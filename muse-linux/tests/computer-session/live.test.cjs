'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const { SessionManager, ForeignToplevelClient, identity, sameProcess } = require('../../src/computer/session/index.cjs');
const base = '/tmp/muse-port-d6c9/rewrite/impl-session';
const prototype = '/tmp/muse-port-d6c9/rewrite/isolation-prototype';
const binaries = path.join(base, 'live-bin');
const clock = { now: () => performance.now(), domain: 'session.fixture' };
const budget = (ms = 15000) => ({ clockDomain: clock.domain, deadlineMonoMs: clock.now() + ms });
const context = (session, ms = 15000) => ({ sessionId: session?.id, revision: { sessionGeneration: session?.generation },
  budget: budget(ms), signal: new AbortController().signal,
  dispatch: { beforeEffect: async () => ({ id: crypto.randomUUID() }), afterEffect: async () => {} } });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function hostState() {
  const query = command => JSON.parse(cp.execFileSync('/usr/bin/hyprctl', ['-j', command], { encoding: 'utf8', timeout: 2000 }));
  try { return { clients: query('clients').map(x => ({ address: x.address, pid: x.pid, workspace: x.workspace.id, mapped: x.mapped, hidden: x.hidden, at: x.at, size: x.size })).sort((a, b) => a.address.localeCompare(b.address)),
    focused: query('activewindow').address, workspace: query('activeworkspace').id, cursor: query('cursorpos') }; }
  catch { return null; }
}
async function until(test, ms = 2000) {
  const end = clock.now() + ms;
  while (clock.now() < end) { const result = await test(); if (result) return result; await sleep(25); }
  throw Error('fixture_assertion_timeout');
}
function lineChannel(channel) {
  const lines = []; let pending = '';
  const unsubscribe = channel.subscribe(data => {
    pending += Buffer.from(data).toString('utf8');
    let index; while ((index = pending.indexOf('\n')) >= 0) { lines.push(pending.slice(0, index)); pending = pending.slice(index + 1); }
  });
  return { unsubscribe, async read(predicate) { return until(() => { const i = lines.findIndex(predicate); if (i >= 0) return lines.splice(i, 1)[0]; }); } };
}
async function helperRequest(channel, reader, req, ctx) {
  await channel.write(Buffer.from(JSON.stringify(req) + '\n'), ctx);
  const line = await reader.read(raw => { try { const x = JSON.parse(raw); return x.id === req.id && ['result', 'error'].includes(x.event); } catch { return false; } });
  const reply = JSON.parse(line); assert.equal(reply.event, 'result'); return reply;
}
async function a11y(session, client, command, more = [], input) {
  const result = await session.runner.exec('accessibilityFixture', [command, String(client.process.pid), 'Session primary fixture', '0', '0', '1280', '720', ...more],
    { ...context(session, 3000), encoding: 'utf8', maxBytes: 262144, ...(input !== undefined ? { input: Buffer.from(input) } : {}) });
  if (result.exitCode !== 0) throw Error('fixture_accessibility_' + result.exitCode + '_' + result.stdout);
  return JSON.parse(result.stdout);
}
async function semantic(session, client, label) {
  const observed = await a11y(session, client, 'observe');
  const control = observed.controls.find(x => x.label === label); assert.ok(control, label);
  return a11y(session, client, 'click', [control.path, control.label, control.role]);
}
async function capture(session, file) {
  const frame = await session.runner.exec('captureFixture', ['-o', 'HEADLESS-1', '-'], { ...context(session), encoding: 'buffer', maxBytes: 4194304 });
  assert.equal(frame.exitCode, 0); assert.equal(frame.outputTruncated, false); fs.writeFileSync(path.join(base, file), frame.stdout, { mode: 0o600 });
}
function options(sentinel) {
  return { runtimeBase: base, clock, libraryDirectories: [path.join(prototype, 'root/usr/lib')], authorize: async () => true,
    quiesce: async () => ({ state: 'confirmed', ownedInputReleased: true, reasonCodes: [] }),
    dependencies: { bwrap: '/usr/bin/bwrap', cage: path.join(prototype, 'root/usr/bin/cage'), dbusDaemon: '/usr/bin/dbus-daemon',
      atspiLauncher: '/usr/lib/at-spi-bus-launcher', atspiRegistry: '/usr/lib/at-spi2-registryd', gdbus: '/usr/bin/gdbus',
      keepalive: '/usr/bin/sleep', protocolProbe: path.join(base, 'wayland-session'), capture: '/usr/bin/grim' },
    executables: {
      fixture: { path: path.join(base, 'fixture'), validateArgs: a => a.length === 1 && a[0] === sentinel },
      accessibilityFixture: { path: path.join(binaries, 'muse-accessibility'), access: 'read', validateArgs: a => ['observe', 'click', 'type', 'focus'].includes(a[0]) && a.length >= 7 && /^\d+$/.test(a[1]) && a[2] === 'Session primary fixture' },
      captureFixture: { path: '/usr/bin/grim', access: 'read', validateArgs: a => a.join(' ') === '-o HEADLESS-1 -' },
      pointerFixture: { pidNamespace: false, path: path.join(binaries, 'muse-pointer'), validateArgs: a => a.length === 0 },
      keyboardFixture: { pidNamespace: false, path: path.join(binaries, 'muse-keyboard'), validateArgs: a => a.length === 0 },
      foreignToplevel: { path: path.join(base, 'wayland-session'), access: 'read', validateArgs: a => a.join(' ') === '--serve',
        messageAccess: message => { try { return JSON.parse(Buffer.from(message).toString('utf8')).op === 'list' ? 'read' : 'mutation'; } catch { return 'mutation'; } } },
    },
    apps: { 'muse-session-fixture': { executableId: 'fixture', validateArgs: a => a.length === 0, buildArgs: () => [sentinel] } },
    readyProbe: async ({ session, launch }) => {
      const client = await launch({ appId: 'muse-session-fixture', args: [] });
      const observed = await until(async () => { try { const tree = await a11y(session, client, 'observe'); return tree.controls.some(x => x.label === 'Synthetic editor') && tree; } catch { return false; } });
      await capture(session, `before-${sentinel}.png`);
      const editor = observed.controls.find(x => x.label === 'Synthetic editor'), text = 'Owned semantic café 日本語 😀';
      await a11y(session, client, 'type', [editor.path, editor.label], text);
      const stateFile = path.join(session.environment.HOME, 'state.txt');
      await until(() => fs.readFileSync(stateFile, 'utf8').endsWith(text));
      await a11y(session, client, 'focus', [editor.path, editor.label]);
      const keyboard = await session.runner.spawn('keyboardFixture', [], context(session));
      const kr = lineChannel(keyboard); await kr.read(x => x.includes('"ready"'));
      await helperRequest(keyboard, kr, { id: 'ready-key', action: 'type', text: ' K' }, context(session));
      await until(() => fs.readFileSync(stateFile, 'utf8').endsWith(text + ' K')); kr.unsubscribe(); await keyboard.stop(budget(700));
      const pointer = await session.runner.spawn('pointerFixture', [], context(session)), pr = lineChannel(pointer); await pr.read(x => x.includes('"ready"'));
      const control = (await a11y(session, client, 'observe')).controls.find(x => x.label === 'Synthetic increment'), b = control.bounds;
      await helperRequest(pointer, pr, { id: 'ready-point', action: 'click', point: { x: Math.round(b[0] + b[2] / 2), y: Math.round(b[1] + b[3] / 2), localX: Math.round(b[0] + b[2] / 2), localY: Math.round(b[1] + b[3] / 2), width: 1280, height: 720, output: 'HEADLESS-1' } }, context(session));
      await until(() => fs.readFileSync(stateFile, 'utf8').startsWith('1\n0\n')); pr.unsubscribe(); await pointer.stop(budget(700));
      const foreign = new ForeignToplevelClient({ session, clock });
      try {
        await foreign.start(context(session)); await semantic(session, client, 'Synthetic second');
        const windows = await until(async () => { const rows = await foreign.list(context(session)); return rows.length === 2 && rows; });
        assert.equal((await foreign.activate(windows.find(x => x.title === 'Session primary fixture').target, context(session, 2500))).effect, 'verified');
        assert.equal((await foreign.close(windows.find(x => x.title === 'Session second fixture').target, context(session, 2500))).effect, 'verified');
      } finally { await foreign.stop(budget(700)); }
      return { semantic: true, pixels: true, input: true, activation: true };
    },
  };
}

