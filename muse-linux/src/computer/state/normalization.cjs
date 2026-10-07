const { clone, id, assertId, assertEvidence, assertTarget, assertRevision, changedFences, sameTarget, isDeepStrictEqual, fail } = require('./evidence.cjs');
const C = require('../contracts.cjs');

// Omitted provider fields remain absent. They never become positive facts.
function jsonProjection(value) {
  if (Array.isArray(value)) return value.map(item => item === undefined ? null : jsonProjection(item));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).map(([key, item]) => [key, jsonProjection(item)]));
  return value;
}
function normalizedEvidence(e) {
  const result = jsonProjection(e);
  assertEvidence(result); C.validateEvidence(result);
  return result;
}

// The wrapper preserves legacy preview limits. Ordinals are never promoted to refs.
function wrapLegacyObservation(observation, { target, revision, source = target?.kind === 'tab' ? 'dom' : 'atspi', interval, makeId = id } = {}) {
  assertTarget(target); assertRevision(revision);
  if (!['dom', 'atspi', 'window', 'pixels'].includes(source) || !interval) throw fail('legacy_normalization_context_required', 'invalid_request');
  const evidenceId = makeId('evidence'), facts = [];
  const emit = (predicate, value, suitability = 'preview') => facts.push({ predicate, value, suitability, evidenceIds: [evidenceId] });
  if (source === 'dom' && typeof observation.url === 'string') emit('document.url', observation.url);
  if (source === 'dom' || source === 'atspi') for (const control of (observation.controls || []).slice(0, 2000)) {
    if (control.type === 'password' || control.secret === true) continue;
    emit('legacy.control', { number: control.element_number, role: control.role, label: String(control.label || '').slice(0, 256) });
    if (typeof control.value === 'string') emit('text.value', { refId: `legacy-${control.element_number}`, value: control.value, complete: false, plainText: true, secret: false });
  }
  if (source === 'window') emit('window.placement', { targetId: target.targetId, workspace: observation.workspace, bounds: observation.bounds });
  const failed = source === 'pixels' && (observation.capture_status === 'unavailable' || observation.image_current === false)
    || source === 'atspi' && observation.accessibility_available === false;
  const blob = source === 'pixels' && (observation.screenshot_id || observation.previous_screenshot_id);
  return assertEvidence({ id: evidenceId, source, producer: 'legacy.observation', target: clone(target), revisionBefore: clone(revision), revisionAfter: clone(revision), interval: clone(interval),
    acquisition: failed ? 'error' : 'ok', freshness: failed && blob ? 'stale' : 'unknown', reasons: ['legacy_freshness_unestablished', 'legacy_interval_unavailable', ...(failed ? ['legacy_source_unavailable'] : [])],
    coverage: { scope: 'legacy_preview', complete: false, truncated: observation.truncated === true || (source === 'dom' || source === 'atspi'), omittedFrames: [], omissionReasons: ['legacy_coverage_unestablished'] },
    facts: failed ? [] : facts, derivedFrom: [],
    ...(blob ? { artifact: { captureId: makeId('legacy-capture'), blobId: String(blob), provenance: target.kind === 'tab' ? 'tab_composited' : 'visible_window' } } : {}) });
}

