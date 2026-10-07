const test = require('node:test');
const assert = require('node:assert/strict');
const { CaptureCoordinator, Reconciler, RefStore, AssertionRegistry, evidenceHeader, wrapLegacyObservation, evidenceFromTextRead, adapterEvidenceProvider, transformPoint } = require('../../src/computer/state/index.cjs');
const { target, revision, evidence, predicate, context, current, element, transform } = require('./helpers.cjs');

test('G5 current DOM wins over stale AX; refs are quarantined without navigation or dispatch', async () => {
  let actual = current(), nav = 0, dispatch = 0;
  const refs = new RefStore({ getCurrent: () => actual, revalidate: async () => { dispatch++; } });
  const reconcile = new Reconciler({ getCurrent: () => actual, refStore: refs });
  const old = evidence('browser_ax', [['element.ref', { ...element(), source: 'browser_ax' }], ['document.headings', { headings: [{ text: 'Home', visible: true }], complete: true }]]);
  const oldSet = refs.issue(reconcile.reconcile([old]));
  actual = current(target, { ...revision, documentEpoch: 2, semanticRevision: 2 });
  const lifecycle = evidence('lifecycle', [['document.url', 'https://fixture.invalid/orders']], { revisionBefore: actual.revision, revisionAfter: actual.revision });
  const dom = evidence('dom', [['document.heading', { text: 'Your Orders', visible: true }]], { revisionBefore: actual.revision, revisionAfter: actual.revision });
  const p = predicate();
  const state = reconcile.reconcile([lifecycle, dom, old], [p]);
  assert.equal(state.assertions[0].status, 'satisfied');
  assert.ok(state.disagreements[0].reasons.includes('do_not_renavigate'));
  assert.equal(state.evidence.find(e => e.id === old.id).freshness, 'stale');
  assert.ok(!state.allowedRoutes.includes('browser_ax'));
  await assert.rejects(refs.resolve(oldSet.elements[0], context(actual.revision)), { code: 'ref_unknown_or_modified' });
  assert.deepEqual({ nav, dispatch }, { nav: 0, dispatch: 0 });
});

test('unknown native freshness with contradictory old payload becomes suspect; current authoritative conflicts remain unknown', () => {
  const p = predicate(), r = new Reconciler({ getCurrent: () => current() });
  const lifecycle = evidence('lifecycle', [['document.url', p.args.url]]);
  const dom = evidence('dom', [['document.heading', { text: p.args.heading, visible: true }]]);
  const ax = evidence('browser_ax', [['document.headings', { headings: [{ text: 'Home', visible: true }], complete: true }]], { freshness: 'unknown' });
  assert.equal(r.reconcile([lifecycle, dom, ax], [p]).assertions[0].status, 'satisfied');
  assert.equal(r.reconcile([lifecycle, dom, ax], [p]).evidence[2].freshness, 'suspect');
  assert.equal(r.reconcile([lifecycle, dom, { ...ax, freshness: 'current' }], [p]).assertions[0].status, 'unknown');
});

test('old pixels and a fresh incomplete tree cannot prove a destination; truncated and omitted absence is unknown', () => {
  const p = predicate(), r = new Reconciler({ getCurrent: () => current() });
  const lifecycle = evidence('lifecycle', [['document.url', p.args.url]]);
  const pixels = evidence('pixels', [['document.heading', { text: p.args.heading, visible: true }, 'identified_pixels']], { revisionBefore: { ...revision, documentEpoch: 0 }, revisionAfter: { ...revision, documentEpoch: 0 } });
  const incomplete = evidence('dom', [['document.headings', { headings: [], complete: true }]], { coverage: { scope: 'target', complete: false, truncated: true, omittedFrames: [], omissionReasons: ['node_limit'] } });
  assert.equal(r.reconcile([lifecycle, incomplete, pixels], [p]).assertions[0].status, 'unknown');
  const omitted = { ...incomplete, coverage: { ...incomplete.coverage, complete: true, truncated: false, omittedFrames: ['frame-2'] } };
  assert.equal(r.reconcile([lifecycle, omitted], [p]).assertions[0].status, 'unknown');
  const complete = { ...incomplete, coverage: { scope: 'target', complete: true, truncated: false, omittedFrames: [], omissionReasons: [] } };
  assert.equal(r.reconcile([lifecycle, complete], [p]).assertions[0].status, 'unsatisfied');
});

