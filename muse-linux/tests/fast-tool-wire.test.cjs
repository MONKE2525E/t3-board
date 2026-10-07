const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { deviceSpecs } = require('../src/device-specs.cjs');
const { parseActions, runBatch } = require('../src/action-batch.cjs');
const { LocalBrowser, CHROME_HEIGHT } = require('../src/local-browser.cjs');

const STRING = 1;
const JSON_STRING_FIELDS = [
  ['computer.batch', 'required', 'actions'],
  ['computer.control', 'optional', 'actions'],
  ['computer.control', 'optional', 'coordinate'],
  ['computer.control', 'optional', 'start_coordinate'],
  ['computer.control', 'optional', 'end_coordinate'],
  ['system.run', 'required', 'argv'],
  ['terminal.start', 'optional', 'argv'],
  ['files.trash', 'required', 'paths'],
];
const BATCH_ACTIONS_JSON = '[{"action":"click","coordinate":[100,200]},{"action":"type","text":"Hello"},{"action":"key","key":"Tab"}]';

function advertisedFields(specs) {
  const fields = [];
  for (const [command, spec] of Object.entries(specs)) {
    for (const kind of ['required', 'optional']) {
      for (const [name, field] of Object.entries(spec[kind] || {})) {
        fields.push({ command, kind, name, type: field.type, description: field.description || '' });
      }
    }
  }
  return fields;
}

function sessioned(browser) {
  browser.stopped = false;
  browser.sessionId = 'session';
  browser.sessionExpires = Date.now() + 60000;
  browser.observation = { id: 'obs', url: 'https://example.com/', expires: Date.now() + 60000 };
  browser.window = { id: 1, getContentSize: () => [800, 600] };
  browser.view = {
    webContents: {
      isDestroyed: () => false,
      getURL: () => 'https://example.com/',
      getTitle: () => 'Linux browser test',
      executeJavaScript: async () => { throw Error('should not run'); },
    },
    getBounds: () => ({ x: 0, y: CHROME_HEIGHT, width: 800, height: 558 }),
  };
  return browser;
}

function mockBrowser() {
  return sessioned(new LocalBrowser({ parent: () => null, session: {}, enabled: () => true }));
}

async function pressKey(browser, args) {
  const events = [];
  browser.view.webContents.sendInputEvent = event => events.push(structuredClone(event));
  const result = await browser.control({ action: 'key', observation_id: 'obs', ...args }, { deferObservation: true });
  assert.equal(result.dispatched, true);
  return events;
}

const BATCH_SHOT = { mime_type: 'image/png', data_base64: 'iVBOR', filename: 'linux-window-after.png' };

function mockBatchBackend({ failOn, image } = {}) {
  const calls = [];
  return {
    calls,
    observation: { id: 'fresh', window_id: 'selected' },
    async control(args, options) {
      calls.push({ action: args.action, window_id: args.window_id, observation_id: args.observation_id, defer: options?.deferObservation === true });
      if (failOn && args.action === failOn) throw Error('window_obscured');
      return { dispatched: true };
    },
    async observe(args) {
      const wantImage = args === true || args?.view === 'image';
      return {
        observation_id: 'after',
        window_id: 'selected',
        ...(wantImage ? { image_transfer: image || BATCH_SHOT } : {}),
      };
    },
  };
}

const settle = async () => { for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve)); };

function bridgeFixture(commands, nativeResult) {
  const handlers = new Map(), requests = [], states = [];
  let tick;
  const rpc = {
    isReady: true,
    connectionAuthority: {},
    onClientInvoke: (id, fn) => { handlers.set(id, fn); return () => handlers.delete(id); },
    sendRequest: async (method, params, opts) => {
      requests.push({ method, params: structuredClone(params), opts });
      if (method === 'client.register_capabilities') {
        return { accepted_device_commands: Object.keys(params.capabilities.device_commands).length, rejected_ids: [] };
      }
      return {};
    },
  };
  const element = { __reactFiber$test: { memoizedProps: { value: rpc } } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/device-bridge.js'), 'utf8'), {
    location: { origin: 'https://muse.ai' },
    document: { querySelectorAll: () => [element] },
    crypto,
    console,
    structuredClone,
    setInterval: fn => { tick = fn; return 1; },
    clearInterval: () => {},
    setTimeout,
    Date,
    window: {
      addEventListener: () => {},
      museLinuxDevice: {
        config: async () => ({ id: 'fixture-device', version: 'test', commands }),
        status: s => states.push(s),
        invoke: async () => structuredClone(nativeResult),
      },
    },
  });
  return { handlers, requests, states, tick };
}

