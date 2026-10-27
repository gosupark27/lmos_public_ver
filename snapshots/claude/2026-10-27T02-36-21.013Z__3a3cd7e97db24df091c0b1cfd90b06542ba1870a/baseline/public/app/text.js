// Every word the interface says, in one place.

import { ARCHETYPES } from '../engine/constants.js';

export const PHASE_NAME = {
  lobby: 'Camp', sunrise: 'Sunrise', silence: 'Silence', talk: 'Talk', act: 'Act', reveal: 'What happened',
  vote: 'The vote', prodigal: 'The prodigal seat', crossing: 'The crossing', frozen: 'Peace', end: 'The end of the road',
};

export const PHASE_HINT = {
  talk: 'Say up to two things, trade, then tap Ready.',
  act: 'Choose one thing to do. You can change it until time runs out.',
  reveal: 'Read what happened, then tap Continue.',
  vote: 'Name them or not. A majority names.',
  prodigal: 'The table waits.',
};

export const ACTIONS = {
  contribute: { group: 'trail', icon: 'cache', label: 'Put into the cache', help: 'Add supplies for the crossing. Only the total shows.' },
  give: { group: 'trail', icon: 'give', label: 'Give freely', help: 'Hand supplies to someone. Everyone sees it.' },
  forage: { group: 'trail', icon: 'forage', label: 'Forage', help: (a) => `Go out for supplies. Brings back ${a.yield}. Adds weight.` },
  still: { group: 'trail', icon: 'still', label: 'Be still', help: 'Do nothing. Your presence grows.' },
  look: { group: 'trail', icon: 'eye', label: 'Look where no one is looking', help: 'Learn exactly what the crossing needs. You might find a cache.' },
  accuse: { group: 'table', icon: 'accuse', label: 'Call someone to account', help: (a) => (a.needs > 1 ? 'Under clear skies it takes two accusers to start a vote.' : 'One accuser starts a vote.') },
  vouch: { group: 'table', icon: 'vouch', label: 'Vouch for someone', help: 'Your word counts against any vote to name them this act.' },
  claim_lead: { group: 'table', icon: 'crown', label: 'Take the lead', help: 'It works unless the leader holds on this round.' },
  hold_lead: { group: 'table', icon: 'crown', label: 'Hold the lead', help: 'Nobody can take the lead from you this round.' },
  boundary: { group: 'table', icon: 'line', label: 'Draw a line', help: 'Put someone outside tomorrow: no voting, no trading, no being accused.' },
  rally: { group: 'calling', icon: 'crown', label: 'Rally the train', help: 'Every contribution this round counts one more.' },
  stir: { group: 'calling', icon: 'crowd', label: 'Stir the crowd', help: 'The camp runs hotter.' },
  calm: { group: 'calling', icon: 'crowd', label: 'Calm the crowd', help: 'The camp cools down.' },
  peek: { group: 'calling', icon: 'letter', label: 'Read someone’s mail', help: 'See what they carry and whether they put into the cache. You gain leverage on them.' },
  callin: { group: 'calling', icon: 'letter', label: 'Call in a debt', help: 'Someone you have leverage on pays you one supply.' },
  witness: { group: 'calling', icon: 'eye', label: 'Witness', help: 'See exactly what one person does this round. Once per act.' },
  sacrifice: { group: 'calling', icon: 'sacrifice', label: null, help: null },
  spoil: { group: 'turned', icon: 'take', label: 'Take from the cache', help: 'Remove up to 3 from the crossing. No one sees who.' },
  stoke: { group: 'turned', icon: 'fire', label: 'Feed the fire', help: 'The camp runs hotter. No one sees who.' },
  esther: { group: 'turned', icon: 'step', label: 'Step forward', help: 'Name the turning in yourself before anyone else does.' },
  return: { group: 'turned', icon: 'step', label: 'Come home', help: 'Confess now. The door is still open.' },
};

export const GROUPS = [
  { id: 'trail', label: 'The trail' },
  { id: 'table', label: 'The table' },
  { id: 'calling', label: 'Your calling' },
  { id: 'turned', label: 'Only you can see these' },
];

export function sacrificeLabel(archetype) {
  return ARCHETYPES[archetype] ? ARCHETYPES[archetype].sacrificeVerb : 'Make an offering';
}

