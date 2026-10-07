'use strict';

const { createHmac, randomBytes } = require('node:crypto');
const C = require('./contracts.cjs');
const { Progress, defaultClock } = require('./progress.cjs');
const { LeaseManager } = require('./lease.cjs');
const { classifyFailure, FailureDetector } = require('./recovery.cjs');
const { PlanExecutor } = require('./plan.cjs');
const { expectationsForOperation } = require('./state/normalization.cjs');
function typed(kind, code = kind) { return Object.assign(new Error(code), { kind, code }); }
function adapterContract(validate, value) {
  try { return validate(value); }
  catch (error) { if (error instanceof C.ContractError) throw typed('internal_defect', 'adapter_contract_violation'); throw error; }
}
function dispatchState(attempts) {
  if (!attempts.length) return 'not_started';
  if (attempts.some(a => a.dispatch === 'possible')) return 'possible';
  if (attempts.some(a => a.dispatch === 'sent')) return 'sent';
  return attempts.every(a => a.dispatch === 'not_started') ? 'not_started' : 'acknowledged';
}
function counters() { return { modelRequests: null, modelResponses: null, modelProviderRetries: null, modelMetricProvenance: 'unavailable', invokes: 0, logicalActions: 0, primitiveAttempts: 0, primitiveDispatches: null, unknownDispatches: 0, captures: 0, imageUploads: 0, duplicateDeliveries: 0, recoveryProbes: 0, inputReplays: 0, assertionsPassed: 0 }; }
class ExecutionCoordinator {
  constructor({ journal, adapter, selectAdapter, authorize, assertions, reconciler, translate,
    parameterMac, leases = new LeaseManager(), clock = defaultClock, utcNow = Date.now, reducer } = {}) {
    if (!journal || typeof authorize !== 'function') throw new C.ContractError('executor_dependencies_required');
    this.journal = journal; this.selectAdapter = selectAdapter || (() => adapter); this.authorize = authorize;
    this.assertions = assertions; this.reconciler = reconciler; this.translate = translate; this.leases = leases;
    this.clock = clock; this.utcNow = utcNow; this.reducer = reducer; this.runs = new Map(); this.pending = new Map(); this.actions = new Map(); this.late = [];
    this.detector = new FailureDetector(); this.plans = new PlanExecutor(this);
    const ephemeralKey = randomBytes(32);
    this.parameterMac = parameterMac || (journal.parameterMac ? value => journal.parameterMac(value) : value => createHmac('sha256', ephemeralKey).update(C.canonicalJson(value)).digest('hex'));
    this.persistentDedup = !!(parameterMac || journal.parameterMac);
  }
  _run(runId, session) {
    let run = this.runs.get(runId);
    if (!run) { run = { controller: new AbortController(), pauseController: new AbortController(), session, start: this.clock.now(), receipts: [], active: new Map(), counters: counters(), state: 'active' }; this.runs.set(runId, run); }
    if (session && run.session && (run.session.id !== session.id || run.session.generation !== session.generation)) throw typed('stale_target');
    return run;
  }
  async invoke(input, session) {
    C.validateInvocation(input);
    const invocation = JSON.parse(C.canonicalJson(input));
    const remaining = Math.min(C.LIMITS.invocationMs, Math.max(0, invocation.deadlineUtcMs - this.utcNow()));
    const runId = invocation.runId || `run:${(await this.parameterMac({ deviceId: invocation.deviceId, invokeId: invocation.invokeId })).slice(0, 48)}`;
    const run = this._run(runId, session); invocation.runId = runId;
    const mac = await this.parameterMac({ command: invocation.command, params: invocation.params });
    const key = C.canonicalJson({ deviceId: invocation.deviceId, runId, invokeId: invocation.invokeId });
    const previous = this.pending.get(key);
    if (previous) {
      if (previous.mac !== mac) {
        const progress = new Progress({ budget: { deadlineMonoMs: this.clock.now() + remaining, clockDomain: this.clock.domain }, signal: run.controller.signal, clock: this.clock });
        if (invocation.params.schema === 'muse.action.v1') { C.validateActionRequest(invocation.params, session.mode); return { receipt: this._rejected(invocation.params, { progress }, typed('invalid_request', 'dedup_collision')), artifacts: [] }; }
        if (invocation.params.schema === 'muse.plan.v1') {
          C.validatePlanRequest(invocation.params, session.mode);
          return { receipt: { planId: invocation.params.planId, execution: 'rejected', attempted: 0, dispatched: 0, verified: 0, skipped: invocation.params.steps.length,
            steps: invocation.params.steps.map((s, index) => ({ id: s.id, index, kind: s.kind, execution: 'skipped', assertions: [], timings: progress.timings() })), checkpointIds: [], stopReason: 'dedup_collision', replay: 'forbidden' }, artifacts: [] };
        }
        throw typed('invalid_request', 'dedup_collision');
      }
      run.counters.duplicateDeliveries++; return previous.promise;
    }
    const promise = this._invoke(invocation, session, run, remaining, mac);
    this.pending.set(key, { mac, promise });
    return promise;
  }
  async _invoke(invocation, session, run, remaining, mac) {
    const progress = new Progress({ budget: { deadlineMonoMs: Math.min(this.clock.now() + remaining, run.start + C.LIMITS.runMs), clockDomain: this.clock.domain }, signal: run.controller.signal, clock: this.clock, onLate: event => this._late(event, invocation) });
    const ctx = { runId: invocation.runId, invokeId: invocation.invokeId, sessionId: session?.id,
      deviceId: invocation.deviceId, session, invocation, parameterMac: mac, signal: progress.signal, budget: progress.budget, progress };
    let request;
    if (invocation.command === 'computer.action' && (invocation.params.schema !== undefined || !this.translate)) request = invocation.params;
    else if (invocation.command === 'computer.plan' && (invocation.params.schema !== undefined || !this.translate)) request = invocation.params;
    else if (this.translate) request = await progress.phase('translation', () => this.translate(invocation, session));
    else throw typed('invalid_request', 'unsupported_operation');
    if (request.runId !== ctx.runId || request.invokeId !== ctx.invokeId) throw new C.ContractError('invocation_scope_mismatch');
    if (request.schema === 'muse.plan.v1') C.validatePlanRequest(request, session.mode); else C.validateActionRequest(request, session.mode);
    run.counters.invokes++;
    ctx.reserveBytes = request.schema === 'muse.plan.v1' ? Math.max(8192, request.steps.filter(s => s.kind === 'act').length * 8192) : 8192;
    let result;
    try {
    if (this.journal.lookupInvocation) {
      const previous = await progress.phase('dedup_lookup', () => this.journal.lookupInvocation(invocation.invokeId, mac));
      if (previous.state === 'receipt') { run.counters.duplicateDeliveries++; return previous.receipt; }
      if (previous.state !== 'new') return this._invocationFailure(request, ctx, Object.assign(typed(previous.state === 'collision' ? 'invalid_request' : 'history_incomplete', previous.state === 'collision' ? 'dedup_collision' : previous.state === 'expired' ? 'dedup_expired' : 'unfinished_action'), { recoveredInvocation: ['pending', 'unfinished'].includes(previous.state) }));
    }
      const mutations = request.schema === 'muse.plan.v1' ? request.steps.filter(s => s.kind === 'act' && C.isMutation(s.action.operation)).map(s => s.action) : C.isMutation(request.operation) ? [request] : [];
      for (const mutation of mutations) await this._checkUnfinished(ctx, mutation);
      // One reservation belongs to the entire invocation, including every plan step and suffix.
      const admission = await progress.phase('journal_admit', () => this.journal.admit(invocation, ctx.reserveBytes));
      if (!admission.accepted) return this._invocationFailure(request, ctx, admission.failure || typed('storage_unavailable'));
      ctx.admitted = true;
      try { result = { receipt: request.schema === 'muse.plan.v1' ? await this.executePlan(request, ctx) : await this.execute(request, ctx), artifacts: [] }; }
      catch (error) { result = this._invocationFailure(request, ctx, error); }
      if (this.journal.finishInvocation) {
        const cleanup = new Progress({ budget: { clockDomain: this.clock.domain, deadlineMonoMs: this.clock.now() + 1000 }, clock: this.clock });
        try { await cleanup.phase('journal_end', () => this.journal.finishInvocation(invocation, result)); }
        catch {
          if (request.schema === 'muse.plan.v1') { result.receipt.execution = result.receipt.execution === 'completed' ? 'failed' : result.receipt.execution; result.receipt.stopReason = result.receipt.stopReason || 'storage_unavailable'; }
          else { result.receipt.persistence = 'degraded'; result.receipt.journal.integrity = 'unknown'; }
        }
      }
      return result;
    } catch (error) {
      return this._invocationFailure(request, ctx, error);
    } finally {
      if (ctx.admitted && this.journal.releaseAdmission) await progress.quiesce(() => this.journal.releaseAdmission(invocation), 1000);
    }
  }
  _invocationFailure(request, ctx, error) {
    error = error?.failure || error;
    const unknown = error.recoveredInvocation === true;
    if (request.schema !== 'muse.plan.v1') {
      const receipt = this._rejected(request, ctx, error);
      if (unknown) { receipt.execution = 'unfinished'; receipt.dispatch = 'possible'; receipt.effect = 'unknown'; receipt.replay = 'forbidden'; receipt.failure.effect = 'unknown'; receipt.failure.requiredNext = 'read_authoritative_state_do_not_replay'; }
      return { receipt, artifacts: [] };
    }
    return { receipt: { planId: request.planId, execution: unknown ? 'unfinished' : 'rejected', steps: request.steps.map((s, index) => ({ id: s.id, index, kind: s.kind, execution: unknown ? 'unfinished' : 'skipped', assertions: [], failure: classifyFailure(error), timings: ctx.progress.timings() })),
      attempted: 0, dispatched: 0, verified: 0, skipped: unknown ? 0 : request.steps.length, checkpointIds: [], stopReason: error.code || error.kind || 'internal_defect', replay: 'forbidden' }, artifacts: [] };
  }
  _late(event, ctx) {
    // Retain only safe metadata. Raw adapter return/error may contain private page data.
    this.late.push({ runId: ctx.runId, invokeId: ctx.invokeId, actionId: ctx.actionId, phase: ['perform', 'preflight', 'permission', 'readback', 'assertions', 'journal_before_effect', 'journal_end_attempt', 'journal_end', 'probe'].includes(event.phase) ? event.phase : 'other', state: event.state });
    if (this.late.length > 128) this.late.shift();
  }
  async _checkUnfinished(ctx, request) {
    if (!C.isMutation(request.operation) || !this.journal.checkUnfinished) return;
    const result = await ctx.progress.phase('journal', () => this.journal.checkUnfinished({ runId: request.runId, target: request.target }));
    C.fields(result, ['blocked', 'unfinishedActionIds'], ['blocked', 'unfinishedActionIds']);
    if (typeof result.blocked !== 'boolean' || !Array.isArray(result.unfinishedActionIds) || result.unfinishedActionIds.length > C.LIMITS.runActions) throw typed('storage_unavailable', 'journal_unavailable');
    result.unfinishedActionIds.forEach(C.id);
    if (result.blocked || result.unfinishedActionIds.length) throw typed('history_incomplete', 'unfinished_action');
  }
  _resource(session, target) {
    if (session.mode === 'borrowed_browser') return { sessionId: session.id, generation: session.generation, kind: 'tab', id: target.targetId };
    if (!session.display?.instanceId) throw typed('backend_unavailable', 'session_unavailable');
    // All sessions borrowing one real display share one lock, including observation/ref publication.
    return { sessionId: session.mode === 'real_desktop' ? session.display.instanceId : session.id,
      generation: session.mode === 'real_desktop' ? 0 : session.generation, kind: 'seat', id: session.display.instanceId };
  }
  async _authorize(ctx, request, phase) {
    ctx.progress.check(phase);
    if (!ctx.session || !['ready', 'paused'].includes(ctx.session.state)) throw typed('not_ready', 'session_unavailable');
    if (ctx.session.state === 'paused' && C.isMutation(request.operation)) throw typed('user_takeover');
    if (request.target.sessionId !== ctx.session.id || request.expectedRevision.sessionGeneration !== ctx.session.generation) throw typed('stale_target');
    const authorization = await ctx.progress.phase('permission', () => this.authorize(ctx, { session: ctx.session, request, phase }));
    ctx.progress.check(phase);
    if (!authorization?.grant || !authorization.revision) throw typed('permission_denied');
    C.validateRevision(authorization.revision);
    if (!C.sameRevision(request.expectedRevision, authorization.revision)) throw typed('stale_target');
    if (ctx.grant && ctx.grant !== authorization.grant) throw typed('permission_denied');
    ctx.grant = authorization.grant; ctx.revision = authorization.revision;
  }
  async _assert(predicates, evidence, ctx, receipt) {
    if (!predicates.length) return [];
    let results;
    if (this.reconciler && receipt) results = await ctx.progress.phase('assertions', () => this.reconciler.verify({ ...receipt, evidence }, predicates, { ...ctx, evidence, dispatch: this._readOnlyDispatch() }));
    else if (this.assertions) results = await ctx.progress.phase('assertions', async () => {
      const out = [];
      for (const p of predicates) out.push(await this.assertions.validate(p, evidence, { ...ctx, evidence, dispatch: this._readOnlyDispatch() }));
      return out;
    });
    else return predicates.map(p => ({ predicateId: p.id, status: 'unknown', producer: 'deterministic', evidenceIds: [], actionIds: [], reasonCodes: ['validator_unavailable'] }));
    if (!Array.isArray(results) || results.length !== predicates.length) throw typed('internal_defect', 'adapter_contract_violation');
    results.forEach((r, i) => {
      C.validateAssertionResult(r);
      if (r.predicateId !== predicates[i].id || !['satisfied', 'unsatisfied', 'unknown', 'pending'].includes(r.status) || !['deterministic', 'model_inferred', 'human_reported'].includes(r.producer) || !Array.isArray(r.evidenceIds) || !Array.isArray(r.actionIds) || !Array.isArray(r.reasonCodes)) throw typed('internal_defect', 'adapter_contract_violation');
      if (r.status === 'satisfied' && (r.producer !== 'deterministic' || !r.evidenceIds.length)) r.status = 'unknown';
    });
    return results;
  }
  async evaluate(predicates, ctx) {
    if (!predicates.length) return [];
    const target = predicates[0].target;
    if (predicates.some(p => !C.sameTarget(p.target, target))) throw new C.ContractError('assertion_target_mismatch');
    if (target.sessionId !== ctx.session?.id || !['ready', 'paused'].includes(ctx.session.state)) throw typed('stale_target');
    const request = { target, operation: { kind: 'query', target, query: { exact: true, limit: 1, scope: 'structural' } }, expectedRevision: ctx.revision };
    const policy = await ctx.progress.phase('permission', () => this.authorize(ctx, { session: ctx.session, request, phase: 'probe' }));
    if (!policy?.grant || !policy.revision) throw typed('permission_denied');
    C.validateRevision(policy.revision); const readCtx = { ...ctx, grant: policy.grant, revision: policy.revision, target, dispatch: this._readOnlyDispatch() };
    const adapter = this.selectAdapter(target, ctx.session, ctx);
    if (!adapter) throw typed('backend_unavailable', 'adapter_missing');
    const lease = await this.leases.acquire(this._resource(ctx.session, target), readCtx);
    try {
      const evidence = await ctx.progress.phase('probe', () => adapter.probe(predicates, target, readCtx));
      return await this._assert(predicates, evidence, readCtx, { target, before: readCtx.revision });
    } finally { await this.leases.release(lease); }
  }
  _readOnlyDispatch() { return { beforeEffect: async () => { throw typed('internal_defect', 'adapter_contract_violation'); }, afterEffect: async () => { throw typed('internal_defect', 'adapter_contract_violation'); } }; }
  async execute(input, parentCtx) {
    const session = parentCtx.session, mode = session?.mode;
    C.validateActionRequest(input, mode); const request = JSON.parse(C.canonicalJson(input));
    if (request.runId !== parentCtx.runId || request.invokeId !== parentCtx.invokeId) throw new C.ContractError('action_context_mismatch');
    const run = this._run(request.runId, session);
    const mac = await this.parameterMac({ command: parentCtx.invocation?.command || 'computer.action', action: request });
    const key = { deviceId: parentCtx.deviceId || parentCtx.invocation?.deviceId, runId: request.runId, invokeId: request.invokeId, actionId: request.actionId };
    C.id(key.deviceId);
    const localKey = C.canonicalJson(key), cached = this.actions.get(localKey);
    if (cached) {
      if (cached.mac !== mac) return this._rejected(request, parentCtx, typed('invalid_request', 'dedup_collision'));
      run.counters.duplicateDeliveries++; return cached.promise;
    }
    const work = this._execute(request, parentCtx, run, mac, key);
    this.actions.set(localKey, { mac, promise: work }); return work;
  }
  _rejected(request, ctx, error) {
    return { schema: 'muse.action_receipt.v1', runId: request.runId, invokeId: request.invokeId, actionId: request.actionId,
      ...(ctx.parentActionId ? { parentActionId: ctx.parentActionId } : {}), ...(ctx.stepIndex !== undefined ? { stepIndex: ctx.stepIndex } : {}),
      target: request.target, before: request.expectedRevision, execution: 'rejected', dispatch: 'not_started', effect: 'none_proven', attempts: [], assertions: [],
      failure: classifyFailure(error), replay: 'same_id_receipt_only', timings: ctx.progress.timings(), journal: { throughSeq: 0, integrity: 'unknown' }, artifacts: [], persistence: 'unavailable' };
  }
  async _execute(request, parentCtx, run, mac, key) {
    const cap = request.operation.kind === 'navigate' ? 15000 : C.isMutation(request.operation) ? 5000 : 2000;
    const progress = new Progress({ budget: { ...parentCtx.progress.budget, deadlineMonoMs: Math.min(parentCtx.progress.budget.deadlineMonoMs, this.clock.now() + cap, run.start + C.LIMITS.runMs) },
      signal: AbortSignal.any([parentCtx.progress.signal, run.controller.signal, ...(C.isMutation(request.operation) ? [run.pauseController.signal] : [])]), clock: this.clock, onLate: event => this._late(event, request) });
    const ctx = { ...parentCtx, ...key, sessionId: request.target.sessionId, target: request.target, actionId: request.actionId, revision: request.expectedRevision, budget: progress.budget, progress, parameterMac: mac };
    ctx.signal = progress.signal;
    const receipt = this._rejected(request, ctx, typed('internal_defect'));
    delete receipt.failure; receipt.execution = 'completed'; receipt.persistence = 'durable';
    let adapter, resource, lease, handle, performed = false, finalized = false, duplicate = false, reportedDispatch, recoveredUnknown = false, validatedNoEffect = false;
    const attemptHandles = new Map(); let inBoundary = false, boundaryInvoked = false;
    let expectationSealed = false, expectationRejected = false, textExpectation;
    if (request.operation.kind === 'editText') ctx.onTextExpectation = value => {
      try {
      progress.check('text_expectation');
      if (finalized || expectationSealed || boundaryInvoked || textExpectation) throw typed('internal_defect', 'adapter_contract_violation');
      adapterContract(v => {
        C.fields(v, ['refId', 'target', 'revision', 'editMode', 'expectedPrivateDigest'], ['refId', 'target', 'revision', 'editMode', 'expectedPrivateDigest']);
        C.id(v.refId); C.id(v.expectedPrivateDigest); C.validateTargetRef(v.target); C.validateRevision(v.revision);
        C.enumeration(v.editMode, ['replace', 'append', 'insert', 'replaceSelection']);
      }, value);
      if (value.refId !== request.operation.ref.id || !C.sameTarget(value.target, request.target) || !C.sameRevision(value.revision, request.expectedRevision) || value.editMode !== request.operation.edit.mode) throw typed('internal_defect', 'adapter_contract_violation');
      textExpectation = value.expectedPrivateDigest;
      } catch (error) { expectationRejected = true; throw error; }
    };
    else delete ctx.onTextExpectation;
    ctx.dispatch = {
      beforeEffect: async boundary => {
        boundaryInvoked = true;
        if (finalized || inBoundary) throw typed('cancelled');
        if (expectationRejected) throw typed('internal_defect', 'adapter_contract_violation');
        if (!C.isMutation(request.operation)) throw typed('internal_defect', 'adapter_contract_violation');
        C.fields(boundary, ['primitive', 'substep', 'target'], ['primitive', 'substep', 'target']);
        C.id(boundary.primitive); C.id(boundary.substep); C.validateTargetRef(boundary.target);
        if (!C.sameTarget(boundary.target, request.target)) throw typed('stale_target');
        inBoundary = true;
        try {
          await this._authorize(ctx, request, 'before_effect');
          await this._checkUnfinished(ctx, request);
          if (request.operation.kind === 'editText' && request.operation.edit.mode !== 'replace' && !textExpectation) throw typed('internal_defect', 'adapter_contract_violation');
          const start = this.clock.now();
          let h;
          try { h = await progress.phase('journal_before_effect', () => this.journal.beforeEffect(handle, { ...boundary, revision: ctx.revision })); }
          catch (error) { throw error?.kind ? error : typed('storage_unavailable'); }
          // Marker is now durable; uncertainty begins before checking cancellation again.
          const attempt = { id: h.id, ...boundary, dispatch: 'possible', effect: 'unknown', evidenceIds: [], timings: { clockDomain: this.clock.domain, startMonoMs: start, endMonoMs: this.clock.now(), totalMs: this.clock.now() - start, phases: {} } };
          receipt.attempts.push(attempt); attemptHandles.set(h, attempt); run.counters.primitiveAttempts++; run.counters.unknownDispatches++;
          progress.check('before_effect'); return h;
        } finally { inBoundary = false; }
      },
      afterEffect: async (h, ack) => {
        const attempt = attemptHandles.get(h); if (!attempt) throw typed('internal_defect', 'adapter_contract_violation');
        adapterContract(value => { C.fields(value, ['state', 'noEffectProven', 'failure'], ['state', 'noEffectProven']); C.enumeration(value.state, ['accepted', 'rejected', 'lost']); }, ack);
        if (typeof ack.noEffectProven !== 'boolean' || ack.state !== 'rejected' && ack.noEffectProven) throw typed('internal_defect', 'adapter_contract_violation');
        if (finalized) { this._late({ phase: 'after_effect', state: 'fulfilled' }, ctx); return; }
        if (attempt.acknowledged) throw typed('internal_defect', 'adapter_contract_violation');
        attempt.acknowledged = true;
        attempt.dispatch = ack.state === 'lost' ? 'possible' : ack.state === 'accepted' ? 'acknowledged' : 'sent';
        attempt.effect = ack.state === 'rejected' && ack.noEffectProven ? 'none_proven' : 'unknown';
        attempt.timings.endMonoMs = this.clock.now(); attempt.timings.totalMs = attempt.timings.endMonoMs - attempt.timings.startMonoMs;
        if (ack.failure) attempt.failure = classifyFailure(ack.failure, { attempts: [attempt] });
        await progress.phase('journal_end_attempt', () => this.journal.endAttempt(h, { dispatch: attempt.dispatch, effect: attempt.effect, timings: attempt.timings, evidenceIds: attempt.evidenceIds, ...(attempt.failure ? { failure: attempt.failure } : {}) }));
      },
    };
    try {
      const previous = await progress.phase('dedup_lookup', () => this.journal.lookup(key, mac));
      if (previous.state === 'receipt') { duplicate = true; run.counters.duplicateDeliveries++; return previous.receipt.receipt || previous.receipt; }
      if (previous.state !== 'new') { recoveredUnknown = ['pending', 'unfinished'].includes(previous.state); throw typed(previous.state === 'collision' ? 'invalid_request' : 'history_incomplete', previous.state === 'collision' ? 'dedup_collision' : previous.state === 'expired' ? 'dedup_expired' : 'unfinished_action'); }
      if (run.receipts.length + run.active.size >= C.LIMITS.runActions || this.clock.now() - run.start >= C.LIMITS.runMs) throw typed('not_ready', 'run_limit');
      if (!this.persistentDedup && C.isMutation(request.operation)) throw typed('storage_unavailable');
      await this._authorize(ctx, request, 'admission'); this.detector.check(request);
      await this._checkUnfinished(ctx, request);
      resource = this._resource(ctx.session, request.target); lease = await this.leases.acquire(resource, ctx);
      adapter = this.selectAdapter(request.target, ctx.session, ctx); if (!adapter) throw typed('backend_unavailable', 'adapter_missing');
      if (!parentCtx.admitted) {
        const admission = await progress.phase('journal_admit', () => this.journal.admit(parentCtx.invocation || { ...key, command: 'computer.action', params: request, deadlineUtcMs: this.utcNow() + progress.remainingMs() }, parentCtx.reserveBytes || 8192));
        if (!admission.accepted) throw admission.failure || typed('storage_unavailable');
      }
      handle = await progress.phase('journal_begin', () => this.journal.begin(ctx, { command: parentCtx.invocation?.command || 'computer.action', operationKind: request.operation.kind, target: request.target, parameterMac: mac }));
      run.active.set(request.actionId, { adapter, ctx, resource }); run.counters.logicalActions++;
      const preflight = await progress.phase('preflight', () => adapter.preflight(request.operation, { ...ctx, dispatch: this._readOnlyDispatch() }));
      adapterContract(C.validatePreflightResult, preflight);
      if (!preflight.eligible) throw preflight.failure || typed('not_ready', 'preflight_rejected');
      if (!C.sameRevision(request.expectedRevision, preflight.revision)) throw typed('stale_target');
      const required = await this._assert(request.require, preflight.evidence || [], ctx, receipt);
      receipt.assertions.push(...required);
      if (required.some(a => a.status !== 'satisfied')) throw typed('assertion_failed');
      await this._authorize(ctx, request, 'perform');
      performed = true;
      let result;
      try { result = await progress.phase('perform', () => adapter.perform(request.operation, ctx)); }
      finally { expectationSealed = true; }
      adapterContract(C.validateAdapterReceipt, result);
      ctx.modalCheckpoint = ctx.session.mode === 'borrowed_browser' && result.evidence.some(e => e.source === 'lifecycle' && e.acquisition === 'ok' && e.freshness === 'current' &&
        C.sameTarget(e.target, request.target) && e.interval.clockDomain === this.clock.domain && this.clock.now() - e.interval.endMonoMs < 1000 &&
        e.facts.some(f => f.predicate === 'dialog.state' && f.value?.state === 'open' && f.value.related === true && f.value.relatedTargetId === request.target.targetId && typeof f.value.dialogId === 'string'));
      if (!C.sameTarget(result.target, request.target) || !C.sameRevision(result.before, request.expectedRevision)) throw typed('stale_target');
      reportedDispatch = result.dispatch;
      // Only a validated, correctly scoped adapter rejection can establish that
      // preparation failed before input. Thrown/malformed responses stay unknown.
      validatedNoEffect = result.dispatch === 'not_started' && result.effect === 'none_proven' && result.attempts.length === 0 && !boundaryInvoked;
      if (C.isMutation(request.operation) && ['possible', 'sent', 'acknowledged'].includes(result.dispatch) && !receipt.attempts.length) throw typed('internal_defect', 'adapter_contract_violation');
      if (result.after) { C.validateRevision(result.after); receipt.after = result.after; }
      if (result.effect === 'partial_verified') receipt.effect = 'partial_verified';
      if (result.failure) throw result.failure;
      const evidence = [...(result.evidence || [])];
      const dynamic = textExpectation && request.operation.edit.mode !== 'replace' ? expectationsForOperation(request.operation, { expectedFinalPrivateDigest: textExpectation, makeId: () => `text-final:${mac.slice(0, 48)}` }) : [];
      const expected = [...request.expect, ...dynamic];
      if (expected.length) {
        const verifyCtx = { ...ctx, revision: result.after || ctx.revision, dispatch: this._readOnlyDispatch() };
        const read = await progress.phase('readback', () => adapter.probe(expected, request.target, verifyCtx)); evidence.push(...read);
        const assertions = await this._assert(expected, evidence, verifyCtx, receipt); receipt.assertions.push(...assertions);
        if (assertions.some(a => a.status !== 'satisfied')) throw typed(assertions.some(a => a.status === 'unsatisfied') ? 'assertion_failed' : 'verification_unavailable');
        receipt.effect = 'verified'; run.counters.assertionsPassed += assertions.length;
      } else receipt.effect = receipt.attempts.every(a => a.effect === 'none_proven') ? 'none_proven' : 'unknown';
      if (result.effect === 'partial_verified') receipt.effect = 'partial_verified';
    } catch (error) {
      error = error?.failure || error;
      receipt.failure = classifyFailure(error, { phase: error.phase || 'execute', attempts: receipt.attempts });
      receipt.execution = error.kind === 'cancelled' ? 'cancelled' : ['invalid_request', 'permission_denied', 'stale_target', 'history_incomplete', 'diagnosis_required'].includes(error.kind) ? 'rejected' : 'failed';
      receipt.effect = receipt.effect === 'partial_verified' ? 'partial_verified' : receipt.attempts.every(a => a.effect === 'none_proven') ? 'none_proven' : 'unknown';
      if (error.kind === 'storage_unavailable') receipt.persistence = 'unavailable';
    } finally {
      finalized = true;
      // A timed-out perform may still complete. No later dispatch can pass the sealed recorder.
      const crossedEffect = receipt.attempts.some(a => a.effect !== 'none_proven');
      const uncertainPerform = performed && !boundaryInvoked && !expectationRejected && reportedDispatch !== 'not_started';
      const modalCheckpoint = ctx.session.mode === 'borrowed_browser' && ['dialog_checkpoint', 'dialog_during_mouse_down', 'dialog_during_key_down'].includes(receipt.failure?.code) &&
        ctx.modalCheckpoint === true;
      if (adapter && (run.controller.signal.aborted || receipt.failure && !modalCheckpoint && (crossedEffect || uncertainPerform || progress.signal.aborted))) {
        const quiescence = await progress.quiesce(cleanup => adapter.quiesce({ ...ctx, progress: cleanup, budget: cleanup.budget, signal: cleanup.signal, dispatch: this._readOnlyDispatch() }), 1000);
        if (quiescence.state !== 'confirmed' && resource) { this.leases.poison(resource, 'quiescence_unknown'); run.state = 'blocked'; }
      }
      receipt.dispatch = dispatchState(receipt.attempts);
      if (recoveredUnknown) { receipt.execution = 'unfinished'; receipt.dispatch = 'possible'; receipt.effect = 'unknown'; receipt.failure.effect = 'unknown'; receipt.failure.requiredNext = 'read_authoritative_state_do_not_replay'; }
      if (reportedDispatch === 'possible' && receipt.attempts.length) receipt.dispatch = 'possible';
      if (performed && C.isMutation(request.operation) && !validatedNoEffect && !receipt.attempts.length && !boundaryInvoked && !expectationRejected && (receipt.failure || reportedDispatch !== 'not_started')) {
        receipt.dispatch = 'possible'; receipt.effect = 'unknown'; receipt.failure.requiredNext = 'read_authoritative_state_do_not_replay';
        receipt.failure.effect = 'unknown';
        if (resource) this.leases.poison(resource, 'unrecorded_effect'); run.state = 'blocked';
      }
      receipt.replay = receipt.effect === 'none_proven' ? 'refresh_before_new_action' : 'forbidden';
      for (const attempt of receipt.attempts) delete attempt.acknowledged;
      receipt.timings = progress.timings();
      if (handle) {
        try {
          const cleanup = new Progress({ budget: { clockDomain: this.clock.domain, deadlineMonoMs: this.clock.now() + 1000 }, clock: this.clock });
          const saved = await cleanup.phase('journal_end', () => this.journal.end(handle, receipt));
          if (saved?.journal) receipt.journal = saved.journal;
          if (saved?.persistence) receipt.persistence = saved.persistence;
        } catch { receipt.persistence = 'degraded'; receipt.journal.integrity = 'unknown'; }
      }
      if (lease) { try { await this.leases.release(lease); } catch { receipt.persistence = 'degraded'; run.state = 'blocked'; } }
      run.active.delete(request.actionId);
      if (!duplicate && (handle || !['history_incomplete', 'invalid_request'].includes(receipt.failure?.kind))) {
        run.receipts.push(receipt); const gate = this.detector.record(request, receipt, { mutation: C.isMutation(request.operation) });
        if (gate) run.state = 'blocked';
      }
    }
    return receipt;
  }
  async executePlan(request, ctx) { return this.plans.execute(request, ctx); }
  async pause(runId) {
    C.id(runId); const run = this.runs.get(runId); if (!run) return;
    run.pauseController.abort('user_takeover'); run.state = 'paused';
    for (const { adapter, ctx, resource } of run.active.values()) {
      const q = await ctx.progress.quiesce(p => adapter.quiesce({ ...ctx, progress: p, budget: p.budget, signal: p.signal, dispatch: this._readOnlyDispatch() }), 1000);
      if (q.state !== 'confirmed') { this.leases.poison(resource, 'quiescence_unknown'); run.state = 'blocked'; }
    }
  }
  resumeByUser(runId) {
    C.id(runId); const run = this.runs.get(runId); if (!run) return;
    if (run.controller.signal.aborted || run.state === 'blocked' || run.active.size) throw typed('not_ready', 'user_resume_required');
    run.pauseController = new AbortController(); run.state = 'active';
  }
  async cancel(runId, _reason = 'user_stop') {
    C.id(runId); const run = this.runs.get(runId); if (!run) return { runId, futureDispatchBlocked: true, quiescence: { state: 'confirmed', ownedInputReleased: true, reasonCodes: [] }, unfinishedActionIds: [] };
    run.controller.abort('cancelled'); run.state = 'cancelled';
    const unfinishedActionIds = [...run.active.keys()], results = [];
    for (const { adapter, ctx, resource } of run.active.values()) {
      const q = await ctx.progress.quiesce(p => adapter.quiesce({ ...ctx, progress: p, budget: p.budget, signal: p.signal, dispatch: this._readOnlyDispatch() }), 1000); results.push(q);
      if (q.state !== 'confirmed') this.leases.poison(resource, 'quiescence_unknown');
    }
    return { runId, futureDispatchBlocked: true, unfinishedActionIds, quiescence: { state: results.every(q => q.state === 'confirmed') ? 'confirmed' : 'unknown', ownedInputReleased: results.every(q => q.ownedInputReleased), reasonCodes: [...new Set(results.flatMap(q => q.reasonCodes))] } };
  }
  async inspect(runId) {
    if (this.reducer) return this.reducer.result(runId);
    const run = this.runs.get(runId); if (!run) throw typed('history_incomplete');
    return { schema: 'muse.run_result.v1', runId, execution: run.state === 'active' && !run.active.size ? 'ended' : run.state,
      outcome: 'unknown', requirements: [], journal: { throughSeq: Math.max(0, ...run.receipts.map(r => r.journal.throughSeq)), integrity: run.receipts.every(r => r.journal.integrity === 'complete') ? 'complete' : 'unknown' },
      counters: { ...run.counters }, failures: run.receipts.filter(r => r.failure).map(r => ({ ...r.failure, actionId: r.actionId, effect: r.effect })), handoffCapability: 'local_only' };
  }
  async diagnose(runId, probes, ctx) { return this.detector.diagnose(runId, probes, ctx); }
  allowRecovery(runId, recovery) { return this.detector.allowRecovery(runId, recovery); }
}

