'use strict';

const safe = require('./safe.cjs');
function byteLength(value) { return Buffer.byteLength(JSON.stringify(value)); }
/** Keep execution truth outside observation compaction. Deep details use trace.read. */
function compactResult(value, { maxBytes = 8192, traceCursor } = {}) {
  const cap = Math.min(8192, Math.max(1024, maxBytes));
  let result;
  if (value.schema === 'muse.action_receipt.v1') {
    result = safe.receipt(value);
    if (byteLength(result) > cap) {
      result.attempted = result.attempts.length;
      result.dispatched = result.attempts.filter(a => a.dispatch !== 'not_started').length;
      result.failedAttemptIds = result.attempts.filter(a => a.failure).map(a => a.id);
      result.attempts = result.attempts.filter(a => a.failure).map(a => ({ id: a.id, dispatch: a.dispatch, effect: a.effect, failure: a.failure }));
      result.assertions = result.assertions.map(a => ({ predicateId: a.predicateId, status: a.status, producer: a.producer, evidenceIds: a.evidenceIds }));
      result.artifacts = result.artifacts.map(a => ({ id: a.id, availability: a.availability, freshness: a.freshness }));
      result.detail = { command: 'computer.trace.read', runId: result.runId, actionId: result.actionId, section: 'attempts', offset: 0 };
    }
  } else if (value.schema === 'muse.run_result.v1') {
    // RunReducer owns this plain safe projection, rather than forwarding caller fields.
    result = { schema: value.schema, runId: safe.id(value.runId), execution: ['active', 'paused', 'ended', 'cancelled', 'blocked'].includes(value.execution) ? value.execution : 'blocked', outcome: ['verified_complete', 'incomplete', 'unknown'].includes(value.outcome) ? value.outcome : 'unknown', requirements: (value.requirements || []).map(r => ({ id: safe.id(r.id), status: ['not_attempted', 'attempted_unverified', 'verified_present', 'verified_absent', 'blocked', 'unknown_history'].includes(r.status) ? r.status : 'unknown_history', assertionIds: safe.ids(r.assertionIds), actionIds: safe.ids(r.actionIds), evidenceIds: safe.ids(r.evidenceIds) })), journal: { throughSeq: safe.number(value.journal?.throughSeq), integrity: ['complete', 'gapped'].includes(value.journal?.integrity) ? value.journal.integrity : 'unknown' }, counters: safeCounters(value.counters), failures: (value.failures || []).map(safe.safeFailure), handoffCapability: ['accepted', 'local_only', 'unavailable'].includes(value.handoffCapability) ? value.handoffCapability : 'unavailable' };
    if (value.currentTarget) result.currentTarget = { ...Object.fromEntries(['selected', 'lastObserved', 'actualFocus'].filter(key => value.currentTarget[key]).map(key => [key, safe.target(value.currentTarget[key])])), freshness: ['current', 'stale', 'unknown'].includes(value.currentTarget.freshness) ? value.currentTarget.freshness : 'unknown' };
    if (value.plans) result.plans = value.plans.slice(0, 4).map(plan => {
      const projected = compactResult({ ...plan, steps: plan.steps || [] });
      return { invokeId: safe.id(plan.invokeId), planId: projected.planId, execution: projected.execution, steps: projected.steps,
        ...(projected.stopReason ? { stopReason: projected.stopReason } : {}), ...(plan.detailsOmitted ? { detailsOmitted: true } : {}),
        detail: { command: 'computer.trace.read', runId: result.runId } };
    });
    if (value.totalPlans !== undefined) result.totalPlans = safe.number(value.totalPlans);
    if (byteLength(result) > cap) {
      result.requirements = result.requirements.map(r => ({ id: r.id, status: r.status, assertionCount: r.assertionIds.length, actionCount: r.actionIds.length, evidenceCount: r.evidenceIds.length }));
      result.detail = { command: 'computer.run.result', runId: result.runId, view: 'page' };
      if (byteLength(result) > cap && result.plans) { result.plans = result.plans.map(({ invokeId, planId, execution, stopReason, detail }) => ({ invokeId, planId, execution, stopReason, detailsOmitted: true, detail })); }
    }
  } else if (Array.isArray(value.steps)) {
    result = { planId: safe.id(value.planId), execution: ['completed', 'rejected', 'failed', 'cancelled', 'skipped', 'unfinished'].includes(value.execution) ? value.execution : 'unfinished', attempted: safe.number(value.attempted), dispatched: safe.number(value.dispatched), verified: safe.number(value.verified), skipped: safe.number(value.skipped), checkpointIds: safe.ids(value.checkpointIds), stopReason: value.stopReason ? safe.code(value.stopReason) : undefined, replay: 'forbidden', steps: value.steps.map(step => ({ id: safe.id(step.id), index: safe.number(step.index), kind: ['assert', 'act', 'waitUntil', 'checkpoint'].includes(step.kind) ? step.kind : 'unknown', ...(step.actionReceipt?.actionId || step.actionId ? { actionId: safe.id(step.actionReceipt?.actionId || step.actionId) } : {}), execution: ['completed', 'rejected', 'failed', 'cancelled', 'skipped', 'unfinished'].includes(step.execution) ? step.execution : 'unfinished', dispatch: ['not_started', 'possible', 'sent', 'acknowledged'].includes(step.actionReceipt?.dispatch || step.dispatch) ? step.actionReceipt?.dispatch || step.dispatch : undefined, effect: ['none_proven', 'verified', 'partial_verified', 'unknown'].includes(step.actionReceipt?.effect || step.effect) ? step.actionReceipt?.effect || step.effect : undefined, failure: safe.safeFailure(step.failure || step.actionReceipt?.failure) })) };
  } else throw safe.failure('invalid_request');
  if (traceCursor) result.traceCursor = traceCursor;
  for (const key of ['offset', 'nextOffset', 'totalRequirements']) if (Number.isSafeInteger(value[key]) && value[key] >= 0) result[key] = value[key];
  if (byteLength(result) <= cap) return JSON.parse(JSON.stringify(result));
  return {
    schema: result.schema || 'muse.plan_result.v1', runId: result.runId,
    actionId: result.actionId, planId: result.planId, execution: result.execution,
    outcome: 'unknown', dispatch: result.dispatch, effect: result.effect,
    replay: 'forbidden', persistence: result.persistence, journal: result.journal,
    failure: { kind: 'history_incomplete', code: 'result_overflow', phase: 'execution', effect: result.effect || 'unknown', evidenceIds: [], requiredNext: 'refresh_readonly' },
    detail: { command: 'computer.trace.read', runId: result.runId, ...(result.actionId ? { actionId: result.actionId, section: 'attempts', offset: 0 } : {}) },
    traceCursor,
  };
}
function safeCounters(value = {}) {
  const out = { modelRequests: null, modelResponses: null, modelProviderRetries: null, modelMetricProvenance: 'unavailable' };
  // Host IDs alone do not establish provider-retry counts.
  if (value.modelMetricProvenance === 'actual_host_ids') {
    out.modelMetricProvenance = 'actual_host_ids';
    for (const key of ['modelRequests', 'modelResponses']) out[key] = Number.isSafeInteger(value[key]) ? value[key] : null;
  } else if (value.modelMetricProvenance === 'scripted_no_model') out.modelMetricProvenance = 'scripted_no_model';
  for (const key of ['invokes', 'logicalActions', 'primitiveAttempts', 'unknownDispatches', 'captures', 'imageUploads', 'duplicateDeliveries', 'recoveryProbes', 'inputReplays', 'assertionsPassed']) out[key] = safe.number(value[key]);
  out.primitiveDispatches = Number.isSafeInteger(value.primitiveDispatches) ? value.primitiveDispatches : null;
  return out;
}
module.exports = { compactResult, safeCounters };
