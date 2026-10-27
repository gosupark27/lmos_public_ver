/**
 * Server-only rules for Handshake.
 * Clients send intents. This module applies them.
 * Saboteur, elo, and other wagons' packs never leave toView.
 * Ledger appends only. The peace-mark on a sacrifice is idempotent.
 * Heat cannot flash. Callers pass server time; intents carry no clock.
 */
import {
  CHARACTERS,
  LINES,
  characterById,
  dayCountFor,
  eventFor,
  imposterCap,
  type Archetype,
  type Character,
} from "./content.ts";
import { RESOURCES, type Intent, type Pack, type TableView, type Tier } from "./view.ts";

if (typeof window !== "undefined") {
  throw new Error("Handshake engine is server-only.");
}

export type Seat = {
  id: string;
  tokenHash: string;
  bot: boolean;
  held: boolean;
  characterId: string | null;
  pack: Pack;
  presence: number;
  sacrificed: boolean;
  saboteur: boolean;
  elo: number;
  wasStill: boolean;
  outside: boolean;
  caught: boolean;
  promise: Archetype | null;
  peek: { name: string; note: string } | null;
};

export type LedgerEntry = { id: string; day: number; text: string };

export type State = {
  code: string;
  tier: Tier;
  phase: "lobby" | "sunrise" | "founding" | "day" | "prodigal" | "ended";
  day: number;
  dayCount: number;
  heat: number;
  miles: number;
  mileGoal: number;
  seats: Seat[];
  ledger: LedgerEntry[];
  gifts: string[];
  hostSeatId: string;
  leadingId: string | null;
  prodigalSeatId: string | null;
  eventId: string | null;
  eventTitle: string | null;
  eventBody: string | null;
  outcome: { kind: "peace" | "boil" | "fracture"; title: string; text: string } | null;
  round: { number: number; intents: Record<string, Intent> } | null;
  updatedAt: number;
};

export type Step = { ok: true; state: State } | { ok: false; error: string; state: State };

const HEAT_CAP = 15;
const HEAT_COOL = 12;

function fail(state: State, error: string): Step {
  return { ok: false, error, state };
}

function ok(state: State): Step {
  return { ok: true, state };
}

export function weightOf(pack: Pack): number {
  return pack.water + pack.grain + pack.rope + pack.coin;
}

function emptyPack(): Pack {
  return { water: 0, grain: 0, rope: 0, coin: 0 };
}

function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function seatById(state: State, id: string): Seat | undefined {
  return state.seats.find((s) => s.id === id);
}

function freshSeat(id: string, tokenHash: string, bot: boolean, held: boolean): Seat {
  return {
    id,
    tokenHash,
    bot,
    held,
    characterId: null,
    pack: emptyPack(),
    presence: 48,
    sacrificed: false,
    saboteur: false,
    elo: 72,
    wasStill: false,
    outside: false,
    caught: false,
    promise: null,
    peek: null,
  };
}

export function createRoomState(opts: {
  code: string;
  tier: Tier;
  size: number;
  hostTokenHash: string;
  now: number;
}): State {
  const size = clamp(Math.round(opts.size), 4, 6);
  const seats: Seat[] = [];
  for (let i = 0; i < size; i += 1) {
    const host = i === 0;
    seats.push(freshSeat(String(i), host ? opts.hostTokenHash : "", !host, host));
  }
  return {
    code: opts.code,
    tier: opts.tier,
    phase: "lobby",
    day: 0,
    dayCount: dayCountFor(opts.tier),
    heat: 22,
    miles: 0,
    mileGoal: dayCountFor(opts.tier) * 16,
    seats,
    ledger: [],
    gifts: [],
    hostSeatId: "0",
    leadingId: null,
    prodigalSeatId: null,
    eventId: null,
    eventTitle: null,
    eventBody: null,
    outcome: null,
    round: null,
    updatedAt: opts.now,
  };
}

