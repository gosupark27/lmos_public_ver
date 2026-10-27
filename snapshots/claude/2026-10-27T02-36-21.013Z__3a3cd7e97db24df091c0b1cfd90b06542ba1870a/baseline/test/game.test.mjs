// Game flow: the milestones from the sync file, played on a scripted table.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeTable } from './helpers.mjs';
import { runBotGame } from '../scripts/sim-lib.mjs';
import { legalActions } from '../public/engine/legal.js';

test('milestones 1-3: room exists, host invites, room goes live with sunrise and silence', () => {
  const T = makeTable({ seats: 4, connect: false });
  assert.equal(T.state.phase, 'lobby');
  assert.equal(T.state.seats.length, 1, 'only the host seat exists');
  T.io.conns.add(0);
  T.core.greet(0, { token: T.tokens[0], isNew: false, lastSeq: 0 }, T.now);
  // Invitees accept or leave on read.
  T.core.invite('seen', T.now); T.core.invite('seen', T.now); T.core.invite('left', T.now);
  for (let i = 0; i < 3; i++) {
    const a = T.core.authenticate({}, T.now);
    T.io.conns.add(a.seat);
    T.core.greet(a.seat, { ...a, lastSeq: 0 }, T.now);
  }
  assert.deepEqual(T.state.invites, { read: 2, accepted: 3, leftOnRead: 1 });
  const joins = T.sent.flatMap((x) => (x.msg.fx || []).filter((f) => f.kind === 'join'));
  assert.ok(joins.length >= 3, 'bells stack on join');
  // Only the host can configure and start.
  assert.equal(T.intent(1, { k: 'start' }).err, 'host_only');
  assert.ok(T.intent(0, { k: 'config', config: { tier: 4, pace: 'quick' } }).ok);
  assert.equal(T.state.config.tier, 4);
  assert.ok(T.intent(0, { k: 'start' }).ok);
  assert.equal(T.state.phase, 'sunrise');
  T.expire();
  assert.equal(T.state.phase, 'silence');
  T.expire();
  assert.equal(T.state.phase, 'talk');
  assert.equal(T.state.round, 1);
  // Every archetype is dealt at a table of four.
  assert.deepEqual(new Set(T.state.seats.map((s) => s.archetype)).size, 4);
});

test('a joiner cannot enter once the room is live', () => {
  const T = makeTable({ seats: 4 });
  T.start();
  assert.equal(T.core.authenticate({}, T.now).err, 'started');
  assert.equal(T.core.authenticate({ token: 'nope' }, T.now).err, 'bad_token');
  assert.equal(T.core.authenticate({ token: T.tokens[2] }, T.now).seat, 2, 'a token reclaims its seat');
});

test('milestone 4: trade, accusation, failed sacrifice; Rome/1775 branch', () => {
  const T = makeTable({ seats: 4 });
  T.start();
  T.state.secret.outbreak.threshold = 999;
  const [a, b] = T.state.seats;
  a.res.water = 3; b.res.timber = 3;
  const before = { aw: a.res.water, at: a.res.timber, bw: b.res.water, bt: b.res.timber };
  const off = T.intent(a.id, { k: 'offer', to: b.id, give: { water: 1 }, get: { timber: 1 } });
  assert.ok(off.ok);
  assert.ok(T.intent(b.id, { k: 'accept', offer: off.result.offer }).ok);
  assert.deepEqual({ aw: a.res.water, at: a.res.timber, bw: b.res.water, bt: b.res.timber },
    { aw: before.aw - 1, at: before.at + 1, bw: before.bw + 1, bt: before.bt - 1 });
  const trade = T.io.ledger.find((e) => e.kind === 'trade');
  assert.ok(trade, 'traded = ledger entry');
  T.allReady();
  T.act();
  T.skipTo('talk'); // round 2, cool skies, no pressure
  T.allReady();
  const ideal = T.seatOf('idealist');
  T.act({ [ideal.id]: { kind: 'sacrifice' } });
  const sac = T.state.secret.sacrifices[0];
  assert.equal(sac.valid, false, 'an offering with nothing at stake does not land');
  assert.ok(sac.reasons.includes('no_pressure'));
  assert.equal(ideal.assets.conviction, false, 'it is still given up');
  T.skipTo('talk'); // round 3
  T.state.heat = 30; // warm: one accuser is enough
  T.allReady();
  const target = T.seatOf('broker');
  const accuser = T.seatOf('populist');
  T.act({ [accuser.id]: { kind: 'accuse', target: target.id } });
  assert.equal(T.state.phase, 'reveal');
  assert.ok(T.state.vote && T.state.vote.accused === target.id);
  T.skipTo('vote');
  for (const s of T.state.seats) if (s.id !== target.id) T.intent(s.id, { k: 'vote', yes: true });
  assert.equal(T.state.vote.result.named, true);
  assert.equal(T.state.vote.result.caught, false, 'the broker was clean');
  assert.ok(T.io.ledger.some((e) => e.kind === 'wrong'));
  T.skipTo('crossing');
  T.skipTo('sunrise');
  assert.ok(['1775', 'rome'].includes(T.state.era), 'the country fractured one way or the other');
});