test('positive fact survives unrelated source failure and partial coverage', () => {
  const p = predicate(), r = new Reconciler({ getCurrent: () => current() });
  const dom = evidence('dom', [['document.heading', { text: p.args.heading, visible: true }]], { coverage: { scope: 'visible', complete: false, truncated: true, omittedFrames: ['other-frame'], omissionReasons: ['node_limit'] } });
  const state = r.reconcile([evidence('lifecycle', [['document.url', p.args.url]]), dom, evidence('atspi', [], { acquisition: 'timeout', freshness: 'unknown' })], [p]);
  assert.equal(state.assertions[0].status, 'satisfied');
});

test('crossed generation/document/semantic/geometry fences and wrong targets reject actionable evidence', () => {
  const r = new Reconciler({ getCurrent: () => current() });
  for (const fence of Object.keys(revision)) {
    const e = evidence('pixels', [], { revisionAfter: { ...revision, [fence]: revision[fence] + 1 } });
    assert.equal(r.reconcile([e]).evidence[0].freshness, 'stale', fence);
  }
  const wrong = evidence('dom', [], { target: { ...target, targetId: 'other-tab' } });
  assert.equal(r.reconcile([wrong], [predicate()]).evidence[0].freshness, 'stale');
  assert.ok(r.reconcile([wrong], [predicate()]).evidence[0].reasons.includes('target_mismatch'));
});

test('pending navigation is not committed readiness; old loader evidence is ineligible', () => {
  const p = predicate(), r = new Reconciler({ getCurrent: () => current() });
  const pending = evidence('lifecycle', [['navigation.pending', true], ['document.url', p.args.url]]);
  assert.equal(r.reconcile([pending, evidence('dom', [['document.heading', { text: p.args.heading, visible: true }]])], [p]).assertions[0].status, 'pending');
  const old = { ...pending, revisionBefore: { ...revision, documentEpoch: 0 }, revisionAfter: { ...revision, documentEpoch: 0 } };
  const state = r.reconcile([old, evidence('dom')], [p]);
  assert.equal(state.pendingNavigation, false);
  assert.equal(state.assertions[0].status, 'unknown');
});

test('source authority and correlation never turn DOM URLs or OCR/model votes into lifecycle truth', () => {
  const p = predicate(), r = new Reconciler({ getCurrent: () => current() });
  const dom = evidence('dom', [['document.url', p.args.url], ['document.heading', { text: p.args.heading, visible: true }]]);
  const state = r.reconcile([dom], [p]);
  assert.equal(state.assertions[0].status, 'unknown');
  const life = evidence('lifecycle', [['document.url', 'https://fixture.invalid/home']]);
  assert.equal(r.reconcile([life, dom, dom, dom], [p]).assertions[0].status, 'unsatisfied');
  const pixels = evidence('pixels', [], { freshness: 'stale' });
  const ocr = evidence('ocr', [['document.heading', { text: p.args.heading, visible: true }]], { derivedFrom: [pixels.id] });
  assert.equal(r.reconcile([evidence('lifecycle', [['document.url', p.args.url]]), pixels, ocr], [p]).assertions[0].status, 'unknown');
  const model = evidence('pixels', [['document.heading', { text: p.args.heading, visible: true }, 'model_inferred']]);
  assert.equal(r.reconcile([evidence('lifecycle', [['document.url', p.args.url]]), model], [p]).assertions[0].status, 'unknown');
});

test('capture failure marks prior artifact stale; identical fresh captures have new capture IDs and one blob', async () => {
  let shouldFail = false;
  const c = new CaptureCoordinator({ clockDomain: 'node.performance', readFence: async () => current(), providers: {
    pixels: async () => { if (shouldFail) throw Error('private-error-do-not-serialize'); return { freshness: 'current', artifact: { blobId: 'same-bitmap', provenance: 'tab_composited' }, facts: [] }; },
    dom: async () => ({ freshness: 'current', facts: [], coverage: { scope: 'target', complete: true, truncated: false, omittedFrames: [], omissionReasons: [] } }),
  } });
  const [first] = await c.capture(target, ['pixels'], context());
  const [second] = await c.capture(target, ['pixels'], context());
  assert.equal(first.artifact.blobId, second.artifact.blobId);
  assert.notEqual(first.artifact.captureId, second.artifact.captureId);
  shouldFail = true;
  const [failed, dom] = await c.capture(target, ['pixels', 'dom'], context());
  assert.equal(failed.freshness, 'stale'); assert.equal(failed.artifact.captureId, second.artifact.captureId);
  assert.equal(failed.acquisition, 'error'); assert.deepEqual(failed.facts, []); assert.equal(dom.freshness, 'current');
  assert.ok(!JSON.stringify(failed).includes('private-error'));
});

