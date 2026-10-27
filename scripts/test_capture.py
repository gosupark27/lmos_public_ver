#!/usr/bin/env python3
"""Regression checks for scripts/capture.py. Uses local git repos, not GitHub."""

from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("capture", ROOT / "capture.py")
assert spec and spec.loader
cap = importlib.util.module_from_spec(spec)
sys.modules["capture"] = cap
spec.loader.exec_module(cap)

SPEC_TEXT = "# Spec\n\nUnique spec sentence for the filter test.\n\nThe word wagon is in the prompt too.\n"
RUBRIC = {
    "schema": "lmos.spec_rubric.v1",
    "concepts": [
        {
            "id": "wagon",
            "section": "Oregon",
            "label": "Wagon word",
            "kind": "terms",
            "any": ["wagon"],
        },
        {
            "id": "spec_only_sentence",
            "section": "Handshake",
            "label": "Sentence that exists only in the spec",
            "kind": "terms",
            "any": ["unique spec sentence for the filter test"],
        },
        {
            "id": "presence_safe",
            "section": "Levers",
            "label": "Presence is not an intent",
            "kind": "absent_if",
            "requires_any": ["presence"],
            "absent": ['kind: "presence"'],
        },
    ],
    "extra_surfaces": [
        {
            "id": "auth",
            "severity": "tension",
            "label": "auth kit",
            "kind": "terms",
            "any": ["better-auth"],
        }
    ],
}


def git(repo: Path, *args: str) -> None:
    env = os.environ.copy()
    env.update(
        {
            "GIT_AUTHOR_NAME": "Test",
            "GIT_AUTHOR_EMAIL": "test@example.com",
            "GIT_COMMITTER_NAME": "Test",
            "GIT_COMMITTER_EMAIL": "test@example.com",
        }
    )
    subprocess.run(["git", "-C", str(repo), *args], check=True, env=env, capture_output=True, text=True)


def init_repo(path: Path) -> None:
    path.mkdir(parents=True)
    subprocess.run(["git", "init", "-b", "main", str(path)], check=True, capture_output=True, text=True)
    git(path, "config", "user.email", "test@example.com")
    git(path, "config", "user.name", "Test")


