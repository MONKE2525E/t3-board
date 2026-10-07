'use strict';

const C = require('./contracts.cjs');
const { classifyFailure } = require('./recovery.cjs');
function clipUtf8(text, bytes) {
  let value = String(text).slice(0, bytes);
  while (Buffer.byteLength(value) > bytes) value = value.slice(0, -1);
  if (/[\uD800-\uDBFF]$/.test(value)) value = value.slice(0, -1);
  return value;
}
const MAX_BYTES = 16 * 1024;
const SOURCES = new Set(['dom', 'atspi', 'window', 'lifecycle', 'browser_ax', 'pixels']);
const FIELDS = ['observation_id', 'window_id', 'run_id', 'title', 'url', 'route', 'accessibility_status',
  'accessibility_error', 'capture_status', 'image_current', 'pending_navigation', 'required_next'];

function safeObservation(input) {
  if (!input || typeof input !== 'object') return null;
  const out = {};
  for (const key of FIELDS) {
    const value = input[key];
    if (typeof value === 'boolean') out[key] = value;
    else if (typeof value === 'string') out[key] = clipUtf8(value, 512);
  }
  if (out.url) {
    try { const url = new URL(out.url); url.username = ''; url.password = ''; url.search = ''; url.hash = ''; out.url = url.href; }
    catch { delete out.url; }
  }
  if (input.revision) { C.validateRevision(input.revision); out.revision = structuredClone(input.revision); }
  out.controls = (Array.isArray(input.controls) ? input.controls : []).slice(0, 32).map(control => {
    const projected = {};
    for (const key of ['ref_id', 'role', 'label']) if (typeof control[key] === 'string') projected[key] = clipUtf8(control[key], key === 'label' ? 120 : 128);
    if (Number.isSafeInteger(control.element_number)) projected.element_number = control.element_number;
    if (Array.isArray(control.capabilities)) projected.capabilities = control.capabilities.filter(c => typeof c === 'string').slice(0, 8).map(c => clipUtf8(c, 40));
    return projected;
  });
  out.controls_truncated = (input.controls?.length || 0) > 32 || input.truncated === true || input.more === true;
  if (Array.isArray(input.state_conflicts) && input.state_conflicts.length) out.reported_state_conflicts = input.state_conflicts.length;
  return out;
}

function reconcileDiagnosticSources(entries, { target, revision, clock }) {
  C.validateTargetRef(target); C.validateRevision(revision);
  if (!Array.isArray(entries) || entries.length > 96) throw new C.ContractError('invalid_diagnosis_evidence');
  const now = clock.now();
  const summaries = [], comparable = new Map(), conflicts = [];
  for (const e of entries) {
    C.validateEvidence(e);
    const acquired = e.acquisition === 'ok';
    const sameScope = C.sameTarget(e.target, target) && C.sameRevision(e.revisionAfter, revision);
    const stable = C.sameRevision(e.revisionBefore, e.revisionAfter);
    const current = acquired && sameScope && stable && e.facts.length > 0 && e.freshness === 'current' && e.interval.clockDomain === clock.domain
      && e.interval.endMonoMs <= now && now - e.interval.endMonoMs <= 1500;
    const status = !acquired ? 'unavailable' : !sameScope || !stable || e.freshness === 'stale' ? 'stale' : current ? 'current' : 'unconfirmed';
    summaries.push({ evidence_id: e.id, source: e.source, status, acquisition: e.acquisition,
      interval: { ...e.interval }, coverage: { scope: e.coverage.scope, complete: e.coverage.complete, truncated: e.coverage.truncated },
      fact_count: e.facts.length });
    if (!current) continue;
    for (const fact of e.facts) {
      if (!fact.evidenceIds.includes(e.id) || !['document.url', 'document.urlDigest', 'window.closed', 'dialog.state'].includes(fact.predicate)) continue;
      const identity = fact.predicate === 'dialog.state' ? fact.value?.dialogId : fact.predicate === 'window.closed' ? fact.value?.targetId : undefined;
      const key = identity === undefined ? fact.predicate : `${fact.predicate}:${identity}`;
      const serialized = C.canonicalJson(fact.value), prior = comparable.get(key);
      if (prior && prior.serialized !== serialized && conflicts.length < 64) conflicts.push({ predicate: fact.predicate, evidence_ids: [prior.id, e.id], sources: [prior.source, e.source], resolution: 'unresolved' });
      else comparable.set(key, { id: e.id, source: e.source, serialized });
    }
  }
  const current = summaries.filter(s => s.status === 'current');
  const staleAX = summaries.some(s => ['atspi', 'browser_ax'].includes(s.source) && ['stale', 'unavailable'].includes(s.status));
  const browserCurrent = current.some(s => ['dom', 'lifecycle'].includes(s.source));
  return { sources: summaries, conflicts, stale_accessibility: staleAX,
    state: conflicts.length ? 'contradictory' : current.length ? 'current_sources_available' : 'unconfirmed',
    next_route: conflicts.length ? 'refresh_authoritative_source' : browserCurrent ? 'direct_browser' : current.some(s => s.source === 'atspi') ? 'semantic_accessibility' : staleAX ? 'connect_selected_browser_or_request_visual_evidence' : 'refresh_selected_target',
    guidance: staleAX ? 'An unavailable or stale accessibility tree does not establish that a page failed to load. Prefer current selected-tab DOM/CDP state; request visual evidence if semantic sources remain unavailable.' : 'Use current target evidence before another action. A refresh confirms state, not action or task success.' };
}

