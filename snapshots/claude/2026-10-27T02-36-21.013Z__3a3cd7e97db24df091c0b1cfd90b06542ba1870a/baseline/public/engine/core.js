// RoomCore: the single writer for one room.
// Every intent, timer, connect and disconnect passes through here, one at a time,
// synchronously. The host environment (Durable Object, Node dev server, or the
// in-browser preview) supplies I/O through `io` and never touches rules directly.
//
// io = {
//   now(), save(state), appendLedger(entries), readLedger(sinceSeq) -> entries,
//   getIntent(key), putIntent(key, result), connectedSeats() -> iterable of seat ids,
//   send(seatId, msg), setAlarm(ms), passportKey (string), fast (bool, tests)
// }

import { LIMITS, LIVE_PHASES, tierById } from './constants.js';
import { createRoom, newSeat, priv, seatById, botRng } from './state.js';
import { handleIntent } from './intents.js';
import { advance } from './rules.js';
import { voteEligible } from './legal.js';
import { publicSnapshot, privateDelta } from './views.js';
import { sha256, hmacSha256, GENESIS_HASH } from './sha256.js';
import { newMemory, observe, botIntents, personaFor, standInPersona } from './bots.js';
import { RUBRIC } from './content.js';

export function randomHex(bytes = 16) {
  const a = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function canonicalEntry(e) {
  return JSON.stringify([e.seq, e.ts, e.round, e.act, e.kind, e.text, e.data]);
}

export function chainHash(prev, e) {
  return sha256(prev + '|' + canonicalEntry(e));
}

export function verifyChain(entries, startHead = GENESIS_HASH) {
  let head = startHead;
  for (const e of entries) {
    if (e.prev !== head) return { ok: false, at: e.seq, why: 'prev' };
    if (chainHash(head, e) !== e.hash) return { ok: false, at: e.seq, why: 'hash' };
    head = e.hash;
  }
  return { ok: true, head };
}

const b64 = {
  enc: (s) => btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
  dec: (s) => atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)),
};

export function signPassport(key, marks, games) {
  const body = b64.enc(JSON.stringify({ v: 1, m: marks.slice().sort(), g: games }));
  return `${body}.${hmacSha256(key, body)}`;
}