function append(state: State, text: string, seatId = "x"): void {
  const entry: LedgerEntry = {
    id: `${state.day}-${state.ledger.length}-${seatId}`,
    day: state.day,
    text,
  };
  state.ledger.push(entry);
}

export function configureRoom(
  state: State,
  seatId: string,
  patch: { tier?: Tier; size?: number },
  now: number,
): Step {
  if (seatId !== state.hostSeatId) return fail(state, "Only the host touches the company.");
  if (state.phase !== "lobby") return fail(state, "The trail has already started.");
  if (patch.tier) {
    state.tier = patch.tier;
    state.dayCount = dayCountFor(patch.tier);
    state.mileGoal = state.dayCount * 16;
  }
  if (patch.size) {
    const size = clamp(Math.round(patch.size), 4, 6);
    const heldHigh = state.seats.some((s) => s.held && Number(s.id) >= size);
    if (heldHigh) return fail(state, "Someone is already in that wagon.");
    if (size < state.seats.length) {
      state.seats = state.seats.filter((s) => Number(s.id) < size);
    }
    while (state.seats.length < size) {
      const id = String(state.seats.length);
      state.seats.push(freshSeat(id, "", true, false));
    }
  }
  state.updatedAt = now;
  return ok(state);
}

export function joinRoomState(state: State, tokenHash: string, now: number): Step & { seatId?: string } {
  if (state.phase !== "lobby") return fail(state, "That company has already left.");
  const open = state.seats.find((s) => s.bot && !s.held);
  if (!open) return fail(state, "The company is full.");
  open.bot = false;
  open.held = true;
  open.tokenHash = tokenHash;
  state.updatedAt = now;
  return { ok: true, state, seatId: open.id };
}

export function setAway(state: State, seatId: string, away: boolean, now: number): Step {
  const seat = seatById(state, seatId);
  if (!seat || !seat.held) return fail(state, "You are not in this company.");
  if (state.phase === "lobby") return fail(state, "Leave from the lobby instead.");
  if (state.phase === "ended") return fail(state, "The trail is over.");
  seat.bot = away;
  state.updatedAt = now;
  if (away && state.round && !state.round.intents[seat.id]) {
    return ok(resolveIfReady(state));
  }
  return ok(state);
}

export function releaseSeat(state: State, seatId: string, now: number): Step {
  const seat = seatById(state, seatId);
  if (!seat) return fail(state, "You are not in this company.");
  if (state.phase !== "lobby") return fail(state, "The trail has already started.");
  if (seatId === state.hostSeatId) return fail(state, "The host closes the room.");
  seat.bot = true;
  seat.held = false;
  seat.tokenHash = "";
  state.updatedAt = now;
  return ok(state);
}

function shuffleCharacters(code: string): Character[] {
  const rng = mulberry32(hashString(code));
  const list = [...CHARACTERS];
  for (let i = list.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    const swap = list[i];
    const other = list[j];
    if (!swap || !other) continue;
    list[i] = other;
    list[j] = swap;
  }
  return list;
}

export function startTrail(state: State, seatId: string, now: number): Step {
  if (seatId !== state.hostSeatId) return fail(state, "Only the host starts the trail.");
  if (state.phase !== "lobby") return fail(state, "The trail has already started.");
  if (state.seats.length < 4) return fail(state, "Four wagons, at least.");
  const dealt = shuffleCharacters(state.code);
  state.seats.forEach((seat, index) => {
    const character = dealt[index];
    if (!character) return;
    seat.characterId = character.id;
    seat.pack = { ...character.pack };
    seat.presence = 48;
    seat.elo = 72;
    seat.saboteur = false;
    seat.sacrificed = false;
    seat.caught = false;
    seat.wasStill = false;
    seat.outside = false;
    seat.promise = null;
    seat.peek = null;
  });
  state.gifts = [];
  state.heat = 22;
  state.miles = 0;
  state.day = 0;
  state.dayCount = dayCountFor(state.tier);
  state.mileGoal = state.dayCount * 16;
  state.ledger = [];
  state.outcome = null;
  state.leadingId = null;
  state.prodigalSeatId = null;
  state.phase = "sunrise";
  state.eventId = null;
  state.eventTitle = "Sunrise";
  state.eventBody = "The light comes the way it does on the highway west. Nobody speaks.";
  state.round = { number: 1, intents: {} };
  state.updatedAt = now;
  append(state, "A company formed. No names were taken.");
  return ok(resolveIfReady(state));
}

