const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const C = require('../../src/computer/contracts.cjs');
const { AssertionRegistry, Reconciler, RefStore, normalizeBrowserEvidence, normalizeDesktopEvidence, normalizeAdapterReceipt, expectationsForOperation } = require('../../src/computer/state/index.cjs');
const { BrowserController } = require('../../src/computer/browser/index.cjs');
const { AccessibilityClient } = require('../../src/computer/desktop/accessibility-client.cjs');
const { target, revision, evidence, predicate, context, current, element } = require('./helpers.cjs');

function browserEmitter() {
  const browser = new BrowserController();
  browser.active = { lease: { target, grantGeneration: 1 } };
  browser.epoch = 1; browser.documentEpoch = 1; browser.semanticRevision = 1; browser.geometryRevision = 1;
  return browser;
}
function edit(ref, text) { return { kind: 'editText', ref, edit: { mode: 'replace', text, semantics: 'plain_text', newlinePolicy: 'literal_multiline', clipboard: 'forbid' } }; }

test('actual browser evidence emitter: observations/checked state and ref capabilities normalize without source/timing changes', async () => {
  const browser = browserEmitter(), registry = new AssertionRegistry(), ref = element();
  const raw = browser.evidence('dom', context(), performance.now(), [
    { predicate: 'document', suitability: 'dom_state', value: { currentUrl: 'https://fixture.invalid/orders', headings: ['Your Orders', 'Hidden'], readyState: 'complete' } },
    { predicate: 'elements', suitability: 'semantic_query', value: [{ refId: ref.id, role: 'heading', name: 'Your Orders', states: { visible: true } }, { refId: 'check-1', role: 'checkbox', name: 'checked field', states: { visible: true, checked: true }, valuePreview: 'short' }] },
  ]);
  const normalized = normalizeBrowserEvidence(raw, { refs: [ref] });
  for (const key of ['id', 'target', 'interval', 'revisionBefore', 'revisionAfter', 'derivedFrom', 'coverage', 'freshness', 'producer']) assert.deepEqual(normalized[key], raw[key], key);
  assert.ok(normalized.facts.some(f => f.predicate === 'element.ref'));
  assert.equal((await registry.validate(predicate('element.checked', { refId: 'check-1', checked: true }), [normalized], context())).status, 'satisfied');
  assert.equal((await registry.validate(predicate('text.exact', { refId: 'check-1', value: 'short' }), [normalized], context())).status, 'unknown');
  assert.equal((await registry.validate(predicate('navigation.destination', { heading: 'Hidden' }), [normalized], context())).status, 'unknown');
  assert.equal((await registry.validate(predicate('navigation.destination', { heading: 'Your Orders' }), [normalized], context())).status, 'satisfied');
  const r = new Reconciler({ getCurrent: () => current() });
  const store = new RefStore({ getCurrent: () => current(), revalidate: async canonical => ({ ref: canonical, revision, evidence: [normalized] }) });
  const issued = store.issue(r.reconcile([normalized]));
  assert.deepEqual((await store.resolve(issued.elements[0], context())).ref, ref);
});

test('browser text_exact proves bound replacement/full digest, never acknowledgment or a different requested value', async () => {
  const browser = browserEmitter(), registry = new AssertionRegistry(), ref = element();
  const text = ('café 日本語 👩🏾‍🚀 e\u0301\n').repeat(180);
  const v = { refId: ref.id, complete: true, exactMatch: true, totalScalars: [...text].length, totalUtf16Units: text.length, totalUtf8Bytes: Buffer.byteLength(text), serverPersistenceVerified: false };
  const raw = browser.evidence('dom', context(), performance.now(), [{ predicate: 'text_exact', suitability: 'full_text_readback', value: v }]);
  const receipt = { target, before: revision, after: revision, dispatch: 'acknowledged', effect: 'verified', evidence: [raw] };
  const normalized = normalizeAdapterReceipt(receipt, { operation: edit(ref, text) });
  assert.equal((await registry.validate(predicate('text.exact', { refId: ref.id, value: text }), normalized.evidence, context())).status, 'satisfied');
  assert.equal((await registry.validate(predicate('text.exact', { refId: ref.id, value: 'a different value' }), normalized.evidence, context())).status, 'unknown');
  assert.equal((await registry.validate(predicate('text.exact', { refId: ref.id, value: text }), normalizeAdapterReceipt({ ...receipt, evidence: [] }, { operation: edit(ref, text) }).evidence, context())).status, 'unknown');
  const bad = { ...raw, facts: raw.facts.map(f => ({ ...f, value: { ...f.value, exactMatch: false } })) };
  assert.equal((await registry.validate(predicate('text.exact', { refId: ref.id, value: text }), normalizeAdapterReceipt({ ...receipt, evidence: [bad] }, { operation: edit(ref, text) }).evidence, context())).status, 'unsatisfied');
  const digest = { ...raw, facts: raw.facts.map(f => ({ ...f, value: { ...f.value, expectedPrivateDigest: 'expected-hmac', actualPrivateDigest: 'expected-hmac' } })) };
  assert.equal((await registry.validate(predicate('text.exact', { refId: ref.id, privateDigest: 'expected-hmac' }), normalizeBrowserEvidence(digest).facts.length ? [normalizeBrowserEvidence(digest)] : [], context())).status, 'satisfied');
  const inferred = { ...raw, facts: raw.facts.map(f => ({ ...f, suitability: 'model_inferred' })) };
  assert.equal((await registry.validate(predicate('text.exact', { refId: ref.id, value: text }), normalizeAdapterReceipt({ ...receipt, evidence: [inferred] }, { operation: edit(ref, text) }).evidence, context())).status, 'unknown');
});

