'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { AccessibilityClient } = require('../../src/computer/desktop/index.cjs');
const { AssertionRegistry, normalizeAdapterReceipt } = require('../../src/computer/state/index.cjs');
const { action, invocation, context, fixture, target, revision, session } = require('./helpers.cjs');

// Concrete accessibility client and state normalization; the private worker is a synthetic in-memory fixture.
function nativeFixture(mode, { corrupt = false, failInsert = false } = {}) {
  let text = 'A'.repeat(3000) + '你好🙂' + 'Z'.repeat(3000), mutations = 0;
  const initial = text, caret = 1500, selection = [1800, 2500], selectedTarget = { ...target, process: { pid: 123, startToken: 'owned-fixture-start' } };
  const hash = value => createHash('sha256').update(value).digest('hex');
  const native = { busUniqueName: ':1.42', objectPath: '/fixture/field', rootHandle: 'root', ownerStartToken: 'owned-fixture-start', handle: 'native-field',
    role: 'entry', roleCode: 77, name: 'synthetic-field', capabilities: ['editText'], states: ['editable', 'enabled', 'sensitive', 'multiline'] };
  const client = new AccessibilityClient({ channel: { async request(operation, params) {
    if (operation === 'resolve' || operation === 'renew') return native;
    if (operation === 'readText') {
      const chars = [...text], end = Math.min(chars.length, params.offset + params.limitScalars);
      return { text: chars.slice(params.offset, end).join(''), totalScalars: chars.length, totalUtf8Bytes: Buffer.byteLength(text), privateReadHash: hash(text), start: params.offset, end, caret, selections: [selection] };
    }
    assert.equal(params.beforeHash, hash(text));
    if (failInsert && operation === 'insert') throw Object.assign(new Error('synthetic insertion failure'), { code: 'transport_lost' });
    const chars = [...text];
    if (operation === 'delete') text = chars.slice(0, params.position).join('') + chars.slice(params.end).join('');
    else if (operation === 'insert') text = chars.slice(0, params.position).join('') + params.text + chars.slice(params.position).join('');
    else throw new Error('unexpected fixture operation');
    if (corrupt && operation === 'insert') text += 'unexpected';
    mutations++; return { accepted: true };
  } } });
  client.session = session; client.generation = 1;
  const ref = client.issue(native, selectedTarget, context(), 'native-refs');
  const request = action('a1', { target: selectedTarget, expect: [], operation: { kind: 'editText', ref, edit: { ...action().operation.edit, mode, text: '+\n🙂' } } });
  const adapter = {
    preflight: async (_op, ctx) => { await client.resolve(ref, ctx); return { eligible: true, revision, evidence: [], noEffectProven: true }; },
    perform: async (op, ctx) => {
      const raw = await client.edit(op.ref, op.edit, ctx);
      const result = normalizeAdapterReceipt(JSON.parse(JSON.stringify({ ...raw, target: selectedTarget, before: revision })), { operation: op, privateDigest: value => client.digest(value) });
      return { target: selectedTarget, before: revision, dispatch: result.dispatch, effect: result.effect, attempts: [], evidence: result.evidence,
        timings: ctx.progress.timings(), ...(raw.execution === 'failed' ? { failure: { kind: 'assertion_failed', code: 'assertion_failed' } } : {}) };
    },
    probe: async (_predicates, _target, ctx) => {
      const read = await client.readText(ref, { mode: 'verify' }, ctx);
      const normalized = normalizeAdapterReceipt(JSON.parse(JSON.stringify({ target: selectedTarget, before: revision, evidence: [read.evidence], readback: read })), { operation: request.operation });
      return normalized.evidence;
    },
    quiesce: async () => ({ state: 'confirmed', ownedInputReleased: true, reasonCodes: [] }),
  };
  const f = fixture({ adapter, assertions: new AssertionRegistry() });
  const chars = [...initial], start = mode === 'append' ? chars.length : mode === 'insert' ? caret : selection[0], end = mode === 'replaceSelection' ? selection[1] : start;
  const expected = chars.slice(0, start).join('') + request.operation.edit.text + chars.slice(end).join('');
  return { ...f, client, request, expected, get value() { return text; }, get mutations() { return mutations; } };
}

