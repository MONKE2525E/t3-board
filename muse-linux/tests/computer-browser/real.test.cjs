'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { BrowserController } = require('../../src/computer/browser/index.cjs');
const { WebSocketTransport } = require('../../src/computer/browser/index.cjs');
const { startFixture } = require('./fixture.cjs');
const { context, policy, edit, find } = require('./helpers.cjs');
const { BrowserFailure } = require('../../src/computer/browser/support.cjs');
const { declarations } = require('../../src/computer/browser/dom.cjs');
test('real owned Chrome: selected target, Unicode, controlled input, modal, file, Stop', { skip: process.env.MUSE_BROWSER_REAL !== '1', timeout: 120000 }, async () => {
  const fixture = await startFixture(); let controller; const events = []; const results = [];
  try {
    const beforeImage = await fixture.screenshot('before.png');
    const duplicate = await fixture.send('Target.createTarget', { url: fixture.origin });
    // Test setup alone creates/activates owned synthetic tabs; the production controller forbids both.
    await fixture.send('Target.activateTarget', { targetId: duplicate.targetId });
    let approved = true; const file = path.join(fixture.directory, 'approved.txt'); await fs.writeFile(file, 'Synthetic approved file', { mode: 0o600 });
    controller = new BrowserController({ policy, fixtureOrigins: [fixture.origin, fixture.crossOrigin], onEvent: event => events.push(event), files: { resolveApproved: async capabilityId => capabilityId === 'approved' && approved ? { path: file, size: 23, symlinkSafe: true, approved: true } : null } });
    const ctx = context({ actionId: 'connection', deadlineMs: 100000 });
    const connected = await controller.connect({ mode: 'chrome_consent', endpoint: fixture.endpoint }, ctx); assert.equal(connected.state, 'connected', JSON.stringify(connected));
    const picker = await controller.listForLocalPicker(ctx); assert.equal(picker.length, 2);
    let lease;
    controller.policy = { ...policy, authorize: async (_ctx, req) => req.action !== 'attach' || req.target.targetId === fixture.targetId };
    for (const candidate of picker) {
      try { lease = await controller.attach(candidate.selectionToken, ctx); break; }
      catch (error) { if (error.code !== 'permission_denied') throw error; }
    }
    assert.equal(lease.target.targetId, fixture.targetId, 'fixture selection must bind original background tab');
    assert.equal(lease.target.ownership, 'borrowed');
    async function observe(query) { return controller.observe({ lease, sources: ['dom'], query }, context({ actionId: `observe-${results.length}`, deadlineMs: 10000 })); }
    async function perform(name, makeOp, budget = 8000) {
      const observation = await observe(); const actionCtx = context({ actionId: name, deadlineMs: budget });
      const receipt = await controller.perform(makeOp(observation), actionCtx); results.push({ name, dispatch: receipt.dispatch, effect: receipt.effect, failure: receipt.failure, timings: receipt.timings, attempts: receipt.attempts });
      return { receipt, actionCtx, observation };
    }
    let observation = await observe();
    assert.equal(observation.state.evidence[0].facts[0].value.currentUrl, `${fixture.origin}/`);
    assert(observation.state.evidence[0].facts[0].value.headings.includes('Synthetic Orders'));
    assert(!JSON.stringify(observation).includes('PRIVATE_CANARY'));
    const unicode = '漢字🙂e\u0301العربية\nLiteral\ttab\n' + '🦋'.repeat(2000);
    let result = await perform('unicode', o => ({ kind: 'editText', ref: find(o, 'Paragraph'), edit: edit(unicode) }));
    assert.equal(result.receipt.effect, 'verified', JSON.stringify(result.receipt.failure));
    assert.equal(JSON.parse(await fixture.state()).paragraph, unicode);
    const editedImage = await fixture.screenshot('edited.png');
    const exact = result.receipt.evidence.find(e => e.facts.some(f => f.predicate === 'text_exact'));
    assert.equal(exact.freshness, 'current'); assert.deepEqual(exact.revisionBefore, exact.revisionAfter);
    const textFact = exact.facts[0].value; assert.equal(textFact.expectedPrivateDigest, textFact.actualPrivateDigest); assert.equal(textFact.totalScalars, [...unicode].length); assert.equal(textFact.totalUtf8Bytes, Buffer.byteLength(unicode));
    assert(!JSON.stringify(result.receipt).includes(unicode));
    const duplicateReceipt = await controller.perform({ kind: 'editText', ref: find(result.observation, 'Paragraph'), edit: edit(unicode) }, result.actionCtx);
    assert.deepEqual(duplicateReceipt, result.receipt);
    assert.equal(result.actionCtx.records.length, 2);
    observation = await observe(); const paragraph = find(observation, 'Paragraph');
    const paged = await controller.readText(paragraph, { mode: 'page', offset: 1000, limitScalars: 17 }, context());
    assert.equal(paged.text, [...unicode].slice(1000, 1017).join('')); assert.equal(paged.truncated, true);
    const verified = await controller.readText(paragraph, { mode: 'verify', expectedPrivateDigest: textFact.actualPrivateDigest }, context());
    assert.equal(verified.complete, true); assert.equal(verified.exactMatch, true);
    result = await perform('append', o => ({ kind: 'editText', ref: find(o, 'Paragraph'), edit: { ...edit('🧪tail'), mode: 'append' } })); assert.equal(result.receipt.effect, 'verified'); assert.equal(JSON.parse(await fixture.state()).paragraph, unicode + '🧪tail');
    result = await perform('selection', o => ({ kind: 'editText', ref: find(o, 'Paragraph'), edit: { ...edit('start'), mode: 'replaceSelection', selection: { units: 'dom_utf16', start: 0, end: 2 } } })); assert.equal(result.receipt.effect, 'verified');
    assert.equal(JSON.parse(await fixture.state()).paragraph, 'start' + unicode.slice(2) + '🧪tail');
    result = await perform('surrogate-split', o => ({ kind: 'editText', ref: find(o, 'Paragraph'), edit: { ...edit('bad'), mode: 'insert', selection: { units: 'dom_utf16', start: 6, end: 6 } } })); assert.equal(result.actionCtx.records.length, 0); assert.equal(result.receipt.failure.code, 'selection_unavailable');
    result = await perform('contenteditable', o => ({ kind: 'editText', ref: find(o, 'Editable'), edit: edit('Plain 漢🙂\nSecond line') })); assert.equal(result.receipt.effect, 'verified', JSON.stringify(result.receipt.failure)); assert.equal(await fixture.evaluate("document.querySelector('[contenteditable]').innerText"), 'Plain 漢🙂\nSecond line');
    result = await perform('shadow', o => ({ kind: 'editText', ref: find(o, 'Shadow entry'), edit: edit('Shadow 🙂') })); assert.equal(result.receipt.effect, 'verified', JSON.stringify(result.receipt.failure)); assert.equal(await fixture.evaluate("shadow.shadowRoot.querySelector('input').value"), 'Shadow 🙂');
    observation = await observe();
    assert(observation.state.evidence[0].coverage.omissionReasons.includes('closed_shadow_roots_not_observable'));
    assert(!JSON.stringify(observation).includes('Closed hidden'));
    for (const name of ['Same frame editor', 'Cross frame editor', 'Nested frame editor']) {
      result = await perform(name, o => ({ kind: 'editText', ref: find(o, name), edit: edit(`${name} 漢🙂`) })); assert.equal(result.receipt.effect, 'verified', `${name}: ${JSON.stringify(result.receipt.failure)}`);
    }
    result = await perform('controlled', o => ({ kind: 'editText', ref: find(o, 'Controlled'), edit: edit('Controlled 漢🙂') })); assert.equal(result.receipt.effect, 'verified', JSON.stringify(result.receipt.failure));
    assert.equal(JSON.parse(await fixture.state()).controlled, 'Controlled 漢🙂');
    result = await perform('empty', o => ({ kind: 'editText', ref: find(o, 'Paragraph'), edit: edit('') })); assert.equal(result.receipt.effect, 'verified', JSON.stringify(result.receipt.failure)); assert.equal(JSON.parse(await fixture.state()).paragraph, '');
    result = await perform('checked', o => ({ kind: 'setChecked', ref: find(o, 'Enabled'), checked: true })); assert.equal(result.receipt.effect, 'verified', JSON.stringify(result.receipt.failure)); assert.equal(JSON.parse(await fixture.state()).checked, true);
    observation = await observe({ scope: 'structural', exact: true, limit: 100 });
    result = await controller.perform({ kind: 'select', ref: find(observation, 'Choice'), itemRefs: [find(observation, 'Beta')], mode: 'replace' }, context({ actionId: 'select' })); assert.equal(result.effect, 'verified', JSON.stringify(result.failure)); assert.equal(JSON.parse(await fixture.state()).selected, 'b');
    result = await perform('save', o => ({ kind: 'click', ref: find(o, 'Save synthetic'), button: 'left' })); assert.equal(result.receipt.dispatch, 'acknowledged', JSON.stringify(result.receipt.failure)); assert.equal(JSON.parse(await fixture.state()).saved, 1);
    await fixture.send('Runtime.evaluate', { expression: "document.getElementById('cover').style.display='block'" }, fixture.inspectorSession);
    result = await perform('covered', o => ({ kind: 'click', ref: find(o, 'Save synthetic'), button: 'left' })); assert.equal(result.receipt.effect, 'none_proven'); assert.equal(result.actionCtx.records.length, 0); assert.equal(result.receipt.failure.code, 'occluded');
    await fixture.send('Runtime.evaluate', { expression: "document.getElementById('cover').style.display='none'" }, fixture.inspectorSession);
    result = await perform('disabled', o => ({ kind: 'editText', ref: find(o, 'Disabled'), edit: edit('bad') })); assert.equal(result.actionCtx.records.length, 0);
    observation = await observe(); const oldRef = find(observation, 'Paragraph');
    await fixture.send('Runtime.evaluate', { expression: 'paragraph.replaceWith(paragraph.cloneNode())' }, fixture.inspectorSession);
    result = await controller.edit(oldRef, edit('wrong replacement'), context({ actionId: 'detached' })); assert.equal(result.dispatch, 'not_started');
    const forged = structuredClone(oldRef); forged.browser.backendNodeId++;
    result = await controller.edit(forged, edit('forged'), context({ actionId: 'forged' })); assert.equal(result.dispatch, 'not_started'); assert.equal(result.failure.code, 'stale_ref');
    result = await perform('file', o => ({ kind: 'upload', ref: find(o, 'Attachment'), fileCapabilityIds: ['approved'] })); assert.equal(result.receipt.effect, 'verified', JSON.stringify(result.receipt.failure)); assert.equal(JSON.parse(await fixture.state()).uploads, 1);
    approved = false; result = await perform('revoked-file', o => ({ kind: 'upload', ref: find(o, 'Attachment'), fileCapabilityIds: ['approved'] })); assert.equal(result.actionCtx.records.length, 0);
    result = await perform('dialog', o => ({ kind: 'click', ref: find(o, 'Confirm synthetic'), button: 'left' })); assert.equal(result.receipt.dispatch, 'possible', JSON.stringify(result.receipt.failure)); assert.equal(result.receipt.failure.code, 'dialog_checkpoint');
    assert(controller.dialog);
    result = await controller.perform({ kind: 'dialog', dialogId: controller.dialog.id, decision: 'accept' }, context({ actionId: 'dialog-accept' })); assert.equal(result.dispatch, 'acknowledged', JSON.stringify(result.failure)); assert.equal(JSON.parse(await fixture.state()).dialog, true);
    assert.equal(controller.heldButtons.size, 0);
    await controller.resumeByUser(context());
    result = await perform('dialog-down', o => ({ kind: 'click', ref: find(o, 'Dialog on down'), button: 'left' })); assert.equal(result.receipt.failure.code, 'dialog_checkpoint'); assert.equal(result.actionCtx.records.length, 1);
    result = await controller.perform({ kind: 'dialog', dialogId: controller.dialog.id, decision: 'dismiss' }, context({ actionId: 'dialog-down-dismiss' })); assert.equal(result.dispatch, 'acknowledged', JSON.stringify(result.failure)); assert.equal(controller.heldButtons.size, 0); assert.equal(JSON.parse(await fixture.state()).dialog, false);
    await controller.resumeByUser(context());
    observation = await observe(); const beforeNav = find(observation, 'Paragraph');
    const destination = `${fixture.origin}/destination?private_token=PRIVATE_URL#details`;
    result = await controller.perform({ kind: 'navigate', target: lease.target, url: `${fixture.origin}/redirect` }, context({ actionId: 'navigate' })); assert.equal(result.effect, 'verified', JSON.stringify(result.failure));
    const navEvidence = result.evidence.find(e => e.source === 'lifecycle' && e.facts[0]?.predicate === 'navigation');
    const nav = navEvidence.facts[0].value; assert.equal(nav.urlDigest, controller.urlDigest(destination)); assert.notEqual(nav.urlDigest, nav.requestedUrlDigest); assert.equal(navEvidence.freshness, 'current'); assert.deepEqual(navEvidence.revisionBefore, navEvidence.revisionAfter);
    assert(nav.visibleHeadings.some(h => h.text === 'Synthetic Orders' && h.visible)); assert(!nav.visibleHeadings.some(h => h.text === 'Hidden destination')); assert(!JSON.stringify(result).includes('PRIVATE_URL'));
    const staleNav = await controller.edit(beforeNav, edit('stale'), context({ actionId: 'stale-navigation' })); assert.equal(staleNav.dispatch, 'not_started');
    const afterImage = await fixture.screenshot('after.png');
    const detach = await controller.detachLease(lease, context({ actionId: 'stop' })); assert.equal(detach.detached, true); assert.equal(detach.browserCloseSent, false);
    assert.equal(fixture.chrome.exitCode, null);
    const remaining = await fixture.send('Target.getTargets'); assert(remaining.targetInfos.some(t => t.targetId === fixture.targetId)); assert(remaining.targetInfos.some(t => t.targetId === duplicate.targetId));
    await fs.writeFile(path.join(fixture.directory, 'result.json'), JSON.stringify({ version: connected.browserVersion, beforeImage, editedImage, afterImage, results, detach, events, modelRoundTrips: null, modelMetricProvenance: 'scripted_no_model', hostImpact: { focus: null, cursor: null, clipboard: null, workspace: null, inputLeak: null }, noHostGui: true }, null, 2), { mode: 0o600 });
    console.log(`Synthetic browser artifacts: ${fixture.directory}`);
  } finally { await controller?.detach(context()).catch(() => {}); await fixture.close(); }
});

