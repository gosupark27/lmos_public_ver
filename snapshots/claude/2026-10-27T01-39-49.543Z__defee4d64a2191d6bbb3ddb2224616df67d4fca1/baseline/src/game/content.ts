import type { Pack, Tier } from "./view.ts";

export type Archetype = "kingmaker" | "populist" | "broker" | "idealist";

export type Character = {
  id: string;
  name: string;
  archetype: Archetype;
  archetypeLabel: string;
  trait: string;
  pack: Pack;
};

export const CHARACTERS: Character[] = [
  {
    id: "surveyor",
    name: "The Surveyor",
    archetype: "kingmaker",
    archetypeLabel: "Kingmaker",
    trait: "Maps the road, then folds the map.",
    pack: { water: 2, grain: 1, rope: 1, coin: 0 },
  },
  {
    id: "captain",
    name: "The Wagon Captain",
    archetype: "kingmaker",
    archetypeLabel: "Kingmaker",
    trait: "Holds the reins out, not in.",
    pack: { water: 1, grain: 1, rope: 2, coin: 0 },
  },
  {
    id: "heir",
    name: "The Heir",
    archetype: "kingmaker",
    archetypeLabel: "Kingmaker",
    trait: "The company was supposed to become theirs.",
    pack: { water: 1, grain: 2, rope: 0, coin: 1 },
  },
  {
    id: "fiddler",
    name: "The Fiddler",
    archetype: "populist",
    archetypeLabel: "Populist",
    trait: "Morale is a song they can stop.",
    pack: { water: 1, grain: 1, rope: 0, coin: 2 },
  },
  {
    id: "cook",
    name: "The Cook",
    archetype: "populist",
    archetypeLabel: "Populist",
    trait: "The pot is the crowd.",
    pack: { water: 1, grain: 3, rope: 0, coin: 0 },
  },
  {
    id: "crier",
    name: "The Crier",
    archetype: "populist",
    archetypeLabel: "Populist",
    trait: "The voice that can go quiet.",
    pack: { water: 2, grain: 0, rope: 1, coin: 1 },
  },
  {
    id: "quartermaster",
    name: "The Quartermaster",
    archetype: "broker",
    archetypeLabel: "Shadow broker",
    trait: "Every sack is counted.",
    pack: { water: 0, grain: 1, rope: 1, coin: 2 },
  },
  {
    id: "guide",
    name: "The Guide",
    archetype: "broker",
    archetypeLabel: "Shadow broker",
    trait: "Knows the ford and the price.",
    pack: { water: 2, grain: 0, rope: 2, coin: 0 },
  },
  {
    id: "letters",
    name: "The Letter Carrier",
    archetype: "broker",
    archetypeLabel: "Shadow broker",
    trait: "Other people's words, unopened.",
    pack: { water: 1, grain: 0, rope: 1, coin: 2 },
  },
  {
    id: "surgeon",
    name: "The Surgeon",
    archetype: "idealist",
    archetypeLabel: "Idealist",
    trait: "Will not leave a wound.",
    pack: { water: 2, grain: 2, rope: 0, coin: 0 },
  },
  {
    id: "teacher",
    name: "The Schoolteacher",
    archetype: "idealist",
    archetypeLabel: "Idealist",
    trait: "Corrects the map out loud.",
    pack: { water: 1, grain: 1, rope: 1, coin: 1 },
  },
  {
    id: "preacher",
    name: "The Preacher",
    archetype: "idealist",
    archetypeLabel: "Idealist",
    trait: "Certain of the way.",
    pack: { water: 0, grain: 2, rope: 1, coin: 1 },
  },
];

export const LINES: { id: string; text: string; promise: Archetype }[] = [
  { id: "crown", text: "I will not take the lead.", promise: "kingmaker" },
  { id: "crowd", text: "I will feed the company before I feed myself.", promise: "populist" },
  { id: "leverage", text: "What I know, I will spend.", promise: "broker" },
  { id: "right", text: "I will give up being right.", promise: "idealist" },
];

export type TrailEvent = { id: string; title: string; body: string };

export const EVENTS: TrailEvent[] = [
  {
    id: "ford",
    title: "The first ford",
    body: "The river is ankle-deep and pretending. Someone will want to rush it.",
  },
  {
    id: "ox",
    title: "The ox",
    body: "One ox is favoring a leg. The company can slow, or it can pretend not to see.",
  },
  {
    id: "watch",
    title: "Night watch",
    body: "The fire is bigger than the cold requires. Heat is a choice before it is weather.",
  },
  {
    id: "split",
    title: "The split track",
    body: "Two ruts. One is shorter. The person who knows will not say so for free.",
  },
  {
    id: "fever",
    title: "Dust fever",
    body: "Someone in the last wagon is hot. No one has asked the certain ones to stop.",
  },
  {
    id: "toll",
    title: "The toll",
    body: "A family on the bank wants grain, not coin. The ledger will remember which you offered.",
  },
  {
    id: "narrow",
    title: "The narrow",
    body: "The canyon takes one wagon at a time. Order is power, and everyone can hear who assumes it.",
  },
  {
    id: "spoke",
    title: "The lost spoke",
    body: "A wheel fails where the map is blank. What is hidden is the spare, and who has been sitting on it.",
  },
  {
    id: "last",
    title: "The last water",
    body: "The sea is a rumor. Four gifts would open it. A performance will not.",
  },
];

const TIER_OFFSET: Record<Tier, number> = { novice: 0, intermediate: 3, advanced: 6 };

export function eventFor(tier: Tier, day: number): TrailEvent {
  const index = (TIER_OFFSET[tier] + Math.max(0, day - 1)) % EVENTS.length;
  return EVENTS[index] ?? EVENTS[0];
}

export function characterById(id: string | null): Character | null {
  if (!id) return null;
  return CHARACTERS.find((c) => c.id === id) ?? null;
}

export function dayCountFor(tier: Tier): number {
  if (tier === "novice") return 5;
  if (tier === "intermediate") return 7;
  return 9;
}

export function imposterCap(tier: Tier): number {
  return tier === "novice" ? 1 : 2;
}

export const RESOURCE_LABEL: Record<keyof Pack, string> = {
  water: "water",
  grain: "grain",
  rope: "rope",
  coin: "coin",
};
