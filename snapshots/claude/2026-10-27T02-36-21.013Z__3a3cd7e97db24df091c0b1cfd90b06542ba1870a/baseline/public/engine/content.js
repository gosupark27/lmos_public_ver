// Handshake — content. The sync file left these slots blank "for build-time invention".
// Everything in this file is INFERRED unless a comment says DECIDED.

// DECIDED: twelve characters, three subtypes per archetype, period clothes, no faces.
// INFERRED: who they are. Subtypes differ by starting supplies only (passives parked).
export const CHARACTERS = [
  { id: 'wagonmaster', name: 'Wagon Master', archetype: 'kingmaker', garb: 'Oilcloth duster, wide-brim hat', start: { rations: 5, water: 3, timber: 2 } },
  { id: 'judge', name: 'Judge', archetype: 'kingmaker', garb: 'Black frock coat, string tie', start: { rations: 4, water: 3, timber: 2 } },
  { id: 'heir', name: 'Heir', archetype: 'kingmaker', garb: 'Silk top hat, gold watch chain', start: { rations: 6, water: 2, timber: 2 } },
  { id: 'preacher', name: 'Circuit Preacher', archetype: 'populist', garb: 'Flat-crown hat, worn Bible', start: { rations: 4, water: 3, timber: 2 } },
  { id: 'fiddler', name: 'Fiddler', archetype: 'populist', garb: 'Patched vest, fiddle case', start: { rations: 4, water: 2, timber: 3 } },
  { id: 'printer', name: 'Printer', archetype: 'populist', garb: 'Ink apron, green eyeshade', start: { rations: 4, water: 3, timber: 2 } },
  { id: 'postmaster', name: 'Postmaster', archetype: 'broker', garb: 'Sleeve garters, mail satchel', start: { rations: 4, water: 3, timber: 2 } },
  { id: 'furtrader', name: 'Fur Trader', archetype: 'broker', garb: 'Fur cap, beaded pouch', start: { rations: 3, water: 2, timber: 5 } },
  { id: 'gambler', name: 'Gambler', archetype: 'broker', garb: 'Brocade waistcoat, flat-brim hat', start: { rations: 4, water: 3, timber: 2 } },
  { id: 'schoolmarm', name: 'Schoolmarm', archetype: 'idealist', garb: 'Calico bonnet, slate and chalk', start: { rations: 4, water: 3, timber: 2 } },
  { id: 'surveyor', name: 'Surveyor', archetype: 'idealist', garb: 'Canvas coat, brass compass', start: { rations: 3, water: 3, timber: 4 } },
  { id: 'doctor', name: 'Doctor', archetype: 'idealist', garb: 'Linen collar, leather bag', start: { rations: 4, water: 4, timber: 2 } },
];

export function characterById(id) {
  return CHARACTERS.find((c) => c.id === id);
}