function bounded(result) {
  while (Buffer.byteLength(JSON.stringify(result)) > MAX_BYTES && result.probes.some(p => p.observation?.controls?.length)) {
    for (const probe of result.probes) if (probe.observation?.controls?.length) { probe.observation.controls.pop(); probe.observation.controls_truncated = true; }
    result.truncated = true;
  }
  while (Buffer.byteLength(JSON.stringify(result)) > MAX_BYTES && result.reconciliation.sources.length) { result.reconciliation.sources.pop(); result.truncated = true; }
  if (Buffer.byteLength(JSON.stringify(result)) > MAX_BYTES) {
    result.probes = result.probes.map(({ source, status, latency_ms, error }) => ({ source, status, latency_ms, ...(error ? { error } : {}) }));
    result.reconciliation.conflicts = []; result.truncated = true;
  }
  return result;
}

async function diagnoseComputer({ runId, target, ctx, detector, probes, assertCurrent }) {
  C.id(runId); C.validateTargetRef(target); C.validateRevision(ctx.revision);
  if (!Array.isArray(probes) || probes.length < 1 || probes.length > 3 || probes.some(p => !SOURCES.has(p.source) || typeof p.read !== 'function') || typeof assertCurrent !== 'function') throw new C.ContractError('invalid_diagnosis_probe');
  const gate = detector.status(runId);
  const selected = gate ? probes : probes.slice(0, 1);
  const progress = ctx.progress.child(5000), started = progress.clock.now(), evidence = [];
  const readOnly = { ...ctx, progress, budget: progress.budget, signal: progress.signal,
    dispatch: { beforeEffect: async () => { throw new C.ContractError('diagnosis_read_only'); } } };
  assertCurrent();
  const reads = selected.map(probe => async probeCtx => {
    assertCurrent();
    const start = progress.clock.now();
    let output;
    try {
      const raw = await progress.phase('diagnosis_refresh', () => probe.read(probeCtx));
      assertCurrent();
      if (raw.target && !C.sameTarget(raw.target, target)) throw new C.ContractError('stale_target');
      const entries = raw.evidence || [];
      if (!Array.isArray(entries) || entries.length > 32) throw new C.ContractError('invalid_diagnosis_evidence');
      entries.forEach(C.validateEvidence);
      evidence.push(...entries);
      output = { source: probe.source, status: 'refreshed', observation: safeObservation(raw.observation), evidence_ids: entries.map(e => e.id) };
    } catch (error) {
      assertCurrent();
      output = { source: probe.source, status: 'failed', error: classifyFailure(error, { phase: 'probe' }) };
    }
    assertCurrent();
    return { ...output, latency_ms: Math.max(0, progress.clock.now() - start) };
  });
  let results;
  try {
    if (gate) results = (await detector.diagnose(runId, reads, readOnly)).results;
    else results = [await reads[0](readOnly)];
  } catch (error) {
    assertCurrent();
    if (error.code === 'diagnosis_probe_limit') throw error;
    results = [{ source: selected[0].source, status: 'failed', error: classifyFailure(error, { phase: 'probe' }), latency_ms: Math.max(0, progress.clock.now() - started) }];
  }
  assertCurrent();
  const latestRevision = results.findLast(p => p.observation?.revision)?.observation.revision || ctx.revision;
  const reconciliation = reconcileDiagnosticSources(evidence, { target, revision: latestRevision, clock: progress.clock });
  return bounded({ run_id: runId, target: { session_id: target.sessionId, kind: target.kind, target_id: target.targetId, generation: target.generation },
    read_only: true, task_success: false, recovery_approved: false,
    gate: gate ? { code: gate.code, reason: gate.reason, blocked: gate.blocked, probes_used: detector.status(runId)?.probes || 0 } : null,
    probes: results, reconciliation, latency_ms: Math.max(0, progress.clock.now() - started), truncated: false });
}
module.exports = { diagnoseComputer, reconcileDiagnosticSources, MAX_BYTES };
