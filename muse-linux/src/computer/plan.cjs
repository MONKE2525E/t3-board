'use strict';

const { validatePlanRequest, ContractError } = require('./contracts.cjs');
const { classifyFailure, revisionChangedUnexpectedly } = require('./recovery.cjs');
class PlanExecutor {
  constructor(coordinator, { pollMs = 25 } = {}) { this.coordinator = coordinator; this.pollMs = pollMs; this.checkpoints = new Map(); }
  async execute(input, parentCtx) {
    validatePlanRequest(input, parentCtx.session?.mode);
    const req = JSON.parse(JSON.stringify(input));
    if (req.runId !== parentCtx.runId || req.invokeId !== parentCtx.invokeId || req.sessionId !== parentCtx.sessionId) throw new ContractError('plan_context_mismatch');
    const progress = parentCtx.progress.child(req.totalBudgetMs), ctx = { ...parentCtx, progress, budget: progress.budget };
    const receipt = { planId: req.planId, execution: 'completed', steps: [], attempted: 0, dispatched: 0, verified: 0, skipped: 0, checkpointIds: [], replay: 'forbidden' };
    let halted = false, last, assertions = [];
    if (req.steps.some(step => step.transition?.bindAs)) {
      const failure = classifyFailure({ kind: 'backend_unavailable', code: 'binding_unavailable' }, { phase: 'plan_step' });
      return { ...receipt, execution: 'rejected', skipped: req.steps.length, stopReason: failure.code,
        steps: req.steps.map((step, index) => ({ id: step.id, index, kind: step.kind, execution: 'skipped', assertions: [], failure, timings: progress.timings() })) };
    }
    if (req.resumeCheckpointId) {
      const checkpoint = this.checkpoints.get(req.resumeCheckpointId);
      if (!checkpoint || checkpoint.runId !== req.runId || checkpoint.sessionId !== req.sessionId || checkpoint.generation !== ctx.session.generation || req.steps[0].kind !== 'assert') throw new ContractError('plan_resume_requires_assertions');
    }
    for (const [index, step] of req.steps.entries()) {
      const result = { id: step.id, index, kind: step.kind, execution: halted ? 'skipped' : 'completed', assertions: [], timings: progress.timings() };
      receipt.steps.push(result);
      if (halted) { receipt.skipped++; continue; }
      receipt.attempted++;
      try {
        progress.check('plan_step');
        if (step.kind === 'act') {
          result.actionReceipt = await this.coordinator.execute(step.action, { ...ctx, parentActionId: req.planId, stepIndex: index });
          const action = result.actionReceipt; result.execution = action.execution; result.assertions = action.assertions; last = action;
          if (action.dispatch !== 'not_started') receipt.dispatched++;
          if (action.effect === 'verified') receipt.verified++;
          if (action.failure || ['rejected', 'failed', 'cancelled', 'unfinished'].includes(action.execution)) { result.failure = action.failure; throw action.failure || { kind: 'internal_defect' }; }
          if (step.transition) {
            const transition = await this.coordinator.evaluate(step.transition.predicates, { ...ctx, revision: action.after || action.before }); result.assertions.push(...transition);
            if (transition.some(a => a.status !== 'satisfied')) throw { kind: 'assertion_failed', code: 'assertion_failed' };
          }
          if (action.after && revisionChangedUnexpectedly({ target: action.target, revision: action.before }, { target: action.target, revision: action.after }, !!step.transition)) throw { kind: 'stale_target', code: 'unexpected_transition' };
        } else if (step.kind === 'assert') {
          result.assertions = await this.coordinator.evaluate(step.predicates, ctx);
          if (!result.assertions.length || result.assertions.some(a => a.status !== 'satisfied')) throw { kind: 'assertion_failed', code: 'assertion_failed' };
        } else if (step.kind === 'waitUntil') {
          const wait = progress.child(step.maxMs), waitCtx = { ...ctx, progress: wait, budget: wait.budget };
          do {
            result.assertions = await this.coordinator.evaluate(step.predicates, waitCtx);
            if (result.assertions.length && result.assertions.every(a => a.status === 'satisfied')) break;
            await wait.delay(Math.min(this.pollMs, wait.remainingMs()));
          } while (true);
        } else {
          if (!assertions.length || assertions.some(a => a.status !== 'satisfied') || step.requirementIds.some(id => !req.steps.slice(0, index).some(s => [...(s.predicates || []), ...(s.action?.expect || []), ...(s.transition?.predicates || [])].some(p => p.requirementId === id && assertions.some(a => a.predicateId === p.id && a.status === 'satisfied'))))) throw { kind: 'assertion_failed', code: 'checkpoint_requires_assertions' };
          const checkpointId = `${req.planId}:${step.id}`;
          if (checkpointId.length > 128) throw new ContractError('checkpoint_id_limit');
          this.checkpoints.set(checkpointId, { runId: req.runId, sessionId: req.sessionId, generation: ctx.session.generation, assertionIds: assertions.map(a => a.predicateId), actionId: last?.actionId });
          result.checkpointId = checkpointId; receipt.checkpointIds.push(checkpointId);
        }
        assertions = step.kind === 'act' ? result.assertions.filter(a => step.action.expect.some(p => p.id === a.predicateId) || step.transition?.predicates.some(p => p.id === a.predicateId)) : result.assertions.length ? result.assertions : assertions;
      } catch (error) {
        result.failure = result.failure || classifyFailure(error, { phase: 'plan_step', attempts: result.actionReceipt?.attempts || [] });
        if (!['failed', 'rejected', 'cancelled', 'unfinished'].includes(result.execution)) result.execution = error.kind === 'cancelled' ? 'cancelled' : 'failed';
        receipt.execution = result.execution; receipt.stopReason = result.failure.code; halted = true;
      } finally { result.timings = progress.timings(); }
    }
    return receipt;
  }
}
module.exports = { PlanExecutor };
