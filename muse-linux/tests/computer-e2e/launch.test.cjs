'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { ComputerRuntime } = require('../../src/computer/index.cjs');
const { sessionTarget } = require('../../src/computer/session-launch.cjs');
const C = require('../../src/computer/contracts.cjs');
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'muse-launch-'));
  let launches = 0, allowed = true;
  const session = { id: 'launch-session', mode: 'isolated_desktop', generation: 2, state: 'ready', ownership: 'owned', display: { instanceId: 'launch-compositor' } };
  const manager = { options: { apps: { files: {}, terminal: {}, calibration: { internalOnly: true } } },
    async launch(id, req) {
      launches++;
      if (req.appId === 'terminal') throw Object.assign(Error('transport_lost'), { kind: 'transport_lost', code: 'transport_lost' });
      return { sessionId: id, process: { pid: 12345, startToken: 'synthetic-process-token' }, ownership: 'owned' };
    },
    async stop() { session.state = 'stopped'; },
  };
  const runtime = new ComputerRuntime({ deviceId: 'launch-device', directory, nativeDirectory: '/unused-native', sessionManager: manager,
    desktop: { paused: false }, policy: () => ({ desktopPolicy: allowed ? 'allow' : 'deny', browserPolicy: 'deny' }), permission: async () => true });
  await runtime.ready;
  runtime.session = session; runtime.epoch = 1; runtime.grant = C.createPrivateHandle('grant', 'launch-grant');
  await runtime.beginRun();
  runtime.observe = async () => { throw Error('must_not_observe_launch'); };
  t.after(async () => { await runtime.close(); await fs.rm(directory, { recursive: true, force: true }); });
  const invoke = (app, invokeId = `launch-${app}`) => {
    const args = { action: 'open_app', app };
    return runtime.control({ command: 'computer.control', params: args, invokeId, deadline: Date.now() + 5000 }, args);
  };
  return { runtime, session, manager, invoke, deny: () => { allowed = false; }, get launches() { return launches; } };
}

test('isolated launch records durable session intent, returns actual process metadata and duplicate never launches again', async t => {
  const f = await fixture(t);
  const output = await f.invoke('files');
  assert.equal(f.launches, 1);
  assert.equal(output.launched, true);
  assert.equal(output.process.pid, 12345);
  assert.equal(output.task_success, false);
  assert.equal(output.window_verified, false);
  assert.equal(output.required_next, 'observe');
  assert.equal(output.route, 'isolated_session');
  assert.equal(output.receipt.target.kind, 'session');
  assert.equal(output.receipt.dispatch, 'acknowledged');
  assert.equal(output.receipt.effect, 'unknown');
  assert.equal(output.receipt.attempts[0].primitive, 'Session.launch');
  const delivery = await f.runtime.journal.lookupDelivery('launch-files', await f.runtime.journal.invocationMac({ command: 'computer.control', params: { action: 'open_app', app: 'files' } }));
  assert.equal(delivery.state, 'receipt');
  assert.equal(delivery.receipt.receipt.target.kind, 'session');
  const duplicate = await f.invoke('files');
  assert.equal(duplicate.duplicate_delivery, true);
  assert.equal(f.launches, 1);
  assert.equal(duplicate.receipt.actionId, output.receipt.actionId);
});
test('allowlist and revoked policy reject before launch with no effect', async t => {
  const f = await fixture(t);
  for (const app of ['unknown', 'calibration']) {
    const result = await f.invoke(app);
    assert.equal(result.receipt.effect, 'none_proven');
    assert.equal(result.receipt.dispatch, 'not_started');
    assert.equal(result.receipt.attempts.length, 0);
  }
  assert.equal(f.launches, 0);
  f.deny();
  const denied = await f.invoke('files');
  assert.equal(denied.receipt.effect, 'none_proven');
  assert.equal(f.launches, 0);
});
test('typed launch routes the owned session target without a window or observation', async t => {
  const f = await fixture(t);
  const input = { operation: { kind: 'launchApp', appId: 'files' } };
  const params = { request: JSON.stringify(input) };
  const request = { command: 'computer.action', params, invokeId: 'typed-launch', deadline: Date.now() + 5000 };
  const output = await f.runtime.action(request, params);
  assert.equal(f.launches, 1);
  assert.equal(output.route, 'isolated_session');
  assert.equal(output.receipt.target.kind, 'session');
  assert.equal(output.receipt.attempts[0].primitive, 'Session.launch');
  assert.equal(output.receipt.effect, 'unknown');
  assert.equal(output.window_verified, false);
  const duplicate = await f.runtime.action(request, params);
  assert.equal(duplicate.duplicate_delivery, true);
  assert.equal(f.launches, 1);
});
test('post-boundary launch failure is unknown and exposes no invented process', async t => {
  const f = await fixture(t);
  const output = await f.invoke('terminal');
  assert.equal(f.launches, 1);
  assert.equal(output.receipt.dispatch, 'possible');
  assert.equal(output.receipt.effect, 'unknown');
  assert.equal(output.error, 'transport_lost');
  assert.equal(output.process, undefined);
  assert.equal(output.launched, undefined);
  assert.equal(output.task_success, false);
});
test('Stop while preflight is pending prevents a late launch', async t => {
  const f = await fixture(t);
  const original = f.runtime.authorize.bind(f.runtime);
  let release, entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  f.runtime.authorize = async (ctx, request) => { if (request.phase === 'admission') { entered(); await blocked; } return original(ctx, request); };
  const pending = f.invoke('files');
  await waiting;
  await f.runtime.stop();
  release();
  const output = await pending;
  assert.equal(f.launches, 0);
  assert.equal(output.receipt.effect, 'none_proven');
  assert.equal(output.receipt.dispatch, 'not_started');
});
test('session target is exact owned compositor lifetime and cannot masquerade as a window', async t => {
  const { session } = await fixture(t);
  const target = sessionTarget(session);
  const op = { kind: 'launchApp', target, appId: 'files' };
  assert.equal(C.validateOperation(op, 'isolated_desktop'), op);
  assert.throws(() => C.validateOperation(op, 'real_desktop'));
  assert.throws(() => C.validateOperation({ ...op, target: { ...target, kind: 'window' } }, 'isolated_desktop'));
  assert.throws(() => C.validateTargetRef({ ...target, targetId: 'pretend-window' }));
  assert.throws(() => C.validateTargetRef({ ...target, ownership: 'borrowed' }));
  assert.throws(() => C.validateOperation({ kind: 'closeWindow', target }, 'isolated_desktop'));
});
