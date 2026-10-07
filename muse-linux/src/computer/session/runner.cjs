'use strict';
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { fail, bounded, identity, sameProcess } = require('./resources.cjs');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

class ProcessOwner {
  constructor({ readIdentity = identity, signal = process.kill.bind(process), procRoot = '/proc' } = {}) {
    this.readIdentity = readIdentity; this.signal = signal; this.procRoot = procRoot; this.groups = new Map();
  }
  add(child) {
    const leader = this.readIdentity(child.pid);
    if (!leader || leader.groupId !== leader.pid || leader.sessionId !== leader.pid) fail('process_identity_unavailable');
    const group = { leader, members: new Map([[leader.pid, leader]]), child, ended: false };
    this.groups.set(leader.pid, group); return group;
  }
  members(group) {
    const live = [];
    for (const name of fs.readdirSync(this.procRoot)) {
      if (!/^\d+$/.test(name)) continue;
      const row = this.readIdentity(Number(name));
      if (row && row.groupId === group.leader.groupId && !row.zombie) live.push(row);
    }
    return live;
  }
  refresh(group) {
    const leader = this.readIdentity(group.leader.pid);
    if (leader && !sameProcess(leader, group.leader)) return false;
    const live = this.members(group);
    // While the original session leader is alive, a process in its unique session/group
    // is an owned descendant. Once it exits, only recorded lifetime tokens are trusted.
    if (sameProcess(leader, group.leader) && !leader.zombie) {
      for (const row of live) if (row.sessionId === group.leader.sessionId) group.members.set(row.pid, row);
    }
    return live.every(row => sameProcess(row, group.members.get(row.pid)) && row.sessionId === group.leader.sessionId);
  }
  async stop(group, remainingMs) {
    if (!this.refresh(group)) return false;
    let live = this.members(group);
    if (!live.length) { group.ended = true; return true; }
    try { this.signal(-group.leader.groupId, 'SIGTERM'); } catch (e) { if (e.code !== 'ESRCH') return false; }
    const end = performance.now() + Math.max(0, remainingMs);
    while (performance.now() < end && (live = this.members(group)).length) {
      if (end - performance.now() < 150) {
        if (!this.refresh(group)) return false;
        try { this.signal(-group.leader.groupId, 'SIGKILL'); } catch (e) { if (e.code !== 'ESRCH') return false; }
      }
      await delay(Math.min(20, Math.max(1, end - performance.now())));
    }
    group.ended = this.members(group).length === 0; return group.ended;
  }
  manifest() { return [...this.groups.values()].flatMap(g => { this.refresh(g); return [...g.members.values()].map(({ pid, startToken, groupId }) => ({ pid, startToken, groupId })); }); }
}