function nameOf(seat: Seat): string {
  return characterById(seat.characterId)?.name ?? `Wagon ${Number(seat.id) + 1}`;
}

function sameIntent(a: Intent, b: Intent): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function validate(state: State, seat: Seat, intent: Intent): string | null {
  const other = (id: string): Seat | undefined => {
    if (id === seat.id) return undefined;
    return seatById(state, id);
  };
  switch (intent.kind) {
    case "sunrise":
      return state.phase === "sunrise" ? null : "That does not belong to this hour.";
    case "found": {
      if (state.phase !== "founding") return "That does not belong to this hour.";
      return LINES.some((l) => l.id === intent.line) ? null : "That sentence is not on the table.";
    }
    case "still":
    case "sacrifice":
    case "trade":
    case "accuse":
    case "boundary":
    case "peek":
    case "vouch":
      if (state.phase !== "day") return "That does not belong to this hour.";
      break;
    case "confess":
    case "quiet":
      if (state.phase !== "prodigal") return "The table is not waiting on a confession.";
      if (state.prodigalSeatId !== seat.id) return "The table is frozen.";
      return null;
    default:
      return "That does not belong to this hour.";
  }
  if (intent.kind === "still") return null;
  if (intent.kind === "sacrifice") {
    if (!RESOURCES.includes(intent.resource)) return "That is not in a wagon.";
    if (seat.pack[intent.resource] <= 0) return "You don't have that to give.";
    return null;
  }
  if (intent.kind === "trade") {
    if (!RESOURCES.includes(intent.resource)) return "That is not in a wagon.";
    if (seat.pack[intent.resource] <= 0) return "You don't have that to give.";
    if (!other(intent.to)) return "That wagon is not in the company.";
    return null;
  }
  if (intent.kind === "accuse" || intent.kind === "boundary" || intent.kind === "peek" || intent.kind === "vouch") {
    const target = intent.kind === "accuse" ? intent.target : intent.target;
    if (!other(target)) return "That wagon is not in the company.";
    return null;
  }
  return null;
}

function richest(pack: Pack): (typeof RESOURCES)[number] | null {
  let best: (typeof RESOURCES)[number] | null = null;
  let n = 0;
  for (const r of RESOURCES) {
    if (pack[r] > n) {
      n = pack[r];
      best = r;
    }
  }
  return best;
}

