// Links between the phone and a room.
// ServerLink: WebSocket to the room's Durable Object, with delta sync on reconnect,
//   gap flagging, a server-clock offset, and HTTP fallbacks for catch-up and intents.
// LocalLink: the same room engine running inside this page, for practice with bots.

import { RoomCore } from '../engine/core.js';
import { memoryIO } from '../engine/memory-io.js';
import { uuid } from './dom.js';

export class ServerLink {
  constructor({ code, token, passport, onMessage, onStatus }) {
    this.code = code;
    this.token = token || null;
    this.passport = passport || null;
    this.onMessage = onMessage;
    this.onStatus = onStatus || (() => {});
    this.lastSeq = 0;
    this.offset = 0;
    this.bestRtt = Infinity;
    this.pending = new Map();
    this.backoff = 500;
    this.closed = false;
    this.ws = null;
    this.pingTimer = null;
  }

  serverNow() { return Date.now() + this.offset; }

  connect() {
    if (this.closed) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/api/rooms/${encodeURIComponent(this.code)}/ws`);
    this.ws = ws;
    this.onStatus('connecting');
    ws.onopen = () => {
      this.backoff = 500;
      this.hello();
      this.ping();
      clearInterval(this.pingTimer);
      this.pingTimer = setInterval(() => this.ping(), 15000);
    };
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      this.receive(msg);
    };
    ws.onclose = (ev) => {
      clearInterval(this.pingTimer);
      this.onStatus('closed', ev.reason);
      if (this.closed || (ev.code >= 4000 && ev.code < 4100)) return;
      setTimeout(() => this.connect(), this.backoff);
      this.backoff = Math.min(8000, this.backoff * 2);
    };
    ws.onerror = () => {};
  }

  hello() {
    this.send0({ t: 'hello', token: this.token || undefined, lastSeq: this.lastSeq, passport: this.passport || undefined });
  }

  ping() {
    this.send0({ t: 'ping', echo: performance.now() });
  }

  send0(obj) {
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(obj));
  }

  receive(msg) {
    if (msg.t === 'pong') {
      const rtt = performance.now() - msg.echo;
      if (rtt < this.bestRtt + 30) {
        this.bestRtt = Math.min(this.bestRtt, rtt);
        this.offset = msg.now + rtt / 2 - Date.now();
      }
      return;
    }
    if (msg.t === 'ack') {
      const p = this.pending.get(msg.id);
      if (p) { clearTimeout(p.timer); this.pending.delete(msg.id); p.resolve(msg); }
      return;
    }
    if (msg.t === 'welcome') {
      if (msg.token) this.token = msg.token;
      if (!Number.isFinite(this.bestRtt)) this.offset = msg.now - Date.now();
      this.onStatus('open');
    }
    if (msg.t === 'state' || msg.t === 'sync') {
      // Gaps are flagged, not skipped: ask for exactly what was missed.
      const evs = msg.events || [];
      if (evs.length && evs[0].seq > this.lastSeq + 1 && msg.t === 'state') {
        this.onStatus('gap', { from: this.lastSeq + 1, to: evs[0].seq - 1 });
        this.hello();
        return;
      }
      for (const e of evs) if (e.seq > this.lastSeq) this.lastSeq = e.seq;
    }
    this.onMessage(msg);
  }

  send(intent) {
    const id = uuid();
    const msg = { t: 'intent', id, ...intent };
    if (this.ws && this.ws.readyState === 1) {
      return new Promise((resolve) => {
        const timer = setTimeout(() => { this.pending.delete(id); resolve({ ok: false, err: 'timeout' }); }, 8000);
        this.pending.set(id, { resolve, timer });
        this.ws.send(JSON.stringify(msg));
      });
    }
    // While the socket reconnects, intents still reach the room over HTTP.
    return fetch(`/api/rooms/${encodeURIComponent(this.code)}/intent`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: this.token, msg }),
    }).then((r) => r.json()).catch(() => ({ ok: false, err: 'timeout' }));
  }

  close() {
    this.closed = true;
    clearInterval(this.pingTimer);
    if (this.ws) this.ws.close();
  }
}

export class LocalLink {
  constructor({ config, specHash, onMessage, onStatus }) {
    this.onMessage = onMessage;
    this.onStatus = onStatus || (() => {});
    this.timer = null;
    this.io = memoryIO({
      clock: () => Date.now(),
      passportKey: 'handshake-practice',
      // Deliver after the engine finishes its turn, in order, like a network would.
      onSend: (seat, msg) => { if (seat === 0) queueMicrotask(() => this.onMessage(msg)); },
      onAlarm: (ms) => this.arm(ms),
    });
    const seed = crypto.getRandomValues(new Uint32Array(1))[0];
    const { core, hostToken } = RoomCore.create({ code: 'PRACTICE', now: Date.now(), seed, specHash: specHash || 'practice', config }, this.io);
    this.core = core;
    this.token = hostToken;
    this.code = 'PRACTICE';
  }

  serverNow() { return Date.now(); }

  arm(ms) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.core.tick(Date.now()), Math.max(0, ms - Date.now()));
  }

  connect() {
    this.io.conns.add(0);
    this.onStatus('open');
    this.core.greet(0, { token: this.token, isNew: true, lastSeq: 0 }, Date.now());
  }

  send(intent) {
    const res = this.core.intent(0, { id: uuid(), ...intent }, Date.now());
    return Promise.resolve({ t: 'ack', ...res });
  }

  close() {
    clearTimeout(this.timer);
    this.io.conns.clear();
  }
}
