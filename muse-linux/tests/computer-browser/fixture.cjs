'use strict';
const http = require('node:http');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const { WebSocketTransport } = require('../../src/computer/browser/index.cjs');
const { context } = require('./helpers.cjs');
const ARTIFACT_ROOT = '/tmp/muse-port-d6c9/rewrite/impl-browser';
const HTML = `<!doctype html><meta charset="utf-8"><title>Muse synthetic browser fixture</title>
<style>body{font:16px sans-serif;margin:24px}textarea{width:520px;height:140px;display:block}input,button,select{margin:8px}#cover{position:absolute;inset:0;background:#bbb9;z-index:9;display:none}#scroll{height:80px;width:200px;overflow:auto;border:1px solid}iframe{width:450px;height:140px}#far{margin-top:1000px}</style>
<h1>Synthetic Orders</h1><h2 hidden>Hidden destination</h2><p id="signed">Synthetic session signed in</p>
<label>Paragraph<textarea id="paragraph"></textarea></label><label>Controlled<input id="controlled"></label>
<div role="textbox" aria-label="Editable" contenteditable="plaintext-only"></div>
<label>Enabled<input id="checked" type="checkbox"></label><label>Choice<select id="choice"><option value="a">Alpha</option><option value="b">Beta</option></select></label>
<button id="click">Save synthetic</button><button id="dialog">Confirm synthetic</button><button id="down">Dialog on down</button><button id="replace">Replace paragraph</button>
<input type="file" aria-label="Attachment" id="file"><input type="password" aria-label="Secret" value="PRIVATE_CANARY">
<input disabled aria-label="Disabled"><div id="cover"></div><div id="scroll" aria-label="Scroll pane"><div style="height:500px">Scroll content</div></div>
<div id="shadow"></div><div id="closed"></div><iframe src="/frame"></iframe><iframe id="cross" src="CROSS_ORIGIN/frame"></iframe><button id="far">Far away</button>
<p id="saved">Unsaved</p><script>
window.fixture={paragraph:'',controlled:'',checked:false,selected:'a',saved:0,dialog:null,uploads:0,events:[]};
paragraph.oninput=()=>{fixture.paragraph=paragraph.value;fixture.events.push({type:'paragraph',length:paragraph.value.length,time:performance.now()})};
let value='';Object.defineProperty(controlled,'value',{get(){return Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').get.call(this)},set(v){value=v;Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(this,v)}});
controlled.oninput=()=>{value=controlled.value;fixture.controlled=value;queueMicrotask(()=>{controlled.value=value})};
checked.onchange=()=>fixture.checked=checked.checked;choice.onchange=()=>fixture.selected=choice.value;
document.getElementById('click').onclick=()=>{fixture.saved++;saved.textContent='Saved synthetic '+fixture.saved};
document.getElementById('dialog').onclick=()=>{fixture.dialog=confirm('Synthetic only')};down.onmousedown=()=>{fixture.dialog=confirm('Down synthetic')};
file.onchange=()=>fixture.uploads=file.files.length;
document.getElementById('replace').onclick=()=>{let old=paragraph;let fresh=old.cloneNode();old.replaceWith(fresh)};
const open=shadow.attachShadow({mode:'open'});open.innerHTML='<label>Shadow entry<input aria-label="Shadow entry"></label><button>Shadow action</button>';
closed.attachShadow({mode:'closed'}).innerHTML='<button>Closed hidden</button>';
</script>`;
const FRAME = `<!doctype html><meta charset="utf-8"><style>body{margin:10px}input{margin:4px}</style><h2>Frame heading</h2><input aria-label="Frame editor"><button>Frame action</button><script>window.fixtureFrame={value:''};document.querySelector('input').oninput=e=>fixtureFrame.value=e.target.value</script>`;
async function server(handler) { const instance = http.createServer(handler); await new Promise(resolve => instance.listen(0, '127.0.0.1', resolve)); return instance; }
async function startFixture() {
  await fs.mkdir(ARTIFACT_ROOT, { recursive: true, mode: 0o700 });
  const directory = await fs.realpath(await fs.mkdtemp(path.join(ARTIFACT_ROOT, 'chrome-'))); await fs.chmod(directory, 0o700);
  const frameServer = await server((req, res) => { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(FRAME.replace('Frame editor', req.url === '/nested' ? 'Nested frame editor' : 'Cross frame editor') + (req.url === '/nested' ? '' : `<iframe src="http://127.0.0.1:${frameServer.address().port}/nested"></iframe>`)); });
  const crossOrigin = `http://localhost:${frameServer.address().port}`;
  const instance = await server((req, res) => {
    if (req.url.startsWith('/redirect')) { res.writeHead(302, { Location: '/destination?private_token=PRIVATE_URL#details' }); res.end(); return; }
    res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(req.url === '/frame' ? FRAME.replace('Frame editor', 'Same frame editor') : HTML.replace('CROSS_ORIGIN', crossOrigin));
  });
  const origin = `http://127.0.0.1:${instance.address().port}`;
  const profile = path.join(directory, 'profile');
  const log = await fs.open(path.join(directory, 'chrome.log'), 'w', 0o600);
  const chrome = spawn('/opt/google/chrome/chrome', ['--headless=new', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-component-update', '--site-per-process', '--window-size=1000,900', origin], { stdio: ['ignore', log.fd, log.fd], env: { PATH: '/usr/bin:/bin', HOME: directory, XDG_CONFIG_HOME: directory, XDG_CACHE_HOME: directory, LANG: 'C.UTF-8' } });
  let exit; chrome.once('exit', (code, signal) => { exit = { code, signal }; });
  const deadline = Date.now() + 15000; let port, browserPath;
  while (Date.now() < deadline) {
    if (exit) throw new Error(`Owned Chrome exited: ${JSON.stringify(exit)}`);
    try { [port, browserPath] = (await fs.readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).trim().split('\n'); if (port && browserPath) break; } catch { /* Wait only for the owned startup metadata. */ }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  if (!port) throw new Error('Owned Chrome startup timed out');
  const endpoint = `ws://127.0.0.1:${port}${browserPath}`;
  const inspector = new WebSocketTransport(); await inspector.connect(endpoint, context());
  async function send(method, params = {}, sessionId) { return inspector.send(method, params, sessionId, context()); }
  let inspectorSession;
  const targets = await send('Target.getTargets'); const targetId = targets.targetInfos.find(t => t.type === 'page').targetId;
  inspectorSession = (await send('Target.attachToTarget', { targetId, flatten: true })).sessionId;
  const state = async () => (await send('Runtime.evaluate', { expression: 'JSON.stringify(window.fixture)', returnByValue: true }, inspectorSession)).result.value;
  const evaluate = async expression => (await send('Runtime.evaluate', { expression, returnByValue: true }, inspectorSession)).result.value;
  const screenshot = async filename => { const image = await send('Page.captureScreenshot', { format: 'png' }, inspectorSession); const file = path.join(directory, filename); await fs.writeFile(file, Buffer.from(image.data, 'base64'), { mode: 0o600 }); return file; };
  async function close() {
    inspector.close(); chrome.kill('SIGTERM');
    await Promise.race([new Promise(resolve => chrome.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 2000))]);
    if (!exit) { chrome.kill('SIGKILL'); await new Promise(resolve => chrome.once('exit', resolve)); }
    await Promise.all([new Promise(resolve => instance.close(resolve)), new Promise(resolve => frameServer.close(resolve))]); await log.close();
  }
  try {
    const readyUntil = Date.now() + 15000;
    while (!await evaluate('document.readyState === "complete" && typeof window.fixture === "object"')) {
      if (Date.now() >= readyUntil) throw new Error('Owned Chrome fixture initial navigation did not complete');
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  } catch (error) { await close(); throw error; }
  return { directory, endpoint, origin, crossOrigin, targetId, chrome, state, evaluate, screenshot, send, inspectorSession, close };
}
module.exports = { startFixture, ARTIFACT_ROOT };
