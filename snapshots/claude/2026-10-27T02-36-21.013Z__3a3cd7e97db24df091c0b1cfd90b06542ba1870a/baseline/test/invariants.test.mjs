// The seven locked invariants, one test each (plus "presence cannot be targeted").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runBotGame } from '../scripts/sim-lib.mjs';
import { makeTable } from './helpers.mjs';
import { HEAT_RISE_CAP, EARLIEST_OUTBREAK_ROUND } from '../public/engine/constants.js';
import { activeImposters } from '../public/engine/rules.js';
import { verifyChain } from '../public/engine/core.js';
import { publicSnapshot, privateDelta } from '../public/engine/views.js';
import { newRoomCode, normalizeCode, CODE_ALPHABET } from '../src/codes.js';
import { legalActions } from '../public/engine/legal.js';

const SEEDS = Array.from({ length: 60 }, (_, i) => 900 + i);

test('1. imposter count starts at one and stacks to a cap', () => {
  for (const seed of SEEDS) {
    let lastCount = 0;
    runBotGame({
      seed, seats: 4 + (seed % 9), tier: 1 + (seed % 5), fast: false,
      onTick: (core) => {
        const s = core.state;
        const count = s.secret.turnedHistory.length;
        assert.ok(count - lastCount <= 1, 'never more than one turning at a time');
        if (lastCount === 0 && count > 0) assert.equal(count, 1, 'first outbreak makes exactly one');
        assert.ok(activeImposters(s) <= s.secret.outbreak.cap, 'active imposters never exceed the cap');
        assert.ok(s.secret.outbreak.cap >= 1 && s.secret.outbreak.cap <= 3);
        lastCount = count;
      },
    });
  }
});

test('2. sacrifice is idempotent', () => {
  const T = makeTable({ seats: 4 });
  T.start();
  T.state.secret.outbreak.threshold = 999;
  T.allReady(); // talk -> act (round 1)
  T.act();
  T.skipTo('talk'); // round 2
  T.state.heat = 60; // pressure
  T.allReady();
  const pop = T.seatOf('populist');
  const msg = { k: 'act', id: 'sac-1', a: { kind: 'sacrifice' } };
  const first = T.intent(pop.id, msg);
  const replay = T.intent(pop.id, msg);
  assert.ok(first.ok);
  assert.ok(replay.replay, 'same intent id replays the stored result');
  for (const s of T.state.seats) if (s.id !== pop.id) T.intent(s.id, { k: 'act', a: { kind: 'still' } });
  assert.equal(T.state.phase, 'reveal');
  assert.equal(T.state.secret.sacrifices.filter((x) => x.seat === pop.id).length, 1);
  assert.equal(pop.assets.crowd, 0);
  // A second offering by the same seat is no longer a legal move.
  T.skipTo('act');
  assert.ok(!legalActions(T.state, pop.id).some((a) => a.kind === 'sacrifice'));
  const again = T.intent(pop.id, { k: 'act', id: 'sac-2', a: { kind: 'sacrifice' } });
  assert.equal(again.ok, false);
});

test('3. the clock is server-owned', () => {
  const T = makeTable({ seats: 4 });
  T.start();
  const seat = T.state.seats[1];
  // Client timestamps are ignored entirely.
  const r1 = T.intent(seat.id, { k: 'ready', ts: 1, at: 99999999999, now: 0 });
  assert.ok(r1.ok);
  // Anything after the server deadline is late, whatever the client thinks.
  T.now = T.state.phaseEndsAt + 1;
  const late = T.core.intent(seat.id, { k: 'word', ps: T.state.phaseSeq, kind: 'still' }, T.now);
  assert.equal(late.err, 'late');
  // Intents aimed at a phase that already ended are stale.
  T.core.tick(T.now);
  const stale = T.core.intent(seat.id, { k: 'ready', ps: T.state.phaseSeq - 1 }, T.now);
  assert.equal(stale.err, 'stale');
});