const enabled = process.env.MUSE_SESSION_LIVE === '1';
test('real Cage: concurrent identical app IDs, private clipboard, foreign activation, pause and owned cleanup', { skip: !enabled, timeout: 60000 }, async () => {
  const managers = [], sessions = [], controllers = [], results = { modelRoundTrips: null, modelMetricProvenance: 'scripted_no_model', checks: {} };
  const before = hostState();
  try {
    const req = { mode: 'isolated_desktop', backend: 'cage_headless', task: 'Owned fixture', viewer: 'none', fileGrantIds: [], network: 'deny', sandboxRequired: false };
    for (const sentinel of ['PRIVATE-A-2525', 'PRIVATE-B-2525']) {
      const manager = new SessionManager(options(sentinel)); managers.push(manager);
      sessions.push(await manager.create(req, context(null, 20000)));
    }
    const [a, b] = sessions;
    assert.notEqual(a.display.socket, b.display.socket); assert.notEqual(a.buses.sessionAddress, b.buses.sessionAddress);
    assert.notEqual(a.buses.accessibilityAddress, b.buses.accessibilityAddress); assert.notEqual(a.environment.HOME, b.environment.HOME);
    const clients = await Promise.all(sessions.map((s, i) => managers[i].launch(s.id, { appId: 'muse-session-fixture', args: [] }, context(s))));
    assert.notEqual(clients[0].process.pid, clients[1].process.pid);
    for (let i = 0; i < 2; i++) {
      const s = sessions[i], client = clients[i];
      await semantic(s, client, 'Synthetic copy'); await semantic(s, client, 'Synthetic paste');
      const clipboard = await until(() => { try { return fs.readFileSync(path.join(s.environment.HOME, 'clipboard.txt'), 'utf8'); } catch { return false; } });
      assert.equal(clipboard, i === 0 ? 'PRIVATE-A-2525' : 'PRIVATE-B-2525');
      const controller = new ForeignToplevelClient({ session: s, clock }); controllers.push(controller);
      const rows = await controller.start(context(s)); assert.equal(rows.length, 1); assert.equal(rows[0].appId, 'muse-session-fixture');
      await semantic(s, client, 'Synthetic second');
      const both = await until(async () => { const list = await controller.list(context(s)); return list.length === 2 && list; });
      const primary = both.find(x => x.title === 'Session primary fixture'), second = both.find(x => x.title === 'Session second fixture');
      assert.ok(second.active); const activation = await controller.activate(primary.target, context(s, 2500));
      results.checks['foreignActivation' + i] = activation;
      assert.equal(activation.effect, 'verified');
      await capture(s, `after-${i}.png`);
      const close = await controller.close(second.target, context(s, 2500)); assert.equal(close.effect, 'verified');
      const paused = await managers[i].pause(s.id, 'user_pause'); assert.equal(paused.state, 'paused');
      await assert.rejects(s.runner.spawn('pointerFixture', [], context(s)), { code: 'session_paused' });
      assert.equal((await controller.list(context(s))).length, 1);
      await assert.rejects(managers[i].resumeByUser(s.id, { id: 'forged', kind: 'local_user_resume' }), { code: 'user_resume_required' });
      await managers[i].resumeByUser(s.id, managers[i].issueLocalResumeToken(s.id));
    }
    results.checks.concurrentPrivate = true; results.checks.clipboardDisjoint = true; results.checks.pause = true;
    const after = hostState();
    // Human activity and other tasks can change passive host metadata while
    // Cage runs. Record that comparison without claiming its cause. A window
    // owned by either fixture on the host is an actual isolation failure.
    results.checks.hostState = before && after ? {
      clientsUnchanged: JSON.stringify(after.clients) === JSON.stringify(before.clients),
      focusUnchanged: after.focused === before.focused,
      workspaceUnchanged: after.workspace === before.workspace,
      cursorUnchanged: JSON.stringify(after.cursor) === JSON.stringify(before.cursor),
      changeAttribution: JSON.stringify(before) === JSON.stringify(after) ? 'no_change_observed' : 'unknown',
    } : null;
    if (after) {
      const ownedPids = new Set(managers.flatMap(m => [...m.sessions.values()].flatMap(r => r.owner.manifest().map(p => p.pid))));
      assert.equal(after.clients.some(row => ownedPids.has(row.pid)), false);
      results.checks.noOwnedHostWindows = true;
    } else results.checks.noOwnedHostWindows = null;
    for (let i = 0; i < 2; i++) {
      await controllers[i].stop(budget(700));
      const s = sessions[i], oldRunner = s.runner, generation = s.generation;
      const stopped = await managers[i].stop(s.id, 'user_stop', budget(1000)); assert.equal(stopped.state, 'stopped');
      assert.ok(stopped.generation > generation);
      await assert.rejects(oldRunner.spawn('pointerFixture', [], context(s)), { code: 'stale_session_generation' });
      assert.equal(fs.existsSync(s.environment.HOME), false);
      for (const p of s.resourceManifest.processes) assert.equal(sameProcess(identity(p.pid), p) && !identity(p.pid)?.zombie, false);
    }
    results.checks.cleanup = true;
  } finally {
    for (const controller of controllers) await controller.stop(budget(700));
    for (let i = 0; i < managers.length; i++) {
      for (const id of managers[i].sessions.keys()) await managers[i].stop(id, 'user_stop', budget(1000));
    }
    fs.writeFileSync(path.join(base, 'live-results.json'), JSON.stringify(results, null, 2), { mode: 0o600 });
  }
});