// Compose a complete read receipt with its provider's actual acquisition interval.
function evidenceFromTextRead(read, { target, source, interval, producer, expectedPrivateDigest, freshness = 'unknown' } = {}) {
  assertTarget(target); assertRevision(read.revisionBefore); assertRevision(read.revisionAfter);
  if (!['dom', 'atspi'].includes(source) || !interval || !producer) throw fail('text_read_evidence_context_required', 'invalid_request');
  const crossed = changedFences(read.revisionBefore, read.revisionAfter, source);
  const complete = read.complete === true && read.truncated === false && !read.unavailableReason;
  const evidenceId = read.evidenceId || id();
  const value = { refId: read.ref, complete, plainText: true, secret: false,
    ...(typeof read.text === 'string' ? { value: read.text } : {}),
    ...(typeof read.digestRef === 'string' ? { privateDigest: read.digestRef, actualDigest: true } : expectedPrivateDigest && typeof read.exactMatch === 'boolean' ? { privateDigest: expectedPrivateDigest, exactMatch: read.exactMatch } : {}) };
  return normalizedEvidence({ id: evidenceId, source, producer, target: clone(target), revisionBefore: clone(read.revisionBefore), revisionAfter: clone(read.revisionAfter), interval: clone(interval),
    acquisition: read.unavailableReason ? 'unsupported' : 'ok', freshness: crossed.length ? 'stale' : freshness, reasons: crossed.map(key => `crossed_${key}`),
    coverage: { scope: 'exact_element_text', complete, truncated: read.truncated === true, omittedFrames: [], omissionReasons: complete ? [] : ['full_value_unavailable'] },
    facts: read.unavailableReason ? [] : [{ predicate: 'text.value', value, suitability: complete ? 'complete_value' : 'preview', evidenceIds: [evidenceId] }], derivedFrom: [] });
}

function adapterEvidenceProvider(read, source) {
  if (typeof read !== 'function') throw fail('adapter_read_required', 'invalid_request');
  return async (target, ctx) => {
    const output = await read(target, ctx);
    const entries = Array.isArray(output) ? output : output.state?.evidence || output.evidence || [output];
    const matching = entries.filter(e => e.source === source);
    if (matching.length !== 1) throw fail('adapter_source_ambiguous', 'verification_unavailable');
    return normalizeAdapterEvidence(matching[0], { refs: output.refs?.elements || [] });
  };
}

