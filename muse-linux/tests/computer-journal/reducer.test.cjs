'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { RunReducer, context, fixture, beginAction, terminal, predicate, evidence, registry, target, revision, fs, path } = require('./helpers.cjs');

test('fake final narrative and model-inferred assertions cannot complete a manifest', async t => {
  const f = await fixture(t);
  const reducer = new RunReducer({ journal: f.journal, assertionRegistry: registry('model_inferred') });
  const initial = await reducer.begin({ runId: 'run-1', requirements: [predicate('orders'), predicate('tracking')] });
  assert.equal(initial.outcome, 'incomplete'); assert.equal(initial.requirements[1].status, 'not_attempted');
  const a = await beginAction(f.journal);
  const proseReceipt = await f.journal.end(a.handle, terminal(context(), { finalText: 'Orders and tracking are done!', assertions: [{ predicateId: 'tracking', status: 'satisfied', producer: 'deterministic', evidenceIds: ['fabricated'], actionIds: ['action-1'], reasonCodes: [] }] }));
  await reducer.recordAction('run-1', proseReceipt, ['orders']);
  await reducer.verify('run-1', ['orders', 'tracking'], [evidence()], context());
  const result = await reducer.result('run-1');
  assert.equal(result.outcome, 'incomplete'); assert.equal(result.requirements[1].status, 'not_attempted');
  assert.equal(result.counters.modelRequests, null); assert.equal(result.counters.modelProviderRetries, null); assert.equal(result.counters.modelMetricProvenance, 'unavailable');
});

test('registry-version predicates and eligible retained evidence establish specific completion', async t => {
  const f = await fixture(t); const j = f.journal;
  const reducer = new RunReducer({ journal: j, assertionRegistry: registry() });
  await reducer.begin({ runId: 'run-1', requirements: [predicate()] });
  await reducer.verify('run-1', ['saved'], [evidence()], context());
  assert.equal((await reducer.result('run-1')).outcome, 'verified_complete');
  const meta = await reducer.readEvidence({ runId: 'run-1', evidenceId: 'evidence-1' });
  assert.equal(meta.representation, 'metadata_only'); assert.equal(meta.rawContentAvailability, 'unavailable');
  await reducer.markEvidence('run-1', 'evidence-1', 'expired');
  assert.notEqual((await reducer.result('run-1')).outcome, 'verified_complete');
  await reducer.correlateModel('run-1', { modelRequestId: 'actual-request-1', modelResponseId: 'actual-response-1' });
  await reducer.correlateModel('run-1', { modelRequestId: 'actual-request-1', modelResponseId: 'actual-response-1' });
  const counters = (await reducer.result('run-1')).counters;
  assert.equal(counters.modelRequests, 1); assert.equal(counters.modelResponses, 1); assert.equal(counters.modelProviderRetries, null);
});

for (const [name, change] of [
  ['stale', { freshness: 'stale' }],
  ['crossed revision', { revisionAfter: { ...revision, documentEpoch: 2 } }],
  ['wrong target', { target: { ...target, targetId: 'other-tab' } }],
  ['wrong browser instance', { target: { ...target, browserInstance: 'other-browser' } }],
  ['wrong clock', { interval: { startMonoMs: 1, endMonoMs: 2, clockDomain: 'other' } }],
  ['failed capture', { acquisition: 'error' }],
]) test(name + ' evidence cannot complete, despite optimistic validator output', async t => {
  const f = await fixture(t); const reducer = new RunReducer({ journal: f.journal, assertionRegistry: registry() });
  await reducer.begin({ runId: 'run-1', requirements: [predicate()] });
  await reducer.verify('run-1', ['saved'], [evidence('evidence-1', change)], context());
  assert.notEqual((await reducer.result('run-1')).outcome, 'verified_complete');
});

test('negative assertion requires complete coverage and is distinct from satisfying the requirement', async t => {
  const f = await fixture(t); const reducer = new RunReducer({ journal: f.journal, assertionRegistry: registry('deterministic', 'unsatisfied') });
  await reducer.begin({ runId: 'run-1', requirements: [predicate()] });
  await reducer.verify('run-1', ['saved'], [evidence('partial', { coverage: { complete: false, truncated: true, omittedFrames: [], omissionReasons: ['truncated'] } })], context());
  assert.equal((await reducer.result('run-1')).requirements[0].status, 'not_attempted');
  await reducer.verify('run-1', ['saved'], [evidence('full')], context());
  const result = await reducer.result('run-1'); assert.equal(result.requirements[0].status, 'verified_absent'); assert.equal(result.outcome, 'incomplete');
});

