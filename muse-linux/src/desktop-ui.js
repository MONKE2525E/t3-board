(() => {
  const VERSION = 3;
  const STYLE_ID = 'muse-linux-desktop-style';
  const SETTINGS_ID = 'muse-linux-settings-native';
  const DESKTOP_SETTINGS_ID = 'muse-linux-desktop-settings';
  const DICTATION_ID = 'muse-linux-dictation';
  const DICTATION_BUTTON_ID = 'muse-linux-dictation-button';
  const DICTATION_CANCEL_ID = 'muse-linux-dictation-cancel';
  const NS = 'http://www.w3.org/2000/svg';
  const SCAN_LIMIT = 360;
  const DESKTOP_SETTINGS_LABEL = 'Desktop settings';
  const NATIVE_TABS = [
    { tab: 'computer', label: 'Computer use', icon: 'monitor' },
    { tab: 'files', label: 'File system access', icon: 'files' },
    { tab: 'dictation', label: 'Dictation', icon: 'mic' },
    { tab: 'shortcuts', label: 'Keyboard shortcuts', icon: 'keyboard' },
  ];
  const NAV_HINTS = new Set([
    'General', 'Connectors', 'Wallet', 'Devices', 'Data controls', 'Help & support',
    'Log out', 'Permissions', 'Legal info', 'Secure store', 'Voice and avatar',
    'Messaging channels', 'Internal settings',
  ]);
  const EXISTING_DICTATION = new Set(['Dictate a message', 'Start dictation', 'Stop dictation']);
  const ICONS = {
    monitor: [
      { d: 'M3.5 3.12h17A1.88 1.88 0 0 1 22.38 5v10.5a1.88 1.88 0 0 1-1.88 1.88H14.9v2.13h2.6a.88.88 0 0 1 0 1.75H6.5a.88.88 0 0 1 0-1.75h2.6v-2.13H3.5A1.88 1.88 0 0 1 1.62 15.5V5A1.88 1.88 0 0 1 3.5 3.12Zm.13 1.75v10.25h16.74V4.87Z' },
    ],
    files: [
      { d: 'M7.25 1.12h6.2c.4 0 .78.16 1.06.44l5.93 5.93c.28.28.44.66.44 1.06v11.2A2.25 2.25 0 0 1 18.63 22H7.25A2.25 2.25 0 0 1 5 19.75V3.37A2.25 2.25 0 0 1 7.25 1.12Zm6.05 1.76H7.25a.5.5 0 0 0-.5.5v16.37c0 .28.22.5.5.5h11.38a.5.5 0 0 0 .5-.5V9.3h-4.3a1.75 1.75 0 0 1-1.75-1.75V2.88Zm1.75 1.48v3.19h3.19Z' },
    ],
    mic: [
      { d: 'M19.5 9.13C19.98 9.13 20.38 9.52 20.38 10V10.5C20.38 14.83 17.09 18.39 12.88 18.83V21.13H15.5C15.98 21.13 16.38 21.52 16.38 22C16.38 22.48 15.98 22.88 15.5 22.88H8.5C8.02 22.88 7.63 22.48 7.63 22C7.63 21.52 8.02 21.13 8.5 21.13H11.13V18.83C6.91 18.39 3.63 14.83 3.63 10.5V10C3.63 9.52 4.02 9.13 4.5 9.13C4.98 9.13 5.38 9.52 5.38 10V10.5C5.38 14.16 8.34 17.13 12 17.13C15.66 17.13 18.63 14.16 18.63 10.5V10C18.63 9.52 19.02 9.13 19.5 9.13Z' },
      { d: 'M12 .63C14.42.63 16.38 2.58 16.38 5V10.5C16.38 12.92 14.42 14.88 12 14.88C9.58 14.88 7.63 12.92 7.63 10.5V5C7.63 2.58 9.58.63 12 .63ZM12 2.38C10.55 2.38 9.38 3.55 9.38 5V10.5C9.38 11.95 10.55 13.13 12 13.13C13.45 13.13 14.63 11.95 14.63 10.5V5C14.63 3.55 13.45 2.38 12 2.38Z', evenodd: true },
    ],
    keyboard: [
      { d: 'M3.5 5.12h17A1.88 1.88 0 0 1 22.38 7v10a1.88 1.88 0 0 1-1.88 1.88H3.5A1.88 1.88 0 0 1 1.62 17V7A1.88 1.88 0 0 1 3.5 5.12Zm.13 1.76v9.24h16.74V6.88ZM6 9.25h2v2H6zm5 0h2v2h-2zm5 0h2v2h-2zM7.5 14.25h9v1.5h-9z' },
    ],
    close: [
      { d: 'M17.75 5.02C18.09 4.68 18.64 4.68 18.98 5.02C19.32 5.36 19.32 5.91 18.98 6.26L13.24 12L18.98 17.75C19.32 18.09 19.32 18.64 18.98 18.98C18.64 19.32 18.09 19.32 17.75 18.98L12 13.24L6.26 18.98C5.91 19.32 5.36 19.32 5.02 18.98C4.68 18.64 4.68 18.09 5.02 17.75L10.76 12L5.02 6.26C4.68 5.91 4.68 5.36 5.02 5.02C5.36 4.68 5.91 4.68 6.26 5.02L12 10.76L17.75 5.02Z' },
    ],
  };

  if (window.__museLinuxDesktopUi) {
    if (window.__museLinuxDesktopUi.version >= VERSION) return;
    if (typeof window.__museLinuxDesktopUi.teardown === 'function') window.__museLinuxDesktopUi.teardown();
  } else {
    const stale = document.getElementById(STYLE_ID);
    if (stale) stale.remove();
    const staleGroup = document.getElementById(SETTINGS_ID);
    if (staleGroup) staleGroup.remove();
    const staleDesktop = document.getElementById(DESKTOP_SETTINGS_ID);
    if (staleDesktop) staleDesktop.remove();
    const staleDict = document.getElementById(DICTATION_ID);
    if (staleDict) staleDict.remove();
  }

  let applying = false;
  let scanTimer = 0;
  let pollTimer = 0;
  let observer = null;
  let state = { dictationEnabled: false, dictationStatus: 'idle', dictationError: null, activeTask: null };
  const bound = { button: null, onClick: null, onPointer: null, onMouse: null, original: null };

  const later = (fn, ms) => window.setTimeout(fn, ms);
  const clearLater = id => window.clearTimeout(id);

  function desktop() {
    const api = window.museDesktop;
    return api && typeof api === 'object' ? api : null;
  }

  function call(name, arg) {
    const api = desktop();
    if (!api || typeof api[name] !== 'function') return;
    try {
      const result = arg === undefined ? api[name]() : api[name](arg);
      if (result && typeof result.then === 'function') void result.catch(() => {});
    } catch {}
  }

  function visible(el) {
    if (!el || !el.isConnected) return false;
    const rects = el.getClientRects();
    return rects.length > 0 && rects[0].width > 0 && rects[0].height > 0;
  }

  function ours(el) {
    if (!el) return false;
    if (el.id === SETTINGS_ID || el.id === DESKTOP_SETTINGS_ID || el.id === DICTATION_ID || el.id === DICTATION_BUTTON_ID || el.id === DICTATION_CANCEL_ID) return true;
    if (el.getAttribute && (el.getAttribute('data-muse-linux-bound') === '1' || el.getAttribute('data-muse-linux-desktop-settings') === '1' || el.getAttribute('data-muse-linux-tab'))) return true;
    if (!el.closest) return false;
    return !!(el.closest('#' + SETTINGS_ID) || el.closest('#' + DICTATION_ID) || el.closest('#' + DESKTOP_SETTINGS_ID));
  }

  function labelOf(el) {
    if (!el) return '';
    const aria = el.getAttribute('aria-label');
    if (aria && aria.trim()) return aria.trim();
    const text = (el.innerText || '').replace(/\s+/g, ' ').trim();
    if (text) return text;
    const title = el.getAttribute('title');
    return title ? title.trim() : '';
  }

  function svgIcon(name, size) {
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', String(size));
    svg.setAttribute('height', String(size));
    svg.setAttribute('fill', 'currentColor');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    for (const part of ICONS[name] || []) {
      const path = document.createElementNS(NS, 'path');
      path.setAttribute('d', part.d);
      if (part.evenodd) {
        path.setAttribute('fill-rule', 'evenodd');
        path.setAttribute('clip-rule', 'evenodd');
      }
      svg.appendChild(path);
    }
    return svg;
  }

  function stopEvent(event) {
    event.preventDefault();
    event.stopPropagation();
    if (typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation();
  }

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.setAttribute('data-muse-linux-ui', String(VERSION));
    style.textContent = [
      '#' + SETTINGS_ID + '{display:contents}',
      '#' + SETTINGS_ID + ' .muse-linux-settings-item{display:flex;width:100%;align-items:center;gap:10px;min-height:32px;margin:0;padding:6px 8px;border:0;border-radius:12px;background:transparent;color:inherit;font:inherit;font-size:13px;line-height:18px;cursor:pointer;text-align:start;user-select:none}',
      '#' + SETTINGS_ID + ' .muse-linux-settings-item:hover,#' + SETTINGS_ID + ' .muse-linux-settings-item:active{background:var(--fill-secondary-elevated,color-mix(in srgb,currentColor 8%,transparent))}',
      '#' + SETTINGS_ID + ' .muse-linux-settings-item:focus-visible{outline:2px solid var(--hatch-accent,#73aaff);outline-offset:-2px}',
      '#' + SETTINGS_ID + ' .muse-linux-settings-icon{display:inline-flex;width:20px;height:20px;flex:0 0 20px;align-items:center;justify-content:center}',
      '#' + SETTINGS_ID + ' .muse-linux-settings-label{min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '#' + DESKTOP_SETTINGS_ID + '{cursor:pointer}',
      '#' + DICTATION_ID + '{display:inline-flex;align-items:center;gap:2px;flex:0 0 auto}',
      '#' + DICTATION_BUTTON_ID + '[data-muse-linux-bound="1"],#' + DICTATION_CANCEL_ID + '{cursor:pointer}',
      '#' + DICTATION_CANCEL_ID + '{display:inline-flex;align-items:center;justify-content:center;margin:0;padding:0;border:0;background:transparent;color:inherit;flex:0 0 auto;user-select:none;width:20px;height:20px;border-radius:999px;color:var(--text-secondary,color-mix(in srgb,currentColor 70%,transparent))}',
      '#' + DICTATION_CANCEL_ID + '[hidden]{display:none!important}',
      '#' + DICTATION_CANCEL_ID + ':hover{background:var(--fill-secondary-elevated,color-mix(in srgb,currentColor 8%,transparent))}',
      '#' + DICTATION_CANCEL_ID + ':focus-visible,#' + DICTATION_BUTTON_ID + ':focus-visible{outline:2px solid var(--hatch-accent,#73aaff);outline-offset:2px}',
      '#' + DICTATION_BUTTON_ID + '[data-status="listening"]{color:#e24b4a}',
      '#' + DICTATION_BUTTON_ID + '[data-status="listening"] svg{transform-origin:center;animation:muse-linux-listen 1.4s ease-in-out infinite}',
      '#' + DICTATION_BUTTON_ID + '[data-status="transcribing"]{opacity:.7}',
      '#' + DICTATION_BUTTON_ID + ':disabled{cursor:default;opacity:.55}',
      '@keyframes muse-linux-listen{0%,100%{transform:scale(1)}50%{transform:scale(1.08)}}',
      '@media (prefers-reduced-motion:reduce){#' + DICTATION_BUTTON_ID + '[data-status="listening"] svg{animation:none}}',
    ].join('');
    const root = document.head || document.documentElement;
    root.appendChild(style);
  }

  function collectClickables() {
    const nodes = document.querySelectorAll('button, [role="button"], a, [role="menuitem"]');
    const list = [];
    const limit = Math.min(nodes.length, SCAN_LIMIT);
    for (let i = 0; i < limit; i++) {
      const el = nodes[i];
      if (ours(el) || !visible(el)) continue;
      list.push(el);
    }
    return list;
  }

  function findSettingsNav() {
    const clickables = collectClickables();
    const hinted = [];
    for (const el of clickables) {
      const label = labelOf(el);
      if (NAV_HINTS.has(label)) hinted.push({ el, label });
    }
    if (hinted.length < 2) return null;
    let best = null;
    let bestScore = 1;
    for (const item of hinted) {
      let node = item.el.parentElement;
      for (let depth = 0; node && depth < 8; depth++) {
        if (node === document.body || node === document.documentElement) break;
        if (ours(node)) { node = node.parentElement; continue; }
        if ((node.getAttribute('role') || '') === 'menu') { node = node.parentElement; continue; }
        const kids = node.querySelectorAll('button, [role="button"], a');
        if (kids.length > 80) { node = node.parentElement; continue; }
        const labels = new Set();
        const limit = Math.min(kids.length, 80);
        for (let i = 0; i < limit; i++) {
          if (ours(kids[i]) || !visible(kids[i])) continue;
          const label = labelOf(kids[i]);
          if (NAV_HINTS.has(label) || NATIVE_TABS.some(tab => tab.label === label)) labels.add(label);
        }
        if (labels.size > bestScore && (labels.has('General') || labels.has('Connectors') || labels.has('Devices') || labels.has('Log out'))) {
          best = { container: node, labels, template: item.el };
          bestScore = labels.size;
        }
        node = node.parentElement;
      }
    }
    return best;
  }

  function findSettingsMenu() {
    const menus = document.querySelectorAll('[role="menu"]');
    const limit = Math.min(menus.length, 20);
    for (let i = 0; i < limit; i++) {
      const menu = menus[i];
      if (!visible(menu) || ours(menu)) continue;
      const items = [...menu.querySelectorAll('[role="menuitem"]')].filter(el => visible(el));
      if (items.length < 2 || items.length > 12) continue;
      const labels = items.map(labelOf);
      if (labels.includes('General') && labels.includes('Connectors')) continue;
      const hasDesktop = items.some(el => ours(el) || labelOf(el) === DESKTOP_SETTINGS_LABEL);
      const foreign = items.filter(el => !ours(el));
      const looks = foreign.some(el => {
        const label = labelOf(el);
        return /\bsettings\b/i.test(label) || /download apps/i.test(label) || /keyboard/i.test(label);
      });
      if (!looks && !hasDesktop) continue;
      const template = foreign.find(el => /\bsettings\b/i.test(labelOf(el))) || foreign[foreign.length - 1] || items[0];
      return { menu, items, foreign, template };
    }
    return null;
  }

  function replaceText(node, from, to) {
    if (node.nodeType === 3) {
      if (node.nodeValue && node.nodeValue.trim() === from) node.nodeValue = to;
      return;
    }
    const children = node.childNodes;
    for (let i = 0; i < children.length; i++) replaceText(children[i], from, to);
  }

  function replaceLongestText(node, to) {
    let best = null;
    let bestLen = 0;
    const walk = current => {
      if (current.nodeType === 3) {
        const text = current.nodeValue ? current.nodeValue.replace(/\s+/g, ' ').trim() : '';
        if (text.length > bestLen) {
          best = current;
          bestLen = text.length;
        }
      }
      const children = current.childNodes;
      for (let i = 0; i < children.length; i++) walk(children[i]);
    };
    walk(node);
    if (best && bestLen >= 3) best.nodeValue = to;
  }

  function decorateNative(el, spec, templateLabel) {
    el.removeAttribute('id');
    el.removeAttribute('data-testid');
    el.removeAttribute('aria-current');
    el.removeAttribute('data-active');
    el.removeAttribute('href');
    el.removeAttribute('disabled');
    el.removeAttribute('aria-busy');
    if (el.tagName === 'BUTTON' || el.tagName === 'button') el.setAttribute('type', 'button');
    el.setAttribute('aria-label', spec.label);
    el.setAttribute('title', spec.label);
    el.setAttribute('data-muse-linux-tab', spec.tab);
    replaceText(el, templateLabel, spec.label);
    const titled = el.querySelector('[title]');
    if (titled) titled.setAttribute('title', spec.label);
    const svg = el.querySelector('svg');
    if (svg && svg.parentNode) {
      const size = Math.round(parseFloat(window.getComputedStyle(svg).width) || 20) || 20;
      svg.parentNode.replaceChild(svgIcon(spec.icon, size), svg);
    }
    el.addEventListener('click', event => {
      stopEvent(event);
      call('settings', spec.tab);
    });
    el.addEventListener('pointerdown', event => event.stopPropagation());
    el.addEventListener('mousedown', event => event.stopPropagation());
  }

  function fallbackRow(spec) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'muse-linux-settings-item';
    button.setAttribute('aria-label', spec.label);
    button.title = spec.label;
    button.setAttribute('data-muse-linux-tab', spec.tab);
    const icon = document.createElement('span');
    icon.className = 'muse-linux-settings-icon';
    icon.appendChild(svgIcon(spec.icon, 20));
    const text = document.createElement('span');
    text.className = 'muse-linux-settings-label';
    text.textContent = spec.label;
    button.appendChild(icon);
    button.appendChild(text);
    button.addEventListener('click', event => {
      stopEvent(event);
      call('settings', spec.tab);
    });
    return button;
  }

  function desktopSettingsItem(template) {
    const el = template && template.cloneNode ? template.cloneNode(true) : document.createElement('div');
    el.id = DESKTOP_SETTINGS_ID;
    el.setAttribute('role', 'menuitem');
    el.setAttribute('data-muse-linux-desktop-settings', '1');
    el.setAttribute('aria-label', DESKTOP_SETTINGS_LABEL);
    el.setAttribute('title', DESKTOP_SETTINGS_LABEL);
    el.removeAttribute('data-highlighted');
    el.removeAttribute('aria-keyshortcuts');
    el.removeAttribute('data-radix-collection-item');
    el.tabIndex = 0;
    for (const kbd of [...el.querySelectorAll('kbd')]) kbd.remove();
    const templateLabel = template ? labelOf(template) : '';
    if (templateLabel) replaceText(el, templateLabel, DESKTOP_SETTINGS_LABEL);
    if (!el.textContent || !el.textContent.includes(DESKTOP_SETTINGS_LABEL)) replaceLongestText(el, DESKTOP_SETTINGS_LABEL);
    if (!el.textContent || !el.textContent.includes(DESKTOP_SETTINGS_LABEL)) {
      el.textContent = DESKTOP_SETTINGS_LABEL;
    }
    el.addEventListener('click', event => {
      stopEvent(event);
      call('settings', 'general');
    });
    el.addEventListener('keydown', event => {
      if(event.key==='Enter'||event.key===' '){stopEvent(event);call('settings','general');}
    });
    el.addEventListener('pointerdown', event => event.stopPropagation());
    el.addEventListener('mousedown', event => event.stopPropagation());
    return el;
  }

  function syncSidebar() {
    const existing = document.getElementById(SETTINGS_ID);
    const found = findSettingsNav();
    if (!found) {
      if (existing) existing.remove();
      return;
    }
    const present = new Set();
    const kids = found.container.querySelectorAll('button, [role="button"], a');
    const limit = Math.min(kids.length, 80);
    for (let i = 0; i < limit; i++) {
      if (ours(kids[i])) continue;
      present.add(labelOf(kids[i]));
    }
    const needed = NATIVE_TABS.filter(spec => !present.has(spec.label));
    if (!needed.length) {
      if (existing) existing.remove();
      return;
    }
    if (existing && existing.parentElement === found.container) {
      const have = [...existing.querySelectorAll('[data-muse-linux-tab]')].map(el => el.getAttribute('data-muse-linux-tab'));
      if (have.length === needed.length && needed.every((spec, i) => spec.tab === have[i])) return;
      existing.remove();
    } else if (existing) existing.remove();

    const group = document.createElement('div');
    group.id = SETTINGS_ID;
    const template = found.template;
    const templateLabel = labelOf(template);
    for (const spec of needed) {
      let row = null;
      if (template && template.cloneNode) {
        row = template.cloneNode(true);
        decorateNative(row, spec, templateLabel);
        if (!row.textContent || !row.textContent.includes(spec.label)) row = fallbackRow(spec);
      } else row = fallbackRow(spec);
      group.appendChild(row);
    }

    const connectors = [...found.container.querySelectorAll('button, [role="button"], a')].find(el => !ours(el) && labelOf(el) === 'Connectors');
    const general = [...found.container.querySelectorAll('button, [role="button"], a')].find(el => !ours(el) && labelOf(el) === 'General');
    const logout = [...found.container.querySelectorAll('button, [role="button"], a')].find(el => !ours(el) && labelOf(el) === 'Log out');
    const after = connectors || general;
    if (after && after.parentElement === found.container) after.after(group);
    else if (after) after.parentElement.insertBefore(group, after.nextSibling);
    else if (logout) logout.parentElement.insertBefore(group, logout);
    else found.container.appendChild(group);
  }

  function syncPopover() {
    const existing = document.getElementById(DESKTOP_SETTINGS_ID);
    const found = findSettingsMenu();
    if (!found) return;
    if (found.items.some(el => labelOf(el) === DESKTOP_SETTINGS_LABEL || el.id === DESKTOP_SETTINGS_ID)) return;
    if (existing && found.menu.contains(existing)) return;
    if (existing) existing.remove();
    const item = desktopSettingsItem(found.template);
    const settingsItem = found.foreign.find(el => /\bsettings\b/i.test(labelOf(el)));
    if (settingsItem && settingsItem.parentElement) settingsItem.parentElement.insertBefore(item, settingsItem);
    else found.menu.appendChild(item);
  }

  function messageField() {
    return document.querySelector('textarea[aria-label="Message"]');
  }

  function findWebDictation() {
    const boundButton = document.getElementById(DICTATION_BUTTON_ID);
    if (boundButton && visible(boundButton) && !boundButton.closest('#'+DICTATION_ID)) return boundButton;
    const nodes = document.querySelectorAll('button, [role="button"]');
    const limit = Math.min(nodes.length, SCAN_LIMIT);
    for (let i = 0; i < limit; i++) {
      const el = nodes[i];
      if (el.id === DICTATION_CANCEL_ID) continue;
      if (el.closest('#'+DICTATION_ID)) continue;
      if (!visible(el)) continue;
      if (EXISTING_DICTATION.has(labelOf(el))) return el;
    }
    return null;
  }

  function composerCluster(textarea) {
    const web = findWebDictation();
    if (web && web.parentElement) return { host: web.parentElement, before: web, adopt: web };
    const send = document.querySelector('button[aria-label="Send"], button[aria-label="Send message"]');
    if (send && send.parentElement && visible(send)) return { host: send.parentElement, before: send, adopt: null };
    let node = textarea.parentElement;
    for (let depth = 0; node && depth < 6; depth++) {
      const buttons = [...node.querySelectorAll('button')].filter(el => !ours(el) && visible(el));
      if (buttons.length) {
        const trailing = buttons[buttons.length - 1];
        if (trailing.parentElement) return { host: trailing.parentElement, before: trailing, adopt: null };
      }
      node = node.parentElement;
    }
    return { host: textarea.parentElement, before: null, adopt: null };
  }

  function dictationCopy(status, error) {
    if (status === 'listening') return { label: 'Listening. Click to finish dictation', title: 'Listening' };
    if (status === 'transcribing') return { label: 'Transcribing dictation', title: 'Transcribing' };
    if (error) return { label: 'Dictate a message', title: error.slice(0, 160) };
    return { label: 'Dictate a message', title: 'Dictate a message' };
  }

  function unbindDictation() {
    const button = bound.button;
    if (button) {
      if (bound.onClick) button.removeEventListener('click', bound.onClick, true);
      if (bound.onPointer) button.removeEventListener('pointerdown', bound.onPointer, true);
      if (bound.onMouse) button.removeEventListener('mousedown', bound.onMouse, true);
      if(bound.original){
        for(const [name,value] of Object.entries(bound.original)){if(value===null)button.removeAttribute(name);else button.setAttribute(name,value);}
      }else{
        if (button.id === DICTATION_BUTTON_ID) button.removeAttribute('id');
        button.removeAttribute('data-muse-linux-bound');button.removeAttribute('data-status');
        button.removeAttribute('aria-pressed');button.removeAttribute('aria-busy');button.disabled=false;
      }
    }
    bound.button = null;
    bound.onClick = null;
    bound.onPointer = null;
    bound.onMouse = null;
    bound.original = null;
    const cancel = document.getElementById(DICTATION_CANCEL_ID);
    if (cancel) cancel.remove();
    const wrap = document.getElementById(DICTATION_ID);
    if (wrap) wrap.remove();
  }

  function ensureCancel(button) {
    let cancel = document.getElementById(DICTATION_CANCEL_ID);
    if (cancel && cancel.isConnected) return cancel;
    if (cancel) cancel.remove();
    cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.id = DICTATION_CANCEL_ID;
    cancel.setAttribute('aria-label', 'Cancel recording');
    cancel.title = 'Cancel recording';
    cancel.hidden = true;
    cancel.appendChild(svgIcon('close', 16));
    cancel.addEventListener('click', event => {
      stopEvent(event);
      call('cancelDictation');
      later(pullState, 120);
    });
    cancel.addEventListener('pointerdown', event => event.stopPropagation());
    cancel.addEventListener('mousedown', event => event.stopPropagation());
    if (button.parentElement) button.insertAdjacentElement('afterend', cancel);
    return cancel;
  }

  function paintDictation() {
    const button = document.getElementById(DICTATION_BUTTON_ID);
    const cancel = document.getElementById(DICTATION_CANCEL_ID);
    if (!button) return;
    const status = state.dictationStatus === 'listening' || state.dictationStatus === 'transcribing' ? state.dictationStatus : 'idle';
    const copy = dictationCopy(status, state.dictationError);
    button.setAttribute('data-status', status);
    button.setAttribute('aria-label', copy.label);
    button.setAttribute('title', copy.title);
    button.setAttribute('aria-pressed', status === 'listening' ? 'true' : 'false');
    if (status === 'transcribing') button.setAttribute('aria-busy', 'true');
    else button.removeAttribute('aria-busy');
    button.disabled = status === 'transcribing';
    const recording = status === 'listening' || status === 'transcribing';
    if (cancel) {
      cancel.hidden = !recording;
      cancel.tabIndex = recording ? 0 : -1;
    }
  }

  function bindWebDictation(button) {
    if (bound.button === button && button.getAttribute('data-muse-linux-bound') === '1') {
      ensureCancel(button);
      paintDictation();
      return;
    }
    if (bound.button && bound.button !== button) unbindDictation();
    bound.original=Object.fromEntries(['id','aria-label','title','disabled','aria-pressed','aria-busy','data-status','data-muse-linux-bound'].map(name=>[name,button.getAttribute(name)]));
    button.id = DICTATION_BUTTON_ID;
    button.setAttribute('data-muse-linux-bound', '1');
    const onClick = event => {
      stopEvent(event);
      if (state.dictationStatus === 'transcribing') return;
      call('dictate');
      later(pullState, 120);
    };
    const onPointer = event => event.stopPropagation();
    button.addEventListener('click', onClick, true);
    button.addEventListener('pointerdown', onPointer, true);
    button.addEventListener('mousedown', onPointer, true);
    bound.button = button;
    bound.onClick = onClick;
    bound.onPointer = onPointer;
    bound.onMouse = onPointer;
    ensureCancel(button);
    paintDictation();
  }

  function insertOwnDictation(cluster) {
    if (!cluster.host) return;
    const root = document.createElement('span');
    root.id = DICTATION_ID;
    const button = document.createElement('button');
    button.type = 'button';
    button.id = DICTATION_BUTTON_ID;
    button.setAttribute('data-muse-linux-bound', '1');
    button.appendChild(svgIcon('mic', 24));
    const sample = cluster.host.querySelector('button');
    if (sample) {
      const css = window.getComputedStyle(sample);
      if (css.width && css.width !== 'auto') button.style.width = css.width;
      if (css.height && css.height !== 'auto') button.style.height = css.height;
      if (css.borderRadius) button.style.borderRadius = css.borderRadius;
    }
    const onClick = event => {
      stopEvent(event);
      if (state.dictationStatus === 'transcribing') return;
      call('dictate');
      later(pullState, 120);
    };
    const onPointer = event => event.stopPropagation();
    button.addEventListener('click', onClick, true);
    button.addEventListener('pointerdown', onPointer, true);
    button.addEventListener('mousedown', onPointer, true);
    bound.button = button;
    bound.original = null;
    bound.onClick = onClick;
    bound.onPointer = onPointer;
    bound.onMouse = onPointer;
    root.appendChild(button);
    if (cluster.before && cluster.before.parentElement === cluster.host) cluster.host.insertBefore(root, cluster.before);
    else cluster.host.appendChild(root);
    ensureCancel(button);
    paintDictation();
  }

  function ensureDictation() {
    const textarea = messageField();
    const enabled = state.dictationEnabled === true;
    if (!enabled || !textarea || !visible(textarea)) {
      unbindDictation();
      return;
    }
    const cluster = composerCluster(textarea);
    if (cluster.adopt) {
      const ownWrap = document.getElementById(DICTATION_ID);
      if (ownWrap) ownWrap.remove();
      bindWebDictation(cluster.adopt);
      return;
    }
    const wrap = document.getElementById(DICTATION_ID);
    if (wrap && wrap.isConnected && document.getElementById(DICTATION_BUTTON_ID)) {
      paintDictation();
      return;
    }
    if (wrap) wrap.remove();
    insertOwnDictation(cluster);
  }

  function pullState() {
    const api = desktop();
    if (!api || typeof api.state !== 'function') {
      state = { dictationEnabled: false, dictationStatus: 'idle', dictationError: null, activeTask: null };
      scan();
      return;
    }
    let result;
    try { result = api.state(); } catch { scan(); return; }
    const apply = value => {
      const next = value && typeof value === 'object' ? value : {};
      state = {
        dictationEnabled: next.dictationEnabled === true,
        dictationStatus: typeof next.dictationStatus === 'string' ? next.dictationStatus : 'idle',
        dictationError: typeof next.dictationError === 'string' ? next.dictationError : null,
        activeTask: typeof next.activeTask === 'string' ? next.activeTask : null,
      };
      scan();
    };
    if (result && typeof result.then === 'function') void result.then(apply, () => apply({}));
    else apply(result);
  }

  function scan() {
    if (applying) return;
    applying = true;
    try {
      injectStyle();
      syncSidebar();
      syncPopover();
      ensureDictation();
    } catch {
    } finally {
      applying = false;
    }
  }

  function requestScan() {
    if (scanTimer) return;
    scanTimer = later(() => { scanTimer = 0; scan(); }, 80);
  }

  function schedulePoll() {
    if (pollTimer) clearLater(pollTimer);
    const busy = state.dictationStatus === 'listening' || state.dictationStatus === 'transcribing';
    pollTimer = later(() => { pollTimer = 0; pullState(); schedulePoll(); }, busy ? 400 : 1200);
  }

  function teardown() {
    if (observer) observer.disconnect();
    observer = null;
    if (scanTimer) clearLater(scanTimer);
    if (pollTimer) clearLater(pollTimer);
    scanTimer = 0;
    pollTimer = 0;
    unbindDictation();
    const style = document.getElementById(STYLE_ID);
    if (style) style.remove();
    const group = document.getElementById(SETTINGS_ID);
    if (group) group.remove();
    const desktopItem = document.getElementById(DESKTOP_SETTINGS_ID);
    if (desktopItem) desktopItem.remove();
    if (window.__museLinuxDesktopUi && window.__museLinuxDesktopUi.version === VERSION) window.__museLinuxDesktopUi = null;
  }

  injectStyle();
  scan();
  pullState();
  schedulePoll();
  observer = new window.MutationObserver(() => { if (!applying) requestScan(); });
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['class', 'style', 'hidden', 'aria-hidden'],
  });
  window.__museLinuxDesktopUi = { version: VERSION, teardown };
})();
