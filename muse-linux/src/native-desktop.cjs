const { execFile } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { runBatch } = require('./action-batch.cjs');
const { elementNumber } = require('./control-selector.cjs');
const { normalizeKey } = require('./key-names.cjs');
const { requireBmpText } = require('./keyboard-input.cjs');
const {LayerControl}=require('./layer-control.cjs');
const { ScreenshotCache, parseForceImage } = require('./screenshot-cache.cjs');

const ACTION_LABELS = {
  move: 'Moving pointer',
  click: 'Clicking',
  double_click: 'Double clicking',
  drag: 'Dragging',
  scroll: 'Scrolling',
  type: 'Typing',
  key: 'Pressing a key',
  focus: 'Focusing',
  observe: 'Observing',
  open_app: 'Opening app',
  move_window: 'Moving window',
  switch_workspace: 'Switching workspace',
};

function defaultRun(command, args, options = {}) {
  const { input, ...rest } = options;
  return new Promise((resolve, reject) => {
    const child = execFile(command, args, rest, (error, stdout, stderr) => {
      if (error) { error.stdout = stdout; error.stderr = stderr; reject(error); }
      else resolve({ stdout, stderr });
    });
    // A short-lived helper can close stdin before a pending write completes.
    // execFile's callback supplies its exit result; do not crash on EPIPE.
    child.stdin?.on('error', error => { if (error.code !== 'EPIPE') reject(error); });
    child.stdin?.end(input ?? '');
  });
}

function luaString(value) {
  return '"' + String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\x00-\x1f]/g, c => `\\${String(c.charCodeAt(0)).padStart(3, '0')}`) + '"';
}

function shortcutCommand({ mods = [], key, windowId }) {
  const names = { control: 'CTRL', shift: 'SHIFT', alt: 'ALT', super: 'SUPER' };
  const mod = (Array.isArray(mods) ? mods : String(mods).split(',')).filter(Boolean).map(m => names[m] || m).join('+');
  return `hl.dsp.send_shortcut({mods=${luaString(mod)},key=${luaString(key)},window=${luaString('address:' + windowId)}})`;
}

function clientRect(client) { return [...client.at, ...client.size]; }

function rectsOverlap(a, b) {
  return a[0] < b[0] + b[2] && a[0] + a[2] > b[0] && a[1] < b[1] + b[3] && a[1] + a[3] > b[1];
}

function workspaceShown(monitor, workspaceId) {
  return !!monitor && (monitor.activeWorkspace?.id === workspaceId || monitor.specialWorkspace?.id === workspaceId);
}

function monitorFor(client, monitors) {
  return monitors.find(m => m.id === client.monitor) || monitors.find(m => workspaceShown(m, client.workspace?.id));
}

function monitorLogicalSize(monitor) {
  const scale = Number(monitor.scale) > 0 ? Number(monitor.scale) : 1;
  let width = Math.round(Number(monitor.width) / scale);
  let height = Math.round(Number(monitor.height) / scale);
  if ((Number(monitor.transform) || 0) % 2 === 1) [width, height] = [height, width];
  return { x: monitor.x, y: monitor.y, width, height };
}

function fullyOnMonitor(client, monitor) {
  if (!monitor) return false;
  const [x, y, w, h] = clientRect(client);
  const box = monitorLogicalSize(monitor);
  return w >= 1 && h >= 1 && x >= box.x && y >= box.y && x + w <= box.x + box.width && y + h <= box.y + box.height;
}

function above(other, target) {
  if (!!other.fullscreen !== !!target.fullscreen) return !!other.fullscreen;
  if (!!other.floating !== !!target.floating) return !!other.floating;
  return other.focusHistoryID < target.focusHistoryID;
}

function occluder(client, clients) {
  const rect = clientRect(client);
  return clients.find(other => other.address !== client.address && other.mapped && !other.hidden
    && other.workspace?.id === client.workspace?.id && rectsOverlap(rect, clientRect(other)) && above(other, client));
}

function ownedPidValue(pid) {
  const n = Number(pid && typeof pid === 'object' ? pid.pid : pid);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function sameOwnedPid(pid, ownedPid) {
  const owned = ownedPidValue(ownedPid);
  return owned != null && Number(pid) === owned;
}

function isOwnedIndicator(surface, ownedPid) {
  if (ownedPid && typeof ownedPid === 'object' && ownedPidValue(ownedPid)) {
    const ns = ownedPid.namespaces;
    if (ns && [ns.glow, ns.stop].includes(surface.namespace) && /^muse-control-(?:overlay|stop)-[a-f0-9]{32}$/.test(surface.namespace)) {
      return ownedPidValue(surface.pid) == null || sameOwnedPid(surface.pid, ownedPid);
    }
  }
  return sameOwnedPid(surface.pid, ownedPid)
    && (surface.namespace === 'muse-control-overlay' || surface.namespace === 'muse-control-stop');
}

function layerSurfaces(layers, monitor) {
  if (layers == null) return null;
  const node = layers[monitor?.name] || layers[monitor?.id] || layers[String(monitor?.id)];
  const levels = node?.levels || {};
  const found = [];
  for (const [level, surfaces] of Object.entries(levels)) {
    if (Number(level) < 2) continue;
    for (const surface of Array.isArray(surfaces) ? surfaces : []) {
      if (!surface || surface.alpha === 0) continue;
      const width = surface.w ?? surface.width, height = surface.h ?? surface.height;
      if (width > 0 && height > 0) found.push({ x: surface.x, y: surface.y, w: width, h: height, namespace: surface.namespace || '', pid: surface.pid });
    }
  }
  return found;
}

function coveringLayers(layers, monitor, ownedPid) {
  const all = layerSurfaces(layers, monitor);
  if (all == null) return null;
  return all.filter(surface => !isOwnedIndicator(surface, ownedPid)).map(surface => [surface.x, surface.y, surface.w, surface.h]);
}

function captureIssue(client, clients, monitors, layers = {}, ownedPid) {
  if (!client || !client.mapped || client.hidden) return 'window_not_visible: show this window before requesting its screenshot';
  const monitor = monitorFor(client, monitors);
  if (!workspaceShown(monitor, client.workspace?.id)) return 'window_not_visible: show this window before requesting its screenshot';
  if (!fullyOnMonitor(client, monitor)) return 'window_not_visible: the selected window is not fully on an active monitor';
  if (occluder(client, clients)) return 'window_obscured: another window covers the selection';
  const covering = coveringLayers(layers, monitor, ownedPid);
  if (covering == null) return 'window_obscured: layer surfaces could not be checked';
  const blocker = layerSurfaces(layers, monitor)?.find(surface => !isOwnedIndicator(surface, ownedPid) && rectsOverlap(clientRect(client), [surface.x, surface.y, surface.w, surface.h]));
  if (blocker) return `window_obscured: a layer surface covers the selection (${String(blocker.namespace || 'unnamed').replace(/[\r\n\x00-\x1f]/g, '').slice(0, 100)}, pid ${ownedPidValue(blocker.pid) || 'unknown'})`;
  return null;
}

function pointInSurface(x, y, surface) {
  return x >= surface.x && y >= surface.y && x < surface.x + surface.w && y < surface.y + surface.h;
}

function pointOnOwnedStop(layers, monitors, x, y, ownedPid) {
  if (ownedPidValue(ownedPid) == null || layers == null) return false;
  for (const monitor of monitors || []) {
    const all = layerSurfaces(layers, monitor);
    if (!all) continue;
    if (all.some(surface => isOwnedIndicator(surface, ownedPid) && (surface.namespace === 'muse-control-stop' || surface.namespace === ownedPid?.namespaces?.stop) && pointInSurface(x, y, surface))) return true;
  }
  return false;
}

function sameRegion(a, b) {
  return JSON.stringify(clientRect(a)) === JSON.stringify(clientRect(b)) && a.workspace?.id === b.workspace?.id && a.monitor === b.monitor;
}

function parseCoordinate(value, label = 'invalid_coordinate') {
  if (value == null || value === '') return null;
  let coord = value;
  if (typeof coord === 'string') {
    try { coord = JSON.parse(coord); } catch { throw Error(`${label}: expected [x,y] normalized 0-1000 in the selected window`); }
  }
  if (!Array.isArray(coord) || coord.length !== 2) throw Error(`${label}: expected [x,y] normalized 0-1000 in the selected window`);
  const x = Number(coord[0]), y = Number(coord[1]);
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1000 || y < 0 || y > 1000) throw Error(`${label}: expected [x,y] normalized 0-1000 in the selected window`);
  return [x, y];
}

