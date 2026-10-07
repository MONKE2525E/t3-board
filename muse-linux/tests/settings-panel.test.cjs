const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');

const PANEL_FILE = path.join(__dirname, '../src/settings-panel.cjs');
const SETTINGS_HTML = path.join(__dirname, '../src/settings.html');
const SETTINGS_PRELOAD = path.join(__dirname, '../src/settings-preload.cjs');
const SETTINGS_FILE_URL = pathToFileURL(SETTINGS_HTML).href;

function loadPanel(electron) {
  const realRequire = createRequire(PANEL_FILE);
  const moduleFixture = { exports: {} };
  vm.runInThisContext('(function(require,module,exports,__dirname,__filename){' + fs.readFileSync(PANEL_FILE, 'utf8') + '\n})', { filename: PANEL_FILE })(
    id => id === 'electron' ? electron : realRequire(id),
    moduleFixture,
    moduleFixture.exports,
    path.dirname(PANEL_FILE),
    PANEL_FILE,
  );
  return moduleFixture.exports.SettingsPanel;
}

function finishLoad(contents, query = { tab: 'computer' }) {
  const url = new URL(SETTINGS_FILE_URL);
  url.search = new URLSearchParams(query).toString();
  contents.url = url.href;
  contents.mainFrame.url = url.href;
}

function createElectron(opts = {}) {
  const views = [];
  class WebContentsView {
    constructor(options) {
      this.options = options;
      this.bounds = null;
      this.backgroundColor = null;
      this.webContents = new EventEmitter();
      const contents = this.webContents;
      contents.destroyed = false;
      contents.loads = [];
      contents.executed = [];
      contents.focused = 0;
      contents.url = '';
      contents.mainFrame = { url: '' };
      contents.windowOpenHandler = null;
      contents.isDestroyed = () => contents.destroyed;
      contents.setWindowOpenHandler = fn => { contents.windowOpenHandler = fn; };
      contents.focus = () => { contents.focused++; };
      contents.close = () => { contents.destroyed = true; };
      contents.executeJavaScript = async code => { contents.executed.push(code); };
      contents.loadFile = async (file, options) => {
        contents.loads.push({ file, query: options?.query });
        if (opts.loadFile) return opts.loadFile(file, options, contents);
        finishLoad(contents, options?.query);
      };
      this.setBackgroundColor = color => { this.backgroundColor = color; };
      views.push(this);
    }
    setBounds(bounds) { this.bounds = bounds; }
  }
  return {
    WebContentsView,
    nativeTheme: { shouldUseDarkColors: !!opts.dark },
    views,
  };
}

function createParent(size = { width: 860, height: 650 }) {
  const parent = new EventEmitter();
  parent.destroyed = false;
  parent.osFocused = 0;
  parent.chatFocused = 0;
  parent.isDestroyed = () => parent.destroyed;
  parent.focus = () => { parent.osFocused++; };
  parent.getContentBounds = () => ({ x: 12, y: 34, width: size.width, height: size.height });
  parent.getContentSize = () => [size.width, size.height];
  parent.contentView = {
    children: [],
    addChildView(view) { this.children.push(view); },
    removeChildView(view) { this.children = this.children.filter(item => item !== view); },
  };
  parent.webContents = {
    destroyed: false,
    isDestroyed() { return this.destroyed; },
    focus() { parent.chatFocused++; },
  };
  parent.destroyHost = () => {
    parent.destroyed = true;
    parent.emit('closed');
  };
  return parent;
}

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
}

test('eager require survives electron mocks without WebContentsView', () => {
  const { SettingsPanel } = require('../src/settings-panel.cjs');
  const panel = new SettingsPanel({ parent: () => null });
  assert.equal(panel.webContents, null);
  assert.equal(panel.visible, false);
  assert.equal(panel.isDestroyed(), false);
  const Missing = loadPanel({ nativeTheme: { shouldUseDarkColors: false } });
  const pending = new Missing({ parent: createParent() });
  assert.equal(pending.webContents, null);
});

test('constructor leaves webContents null until show and never builds BrowserWindow', async () => {
  const electron = createElectron();
  const SettingsPanel = loadPanel(electron);
  const parent = createParent();
  const panel = new SettingsPanel({ parent: () => parent });
  assert.equal(panel.webContents, null);
  assert.equal(electron.views.length, 0);
  assert.equal(electron.BrowserWindow, undefined);
  await panel.show();
  assert.equal(electron.views.length, 1);
  const prefs = electron.views[0].options.webPreferences;
  assert.equal(prefs.sandbox, true);
  assert.equal(prefs.contextIsolation, true);
  assert.equal(prefs.nodeIntegration, false);
  assert.equal(prefs.webSecurity, true);
  assert.equal(prefs.preload, SETTINGS_PRELOAD);
  assert.equal(electron.views[0].backgroundColor, '#faf9f6');
  assert.equal(panel.webContents, electron.views[0].webContents);
  assert.equal(panel.webContents.mainFrame.url.split('?')[0], SETTINGS_FILE_URL);
  panel.destroy();
});

