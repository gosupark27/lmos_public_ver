// Bots. They fill empty seats and stand in for dropped players.
// A bot sees exactly what a phone sees: the public snapshot, its own private delta,
// and the public diary. It never reads server secrets.

import { RES, LIMITS } from './constants.js';
import { BOT_LINES, CHARACTERS, FOUNDING } from './content.js';
import { makeRng, seedFrom } from './rng.js';

const PERSONAS = [
  { id: 'steady', honesty: 0.95, generosity: 0.7, talk: 0.35, quiet: 0.05, nerve: 0.5 },
  { id: 'quiet', honesty: 0.9, generosity: 0.5, talk: 0.08, quiet: 0.6, nerve: 0.3 },
  { id: 'sly', honesty: 0.7, generosity: 0.35, talk: 0.45, quiet: 0.1, nerve: 0.7 },
  { id: 'loud', honesty: 0.85, generosity: 0.55, talk: 0.7, quiet: 0.0, nerve: 0.8 },
  { id: 'kind', honesty: 0.92, generosity: 0.9, talk: 0.3, quiet: 0.15, nerve: 0.35 },
];

export function personaFor(code, seatId) {
  return PERSONAS[seedFrom(`${code}:${seatId}`) % PERSONAS.length];
}

// Stand-ins are "scaled by room temperature and ELO": the absent player's
// truthfulness sets the stand-in's honesty; heat makes it cautious.
export function standInPersona(elo, heat) {
  const honesty = Math.max(0.55, Math.min(0.98, (elo - 1300) / 400));
  return { id: 'standin', honesty, generosity: 0.4, talk: 0, quiet: 0, nerve: Math.max(0.1, 0.6 - heat / 200), standIn: true };
}

export function newMemory() {
  return { suspicion: {}, clean: [], turned: [], seen: 0, presence: {}, plan: null, pledged: [], lastTalkRound: 0, traded: 0 };
}

function nameOf(pub, id) {
  const s = pub.seats.find((x) => x.id === id);
  const c = s && CHARACTERS.find((x) => x.id === s.character);
  return c ? c.name : `Seat ${id + 1}`;
}

// Fold new public diary entries into the bot's suspicions.
export function observe(mem, pub, me, entries) {
  const sus = mem.suspicion;
  const bump = (id, v) => { if (id === me.seat) return; sus[id] = (sus[id] || 0) + v; };
  const privateDeeds = pub.seats.filter((s) => s.id !== me.seat && s.last && s.last.kind === 'private').map((s) => s.id);
  for (const e of entries) {
    if (e.seq <= mem.seen) continue;
    mem.seen = e.seq;
    const d = e.data || {};
    switch (e.kind) {
      case 'spoil':
      case 'stoke':
        for (const id of privateDeeds) bump(id, (e.kind === 'spoil' ? 1.6 : 1.0) / Math.max(1, privateDeeds.length));
        break;
      case 'cache': {
        const pledged = pub.words.filter((w) => w.kind === 'contribute' && w.round === e.round);
        const promised = pledged.reduce((a, w) => a + (w.n || 0), 0);
        const added = Object.values(d.added || {}).reduce((a, b) => a + b, 0);
        if (promised > added + 1) for (const w of pledged) bump(w.seat, (promised - added) / pledged.length / 2);
        break;
      }
      case 'caught': if (!mem.turned.includes(d.target)) mem.turned.push(d.target); break;
      case 'wrong': if (!mem.clean.includes(d.target)) mem.clean.push(d.target); sus[d.target] = 0; break;
      case 'confess': case 'esther': case 'returned':
        mem.turned = mem.turned.filter((x) => x !== d.seat);
        if (!mem.clean.includes(d.seat)) mem.clean.push(d.seat);
        sus[d.seat] = 0;
        break;
      case 'gift': bump(d.from, -0.3); break;
      case 'outbreak':
        mem.outbreakRound = e.round;
        for (const s of pub.seats) if (s.id !== me.seat && !mem.clean.includes(s.id)) bump(s.id, 0.15);
        break;
      default: break;
    }
  }
  // Visible desync: a seat whose presence dropped a level.
  for (const s of pub.seats) {
    const prev = mem.presence[s.id];
    if (prev != null && s.presence < prev) bump(s.id, 0.5 * (prev - s.presence));
    mem.presence[s.id] = s.presence;
  }
  // What this bot learned privately.
  for (const n of me.notes || []) {
    if (n.data && n.data.witness != null) {
      if (n.data.kind === 'spoil' || n.data.kind === 'stoke') { if (!mem.turned.includes(n.data.witness)) mem.turned.push(n.data.witness); }
      else bump(n.data.witness, -0.4);
    }
  }
}

