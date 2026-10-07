'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const { WebSocketServer } = require('ws');
const { WebSocketTransport } = require('../../src/computer/browser/transport.cjs');
const { context } = require('./helpers.cjs');

class Socket extends EventEmitter {
  static instances = [];
  constructor(url, _protocols, options) { super(); this.url = url; this.options = options; this.readyState = 0; this.terminated = 0; Socket.instances.push(this); }
  addEventListener(name, callback) { this.on(name, callback); }
  removeEventListener(name, callback) { this.removeListener(name, callback); }
  terminate() { this.terminated++; this.readyState = 3; this.emit('close', {}); }
  send(value) { this.sent = value; }
  open() { this.readyState = 1; this.emit('open', {}); }
}
const endpoint = 'ws://127.0.0.1:9222/devtools/browser/fixture';
const lastSocket = () => Socket.instances.at(-1);

test('generic handshake errors are connection failures, never invented consent denial', async () => {
  const transport = new WebSocketTransport({ WebSocketImpl: Socket });
  const pending = transport.connect(endpoint, context()); const socket = lastSocket();
  socket.emit('error', { message: 'private diagnostic' });
  await assert.rejects(pending, { code: 'transport_connect_failed' });
  assert.equal(socket.terminated, 1); assert.equal(transport.closed, true); assert.equal(transport.cancelConnect, null);
  for (const event of ['open', 'close', 'message', 'error', 'unexpected-response']) assert.equal(socket.listenerCount(event), 0);
});

test('HTTP rejection is distinguished from transport errors without guessing consent', async () => {
  const transport = new WebSocketTransport({ WebSocketImpl: Socket });
  const pending = transport.connect(endpoint, context()); let resumed = 0;
  lastSocket().emit('unexpected-response', {}, { statusCode: 403, resume() { resumed++; } });
  await assert.rejects(pending, { code: 'transport_handshake_rejected', httpStatus: 403 }); assert.equal(resumed, 1);
});

test('handshake cancellation, explicit close and deadline settle immediately and clean owned sockets', async () => {
  for (const reason of ['abort', 'close', 'deadline']) {
    const controller = new AbortController();
    const transport = new WebSocketTransport({ WebSocketImpl: Socket });
    const pending = transport.connect(endpoint, context({ signal: controller.signal, deadlineMs: reason === 'deadline' ? 15 : 5000 }));
    const socket = lastSocket();
    if (reason === 'abort') controller.abort();
    if (reason === 'close') transport.close();
    await assert.rejects(pending, { code: reason === 'deadline' ? 'attachment_timeout' : 'cancelled' });
    assert.ok(socket.terminated >= 1); assert.equal(transport.closed, true); assert.equal(transport.cancelConnect, null);
  }
});

test('stale socket events cannot disconnect a replacement connection', async () => {
  const transport = new WebSocketTransport({ WebSocketImpl: Socket });
  const first = transport.connect(endpoint, context()); const old = lastSocket(); old.open(); await first; transport.close();
  const second = transport.connect(endpoint, context()); const current = lastSocket(); current.open(); await second;
  old.emit('close', {}); assert.equal(transport.closed, false);
  const request = transport.send('Browser.getVersion', {}, undefined, context());
  const command = JSON.parse(current.sent); current.emit('message', { data: JSON.stringify({ id: command.id, result: { product: 'Fixture' } }) });
  assert.deepEqual(await request, { product: 'Fixture' }); transport.close();
});

test('pending protocol calls fail honestly on disconnect and cancellation', async () => {
  const transport = new WebSocketTransport({ WebSocketImpl: Socket }); const connect = transport.connect(endpoint, context()); lastSocket().open(); await connect;
  const controller = new AbortController(); const request = transport.send('Fixture.mutation', {}, undefined, context({ signal: controller.signal }));
  controller.abort(); await assert.rejects(request, { code: 'cancelled', effect: 'unknown' }); assert.equal(transport.pending.size, 0);
  const lost = transport.send('Fixture.mutation', {}, undefined, context()); lastSocket().emit('close', {});
  await assert.rejects(lost, { code: 'transport_disconnected', effect: 'unknown' }); assert.equal(transport.pending.size, 0);
});

async function server(t, upgrade) {
  const owned = http.createServer(); const sockets = new Set(); owned.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  owned.on('upgrade', upgrade); await new Promise(resolve => owned.listen(0, '127.0.0.1', resolve));
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => owned.close(resolve)); });
  return `ws://127.0.0.1:${owned.address().port}/devtools/browser/fixture`;
}

test('default Node websocket omits Origin, rejects compression and carries CDP without a browser', async t => {
  const ws = new WebSocketServer({ noServer: true }); let headers;
  const url = await server(t, (request, socket, head) => {
    headers = request.headers; ws.handleUpgrade(request, socket, head, client => {
      client.on('message', bytes => { const req = JSON.parse(bytes.toString()); client.send(JSON.stringify({ id: req.id, result: { product: 'Owned fixture' } })); });
    });
  });
  t.after(() => ws.close());
  const transport = new WebSocketTransport(); t.after(() => transport.close());
  await transport.connect(url, context());
  assert.equal(headers.origin, undefined); assert.equal(headers['sec-websocket-extensions'], undefined);
  assert.deepEqual(await transport.send('Browser.getVersion', {}, undefined, context()), { product: 'Owned fixture' });
});

test('default transport follows no redirects and reports owned server rejection accurately', async t => {
  let visits = 0;
  const url = await server(t, (_request, socket) => { visits++; socket.end('HTTP/1.1 302 Found\r\nLocation: ws://127.0.0.1:1/devtools/browser/redirect\r\nContent-Length: 0\r\n\r\n'); });
  const transport = new WebSocketTransport();
  await assert.rejects(transport.connect(url, context()), { code: 'transport_handshake_rejected' }); assert.equal(visits, 1); assert.equal(transport.closed, true);
});

test('default transport bounds inbound frames at the websocket decoder', async t => {
  const ws = new WebSocketServer({ noServer: true });
  const url = await server(t, (request, socket, head) => ws.handleUpgrade(request, socket, head, client => client.on('message', () => client.send('x'.repeat(2048)))));
  t.after(() => ws.close()); const transport = new WebSocketTransport({ maxMessageBytes: 1024 }); t.after(() => transport.close());
  await transport.connect(url, context());
  await assert.rejects(transport.send('Browser.getVersion', {}, undefined, context()), { code: 'transport_error', effect: 'unknown' });
});

test('transport refuses nonlocal endpoints and overlapping connections', async () => {
  const transport = new WebSocketTransport({ WebSocketImpl: Socket });
  await assert.rejects(transport.connect('ws://external.example:9222/devtools/browser/fixture', context()), { code: 'endpoint_not_loopback' });
  const connect = transport.connect(endpoint, context()); await assert.rejects(transport.connect(endpoint, context()), { code: 'transport_already_connected' });
  lastSocket().open(); await connect; transport.close();
});
