'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../../src/computer/contracts.cjs');
const { Progress, defaultClock } = require('../../src/computer/progress.cjs');
const { LeaseManager } = require('../../src/computer/lease.cjs');
const { LegacyCommandAdapter } = require('../../src/computer/executor.cjs');
const { action, invocation, context, fixture, target, revision, session, MemoryJournal, predicate, evidence } = require('./helpers.cjs');
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

test('schemas reject unknown operations, generations, forged private handles and invalid Unicode', () => {
  C.validateActionRequest(action());
  assert.throws(() => C.validateActionRequest(action('a1', { expectedRevision: { ...revision, targetGeneration: 2 } })), /generation_mismatch/);
  assert.throws(() => C.validateActionRequest(action('a1', { operation: { ...action().operation, arbitraryJavaScript: 'x' } })), /unknown_field/);
  assert.throws(() => C.validateOperation({ kind: 'closeWindow', target }, 'borrowed_browser'), /operation_mode_denied/);
  assert.throws(() => C.validateJson({ grant: { kind: 'grant', id: 'grant' } }), /opaque_handle_in_rpc/);
  const handle = C.createPrivateHandle('grant', 'grant'); assert.equal(C.assertPrivateHandle(handle, 'grant'), handle);
  assert.throws(() => C.assertPrivateHandle({ ...handle }, 'grant'), /untrusted_private_handle/);
  assert.throws(() => C.validateTextEdit({ ...action().operation.edit, text: '\ud800' }), /invalid_text/);
  C.validateTextEdit({ ...action().operation.edit, text: '你好🙂e\u0301\n\tمرحبا' });
  assert.throws(() => C.validateJson({ get token() { throw new Error('getter must never run'); } }), /unsafe_object/);
  assert.equal(C.canonicalJson({ b: 1, a: 2 }), C.canonicalJson({ a: 2, b: 1 }));
});

test('shared monotonic deadline clips children and refuses expired phases', async () => {
  let now = 20; const clock = { ...defaultClock, domain: 'fake', now: () => now };
  const progress = new Progress({ budget: { deadlineMonoMs: 100, clockDomain: 'fake' }, clock });
  assert.equal(progress.child(200).budget.deadlineMonoMs, 100);
  assert.equal(progress.child(10).budget.deadlineMonoMs, 30);
  now = 101; assert.equal(progress.remainingMs(), 0);
  let calls = 0; await assert.rejects(progress.phase('dispatch', async () => calls++), /deadline/); assert.equal(calls, 0);
  assert.throws(() => new Progress({ budget: { deadlineMonoMs: 100, clockDomain: 'other' }, clock }), /invalid_request/);
});

test('deadline aborts the adapter signal and cleanup gets an independent finite signal', async () => {
  const progress = new Progress({ budget: { deadlineMonoMs: performance.now() + 25, clockDomain: defaultClock.domain } });
  let observed;
  await assert.rejects(progress.phase('perform', p => new Promise(resolve => {
    p.signal.addEventListener('abort', () => { observed = p.signal.reason; resolve(); }, { once: true });
  })), { kind: 'deadline' });
  assert.equal(observed, 'deadline'); assert.equal(progress.signal.aborted, true);
  const result = await progress.quiesce(async p => {
    assert.equal(p.signal.aborted, false); assert.ok(p.remainingMs() <= 1000);
    return { state: 'confirmed', ownedInputReleased: true, reasonCodes: [] };
  });
  assert.equal(result.state, 'confirmed');
});

test('semantic operations and all plan predicate scopes reject invalid refs before any prefix effect', async () => {
  const coordinate = { captureId: 'capture', transformId: 'transform', target, revision, point: [0, 0], space: 'window_normalized' };
  for (const operation of [
    { kind: 'editText', ref: coordinate, edit: action().operation.edit }, { kind: 'focus', ref: coordinate },
    { kind: 'press', target, ref: coordinate, chord: 'Return' }, { kind: 'upload', ref: coordinate, fileCapabilityIds: ['file'] },
  ]) assert.throws(() => C.validateOperation(operation), C.ContractError);
  C.validateOperation({ kind: 'click', ref: coordinate, button: 'left' });
  C.validateOperation({ kind: 'scroll', ref: coordinate, axis: 'y', delta: 1 });
  const f = fixture(), foreign = { ...predicate(), target: { ...target, sessionId: 'other-session' } };
  for (const suffix of [{ id: 'assert', kind: 'assert', predicates: [foreign] },
    { id: 'transition', kind: 'act', action: action('a2'), transition: { predicates: [foreign] } }]) {
    const plan = { schema: 'muse.plan.v1', planId: 'scoped', runId: 'r1', invokeId: 'i1', sessionId: session.id, totalBudgetMs: 1000,
      steps: [{ id: 'prefix', kind: 'act', action: action() }, suffix] };
    await assert.rejects(f.coordinator.invoke(invocation(plan), session), /plan_predicate_scope/);
    assert.equal(f.edits, 0); assert.equal(f.journal.order.length, 0);
  }
});

