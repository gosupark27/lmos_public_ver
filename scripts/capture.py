#!/usr/bin/env python3
"""Seal public LMOS one-shot repos into an append-only snapshot and delta log.

The first sealed snapshot of a model stores a full byte copy. Later snapshots
store a unified text patch plus raw bytes only for binary files that changed.
Re-running against an unchanged commit writes nothing.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

SCHEMA = "lmos.tracker.v1"
SENSOR = "lmos-tracker/capture.py"
SOURCE_LINE = re.compile(r"^(?P<model>[a-z][a-z0-9_-]{0,31})\s+(?P<target>\S+)\s*$")
GITHUB_REPO = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")
EVENT_FIELDS = (
    "timestamp",
    "event_id",
    "event_type",
    "severity",
    "outcome",
    "sensor",
    "model",
    "repo",
    "repo_url",
    "commit",
    "commit_url",
    "branch",
    "snapshot_id",
    "path",
    "hash_before",
    "hash_after",
    "line_stats",
    "message",
    "detail",
)


@dataclass
class Source:
    model: str
    target: str
    enabled: bool


@dataclass
class Rec:
    path: str
    data: bytes
    sha: str
    size: int
    binary: bool
    lines: int | None
    text: str | None


@dataclass
class Tree:
    model: str
    repo: str
    repo_url: str
    commit: str
    commit_url: str | None
    branch: str
    committed_at: str
    author: str
    subject: str
    files: dict[str, Rec] = field(default_factory=dict)


def utc_now() -> str:
    now = datetime.now(timezone.utc)
    millis = now.microsecond // 1000
    return now.strftime("%Y-%m-%dT%H:%M:%S.") + f"{millis:03d}Z"


def stamp_of(iso: str) -> str:
    return iso.replace(":", "-")


def sha256_bytes(data: bytes) -> str:
    return "sha256:" + hashlib.sha256(data).hexdigest()


def run(cmd: list[str], cwd: Path | None = None, check: bool = True, timeout: int = 180) -> subprocess.CompletedProcess[str]:
    env = os.environ.copy()
    env["GIT_TERMINAL_PROMPT"] = "0"
    env["GCM_INTERACTIVE"] = "Never"
    env.setdefault("LANG", "C.UTF-8")
    proc = subprocess.run(
        cmd,
        cwd=cwd,
        env=env,
        text=True,
        capture_output=True,
        timeout=timeout,
    )
    if check and proc.returncode != 0:
        detail = (proc.stderr or proc.stdout or "").strip()
        raise RuntimeError(f"{' '.join(cmd[:3])} failed ({proc.returncode}): {detail[:400]}")
    return proc


def dump_json(payload: object) -> str:
    return json.dumps(payload, indent=2, ensure_ascii=False, sort_keys=True) + "\n"


def write_if_changed(path: Path, text: str) -> bool:
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists() and path.read_text(encoding="utf-8") == text:
        return False
    path.write_text(text, encoding="utf-8")
    return True


def dump_event(event: dict) -> str:
    ordered = {key: event.get(key) for key in EVENT_FIELDS}
    return json.dumps(ordered, ensure_ascii=False, separators=(",", ":"))


def cell(value: object) -> str:
    return str(value).replace("|", "\\|").replace("\n", " ")


def default_root() -> Path:
    return Path(__file__).resolve().parent.parent


def parse_sources(text: str) -> tuple[list[Source], list[Source]]:
    enabled: list[Source] = []
    placeholders: list[Source] = []
    seen: set[str] = set()
    for raw in text.splitlines():
        stripped = raw.strip()
        if not stripped:
            continue
        commented = stripped.startswith("#")
        body = stripped[1:].strip() if commented else stripped
        match = SOURCE_LINE.match(body)
        if not match:
            continue
        model = match.group("model")
        if model in seen:
            raise SystemExit(f"duplicate model id in sources: {model}")
        seen.add(model)
        source = Source(model, match.group("target"), enabled=not commented)
        (placeholders if commented else enabled).append(source)
    return enabled, placeholders


def uncomment_model(text: str, model: str) -> tuple[str, bool]:
    changed = False
    lines: list[str] = []
    for raw in text.splitlines():
        stripped = raw.strip()
        if stripped.startswith("#"):
            match = SOURCE_LINE.match(stripped[1:].strip())
            if match and match.group("model") == model:
                lines.append(f"{match.group('model')} {match.group('target')}")
                changed = True
                continue
        lines.append(raw)
    body = "\n".join(lines)
    if text.endswith("\n") or not text:
        body += "\n"
    return body, changed


def target_kind(target: str) -> str:
    path = Path(target)
    if target.startswith(("/", ".")) or path.exists():
        return "path"
    if GITHUB_REPO.fullmatch(target):
        return "github"
    raise RuntimeError(f"not a github owner/repo or a local path: {target}")


def github_urls(target: str) -> tuple[str, str]:
    repo_url = f"https://github.com/{target}"
    return repo_url, repo_url + ".git"


def probe_head(source: Source) -> str:
    kind = target_kind(source.target)
    if kind == "path":
        proc = run(["git", "-C", source.target, "rev-parse", "HEAD"])
        return proc.stdout.strip()
    _, fetch = github_urls(source.target)
    proc = run(["git", "ls-remote", fetch, "HEAD"])
    line = proc.stdout.strip().splitlines()
    if not line or not line[0].strip():
        raise RuntimeError(f"no HEAD advertised for {source.target}")
    return line[0].split()[0]


def read_tree_from_git(source: Source, dest: Path) -> Tree:
    kind = target_kind(source.target)
    if kind == "github":
        repo_url, fetch = github_urls(source.target)
        run(["git", "clone", "--quiet", "--depth", "1", fetch, str(dest)])
        repo = source.target
    else:
        repo_url = Path(source.target).resolve().as_uri()
        repo = str(Path(source.target).resolve())
        run(["git", "clone", "--quiet", "--local", "--depth", "1", source.target, str(dest)])
    sha = run(["git", "-C", str(dest), "rev-parse", "HEAD"]).stdout.strip()
    branch = run(["git", "-C", str(dest), "rev-parse", "--abbrev-ref", "HEAD"]).stdout.strip()
    meta = run(["git", "-C", str(dest), "log", "-1", "--format=%cI%n%an%n%s"]).stdout.splitlines()
    committed = meta[0] if meta else ""
    if committed:
        committed = datetime.fromisoformat(committed).astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    author = meta[1] if len(meta) > 1 else ""
    subject = meta[2] if len(meta) > 2 else ""
    commit_url = f"{repo_url}/commit/{sha}" if kind == "github" else None
    files: dict[str, Rec] = {}
    for path in walk_files(dest):
        rel = path.relative_to(dest).as_posix()
        if rel.startswith(".git/") or rel == ".git":
            continue
        data = path.read_bytes() if not path.is_symlink() else path.readlink().as_posix().encode()
        files[rel] = rec_from(rel, data)
    return Tree(
        model=source.model,
        repo=repo,
        repo_url=repo_url,
        commit=sha,
        commit_url=commit_url,
        branch=branch,
        committed_at=committed,
        author=author,
        subject=subject,
        files=files,
    )


def walk_files(root: Path) -> list[Path]:
    found: list[Path] = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [name for name in dirnames if name != ".git"]
        for name in filenames:
            if name == ".DS_Store":
                continue
            found.append(Path(dirpath) / name)
    return sorted(found)


def rec_from(path: str, data: bytes) -> Rec:
    binary = b"\0" in data
    text = None
    lines = None
    if not binary:
        text = data.decode("utf-8", errors="replace")
        lines = len(text.splitlines())
    return Rec(path, data, sha256_bytes(data), len(data), binary, lines, text)


def snapshot_root(root: Path, model: str) -> Path:
    return root / "snapshots" / model


def parse_snapshot_id(name: str) -> tuple[str, str]:
    stamp, sha = name.split("__", 1)
    return stamp, sha


def sealed_snapshots(root: Path, model: str) -> list[Path]:
    base = snapshot_root(root, model)
    if not base.exists():
        return []
    dirs = [path for path in base.iterdir() if path.is_dir() and "__" in path.name]

    def sort_key(path: Path) -> str:
        manifest = path / "manifest.json"
        if manifest.exists():
            try:
                return json.loads(manifest.read_text(encoding="utf-8"))["captured_at"]
            except (json.JSONDecodeError, KeyError, OSError):
                return path.name
        return path.name

    dirs.sort(key=sort_key)
    return dirs


def is_complete(path: Path) -> bool:
    return (path / ".complete").exists()


def latest_complete(root: Path, model: str) -> Path | None:
    done = [path for path in sealed_snapshots(root, model) if is_complete(path)]
    return done[-1] if done else None


def load_manifest(path: Path) -> dict:
    return json.loads((path / "manifest.json").read_text(encoding="utf-8"))


def abandon_incomplete(root: Path, model: str, snap_dir: Path) -> None:
    snap_id = snap_dir.name
    for suffix in (".json", ".md", ".patch"):
        target = root / "deltas" / "over_time" / model / f"{snap_id}{suffix}"
        if target.exists():
            target.unlink()
    blobs = root / "deltas" / "over_time" / model / f"{snap_id}.blobs"
    if blobs.exists():
        shutil.rmtree(blobs)
    shutil.rmtree(snap_dir)


def load_event_ids(root: Path) -> set[str]:
    path = root / "logs" / "events.jsonl"
    found: set[str] = set()
    if not path.exists():
        return found
    for line_no, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if not line.strip():
            continue
        try:
            found.add(json.loads(line)["event_id"])
        except (json.JSONDecodeError, KeyError) as exc:
            raise SystemExit(f"corrupt event log at {path}:{line_no}: {exc}") from exc
    return found


def append_events(root: Path, events: list[dict], known: set[str]) -> int:
    path = root / "logs" / "events.jsonl"
    path.parent.mkdir(parents=True, exist_ok=True)
    wrote = 0
    with path.open("a", encoding="utf-8") as handle:
        for event in events:
            if event["event_id"] in known:
                continue
            handle.write(dump_event(event) + "\n")
            known.add(event["event_id"])
            wrote += 1
        handle.flush()
        os.fsync(handle.fileno())
    return wrote


def last_unavailable_message(root: Path, model: str) -> str | None:
    path = root / "logs" / "events.jsonl"
    if not path.exists():
        return None
    last: str | None = None
    cleared = False
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        event = json.loads(line)
        if event.get("model") != model:
            continue
        if event.get("event_type") == "SOURCE_UNAVAILABLE":
            last = event.get("message")
            cleared = False
        elif event.get("event_type") == "SNAPSHOT_CAPTURED":
            cleared = True
            last = None
    return None if cleared else last


def export_text(files: dict[str, bytes], dest: Path) -> None:
    if dest.exists():
        shutil.rmtree(dest)
    dest.mkdir(parents=True)
    for path, data in files.items():
        if b"\0" in data:
            continue
        target = dest / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)


def normalize_diff(raw: str) -> str:
    lines: list[str] = []
    for line in raw.splitlines(keepends=True):
        if line.startswith("Binary files ") or line.startswith("diff -ruN "):
            continue
        if line.startswith("--- ") or line.startswith("+++ "):
            meta, _, rest = line.partition("\t")
            path = meta[4:]
            epoch = rest.startswith("1970-01-01")
            if path.startswith("old/"):
                label = "/dev/null" if epoch else "a/" + path[4:]
            elif path.startswith("new/"):
                label = "/dev/null" if epoch else "b/" + path[4:]
            else:
                label = path
            lines.append(f"{meta[:4]}{label}\n")
            continue
        lines.append(line if line.endswith("\n") else line + "\n")
    return "".join(lines)


def text_patch(old: dict[str, bytes], new: dict[str, bytes]) -> str:
    with tempfile.TemporaryDirectory() as tmp:
        parent = Path(tmp)
        export_text(old, parent / "old")
        export_text(new, parent / "new")
        proc = subprocess.run(
            ["diff", "-ruN", "old", "new"],
            cwd=parent,
            text=True,
            capture_output=True,
        )
        if proc.returncode not in (0, 1):
            raise RuntimeError(proc.stderr.strip() or "diff failed")
        for line in proc.stdout.splitlines():
            if line.startswith("Only in "):
                raise RuntimeError(f"diff could not express a tree change as a hunk: {line}")
        return normalize_diff(proc.stdout)


def split_patch(patch: str) -> dict[str, str]:
    """Map a relative path to its unified-diff chunk."""
    chunks: dict[str, list[str]] = {}
    current: str | None = None
    for line in patch.splitlines(keepends=True):
        if line.startswith("--- "):
            current = None
            chunks.setdefault("__pending__", [])
            # start a new chunk on the next +++ 
            bucket: list[str] = [line]
            chunks["__open__"] = bucket
            continue
        if line.startswith("+++ ") and "__open__" in chunks:
            label = line[4:].strip()
            if label == "/dev/null":
                minus = chunks["__open__"][0][4:].strip()
                path = minus[2:] if minus.startswith("a/") else minus
            else:
                path = label[2:] if label.startswith("b/") else label
            current = path
            chunks[current] = chunks.pop("__open__")
            chunks[current].append(line)
            continue
        if current and current in chunks:
            chunks[current].append(line)
    chunks.pop("__pending__", None)
    chunks.pop("__open__", None)
    return {path: "".join(body) for path, body in chunks.items()}


def line_stats_from_chunk(chunk: str, binary: bool) -> dict:
    if binary:
        return {"added": 0, "removed": 0, "binary": True}
    added = removed = 0
    for line in chunk.splitlines():
        if line.startswith("+") and not line.startswith("+++"):
            added += 1
        elif line.startswith("-") and not line.startswith("---"):
            removed += 1
    return {"added": added, "removed": removed, "binary": False}


def binary_changes(old: dict[str, Rec], new: dict[str, Rec]) -> list[dict]:
    ops: list[dict] = []
    for path in sorted(set(old) | set(new)):
        before = old.get(path)
        after = new.get(path)
        before_bin = bool(before and before.binary)
        after_bin = bool(after and after.binary)
        if not before_bin and not after_bin:
            continue
        if before and after and before.sha == after.sha:
            continue
        if before and after and not before.binary and not after.binary:
            continue
        op = "modify"
        if before is None:
            op = "add"
        elif after is None:
            op = "remove"
        elif before.binary != after.binary:
            op = "modify"
        ops.append(
            {
                "path": path,
                "op": op,
                "hash_before": before.sha if before else None,
                "hash_after": after.sha if after else None,
                "size_before": before.size if before else None,
                "size_after": after.size if after else None,
                "blob_sha": after.sha if after else None,
            }
        )
    return ops


def apply_text_patch(tree: Path, patch: str) -> None:
    if not patch.strip():
        return
    proc = subprocess.run(
        ["patch", "-p1", "--forward", "--batch", "--silent"],
        cwd=tree,
        input=patch,
        text=True,
        capture_output=True,
    )
    rejects = list(tree.rglob("*.rej"))
    if proc.returncode != 0 or rejects:
        detail = (proc.stderr or proc.stdout or "").strip()
        raise RuntimeError(f"patch failed: {detail[:400]} rejects={rejects}")


def rebuild_bytes(old: dict[str, bytes], patch: str, binary_ops: list[dict], blobs: dict[str, bytes]) -> dict[str, bytes]:
    """Replay one delta onto a full tree. Text comes from the unified patch; binary ops overwrite after."""
    with tempfile.TemporaryDirectory() as tmp:
        tree = Path(tmp) / "tree"
        export_text(old, tree)
        for rel, data in old.items():
            if b"\0" not in data:
                continue
            target = tree / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
        apply_text_patch(tree, patch)
        rebuilt: dict[str, bytes] = {}
        for file_path in walk_files(tree):
            rebuilt[file_path.relative_to(tree).as_posix()] = file_path.read_bytes()
    for op in binary_ops:
        rel = op["path"]
        if op["op"] == "remove" or op.get("hash_after") is None:
            rebuilt.pop(rel, None)
            continue
        rebuilt[rel] = blobs[op["blob_sha"]]
    return rebuilt


def blobs_for(ops: list[dict], files: dict[str, Rec]) -> dict[str, bytes]:
    blobs: dict[str, bytes] = {}
    for op in ops:
        if op.get("blob_sha"):
            blobs[op["blob_sha"]] = files[op["path"]].data
    return blobs


def assert_roundtrip(rebuilt: dict[str, bytes], expected: dict[str, bytes]) -> None:
    bad = [path for path in sorted(set(rebuilt) | set(expected)) if rebuilt.get(path) != expected.get(path)]
    if bad:
        raise RuntimeError(f"delta did not round-trip: {bad[:8]}")


def load_tree_bytes(root: Path, model: str, snapshot_id: str) -> dict[str, bytes]:
    """Rebuild a sealed snapshot from its baseline and later text/binary deltas."""
    snaps = [path for path in sealed_snapshots(root, model) if is_complete(path)]
    chain: list[Path] = []
    for path in snaps:
        chain.append(path)
        if path.name == snapshot_id:
            break
    else:
        raise FileNotFoundError(snapshot_id)
    if chain[-1].name != snapshot_id:
        raise FileNotFoundError(snapshot_id)
    files: dict[str, bytes] = {}
    for index, path in enumerate(chain):
        manifest = load_manifest(path)
        if index == 0:
            if not manifest.get("baseline"):
                raise RuntimeError(f"{model} has no baseline at the start of the chain")
            base = path / "baseline"
            for file_path in walk_files(base):
                rel = file_path.relative_to(base).as_posix()
                files[rel] = file_path.read_bytes()
            continue
        patch_path = root / "deltas" / "over_time" / model / f"{path.name}.patch"
        summary_path = root / "deltas" / "over_time" / model / f"{path.name}.json"
        summary = json.loads(summary_path.read_text(encoding="utf-8"))
        patch = patch_path.read_text(encoding="utf-8") if patch_path.exists() else ""
        blobs: dict[str, bytes] = {}
        for op in summary.get("binary", []):
            if not op.get("blob_sha"):
                continue
            blob = root / "deltas" / "over_time" / model / f"{path.name}.blobs" / op["blob_sha"].split(":", 1)[1]
            blobs[op["blob_sha"]] = blob.read_bytes()
        files = rebuild_bytes(files, patch, summary.get("binary", []), blobs)
    return files


def compile_pattern(pattern: str) -> re.Pattern[str]:
    flags = 0 if "(?i)" in pattern else re.IGNORECASE
    if pattern.startswith("(?") or "\\" in pattern:
        return re.compile(pattern, flags)
    return re.compile(re.escape(pattern), re.IGNORECASE)


def spec_line_set(text: str) -> set[str]:
    lines = set()
    for line in text.splitlines():
        stripped = line.strip().lower()
        if len(stripped) >= 20:
            lines.add(stripped)
    return lines


def filter_spec_echo(text: str, spec_lines: set[str]) -> str:
    kept = [line for line in text.splitlines() if line.strip().lower() not in spec_lines]
    return "\n".join(kept)


def corpus_for(tree: Tree, spec_sha: str | None, spec_lines: set[str]) -> list[tuple[str, str]]:
    rows: list[tuple[str, str]] = []
    for path, rec in tree.files.items():
        if rec.binary or rec.text is None:
            continue
        if spec_sha and rec.sha == spec_sha:
            continue
        rows.append((path, filter_spec_echo(rec.text, spec_lines)))
    return rows


def evidence_rank(path: str) -> tuple:
    """Prefer game files over scaffold and tests when several paths match."""
    lowered = path.lower()
    scaffold = (
        "__grok",
        "grok-pwa",
        "/auth/",
        "preview-host",
        "preview-path",
        "app-data",
        "multiplayer/p2p",
        "scripts/",
        "public/",
    )
    noisy = 1 if any(token in lowered for token in scaffold) else 0
    test = 1 if ".test." in lowered else 0
    return (noisy, test, lowered)


def pattern_hits(corpus: list[tuple[str, str]], pattern: str, exclude: list[str]) -> list[str]:
    regex = compile_pattern(pattern)
    hits: list[str] = []
    for path, text in corpus:
        if any(token in path for token in exclude):
            continue
        if regex.search(text):
            hits.append(path)
    hits.sort(key=evidence_rank)
    return hits


def evaluate_concept(concept: dict, corpus: list[tuple[str, str]]) -> dict:
    kind = concept.get("kind", "terms")
    exclude = concept.get("exclude_substr", [])
    evidence: list[str] = []
    covered = False
    count = None
    if kind == "regex_count":
        regex = compile_pattern(concept["pattern"])
        total = 0
        matched: list[str] = []
        for path, text in corpus:
            if any(token in path for token in exclude):
                continue
            found = list(regex.finditer(text))
            if found:
                matched.append(path)
            total += len(found)
        evidence.extend(sorted(matched, key=evidence_rank)[:3])
        count = total
        covered = total >= int(concept.get("min", 1))
    elif kind == "absent_if":
        required = False
        for pattern in concept.get("requires_any", []):
            hits = pattern_hits(corpus, pattern, exclude)
            if hits:
                required = True
                evidence.extend(hits[:1])
                break
        leaked = False
        for pattern in concept.get("absent", []):
            hits = pattern_hits(corpus, pattern, exclude)
            if hits:
                leaked = True
                evidence.append(f"contradicted by {hits[0]}")
                break
        covered = required and not leaked
    else:
        all_ok = True
        for pattern in concept.get("all", []):
            hits = pattern_hits(corpus, pattern, exclude)
            if not hits:
                all_ok = False
            elif len(evidence) < 4:
                evidence.append(hits[0])
        any_patterns = concept.get("any", [])
        any_ok = True
        if any_patterns:
            any_ok = False
            for pattern in any_patterns:
                hits = pattern_hits(corpus, pattern, exclude)
                if hits:
                    any_ok = True
                    if len(evidence) < 4:
                        evidence.append(hits[0])
                    break
        covered = all_ok and any_ok
    return {
        "id": concept["id"],
        "section": concept.get("section", ""),
        "label": concept.get("label", concept["id"]),
        "covered": covered,
        "evidence": evidence[:4],
        "count": count,
    }


def load_rubric(root: Path) -> tuple[dict | None, str | None]:
    path = root / "reference" / "concepts.json"
    if not path.exists():
        return None, None
    raw = path.read_bytes()
    return json.loads(raw.decode("utf-8")), sha256_bytes(raw)


def score_tree(root: Path, tree: Tree) -> dict:
    rubric, rubric_sha = load_rubric(root)
    spec_path = root / "reference" / "lmos_public.md"
    spec_sha = sha256_bytes(spec_path.read_bytes()) if spec_path.exists() else None
    spec_lines = spec_line_set(spec_path.read_text(encoding="utf-8")) if spec_path.exists() else set()
    if rubric is None:
        return {
            "rubric_sha256": None,
            "spec_sha256": spec_sha,
            "covered": 0,
            "total": 0,
            "coverage": None,
            "gap_score": None,
            "concepts": [],
            "extra_surfaces": [],
        }
    corpus = corpus_for(tree, spec_sha, spec_lines)
    concepts = [evaluate_concept(item, corpus) for item in rubric.get("concepts", [])]
    extras = []
    for item in rubric.get("extra_surfaces", []):
        result = evaluate_concept(item, corpus)
        if result["covered"]:
            extras.append(
                {
                    "id": item["id"],
                    "severity": item.get("severity", "notice"),
                    "label": item.get("label", item["id"]),
                    "evidence": result["evidence"],
                }
            )
    total = len(concepts)
    covered = sum(1 for item in concepts if item["covered"])
    coverage = round(covered / total, 4) if total else None
    gap = round((1 - covered / total) * 100, 1) if total else None
    return {
        "rubric_sha256": rubric_sha,
        "spec_sha256": spec_sha,
        "covered": covered,
        "total": total,
        "coverage": coverage,
        "gap_score": gap,
        "concepts": concepts,
        "extra_surfaces": extras,
    }


def band_of(path: str, file_sha: str, spec_sha: str | None) -> str:
    if (spec_sha and file_sha == spec_sha) or path.endswith("lmos_public.md"):
        return "spec_copy"
    lowered = path.lower()
    harness_tokens = (
        "__grok",
        "grok-pwa",
        "/auth/",
        "preview-host",
        "preview-path",
        "app-data",
        "/p2p",
        "multiplayer/p2p",
    )
    if any(token in lowered for token in harness_tokens):
        return "harness"
    if any(token in lowered for token in ("/game/", "handshake", "/routes/", "styles.css")):
        return "game"
    return "other"


def fingerprint(files: dict[str, Rec]) -> str:
    body = "".join(f"{path}\0{files[path].sha}\n" for path in sorted(files))
    return sha256_bytes(body.encode())


def totals(files: dict[str, Rec]) -> tuple[int, int, int]:
    count = len(files)
    total_bytes = sum(rec.size for rec in files.values())
    total_lines = sum(rec.lines or 0 for rec in files.values())
    return count, total_lines, total_bytes


def file_rows(files: dict[str, Rec], spec_sha: str | None) -> list[dict]:
    rows = []
    for path in sorted(files):
        rec = files[path]
        rows.append(
            {
                "path": path,
                "sha256": rec.sha,
                "size": rec.size,
                "lines": rec.lines,
                "binary": rec.binary,
                "band": band_of(path, rec.sha, spec_sha),
            }
        )
    return rows


def make_event(
    *,
    timestamp: str,
    event_id: str,
    event_type: str,
    severity: str,
    outcome: str,
    model: str | None,
    repo: str | None,
    repo_url: str | None,
    commit: str | None,
    commit_url: str | None,
    branch: str | None,
    snapshot_id: str | None,
    path: str | None,
    hash_before: str | None,
    hash_after: str | None,
    line_stats: dict,
    message: str,
    detail: dict | None,
) -> dict:
    return {
        "timestamp": timestamp,
        "event_id": event_id,
        "event_type": event_type,
        "severity": severity,
        "outcome": outcome,
        "sensor": SENSOR,
        "model": model,
        "repo": repo,
        "repo_url": repo_url,
        "commit": commit,
        "commit_url": commit_url,
        "branch": branch,
        "snapshot_id": snapshot_id,
        "path": path,
        "hash_before": hash_before,
        "hash_after": hash_after,
        "line_stats": line_stats,
        "message": message,
        "detail": detail,
    }


def write_baseline(snap_dir: Path, files: dict[str, Rec]) -> None:
    base = snap_dir / "baseline"
    for path, rec in files.items():
        target = base / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(rec.data)


def write_binary_blobs(root: Path, model: str, snapshot_id: str, ops: list[dict], files: dict[str, Rec]) -> None:
    if not ops:
        return
    dest = root / "deltas" / "over_time" / model / f"{snapshot_id}.blobs"
    dest.mkdir(parents=True, exist_ok=True)
    for op in ops:
        if not op.get("blob_sha"):
            continue
        rec = files[op["path"]]
        blob = dest / rec.sha.split(":", 1)[1]
        blob.write_bytes(rec.data)


def render_over_time(payload: dict) -> str:
    lines = [
        f"# Over-time delta — {payload['model']} — {payload['captured_at']}",
        "",
        f"Snapshot `{payload['snapshot_id']}`.",
        f"Commit `{payload['commit']}`.",
        f"Parent `{payload['parent_snapshot_id'] or 'none'}`.",
        f"Kind: {'baseline' if payload['baseline'] else 'delta'}.",
        "",
        "A baseline is the only full byte copy for this model. Later snapshots store a unified text patch. Binary changes are stored as raw blobs named by sha256. Rebuild with `load_tree_bytes` in `scripts/capture.py`.",
        "",
        f"Files added {payload['files_added']}, removed {payload['files_removed']}, modified {payload['files_modified']}.",
        f"Line stats: +{payload['lines_added']} / -{payload['lines_removed']}.",
        "",
    ]
    if payload.get("directories"):
        lines.append("## Top-level directories")
        lines.append("")
        lines.append("| directory | files | lines | bytes |")
        lines.append("| --- | ---: | ---: | ---: |")
        for row in payload["directories"]:
            lines.append(f"| {cell(row['directory'])} | {row['files']} | {row['lines']} | {row['bytes']} |")
        lines.append("")
    lines.append("## Paths")
    lines.append("")
    lines.append("| op | path | lines | + | - | sha256 |")
    lines.append("| --- | --- | ---: | ---: | ---: | --- |")
    for row in payload["files"]:
        digest = row["sha256"].split(":", 1)[-1][:12] if row.get("sha256") else ""
        lines.append(
            f"| {row['op']} | `{cell(row['path'])}` | {row['lines'] if row['lines'] is not None else ''} | {row['added']} | {row['removed']} | `{digest}` |"
        )
    lines.append("")
    return "\n".join(lines)


def directory_rollup(files: dict[str, Rec]) -> list[dict]:
    roll: dict[str, dict] = {}
    for path, rec in files.items():
        top = path.split("/", 1)[0]
        slot = roll.setdefault(top, {"directory": top, "files": 0, "lines": 0, "bytes": 0})
        slot["files"] += 1
        slot["lines"] += rec.lines or 0
        slot["bytes"] += rec.size
    return [roll[key] for key in sorted(roll)]


def capture_model(root: Path, tree: Tree, captured_at: str, known_ids: set[str]) -> dict:
    parent = latest_complete(root, tree.model)
    parent_id = parent.name if parent else None
    parent_files: dict[str, Rec] = {}
    baseline = parent is None
    if parent is not None:
        raw = load_tree_bytes(root, tree.model, parent.name)
        parent_files = {path: rec_from(path, data) for path, data in raw.items()}
    snapshot_id = f"{stamp_of(captured_at)}__{tree.commit}"
    snap_dir = snapshot_root(root, tree.model) / snapshot_id
    if snap_dir.exists():
        if is_complete(snap_dir):
            return {"snapshot_id": snapshot_id, "skipped": True}
        if (snap_dir / "seal" / "events.jsonl").exists():
            finish_seal(root, tree.model, snap_dir, known_ids)
            return {"snapshot_id": snapshot_id, "skipped": True, "repaired": True}
        abandon_incomplete(root, tree.model, snap_dir)
    snap_dir.mkdir(parents=True)
    spec = score_tree(root, tree)
    count, total_lines, total_bytes = totals(tree.files)
    patch = ""
    binary_ops: list[dict] = []
    per_file: list[dict] = []
    if baseline:
        write_baseline(snap_dir, tree.files)
        for path, rec in tree.files.items():
            stats = {"added": rec.lines or 0, "removed": 0, "binary": rec.binary}
            per_file.append(
                {
                    "op": "add",
                    "path": path,
                    "lines": rec.lines,
                    "added": stats["added"],
                    "removed": 0,
                    "sha256": rec.sha,
                    "hash_before": None,
                    "hash_after": rec.sha,
                    "size_before": None,
                    "size_after": rec.size,
                    "binary": rec.binary,
                    "line_stats": stats,
                }
            )
    else:
        old_bytes = {path: rec.data for path, rec in parent_files.items()}
        new_bytes = {path: rec.data for path, rec in tree.files.items()}
        patch = text_patch(old_bytes, new_bytes)
        binary_ops = binary_changes(parent_files, tree.files)
        write_binary_blobs(root, tree.model, snapshot_id, binary_ops, tree.files)
        patch_path = root / "deltas" / "over_time" / tree.model / f"{snapshot_id}.patch"
        write_if_changed(patch_path, patch)
        chunks = split_patch(patch)
        paths = sorted(set(parent_files) | set(tree.files))
        binary_paths = {op["path"] for op in binary_ops}
        for path in paths:
            before = parent_files.get(path)
            after = tree.files.get(path)
            if before and after and before.sha == after.sha:
                continue
            if path in binary_paths:
                op = next(item for item in binary_ops if item["path"] == path)
                name = {"add": "add", "remove": "remove", "modify": "modify"}[op["op"]]
                stats = {"added": 0, "removed": 0, "binary": True}
                per_file.append(
                    {
                        "op": name,
                        "path": path,
                        "lines": after.lines if after else None,
                        "added": 0,
                        "removed": 0,
                        "sha256": after.sha if after else None,
                        "hash_before": before.sha if before else None,
                        "hash_after": after.sha if after else None,
                        "size_before": before.size if before else None,
                        "size_after": after.size if after else None,
                        "binary": True,
                        "line_stats": stats,
                    }
                )
                continue
            if path not in chunks and before and after:
                # Textually identical aside from a mode-only or binary-adjacent miss.
                continue
            chunk = chunks.get(path, "")
            binary = bool((before and before.binary) or (after and after.binary))
            stats = line_stats_from_chunk(chunk, binary)
            if before is None:
                op_name = "add"
            elif after is None:
                op_name = "remove"
            else:
                op_name = "modify"
            per_file.append(
                {
                    "op": op_name,
                    "path": path,
                    "lines": after.lines if after else (before.lines if before else None),
                    "added": stats["added"],
                    "removed": stats["removed"],
                    "sha256": after.sha if after else None,
                    "hash_before": before.sha if before else None,
                    "hash_after": after.sha if after else None,
                    "size_before": before.size if before else None,
                    "size_after": after.size if after else None,
                    "binary": binary,
                    "line_stats": stats,
                }
            )
        assert_roundtrip(rebuild_bytes(old_bytes, patch, binary_ops, blobs_for(binary_ops, tree.files)), new_bytes)
    added = sum(1 for row in per_file if row["op"] == "add")
    removed = sum(1 for row in per_file if row["op"] == "remove")
    modified = sum(1 for row in per_file if row["op"] == "modify")
    lines_added = sum(row["line_stats"]["added"] for row in per_file)
    lines_removed = sum(row["line_stats"]["removed"] for row in per_file)
    over = {
        "schema": "lmos.over_time.v1",
        "captured_at": captured_at,
        "model": tree.model,
        "snapshot_id": snapshot_id,
        "commit": tree.commit,
        "parent_snapshot_id": parent_id,
        "baseline": baseline,
        "patch": None if baseline else f"deltas/over_time/{tree.model}/{snapshot_id}.patch",
        "files_added": added,
        "files_removed": removed,
        "files_modified": modified,
        "lines_added": lines_added,
        "lines_removed": lines_removed,
        "directories": directory_rollup(tree.files) if baseline else [],
        "files": [
            {
                "op": row["op"],
                "path": row["path"],
                "lines": row["lines"],
                "added": row["added"],
                "removed": row["removed"],
                "sha256": row["sha256"],
                "hash_before": row["hash_before"],
                "hash_after": row["hash_after"],
                "binary": row["binary"],
            }
            for row in per_file
        ],
        "binary": binary_ops,
    }
    over_base = root / "deltas" / "over_time" / tree.model
    write_if_changed(over_base / f"{snapshot_id}.json", dump_json(over))
    write_if_changed(over_base / f"{snapshot_id}.md", render_over_time(over))
    manifest = {
        "schema": "lmos.snapshot.v1",
        "captured_at": captured_at,
        "snapshot_id": snapshot_id,
        "model": tree.model,
        "repo": tree.repo,
        "repo_url": tree.repo_url,
        "branch": tree.branch,
        "baseline": baseline,
        "baseline_path": f"snapshots/{tree.model}/{snapshot_id}/baseline" if baseline else None,
        "parent_snapshot_id": parent_id,
        "commit": {
            "sha": tree.commit,
            "url": tree.commit_url,
            "committed_at": tree.committed_at,
            "author": tree.author,
            "subject": tree.subject,
        },
        "file_count": count,
        "total_lines": total_lines,
        "total_bytes": total_bytes,
        "tree_sha256": fingerprint(tree.files),
        "delta": {
            "files_added": added,
            "files_removed": removed,
            "files_modified": modified,
            "lines_added": lines_added,
            "lines_removed": lines_removed,
        },
        "spec": spec,
        "files": file_rows(tree.files, spec.get("spec_sha256")),
    }
    (snap_dir / "manifest.json").write_text(dump_json(manifest), encoding="utf-8")
    events = snapshot_events(tree, manifest, per_file, captured_at)
    excerpt = snap_dir / "seal" / "events.jsonl"
    excerpt.parent.mkdir(parents=True, exist_ok=True)
    excerpt.write_text("".join(dump_event(event) + "\n" for event in events), encoding="utf-8")
    append_events(root, events, known_ids)
    (snap_dir / ".complete").write_text(captured_at + "\n", encoding="utf-8")
    print(
        f"sealed {tree.model} {tree.commit[:12]} files={count} lines={total_lines} "
        f"baseline={str(baseline).lower()} spec_gap={spec.get('gap_score')}"
    )
    return {"snapshot_id": snapshot_id, "skipped": False, "manifest": manifest, "tree": tree}


def snapshot_events(tree: Tree, manifest: dict, per_file: list[dict], captured_at: str) -> list[dict]:
    sha = tree.commit
    seq = 0

    def next_id() -> str:
        nonlocal seq
        seq += 1
        return f"evt-{tree.model}-{sha[:12]}-{seq:04d}"

    common = dict(
        timestamp=captured_at,
        model=tree.model,
        repo=tree.repo,
        repo_url=tree.repo_url,
        commit=sha,
        commit_url=tree.commit_url,
        branch=tree.branch,
        snapshot_id=manifest["snapshot_id"],
    )
    delta = manifest["delta"]
    events = [
        make_event(
            event_id=next_id(),
            event_type="SNAPSHOT_CAPTURED",
            severity="info",
            outcome="success",
            path=None,
            hash_before=None,
            hash_after=manifest["tree_sha256"],
            line_stats={"added": delta["lines_added"], "removed": delta["lines_removed"], "binary": False},
            message=(
                f"Sealed {tree.model} at {sha[:12]} "
                f"({manifest['file_count']} files, {manifest['total_lines']} lines)"
            ),
            detail={
                "baseline": manifest["baseline"],
                "parent_snapshot_id": manifest["parent_snapshot_id"],
                "file_count": manifest["file_count"],
                "total_lines": manifest["total_lines"],
                "total_bytes": manifest["total_bytes"],
                "files_added": delta["files_added"],
                "files_removed": delta["files_removed"],
                "files_modified": delta["files_modified"],
                "committed_at": tree.committed_at,
                "subject": tree.subject,
            },
            **common,
        )
    ]
    if manifest["baseline"]:
        events.append(
            make_event(
                event_id=next_id(),
                event_type="BASELINE_ESTABLISHED",
                severity="info",
                outcome="success",
                path=manifest["baseline_path"],
                hash_before=None,
                hash_after=manifest["tree_sha256"],
                line_stats={"added": delta["lines_added"], "removed": 0, "binary": False},
                message="Stored the only full tree for this model. Later seals are patches.",
                detail={"files": manifest["file_count"]},
                **common,
            )
        )
    type_for = {"add": "FILE_ADDED", "remove": "FILE_REMOVED", "modify": "FILE_MODIFIED"}
    severity_for = {"add": "info", "remove": "notice", "modify": "notice"}
    for row in sorted(per_file, key=lambda item: item["path"]):
        events.append(
            make_event(
                event_id=next_id(),
                event_type=type_for[row["op"]],
                severity=severity_for[row["op"]],
                outcome="success",
                path=row["path"],
                hash_before=row["hash_before"],
                hash_after=row["hash_after"],
                line_stats=row["line_stats"],
                message=f"{row['op']} {row['path']}",
                detail={"size_before": row["size_before"], "size_after": row["size_after"], "binary": row["binary"]},
                **common,
            )
        )
    spec = manifest["spec"]
    events.append(
        make_event(
            event_id=next_id(),
            event_type="SPEC_COMPARED",
            severity="info",
            outcome="success" if spec.get("total") else "not_applicable",
            path="reference/lmos_public.md",
            hash_before=None,
            hash_after=spec.get("spec_sha256"),
            line_stats={"added": 0, "removed": 0, "binary": False},
            message=(
                f"Spec evidence {spec.get('covered')}/{spec.get('total')} "
                f"(gap {spec.get('gap_score')})"
            ),
            detail={
                "covered": spec.get("covered"),
                "total": spec.get("total"),
                "coverage": spec.get("coverage"),
                "gap_score": spec.get("gap_score"),
                "rubric_sha256": spec.get("rubric_sha256"),
                "uncovered": [item["id"] for item in spec.get("concepts", []) if not item["covered"]],
                "extra_surfaces": [item["id"] for item in spec.get("extra_surfaces", [])],
            },
            **common,
        )
    )
    return events


def finish_seal(root: Path, model: str, snap_dir: Path, known_ids: set[str]) -> None:
    excerpt = snap_dir / "seal" / "events.jsonl"
    events = [json.loads(line) for line in excerpt.read_text(encoding="utf-8").splitlines() if line.strip()]
    append_events(root, events, known_ids)
    if not (snap_dir / ".complete").exists():
        (snap_dir / ".complete").write_text(utc_now() + "\n", encoding="utf-8")
    print(f"repaired seal {model} {snap_dir.name}")


def repair_incomplete(root: Path, known_ids: set[str]) -> bool:
    base = root / "snapshots"
    if not base.exists():
        return False
    changed = False
    for model_dir in sorted(path for path in base.iterdir() if path.is_dir()):
        for snap_dir in sorted(path for path in model_dir.iterdir() if path.is_dir()):
            if is_complete(snap_dir):
                continue
            if (snap_dir / "seal" / "events.jsonl").exists():
                finish_seal(root, model_dir.name, snap_dir, known_ids)
                changed = True
            else:
                print(f"discard incomplete {model_dir.name} {snap_dir.name}")
                abandon_incomplete(root, model_dir.name, snap_dir)
                changed = True
    return changed


def all_latest_manifests(root: Path) -> list[dict]:
    manifests = []
    base = root / "snapshots"
    if not base.exists():
        return manifests
    for model_dir in sorted(path for path in base.iterdir() if path.is_dir()):
        latest = latest_complete(root, model_dir.name)
        if latest:
            manifests.append(load_manifest(latest))
    return manifests


def all_manifests(root: Path) -> list[dict]:
    found = []
    base = root / "snapshots"
    if not base.exists():
        return found
    for model_dir in sorted(path for path in base.iterdir() if path.is_dir()):
        for snap in sealed_snapshots(root, model_dir.name):
            if is_complete(snap):
                found.append(load_manifest(snap))
    found.sort(key=lambda item: (item["captured_at"], item["model"]))
    return found


def hash_map(manifest: dict) -> dict[str, str]:
    return {row["path"]: row["sha256"] for row in manifest["files"]}


def pairwise(left: dict, right: dict) -> dict:
    a = hash_map(left)
    b = hash_map(right)
    only_a = sorted(set(a) - set(b))
    only_b = sorted(set(b) - set(a))
    shared = sorted(set(a) & set(b))
    changed = [path for path in shared if a[path] != b[path]]
    identical = [path for path in shared if a[path] == b[path]]
    union = len(set(a) | set(b))
    structural = 1.0 if union == 0 else 1 - (len(shared) / union)
    content = 1.0 if not shared else len(changed) / len(shared)
    score = round((0.5 * structural + 0.5 * content) * 100, 1)
    return {
        "a": left["model"],
        "b": right["model"],
        "snapshot_a": left["snapshot_id"],
        "snapshot_b": right["snapshot_id"],
        "structural": round(structural, 4),
        "content": round(content, 4),
        "score": score,
        "only_a": only_a,
        "only_b": only_b,
        "changed": changed,
        "identical_count": len(identical),
        "shared_count": len(shared),
    }


def section_names(text: str, path: str) -> list[str]:
    found: list[str] = []
    if path.endswith((".md", ".mdx")):
        for line in text.splitlines():
            if re.match(r"^#{1,6}\s+\S", line):
                found.append(line.strip())
        return found
    for line in text.splitlines():
        stripped = line.strip()
        match = re.match(r"^(?:export\s+)?(?:async\s+)?(?:function|class|interface|type)\s+(\w+)", stripped)
        if match:
            found.append(match.group(1))
            continue
        match = re.match(r"^(?:export\s+)?const\s+(\w+)\s*=", stripped)
        if match:
            found.append(match.group(1))
    return found


def section_delta(root: Path, left: dict, right: dict) -> dict:
    def names_for(manifest: dict) -> set[str]:
        data = load_tree_bytes(root, manifest["model"], manifest["snapshot_id"])
        found: set[str] = set()
        for path, blob in data.items():
            if b"\0" in blob:
                continue
            text = blob.decode("utf-8", errors="replace")
            for name in section_names(text, path):
                found.add(name)
        return found

    a = names_for(left)
    b = names_for(right)
    return {
        "only_a": sorted(a - b),
        "only_b": sorted(b - a),
        "shared_count": len(a & b),
    }


def render_cross(payload: dict) -> str:
    lines = [
        f"# Cross-model delta — {payload['captured_at']}",
        "",
        payload["summary"],
        "",
        "## Models",
        "",
        "| model | repo | commit | files | lines | spec covered | spec gap | extra surfaces |",
        "| --- | --- | --- | ---: | ---: | --- | ---: | ---: |",
    ]
    for model in payload["models"]:
        spec = model["spec"]
        lines.append(
            "| {model} | {repo} | `{commit}` | {files} | {lines} | {covered}/{total} | {gap} | {extras} |".format(
                model=cell(model["model"]),
                repo=cell(model["repo"]),
                commit=model["commit"][:12],
                files=model["file_count"],
                lines=model["total_lines"],
                covered=spec.get("covered"),
                total=spec.get("total"),
                gap=spec.get("gap_score"),
                extras=len(spec.get("extra_surfaces", [])),
            )
        )
    lines.append("")
    if payload["placeholders"]:
        lines.append("## Placeholders")
        lines.append("")
        lines.append("These models are not fetched. Enable one with a single command:")
        lines.append("")
        lines.append("```")
        lines.append("python3 scripts/capture.py --enable <model_id>")
        lines.append("```")
        lines.append("")
        for item in payload["placeholders"]:
            lines.append(f"- `{item['model']}` — `{item['target']}`")
        lines.append("")
    if payload["mode"] == "spec_only":
        lines.extend(
            [
                "## No peer repo",
                "",
                "File-by-file divergence between models is not computable until a second source is sealed. The comparison below is this snapshot against the pinned spec.",
                "",
            ]
        )
    else:
        lines.append("## Pairwise divergence")
        lines.append("")
        lines.append("Score = 100 * (0.5 * path-Jaccard distance + 0.5 * fraction of shared paths whose sha256 differs). 0 is the same tree. 100 is no shared identical file.")
        lines.append("")
        lines.append("| pair | score | only left | only right | shared | content changed | identical |")
        lines.append("| --- | ---: | ---: | ---: | ---: | ---: | ---: |")
        for pair in payload["pairs"]:
            lines.append(
                f"| {pair['a']} vs {pair['b']} | {pair['score']} | {len(pair['only_a'])} | {len(pair['only_b'])} | {pair['shared_count']} | {len(pair['changed'])} | {pair['identical_count']} |"
            )
        lines.append("")
        for pair in payload["pairs"]:
            lines.append(f"### {pair['a']} vs {pair['b']}")
            lines.append("")
            lines.append(f"Paths only in {pair['a']}:")
            lines.append("")
            for path in pair["only_a"][:80]:
                lines.append(f"- `{path}`")
            if len(pair["only_a"]) > 80:
                lines.append(f"- … {len(pair['only_a']) - 80} more in the JSON")
            lines.append("")
            lines.append(f"Paths only in {pair['b']}:")
            lines.append("")
            for path in pair["only_b"][:80]:
                lines.append(f"- `{path}`")
            if len(pair["only_b"]) > 80:
                lines.append(f"- … {len(pair['only_b']) - 80} more in the JSON")
            lines.append("")
            lines.append("Shared paths whose bytes differ:")
            lines.append("")
            if pair["changed"]:
                for path in pair["changed"][:80]:
                    lines.append(f"- `{path}`")
            else:
                lines.append("- none")
            lines.append("")
        if payload.get("sections"):
            lines.append("## Section names")
            lines.append("")
            lines.append("Markdown headings and top-level function, class, type, and const names.")
            lines.append("")
            for block in payload["sections"]:
                lines.append(f"### {block['a']} vs {block['b']}")
                lines.append("")
                lines.append(f"Shared names: {block['shared_count']}.")
                lines.append("")
                lines.append(f"Only in {block['a']}:")
                lines.append("")
                only_a = block["only_a"][:40]
                lines.extend(f"- `{name}`" for name in only_a)
                if len(block["only_a"]) > 40:
                    lines.append(f"- … {len(block['only_a']) - 40} more in the JSON")
                if not only_a:
                    lines.append("- none")
                lines.append("")
                lines.append(f"Only in {block['b']}:")
                lines.append("")
                only_b = block["only_b"][:40]
                lines.extend(f"- `{name}`" for name in only_b)
                if len(block["only_b"]) > 40:
                    lines.append(f"- … {len(block['only_b']) - 40} more in the JSON")
                if not only_b:
                    lines.append("- none")
                lines.append("")
    for model in payload["models"]:
        spec = model["spec"]
        lines.append(f"## Spec evidence — {model['model']}")
        lines.append("")
        lines.append(f"Covered {spec.get('covered')} of {spec.get('total')}. Gap score {spec.get('gap_score')}. Rubric `{spec.get('rubric_sha256')}`.")
        lines.append("")
        lines.append("| section | concept | evidence | paths |")
        lines.append("| --- | --- | --- | --- |")
        for concept in spec.get("concepts", []):
            mark = "yes" if concept["covered"] else "no"
            paths = ", ".join(f"`{item}`" for item in concept.get("evidence", [])[:2]) or "—"
            lines.append(f"| {cell(concept['section'])} | {cell(concept['label'])} | {mark} | {paths} |")
        lines.append("")
        lines.append("### Extra surfaces")
        lines.append("")
        extras = spec.get("extra_surfaces", [])
        if not extras:
            lines.append("None of the watched extra surfaces matched.")
            lines.append("")
        else:
            for extra in extras:
                lines.append(f"- **{extra['severity']}** `{extra['id']}` — {extra['label']} Evidence: {', '.join(extra.get('evidence', [])[:3]) or 'none'}.")
            lines.append("")
        lines.append("### Path bands")
        lines.append("")
        lines.append("Heuristic only: `spec_copy` is a byte match of the pinned spec or a file named `lmos_public.md`. `harness` matches auth, preview, PWA, or P2P paths. `game` matches game, handshake, routes, or styles. Everything else is `other`.")
        lines.append("")
        lines.append("| band | files | lines |")
        lines.append("| --- | ---: | ---: |")
        for band, stats in model["bands"].items():
            lines.append(f"| {band} | {stats['files']} | {stats['lines']} |")
        lines.append("")
        lines.append("### Largest text files")
        lines.append("")
        lines.append("| lines | bytes | band | path |")
        lines.append("| ---: | ---: | --- | --- |")
        for row in model["largest"]:
            lines.append(f"| {row['lines']} | {row['size']} | {row['band']} | `{cell(row['path'])}` |")
        lines.append("")
    lines.append("Machine-readable twin: `deltas/cross_model/" + payload["file_stamp"] + ".json`.")
    lines.append("")
    return "\n".join(lines)


def bands_of(manifest: dict) -> dict:
    roll: dict[str, dict] = {}
    for row in manifest["files"]:
        slot = roll.setdefault(row["band"], {"files": 0, "lines": 0})
        slot["files"] += 1
        slot["lines"] += row["lines"] or 0
    return {key: roll[key] for key in sorted(roll)}


def largest_files(manifest: dict, limit: int = 12) -> list[dict]:
    rows = [row for row in manifest["files"] if not row["binary"]]
    rows.sort(key=lambda row: (-(row["lines"] or 0), row["path"]))
    return [
        {"path": row["path"], "lines": row["lines"], "size": row["size"], "band": row["band"]}
        for row in rows[:limit]
    ]


def write_cross(root: Path, captured_at: str, placeholders: list[Source], known_ids: set[str]) -> None:
    latest = all_latest_manifests(root)
    if not latest:
        return
    file_stamp = stamp_of(captured_at)
    pairs = []
    sections = []
    if len(latest) >= 2:
        for index, left in enumerate(latest):
            for right in latest[index + 1 :]:
                pair = pairwise(left, right)
                pairs.append(pair)
                sections.append({"a": left["model"], "b": right["model"], **section_delta(root, left, right)})
    mode = "cross_model" if len(latest) >= 2 else "spec_only"
    names = [item["model"] for item in latest]
    placeholder_rows = [{"model": item.model, "target": item.target} for item in placeholders]
    if mode == "spec_only":
        summary = (
            f"Only {names[0]} is sealed. "
            + (
                "Placeholders not captured: " + ", ".join(item.model for item in placeholders) + ". "
                if placeholders
                else ""
            )
            + "This record compares that snapshot to reference/lmos_public.md instead of to another model."
        )
    else:
        mean = round(sum(pair["score"] for pair in pairs) / len(pairs), 1)
        summary = f"Sealed models: {', '.join(names)}. Mean pairwise divergence {mean}."
    model_rows = []
    for manifest in latest:
        model_rows.append(
            {
                "model": manifest["model"],
                "repo": manifest["repo"],
                "repo_url": manifest["repo_url"],
                "commit": manifest["commit"]["sha"],
                "commit_url": manifest["commit"]["url"],
                "snapshot_id": manifest["snapshot_id"],
                "captured_at": manifest["captured_at"],
                "file_count": manifest["file_count"],
                "total_lines": manifest["total_lines"],
                "total_bytes": manifest["total_bytes"],
                "spec": manifest["spec"],
                "bands": bands_of(manifest),
                "largest": largest_files(manifest),
            }
        )
    payload = {
        "schema": "lmos.cross_model.v1",
        "captured_at": captured_at,
        "file_stamp": file_stamp,
        "mode": mode,
        "summary": summary,
        "snapshot_ids": [item["snapshot_id"] for item in latest],
        "placeholders": placeholder_rows,
        "models": model_rows,
        "pairs": pairs,
        "sections": sections,
        "divergence_method": "100 * (0.5 * (1 - |shared paths| / |union paths|) + 0.5 * (changed shared paths / shared paths)). Empty shared set uses content distance 1.",
    }
    base = root / "deltas" / "cross_model"
    write_if_changed(base / f"{file_stamp}.json", dump_json(payload))
    write_if_changed(base / f"{file_stamp}.md", render_cross(payload))
    if any(file_stamp in path.name for path in (root / "deltas" / "cross_model").glob("*.json")):
        pass
    event_id = f"evt-cross-{captured_at.replace('-', '').replace(':', '')}-0001"
    if mode == "spec_only":
        message = summary
        outcome = "not_applicable"
        severity = "notice"
        detail = {"mode": mode, "models": names, "placeholders": [item.model for item in placeholders]}
        score_stats = {"added": 0, "removed": 0, "binary": False}
    else:
        message = summary
        outcome = "success"
        severity = "warning"
        detail = {
            "mode": mode,
            "models": names,
            "pairs": [
                {"a": pair["a"], "b": pair["b"], "score": pair["score"], "changed": len(pair["changed"])}
                for pair in pairs
            ],
        }
        score_stats = {"added": 0, "removed": 0, "binary": False}
    event = make_event(
        timestamp=captured_at,
        event_id=event_id,
        event_type="CROSS_MODEL_DIVERGENCE",
        severity=severity,
        outcome=outcome,
        model="cross",
        repo=None,
        repo_url=None,
        commit=None,
        commit_url=None,
        branch=None,
        snapshot_id=file_stamp,
        path=f"deltas/cross_model/{file_stamp}.md",
        hash_before=None,
        hash_after=None,
        line_stats=score_stats,
        message=message,
        detail=detail,
    )
    append_events(root, [event], known_ids)


def covered_snapshot_ids(root: Path) -> set[str]:
    found: set[str] = set()
    base = root / "deltas" / "cross_model"
    if not base.exists():
        return found
    for path in base.glob("*.json"):
        payload = json.loads(path.read_text(encoding="utf-8"))
        found.update(payload.get("snapshot_ids", []))
    return found


def divergence_for(manifest: dict, earlier: list[dict]) -> tuple[float | None, str]:
    peers = []
    for other in earlier:
        if other["model"] == manifest["model"]:
            continue
        if other["captured_at"] <= manifest["captured_at"]:
            peers.append(other)
    latest: dict[str, dict] = {}
    for peer in peers:
        current = latest.get(peer["model"])
        if current is None or peer["captured_at"] >= current["captured_at"]:
            latest[peer["model"]] = peer
    if not latest:
        return None, ""
    scores = [pairwise(manifest, peer)["score"] for peer in latest.values()]
    mean = round(sum(scores) / len(scores), 1)
    return mean, ";".join(sorted(latest))


def write_trends(root: Path) -> None:
    manifests = all_manifests(root)
    rows = []
    for manifest in manifests:
        score, peers = divergence_for(manifest, manifests)
        delta = manifest["delta"]
        spec = manifest["spec"]
        rows.append(
            {
                "captured_at": manifest["captured_at"],
                "model": manifest["model"],
                "commit": manifest["commit"]["sha"],
                "snapshot_id": manifest["snapshot_id"],
                "file_count": manifest["file_count"],
                "total_lines": manifest["total_lines"],
                "total_bytes": manifest["total_bytes"],
                "files_changed_since_last": delta["files_added"] + delta["files_removed"] + delta["files_modified"],
                "lines_added": delta["lines_added"],
                "lines_removed": delta["lines_removed"],
                "cross_model_divergence": "" if score is None else score,
                "spec_coverage": "" if spec.get("coverage") is None else spec["coverage"],
                "spec_gap_score": "" if spec.get("gap_score") is None else spec["gap_score"],
                "extra_surface_count": len(spec.get("extra_surfaces", [])),
                "peer_models": peers,
                "baseline": manifest["baseline"],
            }
        )
    header = [
        "captured_at",
        "model",
        "commit",
        "snapshot_id",
        "file_count",
        "total_lines",
        "total_bytes",
        "files_changed_since_last",
        "lines_added",
        "lines_removed",
        "cross_model_divergence",
        "spec_coverage",
        "spec_gap_score",
        "extra_surface_count",
        "peer_models",
    ]
    csv_lines = [",".join(header)]
    for row in rows:
        csv_lines.append(",".join(str(row[key]) for key in header))
    csv_text = "\n".join(csv_lines) + "\n"
    md = [
        "# Trends",
        "",
        "One row per sealed snapshot. This file is rebuilt from manifests. It is a projection, not the audit log. `logs/events.jsonl` is the log and is append-only.",
        "",
        "`files_changed_since_last` counts adds, removes, and modifications. A baseline counts every file.",
        "",
        "`cross_model_divergence` is empty until another model has a snapshot at or before this row. It is the mean pairwise score: 100 * (0.5 * path-Jaccard distance + 0.5 * share of common paths whose sha256 differs). 0 is identical. 100 shares no identical file.",
        "",
        "`spec_coverage` is covered/total against `reference/concepts.json` at seal time. `spec_gap_score` is `(1 - covered/total) * 100`. Copying the spec into the source repo does not raise coverage: byte-identical spec copies are ignored, and long verbatim spec lines are ignored.",
        "",
        "`extra_surface_count` is login kits, harness shells, and parked items that were built anyway. It is not part of the gap score.",
        "",
        "| captured_at | model | files | lines | changed | +lines | -lines | divergence | spec coverage | spec gap | extras | peers |",
        "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |",
    ]
    for row in rows:
        md.append(
            "| {captured_at} | {model} | {file_count} | {total_lines} | {files_changed_since_last} | {lines_added} | {lines_removed} | {cross_model_divergence} | {spec_coverage} | {spec_gap_score} | {extra_surface_count} | {peers} |".format(
                captured_at=row["captured_at"],
                model=row["model"],
                file_count=row["file_count"],
                total_lines=row["total_lines"],
                files_changed_since_last=row["files_changed_since_last"],
                lines_added=row["lines_added"],
                lines_removed=row["lines_removed"],
                cross_model_divergence=row["cross_model_divergence"],
                spec_coverage=row["spec_coverage"],
                spec_gap_score=row["spec_gap_score"],
                extra_surface_count=row["extra_surface_count"],
                peers=row["peer_models"] or "—",
            )
        )
    md.append("")
    md.append("CSV: `trends/snapshots.csv`.")
    md.append("")
    write_if_changed(root / "trends" / "snapshots.csv", csv_text)
    write_if_changed(root / "TRENDS.md", "\n".join(md))


def unavailable_event(source: Source, message: str, captured_at: str) -> dict:
    kind = "path"
    repo_url = None
    try:
        kind = target_kind(source.target)
    except RuntimeError:
        kind = "invalid"
    if kind == "github":
        repo_url, _ = github_urls(source.target)
    return make_event(
        timestamp=captured_at,
        event_id=f"evt-{source.model}-unavailable-{hashlib.sha256(message.encode()).hexdigest()[:12]}",
        event_type="SOURCE_UNAVAILABLE",
        severity="high",
        outcome="failure",
        model=source.model,
        repo=source.target,
        repo_url=repo_url,
        commit=None,
        commit_url=None,
        branch=None,
        snapshot_id=None,
        path=None,
        hash_before=None,
        hash_after=None,
        line_stats={"added": 0, "removed": 0, "binary": False},
        message=message[:300],
        detail=None,
    )


def needs_cross(root: Path) -> bool:
    latest_ids = {item["snapshot_id"] for item in all_latest_manifests(root)}
    if not latest_ids:
        return False
    return not latest_ids <= covered_snapshot_ids(root)


def capture(root: Path, sources_path: Path, enable: list[str]) -> int:
    text = sources_path.read_text(encoding="utf-8")
    failures: list[str] = []
    if enable:
        _, placeholders = parse_sources(text)
        by_model = {item.model: item for item in placeholders}
        for model in enable:
            if model not in by_model:
                enabled_now, _ = parse_sources(text)
                if any(item.model == model for item in enabled_now):
                    print(f"{model} is already enabled")
                    continue
                print(f"no placeholder named {model}", file=sys.stderr)
                return 2
            try:
                probe_head(by_model[model])
            except Exception as exc:
                print(f"leave placeholder {model}: {exc}", file=sys.stderr)
                failures.append(model)
                continue
            text, changed = uncomment_model(text, model)
            if changed:
                sources_path.write_text(text, encoding="utf-8")
                print(f"enabled {model}")
    enabled, placeholders = parse_sources(text)
    known = load_event_ids(root)
    repaired = repair_incomplete(root, known)
    captured_at = utc_now()
    new_seal = False
    for source in enabled:
        try:
            remote_sha = probe_head(source)
        except Exception as exc:
            message = str(exc).splitlines()[0]
            if last_unavailable_message(root, source.model) == message[:300]:
                print(f"still unavailable {source.model}")
            else:
                append_events(root, [unavailable_event(source, message, captured_at)], known)
                print(f"unavailable {source.model}: {message}", file=sys.stderr)
            failures.append(source.model)
            continue
        latest = latest_complete(root, source.model)
        if latest is not None:
            manifest = load_manifest(latest)
            if manifest["commit"]["sha"] == remote_sha:
                print(f"unchanged {source.model} {remote_sha[:12]}")
                continue
        with tempfile.TemporaryDirectory() as tmp:
            try:
                tree = read_tree_from_git(source, Path(tmp) / "repo")
            except Exception as exc:
                message = str(exc).splitlines()[0]
                if last_unavailable_message(root, source.model) != message[:300]:
                    append_events(root, [unavailable_event(source, message, captured_at)], known)
                print(f"unavailable {source.model}: {message}", file=sys.stderr)
                failures.append(source.model)
                continue
        if latest_complete(root, source.model) and load_manifest(latest_complete(root, source.model))["commit"]["sha"] == tree.commit:
            print(f"unchanged {source.model} {tree.commit[:12]}")
            continue
        result = capture_model(root, tree, captured_at, known)
        if not result.get("skipped"):
            new_seal = True
    if new_seal or repaired or needs_cross(root) or (all_manifests(root) and not (root / "TRENDS.md").exists()):
        # Use one stamp for a run that sealed something. Repairs of derived
        # views use the current time so the missing cross file is created once.
        write_cross(root, captured_at, placeholders, known)
        write_trends(root)
    elif not new_seal and not failures:
        print("no changes")
    return 1 if failures else 0


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Capture LMOS one-shot source repos into the delta log.")
    parser.add_argument("--root", type=Path, default=default_root(), help="Tracker repository root")
    parser.add_argument("--sources", type=Path, default=None, help="Sources file (default: <root>/config/sources.txt)")
    parser.add_argument(
        "--enable",
        action="append",
        default=[],
        help="Uncomment a placeholder and capture it. Refuses to edit config if the remote has no HEAD.",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv if argv is not None else sys.argv[1:])
    root = args.root.resolve()
    sources = args.sources.resolve() if args.sources else root / "config" / "sources.txt"
    if not sources.exists():
        print(f"missing sources file: {sources}", file=sys.stderr)
        return 2
    try:
        return capture(root, sources, args.enable)
    except RuntimeError as exc:
        print(str(exc), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