test('navigation exact URL needs lifecycle read and visible heading; sanitized URL and string summary never gain authority', async () => {
  const browser = browserEmitter(), registry = new AssertionRegistry(), url = 'https://fixture.invalid/orders?filter=active';
  const raw = browser.evidence('lifecycle', context(), performance.now(), [{ predicate: 'navigation', suitability: 'navigation_state', value: { currentUrl: 'https://fixture.invalid/orders', requestedUrl: url, headings: ['Your Orders'], documentReady: true } }]);
  const p = predicate('navigation.destination', { url, heading: 'Your Orders' });
  assert.equal((await registry.validate(p, [normalizeBrowserEvidence(raw)], context())).status, 'unknown');
  const withAuthority = { ...raw, facts: raw.facts.map(f => ({ ...f, value: { ...f.value, currentUrlExact: url, visibleHeadings: [{ text: 'Your Orders', visible: true }] } })) };
  assert.equal((await registry.validate(p, [normalizeBrowserEvidence(withAuthority)], context())).status, 'satisfied');
  assert.equal((await registry.validate({ ...p, args: { ...p.args, url: 'https://fixture.invalid/orders' } }, [normalizeBrowserEvidence(withAuthority)], context())).status, 'unsatisfied');
});

test('actual AccessibilityClient full read contract normalizes a 6000+ scalar value and private digest', async () => {
  const text = ('日本語 café 👩🏾‍🚀 e\u0301\n').repeat(430), window = { ...target, kind: 'window', process: { pid: 456, startToken: 'fixture-start' } };
  const ctx = { ...context(), progress: { check() {}, remainingMs: () => 2000 } };
  const native = { busUniqueName: ':1.25', objectPath: '/org/a11y/fixture/field', rootHandle: 'root-1', ownerStartToken: 'fixture-start', roleCode: 77, role: 'entry', name: 'Field', capabilities: ['editText'], handle: 'native-capability' };
  const client = new AccessibilityClient({ channel: { generation: 1,
    start: async () => ({ state: 'ready' }),
    request: async (command, args) => {
      assert.equal(command, 'readText');
      const scalars = [...text], end = Math.min(args.offset + args.limitScalars, scalars.length);
      return { start: args.offset, end, text: scalars.slice(args.offset, end).join(''), totalScalars: scalars.length, totalUtf8Bytes: Buffer.byteLength(text), privateReadHash: createHash('sha256').update(text).digest('hex') };
    } } });
  await client.start({ id: target.sessionId, state: 'ready', generation: 1, mode: 'isolated_desktop' }, ctx);
  const ref = client.issue(native, window, ctx, 'worker-set');
  const expected = client.digest(text), read = await client.readText(ref, { mode: 'verify', expectedPrivateDigest: expected }, ctx);
  assert.ok(read.totalScalars > 6000); assert.equal(read.text, undefined);
  const page = await client.readText(ref, { mode: 'page', limitScalars: 32 }, ctx);
  assert.equal(page.text, [...text].slice(0, 32).join(''));
  assert.equal(page.truncated, true);
  const normalized = normalizeAdapterReceipt({ target: window, effect: 'unknown', dispatch: 'acknowledged', evidence: [read.evidence] }, { operation: edit(ref, text), textRead: read, expectedPrivateDigest: expected });
  const p = predicate('text.exact', { refId: ref.id, privateDigest: expected }, window), registry = new AssertionRegistry();
  assert.equal((await registry.validate(p, normalized.evidence, ctx)).status, 'satisfied');
  assert.equal((await registry.validate({ ...p, args: { refId: ref.id, privateDigest: 'wrong-digest' } }, normalized.evidence, ctx)).status, 'unsatisfied');
  assert.deepEqual(normalized.evidence[0].interval, read.evidence.interval);
  const preview = await client.readText(ref, { mode: 'preview', limitScalars: 1000 }, ctx);
  const previewEv = normalizeAdapterReceipt({ target: window, evidence: [preview.evidence] }, { textRead: preview });
  // Full-digest evidence from internal verification remains valid; the preview itself is not exact text.
  assert.equal((await registry.validate(predicate('text.exact', { refId: ref.id, value: text }, window), previewEv.evidence, ctx)).status, 'unknown');
  const movedRead = { ...read, revisionAfter: { ...read.revisionAfter, documentEpoch: 2 } };
  assert.throws(() => normalizeAdapterReceipt({ target: window, evidence: [read.evidence] }, { textRead: movedRead }), { code: 'readback_metadata_mismatch' });
});

