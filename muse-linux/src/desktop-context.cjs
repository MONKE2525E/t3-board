'use strict';

const QUERY_MS = 4000;
const DISPATCH_MS = 3000;
const MAX_BUFFER = 512 * 1024;
const MAX_NAME = 256;
const MAX_LAUNCH_ARGV = 36;
const MAX_LAUNCH_CMD = 8192;
const MAX_ARG_LENGTH = 4096;
const OWN_APPS = ['muse-linux', 'io.muse.linux'];

const SHIFT = 1;
const CTRL = 4;
const ALT = 8;
const SUPER = 64;

const APP_DISPATCH = new Set([
  'exec', 'execr', 'exec-once', 'pass', 'sendshortcut', 'sendkeystate', 'global',
  'exec_cmd', 'exec_raw', 'send_shortcut', 'send_key_state',
]);
const CLOSE_DISPATCH = new Set(['closewindow', 'close']);
const KILL_DISPATCH = new Set(['killactive', 'killwindow', 'kill', 'signal']);
const WORKSPACE_DISPATCH = new Set([
  'workspace', 'movetoworkspace', 'movetoworkspacesilent', 'togglespecialworkspace',
  'moveworkspacetomonitor', 'focusworkspaceoncurrentmonitor', 'renameworkspace',
]);
const WINDOW_DISPATCH = new Set([
  'focuswindow', 'movewindow', 'swapwindow', 'cyclenext', 'swapnext', 'fullscreen',
  'fullscreenstate', 'togglefloating', 'pin', 'pseudo', 'centerwindow',
  'bringactivetotop', 'alterzorder', 'tagwindow',
]);
const DISPLAY_DISPATCH = new Set([
  'focusmonitor', 'movecurrentworkspacetomonitor', 'swapactiveworkspaces', 'dpms',
  'movecursor', 'movecursortocorner',
]);

const MOD_TOKENS = new Set(['SUPER', 'CTRL', 'CONTROL', 'ALT', 'SHIFT', 'CAPS', 'MOD2', 'MOD3', 'MOD4', 'MOD5', 'META', 'WIN', 'LOGO']);

// X11 keycode = evdev + 8. Omarchy Lua uses code:10..19 for the number row.
const US_XKB = {
  10: '1', 11: '2', 12: '3', 13: '4', 14: '5', 15: '6', 16: '7', 17: '8', 18: '9', 19: '0',
  20: 'minus', 21: 'equal',
  24: 'q', 25: 'w', 26: 'e', 27: 'r', 28: 't', 29: 'y', 30: 'u', 31: 'i', 32: 'o', 33: 'p',
  34: 'bracketleft', 35: 'bracketright',
  38: 'a', 39: 's', 40: 'd', 41: 'f', 42: 'g', 43: 'h', 44: 'j', 45: 'k', 46: 'l',
  47: 'semicolon', 48: 'apostrophe',
  52: 'z', 53: 'x', 54: 'c', 55: 'v', 56: 'b', 57: 'n', 58: 'm',
  59: 'comma', 60: 'period', 61: 'slash',
};

function luaString(value) {
  return '"' + String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\x00-\x1f]/g, c => `\\${String(c.charCodeAt(0)).padStart(3, '0')}`) + '"';
}

function positiveInt(value) {
  if (typeof value === 'number') return Number.isInteger(value) && value > 0 && value <= 2147483647 ? value : null;
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!/^[1-9][0-9]{0,9}$/.test(text)) return null;
  const n = Number(text);
  return n <= 2147483647 ? n : null;
}

function exactAddress(windowId) {
  const raw = String(windowId || '');
  const address = raw.startsWith('address:') ? raw.slice(8) : raw;
  if (!/^0x[0-9a-fA-F]+$/.test(address) || /^0x0+$/i.test(address)) return null;
  return address;
}

function specialName(name) {
  const text = String(name || '');
  if (text === 'special') return '';
  if (/^special:[A-Za-z0-9_-]+$/.test(text)) return text.slice(8);
  return null;
}

function workspaceSelector(workspace) {
  const id = positiveInt(workspace);
  if (id != null) return { kind: 'id', lua: String(id), text: String(id) };
  if (typeof workspace !== 'string') throw Error('invalid_workspace');
  const name = workspace.trim();
  if (!name || name.length > MAX_NAME) throw Error('invalid_workspace');
  const special = specialName(name);
  if (special != null) {
    const text = special ? `special:${special}` : 'special';
    return { kind: 'special', special, lua: luaString(text), text };
  }
  if (/^(?:[+\-~]|m[+\-~]|r[+\-~]|e[+\-~]|name:|previous|empty)/i.test(name)) throw Error('invalid_workspace');
  if (/[\0\n\r;{}=]/.test(name)) throw Error('invalid_workspace');
  return { kind: 'name', lua: luaString('name:' + name), text: 'name:' + name };
}