test('repeated show reuses one view and selects a tab without reload', async () => {
  const electron = createElectron();
  const SettingsPanel = loadPanel(electron);
  const parent = createParent();
  const panel = new SettingsPanel({ parent });
  await panel.show('computer');
  const view = electron.views[0];
  const contents = view.webContents;
  assert.equal(panel.visible, true);
  assert.deepEqual(parent.contentView.children, [view]);
  assert.deepEqual(contents.loads, [{ file: SETTINGS_HTML, query: { tab: 'computer' } }]);
  contents.executed.length = 0;
  await panel.show('files');
  assert.equal(electron.views.length, 1);
  assert.equal(panel.webContents, contents);
  assert.equal(contents.loads.length, 1);
  assert.equal(contents.executed.length, 1);
  assert.match(contents.executed[0], /tab-files/);
  assert.equal(parent.osFocused, 0);
  assert.ok(contents.focused > 0);
  panel.destroy();
});

test('resize hide and show refill bounds and restore chat focus', async () => {
  const electron = createElectron();
  const SettingsPanel = loadPanel(electron);
  const parent = createParent({ width: 800, height: 600 });
  let closed = 0;
  const panel = new SettingsPanel({ parent: () => parent, onClose: () => closed++ });
  await panel.show('general');
  const view = electron.views[0];
  assert.deepEqual(view.bounds, { x: 0, y: 0, width: 800, height: 600 });
  parent.getContentBounds = () => ({ x: 0, y: 0, width: 1024, height: 768 });
  parent.emit('resize');
  assert.deepEqual(view.bounds, { x: 0, y: 0, width: 1024, height: 768 });
  panel.hide();
  assert.equal(panel.visible, false);
  assert.deepEqual(parent.contentView.children, []);
  assert.equal(parent.chatFocused, 1);
  assert.equal(parent.osFocused, 0);
  assert.equal(closed, 1);
  parent.emit('resize');
  assert.deepEqual(view.bounds, { x: 0, y: 0, width: 1024, height: 768 });
  await panel.show('dictation');
  assert.equal(panel.visible, true);
  assert.deepEqual(parent.contentView.children, [view]);
  assert.equal(electron.views.length, 1);
  assert.equal(view.webContents.loads.length, 1);
  assert.match(view.webContents.executed.at(-1), /tab-dictation/);
  assert.deepEqual(view.bounds, { x: 0, y: 0, width: 1024, height: 768 });
  panel.destroy();
});

test('pending hide during load does not attach over chat', async () => {
  let release;
  const electron = createElectron({
    loadFile: (_file, query, contents) => new Promise(resolve => {
      release = () => { finishLoad(contents, query?.query); resolve(); };
    }),
  });
  const SettingsPanel = loadPanel(electron);
  const parent = createParent();
  const panel = new SettingsPanel({ parent });
  const pending = panel.show('computer');
  await flush();
  assert.equal(electron.views.length, 1);
  assert.equal(panel.visible, false);
  panel.hide();
  release();
  await pending;
  assert.equal(panel.visible, false);
  assert.deepEqual(parent.contentView.children, []);
  assert.equal(panel.isDestroyed(), false);
  panel.destroy();
});

test('immediate queued show then destroy does not create an orphan view', async () => {
  const electron = createElectron();
  const SettingsPanel = loadPanel(electron);
  const parent = createParent();
  const panel = new SettingsPanel({ parent });
  const pending = panel.show('computer');
  panel.destroy();
  await pending;
  assert.equal(panel.isDestroyed(), true);
  assert.equal(panel.visible, false);
  assert.equal(panel.webContents, null);
  assert.equal(electron.views.length, 0);
  assert.deepEqual(parent.contentView.children, []);
});

test('immediate queued show then hide never loads a view', async () => {
  const electron = createElectron();
  const SettingsPanel = loadPanel(electron);
  const parent = createParent();
  const panel = new SettingsPanel({ parent });
  const pending = panel.show('shortcuts');
  panel.hide();
  await pending;
  assert.equal(panel.visible, false);
  assert.equal(panel.isDestroyed(), false);
  assert.equal(electron.views.length, 0);
  assert.equal(parent.osFocused, 0);
  panel.destroy();
});