def commit(path: Path, message: str) -> str:
    git(path, "add", "-A")
    git(path, "commit", "-m", message)
    return subprocess.run(
        ["git", "-C", str(path), "rev-parse", "HEAD"],
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()


def head_bytes(repo: Path) -> dict[str, bytes]:
    listing = subprocess.run(
        ["git", "-C", str(repo), "ls-files"],
        check=True,
        capture_output=True,
        text=True,
    ).stdout.splitlines()
    found = {}
    for rel in listing:
        data = subprocess.run(
            ["git", "-C", str(repo), "show", f"HEAD:{rel}"],
            check=True,
            capture_output=True,
        ).stdout
        found[rel] = data
    return found


def tracker_with(path: Path, sources: str) -> None:
    (path / "config").mkdir(parents=True)
    (path / "reference").mkdir()
    (path / "config" / "sources.txt").write_text(sources, encoding="utf-8")
    (path / "reference" / "lmos_public.md").write_text(SPEC_TEXT, encoding="utf-8")
    (path / "reference" / "concepts.json").write_text(json.dumps(RUBRIC), encoding="utf-8")


def snapshot_dirs(root: Path, model: str) -> list[Path]:
    base = root / "snapshots" / model
    if not base.exists():
        return []
    return sorted(path for path in base.iterdir() if path.is_dir())


def events(root: Path) -> list[dict]:
    path = root / "logs" / "events.jsonl"
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def fail(message: str) -> None:
    raise SystemExit(message)


def test_roundtrip_and_idempotency() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)
        alpha = tmp_path / "alpha"
        init_repo(alpha)
        (alpha / "docs").mkdir()
        (alpha / "docs" / "lmos_public.md").write_bytes(SPEC_TEXT.encode())
        (alpha / "hello.txt").write_text("wagon\n", encoding="utf-8")
        (alpha / "echo.txt").write_text(
            "Unique spec sentence for the filter test.\npresence is a state\n",
            encoding="utf-8",
        )
        (alpha / "presence.ts").write_text("export const presence = 1\n", encoding="utf-8")
        commit(alpha, "baseline")
        root = tmp_path / "tracker"
        tracker_with(root, f"alpha {alpha}\n# grok /tmp/lmos-does-not-exist\n")
        code = cap.main(["--root", str(root)])
        if code != 0:
            fail(f"baseline capture exited {code}")
        snaps = snapshot_dirs(root, "alpha")
        if len(snaps) != 1 or not (snaps[0] / "baseline").is_dir():
            fail("baseline snapshot missing")
        manifest = json.loads((snaps[0] / "manifest.json").read_text(encoding="utf-8"))
        by_id = {item["id"]: item for item in manifest["spec"]["concepts"]}
        if not by_id["wagon"]["covered"]:
            fail("wagon concept should be covered by source, not only the spec copy")
        if by_id["spec_only_sentence"]["covered"]:
            fail("verbatim spec sentence was counted as implementation")
        if not by_id["presence_safe"]["covered"]:
            fail("presence without a presence intent should pass absent_if")
        if manifest["spec"]["extra_surfaces"]:
            fail("auth surface should not match")
        types = [item["event_type"] for item in events(root)]
        if "BASELINE_ESTABLISHED" not in types or "SNAPSHOT_CAPTURED" not in types:
            fail(f"missing baseline events: {types}")
        if "CROSS_MODEL_DIVERGENCE" not in types:
            fail("single-model run should still record that peers are absent")
        log_before = (root / "logs" / "events.jsonl").read_bytes()
        listing_before = sorted(str(path.relative_to(root)) for path in root.rglob("*") if path.is_file())
        if cap.main(["--root", str(root)]) != 0:
            fail("noop capture failed")
        if (root / "logs" / "events.jsonl").read_bytes() != log_before:
            fail("unchanged commit appended events")
        listing_after = sorted(str(path.relative_to(root)) for path in root.rglob("*") if path.is_file())
        if listing_before != listing_after:
            fail("unchanged commit wrote files")

        (alpha / "hello.txt").write_text("wagon\nextra\n", encoding="utf-8")
        commit(alpha, "edit hello")
        if cap.main(["--root", str(root)]) != 0:
            fail("modify capture failed")
        snaps = snapshot_dirs(root, "alpha")
        if len(snaps) != 2:
            fail(f"expected 2 snapshots, found {[path.name for path in snaps]}")
        delta = [path for path in snaps if not (path / "baseline").exists()]
        if len(delta) != 1:
            fail("second snapshot should be a delta without another baseline")
        modified = [item for item in events(root) if item["event_type"] == "FILE_MODIFIED" and item["path"] == "hello.txt"]
        if len(modified) != 1 or modified[0]["line_stats"]["added"] != 1:
            fail(f"expected one +1 modification for hello.txt, got {modified}")
        rebuilt = cap.load_tree_bytes(root, "alpha", delta[0].name)
        if rebuilt != head_bytes(alpha):
            fail(f"rebuild mismatch after edit: {sorted(set(rebuilt) ^ set(head_bytes(alpha)))}")

        (alpha / "hello.txt").unlink()
        (alpha / "bye.txt").write_text("bye\n", encoding="utf-8")
        (alpha / "blob.bin").write_bytes(b"a\0c")
        commit(alpha, "add remove binary")
        if cap.main(["--root", str(root)]) != 0:
            fail("add/remove capture failed")
        snaps = snapshot_dirs(root, "alpha")
        rebuilt = cap.load_tree_bytes(root, "alpha", snaps[-1].name)
        expected = head_bytes(alpha)
        if rebuilt != expected:
            bad = [path for path in sorted(set(rebuilt) | set(expected)) if rebuilt.get(path) != expected.get(path)]
            fail(f"rebuild mismatch after add/remove: {bad}")
        kinds = {(item["event_type"], item["path"]) for item in events(root)}
        if ("FILE_REMOVED", "hello.txt") not in kinds or ("FILE_ADDED", "bye.txt") not in kinds:
            fail("missing add/remove events")
        if ("FILE_ADDED", "blob.bin") not in kinds:
            fail("missing binary add event")

        beta = tmp_path / "beta"
        init_repo(beta)
        (beta / "other.txt").write_text("beta only\n", encoding="utf-8")
        commit(beta, "beta")
        sources = (root / "config" / "sources.txt").read_text(encoding="utf-8")
        (root / "config" / "sources.txt").write_text(sources + f"beta {beta}\n", encoding="utf-8")
        if cap.main(["--root", str(root)]) != 0:
            fail("second model capture failed")
        cross = sorted((root / "deltas" / "cross_model").glob("*.json"))[-1]
        payload = json.loads(cross.read_text(encoding="utf-8"))
        if payload["mode"] != "cross_model" or not payload["pairs"]:
            fail("expected a pairwise cross-model record")
        if payload["pairs"][0]["score"] <= 0:
            fail("different trees should diverge")
        trends = (root / "trends" / "snapshots.csv").read_text(encoding="utf-8")
        if "beta" not in trends or trends.count("\n") < 3:
            fail("trends csv missing rows")
        beta_rows = [line for line in trends.splitlines() if line.startswith("20") and ",beta," in line]
        if not beta_rows or beta_rows[-1].split(",")[10] == "":
            fail(f"beta row should have a divergence score: {beta_rows}")
        print("roundtrip ok")


