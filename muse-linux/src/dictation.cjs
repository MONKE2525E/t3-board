const fs = require('node:fs/promises');
const { createReadStream, createWriteStream } = require('node:fs');
const path = require('node:path');
const childProcess = require('node:child_process');
const { promisify } = require('node:util');
const { createHash, randomUUID } = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const { Readable, Transform } = require('node:stream');

const run = promisify(childProcess.execFile);
const modelUrl = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin';
const modelHash = 'be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21';
const MODEL_SIZE = 77691713;
const RECORD_LIMIT_MS = 60000;
const STOP_TIMEOUT_MS = 1500;
const TRANSCRIPT_LIMIT = 16000;

function drain(stream) {
  if (!stream) return;
  stream.on('data', () => {});
  stream.on('error', () => {});
  stream.resume();
}

function recordError(error) {
  if (!error) return Error('Microphone recording failed');
  if (error.code === 'ENOENT') return Object.assign(Error('Microphone recording is unavailable'), { code: 'ENOENT' });
  if (error.message === 'Microphone recording is unavailable' || error.message === 'Microphone recording failed' || error.message === 'No speech detected') return error;
  return Error('Microphone recording failed');
}

function finishError(error) {
  if (!error) return 'Microphone recording failed';
  if (error.message === 'No speech detected' || error.message === 'Microphone recording is unavailable' || error.message === 'Microphone recording failed' || error.message === 'Speech engine is unavailable' || error.message === 'Speech recognition failed') return error.message;
  if (error.code === 'ENOENT') return 'Speech engine is unavailable';
  if (error.name === 'AbortError' || error.code === 'ABORT_ERR') return 'Dictation cancelled';
  return String(error.message || 'Microphone recording failed').slice(0, 200);
}

function waitForSpawn(child) {
  if (child.pid) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onSpawn = () => { child.removeListener('error', onError); resolve(); };
    const onError = error => { child.removeListener('spawn', onSpawn); reject(error); };
    child.once('spawn', onSpawn);
    child.once('error', onError);
  });
}

function watchStop(child, timeout) {
  if (!child || child.exitCode !== null || child.signalCode !== null || child.pid == null) return;
  try { child.kill('SIGINT'); } catch {}
  return setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, timeout);
}

class Dictation {
  constructor({ directory, engine, enabled, language = () => 'auto', insert, onChange = () => {} }) {
    this.directory = directory;
    this.engine = engine;
    this.enabled = enabled;
    this.language = language;
    this.insert = insert;
    this.onChange = onChange;
    this.model = path.join(directory, 'ggml-tiny.bin');
    this.state = { status: 'idle', ready: false, progress: 0, error: null };
    this.generation = 0;
  }

  update(values) {
    Object.assign(this.state, values);
    this.onChange({ ...this.state });
  }

  async matchesHash() {
    const hash = createHash('sha256');
    let size = 0;
    for await (const chunk of createReadStream(this.model)) {
      size += chunk.length;
      if (size > MODEL_SIZE) return false;
      hash.update(chunk);
    }
    return size === MODEL_SIZE && hash.digest('hex') === modelHash;
  }

  async initialize() {
    try {
      const info = await fs.stat(this.model);
      this.update({ ready: info.size === MODEL_SIZE && await this.matchesHash() });
    } catch {}
  }

  async prepare() {
    if (this.state.status === 'downloading') throw Error('model_download_in_progress');
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    try {
      const info = await fs.stat(this.model);
      if (info.size === MODEL_SIZE && await this.matchesHash()) {
        this.update({ status: 'idle', ready: true, progress: 100, error: null });
        return;
      }
    } catch {}
    this.update({ status: 'downloading', progress: 0, error: null });
    const temp = this.model + '.download';
    const hash = createHash('sha256');
    let size = 0;
    try {
      const response = await fetch(modelUrl, { signal: AbortSignal.timeout(180000) });
      if (!response.ok || !response.body) throw Error('Could not download the speech model');
      const meter = new Transform({
        transform: (chunk, _encoding, callback) => {
          size += chunk.length;
          if (size > MODEL_SIZE) return callback(Error('Unexpected model size'));
          hash.update(chunk);
          this.update({ progress: Math.round(size / MODEL_SIZE * 100) });
          callback(null, chunk);
        }
      });
      await pipeline(Readable.fromWeb(response.body), meter, createWriteStream(temp, { mode: 0o600 }));
      if (size !== MODEL_SIZE || hash.digest('hex') !== modelHash) throw Error('Speech model verification failed');
      await fs.rename(temp, this.model);
      this.update({ status: 'idle', ready: true, progress: 100, error: null });
    } catch (error) {
      await fs.unlink(temp).catch(() => {});
      this.update({ status: 'idle', ready: false, progress: 0, error: error.message });
      throw error;
    }
  }

  listen(child) {
    drain(child.stderr);
    let settled = false;
    const recordDone = new Promise((resolve, reject) => {
      const done = (error) => {
        if (settled) return;
        settled = true;
        if (error) reject(error);
        else resolve();
      };
      child.once('error', error => done(recordError(error)));
      child.once('exit', (code, signal) => {
        if (code === 0 || signal === 'SIGINT' || signal === 'SIGTERM' || signal === 'SIGKILL') done();
        else done(Error('Microphone recording failed'));
      });
      child.once('close', (code, signal) => {
        if (settled) return;
        if (code === 0 || signal === 'SIGINT' || signal === 'SIGTERM' || signal === 'SIGKILL') done();
        else done(recordError(Object.assign(Error('Microphone recording failed'), { code: code === -2 ? 'ENOENT' : undefined })));
      });
    });
    void recordDone.catch(() => {});
    return recordDone;
  }

