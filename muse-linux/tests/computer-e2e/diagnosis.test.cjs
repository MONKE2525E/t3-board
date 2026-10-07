'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { diagnoseComputer, reconcileDiagnosticSources, MAX_BYTES } = require('../../src/computer/diagnosis.cjs');
const { FailureDetector } = require('../../src/computer/recovery.cjs');
const { Progress } = require('../../src/computer/progress.cjs');
const { target, revision, evidence } = require('../computer-state/helpers.cjs');
const fs = require('node:fs/promises');
const path = require('node:path');
const { ComputerRuntime } = require('../../src/computer/index.cjs');
const { BrowserController, WebSocketTransport } = require('../../src/computer/browser/index.cjs');
const { startFixture } = require('../computer-browser/fixture.cjs');

function fixture({ gated = false, deadline = 2000 } = {}) {
  const detector = new FailureDetector(), progress = new Progress({ budget: { clockDomain: 'node.performance', deadlineMonoMs: performance.now() + deadline } });
  const request = { runId: 'diagnosis-run', target, operation: { kind: 'navigate', target, url: 'https://example.invalid/orders' }, requirementIds: [] };
  if (gated) for (let i = 0; i < 3; i++) detector.record(request, { execution: 'completed', effect: 'unknown', assertions: [] });
  return { runId: request.runId, request, target, ctx: { progress, signal: progress.signal, budget: progress.budget, revision }, detector, assertCurrent() {} };
}
function probe(source = 'dom', extras = {}) {
  return { source, read: async () => ({ observation: { title: 'Your Orders', url: 'https://example.invalid/orders?private=hidden', revision, controls: [] },
    evidence: [evidence(source, [['document.url', 'https://example.invalid/orders']])], ...extras }) };
}

test('ungated diagnosis refreshes exactly once without granting recovery or action success', async () => {
  const f = fixture(); let calls = 0;
  const read = probe(); read.read = async ctx => { calls++; assert.equal(ctx.signal.aborted, false); return probe().read(); };
  const result = await diagnoseComputer({ ...f, probes: [read, read, read] });
  assert.equal(calls, 1); assert.equal(result.read_only, true); assert.equal(result.task_success, false); assert.equal(result.recovery_approved, false);
  assert.equal(result.gate, null); assert.equal(result.reconciliation.next_route, 'direct_browser');
  assert.equal(result.probes[0].observation.url, 'https://example.invalid/orders');
  assert.equal(f.detector.status(f.runId), null);
});

test('three gated probes are a run-wide limit and uncertain same intent remains blocked', async () => {
  const f = fixture({ gated: true });
  const result = await diagnoseComputer({ ...f, probes: [probe('dom'), probe('atspi')] });
  assert.equal(result.gate.probes_used, 2); assert.equal(f.detector.status(f.runId).reason, 'no_progress');
  assert.throws(() => f.detector.check(f.request), { code: 'diagnosis_required' });
  await diagnoseComputer({ ...f, probes: [probe()] });
  await assert.rejects(diagnoseComputer({ ...f, probes: [probe()] }), { code: 'diagnosis_probe_limit' });
  assert.equal(f.detector.status(f.runId).probes, 3);
  assert.equal(f.detector._run(f.runId).recovery, null);
});

test('diagnosis dispatch rejects before an effect and returns a first-class failed probe', async () => {
  const f = fixture({ gated: true }); let effects = 0;
  const result = await diagnoseComputer({ ...f, probes: [{ source: 'dom', read: async ctx => { await ctx.dispatch.beforeEffect(); effects++; } }] });
  assert.equal(effects, 0); assert.equal(result.probes[0].status, 'failed'); assert.equal(result.probes[0].error.effect, 'none_proven');
  assert.equal(result.reconciliation.state, 'unconfirmed'); assert.equal(result.task_success, false);
});

test('a hung refresh ends at its finite parent budget without recovery approval', async () => {
  const f = fixture({ gated: true, deadline: 30 }), started = performance.now();
  const result = await diagnoseComputer({ ...f, probes: [{ source: 'dom', read: () => new Promise(() => {}) }] });
  assert.equal(result.probes[0].status, 'failed'); assert.equal(result.probes[0].error.code, 'deadline_exceeded');
  assert.ok(performance.now() - started < 1000); assert.equal(result.recovery_approved, false);
});

test('a session/target change during refresh rejects instead of returning the old observation', async () => {
  const f = fixture(); let changed = false;
  f.assertCurrent = () => { if (changed) throw Object.assign(new Error('stale_session'), { code: 'stale_session' }); };
  await assert.rejects(diagnoseComputer({ ...f, probes: [{ source: 'dom', read: async () => { changed = true; return probe().read(); } }] }), { code: 'stale_session' });
});