test('provider interval, target and crossing checks are applied even to freshly stamped replies', async () => {
  let state = current();
  const c = new CaptureCoordinator({ clockDomain: 'node.performance', readFence: async () => state, providers: {
    dom: async () => { state = current(target, { ...revision, semanticRevision: 2 }); return { freshness: 'current', facts: [] }; },
    browser_ax: async () => evidence('browser_ax'),
    atspi: async () => evidence('atspi', [], { target: { ...target, targetId: 'other' } }),
  } });
  const [dom] = await c.capture(target, ['dom'], context());
  assert.equal(dom.freshness, 'stale'); assert.ok(dom.reasons.includes('crossed_semanticRevision'));
  const [ax] = await c.capture(target, ['browser_ax'], context(state.revision));
  assert.equal(ax.freshness, 'stale');
  const [wrong] = await c.capture(target, ['atspi'], context(state.revision));
  assert.equal(wrong.acquisition, 'error'); assert.ok(wrong.reasons.includes('provider_target_mismatch'));
});

test('bounded probe cancels a hanging provider and ignores late current-looking results', async () => {
  let signal, resolve;
  const c = new CaptureCoordinator({ clockDomain: 'node.performance', readFence: async () => current(), providers: {
    dom: async (_target, ctx) => { signal = ctx.signal; return new Promise(done => { resolve = done; }); },
  } });
  await assert.rejects(c.probe(target, ['dom'], context(revision, 25)), error => error.kind === 'deadline');
  assert.equal(signal.aborted, true);
  resolve({ freshness: 'current', facts: [] });
});

test('stable refsets and selective invalidation preserve unrelated refs; no silent same-label replacement', async () => {
  let state = current();
  const e = evidence('dom', [['element.ref', element()], ['element.ref', { ...element(target, revision, 'node-2'), browser: { backendNodeId: 2, objectToken: 'node-2' } }]]);
  let live = null;
  const refs = new RefStore({ getCurrent: () => state, revalidate: async ref => ({ ref: live || ref, revision: state.revision, evidence: [e] }) });
  const r = new Reconciler({ getCurrent: () => state });
  const reconciled = r.reconcile([e]), set = refs.issue(reconciled);
  assert.deepEqual(refs.issue(reconciled), set);
  refs.invalidate({ sessionId: target.sessionId, refIds: [set.elements[0].id] }, 'subtree_dirty');
  await assert.rejects(refs.resolve(set.elements[0], context()), { code: 'ref_unknown_or_modified' });
  await refs.resolve(set.elements[1], context());
  live = { ...set.elements[1], browser: { backendNodeId: 3, objectToken: 'replacement' } };
  await assert.rejects(refs.resolve(set.elements[1], context()), { code: 'live_ref_identity_changed' });
  state = current(target, { ...revision, semanticRevision: 2 });
  await assert.rejects(refs.resolve(set.elements[1], context(state.revision)), { code: 'ref_revision_stale' });
});

test('same URL SPA semantic change rejects old refs; geometry alone preserves semantic refs after live read', async () => {
  let state = current();
  const refs = new RefStore({ getCurrent: () => state, revalidate: async ref => ({ ref, revision: state.revision, evidence: [evidence('dom', [], { revisionBefore: state.revision, revisionAfter: state.revision })] }) });
  const r = new Reconciler({ getCurrent: () => state });
  const ref = refs.issue(r.reconcile([evidence('dom', [['element.ref', element()]])])).elements[0];
  state = current(target, { ...revision, geometryRevision: 2 });
  assert.equal((await refs.resolve(ref, context(state.revision))).revision.geometryRevision, 2);
  state = current(target, { ...revision, semanticRevision: 2 });
  await assert.rejects(refs.resolve(ref, context(state.revision)), { code: 'ref_revision_stale' });
});