export function sacrificeHelp(archetype) {
  const a = ARCHETYPES[archetype];
  return a ? `Give up ${a.holds} for good. No one is told whether the road accepts it.` : '';
}

export const WORD_LABEL = {
  contribute: 'I’ll put into the crossing…',
  give: 'I’ll give…',
  still: 'I’ll be still this round.',
  no_accuse: 'I won’t call anyone to account.',
  accuse: 'I’m calling someone to account…',
  vote: 'If they’re named, I vote…',
  sacrifice: 'I’ll lay down what I hold.',
  clean: 'I haven’t turned.',
  gave_last: 'I put into the cache last round.',
  holding: 'I’m carrying…',
  need: 'The crossing is … short.',
};

export const FOUNDING_LABEL = {
  never_spoil: 'I’ll never take from the cache.',
  share_every: 'I’ll put in at every crossing.',
  no_hoard: 'I won’t carry more than I need.',
  truth: 'I’ll keep every word I say.',
};

export const ERRORS = {
  late: 'Too late: the clock ran out on that.',
  stale: 'That was for a moment that has already passed.',
  not_legal: 'That move isn’t open to you right now.',
  no_words_left: 'You’ve said your two things this round.',
  slow_down: 'Give the table a moment.',
  talk_off: 'The host turned table talk off.',
  they_cannot_pay: 'They can no longer cover that trade.',
  not_enough: 'You don’t have enough for that.',
  host_only: 'Only the host can do that.',
  need_four: 'A table needs at least four seats. Turn on stand-ins or invite more people.',
  outside: 'You’re outside the line today.',
  table_frozen: 'The table is frozen.',
  not_eligible: 'You can’t vote on this one.',
  started: 'This table already started without you.',
  full: 'This table is full.',
  bad_token: 'That seat belongs to someone else now.',
  no_room: 'There’s no table with that code.',
  bad_code: 'Room codes are eight letters and numbers, like KDRM-4H7Q.',
  too_many_offers: 'You have three offers out already.',
  already_silent: 'You’re already holding silence.',
  already_founded: 'You already made your founding pledge.',
  bad_target: 'Pick someone else.',
  timeout: 'The table didn’t answer. Check your connection.',
};

export function errorText(err) {
  return ERRORS[err] || 'That didn’t go through.';
}

export const RULES = [
  ['The game', 'You are a wagon train headed west, played over three acts of three days. Each act ends at a river. Put enough into the crossing cache, or a wagon goes into the water. Lose both wagons and the trail takes everyone.'],
  ['No names, no faces', 'You get a character and an archetype. The Kingmaker holds a crown, the Populist a crowd, the Shadow Broker leverage, the Idealist the conviction of being right. Each can give theirs up.'],
  ['Each day', 'Talk: say up to two things (pledges and claims), trade, or hold silence. Act: choose one deed. Then read what happened. A call to account leads to a vote.'],
  ['Words', 'The game checks every pledge against what you actually do, and every claim against the truth. It keeps that score in secret and shows it at the end. Table talk is never scored.'],
  ['The turning', 'From day three, when the camp runs hot enough, someone turns. Only they know. If the train fails, they win. Name them by majority vote and they get the prodigal seat: confess, or stay silent. Nobody is thrown out.'],
  ['Weather', 'Heat simmers every day. Clear skies need two accusers. Heat shimmer costs water at dawn. A dust storm stops foraging and drawing lines.'],
  ['Presence', 'Being still, giving freely, and keeping your word make your lantern brighter. Hoarding and breaking your word dim it. Nobody can take it from you. A bright table makes the river run lower.'],
  ['The rest', 'Some of the road is only learned by playing.'],
];

export const LEVERS = [
  ['Heat', 'Pressure before something boils over. It rises slowly and never all at once.'],
  ['Boundary', 'Who counts as inside. The leader can put someone outside for a day.'],
  ['Power', 'Who thinks they lead. Anyone can reach for the lead.'],
  ['Silence', 'The one who waits. Breaking it costs you.'],
  ['Influence', 'Soft moves that shift everything. Vouch for someone.'],
  ['Hidden', 'The thing nobody is watching. Look where no one is looking.'],
  ['Presence', 'Doing nothing, shifting the water level. It cannot be targeted.'],
];