test('milestone 5: a caught saboteur gets the prodigal seat, and the room stops pretending', () => {
  const T = makeTable({ seats: 5 });
  T.start();
  T.state.secret.outbreak.threshold = 999;
  const turned = T.seatOf('kingmaker');
  T.state.secret.turned[turned.id] = { since: 1 };
  T.state.secret.turnedHistory.push({ seat: turned.id, round: 1 });
  T.state.outbreaks = 1;
  T.allReady(); T.act(); // Genesis: no one can be accused yet
  T.skipTo('talk');
  T.state.heat = 40;
  T.allReady();
  const others = T.state.seats.filter((s) => s.id !== turned.id);
  T.act({ [others[0].id]: { kind: 'accuse', target: turned.id }, [turned.id]: { kind: 'spoil' } });
  T.skipTo('vote');
  for (const s of others) T.intent(s.id, { k: 'vote', yes: true });
  T.intent(turned.id, { k: 'vote', yes: false });
  assert.equal(T.state.vote.result.caught, true);
  assert.equal(turned.caught, true);
  T.skipTo('prodigal');
  assert.equal(T.intent(others[0].id, { k: 'prodigal', choice: 'confess' }).err, 'not_your_seat');
  assert.ok(T.intent(turned.id, { k: 'prodigal', choice: 'confess', text: 'I turned. I was afraid we would not make it.' }).ok);
  assert.equal(turned.redeemed, true);
  assert.ok(!T.state.secret.turned[turned.id], 'no longer turned');
  const confess = T.io.ledger.find((e) => e.kind === 'confess');
  assert.match(confess.text, /afraid/);
  assert.ok(T.state.seats.includes(turned), 'no exile: the seat stays at the table');
});

test('the Esther move: a turned seat steps forward before anyone names it', () => {
  const T = makeTable({ seats: 4 });
  T.start();
  T.state.secret.outbreak.threshold = 999;
  const s = T.seatOf('broker');
  T.state.secret.turned[s.id] = { since: 1 };
  T.allReady();
  T.act({ [s.id]: { kind: 'esther' } });
  assert.equal(s.redeemed, true);
  assert.ok(T.io.ledger.some((e) => e.kind === 'esther'));
});

test('milestone 6: levers rewrite legal moves; heat simmers', () => {
  const T = makeTable({ seats: 4 });
  T.start();
  T.state.secret.outbreak.threshold = 999;
  // Genesis: no one can be called to account.
  T.allReady();
  const any = T.state.seats[1];
  const kinds = (id) => new Set(legalActions(T.state, id).map((a) => a.kind));
  assert.ok(!kinds(any.id).has('accuse'));
  T.act();
  T.skipTo('talk');
  T.state.heat = 80; // dust storm: no foraging, no boundary
  T.allReady();
  const lead = T.state.lead;
  assert.ok(!kinds(any.id).has('forage'));
  assert.ok(!kinds(lead).has('boundary'));
  assert.ok(kinds(lead).has('hold_lead'));
  // Silence: speaking breaks it and costs truthfulness.
  T.act();
  T.skipTo('talk');
  const quiet = T.state.seats[2];
  assert.ok(T.intent(quiet.id, { k: 'silence' }).ok);
  const elo0 = T.state.secret.elo[quiet.id];
  T.intent(quiet.id, { k: 'word', kind: 'still' });
  assert.ok(T.state.secret.elo[quiet.id] < elo0, 'breaking silence costs Secret Elo');
  assert.equal(quiet.silence.broken, true);
});