test('nativeElement state normalization and renewed-ref readback retain identity and reject preview-only success', async () => {
  const registry = new AssertionRegistry(), window = { ...target, kind: 'window', process: { pid: 789, startToken: 'native-start' } };
  const original = { id: 'original-native', refSetId: 'native-set', source: 'atspi', target: window, revision,
    native: { busUniqueName: ':1.8', objectPath: '/fixture/entry', rootHandle: 'root', workerGeneration: 1, ownerStartToken: 'native-start' }, identity: { role: 'entry', semanticFingerprint: 'entry-identity' }, capabilities: ['editText'] };
  const renewed = { ...original, id: 'renewed-native' };
  const raw = evidence('atspi', [], { target: window });
  raw.facts = [{ kind: 'nativeElement', ref: original, role: 'entry', name: 'Field', states: ['editable', 'visible', 'showing', 'focused'] }];
  const normalized = normalizeDesktopEvidence(raw);
  assert.equal((await registry.validate(predicate('element.focused', { refId: original.id, focused: true }, window), [normalized], context())).status, 'satisfied');
  const text = 'exact native replacement';
  const full = evidence('atspi', [], { target: window });
  full.facts = [{ kind: 'plainText', refId: renewed.id, privateDigest: 'read-digest', scalarCount: [...text].length, complete: true }];
  const readback = { ref: renewed.id, evidenceId: full.id, complete: true, truncated: false, exactMatch: true, digestRef: 'read-digest', totalScalars: [...text].length, totalUtf8Bytes: Buffer.byteLength(text), revisionBefore: revision, revisionAfter: revision };
  const receipt = normalizeAdapterReceipt({ evidence: [full], readback, renewedRef: renewed, dispatch: 'acknowledged', effect: 'unknown' }, { operation: edit(original, text) });
  assert.equal((await registry.validate(predicate('text.exact', { refId: original.id, value: text }, window), receipt.evidence, context())).status, 'satisfied');
  const wrong = normalizeAdapterReceipt({ evidence: [full], readback, renewedRef: { ...renewed, native: { ...renewed.native, objectPath: '/replacement' } } }, { operation: edit(original, text) });
  assert.equal((await registry.validate(predicate('text.exact', { refId: original.id, value: text }, window), wrong.evidence, context())).status, 'unknown');
  const changedIdentity = normalizeAdapterReceipt({ evidence: [full], readback, renewedRef: { ...renewed, identity: { ...renewed.identity, semanticFingerprint: 'replacement-identity' } } }, { operation: edit(original, text) });
  assert.equal((await registry.validate(predicate('text.exact', { refId: original.id, value: text }, window), changedIdentity.evidence, context())).status, 'unknown');
});

