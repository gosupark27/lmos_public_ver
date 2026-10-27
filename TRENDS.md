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

Repository id is the GitHub id and does not change when the slug changes. The model column above is the label Josh assigned. A rename or a mismatch does not relabel `snapshots/<model>`.

| repo_id | label | current name | commits | attribution | names |
| --- | --- | --- | --- | --- | --- |
| 1435079605 | claude | gosupark27/lmos_public_claude | yes | uncertain | gosupark27/lmos-public-claude, gosupark27/lmos-public-grok, gosupark27/lmos_public_claude |
| 1435127338 | grok | gosupark27/lmos_public_grok | yes | uncertain | gosupark27/lmos_public_grok |
| 1435128289 | chatgpt | gosupark27/lms_public_chatgpt | no | no_commits | gosupark27/lms_public_chatgpt |

- `1435079605`: Assigned label claude left unchanged. GitHub full_name is gosupark27/lmos_public_claude. README heading is # lmos-public-claude. Conclusion: uncertain.
- `1435127338`: Assigned label grok left unchanged. GitHub full_name is gosupark27/lmos_public_grok. README heading is # lmos-public-claude. Conclusion: uncertain.
- `1435128289`: gosupark27/lms_public_chatgpt (repo_id 1435128289) advertises no commits. It is not a build and it was not scored.

CSV: `trends/snapshots.csv`.
