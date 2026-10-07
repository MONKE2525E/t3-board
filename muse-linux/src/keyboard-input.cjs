'use strict';

const { spawn } = require('node:child_process');
const { normalizeKey } = require('./key-names.cjs');

const CHUNK_SIZE = 64;
const MAX_CHARS = 4096;
const STDOUT_LIMIT = 65536;
const REQUEST_TIMEOUT_MS = 8000;
const KILL_MS = 500;

/**
 * One-shot muse-keyboard wrapper. Injects into the compositor-focused client
 * via zwp_virtual_keyboard_v1. It cannot target a window by id.
 *
 * Root must revalidate the freshly observed visible selected window, activate
 * it, and verify focused address+pid immediately before type/key. Pass
 * validateFocus that returns true only for that same address+pid. The wrapper
 * rechecks after helper ready and before every 64-character chunk, then stops
 * the owned helper on mismatch. Abort kills that child only. No clipboard.
 *
 * new KeyboardInput({ helper, spawnImpl, env, timeoutMs, validateFocus, chunkSize })
 * keyboard.validateFocus = async () => addressAndPidMatch
 * async type(text, signal | { signal, validateFocus })
 * async key(input, signal | { signal, validateFocus })
 * Super/Meta/Win, Ctrl, Shift, and Alt alone send the left evdev modifier
 * code (KEY_LEFTMETA 125) with extra mods []. The helper holds that
 * modifier mask through press and release. Abort/Stop kill the owned helper.
 * Per-request validateFocus wins for that call. Root must serialize type/key.
 * Overlap throws keyboard_busy. stop() kills the owned helper only.
 * Non-BMP (U+10000 and above) throws native_text_unsupported before spawn.
 */
const NATIVE_TEXT_UNSUPPORTED = 'native_text_unsupported: use Muse Local Browser type or an accessibility element type';

function codepoints(text) {
  if (typeof text !== 'string' || text.includes('\0')) throw Error('invalid_text');
  for (const ch of text) {
    if (ch.codePointAt(0) > 0xFFFF) throw Error(NATIVE_TEXT_UNSUPPORTED);
  }
  const chars = [];
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp >= 0xd800 && cp <= 0xdfff) throw Error('invalid_text');
    if (cp < 32 && cp !== 9 && cp !== 10 && cp !== 13) throw Error('invalid_text');
    if (cp === 0x7f) throw Error('invalid_text');
    chars.push(ch);
  }
  if (!chars.length) throw Error('invalid_text');
  if (chars.length > MAX_CHARS) throw Error('text_too_large');
  return chars;
}

function requireBmpText(text) {
  codepoints(text);
}

function chunksOf(chars, size) {
  const out = [];
  for (let i = 0; i < chars.length; i += size) out.push(chars.slice(i, i + size).join(''));
  return out;
}

function callOptions(signalOrOpts) {
  if (signalOrOpts == null) return {};
  if (typeof signalOrOpts.aborted === 'boolean' && typeof signalOrOpts.addEventListener === 'function' && signalOrOpts.signal == null) {
    return { signal: signalOrOpts };
  }
  return {
    signal: signalOrOpts.signal,
    validateFocus: signalOrOpts.validateFocus,
  };
}

class KeyboardInput {
  constructor({
    helper,
    spawnImpl = spawn,
    env = process.env,
    timeoutMs = REQUEST_TIMEOUT_MS,
    validateFocus,
    chunkSize = CHUNK_SIZE,
  } = {}) {
    if (typeof helper !== 'string' || !helper) throw Error('keyboard_helper_unavailable');
    this.helper = helper;
    this.spawnImpl = spawnImpl;
    this.env = env;
    this.timeoutMs = timeoutMs;
    this.validateFocus = typeof validateFocus === 'function' ? validateFocus : null;
    this.inflight = false;
    const size = Number(chunkSize);
    this.chunkSize = Number.isInteger(size) && size >= 1 && size <= 256 ? size : CHUNK_SIZE;
    this.generation = 0;
    this.nextId = 0;
    this.pending = new Map();
    this.available = false;
    this.child = null;
  }

  get pid() {
    const pid = this.child?.pid;
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  }

  send(message) {
    if (!this.child?.stdin?.writable) throw Error('keyboard_unavailable');
    this.child.stdin.write(JSON.stringify(message) + '\n');
  }

