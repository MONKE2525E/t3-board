'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { AppLauncher, parseDesktopFile, desktopId } = require('../src/app-launcher.cjs');

function tempDirs(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-apps-'));
  const user = path.join(root, 'user');
  const system = path.join(root, 'system');
  fs.mkdirSync(user, { recursive: true });
  fs.mkdirSync(system, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { user, system };
}

function writeDesktop(dir, relative, body) {
  const full = path.join(dir, relative);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, body);
  return full;
}

const FIREFOX = `[Desktop Entry]
Type=Application
Name=Firefox
Exec=true
StartupWMClass=firefox
`;

test('parseDesktopFile and nested desktop ids', () => {
  const fields = parseDesktopFile(`${FIREFOX}Hidden=false\n`);
  assert.equal(fields.Name, 'Firefox');
  assert.equal(fields.StartupWMClass, 'firefox');
  assert.equal(desktopId('foo/bar.desktop'), 'foo-bar.desktop');
});

test('list returns startupWmClass and skips Hidden NoDisplay terminal', t => {
  const { user } = tempDirs(t);
  writeDesktop(user, 'firefox.desktop', FIREFOX);
  writeDesktop(user, 'hidden.desktop', `[Desktop Entry]\nType=Application\nName=Hidden\nExec=true\nHidden=true\n`);
  writeDesktop(user, 'nodisp.desktop', `[Desktop Entry]\nType=Application\nName=No\nExec=true\nNoDisplay=true\n`);
  writeDesktop(user, 'term.desktop', `[Desktop Entry]\nType=Application\nName=Term\nExec=true\nTerminal=true\n`);
  const apps = new AppLauncher({ dataDirs: [user], env: { PATH: '/usr/bin' } });
  const listed = apps.list().apps;
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, 'firefox.desktop');
  assert.equal(listed[0].startupWmClass, 'firefox');
  assert.equal(listed[0].name, 'Firefox');
});

test('a hidden user override is a tombstone and does not fall through to the system id', t => {
  const { user, system } = tempDirs(t);
  writeDesktop(user, 'firefox.desktop', `[Desktop Entry]\nType=Application\nName=Firefox\nExec=true\nHidden=true\n`);
  writeDesktop(system, 'firefox.desktop', FIREFOX);
  const apps = new AppLauncher({ dataDirs: [user, system], env: { PATH: '/usr/bin' } });
  assert.deepEqual(apps.list().apps, []);
  assert.throws(() => apps.match('Firefox'), /app_not_installed/);
  assert.throws(() => apps.match('firefox.desktop'), /app_not_installed/);
});

test('exact id and name match, ambiguity lists ids and names', t => {
  const { user } = tempDirs(t);
  writeDesktop(user, 'one.desktop', `[Desktop Entry]\nType=Application\nName=Notes\nExec=true\nStartupWMClass=notes1\n`);
  writeDesktop(user, 'two.desktop', `[Desktop Entry]\nType=Application\nName=Notes\nExec=true\nStartupWMClass=notes2\n`);
  writeDesktop(user, 'ok.desktop', `[Desktop Entry]\nType=Application\nName=Only\nExec=true\n`);
  const apps = new AppLauncher({ dataDirs: [user], env: { PATH: '/usr/bin' } });
  const matched = apps.match('ok.desktop');
  assert.equal(matched.name, 'Only');
  assert.equal(matched.startupWmClass, null);
  assert.throws(() => apps.match('Notes'), /app_ambiguous: one\.desktop \(Notes\), two\.desktop \(Notes\)/);
  assert.throws(() => apps.match('missing'), /app_not_installed/);
});

test('launch uses gio launch with the absolute desktop file and returns startupWmClass', async t => {
  const { user } = tempDirs(t);
  const desktopFile = writeDesktop(user, 'firefox.desktop', FIREFOX);
  const calls = [];
  const apps = new AppLauncher({
    dataDirs: [user],
    env: { PATH: '/usr/bin' },
    execFileImpl: (command, args, opts, cb) => {
      calls.push({ command, args });
      queueMicrotask(() => cb(null, '', ''));
      return { pid: 9, kill() {}, once() {}, exitCode: 0, signalCode: null };
    },
  });
  const result = await apps.launch({ id: 'Firefox' });
  assert.deepEqual(result, { dispatched: true, id: 'firefox.desktop', name: 'Firefox', desktopFile, startupWmClass: 'firefox' });
  assert.deepEqual(calls, [{ command: 'gio', args: ['launch', desktopFile] }]);
});

