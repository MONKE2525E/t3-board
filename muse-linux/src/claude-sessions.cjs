const { execFile, spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const path = require('node:path');
const { promisify } = require('node:util');
const run = promisify(execFile);

const CLAUDE = 'claude';
const MAX_PROMPT = 32000;
const MAX_WRITE = 128 * 1024;
const MAX_MODEL = 200;
const MAX_RESUME = 200;
const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 40;
const MIN_COLS = 20;
const MAX_COLS = 400;
const MIN_ROWS = 8;
const MAX_ROWS = 200;
const DEFAULT_READ = 65536;
const MAX_READ = 256 * 1024;
const FORBIDDEN = /dangerously-skip-permissions|allow-dangerously-skip-permissions|bypassPermissions/i;
const MODEL_OK = /^[A-Za-z0-9][A-Za-z0-9._:+-]{0,199}$/;
const RESUME_OK = /^[A-Za-z0-9][A-Za-z0-9 .,_:-]{0,199}$/;

const KEYS = {
  enter: '\r',
  newline: '\n',
  interrupt: '\x03',
  eof: '\x04',
  escape: '\x1b',
  up: '\x1b[A',
  down: '\x1b[B',
  shiftTab: '\x1b[Z',
};

function stripAnsi(value) {
  if (typeof value !== 'string') {
    if (Buffer.isBuffer(value)) value = value.toString('utf8');
    else value = String(value ?? '');
  }
  return value
    .replace(/\u001b\][\s\S]*?(?:\u0007|\u001b\\)/g, '')
    .replace(/\u009d[\s\S]*?(?:\u0007|\u009c)/g, '')
    .replace(/\u001b[P^_][\s\S]*?(?:\u001b\\|\u009c)/g, '')
    .replace(/\u001b\[[\?0-9;:=]*[ -/]*[@-~]/g, '')
    .replace(/\u009b[\?0-9;:=]*[ -/]*[@-~]/g, '')
    .replace(/\u001b[()][0-9A-B]/g, '')
    .replace(/\u001b[=>]/g, '')
    .replace(/\u001b./g, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001a\u001c-\u001f\u007f]/g, '');
}

function dueTime(deadline, args) {
  const due = Number.isSafeInteger(deadline) ? deadline : args?.__deadline;
  if (!Number.isSafeInteger(due) || due <= Date.now()) throw Error('request_expired');
  return due;
}

function size(value, fallback, min, max, label) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw Error(`invalid_${label}`);
  return n;
}

function terminalId(result) {
  if (typeof result === 'string' && result) return result;
  if (result && typeof result.terminal_id === 'string' && result.terminal_id) return result.terminal_id;
  if (result && typeof result.id === 'string' && result.id) return result.id;
  throw Error('terminal_start_failed');
}

function asText(value) {
  if (typeof value === 'string') return value;
  if (Buffer.isBuffer(value)) return value.toString('utf8');
  if (value == null) return '';
  return String(value);
}

function rejectForbidden(value, label) {
  if (typeof value === 'string' && FORBIDDEN.test(value)) throw Error(`forbidden_option: ${label}`);
}

class ClaudeSessions {
  constructor({ terminals, resolve }) {
    if (!terminals || typeof terminals.start !== 'function') throw Error('terminals_required');
    if (typeof resolve !== 'function') throw Error('resolve_required');
    this.terminals = terminals;
    this.resolve = resolve;
    this.sessions = new Map();
    this.generation = 0;
  }

  assertLive(generation) {
    if (generation !== this.generation) throw Error('stopped');
  }

  abandon(terminal_id) {
    try {
      const result = this.terminals.close({ terminal_id });
      if (result && typeof result.then === 'function') void result.catch(() => {});
    } catch { /* already closed by terminals.stop */ }
  }

