'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const { KeyboardInput, CHUNK_SIZE, requireBmpText, NATIVE_TEXT_UNSUPPORTED } = require('../src/keyboard-input.cjs');

const ROOT = path.join(__dirname, '..');
const XML = path.join(ROOT, 'native/protocols/keyboard/virtual-keyboard-unstable-v1.xml');
const SOURCE = path.join(ROOT, 'native/keyboard.c');
const WORK = fs.mkdtempSync(path.join('/tmp/muse-port-d6c9/control/keyboard', `k${process.pid}-`));

function fixture({ ready = { event: 'ready' } } = {}) {
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
  const keyboard = new KeyboardInput({
    helper: 'owned-muse-keyboard',
    spawnImpl: () => {
      queueMicrotask(() => { if (ready) emit(ready); });
      return child;
    },
    timeoutMs: 120,
    chunkSize: 4,
  });
  return { child, keyboard, emit };
}

async function waitMessage(f, pred) {
  for (let i = 0; i < 30; i++) {
    const found = f.child.messages.find(pred);
    if (found) return found;
    await new Promise(resolve => setImmediate(resolve));
  }
  throw Error('message_timeout');
}

test('non-BMP text is refused before the helper starts', async () => {
  let spawned = 0;
  const keyboard = new KeyboardInput({
    helper: 'owned-muse-keyboard',
    spawnImpl: () => { spawned += 1; throw Error('should_not_spawn'); },
  });
  await assert.rejects(keyboard.type('ok\u{1F412}'), error => {
    assert.equal(error.message, NATIVE_TEXT_UNSUPPORTED);
    return true;
  });
  assert.throws(() => requireBmpText('a\u{1F412}b'), error => {
    assert.equal(error.message, NATIVE_TEXT_UNSUPPORTED);
    return true;
  });
  requireBmpText('hé日\n');
  assert.equal(spawned, 0);
});

test('type and key return dispatched and never put text on argv', async t => {
  const f = fixture();
  t.after(() => f.keyboard.stop());
  const typing = f.keyboard.type('Hi\n');
  const request = await waitMessage(f, message => message.action === 'type');
  assert.equal(request.text, 'Hi\n');
  assert.equal(f.child.messages.some(message => message.quit), false);
  f.emit({ event: 'result', id: request.id, dispatched: true });
  assert.deepEqual(await typing, { dispatched: true, characters: 3 });
  assert.equal(f.child.kills[0], 'SIGTERM');
});

test('key sends canonical Ctrl+Shift+P to the helper', async t => {
  const f = fixture();
  t.after(() => f.keyboard.stop());
  const pending = f.keyboard.key('Ctrl+Shift+P');
  const request = await waitMessage(f, message => message.action === 'key');
  assert.equal(request.key, 'p');
  assert.deepEqual(request.mods, ['control', 'shift']);
  f.emit({ event: 'result', id: request.id, dispatched: true });
  assert.deepEqual(await pending, { dispatched: true, key: 'p', mods: ['control', 'shift'] });
});

test('standalone Super/Meta/Win taps send KEY_LEFTMETA 125 with empty extra mods', async t => {
  const f = fixture();
  t.after(() => f.keyboard.stop());
  const pending = f.keyboard.key('Win');
  const request = await waitMessage(f, message => message.action === 'key');
  assert.equal(request.key, 'Super');
  assert.equal(request.code, 125);
  assert.deepEqual(request.mods, []);
  f.emit({ event: 'result', id: request.id, dispatched: true });
  assert.deepEqual(await pending, { dispatched: true, key: 'Super', mods: [] });
});

test('Ctrl+Super keeps Control held and Super as KEY_LEFTMETA', async t => {
  const f = fixture();
  t.after(() => f.keyboard.stop());
  const pending = f.keyboard.key('Ctrl+Super');
  const request = await waitMessage(f, message => message.action === 'key');
  assert.equal(request.key, 'Super');
  assert.equal(request.code, 125);
  assert.deepEqual(request.mods, ['control']);
  f.emit({ event: 'result', id: request.id, dispatched: true });
  assert.deepEqual(await pending, { dispatched: true, key: 'Super', mods: ['control'] });
});

test('abort during a Super tap kills only the owned helper', async t => {
  const f = fixture();
  t.after(() => f.keyboard.stop());
  const controller = new AbortController();
  const pending = f.keyboard.key('Super', controller.signal);
  await waitMessage(f, message => message.action === 'key');
  controller.abort();
  await assert.rejects(pending, /stopped_by_user/);
  assert.equal(f.child.kills[0], 'SIGTERM');
});

test('validateFocus runs after ready and between chunks then stops the owned helper on mismatch', async t => {
  const f = fixture();
  t.after(() => f.keyboard.stop());
  let n = 0;
  f.keyboard.setValidateFocus(async () => ++n < 3);
  const pending = f.keyboard.type('abcdefgh');
  const first = await waitMessage(f, message => message.action === 'type');
  f.emit({ event: 'result', id: first.id, dispatched: true });
  await assert.rejects(pending, /focus_lost/);
  assert.equal(f.child.kills[0], 'SIGTERM');
  assert.equal(n, 3);
  assert.equal(f.child.messages.filter(message => message.action === 'type').length, 1);
  assert.equal(CHUNK_SIZE, 64);
});

test('per-request validateFocus wins over the instance callback', async t => {
  const f = fixture();
  t.after(() => f.keyboard.stop());
  f.keyboard.validateFocus = async () => false;
  const pending = f.keyboard.type('ok', { validateFocus: async () => true });
  const request = await waitMessage(f, message => message.action === 'type');
  f.emit({ event: 'result', id: request.id, dispatched: true });
  assert.deepEqual(await pending, { dispatched: true, characters: 2 });
});