export function readPassport(key, token) {
  if (typeof token !== 'string' || token.length > 2000 || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  if (hmacSha256(key, body) !== sig) return null;
  try {
    const p = JSON.parse(b64.dec(body));
    const ids = new Set(RUBRIC.map((r) => r.id));
    return { marks: (p.m || []).filter((m) => ids.has(m)), games: Number(p.g) || 0 };
  } catch {
    return null;
  }
}

export class RoomCore {
  constructor(state, io) {
    this.state = state;
    this.io = io;
  }

  static create({ code, now, seed, specHash, config, allowDev }, io) {
    const state = createRoom({ code, now, seed, specHash, config, allowDev });
    const core = new RoomCore(state, io);
    const host = newSeat(state, { human: true });
    const token = randomHex(16);
    state.secret.tokens[host.id] = token;
    state.hostSeat = host.id;
    io.save(state);
    return { core, hostToken: token };
  }

  // ----- connections -----

  authenticate(msg, now) {
    const s = this.state;
    let seat = null;
    let token = null;
    let isNew = false;
    if (msg && typeof msg.token === 'string') {
      const entry = Object.entries(s.secret.tokens).find(([, t]) => t === msg.token);
      if (entry) { seat = seatById(s, Number(entry[0])); token = msg.token; }
      else return { err: 'bad_token' };
    } else {
      if (s.phase !== 'lobby') return { err: 'started' };
      if (s.seats.length >= LIMITS.maxSeats) return { err: 'full' };
      seat = newSeat(s, { human: true });
      token = randomHex(16);
      s.secret.tokens[seat.id] = token;
      s.invites.accepted += 1;
      isNew = true;
    }
    if (msg && msg.passport && this.io.passportKey) {
      const p = readPassport(this.io.passportKey, msg.passport);
      if (p) { priv(s, seat.id).passportMarks = p.marks; priv(s, seat.id).passportGames = p.games; seat.marks = p.marks.length; }
    }
    return { seat: seat.id, token, isNew };
  }

  greet(seatId, { token, isNew, lastSeq }, now) {
    const s = this.state;
    const seat = seatById(s, seatId);
    seat.connected = true;
    seat.dcAt = null;
    seat.standIn = false;
    if (isNew) s.fx.push({ kind: 'join', seat: seatId, n: s.seats.filter((x) => x.human).length });
    const since = Number.isInteger(lastSeq) && lastSeq >= 0 ? lastSeq : 0;
    this.io.send(seatId, { t: 'welcome', seat: seatId, token: isNew ? token : undefined, room: s.code, now });
    this.io.send(seatId, {
      t: 'sync', now, since,
      events: this.io.readLedger(since),
      pub: publicSnapshot(s), priv: privateDelta(s, seatId),
    });
    this.flush(now);
  }

  disconnect(seatId, now) {
    const seat = seatById(this.state, seatId);
    if (!seat) return;
    seat.connected = false;
    seat.dcAt = now;
    this.flush(now);
  }

  invite(kind, now) {
    if (kind === 'seen') this.state.invites.read += 1;
    else if (kind === 'left') this.state.invites.leftOnRead += 1;
    else return;
    this.flush(now);
  }

  // ----- intents -----

  intent(seatId, msg, now) {
    const s = this.state;
    const id = typeof msg.id === 'string' ? msg.id.slice(0, 64) : null;
    const key = id ? `${seatId}:${id}` : null;
    if (key) {
      const prev = this.io.getIntent(key);
      if (prev) return { ...prev, replay: true };
    }
    let res;
    const phaseAgnostic = msg.k === 'talk' || msg.k === 'config';
    if (!phaseAgnostic && Number.isInteger(msg.ps) && msg.ps !== s.phaseSeq) res = { ok: false, err: 'stale' };
    else if (!phaseAgnostic && s.phaseEndsAt != null && now > s.phaseEndsAt) res = { ok: false, err: 'late' };
    else res = handleIntent(s, seatId, msg, now);
    if (key) this.io.putIntent(key, res);
    if (res.ok) {
      if (msg.k === 'offer') {
        const to = seatById(s, msg.to);
        if (to && (to.bot || to.standIn)) s.timers.botAt = Math.min(s.timers.botAt ?? Infinity, now + 1200);
      }
      this.settle(now);
    }
    return res;
  }

  // ----- time -----

  tick(now) {
    this.settle(now);
  }

  participants() {
    return this.state.seats.filter((x) => x.bot || x.standIn || x.connected);
  }

  humansConnected() {
    return this.state.seats.some((x) => x.human && x.connected && !x.standIn);
  }

  phaseDone() {
    const s = this.state;
    const P = this.participants();
    switch (s.phase) {
      case 'talk': return P.length > 0 && P.every((x) => x.ready);
      case 'act': return P.length > 0 && P.every((x) => x.acted);
      case 'vote': {
        const eligible = new Set(voteEligible(s));
        const voters = P.filter((x) => eligible.has(x.id));
        return voters.every((x) => x.voted);
      }
      case 'prodigal': return !!(s.prodigal && s.prodigal.choice);
      case 'reveal': {
        const humans = s.seats.filter((x) => x.human && x.connected && !x.standIn);
        return humans.length > 0 && humans.every((x) => x.ready);
      }
      default: return false;
    }
  }

  shouldAdvance(now) {
    const s = this.state;
    if (s.phase === 'lobby' || s.phase === 'end') return false;
    if (s.phaseEndsAt != null && now >= s.phaseEndsAt) return true;
    const live = LIVE_PHASES.has(s.phase);
    if (!this.humansConnected()) {
      if (!live) return true;
      return s.timers.botAt == null && this.phaseDone();
    }
    if (live && s.timers.botAt != null && this.participants().some((x) => x.bot || x.standIn)) return false;
    return this.phaseDone();
  }

  settle(now) {
    const s = this.state;
    // Disconnect during live action: a stand-in takes the seat after a grace period.
    for (const seat of s.seats) {
      if (seat.human && !seat.connected && seat.dcAt != null && !seat.standIn && s.phase !== 'lobby' && s.phase !== 'end'
        && now - seat.dcAt >= LIMITS.standInGraceMs) {
        seat.standIn = true;
      }
    }
    // A host who walks away from the lobby hands it on.
    if (s.phase === 'lobby') {
      const host = seatById(s, s.hostSeat);
      if (host && !host.connected && host.dcAt != null && now - host.dcAt > 30000) {
        const next = s.seats.find((x) => x.human && x.connected);
        if (next) s.hostSeat = next.id;
      }
    }
    for (let guard = 0; guard < 40; guard++) {
      if (s.timers.botAt != null && now >= s.timers.botAt) {
        s.timers.botAt = null;
        this.runBots(now);
      }
      if (this.shouldAdvance(now)) {
        advance(s, now);
        if (this.io.fast && s.timers.botAt != null) s.timers.botAt = now;
        continue;
      }
      break;
    }
    this.flush(now);
  }

  runBots(now) {
    const s = this.state;
    if (!LIVE_PHASES.has(s.phase)) return;
    const tier = tierById(s.config.tier);
    for (const seat of s.seats) {
      if (!seat.bot && !seat.standIn) continue;
      const p = priv(s, seat.id);
      const mem = (p.botMem ||= newMemory());
      const pub = publicSnapshot(s);
      const me = privateDelta(s, seat.id);
      observe(mem, pub, me, this.io.readLedger(mem.seen).concat(pendingAsEntries(s, mem.seen)));
      const persona = seat.bot ? personaFor(s.code, seat.id) : standInPersona(s.secret.elo[seat.id], s.heat);
      const intents = botIntents({ pub, me, mem, rng: botRng(s), persona, skill: tier.botSkill, archetype: seat.archetype });
      for (const it of intents) handleIntent(s, seat.id, it, now);
    }
  }

  // ----- output -----

  flushLedger(now) {
    const s = this.state;
    const out = [];
    for (const e of s.pendingLedger) {
      const body = { seq: s.ledger.seq + 1, ts: now, round: e.round, act: e.act, kind: e.kind, text: e.text, data: e.data };
      const hash = chainHash(s.ledger.head, body);
      const entry = { ...body, prev: s.ledger.head, hash };
      s.ledger.seq = body.seq;
      s.ledger.head = hash;
      out.push(entry);
    }
    s.pendingLedger = [];
    if (out.length) this.io.appendLedger(out);
    return out;
  }

  issuePassports() {
    const s = this.state;
    if (s.phase !== 'end' || s.passportsIssued || !this.io.passportKey || !s.epilogue) return;
    s.passportsIssued = true;
    for (const e of s.epilogue) {
      const seat = seatById(s, e.id);
      if (!seat.human) continue;
      const p = priv(s, seat.id);
      const marks = Array.from(new Set([...(p.passportMarks || []), ...e.marks]));
      p.passport = signPassport(this.io.passportKey, marks, (p.passportGames || 0) + 1);
      p.passportMarks = marks;
    }
  }

  flush(now) {
    const s = this.state;
    this.issuePassports();
    const events = this.flushLedger(now);
    // Simultaneous broadcast: one loop, one message per phone, one reveal time.
    const fx = s.fx.map((f) => ({ ...f, at: now + (f.kind === 'outbreak' || f.kind === 'bell' || f.kind === 'matrix' ? 1200 : 0) }));
    s.fx = [];
    this.io.save(s);
    const pub = publicSnapshot(s);
    for (const seatId of this.io.connectedSeats()) {
      this.io.send(seatId, { t: 'state', now, pub, priv: privateDelta(s, seatId), events, fx });
    }
    this.reschedule(now);
  }

  reschedule(now) {
    const s = this.state;
    const times = [s.phaseEndsAt, s.timers.botAt];
    for (const seat of s.seats) {
      if (seat.human && !seat.connected && seat.dcAt != null && !seat.standIn) times.push(seat.dcAt + LIMITS.standInGraceMs);
    }
    if (s.phase === 'lobby') {
      const host = seatById(s, s.hostSeat);
      if (host && !host.connected && host.dcAt != null) times.push(host.dcAt + 30001);
    }
    const next = Math.min(...times.filter((t) => t != null));
    if (Number.isFinite(next)) this.io.setAlarm(Math.max(next, now + 20));
  }
}

function pendingAsEntries(s, seen) {
  // Bots acting mid-transition can see diary lines that are written but not yet flushed.
  let seq = s.ledger.seq;
  return s.pendingLedger.map((e) => ({ ...e, seq: ++seq })).filter((e) => e.seq > seen);
}
