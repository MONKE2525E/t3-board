'use strict';

const { createHmac, timingSafeEqual } = require('node:crypto');
const ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const enums = {
  execution: ['completed', 'rejected', 'failed', 'cancelled', 'skipped', 'unfinished'],
  dispatch: ['not_started', 'possible', 'sent', 'acknowledged'],
  effect: ['none_proven', 'verified', 'partial_verified', 'unknown'],
  replay: ['forbidden', 'same_id_receipt_only', 'refresh_before_new_action'],
  persistence: ['durable', 'degraded', 'unavailable'],
  status: ['satisfied', 'unsatisfied', 'unknown', 'pending'],
  producer: ['deterministic', 'model_inferred', 'human_reported'],
  availability: ['retained', 'transfer_failed', 'expired', 'redacted', 'unavailable', 'withheld_private'],
  freshness: ['current', 'stale', 'unknown', 'suspect'],
};
const codes = new Set(('invalid_request stale_target ambiguous_target not_ready occluded focus_lost permission_denied user_takeover cancelled deadline transport_lost backend_unavailable assertion_failed verification_unavailable internal_defect diagnosis_required history_incomplete storage_unavailable result_overflow cursor_invalid cursor_expired record_corrupt unknown_schema history_gap dedup_expired dedup_collision dedup_pending run_unknown run_retired manifest_missing evidence_unavailable evidence_expired evidence_ineligible validator_unavailable predicate_mismatch narrative_ignored journal_unavailable journal_full journal_write_failed journal_sync_failed journal_timeout ledger_invalid key_missing key_invalid writer_busy unsafe_path record_too_large queue_full reservation_missing persistence_degraded required_next_unknown refresh_readonly reconcile_readonly user_resume_required stop no_replay none unknown unsupported timeout incomplete truncated blocked input_acknowledged exact_match absent complete authoritative_conflict cross_revision redacted transfer_failed ENOSPC EIO EACCES ETIMEDOUT').split(' '));
const kinds = new Set('invalid_request stale_target ambiguous_target not_ready occluded focus_lost permission_denied user_takeover cancelled deadline transport_lost backend_unavailable assertion_failed verification_unavailable internal_defect diagnosis_required history_incomplete storage_unavailable'.split(' '));
for (const value of ['trusted_user_transition', 'refresh_before_new_action', 'read_authoritative_state_do_not_replay', 'unfinished_action', 'adapter_contract_violation', 'unsupported_operation', 'session_unavailable', 'dialog_checkpoint', 'dialog_during_mouse_down', 'dialog_during_key_down', 'explicit_dialog_decision', 'file_access_denied']) codes.add(value);
const operations = new Set('query navigate click invoke focus editText press select setChecked scroll reveal upload downloadStatus dialog activateWindow closeWindow moveWindow launchApp compositorShortcut calibration assert act waitUntil checkpoint read observe fill type set_text insert_text delete_text submit capture'.split(' '));
const primitives = new Set([...operations, ...'Session.launch atspi.SetTextContents atspi.InsertText atspi.DeleteText atspi.DoAction atspi.SetSelection Input.insertText Input.dispatchKeyEvent Input.dispatchMouseEvent Page.navigate DOM.setFileInputFiles cdp keyboard pointer semantic clear selection mouseDown mouseUp keyDown keyUp'.split(' ')]);