function workspaceDispatch(workspace) {
  const sel = workspaceSelector(workspace);
  if (sel.kind === 'special') return `hl.dsp.workspace.toggle_special(${luaString(sel.special)})`;
  return `hl.dsp.focus({workspace=${sel.lua}})`;
}

function closeWindowDispatch(windowId) {
  const address = exactAddress(windowId);
  if (!address) throw Error('invalid_window');
  return `hl.dsp.window.close({window=${luaString('address:' + address)}})`;
}

function boolOpt(value, fallback, error) {
  if (value == null) return fallback;
  if (value === true || value === false) return value;
  throw Error(error);
}

function moveWindowDispatch(windowId, workspace, follow = false) {
  const address = exactAddress(windowId);
  if (!address) throw Error('invalid_window');
  const sel = workspaceSelector(workspace);
  const followFlag = boolOpt(follow, false, 'invalid_follow');
  return `hl.dsp.window.move({workspace=${sel.lua},follow=${followFlag},window=${luaString('address:' + address)}})`;
}

function posixShellArgv(argv) {
  if (!Array.isArray(argv) || !argv.length || argv.length > MAX_LAUNCH_ARGV) throw Error('invalid_command');
  if (argv.some(item => typeof item !== 'string' || item.includes('\0') || item.length > MAX_ARG_LENGTH)) throw Error('invalid_command');
  return argv.map(arg => `'${arg.replace(/'/g, "'\\''")}'`).join(' ');
}

function execLaunchDispatch(command, workspace, { silent = true, noInitialFocus = true } = {}) {
  const sel = workspaceSelector(workspace);
  const shell = posixShellArgv(command);
  if (shell.length > MAX_LAUNCH_CMD) throw Error('invalid_command');
  const silentFlag = boolOpt(silent, true, 'invalid_silent');
  const focusOff = boolOpt(noInitialFocus, true, 'invalid_focus');
  const text = silentFlag ? `${sel.text} silent` : sel.text;
  return `hl.dsp.exec_cmd(${luaString(shell)}, {workspace=${luaString(text)},no_initial_focus=${focusOff}})`;
}

function bindKeyToken(key, keycode) {
  const name = String(key || '').trim();
  if (name) {
    const parts = name.split(/\s*\+\s*/).filter(Boolean);
    const token = parts.at(-1) || '';
    if (token && !MOD_TOKENS.has(token.toUpperCase()) && token.toLowerCase() !== 'catchall') return token;
  }
  const n = Number(keycode);
  if (Number.isInteger(n) && n > 0) return `code:${n}`;
  return '';
}

