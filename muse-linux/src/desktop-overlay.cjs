const { spawn } = require('node:child_process');
const net = require('node:net');
const path = require('node:path');

function cursorPosition(env) {
  if (!env.XDG_RUNTIME_DIR || !env.HYPRLAND_INSTANCE_SIGNATURE || /[/\\\0]/.test(env.HYPRLAND_INSTANCE_SIGNATURE)) return Promise.resolve(null);
  return new Promise(resolve => {
    const socket = net.createConnection(path.join(env.XDG_RUNTIME_DIR, 'hypr', env.HYPRLAND_INSTANCE_SIGNATURE, '.socket.sock'));
    let data = '', done = false;
    const finish = result => { if (done) return; done = true; socket.destroy(); resolve(result); };
    socket.setTimeout(500, () => finish(null));
    socket.on('error', () => finish(null));
    socket.on('connect', () => socket.write('j/cursorpos'));
    socket.on('data', bytes => { data += bytes.toString('utf8'); if (data.length > 4096) finish(null); });
    socket.on('end', () => {
      try { const result = JSON.parse(data); finish(Number.isFinite(result.x) && Number.isFinite(result.y) ? result : null); }
      catch { finish(null); }
    });
  });
}

const ACTIONS = new Set(['Ready', 'Observing', 'Moving pointer', 'Clicking', 'Double clicking', 'Dragging', 'Scrolling', 'Typing', 'Pressing a key', 'Focusing', 'Opening app', 'Moving window', 'Switching workspace']);

class DesktopOverlay {
  constructor({ helper, logo, onStop = () => {}, onPause = () => {}, onResume = () => {}, onFailure = () => {}, spawnImpl = spawn, env = process.env, timeoutMs = 5000, readCursor = () => cursorPosition(env) } = {}) {
    this.helper = helper;
    this.onStop = onStop;
    this.onPause = onPause;
    this.onResume = onResume;
    this.logo = logo;
    this.onFailure = onFailure;
    this.spawnImpl = spawnImpl;
    this.env = env;
    this.timeoutMs = timeoutMs;
    this.readCursor = readCursor;
    this.generation = 0;
    this.nextId = 0;
    this.pending = new Map();
    this.active = false;
    this.outputs = 0;
    this.child = null;
  }

  send(message) {
    if (!this.child?.stdin?.writable) throw Error('desktop_indicator_unavailable');
    this.child.stdin.write(JSON.stringify(message) + '\n');
  }

  get pid() {
    return this.child?.pid || null;
  }

  get namespaces() {
    return this.active && this.child && this.sessionKey ? { glow: `muse-control-overlay-${this.sessionKey}`, stop: `muse-control-stop-${this.sessionKey}` } : null;
  }

