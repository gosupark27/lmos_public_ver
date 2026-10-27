// Handshake — the rules. Pure functions over room state. No I/O, no clocks of their own:
// `now` always comes from the server.

import {
  ARCHETYPE_ORDER, ELO, ELO_WEIGHT, HEALTH_MAX, OUTBREAK_RELEASE, OUTBREAK_STEP,
  EARLIEST_OUTBREAK_ROUND, LIVE_PHASES, RES, weightClass,
} from './constants.js';
import { CROSSINGS, scenarioForRound, WORDS } from './content.js';
import {
  rng, tierOf, paceOf, seatById, priv, note, isTurned, isOutside, seatName, band, scenario,
  crossingDef, avgPresence, addHeat, shiftPresence, changeElo, computeNeed, effectiveNeed,
  dealCharacters, setupSecrets,
} from './state.js';
import { canSacrifice, voteEligible, validateAction } from './legal.js';
import { emit, say } from './narrator.js';
import { finishGame } from './ladder.js';

// ---------- phases ----------

export function enterPhase(state, phase, now) {
  state.phase = phase;
  state.phaseSeq += 1;
  state.phaseStartedAt = now;
  const pace = paceOf(state);
  const dur = {
    sunrise: pace.sunrise, silence: pace.silence, talk: pace.talk, act: pace.act, reveal: pace.reveal,
    vote: pace.vote, prodigal: pace.prodigal, crossing: pace.crossing, frozen: pace.frozen,
  }[phase];
  state.phaseEndsAt = dur ? now + dur * 1000 : null;
  for (const s of state.seats) s.ready = false;
  if (phase === 'act') for (const s of state.seats) { s.acted = false; s.actionAt = null; }
  if (phase === 'vote') for (const s of state.seats) s.voted = false;
  state.timers.botAt = LIVE_PHASES.has(phase) ? now + 900 : null;
}

export function startGame(state, now) {
  dealCharacters(state);
  setupSecrets(state);
  const tier = tierOf(state);
  state.heat = tier.heatStart;
  state.health = HEALTH_MAX;
  const firstKing = state.seats.find((s) => s.archetype === 'kingmaker');
  state.lead = firstKing ? firstKing.id : 0;
  say.genesis(state, state.specHash);
  beginAct(state, 1);
  enterPhase(state, 'sunrise', now);
}

export function beginAct(state, n) {
  const prevAct = state.act;
  // Silence lasts the act. Holding it from the act's first day earns "the one who waits".
  if (prevAct > 0) {
    const firstRound = (prevAct - 1) * 3 + 1;
    for (const s of state.seats) {
      if (s.silence.holding && s.silence.act === prevAct && s.silence.sinceRound === firstRound) s.stats.silenceActs += 1;
      s.silence = { holding: false, sinceRound: null, act: null, broken: false };
    }
  }
  state.act = n;
  if (n >= 2) {
    // Fracture: Rome to 1775 by collective truthfulness.
    const elos = state.seats.map((s) => state.secret.elo[s.id] ?? ELO.start);
    const avg = elos.reduce((a, b) => a + b, 0) / Math.max(1, elos.length);
    state.era = avg >= ELO.start ? '1775' : 'rome';
    say.era(state);
  }
  const tier = tierOf(state);
  const was = state.apocalypse;
  state.apocalypse = !!tier.apocalypse || (n === 3 && (state.heat >= 75 || state.health <= 1));
  if (state.apocalypse && !was && n > 1) say.apocalypse(state);
  const def = crossingDef(n);
  state.crossing = { act: n, id: def.id, name: def.name, line: def.line, pool: {}, jericho: 0, result: null };
  for (const r of Object.keys(def.needs)) state.crossing.pool[r] = 0;
  state.hidden.need = computeNeed(state, n);
  for (const s of state.seats) s.vouchedBy = [];
}

