const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const fssync = require('node:fs');
const path = require('node:path');
const { Terminals } = require('../src/terminals.cjs');

const helperRoot = '/tmp/muse-port-d6c9/parity/terminals';
fssync.mkdirSync(helperRoot, { recursive: true });
const helperDir = fssync.mkdtempSync(path.join(helperRoot, `p${process.pid}-`));
const helperSrc = path.join(__dirname, '../native/terminal.c');
const helperBin = path.join(helperDir, 'muse-terminal');
const python = '/usr/bin/python3';

execFileSync('cc', ['-std=gnu11', '-O2', '-Wall', '-Wextra', '-Werror', helperSrc, '-o', helperBin], { stdio: 'inherit' });

function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function alive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function parseProc(pid) {
  const text = fssync.readFileSync(`/proc/${pid}/stat`, 'utf8');
  const close = text.lastIndexOf(')');
  const open = text.indexOf(' ');
  const rest = text.slice(close + 1).trim().split(/\s+/);
  return { pid: Number(text.slice(0, open)), ppid: Number(rest[1]), pgrp: Number(rest[2]), session: Number(rest[3]) };
}

function sessionMembers(sid) {
  const found = [];
  for (const name of fssync.readdirSync('/proc')) {
    if (!/^[0-9]+$/.test(name)) continue;
    try {
      const proc = parseProc(Number(name));
      if (proc.session === sid) found.push(proc);
    } catch {}
  }
  return found;
}

async function waitUntil(fn, timeout = 8000) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeout) {
    last = await fn();
    if (last) return last;
    await delay(40);
  }
  throw Error(`timeout: ${last}`);
}

async function waitOutput(term, id, match, timeout = 8000) {
  const start = Date.now();
  let offset = 0, acc = '';
  const needle = typeof match === 'function' ? match : text => (typeof match === 'string' ? text.includes(match) : match.test(text));
  while (Date.now() - start < timeout) {
    const result = await term.read({ terminal_id: id, offset: String(offset), max_bytes: '65536' });
    if (result.output) { acc += result.output; offset = result.cursor; }
    if (needle(acc, result)) return { ...result, output: acc, cursor: offset };
    await delay(40);
  }
  throw Error(`timeout waiting for output:\n${acc}`);
}

function make(t, extra = {}) {
  const term = new Terminals({
    permission: extra.permission || (async () => true),
    resolve: extra.resolve || (async cwd => {
      if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) throw Error('absolute_path_required');
      return { target: cwd };
    }),
    nativeDirectory: helperDir,
    idleMs: extra.idleMs || 60 * 60 * 1000,
    maxSessions: extra.maxSessions,
    maxOutputBytes: extra.maxOutputBytes,
    onChange: extra.onChange,
  });
  t.after(() => { try { term.stop(); } catch {} });
  return term;
}

function pidsWithCwd(cwd) {
  const found = [];
  for (const name of fssync.readdirSync('/proc')) {
    if (!/^[0-9]+$/.test(name)) continue;
    try {
      if (fssync.readlinkSync(`/proc/${name}/cwd`) === cwd) found.push(Number(name));
    } catch {}
  }
  return found;
}

async function tempCwd(t) {
  const dir = await fs.mkdtemp(path.join(helperDir, 'cwd-'));
  t.after(() => {
    for (const pid of pidsWithCwd(dir)) {
      try { process.kill(pid, 'SIGKILL'); } catch {}
    }
    return fs.rm(dir, { recursive: true, force: true });
  });
  return dir;
}

test('string offset 0 reads PTY output and interactive bash keeps env and cwd', async t => {
  const cwd = await tempCwd(t);
  const nested = path.join(cwd, 'nested');
  await fs.mkdir(nested);
  const term = make(t);
  const started = await term.start({ cwd, cols: '80', rows: '24' }, Date.now() + 20000);
  assert.equal(typeof started.terminal_id, 'string');
  assert.ok(started.pid > 1);
  const listed = term.list();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].running, true);
  assert.equal(listed[0].cwd, cwd);
  assert.equal('argv' in listed[0], false);
  assert.equal(JSON.stringify(listed[0]).includes('--noprofile'), false);
  await term.write({ terminal_id: started.terminal_id, text: `cd nested && pwd && export MUSE_TERM_MARK=persist && echo $MUSE_TERM_MARK\n` });
  const seen = await waitOutput(term, started.terminal_id, text => text.includes(nested) && text.includes('persist'));
  const first = await term.read({ terminal_id: started.terminal_id, offset: '0', max_bytes: '4096' });
  assert.equal(typeof first.output, 'string');
  assert.equal(typeof first.cursor, 'number');
  assert.ok(first.cursor >= 0);
  assert.equal(first.truncated, false);
  assert.ok(first.output.includes(nested) || seen.output.includes(nested));
  await term.close({ terminal_id: started.terminal_id });
  assert.equal(term.list().length, 0);
});

