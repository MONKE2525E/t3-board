'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { SessionManager, sanitizedEnvironment, ProcessOwner, profileLease, sameProcess, identity, createSessionExecutableAllowlist } = require('../../src/computer/session/index.cjs');
const { allocate } = require('../../src/computer/session/resources.cjs');
const { ScopedRunner } = require('../../src/computer/session/runner.cjs');
const root = '/tmp/muse-port-d6c9/rewrite/impl-session';
fs.mkdirSync(root, { recursive: true, mode: 0o700 });
function fixtureDir() { const dir = fs.mkdtempSync(path.join(root, 't-')); fs.chmodSync(dir, 0o700); return dir; }
const clock = { now: () => performance.now(), domain: 'test.performance' };
const context = () => ({ budget: { clockDomain: clock.domain, deadlineMonoMs: clock.now() + 2000 }, signal: new AbortController().signal });
const request = { mode: 'isolated_desktop', task: 'synthetic', viewer: 'none', fileGrantIds: [], network: 'deny', sandboxRequired: false };

test('private allocation rejects unsafe parents and never inherits host display/bus secrets', () => {
  const base = fixtureDir();
  try {
    fs.chmodSync(base, 0o755); assert.throws(() => allocate(base), { code: 'unsafe_runtime' }); fs.chmodSync(base, 0o700);
    const dirs = allocate(base), env = sanitizedEnvironment(dirs);
    for (const key of ['DISPLAY', 'WAYLAND_DISPLAY', 'DBUS_SESSION_BUS_ADDRESS', 'AT_SPI_BUS_ADDRESS', 'HYPRLAND_INSTANCE_SIGNATURE', 'SSH_AUTH_SOCK', 'DBUS_STARTER_ADDRESS', 'XAUTHORITY']) assert.equal(Object.hasOwn(env, key), false);
    for (const key of ['HOME', 'XDG_RUNTIME_DIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME']) assert.ok(env[key].startsWith(dirs.root + '/'));
    assert.equal(env.WLR_BACKENDS, 'headless'); assert.equal(env.WLR_RENDERER, 'pixman');
    for (const dir of Object.values(dirs)) assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('profile exclusive lock is atomic, rejects duplicate ownership, never repairs an existing lock', () => {
  const dir = fixtureDir();
  try {
    const first = profileLease(dir, 'first'); assert.throws(() => profileLease(dir, 'second'), { code: 'profile_locked' });
    const raw = fs.readFileSync(path.join(dir, '.muse-lease'), 'utf8');
    assert.throws(() => profileLease(dir, 'second'), { code: 'profile_locked' }); assert.equal(fs.readFileSync(path.join(dir, '.muse-lease'), 'utf8'), raw);
    assert.equal(first.release(), true); const second = profileLease(dir, 'second'); assert.equal(second.release(), true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('missing Cage fails closed before creating runtime or calling an app', async () => {
  const base = fixtureDir();
  const manager = new SessionManager({ runtimeBase: base, dependencies: { bwrap: '/usr/bin/bwrap', cage: path.join(base, 'missing') },
    executables: {}, authorize: async () => true, readyProbe: async () => { throw Error('unexpected'); }, clock });
  try { await assert.rejects(manager.create(request, context()), { code: 'cage_unavailable' }); assert.deepEqual(fs.readdirSync(base), []); }
  finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('unsupported backend, viewer, confidentiality sandbox, dimensions and file grants cannot fall back', async () => {
  const base = fixtureDir(), manager = new SessionManager({ runtimeBase: base, dependencies: {}, executables: {}, authorize: async () => true, clock });
  try {
    for (const patch of [{ backend: 'hyprland_nested' }, { mode: 'real_desktop' }, { viewer: 'explicit' }, { sandboxRequired: true }, { dimensions: { width: 100, height: 100, scale: 1 } }, { fileGrantIds: ['unknown'] }]) {
      await assert.rejects(manager.create({ ...request, ...patch }, context())); assert.deepEqual(fs.readdirSync(base), []);
    }
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('permission policy is mandatory and budget expiry rejects before allocation', async () => {
  const base = fixtureDir();
  try {
    const manager = new SessionManager({ runtimeBase: base, dependencies: {}, executables: {}, clock });
    await assert.rejects(manager.create(request, context()), { code: 'permission_denied' });
    await assert.rejects(manager.create(request, { ...context(), budget: { clockDomain: clock.domain, deadlineMonoMs: 0 } }), { code: 'deadline' });
    assert.deepEqual(fs.readdirSync(base), []);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('reused leader PID never receives a signal or transfers group ownership', async () => {
  const base = fixtureDir(); let signals = 0;
  try {
    fs.writeFileSync(path.join(base, '100'), '');
    const old = { pid: 100, startToken: 'old', parentId: 1, groupId: 100, sessionId: 100, zombie: false };
    let row = old;
    const owner = new ProcessOwner({ procRoot: base, readIdentity: () => row, signal: () => signals++ });
    const group = owner.add({ pid: 100 }); row = { ...old, startToken: 'reused' };
    assert.equal(sameProcess(old, row), false); assert.equal(await owner.stop(group, 100), false); assert.equal(signals, 0);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('runner rejects ambient executables, raw shell arguments, missing budgets and stale generations before spawn', async () => {
  let spawns = 0, stale = false;
  const runner = new ScopedRunner({ executables: { own: { path: '/bin/true', validateArgs: a => a.length === 0, access: 'read' } },
    environment: {}, directories: { home: root, root }, network: 'deny', bwrap: '/usr/bin/bwrap', clock,
    validate() { if (stale) throw Object.assign(new Error('stale'), { code: 'stale_session_generation' }); }, spawn() { spawns++; throw Error('unexpected'); } });
  await assert.rejects(runner.spawn('sh', ['-c', 'evil'], context()), { code: 'executable_not_allowed' });
  await assert.rejects(runner.spawn('own', ['unexpected'], context()), { code: 'argv_not_allowed' });
  await assert.rejects(runner.spawn('own', [], {}), { code: 'invalid_budget' });
  stale = true; await assert.rejects(runner.spawn('own', [], context()), { code: 'stale_session_generation' }); assert.equal(spawns, 0);
});

test('internal calibration app is refused before authorization', async () => {
  let authorized = 0;
  const manager = new SessionManager({ runtimeBase: root, dependencies: {}, executables: {}, clock,
    apps: { calibration: { internalOnly: true } }, authorize: () => { authorized++; return true; } });
  manager.sessions.set('owned', { descriptor: { id: 'owned' } });
  await assert.rejects(manager.launch('owned', { appId: 'calibration', args: [] }, context()), { code: 'app_not_allowed' });
  assert.equal(authorized, 0);
  const entries = createSessionExecutableAllowlist({ fixture: '/bin/true' });
  assert.equal(entries.readinessFixture.internalOnly, true);
});

test('persistent owned channel outlives startup deadline, fences each write, and ends on explicit cancellation', { timeout: 5000 }, async () => {
  const base = fixtureDir(), dirs = allocate(base), controller = new AbortController();
  let paused = false;
  const runner = new ScopedRunner({ executables: {
    persistent: { path: '/usr/bin/cat', persistent: true, validateArgs: a => !a.length,
      messageAccess: bytes => bytes.toString() === 'read\n' ? 'read' : 'mutation' },
  }, environment: sanitizedEnvironment(dirs), directories: dirs, network: 'deny', bwrap: '/usr/bin/bwrap', clock,
    validate: access => { if (paused && access !== 'read') throw Object.assign(Error('session_paused'), { code: 'session_paused' }); } });
  let channel;
  try {
    const deadline = clock.now() + 100;
    channel = await runner.spawn('persistent', [], { budget: { clockDomain: clock.domain, deadlineMonoMs: deadline }, signal: controller.signal });
    await new Promise(resolve => setTimeout(resolve, Math.max(1, deadline - clock.now() + 30)));
    assert.equal(sameProcess(identity(channel.process.pid), channel.process), true);
    await assert.rejects(channel.write(Buffer.from('mutation\n'), { budget: { clockDomain: clock.domain, deadlineMonoMs: deadline }, signal: controller.signal }), { code: 'deadline' });
    paused = true;
    await assert.rejects(channel.write(Buffer.from('mutation\n'), context()), { code: 'session_paused' });
    const received = new Promise(resolve => { const off = channel.subscribe(bytes => { if (bytes.toString().includes('read\n')) { off(); resolve(); } }); });
    await channel.write(Buffer.from('read\n'), context()); await received;
    controller.abort();
    assert.equal((await channel.stop(context().budget)).state, 'confirmed');
    assert.equal(sameProcess(identity(channel.process.pid), channel.process) && !identity(channel.process.pid)?.zombie, false);
  } finally {
    if (channel) await channel.stop(context().budget);
    fs.rmSync(base, { recursive: true, force: true });
  }
});