test('lease queue abort does not steal the next lease and poison blocks mutation', async () => {
  const leases = new LeaseManager(), resource = { sessionId: session.id, generation: 1, kind: 'seat', id: 'seat' };
  const first = await leases.acquire(resource, context());
  const cancel = new AbortController(); const progress = new Progress({ budget: { deadlineMonoMs: performance.now() + 1000, clockDomain: 'node.performance' }, signal: cancel.signal });
  const second = leases.acquire(resource, context({ signal: cancel.signal, progress })); cancel.abort(); await assert.rejects(second, /cancelled/);
  await leases.release(first); const third = await leases.acquire(resource, context()); leases.poison(resource, 'unknown'); await leases.release(third);
  await assert.rejects(leases.acquire(resource, context()), /lease_poisoned/);
});

test('actual invocation pipeline persists intent before input, verifies, and returns equal duplicate receipts', async () => {
  const f = fixture(); const req = invocation();
  const [a, b] = await Promise.all([f.coordinator.invoke(req, session), f.coordinator.invoke(req, session)]);
  assert.equal(f.edits, 1); assert.deepEqual(a, b); assert.equal(a.receipt.effect, 'verified');
  assert.deepEqual(f.journal.order, ['begin', 'durable-intent', 'input', 'ack', 'end']);
  assert.equal((await f.coordinator.inspect('r1')).counters.modelRequests, null);
  const mismatch = invocation(action('a1', { operation: { ...action().operation, edit: { ...action().operation.edit, text: 'changed' } } }));
  assert.equal((await f.coordinator.invoke(mismatch, session)).receipt.failure.code, 'dedup_collision'); assert.equal(f.edits, 1);
});

test('trusted translation unwraps action/plan wire params only when schema is absent and keeps original admission identity', async () => {
  for (const command of ['computer.action', 'computer.plan']) {
    const f = fixture(); let translated = 0, admitted;
    const typed = command === 'computer.action' ? action() : { schema: 'muse.plan.v1', planId: 'translated-plan', runId: 'r1', invokeId: 'i1', sessionId: session.id, totalBudgetMs: 1000, steps: [{ id: 'edit', kind: 'act', action: action() }] };
    const wire = { request: JSON.stringify({ operation: typed.operation || typed.steps[0].action.operation }) };
    f.coordinator.translate = async input => { translated++; assert.deepEqual(input.params, wire); return typed; };
    const admit = f.journal.admit.bind(f.journal); f.journal.admit = async (input, bytes) => { admitted = input; return admit(input, bytes); };
    const input = invocation(typed, { command, params: wire });
    const result = await f.coordinator.invoke(input, session);
    assert.equal(result.receipt.execution, 'completed'); assert.equal(f.edits, 1); assert.equal(translated, 1);
    assert.deepEqual(admitted.params, wire); assert.deepEqual(input.params, wire);
    await f.coordinator.invoke(input, session); assert.equal(translated, 1); assert.equal(f.edits, 1);
    const direct = invocation(action('a2', { invokeId: 'i2' }));
    await f.coordinator.invoke(direct, session); assert.equal(translated, 1);
  }
});

test('unfinished journal fence is rechecked at the effect boundary and terminal unknown does not use the crash fence', async () => {
  const f = fixture(); let checks = 0;
  f.journal.checkUnfinished = async () => ({ blocked: ++checks >= 3, unfinishedActionIds: checks >= 3 ? ['old-action'] : [] });
  const result = await f.coordinator.invoke(invocation(), session);
  assert.equal(checks, 3); assert.equal(result.receipt.failure.code, 'unfinished_action'); assert.equal(f.edits, 0);
  assert.equal(result.receipt.dispatch, 'not_started'); assert.ok(!f.journal.order.includes('durable-intent'));
  const g = fixture(); g.journal.checkUnfinished = async () => ({ blocked: false, unfinishedActionIds: [] });
  const unverified = await g.coordinator.invoke(invocation(action('a1', { expect: [] })), session);
  assert.equal(unverified.receipt.execution, 'completed'); assert.equal(unverified.receipt.effect, 'unknown');
  const next = await g.coordinator.invoke(invocation(action('a2', { invokeId: 'i2', expect: [] })), session);
  assert.equal(next.receipt.failure.code, 'diagnosis_required'); assert.equal(g.edits, 1);
  assert.equal(next.receipt.failure.requiredNext, 'read_authoritative_state_do_not_replay');
});

