// Handshake — rules constants.
// Every number here is either DECIDED by the sync file or INFERRED at build time.
// BUILD_LEDGER.md says which is which.

export const BUILD = '1.0.0';

export const RES = ['rations', 'water', 'timber'];
export const RES_LABEL = { rations: 'rations', water: 'water', timber: 'timber' };

export const ARCHETYPE_ORDER = ['kingmaker', 'populist', 'broker', 'idealist'];

// DECIDED: four archetypes and what each gives up.
export const ARCHETYPES = {
  kingmaker: {
    id: 'kingmaker', name: 'Kingmaker', holds: 'the crown', gives: 'Gives up the crown',
    asset: 'crown', sacrificeVerb: 'Lay the crown on someone else', sacrificeTarget: true,
    power: 'Your crown adds a vote and lets you rally the train.',
  },
  populist: {
    id: 'populist', name: 'Populist', holds: 'the crowd', gives: 'Gives up the crowd',
    asset: 'crowd', sacrificeVerb: 'Send the crowd home', sacrificeTarget: false,
    power: 'Your crowd adds a vote and lets you stir or calm the camp.',
  },
  broker: {
    id: 'broker', name: 'Shadow Broker', holds: 'the leverage', gives: 'Gives up the leverage',
    asset: 'leverage', sacrificeVerb: 'Burn the letters', sacrificeTarget: false,
    power: 'You peek at what others carry and call in debts.',
  },
  idealist: {
    id: 'idealist', name: 'Idealist', holds: 'being right', gives: 'Gives up being right',
    asset: 'conviction', sacrificeVerb: 'Say \u201cI could be wrong\u201d', sacrificeTarget: false,
    power: 'Your conviction doubles a vote and lets you witness one deed per act.',
  },
};

// DECIDED: five DUPR-mapped tiers. INFERRED: the numbers behind them.
export const TIERS = [
  { id: 1, dupr: '2.5', name: 'Dink', note: 'First time at the table', heatStart: 5, simmer: 5, outbreakAt: 30, needAdj: -1, botSkill: 0.35, apocalypse: false },
  { id: 2, dupr: '3.0', name: 'Kitchen', note: 'Knows the rules', heatStart: 6, simmer: 6, outbreakAt: 28, needAdj: 0, botSkill: 0.5, apocalypse: false },
  { id: 3, dupr: '3.5', name: 'Third Shot', note: 'Plays with intent', heatStart: 8, simmer: 7, outbreakAt: 27, needAdj: 0, botSkill: 0.62, apocalypse: false },
  { id: 4, dupr: '4.0', name: 'Erne', note: 'Reads the table', heatStart: 10, simmer: 8, outbreakAt: 25, needAdj: 1, botSkill: 0.75, apocalypse: false },
  { id: 5, dupr: '4.5+', name: 'Around the Post', note: 'Apocalypse', heatStart: 13, simmer: 9, outbreakAt: 23, needAdj: 1, botSkill: 0.85, apocalypse: true },
];

// OPEN SLOT "time-bound number" filled here. Seconds per phase.
export const PACES = {
  quick: { label: 'Quick', minutes: '~15 min', talk: 45, act: 25, vote: 20, prodigal: 30, reveal: 5, sunrise: 6, silence: 5, crossing: 6, frozen: 10 },
  standard: { label: 'Standard', minutes: '~25 min', talk: 75, act: 35, vote: 30, prodigal: 45, reveal: 6, sunrise: 8, silence: 6, crossing: 8, frozen: 12 },
  long: { label: 'Long', minutes: '~40 min', talk: 120, act: 50, vote: 40, prodigal: 60, reveal: 7, sunrise: 9, silence: 7, crossing: 9, frozen: 12 },
  blitz: { label: 'Blitz', minutes: 'dev only', talk: 3, act: 3, vote: 2, prodigal: 2, reveal: 1, sunrise: 1, silence: 1, crossing: 1, frozen: 2, dev: true },
};

// DECIDED: heat is a simmer that rewrites legal moves. INFERRED: the bands.
export const HEAT_BANDS = [
  { id: 'cool', name: 'Clear skies', min: 0, forage: 3, accuseNeeds: 2, waterAtDawn: 0, tradeTax: 0, window: false, boundary: true },
  { id: 'warm', name: 'Warm wind', min: 25, forage: 3, accuseNeeds: 1, waterAtDawn: 0, tradeTax: 0, window: false, boundary: true },
  { id: 'hot', name: 'Heat shimmer', min: 50, forage: 2, accuseNeeds: 1, waterAtDawn: 1, tradeTax: 0, window: true, boundary: true },
  { id: 'boiling', name: 'Dust storm', min: 75, forage: 0, accuseNeeds: 1, waterAtDawn: 1, tradeTax: 1, window: true, boundary: false },
];

