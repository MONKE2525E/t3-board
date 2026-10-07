const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { mkdirSync } = require('node:fs');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const {
  NativeDesktop, shortcutCommand, captureIssue, monitorLogicalSize, defaultRun, pointOnOwnedStop,
} = require('../src/native-desktop.cjs');

const HELPER = '/tmp/muse-port-d6c9/parity/native-desktop/muse-accessibility';
const OWNER_PATH = '/tmp/muse-port-d6c9/parity/native-fixture-owner.json';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const SOURCE = path.join(__dirname, '../native/accessibility.c');

function client(extra = {}) {
  return {
    address: '0xabc', mapped: true, hidden: false, at: [100, 100], size: [400, 300],
    workspace: { id: 9, name: '9' }, monitor: 0, class: 'gjs', title: 'Muse Native Test',
    pid: 2967311, floating: false, fullscreen: 0, focusHistoryID: 2, ...extra,
  };
}

function monitor(extra = {}) {
  return {
    id: 0, name: 'DP-1', x: 0, y: 0, width: 1920, height: 1080, scale: 1, transform: 0,
    activeWorkspace: { id: 9, name: '9' }, specialWorkspace: { id: 0, name: '' }, ...extra,
  };
}

function emptyLayers(name = 'DP-1') {
  return { [name]: { levels: { 0: [], 1: [], 2: [], 3: [] } } };
}

function controls() {
  return [
    { path: '', role: 'frame', label: 'Muse Native Test', value: '', editable: false, disabled: false, showing: true, actionable: false, scrollable: false },
    { path: '0:1', role: 'text', label: 'Test note', value: 'hello', editable: true, disabled: false, showing: true, actionable: true, scrollable: false },
    { path: '0:2', role: 'button', label: 'Save note', value: '', editable: false, disabled: false, showing: true, actionable: true, scrollable: false },
  ];
}

function compileHelper() {
  mkdirSync(path.dirname(HELPER), { recursive: true });
  const flags = execFileSync('pkg-config', ['--cflags', '--libs', 'atspi-2', 'gobject-2.0'], { encoding: 'utf8' }).trim().split(/\s+/);
  execFileSync('cc', ['-std=gnu11', '-O2', '-Wall', '-Wextra', '-Werror', SOURCE, '-o', HELPER, ...flags]);
}

function mockWorld({ clients, monitors, active, helper, grim, dispatch = 'ok', layers } = {}) {
  const calls = [];
  const runFile = async (command, args, options = {}) => {
    if (options.signal?.aborted) { const error = Error('aborted'); error.name = 'AbortError'; throw error; }
    calls.push({ command, args: [...args], input: options.input });
    if (command === 'hyprctl' && args[0] === '-j' && args[1] === 'clients') return { stdout: JSON.stringify(clients()) };
    if (command === 'hyprctl' && args[0] === '-j' && args[1] === 'monitors') return { stdout: JSON.stringify(monitors()) };
    if (command === 'hyprctl' && args[0] === '-j' && args[1] === 'layers') {
      if (layers === null) throw Error('layers unavailable');
      return { stdout: JSON.stringify(typeof layers === 'function' ? layers() : (layers || emptyLayers())) };
    }
    if (command === 'hyprctl' && args[0] === '-j' && args[1] === 'activewindow') return { stdout: JSON.stringify(active()) };
    if (command === 'hyprctl' && args[0] === 'dispatch') {
      if (typeof dispatch === 'function') return dispatch(args[1]);
      if (dispatch instanceof Error) throw dispatch;
      return { stdout: String(dispatch) };
    }
    if (command === 'grim') return grim ? grim(args, options) : { stdout: PNG };
    if (command === HELPER || command === 'helper') return helper(args, options);
    throw Error(`unexpected command ${command}`);
  };
  return { calls, runFile };
}

async function session(desktop) {
  return desktop.session({ action: 'start', task: 'native test', __deadline: Date.now() + 30000 });
}

function contextFixture(workspace=9,spaces=[workspace]) {
  const {DesktopContext}=require('../src/desktop-context.cjs');
  const context=new DesktopContext({runFile:async()=>{throw Error('unexpected context query');}});
  context.get=async()=>({supported:true,currentWorkspace:{id:workspace,name:String(workspace)},workspaces:spaces.map(id=>({id,name:String(id)}))});
  return context;
}

function desktopFor(t, world, extra = {}) {
  const desktop = new NativeDesktop({
    helper: extra.helper || HELPER,
    allowed: extra.allowed || (() => true),
    permission: extra.permission || (async () => true),
    blocked: () => extra.blocked || [],
    onChange: extra.onChange || (() => {}),
    runFile: world.runFile,
    pointer: extra.pointer || null,
    feedback: extra.feedback || null,
    keyboard: extra.keyboard || null,
    apps: extra.apps || null,
    activity: extra.activity || null,
    context: extra.context || null,
    decodeImage: extra.decodeImage || (()=>({width:1,height:1,pixels:Buffer.from([255,0,0,255])})),
  });
  t.after(() => desktop.stop());
  return desktop;
}

function mockPointer() {
  const calls = [];
  return {
    available: false,
    calls,
    async start() { this.available = true; },
    stop() { this.available = false; },
    async perform(req, signal) {
      if (signal?.aborted) { const error = Error('aborted'); error.name = 'AbortError'; throw error; }
      calls.push(req);
      return { dispatched: true, pointer: req.point };
    },
  };
}

function mockFeedback({ pid = 4242, failStart = false, hangStart = false } = {}) {
  const events = [];
  let started = false;
  return {
    get pid() { return started ? pid : null; },
    events,
    async start(task) {
      if (failStart) throw Error(typeof failStart === 'string' ? failStart : 'overlay_failed');
      if (hangStart) return new Promise(() => {});
      started = true;
      events.push(['start', task]);
    },
    action(label) { events.push(['action', label]); },
    pointer(point) { events.push(['pointer', point]); },
    stop() { started = false; events.push(['stop']); },
  };
}

function ownedLayers(pid, extra = []) {
  return {
    'DP-1': {
      levels: {
        2: [
          { x: 0, y: 0, w: 1920, h: 1080, alpha: 1, namespace: 'muse-control-overlay', pid },
          { x: 20, y: 8, w: 280, h: 36, alpha: 1, namespace: 'muse-control-stop', pid },
          ...extra,
        ],
      },
    },
  };
}

test('targeted shortcuts use a Hyprland mods string and window address', () => {
  assert.equal(shortcutCommand({ mods: [], key: 'Escape', windowId: '0xabc' }), 'hl.dsp.send_shortcut({mods="",key="Escape",window="address:0xabc"})');
  assert.equal(shortcutCommand({ mods: ['control', 'shift'], key: 'a', windowId: '0x1' }), 'hl.dsp.send_shortcut({mods="CTRL+SHIFT",key="a",window="address:0x1"})');
});

test('desktop batch keeps a guarded observation for a short sequence and observes once at the end', async t => {
  const fixture = client();
  const world = mockWorld({ clients: () => [fixture], monitors: () => [monitor()], active: () => ({ address: '0xuser' }), helper: args => ({ stdout: JSON.stringify(args[0]==='observe'?{ controls: controls(), truncated: false }:{dispatched:true,action_name:'click'}) }) });
  const desktop = desktopFor(t, world);
  await session(desktop);
  const observed = await desktop.observe({ window_id: '0xabc' });
  const before = world.calls.filter(c => c.args[0] === 'observe').length;
  const result = await desktop.batch({ window_id: '0xabc', observation_id: observed.observation_id, actions: JSON.stringify([{ action: 'click', element_number: '3' }, { action: 'key', key: 'tab' }]) });
  assert.equal(result.completed, 2);
  assert.equal(result.stopped, false);
  assert.equal(world.calls.filter(c => c.args[0] === 'observe').length - before, 1);
  assert.notEqual(result.observation.observation_id, observed.observation_id);
});

