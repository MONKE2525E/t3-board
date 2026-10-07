'use strict';
const { randomUUID, randomBytes, createHash } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { isDeepStrictEqual } = require('node:util');
const { WorkerChannel } = require('./worker-channel.cjs');
const { fail, check, targetCheck, revisionCheck, validateText, evidence, receipt, boundary, digester } = require('./common.cjs');
/** rootMapper is trusted main-process window-to-AX binding, never model data. */
class AccessibilityClient {
  constructor({ channel = new WorkerChannel(), rootMapper, plainTextPolicy, digestKey = randomBytes(32) } = {}) {
    this.channel = channel; this.rootMapper = rootMapper; this.plainTextPolicy = plainTextPolicy; this.digest = digester(digestKey); this.refs = new Map();
  }
  async start(session, ctx) {
    this.session = session; this.refs.clear();
    const result = await this.channel.start(session, ctx);
    this.generation = this.channel.generation;
    return { ...result, generation: this.generation };
  }
  onInvalidation(listener) { return this.channel.subscribe(listener); }
  scope(target, ctx) { targetCheck(target, this.session, ctx); }
  async discover(target, ctx) {
    this.scope(target, ctx);
    return this.channel.request('discover', { ...target.process }, ctx);
  }
  issue(native, target, ctx, refSetId) {
    const id = randomUUID();
    const fingerprint = this.digest(JSON.stringify([native.busUniqueName, native.objectPath, native.roleCode, native.name]));
    const ref = { id, refSetId, target: structuredClone(target), revision: { ...ctx.revision }, source: 'atspi',
      native: { busUniqueName: native.busUniqueName, objectPath: native.objectPath, rootHandle: native.rootHandle,
        workerGeneration: this.generation, ownerStartToken: native.ownerStartToken },
      identity: { roleCode: native.roleCode, role: native.role, semanticFingerprint: fingerprint }, capabilities: [...native.capabilities] };
    this.refs.set(id, { ref, signature: structuredClone(ref), handle: native.handle, native });
    if (this.refs.size > 8192) { this.refs.delete(this.refs.keys().next().value); }
    return ref;
  }
  stored(ref, ctx) {
    revisionCheck(ref, ctx); this.scope(ref.target, ctx);
    const entry = this.refs.get(ref.id);
    if (!entry || !isDeepStrictEqual(ref, entry.signature) || ref.native.workerGeneration !== this.generation) fail('stale_ref');
    return entry;
  }
  async observe(target, req, ctx) {
    this.scope(target, ctx); check(ctx, 'atspi.observe');
    if (!['visible', 'structural'].includes(req.scope)) fail('invalid_scope');
    const subtree = req.rootRef ? this.stored(req.rootRef, ctx) : undefined;
    if (subtree && !isDeepStrictEqual(req.rootRef.target, target)) fail('stale_ref');
    if (!this.rootMapper) fail('root_mapping_required');
    const binding = await this.rootMapper(target, ctx);
    if (!binding?.busUniqueName?.startsWith(':') || !binding.objectPath?.startsWith('/') ||
        binding.pid !== target.process.pid || binding.startToken !== target.process.startToken || binding.confidence !== 'exact') fail('root_mapping_required');
    const start = performance.now();
    const params = { ...binding, scope: req.scope, maxNodes: req.maxNodes ?? 200, maxDepth: req.maxDepth ?? 12,
      ...(subtree ? { subtreeHandle: subtree.handle } : {}) };
    let result;
    try { result = await this.channel.request('observe', params, ctx); }
    catch (error) {
      if (error.code !== 'read_changed') throw error;
      result = await this.channel.request('observe', params, ctx);
    }
    const refSetId = randomUUID();
    const nodes = result.nodes.map(node => ({ ...node, ref: this.issue(node, target, ctx, refSetId) }));
    const refByHandle = new Map(nodes.map(node => [node.handle, node.ref.id]));
    const ev = evidence(target, ctx, nodes.map(node => ({ kind: 'nativeElement', ref: node.ref, role: node.role,
      roleCode: node.roleCode, name: node.name, states: node.states, actions: node.actions, characterCount: node.characterCount,
      bounds: node.bounds, parentRefId: refByHandle.get(node.parentHandle) })), start,
    { scope: req.scope, complete: result.complete, truncated: result.truncated,
      omissionReasons: result.truncated ? ['native_tree_limit'] : [] });
    // Handles are main-private. Published refs contain the opaque root capability only.
    ev.nodes = nodes.map(({ handle: _handle, parentHandle, ...node }) => ({ ...node, parentRefId: refByHandle.get(parentHandle) })); ev.refSetId = refSetId;
    ev.rootConfidence = result.rootConfidence;
    return ev;
  }
  async resolve(ref, ctx) {
    const entry = this.stored(ref, ctx);
    const live = await this.channel.request('resolve', { handle: entry.handle }, ctx);
    return { ...live, ref, validated: true };
  }
  async renewForRead(ref, ctx) {
    const entry = this.stored(ref, ctx);
    const native = await this.channel.request('renew', { handle: entry.handle }, ctx);
    return this.issue(native, ref.target, ctx, randomUUID());
  }
  async readRaw(ref, ctx) {
    const entry = this.stored(ref, ctx); let offset = 0; let first; const parts = [];
    do {
      check(ctx, 'atspi.readText');
      const page = await this.channel.request('readText', { handle: entry.handle, offset, limitScalars: 16384 }, ctx);
      if (!first) first = page;
      if (page.privateReadHash !== first.privateReadHash || page.totalScalars !== first.totalScalars ||
          page.totalUtf8Bytes !== first.totalUtf8Bytes || page.start !== offset || page.end < offset ||
          (page.end === offset && offset < page.totalScalars)) fail('read_changed');
      if (page.totalUtf8Bytes > 1048576 || Buffer.byteLength(page.text) > 1048576) fail('verification_limit');
      parts.push(page.text); offset = page.end;
    } while (offset < first.totalScalars);
    const text = parts.join('');
    if ([...text].length !== first.totalScalars || Buffer.byteLength(text) !== first.totalUtf8Bytes ||
        createHash('sha256').update(text).digest('hex') !== first.privateReadHash) fail('read_changed');
    return { ...first, text, complete: true, truncated: false };
  }
  async readText(ref, req, ctx, requestRef = ref) {
    // requestRef is an internal correlation alias, validated against the live object.
    if (requestRef !== ref) {
      this.stored(requestRef, ctx); this.stored(ref, ctx);
      if (['busUniqueName', 'objectPath', 'rootHandle', 'workerGeneration', 'ownerStartToken'].some(key =>
        requestRef.native[key] !== ref.native[key]) || !isDeepStrictEqual(requestRef.identity, ref.identity)) fail('readback_identity_mismatch');
    }
    if (!['verify', 'preview', 'page'].includes(req.mode)) fail('invalid_text_read');
    const start = performance.now(); let raw; let actualRef = ref;
    try { raw = await this.readRaw(actualRef, ctx); }
    catch (error) {
      if (!['read_changed', 'dirty_ref'].includes(error.code)) throw error;
      actualRef = await this.renewForRead(ref, ctx); raw = await this.readRaw(actualRef, ctx);
    }
    const digestRef = this.digest(raw.text);
    const scalars = [...raw.text];
    const offset = req.mode === 'verify' ? 0 : (req.offset ?? 0);
    const limit = req.mode === 'verify' ? raw.totalScalars : (req.limitScalars ?? 1000);
    if (!Number.isInteger(offset) || !Number.isInteger(limit) || offset < 0 || offset > scalars.length || limit < 0) fail('invalid_range');
    const end = Math.min(scalars.length, offset + limit);
    const ev = evidence(ref.target, ctx, [{ kind: 'plainText', refId: requestRef.id, privateDigest: digestRef,
      scalarCount: scalars.length, complete: true, expectedPrivateDigest: req.expectedPrivateDigest,
      exactMatch: req.expectedPrivateDigest === undefined ? undefined : req.expectedPrivateDigest === digestRef }], start);
    return { ref: requestRef.id, requestRefId: requestRef.id, renewedRef: actualRef.id === requestRef.id ? undefined : actualRef,
      source: ev.source, interval: ev.interval, totalScalars: scalars.length, totalUtf8Bytes: raw.totalUtf8Bytes,
      returnedRange: [offset, end], rangeUnits: 'atspi_characters', truncated: offset > 0 || end < scalars.length,
      complete: offset === 0 && end === scalars.length, revisionBefore: { ...ctx.revision }, revisionAfter: { ...ctx.revision },
      exactMatch: req.expectedPrivateDigest === undefined ? undefined : req.expectedPrivateDigest === digestRef,
      digestRef, expectedPrivateDigest: req.expectedPrivateDigest, text: req.mode === 'verify' ? undefined : scalars.slice(offset, end).join(''), evidenceId: ev.id, evidence: ev };
  }
  async mutation(ref, primitive, params, ctx) {
    const entry = this.stored(ref, ctx);
    const result = await boundary(ctx, `atspi.${primitive}`, ref.target,
      () => this.channel.request(primitive, { handle: entry.handle, ...params }, ctx));
    return receipt(`atspi.${primitive}`, { acknowledgement: result, primitiveDispatches: result.primitiveDispatches });
  }
  async invoke(ref, actionName, ctx) {
    const live = await this.resolve(ref, ctx);
    if (!live.actions.includes(actionName)) return receipt('atspi.invoke', { execution: 'rejected', dispatch: 'not_started',
      effect: 'none_proven', attempted: false, unavailable: true, code: 'semantic_unavailable' });
    return this.mutation(ref, 'invoke', { actionName }, ctx);
  }
  async focus(ref, ctx) {
    const live = await this.resolve(ref, ctx);
    if (!live.capabilities.includes('focus')) fail('semantic_unavailable');
    return this.mutation(ref, 'focus', {}, ctx);
  }
  async reveal(ref, edge, ctx) {
    if (!['nearest', 'start', 'end'].includes(edge)) fail('invalid_edge');
    const live = await this.resolve(ref, ctx);
    if (!live.capabilities.includes('reveal')) fail('semantic_unavailable');
    return this.mutation(ref, 'reveal', { edge }, ctx);
  }
  async edit(ref, edit, ctx) {
    validateText(edit);
    const live = await this.resolve(ref, ctx);
    if (live.roleCode === 40 || /password/i.test(live.role)) fail('secret_control');
    if (!live.capabilities.includes('editText') || !live.states.includes('editable') || live.states.includes('readOnly')) fail('read_only');
    if (live.states.includes('singleline') && /[\r\n]/u.test(edit.text)) fail('singleline_newline');
    const plainTextAuthorized = this.plainTextPolicy ? await this.plainTextPolicy(ref, live, ctx) : live.role === 'entry';
    if (!plainTextAuthorized) fail('rich_text_unsupported');
    const before = await this.readRaw(ref, ctx);
    if (edit.expectedBefore && (edit.expectedBefore.privateDigest !== this.digest(before.text) ||
        edit.expectedBefore.scalarCount !== before.totalScalars)) fail('text_conflict');
    const chars = [...before.text]; let position = 0; let end = 0; const steps = [];
    if (edit.mode === 'append') position = before.totalScalars;
    if (edit.mode === 'insert') position = before.caret;
    if (edit.mode === 'replaceSelection') {
      if (before.selections.length !== 1 || (edit.selection && !isDeepStrictEqual(edit.selection.ranges, before.selections))) fail('selection_conflict');
      [position, end] = before.selections[0];
    }
    if (!Number.isInteger(position) || position < 0 || position > chars.length || end < 0 || end > chars.length ||
        (edit.mode === 'replaceSelection' && end < position)) fail('invalid_selection');
    const expected = edit.mode === 'replace' ? edit.text : chars.slice(0, position).join('') + edit.text +
      chars.slice(edit.mode === 'replaceSelection' ? end : position).join('');
    const expectedPrivateDigest = this.digest(expected);
    // Trusted action-local expectation is sealed before the first input boundary.
    // The callback receives a digest and identity, never the private full text.
    if (ctx.onTextExpectation) {
      check(ctx, 'atspi.textExpectation');
      await ctx.onTextExpectation({ refId: ref.id, target: structuredClone(ref.target), revision: { ...ctx.revision },
        editMode: edit.mode, expectedPrivateDigest });
      check(ctx, 'atspi.textExpectation');
    }
    const params = { text: edit.text, semantics: edit.semantics, plainTextAuthorized: plainTextAuthorized ? 1 : 0, beforeHash: before.privateReadHash, position, end };
    let currentRef = ref;
    if (edit.mode === 'replaceSelection' && end > position) {
      const deletion = await this.mutation(currentRef, 'delete', { ...params, text: '' }, ctx); steps.push(deletion);
      // Read after clear before a second input. Failure here preserves the completed deletion.
      try {
        currentRef = await this.renewForRead(currentRef, ctx);
        const deleted = await this.readRaw(currentRef, ctx);
        const expectedDeleted = chars.slice(0, position).join('') + chars.slice(end).join('');
        if (deleted.text !== expectedDeleted) fail('selection_delete_mismatch');
        params.beforeHash = deleted.privateReadHash;
      } catch (error) { return receipt('atspi.editText', { execution: 'failed', effect: 'unknown', code: error.code,
        substeps: steps, requiredNext: 'read_authoritative_state' }); }
    }
    try {
      if (edit.mode !== 'replaceSelection' || edit.text !== '') steps.push(await this.mutation(currentRef, edit.mode === 'replace' ? 'replace' : 'insert', params, ctx));
    } catch (error) {
      if (!steps.length) throw error;
      return receipt('atspi.editText', { execution: 'failed', effect: 'partial_verified', code: error.code,
        substeps: steps, requiredNext: 'read_authoritative_state' });
    }
    if (!steps.length) return receipt('atspi.editText', { dispatch: 'not_started', attempted: false, effect: 'none_proven', substeps: [] });
    try {
      currentRef = await this.renewForRead(currentRef, ctx);
      const read = await this.readText(currentRef, { mode: 'verify', expectedPrivateDigest }, ctx, ref);
      return receipt('atspi.editText', { effect: read.exactMatch ? 'verified' : 'unknown',
        execution: read.exactMatch ? 'completed' : 'failed', code: read.exactMatch ? undefined : 'text_mismatch',
        substeps: steps, evidence: [read.evidence], verified: read.exactMatch, readback: { ...read, text: undefined, evidence: undefined },
        renewedRef: read.renewedRef || currentRef });
    } catch (error) {
      return receipt('atspi.editText', { effect: 'unknown', execution: 'completed', substeps: steps,
        code: 'verification_unavailable', verificationReason: error.code, requiredNext: 'read_authoritative_state' });
    }
  }
  async select(parent, children, mode, ctx) {
    if (!['replace', 'add', 'remove'].includes(mode) || children.length > 32) fail('invalid_selection');
    const live = await this.resolve(parent, ctx);
    if (!live.capabilities.includes('select')) fail('semantic_unavailable');
    const entries = children.map(child => this.stored(child, ctx));
    for (const child of children) await this.resolve(child, ctx);
    const steps = []; let currentParent = parent;
    try {
      if (mode === 'replace') {
        steps.push(await this.mutation(currentParent, 'clearSelection', {}, ctx));
        currentParent = await this.renewForRead(currentParent, ctx);
      }
      for (let n = 0; n < entries.length; n++) {
        const child = await this.renewForRead(children[n], ctx);
        steps.push(await this.mutation(currentParent, mode === 'remove' ? 'deselectChild' : 'selectChild',
          { childHandle: this.stored(child, ctx).handle }, ctx));
        currentParent = await this.renewForRead(currentParent, ctx);
      }
      // Verify selected object identities through a fresh structural observation.
      const observed = await this.observe(parent.target, { scope: 'structural', maxNodes: 2000, maxDepth: 12 }, ctx);
      const desired = children.every(child => {
        const found = observed.nodes.find(node => node.busUniqueName === child.native.busUniqueName && node.objectPath === child.native.objectPath);
        return found && found.states.includes('selected') === (mode !== 'remove');
      });
      return receipt('atspi.select', { effect: desired ? 'verified' : 'unknown', substeps: steps, evidence: [observed] });
    } catch (error) {
      if (!steps.length) throw error;
      return receipt('atspi.select', { execution: 'failed', effect: 'unknown', code: error.code, substeps: steps });
    }
  }
  async stop(_ctx) { this.refs.clear(); return this.channel.stop(); }
}
module.exports = { AccessibilityClient };
