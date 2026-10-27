// Legal moves. One function decides what each seat may do right now.
// The server validates against it, bots choose from it, and the phone renders it.
// "Seven levers rewrite legal moves": every lever shows up here as a rule.

import { RES, LIMITS } from './constants.js';
import { FOUNDING } from './content.js';
import {
  seatById, isTurned, isOutside, band, scenario, crossingDef, priv,
} from './state.js';

export function wordsThisRound(state, seatId) {
  return state.words.filter((w) => w.seat === seatId && w.round === state.round && !w.founding);
}

export function canSacrifice(state, seat) {
  if (!seat || seat.sacrificed) return false;
  switch (seat.archetype) {
    case 'kingmaker': return seat.assets.crowns > 0;
    case 'populist': return seat.assets.crowd > 0;
    case 'broker': return true;
    case 'idealist': return !!seat.assets.conviction;
    default: return false;
  }
}

function others(state, seat) {
  return state.seats.filter((s) => s.id !== seat.id);
}

function accusable(state, seat) {
  return others(state, seat)
    .filter((s) => !isOutside(state, s) && !s.caught && !s.redeemed)
    .map((s) => s.id);
}

function crossingRes(state) {
  const def = crossingDef(state.act);
  return def ? Object.keys(def.needs) : ['timber'];
}

export function legalActions(state, seatId) {
  const seat = seatById(state, seatId);
  if (!seat || state.phase !== 'act') return [];
  const b = band(state);
  const sc = scenario(state) || { mods: {} };
  const mods = sc.mods || {};
  const out = [];
  const outside = isOutside(state, seat);
  const turned = isTurned(state, seatId);
  const have = (r) => seat.res[r] || 0;

  const contribRes = crossingRes(state).filter((r) => have(r) > 0);
  if (contribRes.length) out.push({ kind: 'contribute', res: contribRes, max: Object.fromEntries(contribRes.map((r) => [r, have(r)])) });

  const giveRes = RES.filter((r) => have(r) > 0);
  if (giveRes.length) out.push({ kind: 'give', targets: others(state, seat).map((s) => s.id), res: giveRes, max: Object.fromEntries(giveRes.map((r) => [r, have(r)])) });

  const forageYield = b.forage + (mods.forageBonus || 0) + (state.era === 'rome' && b.forage > 0 ? 1 : 0);
  if (b.forage > 0) out.push({ kind: 'forage', res: RES.slice(), yield: forageYield });

  out.push({ kind: 'still' });
  out.push({ kind: 'look' });

  if (!mods.noAccuse && !outside) {
    const t = accusable(state, seat);
    if (t.length) out.push({ kind: 'accuse', targets: t, needs: mods.singleAccuser ? 1 : b.accuseNeeds });
  }

  out.push({ kind: 'vouch', targets: others(state, seat).map((s) => s.id) });

  // Power: who thinks they lead.
  if (state.lead === seat.id) {
    out.push({ kind: 'hold_lead' });
    if (b.boundary) {
      out.push({ kind: 'boundary', targets: others(state, seat).filter((s) => !isOutside(state, s)).map((s) => s.id) });
    }
  } else if (!mods.noClaimLead) {
    out.push({ kind: 'claim_lead' });
  }

  // Archetype powers.
  if (seat.assets.crowns > 0) out.push({ kind: 'rally' });
  if (seat.assets.crowd > 0) { out.push({ kind: 'stir' }); out.push({ kind: 'calm' }); }
  if (seat.archetype === 'broker' && !seat.sacrificed) {
    out.push({ kind: 'peek', targets: others(state, seat).map((s) => s.id) });
    const debtors = Object.entries(seat.assets.leverage).filter(([, n]) => n > 0).map(([id]) => Number(id));
    if (debtors.length) out.push({ kind: 'callin', targets: debtors, res: RES.slice() });
  }
  if (seat.archetype === 'idealist' && seat.assets.conviction && seat.assets.witnessAct !== state.act) {
    out.push({ kind: 'witness', targets: others(state, seat).map((s) => s.id) });
  }

  if (canSacrifice(state, seat)) {
    const s = { kind: 'sacrifice', archetype: seat.archetype };
    if (seat.archetype === 'kingmaker') s.targets = others(state, seat).map((x) => x.id);
    out.push(s);
  }

  // The turned.
  if (turned && !seat.caught) {
    out.push({ kind: 'spoil', res: crossingRes(state) });
    out.push({ kind: 'stoke' });
    out.push({ kind: 'esther' });
  }
  if (seat.caught && seat.prodigal === 'silent') out.push({ kind: 'return' });

  return out;
}

