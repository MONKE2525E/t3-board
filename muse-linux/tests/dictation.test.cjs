const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { createReadStream, writeFileSync } = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough, Readable } = require('node:stream');
const childProcess = require('node:child_process');
const { Dictation, modelHash } = require('../src/dictation.cjs');

const MODEL = '/tmp/muse-port-d6c9/parity/ggml-tiny.bin';
const JFK = '/tmp/muse-port-d6c9/parity/whisper-src/samples/jfk.wav';
const WHISPER = path.join(__dirname, '../native/bin/whisper-cli');
const WORK = '/tmp/muse-port-d6c9/parity/dictation';
const MODEL_SIZE = 77691713;

const FAST_ENGINE = path.join(WORK, 'fast-engine.cjs');
const SLOW_ENGINE = path.join(WORK, 'slow-engine.cjs');

function leftovers(names) {
  return names.filter(name => /^recording-.*\.wav$/.test(name) || name.startsWith('transcript-') || name.endsWith('.download'));
}

async function listed(directory) {
  return leftovers(await fs.readdir(directory));
}

async function waitUntil(check, timeout = 1000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 15));
  }
  throw Error('timed out');
}

function emitStop(child, signal, code = 0) {
  if (child.stopped) return;
  child.stopped = true;
  if (signal) {
    child.signalCode = signal;
    child.exitCode = null;
    child.emit('exit', 0, signal);
    child.emit('close', 0, signal);
    return;
  }
  child.exitCode = code;
  child.signalCode = null;
  child.emit('exit', code, null);
  child.emit('close', code, null);
}

function fakeRecorder(options = {}) {
  const child = new EventEmitter();
  child.stderr = new PassThrough();
  child.pid = options.enoent ? undefined : 41000 + Math.floor(Math.random() * 10000);
  child.killed = false;
  child.exitCode = null;
  child.signalCode = null;
  child.stopped = false;
  child.signals = [];
  child.kill = (signal = 'SIGTERM') => {
    child.signals.push(signal);
    child.killed = true;
    if (options.hold && signal !== 'SIGKILL') return true;
    queueMicrotask(() => emitStop(child, signal));
    return true;
  };
  child.release = (signal = child.signals.at(-1) || 'SIGINT') => emitStop(child, signal);
  queueMicrotask(() => {
    if (options.enoent) {
      child.emit('error', Object.assign(Error('spawn pw-record ENOENT'), { code: 'ENOENT' }));
      child.emit('close', -2, null);
      return;
    }
    child.emit('spawn');
    if (options.exitAfter != null) setTimeout(() => emitStop(child, null, options.exitCode ?? 1), options.exitAfter);
  });
  return child;
}

function mockSpawn(factory) {
  childProcess.spawn.mock.mockImplementation((cmd, args, opts) => {
    assert.equal(cmd, 'pw-record');
    assert.deepEqual(args.slice(0, 3), ['--format=s16', '--rate=16000', '--channels=1']);
    return factory(args.at(-1), opts);
  });
}

