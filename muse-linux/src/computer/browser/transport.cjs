'use strict';
const fs = require('node:fs/promises');
const NodeWebSocket = require('ws');
const { BrowserFailure, cdpFailure, check, clock } = require('./support.cjs');
function loopbackUrl(value, protocols = ['http:', 'ws:']) {
  let url;
  try { url = new URL(value); } catch { throw new BrowserFailure('invalid_endpoint'); }
  if (!protocols.includes(url.protocol) || !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname) || url.username || url.password || url.hash || !url.port) throw new BrowserFailure('endpoint_not_loopback');
  return url;
}
async function resolveEndpoint(req, ctx, options = {}) {
  check(ctx, options.now || clock.now);
  let endpoint = req.endpoint;
  if (req.explicitDiscoveryFile) {
    if (endpoint) throw new BrowserFailure('ambiguous_endpoint');
    const file = req.explicitDiscoveryFile;
    if (!file.endsWith('/DevToolsActivePort')) throw new BrowserFailure('invalid_discovery_file');
    const handle = await fs.open(file, require('node:fs').constants.O_RDONLY | require('node:fs').constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > 4096 || stat.uid !== process.getuid() || (stat.mode & 0o022)) throw new BrowserFailure('unsafe_discovery_file');
      const [port, path] = (await handle.readFile('utf8')).trim().split(/\r?\n/);
      if (!/^\d{1,5}$/.test(port) || +port < 1 || +port > 65535 || !/^\/devtools\/browser\/[A-Za-z0-9-]+$/.test(path)) throw new BrowserFailure('invalid_discovery_metadata');
      endpoint = `ws://127.0.0.1:${port}${path}`;
    } finally { await handle.close(); }
  }
  if (!endpoint) throw new BrowserFailure('attachment_required');
  const url = loopbackUrl(endpoint);
  if (url.protocol === 'ws:') {
    if (!/^\/devtools\/(browser|page)\/[A-Za-z0-9-]+$/.test(url.pathname) || url.search) throw new BrowserFailure('invalid_endpoint');
    return url.href;
  }
  if (url.pathname !== '/' || url.search) throw new BrowserFailure('invalid_endpoint');
  const response = await (options.fetch || fetch)(new URL('/json/version', url), {
    redirect: 'error', signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(Math.max(1, Math.floor(ctx.budget.deadlineMonoMs - (options.now || clock.now)())))])
  });
  if (!response.ok) throw new BrowserFailure('attachment_required');
  const body = await response.text();
  if (Buffer.byteLength(body) > 16384) throw new BrowserFailure('endpoint_metadata_limit');
  const ws = loopbackUrl(JSON.parse(body).webSocketDebuggerUrl, ['ws:']);
  if (ws.port !== url.port || !/^\/devtools\/browser\/[A-Za-z0-9-]+$/.test(ws.pathname) || ws.search) throw new BrowserFailure('endpoint_metadata_mismatch');
  check(ctx, options.now || clock.now);
  return ws.href;
}
class WebSocketTransport {
  constructor({ WebSocketImpl = NodeWebSocket, now = clock.now, maxMessageBytes = 2 * 1024 * 1024 } = {}) {
    this.WebSocketImpl = WebSocketImpl; this.now = now; this.maxMessageBytes = maxMessageBytes;
    this.pending = new Map(); this.listeners = new Set(); this.sequence = 0; this.closed = true;
  }
  async connect(endpoint, ctx) {
    check(ctx, this.now);
    if (!this.WebSocketImpl) throw new BrowserFailure('websocket_unavailable');
    loopbackUrl(endpoint, ['ws:']);
    if (!this.closed || this.cancelConnect) throw new BrowserFailure('transport_already_connected');
    // Node's client omits Origin. Chromium rejects browser-origin WebSockets
    // before reaching its local connection approval dialog.
    let socket;
    try {
      socket = new this.WebSocketImpl(endpoint, [], {
        followRedirects: false, perMessageDeflate: false, maxPayload: this.maxMessageBytes
      });
    } catch { throw new BrowserFailure('transport_connect_failed', 'transport'); }
    this.socket = socket; this.closed = false;
    const current = () => this.socket === socket;
    const message = e => { if (current() && !this.closed) this.receive(e.data); };
    const error = () => { if (current()) this.fail('transport_error'); };
    const closed = () => {
      socket.removeEventListener('message', message); socket.removeEventListener('error', error); socket.removeEventListener('close', closed);
      if (current()) this.fail('transport_disconnected');
    };
    socket.addEventListener('message', message); socket.addEventListener('close', closed); socket.addEventListener('error', error);
    await new Promise((resolve, reject) => {
      let settled = false;
      const done = failure => {
        if (settled) return;
        settled = true; clearTimeout(timer); ctx.signal.removeEventListener('abort', abort);
        socket.removeEventListener('open', open); socket.removeEventListener('error', failed); socket.removeEventListener('close', lost);
        socket.removeListener?.('unexpected-response', rejected);
        if (this.cancelConnect === cancel) this.cancelConnect = null;
        if (failure) {
          if (current()) this.fail(failure.code);
          this.destroySocket(socket); reject(failure);
        } else resolve();
      };
      const cancel = () => done(new BrowserFailure('cancelled', 'transport'));
      const abort = cancel;
      const open = () => { try { check(ctx, this.now); done(); } catch (failure) { done(failure); } };
      const failed = () => done(new BrowserFailure('transport_connect_failed', 'transport'));
      const lost = () => done(new BrowserFailure('transport_disconnected', 'transport'));
      const rejected = (_request, response) => {
        const failure = new BrowserFailure('transport_handshake_rejected', 'transport');
        if (Number.isInteger(response.statusCode) && response.statusCode >= 100 && response.statusCode <= 599) failure.httpStatus = response.statusCode;
        response.resume?.(); done(failure);
      };
      const timer = setTimeout(() => done(new BrowserFailure('attachment_timeout', 'transport')), Math.max(1, ctx.budget.deadlineMonoMs - this.now()));
      this.cancelConnect = cancel;
      socket.addEventListener('open', open); socket.addEventListener('error', failed); socket.addEventListener('close', lost);
      socket.on?.('unexpected-response', rejected);
      ctx.signal.addEventListener('abort', abort, { once: true });
      if (ctx.signal.aborted) abort();
    });
  }
  receive(data) {
    if (typeof data !== 'string' || Buffer.byteLength(data) > this.maxMessageBytes) { this.close(); return; }
    let message;
    try { message = JSON.parse(data); } catch { this.close(); return; }
    if (message.id) {
      const item = this.pending.get(message.id);
      if (!item) return;
      this.pending.delete(message.id); item.cleanup();
      message.error ? item.reject(cdpFailure(message.error)) : item.resolve(message.result || {});
    } else if (typeof message.method === 'string') {
      for (const listener of this.listeners) listener(message);
    }
  }
  send(method, params, sessionId, ctx) {
    check(ctx, this.now);
    if (this.closed || this.socket.readyState !== 1) throw new BrowserFailure('transport_disconnected');
    if (this.pending.size >= 64) throw new BrowserFailure('transport_queue_full');
    return new Promise((resolve, reject) => {
      const sequence = ++this.sequence;
      const abort = () => { this.pending.delete(sequence); cleanup(); reject(new BrowserFailure('cancelled', 'transport', 'unknown')); };
      const timer = setTimeout(() => { this.pending.delete(sequence); cleanup(); reject(new BrowserFailure('cdp_timeout', 'transport', 'unknown')); }, Math.max(1, ctx.budget.deadlineMonoMs - this.now()));
      const cleanup = () => { clearTimeout(timer); ctx.signal.removeEventListener('abort', abort); };
      this.pending.set(sequence, { resolve, reject, cleanup });
      ctx.signal.addEventListener('abort', abort, { once: true });
      try { this.socket.send(JSON.stringify({ id: sequence, method, params, ...(sessionId ? { sessionId } : {}) })); }
      catch { this.pending.delete(sequence); cleanup(); reject(new BrowserFailure('transport_send_lost', 'transport', 'unknown')); }
    });
  }
  subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  fail(code) {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) { pending.cleanup(); pending.reject(new BrowserFailure(code, 'transport', 'unknown')); }
    this.pending.clear();
    for (const listener of this.listeners) listener({ method: 'Muse.disconnected', params: {} });
  }
  destroySocket(socket) { try { if (socket?.terminate) socket.terminate(); else socket?.close(); } catch { /* The socket is already unavailable. */ } }
  close() { this.cancelConnect?.(); this.fail('transport_disconnected'); this.destroySocket(this.socket); }
}
// Construct in Electron main with an explicitly owned WebContents debugger. No electron import.
class ElectronDebuggerTransport {
  constructor({ debugger: debuggerApi, targetId, version = 'Chrome/153', now = clock.now }) {
    if (!debuggerApi || !targetId) throw new BrowserFailure('owned_debugger_required');
    this.api = debuggerApi; this.targetId = targetId; this.version = version; this.now = now; this.listeners = new Set(); this.sessionId = `electron-${targetId}`;
    this.onMessage = (_event, method, params, sessionId) => { for (const listener of this.listeners) listener({ method, params, sessionId: sessionId || this.sessionId }); };
    this.onDetach = () => { for (const listener of this.listeners) listener({ method: 'Muse.disconnected', params: {} }); };
  }
  async connect(_endpoint, ctx) { check(ctx, this.now); if (this.api.isAttached()) throw new BrowserFailure('debugger_already_attached'); this.api.attach('1.3'); this.api.on('message', this.onMessage); this.api.on('detach', this.onDetach); }
  async send(method, params, sessionId, ctx) {
    check(ctx, this.now);
    if (!sessionId) {
      if (method === 'Browser.getVersion') return { product: this.version };
      if (method === 'Target.getTargets') return { targetInfos: [{ targetId: this.targetId, type: 'page', title: 'Owned Muse browser', url: 'about:blank' }] };
      if (method === 'Target.attachToTarget' && params.targetId === this.targetId) return { sessionId: this.sessionId };
      if (method === 'Target.detachFromTarget' && params.sessionId === this.sessionId) { this.close(); return {}; }
      throw new BrowserFailure('root_method_denied');
    }
    const promise = this.api.sendCommand(method, params, sessionId === this.sessionId ? undefined : sessionId);
    return new Promise((resolve, reject) => {
      const abort = () => finish(new BrowserFailure('cancelled', 'transport', 'unknown'));
      const timer = setTimeout(() => finish(new BrowserFailure('cdp_timeout', 'transport', 'unknown')), Math.max(1, ctx.budget.deadlineMonoMs - this.now()));
      const finish = (error, result) => { clearTimeout(timer); ctx.signal.removeEventListener('abort', abort); error ? reject(error) : resolve(result); };
      ctx.signal.addEventListener('abort', abort, { once: true });
      promise.then(result => finish(null, result), error => finish(cdpFailure(error)));
    });
  }
  subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  close() { this.api.removeListener('message', this.onMessage); this.api.removeListener('detach', this.onDetach); if (this.api.isAttached()) this.api.detach(); }
}
module.exports = { WebSocketTransport, ElectronDebuggerTransport, resolveEndpoint, loopbackUrl };
