'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { FailureDetector, intentKey } = require('../../src/computer/recovery.cjs');
const { target, revision, ref, action, evidence } = require('./helpers.cjs');

function request(i, operation = { kind: 'press', target, chord: `Control+${i}` }) {
  return action(`progress-${i}`, { operation, expect: [], requirementIds: [], invokeId: `progress-invoke-${i}` });
}
function receipt(failure) { return { execution: failure ? 'rejected' : 'completed', dispatch: failure ? 'not_started' : 'acknowledged',
  effect: failure ? 'none_proven' : 'unknown', assertions: [], ...(failure ? { failure } : {}) }; }
function proof({ before = revision, after = { ...revision, semanticRevision: 2 }, overrides = {} } = {}) {
  const facts = text => [{ predicate: 'document.heading', value: { text, visible: true }, suitability: 'visible', evidenceIds: ['e1'] }];
  const coverage = { scope: 'visible', complete: false, truncated: false, omittedFrames: [], omissionReasons: ['closed_shadow_roots_not_observable'] };
  const old = { ...evidence(facts('Before')), source: 'dom', coverage, revisionBefore: before, revisionAfter: before,
    interval: { startMonoMs: 50, endMonoMs: 80, clockDomain: 'test.progress', utc: '2026-10-07T00:00:00.000Z' } };
  const e = { ...evidence(facts('After')), source: 'dom', coverage: structuredClone(coverage), revisionBefore: after, revisionAfter: after,
    interval: { startMonoMs: 150, endMonoMs: 180, clockDomain: 'test.progress', utc: '2026-10-07T00:00:00.000Z' }, ...overrides };
  return { input: { target, before, after, beforeEvidence: [old], evidence: [e] }, ctx: { afterActionMonoMs: 100, revision: after,
    progress: { check() {}, clock: { domain: 'test.progress', now: () => 200 } } } };
}

test('different keys, destinations, scrolls and apps have private distinct intent identities', () => {
  const groups = [
    [{ kind: 'press', target, chord: 'Control+A' }, { kind: 'press', target, chord: 'Control+B' }],
    [{ kind: 'navigate', target, url: 'https://private.example/one?token=PRIVATE' }, { kind: 'navigate', target, url: 'https://private.example/two' }],
    [{ kind: 'scroll', ref, axis: 'y', delta: 100 }, { kind: 'scroll', ref, axis: 'y', delta: -100 }],
    [{ kind: 'launchApp', target, appId: 'files' }, { kind: 'launchApp', target, appId: 'terminal' }],
  ];
  for (const [a, b] of groups) {
    const ka = intentKey(request(1, a)), kb = intentKey(request(2, b));
    assert.notEqual(ka, kb); assert.match(ka, /^[a-f0-9]{64}$/);
    assert.ok(!ka.includes('PRIVATE'));
    assert.equal(ka, intentKey(request(3, Object.fromEntries(Object.entries(a).reverse()))));
  }
  const refreshed = { ...ref, id: 'new-public-ref', refSetId: 'new-public-set', revision: { ...revision, semanticRevision: 2 } };
  assert.equal(intentKey(request(1, { kind: 'focus', ref })), intentKey(request(2, { kind: 'focus', ref: refreshed })));
  assert.notEqual(intentKey(request(1, { kind: 'focus', ref })), intentKey(request(2, { kind: 'focus', ref: { ...ref, identity: { ...ref.identity, semanticFingerprint: 'other-field' } } })));
});

test('four different acknowledged actions proceed with independently observed semantic progress', () => {
  const detector = new FailureDetector();
  const actions = [request(1), request(2, { kind: 'navigate', target, url: 'https://private.example/orders' }),
    request(3, { kind: 'scroll', ref, axis: 'y', delta: 400 }), request(4, { kind: 'click', ref, button: 'left' })];
  for (let i = 0; i < actions.length; i++) {
    assert.doesNotThrow(() => detector.check(actions[i]));
    const r = receipt(); detector.record(actions[i], r);
    const p = proof({ before: { ...revision, semanticRevision: i + 1 }, after: { ...revision, semanticRevision: i + 2 } });
    assert.equal(detector.observeProgress('r1', p.input, p.ctx).progress, true);
    assert.equal(r.effect, 'unknown'); assert.equal(detector.status('r1'), null);
  }
  assert.throws(() => detector.check(actions[0]), /diagnosis_required/);
  const p = proof(); detector.observeProgress('r1', p.input, p.ctx);
  assert.throws(() => detector.check(actions[0]), /diagnosis_required/);
});

test('only no-progress gate clears; unknown intent locks remain', () => {
  const detector = new FailureDetector();
  for (let i = 1; i <= 3; i++) detector.record(request(i), receipt());
  assert.equal(detector.status('r1').reason, 'no_progress');
  assert.throws(() => detector.check(request(4)), /diagnosis_required/);
  const p = proof();
  assert.deepEqual(detector.observeProgress('r1', p.input, p.ctx), { progress: true, evidenceIds: ['e1'], reason: 'no_progress_gate_cleared' });
  assert.doesNotThrow(() => detector.check(request(4)));
  assert.throws(() => detector.check(request(1)), /diagnosis_required/);
});

