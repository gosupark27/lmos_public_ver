import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createRoomState,
  startTrail,
  submitIntent,
  toView,
  type Seat,
  type State,
} from "./engine.server.ts";
import type { Intent, Resource } from "./view.ts";

function boot(): State {
  const created = createRoomState({
    code: "TRAIL1",
    tier: "novice",
    size: 5,
    hostTokenHash: "host",
    now: 1,
  });
  const started = startTrail(created, "0", 2);
  assert.equal(started.ok, true);
  let state = started.state;
  const sunrise = submitIntent(state, "0", { kind: "sunrise" }, state.round?.number ?? 0, 3);
  assert.equal(sunrise.ok, true);
  state = sunrise.state;
  assert.equal(state.phase, "founding");
  const found = submitIntent(state, "0", { kind: "found", line: "crown" }, state.round?.number ?? 0, 4);
  assert.equal(found.ok, true);
  state = found.state;
  assert.equal(state.phase, "day");
  assert.equal(state.day, 1);
  return state;
}

function humans(state: State): void {
  for (const seat of state.seats) {
    seat.bot = false;
    seat.held = true;
  }
}

function play(state: State, bySeat: Record<string, Intent>, now = 10): State {
  humans(state);
  let next = state;
  for (const seat of next.seats) {
    const intent = bySeat[seat.id] ?? { kind: "still" as const };
    const step = submitIntent(next, seat.id, intent, next.round?.number ?? 0, now);
    assert.equal(step.ok, true, step.ok ? "" : step.error);
    next = step.state;
  }
  return next;
}

function weightOfPack(seat: Seat): number {
  return seat.pack.water + seat.pack.grain + seat.pack.rope + seat.pack.coin;
}

function giftOf(seat: Seat): Intent {
  const resource = (["water", "grain", "rope", "coin"] as const).find((r) => seat.pack[r] > 0);
  if (!resource) throw new Error("empty wagon");
  return { kind: "sacrifice", resource };
}

function bannedKeys(value: unknown, ban: string[], path = ""): void {
  if (Array.isArray(value)) {
    value.forEach((item, i) => bannedKeys(item, ban, `${path}[${i}]`));
    return;
  }
  if (value && typeof value === "object") {
    for (const key of Object.keys(value)) {
      assert.equal(ban.includes(key), false, `${path}.${key}`);
      bannedKeys((value as Record<string, unknown>)[key], ban, `${path}.${key}`);
    }
  }
}