def test_enable_refuses_missing_and_accepts_local() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)
        missing = tmp_path / "missing"
        root = tmp_path / "tracker"
        tracker_with(root, f"# grok {missing}\n")
        code = cap.main(["--root", str(root), "--enable", "grok"])
        if code != 1:
            fail(f"missing enable should exit 1, got {code}")
        if not (root / "config" / "sources.txt").read_text(encoding="utf-8").lstrip().startswith("#"):
            fail("failed enable rewrote the placeholder into an active source")
        repo = tmp_path / "local"
        init_repo(repo)
        (repo / "hello.txt").write_text("wagon\n", encoding="utf-8")
        (repo / "presence.ts").write_text("presence\n", encoding="utf-8")
        commit(repo, "init")
        (root / "config" / "sources.txt").write_text(f"# alpha {repo}\n", encoding="utf-8")
        if cap.main(["--root", str(root), "--enable", "alpha"]) != 0:
            fail("enable of a local repo failed")
        text = (root / "config" / "sources.txt").read_text(encoding="utf-8")
        if text.startswith("#") or "alpha " not in text:
            fail(f"enable did not uncomment alpha: {text}")
        if not snapshot_dirs(root, "alpha"):
            fail("enable did not capture")
        print("enable ok")


def test_unavailable_is_logged_once() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp) / "tracker"
        missing = Path(tmp) / "nope"
        tracker_with(root, f"ghost {missing}\n")
        if cap.main(["--root", str(root)]) != 1:
            fail("missing enabled source should exit 1")
        first = events(root)
        if [item["event_type"] for item in first] != ["SOURCE_UNAVAILABLE"]:
            fail(f"expected one unavailable event, got {first}")
        if cap.main(["--root", str(root)]) != 1:
            fail("second missing capture should still exit 1")
        if events(root) != first:
            fail("repeated unavailable source appended another event")
        print("unavailable ok")


