'use strict';
const { declarations } = require('./dom.cjs');
const { BrowserFailure, check, timings, id, clock } = require('./support.cjs');
const readMethods = new Set(['Page.enable', 'Page.getFrameTree', 'Page.createIsolatedWorld', 'DOM.enable', 'DOM.describeNode', 'DOM.resolveNode', 'DOM.getFrameOwner', 'Runtime.enable', 'Runtime.getProperties', 'Runtime.callFunctionOn', 'Runtime.releaseObjectGroup', 'Accessibility.enable', 'Accessibility.getFullAXTree']);
const writeMethods = new Set(['Page.navigate', 'Page.handleJavaScriptDialog', 'Input.insertText', 'Input.dispatchKeyEvent', 'Input.dispatchMouseEvent', 'DOM.setFileInputFiles', 'Target.setAutoAttach']);
const events = new Set(['Page.frameAttached', 'Page.frameDetached', 'Page.frameNavigated', 'Page.frameStartedLoading', 'Page.frameStoppedLoading', 'Page.navigatedWithinDocument', 'Page.javascriptDialogOpening', 'Page.javascriptDialogClosed', 'Runtime.executionContextCreated', 'Runtime.executionContextDestroyed', 'Runtime.executionContextsCleared', 'Target.attachedToTarget', 'Target.detachedFromTarget', 'Inspector.detached', 'DOM.documentUpdated', 'Muse.disconnected']);
class CdpBroker {
  #caps = new WeakMap();
  #sessions = new Map();
  constructor({ transport, epoch = 1, now = clock.now }) {
    this.transport = transport; this.epoch = epoch; this.now = now;
    this.listeners = new Set(); this.closed = false;
    this.unsubscribe = transport.subscribe(message => {
      if (message.method === 'Muse.disconnected') { this.closed = true; for (const record of this.#sessions.values()) record.valid = false; }
      for (const entry of this.listeners) {
        const record = this.#caps.get(entry.cap);
        if (!record || (!record.valid && message.method !== 'Muse.disconnected')) continue;
        if (entry.events.has(message.method) && (message.method === 'Muse.disconnected' || message.sessionId === record.sessionId)) entry.listener({ method: message.method, params: message.params || {}, sessionId: message.sessionId || '', connectionEpoch: this.epoch });
      }
    });
  }
  issueRoot(purpose, { targetId, sessionId } = {}) {
    if (!['version', 'picker', 'attach', 'detach'].includes(purpose)) throw new BrowserFailure('root_capability_denied');
    if (purpose === 'detach' && !this.#sessions.has(sessionId)) throw new BrowserFailure('session_lineage_denied');
    if (purpose === 'attach' && !targetId) throw new BrowserFailure('exact_target_required');
    const cap = Object.freeze({ id: id(), kind: 'cdp_capability' });
    this.#caps.set(cap, { root: true, purpose, targetId, sessionId, valid: true, epoch: this.epoch });
    return cap;
  }
  issueSession({ sessionId, target, guard, parentSessionId }) {
    if (!sessionId || this.#sessions.has(sessionId) || (parentSessionId && !this.#sessions.get(parentSessionId)?.valid)) throw new BrowserFailure('session_lineage_denied');
    const cap = Object.freeze({ id: id(), kind: 'cdp_capability' });
    const record = { sessionId, target, guard, valid: true, epoch: this.epoch, frames: new Set(), contexts: new Set(), objects: new Set(), backends: new Set() };
    this.#caps.set(cap, record); this.#sessions.set(sessionId, record);
    return cap;
  }
  registerFrame(cap, frameId) { this.record(cap).frames.add(frameId); }
  clearDocument(cap) { const r = this.record(cap); r.contexts.clear(); r.objects.clear(); r.backends.clear(); }
  revoke(cap) { const r = this.#caps.get(cap); if (r) r.valid = false; }
  record(cap) {
    const record = this.#caps.get(cap);
    if (!record || !record.valid || record.epoch !== this.epoch || this.closed) throw new BrowserFailure('stale_cdp_capability');
    return record;
  }
  validate(record, method, params) {
    if (record.root) {
      const expected = { version: 'Browser.getVersion', picker: 'Target.getTargets', attach: 'Target.attachToTarget', detach: 'Target.detachFromTarget' }[record.purpose];
      if (method !== expected) throw new BrowserFailure('root_method_denied');
      if (record.purpose === 'attach' && (params.targetId !== record.targetId || params.flatten !== true || Object.keys(params).some(k => !['targetId', 'flatten'].includes(k)))) throw new BrowserFailure('target_scope_denied');
      if (record.purpose === 'detach' && (params.sessionId !== record.sessionId || Object.keys(params).length !== 1)) throw new BrowserFailure('session_lineage_denied');
      if (['version', 'picker'].includes(record.purpose) && Object.keys(params).length) throw new BrowserFailure('root_parameters_denied');
      return;
    }
    if (!readMethods.has(method) && !writeMethods.has(method)) throw new BrowserFailure('cdp_method_denied');
    if (params.sessionId || params.targetId) throw new BrowserFailure('session_lineage_denied');
    if (params.frameId && !record.frames.has(params.frameId)) throw new BrowserFailure('frame_scope_denied');
    if (params.executionContextId && !record.contexts.has(params.executionContextId)) throw new BrowserFailure('context_scope_denied');
    if (params.objectId && !record.objects.has(params.objectId)) throw new BrowserFailure('object_scope_denied');
    if (params.backendNodeId && !record.backends.has(params.backendNodeId)) throw new BrowserFailure('node_scope_denied');
    if (method === 'Runtime.callFunctionOn') {
      if (!Object.values(declarations).includes(params.functionDeclaration) || params.returnByValue !== true && params.returnByValue !== false || params.awaitPromise !== true || params.objectGroup !== 'muse-dom' || params.userGesture) throw new BrowserFailure('runtime_source_denied');
      if (!!params.objectId === !!params.executionContextId) throw new BrowserFailure('runtime_context_required');
      if (!Array.isArray(params.arguments) || params.arguments.length > 16) throw new BrowserFailure('runtime_arguments_denied');
      for (const arg of params.arguments) if (!arg || Object.keys(arg).length !== 1 || !Object.hasOwn(arg, 'value') && !record.objects.has(arg.objectId)) throw new BrowserFailure('runtime_arguments_denied');
      if (Buffer.byteLength(JSON.stringify(params.arguments)) > 131072) throw new BrowserFailure('argument_limit');
      if (Object.keys(params).some(k => !['functionDeclaration', 'executionContextId', 'objectId', 'arguments', 'returnByValue', 'awaitPromise', 'objectGroup'].includes(k))) throw new BrowserFailure('runtime_parameters_denied');
    }
    if (method === 'Runtime.getProperties' && (!params.ownProperties || Object.keys(params).some(k => !['objectId', 'ownProperties'].includes(k)))) throw new BrowserFailure('runtime_parameters_denied');
    if (method === 'DOM.resolveNode' && (!params.backendNodeId || !params.executionContextId || params.objectGroup !== 'muse-dom')) throw new BrowserFailure('node_scope_denied');
    if (method === 'Page.createIsolatedWorld' && (params.worldName !== 'muse-dom' || params.grantUniveralAccess || Object.keys(params).some(k => !['frameId', 'worldName'].includes(k)))) throw new BrowserFailure('world_scope_denied');
    if (method === 'Target.setAutoAttach' && (params.autoAttach !== true || params.flatten !== true || params.waitForDebuggerOnStart !== false || JSON.stringify(params.filter) !== JSON.stringify([{ type: 'iframe', exclude: false }, { exclude: true }]))) throw new BrowserFailure('autoattach_scope_denied');
    if (method === 'Page.navigate' && (!params.frameId || typeof params.url !== 'string' || Object.keys(params).some(k => !['frameId', 'url'].includes(k)))) throw new BrowserFailure('navigation_scope_denied');
    if (method === 'DOM.setFileInputFiles' && (!params.backendNodeId || !Array.isArray(params.files) || params.files.length > 16)) throw new BrowserFailure('upload_scope_denied');
    if (method === 'Input.dispatchKeyEvent' && !['keyDown', 'keyUp'].includes(params.type)) throw new BrowserFailure('input_parameters_denied');
    if (method === 'Input.dispatchMouseEvent' && !['mousePressed', 'mouseReleased'].includes(params.type)) throw new BrowserFailure('input_parameters_denied');
  }
  async send(cap, method, params, ctx) {
    check(ctx, this.now);
    const record = this.record(cap); this.validate(record, method, params);
    if (!record.root) await record.guard(ctx, writeMethods.has(method) || ['prepareText', 'focus', 'selectOptions', 'scroll', 'reveal'].some(name => params.functionDeclaration === declarations[name]), method, params);
    check(ctx, this.now); this.record(cap);
    const start = this.now();
    const result = await this.transport.send(method, params, record.root ? undefined : record.sessionId, ctx);
    this.record(cap); check(ctx, this.now);
    if (!record.root) {
      if (result.executionContextId) record.contexts.add(result.executionContextId);
      if (result.object?.objectId) record.objects.add(result.object.objectId);
      if (result.result?.objectId) record.objects.add(result.result.objectId);
      if (Array.isArray(result.result)) for (const property of result.result.slice(0, 256)) if (property.value?.objectId) record.objects.add(property.value.objectId);
      if (result.node?.backendNodeId) record.backends.add(result.node.backendNodeId);
      if (result.backendNodeId) record.backends.add(result.backendNodeId);
    }
    return { result, timings: timings(start, this.now(), ctx) };
  }
  subscribe(cap, requested, listener) {
    const record = this.record(cap);
    if (record.root || requested.some(e => !events.has(e))) throw new BrowserFailure('event_scope_denied');
    const entry = { cap, events: new Set(requested), listener }; this.listeners.add(entry);
    return () => this.listeners.delete(entry);
  }
  close() { this.closed = true; this.unsubscribe(); this.listeners.clear(); for (const r of this.#sessions.values()) r.valid = false; }
}
module.exports = { CdpBroker };