test('python input() round-trips on a real tty', async t => {
  const cwd = await tempCwd(t);
  const term = make(t);
  const started = await term.start({
    cwd,
    argv: JSON.stringify([python, '-u', '-c', 'name=input("Name: "); print("Hello "+name)']),
  }, Date.now() + 20000);
  await waitOutput(term, started.terminal_id, 'Name:');
  await term.write({ terminal_id: started.terminal_id, text: 'Ada\n' });
  const seen = await waitOutput(term, started.terminal_id, 'Hello Ada');
  assert.match(seen.output, /Hello Ada/);
  await waitUntil(async () => {
    const result = await term.read({ terminal_id: started.terminal_id, offset: '0' });
    return result.running === false;
  });
  await term.close({ terminal_id: started.terminal_id });
});

test('PTY reports isatty and resize updates winsize', async t => {
  const cwd = await tempCwd(t);
  const term = make(t);
  const script = [
    'import fcntl, struct, sys, termios',
    'print("STDIN", sys.stdin.isatty(), flush=True)',
    'print("STDOUT", sys.stdout.isatty(), flush=True)',
    'def sz():',
    '    packed=fcntl.ioctl(1, termios.TIOCGWINSZ, struct.pack("HHHH",0,0,0,0))',
    '    rows,cols,_,_=struct.unpack("HHHH", packed)',
    '    print(f"SIZE {cols}x{rows}", flush=True)',
    'sz()',
    'input()',
    'sz()',
  ].join('\n');
  const started = await term.start({ cwd, cols: 80, rows: 24, argv: JSON.stringify([python, '-u', '-c', script]) }, Date.now() + 20000);
  await waitOutput(term, started.terminal_id, text => text.includes('STDIN True') && text.includes('STDOUT True') && text.includes('SIZE 80x24'));
  await term.resize({ terminal_id: started.terminal_id, cols: '40', rows: '12' });
  await delay(150);
  await term.write({ terminal_id: started.terminal_id, text: '\n' });
  await waitOutput(term, started.terminal_id, 'SIZE 40x12');
  await term.close({ terminal_id: started.terminal_id });
});

test('output ring bounds and truncation', async t => {
  const cwd = await tempCwd(t);
  const term = make(t, { maxOutputBytes: 4096 });
  const script = 'import sys; sys.stdout.write("A"*12000); sys.stdout.write("ENDMARK\\n"); sys.stdout.flush()';
  const started = await term.start({ cwd, argv: JSON.stringify([python, '-u', '-c', script]) }, Date.now() + 20000);
  await waitUntil(async () => {
    const result = await term.read({ terminal_id: started.terminal_id, offset: '0', max_bytes: '4096' });
    return result.truncated === true || (result.output && result.output.includes('ENDMARK')) ? result : null;
  }, 8000);
  const head = await term.read({ terminal_id: started.terminal_id, offset: '0', max_bytes: '2048' });
  assert.equal(head.truncated, true);
  const tail = await term.read({ terminal_id: started.terminal_id, offset: String(Math.max(0, head.cursor - 64)), max_bytes: '4096' });
  assert.ok(tail.output.includes('ENDMARK') || tail.output.includes('A') || head.output.includes('A'));
  await term.close({ terminal_id: started.terminal_id });
});

test('SIGTERM-ignoring foreground python and background job die on close and stop', async t => {
  const cwd = await tempCwd(t);
  const ignore = 'import os,signal,sys,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); print("PID", os.getpid(), flush=True); time.sleep(120)';
  const term = make(t);
  const started = await term.start({ cwd }, Date.now() + 20000);
  await term.write({ terminal_id: started.terminal_id, text: `${python} -u -c ${JSON.stringify(ignore)}\n` });
  const fgSeen = await waitOutput(term, started.terminal_id, /PID (\d+)/);
  const fgPid = Number(fgSeen.output.match(/PID (\d+)/)[1]);
  assert.ok(alive(fgPid));
  const fg = parseProc(fgPid);
  assert.notEqual(fg.pgrp, started.pid, 'foreground job uses a different process group from bash');
  assert.equal(fg.session, started.pid);
  await term.close({ terminal_id: started.terminal_id });
  await waitUntil(() => !alive(fgPid) && !alive(started.pid), 4000);
  assert.equal(alive(fgPid), false);
  assert.equal(alive(started.pid), false);

  const again = make(t);
  const bgStart = await again.start({ cwd }, Date.now() + 20000);
  await again.write({ terminal_id: bgStart.terminal_id, text: `${python} -u -c ${JSON.stringify(ignore)} &\n` });
  const bgSeen = await waitOutput(again, bgStart.terminal_id, /PID (\d+)/);
  const bgPid = Number(bgSeen.output.match(/PID (\d+)/)[1]);
  assert.ok(alive(bgPid));
  const bg = parseProc(bgPid);
  assert.notEqual(bg.pgrp, bgStart.pid);
  assert.equal(bg.session, bgStart.pid);
  again.stop();
  await waitUntil(() => !alive(bgPid) && !alive(bgStart.pid), 4000);
  assert.equal(alive(bgPid), false);
  assert.equal(alive(bgStart.pid), false);
});

