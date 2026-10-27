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

Sealed models: claude, grok. Mean pairwise divergence 37.0. grok is a byte-identical subset of claude: 26 shared paths match and 74 paths exist only in claude. The score is missing files, not conflicting edits.

## Identity

Repository id is the GitHub id and does not change when the slug changes. Capture reads `GET /repositories/{id}` and keeps one model for that id. A rename appends `REPO_RENAMED` and does not relabel `snapshots/<model>`.

| repo_id | node_id | label | current name | commits | attribution | counts | names |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1435079605 | R_kgDOVYmTtQ | claude | gosupark27/lmos_public_claude | yes | confirmed | yes | gosupark27/lmos-public-claude, gosupark27/lmos-public-grok, gosupark27/lmos-public_claude, gosupark27/lmos_public_claude |
| 1435127338 | R_kgDOVYpOKg | grok | gosupark27/lmos_public_grok | yes | pending | no | gosupark27/lmos_public_grok |
| 1435128289 | R_kgDOVYpR4Q | chatgpt | gosupark27/lmos_public_chatgpt | no | pending | no | gosupark27/lmos_public_chatgpt, gosupark27/lms_public_chatgpt |

## Model slots

A slot counts a repository when `attribution=confirmed` on that repo id. A pending slot stays empty until a different repo id is confirmed.

| model | state | repos | repo_id |
| --- | --- | --- | --- |
| claude | tracked | 1 | 1435079605 |
| grok | pending | 0 | — |
| chatgpt | pending | 0 | — |

Claude: 1 repo tracked; Grok: none; ChatGPT: none.

## Rename timeline

One repo id keeps one model. These rows are slug changes, including names that only remain as redirects.

- `2026-10-27T01:56:07.023Z`: `gosupark27/lmos-public-claude` → `gosupark27/lmos-public-grok` (repo 1435079605)
- `2026-10-27T01:59:48Z`: `gosupark27/lmos-public-grok` → `gosupark27/lmos-public_claude` (repo 1435079605)
- `2026-10-27T02:00:16Z`: `gosupark27/lmos-public_claude` → `gosupark27/lmos_public_claude` (repo 1435079605)
- `2026-10-27T02:00:18.087Z`: `gosupark27/lmos-public-claude` → `gosupark27/lmos_public_claude` (repo 1435079605)
- `2026-10-27T02:08:59Z`: `gosupark27/lms_public_chatgpt` → `gosupark27/lmos_public_chatgpt` (repo 1435128289)

Seals labeled grok are history for repo 1435127338 (gosupark27/lmos_public_grok). The grok slot is pending and counts zero repositories.

- `1435079605`: Josh confirmed repo_id 1435079605 is the claude build. GitHub full_name is gosupark27/lmos_public_claude. node_id is R_kgDOVYmTtQ. README heading is # lmos-public-claude.
- `1435127338`: Slot grok is pending. repo_id 1435127338 (gosupark27/lmos_public_grok) has commits and was not sealed on this run. It counts as that model only after Josh confirms this distinct repo id.
- `1435128289`: Slot chatgpt is pending. gosupark27/lmos_public_chatgpt (repo_id 1435128289) advertises no commits and was not scored.

CSV: `trends/snapshots.csv`.
