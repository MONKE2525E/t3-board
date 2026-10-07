const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { DesktopOverlay } = require('../src/desktop-overlay.cjs');

function fixture({ autoMap = true } = {}) {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.exitCode = null; child.signalCode = null; child.kills = []; child.messages = [];
  child.kill = signal => { child.kills.push(signal); child.signalCode = signal; child.emit('exit', null, signal); };
  const emit = value => child.stdout.write(JSON.stringify(value) + '\n');
  child.stdin.on('data', data => {
    for (const line of data.toString().trim().split('\n')) {
      const message = JSON.parse(line); child.messages.push(message);
      if (message.active && autoMap) queueMicrotask(() => emit({ event: 'active', id: message.id, active: true, outputs: 2 }));
    }
  });
  let stops = 0, failures = 0;
  const overlay = new DesktopOverlay({ helper: 'owned-helper', spawnImpl: () => { queueMicrotask(() => emit({ event: 'ready', outputs: 2 })); return child; }, onStop: () => stops++, onFailure: () => failures++, timeoutMs: 100 });
  return { child, overlay, emit, counts: () => ({ stops, failures }) };
}

test('desktop indicator requires a mapped acknowledgement and never sends private task text', async t => {
  const f = fixture(); t.after(() => f.overlay.stop());
  assert.deepEqual(await f.overlay.start('private task text'), { outputs: 2 });
  assert.equal(f.overlay.active, true);
  assert.equal(JSON.stringify(f.child.messages).includes('private task'), false);
  f.overlay.action('Typing'); f.overlay.pointer({ x: -50, y: 1300, click: true });
  assert.equal(f.child.messages.at(-2).action, 'Typing');
  assert.deepEqual(f.child.messages.at(-1).pointer, { x: -50, y: 1300, visible: true, click: true });
});

test('each mapped overlay has a fresh identity that ends with the owned helper', async t => {
  const f=fixture();f.child.pid=4242;t.after(()=>f.overlay.stop());
  assert.equal(f.overlay.namespaces,null);
  await f.overlay.start();const first=f.overlay.namespaces;
  assert.match(first.glow,/^muse-control-overlay-[a-f0-9]{32}$/);
  assert.equal(first.stop,first.glow.replace('overlay-','stop-'));
  f.overlay.stop();assert.equal(f.overlay.namespaces,null);
  const next=fixture();next.child.pid=4243;t.after(()=>next.overlay.stop());
  await next.overlay.start();assert.notEqual(next.overlay.namespaces.glow,first.glow);
});

test('Stop during indicator startup refuses late mapping and closes only its child', async () => {
  const f = fixture({ autoMap: false });
  const starting = f.overlay.start();
  await new Promise(resolve => setImmediate(resolve));
  const id = f.child.messages.find(message => message.active).id;
  f.overlay.stop(); f.emit({ event: 'active', id, active: true, outputs: 2 });
  await assert.rejects(starting, /stopped_by_user/);
  assert.equal(f.overlay.active, false); assert.equal(f.overlay.outputs, 0);
  assert.deepEqual(f.child.kills, ['SIGTERM']);
});

test('the visible Stop button stops once and helper loss ends desktop control', async () => {
  const f = fixture(); await f.overlay.start();
  f.emit({ event: 'stop' }); f.emit({ event: 'stop' });
  assert.deepEqual(f.counts(), { stops: 1, failures: 0 }); assert.equal(f.overlay.active, false);
  const lost = fixture(); await lost.overlay.start(); lost.child.emit('exit', 1, null);
  assert.deepEqual(lost.counts(), { stops: 0, failures: 1 }); assert.equal(lost.overlay.active, false);
});

test('zero outputs, invalid protocol and missing acknowledgement refuse control', async () => {
  const empty = fixture({ autoMap: false }); const start = empty.overlay.start();
  await new Promise(resolve => setImmediate(resolve));
  empty.emit({ event: 'active', id: empty.child.messages[0].id, active: true, outputs: 0 });
  await assert.rejects(start, /desktop_indicator_unavailable/);
  const broken = fixture({ autoMap: false }); const bad = broken.overlay.start(); broken.child.stdout.write('not json\n');
  await assert.rejects(bad, /desktop_indicator_lost/);
  const late = fixture({ autoMap: false }); await assert.rejects(late.overlay.start(), /desktop_indicator_timeout/);
  assert.equal(late.overlay.active, false);
});

test('helper loss during startup reports an indicator failure instead of a user Stop', async () => {
  for (const failure of ['exit', 'protocol']) {
    const f = fixture({ autoMap: false });
    const starting = f.overlay.start();
    await new Promise(resolve => setImmediate(resolve));
    if (failure === 'exit') f.child.emit('exit', 1, null);
    else f.emit({ event: 'error', error: 'wayland_unavailable' });
    await assert.rejects(starting, /desktop_indicator_lost/);
    assert.equal(f.overlay.active, false);
    assert.equal(f.overlay.child, null);
    assert.deepEqual(f.counts(), { stops: 0, failures: 0 });
  }
});

test('late cursor reads cannot repaint a stopped session', async () => {
  const f = fixture(); let release;
  f.overlay.readCursor = () => new Promise(resolve => { release = resolve; });
  await f.overlay.start();
  const before = f.child.messages.length;
  f.overlay.stop(); release({ x: 200, y: 300 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.child.messages.length, before + 1);
  assert.equal(f.child.messages.at(-1).quit, true);
  assert.equal(f.overlay.active, false);
});

test('pause/resume events and capture acknowledgements preserve session state', async t => {
  const f = fixture(); t.after(() => f.overlay.stop());
  let pauses = 0, resumes = 0;
  f.overlay.onPause = () => pauses++; f.overlay.onResume = () => resumes++;
  await f.overlay.start(); f.emit({ event: 'pause' }); f.emit({ event: 'resume' });
  assert.equal(pauses, 1); assert.equal(resumes, 1);
  f.overlay.paused(true, 'human_input'); f.overlay.pointer({ x: 20, y: 20 });
  assert.equal(f.child.messages.at(-1).pointer.visible, false);
  const hiding = f.overlay.captureHidden(true);
  const msg = f.child.messages.at(-1);
  assert.equal(msg.capture_hidden, true); assert.equal(f.overlay.captureIsHidden, false);
  f.emit({ event: 'capture', id: msg.id, hidden: true }); await hiding;
  assert.equal(f.overlay.captureIsHidden, true);
  assert.equal(f.overlay.isPaused, true);
  f.emit({ event: 'capture', hidden: false, expired: true });
  assert.equal(f.overlay.captureExpired, true);
  assert.equal(f.overlay.captureIsHidden, false);
});
