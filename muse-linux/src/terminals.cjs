const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_ARGV = ['bash', '--noprofile', '--norc'];
const MAX_SESSIONS = 8;
const RING_BYTES = 256 * 1024;
const WRITE_LIMIT = 128 * 1024;
const READ_LIMIT = 256 * 1024;
const IDLE_MS = 2 * 60 * 60 * 1000;
const KILL_WAIT_MS = 1500;

function parseArgv(value) {
  if (value == null || value === '') return DEFAULT_ARGV.slice();
  let argv = value;
  if (typeof value === 'string') {
    try { argv = JSON.parse(value); } catch { throw Error('argv_required: use a JSON array of executable and arguments'); }
  }
  if (!Array.isArray(argv) || argv.length < 1 || argv.length > 100 || argv.some(s => typeof s !== 'string' || s.includes('\0') || s.length > 4096) || !argv[0]) throw Error('invalid_argv');
  return argv;
}

function parseSize(value, fallback) {
  if (value == null || value === '') return fallback;
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(n)) throw Error('invalid_size');
  return Math.min(1000, Math.max(2, n));
}

function parseOffset(value) {
  if (value == null || value === '') return 0;
  if (typeof value === 'string') {
    if (!value.trim()) return 0;
    value = Number(value);
  }
  if (!Number.isSafeInteger(value) || value < 0) throw Error('invalid_offset');
  return value;
}

function parseMaxBytes(value) {
  if (value == null || value === '') return 64 * 1024;
  if (typeof value === 'string') {
    if (!value.trim()) return 64 * 1024;
    value = Number(value);
  }
  if (!Number.isFinite(value) || value < 0 || value > READ_LIMIT) throw Error('invalid_size');
  return Math.floor(value);
}

function utf8Start(buf) {
  let i = 0;
  while (i < buf.length && (buf[i] & 0xc0) === 0x80) i++;
  return i;
}

function utf8CompleteLength(buf) {
  if (!buf.length) return 0;
  let i = buf.length, trail = 0;
  while (i > 0 && (buf[i - 1] & 0xc0) === 0x80) { trail++; i--; }
  if (i === 0) return 0;
  const lead = buf[i - 1];
  if (lead < 0x80) return buf.length;
  const need = lead < 0xe0 ? 1 : lead < 0xf0 ? 2 : lead < 0xf8 ? 3 : -1;
  if (need < 0 || trail > need) return i - 1;
  if (trail < need) return i - 1;
  return buf.length;
}

class ByteRing {
  constructor(limit) {
    this.limit = limit;
    this.chunks = [];
    this.retained = 0;
    this.length = 0;
    this.written = 0;
  }
  push(buf) {
    if (!buf.length) return;
    this.chunks.push(Buffer.from(buf));
    this.length += buf.length;
    this.written += buf.length;
    while (this.length > this.limit && this.chunks.length) {
      const extra = this.length - this.limit;
      const first = this.chunks[0];
      if (first.length <= extra) {
        this.chunks.shift();
        this.length -= first.length;
        this.retained += first.length;
      } else {
        this.chunks[0] = first.subarray(extra);
        this.length -= extra;
        this.retained += extra;
      }
    }
  }
  slice(offset, maxBytes) {
    const start = Math.max(offset, this.retained);
    const end = Math.min(this.written, start + maxBytes);
    if (end <= start) return { buffer: Buffer.alloc(0), start, end: start };
    let skip = start - this.retained;
    let need = end - start;
    const parts = [];
    for (const chunk of this.chunks) {
      if (skip >= chunk.length) { skip -= chunk.length; continue; }
      const take = chunk.subarray(skip, skip + need);
      parts.push(take);
      need -= take.length;
      skip = 0;
      if (need <= 0) break;
    }
    return { buffer: Buffer.concat(parts), start, end: start + parts.reduce((n, p) => n + p.length, 0) };
  }
}

function parseProcStat(text) {
  const close = text.lastIndexOf(')');
  const open = text.indexOf(' ');
  if (close < 0 || open < 0) return null;
  const pid = Number(text.slice(0, open));
  const rest = text.slice(close + 1).trim().split(/\s+/);
  if (rest.length < 20) return null;
  const starttime = Number(rest[19]);
  if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(starttime)) return null;
  return { pid, ppid: Number(rest[1]), pgrp: Number(rest[2]), session: Number(rest[3]), starttime };
}

function listProc() {
  const found = [];
  let names;
  try { names = fs.readdirSync('/proc'); } catch { return found; }
  for (const name of names) {
    if (!/^[0-9]+$/.test(name)) continue;
    try {
      const parsed = parseProcStat(fs.readFileSync(`/proc/${name}/stat`, 'utf8'));
      if (parsed) found.push(parsed);
    } catch {}
  }
  return found;
}

