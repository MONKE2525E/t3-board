'use strict';
const { randomUUID, createHmac } = require('node:crypto');
const { performance } = require('node:perf_hooks');
class DesktopError extends Error {
  constructor(code, details = {}) { super(code); this.name = 'DesktopError'; this.code = code; Object.assign(this, details); }
}
const fail = (code, details) => { throw new DesktopError(code, details); };
function check(ctx, phase) {
  ctx.progress.check(phase);
  if (ctx.signal.aborted) fail('cancelled');
  if (!(ctx.progress.remainingMs() > 0)) fail('deadline');
}
function targetCheck(target, session, ctx) {
  check(ctx, 'desktop.scope');
  if (!session || session.state !== 'ready' || target.sessionId !== session.id || ctx.sessionId !== session.id ||
      target.kind !== 'window' || target.generation !== ctx.revision.targetGeneration ||
      ctx.revision.sessionGeneration !== session.generation || session.mode === 'borrowed_browser') fail('stale_target');
  if (!target.process || !Number.isInteger(target.process.pid) || target.process.pid <= 0 || !target.process.startToken) fail('unknown_owner');
}
function revisionCheck(ref, ctx) {
  if (!ref || ref.source !== 'atspi') fail('invalid_native_ref');
  for (const key of ['sessionGeneration', 'grantGeneration', 'targetGeneration', 'semanticRevision']) {
    if (ref.revision[key] !== ctx.revision[key]) fail('stale_ref');
  }
}
function validateText(edit) {
  if (!edit || edit.semantics !== 'plain_text' || !['replace', 'append', 'insert', 'replaceSelection'].includes(edit.mode) ||
      typeof edit.text !== 'string' || !['literal_multiline', 'reject_singleline'].includes(edit.newlinePolicy) ||
      !['forbid', 'isolated_only'].includes(edit.clipboard)) fail('unsupported_text_edit');
  if (edit.text.includes('\0') || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(edit.text)) fail('invalid_unicode');
  if ([...edit.text].length > 4096 || Buffer.byteLength(edit.text, 'utf8') > 65536) fail('text_limit');
  if (edit.selection && (edit.selection.units !== 'atspi_characters' || edit.selection.ranges?.length !== 1 ||
      edit.selection.ranges[0].length !== 2 || !edit.selection.ranges[0].every(Number.isInteger))) fail('unsupported_selection');
}
function evidence(target, ctx, facts, start, coverage = {}) {
  return { id: randomUUID(), source: 'atspi', producer: 'muse.atspi.v1', target,
    revisionBefore: { ...ctx.revision }, revisionAfter: { ...ctx.revision },
    interval: { startMonoMs: start, endMonoMs: performance.now(), clockDomain: ctx.budget.clockDomain, utc: new Date().toISOString() },
    acquisition: 'ok', freshness: 'current', reasons: [],
    coverage: { scope: 'target', complete: true, truncated: false, omittedFrames: [], omissionReasons: [], ...coverage },
    facts, derivedFrom: [] };
}
function receipt(primitive, result = {}) {
  return { path: 'atspi', primitive, execution: 'completed', dispatch: 'acknowledged', effect: 'unknown',
    attempted: true, replay: 'forbidden', evidence: [], ...result };
}
async function boundary(ctx, primitive, target, work, substep = primitive) {
  check(ctx, 'desktop.beforeEffect');
  const attempt = await ctx.dispatch.beforeEffect({ primitive, substep, target });
  // High level drivers may contain more than one OS call. The marker is conservative.
  let result;
  try { check(ctx, 'desktop.dispatch'); result = await work(); }
  catch (error) {
    await ctx.dispatch.afterEffect(attempt, { state: 'lost', noEffectProven: false });
    throw new DesktopError(error.code || 'transport_lost', { attempted: true, effect: 'unknown', cause: error });
  }
  await ctx.dispatch.afterEffect(attempt, { state: result?.accepted === false ? 'rejected' : 'accepted', noEffectProven: false });
  return result;
}
function digester(key) { return text => createHmac('sha256', key).update(text, 'utf8').digest('hex'); }
module.exports = { DesktopError, fail, check, targetCheck, revisionCheck, validateText, evidence, receipt, boundary, digester };