test('real Cage: compositor death during drag invalidates generation and rejects stale input', { skip: !enabled, timeout: 30000 }, async () => {
  const manager = new SessionManager(options('PRIVATE-DEATH-2525'));
  const req = { mode: 'isolated_desktop', backend: 'cage_headless', task: 'Owned death fixture', viewer: 'none', fileGrantIds: [], network: 'deny', sandboxRequired: false };
  let session, pointer;
  const receipt = { modelRoundTrips: null, checks: {} };
  try {
    session = await manager.create(req, context(null, 20000));
    pointer = await session.runner.spawn('pointerFixture', [], context(session)); const reader = lineChannel(pointer); await reader.read(x => x.includes('"ready"'));
    const oldGeneration = session.generation, oldContext = context(session), record = manager.record(session.id);
    const p = (x, y) => ({ x, y, localX: x, localY: y, width: 1280, height: 720, output: 'HEADLESS-1' });
    await pointer.write(Buffer.from(JSON.stringify({ id: 'inflight-drag', action: 'drag', from: p(40, 450), point: p(700, 600), duration: 800 }) + '\n'), oldContext);
    await sleep(100);
    const owned = record.compositor.group.leader; assert.ok(sameProcess(identity(owned.pid), owned)); process.kill(-owned.groupId, 'SIGKILL');
    await until(() => session.generation > oldGeneration);
    await assert.rejects(pointer.write(Buffer.from('{"id":"stale","action":"click"}\n'), oldContext), { code: 'stale_session_generation' });
    await assert.rejects(session.runner.spawn('keyboardFixture', [], context(session)), { code: 'stale_session_generation' });
    receipt.checks.noReplayOrHostFallback = true; receipt.checks.oldGeneration = oldGeneration; receipt.checks.newGeneration = session.generation;
    receipt.checks.originalDragEffect = 'unknown';
    const stopped = await manager.stop(session.id, 'owned_failure', budget(1000)); assert.equal(stopped.state, 'stopped');
    assert.equal(fs.existsSync(session.environment.HOME), false); receipt.checks.cleanup = true;
  } finally {
    pointer && await pointer.stop(budget(700));
    for (const id of manager.sessions.keys()) await manager.stop(id, 'owned_failure', budget(1000));
    fs.writeFileSync(path.join(base, 'death-results.json'), JSON.stringify(receipt, null, 2), { mode: 0o600 });
  }
});

