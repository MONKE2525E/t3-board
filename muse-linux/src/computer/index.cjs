'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { BrowserController, ElectronDebuggerTransport } = require('./browser/index.cjs');
const { AccessibilityClient, DesktopController } = require('./desktop/index.cjs');
const { HostRunner } = require('./host-runner.cjs');
const { identity } = require('./session/resources.cjs');
const { ForeignToplevelClient } = require('./session/index.cjs');
const { createIsolationManager } = require('./isolation.cjs');
const { sessionTarget, createSessionLaunchAdapter } = require('./session-launch.cjs');
const { diagnoseComputer } = require('./diagnosis.cjs');
const { createHash } = require('node:crypto');
const { ReceiptJournal, RunReducer } = require('./journal/index.cjs');
const { ExecutionCoordinator, LegacyCommandAdapter } = require('./executor.cjs');
const { Progress } = require('./progress.cjs');
const state = require('./state/index.cjs');
const C = require('./contracts.cjs');
const { normalizeKey } = require('../key-names.cjs');
const { compactObservation } = require('../observation-output.cjs');
const clock = Object.freeze({ now: () => performance.now(), domain: 'node.performance', utc: () => new Date().toISOString(), setTimeout, clearTimeout });
const clean = value => JSON.parse(JSON.stringify(value));
const fail = code => { throw Object.assign(Error(code), { code }); };

