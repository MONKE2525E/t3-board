'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { ComputerRuntime } = require('../../src/computer/index.cjs');
const { ReceiptJournal, RunReducer } = require('../../src/computer/journal/index.cjs');
const C = require('../../src/computer/contracts.cjs');

async function fixture(t, requirements = []) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'muse-handoff-'));
  const policy = { desktopPolicy: 'allow', browserPolicy: 'allow' };
  const runtime = new ComputerRuntime({ deviceId: 'handoff-device', directory,
    nativeDirectory: '/unused-handoff-native', sessionManager: { async stop() {} }, policy: () => policy,
    permission: async () => true, desktop: { paused: false, status: () => ({}) } });
  await runtime.ready;
  t.after(async () => { await runtime.close(); await fs.rm(directory, { recursive: true, force: true }); });
  runtime.session = { id: 'handoff-session', mode: 'isolated_desktop', generation: 1, state: 'ready', display: { instanceId: 'handoff-display' } };
  runtime.epoch = 1; runtime.grant = C.createPrivateHandle('grant', 'handoff-grant');
  runtime.target = { sessionId: runtime.session.id, kind: 'window', targetId: 'handoff-window', generation: 1, ownership: 'owned' };
  const declared = requirements.map(id => ({ id, validator: 'element.focused', validatorVersion: 1, target: runtime.target, args: { refId: 'field' } }));
  await runtime.beginRun(declared);
  let inputs = 0;
  runtime.adapter = {
    preflight: async (_operation, ctx) => ({ eligible: true, revision: ctx.revision, evidence: [], noEffectProven: true }),
    perform: async (_operation, ctx) => {
      const marker = await ctx.dispatch.beforeEffect({ primitive: 'KeyPress', substep: 'press', target: runtime.target });
      inputs++; await ctx.dispatch.afterEffect(marker, { state: 'accepted', noEffectProven: false });
      return { target: runtime.target, before: ctx.revision, dispatch: 'acknowledged', effect: 'unknown', evidence: [], attempts: [], timings: ctx.progress.timings() };
    },
    probe: async () => [], quiesce: async () => ({ state: 'confirmed', ownedInputReleased: true, reasonCodes: [] }),
  };
  runtime.desktopController = { ...runtime.adapter, async quiesce() { return { state: 'confirmed', ownedInputReleased: true, reasonCodes: [] }; } };
  const request = id => ({ command: 'computer.control', invokeId: id, params: { action: 'press', key: id }, deadline: Date.now() + 5000 });
  const operation = chord => ({ kind: 'press', target: runtime.target, chord });
  return { runtime, directory, policy, request, operation, get inputs() { return inputs; } };
}

test('authenticated rejection survives restart without claiming a goal was attempted', async t => {
  const f = await fixture(t, ['tracking']);
  f.policy.desktopPolicy = 'deny';
  const output = await f.runtime.execute(f.request('denied-invoke'), f.operation('Enter'), { requirementIds: ['tracking'], noObservation: true });
  assert.equal(output.receipt.dispatch, 'not_started');
  assert.equal(output.receipt.effect, 'none_proven');
  assert.equal(output.handoff_status, undefined);
  assert.equal(f.inputs, 0);
  const result = await f.runtime.runResult({});
  assert.equal(result.requirements[0].status, 'not_attempted');
  assert.deepEqual(result.requirements[0].actionIds, []);
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0].actionId, output.receipt.actionId);
  assert.equal(result.failures[0].code, 'permission_denied');
  await assert.rejects(f.runtime.reducer.recordRejectedInvocation(f.runtime.runId, { ...output.receipt, actionId: 'invented-action' }), { code: 'invalid_request' });
  await f.runtime.close();
  const journal = new ReceiptJournal({ directory: path.join(f.directory, 'computer-journal'), deviceId: 'handoff-device' });
  await journal.ready;
  const recovered = await new RunReducer({ journal }).result(result.runId);
  assert.equal(recovered.failures[0].actionId, output.receipt.actionId);
  assert.equal(recovered.requirements[0].status, 'not_attempted');
  assert.equal(recovered.counters.primitiveAttempts, 0);
  await journal.close();
});

