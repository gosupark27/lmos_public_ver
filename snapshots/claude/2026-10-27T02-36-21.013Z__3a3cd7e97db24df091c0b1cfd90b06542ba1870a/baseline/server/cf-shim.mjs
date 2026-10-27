// A small Cloudflare emulation for Node, so the real Worker and Durable Object code
// can run (and be tested) without wrangler: SQLite storage via node:sqlite,
// the WebSocket Hibernation API, alarms, WebSocketPair, and 101 responses.
// It mirrors the APIs Handshake uses, not all of workerd.

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

// ---------- Response that allows 101 + webSocket, like workerd ----------
const NativeResponse = globalThis.Response;
class CFResponse extends NativeResponse {
  constructor(body, init = {}) {
    if (init && init.status === 101) {
      super(null, { ...init, status: 200 });
      Object.defineProperty(this, 'status', { value: 101 });
      this.webSocket = init.webSocket || null;
    } else {
      super(body, init);
    }
  }
}

// ---------- WebSocketPair ----------
class ShimSocket {
  constructor() {
    this.peer = null;
    this.attachment = null;
    this.readyState = 1;
    this.transport = null; // set on the client end by the HTTP layer
    this.listeners = { message: [], close: [] };
  }
  send(data) {
    if (this.readyState !== 1) throw new Error('socket closed');
    // Server end -> client end -> real network socket.
    if (this.peer && this.peer.transport) this.peer.transport.send(String(data));
  }
  close(code = 1000, reason = '') {
    if (this.readyState !== 1) return;
    this.readyState = 3;
    if (this.peer && this.peer.transport) this.peer.transport.close(code, reason);
  }
  serializeAttachment(v) { this.attachment = v == null ? null : structuredClone(v); }
  deserializeAttachment() { return this.attachment == null ? null : structuredClone(this.attachment); }
}

class WebSocketPair {
  constructor() {
    const client = new ShimSocket();
    const server = new ShimSocket();
    client.peer = server;
    server.peer = client;
    this[0] = client;
    this[1] = server;
  }
}

export function installGlobals() {
  globalThis.Response = CFResponse;
  globalThis.WebSocketPair = WebSocketPair;
}

// ---------- SQLite storage with the DO cursor API ----------
function cursorOf(rows) {
  let i = 0;
  const plain = rows.map((r) => ({ ...r }));
  return {
    rowsRead: plain.length,
    rowsWritten: 0,
    columnNames: plain.length ? Object.keys(plain[0]) : [],
    next() { return i < plain.length ? { done: false, value: plain[i++] } : { done: true, value: undefined }; },
    toArray() { const rest = plain.slice(i); i = plain.length; return rest; },
    one() {
      if (plain.length !== 1) throw new Error(`Expected exactly one row, got ${plain.length}`);
      return plain[0];
    },
    raw() { const rest = plain.slice(i); i = plain.length; return { toArray: () => rest.map((r) => Object.values(r)) }; },
    [Symbol.iterator]() { return { next: () => this.next() }; },
  };
}

function makeStorage(db, onAlarm) {
  let alarmAt = null;
  let timer = null;
  const sql = {
    exec(query, ...bindings) {
      if (/\b(BEGIN|COMMIT|ROLLBACK|SAVEPOINT)\b/i.test(query)) {
        throw new Error('sql.exec cannot run transaction statements; use transactionSync');
      }
      const statements = query.split(';').map((s) => s.trim()).filter(Boolean);
      if (statements.length > 1) {
        if (bindings.length) {
          db.exec(statements.slice(0, -1).join(';\n') + ';');
          return cursorOf(db.prepare(statements[statements.length - 1]).all(...bindings));
        }
        db.exec(query);
        return cursorOf([]);
      }
      const norm = bindings.map((b) => (typeof b === 'boolean' ? (b ? 1 : 0) : b === undefined ? null : b));
      return cursorOf(db.prepare(query).all(...norm));
    },
    get databaseSize() { return 0; },
  };
  let depth = 0;
  return {
    sql,
    transactionSync(fn) {
      if (depth > 0) return fn();
      depth += 1;
      db.exec('BEGIN');
      try {
        const r = fn();
        db.exec('COMMIT');
        return r;
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      } finally {
        depth -= 1;
      }
    },
    async getAlarm() { return alarmAt; },
    setAlarm(when) {
      const ms = when instanceof Date ? when.getTime() : Number(when);
      alarmAt = ms;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { alarmAt = null; timer = null; onAlarm(); }, Math.max(0, ms - Date.now()));
      return Promise.resolve();
    },
    async deleteAlarm() { if (timer) clearTimeout(timer); timer = null; alarmAt = null; },
    close() { if (timer) clearTimeout(timer); timer = null; },
  };
}

// ---------- Durable Object namespace ----------
export function makeNamespace(DOClass, env, { dataDir = null } = {}) {
  const instances = new Map();
  if (dataDir) mkdirSync(dataDir, { recursive: true });
  const instance = (name) => {
    if (instances.has(name)) return instances.get(name);
    const file = dataDir ? join(dataDir, name.replace(/[^A-Z0-9-]/gi, '_') + '.sqlite') : ':memory:';
    const db = new DatabaseSync(file);
    const sockets = new Set();
    let obj = null;
    // Like workerd, events for one object never run at the same time.
    let chain = Promise.resolve();
    const serial = (fn) => { const p = chain.then(fn, fn); chain = p.catch(() => {}); return p; };
    const storage = makeStorage(db, () => serial(() => obj.alarm && obj.alarm()));
    const ctx = {
      storage,
      id: { name, toString: () => name },
      acceptWebSocket(ws) { sockets.add(ws); ws.__accepted = true; },
      getWebSockets() { return [...sockets].filter((s) => s.readyState === 1); },
      blockConcurrencyWhile: (fn) => fn(),
      waitUntil() {},
    };
    obj = new DOClass(ctx, env);
    const rec = {
      obj, ctx, db, sockets, serial,
      fetch: (req) => serial(() => obj.fetch(req)),
      message: (ws, data) => serial(() => obj.webSocketMessage(ws, data)),
      close: (ws, code, reason) => serial(async () => {
        ws.readyState = 3;
        sockets.delete(ws);
        await obj.webSocketClose(ws, code, reason, true);
      }),
    };
    instances.set(name, rec);
    return rec;
  };
  return {
    instances,
    idFromName(name) { return { name, toString: () => name }; },
    get(id) {
      return {
        fetch: async (input, init) => {
          const req = input instanceof Request ? input : new Request(input, init);
          return instance(id.name).fetch(req);
        },
      };
    },
    // For the HTTP layer: which object owns a server-side socket.
    owner(ws) {
      for (const rec of instances.values()) if (rec.sockets.has(ws)) return rec;
      return null;
    },
    closeAll() { for (const rec of instances.values()) { rec.ctx.storage.close(); rec.db.close(); } },
  };
}