test('verification keeps full receipt evidence when a cheap current probe only returns previews', async () => {
  const e = evidence('dom', [['text.value', { refId: 'field', value: 'full value', complete: true, plainText: true, secret: false }]]);
  const r = new Reconciler({ getCurrent: () => current(), captureCoordinator: { capture: async () => [evidence('dom', [['text.value', { refId: 'field', value: 'full', complete: false, plainText: true, secret: false }, 'preview']])] } });
  const answer = await r.verify({ target, evidence: [e] }, [predicate('text.exact', { refId: 'field', value: 'full value' })], context());
  assert.equal(answer[0].status, 'satisfied'); assert.ok(answer[0].evidenceIds.includes(e.id));
});

test('private navigation uses actual lifecycle URL digest and visible headings without publishing the URL', async () => {
  const browser = browserEmitter(), registry = new AssertionRegistry();
  const url = 'https://fixture.invalid/orders?synthetic=private#detail';
  const expected = expectationsForOperation({ kind: 'navigate', target, url }, { heading: 'Your Orders', urlDigest: browser.urlDigest(url) })[0];
  const raw = browser.evidence('lifecycle', context(), performance.now(), [{ predicate: 'navigation', suitability: 'navigation_state', value: {
    requestedUrlDigest: browser.urlDigest(url), urlDigest: browser.urlDigest(url), visibleHeadings: [{ text: 'Your Orders', visible: true }], documentReady: true,
  } }]);
  const normalized = normalizeBrowserEvidence(raw);
  assert.equal((await registry.validate(expected, [normalized], context())).status, 'satisfied');
  assert.equal((await registry.validate({ ...expected, args: { ...expected.args, urlDigest: browser.urlDigest(`${url}-different`) } }, [normalized], context())).status, 'unsatisfied');
  assert.equal((await registry.validate(expected, [normalizeBrowserEvidence({ ...raw, source: 'dom' })], context())).status, 'unknown');
  const requestedOnly = { ...raw, facts: raw.facts.map(f => ({ ...f, value: { ...f.value, urlDigest: undefined } })) };
  assert.equal((await registry.validate(expected, [normalizeBrowserEvidence(requestedOnly)], context())).status, 'unknown');
  const hidden = { ...raw, facts: raw.facts.map(f => ({ ...f, value: { ...f.value, visibleHeadings: [{ text: 'Your Orders', visible: false }] } })) };
  assert.equal((await registry.validate(expected, [normalizeBrowserEvidence(hidden)], context())).status, 'unknown');
  assert.ok(!JSON.stringify([expected, normalized]).includes(url));
  assert.deepEqual(normalized.interval, raw.interval);
});

test('expectations are generated before dispatch; actual digests prove full Unicode values and correlated mismatches', async () => {
  const client = new AccessibilityClient(), registry = new AssertionRegistry(), browser = browserEmitter(), ref = element();
  const text = '日本語 e\u0301 👩🏾‍🚀\n'.repeat(100), operation = edit(ref, text);
  const privateDigest = value => client.digest(value);
  const expected = expectationsForOperation(operation, { privateDigest })[0];
  const raw = browser.evidence('dom', context(), performance.now(), [{ predicate: 'text_exact', suitability: 'full_text_readback', value: {
    refId: ref.id, expectedPrivateDigest: privateDigest(text), actualPrivateDigest: privateDigest(text), exactMatch: true, complete: true,
    totalScalars: [...text].length, totalUtf16Units: text.length, totalUtf8Bytes: Buffer.byteLength(text), serverPersistenceVerified: false,
  } }]);
  const receipt = normalizeAdapterReceipt({ target, evidence: [raw] });
  assert.equal((await registry.validate(expected, receipt.evidence, context())).status, 'satisfied');
  assert.equal((await registry.validate(expected, [], context())).status, 'unknown');
  assert.ok(!JSON.stringify(expected).includes(text));
  const wrong = { ...raw, facts: raw.facts.map(f => ({ ...f, value: { ...f.value, actualPrivateDigest: privateDigest('short wrong text'), exactMatch: false, totalScalars: 16, totalUtf16Units: 16, totalUtf8Bytes: 16 } })) };
  const mismatch = normalizeAdapterReceipt({ target, evidence: [wrong] }, { operation, privateDigest });
  assert.equal((await registry.validate(expected, mismatch.evidence, context())).status, 'unsatisfied');
  assert.equal((await registry.validate(expectationsForOperation(operation)[0], mismatch.evidence, context())).status, 'unsatisfied');
  const differentExpectation = normalizeAdapterReceipt({ target, evidence: [raw] }, { operation: edit(ref, 'other text'), privateDigest });
  assert.equal((await registry.validate(expectationsForOperation(edit(ref, 'other text'))[0], differentExpectation.evidence, context())).status, 'unknown');
  const checked = { kind: 'setChecked', ref, checked: true };
  assert.equal(expectationsForOperation(checked)[0].validator, 'element.checked');
  assert.equal(expectationsForOperation({ kind: 'focus', ref })[0].validator, 'element.focused');
  assert.deepEqual(expectationsForOperation({ kind: 'click', ref, button: 'left' }), []);
  assert.deepEqual(expectationsForOperation({ ...operation, edit: { ...operation.edit, mode: 'append' } }), []);
  assert.deepEqual(expectationsForOperation({ kind: 'navigate', target, url: 'https://fixture.invalid' }), []);
});

