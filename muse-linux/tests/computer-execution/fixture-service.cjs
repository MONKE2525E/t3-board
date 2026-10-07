'use strict';
const http = require('node:http');
const fs = require('node:fs/promises');
const { join } = require('node:path');
const { randomBytes } = require('node:crypto');
// Owned synthetic application. Its full persisted state is independent of the adapter.
const directory = process.argv[2], token = randomBytes(24).toString('hex');
let state = { text: '', commits: 0 };
const server = http.createServer(async (req, res) => {
  if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(403); res.end(); return; }
  try {
    if (req.method === 'GET' && req.url === '/state') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(state)); return; }
    if (req.method !== 'POST' || !['/edit', '/lost-reply'].includes(req.url)) { res.writeHead(404); res.end(); return; }
    let body = ''; for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body) > 65536) throw new Error('oversize'); }
    const input = JSON.parse(body); if (typeof input.text !== 'string') throw new Error('invalid_text');
    state = { text: input.text, commits: state.commits + 1 };
    const file = await fs.open(join(directory, 'application-state.json'), 'w', 0o600);
    try { await file.writeFile(JSON.stringify(state)); await file.sync(); } finally { await file.close(); }
    if (req.url === '/lost-reply') { req.socket.destroy(); return; }
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ accepted: true }));
  } catch { res.writeHead(400); res.end(); }
});
server.listen(0, '127.0.0.1', () => process.send({ port: server.address().port, token }));
process.on('message', message => { if (message === 'stop') server.close(() => process.exit(0)); });
process.on('disconnect', () => server.close(() => process.exit(0)));