function parseButton(value) {
  if (value == null || value === '') return 'left';
  const button = String(value);
  if (!['left', 'right', 'middle'].includes(button)) throw Error('invalid_button: use left, right or middle');
  return button;
}

function wantsPointer(args) {
  const action = args.action;
  const hasCoord = args.coordinate != null && args.coordinate !== '' || args.start_coordinate != null && args.start_coordinate !== '';
  const hasElement = args.element_number != null && args.element_number !== '' || !!args.element_label;
  if (['move', 'double_click', 'drag'].includes(action)) return true;
  if (action === 'click' && hasCoord || action === 'scroll' && hasCoord && !hasElement) return true;
  if (action === 'click' && args.button && String(args.button) !== 'left') return true;
  return false;
}

function parsePointerArgs(args) {
  const action = args.action;
  const button = parseButton(args.button);
  if (action === 'drag') {
    const from = parseCoordinate(args.start_coordinate ?? args.coordinate);
    const to = parseCoordinate(args.end_coordinate, 'invalid_end_coordinate');
    if (!from || !to) throw Error('invalid_end_coordinate: drag needs coordinate start and end_coordinate destination');
    let duration;
    if (args.duration != null && args.duration !== '') {
      duration = Number(args.duration);
      if (!Number.isFinite(duration) || duration < 0 || duration > 30) throw Error('invalid_duration');
    }
    return { action: 'drag', from, to, button, duration };
  }
  if (action === 'scroll') {
    const coord = parseCoordinate(args.coordinate);
    if (!coord) throw Error('invalid_coordinate: expected [x,y] normalized 0-1000 in the selected window');
    const direction = args.scroll_direction || 'down';
    const amount = Math.min(100, Math.max(1, Number(args.scroll_amount) || 3));
    if (!['up', 'down', 'left', 'right'].includes(direction)) throw Error('invalid_scroll');
    return { action: 'scroll', coord, button, direction, amount };
  }
  const coord = parseCoordinate(args.coordinate);
  if (!coord) throw Error('invalid_coordinate: expected [x,y] normalized 0-1000 in the selected window');
  const pointerAction = action === 'double_click' ? 'double_click' : action === 'move' ? 'move' : 'click';
  return { action: pointerAction, coord, button };
}

function pointerDurationMs(seconds) {
  if (seconds == null) return undefined;
  return Math.min(400, Math.max(80, Math.round(Number(seconds) * 1000)));
}

function outputPoint(x, y, monitor) {
  const box = monitor ? monitorLogicalSize(monitor) : { x: 0, y: 0, width: 0, height: 0 };
  return {
    x, y,
    localX: x - box.x,
    localY: y - box.y,
    width: box.width,
    height: box.height,
    output: monitor?.name || null,
  };
}

function windowPoint(client, [nx, ny], monitor) {
  const [x, y, w, h] = clientRect(client);
  return outputPoint(x + Math.round(nx / 1000 * Math.max(1, w - 1)), y + Math.round(ny / 1000 * Math.max(1, h - 1)), monitor);
}

function decodeScreenshot(png) {
  const image = require('electron').nativeImage.createFromBuffer(png);
  if (image.isEmpty()) throw Error('screenshot_decode_failed');
  const {width,height} = image.getSize();
  if (width * height * 4 > 128 * 1024 * 1024) throw Error('screenshot_too_large');
  return {width,height,pixels:image.toBitmap()};
}

function accessibilityPoint(target, element, windowBounds, monitor) {
  if (!Array.isArray(windowBounds) || windowBounds.length !== 4 || !Array.isArray(element?.bounds) || element.bounds.length !== 4) return null;
  const [ax,ay,aw,ah] = windowBounds.map(Number), [ex,ey,ew,eh] = element.bounds.map(Number);
  if (![ax,ay,aw,ah,ex,ey,ew,eh].every(Number.isFinite) || aw <= 0 || ah <= 0 || ew <= 0 || eh <= 0) return null;
  if (ex < ax || ey < ay || ex + ew > ax + aw || ey + eh > ay + ah) return null;
  const [x,y,w,h] = target.bounds;
  const px = x + Math.round((ex - ax + ew / 2) * w / aw), py = y + Math.round((ey - ay + eh / 2) * h / ah);
  if (px < x || py < y || px >= x + w || py >= y + h) return null;
  return outputPoint(px,py,monitor);
}

class NativeDesktop {
  constructor({ helper, allowed, permission, blocked = () => [], onChange = () => {}, onStateChange = () => {}, runFile = defaultRun, pointer = null, feedback = null, keyboard = null, apps = null, activity = null, context = null, decodeImage = decodeScreenshot }) {
    this.helper = helper;
    this.allowed = allowed;
    this.permission = permission;
    this.blocked = blocked;
    this.onChange = onChange;
    this.runFile = runFile;
    this.pointer = pointer || null;
    this.feedback = feedback || null;
    this.keyboard = keyboard;
    this.apps = apps;
    this.activity = activity;
    this.context = context;
    this.onStateChange = onStateChange;
    this.paused = false;
    this.sessionId = null;
    this.observation = null;
    this.abort = null;
    this.generation = 0;
    this.screenshots = new ScreenshotCache();
    this.decodeImage = decodeImage;
    this.layers = new LayerControl(this,{layerSurfaces,monitorLogicalSize,clientRect,windowPoint,pointOnOwnedStop,parsePointerArgs});
  }

  ownedPid() { return this.feedback?.namespaces ? { pid: this.feedback.pid, namespaces: this.feedback.namespaces } : ownedPidValue(this.feedback?.pid); }

  status() {
    return { session_id: this.sessionId, state: !this.sessionId ? 'idle' : this.paused ? 'paused' : 'active', paused: this.paused,
      reason: this.pauseReason || null, paused_at: this.pausedAt ? new Date(this.pausedAt).toISOString() : null,
      physical_input_detection: this.activityAvailable === true, requires_user_resume: !!this.sessionId && this.paused,
      last_interruption: this.lastInterruption || null };
  }

  pauseReceipt(extra = {}) {
    return { ...extra, ...this.status(), interrupted: true, retryable: false, error: 'desktop_paused: the user has control',
      user_action_required: 'Wait for the user to click Resume. Then obtain a fresh observation. Do not replay partially completed input.' };
  }

  pause(reason = 'user_pause') {
    if (!this.sessionId || this.paused) return this.status();
    this.paused = true;
    this.pauseReason = ['human_input', 'user_pause', 'input_unavailable'].includes(reason) ? reason : 'user_pause';
    this.pausedAt = Date.now();
    this.lastInterruption = { reason: this.pauseReason, at: new Date(this.pausedAt).toISOString() };
    this.generation++;
    this.abort?.abort();
    this.abort = new AbortController();
    this.observation = null;
    this.screenshots.reset();
    this.pointer?.stop?.();
    this.keyboard?.stop?.();
    this.apps?.stop?.();
    this.feedback?.paused?.(true, this.pauseReason);
    // Pausing holds the desktop grant until the user resumes or stops it.
    clearTimeout(this.timer); this.timer = null;
    this.onStateChange(this.status());
    return this.status();
  }