test('readback metadata conflicts cannot borrow origin freshness or proof for another ref', async () => {
  const ref = element(), registry = new AssertionRegistry();
  const raw = evidence('dom'), text = 'full text';
  const read = { ref: ref.id, requestRefId: ref.id, source: 'dom', interval: raw.interval, evidenceId: raw.id,
    revisionBefore: revision, revisionAfter: revision, complete: true, truncated: false, text };
  for (const changed of [{ source: 'atspi' }, { interval: { ...raw.interval, startMonoMs: raw.interval.startMonoMs - 1 } }, { requestRefId: 'other-ref' }]) {
    assert.throws(() => normalizeAdapterReceipt({ target, evidence: [raw], readback: { ...read, ...changed } }, { operation: edit(ref, text) }), /readback_(metadata_mismatch|operation_ref_mismatch)/);
  }
  const noOrigin = normalizeAdapterReceipt({ target, evidence: [], readback: read }, { operation: edit(ref, text), producer: 'test.read', freshness: 'current' });
  assert.equal(noOrigin.evidence[0].freshness, 'unknown');
  assert.equal((await registry.validate(expectationsForOperation(edit(ref, text))[0], noOrigin.evidence, context())).status, 'unknown');
});

test('receipt proof and fresh evidence remain together; current conflict or newer fence keeps truth unknown', async () => {
  const e = evidence('dom', [['text.value', { refId: 'field', privateDigest: 'correct-hmac', actualDigest: true, complete: true, plainText: true, secret: false }, 'complete_value']]);
  const p = predicate('text.exact', { refId: 'field', privateDigest: 'correct-hmac' });
  let actual = current();
  let captured = evidence('dom', [['text.value', { refId: 'field', value: 'preview', complete: false, plainText: true, secret: false }, 'preview']]);
  const r = new Reconciler({ getCurrent: () => actual, captureCoordinator: { capture: async () => [captured] } });
  assert.equal((await r.verify({ target, evidence: [e] }, [p], context()))[0].status, 'satisfied');
  captured = evidence('dom', [['text.value', { refId: 'field', privateDigest: 'wrong-hmac', actualDigest: true, complete: true, plainText: true, secret: false }, 'complete_value']]);
  assert.equal((await r.verify({ target, evidence: [e] }, [p], context()))[0].status, 'unknown');
  actual = current(target, { ...revision, semanticRevision: 2 });
  captured = evidence('dom', [], { revisionBefore: actual.revision, revisionAfter: actual.revision });
  assert.equal((await r.verify({ target, evidence: [e] }, [p], context(actual.revision)))[0].status, 'unknown');
});

test('requested URL never proves actual destination; current URL digest disagreement remains unknown', async () => {
  const browser = browserEmitter(), registry = new AssertionRegistry();
  const requested = 'https://fixture.invalid/orders?state=active', actual = 'https://fixture.invalid/orders?state=archived';
  const p = expectationsForOperation({ kind: 'navigate', target, url: requested }, { heading: 'Your Orders', urlDigest: browser.urlDigest(requested) })[0];
  const raw = browser.evidence('lifecycle', context(), performance.now(), [{ predicate: 'navigation', suitability: 'navigation_state', value: {
    requestedUrlDigest: browser.urlDigest(requested), urlDigest: browser.urlDigest(actual), visibleHeadings: [{ text: 'Your Orders', visible: true }],
  } }]);
  const wrong = normalizeBrowserEvidence(raw);
  assert.equal((await registry.validate(p, [wrong], context())).status, 'unsatisfied');
  const correct = normalizeBrowserEvidence({ ...raw, id: 'correct-url-read', facts: raw.facts.map(f => ({ ...f, value: { ...f.value, urlDigest: browser.urlDigest(requested) } })) });
  const r = new Reconciler({ getCurrent: () => current(), captureCoordinator: { capture: async () => [wrong] } });
  const answer = (await r.verify({ target, evidence: [correct] }, [p], context()))[0];
  assert.equal(answer.status, 'unknown');
  assert.ok(answer.reasonCodes.includes('authoritative_conflict'));
  assert.ok(!JSON.stringify([p, wrong, answer]).includes(requested));
  const unkeyed = createHash('sha256').update(requested).digest('hex');
  assert.equal((await registry.validate({ ...p, args: { ...p.args, urlDigest: unkeyed } }, [correct], context())).status, 'unsatisfied');
});