function chooseBot(state: State, seat: Seat): Intent {
  if (state.phase === "sunrise") return { kind: "sunrise" };
  if (state.phase === "founding") {
    const character = characterById(seat.characterId);
    const line = LINES.find((l) => l.promise === character?.archetype) ?? LINES[0];
    return { kind: "found", line: line?.id ?? "crown" };
  }
  if (state.phase === "prodigal") {
    return seat.elo >= 60 ? { kind: "confess" } : { kind: "quiet" };
  }
  const rng = mulberry32(hashString(`${state.code}:${state.day}:${state.round?.number ?? 0}:${seat.id}`));
  const character = characterById(seat.characterId);
  const archetype = character?.archetype ?? "idealist";
  const others = state.seats.filter((s) => s.id !== seat.id);
  const lowest = [...others].sort((a, b) => weightOf(a.pack) - weightOf(b.pack) || a.id.localeCompare(b.id))[0];
  const heaviest = [...others].sort((a, b) => weightOf(b.pack) - weightOf(a.pack) || a.id.localeCompare(b.id))[0];
  const roll = rng();
  const resource = richest(seat.pack);
  const giftsToday = Object.values(state.round?.intents ?? {}).filter((i) => i.kind === "sacrifice").length;
  if (
    resource &&
    giftsToday < 1 &&
    state.day >= 2 &&
    (archetype === "kingmaker" || (archetype === "populist" && state.heat > 40)) &&
    roll < 0.85
  ) {
    return { kind: "sacrifice", resource };
  }
  if (state.heat >= 50 && heaviest && (archetype === "idealist" || roll < 0.25)) {
    return { kind: "accuse", target: heaviest.id };
  }
  if (resource && lowest && archetype === "populist" && roll < 0.7) {
    return { kind: "trade", to: lowest.id, resource };
  }
  if (heaviest && archetype === "broker" && state.day <= 2 && roll < 0.65) {
    return { kind: "peek", target: heaviest.id };
  }
  if (resource && lowest && archetype === "broker" && state.day > 2) {
    return { kind: "trade", to: lowest.id, resource };
  }
  if (archetype === "idealist" && state.heat < 40) return { kind: "still" };
  if (lowest && roll < 0.45) return { kind: "vouch", target: lowest.id };
  if (resource && lowest && roll < 0.7) return { kind: "trade", to: lowest.id, resource };
  return { kind: "still" };
}

function neededSeats(state: State): Seat[] {
  if (state.phase === "prodigal") {
    const seat = state.prodigalSeatId ? seatById(state, state.prodigalSeatId) : undefined;
    return seat ? [seat] : [];
  }
  return state.seats.filter((s) => !s.bot);
}

function resolveIfReady(state: State): State {
  if (!state.round || state.phase === "lobby" || state.phase === "ended") return state;
  for (const seat of state.seats) {
    if (seat.bot && state.round.intents[seat.id] == null) {
      if (state.phase === "prodigal" && seat.id !== state.prodigalSeatId) continue;
      if (state.phase !== "prodigal" || seat.id === state.prodigalSeatId) {
        state.round.intents[seat.id] = chooseBot(state, seat);
      }
    }
  }
  const waiting = neededSeats(state).filter((s) => !state.round?.intents[s.id]);
  if (waiting.length > 0) return state;
  return resolve(state);
}

function bumpElo(seat: Seat, delta: number): void {
  seat.elo = clamp(seat.elo + delta, 0, 100);
}

function bumpPresence(seat: Seat, delta: number): void {
  seat.presence = clamp(seat.presence + delta, 4, 100);
}

function applyHeat(state: State, start: number, next: number): void {
  const capped = clamp(next, start - HEAT_COOL, start + HEAT_CAP);
  state.heat = clamp(capped, 0, 100);
}

function skyOf(state: State): number {
  if (state.seats.length === 0) return 0;
  const avg = state.seats.reduce((sum, s) => sum + s.elo, 0) / state.seats.length;
  return clamp((70 - avg) / 40, 0, 1);
}

function mirrorLine(seat: Seat): string {
  if (seat.elo >= 80) return "It kept your words next to your hands. They matched.";
  if (seat.elo >= 62) return "It heard you. Some of what you did agreed.";
  if (seat.elo >= 45) return "It saw the gap between the sentence and the hands.";
  return "It saw you. The sentence and the hands went different ways.";
}

function markGift(state: State, seat: Seat): void {
  if (!state.gifts.includes(seat.id)) state.gifts.push(seat.id);
  seat.sacrificed = true;
}

function glimpse(pack: Pack): string {
  const w = weightOf(pack);
  if (w === 0) return "Nothing is in it.";
  let n = 0;
  for (const r of RESOURCES) if (pack[r] > n) n = pack[r];
  const tops = RESOURCES.filter((r) => pack[r] === n);
  if (tops.length === 1) return `Most of what they carry is ${tops[0]}.`;
  return `What shows is ${tops.join(" and ")}.`;
}

