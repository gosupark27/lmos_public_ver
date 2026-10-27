// Run many all-bot games and print balance stats.
// Usage: node scripts/simulate.mjs [games=300]
import { runBotGame } from './sim-lib.mjs';

const N = Number(process.argv[2] || 300);
const stats = {
  games: 0, outcomes: {}, firstOutbreak: [], outbreaks: 0, caught: 0, wrong: 0, hung: 0, votes: 0,
  sacrifices: 0, valid: 0, reasons: {}, peace: 0, crossings: { 1: [0, 0], 2: [0, 0], 3: [0, 0] },
  deeds: {}, confess: 0, silentProdigal: 0, esther: 0, tiers: {}, ratings: [], spoils: 0, eraRome: 0, era1775: 0,
  apocalypse: 0,
};
for (let i = 0; i < N; i++) {
  const seats = 4 + (i % 9);
  const tier = 1 + (i % 5);
  const { core, io } = runBotGame({ seed: 1000 + i, seats, tier });
  const s = core.state;
  stats.games += 1;
  stats.outcomes[s.result.kind] = (stats.outcomes[s.result.kind] || 0) + 1;
  const t = (stats.tiers[tier] ||= { games: 0, arrived: 0, lost: 0, peace: 0 });
  t.games += 1; t[s.result.kind] += 1;
  const first = s.secret.turnedHistory[0];
  if (first) stats.firstOutbreak.push(first.round);
  stats.outbreaks += s.secret.turnedHistory.length;
  for (const e of io.ledger) {
    if (e.kind === 'caught') stats.caught += 1;
    if (e.kind === 'wrong') stats.wrong += 1;
    if (e.kind === 'hung') stats.hung += 1;
    if (e.kind === 'vote_open') stats.votes += 1;
    if (e.kind === 'confess') stats.confess += 1;
    if (e.kind === 'prodigal_silent') stats.silentProdigal += 1;
    if (e.kind === 'esther') stats.esther += 1;
    if (e.kind === 'spoil') stats.spoils += 1;
    if (e.kind === 'era') e.data.era === 'rome' ? stats.eraRome++ : stats.era1775++;
    if (e.kind === 'apocalypse') stats.apocalypse += 1;
    if (e.kind === 'crossed' || e.kind === 'failed') {
      const c = stats.crossings[e.act];
      c[0] += 1; if (e.kind === 'crossed') c[1] += 1;
    }
  }
  for (const sac of s.secret.sacrifices) {
    stats.sacrifices += 1;
    if (sac.valid) stats.valid += 1;
    for (const r of sac.reasons) stats.reasons[r] = (stats.reasons[r] || 0) + 1;
  }
  if (s.peace) stats.peace += 1;
  for (const d of s.secret.deeds || []) stats.deeds[d.kind] = (stats.deeds[d.kind] || 0) + 1;
  for (const e of s.epilogue) stats.ratings.push(e.label);
}
const pct = (a, b) => (b ? ((100 * a) / b).toFixed(1) + '%' : '-');
const totalDeeds = Object.values(stats.deeds).reduce((a, b) => a + b, 0);
console.log(`games ${stats.games}`);
console.log('outcomes', Object.fromEntries(Object.entries(stats.outcomes).map(([k, v]) => [k, pct(v, stats.games)])));
console.log('by tier', JSON.stringify(stats.tiers));
const fo = stats.firstOutbreak.sort((a, b) => a - b);
console.log(`games with an outbreak ${pct(fo.length, stats.games)}; first outbreak round median ${fo[Math.floor(fo.length / 2)]}; min ${fo[0]}`);
console.log(`outbreaks/game ${(stats.outbreaks / stats.games).toFixed(2)}  votes/game ${(stats.votes / stats.games).toFixed(2)}  caught ${stats.caught}  wrong ${stats.wrong}  hung ${stats.hung}`);
console.log(`confess ${stats.confess}  silent ${stats.silentProdigal}  esther ${stats.esther}  spoil events ${stats.spoils}`);
console.log(`sacrifices ${stats.sacrifices} valid ${pct(stats.valid, stats.sacrifices)}  reasons ${JSON.stringify(stats.reasons)}  peace ${pct(stats.peace, stats.games)}`);
console.log('crossings (attempted, made):', JSON.stringify(stats.crossings));
console.log(`era: 1775 ${stats.era1775} rome ${stats.eraRome}  apocalypse lines ${stats.apocalypse}`);
console.log('deed mix', Object.fromEntries(Object.entries(stats.deeds).sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, pct(v, totalDeeds)])));
const ladder = {};
for (const r of stats.ratings) ladder[r] = (ladder[r] || 0) + 1;
console.log('grades', JSON.stringify(ladder));