test('same-length replacement and another digest key cannot borrow a complete readback', async () => {
  const browser = browserEmitter(), registry = new AssertionRegistry(), ref = element();
  const client = new AccessibilityClient(), other = new AccessibilityClient();
  const digester = value => client.digest(value), original = edit(ref, '日本語 👩'), changed = edit(ref, '日本語 👨');
  const raw = browser.evidence('dom', context(), performance.now(), [{ predicate: 'text_exact', suitability: 'full_text_readback', value: {
    refId: ref.id, complete: true, exactMatch: true, expectedPrivateDigest: digester(original.edit.text), actualPrivateDigest: digester(original.edit.text),
    totalScalars: [...original.edit.text].length, totalUtf16Units: original.edit.text.length, totalUtf8Bytes: Buffer.byteLength(original.edit.text),
  } }]);
  const n = normalizeAdapterReceipt({ target, evidence: [raw] }, { operation: changed, privateDigest: digester });
  assert.equal((await registry.validate(expectationsForOperation(changed)[0], n.evidence, context())).status, 'unknown');
  assert.equal((await registry.validate(expectationsForOperation(changed, { privateDigest: digester })[0], n.evidence, context())).status, 'unsatisfied');
  assert.equal((await registry.validate(expectationsForOperation(original, { privateDigest: value => other.digest(value) })[0], n.evidence, context())).status, 'unsatisfied');
  assert.equal((await registry.validate(expectationsForOperation(original, { privateDigest: digester })[0], n.evidence, context())).status, 'satisfied');
});

test('append/insert/selection expectations require a trusted full pre-effect final digest', async () => {
  const client = new AccessibilityClient(), registry = new AssertionRegistry(), ref = element();
  const before = '日本語 👩🏾‍🚀 e\u0301\n'.repeat(600);
  for (const mode of ['append', 'insert', 'replaceSelection']) {
    const operation = { ...edit(ref, '追加'), edit: { ...edit(ref, '追加').edit, mode } };
    const operationBefore = structuredClone(operation);
    const expected = mode === 'append' ? before + operation.edit.text : mode === 'insert' ? operation.edit.text + before : operation.edit.text + [...before].slice(2).join('');
    const digest = client.digest(expected);
    assert.deepEqual(expectationsForOperation(operation, { privateDigest: value => client.digest(value) }), []);
    const p = expectationsForOperation(operation, { expectedFinalPrivateDigest: digest })[0];
    assert.deepEqual(operation, operationBefore);
    const raw = evidence('dom', [['text_exact', { refId: ref.id, expectedPrivateDigest: digest, actualPrivateDigest: digest, exactMatch: true, complete: true }, 'full_text_readback']]);
    const n = normalizeAdapterReceipt({ target, evidence: [raw] }, { operation, privateDigest: value => client.digest(value) });
    assert.equal((await registry.validate(p, [], context())).status, 'unknown');
    assert.equal((await registry.validate(p, n.evidence, context())).status, 'satisfied');
    assert.equal((await registry.validate(expectationsForOperation(edit(ref, operation.edit.text))[0], n.evidence, context())).status, 'unknown');
    assert.equal((await registry.validate({ ...p, args: { ...p.args, privateDigest: client.digest('wrong final') } }, n.evidence, context())).status, 'unsatisfied');
    assert.ok(!JSON.stringify(p).includes(expected));
    const incomplete = normalizeBrowserEvidence({ ...raw, facts: raw.facts.map(f => ({ ...f, value: { ...f.value, complete: false } })) });
    assert.equal((await registry.validate(p, [incomplete], context())).status, 'unknown');
  }
  assert.throws(() => expectationsForOperation({ ...edit(ref, 'a'), edit: { ...edit(ref, 'a').edit, mode: 'append' } }, { expectedFinalPrivateDigest: '' }), { code: 'invalid_id' });
});

