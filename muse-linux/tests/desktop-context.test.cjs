'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  DesktopContext, workspaceDispatch, closeWindowDispatch, moveWindowDispatch, execLaunchDispatch,
  chordKeys, presentBinding, parseBindsText,
} = require('../src/desktop-context.cjs');

function monitors() {
  return [
    {
      id: 0, name: 'DP-1', x: 0, y: 0, width: 1920, height: 1080, scale: 1, transform: 0,
      focused: false, disabled: false,
      activeWorkspace: { id: 1, name: '1' },
      specialWorkspace: { id: -98, name: 'special:magic' },
    },
    {
      id: 1, name: 'DP-2', x: 1920, y: 0, width: 2560, height: 1440, scale: 1.25, transform: 0,
      focused: true, disabled: false,
      activeWorkspace: { id: 3, name: '3' },
      specialWorkspace: { id: 0, name: '' },
    },
  ];
}

function workspaces() {
  return [
    { id: 1, name: '1', monitor: 'DP-1', monitorID: 0, windows: 1 },
    { id: 2, name: '2', monitor: 'DP-1', monitorID: 0, windows: 0 },
    { id: 3, name: '3', monitor: 'DP-2', monitorID: 1, windows: 2 },
    { id: 9, name: 'Web', monitor: 'DP-2', monitorID: 1, windows: 1 },
    { id: -98, name: 'special:magic', monitor: 'DP-1', monitorID: 0, windows: 1 },
  ];
}

function clients() {
  return [
    {
      address: '0xaaa', mapped: true, hidden: false, at: [2000, 100], size: [800, 600],
      workspace: { id: 3, name: '3' }, monitor: 1, class: 'firefox', title: 'Firefox', pid: 100,
    },
    {
      address: '0xbbb', mapped: true, hidden: false, at: [80, 80], size: [400, 300],
      workspace: { id: 1, name: '1' }, monitor: 0, class: 'kitty', title: 'term', pid: 101,
    },
    {
      address: '0xccc', mapped: true, hidden: false, at: [100, 100], size: [300, 200],
      workspace: { id: -98, name: 'special:magic' }, monitor: 0, class: 'notes', title: 'scratch', pid: 102,
    },
    {
      address: '0xddd', mapped: true, hidden: false, at: [0, 0], size: [100, 100],
      workspace: { id: 2, name: '2' }, monitor: 0, class: 'hidden-app', title: 'Idle', pid: 103,
    },
    {
      address: '0xeee', mapped: true, hidden: false, at: [10, 10], size: [200, 200],
      workspace: { id: 3, name: '3' }, monitor: 1, class: 'io.muse.linux', title: 'Muse', pid: 104,
    },
    {
      address: '0xfff', mapped: true, hidden: false, at: [20, 20], size: [200, 200],
      workspace: { id: 3, name: '3' }, monitor: 1, class: 'secret-app', title: 'Wallet', pid: 105,
    },
  ];
}

function binds() {
  return [
    { locked: false, mouse: false, modmask: 64, key: '1', keycode: 0, description: 'Workspace 1', dispatcher: 'workspace', arg: '1', submap: '', has_description: true },
    { locked: false, mouse: false, modmask: 4, key: 'q', keycode: 0, description: '', dispatcher: 'killactive', arg: '', submap: '' },
    { locked: false, mouse: false, modmask: 8, key: 'F4', keycode: 0, description: 'Close window', dispatcher: 'closewindow', arg: '', submap: '' },
    { locked: false, mouse: false, modmask: 64, key: 'B', keycode: 0, description: 'Browser', dispatcher: 'exec', arg: 'chromium --user-data-dir=/secret/token --password=hunter2', submap: '', has_description: true },
    { locked: false, mouse: false, modmask: 68, key: 'Q', keycode: 0, description: 'Close window', dispatcher: '__lua', arg: '6', submap: '', has_description: true },
    { locked: false, mouse: false, modmask: 76, key: 'R', keycode: 0, description: 'SSH', dispatcher: 'exec', arg: 'alacritty -e ssh user@host --token=s3cret', submap: '', has_description: true },
    { locked: false, mouse: false, modmask: 64, key: 'W', keycode: 0, description: 'Web', dispatcher: 'workspace', arg: 'name:Web', submap: '' },
  ];
}