function xkbCode(token) {
  const match = String(token || '').match(/^code:(\d+)$/i);
  if (!match) return null;
  const n = Number(match[1]);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function chordKeys(modmask, key, keycode) {
  const n = Number(modmask) || 0;
  const keys = [];
  if (n & SUPER) keys.push('SUPER');
  if (n & CTRL) keys.push('CTRL');
  if (n & ALT) keys.push('ALT');
  if (n & SHIFT) keys.push('SHIFT');
  const token = bindKeyToken(key, keycode);
  if (token) keys.push(token);
  return keys;
}

function parseBindsText(text) {
  if (!text) return [];
  return String(text).split(/\n(?=bind[a-z]*\n)/).map(chunk => {
    const match = chunk.match(/^[ \t]*key:[ \t]*(.*)$/m);
    return match ? match[1].trim() : '';
  });
}

function mergeBindKey(bind, displayKey) {
  const jsonKey = String(bind?.key || '').trim();
  if (jsonKey) return jsonKey;
  return String(displayKey || '').trim();
}

function classifyDispatcher(dispatcher) {
  const name = String(dispatcher || '');
  if (name === '__lua') return 'lua';
  if (APP_DISPATCH.has(name)) return 'app_shortcut';
  if (CLOSE_DISPATCH.has(name) || name === 'window.close') return 'close';
  if (KILL_DISPATCH.has(name) || name === 'window.kill') return 'kill';
  if (WORKSPACE_DISPATCH.has(name)) return 'workspace';
  if (WINDOW_DISPATCH.has(name)) return 'window';
  if (DISPLAY_DISPATCH.has(name)) return 'display';
  return 'other';
}

function safeArg(category, arg) {
  if (!arg) return false;
  if (category === 'app_shortcut' || category === 'lua' || category === 'kill') return false;
  if (category === 'workspace') return /^[1-9][0-9]{0,9}$/.test(arg) || /^special(?::[A-Za-z0-9_-]+)?$/.test(arg);
  if (category === 'window' || category === 'display' || category === 'close') return /^(?:[lrud]|0x[0-9a-fA-F]+)$/.test(arg);
  return false;
}

function presentBinding(bind, displayKey) {
  const dispatcher = String(bind?.dispatcher || '');
  const arg = bind?.arg == null ? '' : String(bind.arg);
  const category = classifyDispatcher(dispatcher);
  const key = mergeBindKey(bind, displayKey);
  const token = bindKeyToken(key, bind?.keycode);
  const keys = chordKeys(bind?.modmask, key, bind?.keycode);
  const code = xkbCode(token);
  const out = {
    keys,
    chord: keys.join('+'),
    description: String(bind?.description || ''),
    dispatcher,
    category,
    args_defined: arg.length > 0,
  };
  if (!token) out.key_missing = true;
  if (code != null) {
    out.code = code;
    if (code >= 8) out.evdev = code - 8;
    if (US_XKB[code]) out.us_key = US_XKB[code];
  }
  if (safeArg(category, arg)) out.arg = arg;
  const submap = String(bind?.submap || '').trim();
  if (submap) out.submap = submap;
  return out;
}

function parseVersion(version) {
  if (!version || typeof version !== 'object') return null;
  const tag = String(version.tag || '').trim();
  const branch = String(version.branch || '').trim();
  const number = String(version.version || '').trim();
  if (!tag && !branch && !number) return null;
  return { tag, branch, version: number };
}

function luaFromVersion(version) {
  const text = `${version?.tag || ''} ${version?.branch || ''} ${version?.version || ''}`;
  const match = text.match(/v?(\d+)\.(\d+)/);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > 0 || minor >= 55;
}

function asBlocked(blocked) {
  if (typeof blocked === 'function') return blocked;
  const list = Array.isArray(blocked) ? blocked : [];
  return () => list;
}

function workspaceShown(monitors, workspaceId) {
  const id = Number(workspaceId);
  if (!Number.isInteger(id) || id === 0) return false;
  return (monitors || []).some(monitor => monitor.activeWorkspace?.id === id || monitor.specialWorkspace?.id === id);
}

function clientRect(client) {
  const at = Array.isArray(client?.at) ? client.at : [0, 0];
  const size = Array.isArray(client?.size) ? client.size : [0, 0];
  return [Number(at[0]) || 0, Number(at[1]) || 0, Number(size[0]) || 0, Number(size[1]) || 0];
}

function emptyState(reason, extra = {}) {
  return {
    ready: false,
    supported: false,
    compositor: extra.compositor || 'unknown',
    lua: false,
    version: extra.version || null,
    reason,
    monitors: [],
    workspaces: [],
    currentWorkspace: null,
    focusedWindow: null,
    windows: [],
    keybindings: [],
  };
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function workspaceRef(value) {
  if (!value || typeof value !== 'object') return { id: 0, name: '' };
  return { id: Number(value.id) || 0, name: String(value.name || '') };
}

function specialRef(value) {
  const ref = workspaceRef(value);
  if (ref.id === 0 && !ref.name) return null;
  return ref;
}

async function withTimeout(work, ms, message) {
  const pending = Promise.resolve().then(work);
  pending.catch(() => {});
  let timer;
  try {
    return await Promise.race([
      pending,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error(message)), ms);
        timer.unref?.();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

class DesktopContext {
  constructor({ runFile, blocked = () => [], env, snapshot } = {}) {
    if (typeof runFile !== 'function') throw Error('runFile_required');
    this.runFile = runFile;
    this.blocked = asBlocked(blocked);
    this.env = env;
    this.snapshot = snapshot;
  }

  workspaceDispatch(workspace) { return workspaceDispatch(workspace); }
  closeWindowDispatch(windowId) { return closeWindowDispatch(windowId); }
  moveWindowDispatch(windowId, workspace, follow = false) { return moveWindowDispatch(windowId, workspace, follow); }
  execLaunchDispatch(command, workspace, options) { return execLaunchDispatch(command, workspace, options); }

  blockedSet() {
    const extra = this.blocked();
    return new Set([...OWN_APPS, ...(Array.isArray(extra) ? extra : [])].filter(Boolean).map(String));
  }

  runOptions(extra = {}) {
    const options = { encoding: 'utf8', maxBuffer: MAX_BUFFER, ...extra };
    if (this.env) options.env = this.env;
    return options;
  }

  async run(args, ms) {
    const result = await withTimeout(
      () => this.runFile('hyprctl', args, this.runOptions()),
      ms,
      'hyprctl_timeout',
    );
    return result;
  }

  async jsonCommand(name) {
    const result = await this.run(['-j', name], QUERY_MS);
    return JSON.parse(result.stdout);
  }

  async loadRaw() {
    if (typeof this.snapshot === 'function') return this.snapshot();
    if (this.snapshot && typeof this.snapshot === 'object') return this.snapshot;
    const names = ['monitors', 'workspaces', 'activeworkspace', 'activewindow', 'binds', 'version', 'clients'];
    const settled = await Promise.all([
      ...names.map(async name => {
        try { return { name, value: await this.jsonCommand(name) }; }
        catch (error) { return { name, error }; }
      }),
      (async () => {
        try { return { name: 'bindsText', value: String((await this.run(['binds'], QUERY_MS)).stdout || '') }; }
        catch (error) { return { name: 'bindsText', error }; }
      })(),
    ]);
    const got = Object.fromEntries(settled.map(item => [item.name, item]));
    if (got.version.error && got.monitors.error) {
      const error = got.version.error;
      const fail = Error('hyprland_unavailable');
      fail.cause = error;
      throw fail;
    }
    const pick = (name, fallback) => got[name].error ? fallback : got[name].value;
    return {
      monitors: pick('monitors', []),
      workspaces: pick('workspaces', []),
      activeworkspace: pick('activeworkspace', null),
      activewindow: pick('activewindow', null),
      binds: pick('binds', []),
      bindsText: pick('bindsText', ''),
      version: pick('version', null),
      clients: pick('clients', []),
    };
  }

  presentWindow(client, monitors, focusedAddress, blocked) {
    if (!client?.address || blocked.has(client.class) || blocked.has(client.initialClass)) return null;
    const workspace = workspaceRef(client.workspace);
    const mapped = client.mapped !== false && !client.hidden;
    const visible = mapped && workspaceShown(monitors, workspace.id);
    return {
      window_id: client.address,
      pid: client.pid,
      app: client.class,
      title: client.title,
      bounds: clientRect(client),
      workspace,
      monitor: client.monitor,
      visible,
      selected: client.address === focusedAddress,
    };
  }

  presentMonitors(monitors) {
    return asArray(monitors).map(monitor => ({
      id: monitor.id,
      name: monitor.name,
      x: monitor.x,
      y: monitor.y,
      width: monitor.width,
      height: monitor.height,
      scale: monitor.scale,
      transform: monitor.transform,
      focused: !!monitor.focused,
      disabled: !!monitor.disabled,
      activeWorkspace: workspaceRef(monitor.activeWorkspace),
      specialWorkspace: specialRef(monitor.specialWorkspace),
    }));
  }

  presentWorkspaces(workspaces, monitors) {
    const activeIds = new Set(monitors.flatMap(monitor => {
      const ids = [];
      if (monitor.activeWorkspace?.id) ids.push(monitor.activeWorkspace.id);
      if (monitor.specialWorkspace?.id) ids.push(monitor.specialWorkspace.id);
      return ids;
    }));
    return asArray(workspaces).map(space => {
      const id = Number(space.id) || 0;
      const name = String(space.name || '');
      return {
        id,
        name,
        monitor: space.monitor,
        monitorID: space.monitorID,
        windows: Number(space.windows) || 0,
        active: activeIds.has(id),
        special: id < 0 || name === 'special' || name.startsWith('special:'),
      };
    });
  }

  buildState(raw) {
    const version = parseVersion(raw.version);
    if (!version || (!version.tag && !version.branch && raw.version == null)) {
      return emptyState('hyprland_unavailable');
    }
    const lua = luaFromVersion(version);
    if (!lua) return emptyState('hyprland_lua_required', { compositor: 'hyprland', version });
    const monitors = this.presentMonitors(raw.monitors);
    const workspaces = this.presentWorkspaces(raw.workspaces, monitors);
    const current = raw.activeworkspace && typeof raw.activeworkspace === 'object'
      ? {
        id: Number(raw.activeworkspace.id) || 0,
        name: String(raw.activeworkspace.name || ''),
        monitor: raw.activeworkspace.monitor,
        monitorID: raw.activeworkspace.monitorID,
        windows: Number(raw.activeworkspace.windows) || 0,
      }
      : null;
    const displayKeys = parseBindsText(raw.bindsText);
    const blocked = this.blockedSet();
    const focusedRaw = raw.activewindow && raw.activewindow.address ? raw.activewindow : null;
    const focusedAddress = focusedRaw && !blocked.has(focusedRaw.class) && !blocked.has(focusedRaw.initialClass)
      ? focusedRaw.address
      : null;
    const windows = asArray(raw.clients)
      .map(client => this.presentWindow(client, monitors, focusedAddress, blocked))
      .filter(Boolean);
    const focusedWindow = focusedAddress
      ? windows.find(window => window.window_id === focusedAddress) || this.presentWindow(focusedRaw, monitors, focusedAddress, blocked)
      : null;
    return {
      ready: true,
      supported: true,
      compositor: 'hyprland',
      lua: true,
      version,
      reason: null,
      monitors,
      workspaces,
      currentWorkspace: current,
      focusedWindow,
      windows,
      keybindings: asArray(raw.binds).map((bind, index) => presentBinding(bind, displayKeys[index])),
    };
  }

  async get() {
    try {
      return this.buildState(await this.loadRaw());
    } catch {
      return emptyState('hyprland_unavailable');
    }
  }

  async describe() {
    return this.get();
  }

  resolveWorkspace(value, workspaces) {
    const id = positiveInt(value);
    if (id != null) {
      const found = workspaces.find(space => space.id === id);
      if (!found) throw Error('workspace_not_found');
      return found;
    }
    if (typeof value !== 'string' && typeof value !== 'number') throw Error('invalid_workspace');
    const name = String(value).trim();
    if (!name) throw Error('invalid_workspace');
    if (/^(?:[+\-~]|m[+\-~]|r[+\-~]|e[+\-~]|name:|previous|empty)/i.test(name) && !workspaces.some(space => space.name === name)) {
      throw Error('invalid_workspace');
    }
    const found = workspaces.find(space => space.name === name);
    if (!found) throw Error('workspace_not_found');
    return found;
  }

  resolveMonitor(value, monitors) {
    const id = typeof value === 'number' || (typeof value === 'string' && /^(?:0|[1-9][0-9]*)$/.test(value.trim()))
      ? Number(String(value).trim())
      : null;
    if (id != null && Number.isInteger(id) && id >= 0) {
      const found = monitors.find(monitor => monitor.id === id);
      if (!found) throw Error('monitor_not_found');
      return found;
    }
    if (typeof value !== 'string') throw Error('invalid_monitor');
    const name = value.trim();
    if (!name || /^(?:[+\-~]|current|desc:)/i.test(name)) throw Error('invalid_monitor');
    const found = monitors.find(monitor => monitor.name === name);
    if (!found) throw Error('monitor_not_found');
    return found;
  }

  async dispatch(expr) {
    const result = await this.run(['dispatch', expr], DISPATCH_MS);
    if (String(result.stdout || '').trim() !== 'ok') throw Error('dispatch_failed');
  }

  dispatchExpr(space) {
    if (space.id > 0) return workspaceDispatch(space.id);
    return workspaceDispatch(space.name);
  }

  async switchWorkspace({ workspace, monitor } = {}) {
    const state = await this.get();
    if (!state.supported || !state.lua) throw Error(state.reason || 'hyprland_lua_required');
    const space = this.resolveWorkspace(workspace, state.workspaces);
    const target = monitor == null || monitor === '' ? null : this.resolveMonitor(monitor, state.monitors);
    const onMonitor = !target || space.monitor === target.name || space.monitorID === target.id;
    if (space.special) {
      const shown = (target || state.monitors.find(item => item.focused) || state.monitors[0])?.specialWorkspace;
      const already = !!shown && (shown.id === space.id || shown.name === space.name);
      if (already && (!target || onMonitor || shown.name === space.name)) {
        return { dispatched: false, already: true, workspace: { id: space.id, name: space.name }, monitor: target ? { id: target.id, name: target.name } : null };
      }
      if (target) await this.dispatch(`hl.dsp.focus({monitor=${luaString(target.name)}})`);
      await this.dispatch(this.dispatchExpr(space));
      return { dispatched: true, workspace: { id: space.id, name: space.name }, monitor: target ? { id: target.id, name: target.name } : null };
    }
    if (target && !onMonitor) {
      await this.dispatch(`hl.dsp.workspace.move({workspace=${space.id},monitor=${luaString(target.name)}})`);
    }
    await this.dispatch(this.dispatchExpr(space));
    return { dispatched: true, workspace: { id: space.id, name: space.name }, monitor: target ? { id: target.id, name: target.name } : null };
  }
}

module.exports = {
  DesktopContext,
  workspaceDispatch,
  closeWindowDispatch,
  moveWindowDispatch,
  execLaunchDispatch,
  luaString,
  chordKeys,
  presentBinding,
  parseBindsText,
};