async function session(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(WORK, 'case-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  if (options.model === 'link') await fs.symlink(MODEL, path.join(directory, 'ggml-tiny.bin'));
  if (options.model === 'wrong-size') await fs.writeFile(path.join(directory, 'ggml-tiny.bin'), 'not-a-model');
  const inserted = [];
  let enabled = options.enabled ?? true;
  const dictation = new Dictation({
    directory,
    engine: options.engine || FAST_ENGINE,
    enabled: () => enabled,
    language: () => options.language || 'en',
    insert: async text => { inserted.push(text); }
  });
  t.after(() => dictation.cancel());
  if (options.init) await dictation.initialize();
  if (options.ready) dictation.state.ready = true;
  return { directory, dictation, inserted, setEnabled: value => { enabled = value; } };
}

describe('dictation', { concurrency: 1 }, () => {
  test.before(async () => {
    await fs.mkdir(WORK, { recursive: true, mode: 0o700 });
    await fs.writeFile(FAST_ENGINE, `#!/usr/bin/env node
const fs = require('fs');
const input = process.argv[process.argv.indexOf('-f') + 1];
const prefix = process.argv[process.argv.indexOf('-of') + 1];
let text = 'hello from dictation';
try { text = fs.readFileSync(input + '.txt', 'utf8'); } catch {}
fs.writeFileSync(prefix + '.txt', text);
`);
    await fs.writeFile(SLOW_ENGINE, `#!/usr/bin/env node
const fs = require('fs');
const input = process.argv[process.argv.indexOf('-f') + 1];
const prefix = process.argv[process.argv.indexOf('-of') + 1];
const meta = JSON.parse(fs.readFileSync(input + '.meta', 'utf8'));
fs.writeFileSync(input + '.started', '1');
const timer = setTimeout(() => {
  fs.writeFileSync(prefix + '.txt', meta.text);
  process.exit(0);
}, meta.delay);
const stop = () => { clearTimeout(timer); process.exit(1); };
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
`);
    await fs.chmod(FAST_ENGINE, 0o755);
    await fs.chmod(SLOW_ENGINE, 0o755);
  });

  test.beforeEach(t => {
    t.mock.method(childProcess, 'spawn', () => {
      throw Object.assign(Error('refusing to open the microphone'), { code: 'ENOENT' });
    });
  });

  test('initialize verifies the pinned model and rejects a wrong-sized file', async t => {
    const missing = await session(t, { init: true });
    assert.equal(missing.dictation.state.ready, false);
    const valid = await session(t, { model: 'link', init: true });
    assert.equal(valid.dictation.state.ready, true);
    const wrong = await session(t, { model: 'wrong-size', init: true });
    assert.equal(wrong.dictation.state.ready, false);
    assert.equal(modelHash, 'be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21');
  });

  test('start rejects disabled, missing model, and overlapping sessions', async t => {
    const disabled = await session(t, { ready: true, enabled: false });
    await assert.rejects(() => disabled.dictation.start(), /dictation_disabled/);
    const unready = await session(t);
    await assert.rejects(() => unready.dictation.start(), /speech_model_required/);
    const { dictation } = await session(t, { ready: true });
    mockSpawn(() => fakeRecorder({ hold: true }));
    await dictation.start();
    await assert.rejects(() => dictation.start(), /dictation_busy/);
  });

  test('missing pw-record is a clear recording error and leaves no wav behind', async t => {
    const { directory, dictation } = await session(t, { ready: true });
    mockSpawn(() => fakeRecorder({ enoent: true }));
    await assert.rejects(() => dictation.start(), /Microphone recording is unavailable/);
    assert.equal(dictation.state.status, 'idle');
    assert.equal(dictation.state.error, 'Microphone recording is unavailable');
    assert.deepEqual(await listed(directory), []);
  });

  test('a recorder that dies on its own reports a clear recording failure', async t => {
    const { dictation } = await session(t, { ready: true });
    mockSpawn(() => fakeRecorder({ exitAfter: 20, exitCode: 1 }));
    await dictation.start();
    await waitUntil(() => dictation.state.status === 'idle' && dictation.state.error);
    assert.equal(dictation.state.error, 'Microphone recording failed');
  });

  test('finish inserts speech and reports no speech when the engine returns a blank marker', async t => {
    const spoken = await session(t, { ready: true });
    mockSpawn(() => fakeRecorder());
    await spoken.dictation.start();
    await spoken.dictation.finish();
    assert.deepEqual(spoken.inserted, ['hello from dictation']);
    assert.equal(spoken.dictation.state.status, 'idle');
    assert.equal(spoken.dictation.state.error, null);
    assert.deepEqual(await listed(spoken.directory), []);

    const silent = await session(t, { ready: true });
    mockSpawn((file) => {
      writeFileSync(file + '.txt', '[BLANK_AUDIO]');
      return fakeRecorder();
    });
    await silent.dictation.start();
    await assert.rejects(() => silent.dictation.finish(), /No speech detected/);
    assert.deepEqual(silent.inserted, []);
    assert.equal(silent.dictation.state.error, 'No speech detected');
    assert.deepEqual(await listed(silent.directory), []);
  });

  test('finish of a cancelled recording does not drop a newer recorder', async t => {
    const { dictation } = await session(t, { ready: true });
    const children = [];
    mockSpawn(() => {
      const child = fakeRecorder({ hold: true });
      children.push(child);
      return child;
    });
    await dictation.start();
    const first = children[0];
    const finishing = dictation.finish();
    assert.equal(dictation.state.status, 'transcribing');
    dictation.cancel();
    await dictation.start();
    assert.equal(children.length, 2);
    const second = children[1];
    first.release('SIGINT');
    await finishing;
    assert.equal(dictation.state.status, 'listening');
    assert.deepEqual(second.signals, []);
    dictation.cancel();
    assert.ok(second.signals.includes('SIGINT') || second.signals.includes('SIGKILL'));
  });

  test('cancel still aborts the latest transcription after an earlier job finishes', async t => {
    const { directory, dictation } = await session(t, { ready: true, engine: SLOW_ENGINE });
    const firstFile = path.join(directory, 'first.wav');
    const secondFile = path.join(directory, 'second.wav');
    await fs.writeFile(firstFile, 'a');
    await fs.writeFile(firstFile + '.meta', JSON.stringify({ delay: 40, text: 'first' }));
    await fs.writeFile(secondFile, 'b');
    await fs.writeFile(secondFile + '.meta', JSON.stringify({ delay: 4000, text: 'late-should-not-land' }));
    const first = dictation.transcribe(firstFile);
    await waitUntil(async () => { try { await fs.stat(firstFile + '.started'); return true; } catch { return false; } });
    const second = dictation.transcribe(secondFile);
    await waitUntil(async () => { try { await fs.stat(secondFile + '.started'); return true; } catch { return false; } });
    assert.equal(await first, 'first');
    dictation.cancel();
    await assert.rejects(second, error => error.name === 'AbortError' || error.code === 'ABORT_ERR');
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal((await fs.readdir(directory)).some(name => name.startsWith('transcript-')), false);
  });

  test('cancel during transcribe does not insert a late result', async t => {
    const { directory, dictation, inserted } = await session(t, { ready: true, engine: SLOW_ENGINE });
    mockSpawn((file) => {
      writeFileSync(file + '.meta', JSON.stringify({ delay: 400, text: 'late-should-not-land' }));
      return fakeRecorder();
    });
    await dictation.start();
    const finishing = dictation.finish();
    await waitUntil(async () => {
      const names = await fs.readdir(directory);
      return names.some(name => name.endsWith('.started'));
    }, 2000);
    dictation.cancel();
    await finishing;
    assert.deepEqual(inserted, []);
    assert.equal(dictation.state.status, 'idle');
    await waitUntil(async () => (await listed(directory)).length === 0);
  });

  test('a rejected recording after cancel does not become an unhandled rejection', async t => {
    const seen = [];
    const onUnhandled = reason => seen.push(reason);
    process.on('unhandledRejection', onUnhandled);
    t.after(() => process.removeListener('unhandledRejection', onUnhandled));
    const { dictation } = await session(t, { ready: true });
    mockSpawn(() => {
      const child = fakeRecorder();
      child.kill = (signal = 'SIGTERM') => {
        child.signals.push(signal);
        child.killed = true;
        queueMicrotask(() => emitStop(child, null, 1));
        return true;
      };
      return child;
    });
    await dictation.start();
    dictation.cancel();
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(seen.length, 0);
    assert.equal(dictation.state.status, 'idle');
  });

  test('cancel SIGKILLs a recorder that ignores SIGINT', async t => {
    const { directory, dictation } = await session(t, { ready: true });
    childProcess.spawn.mock.restore();
    const originalSpawn = childProcess.spawn.bind(childProcess);
    const ready = path.join(directory, 'recorder-ready');
    let child;
    t.mock.method(childProcess, 'spawn', (cmd, _args, opts) => {
      assert.equal(cmd, 'pw-record');
      child = originalSpawn(process.execPath, ['-e', `
        const fs = require('fs');
        process.on('SIGINT', () => {});
        process.on('SIGTERM', () => {});
        fs.writeFileSync(${JSON.stringify(ready)}, '1');
        setInterval(() => {}, 1000);
      `], opts);
      return child;
    });
    await dictation.start();
    await waitUntil(async () => { try { await fs.stat(ready); return true; } catch { return false; } });
    const started = Date.now();
    dictation.cancel();
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('recorder ignored cancel')), 3500);
      const done = () => { clearTimeout(timer); resolve(); };
      child.once('exit', done);
      child.once('close', done);
    });
    assert.ok(Date.now() - started >= 1400);
  });

  test('drained recorder stderr does not block finish', async t => {
    const { dictation, inserted } = await session(t, { ready: true });
    childProcess.spawn.mock.restore();
    const originalSpawn = childProcess.spawn.bind(childProcess);
    t.mock.method(childProcess, 'spawn', (cmd, _args, opts) => {
      assert.equal(cmd, 'pw-record');
      return originalSpawn(process.execPath, ['-e', `
        process.on('SIGINT', () => {});
        process.stderr.write('x'.repeat(256 * 1024), () => {
          process.removeAllListeners('SIGINT');
          process.on('SIGINT', () => process.exit(0));
        });
        setInterval(() => {}, 1000);
      `], opts);
    });
    await dictation.start();
    await new Promise(resolve => setTimeout(resolve, 150));
    const started = Date.now();
    await dictation.finish();
    assert.ok(Date.now() - started < 800);
    assert.deepEqual(inserted, ['hello from dictation']);
  });

  test('missing speech engine is distinct from a microphone error', async t => {
    const { directory, dictation } = await session(t, { ready: true, engine: path.join(WORK, 'missing-whisper-cli') });
    mockSpawn(() => fakeRecorder());
    await dictation.start();
    await assert.rejects(() => dictation.finish(), /Speech engine is unavailable/);
    assert.equal(dictation.state.error, 'Speech engine is unavailable');
    assert.deepEqual(await listed(directory), []);
  });

  test('prepare verifies the pinned hash and skips a second download of a valid model', async t => {
    const fresh = await session(t);
    t.mock.method(globalThis, 'fetch', async () => ({
      ok: true,
      body: Readable.toWeb(Readable.from([Buffer.from('not-the-model')]))
    }));
    await assert.rejects(() => fresh.dictation.prepare(), /Speech model verification failed/);
    assert.equal(fresh.dictation.state.ready, false);
    assert.deepEqual(await listed(fresh.directory), []);

    const { directory, dictation } = await session(t);
    let fetches = 0;
    t.mock.method(globalThis, 'fetch', async () => {
      fetches++;
      return { ok: true, body: Readable.toWeb(createReadStream(MODEL)) };
    });
    await dictation.prepare();
    assert.equal(dictation.state.ready, true);
    assert.equal(fetches, 1);
    assert.equal((await fs.stat(path.join(directory, 'ggml-tiny.bin'))).size, MODEL_SIZE);
    await dictation.prepare();
    assert.equal(fetches, 1);
  });

  test('prepare rejects overlapping downloads', async t => {
    const { dictation } = await session(t);
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    t.mock.method(globalThis, 'fetch', async () => {
      await gate;
      return { ok: true, body: Readable.toWeb(Readable.from([Buffer.from('x')])) };
    });
    const first = dictation.prepare();
    await waitUntil(() => dictation.state.status === 'downloading');
    await assert.rejects(() => dictation.prepare(), /model_download_in_progress/);
    release();
    await assert.rejects(first, /Speech model verification failed/);
  });

  test('whisper-cli transcribes the public JFK sample with the pinned tiny model', async t => {
    const { dictation } = await session(t, { model: 'link', init: true, engine: WHISPER, language: 'en' });
    assert.equal(dictation.state.ready, true);
    const text = await dictation.transcribe(JFK);
    assert.match(text, /ask not what your country can do for you/i);
    assert.match(text, /ask what you can do for your country/i);
    assert.equal((await fs.readdir(dictation.directory)).some(name => name.startsWith('transcript-')), false);
  });
});
