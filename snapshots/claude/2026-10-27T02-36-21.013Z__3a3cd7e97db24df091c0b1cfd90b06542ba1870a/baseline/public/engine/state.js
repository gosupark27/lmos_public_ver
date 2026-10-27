// Room state: creation and small helpers.
// Layout rule: anything that must never reach another phone lives under state.secret.
// Private-but-not-secret knowledge (what one seat learned) lives under state.private[seat].

import {
  BUILD, PACES, TIERS, LIMITS, PRESENCE_START, HEALTH_MAX, ELO, ARCHETYPE_ORDER,
  tierById, imposterCap, heatBand, weightClass, weightOf, HEAT_RISE_CAP,
} from './constants.js';
import { CHARACTERS, CROSSINGS, scenarioForRound } from './content.js';
import { makeRng } from './rng.js';
import { GENESIS_HASH } from './sha256.js';

export const DEFAULT_CONFIG = {
  tier: 2,
  seats: 6,
  fillBots: true,
  pace: 'standard',
  tableTalk: true,
  flashlight: { on: true, radius: 140 },
};

export function normalizeConfig(input = {}, { allowDev = false } = {}) {
  const c = { ...DEFAULT_CONFIG, ...(input || {}) };
  const tier = Number.isInteger(c.tier) && c.tier >= 1 && c.tier <= 5 ? c.tier : DEFAULT_CONFIG.tier;
  const seats = Number.isInteger(c.seats) ? Math.min(LIMITS.maxSeats, Math.max(LIMITS.minSeats, c.seats)) : DEFAULT_CONFIG.seats;
  let pace = typeof c.pace === 'string' && PACES[c.pace] ? c.pace : DEFAULT_CONFIG.pace;
  if (PACES[pace].dev && !allowDev) pace = DEFAULT_CONFIG.pace;
  const fl = c.flashlight && typeof c.flashlight === 'object' ? c.flashlight : DEFAULT_CONFIG.flashlight;
  const radius = Number.isFinite(fl.radius) ? Math.min(320, Math.max(60, Math.round(fl.radius))) : 140;
  return {
    tier, seats, pace,
    fillBots: c.fillBots !== false,
    tableTalk: c.tableTalk !== false,
    flashlight: { on: fl.on !== false, radius },
  };
}

export function createRoom({ code, now, seed, specHash, config, allowDev = false }) {
  return {
    v: 1,
    code,
    build: BUILD,
    specHash: specHash || 'unknown',
    createdAt: now,
    allowDev: !!allowDev,
    config: normalizeConfig(config, { allowDev }),
    phase: 'lobby',
    phaseSeq: 0,
    phaseStartedAt: now,
    phaseEndsAt: null,
    act: 0,
    round: 0,
    era: null,
    apocalypse: false,
    heat: 0,
    heatRise: 0,
    health: HEALTH_MAX,
    lead: null,
    seats: [],
    crossing: null,
    accusation: null,
    vote: null,
    prodigal: null,
    offers: [],
    chat: [],
    invites: { read: 0, accepted: 0, leftOnRead: 0 },
    outbreaks: 0,
    peace: false,
    result: null,
    epilogue: null,
    fx: [],
    hostSeat: 0,
    hidden: { need: null, cacheFound: {} },
    private: {},
    words: [],          // every word said this game (public record)
    actLog: [],         // per-round public summaries
    ledger: { seq: 0, head: GENESIS_HASH },
    pendingLedger: [],
    timers: { botAt: null },
    nextIds: { offer: 1, word: 1, chat: 1 },
    secret: {
      tokens: {},
      turned: {},
      turnedHistory: [],
      elo: {},
      eloLog: [],
      claimTruth: {},
      sacrifices: [],
      outbreak: { threshold: null, count: 0, cap: 1, lastRound: -10 },
      rng: (seed >>> 0) || 1,
      botRng: ((seed * 2654435761) >>> 0) || 7,
      passportKeyId: null,
    },
  };
}

export const rng = (state) => makeRng(state.secret, 'rng');
export const botRng = (state) => makeRng(state.secret, 'botRng');