// After the current phase ends, decide what comes next.
export function advance(state, now) {
  switch (state.phase) {
    case 'sunrise':
      if (state.round === 0) return enterPhase(state, 'silence', now);
      return startRound(state, now);
    case 'silence':
      return startRound(state, now);
    case 'talk':
      closeTalk(state);
      return enterPhase(state, 'act', now);
    case 'act':
      resolveAct(state, now);
      if (state.peace) return freeze(state, now);
      state.revealOf = 'act';
      return enterPhase(state, 'reveal', now);
    case 'reveal':
      if (state.revealOf === 'act' && state.vote && !state.vote.result) return enterPhase(state, 'vote', now);
      if (state.revealOf === 'verdict' && state.prodigal && !state.prodigal.choice) return enterPhase(state, 'prodigal', now);
      return afterRound(state, now);
    case 'vote':
      resolveVote(state);
      state.revealOf = 'verdict';
      return enterPhase(state, 'reveal', now);
    case 'prodigal':
      if (!state.prodigal.choice) resolveProdigal(state, 'silent', null);
      state.revealOf = 'prodigal';
      return enterPhase(state, 'reveal', now);
    case 'crossing':
      if (state.health <= 0) return finishGame(state, 'lost', now, enterPhase);
      if (state.act >= 3) return finishGame(state, 'arrived', now, enterPhase);
      beginAct(state, state.act + 1);
      return enterPhase(state, 'sunrise', now);
    case 'frozen':
      return finishGame(state, 'peace', now, enterPhase);
    default:
      return undefined;
  }
}

function freeze(state, now) {
  say.peace(state);
  state.fx.push({ kind: 'bell', big: true });
  enterPhase(state, 'frozen', now);
}

function afterRound(state, now) {
  // Judges: if nobody reached for the vacant lead, it goes back to the crown.
  if (state.lead == null) {
    const crowned = state.seats.find((s) => s.assets.crowns > 0);
    state.lead = crowned ? crowned.id : state.leadBeforeVacate ?? 0;
    say.lead(state, state.lead, 'returned');
  }
  if (state.round % 3 === 0) {
    resolveCrossing(state);
    return enterPhase(state, 'crossing', now);
  }
  return startRound(state, now);
}

function startRound(state, now) {
  dawn(state);
  enterPhase(state, 'talk', now);
}

// ---------- dawn ----------

export function dawn(state) {
  state.round += 1;
  state.heatRise = 0;
  const sc = scenario(state);
  const mods = (sc && sc.mods) || {};
  const tier = tierOf(state);
  for (const s of state.seats) {
    s.ready = false; s.acted = false; s.voted = false; s.actionAt = null; s.hungry = false;
    const p = priv(state, s.id);
    p.action = null; p.vote = null; p.desync = null;
    if (s.outsideRound != null && s.outsideRound < state.round) s.outsideRound = null;
  }
  state.accusation = null;
  state.vote = null;
  state.prodigal = null;
  state.revealOf = null;
  for (const o of state.offers) if (o.status === 'open') o.status = 'expired';
  state.offers = state.offers.filter((o) => o.status === 'open');

  // Weight is felt at dawn: hoarded = presence going quiet.
  for (const s of state.seats) {
    if (weightClass(s.res) === 'heavy') {
      shiftPresence(state, s, -4, 'hoarding');
      addHeat(state, 1);
      breakFounding(state, s, 'no_hoard');
    }
  }
  let simmer = tier.simmer + (state.era === 'rome' ? 2 : state.era === '1775' ? -1 : 0) + (mods.dawnHeat || 0);
  addHeat(state, simmer);
  addHeat(state, -Math.floor(avgPresence(state) / 40));
  const turnedTonight = maybeOutbreak(state);

  say.dawn(state, sc, band(state).name);
  if (mods.vacateLead) {
    state.leadBeforeVacate = state.lead;
    state.lead = null;
    say.vacated(state);
  }

  const prev = scenarioForRound(state.round - 1);
  if (prev && prev.mods && prev.mods.spoilNextDawnAbove != null) {
    for (const s of state.seats) {
      const over = s.res.rations - prev.mods.spoilNextDawnAbove;
      if (over > 0) { s.res.rations -= over; say.spoiled(state, s.id, over); }
    }
  }
  if (mods.dawnGift) {
    for (const s of state.seats) for (const [r, n] of Object.entries(mods.dawnGift)) s.res[r] += n;
    say.manna(state);
  }
  if (!mods.noConsume && state.round > 1) {
    const b = band(state);
    for (const s of state.seats) {
      if (s.res.rations > 0) s.res.rations -= 1;
      else { s.hungry = true; s.stats.hungerDays += 1; shiftPresence(state, s, -6, 'hunger'); say.hunger(state, s.id, 'a meal'); }
      if (b.waterAtDawn) {
        if (s.res.water > 0) s.res.water -= 1;
        else { s.hungry = true; shiftPresence(state, s, -6, 'thirst'); say.hunger(state, s.id, 'water'); }
      }
    }
  }
  if (turnedTonight) say.outbreak(state);
}

