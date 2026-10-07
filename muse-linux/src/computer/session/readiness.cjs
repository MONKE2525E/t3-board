'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { StringDecoder } = require('node:string_decoder');
const { fail, bounded, identity, sameProcess } = require('./resources.cjs');
const { ForeignToplevelClient } = require('./foreign-toplevel.cjs');
const { AccessibilityClient } = require('../desktop/accessibility-client.cjs');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

// A narrowly bounded PNG decoder used only for the owned startup color marker.
function markerPixel(png, x, y) {
  if (!Buffer.isBuffer(png) || png.length > 4194304 || !png.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) fail('readiness_pixels_invalid');
  let width, height, channels; const compressed = [];
  for (let offset = 8; offset + 12 <= png.length;) {
    const n = png.readUInt32BE(offset), type = png.subarray(offset + 4, offset + 8).toString('ascii');
    if (offset + 12 + n > png.length) fail('readiness_pixels_invalid');
    const data = png.subarray(offset + 8, offset + 8 + n);
    if (type === 'IHDR') {
      if (n !== 13 || data[8] !== 8 || ![2, 6].includes(data[9]) || data[10] || data[11] || data[12]) fail('readiness_pixels_unsupported');
      width = data.readUInt32BE(0); height = data.readUInt32BE(4); channels = data[9] === 6 ? 4 : 3;
    } else if (type === 'IDAT') compressed.push(data);
    offset += n + 12;
  }
  if (width !== 1280 || height !== 720 || x < 0 || y < 0 || x >= width || y >= height) fail('readiness_pixels_invalid');
  const stride = width * channels, raw = zlib.inflateSync(Buffer.concat(compressed), { maxOutputLength: (stride + 1) * height });
  if (raw.length !== (stride + 1) * height) fail('readiness_pixels_invalid');
  let previous = Buffer.alloc(stride);
  for (let row = 0; row <= y; row++) {
    const filter = raw[row * (stride + 1)], current = Buffer.alloc(stride);
    if (filter > 4) fail('readiness_pixels_invalid');
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? current[i - channels] : 0, b = previous[i], c = i >= channels ? previous[i - channels] : 0;
      const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      const predictor = filter === 0 ? 0 : filter === 1 ? a : filter === 2 ? b : filter === 3 ? Math.floor((a + b) / 2) : pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      current[i] = (raw[row * (stride + 1) + 1 + i] + predictor) & 255;
    }
    previous = current;
  }
  return [...previous.subarray(x * channels, x * channels + 3)];
}

function createSessionExecutableAllowlist({ worker, pointer, keyboard, foreignToplevel, fixture, capture }) {
  const empty = a => a.length === 0;
  const workerRead = ['hello', 'discover', 'observe', 'resolve', 'renew', 'readText'];
  const workerMutation = ['replace', 'insert', 'delete', 'invoke', 'focus', 'reveal', 'clearSelection', 'selectChild', 'deselectChild'];
  return {
    'accessibility-worker': { path: worker, pidNamespace: false, persistent: true, access: 'read', validateArgs: empty,
      messageAccess: data => {
        try { if (data.length < 6 || data.readUInt32BE(0) !== data.length - 4) return 'deny'; const req = JSON.parse(data.subarray(4).toString('utf8'));
          if (req.schema !== 'muse.atspi.v1') return 'deny'; return workerRead.includes(req.operation) ? 'read' : workerMutation.includes(req.operation) ? 'mutation' : 'deny'; }
        catch { return 'deny'; }
      } },
    pointer: { path: pointer, pidNamespace: false, persistent: true, validateArgs: empty },
    keyboard: { path: keyboard, pidNamespace: false, persistent: true, validateArgs: empty },
    foreignToplevel: { path: foreignToplevel, persistent: true, access: 'read', validateArgs: a => a.length === 1 && a[0] === '--serve',
      messageAccess: data => { try { const req = JSON.parse(Buffer.from(data).toString('utf8')); return req.op === 'list' ? 'read' : ['activate', 'close'].includes(req.op) ? 'mutation' : 'deny'; } catch { return 'deny'; } } },
    readinessFixture: { path: fixture, internalOnly: true, validateArgs: a => a.length === 1 && /^[a-f0-9-]{36}$/.test(a[0]) },
    readinessCapture: { path: capture, access: 'read', validateArgs: a => a.length === 3 && a.join(' ') === '-o HEADLESS-1 -' },
  };
}

