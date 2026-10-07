'use strict';
const crypto = require('node:crypto');
const { StringDecoder } = require('node:string_decoder');
const { fail, SessionError } = require('./resources.cjs');

// Private transport for the compositor-local helper. Titles/app IDs stay in
// main memory. DesktopController supplies evidence and policy projections.
class ForeignToplevelClient {
  constructor({ session, executableId = 'foreignToplevel', clock, validateSession }) {
    this.session = session; this.executableId = executableId;
    this.clock = clock || { now: () => performance.now(), domain: 'node.performance' };
    this.validateSession = validateSession || (() => {});
    this.generation = session.generation; this.epoch = crypto.randomUUID();
    this.pending = new Map(); this.windows = new Map(); this.buffer = ''; this.closed = false;
    this.decoder = new StringDecoder('utf8');
  }
  check(ctx) {
    this.validateSession();
    if (this.closed || this.session.generation !== this.generation || !['ready', 'starting', 'paused'].includes(this.session.state)) fail('stale_session_generation', 'stale_target');
    if (ctx.sessionId !== this.session.id || ctx.revision?.sessionGeneration !== this.generation) fail('wrong_session', 'stale_target');
    if (ctx.signal?.aborted) fail('cancelled', 'cancelled');
    if (ctx.budget?.clockDomain !== this.clock.domain || !Number.isFinite(ctx.budget.deadlineMonoMs) || ctx.budget.deadlineMonoMs <= this.clock.now()) fail('deadline', 'deadline');
  }
  async start(ctx) {
    this.check(ctx);
    if (this.channel) fail('controller_already_started', 'invalid_request');
    this.channel = await this.session.runner.spawn(this.executableId, ['--serve'], ctx);
    this.unsubscribe = this.channel.subscribe(data => this.receive(data));
    // list provides a correlated final response even if ready was delivered
    // before the caller installed its subscription.
    return this.list(ctx);
  }
  receive(data) {
    this.buffer += this.decoder.write(Buffer.from(data));
    if (Buffer.byteLength(this.buffer) > 262144) { this.invalidate('protocol_overflow'); return; }
    let newline;
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline); this.buffer = this.buffer.slice(newline + 1);
      let message; try { message = JSON.parse(line); } catch { this.invalidate('protocol_invalid'); return; }
      const pending = this.pending.get(message.id);
      if (!pending) continue;
      if (!['result', 'error'].includes(message.event) || !Array.isArray(message.windows)) { this.invalidate('protocol_invalid'); return; }
      this.windows.clear();
      for (const row of message.windows) {
        if (!/^w\d+$/.test(row.targetId) || typeof row.active !== 'boolean' || typeof row.title !== 'string' || typeof row.appId !== 'string') { this.invalidate('protocol_invalid'); return; }
        this.windows.set(`${this.epoch}:${row.targetId}`, row);
      }
      if (message.event === 'error') pending.reject(new SessionError(['target_gone', 'seat_unavailable', 'operation_unsupported'].includes(message.code) ? message.code : 'protocol_error'));
      else pending.resolve([...this.windows].map(([id, row]) => ({ target: { sessionId: this.session.id, kind: 'window',
        targetId: id, generation: this.generation, ownership: 'owned', compositorInstance: this.session.display.instanceId },
        active: row.active, title: row.title, appId: row.appId, geometry: 'surface_local_unknown' })));
    }
  }
  invalidate(code) {
    this.closed = true; for (const p of this.pending.values()) p.reject(new SessionError(code, 'transport_lost'));
    this.pending.clear(); this.windows.clear();
  }
  async request(op, rawTarget, ctx) {
    this.check(ctx); if (!this.channel) fail('controller_not_started', 'not_ready');
    const id = crypto.randomUUID();
    let timer, abort;
    const response = new Promise((resolve, reject) => {
      const finish = callback => value => { clearTimeout(timer); ctx.signal?.removeEventListener('abort', abort); this.pending.delete(id); callback(value); };
      this.pending.set(id, { resolve: finish(resolve), reject: finish(reject) });
      timer = setTimeout(() => this.pending.get(id)?.reject(new SessionError('reply_lost', 'transport_lost')), Math.max(1, ctx.budget.deadlineMonoMs - this.clock.now()));
      abort = () => this.pending.get(id)?.reject(new SessionError('cancelled', 'cancelled'));
      ctx.signal?.addEventListener('abort', abort, { once: true });
    });
    try { await this.channel.write(Buffer.from(JSON.stringify({ id, op, ...(rawTarget ? { targetId: rawTarget } : {}) }) + '\n'), ctx); }
    catch { this.pending.get(id)?.reject(new SessionError('channel_lost', 'transport_lost')); }
    const result = await response; this.check(ctx); return result;
  }
  list(ctx) { return this.request('list', null, ctx); }
  async mutate(op, target, ctx) {
    this.check(ctx);
    if (this.session.state === 'paused') fail('session_paused', 'permission_denied');
    if (target.sessionId !== this.session.id || target.generation !== this.generation || target.compositorInstance !== this.session.display.instanceId || !this.windows.has(target.targetId)) fail('stale_window', 'stale_target');
    if (!ctx.dispatch?.beforeEffect || !ctx.dispatch?.afterEffect) fail('dispatch_recorder_required', 'storage_unavailable');
    const raw = this.windows.get(target.targetId).targetId;
    const handle = await ctx.dispatch.beforeEffect({ primitive: 'foreign_toplevel', substep: op, target });
    try { this.check(ctx); }
    catch (error) {
      await ctx.dispatch.afterEffect(handle, { state: 'rejected', noEffectProven: true });
      return { dispatch: 'not_started', effect: 'none_proven', failure: { ...error.failure, phase: op } };
    }
    let acknowledged = false;
    try {
      const rows = await this.request(op, raw, ctx);
      acknowledged = true;
      await ctx.dispatch.afterEffect(handle, { state: 'accepted', noEffectProven: false });
      // A roundtrip is only an acknowledgement. Use the live activation state
      // or disappearance as the postcondition, with bounded read-only polls.
      while (true) {
        const current = rows.find(row => row.target.targetId === target.targetId);
        if (op === 'activate' && current?.active || op === 'close' && !current) return { dispatch: 'acknowledged', effect: 'verified', windows: rows };
        const fresh = await this.list(ctx); rows.splice(0, rows.length, ...fresh);
        await new Promise(resolve => setTimeout(resolve, Math.min(20, Math.max(1, ctx.budget.deadlineMonoMs - this.clock.now()))));
      }
    } catch (error) {
      if (!acknowledged) await ctx.dispatch.afterEffect(handle, { state: 'lost', noEffectProven: false });
      return { dispatch: acknowledged ? 'acknowledged' : 'possible', effect: 'unknown', failure: { kind: error.failure?.kind || 'transport_lost',
        code: error.code || 'reply_lost', phase: op, effect: 'unknown', evidenceIds: [] } };
    }
  }
  activate(target, ctx) { return this.mutate('activate', target, ctx); }
  close(target, ctx) { return this.mutate('close', target, ctx); }
  async stop(budget) {
    this.unsubscribe?.(); this.invalidate('controller_stopped');
    return this.channel ? this.channel.stop(budget) : { state: 'confirmed', ownedInputReleased: true, reasonCodes: [] };
  }
}
module.exports = { ForeignToplevelClient };
