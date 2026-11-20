#!/usr/bin/env python3
"""Inventory every agent skill copy on us-metal02 and the Mac, with usage counts and health flags.

Writes ~/work/skills-health/inventory.json, the data behind the sw factory Skills view.
Verdicts, upstream origins and groups come from config/skills-health.json next to this script.

    python3 scripts/skills-inventory.py [--out PATH] [--no-mac] [--no-usage]

The same file runs on each box: `--scan-box <box>` prints that box's raw scan as JSON,
and the coordinator pipes this file to `ssh mac python3 - --scan-box mac`.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import re
import sqlite3
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path

HOME = Path.home()
SKIP_DIRS = {"node_modules", ".venv", "dist", ".git", "__pycache__", ".trash"}
REPO_PARENTS = ("src", "Documents/Github", "Documents")
REPO_SKILL_DIRS = (".agents/skills", ".claude/skills", ".codex/skills", ".cursor/skills", ".pi/skills")
REPO_RULE_DIRS = (".claude/rules", ".cursor/rules")
USER_SKILL_DIRS = (
    (".claude/skills", "claude", "~/.claude/skills"),
    (".codex/skills", "codex", "~/.codex/skills"),
    (".agents/skills", "claude", "~/.agents/skills (skills CLI)"),
)
REF_RE = re.compile(r"(?<![\w./-])((?:scripts|references|playbooks)/[\w.-]+(?:/[\w.-]+)*\.\w+)")


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def frontmatter(text: str) -> dict:
    if not text.startswith("---"):
        return {}
    end = text.find("\n---", 3)
    if end < 0:
        return {}
    out: dict = {}
    key = None
    for line in text[3:end].splitlines():
        m = re.match(r"^([A-Za-z_-]+):\s*(.*)$", line)
        if m:
            key, value = m.group(1), m.group(2).strip()
            out[key] = value.strip("'\"")
        elif key and line.startswith((" ", "\t")) and key == "description":
            out[key] = (out[key] + " " + line.strip()).strip()
    return out


def dir_size(path: Path) -> tuple[int, int]:
    total = files = 0
    for root, dirs, names in os.walk(path):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
        for name in names:
            try:
                total += (Path(root) / name).stat().st_size
                files += 1
            except OSError:
                pass
    return total, files


_toplevels: dict[str, str | None] = {}


def git_last_change(path: Path) -> dict | None:
    parent = str(path if path.is_dir() else path.parent)
    if parent not in _toplevels:
        r = subprocess.run(["git", "-C", parent, "rev-parse", "--show-toplevel"], capture_output=True, text=True)
        _toplevels[parent] = r.stdout.strip() if r.returncode == 0 else None
    top = _toplevels[parent]
    if not top:
        return None
    r = subprocess.run(
        ["git", "-C", top, "log", "-1", "--format=%H%x09%cI%x09%an%x09%s", "--", str(path)],
        capture_output=True, text=True,
    )
    if r.returncode != 0 or not r.stdout.strip():
        return {"repo": top, "sha": None, "at": None, "author": None, "subject": "untracked"}
    sha, at, author, subject = r.stdout.strip().split("\t", 3)
    return {"repo": top, "sha": sha, "at": at, "author": author, "subject": subject}


def find_skill_dirs(root: Path, depth: int = 3) -> list[Path]:
    found = []
    if not root.is_dir():
        return found
    base = len(root.parts)
    for current, dirs, names in os.walk(root, followlinks=False):
        here = Path(current)
        dirs[:] = sorted(d for d in dirs if d not in SKIP_DIRS)
        for d in list(dirs):
            if (here / d).is_symlink():
                found.append(here / d)
                dirs.remove(d)
        if "SKILL.md" in names and here != root:
            found.append(here)
            dirs[:] = []
        if len(here.parts) - base >= depth:
            dirs[:] = []
    return found


def prime_release_skills() -> Path | None:
    binary = HOME / ".local/share/prime-agent/bin/prime-agent"
    if not binary.exists():
        return None
    skills = binary.resolve().parent / "skills"
    return skills if skills.is_dir() else None


def scan_entry(path: Path, box: str, how: str, runtimes: list[str], source: str) -> dict:
    is_link = path.is_symlink()
    target = os.readlink(path) if is_link else None
    real = path.resolve()
    skill_md = real / "SKILL.md" if real.is_dir() else real
    row = {
        "box": box,
        "path": str(path),
        "realPath": str(real),
        "linkTarget": target,
        "how": how,
        "runtimes": runtimes,
        "source": source,
        "exists": skill_md.is_file(),
    }
    if not row["exists"]:
        row["name"] = path.name.removesuffix(".md")
        return row
    text = skill_md.read_text(errors="replace")
    fm = frontmatter(text)
    size, files = dir_size(real) if real.is_dir() else (skill_md.stat().st_size, 1)
    last = git_last_change(skill_md)
    roots = [real] + ([Path(last["repo"])] if last else [])
    dead = sorted({ref for ref in REF_RE.findall(text) if real.is_dir() and not any((r / ref).exists() for r in roots)})
    row.update({
        "name": fm.get("name") or (path.name if real.is_dir() else path.stem),
        "dirName": path.name,
        "description": fm.get("description", ""),
        "pythonImport": fm.get("python_import") or (fm.get("metadata") and None),
        "skillMd": str(skill_md),
        "hash": sha256(skill_md),
        "sizeBytes": size,
        "files": files,
        "lines": text.count("\n") + 1,
        "mtime": datetime.fromtimestamp(skill_md.stat().st_mtime, timezone.utc).isoformat(),
        "lastChange": last,
        "deadRefs": dead,
        "text": text if box != "us-metal02" else None,
    })
    return row


def discover(box: str) -> list[dict]:
    rows: list[dict] = []
    jobs: list[tuple] = []
    links = HOME / ".prime/agent/skills"
    if links.is_dir():
        for p in sorted(links.iterdir()):
            jobs.append((p, box, "prime-sync link ~/.prime/agent/skills", ["prime", "pi-host"], "prime-links"))
    release = prime_release_skills()
    if release:
        for p in sorted(release.iterdir()):
            if (p / "SKILL.md").exists():
                jobs.append((p, box, "prime-agent release bundle", ["prime", "pi-host"], "prime-release"))
    checkout = HOME / "src/sieun-pi"
    if box == "us-metal02" and checkout.is_dir():
        for sub in ("skills", "legacy/prime/skills"):
            for p in sorted((checkout / sub).iterdir()):
                if (p / "SKILL.md").exists():
                    jobs.append((p, box, "sieun-pi source", [], "sieun-pi"))
        for p in sorted((checkout / "config/claude-rules").glob("*.md")):
            jobs.append((p, box, "pi-claude-rules extension", ["prime", "pi-host"], "sieun-pi-rules"))
        for p in sorted((checkout / "packages").glob("*/skills/*")):
            if (p / "SKILL.md").exists():
                jobs.append((p, box, f"sieun-pi package {p.parent.parent.name}", ["pi-host"], "sieun-pi-package"))
    plugins = HOME / ".claude/plugins/cache"
    if plugins.is_dir():
        for p in sorted(plugins.glob("*/*/*/skills/*")):
            if (p / "SKILL.md").exists():
                jobs.append((p, box, f"Claude Code plugin {p.parent.parent.parent.name}", ["claude"], "claude-plugin"))
    codex_plugins = HOME / ".codex/plugins/cache"
    if codex_plugins.is_dir():
        for p in sorted(codex_plugins.glob("*/*/*/skills/*")):
            if (p / "SKILL.md").exists():
                jobs.append((p, box, f"Codex plugin {p.parent.parent.parent.name}", ["codex"], "codex-plugin"))
    for rel, runtime, how in USER_SKILL_DIRS:
        for p in find_skill_dirs(HOME / rel):
            jobs.append((p, box, how, [runtime], "user-dir"))
    for rules in (HOME / ".claude/rules",):
        for p in sorted(rules.glob("*.md")) if rules.is_dir() else []:
            jobs.append((p, box, "~/.claude/rules", ["claude"], "user-rules"))
    state = HOME / ".prime/agent/harness/harness_state.json"
    if box == "us-metal02" and state.is_file():
        entries = json.loads(state.read_text()).get("entries", {})
        for kind, group in entries.items():
            for entry_id, entry in (group or {}).items():
                text = entry.get("content") or json.dumps(entry.get("reference") or {})
                rows.append({
                    "box": box, "path": f"harness:{kind}:{entry_id}", "realPath": f"harness:{kind}:{entry_id}", "linkTarget": None,
                    "how": "Prime continual harness (global)", "runtimes": ["prime", "pi-host"], "source": f"harness-{kind}", "exists": True,
                    "name": entry_id, "dirName": entry_id, "description": entry.get("title", ""), "pythonImport": None,
                    "skillMd": f"harness:{kind}:{entry_id}", "hash": hashlib.sha256(text.encode()).hexdigest(), "sizeBytes": len(text.encode()),
                    "files": 1, "lines": text.count("\n") + 1, "mtime": entry.get("updated_at"),
                    "lastChange": {"repo": "sieu-n/prime-shared-state", "sha": None, "at": entry.get("updated_at"), "author": entry.get("source"), "subject": f"{kind} v{entry.get('version')}"},
                    "deadRefs": [], "text": None, "harnessKind": kind,
                })
    seen_repos = set()
    for parent in REPO_PARENTS:
        base = HOME / parent
        if not base.is_dir():
            continue
        for repo in sorted(base.iterdir()):
            if not repo.is_dir() or repo.is_symlink() or repo.resolve() in seen_repos:
                continue
            seen_repos.add(repo.resolve())
            for rel in REPO_SKILL_DIRS:
                for p in find_skill_dirs(repo / rel):
                    jobs.append((p, box, f"repo {rel} ({repo.name})", ["claude", "codex"], f"repo:{repo.name}"))
            for rel in REPO_RULE_DIRS:
                rdir = repo / rel
                if rdir.is_dir():
                    for p in sorted(rdir.glob("*.md*")):
                        jobs.append((p, box, f"repo {rel} ({repo.name})", ["claude"], f"repo-rules:{repo.name}"))
    with ThreadPoolExecutor(8) as pool:
        rows.extend(pool.map(lambda job: scan_entry(*job), jobs))
    return rows


def count_usage(now: datetime, box: str) -> dict:
    if "skills_usage" not in sys.modules:
        sys.path.insert(0, str(Path(__file__).resolve().parent))
    import skills_usage
    return skills_usage.count_usage(now, box)


def scan_box(box: str, usage: bool) -> dict:
    started = time.time()
    now = datetime.now(timezone.utc)
    out = {"box": box, "scannedAt": now.isoformat(), "ok": True, "error": None}
    out["rows"] = discover(box)
    trash = HOME / ".claude/skills/.trash"
    wt = subprocess.run(["git", "-C", str(HOME / "src/sieun-pi"), "worktree", "list", "--porcelain"], capture_output=True, text=True)
    out["extras"] = {
        "claudeSkillTrashFolders": len(list(trash.iterdir())) if trash.is_dir() else 0,
        "sieunPiWorktrees": max(0, wt.stdout.count("\nworktree ") + wt.stdout.startswith("worktree ") - 1) if wt.returncode == 0 else None,
    }
    out["usage"] = count_usage(now, box) if usage else None
    out["seconds"] = round(time.time() - started, 1)
    return out


def scan_remote(box: str, host: str, usage: bool, timeout: int) -> dict:
    args = ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", host, "python3", "-", "--scan-box", box]
    if not usage:
        args.append("--no-usage")
    here = Path(__file__).resolve().parent
    blobs = {name: base64.b64encode((here / name).read_bytes()).decode() for name in ("skills_usage.py", "skills-inventory.py")}
    source = (
        "import base64, sys, types\n"
        "m = types.ModuleType('skills_usage')\n"
        f"exec(compile(base64.b64decode('{blobs['skills_usage.py']}'), 'skills_usage.py', 'exec'), m.__dict__)\n"
        "sys.modules['skills_usage'] = m\n"
        f"exec(compile(base64.b64decode('{blobs['skills-inventory.py']}'), 'skills-inventory.py', 'exec'), {{'__name__': '__main__'}})\n"
    ).encode()
    last = None
    for _ in range(2):
        try:
            r = subprocess.run(args, input=source, capture_output=True, timeout=timeout)
            if r.returncode == 0:
                return json.loads(r.stdout)
            last = f"ssh exit {r.returncode}: {r.stderr.decode(errors='replace').strip()[-300:]}"
        except subprocess.TimeoutExpired:
            last = f"ssh timed out after {timeout} s"
    return {"box": box, "scannedAt": datetime.now(timezone.utc).isoformat(), "ok": False, "error": last, "rows": [], "usage": None}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(HOME / "work/skills-health/inventory.json"))
    ap.add_argument("--scan-box")
    ap.add_argument("--no-mac", action="store_true")
    ap.add_argument("--no-usage", action="store_true")
    ap.add_argument("--mac-host", default="mac")
    ap.add_argument("--mac-timeout", type=int, default=300)
    args = ap.parse_args()
    if args.scan_box:
        json.dump(scan_box(args.scan_box, not args.no_usage), sys.stdout)
        return
    scans = [scan_box("us-metal02", not args.no_usage)]
    if not args.no_mac:
        scans.append(scan_remote("mac", args.mac_host, not args.no_usage, args.mac_timeout))
    config_path = Path(__file__).resolve().parent.parent / "config/skills-health.json"
    config = json.loads(config_path.read_text()) if config_path.exists() else {}
    inventory = build(scans, config)
    out = Path(args.out).expanduser()
    out.parent.mkdir(parents=True, exist_ok=True)
    tmp = out.with_suffix(".tmp")
    tmp.write_text(json.dumps(inventory, indent=1))
    tmp.replace(out)
    print(f"{len(inventory['skills'])} copies of {inventory['counts']['skills']} skills -> {out}")

def family(row: dict) -> str:
    src = row["source"]
    if "claude-rules" in row["realPath"]:
        return "sieun-pi-rules"
    if src in ("sieun-pi", "prime-links") or "/sieun-pi-runtime/" in row["realPath"] or "/src/sieun-pi/" in row["realPath"]:
        return "sieun-pi"
    if src.startswith("repo"):
        return src
    if src == "user-dir":
        parts = Path(row["path"]).parts
        return "user:" + "/".join(parts[3:5]) if len(parts) > 4 else "user"
    return src


def match_verdict(row: dict, verdicts: list[dict]) -> dict | None:
    best = None
    for v in verdicts:
        if v.get("name") not in (None, row["name"]):
            continue
        if v.get("pathContains") and v["pathContains"] not in row["path"] and v["pathContains"] not in row["realPath"]:
            continue
        if v.get("box") and v["box"] != row["box"]:
            continue
        score = (v.get("name") is not None) + bool(v.get("pathContains")) * 2 + bool(v.get("box"))
        if best is None or score > best[0]:
            best = (score, v)
    return best[1] if best else None


def merge_usage(scans: list[dict]) -> dict:
    merged: dict[str, dict] = {}
    for scan in scans:
        usage = scan.get("usage") or {}
        for name, u in (usage.get("skills") or {}).items():
            m = merged.setdefault(name, {"uses7d": 0, "uses30d": 0, "sessions7d": 0, "sessions30d": 0, "agents": set(), "uses": []})
            for k in ("uses7d", "uses30d", "sessions7d", "sessions30d"):
                m[k] += u.get(k, 0)
            m["agents"].update(a for a in u.get("agents", []) if a)
            m["uses"].extend(u.get("uses", []))
    for m in merged.values():
        m["agents"] = sorted(m["agents"])
        m["uses"] = sorted(m["uses"], key=lambda u: u.get("at") or "", reverse=True)[:10]
    return merged


def build(scans: list[dict], config: dict) -> dict:
    copies: dict[tuple[str, str], dict] = {}
    harness_rules = {h["id"]: h for h in config.get("harnessRules", [])}
    for scan in scans:
        for row in scan["rows"]:
            if row["source"].startswith("repo-rules:") and not (match_verdict(row, config.get("verdicts", [])) or {}).get("pathContains"):
                continue
            if row.get("harnessKind"):
                rule = harness_rules.get(row["name"])
                if row["harnessKind"] in ("skill", "subagent"):
                    row["kindOverride"] = "harness"
                elif rule:
                    row = dict(row, name=rule["skill"], entryId=row["name"], kindOverride="rule")
                else:
                    continue
            key = (row["box"], row["realPath"])
            cur = copies.get(key)
            if cur is None:
                cur = copies[key] = dict(row, links=[], how=[], runtimes=[])
            if row["linkTarget"] or row["path"] != row["realPath"]:
                cur["links"].append(row["path"])
            if row["how"] not in cur["how"]:
                cur["how"].append(row["how"])
            cur["runtimes"] = sorted(set(cur["runtimes"]) | set(row["runtimes"]))
            if row["source"] != "sieun-pi" and cur["source"] == "sieun-pi":
                cur["source"] = row["source"] if row["source"] != "prime-links" else "sieun-pi"
    rows = list(copies.values())
    for row in rows:
        row["family"] = family(row)
        row["id"] = f'{row["box"]}:{row["realPath"]}'
    usage = merge_usage(scans)
    upstreams = config.get("upstreams", {})
    groups = config.get("groups", {})
    verdicts = config.get("verdicts", [])
    by_name: dict[str, list[dict]] = {}
    by_hash: dict[str, list[dict]] = {}
    for row in rows:
        if row.get("entryId"):
            by_name.setdefault(row["name"], [])
            continue
        by_name.setdefault(row["name"], []).append(row)
        if row.get("hash"):
            by_hash.setdefault(row["hash"], []).append(row)
    out_rows = []
    for row in rows:
        flags = []
        kind = "rule" if row["exists"] and not row.get("skillMd", "").endswith("SKILL.md") else None
        up = upstreams.get(row["name"])
        if kind is None:
            if not row["exists"]:
                kind = "pointer"
                flags.append({"kind": "broken", "detail": f'Link target {row["linkTarget"]} does not exist.'})
            elif row["source"] == "prime-release":
                kind = "upstream"
                up = up or {"url": "Prime Agent release " + Path(row["realPath"]).parent.parent.name.split("-linux")[0].split("-darwin")[0]}
            elif up:
                pristine = up.get("sha256")
                kind = "upstream" if not pristine or pristine == row.get("hash") else "fork"
            elif row["source"] == "user-dir":
                kind = "upstream"
            else:
                kind = "ours"
        same_family = [r for r in by_name[row["name"]] if r is not row and r["family"] == row["family"]]
        others = [r for r in by_name[row["name"]] if r is not row and r["family"] != row["family"]]
        same_hash = [r for r in by_hash.get(row.get("hash"), []) if r is not row and r["family"] != row["family"] and r["name"] != row["name"]]
        dups = [] if row.get("entryId") else others + same_hash
        if dups:
            flags.append({"kind": "duplicate", "detail": f'{len(dups)} other copies share this name or text: ' + "; ".join(f'{r["box"]}:{r["path"]}' for r in dups[:4])})
        ref = next((r for r in same_family if r["box"] == "us-metal02"), None)
        if ref and row["box"] != "us-metal02" and ref.get("hash") and row.get("hash") and ref["hash"] != row["hash"]:
            flags.append({"kind": "drift", "detail": f'Differs from the us-metal02 copy {ref["path"]}.'})
        if kind == "fork":
            flags.append({"kind": "drift", "detail": f'Edited in place; differs from upstream {up.get("url")}.'})
        if row.get("deadRefs"):
            flags.append({"kind": "broken", "detail": f'Names {len(row["deadRefs"])} missing paths, such as {row["deadRefs"][0]}.'})
        if row.get("kindOverride"):
            kind = row["kindOverride"]
            flags = [f for f in flags if f["kind"] != "duplicate"]
        v = match_verdict(row, verdicts) or {}
        if row.get("entryId"):
            v = dict(harness_rules[row["entryId"]], group="harness notes")
            if v.get("verdict") in ("remove", "merge"):
                flags.append({"kind": "rule-repeats-skill", "detail": v.get("reason", "")})
        if v.get("kind"):
            kind = v["kind"]
        if v.get("unrequested"):
            flags.append({"kind": "unrequested", "detail": v.get("unrequested") if isinstance(v.get("unrequested"), str) else "Installed without an ask."})
        if v.get("rulerepeats"):
            flags.append({"kind": "rule-repeats-skill", "detail": v["rulerepeats"]})
        u = usage.get(row["name"]) or usage.get(row.get("pythonImport") or "", None) or {}
        if not u.get("uses30d") and kind not in ("rule",) and any(s.get("usage") for s in scans):
            flags.append({"kind": "unused", "detail": "No session read or called it in the last 30 days."})
        loaded = bool(row["runtimes"])
        out_rows.append({
            "id": row["id"],
            "name": row["name"],
            "kind": kind,
            "group": v.get("group") or groups.get(row["name"]) or "other",
            "description": row.get("description", ""),
            "box": row["box"],
            "path": row.get("skillMd") or row["realPath"],
            "dir": row["realPath"],
            "links": row["links"],
            "runtimes": row["runtimes"],
            "family": row["family"],
            "upstream": ({"url": up.get("url"), "status": "drift" if kind == "fork" else ("same" if up.get("sha256") else "unknown")} if up else None),
            "duplicateOf": [r["id"] for r in dups],
            "flags": flags,
            "useful": {"verdict": v.get("verdict"), "reason": v.get("reason"), "mergeInto": v.get("mergeInto"), "action": bool(v.get("verdict") in ("merge", "remove") and not v.get("noAction"))},
            "loadedBy": {"how": row["how"] if loaded else ["not loaded"], "agents": u.get("agents", []), "sessions30d": u.get("sessions30d", 0)},
            "uses7d": u.get("uses7d", 0),
            "uses30d": u.get("uses30d", 0),
            "sessions7d": u.get("sessions7d", 0),
            "uses": u.get("uses", []),
            "hash": row.get("hash"),
            "sizeBytes": row.get("sizeBytes"),
            "files": row.get("files"),
            "lines": row.get("lines"),
            "lastChange": row.get("lastChange"),
            "deadRefs": row.get("deadRefs", []),
            "text": row.get("text"),
            "entryId": row.get("entryId"),
        })
    out_rows.sort(key=lambda r: (r["group"], r["name"], r["box"], r["path"]))
    names = {r["name"] for r in out_rows}
    skill_verdict = {}
    for r in out_rows:
        if r["useful"]["verdict"]:
            skill_verdict.setdefault(r["name"], set()).add(r["useful"]["verdict"])
    counts = {
        "skills": len(names),
        "copies": len(out_rows),
        "copiesByKind": dict(sorted(collections_counter(r["kind"] for r in out_rows).items())),
        "copiesByVerdict": dict(sorted(collections_counter(r["useful"]["verdict"] or "unscored" for r in out_rows).items())),
    }
    return {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "definition": config.get("definition"),
        "boxes": [{"box": s["box"], "scannedAt": s["scannedAt"], "ok": s["ok"], "error": s["error"], "seconds": s.get("seconds"),
                   "usageStores": (s.get("usage") or {}).get("stores", []), "extras": s.get("extras")} for s in scans],
        "counts": counts,
        "skills": out_rows,
    }


def collections_counter(items) -> dict:
    out: dict = {}
    for i in items:
        out[i] = out.get(i, 0) + 1
    return out


if __name__ == "__main__":
    main()
