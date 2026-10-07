'use strict';

const { fields, id, enumeration, createPrivateHandle, ContractError } = require('./contracts.cjs');
function resourceKey(resource) {
  fields(resource, ['sessionId', 'generation', 'kind', 'id'], ['sessionId', 'generation', 'kind', 'id']);
  id(resource.sessionId); id(resource.id); enumeration(resource.kind, ['seat', 'tab', 'worker']);
  if (!Number.isSafeInteger(resource.generation) || resource.generation < 0) throw new ContractError('invalid_generation');
  return JSON.stringify([resource.sessionId, resource.generation, resource.kind, resource.id]);
}
class LeaseManager {
  constructor({ crossProcess } = {}) { this.crossProcess = crossProcess; this.resources = new Map(); this.handles = new WeakMap(); this.sequence = 0; }
  async acquire(resource, ctx) {
    const key = resourceKey(resource); ctx.progress.check('lease');
    let state = this.resources.get(key);
    if (!state) { state = { busy: false, queue: [], poison: null }; this.resources.set(key, state); }
    if (state.poison) throw Object.assign(new Error('lease_poisoned'), { kind: 'not_ready', code: 'lease_poisoned', phase: 'lease' });
    if (state.busy) {
      const waiter = {};
      try { await ctx.progress.phase('lease_queue', () => new Promise((resolve, reject) => { waiter.resolve = resolve; waiter.reject = reject; state.queue.push(waiter); })); }
      catch (error) { const i = state.queue.indexOf(waiter); if (i >= 0) state.queue.splice(i, 1); else if (waiter.granted) this._next(state); throw error; }
    } else state.busy = true;
    let external;
    try {
      ctx.progress.check('lease');
      if (state.poison) throw Object.assign(new Error('lease_poisoned'), { kind: 'not_ready', code: 'lease_poisoned', phase: 'lease' });
      if (this.crossProcess) external = await ctx.progress.phase('cross_process_lease', async () => {
        const handle = await this.crossProcess.acquire(resource, ctx);
        if (ctx.signal.aborted || ctx.progress.remainingMs() <= 0) { await this.crossProcess.release(handle); ctx.progress.check('lease'); }
        return handle;
      });
      const handle = createPrivateHandle('lease', `lease:${++this.sequence}`); this.handles.set(handle, { state, external, key }); return handle;
    } catch (error) { this._next(state); throw error; }
  }
  _next(state) {
    if (state.poison) { for (const w of state.queue.splice(0)) w.reject(Object.assign(new Error('lease_poisoned'), { kind: 'not_ready', code: 'lease_poisoned' })); state.busy = false; return; }
    const next = state.queue.shift(); if (next) { next.granted = true; next.resolve(); } else state.busy = false;
  }
  async release(handle) {
    const owned = this.handles.get(handle); if (!owned) throw new ContractError('unknown_lease'); this.handles.delete(handle);
    try { if (owned.external !== undefined) await this.crossProcess.release(owned.external); }
    catch (error) { owned.state.poison = 'lease_release_failed'; throw error; }
    finally { this._next(owned.state); }
  }
  poison(resource, reason) {
    const key = resourceKey(resource); let state = this.resources.get(key);
    if (!state) { state = { busy: false, queue: [], poison: null }; this.resources.set(key, state); }
    state.poison = String(reason).slice(0, 128); if (!state.busy) this._next(state);
  }
}
module.exports = { LeaseManager, resourceKey };