test('screenshots use logical monitor size, rotation, window occluders, and covering layers', () => {
  const target = client();
  const shown = [monitor()];
  const layers = emptyLayers();
  assert.equal(captureIssue(target, [target], shown, layers), null);
  assert.match(captureIssue(target, [target], [monitor({ activeWorkspace: { id: 2 } })], layers), /window_not_visible/);
  assert.match(captureIssue(client({ at: [-40, 100] }), [target], shown, layers), /not fully on an active monitor/);
  const overlay = client({ address: '0xoverlay', floating: true, focusHistoryID: 0, at: [120, 120], size: [200, 200] });
  assert.match(captureIssue(target, [target, overlay], shown, layers), /window_obscured/);
  const behind = client({ address: '0xback', floating: false, focusHistoryID: 8, at: [120, 120], size: [200, 200] });
  assert.equal(captureIssue(target, [target, behind], shown, layers), null);
  const scaled = monitor({ width: 2560, height: 1440, scale: 1.25, x: 0, y: 1080, name: 'DP-2' });
  assert.deepEqual(monitorLogicalSize(scaled), { x: 0, y: 1080, width: 2048, height: 1152 });
  const fullLogical = client({ at: [0, 1080], size: [2048, 1152], monitor: 0 });
  assert.equal(captureIssue(fullLogical, [fullLogical], [scaled], emptyLayers('DP-2')), null);
  assert.match(captureIssue(client({ at: [0, 1080], size: [2048, 1153], monitor: 0 }), [fullLogical], [scaled], emptyLayers('DP-2')), /not fully on an active monitor/);
  const rotated = monitor({ width: 1920, height: 1080, transform: 1, scale: 1 });
  assert.deepEqual(monitorLogicalSize(rotated), { x: 0, y: 0, width: 1080, height: 1920 });
  const bar = { DP1: null, 'DP-1': { levels: { 0: [{ x: 0, y: 0, w: 1920, h: 1080, alpha: 1, namespace: 'omarchy-background' }], 2: [{ x: 100, y: 100, w: 400, h: 24, alpha: 1, namespace: 'omarchy-bar' }] } } };
  assert.match(captureIssue(target, [target], shown, bar), /layer surface/);
  assert.equal(captureIssue(target, [target], shown, { 'DP-1': { levels: { 0: [{ x: 0, y: 0, w: 1920, h: 1080, alpha: 1, namespace: 'omarchy-background' }] } } }), null);
  assert.match(captureIssue(target, [target], shown, null), /layer surfaces could not be checked/);
  const owned = ownedLayers(4242);
  assert.match(captureIssue(target, [target], shown, owned), /layer surface/);
  assert.equal(captureIssue(target, [target], shown, owned, 4242), null);
  assert.match(captureIssue(target, [target], shown, owned, 99), /layer surface/);
  const spoofed = { 'DP-1': { levels: { 2: [{ x: 0, y: 0, w: 1920, h: 1080, alpha: 1, namespace: 'muse-control-overlay', pid: 7 }] } } };
  assert.match(captureIssue(target, [target], shown, spoofed, 4242), /layer surface/);
  assert.equal(pointOnOwnedStop(owned, shown, 40, 20, 4242), true);
  assert.equal(pointOnOwnedStop(owned, shown, 200, 200, 4242), false);
  assert.equal(pointOnOwnedStop(owned, shown, 40, 20, 99), false);
});

test('session, list_windows, activate, and observe keep a selected window without raising it', async t => {
  const fixture = client();
  const blocked = client({ address: '0xblock', class: 'secret-app', title: 'other' });
  const muse = client({ address: '0xmuse', class: 'muse-linux', title: 'Muse for Linux' });
  const packaged = client({ address: '0xpack', class: 'io.muse.linux', title: 'Muse' });
  const world = mockWorld({
    clients: () => [fixture, blocked, muse, packaged],
    monitors: () => [monitor({ activeWorkspace: { id: 2 } })],
    active: () => ({ address: '0xuser', class: 'keep-focus' }),
    helper: args => {
      assert.equal(args[0], 'observe');
      assert.equal(args[1], '2967311');
      assert.equal(args[2], 'Muse Native Test');
      assert.deepEqual(args.slice(3, 7), ['100', '100', '400', '300']);
      return { stdout: JSON.stringify({ controls: controls(), truncated: false }) };
    },
  });
  const desktop = desktopFor(t, world, { blocked: ['secret-app'] });
  const started = await session(desktop);
  assert.ok(started.session_id);
  assert.equal(started.windows.length, 1);
  assert.equal(started.windows[0].window_id, '0xabc');
  assert.equal(started.windows[0].visible, false);
  const listed = await desktop.control({ action: 'list_windows' });
  assert.equal(listed.windows.some(w => ['muse-linux', 'io.muse.linux', 'secret-app'].includes(w.app)), false);
  const selected = await desktop.control({ action: 'activate', window_id: '0xabc' });
  assert.equal(selected.window_id, '0xabc');
  assert.equal(selected.observation_id, desktop.observation.id);
  assert.equal(selected.accessibility_available, true);
  assert.equal((await desktop.control({ action: 'current_target' })).window_id, '0xabc');
  assert.equal(world.calls.some(c => c.command === 'hyprctl' && c.args[0] === 'dispatch'), false);
  assert.equal(world.calls.some(c => c.command === 'grim'), false);
});

test('open_app focuses an already-running window on the current workspace without launching a copy', async t => {
  const fixture = client();
  const world = mockWorld({
    clients: () => [fixture],
    monitors: () => [monitor()],
    active: () => ({ address: '0xuser' }),
    helper: () => ({ stdout: JSON.stringify({ controls: controls(), truncated: false }) }),
  });
  const desktop = desktopFor(t, world, {context:contextFixture()});
  await session(desktop);
  const selected = await desktop.control({ action: 'open_app', app: 'gjs' });
  assert.equal(selected.window_id, '0xabc');
  assert.equal(world.calls.some(c => c.command === 'gjs' || c.command === 'gtk-launch' || c.args?.[0] === 'gjs'), false);
  await assert.rejects(desktop.control({ action: 'open_app', app: 'not-installed-app' }), /app_not_running/);
  assert.equal(world.calls.some(c => c.command === 'not-installed-app'), false);
});

test('stale observation ids, stop, and request deadlines cancel work', async t => {
  const fixture = client();
  let clients = [fixture];
  let delay = false;
  const world = mockWorld({
    clients: () => clients,
    monitors: () => [monitor()],
    active: () => ({ address: '0xuser' }),
    helper: (_args, options) => new Promise((resolve, reject) => {
      const finish = () => resolve({ stdout: JSON.stringify({ controls: controls(), truncated: false }) });
      if (!delay) return finish();
      const timer = setTimeout(finish, 400);
      timer.unref?.();
      options.signal?.addEventListener('abort', () => { clearTimeout(timer); const error = Error('aborted'); error.name = 'AbortError'; reject(error); });
    }),
  });
  const desktop = desktopFor(t, world);
  await session(desktop);
  const observed = await desktop.observe({ window_id: '0xabc' });
  await assert.rejects(desktop.control({ action: 'click', observation_id: 'stale', element_number: 3, window_id: '0xabc' }), /stale_observation/);
  clients = [client({ title: 'renamed' })];
  await assert.rejects(desktop.control({ action: 'click', observation_id: observed.observation_id, element_number: 3, window_id: '0xabc' }), /stale_observation/);
  clients = [fixture];
  delay = true;
  const pending = desktop.observe({ window_id: '0xabc' });
  desktop.stop();
  await assert.rejects(pending, /session_required_or_stopped/);
  await assert.rejects(desktop.observe({ window_id: '0xabc' }), /session_required_or_stopped/);
  await session(desktop);
  await assert.rejects(desktop.observe({ window_id: '0xabc', __deadline: Date.now() - 1 }), /request_expired/);
});

