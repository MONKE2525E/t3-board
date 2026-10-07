const api = window.museLinuxSettings;
const $ = id => document.getElementById(id);
const TABS = ['general', 'computer', 'files', 'dictation', 'shortcuts'];
const TITLES = {
  general: 'General',
  computer: 'Computer use',
  files: 'File system access',
  dictation: 'Dictation',
  shortcuts: 'Keyboard shortcuts',
};
const SHORTCUT_HELP = {
  quickShortcut: 'Bring Muse to the front',
  dictationShortcut: 'Start and stop typing with your voice',
};
const SHORTCUT_STATUS = {
  conflict: 'This shortcut is already used',
  unavailable: "This shortcut couldn't be registered",
};

let current = {};
let tab = 'computer';
let recording = null;
let blocked = [];
let connectingBrowser = false;
let preparingIsolation = false;

const applyTheme = theme => {
  if (theme === 'light' || theme === 'dark') document.documentElement.setAttribute('data-theme', theme);
  else document.documentElement.removeAttribute('data-theme');
};

const idle = el => el !== document.activeElement && !el.contains(document.activeElement);

const setCheck = (id, value) => {
  const el = $(id);
  if (idle(el)) el.checked = !!value;
};

const setSelect = (id, value, enabled = true) => {
  const el = $(id);
  el.disabled = !enabled;
  if (idle(el) && value != null) el.value = value;
};

const appLabel = id => String(id).split('.').pop().replace(/[-_]+/g, ' ') || id;

const shortcutLabel = value => value || 'Off';

const accelerator = event => {
  const mods = [];
  if (event.ctrlKey) mods.push('Control');
  if (event.altKey) mods.push('Alt');
  if (event.shiftKey) mods.push('Shift');
  if (event.metaKey) mods.push('Super');
  let key = event.key;
  if (key === ' ') key = 'Space';
  else if (/^F([1-9]|1[0-2])$/.test(key)) key = key;
  else if (key.length === 1 && /[a-zA-Z0-9]/.test(key)) key = key.toUpperCase();
  else return '';
  return mods.length ? mods.join('+') + '+' + key : '';
};

const showTab = name => {
  if (!TABS.includes(name)) name = 'computer';
  tab = name;
  for (const id of TABS) {
    const selected = id === name;
    const button = $('tab-' + id);
    button.setAttribute('aria-selected', String(selected));
    button.tabIndex = selected ? 0 : -1;
    $('panel-' + id).hidden = !selected;
  }
  $('pane-title').textContent = TITLES[name];
};

const run = async fn => {
  try {
    $('error').textContent = '';
    await fn();
    await refresh();
  } catch {
    $('error').textContent = "Couldn't update this setting. Try again.";
  }
};

const setPreference = (key, value) => run(() => api.preference(key, value));

const beginRecord = (key, button) => {
  recording = key;
  button.textContent = 'Recording';
  button.setAttribute('aria-pressed', 'true');
};

const endRecord = () => {
  if (!recording) return;
  const key = recording;
  recording = null;
  const button = $(key === 'quickShortcut' ? 'quick-shortcut' : 'dictation-shortcut');
  button.setAttribute('aria-pressed', 'false');
  button.textContent = shortcutLabel(current[key]);
};

const renderBlocked = apps => {
  blocked = Array.isArray(apps) ? apps.filter(value => typeof value === 'string') : [];
  const list = $('blocked-list');
  const signature = blocked.join('\0');
  if (list.dataset.ids === signature && list.contains(document.activeElement)) return;
  list.dataset.ids = signature;
  list.replaceChildren();
  if (!blocked.length) {
    const empty = document.createElement('div');
    empty.className = 'row muted';
    empty.textContent = 'None';
    list.appendChild(empty);
    return;
  }
  for (const app of blocked) {
    const row = document.createElement('div');
    row.className = 'row';
    const name = document.createElement('span');
    name.className = 'row-title';
    name.textContent = appLabel(app);
    name.title = app;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = 'Remove';
    remove.setAttribute('aria-label', 'Remove ' + appLabel(app) + ' from blocked apps');
    remove.addEventListener('click', () => setPreference('blockedApps', blocked.filter(item => item !== app)));
    row.append(name, remove);
    list.appendChild(row);
  }
};