// Composition is main-process only. Neither renderer JSON nor possession of a
// ref can issue a grant, choose a Chrome target, or select an ambient display.
class ComputerRuntime {
  constructor({ deviceId, directory, nativeDirectory, policy, permission, localBrowser, desktop, onChange = () => {}, fixtureOrigins = [], sessionManager, resolveFile } = {}) {
    this.deviceId = deviceId; this.nativeDirectory = nativeDirectory; this.policy = policy; this.permission = permission;
    this.localBrowser = localBrowser; this.desktop = desktop; this.onChange = onChange; this.fixtureOrigins = fixtureOrigins;
    this.resolveFile = resolveFile; this.uploadGrants = new Map();
    this.browserFiles = { resolveApproved: async (id, { target, ctx }) => {
      const grant = this.uploadGrants.get(id);
      if (!grant || grant.expires < Date.now() || ctx.signal.aborted || !C.sameTarget(grant.target, target)) fail('file_capability_expired');
      let resolved;
      try { resolved = await this.resolveFile(grant.requested); }
      catch { throw Object.assign(Error('file_access_denied'), { kind: 'permission_denied', code: 'file_access_denied' }); }
      const file = resolved.target || resolved.path;
      const stat = fs.lstatSync(file);
      if (file !== grant.path || !stat.isFile() || stat.isSymbolicLink() || stat.dev !== grant.dev || stat.ino !== grant.ino || stat.size !== grant.size || stat.mtimeMs !== grant.mtimeMs) fail('file_changed');
      return { path: file, symlinkSafe: true, approved: true, size: stat.size };
    } };
    this.manager = sessionManager; this.prepared = new Map(); this.outputs = new Map(); this.picker = new Map(); this.invocationAdapters = new Map();
    this.evidence = new Map(); this.runs = new Set(); this.epoch = 0; this.controller = new AbortController();
    this.journal = new ReceiptJournal({ directory: path.join(directory, 'computer-journal'), deviceId, clock });
    this.ready = this.journal.ready.then(async () => {
      await this.journal.recover();
      this.startupReview = await this.journal.startupReview();
      this.startupBlocked = this.startupReview.integrity !== 'complete' || this.startupReview.actions.length > 0;
    });
    this.ready.catch(() => {});
    this.registry = new state.AssertionRegistry(); this.reducer = new RunReducer({ journal: this.journal, assertionRegistry: this.registry, handoffCapability: 'local_only' });
    this.reconciler = new state.Reconciler({ registry: this.registry, getCurrent: target => ({ target, revision: this.verifyingRevision || this.revision(), clockDomain: clock.domain }) });
    this.coordinator = new ExecutionCoordinator({ journal: this.journal, clock, assertions: this.registry,
      reconciler: this.reconciler,
      authorize: (ctx, request) => this.authorize(ctx, request), selectAdapter: (target, session, ctx) => target.kind === 'session' && session === this.session && session.mode === 'isolated_desktop'
        ? this.wrapAdapter(createSessionLaunchAdapter({ manager: this.manager, session })) : this.invocationAdapters.get(ctx?.invokeId) || this.adapter,
      translate: input => { const request = this.prepared.get(input.invokeId); if (!request) fail('translation_unavailable'); return request; } });
    this.hostRunner = new HostRunner({ helper: path.join(nativeDirectory, 'muse-accessibility-worker'), environment: process.env, clock,
      allowed: () => this.session?.mode === 'real_desktop' && this.policy().desktopPolicy !== 'deny' && !this.controller.signal.aborted });
    this.exit = () => this.hostRunner.stopSync(); process.on('exit', this.exit);
    if (!this.manager) {
      const configured = createIsolationManager({ nativeDirectory, directory, clock,
        authorize: async () => !!this.grant && !this.controller.signal.aborted && this.policy().desktopPolicy !== 'deny',
        quiesce: async () => this.desktopController?.quiesce(this.cleanupContext(this.session)) || { state: 'confirmed', ownedInputReleased: true, reasonCodes: [] },
        onInvalidation: () => { this.controller.abort(); this.onChange(); } });
      this.manager = configured.manager; this.isolationMissing = configured.missing;
    }
  }
  context(deadline = Date.now() + 15000) {
    const progress = new Progress({ budget: { clockDomain: clock.domain, deadlineMonoMs: clock.now() + Math.max(0, Math.min(180000, deadline - Date.now())) }, signal: this.controller.signal, clock });
    return { sessionId: this.session?.id || this.connectionSessionId, revision: this.revision(), budget: progress.budget, signal: progress.signal, progress, grant: this.grant,
      runId: this.runId || 'local-setup', invokeId: randomUUID(), actionId: randomUUID() };
  }
  revision() {
    if (this.browser?.active && this.session) return this.browser.revision({ revision: this.baseRevision() });
    return this.baseRevision();
  }
  baseRevision() { return { sessionGeneration: this.session?.generation || this.epoch || 1, grantGeneration: this.epoch || 1, targetGeneration: this.target?.generation || 1, semanticRevision: 0, geometryRevision: 0 }; }
  async authorize(ctx, { session, request }) {
    if (this.startupBlocked && C.isMutation(request.operation)) fail('startup_review_required');
    if (session !== this.session || this.controller.signal.aborted || !['ready', 'paused'].includes(session.state)) fail('stopped_by_user');
    if (C.isMutation(request.operation) && (this.userPaused || session.state === 'paused' || session.mode === 'real_desktop' && this.desktop.paused)) fail('user_takeover');
    const key = session.mode === 'real_desktop' || session.mode === 'isolated_desktop' ? 'desktopPolicy' : 'browserPolicy';
    if (this.policy()[key] === 'deny' || !this.grant) fail('permission_denied');
    const revision = request.expectedRevision || (!C.isMutation(request.operation) ? { ...this.revision(), targetGeneration: request.target.generation } : undefined);
    if (!revision) fail('stale_session');
    C.validateRevision(revision);
    if (request.target.sessionId !== session.id || revision.sessionGeneration !== session.generation || revision.grantGeneration !== this.epoch || revision.targetGeneration !== request.target.generation) fail('stale_session');
    if (request.target.kind === 'session' && (request.operation.kind !== 'launchApp' || !C.sameTarget(request.target, sessionTarget(session)))) fail('stale_target');
    if (session.mode === 'real_desktop') {
      const live = (await this.desktop.windows()).find(w => w.window_id === request.target.targetId);
      const process = identity(live?.pid);
      if (!live || process?.startToken !== request.target.process?.startToken) fail('stale_target');
    }
    return { grant: this.grant, revision };
  }
  browserPolicy() {
    return { authorize: async ctx => !ctx.signal.aborted && !this.controller.signal.aborted && this.policy().browserPolicy !== 'deny',
      allowNavigation: async url => { try { return new URL(url).protocol === 'https:' && this.policy().browserPolicy !== 'deny'; } catch { return false; } } };
  }
  browserStatus() { return { status: this.connected?.active ? 'ready' : this.connected?.state === 'connected' ? 'choose_tab' : 'disconnected', selected: !!this.connected?.active }; }
  async connection(request) {
    if (!request || !['list', 'select', 'disconnect'].includes(request.action)) fail('invalid_browser_connection');
    if (request.action === 'disconnect') { await this.stop(); await this.connected?.detach(this.context()); this.connected = null; this.picker.clear(); this.onChange(); return this.browserStatus(); }
    if (request.action === 'select') {
      const selected = this.picker.get(request.token); if (!selected) fail('invalid_selection_token');
      const ctx = this.context(); ctx.sessionId = this.connectionSessionId; ctx.revision = { ...this.baseRevision(), sessionGeneration: this.connectionGeneration };
      const lease = await this.connected.attach(selected, ctx); this.picker.clear(); this.connectedLease = lease; this.onChange(); return { status: 'ready', selected: true };
    }
    if (this.connected?.active) return { status: 'ready', selected: true, tabs: [] };
    this.connectionSessionId ||= randomUUID(); this.connectionGeneration ||= (this.connectionCounter = (this.connectionCounter || 0) + 1);
    this.connected ||= new BrowserController({ policy: this.browserPolicy(), files: this.browserFiles, fixtureOrigins: this.fixtureOrigins });
    const ctx = this.context(); ctx.sessionId = this.connectionSessionId; ctx.revision = { ...ctx.revision, sessionGeneration: this.connectionGeneration };
    if (this.connected.state !== 'connected') {
      const discovery = path.join(process.env.HOME, '.config/google-chrome/DevToolsActivePort');
      if (!fs.existsSync(discovery)) return { status: 'attachment_required', setup: 'chrome_consent' };
      const result = await this.connected.connect({ mode: 'chrome_consent', explicitDiscoveryFile: discovery }, ctx);
      if (result.state !== 'connected') return { status: result.state, error: result.failure?.code };
    }
    const choices = await this.connected.listForLocalPicker(ctx); this.picker.clear();
    const tabs = choices.map(choice => { const token = randomUUID(); this.picker.set(token, choice.selectionToken); return { token, title: choice.displayLabel }; });
    return { status: 'choose_tab', tabs };
  }
  async beginRun(requirements = []) {
    await this.ready; this.runId = randomUUID();
    await this.reducer.begin({ runId: this.runId, requirements }); this.runs.add(this.runId);
    return this.runId;
  }
  async start(args) {
    if (this.starting) fail('session_starting');
    const token = this.lifecycle = (this.lifecycle || 0) + 1;
    this.starting = true;
    try { return await this.startScope(args, token); }
    catch (error) { await this.stop().catch(() => {}); throw error; }
    finally { this.starting = false; }
  }
  async startScope(args, token) {
    const check = () => { if (token !== this.lifecycle || this.controller.signal.aborted) fail('stopped_by_user'); };
    await this.ready;
    check();
    if (this.startupBlocked) fail('startup_review_required');
    if (this.session?.state === 'paused' || this.desktop.paused) fail('user_resume_required');
    if (args.scope === 'connected_browser') {
      if (!this.connected?.active) fail('connected_browser_required: select a Chrome tab in Linux settings');
      await this.stop({ keepConnection: true, startupToken: token }); check();
      this.epoch = this.connectedLease.grantGeneration; this.browser = this.connected;
      this.session = { id: this.connectionSessionId, generation: this.connectionGeneration, mode: 'borrowed_browser', ownership: 'borrowed', state: 'ready' };
      this.target = this.connectedLease.target;
      if (!await this.permission('browserPolicy', args.task, args.__deadline, this.controller.signal)) fail('permission_denied');
      check();
    } else if (args.scope === 'desktop') {
      await this.stop({ startupToken: token }); check();
      const result = await this.desktop.session(args); check(); if (!result.session_id || this.desktop.paused) return result;
      this.session = { id: result.session_id, generation: ++this.epoch, mode: 'real_desktop', ownership: 'borrowed', state: 'ready',
        buses: { sessionAddress: process.env.DBUS_SESSION_BUS_ADDRESS, accessibilityAddress: process.env.AT_SPI_BUS_ADDRESS }, runner: this.hostRunner,
        display: { instanceId: process.env.HYPRLAND_INSTANCE_SIGNATURE } };
      if (!this.session.buses.accessibilityAddress) {
        const queried = await promisify(execFile)('/usr/bin/gdbus', ['call', '--session', '--dest', 'org.a11y.Bus', '--object-path', '/org/a11y/bus', '--method', 'org.a11y.Bus.GetAddress'], { encoding: 'utf8', timeout: 2000, maxBuffer: 4096, signal: this.controller.signal });
        check();
        const address = /^\('([^']+)',?\)\s*$/.exec(queried.stdout)?.[1]; if (!address?.startsWith('unix:')) fail('accessibility_bus_unavailable');
        this.session.buses.accessibilityAddress = address;
      }
      this.accessibility = new AccessibilityClient({ rootMapper: (target, ctx) => this.mapRoot(target, ctx), plainTextPolicy: (_ref, live) => ['entry', 'text'].includes(live.role) });
      await this.accessibility.start(this.session, this.context(args.__deadline));
      check();
      this.desktopController = new DesktopController({ session: this.session, accessibility: this.accessibility, probe: (...params) => this.probeNative(...params), authorize: async () => { if (this.desktop.paused || this.policy().desktopPolicy === 'deny') fail('user_takeover'); } });
      this.installAdapter(this.desktopController);
      this.grant = C.createPrivateHandle('grant', randomUUID()); await this.beginRun(); check(); this.onChange();
      return { ...result, run_id: this.runId, tool_contract: '0.6.0', routes: ['atspi', 'physical_fallback'], full_text_readback: true };
    } else if (args.scope === 'isolated_desktop') {
      await this.stop({ startupToken: token }); check();
      if (!this.manager) fail('isolation_dependency_missing');
      const controller = this.controller;
      if (!await this.permission('desktopPolicy', args.task, args.__deadline, controller.signal)) fail('permission_denied');
      if (controller !== this.controller || controller.signal.aborted) fail('stopped_by_user');
      this.grant = C.createPrivateHandle('grant', randomUUID());
      await this.beginRun();
      check();
      const setupContext = this.context(args.__deadline); setupContext.dispatch = this.calibrationDispatch(controller);
      this.session = await this.manager.create({ mode: 'isolated_desktop', backend: 'cage_headless', task: args.task || 'Muse separate desktop',
        dimensions: { width: 1280, height: 720, scale: 1 }, viewer: 'none', fileGrantIds: [], network: 'deny', sandboxRequired: false }, setupContext);
      check();
      this.foreign = new ForeignToplevelClient({ session: this.session, clock }); await this.foreign.start(this.context(args.__deadline));
      check();
      this.accessibility = new AccessibilityClient({ rootMapper: (target, ctx) => this.mapRoot(target, ctx), plainTextPolicy: (_ref, live) => ['entry', 'text'].includes(live.role) });
      await this.accessibility.start(this.session, this.context(args.__deadline));
      check();
      this.desktopController = new DesktopController({ session: this.session, accessibility: this.accessibility,
        probe: (...params) => this.probeNative(...params),
        authorize: async () => { this.requireSession(); if (this.policy().desktopPolicy === 'deny') fail('permission_denied'); } });
      this.installAdapter(this.desktopController); this.onChange();
      return { session_id: this.session.id, run_id: this.runId, scope: 'isolated_desktop', tool_contract: '0.6.0', host_input: false,
        capabilities: this.session.capabilities, apps: Object.keys(this.manager.options.apps).filter(id => !this.manager.options.apps[id].internalOnly),
        limitations: ['Fresh private app profiles; authenticated Chrome is accessed separately through connected_browser.', 'Headless desktop has no viewer or workspaces.', 'Host files are readable; this is input isolation, not a confidentiality sandbox.'] };
    } else {
      await this.stop({ startupToken: token }); check();
      const result = await this.localBrowser.session(args); check();
      this.session = { id: result.session_id, generation: ++this.epoch, mode: 'borrowed_browser', backend: 'owned_browser', ownership: 'owned', state: 'ready' };
      const contents = this.localBrowser.view.webContents;
      this.browser = new BrowserController({ transport: new ElectronDebuggerTransport({ debugger: contents.debugger, targetId: String(contents.id) }), policy: this.browserPolicy(), files: this.browserFiles, fixtureOrigins: this.fixtureOrigins });
      this.grant = C.createPrivateHandle('grant', randomUUID()); const ctx = this.context(args.__deadline);
      const connection = await this.browser.connect({ mode: 'owned' }, ctx); if (connection.state !== 'connected') fail(connection.failure?.code || 'browser_connect_failed');
      check();
      const [choice] = await this.browser.listForLocalPicker(ctx); check();
      await this.browser.attach(choice.selectionToken, ctx); check(); this.target = this.browser.active.lease.target;
    }
    this.grant = C.createPrivateHandle('grant', randomUUID()); this.installAdapter(this.browser);
    await this.beginRun(); check(); this.onChange(); return { session_id: this.session.id, run_id: this.runId, scope: args.scope || 'browser', tool_contract: '0.6.0', routes: ['direct_cdp'], host_input: false, authenticated_profile: this.session.backend === 'owned_browser' ? 'Muse Local Browser' : 'selected_user_tab' };
  }
  installAdapter(provider) {
    this.adapter = this.wrapAdapter(provider);
  }
  wrapAdapter(provider) {
    const privateDigest = this.browser ? value => this.browser.privateDigest(value) : value => this.accessibility.digest(value);
    const normalize = (raw, operation) => state.normalizeAdapterReceipt ? state.normalizeAdapterReceipt(raw, { operation, privateDigest }) : raw;
    return {
      preflight: async (op, ctx) => { const raw = await provider.preflight(op, ctx); return clean({ eligible: raw.eligible, revision: raw.revision, evidence: raw.evidence || [], noEffectProven: raw.noEffectProven !== false, ...(raw.failure ? { failure: raw.failure } : {}) }); },
      perform: async (op, ctx) => {
        const raw = await provider.perform(op, ctx); this.outputs.set(ctx.invokeId, raw);
        const n = normalize(raw, op); this.verifyingRevision = n.after || n.before; return clean({ target: n.target, before: n.before, ...(n.after ? { after: n.after } : {}), dispatch: n.dispatch, effect: n.effect,
          attempts: n.attempts || [], evidence: n.evidence || [], timings: n.timings || ctx.progress.timings(), ...(n.failure ? { failure: n.failure } : {}) });
      },
      probe: async (predicates, target, ctx) => {
        const raw = await provider.probe(predicates, target, ctx);
        return state.normalizeBrowserEvidence && target.kind === 'tab' ? raw.flatMap(e => state.normalizeBrowserEvidence(e)) : raw;
      }, quiesce: ctx => provider.quiesce(ctx),
    };
  }
  calibrationDispatch(controller) {
    const pending = new Map();
    return {
      beforeEffect: async boundary => {
        if (controller.signal.aborted || controller !== this.controller || this.policy().desktopPolicy === 'deny') fail('stopped_by_user');
        const invokeId = randomUUID(), actionId = randomUUID(), revision = { sessionGeneration: boundary.target.generation, grantGeneration: this.epoch,
          targetGeneration: boundary.target.generation, semanticRevision: 0, geometryRevision: 0 };
        const invocation = { deviceId: this.deviceId, runId: this.runId, invokeId, command: 'computer.calibration', params: { primitive: boundary.primitive, target: boundary.target }, deadlineUtcMs: Date.now() + 5000 };
        const admission = await this.journal.admit(invocation, 8192); if (!admission.accepted) fail('storage_unavailable');
        const context = { ...invocation, actionId, revision };
        const handle = await this.journal.begin(context, { command: invocation.command, operationKind: 'calibration', target: boundary.target, parameterMac: await this.journal.invocationMac(invocation) });
        const token = await this.journal.beforeEffect(handle, { ...boundary, revision });
        if (controller.signal.aborted) fail('stopped_by_user');
        pending.set(token, { handle, invocation, context, boundary, start: clock.now() }); return token;
      },
      afterEffect: async (token, ack) => {
        const record = pending.get(token); if (!record) fail('unknown_attempt'); pending.delete(token);
        const dispatch = ack.state === 'accepted' ? 'acknowledged' : ack.state === 'lost' ? 'possible' : 'sent';
        const effect = ack.state === 'rejected' && ack.noEffectProven ? 'none_proven' : 'unknown';
        await this.journal.endAttempt(token, { dispatch, effect });
        const receipt = { schema: 'muse.action_receipt.v1', ...record.context, target: record.boundary.target, before: record.context.revision,
          execution: ack.state === 'accepted' ? 'completed' : 'failed', dispatch, effect, attempts: [], assertions: [], replay: 'forbidden',
          timings: { clockDomain: clock.domain, startMonoMs: record.start, endMonoMs: clock.now(), totalMs: clock.now() - record.start, phases: {} },
          journal: { throughSeq: 0, integrity: 'unknown' }, artifacts: [], persistence: 'durable' };
        const saved = await this.journal.end(record.handle, receipt);
        await this.journal.finishInvocation(record.invocation, { receipt: saved, artifacts: [] });
      },
    };
  }
  async mapRoot(target, ctx) {
    const window = this.session.mode === 'isolated_desktop' ? this.isolatedWindows?.find(w => w.window_id === target.targetId && w.pid === target.process.pid) : (await this.desktop.windows()).find(w => w.window_id === target.targetId && w.pid === target.process.pid);
    if (!window) fail('stale_target');
    const discovered = (await this.accessibility.discover(target, ctx)).candidates;
    let roots = discovered.filter(root => root.name === window.title);
    if (!roots.length && this.session.mode === 'isolated_desktop' && discovered.length === 1 && window.configuredAppBinding &&
      this.isolatedWindows.filter(w => w.pid === window.pid).length === 1) {
      roots = discovered; window.accessibility_title = roots[0].name; window.title_conflict = true;
    }
    if (roots.length !== 1) fail('ambiguous_accessibility_root');
    return { ...roots[0], startToken: target.process.startToken, confidence: 'exact' };
  }
  async probeNative(_predicates, target, ctx) {
    const tree = await this.accessibility.observe(target, { scope: 'structural', maxNodes: 200, maxDepth: 12 }, ctx);
    return [state.normalizeDesktopEvidence(tree, { refs: tree.nodes.map(n => n.ref) })];
  }
  async hostTarget(windowId) {
    const window = await this.desktop.target(windowId, { __deadline: Date.now() + 10000 }); const p = identity(window.pid); if (!p) fail('unknown_owner');
    const target = { sessionId: this.session.id, kind: 'window', targetId: window.window_id, generation: 1, ownership: 'borrowed', compositorInstance: this.session.display.instanceId, process: { pid: p.pid, startToken: p.startToken } };
    this.target = target; return target;
  }
  async nativeTree(window) {
    const target = await this.hostTarget(window.window_id); const ctx = this.context();
    const tree = await this.accessibility.observe(target, { scope: 'structural', maxNodes: 200, maxDepth: 12 }, ctx);
    this.lastNativeEvidence = tree;
    return { window_bounds: window.bounds, truncated: tree.coverage.truncated, controls: tree.nodes.map(node => ({
      path: node.ref.id, label: node.name, role: node.role, bounds: node.bounds, showing: node.states.includes('showing'), disabled: !node.states.includes('enabled'),
      editable: node.ref.capabilities.includes('editText'), actions: node.actions, states: node.states, ref: node.ref,
    })) };
  }
  requireSession(readOnly = false) { if (!this.session || this.controller.signal.aborted) fail('session_required'); if (!readOnly && (this.userPaused || this.session.state === 'paused' || this.desktop.paused || this.browser?.active?.state === 'paused')) fail('user_resume_required'); }
  async observe(args = {}) {
    this.requireSession(true);
    if (this.session.mode === 'real_desktop') return this.desktop.observe(args);
    if (this.session.mode === 'isolated_desktop') return this.observeIsolated(args);
    if (this.browser.dialog) return { run_id: this.runId, window_id: this.target.targetId, target: this.target, revision: this.revision(),
      dialog: { id: this.browser.dialog.id, type: this.browser.dialog.type, state: 'open' }, controls: [], route: 'direct_cdp',
      required_next: 'explicit_dialog_decision', guidance: 'A selected-tab modal is open. Accept or dismiss this exact dialog_id; do not replay the action that opened it.' };
    const ctx = this.context(args.__deadline); const query = args.query ? typeof args.query === 'string' ? JSON.parse(args.query) : args.query : undefined;
    const observed = await this.browser.observe({ lease: this.browser.active.lease, sources: ['dom'], ...(query ? { query } : {}) }, ctx);
    this.observation = observed;
    return this.projectBrowserObservation(observed, args);
  }
  async projectBrowserObservation(observed, args = {}) {
    const document = observed.state.evidence.flatMap(e => e.facts).find(f => f.predicate === 'document')?.value || {};
    const elements = observed.state.evidence.flatMap(e => e.facts).find(f => f.predicate === 'elements')?.value || [];
    const output = { observation_id: observed.id, window_id: this.target.targetId, target: this.target, revision: observed.state.revision,
      run_id: this.runId, title: document.title, url: document.currentUrl, text_excerpt: document.textExcerpt, headings: document.headings,
      pending_navigation: observed.state.pendingNavigation, route: 'direct_cdp', screenshot_requested: false,
      controls: observed.refs.elements.map((ref, i) => { const meta = elements.find(e => e.refId === ref.id) || {}; return { element_number: i + 1, ref_id: ref.id, role: meta.role, label: meta.name, value: meta.valuePreview, states: meta.states, capabilities: ref.capabilities,
        ...(meta.navigation ? { destination_url: meta.navigation.url, destination_target: meta.navigation.target } : {}) }; }),
      coverage: observed.state.evidence.map(e => ({ source: e.source, ...e.coverage })), unsupported: this.browser.capabilities(this.target) };
    if (args.image || args.view === 'image') {
      if (this.session.backend === 'owned_browser') await this.localBrowser.attachScreenshot(output, this.localBrowser.view.webContents, { width: 0, height: 0 }, args);
      else Object.assign(output, { capture_status: 'unavailable', image_current: false, unchanged: null, capture_error: 'connected_tab_pixels_not_integrated', capture_guidance: 'Use the current DOM state. Do not infer navigation failure from missing pixels.' });
    }
    return compactObservation(clean(output), args);
  }
  resolveControl(args) {
    const observation = this.observation; if (!observation || args.observation_id && args.observation_id !== observation.id) fail('stale_observation');
    let matches = observation.refs.elements;
    if (args.ref_id) matches = matches.filter(r => r.id === args.ref_id);
    else if (args.element_number) matches = matches.filter((_r, i) => i + 1 === Number(args.element_number));
    else if (args.element_label) {
      const elements = observation.state.evidence.flatMap(e => e.facts).find(f => f.predicate === 'elements')?.value || [];
      const ids = elements.filter(e => e.name.toLowerCase() === args.element_label.toLowerCase()).map(e => e.refId); matches = matches.filter(r => ids.includes(r.id));
    } else matches = matches.filter(r => r.capabilities.includes('editText'));
    if (matches.length !== 1) fail('unique_element_required: query by role/name or select an observed control'); return matches[0];
  }
  async listIsolatedWindows() {
    const rows = await this.foreign.list(this.context());
    const clients = [...this.manager.record(this.session.id).clients];
    this.isolatedWindows = rows.flatMap(row => {
      const owners = clients.filter(([id, record]) => identity(record.client.process.pid)?.startToken === record.client.process.startToken &&
        (id === row.appId || this.manager.options.apps[id]?.windowAppIds?.includes(row.appId) || record.client.targets.some(t => t.targetId === row.target.targetId)));
      // A compositor title alone cannot identify a PID. Discover exact app roots
      // only among processes this session launched, then require a unique match.
      return [{ window_id: row.target.targetId, title: row.title, app_id: row.appId, active: row.active, foreignTarget: row.target,
        ...(owners.length === 1 ? { pid: owners[0][1].client.process.pid, process: owners[0][1].client.process, configuredAppBinding: true } : {}) }];
    });
    return this.isolatedWindows;
  }
  async observeIsolated(args) {
    const windows = await this.listIsolatedWindows();
    const window = args.window_id ? windows.find(w => w.window_id === args.window_id) : windows.find(w => w.active);
    if (!window) return this.attachIsolatedCapture({ run_id: this.runId, windows: windows.map(({ foreignTarget: _f, process: _p, ...w }) => w), controls: [], route: 'isolated_atspi', required_next: 'open_app' }, args);
    let output;
    try {
    let process = window.process;
    if (!process) {
      const candidates = [];
      for (const [, record] of this.manager.record(this.session.id).clients) {
        if (identity(record.client.process.pid)?.startToken !== record.client.process.startToken) continue;
        const target = { ...window.foreignTarget, process: record.client.process };
        const roots = (await this.accessibility.discover(target, { ...this.context(args.__deadline), revision: { ...this.baseRevision(), targetGeneration: target.generation } })).candidates;
        if (roots.filter(r => r.name === window.title).length === 1) candidates.push(record.client.process);
      }
      if (candidates.length !== 1) fail('ambiguous_accessibility_root'); process = candidates[0]; window.process = process; window.pid = process.pid;
    }
    this.target = { ...window.foreignTarget, process }; const ctx = this.context(args.__deadline);
    const tree = await this.accessibility.observe(this.target, { scope: 'structural', maxNodes: 200, maxDepth: 12 }, ctx);
    this.nativeObservation = { id: randomUUID(), tree }; this.lastNativeEvidence = tree;
    output = { observation_id: this.nativeObservation.id, run_id: this.runId, window_id: window.window_id, target: this.target, revision: ctx.revision,
      title: window.accessibility_title || window.title, ...(window.title_conflict ? { state_conflicts: [{ source: 'foreign_window_title', value: window.title, resolution: 'unique_configured_app_and_current_accessibility_root', accessibility_title: window.accessibility_title }] } : {}), route: 'isolated_atspi', host_input: false, coverage: tree.coverage,
      controls: tree.nodes.map((n, i) => ({ element_number: i + 1, ref_id: n.ref.id, label: n.name, role: n.role, actions: n.actions, states: n.states, capabilities: n.ref.capabilities })),
      coordinates_available: false, coordinate_guidance: 'AT-SPI bounds are surface-local. Physical actions require calibrated geometry and are unavailable here.' };
    } catch (error) {
      this.nativeObservation = null;
      output = { run_id: this.runId, window_id: window.window_id, title: window.title, controls: [], route: 'isolated_atspi', host_input: false,
        accessibility_status: 'unavailable', accessibility_error: error.code || 'accessibility_unavailable', coordinates_available: false,
        guidance: 'Accessibility discovery failed. Pixels are independent; do not conclude the app failed to open. Refresh discovery or inspect the image.' };
    }
    return this.attachIsolatedCapture(output, args);
  }
  async attachIsolatedCapture(output, args) {
    if (args.image || args.view === 'image') {
      const ctx = this.context(args.__deadline);
      try {
      const frame = await this.session.runner.exec('readinessCapture', ['-o', 'HEADLESS-1', '-'], { ...ctx, encoding: 'buffer', maxBytes: 4194304 });
      if (frame.exitCode !== 0 || frame.outputTruncated) fail('capture_failed');
      const digest = createHash('sha256').update(frame.stdout).digest('hex'); output.unchanged = digest === this.isolatedFrame && args.force_image !== 'true';
      output.capture_status = 'available'; output.image_current = true; output.screenshot_id = digest;
      if (!output.unchanged) output.image_transfer = { mime_type: 'image/png', data_base64: frame.stdout.toString('base64'), filename: 'isolated-desktop.png' };
      this.isolatedFrame = digest;
      } catch (error) { Object.assign(output, { capture_status: 'unavailable', image_current: false, unchanged: null, capture_error: error.code || 'capture_failed' }); }
    }
    return compactObservation(clean(output), args);
  }
  operation(args, ref) {
    const action = args.action;
    if (action === 'navigate') return { kind: 'navigate', target: this.target, url: args.url };
    if (action === 'type') return { kind: 'editText', ref, edit: { mode: args.edit_mode || (args.replace_all === true || args.replace_all === 'true' ? 'replace' : 'insert'), text: args.text, semantics: 'plain_text', clipboard: 'forbid', newlinePolicy: 'literal_multiline' } };
    if (action === 'click') return { kind: 'click', ref, button: args.button || 'left' };
    if (action === 'focus') return { kind: 'focus', ref };
    if (action === 'key') return { kind: 'press', target: this.target, ref, chord: normalizeKey({ key: args.key, modifiers: args.modifiers || undefined }).combo };
    if (action === 'reveal') return { kind: 'reveal', ref, edge: args.edge || 'nearest' };
    if (action === 'set_checked') return { kind: 'setChecked', ref, checked: args.checked === true || args.checked === 'true' };
    if (action === 'scroll') return { kind: 'scroll', ref, axis: ['left', 'right'].includes(args.scroll_direction) ? 'x' : 'y', delta: (['up', 'left'].includes(args.scroll_direction) ? -1 : 1) * Math.min(10000, Number(args.scroll_amount || 400)) };
    if (action === 'dialog') return { kind: 'dialog', dialogId: args.dialog_id, decision: args.decision, ...(args.text === undefined ? {} : { text: args.text }) };
    fail('action_unavailable: use a supported semantic operation');
  }
  async execute(request, operation, { expect = [], require = [], requirementIds = [], noObservation = false, route, dispatchPath } = {}) {
    this.requireSession(); await this.journal.ready;
    const session = this.session, runId = this.runId, provider = this.browser || this.desktopController, priorObservation = this.observation;
    const invokeId = request.invokeId || randomUUID(); C.id(invokeId);
    const params = clean(request.params); const incomingMac = await this.journal.invocationMac({ command: request.command, params });
    const prior = await this.journal.lookupDelivery(invokeId, incomingMac);
    if (prior.state !== 'new') {
      if (prior.state === 'collision') fail('dedup_collision');
      if (prior.state !== 'receipt') fail('unfinished_or_expired_action: inspect the trace; do not replay input');
      return { ...clean(prior.receipt), duplicate_delivery: true };
    }
    const target = operation.ref?.target || operation.target || this.target;
    await this.reducer.validateRequirementIds(runId, requirementIds);
    if (!expect.length && state.expectationsForOperation) expect = state.expectationsForOperation(operation, {
      privateDigest: this.browser ? value => this.browser.privateDigest(value) : value => this.accessibility.digest(value),
      heading: request.params.expected_heading, ...(operation.kind === 'navigate' && this.browser ? { urlDigest: this.browser.urlDigest(operation.url) } : {}) });
    if (!expect.length && operation.kind === 'dialog') expect = [{ id: randomUUID(), validator: 'dialog.state', validatorVersion: 1, target, args: { dialogId: operation.dialogId, state: 'closed' } }];
    const action = { schema: 'muse.action.v1', runId, invokeId, actionId: randomUUID(), target,
      expectedRevision: operation.ref?.revision || (operation.kind === 'launchApp' ? { ...this.revision(), targetGeneration: target.generation } : this.revision()), operation, require, expect, requirementIds };
    this.prepared.set(invokeId, action);
    this.invocationAdapters.set(invokeId, this.adapter);
    let result;
    try { result = await this.coordinator.invoke({ deviceId: this.deviceId, runId, invokeId, command: request.command, params, deadlineUtcMs: request.deadline }, session); }
    finally { this.prepared.delete(invokeId); this.invocationAdapters.delete(invokeId); }
    const raw = this.outputs.get(invokeId); this.outputs.delete(invokeId);
    let ledgerFailure;
    try { await this.reducer.recordAction(runId, result.receipt, requirementIds); }
    catch (error) {
      if (error.code !== 'invalid_request' || result.receipt.dispatch !== 'not_started' || result.receipt.effect !== 'none_proven' || result.receipt.attempts.length) throw error;
      try { await this.reducer.recordRejectedInvocation(runId, result.receipt); }
      catch (failure) { ledgerFailure = failure.code || 'history_incomplete'; }
    }
    if (raw?.evidence?.length && requirementIds.length) {
      const normalized = state.normalizeAdapterReceipt(raw, { operation });
      await this.reducer.verify(runId, requirementIds, normalized.evidence, { ...this.context(request.deadline), revision: normalized.after || action.expectedRevision });
    }
    const native = session.mode !== 'borrowed_browser';
    const output = { receipt: result.receipt, run_id: runId, dispatch_path: dispatchPath || (native ? 'semantic' : 'browser_dom'), route: route || (native ? 'atspi' : 'direct_cdp'),
      dispatched: ['acknowledged', 'sent'].includes(result.receipt.dispatch), task_success: result.receipt.effect === 'verified', replay: result.receipt.replay };
    if (ledgerFailure) { output.handoff_status = 'unavailable'; output.handoff_error = ledgerFailure; }
    const current = this.session === session && (this.browser || this.desktopController) === provider && !this.controller.signal.aborted;
    if (raw?.observation && current) this.observation = raw.observation;
    if (result.receipt.failure) { output.error = result.receipt.failure.code; output.required_next = result.receipt.failure.requiredNext; }
    else if (!current) { output.stopped = true; output.required_next = 'start_new_session_do_not_replay'; }
    else if (noObservation) output.required_next = 'observe';
    else {
      try { output.observation = raw?.observation && this.browser ? await this.projectBrowserObservation(raw.observation) : await this.observe({ __deadline: request.deadline }); }
      catch (error) { output.observation_status = 'unavailable'; output.observation_error = error.code || 'observation_unavailable'; output.required_next = 'observe'; }
    }
    if (raw?.launch) Object.assign(output, { launched: result.receipt.dispatch === 'acknowledged', process: raw.launch.process,
      instance: raw.launch.instance, window_verified: false, host_input: false });
    if (current && this.browser && raw?.observation && result.receipt.execution === 'completed' && result.receipt.dispatch === 'acknowledged' && !result.receipt.failure) {
      const observed = raw.observation.state;
      const afterInput = Math.max(...result.receipt.attempts.map(attempt => attempt.timings.endMonoMs));
      try { output.observed_state_change = this.coordinator.detector.observeProgress(runId, { target, before: result.receipt.before, after: observed.revision,
        beforeEvidence: (priorObservation?.state?.evidence || []).map(e => state.normalizeBrowserEvidence(e, { refs: priorObservation.refs.elements })),
        evidence: observed.evidence.map(e => state.normalizeBrowserEvidence(e, { refs: raw.observation.refs.elements })) },
        { ...this.context(request.deadline), revision: observed.revision, afterActionMonoMs: afterInput }); }
      catch { output.observed_state_change = { progress: false, evidenceIds: [], reason: 'progress_evidence_unavailable' }; }
    }
    if (current && this.browser?.dialog) { output.dialog = { id: this.browser.dialog.id, type: this.browser.dialog.type, state: 'open' }; output.required_next = 'explicit_dialog_decision'; }
    return output;
  }
  async control(request, args) {
    const duplicate = await this.delivery(request); if (duplicate) return duplicate;
    if (args.action === 'batch') return this.batch(request, args);
    this.requireSession(['wait', 'describe', 'current_target', 'list_windows', 'list_apps', 'status', 'desktop_context', 'list_workspaces', 'list_keybindings', 'list_layers'].includes(args.action));
    if (['wait', 'describe', 'current_target'].includes(args.action)) return args.action === 'current_target' ? { target: this.target, run_id: this.runId } : this.observe(args);
    if (this.session.mode === 'isolated_desktop') {
      if (args.action === 'list_windows') return { windows: (await this.listIsolatedWindows()).map(({ foreignTarget: _f, process: _p, ...w }) => w) };
      if (args.action === 'list_apps') return { apps: Object.keys(this.manager.options.apps).filter(id => !this.manager.options.apps[id].internalOnly) };
      if (args.action === 'open_app') {
        const launchSession = this.session;
        const provider = createSessionLaunchAdapter({ manager: this.manager, session: launchSession });
        const previous = this.adapter; this.installAdapter(provider);
        const launchAdapter = this.adapter;
        try { return await this.execute(request, { kind: 'launchApp', target: sessionTarget(launchSession), appId: args.app }, { noObservation: true, route: 'isolated_session', dispatchPath: 'session_launch' }); }
        finally { if (this.session === launchSession && this.adapter === launchAdapter) this.adapter = previous; }
      }
      if (args.action === 'activate' || args.action === 'close_window') {
        await this.observeIsolated({ window_id: args.window_id, __deadline: request.deadline });
        const target = this.target, kind = args.action === 'activate' ? 'activateWindow' : 'closeWindow';
        const probe = async (_predicates, selected, ctx) => {
          const start = clock.now(), rows = await this.foreign.list(ctx), row = rows.find(w => w.target.targetId === selected.targetId), id = randomUUID();
          return [{ id, source: 'window', producer: 'muse.cage.foreign', target: selected, revisionBefore: ctx.revision, revisionAfter: ctx.revision,
            interval: { startMonoMs: start, endMonoMs: clock.now(), clockDomain: clock.domain, utc: clock.utc() }, acquisition: 'ok', freshness: 'current', reasons: [],
            coverage: { scope: 'private_compositor', complete: true, truncated: false, omittedFrames: [], omissionReasons: [] }, derivedFrom: [],
            facts: [{ predicate: 'window.closed', value: { targetId: selected.targetId, closed: !row, closureConfirmed: !row }, evidenceIds: [id], suitability: 'authoritative' }] }];
        };
        const provider = { preflight: async (_op, ctx) => ({ eligible: true, revision: ctx.revision, evidence: [], noEffectProven: true }),
          perform: async (_op, ctx) => { const raw = await this.foreign[kind === 'closeWindow' ? 'close' : 'activate'](target, ctx);
            return { target, before: ctx.revision, after: ctx.revision, dispatch: raw.dispatch, effect: raw.effect, attempts: [], evidence: await probe([], target, ctx), timings: ctx.progress.timings(), ...(raw.failure ? { failure: raw.failure } : {}) }; },
          probe, quiesce: async () => ({ state: 'confirmed', ownedInputReleased: true, reasonCodes: [] }) };
        this.installAdapter(provider);
        const expect = kind === 'closeWindow' ? [{ id: randomUUID(), validator: 'window.closed', validatorVersion: 1, target, args: { closed: true } }] : [];
        try { return await this.execute(request, { kind, target }, { expect, route: 'isolated_compositor', dispatchPath: 'compositor' }); }
        finally { this.installAdapter(this.desktopController); }
      }
      if (args.observation_id && args.observation_id !== this.nativeObservation?.id) fail('stale_observation');
      const nodes = this.nativeObservation?.tree.nodes || [];
      const matches = nodes.filter((node, i) => args.ref_id ? node.ref.id === args.ref_id : args.element_number ? i + 1 === Number(args.element_number) : args.element_label ? node.name.toLowerCase() === args.element_label.toLowerCase() : node.ref.capabilities.includes('editText') && node.states.includes('focused'));
      if (matches.length !== 1) fail('unique_element_required');
      return this.execute(request, args.action === 'perform_action' ? { kind: 'invoke', ref: matches[0].ref, actionName: args.action_name } : this.operation(args, matches[0].ref));
    }
    if (args.action === 'list_windows') return this.session.mode === 'real_desktop' ? { windows: await this.desktop.windows() } : { windows: [{ window_id: this.target.targetId, scope: 'selected_tab_only' }] };
    if (this.session.mode === 'real_desktop') {
      const controls = this.desktop.observation?.controls || [];
      let matches = args.element_number ? controls.filter((_c, i) => i + 1 === Number(args.element_number)) : args.element_label ? controls.filter(c => c.label.toLowerCase() === args.element_label.toLowerCase()) : controls.filter(c => c.editable && c.states.includes('focused'));
      if (['type', 'focus', 'perform_action'].includes(args.action) || args.action === 'click' && !args.coordinate && (!args.button || args.button === 'left')) {
        if (args.observation_id !== this.desktop.observation?.id || matches.length !== 1 || !matches[0].ref) fail('unique_element_required: observe and choose an exact accessible control; for web fields connect Chrome');
        const ref = matches[0].ref; this.target = ref.target; this.installAdapter(this.desktopController);
        const operation = args.action === 'perform_action' ? { kind: 'invoke', ref, actionName: args.action_name } : this.operation(args, ref);
        return this.execute(request, operation);
      }
      if (['status', 'desktop_context', 'list_workspaces', 'list_keybindings', 'list_apps', 'list_layers'].includes(args.action)) return this.desktop.control(args);
      return this.legacyControl(request, args);
    }
    const ref = ['navigate', 'dialog'].includes(args.action) ? undefined : this.resolveControl(args);
    if (args.action === 'upload') {
      if (!this.resolveFile) fail('approved_file_access_required');
      const paths = typeof args.paths === 'string' ? JSON.parse(args.paths) : args.paths;
      if (!Array.isArray(paths) || !paths.length || paths.length > 16 || paths.some(file => typeof file !== 'string' || !path.isAbsolute(file))) fail('invalid_upload_files');
      const fileCapabilityIds = [];
      for (const requested of paths) {
        const resolved = await this.resolveFile(requested), file = resolved.target || resolved.path, stat = fs.lstatSync(file);
        if (!stat.isFile() || stat.isSymbolicLink()) fail('upload_regular_file_required');
        const id = await this.journal.parameterMac({ kind: 'upload_grant', target: ref.target, path: file, dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs });
        this.uploadGrants.set(id, { requested, path: file, target: clean(ref.target), dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, expires: Date.now() + 15000 });
        fileCapabilityIds.push(id);
      }
      this.browser.files = this.browserFiles;
      try { return await this.execute(request, { kind: 'upload', ref, fileCapabilityIds }); }
      finally { for (const id of fileCapabilityIds) this.uploadGrants.delete(id); }
    }
    return this.execute(request, this.operation(args, ref));
  }
  async legacyControl(request, args) {
    const windows = await this.desktop.windows();
    const window = windows.find(w => w.window_id === args.window_id) || windows.find(w => w.focused);
    if (!window) fail('target_required');
    const target = await this.hostTarget(window.window_id);
    let actual;
    const adapter = new LegacyCommandAdapter({ commandFor: () => ({ command: request.command, params: args }),
      invokeLegacy: async (_command, params, ctx) => { actual = await this.desktop.control({ ...params, __deadline: Date.now() + ctx.progress.remainingMs() }); return actual; },
      preflight: async (_op, ctx) => ({ eligible: true, revision: ctx.revision, evidence: [], noEffectProven: true }),
      quiesce: async () => { this.desktop.stop(); return { state: 'unknown', ownedInputReleased: false, reasonCodes: ['legacy_input_release_unconfirmed'] }; } });
    this.installAdapter(adapter);
    const effectArgs = { ...args }; delete effectArgs.__deadline; delete effectArgs.observation_id;
    const effectMac = await this.journal.parameterMac(effectArgs);
    const result = await this.execute(request, { kind: 'press', target, chord: `legacy:${args.action}:${effectMac}` });
    return { ...actual, ...result, dispatch_path: actual?.dispatch_path || 'legacy', route: actual?.route || 'legacy_desktop',
      task_success: false, verification: 'The legacy handler acknowledged the request. Its internal effects are unverified; inspect the returned observation.' };
  }
  async batch(request, args) {
    const duplicate = await this.delivery(request); if (duplicate) return duplicate;
    this.requireSession();
    const actions = typeof args.actions === 'string' ? JSON.parse(args.actions) : args.actions;
    if (!Array.isArray(actions) || actions.length < 1 || actions.length > 16 || actions.some(a => !a || Object.getPrototypeOf(a) !== Object.prototype || typeof a.action !== 'string')) fail('invalid_batch');
    const invocation = { deviceId: this.deviceId, runId: this.runId, invokeId: request.invokeId || randomUUID(), command: request.command, params: clean(request.params), deadlineUtcMs: request.deadline };
    const admission = await this.journal.admit(invocation, 8192);
    if (!admission.accepted) fail(admission.failure?.code || 'storage_unavailable');
    const outcomes = []; let stopReason;
    try {
      for (let i = 0; i < actions.length; i++) {
        if (stopReason) { outcomes.push({ index: i, execution: 'skipped', reason: stopReason }); continue; }
        try {
          this.requireSession(); if (Date.now() >= request.deadline) fail('request_expired');
          if (actions[i].action === 'batch') fail('nested_batch_unavailable');
          const step = { ...actions[i], ...(this.session.mode === 'real_desktop' ? { observation_id: this.desktop.observation?.id, window_id: args.window_id || this.desktop.observation?.window_id } : this.session.mode === 'isolated_desktop' ? { observation_id: this.nativeObservation?.id } : { observation_id: this.observation?.id }) };
          const result = await this.control({ ...request, command: 'computer.batch.step', params: step, invokeId: `${invocation.invokeId}:step:${i}` }, step);
          outcomes.push({ index: i, receipt: result.receipt, execution: result.receipt?.execution || 'completed', error: result.error });
          if (result.error || result.receipt?.failure || result.stopped) stopReason = result.error || result.receipt?.failure?.code || 'stopped';
        } catch (error) { stopReason = error.code || 'action_failed'; outcomes.push({ index: i, execution: 'failed', error: stopReason }); }
      }
      const output = { run_id: this.runId, outcomes, completed: outcomes.filter(o => o.execution === 'completed').length,
        task_success: false, ...(stopReason ? { error: stopReason, replay: 'forbidden' } : {}), observation: this.session && !this.controller.signal.aborted ? await this.observe({ __deadline: request.deadline }) : undefined };
      const durable = { planId: invocation.invokeId, execution: stopReason ? 'failed' : 'completed', attempted: outcomes.filter(o => o.execution !== 'skipped').length,
        dispatched: outcomes.filter(o => o.receipt && o.receipt.dispatch !== 'not_started').length, verified: outcomes.filter(o => o.receipt?.effect === 'verified').length,
        skipped: outcomes.filter(o => o.execution === 'skipped').length, checkpointIds: [], stopReason,
        steps: outcomes.map(o => ({ id: o.receipt?.actionId || `${invocation.invokeId}:step:${o.index}`, index: o.index, kind: 'act', execution: o.execution, actionReceipt: o.receipt,
          ...(o.error && !o.receipt?.failure ? { failure: { kind: 'invalid_request', code: o.error, phase: 'batch', effect: 'none_proven', evidenceIds: [], requiredNext: 'read_authoritative_state_do_not_replay' } } : {}) })) };
      await this.journal.finishInvocation(invocation, { receipt: durable, artifacts: [] }); return output;
    } finally { await this.journal.releaseAdmission(invocation).catch(() => {}); }
  }
  async trace(args) {
    const runId = args.run_id || args.runId || this.runId, limit = Number(args.limit || 30), maxBytes = Math.min(32768, Number(args.max_bytes || 16384));
    if (args.action_id || args.actionId) return this.journal.readAction({ runId, actionId: args.action_id || args.actionId, section: args.section || 'attempts', offset: Number(args.offset || 0), limit, maxBytes });
    return this.journal.read({ runId, cursor: args.cursor, limit, maxBytes });
  }
  async diagnose(args = {}) {
    this.requireSession(true);
    if (!this.target) return { read_only: true, task_success: false, error: 'selected_target_required', required_next: 'observe_selected_target' };
    const session = this.session, runId = this.runId, lifecycle = this.lifecycle, epoch = this.epoch, generation = session.generation, target = clean(this.target);
    if (args.window_id && args.window_id !== target.targetId) fail('stale_target');
    const ctx = this.context(Math.min(args.__deadline || Date.now() + 5000, Date.now() + 5000));
    const assertCurrent = () => {
      this.requireSession(true); ctx.progress.check('diagnosis_scope');
      if (this.session !== session || this.runId !== runId || this.lifecycle !== lifecycle || this.epoch !== epoch || session.generation !== generation || !C.sameTarget(this.target, target)) fail('stale_target');
    };
    return diagnoseComputer({ runId, target, ctx, detector: this.coordinator.detector, assertCurrent,
      probes: [{ source: this.browser ? 'dom' : 'atspi', read: async readCtx => {
        const observation = await this.observe({ window_id: target.targetId, detail: 'compact', control_limit: '32', __deadline: Date.now() + Math.max(1, readCtx.progress.remainingMs()) });
        const native = this.lastNativeEvidence;
        const evidence = this.browser ? (this.observation?.state.evidence || []).map(e => state.normalizeBrowserEvidence(e, { refs: this.observation.refs.elements }))
          : !observation.accessibility_status && native?.interval?.startMonoMs >= ctx.progress.start ? [state.normalizeDesktopEvidence(native, { refs: native.nodes.map(n => n.ref) })] : [];
        return { target: this.target, observation, evidence };
      } }] });
  }
  async runResult(args) {
    const runId = args.run_id || this.runId;
    const result = await this.reducer.result(runId);
    if (runId !== this.runId || !this.session || !this.target) return { ...result, currentTarget: { freshness: 'unknown', provenance: 'no_active_selected_target' } };
    const observed = this.observation?.state || this.nativeObservation?.tree || this.lastNativeEvidence;
    const evidence = observed?.evidence || (observed?.facts ? [observed] : []);
    const retained = evidence.find(item => item.acquisition === 'ok' && ['dom', 'atspi'].includes(item.source));
    const observedTarget = observed?.target || retained?.target;
    let freshness = 'unknown';
    if (observedTarget && retained) {
      const revision = observed.revision || retained.revisionAfter;
      const stable = retained.revisionBefore && retained.revisionAfter && C.sameRevision(retained.revisionBefore, retained.revisionAfter);
      const age = clock.now() - retained.interval?.endMonoMs;
      freshness = this.session.state === 'ready' && !this.controller.signal.aborted && C.sameTarget(this.target, observedTarget) &&
        C.sameTarget(observedTarget, retained.target) && C.sameRevision(this.revision(), revision) && C.sameRevision(revision, retained.revisionAfter) &&
        stable && retained.freshness === 'current' && retained.interval?.clockDomain === clock.domain &&
        Number.isFinite(retained.interval?.startMonoMs) && retained.interval.startMonoMs <= retained.interval.endMonoMs &&
        Array.isArray(retained.facts) && retained.facts.length > 0 &&
        age >= 0 && age <= 1000 ? 'current' : 'stale';
    }
    result.currentTarget = { selected: clean(this.target), ...(observedTarget ? { lastObserved: clean(observedTarget) } : {}), freshness,
      provenance: retained?.source || 'no_retained_acquisition', ...(retained?.id ? { evidenceId: retained.id } : {}) };
    const document = retained?.source === 'dom' && retained.facts?.find(fact => fact.predicate === 'document')?.value;
    if (document) result.page = { freshness, provenance: 'retained_dom', ...(typeof document.title === 'string' ? { title: document.title.slice(0, 256) } : {}),
      ...(typeof document.urlDigest === 'string' ? { urlDigest: document.urlDigest } : {}),
      ...(['loading', 'interactive', 'complete'].includes(document.readyState) ? { readyState: document.readyState } : {}) };
    return result;
  }
  async readEvidence(args) { return this.reducer.readEvidence({ runId: args.run_id || this.runId, evidenceId: args.evidence_id }); }
  async startRun(args) {
    this.requireSession(); const requirements = typeof args.requirements === 'string' ? JSON.parse(args.requirements) : args.requirements;
    if (!Array.isArray(requirements) || requirements.length > 32) fail('invalid_requirements');
    for (const predicate of requirements) { C.validatePredicate(predicate); if (!this.registry.has?.(predicate.validator) && !state.BUILTINS.includes(predicate.validator)) fail('unsupported_validator'); if (predicate.target.sessionId !== this.session.id) fail('target_scope_denied'); }
    await this.beginRun(requirements); return { run_id: this.runId, requirements: requirements.map(p => ({ id: p.id, validator: p.validator })), handoff_capability: 'local_only' };
  }
  status() { return { session_id: this.session?.id || null, run_id: this.runId, mode: this.session?.mode,
    state: this.session && this.userPaused || this.browser?.active?.state === 'paused' || this.desktop.paused ? 'paused' : this.session?.state || 'stopped',
    startup_review_required: !!this.startupBlocked, unresolved_actions: this.startupReview?.actions.length || 0,
    control: this.session?.mode === 'real_desktop' ? this.desktop.status() : undefined }; }
  async pause() {
    const transition = this.controlTransition = (this.controlTransition || 0) + 1;
    if (!this.session) return this.status();
    const session = this.session;
    this.userPaused = true;
    this.controller.abort();
    if (session.mode !== 'isolated_desktop') session.state = 'paused';
    this.browser?.pause(); if (session.mode === 'real_desktop') this.desktop.pause();
    if (this.runId) await this.coordinator.pause?.(this.runId);
    if (session.mode === 'isolated_desktop') await this.manager.pause(session.id, 'user_pause');
    else if (session.mode === 'real_desktop') await this.desktopController?.quiesce(this.cleanupContext(session));
    if (this.session !== session || this.controlTransition !== transition) return this.status();
    this.controller = new AbortController();
    if (this.runId) await this.reducer.setExecution(this.runId, 'paused'); this.onChange(); return this.status();
  }
  async resumeByUser() {
    if (!this.session) fail('session_required');
    const session = this.session, lifecycle = this.lifecycle, transition = this.controlTransition = (this.controlTransition || 0) + 1;
    this.userPaused = true;
    const check = () => { if (this.session !== session || this.lifecycle !== lifecycle || this.stopping || this.controlTransition !== transition) fail('stopped_by_user'); };
    if (session.mode === 'isolated_desktop') {
      await this.manager.resumeByUser(session.id, this.manager.issueLocalResumeToken(session.id));
      check();
      this.controller = new AbortController();
      await this.accessibility.start(session, this.context());
    } else if (session.mode === 'real_desktop') {
      await this.desktop.resumeByUser(); check(); if (this.desktop.paused) fail('user_resume_required');
      await this.accessibility.stop();
      check();
      await this.accessibility.start(session, this.context());
    } else await this.browser.resumeByUser(this.context());
    check();
    if (this.runId) this.coordinator.resumeByUser?.(this.runId);
    session.state = 'ready'; this.userPaused = false; this.observation = null; this.nativeObservation = null;
    if (this.runId) await this.reducer.setExecution(this.runId, 'active');
    this.onChange(); return this.status();
  }
  async reviewByUser() {
    await this.ready;
    if (this.startupReview.integrity !== 'complete') fail('history_incomplete');
    await this.stop();
    await this.journal.acknowledgeStartupReview(this.startupReview.throughSeq);
    this.startupBlocked = false; this.onChange();
    return { reviewed: true, previous_effects_verified: false, required_next: 'start_a_new_task_do_not_replay_old_input' };
  }
  isolationStatus() { return { available: !!this.manager, active: this.session?.mode === 'isolated_desktop', missing: this.isolationMissing, message: this.manager ? undefined : 'Separate desktop dependencies are unavailable.' }; }
  async isolationSettings(request) { if (request?.action !== 'prepare') fail('invalid_isolation_action'); if (!this.manager) fail('isolation_unavailable'); return this.start({ scope: 'isolated_desktop', action: 'start', task: 'Prepare separate desktop', __deadline: Date.now() + 30000 }); }
  async action(request, args) {
    const duplicate = await this.delivery(request); if (duplicate) return duplicate;
    const input = typeof args.request === 'string' ? JSON.parse(args.request) : args.request;
    C.fields(input, ['operation', 'expect', 'require', 'requirementIds'], ['operation']);
    input.operation = this.expandRefs(input.operation);
    this.installAdapter(this.browser || this.desktopController);
    return this.execute(request, input.operation, input.operation.kind === 'launchApp' ? { ...input, noObservation: true, route: 'isolated_session', dispatchPath: 'session_launch' } : input);
  }
  expandRefs(operation) {
    const find = id => {
      const refs = this.browser ? this.observation?.refs.elements || [] : this.nativeObservation?.tree.nodes.map(n => n.ref) || this.desktop.observation?.controls.map(c => c.ref).filter(Boolean) || [];
      const ref = refs.find(r => r.id === id); if (!ref) fail('stale_ref'); return ref;
    };
    const output = clean(operation);
    if (typeof output.ref === 'string') output.ref = find(output.ref);
    if (Array.isArray(output.itemRefs)) output.itemRefs = output.itemRefs.map(r => typeof r === 'string' ? find(r) : r);
    if (!output.target && !output.ref) output.target = output.kind === 'launchApp' && this.session?.mode === 'isolated_desktop' ? sessionTarget(this.session) : this.target;
    return output;
  }
  async delivery(request) {
    if (!request.invokeId) return null;
    await this.journal.ready;
    const prior = await this.journal.lookupDelivery(request.invokeId, await this.journal.invocationMac({ command: request.command, params: request.params }));
    if (prior.state === 'new') return null;
    if (prior.state === 'collision') fail('dedup_collision');
    if (prior.state !== 'receipt') fail('unfinished_or_expired_action: inspect the trace; do not replay input');
    return { ...clean(prior.receipt), duplicate_delivery: true };
  }
  async plan(request, args) {
    const duplicate = await this.delivery(request); if (duplicate) return duplicate;
    const input = typeof args.request === 'string' ? JSON.parse(args.request) : args.request;
    if (!input || input.schema !== 'muse.plan.v1') fail('invalid_plan');
    this.requireSession(); const invokeId = request.invokeId || randomUUID();
    this.installAdapter(this.browser || this.desktopController);
    const plan = { ...input, runId: this.runId, invokeId, sessionId: this.session.id };
    for (const step of plan.steps || []) if (step.action) Object.assign(step.action, { runId: this.runId, invokeId, operation: this.expandRefs(step.action.operation) });
    C.validatePlanRequest(plan, this.session.mode);
    for (const step of plan.steps) {
      await this.reducer.validateRequirementIds(plan.runId, step.kind === 'act' ? step.action.requirementIds : step.requirementIds || []);
      for (const predicate of [...(step.predicates || []), ...(step.transition?.predicates || []), ...(step.action?.require || []), ...(step.action?.expect || [])]) {
        if (predicate.requirementId) await this.reducer.validateRequirementIds(plan.runId, [predicate.requirementId]);
      }
    }
    this.prepared.set(invokeId, plan);
    this.invocationAdapters.set(invokeId, this.adapter);
    try {
      const result = await this.coordinator.invoke({ deviceId: this.deviceId, runId: plan.runId, invokeId, command: 'computer.plan', params: clean(request.params), deadlineUtcMs: request.deadline }, this.session);
      for (const step of result.receipt.steps || []) if (step.actionReceipt) {
        const declared = plan.steps[step.index];
        if (declared?.kind !== 'act' || declared.action.actionId !== step.actionReceipt.actionId) fail('action_context_mismatch');
        try { await this.reducer.recordAction(plan.runId, step.actionReceipt, declared.action.requirementIds); }
        catch (error) {
          if (error.code !== 'invalid_request' || step.actionReceipt.dispatch !== 'not_started' || step.actionReceipt.effect !== 'none_proven' || step.actionReceipt.attempts.length) throw error;
          try { await this.reducer.recordRejectedInvocation(plan.runId, step.actionReceipt); }
          catch (failure) { result.handoff_status = 'unavailable'; result.handoff_error = failure.code || 'history_incomplete'; }
        }
      }
      return result;
    }
    finally { this.prepared.delete(invokeId); this.invocationAdapters.delete(invokeId); }
  }
  async stop({ keepConnection = false, startupToken } = {}) {
    this.controlTransition = (this.controlTransition || 0) + 1;
    this.userPaused = false;
    if (startupToken === undefined) this.lifecycle = (this.lifecycle || 0) + 1;
    else if (startupToken !== this.lifecycle) fail('stopped_by_user');
    if (this.stopping) { await this.stopping; if (!keepConnection && this.connected) return this.stop({ keepConnection: false }); return { ended: true }; }
    this.controller.abort(); this.hostRunner.stopSync();
    this.localBrowser?.stop(); this.desktop?.stop?.();
    const current = this.session, runId = this.runId, browser = this.browser, accessibility = this.accessibility, connected = this.connected;
    if (current && current.mode !== 'isolated_desktop') current.state = 'stopped';
    this.session = null; this.grant = null; this.observation = null; this.epoch++;
    this.uploadGrants.clear();
    this.stopping = (async () => {
      if (runId) await this.coordinator.cancel(runId).catch(() => {});
      await accessibility?.stop().catch(() => {});
      if (browser && (!keepConnection || browser !== connected)) await browser.detach(this.cleanupContext(current)).catch(() => {});
      if (!keepConnection && connected) { await connected.detach(this.cleanupContext(current)).catch(() => {}); this.connected = null; this.connectedLease = null; this.picker.clear(); }
      await this.foreign?.stop(this.cleanupContext(current).budget).catch(() => {}); this.foreign = null;
      if (current?.mode === 'isolated_desktop') await this.manager?.stop(current.id, 'user_stop', this.cleanupContext(current).budget).catch(() => {});
      this.accessibility = null; this.browser = null; this.target = null; this.runId = null; this.adapter = null; this.desktopController = null;
      this.nativeObservation = null; this.isolatedWindows = null; this.controller = new AbortController();
      return { ended: true };
    })();
    try { return await this.stopping; } finally { this.stopping = null; }
  }
  cleanupContext(session) {
    const progress = new Progress({ budget: { clockDomain: clock.domain, deadlineMonoMs: clock.now() + 2000 }, clock });
    return { progress, budget: progress.budget, signal: progress.signal, sessionId: session?.id || this.connectionSessionId, revision: this.baseRevision() };
  }
  stopSync() { this.controller.abort(); this.hostRunner.stopSync(); return this.stop().catch(() => {}); }
  async close() { await this.stop(); await this.journal.close(); process.removeListener('exit', this.exit); }
}
module.exports = { ComputerRuntime, clock };