function maybeOutbreak(state) {
  const o = state.secret.outbreak;
  if (state.round < EARLIEST_OUTBREAK_ROUND) return false;
  if (state.heat < o.threshold) return false;
  if (activeImposters(state) >= o.cap) return false;
  if (state.round - o.lastRound < 2) return false;
  const eligible = state.seats.filter((s) => !isTurned(state, s.id) && !s.caught && !s.redeemed);
  if (!eligible.length) return false;
  const weights = eligible.map((s) =>
    1 + (100 - s.presence) / 100 + (weightClass(s.res) === 'heavy' ? 0.5 : 0) + s.stats.wordsBroken * 0.2);
  const chosen = rng(state).weighted(eligible, weights);
  state.secret.turned[chosen.id] = { since: state.round };
  state.secret.turnedHistory.push({ seat: chosen.id, round: state.round });
  o.count += 1;
  o.lastRound = state.round;
  o.threshold += OUTBREAK_STEP;
  state.outbreaks += 1;
  state.heat = Math.max(0, state.heat - OUTBREAK_RELEASE);
  note(state, chosen.id, 'You turned in the night. No one else knows, not even anyone else who turned. If the train fails, you win. You can still step forward before anyone names you.', { turned: true });
  state.fx.push({ kind: 'outbreak' });
  return true;
}

export function activeImposters(state) {
  return Object.keys(state.secret.turned).filter((id) => {
    const s = seatById(state, Number(id));
    return s && !s.caught;
  }).length;
}

function breakFounding(state, seat, kind) {
  if (!seat.founding || seat.founding.kind !== kind || seat.founding.broken) return;
  seat.founding.broken = true;
  changeElo(state, seat.id, ELO.foundingBroken, 'founding_broken', { kind });
}

// ---------- talk ----------

function closeTalk(state) {
  for (const o of state.offers) if (o.status === 'open') o.status = 'expired';
}

// ---------- act ----------

const PUBLIC_KINDS = new Set(['give', 'forage', 'accuse', 'vouch', 'claim_lead', 'boundary', 'rally', 'stir', 'calm', 'callin', 'sacrifice', 'esther', 'return']);