test('region capture refuses inactive or obscured windows and revalidates after grim', async t => {
  const fixture = client();
  let monitors = [monitor({ activeWorkspace: { id: 2 } })];
  let clients = [fixture];
  let grimCalls = 0;
  const world = mockWorld({
    clients: () => clients,
    monitors: () => monitors,
    active: () => ({ address: '0xuser' }),
    helper: () => ({ stdout: JSON.stringify({ controls: controls(), truncated: false }) }),
    grim: args => {
      grimCalls++;
      assert.equal(args[1], '100,100 400x300');
      return { stdout: PNG };
    },
  });
  const desktop = desktopFor(t, world);
  await session(desktop);
  await desktop.observe({ window_id: '0xabc' });
  const unavailable=await desktop.observe({window_id:'0xabc',view:'image'});assert.equal(unavailable.capture_status,'unavailable');assert.match(unavailable.capture_error,/window_not_visible/);assert.equal(unavailable.unchanged,null);
  assert.equal(grimCalls, 0);
  monitors = [monitor()];
  clients = [fixture, client({ address: '0xfloat', floating: true, focusHistoryID: 0, at: [110, 110], size: [200, 200], class: 'other', title: 'overlay' })];
  assert.equal((await desktop.observe({window_id:'0xabc',image:true})).capture_status,'unavailable');
  assert.equal(grimCalls, 0);
  clients = [fixture];
  const ok = await desktop.observe({ window_id: '0xabc', image: true });
  assert.equal(ok.image_transfer.mime_type, 'image/png');
  assert.equal(grimCalls, 1);
  const moving = mockWorld({
    clients: () => clients,
    monitors: () => monitors,
    active: () => ({ address: '0xuser' }),
    helper: () => ({ stdout: JSON.stringify({ controls: controls(), truncated: false }) }),
    grim: () => {
      clients = [client({ at: [500, 500] })];
      return { stdout: PNG };
    },
  });
  const movingDesktop = desktopFor(t, moving);
  await session(movingDesktop);
  await assert.rejects(movingDesktop.observe({ window_id: '0xabc', image: true }), /window_moved/);
});

test('keys validate hyprctl ok, reject pointer claims, and scroll can use targeted keys', async t => {
  const fixture = client();
  const world = mockWorld({
    clients: () => [fixture],
    monitors: () => [monitor()],
    active: () => ({ address: '0xuser', class: 'keep-focus' }),
    helper: args => {
      if (args[0] === 'observe') return { stdout: JSON.stringify({ controls: controls(), truncated: false }) };
      if (args[0] === 'scroll') {
        assert.equal(args[7], '');
        assert.equal(args[8], 'Muse Native Test');
        assert.equal(args[9], 'down');
        const error = Error('fail'); error.stderr = 'scroll_unavailable'; throw error;
      }
      if (args[0] === 'type') { assert.equal(args[7], '0:1'); assert.equal(args[8], 'Test note'); return { stdout: JSON.stringify({ dispatched: true }) }; }
      return { stdout: JSON.stringify({ dispatched: true }) };
    },
    dispatch: expr => {
      assert.match(expr, /hl\.dsp\.send_shortcut\(\{mods="",key="Next",window="address:0xabc"\}\)/);
      return { stdout: 'ok' };
    },
  });
  const desktop = desktopFor(t, world);
  await session(desktop);
  const observed = await desktop.observe({ window_id: '0xabc' });
  await assert.rejects(desktop.control({ action: 'click', coordinate: [10, 10], observation_id: observed.observation_id, window_id: '0xabc' }), /pointer_unsupported/);
  const typed = await desktop.control({ action: 'type', observation_id: observed.observation_id, window_id: '0xabc', element_number: 2, text: '!', replace_all: true });
  assert.equal(typed.dispatched, true);
  const afterType = typed.observation;
  const scrolled = await desktop.control({ action: 'scroll', observation_id: afterType.observation_id, window_id: '0xabc', scroll_direction: 'down' });
  assert.equal(scrolled.dispatched, true);
  const failedKeys = mockWorld({
    clients: () => [fixture],
    monitors: () => [monitor()],
    active: () => ({ address: '0xuser' }),
    helper: () => ({ stdout: JSON.stringify({ controls: controls(), truncated: false }) }),
    dispatch: () => ({ stdout: 'error: window not found' }),
  });
  const failing = desktopFor(t, failedKeys);
  await session(failing);
  const again = await failing.observe({ window_id: '0xabc' });
  await assert.rejects(failing.control({ action: 'key', observation_id: again.observation_id, window_id: '0xabc', key: 'escape' }), /key_dispatch_failed/);
});

test('helper stdin closing early preserves its exit result without an unhandled pipe error', async () => {
  await assert.rejects(defaultRun(process.execPath, ['-e', 'process.exit(7)'], {
    input: 'x'.repeat(1024 * 1024), encoding: 'utf8', timeout: 3000,
  }), error => error.code === 7);
});

test('live GTK fixture: activate, targeted BackSpace, screenshot bounds, and no focus steal', { timeout: 25000 }, async t => {
  compileHelper();
  let owner;
  try { owner = JSON.parse(await fs.readFile(OWNER_PATH, 'utf8')); }
  catch { t.skip('owned native fixture owner record is missing'); return; }
  const clients = JSON.parse((await defaultRun('hyprctl', ['-j', 'clients'], { encoding: 'utf8' })).stdout);
  const fixture = clients.find(c => c.address === owner.address && c.pid === owner.pid && c.class === 'gjs' && c.title === 'Muse Native Test');
  if (!fixture || fixture.pid !== 2967311) { t.skip('owned native GTK fixture is not present'); return; }
  const beforeFocus = JSON.parse((await defaultRun('hyprctl', ['-j', 'activewindow'], { encoding: 'utf8' })).stdout);
  const beforeWorkspace = JSON.parse((await defaultRun('hyprctl', ['-j', 'activeworkspace'], { encoding: 'utf8' })).stdout);
  const calls = [];
  const runFile = async (command, args, options) => {
    calls.push({ command, args: [...args] });
    return defaultRun(command, args, options);
  };
  const desktop = new NativeDesktop({ helper: HELPER, allowed: () => true, permission: async () => true, blocked: () => [], onChange: () => {}, runFile });
  t.after(() => desktop.stop());
  await session(desktop);
  const listed = await desktop.control({ action: 'list_windows' });
  assert.equal(listed.windows.some(w => w.window_id === owner.address), true);
  assert.equal(listed.windows.some(w => w.app === 'muse-linux' || w.app === 'io.muse.linux'), false);
  const selected = await desktop.control({ action: 'activate', window_id: owner.address });
  assert.equal(selected.window_id, owner.address);
  assert.equal(selected.accessibility_available, true);
  const note = selected.controls.find(c => c.label === 'Test note' && c.editable);
  assert.ok(note);
  const original = note.value || 'Native Linux control works';
  const marker = `keyprobe-${Date.now()}X`;
  const typed = await desktop.control({ action: 'type', observation_id: selected.observation_id, window_id: owner.address, element_number: note.element_number, text: marker, replace_all: true });
  const keyed = await desktop.control({ action: 'key', observation_id: typed.observation.observation_id, window_id: owner.address, key: 'backspace' });
  assert.equal(keyed.dispatched, true);
  const dispatch = calls.find(c => c.command === 'hyprctl' && c.args[0] === 'dispatch');
  assert.match(String(dispatch?.args[1] || ''), new RegExp(`hl\\.dsp\\.send_shortcut\\(\\{mods="",key="BackSpace",window="address:${owner.address}"\\}\\)`));
  const afterKey = keyed.observation.controls.find(c => c.label === 'Test note');
  assert.equal(afterKey.value, marker.slice(0, -1));
  const restored = await desktop.control({ action: 'type', observation_id: keyed.observation.observation_id, window_id: owner.address, element_number: keyed.observation.controls.find(c => c.label === 'Test note').element_number, text: original, replace_all: true });
  assert.equal(restored.dispatched, true);
  await assert.rejects(desktop.control({ action: 'key', observation_id: selected.observation_id, window_id: owner.address, key: 'escape' }), /stale_observation/);
  const grimBefore = calls.filter(c => c.command === 'grim').length;
  const listedFixture = (await desktop.control({ action: 'list_windows' })).windows.find(w => w.window_id === owner.address);
  if (!listedFixture?.visible) {
    await assert.rejects(desktop.observe({ window_id: owner.address, image: true }), /window_not_visible|window_obscured|not fully on an active monitor/);
    assert.equal(calls.filter(c => c.command === 'grim').length, grimBefore);
  } else {
    const shot = await desktop.observe({ window_id: owner.address, image: true });
    assert.equal(shot.image_transfer.mime_type, 'image/png');
    assert.ok(shot.image_transfer.data_base64.length > 20);
  }
  desktop.stop();
  await assert.rejects(desktop.observe({ window_id: owner.address }), /session_required_or_stopped/);
  const afterFocus = JSON.parse((await defaultRun('hyprctl', ['-j', 'activewindow'], { encoding: 'utf8' })).stdout);
  const afterWorkspace = JSON.parse((await defaultRun('hyprctl', ['-j', 'activeworkspace'], { encoding: 'utf8' })).stdout);
  assert.equal(afterFocus.address, beforeFocus.address);
  assert.equal(afterWorkspace.id, beforeWorkspace.id);
  const still = JSON.parse((await defaultRun('hyprctl', ['-j', 'clients'], { encoding: 'utf8' })).stdout).find(c => c.address === owner.address);
  assert.equal(still?.pid, owner.pid);
  assert.equal(calls.some(c => c.command === 'hyprctl' && String(c.args[1] || '').includes('focus')), false);
  assert.equal(calls.some(c => c.command === 'hyprctl' && String(c.args[1] || '').includes('window.raise')), false);
});