function version() {
  return { tag: 'v0.56.2', branch: 'v0.56.2', commit: 'abc', dirty: false };
}

function world(extra = {}) {
  const calls = [];
  const data = {
    monitors: extra.monitors || monitors,
    workspaces: extra.workspaces || workspaces,
    activeworkspace: extra.activeworkspace || (() => ({ id: 3, name: '3', monitor: 'DP-2', monitorID: 1, windows: 2 })),
    activewindow: extra.activewindow || (() => clients()[0]),
    binds: extra.binds || binds,
    version: extra.version || version,
    clients: extra.clients || clients,
  };
  const runFile = async (command, args, options = {}) => {
    calls.push({ command, args: [...args], options: { ...options } });
    if (options.timeout != null || options.killSignal || options.signal) throw Error('must_not_kill');
    if (command !== 'hyprctl') throw Error(`unexpected command ${command}`);
    if (args[0] === '-j') {
      const name = args[1];
      if (typeof extra.fail === 'function' && extra.fail(name)) {
        const error = Error('fail');
        if (extra.failCode) error.code = extra.failCode;
        throw error;
      }
      const value = data[name];
      if (!value) throw Error(`unexpected query ${name}`);
      return { stdout: JSON.stringify(typeof value === 'function' ? value() : value) };
    }
    if (args[0] === 'binds' && args.length === 1) {
      if (extra.bindsText != null) return { stdout: extra.bindsText };
      const list = typeof data.binds === 'function' ? data.binds() : data.binds;
      return {
        stdout: (list || []).map(bind => `bindd\n\tmodmask: ${bind.modmask}\n\tkey: ${bind.key || ''}\n\tdescription: ${bind.description || ''}\n\tdispatcher: ${bind.dispatcher}\n\targ: omitted\n`).join('\n'),
      };
    }
    if (args[0] === 'dispatch') {
      if (typeof extra.dispatch === 'function') return extra.dispatch(args[1], calls);
      if (extra.dispatch instanceof Error) throw extra.dispatch;
      return { stdout: extra.dispatch == null ? 'ok' : String(extra.dispatch) };
    }
    throw Error(`unexpected args ${args}`);
  };
  return { calls, runFile };
}

function context(_t, extra = {}) {
  const w = extra.world || world(extra);
  const desktop = new DesktopContext({
    runFile: extra.runFile || w.runFile,
    blocked: extra.blocked || (() => extra.blockedApps || ['secret-app']),
    env: extra.env,
    snapshot: extra.snapshot,
  });
  return { desktop, world: w };
}

test('modmask maps CTRL ALT SUPER SHIFT into compositor chords', () => {
  assert.deepEqual(chordKeys(4, 'q'), ['CTRL', 'q']);
  assert.deepEqual(chordKeys(8, 'F4'), ['ALT', 'F4']);
  assert.deepEqual(chordKeys(64, '1'), ['SUPER', '1']);
  assert.deepEqual(chordKeys(76, 'R'), ['SUPER', 'CTRL', 'ALT', 'R']);
  assert.deepEqual(chordKeys(68, 'Q'), ['SUPER', 'CTRL', 'Q']);
  assert.equal(presentBinding({ modmask: 64, key: '1', dispatcher: 'workspace', arg: '1' }).chord, 'SUPER+1');
});

