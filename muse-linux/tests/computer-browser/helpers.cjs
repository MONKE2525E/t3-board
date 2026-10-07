'use strict';
const { performance } = require('node:perf_hooks');
function context({ sessionId = 'fixture-session', deadlineMs = 15000, actionId = 'action', invokeId = actionId, runId = 'fixture-run', signal = new AbortController().signal } = {}) {
  const records = [];
  return { sessionId, runId, invokeId, actionId, grant: Object.freeze({ id: 'fixture-grant', kind: 'grant' }), signal,
    revision: { sessionGeneration: 1, grantGeneration: 1, targetGeneration: 1, semanticRevision: 0, geometryRevision: 0 },
    budget: { clockDomain: 'node.performance', deadlineMonoMs: performance.now() + deadlineMs },
    records, dispatch: { async beforeEffect(req) { const handle = { id: `attempt-${records.length + 1}`, kind: 'attempt' }; records.push({ handle, req }); return handle; }, async afterEffect(handle, ack) { records.find(r => r.handle === handle).ack = ack; } } };
}
const policy = { authorize: async () => true, allowNavigation: async () => false };
const edit = text => ({ mode: 'replace', text, semantics: 'plain_text', newlinePolicy: 'literal_multiline', clipboard: 'forbid' });
function find(observation, name, role) {
  const items = observation.state.evidence[0].facts.find(f => f.predicate === 'elements').value;
  const matches = items.filter(e => e.name === name && (!role || e.role === role));
  if (matches.length !== 1) throw new Error(`Fixture expected one ${role || ''} ${name}, got ${matches.length}`);
  return observation.refs.elements.find(r => r.id === matches[0].refId);
}
module.exports = { context, policy, edit, find };