// Translate the current direct adapters, preserving source, fences and freshness.
function normalizeAdapterEvidence(input, { refs = [], operation, privateDigest } = {}) {
  const e = clone(input), facts = [];
  const emit = (predicate, value, suitability = 'deterministic') => {
    if (value !== undefined) facts.push({ predicate, value: jsonProjection(value), suitability, evidenceIds: [e.id] });
  };
  for (const f of e.facts || []) {
    if (f.kind === 'nativeElement' && e.source === 'atspi') {
      emit('element.ref', f.ref);
      if (Array.isArray(f.states)) {
        const showing = f.states.includes('showing') && f.states.includes('visible');
        if (f.role === 'heading' && showing && typeof f.name === 'string' && f.name.length < 256) emit('document.heading', { text: f.name, visible: true });
        if (['check box', 'checkbox', 'radio button', 'radio'].includes(f.role)) emit('element.checked', { refId: f.ref.id, checked: f.states.includes('checked') });
        if (f.states.includes('selectable')) emit('element.selected', { refId: f.ref.id, selected: f.states.includes('selected') });
        emit('element.focused', { refId: f.ref.id, focused: f.states.includes('focused') });
      }
    } else if (f.kind === 'plainText' && e.source === 'atspi') {
      emit('text.value', { refId: f.refId, privateDigest: f.privateDigest, actualDigest: true, complete: f.complete === true, plainText: true, secret: false }, f.complete === true ? 'complete_value' : 'preview');
    } else if (f.predicate === 'elements' && f.suitability === 'semantic_query' && e.source === 'dom' && Array.isArray(f.value)) {
      for (const node of f.value) {
        const ref = refs.find(r => r.id === node.refId);
        if (ref) emit('element.ref', ref);
        const heading = node.headingText !== undefined ? node.headingText : node.name;
        if (node.role === 'heading' && node.states?.visible === true && typeof heading === 'string' && heading.length > 0 && heading.length < 256) emit('document.heading', { text: heading, visible: true });
        if (['checkbox', 'radio'].includes(node.role) && typeof node.states?.checked === 'boolean') emit('element.checked', { refId: node.refId, checked: node.states.checked });
        if (node.role === 'option' && typeof node.states?.selected === 'boolean') emit('element.selected', { refId: node.refId, selected: node.states.selected });
        if (typeof node.states?.focused === 'boolean') emit('element.focused', { refId: node.refId, focused: node.states.focused });
        if (typeof node.valuePreview === 'string') emit('text.value', { refId: node.refId, value: node.valuePreview, complete: false, plainText: true, secret: false }, 'preview');
      }
    } else if (f.predicate === 'checked' && f.suitability === 'exact_state') emit('element.checked', f.value);
    else if (f.predicate === 'focused' && f.suitability === 'exact_state') emit('element.focused', f.value);
    else if (f.predicate === 'navigation' && f.suitability === 'navigation_state' && e.source === 'lifecycle') {
      // The adapter sanitizes URL query/hash. Preserve that limit.
      emit('document.url.redacted', f.value.currentUrl, 'redacted_url');
      if (typeof f.value.currentUrlExact === 'string') emit('document.url', f.value.currentUrlExact, 'authoritative');
      if (typeof f.value.urlDigest === 'string') emit('document.urlDigest', f.value.urlDigest, 'authoritative');
      for (const h of f.value.visibleHeadings || []) if (typeof h.text === 'string' && h.visible === true) emit('document.heading', h, 'visible_readback');
    } else if (f.predicate === 'document' && f.suitability === 'dom_state') {
      emit('document.summary', { currentUrl: f.value.currentUrl, headings: f.value.headings, readyState: f.value.readyState }, 'semantic_summary');
      if (e.source === 'lifecycle' && typeof f.value.currentUrlExact === 'string') emit('document.url', f.value.currentUrlExact, 'authoritative');
      if (e.source === 'lifecycle' && typeof f.value.urlDigest === 'string') emit('document.urlDigest', f.value.urlDigest, 'authoritative');
      for (const h of f.value.visibleHeadings || []) if (typeof h.text === 'string' && h.visible === true) emit('document.heading', h, e.source === 'lifecycle' ? 'visible_readback' : 'visible');
    } else if (f.predicate === 'fullText' && f.suitability === 'full_text_readback' && ['dom', 'atspi'].includes(e.source)) {
      const v = f.value;
      if (v.complete === true && typeof v.digest === 'string') emit('text.value', { refId: v.refId, privateDigest: v.digest, actualDigest: true, complete: true, plainText: true, secret: false }, 'complete_value');
    } else if (f.predicate === 'text_exact' && f.suitability === 'full_text_readback' && ['dom', 'atspi'].includes(e.source)) {
      // exactMatch proves the adapter's expectation, not an arbitrary caller value.
      emit('text.readback', f.value, 'adapter_expectation');
      const v = f.value;
      if (v.complete === true && typeof v.actualPrivateDigest === 'string') emit('text.value', { refId: v.refId, complete: true, plainText: true, secret: false, privateDigest: v.actualPrivateDigest, actualDigest: true }, 'complete_value');
      if (v.actualPrivateDigest === undefined && v.complete === true && typeof v.expectedPrivateDigest === 'string' && typeof v.exactMatch === 'boolean') emit('text.value', { refId: v.refId, complete: true, plainText: true, secret: false, privateDigest: v.expectedPrivateDigest, exactMatch: v.exactMatch }, 'complete_value');
      if (boundReplace(operation, e.target, v.refId, v, privateDigest) && digestConsistent(v)) emit('text.value', {
        refId: v.refId, expectedValue: operation.edit.text, exactMatch: v.exactMatch, complete: true, plainText: true, secret: false,
      }, 'complete_value');
    } else if (typeof f.predicate === 'string' && typeof f.suitability === 'string' && f.value !== undefined) facts.push({ predicate: f.predicate, value: jsonProjection(f.value), suitability: f.suitability,
      evidenceIds: Array.isArray(f.evidenceIds) && f.evidenceIds.length ? clone(f.evidenceIds) : [e.id] });
    else emit('adapter.uninterpreted', null, 'unavailable');
  }
  e.facts = facts;
  return normalizedEvidence(e);
}

