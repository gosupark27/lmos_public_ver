# Living Mirror OS — public version tracker

Josh Park (`gosupark27`) gave the same Living Mirror OS / Handshake prompt to several models and let each build a public repo. The prompt is deliberately larger than a one-shot can faithfully build. This repository is the sensor. It records what each model actually published, then keeps only the changes.

It is not a fourth copy of the game. The first seal of a model stores one full tree. Every later seal stores a delta.

Reported build times, from the experiment notes: Claude about 57 minutes across six steps, Grok about 35 minutes, ChatGPT about 33 minutes.

## Sources

Enabled lines in `config/sources.txt` are fetched. Commented lines in the same shape are placeholders and are not fetched.

| model | repo | repo id | state |
| --- | --- | --- | --- |
| claude | [gosupark27/lmos_public_claude](https://github.com/gosupark27/lmos_public_claude) | 1435079605 | enabled. Same id was also `lmos-public-claude` and `lmos-public-grok`. Label stays `claude`. |
| grok | [gosupark27/lmos_public_grok](https://github.com/gosupark27/lmos_public_grok) | 1435127338 | enabled. Partial copy of repo 1435079605, still arriving as `batch-NN` commits. Shared paths match byte for byte. Label stays `grok`. |
| chatgpt | [gosupark27/lms_public_chatgpt](https://github.com/gosupark27/lms_public_chatgpt) | 1435128289 | placeholder. Empty, no commits. The spelling is `lms`, not `lmos`. |
| gpt | `gosupark27/lmos_public_gpt` | — | placeholder, not visible |
| openai | `gosupark27/lmos_public_openai` | — | placeholder, not visible |

`gosupark27/lmos-public-claude`, `gosupark27/lmos-public-grok`, and `gosupark27/lmos_public_claude` are the same repository (id 1435079605). The current slug is `lmos_public_claude`. Do not add a second model line for that id. `lmos_public_chatgpt` is not visible.

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
| `CROSS_MODEL_DIVERGENCE` | Peer trees were compared, or `outcome` is `not_applicable` because one repository is sealed. `detail.mode` `single_repository` means the names are aliases and no pair was scored. |
| `SOURCE_UNAVAILABLE` | An enabled source could not be read. Repeated failures with the same message do not append again. |
| `REPO_RENAMED` | The GitHub slug for a known repo id changed. `detail` has `old_name`, `new_name`, `repo_id`, and `detected_at`. The sealed label is not changed. |
| `LABEL_MISMATCH` | The assigned label, the current slug, or the README heading disagree, or two lines resolved to one repo id. The sealed label is not changed. |
| `MODEL_ATTRIBUTION_UNCERTAIN` | The tree does not identify one model cleanly. `outcome` is `uncertain`. The sealed label is left as Josh assigned it. |

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

Run it whenever a source repo moves. An unchanged HEAD does not seal another snapshot. The first time a rename or a label question is observed, that observation is appended. The same observation does not append again.

## Names and labels

Each source line may end with `repo_id=<GitHub id>`. The id is the key. The slug is the current name. `state/repo_registry.json` maps an id to every name seen for it.

The label in `config/sources.txt` is the one Josh assigned. Capture will not move `snapshots/claude` or rewrite a sealed manifest when the slug or the README heading changes. It appends `REPO_RENAMED`, `LABEL_MISMATCH`, or `MODEL_ATTRIBUTION_UNCERTAIN` and waits for Josh to confirm a relabel.

Repo id 1435079605 is the only full tree. Its current slug is `lmos_public_claude` and its README heading is `# lmos-public-claude`. Between those, the slug was `lmos-public-grok` with no extra commit. Repo id 1435127338 (`lmos_public_grok`) is a second GitHub id receiving that same tree in `batch-NN` commits. Every file present there matches 1435079605 byte for byte, so the divergence score is missing files, not a second interpretation of the spec. `lms_public_chatgpt` (id 1435128289) has no commits. `lmos_public_chatgpt` is not visible.