export function resolveAct(state) {
  const sc = scenario(state);
  const mods = (sc && sc.mods) || {};
  const b = band(state);
  const acts = new Map();
  for (const seat of state.seats) {
    const p = priv(state, seat.id);
    let a = p.action;
    if (a) {
      const err = validateAction(state, seat.id, a);
      if (err) a = { kind: 'drift', failed: err, wanted: a.kind };
    } else a = { kind: 'drift' };
    acts.set(seat.id, a);
  }
  const of = (k) => [...acts].filter(([, a]) => a.kind === k).map(([id, a]) => ({ id, a, seat: seatById(state, id) }));
  const gave = new Map();        // seat -> [{to,res,n}]
  const contributed = new Map(); // seat -> {res,n}
  const firstOfAct = (state.act - 1) * 3 + 1;
  const outbreakThisAct = state.secret.outbreak.lastRound >= firstOfAct;
  let cameClean = false;

  // 1. Coming home.
  for (const { id, seat } of of('esther')) {
    if (!isTurned(state, id) || seat.caught) continue;
    const m = mods.estherMult || 1;
    delete state.secret.turned[id];
    seat.redeemed = true;
    changeElo(state, id, ELO.esther * m, 'esther');
    addHeat(state, -15 * m);
    shiftPresence(state, seat, 10, 'esther');
    say.esther(state, id);
    cameClean = true;
  }
  for (const { id, seat } of of('return')) {
    if (!seat.caught || seat.prodigal !== 'silent') continue;
    delete state.secret.turned[id];
    seat.prodigal = 'returned';
    seat.redeemed = true;
    changeElo(state, id, ELO.returned, 'returned');
    addHeat(state, -8);
    shiftPresence(state, seat, 8, 'returned');
    say.returned(state, id);
    cameClean = true;
  }

  // 2. Offerings. Validity is decided here and never leaves the server.
  const sacs = of('sacrifice').filter(({ seat, a }) => canSacrifice(state, seat)
    && (seat.archetype !== 'kingmaker' || (seatById(state, a.target) && a.target !== seat.id)));
  for (const { id, a, seat } of sacs) {
    const reasons = [];
    if (state.words.some((w) => w.seat === id && w.act === state.act && w.kind === 'sacrifice')) reasons.push('announced');
    const giftedToday = [...acts].some(([, x]) => x.kind === 'give' && x.target === id);
    if (seat.tradedRound === state.round || seat.receivedRound === state.round || giftedToday) reasons.push('traded');
    const pressure = b.window || (state.era === '1775' && state.heat >= 25) || !!mods.windowOpen || state.apocalypse || outbreakThisAct;
    if (!pressure) reasons.push('no_pressure');
    if (sacs.length > 1) reasons.push('not_independent');
    if (isTurned(state, id)) reasons.push('turned');
    if (state.round < 2) reasons.push('too_early');
    const valid = reasons.length === 0;
    let target = null;
    switch (seat.archetype) {
      case 'kingmaker': {
        const t = seatById(state, a.target);
        seat.assets.crowns -= 1;
        t.assets.crowns += 1;
        state.lead = t.id;
        target = t.id;
        break;
      }
      case 'populist': seat.assets.crowd = 0; addHeat(state, -10); break;
      case 'broker': seat.assets.leverage = {}; break;
      case 'idealist': seat.assets.conviction = false; addHeat(state, -5); break;
      default: break;
    }
    seat.sacrificed = { round: state.round };
    shiftPresence(state, seat, 10, 'sacrifice');
    state.secret.sacrifices.push({ seat: id, archetype: seat.archetype, round: state.round, valid, reasons });
    say.sacrifice(state, id, seat.archetype, target);
  }

  // 3. Power: who thinks they lead.
  const claims = of('claim_lead').map((x) => x.id).filter((id) => id !== state.lead);
  if (claims.length) {
    const best = claims.slice().sort((x, y) => {
      const sx = seatById(state, x), sy = seatById(state, y);
      return sy.presence - sx.presence || (sx.actionAt || 0) - (sy.actionAt || 0);
    })[0];
    const holder = state.lead;
    const held = holder != null && acts.get(holder) && acts.get(holder).kind === 'hold_lead';
    if (holder == null || !held) {
      state.lead = best;
      say.lead(state, best, 'took');
    } else {
      addHeat(state, 3);
      for (const c of claims) shiftPresence(state, seatById(state, c), -6, 'contested');
      shiftPresence(state, seatById(state, holder), -3, 'contested');
      say.contested(state, holder, claims);
    }
  }

  // 4. Boundary: who counts as inside. Only works if you still lead.
  for (const { id, a, seat } of of('boundary')) {
    if (state.lead !== id || !band(state).boundary) continue;
    const t = seatById(state, a.target);
    t.outsideRound = state.round + 1;
    addHeat(state, 4);
    shiftPresence(state, seat, -8, 'boundary');
    say.boundary(state, id, t.id);
  }

  // 5. Powers.
  const rallied = of('rally').some(({ seat }) => seat.assets.crowns > 0);
  for (const { id } of of('rally')) say.rally(state, id);
  for (const { id, seat } of of('stir')) if (seat.assets.crowd > 0) { addHeat(state, 3); say.crowd(state, id, 1); }
  for (const { id, seat } of of('calm')) if (seat.assets.crowd > 0) { addHeat(state, -3); say.crowd(state, id, -1); }
  for (const { id, a, seat } of of('peek')) {
    const t = seatById(state, a.target);
    const prevDeed = (state.secret.lastAction || {})[t.id];
    const last = !!prevDeed && prevDeed.kind === 'contribute';
    note(state, id, `You read the ${nameOf(state, t)}’s mail: ${t.res.rations} rations, ${t.res.water} water, ${t.res.timber} timber. Last round they ${last ? 'did' : 'did not'} put into the cache.`,
      { peek: t.id, res: { ...t.res }, contributedLast: last });
    seat.assets.leverage[t.id] = (seat.assets.leverage[t.id] || 0) + 1;
  }
  for (const { id, a, seat } of of('callin')) {
    const t = seatById(state, a.target);
    if (!(seat.assets.leverage[t.id] > 0)) continue;
    seat.assets.leverage[t.id] -= 1;
    let r = t.res[a.res] > 0 ? a.res : RES.slice().sort((x, y) => t.res[y] - t.res[x])[0];
    if (t.res[r] > 0) { t.res[r] -= 1; seat.res[r] += 1; say.callin(state, id, t.id, r); }
    else say.callin(state, id, t.id, null);
  }
  for (const { id } of of('look')) {
    const need = effectiveNeed(state);
    const def = crossingDef(state.act);
    let cacheText = '';
    if (state.hidden.cacheFound[state.act] == null && def) {
      state.hidden.cacheFound[state.act] = id;
      seatById(state, id).res[def.cache] += 2;
      cacheText = ` You also found a cache no one was watching: 2 ${def.cache}.`;
    }
    const pool = state.crossing ? { ...state.crossing.pool } : {};
    priv(state, id).look = { round: state.round, need, pool };
    note(state, id, `You looked where no one was looking. ${state.crossing ? state.crossing.name.charAt(0).toUpperCase() + state.crossing.name.slice(1) : 'The crossing'} needs ${fmt(need)}; the cache holds ${fmt(pool)}.${cacheText}`, { look: true, need, pool });
  }

  // 6. Gifts: freely given.
  let giftCool = 0;
  for (const { id, a, seat } of of('give')) {
    const t = seatById(state, a.target);
    const n = Math.min(a.n, seat.res[a.res]);
    if (n <= 0) continue;
    seat.res[a.res] -= n;
    t.res[a.res] += n;
    t.receivedRound = state.round;
    seat.stats.giftsUnits += n;
    seat.stats.giftsCount += 1;
    gave.set(id, [...(gave.get(id) || []), { to: t.id, res: a.res, n }]);
    shiftPresence(state, seat, Math.min(8, 4 * n) * (mods.giftPresenceMult || 1), 'gift');
    if (giftCool < 3) { addHeat(state, -1); giftCool += 1; }
    say.gift(state, id, t.id, a.res, n);
  }

  // 7. The crossing cache. Amounts are private; the total is public.
  const added = {};
  const builders = [];
  for (const { id, a, seat } of of('contribute')) {
    const n = Math.min(a.n, seat.res[a.res]);
    if (n <= 0) continue;
    seat.res[a.res] -= n;
    let credited = mods.contributeMult ? Math.round(n * mods.contributeMult) : n;
    if (rallied) credited += 1;
    state.crossing.pool[a.res] = (state.crossing.pool[a.res] || 0) + credited;
    added[a.res] = (added[a.res] || 0) + credited;
    seat.stats.contributedUnits += n;
    seat.stats.contributedActs[state.act] = true;
    contributed.set(id, { res: a.res, n });
    builders.push(id);
  }
  if (Object.keys(added).length) say.cache(state, added);

  // 8. The turned take from the cache.
  const taken = {};
  for (const { id, a, seat } of of('spoil')) {
    if (!isTurned(state, id) || seat.caught) continue;
    const pool = state.crossing.pool;
    let r = a.res && pool[a.res] > 0 ? a.res : Object.keys(pool).sort((x, y) => pool[y] - pool[x])[0];
    const n = Math.min(3, pool[r] || 0);
    if (n > 0) { pool[r] -= n; taken[r] = (taken[r] || 0) + n; seat.stats.spoiled += n; }
    shiftPresence(state, seat, -6, 'spoil');
    breakFounding(state, seat, 'never_spoil');
  }
  if (Object.keys(taken).length) say.spoil(state, taken);

  // 9. Forage.
  const yieldN = b.forage + (mods.forageBonus || 0) + (state.era === 'rome' && b.forage > 0 ? 1 : 0);
  for (const { id, a, seat } of of('forage')) {
    if (yieldN <= 0) continue;
    seat.res[a.res] += yieldN;
    seat.stats.foraged += yieldN;
    say.forage(state, id, a.res);
  }

  // 10. Someone feeds the fire.
  let stoked = false;
  for (const { id, seat } of of('stoke')) {
    if (!isTurned(state, id) || seat.caught) continue;
    addHeat(state, 6);
    shiftPresence(state, seat, -4, 'stoke');
    seat.stats.stoked += 1;
    stoked = true;
  }
  if (stoked) say.stoke(state);

  // 11. Presence: doing nothing.
  for (const { seat } of of('still')) {
    const gain = (8 + (seat.silence.holding ? 8 : 0)) * (mods.stillMult || 1);
    shiftPresence(state, seat, gain, 'still');
  }

  // 12. Influence: vouching.
  for (const { id, a } of of('vouch')) {
    const t = seatById(state, a.target);
    if (!t.vouchedBy.includes(id)) t.vouchedBy.push(id);
    say.vouch(state, id, t.id);
  }

  // 13. Accusations.
  const acc = new Map();
  for (const { id, a } of of('accuse')) {
    acc.set(a.target, [...(acc.get(a.target) || []), id]);
    say.accuse(state, id, a.target);
  }
  const needs = mods.singleAccuser ? 1 : b.accuseNeeds;
  let pickTarget = null;
  for (const [t, accusers] of acc) {
    if (accusers.length < needs) continue;
    if (pickTarget == null) { pickTarget = t; continue; }
    const cur = acc.get(pickTarget);
    if (accusers.length > cur.length) pickTarget = t;
    else if (accusers.length === cur.length) {
      if (state.lead != null && accusers.includes(state.lead) && !cur.includes(state.lead)) pickTarget = t;
      else if (!(state.lead != null && cur.includes(state.lead))) {
        const ea = Math.min(...accusers.map((x) => seatById(state, x).actionAt || Infinity));
        const ec = Math.min(...cur.map((x) => seatById(state, x).actionAt || Infinity));
        if (ea < ec) pickTarget = t;
      }
    }
  }
  for (const [t, accusers] of acc) if (accusers.length < needs) say.unseconded(state, t);
  if (pickTarget != null) {
    state.vote = { accused: pickTarget, accusers: acc.get(pickTarget), votes: {}, builders: mods.buildersCantVote ? builders : [], result: null, round: state.round };
    say.voteOpen(state, pickTarget);
  }

  // 14. Witness: the Idealist sees one deed as it was.
  for (const { id, a, seat } of of('witness')) {
    seat.assets.witnessAct = state.act;
    const t = seatById(state, a.target);
    const ta = acts.get(t.id);
    note(state, id, `You watched the ${nameOf(state, t)}: ${describeDeed(state, ta, contributed.get(t.id))}.`, { witness: t.id, kind: ta.kind });
  }

  // 15. Words against deeds.
  checkWords(state, acts, gave, contributed);

  // 16. Jericho and Jonah.
  if (mods.jericho) {
    const holders = state.seats.filter((s) => s.silence.holding).length;
    if (holders >= Math.ceil(state.seats.length / 2)) { state.crossing.jericho = mods.jericho; say.jericho(state, true); }
  }
  if (mods.calmOnConfess && cameClean) { addHeat(state, -mods.calmOnConfess); say.calmed(state); }

  // 17. What the table can see of each seat's deed. The full deed goes to the
  // server-only record the epilogue reads from ("the game admits it sees you").
  for (const seat of state.seats) {
    const a = acts.get(seat.id);
    seat.lastPublic = PUBLIC_KINDS.has(a.kind) ? { kind: a.kind, target: a.target ?? null, res: a.kind === 'forage' ? a.res : null } : { kind: 'private' };
    (state.secret.lastAction ||= {})[seat.id] = a;
    const c = contributed.get(seat.id);
    (state.secret.deeds ||= []).push({
      seat: seat.id, round: state.round, kind: a.kind, target: a.target ?? null,
      res: c ? c.res : a.res ?? null, n: c ? c.n : a.n ?? null,
    });
  }

  // 18. Peace: four offerings the road accepted, one per archetype.
  const valid = new Set(state.secret.sacrifices.filter((s) => s.valid).map((s) => s.archetype));
  if (ARCHETYPE_ORDER.every((x) => valid.has(x))) state.peace = true;

  state.actLog.push({ round: state.round, cache: added, taken, accused: pickTarget });
}