export function tierOf(state) {
  return tierById(state.config.tier);
}

export function paceOf(state) {
  return PACES[state.config.pace] || PACES.standard;
}

export function seatById(state, id) {
  return state.seats.find((s) => s.id === id) || null;
}

export function priv(state, id) {
  if (!state.private[id]) state.private[id] = { notes: [], action: null, vote: null, look: null, desync: null, prodigalText: null };
  return state.private[id];
}

export function note(state, id, text, data) {
  const p = priv(state, id);
  p.notes.push({ round: state.round, text, data: data || null });
  if (p.notes.length > LIMITS.notesKeep) p.notes.splice(0, p.notes.length - LIMITS.notesKeep);
}

export function newSeat(state, { human, bot }) {
  const id = state.seats.length;
  const seat = {
    id,
    human: !!human,
    bot: !!bot,
    standIn: false,
    connected: false,
    dcAt: null,
    character: null,
    archetype: null,
    res: { rations: 0, water: 0, timber: 0 },
    presence: PRESENCE_START,
    assets: { crowns: 0, crowd: 0, leverage: {}, conviction: false, witnessAct: null },
    sacrificed: null,
    silence: { holding: false, sinceRound: null, act: null, broken: false },
    outsideRound: null,
    hungry: false,
    caught: false,
    prodigal: null,
    redeemed: false,
    founding: null,
    ready: false,
    acted: false,
    voted: false,
    vouchedBy: [],
    marks: 0,
    tradedRound: null,
    receivedRound: null,
    lastPublic: null,
    actionAt: null,
    stats: {
      giftsUnits: 0, giftsCount: 0, contributedUnits: 0, contributedActs: {},
      correctYes: 0, wrongYes: 0, vouchedCaught: 0,
      wordsKept: 0, wordsBroken: 0, claimsTrue: 0, claimsFalse: 0,
      silenceActs: 0, hungerDays: 0, spoiled: 0, stoked: 0, foraged: 0,
    },
  };
  state.seats.push(seat);
  state.secret.elo[id] = ELO.start;
  priv(state, id);
  return seat;
}

export function isTurned(state, id) {
  return !!state.secret.turned[id];
}

export function activeTurnedCount(state) {
  return Object.keys(state.secret.turned).length;
}

export function isOutside(state, seat) {
  return seat.outsideRound != null && seat.outsideRound === state.round;
}

export function seatName(state, id) {
  const s = seatById(state, id);
  if (!s || !s.character) return `Seat ${id + 1}`;
  const c = CHARACTERS.find((x) => x.id === s.character);
  return c ? `the ${c.name}` : `Seat ${id + 1}`;
}

export function SeatName(state, id) {
  const n = seatName(state, id);
  return n.charAt(0).toUpperCase() + n.slice(1);
}

export function band(state) {
  return heatBand(state.heat);
}

export function scenario(state) {
  return scenarioForRound(state.round);
}

export function crossingDef(act) {
  return CROSSINGS.find((c) => c.act === act) || null;
}

export function avgPresence(state) {
  if (!state.seats.length) return 0;
  return state.seats.reduce((s, x) => s + x.presence, 0) / state.seats.length;
}

export function heavyCount(state) {
  return state.seats.filter((s) => weightClass(s.res) === 'heavy').length;
}

// Heat: a simmer. Gross additions per round are capped (never flash-fire).
export function addHeat(state, delta) {
  if (delta > 0) {
    const room = Math.max(0, HEAT_RISE_CAP - state.heatRise);
    const applied = Math.min(delta, room);
    state.heatRise += applied;
    state.heat = Math.min(100, state.heat + applied);
    return applied;
  }
  const before = state.heat;
  state.heat = Math.max(0, state.heat + delta);
  return state.heat - before;
}

// Presence: a state, never a target. Only a seat's own deeds and condition move it.
export function shiftPresence(state, seat, delta, reason) {
  const before = seat.presence;
  seat.presence = Math.max(0, Math.min(100, seat.presence + delta));
  // The reason can name a secret deed (spoil), so the log is server-only.
  const log = (state.secret.presenceLog ||= []);
  log.push({ seat: seat.id, delta: seat.presence - before, reason, round: state.round });
  if (log.length > 300) log.splice(0, 150);
}