test('durable action lookup survives a new coordinator and detects parameter collision', async () => {
  const f = fixture(); const a = await f.coordinator.execute(action(), context());
  const second = fixture({ journal: f.journal });
  const repeated = await second.coordinator.execute(action(), context()); assert.deepEqual(repeated, a); assert.equal(second.edits, 0);
  const changed = action(); changed.operation.edit.text = 'other'; const collision = await second.coordinator.execute(changed, context());
  assert.equal(collision.failure.code, 'dedup_collision'); assert.equal(collision.dispatch, 'not_started');
});

test('storage failure before durable marker prevents input; terminal failure retains unknown history', async () => {
  const f = fixture(); f.journal.markerFailure = true;
  const blocked = await f.coordinator.execute(action(), context()); assert.equal(f.edits, 0); assert.equal(blocked.effect, 'none_proven'); assert.equal(blocked.failure.kind, 'storage_unavailable');
  const g = fixture(); g.journal.terminalFailure = true;
  const ended = await g.coordinator.execute(action(), context()); assert.equal(g.edits, 1); assert.equal(ended.persistence, 'degraded');
  const restarted = fixture({ journal: g.journal }); const recovered = await restarted.coordinator.execute(action(), context());
  assert.equal(recovered.failure.code, 'unfinished_action'); assert.equal(restarted.edits, 0);
});

test('lost reply forbids same-ID replay and new-ID same-intent mutation', async () => {
  const f = fixture(); let writes = 0;
  f.adapter.perform = async (op, ctx) => { const h = await ctx.dispatch.beforeEffect({ primitive: 'atspi.SetTextContents', substep: 'editText', target }); writes++; await ctx.dispatch.afterEffect(h, { state: 'lost', noEffectProven: false }); throw Object.assign(new Error('PRIVATE provider payload'), { kind: 'transport_lost', code: 'SECRET-token' }); };
  const request = action(); const first = await f.coordinator.execute(request, context());
  assert.equal(first.effect, 'unknown'); assert.equal(first.replay, 'forbidden'); assert.equal(first.failure.kind, 'transport_lost'); assert.ok(!JSON.stringify(first).includes('PRIVATE')); assert.ok(!JSON.stringify(first).includes('SECRET'));
  assert.deepEqual(await f.coordinator.execute(request, context()), first);
  const next = await f.coordinator.execute(action('a2', { invokeId: 'i2' }), context({ invokeId: 'i2' }));
  assert.equal(next.failure.code, 'unfinished_action'); assert.equal(writes, 1);
});

test('cancel after dispatch yields terminal receipt, releases owned input, and seals late dispatch', async () => {
  const f = fixture(), entered = deferred(), release = deferred(), late = deferred(); let writes = 0, quiesced = 0;
  f.adapter.perform = async (op, ctx) => {
    const h = await ctx.dispatch.beforeEffect({ primitive: 'atspi.SetTextContents', substep: 'editText', target }); writes++; await ctx.dispatch.afterEffect(h, { state: 'accepted', noEffectProven: false }); entered.resolve();
    await release.promise;
    try { await ctx.dispatch.beforeEffect({ primitive: 'atspi.SetTextContents', substep: 'editText', target }); writes++; } catch { late.resolve(); }
    return { target, before: revision, dispatch: 'acknowledged', effect: 'unknown', evidence: [], attempts: [] };
  };
  f.adapter.quiesce = async () => { quiesced++; return { state: 'confirmed', ownedInputReleased: true, reasonCodes: [] }; };
  const work = f.coordinator.invoke(invocation(), session); await entered.promise;
  const cancellation = await f.coordinator.cancel('r1', 'user_stop'); const result = await work;
  assert.equal(cancellation.futureDispatchBlocked, true); assert.equal(result.receipt.execution, 'cancelled'); assert.equal(result.receipt.effect, 'unknown'); assert.ok(quiesced);
  release.resolve(); await late.promise; assert.equal(writes, 1);
  const later = await f.coordinator.execute(action('a2', { invokeId: 'i2' }), context({ invokeId: 'i2' })); assert.equal(later.dispatch, 'not_started');
});