test('milestone 7: weight, hoarding, the crossing, and losing a wagon', () => {
  const T = makeTable({ seats: 4 });
  T.start();
  T.state.secret.outbreak.threshold = 999;
  const hoarder = T.state.seats[3];
  T.allReady();
  T.act();
  hoarder.res.rations = 12; // carried into the night
  const p0 = hoarder.presence;
  T.skipTo('talk');
  assert.ok(hoarder.presence < p0, 'hoarded = presence going quiet');
  // Nobody puts anything into the cache for act 1: the ford takes a wagon.
  T.allReady(); T.act(); T.skipTo('talk'); T.allReady(); T.act();
  T.skipTo('crossing');
  assert.equal(T.state.crossing.result.ok, false);
  assert.equal(T.state.health, 1);
});

test('milestone 8: four independent offerings bring the peace victory and freeze the table', () => {
  const T = makeTable({ seats: 4 });
  T.start();
  T.state.secret.outbreak.threshold = 999;
  T.allReady(); T.act(); // round 1
  const order = ['kingmaker', 'populist', 'broker', 'idealist'];
  for (const arch of order) {
    T.skipTo('talk');
    T.state.heat = 55; // heat shimmer: offerings can land
    T.allReady();
    const s = T.seatOf(arch);
    const a = arch === 'kingmaker' ? { kind: 'sacrifice', target: T.seatOf('idealist').id } : { kind: 'sacrifice' };
    T.act({ [s.id]: a });
    if (T.state.phase === 'reveal') T.allReady();
  }
  assert.equal(T.state.peace, true);
  assert.equal(T.state.phase, 'frozen');
  const frozenMsgs = T.sent.filter((x) => x.msg.fx && x.msg.fx.some((f) => f.kind === 'bell'));
  assert.ok(frozenMsgs.length > 0, 'bell chime as cue');
  assert.equal(T.intent(1, { k: 'ready' }).err, 'table_frozen', 'consequence as mechanic: nothing moves');
  T.expire();
  assert.equal(T.state.phase, 'end');
  assert.equal(T.state.result.kind, 'peace');
  assert.equal(T.state.result.winners.length, 4);
  assert.ok(T.state.epilogue.every((e) => e.marks.includes('taken')));
});

test('a lagging phone that reconnects after the freeze gets the frozen table', () => {
  const T = makeTable({ seats: 4 });
  T.start();
  T.state.peace = true;
  T.state.phase = 'act';
  T.core.disconnect(2, T.now);
  T.io.conns.delete(2);
  T.allReady();
  T.expire(); // act resolves -> peace -> frozen
  assert.equal(T.state.phase, 'frozen');
  T.sent.length = 0;
  T.io.conns.add(2);
  T.core.greet(2, { token: T.tokens[2], isNew: false, lastSeq: 1 }, T.now);
  const sync = T.messagesTo(2).find((m) => m.t === 'sync');
  assert.equal(sync.pub.phase, 'frozen');
  assert.ok(sync.events.length > 0 && sync.events.every((e) => e.seq > 1), 'delta sync only');
});

test('disconnect during live action: a stand-in takes the seat after a grace period', () => {
  const T = makeTable({ seats: 4 });
  T.start();
  T.core.disconnect(3, T.now);
  T.io.conns.delete(3);
  T.tick(3000);
  assert.equal(T.state.seats[3].standIn, false, 'not yet: a refresh gets a grace period');
  T.tick(6000);
  assert.equal(T.state.seats[3].standIn, true);
  T.io.conns.add(3);
  T.core.greet(3, { token: T.tokens[3], isNew: false, lastSeq: 0 }, T.now);
  assert.equal(T.state.seats[3].standIn, false, 'the player takes the seat back');
});

test('the epilogue releases secrets only at the end, with grades on the ladder', () => {
  const { core } = runBotGame({ seed: 77, seats: 6, tier: 3 });
  const s = core.state;
  assert.equal(s.phase, 'end');
  const pub = s.epilogue;
  assert.equal(pub.length, 6);
  for (const e of pub) {
    assert.match(e.label, /^(X|S\+|S|S−|A\+|A|A−|Master)$/);
    assert.equal(Math.round(e.rating * 100) / 100, e.rating, 'decimals to the hundredth');
    if (e.label !== 'Master') assert.ok(e.rating >= 3.67, 'soft floor at A−');
    assert.ok(e.matrix.you.length >= 1 && e.matrix.they.length >= 1, 'the game admits it saw you');
  }
});
