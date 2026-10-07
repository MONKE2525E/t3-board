const { performance } = require('node:perf_hooks');
const { clone, id, fail, assertId, sameTarget, changedFences, eligibility, isDeepStrictEqual, boundedRead } = require('./evidence.cjs');
const { assertTransform, transformPoint } = require('./coordinates.cjs');

function semanticIdentity(ref) {
  return { target: ref.target, source: ref.source, frame: ref.frame, native: ref.native, browser: ref.browser, identity: ref.identity, capabilities: ref.capabilities };
}
function validateCandidate(ref, state) {
  if (!ref || !['dom', 'browser_ax', 'atspi'].includes(ref.source) || !sameTarget(ref.target, state.target) || !ref.identity?.role || !ref.identity.semanticFingerprint || !Array.isArray(ref.capabilities)) throw fail('invalid_element_candidate', 'invalid_request');
  if (ref.source === 'atspi') {
    const n = ref.native;
    if (!n || !/^:[0-9]+\.[0-9]+$/.test(n.busUniqueName) || !/^\/(?:[A-Za-z0-9_]+\/?)*$/.test(n.objectPath) || !n.rootHandle || !Number.isSafeInteger(n.workerGeneration) || n.workerGeneration < 0 || n.ownerStartToken !== state.target.process?.startToken) throw fail('native_identity_unproven');
  } else {
    if (!ref.browser || !Number.isSafeInteger(ref.browser.backendNodeId) || ref.browser.backendNodeId <= 0 || !ref.browser.objectToken || !ref.frame || !sameTarget(ref.frame.tab, state.target)
      || !Number.isSafeInteger(ref.frame.frameGeneration) || ref.frame.frameGeneration < 0 || !ref.frame.frameId || !ref.frame.documentToken || !ref.frame.executionContextId || !ref.frame.cdpSessionId) throw fail('browser_identity_unproven');
  }
  if (changedFences(ref.revision, state.revision, ref.source).length) throw fail('candidate_revision_mismatch');
}

