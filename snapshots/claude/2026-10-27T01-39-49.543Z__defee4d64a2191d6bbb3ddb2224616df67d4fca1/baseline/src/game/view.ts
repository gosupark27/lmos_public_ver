export const RESOURCES = ["water", "grain", "rope", "coin"] as const;
export type Resource = (typeof RESOURCES)[number];
export type Pack = Record<Resource, number>;

export type Tier = "novice" | "intermediate" | "advanced";
export type Phase = "lobby" | "sunrise" | "founding" | "day" | "prodigal" | "ended";
export type OutcomeKind = "peace" | "boil" | "fracture";

export type Intent =
  | { kind: "sunrise" }
  | { kind: "found"; line: string }
  | { kind: "still" }
  | { kind: "sacrifice"; resource: Resource }
  | { kind: "trade"; to: string; resource: Resource }
  | { kind: "accuse"; target: string }
  | { kind: "boundary"; target: string }
  | { kind: "peek"; target: string }
  | { kind: "vouch"; target: string }
  | { kind: "confess" }
  | { kind: "quiet" };

export type PublicSeat = {
  id: string;
  name: string;
  archetype: string | null;
  trait: string | null;
  presence: number;
  weight: number;
  bot: boolean;
  sacrificed: boolean;
  outside: boolean;
  caught: boolean;
  sealed: boolean;
  leading: boolean;
  yours: boolean;
};

export type LedgerLine = { id: string; day: number; text: string };

export type PublicTable = {
  code: string;
  phase: Phase;
  tier: Tier;
  day: number;
  dayCount: number;
  round: number;
  heat: number;
  miles: number;
  mileGoal: number;
  sky: number;
  eventTitle: string | null;
  eventBody: string | null;
  seats: PublicSeat[];
  ledger: LedgerLine[];
  outcome: { kind: OutcomeKind; title: string; text: string } | null;
  prodigalSeatId: string | null;
  youAreHost: boolean;
  waiting: number;
};

export type PrivateHand = {
  seatId: string;
  pack: Pack;
  wasStill: boolean;
  warning: string | null;
  peek: { name: string; note: string } | null;
  mirror: string | null;
  lines: { id: string; text: string }[] | null;
};

export type TableView = { table: PublicTable; hand: PrivateHand };

export type ApiOk = { ok: true; token?: string; view: TableView };
export type ApiErr = { ok: false; error: string };
export type ApiResult = ApiOk | ApiErr;
