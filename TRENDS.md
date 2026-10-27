# Trends

One row per sealed snapshot. This file is rebuilt from manifests. It is a projection, not the audit log. `logs/events.jsonl` is the log and is append-only.

`files_changed_since_last` counts adds, removes, and modifications. A baseline counts every file.

`cross_model_divergence` is empty until another model has a snapshot at or before this row. It is the mean pairwise score: 100 * (0.5 * path-Jaccard distance + 0.5 * share of common paths whose sha256 differs). 0 is identical. 100 shares no identical file.

`spec_coverage` is covered/total against `reference/concepts.json` at seal time. `spec_gap_score` is `(1 - covered/total) * 100`. Copying the spec into the source repo does not raise coverage: byte-identical spec copies are ignored, and long verbatim spec lines are ignored.

`extra_surface_count` is login kits, harness shells, and parked items that were built anyway. It is not part of the gap score.

| captured_at | model | files | lines | changed | +lines | -lines | divergence | spec coverage | spec gap | extras | peers |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 2026-10-27T01:39:49.543Z | claude | 100 | 14208 | 100 | 14208 | 0 |  | 0.8478 | 15.2 | 5 | — |

CSV: `trends/snapshots.csv`.