test('device specs advertise every parameter as a STRING so JSON arrays arrive encoded', () => {
  const specs = deviceSpecs();
  const fields = advertisedFields(specs);
  assert.ok(fields.length > 0);
  for (const field of fields) {
    assert.equal(field.type, STRING, `${field.command} ${field.kind}.${field.name}`);
  }
  for (const [command, kind, name] of JSON_STRING_FIELDS) {
    const field = specs[command]?.[kind]?.[name];
    assert.equal(field?.type, STRING, `${command} ${kind}.${name}`);
    assert.match(`${specs[command].description} ${field.description}`, /JSON/i, `${command} ${name} docs`);
  }
  assert.equal(specs['computer.batch'].optional.observation_id.type, STRING);
  assert.equal(specs['computer.control'].optional.key.type, STRING);
  assert.equal(specs['computer.control'].optional.modifiers.type, STRING);
});

test('batch accepts the documented STRING JSON actions including nested coordinate arrays', async () => {
  const parsed = parseActions(BATCH_ACTIONS_JSON);
  assert.equal(parsed.length, 3);
  assert.deepEqual(parsed[0].coordinate, [100, 200]);
  assert.equal(parsed[1].text, 'Hello');
  assert.equal(parsed[2].key, 'Tab');
  assert.throws(() => parseActions('[{"action":"click","window_id":"other"}]'), /invalid_batch_field/);
  assert.throws(() => parseActions('[{"action":"key","observation_id":"step"}]'), /invalid_batch_field/);
  assert.throws(() => parseActions('[]'), /invalid_actions/);
  assert.throws(() => parseActions('not-json'), /invalid_actions/);

  const backend = mockBatchBackend();
  const result = await runBatch(backend, { observation_id: 'fresh', actions: BATCH_ACTIONS_JSON });
  assert.equal(result.completed, 3);
  assert.equal(result.stopped, false);
  assert.deepEqual(backend.calls.map(call => call.action), ['click', 'type', 'key']);
  assert.ok(backend.calls.every(call => call.window_id === 'selected' && call.observation_id === 'fresh' && call.defer));
});

test('batch screenshots ride on top-level image_transfer so the VM bridge can export them', async () => {
  const backend = mockBatchBackend();
  const result = await runBatch(backend, { observation_id: 'fresh', view: 'image', actions: '[{"action":"key","key":"Tab"}]' });
  assert.deepEqual(result.image_transfer, BATCH_SHOT);
  assert.equal(result.observation.observation_id, 'after');
  assert.equal(result.observation.image_transfer, undefined);
  assert.equal('image_transfer' in result.observation, false);

  const hidden = mockBatchBackend();
  const withoutShot = await runBatch(hidden, { observation_id: 'fresh', actions: '[{"action":"key","key":"Tab"}]' });
  assert.equal(withoutShot.image_transfer, undefined);
  assert.equal('image_transfer' in withoutShot, false);
});

test('a partial batch still exports the follow-up screenshot at the top level', async () => {
  const backend = mockBatchBackend({ failOn: 'type' });
  const result = await runBatch(backend, {
    observation_id: 'fresh',
    view: 'image',
    actions: '[{"action":"click"},{"action":"type","text":"Hello"},{"action":"key","key":"Enter"}]',
  });
  assert.equal(result.completed, 1);
  assert.equal(result.attempted, 2);
  assert.equal(result.error, 'window_obscured');
  assert.deepEqual(result.image_transfer, BATCH_SHOT);
  assert.equal(result.observation.image_transfer, undefined);
});