  async resumeByUser() {
    if (!this.sessionId || !this.paused) return this.status();
    // A physical press that caused takeover must not also activate Resume.
    if (Date.now() - this.pausedAt < 300) return this.status();
    if (this.resuming) return this.status();
    this.resuming = true;
    const generation = this.generation;
    try {
      if (!this.allowed()) { this.stop(); throw Error('desktop_control_disabled'); }
      if (this.activity && !this.activity.available) {
        const ready = await this.activity.start();
        this.activityAvailable = ready.available === true;
        if (!this.activityAvailable && this.activity.env?.MUSE_ACTIVITY_DISABLED !== '1') throw Error('physical_input_detection_unavailable');
      }
      if (this.pointer) await this.withAbort(generation, () => this.pointer.start());
      if (generation !== this.generation || !this.sessionId) throw Error('session_required_or_stopped');
      this.ignorePhysicalUntil = Date.now() + 250;
      this.paused = false;
      this.pauseReason = null;
      this.pausedAt = null;
      this.observation = null;
      this.expires = Date.now() + 600000;
      this.timer = setTimeout(() => this.stop(), 600000); this.timer.unref?.();
      this.feedback?.paused?.(false);
      this.onStateChange(this.status());
      return this.status();
    } catch (error) {
      this.pointer?.stop?.();
      if (this.sessionId) { this.pauseReason = 'input_unavailable'; this.feedback?.paused?.(true, this.pauseReason); }
      throw error;
    } finally { this.resuming = false; }
  }

  physicalInput() {
    if (Date.now() >= (this.ignorePhysicalUntil || 0)) this.pause('human_input');
  }

  activityLost() { this.activityAvailable = false; this.pause('input_unavailable'); }

  capabilities() {
    const ready = !!this.pointer?.available;
    return {
      accessibility: true,
      semantic_actions: true,layer_surfaces:true,observation_free_shortcuts:!!this.keyboard&&!!this.context,
      screenshot_reuse: true,
      targeted_keys: !this.keyboard,
      compositor_keys: !!this.keyboard,
      bulk_text: !!this.keyboard,
      native_keyboard_text: 'Basic Multilingual Plane Unicode. Emoji and other supplementary characters require an accessible editable control or Muse Local Browser; native fallback refuses them before input.',
      installed_app_launch: !!this.apps,
      batch: { max_actions: 16, final_observation: true },
      pause: { physical_takeover: this.activityAvailable === true, resume: 'User only; obtain a fresh observation after Resume', scope: 'Desktop input and new local mutations. Already running terminal/command jobs and cloud reasoning are not suspended.' },
      desktop_context: !!this.context,
      graceful_window_close: true,
      screenshots_exclude_indicator: !!this.feedback?.captureHidden,
      key_names: 'Case-insensitive: Enter/Return, Tab, arrows, Home/End, PageUp/PageDown, F1-F24; Ctrl+Shift+P or key with modifiers ctrl,shift. Meta/Super/Win are equivalent.',
      pointer: ready,
      pointer_actions: ready ? ['move', 'click', 'double_click', 'drag', 'scroll'] : [],
      buttons: ready ? ['left', 'right', 'middle'] : [],
      coordinate_system: { origin: 'top_left', min: 0, max: 1000, space: 'selected_window', units: 'normalized' },
    };
  }

  emitAction(action) {
    try { this.feedback?.action?.(ACTION_LABELS[action] || 'Working'); } catch { /* overlay must not block input */ }
  }

  emitPointer(point, click = false) {
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return;
    try { this.feedback?.pointer?.({ ...point, visible: true, click: click === true }); } catch { /* overlay must not block input */ }
  }

  stop() {
    this.generation++;
    if (this.stopping) return;
    this.stopping = true;
    const endedPaused = this.paused === true;
    try {
      clearTimeout(this.timer);
      this.timer = null;
      this.abort?.abort();
      this.abort = null;
      this.sessionId = null;
      this.observation = null;
      this.screenshots.reset();
      this.paused = false; this.pauseReason = null; this.pausedAt = null;
      this.activityAvailable = false;
      try { this.activity?.stop?.(); } catch { /* owned watcher only */ }
      try { this.pointer?.stop?.(); } catch { /* pointer stop is best-effort */ }
      try { this.keyboard?.stop?.(); } catch { /* owned helper only */ }
      try { this.apps?.stop?.(); } catch { /* owned launcher only */ }
      try { this.feedback?.stop?.(); } catch { /* overlay stop is best-effort */ }
      this.onChange(null);
      this.onStateChange(this.status(), { endedPaused });
    } finally { this.stopping = false; }
  }

  blockedSet() {
    const extra = this.blocked();
    return new Set(['muse-linux', 'io.muse.linux', ...(Array.isArray(extra) ? extra : [])].filter(Boolean));
  }

  check(args, { allowPaused = false } = {}) {
    if (this.abort?.signal.aborted || !this.sessionId) throw Error('session_required_or_stopped');
    if (!this.allowed() || (!this.paused && Date.now() > this.expires)) { this.stop(); throw Error('session_required_or_stopped'); }
    if (this.paused && !allowPaused) throw Error('desktop_paused: wait for the user to click Resume');
    if (Number.isFinite(args?.__deadline) && Date.now() >= args.__deadline) throw Error('request_expired');
  }

  async jsonCommand(command, args, options = {}) {
    const result = await this.runFile(command, args, { timeout: 5000, maxBuffer: 512 * 1024, encoding: 'utf8', signal: this.abort?.signal, ...options });
    return JSON.parse(result.stdout);
  }

  async snapshot() {
    const [clients, monitors, layers] = await Promise.all([
      this.jsonCommand('hyprctl', ['-j', 'clients']),
      this.jsonCommand('hyprctl', ['-j', 'monitors']),
      this.jsonCommand('hyprctl', ['-j', 'layers']).catch(() => null),
    ]);
    return { clients: Array.isArray(clients) ? clients : [], monitors: Array.isArray(monitors) ? monitors : [], layers };
  }

  present(client, clients, monitors, layers) {
    const blocked = this.blockedSet();
    if (!client?.mapped || client.hidden || blocked.has(client.class)) return null;
    const issue = captureIssue(client, clients, monitors, layers, this.ownedPid());
    return {
      window_id: client.address,
      pid: client.pid,
      app: client.class,
      title: client.title,
      bounds: clientRect(client),
      workspace: client.workspace?.id,
      workspace_name: client.workspace?.name,
      monitor: monitorFor(client, monitors)?.name || null,
      focused: client.focusHistoryID === 0,
      visibility_reason: issue || null,
      visible: !issue,
    };
  }

  async windows() {
    if (!this.allowed()) throw Error('desktop_control_disabled');
    const { clients, monitors, layers } = await this.snapshot();
    return clients.map(client => this.present(client, clients, monitors, layers)).filter(Boolean);
  }

  async withAbort(generation, work) {
    const signal = this.abort?.signal;
    if (!signal || signal.aborted || generation !== this.generation) throw Error('session_required_or_stopped');
    let onAbort;
    try {
      return await Promise.race([
        Promise.resolve().then(work),
        new Promise((_, reject) => {
          onAbort = () => reject(Error('session_required_or_stopped'));
          if (signal.aborted) return onAbort();
          signal.addEventListener('abort', onAbort, { once: true });
        }),
      ]);
    } finally {
      if (onAbort) signal.removeEventListener('abort', onAbort);
    }
  }

