# Trends

One row per sealed snapshot. This file is rebuilt from manifests. It is a projection, not the audit log. `logs/events.jsonl` is the log and is append-only.

`files_changed_since_last` counts adds, removes, and modifications. A baseline counts every file.

`cross_model_divergence` is empty until another model has a snapshot at or before this row. It is the mean pairwise score: 100 * (0.5 * path-Jaccard distance + 0.5 * share of common paths whose sha256 differs). 0 is identical. 100 shares no identical file.

`spec_coverage` is covered/total against `reference/concepts.json` at seal time. `spec_gap_score` is `(1 - covered/total) * 100`. Copying the spec into the source repo does not raise coverage: byte-identical spec copies are ignored, and long verbatim spec lines are ignored.

`extra_surface_count` is login kits, harness shells, and parked items that were built anyway. It is not part of the gap score.

| captured_at | model | files | lines | changed | +lines | -lines | divergence | spec coverage | spec gap | extras | peers |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 2026-10-27T01:39:49.543Z | claude | 100 | 14208 | 100 | 14208 | 0 |  | 0.8478 | 15.2 | 5 | — |
| 2026-10-27T01:56:07.023Z | claude | 100 | 14208 | 1 | 1 | 1 |  | 0.8478 | 15.2 | 5 | — |
| 2026-10-27T01:57:04.540Z | grok | 16 | 1075 | 16 | 1075 | 0 | 42.0 | 0.1522 | 84.8 | 3 | claude |
| 2026-10-27T01:57:57.542Z | grok | 19 | 1623 | 3 | 548 | 0 | 40.5 | 0.1739 | 82.6 | 3 | claude |
| 2026-10-27T01:59:16.646Z | grok | 24 | 2625 | 5 | 1002 | 0 | 38.0 | 0.1957 | 80.4 | 3 | claude |
| 2026-10-27T02:00:18.087Z | grok | 26 | 3247 | 2 | 622 | 0 | 37.0 | 0.2174 | 78.3 | 3 | claude |
| 2026-10-27T02:19:02.998Z | grok | 67 | 11031 | 41 | 7784 | 0 | 18.7 | 0.8478 | 15.2 | 4 | claude |
| 2026-10-27T02:19:36.777Z | grok | 72 | 11739 | 5 | 708 | 0 | 16.1 | 0.8478 | 15.2 | 4 | claude |
| 2026-10-27T02:28:10.359Z | claude | 54 | 8270 | 151 | 8257 | 14195 | 98.8 | 0.8913 | 10.9 | 0 | grok |
| 2026-10-27T02:28:10.359Z | grok | 72 | 11662 | 9 | 262 | 339 | 98.8 | 0.8478 | 15.2 | 4 | claude |
| 2026-10-27T02:30:20.240Z | grok | 72 | 11775 | 3 | 222 | 109 | 98.8 | 0.8478 | 15.2 | 4 | claude |
| 2026-10-27T02:36:21.013Z | claude | 54 | 8270 | 54 | 8270 | 0 | 98.8 | 0.8913 | 10.9 | 0 | grok |
| 2026-10-27T02:36:29.084Z | grok | 86 | 13342 | 20 | 1720 | 153 | 98.9 | 0.8478 | 15.2 | 5 | claude |

`grok` `e5f7e8d1b232` is PARTIAL. HEAD is still an Add original source batch commit. Batches seen: 0–17. repeated batches [8].
`grok` `2787eed5fe99` is PARTIAL. HEAD is still an Add original source batch commit. Batches seen: 0–18. repeated batches [8].
`grok` `bc6aef95e1df` is PARTIAL. HEAD `Restore original migrations/0002_rooms.sql` is not a batch commit. Batches seen: 0–18. repeated batches [0, 1, 2, 8].
`grok` `a5bf80de5c7a` is PARTIAL. HEAD `Restore original migrations/auth/0001_auth.sql` is not a batch commit. Batches seen: 0–18. repeated batches [0, 1, 2, 8].
`grok` `842c2a1cb56a` is PARTIAL. HEAD `Restore original src/lib/multiplayer/p2p.ts` is not a batch commit. Batches seen: 0–18. repeated batches [0, 1, 2, 8].

## Genuine baseline

`claude` `3a3cd7e97db2` is the first genuine build baseline for repo 1435079605. It is a full tree, not a patch on the earlier seals.

The commit message says: "the Grok-generated build that was renamed to lmos-public-claude."

Snapshots of this repo through `46018f12b4d2` are the content that commit removed. Any claude-versus-Grok conclusion drawn from those snapshots is invalid. The old events were not rewritten, and those snapshot directories were not moved.