// Invariant 7, made testable: "slow is fast" = heat never flash-fires and nothing turns early.
export const HEAT_RISE_CAP = 12;      // gross heat added in one round can never exceed this
export const EARLIEST_OUTBREAK_ROUND = 3;
export const OUTBREAK_RELEASE = 12;   // pressure released when something turns
export const OUTBREAK_STEP = 15;      // the next turning needs more pressure

export const PRESENCE_START = 40;
export const PRESENCE_LEVELS = [
  { id: 0, name: 'quiet', min: 0 },
  { id: 1, name: 'faint', min: 20 },
  { id: 2, name: 'steady', min: 40 },
  { id: 3, name: 'bright', min: 60 },
  { id: 4, name: 'radiant', min: 80 },
];

export const WEIGHT = { lightMax: 7, loadedMax: 10 }; // 11+ is heavy

export const LIMITS = {
  minSeats: 4,
  maxSeats: 12,
  wordsPerRound: 2,
  talkMax: 140,
  confessMax: 200,
  chatKeep: 60,
  chatGapMs: 2500,
  openOffers: 3,
  standInGraceMs: 8000,
  notesKeep: 30,
};

export const HEALTH_MAX = 2;

// DECIDED: rating ladder. INFERRED: GPA-style numbers to the hundredth.
export const RATING_START = 4.0;
export const SOFT_FLOOR = 3.67;
export const MASTER_ELO = 1300;
export const LADDER = [
  { id: 'X', label: 'X', min: 5.67, sealed: true, hue: 'prism' },
  { id: 'S+', label: 'S+', min: 5.33, hue: 'gold' },
  { id: 'S', label: 'S', min: 5.0, hue: 'gold' },
  { id: 'S-', label: 'S−', min: 4.67, hue: 'gold' },
  { id: 'A+', label: 'A+', min: 4.33, hue: 'teal' },
  { id: 'A', label: 'A', min: 4.0, hue: 'teal' },
  { id: 'A-', label: 'A−', min: 3.67, hue: 'teal', floor: true },
  { id: 'MASTER', label: 'Master', min: -Infinity, bottom: true, hue: 'ash' },
];

// Secret Elo: truthfulness, not skill.
export const ELO = {
  start: 1500,
  pledgeKept: 8,
  pledgeBroken: -30,
  claimTrue: 4,
  claimFalse: -40,
  foundingKept: 40,
  foundingBroken: -40,
  silenceBroken: -30,
  confess: 60,
  esther: 80,
  returned: 40,
  staySilent: -20,
};

// "A Shadow Broker's truthfulness means something different than an Idealist's."
// Multipliers by archetype and word family.
export const ELO_WEIGHT = {
  kingmaker: { deed: 1.0, vote: 1.5, claim: 1.0, trade: 1.0 },
  populist: { deed: 1.25, vote: 1.25, claim: 1.25, trade: 1.0 },
  broker: { deed: 1.0, vote: 1.0, claim: 0.5, trade: 2.0 },
  idealist: { deed: 1.0, vote: 1.0, claim: 1.5, trade: 1.0 },
};

export const SPECTRUM = [
  { min: 1650, label: 'Honest' },
  { min: 1550, label: 'Mostly honest' },
  { min: 1450, label: 'Mixed' },
  { min: 1350, label: 'Slippery' },
  { min: -Infinity, label: 'Dishonest' },
];

export const PHASES = ['lobby', 'sunrise', 'silence', 'talk', 'act', 'reveal', 'vote', 'prodigal', 'crossing', 'frozen', 'end'];
export const LIVE_PHASES = new Set(['talk', 'act', 'vote', 'prodigal']);

export function imposterCap(seatCount, tier) {
  // Invariant 1: starts at one, stacks to a cap. Zero before the first outbreak.
  let cap = seatCount <= 6 ? 1 : seatCount <= 9 ? 2 : 3;
  if (tier && tier.apocalypse) cap += 1;
  return Math.min(cap, 3);
}

export function heatBand(heat) {
  let band = HEAT_BANDS[0];
  for (const b of HEAT_BANDS) if (heat >= b.min) band = b;
  return band;
}

export function presenceLevel(p) {
  let lvl = 0;
  for (const l of PRESENCE_LEVELS) if (p >= l.min) lvl = l.id;
  return lvl;
}

export function weightOf(res) {
  return (res.rations || 0) + (res.water || 0) + (res.timber || 0);
}

export function weightClass(res) {
  const w = weightOf(res);
  return w <= WEIGHT.lightMax ? 'light' : w <= WEIGHT.loadedMax ? 'loaded' : 'heavy';
}

export function spectrumLabel(elo) {
  for (const s of SPECTRUM) if (elo >= s.min) return s.label;
  return 'Dishonest';
}

export function tierById(id) {
  return TIERS.find((t) => t.id === id) || TIERS[2];
}