  async session(args) {
    if (args.action === 'status') return this.status();
    if (args.action === 'pause') return this.pause();
    if (this.paused && ['start', 'end'].includes(args.action)) return this.pauseReceipt({ dispatched: false });
    if (args.action === 'end') { this.stop(); return { ended: true }; }
    if (args.action !== 'start' || typeof args.task !== 'string' || !args.task.trim() || args.task.length > 160) throw Error('invalid_session_request');
    if (!this.allowed()) throw Error('desktop_control_disabled: enable Computer control in Settings');
    this.stop();
    const controller = new AbortController();
    this.abort = controller;
    const generation = this.generation;
    const deadline = Number(args.__deadline);
    if (Number.isFinite(deadline) && deadline <= Date.now()) { this.stop(); throw Error('permission_denied_or_expired'); }
    if (!await this.permission(args.task, args.__deadline, controller.signal) || !this.allowed() || (Number.isFinite(deadline) && Date.now() >= deadline)) {
      const stopped = generation !== this.generation || controller.signal.aborted;
      this.stop();
      throw Error(stopped ? 'session_required_or_stopped' : 'permission_denied_or_expired');
    }
    if (generation !== this.generation || controller.signal.aborted) { this.stop(); throw Error('session_required_or_stopped'); }
    let stage = 'pointer';
    try {
      if (this.pointer) {
        await this.withAbort(generation, () => this.pointer.start());
        if (generation !== this.generation || controller.signal.aborted) throw Error('session_required_or_stopped');
        if (!this.pointer.available) throw Error('pointer_unavailable: pointer helper is not ready');
      }
      stage = 'feedback';
      if (this.feedback) {
        await this.withAbort(generation, () => this.feedback.start(args.task));
        if (generation !== this.generation || controller.signal.aborted) throw Error('session_required_or_stopped');
      }
    } catch (error) {
      const stopped = generation !== this.generation || controller.signal.aborted || error.message === 'session_required_or_stopped' || error.message === 'stopped_by_user';
      this.stop();
      if (stopped) throw Error('session_required_or_stopped');
      if (String(error.message).startsWith('pointer_unavailable') || String(error.message).startsWith('feedback_unavailable')) throw error;
      throw Error(`${stage === 'feedback' ? 'feedback_unavailable' : 'pointer_unavailable'}: ${error.message || 'failed to start'}`);
    }
    if (generation !== this.generation || controller.signal.aborted || !this.allowed()) { this.stop(); throw Error('session_required_or_stopped'); }
    this.sessionId = randomUUID();
    this.ignorePhysicalUntil = Date.now() + 250;
    this.expires = Date.now() + 600000;
    this.timer = setTimeout(() => this.stop(), 600000);
    this.timer.unref?.();
    this.onChange(args.task);
    if (this.activity) {
      let result;
      try { result = await this.activity.start(); }
      catch { result = { available: false }; }
      if (!this.sessionId) throw Error('session_required_or_stopped');
      this.activityAvailable = result.available === true;
      if (!this.activityAvailable && this.activity.env?.MUSE_ACTIVITY_DISABLED !== '1') {
        this.pause('input_unavailable');
        return this.pauseReceipt({ capabilities: this.capabilities() });
      }
    }
    this.onStateChange(this.status());
    const windows = await this.windows();
    if (this.paused) return this.pauseReceipt({ windows, capabilities: this.capabilities() });
    if (generation !== this.generation) { this.stop(); throw Error('session_required_or_stopped'); }
    return {
      session_id: this.sessionId,
      scope: 'Native Linux windows, except blocked apps',
      expires_in_seconds: 600,
      user_can_stop: true,
      user_can_see_preview: !!this.feedback,
      windows,
      capabilities: this.capabilities(),
    };
  }

  appMatch(window, app) {
    const wanted = String(app || '').trim().toLowerCase();
    if (!wanted) return false;
    const stem = wanted.replace(/\.desktop$/, '');
    return [wanted, stem].includes(String(window.app || '').toLowerCase()) || String(window.title || '').toLowerCase() === wanted;
  }

  async target(value, args) {
    this.check(args);
    const windows = await this.windows();
    const target = windows.find(w => w.window_id === (value || this.observation?.window_id));
    if (!target) throw Error('window_required: list_windows and choose an allowed window_id');
    return target;
  }

  async select(args, state = {}) {
    this.check(args);
    let windowId = args.window_id;
    if (args.action === 'open_app' || args.app) {
      const windows = await this.windows();
      let entry;
      if (args.app && this.apps) {
        try { entry = this.apps.match(args.app); }
        catch (error) { if (!['app_not_installed', 'invalid_app'].includes(error.message)) throw error; }
      }
      const names = [args.app, entry?.id, entry?.name, entry?.startupWmClass].filter(Boolean);
      let destination;
      if(args.action==='open_app'){
        if(!this.context)throw Error('desktop_context_unavailable');
        const context=await this.context.get();this.check(args);
        destination=this.workspaceDestination(args.workspace!=null&&args.workspace!==''?args.workspace:context.currentWorkspace?.id || context.currentWorkspace?.name,context);
      }
      let matches = args.app ? windows.filter(w => names.some(name => this.appMatch(w, name))) : windows;
      if(!windowId && destination && matches.some(window=>window.workspace===destination.id))matches=matches.filter(window=>window.workspace===destination.id);
      if (!windowId && matches.length > 1) throw Error('app_ambiguous: choose window_id from list_windows: ' + matches.map(w => w.window_id).join(', '));
      const chosen = windowId ? matches.find(w => w.window_id === windowId) : matches[0];
      if (!chosen) {
        if (args.action !== 'open_app' || !args.app || !this.apps) throw Error('app_not_running: use list_apps and open_app with an exact installed app id');
        if (windowId) throw Error('window_required: supplied window_id does not match the app');
        if (!entry) entry = this.apps.match(args.app);
        const blocked = this.blockedSet();
        if ([entry.id, entry.id.replace(/\.desktop$/i, ''), entry.name, entry.startupWmClass].filter(Boolean).some(name => blocked.has(name))) throw Error('app_blocked');
        this.emitAction('open_app');
        this.observation = null;
        this.check(args);
        const generation = this.generation;
        state.inputStarted = true;
        const launch = await this.apps.launch({ id: entry.id, workspace: destination?.id > 0 ? destination.id : destination?.name, signal: this.abort?.signal });
        state.dispatched = launch.dispatched === true;
        state.receipt = launch;
        this.check(args);
        if (generation !== this.generation) throw Error('session_required_or_stopped');
        const expires = Math.min(Date.now() + 1800, args.__deadline || Infinity);
        let launchedWindows;
        do {
          this.check(args);
          launchedWindows = await this.windows();
          this.check(args);
          const appeared = launchedWindows.filter(w => names.some(name => this.appMatch(w, name)));
          if (appeared.length === 1) {
            const window = appeared[0];
            if (destination && window.workspace !== destination.id) {
              const moved = await this.moveWindow(window, { ...args, workspace: destination.id > 0 ? destination.id : destination.name }, state);
              launchedWindows = moved.windows;
            }
            const placed = launchedWindows.find(w => w.window_id === window.window_id && w.pid === window.pid);
            return { ...launch, window_id: placed?.window_id, workspace_verified: !!placed && placed.workspace === destination?.id, windows: launchedWindows, verification: 'Inspect workspace_verified and select the returned window before input.' };
          }
          if (Date.now() >= expires) break;
          await new Promise(resolve => setTimeout(resolve, 100));
        } while (Date.now() < expires);
        return { ...launch, workspace_verified: false, windows: launchedWindows, verification: 'Launch dispatched but placement is not verified. Select the actual window from list_windows and move it if needed. Do not relaunch a starting app.' };
      }
      if(destination){
        if(chosen.workspace!==destination.id)await this.moveWindow(chosen,{...args,workspace:destination.id>0?destination.id:destination.name},state);
        const refreshed=await this.target(chosen.window_id,args);
        if(refreshed.pid!==chosen.pid)throw Error('stale_observation: the selected process changed');
        await this.liveWindow(refreshed,args);
        this.observation=null;this.check(args);state.inputStarted=true;
        const result=await this.runFile('hyprctl',['dispatch',`hl.dsp.focus({window=${luaString('address:'+refreshed.window_id)}})`],{encoding:'utf8',timeout:3000,signal:this.abort?.signal});
        if(String(result.stdout||'').trim()!=='ok')throw Error('focus_failed');
        state.dispatched=true;this.check(args);
      }
      windowId = chosen.window_id;
    }
    if (!windowId && !this.observation?.window_id) throw Error('window_required: list_windows and choose an allowed window_id');
    return this.observe({ window_id: windowId, view: args.view, image: args.image, force_image:args.force_image, __deadline: args.__deadline });
  }