export function legalWords(state, seatId) {
  const seat = seatById(state, seatId);
  if (!seat || state.phase !== 'talk') return { left: 0, kinds: [], founding: null };
  const sc = scenario(state) || { mods: {} };
  const mods = sc.mods || {};
  const left = Math.max(0, LIMITS.wordsPerRound - wordsThisRound(state, seatId).length);
  const kinds = [];
  const contribRes = crossingRes(state);
  kinds.push({ kind: 'contribute', res: contribRes });
  kinds.push({ kind: 'give', targets: others(state, seat).map((s) => s.id), res: RES.slice() });
  kinds.push({ kind: 'still' });
  if (!mods.noAccuse) {
    kinds.push({ kind: 'no_accuse' });
    kinds.push({ kind: 'accuse', targets: accusable(state, seat) });
    kinds.push({ kind: 'vote', targets: accusable(state, seat) });
  }
  if (canSacrifice(state, seat)) kinds.push({ kind: 'sacrifice' });
  kinds.push({ kind: 'clean' });
  if (state.round > 1) kinds.push({ kind: 'gave_last' });
  kinds.push({ kind: 'holding', res: RES.slice() });
  kinds.push({ kind: 'need' });
  const founding = mods.founding && !seat.founding ? Object.keys(FOUNDING) : null;
  return { left, kinds, founding };
}

export function legalTalk(state, seatId) {
  const seat = seatById(state, seatId);
  if (!seat) return null;
  const outside = isOutside(state, seat);
  const b = band(state);
  return {
    words: legalWords(state, seatId),
    canTalk: state.config.tableTalk,
    canTrade: !outside && state.phase === 'talk',
    tradeTargets: others(state, seat).filter((s) => !isOutside(state, s)).map((s) => s.id),
    tradeTax: b.tradeTax,
    silence: seat.silence.holding,
    canHoldSilence: !seat.silence.holding && state.phase === 'talk',
  };
}

export function voteEligible(state) {
  if (!state.vote) return [];
  const sc = scenario(state) || { mods: {} };
  const builders = sc.mods && sc.mods.buildersCantVote ? new Set(state.vote.builders || []) : new Set();
  return state.seats
    .filter((s) => s.id !== state.vote.accused && !isOutside(state, s) && !builders.has(s.id))
    .map((s) => s.id);
}

export function legalVote(state, seatId) {
  const seat = seatById(state, seatId);
  if (!seat || state.phase !== 'vote' || !state.vote) return null;
  const eligible = voteEligible(state).includes(seatId);
  return {
    accused: state.vote.accused,
    canVote: eligible,
    canStake: eligible && seat.archetype === 'idealist' && !!seat.assets.conviction,
  };
}

export function legalFor(state, seatId) {
  const p = priv(state, seatId);
  switch (state.phase) {
    case 'talk': return { phase: 'talk', ...legalTalk(state, seatId) };
    case 'act': return { phase: 'act', actions: legalActions(state, seatId), chosen: p.action };
    case 'vote': return { phase: 'vote', ...(legalVote(state, seatId) || {}) };
    case 'prodigal': return { phase: 'prodigal', mine: state.prodigal && state.prodigal.seat === seatId };
    default: return { phase: state.phase };
  }
}

export function validateAction(state, seatId, a) {
  if (!a || typeof a !== 'object') return 'bad_action';
  const legal = legalActions(state, seatId);
  const L = legal.find((x) => x.kind === a.kind);
  if (!L) return 'not_legal';
  const seat = seatById(state, seatId);
  const int = (v) => Number.isInteger(v);
  switch (a.kind) {
    case 'contribute':
      if (!L.res.includes(a.res)) return 'bad_res';
      if (!int(a.n) || a.n < 1 || a.n > seat.res[a.res]) return 'bad_amount';
      return null;
    case 'give':
      if (!L.targets.includes(a.target)) return 'bad_target';
      if (!L.res.includes(a.res)) return 'bad_res';
      if (!int(a.n) || a.n < 1 || a.n > seat.res[a.res]) return 'bad_amount';
      return null;
    case 'forage':
      if (!RES.includes(a.res)) return 'bad_res';
      return null;
    case 'accuse': case 'vouch': case 'boundary': case 'peek': case 'witness':
      if (!L.targets.includes(a.target)) return 'bad_target';
      return null;
    case 'callin':
      if (!L.targets.includes(a.target)) return 'bad_target';
      if (!RES.includes(a.res)) return 'bad_res';
      return null;
    case 'sacrifice':
      if (L.targets && !L.targets.includes(a.target)) return 'bad_target';
      return null;
    case 'spoil':
      if (a.res != null && !L.res.includes(a.res)) return 'bad_res';
      return null;
    default:
      return null;
  }
}