function createCageReadinessProbe({ createWorkerChannel, createAccessibilityClient = options => new AccessibilityClient(options), clock,
  onPhase = () => {}, onFrame = () => {}, captureId = 'readinessCapture', pointerId = 'pointer', keyboardId = 'keyboard', foreignId = 'foreignToplevel' }) {
  if (typeof createWorkerChannel !== 'function' || typeof clock?.now !== 'function' || !clock.domain) fail('invalid_readiness_options', 'invalid_request');
  return async ({ session, launch, ctx }) => {
    const nonce = crypto.randomUUID(), file = path.join(session.environment.HOME, `readiness-${nonce}.txt`);
    const channels = []; let accessibility, foreign, client, fixtureTarget;
    const localCtx = { ...ctx, runId: ctx.runId || nonce, invokeId: ctx.invokeId || nonce, actionId: nonce,
      progress: { check() { if (ctx.signal.aborted || clock.now() >= ctx.budget.deadlineMonoMs) fail('deadline', 'deadline'); },
        remainingMs: () => Math.max(0, ctx.budget.deadlineMonoMs - clock.now()) } };
    const wait = async test => bounded(async () => { while (true) { localCtx.progress.check(); const value = await test(); if (value) return value; await pause(20); } }, ctx.budget, clock, ctx.signal);
    const rpc = async (operation, work) => {
      onPhase('accessibility_' + operation);
      try { return await work(); }
      catch (error) { error.readinessPhase = operation; throw error; }
    };
    const capture = async stage => {
      const frame = await session.runner.exec(captureId, ['-o', 'HEADLESS-1', '-'], { ...localCtx, encoding: 'buffer', maxBytes: 4194304 });
      const color = markerPixel(frame.stdout, 64, 192);
      if (frame.exitCode !== 0 || frame.outputTruncated || color.some((n, i) => Math.abs(n - [32, 128, 191][i]) > 2)) fail('readiness_frame_marker_failed');
      await bounded(() => onFrame(stage, frame.stdout), ctx.budget, clock, ctx.signal);
    };
    const state = () => {
      try { const stat = fs.lstatSync(file); if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || stat.size > 4096) fail('unsafe_readiness_state');
        const lines = fs.readFileSync(file, 'utf8').split('\n'); return lines[0] === nonce ? { clicks: Number(lines[1]), submits: Number(lines[2]), text: lines.slice(3).join('\n') } : null; }
      catch (e) { if (e.code !== 'ENOENT') throw e; return null; }
    };
    const helper = async id => {
      const channel = await session.runner.spawn(id, [], localCtx); channels.push(channel);
      const messages = []; const decoder = new StringDecoder('utf8'); let pending = '', bytes = 0, helperFailure;
      const unsubscribe = channel.subscribe(data => {
        if (helperFailure) return;
        bytes += data.byteLength;
        if (bytes > 262144) { helperFailure = 'readiness_helper_overflow'; return; }
        pending += decoder.write(Buffer.from(data));
        let index; while ((index = pending.indexOf('\n')) >= 0) {
          const line = pending.slice(0, index); pending = pending.slice(index + 1);
          try { const message = JSON.parse(line); if (!message || typeof message !== 'object' || Array.isArray(message) || messages.length >= 256) { helperFailure = 'readiness_helper_invalid'; return; } messages.push(message); }
          catch { helperFailure = 'readiness_helper_invalid'; return; }
        }
      });
      const reply = test => wait(() => { if (helperFailure) fail(helperFailure); return messages.find(test); });
      await reply(x => x.event === 'ready');
      return { unsubscribe, async send(req) {
        await channel.write(Buffer.from(JSON.stringify(req) + '\n'), localCtx);
        const result = await reply(x => x.id === req.id && ['result', 'error'].includes(x.event));
        if (result.event !== 'result') fail('readiness_input_failed'); return result;
      } };
    };
    try {
      onPhase('launch');
      client = await launch({ appId: 'muse-readiness-fixture', args: [nonce] });
      await wait(() => state());
      // Host-visible bus peer PIDs and host /proc are intentionally required.
      if (!sameProcess(identity(client.process.pid), client.process)) fail('readiness_owner_lost');
      foreign = new ForeignToplevelClient({ session, executableId: foreignId, clock });
      await foreign.start(localCtx);
      const windows = await wait(async () => {
        const rows = await foreign.list(localCtx);
        if (!rows.length) return false;
        if (rows.length !== 1 || rows[0].appId !== 'muse-readiness-fixture') fail('readiness_window_ambiguous');
        return rows;
      });
      fixtureTarget = { ...windows[0].target, process: { ...client.process } };
      localCtx.revision = { sessionGeneration: session.generation, targetGeneration: fixtureTarget.generation,
        grantGeneration: 0, semanticRevision: 0, geometryRevision: 0 };
      // This facade never escapes calibration. Main remains starting until all
      // probes pass; Pause/Stop/generation changes still reach the real runner.
      const calibration = { id: session.id, mode: session.mode, buses: session.buses, display: session.display,
        get generation() { return session.generation; },
        get state() { return session.state === 'starting' ? 'ready' : session.state; },
        runner: { spawn: async (...args) => { const channel = await session.runner.spawn(...args); channels.push(channel); return channel; } } };
      accessibility = createAccessibilityClient({ channel: createWorkerChannel({ clock }), plainTextPolicy: () => true,
        rootMapper: async target => {
          const candidates = await wait(async () => {
            const found = await rpc('discover', () => accessibility.discover(target, localCtx)); return found.candidates?.length && found.candidates;
          });
          if (candidates.length !== 1 || candidates[0].pid !== client.process.pid || candidates[0].ownerStartToken !== client.process.startToken || candidates[0].name !== 'Muse readiness fixture') fail('readiness_owner_ambiguous');
          return { ...candidates[0], ...client.process, confidence: 'exact' };
        } });
      const hello = await rpc('start', () => accessibility.start(calibration, localCtx));
      if (!hello.ready) fail('readiness_worker_unavailable');
      const observed = await rpc('observe', () => accessibility.observe(fixtureTarget, { scope: 'structural', maxNodes: 64, maxDepth: 8 }, localCtx));
      const editors = observed.nodes.filter(n => n.name === 'Muse readiness editor' && n.capabilities.includes('editText'));
      if (editors.length !== 1 || !observed.coverage.complete) fail('readiness_semantic_unavailable');
      let ref = await rpc('renew', () => accessibility.renewForRead(editors[0].ref, localCtx));
      const before = await rpc('readText', () => accessibility.readText(ref, { mode: 'verify' }, localCtx));
      if (!before.complete || before.totalScalars !== 0 || before.totalUtf8Bytes !== 0 || state()?.text !== '') fail('readiness_initial_state_failed');
      await capture('before');
      const text = 'Muse private café 日本語 😀';
      const edit = await rpc('edit', () => accessibility.edit(ref, { mode: 'replace', text, semantics: 'plain_text',
        newlinePolicy: 'reject_singleline', clipboard: 'forbid', expectedBefore: { privateDigest: before.digestRef, scalarCount: before.totalScalars } }, localCtx));
      if (edit.effect !== 'verified' || edit.verified !== true || edit.readback?.ref !== ref.id || !edit.readback.complete) fail('readiness_semantic_failed');
      ref = edit.renewedRef || await rpc('renew', () => accessibility.renewForRead(ref, localCtx));
      const read = await rpc('readText', () => accessibility.readText(ref, { mode: 'verify', expectedPrivateDigest: edit.readback.digestRef }, localCtx));
      if (!read.complete || !read.exactMatch || read.totalScalars !== [...text].length || read.totalUtf8Bytes !== Buffer.byteLength(text)) fail('readiness_semantic_failed');
      onPhase('semantic_application_state');
      await wait(() => state()?.text === text);
      await capture('semantic');
      ref = await rpc('renew', () => accessibility.renewForRead(ref, localCtx));
      await rpc('focus', () => accessibility.focus(ref, localCtx));
      ref = await rpc('renew', () => accessibility.renewForRead(ref, localCtx));
      const focused = await rpc('readRaw', () => accessibility.readRaw(ref, localCtx));
      if (!focused.complete || focused.selections.length > 1) fail('readiness_selection_unknown');
      const selection = focused.selections[0] || [focused.caret, focused.caret], scalars = [...focused.text];
      if (!selection.every(n => Number.isInteger(n) && n >= 0 && n <= scalars.length) || selection[1] < selection[0]) fail('readiness_selection_unknown');
      const physicalExpected = scalars.slice(0, selection[0]).join('') + ' K' + scalars.slice(selection[1]).join('');
      onPhase('keyboard_ready');
      const keyboard = await helper(keyboardId);
      await keyboard.send({ id: crypto.randomUUID(), action: 'type', text: ' K' }); keyboard.unsubscribe();
      onPhase('keyboard_application_state');
      await wait(() => state()?.text === physicalExpected && state()?.submits === 0);
      onPhase('pointer_ready');
      const pointer = await helper(pointerId);
      await pointer.send({ id: crypto.randomUUID(), action: 'click', point: { x: 64, y: 192, localX: 64, localY: 192, width: 1280, height: 720, output: 'HEADLESS-1' } }); pointer.unsubscribe();
      onPhase('pointer_application_state');
      await wait(() => state()?.clicks === 1 && state()?.submits === 0);
      await capture('after');
      const verified = { semantic: true, pixels: true, input: true, activation: false,
        ownerPid: client.process.pid, ownerStartToken: client.process.startToken, accessibilityClient: 'persistent',
        fullReadback: { scalarCount: read.totalScalars, utf8Bytes: read.totalUtf8Bytes, exactMatch: read.exactMatch,
          requestedRefCorrelated: edit.readback.ref === before.ref } };
      onPhase('fixture_close'); const close = await foreign.close(fixtureTarget, localCtx);
      if (close.effect !== 'verified') fail('readiness_fixture_cleanup_failed');
      onPhase('fixture_process_exit'); await wait(() => !sameProcess(identity(client.process.pid), client.process));
      return verified;
    } finally {
      const cleanupBudget = { clockDomain: clock.domain, deadlineMonoMs: clock.now() + 1000 };
      await accessibility?.stop(localCtx); await foreign?.stop(cleanupBudget);
      const stopped = await Promise.all(channels.map(channel => channel.stop(cleanupBudget)));
      if (stopped.some(result => result.state !== 'confirmed')) fail('readiness_helper_cleanup_failed');
      try { fs.unlinkSync(file); } catch (e) { if (e.code !== 'ENOENT') fail('readiness_state_cleanup_failed'); }
    }
  };
}
module.exports = { createCageReadinessProbe, createSessionExecutableAllowlist, markerPixel };