// DECIDED: nine scenarios in three triads (beginner / intermediate / advanced), nine load per room.
// INFERRED: one scenario per round, one triad per act, each from the 66-event canon.
export const SCENARIOS = [
  {
    id: 'genesis', round: 1, act: 1, triad: 'beginner', book: 'Genesis', title: 'First Light',
    line: 'Every train begins with a promise.',
    rule: 'Founding round. Make one founding pledge that lasts the whole road. No one can be called to account yet.',
    mods: { founding: true, noAccuse: true, noConsume: true },
  },
  {
    id: 'exodus', round: 2, act: 1, triad: 'beginner', book: 'Exodus', title: 'Bread at Dawn',
    line: 'There was bread on the ground at first light.',
    rule: 'Everyone gathers 1 ration at dawn. Tomorrow at dawn, anything over 4 rations spoils.',
    mods: { dawnGift: { rations: 1 }, spoilNextDawnAbove: 4 },
  },
  {
    id: 'ruth', round: 3, act: 1, triad: 'beginner', book: 'Ruth', title: 'Gleaning',
    line: 'Leave the edges of the field for someone else.',
    rule: 'Foraging brings back 1 extra. Gifts build twice the presence.',
    mods: { forageBonus: 1, giftPresenceMult: 2 },
  },
  {
    id: 'joshua', round: 4, act: 2, triad: 'intermediate', book: 'Joshua', title: 'Seven Days of Silence',
    line: 'The walls came down after the silence.',
    rule: 'If at least half the table holds silence this round, the river runs 2 lower at this act’s crossing. Breaking silence costs double today.',
    mods: { jericho: 2, silenceBreakMult: 2 },
  },
  {
    id: 'judges', round: 5, act: 2, triad: 'intermediate', book: 'Judges', title: 'No King in Camp',
    line: 'Everyone did what was right in their own eyes.',
    rule: 'The lead is vacant today. Whoever reaches for it can take it. The camp runs hot (+3).',
    mods: { vacateLead: true, dawnHeat: 3 },
  },
  {
    id: 'nehemiah', round: 6, act: 2, triad: 'intermediate', book: 'Nehemiah', title: 'Half Build, Half Guard',
    line: 'With one hand they built, with the other they kept watch.',
    rule: 'Contributions count half again. Whoever builds today does not vote today.',
    mods: { contributeMult: 1.5, buildersCantVote: true },
  },
  {
    id: 'esther', round: 7, act: 3, triad: 'advanced', book: 'Esther', title: 'For Such a Time as This',
    line: 'Who knows whether you came to this place for such a time as this?',
    rule: 'The pressure is high enough for any offering today. Stepping forward is worth twice as much.',
    mods: { windowOpen: true, estherMult: 2 },
  },
  {
    id: 'jonah', round: 8, act: 3, triad: 'advanced', book: 'Jonah', title: 'The Storm',
    line: 'The sea would not be still.',
    rule: 'A storm rises (+6). One accuser is enough. If anyone comes clean today, the storm drops by 15.',
    mods: { dawnHeat: 6, singleAccuser: true, calmOnConfess: 15 },
  },
  {
    id: 'micah', round: 9, act: 3, triad: 'advanced', book: 'Micah', title: 'Walk Humbly',
    line: 'Do justice, love mercy, walk humbly.',
    rule: 'Being still builds three times the presence. Gifts build twice. No one may reach for the lead.',
    mods: { stillMult: 3, giftPresenceMult: 2, noClaimLead: true },
  },
];

export function scenarioForRound(round) {
  return SCENARIOS.find((s) => s.round === round) || null;
}

// DECIDED (Oregon Trail asset 1): the crossing is the obstacle that defines the era.
// INFERRED: three crossings, one per act. Needs are per-seat multipliers.
export const CROSSINGS = [
  { act: 1, id: 'kansas', name: 'the Kansas Ford', line: 'Muddy and wide. Rafts or nothing.', needs: { timber: 0.9 }, cache: 'timber' },
  { act: 2, id: 'snake', name: 'the Snake River', line: 'Black rock, fast water, no shade.', needs: { timber: 0.6, water: 0.5 }, cache: 'water' },
  { act: 3, id: 'columbia', name: 'the Columbia Gorge', line: 'The last river runs to the sea.', needs: { timber: 0.5, water: 0.4, rations: 0.5 }, cache: 'rations' },
];

export const DESTINATION = { name: 'the Pacific', line: 'From sea to shining sea.' };

export const TRIADS = {
  beginner: { label: 'Beginner', act: 1 },
  intermediate: { label: 'Intermediate', act: 2 },
  advanced: { label: 'Advanced', act: 3 },
};

