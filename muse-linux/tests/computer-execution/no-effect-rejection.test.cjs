'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { LegacyCommandAdapter } = require('../../src/computer/executor.cjs');
const { action, context, fixture, target, revision } = require('./helpers.cjs');

function rejectedReceipt(ctx, overrides = {}) {
  return { target, before: revision, dispatch: 'not_started', effect: 'none_proven', attempts: [], evidence: [],
    timings: ctx.progress.timings(), failure: { kind: 'permission_denied', code: 'permission_denied' }, ...overrides };
}

test('validated preparation rejection preserves no effect without quiescing or poisoning the next action', async () => {
  const f = fixture(), original = f.adapter.perform;
  let calls = 0, quiesces = 0;
  f.adapter.perform = async (op, ctx) => ++calls === 1 ? rejectedReceipt(ctx) : original(op, ctx);
  f.adapter.quiesce = async () => { quiesces++; return { state: 'unknown', ownedInputReleased: false, reasonCodes: ['worker_busy'] }; };

  const denied = await f.coordinator.execute(action(), context());
  assert.equal(denied.execution, 'rejected');
  assert.equal(denied.failure.kind, 'permission_denied');
  assert.equal(denied.dispatch, 'not_started');
  assert.equal(denied.effect, 'none_proven');
  assert.equal(denied.failure.effect, 'none_proven');
  assert.equal(denied.replay, 'refresh_before_new_action');
  assert.equal(denied.attempts.length, 0);
  assert.equal(f.edits, 0);
  assert.equal(quiesces, 0);
  assert.ok(!f.journal.order.includes('durable-intent'));

  const next = await f.coordinator.execute(action('a2', { invokeId: 'i2' }), context({ invokeId: 'i2' }));
  assert.equal(next.execution, 'completed');
  assert.equal(next.effect, 'verified');
  assert.equal(f.edits, 1);
  assert.equal(quiesces, 0);
});

test('malformed no-effect response remains unknown and requires quiescence and a blocked lease', async () => {
  const f = fixture(); let quiesces = 0;
  f.adapter.perform = async (_op, ctx) => rejectedReceipt(ctx, { noEffectProven: true });
  f.adapter.quiesce = async () => { quiesces++; return { state: 'confirmed', ownedInputReleased: true, reasonCodes: [] }; };
  const result = await f.coordinator.execute(action(), context());
  assert.equal(result.failure.code, 'adapter_contract_violation');
  assert.equal(result.dispatch, 'possible');
  assert.equal(result.effect, 'unknown');
  assert.equal(result.replay, 'forbidden');
  assert.equal(quiesces, 1);
  const next = await f.coordinator.execute(action('a2', { invokeId: 'i2', operation: { kind: 'focus', ref: action().operation.ref } }), context({ invokeId: 'i2' }));
  assert.equal(next.dispatch, 'not_started');
  assert.equal(next.failure.code, 'lease_poisoned');
});

test('thrown unmarked permission failure cannot establish that the adapter sent no input', async () => {
  const f = fixture(); let quiesces = 0;
  f.adapter.perform = async () => { throw Object.assign(new Error('synthetic preparation failure'), { kind: 'permission_denied', code: 'permission_denied' }); };
  f.adapter.quiesce = async () => { quiesces++; return { state: 'confirmed', ownedInputReleased: true, reasonCodes: [] }; };
  const result = await f.coordinator.execute(action(), context());
  assert.equal(result.failure.kind, 'permission_denied');
  assert.equal(result.dispatch, 'possible');
  assert.equal(result.effect, 'unknown');
  assert.equal(result.failure.effect, 'unknown');
  assert.equal(result.failure.requiredNext, 'read_authoritative_state_do_not_replay');
  assert.equal(result.replay, 'forbidden');
  assert.equal(quiesces, 1);
});

for (const [name, overrides] of [
  ['foreign target', { target: { ...target, targetId: 'unrelated-window' } }],
  ['stale revision', { before: { ...revision, semanticRevision: 2 } }],
]) test(`no-effect response for a ${name} cannot clear uncertainty for the requested action`, async () => {
  const f = fixture();
  f.adapter.perform = async (_op, ctx) => rejectedReceipt(ctx, overrides);
  const result = await f.coordinator.execute(action(), context());
  assert.equal(result.failure.kind, 'stale_target');
  assert.equal(result.dispatch, 'possible');
  assert.equal(result.effect, 'unknown');
  assert.equal(result.replay, 'forbidden');
  const next = await f.coordinator.execute(action('a2', { invokeId: 'i2', operation: { kind: 'focus', ref: action().operation.ref } }), context({ invokeId: 'i2' }));
  assert.equal(next.failure.code, 'lease_poisoned');
});

test('a valid no-effect response cannot erase a crossed effect boundary', async () => {
  const f = fixture(); let quiesces = 0;
  f.adapter.perform = async (_op, ctx) => {
    const attempt = await ctx.dispatch.beforeEffect({ primitive: 'atspi.SetTextContents', substep: 'editText', target });
    await ctx.dispatch.afterEffect(attempt, { state: 'accepted', noEffectProven: false });
    return rejectedReceipt(ctx);
  };
  f.adapter.quiesce = async () => { quiesces++; return { state: 'confirmed', ownedInputReleased: true, reasonCodes: [] }; };
  const result = await f.coordinator.execute(action(), context());
  assert.equal(result.dispatch, 'acknowledged');
  assert.equal(result.effect, 'unknown');
  assert.equal(result.attempts.length, 1);
  assert.equal(result.replay, 'forbidden');
  assert.equal(quiesces, 1);
});

test('legacy coarse no-effect flags remain possible and unknown behind the recorded boundary', async () => {
  let calls = 0;
  const adapter = new LegacyCommandAdapter({ commandFor: () => ({ command: 'fixture', params: {} }),
    invokeLegacy: async () => { calls++; return { dispatch: 'not_started', effect: 'none_proven', noEffectProven: true, failure: { kind: 'permission_denied', code: 'permission_denied' } }; },
    preflight: async () => ({ eligible: true, revision, noEffectProven: true, evidence: [] }),
    quiesce: async () => ({ state: 'confirmed', ownedInputReleased: true, reasonCodes: [] }) });
  const f = fixture({ adapter });
  const result = await f.coordinator.execute(action('a1', { expect: [] }), context());
  assert.equal(calls, 1);
  assert.equal(result.dispatch, 'possible');
  assert.equal(result.effect, 'unknown');
  assert.equal(result.attempts.length, 1);
  assert.equal(result.replay, 'forbidden');
  assert.ok(f.journal.order.includes('durable-intent'));
});
