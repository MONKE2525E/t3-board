'use strict';

const ENUMS = Object.freeze({
  mode: ['real_desktop', 'isolated_desktop', 'borrowed_browser'],
  ownership: ['owned', 'borrowed'],
  dispatch: ['not_started', 'possible', 'sent', 'acknowledged'],
  effect: ['none_proven', 'verified', 'partial_verified', 'unknown'],
  terminal: ['completed', 'rejected', 'failed', 'cancelled', 'skipped', 'unfinished'],
  failure: ['invalid_request', 'stale_target', 'ambiguous_target', 'not_ready', 'occluded',
    'focus_lost', 'permission_denied', 'user_takeover', 'cancelled', 'deadline', 'transport_lost',
    'backend_unavailable', 'assertion_failed', 'verification_unavailable', 'internal_defect',
    'diagnosis_required', 'history_incomplete', 'storage_unavailable'],
});
const LIMITS = Object.freeze({ invocationMs: 180000, mutations: 16, steps: 64, predicates: 32,
  planBytes: 65536, textScalars: 4096, textBytes: 65536, runActions: 128, runMs: 600000 });
class ContractError extends Error {
  constructor(code = 'invalid_request', phase = 'validation') {
    super(code); this.name = 'ContractError'; this.kind = 'invalid_request'; this.code = code; this.phase = phase;
  }
}
function fail(code) { throw new ContractError(code); }
function object(value) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) fail('plain_object_required');
  if (Object.getOwnPropertySymbols(value).length) fail('unsafe_object');
  for (const key of Object.getOwnPropertyNames(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (['__proto__', 'constructor', 'prototype'].includes(key) || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) fail('unsafe_object');
  }
  return value;
}
function fields(value, allowed, required = []) {
  object(value);
  if (Object.keys(value).some(key => !allowed.includes(key))) fail('unknown_field');
  if (required.some(key => value[key] === undefined)) fail('missing_field');
  return value;
}
function id(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_:.@+-]{1,128}$/.test(value)) fail('invalid_id');
  return value;
}
function string(value, max = 4096) { if (typeof value !== 'string' || value.length > max || value.includes('\0')) fail('invalid_string'); return value; }
function number(value, min = 0, max = Number.MAX_SAFE_INTEGER, integer = true) {
  if (!Number.isFinite(value) || value < min || value > max || integer && !Number.isSafeInteger(value)) fail('invalid_number');
  return value;
}
function boolean(value) { if (typeof value !== 'boolean') fail('invalid_boolean'); return value; }
function enumeration(value, choices) { if (!choices.includes(value)) fail('invalid_enum'); return value; }
function array(value, max, validator) {
  if (!Array.isArray(value) || value.length > max || Object.getOwnPropertySymbols(value).length || Object.getOwnPropertyNames(value).length !== value.length + 1) fail('invalid_array');
  for (let i = 0; i < value.length; i++) { const descriptor = Object.getOwnPropertyDescriptor(value, String(i)); if (!descriptor || !Object.hasOwn(descriptor, 'value')) fail('invalid_array'); validator(descriptor.value); }
  return value;
}
const privateHandles = new WeakSet();
function createPrivateHandle(kind, handleId) { const value = Object.freeze({ kind: string(kind, 64), id: id(handleId) }); privateHandles.add(value); return value; }
function isPrivateHandle(value, kind) { return !!value && privateHandles.has(value) && (!kind || value.kind === kind); }
function assertPrivateHandle(value, kind) { if (!isPrivateHandle(value, kind)) fail('untrusted_private_handle'); return value; }
function validateJson(value, depth = 0, seen = new Set()) {
  if (depth > 32) fail('json_depth');
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'string') { string(value, 65536); return; }
  if (typeof value === 'number') { if (!Number.isFinite(value) || Object.is(value, -0)) fail('invalid_number'); return; }
  if (typeof value !== 'object' || seen.has(value)) fail('invalid_json');
  seen.add(value);
  if (Array.isArray(value)) array(value, 4096, x => validateJson(x, depth + 1, seen));
  else {
    object(value);
    if (privateHandles.has(value) || ['grant', 'lease', 'selected_target', 'local_user_resume', 'cdp_capability', 'native_object', 'action', 'attempt'].includes(value.kind)) fail('opaque_handle_in_rpc');
    Object.values(value).forEach(x => validateJson(x, depth + 1, seen));
  }
  seen.delete(value);
}
function canonicalJson(value) {
  validateJson(value);
  const walk = x => x && typeof x === 'object' ? Array.isArray(x) ? x.map(walk) : Object.fromEntries(Object.keys(x).sort().map(k => [k, walk(x[k])])) : x;
  return JSON.stringify(walk(value));
}
function validateRevision(r) {
  const required = ['sessionGeneration', 'grantGeneration', 'targetGeneration', 'semanticRevision', 'geometryRevision'];
  fields(r, [...required, 'connectionEpoch', 'documentEpoch'], required);
  Object.values(r).forEach(x => number(x)); return r;
}
function sameRevision(a, b, { geometry = true } = {}) {
  return ['sessionGeneration', 'grantGeneration', 'connectionEpoch', 'targetGeneration', 'documentEpoch', 'semanticRevision', ...(geometry ? ['geometryRevision'] : [])].every(k => a?.[k] === b?.[k]);
}
function validateTargetRef(t) {
  fields(t, ['sessionId', 'kind', 'targetId', 'generation', 'ownership', 'process', 'compositorInstance', 'browserInstance', 'connectionEpoch'], ['sessionId', 'kind', 'targetId', 'generation', 'ownership']);
  id(t.sessionId); id(t.targetId); enumeration(t.kind, ['window', 'tab', 'session']); number(t.generation); enumeration(t.ownership, ENUMS.ownership);
  for (const k of ['compositorInstance', 'browserInstance']) if (t[k] !== undefined) id(t[k]);
  if (t.connectionEpoch !== undefined) number(t.connectionEpoch);
  if (t.process) { fields(t.process, ['pid', 'startToken'], ['pid', 'startToken']); number(t.process.pid, 1); string(t.process.startToken, 128); }
  if (t.kind === 'session' && (t.targetId !== t.sessionId || t.ownership !== 'owned' || !t.compositorInstance || t.process || t.browserInstance || t.connectionEpoch !== undefined)) fail('invalid_session_target');
  return t;
}
function sameTarget(a, b) { return canonicalJson(a) === canonicalJson(b); }
function validateElementRef(r) {
  fields(r, ['id', 'refSetId', 'target', 'revision', 'source', 'frame', 'native', 'browser', 'identity', 'capabilities'], ['id', 'refSetId', 'target', 'revision', 'source', 'identity', 'capabilities']);
  id(r.id); id(r.refSetId); validateTargetRef(r.target); validateRevision(r.revision); enumeration(r.source, ['dom', 'browser_ax', 'atspi']);
  fields(r.identity, ['roleCode', 'role', 'semanticFingerprint'], ['role', 'semanticFingerprint']); string(r.identity.role, 128); id(r.identity.semanticFingerprint);
  if (r.identity.roleCode !== undefined) number(r.identity.roleCode);
  array(r.capabilities, 64, x => string(x, 128));
  if (r.frame) {
    fields(r.frame, ['tab', 'frameId', 'frameGeneration', 'documentToken', 'executionContextId', 'cdpSessionId'], ['tab', 'frameId', 'frameGeneration', 'documentToken', 'executionContextId', 'cdpSessionId']);
    validateTargetRef(r.frame.tab); if (!sameTarget(r.target, r.frame.tab)) fail('frame_target_mismatch');
    number(r.frame.frameGeneration); ['frameId', 'documentToken', 'executionContextId', 'cdpSessionId'].forEach(k => id(r.frame[k]));
  }
  if (r.native) {
    fields(r.native, ['busUniqueName', 'objectPath', 'rootHandle', 'workerGeneration', 'ownerStartToken'], ['busUniqueName', 'objectPath', 'rootHandle', 'workerGeneration', 'ownerStartToken']);
    id(r.native.busUniqueName); if (!r.native.busUniqueName.startsWith(':')) fail('native_owner_not_unique');
    if (typeof r.native.objectPath !== 'string' || !/^\/(?:[A-Za-z0-9_]+\/?)*$/.test(r.native.objectPath) || r.native.objectPath.length > 1024) fail('invalid_object_path');
    id(r.native.rootHandle); number(r.native.workerGeneration); string(r.native.ownerStartToken, 128);
  }
  if (r.browser) { fields(r.browser, ['backendNodeId', 'objectToken'], ['backendNodeId', 'objectToken']); number(r.browser.backendNodeId, 1); id(r.browser.objectToken); }
  return r;
}
function validateCoordinateRef(r) {
  fields(r, ['captureId', 'transformId', 'target', 'revision', 'point', 'space'], ['captureId', 'transformId', 'target', 'revision', 'point', 'space']);
  id(r.captureId); id(r.transformId); validateTargetRef(r.target); validateRevision(r.revision); enumeration(r.space, ['capture_px', 'window_normalized']);
  array(r.point, 2, x => number(x, 0, r.space === 'window_normalized' ? 1 : 1e7, false)); if (r.point.length !== 2) fail('invalid_point'); return r;
}
function validateRef(r) { return r?.captureId !== undefined ? validateCoordinateRef(r) : validateElementRef(r); }
function validateTextEdit(e) {
  fields(e, ['mode', 'text', 'expectedBefore', 'selection', 'semantics', 'newlinePolicy', 'clipboard'], ['mode', 'text', 'semantics', 'newlinePolicy', 'clipboard']);
  enumeration(e.semantics, ['plain_text']);
  enumeration(e.mode, ['replace', 'append', 'insert', 'replaceSelection']); string(e.text, 65536);
  if (/[\uD800-\uDFFF]/u.test(e.text) || [...e.text].length > LIMITS.textScalars || Buffer.byteLength(e.text) > LIMITS.textBytes) fail('invalid_text');
  enumeration(e.newlinePolicy, ['literal_multiline', 'reject_singleline']); enumeration(e.clipboard, ['forbid', 'isolated_only']);
  if (e.expectedBefore !== undefined) { fields(e.expectedBefore, ['privateDigest', 'scalarCount'], ['privateDigest', 'scalarCount']); id(e.expectedBefore.privateDigest); number(e.expectedBefore.scalarCount); }
  if (e.selection !== undefined) {
    const s = e.selection; enumeration(s.units, ['atspi_characters', 'dom_utf16', 'dom_range']);
    if (s.units === 'atspi_characters') { fields(s, ['units', 'ranges'], ['ranges']); array(s.ranges, 1, r => { array(r, 2, x => number(x)); if (r.length !== 2 || r[1] < r[0]) fail('invalid_range'); }); }
    else if (s.units === 'dom_utf16') { fields(s, ['units', 'start', 'end'], ['start', 'end']); number(s.start); number(s.end, s.start); }
    else { fields(s, ['units', 'anchorRef', 'anchorOffset', 'focusRef', 'focusOffset'], ['anchorRef', 'anchorOffset', 'focusRef', 'focusOffset']); id(s.anchorRef); id(s.focusRef); number(s.anchorOffset); number(s.focusOffset); }
  }
  return e;
}
const OP_FIELDS = Object.freeze({ query: ['target', 'query'], navigate: ['target', 'url'], click: ['ref', 'button'], invoke: ['ref', 'actionName'], focus: ['ref'], editText: ['ref', 'edit'], press: ['target', 'ref', 'chord'], select: ['ref', 'itemRefs', 'mode'], setChecked: ['ref', 'checked'], scroll: ['ref', 'axis', 'delta'], reveal: ['ref', 'edge'], upload: ['ref', 'fileCapabilityIds'], downloadStatus: ['downloadId'], dialog: ['dialogId', 'decision', 'text'], activateWindow: ['target'], closeWindow: ['target'], moveWindow: ['target', 'workspace', 'follow'], launchApp: ['target', 'appId'], compositorShortcut: ['sessionId', 'configuredBindingId'] });
function validateOperation(op, mode) {
  object(op); const keys = OP_FIELDS[op.kind]; if (!keys) fail('unsupported_operation');
  fields(op, ['kind', ...keys], ['kind', ...keys.filter(k => !['text', 'ref'].includes(k) || op.kind !== 'press' && k !== 'text')]);
  if (op.target) validateTargetRef(op.target);
  if (op.kind === 'launchApp') { if (mode !== 'isolated_desktop' || op.target.kind !== 'session') fail('operation_mode_denied'); id(op.appId); }
  else if (op.target?.kind === 'session' || op.ref?.target.kind === 'session') fail('operation_mode_denied');
  if (op.ref) (['click', 'scroll'].includes(op.kind) ? validateRef : validateElementRef)(op.ref);
  if (mode === 'borrowed_browser' && (['activateWindow', 'closeWindow', 'moveWindow', 'compositorShortcut'].includes(op.kind) || op.ref?.captureId || op.ref?.source === 'atspi')) fail('operation_mode_denied');
  if (op.kind === 'query') {
    fields(op.query, ['role', 'name', 'states', 'rootRefId', 'exact', 'limit', 'scope'], ['exact', 'limit', 'scope']);
    if (op.query.role !== undefined) string(op.query.role, 128); if (op.query.name !== undefined) string(op.query.name);
    if (op.query.rootRefId !== undefined) id(op.query.rootRefId);
    if (op.query.states !== undefined) { object(op.query.states); if (Object.keys(op.query.states).length > 32) fail('query_states_limit'); Object.values(op.query.states).forEach(boolean); }
    boolean(op.query.exact); number(op.query.limit, 1, 256); enumeration(op.query.scope, ['visible', 'structural']);
  }
  if (op.kind === 'editText') validateTextEdit(op.edit);
  if (op.kind === 'navigate') string(op.url, 8192);
  if (op.button !== undefined) enumeration(op.button, ['left', 'right', 'middle']);
  if (op.actionName !== undefined) string(op.actionName, 128);
  if (op.chord !== undefined) string(op.chord, 256);
  if (op.itemRefs) { array(op.itemRefs, 64, validateElementRef); enumeration(op.mode, ['replace', 'add', 'remove']); }
  if (op.checked !== undefined) boolean(op.checked);
  if (op.axis !== undefined) { enumeration(op.axis, ['x', 'y']); number(op.delta, -1e6, 1e6, false); }
  if (op.edge !== undefined) enumeration(op.edge, ['nearest', 'start', 'end']);
  if (op.fileCapabilityIds) array(op.fileCapabilityIds, 64, id);
  if (op.downloadId !== undefined) id(op.downloadId); if (op.dialogId !== undefined) id(op.dialogId);
  if (op.decision !== undefined) enumeration(op.decision, ['accept', 'dismiss']); if (op.text !== undefined) string(op.text);
  if (op.workspace !== undefined) { string(op.workspace, 128); boolean(op.follow); }
  if (op.sessionId !== undefined) id(op.sessionId); if (op.configuredBindingId !== undefined) id(op.configuredBindingId);
  return op;
}
function validatePredicate(p) {
  fields(p, ['id', 'validator', 'validatorVersion', 'target', 'args', 'requirementId'], ['id', 'validator', 'validatorVersion', 'target', 'args']);
  id(p.id); id(p.validator); number(p.validatorVersion, 1); validateTargetRef(p.target); object(p.args); validateJson(p.args); if (p.requirementId !== undefined) id(p.requirementId); return p;
}
function validateActionRequest(a, mode) {
  fields(a, ['schema', 'actionId', 'runId', 'invokeId', 'target', 'expectedRevision', 'operation', 'require', 'expect', 'requirementIds'], ['schema', 'actionId', 'runId', 'invokeId', 'target', 'expectedRevision', 'operation', 'require', 'expect', 'requirementIds']);
  if (a.schema !== 'muse.action.v1') fail('invalid_schema'); ['actionId', 'runId', 'invokeId'].forEach(k => id(a[k]));
  validateTargetRef(a.target); validateRevision(a.expectedRevision); if (a.target.generation !== a.expectedRevision.targetGeneration) fail('generation_mismatch');
  if (a.target.kind === 'session' && (mode !== 'isolated_desktop' || a.operation.kind !== 'launchApp')) fail('operation_mode_denied');
  if (mode === 'borrowed_browser' && a.target.kind !== 'tab') fail('operation_mode_denied');
  validateOperation(a.operation, mode); array(a.require, 32, validatePredicate); array(a.expect, 32, validatePredicate); array(a.requirementIds, 32, id);
  for (const t of [a.operation.target, a.operation.ref?.target, ...(a.operation.itemRefs || []).map(r => r.target), ...[...a.require, ...a.expect].map(p => p.target)].filter(Boolean)) if (!sameTarget(t, a.target)) fail('target_mismatch');
  for (const ref of [a.operation.ref, ...(a.operation.itemRefs || [])].filter(Boolean)) if (!sameRevision(ref.revision, a.expectedRevision)) fail('ref_revision_mismatch');
  if (a.operation.sessionId && a.operation.sessionId !== a.target.sessionId) fail('session_mismatch'); return a;
}
function validatePlanRequest(p, mode) {
  fields(p, ['schema', 'planId', 'runId', 'invokeId', 'sessionId', 'steps', 'totalBudgetMs', 'resumeCheckpointId'], ['schema', 'planId', 'runId', 'invokeId', 'sessionId', 'steps', 'totalBudgetMs']);
  if (p.schema !== 'muse.plan.v1') fail('invalid_schema'); ['planId', 'runId', 'invokeId', 'sessionId'].forEach(k => id(p[k]));
  number(p.totalBudgetMs, 1, LIMITS.invocationMs); if (p.resumeCheckpointId !== undefined) id(p.resumeCheckpointId);
  let mutations = 0, predicates = 0; const ids = new Set(); const actionIds = new Set();
  array(p.steps, LIMITS.steps, s => {
    object(s); id(s.id); if (ids.has(s.id)) fail('duplicate_step_id'); ids.add(s.id);
    if (s.kind === 'act') {
      fields(s, ['id', 'kind', 'action', 'transition'], ['action']); validateActionRequest(s.action, mode);
      if (s.action.runId !== p.runId || s.action.invokeId !== p.invokeId || s.action.target.sessionId !== p.sessionId) fail('plan_action_scope');
      if (actionIds.has(s.action.actionId)) fail('duplicate_action_id'); actionIds.add(s.action.actionId);
      if (isMutation(s.action.operation)) mutations++;
      predicates += s.action.require.length + s.action.expect.length;
      if (s.transition) { fields(s.transition, ['predicates', 'bindAs'], ['predicates']); array(s.transition.predicates, 32, validatePredicate); predicates += s.transition.predicates.length; if (s.transition.bindAs !== undefined) id(s.transition.bindAs); }
    } else if (['assert', 'waitUntil'].includes(s.kind)) {
      fields(s, ['id', 'kind', 'predicates', ...(s.kind === 'waitUntil' ? ['maxMs'] : [])], ['predicates']); array(s.predicates, 32, validatePredicate); predicates += s.predicates.length;
      if (s.kind === 'waitUntil') number(s.maxMs, 1, LIMITS.invocationMs);
    } else if (s.kind === 'checkpoint') { fields(s, ['id', 'kind', 'requirementIds'], ['requirementIds']); array(s.requirementIds, 32, id); }
    else fail('invalid_step_kind');
    const scoped = s.transition?.predicates || s.predicates || [];
    for (const predicate of scoped) {
      if (predicate.target.sessionId !== p.sessionId) fail('plan_predicate_scope');
      if (s.kind === 'act' && !sameTarget(predicate.target, s.action.target)) fail('target_mismatch');
    }
    if (scoped.some(predicate => !sameTarget(predicate.target, scoped[0].target))) fail('assertion_target_mismatch');
  });
  if (!p.steps.length || mutations > LIMITS.mutations || predicates > LIMITS.predicates || Buffer.byteLength(canonicalJson(p)) > LIMITS.planBytes) fail('plan_limit');
  return p;
}
function validateInvocation(req) {
  fields(req, ['deviceId', 'runId', 'invokeId', 'command', 'params', 'deadlineUtcMs', 'modelRequestId', 'modelResponseId'], ['deviceId', 'invokeId', 'command', 'params', 'deadlineUtcMs']);
  id(req.deviceId); id(req.invokeId); if (req.runId !== undefined) id(req.runId); string(req.command, 128); object(req.params); validateJson(req.params); number(req.deadlineUtcMs);
  for (const k of ['modelRequestId', 'modelResponseId']) if (req[k] !== undefined) id(req[k]);
  if (Buffer.byteLength(canonicalJson(req.params)) > LIMITS.planBytes) fail('invocation_limit'); return req;
}
function isMutation(op) { return !['query', 'downloadStatus'].includes(op.kind); }
function validateBudget(b) { fields(b, ['deadlineMonoMs', 'clockDomain'], ['deadlineMonoMs', 'clockDomain']); number(b.deadlineMonoMs, 0, Number.MAX_SAFE_INTEGER, false); id(b.clockDomain); return b; }
function validateAssertionResult(a) {
  fields(a, ['predicateId', 'status', 'producer', 'evidenceIds', 'actionIds', 'reasonCodes', 'observedRevision', 'observedAtUtc'], ['predicateId', 'status', 'producer', 'evidenceIds', 'actionIds', 'reasonCodes']);
  id(a.predicateId); enumeration(a.status, ['satisfied', 'unsatisfied', 'unknown', 'pending']); enumeration(a.producer, ['deterministic', 'model_inferred', 'human_reported']);
  array(a.evidenceIds, 256, id); array(a.actionIds, 128, id); array(a.reasonCodes, 64, x => id(x));
  if (a.observedRevision) validateRevision(a.observedRevision); if (a.observedAtUtc !== undefined) string(a.observedAtUtc, 64); return a;
}
function validateEvidence(e) {
  fields(e, ['id', 'source', 'producer', 'target', 'revisionBefore', 'revisionAfter', 'interval', 'acquisition', 'freshness', 'reasons', 'coverage', 'facts', 'derivedFrom', 'artifact'], ['id', 'source', 'producer', 'target', 'revisionBefore', 'revisionAfter', 'interval', 'acquisition', 'freshness', 'reasons', 'coverage', 'facts', 'derivedFrom']);
  id(e.id); enumeration(e.source, ['window', 'lifecycle', 'dom', 'browser_ax', 'atspi', 'pixels', 'ocr']); string(e.producer, 128); validateTargetRef(e.target);
  validateRevision(e.revisionBefore); validateRevision(e.revisionAfter);
  fields(e.interval, ['startMonoMs', 'endMonoMs', 'clockDomain', 'utc'], ['startMonoMs', 'endMonoMs', 'clockDomain', 'utc']);
  number(e.interval.startMonoMs, 0, Number.MAX_SAFE_INTEGER, false); number(e.interval.endMonoMs, e.interval.startMonoMs, Number.MAX_SAFE_INTEGER, false); id(e.interval.clockDomain); string(e.interval.utc, 64);
  enumeration(e.acquisition, ['ok', 'timeout', 'error', 'unsupported', 'not_requested']); enumeration(e.freshness, ['current', 'unknown', 'suspect', 'stale']); array(e.reasons, 64, id);
  fields(e.coverage, ['scope', 'complete', 'truncated', 'omittedFrames', 'omissionReasons'], ['scope', 'complete', 'truncated', 'omittedFrames', 'omissionReasons']);
  string(e.coverage.scope, 128); boolean(e.coverage.complete); boolean(e.coverage.truncated); array(e.coverage.omittedFrames, 256, id); array(e.coverage.omissionReasons, 64, id);
  array(e.facts, 4096, f => { fields(f, ['predicate', 'value', 'evidenceIds', 'suitability'], ['predicate', 'value', 'evidenceIds', 'suitability']); id(f.predicate); validateJson(f.value); array(f.evidenceIds, 256, id); string(f.suitability, 128); });
  array(e.derivedFrom, 256, id);
  if (e.artifact) { fields(e.artifact, ['captureId', 'blobId', 'transformId', 'provenance'], ['captureId', 'provenance']); id(e.artifact.captureId); if (e.artifact.blobId !== undefined) id(e.artifact.blobId); if (e.artifact.transformId !== undefined) id(e.artifact.transformId); enumeration(e.artifact.provenance, ['visible_window', 'tab_composited', 'ocr_crop']); }
  return e;
}
function validatePreflightResult(p) {
  fields(p, ['eligible', 'revision', 'evidence', 'noEffectProven', 'failure'], ['eligible', 'revision', 'evidence', 'noEffectProven']); boolean(p.eligible); boolean(p.noEffectProven); validateRevision(p.revision); array(p.evidence, 256, validateEvidence); return p;
}
function validateAdapterReceipt(r) {
  fields(r, ['target', 'before', 'after', 'dispatch', 'effect', 'attempts', 'evidence', 'failure', 'timings'], ['target', 'before', 'dispatch', 'effect', 'attempts', 'evidence', 'timings']);
  validateTargetRef(r.target); validateRevision(r.before); if (r.after) validateRevision(r.after);
  enumeration(r.dispatch, ENUMS.dispatch); enumeration(r.effect, ENUMS.effect); array(r.attempts, 256, a => { id(a.id); enumeration(a.dispatch, ENUMS.dispatch); enumeration(a.effect, ENUMS.effect); }); array(r.evidence, 256, validateEvidence); return r;
}
module.exports = { ENUMS, LIMITS, ContractError, id, fields, enumeration, validateJson, canonicalJson,
  createPrivateHandle, isPrivateHandle, assertPrivateHandle, validateRevision, sameRevision, validateTargetRef,
  sameTarget, validateElementRef, validateCoordinateRef, validateRef, validateTextEdit, validateOperation,
  validatePredicate, validateActionRequest, validatePlanRequest, validateInvocation, isMutation,
  validateBudget, validateAssertionResult, validateEvidence, validatePreflightResult, validateAdapterReceipt };
