'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { performance } = require('node:perf_hooks');
const { randomUUID, createHash } = require('node:crypto');
const { AccessibilityClient, DesktopController } = require('../../src/computer/desktop/index.cjs');
const { WorkerChannel } = require('../../src/computer/desktop/worker-channel.cjs');
const { ExecutionCoordinator } = require('../../src/computer/executor.cjs');
const { createPrivateHandle } = require('../../src/computer/contracts.cjs');
const { AssertionRegistry, normalizeAdapterReceipt, expectationsForOperation } = require('../../src/computer/state/index.cjs');
const { MemoryJournal } = require('../computer-execution/helpers.cjs');
const ROOT = '/tmp/muse-port-d6c9/rewrite/impl-desktop';
const enabled = process.env.MUSE_DESKTOP_LIVE === '1';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function token(pid) { return fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ').at(-1).split(' ')[19]; }
async function waitFor(fn, ms = 8000) {
  const end = performance.now() + ms;
  while (performance.now() < end) { const result = await fn(); if (result) return result; await sleep(25); }
  throw new Error('owned fixture readiness timeout');
}
function context() {
  const controller = new AbortController(); const deadlineMonoMs = performance.now() + 12000;
  const attempts = [];
  return { runId: 'fixture-run', invokeId: 'fixture-invoke', actionId: 'fixture-action', sessionId: 'desktop-fixture',
    signal: controller.signal, budget: { deadlineMonoMs, clockDomain: 'node.performance' },
    revision: { sessionGeneration: 1, grantGeneration: 1, targetGeneration: 1, semanticRevision: 1, geometryRevision: 1 },
    progress: { remainingMs: () => deadlineMonoMs - performance.now(), check: () => { assert.ok(performance.now() < deadlineMonoMs); } },
    dispatch: { beforeEffect: async event => { const handle = { ...event }; attempts.push(handle); return handle; },
      afterEffect: async (handle, ack) => { assert.ok(['accepted', 'rejected', 'lost'].includes(ack.state)); assert.equal(typeof ack.noEffectProven, 'boolean'); handle.ack = ack; } }, attempts };
}
test('persistent AT-SPI worker on owned Cage/private bus with independent full GTK readback', { skip: !enabled, timeout: 100000 }, async () => {
  const runtime = fs.mkdtempSync(path.join(ROOT, 'run-')); fs.chmodSync(runtime, 0o700);
  const owned = []; const notes = []; const textProofs = []; let client;
  const env = { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', HOME: path.join(runtime, 'home'), XDG_RUNTIME_DIR: runtime,
    XDG_CONFIG_HOME: path.join(runtime, 'config'), XDG_CACHE_HOME: path.join(runtime, 'cache'), XDG_DATA_HOME: path.join(runtime, 'data'),
    GDK_BACKEND: 'wayland', GTK_USE_PORTAL: '0', GTK_A11Y: 'always', NO_AT_BRIDGE: '0', WLR_BACKENDS: 'headless',
    WLR_RENDERER: 'pixman', WLR_HEADLESS_OUTPUTS: '1' };
  for (const folder of ['home', 'config', 'cache', 'data']) fs.mkdirSync(path.join(runtime, folder), { mode: 0o700 });
  function spawn(file, argv, name, extraEnv = {}) {
    const child = cp.spawn(file, argv, { env: { ...env, ...extraEnv }, cwd: runtime, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    owned.push(child); child.output = ''; child.errors = '';
    child.stdout.on('data', data => { child.output += data; }); child.stderr.on('data', data => { child.errors += data; });
    child.on('error', error => { child.errors += error.code; }); child.label = name;
    child.terminate = async () => {
      if (child.exitCode === null && child.signalCode === null) { process.kill(-child.pid, 'SIGTERM'); await waitFor(() => child.exitCode !== null || child.signalCode !== null, 1000); }
    };
    return child;
  }
  async function execute(file, argv) {
    return new Promise((resolve, reject) => cp.execFile(file, argv, { env, cwd: runtime, timeout: 5000, maxBuffer: 2e6 },
      (error, stdout) => error ? reject(error) : resolve(stdout)));
  }
  const state = () => JSON.parse(fs.readFileSync(path.join(runtime, 'state.json'), 'utf8'));
  async function control(op) {
    const serial = state().commandSerial;
    fs.writeFileSync(path.join(runtime, 'control.json'), JSON.stringify(op));
    await waitFor(() => state().commandSerial > serial); await sleep(100);
  }
  try {
    const dbus = spawn('/usr/bin/dbus-daemon', ['--session', '--nofork', '--nopidfile', `--address=unix:path=${runtime}/session`, '--print-address=1'], 'dbus');
    env.DBUS_SESSION_BUS_ADDRESS = await waitFor(() => dbus.output.trim().startsWith('unix:') && dbus.output.trim());
    spawn('/usr/lib/at-spi-bus-launcher', ['--launch-immediately', '--a11y=1'], 'atspi');
    env.AT_SPI_BUS_ADDRESS = await waitFor(async () => { try {
      const result = await execute('/usr/bin/gdbus', ['call', '--session', '--dest', 'org.a11y.Bus', '--object-path', '/org/a11y/bus', '--method', 'org.a11y.Bus.GetAddress']);
      return result.match(/'(unix:[^']+)'/u)?.[1];
    } catch { return false; } });
    spawn('/usr/lib/at-spi2-registryd', [], 'registry');
    const cageRoot = process.env.MUSE_CAGE_ROOT || '/tmp/muse-port-d6c9/rewrite/isolation-prototype/root';
    const cage = spawn(`${cageRoot}/usr/bin/cage`, ['-D', '--', `${ROOT}/fixture`, runtime], 'cage', { LD_LIBRARY_PATH: `${cageRoot}/usr/lib` });
    await waitFor(() => cage.output.includes('fixture-ready'));
    env.WAYLAND_DISPLAY = await waitFor(() => fs.readdirSync(runtime).find(name => /^wayland-\d+$/u.test(name) && fs.statSync(path.join(runtime, name)).isSocket()));
    // Our new fixture executable is uniquely identified, and was launched only in this owned group.
    const fixturePid = await waitFor(() => fs.readdirSync('/proc').filter(name => /^\d+$/u.test(name)).map(Number).find(pid => {
      try { return fs.readlinkSync(`/proc/${pid}/exe`) === `${ROOT}/fixture` && fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ').at(-1).split(' ')[2] === String(cage.pid); }
      catch { return false; }
    }));
    const session = { id: 'desktop-fixture', generation: 1, mode: 'isolated_desktop', state: 'ready', ownership: 'owned',
      display: { socket: env.WAYLAND_DISPLAY, instanceId: `owned-cage-${cage.pid}`, coordinateSpace: 'owned-fixture-logical' },
      buses: { sessionAddress: env.DBUS_SESSION_BUS_ADDRESS, accessibilityAddress: env.AT_SPI_BUS_ADDRESS },
      runner: { spawn: async (id, argv) => { assert.equal(id, 'accessibility-worker'); assert.deepEqual(argv, []); return spawn(`${ROOT}/accessibility-worker`, [], 'worker'); } } };
    const target = { sessionId: session.id, kind: 'window', targetId: 'fixture-window', generation: 1, ownership: 'owned', process: { pid: fixturePid, startToken: token(fixturePid) } };
    let binding;
    client = new AccessibilityClient({ channel: new WorkerChannel(), plainTextPolicy: (_ref, live) => ['entry', 'text'].includes(live.role),
      rootMapper: async () => binding });
    assert.equal((await client.start(session, context())).ready, true);
    const candidates = (await client.discover(target, context())).candidates;
    assert.equal(candidates.length, 1);
    const root = candidates[0]; assert.equal(root.name, 'Muse Desktop Contract Fixture');
    binding = { ...root, startToken: target.process.startToken, confidence: 'exact' };
    await client.observe(target, { scope: 'structural', maxNodes: 2000, maxDepth: 12 }, context());
    await sleep(250); // Fixture startup ATK exports/focus events settle; no input is retried.
    const controller = new DesktopController({ session, accessibility: client, authorize: async () => {}, input: {
      click: async () => { throw Error('physical input must not be called'); } } });
    const revision = context().revision, journal = new MemoryJournal(); let latestRaw;
    const adapter = {
      preflight: async (op, ctx) => { const raw = await controller.preflight(op, ctx); return { eligible: raw.eligible, revision: raw.revision, evidence: [], noEffectProven: true }; },
      perform: async (op, ctx) => {
        latestRaw = await controller.perform(op, ctx);
        const normalized = normalizeAdapterReceipt(latestRaw, { operation: op, privateDigest: value => client.digest(value) });
        return JSON.parse(JSON.stringify({ target: normalized.target, before: normalized.before, after: normalized.after,
          dispatch: normalized.dispatch, effect: normalized.effect, evidence: normalized.evidence, failure: normalized.failure,
          timings: ctx.progress.timings(), attempts: [] }));
      }, probe: async () => [], quiesce: ctx => controller.quiesce(ctx),
    };
    const grant = createPrivateHandle('grant', 'fixture-grant');
    const coordinator = new ExecutionCoordinator({ journal, adapter, assertions: new AssertionRegistry(),
      authorize: async () => ({ grant, revision }) });
    async function observe() { return client.observe(target, { scope: 'structural', maxNodes: 2000, maxDepth: 12 }, context()); }
    async function ref(name) { const result = await observe(); const node = result.nodes.find(n => n.name === name); assert.ok(node, name); return node.ref; }
    async function edit(name, mode, text, position = 0, end = position) {
      console.log('fixture edit', name, mode);
      const outputFile = path.join(runtime, name === 'Plain entry' ? 'entry.txt' : 'view.txt');
      const independentBefore = [...fs.readFileSync(outputFile, 'utf8')];
      const independentExpected = mode === 'replace' ? text : mode === 'append' ? independentBefore.join('') + text :
        independentBefore.slice(0, position).join('') + text + independentBefore.slice(mode === 'replaceSelection' ? end : position).join('');
      const editRef = await ref(name), operation = { kind: 'editText', ref: editRef,
        edit: { mode, text, semantics: 'plain_text', newlinePolicy: 'literal_multiline', clipboard: 'forbid' } };
      const invokeId = randomUUID(), request = { schema: 'muse.action.v1', actionId: randomUUID(), runId: 'fixture-run', invokeId,
        target, expectedRevision: revision, operation, require: [], requirementIds: [],
        expect: expectationsForOperation(operation, { privateDigest: value => client.digest(value) }) };
      const outcome = await coordinator.invoke({ deviceId: 'owned-fixture', runId: request.runId, invokeId, command: 'computer.action',
        params: request, deadlineUtcMs: Date.now() + 12000 }, session);
      assert.equal(outcome.receipt.execution, 'completed', JSON.stringify(outcome.receipt.failure));
      assert.equal(outcome.receipt.effect, 'verified', JSON.stringify(outcome.receipt.assertions));
      assert.ok(outcome.receipt.assertions.some(a => a.status === 'satisfied'));
      assert.ok(outcome.receipt.attempts.length >= 1);
      const result = latestRaw;
      assert.equal(result.effect, 'verified', `${name}/${mode}: ${result.code}/${result.verificationReason}`);
      assert.equal(result.readback.ref, editRef.id); assert.equal(result.readback.text, undefined);
      assert.equal(result.readback.digestRef, result.readback.expectedPrivateDigest);
      const full = await client.readText(await ref(name), { mode: 'page', limitScalars: 1048576 }, context());
      const external = fs.readFileSync(outputFile, 'utf8');
      assert.equal(external, independentExpected, 'independent GTK full value must equal requested edit construction');
      assert.equal(full.text, external); assert.equal(full.totalScalars, [...external].length);
      textProofs.push({ mode, scalarCount: full.totalScalars, utf8Bytes: full.totalUtf8Bytes,
        independentApplicationSha256: createHash('sha256').update(external).digest('hex'),
        independentlyExpectedSha256: createHash('sha256').update(independentExpected).digest('hex'),
        controllerEffect: result.effect, coordinatorEffect: outcome.receipt.effect,
        assertions: outcome.receipt.assertions, attempts: outcome.receipt.attempts.length,
        readback: result.readback, timings: outcome.receipt.timings });
      return { result, full, external };
    }
    await execute('/usr/bin/grim', ['-o', 'HEADLESS-1', path.join(ROOT, 'before.png')]);
    const scopeRef = await ref('Plain entry');
    const scoped = await controller.perform({ kind: 'query', target,
      query: { rootRefId: scopeRef.id, name: 'Plain entry', role: scopeRef.identity.role, exact: true, limit: 2, scope: 'structural', states: { editable: true } } }, context());
    assert.equal(scoped.matches.length, 1); assert.equal(scoped.evidence[0].nodes.length, 1); assert.equal(scoped.complete, true);
    const absent = await controller.perform({ kind: 'query', target,
      query: { rootRefId: scopeRef.id, name: 'Increment', exact: true, limit: 2, scope: 'visible' } }, context());
    assert.equal(absent.matches.length, 0); assert.equal(absent.absence, 'verified_absent'); notes.push('ancestor-scoped native query excludes siblings');
    const replace4096 = 'A'.repeat(4086) + '日本語🌍e\u0301אבגZ'; assert.equal([...replace4096].length, 4096);
    assert.equal((await edit('Plain entry', 'replace', replace4096)).external, replace4096); notes.push('4096 scalar replace with CJK/emoji/combining/RTL');
    await edit('Plain entry', 'append', 'B'.repeat(3904));
    const append = await edit('Plain entry', 'append', '🌍!'); assert.equal([...append.external].length, 8002); notes.push('append to 8000+ with independent full readback');
    await control({ op: 'caret', position: 3 }); const inserted = await edit('Plain entry', 'insert', '日本🌍e\u0301', 3);
    assert.equal(inserted.external.slice(0, 3), 'AAA'); assert.ok(inserted.external.startsWith('AAA日本🌍e\u0301'));
    await control({ op: 'selection', start: 3, end: 8 });
    const selected = await edit('Plain entry', 'replaceSelection', '中', 3, 8); assert.ok(selected.external.startsWith('AAA中'));
    await edit('Plain entry', 'replace', ''); assert.equal(fs.readFileSync(path.join(runtime, 'entry.txt'), 'utf8'), '');
    const multiline = 'one\ntwo\t🌍日本e\u0301'; assert.equal((await edit('Plain multiline', 'replace', multiline)).external, multiline);
    const passwordRef = await ref('Password'); const ctx = context();
    await assert.rejects(client.edit(passwordRef, { mode: 'replace', text: 'synthetic-only', semantics: 'plain_text', newlinePolicy: 'reject_singleline', clipboard: 'forbid' }, ctx), /secret_control/u);
    assert.equal(ctx.attempts.length, 0);
    await assert.rejects(client.edit(await ref('Readonly'), { mode: 'replace', text: 'x', semantics: 'plain_text', newlinePolicy: 'reject_singleline', clipboard: 'forbid' }, context()), /read_only/u);
    let rows = (await observe()).nodes.filter(n => n.name === 'Identical row'); assert.equal(rows.length, 2);
    const oldRow = rows[0].ref; await control({ op: 'reorder' });
    const staleCtx = context(); await assert.rejects(client.invoke(oldRow, 'click', staleCtx), /dirty_ref|identity_changed/u); assert.equal(staleCtx.attempts.length, 0);
    rows = (await observe()).nodes.filter(n => n.name === 'Identical row'); const oldObjects = rows.map(n => n.ref);
    await control({ op: 'replaceRow' });
    for (const old of oldObjects) await assert.rejects(client.invoke(old, 'click', context()), /dirty_ref|identity_changed|defunct_ref/u);
    assert.equal(state().rowClicks, 0); notes.push('same-label reorder and object replacement reject old refs with zero row clicks');
    const slider = await ref('Slider is not scroll');
    await assert.rejects(controller.perform({ kind: 'scroll', ref: slider, axis: 'y', delta: 20 }, context()), /semantic_incremental_scroll_unavailable/u);
    await execute('/usr/bin/grim', ['-o', 'HEADLESS-1', path.join(ROOT, 'after.png')]);
    await control({ op: 'cover' }); const count = state().clicks;
    const clickResult = await controller.perform({ kind: 'click', ref: await ref('Increment'), button: 'left' }, context());
    assert.equal(clickResult.path, 'atspi'); await waitFor(() => state().clicks === count + 1); notes.push('covered semantic named click with zero physical calls');
    await execute('/usr/bin/grim', ['-o', 'HEADLESS-1', path.join(ROOT, 'covered.png')]);
    fs.writeFileSync(path.join(ROOT, 'live-result.json'), JSON.stringify({ verified: true, notes, session: 'owned Cage/private DBus/AT-SPI',
      highLevelController: true, actualCoordinator: true, journal: 'test-only memory journal', preDispatchExpectedDigest: true,
      fullIndependentReadback: true, model_round_trips: null,
      skipped: ['Qt', 'offscreen reveal', 'selected native lists', 'off-workspace compositor control', 'portal mapping', 'performance distribution', 'physical route'], fixturePid }, null, 2));
    fs.writeFileSync(path.join(ROOT, 'text-proofs.json'), JSON.stringify(textProofs, null, 2));
  } finally {
    await client?.stop(context());
    for (const child of [...owned].reverse()) { try { await child.terminate(); } catch { if (child.exitCode === null && child.signalCode === null) process.kill(-child.pid, 'SIGKILL'); } }
    // Logs contain synthetic fixture labels only and remain local.
    fs.writeFileSync(path.join(ROOT, 'fixture-processes.json'), JSON.stringify(owned.map(p => ({ name: p.label, pid: p.pid, exitCode: p.exitCode, signal: p.signalCode, errors: p.errors })), null, 2));
    fs.rmSync(runtime, { recursive: true, force: true });
  }
});
