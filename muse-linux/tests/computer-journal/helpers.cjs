'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { ReceiptJournal, RunReducer } = require('../../src/computer/journal/index.cjs');
const target = { sessionId: 'session-1', kind: 'tab', targetId: 'tab-1', generation: 1, ownership: 'owned' };
const revision = { sessionGeneration: 1, grantGeneration: 1, targetGeneration: 1, documentEpoch: 1, semanticRevision: 1, geometryRevision: 1 };
const context = (actionId = 'action-1', invokeId = 'invoke-1', runId = 'run-1') => ({ deviceId: 'fixture-device', runId, invokeId, actionId, revision, budget: { clockDomain: 'main', deadlineMonoMs: 10000 } });
async function fixture(t, options = {}) {
  const root = '/tmp/muse-port-d6c9/rewrite/impl-journal';
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const directory = await fs.mkdtemp(path.join(root, 'test-'));
  let journal = new ReceiptJournal({ directory, deviceId: 'fixture-device', ...options });
  await journal.ready;
  t.after(async () => { await journal.close(); await fs.rm(directory, { recursive: true, force: true }); });
  return { directory, get journal() { return journal; }, async reopen() { await journal.close(); journal = new ReceiptJournal({ directory, deviceId: 'fixture-device', ...options }); await journal.ready; return journal; } };
}
async function beginAction(journal, ctx = context(), params = { kind: 'submit', value: 'synthetic' }) {
  const parameterMac = await journal.parameterMac(params);
  const req = { ...ctx, params, command: 'computer.action' };
  const admitted = await journal.admit(req, 65536);
  if (!admitted.accepted) throw new Error(JSON.stringify(admitted));
  const handle = await journal.begin(ctx, { command: 'computer.action', operationKind: 'click', target, parameterMac });
  return { handle, parameterMac, req, ctx };
}
function terminal(ctx = context(), overrides = {}) {
  return { schema: 'muse.action_receipt.v1', runId: ctx.runId, invokeId: ctx.invokeId, actionId: ctx.actionId, target, before: revision, after: revision, execution: 'completed', dispatch: 'acknowledged', effect: 'verified', attempts: [], assertions: [], replay: 'same_id_receipt_only', timings: { clockDomain: 'main', startMonoMs: 1, endMonoMs: 2, totalMs: 1, phases: {} }, artifacts: [], persistence: 'durable', journal: { throughSeq: 0, integrity: 'complete' }, ...overrides };
}
function predicate(id = 'saved') { return { id, validator: 'fixture_saved', validatorVersion: 1, target, args: { expected: true } }; }
function evidence(id = 'evidence-1', overrides = {}) {
  return { id, source: 'dom', producer: 'fixture', target, revisionBefore: revision, revisionAfter: revision, interval: { startMonoMs: 1, endMonoMs: 2, clockDomain: 'main', utc: '2026-10-07T00:00:00.000Z' }, acquisition: 'ok', freshness: 'current', reasons: [], coverage: { scope: 'selected_target', complete: true, truncated: false, omittedFrames: [], omissionReasons: [] }, facts: [{ predicate: 'saved', value: true, evidenceIds: [id], suitability: 'authoritative' }], derivedFrom: [], ...overrides };
}
function registry(producer = 'deterministic', status = 'satisfied') {
  return { async validate(predicate, evidence) { return { predicateId: predicate.id, status, producer, evidenceIds: evidence.map(e => e.id), actionIds: [], reasonCodes: [], observedRevision: revision }; } };
}
module.exports = { fs, path, ReceiptJournal, RunReducer, target, revision, context, fixture, beginAction, terminal, predicate, evidence, registry };
