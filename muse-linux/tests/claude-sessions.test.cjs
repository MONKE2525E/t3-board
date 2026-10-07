const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { ClaudeSessions, stripAnsi, KEYS, MAX_WRITE, CLAUDE } = require('../src/claude-sessions.cjs');

const EVIDENCE = '/tmp/muse-port-d6c9/parity/claude-sessions';
const REAL = process.env.MUSE_TEST_REAL_CLAUDE === '1';
const PROMPT = 'In this directory only: write muse-ok.txt containing exactly ok and a newline. Then run Bash to write muse-bash.txt containing exactly ok and a newline, for example printf ok\\n > muse-bash.txt after cat muse-ok.txt. Do not use git. Finish after both files exist.';

class FakeTerminals {
  constructor() {
    this.started = [];
    this.writes = [];
    this.closed = [];
    this.outputs = new Map();
    this.running = new Map();
    this.n = 0;
    this.gate = null;
  }
  async start(args, deadline) {
    if (typeof this.gate === 'function') await this.gate(args, deadline);
    if (!Number.isSafeInteger(deadline) || deadline <= Date.now()) throw Error('request_expired');
    const id = `term-${++this.n}`;
    this.started.push({ args, deadline, id });
    this.outputs.set(id, Buffer.alloc(0));
    this.running.set(id, true);
    return { terminal_id: id };
  }
  async write({ terminal_id, text }) {
    if (!this.running.has(terminal_id)) throw Error('unknown_terminal');
    this.writes.push({ terminal_id, text });
    return { ok: true, terminal_id };
  }
  async read({ terminal_id, offset = 0, max_bytes = 65536 }) {
    if (!this.outputs.has(terminal_id)) throw Error('unknown_terminal');
    const buf = this.outputs.get(terminal_id);
    const slice = buf.subarray(offset, offset + max_bytes);
    return {
      output: slice.toString('utf8'),
      cursor: offset + slice.length,
      truncated: false,
      running: this.running.get(terminal_id) === true,
      exit_code: this.running.get(terminal_id) ? null : 0,
      signal: null,
    };
  }
  async close({ terminal_id }) {
    if (!this.outputs.has(terminal_id) && !this.running.has(terminal_id)) throw Error('unknown_terminal');
    this.running.delete(terminal_id);
    this.closed.push(terminal_id);
    return { ok: true, terminal_id };
  }
  list() {
    return [...this.running.entries()].map(([terminal_id, running]) => ({ terminal_id, running }));
  }
  stop() {
    this.running.clear();
  }
  append(id, text) {
    this.outputs.set(id, Buffer.concat([this.outputs.get(id) || Buffer.alloc(0), Buffer.from(text)]));
  }
}

function deadline(ms = 8000) {
  return Date.now() + ms;
}

async function makeSessions(t, terminals = new FakeTerminals()) {
  const sessions = new ClaudeSessions({
    terminals,
    resolve: async cwd => ({ target: cwd }),
  });
  sessions.probeInstalled = async () => ({ version: '2.1.284 (Claude Code)', authenticated: true, hasModel: true, hasResume: true });
  t.after(() => sessions.stop());
  return { sessions, terminals };
}

test('stripAnsi keeps CSI text that is followed by an OSC window title BEL', () => {
  const raw = '\x1b[32mVISIBLE\x1b[0m\x1b]0;secret-title\x07OK';
  assert.equal(stripAnsi(raw), 'VISIBLEOK');
  assert.match(raw, /\x1b\[32m/);
  assert.match(raw, /\x1b\]0;secret-title\x07/);
});

