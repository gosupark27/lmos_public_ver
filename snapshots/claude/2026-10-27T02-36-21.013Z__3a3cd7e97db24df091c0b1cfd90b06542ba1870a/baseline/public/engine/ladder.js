// End of the road: outcome, the rating ladder, builder marks, and the epilogue
// where the game admits it saw everything. Secrets are released here and only here.

import {
  LADDER, RATING_START, SOFT_FLOOR, MASTER_ELO, HEALTH_MAX, ELO, spectrumLabel,
} from './constants.js';
import { CHARACTERS, RUBRIC, WORDS, FOUNDING } from './content.js';
import { seatById, isTurned, seatName, SeatName, changeElo } from './state.js';
import { say } from './narrator.js';

export const SACRIFICE_REASONS = {
  announced: 'it was announced first, and the road does not take a performance',
  traded: 'something changed hands that same day',
  no_pressure: 'nothing was at stake yet',
  not_independent: 'someone else made an offering the same day',
  turned: 'it came from a turned seat',
  too_early: 'the road had barely begun',
};

export function tierFor(rating, elo, perfect) {
  if (elo < MASTER_ELO) return LADDER.find((l) => l.bottom);
  for (const l of LADDER) {
    if (l.bottom) continue;
    if (l.sealed && !perfect) continue;
    if (rating >= l.min) return l;
  }
  return LADDER.find((l) => l.floor);
}

function everTurned(state, id) {
  return state.secret.turnedHistory.some((t) => t.seat === id);
}

export function computeRating(state, seat, kind) {
  const elo = state.secret.elo[seat.id] ?? ELO.start;
  let r = RATING_START + (elo - ELO.start) / 500;
  const sac = state.secret.sacrifices.find((s) => s.seat === seat.id);
  if (sac) r += sac.valid ? 0.33 : 0.1;
  r += Math.min(0.25, 0.05 * seat.stats.giftsUnits);
  r += Math.min(0.15, 0.02 * seat.stats.contributedUnits);
  r += Math.min(0.3, 0.15 * seat.stats.correctYes);
  r -= 0.05 * seat.stats.wrongYes;
  r -= 0.1 * seat.stats.vouchedCaught;
  if (seat.redeemed) r += 0.2;
  if (seat.caught && seat.prodigal === 'silent') r -= 0.33;
  r += (seat.presence - 50) / 250;
  const uncaught = isTurned(state, seat.id) && !seat.caught;
  if (kind === 'peace') r += 0.25;
  else if (kind === 'arrived') r += uncaught ? -0.1 : 0.05;
  else if (kind === 'lost') r += uncaught ? 0.1 : -0.1;
  r = Math.round(r * 100) / 100;
  const perfect = kind === 'peace' && !!sac && sac.valid && seat.stats.wordsBroken === 0
    && seat.stats.claimsFalse === 0 && !everTurned(state, seat.id) && !(seat.founding && seat.founding.broken);
  if (elo >= MASTER_ELO) r = Math.max(r, SOFT_FLOOR);
  if (!perfect && r >= LADDER[0].min) r = Math.min(r, LADDER[0].min - 0.01);
  const tier = tierFor(r, elo, perfect);
  return { rating: r, tier: tier.id, label: tier.label, hue: tier.hue, perfect };
}

export function marksFor(state, seat, kind) {
  const m = [];
  const spoke = state.words.some((w) => w.seat === seat.id);
  const failedCrossing = state.health < HEALTH_MAX;
  if (spoke && seat.stats.wordsBroken === 0 && seat.stats.claimsFalse === 0 && !(seat.founding && seat.founding.broken)) m.push('word');
  if (seat.stats.giftsCount > 0) m.push('given');
  if (kind !== 'lost' && !failedCrossing) m.push('crossed');
  if (seat.id === state.hostSeat && seat.human) m.push('host');
  const sac = state.secret.sacrifices.find((s) => s.seat === seat.id);
  if (sac && sac.valid) m.push('taken');
  if (seat.stats.silenceActs > 0) m.push('waits');
  if (seat.redeemed) m.push('home');
  if (seat.stats.correctYes > 0) m.push('named');
  return m;
}

function wordText(state, w) {
  const name = (id) => seatName(state, id);
  if (w.founding) return FOUNDING[w.kind] ? FOUNDING[w.kind].say : w.kind;
  const def = WORDS[w.kind];
  return def ? def.say(w, name) : w.kind;
}

function deedText(state, d) {
  if (!d) return 'did nothing';
  switch (d.kind) {
    case 'contribute': return `put ${d.n} ${d.res} into the cache`;
    case 'give': return `gave ${d.n} ${d.res} to ${seatName(state, d.target)}`;
    case 'spoil': return 'took from the cache';
    case 'stoke': return 'fed the fire';
    case 'still': return 'stayed still';
    case 'accuse': return `called ${seatName(state, d.target)} to account`;
    case 'forage': return `went foraging for ${d.res}`;
    case 'drift': return 'did nothing at all';
    case 'look': return 'went looking where no one was watching';
    default: return d.kind.replace(/_/g, ' ');
  }
}

