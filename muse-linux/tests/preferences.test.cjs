const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { Preferences, defaults } = require('../src/preferences.cjs');

const ROOT = '/tmp/muse-port-d6c9/parity/prefs-commands';

async function tempDir(t) {
  await fs.mkdir(ROOT, { recursive: true });
  const dir = await fs.mkdtemp(path.join(ROOT, 'prefs-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

test('load/set/save keep defaults, values, and id', async t => {
  const dir = await tempDir(t);
  const file = path.join(dir, 'linux-permissions.json');
  const prefs = new Preferences(file);
  const values = await prefs.load();
  assert.equal(values, prefs.values);
  assert.equal(typeof prefs.id, 'string');
  assert.match(prefs.id, /^[a-f0-9-]{36}$/);
  assert.equal(prefs.values.browserPolicy, 'deny');
  assert.equal(prefs.values.desktopPolicy, 'ask');
  assert.equal(prefs.values.commandPolicy, 'deny');
  assert.equal(prefs.values.fileWritePolicy, 'ask');
  assert.equal(prefs.values.folder, null);
  assert.equal(prefs.values.rememberFolder, true);
  assert.equal(prefs.values.theme, 'system');
  assert.deepEqual(prefs.values.blockedApps, []);
  assert.equal(defaults.commandPolicy, 'deny');
  await prefs.set('theme', 'dark');
  assert.equal(prefs.values.theme, 'dark');
  const disk = await readJson(file);
  assert.equal(disk.id, prefs.id);
  assert.equal(disk.theme, 'dark');
  const again = new Preferences(file);
  await again.load();
  assert.equal(again.id, prefs.id);
  assert.equal(again.values.theme, 'dark');
});

test('old browserEnabled/browserAutoApprove migrate only when browserPolicy is absent', async t => {
  const dir = await tempDir(t);
  const file = path.join(dir, 'linux-permissions.json');
  await fs.writeFile(file, JSON.stringify({
    id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    browserEnabled: true,
    browserAutoApprove: true,
    folder: dir,
    rememberFolder: true,
  }));
  const prefs = new Preferences(file);
  await prefs.load();
  assert.equal(prefs.values.browserPolicy, 'allow');
  const askFile = path.join(dir, 'ask.json');
  await fs.writeFile(askFile, JSON.stringify({ browserEnabled: true, browserAutoApprove: false, rememberFolder: true }));
  const ask = new Preferences(askFile);
  await ask.load();
  assert.equal(ask.values.browserPolicy, 'ask');
  const denyFile = path.join(dir, 'deny.json');
  await fs.writeFile(denyFile, JSON.stringify({ browserEnabled: false, browserAutoApprove: true, rememberFolder: true }));
  const deny = new Preferences(denyFile);
  await deny.load();
  assert.equal(deny.values.browserPolicy, 'deny');
  const explicit = path.join(dir, 'explicit.json');
  await fs.writeFile(explicit, JSON.stringify({ browserPolicy: 'deny', browserEnabled: true, browserAutoApprove: true, rememberFolder: true }));
  const kept = new Preferences(explicit);
  await kept.load();
  assert.equal(kept.values.browserPolicy, 'deny');
});

test('folder grant is remembered only when rememberFolder is explicitly true', async t => {
  const dir = await tempDir(t);
  const granted = path.join(dir, 'granted');
  await fs.mkdir(granted);
  const missing = path.join(dir, 'missing-flag.json');
  await fs.writeFile(missing, JSON.stringify({ folder: granted, rememberFolder: undefined, browserPolicy: 'ask' }));
  const dropped = new Preferences(missing);
  await dropped.load();
  assert.equal(dropped.values.folder, null);
  const falseFile = path.join(dir, 'false-flag.json');
  await fs.writeFile(falseFile, JSON.stringify({ folder: granted, rememberFolder: false }));
  const refused = new Preferences(falseFile);
  await refused.load();
  assert.equal(refused.values.folder, null);
  const remembered = path.join(dir, 'remembered.json');
  await fs.writeFile(remembered, JSON.stringify({ folder: granted, rememberFolder: true }));
  const kept = new Preferences(remembered);
  await kept.load();
  assert.equal(kept.values.folder, granted);
  await kept.set('rememberFolder', false);
  assert.equal(kept.values.folder, granted);
  assert.equal((await readJson(remembered)).folder, null);
  const linkDir = path.join(dir, 'real');
  await fs.mkdir(linkDir);
  const link = path.join(dir, 'link');
  await fs.symlink(linkDir, link);
  const linked = path.join(dir, 'linked.json');
  await fs.writeFile(linked, JSON.stringify({ folder: link, rememberFolder: true }));
  const noLink = new Preferences(linked);
  await noLink.load();
  assert.equal(noLink.values.folder, null);
});

test('schema accepts typed policies and native behavior settings and rejects the rest', async t => {
  const dir = await tempDir(t);
  const prefs = new Preferences(path.join(dir, 'linux-permissions.json'));
  await prefs.load();
  for (const key of ['browserPolicy', 'desktopPolicy', 'commandPolicy', 'fileWritePolicy']) {
    await prefs.set(key, 'ask');
    await prefs.set(key, 'allow');
    await prefs.set(key, 'deny');
    await assert.rejects(prefs.set(key, 'always'), /invalid_permission/);
    await assert.rejects(prefs.set(key, true), /invalid_permission/);
  }
  await prefs.set('theme', 'light');
  await prefs.set('startAtLogin', true);
  await prefs.set('keepAwake', true);
  await prefs.set('dictationEnabled', true);
  await prefs.set('dictationAutoSend', true);
  await prefs.set('dictationLanguage', 'en');
  await prefs.set('quickShortcut', 'Control+Shift+M');
  await prefs.set('dictationShortcut', 'Super+Space');
  await prefs.set('blockedApps', ['firefox', 'chromium']);
  await prefs.set('folder', dir);
  await assert.rejects(prefs.set('theme', 'solarized'), /invalid_theme/);
  await assert.rejects(prefs.set('folder', 'relative'), /invalid_folder/);
  await assert.rejects(prefs.set('blockedApps', ['x'.repeat(201)]), /invalid_app_list/);
  await assert.rejects(prefs.set('quickShortcut', 'control+m'), /invalid_shortcut/);
  await assert.rejects(prefs.set('unknown', true), /unknown_setting/);
  await assert.rejects(prefs.set('keepAwake', 'yes'), /invalid_setting/);
  const disk = await readJson(prefs.file);
  assert.equal(disk.commandPolicy, 'deny');
  assert.equal(disk.startAtLogin, true);
  assert.equal(disk.keepAwake, true);
  assert.equal(disk.browserEnabled, false);
  assert.equal(disk.browserAutoApprove, false);
  await prefs.set('browserPolicy', 'allow');
  const enabled = await readJson(prefs.file);
  assert.equal(enabled.browserEnabled, true);
  assert.equal(enabled.browserAutoApprove, true);
});

test('queued writes stay atomic and last complete snapshot wins', async t => {
  const dir = await tempDir(t);
  const file = path.join(dir, 'linux-permissions.json');
  const prefs = new Preferences(file);
  await prefs.load();
  await Promise.all([
    prefs.set('theme', 'dark'),
    prefs.set('keepAwake', true),
    prefs.set('dictationLanguage', 'ja'),
    prefs.set('commandPolicy', 'ask'),
  ]);
  const disk = await readJson(file);
  assert.equal(disk.theme, 'dark');
  assert.equal(disk.keepAwake, true);
  assert.equal(disk.dictationLanguage, 'ja');
  assert.equal(disk.commandPolicy, 'ask');
  assert.equal(disk.id, prefs.id);
  const leftovers = (await fs.readdir(dir)).filter(name => name.endsWith('.new'));
  assert.deepEqual(leftovers, []);
  const mode = (await fs.stat(file)).mode & 0o777;
  assert.equal(mode, 0o600);
});

test('blockedApps is copied so callers cannot mutate defaults or the live snapshot', async t => {
  const dir = await tempDir(t);
  const prefs = new Preferences(path.join(dir, 'linux-permissions.json'));
  await prefs.load();
  prefs.values.blockedApps.push('mutated');
  assert.deepEqual(defaults.blockedApps, []);
  await prefs.set('blockedApps', ['kitty']);
  const stored = prefs.values.blockedApps;
  stored.push('ghost');
  assert.deepEqual(prefs.values.blockedApps, ['kitty', 'ghost']);
  assert.deepEqual((await readJson(prefs.file)).blockedApps, ['kitty']);
});
