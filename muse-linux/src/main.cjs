const { app, BrowserWindow, Menu, dialog, session, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const { HOME_URL, isMuseUrl, isAppNavigation, isExternalUrl, browserUserAgent, permissionLabel } = require('./policy.cjs');
const { LinuxDevice } = require('./device.cjs');

app.setName('Muse for Linux');
app.setDesktopName('io.muse.linux.desktop');
app.enableSandbox();
app.setPath('userData', path.join(app.getPath('appData'), 'muse-linux'));
const profileArg = process.argv.find(arg => arg.startsWith('--user-data-dir='));
if (profileArg) app.setPath('userData', path.resolve(profileArg.slice('--user-data-dir='.length)));

let mainWindow;
let device;
let shutdown;
const pendingCleanup = new Set();
function destroyDevice() {
  const current = device; device = null;
  if (!current) return;
  const done = Promise.resolve(current.destroy()); pendingCleanup.add(done);
  void done.finally(() => pendingCleanup.delete(done));
}
app.on('before-quit', event => {
  if (shutdown === 'complete') return;
  event.preventDefault();
  if (shutdown) return;
  destroyDevice();
  shutdown = Promise.allSettled([...pendingCleanup]).then(() => { shutdown = 'complete'; app.quit(); });
});
const icon = path.join(__dirname, '../assets/icon.png');
const errorPage = path.join(__dirname, 'offline.html');
const webPreferences = { nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true };

async function openExternal(url) {
  if (isExternalUrl(url)) await shell.openExternal(url).catch(() => {});
}

function protectContents(contents) {
  contents.setWindowOpenHandler(({ url }) => {
    if (!isAppNavigation(url)) {
      void openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow', overrideBrowserWindowOptions: {
      width: 560, height: 760, minWidth: 420, minHeight: 520,
      parent: mainWindow, icon, autoHideMenuBar: true,
      webPreferences: { ...webPreferences, session: contents.session },
    } };
  });
  const navigation = (event, url) => {
    if (isAppNavigation(url)) return;
    event.preventDefault();
    void openExternal(url);
  };
  contents.on('will-navigate', navigation);
  contents.on('will-redirect', navigation);
  contents.on('will-attach-webview', event => event.preventDefault());
  contents.on('did-create-window', child => protectContents(child.webContents));
}

function configureSession(museSession) {
  museSession.setUserAgent(browserUserAgent(museSession.getUserAgent()));
  const granted = new Set();
  const automatic = new Set(['fullscreen', 'clipboard-sanitized-write']);
  const permissionKeys = (origin, permission, mediaTypes = []) => {
    const base = `${new URL(origin).origin}:${permission}`;
    return permission === 'media' ? mediaTypes.map(type => `${base}:${type}`) : [base];
  };
  museSession.setPermissionCheckHandler((_contents, permission, origin, details) => {
    if (!isMuseUrl(origin)) return false;
    if (automatic.has(permission)) return true;
    const types = details.mediaType ? [details.mediaType] : [];
    const keys = permissionKeys(origin, permission, types);
    return keys.length > 0 && keys.every(key => granted.has(key));
  });
  museSession.setPermissionRequestHandler(async (contents, permission, callback, details) => {
    if (contents === device?.bridge?.webContents) return callback(false);
    const origin = details.requestingUrl || contents.getURL();
    if (!isMuseUrl(origin) || !isMuseUrl(contents.getURL())) return callback(false);
    if (automatic.has(permission)) return callback(true);
    const label = permissionLabel(permission, details);
    if (!label || contents.isDestroyed()) return callback(false);
    const keys = permissionKeys(origin, permission, details.mediaTypes);
    if (keys.every(key => granted.has(key))) return callback(true);
    try {
      const parent = BrowserWindow.fromWebContents(contents);
      const answer = await dialog.showMessageBox(parent, {
        type: 'question', title: 'Muse permission',
        message: `Allow Muse to ${label}?`,
        detail: 'This permission lasts until you quit Muse for Linux.',
        buttons: ['Deny', 'Allow'], defaultId: 0, cancelId: 0,
      });
      const allowed=answer.response===1&&!contents.isDestroyed()&&isMuseUrl(contents.getURL());
      if (allowed) for (const key of keys) granted.add(key);
      callback(allowed);
    } catch { callback(false); }
  });
  museSession.on('will-download', (_event, item) => {
    const filename = path.basename(item.getFilename()).replace(/[\x00-\x1f]/g, '_') || 'download';
    item.setSaveDialogOptions({ defaultPath: path.join(app.getPath('downloads'), filename) });
    item.on('done', (_event, state) => {
      if (state !== 'completed' && state !== 'cancelled' && mainWindow && !mainWindow.isDestroyed()) {
        void dialog.showMessageBox(mainWindow, { type: 'error', message: 'The download could not finish.', detail: 'Try downloading the file again.' });
      }
    });
  });
}

async function showOffline() {
  if (mainWindow && !mainWindow.isDestroyed()) await mainWindow.loadFile(errorPage);
}