for (const mode of ['append', 'insert', 'replaceSelection']) test(`coordinator verifies full ${mode} through concrete accessibility client and callback-bound private digest`, async () => {
  const f = nativeFixture(mode), before = JSON.stringify(f.request);
  const result = await f.coordinator.invoke(invocation(f.request), session);
  assert.equal(result.receipt.failure, undefined, JSON.stringify(result.receipt));
  assert.equal(result.receipt.effect, 'verified'); assert.equal(result.receipt.assertions.length, 1);
  assert.equal(result.receipt.assertions[0].status, 'satisfied'); assert.equal(f.value, f.expected);
  assert.equal(f.mutations, mode === 'replaceSelection' ? 2 : 1);
  assert.equal(JSON.stringify(f.request), before); assert.ok(!JSON.stringify(result).includes(f.expected));
});

test('full value mismatch and selection insertion failure preserve effects and forbid replay', async () => {
  for (const [options, effect] of [[{ corrupt: true }, 'unknown'], [{ failInsert: true }, 'partial_verified']]) {
    const f = nativeFixture('replaceSelection', options);
    const result = await f.coordinator.invoke(invocation(f.request), session);
    assert.equal(result.receipt.effect, effect); assert.equal(result.receipt.replay, 'forbidden');
    assert.equal(result.receipt.execution, 'failed'); assert.ok(result.receipt.attempts.length >= 1);
    const count = f.mutations;
    await f.coordinator.invoke(invocation(f.request), session); assert.equal(f.mutations, count);
  }
});

test('expectation callback rejects mismatch, duplicates, omission, and receipt-only digest before any edit effect', async () => {
  for (const fault of ['ref', 'target', 'revision', 'mode', 'extra', 'duplicate', 'omitted']) {
    const f = fixture(), req = action(); req.operation.edit.mode = 'append'; req.expect = [];
    let effects = 0;
    f.adapter.perform = async (_op, ctx) => {
      const value = { refId: req.operation.ref.id, target, revision, editMode: 'append', expectedPrivateDigest: 'trusted-fixture-digest' };
      if (fault === 'ref') value.refId = 'other-field';
      if (fault === 'target') value.target = { ...target, targetId: 'other-window' };
      if (fault === 'revision') value.revision = { ...revision, semanticRevision: 2 };
      if (fault === 'mode') value.editMode = 'insert';
      if (fault === 'extra') value.text = 'private';
      if (fault !== 'omitted') await ctx.onTextExpectation(value);
      if (fault === 'duplicate') await ctx.onTextExpectation(value);
      await ctx.dispatch.beforeEffect({ primitive: 'atspi.InsertText', substep: 'editText', target }); effects++;
      return { target, before: revision, dispatch: 'acknowledged', effect: 'verified', attempts: [], evidence: [], timings: ctx.progress.timings(), expectedPrivateDigest: 'receipt-only-digest' };
    };
    const result = await f.coordinator.invoke(invocation(req), session);
    assert.equal(result.receipt.failure.code, 'adapter_contract_violation', fault); assert.equal(effects, 0, fault);
    assert.equal(result.receipt.effect, 'none_proven', fault); assert.equal(result.receipt.dispatch, 'not_started', fault);
    assert.ok(!f.journal.order.includes('durable-intent'), fault);
  }
});

test('expectation callback remains sealed during readback and after invocation', async () => {
  const f = nativeFixture('append'), perform = f.adapter.perform, probe = f.adapter.probe; let callback;
  f.adapter.perform = (op, ctx) => { callback = ctx.onTextExpectation; return perform(op, ctx); };
  f.adapter.probe = (predicates, selectedTarget, ctx) => {
    assert.throws(() => ctx.onTextExpectation({ refId: f.request.operation.ref.id, target: f.request.target, revision, editMode: 'append', expectedPrivateDigest: 'readback' }), { code: 'adapter_contract_violation' });
    return probe(predicates, selectedTarget, ctx);
  };
  const result = await f.coordinator.invoke(invocation(f.request), session);
  assert.equal(result.receipt.effect, 'verified');
  assert.throws(() => callback({ refId: f.request.operation.ref.id, target: f.request.target, revision, editMode: 'append', expectedPrivateDigest: 'late' }), { code: 'adapter_contract_violation' });
});