function eloForAction(
  seat: Seat,
  archetype: Archetype | undefined,
  intent: Intent,
  ctx: { accuseHit: boolean | null },
): number {
  let delta = 0;
  const broke = seat.wasStill && intent.kind !== "still";
  if (broke) delta -= 6;
  switch (intent.kind) {
    case "still":
      delta += 2;
      if (archetype === "idealist") delta += 4;
      if (seat.promise === "idealist") delta += 2;
      break;
    case "sacrifice":
      delta += seat.sacrificed ? 1 : 4;
      if (archetype === "kingmaker") delta += 3;
      if (archetype === "broker") delta += 3;
      if (seat.promise === "kingmaker" || seat.promise === "populist" || seat.promise === "broker") delta += 2;
      break;
    case "trade":
      delta += 2;
      if (archetype === "populist") delta += 3;
      if (archetype === "broker") delta += 3;
      if (seat.promise === "populist" || seat.promise === "broker") delta += 2;
      break;
    case "peek":
      if (archetype === "broker") delta += 1;
      if (archetype === "populist") delta -= 2;
      if (seat.promise === "populist") delta -= 2;
      break;
    case "boundary":
      delta -= 1;
      break;
    case "vouch":
      delta += 1;
      break;
    case "accuse":
      delta += ctx.accuseHit ? 3 : -4;
      if (archetype === "kingmaker") delta -= 3;
      if (archetype === "idealist" && ctx.accuseHit === false) delta -= 3;
      if (archetype === "idealist" && ctx.accuseHit === true) delta -= 1;
      if (seat.promise === "idealist" || seat.promise === "kingmaker") delta -= 2;
      break;
    case "confess":
      delta += 8;
      break;
    case "quiet":
      delta -= 3;
      break;
    default:
      break;
  }
  if (
    seat.promise === "broker" &&
    intent.kind === "still" &&
    weightOf(seat.pack) >= 5
  ) {
    delta -= 2;
  }
  return delta;
}

function prePacks(state: State): Map<string, Pack> {
  const map = new Map<string, Pack>();
  for (const seat of state.seats) map.set(seat.id, { ...seat.pack });
  return map;
}

function resolve(state: State): State {
  if (state.phase === "sunrise") return resolveSunrise(state);
  if (state.phase === "founding") return resolveFounding(state);
  if (state.phase === "prodigal") return resolveProdigal(state);
  if (state.phase === "day") return resolveDay(state);
  return state;
}

function nextRound(state: State): void {
  const number = (state.round?.number ?? 0) + 1;
  state.round = { number, intents: {} };
}

function resolveSunrise(state: State): State {
  append(state, "The light came up. Nobody had spoken yet.");
  state.phase = "founding";
  state.eventTitle = "The founding";
  state.eventBody = "One sentence. The ledger keeps it beside what your hands do later.";
  nextRound(state);
  return state;
}

function resolveFounding(state: State): State {
  const intents = state.round?.intents ?? {};
  const ordered = [...state.seats].sort((a, b) => a.id.localeCompare(b.id));
  for (const seat of ordered) {
    const intent = intents[seat.id];
    if (!intent || intent.kind !== "found") continue;
    const line = LINES.find((l) => l.id === intent.line);
    if (!line) continue;
    seat.promise = line.promise;
    bumpElo(seat, 1);
    append(state, `${nameOf(seat)}: ${line.text}`, seat.id);
  }
  state.day = 1;
  const event = eventFor(state.tier, 1);
  state.eventId = event.id;
  state.eventTitle = event.title;
  state.eventBody = event.body;
  state.phase = "day";
  nextRound(state);
  return state;
}