export function changeElo(state, seatId, delta, reason, data) {
  const s = state.secret;
  s.elo[seatId] = Math.round((s.elo[seatId] ?? ELO.start) + delta);
  s.eloLog.push({ seat: seatId, round: state.round, delta: Math.round(delta), reason, data: data || null });
}

export function totalRes(res) {
  return weightOf(res);
}

export function computeNeed(state, act) {
  const def = crossingDef(act);
  if (!def) return null;
  const n = state.seats.length;
  const tier = tierOf(state);
  const need = {};
  for (const [r, mult] of Object.entries(def.needs)) {
    let v = Math.ceil(mult * n) + tier.needAdj;
    if (state.era === 'rome') v += 1;
    if (state.era === '1775') v -= 1;
    if (state.apocalypse) v += 1;
    need[r] = Math.max(1, v);
  }
  return need;
}

// The water level: what the crossing really needs right now.
export function effectiveNeed(state) {
  const base = state.hidden.need;
  if (!base) return null;
  const relief = Math.floor(avgPresence(state) / 25) + (state.crossing && state.crossing.jericho ? state.crossing.jericho : 0);
  const shift = Math.floor(heavyCount(state) / 2) - relief;
  const need = {};
  for (const [r, v] of Object.entries(base)) need[r] = Math.max(1, v + shift);
  return need;
}

export function shortfall(state) {
  const need = effectiveNeed(state);
  if (!need || !state.crossing) return 0;
  let s = 0;
  for (const [r, v] of Object.entries(need)) s += Math.max(0, v - (state.crossing.pool[r] || 0));
  return s;
}

export function shortfallByRes(state) {
  const need = effectiveNeed(state);
  if (!need || !state.crossing) return {};
  const out = {};
  for (const [r, v] of Object.entries(need)) out[r] = Math.max(0, v - (state.crossing.pool[r] || 0));
  return out;
}

const RES_GAUGE = ['Ready', 'Close', 'Short', 'Far short'];
export function resGauge(short) {
  const level = short <= 0 ? 0 : short <= 1 ? 1 : short <= 3 ? 2 : 3;
  return { level, text: RES_GAUGE[level] };
}

export function gaugeFor(short) {
  if (short <= 0) return { level: 0, text: 'Ready to cross' };
  if (short <= 2) return { level: 1, text: 'Close' };
  if (short <= 5) return { level: 2, text: 'Short' };
  return { level: 3, text: 'Far short' };
}

export function sunrisePalette(state) {
  if (state.apocalypse) return 'pink';
  if (state.act <= 1) return 'yellow';
  if (state.act === 2) return 'red';
  return 'blue';
}

export function archetypeSeats(state, archetype) {
  return state.seats.filter((s) => s.archetype === archetype);
}

export function dealCharacters(state) {
  // Balanced: archetypes go round-robin so every table of 4+ has all four.
  const r = rng(state);
  const pools = {};
  for (const a of ARCHETYPE_ORDER) pools[a] = r.shuffle(CHARACTERS.filter((c) => c.archetype === a));
  const order = r.shuffle(state.seats.map((s) => s.id));
  order.forEach((seatId, i) => {
    const a = ARCHETYPE_ORDER[i % 4];
    const ch = pools[a].shift();
    const seat = seatById(state, seatId);
    seat.character = ch.id;
    seat.archetype = a;
    seat.res = { ...ch.start };
    if (a === 'kingmaker') seat.assets.crowns = 1;
    if (a === 'populist') seat.assets.crowd = 3;
    if (a === 'idealist') seat.assets.conviction = true;
  });
}

export function setupSecrets(state) {
  const tier = tierOf(state);
  const r = rng(state);
  state.secret.outbreak = {
    threshold: tier.outbreakAt + (r.int(9) - 4),
    count: 0,
    cap: imposterCap(state.seats.length, tier),
    lastRound: -10,
  };
}

export function heatBandOf(state) {
  return heatBand(state.heat);
}

export { weightClass, weightOf, TIERS, HEALTH_MAX };
