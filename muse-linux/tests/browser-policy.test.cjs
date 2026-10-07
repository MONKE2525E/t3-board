const test = require('node:test');
const assert = require('node:assert/strict');
const { browserUrl, LocalBrowser, CHROME_HEIGHT, FILE_LIMIT } = require('../src/local-browser.cjs');

test('local browser navigation accepts public HTTPS and rejects local or privileged destinations', () => {
  assert.equal(browserUrl('https://example.com/page'), 'https://example.com/page');
  for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'http://example.com', 'https://localhost', 'https://127.0.0.1', 'https://[::1]', 'https://router.local', 'https://user:secret@example.com', 'https://example.com:8080']) assert.equal(browserUrl(url), null, url);
});

test('control chrome height stays in the slim 40-44px range', () => {
  assert.equal(CHROME_HEIGHT, 42);
});

test('LocalBrowser constructor defaults omit onChange side effects and file reads', () => {
  const browser = new LocalBrowser({ parent: () => null, session: {}, enabled: () => true });
  assert.equal(typeof browser.onChange, 'function');
  assert.equal(browser.readFile, undefined);
  browser.notify('task');
  browser.notify(null);
});

function sessioned(browser) {
  browser.stopped = false;
  browser.sessionId = 'session';
  browser.sessionExpires = Date.now() + 60000;
  browser.observation = { id: 'obs', url: 'https://example.com/', expires: Date.now() + 60000 };
  browser.window = { id: 1, getContentSize: () => [800, 600] };
  browser.view = { webContents: { isDestroyed: () => false, getURL: () => 'https://example.com/', getTitle: () => 'Linux browser test', executeJavaScript: async () => { throw Error('should not run'); } }, getBounds: () => ({ x: 0, y: CHROME_HEIGHT, width: 800, height: 558 }) };
  return browser;
}

test('upload_file is fail-closed without an approved reader, exact observation, or numbered file input', async () => {
  const browser = sessioned(new LocalBrowser({ parent: () => null, session: {}, enabled: () => true }));
  await assert.rejects(browser.control({ action: 'upload_file', observation_id: 'stale', element_number: 1, path: '/tmp/a.txt' }), /stale_observation/);
  await assert.rejects(browser.control({ action: 'upload_file', observation_id: 'obs', path: '/tmp/a.txt' }), /element_number_required/);
  await assert.rejects(browser.control({ action: 'upload_file', observation_id: 'obs', element_number: 1, path: '/tmp/a.txt' }), /upload_unavailable/);
});

test('upload_file reads only the supplied absolute path and rejects oversized or invalid payloads', async () => {
  const calls = [];
  const browser = sessioned(new LocalBrowser({
    parent: () => null, session: {}, enabled: () => true,
    readFile: async filePath => { calls.push(filePath); return { filename: 'note.txt', data_base64: Buffer.from('ok').toString('base64') }; },
  }));
  await assert.rejects(browser.approvedFile('relative.txt'), /absolute_path_required/);
  await assert.rejects(browser.approvedFile('/tmp/secret\0.txt'), /absolute_path_required/);
  const file = await browser.approvedFile('/tmp/note.txt');
  assert.deepEqual(calls, ['/tmp/note.txt']);
  assert.equal(file.filename, 'note.txt');
  assert.equal(file.size, 2);

  browser.readFile = async () => ({ filename: 'huge.bin', data_base64: Buffer.alloc(FILE_LIMIT + 1).toString('base64') });
  await assert.rejects(browser.approvedFile('/tmp/huge.bin'), /file_too_large/);
  browser.readFile = async () => ({ filename: 'bad.bin', data_base64: '!!!!' });
  await assert.rejects(browser.approvedFile('/tmp/bad.bin'), /invalid_binary_data/);
  browser.readFile = async () => ({ filename: '../x.txt', data_base64: Buffer.from('ok').toString('base64') });
  assert.equal((await browser.approvedFile('/tmp/x.txt')).filename, 'x.txt');
});

test('deadlines and Stop stay fail-closed before a window is created', async () => {
  const browser = new LocalBrowser({ parent: () => null, session: {}, enabled: () => true, approved: () => false });
  await assert.rejects(browser.session({ action: 'start', task: 'Expired', __deadline: Date.now() - 1 }), /request_expired/);
  assert.equal(browser.window, null);
  browser.stopped = true;
  await assert.rejects(browser.observe(), /stopped_by_user/);
});

test('remembered approval is rechecked and does not start a window once revoked', async () => {
  let n = 0;
  const browser = new LocalBrowser({ parent: () => null, session: {}, enabled: () => true, approved: () => ++n === 1 });
  await assert.rejects(browser.session({ action: 'start', task: 'Revoked during approve' }), /permission_denied/);
  assert.equal(browser.window, null);
  assert.equal(n, 2);
});