  async probeInstalled() {
    if (this._probe && Date.now() - this._probe.at < 15000) return this._probe;
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    let version;
    try {
      const { stdout, stderr } = await run(CLAUDE, ['--version'], { timeout: 4000, maxBuffer: 4096, env });
      version = stripAnsi(String(stdout || stderr)).trim().split(/\n/)[0].slice(0, 80);
      if (!version) throw Error('claude_not_installed');
    } catch {
      throw Error('claude_not_installed');
    }
    const authenticated = await new Promise(resolve => {
      const child = spawn(CLAUDE, ['auth', 'status'], { stdio: 'ignore', env, timeout: 5000 });
      child.once('error', () => resolve(false));
      child.once('exit', code => resolve(code === 0));
    });
    let hasModel = true;
    let hasResume = true;
    try {
      const { stdout, stderr } = await run(CLAUDE, ['--help'], { timeout: 5000, maxBuffer: 96 * 1024, env });
      const help = `${stdout}\n${stderr}`;
      hasModel = /\s--model\b/.test(help);
      hasResume = /\s--resume\b/.test(help);
    } catch { /* keep defaults from the local CLI already inspected during development */ }
    this._probe = { version, authenticated, hasModel, hasResume, at: Date.now() };
    return this._probe;
  }

  buildArgv(args, flags) {
    if (args && Object.hasOwn(args, 'argv')) throw Error('unexpected_argv: claude.start accepts prompt, model, and resume only');
    const argv = [CLAUDE];
    if (args?.model !== undefined && args.model !== null && args.model !== '') {
      if (typeof args.model !== 'string' || args.model.length > MAX_MODEL || !MODEL_OK.test(args.model)) throw Error('invalid_model');
      rejectForbidden(args.model, 'model');
      if (!flags.hasModel) throw Error('model_unsupported');
      argv.push('--model', args.model);
    }
    if (args?.resume !== undefined && args.resume !== null && args.resume !== '') {
      if (typeof args.resume !== 'string' || args.resume.length > MAX_RESUME || !RESUME_OK.test(args.resume) || args.resume.startsWith('-')) throw Error('invalid_resume');
      rejectForbidden(args.resume, 'resume');
      if (!flags.hasResume) throw Error('resume_unsupported');
      argv.push('--resume', args.resume);
    }
    if (args?.prompt !== undefined && args.prompt !== null && args.prompt !== '') {
      if (typeof args.prompt !== 'string' || args.prompt.includes('\0') || args.prompt.length > MAX_PROMPT) throw Error('invalid_prompt');
      argv.push('--', args.prompt);
    }
    const flagsOnly = argv.includes('--') ? argv.slice(0, argv.indexOf('--')) : argv;
    if (flagsOnly.some(part => FORBIDDEN.test(part) || part === '-p' || part === '--print' || part === '--continue' || part === '-c')) {
      throw Error('forbidden_option');
    }
    return argv;
  }

  async start(args = {}, deadline) {
    const generation = this.generation;
    const due = dueTime(deadline, args);
    const probe = await this.probeInstalled();
    this.assertLive(generation);
    if (Date.now() >= due) throw Error('request_expired');
    if (!probe.authenticated) throw Error('claude_not_authenticated: sign in with the Claude CLI in a user terminal; Muse does not log in');
    const argv = this.buildArgv(args, probe);
    const resolved = await this.resolve(args.cwd);
    this.assertLive(generation);
    const cwd = resolved?.target;
    if (typeof cwd !== 'string' || !path.isAbsolute(cwd) || cwd.includes('\0')) throw Error('invalid_cwd');
    const cols = size(args.cols, DEFAULT_COLS, MIN_COLS, MAX_COLS, 'cols');
    const rows = size(args.rows, DEFAULT_ROWS, MIN_ROWS, MAX_ROWS, 'rows');
    if (Date.now() >= due) throw Error('request_expired');
    const started = await this.terminals.start({ argv: JSON.stringify(argv), cwd, cols, rows }, due);
    const terminal_id = terminalId(started);
    if (generation !== this.generation) {
      this.abandon(terminal_id);
      throw Error('stopped');
    }
    const session_id = randomUUID();
    this.sessions.set(session_id, { session_id, terminal_id, cwd });
    return {
      session_id,
      read_hint: 'claude.read returns output/raw (ANSI PTY bytes as text) and text (ANSI stripped). cursor is the absolute byte offset for the next read. Send permission answers as literal keys after reading the prompt: Enter=\\r, Up=\\x1b[A, Down=\\x1b[B, Shift+Tab=\\x1b[Z. interrupt sends Ctrl+C. Never skip permissions.',
    };
  }

