'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const { DesktopActivity } = require('../src/desktop-activity.cjs');

const ROOT = path.join(__dirname, '..');
const SOURCE = path.join(ROOT, 'native/activity.c');
const WRAPPER = path.join(ROOT, 'src/desktop-activity.cjs');
const PARENT = '/tmp/muse-port-d6c9/control/activity';
fs.mkdirSync(PARENT, { recursive: true });
const WORK = fs.mkdtempSync(path.join(PARENT, `a${process.pid}-`));
const BINARY = path.join(WORK, 'muse-activity');

function compileHelper() {
  if (fs.existsSync(BINARY)) return BINARY;
  execFileSync('cc', ['-std=gnu11', '-O2', '-Wall', '-Wextra', '-Werror', SOURCE, '-o', BINARY], { stdio: 'pipe' });
  fs.chmodSync(BINARY, 0o755);
  return BINARY;
}

function fixture({ ready = { event: 'ready', available: true, devices: 2 } } = {}) {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.pid = 4242;
  child.exitCode = null;
  child.signalCode = null;
  child.kills = [];
  child.messages = [];
  child.kill = signal => {
    child.kills.push(signal);
    child.signalCode = signal;
    child.emit('exit', null, signal);
  };
  const emit = value => child.stdout.write(JSON.stringify(value) + '\n');
  child.stdin.on('data', data => {
    for (const line of data.toString().split('\n').filter(Boolean)) {
      child.messages.push(JSON.parse(line));
    }
  });
  const inputs = [];
  let failures = 0;
  let spawned = 0;
  const activity = new DesktopActivity({
    helper: 'owned-muse-activity',
    spawnImpl: () => {
      spawned += 1;
      queueMicrotask(() => { if (ready) emit(ready); });
      return child;
    },
    onInput: event => inputs.push(event),
    onFailure: () => { failures += 1; },
    timeoutMs: 120,
  });
  return { child, activity, emit, inputs, failures: () => failures, spawned: () => spawned };
}

test('helper source never grabs, writes, or links extra libraries', () => {
  const text = fs.readFileSync(SOURCE, 'utf8');
  assert.match(text, /O_RDONLY/);
  assert.match(text, /O_NONBLOCK/);
  assert.match(text, /BUS_VIRTUAL/);
  assert.match(text, /EVIOCGID/);
  assert.equal(text.includes('EVIOCGRAB'), false);
  assert.equal(text.includes('O_RDWR'), false);
  assert.equal(text.includes('EVIOCS'), false);
  assert.equal(text.includes('libevdev'), false);
  assert.equal(text.includes('json-glib'), false);
  assert.equal(text.includes('uinput.h'), false);
  assert.match(text, /kind\\":\\"pointer\\"/);
  assert.match(text, /kind\\":\\"keyboard\\"/);
  assert.equal(/\bwrite\s*\(/.test(text), false);
});

test('wrapper never forwards key data and only starts during an explicit start()', () => {
  const text = fs.readFileSync(WRAPPER, 'utf8');
  assert.match(text, /onInput\(\{ kind: event\.kind \}\)/);
  assert.match(text, /MUSE_ACTIVITY_DISABLED/);
  assert.equal(text.includes('EVIOCGRAB'), false);
});

test('compiled helper --self-test classifies synthetic events without host devices or key codes', () => {
  const binary = compileHelper();
  const result = execFileSync(binary, ['--self-test'], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, MUSE_ACTIVITY_DISABLED: '1' },
  });
  const lines = result.trim().split('\n').filter(Boolean);
  assert.ok(lines.length >= 4);
  for (const line of lines) {
    const event = JSON.parse(line);
    assert.deepEqual(Object.keys(event).sort(), ['event', 'kind']);
    assert.equal(event.event, 'input');
    assert.ok(event.kind === 'pointer' || event.kind === 'keyboard');
  }
  assert.equal(result.includes('"code"'), false);
  assert.equal(result.includes('"key"'), false);
  assert.equal(result.includes('"text"'), false);
  assert.equal(result.includes('"value"'), false);
  assert.equal(result.includes('/dev/'), false);
  assert.equal(result.includes('event0'), false);
  assert.equal(/\b30\b/.test(result), false);
  assert.equal(result.includes('BTN'), false);
  assert.equal(result.includes('KEY_A'), false);
  assert.equal(result.includes('serial'), false);
});

test('MUSE_ACTIVITY_DISABLED compiled helper reports unavailable without opening host input', async () => {
  const binary = compileHelper();
  const child = spawn(binary, [], {
    env: { PATH: process.env.PATH, MUSE_ACTIVITY_DISABLED: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  child.stdout.on('data', chunk => { stdout += chunk.toString('utf8'); });
  const ready = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('ready_timeout')), 500);
    child.stdout.once('data', () => {
      clearTimeout(timer);
      resolve();
    });
    child.once('exit', (code, signal) => reject(Error(`exit ${code} ${signal}`)));
  });
  void ready;
  const event = JSON.parse(stdout.trim().split('\n')[0]);
  assert.deepEqual(event, { event: 'ready', available: false, devices: 0 });
  child.stdin.end(JSON.stringify({ quit: true }) + '\n');
  const code = await new Promise(resolve => child.once('exit', resolve));
  assert.equal(code, 0);
  assert.equal(stdout.includes('/dev/'), false);
});