test('top-level batch image_transfer is written to the Muse VM and stripped from the invoke payload', async () => {
  const png = Buffer.from('png-bytes').toString('base64');
  const f = bridgeFixture({ 'computer.batch': {} }, {
    completed: 2,
    stopped: false,
    observation: { observation_id: 'after', window_id: 'selected' },
    image_transfer: { mime_type: 'image/png', data_base64: png, filename: 'linux-window-after.png' },
  });
  await settle();
  assert.equal(f.states.at(-1), 'connected');
  await f.handlers.get('computer.batch')(
    { invoke_id: 'batch-1', command_id: 'computer.batch', params_json: '{"observation_id":"fresh","actions":"[]"}', timeout_ms: 10000 },
    { websocketConnectionID: 'fixture-connection' },
  );
  const write = f.requests.find(r => r.method === 'fs.write');
  assert.match(write.params.path, /^linux-companion\/fixture-device\/[0-9a-f-]+-linux-window-after\.png$/);
  assert.equal(write.params.data_base64, png);
  assert.equal(write.params.overwrite, false);
  assert.equal(write.opts.expectedConnectionId, 'fixture-connection');
  const receipt = f.requests.find(r => r.method === 'client.invoke.result');
  const payload = JSON.parse(receipt.params.payload_json);
  assert.equal(receipt.params.ok, true);
  assert.equal(payload.image.path, write.params.path);
  assert.equal(payload.image.mime_type, 'image/png');
  assert.equal(payload.image_transfer, undefined);
  assert.equal(payload.observation.image_transfer, undefined);
  assert.equal(JSON.stringify(payload).includes(png), false);
});

test('browser key aliases and chords are case-insensitive over mocked Electron input', async () => {
  const chord = await pressKey(mockBrowser(), { key: 'Ctrl+Shift+P' });
  assert.deepEqual(chord, [
    { type: 'keyDown', keyCode: 'p', modifiers: ['control', 'shift'] },
    { type: 'keyUp', keyCode: 'p', modifiers: ['control', 'shift'] },
  ]);
  assert.deepEqual(await pressKey(mockBrowser(), { key: 'ctrl+shift+p' }), chord);
  assert.deepEqual(await pressKey(mockBrowser(), { key: 'CTRL+SHIFT+P' }), chord);
  assert.deepEqual(await pressKey(mockBrowser(), { key: 'P', modifiers: 'CTRL,SHIFT' }), chord);
  assert.deepEqual(await pressKey(mockBrowser(), { key: 'p', modifiers: ['Control', 'Shift'] }), chord);

  const enter = await pressKey(mockBrowser(), { key: 'Enter' });
  assert.deepEqual(enter, [
    { type: 'keyDown', keyCode: 'Enter', modifiers: [] },
    { type: 'char', keyCode: '\r', modifiers: [] },
    { type: 'keyUp', keyCode: 'Enter', modifiers: [] },
  ]);
  assert.deepEqual(await pressKey(mockBrowser(), { key: 'Return' }), enter);
  assert.deepEqual(await pressKey(mockBrowser(), { key: 'ENTER' }), enter);

  const superKey = await pressKey(mockBrowser(), { key: 'Super+Tab' });
  assert.deepEqual(superKey, [
    { type: 'keyDown', keyCode: 'Tab', modifiers: ['meta'] },
    { type: 'keyUp', keyCode: 'Tab', modifiers: ['meta'] },
  ]);
  assert.deepEqual(await pressKey(mockBrowser(), { key: 'Win+Tab' }), superKey);
  assert.deepEqual(await pressKey(mockBrowser(), { key: 'Meta+Tab' }), superKey);
});

test('browser key refuses an invalid name before sending Electron events', async () => {
  const browser = mockBrowser();
  let sent = false;
  browser.view.webContents.sendInputEvent = () => { sent = true; };
  await assert.rejects(browser.control({ action: 'key', observation_id: 'obs', key: 'HoldBreath' }, { deferObservation: true }), /invalid_key/);
  assert.equal(sent, false);
});

test('a partial batch never runs later actions and a replay would resend already dispatched input', async () => {
  // Fail on the type step itself. A global call-count gate (calls.length === 2) lets the
  // fourth control succeed, so replay would dispatch key even though source still stops
  // later actions inside a single runBatch.
  const backend = mockBatchBackend({ failOn: 'type' });
  const actions = '[{"action":"click"},{"action":"type","text":"Hello"},{"action":"key","key":"Enter"}]';
  const first = await runBatch(backend, { observation_id: 'fresh', actions });
  assert.deepEqual(backend.calls.map(call => call.action), ['click', 'type']);
  assert.equal(first.completed, 1);
  assert.equal(first.attempted, 2);
  assert.equal(first.total, 3);
  assert.equal(first.stopped, true);
  assert.equal(first.error, 'window_obscured');
  assert.equal(first.retryable, false);
  assert.equal(first.task_success, false);
  assert.match(first.verification, /do not replay/i);

  const second = await runBatch(backend, { observation_id: 'fresh', actions });
  assert.deepEqual(backend.calls.map(call => call.action), ['click', 'type', 'click', 'type']);
  assert.equal(second.completed, 1);
  assert.equal(second.attempted, 2);
  assert.equal(second.retryable, false);
});
