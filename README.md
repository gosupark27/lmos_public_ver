# Living Mirror OS — public version tracker

Josh Park (`gosupark27`) gave the same Living Mirror OS / Handshake prompt to several models and let each build a public repo. The prompt is deliberately larger than a one-shot can faithfully build. This repository is the sensor. It records what each model actually published, then keeps only the changes.

It is not a fourth copy of the game. The first seal of a model stores one full tree. Every later seal stores a delta.

Reported build times, from the experiment notes: Claude about 57 minutes across six steps, Grok about 35 minutes, ChatGPT about 33 minutes.

## Sources

Enabled lines in `config/sources.txt` are fetched. Commented lines in the same shape are placeholders and are not fetched.

| model | repo | repo id | state |
| --- | --- | --- | --- |
| claude | [gosupark27/lmos_public_claude](https://github.com/gosupark27/lmos_public_claude) | 1435079605 | confirmed. Node `R_kgDOVYmTtQ`. Josh says this is Claude's build. |
| grok | [gosupark27/lmos_public_grok](https://github.com/gosupark27/lmos_public_grok) | 1435127338 | enabled. Node `R_kgDOVYpOKg`. Distinct from Claude. Batch uploads may be marked PARTIAL. |
| chatgpt | [gosupark27/lmos_public_chatgpt](https://github.com/gosupark27/lmos_public_chatgpt) | 1435128289 | pending. Empty, no commits. Created as `lms_public_chatgpt`; slug is now `lmos_public_chatgpt`. |
| gpt | `gosupark27/lmos_public_gpt` | — | placeholder, not visible |
| openai | `gosupark27/lmos_public_openai` | — | placeholder, not visible |

`gosupark27/lmos-public-claude`, `gosupark27/lmos-public-grok`, `gosupark27/lmos-public_claude`, and `gosupark27/lmos_public_claude` are one repository (id 1435079605, node `R_kgDOVYmTtQ`). The live slug is `lmos_public_claude`. `lmos-public-grok` redirects to that Claude id. It is not the Grok slot. The Grok slot is `gosupark27/lmos_public_grok` (id 1435127338). `lmos-public_claude` mixes a hyphen and an underscore; it still redirects to the Claude id and is not the current name. Do not add a second model line for id 1435079605.

Repo 1435127338 (`lmos_public_grok`, node `R_kgDOVYpOKg`) is the Grok slot. It is a different id from Claude. Its commits are batch uploads, and an open batch sequence is sealed as PARTIAL.

When Josh points a pending slot at a distinct repo id:

```bash
python3 scripts/capture.py --enable <model>
```

That uncomments one line and seals the new HEAD. See `scripts/README.md`.

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
| `BASELINE_ESTABLISHED` | A full byte copy was stored. The first seal of a model does this. A later seal does it again when that commit is the first genuine build. |
| `FILE_ADDED` | Path exists now and did not in the parent seal. |
| `FILE_REMOVED` | Path existed in the parent and does not now. |
| `FILE_MODIFIED` | Same path, different sha256. |
| `SPEC_COMPARED` | The new tree was scored against `reference/concepts.json`. |
| `CROSS_MODEL_DIVERGENCE` | Peer trees were compared, or `outcome` is `not_applicable` because one repository is sealed. `detail.mode` `single_repository` means the names are aliases and no pair was scored. |
| `SOURCE_UNAVAILABLE` | An enabled source could not be read. Repeated failures with the same message do not append again. |
| `REPO_RENAMED` | The GitHub slug for a known repo id changed. `detail` has `old_name`, `new_name`, `repo_id`, and `detected_at`. The sealed label is not changed. |
| `LABEL_MISMATCH` | The assigned label, the current slug, or the README heading disagree, or two lines resolved to one repo id. The sealed label is not changed. |
| `MODEL_ATTRIBUTION_UNCERTAIN` | The tree does not identify one model cleanly. `outcome` is `uncertain`. The sealed label is left as Josh assigned it. |
| `MODEL_ATTRIBUTION_CORRECTED` | Josh confirmed the label for a repo id. Earlier uncertain events stay in the log. The sealed directory is not moved. |
| `LABEL_MISMATCH_RESOLVED` | The current GitHub slug now matches `lmos_public_<model>`. The earlier mismatch event stays in the log. |
| `REPO_DISCOVERED` | A repo id was seen for a slot and has no commits yet, so it was not sealed. |
| `PROMPT_VERSION_RECORDED` | The prompt version assigned to a model. `sha256` is `pending` when that text is not in the tracker yet. |
| `LABEL_MISMATCH_CONFIRMED` | A later commit message identifies earlier trees of this repo id as a different model's content. Those snapshots stay on disk. Earlier events are not rewritten. |
| `BUILD_METADATA_RECORDED` | Build version, spec hash, flagged contradictions, and a test count taken from the tree. A test count is claimed unless the tracker ran the tests. |

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

Each source line may carry `repo_id=<GitHub id>`, `node_id=<node id>`, and `attribution=confirmed` or `attribution=pending`. Capture resolves `repo_id` with `GET /repositories/{id}`. The slug is only the current name. `state/repo_registry.json` maps an id to every name seen for it.

The label in `config/sources.txt` is the one Josh assigned. Capture will not move `snapshots/claude` or rewrite a sealed manifest when the slug or the README heading changes. A rename appends `REPO_RENAMED`. A naming question appends `LABEL_MISMATCH`. `attribution=confirmed` appends `MODEL_ATTRIBUTION_CORRECTED` once and does not append another `MODEL_ATTRIBUTION_UNCERTAIN` for that confirmation.

Repo id 1435079605 is the Claude slot. Josh confirmed that. The live slug is `lmos_public_claude`. Commit `3a3cd7e97db2` says the files it removed were the Grok-generated build that was renamed to `lmos-public-claude`. Seals through `46018f1` are that content. The full snapshot of `3a3cd7e97db2` is Claude's first genuine baseline: README heading `# Handshake`, package name `handshake`. The slug was also `lmos-public-grok` and, briefly, `lmos-public_claude` (hyphen then underscore). Those names are aliases of this id. Repo id 1435127338 (`lmos_public_grok`) is the Grok slot. It is not repo 1435079605. `lms_public_chatgpt` was renamed to `lmos_public_chatgpt` (id 1435128289, updated_at 2026-10-27T02:08:59Z). The live ChatGPT slug matches `lmos_public_chatgpt`. The repo still has no commits, so the slot is not sealed. Claude and Grok are recorded on prompt `PV-0.9.0-full`. ChatGPT is assigned `PV-0.10-lite`, whose text is not in this tracker yet. A ChatGPT-versus-Claude comparison confounds model and prompt.
