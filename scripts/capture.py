#!/usr/bin/env python3
"""Seal public LMOS one-shot repos into an append-only snapshot and delta log.

The first sealed snapshot of a model stores a full byte copy. Later snapshots
store a unified text patch plus raw bytes only for binary files that changed.
Re-running against an unchanged commit does not seal another snapshot. A GitHub
rename or a label question is appended once, then the same observation writes
nothing. The model label on an existing seal is not rewritten.
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
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

SCHEMA = "lmos.tracker.v1"
SENSOR = "lmos-tracker/capture.py"
SOURCE_LINE = re.compile(
    r"^(?P<model>[a-z][a-z0-9_-]{0,31})\s+(?P<target>\S+)"
    r"(?:\s+repo_id=(?P<repo_id>\d+))?"
    r"(?:\s+node_id=(?P<node_id>\S+))?"
    r"(?:\s+attribution=(?P<attribution>[a-z][a-z0-9_-]*))?"
    r"\s*$"
)
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
    repo_id: str | None = None
    node_id: str | None = None
    attribution: str | None = None


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
    repo_id: str | None = None
    node_id: str | None = None
    files: dict[str, Rec] = field(default_factory=dict)
    completeness: str | None = None
    partial_detail: dict | None = None


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
        source = Source(
            model,
            match.group("target"),
            enabled=not commented,
            repo_id=match.group("repo_id"),
            node_id=match.group("node_id"),
            attribution=match.group("attribution"),
        )
        (placeholders if commented else enabled).append(source)
    return enabled, placeholders


def format_source(
    model: str,
    target: str,
    repo_id: str | None,
    node_id: str | None = None,
    attribution: str | None = None,
) -> str:
    parts = [model, target]
    if repo_id:
        parts.append(f"repo_id={repo_id}")
    if node_id:
        parts.append(f"node_id={node_id}")
    if attribution:
        parts.append(f"attribution={attribution}")
    return " ".join(parts)


def uncomment_model(text: str, model: str) -> tuple[str, bool]:
    changed = False
    lines: list[str] = []
    for raw in text.splitlines():
        stripped = raw.strip()
        if stripped.startswith("#"):
            match = SOURCE_LINE.match(stripped[1:].strip())
            if match and match.group("model") == model:
                lines.append(
                    format_source(
                        match.group("model"),
                        match.group("target"),
                        match.group("repo_id"),
                        match.group("node_id"),
                        match.group("attribution"),
                    )
                )
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
        repo_id=source.repo_id,
        node_id=source.node_id,
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


def _header_path(line: str) -> str:
    return line[4:].split("\t", 1)[0].strip()


def _old_file_header(line: str) -> bool:
    if not line.startswith("--- "):
        return False
    path = _header_path(line)
    return path == "/dev/null" or path.startswith("a/") or path.startswith("old/")


def _new_file_header(line: str) -> bool:
    if not line.startswith("+++ "):
        return False
    path = _header_path(line)
    return path == "/dev/null" or path.startswith("b/") or path.startswith("new/")


def _file_header_pair(line: str, nxt: str, third: str) -> bool:
    """True when two lines are a unified-diff file header, not a hunk body.

    A removed source line that begins with `-- ` is also `--- ` in the diff.
    Those lines have no tab-separated timestamp and are not followed by `+++ `.
    """
    if not (_old_file_header(line) and _new_file_header(nxt)):
        return False
    return third == "" or third.startswith("@@")


def normalize_diff(raw: str) -> str:
    lines: list[str] = []
    for line in raw.splitlines(keepends=True):
        if line.startswith("Binary files ") or line.startswith("diff -ruN "):
            continue
        # diff -ruN file headers always carry a tab and a timestamp.
        # Hunk lines such as `--- Better Auth schema` do not.
        if line.startswith("--- ") or line.startswith("+++ "):
            meta, sep, rest = line.partition("\t")
            path = meta[4:].strip()
            header = sep == "\t" and (path.startswith(("old/", "new/")) or path == "/dev/null")
            if header:
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
    rows = patch.splitlines(keepends=True)
    chunks: dict[str, list[str]] = {}
    current: str | None = None
    index = 0
    while index < len(rows):
        line = rows[index]
        nxt = rows[index + 1] if index + 1 < len(rows) else ""
        third = rows[index + 2] if index + 2 < len(rows) else ""
        if _file_header_pair(line, nxt, third):
            plus = _header_path(nxt)
            minus = _header_path(line)
            if plus == "/dev/null":
                path = minus[2:] if minus.startswith("a/") else minus
            else:
                path = plus[2:] if plus.startswith(("b/", "new/")) else plus
            current = path
            chunks[current] = [line, nxt]
            index += 2
            continue
        if current is not None:
            chunks.setdefault(current, []).append(line)
        index += 1
    return {path: "".join(body) for path, body in chunks.items()}


def line_stats_from_chunk(chunk: str, binary: bool) -> dict:
    if binary:
        return {"added": 0, "removed": 0, "binary": True}
    added = removed = 0
    rows = chunk.splitlines()
    index = 0
    while index < len(rows):
        line = rows[index]
        nxt = rows[index + 1] if index + 1 < len(rows) else ""
        third = rows[index + 2] if index + 2 < len(rows) else ""
        if _file_header_pair(line, nxt, third):
            index += 2
            continue
        if line.startswith("+"):
            added += 1
        elif line.startswith("-"):
            removed += 1
        index += 1
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
    # GNU patch treats a hunk line that starts with `--- ` as a new file header.
    # git apply honors the @@ counts, so a removed `-- ` comment survives.
    git_dir = tree / ".git"
    created = not git_dir.exists()
    if created:
        init = subprocess.run(["git", "init", "-q"], cwd=tree, capture_output=True, text=True)
        if init.returncode != 0:
            detail = (init.stderr or init.stdout or "").strip()
            raise RuntimeError(f"git init failed before apply: {detail[:400]}")
    env = os.environ.copy()
    env["GIT_DIR"] = str(git_dir)
    env["GIT_WORK_TREE"] = str(tree)
    proc = subprocess.run(
        ["git", "apply", "--whitespace=nowarn", "-p1", "-"],
        cwd=tree,
        input=patch,
        text=True,
        capture_output=True,
        env=env,
    )
    if created and git_dir.exists():
        shutil.rmtree(git_dir)
    if proc.returncode != 0:
        detail = (proc.stderr or proc.stdout or "").strip()
        raise RuntimeError(f"patch failed: {detail[:400]}")


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
    saw_baseline = False
    for path in chain:
        manifest = load_manifest(path)
        if manifest.get("baseline"):
            # A later full snapshot starts a new chain. Earlier trees stay on disk.
            files = {}
            base = path / "baseline"
            for file_path in walk_files(base):
                rel = file_path.relative_to(base).as_posix()
                files[rel] = file_path.read_bytes()
            saw_baseline = True
            continue
        if not saw_baseline:
            raise RuntimeError(f"{model} has no baseline at the start of the chain")
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
        "A baseline stores a full byte copy. Later snapshots store a unified text patch unless a later seal is itself a baseline. Binary changes are stored as raw blobs named by sha256. Rebuild with `load_tree_bytes` in `scripts/capture.py`.",
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
        "repo_id": tree.repo_id,
        "node_id": tree.node_id,
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
        "completeness": tree.completeness or "complete",
        "partial_detail": tree.partial_detail,
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
        + (" PARTIAL" if tree.completeness == "partial" else "")
    )
    return {"snapshot_id": snapshot_id, "skipped": False, "manifest": manifest, "tree": tree}


def seal_genuine_baseline(
    root: Path,
    tree: Tree,
    captured_at: str,
    known_ids: set[str],
    *,
    git_diff: dict,
    build: dict,
    reclassify: dict,
) -> dict:
    """Store a full tree and mark it as the first genuine build for this label.

    Earlier snapshots stay where they are. Their events are not rewritten.
    """
    for snap in sealed_snapshots(root, tree.model):
        if not is_complete(snap):
            continue
        previous = load_manifest(snap)
        if previous.get("genuine_build") and previous["commit"]["sha"] == tree.commit:
            return {"snapshot_id": previous["snapshot_id"], "skipped": True}
    snapshot_id = f"{stamp_of(captured_at)}__{tree.commit}"
    snap_dir = snapshot_root(root, tree.model) / snapshot_id
    if snap_dir.exists():
        raise RuntimeError(f"snapshot path already exists: {snap_dir}")
    snap_dir.mkdir(parents=True)
    write_baseline(snap_dir, tree.files)
    spec = score_tree(root, tree)
    count, total_lines, total_bytes = totals(tree.files)
    per_file = []
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
                "binary": rec.binary,
            }
        )
    over = {
        "schema": "lmos.over_time.v1",
        "captured_at": captured_at,
        "model": tree.model,
        "snapshot_id": snapshot_id,
        "commit": tree.commit,
        "parent_snapshot_id": None,
        "baseline": True,
        "genuine_build": True,
        "patch": None,
        "files_added": count,
        "files_removed": 0,
        "files_modified": 0,
        "lines_added": total_lines,
        "lines_removed": 0,
        "directories": directory_rollup(tree.files),
        "files": per_file,
        "binary": [],
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
        "repo_id": tree.repo_id,
        "node_id": tree.node_id,
        "branch": tree.branch,
        "baseline": True,
        "genuine_build": True,
        "baseline_path": f"snapshots/{tree.model}/{snapshot_id}/baseline",
        "parent_snapshot_id": None,
        "invalidates_cross_model_through": reclassify["through_commit"],
        "reclassification_quote": reclassify["quote"],
        "git_diff_from_previous": git_diff,
        "build": build,
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
        "completeness": "complete",
        "partial_detail": None,
        "delta": {
            "files_added": count,
            "files_removed": 0,
            "files_modified": 0,
            "lines_added": total_lines,
            "lines_removed": 0,
        },
        "spec": spec,
        "files": file_rows(tree.files, spec.get("spec_sha256")),
    }
    (snap_dir / "manifest.json").write_text(dump_json(manifest), encoding="utf-8")
    common = dict(
        timestamp=captured_at,
        model=tree.model,
        repo=tree.repo,
        repo_url=tree.repo_url,
        commit=tree.commit,
        commit_url=tree.commit_url,
        branch=tree.branch,
        snapshot_id=snapshot_id,
    )
    short = tree.commit[:12]
    events = [
        make_event(
            event_id=f"evt-{tree.model}-genuine-{short}-0001",
            event_type="SNAPSHOT_CAPTURED",
            severity="info",
            outcome="success",
            path=None,
            hash_before=None,
            hash_after=manifest["tree_sha256"],
            line_stats={"added": total_lines, "removed": 0, "binary": False},
            message=(
                f"Sealed {tree.model} at {short} as the first genuine build baseline. "
                f"Full tree stored ({count} files, {total_lines} lines)."
            ),
            detail={
                "baseline": True,
                "genuine_build": True,
                "parent_snapshot_id": None,
                "file_count": count,
                "total_lines": total_lines,
                "total_bytes": total_bytes,
                "git_diff_from_previous": git_diff,
                "subject": tree.subject,
                "committed_at": tree.committed_at,
                "completeness": "complete",
            },
            **common,
        ),
        make_event(
            event_id=f"evt-{tree.model}-genuine-{short}-0002",
            event_type="BASELINE_ESTABLISHED",
            severity="info",
            outcome="success",
            path=manifest["baseline_path"],
            hash_before=None,
            hash_after=manifest["tree_sha256"],
            line_stats={"added": total_lines, "removed": 0, "binary": False},
            message=(
                f"Stored the full tree for {short} and marked it as {tree.model}'s first genuine build baseline. "
                f"Earlier seals through {reclassify['through_commit'][:12]} stay on disk."
            ),
            detail={"files": count, "genuine_build": True, "through_commit": reclassify["through_commit"]},
            **common,
        ),
        make_event(
            event_id=f"evt-label-confirmed-{tree.repo_id}-{short}",
            event_type="LABEL_MISMATCH_CONFIRMED",
            severity="warning",
            outcome="confirmed",
            path=None,
            hash_before=None,
            hash_after=None,
            line_stats={"added": 0, "removed": 0, "binary": False},
            message=(
                f"Commit {short} on repo {tree.repo_id} says the files it removed were "
                f"{reclassify['quote']} "
                f"Snapshots of this repo through {reclassify['through_commit'][:12]} are that content. "
                "They stay under snapshots/"
                f"{tree.model}. They are not this genuine baseline. "
                "Earlier events were not rewritten."
            ),
            detail=reclassify,
            **common,
        ),
        make_event(
            event_id=f"evt-build-{short}",
            event_type="BUILD_METADATA_RECORDED",
            severity="info",
            outcome="recorded",
            path=build.get("ledger_path"),
            hash_before=None,
            hash_after=None,
            line_stats={"added": 0, "removed": 0, "binary": False},
            message=(
                f"Build {build.get('version')} at {short} reports spec hash {build.get('spec_hash')} "
                f"({build.get('prompt_version')}). "
                f"Flagged contradictions: {', '.join(build.get('flagged') or [])}. "
                f"Tests claimed passing: {build.get('tests_claimed')}. The tracker did not run them."
            ),
            detail=build,
            **common,
        ),
        make_event(
            event_id=f"evt-{tree.model}-genuine-{short}-0003",
            event_type="SPEC_COMPARED",
            severity="info",
            outcome="success" if spec.get("total") else "not_applicable",
            path="reference/lmos_public.md",
            hash_before=None,
            hash_after=spec.get("spec_sha256"),
            line_stats={"added": 0, "removed": 0, "binary": False},
            message=f"Spec evidence {spec.get('covered')}/{spec.get('total')} (gap {spec.get('gap_score')})",
            detail={
                "covered": spec.get("covered"),
                "total": spec.get("total"),
                "coverage": spec.get("coverage"),
                "gap_score": spec.get("gap_score"),
                "rubric_sha256": spec.get("rubric_sha256"),
                "uncovered": [item["id"] for item in spec.get("concepts", []) if not item["covered"]],
                "extra_surfaces": [item["id"] for item in spec.get("extra_surfaces", [])],
                "genuine_build": True,
            },
            **common,
        ),
    ]
    excerpt = snap_dir / "seal" / "events.jsonl"
    excerpt.parent.mkdir(parents=True, exist_ok=True)
    excerpt.write_text("".join(dump_event(event) + "\n" for event in events), encoding="utf-8")
    append_events(root, events, known_ids)
    (snap_dir / ".complete").write_text(captured_at + "\n", encoding="utf-8")
    print(
        f"sealed {tree.model} {short} files={count} lines={total_lines} "
        f"baseline=true genuine=true spec_gap={spec.get('gap_score')}"
    )
    return {"snapshot_id": snapshot_id, "skipped": False, "manifest": manifest}


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
                + (" PARTIAL" if manifest.get("completeness") == "partial" else "")
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
                "completeness": manifest.get("completeness") or "complete",
                "partial_detail": manifest.get("partial_detail"),
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
        for pair in pairs:
            if not pair["shared_count"] or pair["changed"]:
                continue
            if not pair["only_b"]:
                smaller, larger, missing = pair["b"], pair["a"], len(pair["only_a"])
            elif not pair["only_a"]:
                smaller, larger, missing = pair["a"], pair["b"], len(pair["only_b"])
            else:
                continue
            summary += (
                f" {smaller} is a byte-identical subset of {larger}: "
                f"{pair['identical_count']} shared paths match and {missing} paths exist only in {larger}. "
                "The score is missing files, not conflicting edits."
            )
        genuine = [item for item in latest if item.get("genuine_build")]
        partial_models = [item for item in latest if item.get("completeness") == "partial"]
        if partial_models:
            bits = []
            for item in partial_models:
                subject = ((item.get("commit") or {}).get("subject")) or ""
                if BATCH_SUBJECT.search(subject):
                    bits.append(f"{item['model']} is still receiving batch commits")
                else:
                    bits.append(f"{item['model']} batch history still repeats or skips")
            summary += " PARTIAL: " + "; ".join(bits) + "."
        for item in genuine:
            cutoff = item.get("invalidates_cross_model_through") or ""
            summary += (
                f" {item['model']} {item['commit']['sha'][:12]} is the first genuine build baseline."
                f" A {item['model']}-versus-peer score that uses a snapshot through {cutoff[:12]} is invalid."
            )
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
                "files_changed_since_last": (
                    delta["files_added"] + delta["files_removed"] + delta["files_modified"] + int(delta.get("files_renamed") or 0)
                ),
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
    for manifest in manifests:
        if manifest.get("completeness") != "partial":
            continue
        detail = manifest.get("partial_detail") or {}
        batches = detail.get("batch_numbers") or []
        span = f"{batches[0]}–{batches[-1]}" if batches else "unknown"
        extra = []
        if detail.get("repeated_batches"):
            extra.append(f"repeated batches {detail['repeated_batches']}")
        if detail.get("missing_batches"):
            extra.append(f"missing batches {detail['missing_batches']}")
        subject = ((manifest.get("commit") or {}).get("subject")) or ""
        if BATCH_SUBJECT.search(subject):
            head_sentence = "HEAD is still an Add original source batch commit."
        elif subject:
            head_sentence = f"HEAD `{subject}` is not a batch commit."
        else:
            head_sentence = "HEAD is not a batch commit."
        md.append(
            f"`{manifest['model']}` `{manifest['commit']['sha'][:12]}` is PARTIAL. "
            f"{head_sentence} "
            f"Batches seen: {span}."
            + ((" " + "; ".join(extra) + ".") if extra else "")
        )
    if any(item.get("completeness") == "partial" for item in manifests):
        md.append("")
    md.extend(genuine_baseline_lines(manifests))
    pair_summary = latest_pair_summary(root)
    if pair_summary:
        md.append(pair_summary)
        md.append("")
    md.extend(identity_lines(root))
    md.extend(prompt_lines(root))
    md.append("CSV: `trends/snapshots.csv`.")
    md.append("")
    write_if_changed(root / "trends" / "snapshots.csv", csv_text)
    write_if_changed(root / "TRENDS.md", "\n".join(md))


def genuine_baseline_lines(manifests: list[dict]) -> list[str]:
    lines: list[str] = []
    for manifest in manifests:
        if not manifest.get("genuine_build"):
            continue
        commit = manifest["commit"]["sha"]
        cutoff = manifest.get("invalidates_cross_model_through") or ""
        quote = manifest.get("reclassification_quote") or ""
        git_diff = manifest.get("git_diff_from_previous") or {}
        build = manifest.get("build") or {}
        lines.append("## Genuine baseline")
        lines.append("")
        lines.append(
            f"`{manifest['model']}` `{commit[:12]}` is the first genuine build baseline for repo {manifest.get('repo_id')}. "
            "It is a full tree, not a patch on the earlier seals."
        )
        if quote:
            lines.append("")
            lines.append(f"The commit message says: {quote}")
        if cutoff:
            lines.append("")
            lines.append(
                f"Snapshots of this repo through `{cutoff[:12]}` are the content that commit removed. "
                f"Any {manifest['model']}-versus-Grok conclusion drawn from those snapshots is invalid. "
                "The old events were not rewritten, and those snapshot directories were not moved."
            )
        if git_diff.get("files_changed") is not None:
            lines.append("")
            lines.append(
                f"`git diff --find-renames {str(git_diff.get('from_commit') or '')[:12]}..{commit[:12]}` "
                f"changes {git_diff.get('files_changed')} files: "
                f"{git_diff.get('added')} added, {git_diff.get('removed')} removed, "
                f"{git_diff.get('modified')} modified, {git_diff.get('renamed')} renamed "
                f"({git_diff.get('rename_from')} → {git_diff.get('rename_to')}), "
                f"{git_diff.get('insertions')} insertions, {git_diff.get('deletions')} deletions."
            )
        if build.get("version"):
            lines.append("")
            lines.append(
                f"Build {build.get('version')} reports spec hash `{build.get('spec_hash')}` "
                f"({build.get('prompt_version')}). "
                f"Flagged contradictions: {', '.join(build.get('flagged') or [])}. "
                f"Decision labels in the ledger: {', '.join(build.get('decision_labels') or [])}. "
                f"Tests claimed passing: {build.get('tests_claimed')}. "
                "The tracker did not run them. "
                f"Stack recorded from the ledger and package.json: {build.get('stack')}."
            )
        lines.append("")
    return lines


def latest_pair_summary(root: Path) -> str | None:
    base = root / "deltas" / "cross_model"
    if not base.exists():
        return None
    best = None
    best_at = ""
    for path in base.glob("*.json"):
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if payload.get("mode") != "cross_model":
            continue
        captured = payload.get("captured_at") or ""
        if captured >= best_at:
            best_at = captured
            best = payload.get("summary")
    return best


def counts_as_model(item: dict) -> bool:
    if "counts_as_model" in item:
        return bool(item["counts_as_model"])
    if item.get("attribution") in ("pending", "no_commits"):
        return False
    return bool(item.get("commits"))


def identity_lines(root: Path) -> list[str]:
    path = root / "state" / "repo_registry.json"
    if not path.exists():
        return []
    registry = json.loads(path.read_text(encoding="utf-8"))
    repos = registry.get("repos") or {}
    if not repos:
        return []
    lines = [
        "## Identity",
        "",
        "Repository id is the GitHub id and does not change when the slug changes. Capture reads `GET /repositories/{id}` and keeps one model for that id. A rename appends `REPO_RENAMED` and does not relabel `snapshots/<model>`.",
        "",
        "| repo_id | node_id | label | current name | commits | attribution | counts | names |",
        "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ]
    for repo_id in sorted(repos):
        item = repos[repo_id]
        lines.append(
            "| {repo_id} | {node} | {label} | {name} | {commits} | {attr} | {counts} | {names} |".format(
                repo_id=item.get("repo_id") or repo_id,
                node=item.get("node_id") or "",
                label=item.get("model_label") or "",
                name=item.get("current_full_name") or "",
                commits="yes" if item.get("commits") else "no",
                attr=item.get("attribution") or "",
                counts="yes" if counts_as_model(item) else "no",
                names=", ".join(item.get("names") or []),
            )
        )
    lines.append("")
    slots = registry.get("model_slots") or {}
    if slots:
        lines.extend(
            [
                "## Model slots",
                "",
                "A slot counts a repository when its source line says `attribution=confirmed` or `attribution=assigned` on that repo id. A pending slot stays empty.",
                "",
                "| model | state | repos | repo_id |",
                "| --- | --- | --- | --- |",
            ]
        )
        order = [name for name in ("claude", "grok", "chatgpt") if name in slots]
        order.extend(sorted(name for name in slots if name not in order))
        phrases = []
        for name in order:
            item = slots[name]
            count = int(item.get("count") or 0)
            lines.append(
                f"| {name} | {item.get('state') or ''} | {count} | {item.get('repo_id') or '—'} |"
            )
            display = {"chatgpt": "ChatGPT", "claude": "Claude", "grok": "Grok"}.get(name, name.capitalize())
            if item.get("state") == "tracked" and count:
                phrases.append(f"{display}: {count} repo tracked" if count == 1 else f"{display}: {count} repos tracked")
            else:
                phrases.append(f"{display}: none")
        lines.append("")
        lines.append("; ".join(phrases) + ".")
        lines.append("")
    timeline = []
    for repo_id in sorted(repos):
        for row in repos[repo_id].get("renames") or []:
            timeline.append((row.get("detected_at") or "", repo_id, row))
    if timeline:
        lines.append("## Rename timeline")
        lines.append("")
        lines.append("One repo id keeps one model. These rows are slug changes, including names that only remain as redirects.")
        lines.append("")
        for _, repo_id, row in sorted(timeline, key=lambda item: (item[0], item[1], item[2].get("old_name") or "")):
            lines.append(
                f"- `{row.get('detected_at')}`: `{row.get('old_name')}` → `{row.get('new_name')}` (repo {repo_id})"
            )
        lines.append("")
    for repo_id in sorted(repos):
        item = repos[repo_id]
        if item.get("model_slot") == "pending" and item.get("snapshot_id"):
            label = item.get("model_label") or "that label"
            lines.append(
                f"Seals labeled {label} are history for repo {repo_id} ({item.get('current_full_name')}). "
                f"The {label} slot is pending and counts zero repositories."
            )
    if any(item.get("model_slot") == "pending" and item.get("snapshot_id") for item in repos.values()):
        lines.append("")
    for repo_id in sorted(repos):
        note = repos[repo_id].get("note")
        if note:
            lines.append(f"- `{repo_id}`: {note}")
    lines.append("")
    return lines


PROBE_LINE = re.compile(r"^#\s+PROBE\s+(?P<target>\S+)\s*$")
ALIAS_LINE = re.compile(r"^#\s+ALIASES\s+(?P<repo_id>\d+)\s+(?P<names>.+?)\s*$")
PROMPT_LINE = re.compile(
    r"^#\s+PROMPT\s+(?P<model>[a-z][a-z0-9_-]{0,31})\s+(?P<version>\S+)"
    r"(?:\s+sha256=(?P<sha>\S+))?"
    r"(?:\s+file=(?P<file>\S+))?"
    r"(?:\s+status=(?P<status>\S+))?"
    r"\s*$"
)
HOP_LINE = re.compile(
    r"^#\s+ALIAS_HOP\s+(?P<repo_id>\d+)\s+(?P<old>\S+)\s+(?P<new>\S+)"
    r"(?:\s+observed_at=(?P<observed>\S+))?\s*$"
)
MODEL_TOKENS = ("chatgpt", "claude", "openai", "grok", "gpt")
REGISTRY_SCHEMA = "lmos.repo_registry.v1"
EMPTY_LINE_STATS = {"added": 0, "removed": 0, "binary": False}


def is_github_target(target: str) -> bool:
    try:
        return target_kind(target) == "github"
    except RuntimeError:
        return False


def parse_probes(text: str) -> list[str]:
    found: list[str] = []
    for raw in text.splitlines():
        match = PROBE_LINE.match(raw.strip())
        if match:
            found.append(match.group("target"))
    return found


def memo_lookup(lookup):
    cache: dict[str, dict | None] = {}

    def wrapped(target: str) -> dict | None:
        if target not in cache:
            try:
                cache[target] = lookup(target)
            except Exception as exc:
                print(f"identity lookup skipped for {target}: {exc}", file=sys.stderr)
                cache[target] = None
        return cache[target]

    return wrapped


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def github_headers() -> dict[str, str]:
    headers = {
        "Accept": "application/vnd.github+json",
        "User-Agent": "lmos-tracker",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    token = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN")
    if token:
        headers["Authorization"] = f"Bearer {token}"
    return headers


def parse_github_repo(payload: dict) -> dict:
    return {
        "id": str(payload["id"]),
        "node_id": payload.get("node_id"),
        "name": payload.get("name"),
        "full_name": payload["full_name"],
        "html_url": payload.get("html_url") or f"https://github.com/{payload['full_name']}",
        "pushed_at": payload.get("pushed_at"),
        "created_at": payload.get("created_at"),
        "updated_at": payload.get("updated_at"),
        "description": payload.get("description") or "",
        "size": payload.get("size"),
    }


def github_get_json(url: str) -> dict | None:
    request = urllib.request.Request(url, headers=github_headers())
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            payload = json.loads(response.read().decode())
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            return None
        raise RuntimeError(f"{url}: HTTP {exc.code}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"{url}: {exc.reason}") from exc
    if "id" not in payload or "full_name" not in payload:
        return None
    return parse_github_repo(payload)


def github_identity(target: str) -> dict | None:
    """Return the canonical GitHub repo record. HTTP 404 is absence. Other errors raise."""
    return github_get_json(f"https://api.github.com/repos/{target}")


def github_identity_by_id(repo_id: str) -> dict | None:
    """Resolve a repository by its permanent id. A rename keeps this URL stable."""
    return github_get_json(f"https://api.github.com/repositories/{repo_id}")


def github_name_status(full_name: str) -> dict:
    """Return 200 for the current name, 301 for an old name, or 404 when it is absent."""
    url = f"https://api.github.com/repos/{full_name}"
    opener = urllib.request.build_opener(_NoRedirect)
    request = urllib.request.Request(url, headers=github_headers())
    try:
        with opener.open(request, timeout=30) as response:
            payload = json.loads(response.read().decode())
            return {"status": response.status, "location": None, "identity": parse_github_repo(payload)}
    except urllib.error.HTTPError as exc:
        location = exc.headers.get("Location") if exc.headers else None
        if exc.code in (301, 302, 307, 308):
            return {"status": exc.code, "location": location, "identity": None}
        if exc.code == 404:
            return {"status": 404, "location": location, "identity": None}
        raise RuntimeError(f"{full_name}: HTTP {exc.code}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"{full_name}: {exc.reason}") from exc


def alias_belongs(status: dict, repo_id: str) -> bool:
    if status.get("status") == 200 and status.get("identity") and str(status["identity"]["id"]) == str(repo_id):
        return True
    if status.get("status") in (301, 302, 307, 308):
        location = (status.get("location") or "").rstrip("/")
        return location.endswith(f"/repositories/{repo_id}")
    return False


def parse_aliases(text: str) -> dict[str, list[str]]:
    found: dict[str, list[str]] = {}
    for raw in text.splitlines():
        match = ALIAS_LINE.match(raw.strip())
        if not match:
            continue
        names = match.group("names").split()
        bucket = found.setdefault(match.group("repo_id"), [])
        for name in names:
            if name not in bucket:
                bucket.append(name)
    return found


def parse_prompts(text: str) -> list[dict]:
    found = []
    for raw in text.splitlines():
        match = PROMPT_LINE.match(raw.strip())
        if not match:
            continue
        found.append(
            {
                "model": match.group("model"),
                "version": match.group("version"),
                "sha256": match.group("sha") or "pending",
                "file": match.group("file") or "pending",
                "status": match.group("status") or "recorded",
            }
        )
    return found


def prompt_lines(root: Path) -> list[str]:
    path = root / "config" / "sources.txt"
    if not path.exists():
        return []
    prompts = parse_prompts(path.read_text(encoding="utf-8"))
    if not prompts:
        return []
    lines = [
        "## Prompt versions",
        "",
        "Each model ran a named prompt. The SHA-256 is the pinned spec file when that file is in this tracker. `pending` means the text is not here yet.",
        "",
        "| model | prompt | file | sha256 | status |",
        "| --- | --- | --- | --- | --- |",
    ]
    for item in prompts:
        sha = item["sha256"]
        shown = sha if sha == "pending" or len(sha) < 16 else f"{sha[:8]}…{sha[-4:]}"
        lines.append(
            f"| {item['model']} | {item['version']} | {item['file']} | `{shown}` | {item['status']} |"
        )
    lines.append("")
    by_version: dict[str, list[str]] = {}
    for item in prompts:
        by_version.setdefault(item["version"], []).append(item["model"])
    if "PV-0.9.0-full" in by_version and "PV-0.10-lite" in by_version:
        full = ", ".join(by_version["PV-0.9.0-full"])
        lite = ", ".join(by_version["PV-0.10-lite"])
        lines.append(
            f"{full} ran PV-0.9.0-full (`reference/lmos_public.md`). {lite} is assigned PV-0.10-lite, the lightweight prompt, and that text is still pending. "
            "ChatGPT versus Claude or Grok is a big prompt against a lightweight prompt. Model and prompt are confounded. It is not a model-versus-model comparison."
        )
        lines.append("")
    elif len(by_version) > 1:
        lines.append(
            "More than one prompt version is assigned. A comparison across those versions confounds model and prompt. It is not a model-versus-model comparison."
        )
        lines.append("")
    return lines


def parse_hops(text: str) -> list[dict]:
    found = []
    for raw in text.splitlines():
        match = HOP_LINE.match(raw.strip())
        if not match:
            continue
        found.append(
            {
                "repo_id": match.group("repo_id"),
                "old": match.group("old"),
                "new": match.group("new"),
                "observed_at": match.group("observed"),
            }
        )
    return found


def mixed_slug(full_name: str) -> bool:
    slug = full_name.split("/", 1)[-1]
    return "-" in slug and "_" in slug


def github_recent_commits(target: str, limit: int = 30) -> list[dict]:
    url = f"https://api.github.com/repos/{target}/commits?per_page={limit}"
    request = urllib.request.Request(
        url,
        headers={
            "Accept": "application/vnd.github+json",
            "User-Agent": "lmos-tracker",
            "X-GitHub-Api-Version": "2022-11-28",
        },
    )
    token = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN")
    if token:
        request.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            payload = json.loads(response.read().decode())
    except urllib.error.HTTPError as exc:
        if exc.code in (404, 409):
            return []
        raise RuntimeError(f"{target} commits: HTTP {exc.code}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"{target} commits: {exc.reason}") from exc
    commits = []
    for item in payload:
        commit = item.get("commit") or {}
        author = (commit.get("author") or {}).get("name") or ""
        message = commit.get("message") or ""
        commits.append(
            {
                "sha": item.get("sha"),
                "author": author,
                "committed_at": (commit.get("author") or {}).get("date"),
                "subject": message.splitlines()[0] if message else "",
            }
        )
    return commits


def advertised_head(target: str) -> str | None:
    if not is_github_target(target):
        return None
    _, fetch = github_urls(target)
    try:
        proc = run(["git", "ls-remote", fetch, "HEAD"], check=False)
    except Exception:
        return None
    if proc.returncode != 0:
        return None
    lines = [line for line in proc.stdout.splitlines() if line.strip()]
    if not lines:
        return None
    return lines[0].split()[0]


def finish_text(text: str, original: str) -> str:
    if (original.endswith("\n") or not original) and not text.endswith("\n"):
        text += "\n"
    return text


def replace_source_line(text: str, model: str, new_line: str) -> str:
    lines: list[str] = []
    for raw in text.splitlines():
        stripped = raw.strip()
        body = stripped[1:].strip() if stripped.startswith("#") else stripped
        match = SOURCE_LINE.match(body) if body else None
        if match and match.group("model") == model:
            lines.append(new_line)
            continue
        lines.append(raw)
    return finish_text("\n".join(lines), text)


def tokens_in(text: str) -> list[str]:
    found: list[str] = []
    if re.search(r"chatgpt", text, re.IGNORECASE):
        found.append("chatgpt")
    if re.search(r"claude", text, re.IGNORECASE):
        found.append("claude")
    if re.search(r"openai", text, re.IGNORECASE):
        found.append("openai")
    if re.search(r"grok", text, re.IGNORECASE):
        found.append("grok")
    if re.search(r"(?<![a-z])gpt(?![a-z])", text, re.IGNORECASE):
        found.append("gpt")
    return found


def short_hash(payload: object) -> str:
    raw = json.dumps(payload, sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(raw.encode()).hexdigest()[:12]


def load_registry(root: Path) -> dict:
    path = root / "state" / "repo_registry.json"
    if not path.exists():
        return {"schema": REGISTRY_SCHEMA, "repos": {}}
    return json.loads(path.read_text(encoding="utf-8"))


def model_manifests(root: Path, model: str) -> list[dict]:
    return [load_manifest(path) for path in sealed_snapshots(root, model) if is_complete(path)]


def claim_sources(enabled: list[Source], identities: dict[str, dict | None]) -> tuple[list[Source], dict[str, str]]:
    """First enabled source to claim a GitHub id is kept. Later sources that resolve to it are skipped."""
    claimed: dict[str, str] = {}
    dupes: dict[str, str] = {}
    keepers: list[Source] = []
    for source in enabled:
        ident = identities.get(source.model)
        if not ident:
            keepers.append(source)
            continue
        actual = str(ident["id"])
        if source.repo_id and source.repo_id != actual:
            keepers.append(source)
            continue
        if actual in claimed:
            dupes[source.model] = claimed[actual]
            continue
        claimed[actual] = source.model
        keepers.append(source)
    return keepers, dupes


BATCH_SUBJECT = re.compile(r"Add original source \(batch-(\d+)\.json\)", re.IGNORECASE)


def partial_upload(subjects: list[str]) -> dict | None:
    """A batch-NN upload is partial while HEAD is still one of those commits, or the numbers skip or repeat."""
    numbers: list[int] = []
    for subject in subjects:
        match = BATCH_SUBJECT.search(subject or "")
        if match:
            numbers.append(int(match.group(1)))
    if not numbers:
        return None
    latest_is_batch = bool(subjects) and bool(BATCH_SUBJECT.search(subjects[0] or ""))
    present = set(numbers)
    unique = sorted(present)
    repeated = sorted(number for number in unique if numbers.count(number) > 1)
    missing = [number for number in range(unique[0], unique[-1] + 1) if number not in present]
    if not latest_is_batch and not repeated and not missing:
        return None
    reasons = []
    if latest_is_batch:
        reasons.append("HEAD is still an Add original source batch commit")
    else:
        reasons.append("HEAD is no longer a batch commit")
    if repeated:
        reasons.append("batch numbers repeat")
    if missing:
        reasons.append("batch numbers skip")
    reason = "; ".join(reasons)
    return {
        "status": "partial",
        "reason": reason,
        "head_is_batch": latest_is_batch,
        "batch_numbers": unique,
        "repeated_batches": repeated,
        "missing_batches": missing,
        "latest_batch": max(numbers) if latest_is_batch else unique[-1],
    }


def is_grok_fingerprint(path: str) -> bool:
    lower = path.lower()
    return "__grok" in lower or "grok-pwa" in lower or lower.startswith(".grok/") or "/.grok/" in lower


def tree_texts(files: dict[str, bytes]) -> dict[str, str]:
    texts: dict[str, str] = {}
    for path, data in files.items():
        if b"\0" in data:
            continue
        texts[path] = data.decode("utf-8", errors="replace")
    return texts


def first_heading(text: str) -> str | None:
    for line in text.splitlines():
        if line.startswith("#"):
            return line.strip()
    return None


def assess_attribution(files: dict[str, bytes], manifests: list[dict], label: str, full_name: str) -> dict:
    texts = tree_texts(files)
    heading = first_heading(texts.get("README.md", ""))
    package_name = None
    if "package.json" in texts:
        try:
            package_name = json.loads(texts["package.json"]).get("name")
        except json.JSONDecodeError:
            package_name = None
    fingerprints = sorted(path for path in texts if is_grok_fingerprint(path))
    word_counts = {token: 0 for token in ("claude", "anthropic", "chatgpt", "openai", "grok")}
    generated_model: list[str] = []
    generated_other: list[str] = []
    markers = {"og.grok": 0, "virtual:grok-og-identity": 0, ".grok/": 0}
    for path, text in texts.items():
        if path == "docs/lmos_public.md":
            continue
        body = text
        if path.lower() == "readme.md":
            lines = text.splitlines()
            if lines and lines[0].startswith("#"):
                body = "\n".join(lines[1:])
        for token, pattern in (
            ("claude", r"claude"),
            ("anthropic", r"anthropic"),
            ("chatgpt", r"chatgpt"),
            ("openai", r"openai"),
            ("grok", r"grok"),
        ):
            word_counts[token] += len(re.findall(pattern, body, flags=re.IGNORECASE))
        for line in text.splitlines():
            if "generated by" not in line.lower():
                continue
            shown = f"{path}: {line.strip()}"
            if re.search(r"generated by\s+(claude|anthropic|grok|chatgpt|openai|gpt)\b", line, re.IGNORECASE):
                generated_model.append(shown)
            elif len(generated_other) < 5:
                generated_other.append(shown)
        markers["og.grok"] += body.lower().count("og.grok")
        markers["virtual:grok-og-identity"] += body.lower().count("virtual:grok-og-identity")
        markers[".grok/"] += body.lower().count(".grok/")
    authors = sorted({item["commit"].get("author") or "" for item in manifests if item.get("commit")})
    subjects = [item["commit"].get("subject") or "" for item in manifests if item.get("commit")]
    name_tokens = tokens_in(full_name)
    heading_tokens = tokens_in(heading or "")
    conflicts: list[str] = []
    supports: list[str] = []
    if name_tokens and label not in name_tokens:
        conflicts.append(
            f"GitHub full_name {full_name} names {', '.join(name_tokens)}, and the assigned label is {label}."
        )
    elif name_tokens and label in name_tokens:
        supports.append(f"GitHub full_name {full_name} contains the assigned label {label}.")
    if heading and heading_tokens and label not in heading_tokens:
        conflicts.append(f"README heading {heading} does not contain the assigned label {label}.")
    elif heading and label in heading_tokens:
        supports.append(f"README heading {heading} matches the assigned label {label}.")
    if heading_tokens and name_tokens and set(heading_tokens).isdisjoint(name_tokens):
        conflicts.append(
            f"README heading {heading} and GitHub name {full_name} name different models."
        )
    if fingerprints and label != "grok":
        conflicts.append(
            f"{len(fingerprints)} paths are Grok app-builder harness files (public/__grok, scripts/grok-pwa). "
            "That is a scaffold fingerprint, not a signature on the game code, and it is not zero."
        )
    elif fingerprints and label == "grok":
        supports.append(f"{len(fingerprints)} paths are Grok app-builder harness files.")
    if word_counts["claude"] == 0 and word_counts["anthropic"] == 0 and label == "claude":
        conflicts.append(
            "Outside the README heading and the spec copy, the tree has no claude or anthropic strings."
        )
    if not generated_model:
        supports.append(
            "No line says the tree was generated by Claude, Grok, ChatGPT, or OpenAI. "
            + (
                "Other generated-by lines: " + "; ".join(generated_other) + "."
                if generated_other
                else "No generated-by line names a model."
            )
        )
    else:
        conflicts.append("A generated-by line names a model: " + "; ".join(generated_model) + ".")
    if package_name:
        supports.append(f"package.json name is {package_name}, which does not name a model.")
    if authors:
        supports.append(
            "Sealed commit authors are " + ", ".join(author for author in authors if author) + ", the GitHub account rather than a model id."
        )
    retitles = [subject for subject in subjects if subject.lower().startswith("rename project")]
    if retitles:
        conflicts.append("Commit subjects retitle the project: " + "; ".join(retitles) + ".")
    conclusion = "uncertain" if conflicts else "consistent"
    return {
        "conclusion": conclusion,
        "assigned_label": label,
        "label_left_unchanged": True,
        "full_name": full_name,
        "readme_heading": heading,
        "package_name": package_name,
        "name_tokens": name_tokens,
        "heading_tokens": heading_tokens,
        "fingerprint_paths": fingerprints,
        "word_counts_outside_heading_and_spec": word_counts,
        "content_markers": markers,
        "generated_by_model": generated_model,
        "generated_by_other": generated_other,
        "supports_assigned_label": supports,
        "weighs_against_assigned_label": conflicts,
        "authors": authors,
        "retitle_subjects": retitles,
    }


def mismatch_reasons(label: str, full_name: str, heading: str | None) -> list[str]:
    reasons: list[str] = []
    name_tokens = tokens_in(full_name)
    heading_tokens = tokens_in(heading or "")
    if name_tokens and label not in name_tokens:
        reasons.append(f"GitHub full_name {full_name} does not contain the assigned label {label}.")
    if heading and heading_tokens and label not in heading_tokens:
        reasons.append(f"README heading {heading} does not contain the assigned label {label}.")
    if heading_tokens and name_tokens and set(heading_tokens).isdisjoint(name_tokens):
        reasons.append(f"README heading {heading} and GitHub name {full_name} name different models.")
    return reasons


def identity_event(
    *,
    timestamp: str,
    event_id: str,
    event_type: str,
    severity: str,
    outcome: str,
    model: str,
    repo: str,
    repo_url: str | None,
    commit: str | None,
    snapshot_id: str | None,
    message: str,
    detail: dict,
) -> dict:
    return make_event(
        timestamp=timestamp,
        event_id=event_id,
        event_type=event_type,
        severity=severity,
        outcome=outcome,
        model=model,
        repo=repo,
        repo_url=repo_url,
        commit=commit,
        commit_url=f"{repo_url}/commit/{commit}" if repo_url and commit else None,
        branch="main",
        snapshot_id=snapshot_id,
        path=None,
        hash_before=None,
        hash_after=None,
        line_stats=EMPTY_LINE_STATS,
        message=message,
        detail=detail,
    )


def render_single_cross(payload: dict) -> str:
    lines = [
        f"# Cross-model diff {payload['captured_at']}",
        "",
        payload["summary"],
        "",
        "## Distinct repositories with a tree",
        "",
        "| repo_id | label | current name | head | sealed snapshot |",
        "| --- | --- | --- | --- | --- |",
    ]
    for row in payload["content_repos"]:
        lines.append(
            f"| {row['repo_id']} | {row['label']} | {row['full_name']} | `{row['head'][:12]}` | {row['snapshot_id']} |"
        )
    lines.extend(
        [
            "",
            "Pairwise divergence was not computed. A score between two names of one repository would compare a tree to itself.",
            "",
        ]
    )
    if payload.get("names"):
        lines.append("Names seen for this id: " + ", ".join(f"`{name}`" for name in payload["names"]) + ".")
        lines.append("")
    if payload.get("over_time"):
        over = payload["over_time"]
        changed = ", ".join(over["paths"]) if over["paths"] else "none"
        lines.append(
            f"Over time, label {over['model']} moved from `{over['parent_commit'][:12]}` to `{over['commit'][:12]}`. "
            f"Changed paths: {changed}. That delta is `deltas/over_time/{over['model']}/{over['snapshot_id']}.md`."
        )
        lines.append("")
    if payload["empty_repositories"]:
        lines.append("## Repositories with no commits")
        lines.append("")
        lines.append("These ids exist and advertise no HEAD. They are not a second build and they are not scored.")
        lines.append("")
        lines.append("| label | repo_id | name | created_at | pushed_at |")
        lines.append("| --- | --- | --- | --- | --- |")
        for row in payload["empty_repositories"]:
            lines.append(
                f"| {row['model']} | {row['repo_id']} | {row['full_name']} | {row.get('created_at') or ''} | {row.get('pushed_at') or ''} |"
            )
        lines.append("")
    if payload.get("unsealed_with_commits"):
        lines.append("## Placeholders that already have commits")
        lines.append("")
        lines.append("These were not sealed. Enable the line once Josh wants that label tracked.")
        lines.append("")
        for row in payload["unsealed_with_commits"]:
            lines.append(f"- {row['model']}: `{row['full_name']}` `{row['head']}`")
        lines.append("")
    if payload["not_found"]:
        lines.append("## Names that are not visible")
        lines.append("")
        lines.append("HTTP 404 for the connected account. No event is logged for a missing name.")
        lines.append("")
        for row in payload["not_found"]:
            lines.append(f"- `{row['target']}`")
        lines.append("")
    if any(row.get("attribution") == "confirmed" for row in payload.get("content_repos") or []):
        label = payload["content_repos"][0]["label"]
        lines.append(f"Josh confirmed the sealed label. It stays {label}.")
    else:
        lines.append("The sealed model label is unchanged until Josh confirms a relabel.")
    lines.append("")
    return "\n".join(lines)


def apply_alias_hops(
    events: list[dict],
    renames: list[dict],
    names: set[str],
    hops: list[dict],
    repo_id: str,
    ident: dict,
    source: Source,
    manifest: dict | None,
    name_status,
    captured_at: str,
) -> None:
    for hop in hops:
        if hop["repo_id"] != repo_id:
            continue
        old_name = hop["old"]
        new_name = hop["new"]
        names.add(old_name)
        names.add(new_name)
        if any(row.get("old_name") == old_name and row.get("new_name") == new_name for row in renames):
            continue
        if name_status is None:
            continue
        try:
            old_status = name_status(old_name)
            new_status = name_status(new_name)
        except Exception as exc:
            print(f"alias hop skipped {old_name} -> {new_name}: {exc}", file=sys.stderr)
            continue
        if not alias_belongs(old_status, repo_id) or not alias_belongs(new_status, repo_id):
            print(f"alias hop not verified {old_name} -> {new_name}", file=sys.stderr)
            continue
        observed = hop.get("observed_at") or captured_at
        renames.append(
            {
                "old_name": old_name,
                "new_name": new_name,
                "detected_at": observed,
                "repo_id": repo_id,
            }
        )
        events.append(
            identity_event(
                timestamp=observed,
                event_id=f"evt-rename-{repo_id}-{short_hash([old_name, new_name])}",
                event_type="REPO_RENAMED",
                severity="warning",
                outcome="success",
                model=source.model,
                repo=ident.get("full_name") or new_name,
                repo_url=ident.get("html_url"),
                commit=manifest["commit"]["sha"] if manifest else None,
                snapshot_id=manifest["snapshot_id"] if manifest else None,
                message=(
                    f"GitHub repo id {repo_id} was {old_name} and then {new_name}. "
                    f"Observed at {observed}. The current canonical name is {ident.get('full_name')}."
                ),
                detail={
                    "old_name": old_name,
                    "new_name": new_name,
                    "repo_id": repo_id,
                    "node_id": ident.get("node_id"),
                    "detected_at": observed,
                    "observed_at": observed,
                    "current_full_name": ident.get("full_name"),
                    "current_updated_at": ident.get("updated_at"),
                    "old_http_status": old_status.get("status"),
                    "old_location": old_status.get("location"),
                    "new_http_status": new_status.get("status"),
                    "new_location": new_status.get("location"),
                    "label_left_unchanged": source.model,
                },
            )
        )


def append_confirmed_attribution(
    events: list[dict],
    root: Path,
    repo_id: str,
    source: Source,
    ident: dict,
    manifest: dict,
    assessment: dict | None,
    heading: str | None,
    names: set[str],
    detected_at: str,
) -> None:
    seals = []
    for item in all_manifests(root):
        if str(item.get("repo_id") or "") == repo_id:
            seals.append(
                {
                    "model": item.get("model"),
                    "snapshot_id": item.get("snapshot_id"),
                    "commit": (item.get("commit") or {}).get("sha"),
                }
            )
    foreign = [row for row in seals if row["model"] != source.model]
    fingerprints = assessment["fingerprint_paths"] if assessment else []
    message = (
        f"Josh confirmed repo_id {repo_id} (node_id {source.node_id}) is the {source.model} build. "
        "An earlier slug that named another model was accidental and is this same repository. "
        f"Seals of this repo id stay under snapshots/{source.model}. "
    )
    if foreign:
        shown = ", ".join(f"{row['model']} {row['snapshot_id']}" for row in foreign)
        message += f"Seals of this repo id under other labels stay on disk and are reattributed by this event: {shown}. "
    else:
        message += f"No seal of repo_id {repo_id} is stored under another model. "
    message += (
        "Earlier MODEL_ATTRIBUTION_UNCERTAIN events remain in the log. "
        "Grok harness files remain in the tree and do not change the label. "
        "The Grok and ChatGPT slots stay empty until a different repo id is confirmed."
    )
    events.append(
        identity_event(
            timestamp=detected_at,
            event_id=f"evt-attrib-corrected-{repo_id}-{source.model}",
            event_type="MODEL_ATTRIBUTION_CORRECTED",
            severity="notice",
            outcome="corrected",
            model=source.model,
            repo=ident.get("full_name"),
            repo_url=ident.get("html_url"),
            commit=manifest["commit"]["sha"],
            snapshot_id=manifest["snapshot_id"],
            message=message,
            detail={
                "repo_id": repo_id,
                "node_id": source.node_id,
                "assigned_label": source.model,
                "confirmed_by": "Josh",
                "current_full_name": ident.get("full_name"),
                "readme_heading": heading,
                "package_name": assessment.get("package_name") if assessment else None,
                "fingerprint_paths": fingerprints,
                "word_counts_outside_heading_and_spec": assessment.get("word_counts_outside_heading_and_spec") if assessment else None,
                "content_markers": assessment.get("content_markers") if assessment else None,
                "seals_of_this_repo_id": seals,
                "reattributed_seals": foreign,
                "history_deleted": False,
                "grok_slot": "pending",
                "chatgpt_slot": "pending",
            },
        )
    )
    slug = (ident.get("full_name") or "").split("/", 1)[-1]
    expected = f"lmos_public_{source.model}"
    mixed = sorted(name for name in names if mixed_slug(name))
    heading_text = (heading or "").lstrip("#").strip()
    heading_differs = bool(heading_text) and heading_text != slug
    if slug == expected:
        resolved = (
            f"GitHub name {ident.get('full_name')} matches {expected}. "
            "The slug convention mismatch is resolved."
        )
        if mixed:
            resolved += " Previous alias " + ", ".join(mixed) + " still redirects and does not match that pattern."
        if heading_differs:
            resolved += f" README heading remains {heading}."
        events.append(
            identity_event(
                timestamp=detected_at,
                event_id=f"evt-label-resolved-{repo_id}-{source.model}",
                event_type="LABEL_MISMATCH_RESOLVED",
                severity="notice",
                outcome="resolved",
                model=source.model,
                repo=ident.get("full_name"),
                repo_url=ident.get("html_url"),
                commit=manifest["commit"]["sha"],
                snapshot_id=manifest["snapshot_id"],
                message=resolved,
                detail={
                    "resolves": "LABEL_MISMATCH",
                    "repo_id": repo_id,
                    "node_id": source.node_id,
                    "current_full_name": ident.get("full_name"),
                    "expected_pattern": expected,
                    "mixed_aliases": mixed,
                    "readme_heading": heading,
                    "heading_still_differs": heading_differs,
                    "source_renamed_by_tracker": False,
                },
            )
        )
    if not mixed and slug == expected and not heading_differs:
        return
    parts = []
    if mixed:
        parts.append(
            "Previous slug "
            + ", ".join(mixed)
            + " mixes a hyphen and an underscore and does not match lmos_public_<model>."
        )
    if slug == expected:
        parts.append(f"The live canonical name {ident.get('full_name')} matches {expected}.")
    else:
        parts.append(f"The live canonical name {ident.get('full_name')} does not match {expected}.")
    if heading:
        parts.append(f"README heading is {heading}.")
    parts.append("Flag for Josh. The tracker did not rename the source.")
    key = {"repo_id": repo_id, "mixed": mixed, "current": ident.get("full_name"), "heading": heading, "expected": expected}
    events.append(
        identity_event(
            timestamp=detected_at,
            event_id=f"evt-label-convention-{repo_id}-{short_hash(key)}",
            event_type="LABEL_MISMATCH",
            severity="warning",
            outcome="flagged",
            model=source.model,
            repo=ident.get("full_name"),
            repo_url=ident.get("html_url"),
            commit=manifest["commit"]["sha"],
            snapshot_id=manifest["snapshot_id"],
            message=" ".join(parts),
            detail={
                "repo_id": repo_id,
                "node_id": source.node_id,
                "assigned_label": source.model,
                "current_full_name": ident.get("full_name"),
                "expected_pattern": expected,
                "current_matches_pattern": slug == expected,
                "mixed_aliases": mixed,
                "readme_heading": heading,
                "flag_for": "Josh",
                "source_renamed_by_tracker": False,
                "detected_at": detected_at,
            },
        )
    )


def apply_identity_audit(
    root: Path,
    sources_path: Path,
    known: set[str],
    captured_at: str,
    lookup=github_identity,
    head_of=None,
    commits_of=None,
    lookup_by_id=None,
    name_status=None,
) -> dict:
    """Record renames and label questions. Does not relabel a sealed snapshot."""
    text = sources_path.read_text(encoding="utf-8")
    enabled, placeholders = parse_sources(text)
    probes = parse_probes(text)
    interesting = [source.target for source in enabled + placeholders if is_github_target(source.target)]
    interesting.extend(target for target in probes if is_github_target(target))
    if not interesting:
        return {"changed": False, "wrote_cross": False, "distinct_content": 0}
    if head_of is None:
        head_of = advertised_head
    if commits_of is None:
        commits_of = lambda target: []
    identities: dict[str, dict | None] = {}
    for target in interesting:
        identities[target] = lookup(target)
    aliases = parse_aliases(text)
    hops = parse_hops(text)
    events: list[dict] = []
    for source in enabled + placeholders:
        if not source.repo_id or lookup_by_id is None:
            continue
        found = lookup_by_id(source.repo_id)
        if not found:
            continue
        if source.node_id and found.get("node_id") and source.node_id != found["node_id"]:
            events.append(
                identity_event(
                    timestamp=captured_at,
                    event_id=f"evt-label-node-{source.model}-{source.repo_id}",
                    event_type="LABEL_MISMATCH",
                    severity="warning",
                    outcome="flagged",
                    model=source.model,
                    repo=source.target,
                    repo_url=found.get("html_url"),
                    commit=None,
                    snapshot_id=None,
                    message=(
                        f"configured node_id {source.node_id} for repo_id {source.repo_id} "
                        f"does not match GitHub node_id {found.get('node_id')}. The source line was not retargeted."
                    ),
                    detail={
                        "configured_repo_id": source.repo_id,
                        "configured_node_id": source.node_id,
                        "observed_node_id": found.get("node_id"),
                        "observed_full_name": found.get("full_name"),
                        "retargeted": False,
                    },
                )
            )
            continue
        identities[source.target] = found
        identities[found["full_name"]] = found
        source.node_id = found.get("node_id") or source.node_id
    by_model = {source.model: identities.get(source.target) for source in enabled}
    keepers, dupes = claim_sources(enabled, by_model)
    registry = load_registry(root)
    repos: dict[str, dict] = registry.setdefault("repos", {})
    new_text = text
    content_rows = []
    empty_rows = []
    not_found = []
    unsealed = []
    wrote_cross = False

    for source in enabled:
        ident = identities.get(source.target)
        if ident and source.repo_id and source.repo_id != str(ident["id"]):
            events.append(
                identity_event(
                    timestamp=captured_at,
                    event_id=f"evt-label-id-{source.model}-{source.repo_id}-{ident['id']}",
                    event_type="LABEL_MISMATCH",
                    severity="warning",
                    outcome="flagged",
                    model=source.model,
                    repo=source.target,
                    repo_url=ident.get("html_url"),
                    commit=None,
                    snapshot_id=None,
                    message=(
                        f"configured repo_id {source.repo_id} for {source.model} does not match "
                        f"GitHub id {ident['id']} ({ident['full_name']}). The source line was not retargeted."
                    ),
                    detail={
                        "configured_repo_id": source.repo_id,
                        "observed_repo_id": str(ident["id"]),
                        "observed_full_name": ident["full_name"],
                        "assigned_label": source.model,
                        "retargeted": False,
                    },
                )
            )

    for model, keeper in dupes.items():
        ident = by_model.get(model) or {}
        repo_id = str(ident.get("id") or "")
        new_text = replace_source_line(
            new_text,
            model,
            f"# NOTE {model} disabled: repo_id={repo_id} is already tracked as {keeper}",
        )
        events.append(
            identity_event(
                timestamp=captured_at,
                event_id=f"evt-label-dup-{repo_id}-{model}-{keeper}",
                event_type="LABEL_MISMATCH",
                severity="warning",
                outcome="flagged",
                model=model,
                repo=ident.get("full_name"),
                repo_url=ident.get("html_url"),
                commit=None,
                snapshot_id=None,
                message=(
                    f"skip {model}: repo_id {repo_id} is already tracked as {keeper}. "
                    "The same repository is not counted as two models."
                ),
                detail={
                    "repo_id": repo_id,
                    "skipped_label": model,
                    "kept_label": keeper,
                    "full_name": ident.get("full_name"),
                    "retargeted": False,
                },
            )
        )

    claimed_ids = {}
    for source in keepers:
        ident = identities.get(source.target)
        if not ident:
            continue
        if source.repo_id and source.repo_id != str(ident["id"]):
            continue
        claimed_ids[str(ident["id"])] = source

    for source in placeholders:
        if not is_github_target(source.target):
            continue
        ident = identities.get(source.target)
        if ident is None:
            not_found.append({"model": source.model, "target": source.target})
            continue
        repo_id = str(ident["id"])
        if repo_id in claimed_ids:
            keeper = claimed_ids[repo_id]
            new_text = replace_source_line(
                new_text,
                source.model,
                f"# NOTE {source.model} disabled: repo_id={repo_id} is already tracked as {keeper.model}",
            )
            events.append(
                identity_event(
                    timestamp=captured_at,
                    event_id=f"evt-label-dup-{repo_id}-{source.model}-{keeper.model}",
                    event_type="LABEL_MISMATCH",
                    severity="warning",
                    outcome="flagged",
                    model=source.model,
                    repo=ident["full_name"],
                    repo_url=ident.get("html_url"),
                    commit=None,
                    snapshot_id=None,
                    message=(
                        f"placeholder {source.model} resolves to repo_id {repo_id}, already tracked as {keeper.model}. "
                        "It was commented out so enabling it cannot seal a second copy."
                    ),
                    detail={
                        "repo_id": repo_id,
                        "skipped_label": source.model,
                        "kept_label": keeper.model,
                        "full_name": ident["full_name"],
                        "requested_name": source.target,
                    },
                )
            )
            continue
        head = head_of(source.target)
        if not head:
            empty_rows.append(
                {
                    "model": source.model,
                    "target": source.target,
                    "repo_id": repo_id,
                    "full_name": ident["full_name"],
                    "html_url": ident.get("html_url"),
                    "created_at": ident.get("created_at"),
                    "pushed_at": ident.get("pushed_at"),
                    "updated_at": ident.get("updated_at"),
                    "attribution": source.attribution,
                    "node_id": ident.get("node_id") or source.node_id,
                }
            )
            new_text = replace_source_line(
                new_text,
                source.model,
                "# "
                + format_source(
                    source.model,
                    ident["full_name"],
                    repo_id,
                    ident.get("node_id") or source.node_id,
                    source.attribution,
                ),
            )
            continue
        # A placeholder that grows a real HEAD is reported and left commented.
        unsealed.append(
            {
                "model": source.model,
                "target": source.target,
                "repo_id": repo_id,
                "full_name": ident["full_name"],
                "head": head,
            }
        )
        new_text = replace_source_line(
            new_text,
            source.model,
            "# "
            + format_source(
                source.model,
                ident["full_name"],
                repo_id,
                ident.get("node_id") or source.node_id,
                source.attribution,
            ),
        )
        if source.attribution == "pending":
            previous = repos.get(repo_id) or {}
            names = set(previous.get("names") or [])
            names.add(source.target)
            names.add(ident["full_name"])
            repos[repo_id] = {
                "repo_id": repo_id,
                "node_id": ident.get("node_id") or source.node_id,
                "model_label": source.model,
                "model_slot": "pending",
                "counts_as_model": False,
                "names": sorted(names),
                "current_full_name": ident["full_name"],
                "html_url": ident.get("html_url"),
                "head": head,
                "pushed_at": ident.get("pushed_at"),
                "created_at": ident.get("created_at") or previous.get("created_at"),
                "updated_at": ident.get("updated_at"),
                "description": ident.get("description") or previous.get("description") or "",
                "detected_at": previous.get("detected_at") or captured_at,
                "attribution": "pending",
                "readme_heading": previous.get("readme_heading"),
                "sealed_repo_name": previous.get("sealed_repo_name"),
                "snapshot_id": previous.get("snapshot_id"),
                "commits": True,
                "renames": previous.get("renames") or [],
                "note": (
                    f"Slot {source.model} is pending. repo_id {repo_id} ({ident['full_name']}) "
                    "has commits and was not sealed on this run. It counts as that model only after "
                    "Josh confirms this distinct repo id."
                ),
                "remote_commit_authors": previous.get("remote_commit_authors") or [],
                "cross_captured_at": previous.get("cross_captured_at") or {},
            }

    for target in probes:
        ident = identities.get(target)
        if ident is None:
            if not any(row["target"] == target for row in not_found):
                not_found.append({"model": None, "target": target})
            continue
        repo_id = str(ident["id"])
        previous = repos.get(repo_id) or {}
        names = set(previous.get("names") or [])
        names.add(target)
        names.add(ident["full_name"])
        if repo_id in repos:
            repos[repo_id]["names"] = sorted(names)

    for source in keepers:
        ident = identities.get(source.target)
        if not ident or (source.repo_id and source.repo_id != str(ident["id"])):
            continue
        repo_id = str(ident["id"])
        latest = latest_complete(root, source.model)
        if latest is None:
            continue
        manifest = load_manifest(latest)
        manifests = model_manifests(root, source.model)
        full_name = ident["full_name"]
        source.node_id = ident.get("node_id") or source.node_id
        new_text = replace_source_line(
            new_text,
            source.model,
            format_source(source.model, full_name, repo_id, source.node_id, source.attribution),
        )
        try:
            files = load_tree_bytes(root, source.model, manifest["snapshot_id"])
        except (OSError, RuntimeError, FileNotFoundError) as exc:
            print(f"attribution skipped for {source.model}: {exc}", file=sys.stderr)
            files = {}
        assessment = assess_attribution(files, manifests, source.model, full_name) if files else None
        heading = assessment["readme_heading"] if assessment else None
        sealed_names = [item["repo"] for item in manifests]
        old_name = next((name for name in sealed_names if name != full_name), None)
        previous = repos.get(repo_id) or {}
        names = set(previous.get("names") or [])
        names.update(sealed_names)
        names.add(full_name)
        names.add(source.target)
        names.update(aliases.get(repo_id, []))
        renames = list(previous.get("renames") or [])
        detected_at = previous.get("detected_at") or captured_at
        rename_detected = None
        if old_name:
            rename_detected = next(
                (row["detected_at"] for row in renames if row["old_name"] == old_name and row["new_name"] == full_name),
                None,
            )
            if rename_detected is None:
                rename_detected = captured_at
                renames.append({"old_name": old_name, "new_name": full_name, "detected_at": rename_detected, "repo_id": repo_id})
        commit_rows = [
            {
                "sha": item["commit"]["sha"],
                "subject": item["commit"].get("subject"),
                "committed_at": item["commit"].get("committed_at"),
                "author": item["commit"].get("author"),
                "recorded_repo": item["repo"],
            }
            for item in manifests
            if item.get("commit")
        ]
        try:
            remote_commits = commits_of(full_name) or []
            remote_authors = sorted({row["author"] for row in remote_commits if row.get("author")})
        except Exception as exc:
            print(f"commit list skipped for {full_name}: {exc}", file=sys.stderr)
            remote_commits = []
            remote_authors = list(previous.get("remote_commit_authors") or [])
        if old_name:
            retitles = [row["subject"] for row in commit_rows if (row.get("subject") or "").lower().startswith("rename project")]
            message = (
                f"GitHub repo id {repo_id} is {full_name}. "
                f"The sealed manifest recorded {old_name}."
            )
            if retitles:
                message += " Commit subjects that retitle the project: " + "; ".join(retitles) + "."
                message += " Those commits do not by themselves change the GitHub slug."
            events.append(
                identity_event(
                    timestamp=rename_detected,
                    event_id=f"evt-rename-{repo_id}-{short_hash([old_name, full_name])}",
                    event_type="REPO_RENAMED",
                    severity="warning",
                    outcome="success",
                    model=source.model,
                    repo=full_name,
                    repo_url=ident.get("html_url"),
                    commit=manifest["commit"]["sha"],
                    snapshot_id=manifest["snapshot_id"],
                    message=message,
                    detail={
                        "old_name": old_name,
                        "new_name": full_name,
                        "repo_id": repo_id,
                        "detected_at": rename_detected,
                        "created_at": ident.get("created_at"),
                        "pushed_at": ident.get("pushed_at"),
                        "description": ident.get("description"),
                        "sealed_commits": commit_rows,
                        "label_left_unchanged": source.model,
                    },
                )
            )
        apply_alias_hops(
            events,
            renames,
            names,
            hops,
            repo_id,
            ident,
            source,
            manifest,
            name_status,
            captured_at,
        )
        confirmed = source.attribution == "confirmed"
        reasons = mismatch_reasons(source.model, full_name, heading)
        if reasons and not confirmed:
            events.append(
                identity_event(
                    timestamp=detected_at,
                    event_id=f"evt-label-{repo_id}-{short_hash([source.model, full_name, heading])}",
                    event_type="LABEL_MISMATCH",
                    severity="warning",
                    outcome="flagged",
                    model=source.model,
                    repo=full_name,
                    repo_url=ident.get("html_url"),
                    commit=manifest["commit"]["sha"],
                    snapshot_id=manifest["snapshot_id"],
                    message=" ".join(reasons) + f" The sealed label stays {source.model} until Josh confirms a relabel.",
                    detail={
                        "assigned_label": source.model,
                        "current_full_name": full_name,
                        "readme_heading": heading,
                        "repo_id": repo_id,
                        "reasons": reasons,
                        "label_left_unchanged": True,
                        "detected_at": detected_at,
                    },
                )
            )
        if assessment and assessment["conclusion"] == "uncertain" and not confirmed:
            # The question is the label, the slug, and the heading. A later batch
            # of the same tree must not append a new event just because a word count moved.
            question = {
                "label": source.model,
                "full_name": full_name,
                "heading": heading,
                "conclusion": assessment["conclusion"],
                "name_tokens": assessment["name_tokens"],
                "heading_tokens": assessment["heading_tokens"],
                "grok_harness": bool(assessment["fingerprint_paths"]),
                "generated_by_model": bool(assessment["generated_by_model"]),
            }
            events.append(
                identity_event(
                    timestamp=detected_at,
                    event_id=f"evt-attrib-{repo_id}-{short_hash(question)}",
                    event_type="MODEL_ATTRIBUTION_UNCERTAIN",
                    severity="notice",
                    outcome="uncertain",
                    model=source.model,
                    repo=full_name,
                    repo_url=ident.get("html_url"),
                    commit=manifest["commit"]["sha"],
                    snapshot_id=manifest["snapshot_id"],
                    message=(
                        f"Attribution for repo_id {repo_id} is uncertain. "
                        f"The sealed label stays {source.model} until Josh confirms it."
                    ),
                    detail=assessment,
                )
            )
        if confirmed:
            append_confirmed_attribution(
                events,
                root,
                repo_id,
                source,
                ident,
                manifest,
                assessment,
                heading,
                names,
                detected_at,
            )
        if confirmed:
            note = (
                f"Josh confirmed repo_id {repo_id} is the {source.model} build. "
                f"GitHub full_name is {full_name}. node_id is {source.node_id or 'unknown'}. "
                f"README heading is {heading or 'absent'}."
            )
            attribution_value = "confirmed"
        elif source.attribution == "assigned":
            note = (
                f"Repo id {repo_id} is the {source.model} slot and is a different id from the other sealed models. "
                f"GitHub full_name is {full_name}. README heading is {heading or 'absent'}."
            )
            attribution_value = "assigned"
        else:
            note = (
                f"Assigned label {source.model} left unchanged. GitHub full_name is {full_name}. "
                f"README heading is {heading or 'absent'}. "
                f"Conclusion: {assessment['conclusion'] if assessment else 'unreadable'}."
            )
            attribution_value = assessment["conclusion"] if assessment else "unreadable"
        repos[repo_id] = {
            "repo_id": repo_id,
            "node_id": source.node_id,
            "model_label": source.model,
            "model_slot": "tracked" if source.attribution in ("confirmed", "assigned") else previous.get("model_slot"),
            "counts_as_model": True,
            "names": sorted(names),
            "current_full_name": full_name,
            "html_url": ident.get("html_url"),
            "head": manifest["commit"]["sha"],
            "pushed_at": ident.get("pushed_at"),
            "created_at": ident.get("created_at"),
            "updated_at": ident.get("updated_at"),
            "description": ident.get("description") or "",
            "detected_at": detected_at,
            "attribution": attribution_value,
            "readme_heading": heading,
            "sealed_repo_name": sealed_names[0] if sealed_names else source.target,
            "snapshot_id": manifest["snapshot_id"],
            "commits": True,
            "renames": renames,
            "note": note,
            "remote_commit_authors": remote_authors,
            "cross_captured_at": dict(previous.get("cross_captured_at") or {}),
        }
        content_rows.append(
            {
                "repo_id": repo_id,
                "label": source.model,
                "full_name": full_name,
                "head": manifest["commit"]["sha"],
                "snapshot_id": manifest["snapshot_id"],
                "html_url": ident.get("html_url"),
                "pushed_at": ident.get("pushed_at"),
                "created_at": ident.get("created_at"),
                "attribution": source.attribution,
            }
        )

    for row in empty_rows:
        repo_id = row["repo_id"]
        previous = repos.get(repo_id) or {}
        names = set(previous.get("names") or [])
        names.add(row["target"])
        names.add(row["full_name"])
        pending = row.get("attribution") == "pending"
        renames = list(previous.get("renames") or [])
        events.append(
            identity_event(
                timestamp=captured_at,
                event_id=f"evt-discovered-{repo_id}",
                event_type="REPO_DISCOVERED",
                severity="notice",
                outcome="success",
                model=row["model"],
                repo=row["full_name"],
                repo_url=row.get("html_url"),
                commit=None,
                snapshot_id=None,
                message=(
                    f"Discovered repo_id {repo_id} ({row.get('node_id') or 'node id unknown'}) "
                    f"as {row['full_name']} for the {row['model']} slot. It advertises no commits, so it was not sealed."
                ),
                detail={
                    "repo_id": repo_id,
                    "node_id": row.get("node_id"),
                    "full_name": row["full_name"],
                    "created_at": row.get("created_at"),
                    "updated_at": row.get("updated_at"),
                    "pushed_at": row.get("pushed_at"),
                    "commits": False,
                    "aliases": aliases.get(repo_id, []),
                },
            )
        )
        expected = f"lmos_public_{row['model']}"
        bad_aliases = sorted(
            name for name in aliases.get(repo_id, []) if name.split("/", 1)[-1] != expected and name != row["full_name"]
        )
        if bad_aliases:
            current_slug = row["full_name"].split("/", 1)[-1]
            events.append(
                identity_event(
                    timestamp=row.get("updated_at") or captured_at,
                    event_id=f"evt-label-typo-{repo_id}-{short_hash(bad_aliases)}",
                    event_type="LABEL_MISMATCH",
                    severity="warning",
                    outcome="flagged",
                    model=row["model"],
                    repo=row["full_name"],
                    repo_url=row.get("html_url"),
                    commit=None,
                    snapshot_id=None,
                    message=(
                        "Created name "
                        + ", ".join(bad_aliases)
                        + f" does not match {expected}. "
                        + (
                            f"The live name {row['full_name']} matches {expected}. "
                            if current_slug == expected
                            else f"The live name {row['full_name']} does not match {expected}. "
                        )
                        + "Flag for Josh. The tracker did not rename the source."
                    ),
                    detail={
                        "repo_id": repo_id,
                        "node_id": row.get("node_id"),
                        "expected_pattern": expected,
                        "bad_aliases": bad_aliases,
                        "current_full_name": row["full_name"],
                        "current_matches_pattern": current_slug == expected,
                        "flag_for": "Josh",
                        "source_renamed_by_tracker": False,
                    },
                )
            )
            if current_slug == expected:
                events.append(
                    identity_event(
                        timestamp=row.get("updated_at") or captured_at,
                        event_id=f"evt-label-resolved-{repo_id}-{row['model']}",
                        event_type="LABEL_MISMATCH_RESOLVED",
                        severity="notice",
                        outcome="resolved",
                        model=row["model"],
                        repo=row["full_name"],
                        repo_url=row.get("html_url"),
                        commit=None,
                        snapshot_id=None,
                        message=(
                            f"The naming mismatch for repo_id {repo_id} is resolved. "
                            + ", ".join(bad_aliases)
                            + f" now redirects to {row['full_name']}, which matches {expected}. "
                            "The earlier LABEL_MISMATCH for that created name stays in the log. "
                            "The repository is still empty. The tracker did not rename the source."
                        ),
                        detail={
                            "resolves": "LABEL_MISMATCH",
                            "resolved_event_id": f"evt-label-typo-{repo_id}-{short_hash(bad_aliases)}",
                            "repo_id": repo_id,
                            "node_id": row.get("node_id"),
                            "old_names": bad_aliases,
                            "current_full_name": row["full_name"],
                            "expected_pattern": expected,
                            "commits": False,
                            "source_renamed_by_tracker": False,
                        },
                    )
                )
        apply_alias_hops(
            events,
            renames,
            names,
            hops,
            repo_id,
            {
                "full_name": row["full_name"],
                "html_url": row.get("html_url"),
                "node_id": row.get("node_id"),
                "updated_at": row.get("updated_at"),
            },
            Source(row["model"], row["full_name"], False, repo_id, row.get("node_id"), row.get("attribution")),
            None,
            name_status,
            captured_at,
        )
        repos[repo_id] = {
            "repo_id": repo_id,
            "node_id": row.get("node_id"),
            "model_label": row["model"],
            "model_slot": "pending" if pending else None,
            "counts_as_model": False,
            "names": sorted(names),
            "current_full_name": row["full_name"],
            "html_url": row.get("html_url"),
            "head": None,
            "pushed_at": row.get("pushed_at"),
            "created_at": row.get("created_at"),
            "updated_at": row.get("updated_at"),
            "description": "",
            "detected_at": previous.get("detected_at") or captured_at,
            "attribution": "pending" if pending else "no_commits",
            "readme_heading": None,
            "sealed_repo_name": None,
            "snapshot_id": None,
            "commits": False,
            "renames": renames,
            "note": (
                f"Slot {row['model']} is pending. {row['full_name']} (repo_id {repo_id}) advertises no commits and was not scored."
                if pending
                else f"{row['full_name']} (repo_id {repo_id}) advertises no commits. It is not a build and it was not scored."
            ),
            "remote_commit_authors": [],
            "cross_captured_at": previous.get("cross_captured_at") or {},
        }

    for target in probes:
        ident = identities.get(target)
        if not ident:
            continue
        repo_id = str(ident["id"])
        if repo_id in repos:
            names = set(repos[repo_id].get("names") or [])
            names.add(target)
            names.add(ident["full_name"])
            repos[repo_id]["names"] = sorted(names)

    changed = False
    if append_events(root, events, known):
        changed = True
    if new_text != text:
        sources_path.write_text(new_text, encoding="utf-8")
        changed = True

    distinct = len({row["repo_id"] for row in content_rows})
    if distinct == 1 and content_rows:
        row = content_rows[0]
        entry = repos[row["repo_id"]]
        cross_times = entry.setdefault("cross_captured_at", {})
        cross_at = cross_times.get(row["head"]) or captured_at
        cross_times[row["head"]] = cross_at
        over = None
        over_path = root / "deltas" / "over_time" / row["label"] / f"{row['snapshot_id']}.json"
        if over_path.exists():
            summary = json.loads(over_path.read_text(encoding="utf-8"))
            if summary.get("parent_snapshot_id"):
                parent = next(
                    (item for item in model_manifests(root, row["label"]) if item["snapshot_id"] == summary["parent_snapshot_id"]),
                    None,
                )
                over = {
                    "model": row["label"],
                    "snapshot_id": row["snapshot_id"],
                    "commit": summary.get("commit"),
                    "parent_commit": parent["commit"]["sha"] if parent else "",
                    "paths": [item["path"] for item in summary.get("files") or [] if item.get("op") != "unchanged"],
                }
        not_found_rows = sorted(not_found, key=lambda item: item["target"])
        empty_sorted = sorted(empty_rows, key=lambda item: item["repo_id"])
        summary_text = (
            f"One distinct repository has a tree: GitHub id {row['repo_id']} "
            f"({row['full_name']}), sealed under the label {row['label']}. "
            f"HEAD {row['head']} is that seal. "
            "Other names of this id are aliases. Pairwise divergence was not computed."
        )
        if empty_sorted:
            summary_text += " Empty repositories were listed and not scored: " + ", ".join(
                item["full_name"] for item in empty_sorted
            ) + "."
        if row.get("attribution") == "confirmed":
            summary_text += f" Josh confirmed this id is the {row['label']} build."
        payload = {
            "schema": "lmos.cross_model.v1",
            "captured_at": cross_at,
            "mode": "single_repository",
            "summary": summary_text,
            "distinct_content_repos": 1,
            "snapshot_ids": [item["snapshot_id"] for item in all_latest_manifests(root)],
            "pairs": [],
            "pairwise": "not_computed",
            "content_repos": content_rows,
            "empty_repositories": empty_sorted,
            "not_found": not_found_rows,
            "unsealed_with_commits": sorted(unsealed, key=lambda item: item["target"]),
            "names": entry.get("names") or [],
            "over_time": over,
            "divergence_method": "not_computed. Two names of one GitHub repo id are not a pair.",
        }
        stamp = f"single-{row['repo_id']}__{row['head']}"
        base = root / "deltas" / "cross_model"
        if write_if_changed(base / f"{stamp}.json", dump_json(payload)):
            changed = True
        if write_if_changed(base / f"{stamp}.md", render_single_cross(payload)):
            changed = True
        cross_event = identity_event(
            timestamp=cross_at,
            event_id=f"evt-cross-single-{row['repo_id']}-{row['head'][:12]}",
            event_type="CROSS_MODEL_DIVERGENCE",
            severity="notice",
            outcome="not_applicable",
            model="cross",
            repo=row["full_name"],
            repo_url=row.get("html_url"),
            commit=row["head"],
            snapshot_id=stamp,
            message=summary_text,
            detail={
                "mode": "single_repository",
                "repo_id": row["repo_id"],
                "names": entry.get("names"),
                "pairs": [],
                "distinct_content_repos": 1,
                "empty_repositories": [item["full_name"] for item in empty_sorted],
                "not_found": [item["target"] for item in not_found_rows],
            },
        )
        # identity_event puts path None. Point the cross event at the markdown file.
        cross_event["path"] = f"deltas/cross_model/{stamp}.md"
        if append_events(root, [cross_event], known):
            changed = True
        wrote_cross = True

    prompt_versions = parse_prompts(text)
    if prompt_versions:
        registry["prompt_versions"] = prompt_versions
        for item in prompt_versions:
            events.append(
                identity_event(
                    timestamp=captured_at,
                    event_id=f"evt-prompt-{item['model']}-{short_hash([item['version'], item['sha256'], item['file']])}",
                    event_type="PROMPT_VERSION_RECORDED",
                    severity="info",
                    outcome="success",
                    model=item["model"],
                    repo=None,
                    repo_url=None,
                    commit=None,
                    snapshot_id=None,
                    message=(
                        f"{item['model']} is assigned prompt {item['version']} "
                        f"({item['file']}, sha256 {item['sha256']}, status {item['status']})."
                    ),
                    detail=item,
                )
            )
        if append_events(root, events, known):
            changed = True
    if any(source.attribution in ("confirmed", "assigned") for source in keepers):
        slots: dict[str, dict] = {}
        for source in keepers:
            if source.attribution not in ("confirmed", "assigned"):
                continue
            ident = identities.get(source.target)
            if not ident or (source.repo_id and source.repo_id != str(ident["id"])):
                continue
            slots[source.model] = {
                "state": "tracked",
                "count": 1,
                "repo_id": str(ident["id"]),
                "node_id": ident.get("node_id") or source.node_id,
            }
        for source in placeholders:
            if source.attribution == "pending" and source.model not in slots:
                slots[source.model] = {"state": "pending", "count": 0, "repo_id": None, "node_id": None}
        registry["model_slots"] = slots
    registry["schema"] = REGISTRY_SCHEMA
    if write_if_changed(root / "state" / "repo_registry.json", dump_json(registry)):
        changed = True
    return {"changed": changed, "wrote_cross": wrote_cross, "distinct_content": distinct}


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
    lookup = memo_lookup(github_identity)
    lookup_id = memo_lookup(github_identity_by_id)
    statuses = memo_lookup(github_name_status)
    identities: dict[str, dict | None] = {}
    for source in enabled:
        if source.repo_id and is_github_target(source.target):
            ident = lookup_id(source.repo_id)
            if ident and source.node_id and ident.get("node_id") and source.node_id != ident["node_id"]:
                print(
                    f"node_id mismatch for {source.model}: configured {source.node_id}, GitHub {ident.get('node_id')}. Not retargeted.",
                    file=sys.stderr,
                )
            elif ident:
                source.repo_id = str(ident["id"])
                source.node_id = ident.get("node_id") or source.node_id
                source.target = ident["full_name"]
            identities[source.model] = ident
            continue
        ident = lookup(source.target) if is_github_target(source.target) else None
        if ident and (not source.repo_id or source.repo_id == str(ident["id"])):
            source.repo_id = str(ident["id"])
            source.node_id = ident.get("node_id") or source.node_id
            source.target = ident["full_name"]
        identities[source.model] = ident
    keepers, dupes = claim_sources(enabled, identities)
    for model, keeper in dupes.items():
        print(f"skip {model}: same GitHub repo as {keeper}")
    new_seal = False
    for source in keepers:
        ident = identities.get(source.model)
        node_ok = not (
            source.node_id and ident and ident.get("node_id") and source.node_id != ident.get("node_id")
        )
        if ident and node_ok and (not source.repo_id or source.repo_id == str(ident["id"])):
            source.repo_id = str(ident["id"])
            source.node_id = ident.get("node_id") or source.node_id
            source.target = ident["full_name"]
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
        if is_github_target(source.target):
            try:
                remote_commits = github_recent_commits(source.target, limit=100)
            except Exception as exc:
                print(f"batch list skipped for {source.target}: {exc}", file=sys.stderr)
                remote_commits = []
            subjects = [row["subject"] for row in remote_commits if row.get("subject")]
            if tree.subject and (not subjects or subjects[0] != tree.subject):
                subjects.insert(0, tree.subject)
            info = partial_upload(subjects)
            if info:
                tree.completeness = "partial"
                tree.partial_detail = info
        result = capture_model(root, tree, captured_at, known)
        if not result.get("skipped"):
            new_seal = True
    identity = apply_identity_audit(
        root,
        sources_path,
        known,
        captured_at,
        lookup=lookup,
        commits_of=github_recent_commits,
        lookup_by_id=lookup_id,
        name_status=statuses,
    )
    if new_seal or repaired or needs_cross(root) or (all_manifests(root) and not (root / "TRENDS.md").exists()):
        # A single-repository audit already wrote the cross record. Writing the
        # spec-only record as well would describe aliases as missing models.
        if not identity["wrote_cross"]:
            _, placeholders = parse_sources(sources_path.read_text(encoding="utf-8"))
            write_cross(root, captured_at, placeholders, known)
        write_trends(root)
    elif identity["changed"]:
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
