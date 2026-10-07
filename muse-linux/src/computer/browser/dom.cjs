'use strict';
// These functions run only in adapter-created isolated worlds. Arguments are data.
function visibleElement(e) {
  if (!e || e.closest('[aria-hidden="true"],script,style,noscript,[type="password"],[data-muse-secret],textarea')) return false;
  const style = e.ownerDocument.defaultView.getComputedStyle(e);
  return style.visibility !== 'hidden' && style.visibility !== 'collapse' && style.display !== 'none' && e.getClientRects().length > 0;
}
function visibleText(root, limit) {
  const walker = root.ownerDocument.createTreeWalker(root, 4);
  let text = '', count = 0;
  while (walker.nextNode() && count++ < 2000 && text.length < limit) {
    if (!globalThis.__museVisibleElement(walker.currentNode.parentElement)) continue;
    const part = walker.currentNode.textContent.trim();
    if (part) text += `${part} `;
  }
  return text.trim().slice(0, limit);
}
function install() {
  const w = globalThis;
  if (w.__museDom) return true;
  const state = { semantic: 0, geometry: 0, composition: false };
  const observer = new w.MutationObserver(() => { state.semantic++; });
  observer.observe(w.document, { subtree: true, childList: true, characterData: true, attributes: true });
  w.document.addEventListener('compositionstart', () => { state.composition = true; state.semantic++; }, true);
  w.document.addEventListener('compositionend', () => { state.composition = false; state.semantic++; }, true);
  w.document.addEventListener('input', () => { state.semantic++; }, true);
  w.document.addEventListener('scroll', () => { state.geometry++; }, true);
  w.addEventListener('resize', () => { state.geometry++; });
  Object.defineProperty(w, '__museDom', { value: state });
  return true;
}
function metadata() {
  const e = this;
  if (!e || e.nodeType !== 1 || !e.isConnected) return { connected: false };
  const w = e.ownerDocument.defaultView;
  const tag = e.localName;
  const type = (e.getAttribute('type') || '').toLowerCase();
  const secret = type === 'password' || /password|one-time-code|cc-number|cc-csc|cc-exp/.test(e.autocomplete || '') || e.getAttribute('data-muse-secret') === 'true';
  const implicit = { button: 'button', a: e.hasAttribute('href') ? 'link' : 'generic', textarea: 'textbox', select: 'combobox', option: 'option', input: ['checkbox', 'radio'].includes(type) ? type : ['submit', 'button', 'reset'].includes(type) ? 'button' : type === 'file' ? 'file' : 'textbox', h1: 'heading', h2: 'heading', h3: 'heading' };
  const role = e.getAttribute('role') || implicit[tag] || (e.isContentEditable ? 'textbox' : 'generic');
  let name = e.getAttribute('aria-label') || '';
  if (!name && e.hasAttribute('aria-labelledby')) name = e.getAttribute('aria-labelledby').split(/\s+/).slice(0, 8).map(id => e.getRootNode().getElementById?.(id)?.textContent || '').join(' ');
  if (!name && e.labels) name = Array.from(e.labels).slice(0, 8).map(l => {
    const walker = e.ownerDocument.createTreeWalker(l, 4); let text = ''; let visited = 0;
    while (walker.nextNode() && visited++ < 256 && text.length < 256) if (!e.contains(walker.currentNode)) text += walker.currentNode.textContent;
    return text;
  }).join(' ');
  if (!name && role === 'heading') name = globalThis.__museVisibleText(e, 256);
  if (!name) name = e.getAttribute('alt') || e.getAttribute('title') || e.getAttribute('placeholder') || (['button', 'link', 'option'].includes(role) ? e.textContent : '') || '';
  const r = e.getBoundingClientRect();
  const style = w.getComputedStyle(e);
  const visible = !!e.getClientRects().length && r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) !== 0;
  const textEditable = !secret && ((tag === 'textarea') || (tag === 'input' && ['text', 'search', 'email', 'url', 'tel', ''].includes(type)) || e.isContentEditable);
  let navigation;
  if (tag === 'a' && e.hasAttribute('href')) {
    try {
      const url = new w.URL(e.href);
      if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && url.href.length <= 8192)
        navigation = { url: url.href, target: e.getAttribute('target') || '_self' };
    } catch { /* A malformed or script URL is not a navigation destination. */ }
  }
  return { connected: true, role, name: secret ? '[secret]' : name.trim().slice(0, 256), tag, type, secret, visible,
    ...(role === 'heading' ? { headingText: globalThis.__museVisibleText(e, 256) } : {}),
    ...(navigation ? { navigation } : {}),
    enabled: !e.disabled && e.getAttribute('aria-disabled') !== 'true' && !e.closest('[inert]'), readonly: !!e.readOnly || e.getAttribute('aria-readonly') === 'true',
    editable: textEditable, contenteditable: e.isContentEditable, multiline: tag === 'textarea' || e.isContentEditable,
    checked: !!e.checked || e.getAttribute('aria-checked') === 'true', selected: !!e.selected,
    focused: (e.getRootNode().activeElement || e.ownerDocument.activeElement) === e,
    scrollableX: e.scrollWidth > e.clientWidth && /auto|scroll/.test(style.overflowX), scrollableY: e.scrollHeight > e.clientHeight && /auto|scroll/.test(style.overflowY),
    valuePreview: secret ? undefined : typeof e.value === 'string' && type !== 'file' ? e.value.slice(0, 128) : undefined,
    valueUtf16: secret ? undefined : typeof e.value === 'string' && type !== 'file' ? e.value.length : undefined,
    rect: { x: r.x, y: r.y, width: r.width, height: r.height },
    semantic: w.__museDom?.semantic || 0, geometry: w.__museDom?.geometry || 0, composition: w.__museDom?.composition || false };
}
function scan(query, limit, maxVisited) {
  const doc = this.nodeType === 9 ? this : this.ownerDocument;
  const root = this.nodeType === 9 ? this.documentElement : this;
  const stack = root ? [root] : [];
  const nodes = []; let visited = 0;
  const meta = globalThis.__museMetadata;
  while (stack.length && visited < maxVisited && nodes.length < limit) {
    const e = stack.pop(); visited++;
    if (e.nodeType === 11) { for (const child of Array.from(e.children).reverse()) stack.push(child); continue; }
    if (e.nodeType !== 1) continue;
    const m = meta.call(e);
    const interesting = m.role !== 'generic' || m.editable || m.scrollableX || m.scrollableY || e.hasAttribute('tabindex');
    const nameMatch = !query?.name || (query.exact ? m.name === query.name : m.name.toLowerCase().includes(query.name.toLowerCase()));
    const statesMatch = Object.entries(query?.states || {}).every(([key, value]) => m[key] === value);
    if (interesting && !m.secret && (!query?.role || m.role === query.role) && nameMatch && statesMatch && (query?.scope === 'structural' || m.visible)) nodes.push(e);
    if (e.shadowRoot) stack.push(e.shadowRoot);
    const children = Array.from(e.children || []);
    for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]);
  }
  globalThis.__museScan = { truncated: stack.length > 0, visited, count: nodes.length, readyState: doc.readyState };
  return nodes;
}
function documentObject() { return globalThis.document; }
function summary() {
  const doc = globalThis.document;
  const visible = globalThis.__museVisibleElement, visibleText = globalThis.__museVisibleText;
  const headingElements = Array.from(doc.querySelectorAll('h1,h2,[role="heading"]')).filter(visible).slice(0, 8);
  const headings = headingElements.map(e => visibleText(e, 256)).filter(Boolean);
  const visibleHeadings = headings.map(text => ({ text, visible: true }));
  const main = Array.from(doc.querySelectorAll('main,[role="main"]')).find(visible);
  const excerpt = visibleText(main || doc.body || doc.documentElement, 2048);
  return { url: doc.URL, title: doc.title.slice(0, 256), headings, visibleHeadings, textExcerpt: excerpt.slice(0, 2048), readyState: doc.readyState,
    semantic: globalThis.__museDom?.semantic || 0, geometry: globalThis.__museDom?.geometry || 0,
    composition: globalThis.__museDom?.composition || false, scan: globalThis.__museScan || {} };
}
function hitTest() {
  const e = this; const doc = e.ownerDocument;
  if (!e.isConnected) return { ok: false, reason: 'detached_node' };
  const r = e.getBoundingClientRect();
  const x = r.x + r.width / 2, y = r.y + r.height / 2;
  if (r.width <= 0 || r.height <= 0 || x < 0 || y < 0 || x >= doc.defaultView.innerWidth || y >= doc.defaultView.innerHeight) return { ok: false, reason: 'offscreen' };
  let hit = doc.elementFromPoint(x, y);
  while (hit?.shadowRoot) { const child = hit.shadowRoot.elementFromPoint(x, y); if (!child || child === hit) break; hit = child; }
  const ok = hit === e || e.contains(hit) || (e.localName === 'label' && e.control === hit);
  return { ok, reason: ok ? undefined : 'occluded', x, y, rect: { x: r.x, y: r.y, width: r.width, height: r.height } };
}
function textRead(limit) {
  const e = this;
  if (!e.isConnected) return { unavailable: 'detached_node' };
  if (e.localName === 'input' && e.type === 'password') return { unavailable: 'secret_control' };
  const text = typeof e.value === 'string' && e.type !== 'file' ? e.value : e.isContentEditable ? e.innerText : e.textContent;
  if (text.length > limit) return { unavailable: 'verification_limit', totalUtf16Units: text.length };
  const totalUtf8Bytes = new globalThis.TextEncoder().encode(text).byteLength;
  if (totalUtf8Bytes > limit) return { unavailable: 'verification_limit', totalUtf16Units: text.length, totalUtf8Bytes };
  let start = e.selectionStart, end = e.selectionEnd;
  if (e.isContentEditable) {
    const selection = e.ownerDocument.getSelection();
    if (selection.rangeCount && e.contains(selection.anchorNode) && e.contains(selection.focusNode)) {
      const range = selection.getRangeAt(0); const pre = range.cloneRange(); pre.selectNodeContents(e); pre.setEnd(range.startContainer, range.startOffset); start = pre.toString().length;
      pre.setEnd(range.endContainer, range.endOffset); end = pre.toString().length;
    } else { start = end = text.length; }
  }
  return { text, start, end, semantic: globalThis.__museDom?.semantic || 0 };
}
function prepareText(start, end) {
  const e = this; e.focus({ preventScroll: true });
  if (typeof e.setSelectionRange === 'function') e.setSelectionRange(start, end);
  else {
    const doc = e.ownerDocument; const walker = doc.createTreeWalker(e, 4); let offset = 0; let a, b;
    while (walker.nextNode()) { const n = walker.currentNode; const next = offset + n.textContent.length; if (!a && start <= next) a = [n, Math.max(0, start - offset)]; if (end <= next) { b = [n, Math.max(0, end - offset)]; break; } offset = next; }
    const range = doc.createRange(); if (a && b) { range.setStart(...a); range.setEnd(...b); } else { range.selectNodeContents(e); if (start === end) range.collapse(false); }
    const selection = doc.getSelection(); selection.removeAllRanges(); selection.addRange(range);
  }
  const active = e.getRootNode().activeElement || e.ownerDocument.activeElement;
  return { focused: active === e };
}
function focus() { this.focus({ preventScroll: true }); return (this.getRootNode().activeElement || this.ownerDocument.activeElement) === this; }
function selectOptions(values) {
  if (this.localName !== 'select') return { unavailable: 'select_unsupported' };
  const set = new Set(values); for (const option of this.options) option.selected = set.has(option.value);
  const w = this.ownerDocument.defaultView; this.dispatchEvent(new w.Event('input', { bubbles: true })); this.dispatchEvent(new w.Event('change', { bubbles: true }));
  return { selected: Array.from(this.selectedOptions).map(o => o.value) };
}
function optionValues() { return this.localName === 'select' ? Array.from(this.selectedOptions).map(o => o.value) : { unavailable: 'select_unsupported' }; }
function optionInfo() { return { value: this.value, selected: this.selected, parentTag: this.parentElement?.localName }; }
function optionBelongs(object) { return this.localName === 'select' && Array.from(this.options).includes(object); }
function scroll(axis, delta) { const before = axis === 'x' ? this.scrollLeft : this.scrollTop; this.scrollBy({ [axis === 'x' ? 'left' : 'top']: delta, behavior: 'instant' }); return { before, after: axis === 'x' ? this.scrollLeft : this.scrollTop }; }
function reveal(edge) { this.scrollIntoView({ block: edge, inline: 'nearest', behavior: 'instant' }); return true; }
function filesRead() { return this.localName === 'input' && this.type === 'file' ? { count: this.files.length, sizes: Array.from(this.files).slice(0, 16).map(f => f.size) } : { unavailable: 'not_file_input' }; }
function stableFrame() {
  const geometry = new Set(['transform','translate','rotate','scale','width','height','top','left','right','bottom','margin','padding']);
  let node = this;
  while (node?.nodeType === 1) {
    for (const animation of node.getAnimations()) if (animation.playState === 'running' && animation.effect?.getKeyframes().some(frame => Object.keys(frame).some(key => geometry.has(key)))) return false;
    node = node.parentElement || node.getRootNode().host;
  }
  return true;
}
const functions = { install, metadata, scan, documentObject, summary, hitTest, textRead, prepareText, focus, selectOptions, optionValues, optionInfo, optionBelongs, scroll, reveal, filesRead, stableFrame };
// Install one audited metadata helper in the isolated world for the bounded walker.
functions.installMetadata = function installMetadata() { globalThis.__museMetadata = function metadataPlaceholder() {}; return true; };
// The declaration is fixed at build time; no caller supplies code or selectors.
const declarations = Object.fromEntries(Object.entries(functions).map(([name, fn]) => [name, fn.toString()]));
declarations.installMetadata = `function(){globalThis.__museVisibleElement=${visibleElement.toString()};globalThis.__museVisibleText=${visibleText.toString()};globalThis.__museMetadata=${metadata.toString()};return true;}`;
module.exports = { declarations };
