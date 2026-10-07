'use strict';
const { performance } = require('node:perf_hooks');
const { EventEmitter } = require('node:events');
const { DesktopError } = require('../../src/computer/desktop/common.cjs');
function context(ms = 2000) {
  const controller = new AbortController(), deadlineMonoMs = performance.now() + ms, attempts = [];
  return { controller, signal: controller.signal, attempts, runId: 'test-run', invokeId: 'test-invoke', actionId: 'test-action', sessionId: 'test-session',
    budget: { deadlineMonoMs, clockDomain: 'node.performance' },
    revision: { sessionGeneration: 1, grantGeneration: 1, targetGeneration: 1, semanticRevision: 1, geometryRevision: 1 },
    progress: { remainingMs: () => deadlineMonoMs - performance.now(), check() {
      if (controller.signal.aborted) throw new DesktopError('cancelled');
      if (performance.now() >= deadlineMonoMs) throw new DesktopError('deadline');
    } }, dispatch: { async beforeEffect(event) { const attempt = { ...event }; attempts.push(attempt); return attempt; },
      async afterEffect(attempt, ack) { attempt.ack = ack; } } };
}
const target = { sessionId: 'test-session', kind: 'window', targetId: 'test-window', generation: 1, ownership: 'owned', process: { pid: 123, startToken: '321' } };
function session(spawn) { return { id: 'test-session', mode: 'isolated_desktop', ownership: 'owned', state: 'ready', generation: 1,
  buses: { sessionAddress: 'unix:path=/owned/session', accessibilityAddress: 'unix:path=/owned/atspi' }, runner: { spawn } }; }
function frame(value) { const bytes = Buffer.from(JSON.stringify(value)), header = Buffer.alloc(4); header.writeUInt32BE(bytes.length); return Buffer.concat([header, bytes]); }
class Pipe extends EventEmitter {
  constructor(handler) { super(); this.handler = handler; this.requests = []; this.stops = 0; this.listenersForData = new Set(); }
  subscribe(listener) { this.listenersForData.add(listener); return () => this.listenersForData.delete(listener); }
  deliver(data) { for (const listener of this.listenersForData) listener(data); }
  reply(request, result = {}, overrides = {}) { this.deliver(frame({ schema: request.schema, generation: request.generation, sessionId: request.sessionId,
    requestId: request.requestId, ok: true, result, ...overrides })); }
  write(bytes) { const request = JSON.parse(bytes.subarray(4).toString()); this.requests.push(request);
    if (request.operation === 'hello') this.reply(request, { ready: true }); else return this.handler?.(request, this); }
  async stop() { this.stops++; return this.quiescence || { state: 'confirmed', ownedInputReleased: true, reasonCodes: [] }; }
}
module.exports = { context, target, session, frame, Pipe };
