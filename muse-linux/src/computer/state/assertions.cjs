const { performance } = require('node:perf_hooks');
const { assertId, assertTarget, clone, fail, exhaustive, eligibility, boundedRead, isDeepStrictEqual } = require('./evidence.cjs');

const BUILTINS = ['text.exact', 'element.checked', 'element.selected', 'element.focused', 'navigation.destination', 'dialog.state', 'window.placement', 'window.closed', 'download.state', 'fixture.saved'];
const DETERMINISTIC = new Set(['deterministic', 'authoritative', 'visible', 'visible_readback', 'complete_value', 'state', 'identified_pixels']);
const AUTHORITIES = {
  'text.value': ['dom', 'atspi'],
  'element.checked': ['dom', 'browser_ax', 'atspi'], 'element.selected': ['dom', 'browser_ax', 'atspi'], 'element.focused': ['dom', 'atspi'],
  'document.url': ['lifecycle'], 'document.urlDigest': ['lifecycle'], 'document.route': ['lifecycle', 'dom'],
  'document.heading': ['dom', 'browser_ax', 'atspi', 'pixels', 'ocr', 'lifecycle'], 'document.headings': ['dom', 'browser_ax', 'atspi'],
  'dialog.state': ['lifecycle', 'dom', 'atspi'], 'window.placement': ['window'], 'window.closed': ['window'],
  'download.state': ['lifecycle'], 'fixture.saved': ['dom', 'atspi'], 'navigation.pending': ['lifecycle'],
};

