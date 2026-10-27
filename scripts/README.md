# Capture

`scripts/capture.py` reads `config/sources.txt`, fetches each enabled public repo, and seals new commits into this tracker. It uses `git ls-remote` and `git clone` over HTTPS. It does not write to the source repos.

```bash
python3 scripts/capture.py
```

Python 3.11 or newer. The script uses the standard library plus `git`, `diff`, and `patch`.

## Exit codes

| code | meaning |
| --- | --- |
| 0 | Every enabled source was unchanged or newly sealed. |
| 1 | An enabled source could not be read. Other sources are still sealed. |
| 2 | The sources file is missing, or `--enable` names an unknown model. |

## Idempotency

An unchanged commit does not clone the tree and does not seal another snapshot. The first observation of a GitHub rename or a label question appends one event and can write `state/repo_registry.json`. Repeating that observation writes nothing. The probe is `git ls-remote` for GitHub and `git rev-parse` for a local checkout. When a line has `repo_id=`, capture resolves it with `GET /repositories/{id}` and follows that canonical `full_name`, so a rename does not open a new model. `node_id=` is checked against the same payload. `attribution=confirmed` records Josh's label and does not append another uncertain-attribution event. `attribution=pending` leaves the slot empty. A sealed model label is not rewritten from that id.

If a seal is interrupted before `.complete`, the next run either finishes appending the already-written event excerpt or deletes the partial snapshot and captures again. Event ids are deterministic per commit, so a replay does not duplicate lines.

## Add a model

Placeholders are commented lines in `config/sources.txt`:

```
# grok gosupark27/lmos_public_grok repo_id=1435127338 node_id=R_kgDOVYpOKg attribution=pending
```

`repo_id` is optional and, once known, required for honesty. `node_id` is the same repository's GraphQL node id. Two lines with the same id are one repository. The later one is commented out and a `LABEL_MISMATCH` is appended. A commented `PROBE owner/repo` line is checked for existence and is not a model. `# ALIASES <repo_id> owner/repo ...` lists previous names. `# ALIAS_HOP <repo_id> old new observed_at=<time>` asks capture to verify both names and append `REPO_RENAMED` once.

One command, once that repo exists:

```bash
python3 scripts/capture.py --enable grok
```

`--enable` uncomments the line only after the remote advertises a HEAD. A missing repo leaves the placeholder commented.

Editing the file by hand is the same change: delete the leading `#` and the following space, then run `python3 scripts/capture.py`.

A local checkout works in place of `owner/repo` if the target is an absolute path. Tests use that. The real sources are GitHub repos.

## What a run writes

- `snapshots/<model>/<UTC stamp>__<commit>/manifest.json` — file tree, sizes, sha256, commit URL.
- `snapshots/<model>/<UTC stamp>__<commit>/baseline/` — full bytes, first snapshot of that model only.
- `deltas/over_time/<model>/<snapshot id>.patch` — unified text diff from the previous seal. Later trees are rebuilt by applying these patches to the baseline.
- `deltas/over_time/<model>/<snapshot id>.blobs/` — raw bytes for binary files that changed.
- `deltas/over_time/<model>/<snapshot id>.md` and `.json` — the path-level add, remove, and modify list.
- `deltas/cross_model/<UTC stamp>.md` and `.json` — peer diff when two labels have trees, or a spec comparison when identity could not be checked.
- `deltas/cross_model/single-<repo id>__<sha>.md` — one GitHub id has the only tree. Pairs are empty. Aliases are not scored against each other.
- `state/repo_registry.json` — repo id, current slug, names seen, and the assigned label.
- `trends/snapshots.csv` and `TRENDS.md` — one row per snapshot. Rebuilt from manifests. Not append-only.
- `logs/events.jsonl` — append-only.

## Checks

```bash
python3 scripts/test_capture.py
```

The tests build temporary git repos. They do not touch GitHub.
