'use strict';

const { execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execLaunchDispatch } = require('./desktop-context.cjs');

const MAX_DESKTOP_BYTES = 64 * 1024;
const MAX_ARGS = 32;
const MAX_ARG_LENGTH = 4096;
const LAUNCH_TIMEOUT_MS = 15000;
const KILL_MS = 500;

/**
 * Installed .desktop applications. Lists XDG entries, matches exact desktop id
 * or Name, launches with gio launch /abs.desktop or gtk-launch id.
 *
 * Never interpolates into a shell or runs the user's Exec line. Abort kills
 * only the gio/gtk-launch child. A launched GUI is left running.
 *
 * new AppLauncher({ execFileImpl, env, dataDirs, allowTerminal, gio, gtkLaunch, timeoutMs })
 * list() -> { apps: [{ id, name, desktopFile, terminal, available, startupWmClass }] }
 * match(query) -> app  or throw app_not_installed / app_ambiguous: id (name), ...
 * launch({ id|name|app, args?, signal?, workspace? }) ->
 *   { dispatched: true, id, name, desktopFile, startupWmClass, workspace? }
 *
 * workspace is a plain positive id or exact name/special. Placement uses
 * hyprctl dispatch of typed hl.dsp.exec_cmd wrapping gio launch; never the
 * desktop Exec line. Missing workspace keeps gio/gtk-launch. Abort kills
 * only the owned hyprctl/gio/gtk-launch child.
 */

function unescapeDesktop(value) {
  return String(value).replace(/\\(.)/g, (_, ch) => {
    if (ch === 's') return ' ';
    if (ch === 'n') return '\n';
    if (ch === 't') return '\t';
    if (ch === 'r') return '\r';
    if (ch === '\\') return '\\';
    return ch;
  });
}

function isTrue(value) {
  return String(value || '').trim().toLowerCase() === 'true';
}

function parseDesktopFile(text) {
  if (typeof text !== 'string') return null;
  const fields = {};
  let inEntry = false;
  for (const line of text.split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('[')) {
      inEntry = line.trim() === '[Desktop Entry]';
      continue;
    }
    if (!inEntry) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq);
    if (!fields[key]) fields[key] = unescapeDesktop(line.slice(eq + 1));
  }
  return fields;
}

function desktopId(relative) {
  return String(relative).replace(/\\/g, '/').replace(/^\/+/, '').replaceAll('/', '-');
}

function defaultDataDirs(env = process.env) {
  const home = env.HOME || os.homedir();
  const dataHome = env.XDG_DATA_HOME || (home ? path.join(home, '.local/share') : '');
  const dataDirs = String(env.XDG_DATA_DIRS || '/usr/local/share:/usr/share').split(':').filter(Boolean);
  const dirs = [];
  if (dataHome) dirs.push(dataHome);
  for (const dir of dataDirs) {
    if (dir && !dirs.includes(dir)) dirs.push(dir);
  }
  return dirs.map(dir => path.join(dir, 'applications'));
}

function walkDesktopFiles(root, relative, found) {
  let entries;
  try { entries = fs.readdirSync(path.join(root, relative), { withFileTypes: true }); }
  catch { return; }
  for (const entry of entries) {
    const rel = relative ? path.join(relative, entry.name) : entry.name;
    if (entry.isDirectory()) {
      walkDesktopFiles(root, rel, found);
      continue;
    }
    if (!(entry.isFile() || entry.isSymbolicLink()) || !entry.name.endsWith('.desktop')) continue;
    found.push(rel);
  }
}

function firstExecToken(exec) {
  const text = String(exec || '').trim();
  if (!text) return '';
  if (text.startsWith('"')) {
    const end = text.indexOf('"', 1);
    return end > 1 ? text.slice(1, end) : '';
  }
  return text.split(/\s+/)[0] || '';
}