  workspaceDestination(value, context) {
    if(!context.supported)throw Error(context.reason || 'desktop_context_unavailable');
    try{return this.context.resolveWorkspace(value,context.workspaces);}
    catch(error){
      const n=typeof value==='number'?value:/^[1-9][0-9]{0,3}$/.test(String(value))?Number(value):null;
      if(error.message==='workspace_not_found' && Number.isInteger(n) && n>0 && n<=1000)return{id:n,name:String(n),special:false};
      throw error;
    }
  }

  async moveWindow(target,args,state={}) {
    if(!this.context)throw Error('desktop_context_unavailable');
    const context=await this.context.get();this.check(args);
    const destination=this.workspaceDestination(args.workspace,context);
    await this.liveWindow(target,args);
    const follow=args.follow===true||args.follow==='true';
    if(args.follow!=null&&!['',true,false,'true','false'].includes(args.follow))throw Error('invalid_follow');
    const expr=this.context.moveWindowDispatch(target.window_id,destination.id>0?destination.id:destination.name,follow);
    this.observation=null;this.check(args);this.emitAction('move_window');state.inputStarted=true;
    const result=await this.runFile('hyprctl',['dispatch',expr],{encoding:'utf8',timeout:3000,signal:this.abort?.signal});
    if(String(result.stdout||'').trim()!=='ok')throw Error('window_move_failed');
    state.dispatched=true;this.check(args);
    const windows=await this.windows();this.check(args);
    const moved=windows.find(window=>window.window_id===target.window_id&&window.pid===target.pid);
    return{dispatched:true,window_id:target.window_id,workspace:destination.id,follow,moved:moved?.workspace===destination.id,windows,
      verification:'Inspect the returned workspace and window. Obtain a fresh observation before input; movement may change visibility and geometry.'};
  }

  helperError(error) {
    if (this.paused) throw Error('desktop_paused: wait for the user to click Resume');
    const aborted = error?.name === 'AbortError' || this.abort?.signal.aborted;
    if (aborted || !this.sessionId) throw Error('session_required_or_stopped');
    const stderr = String(error.stderr || error.message || '');
    if (stderr.includes('accessibility_unavailable')) throw Error('accessibility_unavailable');
    throw Error(stderr.split('\n').filter(Boolean).at(-1)?.slice(0, 200) || 'accessibility_command_failed');
  }

  async accessibility(command, target, element, text, extra = [], state) {
    if (command === 'observe' && this.semanticTree) return this.semanticTree(target);
    const args = [command, String(target.pid), target.title, ...target.bounds.map(String)];
    if (element) args.push(element.path, element.label, ...extra);
    const generation = this.generation;
    try {
      const result = await this.runFile(this.helper, args, {
        timeout: 7000,
        maxBuffer: 512 * 1024,
        encoding: 'utf8',
        signal: this.abort?.signal,
        input: text || '',
      });
      const parsed = JSON.parse(result.stdout);
      if (state && (parsed.dispatched === true || parsed.ok === true)) state.dispatched = true;
      if (generation !== this.generation) throw Error('session_required_or_stopped');
      return parsed;
    } catch (error) {
      if (generation !== this.generation) throw Error('session_required_or_stopped');
      if (error instanceof SyntaxError) throw Error('invalid_accessibility_response');
      this.helperError(error);
    }
  }

  async observe(args = {}) {
    if (this.paused) return this.pauseReceipt({ dispatched: false });
    try { return args.surface === 'layer' ? await this.layers.observe(args) : await this.observeActive(args); }
    catch(error) { if(this.paused) return this.pauseReceipt({dispatched:false}); throw error; }
  }

  async observeActive(args = {}) {
    parseForceImage(args.force_image);
    const generation = this.generation;
    const target = await this.target(args.window_id, args);
    this.emitAction('observe');
    let tree;
    try { tree = await this.accessibility('observe', target); }
    catch (error) {
      if (error.message === 'session_required_or_stopped' || error.message === 'request_expired') throw error;
      tree = { controls: [], accessibility_error: error.message };
    }
    this.check(args);
    if (generation !== this.generation) throw Error('session_required_or_stopped');
    const id = randomUUID();
    const controls = (tree.controls || []).map((c, i) => ({ ...c, element_number: i + 1 }));
    this.observation = { id, window_id: target.window_id, pid: target.pid, title: target.title, bounds: target.bounds, workspace: target.workspace, controls, expires: Date.now() + 120000 };
    const caps = this.capabilities();
    const result = {
      ...target,
      observation_id: id,
      controls,
      text_excerpt: controls.map(c => c.label + (c.value ? ' ' + c.value : '')).join('\n').slice(0, 16000),
      accessibility_available: !tree.accessibility_error,
      accessibility_error: tree.accessibility_error,
      truncated: !!tree.truncated,
      captured_at: new Date().toISOString(),
      coordinate_system: caps.coordinate_system,
      capabilities: caps,
      pointer_actions: caps.pointer_actions,
    };
    if (args.image || args.view === 'image') {
      try { Object.assign(result, await this.captureWindow(target, id, args, generation)); }
      catch (error) {
        if (!/^(window_obscured|window_not_visible):/.test(error.message)) throw error;
        this.check(args);
        if (generation !== this.generation) throw Error('session_required_or_stopped');
        const previous = this.screenshots.baseline;
        Object.assign(result,{capture_status:'unavailable',unchanged:null,image_current:false,capture_error:error.message,
          ...(previous?.key === this.captureKey(target) ? {previous_screenshot_id:previous.screenshot_id} : {}),
          capture_guidance:'Covered or off-workspace pixels cannot be verified. A previous image is stale evidence. Use compositor_key for configured notification/workspace shortcuts, then request an image again.'});
      }
    }
    return result;
  }

  captureKey(target) {
    return JSON.stringify({session:this.sessionId,window:target.window_id,pid:target.pid,title:target.title,bounds:target.bounds,workspace:target.workspace,monitor:target.monitor});
  }

