// End-to-end: start the dev server, play a full game with real WebSocket clients plus bots.
// Checks simultaneous broadcast, delta sync after a dropped connection, no secrets on the wire,
// an intact hash chain, and passports at the end.
import { spawn } from 'node:child_process';
import { verifyChain } from '../public/engine/core.js';

const PORT = 8799;
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FORBIDDEN = ['secret', 'secretElo', 'elo', 'eloLog', 'claimTruth', 'tokens', 'threshold', 'turnedHistory', 'deeds', 'botMem'];

function scan(obj, hits, path = '') {
  if (!obj || typeof obj !== 'object') return;
  for (const [k, v] of Object.entries(obj)) {
    if (FORBIDDEN.includes(k)) hits.push(path + '.' + k);
    scan(v, hits, path + '.' + k);
  }
}

const srv = spawn(process.execPath, ['--no-warnings', 'server/dev.mjs', '--port', String(PORT), '--memory', '--quiet'], {
  env: { ...process.env, HANDSHAKE_DEV: '1', NODE_USE_ENV_PROXY: '0' }, stdio: ['ignore', 'pipe', 'pipe'],
});
srv.stderr.on('data', (d) => process.stderr.write('[server] ' + d));
await new Promise((resolve) => srv.stdout.on('data', (d) => { if (String(d).includes('running')) resolve(); }));

const fail = (msg) => { console.error('FAIL:', msg); srv.kill(); process.exit(1); };
const get = (p) => fetch(BASE + p).then((r) => r.json().then((j) => ({ status: r.status, j })));

const health = await get('/api/health');
if (!health.j.ok) fail('health');
if ((await get('/api/rooms/NOPE')).status !== 400) fail('bad code should be 400');
if ((await get('/api/rooms/ABCD-EFGH/meta')).status !== 404) fail('unknown room should be 404');

const created = await fetch(BASE + '/api/rooms', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ config: { seats: 7, tier: 4, pace: 'blitz', fillBots: true } }),
}).then((r) => r.json());
const code = created.code;
console.log('room', code);