const renderActivity = state => {
  const speech = state.dictation || {};
  const terminals = Number(state.terminalCount) || 0;
  const parts = [];
  if (state.activeTask) parts.push(state.activeTask);
  else if (speech.status === 'listening') parts.push('Listening for dictation');
  else if (speech.status === 'transcribing') parts.push('Transcribing dictation');
  if (terminals > 0) parts.push(terminals === 1 ? '1 terminal session' : terminals + ' terminal sessions');
  const active = parts.length > 0;
  $('activity').hidden = !active;
  if (active) $('activity-label').textContent = parts.join(' · ');
};

const renderDictation = (state, speech) => {
  const enabled = !!state.dictationEnabled;
  const ready = !!speech.ready;
  const status = speech.status || 'idle';
  const downloading = status === 'downloading';
  $('speech-progress-row').hidden = !downloading;
  $('speech-row').hidden = downloading;
  $('speech-progress').value = Number(speech.progress) || 0;
  $('speech-progress-label').textContent = (Number(speech.progress) || 0) + '%';
  if (ready) {
    $('speech-title').textContent = 'Speech setup';
    $('speech-detail').textContent = 'Local speech is ready';
    $('speech-action').hidden = true;
  } else if (speech.error) {
    $('speech-title').textContent = 'Speech setup';
    $('speech-detail').textContent = speech.error;
    $('speech-action').hidden = false;
    $('speech-action').textContent = 'Retry';
  } else {
    $('speech-title').textContent = 'Speech setup';
    $('speech-detail').textContent = 'Download a local model to type with your voice';
    $('speech-action').hidden = false;
    $('speech-action').textContent = 'Download';
  }
  const busy = status === 'listening' || status === 'transcribing';
  $('dictate').disabled = !enabled || !ready || downloading;
  $('dictate').textContent = status === 'listening' ? 'Stop dictation' : status === 'transcribing' ? 'Transcribing' : 'Start dictation';
  $('cancel-dictation').hidden = !busy;
  $('dictation-language').disabled = !enabled;
  $('dictation-auto-send').disabled = !enabled;
  if (status === 'listening') $('dictation-status').textContent = 'Listening';
  else if (status === 'transcribing') $('dictation-status').textContent = 'Transcribing';
  else if (speech.error && ready) $('dictation-status').textContent = speech.error;
  else if (ready) $('dictation-status').textContent = 'Dictation is ready';
  else $('dictation-status').textContent = 'Ready when the speech model is installed';
};

const renderAbout = state => {
  $('about-version').textContent = 'Version ' + (state.version || '');
  $('about-connection').textContent = state.connection === 'connected'
    ? 'Connected to Muse'
    : state.connection === 'rejected'
      ? 'Muse rejected this device'
      : 'Waiting for a signed-in Muse connection';
  const limits = [
    'Credential paths stay private. Text files up to 256 KiB, other files up to 8 MiB.',
  ];
  if (state.desktopAvailable === false) limits.push('Native app control needs Hyprland accessibility.');
  if (state.commandAvailable === false) limits.push("Code execution isn't available in this session.");
  if (state.claudeAvailable === false) limits.push("Claude Code isn't connected.");
  $('about-limits').textContent = limits.join(' ');
};

const renderShortcut = (key, buttonId, helpId, state) => {
  const button = $(buttonId);
  if (recording !== key && idle(button)) button.textContent = shortcutLabel(state[key]);
  const status = state.shortcutStatus && state.shortcutStatus[key];
  $(helpId).textContent = SHORTCUT_STATUS[status] || SHORTCUT_HELP[key];
};

const paint = state => {
  current = state;
  applyTheme(state.theme);
  setSelect('theme', state.theme || 'system');
  setCheck('start-at-login', state.startAtLogin);
  setCheck('keep-awake', state.keepAwake);
  setSelect('browser-policy', state.browserPolicy || 'deny');
  setSelect('desktop-policy', state.desktopPolicy || 'ask', state.desktopAvailable !== false);
  $('desktop-note').textContent = state.desktopAvailable === false
    ? 'Native app control needs Hyprland accessibility'
    : 'Click, type, and read windows Muse is allowed to use';
  setSelect('command-policy', state.commandPolicy || 'deny', state.commandAvailable !== false);
  const commandNote = $('command-note');
  if (state.commandAvailable === false) commandNote.textContent = "Code execution isn't available in this session";
  else commandNote.textContent = 'Allow scripts and terminal sessions';
  renderBlocked(state.blockedApps);
  const folder = state.folder;
  $('folder-path').textContent = folder === '/' ? 'All files' : folder || 'No folder selected';
  setCheck('remember-folder', state.rememberFolder !== false);
  setSelect('file-write-policy', state.fileWritePolicy || 'ask');
  setCheck('dictation-enabled', state.dictationEnabled);
  setSelect('dictation-language', state.dictationLanguage || 'auto', !!state.dictationEnabled);
  setCheck('dictation-auto-send', state.dictationAutoSend);
  renderDictation(state, state.dictation || {});
  renderShortcut('quickShortcut', 'quick-shortcut', 'quick-shortcut-status', state);
  renderShortcut('dictationShortcut', 'dictation-shortcut', 'dictation-shortcut-status', state);
  renderActivity(state);
  renderControlSessions(state);
  renderAbout(state);
};

