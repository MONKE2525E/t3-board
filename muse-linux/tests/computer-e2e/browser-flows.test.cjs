'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { ComputerRuntime } = require('../../src/computer/index.cjs');
const { BrowserController, WebSocketTransport } = require('../../src/computer/browser/index.cjs');
const { startFixture } = require('../computer-browser/fixture.cjs');

class MeasuredTransport extends WebSocketTransport {
  constructor() { super(); this.calls = []; }
  send(method, params, sessionId, ctx) {
    this.calls.push({ method, at: performance.now(), inputType: params.type });
    return super.send(method, params, sessionId, ctx);
  }
}
async function setup(name, options = {}) {
  const fixture = await startFixture();
  const directory = await fs.mkdtemp(path.join(fixture.directory, `${name}-`));
  const transport = new MeasuredTransport();
  const injected = typeof options === 'function' ? await options({ fixture, directory }) : options;
  const runtime = new ComputerRuntime({ deviceId: `flows-${name}`, directory, nativeDirectory: path.resolve('native/bin'),
    policy: () => ({ browserPolicy: 'allow', desktopPolicy: 'deny' }), permission: async () => true,
    desktop: { paused: false }, fixtureOrigins: [fixture.origin, fixture.crossOrigin], ...injected });
  const actions = [];
  try {
    runtime.connectionSessionId = `flows-${name}-session`; runtime.connectionGeneration = 1; runtime.epoch = 1;
    runtime.connected = new BrowserController({ transport, policy: runtime.browserPolicy(), fixtureOrigins: runtime.fixtureOrigins });
    const ctx = runtime.context(); ctx.sessionId = runtime.connectionSessionId;
    assert.equal((await runtime.connected.connect({ mode: 'chrome_consent', endpoint: fixture.endpoint }, ctx)).state, 'connected');
    const [choice] = await runtime.connected.listForLocalPicker(ctx);
    runtime.connectedLease = await runtime.connected.attach(choice.selectionToken, ctx);
    assert.equal((await runtime.start({ scope: 'connected_browser', task: 'Synthetic browser flow verification', __deadline: Date.now() + 30000 })).host_input, false);
    let sequence = 0;
    async function call(kind, params, invokeId = `${name}-${++sequence}`) {
      const start = performance.now();
      const requestedAction = params.action || (kind === 'action' ? JSON.parse(params.request).operation.kind : 'batch');
      try {
        const result = await runtime[kind]({ command: `computer.${kind}`, params, invokeId, deadline: Date.now() + 10000 }, params);
        actions.push({ kind, invokeId, requestedAction, latencyMs: performance.now() - start,
          dispatch: result.receipt?.dispatch, effect: result.receipt?.effect, failure: result.receipt?.failure || result.error, duplicateDelivery: result.duplicate_delivery || false });
        return result;
      } catch (error) { actions.push({ kind, invokeId, requestedAction, latencyMs: performance.now() - start, error: error.code || error.message }); throw error; }
    }
    async function observe(query) { return runtime.observe(query ? { query: JSON.stringify(query) } : {}); }
    async function control(action, label, extra = {}, invokeId) {
      const observation = await observe();
      const matches = observation.controls.filter(c => c.label === label); assert.equal(matches.length, 1, `Expected one ${label}`);
      return call('control', { action, ref_id: matches[0].ref_id, observation_id: observation.observation_id, ...extra }, invokeId);
    }
    async function action(operation, invokeId) { return call('action', { request: JSON.stringify({ operation }) }, invokeId); }
    return { fixture, runtime, transport, actions, directory, call, observe, control, action, async close() {
      const summary = { actions, actionCount: actions.length, totalActionLatencyMs: actions.reduce((sum, a) => sum + a.latencyMs, 0),
        primitiveCounts: Object.fromEntries([...new Set(transport.calls.map(c => c.method))].map(method => [method, transport.calls.filter(c => c.method === method).length])),
        keyboardEventCount: transport.calls.filter(c => c.method === 'Input.dispatchKeyEvent').length,
        screenshotCount: transport.calls.filter(c => c.method === 'Page.captureScreenshot').length,
        failureCount: actions.filter(a => a.failure || a.error).length, duplicateDeliveryCount: actions.filter(a => a.duplicateDelivery).length,
        modelRoundTrips: null, metricProvenance: 'scripted_no_model', authenticatedAccount: false,
        hostStateMeasurements: { focus: null, clipboard: null, workspace: null, cursor: null }, noHostGui: true };
      try {
        await fs.writeFile(path.join(directory, 'flows.json'), JSON.stringify(summary, null, 2), { mode: 0o600 });
        console.log(`Composed browser flow artifacts: ${directory}`);
      } finally { try { await runtime.close(); } finally { await fixture.close(); } }
    } };
  } catch (error) { try { await runtime.close(); } finally { await fixture.close(); } throw error; }
}
const real = { skip: process.env.MUSE_COMPUTER_E2E !== '1', timeout: 45000 };