function topSuspect(mem, pub, me) {
  let best = null, score = -Infinity;
  for (const s of pub.seats) {
    if (s.id === me.seat || s.caught || s.redeemed || mem.clean.includes(s.id)) continue;
    const v = (mem.turned.includes(s.id) ? 100 : 0) + (mem.suspicion[s.id] || 0);
    if (v > score) { score = v; best = s.id; }
  }
  return best == null ? null : { id: best, score };
}

function activeThreat(pub) {
  const resolved = pub.seats.filter((s) => s.caught || s.redeemed).length;
  return pub.outbreaks > resolved;
}

function crossingNeeds(pub) {
  return pub.crossing ? Object.keys(pub.crossing.pool) : [];
}

// ---------- talk ----------

export function talkIntents(ctx) {
  const { pub, me, mem, rng, persona } = ctx;
  const out = [];
  const L = me.legal;
  if (!L || L.phase !== 'talk') return out;
  if (mem.talkedRound === pub.round) {
    answerOffers(ctx, out);
    out.push({ k: 'ready' });
    return out;
  }
  mem.talkedRound = pub.round;
  const sc = pub.scenario;
  mem.plan = planAction(ctx, true);

  if (L.words && L.words.founding && rng.chance(0.8) && !persona.standIn) {
    const options = persona.honesty > 0.8 ? ['share_every', 'truth', 'no_hoard'] : Object.keys(FOUNDING);
    out.push({ k: 'founding', kind: rng.pick(options) });
  }
  if (!me.silence.holding && !persona.standIn && rng.chance(persona.quiet * (sc && sc.id === 'joshua' ? 1.6 : 0.5))) {
    out.push({ k: 'silence' });
    out.push({ k: 'ready' });
    return out;
  }
  if (me.silence.holding || persona.standIn) { out.push({ k: 'ready' }); return out; }

  const plan = mem.plan;
  const words = [];
  if (plan && plan.kind === 'contribute' && rng.chance(0.75)) {
    // An honest bot pledges what it means to do; a turned one sometimes promises more.
    const n = me.turned ? Math.max(plan.n, 1 + rng.int(2)) : plan.n;
    words.push({ k: 'word', kind: 'contribute', res: plan.res, n });
  } else if (plan && plan.kind === 'still' && rng.chance(0.3)) {
    words.push({ k: 'word', kind: 'still' });
  } else if (plan && plan.kind === 'sacrifice' && rng.chance(0.2)) {
    words.push({ k: 'word', kind: 'sacrifice' });
  } else if (plan && plan.kind === 'accuse' && rng.chance(0.5)) {
    words.push({ k: 'word', kind: 'accuse', target: plan.target });
  }
  const suspicious = activeThreat(pub) && (me.turned || (mem.suspicion[me.seat] || 0) > 0 || rng.chance(0.15));
  if (suspicious && rng.chance(0.5)) words.push({ k: 'word', kind: 'clean' });
  for (const w of words.slice(0, L.words ? L.words.left : 0)) out.push(w);
  mem.pledged = words.map((w) => ({ ...w }));

  // Trade if short on what the crossing needs.
  const needs = crossingNeeds(pub);
  if (L.canTrade && mem.traded < pub.round && rng.chance(0.35)) {
    const lacking = needs.find((r) => (me.res[r] || 0) === 0);
    const surplus = RES.filter((r) => (me.res[r] || 0) >= 3 && r !== lacking).sort((a, b) => me.res[b] - me.res[a])[0];
    if (lacking && surplus) {
      const partners = pub.seats.filter((s) => s.id !== me.seat && L.tradeTargets.includes(s.id) && s.weight !== 'light');
      const to = rng.pick(partners.length ? partners : pub.seats.filter((s) => L.tradeTargets.includes(s.id)));
      if (to) { out.push({ k: 'offer', to: to.id, give: { [surplus]: 1 }, get: { [lacking]: 1 } }); mem.traded = pub.round; }
    }
  }
  answerOffers(ctx, out);

  if (pub.config.tableTalk && rng.chance(persona.talk) && mem.lastTalkRound < pub.round) {
    mem.lastTalkRound = pub.round;
    const top = topSuspect(mem, pub, me);
    let pool = BOT_LINES.open;
    if (mem.outbreakRound === pub.round) pool = BOT_LINES.outbreak;
    else if (top && top.score > 1.2) pool = BOT_LINES.suspicious;
    else if ((mem.suspicion[me.seat] || 0) > 1 || me.turned) pool = BOT_LINES.defensive;
    else if (pub.weather.band === 'hot' || pub.weather.band === 'boiling') pool = BOT_LINES.calm;
    let line = rng.pick(pool);
    if (line.includes('{seat}')) line = top ? line.replace('{seat}', nameOf(pub, top.id)) : rng.pick(BOT_LINES.open);
    out.push({ k: 'talk', text: line });
  }
  out.push({ k: 'ready' });
  return out;
}

