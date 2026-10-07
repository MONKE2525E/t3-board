'use strict';
const { randomBytes } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const { CdpBroker } = require('./broker.cjs');
const { declarations } = require('./dom.cjs');
const { WebSocketTransport, ElectronDebuggerTransport, resolveEndpoint } = require('./transport.cjs');
const { BrowserFailure, check, timings, safeFailure, privateDigest, scalarText, plainArgs, id, clock } = require('./support.cjs');
const supportedOps = new Set(['query', 'navigate', 'click', 'focus', 'editText', 'press', 'select', 'setChecked', 'scroll', 'reveal', 'upload', 'dialog']);
const mutatingFunctions = new Set(['prepareText', 'focus', 'selectOptions', 'scroll', 'reveal']);
const modalCheckpoints = new Set(['dialog_checkpoint', 'dialog_during_mouse_down', 'dialog_during_key_down']);
const refEqual = isDeepStrictEqual;
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
class BrowserController {
  #tokens = new WeakMap();
  #leases = new Map();
  #refs = new Map();
  #identity = new Map();
  #actions = new Map();
  #retiredChildCaps = new WeakSet();
  constructor({ transport, transportFactory = () => new WebSocketTransport(), policy = {}, files, now = clock.now, digestKey = randomBytes(32), maxNodes = 100, maxVisited = 2000, leaseMs = 180000, fixtureOrigins = [], onEvent = () => {} } = {}) {
    if (maxNodes < 1 || maxNodes > 200 || maxVisited < 1 || maxVisited > 2000 || leaseMs < 1 || leaseMs > 180000) throw new BrowserFailure('invalid_browser_limits');
    this.transport = transport; this.transportFactory = transportFactory; this.policy = policy; this.files = files; this.now = now; this.digestKey = digestKey;
    this.maxNodes = maxNodes; this.maxVisited = maxVisited; this.leaseMs = leaseMs; this.fixtureOrigins = new Set(fixtureOrigins);
    for (const origin of fixtureOrigins) { const u = new URL(origin); if (!['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname) || u.origin !== origin) throw new BrowserFailure('invalid_fixture_origin'); }
    this.onEvent = onEvent; this.tail = Promise.resolve(); this.epoch = 0; this.frames = new Map(); this.childSessions = new Map(); this.pending = new Set(); this.documentEpoch = 0; this.semanticRevision = 0; this.geometryRevision = 0; this.dialog = null; this.dialogWaiters = new Set(); this.inflight = new Set(); this.heldKeys = new Map(); this.heldButtons = new Map(); this.state = 'disconnected';
  }
  async authorize(ctx, action, target) {
    check(ctx, this.now);
    if (!this.policy.authorize || await this.policy.authorize(ctx, { action, target }) !== true) throw new BrowserFailure('permission_denied');
    check(ctx, this.now);
  }
  async connect(req, ctx) {
    const receipt = { connectionId: id(), epoch: ++this.epoch, browserVersion: '', state: 'failed' };
    try {
      if (this.active) throw new BrowserFailure('lease_already_active');
      if (!['chrome_consent', 'owned'].includes(req.mode)) throw new BrowserFailure('unsupported_connection_mode');
      await this.authorize(ctx, 'connect');
      this.broker?.close(); this.transport?.close();
      // An injected transport is privileged local configuration, never supplied by model JSON.
      this.transport = this.transport || this.transportFactory();
      const endpoint = req.endpoint || req.explicitDiscoveryFile ? await resolveEndpoint(req, ctx, { now: this.now }) : req.mode === 'owned' && this.transport instanceof ElectronDebuggerTransport ? undefined : null;
      if (endpoint === null) throw new BrowserFailure('attachment_required');
      await this.transport.connect(endpoint, ctx);
      this.broker = new CdpBroker({ transport: this.transport, epoch: this.epoch, now: this.now });
      const { result } = await this.broker.send(this.broker.issueRoot('version'), 'Browser.getVersion', {}, ctx);
      receipt.browserVersion = String(result.product || '').slice(0, 80);
      if (req.mode === 'chrome_consent' && Number(/(?:Chrome|Chromium)\/(\d+)/.exec(receipt.browserVersion)?.[1] || 0) < 144) throw new BrowserFailure('chrome_consent_version_unavailable');
      this.mode = req.mode; this.connectionId = receipt.connectionId; this.state = 'connected'; receipt.state = 'connected';
    } catch (error) {
      receipt.state = error.code === 'consent_denied' ? 'consent_denied' : /attachment|version/.test(error.code || '') ? 'attachment_required' : 'failed';
      receipt.failure = safeFailure(error); this.state = 'disconnected'; this.transport?.close();
    }
    return receipt;
  }
  async listForLocalPicker(ctx) {
    await this.authorize(ctx, 'local_picker');
    if (this.state !== 'connected') throw new BrowserFailure('attachment_required');
    const { result } = await this.broker.send(this.broker.issueRoot('picker'), 'Target.getTargets', {}, ctx);
    return (result.targetInfos || []).filter(info => info.type === 'page' && !/^(chrome|devtools|chrome-extension):/.test(info.url)).slice(0, 100).map(info => {
      const token = Object.freeze({ id: id(), kind: 'selected_target' });
      this.#tokens.set(token, { targetId: info.targetId, epoch: this.epoch, sessionId: ctx.sessionId });
      let origin = ''; try { origin = new URL(info.url).origin; } catch { /* Only a local display label. */ }
      return { selectionToken: token, displayLabel: `${String(info.title || 'Untitled tab').replace(/[\x00-\x1f]/g, '').slice(0, 100)}${origin !== 'null' ? ` (${origin})` : ''}` };
    });
  }
  async attach(selection, ctx) {
    const selected = this.#tokens.get(selection);
    if (!selected || selected.epoch !== this.epoch || selected.sessionId !== ctx.sessionId) throw new BrowserFailure('invalid_selection_token');
    if (this.active) throw new BrowserFailure('lease_already_active');
    const target = Object.freeze({ sessionId: ctx.sessionId, kind: 'tab', targetId: selected.targetId, generation: 1, ownership: this.mode === 'owned' ? 'owned' : 'borrowed', browserInstance: this.connectionId, connectionEpoch: this.epoch });
    await this.authorize(ctx, 'attach', target);
    // Recheck identity without selecting by title, URL, index, or fallback tab.
    const { result: listing } = await this.broker.send(this.broker.issueRoot('picker'), 'Target.getTargets', {}, ctx);
    if (!listing.targetInfos.some(t => t.targetId === selected.targetId && t.type === 'page')) throw new BrowserFailure('tab_gone');
    const { result } = await this.broker.send(this.broker.issueRoot('attach', { targetId: selected.targetId }), 'Target.attachToTarget', { targetId: selected.targetId, flatten: true }, ctx);
    // The request budget bounds attachment work, not the selected tab's lifetime.
    const lease = Object.freeze({ id: id(), target, grantGeneration: ctx.revision.grantGeneration, expiresMonoMs: this.now() + this.leaseMs });
    this.active = { lease, sessionId: result.sessionId, ctxSessionGeneration: ctx.revision.sessionGeneration, state: 'ready', poisoned: false, unknownPoison: false };
    this.#leases.set(lease.id, this.active); this.frames.clear(); this.childSessions.clear(); this.pending.clear(); this.documentEpoch++;
    const cap = this.broker.issueSession({ sessionId: result.sessionId, target, guard: (context, mutation, method, params) => this.guard(context, mutation, method, params) });
    this.active.cap = cap; this.watch(cap);
    try {
      for (const method of ['Page.enable', 'Runtime.enable', 'DOM.enable']) await this.send(cap, method, {}, ctx);
      await this.send(cap, 'Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true, filter: [{ type: 'iframe', exclude: false }, { exclude: true }] }, ctx);
      await this.refreshFrames(ctx);
      return lease;
    } catch (error) { await this.detachLease(lease, ctx).catch(() => {}); throw error; }
  }
  async guard(ctx, mutation = false, method, params) {
    check(ctx, this.now);
    const active = this.active;
    if (!active || active.state === 'detached' || this.state !== 'connected') throw new BrowserFailure('tab_gone');
    if (ctx.sessionId !== active.lease.target.sessionId || ctx.revision.sessionGeneration !== active.ctxSessionGeneration || ctx.revision.grantGeneration !== active.lease.grantGeneration) throw new BrowserFailure('grant_generation_mismatch');
    if (this.now() >= active.lease.expiresMonoMs) throw new BrowserFailure('lease_expired');
    const release = method === 'Input.dispatchMouseEvent' && params?.type === 'mouseReleased' && this.heldButtons.has(params.button)
      || method === 'Input.dispatchKeyEvent' && params?.type === 'keyUp' && this.heldKeys.has(params.code);
    if (mutation && (active.state !== 'ready' || active.poisoned && method !== 'Page.handleJavaScriptDialog' && !release)) throw new BrowserFailure(active.state === 'paused' ? 'paused' : 'quiescence_unknown');
    await this.authorize(ctx, mutation ? 'mutate' : 'read', active.lease.target);
  }
  target(target) { if (!this.active || !refEqual(target, this.active.lease.target)) throw new BrowserFailure('target_scope_denied'); return this.active.lease.target; }
  lease(lease) { if (!lease || !refEqual(lease, this.active?.lease) || this.#leases.get(lease.id) !== this.active) throw new BrowserFailure('stale_lease'); return this.active; }
  revision(ctx) {
    return { sessionGeneration: ctx.revision.sessionGeneration, grantGeneration: this.active.lease.grantGeneration, connectionEpoch: this.epoch, targetGeneration: this.active.lease.target.generation,
      documentEpoch: this.documentEpoch, semanticRevision: this.semanticRevision, geometryRevision: this.geometryRevision };
  }
  async send(cap, method, params, ctx) {
    try { return (await this.broker.send(cap, method, params, ctx)).result; }
    catch (error) {
      if (error.code === 'cdp_session_gone') {
        const child = Array.from(this.childSessions.values()).find(item => item.cap === cap);
        if (child) this.removeChildSession(child.sessionId);
      }
      if (['cdp_session_gone', 'stale_cdp_capability'].includes(error.code) && this.#retiredChildCaps.has(cap)) Object.defineProperty(error, 'retiredChildSession', { value: true });
      throw error;
    }
  }
  async fn(frame, name, args, ctx, objectId, returnByValue = true) {
    if (!declarations[name]) throw new BrowserFailure('runtime_source_denied');
    const result = await this.send(frame.cap, 'Runtime.callFunctionOn', { functionDeclaration: declarations[name], ...(objectId ? { objectId } : { executionContextId: frame.context }), arguments: plainArgs(args || []), returnByValue, awaitPromise: true, objectGroup: 'muse-dom' }, ctx);
    if (result.exceptionDetails) throw new BrowserFailure('dom_function_failed');
    const value = returnByValue ? result.result?.value : result.result;
    if (returnByValue) this.sampleRevision(frame, value);
    return value;
  }
  sampleRevision(frame, value) {
    for (const [counter, revision] of [['semantic', 'semanticRevision'], ['geometry', 'geometryRevision']]) {
      if (!Number.isSafeInteger(value?.[counter]) || value[counter] < 0) continue;
      const previous = frame[`${counter}Sample`];
      if (previous !== undefined && previous !== value[counter]) this[revision] += Math.max(1, value[counter] - previous);
      frame[`${counter}Sample`] = value[counter];
    }
  }
  watch(cap) {
    this.broker.subscribe(cap, ['Page.frameAttached', 'Page.frameDetached', 'Page.frameNavigated', 'Page.frameStartedLoading', 'Page.frameStoppedLoading', 'Page.navigatedWithinDocument', 'Page.javascriptDialogOpening', 'Page.javascriptDialogClosed', 'Runtime.executionContextDestroyed', 'Runtime.executionContextsCleared', 'Target.attachedToTarget', 'Target.detachedFromTarget', 'Inspector.detached', 'DOM.documentUpdated', 'Muse.disconnected'], event => {
      const p = event.params;
      if (['Muse.disconnected', 'Inspector.detached'].includes(event.method)) { this.state = 'disconnected'; if (this.active) this.active.poisoned = true; this.#refs.clear(); }
      if (event.method === 'Target.attachedToTarget') this.childSessions.set(p.sessionId, { ...p.targetInfo, sessionId: p.sessionId, parentCap: cap });
      if (event.method === 'Target.detachedFromTarget') this.removeChildSession(p.sessionId);
      if (event.method === 'Page.frameStartedLoading') { this.pending.add(p.frameId); this.documentEpoch++; }
      if (event.method === 'Page.frameStoppedLoading') this.pending.delete(p.frameId);
      if (event.method === 'Page.frameDetached') { this.frames.delete(p.frameId); this.pending.delete(p.frameId); this.documentEpoch++; }
      if (['Page.frameNavigated', 'Page.navigatedWithinDocument'].includes(event.method)) {
        const frameId = p.frame?.id || p.frameId; const f = this.frames.get(frameId);
        if (f) { f.context = null; f.loader = p.frame?.loaderId || f.loader; f.urlExact = p.frame ? `${p.frame.url || ''}${p.frame.urlFragment || ''}` : p.url; f.epoch++; }
        this.documentEpoch++; this.semanticRevision++; this.#refs.clear();
      }
      if (event.method === 'Runtime.executionContextsCleared' || event.method === 'DOM.documentUpdated') {
        for (const f of this.frames.values()) if (f.cap === cap) f.context = null;
        try { this.broker.clearDocument(cap); } catch { /* Disconnection already invalidates all capabilities. */ }
        this.documentEpoch++; this.#refs.clear();
      }
      if (event.method === 'Runtime.executionContextDestroyed') for (const f of this.frames.values()) if (f.context === p.executionContextId) { f.context = null; f.epoch++; this.documentEpoch++; this.#refs.clear(); }
      if (event.method === 'Page.javascriptDialogOpening') { this.dialog = { id: id(), type: p.type, sessionId: event.sessionId, cap, epoch: this.documentEpoch, openedMonoMs: this.now() }; for (const waiter of this.dialogWaiters) waiter(); }
      if (event.method === 'Page.javascriptDialogClosed') this.dialog = null;
      this.onEvent({ kind: event.method, target: this.active?.lease.target, revision: this.documentEpoch, dialogId: this.dialog?.id });
    });
  }
  removeChildSession(sessionId) {
    const retired = new Set([sessionId]);
    for (const currentId of retired) {
      const child = this.childSessions.get(currentId);
      if (child?.cap) {
        for (const descendant of this.childSessions.values()) if (descendant.parentCap === child.cap) retired.add(descendant.sessionId);
        this.#retiredChildCaps.add(child.cap); this.broker.revoke(child.cap);
      }
      this.childSessions.delete(currentId);
    }
    for (const [key, frame] of this.frames) if (retired.has(frame.sessionId)) { this.frames.delete(key); this.pending.delete(key); }
    this.documentEpoch++; this.#refs.clear();
  }
  async refreshFrames(ctx) {
    await this.guard(ctx);
    const collect = async (cap, sessionId) => {
      const tree = await this.send(cap, 'Page.getFrameTree', {}, ctx);
      const present = new Set();
      const visit = (node, parentId) => {
        if (!node?.frame) return;
        const frame = node.frame;
        present.add(frame.id);
        let f = this.frames.get(frame.id);
        if (f && f.sessionId !== sessionId && Array.from(this.childSessions.values()).some(c => c.targetId === frame.id && c.cap && c.sessionId === f.sessionId)) {
          for (const child of node.childFrames || []) visit(child, frame.id);
          return;
        }
        if (!f || f.sessionId !== sessionId) {
          f = { id: frame.id, parentId: frame.parentId || parentId || f?.parentId, cap, sessionId, context: null, loader: frame.loaderId, epoch: (f?.epoch || 0) + 1, urlExact: `${frame.url || ''}${frame.urlFragment || ''}` };
          this.frames.set(frame.id, f);
        } else if (frame.loaderId && f.loader !== frame.loaderId) { f.loader = frame.loaderId; f.epoch++; f.context = null; this.documentEpoch++; }
        f.urlExact = `${frame.url || ''}${frame.urlFragment || ''}`;
        this.broker.registerFrame(cap, frame.id);
        for (const child of node.childFrames || []) visit(child, frame.id);
      };
      const child = this.childSessions.get(sessionId);
      visit(tree.frameTree, child?.parentFrameId || child?.parentId);
      // A new document's authoritative frame tree replaces the old tree. Do not
      // keep detached same-process frames until a delayed event happens to arrive.
      for (const [key, frame] of this.frames) if (frame.sessionId === sessionId && !present.has(key)) {
        this.frames.delete(key); this.pending.delete(key); this.documentEpoch++; this.#refs.clear();
      }
      return tree.frameTree?.frame.id;
    };
    this.mainFrameId = await collect(this.active.cap, this.active.sessionId);
    // Auto-attach is confined to iframe descendants; unrelated page targets never acquire a capability.
    for (const child of this.childSessions.values()) {
      // Chrome may omit an OOPIF from the parent's frame tree. The confined
      // auto-attach event still supplies its exact, already-known parent frame.
      if (child.type !== 'iframe' || !child.cap && !this.frames.has(child.targetId) && !this.frames.has(child.parentFrameId || child.parentId)) continue;
      try {
        if (!child.cap) {
          child.cap = this.broker.issueSession({ sessionId: child.sessionId, target: this.active.lease.target, guard: (context, mutation, method, params) => this.guard(context, mutation, method, params), parentSessionId: this.broker.record(child.parentCap).sessionId });
          this.watch(child.cap);
          for (const method of ['Page.enable', 'Runtime.enable', 'DOM.enable']) await this.send(child.cap, method, {}, ctx);
          await this.send(child.cap, 'Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true, filter: [{ type: 'iframe', exclude: false }, { exclude: true }] }, ctx);
        }
        await collect(child.cap, child.sessionId);
      } catch (error) {
        if (error.code !== 'cdp_session_gone' && !(error.code === 'stale_cdp_capability' && !this.childSessions.has(child.sessionId))) throw error;
        // The selected page remains leased. Only its confirmed dead child is
        // retired; this is a read reconciliation, never an input retry.
        this.removeChildSession(child.sessionId);
      }
    }
    const omissions = [];
    for (const frame of this.frames.values()) {
      if (frame.context) continue;
      try {
        const { executionContextId } = await this.send(frame.cap, 'Page.createIsolatedWorld', { frameId: frame.id, worldName: 'muse-dom' }, ctx);
        frame.context = executionContextId;
        await this.fn(frame, 'install', [], ctx); await this.fn(frame, 'installMetadata', [], ctx);
      } catch (error) {
        if (/cancel|deadline|permission|grant/.test(error.code || '')) throw error;
        omissions.push(frame.id);
      }
    }
    return omissions;
  }
  frameRef(frame) { return { tab: this.active.lease.target, frameId: frame.id, frameGeneration: frame.epoch, documentToken: frame.loader || `pending-${frame.epoch}`, executionContextId: String(frame.context), cdpSessionId: frame.sessionId }; }
  validateQuery(query) {
    if (!query) return { scope: 'visible', exact: true, limit: this.maxNodes };
    if (!['visible', 'structural'].includes(query.scope) || !Number.isInteger(query.limit) || query.limit < 1 || query.limit > this.maxNodes || typeof query.exact !== 'boolean' || query.name && (typeof query.name !== 'string' || query.name.length > 256) || query.role && (typeof query.role !== 'string' || query.role.length > 64) || Object.keys(query.states || {}).some(k => !['visible', 'enabled', 'readonly', 'checked', 'selected', 'editable', 'focused'].includes(k))) throw new BrowserFailure('invalid_semantic_query');
    return query;
  }
  evidence(source, ctx, start, facts, coverage = {}, acquisition = 'ok', before) {
    const revision = this.revision(ctx); const evidenceId = id();
    const crossed = before ? Object.keys(revision).filter(key => before[key] !== revision[key]) : [];
    return { id: evidenceId, source, producer: 'muse.direct-cdp', target: this.active.lease.target, revisionBefore: before || revision, revisionAfter: revision,
      interval: { startMonoMs: start, endMonoMs: this.now(), clockDomain: ctx.budget.clockDomain, utc: new Date().toISOString() }, acquisition,
      freshness: this.pending.size || acquisition !== 'ok' || crossed.length ? 'unknown' : 'current', reasons: [...(this.pending.size ? ['pending_navigation'] : []), ...crossed.map(key => `crossed_${key}`)],
      coverage: { scope: 'selected_tab', complete: false, truncated: false, omittedFrames: [], omissionReasons: ['closed_shadow_roots_not_observable'], ...coverage },
      facts: facts.map(f => ({ ...f, evidenceIds: [evidenceId] })), derivedFrom: [] };
  }
  poison(error) {
    if (!this.active) return;
    this.active.poisoned = true;
    if (modalCheckpoints.has(error.code) && this.dialog && !this.active.unknownPoison) this.active.dialogRecoveryId = this.dialog.id;
    else { this.active.unknownPoison = true; this.active.dialogRecoveryId = null; }
  }
  dialogEvidence(ctx, dialog, state) {
    const proof = this.evidence('lifecycle', ctx, this.now(), [{ predicate: 'dialog.state', value: { dialogId: dialog.id, state, related: true, relatedTargetId: this.active.lease.target.targetId }, suitability: 'authoritative' }], { scope: 'exact_dialog', complete: true, omissionReasons: [] });
    // Dialog open/closed events describe the selected session directly. Pending
    // page loading does not make that exact modal event a DOM readiness claim.
    const current = state === 'open' ? this.dialog === dialog && dialog.epoch === this.documentEpoch : this.dialog === null;
    proof.freshness = current ? 'current' : 'unknown'; proof.reasons = current ? [] : ['dialog_event_changed'];
    return proof;
  }
  serial(work) { const next = this.tail.catch(() => {}).then(work); this.tail = next.catch(() => {}); return next; }
  observe(req, ctx) { return this.serial(() => this.observeInternal(req, ctx)); }
  async observeInternal(req, ctx) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const observation = await this.captureObservation(req, ctx);
        if (observation.state.evidence[0].freshness === 'current' || attempt === 1) return observation;
      } catch (error) {
        if (attempt === 1 || !this.lifecycleReadFailure(error)) throw error;
        this.invalidateReadContexts();
      }
    }
  }
  lifecycleReadFailure(error) { return error.retiredChildSession === true || ['cdp_context_gone', 'cdp_frame_gone', 'cdp_object_gone', 'context_scope_denied', 'observation_crossed_document'].includes(error.code); }
  invalidateReadContexts() {
    const caps = new Set();
    for (const frame of this.frames.values()) { frame.context = null; frame.epoch++; caps.add(frame.cap); }
    for (const cap of caps) this.broker.clearDocument(cap);
    this.documentEpoch++; this.#refs.clear();
  }
  async captureObservation(req, ctx) {
    this.lease(req.lease); await this.guard(ctx);
    const start = this.now(); const omittedFrames = await this.refreshFrames(ctx);
    const query = this.validateQuery(req.query); const refSetId = id(); const before = this.revision(ctx); const elements = []; const records = [];
    let truncated = false; const frameStates = [];
    const chosen = req.frame ? [this.frames.get(req.frame.frameId)] : Array.from(this.frames.values());
    if (req.frame && (!chosen[0] || !refEqual(req.frame, this.frameRef(chosen[0])))) throw new BrowserFailure('wrong_frame_context');
    let rootRecord;
    if (query.rootRefId) rootRecord = this.#refs.get(query.rootRefId);
    if (query.rootRefId && !rootRecord) throw new BrowserFailure('stale_ref');
    for (const frame of chosen) {
      if (!frame?.context || elements.length >= query.limit) { truncated = true; continue; }
      if (rootRecord && rootRecord.frame.id !== frame.id) continue;
      const rootObject = rootRecord ? await this.resolve(rootRecord.ref, ctx) : await this.fn(frame, 'documentObject', [], ctx, null, false);
      const array = await this.fn(frame, 'scan', [query, query.limit - elements.length, this.maxVisited], ctx, rootObject.objectId, false);
      const props = await this.send(frame.cap, 'Runtime.getProperties', { objectId: array.objectId, ownProperties: true }, ctx);
      const summary = await this.fn(frame, 'summary', [], ctx); summary.urlDigest = this.urlDigest(summary.url); summary.url = this.safeUrl(summary.url); frameStates.push({ frameId: frame.id, ...summary });
      truncated ||= !!summary.scan.truncated;
      for (const property of props.result || []) {
        if (!/^\d+$/.test(property.name) || !property.value?.objectId || elements.length >= query.limit) continue;
        const objectId = property.value.objectId;
        const [description, meta] = await Promise.all([this.send(frame.cap, 'DOM.describeNode', { objectId, depth: 0 }, ctx), this.fn(frame, 'metadata', [], ctx, objectId)]);
        if (!meta.connected || meta.secret) continue;
        const backendNodeId = description.node.backendNodeId; const identityKey = `${frame.sessionId}:${frame.id}:${frame.epoch}:${backendNodeId}`;
        let objectToken = this.#identity.get(identityKey); if (!objectToken) { objectToken = id(); this.#identity.set(identityKey, objectToken); }
        const capabilities = ['click', 'focus', 'reveal'];
        if (meta.editable) capabilities.push('editText', 'readText', 'press');
        if (meta.tag === 'select') capabilities.push('select');
        if (['checkbox', 'radio'].includes(meta.role)) capabilities.push('setChecked');
        if (meta.type === 'file') capabilities.push('upload');
        if (meta.scrollableX || meta.scrollableY) capabilities.push('scroll');
        const ref = { id: id(), refSetId, target: this.active.lease.target, revision: {}, source: 'dom', frame: this.frameRef(frame), browser: { backendNodeId, objectToken }, identity: { role: meta.role, semanticFingerprint: privateDigest(this.digestKey, JSON.stringify([meta.role, meta.name, meta.tag, meta.type])) }, capabilities };
        elements.push(ref); records.push({ ref, frame, meta, identityKey });
      }
    }
    // Resample all participating worlds after resolving nodes. A DOM change in an
    // earlier frame must not authorize refs assembled from mixed revisions.
    for (const frame of chosen) if (frame?.context) await this.fn(frame, 'summary', [], ctx);
    const revision = this.revision(ctx);
    if (before.documentEpoch !== revision.documentEpoch) throw new BrowserFailure('observation_crossed_document');
    const stable = refEqual(before, revision) && !this.pending.size;
    if (!stable) { elements.length = 0; records.length = 0; }
    for (const record of records) { record.ref.revision = { ...revision }; this.#refs.set(record.ref.id, { ...record, ref: structuredClone(record.ref) }); }
    if (this.#refs.size > 2000) { const retained = new Map(records.map(r => [r.ref.id, this.#refs.get(r.ref.id)])); this.#refs = retained; }
    if (this.#identity.size > 4000) this.#identity.clear();
    const main = frameStates.find(f => f.frameId === this.mainFrameId) || frameStates[0];
    const facts = [{ predicate: 'document', value: { currentUrl: main?.url, urlDigest: main?.urlDigest, title: main?.title, headings: main?.headings, visibleHeadings: main?.visibleHeadings, textExcerpt: main?.textExcerpt, readyState: main?.readyState, frames: frameStates.map(f => ({ frameId: f.frameId, url: f.url, headings: f.headings })), dialog: this.dialog ? { id: this.dialog.id, type: this.dialog.type } : null }, suitability: 'dom_state' },
      { predicate: 'elements', value: records.map(r => ({ refId: r.ref.id, role: r.meta.role, name: r.meta.name, ...(r.meta.role === 'heading' ? { headingText: r.meta.headingText } : {}), ...(r.meta.navigation ? { navigation: r.meta.navigation } : {}), states: { visible: r.meta.visible, enabled: r.meta.enabled, readonly: r.meta.readonly, checked: r.meta.checked, selected: r.meta.selected, focused: r.meta.focused }, valuePreview: r.meta.valuePreview, valueUtf16: r.meta.valueUtf16, rect: r.meta.rect })), suitability: 'semantic_query' }];
    const evidence = [this.evidence('dom', ctx, start, facts, { scope: query.scope, truncated, omittedFrames, omissionReasons: ['closed_shadow_roots_not_observable', ...(omittedFrames.length ? ['frame_context_unavailable'] : [])] }, 'ok', before)];
    if (main) evidence.push(this.evidence('lifecycle', ctx, start, [{ predicate: 'navigation', value: { urlDigest: main.urlDigest, visibleHeadings: main.visibleHeadings, documentReady: !this.pending.size && ['interactive', 'complete'].includes(main.readyState) }, suitability: 'navigation_state' }], { scope: 'main_frame_document', complete: true, omissionReasons: [] }, 'ok', before));
    for (const source of req.sources || []) if (source !== 'dom' && source !== 'lifecycle') evidence.push(this.evidence(source, ctx, start, [], { omissionReasons: ['source_unavailable'] }, 'unsupported'));
    return { id: id(), state: { target: this.active.lease.target, revision, evidence, assertions: [], disagreements: [], allowedRoutes: ['direct_cdp'], pendingNavigation: this.pending.size > 0 }, refs: { id: refSetId, target: this.active.lease.target, revision, elements }, artifacts: [] };
  }
  safeUrl(value) { try { const url = new URL(value); url.username = ''; url.password = ''; url.search = ''; url.hash = ''; return url.href.slice(0, 2048); } catch { return 'unavailable'; } }
  // Main-private predicate construction; never expose as a model-selected hash API.
  privateDigest(value) { if (typeof value !== 'string') throw new BrowserFailure('invalid_digest_input'); return privateDigest(this.digestKey, value); }
  urlDigest(value) { return privateDigest(this.digestKey, new URL(value).href); }
  async resolve(ref, ctx) {
    await this.guard(ctx); this.target(ref?.target);
    const record = this.#refs.get(ref?.id);
    if (!record || !refEqual(record.ref, ref)) throw new BrowserFailure('stale_ref');
    const frame = this.frames.get(ref.frame.frameId);
    if (!frame?.context || !refEqual(ref.frame, this.frameRef(frame)) || ref.revision.documentEpoch !== this.documentEpoch || ref.revision.sessionGeneration !== ctx.revision.sessionGeneration || ref.revision.grantGeneration !== ctx.revision.grantGeneration) throw new BrowserFailure('wrong_frame_context');
    const result = await this.send(frame.cap, 'DOM.resolveNode', { backendNodeId: ref.browser.backendNodeId, executionContextId: frame.context, objectGroup: 'muse-dom' }, ctx);
    if (!result.object?.objectId) throw new BrowserFailure('detached_node');
    const meta = await this.fn(frame, 'metadata', [], ctx, result.object.objectId);
    if (!meta?.connected) throw new BrowserFailure('detached_node');
    if (meta.secret) throw new BrowserFailure('secret_control');
    if (privateDigest(this.digestKey, JSON.stringify([meta.role, meta.name, meta.tag, meta.type])) !== ref.identity.semanticFingerprint) throw new BrowserFailure('semantic_identity_changed');
    if (meta.composition) throw new BrowserFailure('composition_busy');
    return { objectId: result.object.objectId, frame, meta, record };
  }
  capabilities(target) {
    this.target(target); const caps = Object.fromEntries(Array.from(supportedOps, k => [k, { supported: true }]));
    return { ...caps, browser_ax: { supported: false, reason: 'browser_ax_not_integrated' }, pixels: { supported: false, reason: 'screenshot_capture_not_integrated' }, downloadStatus: { supported: false, reason: 'normal_download_guid_correlation_unavailable' }, closedShadow: { supported: false, reason: 'closed_shadow_root' }, transformedFramePointer: { supported: false, reason: 'transformed_iframe_hit_test_unverified' }, richText: { supported: false, reason: 'dedicated_rich_editor_required' }, activateWindow: { supported: false, reason: 'borrowed_target_activation_forbidden' } };
  }
  async preflight(op, ctx) {
    let eligible = false; let error;
    try {
      if (!supportedOps.has(op.kind)) throw new BrowserFailure('operation_unavailable');
      await this.guard(ctx, op.kind !== 'query', op.kind === 'dialog' ? 'Page.handleJavaScriptDialog' : undefined);
      if (op.target) this.target(op.target);
      if (this.dialog && op.kind !== 'dialog' && op.kind !== 'query') throw new BrowserFailure('dialog_checkpoint');
      if (op.ref) {
        const resolved = await this.resolve(op.ref, ctx);
        if (!op.ref.capabilities.includes(op.kind === 'editText' ? 'editText' : op.kind) && op.kind !== 'press') throw new BrowserFailure('element_operation_unavailable');
        if (op.kind !== 'reveal' && op.kind !== 'scroll' && op.kind !== 'upload' && (!resolved.meta.enabled || resolved.meta.readonly && ['editText', 'select', 'setChecked'].includes(op.kind))) throw new BrowserFailure('element_not_editable');
        if (['click', 'setChecked'].includes(op.kind)) await this.actionable(resolved, ctx);
        if (op.kind === 'editText') this.validateEdit(op.edit, resolved.meta);
      }
      if (op.kind === 'navigate') await this.navigationAllowed(op.url, ctx);
      if (op.kind === 'dialog' && (!this.dialog || this.dialog.id !== op.dialogId || !['accept', 'dismiss'].includes(op.decision))) throw new BrowserFailure('dialog_scope_denied');
      eligible = true;
    } catch (failure) { error = failure; }
    return { eligible, revision: this.revision(ctx), evidence: [], noEffectProven: true, ...(error ? { failure: safeFailure(error) } : {}) };
  }
  validateEdit(edit, meta) {
    if (!edit || !['replace', 'append', 'insert', 'replaceSelection'].includes(edit.mode) || edit.semantics !== 'plain_text' || !['forbid', 'isolated_only'].includes(edit.clipboard) || !['literal_multiline', 'reject_singleline'].includes(edit.newlinePolicy)) throw new BrowserFailure('invalid_text_edit');
    scalarText(edit.text);
    if (!meta.editable || !meta.enabled || meta.readonly) throw new BrowserFailure('element_not_editable');
    if (!meta.multiline && /[\n\r]/.test(edit.text)) throw new BrowserFailure('singleline_newline');
    if (edit.selection && (edit.selection.units !== 'dom_utf16' || !Number.isInteger(edit.selection.start) || !Number.isInteger(edit.selection.end) || edit.selection.start < 0 || edit.selection.end < edit.selection.start)) throw new BrowserFailure('selection_unavailable');
  }
  async navigationAllowed(url, ctx) {
    let parsed; try { parsed = new URL(url); } catch { throw new BrowserFailure('invalid_navigation'); }
    if (parsed.username || parsed.password || !['https:', 'http:'].includes(parsed.protocol) || url.length > 8192) throw new BrowserFailure('navigation_policy_denied');
    if (this.fixtureOrigins.has(parsed.origin)) return;
    if (parsed.protocol !== 'https:' || !this.policy.allowNavigation || await this.policy.allowNavigation(parsed.href, ctx) !== true) throw new BrowserFailure('navigation_policy_denied');
  }
  async actionable(resolved, ctx) {
    const { frame, objectId, meta } = resolved;
    if (!meta.enabled || !meta.visible) throw new BrowserFailure('element_not_actionable');
    const first = await this.fn(frame, 'hitTest', [], ctx, objectId);
    if (!first.ok) throw new BrowserFailure(first.reason);
    if (!await this.fn(frame, 'stableFrame', [], ctx, objectId)) throw new BrowserFailure('unstable_geometry');
    const second = await this.fn(frame, 'hitTest', [], ctx, objectId);
    if (!second.ok || JSON.stringify(first.rect) !== JSON.stringify(second.rect)) throw new BrowserFailure(second.reason || 'unstable_geometry');
    if (frame.id !== this.mainFrameId) throw new BrowserFailure('frame_pointer_unavailable');
    return second;
  }
  async effect(receipt, primitive, substep, cap, method, params, ctx, fn) {
    await this.guard(ctx, true, method, params);
    if (!ctx.dispatch?.beforeEffect || !ctx.dispatch?.afterEffect) throw new BrowserFailure('dispatch_recorder_required');
    const start = this.now();
    const handle = await ctx.dispatch.beforeEffect({ primitive, substep, target: receipt.target });
    const attempt = { id: handle.id, primitive, substep, target: receipt.target, dispatch: 'possible', effect: 'unknown', evidenceIds: [], timings: timings(start, this.now(), ctx) };
    receipt.attempts.push(attempt); receipt.dispatch = 'possible'; receipt.effect = 'unknown';
    try {
      if (method === 'Input.dispatchMouseEvent' && params.type === 'mousePressed') this.heldButtons.set(params.button, { cap, params });
      if (method === 'Input.dispatchKeyEvent' && params.type === 'keyDown') this.heldKeys.set(params.code, { cap, params });
      const pending = fn ? fn() : this.send(cap, method, params, ctx);
      this.inflight.add(pending);
      const clear = () => { this.inflight.delete(pending); if (method === 'Input.dispatchMouseEvent' && params.type === 'mouseReleased') this.heldButtons.delete(params.button); if (method === 'Input.dispatchKeyEvent' && params.type === 'keyUp') this.heldKeys.delete(params.code); };
      pending.then(clear, () => this.inflight.delete(pending));
      let wake;
      const checkpoint = new Promise((_resolve, reject) => { wake = () => reject(new BrowserFailure('dialog_checkpoint', 'dispatch', 'unknown')); });
      if (method?.startsWith('Input.') || method === 'Page.navigate') this.dialogWaiters.add(wake);
      let result;
      try { result = await Promise.race([pending, checkpoint]); }
      finally { this.dialogWaiters.delete(wake); }

      attempt.dispatch = 'acknowledged'; receipt.dispatch = 'acknowledged';
      await ctx.dispatch.afterEffect(handle, { state: 'accepted', noEffectProven: false });
      attempt.timings = timings(start, this.now(), ctx);
      return result;
    } catch (error) {
      attempt.failure = safeFailure(error, 'unknown'); attempt.timings = timings(start, this.now(), ctx);
      receipt.failure = attempt.failure; this.poison(error);
      await ctx.dispatch.afterEffect(handle, { state: 'lost', noEffectProven: false, failure: attempt.failure }).catch(() => {});
      throw error;
    }
  }
  async perform(op, ctx) {
    const key = `${ctx.runId}:${ctx.invokeId}:${ctx.actionId || ''}`;
    const mac = privateDigest(this.digestKey, JSON.stringify(canonical(op)));
    const prior = this.#actions.get(key);
    if (prior) {
      if (prior.mac !== mac) throw new BrowserFailure('action_id_collision');
      return structuredClone(await prior.promise);
    }
    if (this.#actions.size >= 2048) throw new BrowserFailure('adapter_dedup_full');
    const entry = { mac, promise: null }; this.#actions.set(key, entry);
    entry.promise = this.serial(() => this.executeOperation(op, ctx));
    return structuredClone(await entry.promise);
  }
  async executeOperation(op, ctx) {
    const start = this.now();
    const receipt = { target: this.active?.lease.target, before: this.active ? this.revision(ctx) : ctx.revision, dispatch: 'not_started', effect: 'none_proven', attempts: [], evidence: [], timings: timings(start, start, ctx) };
    let closedDialog;
    try {
      const preflight = await this.preflight(op, ctx);
      if (!preflight.eligible) { receipt.failure = preflight.failure; return receipt; }
      let resolved = op.ref ? await this.resolve(op.ref, ctx) : null;
      const frame = resolved?.frame || this.frames.get(this.mainFrameId);
      const mutateFn = async (name, args) => {
        if (!mutatingFunctions.has(name)) throw new BrowserFailure('mutation_function_denied');
        return this.effect(receipt, `DOM.${name}`, name, frame.cap, null, null, ctx, () => this.fn(frame, name, args, ctx, resolved.objectId));
      };
      const mutate = (method, params, substep = method) => this.effect(receipt, method, substep, frame.cap, method, params, ctx);
      if (op.kind === 'query') {
        const obs = await this.observeInternal({ lease: this.active.lease, sources: ['dom'], query: op.query }, ctx); receipt.evidence = obs.state.evidence; receipt.observation = obs;
      } else if (op.kind === 'navigate') {
        const result = await mutate('Page.navigate', { url: op.url, frameId: this.mainFrameId }, 'navigate');
        if (result.errorText) throw new BrowserFailure('navigation_failed', 'navigation', 'unknown');
        await this.waitReady(ctx, async () => {
          await this.refreshFrames(ctx); const f = this.frames.get(this.mainFrameId); if (!f?.context) return false;
          // A ready old document is not proof of the newly accepted navigation.
          if (result.loaderId && f.loader !== result.loaderId) return false;
          try {
            const state = await this.fn(f, 'summary', [], ctx); return !this.pending.size && ['interactive', 'complete'].includes(state.readyState);
          } catch (error) {
            if (!this.lifecycleReadFailure(error)) throw error;
            this.invalidateReadContexts(); return false;
          }
        });
        await this.refreshFrames(ctx);
        let navigationEvidence;
        for (let attempt = 0; attempt < 2; attempt++) {
          const readBefore = this.revision(ctx); const readStart = this.now();
          const currentFrame = this.frames.get(this.mainFrameId);
          const state = await this.fn(currentFrame, 'summary', [], ctx);
          await this.navigationAllowed(state.url, ctx);
          navigationEvidence = this.evidence('lifecycle', ctx, readStart, [{ predicate: 'navigation', value: { requestedUrlDigest: this.urlDigest(op.url), urlDigest: this.urlDigest(state.url), visibleHeadings: state.visibleHeadings, documentReady: !this.pending.size && ['interactive', 'complete'].includes(state.readyState) }, suitability: 'navigation_state' }], { scope: 'main_frame_document', complete: true, omissionReasons: [] }, 'ok', readBefore);
          if (navigationEvidence.freshness === 'current') break;
        }
        receipt.evidence = [navigationEvidence];
        if (navigationEvidence.freshness !== 'current') throw new BrowserFailure('read_crossed_revision', 'verify', 'unknown');
        receipt.effect = 'verified';
      } else if (op.kind === 'editText') {
        await this.editOperation(resolved, op.edit, receipt, ctx);
      } else if (op.kind === 'click' || op.kind === 'setChecked') {
        if (op.kind === 'setChecked' && resolved.meta.checked === op.checked) {
          receipt.evidence = [this.evidence('dom', ctx, start, [{ predicate: 'checked', value: { refId: op.ref.id, checked: op.checked }, suitability: 'exact_state' }])];
        } else {
          const point = await this.actionable(resolved, ctx); const button = op.kind === 'setChecked' ? 'left' : op.button;
          if (!['left', 'right', 'middle'].includes(button)) throw new BrowserFailure('invalid_button');
          await mutate('Input.dispatchMouseEvent', { type: 'mousePressed', button, buttons: button === 'left' ? 1 : button === 'right' ? 2 : 4, clickCount: 1, x: point.x, y: point.y }, 'mouse_down');
          // A modal between down/up is a checkpoint. Never send another click or choose automatically.
          if (this.dialog) { if (this.active) this.active.poisoned = true; throw new BrowserFailure('dialog_during_mouse_down', 'dispatch', 'unknown'); }
          await mutate('Input.dispatchMouseEvent', { type: 'mouseReleased', button, buttons: 0, clickCount: 1, x: point.x, y: point.y }, 'mouse_up');
          if (op.kind === 'setChecked') {
            const after = await this.fn(frame, 'metadata', [], ctx, resolved.objectId);
            if (after.checked !== op.checked) throw new BrowserFailure('checked_mismatch', 'verify', 'unknown');
            receipt.evidence = [this.evidence('dom', ctx, start, [{ predicate: 'checked', value: { refId: op.ref.id, checked: after.checked }, suitability: 'exact_state' }])]; receipt.effect = 'verified';
          }
        }
      } else if (op.kind === 'focus') {
        await mutateFn('focus', []);
        let focusEvidence;
        for (let attempt = 0; attempt < 2; attempt++) {
          const before = this.revision(ctx); const readStart = this.now();
          const live = await this.fn(frame, 'metadata', [], ctx, resolved.objectId);
          focusEvidence = this.evidence('dom', ctx, readStart, [{ predicate: 'focused', value: { refId: op.ref.id, focused: live.focused === true }, suitability: 'exact_state' }], { scope: 'exact_element', complete: true, omissionReasons: [] }, 'ok', before);
          if (focusEvidence.freshness === 'current') break;
        }
        receipt.evidence = [focusEvidence];
        if (focusEvidence.freshness !== 'current') throw new BrowserFailure('read_crossed_revision', 'verify', 'unknown');
        if (!focusEvidence.facts[0].value.focused) throw new BrowserFailure('focus_mismatch', 'verify', 'unknown');
        receipt.effect = 'verified';
      } else if (op.kind === 'press') {
        if (!resolved) throw new BrowserFailure('press_ref_required');
        await mutateFn('focus', []);
        const key = this.key(op.chord);
        await mutate('Input.dispatchKeyEvent', { type: 'keyDown', ...key }, 'key_down');
        if (this.dialog) { if (this.active) this.active.poisoned = true; throw new BrowserFailure('dialog_during_key_down', 'dispatch', 'unknown'); }
        await mutate('Input.dispatchKeyEvent', { type: 'keyUp', ...key }, 'key_up');
      } else if (op.kind === 'select') {
        const current = await this.fn(frame, 'optionValues', [], ctx, resolved.objectId);
        if (!Array.isArray(current) || !['replace', 'add', 'remove'].includes(op.mode) || !Array.isArray(op.itemRefs) || op.itemRefs.length > 100) throw new BrowserFailure('select_unavailable');
        const values = [];
        for (const ref of op.itemRefs) {
          const child = await this.resolve(ref, ctx);
          if (child.frame.id !== frame.id || child.meta.tag !== 'option') throw new BrowserFailure('select_item_scope_denied');
          const result = await this.send(frame.cap, 'Runtime.callFunctionOn', { functionDeclaration: declarations.optionBelongs, objectId: resolved.objectId, arguments: [{ objectId: child.objectId }], returnByValue: true, awaitPromise: true, objectGroup: 'muse-dom' }, ctx);
          if (!result.result?.value) throw new BrowserFailure('select_item_scope_denied');
          values.push((await this.fn(frame, 'optionInfo', [], ctx, child.objectId)).value);
        }
        const desired = op.mode === 'replace' ? values : op.mode === 'add' ? Array.from(new Set([...current, ...values])) : current.filter(v => !values.includes(v));
        await mutateFn('selectOptions', [desired]);
        const after = await this.fn(frame, 'optionValues', [], ctx, resolved.objectId);
        if (!refEqual(after.slice().sort(), desired.slice().sort())) throw new BrowserFailure('select_mismatch', 'verify', 'unknown');
        receipt.effect = 'verified'; receipt.evidence = [this.evidence('dom', ctx, start, [{ predicate: 'selection', value: { refId: op.ref.id, selectedCount: after.length }, suitability: 'exact_state' }])];
      } else if (op.kind === 'scroll') {
        if (!['x', 'y'].includes(op.axis) || !Number.isFinite(op.delta) || Math.abs(op.delta) > 10000 || !resolved.meta[op.axis === 'x' ? 'scrollableX' : 'scrollableY']) throw new BrowserFailure('scroll_container_required');
        const result = await mutateFn('scroll', [op.axis, op.delta]); receipt.effect = 'verified';
        receipt.evidence = [this.evidence('dom', ctx, start, [{ predicate: 'scroll', value: { refId: op.ref.id, axis: op.axis, ...result }, suitability: 'scroll_position' }])];
      } else if (op.kind === 'reveal') {
        if (!['nearest', 'start', 'end'].includes(op.edge)) throw new BrowserFailure('invalid_reveal');
        await mutateFn('reveal', [op.edge]); const hit = await this.fn(frame, 'hitTest', [], ctx, resolved.objectId);
        receipt.effect = hit.ok ? 'verified' : 'unknown'; receipt.evidence = [this.evidence('dom', ctx, start, [{ predicate: 'revealed', value: { refId: op.ref.id, visibleAtPoint: hit.ok, reason: hit.reason }, suitability: 'visibility' }])];
      } else if (op.kind === 'upload') {
        if (resolved.meta.type !== 'file' || !this.files?.resolveApproved || !Array.isArray(op.fileCapabilityIds) || op.fileCapabilityIds.length > 16 || !op.fileCapabilityIds.length) throw new BrowserFailure('approved_file_capability_required');
        const paths = [];
        for (const capabilityId of op.fileCapabilityIds) {
          const file = await this.files.resolveApproved(capabilityId, { target: receipt.target, ctx });
          if (!file || typeof file.path !== 'string' || !file.path.startsWith('/') || file.symlinkSafe !== true || file.approved !== true || !Number.isSafeInteger(file.size) || file.size < 0) throw new BrowserFailure('approved_file_capability_required');
          paths.push(file.path);
        }
        await mutate('DOM.setFileInputFiles', { backendNodeId: op.ref.browser.backendNodeId, files: paths }, 'set_approved_files');
        const value = await this.fn(frame, 'filesRead', [], ctx, resolved.objectId);
        if (value.count !== paths.length) throw new BrowserFailure('upload_readback_mismatch', 'verify', 'unknown');
        receipt.effect = 'verified'; receipt.evidence = [this.evidence('dom', ctx, start, [{ predicate: 'file_input', value: { refId: op.ref.id, count: value.count, sizes: value.sizes, serverUploadVerified: false }, suitability: 'input_file_selection' }])];
      } else if (op.kind === 'dialog') {
        const dialog = this.dialog;
        if (op.text !== undefined) scalarText(op.text);
        await this.effect(receipt, 'Page.handleJavaScriptDialog', 'explicit_dialog_decision', dialog.cap, 'Page.handleJavaScriptDialog', { accept: op.decision === 'accept', ...(op.text !== undefined ? { promptText: op.text } : {}) }, ctx);
        await this.waitReady(ctx, async () => this.dialog !== dialog, 'dialog_close_unconfirmed');
        // A previously sent mouse-up/key-up can finish only after the modal
        // closes. Drain it first so it is never sent a second time as cleanup.
        await this.waitReady(ctx, async () => this.inflight.size === 0, 'dialog_input_drain_unconfirmed');
        // Only release keys/buttons this adapter recorded, after the user's
        // explicit dialog decision. Never replay the original input.
        for (const [button, held] of this.heldButtons) await this.effect(receipt, 'Input.dispatchMouseEvent', 'release_owned_button', held.cap, 'Input.dispatchMouseEvent', { ...held.params, type: 'mouseReleased', buttons: 0, button }, ctx);
        for (const held of this.heldKeys.values()) await this.effect(receipt, 'Input.dispatchKeyEvent', 'release_owned_key', held.cap, 'Input.dispatchKeyEvent', { ...held.params, type: 'keyUp' }, ctx);
        await this.waitReady(ctx, async () => this.inflight.size === 0 && this.heldButtons.size === 0 && this.heldKeys.size === 0, 'dialog_input_drain_unconfirmed');
        if (this.dialog) throw new BrowserFailure('dialog_checkpoint', 'dispatch', 'unknown');
        receipt.evidence = [this.dialogEvidence(ctx, dialog, 'closed'), this.evidence('lifecycle', ctx, start, [{ predicate: 'dialog_decision', value: { dialogId: dialog.id, decision: op.decision }, suitability: 'acknowledged_decision' }])];
        if (!this.active.unknownPoison && this.active.dialogRecoveryId === dialog.id) { this.active.poisoned = false; this.active.dialogRecoveryId = null; }
        closedDialog = dialog;
      }
      receipt.after = this.revision(ctx);
      // Every action includes fresh selected-tab DOM state when no blocking modal prevents it.
      if (!this.dialog && !this.active.poisoned) {
        const observation = await this.observeInternal({ lease: this.active.lease, sources: ['dom'] }, ctx);
        receipt.evidence.push(...observation.state.evidence); receipt.observation = observation;
      }
      if (closedDialog) {
        receipt.evidence = receipt.evidence.filter(e => !e.facts.some(f => f.predicate === 'dialog.state' && f.value.state === 'closed'));
        receipt.evidence.push(this.dialogEvidence(ctx, closedDialog, 'closed'));
        receipt.after = this.revision(ctx);
      }
    } catch (error) {
      receipt.failure ||= safeFailure(error, receipt.attempts.length ? 'unknown' : 'none_proven');
      if (receipt.attempts.length && receipt.effect !== 'verified') { receipt.effect = 'unknown'; this.poison(error); }
      else if (!receipt.attempts.length) receipt.effect = 'none_proven';
      if (modalCheckpoints.has(error.code) && this.dialog) receipt.evidence.push(this.dialogEvidence(ctx, this.dialog, 'open'));
    } finally { receipt.timings = timings(start, this.now(), ctx); }
    return receipt;
  }
  async editOperation(resolved, edit, receipt, ctx) {
    this.validateEdit(edit, resolved.meta);
    const { frame, objectId } = resolved;
    const initial = await this.fn(frame, 'textRead', [1048576], ctx, objectId);
    if (initial.unavailable || typeof initial.text !== 'string') throw new BrowserFailure(initial.unavailable || 'verification_unavailable');
    if (edit.expectedBefore && (edit.expectedBefore.scalarCount !== Array.from(initial.text).length || edit.expectedBefore.privateDigest !== privateDigest(this.digestKey, initial.text))) throw new BrowserFailure('text_precondition_mismatch');
    let start, end;
    if (edit.mode === 'replace') { start = 0; end = initial.text.length; }
    else if (edit.mode === 'append') { start = end = initial.text.length; }
    else if (edit.selection) { start = edit.selection.start; end = edit.selection.end; }
    else { start = initial.start; end = edit.mode === 'insert' ? initial.start : initial.end; }
    if (!Number.isInteger(start) || !Number.isInteger(end) || end > initial.text.length || start < 0 || end < start || /[\uD800-\uDBFF]/.test(initial.text[start - 1] || '') && /[\uDC00-\uDFFF]/.test(initial.text[start] || '') || /[\uD800-\uDBFF]/.test(initial.text[end - 1] || '') && /[\uDC00-\uDFFF]/.test(initial.text[end] || '')) throw new BrowserFailure('selection_unavailable');
    const expected = initial.text.slice(0, start) + edit.text + initial.text.slice(end);
    if (ctx.onTextExpectation !== undefined) {
      if (typeof ctx.onTextExpectation !== 'function') throw new BrowserFailure('invalid_text_expectation_callback');
      await ctx.onTextExpectation({ refId: resolved.record.ref.id, target: receipt.target, revision: { ...ctx.revision }, editMode: edit.mode, expectedPrivateDigest: this.privateDigest(expected) });
    }
    const prepared = await this.effect(receipt, 'DOM.prepareText', 'focus_and_select_exact_field', frame.cap, null, null, ctx, () => this.fn(frame, 'prepareText', [start, end], ctx, objectId));
    if (!prepared.focused) throw new BrowserFailure('focus_mismatch', 'preparation', 'unknown');
    if (edit.text === '') {
      if (start !== end) {
        await this.effect(receipt, 'Input.dispatchKeyEvent', 'empty_delete_down', frame.cap, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 }, ctx);
        await this.effect(receipt, 'Input.dispatchKeyEvent', 'empty_delete_up', frame.cap, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 }, ctx);
      }
    } else await this.effect(receipt, 'Input.insertText', 'bulk_text_insert', frame.cap, 'Input.insertText', { text: edit.text }, ctx);
    let after;
    await this.waitReady(ctx, async () => {
      // Never resolve a replacement element by name. A controlled rerender that replaces identity is unavailable.
      const live = await this.resolve(resolved.record.ref, ctx);
      after = await this.fn(frame, 'textRead', [1048576], ctx, live.objectId);
      return !after.unavailable && after.text === expected;
    }, 'text_readback_mismatch');
    let readStart, readBefore;
    for (let attempt = 0; attempt < 2; attempt++) {
      readBefore = this.revision(ctx); readStart = this.now();
      after = await this.fn(frame, 'textRead', [1048576], ctx, objectId);
      if (after.unavailable || after.text !== expected) throw new BrowserFailure(after.unavailable || 'text_readback_mismatch', 'verify', 'unknown');
      if (readBefore.semanticRevision === this.semanticRevision && readBefore.documentEpoch === this.documentEpoch) break;
      if (attempt === 1) throw new BrowserFailure('read_crossed_revision', 'verify', 'unknown');
    }
    receipt.effect = 'verified';
    const fact = { refId: resolved.record.ref.id, expectedPrivateDigest: privateDigest(this.digestKey, expected), actualPrivateDigest: privateDigest(this.digestKey, after.text), exactMatch: after.text === expected, complete: true, totalScalars: Array.from(after.text).length, totalUtf16Units: after.text.length, totalUtf8Bytes: Buffer.byteLength(after.text), serverPersistenceVerified: false };
    receipt.evidence.push(this.evidence('dom', ctx, readStart, [{ predicate: 'text_exact', value: fact, suitability: 'full_text_readback' }], { scope: 'exact_element_text', complete: true, omissionReasons: [] }, 'ok', readBefore));
  }
  async waitReady(ctx, predicate, code = 'readiness_timeout') {
    let polls = 0;
    while (polls++ < 256) {
      check(ctx, this.now);
      if (await predicate()) return;
      const remaining = ctx.budget.deadlineMonoMs - this.now();
      if (remaining <= 0) break;
      // Adaptive predicate polling, clipped by the one caller budget. No unconditional post-input sleep.
      await new Promise((resolve, reject) => {
        const abort = () => { clearTimeout(timer); ctx.signal.removeEventListener('abort', abort); reject(new BrowserFailure('cancelled')); };
        const timer = setTimeout(() => { ctx.signal.removeEventListener('abort', abort); resolve(); }, Math.min(remaining, Math.min(50, 5 + polls * 2)));
        ctx.signal.addEventListener('abort', abort, { once: true });
      });
    }
    throw new BrowserFailure(code, 'settle', 'unknown');
  }
  key(chord) {
    if (typeof chord !== 'string' || chord.length > 64) throw new BrowserFailure('invalid_key_chord');
    const parts = chord.split('+'); let modifiers = 0;
    for (const modifier of parts.slice(0, -1)) { const bit = { Alt: 1, Ctrl: 2, Meta: 4, Shift: 8 }[modifier]; if (!bit) throw new BrowserFailure('invalid_key_chord'); modifiers |= bit; }
    const key = parts.at(-1); const special = { Enter: ['Enter', 13], Tab: ['Tab', 9], Backspace: ['Backspace', 8], Delete: ['Delete', 46], Escape: ['Escape', 27], ArrowLeft: ['ArrowLeft', 37], ArrowUp: ['ArrowUp', 38], ArrowRight: ['ArrowRight', 39], ArrowDown: ['ArrowDown', 40], Home: ['Home', 36], End: ['End', 35], PageUp: ['PageUp', 33], PageDown: ['PageDown', 34], Space: ['Space', 32] }[key];
    if (special) return { key: key === 'Space' ? ' ' : key, code: special[0], windowsVirtualKeyCode: special[1], modifiers };
    if (/^[a-zA-Z]$/.test(key) && modifiers) return { key, code: `Key${key.toUpperCase()}`, windowsVirtualKeyCode: key.toUpperCase().charCodeAt(0), modifiers };
    throw new BrowserFailure('key_chord_unavailable');
  }
  edit(ref, edit, ctx) { return this.perform({ kind: 'editText', ref, edit }, ctx); }
  readText(ref, req, ctx) { return this.serial(() => this.readTextInternal(ref, req, ctx)); }
  async readTextInternal(ref, req, ctx) {
    const start = this.now(); const before = this.revision(ctx); const resolved = await this.resolve(ref, ctx);
    const read = await this.fn(resolved.frame, 'textRead', [1048576], ctx, resolved.objectId);
    const receipt = { ref: ref.id, truncated: false, complete: false, revisionBefore: before, revisionAfter: this.revision(ctx), evidenceId: id(), interval: { startMonoMs: start, endMonoMs: this.now(), clockDomain: ctx.budget.clockDomain } };
    if (read.unavailable || !refEqual(before, receipt.revisionAfter)) return { ...receipt, unavailableReason: read.unavailable || 'read_crossed_revision' };
    const scalars = Array.from(read.text); receipt.totalScalars = scalars.length; receipt.totalUtf16Units = read.text.length; receipt.totalUtf8Bytes = Buffer.byteLength(read.text);
    receipt.digestRef = privateDigest(this.digestKey, read.text);
    if (req.mode === 'verify') { receipt.complete = true; if (req.expectedPrivateDigest) receipt.exactMatch = receipt.digestRef === req.expectedPrivateDigest; }
    else if (['preview', 'page'].includes(req.mode)) {
      const offset = req.mode === 'preview' ? 0 : req.offset || 0; const limit = req.limitScalars ?? 1000;
      if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 4096) throw new BrowserFailure('invalid_text_range');
      receipt.text = scalars.slice(offset, offset + limit).join(''); receipt.returnedRange = [offset, Math.min(scalars.length, offset + limit)]; receipt.rangeUnits = 'unicode_scalars'; receipt.truncated = offset > 0 || offset + limit < scalars.length; receipt.complete = !receipt.truncated;
    } else throw new BrowserFailure('invalid_text_read');
    receipt.timings = timings(start, this.now(), ctx); return receipt;
  }
  async probe(_predicates, target, ctx) { this.target(target); return (await this.observe({ lease: this.active.lease, sources: ['dom'] }, ctx)).state.evidence; }
  pause() { if (this.active) { this.active.state = 'paused'; this.#refs.clear(); this.documentEpoch++; } }
  async resumeByUser(ctx) { await this.authorize(ctx, 'local_user_resume', this.active?.lease.target); if (this.inflight.size || this.heldKeys.size || this.heldButtons.size) throw new BrowserFailure('quiescence_unknown'); if (this.active) { this.active.poisoned = false; this.active.unknownPoison = false; this.active.dialogRecoveryId = null; this.active.state = 'ready'; this.documentEpoch++; } }
  async quiesce(_ctx) { if (this.active) this.active.state = 'paused'; return { state: this.active?.poisoned ? 'unknown' : 'confirmed', ownedInputReleased: !this.active?.poisoned, reasonCodes: this.active?.poisoned ? ['potential_inflight_input'] : [] }; }
  async detachLease(lease, ctx) {
    const active = this.lease(lease); active.state = 'detached'; this.#refs.clear(); this.documentEpoch++;
    const quiescence = { state: active.poisoned ? 'unknown' : 'confirmed', ownedInputReleased: !active.poisoned, reasonCodes: active.poisoned ? ['potential_inflight_input'] : [] };
    let detached = false;
    try { await this.broker.send(this.broker.issueRoot('detach', { sessionId: active.sessionId }), 'Target.detachFromTarget', { sessionId: active.sessionId }, ctx); detached = true; }
    catch { quiescence.state = 'unknown'; quiescence.reasonCodes.push('detach_ack_unavailable'); }
    finally { this.broker.close(); this.transport.close(); this.active = null; this.state = 'disconnected'; }
    return { leaseId: lease.id, detached, browserCloseSent: false, quiescence };
  }
  async detach(ctx) { if (this.active) await this.detachLease(this.active.lease, ctx); else { this.broker?.close(); this.transport?.close(); this.state = 'disconnected'; } }
}
module.exports = { BrowserController, CdpBroker, WebSocketTransport, ElectronDebuggerTransport, BrowserFailure };