  async captureWindow(target, id, args, generation) {
    const before = await this.snapshot();
    this.check(args);
    const client = before.clients.find(c => c.address === target.window_id && c.pid === target.pid);
    const issue = captureIssue(client, before.clients, before.monitors, before.layers, this.ownedPid());
    if (issue) throw Error(issue);
    const [x, y, w, h] = clientRect(client);
    let png;
    // Compositor acknowledgement ensures the helper's last visible frame is gone.
    try {
      if (this.feedback?.captureHidden) await this.feedback.captureHidden(true);
      this.check(args);
      png = await this.runFile('grim', ['-g', `${x},${y} ${w}x${h}`, '-'], { encoding: 'buffer', timeout: 2500, maxBuffer: 20 * 1024 * 1024, signal: this.abort?.signal });
      if (this.feedback?.captureExpired) throw Error('screenshot_discarded: indicator visibility changed during capture');
    } finally {
      if (this.feedback?.active && this.feedback?.captureHidden) {
        try { await this.feedback.captureHidden(false); }
        catch (error) { this.stop(); throw error; }
      }
    }
    if (this.feedback?.captureExpired) throw Error('screenshot_discarded: indicator visibility changed during capture');
    this.check(args);
    if (generation !== this.generation) throw Error('session_required_or_stopped');
    const after = await this.snapshot();
    const current = after.clients.find(c => c.address === target.window_id && c.pid === target.pid);
    if (!current || !sameRegion(client, current)) throw Error('window_moved: screenshot discarded');
    const later = captureIssue(current, after.clients, after.monitors, after.layers, this.ownedPid());
    if (later) throw Error(later);
    this.check(args);
    if (generation !== this.generation) throw Error('session_required_or_stopped');
    if (!png?.stdout?.length) throw Error('screenshot_failed');
    const bitmap = this.decodeImage(Buffer.from(png.stdout));
    const output=monitorFor(current,after.monitors);
    const geometry=JSON.stringify({scale:output?.scale,transform:output?.transform});
    if(this.captureGeometry!==geometry)this.screenshots.reset();
    this.captureGeometry=geometry;
    const metadata = this.screenshots.compare({key:this.captureKey(target), ...bitmap, force:parseForceImage(args.force_image)});
    return { capture_status:'captured',image_current:true,...metadata, ...(!metadata.unchanged ? {image_transfer:{ mime_type: 'image/png', data_base64: Buffer.from(png.stdout).toString('base64'), filename: `linux-native-${id}.png` }} : {}) };
  }

  stale(observation, target, args) {
    return !observation || args.observation_id !== observation.id || Date.now() > observation.expires
      || target.window_id !== observation.window_id || target.pid !== observation.pid
      || JSON.stringify(target.bounds) !== JSON.stringify(observation.bounds);
  }

