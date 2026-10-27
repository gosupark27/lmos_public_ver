#!/usr/bin/env node
// Play Handshake on your own network with nothing but Node 22+:
//   node --no-warnings server/dev.mjs            -> http://localhost:8787 and your LAN address
// It runs the same Worker and Durable Object code that deploys to Cloudflare,
// on a small emulation layer (server/cf-shim.mjs). Rooms persist in .data/.

import http from 'node:http';
import os from 'node:os';
import { readFile, stat } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { join, extname, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { installGlobals, makeNamespace } from './cf-shim.mjs';
import { handshake, transport } from './ws.mjs';

installGlobals();
const { default: worker, Room } = await import('../src/worker.js');

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = join(ROOT, 'public');
const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return dflt;
  const v = args[i + 1];
  return v && !v.startsWith('--') ? v : true;
};
const PORT = Number(flag('port', process.env.PORT || 8787));
const HOST = String(flag('host', '0.0.0.0'));
const MEMORY = !!flag('memory', false);
const QUIET = !!flag('quiet', false);

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json', '.txt': 'text/plain; charset=utf-8',
};

function headerRules() {
  const file = join(PUBLIC, '_headers');
  if (!existsSync(file)) return {};
  const out = {};
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s+([A-Za-z-]+):\s*(.+)$/);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}
const STATIC_HEADERS = headerRules();

const ASSETS = {
  async fetch(request) {
    const url = new URL(request.url);
    let path = decodeURIComponent(url.pathname);
    if (path.endsWith('/')) path += 'index.html';
    const full = normalize(join(PUBLIC, path));
    if (!full.startsWith(PUBLIC) || path.includes('/_headers')) return new Response('Not found', { status: 404 });
    let file = full;
    try {
      const st = await stat(file);
      if (st.isDirectory()) file = join(file, 'index.html');
    } catch {
      // Single-page app: unknown paths get the shell.
      if (extname(path)) return new Response('Not found', { status: 404 });
      file = join(PUBLIC, 'index.html');
    }
    try {
      const body = await readFile(file);
      return new Response(body, { headers: { 'content-type': MIME[extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache', ...STATIC_HEADERS } });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  },
};

let secret = process.env.PASSPORT_SECRET;
if (!secret) {
  const f = join(ROOT, '.data', 'passport-secret');
  if (!MEMORY && existsSync(f)) secret = readFileSync(f, 'utf8').trim();
  else {
    secret = randomBytes(24).toString('hex');
    if (!MEMORY) { const { mkdirSync, writeFileSync } = await import('node:fs'); mkdirSync(join(ROOT, '.data'), { recursive: true }); writeFileSync(f, secret); }
  }
}
const env = { PASSPORT_SECRET: secret, HANDSHAKE_DEV: process.env.HANDSHAKE_DEV || '0', ASSETS };
const ROOMS = makeNamespace(Room, env, { dataDir: MEMORY ? null : join(ROOT, '.data', 'rooms') });
env.ROOMS = ROOMS;

async function toRequest(req, body) {
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (v != null) headers.set(k, Array.isArray(v) ? v.join(', ') : String(v));
  const init = { method: req.method, headers };
  if (body && body.length && req.method !== 'GET' && req.method !== 'HEAD') init.body = body;
  return new Request(`http://${req.headers.host || 'localhost'}${req.url}`, init);
}

const server = http.createServer(async (req, res) => {
  const chunks = [];
  let size = 0;
  req.on('data', (c) => { size += c.length; if (size > 64 * 1024) req.destroy(); else chunks.push(c); });
  req.on('end', async () => {
    try {
      const response = await worker.fetch(await toRequest(req, Buffer.concat(chunks)), env);
      const headers = {};
      response.headers.forEach((v, k) => { headers[k] = v; });
      res.writeHead(response.status, headers);
      res.end(Buffer.from(await response.arrayBuffer()));
      if (!QUIET && req.url.startsWith('/api/')) console.log(`${req.method} ${req.url} -> ${response.status}`);
    } catch (err) {
      console.error(err);
      res.writeHead(500); res.end('server error');
    }
  });
});

server.on('upgrade', async (req, socket, head) => {
  try {
    const response = await worker.fetch(await toRequest(req), env);
    if (response.status !== 101 || !response.webSocket) {
      socket.write(`HTTP/1.1 ${response.status} No\r\n\r\n`);
      socket.destroy();
      return;
    }
    if (!handshake(req, socket)) { socket.destroy(); return; }
    const client = response.webSocket;
    const serverEnd = client.peer;
    const t = transport(socket, head);
    client.transport = t;
    t.onMessage((msg) => {
      const owner = ROOMS.owner(serverEnd);
      if (owner) owner.message(serverEnd, msg).catch((e) => console.error(e));
    });
    t.onClose((code, reason) => {
      const owner = ROOMS.owner(serverEnd);
      if (owner) owner.close(serverEnd, code, reason).catch((e) => console.error(e));
    });
  } catch (err) {
    console.error(err);
    socket.destroy();
  }
});

server.listen(PORT, HOST, () => {
  const addrs = Object.values(os.networkInterfaces()).flat().filter((a) => a && a.family === 'IPv4' && !a.internal).map((a) => a.address);
  console.log(`\nHandshake is running.`);
  for (const a of addrs) console.log(`  Host from here so phones can join:  http://${a}:${PORT}`);
  console.log(`  This computer only:                 http://localhost:${PORT}`);
  console.log(`  Rooms are ${MEMORY ? 'in memory only' : 'saved in .data/'}${env.HANDSHAKE_DEV === '1' ? '; blitz pace enabled' : ''}.\n`);
});

const shutdown = () => { ROOMS.closeAll(); server.close(); process.exit(0); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

export { server, ROOMS, env };