test('stale AX cannot negate current DOM and contradictory fresh facts remain unresolved', () => {
  const dom = evidence('dom', [['document.url', 'https://example.invalid/orders']]);
  const stale = evidence('atspi', [['document.url', 'https://example.invalid/home']], { freshness: 'stale' });
  const opts = { target, revision, clock: { now: () => performance.now(), domain: 'node.performance' } };
  const result = reconcileDiagnosticSources([dom, stale], opts);
  assert.equal(result.next_route, 'direct_browser'); assert.equal(result.stale_accessibility, true); assert.deepEqual(result.conflicts, []);
  assert.match(result.guidance, /does not establish that a page failed to load/);
  const contradictory = reconcileDiagnosticSources([dom, evidence('browser_ax', [['document.url', 'https://example.invalid/home']])], opts);
  assert.equal(contradictory.state, 'contradictory'); assert.equal(contradictory.next_route, 'refresh_authoritative_source');
  assert.equal(contradictory.conflicts[0].resolution, 'unresolved');
});

test('wrong target, changed revision and old clock never become current state', () => {
  const entries = [evidence('dom', [], { target: { ...target, generation: 2 } }),
    evidence('atspi', [], { revisionAfter: { ...revision, semanticRevision: 2 } }),
    evidence('window', [], { interval: { startMonoMs: 0, endMonoMs: 1, clockDomain: 'old.clock', utc: new Date().toISOString() } })];
  const result = reconcileDiagnosticSources(entries, { target, revision, clock: { now: () => performance.now(), domain: 'node.performance' } });
  assert.equal(result.state, 'unconfirmed'); assert.ok(result.sources.every(s => s.status !== 'current'));
});

test('model output excludes private handles, full field values and pixels and stays under16KiB', async () => {
  const f = fixture({ gated: true });
  const controls = Array.from({ length: 1000 }, (_, i) => ({ ref_id: `ref-${i}`, label: '😀'.repeat(2000), value: 'PRIVATE_SECRET', ref: { objectToken: 'PRIVATE_HANDLE' }, role: 'entry', capabilities: ['editText'] }));
  const result = await diagnoseComputer({ ...f, probes: [probe('dom', { observation: { title: 'A'.repeat(9000), revision, controls, image_transfer: { data_base64: 'PRIVATE_PIXELS' }, raw: 'PRIVATE_HANDLE' } })] });
  const json = JSON.stringify(result);
  assert.ok(Buffer.byteLength(json) <= MAX_BYTES); assert.equal(result.probes[0].observation.controls_truncated, true);
  assert.doesNotMatch(json, /PRIVATE_SECRET|PRIVATE_HANDLE|PRIVATE_PIXELS/);
});

test('malformed evidence is a failed probe, never unvalidated current evidence', async () => {
  const f = fixture();
  const result = await diagnoseComputer({ ...f, probes: [probe('dom', { evidence: [{ source: 'dom', facts: [] }] })] });
  assert.equal(result.probes[0].status, 'failed'); assert.equal(result.reconciliation.state, 'unconfirmed');
});

test('an empty fresh tree is unconfirmed and unrelated dialog identities do not conflict', () => {
  const opts = { target, revision, clock: { now: () => performance.now(), domain: 'node.performance' } };
  assert.equal(reconcileDiagnosticSources([evidence('dom')], opts).state, 'unconfirmed');
  const result = reconcileDiagnosticSources([evidence('lifecycle', [['dialog.state', { dialogId: 'dialog-one', state: 'open' }],
    ['dialog.state', { dialogId: 'dialog-two', state: 'open' }]])], opts);
  assert.deepEqual(result.conflicts, []);
});

