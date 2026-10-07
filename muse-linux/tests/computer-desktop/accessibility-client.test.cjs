'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { AccessibilityClient, DesktopController, InputClient, WindowingClient } = require('../../src/computer/desktop/index.cjs');
const { DesktopError } = require('../../src/computer/desktop/common.cjs');
const { context, target, session } = require('./helpers.cjs');

// Stateful protocol fixture. Production full text and identity are exercised by live.test.cjs.
function fixture({ text = 'original', reject, readPage, policy } = {}) {
  const native = { handle: 'private-handle-1', rootHandle: 'private-root', busUniqueName: ':1.2', objectPath: '/fixture/entry',
    ownerStartToken: target.process.startToken, roleCode: 79, role: 'entry', name: 'Field', capabilities: ['readText', 'editText', 'invoke'],
    states: ['editable', 'enabled', 'sensitive', 'visible', 'showing', 'singleline'], actions: ['click'] };
  const calls = []; let serial = 1; let caret = 2; let selections = [[1, 3]];
  const channel = { generation: 1, async start() { return { ready: true }; }, subscribe() { return () => {}; }, async stop() { return { stopped: true }; },
    async request(op, params) {
      calls.push({ op, params: structuredClone(params) });
      if (reject) await reject(op, params, calls);
      if (op === 'observe') return { nodes: [{ ...native, handle: `private-handle-${++serial}` }], complete: true, truncated: false, rootConfidence: 'explicit_bus_object_process' };
      if (op === 'resolve') return { ...native };
      if (op === 'renew') return { ...native, handle: `private-handle-${++serial}` };
      if (op === 'readText') {
        const chars = [...text], end = Math.min(chars.length, params.offset + params.limitScalars);
        const page = { text: chars.slice(params.offset, end).join(''), totalScalars: chars.length, totalUtf8Bytes: Buffer.byteLength(text),
          start: params.offset, end, privateReadHash: createHash('sha256').update(text).digest('hex'), caret, selections };
        return readPage ? readPage(page, calls) : page;
      }
      if (['replace', 'insert', 'delete'].includes(op)) {
        assert.equal(params.beforeHash, createHash('sha256').update(text).digest('hex'));
        const chars = [...text];
        if (op === 'replace') text = params.text;
        else if (op === 'insert') text = chars.slice(0, params.position).join('') + params.text + chars.slice(params.position).join('');
        else text = chars.slice(0, params.position).join('') + chars.slice(params.end).join('');
        return { accepted: true, primitiveDispatches: 1 };
      }
      return { accepted: true, primitiveDispatches: 1 };
    } };
  const owned = session();
  const client = new AccessibilityClient({ channel, plainTextPolicy: policy,
    rootMapper: async () => ({ busUniqueName: native.busUniqueName, objectPath: '/fixture/root', pid: target.process.pid,
      startToken: target.process.startToken, confidence: 'exact' }), digestKey: Buffer.alloc(32, 7) });
  async function setup() { await client.start(owned, context()); return (await client.observe(target, { scope: 'structural' }, context())).nodes[0].ref; }
  return { client, channel, calls, native, owned, setup, get text() { return text; }, set text(value) { text = value; },
    set caret(value) { caret = value; }, set selections(value) { selections = value; } };
}
const edit = (mode, text) => ({ mode, text, semantics: 'plain_text', newlinePolicy: 'literal_multiline', clipboard: 'forbid' });

