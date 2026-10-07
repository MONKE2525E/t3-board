'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { FileJournalStorage, compactResult } = require('../../src/computer/journal/index.cjs');
const { fs, path, ReceiptJournal, target, revision, context, fixture, beginAction, terminal } = require('./helpers.cjs');

test('canonical private MAC, durable intents, equal duplicates and parameter collision', async t => {
  const f = await fixture(t); const j = f.journal;
  await j.registerRun('run-1');
  assert.equal(await j.parameterMac({ b: 2, a: 1 }), await j.parameterMac({ a: 1, b: 2 }));
  assert.notEqual(await j.parameterMac([1, 2]), await j.parameterMac({ 0: 1, 1: 2 }));
  assert.notEqual(await j.parameterMac(-0), await j.parameterMac(0));
  await assert.rejects(j.parameterMac({ a: undefined }), { code: 'invalid_request' });
  await assert.rejects(j.parameterMac({ a: NaN }), { code: 'invalid_request' });
  const { handle, parameterMac, req } = await beginAction(j);
  const key = { ...req, deviceId: 'fixture-device' };
  assert.equal((await j.lookup(key, parameterMac)).state, 'pending');
  const attempt = await j.beforeEffect(handle, { primitive: 'submit', substep: 'click', target, revision });
  const disk = JSON.parse(await fs.readFile(path.join(f.directory, 'ledger.json'), 'utf8'));
  assert.equal(Object.values(disk.state.operations)[0].attempts[0].dispatch, 'possible');
  assert.equal((await j.lookup(key, parameterMac)).state, 'unfinished');
  await j.endAttempt(attempt, { dispatch: 'acknowledged', effect: 'verified', timings: {}, evidenceIds: [] });
  await j.end(handle, terminal());
  assert.equal((await j.lookup(key, parameterMac)).receipt.effect, 'verified');
  assert.equal((await j.lookup(key, await j.parameterMac({ changed: true }))).state, 'collision');
  const reloaded = await f.reopen();
  assert.equal((await reloaded.lookup(key, parameterMac)).state, 'receipt');
  assert.equal((await reloaded.lookup(key, parameterMac)).receipt.dispatch, 'acknowledged');
  await reloaded.retireRun('run-1');
  assert.equal((await reloaded.lookup(key, parameterMac)).state, 'expired');
  await assert.rejects(reloaded.registerRun('run-1'), { code: 'run_retired' });
});

test('remote invoke identity survives session/run changes and numeric shared UTC clock', async t => {
  const f = await fixture(t, { clock: { now: () => 10, utc: () => 1791331200000, domain: 'node.performance' } });
  const j = f.journal; await j.registerRun('run-1');
  const a = await beginAction(j);
  const invocationMac = await j.invocationMac(a.req);
  await j.beforeEffect(a.handle, { primitive: 'submit', substep: 'click', target, revision });
  await j.end(a.handle, terminal());
  await j.registerRun('new-session-run');
  const delivery = await j.lookupInvocation('invoke-1', invocationMac);
  assert.equal(delivery.state, 'receipt'); assert.equal(delivery.receipt.receipt.runId, 'run-1');
  const crossRun = await j.lookup({ ...context(), actionId: undefined, runId: 'new-session-run' }, invocationMac);
  assert.equal(crossRun.state, 'receipt');
  assert.equal((await j.admit({ ...a.req, runId: 'new-session-run' }, 8192)).accepted, false);
  const restarted = await f.reopen();
  assert.equal((await restarted.lookupInvocation('invoke-1', invocationMac)).state, 'receipt');
  assert.equal((await restarted.lookupInvocation('invoke-1', await restarted.invocationMac({ ...a.req, params: { sessionId: 'new-session' } }))).state, 'collision');
  await restarted.retireRun('run-1');
  assert.equal((await restarted.lookupInvocation('invoke-1', invocationMac)).state, 'expired');
  assert.equal((await restarted.admit({ ...a.req, runId: 'new-session-run' }, 8192)).accepted, false);
});