test('focus readback and window expectations stay typed; targetless operations do not invent predicates', async () => {
  const ref = element(), registry = new AssertionRegistry();
  const op = { kind: 'focus', ref }, p = expectationsForOperation(op)[0];
  const focused = normalizeBrowserEvidence(evidence('dom', [['focused', { refId: ref.id, focused: true }, 'exact_state']]));
  assert.equal((await registry.validate(p, [focused], context())).status, 'satisfied');
  const blurred = normalizeBrowserEvidence(evidence('dom', [['elements', [{ refId: ref.id, role: 'textbox', states: { focused: false } }], 'semantic_query']]));
  assert.equal((await registry.validate(p, [blurred], context())).status, 'unsatisfied');
  assert.equal((await registry.validate(p, [focused, blurred], context())).status, 'unknown');
  const window = { ...target, kind: 'window' };
  const close = expectationsForOperation({ kind: 'closeWindow', target: window })[0];
  const unconfirmed = evidence('window', [['window.closed', { targetId: window.targetId, closed: true, closureConfirmed: false }]], { target: window });
  assert.equal((await registry.validate(close, [normalizeDesktopEvidence(unconfirmed)], context())).status, 'unknown');
  assert.equal(expectationsForOperation({ kind: 'moveWindow', target: window, workspace: '2', follow: false })[0].validator, 'window.placement');
  for (const operation of [{ kind: 'dialog', dialogId: 'dialog', decision: 'dismiss' }, { kind: 'downloadStatus', downloadId: 'download' }, { kind: 'compositorShortcut', sessionId: target.sessionId, configuredBindingId: 'binding' }]) assert.deepEqual(expectationsForOperation(operation), []);
});

test('normalizers emit frozen-contract facts from digest-only navigation and preserve bounded acquired provenance', () => {
  const browser = browserEmitter();
  const raw = browser.evidence('lifecycle', context(), performance.now(), [{ predicate: 'navigation', suitability: 'navigation_state', value: {
    urlDigest: browser.urlDigest('https://fixture.invalid/orders'), visibleHeadings: [{ text: 'Your Orders', visible: true }],
  } }]);
  raw.facts.push({ predicate: 'navigation.pending', value: false, suitability: 'authoritative' });
  raw.facts.push({ predicate: 'adapter.summary', value: { present: true, unavailable: undefined }, suitability: 'semantic_summary', evidenceIds: [], diagnosticOnly: true });
  raw.facts.push({ predicate: 'adapter.linked', value: null, suitability: 'unavailable', evidenceIds: ['prior-acquisition'] });
  const normalized = normalizeBrowserEvidence(raw);
  C.validateEvidence(normalized);
  assert.ok(!normalized.facts.some(f => f.value === undefined || f.predicate === 'document.url.redacted'));
  for (const name of ['navigation.pending', 'adapter.summary']) assert.deepEqual(normalized.facts.find(f => f.predicate === name).evidenceIds, [raw.id]);
  assert.deepEqual(normalized.facts.find(f => f.predicate === 'adapter.summary').value, { present: true });
  assert.deepEqual(normalized.facts.find(f => f.predicate === 'adapter.linked').evidenceIds, ['prior-acquisition']);
  const receipt = normalizeAdapterReceipt({ target, before: revision, after: revision, dispatch: 'acknowledged', effect: 'unknown',
    attempts: [], evidence: [raw], timings: { clockDomain: 'node.performance', startMonoMs: raw.interval.startMonoMs, endMonoMs: raw.interval.endMonoMs, totalMs: raw.interval.endMonoMs - raw.interval.startMonoMs, phases: {} } });
  C.validateAdapterReceipt(receipt);
  assert.deepEqual(receipt.evidence[0], normalized);
  const native = normalizeDesktopEvidence(evidence('atspi', [], { target: { ...target, kind: 'window' } , facts: [
    { kind: 'plainText', refId: 'native-field', privateDigest: 'native-hmac', complete: true, expectedPrivateDigest: undefined, exactMatch: undefined },
  ] }));
  C.validateEvidence(native);
  const p = expectationsForOperation({ ...edit(element(), 'append'), edit: { ...edit(element(), 'append').edit, mode: 'append' } }, { expectedFinalPrivateDigest: 'hmac-final' })[0];
  C.validatePredicate(p);
});