test('exec and lua bind arguments never leak into metadata', () => {
  const browser = presentBinding({
    modmask: 64, key: 'B', dispatcher: 'exec',
    arg: 'chromium --password=hunter2', description: 'Browser',
  });
  assert.equal(browser.category, 'app_shortcut');
  assert.equal(browser.args_defined, true);
  assert.equal(browser.description, 'Browser');
  assert.equal(browser.chord, 'SUPER+B');
  assert.equal('arg' in browser, false);
  assert.equal(JSON.stringify(browser).includes('hunter2'), false);

  const lua = presentBinding({
    modmask: 68, key: 'Q', dispatcher: '__lua', arg: '6', description: 'Close window',
  });
  assert.equal(lua.dispatcher, '__lua');
  assert.equal(lua.category, 'lua');
  assert.equal(lua.args_defined, true);
  assert.equal('arg' in lua, false);

  const named = presentBinding({
    modmask: 64, key: 'W', dispatcher: 'workspace', arg: 'name:Web', description: '',
  });
  assert.equal(named.category, 'workspace');
  assert.equal('arg' in named, false);

  const numbered = presentBinding({
    modmask: 64, key: '1', dispatcher: 'workspace', arg: '1', description: 'Workspace 1',
  });
  assert.equal(numbered.arg, '1');
});

test('get/describe keep per-monitor active and special workspaces and do not infer a single current workspace', async t => {
  const { desktop, world: w } = context(t);
  const state = await desktop.describe();
  assert.equal(state.ready, true);
  assert.equal(state.supported, true);
  assert.equal(state.lua, true);
  assert.equal(state.version.tag, 'v0.56.2');
  assert.equal(state.currentWorkspace.id, 3);
  assert.equal(state.currentWorkspace.monitor, 'DP-2');
  assert.equal(state.monitors[0].activeWorkspace.id, 1);
  assert.equal(state.monitors[0].specialWorkspace.name, 'special:magic');
  assert.equal(state.monitors[1].activeWorkspace.id, 3);
  assert.equal(state.monitors[1].specialWorkspace, null);
  assert.equal(state.focusedWindow.window_id, '0xaaa');
  assert.equal(state.focusedWindow.selected, true);
  assert.equal(state.focusedWindow.workspace.id, 3);

  const kitty = state.windows.find(window => window.window_id === '0xbbb');
  assert.equal(kitty.workspace.id, 1);
  assert.equal(kitty.visible, true);
  const idle = state.windows.find(window => window.window_id === '0xddd');
  assert.equal(idle.visible, false);
  const scratch = state.windows.find(window => window.window_id === '0xccc');
  assert.equal(scratch.visible, true);
  assert.equal(state.windows.some(window => window.app === 'io.muse.linux'), false);
  assert.equal(state.windows.some(window => window.app === 'secret-app'), false);
  assert.equal(state.focusedWindow.app, 'firefox');

  const queries = w.calls.filter(call => call.args[0] === '-j').map(call => call.args[1]).sort();
  assert.deepEqual(queries, ['activewindow', 'activeworkspace', 'binds', 'clients', 'monitors', 'version', 'workspaces']);
  assert.equal(w.calls.every(call => call.options.timeout == null && call.options.signal == null && call.options.killSignal == null), true);
});

test('blocked focused window is omitted and extra blocked apps are excluded', async t => {
  const { desktop } = context(t, {
    activewindow: () => clients().find(c => c.class === 'secret-app'),
    blockedApps: ['secret-app'],
  });
  const state = await desktop.get();
  assert.equal(state.focusedWindow, null);
  assert.equal(state.windows.some(window => window.window_id === '0xfff'), false);
});

test('keybindings from get() keep chords and drop exec secrets', async t => {
  const { desktop } = context(t);
  const state = await desktop.get();
  const dump = JSON.stringify(state);
  assert.equal(dump.includes('hunter2'), false);
  assert.equal(dump.includes('s3cret'), false);
  assert.equal(dump.includes('/secret/token'), false);
  const browser = state.keybindings.find(bind => bind.chord === 'SUPER+B');
  assert.equal(browser.category, 'app_shortcut');
  assert.equal(browser.args_defined, true);
  assert.equal('arg' in browser, false);
  const ssh = state.keybindings.find(bind => bind.chord === 'SUPER+CTRL+ALT+R');
  assert.equal(ssh.description, 'SSH');
  assert.equal(ssh.category, 'app_shortcut');
  const close = state.keybindings.find(bind => bind.chord === 'ALT+F4');
  assert.equal(close.category, 'close');
  const lua = state.keybindings.find(bind => bind.chord === 'SUPER+CTRL+Q');
  assert.equal(lua.category, 'lua');
  assert.equal('arg' in lua, false);
});