test('admission itself is durable and a racing duplicate is not admitted twice', async t => {
  const f = await fixture(t); const j = f.journal; await j.registerRun('run-1');
  const req = { ...context(), command: 'computer.action', params: {} };
  const results = await Promise.all([j.admit(req, 8192), j.admit(req, 8192)]);
  assert.equal(results.filter(r => r.accepted).length, 1);
  const mac = await j.invocationMac(req);
  const restarted = await f.reopen();
  assert.equal((await restarted.lookupInvocation(req.invokeId, mac)).state, 'unfinished');
});

test('plan reservation remains usable for later actions and invocation finalization accounts for skipped steps', async t => {
  const f = await fixture(t); const j = f.journal; await j.registerRun('run-1');
  const req = { ...context(), command: 'computer.plan', params: { planId: 'plan-1' } };
  assert.equal((await j.admit(req, 128 * 1024)).accepted, true);
  for (let index = 1; index <= 2; index++) {
    const ctx = context('action-' + index);
    const handle = await j.begin(ctx, { command: 'computer.plan', operationKind: 'click', parameterMac: await j.parameterMac({ index }), target });
    await j.beforeEffect(handle, { primitive: 'submit', substep: 'click', target, revision });
    await j.end(handle, terminal(ctx));
  }
  const plan = { planId: 'plan-1', execution: 'failed', attempted: 2, dispatched: 2, verified: 2, skipped: 1, steps: [{ id: 'step-1', index: 0, kind: 'act', execution: 'completed' }, { id: 'step-2', index: 1, kind: 'act', execution: 'failed' }, { id: 'step-3', index: 2, kind: 'act', execution: 'skipped' }] };
  await j.finishInvocation(req, plan);
  const reloaded = await f.reopen();
  const duplicate = await reloaded.lookupInvocation(req.invokeId, await reloaded.invocationMac(req));
  assert.equal(duplicate.state, 'receipt'); assert.equal(duplicate.receipt.receipt.steps[2].execution, 'skipped');
});

test('bounded slow intent write cannot dispatch, and later completion cannot reopen the writer', async t => {
  const directory = await fs.mkdtemp('/tmp/muse-port-d6c9/rewrite/impl-journal/slow-');
  let fail = false; let release;
  const storage = new FileJournalStorage({ directory, fault: point => fail && point === 'intent:write' ? new Promise(resolve => { release = resolve; }) : Promise.resolve() });
  const j = new ReceiptJournal({ storage, deviceId: 'fixture-device', ioTimeoutMs: 30 }); await j.ready;
  t.after(async () => { release?.(); await new Promise(resolve => setTimeout(resolve, 30)); await storage.close(); await fs.rm(directory, { recursive: true, force: true }); });
  await j.registerRun('run-1'); const a = await beginAction(j); fail = true;
  let inputs = 0; const start = Date.now();
  await assert.rejects(async () => { await j.beforeEffect(a.handle, { primitive: 'submit', substep: 'click', target, revision }); inputs++; }, { code: 'journal_timeout' });
  assert.equal(inputs, 0); assert.ok(Date.now() - start < 1000);
  release();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal((await j.admit({ ...context('action-2', 'invoke-2'), command: 'computer.action', params: {} }, 8192)).accepted, false);
  assert.equal((await j.end(a.handle, terminal(context(), { dispatch: 'possible', effect: 'unknown', replay: 'forbidden' }))).persistence, 'degraded');
});

test('reserve ENOSPC rejects admission before any operation', async t => {
  const directory = await fs.mkdtemp('/tmp/muse-port-d6c9/rewrite/impl-journal/reserve-');
  const storage = new FileJournalStorage({ directory, fault: async point => { if (point === 'reserve:write') { const e = new Error('private ENOSPC'); e.code = 'ENOSPC'; throw e; } } });
  const j = new ReceiptJournal({ storage, deviceId: 'fixture-device' }); await j.ready;
  t.after(async () => { await j.close(); await fs.rm(directory, { recursive: true, force: true }); });
  await j.registerRun('run-1');
  const result = await j.admit({ ...context(), command: 'computer.action', params: {} }, 8192);
  assert.equal(result.accepted, false); assert.equal(Object.keys(j.state.operations).length, 0);
});