test('unknown requirement IDs reject the action before invocation admission or input', async t => {
  const f = await fixture(t, ['orders']);
  await assert.rejects(f.runtime.execute(f.request('bad-requirement'), f.operation('Enter'), { requirementIds: ['tracking'], noObservation: true }), { code: 'invalid_request' });
  assert.equal(f.inputs, 0);
  assert.equal((await f.runtime.runResult({})).counters.invokes, 0);
});

test('read-only probes acquire trusted current revision, while mutations cannot omit or change it', async t => {
  const f = await fixture(t);
  const query = { kind: 'query', target: f.runtime.target, query: { exact: true, limit: 1, scope: 'structural' } };
  const policy = await f.runtime.authorize(f.runtime.context(), { session: f.runtime.session, request: { target: f.runtime.target, operation: query } });
  assert.deepEqual(policy.revision, f.runtime.revision());
  await assert.rejects(f.runtime.authorize(f.runtime.context(), { session: f.runtime.session,
    request: { target: f.runtime.target, operation: f.operation('Enter') } }), { code: 'stale_session' });
  await assert.rejects(f.runtime.authorize(f.runtime.context(), { session: f.runtime.session,
    request: { target: f.runtime.target, operation: query, expectedRevision: { ...f.runtime.revision(), targetGeneration: 2 } } }), { code: 'stale_session' });
  assert.equal(f.inputs, 0);
});

function plan(f, requirementIds = ['orders']) {
  const runId = f.runtime.runId, invokeId = 'handoff-plan-invoke';
  return { schema: 'muse.plan.v1', planId: 'handoff-plan', runId, invokeId, sessionId: f.runtime.session.id, totalBudgetMs: 5000,
    steps: ['first', 'denied', 'skipped'].map((id, index) => ({ id, kind: 'act', action: {
      schema: 'muse.action.v1', actionId: `handoff-action-${index}`, runId, invokeId, target: f.runtime.target,
      expectedRevision: f.runtime.revision(), operation: f.operation(id), require: [], expect: [], requirementIds,
    } })) };
}

test('plan handoff includes successful attempts, rejected steps and a skipped suffix', async t => {
  const f = await fixture(t, ['orders', 'tracking']);
  const provider = f.runtime.desktopController;
  const perform = provider.perform;
  provider.perform = async (...args) => { const output = await perform(...args); f.policy.desktopPolicy = 'deny'; return output; };
  const input = plan(f);
  const output = await f.runtime.plan({ command: 'computer.plan', invokeId: input.invokeId, params: { request: input }, deadline: Date.now() + 5000 }, { request: input });
  assert.equal(output.handoff_status, undefined);
  assert.equal(output.receipt.steps.length, 3);
  assert.equal(output.receipt.steps[0].actionReceipt.dispatch, 'acknowledged', JSON.stringify(output.receipt.steps[0]));
  assert.equal(output.receipt.steps[1].actionReceipt.dispatch, 'not_started');
  assert.equal(output.receipt.steps[2].execution, 'skipped');
  assert.equal(f.inputs, 1);
  const result = await f.runtime.runResult({});
  assert.equal(result.requirements[0].status, 'attempted_unverified');
  assert.deepEqual(result.requirements[0].actionIds, ['handoff-action-0']);
  assert.equal(result.requirements[1].status, 'not_attempted');
  assert.equal(result.failures[0].actionId, 'handoff-action-1');
  assert.equal(result.plans[0].steps[1].actionId, 'handoff-action-1');
  assert.equal(result.plans[0].steps[2].execution, 'skipped');
  const duplicate = await f.runtime.delivery({ command: 'computer.plan', invokeId: input.invokeId, params: { request: input } });
  assert.equal(duplicate.receipt.steps[1].actionId, 'handoff-action-1');
  assert.equal(duplicate.receipt.steps[1].dispatch, 'not_started');
  assert.equal(duplicate.receipt.steps[2].execution, 'skipped');
  assert.equal(f.inputs, 1);
});