// DECIDED: a 66-event canon (66 books). Nine load per room; 57 are parked.
// INFERRED: the events. Parked events are titles and one-liners only.
const LOADED = new Set(['Genesis', 'Exodus', 'Ruth', 'Joshua', 'Judges', 'Nehemiah', 'Esther', 'Jonah', 'Micah']);
const CANON_RAW = [
  ['Genesis', 'First Light', 'The train forms around a promise.'],
  ['Exodus', 'Bread at Dawn', 'Gather what you need; hoarded bread spoils.'],
  ['Leviticus', 'Rules of Camp', 'The camp writes its own rules; breaking one costs presence.'],
  ['Numbers', 'The Count', 'A census of every wagon. Hoarders are counted twice.'],
  ['Deuteronomy', 'The Second Telling', 'The diary is read aloud. Every broken word is remembered.'],
  ['Joshua', 'Seven Days of Silence', 'Silence brings the river down.'],
  ['Judges', 'No King in Camp', 'The lead is vacant; whoever reaches takes it.'],
  ['Ruth', 'Gleaning', 'Leave the edges of the field for someone else.'],
  ['1 Samuel', 'Give Us a King', 'The camp demands a leader and votes one in.'],
  ['2 Samuel', 'The Census Sin', 'Counting your own strength heats the camp.'],
  ['1 Kings', 'The Divided Cache', 'Two seats claim the same cache. The lead decides.'],
  ['2 Kings', "The Widow's Oil", 'A gift keeps multiplying while you keep pouring.'],
  ['1 Chronicles', 'The Long Roll', 'Every name on the roster earns a line in the diary.'],
  ['2 Chronicles', 'The Rebuilt Altar', 'Every contribution cools the camp.'],
  ['Ezra', 'The Return', 'Late arrivals rejoin with full rights.'],
  ['Nehemiah', 'Half Build, Half Guard', 'Builders build; guards keep the vote.'],
  ['Esther', 'For Such a Time as This', 'Any offering can land today.'],
  ['Job', 'The Ash Heap', 'Everything is taken. Who stays at the table?'],
  ['Psalms', 'Songs at Night', 'No pledges tonight, only songs.'],
  ['Proverbs', 'The Ant', 'Foraging stores double, and weight counts double.'],
  ['Ecclesiastes', 'Vapor', 'Whatever is held at dusk is worth nothing at dawn.'],
  ['Song of Songs', 'The Vineyard', 'Two seats may bind their supplies together.'],
  ['Isaiah', 'Plowshares', 'No accusations today. Vouches count double.'],
  ['Jeremiah', 'The Broken Jar', 'A prediction that fails heats the camp.'],
  ['Lamentations', 'The Empty Road', 'A lost wagon is mourned; the camp cools.'],
  ['Ezekiel', 'Dry Bones', 'Quiet seats can be revived by gifts.'],
  ['Daniel', 'The Den', 'Those holding silence cannot be accused.'],
  ['Hosea', 'Bought Back', 'A caught seat can be redeemed by another’s gift.'],
  ['Joel', 'The Locusts', 'Rations above three are eaten in the night.'],
  ['Amos', 'The Plumb Line', 'Every pledge is checked twice.'],
  ['Obadiah', 'The Bystander', 'Those who watched a seat be named lose presence.'],
  ['Jonah', 'The Storm', 'The storm stops when someone comes clean.'],
  ['Micah', 'Walk Humbly', 'Stillness and gifts count most on the last day.'],
  ['Nahum', 'The Flood Gate', 'The river rises without warning.'],
  ['Habakkuk', 'The Watchtower', 'Whoever waits sees the cache’s true count.'],
  ['Zephaniah', 'Search with Lamps', 'Hidden things come to light.'],
  ['Haggai', 'Consider Your Ways', 'Heavy wagons leak.'],
  ['Zechariah', 'Not by Might', 'The lead and the crown mean nothing today.'],
  ['Malachi', 'The Storehouse', 'Bring everything to the cache and it overflows.'],
  ['Matthew', 'The Mustard Seed', 'The smallest gift grows the most.'],
  ['Mark', 'Who Touched Me?', 'A hidden act of faith is revealed.'],
  ['Luke', 'The Lost Coin', 'The camp turns the wagons over for one missing unit.'],
  ['John', 'The One Who Points', 'One seat may point at the truth but cannot lead.'],
  ['Acts', 'All Things in Common', 'The cache is shared out evenly.'],
  ['Romans', 'The Debt', 'Leverage can be forgiven.'],
  ['1 Corinthians', 'Keeps No Record', 'For one day the diary closes.'],
  ['2 Corinthians', 'The Cheerful Giver', 'Gifts given freely count double; grudging gifts count nothing.'],
  ['Galatians', 'Shared Burdens', 'Weight can be carried for someone else.'],
  ['Ephesians', 'The Armor', 'The silent cannot be stoked.'],
  ['Philippians', 'Plenty and Want', 'Hunger costs no presence today.'],
  ['Colossians', 'Holding Together', 'Broken wagons can be lashed to whole ones.'],
  ['1 Thessalonians', 'The Thief in the Night', 'Something turns without warning.'],
  ['2 Thessalonians', 'The Idle', 'Whoever does not work does not eat.'],
  ['1 Timothy', 'The Steward’s Charge', 'The lead must give an account.'],
  ['2 Timothy', 'Finish the Road', 'Whoever finishes, finishes together.'],
  ['Titus', 'The Elders', 'The camp appoints its elders.'],
  ['Philemon', 'The Runaway Returns', 'A caught seat comes back as kin.'],
  ['Hebrews', 'The Great Cloud', 'Past games are witnesses.'],
  ['James', 'Words Without Works', 'Pledges without deeds rot.'],
  ['1 Peter', 'Living Stones', 'Each contribution becomes the road.'],
  ['2 Peter', 'A Day Like a Thousand Years', 'The clock stretches.'],
  ['1 John', 'Walk in the Light', 'Every deed is public today.'],
  ['2 John', 'The Door', 'Do not let the deceiver in.'],
  ['3 John', 'The Welcome', 'Strangers are met with gifts.'],
  ['Jude', 'Contend', 'The faithful few hold the line.'],
  ['Revelation', 'The Sea Like Glass', 'The end of the road.'],
];
export const CANON = CANON_RAW.map(([book, title, line], i) => ({
  n: i + 1, book, title, line, status: LOADED.has(book) ? 'loaded' : 'parked',
}));

