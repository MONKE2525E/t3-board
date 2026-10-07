const { performance } = require('node:perf_hooks');
const { randomUUID } = require('node:crypto');
const target = { sessionId: 'state-fixture', kind: 'tab', targetId: 'tab-1', generation: 1, ownership: 'owned', browserInstance: 'fixture-browser', connectionEpoch: 1 };
const revision = { sessionGeneration: 1, grantGeneration: 1, connectionEpoch: 1, targetGeneration: 1, documentEpoch: 1, semanticRevision: 1, geometryRevision: 1 };
function evidence(source, facts = [], overrides = {}) {
  const id = randomUUID();
  return { id, source, producer: `fixture.${source}`, target: structuredClone(target), revisionBefore: { ...revision }, revisionAfter: { ...revision },
    interval: { startMonoMs: performance.now() - 1, endMonoMs: performance.now(), clockDomain: 'node.performance', utc: new Date().toISOString() },
    acquisition: 'ok', freshness: 'current', reasons: [],
    coverage: { scope: 'target', complete: true, truncated: false, omittedFrames: [], omissionReasons: [] },
    facts: facts.map(f => ({ predicate: f[0], value: f[1], suitability: f[2] || 'deterministic', evidenceIds: [id] })), derivedFrom: [], ...overrides };
}
function predicate(validator = 'navigation.destination', args = { url: 'https://fixture.invalid/orders', heading: 'Your Orders' }, selected = target) {
  return { id: randomUUID(), validator, validatorVersion: 1, target: structuredClone(selected), args };
}
function context(rev = revision, duration = 2000) {
  return { runId: 'run-state', invokeId: randomUUID(), sessionId: target.sessionId, revision: { ...rev },
    budget: { clockDomain: 'node.performance', deadlineMonoMs: performance.now() + duration }, signal: new AbortController().signal };
}
function current(selected = target, rev = revision) {
  return { target: structuredClone(selected), revision: { ...rev }, clockDomain: 'node.performance' };
}
function element(selected = target, rev = revision, objectToken = 'node-1') {
  return { id: 'provider-ref', refSetId: 'provider-set', target: structuredClone(selected), revision: { ...rev }, source: 'dom',
    frame: { tab: structuredClone(selected), frameId: 'frame-1', frameGeneration: 1, documentToken: 'document-1', executionContextId: 'context-1', cdpSessionId: 'cdp-1' },
    browser: { backendNodeId: 1, objectToken }, identity: { role: 'button', semanticFingerprint: objectToken }, capabilities: ['click'] };
}
function transform(e, selected = e.target) {
  return { id: e.artifact.transformId, captureId: e.artifact.captureId, target: structuredClone(selected), revision: { ...e.revisionAfter },
    provenance: 'visible_window', calibrated: true, singleOutput: true, occlusionChecked: true, occluded: false,
    captureSize: { width: 250, height: 125 }, logicalBounds: { x: 10, y: 20, width: 200, height: 100 },
    output: { origin: [1000, 0], scale: 1.25, rotation: 0 }, crop: { x: 0, y: 0, width: 250, height: 125 },
    decoration: { left: 0, right: 0, top: 0, bottom: 0 }, scroll: [0, 0], frame: { kind: 'window', offset: [0, 0], scale: [1, 1] } };
}
module.exports = { target, revision, evidence, predicate, context, current, element, transform };