test('only ledger-confirmed bound attempts change tracking from not_attempted', async t => {
  const f = await fixture(t); const reducer = new RunReducer({ journal: f.journal, assertionRegistry: registry() });
  await reducer.begin({ runId: 'run-1', requirements: [predicate('tracking')] });
  await assert.rejects(reducer.recordAction('run-1', terminal(), ['tracking']), { code: 'invalid_request' });
  const a = await beginAction(f.journal);
  const skipped = await f.journal.end(a.handle, terminal(context(), { execution: 'skipped', dispatch: 'not_started', effect: 'none_proven' }));
  await reducer.recordAction('run-1', skipped, ['tracking']);
  assert.equal((await reducer.result('run-1')).requirements[0].status, 'not_attempted');
  const b = await beginAction(f.journal, context('action-2', 'invoke-2'));
  await f.journal.beforeEffect(b.handle, { primitive: 'submit', substep: 'click', target, revision });
  const attempted = await f.journal.end(b.handle, terminal(b.ctx, { effect: 'unknown' }));
  await reducer.recordAction('run-1', attempted, ['tracking']);
  assert.equal((await reducer.result('run-1')).requirements[0].status, 'attempted_unverified');
});

test('missing manifest, expired evidence and journal gaps never produce verified_complete', async t => {
  const f = await fixture(t, { segmentBytes: 1100 }); const reducer = new RunReducer({ journal: f.journal, assertionRegistry: registry() });
  await reducer.begin({ runId: 'empty-run', requirements: [] });
  assert.equal((await reducer.result('empty-run')).outcome, 'unknown');
  await reducer.begin({ runId: 'run-1', requirements: [predicate()] });
  await reducer.verify('run-1', ['saved'], [evidence()], context());
  assert.equal((await reducer.result('run-1')).outcome, 'verified_complete');
  const segments = await f.journal.storage.segments(); await f.journal.storage.remove(segments[0].name);
  const result = await reducer.result('run-1'); assert.equal(result.outcome, 'unknown'); assert.equal(result.requirements[0].status, 'unknown_history');
});

test('manifest survives restart, exact arguments must match, and evidence can expire', async t => {
  let utcMs = Date.parse('2026-10-07T00:00:00Z');
  const f = await fixture(t, { clock: { now: () => 5, utc: () => new Date(utcMs).toISOString(), domain: 'main' } });
  const reducer = new RunReducer({ journal: f.journal, assertionRegistry: registry(), evidenceRetentionMs: 1000 });
  await reducer.begin({ runId: 'run-1', requirements: [predicate()] });
  await reducer.verify('run-1', ['saved'], [evidence()], context());
  const reloaded = await f.reopen(); const restored = new RunReducer({ journal: reloaded, assertionRegistry: registry() });
  await assert.rejects(restored.restoreManifest('run-1', [{ ...predicate(), args: { expected: false } }]), { code: 'predicate_mismatch' });
  await restored.restoreManifest('run-1', [predicate()]);
  assert.equal((await restored.result('run-1')).outcome, 'verified_complete');
  utcMs += 1500;
  assert.notEqual((await restored.result('run-1')).outcome, 'verified_complete');
  await restored.setExecution('run-1', 'ended');
  await assert.rejects(restored.setExecution('run-1', 'active'), { code: 'invalid_request' });
});

test('predicate content, evidence facts and narrative privacy canaries stay out of retained metadata', async t => {
  const f = await fixture(t); const canary = 'TOP_SECRET_canary https://private.invalid/item';
  const reducer = new RunReducer({ journal: f.journal, assertionRegistry: registry() });
  const requirement = { ...predicate(), args: { expected: canary }, prose: canary };
  await reducer.begin({ runId: 'run-1', requirements: [requirement] });
  await reducer.verify('run-1', ['saved'], [evidence('evidence-1', { facts: [{ value: canary }], title: canary, url: canary, text: canary })], context());
  for (const name of await fs.readdir(f.directory)) if (name !== 'key' && name !== 'reserve.bin') assert.ok(!(await fs.readFile(path.join(f.directory, name), 'utf8')).includes(canary), name);
});