const renderControlSessions = state => {
  const control = state.computerControl || {};
  $('control-recovery-row').hidden = !control.startup_review_required && control.state !== 'paused';
  $('control-recovery-title').textContent = control.startup_review_required ? 'Previous task needs review' : 'Control paused';
  $('control-recovery-status').textContent = control.startup_review_required
    ? `${control.unresolved_actions || 0} actions have unverified results. Starting a new task leaves those results unknown and does not replay them.`
    : 'Resume grants control again. Muse must observe fresh state before its next action.';
  $('resume-control').textContent = control.startup_review_required ? 'Start fresh' : 'Resume';
  const connection = state.browserConnection || {};
  const connected = connection.status === 'ready';
  $('connect-browser').hidden = connected;
  $('disconnect-browser').hidden = !connected;
  $('connect-browser').disabled = connectingBrowser || connection.available === false;
  $('connect-browser').textContent = connectingBrowser ? 'Connecting…' : 'Connect Chrome';
  $('browser-connection-status').textContent = connected
    ? (connection.label || 'Connected tab') + '. Existing sign-in is preserved.'
    : connection.message || 'Use an existing Chrome tab with its current sign-in';
  const isolated = state.isolation || {};
  $('isolation-status').textContent = isolated.message || (isolated.active
    ? 'Ready. Tasks stay inside this desktop.'
    : 'Private app input with fresh profiles. No desktop viewer yet.');
  $('prepare-isolation').disabled = preparingIsolation || isolated.available === false || isolated.active === true;
  $('prepare-isolation').textContent = preparingIsolation ? 'Preparing…' : isolated.active ? 'Ready' : 'Set up';
};

$('resume-control').addEventListener('click', () => run(async () => {
  const state = await api.state();
  await api.control({ action: state.computerControl?.startup_review_required ? 'review' : 'resume' });
}));

const connectBrowser = async () => {
  if (connectingBrowser) return;
  connectingBrowser = true;
  $('browser-connection-setup').hidden = true;
  $('browser-tab-picker').hidden = true;
  renderControlSessions(current);
  try {
    const result = await api.browserConnection({ action: 'list' });
    if (result.status === 'attachment_required') {
      $('browser-connection-setup').hidden = false;
      $('browser-connection-status').textContent = 'Chrome needs your approval before Muse can connect.';
      return;
    }
    if (result.status === 'ready') return;
    if (result.status !== 'choose_tab') throw new Error(result.error || 'browser_connection_failed');
    const picker = $('browser-tab-picker');
    picker.replaceChildren();
    const caption = document.createElement('p');
    caption.className = 'hint';
    caption.textContent = 'Choose the tab Muse may use. Other tabs stay outside this connection.';
    picker.appendChild(caption);
    for (const target of result.tabs || []) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'tab-choice';
      const title = document.createElement('span');
      title.textContent = target.title || 'Untitled tab';
      const origin = document.createElement('small');
      origin.textContent = target.origin || '';
      button.append(title, origin);
      button.addEventListener('click', () => run(async () => {
        button.disabled = true;
        try { await api.browserConnection({ action: 'select', token: target.token }); picker.hidden = true; }
        finally { button.disabled = false; }
      }));
      picker.appendChild(button);
    }
    picker.hidden = false;
    if (!result.tabs?.length) caption.textContent = 'No supported tabs are available. Open a website in Chrome and try again.';
  } catch {
    $('browser-connection-status').textContent = 'Chrome could not connect. Check its connection request and try again.';
    $('browser-connection-setup').hidden = false;
  } finally { connectingBrowser = false; $('connect-browser').disabled = false; $('connect-browser').textContent = 'Connect Chrome'; }
};

const refresh = async () => {
  paint(await api.state());
};