function digestConsistent(read) {
  const actual = read.actualPrivateDigest ?? read.digestRef;
  return actual === undefined || read.expectedPrivateDigest === undefined || (actual === read.expectedPrivateDigest) === read.exactMatch;
}
function boundReplace(operation, target, refId, read, privateDigest) {
  const edit = operation?.edit;
  return operation?.kind === 'editText' && sameTarget(operation.ref?.target, target) && operation.ref.id === refId && edit?.mode === 'replace' && edit.semantics === 'plain_text' && typeof edit.text === 'string'
    && read.complete === true && typeof read.exactMatch === 'boolean'
    && (privateDigest === undefined || typeof privateDigest === 'function' && read.expectedPrivateDigest === privateDigest(edit.text))
    && (read.exactMatch === false || (read.totalScalars === undefined || read.totalScalars === [...edit.text].length)
      && (read.totalUtf16Units === undefined || read.totalUtf16Units === edit.text.length)
      && (read.totalUtf8Bytes === undefined || read.totalUtf8Bytes === Buffer.byteLength(edit.text)));
}
function normalizeBrowserEvidence(input, options = {}) {
  if (!['dom', 'browser_ax', 'lifecycle', 'pixels', 'ocr'].includes(input.source)) throw fail('browser_evidence_source_mismatch', 'invalid_request');
  return normalizeAdapterEvidence(input, options);
}
function normalizeDesktopEvidence(input, options = {}) {
  if (!['window', 'atspi', 'pixels', 'ocr'].includes(input.source)) throw fail('desktop_evidence_source_mismatch', 'invalid_request');
  return normalizeAdapterEvidence(input, options);
}
function sameNativeObject(a, b) {
  return a && b && sameTarget(a.target, b.target) && a.source === 'atspi' && b.source === 'atspi' && isDeepStrictEqual(a.native, b.native) && isDeepStrictEqual(a.identity, b.identity);
}

// options.operation is the coordinator's validated, dispatched operation, never model commentary.
function normalizeAdapterReceipt(input, options = {}) {
  const receipt = clone(input), op = options.operation;
  const target = receipt.target || op?.target || op?.ref?.target;
  if (!target) throw fail('receipt_target_required', 'invalid_request');
  if (op && !sameTarget(op.target || op.ref?.target || target, target)) throw fail('receipt_operation_target_mismatch', 'invalid_request');
  receipt.evidence = (receipt.evidence || []).map(e => {
    if (!sameTarget(e.target, target)) throw fail('receipt_evidence_target_mismatch');
    return (e.source === 'atspi' || e.source === 'window' ? normalizeDesktopEvidence : normalizeBrowserEvidence)(e, options);
  });
  const read = options.textRead || receipt.readback;
  if (read) {
    const origin = (input.evidence || []).find(e => e.id === read.evidenceId) || read.evidence;
    const interval = origin?.interval || read.interval || options.interval;
    const source = options.source || origin?.source || read.source;
    if (!interval || !source) throw fail('readback_interval_required', 'invalid_request');
    if (origin && (!sameTarget(origin.target, target) || source !== origin.source || !isDeepStrictEqual(origin.revisionBefore, read.revisionBefore) || !isDeepStrictEqual(origin.revisionAfter, read.revisionAfter))) throw fail('readback_metadata_mismatch');
    if (origin && (read.source && read.source !== origin.source || read.interval && !isDeepStrictEqual(read.interval, origin.interval))) throw fail('readback_metadata_mismatch');
    if (read.requestRefId !== undefined && op?.ref && read.requestRefId !== op.ref.id) throw fail('readback_operation_ref_mismatch');
    const ev = evidenceFromTextRead(read, { target, source, interval, producer: origin?.producer || options.producer,
      expectedPrivateDigest: options.expectedPrivateDigest || read.expectedPrivateDigest, freshness: origin?.freshness || 'unknown' });
    if (origin) {
      ev.derivedFrom = clone(origin.derivedFrom); ev.reasons = [...new Set([...origin.reasons, ...ev.reasons])]; ev.acquisition = origin.acquisition;
    }
    const alias = receipt.renewedRef && op?.ref && read.ref === receipt.renewedRef.id && sameNativeObject(op.ref, receipt.renewedRef) ? op.ref.id : read.ref;
    if (alias !== read.ref) for (const f of ev.facts) f.value.refId = alias;
    if (boundReplace(op, target, alias, read, options.privateDigest) && digestConsistent(read)) ev.facts.push({ predicate: 'text.value', value: { refId: alias, expectedValue: op.edit.text, exactMatch: read.exactMatch,
      complete: true, plainText: true, secret: false }, suitability: 'complete_value', evidenceIds: [ev.id] });
    const index = receipt.evidence.findIndex(e => e.id === ev.id);
    if (index < 0) receipt.evidence.push(ev);
    else receipt.evidence[index] = { ...receipt.evidence[index], facts: [...receipt.evidence[index].facts, ...ev.facts] };
  }
  receipt.evidence = receipt.evidence.map(normalizedEvidence);
  return receipt;
}