test('pointer session starts feedback after permission and advertises window-local coordinates', async t => {
  const fixture = client({ floating: true });
  const pointer = mockPointer();
  const feedback = mockFeedback();
  const world = mockWorld({
    clients: () => [fixture],
    monitors: () => [monitor()],
    active: () => ({ address: '0xuser' }),
    helper: () => ({ stdout: JSON.stringify({ controls: controls(), truncated: false }) }),
  });
  const desktop = desktopFor(t, world, { pointer, feedback });
  const started = await session(desktop);
  assert.equal(pointer.available, true);
  assert.equal(started.capabilities.pointer, true);
  assert.deepEqual(started.capabilities.pointer_actions, ['move', 'click', 'double_click', 'drag', 'scroll']);
  assert.equal(started.user_can_see_preview, true);
  assert.equal(feedback.events.some(event => event[0] === 'start' && event[1] === 'native test'), true);
  const observed = await desktop.observe({ window_id: '0xabc' });
  assert.equal(observed.coordinate_system.max, 1000);
  assert.equal(observed.coordinate_system.space, 'selected_window');
  assert.equal(JSON.stringify(feedback.events).includes('Muse Native Test'), false);
});

test('pointer input rejects invalid, stale, hidden, blocked and occluded targets before perform', async t => {
  const fixture = client({ floating: true });
  let clients = [fixture];
  let monitors = [monitor()];
  const pointer = mockPointer();
  const world = mockWorld({
    clients: () => clients,
    monitors: () => monitors,
    active: () => ({ address: '0xuser' }),
    helper: () => ({ stdout: JSON.stringify({ controls: controls(), truncated: false }) }),
  });
  const desktop = desktopFor(t, world, { pointer, feedback: mockFeedback() });
  await session(desktop);
  const observed = await desktop.observe({ window_id: '0xabc' });
  const base = { observation_id: observed.observation_id, window_id: '0xabc' };
  await assert.rejects(desktop.control({ action: 'click', coordinate: [-1, 0], ...base }), /invalid_coordinate/);
  await assert.rejects(desktop.control({ action: 'click', coordinate: [1001, 10], ...base }), /invalid_coordinate/);
  await assert.rejects(desktop.control({ action: 'click', coordinate: 'nope', ...base }), /invalid_coordinate/);
  await assert.rejects(desktop.control({ action: 'drag', coordinate: [10, 10], ...base }), /invalid_end_coordinate/);
  assert.equal(pointer.calls.length, 0);
  await assert.rejects(desktop.control({ action: 'click', coordinate: [10, 10], observation_id: 'stale', window_id: '0xabc' }), /stale_observation/);
  monitors = [monitor({ activeWorkspace: { id: 2 } })];
  await assert.rejects(desktop.control({ action: 'click', coordinate: [10, 10], ...base }), /window_not_visible/);
  monitors = [monitor()];
  clients = [fixture, client({ address: '0xfloat', floating: true, focusHistoryID: 0, at: [110, 110], size: [200, 200], class: 'other', title: 'overlay' })];
  await assert.rejects(desktop.control({ action: 'click', coordinate: [10, 10], ...base }), /window_obscured/);
  assert.equal(pointer.calls.length, 0);
  const blockedWorld = mockWorld({
    clients: () => [client({ class: 'secret-app' })],
    monitors: () => [monitor()],
    active: () => ({ address: '0xuser' }),
    helper: () => ({ stdout: JSON.stringify({ controls: controls(), truncated: false }) }),
  });
  const blocked = desktopFor(t, blockedWorld, { pointer: mockPointer(), feedback: mockFeedback(), blocked: ['secret-app'] });
  await session(blocked);
  await assert.rejects(blocked.control({ action: 'click', coordinate: [10, 10], observation_id: 'x', window_id: '0xabc' }), /window_required/);
});

test('floating windows map pointer locals to the output, not the window, including scaled and negative origins', async t => {
  const pointer = mockPointer();
  const dp2 = monitor({ id: 1, name: 'DP-2', width: 2560, height: 1440, scale: 1.25, x: 0, y: 1080 });
  const floating = client({ at: [200, 1200], size: [400, 300], monitor: 1, floating: true });
  const world = mockWorld({
    clients: () => [floating],
    monitors: () => [dp2],
    active: () => ({ address: '0xuser' }),
    helper: () => ({ stdout: JSON.stringify({ controls: controls(), truncated: false }) }),
    layers: emptyLayers('DP-2'),
  });
  const desktop = desktopFor(t, world, { pointer, feedback: mockFeedback() });
  await session(desktop);
  const observed = await desktop.observe({ window_id: '0xabc' });
  await desktop.control({ action: 'click', coordinate: [0, 0], observation_id: observed.observation_id, window_id: '0xabc' });
  assert.deepEqual(pointer.calls.at(-1).point, { x: 200, y: 1200, localX: 200, localY: 120, width: 2048, height: 1152, output: 'DP-2' });
  const after = await desktop.observe({ window_id: '0xabc' });
  await desktop.control({ action: 'move', coordinate: '[1000,1000]', observation_id: after.observation_id, window_id: '0xabc' });
  assert.deepEqual(pointer.calls.at(-1).point, { x: 599, y: 1499, localX: 599, localY: 419, width: 2048, height: 1152, output: 'DP-2' });

  const left = monitor({ name: 'HDMI-A-1', x: -1920, y: 0, width: 1920, height: 1080 });
  const floated = client({ at: [-1600, 80], size: [400, 300], floating: true });
  const leftPointer = mockPointer();
  const leftWorld = mockWorld({
    clients: () => [floated],
    monitors: () => [left],
    active: () => ({ address: '0xuser' }),
    helper: () => ({ stdout: JSON.stringify({ controls: controls(), truncated: false }) }),
    layers: emptyLayers('HDMI-A-1'),
  });
  const leftDesktop = desktopFor(t, leftWorld, { pointer: leftPointer, feedback: mockFeedback() });
  await session(leftDesktop);
  const leftObserved = await leftDesktop.observe({ window_id: '0xabc' });
  await leftDesktop.control({ action: 'click', coordinate: [0, 0], observation_id: leftObserved.observation_id, window_id: '0xabc' });
  assert.deepEqual(leftPointer.calls.at(-1).point, { x: -1600, y: 80, localX: 320, localY: 80, width: 1920, height: 1080, output: 'HDMI-A-1' });
});

test('owned Stop badge blocks only its rectangle; the rest of a maximized window stays clickable', async t => {
  const pointer = mockPointer();
  const feedback = mockFeedback({ pid: 4242 });
  const maximized = client({ at: [0, 0], size: [1920, 1080] });
  const world = mockWorld({
    clients: () => [maximized],
    monitors: () => [monitor()],
    active: () => ({ address: '0xuser' }),
    helper: () => ({ stdout: JSON.stringify({ controls: controls(), truncated: false }) }),
    layers: ownedLayers(4242),
  });
  const desktop = desktopFor(t, world, { pointer, feedback });
  await session(desktop);
  const listed = await desktop.control({ action: 'list_windows' });
  assert.equal(listed.windows[0].visible, true);
  const observed = await desktop.observe({ window_id: '0xabc', image: true });
  assert.equal(observed.image_transfer.mime_type, 'image/png');
  await assert.rejects(desktop.control({
    action: 'click', coordinate: [40 / 1919 * 1000, 20 / 1079 * 1000], observation_id: observed.observation_id, window_id: '0xabc',
  }), /coordinate_blocked/);
  assert.equal(pointer.calls.length, 0);
  const again = await desktop.observe({ window_id: '0xabc' });
  await desktop.control({ action: 'click', coordinate: [500, 500], observation_id: again.observation_id, window_id: '0xabc', button: 'right' });
  assert.equal(pointer.calls.at(-1).action, 'click');
  assert.equal(pointer.calls.at(-1).button, 'right');
  assert.equal(pointer.calls.at(-1).point.x, 960);
  assert.equal(pointer.calls.at(-1).point.y, 540);
  assert.equal(pointer.calls.at(-1).point.localX, 960);
  assert.equal(pointer.calls.at(-1).point.width, 1920);
});

