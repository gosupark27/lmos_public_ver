// Red-team the edge-case cluster: timestamp trust, vote integrity, conflicting intents.
// "80% of bugs live here."
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeTable } from './helpers.mjs';
import { runBotGame } from '../scripts/sim-lib.mjs';
import { RES, LIMITS } from '../public/engine/constants.js';
import { voteEligible } from '../public/engine/legal.js';
import { makeRng } from '../public/engine/rng.js';

function toVote(T, accusedArch = 'broker') {
  T.state.secret.outbreak.threshold = 999;
  T.allReady(); T.act(); T.skipTo('talk');
  T.state.heat = 40;
  T.allReady();
  const accused = T.seatOf(accusedArch);
  const accuser = T.state.seats.find((s) => s.id !== accused.id);
  T.act({ [accuser.id]: { kind: 'accuse', target: accused.id } });
  T.skipTo('vote');
  return accused;
}

test('vote integrity: one ballot per seat, the accused cannot vote, ballots carry no client weight', () => {
  const T = makeTable({ seats: 5 });
  T.start();
  const accused = toVote(T);
  assert.equal(T.intent(accused.id, { k: 'vote', yes: false }).err, 'not_eligible');
  const voter = T.state.seats.find((s) => s.id !== accused.id);
  T.intent(voter.id, { k: 'vote', yes: true, weight: 99, stake: true });
  T.intent(voter.id, { k: 'vote', yes: false });
  assert.equal(Object.keys(T.state.vote.votes).length, 1, 'changing a vote replaces it');
  assert.equal(T.state.vote.votes[voter.id].yes, false);
  assert.ok(!('weight' in T.state.vote.votes[voter.id]));
  if (voter.archetype !== 'idealist') assert.equal(T.state.vote.votes[voter.id].stake, false, 'only conviction can stake');
  assert.equal(T.intent(voter.id, { k: 'vote', yes: 'yes' }).err, 'bad_vote');
});

test('vote integrity: outsiders cannot vote and cannot be accused', () => {
  const T = makeTable({ seats: 5 });
  T.start();
  T.state.secret.outbreak.threshold = 999;
  T.allReady(); T.act(); T.skipTo('talk');
  T.state.heat = 30;
  T.allReady();
  const lead = T.state.lead;
  const target = T.state.seats.find((s) => s.id !== lead);
  T.act({ [lead]: { kind: 'boundary', target: target.id } });
  T.skipTo('talk');
  assert.equal(target.outsideRound, T.state.round);
  T.allReady();
  const other = T.state.seats.find((s) => s.id !== lead && s.id !== target.id);
  const r = T.intent(other.id, { k: 'act', a: { kind: 'accuse', target: target.id } });
  assert.equal(r.err, 'bad_target', 'you cannot accuse someone outside the line');
  const third = T.state.seats.find((s) => ![lead, target.id, other.id].includes(s.id));
  T.act({ [other.id]: { kind: 'accuse', target: third.id } });
  T.skipTo('vote');
  assert.ok(!voteEligible(T.state).includes(target.id));
  assert.equal(T.intent(target.id, { k: 'vote', yes: true }).err, 'not_eligible');
});

test('conflicting intents: two trades that spend the same supplies cannot both settle', () => {
  const T = makeTable({ seats: 4 });
  T.start();
  const [a, b, c] = T.state.seats;
  a.res.water = 1;
  const o1 = T.intent(a.id, { k: 'offer', to: b.id, give: { water: 1 }, get: { rations: 1 } });
  const o2 = T.intent(a.id, { k: 'offer', to: c.id, give: { water: 1 }, get: { rations: 1 } });
  assert.ok(o1.ok && o2.ok);
  assert.ok(T.intent(b.id, { k: 'accept', offer: o1.result.offer }).ok);
  const second = T.intent(c.id, { k: 'accept', offer: o2.result.offer });
  assert.equal(second.err, 'they_cannot_pay');
  assert.equal(a.res.water, 0);
  for (const s of T.state.seats) for (const r of RES) assert.ok(s.res[r] >= 0);
});

test('replayed intents never apply twice', () => {
  const T = makeTable({ seats: 4 });
  T.start();
  const [a, b] = T.state.seats;
  a.res.water = 2;
  const off = T.intent(a.id, { k: 'offer', id: 'o-1', to: b.id, give: { water: 1 }, get: { rations: 1 } });
  const accept = { k: 'accept', id: 'acc-1', offer: off.result.offer };
  const r1 = T.intent(b.id, accept);
  const r2 = T.intent(b.id, accept);
  assert.ok(r1.ok && r2.replay);
  assert.equal(T.io.ledger.filter((e) => e.kind === 'trade').length, 1);
  // Another seat reusing the same id is a different intent.
  const r3 = T.intent(a.id, { ...accept });
  assert.equal(r3.replay, undefined);
});