test('real composed Chrome diagnosis refreshes DOM without input or screenshots and preserves unknown intent',
  { skip: process.env.MUSE_COMPUTER_E2E !== '1', timeout: 90000 }, async () => {
    const browserFixture = await startFixture();
    const directory = await fs.mkdtemp(path.join(browserFixture.directory, 'diagnosis-'));
    const runtime = new ComputerRuntime({ deviceId: 'diagnosis-fixture', directory, nativeDirectory: path.resolve('native/bin'),
      policy: () => ({ browserPolicy: 'allow', desktopPolicy: 'deny' }), permission: async () => true,
      desktop: { paused: false }, fixtureOrigins: [browserFixture.origin, browserFixture.crossOrigin] });
    const calls = [], transport = new WebSocketTransport(), send = transport.send.bind(transport);
    transport.send = (method, ...args) => { calls.push(method); return send(method, ...args); };
    try {
      runtime.connectionSessionId = 'diagnosis-session'; runtime.connectionGeneration = 1; runtime.epoch = 1;
      runtime.connected = new BrowserController({ transport, policy: runtime.browserPolicy(), fixtureOrigins: runtime.fixtureOrigins });
      const ctx = runtime.context(); ctx.sessionId = runtime.connectionSessionId;
      await runtime.connected.connect({ mode: 'chrome_consent', endpoint: browserFixture.endpoint }, ctx);
      const [choice] = await runtime.connected.listForLocalPicker(ctx);
      runtime.connectedLease = await runtime.connected.attach(choice.selectionToken, ctx);
      assert.equal((await runtime.start({ scope: 'connected_browser', task: 'Synthetic read-only diagnosis', __deadline: Date.now() + 30000 })).host_input, false);
      const observed = await runtime.observe();
      const params = { action: 'click', element_label: 'Save synthetic', observation_id: observed.observation_id };
      const clicked = await runtime.control({ command: 'computer.control', params, invokeId: 'diagnosis-unknown-click', deadline: Date.now() + 15000 }, params);
      assert.equal(clicked.receipt.effect, 'unknown'); assert.equal(JSON.parse(await browserFixture.state()).saved, 1);
      const replayParams = { action: 'click', element_label: 'Save synthetic' };
      const replayRequest = { command: 'computer.control', params: replayParams, invokeId: 'diagnosis-repeated-click', deadline: Date.now() + 15000 };
      assert.equal((await runtime.control(replayRequest, replayParams)).receipt.failure.code, 'diagnosis_required');
      const gateBefore = { ...runtime.coordinator.detector.status(runtime.runId) };
      const inputBefore = calls.filter(method => method.startsWith('Input.')).length;
      const focusBefore = calls.filter(method => ['Page.bringToFront', 'Target.activateTarget'].includes(method)).length;
      const browserObserve = runtime.browser.observe.bind(runtime.browser);
      runtime.browser.observe = async (...args) => {
        const current = await browserObserve(...args);
        // Inject a stale AX representation beside a real current DOM acquisition.
        const stale = structuredClone(current.state.evidence.find(entry => entry.source === 'dom'));
        stale.id = 'diagnosis-injected-stale-ax'; stale.source = 'browser_ax'; stale.freshness = 'stale';
        stale.facts = [{ predicate: 'document.url', value: 'https://example.invalid/stale-not-loaded', suitability: 'authoritative', evidenceIds: [stale.id] }];
        current.state.evidence.push(stale);
        return current;
      };
      const diagnosis = await runtime.diagnose({ __deadline: Date.now() + 5000 });
      assert.equal(diagnosis.probes[0].status, 'refreshed', JSON.stringify(diagnosis));
      assert.equal(diagnosis.probes[0].observation.title, 'Muse synthetic browser fixture');
      assert.equal(diagnosis.reconciliation.sources.find(source => source.source === 'dom').status, 'current');
      assert.equal(diagnosis.reconciliation.sources.find(source => source.source === 'browser_ax').status, 'stale');
      assert.equal(diagnosis.reconciliation.next_route, 'direct_browser'); assert.equal(diagnosis.recovery_approved, false); assert.equal(diagnosis.task_success, false);
      assert.match(diagnosis.reconciliation.guidance, /does not establish that a page failed to load/);
      assert.equal(runtime.coordinator.detector.status(runtime.runId).reason, gateBefore.reason);
      assert.equal(runtime.coordinator.detector.status(runtime.runId).probes, gateBefore.probes + 1);
      const repeated = await runtime.control({ ...replayRequest, invokeId: 'diagnosis-after-refresh-click' }, replayParams);
      assert.equal(repeated.receipt.failure.code, 'diagnosis_required'); assert.equal(repeated.receipt.dispatch, 'not_started');
      assert.equal(calls.filter(method => method.startsWith('Input.')).length, inputBefore);
      assert.equal(calls.filter(method => ['Page.bringToFront', 'Target.activateTarget'].includes(method)).length, focusBefore);
      assert.equal(calls.filter(method => method === 'Page.captureScreenshot').length, 0);
      assert.equal(JSON.parse(await browserFixture.state()).saved, 1);
      await fs.writeFile(path.join(directory, 'diagnosis-evidence.json'), JSON.stringify({ readOnly: true,
        gateReason: diagnosis.gate.reason, observedTitle: diagnosis.probes[0].observation.title,
        sources: diagnosis.reconciliation.sources, staleAXInjected: true, nextRoute: diagnosis.reconciliation.next_route,
        additionalInputCount: 0, additionalFocusCount: 0, screenshotCount: 0, uncertainIntentStillBlocked: true,
        modelRoundTrips: null, metricProvenance: 'actual_composed_runtime_owned_headless_chrome_with_injected_stale_ax' }, null, 2), { mode: 0o600 });
      console.log(`Diagnosis artifacts: ${directory}`);
    } finally { await runtime.close(); await browserFixture.close(); }
  });