test('timeout after dispatch poisons target on unknown quiescence and retains late completion metadata', async () => {
  const f = fixture(), release = deferred(); let writes = 0;
  f.adapter.perform = async (op, ctx) => { await ctx.dispatch.beforeEffect({ primitive: 'atspi.SetTextContents', substep: 'editText', target }); writes++; await release.promise; return { target, before: revision, dispatch: 'possible', effect: 'unknown', evidence: [] }; };
  f.adapter.quiesce = async () => ({ state: 'unknown', ownedInputReleased: false, reasonCodes: ['worker_busy'] });
  const req = invocation(action(), { deadlineUtcMs: Date.now() + 35 }); const result = await f.coordinator.invoke(req, session);
  assert.equal(result.receipt.failure.kind, 'deadline'); assert.equal(result.receipt.effect, 'unknown'); assert.equal((await f.coordinator.inspect('r1')).execution, 'blocked');
  const next = action('a2', { invokeId: 'i2', requirementIds: ['other'] }); const blocked = await f.coordinator.execute(next, context({ invokeId: 'i2' })); assert.equal(blocked.failure.code, 'lease_poisoned');
  release.resolve(); await new Promise(resolve => setImmediate(resolve)); assert.equal(writes, 1); assert.ok(f.coordinator.late.some(e => e.phase === 'perform'));
});

test('four-step plan failure at step three preserves all receipts and does not replay prefix', async () => {
  const f = fixture(), original = f.adapter.perform; let calls = 0;
  f.adapter.perform = async (op, ctx) => { calls++; if (calls === 3) throw Object.assign(new Error('synthetic failure'), { kind: 'not_ready', code: 'not_ready' }); return original(op, ctx); };
  const request = { schema: 'muse.plan.v1', planId: 'plan1', runId: 'r1', invokeId: 'i1', sessionId: session.id, totalBudgetMs: 2000,
    steps: [1, 2, 3, 4].map(n => ({ id: `s${n}`, kind: 'act', action: action(`a${n}`) })) };
  const result = await f.coordinator.invoke(invocation(request), session);
  assert.deepEqual(result.receipt.steps.map(s => s.execution), ['completed', 'completed', 'failed', 'skipped']); assert.equal(result.receipt.steps.length, 4); assert.equal(result.receipt.attempted, 3); assert.equal(f.edits, 2);
  await f.coordinator.invoke(invocation(request), session); assert.equal(calls, 3);
});

test('assertion failure after input preserves dispatch and prevents plan tail', async () => {
  const f = fixture({ assertions: { validate: async p => ({ predicateId: p.id, status: 'unsatisfied', producer: 'deterministic', evidenceIds: ['e1'], actionIds: [], reasonCodes: ['value_mismatch'] }) } });
  const result = await f.coordinator.execute(action(), context()); assert.equal(result.failure.kind, 'assertion_failed'); assert.equal(result.dispatch, 'acknowledged'); assert.equal(result.effect, 'unknown'); assert.equal(f.edits, 1);
});

test('two same-intent pre-dispatch failures require bounded read-only diagnosis', async () => {
  const f = fixture(); let calls = 0;
  f.adapter.preflight = async () => { calls++; return { eligible: false, revision, noEffectProven: true, evidence: [], failure: { kind: 'not_ready', code: 'not_ready' } }; };
  await f.coordinator.execute(action(), context()); await f.coordinator.execute(action('a2', { invokeId: 'i2' }), context({ invokeId: 'i2' }));
  const blocked = await f.coordinator.execute(action('a3', { invokeId: 'i3' }), context({ invokeId: 'i3' })); assert.equal(blocked.failure.kind, 'diagnosis_required'); assert.equal(calls, 2);
  const diagnosis = await f.coordinator.diagnose('r1', [async ctx => { await assert.rejects(ctx.dispatch.beforeEffect({}), /diagnosis_read_only/); return { evidenceIds: ['fresh'] }; }], context()); assert.equal(diagnosis.probes, 1);
  await assert.rejects(f.coordinator.diagnose('r1', [async () => {}, async () => {}, async () => {}], context()), /diagnosis_probe_limit/);
  const changed = action('a4', { invokeId: 'i4', operation: { kind: 'focus', ref: action().operation.ref } });
  f.coordinator.allowRecovery('r1', { action: changed, hypothesis: 'field requires focus', evidenceIds: ['fresh'], predictedAssertions: [predicate('focused')] });
  const failedRecovery = await f.coordinator.execute(changed, context({ invokeId: 'i4' })); assert.equal(failedRecovery.failure.kind, 'not_ready'); assert.equal(f.coordinator.detector.status('r1').blocked, true);
});