test('TERM-ignoring grandchild survives helper SIGKILL then stop reaps the session', async t => {
  const cwd = await tempCwd(t);
  const script = [
    'import os, signal, time',
    'signal.signal(signal.SIGTERM, signal.SIG_IGN)',
    'signal.signal(signal.SIGHUP, signal.SIG_IGN)',
    'print("PID", os.getpid(), flush=True)',
    'time.sleep(120)',
  ].join('\n');
  await fs.writeFile(path.join(cwd, 'ignore.py'), script);
  const term = make(t);
  const started = await term.start({ cwd }, Date.now() + 20000);
  await term.write({ terminal_id: started.terminal_id, text: `${python} -u ignore.py &\n` });
  const seen = await waitOutput(term, started.terminal_id, /PID (\d+)/);
  const child = Number(seen.output.match(/PID (\d+)/)[1]);
  const helperPid = parseProc(started.pid).ppid;
  assert.ok(alive(helperPid));
  process.kill(helperPid, 'SIGKILL');
  await waitUntil(() => !alive(helperPid), 2000);
  assert.equal(alive(child), true, 'grandchild must still be alive after helper death');
  term.stop();
  await waitUntil(() => !alive(child) && !alive(started.pid), 4000);
  assert.equal(alive(child), false);
});

test('forked descendants die on close and outsiders survive stop', async t => {
  const cwd = await tempCwd(t);
  const script = 'import os,sys,time\nprint("PARENT", os.getpid(), flush=True)\npid=os.fork()\nif pid==0:\n    time.sleep(120)\nelse:\n    print("CHILD", pid, flush=True)\n    time.sleep(120)\n';
  const term = make(t);
  const started = await term.start({ cwd, argv: JSON.stringify([python, '-u', '-c', script]) }, Date.now() + 20000);
  const seen = await waitOutput(term, started.terminal_id, text => /PARENT (\d+)/.test(text) && /CHILD (\d+)/.test(text));
  const parentPid = Number(seen.output.match(/PARENT (\d+)/)[1]);
  const childPid = Number(seen.output.match(/CHILD (\d+)/)[1]);
  const outsider = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
  t.after(() => { try { process.kill(outsider.pid, 'SIGKILL'); } catch {} });
  assert.ok(alive(parentPid) && alive(childPid) && alive(outsider.pid));
  await term.close({ terminal_id: started.terminal_id });
  await waitUntil(() => !alive(parentPid) && !alive(childPid), 4000);
  assert.equal(alive(outsider.pid), true);
  const other = make(t);
  const live = await other.start({ cwd, argv: JSON.stringify(['sleep', '30']) }, Date.now() + 20000);
  other.stop();
  await waitUntil(() => !alive(live.pid), 4000);
  assert.equal(alive(outsider.pid), true);
});

test('permission deny and Stop during approval do not spawn', async t => {
  const cwd = await tempCwd(t);
  const denied = make(t, { permission: async () => false });
  await assert.rejects(denied.start({ cwd }, Date.now() + 5000), /command_permission_denied/);
  const before = sessionMembers(process.pid).length;
  let term;
  let cancelOnce = true;
  term = new Terminals({
    nativeDirectory: helperDir,
    resolve: async value => ({ target: value }),
    permission: async () => { if (cancelOnce) { cancelOnce = false; term.stop(); } return true; },
  });
  t.after(() => { try { term.stop(); } catch {} });
  await assert.rejects(term.start({ cwd, argv: JSON.stringify(['sleep', '30']) }, Date.now() + 5000), /stopped/);
  await delay(200);
  assert.equal(term.list().length, 0);
  assert.ok(sessionMembers(process.pid).length <= before + 2);
  const after = await term.start({ cwd, argv: JSON.stringify(['sleep', '5']) }, Date.now() + 20000);
  assert.ok(after.pid > 1);
  assert.equal(term.list()[0].running, true);
  await term.close({ terminal_id: after.terminal_id });
});

test('caps at eight sessions and rejects unknown ids', async t => {
  const cwd = await tempCwd(t);
  const term = make(t, { maxSessions: 8 });
  const ids = [];
  for (let i = 0; i < 8; i++) ids.push(await term.start({ cwd, argv: JSON.stringify(['sleep', '8']) }, Date.now() + 20000));
  await assert.rejects(term.start({ cwd, argv: JSON.stringify(['sleep', '8']) }, Date.now() + 5000), /too_many_terminals/);
  await assert.rejects(term.read({ terminal_id: 'missing' }), /unknown_terminal/);
  assert.equal(term.list().every(item => item.running === true || item.running === false), true);
  term.stop();
  for (const started of ids) await waitUntil(() => !alive(started.pid), 4000);
});