`git diff --find-renames 46018f12b4d2..3a3cd7e97db2` changes 150 files: 50 added, 96 removed, 3 modified, 1 renamed (docs/lmos_public.md → SPEC.md), 8102 insertions, 14040 deletions.

Build 1.0.0 reports spec hash `1e2c01b465b9b3e62fa898e75d6b829291e5f24a0f0bf8ae89db1a336ee10b88` (PV-0.9.0-full). Flagged contradictions: F1, F2, F3, F4, F5, F6, F7, F8. Decision labels in the ledger: DECIDED, INFERRED, FLAGGED. Tests claimed passing: 27. The tracker did not run them. Stack recorded from the ledger and package.json: Cloudflare Worker, one Durable Object per room, WebSockets, vanilla JS client, no package dependencies.

Sealed models: claude, grok. Mean pairwise divergence 98.9. PARTIAL: grok batch history still repeats or skips. claude 3a3cd7e97db2 is the first genuine build baseline. A claude-versus-peer score that uses a snapshot through 46018f12b4d2 is invalid.

## Identity

Repository id is the GitHub id and does not change when the slug changes. Capture reads `GET /repositories/{id}` and keeps one model for that id. A rename appends `REPO_RENAMED` and does not relabel `snapshots/<model>`.

| repo_id | node_id | label | current name | commits | attribution | counts | names |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1435079605 | R_kgDOVYmTtQ | claude | gosupark27/lmos_public_claude | yes | confirmed | yes | gosupark27/lmos-public-claude, gosupark27/lmos-public-grok, gosupark27/lmos-public_claude, gosupark27/lmos_public_claude |
| 1435127338 | R_kgDOVYpOKg | grok | gosupark27/lmos_public_grok | yes | assigned | yes | gosupark27/lmos_public_grok |
| 1435128289 | R_kgDOVYpR4Q | chatgpt | gosupark27/lmos_public_chatgpt | no | pending | no | gosupark27/lmos_public_chatgpt, gosupark27/lms_public_chatgpt |

## Model slots

A slot counts a repository when its source line says `attribution=confirmed` or `attribution=assigned` on that repo id. A pending slot stays empty.

| model | state | repos | repo_id |
| --- | --- | --- | --- |
| claude | tracked | 1 | 1435079605 |
| grok | tracked | 1 | 1435127338 |
| chatgpt | pending | 0 | — |

Claude: 1 repo tracked; Grok: 1 repo tracked; ChatGPT: none.

## Rename timeline

One repo id keeps one model. These rows are slug changes, including names that only remain as redirects.

- `2026-10-27T01:56:07.023Z`: `gosupark27/lmos-public-claude` → `gosupark27/lmos-public-grok` (repo 1435079605)
- `2026-10-27T01:59:48Z`: `gosupark27/lmos-public-grok` → `gosupark27/lmos-public_claude` (repo 1435079605)
- `2026-10-27T02:00:16Z`: `gosupark27/lmos-public_claude` → `gosupark27/lmos_public_claude` (repo 1435079605)
- `2026-10-27T02:00:18.087Z`: `gosupark27/lmos-public-claude` → `gosupark27/lmos_public_claude` (repo 1435079605)
- `2026-10-27T02:08:59Z`: `gosupark27/lms_public_chatgpt` → `gosupark27/lmos_public_chatgpt` (repo 1435128289)

- `1435079605`: Josh confirmed repo_id 1435079605 is the claude build. GitHub full_name is gosupark27/lmos_public_claude. node_id is R_kgDOVYmTtQ. README heading is # Handshake.
- `1435127338`: Repo id 1435127338 is the grok slot and is a different id from the other sealed models. GitHub full_name is gosupark27/lmos_public_grok. README heading is # lmos_public_grok.
- `1435128289`: Slot chatgpt is pending. gosupark27/lmos_public_chatgpt (repo_id 1435128289) advertises no commits and was not scored.

## Prompt versions

Each model ran a named prompt. The SHA-256 is the pinned spec file when that file is in this tracker. `pending` means the text is not here yet.

| model | prompt | file | sha256 | status |
| --- | --- | --- | --- | --- |
| claude | PV-0.9.0-full | reference/lmos_public.md | `1e2c01b4…0b88` | pinned |
| grok | PV-0.9.0-full | reference/lmos_public.md | `1e2c01b4…0b88` | pinned |
| chatgpt | PV-0.10-lite | pending | `pending` | text-pending |

claude, grok ran PV-0.9.0-full (`reference/lmos_public.md`). chatgpt is assigned PV-0.10-lite, the lightweight prompt, and that text is still pending. ChatGPT versus Claude or Grok is a big prompt against a lightweight prompt. Model and prompt are confounded. It is not a model-versus-model comparison.

CSV: `trends/snapshots.csv`.