function answerOffers(ctx, out) {
  const { pub, me, rng } = ctx;
  const needs = crossingNeeds(pub);
  for (const o of me.offersIn || []) {
    const getsNeeded = Object.keys(o.give).some((r) => needs.includes(r) || r === 'rations');
    const canPay = RES.every((r) => (me.res[r] || 0) >= (o.get[r] || 0) + (needs.includes(r) ? 1 : 0));
    if (getsNeeded && canPay && rng.chance(0.8)) out.push({ k: 'accept', offer: o.id });
    else out.push({ k: 'decline', offer: o.id });
  }
}

// ---------- act ----------

function legalAction(L, kind) {
  return L.actions.find((a) => a.kind === kind);
}

function planAction(ctx, early) {
  const { pub, me, mem, rng, persona, skill } = ctx;
  const needs = crossingNeeds(pub);
  const gauge = pub.crossing ? pub.crossing.gauge.level : 0;
  const band = pub.weather.band;
  const threat = activeThreat(pub);
  const sc = pub.scenario ? pub.scenario.id : null;
  const top = topSuspect(mem, pub, me);
  const accuseThreshold = 1.9 - skill * 1.0;

  if (me.turned && !pub.seats[me.seat].caught) {
    if (band === 'boiling' && pub.health <= 1 && rng.chance(0.1 + persona.honesty * 0.15)) return { kind: 'esther' };
    if (sc === 'esther' && rng.chance(0.08 + persona.honesty * 0.1)) return { kind: 'esther' };
    const pool = pub.crossing ? Object.values(pub.crossing.pool).reduce((a, b) => a + b, 0) : 0;
    if (pool > 0 && (gauge <= 1 || pub.round % 3 === 0) && rng.chance(0.55)) return { kind: 'spoil', res: needs[0] };
    if (rng.chance(0.2)) return { kind: 'stoke' };
    if (top && top.score > 0.8 && rng.chance(0.25)) return { kind: 'accuse', target: top.id };
    const r = needs.find((x) => (me.res[x] || 0) > 0);
    if (r && rng.chance(0.5)) return { kind: 'contribute', res: r, n: 1 };
    return { kind: 'still' };
  }

  if (me.legal && me.legal.phase === 'act' && !early) {
    if (legalAction(me.legal, 'return') && rng.chance(0.35 + persona.honesty * 0.4)) return { kind: 'return' };
  }

  const gauges = pub.crossing ? pub.crossing.gauges || {} : {};
  const lvl = (r) => (gauges[r] ? gauges[r].level : 0);
  const contribRes = needs.filter((x) => lvl(x) >= 1 && (me.res[x] || 0) > (x === 'rations' ? 2 : 0))
    .sort((a, b) => lvl(b) - lvl(a) || (me.res[b] || 0) - (me.res[a] || 0));
  const lastDayOfAct = pub.round % 3 === 0;
  const hotNow = band === 'hot' || band === 'boiling';
  const starving = (me.res.rations || 0) === 0 || (hotNow && (me.res.water || 0) === 0);
  const contributeNow = () => {
    const r = contribRes[0];
    const keep = r === 'rations' ? 2 : 0;
    const want = Math.max(1, lvl(r) - 1) + (lastDayOfAct && lvl(r) >= 2 ? 1 : 0);
    const n = Math.max(1, Math.min((me.res[r] || 0) - keep, Math.max(1, want)));
    return { kind: 'contribute', res: r, n };
  };

  // An offering, sometimes. Bots stagger by archetype so they rarely collide.
  const canSac = !me.sacrificed && (me.assets.crowns > 0 || me.assets.crowd > 0 || me.assets.conviction || ctx.archetype === 'broker');
  const pressure = band === 'hot' || band === 'boiling' || sc === 'esther' || pub.apocalypse || (pub.era === '1775' && band === 'warm') || threat;
  const window = { kingmaker: [4, 5], populist: [5, 6], broker: [7, 8], idealist: [8, 9] }[ctx.archetype] || [4, 9];
  const inWindow = pub.round >= window[0] && pub.round <= window[1];
  const firstOfKind = !pub.seats.some((s) => s.archetype === ctx.archetype && s.id < me.seat && !s.sacrificed);
  const sacChance = (inWindow && firstOfKind ? 0.3 + persona.honesty * 0.15 : 0.015) + (sc === 'esther' ? 0.04 : 0);
  if (canSac && pressure && pub.round >= 3 && rng.chance(sacChance)) {
    const target = ctx.archetype === 'kingmaker'
      ? pub.seats.filter((s) => s.id !== me.seat && !mem.turned.includes(s.id)).sort((a, b) => b.presence - a.presence)[0]
      : null;
    return { kind: 'sacrifice', target: target ? target.id : undefined };
  }

  // The last day before a crossing: put in if it is short.
  if (lastDayOfAct && contribRes.length && !starving) return contributeNow();

  // Hungry? Go find food.
  if ((me.res.rations || 0) <= 1 && band !== 'boiling') return { kind: 'forage', res: 'rations' };
  if (hotNow && (me.res.water || 0) <= 1 && band !== 'boiling') return { kind: 'forage', res: 'water' };

  // Accuse when the evidence is there.
  if (threat && top && top.score >= accuseThreshold && sc !== 'genesis' && rng.chance(persona.nerve)) {
    return { kind: 'accuse', target: top.id };
  }

  // The crossing.
  if (contribRes.length && rng.chance(lastDayOfAct ? 0.9 : 0.5)) return contributeNow();
  const missing = needs.find((x) => lvl(x) >= 2 && (me.res[x] || 0) === 0);
  if (missing && band !== 'boiling' && rng.chance(0.6)) return { kind: 'forage', res: missing };

  // Gifts for the hungry.
  const hungry = pub.seats.find((s) => s.id !== me.seat && s.hungry);
  if (hungry && (me.res.rations || 0) >= 3 && rng.chance(persona.generosity)) return { kind: 'give', target: hungry.id, res: 'rations', n: 1 };
  if (me.weight >= 11 && rng.chance(0.6)) {
    const res = RES.slice().sort((a, b) => me.res[b] - me.res[a])[0];
    const light = pub.seats.filter((s) => s.id !== me.seat && s.weight === 'light');
    const to = rng.pick(light.length ? light : pub.seats.filter((s) => s.id !== me.seat));
    if (to) return { kind: 'give', target: to.id, res, n: 1 };
  }

  // Powers.
  if (ctx.archetype === 'idealist' && me.assets.conviction && !me.assets.witnessUsed && threat && top && rng.chance(0.5)) return { kind: 'witness', target: top.id };
  if (ctx.archetype === 'broker' && !me.sacrificed && threat && top && rng.chance(0.25)) return { kind: 'peek', target: top.id };
  if (me.assets.crowd > 0 && (band === 'hot' || band === 'boiling') && rng.chance(0.4)) return { kind: 'calm' };
  if (me.assets.crowns > 0 && gauge >= 1 && rng.chance(0.25)) return { kind: 'rally' };
  if (pub.lead == null && rng.chance(0.4)) return { kind: 'claim_lead' };
  if (pub.lead !== me.seat && rng.chance(0.02)) return { kind: 'claim_lead' };
  if (rng.chance(0.08)) return { kind: 'look' };
  return { kind: 'still' };
}