class RefStore {
  constructor({ getCurrent, revalidate, readCalibration, now = () => performance.now(), makeId = id, maxRefs = 4096, maxTransforms = 128 } = {}) {
    if (typeof getCurrent !== 'function' || !Number.isInteger(maxRefs) || maxRefs < 1 || maxRefs > 16384 || !Number.isInteger(maxTransforms) || maxTransforms < 1 || maxTransforms > 1024) throw fail('ref_configuration_required', 'invalid_request');
    this.getCurrent = getCurrent; this.revalidate = revalidate; this.readCalibration = readCalibration; this.now = now; this.makeId = makeId;
    this.maxRefs = maxRefs; this.maxTransforms = maxTransforms;
    this.refs = new Map(); this.transforms = new Map(); this.sets = new Map();
  }
  issue(state) {
    const current = this.getCurrent(state.target);
    if (!sameTarget(current.target, state.target) || !isDeepStrictEqual(current.revision, state.revision)) throw fail('state_no_longer_current');
    const candidates = [];
    for (const e of state.evidence) {
      if (!eligibility(e, state.target, state.revision, current.clockDomain).eligible || !state.allowedRoutes.includes(e.source)) continue;
      for (const fact of e.facts) if (fact.predicate === 'element.ref' && ['deterministic', 'authoritative'].includes(fact.suitability)) {
        const ref = clone(fact.value); validateCandidate(ref, state);
        if (ref.source !== e.source) throw fail('ref_source_mismatch');
        candidates.push({ ref, evidence: e });
      }
    }
    // Only the exact current generation/revision/object identities may share a stable ref set.
    const signature = JSON.stringify({ target: state.target, revision: state.revision, identities: candidates.map(c => semanticIdentity(c.ref)) });
    const existing = this.sets.get(signature);
    if (existing && existing.elements.every(ref => this.refs.has(ref.id))) {
      existing.elements.forEach((ref, index) => {
        const entry = this.refs.get(ref.id);
        entry.evidence = [clone(candidates[index].evidence)]; entry.providerRef = clone(candidates[index].ref);
      });
      return clone(existing);
    }
    const set = { id: this.makeId('refset'), target: clone(state.target), revision: clone(state.revision), elements: [] };
    for (const candidate of candidates) {
      const ref = { ...candidate.ref, id: this.makeId('ref'), refSetId: set.id, revision: clone(state.revision) };
      this.refs.set(ref.id, { ref: clone(ref), providerRef: clone(candidate.ref), evidence: [clone(candidate.evidence)] }); set.elements.push(ref);
    }
    this.sets.set(signature, clone(set));
    while (this.refs.size > this.maxRefs) this.refs.delete(this.refs.keys().next().value);
    while (this.sets.size > this.maxRefs) this.sets.delete(this.sets.keys().next().value);
    return clone(set);
  }
  registerTransform(transform, evidence) {
    const t = assertTransform(transform);
    const current = this.getCurrent(t.target);
    if (!evidence || evidence.source !== 'pixels' || !eligibility(evidence, current.target, current.revision, current.clockDomain).eligible || evidence.artifact?.captureId !== t.captureId || evidence.artifact?.transformId !== t.id
      || changedFences(t.revision, current.revision, 'pixels').length) throw fail('transform_evidence_mismatch');
    this.transforms.set(t.id, { transform: t, evidence: clone(evidence) });
    while (this.transforms.size > this.maxTransforms) this.transforms.delete(this.transforms.keys().next().value);
    return clone(t);
  }
  hasTransform(transformId, captureId) {
    const entry = this.transforms.get(transformId);
    if (!entry || entry.transform.captureId !== captureId) return false;
    const current = this.getCurrent(entry.transform.target);
    return sameTarget(current.target, entry.transform.target) && changedFences(entry.transform.revision, current.revision, 'pixels').length === 0;
  }
  predicateForAdapter(predicate) {
    const p = clone(predicate), entry = this.refs.get(p.args?.refId);
    if (entry) p.args.refId = entry.providerRef.id;
    return p;
  }
  issueCoordinate({ captureId, transformId, point, space }) {
    const entry = this.transforms.get(transformId);
    if (!entry || entry.transform.captureId !== captureId) throw fail('transform_unavailable');
    const t = entry.transform, current = this.getCurrent(t.target);
    if (!sameTarget(current.target, t.target) || changedFences(t.revision, current.revision, 'pixels').length) throw fail('transform_stale');
    const ref = { captureId, transformId, target: clone(t.target), revision: clone(t.revision), point: clone(point), space };
    transformPoint(t, ref);
    return ref;
  }
  async resolve(ref, ctx) {
    if (ref?.captureId !== undefined) return this.resolveCoordinate(ref, ctx);
    assertId(ref?.id);
    const entry = this.refs.get(ref.id);
    if (!entry || !isDeepStrictEqual(entry.ref, ref)) throw fail('ref_unknown_or_modified');
    const current = this.getCurrent(ref.target);
    if (ctx.sessionId !== ref.target.sessionId || !sameTarget(current.target, ref.target) || changedFences(ref.revision, current.revision, ref.source).length
      || changedFences(ctx.revision, current.revision, ref.source).length) throw fail('ref_revision_stale');
    if (!entry.evidence.every(e => eligibility(e, current.target, current.revision, current.clockDomain).eligible)) throw fail('ref_evidence_stale');
    if (typeof this.revalidate !== 'function') throw fail('live_ref_validation_unavailable', 'backend_unavailable');
    const live = await boundedRead(child => this.revalidate(clone(entry.providerRef), child), ctx, { now: this.now, maxMs: 750, phase: 'ref_preflight' });
    const after = this.getCurrent(ref.target);
    if (!live || !sameTarget(after.target, ref.target) || changedFences(current.revision, after.revision, ref.source).length || !isDeepStrictEqual(semanticIdentity(live.ref), semanticIdentity(ref))
      || changedFences(live.revision, after.revision, ref.source).length || !Array.isArray(live.evidence) || !live.evidence.length || live.evidence.some(e => !eligibility(e, after.target, after.revision, after.clockDomain).eligible)) throw fail('live_ref_identity_changed');
    // Return the adapter-issued canonical capability after validation. Adapters retain their own handle maps.
    return { ref: clone(entry.providerRef), revision: clone(after.revision), evidence: clone(live.evidence) };
  }
  async resolveCoordinate(ref, ctx) {
    const entry = this.transforms.get(ref.transformId);
    if (!entry || entry.transform.captureId !== ref.captureId) throw fail('transform_unavailable');
    const t = entry.transform, current = this.getCurrent(t.target);
    if (ctx.sessionId !== t.target.sessionId || !sameTarget(ref.target, t.target) || !sameTarget(current.target, t.target) || !isDeepStrictEqual(ref.revision, t.revision)
      || changedFences(t.revision, current.revision, 'pixels').length || changedFences(ctx.revision, current.revision, 'pixels').length) throw fail('coordinate_revision_stale');
    if (typeof this.readCalibration !== 'function') throw fail('live_calibration_unavailable', 'backend_unavailable');
    const live = await boundedRead(child => this.readCalibration(clone(t.target), child), ctx, { now: this.now, maxMs: 750, phase: 'coordinate_preflight' });
    const after = this.getCurrent(t.target);
    if (!sameTarget(after.target, t.target) || changedFences(current.revision, after.revision, 'pixels').length || !isDeepStrictEqual(live, t)) throw fail('coordinate_calibration_changed');
    transformPoint(t, ref);
    return { ref: clone(ref), revision: clone(after.revision), evidence: [clone(entry.evidence)] };
  }
  invalidate(scope, _reason) {
    const matches = ref => ref.target.sessionId === scope.sessionId && (scope.targetId === undefined || ref.target.targetId === scope.targetId)
      && (scope.generation === undefined || ref.revision.sessionGeneration === scope.generation);
    for (const [key, entry] of this.refs) if (matches(entry.ref) && (scope.refIds === undefined || scope.refIds.includes(key))) this.refs.delete(key);
    if (scope.refIds === undefined) for (const [key, entry] of this.transforms) if (matches(entry.transform)) this.transforms.delete(key);
    for (const [key, set] of this.sets) if (!set.elements.every(ref => this.refs.has(ref.id))) this.sets.delete(key);
  }
  invalidateEvidence(evidenceId, _reason) {
    for (const [key, entry] of this.refs) if (entry.evidence.some(e => e.id === evidenceId)) this.refs.delete(key);
    for (const [key, set] of this.sets) if (!set.elements.every(ref => this.refs.has(ref.id))) this.sets.delete(key);
  }
  point(ref) {
    const entry = this.transforms.get(ref.transformId);
    if (!entry || ref.captureId !== entry.transform.captureId) throw fail('transform_unavailable');
    return transformPoint(entry.transform, ref);
  }
}

module.exports = { RefStore };
