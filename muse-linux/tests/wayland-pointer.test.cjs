const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const { WaylandPointer } = require('../src/wayland-pointer.cjs');

const ROOT = path.join(__dirname, '..');
const XML = path.join(ROOT, 'native/protocols/pointer/wlr-virtual-pointer-unstable-v1.xml');
const SOURCE = path.join(ROOT, 'native/pointer.c');
const WORK = fs.mkdtempSync(path.join('/tmp/muse-port-d6c9/control/pointer', `p${process.pid}-`));

const sample = {
  x: 100,
  y: 200,
  localX: 100,
  localY: 200,
  width: 1920,
  height: 1080,
  output: 'DP-1',
};

function fixture({ ready = { event: 'ready', outputs: [{ name: 'DP-1', x: 0, y: 0, width: 1920, height: 1080 }] } } = {}) {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
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
      const message = JSON.parse(line);
      child.messages.push(message);
    }
  });
  let failures = 0;
  const moves = [];
  const pointer = new WaylandPointer({
    helper: 'owned-muse-pointer',
    spawnImpl: () => {
      queueMicrotask(() => { if (ready) emit(ready); });
      return child;
    },
    onMove: point => moves.push(point),
    onFailure: () => failures++,
    timeoutMs: 120,
  });
  return { child, pointer, emit, moves, failures: () => failures };
}

test('start waits for ready and perform returns dispatched pointer from helper results', async t => {
  const f = fixture();
  t.after(() => f.pointer.stop());
  const started = await f.pointer.start();
  assert.equal(f.pointer.available, true);
  assert.equal(started.outputs[0].name, 'DP-1');
  const performing = f.pointer.perform({ action: 'move', point: sample, duration: 120 });
  await new Promise(resolve => setImmediate(resolve));
  const request = f.child.messages.find(message => message.action === 'move');
  assert.equal(request.id, '1');
  assert.deepEqual(request.point, sample);
  assert.equal(request.duration, 120);
  f.emit({ event: 'ack', id: '1', x: 80, y: 160 });
  f.emit({ event: 'ack', id: '1', x: 100, y: 200 });
  f.emit({ event: 'result', id: '1', x: 100, y: 200 });
  assert.deepEqual(await performing, { dispatched: true, pointer: { x: 100, y: 200 } });
  assert.deepEqual(f.moves, [{ x: 80, y: 160, click: false }, { x: 100, y: 200, click: false }]);
});

test('click drag and scroll send the helper contract and onMove follows click acks', async t => {
  const f = fixture();
  t.after(() => f.pointer.stop());
  await f.pointer.start();
  const from = { ...sample, x: 10, y: 20, localX: 10, localY: 20 };
  const click = f.pointer.perform({ action: 'click', point: sample, button: 'left' });
  await new Promise(resolve => setImmediate(resolve));
  f.emit({ event: 'ack', id: '1', x: 100, y: 200, click: true });
  f.emit({ event: 'result', id: '1', x: 100, y: 200 });
  assert.deepEqual(await click, { dispatched: true, pointer: { x: 100, y: 200 } });
  assert.equal(f.child.messages.at(-1).action, 'click');
  assert.equal(f.moves.at(-1).click, true);
  const drag = f.pointer.perform({ action: 'drag', point: sample, from, button: 'left', duration: 80 });
  await new Promise(resolve => setImmediate(resolve));
  f.emit({ event: 'ack', id: '2', x: 10, y: 20, click: true });
  f.emit({ event: 'ack', id: '2', x: 100, y: 200 });
  f.emit({ event: 'result', id: '2', x: 100, y: 200 });
  assert.equal((await drag).dispatched, true);
  assert.equal(f.child.messages.at(-1).action, 'drag');
  const scroll = f.pointer.perform({ action: 'scroll', point: sample, direction: 'down', amount: 3 });
  await new Promise(resolve => setImmediate(resolve));
  f.emit({ event: 'result', id: '3', x: 100, y: 200 });
  assert.equal((await scroll).dispatched, true);
  assert.deepEqual(f.child.messages.at(-1), { id: '3', action: 'scroll', point: sample, direction: 'down', amount: 3 });
});

test('Stop before ready refuses the start and kills only the owned helper', async () => {
  const f = fixture({ ready: null });
  const starting = f.pointer.start();
  await new Promise(resolve => setImmediate(resolve));
  f.pointer.stop();
  f.emit({ event: 'ready', outputs: [{ name: 'DP-1', x: 0, y: 0, width: 1920, height: 1080 }] });
  await assert.rejects(starting, /stopped_by_user/);
  assert.equal(f.pointer.available, false);
  assert.deepEqual(f.child.kills, ['SIGTERM']);
  assert.equal(f.failures(), 0);
});

test('abort of a pending perform stops the owned child without hung buttons', async t => {
  const f = fixture();
  t.after(() => f.pointer.stop());
  await f.pointer.start();
  const controller = new AbortController();
  const pending = f.pointer.perform({ action: 'move', point: sample }, controller.signal);
  await new Promise(resolve => setImmediate(resolve));
  controller.abort();
  await assert.rejects(pending, /stopped_by_user/);
  assert.equal(f.pointer.available, false);
  assert.equal(f.child.kills[0], 'SIGTERM');
});

test('unexpected helper exit after ready calls onFailure and rejects pending', async t => {
  const f = fixture();
  t.after(() => f.pointer.stop());
  await f.pointer.start();
  const pending = f.pointer.perform({ action: 'move', point: sample });
  await new Promise(resolve => setImmediate(resolve));
  f.child.emit('exit', 1, null);
  await assert.rejects(pending, /stopped_by_user|pointer_helper_lost/);
  assert.equal(f.failures(), 1);
  assert.equal(f.pointer.available, false);
});