test('later target input invalidates completion and reused evidence cannot renew it', async t => {
  const f = await fixture(t); const j = f.journal;
  const reducer = new RunReducer({ journal: j, assertionRegistry: registry() });
  await reducer.begin({ runId: 'run-1', requirements: [predicate()] });
  await reducer.verify('run-1', ['saved'], [evidence()], context());
  assert.equal((await reducer.result('run-1')).outcome, 'verified_complete');
  const action = await beginAction(j);
  await j.beforeEffect(action.handle, { primitive: 'submit', substep: 'click', target, revision });
  const receipt = await j.end(action.handle, terminal());
  await reducer.recordAction('run-1', receipt, ['saved']);
  assert.equal((await reducer.result('run-1')).requirements[0].status, 'attempted_unverified');
  await reducer.verify('run-1', ['saved'], [evidence()], context());
  assert.equal((await reducer.result('run-1')).outcome, 'incomplete');
  const restored = new RunReducer({ journal: await f.reopen(), assertionRegistry: registry() });
  await restored.restoreManifest('run-1', [predicate()]);
  await restored.verify('run-1', ['saved'], [evidence()], context());
  assert.equal((await restored.result('run-1')).outcome, 'incomplete');
  await restored.verify('run-1', ['saved'], [evidence('post-input')], context());
  assert.equal((await restored.result('run-1')).outcome, 'verified_complete');
});

test('unrelated target input preserves an eligible assertion', async t => {
  const f = await fixture(t); const j = f.journal;
  const reducer = new RunReducer({ journal: j, assertionRegistry: registry() });
  await reducer.begin({ runId: 'run-1', requirements: [predicate()] });
  await reducer.verify('run-1', ['saved'], [evidence()], context());
  const action = await beginAction(j);
  await j.beforeEffect(action.handle, { primitive: 'submit', substep: 'click', target: { ...target, targetId: 'unrelated-tab' }, revision });
  await j.end(action.handle, terminal());
  assert.equal((await reducer.result('run-1')).outcome, 'verified_complete');
});

test('another run invalidates final assertions across target revisions, retirement and restart', async t => {
  const f = await fixture(t); const j = f.journal;
  const reducer = new RunReducer({ journal: j, assertionRegistry: registry() });
  await reducer.begin({ runId: 'run-1', requirements: [predicate()] });
  await reducer.verify('run-1', ['saved'], [evidence()], context());
  assert.equal((await reducer.result('run-1')).outcome, 'verified_complete');
  await j.registerRun('mutating-run');
  const action = await beginAction(j, context('action-2', 'invoke-2', 'mutating-run'));
  await j.beforeEffect(action.handle, { primitive: 'submit', substep: 'click', target: { ...target, generation: 2, connectionEpoch: 2 }, revision });
  await j.end(action.handle, terminal(action.ctx));
  assert.equal((await reducer.result('run-1')).outcome, 'incomplete');
  await j.retireRun('mutating-run');
  assert.equal((await reducer.result('run-1')).outcome, 'incomplete');
  const restored = new RunReducer({ journal: await f.reopen(), assertionRegistry: registry() });
  await restored.restoreManifest('run-1', [predicate()]);
  await restored.verify('run-1', ['saved'], [evidence()], context());
  assert.equal((await restored.result('run-1')).outcome, 'incomplete');
  await restored.verify('run-1', ['saved'], [evidence('fresh-after-other-run')], context());
  assert.equal((await restored.result('run-1')).outcome, 'verified_complete');
});

test('input during read-only validation prevents the old answer from completing', async t => {
  const f = await fixture(t); const j = f.journal;
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const pending = new Promise(resolve => { release = resolve; });
  const delayed = { async validate(p, items) { entered(); await pending; return registry().validate(p, items); } };
  const reducer = new RunReducer({ journal: j, assertionRegistry: delayed });
  await reducer.begin({ runId: 'run-1', requirements: [predicate()] });
  const verification = reducer.verify('run-1', ['saved'], [evidence()], context());
  await started;
  const action = await beginAction(j);
  await j.beforeEffect(action.handle, { primitive: 'submit', substep: 'click', target, revision });
  await j.end(action.handle, terminal());
  release(); await verification;
  assert.equal((await reducer.result('run-1')).outcome, 'incomplete');
});

test('full manifest and large evidence references keep diagnostic records bounded', async t => {
  const f = await fixture(t); const j = f.journal;
  const reducer = new RunReducer({ journal: j, assertionRegistry: registry() });
  const requirements = Array.from({ length: 32 }, (_, i) => predicate('requirement-' + i));
  const items = Array.from({ length: 64 }, (_, i) => evidence('evidence-' + i + '-'.repeat(70)));
  await reducer.begin({ runId: 'run-1', requirements });
  await reducer.verify('run-1', requirements.map(p => p.id), items, context());
  assert.equal((await reducer.result('run-1')).outcome, 'verified_complete');
  const compact = await reducer.read({ runId: 'run-1' });
  assert.ok(Buffer.byteLength(JSON.stringify(compact)) <= 8192);
  assert.equal(compact.outcome, 'verified_complete');
  for (const segment of await j.storage.segments()) {
    const lines = (await j.storage.read(segment.name)).toString().split('\n').filter(Boolean);
    assert.ok(lines.every(line => Buffer.byteLength(line + '\n') <= 8192));
  }
});