class Client {
  constructor(name, token) {
    this.name = name; this.token = token; this.events = []; this.lastSeq = 0; this.msgs = 0;
    this.seat = null; this.pub = null; this.priv = null; this.outbreakAt = []; this.leaks = []; this.gaps = 0; this.drop = false;
  }
  connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}/api/rooms/${code}/ws`);
      this.ws = ws;
      ws.onopen = () => ws.send(JSON.stringify({ t: 'hello', token: this.token, lastSeq: this.lastSeq }));
      ws.onerror = (e) => reject(e);
      ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data);
        this.msgs++;
        if (msg.t === 'welcome') { this.seat = msg.seat; if (msg.token) this.token = msg.token; resolve(); }
        if (msg.t === 'error') reject(new Error(msg.err));
        if (msg.t === 'state' || msg.t === 'sync') this.onState(msg);
      };
    });
  }
  onState(msg) {
    if (msg.pub && msg.pub.phase !== 'end') { const hits = []; scan(msg, hits); if (hits.length) this.leaks.push(hits); }
    for (const e of msg.events || []) {
      if (e.seq <= this.lastSeq) continue;
      if (e.seq !== this.lastSeq + 1) this.gaps++;
      this.events.push(e);
      this.lastSeq = e.seq;
    }
    for (const f of msg.fx || []) if (f.kind === 'outbreak') this.outbreakAt.push({ at: f.at, recv: performance.now() + performance.timeOrigin });
    this.pub = msg.pub; this.priv = msg.priv;
    this.respond();
  }
  send(intent) {
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify({ t: 'intent', id: crypto.randomUUID(), ps: this.pub.ps, ...intent }));
  }
  respond() {
    const p = this.pub, me = this.priv;
    if (!p || !me || this.drop) return;
    const key = `${p.ps}`;
    if (this.answered === key) return;
    this.answered = key;
    const L = me.legal || {};
    if (p.phase === 'talk') {
      if (L.words && L.words.left > 0 && Math.random() < 0.5) this.send({ k: 'word', kind: 'still' });
      if (p.config.tableTalk && Math.random() < 0.3) this.send({ k: 'talk', text: `${this.name} here <b>hi</b>` });
      this.send({ k: 'ready' });
    } else if (p.phase === 'act') {
      const c = (L.actions || []).find((a) => a.kind === 'contribute');
      const a = c && Math.random() < 0.7 ? { kind: 'contribute', res: c.res[0], n: 1 } : { kind: 'still' };
      this.send({ k: 'act', a });
    } else if (p.phase === 'vote' && L.canVote) {
      this.send({ k: 'vote', yes: Math.random() < 0.5 });
    } else if (p.phase === 'prodigal' && p.prodigal && p.prodigal.seat === me.seat) {
      this.send({ k: 'prodigal', choice: 'confess', text: 'I turned.' });
    } else if (p.phase === 'reveal') {
      this.send({ k: 'ready' });
    }
  }
}

const host = new Client('host', created.token);
await host.connect();
const a = new Client('ana'); await a.connect();
const b = new Client('ben'); await b.connect();
if (host.seat !== 0 || a.seat == null || b.seat == null) fail('seats');
console.log('seats', host.seat, a.seat, b.seat);
host.send({ k: 'start' });

let dropped = false;
const t0 = Date.now();
while (Date.now() - t0 < 240000) {
  await sleep(250);
  const p = host.pub;
  if (!p) continue;
  if (!dropped && p.round === 4 && p.phase === 'talk') {
    // Refresh mid-round: drop and come back with the last seen sequence.
    dropped = true;
    const before = a.lastSeq;
    a.drop = true; a.ws.close();
    await sleep(1200);
    a.drop = false;
    await a.connect();
    console.log(`reconnected seat ${a.seat} from seq ${before}; caught up to ${a.lastSeq}`);
  }
  if (p.phase === 'end') break;
}
await sleep(500);
const p = host.pub;
if (!p || p.phase !== 'end') fail('game did not finish: ' + (p && p.phase));
console.log('result', p.result.kind, 'rounds', p.round, 'events', host.events.length);

for (const c of [host, a, b]) {
  if (c.leaks.length) fail(`${c.name} saw secret keys: ${JSON.stringify(c.leaks[0])}`);
  if (c.gaps) fail(`${c.name} had ${c.gaps} sequence gaps`);
  const chain = verifyChain(c.events);
  if (!chain.ok) fail(`${c.name} chain broken at ${chain.at}`);
  if (!c.priv.passport) fail(`${c.name} got no passport`);
}
if (host.events.length !== a.events.length || host.events.at(-1).hash !== a.events.at(-1).hash) fail('clients disagree on the ledger');

// Simultaneous broadcast: every phone got the outbreak at the same moment.
const n = Math.min(host.outbreakAt.length, b.outbreakAt.length);
for (let i = 0; i < n; i++) {
  const skew = Math.abs(host.outbreakAt[i].recv - b.outbreakAt[i].recv);
  const sameAt = host.outbreakAt[i].at === b.outbreakAt[i].at;
  console.log(`outbreak ${i + 1}: reveal time identical=${sameAt}, receive skew ${skew.toFixed(1)} ms`);
  if (!sameAt || skew > 50) fail('outbreak was staggered');
}
if (!n) console.log('(no outbreak this game)');

const meta = await get(`/api/rooms/${code}/meta`);
if (meta.j.phase !== 'end') fail('meta');
const poll = await get(`/api/rooms/${code}/poll?token=${encodeURIComponent(a.token)}&since=${a.lastSeq - 3}`);
if (!poll.j.pub || !poll.j.priv || poll.j.events.length !== 3) fail('poll payload split');
const badPoll = await get(`/api/rooms/${code}/poll?token=nope`);
if (badPoll.status !== 403) fail('poll needs a token');

console.log('SMOKE OK');
srv.kill();
process.exit(0);
