const electron = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const TABS = ['general', 'computer', 'files', 'dictation', 'shortcuts'];
const SETTINGS_HTML = path.join(__dirname, 'settings.html');
const SETTINGS_FILE_URL = pathToFileURL(SETTINGS_HTML).href;
const PRELOAD = path.join(__dirname, 'settings-preload.cjs');

function resolveTab(tab) {
  return TABS.includes(tab) ? tab : 'computer';
}

function allowedUrl(url) {
  try { return new URL(url).href.split('?')[0] === SETTINGS_FILE_URL; } catch { return false; }
}

function themeBackground() {
  return electron.nativeTheme?.shouldUseDarkColors ? '#171717' : '#faf9f6';
}

class SettingsPanel {
  constructor({ parent, onClose } = {}) {
    this.parent = parent;
    this.onClose = onClose;
    this.view = null;
    this.attached = false;
    this.wanted = false;
    this.loaded = false;
    this.dead = false;
    this.token = 0;
    this.requestedTab = 'computer';
    this.loading = null;
    this.loadingView = null;
    this.queue = Promise.resolve();
    this.hostWindow = null;
    this.closedHandler = null;
    this.resizeHandler = null;
    this.resizeHost = null;
    const host = this.host();
    if (host) this.watchHost(host);
  }

  get visible() {
    return !this.dead && this.attached;
  }

  get webContents() {
    const contents = this.view?.webContents;
    if (!contents || contents.isDestroyed()) return null;
    return contents;
  }

  isDestroyed() {
    return this.dead;
  }

  host() {
    if (this.dead) return null;
    let value = this.parent;
    if (typeof value === 'function') {
      try { value = value(); } catch { return null; }
    }
    if (!value || typeof value.isDestroyed === 'function' && value.isDestroyed()) return null;
    return value;
  }

  watchHost(host) {
    if (!host || this.hostWindow === host) return;
    this.unwatchHost();
    this.hostWindow = host;
    this.closedHandler = () => this.destroy();
    host.on('closed', this.closedHandler);
  }

  unwatchHost() {
    if (this.hostWindow && this.closedHandler) {
      try { this.hostWindow.removeListener('closed', this.closedHandler); } catch { /* host may already be gone */ }
    }
    this.hostWindow = null;
    this.closedHandler = null;
  }

  bindGuards(contents) {
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.on('will-attach-webview', event => event.preventDefault());
    const block = (event, url) => { if (!allowedUrl(url)) event.preventDefault(); };
    contents.on('will-navigate', block);
    contents.on('will-redirect', block);
    contents.on('render-process-gone', () => {
      if (this.dead) return;
      this.hide();
      this.dropView();
    });
  }

