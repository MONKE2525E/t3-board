const { randomUUID } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');

const SOURCES = ['window', 'lifecycle', 'dom', 'browser_ax', 'atspi', 'pixels', 'ocr'];
const HARD_FENCES = ['sessionGeneration', 'grantGeneration', 'connectionEpoch', 'targetGeneration', 'documentEpoch'];
const SEMANTIC_SOURCES = ['dom', 'browser_ax', 'atspi'];
const VISUAL_SOURCES = ['pixels', 'ocr'];
const clone = value => structuredClone(value);
const id = (prefix = 'evidence') => `${prefix}-${randomUUID()}`;
function fail(code, kind = 'stale_target') {
  const error = new Error(code);
  error.code = code;
  error.kind = kind;
  error.effect = 'none_proven';
  return error;
}
function assertId(value) {
  if (typeof value !== 'string' || !value.length || value.length > 128 || /[\x00-\x1f]/.test(value)) throw fail('invalid_id', 'invalid_request');
}
function assertTarget(target) {
  if (!target || !['window', 'tab'].includes(target.kind) || !['owned', 'borrowed'].includes(target.ownership)) throw fail('invalid_target', 'invalid_request');
  assertId(target.sessionId); assertId(target.targetId);
  if (!Number.isSafeInteger(target.generation) || target.generation < 0) throw fail('invalid_target_generation', 'invalid_request');
  if (target.process && (!Number.isSafeInteger(target.process.pid) || target.process.pid <= 0 || !target.process.startToken)) throw fail('invalid_process_identity', 'invalid_request');
}
function assertRevision(revision) {
  if (!revision) throw fail('missing_revision', 'invalid_request');
  for (const key of [...HARD_FENCES, 'semanticRevision', 'geometryRevision']) {
    if (['connectionEpoch', 'documentEpoch'].includes(key) && revision[key] === undefined) continue;
    if (!Number.isSafeInteger(revision[key]) || revision[key] < 0) throw fail('invalid_revision', 'invalid_request');
  }
}
function sameTarget(a, b) {
  return !!a && !!b && ['sessionId', 'kind', 'targetId', 'generation', 'ownership', 'compositorInstance', 'browserInstance', 'connectionEpoch'].every(key => a[key] === b[key])
    && isDeepStrictEqual(a.process, b.process);
}
function changedFences(a, b, source, { semantic = true, geometry = VISUAL_SOURCES.includes(source) } = {}) {
  const keys = [...HARD_FENCES, ...(semantic && [...SEMANTIC_SOURCES, ...VISUAL_SOURCES].includes(source) ? ['semanticRevision'] : []), ...(geometry ? ['geometryRevision'] : [])];
  return keys.filter(key => a?.[key] !== b?.[key]);
}
function exhaustive(evidence) {
  const c = evidence.coverage;
  return !!c && c.complete === true && c.truncated === false && c.omittedFrames.length === 0 && c.omissionReasons.length === 0;
}
function eligibility(evidence, target, revision, clockDomain) {
  const reasons = [];
  if (!sameTarget(evidence.target, target)) reasons.push('target_mismatch');
  if (evidence.acquisition !== 'ok') reasons.push(`acquisition_${evidence.acquisition}`);
  if (evidence.freshness !== 'current') reasons.push(`freshness_${evidence.freshness}`);
  if (clockDomain && evidence.interval.clockDomain !== clockDomain) reasons.push('clock_domain_mismatch');
  if (evidence.interval.endMonoMs < evidence.interval.startMonoMs) reasons.push('invalid_interval');
  reasons.push(...changedFences(evidence.revisionBefore, evidence.revisionAfter, evidence.source).map(key => `crossed_${key}`));
  reasons.push(...changedFences(evidence.revisionAfter, revision, evidence.source).map(key => `old_${key}`));
  return { eligible: reasons.length === 0, reasons };
}
function assertEvidence(e) {
  if (!e || !SOURCES.includes(e.source)) throw fail('invalid_evidence_source', 'invalid_request');
  assertId(e.id); assertTarget(e.target); assertRevision(e.revisionBefore); assertRevision(e.revisionAfter);
  if (typeof e.producer !== 'string' || !e.producer.length || e.producer.length > 128) throw fail('invalid_evidence_producer', 'invalid_request');
  if (!['ok', 'timeout', 'error', 'unsupported', 'not_requested'].includes(e.acquisition) || !['current', 'unknown', 'suspect', 'stale'].includes(e.freshness)) throw fail('invalid_evidence_status', 'invalid_request');
  if (!e.interval || !Number.isFinite(e.interval.startMonoMs) || !Number.isFinite(e.interval.endMonoMs) || typeof e.interval.utc !== 'string') throw fail('invalid_interval', 'invalid_request');
  assertId(e.interval.clockDomain);
  const c = e.coverage;
  if (!c || typeof c.scope !== 'string' || typeof c.complete !== 'boolean' || typeof c.truncated !== 'boolean' || !Array.isArray(c.omittedFrames) || !Array.isArray(c.omissionReasons)) throw fail('invalid_coverage', 'invalid_request');
  for (const array of [e.facts, e.reasons, e.derivedFrom, c.omittedFrames, c.omissionReasons]) if (!Array.isArray(array) || array.length > 2048) throw fail('evidence_limit', 'invalid_request');
  for (const fact of e.facts) if (!fact || typeof fact.predicate !== 'string' || !Array.isArray(fact.evidenceIds) || typeof fact.suitability !== 'string') throw fail('invalid_fact', 'invalid_request');
  if (Buffer.byteLength(JSON.stringify(e)) > 1024 * 1024) throw fail('evidence_limit', 'invalid_request');
  return e;
}
function checkContext(ctx, phase, now) {
  ctx?.progress?.check(phase);
  if (ctx?.signal?.aborted) throw fail('cancelled', 'cancelled');
  if (ctx?.budget && now && now() >= ctx.budget.deadlineMonoMs) throw fail('deadline', 'deadline');
}

// Race read-only work, abort its scoped signal, and discard all late output.
async function boundedRead(work, ctx, { now, maxMs = Infinity, phase = 'state_read' }) {
  checkContext(ctx, phase, now);
  const remaining = Math.min(maxMs, ctx?.budget ? ctx.budget.deadlineMonoMs - now() : maxMs);
  if (!Number.isFinite(remaining) || remaining <= 0) throw fail('deadline', 'deadline');
  const controller = new AbortController();
  const child = { ...ctx, signal: controller.signal, budget: { ...ctx.budget, deadlineMonoMs: now() + remaining } };
  if (ctx.progress?.child) child.progress = ctx.progress.child(remaining);
  let timer, onAbort;
  const interrupted = new Promise((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(fail('deadline', 'deadline')); }, remaining);
    onAbort = () => { controller.abort(); reject(fail('cancelled', 'cancelled')); };
    ctx.signal?.addEventListener('abort', onAbort, { once: true });
    if (ctx.signal?.aborted) onAbort();
  });
  try {
    const result = await Promise.race([Promise.resolve().then(() => work(child)), interrupted]);
    checkContext(ctx, phase, now);
    return result;
  } finally {
    clearTimeout(timer); ctx.signal?.removeEventListener('abort', onAbort); controller.abort();
  }
}

module.exports = { SOURCES, HARD_FENCES, SEMANTIC_SOURCES, VISUAL_SOURCES, clone, id, fail, assertId, assertTarget, assertRevision, sameTarget, changedFences, exhaustive, eligibility, assertEvidence, checkContext, boundedRead, isDeepStrictEqual };
