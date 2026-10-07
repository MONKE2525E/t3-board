'use strict';
const { ReceiptJournal, RunReducer } = require('../../src/computer/journal/index.cjs');
const { ExecutionCoordinator } = require('../../src/computer/executor.cjs');
const { createPrivateHandle } = require('../../src/computer/contracts.cjs');
const { defaultClock } = require('../../src/computer/progress.cjs');
const { action, invocation, target, revision, session, predicate } = require('./helpers.cjs');

// Only the owned test parent supplies the service endpoint and temporary token.
process.once('message', async ({ directory, endpoint, token, text }) => {
  try {
    const journal = new ReceiptJournal({ directory, deviceId: 'device-fixture', clock: { ...defaultClock, utc: () => new Date().toISOString() } });
    const reducer = new RunReducer({ journal });
    await reducer.begin({ runId: 'r1', requirements: [predicate('save', { expected: text }), predicate('tracking', { expected: 'unattempted' })] });
    const grant = createPrivateHandle('grant', 'crash-fixture-grant');
    const adapter = {
      preflight: async () => ({ eligible: true, revision, evidence: [], noEffectProven: true }),
      perform: async (op, ctx) => {
        await ctx.dispatch.beforeEffect({ primitive: 'atspi.SetTextContents', substep: 'editText', target });
        try {
          await fetch(endpoint + '/lost-reply', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ text: op.edit.text }), signal: ctx.signal });
        } catch {
          // Deliberate process death between the external commit and any acknowledgement/terminal record.
          process.exit(23);
        }
        process.exit(24);
      },
      probe: async () => [],
      quiesce: async () => ({ state: 'confirmed', ownedInputReleased: true, reasonCodes: [] }),
    };
    const coordinator = new ExecutionCoordinator({ journal, adapter, reducer, clock: defaultClock, authorize: async () => ({ grant, revision }) });
    const request = action(); request.operation.edit.text = text; request.expect = [predicate('save', { expected: text })];
    await coordinator.invoke(invocation(request), session);
    process.exit(25);
  } catch { process.exit(26); }
});
process.on('disconnect', () => process.exit(27));