async function attachedFixture(transport) {
  const fixture = await startFixture();
  const controller = new BrowserController({ transport, policy, fixtureOrigins: [fixture.origin, fixture.crossOrigin] });
  try {
    const ctx = context(); const connected = await controller.connect({ mode: 'chrome_consent', endpoint: fixture.endpoint }, ctx);
    assert.equal(connected.state, 'connected');
    const [choice] = await controller.listForLocalPicker(ctx); const lease = await controller.attach(choice.selectionToken, ctx);
    return { fixture, controller, lease };
  } catch (error) { await controller.detach(context()).catch(() => {}); await fixture.close(); throw error; }
}
class NavigationRaceTransport extends WebSocketTransport {
  constructor() { super(); this.navigationCount = 0; this.lifecycleRejections = 0; }
  async send(method, params, sessionId, ctx) {
    if (method === 'Page.navigate') { this.navigationCount++; this.rejectSummary = true; }
    if (this.rejectSummary && method === 'Runtime.callFunctionOn' && params.functionDeclaration === declarations.summary) {
      this.rejectSummary = false; this.lifecycleRejections++;
      throw new BrowserFailure('cdp_context_gone', 'protocol');
    }
    return super.send(method, params, sessionId, ctx);
  }
}
test('real Chrome modal recovery has related lifecycle proof and never repeats opening input', { skip: process.env.MUSE_BROWSER_REAL !== '1', timeout: 30000 }, async () => {
  const { fixture, controller, lease } = await attachedFixture();
  const proofs = [];
  try {
    await fixture.evaluate("document.getElementById('dialog').onclick=()=>{fixture.dialog=confirm('Synthetic checkpoint');saved.textContent='Dialog decision completed'}");
    for (const decision of ['accept', 'dismiss']) {
      const observation = await controller.observe({ lease, sources: ['dom'] }, context());
      const opening = context({ actionId: `related-open-${decision}` });
      const receipt = await controller.perform({ kind: 'click', ref: find(observation, 'Confirm synthetic'), button: 'left' }, opening);
      assert.equal(receipt.effect, 'unknown'); assert.equal(receipt.failure.code, 'dialog_checkpoint');
      const dialogId = controller.dialog.id;
      const openProof = receipt.evidence.find(e => e.facts.some(f => f.predicate === 'dialog.state'));
      assert.equal(openProof.freshness, 'current'); assert.deepEqual(openProof.target, lease.target);
      assert.deepEqual(openProof.facts[0].value, { dialogId, state: 'open', related: true, relatedTargetId: lease.target.targetId });
      const decisionContext = context({ actionId: `related-decision-${decision}` });
      const closed = await controller.perform({ kind: 'dialog', dialogId, decision }, decisionContext);
      assert.equal(closed.failure, undefined); assert.equal(closed.dispatch, 'acknowledged');
      const closedProof = closed.evidence.find(e => e.facts.some(f => f.predicate === 'dialog.state'));
      assert.equal(closedProof.freshness, 'current'); assert.deepEqual(closedProof.revisionBefore, closed.after); assert.deepEqual(closedProof.revisionAfter, closed.after);
      assert.deepEqual(closedProof.facts[0].value, { dialogId, state: 'closed', related: true, relatedTargetId: lease.target.targetId });
      assert.equal(controller.active.poisoned, false); assert.equal(controller.inflight.size, 0); assert.equal(controller.heldButtons.size, 0);
      assert(closed.observation); assert.equal(JSON.parse(await fixture.state()).dialog, decision === 'accept');
      assert.equal(opening.records.filter(r => r.req.substep === 'mouse_down').length, 1);
      assert.equal(decisionContext.records.filter(r => r.req.primitive === 'Input.dispatchMouseEvent').length, 0);
      assert.equal(await fixture.evaluate('saved.textContent'), 'Dialog decision completed');
      assert.deepEqual(await controller.perform({ kind: 'click', ref: find(observation, 'Confirm synthetic'), button: 'left' }, opening), receipt);
      proofs.push({ decision, opening: receipt, closed });
    }
    await fs.writeFile(path.join(fixture.directory, 'modal-recovery.json'), JSON.stringify(proofs, null, 2), { mode: 0o600 });
    console.log(`Synthetic modal recovery artifacts: ${fixture.directory}`);
  } finally { await controller.detach(context()).catch(() => {}); await fixture.close(); }
});
test('real Chrome navigation replaces stale iframe sessions and retries only lifecycle reads', { skip: process.env.MUSE_BROWSER_REAL !== '1', timeout: 45000 }, async () => {
  const transport = new NavigationRaceTransport(); const { fixture, controller, lease } = await attachedFixture(transport);
  const results = [];
  try {
    for (let sample = 0; sample < 5; sample++) {
      let observation = await controller.observe({ lease, sources: ['dom'] }, context());
      for (const name of ['Paragraph', 'Controlled']) {
        const receipt = await controller.edit(find(observation, name), edit(`Synthetic compound ${sample}`), context({ actionId: `before-navigation-${sample}-${name}` }));
        assert.equal(receipt.effect, 'verified', JSON.stringify(receipt.failure)); observation = receipt.observation;
      }
      const clicked = await controller.perform({ kind: 'click', ref: find(observation, 'Save synthetic'), button: 'left' }, context({ actionId: `before-navigation-${sample}-click` }));
      assert.equal(clicked.dispatch, 'acknowledged'); assert.equal(JSON.parse(await fixture.state()).saved, 1);
      const url = `${fixture.origin}/destination?sample=${sample}`;
      const ctx = context({ actionId: `reconciled-navigation-${sample}` });
      const receipt = await controller.perform({ kind: 'navigate', target: lease.target, url }, ctx);
      assert.equal(receipt.effect, 'verified', JSON.stringify(receipt.failure)); assert.equal(receipt.failure, undefined);
      assert.equal(ctx.records.length, 1); assert.equal(ctx.records[0].req.primitive, 'Page.navigate');
      const proof = receipt.evidence.find(e => e.facts.some(f => f.predicate === 'navigation'));
      assert.equal(proof.freshness, 'current'); assert.equal(proof.facts[0].value.urlDigest, controller.urlDigest(url));
      assert.equal(await fixture.evaluate('document.URL'), url);
      const frameEdit = await controller.edit(find(receipt.observation, 'Cross frame editor'), edit(`Current child ${sample}`), context({ actionId: `current-child-${sample}` }));
      assert.equal(frameEdit.effect, 'verified', JSON.stringify(frameEdit.failure));
      results.push({ sample, effect: receipt.effect, attempts: ctx.records.length, frames: controller.frames.size, childSessions: controller.childSessions.size });
    }
    assert.equal(transport.navigationCount, 5); assert.equal(transport.lifecycleRejections, 5);
    await fs.writeFile(path.join(fixture.directory, 'navigation-reconciliation.json'), JSON.stringify({ results, navigationCount: transport.navigationCount, lifecycleRejections: transport.lifecycleRejections, modelRoundTrips: null, noHostGui: true }, null, 2), { mode: 0o600 });
    console.log(`Synthetic navigation reconciliation artifacts: ${fixture.directory}`);
  } finally { await controller.detach(context()).catch(() => {}); await fixture.close(); }
});
test('real Chrome capture fences reject mixed revisions and focus has exact readback', { skip: process.env.MUSE_BROWSER_REAL !== '1', timeout: 30000 }, async () => {
  const { fixture, controller, lease } = await attachedFixture();
  try {
    await controller.observe({ lease, sources: ['dom'] }, context());
    const original = controller.fn.bind(controller); let changed = false;
    controller.fn = async (frame, name, ...args) => {
      const result = await original(frame, name, ...args);
      if (!changed && name === 'summary' && frame.id === controller.mainFrameId) {
        changed = true; await fixture.evaluate("document.querySelector('h1').textContent='New synthetic heading'");
      }
      return result;
    };
    const mixed = await controller.captureObservation({ lease, sources: ['dom'] }, context());
    assert.equal(mixed.state.evidence[0].freshness, 'unknown'); assert(mixed.state.evidence[0].reasons.includes('crossed_semanticRevision'));
    assert.equal(mixed.refs.elements.length, 0);
    controller.fn = original;
    const fresh = await controller.observe({ lease, sources: ['dom'] }, context());
    assert.equal(fresh.state.evidence[0].freshness, 'current'); assert(fresh.refs.elements.length > 0);
    const paragraph = find(fresh, 'Paragraph');
    const focused = await controller.perform({ kind: 'focus', ref: paragraph }, context({ actionId: 'focus-proof' }));
    assert.equal(focused.effect, 'verified', JSON.stringify(focused.failure));
    const proof = focused.evidence.find(e => e.facts.some(f => f.predicate === 'focused'));
    assert.equal(proof.freshness, 'current'); assert.deepEqual(proof.revisionBefore, proof.revisionAfter);
    assert.deepEqual(proof.facts[0].value, { refId: paragraph.id, focused: true });
    assert.equal(await fixture.evaluate("document.activeElement===document.getElementById('paragraph')"), true);
    await fs.writeFile(path.join(fixture.directory, 'fences.json'), JSON.stringify({ mixed, fresh, focused }, null, 2), { mode: 0o600 });
    console.log(`Synthetic fence artifacts: ${fixture.directory}`);
  } finally { await controller.detach(context()).catch(() => {}); await fixture.close(); }
});
class DroppedReplyTransport extends WebSocketTransport {
  arm() { this.armed = true; this.dropped = new Promise(resolve => { this.didDrop = resolve; }); }
  send(method, params, sessionId, ctx) {
    if (this.armed && method === 'Input.insertText') { this.armed = false; this.dropId = this.sequence + 1; }
    return super.send(method, params, sessionId, ctx);
  }
  receive(data) {
    if (this.dropId && JSON.parse(data).id === this.dropId) { this.lateReply = data; this.dropId = null; this.didDrop(); return; }
    super.receive(data);
  }
}
for (const ending of ['cancel', 'deadline']) test(`real Chrome ${ending} after dropped input reply blocks replay and later dispatch`, { skip: process.env.MUSE_BROWSER_REAL !== '1', timeout: 30000 }, async () => {
  const transport = new DroppedReplyTransport(); const { fixture, controller, lease } = await attachedFixture(transport);
  try {
    const observation = await controller.observe({ lease, sources: ['dom'] }, context()); const ref = find(observation, 'Paragraph');
    const cancelled = new AbortController(); cancelled.abort();
    const untouched = await controller.edit(ref, edit('never input'), context({ actionId: 'already-cancelled', signal: cancelled.signal }));
    assert.equal(untouched.dispatch, 'not_started'); assert.equal(untouched.effect, 'none_proven'); assert.equal(JSON.parse(await fixture.state()).paragraph, '');
    const abort = new AbortController(); const ctx = context({ actionId: `dropped-${ending}`, deadlineMs: ending === 'deadline' ? 1500 : 10000, signal: abort.signal });
    transport.arm(); const text = `Dropped ${ending} 漢🙂`; const op = { kind: 'editText', ref, edit: edit(text) };
    const pending = controller.perform(op, ctx);
    await transport.dropped; assert.equal(JSON.parse(await fixture.state()).paragraph, text);
    if (ending === 'cancel') abort.abort();
    const receipt = await pending;
    assert.equal(receipt.dispatch, 'possible'); assert.equal(receipt.effect, 'unknown');
    assert.equal(receipt.failure.code, ending === 'cancel' ? 'cancelled' : 'cdp_timeout'); assert.equal(ctx.records.length, 2);
    assert.equal(ctx.records[1].ack.state, 'lost'); assert.equal(transport.pending.size, 0);
    const events = JSON.parse(await fixture.state()).events.length;
    transport.receive(transport.lateReply);
    assert.deepEqual(await controller.perform(op, ctx), receipt);
    await assert.rejects(controller.perform({ ...op, edit: edit('changed') }, ctx), { code: 'action_id_collision' });
    const fresh = await controller.observe({ lease, sources: ['dom'] }, context());
    const blocked = await controller.edit(find(fresh, 'Paragraph'), edit('no uncertain replay'), context({ actionId: 'new-id' }));
    assert.equal(blocked.dispatch, 'not_started'); assert.equal(blocked.failure.code, 'quiescence_unknown');
    assert.equal(JSON.parse(await fixture.state()).events.length, events); assert.equal(JSON.parse(await fixture.state()).paragraph, text);
    // An unrelated explicit modal decision cannot clear earlier transport loss.
    const externalModal = fixture.evaluate("confirm('Unrelated synthetic dialog')");
    for (let poll = 0; poll < 100 && !controller.dialog; poll++) await new Promise(resolve => setTimeout(resolve, 5));
    assert(controller.dialog);
    const dialogDecision = await controller.perform({ kind: 'dialog', dialogId: controller.dialog.id, decision: 'dismiss' }, context({ actionId: `unrelated-dialog-${ending}` }));
    assert.equal(dialogDecision.dispatch, 'acknowledged'); assert.equal(await externalModal, false);
    assert.equal(controller.active.poisoned, true); assert.equal(controller.active.unknownPoison, true);
    const unchanged = await controller.observe({ lease, sources: ['dom'] }, context());
    const stillBlocked = await controller.edit(find(unchanged, 'Paragraph'), edit('still no replay'), context({ actionId: `after-dialog-${ending}` }));
    assert.equal(stillBlocked.dispatch, 'not_started'); assert.equal(stillBlocked.failure.code, 'quiescence_unknown');
    assert.equal(JSON.parse(await fixture.state()).events.length, events);
    const quiescence = await controller.quiesce(context()); assert.equal(quiescence.state, 'unknown');
    await fs.writeFile(path.join(fixture.directory, 'dropped-reply.json'), JSON.stringify({ ending, receipt, blocked, quiescence, inputEvents: events, pendingReplies: transport.pending.size }, null, 2), { mode: 0o600 });
    console.log(`Synthetic dropped-reply artifacts: ${fixture.directory}`);
  } finally { await controller.detach(context()).catch(() => {}); await fixture.close(); }
});