function id(value) {
  if (typeof value !== 'string' || !ID.test(value) || ['__proto__', 'constructor', 'prototype'].includes(value)) throw failure('invalid_request');
  return value;
}
function failure(code, effect = 'none_proven') {
  const error = new Error(code);
  error.code = code;
  error.failure = { kind: code === 'invalid_request' ? code : 'storage_unavailable', code, phase: 'journal', effect, evidenceIds: [] };
  return error;
}
function number(value, fallback = 0) { return Number.isFinite(value) && value >= 0 ? value : fallback; }
function choice(value, field, fallback) { return enums[field].includes(value) ? value : fallback; }
function code(value) { return codes.has(value) ? value : 'unknown'; }
function ids(values) { return Array.isArray(values) ? values.slice(0, 512).filter(v => typeof v === 'string' && ID.test(v)) : []; }
function revision(value = {}) {
  const out = {};
  for (const key of ['sessionGeneration', 'grantGeneration', 'connectionEpoch', 'targetGeneration', 'documentEpoch', 'semanticRevision', 'geometryRevision']) {
    if (Number.isSafeInteger(value[key]) && value[key] >= 0) out[key] = value[key];
  }
  return out;
}
function target(value) {
  if (!value) return undefined;
  const out = { sessionId: id(value.sessionId), kind: ['tab', 'session'].includes(value.kind) ? value.kind : 'window', targetId: id(value.targetId), generation: number(value.generation), ownership: value.ownership === 'owned' ? 'owned' : 'borrowed' };
  for (const key of ['compositorInstance', 'browserInstance']) if (value[key]) out[key] = id(value[key]);
  if (Number.isSafeInteger(value.connectionEpoch)) out.connectionEpoch = value.connectionEpoch;
  if (value.process) out.process = { pid: number(value.process.pid), startToken: id(value.process.startToken) };
  return out;
}
function sameTarget(a, b) {
  return !!a && !!b && a.sessionId === b.sessionId && a.targetId === b.targetId && a.generation === b.generation && a.kind === b.kind && a.ownership === b.ownership && a.connectionEpoch === b.connectionEpoch && a.browserInstance === b.browserInstance && a.compositorInstance === b.compositorInstance && a.process?.pid === b.process?.pid && a.process?.startToken === b.process?.startToken;
}
function timings(value = {}) {
  const out = { clockDomain: typeof value.clockDomain === 'string' && ID.test(value.clockDomain) ? value.clockDomain : 'main', startMonoMs: number(value.startMonoMs), endMonoMs: number(value.endMonoMs), totalMs: number(value.totalMs), phases: {} };
  for (const key of ['queue', 'permission', 'resolve', 'preflight', 'dispatch', 'appConsumption', 'settle', 'readback', 'capture', 'transfer', 'journalFsync', 'total']) if (Number.isFinite(value.phases?.[key])) out.phases[key] = number(value.phases[key]);
  return out;
}
function safeFailure(value) {
  if (!value) return undefined;
  const out = { kind: kinds.has(value.kind) ? value.kind : 'internal_defect', code: code(value.code), phase: ['admission', 'journal', 'preflight', 'dispatch', 'verification', 'capture', 'transfer', 'permission', 'execution', 'plan'].includes(value.phase) ? value.phase : 'execution', effect: choice(value.effect, 'effect', 'unknown'), evidenceIds: ids(value.evidenceIds) };
  if (value.actionId) out.actionId = id(value.actionId);
  if (value.requiredNext) out.requiredNext = code(value.requiredNext);
  return out;
}
function assertion(value) {
  const out = { predicateId: id(value.predicateId), status: choice(value.status, 'status', 'unknown'), producer: choice(value.producer, 'producer', 'model_inferred'), evidenceIds: ids(value.evidenceIds), actionIds: ids(value.actionIds), reasonCodes: (value.reasonCodes || []).slice(0, 32).map(code) };
  if (value.observedRevision) out.observedRevision = revision(value.observedRevision);
  return out;
}
function attempt(value) {
  return JSON.parse(JSON.stringify({ id: id(value.id), primitive: primitives.has(value.primitive) ? value.primitive : 'unknown', substep: operations.has(value.substep) ? value.substep : 'unknown', target: target(value.target), dispatch: choice(value.dispatch, 'dispatch', 'possible'), effect: choice(value.effect, 'effect', 'unknown'), timings: timings(value.timings), failure: safeFailure(value.failure), evidenceIds: ids(value.evidenceIds) }));
}
function artifact(value) {
  const out = { id: id(value.id), availability: choice(value.availability, 'availability', 'unavailable'), freshness: choice(value.freshness, 'freshness', 'unknown') };
  for (const key of ['captureId', 'blobId', 'deliveryId']) if (value[key]) out[key] = id(value[key]);
  return out;
}
function receipt(value) {
  const out = { schema: 'muse.action_receipt.v1', runId: id(value.runId), invokeId: id(value.invokeId), actionId: id(value.actionId), target: target(value.target), before: revision(value.before), execution: choice(value.execution, 'execution', 'unfinished'), dispatch: choice(value.dispatch, 'dispatch', 'possible'), effect: choice(value.effect, 'effect', 'unknown'), attempts: (value.attempts || []).slice(0, 256).map(attempt), assertions: (value.assertions || []).slice(0, 32).map(assertion), failure: safeFailure(value.failure), replay: choice(value.replay, 'replay', 'forbidden'), timings: timings(value.timings), journal: { throughSeq: number(value.journal?.throughSeq), integrity: ['complete', 'gapped'].includes(value.journal?.integrity) ? value.journal.integrity : 'unknown' }, artifacts: (value.artifacts || []).slice(0, 64).map(artifact), persistence: choice(value.persistence, 'persistence', 'degraded') };
  if (value.parentActionId) out.parentActionId = id(value.parentActionId);
  if (Number.isSafeInteger(value.stepIndex)) out.stepIndex = value.stepIndex;
  if (value.after) out.after = revision(value.after);
  return JSON.parse(JSON.stringify(out));
}
function summary(value) {
  const commands = new Set('computer.action computer.plan computer.session.create computer.session.pause computer.session.stop computer.run.begin computer.run.start computer.run.result computer.trace.read computer.evidence.read computer.observe computer.query computer.edit computer.navigate computer.click computer.control computer.batch computer.batch.step computer.calibration'.split(' '));
  const out = { command: commands.has(value.command) ? value.command : 'unknown', operationKind: operations.has(value.operationKind) ? value.operationKind : 'unknown', parameterMac: value.parameterMac, inputSizes: {} };
  if (!/^[a-f0-9]{64}$/.test(value.parameterMac)) throw failure('invalid_request');
  if (value.target) out.target = target(value.target);
  for (const key of ['scalars', 'utf16Units', 'utf8Bytes', 'steps', 'predicates', 'files']) if (Number.isFinite(value.inputSizes?.[key])) out.inputSizes[key] = number(value.inputSizes[key]);
  return out;
}

