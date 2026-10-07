'use strict';
const http = require('node:http');
const { randomUUID } = require('node:crypto');

function fixtureHtml(frameOrigin, token) {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><title>Muse execution fixture</title>
<style>body{font:16px system-ui;background:#f6f7f9;color:#152133;margin:32px;max-width:900px}textarea,input,button,select{font:inherit;padding:10px;margin:6px}textarea{display:block;width:85%;height:140px}button{cursor:pointer}#overlay{position:fixed;inset:0;background:#0005;display:none}dialog{border:1px solid #ccc;border-radius:12px;padding:24px}iframe{display:block;width:80%;height:130px;border:1px solid #ccd6e0}.scroll{height:90px;overflow:auto;border:1px solid #ddd}</style>
<h1>Muse execution fixture</h1><p>Only synthetic data appears on this page.</p>
<textarea aria-label="Paragraph"></textarea><input aria-label="Controlled field" value="initial">
<input type="checkbox" aria-label="Enable sample"><select aria-label="Delivery view"><option value="summary">Summary</option><option value="detail">Detail</option></select>
<button id="menu" onclick="document.querySelector('#menu-items').hidden=false">Open menu</button>
<nav id="menu-items" hidden><button onclick="history.pushState({},'', '/orders');document.querySelector('h1').textContent='Your Orders';document.querySelector('#status').textContent='Synthetic package is in transit';">Your Orders</button></nav>
<button onclick="document.querySelector('dialog').showModal()">Open dialog</button><dialog><h2>Confirm fixture</h2><button onclick="document.querySelector('#status').textContent='Confirmed';this.closest('dialog').close()">Confirm fixture</button><button onclick="this.closest('dialog').close()">Cancel fixture</button></dialog>
<input type="file" aria-label="Attach fixture file"><p id="file-status"></p>
<button onclick="document.querySelector('#status').textContent='Saved'">Save fixture</button><p id="status">Ready</p>
<div class="scroll" aria-label="Scrollable list">${Array.from({length:30},(_,i)=>'<p>Row '+i+'</p>').join('')}</div>
<div id="shadow"></div><iframe title="Child controls" src="${frameOrigin}/frame"></iframe><div id="overlay"></div>
<script>
window.fixture={token:${JSON.stringify(token)},changes:[],submissions:0,controlled:'initial'};
const paragraph=document.querySelector('textarea');
paragraph.addEventListener('input',()=>fixture.changes.push({kind:'paragraph',at:performance.now(),value:paragraph.value}));
const controlled=document.querySelector('[aria-label="Controlled field"]');
controlled.addEventListener('input',()=>{fixture.controlled=controlled.value;queueMicrotask(()=>{controlled.value=fixture.controlled;});});
document.querySelector('[type=file]').addEventListener('change',e=>document.querySelector('#file-status').textContent=Array.from(e.target.files,f=>f.name).join(','));
const shadow=document.querySelector('#shadow').attachShadow({mode:'open'});shadow.innerHTML='<button>Shadow action</button>';
shadow.querySelector('button').onclick=()=>document.querySelector('#status').textContent='Shadow activated';
window.addEventListener('keydown',e=>{if(e.key==='Enter')fixture.submissions++;});
</script></html>`;
}
async function listen(handler) {
  const server=http.createServer(handler);
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  return {server,url:'http://127.0.0.1:'+server.address().port};
}
async function startFixture() {
  const token=randomUUID();
  const child=await listen((_req,res)=>{res.setHeader('Content-Type','text/html');res.end('<!doctype html><title>Child fixture</title><input aria-label="Frame field"><button onclick="document.body.dataset.clicked=\'true\'">Frame button</button>');});
  const main=await listen((req,res)=>{
    res.setHeader('Cache-Control','no-store');
    if(req.url==='/download-a'||req.url==='/download-b') {res.setHeader('Content-Disposition','attachment; filename="fixture-'+req.url.at(-1)+'.txt"');return res.end('synthetic download');}
    res.setHeader('Content-Type','text/html');res.end(fixtureHtml(child.url.replace('127.0.0.1','localhost'),token));
  });
  return {url:main.url,frameUrl:child.url,token,async close(){await Promise.all([main.server,child.server].map(s=>new Promise(resolve=>s.close(resolve))));}};
}
module.exports={startFixture,fixtureHtml};
