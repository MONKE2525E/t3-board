'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

class SessionError extends Error {
  constructor(code, kind = 'backend_unavailable', phase = 'session') {
    super(code); this.name = 'SessionError'; this.code = code;
    this.failure = { kind, code, phase, effect: 'none_proven', evidenceIds: [] };
  }
}
function fail(code, kind, phase) { throw new SessionError(code, kind, phase); }
async function bounded(work, budget, clock, signal) {
  if (budget?.clockDomain !== clock.domain || !Number.isFinite(budget.deadlineMonoMs)) fail('invalid_budget', 'invalid_request');
  if (signal?.aborted) fail('cancelled', 'cancelled');
  const remaining = budget.deadlineMonoMs - clock.now();
  if (remaining <= 0) fail('deadline', 'deadline');
  let timer, abort;
  const cutoff = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new SessionError('deadline', 'deadline')), remaining);
    abort = () => reject(new SessionError('cancelled', 'cancelled'));
    signal?.addEventListener('abort', abort, { once: true });
  });
  try { return await Promise.race([Promise.resolve().then(work), cutoff]); }
  finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}
function identity(pid, read = fs.readFileSync) {
  try {
    const raw = read(`/proc/${pid}/stat`, 'utf8');
    const fields = raw.slice(raw.lastIndexOf(')') + 2).trim().split(/\s+/);
    return { pid: Number(pid), startToken: fields[19], parentId: Number(fields[1]),
      groupId: Number(fields[2]), sessionId: Number(fields[3]), zombie: fields[0] === 'Z' };
  } catch { return null; }
}
function sameProcess(a, b) { return Boolean(a && b && a.pid === b.pid && a.startToken === b.startToken); }
function privateDirectory(dir) {
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o700) fail('unsafe_runtime');
  if (fs.realpathSync(dir) !== path.resolve(dir)) fail('runtime_symlink');
}
function allocate(base) {
  privateDirectory(base);
  const root = fs.mkdtempSync(path.join(base, 'r-'));
  fs.chmodSync(root, 0o700);
  const dirs = Object.fromEntries(['home', 'config', 'data', 'cache', 'runtime', 'profiles'].map(name => {
    const dir = path.join(root, name); fs.mkdirSync(dir, { mode: 0o700 }); return [name, dir];
  }));
  // Linux AF_UNIX addresses have a 108-byte ceiling, including terminator.
  if (Buffer.byteLength(path.join(dirs.runtime, 'at-spi', 'bus_999999999')) >= 104) {
    fs.rmSync(root, { recursive: true }); fail('runtime_path_too_long');
  }
  return { root, ...dirs };
}
function sanitizedEnvironment(dirs, options = {}) {
  const env = { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8',
    HOME: dirs.home, XDG_CONFIG_HOME: dirs.config, XDG_DATA_HOME: dirs.data,
    XDG_CACHE_HOME: dirs.cache, XDG_RUNTIME_DIR: dirs.runtime,
    GDK_BACKEND: 'wayland', QT_QPA_PLATFORM: 'wayland', GTK_USE_PORTAL: '0',
    GTK_A11Y: 'atspi', NO_AT_BRIDGE: '0', WLR_BACKENDS: 'headless',
    WLR_RENDERER: 'pixman', WLR_HEADLESS_OUTPUTS: '1' };
  if (options.libraryDirectories?.length) {
    for (const dir of options.libraryDirectories) if (!path.isAbsolute(dir) || dir.includes(':') || dir.includes('\0')) fail('invalid_library_directory', 'invalid_request');
    env.LD_LIBRARY_PATH = options.libraryDirectories.join(':');
  }
  return env;
}
function socketOwned(socket, runtime) {
  const stat = fs.lstatSync(socket);
  if (!stat.isSocket() || stat.uid !== process.getuid() || path.dirname(socket) !== runtime || fs.realpathSync(path.dirname(socket)) !== runtime) fail('unsafe_socket');
  privateDirectory(runtime);
  return true;
}
function profileLease(profile, sessionId, owner = identity(process.pid)) {
  privateDirectory(profile);
  const lock = path.join(profile, '.muse-lease');
  let fd;
  try { fd = fs.openSync(lock, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600); }
  catch { fail('profile_locked', 'permission_denied'); }
  const token = crypto.randomUUID();
  try { fs.writeFileSync(fd, JSON.stringify({ sessionId, token, owner })); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  return { path: profile, release() {
    try { if (JSON.parse(fs.readFileSync(lock, 'utf8')).token !== token) return false; fs.unlinkSync(lock); return true; }
    catch { return false; }
  } };
}
module.exports = { SessionError, fail, bounded, identity, sameProcess, privateDirectory, allocate, sanitizedEnvironment, socketOwned, profileLease };