class ScopedRunner {
  constructor({ executables, environment, directories, network, bwrap, owner = new ProcessOwner(),
    clock = { now: () => performance.now(), domain: 'node.performance' }, readOnlyResources = [], validate = () => {}, spawn = cp.spawn }) {
    this.executables = executables; this.environment = environment; this.directories = directories;
    this.readOnlyResources = readOnlyResources; this.network = network; this.bwrap = bwrap; this.owner = owner; this.clock = clock; this.validate = validate; this.spawnProcess = spawn;
  }
  check(options, access) {
    if (!options?.budget || options.budget.clockDomain !== this.clock.domain || !Number.isFinite(options.budget.deadlineMonoMs)) fail('invalid_budget', 'invalid_request');
    if (options.signal?.aborted) fail('cancelled', 'cancelled');
    if (this.clock.now() >= options.budget.deadlineMonoMs) fail('deadline', 'deadline');
    this.validate(access);
  }
  command(id, argv) {
    const entry = Object.hasOwn(this.executables, id) && this.executables[id];
    if (!entry || !path.isAbsolute(entry.path) || typeof entry.validateArgs !== 'function') fail('executable_not_allowed', 'permission_denied');
    if (!Array.isArray(argv) || argv.length > 128 || argv.some(a => typeof a !== 'string' || a.includes('\0') || Buffer.byteLength(a) > 65536) || argv.reduce((n, a) => n + Buffer.byteLength(a), 0) > 131072 || !entry.validateArgs(argv)) fail('argv_not_allowed', 'invalid_request');
    return entry;
  }
  namespace(entry, argv) {
    // This policy isolates interaction and restricts writes. It leaves host files
    // readable, so it must never satisfy sandboxRequired.
    return { file: this.bwrap, args: ['--unshare-user', ...(entry.pidNamespace === false ? [] : ['--unshare-pid']), '--unshare-ipc',
      ...(this.network === 'deny' ? ['--unshare-net'] : []), '--die-with-parent',
      '--ro-bind', '/', '/', '--tmpfs', '/tmp', ...this.readOnlyResources.flatMap(p => ['--ro-bind', p, p]), '--bind', this.directories.root, this.directories.root,
      '--tmpfs', '/run/user', '--dev', '/dev', '--proc', '/proc',
      '--clearenv', ...Object.entries(this.environment).flatMap(([key, value]) => ['--setenv', key, value]),
      '--chdir', this.directories.home, '--', entry.path, ...argv] };
  }
  async start(id, argv, options, internal = {}) {
    const entry = this.command(id, argv); this.check(options, entry.access || 'mutation');
    const cmd = this.namespace(entry, argv);
    const child = this.spawnProcess(cmd.file, cmd.args, { env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
      cwd: this.directories.home, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdin.on('error', () => {});
    const group = await new Promise((resolve, reject) => {
      child.once('error', () => reject(Object.assign(new Error('spawn_unavailable'), { code: 'spawn_unavailable' })));
      child.once('spawn', () => { try { resolve(this.owner.add(child)); } catch (e) { reject(e); } });
    });
    child.on('error', () => {});
    const listeners = new Set(); let bytes = 0, truncated = false; const chunks = [];
    const limit = options.maxBytes || 262144;
    child.stdout.on('data', data => {
      const remaining = Math.max(0, limit - bytes); bytes += data.length;
      if (remaining) chunks.push(data.subarray(0, remaining));
      if (bytes > limit) truncated = true;
      for (const listener of listeners) listener(data);
    });
    // Drain stderr without retaining raw private app errors.
    child.stderr.on('data', () => {});
    let resolveExit; const exited = new Promise(resolve => { resolveExit = resolve; });
    child.once('close', (exitCode, signal) => { resolveExit({ exitCode, signal }); internal.onExit?.(exitCode, signal); });
    let timedOut = false;
    const abort = () => { void this.owner.stop(group, 700); };
    options.signal?.addEventListener('abort', abort, { once: true });
    let timer;
    if (!internal.service) timer = setTimeout(() => { timedOut = true; abort(); }, Math.max(1, options.budget.deadlineMonoMs - this.clock.now()));
    const refreshTimer = setInterval(() => this.owner.refresh(group), 25);
    child.once('close', () => { clearTimeout(timer); clearInterval(refreshTimer); options.signal?.removeEventListener('abort', abort); });
    const channel = {
      process: { pid: group.leader.pid, startToken: group.leader.startToken },
      write: async (message, ctx) => {
        if (!(Buffer.isBuffer(message) || message?.constructor?.name === 'Uint8Array') || message.byteLength > 262144) fail('invalid_message', 'invalid_request');
        const access = typeof entry.messageAccess === 'function' ? entry.messageAccess(message) : 'mutation';
        if (!['read', 'mutation'].includes(access)) fail('message_not_allowed', 'permission_denied');
        this.check(ctx, access);
        if (!this.owner.refresh(group) || child.exitCode !== null || child.signalCode !== null || child.stdin.destroyed) fail('process_gone', 'transport_lost');
        await bounded(() => {
          this.check(ctx, access);
          return new Promise((resolve, reject) => child.stdin.write(message, error => error ? reject(Object.assign(new Error('channel_lost'), { code: 'channel_lost' })) : resolve()));
        }, ctx.budget, this.clock, ctx.signal);
      },
      subscribe(listener) { listeners.add(listener); if (chunks.length) listener(Buffer.concat(chunks)); return () => listeners.delete(listener); },
      stop: async budget => {
        const ms = budget?.clockDomain === this.clock.domain ? Math.min(1000, Math.max(0, budget.deadlineMonoMs - this.clock.now())) : 0;
        const ok = await this.owner.stop(group, ms);
        return { state: ok ? 'confirmed' : 'unknown', ownedInputReleased: ok, reasonCodes: ok ? [] : ['owned_group_unconfirmed'] };
      },
    };
    return { channel, group, child, exited, read: () => ({ buffer: Buffer.concat(chunks), truncated, timedOut }) };
  }
  async exec(id, argv, options) {
    if (!options || !['utf8', 'buffer'].includes(options.encoding) || !Number.isInteger(options.maxBytes) || options.maxBytes < 1 || options.maxBytes > 4194304 || options.input && (!Buffer.isBuffer(options.input) || options.input.length > 1048576)) fail('invalid_exec_options', 'invalid_request');
    const startMonoMs = this.clock.now();
    const run = await this.start(id, argv, options);
    run.child.stdin.end(options.input);
    let result;
    try { result = await bounded(() => run.exited, options.budget, this.clock, options.signal); }
    catch {
      await this.owner.stop(run.group, 700);
      result = { exitCode: run.child.exitCode, signal: run.child.signalCode };
    }
    const output = run.read(), endMonoMs = this.clock.now();
    return { ...result, stdout: options.encoding === 'buffer' ? output.buffer : output.buffer.toString('utf8'),
      ...(result.exitCode !== 0 ? { stderrCode: 'process_failed' } : {}), timedOut: output.timedOut || this.clock.now() >= options.budget.deadlineMonoMs,
      outputTruncated: output.truncated, timings: { clockDomain: this.clock.domain, startMonoMs, endMonoMs, totalMs: endMonoMs - startMonoMs, phases: {} } };
  }
  async spawn(id, argv, options) {
    // Only main's executable allowlist can grant a session lifetime. Each
    // later write still requires its own current budget and session check.
    const entry = this.command(id, argv);
    return (await this.start(id, argv, options, { service: entry.persistent === true })).channel;
  }
}
module.exports = { ScopedRunner, sanitizedScopedRunner: options => new ScopedRunner(options), ProcessOwner };
