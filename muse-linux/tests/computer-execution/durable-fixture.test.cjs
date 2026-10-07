'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { join } = require('node:path');
const { fork } = require('node:child_process');
const { once } = require('node:events');
const { ReceiptJournal, RunReducer } = require('../../src/computer/journal/index.cjs');
const { AssertionRegistry } = require('../../src/computer/state/index.cjs');
const { ExecutionCoordinator, LegacyCommandAdapter } = require('../../src/computer/executor.cjs');
const { createPrivateHandle } = require('../../src/computer/contracts.cjs');
const { defaultClock } = require('../../src/computer/progress.cjs');
const { action, invocation, target, revision, session, predicate, evidence, context } = require('./helpers.cjs');
const root = '/tmp/muse-port-d6c9/rewrite/impl-execution';

test('process death after an owned lost-reply commit recovers unfinished receipt and reducer without input replay', { timeout: 10000 }, async t => {
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const directory = await fs.mkdtemp(join(root, 'crash-recovery-'));
  const service = fork(join(__dirname, 'fixture-service.cjs'), [directory], { env: { PATH: '/usr/bin:/bin' }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  const serviceExit = once(service, 'exit');
  t.after(async () => { if (service.exitCode === null) service.send('stop'); await serviceExit; });
  const [connection] = await once(service, 'message', { signal: AbortSignal.timeout(3000) });
  const endpoint = `http://127.0.0.1:${connection.port}`, text = 'Committed before crash\n你好🙂';
  const crash = fork(join(__dirname, 'crash-client.cjs'), [], { env: { PATH: '/usr/bin:/bin' }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  const crashExit = once(crash, 'exit', { signal: AbortSignal.timeout(5000) });
  t.after(() => { if (crash.exitCode === null) crash.kill('SIGKILL'); });
  const ledger = join(directory, 'journal'); crash.send({ directory: ledger, endpoint, token: connection.token, text });
  const [code, signal] = await crashExit; assert.equal(code, 23); assert.equal(signal, null);
  const independent = JSON.parse(await fs.readFile(join(directory, 'application-state.json'), 'utf8'));
  assert.deepEqual(independent, { text, commits: 1 });
  const journal = new ReceiptJournal({ directory: ledger, deviceId: 'device-fixture', clock: { ...defaultClock, utc: () => new Date().toISOString() } });
  t.after(() => journal.close());
  const recovery = await journal.recover(); assert.deepEqual(recovery.unfinishedActionIds, ['a1']); assert.equal(recovery.integrity, 'complete');
  const registry = new AssertionRegistry({ builtins: false });
  registry.register('fixture.value', 1, async (p, observations) => ({ predicateId: p.id,
    status: observations.some(e => e.facts.some(f => f.predicate === 'text.value' && f.value === p.args.expected)) ? 'satisfied' : 'unsatisfied',
    producer: 'deterministic', evidenceIds: observations.map(e => e.id), actionIds: [], reasonCodes: [] }));
  const requirements = [predicate('save', { expected: text }), predicate('tracking', { expected: 'unattempted' })];
  const reducer = new RunReducer({ journal, assertionRegistry: registry }); await reducer.restoreManifest('r1', requirements);
  let effects = 0, probes = 0;
  const grant = createPrivateHandle('grant', 'recovered-grant');
  const adapter = {
    preflight: async () => ({ eligible: true, revision, evidence: [], noEffectProven: true }),
    perform: async () => { effects++; throw new Error('recovery must not input'); },
    probe: async (_predicates, _target, ctx) => {
      probes++; const res = await fetch(endpoint + '/state', { headers: { Authorization: `Bearer ${connection.token}` }, signal: ctx.signal });
      assert.equal(res.status, 200); const app = await res.json(); assert.equal(app.commits, 1);
      return [{ ...evidence([{ predicate: 'text.value', value: app.text, evidenceIds: ['post-crash'], suitability: 'authoritative' }]), id: 'post-crash' }];
    },
    quiesce: async () => ({ state: 'confirmed', ownedInputReleased: true, reasonCodes: [] }),
  };
  const coordinator = new ExecutionCoordinator({ journal, adapter, reducer, assertions: registry, authorize: async () => ({ grant, revision }) });
  const request = action(); request.operation.edit.text = text; request.expect = [requirements[0]];
  const newRequest = { ...request, actionId: 'a2', invokeId: 'i2' }, freshInvocation = invocation(newRequest);
  const blocked = await coordinator.invoke(freshInvocation, session);
  assert.equal(blocked.receipt.failure.code, 'unfinished_action'); assert.equal(blocked.receipt.execution, 'rejected');
  assert.equal(blocked.receipt.dispatch, 'not_started'); assert.equal(blocked.receipt.effect, 'none_proven');
  assert.equal((await journal.lookupInvocation('i2', await journal.invocationMac(freshInvocation))).state, 'new');
  const recovered = await coordinator.invoke(invocation(request), session);
  assert.equal(recovered.receipt.execution, 'unfinished'); assert.equal(recovered.receipt.dispatch, 'possible');
  assert.equal(recovered.receipt.effect, 'unknown'); assert.equal(recovered.receipt.replay, 'forbidden'); assert.equal(effects, 0);
  await reducer.recordAction('r1', recovered.receipt, ['save']);
  const beforeProbe = await coordinator.inspect('r1');
  assert.equal(beforeProbe.outcome, 'incomplete'); assert.equal(beforeProbe.requirements[0].status, 'attempted_unverified');
  assert.equal(beforeProbe.requirements[1].status, 'not_attempted'); assert.equal(beforeProbe.counters.primitiveAttempts, 1);
  await reducer.verify('r1', ['save'], await adapter.probe([requirements[0]], target, context()), context());
  const afterProbe = await coordinator.inspect('r1');
  assert.equal(afterProbe.requirements[0].status, 'verified_present'); assert.equal(afterProbe.requirements[1].status, 'not_attempted');
  assert.equal(afterProbe.outcome, 'incomplete'); assert.equal(probes, 1); assert.equal(effects, 0);
  const events = await journal.read({ runId: 'r1', limit: 100 });
  assert.equal(events.events.filter(e => e.kind === 'attempt.intent').length, 1);
  assert.equal(events.events.filter(e => e.kind === 'action.end').length, 0);
  const result = { schema: 'muse.execution_crash_fixture.v1', fixture: 'owned_node_application', realJournal: true, realRunReducer: true,
    coordinatorProcessExit: code, recoveredActionIds: recovery.unfinishedActionIds, recoveredReceipt: { execution: recovered.receipt.execution, dispatch: recovered.receipt.dispatch, effect: recovered.receipt.effect, replay: recovered.receipt.replay },
    beforeReadOnlyProbe: beforeProbe.requirements.map(r => ({ id: r.id, status: r.status })), afterReadOnlyProbe: afterProbe.requirements.map(r => ({ id: r.id, status: r.status })),
    applicationCommits: independent.commits, durablePrimitiveIntents: 1, recoveredInputCalls: effects, recoveryProbes: probes, uncertainReplays: 0,
    newInvokeFence: { blocked: true, admitted: false, dispatch: blocked.receipt.dispatch, effect: blocked.receipt.effect },
    modelRequests: afterProbe.counters.modelRequests, modelMetricProvenance: afterProbe.counters.modelMetricProvenance, journalIntegrity: recovery.integrity,
    skipped: ['GUI/browser/AT-SPI/physical input', 'packaged app', 'real account E2E', 'performance distribution'] };
  await fs.writeFile(join(root, 'crash-recovery-result.json'), JSON.stringify(result, null, 2), { mode: 0o600 });
});

test('real owned application + owner journal + owner assertions prove Unicode edit, restart dedup, and lost reply safety', { timeout: 10000 }, async t => {
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const directory = await fs.mkdtemp(join(root, 'application-'));
  const child = fork(join(__dirname, 'fixture-service.cjs'), [directory], { env: { PATH: '/usr/bin:/bin' }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  const exit = once(child, 'exit'); t.after(async () => { if (child.exitCode === null) child.send('stop'); await exit; });
  const [connection] = await once(child, 'message');
  const endpoint = `http://127.0.0.1:${connection.port}`;
  const call = async (route, ctx, body) => {
    const res = await fetch(endpoint + route, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${connection.token}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}), signal: ctx.signal });
    assert.equal(res.status, 200); return res.json();
  };
  const journalClock = { ...defaultClock, utc: () => new Date().toISOString() }, ledger = join(directory, 'journal');
  let journal = new ReceiptJournal({ directory: ledger, deviceId: 'device-fixture', clock: journalClock });
  t.after(async () => { await journal.close(); });
  const registry = new AssertionRegistry({ builtins: false });
  registry.register('fixture.value', 1, async (p, observations) => ({ predicateId: p.id,
    status: observations.some(e => e.facts.some(f => f.predicate === 'text.value' && f.value === p.args.expected)) ? 'satisfied' : 'unsatisfied',
    producer: 'deterministic', evidenceIds: observations.map(e => e.id), actionIds: [], reasonCodes: [] }));
  const text = 'Unicode fixture\n你好🙂e\u0301\tمرحبا';
  const requirements = [predicate('save', { expected: text }), predicate('tracking', { expected: 'unattempted synthetic requirement' })];
  let reducer = new RunReducer({ journal, assertionRegistry: registry });
  await reducer.begin({ runId: 'r1', requirements });
  const grant = createPrivateHandle('grant', 'fixture-grant'), authorize = async () => ({ grant, revision });
  let route = '/edit', dispatches = 0;
  const direct = {
    preflight: async () => ({ eligible: true, revision, evidence: [], noEffectProven: true }),
    perform: async (op, ctx) => {
      const handle = await ctx.dispatch.beforeEffect({ primitive: 'atspi.SetTextContents', substep: 'editText', target }); dispatches++;
      try { await call(route, ctx, { text: op.edit.text }); }
      catch { await ctx.dispatch.afterEffect(handle, { state: 'lost', noEffectProven: false }); throw Object.assign(new Error('fixture reply lost'), { kind: 'transport_lost', code: 'transport_lost' }); }
      await ctx.dispatch.afterEffect(handle, { state: 'accepted', noEffectProven: false });
      return { target, before: revision, dispatch: 'acknowledged', effect: 'unknown', attempts: [], evidence: [], timings: ctx.progress.timings() };
    },
    probe: async (_predicates, _target, ctx) => { const value = await call('/state', ctx); return [evidence([{ predicate: 'text.value', value: value.text, evidenceIds: ['e1'], suitability: 'authoritative' }])]; },
    quiesce: async () => ({ state: 'confirmed', ownedInputReleased: true, reasonCodes: [] }),
  };
  let coordinator = new ExecutionCoordinator({ journal, adapter: direct, assertions: registry, authorize, clock: defaultClock, reducer });
  const request = action(); request.operation.edit.text = text; request.expect = [requirements[0]];
  const first = await coordinator.invoke(invocation(request), session);
  assert.equal(first.receipt.effect, 'verified'); assert.equal(first.receipt.persistence, 'durable'); assert.equal(first.receipt.journal.integrity, 'complete');
  const app = JSON.parse(await fs.readFile(join(directory, 'application-state.json'), 'utf8')); assert.deepEqual(app, { text, commits: 1 });
  // Main binds actual ledger actions and verifies retained evidence. Final prose is not authority.
  await reducer.recordAction('r1', first.receipt, ['save']);
  await reducer.verify('r1', ['save'], await direct.probe([requirements[0]], target, context()), context());
  const handoff = await coordinator.inspect('r1');
  assert.equal(handoff.outcome, 'incomplete'); assert.equal(handoff.requirements[0].status, 'verified_present');
  assert.equal(handoff.requirements[1].status, 'not_attempted'); assert.deepEqual(handoff.requirements[1].actionIds, []);
  await journal.close();
  journal = new ReceiptJournal({ directory: ledger, deviceId: 'device-fixture', clock: journalClock });
  reducer = new RunReducer({ journal, assertionRegistry: registry }); await reducer.restoreManifest('r1', requirements);
  coordinator = new ExecutionCoordinator({ journal, adapter: direct, assertions: registry, authorize, clock: defaultClock, reducer });
  const restoredHandoff = await coordinator.inspect('r1');
  assert.equal(restoredHandoff.requirements[0].status, 'verified_present'); assert.equal(restoredHandoff.requirements[1].status, 'not_attempted');
  const duplicate = await coordinator.invoke(invocation(request), session); assert.equal(duplicate.receipt.effect, 'verified'); assert.equal(dispatches, 1);
  const changed = action(); changed.operation.edit.text = 'different'; const mismatch = await coordinator.invoke(invocation(changed), session);
  assert.equal(mismatch.receipt.failure.code, 'dedup_collision'); assert.equal(dispatches, 1);
  route = '/lost-reply';
  const lostRequest = action('a2', { invokeId: 'i2' }); lostRequest.operation.edit.text = 'lost reply still committed'; lostRequest.expect = [predicate('value', { expected: lostRequest.operation.edit.text })];
  const lost = await coordinator.invoke(invocation(lostRequest), session); assert.equal(lost.receipt.effect, 'unknown'); assert.equal(lost.receipt.replay, 'forbidden');
  await reducer.recordAction('r1', lost.receipt, ['save']);
  const afterLost = await coordinator.inspect('r1');
  assert.equal(afterLost.requirements[0].status, 'attempted_unverified'); assert.equal(afterLost.requirements[1].status, 'not_attempted');
  const independent = JSON.parse(await fs.readFile(join(directory, 'application-state.json'), 'utf8')); assert.equal(independent.commits, 2); assert.equal(independent.text, lostRequest.operation.edit.text);
  await journal.close(); journal = new ReceiptJournal({ directory: ledger, deviceId: 'device-fixture', clock: journalClock });
  reducer = new RunReducer({ journal, assertionRegistry: registry }); await reducer.restoreManifest('r1', requirements);
  coordinator = new ExecutionCoordinator({ journal, adapter: direct, assertions: registry, authorize, clock: defaultClock, reducer });
  const replay = await coordinator.invoke(invocation(lostRequest), session); assert.equal(replay.receipt.effect, 'unknown'); assert.equal(dispatches, 2);
  const result = { schema: 'muse.execution_fixture.v1', fixture: 'owned_node_application', realJournal: true, ownerAssertionRegistry: true, unicodeReadback: true, persistedDedup: true,
    realRunReducer: true, handoff: { beforeLaterInput: handoff.requirements.map(r => ({ id: r.id, status: r.status })), afterLaterInput: afterLost.requirements.map(r => ({ id: r.id, status: r.status })), persistedAcrossRestart: true },
    applicationCommits: independent.commits, primitiveBoundaryAttempts: dispatches, uncertainReplays: 0, modelRoundTrips: null, modelMetricProvenance: 'scripted_no_model',
    skipped: ['GUI/browser/AT-SPI/physical input/Pause controls', 'packaged app integration', 'upstream model correlation'], journalIntegrity: replay.receipt.journal.integrity };
  await fs.writeFile(join(root, 'real-fixture-result.json'), JSON.stringify(result, null, 2), { mode: 0o600 });
});

test('owner browser/desktop-shaped adapters compose with durable journal; physical legacy return stays possible/unknown', { timeout: 10000 }, async t => {
  await fs.mkdir(root, { recursive: true, mode: 0o700 }); const directory = await fs.mkdtemp(join(root, 'composition-'));
  const journal = new ReceiptJournal({ directory: join(directory, 'journal'), deviceId: 'device-fixture', clock: { ...defaultClock, utc: () => new Date().toISOString() } });
  t.after(() => journal.close()); await journal.registerRun('desktop-run'); await journal.registerRun('browser-run');
  const grant = createPrivateHandle('grant', 'composition-grant'); let legacyCalls = 0, browserCalls = 0;
  const physical = new LegacyCommandAdapter({ commandFor: () => ({ command: 'computer.press_key', params: { key: 'Control+a' } }), invokeLegacy: async () => { legacyCalls++; return { dispatched: true }; },
    preflight: async () => ({ eligible: true, revision, evidence: [], noEffectProven: true }) });
  const tab = { ...target, sessionId: 'browser-session', kind: 'tab', targetId: 'selected-tab', ownership: 'borrowed', browserInstance: 'browser-fixture', connectionEpoch: 1 };
  const browserSession = { id: tab.sessionId, mode: 'borrowed_browser', state: 'ready', generation: 1, ownership: 'borrowed' };
  const browser = {
    preflight: async () => ({ eligible: true, revision, evidence: [], noEffectProven: true }),
    perform: async (op, ctx) => { const h = await ctx.dispatch.beforeEffect({ primitive: 'Page.navigate', substep: 'navigate', target: tab }); browserCalls++; await ctx.dispatch.afterEffect(h, { state: 'accepted', noEffectProven: false }); return { target: tab, before: revision, dispatch: 'acknowledged', effect: 'unknown', attempts: [], evidence: [], timings: ctx.progress.timings() }; },
    probe: async () => [], quiesce: async () => ({ state: 'confirmed', ownedInputReleased: false, reasonCodes: [] }),
  };
  const coordinator = new ExecutionCoordinator({ journal, selectAdapter: t => t.kind === 'tab' ? browser : physical, authorize: async () => ({ grant, revision }) });
  const desktop = action('physical', { runId: 'desktop-run', expect: [], operation: { kind: 'press', target, chord: 'Control+a' } });
  const p = await coordinator.invoke(invocation(desktop), session); assert.equal(p.receipt.dispatch, 'possible'); assert.equal(p.receipt.effect, 'unknown'); assert.equal(p.receipt.replay, 'forbidden'); assert.equal(legacyCalls, 1); assert.equal(p.receipt.persistence, 'durable', JSON.stringify(journal.status));
  const navigation = action('navigate', { runId: 'browser-run', invokeId: 'browser-invoke', target: tab, expect: [], operation: { kind: 'navigate', target: tab, url: 'https://example.test/fixture' } });
  const b = await coordinator.invoke(invocation(navigation), browserSession); assert.equal(b.receipt.failure, undefined, JSON.stringify(b.receipt)); assert.equal(b.receipt.dispatch, 'acknowledged'); assert.equal(b.receipt.effect, 'unknown'); assert.equal(browserCalls, 1);
  const all = await journal.read({ runId: 'desktop-run', limit: 100 }); assert.ok(all.events.some(e => e.kind === 'attempt.intent')); assert.ok(all.events.some(e => e.kind === 'action.end'));
  await journal.registerRun('plan-run');
  const planInvocation = 'plan-invoke'; let planCalls = 0;
  browser.preflight = async () => ({ eligible: planCalls < 2, revision, evidence: [], noEffectProven: true, ...(planCalls >= 2 ? { failure: { kind: 'not_ready', code: 'not_ready' } } : {}) });
  const perform = browser.perform;
  browser.perform = async (op, ctx) => { planCalls++; return perform(op, ctx); };
  const planAction = (n, operation) => action(`plan-action-${n}`, { runId: 'plan-run', invokeId: planInvocation, target: tab, operation, expect: [] });
  const plan = { schema: 'muse.plan.v1', planId: 'durable-plan', runId: 'plan-run', invokeId: planInvocation, sessionId: tab.sessionId, totalBudgetMs: 2000,
    steps: [{ id: 'one', kind: 'act', action: planAction(1, { kind: 'navigate', target: tab, url: 'https://example.test/one' }) },
      { id: 'two', kind: 'act', action: planAction(2, { kind: 'press', target: tab, chord: 'ArrowDown' }) },
      { id: 'three', kind: 'act', action: planAction(3, { kind: 'dialog', dialogId: 'dialog', decision: 'dismiss' }) },
      { id: 'four', kind: 'act', action: planAction(4, { kind: 'downloadStatus', downloadId: 'download' }) }] };
  coordinator.translate = () => plan;
  const wirePlan = invocation(plan, { params: { request: JSON.stringify(plan) } });
  const p4 = await coordinator.invoke(wirePlan, browserSession); assert.deepEqual(p4.receipt.steps.map(s => s.execution), ['completed', 'completed', 'failed', 'skipped']); assert.equal(planCalls, 2);
  await journal.close();
  const reopened = new ReceiptJournal({ directory: join(directory, 'journal'), deviceId: 'device-fixture', clock: { ...defaultClock, utc: () => new Date().toISOString() } }); t.after(() => reopened.close());
  const restored = new ExecutionCoordinator({ journal: reopened, adapter: browser, authorize: async () => ({ grant, revision }), translate: () => plan });
  const savedPlan = await restored.invoke(wirePlan, browserSession); assert.equal(savedPlan.receipt.stopReason, 'not_ready'); assert.equal(planCalls, 2);
  const changedWire = { ...wirePlan, params: { request: JSON.stringify(plan) + ' ' } };
  await assert.rejects(restored.invoke(changedWire, browserSession), { code: 'dedup_collision' });
  const collisionCoordinator = new ExecutionCoordinator({ journal: reopened, adapter: browser, authorize: async () => ({ grant, revision }), translate: () => plan });
  const collision = await collisionCoordinator.invoke(changedWire, browserSession); assert.equal(collision.receipt.stopReason, 'dedup_collision'); assert.equal(planCalls, 2);
});