test('gifts that no longer fit after a debt is called in are clamped, never negative', () => {
  const T = makeTable({ seats: 4 });
  T.start();
  T.state.secret.outbreak.threshold = 999;
  T.allReady(); T.act(); T.skipTo('talk'); T.allReady();
  const broker = T.seatOf('broker');
  const debtor = T.state.seats.find((s) => s.id !== broker.id);
  broker.assets.leverage[debtor.id] = 1;
  debtor.res.rations = 1;
  const to = T.state.seats.find((s) => s.id !== broker.id && s.id !== debtor.id);
  T.act({ [broker.id]: { kind: 'callin', target: debtor.id, res: 'rations' }, [debtor.id]: { kind: 'give', target: to.id, res: 'rations', n: 1 } });
  assert.equal(debtor.res.rations, 0);
  assert.ok(T.io.ledger.some((e) => e.kind === 'callin'));
  assert.ok(!T.io.ledger.some((e) => e.kind === 'gift' && e.round === T.state.round), 'the gift had nothing left to give');
});

test('fuzz: random and malformed intents from every seat never crash or break conservation', () => {
  const KINDS = ['ready', 'word', 'founding', 'talk', 'silence', 'offer', 'accept', 'decline', 'cancel', 'act', 'vote', 'prodigal', 'config', 'start', 'nonsense'];
  const ACTS = ['contribute', 'give', 'forage', 'still', 'look', 'accuse', 'vouch', 'claim_lead', 'hold_lead', 'boundary', 'rally', 'stir', 'calm', 'peek', 'callin', 'witness', 'sacrifice', 'spoil', 'stoke', 'esther', 'return', 'presence', '__proto__'];
  const junk = [null, undefined, -1, 0, 1, 2, 99, 1.5, 'x', '1', {}, [], true, NaN, '<script>alert(1)</script>', 'water', 'timber', 'rations'];
  for (let g = 0; g < 40; g++) {
    const fz = { s: 12345 + g };
    const r = makeRng(fz, 's');
    runBotGame({
      seed: 3000 + g, seats: 4 + (g % 9), tier: 1 + (g % 5), fast: false,
      chaos: (core, t) => {
        const s = core.state;
        for (let i = 0; i < 6; i++) {
          const seat = r.int(s.seats.length + 1) - (r.chance(0.1) ? 1 : 0);
          const k = r.pick(KINDS);
          const msg = {
            k, id: r.chance(0.3) ? 'dup' : `f${g}-${t}-${i}`, ps: r.chance(0.8) ? s.phaseSeq : r.pick(junk),
            kind: r.chance(0.5) ? r.pick(['contribute', 'give', 'still', 'clean', 'holding', 'need', 'vote', 'accuse', 'truth']) : r.pick(junk),
            target: r.pick([...s.seats.map((x) => x.id), ...junk]), res: r.pick([...RES, ...junk]), n: r.pick([1, 2, 3, ...junk]),
            yes: r.pick([true, false, ...junk]), text: r.pick(['hello', 'x'.repeat(500), '‮ evil', ...junk]),
            to: r.pick([...s.seats.map((x) => x.id), ...junk]), give: r.pick([{ water: 1 }, { timber: 2 }, { water: -3 }, junk[0]]),
            get: r.pick([{ rations: 1 }, { water: 1 }, {}]), offer: r.int(10), choice: r.pick(['confess', 'silent', 'x']),
            a: { kind: r.pick(ACTS), target: r.pick([...s.seats.map((x) => x.id), ...junk]), res: r.pick([...RES, ...junk]), n: r.pick([1, 2, 5, ...junk]) },
            config: { tier: r.pick([1, 3, 9, 'x']), seats: r.pick([2, 6, 40]) },
          };
          try {
            core.intent(seat, msg, t);
          } catch (e) {
            assert.fail(`intent ${k} threw: ${e.stack}`);
          }
        }
      },
      onTick: (core) => {
        const s = core.state;
        for (const seat of s.seats) {
          for (const res of RES) assert.ok(Number.isInteger(seat.res[res]) && seat.res[res] >= 0, `seat ${seat.id} ${res}=${seat.res[res]}`);
          assert.ok(seat.presence >= 0 && seat.presence <= 100);
          const said = s.words.filter((w) => w.seat === seat.id && w.round === s.round && !w.founding).length;
          assert.ok(said <= LIMITS.wordsPerRound);
        }
        assert.ok(s.heat >= 0 && s.heat <= 100);
        assert.ok(s.health >= 0 && s.health <= 2);
        if (s.vote) for (const id of Object.keys(s.vote.votes)) assert.ok(voteEligible(s).includes(Number(id)));
        for (const c of s.chat) assert.ok(c.text.length <= LIMITS.talkMax && !/[‮]/.test(c.text));
      },
    });
  }
});

test('all-bot games always finish', () => {
  for (let i = 0; i < 200; i++) {
    const { core } = runBotGame({ seed: 7000 + i, seats: 4 + (i % 9), tier: 1 + (i % 5) });
    assert.equal(core.state.phase, 'end');
    assert.ok(['peace', 'arrived', 'lost'].includes(core.state.result.kind));
  }
});