test('composed browser opens synthetic Orders by menu without keyboard traversal', real, async () => {
  const harness = await setup('menu');
  try {
    await harness.fixture.evaluate(`window.fixture.menuClicks=0;window.fixture.orderClicks=0;
      const menu=document.createElement('div');menu.innerHTML='<button id="account-menu">Account menu</button><div id="order-menu" hidden><button id="orders-link">Your Orders</button></div>';document.body.prepend(menu);
      document.getElementById('account-menu').onclick=()=>{fixture.menuClicks++;document.getElementById('order-menu').hidden=false};
      document.getElementById('orders-link').onclick=()=>{fixture.orderClicks++;history.pushState({},'', '/orders');document.querySelector('h1').textContent='Your Orders';document.getElementById('saved').textContent='Synthetic package is in transit'};`);
    const opened = await harness.control('click', 'Account menu'); assert.equal(opened.receipt.dispatch, 'acknowledged');
    const orders = await harness.control('click', 'Your Orders'); assert.equal(orders.receipt.dispatch, 'acknowledged');
    assert.equal(await harness.fixture.evaluate('document.URL'), harness.fixture.origin + '/orders');
    assert.equal(await harness.fixture.evaluate("document.getElementById('saved').textContent"), 'Synthetic package is in transit');
    const state = JSON.parse(await harness.fixture.state()); assert.equal(state.menuClicks, 1); assert.equal(state.orderClicks, 1);
    const observed = await harness.observe(); assert(observed.headings.includes('Your Orders'));
    assert.equal(harness.transport.calls.filter(c => c.method === 'Input.dispatchKeyEvent').length, 0);
    assert.equal(harness.actions.length, 2);
  } finally { await harness.close(); }
});

test('composed browser uses select, checkbox, shadow controls and direct child-frame editing', real, async () => {
  const harness = await setup('controls');
  try {
    const observation = await harness.runtime.observe({ query: JSON.stringify({ scope: 'structural', exact: true, limit: 100 }) });
    const ref = label => { const controls = observation.controls.filter(c => c.label === label); assert.equal(controls.length, 1); return controls[0].ref_id; };
    const selected = await harness.action({ kind: 'select', ref: ref('Choice'), itemRefs: [ref('Beta')], mode: 'replace' });
    assert.equal(selected.receipt.dispatch, 'acknowledged', JSON.stringify(selected)); assert.equal(JSON.parse(await harness.fixture.state()).selected, 'b');
    const checked = await harness.control('set_checked', 'Enabled', { checked: 'true' }); assert.equal(checked.receipt.effect, 'verified'); assert.equal(JSON.parse(await harness.fixture.state()).checked, true);
    const shadow = await harness.control('type', 'Shadow entry', { text: 'Shadow 漢🙂', replace_all: 'true' }); assert.equal(shadow.receipt.effect, 'verified');
    assert.equal(await harness.fixture.evaluate("shadow.shadowRoot.querySelector('input').value"), 'Shadow 漢🙂');
    for (const label of ['Same frame editor', 'Cross frame editor', 'Nested frame editor']) {
      const edited = await harness.control('type', label, { text: `Direct ${label} 🙂`, replace_all: 'true' });
      assert.equal(edited.receipt.effect, 'verified', JSON.stringify(edited));
      if (label === 'Same frame editor') assert.equal(await harness.fixture.evaluate("document.querySelector('iframe').contentDocument.querySelector('input').value"), `Direct ${label} 🙂`);
      else {
        const url = label === 'Cross frame editor' ? harness.fixture.crossOrigin + '/frame' : harness.fixture.crossOrigin.replace('localhost', '127.0.0.1') + '/nested';
        const targets = (await harness.fixture.send('Target.getTargets')).targetInfos.filter(t => t.type === 'iframe' && t.url === url);
        assert.equal(targets.length, 1);
        const session = await harness.fixture.send('Target.attachToTarget', { targetId: targets[0].targetId, flatten: true });
        try { assert.equal((await harness.fixture.send('Runtime.evaluate', { expression: 'document.querySelector("input").value', returnByValue: true }, session.sessionId)).result.value, `Direct ${label} 🙂`); }
        finally { await harness.fixture.send('Target.detachFromTarget', { sessionId: session.sessionId }); }
      }
    }
    const scroll = await harness.control('scroll', 'Scroll pane', { scroll_direction: 'down', scroll_amount: '180' });
    assert.equal(scroll.receipt.dispatch, 'acknowledged'); assert.equal(await harness.fixture.evaluate("document.getElementById('scroll').scrollTop"), 180);
    assert.equal(harness.transport.calls.filter(c => c.method === 'Input.dispatchKeyEvent').length, 0);
  } finally { await harness.close(); }
});

