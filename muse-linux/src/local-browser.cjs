const { BrowserWindow, WebContentsView, dialog } = require('electron');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { runBatch } = require('./action-batch.cjs');
const { elementNumber } = require('./control-selector.cjs');
const { normalizeKey } = require('./key-names.cjs');
const { ScreenshotCache, parseForceImage } = require('./screenshot-cache.cjs');

const CHROME_HEIGHT = 42;
const FILE_LIMIT = 8 * 1024 * 1024;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

function browserUrl(value) {
  try {
    const u = new URL(value);
    if (u.protocol !== 'https:' || u.username || u.password || u.port && u.port !== '443') return null;
    if (u.hostname === 'localhost' || !u.hostname.includes('.') || u.hostname.endsWith('.local') || u.hostname.endsWith('.internal') || /^[\d.]+$/.test(u.hostname) || u.hostname.includes(':')) return null;
    return u.href;
  } catch { return null; }
}

class LocalBrowser {
  constructor({ parent, session, enabled, approved = () => false, icon, onChange = () => {}, readFile }) {
    this.parent = parent; this.browserSession = session; this.enabled = enabled; this.icon = icon;
    this.approved = approved;
    this.onChange = onChange;
    this.readFile = readFile;
    this.window = null; this.view = null; this.sessionId = null; this.observation = null; this.stopped = false;
    this.abort = null; this.generation = 0; this.screenshots = new ScreenshotCache();
  }

  invalidatePage() {
    this.generation++;
    this.observation = null;
    this.screenshots.reset();
  }

  notify(task) {
    this.onChange(task ?? null);
  }

  stop() {
    this.abort?.abort(); this.abort = null;
    this.pendingApproval?.abort(); clearTimeout(this.expiryTimer);
    this.stopped = true; this.sessionId = null;
    this.invalidatePage();
    if (this.view && !this.view.webContents.isDestroyed()) this.view.webContents.stop();
    if (this.window && !this.window.isDestroyed()) this.window.close();
    this.window = null; this.view = null;
    this.notify(null);
  }

  requireSession() {
    if (this.stopped) throw Error('stopped_by_user');
    if (!this.enabled()) throw Error('computer_use_disabled: enable it in Linux settings');
    if (!this.sessionId || Date.now() > this.sessionExpires) { this.stop(); throw Error('session_required'); }
  }