describe("handshake engine", () => {
  it("keeps the peace-mark idempotent and spends the resource twice", () => {
    let state = boot();
    const seat = state.seats.find((s) => Object.values(s.pack).some((n) => n >= 2));
    assert.ok(seat);
    const resource = (Object.entries(seat.pack).find(([, n]) => n >= 2)?.[0] ?? "water") as Resource;
    const before = seat.pack[resource];
    state = play(state, { [seat.id]: { kind: "sacrifice", resource } });
    assert.equal(state.gifts.length, 1);
    assert.equal(state.phase, "day");
    const again = state.seats.find((s) => s.id === seat.id);
    assert.ok(again);
    assert.equal(again.sacrificed, true);
    assert.equal(again.pack[resource], before - 1);
    state = play(state, { [seat.id]: { kind: "sacrifice", resource } });
    const after = state.seats.find((s) => s.id === seat.id);
    assert.ok(after);
    assert.equal(state.gifts.length, 1);
    assert.equal(after.pack[resource], before - 2);
  });

  it("opens the prodigal seat only on a true majority", () => {
    let state = boot();
    const target = state.seats[2];
    assert.ok(target);
    target.saboteur = true;
    const accusers = state.seats.filter((s) => s.id !== target.id).slice(0, 3);
    const intents: Record<string, Intent> = {};
    for (const seat of accusers) intents[seat.id] = { kind: "accuse", target: target.id };
    state = play(state, intents);
    assert.equal(state.phase, "prodigal");
    assert.equal(state.prodigalSeatId, target.id);
    const text = state.ledger.map((l) => l.text).join("\n");
    assert.doesNotMatch(text, /saboteur|promoted|imposter|elo/i);
    const confess = submitIntent(
      state,
      target.id,
      { kind: "confess" },
      state.round?.number ?? 0,
      20,
    );
    assert.equal(confess.ok, true);
    const caught = confess.state.seats.find((s) => s.id === target.id);
    assert.equal(caught?.saboteur, false);
    assert.equal(caught?.caught, true);
    assert.equal(confess.state.prodigalSeatId, null);
  });

  it("does not catch a clean wagon", () => {
    let state = boot();
    const target = state.seats[1];
    assert.ok(target);
    assert.equal(target.saboteur, false);
    const accusers = state.seats.filter((s) => s.id !== target.id).slice(0, 3);
    const intents: Record<string, Intent> = {};
    for (const seat of accusers) intents[seat.id] = { kind: "accuse", target: target.id };
    const heat = state.heat;
    state = play(state, intents);
    assert.notEqual(state.phase, "prodigal");
    assert.equal(state.prodigalSeatId, null);
    assert.ok(state.heat <= heat + 15);
    assert.match(state.ledger.map((l) => l.text).join("\n"), /was clean/);
  });

  it("keeps a look private and caps the day's heat", () => {
    let state = boot();
    const heat = state.heat;
    state = play(state, {
      "0": { kind: "peek", target: "1" },
      "1": { kind: "accuse", target: "2" },
      "2": { kind: "accuse", target: "3" },
    });
    const joined = state.ledger.map((l) => l.text).join("\n");
    assert.doesNotMatch(joined, /Most of what|What shows|Nothing is in it/);
    const viewer = toView(state, "0");
    assert.ok(viewer.hand.peek);
    const other = toView(state, "1");
    assert.equal(other.hand.peek, null);
    assert.ok(state.heat - heat <= 15);
  });

  it("ships no secret truth", () => {
    let state = boot();
    state.seats[4]!.elo = 10;
    state.heat = 80;
    state.day = 3;
    state = play(state, {});
    const promoted = state.seats.filter((s) => s.saboteur);
    assert.equal(promoted.length, 1);
    assert.equal(promoted[0]?.id, "4");
    const view = toView(state, "0");
    bannedKeys(view, ["elo", "saboteur", "tokenHash", "promise", "token"]);
    assert.equal(JSON.stringify(view).includes("tokenHash"), false);
    const packs = state.seats.filter((s) => s.id !== "0").map((s) => s.pack);
    assert.equal(JSON.stringify(view.hand.pack) === JSON.stringify(packs[0]), false);
  });

  it("rejects a second, different intent and accepts the same one", () => {
    const state = boot();
    humans(state);
    const round = state.round?.number ?? 0;
    const pack = state.seats[0]?.pack.water ?? 0;
    const first = submitIntent(state, "0", { kind: "still" }, round, 5);
    assert.equal(first.ok, true);
    const second = submitIntent(first.state, "0", { kind: "sacrifice", resource: "water" }, round, 6);
    assert.equal(second.ok, false);
    assert.equal(second.state.seats[0]?.pack.water, pack);
    const again = submitIntent(first.state, "0", { kind: "still" }, round, 7);
    assert.equal(again.ok, true);
    assert.equal(again.state.round?.intents["0"]?.kind, "still");
  });

  it("holds a trade at the line and never rewrites the ledger", () => {
    let state = boot();
    const giver = state.seats.find((s) => s.id !== "0" && s.id !== "1" && weightOfPack(s) > 0);
    assert.ok(giver);
    const resource = (["water", "grain", "rope", "coin"] as const).find((r) => giver.pack[r] > 0);
    assert.ok(resource);
    const before = state.seats[1]?.pack[resource] ?? 0;
    const ledgerHead = "A company formed. No names were taken.";
    state = play(state, {
      "0": { kind: "boundary", target: "1" },
      [giver.id]: { kind: "trade", to: "1", resource },
    });
    assert.equal(state.seats[1]?.pack[resource], before);
    assert.match(state.ledger.map((l) => l.text).join("\n"), /line held/i);
    assert.equal(state.ledger[0]?.text, ledgerHead);
    const previous = state.ledger.map((l) => l.text);
    const later = play(state, {});
    previous.forEach((text, i) => assert.equal(later.ledger[i]?.text, text));
    assert.ok(later.ledger.length >= previous.length);
  });

  it("ends in peace on four independent gifts and ignores a stale round", () => {
    let state = boot();
    const intents: Record<string, Intent> = {};
    for (const seat of state.seats.slice(0, 4)) intents[seat.id] = giftOf(seat);
    const round = state.round?.number ?? 0;
    state = play(state, intents);
    assert.equal(state.phase, "ended");
    assert.equal(state.outcome?.kind, "peace");
    assert.equal(state.gifts.length, 4);
    const stale = submitIntent(state, "0", { kind: "still" }, round, 30);
    assert.equal(stale.ok, false);
  });

  it("stores server time and never reads a clock off the intent", () => {
    const state = boot();
    humans(state);
    const step = submitIntent(state, "0", { kind: "still" }, state.round?.number ?? 0, 12345);
    assert.equal(step.ok, true);
    assert.equal(step.state.updatedAt, 12345);
    assert.equal("time" in (step.state.round?.intents["0"] ?? {}), false);
  });
});