test('workspaceDispatch emits Lua focus from integers and rejects selector interpolation', () => {
  assert.equal(workspaceDispatch(3), 'hl.dsp.focus({workspace=3})');
  assert.equal(workspaceDispatch('9'), 'hl.dsp.focus({workspace=9})');
  assert.equal(workspaceDispatch('Web'), 'hl.dsp.focus({workspace="name:Web"})');
  assert.equal(workspaceDispatch('special:magic'), 'hl.dsp.workspace.toggle_special("magic")');
  assert.equal(workspaceDispatch('special'), 'hl.dsp.workspace.toggle_special("")');
  for (const bad of [0, -1, 1.5, '+1', 'm+1', 'r~2', 'e-1', 'previous', 'empty', 'name:Web', '3;hl.dsp.exec_cmd("x")', 'Web"=1,x="y', null, '', {}]) {
    assert.throws(() => workspaceDispatch(bad), /invalid_workspace/, String(bad));
  }
});

test('closeWindowDispatch uses exact address close and never kill', () => {
  assert.equal(closeWindowDispatch('0xabc'), 'hl.dsp.window.close({window="address:0xabc"})');
  assert.equal(closeWindowDispatch('address:0xAAA'), 'hl.dsp.window.close({window="address:0xAAA"})');
  assert.equal(closeWindowDispatch('0xabc').includes('kill'), false);
  for (const bad of ['0x0', 'address:0x0', 'abc', '0xabc;os.execute', 'address:0xabc,class:x', 'pid:1', '', null]) {
    assert.throws(() => closeWindowDispatch(bad), /invalid_window/, String(bad));
  }
});

test('switchWorkspace validates snapshot ids and dispatches the snapshot integer, not the caller string', async t => {
  const { desktop, world: w } = context(t);
  const result = await desktop.switchWorkspace({ workspace: '3' });
  assert.equal(result.dispatched, true);
  assert.equal(result.workspace.id, 3);
  assert.equal(result.workspace.name, '3');
  const dispatched = w.calls.filter(call => call.args[0] === 'dispatch').map(call => call.args[1]);
  assert.deepEqual(dispatched, ['hl.dsp.focus({workspace=3})']);
  await assert.rejects(() => desktop.switchWorkspace({ workspace: 4 }), /workspace_not_found/);
  await assert.rejects(() => desktop.switchWorkspace({ workspace: '+1' }), /invalid_workspace|workspace_not_found/);
  await assert.rejects(() => desktop.switchWorkspace({ workspace: '3;hl.dsp.exec_cmd("curl http://evil")' }), /invalid_workspace|workspace_not_found/);
  await assert.rejects(() => desktop.switchWorkspace({ workspace: 0 }), /invalid_workspace|workspace_not_found/);
  assert.equal(w.calls.some(call => String(call.args[1] || '').includes('exec_cmd')), false);
  assert.equal(w.calls.some(call => String(call.args[1] || '').includes('window.kill')), false);
});

test('named workspace uses the snapshot id rather than interpolating the name into Lua', async t => {
  const { desktop, world: w } = context(t);
  const result = await desktop.switchWorkspace({ workspace: 'Web' });
  assert.equal(result.workspace.id, 9);
  assert.equal(result.workspace.name, 'Web');
  assert.deepEqual(w.calls.filter(call => call.args[0] === 'dispatch').map(call => call.args[1]), ['hl.dsp.focus({workspace=9})']);
});

test('switchWorkspace with a monitor already hosting the workspace only focuses it', async t => {
  const { desktop, world: w } = context(t);
  await desktop.switchWorkspace({ workspace: 3, monitor: 'DP-2' });
  assert.deepEqual(w.calls.filter(call => call.args[0] === 'dispatch').map(call => call.args[1]), ['hl.dsp.focus({workspace=3})']);
});