function killPid(pid, signal) {
  if (!pid || pid <= 1 || pid === process.pid) return;
  try { process.kill(pid, signal); } catch {}
}

function killGroup(pid, signal) {
  if (!pid || pid <= 1) return;
  try { process.kill(-pid, signal); } catch { killPid(pid, signal); }
}

function identity(pid) {
  if (!pid || pid <= 1) return null;
  try { return parseProcStat(fs.readFileSync(`/proc/${pid}/stat`, 'utf8')); } catch { return null; }
}

function sameIdentity(fp, pid) {
  if (!fp || !pid || fp.pid !== pid) return false;
  const now = identity(pid);
  return !!(now && now.starttime === fp.starttime && now.session === fp.session);
}

function fingerprintKey(fp) {
  return fp ? `${fp.pid}:${fp.starttime}:${fp.session}` : '';
}

function killFingerprint(fp, signal) {
  if (!fp || !sameIdentity(fp, fp.pid)) return false;
  const now = identity(fp.pid);
  if (!now) return false;
  killPid(now.pid, signal);
  if (now.pgrp === now.pid) killGroup(now.pgrp, signal);
  return true;
}

function membersOfSession(sid) {
  if (!sid) return [];
  return listProc().filter(proc => proc.session === sid);
}

const instances = new Set();
function onProcessExit() {
  for (const inst of instances) inst.hardKillTracked();
}
function bindInstance(inst) {
  instances.add(inst);
  if (instances.size === 1) process.on('exit', onProcessExit);
}

class Terminals {
  constructor({ permission, resolve, onChange = null, nativeDirectory = null, idleMs = IDLE_MS, maxSessions = MAX_SESSIONS, maxOutputBytes = RING_BYTES } = {}) {
    this.permission = permission;
    this.resolve = resolve;
    this.onChange = onChange;
    this.nativeDirectory = nativeDirectory;
    this.idleMs = Number.isFinite(idleMs) && idleMs > 0 ? idleMs : IDLE_MS;
    this.maxSessions = Math.max(1, Math.min(32, maxSessions || MAX_SESSIONS));
    this.maxOutputBytes = Math.max(1024, maxOutputBytes || RING_BYTES);
    this.sessions = new Map();
    this.tracked = new Map();
    this.generation = 0;
    bindInstance(this);
  }

  helperPath() {
    const name = 'muse-terminal';
    if (this.nativeDirectory) return path.join(this.nativeDirectory, name);
    return path.join(__dirname, '../native/bin', name);
  }

  notify(kind, session) {
    try { this.onChange?.({ type: kind, terminal_id: session.id, running: session.running }); } catch {}
  }

  trackFp(fp) {
    const key = fingerprintKey(fp);
    if (key) this.tracked.set(key, fp);
  }

  untrackSession(session) {
    for (const fp of [session.helperFp, session.childFp, ...(session.memberFps || [])]) {
      this.tracked.delete(fingerprintKey(fp));
    }
  }

  pruneTracked() {
    for (const [key, fp] of this.tracked) {
      if (!sameIdentity(fp, fp.pid)) this.tracked.delete(key);
    }
  }

  hardKillTracked() {
    for (const session of this.sessions.values()) this.killOwned(session, 'SIGKILL');
    for (const fp of this.tracked.values()) killFingerprint(fp, 'SIGKILL');
    this.pruneTracked();
  }

  sidScanSafe(session) {
    const sid = session.sid || session.childFp?.session;
    if (!sid) return false;
    if (sameIdentity(session.childFp, session.childPid) || sameIdentity(session.childFp, sid)) return true;
    const leader = identity(sid);
    if (!leader) return true;
    return false;
  }

  snapshotMembers(session, { allowOrphans = false } = {}) {
    const sid = session.sid || session.childFp?.session;
    const live = sameIdentity(session.childFp, session.childPid) || sameIdentity(session.helperFp, session.helper?.pid);
    if (!sid || (!live && !allowOrphans) || (!live && !this.sidScanSafe(session))) return;
    const seen = new Map((session.memberFps || []).map(fp => [fingerprintKey(fp), fp]));
    for (const proc of membersOfSession(sid)) {
      const fp = identity(proc.pid);
      if (fp && fp.session === sid) {
        seen.set(fingerprintKey(fp), fp);
        this.trackFp(fp);
      }
    }
    session.memberFps = [...seen.values()];
  }

  killOwned(session, signal) {
    this.snapshotMembers(session, { allowOrphans: true });
    for (const fp of session.memberFps || []) killFingerprint(fp, signal);
    killFingerprint(session.childFp, signal);
    killFingerprint(session.helperFp, signal);
    if (sameIdentity(session.helperFp, session.helper?.pid)) {
      try { session.helper.kill(signal); } catch {}
    }
  }