test('4. room codes are not guessable', () => {
  const seen = new Set();
  const counts = Object.fromEntries([...CODE_ALPHABET].map((c) => [c, 0]));
  for (let i = 0; i < 20000; i++) {
    const c = newRoomCode();
    assert.match(c, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    assert.ok(!seen.has(c), 'no repeats in 20k codes');
    seen.add(c);
    for (const ch of c.replace('-', '')) counts[ch] += 1;
    assert.equal(normalizeCode(c.toLowerCase().replace('-', ' ')), c);
  }
  for (const ch of 'ILOU01') assert.ok(!CODE_ALPHABET.includes(ch));
  const expected = (20000 * 8) / CODE_ALPHABET.length;
  for (const [ch, n] of Object.entries(counts)) assert.ok(Math.abs(n - expected) / expected < 0.08, `letter ${ch} is uniform`);
  assert.ok(Math.log2(CODE_ALPHABET.length ** 8) > 39, 'about 39 bits per code');
});

test('5. the ledger appends and never mutates', () => {
  for (const seed of SEEDS.slice(0, 20)) {
    let prev = [];
    const { io } = runBotGame({
      seed, seats: 6, tier: 3, fast: false,
      onTick: (core, t) => {
        const now = core.io.ledger.map((e) => e.hash);
        assert.deepEqual(now.slice(0, prev.length), prev, 'earlier entries are untouched');
        prev = now;
      },
    });
    assert.ok(verifyChain(io.ledger).ok, 'hash chain verifies');
    const tampered = io.ledger.map((e) => ({ ...e }));
    tampered[3].text = tampered[3].text + ' (edited)';
    assert.equal(verifyChain(tampered).ok, false, 'an edit breaks the chain');
  }
});

const FORBIDDEN_KEYS = ['secret', 'secretElo', 'elo', 'eloLog', 'claimTruth', 'tokens', 'threshold', 'turnedHistory', 'deeds', 'presenceLog', 'botMem'];

function scanKeys(obj, path, hits) {
  if (!obj || typeof obj !== 'object') return;
  for (const [k, v] of Object.entries(obj)) {
    if (FORBIDDEN_KEYS.includes(k)) hits.push(path + '.' + k);
    scanKeys(v, path + '.' + k, hits);
  }
}

test('6. clients never receive secret truth', () => {
  for (const seed of SEEDS.slice(0, 30)) {
    runBotGame({
      seed, seats: 4 + (seed % 9), tier: 1 + (seed % 5), fast: false, listen: true,
      onSend: (seatId, msg, core) => {
        if (msg.pub && msg.pub.phase === 'end') return; // the epilogue is where secrets are released
        const hits = [];
        scanKeys({ pub: msg.pub, priv: msg.priv, events: msg.events, fx: msg.fx }, 'msg', hits);
        assert.deepEqual(hits, [], `seat ${seatId} got secret keys`);
        if (msg.priv) {
          assert.equal(msg.priv.seat, seatId, 'private delta goes only to its own seat');
          assert.equal(msg.priv.turned, !!core.state.secret.turned[seatId], 'only your own turning is told to you');
          for (const n of msg.priv.notes) assert.ok(!(n.data && n.data.turned) || core.state.secret.turnedHistory.some((x) => x.seat === seatId));
        }
        for (const e of msg.events || []) {
          if (e.kind === 'spoil' || e.kind === 'stoke' || e.kind === 'outbreak') assert.ok(!('seat' in (e.data || {})), 'secret deeds never name a seat');
        }
      },
    });
  }
});

test('6b. views do not read secrets (noninterference)', () => {
  const { core } = runBotGame({ seed: 4242, seats: 8, tier: 4, maxTicks: 30 });
  const s = core.state;
  const before = JSON.stringify(publicSnapshot(s));
  const privBefore = s.seats.map((x) => JSON.stringify({ ...privateDelta(s, x.id), turned: null }));
  // Scramble everything secret except each seat's own turned flag.
  s.secret.elo = Object.fromEntries(s.seats.map((x) => [x.id, Math.random() * 3000]));
  s.secret.sacrifices = s.secret.sacrifices.map((x) => ({ ...x, valid: !x.valid }));
  s.secret.outbreak.threshold = -5;
  s.secret.claimTruth = {};
  s.secret.tokens = {};
  if (s.phase !== 'end') {
    assert.equal(JSON.stringify(publicSnapshot(s)), before);
    s.seats.forEach((x, i) => assert.equal(JSON.stringify({ ...privateDelta(s, x.id), turned: null }), privBefore[i]));
  }
});

test('7. slow is fast: nothing turns before day 3, heat never flash-fires', () => {
  for (const seed of SEEDS) {
    runBotGame({
      seed, seats: 4 + (seed % 9), tier: 1 + (seed % 5), fast: false,
      onTick: (core) => {
        const s = core.state;
        assert.ok(s.heatRise <= HEAT_RISE_CAP, `heat rose ${s.heatRise} in one round`);
        for (const t of s.secret.turnedHistory) assert.ok(t.round >= EARLIEST_OUTBREAK_ROUND);
        assert.ok(s.heat >= 0 && s.heat <= 100);
      },
    });
  }
});

test('presence cannot be targeted: it only moves with your own deeds', () => {
  const SELF = new Set(['hoarding', 'hunger', 'thirst', 'esther', 'returned', 'sacrifice', 'contested', 'boundary', 'gift', 'spoil', 'stoke', 'still', 'desync', 'in_sync', 'confess', 'silence_broken']);
  for (const seed of SEEDS.slice(0, 20)) {
    const { core } = runBotGame({ seed, seats: 7, tier: 3 });
    for (const e of core.state.secret.presenceLog || []) assert.ok(SELF.has(e.reason), `unexpected presence cause ${e.reason}`);
  }
  // No action anywhere names presence as a target.
  const T = makeTable({ seats: 4 });
  T.start();
  T.allReady();
  for (const s of T.state.seats) {
    for (const a of legalActions(T.state, s.id)) assert.ok(!/presence/i.test(a.kind));
    const r = T.intent(s.id, { k: 'act', a: { kind: 'presence', target: 0 } });
    assert.equal(r.ok, false);
  }
});
