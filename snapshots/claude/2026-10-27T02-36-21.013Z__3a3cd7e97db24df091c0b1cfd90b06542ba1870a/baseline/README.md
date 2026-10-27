# Handshake

Anonymous social deduction on the westward trail. Four to twelve people, one phone each, no login, no install, no names, no faces. Room codes only.

Built from the Living Mirror OS sync file (`SPEC.md`). Every gap that file left open was filled at build time and is marked **INFERRED** in [`BUILD_LEDGER.md`](BUILD_LEDGER.md), with the reason, so nothing invented passes as a decision you made.

## Play tonight, on your own Wi-Fi

You need Node 22 or newer. Nothing to install.

```bash
node --no-warnings server/dev.mjs
```

It prints your Wi-Fi address. Open that address on your computer (not `localhost`, or the invite link will point at your own machine), tap **Host a table**, and send the invite link to everyone's phone. Everyone needs to be on the same Wi-Fi. Turn on stand-ins and bots fill the empty seats. Rooms are saved in `.data/` and survive a restart.

To try it alone first, tap **Practice with bots**.

## Put it on the internet (Cloudflare)

```bash
npm install --save-dev wrangler
npx wrangler login
npx wrangler secret put PASSPORT_SECRET   # any long random string; it signs builder marks
npx wrangler deploy
```

For local Cloudflare development, copy `.dev.vars.example` to `.dev.vars` and run `npx wrangler dev`.

The Cloudflare path has not run on the real Workers runtime yet: the build environment couldn't reach npm. It runs under the emulation in `server/cf-shim.mjs`, which is how the end-to-end test exercises it. Expect the first `wrangler dev` to be its real first run.

## How a game goes

Three acts of three days. Each day: **Talk** (say up to two things the game will check against what you do, trade, or hold silence), **Act** (one deed), then read what happened. A call to account becomes a vote. Each act ends at a river; put enough into the crossing cache or lose a wagon. Lose both and the trail takes everyone.

From day three, when the camp runs hot enough, someone turns. Only they know. Name them by majority and they get the prodigal seat. Make four offerings the road accepts, one per archetype, and the table freezes in peace. The full rules are under **Rules** in the app; the hidden ones are learned by playing, and the epilogue explains them.

## Project map

```
public/engine/   the rules: one engine shared by the server, the Node server, and the preview
  core.js        RoomCore, the single writer for a room (intents, timers, bots, broadcast)
  rules.js       dawn, deeds, votes, the prodigal seat, crossings
  intents.js     every client message is an intent; validated here
  legal.js       what each seat may do right now (the levers live here)
  views.js       the only place payloads are built: public snapshot + private delta
  bots.js        stand-ins and fill-in seats; they see only what a phone sees
  ladder.js      grades, builder marks, and the end-of-game reveal
public/app/      the phone client (vanilla JS, no build step)
src/worker.js    Cloudflare Worker: static files + room routing; host-only room creation
src/room.js      the Durable Object: SQLite storage, WebSockets, alarms
server/          Node server and the Cloudflare emulation it runs on
preview/         bundles everything into one page: the single-device preview
test/            invariants, milestones, the red-team cluster
scripts/         bot simulations and the end-to-end smoke test
```

## Checks

```bash
npm test                                  # 27 tests: invariants, milestones, red team, 200 bot games
node scripts/simulate.mjs 1000            # balance report over 1,000 bot games
node --no-warnings scripts/smoke.mjs      # real server, real WebSockets, a full game
node preview/build-preview.mjs            # dist/handshake-preview.html
```

| Invariant | Where it's enforced | Test |
|---|---|---|
| Imposter count starts at one, stacks to cap | `rules.js` `maybeOutbreak` | invariants 1 |
| Sacrifice is idempotent | `legal.js` `canSacrifice`, intent ids in `core.js` | invariants 2 |
| Clock is server-owned | `core.js` (late and stale intents refused; client times ignored) | invariants 3 |
| Room codes aren't guessable | `src/codes.js` (8 of 30 symbols, rejection sampled) | invariants 4 |
| Ledger appends, doesn't mutate | INSERT-only table, SHA-256 hash chain | invariants 5 |
| Clients never receive secret truth | `views.js` whitelist, `secrets` table | invariants 6, 6b |
| Slow is fast | no turning before day 3; heat +12 per round at most | invariants 7 |

## What changed from the sync file

Nothing locked was changed. Eight contradictions were resolved and are listed at the top of the build ledger (F1 to F8). The biggest: words are structured pledges and claims so the game can check them, and free table talk is never scored.