test('failed read-only plan steps and skipped suffix survive in the parent handoff after restart', async t => {
  const f = await fixture(t, ['orders']);
  const input = plan(f);
  input.steps = [{ id: 'assert-page', kind: 'assert', predicates: [{ id: 'assert-orders', validator: 'element.focused', validatorVersion: 1,
    target: f.runtime.target, args: { refId: 'missing-ref' }, requirementId: 'orders' }] }, input.steps[0]];
  const output = await f.runtime.plan({ command: 'computer.plan', invokeId: input.invokeId, params: { request: input }, deadline: Date.now() + 5000 }, { request: input });
  assert.equal(output.receipt.steps[0].execution, 'failed');
  assert.equal(output.receipt.steps[1].execution, 'skipped');
  assert.equal(f.inputs, 0);
  const result = await f.runtime.runResult({});
  assert.equal(result.plans[0].steps[0].failure.code, 'assertion_failed');
  assert.equal(result.plans[0].steps[1].execution, 'skipped');
  assert.equal(result.requirements[0].status, 'not_attempted');
  assert.equal(result.counters.primitiveAttempts, 0);
  const page = await f.runtime.reducer.read({ runId: result.runId });
  assert.equal(page.plans[0].steps[0].failure.code, 'assertion_failed');
  await f.runtime.close();
  const journal = new ReceiptJournal({ directory: path.join(f.directory, 'computer-journal'), deviceId: 'handoff-device' });
  await journal.ready;
  const recovered = await new RunReducer({ journal }).result(result.runId);
  assert.equal(recovered.plans[0].steps[0].id, 'assert-page');
  assert.equal(recovered.plans[0].steps[0].failure.code, 'assertion_failed');
  assert.equal(recovered.plans[0].steps[1].execution, 'skipped');
  await journal.close();
});

test('unknown requirement in a later plan step prevents every earlier effect', async t => {
  const f = await fixture(t, ['orders']);
  const input = plan(f); input.steps[2].action.requirementIds = ['tracking'];
  await assert.rejects(f.runtime.plan({ command: 'computer.plan', invokeId: input.invokeId, params: { request: input }, deadline: Date.now() + 5000 }, { request: input }), { code: 'invalid_request' });
  assert.equal(f.inputs, 0);
  assert.equal((await f.runtime.runResult({})).counters.invokes, 0);
});

test('current-state handoff reports only a fresh selected DOM acquisition and keeps URLs private', async t => {
  const f = await fixture(t);
  f.runtime.session.mode = 'borrowed_browser';
  const revision = f.runtime.revision();
  f.runtime.observation = { id: 'handoff-observation', state: { target: f.runtime.target, revision, pendingNavigation: false,
    evidence: [{ id: 'handoff-document', source: 'dom', target: f.runtime.target, acquisition: 'ok', freshness: 'current',
      revisionBefore: revision, revisionAfter: revision, interval: { startMonoMs: performance.now(), endMonoMs: performance.now(), clockDomain: 'node.performance' },
      coverage: { scope: 'main_frame_document', complete: true, truncated: false }, facts: [{ predicate: 'document', value: { title: 'Owned fixture page', urlDigest: 'private-url-digest', currentUrl: 'https://private.invalid/orders?secret=canary', readyState: 'complete' } }] }] } };
  const fresh = await f.runtime.runResult({});
  assert.equal(fresh.currentTarget.freshness, 'current');
  assert.equal(fresh.page.title, 'Owned fixture page');
  assert.equal(fresh.page.urlDigest, 'private-url-digest');
  assert.equal(fresh.page.readyState, 'complete');
  assert.equal(fresh.currentTarget.actualFocus, undefined);
  assert.equal(JSON.stringify(fresh).includes('secret=canary'), false);
  f.runtime.observation.state.evidence[0].target = { ...f.runtime.target, targetId: 'foreign-window' };
  assert.equal((await f.runtime.runResult({})).currentTarget.freshness, 'stale');
  f.runtime.observation.state.evidence[0].target = f.runtime.target;
  f.runtime.observation.state.evidence[0].interval.endMonoMs -= 2000;
  assert.equal((await f.runtime.runResult({})).currentTarget.freshness, 'stale');
  f.runtime.target = { ...f.runtime.target, generation: 2 };
  const switched = await f.runtime.runResult({});
  assert.equal(switched.currentTarget.freshness, 'stale');
  assert.equal(switched.page.freshness, 'stale');
});
