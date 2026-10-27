import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServerFn } from "@tanstack/react-start";
import { getSql } from "@/lib/db";
import {
  configureRoom,
  createRoomState,
  findSeatByToken,
  joinRoomState,
  releaseSeat,
  setAway,
  startTrail,
  submitIntent,
  toView,
  type State,
} from "./engine.server.ts";
import type { ApiResult, Intent, Tier } from "./view.ts";
import { RESOURCES } from "./view.ts";

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function newToken(): string {
  return randomBytes(18).toString("base64url");
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function tokenMatches(token: string, hash: string): boolean {
  const got = hashToken(token);
  if (got.length !== hash.length) return false;
  return timingSafeEqual(Buffer.from(got), Buffer.from(hash));
}

function makeCode(): string {
  const bytes = randomBytes(6);
  let code = "";
  for (const byte of bytes) code += ALPHABET[byte % ALPHABET.length];
  return code;
}

function normalizeCode(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
}

function parseTier(value: unknown): Tier {
  if (value === "novice" || value === "intermediate" || value === "advanced") return value;
  throw new Error("Pick a trail.");
}

function parseSize(value: unknown): number {
  if (value === 4 || value === 5 || value === 6) return value;
  throw new Error("Company size is 4, 5, or 6.");
}

function cleanIntent(raw: unknown): Intent {
  if (!raw || typeof raw !== "object") throw new Error("Bad request.");
  const kind = (raw as { kind?: unknown }).kind;
  const rec = raw as Record<string, unknown>;
  switch (kind) {
    case "sunrise":
    case "still":
    case "confess":
    case "quiet":
      return { kind };
    case "found":
      if (typeof rec.line !== "string") throw new Error("Bad request.");
      return { kind: "found", line: rec.line };
    case "sacrifice":
      if (!isResource(rec.resource)) throw new Error("Bad request.");
      return { kind: "sacrifice", resource: rec.resource };
    case "trade":
      if (!isResource(rec.resource) || typeof rec.to !== "string") throw new Error("Bad request.");
      return { kind: "trade", to: rec.to, resource: rec.resource };
    case "accuse":
    case "boundary":
    case "peek":
    case "vouch":
      if (typeof rec.target !== "string") throw new Error("Bad request.");
      return { kind, target: rec.target };
    default:
      throw new Error("Bad request.");
  }
}

function isResource(value: unknown): value is (typeof RESOURCES)[number] {
  return typeof value === "string" && (RESOURCES as readonly string[]).includes(value);
}

type Row = { version: number; state: string | State };

function readState(raw: string | State): State {
  if (typeof raw === "string") return JSON.parse(raw) as State;
  return raw;
}

async function load(code: string): Promise<{ version: number; state: State } | null> {
  const sql = await getSql();
  const rows = await sql<Row>`select version, state from rooms where code = ${code}`;
  const row = rows[0];
  if (!row) return null;
  return { version: Number(row.version), state: readState(row.state) };
}

async function save(code: string, version: number, state: State): Promise<boolean> {
  const sql = await getSql();
  const rows = await sql<{ code: string }>`
    update rooms
    set state = ${JSON.stringify(state)}, version = ${version + 1}, updated_at = now()
    where code = ${code} and version = ${version}
    returning code
  `;
  return rows.length > 0;
}

function seatFromToken(state: State, token: string) {
  const hash = hashToken(token);
  const seat = findSeatByToken(state, hash);
  if (!seat || !tokenMatches(token, seat.tokenHash)) return undefined;
  return seat;
}

async function mutate(
  code: string,
  token: string,
  fn: (state: State, seatId: string, now: number) => { ok: true; state: State } | { ok: false; error: string; state: State },
): Promise<ApiResult> {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const loaded = await load(code);
    if (!loaded) return { ok: false, error: "No company is using that code." };
    const seat = seatFromToken(loaded.state, token);
    if (!seat) return { ok: false, error: "You are not in this company." };
    const now = Date.now();
    const step = fn(loaded.state, seat.id, now);
    if (!step.ok) return { ok: false, error: step.error };
    const wrote = await save(code, loaded.version, step.state);
    if (!wrote) continue;
    return { ok: true, view: toView(step.state, seat.id) };
  }
  return { ok: false, error: "The trail moved. Try once more." };
}

export const createRoom = createServerFn({ method: "POST" })
  .validator((data: unknown) => {
    const rec = (data ?? {}) as Record<string, unknown>;
    return { tier: parseTier(rec.tier), size: parseSize(rec.size) };
  })
  .handler(async ({ data }): Promise<ApiResult> => {
    try {
      const token = newToken();
      const now = Date.now();
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const code = makeCode();
        const state = createRoomState({
          code,
          tier: data.tier,
          size: data.size,
          hostTokenHash: hashToken(token),
          now,
        });
        const sql = await getSql();
        try {
          await sql`
            insert into rooms (code, version, state)
            values (${code}, ${1}, ${JSON.stringify(state)})
          `;
        } catch {
          continue;
        }
        return { ok: true, token, view: toView(state, "0") };
      }
      return { ok: false, error: "Couldn't open a room." };
    } catch (err) {
      console.error(err);
      return { ok: false, error: "The trail couldn't be reached." };
    }
  });