test('gtk-launch is used only when gio is missing with ENOENT', async t => {
  const { user } = tempDirs(t);
  writeDesktop(user, 'firefox.desktop', FIREFOX);
  const calls = [];
  const apps = new AppLauncher({
    dataDirs: [user],
    env: { PATH: '/usr/bin' },
    execFileImpl: (command, args, opts, cb) => {
      calls.push(command);
      const error = new Error(command === 'gio' ? 'missing' : 'ok');
      if (command === 'gio') {
        error.code = 'ENOENT';
        queueMicrotask(() => cb(error, '', ''));
      } else queueMicrotask(() => cb(null, '', ''));
      return { pid: 9, kill() {}, once() {}, exitCode: command === 'gio' ? null : 0, signalCode: null };
    },
  });
  assert.equal((await apps.launch({ name: 'firefox.desktop' })).dispatched, true);
  assert.deepEqual(calls, ['gio', 'gtk-launch']);
});

test('a gio launch failure other than ENOENT does not also gtk-launch', async t => {
  const { user } = tempDirs(t);
  writeDesktop(user, 'firefox.desktop', FIREFOX);
  const calls = [];
  const apps = new AppLauncher({
    dataDirs: [user],
    env: { PATH: '/usr/bin' },
    execFileImpl: (command, args, opts, cb) => {
      calls.push(command);
      const error = new Error('busy');
      error.code = 'EIO';
      queueMicrotask(() => cb(error, '', 'busy'));
      return { pid: 9, kill() {}, once() {}, exitCode: 1, signalCode: null };
    },
  });
  await assert.rejects(apps.launch({ id: 'firefox.desktop' }), /busy/);
  assert.deepEqual(calls, ['gio']);
});

test('abort kills only the owned launcher process', async t => {
  const { user } = tempDirs(t);
  writeDesktop(user, 'firefox.desktop', FIREFOX);
  const child = new EventEmitter();
  child.pid = 77;
  child.kills = [];
  child.exitCode = null;
  child.signalCode = null;
  child.kill = signal => { child.kills.push(signal); child.signalCode = signal; };
  child.once = (event, fn) => child.on(event, fn);
  const apps = new AppLauncher({
    dataDirs: [user],
    env: { PATH: '/usr/bin' },
    execFileImpl: (command, args, opts, cb) => {
      opts.signal?.addEventListener('abort', () => {
        child.kill('SIGTERM');
        const error = new Error('aborted');
        error.message = 'stopped_by_user';
        cb(error, '', '');
      }, { once: true });
      return child;
    },
  });
  t.after(() => apps.stop());
  const controller = new AbortController();
  const pending = apps.launch({ id: 'firefox.desktop', signal: controller.signal });
  await new Promise(resolve => setImmediate(resolve));
  controller.abort();
  await assert.rejects(pending, /stopped_by_user/);
  assert.equal(child.kills[0], 'SIGTERM');
});

test('Flatpak-style desktop symlinks are discovered without following directory loops', t => {
  const { user, system } = tempDirs(t);
  const file = writeDesktop(system, 'flatpak.desktop', FIREFOX);
  fs.symlinkSync(file, path.join(user, 'org.test.Flatpak.desktop'));
  fs.symlinkSync(user, path.join(user, 'loop'));
  fs.symlinkSync(path.join(user, 'missing'), path.join(user, 'firefox.desktop'));
  writeDesktop(system, 'firefox.desktop', FIREFOX);
  const apps = new AppLauncher({ dataDirs: [user, system], env: { PATH: '/usr/bin' } });
  assert.equal(apps.match('org.test.Flatpak.desktop').desktopFile, path.join(user, 'org.test.Flatpak.desktop'));
  assert.equal(apps.list().apps.some(app=>app.id==='firefox.desktop'), false);
});

