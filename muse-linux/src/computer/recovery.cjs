'use strict';

const { createHmac, randomBytes } = require('node:crypto');
const { ENUMS, canonicalJson, sameTarget, sameRevision, validateTargetRef, validateElementRef, validateRevision, validateEvidence, ContractError } = require('./contracts.cjs');
const intentSecret = randomBytes(32);
const SAFE_CODES = new Set(['cancelled', 'deadline_exceeded', 'lease_poisoned', 'permission_denied', 'user_takeover',
  'dialog_checkpoint', 'dialog_during_mouse_down', 'dialog_during_key_down', 'file_access_denied',
  'stale_target', 'not_ready', 'unsupported_operation', 'adapter_missing', 'preflight_rejected', 'assertion_failed',
  'verification_unavailable', 'transport_lost', 'storage_unavailable', 'dedup_collision', 'dedup_expired', 'history_incomplete',
  'unfinished_action', 'diagnosis_required', 'adapter_contract_violation', 'invalid_request', 'internal_defect', 'session_unavailable',
  'unexpected_transition', 'binding_unavailable', 'checkpoint_requires_assertions', 'run_limit', 'plan_resume_requires_assertions',
  'dedup_pending', 'run_unknown', 'run_retired', 'journal_unavailable', 'journal_full', 'journal_write_failed', 'journal_sync_failed',
  'journal_timeout', 'ledger_invalid', 'key_missing', 'key_invalid', 'writer_busy', 'unsafe_path', 'record_too_large', 'queue_full', 'reservation_missing']);