test('concurrent show loads once and selects the latest tab', async () => {
  let release;
  const electron = createElectron({
    loadFile: (_file, options, contents) => new Promise(resolve => {
      release = () => { finishLoad(contents, options?.query); resolve(); };
    }),
  });
  const SettingsPanel = loadPanel(electron);
  const parent = createParent();
  const panel = new SettingsPanel({ parent });
  const first = panel.show('computer');
  await flush();
  assert.equal(electron.views.length, 1);
  assert.deepEqual(electron.views[0].webContents.loads[0].query, { tab: 'computer' });
  const second = panel.show('files');
  release();
  await Promise.all([first, second]);
  const contents = electron.views[0].webContents;
  assert.equal(electron.views.length, 1);
  assert.equal(contents.loads.length, 1);
  assert.equal(panel.visible, true);
  assert.match(contents.executed.at(-1), /tab-files/);
  panel.destroy();
});

test('stale load rejection does not detach a newer show', async () => {
  const loads = [];
  let rejectFirst;
  const electron = createElectron({
    loadFile: (_file, options, contents) => new Promise((resolve, reject) => {
      loads.push({ options, resolve: () => { finishLoad(contents, options?.query); resolve(); }, reject });
      if (!rejectFirst) rejectFirst = reject;
    }),
  });
  const SettingsPanel = loadPanel(electron);
  const parent = createParent();
  const panel = new SettingsPanel({ parent });
  const first = panel.show('computer');
  await flush();
  const second = panel.show('general');
  rejectFirst(Error('load_failed'));
  await first;
  assert.equal(panel.visible, false);
  assert.equal(electron.views.length, 1);
  assert.deepEqual(parent.contentView.children, []);
  loads[1].resolve();
  await second;
  assert.equal(panel.visible, true);
  assert.equal(electron.views.length, 1);
  assert.deepEqual(parent.contentView.children, [electron.views[0]]);
  assert.equal(parent.osFocused, 0);
  panel.destroy();
});

test('old load completion after crash does not mark a replacement view loaded', async () => {
  let release;
  const electron = createElectron({
    loadFile: (_file, options, contents) => new Promise(resolve => {
      release = () => { finishLoad(contents, options?.query); resolve(); };
    }),
  });
  const SettingsPanel = loadPanel(electron);
  const parent = createParent();
  const panel = new SettingsPanel({ parent });
  const first = panel.show('computer');
  await flush();
  const crashed = electron.views[0];
  crashed.webContents.emit('render-process-gone');
  release();
  await first;
  assert.equal(panel.visible, false);
  assert.equal(panel.isDestroyed(), false);
  const second = panel.show('dictation');
  await flush();
  release();
  await second;
  assert.equal(electron.views.length, 2);
  assert.equal(panel.webContents, electron.views[1].webContents);
  assert.equal(electron.views[1].webContents.loads.length, 1);
  assert.deepEqual(parent.contentView.children, [electron.views[1]]);
  panel.destroy();
});

test('parent closed destroys the panel and load failure detaches', async () => {
  const electron = createElectron({
    loadFile: async () => { throw Error('disk_missing'); },
  });
  const SettingsPanel = loadPanel(electron);
  const parent = createParent();
  const panel = new SettingsPanel({ parent });
  await assert.rejects(panel.show('computer'), /disk_missing/);
  assert.equal(panel.visible, false);
  assert.deepEqual(parent.contentView.children, []);
  assert.equal(panel.webContents, null);
  const ok = createElectron();
  const SettingsPanelOk = loadPanel(ok);
  const live = createParent();
  const other = new SettingsPanelOk({ parent: () => live });
  await other.show();
  live.destroyHost();
  assert.equal(other.isDestroyed(), true);
  assert.equal(other.visible, false);
  assert.equal(other.webContents, null);
  other.hide();
});

test('navigation webviews and window.open stay on the settings file URL', async () => {
  const electron = createElectron();
  const SettingsPanel = loadPanel(electron);
  const parent = createParent();
  const panel = new SettingsPanel({ parent });
  await panel.show();
  const contents = panel.webContents;
  assert.deepEqual(contents.windowOpenHandler({ url: 'https://example.com' }), { action: 'deny' });
  const blocked = { prevented: false, preventDefault() { this.prevented = true; } };
  contents.emit('will-navigate', blocked, 'https://muse.ai/');
  assert.equal(blocked.prevented, true);
  const allowed = { prevented: false, preventDefault() { this.prevented = true; } };
  contents.emit('will-navigate', allowed, SETTINGS_FILE_URL + '?tab=files');
  assert.equal(allowed.prevented, false);
  const redirect = { prevented: false, preventDefault() { this.prevented = true; } };
  contents.emit('will-redirect', redirect, 'file:///etc/passwd');
  assert.equal(redirect.prevented, true);
  const webview = { prevented: false, preventDefault() { this.prevented = true; } };
  contents.emit('will-attach-webview', webview);
  assert.equal(webview.prevented, true);
  assert.equal(parent.osFocused, 0);
  panel.destroy();
});