  owned(args) {
    const id = args?.session_id;
    if (typeof id !== 'string' || !id) throw Error('session_id_required');
    const session = this.sessions.get(id);
    if (!session) throw Error('unknown_session');
    return session;
  }

  async send(args = {}) {
    const session = this.owned(args);
    if (typeof args.text !== 'string' || args.text.includes('\0')) throw Error('text_required');
    if (!args.text.length) throw Error('text_required');
    if (Buffer.byteLength(args.text, 'utf8') > MAX_WRITE) throw Error('text_too_large');
    await this.terminals.write({ terminal_id: session.terminal_id, text: args.text });
    return { ok: true, session_id: session.session_id };
  }

  async read(args = {}) {
    const session = this.owned(args);
    const offset = args.offset === undefined || args.offset === null || args.offset === '' ? 0 : Number(args.offset);
    if (!Number.isSafeInteger(offset) || offset < 0) throw Error('invalid_offset');
    let max_bytes = args.max_bytes === undefined || args.max_bytes === null || args.max_bytes === '' ? DEFAULT_READ : Number(args.max_bytes);
    if (!Number.isSafeInteger(max_bytes) || max_bytes < 1) throw Error('invalid_max_bytes');
    max_bytes = Math.min(max_bytes, MAX_READ);
    const result = await this.terminals.read({ terminal_id: session.terminal_id, offset, max_bytes });
    const raw = asText(result?.output);
    const cursor = Number.isSafeInteger(result?.cursor) ? result.cursor : offset + Buffer.byteLength(raw, 'utf8');
    return {
      session_id: session.session_id,
      output: raw,
      raw,
      text: stripAnsi(raw),
      cursor,
      truncated: Boolean(result?.truncated),
      running: result?.running !== false,
      exit_code: result?.exit_code ?? null,
      signal: result?.signal ?? null,
    };
  }

  async interrupt(args = {}) {
    const session = this.owned(args);
    await this.terminals.write({ terminal_id: session.terminal_id, text: KEYS.interrupt });
    return { ok: true, session_id: session.session_id };
  }

  async close(args = {}) {
    const session = this.owned(args);
    this.sessions.delete(session.session_id);
    try { await this.terminals.close({ terminal_id: session.terminal_id }); } catch { /* already gone after terminals.stop */ }
    return { ok: true, session_id: session.session_id };
  }

  list() {
    const listed = typeof this.terminals.list === 'function' ? this.terminals.list() : [];
    const byId = new Map((Array.isArray(listed) ? listed : []).map(item => [item.terminal_id || item.id, item]));
    const rows = [];
    for (const session of [...this.sessions.values()]) {
      const row = byId.get(session.terminal_id);
      if (!row) {
        this.sessions.delete(session.session_id);
        rows.push({ session_id: session.session_id, running: false, cwd: session.cwd });
        continue;
      }
      rows.push({
        session_id: session.session_id,
        running: row.running !== false,
        cwd: session.cwd,
      });
    }
    return rows;
  }

  stop() {
    this.generation += 1;
    const closing = [...this.sessions.values()];
    this.sessions.clear();
    for (const session of closing) this.abandon(session.terminal_id);
  }
}

module.exports = { ClaudeSessions, stripAnsi, KEYS, MAX_WRITE, CLAUDE };
