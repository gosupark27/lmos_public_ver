# Build ledger

Append-only, like the game's own diary. Every line says where a decision came from:

- **DECIDED**: taken from the sync file (`SPEC.md`, the Living Mirror OS sync file of 2026-10-26).
- **INFERRED**: a gap filled at build time. Each says why, so you can overrule it.
- **FLAGGED**: something in the sync file that contradicted itself or couldn't be built as written, and how it was resolved.

This build: `1.0.0`. Spec hash: `1e2c01b465b9b3e62fa898e75d6b829291e5f24a0f0bf8ae89db1a336ee10b88`.
Every game's first diary entry is stamped with that hash, so a game can always be traced to the prompt version that produced it.

---

## Entry 1 · 2026-10-26 · first build from the sync file

### Flagged before building

| # | What the file said | Resolution |
|---|---|---|
| F1 | Invariant 1: "imposter count starts at one." Saboteur section: "everyone starts clean." | Read together: **zero at the deal; the first outbreak creates exactly one; each later outbreak adds one, up to a cap** (1 for 4–6 seats, 2 for 7–9, 3 for 10–12, +1 at tier 5, max 3). "Imposter" and "saboteur" are the same thing; the UI says "turned." Tested. |
| F2 | "Ledger" meant three things: the game's event log, prompt-version history, and the Oregon Trail diary. | Two separate stores, one discipline. The **game ledger** is an append-only, hash-chained event log that players read as the trail diary. **Prompt versioning** is this file plus the spec hash stamped on every game. Prompt versions never go into game data. |
| F3 | "Ledger does NOT record [the saboteur assignment]," but the ledger is the record. Where does the secret live? | A named server-only store: the Durable Object's `secrets` table, written in the same transaction as room state. The ledger records only public deeds ("Something went missing from the cache. No one saw who."). |
| F4 | "Poll payload" vs "outbreak: simultaneous broadcast" vs "nothing secret ships to the phone." With short polling, an outbreak lands up to one poll interval apart, and lining it up means shipping it early. | **WebSockets** (Durable Object hibernation API) carry everything; the payload keeps the public snapshot + private delta split. The outbreak goes out in one loop to every phone with one server-time reveal moment. HTTP `/poll` and `/intent` remain as a fallback for catch-up. Measured skew in the end-to-end test: under 5 ms. |
| F5 | Invariant 7, "slow is fast," can't be tested. | Interpreted as a pacing rule and tested: **nothing turns before day 3**, and **heat can't rise more than 12 in one round** (it simmers, never flash-fires). |
| F6 | All 8 milestones were marked DONE while the tech stack and scenario contents were open. | Read as "designed." All 8 are now built, and each has a test named after it (`test/game.test.mjs`). |
| F7 | Two success metrics: "one-shot accuracy is the ultimate metric" and "5–10 real games fully played." | Built for the second. One-shot accuracy can't be measured from inside the build; real games can. The Node server lets you run a real game on home Wi-Fi tonight without deploying anything. |
| F8 | Secret Elo compares "public words" with actions, but nothing said how words reach the server. | **Words are structured**: pledges about what you'll do this round and claims about what's true ("I'll put 2 timber into the crossing," "I haven't turned"). The server checks every one. **Free table talk exists but is never scored**, and the UI says so. |

### The game

- DECIDED: anonymous social deduction; no login, no install, no in-game names, no faces; room codes only; phone-first, desktop for host config.
- DECIDED: four archetypes and what each gives up. INFERRED: what each *holds* mechanically.
  - Kingmaker holds a **crown**: +1 vote, can rally the train (+1 to every contribution that round). Offering: lay the crown on someone else, who becomes the lead.
  - Populist holds a **crowd** of 3: +1 vote, can stir (+3 heat) or calm (−3). Offering: send the crowd home (−10 heat).
  - Shadow Broker holds **leverage**: reads someone's mail (their supplies and whether they contributed) and gains a letter on them; calls in a debt (they pay 1 supply). Offering: burn the letters.
  - Idealist holds **conviction**: can stake a vote (counts double), and once per act can witness exactly what one person does. Offering: say "I could be wrong."
- DECIDED: twelve characters, three per archetype, period clothes. INFERRED: Wagon Master, Judge, Heir · Circuit Preacher, Fiddler, Printer · Postmaster, Fur Trader, Gambler · Schoolmarm, Surveyor, Doctor. Drawn as hats and objects only. Subtypes differ by starting supplies; per-subtype abilities are left out.
- DECIDED: nine scenarios in triads (beginner/intermediate/advanced); a 66-event canon; nine load per room; 57 parked.
  - INFERRED: **one scenario per day, one triad per act, three acts, nine days.** Act I: Genesis (founding pledges), Exodus (hoarded bread spoils), Ruth (gleaning). Act II: Joshua (silence lowers the river), Judges (no king in camp), Nehemiah (build or guard). Act III: Esther (any offering can land), Jonah (the storm calms when someone comes clean), Micah (walk humbly). The other 57 are titles and one-liners, marked parked.