function commandAvailable(command, env) {
  if (!command || command.includes('\0') || command.includes('..')) return false;
  if (command.includes('/') ) {
    try { fs.accessSync(command, fs.constants.X_OK); return true; }
    catch { return false; }
  }
  const dirs = String(env.PATH || '').split(':').filter(Boolean);
  for (const dir of dirs) {
    try { fs.accessSync(path.join(dir, command), fs.constants.X_OK); return true; }
    catch { /* try next */ }
  }
  return false;
}

function parseArgs(value) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw Error('invalid_args');
  if (value.length > MAX_ARGS) throw Error('invalid_args');
  if (value.some(item => typeof item !== 'string' || item.includes('\0') || item.length > MAX_ARG_LENGTH)) throw Error('invalid_args');
  return value;
}

class AppLauncher {
  constructor({
    execFileImpl = execFile,
    env = process.env,
    dataDirs,
    allowTerminal = false,
    gio = 'gio',
    gtkLaunch = 'gtk-launch',
    timeoutMs = LAUNCH_TIMEOUT_MS,
  } = {}) {
    this.execFileImpl = execFileImpl;
    this.env = env;
    this.dataDirs = Array.isArray(dataDirs) && dataDirs.length ? dataDirs : defaultDataDirs(env);
    this.allowTerminal = allowTerminal === true;
    this.gio = gio;
    this.gtkLaunch = gtkLaunch;
    this.timeoutMs = timeoutMs;
    this.generation = 0;
    this.child = null;
  }

  get pid() {
    const pid = this.child?.pid;
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  }