test('browser bulk typing accepts a focused contenteditable without an element number', async () => {
  const browser = sessioned(new LocalBrowser({ parent: () => null, session: {}, enabled: () => true }));
  const typed = [];
  browser.view.webContents.executeJavaScript = async () => true;
  browser.view.webContents.insertText = async text => typed.push(text);
  const result = await browser.control({ action: 'type', observation_id: 'obs', text: 'A whole sentence, café 🐒' }, { deferObservation: true });
  assert.equal(result.dispatched, true);
  assert.deepEqual(typed, ['A whole sentence, café 🐒']);
});

test('browser type refuses an unavailable focused field before sending text', async () => {
  const browser = sessioned(new LocalBrowser({ parent: () => null, session: {}, enabled: () => true }));
  let typed = false;
  browser.view.webContents.executeJavaScript = async () => false;
  browser.view.webContents.insertText = async () => { typed = true; };
  await assert.rejects(browser.control({ action: 'type', observation_id: 'obs', text: 'text' }), /field_unavailable/);
  assert.equal(typed, false);
});

test('browser Stop aborts long waits promptly', async () => {
  const { LocalBrowser } = require('../src/local-browser.cjs');
  const browser = new LocalBrowser({ parent:()=>null, session:{}, enabled:()=>true });
  browser.abort = new AbortController();
  const started = Date.now();const waiting = browser.sleep(3000);
  browser.stop();await assert.rejects(waiting,/stopped_by_user/);assert.ok(Date.now()-started<200);
});

test('ordinary browser control preserves dispatch receipt when Stop aborts its follow-up delay', async () => {
  const browser = sessioned(new LocalBrowser({ parent:()=>null,session:{},enabled:()=>true }));
  browser.abort = new AbortController();
  let keys=0;
  browser.view.webContents.sendInputEvent = event => { if(event.type==='keyUp'){keys++;browser.stopped=true;browser.abort.abort();} };
  const result=await browser.control({action:'key',key:'Tab',observation_id:'obs'});
  assert.equal(keys,1);assert.equal(result.dispatched,true);assert.equal(result.retryable,false);assert.equal(browser.observation,null);assert.match(result.error,/do not replay/);
});

const TREE = {
  title: 'Example', url: 'https://example.com/', width: 800, height: 558, text_excerpt: 'Hello',
  controls: [{ element_number: 1, role: 'button', type: '', label: 'Go', value: '', files: [], disabled: false, coordinate: [10, 10] }],
};

function fakeShot({ width = 2, height = 1, fill = 1, png = Buffer.from('PNG1') } = {}) {
  const pixels = Buffer.alloc(width * height * 4, fill);
  return {
    toBitmap: () => Buffer.from(pixels),
    getSize: () => ({ width, height }),
    toPNG: () => png,
  };
}

function observing(browser, shot = fakeShot()) {
  browser.view.webContents.executeJavaScript = async () => structuredClone(TREE);
  browser.view.webContents.capturePage = async () => shot;
  browser.view.webContents.stop = () => {};
  browser.window.isDestroyed = () => false;
  browser.window.close = () => {};
  return browser;
}

test('observe accepts a boolean or options object and skips identical raw pixels', async () => {
  const browser = observing(sessioned(new LocalBrowser({ parent: () => null, session: {}, enabled: () => true })));
  let png = 0;
  browser.view.webContents.capturePage = async () => fakeShot({ png: Buffer.from(`png-${++png}`) });
  const first = await browser.observe({ image: true });
  const second = await browser.observe(true);
  const third = await browser.observe({ view: 'image', force_image: 'false' });
  assert.equal(first.unchanged, false);
  assert.equal(first.image_transfer.mime_type, 'image/png');
  assert.equal(first.image_transfer.data_base64, Buffer.from('png-1').toString('base64'));
  assert.equal(second.unchanged, true);
  assert.equal(second.image_transfer, undefined);
  assert.equal('image_transfer' in second, false);
  assert.equal(second.screenshot_id, first.screenshot_id);
  assert.notEqual(second.observation_id, first.observation_id);
  assert.deepEqual(second.controls, TREE.controls);
  assert.equal(third.unchanged, true);
  assert.equal(third.screenshot_id, first.screenshot_id);
});

test('changed pixels, size, or site send a fresh image_transfer', async () => {
  const browser = observing(sessioned(new LocalBrowser({ parent: () => null, session: {}, enabled: () => true })));
  const first = await browser.observe({ view: 'image' });
  browser.view.webContents.capturePage = async () => fakeShot({ fill: 9, png: Buffer.from('PNG2') });
  const changed = await browser.observe({ image: 'true' });
  assert.equal(changed.unchanged, false);
  assert.notEqual(changed.screenshot_id, first.screenshot_id);
  assert.equal(changed.image_transfer.data_base64, Buffer.from('PNG2').toString('base64'));
  browser.view.webContents.capturePage = async () => fakeShot({ width: 4, height: 1, png: Buffer.from('PNG3') });
  const resized = await browser.observe({ image: true });
  assert.equal(resized.unchanged, false);
  browser.view.webContents.getURL = () => 'https://example.com/other';
  browser.view.webContents.capturePage = async () => fakeShot({ png: Buffer.from('PNG4') });
  const moved = await browser.observe({ image: true });
  assert.equal(moved.unchanged, false);
  assert.ok(moved.image_transfer.data_base64);
});