const SAFE_PHASES = new Set(['admission', 'validation', 'lease', 'permission', 'journal', 'journal_before_effect', 'journal_end_attempt', 'preflight', 'before_effect', 'perform', 'readback', 'assertions', 'execute', 'plan_step', 'probe', 'dispatch', 'verification', 'capture', 'transfer']);
function classifyFailure(error, { phase = 'execute', attempts = [], evidenceIds = [] } = {}) {
  error = error?.failure || error;
  const kind = ENUMS.failure.includes(error?.kind) ? error.kind : 'internal_defect';
  const code = error instanceof ContractError ? error.code : SAFE_CODES.has(error?.code) ? error.code : kind;
  const noEffect = attempts.every(a => a.effect === 'none_proven');
  return { kind, code, phase: SAFE_PHASES.has(phase) ? phase : 'execute', effect: noEffect ? 'none_proven' : 'unknown', evidenceIds: [...evidenceIds],
    requiredNext: ['unfinished_action', 'diagnosis_required'].includes(code) || !noEffect ? 'read_authoritative_state_do_not_replay' : ['permission_denied', 'user_takeover', 'cancelled'].includes(kind) ? 'trusted_user_transition' : 'refresh_before_new_action' };
}
function intentKey(action) {
  const identity = ref => {
    if (!ref) return null;
    if (ref.captureId) return { target: ref.target, point: ref.point, space: ref.space, transformId: ref.transformId };
    return { target: ref.target, source: ref.source, identity: ref.identity,
      ...(ref.frame ? { frame: ref.frame } : {}), ...(ref.native ? { native: ref.native } : {}),
      ...(ref.browser ? { backendNodeId: ref.browser.backendNodeId } : {}) };
  };
  const operation = { ...action.operation };
  if (operation.ref) operation.ref = identity(operation.ref);
  if (operation.itemRefs) operation.itemRefs = operation.itemRefs.map(identity);
  return createHmac('sha256', intentSecret).update(canonicalJson({ target: action.target, operation,
    requirements: [...action.requirementIds].sort() })).digest('hex');
}
function semanticContent(evidence) {
  const facts = evidence.facts.filter(f => f.evidenceIds.includes(evidence.id));
  const scopedRef = f => {
    if (f.predicate !== 'element.ref' || f.suitability !== 'deterministic') return false;
    try { validateElementRef(f.value); } catch { return false; }
    return sameTarget(f.value.target, evidence.target) && sameRevision(f.value.revision, evidence.revisionAfter) && f.value.source === evidence.source;
  };
  const identities = new Map(facts.filter(scopedRef)
    .map(f => [f.value.id, f.value.identity]));
  const values = [];
  for (const f of facts) {
    const value = f.value;
    if (scopedRef(f)) values.push({ predicate: f.predicate, value: { identity: value.identity, capabilities: value.capabilities } });
    else if (['element.checked', 'element.selected', 'element.focused'].includes(f.predicate) && f.suitability === 'deterministic' && identities.has(value?.refId)) {
      const { refId, ...state } = value;
      values.push({ predicate: f.predicate, value: { identity: identities.get(refId), ...state } });
    } else if (f.predicate === 'document.heading' && ['visible', 'visible_readback', 'deterministic'].includes(f.suitability) && value?.visible === true && typeof value.text === 'string' && value.text.length) values.push({ predicate: f.predicate, value });
    else if (f.predicate === 'document.summary' && f.suitability === 'semantic_summary' && typeof value?.currentUrl === 'string' && ['interactive', 'complete'].includes(value.readyState)) values.push({ predicate: f.predicate, value });
    else if (f.predicate === 'text.value' && ['preview', 'complete_value'].includes(f.suitability) && identities.has(value?.refId) && value.secret === false && value.plainText === true
      && (typeof value.value === 'string' || typeof value.privateDigest === 'string')) {
      const { refId, ...text } = value;
      values.push({ predicate: f.predicate, value: { identity: identities.get(refId), ...text } });
    }
  }
  return values.length ? canonicalJson(values.map(canonicalJson).sort()) : null;
}
function semanticScope(evidence) {
  return ['dom', 'atspi'].includes(evidence.source) && ['visible', 'structural', 'selected_tab'].includes(evidence.coverage.scope)
    && evidence.coverage.truncated === false && evidence.derivedFrom.length === 0;
}
class FailureDetector {
  constructor() { this.runs = new Map(); }
  _run(runId) { if (!this.runs.has(runId)) this.runs.set(runId, { failures: new Map(), unknown: new Set(), completedUnknown: new Set(), noProgress: 0, gate: null, recovery: null }); return this.runs.get(runId); }
  check(action) {
    const state = this._run(action.runId), key = intentKey(action);
    if (state.completedUnknown.has(key)) {
      state.gate ||= { code: 'diagnosis_required', reason: 'completed_unknown_intent', failedIntent: key, blocked: false, probes: 0 };
      throw Object.assign(new Error('diagnosis_required'), { kind: 'diagnosis_required', code: 'diagnosis_required' });
    }
    if (state.unknown.has(key)) throw Object.assign(new Error('unfinished_action'), { kind: 'history_incomplete', code: 'unfinished_action' });
    if (state.gate) {
      if (!state.recovery || state.recovery.key !== key || state.recovery.used) throw Object.assign(new Error('diagnosis_required'), { kind: 'diagnosis_required', code: 'diagnosis_required' });
      state.recovery.used = true;
    }
  }
  record(action, receipt, { mutation = true } = {}) {
    const state = this._run(action.runId), key = intentKey(action);
    if (receipt.effect !== 'none_proven' && receipt.effect !== 'verified') state.unknown.add(key);
    if (receipt.execution === 'completed' && receipt.effect !== 'none_proven' && receipt.effect !== 'verified') state.completedUnknown.add(key);
    if (receipt.failure) state.failures.set(key, (state.failures.get(key) || 0) + 1);
    const progress = receipt.assertions.some(a => a.status === 'satisfied' && a.producer === 'deterministic' && a.evidenceIds.length);
    if (progress) state.noProgress = 0; else if (mutation) state.noProgress++;
    const reason = state.recovery?.used && receipt.failure ? 'recovery_failed' : (state.failures.get(key) || 0) >= 2 ? 'repeated_failure' : state.noProgress >= 3 ? 'no_progress' : null;
    if (reason && (!state.gate || state.gate.reason === 'no_progress' || reason !== 'no_progress')) state.gate = { code: 'diagnosis_required', reason, failedIntent: key, blocked: !!state.recovery?.used, probes: 0 };
    return state.gate;
  }
  observeProgress(runId, { target, before, after, beforeEvidence = [], evidence }, ctx) {
    validateTargetRef(target); validateRevision(before); validateRevision(after);
    if (![beforeEvidence, evidence].every(entries => Array.isArray(entries) && entries.length <= 256)) throw new ContractError('invalid_progress_evidence');
    beforeEvidence.forEach(validateEvidence); evidence.forEach(validateEvidence);
    ctx.progress.check('observe_progress');
    const clock = ctx.progress.clock, now = clock.now(), boundary = ctx.afterActionMonoMs;
    if (!Number.isFinite(boundary) || boundary < 0 || boundary > now) throw new ContractError('invalid_progress_boundary');
    if (ctx.revision) { validateRevision(ctx.revision); if (!sameRevision(ctx.revision, after)) throw new ContractError('progress_revision_mismatch'); }
    const stableLifetime = ['sessionGeneration', 'grantGeneration', 'connectionEpoch', 'targetGeneration'].every(k => before[k] === after[k]);
    const stateCounters = ['documentEpoch', 'semanticRevision'];
    const monotonic = stateCounters.every(k => before[k] === undefined && after[k] === undefined || Number.isFinite(before[k]) && Number.isFinite(after[k]) && after[k] >= before[k]);
    const changed = monotonic && stateCounters.some(k => Number.isFinite(before[k]) && Number.isFinite(after[k]) && after[k] > before[k]);
    const baseline = beforeEvidence.filter(e => semanticScope(e) && e.acquisition === 'ok' && e.freshness === 'current'
      && sameTarget(e.target, target) && sameRevision(e.revisionBefore, before) && sameRevision(e.revisionAfter, before)
      && e.interval.clockDomain === clock.domain && e.interval.endMonoMs <= boundary && e.interval.endMonoMs - e.interval.startMonoMs <= 1000);
    const ids = stableLifetime && changed ? evidence.filter(e => semanticScope(e) && e.acquisition === 'ok' && e.freshness === 'current'
      && sameTarget(e.target, target) && sameRevision(e.revisionBefore, after) && sameRevision(e.revisionAfter, after)
      && e.interval.clockDomain === clock.domain && e.interval.startMonoMs >= boundary && e.interval.endMonoMs <= now
      && now - e.interval.endMonoMs <= 1000 && e.interval.endMonoMs - e.interval.startMonoMs <= 1000
      && baseline.some(old => old.source === e.source && canonicalJson(old.coverage) === canonicalJson(e.coverage)
        && semanticContent(old) !== null && semanticContent(e) !== null && semanticContent(old) !== semanticContent(e))).map(e => e.id) : [];
    if (!ids.length) return { progress: false, evidenceIds: [], reason: 'no_fresh_semantic_change' };
    const state = this._run(runId);
    state.noProgress = 0;
    const cleared = state.gate?.reason === 'no_progress' && !state.gate.blocked && !state.recovery;
    if (cleared) state.gate = null;
    return { progress: true, evidenceIds: [...new Set(ids)], reason: cleared ? 'no_progress_gate_cleared' : 'observed_semantic_change' };
  }
  async diagnose(runId, probes, ctx) {
    const state = this._run(runId); if (!state.gate) return null;
    if (!Array.isArray(probes) || probes.length > 3 || state.gate.probes + probes.length > 3) throw new ContractError('diagnosis_probe_limit');
    const progress = ctx.progress.child(5000), results = [];
    for (const probe of probes) { state.gate.probes++; results.push(await progress.phase('diagnosis_probe', () => probe({ ...ctx, progress, budget: progress.budget, dispatch: { beforeEffect: async () => { throw new ContractError('diagnosis_read_only'); } } }))); }
    return { ...state.gate, results };
  }
  allowRecovery(runId, { action, hypothesis, evidenceIds, predictedAssertions }) {
    const state = this._run(runId), key = intentKey(action);
    if (!state.gate || state.gate.blocked || state.recovery || key === state.gate.failedIntent || state.unknown.has(key) || action.runId !== runId || !hypothesis || !evidenceIds?.length || !predictedAssertions?.length) throw new ContractError('invalid_recovery');
    state.recovery = { key, used: false };
  }
  status(runId) { return this._run(runId).gate; }
}
function revisionChangedUnexpectedly(before, after, expectedTransition = false) {
  if (!sameTarget(before.target, after.target)) return true;
  const a = before.revision, b = after.revision;
  return ['sessionGeneration', 'grantGeneration', 'connectionEpoch', 'targetGeneration', 'documentEpoch', 'geometryRevision', 'semanticRevision'].some(k => a[k] !== b[k] && (!expectedTransition || !['documentEpoch', 'geometryRevision', 'semanticRevision'].includes(k)));
}
module.exports = { classifyFailure, intentKey, FailureDetector, revisionChangedUnexpectedly };
