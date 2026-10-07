'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { ScopedRunner, ProcessOwner } = require('./runner.cjs');
const { SessionError, fail, bounded, allocate, sanitizedEnvironment, socketOwned, privateDirectory, profileLease, identity, sameProcess } = require('./resources.cjs');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const capability = (supported, reason, verification = 'source_only') => ({ supported, ...(reason ? { reason } : {}), verification });

class SessionManager {
  constructor(options) {
    if (!options || !path.isAbsolute(options.runtimeBase || '') || !options.dependencies || !options.executables) fail('invalid_session_options', 'invalid_request');
    this.options = options; this.sessions = new Map(); this.resumeTokens = new WeakMap();
    this.clock = options.clock || { now: () => performance.now(), domain: 'node.performance' };
    this.sequence = 0;
  }
  context(ctx) {
    if (!ctx?.budget || ctx.budget.clockDomain !== this.clock.domain || !Number.isFinite(ctx.budget.deadlineMonoMs)) fail('invalid_budget', 'invalid_request');
    if (ctx.signal?.aborted) fail('cancelled', 'cancelled');
    if (ctx.budget.deadlineMonoMs <= this.clock.now()) fail('deadline', 'deadline');
  }
  async authorize(operation, request, ctx) {
    this.context(ctx);
    // Main must inject its existing trusted grant/permission policy. A renderer
    // request or possession of a session ID never creates permission.
    if (typeof this.options.authorize !== 'function' || await bounded(() => this.options.authorize(operation, request, ctx), ctx.budget, this.clock, ctx.signal) !== true) fail('permission_denied', 'permission_denied');
    this.context(ctx);
  }
  get(id) { const record = this.sessions.get(id); if (!record) fail('session_not_found', 'stale_target'); return record.descriptor; }
  record(id) { this.get(id); return this.sessions.get(id); }
  status(id) {
    const r = this.record(id), d = r.descriptor;
    return { sessionId: id, state: d.state, generation: d.generation, requiresUserResume: r.paused,
      reasons: [...r.reasons], quiescence: { ...r.quiescence, reasonCodes: [...r.quiescence.reasonCodes] } };
  }
  receipt(r, action, startMonoMs) {
    const endMonoMs = this.clock.now();
    return { ...this.status(r.descriptor.id), action, timings: { clockDomain: this.clock.domain,
      startMonoMs, endMonoMs, totalMs: endMonoMs - startMonoMs, phases: {} } };
  }
  checkRecord(r, generation, access) {
    const d = r.descriptor;
    if (generation !== d.generation) fail('stale_session_generation', 'stale_target');
    if (!['ready', 'starting', 'paused'].includes(d.state)) fail('session_unavailable', 'not_ready');
    if (r.paused && access !== 'read') fail('session_paused', 'permission_denied');
    if (d.state === 'starting' && r.paused) fail('session_paused', 'permission_denied');
    if (r.compositor && !sameProcess(r.owner.readIdentity(r.compositor.group.leader.pid), r.compositor.group.leader)) {
      this.invalidate(r, 'compositor_lost'); fail('compositor_lost', 'transport_lost');
    }
  }
  invalidate(r, reason) {
    if (['stopped', 'stopping', 'failed', 'quiescence_unknown'].includes(r.descriptor.state)) return;
    r.descriptor.generation++; r.descriptor.state = 'failed'; r.reasons.add(reason); r.controller.abort();
    this.options.onInvalidation?.({ sessionId: r.descriptor.id, generation: r.descriptor.generation, reason });
    r.cleanup ||= this.cleanup(r, { deadlineMonoMs: this.clock.now() + 1000, clockDomain: this.clock.domain });
  }
  async wait(r, ctx, test) {
    while (true) {
      this.context(ctx); this.checkRecord(r, r.descriptor.generation, 'read');
      const value = await test(); if (value) return value;
      await delay(Math.min(25, Math.max(1, ctx.budget.deadlineMonoMs - this.clock.now())));
    }
  }
  async create(req, ctx) {
    const fields = ['mode', 'task', 'backend', 'dimensions', 'viewer', 'fileGrantIds', 'network', 'sandboxRequired', 'selectedTarget'];
    if (!req || typeof req !== 'object' || Object.keys(req).some(k => !fields.includes(k)) || typeof req.sandboxRequired !== 'boolean' || req.selectedTarget !== undefined) fail('invalid_session_request', 'invalid_request');
    await this.authorize('create', req, ctx);
    if (req.mode !== 'isolated_desktop' || req.backend && req.backend !== 'cage_headless') fail('session_backend_unsupported');
    if (req.viewer !== 'none') fail('viewer_unsupported');
    if (!['deny', 'approved'].includes(req.network) || !Array.isArray(req.fileGrantIds) || req.fileGrantIds.length) fail('session_policy_unsupported', 'permission_denied');
    if (req.sandboxRequired) fail('confidentiality_sandbox_unavailable');
    if (typeof req.task !== 'string' || req.task.length > 4096) fail('invalid_task_scope', 'invalid_request');
    const size = req.dimensions || { width: 1280, height: 720, scale: 1 };
    if (size.width !== 1280 || size.height !== 720 || size.scale !== 1) fail('dimensions_unsupported');
    if (typeof this.options.readyProbe !== 'function') fail('readiness_probe_unavailable');
    const deps = this.options.dependencies;
    for (const key of ['bwrap', 'cage', 'dbusDaemon', 'atspiLauncher', 'atspiRegistry', 'gdbus', 'keepalive', 'protocolProbe', 'capture']) {
      if (!path.isAbsolute(deps[key] || '')) fail(key === 'cage' ? 'cage_unavailable' : 'runtime_dependency_unavailable');
      try { fs.accessSync(deps[key], fs.constants.X_OK); } catch { fail(key === 'cage' ? 'cage_unavailable' : 'runtime_dependency_unavailable'); }
    }
    const dirs = allocate(this.options.runtimeBase), id = crypto.randomUUID();
    const d = { id, mode: 'isolated_desktop', backend: 'cage_headless', ownership: 'owned', state: 'starting', generation: ++this.sequence,
      capabilities: { filesystemConfidentiality: capability(false, 'host_files_readable'),
        networkIsolation: capability(req.network === 'deny', req.network === 'approved' ? 'approved_host_network' : undefined),
        workspace: capability(false, 'cage_has_no_workspaces'), viewer: capability(false, 'viewer_unsupported'),
        globalAtspiGeometry: capability(false, 'atspi_bounds_are_surface_local'), hostRawInputTakeover: capability(false, 'isolated_seat'),
        portals: capability(false, 'portal_broker_unavailable'), keyring: capability(false, 'keyring_broker_unavailable') },
      resourceManifest: { processes: [], sockets: [], directories: [dirs.root], profilePaths: [] } };
    const r = { descriptor: d, dirs, owner: new ProcessOwner(this.options.processOwnerOptions),
      controller: new AbortController(), paused: false, reasons: new Set(), clients: new Map(), profiles: [],
      quiescence: { state: 'confirmed', ownedInputReleased: true, reasonCodes: [] } };
    this.sessions.set(id, r);
    const generation = d.generation;
    const env = sanitizedEnvironment(dirs, this.options);
    const entries = { ...this.options.executables };
    const service = (name, binary, validateArgs, access = 'service') => { entries[name] = { path: binary, validateArgs, access }; };
    service('$bus', deps.dbusDaemon, a => a.length === 5 && a[0] === '--session' && a[1] === '--nofork' && a[2] === '--nopidfile' && a[3] === `--address=unix:path=${dirs.runtime}/session` && a[4] === '--print-address=1');
    service('$a11y', deps.atspiLauncher, a => a.join(' ') === '--launch-immediately --a11y=1');
    service('$registry', deps.atspiRegistry, a => a.length === 0);
    for (const name of ['$bus', '$a11y', '$registry']) entries[name].pidNamespace = false;
    service('$cage', deps.cage, a => a.length === 4 && a[0] === '-D' && a[1] === '--' && a[2] === deps.keepalive && a[3] === 'infinity');
    service('$dbusQuery', deps.gdbus, a => a.join(' ') === 'call --session --dest org.a11y.Bus --object-path /org/a11y/bus --method org.a11y.Bus.GetAddress' || a.join(' ') === `call --address ${env.AT_SPI_BUS_ADDRESS} --dest org.a11y.atspi.Registry --object-path /org/a11y/atspi/registry --method org.freedesktop.DBus.Peer.Ping`, 'read');
    service('$protocolProbe', deps.protocolProbe, a => a.length === 1 && a[0] === '--probe', 'read');
    service('$capture', deps.capture, a => a.join(' ') === '-o HEADLESS-1 -', 'read');
    r.runner = new ScopedRunner({ executables: entries, environment: env, directories: dirs, network: req.network, bwrap: deps.bwrap,
      owner: r.owner, clock: this.clock, readOnlyResources: [...new Set([...Object.values(entries).map(e => e.path), deps.keepalive, ...(this.options.libraryDirectories || [])])], validate: access => this.checkRecord(r, generation, access) });
    // Lifecycle-only IDs and service lifetimes never escape through the public runner.
    const publicExecutable = name => {
      if (typeof name !== 'string' || name.startsWith('$') || !Object.hasOwn(entries, name) || entries[name].internalOnly === true) fail('executable_not_allowed', 'permission_denied');
    };
    d.runner = Object.freeze({ exec: (name, argv, opt) => { publicExecutable(name); return r.runner.exec(name, argv, opt); },
      spawn: (name, argv, opt) => { publicExecutable(name); return r.runner.spawn(name, argv, opt); } });
    Object.defineProperty(d, 'environment', { value: env, enumerable: false });
    const startupAbort = () => r.controller.abort(); ctx.signal?.addEventListener('abort', startupAbort, { once: true });
    const startup = { budget: ctx.budget, signal: r.controller.signal, encoding: 'utf8', maxBytes: 262144 };
    try {
      await r.runner.start('$bus', ['--session', '--nofork', '--nopidfile', `--address=unix:path=${dirs.runtime}/session`, '--print-address=1'], startup, { service: true, onExit: () => this.invalidate(r, 'session_bus_lost') });
      await this.wait(r, ctx, () => { try { return socketOwned(`${dirs.runtime}/session`, dirs.runtime); } catch { return false; } });
      env.DBUS_SESSION_BUS_ADDRESS = `unix:path=${dirs.runtime}/session`;
      await r.runner.start('$a11y', ['--launch-immediately', '--a11y=1'], startup, { service: true, onExit: () => this.invalidate(r, 'accessibility_bus_lost') });
      env.AT_SPI_BUS_ADDRESS = await this.wait(r, ctx, async () => {
        const result = await r.runner.exec('$dbusQuery', ['call', '--session', '--dest', 'org.a11y.Bus', '--object-path', '/org/a11y/bus', '--method', 'org.a11y.Bus.GetAddress'], startup);
        if (result.exitCode !== 0) return false;
        const address = result.stdout.match(/'(unix:path=([^',]+)(?:,[^']+)?)'/);
        if (!address || !path.resolve(address[2]).startsWith(`${dirs.runtime}/`)) fail('unsafe_accessibility_bus');
        let stat;
        try { stat = fs.lstatSync(address[2]); } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
        if (!stat.isSocket() || stat.uid !== process.getuid()) fail('unsafe_accessibility_bus');
        return address[1];
      });
      await r.runner.start('$registry', [], startup, { service: true, onExit: () => this.invalidate(r, 'accessibility_registry_lost') });
      await this.wait(r, ctx, async () => (await r.runner.exec('$dbusQuery', ['call', '--address', env.AT_SPI_BUS_ADDRESS, '--dest', 'org.a11y.atspi.Registry', '--object-path', '/org/a11y/atspi/registry', '--method', 'org.freedesktop.DBus.Peer.Ping'], startup)).exitCode === 0);
      r.compositor = await r.runner.start('$cage', ['-D', '--', deps.keepalive, 'infinity'], startup, { service: true, onExit: () => this.invalidate(r, 'compositor_lost') });
      const socket = await this.wait(r, ctx, () => {
        const names = fs.readdirSync(dirs.runtime).filter(n => /^wayland-\d+$/.test(n));
        if (names.length !== 1) return false;
        const full = path.join(dirs.runtime, names[0]); return socketOwned(full, dirs.runtime) && full;
      });
      env.WAYLAND_DISPLAY = socket;
      const probe = await r.runner.exec('$protocolProbe', ['--probe'], startup);
      let protocols; try { protocols = JSON.parse(probe.stdout).protocols; } catch { fail('protocol_probe_failed'); }
      if (probe.exitCode !== 0 || !Array.isArray(protocols) || !['zwlr_virtual_pointer_manager_v1', 'zwp_virtual_keyboard_manager_v1', 'zwlr_screencopy_manager_v1', 'zwlr_foreign_toplevel_manager_v1'].every(p => protocols.includes(p))) fail('isolation_protocol_unavailable');
      const frame = await r.runner.exec('$capture', ['-o', 'HEADLESS-1', '-'], { ...startup, encoding: 'buffer', maxBytes: 4194304 });
      if (frame.exitCode !== 0 || frame.outputTruncated || frame.stdout.length < 24 || !frame.stdout.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) || frame.stdout.readUInt32BE(16) !== size.width || frame.stdout.readUInt32BE(20) !== size.height) fail('frame_readiness_failed');
      d.display = Object.freeze({ socket, instanceId: crypto.randomUUID(), coordinateSpace: 'cage_headless_output_logical' });
      d.buses = Object.freeze({ sessionAddress: env.DBUS_SESSION_BUS_ADDRESS, accessibilityAddress: env.AT_SPI_BUS_ADDRESS, busId: crypto.randomUUID() });
      const probeCtx = { ...ctx, sessionId: id, revision: { ...ctx.revision, sessionGeneration: generation }, signal: r.controller.signal };
      const measured = await bounded(() => this.options.readyProbe({ session: d, runner: d.runner, launch: req => this.launchInternal(r, req, probeCtx), ctx: probeCtx }), ctx.budget, this.clock, r.controller.signal);
      this.context(ctx); this.checkRecord(r, generation, 'read');
      if (!measured || measured.semantic !== true || measured.pixels !== true || measured.input !== true) fail('fixture_readiness_failed');
      for (const name of ['pixels', 'nativeSemantic', 'pointer', 'keyboard']) d.capabilities[name] = capability(true, undefined, 'measured');
      d.capabilities.foreignToplevel = capability(true, undefined, 'measured');
      d.capabilities.activateWindow = capability(measured.activation === true, measured.activation === true ? undefined : 'activation_not_verified', measured.activation === true ? 'measured' : 'source_only');
      d.resourceManifest.sockets = [socket, `${dirs.runtime}/session`, env.AT_SPI_BUS_ADDRESS.match(/^unix:path=([^,]+)/)[1]];
      d.resourceManifest.processes = r.owner.manifest();
      Object.freeze(env);
      Object.freeze(d.capabilities);
      for (const key of ['id', 'mode', 'backend', 'ownership', 'runner']) Object.defineProperty(d, key, { writable: false });
      d.state = r.paused ? 'paused' : 'ready'; return d;
    } catch (error) {
      d.generation++; d.state = 'failed'; r.reasons.add(error.code || 'isolation_unavailable'); r.controller.abort();
      r.cleanup ||= this.cleanup(r, { deadlineMonoMs: this.clock.now() + 1000, clockDomain: this.clock.domain }); await r.cleanup;
      const out = new SessionError(error.code || 'isolation_unavailable', error.failure?.kind || 'backend_unavailable', 'startup');
      Object.defineProperty(out, 'cause', { value: error }); out.sessionId = id; out.isolationCode = 'isolation_unavailable'; throw out;
    } finally { ctx.signal?.removeEventListener('abort', startupAbort); }
  }
  async launch(id, req, ctx) {
    if (!req || typeof req !== 'object' || Object.keys(req).some(k => !['appId', 'args', 'workspace'].includes(k))) fail('invalid_launch_request', 'invalid_request');
    const r = this.record(id);
    if (this.options.apps?.[req.appId]?.internalOnly === true) fail('app_not_allowed', 'permission_denied');
    await this.authorize('launch', { sessionId: id, appId: req.appId }, ctx);
    if (ctx.sessionId !== id || ctx.revision?.sessionGeneration !== r.descriptor.generation) fail('stale_session_generation', 'stale_target');
    this.checkRecord(r, r.descriptor.generation, 'mutation'); return this.launchInternal(r, req, ctx);
  }
  async launchInternal(r, req, ctx) {
    this.context(ctx);
    if (req.workspace !== undefined) fail('workspace_unsupported', 'invalid_request');
    const app = Object.hasOwn(this.options.apps || {}, req.appId) && this.options.apps[req.appId];
    if (!app || !Array.isArray(req.args) || req.args.length > 64 || req.args.some(a => typeof a !== 'string' || a.includes('\0')) || typeof app.buildArgs !== 'function' || typeof app.validateArgs !== 'function' || !app.validateArgs(req.args)) fail('app_not_allowed', 'permission_denied');
    const previous = r.clients.get(req.appId);
    if (previous) {
      if (sameProcess(identity(previous.client.process.pid), previous.client.process)) return previous.client;
      if (!r.owner.members(previous.run.group).length) fail('app_instance_ended', 'stale_target');
      fail('app_instance_unknown', 'transport_lost');
    }
    const profile = path.join(r.dirs.profiles, crypto.randomUUID()); fs.mkdirSync(profile, { mode: 0o700 });
    const lease = profileLease(profile, r.descriptor.id); r.profiles.push(lease); r.descriptor.resourceManifest.profilePaths.push(profile);
    const argv = app.buildArgs({ args: [...req.args], profile, home: r.dirs.home });
    const run = await r.runner.start(app.executableId, argv, { budget: ctx.budget, signal: r.controller.signal }, { service: true });
    const executable = fs.realpathSync(r.runner.executables[app.executableId].path);
    const processRow = await this.wait(r, ctx, () => {
      r.owner.refresh(run.group);
      return r.owner.members(run.group).find(row => { try { return fs.realpathSync(`/proc/${row.pid}/exe`) === executable; } catch { return false; } });
    });
    const client = { process: { pid: processRow.pid, startToken: processRow.startToken }, targets: [], ownership: 'owned', sessionId: r.descriptor.id };
    r.clients.set(req.appId, { client, run }); r.descriptor.resourceManifest.processes = r.owner.manifest();
    return client;
  }
  async pause(id, reason) {
    if (!['human_input', 'viewer_input', 'user_pause', 'input_unavailable'].includes(reason)) fail('invalid_pause_reason', 'invalid_request');
    const r = this.record(id), start = this.clock.now();
    if (reason === 'human_input' || reason === 'viewer_input') fail('isolated_takeover_unsupported', 'invalid_request');
    if (!['starting', 'ready', 'paused'].includes(r.descriptor.state)) fail('session_unavailable', 'not_ready');
    r.paused = true; r.reasons.add(reason); r.descriptor.state = 'paused';
    // Adapter quiescence is injected by main and must not send new intended input.
    try {
      r.quiescence = typeof this.options.quiesce === 'function' ? await bounded(() => this.options.quiesce(r.descriptor, { deadlineMonoMs: start + 1000, clockDomain: this.clock.domain }), { deadlineMonoMs: start + 1000, clockDomain: this.clock.domain }, this.clock) :
        { state: 'unknown', ownedInputReleased: false, reasonCodes: ['adapter_quiescence_unavailable'] };
    } catch { r.quiescence = { state: 'unknown', ownedInputReleased: false, reasonCodes: ['adapter_quiescence_unknown'] }; }
    if (r.quiescence.state !== 'confirmed') r.reasons.add('quiescence_unknown');
    return this.receipt(r, 'pause', start);
  }
  issueLocalResumeToken(id) {
    const r = this.record(id); if (!r.paused) fail('session_not_paused', 'invalid_request');
    const proof = Object.freeze({ id: crypto.randomUUID(), kind: 'local_user_resume' }); this.resumeTokens.set(proof, { id, generation: r.descriptor.generation }); return proof;
  }
  async resumeByUser(id, proof) {
    const r = this.record(id), start = this.clock.now(), token = this.resumeTokens.get(proof);
    if (!token || token.id !== id || token.generation !== r.descriptor.generation || r.descriptor.state !== 'paused' || r.quiescence.state !== 'confirmed') fail('user_resume_required', 'permission_denied');
    this.resumeTokens.delete(proof); r.paused = false; r.reasons.clear(); r.descriptor.state = 'ready';
    this.options.onInvalidation?.({ sessionId: id, generation: r.descriptor.generation, reason: 'user_resume_reobserve' });
    return this.receipt(r, 'resume', start);
  }
  async cleanup(r, budget) {
    const end = budget?.clockDomain === this.clock.domain ? Math.min(this.clock.now() + 1000, budget.deadlineMonoMs) : this.clock.now();
    let ok = true;
    for (const group of [...r.owner.groups.values()].reverse()) ok = await r.owner.stop(group, Math.max(0, end - this.clock.now())) && ok;
    r.quiescence = { state: ok ? 'confirmed' : 'unknown', ownedInputReleased: ok, reasonCodes: ok ? [] : ['owned_group_unconfirmed'] };
    r.descriptor.resourceManifest.processes = r.owner.manifest();
    if (ok) {
      for (const lease of r.profiles) lease.release();
      try { privateDirectory(r.dirs.root); fs.rmSync(r.dirs.root, { recursive: true }); }
      catch { r.quiescence = { state: 'unknown', ownedInputReleased: true, reasonCodes: ['runtime_cleanup_unconfirmed'] }; }
    }
    return r.quiescence;
  }
  async stop(id, reason, budget) {
    if (!['user_stop', 'expired', 'permission_revoked', 'disconnected', 'owned_failure'].includes(reason)) fail('invalid_stop_reason', 'invalid_request');
    const r = this.record(id), start = this.clock.now();
    if (r.descriptor.state === 'stopped') return this.receipt(r, 'stop', start);
    r.descriptor.state = 'stopping'; r.descriptor.generation++; r.reasons.add(reason); r.controller.abort();
    this.options.onInvalidation?.({ sessionId: id, generation: r.descriptor.generation, reason });
    r.cleanup ||= this.cleanup(r, budget); await r.cleanup;
    r.descriptor.state = r.quiescence.state === 'confirmed' ? 'stopped' : 'quiescence_unknown';
    return this.receipt(r, 'stop', start);
  }
}
module.exports = { ...require('./readiness.cjs'), ForeignToplevelClient: require('./foreign-toplevel.cjs').ForeignToplevelClient, SessionManager, ScopedRunner, sanitizedScopedRunner: options => new ScopedRunner(options), ProcessOwner,
  SessionError, sanitizedEnvironment, identity, sameProcess, profileLease };