  createView() {
    const View = electron.WebContentsView;
    if (typeof View !== 'function') throw Error('web_contents_view_unavailable');
    const view = new View({
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        preload: PRELOAD,
      },
    });
    const contents = view.webContents;
    if (!contents) throw Error('settings_view_unavailable');
    if (typeof view.setBackgroundColor === 'function') view.setBackgroundColor(themeBackground());
    this.bindGuards(contents);
    this.view = view;
    this.loaded = false;
    return view;
  }

  dropView() {
    const view = this.view;
    this.view = null;
    this.loaded = false;
    if (this.loadingView === view) {
      this.loading = null;
      this.loadingView = null;
    }
    if (!view) return;
    try {
      const contents = view.webContents;
      if (contents && !contents.isDestroyed()) contents.close();
    } catch { /* renderer may already be gone */ }
  }

  syncBounds() {
    if (!this.attached || !this.view) return;
    const host = this.host();
    if (!host) return;
    let width = 0;
    let height = 0;
    if (typeof host.getContentBounds === 'function') {
      const bounds = host.getContentBounds() || {};
      width = bounds.width;
      height = bounds.height;
    } else if (typeof host.getContentSize === 'function') {
      [width, height] = host.getContentSize();
    }
    this.view.setBounds({ x: 0, y: 0, width: Math.max(1, width || 0), height: Math.max(1, height || 0) });
  }

  bindResize(host) {
    if (this.resizeHandler) return;
    this.resizeHandler = () => this.syncBounds();
    this.resizeHost = host;
    host.on('resize', this.resizeHandler);
  }

  unbindResize() {
    if (!this.resizeHandler) return;
    try { this.resizeHost?.removeListener('resize', this.resizeHandler); } catch { /* host may already be gone */ }
    this.resizeHandler = null;
    this.resizeHost = null;
  }

  attach(host) {
    if (this.attached || !this.view) return;
    host.contentView.addChildView(this.view);
    this.attached = true;
    this.bindResize(host);
    this.syncBounds();
  }

  detach() {
    const view = this.view;
    const host = this.resizeHost;
    const was = this.attached;
    this.unbindResize();
    this.attached = false;
    if (!was || !view) return;
    try {
      const target = host && !(typeof host.isDestroyed === 'function' && host.isDestroyed()) ? host : this.host();
      target?.contentView?.removeChildView(view);
    } catch { /* parent may already be gone */ }
  }

  async selectTab(name) {
    const contents = this.webContents;
    if (!contents) return;
    await contents.executeJavaScript(`document.getElementById(${JSON.stringify('tab-' + name)})?.click()`);
  }

  focusView() {
    this.webContents?.focus();
  }

  focusChat() {
    const host = this.host();
    const chat = host?.webContents;
    if (!chat || typeof chat.isDestroyed === 'function' && chat.isDestroyed()) return;
    if (typeof chat.focus === 'function') chat.focus();
  }

  stale(token) {
    return this.dead || token !== this.token || !this.wanted;
  }

  async ensureLoaded(name) {
    if (!this.view) this.createView();
    const view = this.view;
    const contents = view?.webContents;
    if (!contents || contents.isDestroyed()) throw Error('settings_view_unavailable');
    const tab = this.requestedTab || name;
    if (this.loaded) {
      await this.selectTab(tab);
      return;
    }
    if (!this.loading || this.loadingView !== view) {
      this.loadingView = view;
      this.loading = contents.loadFile(SETTINGS_HTML, { query: { tab } });
    }
    try {
      await this.loading;
    } catch (error) {
      if (this.loadingView === view) {
        this.loading = null;
        this.loadingView = null;
      }
      if (this.view !== view) return;
      throw error;
    }
    if (this.view !== view) return;
    this.loaded = true;
    if (this.loadingView === view) {
      this.loading = null;
      this.loadingView = null;
    }
    await this.selectTab(this.requestedTab || name);
  }

  async show(tab = 'computer') {
    if (this.dead) throw Error('settings_destroyed');
    const host = this.host();
    if (!host) throw Error('settings_parent_unavailable');
    this.watchHost(host);
    this.wanted = true;
    const token = ++this.token;
    const name = resolveTab(tab);
    this.requestedTab = name;
    const work = async () => {
      if (this.stale(token)) return;
      try {
        await this.ensureLoaded(name);
        if (this.stale(token)) return;
        this.attach(host);
      } catch (error) {
        if (this.stale(token)) return;
        this.detach();
        this.dropView();
        throw error;
      }
      if (this.stale(token)) return;
      this.focusView();
    };
    const run = this.queue.then(work, work);
    this.queue = run.catch(() => {});
    return run;
  }

  hide() {
    if (this.dead) return;
    this.wanted = false;
    this.token++;
    const wasVisible = this.attached;
    this.detach();
    this.focusChat();
    if (wasVisible && typeof this.onClose === 'function') this.onClose();
  }

  destroy() {
    if (this.dead) return;
    this.dead = true;
    this.wanted = false;
    this.token++;
    this.detach();
    this.unwatchHost();
    this.dropView();
  }
}

module.exports = { SettingsPanel };
