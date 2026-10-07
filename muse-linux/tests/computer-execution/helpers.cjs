'use strict';
const { createHmac } = require('node:crypto');
const { Progress } = require('../../src/computer/progress.cjs');
const { ExecutionCoordinator } = require('../../src/computer/executor.cjs');
const { createPrivateHandle } = require('../../src/computer/contracts.cjs');
const target = { sessionId: 'fixture-session', kind: 'window', targetId: 'fixture-window', generation: 1, ownership: 'owned' };
const revision = { sessionGeneration: 1, grantGeneration: 1, targetGeneration: 1, semanticRevision: 1, geometryRevision: 1 };
const session = { id: target.sessionId, mode: 'isolated_desktop', state: 'ready', generation: 1, ownership: 'owned', display: { instanceId: 'fixture-display' } };
const ref = { id: 'field', refSetId: 'refs', target, revision, source: 'atspi', identity: { role: 'entry', semanticFingerprint: 'fixture-field' }, capabilities: ['editText'] };
function evidence(facts = []) { return { id: 'e1', source: 'atspi', producer: 'fixture', target, revisionBefore: revision, revisionAfter: revision,
  interval: { startMonoMs: performance.now(), endMonoMs: performance.now(), clockDomain: 'node.performance', utc: new Date().toISOString() }, acquisition: 'ok', freshness: 'current', reasons: [],
  coverage: { scope: 'fixture-field', complete: true, truncated: false, omittedFrames: [], omissionReasons: [] }, facts, derivedFrom: [] }; }
function predicate(id = 'value', args = {}) { return { id, validator: 'fixture.value', validatorVersion: 1, target, args, requirementId: 'save' }; }
function action(actionId = 'a1', options = {}) {
  return { schema: 'muse.action.v1', actionId, runId: 'r1', invokeId: 'i1', target, expectedRevision: revision,
    operation: { kind: 'editText', ref, edit: { mode: 'replace', text: 'hello', semantics: 'plain_text', newlinePolicy: 'literal_multiline', clipboard: 'forbid' } }, require: [], expect: [predicate()], requirementIds: ['save'], ...options };
}
function invocation(request = action(), overrides = {}) { return { deviceId: 'device-fixture', runId: request.runId, invokeId: request.invokeId, command: request.schema === 'muse.plan.v1' ? 'computer.plan' : 'computer.action', params: request, deadlineUtcMs: Date.now() + 2000, ...overrides }; }
function context(options = {}) { const progress = new Progress({ budget: { deadlineMonoMs: performance.now() + 2000, clockDomain: 'node.performance' } }); return { runId: 'r1', invokeId: 'i1', sessionId: session.id, deviceId: 'device-fixture', session, progress, signal: progress.signal, budget: progress.budget, revision, ...options }; }
class MemoryJournal {
  constructor() { this.entries = new Map(); this.order = []; this.sequence = 0; }
  parameterMac(value) { return createHmac('sha256', 'synthetic-test-key').update(JSON.stringify(value)).digest('hex'); }
  async lookup(key, mac) { const row = this.entries.get(JSON.stringify(key)); if (!row) return { state: 'new' }; if (row.mac !== mac) return { state: 'collision' }; return row.receipt ? { state: 'receipt', receipt: structuredClone(row.receipt) } : { state: 'unfinished' }; }
  async admit() { return { accepted: true, reserveBytes: 8192 }; }
  async begin(ctx, summary) { const key = JSON.stringify({ deviceId: ctx.deviceId, runId: ctx.runId, invokeId: ctx.invokeId, actionId: ctx.actionId }); const handle = { id: ctx.actionId }; this.entries.set(key, { mac: summary.parameterMac, handle }); handle.key = key; this.order.push('begin'); return handle; }
  async beforeEffect(handle) { this.order.push('durable-intent'); if (this.markerFailure) throw Object.assign(new Error('synthetic disk full'), { kind: 'storage_unavailable', code: 'storage_unavailable' }); return { id: `attempt:${++this.sequence}`, action: handle }; }
  async endAttempt() { this.order.push('ack'); }
  async end(handle, receipt) { this.order.push('end'); if (this.terminalFailure) throw new Error('synthetic storage error'); receipt.journal = { throughSeq: ++this.sequence, integrity: 'complete' }; this.entries.get(handle.key).receipt = structuredClone(receipt); return receipt; }
}
function fixture(options = {}) {
  const journal = options.journal || new MemoryJournal(); let edits = 0, probes = 0;
  const adapter = options.adapter || {
    preflight: async () => ({ eligible: true, revision, evidence: [], noEffectProven: true }),
    perform: async (op, ctx) => { const h = await ctx.dispatch.beforeEffect({ primitive: 'atspi.SetTextContents', substep: 'editText', target }); journal.order.push('input'); edits++; await ctx.dispatch.afterEffect(h, { state: 'accepted', noEffectProven: false }); return { target, before: revision, dispatch: 'acknowledged', effect: 'unknown', evidence: [], attempts: [], timings: ctx.progress.timings() }; },
    probe: async () => { probes++; return [evidence()]; },
    quiesce: async () => ({ state: 'confirmed', ownedInputReleased: true, reasonCodes: [] }),
  };
  const grant = createPrivateHandle('grant', 'grant-fixture');
  const coordinator = new ExecutionCoordinator({ journal, adapter, authorize: async () => ({ grant, revision }),
    assertions: { validate: async p => ({ predicateId: p.id, status: 'satisfied', producer: 'deterministic', evidenceIds: ['e1'], actionIds: [], reasonCodes: [] }) }, ...options });
  return { coordinator, journal, adapter, get edits() { return edits; }, get probes() { return probes; } };
}
module.exports = { target, revision, session, ref, predicate, evidence, action, invocation, context, MemoryJournal, fixture };