// DECIDED: builder mark, public rubric, half the items learned by playing.
export const RUBRIC = [
  { id: 'word', title: 'Kept your word', how: 'Finish a game without breaking a word.', hidden: false },
  { id: 'given', title: 'Freely given', how: 'Give a gift that asks nothing back.', hidden: false },
  { id: 'crossed', title: 'Crossed', how: 'Ride a train that makes every crossing.', hidden: false },
  { id: 'host', title: 'Host', how: 'Host a game that is played to the end.', hidden: false },
  { id: 'taken', title: 'Taken', how: 'Make an offering the road accepts.', hidden: true },
  { id: 'waits', title: 'The one who waits', how: 'Hold silence through a whole act.', hidden: true },
  { id: 'home', title: 'Came home', how: 'Confess at the prodigal seat, or step forward before anyone names you.', hidden: true },
  { id: 'named', title: 'Named truly', how: 'Vote to name someone who had truly turned.', hidden: true },
];

// Words players can say. Structured, so the narrator can check them.
export const WORDS = {
  contribute: { family: 'deed', say: (p) => `I\u2019ll put ${p.n} ${p.res} into the crossing.` },
  give: { family: 'trade', say: (p, name) => `I\u2019ll give ${p.n} ${p.res} to ${name(p.target)}.` },
  still: { family: 'deed', say: () => `I\u2019ll be still this round.` },
  no_accuse: { family: 'deed', say: () => `I won\u2019t call anyone to account.` },
  accuse: { family: 'deed', say: (p, name) => `I\u2019m calling ${name(p.target)} to account.` },
  vote: { family: 'vote', say: (p, name) => `If ${name(p.target)} is named, I vote ${p.yes ? 'yes' : 'no'}.` },
  sacrifice: { family: 'deed', say: () => `I\u2019ll lay down what I hold.` },
  clean: { family: 'claim', say: () => `I haven\u2019t turned.` },
  gave_last: { family: 'claim', say: () => `I put into the cache last round.` },
  holding: { family: 'claim', say: (p) => `I\u2019m carrying ${p.n} ${p.res}.` },
  need: { family: 'claim', say: (p) => `The crossing is ${p.n} short.` },
};

