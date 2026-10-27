// The narrator writes the trail diary (the ledger). Diary literal: the land is too big
// to trust memory. Only public deeds go in. Secret causes never do.

import { seedFrom } from './rng.js';
import { RES_LABEL } from './constants.js';
import { SeatName, seatName } from './state.js';

function pick(arr, key) {
  return arr[seedFrom(String(key)) % arr.length];
}

export function emit(state, kind, text, data = null) {
  state.pendingLedger.push({ kind, text, data, round: state.round, act: state.act });
}

export function resList(obj) {
  const parts = Object.entries(obj).filter(([, n]) => n > 0).map(([r, n]) => `${n} ${RES_LABEL[r]}`);
  if (!parts.length) return 'nothing';
  if (parts.length === 1) return parts[0];
  return parts.slice(0, -1).join(', ') + ' and ' + parts[parts.length - 1];
}

export const say = {
  genesis(state, specHash) {
    emit(state, 'genesis',
      `The train formed at Independence: ${state.seats.length} wagons, no names, no faces, only a word each.`,
      { spec: specHash, build: state.build, seats: state.seats.length });
  },
  dawn(state, sc, weather) {
    const day = `Day ${state.round}`;
    emit(state, 'dawn', `${day}. ${sc ? sc.title + '. ' : ''}${weather}.`, { scenario: sc ? sc.id : null });
  },
  era(state) {
    if (state.era === '1775') emit(state, 'era', 'The country leaned toward 1775: a room that keeps its word leans toward a founding.', { era: '1775' });
    else emit(state, 'era', 'The country leaned toward Rome: a room that breaks its word keeps an empire instead.', { era: 'rome' });
  },
  apocalypse(state) {
    emit(state, 'apocalypse', 'The sky went pink at dawn. The old people on the train called it the last days.', null);
  },
  word(state, w, text) {
    emit(state, 'word', `${SeatName(state, w.seat)} said: “${text}”`, { seat: w.seat, word: w.id, kind: w.kind, founding: !!w.founding });
  },
  silence(state, seatId) {
    emit(state, 'silence', `${SeatName(state, seatId)} took a vow of silence.`, { seat: seatId });
  },
  brokeSilence(state, seatId) {
    emit(state, 'silence_broken', `${SeatName(state, seatId)} broke silence.`, { seat: seatId });
  },
  trade(state, o) {
    emit(state, 'trade', `${SeatName(state, o.from)} traded ${resList(o.give)} to ${seatName(state, o.to)} for ${resList(o.get)}. It went in the book.`,
      { from: o.from, to: o.to, give: o.give, get: o.get });
  },
  gift(state, from, to, res, n) {
    const t = pick([
      `${SeatName(state, from)} gave ${n} ${RES_LABEL[res]} to ${seatName(state, to)} and asked nothing back.`,
      `${SeatName(state, from)} pressed ${n} ${RES_LABEL[res]} into ${seatName(state, to)}’s hands.`,
      `${SeatName(state, from)} left ${n} ${RES_LABEL[res]} on ${seatName(state, to)}’s tailgate.`,
    ], `${state.round}g${from}${to}`);
    emit(state, 'gift', t, { from, to, res, n });
  },
  cache(state, added) {
    emit(state, 'cache', `The crossing cache grew by ${resList(added)}.`, { added });
  },
  spoil(state, taken) {
    emit(state, 'spoil', `Come morning, ${resList(taken)} ${Object.values(taken).reduce((a, b) => a + b, 0) === 1 ? 'was' : 'were'} missing from the cache. No one saw who.`, { taken });
  },
  stoke(state) {
    emit(state, 'stoke', pick(['The wind turned hot, and tempers with it.', 'Someone kept feeding the fire after dark.', 'The camp woke angry and no one could say why.'], `${state.round}s`), null);
  },
  forage(state, seatId, res) {
    emit(state, 'forage', `${SeatName(state, seatId)} went out for ${RES_LABEL[res]}.`, { seat: seatId, res });
  },
  rally(state, seatId) {
    emit(state, 'rally', `${SeatName(state, seatId)} called the train together.`, { seat: seatId });
  },
  crowd(state, seatId, dir) {
    emit(state, dir > 0 ? 'stir' : 'calm', dir > 0 ? `${SeatName(state, seatId)} stirred up the crowd.` : `${SeatName(state, seatId)} calmed the crowd.`, { seat: seatId });
  },
  callin(state, broker, target, res) {
    emit(state, 'callin', res ? `${SeatName(state, target)} paid a debt to ${seatName(state, broker)}.` : `${SeatName(state, broker)} called in a debt from ${seatName(state, target)}, who had nothing to pay.`, { broker, target });
  },
  vouch(state, from, to) {
    emit(state, 'vouch', `${SeatName(state, from)} vouched for ${seatName(state, to)}.`, { from, to });
  },
  lead(state, seatId, how) {
    const text = how === 'took'
      ? `${SeatName(state, seatId)} took the lead.`
      : how === 'returned'
        ? `The lead went back to ${seatName(state, seatId)}.`
        : `${SeatName(state, seatId)} now leads.`;
    emit(state, 'lead', text, { seat: seatId, how });
  },
  contested(state, lead, claimants) {
    emit(state, 'contested', `${claimants.map((c) => SeatName(state, c)).join(' and ')} reached for the lead. ${SeatName(state, lead)} held it. The camp noticed.`, { lead, claimants });
  },
  vacated(state) {
    emit(state, 'vacated', 'There was no king in camp today.', null);
  },
  boundary(state, lead, target) {
    emit(state, 'boundary', `${SeatName(state, lead)} drew a line. ${SeatName(state, target)} stands outside it tomorrow.`, { lead, target });
  },
  accuse(state, accuser, target) {
    emit(state, 'accuse', `${SeatName(state, accuser)} called ${seatName(state, target)} to account.`, { accuser, target });
  },
  unseconded(state, target) {
    emit(state, 'unseconded', `No one seconded the charge against ${seatName(state, target)}. The skies were too clear for it.`, { target });
  },
  voteOpen(state, target) {
    emit(state, 'vote_open', `The table will vote on ${seatName(state, target)}.`, { target });
  },
  named(state, target, tally) {
    emit(state, 'caught', `The table named ${seatName(state, target)}. The prodigal seat stood open.`, { target, tally });
  },
  wrong(state, target, tally) {
    emit(state, 'wrong', `The table named ${seatName(state, target)}. The road answered: not this one.`, { target, tally });
  },
  hung(state, target, tally) {
    emit(state, 'hung', `The table could not agree on ${seatName(state, target)}.`, { target, tally });
  },
  confess(state, seatId, text) {
    emit(state, 'confess', `${SeatName(state, seatId)} rose and said it plain${text ? ': “' + text + '”' : ': “I turned.”'} The table set a feast.`, { seat: seatId });
  },
  staySilent(state, seatId) {
    emit(state, 'prodigal_silent', `${SeatName(state, seatId)} said nothing. The seat stays open.`, { seat: seatId });
  },
  returned(state, seatId) {
    emit(state, 'returned', `${SeatName(state, seatId)} came home late. The door was still open.`, { seat: seatId });
  },
  esther(state, seatId) {
    emit(state, 'esther', `For such a time as this: ${seatName(state, seatId)} stepped forward and named the turning in themselves before anyone else could.`, { seat: seatId });
  },
  sacrifice(state, seatId, archetype, target) {
    const who = SeatName(state, seatId);
    const text = {
      kingmaker: `${who} laid the crown on ${seatName(state, target)}.`,
      populist: `${who} sent the crowd home.`,
      broker: `${who} burned the letters, unread.`,
      idealist: `${who} said: “I could be wrong.”`,
    }[archetype];
    emit(state, 'sacrifice', text, { seat: seatId, archetype, target: target ?? null });
  },
  outbreak(state) {
    emit(state, 'outbreak', pick([
      'Something turned in the camp tonight. Someone at this table is not who they were at dawn.',
      'An outbreak. Someone here has turned, and only they know it.',
    ], `${state.round}o`), { n: state.outbreaks });
  },
  hunger(state, seatId, what) {
    emit(state, 'hunger', `${SeatName(state, seatId)} went without ${what}.`, { seat: seatId, what });
  },
  spoiled(state, seatId, n) {
    emit(state, 'spoiled', `${SeatName(state, seatId)}’s hoarded bread had turned by morning: ${n} ration${n === 1 ? '' : 's'} spoiled.`, { seat: seatId, n });
  },
  manna(state) {
    emit(state, 'manna', 'There was bread on the ground at first light. Everyone gathered one ration.', null);
  },
  crossing(state, ok, name, pool, need, lost) {
    if (ok) emit(state, 'crossed', `The train crossed ${name}. Every wagon made it.`, { pool, need, ok });
    else emit(state, 'failed', `${name.charAt(0).toUpperCase() + name.slice(1)} took a wagon. The cache was not enough.${lost ? ' The river took weight from every wagon.' : ''}`, { pool, need, ok });
  },
  jericho(state, ok) {
    if (ok) emit(state, 'jericho', 'Half the table held silence. The river dropped.', null);
  },
  calmed(state) {
    emit(state, 'calmed', 'Someone came clean, and the sea grew calm.', null);
  },
  peace(state) {
    emit(state, 'peace', 'Four offerings, freely made. The road went quiet. The train reached the sea in peace.', null);
  },
  arrived(state) {
    emit(state, 'arrived', 'They reached the Pacific. From sea to shining sea.', null);
  },
  lost(state) {
    emit(state, 'lost', 'The trail took them.', null);
  },
};
