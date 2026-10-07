const fs = require('node:fs/promises');
const path = require('node:path');

async function main() {
  const endpoint = process.argv[2];
  const output = path.resolve(process.argv[3] || '/tmp/muse-linux-verification');
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(endpoint || '')) throw new Error('Usage: node scripts/verify.cjs http://127.0.0.1:PORT OUTPUT_DIRECTORY');
  await fs.mkdir(output, { recursive: true });
  const targets = await (await fetch(`${endpoint}/json/list`, { signal: AbortSignal.timeout(5000) })).json();
  const page = targets.find(target => target.type === 'page' && (target.url.startsWith('https://muse.ai/') || target.url.endsWith('/offline.html')));
  if (!page) throw new Error('No Muse app page found');
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  let nextId = 0;
  const pending = new Map();
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    const request = pending.get(message.id);
    if (request) { pending.delete(message.id); clearTimeout(request.timer); message.error ? request.reject(new Error(message.error.message)) : request.resolve(message.result); }
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, 10000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const inspect = async () => {
    const result = await send('Runtime.evaluate', { expression: `JSON.stringify({title:document.title,origin:location.origin,ready:document.readyState,loginVisible:!!document.querySelector('input[autocomplete="username"]')||document.body.innerText.includes('Log in or create an account'),inputCount:document.querySelectorAll('input,textarea').length,nodeExposed:typeof require!=='undefined'||typeof process!=='undefined',offlineVisible:document.body.innerText.includes('Couldn’t connect to Muse')})`, returnByValue: true });
    return JSON.parse(result.result.value);
  };
  try {
    const state = await inspect();
    if (state.ready !== 'complete' || state.nodeExposed) throw new Error('Page not ready or Node exposed to remote content');
    const screenshot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    await fs.writeFile(path.join(output, 'app.png'), Buffer.from(screenshot.data, 'base64'));
    await fs.writeFile(path.join(output, 'state.json'), `${JSON.stringify(state, null, 2)}\n`);
    console.log(JSON.stringify(state));
  } finally { socket.close(); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
