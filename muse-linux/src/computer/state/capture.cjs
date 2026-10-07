const { performance } = require('node:perf_hooks');
const { SOURCES, clone, id, fail, assertTarget, assertRevision, assertEvidence, sameTarget, changedFences, boundedRead } = require('./evidence.cjs');

class CaptureCoordinator {
  constructor({ providers = {}, readFence, now = () => performance.now(), clockDomain, utc = () => new Date().toISOString(), makeId = id, maxTargets = 128 } = {}) {
    if (typeof readFence !== 'function' || !clockDomain || !Number.isInteger(maxTargets) || maxTargets < 1 || maxTargets > 1024) throw fail('capture_configuration_required', 'invalid_request');
    this.providers = providers; this.readFence = readFence; this.now = now;
    this.clockDomain = clockDomain; this.utc = utc; this.makeId = makeId;
    this.maxTargets = maxTargets; this.lastPixels = new Map();
  }

  async capture(target, sources, ctx) {
    assertTarget(target); assertRevision(ctx.revision);
    if (ctx.sessionId !== target.sessionId || ctx.budget.clockDomain !== this.clockDomain) throw fail('capture_context_mismatch', 'invalid_request');
    if (!Array.isArray(sources) || sources.length > SOURCES.length || sources.some(source => !SOURCES.includes(source)) || new Set(sources).size !== sources.length) throw fail('invalid_capture_sources', 'invalid_request');
    // Every source has its own interval/fences. A failed source does not erase its peers.
    const settled = await Promise.allSettled(sources.map(source => this.captureSource(target, source, ctx)));
    return settled.map((result, index) => result.status === 'fulfilled' ? result.value : this.failed(target, sources[index], ctx, result.reason));
  }

  async captureSource(target, source, ctx) {
    let before, start = this.now();
    try {
      return await boundedRead(async child => {
        before = clone(await this.readFence(target, child));
        assertTarget(before.target); assertRevision(before.revision);
        if (!sameTarget(target, before.target)) throw fail('target_mismatch');
        const provider = this.providers[source];
        if (!provider) return this.failed(target, source, ctx, fail('source_unsupported', 'backend_unavailable'), start, before, 'unsupported');
        const raw = await (typeof provider === 'function' ? provider(target, child) : provider.capture(target, child));
        const after = clone(await this.readFence(target, child));
        assertTarget(after.target); assertRevision(after.revision);
        const end = this.now();
        if (!raw || raw.source && raw.source !== source || raw.target && !sameTarget(raw.target, target)) throw fail('provider_target_mismatch');
        const full = raw.id && raw.revisionBefore && raw.interval;
        if (full) assertEvidence(raw);
        const evidence = {
          id: full ? raw.id : this.makeId('evidence'), source,
          producer: raw.producer || `capture.${source}`, target: clone(target),
          revisionBefore: clone(raw.revisionBefore || before.revision), revisionAfter: clone(raw.revisionAfter || after.revision),
          interval: full ? clone(raw.interval) : { startMonoMs: start, endMonoMs: end, clockDomain: this.clockDomain, utc: this.utc() },
          acquisition: raw.acquisition || 'ok', freshness: raw.freshness || 'unknown', reasons: [...(raw.reasons || [])],
          coverage: clone(raw.coverage || { scope: 'unknown', complete: false, truncated: false, omittedFrames: [], omissionReasons: ['coverage_unavailable'] }),
          facts: clone(raw.facts || []), derivedFrom: [...(raw.derivedFrom || [])],
          ...(raw.artifact ? { artifact: clone(raw.artifact) } : {}),
        };
        const crossing = [...changedFences(before.revision, after.revision, source), ...changedFences(evidence.revisionBefore, evidence.revisionAfter, source)];
        const outside = changedFences(evidence.revisionAfter, after.revision, source);
        if (!sameTarget(target, after.target) || crossing.length || outside.length || evidence.interval.clockDomain !== this.clockDomain || evidence.interval.startMonoMs < start || evidence.interval.endMonoMs > end || evidence.interval.endMonoMs < evidence.interval.startMonoMs) {
          evidence.freshness = 'stale';
          evidence.reasons.push(...crossing.map(key => `crossed_${key}`), ...outside.map(key => `old_${key}`));
          if (!sameTarget(target, after.target)) evidence.reasons.push('target_mismatch');
          if (evidence.interval.clockDomain !== this.clockDomain) evidence.reasons.push('clock_domain_mismatch');
          if (evidence.interval.startMonoMs < start || evidence.interval.endMonoMs > end || evidence.interval.endMonoMs < evidence.interval.startMonoMs) evidence.reasons.push('provider_interval_outside_acquisition');
        }
        for (const fact of evidence.facts) if (!fact.evidenceIds.length) fact.evidenceIds = [evidence.id];
        if (source === 'pixels' && evidence.acquisition === 'ok' && evidence.artifact) {
          // A byte/blob cache never supplies capture identity or currentness.
          evidence.artifact.captureId = this.makeId('capture');
          if (evidence.freshness === 'current') {
            const key = JSON.stringify(target);
            this.lastPixels.delete(key); this.lastPixels.set(key, clone(evidence.artifact));
            while (this.lastPixels.size > this.maxTargets) this.lastPixels.delete(this.lastPixels.keys().next().value);
          }
        }
        return assertEvidence(evidence);
      }, ctx, { now: this.now, maxMs: 2000, phase: `capture_${source}` });
    } catch (error) { return this.failed(target, source, ctx, error, start, before); }
  }

  failed(target, source, ctx, error, start = this.now(), before, acquisition) {
    const previous = source === 'pixels' ? this.lastPixels.get(JSON.stringify(target)) : undefined;
    const code = ['target_mismatch', 'provider_target_mismatch', 'clock_domain_mismatch'].includes(error?.code) ? error.code : error?.kind === 'cancelled' ? 'capture_cancelled' : error?.kind === 'deadline' ? 'capture_timeout' : 'capture_failed';
    return { id: this.makeId('evidence'), source, producer: `capture.${source}`, target: clone(target),
      revisionBefore: clone(before?.revision || ctx.revision), revisionAfter: clone(before?.revision || ctx.revision),
      interval: { startMonoMs: start, endMonoMs: this.now(), clockDomain: this.clockDomain, utc: this.utc() },
      acquisition: acquisition || (error?.kind === 'deadline' ? 'timeout' : 'error'), freshness: previous ? 'stale' : 'unknown', reasons: [code, ...(previous ? ['prior_capture_stale'] : [])],
      coverage: { scope: 'unknown', complete: false, truncated: false, omittedFrames: [], omissionReasons: [code] }, facts: [], derivedFrom: [],
      ...(previous ? { artifact: clone(previous) } : {}) };
  }

  async probe(target, sources, ctx) {
    return boundedRead(child => this.capture(target, sources, child), ctx, { now: this.now, maxMs: 750, phase: 'state_probe' });
  }
}

module.exports = { CaptureCoordinator };
