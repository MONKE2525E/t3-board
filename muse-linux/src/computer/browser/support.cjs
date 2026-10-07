'use strict';
const { randomUUID, createHmac } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const id = () => randomUUID();
const clock = { now: () => performance.now(), domain: 'node.performance' };
class BrowserFailure extends Error {
  constructor(code, phase = 'browser', effect = 'none_proven') {
    super(code); this.name = 'BrowserFailure'; this.code = code; this.phase = phase; this.effect = effect;
  }
}
function cdpFailure(error) {
  const message = typeof error?.message === 'string' ? error.message : '';
  // Keep protocol diagnostics private. Only known lifecycle failures become codes.
  const code = /Session with given id not found\.?$/.test(message) ? 'cdp_session_gone'
    : /Cannot find context with specified id|Execution context was destroyed|Cannot find execution context/.test(message) ? 'cdp_context_gone'
      : /No frame for given id found|Frame with the given id was not found/.test(message) ? 'cdp_frame_gone'
        : /Could not find object with given id|Cannot find object with given id/.test(message) ? 'cdp_object_gone' : 'cdp_rejected';
  return new BrowserFailure(code, 'protocol');
}
function check(ctx, now = clock.now) {
  ctx?.progress?.check('browser');
  if (ctx?.signal?.aborted) throw new BrowserFailure('cancelled');
  if (!ctx?.budget || !Number.isFinite(ctx.budget.deadlineMonoMs) || ctx.budget.deadlineMonoMs <= now()) throw new BrowserFailure('deadline_exceeded');
}
function timings(start, end, ctx) {
  return { clockDomain: ctx?.budget?.clockDomain || clock.domain, startMonoMs: start, endMonoMs: end, totalMs: end - start, phases: {} };
}
function safeFailure(error, effect = 'none_proven') {
  const code = error instanceof BrowserFailure ? error.code : 'browser_operation_failed';
  const kind = /cancel/.test(code) ? 'cancelled' : /deadline|timeout/.test(code) ? 'deadline' : /verification_limit|verification_unavailable/.test(code) ? 'verification_unavailable' : /occluded/.test(code) ? 'occluded' : /mismatch/.test(code) ? 'assertion_failed' : /unsupported|unavailable/.test(code) ? 'backend_unavailable' : /grant|permission|scope|paused/.test(code) ? 'permission_denied' : /stale|context|gone|detached|identity/.test(code) ? 'stale_target' : /transport|cdp_/.test(code) ? 'transport_lost' : 'invalid_request';
  return { kind, code, phase: error.phase || 'browser', effect, evidenceIds: [] };
}
function privateDigest(key, value) { return createHmac('sha256', key).update(value).digest('hex'); }
function scalarText(text, cap = 4096) {
  if (typeof text !== 'string' || text.includes('\0') || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(text)) throw new BrowserFailure('invalid_unicode');
  if (Array.from(text).length > cap || Buffer.byteLength(text) > 65536) throw new BrowserFailure('text_limit');
  return text;
}
function plainArgs(args) {
  if (!Array.isArray(args) || args.length > 16 || Buffer.byteLength(JSON.stringify(args)) > 131072) throw new BrowserFailure('argument_limit');
  return args.map(value => ({ value }));
}
module.exports = { BrowserFailure, cdpFailure, check, timings, safeFailure, privateDigest, scalarText, plainArgs, id, clock };