// Call before dispatch with the validated operation. A supplied digest function
// must use the adapter's private key. Expected text alone is never readback.
// expectedFinalPrivateDigest comes from the adapter's full live pre-read before
// any effect, through a trusted action-local callback. Never copy it from a receipt.
function expectationsForOperation(operation, { privateDigest, expectedFinalPrivateDigest, heading, urlDigest, makeId = id } = {}) {
  // Some validated operations have no target and no registered postcondition.
  if (!['editText', 'setChecked', 'focus', 'navigate', 'moveWindow', 'closeWindow'].includes(operation?.kind)) return [];
  const target = operation?.ref?.target || operation?.target;
  assertTarget(target);
  const predicate = (validator, args) => {
    const p = { id: makeId('predicate'), validator, validatorVersion: 1, target: clone(target), args };
    assertId(p.id); C.validatePredicate(p); return p;
  };
  const refId = operation.ref?.id;
  switch (operation.kind) {
    case 'editText':
      if (!['replace', 'append', 'insert', 'replaceSelection'].includes(operation.edit?.mode) || operation.edit.semantics !== 'plain_text' || typeof operation.edit.text !== 'string') return [];
      assertId(refId);
      if (operation.edit.mode !== 'replace') {
        if (expectedFinalPrivateDigest === undefined) return [];
        assertId(expectedFinalPrivateDigest);
        return [predicate('text.exact', { refId, privateDigest: expectedFinalPrivateDigest })];
      }
      if (privateDigest !== undefined) {
        if (typeof privateDigest !== 'function') throw fail('private_digester_required', 'invalid_request');
        const digest = privateDigest(operation.edit.text); assertId(digest);
        return [predicate('text.exact', { refId, privateDigest: digest })];
      }
      return [predicate('text.exact', { refId, value: operation.edit.text })];
    case 'setChecked':
      assertId(refId);
      if (typeof operation.checked !== 'boolean') throw fail('invalid_checked_expectation', 'invalid_request');
      return [predicate('element.checked', { refId, checked: operation.checked })];
    case 'focus':
      assertId(refId); return [predicate('element.focused', { refId, focused: true })];
    case 'moveWindow':
      if (typeof operation.workspace !== 'string') throw fail('invalid_window_expectation', 'invalid_request');
      return [predicate('window.placement', { workspace: operation.workspace })];
    case 'closeWindow':
      return [predicate('window.closed', { closed: true })];
    case 'navigate':
      if (typeof heading !== 'string' || !heading.length) return [];
      if (urlDigest !== undefined) { assertId(urlDigest); return [predicate('navigation.destination', { urlDigest, heading })]; }
      if (typeof operation.url !== 'string') throw fail('invalid_navigation_expectation', 'invalid_request');
      return [predicate('navigation.destination', { url: operation.url, heading })];
    default: return [];
  }
}

module.exports = { wrapLegacyObservation, evidenceFromTextRead, adapterEvidenceProvider, normalizeAdapterEvidence,
  normalizeBrowserEvidence, normalizeDesktopEvidence, normalizeAdapterReceipt, expectationsForOperation };
