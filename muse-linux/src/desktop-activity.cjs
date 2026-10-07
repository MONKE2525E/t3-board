'use strict';

const { spawn } = require('node:child_process');

const STDOUT_LIMIT = 65536;
const REQUEST_TIMEOUT_MS = 8000;
const KILL_MS = 500;
const KINDS = new Set(['pointer', 'keyboard']);

function envDisabled(env) {
  return String(env?.MUSE_ACTIVITY_DISABLED || '') === '1';
}

class DesktopActivity {
  constructor({
    helper,
    env = process.env,
    spawnImpl = spawn,
    onInput = () => {},
    onFailure = () => {},
    timeoutMs = REQUEST_TIMEOUT_MS,
  } = {}) {
    if (typeof helper !== 'string' || !helper) throw Error('activity_helper_unavailable');
    this.helper = helper;
    this.env = env;
    this.spawnImpl = spawnImpl;
    this.onInput = onInput;
    this.onFailure = onFailure;
    this.timeoutMs = timeoutMs;
    this.generation = 0;
    this.pending = new Map();
    this.available = false;
    this.devices = 0;
    this.running = false;
    this.child = null;
  }

  wait(id) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(Error('activity_helper_timeout'));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
  }

  settle(id, value, error) {
    const pending = this.pending.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(id);
    if (error) pending.reject(error); else pending.resolve(value);
  }

  rejectAll(error) {
    for (const id of [...this.pending.keys()]) this.settle(id, null, error);
  }

  lost(child) {
    if (this.child !== child) return;
    const running = this.running;
    this.stop();
    if (running) this.onFailure(Error('activity_helper_lost'));
  }

  handleEvent(event, child) {
    if (!event || typeof event !== 'object' || Array.isArray(event)) {
      this.lost(child);
      return;
    }
    if (event.event === 'ready') {
      if (this.running) {
        this.available = event.available === true;
        this.devices = Number.isInteger(event.devices) && event.devices >= 0 ? event.devices : 0;
        if (!this.available) this.onFailure(Error('activity_devices_unavailable'));
        return;
      }
      this.settle('ready', event);
      return;
    }
    if (event.event === 'error') {
      this.lost(child);
      return;
    }
    if (event.event !== 'input') {
      this.lost(child);
      return;
    }
    if (!this.running || this.child !== child) return;
    if (!KINDS.has(event.kind)) {
      this.lost(child);
      return;
    }
    try { this.onInput({ kind: event.kind }); }
    catch { /* takeover must not throw into the helper stream */ }
  }

  async start() {
    this.stop();
    if (envDisabled(this.env)) {
      this.available = false;
      this.devices = 0;
      return { available: false, devices: 0 };
    }
    const generation = this.generation;
    const ready = this.wait('ready');
    void ready.catch(() => {});
    let child;
    try { child = this.spawnImpl(this.helper, [], { stdio: ['pipe', 'pipe', 'pipe'], env: this.env }); }
    catch { this.settle('ready', null, Error('activity_helper_unavailable')); }
    if (!child) return ready;
    this.child = child;
    let buffer = '';
    const fail = () => this.lost(child);
    child.on('error', fail);
    child.on('exit', fail);
    child.stdin.on('error', fail);
    child.stderr.on('data', () => {});
    child.stdout.on('data', bytes => {
      if (this.child !== child) return;
      buffer += bytes.toString('utf8');
      if (buffer.length > STDOUT_LIMIT) { fail(); return; }
      let end;
      while ((end = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        let event;
        try { event = JSON.parse(line); } catch { fail(); return; }
        this.handleEvent(event, child);
      }
    });
    try {
      const event = await ready;
      if (generation !== this.generation || this.child !== child) throw Error('stopped_by_user');
      this.available = event.available === true;
      this.devices = Number.isInteger(event.devices) && event.devices >= 0 ? event.devices : 0;
      this.running = true;
      return { available: this.available, devices: this.devices };
    } catch (error) {
      if (this.child === child) this.stop();
      throw error;
    }
  }

  stop() {
    this.generation++;
    this.available = false;
    this.devices = 0;
    this.running = false;
    this.rejectAll(Error('stopped_by_user'));
    const child = this.child;
    this.child = null;
    if (!child) return;
    try { child.stdin.end(JSON.stringify({ quit: true }) + '\n'); } catch { /* pipe already closed */ }
    try { child.kill('SIGTERM'); } catch { /* owned helper already gone */ }
    const timer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        try { child.kill('SIGKILL'); } catch { /* owned helper already gone */ }
      }
    }, KILL_MS);
    timer.unref?.();
    child.once('exit', () => clearTimeout(timer));
  }
}

module.exports = { DesktopActivity };
