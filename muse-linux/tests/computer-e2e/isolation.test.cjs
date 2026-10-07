'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const cp = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { ComputerRuntime } = require('../../src/computer/index.cjs');
const { identity, sameProcess } = require('../../src/computer/session/index.cjs');
function hostState() {
  const query = command => JSON.parse(cp.execFileSync('/usr/bin/hyprctl', ['-j', command], { encoding: 'utf8', timeout: 2000 }));
  return { windows: query('clients').map(w => ({ id: w.address, pid: w.pid, workspace: w.workspace.id })).sort((a, b) => a.id.localeCompare(b.id)),
    focus: query('activewindow').address, workspace: query('activeworkspace').id, pointer: query('cursorpos') };
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(read, ms = 5000) {
  const deadline = performance.now() + ms;
  while (performance.now() < deadline) {
    const value = await read(); if (value) return value;
    await sleep(30);
  }
  throw Error('isolated_fixture_readiness_timeout');
}
function passiveComparison(before, after) {
  return { windows: JSON.stringify(after.windows) === JSON.stringify(before.windows), focus: after.focus === before.focus,
    workspace: after.workspace === before.workspace, pointer: JSON.stringify(after.pointer) === JSON.stringify(before.pointer),
    changeAttribution: JSON.stringify(after) === JSON.stringify(before) ? 'no_change_observed' : 'unknown' };
}
test('main composition drives approved private app, semantic discovery, window control and screenshot deltas', { skip: process.env.MUSE_COMPUTER_E2E !== '1', timeout: 90000 }, async () => {
  const directory = await fs.mkdtemp('/tmp/muse-port-d6c9/rewrite/runtime-isolation-');
  const runtime = new ComputerRuntime({ deviceId: 'isolation-fixture', directory, nativeDirectory: path.resolve('native/bin'),
    policy: () => ({ desktopPolicy: 'allow', browserPolicy: 'deny' }), permission: async () => true, desktop: { paused: false } });
  const before = hostState(), started = performance.now();
  const metrics = { actionCount: 0, mutationActionCount: 0, metadataControlCalls: 0, screenshotRequests: 0, screenshotsTransferred: 0, observations: 0, failures: [], steps: [],
    modelRoundTrips: null, metricProvenance: 'scripted_no_model', inputLatencyMs: null };
  let ownedRecord, ownedProcesses = [], failure;
  async function control(args) {
    const request = { invokeId: randomUUID(), command: 'computer.control', params: args, deadline: Date.now() + 10000 };
    metrics.actionCount++;
    if (args.action.startsWith('list_')) metrics.metadataControlCalls++; else metrics.mutationActionCount++;
    const begin = performance.now();
    try {
      const result = await runtime.control(request, args);
      metrics.steps.push({ action: args.action, elapsedMs: performance.now() - begin, dispatch: result.receipt?.dispatch,
        effect: result.receipt?.effect, taskSuccess: result.task_success, error: result.error });
      if (result.error) metrics.failures.push({ action: args.action, code: result.error });
      return result;
    } catch (error) { metrics.failures.push({ action: args.action, code: error.code || error.message }); throw error; }
  }
  async function observe(args = {}) {
    metrics.observations++; if (args.view === 'image') metrics.screenshotRequests++;
    const begin = performance.now();
    try {
      const result = await runtime.observe({ ...args, __deadline: Date.now() + 10000 });
      if (result.image_transfer) metrics.screenshotsTransferred++;
      if (result.accessibility_error) metrics.failures.push({ action: 'observe', code: result.accessibility_error });
      metrics.steps.push({ action: 'observe', elapsedMs: performance.now() - begin, route: result.route,
        captureStatus: result.capture_status, unchanged: result.unchanged, pixelsTransferred: !!result.image_transfer });
      return result;
    } catch (error) { metrics.failures.push({ action: 'observe', code: error.code || error.message }); throw error; }
  }
  try {
    assert.equal(runtime.isolationStatus().available, true);
    const startup = performance.now();
    const result = await runtime.start({ scope: 'isolated_desktop', task: 'Owned isolated composition benchmark', __deadline: Date.now() + 40000 });
    metrics.startupMs = performance.now() - startup;
    assert.equal(result.host_input, false); assert.equal(runtime.session.state, 'ready');
    assert.equal(result.capabilities.nativeSemantic.verification, 'measured');
    metrics.capabilities = result.capabilities;
    ownedRecord = runtime.manager.record(runtime.session.id);
    assert.deepEqual((await observe()).controls, []);
    assert.ok(result.apps.includes('files'), 'factory must advertise the approved files app used by this benchmark');
    const opened = await control({ action: 'open_app', app: 'files' });
    assert.equal(opened.launched, true); assert.equal(opened.host_input, false);
    metrics.launchedProcess = opened.process;
    const windows = await until(async () => { const rows = (await control({ action: 'list_windows' })).windows; return rows.length === 1 && rows; });
    metrics.launchProcessAlive = sameProcess(identity(opened.process.pid), opened.process);
    metrics.privateProcessesBeforeObserve = ownedRecord.owner.manifest();
    metrics.launchedWindows = windows;
    const windowId = windows[0].window_id;
    let tree, lastTransientError;
    const discoveryDeadline = performance.now() + 3000;
    for (let attempt = 0; attempt < 20 && performance.now() < discoveryDeadline; attempt++) {
      try {
        const candidate = await observe({ window_id: windowId });
        if (candidate.accessibility_status === 'unavailable') throw Object.assign(Error(candidate.accessibility_error), { code: candidate.accessibility_error });
        tree = candidate; break;
      }
      catch (error) {
        if (!['ambiguous_accessibility_root', 'root_mapping_required', 'dirty_ref'].includes(error.code)) throw error;
        lastTransientError = error; metrics.readOnlyDiscoveryRetries = (metrics.readOnlyDiscoveryRetries || 0) + 1;
        await sleep(100);
      }
    }
    if (!tree) {
      metrics.discoveryWindows = await runtime.listIsolatedWindows();
      metrics.discoveryRoots = (await runtime.accessibility.discover({ ...runtime.isolatedWindows[0].foreignTarget,
        process: opened.process }, runtime.context())).candidates;
      const frame = await runtime.session.runner.exec('readinessCapture', ['-o', 'HEADLESS-1', '-'], {
        ...runtime.context(), encoding: 'buffer', maxBytes: 4194304,
      });
      if (frame.exitCode === 0 && !frame.outputTruncated) {
        await fs.writeFile(path.join(directory, 'files-discovery-failure.png'), frame.stdout, { mode: 0o600 });
        metrics.diagnosticScreenshot = { route: 'test_private_capture', bytes: frame.stdout.length };
      }
      throw lastTransientError || Error('isolated_fixture_readiness_timeout');
    }
    assert.equal(tree.route, 'isolated_atspi'); assert.equal(tree.host_input, false);
    assert.ok(tree.controls.length > 1, 'approved files app must have actual semantic controls');
    assert.ok(tree.controls.some(control => control.capabilities?.length), 'native refs need supported capabilities');
    assert.equal(tree.coordinates_available, false, 'uncalibrated coordinates must stay explicitly unavailable');
    metrics.nativeControls = tree.controls.length;
    metrics.observedTitle = tree.title; metrics.stateConflicts = tree.state_conflicts;
    if (windows[0].title === 'Loading…') {
      assert.equal(tree.title, 'Home', 'fresh accessibility state must identify the actually loaded folder');
      assert.ok(tree.state_conflicts?.some(conflict => conflict.source === 'foreign_window_title' && conflict.value === 'Loading…'),
        'the conflicting compositor title must be reported rather than silently treated as a failed load');
    }
    const activated = await control({ action: 'activate', window_id: windowId });
    assert.equal(activated.receipt.dispatch, 'acknowledged');
    metrics.activationVerification = activated.receipt.effect;
    const first = await observe({ window_id: windowId, view: 'image', force_image: 'true' });
    assert.equal(first.capture_status, 'available'); assert.equal(first.image_current, true); assert.equal(first.unchanged, false);
    assert.ok(first.image_transfer?.data_base64);
    await fs.writeFile(path.join(directory, 'files-before.png'), Buffer.from(first.image_transfer.data_base64, 'base64'), { mode: 0o600 });
    const second = await observe({ window_id: windowId, view: 'image' });
    assert.equal(second.capture_status, 'available'); assert.equal(second.unchanged, true);
    assert.equal(second.image_transfer, undefined, 'unchanged pixels must not be sent again');
    assert.equal(second.screenshot_id, first.screenshot_id);
    const realObserve = runtime.accessibility.observe;
    runtime.accessibility.observe = async () => { throw Object.assign(Error('test_ax_probe_unavailable'), { code: 'test_ax_probe_unavailable' }); };
    try {
      const visualFallback = await observe({ window_id: windowId, view: 'image', force_image: 'true' });
      assert.equal(visualFallback.accessibility_status, 'unavailable');
      assert.equal(visualFallback.accessibility_error, 'test_ax_probe_unavailable');
      assert.equal(visualFallback.capture_status, 'available'); assert.equal(visualFallback.image_current, true);
      assert.ok(visualFallback.image_transfer?.data_base64, 'private pixels must remain available after a failed AX read');
      metrics.injectedFailureRecovery = { provenance: 'test_injected_accessibility_read_failure', independentPixelsAvailable: true };
    } finally { runtime.accessibility.observe = realObserve; }
    const closed = await control({ action: 'close_window', window_id: windowId });
    assert.equal(closed.receipt.dispatch, 'acknowledged'); assert.equal(closed.receipt.effect, 'verified');
    assert.equal(closed.task_success, true);
    assert.deepEqual((await control({ action: 'list_windows' })).windows, []);
    assert.deepEqual((await observe()).controls, []);
    const after = hostState();
    ownedProcesses = ownedRecord.owner.manifest();
    const ownedPids = new Set(ownedProcesses.map(row => row.pid));
    assert.equal(after.windows.some(row => ownedPids.has(row.pid)), false, 'no private app/helper may map a host window');
    metrics.passiveHostComparison = passiveComparison(before, after);
    metrics.noOwnedHostWindows = true; metrics.success = true;
  } catch (error) { failure = error; metrics.success = false; metrics.failure = { code: error.code || error.message }; }
  finally {
    if (ownedRecord) ownedProcesses = ownedRecord.owner.manifest();
    await runtime.close();
    metrics.cleanupRemainingProcesses = ownedProcesses.filter(row => sameProcess(identity(row.pid), row)).map(row => ({ pid: row.pid, startToken: row.startToken }));
    metrics.elapsedMs = performance.now() - started;
    await fs.writeFile(path.join(directory, 'result.json'), JSON.stringify(metrics, null, 2), { mode: 0o600 });
    console.log(`Main isolated runtime artifacts: ${directory}`);
  }
  if (failure) throw failure;
  assert.deepEqual(metrics.cleanupRemainingProcesses, [], 'Stop must end only the owned private session processes');
});