test('start waits for ready and onInput receives only kind', async t => {
  const f = fixture();
  t.after(() => f.activity.stop());
  assert.deepEqual(await f.activity.start(), { available: true, devices: 2 });
  assert.equal(f.activity.available, true);
  f.emit({ event: 'input', kind: 'pointer', code: 30, key: 'a', device: '/dev/input/event0', value: 1, text: 'secret' });
  f.emit({ event: 'input', kind: 'keyboard', serial: 'abc', name: 'AT keyboard' });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.inputs, [{ kind: 'pointer' }, { kind: 'keyboard' }]);
  assert.equal(JSON.stringify(f.inputs).includes('secret'), false);
  assert.equal(JSON.stringify(f.inputs).includes('event0'), false);
  assert.equal(JSON.stringify(f.inputs).includes('30'), false);
  assert.equal(JSON.stringify(f.inputs).includes('AT keyboard'), false);
});

test('MUSE_ACTIVITY_DISABLED start does not spawn or read host hardware', async () => {
  let spawned = 0;
  const activity = new DesktopActivity({
    helper: 'owned-muse-activity',
    env: { MUSE_ACTIVITY_DISABLED: '1' },
    spawnImpl: () => { spawned += 1; throw Error('should_not_spawn'); },
    timeoutMs: 50,
  });
  assert.deepEqual(await activity.start(), { available: false, devices: 0 });
  assert.equal(activity.available, false);
  assert.equal(spawned, 0);
});

test('unavailable ready is a successful start and does not call onFailure', async t => {
  const f = fixture({ ready: { event: 'ready', available: false, devices: 0 } });
  t.after(() => f.activity.stop());
  assert.deepEqual(await f.activity.start(), { available: false, devices: 0 });
  assert.equal(f.failures(), 0);
  assert.equal(f.activity.running, true);
});

test('Stop before ready refuses the start and kills only the owned helper', async () => {
  const f = fixture({ ready: null });
  const starting = f.activity.start();
  await new Promise(resolve => setImmediate(resolve));
  f.activity.stop();
  f.emit({ event: 'ready', available: true, devices: 1 });
  await assert.rejects(starting, /stopped_by_user/);
  assert.equal(f.activity.available, false);
  assert.deepEqual(f.child.kills, ['SIGTERM']);
  assert.equal(f.failures(), 0);
  assert.deepEqual(f.child.messages[0], { quit: true });
});

test('EOF after ready fail-closes and calls onFailure', async t => {
  const f = fixture();
  t.after(() => f.activity.stop());
  await f.activity.start();
  f.child.emit('exit', 0, null);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.failures(), 1);
  assert.equal(f.activity.available, false);
  assert.equal(f.activity.running, false);
});

test('invalid JSON, unknown kind, and stdout overflow fail closed', async t => {
  const invalid = fixture();
  t.after(() => invalid.activity.stop());
  await invalid.activity.start();
  invalid.child.stdout.write('not json\n');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(invalid.failures(), 1);

  const kind = fixture();
  t.after(() => kind.activity.stop());
  await kind.activity.start();
  kind.emit({ event: 'input', kind: 'text', text: 'hello' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(kind.failures(), 1);
  assert.equal(kind.inputs.length, 0);

  const overflow = fixture({ ready: null });
  t.after(() => overflow.activity.stop());
  const starting = overflow.activity.start();
  overflow.child.stdout.write('x'.repeat(70000));
  await assert.rejects(starting, /activity_helper_lost|stopped_by_user|activity_helper_timeout/);
  assert.equal(overflow.activity.available, false);
});

test('input after stop is ignored and stop kills only the owned helper', async t => {
  const f = fixture();
  t.after(() => f.activity.stop());
  await f.activity.start();
  f.activity.stop();
  f.emit({ event: 'input', kind: 'keyboard', key: 'a' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.inputs.length, 0);
  assert.equal(f.child.kills[0], 'SIGTERM');
  assert.equal(f.failures(), 0);
});

test('loss of every physical device reports unavailable, without raw device details', async t => {
  const f = fixture(); t.after(() => f.activity.stop()); await f.activity.start();
  f.emit({ event: 'ready', available: false, devices: 0 });
  assert.equal(f.activity.available, false);
  assert.equal(f.failures(), 1);
  f.emit({ event: 'ready', available: true, devices: 2 });
  assert.equal(f.activity.available, true);
  assert.equal(f.inputs.length, 0);
});