test('launch with a plain workspace dispatches typed exec_cmd wrapping gio, not the Exec line', async t => {
  const { user } = tempDirs(t);
  const desktopFile = writeDesktop(user, 'firefox.desktop', `[Desktop Entry]
Type=Application
Name=Firefox
Exec=true --token=s3cret
StartupWMClass=firefox
`);
  const calls = [];
  const apps = new AppLauncher({
    dataDirs: [user],
    env: { PATH: '/usr/bin' },
    execFileImpl: (command, args, opts, cb) => {
      calls.push({ command, args: [...args] });
      queueMicrotask(() => cb(null, 'ok\n', ''));
      return { pid: 11, kill() {}, once() {}, exitCode: 0, signalCode: null };
    },
  });
  const result = await apps.launch({ id: 'firefox.desktop', workspace: 3 });
  assert.deepEqual(result, {
    dispatched: true, id: 'firefox.desktop', name: 'Firefox', desktopFile, startupWmClass: 'firefox', workspace: 3,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'hyprctl');
  assert.equal(calls[0].args[0], 'dispatch');
  assert.equal(
    calls[0].args[1],
    `hl.dsp.exec_cmd("'gio' 'launch' '${desktopFile}'", {workspace="3 silent",no_initial_focus=true})`,
  );
  assert.equal(String(calls[0].args[1]).includes('s3cret'), false);
  assert.equal(String(calls[0].args[1]).includes('/bin/evil'), false);
  assert.equal(calls.some(call => call.command === 'gio' || call.command === 'gtk-launch'), false);
});

test('launch accepts an absent numeric workspace id and a special name without querying clients', async t => {
  const { user } = tempDirs(t);
  const desktopFile = writeDesktop(user, 'firefox.desktop', FIREFOX);
  const exprs = [];
  const apps = new AppLauncher({
    dataDirs: [user],
    env: { PATH: '/usr/bin' },
    execFileImpl: (command, args, opts, cb) => {
      exprs.push(args[1]);
      queueMicrotask(() => cb(null, 'ok', ''));
      return { pid: 12, kill() {}, once() {}, exitCode: 0, signalCode: null };
    },
  });
  assert.equal((await apps.launch({ id: 'Firefox', workspace: 9 })).workspace, 9);
  assert.equal((await apps.launch({ id: 'Firefox', workspace: '1000' })).workspace, '1000');
  assert.equal((await apps.launch({ id: 'Firefox', workspace: 'special:magic' })).workspace, 'special:magic');
  assert.equal(
    exprs[0],
    `hl.dsp.exec_cmd("'gio' 'launch' '${desktopFile}'", {workspace="9 silent",no_initial_focus=true})`,
  );
  assert.equal(
    exprs[1],
    `hl.dsp.exec_cmd("'gio' 'launch' '${desktopFile}'", {workspace="1000 silent",no_initial_focus=true})`,
  );
  assert.equal(
    exprs[2],
    `hl.dsp.exec_cmd("'gio' 'launch' '${desktopFile}'", {workspace="special:magic silent",no_initial_focus=true})`,
  );
  await assert.rejects(apps.launch({ id: 'Firefox', workspace: '+1' }), /invalid_workspace/);
  await assert.rejects(apps.launch({ id: 'Firefox', workspace: 'previous' }), /invalid_workspace/);
});

test('workspace launch abort kills only the owned hyprctl child', async t => {
  const { user } = tempDirs(t);
  writeDesktop(user, 'firefox.desktop', FIREFOX);
  const child = new EventEmitter();
  child.pid = 88;
  child.kills = [];
  child.exitCode = null;
  child.signalCode = null;
  child.kill = signal => { child.kills.push(signal); child.signalCode = signal; };
  child.once = (event, fn) => child.on(event, fn);
  const apps = new AppLauncher({
    dataDirs: [user],
    env: { PATH: '/usr/bin' },
    execFileImpl: (command, args, opts, cb) => {
      assert.equal(command, 'hyprctl');
      opts.signal?.addEventListener('abort', () => {
        child.kill('SIGTERM');
        const error = new Error('aborted');
        error.message = 'stopped_by_user';
        cb(error, '', '');
      }, { once: true });
      return child;
    },
  });
  t.after(() => apps.stop());
  const controller = new AbortController();
  const pending = apps.launch({ id: 'firefox.desktop', workspace: 3, signal: controller.signal });
  await new Promise(resolve => setImmediate(resolve));
  controller.abort();
  await assert.rejects(pending, /stopped_by_user/);
  assert.equal(child.kills[0], 'SIGTERM');
});

test('missing hyprctl for a workspace launch is hyprland_unavailable and does not gtk-launch', async t => {
  const { user } = tempDirs(t);
  writeDesktop(user, 'firefox.desktop', FIREFOX);
  const calls = [];
  const apps = new AppLauncher({
    dataDirs: [user],
    env: { PATH: '/usr/bin' },
    execFileImpl: (command, args, opts, cb) => {
      calls.push(command);
      const error = new Error('missing');
      error.code = 'ENOENT';
      queueMicrotask(() => cb(error, '', ''));
      return { pid: 9, kill() {}, once() {}, exitCode: null, signalCode: null };
    },
  });
  await assert.rejects(apps.launch({ id: 'firefox.desktop', workspace: 3 }), /hyprland_unavailable/);
  assert.deepEqual(calls, ['hyprctl']);
});
