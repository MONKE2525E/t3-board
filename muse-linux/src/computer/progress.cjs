'use strict';

const { performance } = require('node:perf_hooks');
const { id, fields, enumeration } = require('./contracts.cjs');
const defaultClock = Object.freeze({ now: () => performance.now(), domain: 'node.performance', setTimeout, clearTimeout });
class ProgressError extends Error {
  constructor(kind, phase) { super(kind); this.name = 'ProgressError'; this.kind = kind; this.code = kind === 'deadline' ? 'deadline_exceeded' : 'cancelled'; this.phase = phase; }
}
class Progress {
  constructor({ budget, signal = new AbortController().signal, clock = defaultClock, onLate = () => {}, phases } = {}) {
    if (!budget || !Number.isFinite(budget.deadlineMonoMs) || budget.clockDomain !== clock.domain) throw new ProgressError('invalid_request', 'clock_domain');
    id(clock.domain); this.budget = Object.freeze({ ...budget }); this.controller = new AbortController();
    this.signal = AbortSignal.any([signal, this.controller.signal]); this.clock = clock; this.onLate = onLate;
    this.start = clock.now(); this.phases = phases || {}; this.timer = clock.setTimeout || setTimeout; this.clearTimer = clock.clearTimeout || clearTimeout;
  }
  remainingMs() { return Math.max(0, this.budget.deadlineMonoMs - this.clock.now()); }
  check(phase = 'check') {
    if (this.signal.aborted) throw new ProgressError(this.signal.reason === 'deadline' ? 'deadline' : 'cancelled', phase);
    if (this.remainingMs() <= 0) { this.controller.abort('deadline'); throw new ProgressError('deadline', phase); }
  }
  child(maxMs) {
    if (!Number.isFinite(maxMs) || maxMs <= 0) throw new ProgressError('invalid_request', 'child_budget');
    return new Progress({ budget: { ...this.budget, deadlineMonoMs: Math.min(this.budget.deadlineMonoMs, this.clock.now() + maxMs) }, signal: this.signal, clock: this.clock, onLate: this.onLate, phases: this.phases });
  }
  async phase(name, work) {
    this.check(name); const start = this.clock.now(); let settled = false, timer, abort;
    try {
      return await new Promise((resolve, reject) => {
        const finish = (fn, value) => { if (settled) return; settled = true; fn(value); };
        abort = () => finish(reject, new ProgressError(this.signal.reason === 'deadline' ? 'deadline' : 'cancelled', name));
        this.signal.addEventListener('abort', abort, { once: true });
        timer = this.timer(() => { finish(reject, new ProgressError('deadline', name)); this.controller.abort('deadline'); }, Math.min(this.remainingMs(), 2147483647));
        Promise.resolve().then(() => { this.check(name); return work(this); }).then(value => {
          if (settled) { Promise.resolve().then(() => this.onLate({ phase: name, state: 'fulfilled', value })).catch(() => {}); return; }
          try { this.check(name); finish(resolve, value); } catch (error) { finish(reject, error); }
        }, error => {
          if (settled) { Promise.resolve().then(() => this.onLate({ phase: name, state: 'rejected', error })).catch(() => {}); return; }
          finish(reject, error);
        });
      });
    } finally {
      this.clearTimer(timer); if (abort) this.signal.removeEventListener('abort', abort);
      this.phases[name] = (this.phases[name] || 0) + Math.max(0, this.clock.now() - start);
    }
  }
  async delay(ms) {
    let timer;
    try { await this.phase('wait', () => new Promise(resolve => { timer = this.timer(resolve, Math.max(0, ms)); })); }
    finally { this.clearTimer(timer); }
  }
  async quiesce(work, cleanupBudgetMs = 1000) {
    const cleanup = new Progress({ budget: { clockDomain: this.clock.domain, deadlineMonoMs: this.clock.now() + Math.min(1000, Math.max(1, cleanupBudgetMs)) }, clock: this.clock });
    try {
      const result = await cleanup.phase('quiesce', () => work(cleanup));
      fields(result, ['state', 'ownedInputReleased', 'reasonCodes'], ['state', 'ownedInputReleased', 'reasonCodes']);
      enumeration(result.state, ['confirmed', 'unknown']);
      if (typeof result.ownedInputReleased !== 'boolean' || !Array.isArray(result.reasonCodes) || result.reasonCodes.length > 64) throw new Error('invalid_quiescence');
      result.reasonCodes.forEach(id); return result;
    } catch { return { state: 'unknown', ownedInputReleased: false, reasonCodes: ['quiescence_unconfirmed'] }; }
  }
  timings() { const end = this.clock.now(); return { clockDomain: this.clock.domain, startMonoMs: this.start, endMonoMs: end, totalMs: Math.max(0, end - this.start), phases: { ...this.phases } }; }
}
module.exports = { Progress, ProgressError, defaultClock };