  sleep(ms) {
    const signal = this.abort?.signal;
    return new Promise((resolve, reject) => {
      const onAbort = () => { clearTimeout(timer); reject(Error('session_required_or_stopped')); };
      const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
      if (signal?.aborted) return onAbort();
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  async sendKey(target, key, mods, args, state) {
    await this.liveWindow(target, args);
    const before = await this.jsonCommand('hyprctl', ['-j', 'activewindow']).catch(() => null);
    const expr = shortcutCommand({ mods, key, windowId: target.window_id });
    let result;
    try { if (state) state.inputStarted = true; result = await this.runFile('hyprctl', ['dispatch', expr], { timeout: 3000, encoding: 'utf8', signal: this.abort?.signal }); }
    catch (error) { this.helperError(error); }
    const text = String(result.stdout || '').trim();
    if (text && text !== 'ok') throw Error('key_dispatch_failed: targeted shortcut was not accepted');
    if (state) state.dispatched = true;
    this.check(args);
    const after = await this.jsonCommand('hyprctl', ['-j', 'activewindow']).catch(() => null);
    if (before?.address && after?.address && before.address !== after.address) throw Error('key_dispatch_failed: targeted shortcut stole focus');
  }

  async compositorKey(args,state) {
    if(!this.keyboard || !this.context)throw Error('compositor_keyboard_unavailable');
    const normalized=normalizeKey({key:args.key,modifiers:args.modifiers || undefined});
    const context=await this.context.get();this.check(args);
    const binding=context.keybindings?.find(b=>{
      if(b.submap || b.key_missing)return false;
      try {
        const chord=normalizeKey({key:b.us_key || b.keys?.at(-1),modifiers:b.keys?.slice(0,-1).join('+')});
        return (b.evdev ?? chord.linux.code)===normalized.linux.code && JSON.stringify(chord.mods.filter(m=>m!==({Super:'super',Control:'control',Shift:'shift',Alt:'alt'})[chord.key]))===JSON.stringify(normalized.mods);
      }catch{return false;}
    });
    if(!binding)throw Error('configured_shortcut_required: use list_keybindings; ordinary app keys need a fresh observation');
    const validate=async()=>{this.check(args);const active=await this.jsonCommand('hyprctl',['-j','activewindow']);this.check(args);if(args.window_id && active.address!==args.window_id)throw Error('compositor_target_mismatch: global shortcuts act on the focused window; activate the intended window first');if(this.blockedSet().has(active.class)||this.blockedSet().has(active.initialClass))throw Error('app_blocked: compositor shortcut would affect a blocked focused app');return true;};
    await validate();this.observation=null;this.emitAction('key');state.inputStarted=true;state.receipt={route:'compositor_keyboard',dispatch_path:'compositor'};
    await this.keyboard.key(normalized.combo,{signal:this.abort?.signal,validateFocus:validate});state.dispatched=true;this.check(args);
    await this.sleep(150);this.check(args);
    return {dispatched:true,...state.receipt,shortcut:normalized.combo,binding:binding.chord,desktop:await this.context.get(),
      verification:'Configured shortcut dispatched without focusing a window. Inspect desktop context or a new observation for its effect; prior observation IDs are invalid.'};
  }

  async focusKeyboard(target, args) {
    await this.liveWindow(target, args, { requireVisible: true });
    const result = await this.runFile('hyprctl', ['dispatch', `hl.dsp.focus({window=${luaString('address:' + target.window_id)}})`], { timeout: 3000, encoding: 'utf8', signal: this.abort?.signal });
    if (String(result.stdout || '').trim() !== 'ok') throw Error('focus_failed');
    const validate = async () => {
      await this.liveWindow(target, args, { requireVisible: true });
      const active = await this.jsonCommand('hyprctl', ['-j', 'activewindow']);
      this.check(args);
      return active?.address === target.window_id && active?.pid === target.pid;
    };
    if (!await validate()) throw Error('focus_lost');
    return validate;
  }

  async typeFocused(target, args, state) {
    if (!this.keyboard) throw Error('keyboard_helper_unavailable');
    if (typeof args.text !== 'string' || args.text.length > 4096 || args.text.includes('\0')) throw Error('invalid_text');
    if (args.text) requireBmpText(args.text);
    if (args.coordinate != null && args.coordinate !== '') {
      await this.dispatchPointer(target, parsePointerArgs({ action: 'click', coordinate: args.coordinate }), args, state);
    }
    const validate = await this.focusKeyboard(target, args);
    state.inputStarted = true;
    this.keyboard.validateFocus = validate;
    try {
      this.emitAction('type');
      if (args.replace_all === true || args.replace_all === 'true') await this.keyboard.key('Ctrl+A', this.abort?.signal);
      if (args.text) await this.keyboard.type(args.text, this.abort?.signal);
      else if (args.replace_all === true || args.replace_all === 'true') await this.keyboard.key('Backspace', this.abort?.signal);
      state.dispatched = true;
      this.check(args);
    } finally { this.keyboard.validateFocus = null; }
  }

  async liveWindow(target, args, { requireVisible = false } = {}) {
    this.check(args);
    const snap = await this.snapshot();
    const client = snap.clients.find(c => c.address === target.window_id && c.pid === target.pid);
    if (!client) throw Error('stale_observation: observe the target again');
    if (this.blockedSet().has(client.class)) throw Error('window_required: list_windows and choose an allowed window_id');
    if (!client.mapped || client.hidden) throw Error('window_not_visible: show this window before requesting input');
    if (!this.present(client, snap.clients, snap.monitors, snap.layers)) throw Error('window_required: list_windows and choose an allowed window_id');
    if (JSON.stringify(clientRect(client)) !== JSON.stringify(target.bounds)) throw Error('stale_observation: observe the target again');
    const issue = captureIssue(client, snap.clients, snap.monitors, snap.layers, this.ownedPid());
    if (requireVisible && issue) throw Error(issue);
    return { client, snap, monitor: monitorFor(client, snap.monitors), issue };
  }

  async movePointer(point, args) {
    if (!this.pointer?.available || !point) return;
    this.check(args);
    const result = await this.pointer.perform({ action: 'move', point }, this.abort?.signal);
    this.emitPointer(result?.pointer || point);
  }

  async clickAccessible(target, element, args, state) {
    await this.liveWindow(target,args);
    this.check(args); this.emitAction('click');
    state.inputStarted = true; state.receipt = {route:'atspi',dispatch_path:'semantic'};
    const receipt = await this.accessibility('click',target,element,undefined,[String(element.role || '')],state);
    this.check(args);
    if (receipt.dispatched === true) {
      state.receipt = {route:'atspi',dispatch_path:'semantic',action_name:receipt.action_name || 'click'};
      return null;
    }
    if (receipt.dispatched !== false || receipt.semantic_unavailable !== true || receipt.uncertain || receipt.error) throw Error('semantic_action_uncertain: do not retry through the pointer');
    state.inputStarted = false;
    if (!this.pointer?.available) throw Error('semantic_action_unavailable: use a screenshot coordinate when pointer control is available');
    const tree = await this.accessibility('observe',target);
    this.check(args);
    const current = tree.controls?.find(c=>c.path === element.path && c.label === element.label && c.role === element.role && !c.disabled && c.showing);
    if (!current) throw Error('stale_observation: the control changed before pointer fallback');
    const live = await this.liveWindow(target,args,{requireVisible:true});
    const point = accessibilityPoint(target,current,tree.window_bounds,live.monitor);
    if (!point) throw Error('coordinate_required: this control has no reliable accessibility bounds; observe an image and provide a window-relative coordinate');
    const [x,y,w,h] = target.bounds;
    state.receipt = {route:'pointer_fallback',dispatch_path:'coordinate'};
    return this.dispatchPointer(target,{action:'click',coord:[(point.x-x)/Math.max(1,w-1)*1000,(point.y-y)/Math.max(1,h-1)*1000],button:'left'},args,state);
  }

  async dispatchPointer(target, parsed, args, state) {
    const live = await this.liveWindow(target, args, { requireVisible: true });
    const fromCoord = parsed.from || parsed.coord;
    const toCoord = parsed.to || parsed.coord;
    const from = fromCoord ? windowPoint(live.client, fromCoord, live.monitor) : null;
    const point = toCoord ? windowPoint(live.client, toCoord, live.monitor) : null;
    if (!point) throw Error('invalid_coordinate: expected [x,y] normalized 0-1000 in the selected window');
    const owned = this.ownedPid();
    if (pointOnOwnedStop(live.snap.layers, live.snap.monitors, point.x, point.y, owned)
      || (from && pointOnOwnedStop(live.snap.layers, live.snap.monitors, from.x, from.y, owned))) {
      throw Error('coordinate_blocked: the Stop control covers this point');
    }
    this.check(args);
    this.emitAction(parsed.action);
    if (state) { state.inputStarted = true; state.receipt = {...state.receipt,route:state.receipt?.route || 'pointer',dispatch_path:'coordinate'}; }
    const result = await this.pointer.perform({
      action: parsed.action,
      point,
      from: parsed.action === 'drag' ? from : undefined,
      button: parsed.button,
      direction: parsed.direction,
      amount: parsed.amount,
      duration: pointerDurationMs(parsed.duration),
    }, this.abort?.signal);
    if (state) state.dispatched = true;
    this.emitPointer(result?.pointer || point, parsed.action === 'click' || parsed.action === 'double_click');
    return result?.pointer || point;
  }

  async batch(args) {
    if (this.paused) return this.pauseReceipt({ completed: 0, outcomes: [], stopped: true });
    this.check(args);
    const result = await runBatch(this, args);
    return this.paused ? this.pauseReceipt(result) : result;
  }

  async settleBatch(args) { await this.sleep(150); this.check(args); }

  async control(args, options = {}) {
    if (this.paused && !['status', 'desktop_context', 'list_windows', 'list_apps', 'list_workspaces', 'list_keybindings','list_layers'].includes(args.action)) return this.pauseReceipt({ dispatched: false });
    const observed = this.observation;
    const state = { inputStarted: false };
    try { return await this.performControl(args, options, state); }
    catch (error) {
      if (state.inputStarted) {
        if (this.observation === observed) this.observation = null;
        error.message += ': input may have partial effects; observe again and do not replay';
      }
      if (this.paused) return this.pauseReceipt({ ...state.receipt, dispatched: state.dispatched === true, input_may_have_partial_effects: state.inputStarted, task_success: false, uncertain: state.inputStarted });
      if (state.dispatched) return { ...state.receipt, dispatched: true, task_success: false, error: error.message, uncertain: true, retryable: false };
      throw error;
    }
  }

  async performControl(args, { deferObservation = false } = {}, state = {}) {
    if (args.action === 'status') return this.status();
    this.check(args, { allowPaused: ['desktop_context', 'list_windows', 'list_apps', 'list_workspaces', 'list_keybindings', 'list_layers'].includes(args.action) });
    if (args.action === 'list_layers') {const snap=await this.snapshot();this.check(args,{allowPaused:true});return {layers:this.layers.available(snap)};}
    if (args.surface === 'layer' && !['compositor_key','list_layers'].includes(args.action)) {
      if(args.action === 'describe')return this.layers.observe(args);
      if(args.action === 'wait'){await this.sleep(Math.min(3000,Math.max(0,Number(args.duration)*1000||500)));this.check(args);return this.layers.observe(args);}
      return this.layers.control(args,state);
    }
    if (args.action === 'list_windows') return { windows: await this.windows() };
    if (args.action === 'list_apps') return this.apps ? this.apps.list() : { apps: [], error: 'launcher_unavailable' };
    if (['desktop_context', 'list_workspaces', 'list_keybindings'].includes(args.action)) {
      if (!this.context) throw Error('desktop_context_unavailable');
      const context = await this.context.get();
      this.check(args, { allowPaused: true });
      return args.action === 'list_workspaces' ? { monitors: context.monitors, workspaces: context.workspaces, current_workspace: context.currentWorkspace }
        : args.action === 'list_keybindings' ? { keybindings: context.keybindings, key_route: 'Compositor virtual keyboard with standard evdev key codes; configured code: bindings are supported.' }
          : { ...context, control: this.status(), guidance: 'Choose the correct visible workspace on each monitor. Use close_window for graceful closing; do not guess an X or kill a process. Use configured keybindings, not assumed Alt+F4 or Super+Q.' };
    }
    if (args.action === 'switch_workspace') {
      if (!this.context) throw Error('desktop_context_unavailable');
      const context = await this.context.get();
      const space = this.workspaceDestination(args.workspace, context);
      if (!context.supported) throw Error(context.reason || 'desktop_context_unavailable');
      this.check(args);
      this.observation = null;this.emitAction('switch_workspace');
      state.inputStarted = true;
      const result = await this.runFile('hyprctl', ['dispatch', this.context.dispatchExpr(space)], { encoding: 'utf8', timeout: 3000, signal: this.abort?.signal });
      if (String(result.stdout || '').trim() !== 'ok') throw Error('workspace_dispatch_failed');
      state.dispatched = true; this.check(args);
      return { dispatched: true, desktop: await this.context.get() };
    }
    if (args.action === 'compositor_key' || args.action === 'key' && this.keyboard && this.context) {
      try { return await this.compositorKey(args,state); }
      catch(error) { if(args.action !== 'key' || !args.observation_id || !error.message.startsWith('configured_shortcut_required:'))throw error; }
    }
    if (args.action === 'current_target') return { window_id: this.observation?.window_id || null };
    if (args.action === 'describe') return this.observe(args);
    if (args.action === 'activate' || args.action === 'open_app') return this.select(args, state);
    if (args.action === 'wait') {
      let target;
      if (deferObservation) { target = await this.target(args.window_id, args); if (this.stale(this.observation, target, args)) throw Error('stale_observation'); await this.liveWindow(target, args); }
      await this.sleep(Math.min(3000, Math.max(0, Number(args.duration) * 1000 || 500)));
      this.check(args);
      if (deferObservation) { await this.liveWindow(target, args); return { dispatched: true }; }
      return this.observe(args);
    }
    const pointerWanted = wantsPointer(args);
    let parsed;
    if (pointerWanted) {
      if (!this.pointer?.available) throw Error('pointer_unsupported: native Linux control uses accessibility or targeted keys');
      parsed = parsePointerArgs(args);
    }
    const target = await this.target(args.window_id, args);
    const observation = this.observation;
    if (this.stale(observation, target, args)) throw Error('stale_observation: observe the target again');
    if(args.action==='move_window')return this.moveWindow(target,args,state);
    if (args.action === 'close_window') {
      await this.liveWindow(target, args);
      const expression = this.context?.closeWindowDispatch(target.window_id);
      if (!expression) throw Error('desktop_context_unavailable');
      this.check(args); state.inputStarted = true;
      const result = await this.runFile('hyprctl', ['dispatch', expression], { encoding: 'utf8', timeout: 3000, signal: this.abort?.signal });
      if (String(result.stdout || '').trim() !== 'ok') throw Error('window_close_failed');
      state.dispatched = true; this.observation = null; this.check(args);
      await this.sleep(150); this.check(args);
      const windows = await this.windows();
      return { dispatched: true, still_open: windows.some(window => window.window_id === target.window_id && window.pid === target.pid), windows,
        verification: 'Graceful close requested. A remaining window may contain an unsaved-work prompt. Observe it; do not kill its process.' };
    }
    if (deferObservation) await this.liveWindow(target, args, { requireVisible: !(['click','perform_action','focus','type'].includes(args.action) && !pointerWanted) });
    const selectedElement = elementNumber(observation, args);
    if (selectedElement && target.title !== observation.title) throw Error('stale_observation: accessible controls need a new observation after the window title changes');
    let pointer = null;
    const generation = this.generation;
    if (args.action === 'type' && !selectedElement) {
      await this.typeFocused(target, args, state);
    } else if (['type', 'click', 'focus', 'perform_action'].includes(args.action) && !pointerWanted) {
      let element = observation.controls[selectedElement - 1];
      if (!element || element.disabled) throw Error('element_required: use a numbered accessibility control');
      let text = args.text;
      if (args.action === 'type') {
        if (!element.editable || typeof text !== 'string' || text.length > 4096 || text.includes('\0')) throw Error('editable_control_required');
        if (deferObservation && args.replace_all !== true && args.replace_all !== 'true') {
          const tree = await this.accessibility('observe', target);
          const current = tree.controls?.find(c => c.path === element.path && c.label === element.label && c.editable && !c.disabled);
          if (!current) throw Error('stale_observation: the editable control changed');
          element = current;
        }
        if (args.replace_all !== true && args.replace_all !== 'true') text = (element.value || '') + text;
      }
      if (args.action === 'click') pointer = await this.clickAccessible(target,element,args,state);
      else if (args.action === 'perform_action') {
        if (typeof args.action_name !== 'string' || !args.action_name || args.action_name.length > 64 || args.action_name.includes('\0') || !Array.isArray(element.actions) || !element.actions.includes(args.action_name)) throw Error('action_name_required: choose an exact action from the observed control actions');
        await this.liveWindow(target,args);
        this.check(args); this.emitAction('click');
        state.inputStarted = true; state.receipt = {route:'atspi',dispatch_path:'semantic',action_name:args.action_name};
        const receipt = await this.accessibility('perform_action',target,element,undefined,[args.action_name,String(element.role || '')],state);
        if (receipt.dispatched !== true) throw Error('semantic_action_unavailable_or_uncertain: no pointer retry');
      } else {
        this.emitAction(args.action);
        state.inputStarted = true;
        await this.accessibility(args.action, target, element, text, [], state);
      }
    } else if (args.action === 'key') {
      const normalized = normalizeKey({ key: args.key, modifiers: args.modifiers || undefined });
      this.emitAction('key');
      if (this.keyboard) {
        const validate = await this.focusKeyboard(target, args);
        state.inputStarted = true;
        await this.keyboard.key(normalized.combo, { signal: this.abort?.signal, validateFocus: validate });
        state.dispatched = true;
        this.check(args);
        if (normalized.mods.includes('super') || normalized.mods.includes('alt') || [125,126,29,97,56,100,42,54].includes(normalized.linux.code)) {
          this.observation = null;
          return { dispatched: true, route: 'compositor_keyboard', windows: await this.windows(), verification: 'Keys reached the compositor. Check desktop_context and list_windows for actual effects; the previous observation is invalid.' };
        }
      } else await this.sendKey(target, normalized.hyprland.key, normalized.mods, args, state);
    } else if (args.action === 'scroll' && !pointerWanted) {
      const direction = args.scroll_direction || 'down';
      const amount = Math.min(100, Math.max(1, Number(args.scroll_amount) || 3));
      if (!['up', 'down', 'left', 'right'].includes(direction)) throw Error('invalid_scroll');
      const element = selectedElement ? observation.controls[selectedElement - 1] : observation.controls.find(c => c.scrollable) || { path: '', label: target.title };
      if (selectedElement && !element) throw Error('element_required: use a numbered accessibility control');
      this.emitAction('scroll');
      try { state.inputStarted = true; await this.accessibility('scroll', target, element, '', [direction, String(amount)], state); }
      catch (error) {
        if (error.message === 'session_required_or_stopped' || error.message === 'request_expired') throw error;
        if (!String(error.message).includes('scroll_unavailable') && !String(error.message).includes('action_unavailable')) throw error;
        const keys = { up: amount >= 3 ? 'Prior' : 'Up', down: amount >= 3 ? 'Next' : 'Down', left: 'Left', right: 'Right' };
        await this.sendKey(target, keys[direction], [], args, state);
      }
    } else if (pointerWanted) {
      pointer = await this.dispatchPointer(target, parsed, args, state);
    } else throw Error('action_unsupported: use accessibility controls or a targeted key');
    if (deferObservation) {
      try { if (generation !== this.generation) throw Error('session_required_or_stopped'); this.check(args); await this.sleep(30); this.check(args); }
      catch (error) { this.observation = null; return { dispatched: true, error: error.message, uncertain: true, retryable: false, ...(pointer ? { pointer } : {}) }; }
      return { dispatched: true, ...state.receipt, ...(pointer ? { pointer } : {}) };
    }
    if (generation !== this.generation) throw Error('session_required_or_stopped');
    this.check(args);
    this.observation = null;
    try {
      await this.sleep(150);
      const result = { dispatched: true, ...state.receipt, observation: await this.observe({ window_id: target.window_id, view:args.view, image:args.image, force_image:args.force_image, __deadline: args.__deadline }) };
      if (pointer) result.pointer = pointer;
      return result;
    } catch (error) {
      if (error.message === 'session_required_or_stopped') throw error;
      return { dispatched: true, ...state.receipt, outcome: 'unknown: input was sent, but the follow-up observation failed. Do not replay input.' };
    }
  }
}

module.exports = { NativeDesktop, luaString, shortcutCommand, captureIssue, clientRect, rectsOverlap, monitorLogicalSize, defaultRun, coveringLayers, pointOnOwnedStop, windowPoint, accessibilityPoint, pointerDurationMs };