  async session(args) {
    if (args.action === 'end') {
      if (args.session_id && this.sessionId && args.session_id !== this.sessionId) throw Error('invalid_session_id');
      this.stop(); return { ended: true };
    }
    if (args.action !== 'start' || typeof args.task !== 'string' || !args.task.trim() || args.task.length > 160) throw Error('invalid_session_request');
    if (!this.enabled()) throw Error('computer_use_disabled: enable it in Linux settings');
    if (this.sessionId) this.stop();
    const deadline = args.__deadline || Date.now()+60000;
    if (deadline<=Date.now()) throw Error('request_expired');
    this.stopped = false;
    const approval = new AbortController(); this.pendingApproval = approval;
    const expiry = setTimeout(()=>approval.abort(),deadline-Date.now());
    let answer = { response: 1 };
    const remembered = this.approved();
    try { if (!remembered) answer = await dialog.showMessageBox(this.parent(), {
      type: 'question', title: 'Muse local computer use', message: 'Allow Muse to control its local browser for this task?',
      detail: `${args.task}\n\nOnly the Muse Local Browser window is accessible. Other apps and your existing browser windows are outside this session. Access expires after 10 minutes. Use Stop to end it immediately.`,
      buttons: ['Deny', 'Allow this task'], defaultId: 0, cancelId: 0,
      signal:approval.signal,
    }); } finally { clearTimeout(expiry); if (this.pendingApproval===approval) this.pendingApproval = null; }
    if (approval.signal.aborted || this.stopped || Date.now()>=deadline) throw Error('request_expired_or_stopped: no browser started');
    if (answer.response !== 1 || !this.enabled() || remembered && !this.approved()) throw Error('permission_denied');
    this.stopped = false; this.sessionId = randomUUID(); this.sessionExpires = Date.now() + 600000;
    this.abort = new AbortController();
    this.expiryTimer = setTimeout(()=>this.stop(),600000);
    this.window = new BrowserWindow({ width: 1100, height: 820, minWidth: 480, minHeight: 400, title: 'Muse Local Browser', show: false, icon: this.icon, autoHideMenuBar: true,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, preload: path.join(__dirname, 'control-preload.cjs') } });
    this.window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    this.window.webContents.on('will-navigate', e => e.preventDefault());
    this.window.on('page-title-updated', e => e.preventDefault());
    this.view = new WebContentsView({ webPreferences: { session: this.browserSession, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, backgroundThrottling: false } });
    this.window.contentView.addChildView(this.view);
    const resize = () => { if (this.window && this.view) { const [width, height] = this.window.getContentSize(); this.view.setBounds({ x: 0, y: CHROME_HEIGHT, width, height: Math.max(1, height - CHROME_HEIGHT) }); } };
    this.window.on('resize', resize); resize();
    const contents = this.view.webContents;
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.on('will-attach-webview', e => e.preventDefault());
    for (const event of ['will-navigate', 'will-redirect']) contents.on(event, (e, url) => { if (!browserUrl(url)) e.preventDefault(); });
    contents.on('did-start-navigation', (_e, _url, _inPlace, main) => { if (main) this.invalidatePage(); });
    const ownedWindow = this.window, ownedView = this.view;
    ownedWindow.on('closed', () => {
      if (this.window === ownedWindow) {
        this.window = null; this.view = null; this.sessionId = null; this.stopped = true; clearTimeout(this.expiryTimer);
        this.invalidatePage();
        this.notify(null);
      }
      if (!ownedView.webContents.isDestroyed()) ownedView.webContents.close();
    });
    await this.window.loadFile(path.join(__dirname, 'control.html'), { query: { task: args.task } });
    await contents.loadURL('https://example.com/');
    this.window.showInactive();
    this.notify(args.task);
    return { session_id: this.sessionId, user_can_see_preview: true, scope: 'Muse Local Browser only', expires_in_seconds: 600 };
  }

  observeArgs(args = {}) {
    return { image: args.image, view: args.view, force_image: args.force_image };
  }

  async observe(image = false) {
    const options = image && typeof image === 'object' && !Array.isArray(image) ? image : { image };
    parseForceImage(options.force_image);
    const wantImage = options.image === true || options.image === 'true' || options.view === 'image';
    this.requireSession();
    if (!this.view || this.view.webContents.isDestroyed()) throw Error('target_window_required');
    const contents = this.view.webContents;
    const generation = this.generation, sessionId = this.sessionId, url = contents.getURL();
    const id = randomUUID();
    const state = await contents.executeJavaScript(`(() => {
      const visible = e => { const r=e.getBoundingClientRect(),s=getComputedStyle(e); return r.width>0&&r.height>0&&s.visibility!=='hidden'&&s.display!=='none'&&r.bottom>0&&r.right>0&&r.top<innerHeight&&r.left<innerWidth; };
      const items = Array.from(document.querySelectorAll('a[href],button,input,textarea,select,[role="button"],[contenteditable="true"]')).filter(visible).slice(0,200);
      window.__museControlObservation = { id: ${JSON.stringify(id)}, items };
      return { title:document.title.slice(0,200), url:location.href, width:innerWidth, height:innerHeight, text_excerpt:document.body.innerText.slice(0,12000), controls:items.map((e,i)=>{const r=e.getBoundingClientRect();const type=e.tagName==='INPUT'||e.tagName==='BUTTON'?e.type:'';return {element_number:i+1,role:e.getAttribute('role')||e.tagName.toLowerCase(),type,label:(e.getAttribute('aria-label')||e.getAttribute('placeholder')||e.innerText||e.getAttribute('name')||'').slice(0,150),value:e.type==='password'?'':String(e.value??'').slice(0,1000),files:type==='file'?Array.from(e.files||[]).slice(0,8).map(f=>({name:String(f.name||'').slice(0,200),size:f.size,type:String(f.type||'').slice(0,80)})):[],disabled:!!e.disabled,coordinate:[Math.round((r.x+r.width/2)/innerWidth*1000),Math.round((r.y+r.height/2)/innerHeight*1000)]};}) };
    })()`);
    this.requireSession();
    if (generation !== this.generation || sessionId !== this.sessionId || this.view?.webContents !== contents || contents.getURL() !== url) throw Error('observation_discarded: session or page changed');
    this.observation = { id, window_id: this.window.id, url: contents.getURL(), controls: state.controls, expires: Date.now() + 120000 };
    const result = { ...state, window_id: this.window.id, app: 'Muse Local Browser', observation_id: id, captured_at: new Date().toISOString() };
    if (wantImage) await this.attachScreenshot(result, contents, state, options);
    return result;
  }

  async attachScreenshot(result, contents, state, options) {
    const force = parseForceImage(options.force_image);
    const generation = this.generation;
    const sessionId = this.sessionId;
    const url = contents.getURL();
    const screenshot = await contents.capturePage();
    this.requireSession();
    if (generation !== this.generation || sessionId !== this.sessionId) throw Error('screenshot_discarded: session or page changed during capture');
    if (!this.window || !this.view || this.view.webContents.isDestroyed() || this.view.webContents !== contents) throw Error('screenshot_discarded: target changed during capture');
    if (contents.getURL() !== url) throw Error('screenshot_discarded: navigation during capture');
    const size = screenshot.getSize();
    const raw = screenshot.toBitmap();
    const pixels = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    if (!size || !Number.isInteger(size.width) || !Number.isInteger(size.height) || size.width < 1 || size.height < 1 || !pixels.length) throw Error('screenshot_failed');
    const key = JSON.stringify({
      session: sessionId,
      target: String(this.window.id),
      site: url,
      viewport: { width: state.width, height: state.height, bitmap_width: size.width, bitmap_height: size.height },
    });
    const compared = this.screenshots.compare({ key, pixels, width: size.width, height: size.height, force });
    result.unchanged = compared.unchanged;
    result.screenshot_id = compared.screenshot_id;
    if (compared.unchanged) return;
    result.image_transfer = { mime_type: 'image/png', data_base64: screenshot.toPNG().toString('base64'), filename: `linux-window-${compared.screenshot_id}.png` };
  }

  async approvedFile(filePath) {
    if (typeof this.readFile !== 'function') throw Error('upload_unavailable: no approved file reader');
    if (typeof filePath !== 'string' || !filePath || filePath.includes('\0') || !path.isAbsolute(filePath)) throw Error('absolute_path_required');
    const file = await this.readFile(filePath);
    this.requireSession();
    if (!file || typeof file.filename !== 'string' || typeof file.data_base64 !== 'string') throw Error('invalid_file_payload');
    const filename = path.basename(file.filename).replace(/[\x00-\x1f]/g, '').slice(0, 200);
    if (!filename || filename === '.' || filename === '..') throw Error('invalid_filename');
    if (file.data_base64.length > 4 * Math.ceil(FILE_LIMIT / 3)) throw Error('file_too_large: maximum 8 MiB');
    if (file.data_base64.length % 4 !== 0 || !BASE64.test(file.data_base64)) throw Error('invalid_binary_data');
    const data = Buffer.from(file.data_base64, 'base64');
    if (data.length > FILE_LIMIT) throw Error('file_too_large: maximum 8 MiB');
    return { filename, data_base64: data.toString('base64'), size: data.length };
  }

  async uploadFile(contents, args, element, expected) {
    const file = await this.approvedFile(args.path);
    this.requireSession();
    const inserted = await contents.executeJavaScript(`(() => {
      const o=window.__museControlObservation,e=o?.items[${element - 1}];
      if(o?.id!==${JSON.stringify(expected)}||!e?.isConnected||e.disabled||e.tagName!=='INPUT'||e.type!=='file'||e.webkitdirectory)return {ok:false};
      const binary=atob(${JSON.stringify(file.data_base64)});
      if(binary.length!==${file.size})return {ok:false};
      const bytes=new Uint8Array(binary.length);
      for(let i=0;i<binary.length;i++)bytes[i]=binary.charCodeAt(i);
      const uploaded=new File([bytes],${JSON.stringify(file.filename)},{type:'application/octet-stream'});
      const transfer=new DataTransfer();
      transfer.items.add(uploaded);
      e.files=transfer.files;
      e.dispatchEvent(new Event('input',{bubbles:true}));
      e.dispatchEvent(new Event('change',{bubbles:true}));
      const got=e.files[0];
      if(!got||got.name!==${JSON.stringify(file.filename)}||got.size!==${file.size})return {ok:false};
      return {ok:true,name:got.name,size:got.size,count:e.files.length};
    })()`);
    this.requireSession();
    if (!inserted?.ok) throw Error('file_input_unavailable: no file inserted');
    return inserted;
  }

  async batch(args) { this.requireSession(); return runBatch(this, args); }

  sleep(ms) {
    const signal = this.abort?.signal;
    return new Promise((resolve, reject) => {
      const onAbort = () => { clearTimeout(timer); reject(Error('stopped_by_user')); };
      const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
      if (signal?.aborted) return onAbort();
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  async settleBatch() { await this.sleep(150); this.requireSession(); }

  async control(args, options = {}) {
    const observed = this.observation;
    const state = { inputStarted: false };
    try { return await this.performControl(args, options, state); }
    catch (error) {
      if (state.inputStarted && args.observation_id === observed?.id) {
        if (this.observation === observed) this.observation = null;
        error.message += ': input may have partial effects; observe again and do not replay';
      }
      if (state.dispatched) return { dispatched: true, task_success: false, error: error.message, uncertain: true, retryable: false };
      throw error;
    }
  }

  async performControl(args, { deferObservation = false } = {}, state = {}) {
    this.requireSession();
    parseForceImage(args.force_image);
    const contents = this.view?.webContents;
    if (!contents || contents.isDestroyed()) throw Error('target_window_required');
    const action = args.action;
    if (['list_windows', 'current_target'].includes(action)) return { windows: [{ window_id: this.window.id, app: 'Muse Local Browser', title: contents.getTitle() }], scope: 'Owned browser only' };
    if (action === 'open_app' || action === 'navigate') {
      if (action === 'open_app' && args.app && args.app !== 'Muse Local Browser') throw Error('app_unsupported: only Muse Local Browser is supported');
      const url = browserUrl(args.url || 'https://example.com/'); if (!url) throw Error('invalid_url');
      await contents.loadURL(url); this.requireSession(); return this.observe(this.observeArgs(args));
    }
    if (action === 'describe') return this.observe(this.observeArgs(args));
    if (action === 'wait' && !deferObservation) { await this.sleep(Math.min(3000, Math.max(0, Number(args.duration) * 1000 || 500))); this.requireSession(); return this.observe(this.observeArgs(args)); }
    if (!this.observation || args.observation_id !== this.observation.id || Date.now() > this.observation.expires || this.observation.url !== contents.getURL()) throw Error('stale_observation: observe again before input');
    if (args.window_id != null && String(args.window_id) !== String(this.window.id)) throw Error('target_window_required');
    if (action === 'wait') { await this.sleep(Math.min(3000, Math.max(0, Number(args.duration) * 1000 || 500))); this.requireSession(); if (!this.observation || args.observation_id !== this.observation.id || this.observation.url !== contents.getURL()) throw Error('stale_observation'); return { dispatched: true }; }
    if (!['click', 'focus', 'type', 'key', 'scroll', 'upload_file'].includes(action)) throw Error('action_unsupported');
    const expected = this.observation.id;
    const element = elementNumber(this.observation, args);
    if ((['focus', 'upload_file'].includes(action) || action === 'type' && (args.element_number != null && args.element_number !== '' || args.element_label)) && (!Number.isInteger(element) || element < 1 || element > 200)) throw Error('element_number_required');
    if (action === 'upload_file') {
      await this.uploadFile(contents, args, element, expected);
    } else if (action === 'type') {
      if (typeof args.text !== 'string' || args.text.length > 4096 || args.text.includes('\0')) throw Error('invalid_text');
      const valid = await contents.executeJavaScript(`(() => {
        const o=window.__museControlObservation,e=${Number.isInteger(element) ? `o?.items[${element - 1}]` : 'document.activeElement'};
        if(o?.id!==${JSON.stringify(expected)}||!e?.isConnected||e.disabled||e.readOnly||e.type==='password'||!(e.isContentEditable||['INPUT','TEXTAREA'].includes(e.tagName)))return false;
        e.focus();
        ${args.replace_all === true || args.replace_all === 'true' ? "if(e.isContentEditable){const r=document.createRange();r.selectNodeContents(e);const s=getSelection();s.removeAllRanges();s.addRange(r);}else if(typeof e.select==='function')e.select();else return false;" : ''}
        return true;
      })()`);
      if (!valid) throw Error('field_unavailable: no text sent');
      state.inputStarted = true;
      await contents.insertText(args.text);
    } else if (action === 'click' || action === 'focus') {
      if (Number.isInteger(element) && element > 0) {
        state.inputStarted = true;
        const ok = await contents.executeJavaScript(`(() => {const o=window.__museControlObservation,e=o?.items[${element - 1}];if(o?.id!==${JSON.stringify(expected)}||!e?.isConnected||e.disabled)return false;e.${action === 'click' ? 'click' : 'focus'}();return true;})()`);
        if (!ok) { state.inputStarted = false; throw Error('target_unavailable: no input sent'); }
      } else {
        let coordinate = args.coordinate; if (typeof coordinate === 'string') { try { coordinate = JSON.parse(coordinate); } catch {} }
        if (action !== 'click' || !Array.isArray(coordinate) || coordinate.length !== 2 || coordinate.some(n => !Number.isFinite(n) || n < 0 || n > 1000)) throw Error('invalid_coordinate');
        const bounds = this.view.getBounds();
        const x = Math.round(coordinate[0] / 1000 * Math.max(1, bounds.width - 1)), y = Math.round(coordinate[1] / 1000 * Math.max(1, bounds.height - 1));
        state.inputStarted = true;
        contents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 }); contents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
      }
    } else if (action === 'key') {
      const normalized = normalizeKey({ key: args.key, modifiers: args.modifiers || undefined });
      state.inputStarted = true;
      contents.sendInputEvent({ type:'keyDown', ...normalized.electron });
      if (normalized.key === 'Enter') contents.sendInputEvent({ type:'char', keyCode:'\r', modifiers: normalized.electron.modifiers });
      contents.sendInputEvent({ type:'keyUp', ...normalized.electron });
    } else {
      const direction = args.scroll_direction || 'down', amount = Math.min(100, Math.max(1, Number(args.scroll_amount) || 3)) * 80;
      if (!['up','down','left','right'].includes(direction)) throw Error('invalid_scroll');
      state.inputStarted = true;
      contents.sendInputEvent({ type:'mouseWheel', x:100, y:100, deltaX:direction==='left'?-amount:direction==='right'?amount:0, deltaY:direction==='up'?-amount:direction==='down'?amount:0 });
    }
    state.dispatched = true;
    if (deferObservation) { try { await this.sleep(30); this.requireSession(); } catch (error) { this.observation = null; return { dispatched: true, error: error.message, uncertain: true, retryable: false }; } return { dispatched: true }; }
    this.observation = null;
    await this.sleep(200); this.requireSession();
    try { return { dispatched:true, task_success:false, observation:await this.observe(this.observeArgs(args)), verification:'Inspect the fresh observation to verify the intended effect. Dispatched alone is not success.' }; }
    catch { return { dispatched:true, task_success:false, evidence_status:'unavailable', required_next:'observe', side_effect:'dispatched', retryable:false }; }
  }
}

module.exports = { LocalBrowser, browserUrl, CHROME_HEIGHT, FILE_LIMIT };