test('assert/wait/checkpoint plans require live assertions and resume never authorizes prefix replay', async () => {
  const f = fixture(); let captures = 0;
  f.adapter.probe = async () => { captures++; return [evidence()]; };
  const req = { schema: 'muse.plan.v1', planId: 'p1', runId: 'r1', invokeId: 'i1', sessionId: session.id, totalBudgetMs: 1000,
    steps: [{ id: 'assert', kind: 'assert', predicates: [predicate()] }, { id: 'checkpoint', kind: 'checkpoint', requirementIds: ['save'] }, { id: 'wait', kind: 'waitUntil', maxMs: 100, predicates: [predicate()] }] };
  const result = await f.coordinator.invoke(invocation(req), session); assert.equal(result.receipt.execution, 'completed'); assert.deepEqual(result.receipt.checkpointIds, ['p1:checkpoint']); assert.equal(captures, 2); assert.equal(f.edits, 0);
  const invalidResume = { ...req, invokeId: 'i2', resumeCheckpointId: 'p1:checkpoint', steps: [{ id: 'checkpoint', kind: 'checkpoint', requirementIds: [] }] };
  await assert.rejects(f.coordinator.executePlan(invalidResume, context({ invokeId: 'i2' })), /plan_resume_requires_assertions/);
});

test('legacy compatibility calls real injected handlers behind a conservative durable boundary', async () => {
  const journal = new MemoryJournal(); let calls = 0;
  const adapter = new LegacyCommandAdapter({ commandFor: () => ({ command: 'computer.type', params: { text: 'synthetic' } }),
    invokeLegacy: async (command, params, ctx) => { assert.equal(command, 'computer.type'); assert.equal(params.text, 'synthetic'); assert.ok(ctx.actionId); calls++; return {}; },
    preflight: async () => ({ eligible: true, revision, noEffectProven: true, evidence: [] }), probe: async () => [] });
  const f = fixture({ journal, adapter }); const result = await f.coordinator.execute(action('a1', { expect: [] }), context()); assert.equal(calls, 1); assert.equal(result.dispatch, 'possible'); assert.equal(result.effect, 'unknown'); assert.equal(result.replay, 'forbidden');
});

test('admission denial and thrown storage failure retain safe codes and every plan step without dispatch', async () => {
  for (const failure of [
    { kind: 'storage_unavailable', code: 'journal_full' },
    { kind: 'invalid_request', code: 'dedup_collision' },
    { kind: 'history_incomplete', code: 'dedup_expired' },
  ]) {
    const f = fixture();
    f.journal.admit = async () => ({ accepted: false, reserveBytes: 0, failure });
    const denied = await f.coordinator.invoke(invocation(), session);
    assert.equal(denied.receipt.failure.code, failure.code); assert.equal(denied.receipt.failure.kind, failure.kind);
    assert.equal(denied.receipt.dispatch, 'not_started'); assert.equal(f.edits, 0);
    const plan = { schema: 'muse.plan.v1', planId: 'denied-plan', runId: 'r1', invokeId: 'i2', sessionId: session.id, totalBudgetMs: 1000,
      steps: [1, 2, 3].map(n => ({ id: `s${n}`, kind: 'act', action: action(`a${n}`, { invokeId: 'i2' }) })) };
    const result = await f.coordinator.invoke(invocation(plan), session);
    assert.equal(result.receipt.stopReason, failure.code); assert.equal(result.receipt.skipped, 3);
    assert.deepEqual(result.receipt.steps.map(s => s.execution), ['skipped', 'skipped', 'skipped']); assert.equal(f.edits, 0);
  }
  const f = fixture(); f.journal.admit = async () => { throw { failure: { kind: 'storage_unavailable', code: 'journal_timeout' } }; };
  const thrown = await f.coordinator.invoke(invocation(), session); assert.equal(thrown.receipt.failure.code, 'journal_timeout'); assert.equal(f.edits, 0);
});