test('start builds prompt/model/resume argv only, never skip-permissions, and hides prompt from the result', async t => {
  const cwd = path.join(EVIDENCE, 'unit-cwd');
  await fs.mkdir(cwd, { recursive: true });
  const { sessions, terminals } = await makeSessions(t);
  const started = await sessions.start({ cwd, model: 'haiku', resume: 'abc123', prompt: PROMPT, cols: 100, rows: 30 }, deadline());
  assert.equal(typeof started.session_id, 'string');
  assert.equal(started.session_id.includes('-'), true);
  assert.equal(Object.hasOwn(started, 'argv'), false);
  assert.equal(Object.hasOwn(started, 'prompt'), false);
  assert.match(started.read_hint, /ANSI stripped/);
  const argv = JSON.parse(terminals.started[0].args.argv);
  assert.deepEqual(argv.slice(0, 5), [CLAUDE, '--model', 'haiku', '--resume', 'abc123']);
  assert.equal(argv[5], '--');
  assert.equal(argv[6], PROMPT);
  assert.equal(argv.includes('--dangerously-skip-permissions'), false);
  assert.equal(argv.includes('--allow-dangerously-skip-permissions'), false);
  assert.equal(argv.includes('--print'), false);
  assert.equal(argv.includes('-p'), false);
  assert.equal(argv.includes('--continue'), false);
  assert.notEqual(started.session_id, terminals.started[0].id);
});

test('start rejects raw argv, skip-permissions smuggled in model/resume, and bare continue', async t => {
  const { sessions } = await makeSessions(t);
  const cwd = '/tmp/muse-port-d6c9/parity/claude-sessions/unit-cwd';
  await assert.rejects(sessions.start({ cwd, argv: JSON.stringify(['claude', '--dangerously-skip-permissions']) }, deadline()), /unexpected_argv/);
  await assert.rejects(sessions.start({ cwd, model: '--dangerously-skip-permissions' }, deadline()), /invalid_model|forbidden_option/);
  await assert.rejects(sessions.start({ cwd, resume: '--dangerously-skip-permissions' }, deadline()), /invalid_resume|forbidden_option/);
  await assert.rejects(sessions.start({ cwd, resume: '../other-project' }, deadline()), /invalid_resume/);
});

test('send, read, interrupt and close use owned session ids and pass terminal_id internally', async t => {
  const cwd = '/tmp/muse-port-d6c9/parity/claude-sessions/unit-cwd';
  const { sessions, terminals } = await makeSessions(t);
  const { session_id } = await sessions.start({ cwd, prompt: 'hi' }, deadline());
  const terminal_id = terminals.started[0].id;
  terminals.append(terminal_id, '\x1b[31mAsk\x1b[0m to edit\n');
  const chunk = await sessions.read({ session_id, offset: 0 });
  assert.equal(chunk.output.includes('\x1b[31m'), true);
  assert.equal(chunk.raw, chunk.output);
  assert.equal(chunk.text, 'Ask to edit\n');
  assert.equal(chunk.cursor, Buffer.byteLength(chunk.output));
  assert.equal(chunk.running, true);
  assert.equal(Object.hasOwn(chunk, 'truncated'), true);
  await sessions.send({ session_id, text: KEYS.enter });
  await sessions.interrupt({ session_id });
  assert.equal(terminals.writes[0].terminal_id, terminal_id);
  assert.equal(terminals.writes[0].text, '\r');
  assert.equal(terminals.writes[1].text, KEYS.interrupt);
  const listed = sessions.list();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].session_id, session_id);
  assert.equal(listed[0].running, true);
  assert.equal(Object.hasOwn(listed[0], 'terminal_id'), false);
  await sessions.close({ session_id });
  assert.deepEqual(terminals.closed, [terminal_id]);
  assert.equal(sessions.list().length, 0);
  await assert.rejects(sessions.send({ session_id, text: 'x' }), /unknown_session/);
});

test('list reports running false and prunes when the terminal row is gone', async t => {
  const cwd = '/tmp/muse-port-d6c9/parity/claude-sessions/unit-cwd';
  const { sessions, terminals } = await makeSessions(t);
  const { session_id } = await sessions.start({ cwd }, deadline());
  terminals.stop();
  const rows = sessions.list();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].session_id, session_id);
  assert.equal(rows[0].running, false);
  assert.equal(sessions.list().length, 0);
});

