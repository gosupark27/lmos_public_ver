export type Rubric = {
  still: boolean;
  gave: boolean;
  ledger: boolean;
  prodigal: boolean;
};

type Saved = {
  value: number;
  floorHits: number;
  foundX: boolean;
  rubric: Rubric;
  rated: string[];
};

const KEY = "handshake.rating.v1";

const EMPTY: Saved = {
  value: 4,
  floorHits: 0,
  foundX: false,
  rubric: { still: false, gave: false, ledger: false, prodigal: false },
  rated: [],
};

function load(): Saved {
  if (typeof localStorage === "undefined") return { ...EMPTY, rubric: { ...EMPTY.rubric }, rated: [] };
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...EMPTY, rubric: { ...EMPTY.rubric }, rated: [] };
    const parsed = JSON.parse(raw) as Partial<Saved>;
    return {
      value: typeof parsed.value === "number" ? parsed.value : 4,
      floorHits: parsed.floorHits ?? 0,
      foundX: Boolean(parsed.foundX),
      rubric: { ...EMPTY.rubric, ...parsed.rubric },
      rated: Array.isArray(parsed.rated) ? parsed.rated : [],
    };
  } catch {
    return { ...EMPTY, rubric: { ...EMPTY.rubric }, rated: [] };
  }
}

function save(next: Saved): void {
  localStorage.setItem(KEY, JSON.stringify(next));
}

export function readRating(): Saved {
  return load();
}

export function rankLabel(value: number): string {
  const n = Math.max(3.7, value);
  if (n >= 5.3) return "S+";
  if (n >= 5) return "S";
  if (n >= 4.7) return "S−";
  if (n >= 4.3) return "A+";
  if (n >= 4) return "A";
  return "A−";
}

export function recordGame(code: string, kind: "peace" | "boil" | "fracture"): Saved {
  const current = load();
  const mark = `${code}:${kind}`;
  if (current.rated.includes(mark)) return current;
  const delta = kind === "peace" ? 0.18 : kind === "fracture" ? -0.08 : -0.16;
  let value = Math.round((current.value + delta) * 100) / 100;
  let floorHits = current.floorHits;
  if (value < 3.7) {
    value = 3.7;
    floorHits += 1;
  }
  if (value > 5.39) value = 5.39;
  const next = { ...current, value, floorHits, rated: [...current.rated, mark] };
  save(next);
  return next;
}

export function markRubric(key: keyof Rubric): Saved {
  const current = load();
  if (current.rubric[key]) return current;
  const next = { ...current, rubric: { ...current.rubric, [key]: true } };
  save(next);
  return next;
}

export function revealX(): Saved {
  const current = load();
  const next = { ...current, foundX: true };
  save(next);
  return next;
}

export function isSealedQuery(code: string): boolean {
  const c = code.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return c === "X" || c === "RANKX" || c === "SEALED";
}
