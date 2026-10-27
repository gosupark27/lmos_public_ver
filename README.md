# Living Mirror OS — public version tracker

Josh Park (`gosupark27`) gave the same Living Mirror OS / Handshake prompt to several models and let each build a public repo. The prompt is deliberately larger than a one-shot can faithfully build. This repository is the sensor. It records what each model actually published, then keeps only the changes.

It is not a fourth copy of the game. The first seal of a model stores one full tree. Every later seal stores a delta.

Reported build times, from the experiment notes: Claude about 57 minutes across six steps, Grok about 35 minutes, ChatGPT about 33 minutes.

## Sources

Enabled lines in `config/sources.txt` are fetched. Commented lines in the same shape are placeholders and are not fetched.

| model | repo | state |
| --- | --- | --- |
| claude | [gosupark27/lmos-public-claude](https://github.com/gosupark27/lmos-public-claude) | enabled |
| grok | `gosupark27/lmos-public-grok` | placeholder, not on GitHub at first seal |
| chatgpt | `gosupark27/lmos-public-chatgpt` | placeholder |
| gpt | `gosupark27/lmos-public-gpt` | placeholder |
| openai | `gosupark27/lmos-public-openai` | placeholder |

When a placeholder repo exists:

```bash
python3 scripts/capture.py --enable grok
```

That is the whole change. The command uncomments one line and seals the new HEAD. See `scripts/README.md`.

## Layout

```
config/sources.txt                 one model per line
reference/lmos_public.md           pinned public spec
reference/concepts.json            evidence rubric used for spec gap
logs/events.jsonl                  append-only audit log
snapshots/<model>/<stamp>__<sha>/  manifest, and baseline bytes only on the first seal
deltas/over_time/<model>/          patch and path list between consecutive seals
deltas/cross_model/<stamp>.md      peer diff, or spec comparison when no peer exists
deltas/cross_model/<stamp>.json
trends/snapshots.csv               one row per seal
TRENDS.md                          the same rows, with the formulas
scripts/capture.py                 re-run the sensor
```

`TRENDS.md` and the cross-model files are projections. They can be rebuilt. `logs/events.jsonl` is the log. Do not rewrite old lines.

## Why a baseline is stored

A later patch is useless if there is no tree to apply it to. The baseline under `snapshots/<model>/<first stamp>__<sha>/baseline/` is that tree, pinned to the source commit SHA and URL in `manifest.json`. Nothing after the baseline is stored as a full copy. Text changes live in `deltas/over_time/<model>/<stamp>.patch`. Binary changes live as sha256 blobs next to that patch. `load_tree_bytes` in `scripts/capture.py` rebuilds any later seal by replaying those deltas, and the capture refuses to seal a delta that does not round-trip.

## How to read the log

One JSON object per line. Times are ISO-8601 UTC. This is the shape of a file event:

```json
{
  "timestamp": "2026-10-27T00:00:00Z",
  "event_id": "evt-claude-<sha12>-0003",
  "event_type": "FILE_ADDED",
  "severity": "info",
  "outcome": "success",
  "sensor": "lmos-tracker/capture.py",
  "model": "claude",
  "repo": "gosupark27/lmos-public-claude",
  "repo_url": "https://github.com/gosupark27/lmos-public-claude",
  "commit": "<40-hex>",
  "commit_url": "https://github.com/gosupark27/lmos-public-claude/commit/<40-hex>",
  "branch": "main",
  "snapshot_id": "<stamp>__<sha>",
  "path": "src/game/engine.server.ts",
  "hash_before": null,
  "hash_after": "sha256:<hex>",
  "line_stats": {"added": 900, "removed": 0, "binary": false},
  "message": "add src/game/engine.server.ts",
  "detail": {"size_before": null, "size_after": 30805, "binary": false}
}
```

| event_type | when it is written |
| --- | --- |
| `SNAPSHOT_CAPTURED` | A new source commit was sealed. Totals are in `detail` and `line_stats`. |
| `BASELINE_ESTABLISHED` | First seal for that model. Full bytes were stored. |
| `FILE_ADDED` | Path exists now and did not in the parent seal. |
| `FILE_REMOVED` | Path existed in the parent and does not now. |
| `FILE_MODIFIED` | Same path, different sha256. |
| `SPEC_COMPARED` | The new tree was scored against `reference/concepts.json`. |
| `CROSS_MODEL_DIVERGENCE` | Peer trees were compared, or the field `outcome` is `not_applicable` because only one model is sealed. |
| `SOURCE_UNAVAILABLE` | An enabled source could not be read. Repeated failures with the same message do not append again. |

Hashes use the prefix `sha256:`. `hash_before` is null when the path was created. `hash_after` is null when it was removed.

Useful queries:

```bash
jq -c 'select(.event_type=="FILE_MODIFIED")' logs/events.jsonl
jq -c 'select(.model=="claude" and .event_type=="SPEC_COMPARED")' logs/events.jsonl
jq -s 'map(select(.event_type=="SNAPSHOT_CAPTURED")) | .[] | {timestamp, model, commit, detail}' logs/events.jsonl
```

A single seal's events are also copied to `snapshots/<model>/<id>/seal/events.jsonl`. The authoritative log is `logs/events.jsonl`.

## Spec gap and divergence

`spec_gap_score` is `(1 - covered/total) * 100` against `reference/concepts.json`. A concept counts only when the implementation tree shows evidence. Two filters keep a pasted prompt from scoring as a build:

- a file whose bytes match `reference/lmos_public.md` is ignored
- any other line that is a verbatim spec line of 20 characters or more is ignored

`extra_surface_count` is separate. It flags things the spec excludes or parks (a login kit, a PWA shell, a bell cue) when they show up anyway. It does not change the gap score.

`cross_model_divergence` is empty until another model has a seal at or before that row. The score is:

```
100 * (0.5 * (1 - shared_paths / union_paths) + 0.5 * (changed_shared / shared_paths))
```

0 means the trees match. 100 means they share no identical file. When the shared set is empty, the content term is 1.

Path bands in the cross-model report are a heuristic for reading a noisy tree: `spec_copy`, `harness` (auth, preview, PWA, P2P), `game` (game, handshake, routes, styles), and `other`. They are not part of the score.

## The pinned spec

`reference/lmos_public.md` is the public sync file dated 2026-10-26. It is here so a later capture can score a model against the prompt instead of against a copy the model committed. Claude's repo contains a byte-identical copy; without a pinned original, that echo would look like coverage of every section.

## Re-run

```bash
python3 scripts/capture.py
```

Run it whenever a source repo moves. An unchanged HEAD is a no-op.
