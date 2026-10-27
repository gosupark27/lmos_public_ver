// One Durable Object per room: the single writer.
// It owns the room's SQLite storage, its WebSockets, and its alarm (the server clock).
// Rules live in RoomCore; this file only moves bytes in and out.

import { RoomCore } from '../public/engine/core.js';
import { BUILD, LIMITS } from '../public/engine/constants.js';
import { publicSnapshot, privateDelta } from '../public/engine/views.js';

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS secrets (k TEXT PRIMARY KEY, v TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS ledger (
    seq INTEGER PRIMARY KEY, ts INTEGER NOT NULL, rnd INTEGER, act INTEGER,
    kind TEXT NOT NULL, text TEXT NOT NULL, data TEXT, prev TEXT NOT NULL, hash TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS intents (k TEXT PRIMARY KEY, result TEXT NOT NULL, ts INTEGER NOT NULL);
`;

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
});

export class Room {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.sql = ctx.storage.sql;
    this.core = null;
    this.rate = new WeakMap();
    this.intentWrites = 0;
  }

  exists() {
    return this.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'meta'").toArray().length > 0;
  }

  load() {
    if (this.core) return this.core;
    if (!this.exists()) return null;
    const row = this.sql.exec("SELECT v FROM meta WHERE k = 'state'").toArray()[0];
    if (!row) return null;
    const state = JSON.parse(row.v);
    const sec = this.sql.exec("SELECT v FROM secrets WHERE k = 'secret'").toArray()[0];
    state.secret = sec ? JSON.parse(sec.v) : {};
    this.core = new RoomCore(state, this.io());
    return this.core;
  }

  io() {
    const sql = this.sql;
    const storage = this.ctx.storage;
    const sockets = () => this.ctx.getWebSockets();
    const seatOf = (ws) => {
      const a = ws.deserializeAttachment();
      return a && a.seat != null ? a.seat : null;
    };
    return {
      fast: false,
      passportKey: this.env.PASSPORT_SECRET || 'handshake-dev-passport-key',
      now: () => Date.now(),
      save: (state) => {
        // Secrets live in their own table, written in the same transaction.
        const { secret, ...rest } = state;
        storage.transactionSync(() => {
          sql.exec("INSERT OR REPLACE INTO meta (k, v) VALUES ('state', ?)", JSON.stringify(rest));
          sql.exec("INSERT OR REPLACE INTO secrets (k, v) VALUES ('secret', ?)", JSON.stringify(secret));
        });
      },
      // Ledger appends, doesn't mutate: INSERT only, never UPDATE or DELETE.
      appendLedger: (entries) => {
        for (const e of entries) {
          sql.exec('INSERT INTO ledger (seq, ts, rnd, act, kind, text, data, prev, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
            e.seq, e.ts, e.round, e.act, e.kind, e.text, JSON.stringify(e.data ?? null), e.prev, e.hash);
        }
      },
      readLedger: (since) => sql.exec('SELECT * FROM ledger WHERE seq > ? ORDER BY seq LIMIT 1000', since).toArray()
        .map((r) => ({ seq: r.seq, ts: r.ts, round: r.rnd, act: r.act, kind: r.kind, text: r.text, data: JSON.parse(r.data), prev: r.prev, hash: r.hash })),
      getIntent: (k) => {
        const r = sql.exec('SELECT result FROM intents WHERE k = ?', k).toArray()[0];
        return r ? JSON.parse(r.result) : null;
      },
      putIntent: (k, v) => {
        sql.exec('INSERT OR REPLACE INTO intents (k, result, ts) VALUES (?, ?, ?)', k, JSON.stringify(v), Date.now());
        if (++this.intentWrites % 200 === 0) sql.exec('DELETE FROM intents WHERE ts < ?', Date.now() - 6 * 3600 * 1000);
      },
      connectedSeats: () => {
        const set = new Set();
        for (const ws of sockets()) { const s = seatOf(ws); if (s != null) set.add(s); }
        return set;
      },
      send: (seat, msg) => {
        const data = JSON.stringify(msg);
        for (const ws of sockets()) {
          if (seatOf(ws) !== seat) continue;
          try { ws.send(data); } catch { /* closing socket */ }
        }
      },
      setAlarm: (ms) => { storage.setAlarm(ms).catch(() => {}); },
    };
  }

  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;
    if (path === '/create' && request.method === 'POST') {
      if (this.load()) return json({ err: 'exists' }, 409);
      const body = await request.json();
      this.sql.exec(SCHEMA);
      const { core, hostToken } = RoomCore.create({
        code: body.code, now: Date.now(), seed: body.seed >>> 0, specHash: body.specHash,
        config: body.config, allowDev: !!body.allowDev,
      }, this.io());
      this.core = core;
      return json({ code: body.code, seat: 0, token: hostToken, build: BUILD });
    }
    const core = this.load();
    if (!core) return json({ err: 'no_room' }, 404);
    const now = Date.now();
    switch (path) {
      case '/meta': {
        const s = core.state;
        return json({
          code: s.code, phase: s.phase, seats: s.seats.filter((x) => x.human).length, max: LIMITS.maxSeats,
          tier: s.config.tier, pace: s.config.pace, build: s.build,
        });
      }
      case '/seen':
        core.invite('seen', now);
        return json({ ok: true });
      case '/left':
        core.invite('left', now);
        return json({ ok: true });
      case '/ws': {
        if (request.headers.get('Upgrade') !== 'websocket') return new Response('Expected a WebSocket', { status: 426 });
        const pair = new WebSocketPair();
        const [client, server] = Object.values(pair);
        this.ctx.acceptWebSocket(server);
        server.serializeAttachment({ seat: null, at: now });
        return new Response(null, { status: 101, webSocket: client });
      }
      case '/poll': {
        // Delta sync over HTTP: the same split payload a socket would get.
        const seat = this.seatForToken(core, url.searchParams.get('token'));
        if (seat == null) return json({ err: 'bad_token' }, 403);
        const since = Number(url.searchParams.get('since')) || 0;
        return json({ t: 'sync', now, since, events: core.io.readLedger(since), pub: publicSnapshot(core.state), priv: privateDelta(core.state, seat) });
      }
      case '/intent': {
        const body = await request.json().catch(() => null);
        const seat = body && this.seatForToken(core, body.token);
        if (seat == null) return json({ err: 'bad_token' }, 403);
        const res = core.intent(seat, body.msg || {}, now);
        return json({ t: 'ack', id: body.msg && body.msg.id, ...res });
      }
      default:
        return json({ err: 'not_found' }, 404);
    }
  }

  seatForToken(core, token) {
    if (typeof token !== 'string') return null;
    const hit = Object.entries(core.state.secret.tokens).find(([, t]) => t === token);
    return hit ? Number(hit[0]) : null;
  }

  allow(ws) {
    // A small token bucket per socket: 25 messages, refilling 15 per second.
    const now = Date.now();
    const b = this.rate.get(ws) || { tokens: 25, at: now };
    b.tokens = Math.min(25, b.tokens + ((now - b.at) / 1000) * 15);
    b.at = now;
    if (b.tokens < 1) { this.rate.set(ws, b); return false; }
    b.tokens -= 1;
    this.rate.set(ws, b);
    return true;
  }

  async webSocketMessage(ws, data) {
    const now = Date.now();
    if (typeof data !== 'string' || data.length > 8192) return;
    if (!this.allow(ws)) { ws.send(JSON.stringify({ t: 'error', err: 'slow_down' })); return; }
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    if (!msg || typeof msg !== 'object') return;
    if (msg.t === 'ping') { ws.send(JSON.stringify({ t: 'pong', now, echo: msg.echo })); return; }
    const core = this.load();
    if (!core) { ws.close(4004, 'no_room'); return; }
    if (msg.t === 'hello') {
      const a = core.authenticate(msg, now);
      if (a.err) {
        ws.send(JSON.stringify({ t: 'error', err: a.err }));
        ws.close(4001, a.err);
        return;
      }
      ws.serializeAttachment({ seat: a.seat, at: now });
      core.greet(a.seat, { token: a.token, isNew: a.isNew, lastSeq: msg.lastSeq }, now);
      return;
    }
    const att = ws.deserializeAttachment() || {};
    if (att.seat == null) { ws.send(JSON.stringify({ t: 'error', err: 'hello_first' })); return; }
    if (msg.t === 'intent') {
      const res = core.intent(att.seat, msg, now);
      ws.send(JSON.stringify({ t: 'ack', id: msg.id, ok: res.ok, err: res.err, result: res.result, replay: res.replay }));
    }
  }

  closed(ws) {
    const att = ws.deserializeAttachment();
    const core = this.load();
    if (!core || !att || att.seat == null) return;
    const still = this.ctx.getWebSockets().some((w) => {
      if (w === ws) return false;
      const a = w.deserializeAttachment();
      return a && a.seat === att.seat;
    });
    if (!still) core.disconnect(att.seat, Date.now());
  }

  async webSocketClose(ws, code, reason) {
    this.closed(ws);
    try { ws.close(code, reason); } catch { /* already closed */ }
  }

  async webSocketError(ws) {
    this.closed(ws);
  }

  async alarm() {
    const core = this.load();
    if (core) core.tick(Date.now());
  }
}