function result(predicate, status = 'unknown', reasonCodes = [], rows = []) {
  return { predicateId: predicate.id, status, producer: 'deterministic',
    evidenceIds: [...new Set(rows.flatMap(row => [row.e.id, ...row.fact.evidenceIds]))], actionIds: [], reasonCodes,
    ...(rows.length ? { observedRevision: clone(rows[0].e.revisionAfter), observedAtUtc: rows[0].e.interval.utc } : {}) };
}
function validatePredicate(p) {
  assertId(p?.id); assertTarget(p.target);
  if (typeof p.validator !== 'string' || !Number.isInteger(p.validatorVersion) || p.validatorVersion < 1 || !p.args || typeof p.args !== 'object' || Array.isArray(p.args)) throw fail('invalid_predicate', 'invalid_request');
}
function rowsFor(predicate, evidence, name, ctx) {
  const all = new Map(evidence.map(e => [e.id, e]));
  return evidence.flatMap(e => {
    if (!eligibility(e, predicate.target, ctx.revision, ctx.budget?.clockDomain).eligible || !AUTHORITIES[name]?.includes(e.source)) return [];
    if (e.derivedFrom.some(id => !all.has(id) || !eligibility(all.get(id), predicate.target, ctx.revision, ctx.budget?.clockDomain).eligible)) return [];
    return e.facts.filter(fact => fact.predicate === name && DETERMINISTIC.has(fact.suitability)
      && (name !== 'document.heading' || e.source !== 'lifecycle' || fact.suitability === 'visible_readback')
      && (!['pixels', 'ocr'].includes(e.source) || fact.suitability === 'identified_pixels')
      && fact.evidenceIds.every(id => all.has(id) && eligibility(all.get(id), predicate.target, ctx.revision, ctx.budget?.clockDomain).eligible))
      .map(fact => ({ e, fact, value: fact.value }));
  });
}
function decide(p, rows, match, complete = () => true) {
  const usable = rows.filter(row => complete(row.value, row.e));
  if (!usable.length) return result(p, 'unknown', ['positive_fact_unavailable']);
  const matches = usable.filter(row => match(row.value));
  const misses = usable.filter(row => !match(row.value));
  if (matches.length && misses.length) return result(p, 'unknown', ['authoritative_conflict'], usable);
  return result(p, matches.length ? 'satisfied' : 'unsatisfied', [], usable);
}
function exactKeys(args, allowed, required = allowed) {
  return Object.keys(args).every(key => allowed.includes(key)) && required.every(key => args[key] !== undefined);
}
function evaluateBuiltin(p, evidence, ctx) {
  validatePredicate(p);
  if (p.validatorVersion !== 1 || !BUILTINS.includes(p.validator)) return result(p, 'unknown', ['validator_unregistered']);
  const args = p.args;
  const rows = name => rowsFor(p, evidence, name, ctx);
  let verdict;
  switch (p.validator) {
    case 'text.exact': {
      if (!exactKeys(args, ['refId', 'value', 'privateDigest'], ['refId']) || typeof args.refId !== 'string' || (typeof args.value !== 'string' && typeof args.privateDigest !== 'string') || args.value !== undefined && args.privateDigest !== undefined) return result(p, 'unknown', ['invalid_predicate_args']);
      const values = rows('text.value').filter(row => row.value?.refId === args.refId);
      verdict = decide(p, values, v => args.value !== undefined ? typeof v.value === 'string' ? v.value === args.value : v.expectedValue === args.value && v.exactMatch === true : v.privateDigest === args.privateDigest && (v.actualDigest === true || v.exactMatch === true),
        v => v.complete === true && v.plainText === true && v.secret === false && (args.value !== undefined ? typeof v.value === 'string' || v.expectedValue === args.value && typeof v.exactMatch === 'boolean' : typeof v.privateDigest === 'string' && (v.actualDigest === true || v.privateDigest === args.privateDigest && typeof v.exactMatch === 'boolean')));
      break;
    }
    case 'element.checked': case 'element.selected': case 'element.focused': {
      const field = p.validator.split('.')[1];
      if (!exactKeys(args, ['refId', field]) || typeof args.refId !== 'string' || typeof args[field] !== 'boolean') return result(p, 'unknown', ['invalid_predicate_args']);
      verdict = decide(p, rows(p.validator).filter(row => row.value?.refId === args.refId), v => v[field] === args[field], v => typeof v[field] === 'boolean');
      break;
    }
    case 'navigation.destination': {
      if (!exactKeys(args, ['url', 'urlDigest', 'route', 'heading'], ['heading']) || typeof args.heading !== 'string' || args.url !== undefined && typeof args.url !== 'string' || args.urlDigest !== undefined && (typeof args.urlDigest !== 'string' || !args.urlDigest.length) || args.url !== undefined && args.urlDigest !== undefined || args.route !== undefined && typeof args.route !== 'string') return result(p, 'unknown', ['invalid_predicate_args']);
      const url = args.url === undefined ? result(p, 'satisfied') : decide(p, rows('document.url'), v => v === args.url, v => typeof v === 'string');
      const urlDigest = args.urlDigest === undefined ? result(p, 'satisfied') : decide(p, rows('document.urlDigest'), v => v === args.urlDigest, v => typeof v === 'string');
      const route = args.route === undefined ? result(p, 'satisfied') : decide(p, rows('document.route'), v => v === args.route, v => typeof v === 'string');
      const positives = rows('document.heading').filter(row => row.value?.text === args.heading && row.value.visible === true);
      const enumerations = rows('document.headings').filter(row => row.value?.complete === true && Array.isArray(row.value.headings) && exhaustive(row.e));
      const heading = positives.length ? result(p, 'satisfied', [], positives) : enumerations.length ? decide(p, enumerations, v => v.headings.some(h => h.text === args.heading && h.visible === true)) : result(p, 'unknown', ['heading_coverage_unknown']);
      // Complete contradictory inventories are relevant even when a positive fact exists.
      if (positives.length && enumerations.some(row => !row.value.headings.some(h => h.text === args.heading && h.visible === true))) {
        verdict = result(p, 'unknown', ['authoritative_conflict'], [...positives, ...enumerations]); break;
      }
      const parts = [url, urlDigest, route, heading];
      const status = parts.some(v => v.status === 'unknown') ? 'unknown' : parts.some(v => v.status === 'unsatisfied') ? 'unsatisfied' : 'satisfied';
      verdict = { ...result(p, status, [...new Set(parts.flatMap(v => v.reasonCodes))]), evidenceIds: [...new Set(parts.flatMap(v => v.evidenceIds))], observedRevision: clone(ctx.revision) };
      break;
    }
    case 'dialog.state': {
      if (!exactKeys(args, ['dialogId', 'state']) || !['open', 'closed'].includes(args.state)) return result(p, 'unknown', ['invalid_predicate_args']);
      verdict = decide(p, rows('dialog.state').filter(row => row.value?.dialogId === args.dialogId), v => v.state === args.state,
        v => v.related === true && v.relatedTargetId === p.target.targetId && ['open', 'closed'].includes(v.state));
      break;
    }
    case 'window.placement': {
      if (!exactKeys(args, ['workspace', 'bounds'], []) || !Object.keys(args).length || args.workspace !== undefined && typeof args.workspace !== 'string' || args.bounds !== undefined && (!Array.isArray(args.bounds) || args.bounds.length !== 4 || !args.bounds.every(Number.isFinite))) return result(p, 'unknown', ['invalid_predicate_args']);
      verdict = decide(p, rows('window.placement'), v => Object.keys(args).every(key => isDeepStrictEqual(v[key], args[key])), v => v.targetId === p.target.targetId && Object.keys(args).every(key => v[key] !== undefined));
      break;
    }
    case 'window.closed': {
      if (!exactKeys(args, ['closed']) || typeof args.closed !== 'boolean') return result(p, 'unknown', ['invalid_predicate_args']);
      verdict = decide(p, rows('window.closed'), v => v.closed === args.closed, v => v.targetId === p.target.targetId && typeof v.closed === 'boolean' && (v.closed !== true || v.closureConfirmed === true));
      break;
    }
    case 'download.state': {
      if (!exactKeys(args, ['downloadId', 'state', 'actionId']) || !['in_progress', 'completed', 'cancelled', 'interrupted'].includes(args.state)) return result(p, 'unknown', ['invalid_predicate_args']);
      verdict = decide(p, rows('download.state').filter(row => row.value?.downloadId === args.downloadId), v => v.state === args.state,
        v => v.correlation?.prearmed === true && v.correlation.targetId === p.target.targetId && v.correlation.actionId === args.actionId && v.correlation.guid === args.downloadId && ['in_progress', 'completed', 'cancelled', 'interrupted'].includes(v.state));
      if (verdict.status !== 'unknown') verdict.actionIds = [args.actionId];
      break;
    }
    case 'fixture.saved': {
      if (!exactKeys(args, ['key', 'saved']) || typeof args.key !== 'string' || typeof args.saved !== 'boolean') return result(p, 'unknown', ['invalid_predicate_args']);
      verdict = decide(p, rows('fixture.saved').filter(row => row.value?.key === args.key), v => v.saved === args.saved, v => v.synthetic === true && typeof v.saved === 'boolean');
      break;
    }
  }
  const pending = rows('navigation.pending').filter(row => row.value === true);
  if (pending.length && p.validator === 'navigation.destination') return result(p, 'pending', ['navigation_pending'], pending);
  return verdict;
}