test('switchWorkspace moves a workspace onto the requested monitor then focuses the snapshot id', async t => {
  const { desktop, world: w } = context(t);
  await desktop.switchWorkspace({ workspace: 1, monitor: 'DP-2' });
  assert.deepEqual(w.calls.filter(call => call.args[0] === 'dispatch').map(call => call.args[1]), [
    'hl.dsp.workspace.move({workspace=1,monitor="DP-2"})',
    'hl.dsp.focus({workspace=1})',
  ]);
  await assert.rejects(() => desktop.switchWorkspace({ workspace: 3, monitor: 'HDMI-A-1' }), /monitor_not_found/);
  await assert.rejects(() => desktop.switchWorkspace({ workspace: 3, monitor: '+1' }), /invalid_monitor/);
});

test('special workspace toggles by snapshot name and does not hide one that is already shown', async t => {
  const { desktop, world: w } = context(t);
  const already = await desktop.switchWorkspace({ workspace: 'special:magic', monitor: 'DP-1' });
  assert.equal(already.already, true);
  assert.equal(already.dispatched, false);
  assert.equal(w.calls.some(call => call.args[0] === 'dispatch'), false);

  const other = world();
  const desktop2 = new DesktopContext({ runFile: other.runFile, blocked: () => [] });
  const shown = await desktop2.switchWorkspace({ workspace: 'special:magic', monitor: 'DP-2' });
  assert.equal(shown.dispatched, true);
  assert.deepEqual(other.calls.filter(call => call.args[0] === 'dispatch').map(call => call.args[1]), [
    'hl.dsp.focus({monitor="DP-2"})',
    'hl.dsp.workspace.toggle_special("magic")',
  ]);
});

test('legacy Hyprland and missing hyprctl are unsupported without throwing', async () => {
  const legacy = new DesktopContext({
    runFile: async (_command, args) => {
      if (args[1] === 'version') return { stdout: JSON.stringify({ tag: 'v0.54.0', branch: 'v0.54.0' }) };
      return { stdout: '[]' };
    },
  });
  const state = await legacy.describe();
  assert.equal(state.ready, false);
  assert.equal(state.lua, false);
  assert.equal(state.compositor, 'hyprland');
  assert.equal(state.reason, 'hyprland_lua_required');
  await assert.rejects(() => legacy.switchWorkspace({ workspace: 1 }), /hyprland_lua_required/);

  const missing = new DesktopContext({
    runFile: async () => {
      const error = Error('spawn hyprctl ENOENT');
      error.code = 'ENOENT';
      throw error;
    },
  });
  const gone = await missing.get();
  assert.equal(gone.supported, false);
  assert.equal(gone.reason, 'hyprland_unavailable');
  await assert.rejects(() => missing.switchWorkspace({ workspace: 1 }), /hyprland_unavailable/);
});

test('constructor snapshot is used and nested env is forwarded without process-kill options', async () => {
  const env = { WAYLAND_DISPLAY: 'wayland-99', XDG_RUNTIME_DIR: '/tmp/nested', HYPRLAND_INSTANCE_SIGNATURE: 'sig' };
  const snapshot = {
    monitors: monitors(),
    workspaces: workspaces(),
    activeworkspace: { id: 1, name: '1', monitor: 'DP-1', monitorID: 0, windows: 1 },
    activewindow: clients()[1],
    binds: binds(),
    version: version(),
    clients: clients(),
  };
  const calls = [];
  const desktop = new DesktopContext({
    env,
    snapshot,
    blocked: () => [],
    runFile: async (command, args, options) => {
      calls.push({ command, args, options });
      if (options.env !== env) throw Error('env_not_forwarded');
      if (options.timeout != null || options.signal) throw Error('must_not_kill');
      return { stdout: 'ok' };
    },
  });
  const state = await desktop.get();
  assert.equal(state.currentWorkspace.id, 1);
  assert.equal(state.focusedWindow.window_id, '0xbbb');
  assert.equal(calls.length, 0);
  await desktop.switchWorkspace({ workspace: 2 });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, ['dispatch', 'hl.dsp.focus({workspace=2})']);
  assert.equal(calls[0].options.env.WAYLAND_DISPLAY, 'wayland-99');
  assert.equal(calls[0].options.timeout, undefined);
});