for (const boundary of ['intent:write', 'intent:sync', 'intent:directory_sync']) {
  test('fault ' + boundary + ' blocks the input boundary', async t => {
    let fail = false;
    const directory = await fs.mkdtemp('/tmp/muse-port-d6c9/rewrite/impl-journal/fault-');
    const storage = new FileJournalStorage({ directory, fault: async point => { if (fail && point === boundary) { const e = new Error('private disk details'); e.code = 'ENOSPC'; throw e; } } });
    const j = new ReceiptJournal({ storage, deviceId: 'fixture-device' }); await j.ready;
    t.after(async () => { await j.close(); await fs.rm(directory, { recursive: true, force: true }); });
    await j.registerRun('run-1');
    const { handle } = await beginAction(j);
    fail = true; let dispatched = 0;
    await assert.rejects(async () => { await j.beforeEffect(handle, { primitive: 'submit', substep: 'click', target, revision }); dispatched++; });
    assert.equal(dispatched, 0);
    assert.equal((await j.admit({ ...context(), command: 'computer.action' }, 8192)).accepted, false);
  });
}

test('terminal write failure preserves the completed input facts and memory dedup', async t => {
  let fail = false;
  const directory = await fs.mkdtemp('/tmp/muse-port-d6c9/rewrite/impl-journal/terminal-');
  const storage = new FileJournalStorage({ directory, fault: async point => { if (fail && point === 'terminal:sync') throw new Error('private terminal failure'); } });
  const j = new ReceiptJournal({ storage, deviceId: 'fixture-device' }); await j.ready;
  t.after(async () => { await j.close(); await fs.rm(directory, { recursive: true, force: true }); });
  await j.registerRun('run-1'); const { handle, parameterMac, req } = await beginAction(j);
  await j.beforeEffect(handle, { primitive: 'submit', substep: 'click', target, revision });
  const independentInput = { submissions: 1 };
  fail = true;
  const receipt = await j.end(handle, terminal());
  assert.equal(independentInput.submissions, 1);
  assert.equal(receipt.dispatch, 'acknowledged'); assert.equal(receipt.effect, 'verified'); assert.equal(receipt.persistence, 'degraded');
  assert.equal((await j.lookup(req, parameterMac)).receipt.effect, 'verified');
  await j.close();
  const recovery = new ReceiptJournal({ directory, deviceId: 'fixture-device' }); await recovery.ready;
  assert.equal((await recovery.lookup(req, parameterMac)).state, 'unfinished');
  await recovery.close();
});

for (const mode of ['marker-only', 'submit', 'terminal']) {
  test('real owned subprocess ' + mode + ' restart cannot authorize a second submit', async t => {
    const directory = await fs.mkdtemp('/tmp/muse-port-d6c9/rewrite/impl-journal/crash-');
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const child = spawn(process.execPath, [path.join(__dirname, 'owned-submit.cjs'), directory, mode], { env: { PATH: process.env.PATH }, stdio: ['ignore', 'pipe', 'pipe'] });
    const result = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => resolve(code)); });
    assert.equal(result, mode === 'terminal' ? 0 : 23);
    const j = new ReceiptJournal({ directory, deviceId: 'fixture-device' }); await j.ready;
    const mac = await j.parameterMac({ kind: 'submit', value: 'synthetic' });
    const key = context();
    const duplicate = await j.lookup(key, mac);
    assert.equal(duplicate.state, mode === 'terminal' ? 'receipt' : 'unfinished');
    const report = await j.recover();
    assert.deepEqual(report.unfinishedActionIds, mode === 'terminal' ? [] : ['action-1']);
    const fence = await j.checkUnfinished({ runId: 'run-1', target });
    assert.deepEqual(fence, { blocked: mode !== 'terminal', unfinishedActionIds: mode === 'terminal' ? [] : ['action-1'] });
    const fresh = { ...context('new-action', 'new-invoke'), command: 'computer.action', params: { kind: 'submit', value: 'synthetic' } };
    assert.equal((await j.lookupDelivery(fresh.invokeId, await j.invocationMac(fresh))).state, 'new');
    let newMutationAdmissions = 0;
    if (!fence.blocked) newMutationAdmissions += Number((await j.admit(fresh, 8192)).accepted);
    assert.equal(newMutationAdmissions, mode === 'terminal' ? 1 : 0);
    if (mode === 'marker-only') await assert.rejects(fs.readFile(path.join(directory, 'fixture-state.json')), { code: 'ENOENT' });
    else assert.equal(JSON.parse(await fs.readFile(path.join(directory, 'fixture-state.json'), 'utf8')).submissions, 1);
    await j.close();
  });
}