test('native refs reject forgery, changed revisions and restart before a provider request', async () => {
  const f = fixture(), ref = await f.setup(), count = f.calls.length;
  const forged = structuredClone(ref); forged.native.objectPath = '/another';
  await assert.rejects(f.client.resolve(forged, context()), { code: 'stale_ref' });
  const stale = context(); stale.revision.semanticRevision++;
  await assert.rejects(f.client.resolve(ref, stale), { code: 'stale_ref' });
  await f.client.start(f.owned, context()); await assert.rejects(f.client.resolve(ref, context()), { code: 'stale_ref' });
  assert.equal(f.calls.length, count);
});
test('canonical property order preserves issued refs while changed native bytes fail closed', async () => {
  const f = fixture(), ref = await f.setup();
  function canonical(value) { return Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ?
    Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value; }
  const validated = canonical(ref); assert.notEqual(JSON.stringify(validated), JSON.stringify(ref));
  assert.equal((await f.client.resolve(validated, context())).validated, true);
  const subtree = await f.client.observe(canonical(target), { scope: 'structural', rootRef: validated }, context());
  assert.equal(subtree.nodes.length, 1);
  validated.native.ownerStartToken = 'reused'; await assert.rejects(f.client.resolve(validated, context()), { code: 'stale_ref' });
});
test('subtree observation passes a retained private handle and rejects another target', async () => {
  const f = fixture(), ref = await f.setup();
  const observed = await f.client.observe(target, { scope: 'visible', rootRef: ref }, context());
  assert.equal(f.calls.at(-1).params.subtreeHandle, f.client.refs.get(ref.id).handle);
  assert.equal(observed.nodes[0].handle, undefined); assert.equal(observed.nodes[0].parentHandle, undefined);
  await assert.rejects(f.client.observe({ ...target, targetId: 'other' }, { scope: 'structural', rootRef: ref }, context()), { code: 'stale_ref' });
});
test('paged full read verifies all Unicode scalars and suppresses text in default verify receipt', async () => {
  const text = 'A'.repeat(17000) + '日本🌍e\u0301אבג', f = fixture({ text }), ref = await f.setup();
  const read = await f.client.readText(ref, { mode: 'verify', expectedPrivateDigest: f.client.digest(text) }, context());
  assert.equal(read.complete, true); assert.equal(read.truncated, false); assert.equal(read.exactMatch, true);
  assert.equal(read.totalScalars, [...text].length); assert.equal(read.totalUtf8Bytes, Buffer.byteLength(text)); assert.equal(read.text, undefined);
  assert.equal(JSON.stringify(read).includes(text), false);
  assert.deepEqual(f.calls.filter(c => c.op === 'readText').map(c => c.params.offset), [0, 16384]);
  const page = await f.client.readText(ref, { mode: 'page', offset: 17000, limitScalars: 3 }, context());
  assert.equal(page.text, '日本🌍'); assert.deepEqual(page.returnedRange, [17000, 17003]); assert.equal(page.truncated, true);
});
test('content changes across pages renew once and never dispatch input', async () => {
  let reads = 0; const f = fixture({ text: 'x'.repeat(17000), readPage: page => { reads++; return reads === 2 ? { ...page, privateReadHash: 'changed' } : page; } });
  const ref = await f.setup(), ctx = context(), read = await f.client.readText(ref, { mode: 'verify' }, ctx);
  assert.equal(read.complete, true); assert.equal(read.requestRefId, ref.id); assert.notEqual(read.renewedRef.id, ref.id);
  assert.equal(f.calls.filter(c => c.op === 'renew').length, 1); assert.equal(ctx.attempts.length, 0);
});
test('repeated changed read fails after one renewal; no digest or verification success escapes', async () => {
  const f = fixture({ text: 'x'.repeat(17000), readPage: page => page.start ? { ...page, end: page.start } : page });
  await assert.rejects(f.client.readText(await f.setup(), { mode: 'verify' }, context()), { code: 'read_changed' });
  assert.equal(f.calls.filter(c => c.op === 'renew').length, 1);
});
test('append inserts only new text at full scalar count and binds proof to original ref', async () => {
  const f = fixture({ text: 'a'.repeat(7998) + '🌍e\u0301' }), ref = await f.setup(), ctx = context();
  const result = await f.client.edit(ref, edit('append', '日本🌍'), ctx);
  assert.equal(result.effect, 'verified'); assert.equal([...f.text].length, 8004);
  const insert = f.calls.find(c => c.op === 'insert'); assert.equal(insert.params.position, 8001); assert.equal(insert.params.text, '日本🌍');
  assert.equal(f.calls.some(c => c.op === 'replace'), false); assert.equal(ctx.attempts.length, 1);
  assert.equal(result.readback.ref, ref.id); assert.equal(result.readback.requestRefId, ref.id); assert.equal(result.readback.text, undefined);
  assert.equal(result.readback.digestRef, f.client.digest(f.text)); assert.equal(result.readback.expectedPrivateDigest, f.client.digest(f.text));
  assert.notEqual(result.renewedRef.id, ref.id); assert.deepEqual(result.renewedRef.native, ref.native);
});
test('expected-before conflict, secret, rich, readonly and Unicode failures cross no effect boundary', async () => {
  const f = fixture(), ref = await f.setup();
  for (const request of [edit('replace', '\0'), edit('replace', '\ud800'), edit('replace', 'x'.repeat(4097)),
    { ...edit('replace', 'x'), expectedBefore: { privateDigest: 'wrong', scalarCount: 8 } }]) {
    const ctx = context(); await assert.rejects(f.client.edit(ref, request, ctx)); assert.equal(ctx.attempts.length, 0);
  }
  for (const mutate of [n => { n.role = 'password text'; n.roleCode = 40; }, n => { n.states = ['readOnly']; }, n => { n.role = 'text'; }]) {
    const g = fixture({ policy: () => false }), r = await g.setup(); mutate(g.native); const ctx = context();
    await assert.rejects(g.client.edit(r, edit('replace', 'x'), ctx)); assert.equal(ctx.attempts.length, 0);
  }
});
test('selection insertion failure keeps successful deletion and forbids replay', async () => {
  const f = fixture({ text: 'abcdef', reject: op => { if (op === 'insert') throw new DesktopError('deadline'); } });
  const ref = await f.setup(), ctx = context(), result = await f.client.edit(ref, edit('replaceSelection', '中'), ctx);
  assert.equal(f.text, 'adef'); assert.equal(result.execution, 'failed'); assert.equal(result.effect, 'partial_verified');
  assert.equal(result.replay, 'forbidden'); assert.equal(result.substeps.length, 1); assert.equal(ctx.attempts.length, 2);
  assert.equal(ctx.attempts[1].ack.state, 'lost'); assert.equal(f.calls.filter(c => c.op === 'insert').length, 1);
});
test('trusted expected final digest is bound before first effect, and callback rejection blocks input', async () => {
  const f = fixture({ text: 'abcdef' }), ref = await f.setup(), ctx = context(); let expectation;
  ctx.onTextExpectation = async value => { assert.equal(ctx.attempts.length, 0); assert.equal(f.text, 'abcdef'); expectation = value; };
  const result = await f.client.edit(ref, edit('replaceSelection', '中'), ctx);
  assert.deepEqual(expectation, { refId: ref.id, target, revision: ctx.revision, editMode: 'replaceSelection', expectedPrivateDigest: f.client.digest('a中def') });
  assert.equal(result.readback.digestRef, expectation.expectedPrivateDigest); assert.equal(result.effect, 'verified');
  const rejected = context(); rejected.onTextExpectation = async () => { throw new DesktopError('expectation_rejected'); };
  await assert.rejects(f.client.edit(ref, edit('append', 'x'), rejected), { code: 'expectation_rejected' });
  assert.equal(rejected.attempts.length, 0); assert.equal(f.text, 'a中def');
});
test('readback identity alias rejects another root before reading', async () => {
  const f = fixture(), ref = await f.setup(); const another = f.client.issue({ ...f.native, rootHandle: 'another-root' }, target, context(), 'another-set');
  await assert.rejects(f.client.readText(another, { mode: 'verify' }, context(), ref), { code: 'readback_identity_mismatch' });
  assert.equal(f.calls.some(c => c.op === 'readText'), false);
});
test('semantic provider false or timeout never falls back to pointer; slider never sends navigation keys', async () => {
  for (const code of ['semantic_rejected', 'deadline']) {
    const f = fixture({ reject: op => { if (op === 'invoke') throw new DesktopError(code, { attempted: true }); } });
    const ref = await f.setup(); let physical = 0;
    const controller = new DesktopController({ session: f.owned, accessibility: f.client, authorize: async () => {},
      input: { click: async () => { physical++; } }, pointerRefForElement: async () => { physical++; } });
    const ctx = context(); await assert.rejects(controller.perform({ kind: 'click', ref, button: 'left' }, ctx), { code });
    assert.equal(physical, 0); assert.equal(ctx.attempts.length, 1); assert.equal(ctx.attempts[0].ack.state, 'lost');
    await assert.rejects(controller.perform({ kind: 'scroll', ref, axis: 'y', delta: 20 }, context()), { code: 'semantic_incremental_scroll_unavailable' });
    assert.equal(physical, 0);
  }
});
test('semantic query applies exact/state/ancestor scope and incomplete absence stays unknown', async () => {
  const f = fixture(), ref = await f.setup();
  const controller = new DesktopController({ session: f.owned, accessibility: f.client, authorize: async () => {} });
  const query = { role: 'entry', name: 'Field', states: { editable: true }, exact: true, limit: 2, scope: 'structural', rootRefId: ref.id };
  const result = await controller.perform({ kind: 'query', target, query }, context());
  assert.equal(result.matches.length, 1); assert.equal(result.complete, true); assert.equal(result.attempted, false);
  assert.equal(f.calls.at(-1).params.subtreeHandle, f.client.refs.get(ref.id).handle);
  const originalObserve = f.client.observe.bind(f.client); f.client.observe = async (...args) => {
    const observed = await originalObserve(...args); return { ...observed, coverage: { complete: false, truncated: true } };
  };
  const missing = await controller.perform({ kind: 'query', target, query: { ...query, name: 'missing' } }, context());
  assert.equal(missing.matches.length, 0); assert.equal(missing.absence, 'unknown');
  for (const invalid of [{ ...query, states: { invented: true } }, { ...query, name: 5 }, { ...query, limit: 0 }])
    await assert.rejects(controller.perform({ kind: 'query', target, query: invalid }, context()), { code: 'unsupported_query' });
});
test('physical and window drivers refuse stale identity, occlusion and unproven delivery before input', async () => {
  let calls = 0; const owned = session(), ctx = context();
  const ref = { target, revision: { ...ctx.revision }, point: [0.5, 0.5], space: 'window_normalized', captureId: 'capture', transformId: 'transform' };
  const input = new InputClient({ session: owned, authorize: async () => {}, driver: { click: () => { calls++; }, key: () => { calls++; } },
    verifyCoordinate: async () => ({ target, captureId: ref.captureId, transformId: ref.transformId, occluded: true, hit: true, geometryCurrent: true, transformVerified: true, point: [20, 20] }),
    verifyKeyTarget: async () => ({ target, deliveryVerified: true, xwaylandToXwayland: true }) });
  await assert.rejects(input.click(ref, 'left', ctx), { code: 'physical_target_unavailable' });
  await assert.rejects(input.key(target, 'CTRL+a', ctx), { code: 'key_target_unavailable' });
  const windowing = new WindowingClient({ session: owned, authorize: async () => {}, driver: {
    inspect: async () => ({ ...target, process: { ...target.process, startToken: 'PID-reused' } }), close: () => { calls++; } } });
  await assert.rejects(windowing.close(target, ctx), { code: 'stale_target' });
  assert.equal(calls, 0); assert.equal(ctx.attempts.length, 0);
});