  wait(id, timeoutMs = this.timeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(Error('desktop_indicator_timeout'));
      }, timeoutMs);
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

  async start() {
    this.stop();
    this.sessionKey = require('node:crypto').randomBytes(16).toString('hex');
    const generation = this.generation;
    const ready = this.wait('ready');
    let child;
    try { child = this.spawnImpl(this.helper, ['--session-key', this.sessionKey, ...(this.logo ? ['--logo', this.logo] : [])], { stdio: ['pipe', 'pipe', 'pipe'], env: this.env }); }
    catch { this.settle('ready', null, Error('desktop_indicator_unavailable')); }
    if (!child) return ready;
    this.child = child;
    let buffer = '';
    const fail = () => {
      if (this.child !== child) return;
      const wasActive = this.active;
      for (const key of this.pending.keys()) this.settle(key, null, Error('desktop_indicator_lost'));
      this.stop();
      if (wasActive) this.onFailure(Error('desktop_indicator_lost'));
    };
    child.on('error', fail);
    child.on('exit', fail);
    child.stdin.on('error', fail);
    child.stderr.on('data', () => {});
    child.stdout.on('data', bytes => {
      if (this.child !== child) return;
      buffer += bytes.toString('utf8');
      if (buffer.length > 65536) { fail(); return; }
      let end;
      while ((end = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        let event;
        try { event = JSON.parse(line); } catch { fail(); return; }
        if (event.event === 'ready') this.settle('ready', event);
        else if (event.event === 'active') this.settle(event.id, event);
        else if (event.event === 'capture') {
          if(event.expired === true) { this.captureIsHidden = false; this.captureExpired = true; }
          this.settle(event.id, event);
        }
        else if (event.event === 'pause') this.onPause();
        else if (event.event === 'resume') this.onResume();
        else if (event.event === 'stop') { this.stop(); this.onStop(); return; }
        else if (event.event === 'error') { fail(); return; }
      }
    });
    try {
      await ready;
      if (generation !== this.generation || this.child !== child) throw Error('stopped_by_user');
      const id = ++this.nextId;
      const mapped = this.wait(id);
      void mapped.catch(() => {});
      this.send({ id, active: true, action: 'Ready' });
      const result = await mapped;
      if (generation !== this.generation || this.child !== child) throw Error('stopped_by_user');
      if (result.active !== true || !Number.isInteger(result.outputs) || result.outputs < 1) throw Error('desktop_indicator_unavailable');
      this.active = true;
      this.outputs = result.outputs;
      this.heartbeat = setInterval(() => {
        try { this.send({ ping: true }); } catch { fail(); }
      }, 2000);
      this.heartbeat.unref?.();
      let polling = false;
      const follow = async () => {
        if (polling || !this.active) return;
        polling = true;
        try {
          const point = await this.readCursor();
          if (generation === this.generation && this.active && point) this.pointer(point);
        } catch { /* pointer transport still supplies movement acknowledgements */ }
        finally { polling = false; }
      };
      void follow();
      this.cursorTimer = setInterval(follow, 50);
      this.cursorTimer.unref?.();
      return { outputs: this.outputs };
    } catch (error) {
      if (this.child === child) this.stop();
      throw error;
    }
  }

  action(label) {
    if (!this.active) return;
    try { this.send({ action: ACTIONS.has(label) ? label : 'Working' }); }
    catch { this.stop(); this.onFailure(Error('desktop_indicator_lost')); }
  }

  paused(value, reason = 'user_pause') {
    this.isPaused = value === true;
    if (!this.active) return;
    try {
      this.send({ paused: this.isPaused, reason: ['human_input', 'user_pause', 'input_unavailable'].includes(reason) ? reason : 'user_pause' });
      if (this.isPaused) this.pointer({ x: 0, y: 0, visible: false });
    } catch { this.stop(); this.onFailure(Error('desktop_indicator_lost')); }
  }

  async captureHidden(hidden) {
    if (!this.active) throw Error('desktop_indicator_unavailable');
    const generation = this.generation;
    const id = ++this.nextId;
    if (hidden) this.captureExpired = false;
    const acknowledged = this.wait(id, 1000);
    void acknowledged.catch(() => {});
    try { this.send({ id, capture_hidden: hidden === true }); }
    catch(error) { this.settle(id, null, error); throw error; }
    const result = await acknowledged;
    if (generation !== this.generation || !this.active) throw Error('stopped_by_user');
    if (result.hidden !== (hidden === true)) throw Error('desktop_capture_hide_failed');
    this.captureIsHidden = hidden === true;
  }

  pointer(point) {
    if (!this.active || !Number.isFinite(point?.x) || !Number.isFinite(point?.y)) return;
    const marker = { x: point.x, y: point.y, visible: !this.isPaused && point.visible !== false, click: point.click === true };
    if (this.lastMarker && Object.keys(marker).every(key => marker[key] === this.lastMarker[key])) return;
    try { this.send({ pointer: marker }); this.lastMarker = marker; }
    catch { this.stop(); this.onFailure(Error('desktop_indicator_lost')); }
  }

  stop() {
    this.generation++;
    clearInterval(this.heartbeat); this.heartbeat = null;
    clearInterval(this.cursorTimer); this.cursorTimer = null;
    this.active = false; this.outputs = 0;
    this.isPaused = false; this.captureIsHidden = false; this.captureExpired = false;
    this.lastMarker = null;
    for (const key of this.pending.keys()) this.settle(key, null, Error('stopped_by_user'));
    const child = this.child; this.child = null;
    if (!child) return;
    try { child.stdin.end(JSON.stringify({ quit: true }) + '\n'); } catch { /* pipe already closed */ }
    try { child.kill('SIGTERM'); } catch { /* owned helper already gone */ }
    const timer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        try { child.kill('SIGKILL'); } catch { /* owned helper already gone */ }
      }
    }, 500);
    timer.unref?.();
    child.once('exit', () => clearTimeout(timer));
  }
}

module.exports = { DesktopOverlay, cursorPosition };