export function actIntents(ctx) {
  const { me, mem, rng, persona } = ctx;
  const L = me.legal;
  if (!L || L.phase !== 'act') return [];
  const pledge = (mem.pledged || []).find((w) => ['contribute', 'still', 'accuse', 'sacrifice'].includes(w.kind));
  const fromPledge = (w) => {
    if (w.kind === 'contribute') return { kind: 'contribute', res: w.res, n: Math.min(w.n, me.res[w.res] || 0) };
    if (w.kind === 'accuse') return { kind: 'accuse', target: w.target };
    if (w.kind === 'sacrifice') return mem.plan && mem.plan.kind === 'sacrifice' ? mem.plan : { kind: 'still' };
    return { kind: 'still' };
  };
  let plan;
  if (persona.standIn) {
    // A stand-in keeps the absent player's word, or keeps still.
    plan = pledge ? fromPledge(pledge) : { kind: 'still' };
  } else if (pledge) {
    const keeps = rng.chance(me.turned ? 0.35 : persona.honesty);
    plan = keeps ? fromPledge(pledge) : (me.turned ? planAction(ctx, false) : { kind: 'still' });
  } else {
    plan = planAction(ctx, false);
  }
  const chosen = fitToLegal(L, plan, me, rng);
  mem.plan = null;
  mem.pledged = [];
  return [{ k: 'act', a: chosen }];
}