class AssertionRegistry {
  constructor({ now = () => performance.now(), builtins = true } = {}) {
    this.now = now; this.validators = new Map();
    if (builtins) for (const name of BUILTINS) this.register(name, 1, (p, evidence, ctx) => evaluateBuiltin(p, evidence, ctx));
  }
  register(name, version, validator) {
    assertId(name);
    if (!Number.isSafeInteger(version) || version < 1 || typeof validator !== 'function') throw fail('invalid_validator', 'invalid_request');
    const key = `${name}@${version}`;
    if (this.validators.has(key)) throw fail('validator_already_registered', 'invalid_request');
    this.validators.set(key, validator);
  }
  async validate(predicate, evidence, ctx) {
    validatePredicate(predicate);
    const validator = this.validators.get(`${predicate.validator}@${predicate.validatorVersion}`);
    if (!validator) return result(predicate, 'unknown', ['validator_unregistered']);
    const eligible = evidence.filter(e => eligibility(e, predicate.target, ctx.revision, ctx.budget?.clockDomain).eligible);
    try {
      const answer = await boundedRead(child => validator(clone(predicate), clone(eligible), child), ctx, { now: this.now, maxMs: 2000, phase: 'assertion_read' });
      if (!answer || answer.predicateId !== predicate.id || !['satisfied', 'unsatisfied', 'unknown', 'pending'].includes(answer.status) || !['deterministic', 'model_inferred', 'human_reported'].includes(answer.producer)
        || !Array.isArray(answer.evidenceIds) || !Array.isArray(answer.actionIds) || !Array.isArray(answer.reasonCodes)) return result(predicate, 'unknown', ['invalid_validator_result']);
      if (['satisfied', 'unsatisfied'].includes(answer.status) && (!answer.evidenceIds.length || answer.evidenceIds.some(id => !eligible.some(e => e.id === id)))) return result(predicate, 'unknown', ['validator_evidence_unavailable']);
      if (answer.producer === 'deterministic' && answer.evidenceIds.some(id => eligible.find(e => e.id === id)?.facts.every(f => ['model_inferred', 'human_reported'].includes(f.suitability)))) return { ...answer, status: 'unknown', producer: 'model_inferred', reasonCodes: ['inference_not_deterministic'] };
      return clone(answer);
    } catch (error) {
      return result(predicate, 'unknown', [error?.kind === 'deadline' ? 'assertion_timeout' : error?.kind === 'cancelled' ? 'assertion_cancelled' : 'validator_failed']);
    }
  }
}

module.exports = { AssertionRegistry, BUILTINS, evaluateBuiltin, result, rowsFor };