test('exact text requires full value and fences; previews and inference cannot satisfy', async () => {
  const registry = new AssertionRegistry(), p = predicate('text.exact', { refId: 'field', value: 'café 日本語 👩🏾‍🚀\n' });
  const value = { refId: 'field', value: p.args.value, complete: true, plainText: true, secret: false };
  assert.equal((await registry.validate(p, [evidence('dom', [['text.value', value]])], context())).status, 'satisfied');
  assert.equal((await registry.validate(p, [evidence('dom', [['text.value', { ...value, complete: false }]])], context())).status, 'unknown');
  assert.equal((await registry.validate(p, [evidence('dom', [['text.value', value, 'model_inferred']])], context())).status, 'unknown');
  const read = { ref: 'field', complete: true, truncated: false, text: p.args.value, revisionBefore: revision, revisionAfter: revision, evidenceId: 'full-read' };
  const e = evidenceFromTextRead(read, { source: 'dom', target, producer: 'owned.full-read', interval: evidence('dom').interval, freshness: 'current' });
  assert.equal((await registry.validate(p, [e], context())).status, 'satisfied');
  const digestP = predicate('text.exact', { refId: 'field', privateDigest: 'private-value-digest' });
  const digestE = evidenceFromTextRead({ ...read, text: undefined, exactMatch: true }, { source: 'dom', target, producer: 'owned.full-read', interval: e.interval, freshness: 'current', expectedPrivateDigest: digestP.args.privateDigest });
  assert.equal((await registry.validate(digestP, [digestE], context())).status, 'satisfied');
});

test('typed state, related dialogs, exact window placement/closure and correlated download status', async () => {
  const registry = new AssertionRegistry();
  const cases = [
    ['element.checked', { refId: 'check', checked: true }, 'dom', { refId: 'check', checked: true }],
    ['element.selected', { refId: 'option', selected: true }, 'dom', { refId: 'option', selected: true }],
    ['element.focused', { refId: 'field', focused: true }, 'dom', { refId: 'field', focused: true }],
    ['dialog.state', { dialogId: 'dialog-1', state: 'closed' }, 'lifecycle', { dialogId: 'dialog-1', state: 'closed', related: true, relatedTargetId: target.targetId }],
    ['window.placement', { workspace: '2', bounds: [1, 2, 300, 200] }, 'window', { targetId: target.targetId, workspace: '2', bounds: [1, 2, 300, 200] }],
    ['window.closed', { closed: true }, 'window', { targetId: target.targetId, closed: true, closureConfirmed: true }],
    ['download.state', { downloadId: 'download-1', state: 'completed', actionId: 'download-action' }, 'lifecycle', { downloadId: 'download-1', state: 'completed', correlation: { targetId: target.targetId, actionId: 'download-action', prearmed: true, guid: 'download-1' } }],
    ['fixture.saved', { key: 'draft', saved: true }, 'dom', { key: 'draft', saved: true, synthetic: true }],
  ];
  for (const [name, args, source, value] of cases) assert.equal((await registry.validate(predicate(name, args), [evidence(source, [[name, value]])], context())).status, 'satisfied', name);
  const download = cases[6];
  assert.equal((await registry.validate(predicate(download[0], download[1]), [evidence('lifecycle', [['download.state', { ...download[3], correlation: { ...download[3].correlation, actionId: 'another' } }]])], context())).status, 'unknown');
  assert.equal((await registry.validate(predicate('dialog.state', { dialogId: 'dialog-1', state: 'open' }), [evidence('dom', [['dialog.state', { dialogId: 'dialog-1', state: 'open', related: false }]])], context())).status, 'unknown');
});

test('registry versions, budgets and inferred producers stay explicit', async () => {
  const registry = new AssertionRegistry(), p = predicate('vision.explained', {});
  registry.register('vision.explained', 1, async p => ({ predicateId: p.id, status: 'satisfied', producer: 'model_inferred', evidenceIds: ['image'], actionIds: [], reasonCodes: ['model_visual_interpretation'] }));
  const image = evidence('pixels', [['model.caption', 'orders', 'model_inferred']], { id: 'image' }); image.facts[0].evidenceIds = ['image'];
  assert.equal((await registry.validate(p, [image], context())).producer, 'model_inferred');
  registry.register('bad.vision', 1, async p => ({ predicateId: p.id, status: 'satisfied', producer: 'deterministic', evidenceIds: ['image'], actionIds: [], reasonCodes: [] }));
  assert.equal((await registry.validate(predicate('bad.vision', {}), [image], context())).status, 'unknown');
  assert.equal((await registry.validate({ ...p, validatorVersion: 2 }, [image], context())).status, 'unknown');
  assert.throws(() => registry.register('vision.explained', 1, () => {}), { code: 'validator_already_registered' });
  registry.register('hanging.read', 1, () => new Promise(() => {}));
  assert.equal((await registry.validate(predicate('hanging.read', {}), [], context(revision, 20))).reasonCodes[0], 'assertion_timeout');
});