test('no change, timestamp-only, stale, wrong target, wrong clock and pre-action evidence preserve gate', () => {
  const variants = [
    { after: revision },
    { after: { ...revision, geometryRevision: 2 } },
    { after: { ...revision, semanticRevision: 0 } },
    { before: { ...revision, documentEpoch: 2 }, after: { ...revision, documentEpoch: 1, semanticRevision: 2 } },
    { after: { ...revision, grantGeneration: 2, semanticRevision: 2 } },
    { overrides: { freshness: 'stale' } },
    { overrides: { target: { ...target, targetId: 'wrong-window' } } },
    { overrides: { source: 'pixels' } },
    { overrides: { acquisition: 'error' } },
    { overrides: { interval: { startMonoMs: 150, endMonoMs: 180, clockDomain: 'wrong.clock', utc: 'now' } } },
    { overrides: { interval: { startMonoMs: 90, endMonoMs: 180, clockDomain: 'test.progress', utc: 'now' } } },
    { overrides: { interval: { startMonoMs: 150, endMonoMs: 201, clockDomain: 'test.progress', utc: 'now' } } },
    { overrides: { revisionBefore: revision } },
  ];
  for (const variant of variants) {
    const detector = new FailureDetector();
    for (let i = 1; i <= 3; i++) detector.record(request(i), receipt());
    const p = proof(variant);
    assert.equal(detector.observeProgress('r1', p.input, p.ctx).progress, false);
    assert.throws(() => detector.check(request(4)), /diagnosis_required/);
  }
  const detector = new FailureDetector(), p = proof();
  p.ctx.progress.clock.now = () => 1300;
  assert.equal(detector.observeProgress('r1', p.input, p.ctx).progress, false);
});

test('malformed evidence, inconsistent current revision and missing boundary are rejected', () => {
  const detector = new FailureDetector();
  let p = proof({ overrides: { madeUp: true } });
  assert.throws(() => detector.observeProgress('r1', p.input, p.ctx), /unknown_field/);
  p = proof(); p.ctx.revision = revision;
  assert.throws(() => detector.observeProgress('r1', p.input, p.ctx), /progress_revision_mismatch/);
  p = proof(); delete p.ctx.afterActionMonoMs;
  assert.throws(() => detector.observeProgress('r1', p.input, p.ctx), /invalid_progress_boundary/);
});

test('empty, unchanged, unbound, partial and scope-shifted semantic content cannot clear the gate', () => {
  const variants = [
    p => { p.input.evidence[0].facts = []; },
    p => { p.input.beforeEvidence = []; },
    p => { p.input.evidence[0].facts = p.input.beforeEvidence[0].facts; },
    p => { p.input.evidence[0].facts[0].evidenceIds = []; },
    p => { p.input.evidence[0].facts[0].suitability = 'unavailable'; },
    p => { p.input.evidence[0].coverage.truncated = true; },
    p => { p.input.evidence[0].coverage.scope = 'structural'; },
    p => { p.input.evidence[0].derivedFrom = ['other-evidence']; },
    p => { p.input.beforeEvidence[0].revisionBefore = { ...revision, semanticRevision: 0 }; },
    p => { p.input.beforeEvidence[0].interval.endMonoMs = 101; },
    p => { p.input.beforeEvidence[0].target = { ...target, targetId: 'foreign' }; },
    p => { p.input.beforeEvidence[0].freshness = 'stale'; },
  ];
  for (const modify of variants) {
    const detector = new FailureDetector();
    for (let i = 1; i <= 3; i++) detector.record(request(i), receipt());
    const p = proof(); modify(p);
    assert.equal(detector.observeProgress('r1', p.input, p.ctx).progress, false);
    assert.throws(() => detector.check(request(4)), /diagnosis_required/);
  }
});

test('new public refs and a later sample alone do not count as changed content', () => {
  const detector = new FailureDetector(), p = proof();
  p.input.beforeEvidence[0].source = 'atspi'; p.input.evidence[0].source = 'atspi';
  const entry = (id, revisionValue) => ({ predicate: 'element.ref', value: { ...structuredClone(ref), id, refSetId: `set-${id}`, revision: revisionValue }, suitability: 'deterministic', evidenceIds: ['e1'] });
  p.input.beforeEvidence[0].facts = [entry('before', p.input.before)];
  p.input.evidence[0].facts = [entry('after', p.input.after)];
  assert.equal(detector.observeProgress('r1', p.input, p.ctx).progress, false);
  p.input.evidence[0].facts[0].value.identity.semanticFingerprint = 'changed-but-foreign';
  p.input.evidence[0].facts[0].value.target = { ...target, targetId: 'foreign-window' };
  assert.equal(detector.observeProgress('r1', p.input, p.ctx).progress, false);
});

test('fresh state cannot clear repeated failures, failed recovery or unfinished intent locks', () => {
  const detector = new FailureDetector(), failed = request(1);
  detector.record(failed, receipt({ code: 'preflight_rejected' })); detector.record(failed, receipt({ code: 'preflight_rejected' }));
  const p = proof(); assert.equal(detector.status('r1').reason, 'repeated_failure');
  detector.observeProgress('r1', p.input, p.ctx);
  assert.throws(() => detector.check(request(2)), /diagnosis_required/);
  detector.allowRecovery('r1', { action: request(2), hypothesis: 'alternate target', evidenceIds: ['e1'], predictedAssertions: ['checked'] });
  detector.check(request(2)); detector.record(request(2), receipt({ code: 'preflight_rejected' }));
  assert.equal(detector.status('r1').reason, 'recovery_failed'); detector.observeProgress('r1', p.input, p.ctx);
  assert.throws(() => detector.check(request(3)), /diagnosis_required/);
  const unfinished = new FailureDetector();
  unfinished.record(failed, { ...receipt(), execution: 'unfinished' }); unfinished.observeProgress('r1', p.input, p.ctx);
  assert.throws(() => unfinished.check(failed), /unfinished_action/);
});