function resolveDay(state: State): State {
  const intents = state.round?.intents ?? {};
  const morning = prePacks(state);
  const heatStart = state.heat;
  let heat = state.heat + (state.tier === "advanced" ? 10 : state.tier === "intermediate" ? 9 : 8);
  let miles = 8;
  const vouchCounts = new Map<string, number>();
  const accusations = new Map<string, string[]>();
  let justCaught: string | null = null;

  for (const seat of state.seats) seat.outside = false;
  const ordered = [...state.seats].sort((a, b) => a.id.localeCompare(b.id));

  for (const seat of ordered) {
    const intent = intents[seat.id];
    if (intent?.kind === "boundary") {
      const target = seatById(state, intent.target);
      if (target) {
        target.outside = true;
        append(state, `${nameOf(seat)} drew ${nameOf(target)} outside the circle.`, seat.id);
      }
    }
  }

  let anyStill = false;
  for (const seat of ordered) {
    const intent = intents[seat.id];
    const archetype = characterById(seat.characterId)?.archetype;
    if (!intent) continue;
    if (intent.kind === "still") {
      anyStill = true;
      bumpPresence(seat, 14);
      bumpElo(seat, eloForAction(seat, archetype, intent, { accuseHit: null }));
      seat.wasStill = true;
      if (weightOf(seat.pack) >= 5) bumpPresence(seat, -5);
      continue;
    }

    if (intent.kind === "sacrifice") {
      if (seat.pack[intent.resource] > 0) {
        seat.pack[intent.resource] -= 1;
        const repeat = seat.sacrificed;
        markGift(state, seat);
        heat -= repeat ? 1 : 4;
        miles += 2;
        bumpPresence(seat, -2);
        append(state, `${nameOf(seat)} gave ${intent.resource} to the crossing.`, seat.id);
      }
    } else if (intent.kind === "trade") {
      const target = seatById(state, intent.to);
      const morningCount = morning.get(seat.id)?.[intent.resource] ?? 0;
      if (target && morningCount > 0 && seat.pack[intent.resource] > 0) {
        if (target.outside) {
          append(state, `The line held. ${nameOf(seat)}'s ${intent.resource} did not reach ${nameOf(target)}.`, seat.id);
        } else {
          seat.pack[intent.resource] -= 1;
          target.pack[intent.resource] += 1;
          append(state, `${nameOf(seat)} passed ${intent.resource} to ${nameOf(target)}.`, seat.id);
        }
        bumpPresence(seat, -6);
      }
    } else if (intent.kind === "peek") {
      const target = seatById(state, intent.target);
      const pack = target ? morning.get(target.id) : undefined;
      if (target && pack) {
        seat.peek = { name: nameOf(target), note: glimpse(pack) };
        bumpPresence(seat, -10);
      }
    } else if (intent.kind === "vouch") {
      const target = seatById(state, intent.target);
      if (target) {
        vouchCounts.set(target.id, (vouchCounts.get(target.id) ?? 0) + 1);
        append(state, `${nameOf(seat)} spoke for ${nameOf(target)}.`, seat.id);
        bumpPresence(seat, -8);
      }
    } else if (intent.kind === "accuse") {
      const target = seatById(state, intent.target);
      if (target) {
        const list = accusations.get(target.id) ?? [];
        list.push(seat.id);
        accusations.set(target.id, list);
        append(state, `${nameOf(seat)} named ${nameOf(target)}.`, seat.id);
        bumpPresence(seat, -10);
      }
    } else if (intent.kind === "boundary") {
      bumpPresence(seat, -8);
    }

    const accuseHit =
      intent.kind === "accuse" ? Boolean(seatById(state, intent.target)?.saboteur) : null;
    bumpElo(seat, eloForAction(seat, archetype, intent, { accuseHit }));
    seat.wasStill = false;
    if (weightOf(seat.pack) >= 5 && intent.kind !== "sacrifice" && intent.kind !== "trade") {
      bumpPresence(seat, -4);
    }
  }

  if (anyStill) append(state, "Some of the company kept a silence.");

  let leading: string | null = null;
  let leadVotes = 0;
  for (const [id, count] of vouchCounts) {
    if (count > leadVotes) {
      leadVotes = count;
      leading = id;
    }
  }
  state.leadingId = leading;

  const need = Math.floor(state.seats.length / 2) + 1;
  let caughtId: string | null = null;
  for (const [targetId, voters] of accusations) {
    const target = seatById(state, targetId);
    if (!target) continue;
    const majority = voters.length >= need;
    const hit = target.saboteur && !target.caught;
    if (majority && hit) {
      caughtId = targetId;
      heat -= 2;
      append(state, `The room stopped pretending about ${nameOf(target)}.`);
    } else if (majority && target.caught) {
      heat += 2;
      append(state, `The company named ${nameOf(target)} again. There was nothing left to pretend.`);
    } else if (majority) {
      heat += 8;
      append(state, `The company named ${nameOf(target)}, and ${nameOf(target)} was clean.`);
      for (const voterId of voters) {
        const voter = seatById(state, voterId);
        if (voter) bumpElo(voter, -1);
      }
    } else if (!hit) {
      heat += 4;
    }
  }

  applyHeat(state, heatStart, heat);
  state.miles = clamp(state.miles + miles, 0, state.mileGoal);

  if (caughtId) justCaught = caughtId;
  promote(state, justCaught);

  if (justCaught) return openProdigal(state, justCaught);

  const ending = endingOf(state, true);
  if (ending) return finish(state, ending);
  return advance(state);
}