function nameOf(state, seat) {
  return seatName(state, seat.id).replace(/^the /, '');
}

function fmt(obj) {
  if (!obj) return 'nothing';
  const parts = Object.entries(obj).map(([r, n]) => `${n} ${r}`);
  return parts.length ? parts.join(', ') : 'nothing';
}

function describeDeed(state, a, contrib) {
  switch (a.kind) {
    case 'contribute': return contrib ? `put ${contrib.n} ${contrib.res} into the cache` : 'reached for the cache but had nothing to give';
    case 'spoil': return 'took from the cache';
    case 'stoke': return 'fed the fire after dark';
    case 'still': return 'was still';
    case 'look': return 'went looking where no one was watching';
    case 'peek': return 'read someone’s mail';
    case 'witness': return 'was watching someone too';
    case 'drift': return 'did nothing at all';
    case 'give': return `gave ${a.n} ${a.res} to ${seatName(state, a.target)}`;
    case 'forage': return `went out for ${a.res}`;
    case 'accuse': return `called ${seatName(state, a.target)} to account`;
    case 'hold_lead': return 'held on to the lead';
    default: return a.kind.replace('_', ' ');
  }
}

function weightFor(seat, family) {
  const w = ELO_WEIGHT[seat.archetype] || ELO_WEIGHT.kingmaker;
  return w[family] ?? 1;
}

