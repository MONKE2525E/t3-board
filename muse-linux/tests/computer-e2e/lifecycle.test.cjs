'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { ComputerRuntime } = require('../../src/computer/index.cjs');
const { AccessibilityClient } = require('../../src/computer/desktop/index.cjs');
const C = require('../../src/computer/contracts.cjs');
const { terminal } = require('../computer-journal/helpers.cjs');

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
async function fixture(t, options = {}) {
  const directory = options.directory || await fs.mkdtemp(path.join(os.tmpdir(), 'muse-lifecycle-'));
  const manager = options.manager || {};
  const runtime = new ComputerRuntime({ deviceId: 'lifecycle-device', directory, nativeDirectory: '/unused-lifecycle-native',
    desktop: { paused: false, status: () => ({ paused: false }), ...options.desktop },
    policy: () => ({ browserPolicy: 'allow', desktopPolicy: 'allow' }), permission: options.permission || (async () => true),
    sessionManager: manager });
  await runtime.ready;
  t.after(async () => { if (!runtime.journal.closed) await runtime.close(); if (!options.directory) await fs.rm(directory, { recursive: true, force: true }); });
  return { runtime, directory, manager };
}
function browserScope(runtime) {
  const target = { sessionId: 'lifecycle-session', kind: 'tab', targetId: 'lifecycle-tab', generation: 1, ownership: 'borrowed' };
  runtime.epoch = 1;
  runtime.session = { id: target.sessionId, generation: 1, mode: 'borrowed_browser', ownership: 'borrowed', state: 'ready' };
  runtime.target = target;
  runtime.grant = C.createPrivateHandle('grant', 'lifecycle-grant');
  const browser = {
    active: { state: 'ready', lease: { target } },
    revision: ({ revision }) => revision,
    capabilities: () => ({}),
    privateDigest: () => 'lifecycle-private-digest', urlDigest: () => 'lifecycle-url-digest',
    pause() { this.active.state = 'paused'; },
    async resumeByUser(ctx) { assert.equal(ctx.signal.aborted, false); this.active.state = 'ready'; },
    async detach() { this.active.state = 'detached'; },
    async observe(_request, ctx) {
      return { id: 'lifecycle-observation', refs: { elements: [] }, state: { revision: ctx.revision,
        evidence: [{ source: 'dom', coverage: { complete: true, truncated: false }, facts: [
          { predicate: 'document', value: { title: 'Synthetic lifecycle page', currentUrl: 'https://example.invalid/', headings: [] } },
          { predicate: 'elements', value: [] },
        ] }] } };
    },
  };
  runtime.browser = browser;
  return { target, session: runtime.session, browser };
}

test('StopSync reaches isolated manager cleanup without premarking its descriptor stopped', async t => {
  let cleanupCount = 0;
  const manager = { async stop(_id, reason) {
    assert.equal(reason, 'user_stop');
    if (descriptor.state === 'stopped') return;
    cleanupCount++;
    descriptor.state = 'stopped';
  } };
  const { runtime } = await fixture(t, { manager });
  const descriptor = { id: 'private-lifecycle-session', generation: 1, mode: 'isolated_desktop', state: 'ready' };
  runtime.session = descriptor;
  runtime.stopSync();
  await runtime.stopping;
  assert.equal(cleanupCount, 1);
  assert.equal(runtime.session, null);
});
test('listing a browser connection does not invalidate the active desktop grant generation', async t => {
  const { runtime } = await fixture(t);
  runtime.epoch = 5;
  runtime.connected = { state: 'connected', async detach() {}, async listForLocalPicker(ctx) {
    assert.equal(ctx.revision.grantGeneration, 5);
    return [];
  } };
  const result = await runtime.connection({ action: 'list' });
  assert.equal(result.status, 'choose_tab');
  assert.equal(runtime.epoch, 5);
  assert.equal(runtime.connectionGeneration, 1);
});

test('late connected-browser permission cannot issue a grant or run after Stop', async t => {
  const waiting = deferred(), approval = deferred();
  const { runtime } = await fixture(t, { permission: async () => { waiting.resolve(); return approval.promise; } });
  const { browser, target } = browserScope(runtime);
  runtime.connected = browser;
  runtime.connectedLease = { target, grantGeneration: 1 };
  runtime.connectionSessionId = target.sessionId;
  runtime.connectionGeneration = 1;
  const started = runtime.start({ scope: 'connected_browser', task: 'Synthetic delayed approval', __deadline: Date.now() + 5000 });
  // Attach the rejection assertion before settling the deferred permission.
  const rejected = assert.rejects(started, error => error.code === 'stopped_by_user');
  await waiting.promise;
  await runtime.stop();
  approval.resolve(true);
  await rejected;
  assert.equal(runtime.grant, null);
  assert.equal(runtime.runId, null);
  assert.equal(runtime.runs.size, 0);
});

test('Stop during execution preserves the original action receipt and run identity', async t => {
  const { runtime } = await fixture(t);
  const { target } = browserScope(runtime);
  const runId = await runtime.beginRun();
  const entered = deferred(), finished = deferred();
  const receipt = terminal({ runId, invokeId: 'lifecycle-invoke', actionId: 'lifecycle-action' }, {
    target, before: runtime.revision(), after: runtime.revision(), dispatch: 'possible', effect: 'unknown', replay: 'forbidden',
  });
  let recordedRun;
  runtime.reducer.recordAction = async (recordRun, recorded) => { recordedRun = recordRun; assert.equal(recorded.actionId, receipt.actionId); };
  runtime.coordinator.invoke = async () => { entered.resolve(); await finished.promise; return { receipt, artifacts: [] }; };
  const output = runtime.execute({ command: 'computer.control', params: { action: 'navigate' }, invokeId: receipt.invokeId,
    deadline: Date.now() + 5000 }, { kind: 'navigate', target, url: 'https://example.invalid/' });
  await entered.promise;
  await runtime.stop();
  finished.resolve();
  const result = await output;
  assert.equal(result.receipt.actionId, receipt.actionId);
  assert.equal(result.receipt.effect, 'unknown');
  assert.equal(result.run_id, runId);
  assert.equal(recordedRun, runId);
  assert.equal(result.stopped, true);
  assert.equal(result.task_success, false);
  assert.equal(result.observation, undefined);
});