- INFERRED: three crossings (Kansas Ford: timber; Snake River: timber + water; Columbia Gorge: all three), two wagons, then the Pacific.
- DECIDED: "time-bound number" was open. INFERRED: three paces. Quick (~15 min: 45 s talk, 25 s act), Standard (~25 min), Long (~40 min). Phases end early when everyone is ready. A 3-second "blitz" pace exists only when `HANDSHAKE_DEV=1`.

### Words, truthfulness, presence

- DECIDED: Secret Elo is truthfulness, not skill, and kept per player by the machine.
  - INFERRED: starts at 1500. Kept pledge +8, broken −30, true claim +4, false claim −40, breaking silence −30, confessing +60, stepping forward +80, founding pledge kept +40 at the end.
  - DECIDED: "a Shadow Broker's truthfulness means something different than an Idealist's." INFERRED weights: a Kingmaker's vote pledges count 1.5×; a Populist's words count 1.25×; a Broker's claims count 0.5× but trade pledges 2×; an Idealist's claims count 1.5×.
  - Shown to nobody until the end, where every seat's score and the specific broken words are revealed ("Day 4, you said ... You took from the cache.").
- DECIDED: Presence can't be targeted; doing nothing grows it; performing shrinks it, "desync made visible."
  - INFERRED: being still +8 (+16 while holding silence); giving +4 per unit; keeping all your pledges +3; breaking one −10; hoarding −4 per dawn; hunger −6. Others see your lantern's glow in five levels; you see the exact number. A bright table makes the river run lower.
  - INFERRED: "visible" desync means **your own sky** shifts hue and says "Seen." for that round. False claims cost Secret Elo but don't dim your lantern, so the glow isn't a lie detector.
  - Tested: no action can name presence as a target, and every presence change comes from the seat's own deeds.
- DECIDED: Silence costs Secret Elo to break. INFERRED: you take a vow in Talk; it lasts the act; speaking, trading, or table talk breaks it.

### The seven levers