function checkWords(state, acts, gave, contributed) {
  const words = state.words.filter((w) => w.round === state.round && !w.founding && w.kind !== 'vote');
  const broke = new Set();
  const spoke = new Set();
  for (const w of words) {
    const seat = seatById(state, w.seat);
    const a = acts.get(w.seat);
    const fam = WORDS[w.kind] ? WORDS[w.kind].family : 'deed';
    const mult = weightFor(seat, fam);
    spoke.add(w.seat);
    if (fam === 'claim') {
      const truth = !!state.secret.claimTruth[w.id];
      if (truth) { seat.stats.claimsTrue += 1; changeElo(state, w.seat, ELO.claimTrue * mult, 'claim_true', { word: w.id, kind: w.kind }); }
      else {
        seat.stats.claimsFalse += 1;
        changeElo(state, w.seat, ELO.claimFalse * mult, 'claim_false', { word: w.id, kind: w.kind });
        breakFounding(state, seat, 'truth');
      }
      continue;
    }
    let kept = false;
    switch (w.kind) {
      case 'contribute': { const c = contributed.get(w.seat); kept = !!c && c.res === w.res && c.n >= w.n; break; }
      case 'give': kept = (gave.get(w.seat) || []).some((g) => g.to === w.target && g.res === w.res && g.n >= w.n); break;
      case 'still': kept = a.kind === 'still'; break;
      case 'no_accuse': kept = a.kind !== 'accuse'; break;
      case 'accuse': kept = a.kind === 'accuse' && a.target === w.target; break;
      case 'sacrifice': kept = a.kind === 'sacrifice'; break;
      default: kept = true;
    }
    w.checked = true;
    if (kept) { seat.stats.wordsKept += 1; changeElo(state, w.seat, ELO.pledgeKept * mult, 'kept', { word: w.id, kind: w.kind }); }
    else {
      seat.stats.wordsBroken += 1;
      broke.add(w.seat);
      changeElo(state, w.seat, ELO.pledgeBroken * mult, 'broken', { word: w.id, kind: w.kind });
      breakFounding(state, seat, 'truth');
    }
  }
  for (const id of spoke) {
    const seat = seatById(state, id);
    if (broke.has(id)) {
      shiftPresence(state, seat, -10, 'desync');
      priv(state, id).desync = { round: state.round };
    } else if (words.some((w) => w.seat === id && WORDS[w.kind] && WORDS[w.kind].family !== 'claim')) {
      shiftPresence(state, seat, 3, 'in_sync');
    }
  }
}