test('nested plan keeps each action revision and rejects stale refs after an expected transition', async () => {
  const f = fixture(), original = f.adapter.perform; let current = revision, calls = 0;
  f.coordinator.authorize = async () => ({ grant: f.grant || (f.grant = C.createPrivateHandle('grant', 'nested-grant')), revision: current });
  f.adapter.perform = async (op, ctx) => { calls++; const result = await original(op, ctx); current = { ...revision, semanticRevision: 2 }; return { ...result, after: current }; };
  const plan = { schema: 'muse.plan.v1', planId: 'nested-plan', runId: 'r1', invokeId: 'i1', sessionId: session.id, totalBudgetMs: 2000,
    steps: [{ id: 'change', kind: 'act', action: action('a1'), transition: { predicates: [predicate('transition')] } },
      { id: 'stale', kind: 'act', action: action('a2') }, { id: 'tail', kind: 'checkpoint', requirementIds: ['save'] }] };
  const result = await f.coordinator.invoke(invocation(plan), session);
  assert.deepEqual(result.receipt.steps.map(s => s.execution), ['completed', 'rejected', 'skipped']);
  assert.equal(result.receipt.steps[1].failure.kind, 'stale_target'); assert.equal(calls, 1);
  assert.deepEqual(plan.steps[1].action.expectedRevision, revision);
  const selection = action('selection', { operation: { kind: 'select', ref: action().operation.ref, itemRefs: [{ ...action().operation.ref, revision: current }], mode: 'replace' } });
  assert.throws(() => C.validateActionRequest(selection), /ref_revision_mismatch/);
});

test('unsupported dynamic binding rejects all plan steps before effects', async () => {
  const f = fixture();
  const plan = { schema: 'muse.plan.v1', planId: 'binding-plan', runId: 'r1', invokeId: 'i1', sessionId: session.id, totalBudgetMs: 2000,
    steps: [{ id: 'prefix', kind: 'act', action: action('a1') }, { id: 'bind', kind: 'act', action: action('a2'), transition: { predicates: [predicate()], bindAs: 'new-ref' } }] };
  const result = await f.coordinator.invoke(invocation(plan), session);
  assert.equal(result.receipt.execution, 'rejected'); assert.equal(result.receipt.stopReason, 'binding_unavailable');
  assert.equal(result.receipt.skipped, 2); assert.equal(f.edits, 0); assert.equal(result.receipt.attempted, 0);
});

test('afterEffect rejects extra fields and never turns a malformed adapter receipt into no-effect proof', async () => {
  const f = fixture();
  f.adapter.perform = async (_op, ctx) => {
    const h = await ctx.dispatch.beforeEffect({ primitive: 'semantic', substep: 'editText', target });
    await ctx.dispatch.afterEffect(h, { state: 'accepted', noEffectProven: false, status: 'ok' });
  };
  const result = await f.coordinator.invoke(invocation(), session);
  assert.equal(result.receipt.failure.code, 'adapter_contract_violation'); assert.equal(result.receipt.dispatch, 'possible');
  assert.equal(result.receipt.effect, 'unknown'); assert.equal(result.receipt.replay, 'forbidden');
  const g = fixture(); g.adapter.perform = async () => { throw new C.ContractError('unknown_field'); };
  const unrecorded = await g.coordinator.invoke(invocation(), session);
  assert.equal(unrecorded.receipt.effect, 'unknown'); assert.equal(unrecorded.receipt.dispatch, 'possible');
  assert.equal((await g.coordinator.inspect('r1')).execution, 'blocked');
});

test('legacy coarse no-effect flags cannot authorize replay, and missing quiescence stays unknown', async () => {
  const adapter = new LegacyCommandAdapter({ commandFor: () => ({ command: 'fixture', params: {} }), invokeLegacy: async () => ({ noEffectProven: true }),
    preflight: async () => ({ eligible: true, revision, noEffectProven: true, evidence: [] }) });
  const f = fixture({ adapter }); const result = await f.coordinator.invoke(invocation(action('a1', { expect: [] })), session);
  assert.equal(result.receipt.dispatch, 'possible'); assert.equal(result.receipt.effect, 'unknown'); assert.equal(result.receipt.replay, 'forbidden');
  assert.equal((await context().progress.quiesce(async () => {})).state, 'unknown');
});