- DECIDED: seven levers rewrite legal moves; heat is a simmer.
- INFERRED, as rules:
  - **Heat** is the weather: clear skies (a vote needs two accusers), warm wind, heat shimmer (dawn costs a water; offerings can land), dust storm (no foraging, no lines drawn, trades cost a water). It simmers every dawn by tier and era, and cools with presence, gifts, calming, and confession.
  - **Boundary**: the leader can put one person outside the line tomorrow: no voting, no trading, can't accuse or be accused. Costs the leader presence and heats the camp.
  - **Power**: anyone can reach for the lead; it fails if the leader holds on that round. The leader breaks vote ties.
  - **Silence**, **Influence** (vouching adds a "no" weight to any vote against that person for the act), **Hidden** (look where no one is looking: exact crossing numbers, and the act's one unwatched cache), and **Presence**, as above.

### The turning

- DECIDED: everyone starts clean; an event path promotes a clean player when pressure peaks; silent assignment; server-only.
  - INFERRED: at dawn from day 3, when heat passes a secret threshold (set by tier with random jitter), one seat turns. The draw leans toward dim lanterns, heavy wagons, and broken words. Heat drops by 12 and the next threshold rises by 15.
  - INFERRED: **the turned player is told**, privately. Nobody else is, including other turned players.
  - INFERRED: the turned can take up to 3 from the cache unseen, or feed the fire unseen. They win if the train is lost.
- DECIDED: caught by majority vote → the prodigal seat; confess out loud or stay silent; no exile.
  - INFERRED: confession restores the seat and the table feasts (+1 ration each, heat −10). Staying silent keeps the seat at the table with its sabotage powers gone; it can still come home on any later day.
  - INFERRED, from the Esther reference: a turned seat can **step forward** before anyone names it.
  - INFERRED: a majority that names a clean seat is told "not this one," and the camp heats up.

### Offerings and peace

- DECIDED: peace victory from four independent sacrifices; "sacrifice window validity" is a server-only secret; a "failed sacrifice" is a first action.
  - INFERRED: one offering per archetype. The thing is given up either way; the road accepts it only if: it wasn't announced in words this act; nothing changed hands with you that day; there was real pressure (heat shimmer or worse, warm wind in a 1775 era, the Esther day, the apocalypse, or someone turned this act); it was the only offering that day; and the giver hadn't turned.
  - Why: once players know the reward exists, a performed sacrifice stops being selfless. Hiding the rules and voiding announced or traded offerings keeps the fourth offering meaningful in game three. The epilogue explains which offerings landed and why the others didn't, so the rules can be learned by playing.
  - When the fourth lands, the table freezes with a bell. Everyone wins, including anyone who turned.
- Bots reach peace in about 1% of games; humans who learn the rules will do better.

### State boundaries (locked; all DECIDED, built as written)

Delta sync on refresh (the phone sends the last diary entry it saw and gets only what it missed); simultaneous outbreak broadcast; a stand-in takes a dropped seat after an 8-second grace (INFERRED: the grace, so a refresh doesn't trigger it), keeping the absent player's pledges, with honesty set by their Secret Elo and caution by the heat; peace freezes the table with a bell and late phones get the frozen table; clients send intents, never state; payloads split public/private; secrets stay on the server until the end.

### Rating ladder (locked)

- DECIDED: X sealed at top and easter-egg discoverable; S+ through A−; start at A; soft floor A−; true bottom "Master"; decimals to hundredths.
- INFERRED: GPA-style numbers. A = 4.00, A+ 4.33, S− 4.67, S 5.00, S+ 5.33, X 5.67 (only for a perfect road ending in peace). Honest play is floored at 3.67; Secret Elo under 1300 drops you to "Master." The grade mixes truthfulness, offerings, gifts, contributions, correct and wrong votes, coming home, presence, and the outcome.
- DECIDED: builder mark with a public rubric, half learned by playing. INFERRED: eight marks, four visible (kept your word, freely given, crossed, host) and four hidden (taken, the one who waits, came home, named truly). Marks live on the device in a server-signed passport, so they can't be forged, and show as checkmarks in the lobby.

### Sunrise, soft entrance, Oregon Trail

- DECIDED: desert sunrise from I-10; yellow novice, red intermediate, blue advanced, pink apocalypse; synced by default; desync is performance; Rome/1775 fracture by collective truthfulness; a Matrix beat.
  - INFERRED: colors follow the acts (yellow, red, blue). Pink appears at tier 5 or when the last act opens in a dust storm or with one wagon left. The sky runs on the server clock, so every phone shows the same sunrise. At acts II and III the sky cracks toward **1775** (room's average Secret Elo at or above the start) or **Rome** (below); 1775 cools the camp and lowers the rivers, Rome heats it and raises them. The Matrix beat is the end screen: "I saw everything."
- DECIDED: host-only creation; accept or leave on read; music before glow; bells stack on join; flashlight cursor; five DUPR-mapped tiers; easter eggs via room search; builder checkmarks.
  - INFERRED: tiers 2.5 Dink, 3.0 Kitchen, 3.5 Third Shot, 4.0 Erne, 4.5+ Around the Post. Higher tiers mean hotter starts, faster simmer, lower outbreak thresholds, harder crossings, and sharper bots.
  - INFERRED: the host sees counts of opened / took a seat / left on read, never names. Music and the lantern glow wait for a tap (browsers require one for sound). Fourteen easter eggs (try `x`, `capybara`, `66`, `i-10`, `1775`).
- DECIDED: the five Oregon Trail assets; resources are weight; freely given is sacrifice; traded is a ledger entry; hoarded is presence going quiet. INFERRED: rations, water, timber; over 10 carried is heavy.

### Tech stack (was an open slot)

- INFERRED: **Cloudflare Workers + one Durable Object per room** (SQLite storage, WebSocket hibernation, alarms as the server clock). One instance per room is a single writer, so the edge-case cluster (timestamp trust, vote integrity, conflicting intents) is mostly prevented by construction: intents are applied one at a time, stamped by the server clock, with replay protection by intent id.
- INFERRED: vanilla JavaScript, no framework, no build step for the server version. The rules engine (`public/engine/`) is shared by the Durable Object, the Node server, and the single-device preview.
- INFERRED: a Node 22 server (`server/dev.mjs`) that runs the same Worker and Durable Object code on a small emulation layer, so you can play without a Cloudflare account.

### Parked (respected)

Docker fleets, the ML tour, the cover image, and the submission copy were not built. The bell sound cue is parked, so the bells are simple synthesized placeholders; the locked rules that need a chime still get one.

### Trinity mapping

Kept as design meaning rather than mechanics: the narrator writes the diary, Secret Elo is the scorecard nobody sees until the end, and players who keep their word stay in good standing. The John the Baptist steward role is not a seat in this build; it survives as the "John" easter egg and parked canon event 43 ("one seat may point at the truth but cannot lead"). It needs its own design pass.

### Verified, and what wasn't

- 27 automated tests pass: the seven invariants, the eight milestones, the red-team cluster (including a fuzz test of malformed intents from every seat), and 200 complete bot games.
- 1,000 bot games: 72% arrive, 27% lost, 1% peace. Arrival falls from 90% at tier 2.5 to 55% at tier 4.5+. Something turns in 98% of games, first on day 4 (median). 1.7 turnings and 0.9 votes per game.
- End to end on the Node server: real WebSocket clients and headless Chrome played full games with bots; delta sync after a dropped connection, identical outbreak timing across phones, intact hash chains, and no secret keys on the wire.
- **Not verified**: the npm registry was blocked in the build environment, so `wrangler` and the real Workers runtime never ran. The Cloudflare code follows the current docs and runs under emulation, but the first `wrangler dev` is its first real test. Balance was tuned with bots only.