test('privacy whitelist excludes request/result/error/label/URL/body canaries on disk and trace', async t => {
  const f = await fixture(t); const j = f.journal;
  await j.registerRun('run-1');
  const canary = 'PRIVATE_CANARY_https://secret.invalid/?password=42';
  const mac = await j.parameterMac({ text: canary, url: canary, cookie: canary });
  await j.admit({ ...context(), command: canary, params: { text: canary } }, 65536);
  const handle = await j.begin(context(), { command: canary, operationKind: canary, parameterMac: mac, target: { ...target, title: canary, url: canary }, inputSizes: { utf8Bytes: 44, [canary]: 1 }, text: canary });
  const attempt = await j.beforeEffect(handle, { primitive: canary, substep: canary, target: { ...target, label: canary }, revision, raw: canary });
  await j.endAttempt(attempt, { dispatch: 'acknowledged', effect: 'unknown', failure: { kind: canary, code: canary, phase: canary, message: canary, stack: canary }, timings: { phases: { [canary]: 1 } }, evidenceIds: [], rawError: canary });
  const receipt = await j.end(handle, terminal(context(), { text: canary, rawError: canary, failure: { kind: canary, code: canary, phase: canary, requiredNext: canary, message: canary }, assertions: [{ predicateId: 'p-1', status: 'unknown', producer: 'model_inferred', reasonCodes: [canary], evidenceIds: [], actionIds: [], narrative: canary }] }));
  assert.ok(!JSON.stringify(receipt).includes(canary));
  assert.ok(!JSON.stringify(await j.read({ runId: 'run-1', maxBytes: 32768 })).includes(canary));
  for (const name of await fs.readdir(f.directory)) {
    if (name === 'key' || name === 'reserve.bin') continue;
    assert.ok(!(await fs.readFile(path.join(f.directory, name), 'utf8')).includes(canary), name);
    assert.equal((await fs.stat(path.join(f.directory, name))).mode & 0o777, 0o600);
  }
  assert.equal((await fs.stat(f.directory)).mode & 0o777, 0o700);
});

test('fixed high-water cursor survives rotation and excludes later appends', async t => {
  const f = await fixture(t, { segmentBytes: 1100 }); const j = f.journal;
  await j.registerRun('run-1');
  const a = await beginAction(j); await j.end(a.handle, terminal(context(), { dispatch: 'not_started', effect: 'none_proven' }));
  const first = await j.read({ runId: 'run-1', limit: 1 });
  assert.ok(first.nextCursor);
  const highWater = first.highWaterSeq;
  const b = await beginAction(j, context('action-2', 'invoke-2')); await j.end(b.handle, terminal(b.ctx));
  const ids = first.events.map(e => e.seq); let cursor = first.nextCursor;
  while (cursor) { const page = await j.read({ runId: 'run-1', cursor, limit: 1 }); assert.equal(page.highWaterSeq, highWater); ids.push(...page.events.map(e => e.seq)); cursor = page.nextCursor; }
  assert.equal(ids.length, new Set(ids).size);
  assert.ok(ids.every(seq => seq <= highWater));
  assert.deepEqual(ids, Array.from({ length: highWater }, (_, index) => index + 1));
  assert.ok((await j.storage.segments()).length > 1);
  const bad = await j.read({ runId: 'run-1', cursor: 'untrusted' }); assert.equal(bad.failure.code, 'cursor_invalid');
});