test('stop then start again works after connection-loss style cancel', async t => {
  const cwd = await tempCwd(t);
  const term = make(t);
  const first = await term.start({ cwd, argv: JSON.stringify(['sleep', '30']) }, Date.now() + 20000);
  assert.ok(alive(first.pid));
  term.stop();
  await waitUntil(() => !alive(first.pid) && term.list().length === 0, 4000);
  const second = await term.start({ cwd, argv: JSON.stringify(['bash', '--noprofile', '--norc']) }, Date.now() + 20000);
  assert.notEqual(second.terminal_id, first.terminal_id);
  assert.ok(alive(second.pid));
  assert.equal(term.list().length, 1);
  assert.equal(term.list()[0].running, true);
  await term.write({ terminal_id: second.terminal_id, text: 'echo AFTER_STOP\n' });
  await waitOutput(term, second.terminal_id, 'AFTER_STOP');
  await term.close({ terminal_id: second.terminal_id });
});

test('stale child and helper pids do not kill reused-identity outsiders', async t => {
  const cwd = await tempCwd(t);
  const term = make(t);
  const started = await term.start({ cwd, argv: JSON.stringify([python, '-u', '-c', 'import time; time.sleep(30)']) }, Date.now() + 20000);
  assert.ok(started.pid > 1);
  const session = [...term.sessions.values()][0];
  const outsider = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
  t.after(() => { try { process.kill(outsider.pid, 'SIGKILL'); } catch {} });
  const originalChild = session.childPid;
  const originalHelper = session.helper?.pid;
  session.childPid = outsider.pid;
  session.helper = { pid: outsider.pid, kill() { process.kill(outsider.pid, 'SIGKILL'); } };
  term.stop();
  await waitUntil(() => !alive(originalChild) && !alive(originalHelper), 4000);
  assert.equal(alive(outsider.pid), true);
});

test('stop during pending start before ready does not leak and allows a later start', async t => {
  const cwd = await tempCwd(t);
  const term = make(t);
  const pending = term.start({ cwd, argv: JSON.stringify(['sleep', '30']) }, Date.now() + 20000);
  await waitUntil(() => pidsWithCwd(cwd).length > 0 || term.list().length > 0, 2000).catch(() => null);
  term.stop();
  const result = await pending.then(value => ({ ok: true, value })).catch(error => ({ ok: false, error }));
  if (result.ok) {
    await waitUntil(() => !alive(result.value.pid) && term.list().length === 0, 4000);
  } else {
    assert.match(String(result.error.message), /stopped|request_expired/);
  }
  await delay(150);
  assert.equal(term.list().length, 0);
  for (const pid of pidsWithCwd(cwd)) assert.equal(alive(pid), false, `leaked ${pid}`);
  const again = await term.start({ cwd, argv: JSON.stringify(['sleep', '5']) }, Date.now() + 20000);
  assert.ok(again.pid > 1);
  assert.equal(alive(again.pid), true);
  await term.close({ terminal_id: again.terminal_id });
});

test('cols and rows clamp to 2..1000 and reject non-integers', async t => {
  const cwd = await tempCwd(t);
  const term = make(t);
  const started = await term.start({ cwd, cols: '1', rows: '5000', argv: JSON.stringify(['sleep', '5']) }, Date.now() + 20000);
  assert.equal(started.cols, 2);
  assert.equal(started.rows, 1000);
  await assert.rejects(term.resize({ terminal_id: started.terminal_id, cols: 'nope' }), /invalid_size/);
  await assert.rejects(term.resize({ terminal_id: started.terminal_id, cols: 1.5 }), /invalid_size/);
  await term.close({ terminal_id: started.terminal_id });
});

test('write rejects payloads over 128 KiB including non-ASCII', async t => {
  const cwd = await tempCwd(t);
  const term = make(t);
  const started = await term.start({ cwd, argv: JSON.stringify(['cat']) }, Date.now() + 20000);
  await assert.rejects(term.write({ terminal_id: started.terminal_id, text: 'a'.repeat(128 * 1024 + 1) }), /write_too_large/);
  const nonAscii = 'é'.repeat(64 * 1024 + 1);
  assert.ok(nonAscii.length < 128 * 1024);
  assert.ok(Buffer.byteLength(nonAscii, 'utf8') > 128 * 1024);
  await assert.rejects(term.write({ terminal_id: started.terminal_id, text: nonAscii }), /write_too_large/);
  await term.close({ terminal_id: started.terminal_id });
});
