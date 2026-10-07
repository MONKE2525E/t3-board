const { spawn } = require('node:child_process');

const ACTIONS = new Set(['move', 'click', 'double_click', 'drag', 'scroll']);
const BUTTONS = new Set(['left', 'right', 'middle']);
const DIRECTIONS = new Set(['up', 'down', 'left', 'right']);
const OUTPUT_NAME = /^[A-Za-z0-9._:-]{1,63}$/;
const COORD_MIN = -100000;
const COORD_MAX = 100000;
const STDOUT_LIMIT = 65536;
const REQUEST_TIMEOUT_MS = 8000;
const KILL_MS = 500;

function integer(value, name) {
  if (typeof value === 'string' && value.trim() !== '') value = Number(value);
  if (!Number.isInteger(value) || value < COORD_MIN || value > COORD_MAX) throw Error(`invalid_${name}`);
  return value;
}

function extent(value, name) {
  const n = integer(value, name);
  if (n < 1) throw Error(`invalid_${name}`);
  return n;
}

function point(value, label = 'point') {
  if (!value || typeof value !== 'object') throw Error(`invalid_${label}`);
  const output = String(value.output ?? '');
  if (!OUTPUT_NAME.test(output)) throw Error('invalid_output');
  return {
    x: integer(value.x, 'x'),
    y: integer(value.y, 'y'),
    localX: integer(value.localX, 'localX'),
    localY: integer(value.localY, 'localY'),
    width: extent(value.width, 'width'),
    height: extent(value.height, 'height'),
    output,
  };
}

function durationOf(value) {
  if (value == null || value === '') return undefined;
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) throw Error('invalid_duration');
  return Math.min(400, Math.max(80, Math.round(n)));
}

function amountOf(value) {
  if (value == null || value === '') return 1;
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n < 1 || n > 100) throw Error('invalid_scroll');
  return Math.floor(n);
}

class WaylandPointer {
  constructor({ helper, onMove = () => {}, onFailure = () => {}, spawnImpl = spawn, env = process.env, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
    this.helper = helper;
    this.onMove = onMove;
    this.onFailure = onFailure;
    this.spawnImpl = spawnImpl;
    this.env = env;
    this.timeoutMs = timeoutMs;
    this.generation = 0;
    this.nextId = 0;
    this.pending = new Map();
    this.available = false;
    this.outputs = [];
    this.child = null;
  }

  send(message) {
    if (!this.child?.stdin?.writable) throw Error('pointer_unavailable');
    this.child.stdin.write(JSON.stringify(message) + '\n');
  }

  wait(id) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(Error('pointer_timeout'));
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
    const wasAvailable = this.available;
    this.stop();
    if (wasAvailable) this.onFailure(Error('pointer_helper_lost'));
  }

  async start() {
    this.stop();
    const generation = this.generation;
    const ready = this.wait('ready');
    let child;
    try { child = this.spawnImpl(this.helper, [], { stdio: ['pipe', 'pipe', 'pipe'], env: this.env }); }
    catch { this.settle('ready', null, Error('pointer_helper_unavailable')); }
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
        else if (event.event === 'ack') {
          if (Number.isInteger(event.x) && Number.isInteger(event.y)) {
            try { this.onMove({ x: event.x, y: event.y, click: event.click === true }); } catch { /* overlay must not break input */ }
          }
        } else if (event.event === 'result') this.settle(event.id, event);
        else if (event.event === 'error') {
          const error = Error(event.error || 'pointer_helper_error');
          if (event.id) this.settle(event.id, null, error);
          else { this.settle('ready', null, error); fail(); }
        }
      }
    });
    try {
      const event = await ready;
      if (generation !== this.generation || this.child !== child) throw Error('stopped_by_user');
      if (event?.event === 'error') throw Error(event.error || 'pointer_helper_unavailable');
      this.available = true;
      this.outputs = Array.isArray(event.outputs) ? event.outputs : [];
      return { outputs: this.outputs };
    } catch (error) {
      if (this.child === child) this.stop();
      throw error;
    }
  }

  async perform(args = {}, signal) {
    if (!this.available || !this.child) throw Error('pointer_unavailable');
    const generation = this.generation;
    if (!ACTIONS.has(args.action)) throw Error('action_unsupported');
    const dest = point(args.point);
    const from = args.from != null ? point(args.from, 'from') : undefined;
    if (args.action === 'drag' && !from) throw Error('invalid_from');
    if (from && from.output !== dest.output) throw Error('cross_output_drag_unsupported');
    const request = { id: String(++this.nextId), action: args.action, point: dest };
    if (from) request.from = from;
    if (args.action === 'click' || args.action === 'double_click' || args.action === 'drag') {
      request.button = args.button || 'left';
      if (!BUTTONS.has(request.button)) throw Error('invalid_button');
    }
    if (args.action === 'scroll') {
      request.direction = args.direction || 'down';
      if (!DIRECTIONS.has(request.direction)) throw Error('invalid_scroll');
      request.amount = amountOf(args.amount);
    }
    const duration = durationOf(args.duration);
    if (duration != null) request.duration = duration;
    if (generation !== this.generation || !this.available) throw Error('stopped_by_user');
    const result = this.wait(request.id);
    // Abort or a closed pipe can reject the wait before execution reaches await.
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
      try { this.send(request); }
      catch (error) { this.lost(this.child); throw error; }
      const event = await result;
      if (generation !== this.generation || this.child == null) throw Error('stopped_by_user');
      if (!Number.isInteger(event.x) || !Number.isInteger(event.y)) throw Error('invalid_pointer_result');
      return { dispatched: true, pointer: { x: event.x, y: event.y } };
    } finally {
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  }

  stop() {
    this.generation++;
    this.available = false;
    this.outputs = [];
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

module.exports = { WaylandPointer };