  wait(id) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(Error('keyboard_timeout'));
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
    this.stop();
  }

  setValidateFocus(fn) {
    this.validateFocus = typeof fn === 'function' ? fn : null;
  }

  async ensureFocus(validateFocus, signal) {
    if (signal?.aborted) { this.stop(); throw Error('stopped_by_user'); }
    const check = typeof validateFocus === 'function' ? validateFocus : this.validateFocus;
    if (typeof check !== 'function') return;
    let ok;
    let onAbort;
    const aborted = new Promise((_, reject) => { onAbort = () => reject(Error('stopped_by_user')); signal?.addEventListener('abort', onAbort, { once: true }); });
    try {
      ok = await Promise.race([Promise.resolve().then(check), aborted]);
      if (signal?.aborted) throw Error('stopped_by_user');
    }
    catch (error) {
      this.stop();
      if (signal?.aborted) throw Error('stopped_by_user');
      if (error && (['stopped_by_user', 'session_required_or_stopped'].includes(error.message) || error.name === 'AbortError')) throw error;
      throw Error('focus_lost');
    }
    finally { signal?.removeEventListener('abort', onAbort); }
    if (ok === false) {
      this.stop();
      throw Error('focus_lost');
    }
  }

  async start(signal) {
    if (signal?.aborted) throw Error('stopped_by_user');
    this.stop();
    const generation = this.generation;
    const ready = this.wait('ready');
    void ready.catch(() => {});
    let child;
    try { child = this.spawnImpl(this.helper, [], { stdio: ['pipe', 'pipe', 'pipe'], env: this.env }); }
    catch { this.settle('ready', null, Error('keyboard_helper_unavailable')); }
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
        if (event.event === 'ready') this.settle('ready', event);
        else if (event.event === 'result') this.settle(event.id, event);
        else if (event.event === 'error') {
          const error = Error(event.error || 'keyboard_helper_error');
          if (event.id) this.settle(event.id, null, error);
          else { this.settle('ready', null, error); fail(); }
        }
      }
    });
    const onAbort = () => this.stop();
    if (signal) {
      if (signal.aborted) {
        this.stop();
        throw Error('stopped_by_user');
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }
    try {
      const event = await ready;
      if (generation !== this.generation || this.child !== child) throw Error('stopped_by_user');
      if (event?.event === 'error') throw Error(event.error || 'keyboard_helper_unavailable');
      this.available = true;
    } catch (error) {
      if (this.child === child) this.stop();
      throw error;
    } finally {
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  }

  async request(body, signal) {
    if (!this.available || !this.child) throw Error('keyboard_unavailable');
    const generation = this.generation;
    const id = String(++this.nextId);
    const result = this.wait(id);
    void result.catch(() => {});
    const onAbort = () => this.stop();
    if (signal) {
      if (signal.aborted) {
        this.stop();
        throw Error('stopped_by_user');
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }
    try {
      try { this.send({ id, ...body }); }
      catch (error) { this.lost(this.child); throw error; }
      const event = await result;
      if (generation !== this.generation || this.child == null) throw Error('stopped_by_user');
      if (event.dispatched !== true) throw Error(event.error || 'keyboard_helper_error');
      return event;
    } finally {
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  }

  async type(text, signalOrOpts) {
    const chars = codepoints(text);
    const { signal, validateFocus } = callOptions(signalOrOpts);
    if (signal?.aborted) throw Error('stopped_by_user');
    if (this.inflight) throw Error('keyboard_busy');
    this.inflight = true;
    const onAbort = () => this.stop();
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      await this.start(signal);
      const generation = this.generation;
      await this.ensureFocus(validateFocus, signal);
      if (generation !== this.generation) throw Error('stopped_by_user');
      for (const chunk of chunksOf(chars, this.chunkSize)) {
        await this.ensureFocus(validateFocus, signal);
        if (generation !== this.generation) throw Error('stopped_by_user');
        await this.request({ action: 'type', text: chunk }, signal);
      }
      return { dispatched: true, characters: chars.length };
    } finally {
      signal?.removeEventListener('abort', onAbort);
      this.inflight = false;
      this.stop();
    }
  }

  async key(input, signalOrOpts) {
    const normalized = normalizeKey(input);
    const { signal, validateFocus } = callOptions(signalOrOpts);
    if (signal?.aborted) throw Error('stopped_by_user');
    if (this.inflight) throw Error('keyboard_busy');
    this.inflight = true;
    const onAbort = () => this.stop();
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      await this.start(signal);
      const generation = this.generation;
      await this.ensureFocus(validateFocus, signal);
      if (generation !== this.generation) throw Error('stopped_by_user');
      await this.request({ action: 'key', key: normalized.key, code: normalized.linux.code, mods: normalized.mods }, signal);
      return { dispatched: true, key: normalized.key, mods: normalized.mods };
    } finally {
      signal?.removeEventListener('abort', onAbort);
      this.inflight = false;
      this.stop();
    }
  }

  stop() {
    this.generation++;
    this.available = false;
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

module.exports = { KeyboardInput, CHUNK_SIZE, MAX_CHARS, requireBmpText, NATIVE_TEXT_UNSUPPORTED };