test('drag duration seconds become 80-400ms and double-click uses the pointer', async t => {
  const pointer = mockPointer();
  const fixture = client({ floating: true, at: [240, 180], size: [400, 300] });
  const world = mockWorld({
    clients: () => [fixture],
    monitors: () => [monitor()],
    active: () => ({ address: '0xuser' }),
    helper: () => ({ stdout: JSON.stringify({ controls: controls(), truncated: false }) }),
  });
  const desktop = desktopFor(t, world, { pointer, feedback: mockFeedback() });
  await session(desktop);
  let observed = await desktop.observe({ window_id: '0xabc' });
  await desktop.control({
    action: 'drag', coordinate: [0, 0], end_coordinate: [1000, 1000], duration: 0.2,
    observation_id: observed.observation_id, window_id: '0xabc',
  });
  assert.equal(pointer.calls.at(-1).action, 'drag');
  assert.equal(pointer.calls.at(-1).duration, 200);
  assert.deepEqual(pointer.calls.at(-1).from, { x: 240, y: 180, localX: 240, localY: 180, width: 1920, height: 1080, output: 'DP-1' });
  assert.deepEqual(pointer.calls.at(-1).point, { x: 639, y: 479, localX: 639, localY: 479, width: 1920, height: 1080, output: 'DP-1' });
  observed = await desktop.observe({ window_id: '0xabc' });
  await desktop.control({ action: 'drag', coordinate: [10, 10], end_coordinate: [20, 20], duration: 1, observation_id: observed.observation_id, window_id: '0xabc' });
  assert.equal(pointer.calls.at(-1).duration, 400);
  observed = await desktop.observe({ window_id: '0xabc' });
  await desktop.control({ action: 'drag', coordinate: [10, 10], end_coordinate: [20, 20], duration: 0.01, observation_id: observed.observation_id, window_id: '0xabc' });
  assert.equal(pointer.calls.at(-1).duration, 80);
  observed = await desktop.observe({ window_id: '0xabc' });
  await desktop.control({ action: 'double_click', coordinate: [250, 250], observation_id: observed.observation_id, window_id: '0xabc' });
  assert.equal(pointer.calls.at(-1).action, 'double_click');
});

test('stop during pointer or feedback load refuses the session', async t => {
  const fixture = client();
  const world = mockWorld({
    clients: () => [fixture],
    monitors: () => [monitor()],
    active: () => ({ address: '0xuser' }),
    helper: () => ({ stdout: JSON.stringify({ controls: controls(), truncated: false }) }),
  });
  const hanging = {
    available: false,
    async start() { return new Promise(resolve => { this.release = () => { this.available = true; resolve(); }; }); },
    stop() { this.available = false; this.release = null; },
    async perform() { return { dispatched: true }; },
  };
  const desktop = desktopFor(t, world, { pointer: hanging, feedback: mockFeedback() });
  const pending = session(desktop);
  for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve));
  desktop.stop();
  hanging.release?.();
  await assert.rejects(pending, /session_required_or_stopped/);
  assert.equal(desktop.sessionId, null);

  const failing = mockFeedback({ failStart: true });
  const failed = desktopFor(t, world, { pointer: mockPointer(), feedback: failing });
  await assert.rejects(session(failed), /feedback_unavailable/);
  assert.equal(failed.sessionId, null);
  assert.equal(failing.events.some(event => event[0] === 'stop'), true);
});

test('semantic click avoids pointer motion and supports off-workspace windows', async t => {
  const pointer = mockPointer();
  const feedback = mockFeedback();
  const fixture = client({ floating: true, at: [240, 180], size: [400, 300] });
  const withBounds = [
    ...controls().slice(0, 2),
    { path: '0:2', role: 'button', label: 'Save note', value: '', editable: false, disabled: false, showing: true, actionable: true, scrollable: false, bounds: [20, 40, 80, 20] },
  ];
  let monitors = [monitor()];
  const world = mockWorld({
    clients: () => [fixture],
    monitors: () => monitors,
    active: () => ({ address: '0xuser' }),
    helper: args => {
      if (args[0] === 'observe') return { stdout: JSON.stringify({ controls: withBounds, truncated: false }) };
      return { stdout: JSON.stringify({ dispatched: true }) };
    },
  });
  const desktop = desktopFor(t, world, { pointer, feedback });
  await session(desktop);
  const observed = await desktop.observe({ window_id: '0xabc' });
  const clicked = await desktop.control({ action: 'click', observation_id: observed.observation_id, window_id: '0xabc', element_number: 3 });
  assert.equal(clicked.dispatched, true);
  assert.equal(pointer.calls.length, 0);
  assert.equal(clicked.route, 'atspi');
  assert.equal(feedback.events.some(event => event[0] === 'action' && event[1] === 'Clicking'), true);

  monitors = [monitor({ activeWorkspace: { id: 2 } })];
  const hiddenPointer = mockPointer();
  const hiddenWorld = mockWorld({
    clients: () => [fixture],
    monitors: () => monitors,
    active: () => ({ address: '0xuser' }),
    helper: args => {
      if (args[0] === 'observe') return { stdout: JSON.stringify({ controls: withBounds, truncated: false }) };
      return { stdout: JSON.stringify({ dispatched: true }) };
    },
  });
  const hidden = desktopFor(t, hiddenWorld, { pointer: hiddenPointer, feedback: mockFeedback() });
  await session(hidden);
  const hiddenObserved = await hidden.observe({ window_id: '0xabc' });
  const result=await hidden.control({action:'click',observation_id:hiddenObserved.observation_id,window_id:'0xabc',element_number:3});assert.equal(result.dispatch_path,'semantic');
  assert.equal(hiddenPointer.calls.length, 0);
});

test('focused Unicode typing verifies visible selected PID and focus before keyboard input', async t => {
  const c=client();const typed=[];
  const world=mockWorld({clients:()=>[c],monitors:()=>[monitor()],active:()=>c,helper:async()=>({stdout:JSON.stringify({controls:[]})})});
  const keyboard={stop(){},async type(text,signal){assert.equal(await this.validateFocus(),true);assert.equal(signal.aborted,false);typed.push(text);},async key(key){assert.equal(await this.validateFocus(),true);typed.push(key);}};
  const d=desktopFor(t,world,{keyboard});await session(d);const o=await d.observe({window_id:c.address});
  const result=await d.control({action:'type',window_id:c.address,observation_id:o.observation_id,text:'hello café 日本語',replace_all:'true'});
  assert.deepEqual(typed,['Ctrl+A','hello café 日本語']);assert.equal(result.dispatched,true);assert.equal(keyboard.validateFocus,null);
  assert.ok(world.calls.some(c=>c.command==='hyprctl'&&c.args[1]?.startsWith('hl.dsp.focus(')));
});

test('focused text refuses wrong focus and invisible targets before sending text', async t => {
  const c=client();let active={...c,address:'0xother'};let typed=0;
  const world=mockWorld({clients:()=>[c],monitors:()=>[monitor()],active:()=>active,helper:async()=>({stdout:JSON.stringify({controls:[]})})});
  const d=desktopFor(t,world,{keyboard:{stop(){},async type(){typed++;}}});await session(d);let o=await d.observe({window_id:c.address});
  await assert.rejects(d.control({action:'type',observation_id:o.observation_id,text:'refused'}),/focus_lost/);
  active=c;c.workspace.id=3;o=await d.observe({window_id:c.address});
  await assert.rejects(d.control({action:'type',observation_id:o.observation_id,text:'refused'}),/window_not_visible/);assert.equal(typed,0);
});

test('open_app launches an exact installed entry without claiming a ready window', async t => {
  let launches=0;const world=mockWorld({clients:()=>[],monitors:()=>[monitor()],active:()=>({})});
  const apps={stop(){},list(){return {apps:[{id:'fixture.desktop',name:'Fixture'}]};},match(name){assert.equal(name,'Fixture');return {id:'fixture.desktop',name:'Fixture'};},async launch(args){assert.equal(args.id,'fixture.desktop');assert.equal(args.workspace,9);launches++;return {dispatched:true,id:args.id};}};
  const d=desktopFor(t,world,{apps,context:contextFixture()});await session(d);assert.equal((await d.control({action:'list_apps'})).apps.length,1);
  const result=await d.control({action:'open_app',app:'Fixture'});assert.equal(launches,1);assert.equal(result.dispatched,true);assert.deepEqual(result.windows,[]);assert.match(result.verification,/Select the actual/);
});