test('real Cage: Stop during readiness rejects startup, preserves Pause and removes only its own resources', { skip: !enabled, timeout: 30000 }, async () => {
  const configured = options('PRIVATE-STOP-2525');
  let reached, session; const ready = new Promise(resolve => { reached = resolve; });
  configured.readyProbe = async ({ session: descriptor, ctx }) => {
    session = descriptor; reached();
    await new Promise(resolve => ctx.signal.addEventListener('abort', resolve, { once: true }));
    return { semantic: true, pixels: true, input: true };
  };
  const manager = new SessionManager(configured);
  const req = { mode: 'isolated_desktop', backend: 'cage_headless', task: 'Owned readiness stop', viewer: 'none', fileGrantIds: [], network: 'deny', sandboxRequired: false };
  const pending = manager.create(req, context(null, 10000));
  // Observe rejection immediately so the expected cancellation is never an
  // unhandled rejection while Stop awaits process teardown.
  const outcome = pending.then(() => null, error => error);
  try {
    await ready;
    const paused = await manager.pause(session.id, 'user_pause'); assert.equal(paused.requiresUserResume, true);
    const stopped = await manager.stop(session.id, 'user_stop', budget(1000));
    const error = await outcome; assert.ok(error); assert.equal(error.isolationCode, 'isolation_unavailable');
    assert.ok(stopped.generation > 1); assert.equal(fs.existsSync(session.environment.HOME), false);
    assert.equal(manager.status(session.id).requiresUserResume, true);
  } finally { for (const id of manager.sessions.keys()) await manager.stop(id, 'user_stop', budget(1000)); }
});