test('paused browser permits read-only observation, then trusted local Resume restores mutation admission', async t => {
  const { runtime } = await fixture(t);
  const { browser, session } = browserScope(runtime);
  await runtime.beginRun();
  await runtime.pause();
  assert.equal(runtime.status().state, 'paused');
  assert.equal((await runtime.observe()).title, 'Synthetic lifecycle page');
  assert.throws(() => runtime.requireSession(), { code: 'user_resume_required' });
  const resumed = await runtime.resumeByUser();
  assert.equal(resumed.state, 'ready');
  assert.equal(session.state, 'ready');
  assert.equal(browser.active.state, 'ready');
  assert.doesNotThrow(() => runtime.requireSession());
  assert.equal(runtime.observation, null);
});

test('paused scope permits coordinator read-only diagnosis but rejects mutation authorization', async t => {
  const { runtime } = await fixture(t);
  const { target, session } = browserScope(runtime);
  await runtime.pause();
  const expectedRevision = runtime.revision();
  const request = { target, expectedRevision, operation: { kind: 'query', target, query: { exact: true, limit: 1, scope: 'structural' } } };
  assert.equal((await runtime.authorize(runtime.context(), { session, request, phase: 'probe' })).grant, runtime.grant);
  await assert.rejects(runtime.authorize(runtime.context(), { session, request: { ...request,
    operation: { kind: 'navigate', target, url: 'https://example.invalid/' } }, phase: 'before_effect' }));
});

for (const completed of [false, true]) {
  test(`startup unresolved ${completed ? 'terminal unknown' : 'unfinished'} effect fences a fresh run until local review`, async t => {
    const { runtime: first, directory } = await fixture(t);
    const { target } = browserScope(first);
    const runId = await first.beginRun();
    const revision = first.revision();
    const context = { deviceId: 'lifecycle-device', runId, invokeId: 'startup-invoke', actionId: 'startup-action', revision };
    const invocation = { ...context, command: 'computer.action', params: {}, deadlineUtcMs: Date.now() + 5000 };
    assert.equal((await first.journal.admit(invocation, 32768)).accepted, true);
    const handle = await first.journal.begin(context, { command: invocation.command, operationKind: 'click', target,
      parameterMac: await first.journal.parameterMac({}) });
    await first.journal.beforeEffect(handle, { primitive: 'submit', substep: 'click', target, revision });
    if (completed) await first.journal.end(handle, terminal(context, { target, before: revision, after: revision,
      effect: 'unknown', dispatch: 'possible', replay: 'forbidden' }));
    await first.close();
    const { runtime: reopened } = await fixture(t, { directory });
    assert.equal(reopened.status().startup_review_required, true);
    assert.equal(reopened.startupReview.actions[0].runId, runId);
    await assert.rejects(reopened.start({ scope: 'connected_browser', task: 'Fresh unrelated run', __deadline: Date.now() + 5000 }),
      { code: 'startup_review_required' });
    const scope = browserScope(reopened);
    const freshRun = await reopened.beginRun();
    assert.notEqual(freshRun, runId);
    await assert.rejects(reopened.authorize(reopened.context(), { session: scope.session, request: {
      target: scope.target, expectedRevision: reopened.revision(), operation: { kind: 'navigate', target: scope.target, url: 'https://example.invalid/' },
    } }), { code: 'startup_review_required' });
    const reviewed = await reopened.reviewByUser();
    assert.equal(reviewed.previous_effects_verified, false);
    assert.equal(reopened.status().startup_review_required, false);
    await reopened.close();
    const { runtime: acknowledged } = await fixture(t, { directory });
    assert.equal(acknowledged.status().startup_review_required, false);
    const prior = await acknowledged.journal.lookupDelivery('startup-invoke', await acknowledged.journal.invocationMac(invocation));
    assert.notEqual(prior.state, 'new');
    await acknowledged.close();
  });
}

test('desktop setup installs its semantic provider without starting any helper process', async t => {
  const oldAddress = process.env.AT_SPI_BUS_ADDRESS;
  process.env.AT_SPI_BUS_ADDRESS = 'unix:path=/synthetic-lifecycle-bus';
  t.after(() => { if (oldAddress === undefined) delete process.env.AT_SPI_BUS_ADDRESS; else process.env.AT_SPI_BUS_ADDRESS = oldAddress; });
  t.mock.method(AccessibilityClient.prototype, 'start', async () => ({ ready: true }));
  const { runtime } = await fixture(t, { desktop: { async session() { return { session_id: 'synthetic-desktop-session' }; } } });
  const started = await runtime.start({ scope: 'desktop', action: 'start', task: 'Synthetic desktop setup', __deadline: Date.now() + 5000 });
  assert.equal(started.session_id, 'synthetic-desktop-session');
  assert.equal(typeof runtime.adapter?.perform, 'function');
  assert.equal(runtime.desktopController.accessibility, runtime.accessibility);
  assert.equal(runtime.hostRunner.children.size, 0);
});