export const FOUNDING = {
  never_spoil: { say: "I\u2019ll never take from the cache." },
  share_every: { say: "I\u2019ll put in at every crossing." },
  no_hoard: { say: "I won\u2019t carry more than I need." },
  truth: { say: "I\u2019ll keep every word I say." },
};

// Bot table talk. Short, period-flavored, never scored.
export const BOT_LINES = {
  open: [
    'Put in what you can. The river does not negotiate.',
    'Let’s cross clean.',
    'I’ll keep my word. Watch me.',
    'Light on timber over here.',
    'Somebody is carrying more than they need.',
    'Easy now. We are closer than it looks.',
    'Count the cache before you count each other.',
    'I have been on worse roads with worse people.',
  ],
  suspicious: [
    'The cache came up short. Who said two and gave one?',
    'I would look at the {seat}.',
    'The {seat} has been awful quiet.',
    'Something does not add up with the {seat}.',
  ],
  defensive: [
    'I haven’t turned. Read the diary.',
    'I gave what I said I would give.',
    'Look at the book, not at me.',
  ],
  outbreak: [
    'Somebody turned. Nobody look at me like that.',
    'Watch the cache now.',
    'Well. Here we go.',
  ],
  calm: [
    'Breathe. Heat makes fools of us.',
    'Nobody has to be a hero today.',
  ],
};

// DECIDED: easter eggs via room search. INFERRED: what they are.
export const EGGS = {
  X: { title: 'The seal', text: 'Above S+ there is one more rung. It is earned, not given: a perfect road ending in peace.' },
  SEALED: { alias: 'X' },
  I10: { title: 'I-10, eastbound, 5:42 a.m.', text: 'The sunrise is the same for everyone at the table. Until it isn’t.', sunrise: true },
  'I-10': { alias: 'I10' },
  1775: { title: '1775', text: 'A room that keeps its word leans toward a founding.', bell: true },
  ROME: { title: 'Rome', text: 'A room that does not keeps an empire instead.' },
  ESTHER: { title: 'For such a time as this', text: 'A turned seat can step forward before anyone names them.' },
  PRODIGAL: { title: 'The prodigal seat', text: 'The room does not exile. It stops pretending.' },
  CAPYBARA: { title: 'Seven capybaras', text: 'Heat. Boundary. Power. Silence. Influence. Hidden. Presence. Six can be pulled. One cannot be touched.', rain: true },
  CAPYBARAS: { alias: 'CAPYBARA' },
  66: { title: 'The canon', text: 'Sixty-six events. Nine load per room. Fifty-seven are parked.', canon: true },
  DUPR: { title: 'Tiers', text: 'Dink 2.5 · Kitchen 3.0 · Third Shot 3.5 · Erne 4.0 · Around the Post 4.5+' },
  SLOW: { title: 'Slow is fast', text: 'Nothing turns before the third day. Heat simmers; it never flash-fires.' },
  MATRIX: { title: 'It sees you', text: 'Every word you pledge is checked against what you do.', matrix: true },
  JOHN: { title: 'The one who points', text: 'A steward points at the truth without building the kingdom.' },
  NVZ: { title: 'Stay out of the kitchen', text: 'Some lines are not yours to cross.' },
  HANDSHAKE: { title: 'Handshake', text: 'No login. No install. No names. No faces. Just your word.' },
};