for (const decision of ['accept', 'dismiss']) test(`composed browser resolves explicit ${decision} modal checkpoint without repeating click`, real, async () => {
  const harness = await setup(`dialog-${decision}`);
  try {
    const opened = await harness.control('click', 'Confirm synthetic', {}, `dialog-open-${decision}`);
    assert(opened.receipt.failure); assert.equal(opened.receipt.effect, 'unknown');
    const clickCount = harness.transport.calls.filter(c => c.method === 'Input.dispatchMouseEvent').length;
    const dialogId = harness.runtime.browser.dialog?.id; assert(dialogId);
    const resolved = await harness.call('control', { action: 'dialog', dialog_id: dialogId, decision }, `dialog-decision-${decision}`);
    assert.equal(resolved.receipt.dispatch, 'acknowledged', JSON.stringify(resolved));
    assert.equal(opened.receipt.failure.code, 'dialog_checkpoint');
    assert.equal(JSON.parse(await harness.fixture.state()).dialog, decision === 'accept');
    assert.equal(harness.transport.calls.filter(c => c.method === 'Input.dispatchMouseEvent' && c.inputType === 'mousePressed').length, 1);
    assert(harness.transport.calls.filter(c => c.method === 'Input.dispatchMouseEvent').length <= clickCount + 1);
    const replay = await harness.call('control', { action: 'dialog', dialog_id: dialogId, decision }, `dialog-decision-${decision}`);
    assert.equal(replay.duplicate_delivery, true);
  } finally { await harness.close(); }
});

test('composed browser uploads only an approved regular file and blocks uncertain same-intent replay', real, async () => {
  let approvedFile, distinctFile, approvedDirectory, symlink, resolverCalls = 0;
  const harness = await setup('upload', async ({ directory }) => {
    approvedDirectory = directory; approvedFile = path.join(directory, 'approved-synthetic.txt'); symlink = path.join(directory, 'linked-synthetic.txt');
    await fs.writeFile(approvedFile, 'Only synthetic approved data', { mode: 0o600 }); await fs.symlink(approvedFile, symlink);
    distinctFile = path.join(directory, 'distinct-synthetic.txt');
    await fs.writeFile(distinctFile, 'Different synthetic approved data', { mode: 0o600 });
    return { resolveFile: async requested => {
      resolverCalls++;
      if (!requested.startsWith(directory + path.sep) && requested !== directory) throw Object.assign(Error('file_access_denied'), { code: 'file_access_denied' });
      return { target: requested };
    } };
  });
  try {
    await harness.fixture.evaluate("window.fixture.uploadEvents=0;file.addEventListener('change',()=>fixture.uploadEvents++)");
    const operations = [], execute = harness.runtime.execute.bind(harness.runtime);
    harness.runtime.execute = (request, operation, options) => {
      if (operation.kind === 'upload') operations.push(structuredClone(operation));
      return execute(request, operation, options);
    };
    const uploaded = await harness.control('upload', 'Attachment', { paths: JSON.stringify([approvedFile]) });
    assert.equal(uploaded.receipt.dispatch, 'acknowledged', JSON.stringify(uploaded));
    assert.equal(uploaded.receipt.effect, 'unknown', 'Selecting a local file does not prove a server upload');
    assert.equal(JSON.parse(await harness.fixture.state()).uploads, 1);
    assert.equal(await harness.fixture.evaluate("file.files[0].name"), 'approved-synthetic.txt');
    assert(resolverCalls >= 2, 'Grant must be rechecked at dispatch');
    const uploadCount = () => harness.transport.calls.filter(c => c.method === 'DOM.setFileInputFiles').length;
    assert.equal(uploadCount(), 1);
    const distinct = await harness.control('upload', 'Attachment', { paths: JSON.stringify([distinctFile]) });
    assert.equal(distinct.receipt.dispatch, 'acknowledged', JSON.stringify(distinct));
    assert.equal(distinct.receipt.effect, 'unknown');
    assert.equal(await harness.fixture.evaluate("file.files[0].name"), 'distinct-synthetic.txt');
    assert.equal(JSON.parse(await harness.fixture.state()).uploadEvents, 2);
    assert.notDeepEqual(operations[0].fileCapabilityIds, operations[1].fileCapabilityIds);
    assert.equal(uploadCount(), 2);
    for (const file of [approvedDirectory, symlink, '/etc/passwd']) {
      await assert.rejects(harness.control('upload', 'Attachment', { paths: JSON.stringify([file]) }));
      assert.equal(uploadCount(), 2); assert.equal(JSON.parse(await harness.fixture.state()).uploadEvents, 2);
    }
    const denied = await harness.control('upload', 'Attachment', { paths: JSON.stringify([approvedFile]) });
    assert.equal(denied.receipt.dispatch, 'not_started', JSON.stringify(denied)); assert.equal(denied.receipt.failure.code, 'diagnosis_required');
    assert.notEqual(operations[0].ref.id, operations[2].ref.id, 'A fresh observation must not bypass unresolved upload replay protection');
    assert.equal(operations[0].ref.browser.backendNodeId, operations[2].ref.browser.backendNodeId);
    assert.deepEqual(operations[0].fileCapabilityIds, operations[2].fileCapabilityIds);
    assert.equal(uploadCount(), 2); assert.equal(JSON.parse(await harness.fixture.state()).uploadEvents, 2);
    assert.equal(await harness.fixture.evaluate("file.files[0].name"), 'distinct-synthetic.txt');
    assert.equal(harness.runtime.uploadGrants.size, 0);
  } finally { await harness.close(); }
});

