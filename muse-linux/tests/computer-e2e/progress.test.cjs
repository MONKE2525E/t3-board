'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { ComputerRuntime } = require('../../src/computer/index.cjs');
const { BrowserController, WebSocketTransport } = require('../../src/computer/browser/index.cjs');
const { startFixture } = require('../computer-browser/fixture.cjs');

test('four distinct DOM-changing clicks retain unknown effects while independent progress permits the next action',
  { skip: process.env.MUSE_COMPUTER_E2E !== '1', timeout: 90000 }, async () => {
    const fixture = await startFixture();
    const directory = await fs.mkdtemp(path.join(fixture.directory, 'progress-'));
    const runtime = new ComputerRuntime({ deviceId: 'progress-fixture', directory, nativeDirectory: path.resolve('native/bin'),
      policy: () => ({ browserPolicy: 'allow', desktopPolicy: 'deny' }), permission: async () => true,
      desktop: { paused: false }, fixtureOrigins: [fixture.origin, fixture.crossOrigin] });
    const calls = [];
    const transport = new WebSocketTransport();
    const send = transport.send.bind(transport);
    transport.send = (method, ...args) => { calls.push(method); return send(method, ...args); };
    try {
      await fixture.evaluate(`(() => {
        fixture.progress = [];
        const heading = document.createElement('h2'); heading.textContent = 'Progress initial';
        document.body.prepend(heading);
        for (let i = 4; i >= 1; i--) {
          const button = document.createElement('button'); button.textContent = 'Progress action ' + i;
          button.onclick = () => { fixture.progress.push(i); heading.textContent = 'Progress step ' + i; };
          document.body.prepend(button);
        }
      })()`);
      runtime.connectionSessionId = 'progress-session'; runtime.connectionGeneration = 1; runtime.epoch = 1;
      runtime.connected = new BrowserController({ transport, policy: runtime.browserPolicy(), fixtureOrigins: runtime.fixtureOrigins });
      const ctx = runtime.context(); ctx.sessionId = runtime.connectionSessionId;
      await runtime.connected.connect({ mode: 'chrome_consent', endpoint: fixture.endpoint }, ctx);
      const [choice] = await runtime.connected.listForLocalPicker(ctx);
      runtime.connectedLease = await runtime.connected.attach(choice.selectionToken, ctx);
      const started = await runtime.start({ scope: 'connected_browser', task: 'Synthetic independent progress test', __deadline: Date.now() + 30000 });
      assert.equal(started.host_input, false);
      await runtime.observe();
      const outcomes = [];
      for (let i = 1; i <= 4; i++) {
        const params = { action: 'click', element_label: `Progress action ${i}` };
        const result = await runtime.control({ command: 'computer.control', params, invokeId: `progress-click-${i}`, deadline: Date.now() + 15000 }, params);
        assert.equal(result.receipt.execution, 'completed', JSON.stringify(result));
        assert.equal(result.receipt.dispatch, 'acknowledged');
        assert.equal(result.receipt.effect, 'unknown', 'Observed change is not proof that the requested goal succeeded');
        assert.equal(result.task_success, false);
        assert.equal(result.observed_state_change?.progress, true, JSON.stringify(result.observed_state_change));
        assert.equal(runtime.coordinator.detector.status(runtime.runId), null);
        assert.deepEqual(JSON.parse(await fixture.state()).progress, Array.from({ length: i }, (_, index) => index + 1));
        outcomes.push({ action: i, effect: result.receipt.effect, latencyMs: result.receipt.timings.totalMs,
          inputAttempts: result.receipt.attempts.length, observedStateChange: result.observed_state_change });
      }
      const inputsBeforeReplay = calls.filter(method => method.startsWith('Input.')).length;
      const params = { action: 'click', element_label: 'Progress action 1' };
      const repeated = await runtime.control({ command: 'computer.control', params, invokeId: 'progress-click-new-id', deadline: Date.now() + 15000 }, params);
      assert.equal(repeated.receipt.dispatch, 'not_started');
      assert.equal(repeated.receipt.effect, 'none_proven');
      assert.equal(repeated.receipt.failure.code, 'diagnosis_required');
      assert.equal(calls.filter(method => method.startsWith('Input.')).length, inputsBeforeReplay);
      assert.deepEqual(JSON.parse(await fixture.state()).progress, [1, 2, 3, 4]);
      await fs.writeFile(path.join(directory, 'progress-evidence.json'), JSON.stringify({ outcomes,
        repeatedIntent: { dispatch: repeated.receipt.dispatch, code: repeated.receipt.failure.code, additionalInputCount: 0 },
        fixtureObservedSteps: [1, 2, 3, 4], screenshotCount: 0, modelRoundTrips: null, metricProvenance: 'scripted_owned_headless_chrome_no_model' }, null, 2), { mode: 0o600 });
      console.log(`Observed progress artifacts: ${directory}`);
    } finally { await runtime.close(); await fixture.close(); }
  });