// ---------- vote ----------

export function voteWeight(state, seat, ballot) {
  let w = 1 + (seat.assets.crowns || 0) + (seat.assets.crowd >= 2 ? 1 : 0) + (state.era === 'rome' && state.lead === seat.id ? 1 : 0);
  if (ballot && ballot.stake && seat.archetype === 'idealist' && seat.assets.conviction) w *= 2;
  return w;
}

export function resolveVote(state) {
  const v = state.vote;
  if (!v || v.result) return;
  const accused = seatById(state, v.accused);
  const eligible = voteEligible(state);
  let yes = 0, no = 0, yesCount = 0;
  for (const id of eligible) {
    const ballot = v.votes[id];
    if (!ballot) continue;
    const w = voteWeight(state, seatById(state, id), ballot);
    if (ballot.yes) { yes += w; yesCount += 1; } else no += w;
  }
  let vouch = 0;
  for (const vid of accused.vouchedBy) {
    const vs = seatById(state, vid);
    vouch += 1 + (vs.archetype === 'populist' && vs.assets.crowd >= 2 ? 1 : 0);
  }
  no += vouch;
  let named = yes > no && yesCount >= 2;
  const leadBallot = state.lead != null ? v.votes[state.lead] : null;
  if (!named && yes === no && yes > 0 && leadBallot && eligible.includes(state.lead) && leadBallot.yes) named = true;
  const tally = { yes, no, vouch, yesCount, cast: Object.keys(v.votes).length, eligible: eligible.length };

  // Vote pledges.
  for (const w of state.words.filter((x) => x.round === state.round && x.kind === 'vote' && x.target === v.accused)) {
    const seat = seatById(state, w.seat);
    const ballot = v.votes[w.seat];
    const kept = !!ballot && ballot.yes === w.yes;
    const mult = weightFor(seat, 'vote');
    if (kept) { seat.stats.wordsKept += 1; changeElo(state, w.seat, ELO.pledgeKept * mult, 'kept', { word: w.id, kind: 'vote' }); }
    else {
      seat.stats.wordsBroken += 1;
      changeElo(state, w.seat, ELO.pledgeBroken * mult, 'broken', { word: w.id, kind: 'vote' });
      shiftPresence(state, seat, -10, 'desync');
      priv(state, w.seat).desync = { round: state.round };
      breakFounding(state, seat, 'truth');
    }
  }

  let caught = false;
  if (named) {
    if (isTurned(state, accused.id) && !accused.caught) {
      caught = true;
      accused.caught = true;
      accused.prodigal = 'open';
      state.prodigal = { seat: accused.id, choice: null };
      for (const [id, b] of Object.entries(v.votes)) if (b.yes) seatById(state, Number(id)).stats.correctYes += 1;
      for (const vid of accused.vouchedBy) seatById(state, vid).stats.vouchedCaught += 1;
      say.named(state, accused.id, tally);
    } else {
      addHeat(state, 6);
      for (const [id, b] of Object.entries(v.votes)) if (b.yes) seatById(state, Number(id)).stats.wrongYes += 1;
      say.wrong(state, accused.id, tally);
    }
  } else {
    addHeat(state, 2);
    say.hung(state, accused.id, tally);
  }
  v.result = { named, caught, tally };
  state.fx.push({ kind: 'verdict', named, caught });
}

