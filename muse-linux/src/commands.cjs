const { spawn } = require('node:child_process');
const path = require('node:path');

const MAX_ARGV = 100;
const MAX_ARG_LENGTH = 4096;
const MAX_TEXT = 64000;
const MAX_BYTES = 256 * 1024;
const MIN_TIMEOUT_MS = 100;
const MAX_TIMEOUT_MS = 60000;
const DEFAULT_TIMEOUT_MS = 30000;
const KILL_GRACE_MS = 2000;

const ENV_ALLOW = new Set([
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LANGUAGE', 'LC_ALL', 'TZ',
  'TERM', 'COLORTERM', 'DISPLAY', 'WAYLAND_DISPLAY', 'XAUTHORITY',
  'XDG_RUNTIME_DIR', 'XDG_SESSION_TYPE', 'XDG_CURRENT_DESKTOP', 'XDG_SESSION_DESKTOP',
  'XDG_DATA_DIRS', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'XDG_DATA_HOME',
  'HYPRLAND_INSTANCE_SIGNATURE', 'HYPRLAND_CMD', 'HYPRCURSOR_THEME',
  'DBUS_SESSION_BUS_ADDRESS', 'GDK_BACKEND', 'QT_QPA_PLATFORM',
  'TMPDIR', 'TMP', 'TEMP', 'USERNAME',
]);

const ENV_NAME_BLOCK = /(?:TOKEN|SECRET|PASSWORD|PASSWD|PASSPHRASE|API[_-]?KEY|CREDENTIAL|PRIVATE[_-]?KEY|ACCESS[_-]?KEY)$/i;
const ENV_PREFIX_BLOCK = /^(?:ELECTRON|NODE_|NPM_|AWS_|OPENAI_|ANTHROPIC_|XAI_|GITHUB_|HUGGINGFACE_|GOOGLE_|AZURE_|CLOUDS?DK)/i;

function commandEnv() {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value !== 'string') continue;
    if (ENV_NAME_BLOCK.test(key) || ENV_PREFIX_BLOCK.test(key)) continue;
    if (key === 'SSH_AUTH_SOCK' || key === 'SSH_AGENT_PID' || key === 'GPG_AGENT_INFO' || key === 'GNUPGHOME') continue;
    if (ENV_ALLOW.has(key) || key.startsWith('LC_') || key.startsWith('XDG_')) env[key] = value;
  }
  return env;
}

function parseArgv(raw) {
  let argv;
  try { argv = JSON.parse(raw); } catch { throw Error('argv_required: use a JSON array of executable and arguments'); }
  if (!Array.isArray(argv) || argv.length < 1 || argv.length > MAX_ARGV) throw Error('invalid_argv');
  if (argv.some(s => typeof s !== 'string' || s.includes('\0') || s.length > MAX_ARG_LENGTH) || !argv[0]) throw Error('invalid_argv');
  return argv;
}

class Commands {
  constructor({ permission, resolve }) {
    this.permission = permission;
    this.resolve = resolve;
    this.active = null;
    this.pgid = null;
    this.pending = false;
    this.generation = 0;
    this.timers = [];
    this.onProcessExit = () => this.killGroup('SIGKILL');
    this.stopActive = () => this.stop();
  }

  stop() {
    this.generation += 1;
    this.killGroup('SIGTERM');
    if (this.pgid && !this.killTimer) {
      this.killTimer = setTimeout(() => this.killGroup('SIGKILL'), KILL_GRACE_MS);
      this.timers.push(this.killTimer);
    }
  }

  killGroup(signal) {
    const pgid = this.pgid;
    if (!Number.isInteger(pgid) || pgid <= 1 || pgid === process.pid) return;
    try { process.kill(-pgid, signal); } catch {}
  }

  clearTimers() {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers = [];
    this.killTimer = null;
  }

  armExitKill() {
    if (this.exitArmed) return;
    this.exitArmed = true;
    process.on('exit', this.onProcessExit);
  }

  disarmExitKill() {
    if (!this.exitArmed) return;
    this.exitArmed = false;
    process.off('exit', this.onProcessExit);
  }

  async run(args, deadline) {
    if (this.active || this.pgid || this.pending) throw Error('busy: another local command is running');
    const argv = parseArgv(args?.argv);
    if (!Number.isSafeInteger(deadline) || deadline <= Date.now()) throw Error('request_expired');
    const generation = this.generation;
    this.pending = true;
    try {
      if (generation !== this.generation) throw Error('command_stopped');
      const resolved = await this.resolve(args.cwd);
      if (generation !== this.generation) throw Error('command_stopped');
      const cwd = resolved?.target;
      if (typeof cwd !== 'string' || !path.isAbsolute(cwd) || cwd.includes('\0')) throw Error('invalid_cwd');
      if (Date.now() >= deadline) throw Error('request_expired');
      if (!await this.permission(JSON.stringify(argv), deadline)) throw Error('command_permission_denied');
      if (generation !== this.generation) throw Error('command_stopped');
      if (Date.now() >= deadline) throw Error('request_expired');
      const timeout = Math.max(MIN_TIMEOUT_MS, Math.min(MAX_TIMEOUT_MS, deadline - Date.now(), Number(args.timeout_ms) || DEFAULT_TIMEOUT_MS));
      return await this.spawnRun(argv, cwd, timeout);
    } finally {
      this.pending = false;
    }
  }

  spawnRun(argv, cwd, timeout) {
    return new Promise((resolve, reject) => {
      const child = spawn(argv[0], argv.slice(1), {
        cwd,
        argv0: argv[0],
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
        shell: false,
        env: commandEnv(),
      });
      this.active = child;
      this.pgid = child.pid || null;
      this.armExitKill();

      let stdout = '';
      let stderr = '';
      let bytes = 0;
      let timedOut = false;
      let truncated = false;
      let settled = false;
      let exitCode = null;
      let exitSignal = null;

      const settle = fn => {
        if (settled) return;
        settled = true;
        this.killGroup('SIGKILL');
        this.clearTimers();
        this.disarmExitKill();
        this.active = null;
        this.pgid = null;
        fn();
      };

      const timer = setTimeout(() => {
        timedOut = true;
        this.stop();
      }, timeout);
      this.timers.push(timer);

      const append = (stream, data) => {
        bytes += data.length;
        const text = data.toString('utf8');
        if (stream === 'stdout') {
          if (text.length > MAX_TEXT - stdout.length) truncated = true;
          if (stdout.length < MAX_TEXT) stdout += text.slice(0, MAX_TEXT - stdout.length);
        } else {
          if (text.length > MAX_TEXT - stderr.length) truncated = true;
          if (stderr.length < MAX_TEXT) stderr += text.slice(0, MAX_TEXT - stderr.length);
        }
        if (bytes > MAX_BYTES) {
          truncated = true;
          this.stop();
        }
      };

      child.stdout.on('data', data => append('stdout', data));
      child.stderr.on('data', data => append('stderr', data));
      child.once('error', error => {
        settle(() => reject(Error(error.code === 'ENOENT' ? 'executable_not_found' : 'command_failed_to_start')));
      });
      child.once('exit', (code, signal) => {
        exitCode = code;
        exitSignal = signal;
        this.killGroup('SIGKILL');
      });
      child.once('close', () => {
        settle(() => resolve({
          exit_code: exitCode,
          signal: exitSignal,
          stdout,
          stderr,
          timed_out: timedOut,
          truncated,
        }));
      });
    });
  }
}

module.exports = { Commands };