test('real Chrome seals exact append/insert/selection expectations before any effect', { skip: process.env.MUSE_BROWSER_REAL !== '1', timeout: 30000 }, async () => {
  const { fixture, controller, lease } = await attachedFixture();
  try {
    let current = 'a'.repeat(8000) + '🙂tail';
    await fixture.evaluate(`paragraph.value=${JSON.stringify(current)};paragraph.dispatchEvent(new Event('input',{bubbles:true}))`);
    const cases = [
      { mode: 'append', text: '漢🙂', start: current.length, end: current.length },
      { mode: 'insert', text: 'insert', start: 5, end: 5 },
      { mode: 'replaceSelection', text: 'replaced', start: 2, end: 9 }
    ];
    const proofs = [];
    for (const item of cases) {
      const observation = await controller.observe({ lease, sources: ['dom'] }, context()); const ref = find(observation, 'Paragraph');
      const ctx = context({ actionId: `expect-${item.mode}` }); const expected = current.slice(0, item.start) + item.text + current.slice(item.end);
      if (item.mode === 'insert') await fixture.evaluate(`paragraph.setSelectionRange(${item.start},${item.end})`);
      const operation = { kind: 'editText', ref, edit: { ...edit(item.text), mode: item.mode, ...(item.mode === 'replaceSelection' ? { selection: { units: 'dom_utf16', start: item.start, end: item.end } } : {}) } };
      let calls = 0;
      ctx.onTextExpectation = async expectation => {
        assert.equal(ctx.records.length, 0); assert.equal(JSON.parse(await fixture.state()).paragraph, current);
        assert.deepEqual(expectation, { refId: ref.id, target: lease.target, revision: ctx.revision, editMode: item.mode, expectedPrivateDigest: controller.privateDigest(expected) });
        calls++; await Promise.resolve(); proofs.push(expectation);
      };
      const receipt = await controller.perform(operation, ctx); assert.equal(receipt.effect, 'verified', JSON.stringify(receipt.failure)); assert.equal(calls, 1);
      assert.equal(JSON.parse(await fixture.state()).paragraph, expected); current = expected;
      const proof = receipt.evidence.find(e => e.facts.some(f => f.predicate === 'text_exact'));
      assert.equal(proof.facts[0].value.actualPrivateDigest, proofs.at(-1).expectedPrivateDigest);
    }
    const observation = await controller.observe({ lease, sources: ['dom'] }, context()); const ctx = context({ actionId: 'expectation-denied' });
    ctx.onTextExpectation = async () => { throw new Error('Synthetic seal rejection'); };
    const blocked = await controller.edit(find(observation, 'Paragraph'), edit('never dispatch'), ctx);
    assert.equal(blocked.dispatch, 'not_started'); assert.equal(blocked.effect, 'none_proven'); assert.equal(ctx.records.length, 0);
    assert.equal(JSON.parse(await fixture.state()).paragraph, current);
    await fs.writeFile(path.join(fixture.directory, 'expectations.json'), JSON.stringify({ proofs, blocked, finalDigest: controller.privateDigest(current), finalScalars: [...current].length }, null, 2), { mode: 0o600 });
    console.log(`Synthetic expectation artifacts: ${fixture.directory}`);
  } finally { await controller.detach(context()).catch(() => {}); await fixture.close(); }
});