  meta(session) {
    return {
      terminal_id: session.id,
      running: session.running,
      pid: session.childPid || null,
      cwd: session.cwd,
      cols: session.cols,
      rows: session.rows,
      started_at: session.startedAt,
      last_activity_at: session.lastActivityAt,
      exit_code: session.exitCode,
      signal: session.signal,
    };
  }

  require(id) {
    if (typeof id !== 'string' || !id || id.length > 128) throw Error('unknown_terminal');
    const session = this.sessions.get(id);
    if (!session) throw Error('unknown_terminal');
    return session;
  }

  touch(session) {
    session.lastActivityAt = Date.now();
    if (session.idleTimer) clearTimeout(session.idleTimer);
    session.idleTimer = setTimeout(() => { void this.expire(session.id); }, this.idleMs);
    if (typeof session.idleTimer.unref === 'function') session.idleTimer.unref();
  }

  async expire(id) {
    const session = this.sessions.get(id);
    if (!session) return;
    await this.reap(session);
  }

  armHardKill(session) {
    if (session.killTimer) return;
    session.killTimer = setTimeout(() => {
      session.killTimer = null;
      this.killOwned(session, 'SIGKILL');
    }, KILL_WAIT_MS);
  }

  reapSync(session) {
    this.killOwned(session, 'SIGTERM');
    this.killOwned(session, 'SIGKILL');
    this.forget(session);
  }

  async reap(session) {
    this.killOwned(session, 'SIGTERM');
    this.armHardKill(session);
    const timeout = new Promise(resolve => setTimeout(resolve, KILL_WAIT_MS + 200));
    await Promise.race([session.exited, timeout]);
    this.killOwned(session, 'SIGKILL');
    await Promise.race([session.exited, new Promise(resolve => setTimeout(resolve, 400))]);
    this.forget(session);
  }

  forget(session) {
    if (session.idleTimer) { clearTimeout(session.idleTimer); session.idleTimer = null; }
    if (session.killTimer) { clearTimeout(session.killTimer); session.killTimer = null; }
    this.killOwned(session, 'SIGKILL');
    this.untrackSession(session);
    try { session.helper?.stdin?.end(); } catch {}
    this.sessions.delete(session.id);
    this.notify('close', session);
  }

  list() {
    return [...this.sessions.values()].map(session => this.meta(session));
  }

  stop() {
    this.generation += 1;
    for (const session of [...this.sessions.values()]) this.reapSync(session);
    this.hardKillTracked();
  }