test('stop swallows close rejections after terminals.stop and invalidates in-flight start', async t => {
  const cwd = '/tmp/muse-port-d6c9/parity/claude-sessions/unit-cwd';
  const terminals = new FakeTerminals();
  const { sessions } = await makeSessions(t, terminals);
  const { session_id } = await sessions.start({ cwd }, deadline());
  const originalClose = terminals.close.bind(terminals);
  terminals.close = async () => {
    terminals.running.clear();
    throw Error('unknown_terminal');
  };
  const rejections = [];
  const onReject = err => rejections.push(err);
  process.on('unhandledRejection', onReject);
  t.after(() => process.off('unhandledRejection', onReject));
  sessions.stop();
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(rejections.length, 0);
  await assert.rejects(sessions.send({ session_id, text: 'x' }), /unknown_session/);

  terminals.close = originalClose;
  let releaseProbe;
  sessions.probeInstalled = () => new Promise(resolve => { releaseProbe = resolve; });
  const pending = sessions.start({ cwd }, deadline());
  sessions.stop();
  releaseProbe({ version: '2.1.284 (Claude Code)', authenticated: true, hasModel: true, hasResume: true });
  await assert.rejects(pending, /stopped/);
  assert.equal(terminals.started.length, 1);

  sessions.probeInstalled = async () => ({ version: '2.1.284 (Claude Code)', authenticated: true, hasModel: true, hasResume: true });
  let releaseStart;
  let blocked = false;
  terminals.gate = () => new Promise(resolve => { blocked = true; releaseStart = resolve; });
  const late = sessions.start({ cwd }, deadline());
  const waitStart = Date.now();
  while (!blocked && Date.now() - waitStart < 2000) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(blocked, true);
  sessions.stop();
  releaseStart();
  await assert.rejects(late, /stopped/);
  assert.equal(terminals.closed.includes('term-2'), true);
  assert.equal(sessions.list().length, 0);
});

test('send rejects oversized writes and missing text', async t => {
  const cwd = '/tmp/muse-port-d6c9/parity/claude-sessions/unit-cwd';
  const { sessions } = await makeSessions(t);
  const { session_id } = await sessions.start({ cwd }, deadline());
  await assert.rejects(sessions.send({ session_id, text: '' }), /text_required/);
  await assert.rejects(sessions.send({ session_id, text: 'a'.repeat(MAX_WRITE + 1) }), /text_too_large/);
});

test('installed Claude CLI reports version and boolean auth without private identifiers', async t => {
  if (!REAL) {
    t.skip('set MUSE_TEST_REAL_CLAUDE=1 to probe the installed CLI');
    return;
  }
  const sessions = new ClaudeSessions({
    terminals: new FakeTerminals(),
    resolve: async cwd => ({ target: cwd }),
  });
  const probe = await sessions.probeInstalled();
  assert.equal(typeof probe.version, 'string');
  assert.match(probe.version, /Claude Code/);
  assert.equal(typeof probe.authenticated, 'boolean');
  assert.equal(Object.hasOwn(probe, 'account'), false);
  assert.equal(Object.hasOwn(probe, 'email'), false);
  assert.equal(Object.hasOwn(probe, 'user'), false);
  assert.equal(Object.hasOwn(probe, 'organization'), false);
  const dump = JSON.stringify(probe);
  assert.equal(/@/.test(dump), false);
  await fs.mkdir(EVIDENCE, { recursive: true });
  await fs.writeFile(path.join(EVIDENCE, 'probe.json'), JSON.stringify({
    installed: true,
    authenticated: probe.authenticated,
    version: probe.version,
    hasModel: probe.hasModel,
    hasResume: probe.hasResume,
  }, null, 2));
});

async function writeRealBooleans(values) {
  await fs.mkdir(EVIDENCE, { recursive: true });
  await fs.unlink(path.join(EVIDENCE, 'real-session-text.txt')).catch(() => {});
  await fs.writeFile(path.join(EVIDENCE, 'real-session.json'), JSON.stringify({
    opt_in: Boolean(REAL),
    launched: false,
    trusted: false,
    edit_ok: false,
    bash_ok: false,
    usage_limited: false,
    retries: 0,
    ...values,
  }));
}