// Reject lossy JSON values rather than making different parameters share a MAC.
function canonical(value, depth = 0) {
  if (depth > 32) throw failure('invalid_request');
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean') return String(value);
  if (typeof value === 'number' && Number.isFinite(value)) return Object.is(value, -0) ? '-0' : String(value);
  if (Array.isArray(value)) return '[' + Array.from(value, v => canonical(v, depth + 1)).join(',') + ']';
  if (value && Object.getPrototypeOf(value) === Object.prototype) {
    if (Object.getOwnPropertySymbols(value).length) throw failure('invalid_request');
    return '{' + Object.keys(value).sort().map(k => {
      const descriptor = Object.getOwnPropertyDescriptor(value, k);
      if (!Object.hasOwn(descriptor, 'value')) throw failure('invalid_request');
      return JSON.stringify(k) + ':' + canonical(descriptor.value, depth + 1);
    }).join(',') + '}';
  }
  throw failure('invalid_request');
}
function mac(key, value, maxBytes = 32 * 1024 * 1024) { const text = canonical(value); if (Buffer.byteLength(text) > maxBytes) throw failure('invalid_request'); return createHmac('sha256', key).update(text).digest('hex'); }
function equalMac(a, b) { return typeof a === 'string' && typeof b === 'string' && /^[a-f0-9]{64}$/.test(a) && /^[a-f0-9]{64}$/.test(b) && timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex')); }
module.exports = { id, ids, failure, number, code, revision, target, sameTarget, timings, safeFailure, assertion, attempt, artifact, receipt, summary, canonical, mac, equalMac, operations, primitives };