// ---------- prodigal ----------

export function resolveProdigal(state, choice, text) {
  const pr = state.prodigal;
  if (!pr || pr.choice) return;
  const seat = seatById(state, pr.seat);
  const sc = scenario(state);
  const mods = (sc && sc.mods) || {};
  pr.choice = choice === 'confess' ? 'confess' : 'silent';
  if (pr.choice === 'confess') {
    delete state.secret.turned[seat.id];
    seat.redeemed = true;
    seat.prodigal = 'confessed';
    changeElo(state, seat.id, ELO.confess, 'confess');
    addHeat(state, -10);
    shiftPresence(state, seat, 10, 'confess');
    for (const s of state.seats) s.res.rations += 1;
    say.confess(state, seat.id, text || null);
    if (mods.calmOnConfess) { addHeat(state, -mods.calmOnConfess); say.calmed(state); }
    state.fx.push({ kind: 'feast' });
  } else {
    seat.prodigal = 'silent';
    changeElo(state, seat.id, ELO.staySilent, 'stay_silent');
    say.staySilent(state, seat.id);
  }
}

// ---------- crossing ----------

export function resolveCrossing(state) {
  const need = effectiveNeed(state);
  const pool = { ...state.crossing.pool };
  const ok = Object.entries(need).every(([r, v]) => (pool[r] || 0) >= v);
  for (const s of state.seats) {
    if (s.founding && s.founding.kind === 'share_every' && !s.stats.contributedActs[state.act]) breakFounding(state, s, 'share_every');
  }
  if (!ok) {
    state.health -= 1;
    addHeat(state, 8);
    for (const s of state.seats) {
      const r = RES.slice().sort((x, y) => s.res[y] - s.res[x])[0];
      if (s.res[r] > 0) s.res[r] -= 1;
    }
  }
  state.crossing.result = { ok, need, pool };
  say.crossing(state, ok, state.crossing.name, pool, need, !ok);
  state.fx.push({ kind: 'crossing', ok });
}

export { CROSSINGS };