test('methods are instance-bound helpers matching the exported functions', () => {
  const desktop = new DesktopContext({ runFile: async () => ({ stdout: '{}' }) });
  assert.equal(desktop.workspaceDispatch(2), workspaceDispatch(2));
  assert.equal(desktop.closeWindowDispatch('0xabc'), closeWindowDispatch('0xabc'));
  assert.equal(desktop.moveWindowDispatch('0xabc', 9, false), moveWindowDispatch('0xabc', 9, false));
  assert.equal(
    desktop.execLaunchDispatch(['gio', 'launch', '/tmp/a.desktop'], 3),
    execLaunchDispatch(['gio', 'launch', '/tmp/a.desktop'], 3),
  );
});

test('Lua code:N binds recover displayKey from text hyprctl binds when JSON key and keycode are empty', async t => {
  const text = [
    'bindd',
    '\tmodmask: 64',
    '\tsubmap: ',
    '\tkey: SUPER + code:12',
    '\tkeycode: 0',
    '\tdescription: Muse QA workspace',
    '\tdispatcher: __lua',
    '\targ: 6',
    '',
    'bindd',
    '\tmodmask: 64',
    '\tkey: 3',
    '\tkeycode: 0',
    '\tdescription: Muse QA actual keycode',
    '\tdispatcher: __lua',
    '\targ: 8',
  ].join('\n');
  assert.deepEqual(parseBindsText(text), ['SUPER + code:12', '3']);
  const { desktop } = context(t, {
    binds: () => [
      { modmask: 64, key: '', keycode: 0, description: 'Muse QA workspace', dispatcher: '__lua', arg: '6' },
      { modmask: 64, key: '3', keycode: 0, description: 'Muse QA actual keycode', dispatcher: '__lua', arg: '8' },
    ],
    bindsText: text,
  });
  const state = await desktop.get();
  const dump = JSON.stringify(state);
  assert.equal(dump.includes('"arg":"6"'), false);
  const codeBind = state.keybindings.find(bind => bind.description === 'Muse QA workspace');
  assert.equal(codeBind.chord, 'SUPER+code:12');
  assert.deepEqual(codeBind.keys, ['SUPER', 'code:12']);
  assert.equal(codeBind.code, 12);
  assert.equal(codeBind.evdev, 4);
  assert.equal(codeBind.us_key, '3');
  assert.equal(codeBind.key_missing, undefined);
  const symbol = state.keybindings.find(bind => bind.description === 'Muse QA actual keycode');
  assert.equal(symbol.chord, 'SUPER+3');
  assert.equal(symbol.us_key, undefined);
});

test('JSON-only empty key stays key_missing and does not invent a code', () => {
  const bind = presentBinding({ modmask: 64, key: '', keycode: 0, dispatcher: '__lua', description: 'Switch to workspace 3', arg: '9' });
  assert.equal(bind.chord, 'SUPER');
  assert.equal(bind.key_missing, true);
  assert.equal(bind.code, undefined);
  assert.equal('arg' in bind, false);
  const recovered = presentBinding(
    { modmask: 65, key: '', keycode: 0, dispatcher: '__lua', description: 'Move window silently to workspace 3' },
    'SUPER + SHIFT + code:12',
  );
  assert.equal(recovered.chord, 'SUPER+SHIFT+code:12');
  assert.equal(recovered.us_key, '3');
  assert.equal(recovered.code, 12);
});

test('blocked may be an array as well as a function', async () => {
  const w = world();
  const desktop = new DesktopContext({ runFile: w.runFile, blocked: ['secret-app'] });
  const state = await desktop.get();
  assert.equal(state.windows.some(window => window.app === 'secret-app'), false);
  assert.equal(state.windows.some(window => window.app === 'io.muse.linux'), false);
});