  async start(args = {}, deadline) {
    if (!Number.isSafeInteger(deadline) || deadline <= Date.now()) throw Error('request_expired');
    const generation = this.generation;
    const argv = parseArgv(args.argv);
    const cols = parseSize(args.cols, 80);
    const rows = parseSize(args.rows, 24);
    const { target: cwd } = await this.resolve(args.cwd);
    if (this.generation !== generation) throw Error('stopped');
    if (!await this.permission(argv.join(' '), deadline)) throw Error('command_permission_denied');
    if (this.generation !== generation) throw Error('stopped');
    if (Date.now() >= deadline) throw Error('request_expired');
    if (this.sessions.size >= this.maxSessions) throw Error('too_many_terminals');
    const helper = this.helperPath();
    try { fs.accessSync(helper, fs.constants.X_OK); } catch { throw Error('terminal_helper_unavailable'); }
    if (this.generation !== generation) throw Error('stopped');

    const env = { ...process.env, TERM: process.env.TERM || 'xterm-256color' };
    delete env.ELECTRON_RUN_AS_NODE;
    const helperProcess = spawn(helper, [String(cols), String(rows), '--', ...argv], {
      cwd,
      env,
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
    });
    const helperFp = identity(helperProcess.pid);
    const session = {
      id: randomUUID(),
      helper: helperProcess,
      helperFp,
      childPid: 0,
      childFp: null,
      memberFps: [],
      sid: 0,
      cwd,
      cols,
      rows,
      running: true,
      exitCode: null,
      signal: null,
      startedAt: Date.now(),
      lastActivityAt: Date.now(),
      ring: new ByteRing(this.maxOutputBytes),
      idleTimer: null,
      killTimer: null,
      ready: null,
      exited: null,
    };

    let resolveReady, rejectReady, resolveExit;
    session.ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    session.exited = new Promise(resolve => { resolveExit = resolve; });

    let stderr = '';
    const takeLines = chunk => {
      stderr += chunk.toString('utf8');
      let nl;
      while ((nl = stderr.indexOf('\n')) >= 0) {
        const line = stderr.slice(0, nl).trim();
        stderr = stderr.slice(nl + 1);
        if (!line) continue;
        let event;
        try { event = JSON.parse(line); } catch { continue; }
        if (event.event === 'ready' && Number.isInteger(event.pid)) {
          session.childPid = event.pid;
          session.sid = Number.isInteger(event.sid) ? event.sid : event.pid;
          session.childFp = identity(event.pid);
          this.trackFp(session.helperFp);
          this.trackFp(session.childFp);
          this.snapshotMembers(session);
          resolveReady(event.pid);
        } else if (event.event === 'exit') {
          session.running = false;
          session.exitCode = event.exit_code == null ? null : event.exit_code;
          session.signal = event.signal || null;
          this.notify('exit', session);
        } else if (event.event === 'error') {
          rejectReady(Error(event.message || 'terminal_failed_to_start'));
        }
      }
    };

    helperProcess.stderr.on('data', takeLines);
    helperProcess.stdout.on('data', data => {
      session.ring.push(data);
      this.notify('output', session);
    });
    helperProcess.once('error', error => {
      session.running = false;
      rejectReady(Error(error.code === 'ENOENT' ? 'terminal_helper_unavailable' : 'terminal_failed_to_start'));
      resolveExit();
    });
    helperProcess.once('exit', (code, signal) => {
      session.running = false;
      if (session.exitCode == null && session.signal == null) {
        session.exitCode = signal ? null : code;
        session.signal = signal || null;
      }
      this.snapshotMembers(session, { allowOrphans: true });
      this.pruneTracked();
      this.notify('exit', session);
      resolveExit();
      if (!session.childPid) rejectReady(Error('terminal_failed_to_start'));
    });

    this.trackFp(helperFp);
    if (this.generation !== generation) {
      this.killOwned(session, 'SIGKILL');
      this.untrackSession(session);
      throw Error('stopped');
    }

    const remain = Math.max(50, deadline - Date.now());
    let timer;
    try {
      await Promise.race([
        session.ready,
        new Promise((_, reject) => { timer = setTimeout(() => reject(Error('request_expired')), remain); }),
      ]);
    } catch (error) {
      this.killOwned(session, 'SIGKILL');
      this.untrackSession(session);
      throw error;
    } finally { clearTimeout(timer); }
    if (this.generation !== generation) {
      this.killOwned(session, 'SIGKILL');
      this.untrackSession(session);
      throw Error('stopped');
    }
    if (Date.now() >= deadline) {
      this.killOwned(session, 'SIGKILL');
      this.untrackSession(session);
      throw Error('request_expired');
    }
    this.sessions.set(session.id, session);
    this.touch(session);
    this.notify('start', session);
    return { terminal_id: session.id, pid: session.childPid, cols, rows };
  }

  async write(args = {}) {
    const session = this.require(args.terminal_id);
    if (!session.running) throw Error('terminal_exited');
    if (typeof args.text !== 'string') throw Error('text_required');
    if (Buffer.byteLength(args.text, 'utf8') > WRITE_LIMIT) throw Error('write_too_large');
    const stdin = session.helper?.stdin;
    if (!stdin || stdin.destroyed || stdin.writableEnded) throw Error('terminal_exited');
    this.snapshotMembers(session);
    this.touch(session);
    await new Promise((resolve, reject) => {
      stdin.write(args.text, 'utf8', error => { if (error) reject(error); else resolve(); });
    });
    return { ok: true, terminal_id: session.id };
  }

  async read(args = {}) {
    const session = this.require(args.terminal_id);
    const offset = parseOffset(args.offset);
    const max = parseMaxBytes(args.max_bytes);
    this.snapshotMembers(session);
    this.touch(session);
    const { buffer, start } = session.ring.slice(offset, max);
    const lead = utf8Start(buffer);
    const complete = utf8CompleteLength(buffer.subarray(lead));
    const output = buffer.subarray(lead, lead + complete).toString('utf8');
    const cursor = start + lead + complete;
    return {
      output,
      cursor: offset > session.ring.written ? session.ring.written : cursor,
      truncated: offset < session.ring.retained,
      running: session.running,
      exit_code: session.exitCode,
      signal: session.signal,
    };
  }

  async resize(args = {}) {
    const session = this.require(args.terminal_id);
    if (!session.running) throw Error('terminal_exited');
    const cols = parseSize(args.cols, session.cols);
    const rows = parseSize(args.rows, session.rows);
    const control = session.helper?.stdio?.[3];
    if (!control || control.destroyed || control.writableEnded) throw Error('terminal_exited');
    session.cols = cols;
    session.rows = rows;
    this.snapshotMembers(session);
    this.touch(session);
    await new Promise((resolve, reject) => {
      control.write(`resize ${cols} ${rows}\n`, 'utf8', error => { if (error) reject(error); else resolve(); });
    });
    return { ok: true, terminal_id: session.id, cols, rows };
  }

  async close(args = {}) {
    const session = this.require(args.terminal_id);
    await this.reap(session);
    return { ok: true, terminal_id: session.id };
  }
}

module.exports = { Terminals };