test('eviction, corruption and partial crash tail report honest gaps', async t => {
  const f = await fixture(t, { segmentBytes: 900 }); const j = f.journal;
  await j.registerRun('run-1'); const a = await beginAction(j); await j.end(a.handle, terminal());
  const first = await j.read({ runId: 'run-1', limit: 1 });
  const segments = await j.storage.segments();
  await j.storage.remove(segments[0].name);
  const expired = await j.read({ runId: 'run-1', cursor: first.nextCursor });
  assert.ok(expired.gaps.length); assert.notEqual(expired.integrity, 'complete');
  const last = segments.at(-1).name;
  await fs.appendFile(path.join(f.directory, last), '{"private":"raw incomplete tail');
  const report = await j.recover(); assert.equal(report.integrity, 'unknown');
  assert.ok(!(await fs.readFile(path.join(f.directory, last), 'utf8')).includes('raw incomplete tail'));
  await fs.appendFile(path.join(f.directory, last), '{bad complete line}\n');
  assert.equal((await j.read({ runId: 'run-1' })).integrity, 'unknown');
});

test('lost key or corrupted ledger never reopens duplicate invocations as new', async t => {
  const f = await fixture(t); await f.journal.registerRun('run-1'); await beginAction(f.journal); await f.journal.close();
  await fs.unlink(path.join(f.directory, 'key'));
  const broken = new ReceiptJournal({ directory: f.directory, deviceId: 'fixture-device' });
  await assert.rejects(broken.ready, { code: 'key_missing' }); await broken.close();
});

test('symlinks and simultaneous writers are rejected without modifying the target', async t => {
  const f = await fixture(t); const second = new ReceiptJournal({ directory: f.directory, deviceId: 'fixture-device' });
  await assert.rejects(second.ready, { code: 'writer_busy' });
  // second never acquired the writer lock, so it must not close the owner's lock.
  const alias = f.directory + '-alias'; await fs.symlink(f.directory, alias);
  t.after(() => fs.unlink(alias));
  const aliased = new ReceiptJournal({ directory: alias, deviceId: 'fixture-device' });
  await assert.rejects(aliased.ready, { code: 'unsafe_path' });
});

test('compact output preserves failure certainty or explicit overflow, and deep action paging', async t => {
  const f = await fixture(t); const j = f.journal; await j.registerRun('run-1');
  const a = await beginAction(j);
  const many = Array.from({ length: 100 }, (_, index) => ({ id: 'attempt-' + index, primitive: 'submit', substep: 'click', target, dispatch: 'sent', effect: 'unknown', timings: {}, evidenceIds: [], failure: { kind: 'transport_lost', code: 'transport_lost', phase: 'dispatch', effect: 'unknown', evidenceIds: [], requiredNext: 'reconcile_readonly' } }));
  const full = await j.end(a.handle, terminal(context(), { attempts: many, effect: 'unknown', replay: 'forbidden' }));
  const compact = compactResult(full); assert.ok(Buffer.byteLength(JSON.stringify(compact)) <= 8192); assert.equal(compact.effect, 'unknown'); assert.equal(compact.replay, 'forbidden');
  const page = await j.readAction({ runId: 'run-1', actionId: 'action-1', limit: 4 });
  assert.equal(page.total, 100); assert.equal(page.items.length, 4); assert.equal(page.nextOffset, 4);
  const plan = compactResult({ planId: 'plan-1', execution: 'failed', attempted: 3, dispatched: 2, verified: 1, skipped: 1, steps: [{ id: 's1', index: 0, kind: 'act', execution: 'completed' }, { id: 's2', index: 1, kind: 'act', execution: 'completed' }, { id: 's3', index: 2, kind: 'act', execution: 'failed', failure: { kind: 'transport_lost', code: 'transport_lost', phase: 'dispatch', effect: 'unknown', evidenceIds: [] } }, { id: 's4', index: 3, kind: 'act', execution: 'skipped' }] });
  assert.equal(plan.steps[2].failure.code, 'transport_lost'); assert.equal(plan.steps[3].execution, 'skipped'); assert.equal(plan.attempted, 3);
});

