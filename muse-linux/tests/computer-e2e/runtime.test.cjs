'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { ComputerRuntime } = require('../../src/computer/index.cjs');
const { BrowserController } = require('../../src/computer/browser/index.cjs');
const { startFixture } = require('../computer-browser/fixture.cjs');

test('composed runtime verifies direct Unicode edit and durable delivery without host input', { skip: process.env.MUSE_COMPUTER_E2E !== '1', timeout: 90000 }, async () => {
  const fixture = await startFixture();
  const directory = await fs.mkdtemp(path.join(fixture.directory, 'runtime-'));
  const runtime = new ComputerRuntime({ deviceId: 'runtime-fixture', directory, nativeDirectory: path.resolve('native/bin'),
    policy: () => ({ browserPolicy: 'allow', desktopPolicy: 'deny' }), permission: async () => true,
    desktop: { paused: false }, fixtureOrigins: [fixture.origin, fixture.crossOrigin] });
  try {
    runtime.connectionSessionId = 'runtime-session'; runtime.connectionGeneration = 1; runtime.epoch = 1;
    runtime.connected = new BrowserController({ policy: runtime.browserPolicy(), fixtureOrigins: runtime.fixtureOrigins });
    const ctx = runtime.context(); ctx.sessionId = runtime.connectionSessionId;
    const connection = await runtime.connected.connect({ mode: 'chrome_consent', endpoint: fixture.endpoint }, ctx);
    assert.equal(connection.state, 'connected');
    const [choice] = await runtime.connected.listForLocalPicker(ctx);
    runtime.connectedLease = await runtime.connected.attach(choice.selectionToken, ctx);
    const started = await runtime.start({ scope: 'connected_browser', task: 'Synthetic runtime benchmark', __deadline: Date.now() + 30000 });
    assert.equal(started.host_input, false);
    let observation = await runtime.observe();
    const paragraph = observation.controls.find(c => c.label === 'Paragraph'); assert(paragraph);
    const text = 'Direct Unicode editing: 漢字🙂 e\u0301\n' + 'A substantial paragraph with independent readback. '.repeat(45);
    const params = { action: 'type', ref_id: paragraph.ref_id, text, replace_all: 'true', observation_id: observation.observation_id };
    const request = { command: 'computer.control', params, invokeId: 'runtime-edit', deadline: Date.now() + 15000 };
    const start = performance.now(); const result = await runtime.control(request, params); const elapsed = performance.now() - start;
    assert.equal(result.receipt.effect, 'verified', JSON.stringify(result));
    assert.equal(JSON.parse(await fixture.state()).paragraph, text);
    const beforeEvents = JSON.parse(await fixture.state()).events.length;
    const replay = await runtime.control(request, params);
    assert.equal(replay.duplicate_delivery, true);
    const duplicateInputCount = JSON.parse(await fixture.state()).events.length - beforeEvents;
    assert.equal(duplicateInputCount, 0);
    const trace = await runtime.trace({}); assert(trace);
    observation = await runtime.observe(); assert(observation.controls.some(c => c.label === 'Paragraph'));
    const append = { action: 'type', element_label: 'Paragraph', edit_mode: 'append', text: '🧪'.repeat(1800), observation_id: observation.observation_id };
    const appended = await runtime.control({ command: 'computer.control', params: append, invokeId: 'runtime-append', deadline: Date.now() + 15000 }, append);
    assert.equal(appended.receipt.effect, 'verified', JSON.stringify(appended));
    assert.equal(JSON.parse(await fixture.state()).paragraph, text + append.text);
    const batchParams = { actions: JSON.stringify([{ action: 'type', element_label: 'Controlled', replace_all: 'true', text: 'A direct compound action' }, { action: 'click', element_label: 'Save synthetic' }]) };
    const batch = await runtime.batch({ command: 'computer.batch', params: batchParams, invokeId: 'runtime-batch', deadline: Date.now() + 15000 }, batchParams);
    assert.equal(batch.completed, 2, JSON.stringify(batch)); assert.equal(batch.outcomes[0].receipt.effect, 'verified');
    assert.equal(JSON.parse(await fixture.state()).controlled, 'A direct compound action'); assert.equal(JSON.parse(await fixture.state()).saved, 1);
    const batchReplay = await runtime.batch({ command: 'computer.batch', params: batchParams, invokeId: 'runtime-batch', deadline: Date.now() + 15000 }, batchParams);
    assert.equal(batchReplay.duplicate_delivery, true); assert.equal(JSON.parse(await fixture.state()).saved, 1);
    const destination = { action: 'navigate', url: fixture.origin + '/destination', expected_heading: 'Synthetic Orders' };
    const navigation = await runtime.control({ command: 'computer.control', params: destination, invokeId: 'runtime-navigation', deadline: Date.now() + 15000 }, destination);
    assert.equal(navigation.receipt.effect, 'verified', JSON.stringify(navigation));
    assert(navigation.observation.headings.includes('Synthetic Orders'));
    assert(Buffer.byteLength(JSON.stringify(navigation.observation)) <= 12288);
    await fs.writeFile(path.join(directory, 'benchmark.json'), JSON.stringify({ textScalars: [...text].length, textUtf8Bytes: Buffer.byteLength(text), elapsedMs: elapsed,
      dispatch: result.receipt.dispatch, effect: result.receipt.effect, attempts: result.receipt.attempts.length, screenshotCount: 0, modelRoundTrips: null,
      metricProvenance: 'scripted_no_model', duplicateInputCount }, null, 2), { mode: 0o600 });
    console.log(`Composed runtime artifacts: ${directory}`);
  } finally { await runtime.close(); await fixture.close(); }
});