const bindPref = (id, read) => {
  $(id).addEventListener('change', event => {
    const value = read(event.target);
    if (id === 'theme') applyTheme(value);
    void setPreference(event.target.getAttribute('data-pref'), value);
  });
};

bindPref('theme', el => el.value);
bindPref('start-at-login', el => el.checked);
bindPref('keep-awake', el => el.checked);
bindPref('browser-policy', el => el.value);
bindPref('desktop-policy', el => el.value);
bindPref('command-policy', el => el.value);
bindPref('remember-folder', el => el.checked);
bindPref('file-write-policy', el => el.value);
bindPref('dictation-enabled', el => el.checked);
bindPref('dictation-language', el => el.value);
bindPref('dictation-auto-send', el => el.checked);

for (const id of TABS) {
  $('tab-' + id).addEventListener('click', () => showTab(id));
}

$('tab-general').parentElement.addEventListener('keydown', event => {
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const index = TABS.indexOf(tab);
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? TABS.length - 1 : event.key === 'ArrowDown' ? (index + 1) % TABS.length : (index - 1 + TABS.length) % TABS.length;
  showTab(TABS[next]);
  $('tab-' + TABS[next]).focus();
});

$('close').addEventListener('click', () => run(() => api.close()));
$('stop').addEventListener('click', () => run(() => api.stop()));
$('connect-browser').addEventListener('click', () => { void connectBrowser(); });
$('retry-browser').addEventListener('click', () => { void connectBrowser(); });
$('disconnect-browser').addEventListener('click', () => run(async () => {
  await api.browserConnection({ action: 'disconnect' });
  $('browser-tab-picker').hidden = true;
}));
$('prepare-isolation').addEventListener('click', () => run(async () => {
  if (preparingIsolation) return;
  preparingIsolation = true;
  renderControlSessions(current);
  try { await api.isolation({ action: 'prepare' }); }
  finally { preparingIsolation = false; }
}));
$('choose-folder').addEventListener('click', () => run(() => api.folder()));
$('all-files').addEventListener('click', () => run(() => api.folder('all')));
$('revoke-folder').addEventListener('click', () => run(() => api.revokeFolder()));
$('speech-action').addEventListener('click', () => run(() => api.downloadSpeech()));
$('dictate').addEventListener('click', () => run(() => api.dictate()));
$('cancel-dictation').addEventListener('click', () => run(() => api.cancelDictation()));

const recordButton = (key, button) => {
  if (recording === key) {
    endRecord();
    return;
  }
  beginRecord(key, button);
};
$('quick-shortcut').addEventListener('click', event => recordButton('quickShortcut', event.currentTarget));
$('dictation-shortcut').addEventListener('click', event => recordButton('dictationShortcut', event.currentTarget));

window.addEventListener('keydown', event => {
  if (!recording) return;
  event.preventDefault();
  if (event.key === 'Escape') {
    endRecord();
    return;
  }
  if (event.key === 'Backspace' || event.key === 'Delete') {
    const key = recording;
    endRecord();
    void setPreference(key, '');
    return;
  }
  if (['Control', 'Alt', 'Shift', 'Meta'].includes(event.key)) return;
  const value = accelerator(event);
  const key = recording;
  endRecord();
  if (value) void setPreference(key, value);
});

window.addEventListener('keydown', event => {
  if (event.key !== 'Escape' || event.defaultPrevented) return;
  if (document.querySelector('dialog[open]')) return;
  if (document.activeElement?.tagName === 'SELECT') return;
  event.preventDefault();
  void run(() => api.close());
});

$('add-app').addEventListener('click', async () => {
  const picker = $('app-picker');
  const list = $('app-picker-list');
  const empty = $('app-picker-empty');
  list.replaceChildren();
  empty.hidden = true;
  try {
    const apps = await api.apps();
    const unique = [...new Set((Array.isArray(apps) ? apps : [])
      .map(item => typeof item === 'string' ? item : item && item.app)
      .filter(app => app && !blocked.includes(app)))];
    if (!unique.length) empty.hidden = false;
    for (const app of unique) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = appLabel(app);
      button.title = app;
      button.addEventListener('click', () => {
        picker.close();
        void setPreference('blockedApps', blocked.concat(app));
      });
      list.appendChild(button);
    }
  } catch {
    empty.hidden = false;
    empty.textContent = "Couldn't list running apps.";
  }
  picker.showModal();
});

showTab(new URLSearchParams(location.search).get('tab') || 'computer');
void refresh();
setInterval(() => { void refresh().catch(() => {}); }, 2000);
