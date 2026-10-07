const test = require('node:test');
const assert = require('node:assert/strict');
const { parseActions, runBatch } = require('../src/action-batch.cjs');

test('batch parses string-wire actions and refuses target overrides or unbounded work', () => {
  assert.deepEqual(parseActions('[{"action":"key","key":"Ctrl+A"}]'), [{ action: 'key', key: 'Ctrl+A' }]);
  for (const value of ['invalid', [], Array(17).fill({ action: 'key' }), [{ action: 'open_app' }], [{ action: 'click', window_id: 'other' }]]) {
    assert.throws(() => parseActions(value), /invalid_/);
  }
});

test('batch performs a whole sequence with one final observation and no intermediate wire results', async () => {
  const calls = [];
  let observations = 0;
  const backend = {
    observation: { id: 'fresh', window_id: 'selected' },
    async control(args, options) { calls.push({ args, options }); return { dispatched: true }; },
    async observe(args) { observations++; assert.equal(args.window_id, 'selected'); return { observation_id: 'after' }; },
  };
  const result = await runBatch(backend, { observation_id: 'fresh', actions: JSON.stringify([{ action: 'click', coordinate: [100, 200] }, { action: 'type', text: 'A whole sentence' }, { action: 'key', key: 'Enter' }]) });
  assert.equal(result.completed, 3);
  assert.equal(result.stopped, false);
  assert.equal(observations, 1);
  assert.equal(result.observation.observation_id, 'after');
  assert.equal(result.task_success, false);
  assert.ok(calls.every(c => c.args.window_id === 'selected' && c.args.observation_id === 'fresh' && c.options.deferObservation));
});

test('batch reports partial progress, does not replay input and never executes later actions after a failure', async () => {
  let calls = 0;
  const backend = {
    observation: { id: 'fresh', window_id: 'selected' },
    async control() { if (++calls === 2) throw Error('window_obscured'); return { dispatched: true }; },
    async observe() { return { observation_id: 'after' }; },
  };
  const result = await runBatch(backend, { observation_id: 'fresh', actions: [{ action: 'click' }, { action: 'type', text: 'text' }, { action: 'key' }] });
  assert.equal(calls, 2);
  assert.equal(result.completed, 1);
  assert.equal(result.attempted, 2);
  assert.equal(result.error, 'window_obscured');
  assert.equal(result.retryable, false);
});

test('batch refuses stale observations before executing and reports Stop when follow-up evidence is unavailable', async () => {
  const backend = {
    observation: { id: 'fresh' },
    async control() { throw Error('session_required_or_stopped'); },
    async observe() { throw Error('session_required_or_stopped'); },
  };
  await assert.rejects(runBatch(backend, { observation_id: 'old', actions: [{ action: 'key' }] }), /stale_observation/);
  const result = await runBatch(backend, { observation_id: 'fresh', actions: [{ action: 'key' }] });
  assert.equal(result.completed, 0);
  assert.equal(result.error, 'session_required_or_stopped');
  assert.equal(result.observation_error, 'session_required_or_stopped');
});