test('production readiness uses new worker on two private Cage hosts, verifies bus PID/start tokens, and closes calibration apps', { skip: !enabled, timeout: 30000 }, async () => {
  const { createCageReadinessProbe, createSessionExecutableAllowlist } = require('../../src/computer/session/index.cjs');
  const { WorkerChannel } = require('../../src/computer/desktop/worker-channel.cjs');
  const configured = options('UNUSED');
  const paths = { worker: path.join(binaries, 'muse-accessibility-worker'), pointer: path.join(binaries, 'muse-pointer'),
    keyboard: path.join(binaries, 'muse-keyboard'), foreignToplevel: path.join(base, 'wayland-session'), fixture: path.join(base, 'readiness-fixture'), capture: '/usr/bin/grim' };
  configured.executables = createSessionExecutableAllowlist(paths);
  configured.apps = { 'muse-readiness-fixture': { executableId: 'readinessFixture', internalOnly: true,
    validateArgs: a => a.length === 1 && /^[a-f0-9-]{36}$/.test(a[0]), buildArgs: ({ args }) => args } };
  const phases = [], runs = [], started = clock.now(), hostBefore = hostState(); let runIndex = 0;
  const actualProbe = createCageReadinessProbe({ createWorkerChannel: options => new WorkerChannel(options), clock,
    onPhase: phase => { phases.push({ runIndex, phase, elapsedMs: clock.now() - started }); fs.writeFileSync(path.join(base, 'readiness-phase.txt'), phase); },
    onFrame: (stage, png) => fs.writeFileSync(path.join(base, `production-readiness-${runIndex ? '2-' : ''}${stage}.png`), png, { mode: 0o600 }) });
  let measured;
  configured.readyProbe = async args => { measured = await actualProbe(args); return measured; };
  const manager = new SessionManager(configured); let session;
  try {
    session = await manager.create({ mode: 'isolated_desktop', backend: 'cage_headless', task: 'Production readiness verification', viewer: 'none', fileGrantIds: [], network: 'deny', sandboxRequired: false }, context(null, 20000));
    assert.equal(session.state, 'ready'); assert.equal(session.capabilities.nativeSemantic.verification, 'measured');
    await assert.rejects(manager.launch(session.id, { appId: 'muse-readiness-fixture', args: [crypto.randomUUID()] }, context(session)), { code: 'app_not_allowed' });
    await assert.rejects(async () => session.runner.spawn('readinessFixture', [crypto.randomUUID()], context(session)), { code: 'executable_not_allowed' });
    await assert.rejects(async () => session.runner.exec('readinessFixture', [crypto.randomUUID()], { ...context(session), encoding: 'utf8', maxBytes: 1024 }), { code: 'executable_not_allowed' });
    assert.ok(measured.ownerPid > 0); assert.ok(measured.ownerStartToken);
    assert.equal(sameProcess(identity(measured.ownerPid), { pid: measured.ownerPid, startToken: measured.ownerStartToken }), false);
    const foreign = new ForeignToplevelClient({ session, clock });
    try { assert.deepEqual(await foreign.start(context(session)), []); } finally { await foreign.stop(budget(700)); }
    assert.equal(fs.readdirSync(session.environment.HOME).some(n => n.startsWith('readiness-')), false);
    runs.push({ measured, fixtureAlive: false, remainingWindows: 0 }); runIndex++;
    const second = await manager.create({ mode: 'isolated_desktop', backend: 'cage_headless', task: 'Second production readiness host', viewer: 'none', fileGrantIds: [], network: 'deny', sandboxRequired: false }, context(null, 20000));
    assert.equal(second.state, 'ready');
    assert.notEqual(second.display.socket, session.display.socket);
    assert.notEqual(second.buses.sessionAddress, session.buses.sessionAddress);
    assert.notEqual(second.buses.accessibilityAddress, session.buses.accessibilityAddress);
    assert.notEqual(second.environment.HOME, session.environment.HOME);
    assert.notEqual(second.generation, session.generation);
    assert.equal(sameProcess(identity(measured.ownerPid), { pid: measured.ownerPid, startToken: measured.ownerStartToken }), false);
    const secondForeign = new ForeignToplevelClient({ session: second, clock });
    try {
      assert.deepEqual(await secondForeign.start(context(second)), []);
      await assert.rejects(secondForeign.list(context(session)), { code: 'wrong_session' });
    } finally { await secondForeign.stop(budget(700)); }
    runs.push({ measured, fixtureAlive: false, remainingWindows: 0 });
    const hostAfter = hostState();
    const ownedPids = new Set([...manager.sessions.values()].flatMap(r => r.owner.manifest().map(p => p.pid)));
    if (hostAfter) assert.equal(hostAfter.clients.some(row => ownedPids.has(row.pid)), false);
    const hostPassivity = hostBefore && hostAfter ? {
      clientsUnchanged: JSON.stringify(hostBefore.clients) === JSON.stringify(hostAfter.clients),
      focusUnchanged: hostBefore.focused === hostAfter.focused,
      workspaceUnchanged: hostBefore.workspace === hostAfter.workspace,
      cursorUnchanged: JSON.stringify(hostBefore.cursor) === JSON.stringify(hostAfter.cursor),
      noOwnedHostWindows: true,
      changeAttribution: JSON.stringify(hostBefore) === JSON.stringify(hostAfter) ? 'no_change_observed' : 'unknown',
    } : null;
    fs.writeFileSync(path.join(base, 'production-readiness-results.json'), JSON.stringify({ measured: runs[0].measured, runs, phases,
      elapsedMs: clock.now() - started, dualPrivate: true, hostPassivity, internalOnlyEnforced: true, fixtureAlive: false, remainingWindows: 0,
      workerPidNamespace: 'host', busPidNamespace: 'host', fixturePidNamespace: 'private', modelRoundTrips: null, modelMetricProvenance: 'scripted_no_model' }, null, 2), { mode: 0o600 });
  } finally { for (const id of manager.sessions.keys()) await manager.stop(id, 'user_stop', budget(1000)); }
});