def test_identity_rename_does_not_relabel() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp) / "tracker"
        sha = "a" * 40
        snap_id = f"2026-10-27T00-00-00.000Z__{sha}"
        snap = root / "snapshots" / "alpha" / snap_id
        (snap / "baseline" / "public" / "__grok").mkdir(parents=True)
        (snap / "baseline" / "README.md").write_text("# acme-grok\n", encoding="utf-8")
        (snap / "baseline" / "package.json").write_text('{"name": "app-builder-workspace"}\n', encoding="utf-8")
        (snap / "baseline" / "public" / "__grok" / "app.txt").write_text("scaffold\n", encoding="utf-8")
        manifest = {
            "model": "alpha",
            "repo": "acme/old-name",
            "repo_url": "https://github.com/acme/old-name",
            "snapshot_id": snap_id,
            "captured_at": "2026-10-27T00:00:00.000Z",
            "baseline": True,
            "branch": "main",
            "commit": {
                "sha": sha,
                "author": "JJ Park",
                "subject": "Rename project from acme-old to acme-grok",
                "committed_at": "2026-10-27T00:00:00Z",
                "url": f"https://github.com/acme/old-name/commit/{sha}",
            },
        }
        (snap / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
        (snap / ".complete").write_text("done\n", encoding="utf-8")
        manifest_bytes = (snap / "manifest.json").read_bytes()
        sources = root / "config" / "sources.txt"
        sources.parent.mkdir(parents=True)
        sources.write_text(
            "alpha acme/old-name\nbeta acme/old-name\n# chatgpt acme/missing\n# grok acme/empty-grok\n",
            encoding="utf-8",
        )
        identity = {
            "id": "10",
            "full_name": "acme/new-name",
            "html_url": "https://github.com/acme/new-name",
            "pushed_at": "2026-10-27T00:00:00Z",
            "created_at": "2026-10-27T00:00:00Z",
            "description": "test",
        }
        empty = {
            "id": "11",
            "full_name": "acme/empty-grok",
            "html_url": "https://github.com/acme/empty-grok",
            "pushed_at": "2026-10-27T00:00:00Z",
            "created_at": "2026-10-27T00:00:00Z",
            "description": "",
        }

        def lookup(target: str):
            if target in ("acme/old-name", "acme/new-name"):
                return identity
            if target == "acme/empty-grok":
                return empty
            if target == "acme/missing":
                return None
            raise AssertionError(target)

        def head_of(target: str):
            if target == "acme/old-name":
                return sha
            return None

        when = "2026-10-27T01:00:00.000Z"
        status = cap.apply_identity_audit(root, sources, set(), when, lookup=lookup, head_of=head_of)
        if not status["changed"] or not status["wrote_cross"] or status["distinct_content"] != 1:
            fail(f"identity audit did not record one repository: {status}")
        kinds = {item["event_type"] for item in events(root)}
        for required in ("REPO_RENAMED", "LABEL_MISMATCH", "MODEL_ATTRIBUTION_UNCERTAIN"):
            if required not in kinds:
                fail(f"missing {required}: {sorted(kinds)}")
        renamed = next(item for item in events(root) if item["event_type"] == "REPO_RENAMED")
        if renamed["detail"]["old_name"] != "acme/old-name" or renamed["detail"]["new_name"] != "acme/new-name":
            fail(f"rename detail wrong: {renamed['detail']}")
        if renamed["detail"]["repo_id"] != "10" or renamed["model"] != "alpha":
            fail("rename event moved the label or lost the repo id")
        uncertain = next(item for item in events(root) if item["event_type"] == "MODEL_ATTRIBUTION_UNCERTAIN")
        if uncertain["outcome"] != "uncertain" or uncertain["model"] != "alpha":
            fail("attribution event relabeled the snapshot")
        text = sources.read_text(encoding="utf-8")
        enabled, placeholders = cap.parse_sources(text)
        if [item.model for item in enabled] != ["alpha"] or enabled[0].repo_id != "10":
            fail(f"source line was not keyed by repo id: {text}")
        if enabled[0].target != "acme/new-name":
            fail(f"source was not updated to the current name: {text}")
        if any(item.model == "beta" for item in enabled + placeholders):
            fail(f"duplicate model is still a source line: {text}")
        if "repo_id=10 is already tracked as alpha" not in text:
            fail(f"duplicate line was not neutralized: {text}")
        cross = json.loads(next((root / "deltas" / "cross_model").glob("single-10__*.json")).read_text(encoding="utf-8"))
        if cross["mode"] != "single_repository" or cross["pairs"] != []:
            fail(f"cross record invented a pair: {cross['mode']} {cross['pairs']}")
        if cross["distinct_content_repos"] != 1:
            fail("cross record counted more than one tree")
        if (snap / "manifest.json").read_bytes() != manifest_bytes:
            fail("identity audit rewrote the sealed manifest")
        if json.loads((snap / "manifest.json").read_text(encoding="utf-8"))["model"] != "alpha":
            fail("sealed model label changed")
        before = events(root)
        source_bytes = sources.read_bytes()
        again = cap.apply_identity_audit(root, sources, cap.load_event_ids(root), "2026-10-27T02:00:00.000Z", lookup=lookup, head_of=head_of)
        if again["changed"]:
            fail("second identity audit wrote again")
        if events(root) != before or sources.read_bytes() != source_bytes:
            fail("second identity audit was not idempotent")
        print("identity ok")


def test_source_fields_and_alias_lines() -> None:
    text = (
        "claude acme/widget repo_id=1435079605 node_id=R_kgDOVYmTtQ attribution=confirmed\n"
        "# grok acme/other repo_id=9 node_id=R_x attribution=pending\n"
        "# ALIASES 1435079605 acme/a acme/b\n"
        "# ALIAS_HOP 1435079605 acme/a acme/b observed_at=2026-10-27T01:59:48Z\n"
    )
    enabled, placeholders = cap.parse_sources(text)
    if enabled[0].node_id != "R_kgDOVYmTtQ" or enabled[0].attribution != "confirmed" or enabled[0].repo_id != "1435079605":
        fail(f"confirmed source fields dropped: {enabled[0]}")
    if placeholders[0].attribution != "pending" or placeholders[0].node_id != "R_x":
        fail(f"pending source fields dropped: {placeholders[0]}")
    line = cap.format_source("claude", "acme/widget", "1435079605", "R_kgDOVYmTtQ", "confirmed")
    if line != "claude acme/widget repo_id=1435079605 node_id=R_kgDOVYmTtQ attribution=confirmed":
        fail(line)
    if cap.parse_sources("# ALIASES 1435079605 acme/a acme/b\n") != ([], []):
        fail("alias line parsed as a source")
    prompts = cap.parse_prompts(
        "# PROMPT claude PV-0.9.0-full sha256=abc file=reference/lmos_public.md status=pinned\n"
        "# PROMPT chatgpt PV-0.10-lite sha256=pending file=pending status=text-pending\n"
    )
    if [item["version"] for item in prompts] != ["PV-0.9.0-full", "PV-0.10-lite"]:
        fail(f"prompt lines did not parse: {prompts}")
    if cap.parse_sources("# PROMPT claude PV-0.9.0-full sha256=abc file=reference/lmos_public.md status=pinned\n") != ([], []):
        fail("prompt line parsed as a source")
    hops = cap.parse_hops(text)
    if hops != [{"repo_id": "1435079605", "old": "acme/a", "new": "acme/b", "observed_at": "2026-10-27T01:59:48Z"}]:
        fail(f"hop parse failed: {hops}")
    print("source fields ok")


def test_confirmed_attribution_does_not_reopen_uncertainty() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp) / "tracker"
        sha = "b" * 40
        snap_id = f"2026-10-27T00-00-00.000Z__{sha}"
        snap = root / "snapshots" / "alpha" / snap_id
        (snap / "baseline" / "README.md").parent.mkdir(parents=True)
        (snap / "baseline" / "README.md").write_text("# acme-alpha\n", encoding="utf-8")
        (snap / "baseline" / "public" / "__grok").mkdir(parents=True)
        (snap / "baseline" / "public" / "__grok" / "app.txt").write_text("scaffold\n", encoding="utf-8")
        manifest = {
            "model": "alpha",
            "repo": "acme/old-name",
            "repo_id": "10",
            "repo_url": "https://github.com/acme/old-name",
            "snapshot_id": snap_id,
            "captured_at": "2026-10-27T00:00:00.000Z",
            "baseline": True,
            "branch": "main",
            "commit": {
                "sha": sha,
                "author": "JJ Park",
                "subject": "initial",
                "committed_at": "2026-10-27T00:00:00Z",
                "url": f"https://github.com/acme/old-name/commit/{sha}",
            },
        }
        (snap / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
        (snap / ".complete").write_text("done\n", encoding="utf-8")
        manifest_bytes = (snap / "manifest.json").read_bytes()
        sources = root / "config" / "sources.txt"
        sources.parent.mkdir(parents=True)
        sources.write_text(
            "alpha acme/old-name repo_id=10 node_id=N1 attribution=confirmed\n"
            "# ALIASES 10 acme/old-name acme/mid-name acme/new_name\n"
            "# ALIAS_HOP 10 acme/old-name acme/mid_name observed_at=2026-10-27T01:59:48Z\n"
            "# grok acme/other repo_id=11 attribution=pending\n",
            encoding="utf-8",
        )
        identity = {
            "id": "10",
            "node_id": "N1",
            "full_name": "acme/new_name",
            "html_url": "https://github.com/acme/new_name",
            "pushed_at": "2026-10-27T00:00:00Z",
            "created_at": "2026-10-27T00:00:00Z",
            "updated_at": "2026-10-27T02:00:16Z",
            "description": "test",
        }

        def lookup(target: str):
            if target in ("acme/old-name", "acme/new_name"):
                return identity
            return None

        def lookup_by_id(repo_id: str):
            if repo_id == "10":
                return identity
            return None

        def name_status(full_name: str):
            if full_name == "acme/new_name":
                return {"status": 200, "location": None, "identity": identity}
            if full_name in ("acme/old-name", "acme/mid_name"):
                return {"status": 301, "location": "https://api.github.com/repositories/10", "identity": None}
            return {"status": 404, "location": None, "identity": None}

        when = "2026-10-27T03:00:00.000Z"
        status = cap.apply_identity_audit(
            root,
            sources,
            set(),
            when,
            lookup=lookup,
            head_of=lambda target: None,
            lookup_by_id=lookup_by_id,
            name_status=name_status,
        )
        if not status["changed"]:
            fail("confirmed audit wrote nothing")
        kinds = [item["event_type"] for item in events(root)]
        if "MODEL_ATTRIBUTION_UNCERTAIN" in kinds:
            fail(f"confirmation reopened uncertainty: {kinds}")
        corrected = [item for item in events(root) if item["event_type"] == "MODEL_ATTRIBUTION_CORRECTED"]
        if len(corrected) != 1 or corrected[0]["model"] != "alpha" or corrected[0]["detail"]["repo_id"] != "10":
            fail(f"missing correction: {corrected}")
        hop = next(
            item
            for item in events(root)
            if item["event_type"] == "REPO_RENAMED" and item["detail"]["old_name"] == "acme/old-name" and item["detail"]["new_name"] == "acme/mid_name"
        )
        if hop["timestamp"] != "2026-10-27T01:59:48Z":
            fail(f"hop timestamp was not the observed time: {hop['timestamp']}")
        text = sources.read_text(encoding="utf-8")
        if "node_id=N1" not in text or "attribution=confirmed" not in text:
            fail(f"confirmed source line lost node_id or attribution: {text}")
        if "attribution=pending" not in text:
            fail(f"pending line was enabled: {text}")
        registry = json.loads((root / "state" / "repo_registry.json").read_text(encoding="utf-8"))
        if registry["repos"]["10"]["attribution"] != "confirmed" or registry["repos"]["10"]["counts_as_model"] is not True:
            fail(f"registry did not confirm the repo: {registry['repos']['10']}")
        if registry["model_slots"]["alpha"]["count"] != 1 or registry["model_slots"]["grok"]["count"] != 0:
            fail(f"slots wrong: {registry['model_slots']}")
        if (snap / "manifest.json").read_bytes() != manifest_bytes:
            fail("confirmed audit rewrote the sealed manifest")
        before = events(root)
        source_bytes = sources.read_bytes()
        registry_bytes = (root / "state" / "repo_registry.json").read_bytes()
        again = cap.apply_identity_audit(
            root,
            sources,
            cap.load_event_ids(root),
            "2026-10-27T04:00:00.000Z",
            lookup=lookup,
            head_of=lambda target: None,
            lookup_by_id=lookup_by_id,
            name_status=name_status,
        )
        if again["changed"] or events(root) != before or sources.read_bytes() != source_bytes:
            fail("second confirmed audit was not idempotent")
        if (root / "state" / "repo_registry.json").read_bytes() != registry_bytes:
            fail("second confirmed audit rewrote the registry")
        print("confirmed attribution ok")


def test_dashdash_hunk_lines_roundtrip() -> None:
    old = {
        "migrations/auth/0001_auth.sql": (
            "-- Better Auth schema (camelCase)\n"
            "--\n"
            "-- Generated. Do not edit.\n"
            "create table \"user\" ();\n"
        ).encode(),
        "keep.txt": b"same\n",
    }
    new = {
        "migrations/auth/0001_auth.sql": b"CREATE TABLE auth_user ();\nCREATE TABLE auth_session ();\n",
        "keep.txt": b"same\n",
    }
    patch = cap.text_patch(old, new)
    if "\n\n---\n" in patch or "\n\n--- Generated" in patch:
        fail("normalize_diff inserted a blank line into a -- comment hunk")
    if "--- Better Auth schema" not in patch:
        fail(f"removed -- comment missing from patch:\n{patch}")
    rebuilt = cap.rebuild_bytes(old, patch, [], {})
    if rebuilt != new:
        fail(f"dashdash hunk did not round-trip: {rebuilt}")
    chunk = cap.split_patch(patch)["migrations/auth/0001_auth.sql"]
    stats = cap.line_stats_from_chunk(chunk, False)
    if stats["removed"] != 4 or stats["added"] != 2:
        fail(f"line stats dropped -- comment lines: {stats}")
    print("dashdash hunk ok")


def test_partial_batch_sequence() -> None:
    info = cap.partial_upload(
        [
            "Add original source (batch-14.json)",
            "Add original source (batch-08.json)",
            "Add original source (batch-08.json)",
            "Initial commit",
        ]
    )
    if not info or info["status"] != "partial" or info["repeated_batches"] != [8]:
        fail(f"open batch sequence was not partial: {info}")
    if 9 not in info["missing_batches"] or info["latest_batch"] != 14:
        fail(f"batch span wrong: {info}")
    if cap.partial_upload(["Implement the game", "Add original source (batch-01.json)"]):
        fail("a non-batch HEAD with a contiguous history should not be partial")
    restored = cap.partial_upload(
        [
            "Restore original migrations/0002_rooms.sql",
            "Add original source (batch-00.json)",
            "Add original source (batch-00.json)",
            "Add original source (batch-01.json)",
        ]
    )
    if not restored or restored.get("head_is_batch"):
        fail(f"a restore commit should not count as a batch HEAD: {restored}")
    if "HEAD is still" in restored["reason"] or "batch numbers repeat" not in restored["reason"]:
        fail(f"restore reason should name the repeat without calling HEAD a batch: {restored['reason']}")
    print("partial ok")


if __name__ == "__main__":
    test_roundtrip_and_idempotency()
    test_enable_refuses_missing_and_accepts_local()
    test_unavailable_is_logged_once()
    test_identity_rename_does_not_relabel()
    test_source_fields_and_alias_lines()
    test_confirmed_attribution_does_not_reopen_uncertainty()
    test_dashdash_hunk_lines_roundtrip()
    test_partial_batch_sequence()
    print("all capture tests passed")
