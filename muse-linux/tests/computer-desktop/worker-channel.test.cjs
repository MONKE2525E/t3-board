'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const { once } = require('node:events');
const { WorkerChannel, MAX_FRAME } = require('../../src/computer/desktop/worker-channel.cjs');
const { boundary } = require('../../src/computer/desktop/common.cjs');
const { context, target, session, frame, Pipe } = require('./helpers.cjs');
async function start(pipe, options) { const channel = new WorkerChannel(options); await channel.start(session(async () => pipe), context()); return channel; }
test('fragmented/coalesced frames keep invalidations separate from exact response', async () => {
  const pipe = new Pipe((request, p) => {
    const data = Buffer.concat([frame({ schema: request.schema, generation: request.generation, sessionId: request.sessionId, event: 'invalidation', reason: 'semantic_dirty' }),
      frame({ schema: request.schema, generation: request.generation, sessionId: request.sessionId, requestId: request.requestId, ok: true, result: { ready: 'result' } })]);
    p.deliver(data.subarray(0, 2)); p.deliver(data.subarray(2, 17)); p.deliver(data.subarray(17));
  });
  const channel = await start(pipe), events = []; channel.subscribe(event => events.push(event));
  assert.deepEqual(await channel.request('resolve', { handle: 'opaque' }, context()), { ready: 'result' });
  assert.equal(events.length, 1); assert.equal(channel.buffer.length, 0); await channel.stop(); assert.equal(pipe.stops, 1);
});
test('only explicit buses and owned runner can start a worker', async () => {
  let calls = 0; const owned = session(async () => { calls++; }); delete owned.buses.accessibilityAddress;
  await assert.rejects(new WorkerChannel().start(owned, context()), { code: 'accessibility_bus_unavailable' }); assert.equal(calls, 0);
  const expired = context(); expired.controller.abort(); await assert.rejects(new WorkerChannel().start(session(async () => { calls++; }), expired), { code: 'cancelled' }); assert.equal(calls, 0);
});
test('invalid size, JSON, scope, unknown request and malformed success poison and stop exactly once', async t => {
  for (const [code, respond] of [
    ['worker_frame_invalid', (_r, p) => { const h = Buffer.alloc(4); h.writeUInt32BE(MAX_FRAME + 1); p.deliver(h); }],
    ['worker_json_invalid', (_r, p) => p.deliver(Buffer.from([0, 0, 0, 2, 123, 123]))],
    ['worker_json_invalid', (r, p) => { const data = frame({ schema: r.schema, generation: r.generation, sessionId: r.sessionId,
      requestId: r.requestId, ok: true, result: { text: 'valid-text' } }); data[data.indexOf('valid-text')] = 0xff; p.deliver(data); }],
    ['worker_scope_invalid', (r, p) => p.reply(r, {}, { sessionId: 'another-session' })],
    ['worker_scope_invalid', (r, p) => p.reply(r, {}, { generation: r.generation + 1 })],
    ['worker_response_unknown', (r, p) => p.reply(r, {}, { requestId: 'other-request' })],
    ['worker_response_invalid', (r, p) => p.reply(r, {}, { ok: undefined })],
  ]) await t.test(code, async () => {
    const pipe = new Pipe(respond), channel = await start(pipe); channel.subscribe(() => { throw Error('listener'); });
    await assert.rejects(channel.request('resolve', {}, context()), { code });
    await assert.rejects(channel.request('resolve', {}, context()), { code: 'worker_unavailable' });
    await channel.stop(); assert.equal(pipe.stops, 1); assert.equal(pipe.requests.length, 2); assert.equal(channel.pending.size, 0);
  });
});
test('typed attempted provider rejection survives transport without reconnect or replay', async () => {
  const pipe = new Pipe((r, p) => p.reply(r, undefined, { ok: false, code: 'semantic_rejected', attempted: true, effect: 'unknown' }));
  const channel = await start(pipe);
  await assert.rejects(channel.request('invoke', {}, context()), error => error.code === 'semantic_rejected' && error.attempted === true && error.effect === 'unknown');
  assert.equal(channel.closed, false); assert.equal(pipe.requests.filter(r => r.operation === 'invoke').length, 1); await channel.stop();
});
test('synchronous write failure cleans pending request and preserves uncertain dispatch', async () => {
  const pipe = new Pipe(() => { throw Error('broken pipe'); }), channel = await start(pipe), ctx = context();
  await assert.rejects(boundary(ctx, 'atspi.invoke', target, () => channel.request('invoke', {}, ctx)), error => error.attempted && error.effect === 'unknown');
  assert.equal(ctx.attempts[0].ack.state, 'lost'); assert.equal(channel.pending.size, 0); await channel.stop(); assert.equal(pipe.stops, 1);
});
test('bounded queue, pre-dispatch queued cancellation, and worker generation fence', async () => {
  let active; const pipe = new Pipe(r => { active = r; }), channel = await start(pipe, { maxQueued: 2 });
  const first = channel.request('resolve', {}, context()), cancelled = context();
  const second = channel.request('invoke', {}, cancelled); second.catch(() => {}); cancelled.controller.abort();
  await assert.rejects(channel.request('invoke', {}, context()), { code: 'worker_queue_full' });
  await new Promise(resolve => setImmediate(resolve)); pipe.reply(active);
  await first; await assert.rejects(second, { code: 'cancelled' });
  assert.equal(pipe.requests.length, 2); await channel.stop();
  const next = new Pipe((r, p) => p.reply(r, { replacement: true })); await channel.start(session(async () => next), context());
  pipe.deliver(frame({ schema: 'muse.atspi.v1', sessionId: 'test-session', generation: 1, event: 'invalidation' }));
  assert.deepEqual(await channel.request('resolve', {}, context()), { replacement: true }); assert.equal(channel.generation, 2); await channel.stop();
});
test('deadline terminates a hung worker and prevents a queued follow-on input', async () => {
  const pipe = new Pipe(), channel = await start(pipe);
  const hung = channel.request('invoke', {}, context(25)); const queued = channel.request('invoke', {}, context()); queued.catch(() => {});
  await assert.rejects(hung, { code: 'deadline' }); await assert.rejects(queued, { code: 'worker_unavailable' });
  await channel.stop(); assert.equal(pipe.requests.length, 2); assert.equal(pipe.stops, 1);
});
test('unconfirmed owned termination stays unknown in Stop receipt', async () => {
  const pipe = new Pipe(); pipe.quiescence = { state: 'unknown', ownedInputReleased: false, reasonCodes: ['owned_group_unconfirmed'] };
  const channel = await start(pipe), result = await channel.stop(); assert.equal(result.stopped, false); assert.equal(result.quiescence.state, 'unknown');
});
test('Stop after dispatch kills only the owned subprocess and records lost acknowledgement', { timeout: 5000 }, async () => {
  const source = `let input=Buffer.alloc(0);process.stdin.on('data',d=>{input=Buffer.concat([input,d]);while(input.length>=4){const n=input.readUInt32BE(0);if(input.length<n+4)return;const r=JSON.parse(input.subarray(4,n+4));input=input.subarray(n+4);if(r.operation==='hello'){const b=Buffer.from(JSON.stringify({...r,ok:true,result:{ready:true}}));const h=Buffer.alloc(4);h.writeUInt32BE(b.length);process.stdout.write(Buffer.concat([h,b]));}else process.stdout.write(Buffer.alloc(0));}});`;
  const child = cp.spawn(process.execPath, ['-e', source], { env: { PATH: '/usr/bin:/bin' }, stdio: ['pipe', 'pipe', 'pipe'] });
  const exit = once(child, 'exit'); child.terminate = async () => { child.kill('SIGTERM'); await exit; };
  const channel = new WorkerChannel(); const ctx = context();
  try {
    await channel.start(session(async () => child), ctx);
    const input = boundary(ctx, 'atspi.invoke', target, () => channel.request('invoke', {}, ctx)); input.catch(() => {});
    await new Promise(resolve => setImmediate(resolve)); ctx.controller.abort();
    await assert.rejects(input, error => error.code === 'cancelled' && error.attempted && error.effect === 'unknown');
    const stopped = await channel.stop(); assert.equal(stopped.stopped, true); assert.equal(child.signalCode, 'SIGTERM');
    assert.equal(ctx.attempts.length, 1); assert.equal(ctx.attempts[0].ack.state, 'lost');
  } finally { await channel.stop(); }
});