test('move_window creates an empty numeric workspace, preserves selection identity and invalidates input',async t=>{
  const c=client(),context=contextFixture();
  const world=mockWorld({clients:()=>[c],monitors:()=>[monitor()],active:()=>c,helper:()=>({stdout:JSON.stringify({controls:controls()})}),dispatch:expr=>{
    assert.match(expr,/^hl\.dsp\.window\.move\(/);assert.match(expr,/workspace=3/);assert.match(expr,/follow=false/);assert.match(expr,/address:0xabc/);
    c.workspace={id:3,name:'3'};return{stdout:'ok'};
  }});
  const d=desktopFor(t,world,{context});await session(d);const o=await d.observe({window_id:c.address});
  await assert.rejects(d.control({action:'move_window',window_id:c.address,observation_id:'stale',workspace:'3'}),/stale_observation/);
  await assert.rejects(d.control({action:'move_window',window_id:c.address,observation_id:o.observation_id,workspace:'3;bad'}),/invalid_workspace|workspace_not_found/);
  const moved=await d.control({action:'move_window',window_id:c.address,observation_id:o.observation_id,workspace:'3'});
  assert.equal(moved.dispatched,true);assert.equal(moved.moved,true);assert.equal(moved.follow,false);assert.equal(d.observation,null);assert.equal(moved.windows[0].visible,false);
  await assert.rejects(d.control({action:'key',key:'Enter',window_id:c.address,observation_id:o.observation_id}),/stale_observation/);
});

test('open_app brings an existing window to the current workspace without launching a duplicate',async t=>{
  const c=client({workspace:{id:1,name:'1'}}),context=contextFixture(9,[1,9]);let launches=0;
  const apps={stop(){},match:()=>({id:'fixture.desktop',startupWmClass:'gjs'}),launch:async()=>{launches++;}};
  const world=mockWorld({clients:()=>[c],monitors:()=>[monitor()],active:()=>c,helper:()=>({stdout:JSON.stringify({controls:controls()})}),dispatch:expr=>{
    if(expr.startsWith('hl.dsp.window.move'))c.workspace={id:9,name:'9'};
    return{stdout:'ok'};
  }});
  const d=desktopFor(t,world,{context,apps});await session(d);
  const result=await d.control({action:'open_app',app:'fixture.desktop'});
  assert.equal(launches,0);assert.equal(result.workspace,9);assert.equal(result.visible,true);
  assert.equal(world.calls.filter(call=>call.args[0]==='dispatch'&&call.args[1].startsWith('hl.dsp.window.move')).length,1);
});

test('batch stops after target geometry changes and never sends the later key', async t => {
  const c=client();let keys=0;const world=mockWorld({clients:()=>[c],monitors:()=>[monitor()],active:()=>c,helper:async()=>({stdout:JSON.stringify({controls:controls()})}),dispatch:()=>{keys++;c.at=[150,100];return {stdout:'ok'};}});
  const d=desktopFor(t,world);await session(d);const o=await d.observe({window_id:c.address});const result=await d.batch({window_id:c.address,observation_id:o.observation_id,actions:[{action:'key',key:'Tab'},{action:'key',key:'Enter'}]});
  assert.equal(keys,1);assert.equal(result.completed,1);assert.match(result.error,/stale_observation/);assert.equal(result.retryable,false);
});

test('supplementary text is refused before focus, selection or partial typing in native fallback', async t => {
  const c=client();let sends=0;const world=mockWorld({clients:()=>[c],monitors:()=>[monitor()],active:()=>c,helper:async()=>({stdout:JSON.stringify({controls:[]})})});
  const d=desktopFor(t,world,{keyboard:{stop(){},async key(){sends++;},async type(){sends++;}}});await session(d);const o=await d.observe({window_id:c.address});const before=world.calls.filter(c=>c.args[0]==='dispatch').length;
  await assert.rejects(d.control({action:'type',observation_id:o.observation_id,text:'prefix 🐒',replace_all:'true',coordinate:[500,500]}),/native_text_unsupported/);assert.equal(sends,0);assert.equal(world.calls.filter(c=>c.args[0]==='dispatch').length,before);
});

test('desktop ids and StartupWMClass find existing windows and ambiguity never launches another copy', async t => {
  const clients=[client({class:'custom-app',address:'0x1'}),client({class:'custom-app',address:'0x2'})];let launches=0;
  const world=mockWorld({clients:()=>clients,monitors:()=>[monitor()],active:()=>clients[0],helper:async()=>({stdout:JSON.stringify({controls:[]})})});
  const apps={stop(){},match(){return {id:'example.desktop',name:'Example',startupWmClass:'custom-app'};},async launch(){launches++;}};
  const d=desktopFor(t,world,{apps,context:contextFixture()});await session(d);await assert.rejects(d.control({action:'open_app',app:'example.desktop'}),/app_ambiguous/);
  const r=await d.control({action:'open_app',app:'example.desktop',window_id:'0x2'});assert.equal(r.window_id,'0x2');assert.equal(launches,0);
});

test('native keyboard survives a document title change, but partial typing invalidates its observation', async t => {
  const c=client();let failed=false;
  const world=mockWorld({clients:()=>[c],monitors:()=>[monitor()],active:()=>c,helper:async()=>({stdout:JSON.stringify({controls:[]})})});
  const keyboard={stop(){},async type(){c.title='New document title';assert.equal(await this.validateFocus(),true);if(failed)throw Error('focus_lost');}};
  const d=desktopFor(t,world,{keyboard});await session(d);let o=await d.observe({window_id:c.address});
  assert.equal((await d.control({action:'type',observation_id:o.observation_id,text:'first'})).dispatched,true);
  o=await d.observe({window_id:c.address});failed=true;await assert.rejects(d.control({action:'type',observation_id:o.observation_id,text:'second'}),/do not replay/);assert.equal(d.observation,null);
});

test('Stop after acknowledged dispatch remains in batch progress and prevents the next step', async t => {
  const c=client();let d,keys=0;
  const world=mockWorld({clients:()=>[c],monitors:()=>[monitor()],active:()=>c,helper:async()=>({stdout:JSON.stringify({controls:controls()})}),dispatch:()=>{keys++;queueMicrotask(()=>d.stop());return {stdout:'ok'};}});
  d=desktopFor(t,world);await session(d);const o=await d.observe({window_id:c.address});const r=await d.batch({observation_id:o.observation_id,actions:[{action:'key',key:'Tab'},{action:'key',key:'Enter'}]});
  assert.equal(keys,1);assert.equal(r.completed,1);assert.equal(r.outcomes[0].dispatched,true);assert.equal(r.stopped,true);assert.equal(r.retryable,false);assert.equal(d.observation,null);
});

test('session-scoped indicators tolerate absent PID metadata but never exempt a foreign layer', () => {
  const target=client(),shown=[monitor()],key='a'.repeat(32);
  const owner={pid:4242,namespaces:{glow:'muse-control-overlay-'+key,stop:'muse-control-stop-'+key}};
  const glow={x:0,y:0,w:1920,h:1080,namespace:owner.namespaces.glow};
  const stop={x:20,y:10,w:392,h:64,namespace:owner.namespaces.stop};
  const layers={'DP-1':{levels:{2:[glow],3:[stop]}}};
  assert.equal(captureIssue(target,[target],shown,layers,owner),null);
  assert.equal(pointOnOwnedStop(layers,shown,40,20,owner),true);
  assert.match(captureIssue(target,[target],shown,{'DP-1':{levels:{2:[{...glow,pid:7}]}}},owner),/pid 7/);
  assert.match(captureIssue(target,[target],shown,{'DP-1':{levels:{2:[{...glow,namespace:'muse-control-overlay-'+'b'.repeat(32)}]}}},owner),/layer surface/);
  assert.match(captureIssue(target,[target],shown,{'DP-1':{levels:{2:[{...glow,namespace:'muse-control-overlay'}]}}},owner),/layer surface/);
  assert.match(captureIssue(target,[target],shown,layers),/layer surface/);
});

test('Stop after app launch keeps the launch receipt and forbids replay', async t => {
  const c=client();const world=mockWorld({clients:()=>[c],monitors:()=>[monitor()],active:()=>c});
  const d=desktopFor(t,world);let launches=0;
  d.apps={match:()=>({id:'new.desktop',name:'New app'}),launch:async()=>{launches++;d.stop();return {dispatched:true,id:'new.desktop',name:'New app'};},stop(){}};
  d.context=contextFixture();
  await session(d);
  const result=await d.control({action:'open_app',app:'new.desktop'});
  assert.equal(launches,1);assert.equal(result.id,'new.desktop');assert.equal(result.dispatched,true);assert.equal(result.retryable,false);assert.match(result.error,/do not replay/);assert.equal(d.observation,null);
});

test('physical takeover cancels a batch, reports partial progress, and requires a user resume', async t => {
  const c = client(), m = monitor();
  const world = mockWorld({ clients: () => [c], monitors: () => [m], active: () => c, helper: async () => ({ stdout: JSON.stringify({ controls: controls() }) }) });
  const pointer = mockPointer(), feedback = mockFeedback();
  feedback.paused = value => feedback.events.push(['paused', value]);
  const desktop = desktopFor(t, world, { pointer, feedback });
  await session(desktop);
  const observed = await desktop.observe({ window_id: c.address });
  pointer.perform = async req => { pointer.calls.push(req); desktop.pause('human_input'); return { dispatched: true, pointer: req.point }; };
  const result = await desktop.batch({ window_id: c.address, observation_id: observed.observation_id, actions: JSON.stringify([{ action: 'click', coordinate: [20, 20] }, { action: 'key', key: 'Enter' }]) });
  assert.equal(result.interrupted, true);
  assert.equal(result.reason, 'human_input');
  assert.equal(result.completed, 1);
  assert.equal(result.outcomes.length, 1);
  assert.equal(result.outcomes[0].dispatched, true);
  assert.equal(pointer.available, false);
  assert.equal(feedback.pid, 4242);
  assert.equal(desktop.observation, null);
  assert.equal((await desktop.session({ action: 'start', task: 'bypass' })).requires_user_resume, true);
  assert.equal((await desktop.control({ action: 'key', key: 'Enter' })).dispatched, false);
  assert.equal((await desktop.observe({ window_id: c.address, image: true })).requires_user_resume, true);
  assert.equal((await desktop.resumeByUser()).paused, true); // The takeover press must not also resume.
  desktop.pausedAt -= 400;
  await desktop.resumeByUser();
  assert.equal(desktop.paused, false);
  assert.equal(pointer.available, true);
  assert.equal(desktop.observation, null);
  await assert.rejects(desktop.control({ action: 'key', key: 'Enter', window_id: c.address, observation_id: observed.observation_id }), /stale_observation/);
  assert.equal(world.calls.filter(call => call.command === 'hyprctl' && call.args[0] === 'dispatch').length, 0);
});

test('capture hides every overlay before grim and restores it even when grim fails', async t => {
  const c = client(), m = monitor();
  let hidden = false, fail = false;
  const transitions = [];
  const feedback = mockFeedback();
  feedback.active = true;
  feedback.captureHidden = async value => { hidden = value; transitions.push(value); };
  const world = mockWorld({ clients: () => [c], monitors: () => [m], active: () => c, helper: async () => ({ stdout: JSON.stringify({ controls: controls() }) }), grim: async () => { assert.equal(hidden, true); if (fail) throw Error('grim_failed'); return { stdout: PNG }; } });
  const desktop = desktopFor(t, world, { feedback });
  await session(desktop);
  const observed = await desktop.observe({ window_id: c.address, image: true });
  assert.ok(observed.image_transfer.data_base64);
  assert.deepEqual(transitions, [true, false]);
  fail = true;
  await assert.rejects(desktop.observe({ window_id: c.address, image: true }), /grim_failed/);
  assert.deepEqual(transitions, [true, false, true, false]);
  assert.equal(hidden, false);
});

test('a failed screenshot hide never invokes grim, and a failed restore ends control', async t => {
  const c = client(), m = monitor();
  const world = mockWorld({ clients: () => [c], monitors: () => [m], active: () => c, helper: async () => ({ stdout: JSON.stringify({ controls: controls() }) }) });
  const feedback = mockFeedback(); feedback.active = true;
  feedback.captureHidden = async value => { if (value) throw Error('hide_failed'); };
  const desktop = desktopFor(t, world, { feedback }); await session(desktop);
  await assert.rejects(desktop.observe({ window_id: c.address, image: true }), /hide_failed/);
  assert.equal(world.calls.some(call => call.command === 'grim'), false);
  feedback.captureHidden = async value => { if (!value) throw Error('restore_failed'); };
  await assert.rejects(desktop.observe({ window_id: c.address, image: true }), /restore_failed/);
  assert.equal(desktop.sessionId, null);
});

test('image polls omit identical pixels while observations stay fresh; force and changed pixels send images',async t=>{
  let pixel=1;
  const world=mockWorld({clients:()=>[client()],monitors:()=>[monitor()],active:()=>client(),helper:async()=>({controls:controls()})});
  const d=desktopFor(t,world,{decodeImage:()=>({width:1,height:1,pixels:Buffer.from([pixel,0,0,255])})});await session(d);
  const first=await d.observe({window_id:'0xabc',view:'image'}),same=await d.observe({window_id:'0xabc',view:'image'});
  assert.equal(first.unchanged,false);assert.ok(first.image_transfer);assert.equal(same.unchanged,true);assert.equal(same.image_transfer,undefined);assert.equal(same.screenshot_id,first.screenshot_id);assert.notEqual(same.observation_id,first.observation_id);
  const forced=await d.observe({window_id:'0xabc',view:'image',force_image:'true'});assert.equal(forced.unchanged,false);assert.ok(forced.image_transfer);
  pixel=2;const changed=await d.observe({window_id:'0xabc',view:'image'});assert.equal(changed.unchanged,false);assert.ok(changed.image_transfer);assert.notEqual(changed.screenshot_id,same.screenshot_id);
  assert.equal(world.calls.filter(c=>c.command==='grim').length,4);
});

test('numbered native click prefers semantic action without touching pointer or reading control bounds',async t=>{
  const pointer=mockPointer();const c=controls();c[2].bounds=[0,0,0,0];c[2].actions=['press'];
  const world=mockWorld({clients:()=>[client()],monitors:()=>[monitor()],active:()=>client(),helper:async args=>({stdout:JSON.stringify(args[0]==='observe'?{controls:c}:{dispatched:true,action_name:'press'})})});
  const d=desktopFor(t,world,{pointer});await session(d);const o=await d.observe({window_id:'0xabc'});
  const r=await d.control({action:'click',element_number:'3',observation_id:o.observation_id});assert.equal(r.route,'atspi');assert.equal(r.action_name,'press');assert.equal(pointer.calls.length,0);
  assert.equal(world.calls.find(c=>c.args[0]==='click').args[9],'button');
});

test('native pointer fallback follows only explicit unattempted semantic receipt and fresh scaled AX bounds',async t=>{
  const pointer=mockPointer();const c=controls();c[2].bounds=[240,280,80,40];
  const world=mockWorld({clients:()=>[client()],monitors:()=>[monitor()],active:()=>client(),helper:async args=>({stdout:JSON.stringify(args[0]==='observe'?{controls:c,window_bounds:[200,200,800,600]}:{dispatched:false,semantic_unavailable:true})})});
  const d=desktopFor(t,world,{pointer});await session(d);const o=await d.observe({window_id:'0xabc'});
  const r=await d.control({action:'click',element_number:'3',observation_id:o.observation_id});assert.equal(r.route,'pointer_fallback');assert.equal(pointer.calls.length,1);assert.equal(pointer.calls[0].action,'click');assert.equal(pointer.calls[0].point.x,140);assert.equal(pointer.calls[0].point.y,150);
});

test('failed or uncertain semantic activation cannot dispatch a fallback click',async t=>{
  const pointer=mockPointer();const world=mockWorld({clients:()=>[client()],monitors:()=>[monitor()],active:()=>client(),helper:async args=>({stdout:JSON.stringify(args[0]==='observe'?{controls:controls()}:{dispatched:false,semantic_unavailable:true,uncertain:true,error:'attempted action failed'})})});
  const d=desktopFor(t,world,{pointer});await session(d);const o=await d.observe({window_id:'0xabc'});
  await assert.rejects(d.control({action:'click',element_number:'3',observation_id:o.observation_id}),/semantic_action_uncertain.*partial effects/);assert.equal(pointer.calls.length,0);assert.equal(d.observation,null);
});

test('explicit pointer coordinates retain physical semantics even with a numbered control',async t=>{
  const pointer=mockPointer();const world=mockWorld({clients:()=>[client()],monitors:()=>[monitor()],active:()=>client(),helper:async()=>({controls:controls()})});const d=desktopFor(t,world,{pointer});await session(d);const o=await d.observe({window_id:'0xabc'});await d.control({action:'click',element_number:'3',coordinate:'[500,500]',observation_id:o.observation_id});assert.equal(pointer.calls[0].action,'click');assert.equal(world.calls.some(c=>c.args[0]==='click'),false);
});

test('perform_action requires an exposed exact name and keeps its semantic receipt',async t=>{
  const pointer=mockPointer(),c=controls();c[1].actions=['activate'];const world=mockWorld({clients:()=>[client()],monitors:()=>[monitor()],active:()=>client(),helper:async args=>({stdout:JSON.stringify(args[0]==='observe'?{controls:c}:{dispatched:true,action_name:'activate'})})});const d=desktopFor(t,world,{pointer});await session(d);const o=await d.observe({window_id:'0xabc'});
  await assert.rejects(d.control({action:'perform_action',action_name:'jump',element_number:'2',observation_id:o.observation_id}),/action_name_required/);
  const r=await d.control({action:'perform_action',action_name:'activate',element_number:'2',observation_id:o.observation_id});assert.equal(r.route,'atspi');assert.equal(r.dispatch_path,'semantic');assert.equal(r.action_name,'activate');assert.equal(pointer.calls.length,0);const sent=world.calls.find(c=>c.args[0]==='perform_action');assert.equal(sent.args[9],'activate');assert.equal(sent.args[10],'text');
});

test('covered image waits preserve stale evidence while semantic clicks and batches still dispatch',async t=>{
 const c=client(),pointer=mockPointer();let cover=false;const layers=()=>cover?{'DP-1':{levels:{2:[{namespace:'omarchy-notifications',pid:2260,x:0,y:0,w:1920,h:1080,alpha:1}]}}}:emptyLayers();
 const world=mockWorld({clients:()=>[c],monitors:()=>[monitor()],active:()=>c,layers,helper:async a=>({stdout:JSON.stringify(a[0]==='observe'?{controls:controls()}:{dispatched:true,action_name:'press'})})});const d=desktopFor(t,world,{pointer});await session(d);const first=await d.observe({window_id:c.address,view:'image'});cover=true;let o=await d.control({action:'wait',duration:'0.01',window_id:c.address,view:'image'});assert.equal(o.capture_status,'unavailable');assert.equal(o.unchanged,null);assert.equal(o.previous_screenshot_id,first.screenshot_id);assert.equal(o.image_transfer,undefined);assert.match(o.capture_error,/omarchy-notifications/);
 const result=await d.control({action:'click',observation_id:o.observation_id,element_number:'3',view:'image'});assert.equal(result.dispatch_path,'semantic');assert.equal(result.action_name,'press');assert.equal(result.observation.capture_status,'unavailable');assert.equal(pointer.calls.length,0);
 o=result.observation;const batch=await d.batch({window_id:c.address,observation_id:o.observation_id,actions:'[{"action":"click","element_number":"3"},{"action":"wait","duration":"0.01"}]'});assert.equal(batch.completed,2);assert.equal(batch.outcomes[0].dispatch_path,'semantic');
});

test('semantic unavailability cannot fall back through an obscuring notification',async t=>{
 const c=client(),pointer=mockPointer();const world=mockWorld({clients:()=>[c],monitors:()=>[monitor()],active:()=>c,layers:{'DP-1':{levels:{2:[{namespace:'omarchy-notifications',pid:2260,x:0,y:0,w:1920,h:1080,alpha:1}]}}},helper:async a=>({stdout:JSON.stringify(a[0]==='observe'?{controls:controls(),window_bounds:[0,0,1920,1080]}:{dispatched:false,semantic_unavailable:true})})});const d=desktopFor(t,world,{pointer});await session(d);const o=await d.observe({window_id:c.address});await assert.rejects(d.control({action:'click',observation_id:o.observation_id,element_number:'3'}),/window_obscured/);assert.equal(pointer.calls.length,0);
});

test('configured compositor keys need no observation or focus, including comma and code bindings',async t=>{
 const c=client();let calls=0;const keyboard={stop(){},async key(key,opts){assert.equal(await opts.validateFocus(),true);assert.equal(key,'Shift+Super+,');calls++;}};
 const context={get:async()=>({supported:true,keybindings:[{chord:'SUPER+SHIFT+code:59',keys:['SUPER','SHIFT','code:59'],evdev:51,us_key:'comma'}]})};const world=mockWorld({clients:()=>[c],monitors:()=>[monitor()],active:()=>c});const d=desktopFor(t,world,{keyboard,context});await session(d);
 const r=await d.control({action:'compositor_key',key:'Super+Shift+comma'});assert.equal(r.dispatch_path,'compositor');assert.equal(d.observation,null);assert.equal(calls,1);assert.equal(world.calls.some(c=>c.args[0]==='dispatch'),false);
 await d.control({action:'key',key:'Super+Shift+comma',observation_id:'not-an-observation'});assert.equal(calls,2);
 await assert.rejects(d.control({action:'key',key:'Enter'}),/configured_shortcut_required/);assert.equal(calls,2);
 c.class='io.muse.linux';await assert.rejects(d.control({action:'compositor_key',key:'Super+Shift+comma'}),/app_blocked/);assert.equal(calls,2);
});

test('full-screen foreign layer can be photographed and right-clicked while its window is obscured',async t=>{
 const c=client(),pointer=mockPointer();let present=true;const layers=()=>({'DP-1':{levels:{2:present?[{namespace:'omarchy-notifications',pid:2260,x:0,y:0,w:1920,h:1080,alpha:1}]:[]}}});const world=mockWorld({clients:()=>[c],monitors:()=>[monitor()],active:()=>c,layers});const original=pointer.perform.bind(pointer);pointer.perform=async args=>{assert.equal(args.button,'right');present=false;return original(args);};const d=desktopFor(t,world,{pointer});await session(d);
 const o=await d.observe({surface:'layer',layer_namespace:'omarchy-notifications',monitor:'DP-1',view:'image'});assert.equal(o.capture_status,'captured');assert.ok(o.image_transfer);assert.equal(o.coordinate_system.space,'selected_layer');
 await assert.rejects(d.control({surface:'layer',action:'click',observation_id:o.observation_id,x:50,y:50,button:'right'}),/invalid_coordinate/);
 const r=await d.control({surface:'layer',action:'click',observation_id:o.observation_id,coordinate:'[500,100]',button:'right'});assert.equal(r.route,'layer_pointer');assert.equal(r.dispatch_path,'coordinate');assert.equal(r.layer_still_present,false);assert.equal(pointer.calls.length,1);assert.equal(pointer.calls[0].point.x,960);
});

test('layer identity and blocked-window points remain checked before input',async t=>{
 const c=client(),pointer=mockPointer();let pid=2260;const world=mockWorld({clients:()=>[c],monitors:()=>[monitor()],active:()=>c,layers:()=>({'DP-1':{levels:{2:[{namespace:'omarchy-notifications',pid,x:0,y:0,w:1920,h:1080,alpha:1}]}}})});const d=desktopFor(t,world,{pointer});await session(d);let o=await d.observe({surface:'layer',layer_namespace:'omarchy-notifications'});pid=2261;await assert.rejects(d.control({surface:'layer',action:'click',observation_id:o.observation_id,coordinate:'[100,150]'}),/stale_observation/);o=await d.observe({surface:'layer',layer_namespace:'omarchy-notifications'});c.class='io.muse.linux';await assert.rejects(d.control({surface:'layer',action:'click',observation_id:o.observation_id,coordinate:'[100,150]'}),/app_blocked/);assert.equal(pointer.calls.length,0);
 const {redact}=require('../src/layer-control.cjs');const bitmap={width:4,height:2,pixels:Buffer.alloc(32,99)};redact(bitmap,[0,0,4,2],[[1,0,2,2]]);assert.deepEqual([...bitmap.pixels.subarray(4,8)],[0,0,0,255]);assert.equal(bitmap.pixels[0],99);
});