function fitToLegal(L, plan, me, rng) {
  const A = plan && L.actions.find((a) => a.kind === plan.kind);
  if (A) {
    const a = { kind: plan.kind };
    if (A.targets) {
      a.target = A.targets.includes(plan.target) ? plan.target : rng.pick(A.targets);
      if (a.target == null) return { kind: 'still' };
    }
    if (A.res) a.res = A.res.includes(plan.res) ? plan.res : A.res[0];
    if (plan.kind === 'contribute' || plan.kind === 'give') {
      const max = A.max ? A.max[a.res] || 0 : me.res[a.res] || 0;
      if (max < 1) return { kind: 'still' };
      a.n = Math.max(1, Math.min(plan.n || 1, max));
    }
    return a;
  }
  return { kind: 'still' };
}

// ---------- vote / prodigal ----------

export function voteIntents(ctx) {
  const { pub, me, mem, rng, skill, persona } = ctx;
  const L = me.legal;
  if (!L || L.phase !== 'vote' || !L.canVote) return [];
  const accused = L.accused;
  const pledged = pub.words.find((w) => w.seat === me.seat && w.kind === 'vote' && w.target === accused);
  if (pledged && rng.chance(persona.honesty)) return [{ k: 'vote', yes: !!pledged.yes }];
  if (persona.standIn) return [{ k: 'vote', yes: false }];
  let yes;
  if (me.turned) yes = rng.chance(0.55);
  else if (mem.turned.includes(accused)) yes = true;
  else if (mem.clean.includes(accused)) yes = false;
  else {
    const s = mem.suspicion[accused] || 0;
    const top = topSuspect(mem, pub, me);
    yes = s >= 1.6 - skill * 0.6 || (top && top.id === accused && s > 0.6);
    if (rng.chance(0.12)) yes = !yes;
  }
  const stake = L.canStake && yes && (mem.turned.includes(accused) || (mem.suspicion[accused] || 0) > 3);
  return [{ k: 'vote', yes, stake }];
}

export function prodigalIntents(ctx) {
  const { pub, me, rng, persona } = ctx;
  if (!pub.prodigal || pub.prodigal.seat !== me.seat || pub.prodigal.choice) return [];
  const confess = rng.chance(0.25 + persona.honesty * 0.6);
  return [{ k: 'prodigal', choice: confess ? 'confess' : 'silent', text: confess ? 'I turned. I’m sorry.' : '' }];
}

export function botIntents(ctx) {
  switch (ctx.pub.phase) {
    case 'talk': return talkIntents(ctx);
    case 'act': return actIntents(ctx);
    case 'vote': return voteIntents(ctx);
    case 'prodigal': return prodigalIntents(ctx);
    default: return [];
  }
}

export function botRngFor(holder) {
  return makeRng(holder, 'botRng');
}

export { LIMITS };