// Compatibility handlers remain injected by main. No imports instantiate a desktop/browser.
class LegacyCommandAdapter {
  constructor({ commandFor, invokeLegacy, preflight, probe = async () => [], quiesce = async () => ({ state: 'unknown', ownedInputReleased: false, reasonCodes: ['legacy_quiescence_unknown'] }) }) {
    if (![commandFor, invokeLegacy, preflight].every(x => typeof x === 'function')) throw new C.ContractError('legacy_adapter_dependencies');
    this.commandFor = commandFor; this.invokeLegacy = invokeLegacy; this.preflight = preflight; this.probe = probe; this.quiesce = quiesce;
  }
  capabilities() { return { legacy: { supported: true, reason: 'conservative_high_level_boundary' } }; }
  async perform(op, ctx) {
    const command = this.commandFor(op, ctx); let attempt;
    if (C.isMutation(op)) attempt = await ctx.dispatch.beforeEffect({ primitive: 'legacy_command', substep: op.kind, target: ctx.target });
    let result;
    try { result = await this.invokeLegacy(command.command, command.params, ctx); }
    catch (error) { if (attempt) await ctx.dispatch.afterEffect(attempt, { state: 'lost', noEffectProven: false }); throw error; }
    // A high-level handler cannot prove which internal calls had side effects.
    if (attempt) await ctx.dispatch.afterEffect(attempt, { state: 'accepted', noEffectProven: false });
    return { target: ctx.target, before: ctx.revision, dispatch: attempt ? 'possible' : 'not_started', effect: attempt ? 'unknown' : 'none_proven', attempts: [], evidence: result?.evidence || [], timings: ctx.progress.timings(), ...(result?.failure ? { failure: result.failure } : {}) };
  }
  async detach() {}
}
module.exports = { ExecutionCoordinator, LegacyCommandAdapter, dispatchState };
