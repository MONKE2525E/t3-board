'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { BrowserController, CdpBroker } = require('../../src/computer/browser/index.cjs');
const { declarations } = require('../../src/computer/browser/dom.cjs');
const { scalarText, privateDigest, cdpFailure, safeFailure, BrowserFailure } = require('../../src/computer/browser/support.cjs');
const { resolveEndpoint } = require('../../src/computer/browser/transport.cjs');
const { validateActionRequest, canonicalJson } = require('../../src/computer/contracts.cjs');
const { context, policy } = require('./helpers.cjs');
class FakeTransport {
  constructor() { this.calls = []; this.listeners = new Set(); }
  async connect() {}
  close() {}
  subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  async send(method, params, sessionId) {
    this.calls.push({ method, params, sessionId });
    if (method === 'Browser.getVersion') return { product: 'Chrome/153.0.0' };
    if (method === 'Target.getTargets') return { targetInfos: [{ targetId: 'tab-a', type: 'page', title: 'identical', url: 'https://example.test/' }, { targetId: 'tab-b', type: 'page', title: 'identical', url: 'https://example.test/' }] };
    if (method === 'Target.attachToTarget') return { sessionId: 'selected-session' };
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'frame-a', loaderId: 'document-a', url: 'https://example.test/' } } };
    if (method === 'Page.createIsolatedWorld') return { executionContextId: 5 };
    return { result: { value: true } };
  }
}
test('protocol lifecycle codes distinguish stale state without publishing raw diagnostics', () => {
  for (const [message, expected] of [['Session with given id not found.', 'cdp_session_gone'], ['No frame for given id found', 'cdp_frame_gone'], ['Cannot find context with specified id', 'cdp_context_gone'], ['Could not find object with given id', 'cdp_object_gone']]) {
    const failure = cdpFailure({ code: -32000, message });
    assert.equal(failure.code, expected); assert.equal(safeFailure(failure).kind, 'stale_target');
    assert(!JSON.stringify(safeFailure(failure)).includes(message));
  }
  const unknown = cdpFailure({ code: -32000, message: 'Private raw diagnostic with account text' });
  assert.equal(unknown.code, 'cdp_rejected'); assert(!JSON.stringify(safeFailure(unknown)).includes('account text'));
});
test('selected-session loss is terminal and never retries navigation', async () => {
  const transport = new FakeTransport();
  const controller = new BrowserController({ transport, policy: { ...policy, allowNavigation: async () => true } });
  const ctx = context(); await controller.connect({ mode: 'owned', endpoint: 'ws://127.0.0.1:5555/devtools/browser/fixture' }, ctx);
  const [choice] = await controller.listForLocalPicker(ctx); const lease = await controller.attach(choice.selectionToken, ctx);
  const send = transport.send.bind(transport); let navigations = 0;
  transport.send = async (method, ...args) => {
    if (method === 'Page.navigate') { navigations++; return { loaderId: 'new-document' }; }
    if (navigations && method === 'Page.getFrameTree') throw new BrowserFailure('cdp_session_gone', 'protocol');
    return send(method, ...args);
  };
  const action = context({ actionId: 'lost-selected-session' });
  const receipt = await controller.perform({ kind: 'navigate', target: lease.target, url: 'https://example.test/next' }, action);
  assert.equal(receipt.dispatch, 'acknowledged'); assert.equal(receipt.effect, 'unknown');
  assert.equal(receipt.failure.code, 'cdp_session_gone'); assert.equal(receipt.failure.kind, 'stale_target');
  assert.equal(navigations, 1); assert.equal(action.records.length, 1); assert.equal(controller.active.poisoned, true);
});
test('attach budget bounds setup, explicit lease duration survives completed setup', async () => {
  let mono = 100; let allowed = true;
  const transport = new FakeTransport();
  const controller = new BrowserController({ transport, now: () => mono, leaseMs: 180000, policy: { authorize: async () => allowed } });
  const setup = context(); setup.budget.deadlineMonoMs = 110;
  const connected = await controller.connect({ mode: 'chrome_consent', endpoint: 'ws://127.0.0.1:5555/devtools/browser/fixture' }, setup);
  assert.equal(connected.state, 'connected');
  const picker = await controller.listForLocalPicker(setup);
  const lease = await controller.attach(picker[1].selectionToken, setup);
  assert.equal(lease.target.targetId, 'tab-b'); assert.equal(lease.target.ownership, 'borrowed');
  assert.equal(lease.expiresMonoMs, 180100);
  mono = 1000; const action = context(); action.budget.deadlineMonoMs = 2000;
  await controller.guard(action, true);
  allowed = false; await assert.rejects(controller.guard(action, true), { code: 'permission_denied' });
  allowed = true; action.revision.grantGeneration++; await assert.rejects(controller.guard(action), { code: 'grant_generation_mismatch' });
  action.revision.grantGeneration--; mono = 180100; action.budget.deadlineMonoMs = mono + 1000;
  await assert.rejects(controller.guard(action), { code: 'lease_expired' });
  assert(!transport.calls.some(c => /closeTarget|activateTarget|createTarget|Browser.close/.test(c.method)));
});
test('selection tokens are opaque and session/connection scoped', async () => {
  const controller = new BrowserController({ transport: new FakeTransport(), policy }); const ctx = context();
  await controller.connect({ mode: 'owned', endpoint: 'ws://127.0.0.1:5555/devtools/browser/fixture' }, ctx);
  const picker = await controller.listForLocalPicker(ctx);
  await assert.rejects(controller.attach({ ...picker[0].selectionToken }, ctx), { code: 'invalid_selection_token' });
  await assert.rejects(controller.attach(picker[0].selectionToken, context({ sessionId: 'another' })), { code: 'invalid_selection_token' });
});
test('broker denies root mutation, arbitrary evaluation, foreign context/node and autoattach widening', async () => {
  const transport = new FakeTransport(); const broker = new CdpBroker({ transport }); const ctx = context();
  const root = broker.issueRoot('picker');
  for (const method of ['Browser.close', 'Target.createTarget', 'Target.activateTarget', 'Storage.getCookies', 'Network.getResponseBody']) await assert.rejects(broker.send(root, method, {}, ctx), { code: 'root_method_denied' });
  const cap = broker.issueSession({ sessionId: 'selected-session', target: {}, guard: async () => {} }); broker.registerFrame(cap, 'frame-a');
  await assert.rejects(broker.send(cap, 'Runtime.evaluate', { expression: '42' }, ctx), { code: 'cdp_method_denied' });
  await assert.rejects(broker.send(cap, 'Runtime.callFunctionOn', { functionDeclaration: declarations.summary, executionContextId: 99 }, ctx), { code: 'context_scope_denied' });
  await assert.rejects(broker.send(cap, 'DOM.resolveNode', { backendNodeId: 999 }, ctx), { code: 'node_scope_denied' });
  await assert.rejects(broker.send(cap, 'Target.setAutoAttach', { autoAttach: true, flatten: true, waitForDebuggerOnStart: true }, ctx), { code: 'autoattach_scope_denied' });
  await assert.rejects(broker.send(cap, 'Page.createIsolatedWorld', { frameId: 'foreign', worldName: 'muse-dom' }, ctx), { code: 'frame_scope_denied' });
  assert.equal(transport.calls.length, 0);
});
test('evidence marks every crossed fence unknown; per-frame counters do not hide changes', () => {
  const controller = new BrowserController({ policy }); const ctx = context(); controller.active = { lease: { target: { targetId: 'tab' }, grantGeneration: 1 } };
  const first = {}; const second = {}; controller.sampleRevision(first, { semantic: 10, geometry: 2 }); controller.sampleRevision(second, { semantic: 2, geometry: 1 });
  const before = controller.revision(ctx);
  controller.sampleRevision(second, { semantic: 3, geometry: 1 });
  const evidence = controller.evidence('dom', ctx, 0, [], {}, 'ok', before);
  assert.equal(evidence.freshness, 'unknown'); assert(evidence.reasons.includes('crossed_semanticRevision'));
  const beforeGeometry = controller.revision(ctx); controller.sampleRevision(first, { semantic: 10, geometry: 3 });
  assert(controller.evidence('pixels', ctx, 0, [], {}, 'ok', beforeGeometry).reasons.includes('crossed_geometryRevision'));
});
test('validated targets and replay fingerprints ignore object property order', async () => {
  const controller = new BrowserController({ transport: new FakeTransport(), policy }); const ctx = context();
  await controller.connect({ mode: 'owned', endpoint: 'ws://127.0.0.1:5555/devtools/browser/fixture' }, ctx);
  const [choice] = await controller.listForLocalPicker(ctx); const lease = await controller.attach(choice.selectionToken, ctx);
  const request = validateActionRequest(JSON.parse(canonicalJson({ schema: 'muse.action.v1', actionId: ctx.actionId, runId: ctx.runId, invokeId: ctx.invokeId, target: lease.target, expectedRevision: controller.revision(ctx), operation: { kind: 'query', target: lease.target, query: { scope: 'visible', exact: true, limit: 1 } }, require: [], expect: [], requirementIds: [] })), 'borrowed_browser');
  assert.deepEqual(controller.target(request.target), lease.target);
  assert.equal((await controller.preflight(request.operation, ctx)).eligible, true);
  const reorder = obj => Object.fromEntries(Object.entries(obj).reverse());
  controller.lease(reorder(lease)); controller.target(reorder(lease.target));
  let calls = 0; controller.executeOperation = async () => { calls++; return { synthetic: true }; };
  const first = await controller.perform(request.operation, ctx);
  assert.deepEqual(await controller.perform({ query: reorder(request.operation.query), target: reorder(lease.target), kind: 'query' }, ctx), first);
  assert.equal(calls, 1);
  await assert.rejects(controller.perform({ ...request.operation, query: { ...request.operation.query, limit: 2 } }, ctx), { code: 'action_id_collision' });
  const other = new BrowserController({ policy });
  assert.equal(controller.privateDigest('text'), privateDigest(controller.digestKey, 'text'));
  assert.notEqual(controller.privateDigest('text'), other.privateDigest('text'));
  assert.notEqual(controller.urlDigest('https://example.test/?a=1#one'), controller.urlDigest('https://example.test/?a=2#one'));
});
test('text caps count Unicode scalars and reject malformed Unicode before effects', () => {
  assert.equal(scalarText('🙂'.repeat(4096)).length, 8192);
  for (const text of ['\uD800', '\uDC00', 'a\0b']) assert.throws(() => scalarText(text), { code: 'invalid_unicode' });
  assert.throws(() => scalarText('🙂'.repeat(4097)), { code: 'text_limit' });
  const key = Buffer.alloc(32, 1); assert.notEqual(privateDigest(key, 'e\u0301'), privateDigest(key, 'é'));
});
test('full readback ceiling counts UTF-8 bytes as well as UTF-16 units', () => {
  const read = new Function(`return (${declarations.textRead})`)();
  const node = { isConnected: true, localName: 'textarea', value: '🙂🙂', selectionStart: 0, selectionEnd: 0 };
  assert.equal(read.call(node, 8).text, node.value);
  node.value += 'a'; const bounded = read.call(node, 8);
  assert.equal(bounded.unavailable, 'verification_limit'); assert.equal(bounded.totalUtf8Bytes, 9); assert.equal(bounded.text, undefined);
});
test('endpoint discovery is explicit, loopback-only, no remote redirects or profile scanning', async () => {
  const ctx = context();
  for (const endpoint of ['ws://remote.test:9222/devtools/browser/id', 'ws://user:pass@127.0.0.1:9222/devtools/browser/id', 'http://127.0.0.1:9222/private']) await assert.rejects(resolveEndpoint({ endpoint }, ctx));
  await assert.rejects(resolveEndpoint({}, ctx), { code: 'attachment_required' });
  const endpoint = await resolveEndpoint({ endpoint: 'http://127.0.0.1:9222' }, ctx, { fetch: async (_url, req) => { assert.equal(req.redirect, 'error'); return { ok: true, text: async () => JSON.stringify({ webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/id' }) }; } });
  assert.equal(endpoint, 'ws://127.0.0.1:9222/devtools/browser/id');
});
module.exports = { FakeTransport };
