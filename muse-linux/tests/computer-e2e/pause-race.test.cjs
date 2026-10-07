'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { ComputerRuntime } = require('../../src/computer/index.cjs');
const { BrowserController } = require('../../src/computer/browser/index.cjs');
const C = require('../../src/computer/contracts.cjs');
const { boundary } = require('../../src/computer/desktop/common.cjs');
const { identity } = require('../../src/computer/session/resources.cjs');

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
async function fixture(t, manager = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'muse-pause-race-'));
  const runtime = new ComputerRuntime({ deviceId: 'pause-race-device', directory,
    nativeDirectory: '/unused-pause-race-native', sessionManager: manager,
    policy: () => ({ browserPolicy: 'allow', desktopPolicy: 'allow' }),
    permission: async () => true, desktop: { paused: false, status: () => ({}) } });
  await runtime.ready;
  t.after(async () => { await runtime.close(); await fs.rm(directory, { recursive: true, force: true }); });
  runtime.epoch = 1;
  runtime.grant = C.createPrivateHandle('grant', 'pause-race-grant');
  return runtime;
}
function cancellation(error) {
  return ['user_resume_required', 'stopped_by_user', 'user_takeover', 'cancelled'].includes(error.code);
}
async function browserScope(t) {
  const runtime = await fixture(t), entered = deferred(), approval = deferred();
  const target = { sessionId: 'pause-browser-session', kind: 'tab', targetId: 'pause-browser-tab',
    generation: 1, ownership: 'borrowed' };
  const browser = new BrowserController({ policy: { authorize: async (_ctx, { action }) => {
    if (action === 'local_user_resume') { entered.resolve(); await approval.promise; }
    return true;
  } } });
  browser.active = { state: 'paused', lease: { target, grantGeneration: 1 } };
  // This fixture never connects a transport or creates a browser process.
  browser.detach = async () => { browser.active = null; };
  runtime.session = { id: target.sessionId, generation: 1, mode: 'borrowed_browser', state: 'paused' };
  runtime.target = target; runtime.browser = browser;
  await runtime.beginRun();
  return { runtime, browser, entered, approval };
}
test('later Pause outranks browser Resume awaiting trusted authorization', async t => {
  const { runtime, entered, approval } = await browserScope(t);
  const resuming = runtime.resumeByUser();
  const rejected = assert.rejects(resuming, cancellation);
  await entered.promise;
  await runtime.pause();
  approval.resolve();
  await rejected;
  assert.equal(runtime.status().state, 'paused');
  assert.throws(() => runtime.requireSession(), { code: 'user_resume_required' });
});
test('later Stop outranks browser Resume awaiting trusted authorization', async t => {
  const { runtime, entered, approval } = await browserScope(t);
  const resuming = runtime.resumeByUser();
  const rejected = assert.rejects(resuming, cancellation);
  await entered.promise;
  await runtime.stop();
  approval.resolve();
  await rejected;
  assert.equal(runtime.session, null);
  assert.equal(runtime.status().state, 'stopped');
  assert.throws(() => runtime.requireSession(), { code: 'session_required' });
});
test('later Pause outranks isolated Resume during accessibility readiness', async t => {
  const entered = deferred(), ready = deferred();
  let session;
  const manager = {
    issueLocalResumeToken: () => ({}),
    async resumeByUser() { session.state = 'ready'; },
    async pause() { session.state = 'paused'; },
    async stop() { session.state = 'stopped'; },
  };
  const runtime = await fixture(t, manager);
  session = { id: 'pause-isolated-session', generation: 1, mode: 'isolated_desktop', state: 'paused' };
  runtime.session = session;
  runtime.accessibility = { async start() { entered.resolve(); await ready.promise; }, async stop() {} };
  await runtime.beginRun();
  const resuming = runtime.resumeByUser();
  const rejected = assert.rejects(resuming, cancellation);
  await entered.promise;
  await runtime.pause();
  ready.resolve();
  await rejected;
  assert.equal(session.state, 'paused');
  assert.equal(runtime.status().state, 'paused');
  assert.throws(() => runtime.requireSession(), { code: 'user_resume_required' });
});
test('later Stop prevents accessibility startup after deferred isolated Resume', async t => {
  const entered = deferred(), ready = deferred();
  let starts = 0, stops = 0, session;
  const manager = {
    issueLocalResumeToken: () => ({}),
    async resumeByUser() { entered.resolve(); await ready.promise; session.state = 'ready'; },
    async stop() { stops++; session.state = 'stopped'; },
  };
  const runtime = await fixture(t, manager);
  session = { id: 'stop-isolated-session', generation: 1, mode: 'isolated_desktop', state: 'paused' };
  runtime.session = session;
  runtime.accessibility = { async start() { starts++; }, async stop() {} };
  await runtime.beginRun();
  const resuming = runtime.resumeByUser();
  const rejected = assert.rejects(resuming, cancellation);
  await entered.promise;
  await runtime.stop();
  ready.resolve();
  await rejected;
  assert.equal(starts, 0);
  assert.equal(stops, 1);
  assert.equal(runtime.session, null);
  assert.throws(() => runtime.requireSession(), { code: 'session_required' });
});

test('Pause while a durable desktop input marker is pending delivers zero later input', { timeout: 10000 }, async t => {
  const runtime = await fixture(t), markerEntered = deferred(), markerReply = deferred();
  const processIdentity = identity(process.pid);
  const target = { sessionId: 'pause-marker-session', kind: 'window', targetId: 'pause-marker-window', generation: 1,
    ownership: 'borrowed', process: { pid: processIdentity.pid, startToken: processIdentity.startToken } };
  runtime.session = { id: target.sessionId, generation: 1, mode: 'real_desktop', state: 'ready', display: { instanceId: 'pause-marker-display' } };
  runtime.target = target;
  runtime.desktop.windows = async () => [{ window_id: target.targetId, pid: process.pid }];
  runtime.desktop.pause = () => { runtime.desktop.paused = true; };
  await runtime.beginRun();
  let inputCount = 0, quiesces = 0;
  const adapter = {
    async preflight(_op, ctx) { return { eligible: true, revision: ctx.revision, evidence: [], noEffectProven: true }; },
    async perform(_op, ctx) {
      await boundary(ctx, 'KeyPress', target, async () => { inputCount++; return { accepted: true }; }, 'press');
      return { target, before: ctx.revision, dispatch: 'acknowledged', effect: 'unknown', evidence: [], attempts: [], timings: ctx.progress.timings() };
    },
    async quiesce() { quiesces++; return { state: 'confirmed', ownedInputReleased: true, reasonCodes: [] }; },
  };
  runtime.adapter = adapter; runtime.desktopController = adapter;
  const originalMarker = runtime.journal.beforeEffect.bind(runtime.journal);
  runtime.journal.beforeEffect = async (...args) => {
    const marker = await originalMarker(...args);
    markerEntered.resolve();
    await markerReply.promise;
    return marker;
  };
  const execution = runtime.execute({ command: 'computer.control', params: { action: 'key', key: 'Enter' },
    invokeId: 'pause-marker-invoke', deadline: Date.now() + 5000 }, { kind: 'press', target, chord: 'Enter' }, { noObservation: true });
  await markerEntered.promise;
  assert.equal(inputCount, 0);
  await runtime.pause();
  assert.equal(runtime.status().state, 'paused');
  markerReply.resolve();
  const output = await execution;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(inputCount, 0);
  assert.equal(output.dispatched, false);
  assert.equal(output.task_success, false);
  assert.ok(quiesces > 0);
  assert.throws(() => runtime.requireSession(), { code: 'user_resume_required' });
});
