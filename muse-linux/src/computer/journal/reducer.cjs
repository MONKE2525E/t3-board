'use strict';

const safe = require('./safe.cjs');
const { compactResult, safeCounters } = require('./projection.cjs');

const clone = value => JSON.parse(JSON.stringify(value));
const sameTarget = safe.sameTarget;
function sameRevision(a, b) { return JSON.stringify(safe.revision(a)) === JSON.stringify(safe.revision(b)); }

/** Main-private deterministic completion. Prose and receipt assertions are not authority. */
class RunReducer {
  constructor({ journal, assertionRegistry, evidenceRetentionMs = 7 * 86400000, handoffCapability = 'local_only' } = {}) {
    if (!journal) throw safe.failure('invalid_request');
    this.journal = journal;
    this.registry = assertionRegistry;
    this.evidenceRetentionMs = evidenceRetentionMs;
    this.handoffCapability = ['accepted', 'local_only', 'unavailable'].includes(handoffCapability) ? handoffCapability : 'unavailable';
    this.predicates = new Map();
  }
  async begin({ runId, requirements }, ctx = {}) {
    safe.id(runId);
    if (!Array.isArray(requirements) || requirements.length > 32) throw safe.failure('invalid_request');
    const manifest = [];
    const seen = new Set();
    for (const predicate of requirements) {
      const id = safe.id(predicate.id);
      if (seen.has(id) || !Number.isSafeInteger(predicate.validatorVersion) || predicate.validatorVersion < 1) throw safe.failure('invalid_request');
      seen.add(id);
      manifest.push({ id, validator: safe.id(predicate.validator), validatorVersion: predicate.validatorVersion, target: safe.target(predicate.target), argsMac: await this.journal.parameterMac(predicate.args || {}) });
    }
    await this.journal.registerRun(runId, manifest);
    this.predicates.set(runId, new Map(requirements.map(p => [p.id, clone(p)])));
    await this._update(runId, run => { run.reducer = { execution: 'active', bindings: {}, assertions: {}, evidence: {}, failures: [], modelRequests: [], modelResponses: [] }; }, 'manifest');
    if (ctx.modelRequestId || ctx.modelResponseId) await this.correlateModel(runId, ctx);
    return this.result(runId);
  }
  async _update(runId, work, purpose) {
    return this.journal._serial(async () => {
      const run = this.journal.state.runs[safe.id(runId)];
      if (!run || run.retired || !run.reducer) {
        if (purpose !== 'manifest' || !run || run.retired) throw safe.failure('run_unknown');
      }
      const result = await this.journal._update(state => work(state.runs[runId]), 'reducer_' + purpose);
      const current = this.journal.state.runs[runId];
      const assertions = Object.values(current.reducer.assertions);
      await this.journal._event('run.' + purpose, { runId }, { requirementCount: current.manifest.length, execution: current.reducer.execution, assertionCount: assertions.length, statuses: assertions.map(({ status }) => status) }, 'reducer');
      return result;
    });
  }
  /** Rehydrate exact predicates after restart; their canonical MAC must match the manifest. */
  async restoreManifest(runId, requirements) {
    await this.journal.ready;
    const manifest = this.journal.state.runs[runId]?.manifest;
    if (!manifest || manifest.length !== requirements.length) throw safe.failure('predicate_mismatch');
    for (const predicate of requirements) {
      const declared = manifest.find(p => p.id === predicate.id);
      if (!declared || declared.validator !== predicate.validator || declared.validatorVersion !== predicate.validatorVersion || !sameTarget(declared.target, predicate.target) || !safe.equalMac(declared.argsMac, await this.journal.parameterMac(predicate.args || {}))) throw safe.failure('predicate_mismatch');
    }
    this.predicates.set(runId, new Map(requirements.map(p => [p.id, clone(p)])));
  }
  /** Bind only an existing ledger action. Caller cannot fabricate attempted tracking. */
  async validateRequirementIds(runId, requirementIds) {
    await this.journal.ready;
    return this.journal._serial(() => {
      const run = this.journal.state.runs[safe.id(runId)];
      if (!run || !run.reducer || run.retired) throw safe.failure('run_unknown');
      if (!Array.isArray(requirementIds) || requirementIds.length > 32) throw safe.failure('invalid_request');
      for (const id of requirementIds) if (!run.manifest.some(predicate => predicate.id === safe.id(id))) throw safe.failure('invalid_request');
      return true;
    });
  }
  /** Preserve an authenticated invocation rejection without inventing an input attempt. */
  async recordRejectedInvocation(runId, receipt) {
    const terminal = safe.receipt(receipt);
    if (receipt.dispatch !== 'not_started' || receipt.effect !== 'none_proven' || !Array.isArray(receipt.attempts) || receipt.attempts.length ||
        !receipt.failure || !['rejected', 'failed', 'cancelled'].includes(receipt.execution) || terminal.runId !== runId) throw safe.failure('invalid_request');
    return this._update(runId, run => {
      const invocation = Object.values(this.journal.state.invocations).find(entry => entry.deviceId === this.journal.deviceId &&
        entry.runId === runId && entry.invokeId === terminal.invokeId);
      const durable = invocation?.receipt?.receipt;
      if (!durable || Object.values(this.journal.state.operations).some(entry => entry.runId === runId && entry.actionId === terminal.actionId)) throw safe.failure('invalid_request');
      if (durable.schema === 'muse.action_receipt.v1') {
        if (safe.canonical(safe.receipt(durable)) !== safe.canonical(terminal)) throw safe.failure('invalid_request');
      } else {
        const step = durable.steps?.[terminal.stepIndex];
        if (durable.planId !== terminal.parentActionId || step?.actionId !== terminal.actionId || step.execution !== terminal.execution ||
            step.dispatch !== terminal.dispatch || step.effect !== terminal.effect ||
            safe.canonical(step.failure) !== safe.canonical(terminal.failure)) throw safe.failure('invalid_request');
      }
      if (!run.reducer.failures.some(failure => failure.actionId === terminal.actionId && failure.code === terminal.failure.code)) {
        run.reducer.failures.push({ ...terminal.failure, actionId: terminal.actionId, effect: 'none_proven' });
      }
    }, 'invocation_rejection');
  }
  async recordAction(runId, receipt, requirementIds = []) {
    const terminal = safe.receipt(receipt);
    return this._update(runId, run => {
      const operation = Object.values(this.journal.state.operations).find(op => op.runId === runId && op.actionId === terminal.actionId && op.invokeId === terminal.invokeId);
      if (!operation || terminal.runId !== runId) throw safe.failure('invalid_request');
      for (const id of safe.ids(requirementIds)) {
        if (!run.manifest.some(p => p.id === id)) throw safe.failure('invalid_request');
        const binding = run.reducer.bindings[id] ||= [];
        if (!binding.includes(terminal.actionId)) binding.push(terminal.actionId);
      }
      if (terminal.failure && !run.reducer.failures.some(f => f.actionId === terminal.actionId && f.code === terminal.failure.code)) run.reducer.failures.push({ ...terminal.failure, actionId: terminal.actionId, effect: terminal.effect });
    }, 'action');
  }
  /** Registry calls are read-only. Evidence content is never persisted here. */
  async verify(runId, predicateIds, evidence, ctx) {
    await this.journal.ready;
    if (!this.registry || typeof this.registry.validate !== 'function') throw safe.failure('validator_unavailable');
    const manifest = this.journal.state.runs[runId]?.manifest;
    const known = this.predicates.get(runId);
    if (!known || !manifest) throw safe.failure('manifest_missing');
    if (!Array.isArray(evidence) || evidence.length > 64 || !Array.isArray(predicateIds) || predicateIds.length > 32) throw safe.failure('invalid_request');
    // Input during a validator read must invalidate the answer, too.
    const verificationSeq = this.journal.state.seq;
    const results = [];
    for (const predicateId of predicateIds) {
      const predicate = known.get(predicateId);
      if (!predicate) throw safe.failure('invalid_request');
      ctx?.progress?.check('verification');
      const assertion = safe.assertion(await this.registry.validate(clone(predicate), evidence, ctx));
      if (assertion.predicateId !== predicate.id) throw safe.failure('predicate_mismatch');
      results.push({ predicate, assertion });
    }
    await this._update(runId, run => {
      const now = Date.parse(this.journal.clock.utc());
      for (const item of evidence) {
        const id = safe.id(item.id);
        const eligible = item.acquisition === 'ok' && item.freshness === 'current' && sameRevision(item.revisionBefore, item.revisionAfter) && validRevision(item.revisionAfter) && Number.isFinite(item.interval?.startMonoMs) && Number.isFinite(item.interval?.endMonoMs) && item.interval.endMonoMs >= item.interval.startMonoMs && item.interval.clockDomain === ctx?.budget?.clockDomain;
        const metadata = { id, eligible, target: safe.target(item.target), revision: safe.revision(item.revisionAfter), complete: item.coverage?.complete === true && item.coverage?.truncated === false && !(item.coverage?.omittedFrames?.length) && !(item.coverage?.omissionReasons?.length), retainedUntilMs: run.reducer.evidence[id]?.retainedUntilMs || now + this.evidenceRetentionMs, availability: run.reducer.evidence[id]?.availability || 'retained', contentMac: safe.mac(this.journal.key, clone(item), 1024 * 1024), acquiredThroughSeq: run.reducer.evidence[id]?.acquiredThroughSeq ?? verificationSeq };
        if (item.artifact?.captureId) metadata.captureId = safe.id(item.artifact.captureId);
        // Evidence IDs describe one acquisition, never a replaceable content slot.
        if (run.reducer.evidence[id] && JSON.stringify(run.reducer.evidence[id]) !== JSON.stringify(metadata)) throw safe.failure('invalid_request');
        if (Object.keys(run.reducer.evidence).length >= 512 && !run.reducer.evidence[id]) throw safe.failure('journal_full');
        run.reducer.evidence[id] = metadata;
      }
      for (const { predicate, assertion } of results) {
        const declared = run.manifest.find(p => p.id === predicate.id);
        const eligible = assertion.producer === 'deterministic' && assertion.evidenceIds.length > 0 && assertion.evidenceIds.every(id => {
          const item = run.reducer.evidence[id];
          return item?.eligible && item.availability === 'retained' && sameTarget(item.target, declared.target) && (!assertion.observedRevision || sameRevision(item.revision, assertion.observedRevision));
        });
        const throughSeq = Math.min(verificationSeq, ...assertion.evidenceIds.map(id => run.reducer.evidence[id]?.acquiredThroughSeq ?? 0));
        run.reducer.assertions[predicate.id] = { ...assertion, eligible, validator: declared.validator, validatorVersion: declared.validatorVersion, throughSeq };
      }
    }, 'verification');
    return results.map(r => r.assertion);
  }
  async markEvidence(runId, evidenceId, availability) {
    if (!['expired', 'unavailable', 'redacted', 'withheld_private', 'retained'].includes(availability)) throw safe.failure('invalid_request');
    return this._update(runId, run => {
      const evidence = run.reducer.evidence[safe.id(evidenceId)];
      if (!evidence) throw safe.failure('evidence_unavailable');
      evidence.availability = availability;
    }, 'evidence');
  }
  async setExecution(runId, state) {
    if (!['active', 'paused', 'ended', 'cancelled', 'blocked'].includes(state)) throw safe.failure('invalid_request');
    return this._update(runId, run => {
      if (['cancelled', 'ended', 'blocked'].includes(run.reducer.execution) && state === 'active') throw safe.failure('invalid_request');
      run.reducer.execution = state;
    }, 'lifecycle');
  }
  async correlateModel(runId, { modelRequestId, modelResponseId }) {
    return this._update(runId, run => {
      for (const [key, value] of [['modelRequests', modelRequestId], ['modelResponses', modelResponseId]]) if (value) {
        safe.id(value);
        if (!run.reducer[key].includes(value) && run.reducer[key].length < 128) run.reducer[key].push(value);
      }
    }, 'model_correlation');
  }
  async result(runId) {
    const build = async () => {
      const run = this.journal.state.runs[safe.id(runId)];
      if (!run || !run.reducer || run.retired) throw safe.failure('run_unknown');
      if (!this.journal.poisoned) await this.journal._io(() => this.journal._scan());
      const integrity = this.journal.integrity(runId);
      const operations = Object.values(this.journal.state.operations).filter(op => op.runId === runId);
      const now = Date.parse(this.journal.clock.utc());
      const requirements = run.manifest.map(predicate => {
        const bound = run.reducer.bindings[predicate.id] || [];
        const actionIds = bound.filter(id => operations.some(op => op.actionId === id && op.attempts.length > 0));
        const assertion = run.reducer.assertions[predicate.id];
        const evidenceIds = assertion?.evidenceIds || [];
        const retained = evidenceIds.length > 0 && evidenceIds.every(id => run.reducer.evidence[id]?.availability === 'retained' && run.reducer.evidence[id].retainedUntilMs > now);
        const laterInput = assertion && ((run.reducer.mutationThroughSeq?.[predicate.id] || 0) > assertion.throughSeq || operations.some(op => op.attempts.some(attempt => attempt.intentSeq > assertion.throughSeq && sameTarget(attempt.target, predicate.target))));
        let status = actionIds.length ? 'attempted_unverified' : 'not_attempted';
        if (integrity !== 'complete' || this.journal.status.state !== 'durable') status = 'unknown_history';
        else if (assertion?.eligible && retained && !laterInput && assertion.status === 'satisfied') status = 'verified_present';
        // Negative proof needs exhaustive eligible coverage as well as a deterministic validator.
        else if (assertion?.eligible && retained && !laterInput && assertion.status === 'unsatisfied' && evidenceIds.every(id => run.reducer.evidence[id].complete)) status = 'verified_absent';
        else if (assertion && !retained) status = actionIds.length ? 'attempted_unverified' : 'not_attempted';
        if (run.reducer.execution === 'blocked' && !['verified_present', 'verified_absent', 'unknown_history'].includes(status) && actionIds.length) status = 'blocked';
        return { id: predicate.id, status, assertionIds: assertion ? [predicate.id] : [], actionIds, evidenceIds };
      });
      // Unsatisfied is a verified absence, but does not satisfy a required predicate.
      const complete = requirements.length > 0 && requirements.every(r => r.status === 'verified_present') && integrity === 'complete' && this.journal.status.state === 'durable';
      const unknown = integrity !== 'complete' || this.journal.status.state !== 'durable' || !requirements.length;
      const attempts = operations.flatMap(op => op.attempts);
      const counters = safeCounters({ modelMetricProvenance: run.reducer.modelRequests.length || run.reducer.modelResponses.length ? 'actual_host_ids' : 'unavailable', modelRequests: run.reducer.modelRequests.length || null, modelResponses: run.reducer.modelResponses.length || null, invokes: Object.values(this.journal.state.invocations).filter(i => i.runId === runId).length, logicalActions: operations.length, primitiveAttempts: attempts.length, primitiveDispatches: attempts.some(a => a.dispatch === 'possible') ? null : attempts.filter(a => ['sent', 'acknowledged'].includes(a.dispatch)).length, unknownDispatches: attempts.filter(a => a.dispatch === 'possible').length, captures: new Set(Object.values(run.reducer.evidence).map(e => e.captureId).filter(Boolean)).size, assertionsPassed: requirements.filter(r => r.status === 'verified_present').length });
      const completedPlans = Object.values(this.journal.state.invocations).filter(invocation => invocation.runId === runId && invocation.plan && invocation.receipt?.receipt?.planId)
        .sort((a, b) => a.startedMs - b.startedMs || a.invokeId.localeCompare(b.invokeId));
      const plans = []; let planBytes = 0;
      for (const invocation of completedPlans.slice(-4).reverse()) {
        const saved = invocation.receipt.receipt;
        let summary = { invokeId: invocation.invokeId, planId: saved.planId, execution: saved.execution,
          ...(saved.stopReason ? { stopReason: saved.stopReason } : {}),
          steps: (saved.steps || []).map(step => ({ id: step.id, index: step.index, kind: step.kind, execution: step.execution,
            ...(step.actionId ? { actionId: step.actionId } : {}), ...(step.dispatch ? { dispatch: step.dispatch, effect: step.effect } : {}),
            ...(step.failure ? { failure: clone(step.failure) } : {}) })),
          detail: { command: 'computer.trace.read', runId } };
        const bytes = Buffer.byteLength(JSON.stringify(summary));
        if (planBytes + bytes > 8192) summary = { invokeId: invocation.invokeId, planId: saved.planId, execution: saved.execution,
          ...(saved.stopReason ? { stopReason: saved.stopReason } : {}), detailsOmitted: true, detail: { command: 'computer.trace.read', runId } };
        planBytes += Buffer.byteLength(JSON.stringify(summary)); plans.push(summary);
      }
      return { schema: 'muse.run_result.v1', runId, execution: run.reducer.execution, outcome: complete ? 'verified_complete' : unknown ? 'unknown' : 'incomplete', requirements, journal: { throughSeq: this.journal.state.seq, integrity }, counters, failures: clone(run.reducer.failures), plans, totalPlans: completedPlans.length, handoffCapability: this.handoffCapability };
    };
    await this.journal.ready;
    if (this.journal.poisoned) { await this.journal.queue; return build(); }
    return this.journal._serial(build);
  }
  runResult(runId) { return this.result(runId); }
  async read({ runId, offset = 0, limit = 8, maxBytes = 8192 }) {
    const result = await this.result(runId);
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1) throw safe.failure('invalid_request');
    const page = { ...result, requirements: result.requirements.slice(offset, offset + Math.min(32, limit)), totalRequirements: result.requirements.length, offset };
    if (offset + page.requirements.length < result.requirements.length) page.nextOffset = offset + page.requirements.length;
    return compactResult(page, { maxBytes });
  }
  async readEvidence({ runId, evidenceId }) {
    await this.journal.ready;
    const item = this.journal.state.runs[safe.id(runId)]?.reducer?.evidence[safe.id(evidenceId)];
    if (!item) return { id: evidenceId, availability: 'unavailable', representation: 'metadata_only' };
    return { ...clone(item), availability: item.retainedUntilMs <= Date.parse(this.journal.clock.utc()) ? 'expired' : item.availability, representation: 'metadata_only', rawContentAvailability: 'unavailable' };
  }
}
function validRevision(revision) {
  return revision && ['sessionGeneration', 'grantGeneration', 'targetGeneration', 'semanticRevision', 'geometryRevision'].every(key => Number.isSafeInteger(revision[key]) && revision[key] >= 0);
}
module.exports = { RunReducer };