  async start() {
    if (!this.enabled()) throw Error('dictation_disabled');
    if (!this.state.ready) throw Error('speech_model_required');
    if (this.state.status !== 'idle') throw Error('dictation_busy');
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    clearTimeout(this.timer);
    const generation = ++this.generation;
    const recordPath = path.join(this.directory, `recording-${randomUUID()}.wav`);
    const recorder = childProcess.spawn('pw-record', ['--format=s16', '--rate=16000', '--channels=1', recordPath], { stdio: ['ignore', 'ignore', 'pipe'] });
    const recordDone = this.listen(recorder);
    this.recorder = recorder;
    this.recordPath = recordPath;
    this.recordDone = recordDone;
    this.update({ status: 'listening', error: null });
    void recordDone.catch(error => {
      if (generation === this.generation && this.state.status === 'listening') {
        this.update({ status: 'idle', error: finishError(error) });
        void fs.unlink(recordPath).catch(() => {});
        if (this.recorder === recorder) {
          this.recorder = null;
          this.recordPath = null;
          this.recordDone = null;
        }
      }
    });
    try {
      await waitForSpawn(recorder);
    } catch (error) {
      const mapped = recordError(error);
      if (generation === this.generation) {
        this.update({ status: 'idle', error: mapped.message });
        await fs.unlink(recordPath).catch(() => {});
        if (this.recorder === recorder) {
          this.recorder = null;
          this.recordPath = null;
          this.recordDone = null;
        }
      }
      throw mapped;
    }
    if (generation !== this.generation) return;
    this.timer = setTimeout(() => { void this.finish().catch(() => {}); }, RECORD_LIMIT_MS);
  }

  async transcribe(file) {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const prefix = path.join(this.directory, `transcript-${randomUUID()}`);
    const abort = new AbortController();
    this.transcriptionAbort = abort;
    try {
      try {
        await run(this.engine, ['-m', this.model, '-f', file, '-l', this.language(), '-otxt', '-of', prefix, '-nt', '-np', '--no-gpu', '-t', '4'], {
          timeout: 120000,
          maxBuffer: 1024 * 1024,
          signal: abort.signal
        });
      } catch (error) {
        if (error.name === 'AbortError' || error.code === 'ABORT_ERR') throw error;
        if (error.code === 'ENOENT') throw Object.assign(Error('Speech engine is unavailable'), { code: 'ENOENT' });
        throw Error('Speech recognition failed');
      }
      try {
        return (await fs.readFile(prefix + '.txt', 'utf8')).trim().slice(0, TRANSCRIPT_LIMIT);
      } catch (error) {
        if (error.code === 'ENOENT') throw Error('Speech recognition failed');
        throw error;
      }
    } finally {
      await fs.unlink(prefix + '.txt').catch(() => {});
      if (this.transcriptionAbort === abort) this.transcriptionAbort = null;
    }
  }

  async finish() {
    if (this.state.status !== 'listening') return;
    clearTimeout(this.timer);
    this.timer = null;
    const generation = this.generation;
    const record = this.recordPath;
    const recorder = this.recorder;
    const recordDone = this.recordDone;
    this.update({ status: 'transcribing', error: null });
    const killer = watchStop(recorder, STOP_TIMEOUT_MS);
    try {
      try {
        await recordDone;
      } finally {
        clearTimeout(killer);
      }
      if (generation !== this.generation) return;
      const text = await this.transcribe(record);
      if (generation !== this.generation) return;
      if (!this.enabled()) {
        this.update({ status: 'idle', error: null });
        return;
      }
      if (!text || /^\[.*\]$/.test(text)) throw Error('No speech detected');
      await this.insert(text);
      if (generation !== this.generation) return;
      this.update({ status: 'idle', error: null });
    } catch (error) {
      if (generation !== this.generation) return;
      this.update({ status: 'idle', error: finishError(error) });
      throw error;
    } finally {
      clearTimeout(killer);
      await fs.unlink(record).catch(() => {});
      if (this.recorder === recorder) this.recorder = null;
      if (this.recordPath === record) this.recordPath = null;
      if (this.recordDone === recordDone) this.recordDone = null;
    }
  }

  async toggle() {
    if (this.state.status === 'listening') await this.finish();
    else if (this.state.status === 'idle') await this.start();
  }

  cancel() {
    ++this.generation;
    clearTimeout(this.timer);
    this.timer = null;
    this.transcriptionAbort?.abort();
    const recorder = this.recorder;
    const recordDone = this.recordDone;
    const file = this.recordPath;
    const killer = watchStop(recorder, STOP_TIMEOUT_MS);
    this.update({ status: 'idle', error: null });
    const cleanup = async () => {
      clearTimeout(killer);
      if (file) await fs.unlink(file).catch(() => {});
      if (this.recorder === recorder) this.recorder = null;
      if (this.recordPath === file) this.recordPath = null;
      if (this.recordDone === recordDone) this.recordDone = null;
    };
    if (recordDone) void recordDone.catch(() => {}).finally(cleanup);
    else void cleanup();
  }
}

module.exports = { Dictation, modelUrl, modelHash };