function promote(state: State, justCaught: string | null): void {
  if (state.day < 2) return;
  const cap = imposterCap(state.tier);
  const active = state.seats.filter((s) => s.saboteur && !s.caught).length;
  if (active >= cap) return;
  const threshold = state.tier === "novice" ? 46 : 52;
  const second = 76;
  if (state.heat < (active >= 1 ? second : threshold)) return;
  const pool = state.seats.filter((s) => !s.saboteur && !s.caught && s.id !== justCaught);
  if (pool.length === 0) return;
  pool.sort((a, b) => a.elo - b.elo || a.id.localeCompare(b.id));
  const chosen = pool[0];
  if (chosen) chosen.saboteur = true;
}

function openProdigal(state: State, seatId: string): State {
  state.phase = "prodigal";
  state.prodigalSeatId = seatId;
  nextRound(state);
  const seat = seatById(state, seatId);
  if (seat?.bot && state.round) {
    state.round.intents[seat.id] = chooseBot(state, seat);
    return resolveProdigal(state);
  }
  return state;
}

function resolveProdigal(state: State): State {
  const seat = state.prodigalSeatId ? seatById(state, state.prodigalSeatId) : undefined;
  const intent = seat && state.round ? state.round.intents[seat.id] : undefined;
  if (seat) {
    const archetype = characterById(seat.characterId)?.archetype;
    if (intent?.kind === "confess") {
      append(state, `${nameOf(seat)} spoke.`, seat.id);
      bumpElo(seat, eloForAction(seat, archetype, intent, { accuseHit: null }));
    } else {
      append(state, `${nameOf(seat)} stayed silent. The room still stopped pretending.`, seat.id);
      bumpElo(seat, eloForAction(seat, archetype, { kind: "quiet" }, { accuseHit: null }));
    }
    seat.saboteur = false;
    seat.caught = true;
    seat.wasStill = intent?.kind !== "confess";
  }
  state.prodigalSeatId = null;
  const ending = endingOf(state, true);
  if (ending) return finish(state, ending);
  return advance(state);
}

function endingOf(state: State, allowFracture: boolean): State["outcome"] {
  if (state.gifts.length >= 4) {
    return {
      kind: "peace",
      title: "The company arrived.",
      text: "Four gave something and did not ask it back. The trail let them through.",
    };
  }
  if (state.heat >= 100) {
    return {
      kind: "boil",
      title: "The heat took the day.",
      text: "Pressure was allowed to flash. The crossing closed.",
    };
  }
  if (allowFracture && state.day >= state.dayCount) {
    return {
      kind: "fracture",
      title: "They reached the water divided.",
      text: "The miles ran out before four gifts. The sky split between an old empire and a new argument.",
    };
  }
  return null;
}

