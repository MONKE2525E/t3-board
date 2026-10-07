'use strict';
const { randomUUID } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { check, DesktopError, fail } = require('./common.cjs');
const MAX_FRAME = 256 * 1024;
/** Private big-endian uint32 length + JSON pipes. No shell, bus lookup or ambient spawn. */
class WorkerChannel {
  constructor({ executableId = 'accessibility-worker', maxQueued = 32, clock = { now: () => performance.now(), domain: 'node.performance' } } = {}) {
    if (!Number.isInteger(maxQueued) || maxQueued < 1 || maxQueued > 32) fail('invalid_worker_queue');
    this.clock = clock;
    this.executableId = executableId; this.maxQueued = maxQueued; this.pending = new Map(); this.buffer = Buffer.alloc(0);
    this.serial = Promise.resolve(); this.queued = 0; this.listeners = new Set(); this.closed = true;
  }
  async start(session, ctx) {
    if (!this.closed || this.starting || this.queued) fail('worker_already_started');
    check(ctx, 'atspi.start');
    if (ctx.budget.clockDomain !== this.clock.domain) fail('invalid_clock_domain');
    if (!session.buses?.accessibilityAddress || !session.buses?.sessionAddress || !session.runner?.spawn) fail('accessibility_bus_unavailable');
    this.starting = true;
    try {
    if (this.termination) await this.termination;
    this.termination = undefined; this.process = undefined;
    this.session = session; this.generation = (this.generation || 0) + 1;
    const generation = this.generation;
    this.process = await (session.runner.spawnService || session.runner.spawn).call(session.runner, this.executableId, [], { budget: ctx.budget, signal: ctx.signal });
    // OwnedProcessChannel must expose Node-compatible private streams and owned termination.
    const p = this.process;
    if (!(p.write && p.subscribe && p.stop) && !(p.stdin?.write && p.stdout?.on && p.terminate)) fail('worker_channel_unavailable');
    this.closed = false; this.buffer = Buffer.alloc(0);
    const consume = data => { if (this.generation === generation) this.consume(data); };
    if (p.subscribe) this.unsubscribe = p.subscribe(consume);
    else { p.stdout.on('data', consume); this.unsubscribe = () => p.stdout.removeListener('data', consume); }
    p.on?.('exit', () => { if (this.generation === generation) void this.breakAndTerminate('worker_exited'); });
    p.on?.('error', () => { if (this.generation === generation) void this.breakAndTerminate('worker_transport_lost'); });
    const result = await this.request('hello', {}, ctx);
    if (result?.ready !== true) fail('worker_not_ready');
    return result;
    } catch (error) { await this.breakAndTerminate(error.code || 'worker_start_failed'); throw error; }
    finally { this.starting = false; }
  }
  subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  consume(data) {
    if (this.closed) return;
    this.buffer = Buffer.concat([this.buffer, data]);
    while (this.buffer.length >= 4) {
      const size = this.buffer.readUInt32BE(0);
      if (size < 2 || size > MAX_FRAME) { void this.breakAndTerminate('worker_frame_invalid'); return; }
      if (this.buffer.length < size + 4) return;
      let message;
      try { message = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(this.buffer.subarray(4, size + 4))); }
      catch { void this.breakAndTerminate('worker_json_invalid'); return; }
      this.buffer = this.buffer.subarray(size + 4);
      if (!message || message.schema !== 'muse.atspi.v1' || message.generation !== this.generation || message.sessionId !== this.session.id) {
        void this.breakAndTerminate('worker_scope_invalid'); return;
      }
      if (message.event === 'invalidation') { this.notify(message); continue; }
      if (typeof message.ok !== 'boolean' || (message.ok && (!message.result || typeof message.result !== 'object' || Array.isArray(message.result)))) {
        void this.breakAndTerminate('worker_response_invalid'); return;
      }
      const pending = this.pending.get(message.requestId);
      if (!pending) { void this.breakAndTerminate('worker_response_unknown'); return; }
      this.pending.delete(message.requestId); pending.finish();
      if (message.ok === false) pending.reject(new DesktopError(message.code || 'worker_failed', { attempted: !!message.attempted, effect: message.effect || 'none_proven' }));
      else pending.resolve(message.result);
    }
    if (this.buffer.length > MAX_FRAME + 4) void this.breakAndTerminate('worker_frame_invalid');
  }
  request(operation, params, ctx) {
    if (this.queued >= this.maxQueued) return Promise.reject(new DesktopError('worker_queue_full'));
    this.queued++;
    const generation = this.generation;
    const work = this.serial.then(() => {
      if (generation !== this.generation) fail('worker_generation_changed');
      return this.exchange(operation, params, ctx);
    });
    this.serial = work.catch(() => {});
    return work.finally(() => { this.queued--; });
  }
  async exchange(operation, params, ctx) {
    check(ctx, 'atspi.request');
    if (this.closed) fail('worker_unavailable');
    const requestId = randomUUID();
    const bytes = Buffer.from(JSON.stringify({ schema: 'muse.atspi.v1', requestId, actionId: ctx.actionId || ctx.invokeId,
      sessionId: this.session.id, generation: this.generation, remainingMs: Math.floor(ctx.progress.remainingMs()), operation, params }));
    if (bytes.length > MAX_FRAME - 4) fail('worker_request_limit');
    const header = Buffer.alloc(4); header.writeUInt32BE(bytes.length);
    return new Promise((resolve, reject) => {
      const abort = () => { void this.breakAndTerminate('cancelled'); };
      const timer = setTimeout(() => { void this.breakAndTerminate('deadline'); }, Math.max(1, ctx.progress.remainingMs()));
      const finish = () => { clearTimeout(timer); ctx.signal.removeEventListener('abort', abort); };
      this.pending.set(requestId, { resolve, reject, finish });
      ctx.signal.addEventListener('abort', abort, { once: true });
      if (ctx.signal.aborted) { abort(); return; }
      const frame = Buffer.concat([header, bytes]);
      try {
        if (this.process.write) Promise.resolve(this.process.write(frame, ctx)).catch(() => { void this.breakAndTerminate('worker_transport_lost'); });
        else this.process.stdin.write(frame, error => { if (error) void this.breakAndTerminate('worker_transport_lost'); });
      } catch { void this.breakAndTerminate('worker_transport_lost'); }
    });
  }
  notify(event) { for (const listener of this.listeners) { try { listener(event); } catch { /* policy listeners cannot break transport cleanup */ } } }
  broken(code) {
    if (this.closed) return;
    this.closed = true;
    for (const item of this.pending.values()) { item.finish(); item.reject(new DesktopError(code)); }
    this.pending.clear();
    this.buffer = Buffer.alloc(0);
    this.notify({ event: 'invalidation', reason: code, generation: this.generation });
  }
  breakAndTerminate(code) {
    if (this.termination) return this.termination;
    this.broken(code);
    this.unsubscribe?.(); this.unsubscribe = undefined;
    const p = this.process;
    this.termination = Promise.resolve().then(async () => {
      try {
        if (p?.stop) return await p.stop({ deadlineMonoMs: this.clock.now() + 1000, clockDomain: this.clock.domain });
        if (p?.terminate) { await p.terminate({ reason: code, cleanupBudgetMs: 1000 }); return { state: 'confirmed', ownedInputReleased: true, reasonCodes: [] }; }
        if (!p) return { state: 'confirmed', ownedInputReleased: true, reasonCodes: [] };
      } catch { /* report unconfirmed owned cleanup */ }
      return { state: 'unknown', ownedInputReleased: false, reasonCodes: ['worker_termination_unconfirmed'] };
    });
    return this.termination;
  }
  async stop() {
    const quiescence = await this.breakAndTerminate('worker_stopped');
    return { stopped: quiescence.state === 'confirmed', generation: this.generation, quiescence };
  }
}
module.exports = { WorkerChannel, MAX_FRAME };