test('force_image true disables dedup and invalid flags fail before capture', async () => {
  const browser = observing(sessioned(new LocalBrowser({ parent: () => null, session: {}, enabled: () => true })));
  let captured = 0;
  browser.view.webContents.capturePage = async () => { captured++; return fakeShot(); };
  const first = await browser.observe({ image: true });
  const forced = await browser.observe({ view: 'image', force_image: 'true' });
  assert.equal(forced.unchanged, false);
  assert.notEqual(forced.screenshot_id, first.screenshot_id);
  assert.ok(forced.image_transfer);
  await assert.rejects(browser.observe({ image: true, force_image: 'yes' }), /invalid_force_image/);
  assert.equal(captured, 2);
});

test('observe without image or view=image does not capture', async () => {
  const browser = observing(sessioned(new LocalBrowser({ parent: () => null, session: {}, enabled: () => true })));
  let captured = 0;
  browser.view.webContents.capturePage = async () => { captured++; return fakeShot(); };
  const result = await browser.observe({ view: 'controls', force_image: 'false' });
  assert.equal(captured, 0);
  assert.equal(result.image_transfer, undefined);
  assert.equal(result.unchanged, undefined);
  assert.ok(result.observation_id);
  assert.deepEqual(result.controls, TREE.controls);
});

test('wait, describe, and navigate pass view and force_image into observe', async () => {
  const browser = sessioned(new LocalBrowser({ parent: () => null, session: {}, enabled: () => true }));
  const seen = [];
  browser.observe = async opts => { seen.push(opts); return { observation_id: 'next', controls: TREE.controls }; };
  browser.view.webContents.loadURL = async () => {};
  await browser.control({ action: 'wait', duration: 0.001, view: 'image', force_image: 'true' });
  await browser.control({ action: 'describe', image: true, force_image: 'false' });
  await browser.control({ action: 'navigate', url: 'https://example.com/', view: 'image' });
  assert.deepEqual(seen, [
    { image: undefined, view: 'image', force_image: 'true' },
    { image: true, view: undefined, force_image: 'false' },
    { image: undefined, view: 'image', force_image: undefined },
  ]);
});

test('invalid force_image fails before navigate mutates the page', async () => {
  const browser = sessioned(new LocalBrowser({ parent: () => null, session: {}, enabled: () => true }));
  let loaded = false;
  browser.view.webContents.loadURL = async () => { loaded = true; };
  await assert.rejects(browser.control({ action: 'navigate', url: 'https://example.com/', force_image: '1' }), /invalid_force_image/);
  assert.equal(loaded, false);
});

test('Stop resets the screenshot baseline', async () => {
  const browser = observing(sessioned(new LocalBrowser({ parent: () => null, session: {}, enabled: () => true })));
  const first = await browser.observe({ image: true });
  assert.ok(browser.screenshots.baseline);
  browser.stop();
  assert.equal(browser.screenshots.baseline, null);
  assert.ok(first.screenshot_id);
});

test('navigation during capture discards the screenshot and does not poison the cache', async () => {
  const browser = observing(sessioned(new LocalBrowser({ parent: () => null, session: {}, enabled: () => true })));
  let release;
  browser.view.webContents.capturePage = () => new Promise(resolve => { release = resolve; });
  const pending = browser.observe({ image: true });
  while (!release) await new Promise(resolve => setImmediate(resolve));
  const late = fakeShot({ fill: 3, png: Buffer.from('late') });
  browser.invalidatePage();
  release(late);
  await assert.rejects(pending, /screenshot_discarded/);
  browser.view.webContents.capturePage = async () => late;
  const next = await browser.observe({ image: true });
  assert.equal(next.unchanged, false);
  assert.ok(next.image_transfer);
});


test('navigation while reading the browser tree cannot seed an image baseline',async()=>{
  const browser=observing(sessioned(new LocalBrowser({parent:()=>null,session:{},enabled:()=>true})));let release,captures=0;
  browser.view.webContents.executeJavaScript=()=>new Promise(resolve=>{release=resolve;});
  browser.view.webContents.capturePage=async()=>{captures++;return fakeShot();};
  const pending=browser.observe({view:'image'});while(!release)await new Promise(resolve=>setImmediate(resolve));
  browser.invalidatePage();release(structuredClone(TREE));await assert.rejects(pending,/observation_discarded/);
  assert.equal(captures,0);assert.equal(browser.screenshots.baseline,null);
});