test('composed browser rechecks revoked file permission before its first upload dispatch', real, async () => {
  let file, calls = 0;
  const harness = await setup('revocation', async ({ directory }) => {
    file = path.join(directory, 'revoked-synthetic.txt'); await fs.writeFile(file, 'Synthetic revoked data', { mode: 0o600 });
    return { resolveFile: async requested => {
      calls++;
      if (requested !== file || calls > 1) throw Object.assign(Error('file_access_denied'), { code: 'file_access_denied' });
      return { target: requested };
    } };
  });
  try {
    const denied = await harness.control('upload', 'Attachment', { paths: JSON.stringify([file]) });
    assert.equal(denied.receipt.dispatch, 'not_started', JSON.stringify(denied)); assert.equal(denied.receipt.effect, 'none_proven');
    assert.equal(calls, 2); assert.equal(harness.transport.calls.filter(c => c.method === 'DOM.setFileInputFiles').length, 0);
    assert.equal(JSON.parse(await harness.fixture.state()).uploads, 0); assert.equal(harness.runtime.uploadGrants.size, 0);
  } finally { await harness.close(); }
});

test('composed browser preserves failed batch prefix and skips suffix without input replay', real, async () => {
  const harness = await setup('recovery');
  try {
    await harness.observe();
    const params = { actions: JSON.stringify([{ action: 'type', element_label: 'Controlled', replace_all: 'true', text: 'Exactly once' },
      { action: 'type', element_label: 'Disabled', replace_all: 'true', text: 'Must not happen' }, { action: 'click', element_label: 'Save synthetic' }]) };
    const result = await harness.call('batch', params, 'partial-batch');
    assert.equal(result.outcomes.length, 3); assert.equal(result.outcomes[0].receipt.effect, 'verified');
    assert.equal(result.outcomes[1].receipt.dispatch, 'not_started'); assert.equal(result.outcomes[2].execution, 'skipped');
    const state = JSON.parse(await harness.fixture.state()); assert.equal(state.controlled, 'Exactly once'); assert.equal(state.saved, 0);
    const inputCount = harness.transport.calls.filter(c => c.method.startsWith('Input.')).length;
    const replay = await harness.call('batch', params, 'partial-batch'); assert.equal(replay.duplicate_delivery, true);
    assert.equal(harness.transport.calls.filter(c => c.method.startsWith('Input.')).length, inputCount);
    const saved = await harness.control('click', 'Save synthetic'); assert.equal(saved.receipt.dispatch, 'acknowledged');
    assert.equal(JSON.parse(await harness.fixture.state()).saved, 1);
  } finally { await harness.close(); }
});