test('large terminal receipt pages retain all details after restart and trace eviction', async t => {
  const f = await fixture(t); let j = f.journal; await j.registerRun('run-1');
  const a = await beginAction(j);
  const attempts = Array.from({ length: 100 }, (_, i) => ({ id: 'attempt-' + i, primitive: 'submit', substep: 'click', target, dispatch: 'sent', effect: 'unknown', timings: {}, evidenceIds: ['evidence-' + i] }));
  const assertions = Array.from({ length: 32 }, (_, i) => ({ predicateId: 'predicate-' + i, status: 'unknown', producer: 'deterministic', reasonCodes: [], evidenceIds: ['evidence-' + i], actionIds: ['action-1'] }));
  const artifacts = Array.from({ length: 64 }, (_, i) => ({ id: 'artifact-' + i, availability: 'transfer_failed', freshness: 'current' }));
  const full = await j.end(a.handle, terminal(context(), { attempts, assertions, artifacts, effect: 'unknown', replay: 'forbidden' }));
  assert.ok(Buffer.byteLength(JSON.stringify(full)) > 8192);
  const compact = compactResult(full);
  assert.equal(compact.detail.actionId, 'action-1'); assert.equal(compact.detail.offset, 0);
  for (const segment of await j.storage.segments()) await j.storage.remove(segment.name);
  j = await f.reopen();
  for (const [section, expected] of Object.entries({ attempts, assertions, artifacts })) {
    let offset = 0; const items = [];
    do {
      const page = await j.readAction({ runId: 'run-1', actionId: 'action-1', section, offset, limit: 7, maxBytes: 4096 });
      assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 4096);
      assert.equal(page.receipt.replay, 'forbidden'); assert.equal(page.receipt.effect, 'unknown');
      assert.equal(page.receipt.journal.integrity, 'gapped');
      assert.equal(page.total, expected.length); assert.ok(page.items.length > 0);
      items.push(...page.items);
      if (page.nextOffset === undefined) break;
      assert.ok(page.nextOffset > offset); offset = page.nextOffset;
    } while (true);
    assert.deepEqual(items.map(item => item.id || item.predicateId), expected.map(item => item.id || item.predicateId));
    assert.equal(new Set(items.map(item => item.id || item.predicateId)).size, expected.length);
  }
  assert.equal((await j.lookupDelivery(a.req.invokeId, await j.invocationMac(a.req))).state, 'receipt');
  await assert.rejects(j.readAction({ runId: 'run-1', actionId: 'action-1', limit: NaN }), { code: 'invalid_request' });
});

test('one oversized detail returns explicit bounded overflow with no paging loop', async t => {
  const f = await fixture(t); const j = f.journal; await j.registerRun('run-1');
  const a = await beginAction(j);
  const assertion = { predicateId: 'large-predicate', status: 'unknown', producer: 'deterministic', reasonCodes: [], evidenceIds: Array.from({ length: 100 }, (_, i) => 'evidence-' + i), actionIds: [] };
  await j.end(a.handle, terminal(context(), { assertions: [assertion] }));
  const page = await j.readAction({ runId: 'run-1', actionId: 'action-1', section: 'assertions', maxBytes: 1024 });
  assert.equal(page.failure.code, 'result_overflow'); assert.equal(page.replay, 'forbidden');
  assert.equal(page.nextOffset, undefined); assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 1024);
});