test('coordinate transforms are calibrated and reject wrong-window, scale/rotation/scroll changes before dispatch', async () => {
  const window = { sessionId: target.sessionId, kind: 'window', targetId: 'window-1', generation: 1, ownership: 'owned', process: { pid: 123, startToken: 'start-123' }, compositorInstance: 'owned-compositor' };
  let state = current(window), calibration;
  const pixels = evidence('pixels', [], { target: window, artifact: { captureId: 'capture-1', blobId: 'bitmap-1', transformId: 'transform-1', provenance: 'visible_window' } });
  const refs = new RefStore({ getCurrent: () => state, readCalibration: async () => calibration });
  calibration = transform(pixels, window); refs.registerTransform(calibration, pixels);
  const ref = refs.issueCoordinate({ captureId: 'capture-1', transformId: 'transform-1', point: [125, 62.5], space: 'capture_px' });
  assert.deepEqual(refs.point(ref), [1110, 70]);
  await refs.resolve(ref, context());
  await assert.rejects(refs.resolve({ ...ref, target: { ...window, targetId: 'wrong-window' } }, context()), { code: 'coordinate_revision_stale' });
  for (const change of [{ output: { ...calibration.output, scale: 2 } }, { output: { ...calibration.output, rotation: 90 } }, { scroll: [0, 100] }]) {
    const original = calibration; calibration = { ...calibration, ...change };
    await assert.rejects(refs.resolve(ref, context()), { code: 'coordinate_calibration_changed' }); calibration = original;
  }
  state = current(window, { ...revision, geometryRevision: 2 });
  await assert.rejects(refs.resolve(ref, context(state.revision)), { code: 'coordinate_revision_stale' });
  assert.throws(() => refs.registerTransform({ ...calibration, provenance: 'tab_composited' }, pixels), { code: 'coordinate_mapping_unsupported' });
  const rotated = { ...calibration, captureSize: { width: 125, height: 250 }, output: { ...calibration.output, rotation: 90 }, crop: { x: 0, y: 0, width: 125, height: 250 } };
  assert.deepEqual(transformPoint(rotated, { point: [62.5, 125], space: 'capture_px' }), [1110, 70]);
});

test('legacy normalization exposes unknown freshness and preview limits without refs or deterministic success', () => {
  const output = { url: 'https://fixture.invalid/orders', controls: [{ element_number: 1, role: 'textbox', value: 'preview', label: 'field' }], screenshot_id: 'legacy-blob', unchanged: true };
  const e = wrapLegacyObservation(output, { target, revision, interval: evidence('dom').interval });
  assert.equal(e.freshness, 'unknown'); assert.equal(e.coverage.complete, false);
  assert.ok(!e.facts.some(f => f.predicate === 'element.ref'));
  assert.equal(new Reconciler({ getCurrent: () => current() }).reconcile([e], [predicate('text.exact', { refId: 'legacy-1', value: 'preview' })]).assertions[0].status, 'unknown');
  const failed = wrapLegacyObservation({ ...output, capture_status: 'unavailable', image_current: false }, { source: 'pixels', target, revision, interval: e.interval });
  assert.equal(failed.freshness, 'stale'); assert.deepEqual(failed.facts, []);
});

test('actual adapter output shapes compose by source and essential header excludes content', async () => {
  const dom = evidence('dom', [['document.heading', { text: 'PRIVATE-CANARY', visible: true }]]);
  const read = adapterEvidenceProvider(async () => ({ id: 'observation', state: { evidence: [dom] }, refs: { elements: [] } }), 'dom');
  assert.deepEqual(await read(target, context()), dom);
  const state = new Reconciler({ getCurrent: () => current() }).reconcile([dom], [predicate()]);
  const h = evidenceHeader(state);
  assert.equal(h.sources[0].id, dom.id); assert.deepEqual(h.revision, revision);
  assert.ok(h.sources[0].coverage); assert.ok(h.sources[0].interval); assert.ok(h.assertions);
  assert.ok(!JSON.stringify(h).includes('PRIVATE-CANARY'));
  await assert.rejects(adapterEvidenceProvider(async () => ({ evidence: [dom, dom] }), 'dom')(target, context()), { code: 'adapter_source_ambiguous' });
});