test('an already aborted command closes the helper without an orphan rejection', async t => {
  const f = fixture();
  t.after(() => f.pointer.stop());
  await f.pointer.start();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(f.pointer.perform({ action: 'move', point: sample }, controller.signal), /stopped_by_user/);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.pointer.pending.size, 0);
  assert.equal(f.child.messages.some(message => message.action), false);
  assert.equal(f.pointer.available, false);
});

test('a closed command pipe ends the session and settles every pending wait', async t => {
  const f = fixture();
  t.after(() => f.pointer.stop());
  await f.pointer.start();
  f.child.stdin.end();
  await assert.rejects(f.pointer.perform({ action: 'move', point: sample }), /pointer_unavailable/);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.pointer.pending.size, 0);
  assert.equal(f.pointer.available, false);
  assert.equal(f.failures(), 1);
  assert.equal(f.child.kills[0], 'SIGTERM');
});

test('wrapper rejects unsupported actions, bad outputs, non-integers, and cross-output drags', async t => {
  const f = fixture();
  t.after(() => f.pointer.stop());
  await f.pointer.start();
  await assert.rejects(f.pointer.perform({ action: 'hover', point: sample }), /action_unsupported/);
  await assert.rejects(f.pointer.perform({ action: 'move', point: { ...sample, output: 'DP-1;rm' } }), /invalid_output/);
  await assert.rejects(f.pointer.perform({ action: 'move', point: { ...sample, x: 1.5 } }), /invalid_x/);
  await assert.rejects(f.pointer.perform({ action: 'drag', point: sample }), /invalid_from/);
  await assert.rejects(f.pointer.perform({
    action: 'drag',
    point: sample,
    from: { ...sample, output: 'DP-2' },
  }), /cross_output_drag_unsupported/);
  assert.equal(f.child.messages.some(message => message.action), false);
});

test('protocol XML is output-bound v2 and the helper compiles without host input', () => {
  const xml = fs.readFileSync(XML, 'utf8');
  assert.match(xml, /create_virtual_pointer_with_output/);
  assert.match(xml, /since="2"/);
  assert.match(xml, /interface="wl_output"/);
  assert.match(fs.readFileSync(SOURCE, 'utf8'), /create_virtual_pointer_with_output/);
  assert.match(fs.readFileSync(SOURCE, 'utf8'), /json-glib\/json-glib\.h/);
  const generated = path.join(WORK, 'generated');
  fs.mkdirSync(generated, { recursive: true });
  const header = path.join(generated, 'wlr-virtual-pointer-unstable-v1-client-protocol.h');
  const protocol = path.join(generated, 'wlr-virtual-pointer-unstable-v1-protocol.c');
  const binary = path.join(WORK, 'muse-pointer');
  execFileSync('wayland-scanner', ['client-header', XML, header], { stdio: 'pipe' });
  execFileSync('wayland-scanner', ['private-code', XML, protocol], { stdio: 'pipe' });
  const flags = execFileSync('pkg-config', ['--cflags', '--libs', 'wayland-client', 'json-glib-1.0'], { encoding: 'utf8' }).trim().split(/\s+/).filter(Boolean);
  execFileSync('cc', ['-std=gnu11', '-O2', '-Wall', '-Wextra', '-Werror', SOURCE, '-o', binary, '-I' + generated, protocol, ...flags, '-lm'], { stdio: 'pipe' });
  fs.chmodSync(binary, 0o755);
  assert.equal(fs.existsSync(binary), true);
});

test('compiled helper reports wayland_unavailable on a missing display and does not use the host compositor', async () => {
  const generated = path.join(WORK, 'generated');
  const binary = path.join(WORK, 'muse-pointer');
  if (!fs.existsSync(binary)) {
    const header = path.join(generated, 'wlr-virtual-pointer-unstable-v1-client-protocol.h');
    const protocol = path.join(generated, 'wlr-virtual-pointer-unstable-v1-protocol.c');
    fs.mkdirSync(generated, { recursive: true });
    execFileSync('wayland-scanner', ['client-header', XML, header], { stdio: 'pipe' });
    execFileSync('wayland-scanner', ['private-code', XML, protocol], { stdio: 'pipe' });
    const flags = execFileSync('pkg-config', ['--cflags', '--libs', 'wayland-client', 'json-glib-1.0'], { encoding: 'utf8' }).trim().split(/\s+/).filter(Boolean);
    execFileSync('cc', ['-std=gnu11', '-O2', '-Wall', '-Wextra', '-Werror', SOURCE, '-o', binary, '-I' + generated, protocol, ...flags, '-lm'], { stdio: 'pipe' });
  }
  const env = { ...process.env, WAYLAND_DISPLAY: 'muse-pointer-test-missing', XDG_RUNTIME_DIR: WORK };
  delete env.WAYLAND_SOCKET;
  const child = spawn(binary, [], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  child.stdout.on('data', chunk => { stdout += chunk.toString('utf8'); });
  child.stdin.end();
  const code = await new Promise(resolve => child.once('exit', resolve));
  const event = JSON.parse(stdout.trim().split('\n')[0]);
  assert.equal(event.event, 'error');
  assert.equal(event.error, 'wayland_unavailable');
  assert.equal(typeof event.id, 'undefined');
  assert.equal(code, 1);
});