test('coordinator recovery instructions survive safe terminal and duplicate projections', async t => {
  const f = await fixture(t); const j = f.journal; await j.registerRun('run-1');
  const a = await beginAction(j);
  await j.beforeEffect(a.handle, { primitive: 'submit', substep: 'click', target, revision });
  const failure = { kind: 'transport_lost', code: 'unfinished_action', phase: 'dispatch', effect: 'unknown', evidenceIds: [], requiredNext: 'read_authoritative_state_do_not_replay' };
  const receipt = await j.end(a.handle, terminal(context(), { effect: 'unknown', replay: 'forbidden', failure }));
  assert.equal(receipt.failure.requiredNext, failure.requiredNext);
  assert.equal(receipt.failure.code, failure.code);
  const restarted = await f.reopen();
  const duplicate = await restarted.lookupDelivery(a.req.invokeId, await restarted.invocationMac(a.req));
  assert.equal(duplicate.receipt.receipt.failure.requiredNext, failure.requiredNext);
  const page = await restarted.readAction({ runId: 'run-1', actionId: 'action-1' });
  assert.equal(page.receipt.failure.requiredNext, failure.requiredNext);
});

test('startup unfinished fence is read-only and matches every exact target lifetime field', async t => {
  const f = await fixture(t); let j = f.journal; await j.registerRun('run-1');
  const exact = { ...target, browserInstance: 'browser-1', compositorInstance: 'compositor-1', connectionEpoch: 1, process: { pid: 1234, startToken: 'process-start-1' } };
  const a = await beginAction(j);
  await j.beforeEffect(a.handle, { primitive: 'submit', substep: 'click', target: exact, revision });
  assert.deepEqual(await j.checkUnfinished({ runId: 'run-1', target: exact }), { blocked: false, unfinishedActionIds: [] });
  j = await f.reopen();
  const before = await fs.readFile(path.join(f.directory, 'ledger.json'));
  const fence = await j.checkUnfinished({ runId: 'run-1', target: exact });
  assert.deepEqual(fence, { blocked: true, unfinishedActionIds: ['action-1'] });
  for (const change of [
    { sessionId: 'other-session' }, { kind: 'window' }, { targetId: 'other-tab' },
    { generation: 2 }, { ownership: 'borrowed' }, { browserInstance: 'browser-2' },
    { compositorInstance: 'compositor-2' }, { connectionEpoch: 2 },
    { process: { ...exact.process, pid: 2345 } }, { process: { ...exact.process, startToken: 'other-start' } },
  ]) assert.deepEqual(await j.checkUnfinished({ runId: 'run-1', target: { ...exact, ...change } }), { blocked: false, unfinishedActionIds: [] });
  assert.deepEqual(await fs.readFile(path.join(f.directory, 'ledger.json')), before);
  await assert.rejects(j.checkUnfinished({ runId: 'unknown-run', target: exact }), { code: 'run_unknown' });
});

test('startup fence excludes terminal unverified receipts and proven unentered effects', async t => {
  const f = await fixture(t); let j = f.journal; await j.registerRun('run-1');
  const beforeMarker = await beginAction(j);
  const completed = await beginAction(j, context('completed-action', 'completed-invoke'));
  await j.beforeEffect(completed.handle, { primitive: 'submit', substep: 'click', target, revision });
  await j.end(completed.handle, terminal(completed.ctx, { effect: 'unknown' }));
  const rejected = await beginAction(j, context('rejected-action', 'rejected-invoke'));
  const rejectedAttempt = await j.beforeEffect(rejected.handle, { primitive: 'submit', substep: 'click', target, revision });
  await j.endAttempt(rejectedAttempt, { dispatch: 'not_started', effect: 'none_proven', evidenceIds: [], timings: {} });
  j = await f.reopen();
  assert.equal((await j.lookup(beforeMarker.req, beforeMarker.parameterMac)).state, 'unfinished');
  assert.deepEqual(await j.checkUnfinished({ runId: 'run-1', target }), { blocked: false, unfinishedActionIds: [] });
  assert.equal((await j.lookupDelivery(completed.req.invokeId, await j.invocationMac(completed.req))).receipt.receipt.effect, 'unknown');
});