test('moveWindowDispatch uses exact address and a plain workspace without querying state', () => {
  assert.equal(
    moveWindowDispatch('0xabc', 3),
    'hl.dsp.window.move({workspace=3,follow=false,window="address:0xabc"})',
  );
  assert.equal(
    moveWindowDispatch('address:0xAAA', '9', true),
    'hl.dsp.window.move({workspace=9,follow=true,window="address:0xAAA"})',
  );
  assert.equal(
    moveWindowDispatch('0xabc', 1000, false),
    'hl.dsp.window.move({workspace=1000,follow=false,window="address:0xabc"})',
  );
  assert.equal(
    moveWindowDispatch('0xabc', 'Web'),
    'hl.dsp.window.move({workspace="name:Web",follow=false,window="address:0xabc"})',
  );
  assert.equal(
    moveWindowDispatch('0xabc', 'special:magic'),
    'hl.dsp.window.move({workspace="special:magic",follow=false,window="address:0xabc"})',
  );
  assert.equal(
    moveWindowDispatch('0xabc', 'special'),
    'hl.dsp.window.move({workspace="special",follow=false,window="address:0xabc"})',
  );
  assert.equal(moveWindowDispatch('0xabc', 4).includes('kill'), false);
  for (const bad of [0, -1, 1.5, '+1', 'm+1', 'previous', 'empty', 'name:Web', '3;hl.dsp.exec_cmd("x")', '', null, {}]) {
    assert.throws(() => moveWindowDispatch('0xabc', bad), /invalid_workspace/, String(bad));
  }
  for (const bad of ['0x0', 'abc', '0xabc;os.execute', 'address:0xabc,class:x', 'pid:1', '', null]) {
    assert.throws(() => moveWindowDispatch(bad, 3), /invalid_window/, String(bad));
  }
  assert.throws(() => moveWindowDispatch('0xabc', 3, 'false'), /invalid_follow/);
  assert.throws(() => moveWindowDispatch('0xabc', 3, 0), /invalid_follow/);
});

test('execLaunchDispatch quotes argv and never interpolates a raw Exec line', () => {
  assert.equal(
    execLaunchDispatch(['gio', 'launch', '/tmp/firefox.desktop'], 3),
    'hl.dsp.exec_cmd("\'gio\' \'launch\' \'/tmp/firefox.desktop\'", {workspace="3 silent",no_initial_focus=true})',
  );
  assert.equal(
    execLaunchDispatch(['gio', 'launch', '/tmp/app.desktop', 'file; rm -rf /'], 9, { silent: true, noInitialFocus: true }),
    'hl.dsp.exec_cmd("\'gio\' \'launch\' \'/tmp/app.desktop\' \'file; rm -rf /\'", {workspace="9 silent",no_initial_focus=true})',
  );
  assert.equal(
    execLaunchDispatch(['gio', 'launch', '/tmp/a.desktop'], 'Web', { silent: false, noInitialFocus: false }),
    'hl.dsp.exec_cmd("\'gio\' \'launch\' \'/tmp/a.desktop\'", {workspace="name:Web",no_initial_focus=false})',
  );
  assert.equal(
    execLaunchDispatch(['gio', 'launch', '/tmp/a.desktop'], 'special:magic'),
    'hl.dsp.exec_cmd("\'gio\' \'launch\' \'/tmp/a.desktop\'", {workspace="special:magic silent",no_initial_focus=true})',
  );
  const quoted = execLaunchDispatch(['gio', 'launch', `/tmp/it's.desktop`], 1);
  assert.equal(quoted.includes("/tmp/it'\\\\''s.desktop"), true);
  assert.throws(() => execLaunchDispatch(['gio', 'launch', '/tmp/a.desktop'], '+1'), /invalid_workspace/);
  assert.throws(() => execLaunchDispatch('gio launch /bin/evil --token=s3cret', 3), /invalid_command/);
  assert.throws(() => execLaunchDispatch(['gio', 'launch', '/tmp/a.desktop'], 3, { silent: 'yes' }), /invalid_silent/);
});