export const joinRoom = createServerFn({ method: "POST" })
  .validator((data: unknown) => {
    const rec = (data ?? {}) as Record<string, unknown>;
    const code = normalizeCode(rec.code);
    if (!/^[A-Z0-9]{4,8}$/.test(code)) throw new Error("That code is not a room.");
    return { code };
  })
  .handler(async ({ data }): Promise<ApiResult> => {
    try {
      const token = newToken();
      const hash = hashToken(token);
      for (let attempt = 0; attempt < 6; attempt += 1) {
        const loaded = await load(data.code);
        if (!loaded) return { ok: false, error: "No company is using that code." };
        const now = Date.now();
        const step = joinRoomState(loaded.state, hash, now);
        if (!step.ok) return { ok: false, error: step.error };
        if (!step.seatId) return { ok: false, error: "The company is full." };
        const wrote = await save(data.code, loaded.version, step.state);
        if (!wrote) continue;
        return { ok: true, token, view: toView(step.state, step.seatId) };
      }
      return { ok: false, error: "The trail moved. Try once more." };
    } catch (err) {
      console.error(err);
      return { ok: false, error: "The trail couldn't be reached." };
    }
  });

function parseSeat(data: unknown): { code: string; token: string } {
  const rec = (data ?? {}) as Record<string, unknown>;
  const code = normalizeCode(rec.code);
  const token = typeof rec.token === "string" ? rec.token : "";
  if (!/^[A-Z0-9]{4,8}$/.test(code) || token.length < 8) throw new Error("Bad request.");
  return { code, token };
}

export const snapshot = createServerFn({ method: "POST" })
  .validator((data: unknown) => parseSeat(data))
  .handler(async ({ data }): Promise<ApiResult> => {
    try {
      const loaded = await load(data.code);
      if (!loaded) return { ok: false, error: "No company is using that code." };
      const seat = seatFromToken(loaded.state, data.token);
      if (!seat) return { ok: false, error: "You are not in this company." };
      return { ok: true, view: toView(loaded.state, seat.id) };
    } catch (err) {
      console.error(err);
      return { ok: false, error: "The trail couldn't be reached." };
    }
  });

export const configure = createServerFn({ method: "POST" })
  .validator((data: unknown) => {
    const seat = parseSeat(data);
    const rec = data as Record<string, unknown>;
    return {
      ...seat,
      tier: parseTier(rec.tier),
      size: parseSize(rec.size),
    };
  })
  .handler(async ({ data }): Promise<ApiResult> => {
    try {
      return await mutate(data.code, data.token, (state, seatId, now) =>
        configureRoom(state, seatId, { tier: data.tier, size: data.size }, now),
      );
    } catch (err) {
      console.error(err);
      return { ok: false, error: "The trail couldn't be reached." };
    }
  });

export const start = createServerFn({ method: "POST" })
  .validator((data: unknown) => parseSeat(data))
  .handler(async ({ data }): Promise<ApiResult> => {
    try {
      return await mutate(data.code, data.token, (state, seatId, now) => startTrail(state, seatId, now));
    } catch (err) {
      console.error(err);
      return { ok: false, error: "The trail couldn't be reached." };
    }
  });

export const act = createServerFn({ method: "POST" })
  .validator((data: unknown) => {
    const seat = parseSeat(data);
    const rec = data as Record<string, unknown>;
    const round = rec.round;
    if (typeof round !== "number" || !Number.isInteger(round)) throw new Error("Bad request.");
    return { ...seat, round, intent: cleanIntent(rec.intent) };
  })
  .handler(async ({ data }): Promise<ApiResult> => {
    try {
      return await mutate(data.code, data.token, (state, seatId, now) =>
        submitIntent(state, seatId, data.intent, data.round, now),
      );
    } catch (err) {
      console.error(err);
      return { ok: false, error: "The trail couldn't be reached." };
    }
  });

export const away = createServerFn({ method: "POST" })
  .validator((data: unknown) => {
    const seat = parseSeat(data);
    const rec = data as Record<string, unknown>;
    if (typeof rec.away !== "boolean") throw new Error("Bad request.");
    return { ...seat, away: rec.away };
  })
  .handler(async ({ data }): Promise<ApiResult> => {
    try {
      return await mutate(data.code, data.token, (state, seatId, now) =>
        data.away && state.phase === "lobby"
          ? releaseSeat(state, seatId, now)
          : setAway(state, seatId, data.away, now),
      );
    } catch (err) {
      console.error(err);
      return { ok: false, error: "The trail couldn't be reached." };
    }
  });

export const closeRoom = createServerFn({ method: "POST" })
  .validator((data: unknown) => parseSeat(data))
  .handler(async ({ data }): Promise<{ ok: true } | { ok: false; error: string }> => {
    try {
      const loaded = await load(data.code);
      if (!loaded) return { ok: true };
      const seat = seatFromToken(loaded.state, data.token);
      if (!seat || seat.id !== loaded.state.hostSeatId) {
        return { ok: false, error: "Only the host closes the room." };
      }
      if (loaded.state.phase !== "lobby") {
        return { ok: false, error: "The trail has already started." };
      }
      const sql = await getSql();
      await sql`delete from rooms where code = ${data.code} and version = ${loaded.version}`;
      return { ok: true };
    } catch (err) {
      console.error(err);
      return { ok: false, error: "The trail couldn't be reached." };
    }
  });