test('abort kills only the owned helper', async t => {
  const f = fixture();
  t.after(() => f.keyboard.stop());
  const controller = new AbortController();
  const pending = f.keyboard.type('hello', controller.signal);
  await waitMessage(f, message => message.action === 'type');
  controller.abort();
  await assert.rejects(pending, /stopped_by_user/);
  assert.equal(f.child.kills[0], 'SIGTERM');
});

test('overlap while a request is in flight is keyboard_busy', async t => {
  const f = fixture();
  t.after(() => f.keyboard.stop());
  const first = f.keyboard.type('ab');
  const request = await waitMessage(f, message => message.action === 'type');
  await assert.rejects(f.keyboard.key('Enter'), /keyboard_busy/);
  f.emit({ event: 'result', id: request.id, dispatched: true });
  assert.equal((await first).dispatched, true);
});

test('protocol XML is virtual-keyboard v1 and the helper compiles without host input', () => {
  const xml = fs.readFileSync(XML, 'utf8');
  assert.match(xml, /zwp_virtual_keyboard_manager_v1/);
  assert.match(xml, /create_virtual_keyboard/);
  assert.match(fs.readFileSync(SOURCE, 'utf8'), /zwp_virtual_keyboard_manager_v1_create_virtual_keyboard/);
  assert.match(fs.readFileSync(SOURCE, 'utf8'), /json-glib\/json-glib\.h/);
  assert.match(fs.readFileSync(SOURCE, 'utf8'), /xkbcommon\/xkbcommon\.h/);
  const source = fs.readFileSync(SOURCE, 'utf8');
  const handle = source.slice(source.indexOf('handle_type'));
  assert.ok(handle.indexOf('ch > 0xFFFF') >= 0 && handle.indexOf('ch > 0xFFFF') < handle.indexOf('upload_keymap'));
  const keyFn = source.slice(source.indexOf('handle_key'));
  assert.match(source, /KEY_LEFTMETA 125/);
  assert.match(source, /XKB_KEY_Super_L/);
  assert.ok(keyFn.indexOf('key_mod_bit') >= 0);
  assert.ok(keyFn.indexOf('tap(code)') < keyFn.indexOf('send_mods(0)'));
  assert.ok(keyFn.indexOf('wl_display_roundtrip') < keyFn.lastIndexOf('send_mods(0)'));
  const generated = path.join(WORK, 'generated');
  fs.mkdirSync(generated, { recursive: true });
  const header = path.join(generated, 'virtual-keyboard-unstable-v1-client-protocol.h');
  const protocol = path.join(generated, 'virtual-keyboard-unstable-v1-protocol.c');
  const binary = path.join(WORK, 'muse-keyboard');
  execFileSync('wayland-scanner', ['client-header', XML, header], { stdio: 'pipe' });
  execFileSync('wayland-scanner', ['private-code', XML, protocol], { stdio: 'pipe' });
  const flags = execFileSync('pkg-config', ['--cflags', '--libs', 'wayland-client', 'xkbcommon', 'json-glib-1.0'], { encoding: 'utf8' }).trim().split(/\s+/).filter(Boolean);
  execFileSync('cc', ['-std=gnu11', '-O2', '-Wall', '-Wextra', '-Werror', SOURCE, '-o', binary, '-I' + generated, protocol, ...flags], { stdio: 'pipe' });
  fs.chmodSync(binary, 0o755);
  assert.equal(fs.existsSync(binary), true);
});

test('compiled helper reports wayland_unavailable on a missing display and does not use the host compositor', async () => {
  const generated = path.join(WORK, 'generated');
  const binary = path.join(WORK, 'muse-keyboard');
  if (!fs.existsSync(binary)) {
    const header = path.join(generated, 'virtual-keyboard-unstable-v1-client-protocol.h');
    const protocol = path.join(generated, 'virtual-keyboard-unstable-v1-protocol.c');
    fs.mkdirSync(generated, { recursive: true });
    execFileSync('wayland-scanner', ['client-header', XML, header], { stdio: 'pipe' });
    execFileSync('wayland-scanner', ['private-code', XML, protocol], { stdio: 'pipe' });
    const flags = execFileSync('pkg-config', ['--cflags', '--libs', 'wayland-client', 'xkbcommon', 'json-glib-1.0'], { encoding: 'utf8' }).trim().split(/\s+/).filter(Boolean);
    execFileSync('cc', ['-std=gnu11', '-O2', '-Wall', '-Wextra', '-Werror', SOURCE, '-o', binary, '-I' + generated, protocol, ...flags], { stdio: 'pipe' });
  }
  const env = { ...process.env, WAYLAND_DISPLAY: 'muse-keyboard-test-missing', XDG_RUNTIME_DIR: WORK };
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

test('Stop during a pending focus check releases the helper and reports Stop immediately', async t => {
  const f = fixture();t.after(()=>f.keyboard.stop());
  const controller=new AbortController();let entered;
  const checking=new Promise(resolve=>{entered=resolve;});
  f.keyboard.validateFocus=()=>{entered();return new Promise(()=>{});};
  const pending=f.keyboard.type('hello',controller.signal);
  await checking;controller.abort();
  await assert.rejects(pending,/stopped_by_user/);
  assert.equal(f.child.messages.some(message=>message.action==='type'),false);
  assert.equal(f.child.kills[0],'SIGTERM');
});
