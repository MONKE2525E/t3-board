const { performance } = require('node:perf_hooks');
const { clone, fail, assertEvidence, assertTarget, assertRevision, sameTarget, eligibility, exhaustive, boundedRead } = require('./evidence.cjs');
const { AssertionRegistry, evaluateBuiltin, rowsFor } = require('./assertions.cjs');

class Reconciler {
  constructor({ getCurrent, captureCoordinator, registry = new AssertionRegistry(), refStore, now = () => performance.now() } = {}) {
    if (typeof getCurrent !== 'function') throw fail('current_state_provider_required', 'invalid_request');
    this.getCurrent = getCurrent; this.captureCoordinator = captureCoordinator;
    this.registry = registry; this.refStore = refStore; this.now = now;
  }
  reconcile(input, predicates = []) {
    if (!Array.isArray(input) || input.length > 256 || !Array.isArray(predicates) || predicates.length > 32) throw fail('reconcile_limit', 'invalid_request');
    const selected = predicates[0]?.target || input[0]?.target;
    if (!selected) throw fail('target_required', 'invalid_request');
    const current = this.getCurrent(clone(selected));
    assertTarget(current.target); assertRevision(current.revision);
    if (!sameTarget(selected, current.target)) throw fail('target_mismatch');
    const ctx = { revision: current.revision, budget: { clockDomain: current.clockDomain } };
    const evidence = input.map(item => {
      assertEvidence(item);
      const e = clone(item), check = eligibility(e, current.target, current.revision, current.clockDomain);
      const fenced = check.reasons.filter(reason => reason.startsWith('old_') || reason.startsWith('crossed_') || ['target_mismatch', 'clock_domain_mismatch', 'invalid_interval'].includes(reason));
      if (fenced.length) { e.freshness = 'stale'; e.reasons = [...new Set([...e.reasons, ...fenced])]; }
      return e;
    });
    const disagreements = [];
    for (const p of predicates) {
      if (!sameTarget(p.target, current.target)) throw fail('predicate_target_mismatch', 'invalid_request');
      if (p.validator !== 'navigation.destination') continue;
      const positives = rowsFor(p, evidence, 'document.heading', ctx).filter(row => ['dom', 'pixels', 'ocr'].includes(row.e.source) && row.value?.text === p.args.heading && row.value.visible === true);
      if (!positives.length) continue;
      for (const e of evidence) {
        if (!['browser_ax', 'atspi'].includes(e.source) || !sameTarget(e.target, current.target)) continue;
        const conflicting = e.facts.some(f => f.predicate === 'document.headings' && Array.isArray(f.value?.headings) && f.value.complete === true && (e.freshness !== 'current' || exhaustive(e)) && !f.value.headings.some(h => h.text === p.args.heading && h.visible === true)
          || f.predicate === 'document.heading' && f.value?.primary === true && f.value.visible === true && f.value.text !== p.args.heading && positives.some(row => row.value.primary === true));
        if (!conflicting) continue;
        const reasons = e.freshness === 'current' ? ['authoritative_conflict'] : ['stale_semantics_quarantined', 'refresh_semantics_once', 'do_not_renavigate'];
        disagreements.push({ predicate: p.id, evidenceIds: [e.id, ...positives.map(row => row.e.id)], reasons });
        if (e.freshness !== 'current') {
          e.freshness = e.freshness === 'stale' ? 'stale' : 'suspect';
          e.reasons = [...new Set([...e.reasons, ...reasons])];
          this.refStore?.invalidateEvidence(e.id, 'stale_semantics_quarantined');
        }
      }
    }
    // No counts or majority votes. Relevant eligible conflicting values remain unknown.
    const assertions = predicates.map(p => {
      const answer = evaluateBuiltin(this.refStore?.predicateForAdapter(p) || p, evidence, ctx);
      if (disagreements.some(d => d.predicate === p.id && d.reasons.includes('authoritative_conflict'))) return { ...answer, status: 'unknown', reasonCodes: ['authoritative_conflict'], evidenceIds: [...new Set([...answer.evidenceIds, ...disagreements.filter(d => d.predicate === p.id).flatMap(d => d.evidenceIds)])] };
      return answer;
    });
    for (const assertion of assertions) if (assertion.reasonCodes.includes('authoritative_conflict') && !disagreements.some(d => d.predicate === assertion.predicateId)) disagreements.push({ predicate: assertion.predicateId, evidenceIds: assertion.evidenceIds, reasons: ['authoritative_conflict'] });
    const allowedRoutes = [];
    for (const source of ['dom', 'browser_ax', 'atspi']) if (evidence.some(e => e.source === source && eligibility(e, current.target, current.revision, current.clockDomain).eligible)) allowedRoutes.push(source);
    if (evidence.some(e => e.source === 'pixels' && this.refStore?.hasTransform(e.artifact?.transformId, e.artifact?.captureId) && eligibility(e, current.target, current.revision, current.clockDomain).eligible)) allowedRoutes.push('calibrated_coordinates');
    const pendingNavigation = evidence.some(e => e.source === 'lifecycle' && eligibility(e, current.target, current.revision, current.clockDomain).eligible && e.facts.some(f => f.predicate === 'navigation.pending' && f.value === true && ['deterministic', 'authoritative'].includes(f.suitability)));
    return { target: clone(current.target), revision: clone(current.revision), evidence, assertions, disagreements, allowedRoutes, pendingNavigation };
  }
  async verify(receipt, predicates, ctx) {
    if (predicates.some(p => !sameTarget(p.target, receipt.target))) throw fail('predicate_target_mismatch', 'invalid_request');
    let evidence = receipt.evidence || [];
    if (this.captureCoordinator) {
      const sources = receipt.target.kind === 'tab' ? ['lifecycle', 'dom', 'browser_ax'] : ['window', 'atspi'];
      const captured = await boundedRead(child => this.captureCoordinator.capture(receipt.target, sources, child), ctx, { now: this.now, maxMs: 2000, phase: 'state_verify' });
      evidence = [...evidence, ...captured];
    }
    const state = this.reconcile(evidence, predicates);
    const currentCtx = { ...ctx, revision: state.revision };
    const results = await Promise.all(predicates.map(p => this.registry.validate(this.refStore?.predicateForAdapter(p) || p, state.evidence, currentCtx)));
    return results.map(answer => {
      const sync = state.assertions.find(a => a.predicateId === answer.predicateId);
      return sync?.reasonCodes.includes('authoritative_conflict') ? sync : answer;
    });
  }
}

function evidenceHeader(state) {
  return { schema: 'muse.evidence_header.v1', target: clone(state.target), revision: clone(state.revision), pendingNavigation: state.pendingNavigation,
    sources: state.evidence.map(e => ({ id: e.id, source: e.source, acquisition: e.acquisition, freshness: e.freshness,
      revisionBefore: clone(e.revisionBefore), revisionAfter: clone(e.revisionAfter), interval: clone(e.interval), coverage: clone(e.coverage), reasons: [...e.reasons], derivedFrom: [...e.derivedFrom], ...(e.artifact ? { artifact: clone(e.artifact) } : {}) })),
    assertions: state.assertions.map(a => clone(a)), disagreements: clone(state.disagreements), allowedRoutes: [...state.allowedRoutes],
    requiredNext: [...new Set(state.disagreements.flatMap(d => d.reasons.filter(r => ['refresh_semantics_once', 'do_not_renavigate'].includes(r))))] };
}

module.exports = { Reconciler, evidenceHeader };
