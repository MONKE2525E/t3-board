'use strict';
// No desktop, browser, network or installed-app state. This is the external effect fixture.
const { fs, path, ReceiptJournal, context, beginAction, terminal, target, revision } = require('./helpers.cjs');
async function main() {
  const [directory, mode] = process.argv.slice(2);
  const journal = new ReceiptJournal({ directory, deviceId: 'fixture-device' });
  await journal.ready;
  await journal.registerRun('run-1');
  const { handle } = await beginAction(journal);
  const attempt = await journal.beforeEffect(handle, { primitive: 'submit', substep: 'click', target, revision });
  if (mode !== 'marker-only') {
    const stateFile = await fs.open(path.join(directory, 'fixture-state.json'), 'wx', 0o600);
    await stateFile.writeFile(JSON.stringify({ submissions: 1, text: 'owned synthetic form' }));
    await stateFile.sync(); await stateFile.close();
  }
  if (mode === 'terminal') {
    await journal.endAttempt(attempt, { dispatch: 'acknowledged', effect: 'verified', evidenceIds: [], timings: {} });
    await journal.end(handle, terminal(context()));
    await journal.close();
  }
  process.stdout.write('fixture_finished\n');
  process.exit(mode === 'terminal' ? 0 : 23);
}
if (require.main === module) main().catch(() => { process.stderr.write('fixture_failed\n'); process.exit(24); });