test('real Claude Code session edits a file and completes a Bash marker in an owned fixture PTY', { timeout: 180000 }, async t => {
  if (!REAL) {
    await writeRealBooleans({ opt_in: false });
    t.skip('set MUSE_TEST_REAL_CLAUDE=1 to launch the installed Claude CLI');
    return;
  }
  let Terminals;
  try { ({ Terminals } = require('../src/terminals.cjs')); } catch {
    await writeRealBooleans({ launched: false });
    t.skip('terminals.cjs is not available yet');
    return;
  }
  const helper = path.join(__dirname, '../native/bin/muse-terminal');
  try { await fs.access(helper); } catch {
    await writeRealBooleans({ launched: false });
    t.skip('muse-terminal helper is not built yet');
    return;
  }
  const fixture = await fs.mkdtemp(path.join(EVIDENCE, 'fixture-'));
  t.after(() => fs.rm(fixture, { recursive: true, force: true }));
  const terminals = new Terminals({
    permission: async () => true,
    resolve: async cwd => ({ target: cwd || fixture }),
    nativeDirectory: path.join(__dirname, '../native/bin'),
  });
  const sessions = new ClaudeSessions({
    terminals,
    resolve: async cwd => ({ target: cwd || fixture }),
  });
  t.after(() => {
    sessions.stop();
    try { terminals.stop(); } catch { /* terminal agent still fixing Stop */ }
  });

  const probe = await sessions.probeInstalled();
  if (!probe.authenticated) {
    await writeRealBooleans({ launched: false });
    t.skip('Claude CLI is installed but not logged in');
    return;
  }

  const started = await sessions.start({
    cwd: fixture,
    model: 'haiku',
    prompt: PROMPT,
    cols: 120,
    rows: 40,
  }, Date.now() + 120000);
  assert.equal(typeof started.session_id, 'string');
  assert.equal(Object.hasOwn(started, 'argv'), false);

  let cursor = 0;
  let recent = '';
  let enters = 0;
  let trusted = false;
  let usageLimited = false;
  const edited = path.join(fixture, 'muse-ok.txt');
  const bashMarker = path.join(fixture, 'muse-bash.txt');
  const until = Date.now() + 150000;

  async function marker(file) {
    try { return /^ok\s*$/.test(await fs.readFile(file, 'utf8')); } catch { return false; }
  }

  while (Date.now() < until) {
    const edit_ok = await marker(edited);
    const bash_ok = await marker(bashMarker);
    if (edit_ok && bash_ok) break;
    const chunk = await sessions.read({ session_id: started.session_id, offset: cursor, max_bytes: 65536 });
    cursor = chunk.cursor;
    recent = (recent + chunk.text).slice(-8000);
    const screen = recent.toLowerCase();
    if (/session limit|usage limit reached/.test(screen)) {
      usageLimited = true;
      break;
    }
    if (!trusted && /no,\s*exit/.test(screen) && /trust\s*this\s*folder/.test(screen)) {
      await sessions.send({ session_id: started.session_id, text: KEYS.down });
      await new Promise(resolve => setTimeout(resolve, 300));
      await sessions.send({ session_id: started.session_id, text: KEYS.enter });
      trusted = true;
      enters += 1;
    } else if (trusted && !usageLimited && enters < 12 && /do\s*you\s*want|allow\s*this|permission\s*to/.test(chunk.text.toLowerCase())) {
      await sessions.send({ session_id: started.session_id, text: KEYS.enter });
      enters += 1;
    }
    if (chunk.running === false) break;
    await new Promise(resolve => setTimeout(resolve, 400));
  }

  const edit_ok = await marker(edited);
  const bash_ok = await marker(bashMarker);
  await writeRealBooleans({
    launched: true,
    trusted,
    edit_ok,
    bash_ok,
    usage_limited: usageLimited,
    retries: 0,
  });
  await sessions.close({ session_id: started.session_id }).catch(() => {});
  if (usageLimited) {
    t.skip('Claude CLI session usage limit; not retrying; edit_ok/bash_ok remain false');
    return;
  }
  assert.equal(edit_ok, true);
  assert.equal(bash_ok, true);
});