function matrixLines(state, seat, they = false) {
  const P = they
    ? { you: 'they', You: 'They', said: 'they said', did: 'they did', your: 'their' }
    : { you: 'you', You: 'You', said: 'you said', did: 'you did', your: 'your' };
  const lines = [];
  const deeds = (state.secret.deeds || []).filter((d) => d.seat === seat.id);
  const byWord = new Map(state.words.map((w) => [w.id, w]));
  for (const e of state.secret.eloLog.filter((x) => x.seat === seat.id)) {
    if (lines.length >= 3) break;
    if (e.reason === 'broken' && e.data) {
      const w = byWord.get(e.data.word);
      if (!w) continue;
      const deed = deeds.find((d) => d.round === w.round);
      lines.push(`Day ${w.round}, ${P.said} \u201c${wordText(state, w)}\u201d ${P.You} ${w.kind === 'vote' ? 'voted the other way' : deedText(state, deed)}.`);
    } else if (e.reason === 'claim_false' && e.data) {
      const w = byWord.get(e.data.word);
      if (w) lines.push(`Day ${w.round}, ${P.said} \u201c${wordText(state, w)}\u201d It wasn\u2019t true.`);
    } else if (e.reason === 'silence_broken') {
      lines.push(`Day ${e.round}, ${P.you} broke ${P.your} silence.`);
    }
  }
  if (!lines.length) {
    const spoke = state.words.filter((w) => w.seat === seat.id).length;
    lines.push(spoke ? `Every word ${P.said}, ${P.did}.` : `${P.You} said almost nothing. The road heard that too.`);
  }
  return lines;
}

export function buildEpilogue(state, kind) {
  return state.seats.map((seat) => {
    const ch = CHARACTERS.find((c) => c.id === seat.character);
    const elo = state.secret.elo[seat.id] ?? ELO.start;
    const sac = state.secret.sacrifices.find((s) => s.seat === seat.id) || null;
    const rating = computeRating(state, seat, kind);
    return {
      id: seat.id,
      human: seat.human,
      bot: seat.bot,
      character: seat.character,
      name: ch ? ch.name : `Seat ${seat.id + 1}`,
      archetype: seat.archetype,
      turned: state.secret.turnedHistory.filter((t) => t.seat === seat.id).map((t) => t.round),
      stillTurned: isTurned(state, seat.id),
      caught: seat.caught,
      prodigal: seat.prodigal,
      redeemed: seat.redeemed,
      elo,
      spectrum: spectrumLabel(elo),
      ...rating,
      sacrifice: sac ? { round: sac.round, valid: sac.valid, why: sac.reasons.map((r) => SACRIFICE_REASONS[r] || r) } : null,
      founding: seat.founding ? { kind: seat.founding.kind, text: FOUNDING[seat.founding.kind].say, kept: !seat.founding.broken } : null,
      words: { kept: seat.stats.wordsKept, broken: seat.stats.wordsBroken, claimsTrue: seat.stats.claimsTrue, claimsFalse: seat.stats.claimsFalse },
      marks: marksFor(state, seat, kind),
      matrix: { you: matrixLines(state, seat, false), they: matrixLines(state, seat, true) },
    };
  });
}

export function outcomeFor(state, kind) {
  const winners = [];
  for (const s of state.seats) {
    const uncaught = isTurned(state, s.id) && !s.caught;
    const unreconciled = s.caught && s.prodigal === 'silent';
    if (kind === 'peace') winners.push(s.id);
    else if (kind === 'arrived' && !uncaught && !unreconciled) winners.push(s.id);
    else if (kind === 'lost' && uncaught) winners.push(s.id);
  }
  const titles = {
    peace: ['Peace', 'Four offerings the road accepted. Everyone reached the sea, even anyone who had turned.'],
    arrived: ['The sea', 'The train reached the Pacific. From sea to shining sea.'],
    lost: ['The trail took them', 'Too many wagons went into the rivers.'],
  };
  return { kind, title: titles[kind][0], line: titles[kind][1], winners };
}

export function finishGame(state, kind, now, enterPhase) {
  // The final act's silence counts too.
  const firstRound = (state.act - 1) * 3 + 1;
  for (const s of state.seats) {
    if (s.silence.holding && s.silence.act === state.act && s.silence.sinceRound === firstRound) s.stats.silenceActs += 1;
    if (s.founding && !s.founding.broken && !s.founding.kept) {
      s.founding.kept = true;
      changeElo(state, s.id, ELO.foundingKept, 'founding_kept', { kind: s.founding.kind });
    }
  }
  if (kind === 'arrived') say.arrived(state);
  if (kind === 'lost') say.lost(state);
  state.result = outcomeFor(state, kind);
  state.epilogue = buildEpilogue(state, kind);
  state.fx.push({ kind: 'matrix' });
  enterPhase(state, 'end', now);
}

export { RUBRIC, SeatName, seatById };