  readEntry(dir, relative) {
    const desktopFile = path.join(dir, relative);
    const id = desktopId(relative);
    if (!id.endsWith('.desktop') || id.includes('..')) return { id, tombstone: true };
    let text;
    try {
      const stat = fs.statSync(desktopFile);
      if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_DESKTOP_BYTES) return { id, tombstone: true };
      text = fs.readFileSync(desktopFile, 'utf8');
    } catch { return { id, tombstone: true }; }
    const fields = parseDesktopFile(text);
    if (!fields) return { id, tombstone: true };
    if (isTrue(fields.Hidden) || isTrue(fields.NoDisplay)) return { id, tombstone: true };
    const type = fields.Type || 'Application';
    if (type !== 'Application') return { id, tombstone: true };
    const terminal = isTrue(fields.Terminal);
    if (terminal && !this.allowTerminal) return { id, tombstone: true };
    const name = String(fields.Name || '').trim();
    if (!name) return { id, tombstone: true };
    const exec = String(fields.Exec || '').trim();
    if (!exec && !isTrue(fields.DBusActivatable)) return { id, tombstone: true };
    const tryExec = String(fields.TryExec || '').trim();
    const probe = tryExec || firstExecToken(exec);
    const available = !probe || commandAvailable(probe, this.env);
    const startupWmClass = String(fields.StartupWMClass || '').trim();
    return {
      id,
      name,
      desktopFile,
      terminal,
      available,
      startupWmClass: startupWmClass || null,
    };
  }

  collect() {
    const byId = new Map();
    for (const dir of this.dataDirs) {
      const found = [];
      walkDesktopFiles(dir, '', found);
      for (const relative of found) {
        const id = desktopId(relative);
        if (byId.has(id)) continue;
        byId.set(id, this.readEntry(dir, relative));
      }
    }
    return [...byId.values()].filter(entry => entry && !entry.tombstone).sort((a, b) => a.id.localeCompare(b.id));
  }

  list() {
    return { apps: this.collect() };
  }

  match(query) {
    const wanted = String(query || '').trim().toLowerCase();
    if (!wanted) throw Error('invalid_app');
    const apps = this.collect();
    const stem = wanted.endsWith('.desktop') ? wanted : wanted + '.desktop';
    const matches = apps.filter(app => {
      const id = app.id.toLowerCase();
      return id === wanted || id === stem || app.name.toLowerCase() === wanted;
    });
    if (!matches.length) throw Error('app_not_installed');
    const unique = [];
    for (const app of matches) {
      if (!unique.some(item => item.desktopFile === app.desktopFile)) unique.push(app);
    }
    if (unique.length > 1) {
      throw Error('app_ambiguous: ' + unique.map(app => `${app.id} (${app.name})`).join(', '));
    }
    const app = unique[0];
    if (!app.available) throw Error('app_not_installed');
    return app;
  }

  run(command, args, signal) {
    const generation = this.generation;
    return new Promise((resolve, reject) => {
      let child;
      try {
        child = this.execFileImpl(command, args, {
          env: this.env,
          timeout: this.timeoutMs,
          encoding: 'utf8',
          signal,
        }, (error, stdout, stderr) => {
          if (this.child === child) this.child = null;
          if (generation !== this.generation) {
            reject(Error('stopped_by_user'));
            return;
          }
          if (error) {
            error.stdout = stdout;
            error.stderr = stderr;
            reject(error);
          } else resolve({ stdout, stderr });
        });
      } catch (error) {
        reject(error);
        return;
      }
      this.child = child;
      if (!child) reject(Error('launcher_unavailable'));
    });
  }

  async launch(args = {}) {
    const query = args.id || args.name || args.app;
    if (query == null || query === '') throw Error('invalid_app');
    const extra = parseArgs(args.args ?? args.uris);
    const app = this.match(query);
    if (args.desktopFile && path.resolve(args.desktopFile) !== path.resolve(app.desktopFile)) {
      throw Error('app_not_installed');
    }
    if (args.signal?.aborted) throw Error('stopped_by_user');
    const gtkId = app.id.replace(/\.desktop$/i, '');
    const workspace = args.workspace;
    if (workspace != null && workspace !== '') {
      const expr = execLaunchDispatch([this.gio, 'launch', app.desktopFile, ...extra], workspace);
      try {
        const result = await this.run('hyprctl', ['dispatch', expr], args.signal);
        if (String(result.stdout || '').trim() !== 'ok') throw Error('launch_failed');
      } catch (error) {
        if (error?.message === 'stopped_by_user' || args.signal?.aborted) throw Error('stopped_by_user');
        if (error?.message === 'launch_failed') throw error;
        if (error?.code === 'ENOENT') throw Error('hyprland_unavailable');
        throw Error(String(error.message || 'launch_failed').slice(0, 200));
      }
      return {
        dispatched: true,
        id: app.id,
        name: app.name,
        desktopFile: app.desktopFile,
        startupWmClass: app.startupWmClass,
        workspace,
      };
    }
    try {
      await this.run(this.gio, ['launch', app.desktopFile, ...extra], args.signal);
    } catch (error) {
      if (error?.message === 'stopped_by_user' || args.signal?.aborted) throw Error('stopped_by_user');
      if (error?.code !== 'ENOENT') throw Error(String(error.message || 'launch_failed').slice(0, 200));
      try {
        await this.run(this.gtkLaunch, [gtkId, ...extra], args.signal);
      } catch (fallback) {
        if (fallback?.message === 'stopped_by_user' || args.signal?.aborted) throw Error('stopped_by_user');
        if (fallback?.code === 'ENOENT') throw Error('launcher_unavailable');
        throw Error(String(fallback.message || 'launch_failed').slice(0, 200));
      }
    }
    return { dispatched: true, id: app.id, name: app.name, desktopFile: app.desktopFile, startupWmClass: app.startupWmClass };
  }

  stop() {
    this.generation++;
    const child = this.child;
    this.child = null;
    if (!child) return;
    try { child.kill('SIGTERM'); } catch { /* owned launcher already gone */ }
    const timer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        try { child.kill('SIGKILL'); } catch { /* owned launcher already gone */ }
      }
    }, KILL_MS);
    timer.unref?.();
    child.once?.('exit', () => clearTimeout(timer));
  }
}

module.exports = { AppLauncher, parseDesktopFile, desktopId };