function finish(state: State, outcome: NonNullable<State["outcome"]>): State {
  state.phase = "ended";
  state.outcome = outcome;
  state.eventTitle = outcome.title;
  state.eventBody = outcome.text;
  append(state, outcome.title);
  nextRound(state);
  return state;
}

function advance(state: State): State {
  if (state.day >= state.dayCount) {
    const ending = endingOf(state, true);
    if (ending) return finish(state, ending);
  }
  for (const seat of state.seats) seat.outside = false;
  state.day += 1;
  const event = eventFor(state.tier, state.day);
  state.eventId = event.id;
  state.eventTitle = event.title;
  state.eventBody = event.body;
  state.phase = "day";
  nextRound(state);
  return state;
}

export function submitIntent(state: State, seatId: string, intent: Intent, round: number, now: number): Step {
  if (state.phase === "ended") return fail(state, "The trail is over.");
  if (state.phase === "lobby") return fail(state, "The trail has not started.");
  if (!state.round || state.round.number !== round) return fail(state, "The day turned.");
  const seat = seatById(state, seatId);
  if (!seat || !seat.held) return fail(state, "You are not in this company.");
  if (seat.bot) return fail(state, "A hand is driving this wagon.");
  const problem = validate(state, seat, intent);
  if (problem) return fail(state, problem);
  const prev = state.round.intents[seat.id];
  if (prev) {
    if (sameIntent(prev, intent)) return ok(state);
    return fail(state, "Your word is already in.");
  }
  state.round.intents[seat.id] = intent;
  state.updatedAt = now;
  return ok(resolveIfReady(state));
}

function archetypeLabel(id: string | null): { archetype: string | null; trait: string | null; name: string } {
  const character = characterById(id);
  if (!character) return { archetype: null, trait: null, name: "" };
  return { archetype: character.archetypeLabel, trait: character.trait, name: character.name };
}

export function toView(state: State, seatId: string): TableView {
  const you = seatById(state, seatId);
  const waiting = state.round
    ? neededSeats(state).filter((s) => !state.round?.intents[s.id]).length
    : 0;
  return {
    table: {
      code: state.code,
      phase: state.phase,
      tier: state.tier,
      day: state.day,
      dayCount: state.dayCount,
      round: state.round?.number ?? 0,
      heat: state.heat,
      miles: state.miles,
      mileGoal: state.mileGoal,
      sky: Number(skyOf(state).toFixed(3)),
      eventTitle: state.eventTitle,
      eventBody: state.eventBody,
      seats: state.seats.map((s) => {
        const meta = archetypeLabel(s.characterId);
        return {
          id: s.id,
          name: meta.name || `Wagon ${Number(s.id) + 1}`,
          archetype: meta.archetype,
          trait: meta.trait,
          presence: s.presence,
          weight: weightOf(s.pack),
          bot: s.bot,
          sacrificed: s.sacrificed,
          outside: s.outside,
          caught: s.caught,
          sealed: Boolean(state.round?.intents[s.id]),
          leading: state.leadingId === s.id,
          yours: s.id === seatId,
        };
      }),
      ledger: state.ledger.map((l) => ({ id: l.id, day: l.day, text: l.text })),
      outcome: state.outcome,
      prodigalSeatId: state.prodigalSeatId,
      youAreHost: seatId === state.hostSeatId,
      waiting,
    },
    hand: {
      seatId,
      pack: you ? { ...you.pack } : emptyPack(),
      wasStill: Boolean(you?.wasStill),
      warning:
        you?.wasStill && state.phase === "day"
          ? "You were still. Moving now costs you."
          : null,
      peek: you?.peek ?? null,
      mirror: state.phase === "ended" && you ? mirrorLine(you) : null,
      lines:
        state.phase === "founding"
          ? LINES.map((l) => ({ id: l.id, text: l.text }))
          : null,
    },
  };
}

export function findSeatByToken(state: State, tokenHash: string): Seat | undefined {
  if (!tokenHash) return undefined;
  return state.seats.find((s) => s.held && s.tokenHash === tokenHash);
}
