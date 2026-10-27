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

An unchanged commit does nothing: no clone of the tree, no new snapshot, no appended event, no rewritten trend file. The probe is `git ls-remote` for GitHub and `git rev-parse` for a local checkout.

If a seal is interrupted before `.complete`, the next run either finishes appending the already-written event excerpt or deletes the partial snapshot and captures again. Event ids are deterministic per commit, so a replay does not duplicate lines.

## Add a model

Placeholders are commented lines in `config/sources.txt`:

```
# grok gosupark27/lmos-public-grok
```

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
- `deltas/cross_model/<UTC stamp>.md` and `.json` — peer diff, or a spec comparison when only one model is sealed.
- `trends/snapshots.csv` and `TRENDS.md` — one row per snapshot. Rebuilt from manifests. Not append-only.
- `logs/events.jsonl` — append-only.

## Checks

```bash
python3 scripts/test_capture.py
```

The tests build temporary git repos. They do not touch GitHub.
