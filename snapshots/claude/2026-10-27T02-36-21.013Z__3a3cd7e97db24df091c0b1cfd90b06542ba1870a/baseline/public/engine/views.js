// The only place payloads for phones are built.
// Poll payload splits: public snapshot + private delta per player.
// Nothing under state.secret is read here, except one seat's own "have I turned?"
// in that seat's own private delta. Everything else is an explicit whitelist.

import { HEALTH_MAX, presenceLevel, weightClass, weightOf, heatBand, PACES } from './constants.js';
import { scenarioForRound, CROSSINGS } from './content.js';
import { seatById, priv, isOutside, effectiveNeed, shortfall, shortfallByRes, resGauge, gaugeFor, sunrisePalette, tierOf } from './state.js';
import { legalFor } from './legal.js';

const ENDED = new Set(['end']);

function publicSeat(state, s) {
  return {
    id: s.id,
    human: s.human,
    bot: s.bot,
    standIn: s.standIn,
    connected: s.connected,
    character: s.character,
    archetype: s.archetype,
    presence: presenceLevel(s.presence),
    weight: weightClass(s.res),
    crowns: s.assets.crowns,
    crowd: s.assets.crowd,
    letters: Object.values(s.assets.leverage).reduce((a, b) => a + b, 0),
    conviction: !!s.assets.conviction,
    sacrificed: !!s.sacrificed,
    silence: !!s.silence.holding,
    outside: isOutside(state, s),
    outsideNext: s.outsideRound != null && s.outsideRound === state.round + 1,
    hungry: s.hungry,
    caught: s.caught,
    prodigal: s.prodigal,
    redeemed: s.redeemed,
    founding: s.founding ? { kind: s.founding.kind } : null,
    ready: s.ready,
    acted: s.acted,
    voted: s.voted,
    vouchedBy: s.vouchedBy.slice(),
    marks: s.marks,
    last: s.lastPublic,
  };
}

export function publicSnapshot(state) {
  const sc = scenarioForRound(state.round);
  const b = heatBand(state.heat);
  const short = state.crossing ? shortfall(state) : 0;
  const ended = ENDED.has(state.phase);
  const pace = PACES[state.config.pace];
  const snap = {
    code: state.code,
    build: state.build,
    phase: state.phase,
    ps: state.phaseSeq,
    startedAt: state.phaseStartedAt,
    endsAt: state.phaseEndsAt,
    revealOf: state.revealOf || null,
    act: state.act,
    round: state.round,
    scenario: sc ? { id: sc.id, book: sc.book, title: sc.title, line: sc.line, rule: sc.rule, triad: sc.triad } : null,
    era: state.era,
    apocalypse: state.apocalypse,
    sunrise: sunrisePalette(state),
    weather: { band: b.id, name: b.name, gauge: Math.round(state.heat / 5) * 5 },
    rules: { forage: b.forage, accuseNeeds: b.accuseNeeds, tradeTax: b.tradeTax, boundary: b.boundary },
    health: state.health,
    healthMax: HEALTH_MAX,
    crossing: state.crossing ? {
      name: state.crossing.name,
      line: state.crossing.line,
      pool: { ...state.crossing.pool },
      gauge: gaugeFor(short),
      gauges: Object.fromEntries(Object.entries(shortfallByRes(state)).map(([r, v]) => [r, resGauge(v)])),
      result: state.crossing.result,
    } : null,
    lead: state.lead,
    seats: state.seats.map((s) => publicSeat(state, s)),
    words: state.words.filter((w) => w.round === state.round || w.founding).map((w) => ({
      id: w.id, seat: w.seat, round: w.round, kind: w.kind, target: w.target ?? null, res: w.res ?? null,
      n: w.n ?? null, yes: w.yes ?? null, founding: !!w.founding,
    })),
    accusation: state.vote ? { accused: state.vote.accused, accusers: state.vote.accusers.slice() } : null,
    vote: state.vote ? {
      accused: state.vote.accused,
      cast: Object.keys(state.vote.votes).length,
      builders: state.vote.builders.slice(),
      result: state.vote.result,
    } : null,
    prodigal: state.prodigal ? { seat: state.prodigal.seat, choice: state.prodigal.choice } : null,
    chat: state.config.tableTalk ? state.chat.slice(-40) : [],
    invites: { ...state.invites },
    host: state.hostSeat,
    config: { ...state.config, flashlight: { ...state.config.flashlight } },
    tier: (() => { const t = tierOf(state); return { id: t.id, dupr: t.dupr, name: t.name }; })(),
    pace: { id: state.config.pace, label: pace ? pace.label : '' },
    outbreaks: state.outbreaks,
    peace: state.peace,
    ledger: { seq: state.ledger.seq, head: state.ledger.head },
    result: ended ? state.result : null,
    epilogue: ended ? state.epilogue : null,
  };
  return snap;
}

export function privateDelta(state, seatId) {
  const s = seatById(state, seatId);
  if (!s) return null;
  const p = priv(state, seatId);
  const offersIn = state.offers.filter((o) => o.to === seatId && o.status === 'open');
  const offersOut = state.offers.filter((o) => o.from === seatId && o.status === 'open');
  return {
    seat: seatId,
    host: seatId === state.hostSeat,
    res: { ...s.res },
    weight: weightOf(s.res),
    presence: s.presence,
    assets: {
      crowns: s.assets.crowns,
      crowd: s.assets.crowd,
      leverage: { ...s.assets.leverage },
      conviction: !!s.assets.conviction,
      witnessUsed: s.assets.witnessAct === state.act,
    },
    sacrificed: s.sacrificed ? { round: s.sacrificed.round } : null,
    silence: { ...s.silence },
    founding: s.founding ? { kind: s.founding.kind } : null,
    action: p.action ? { ...p.action } : null,
    vote: p.vote ? { ...p.vote } : null,
    legal: legalFor(state, seatId),
    offersIn: offersIn.map((o) => ({ ...o })),
    offersOut: offersOut.map((o) => ({ ...o })),
    notes: p.notes.slice(-12),
    look: p.look,
    desync: !!(p.desync && p.desync.round === state.round),
    // A seat's own secret, to that seat only. Nobody else's.
    turned: !!state.secret.turned[seatId],
    passport: state.phase === 'end' ? p.passport || null : null,
  };
}

// For tests and the leak scanner: the full message a seat receives.
export function viewFor(state, seatId) {
  return { pub: publicSnapshot(state), priv: seatId == null ? null : privateDelta(state, seatId) };
}

export { effectiveNeed, CROSSINGS };