function openHome() {
  device?.hideSettings();
  if (mainWindow && !mainWindow.isDestroyed()) void mainWindow.loadURL(HOME_URL).catch(() => {});
}

function openSettings(tab) {
  void device?.showSettings(tab).catch(() => {
    if(mainWindow&&!mainWindow.isDestroyed())void dialog.showMessageBox(mainWindow,{type:'error',title:'Muse settings',message:'Settings could not open.',detail:'Your chat is still available. Try opening settings again.'});
  });
}

function visibleContents() {
  return device?.settingsVisible ? device.settingsPanel.webContents : mainWindow?.webContents;
}

function createWindow() {
  const museSession = session.fromPartition('persist:muse');
  configureSession(museSession);
  mainWindow = new BrowserWindow({
    width: 1280, height: 860, minWidth: 480, minHeight: 520,
    title: 'Muse for Linux', backgroundColor: '#ffffff', icon,
    show: false, autoHideMenuBar: true,
    webPreferences: { ...webPreferences, backgroundThrottling:false, session: museSession, preload:path.join(__dirname,'main-preload.cjs') },
  });
  protectContents(mainWindow.webContents);
  mainWindow.webContents.on('did-finish-load',async()=>{
    const contents=mainWindow?.webContents;
    if(!contents||!isMuseUrl(contents.getURL()))return;
    try{const source=await fs.readFile(path.join(__dirname,'desktop-ui.js'),'utf8');if(!contents.isDestroyed()&&isMuseUrl(contents.getURL()))await contents.executeJavaScript(source);}catch{}
  });
  mainWindow.on('page-title-updated', event => event.preventDefault());
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => { destroyDevice(); mainWindow = null; });
  mainWindow.webContents.on('did-fail-load', (_event, code, _description, url, isMainFrame) => {
    if (isMainFrame && code !== -3 && isAppNavigation(url)) void showOffline();
  });
  mainWindow.webContents.on('render-process-gone', () => void showOffline());
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'Muse', submenu: [
      { label: 'Home', accelerator: 'CmdOrCtrl+H', click: openHome },
      { label: 'Downloads', accelerator: 'CmdOrCtrl+Shift+D', click: () => void shell.openPath(app.getPath('downloads')) },
      { label: 'Settings', accelerator: 'CmdOrCtrl+,', click: () => openSettings('general') },
      { label: 'Dictate', click: () => { void device?.dictation.toggle().catch(()=>{}); } },
      { label: 'Stop local tasks', click: () => { void device?.stopBrowser().catch(()=>{}); } },
      { type: 'separator' }, { role: 'quit' },
    ] },
    { role: 'editMenu' },
    { label: 'View', submenu: [
      { label: 'Back', accelerator: 'Alt+Left', click: () => { if(device?.settingsVisible){device.hideSettings();return;}if (mainWindow?.webContents.navigationHistory.canGoBack()) mainWindow.webContents.navigationHistory.goBack(); } },
      { label: 'Forward', accelerator: 'Alt+Right', click: () => { if(device?.settingsVisible)return;if (mainWindow?.webContents.navigationHistory.canGoForward()) mainWindow.webContents.navigationHistory.goForward(); } },
      { label: 'Reload', accelerator: 'CmdOrCtrl+R', click: () => visibleContents()?.reload() },
      { label: 'Force reload', accelerator: 'CmdOrCtrl+Shift+R', click: () => visibleContents()?.reloadIgnoringCache() },
      { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
      { role: 'togglefullscreen' },
    ] },
    { label: 'Help', submenu: [
      { label: 'Open Muse in browser', click: () => void openExternal(HOME_URL) },
      { label: 'About Muse for Linux', click: () => void dialog.showMessageBox(mainWindow, {
        type: 'info', title: 'About Muse for Linux', message: `Muse for Linux ${app.getVersion()}`,
        detail: 'An unofficial desktop client with a Linux device companion.\n\nLocal browser control, Linux accessibility, file access, code execution and offline dictation use your desktop settings. Apple integrations are unavailable. Web features update through Muse; install new desktop builds manually.\n\nMuse is a product of Meta. This client is not affiliated with Meta.',
      }) },
    ] },
  ]));
  device = new LinuxDevice({ parent: () => mainWindow, museSession, icon });
  void device.start().then(() => { if (process.argv.includes('--settings')) openSettings(); }).catch(() => {
    destroyDevice();
    if(mainWindow&&!mainWindow.isDestroyed())void dialog.showMessageBox(mainWindow,{type:'error',title:'Muse desktop features',message:'Desktop features could not start.',detail:'Chat is still available. Restart Muse to try connecting the Linux companion again.'});
  });
  openHome();
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_event,argv) => { if (argv.includes('--settings')) { if(mainWindow?.isMinimized())mainWindow.restore();mainWindow?.show();openSettings();return; } if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.show(); mainWindow.focus(); } });
  app.whenReady().then(createWindow);
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  app.on('window-all-closed', () => app.quit());
}
