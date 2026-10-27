// Intents. Clients send intents, never state. Each handler validates against the
// current phase and legal moves, then changes state or refuses with a reason.

import { RES, LIMITS, LIVE_PHASES, ELO } from './constants.js';
import { FOUNDING, WORDS } from './content.js';
import {
  seatById, priv, isTurned, isOutside, band, scenario, shortfall, changeElo, shiftPresence,
  newSeat, normalizeConfig, seatName,
} from './state.js';
import { legalWords, legalVote, validateAction, wordsThisRound } from './legal.js';
import { startGame, resolveProdigal } from './rules.js';
import { say } from './narrator.js';

const fail = (err) => ({ ok: false, err });
const ok = (result) => ({ ok: true, result: result ?? null });
const isInt = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;

export function sanitizeText(text, max) {
  if (typeof text !== 'string') return '';
  return text
    .replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function breakSilence(state, seat) {
  if (!seat.silence.holding) return false;
  const sc = scenario(state);
  const mult = (sc && sc.mods && sc.mods.silenceBreakMult) || 1;
  seat.silence.holding = false;
  seat.silence.broken = true;
  changeElo(state, seat.id, ELO.silenceBroken * mult, 'silence_broken');
  shiftPresence(state, seat, -10, 'silence_broken');
  say.brokeSilence(state, seat.id);
  return true;
}

function cleanBag(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const out = {};
  for (const r of RES) {
    if (obj[r] == null) continue;
    if (!isInt(obj[r], 1, 12)) return null;
    out[r] = obj[r];
  }
  return Object.keys(out).length ? out : null;
}

function has(seat, bag, extra = {}) {
  return RES.every((r) => (seat.res[r] || 0) >= (bag[r] || 0) + (extra[r] || 0));
}

export function handleIntent(state, seatId, msg, now) {
  const seat = seatById(state, seatId);
  if (!seat) return fail('no_seat');
  if (!msg || typeof msg.k !== 'string') return fail('bad_intent');
  if (state.phase === 'frozen' || state.phase === 'end') {
    if (msg.k !== 'talk') return fail('table_frozen');
  }
  switch (msg.k) {
    case 'config': return config(state, seat, msg);
    case 'start': return start(state, seat, now);
    case 'ready': return ready(state, seat);
    case 'word': return word(state, seat, msg);
    case 'founding': return founding(state, seat, msg);
    case 'talk': return talk(state, seat, msg, now);
    case 'silence': return silence(state, seat);
    case 'offer': return offer(state, seat, msg, now);
    case 'accept': return accept(state, seat, msg);
    case 'decline': return closeOffer(state, seat, msg, 'to', 'declined');
    case 'cancel': return closeOffer(state, seat, msg, 'from', 'cancelled');
    case 'act': return act(state, seat, msg, now);
    case 'vote': return vote(state, seat, msg);
    case 'prodigal': return prodigal(state, seat, msg);
    default: return fail('unknown_intent');
  }
}

function config(state, seat, msg) {
  if (state.phase !== 'lobby') return fail('started');
  if (seat.id !== state.hostSeat) return fail('host_only');
  state.config = normalizeConfig({ ...state.config, ...(msg.config || {}) }, { allowDev: state.allowDev });
  return ok();
}

function start(state, seat, now) {
  if (state.phase !== 'lobby') return fail('started');
  if (seat.id !== state.hostSeat) return fail('host_only');
  if (state.config.fillBots) {
    while (state.seats.length < Math.min(LIMITS.maxSeats, state.config.seats)) newSeat(state, { bot: true });
  }
  if (state.seats.length < LIMITS.minSeats) return fail('need_four');
  startGame(state, now);
  return ok();
}

function ready(state, seat) {
  if (state.phase !== 'talk' && state.phase !== 'reveal') return fail('phase');
  seat.ready = true;
  return ok();
}

function word(state, seat, msg) {
  if (state.phase !== 'talk') return fail('phase');
  const legal = legalWords(state, seat.id);
  if (legal.left <= 0) return fail('no_words_left');
  const K = legal.kinds.find((x) => x.kind === msg.kind);
  if (!K) return fail('not_legal');
  const w = { id: state.nextIds.word++, seat: seat.id, round: state.round, act: state.act, kind: msg.kind };
  switch (msg.kind) {
    case 'contribute':
      if (!K.res.includes(msg.res) || !isInt(msg.n, 1, 12)) return fail('bad_word');
      w.res = msg.res; w.n = msg.n; break;
    case 'give':
      if (!K.targets.includes(msg.target) || !RES.includes(msg.res) || !isInt(msg.n, 1, 12)) return fail('bad_word');
      w.target = msg.target; w.res = msg.res; w.n = msg.n; break;
    case 'accuse':
      if (!K.targets.includes(msg.target)) return fail('bad_word');
      w.target = msg.target; break;
    case 'vote':
      if (!K.targets.includes(msg.target) || typeof msg.yes !== 'boolean') return fail('bad_word');
      w.target = msg.target; w.yes = msg.yes; break;
    case 'holding':
      if (!RES.includes(msg.res) || !isInt(msg.n, 0, 40)) return fail('bad_word');
      w.res = msg.res; w.n = msg.n; break;
    case 'need':
      if (!isInt(msg.n, 0, 60)) return fail('bad_word');
      w.n = msg.n; break;
    default: break;
  }
  breakSilence(state, seat);
  if (WORDS[w.kind].family === 'claim') {
    // The truth of a claim is fixed the moment it is said, and kept server-side.
    let truth = false;
    switch (w.kind) {
      case 'clean': truth = !isTurned(state, seat.id); break;
      case 'gave_last': truth = !!((state.secret.lastAction || {})[seat.id] && state.secret.lastAction[seat.id].kind === 'contribute'); break;
      case 'holding': truth = seat.res[w.res] === w.n; break;
      case 'need': truth = Math.abs(shortfall(state) - w.n) <= 1; break;
      default: truth = true;
    }
    state.secret.claimTruth[w.id] = truth;
  }
  state.words.push(w);
  say.word(state, w, WORDS[w.kind].say(w, (id) => seatName(state, id)));
  return ok({ word: w.id });
}

function founding(state, seat, msg) {
  if (state.phase !== 'talk') return fail('phase');
  const sc = scenario(state);
  if (!sc || !sc.mods || !sc.mods.founding) return fail('not_founding_day');
  if (seat.founding) return fail('already_founded');
  if (!FOUNDING[msg.kind]) return fail('bad_word');
  breakSilence(state, seat);
  seat.founding = { kind: msg.kind, broken: false, round: state.round };
  const w = { id: state.nextIds.word++, seat: seat.id, round: state.round, act: state.act, kind: msg.kind, founding: true };
  state.words.push(w);
  say.word(state, w, FOUNDING[msg.kind].say);
  return ok({ word: w.id });
}

function talk(state, seat, msg, now) {
  if (!state.config.tableTalk) return fail('talk_off');
  const text = sanitizeText(msg.text, LIMITS.talkMax);
  if (!text) return fail('empty');
  const p = priv(state, seat.id);
  if (p.lastChatAt && now - p.lastChatAt < LIMITS.chatGapMs) return fail('slow_down');
  p.lastChatAt = now;
  if (LIVE_PHASES.has(state.phase) || state.phase === 'reveal') breakSilence(state, seat);
  state.chat.push({ id: state.nextIds.chat++, seat: seat.id, text, at: now, round: state.round });
  if (state.chat.length > LIMITS.chatKeep) state.chat.splice(0, state.chat.length - LIMITS.chatKeep);
  return ok();
}

function silence(state, seat) {
  if (state.phase !== 'talk') return fail('phase');
  if (seat.silence.holding) return fail('already_silent');
  seat.silence = { holding: true, sinceRound: state.round, act: state.act, broken: false };
  say.silence(state, seat.id);
  return ok();
}

function offer(state, seat, msg, now) {
  if (state.phase !== 'talk') return fail('phase');
  if (isOutside(state, seat)) return fail('outside');
  const to = seatById(state, msg.to);
  if (!to || to.id === seat.id || isOutside(state, to)) return fail('bad_target');
  const give = cleanBag(msg.give);
  const get = cleanBag(msg.get);
  if (!give || !get) return fail('bad_trade');
  const tax = band(state).tradeTax ? { water: band(state).tradeTax } : {};
  if (!has(seat, give, tax)) return fail('not_enough');
  const open = state.offers.filter((o) => o.from === seat.id && o.status === 'open').length;
  if (open >= LIMITS.openOffers) return fail('too_many_offers');
  breakSilence(state, seat);
  const o = { id: state.nextIds.offer++, from: seat.id, to: to.id, give, get, round: state.round, status: 'open', at: now };
  state.offers.push(o);
  return ok({ offer: o.id });
}

function accept(state, seat, msg) {
  if (state.phase !== 'talk') return fail('phase');
  const o = state.offers.find((x) => x.id === msg.offer);
  if (!o || o.to !== seat.id || o.status !== 'open') return fail('no_offer');
  const from = seatById(state, o.from);
  if (isOutside(state, seat) || isOutside(state, from)) return fail('outside');
  const taxN = band(state).tradeTax;
  const tax = taxN ? { water: taxN } : {};
  if (!has(from, o.give, tax)) { o.status = 'failed'; return fail('they_cannot_pay'); }
  if (!has(seat, o.get)) return fail('not_enough');
  breakSilence(state, seat);
  for (const r of RES) {
    from.res[r] -= o.give[r] || 0; seat.res[r] += o.give[r] || 0;
    seat.res[r] -= o.get[r] || 0; from.res[r] += o.get[r] || 0;
  }
  if (taxN) from.res.water -= taxN;
  o.status = 'done';
  from.tradedRound = state.round;
  seat.tradedRound = state.round;
  say.trade(state, o);
  return ok();
}

function closeOffer(state, seat, msg, side, status) {
  const o = state.offers.find((x) => x.id === msg.offer);
  if (!o || o[side] !== seat.id || o.status !== 'open') return fail('no_offer');
  o.status = status;
  return ok();
}

function sanitizeAction(a) {
  if (!a || typeof a !== 'object' || typeof a.kind !== 'string') return null;
  const out = { kind: a.kind };
  if (a.target != null) out.target = a.target;
  if (a.res != null) out.res = a.res;
  if (a.n != null) out.n = a.n;
  return out;
}

function act(state, seat, msg, now) {
  if (state.phase !== 'act') return fail('phase');
  const a = sanitizeAction(msg.a);
  const err = validateAction(state, seat.id, a);
  if (err) return fail(err);
  priv(state, seat.id).action = a;
  seat.acted = true;
  seat.actionAt = now;
  return ok();
}

function vote(state, seat, msg) {
  if (state.phase !== 'vote') return fail('phase');
  const L = legalVote(state, seat.id);
  if (!L || !L.canVote) return fail('not_eligible');
  if (typeof msg.yes !== 'boolean') return fail('bad_vote');
  const ballot = { yes: msg.yes, stake: !!msg.stake && L.canStake };
  state.vote.votes[seat.id] = ballot;
  priv(state, seat.id).vote = ballot;
  seat.voted = true;
  return ok();
}

function prodigal(state, seat, msg) {
  if (state.phase !== 'prodigal' || !state.prodigal) return fail('phase');
  if (state.prodigal.seat !== seat.id) return fail('not_your_seat');
  if (msg.choice !== 'confess' && msg.choice !== 'silent') return fail('bad_choice');
  const text = sanitizeText(msg.text, LIMITS.confessMax) || null;
  resolveProdigal(state, msg.choice, text);
  return ok();
}

export { wordsThisRound };
