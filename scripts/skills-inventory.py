#!/usr/bin/env python3
"""Inventory every agent skill copy on us-metal02 and the Mac, with usage counts and health flags.

Writes ~/work/skills-health/inventory.json, the facts behind the sw factory skills DB: apps/chat's server/skills-db.ts ingests
its `copies`, `usage` and box `settings` into chat.sqlite and gives verdicts by rule. Upstream origins and groups for the older
`skills` rows come from config/skills-health.json next to this script.

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
REPO_PARENTS = ("src", "Documents/Github", "Documents", "code")
SOURCE_REPO = "sieun-pi"
SOURCE_SKILL_DIRS = ("skills", "legacy/prime/skills")
# Which folders the scan walks, raised each time it walks more: the skills DB owns the copies a new walk finds once, instead of listing every
# one as unowned. 2 added ~/code's symphony workspaces, .claude/skills-native, repo skills folders and the DB's install paths on 11-22.
COVERAGE = 2
REPO_SKILL_DIRS = (".agents/skills", ".claude/skills", ".claude/skills-native", ".codex/skills", ".cursor/skills", ".pi/skills")
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
_checkouts: dict[str, dict] = {}


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


def toplevel(folder: Path) -> str | None:
    parent = str(folder)
    if parent not in _toplevels:
        r = subprocess.run(["git", "-C", parent, "rev-parse", "--show-toplevel"], capture_output=True, text=True)
        _toplevels[parent] = r.stdout.strip() if r.returncode == 0 else None
    return _toplevels[parent]


def checkout_of(path: Path) -> dict | None:
    """The git checkout a folder or link sits in, with its remote, branch, last commit time and whether git tracks the path."""
    top = toplevel(path.parent) if path.parent.is_dir() else None
    if not top:
        return None
    if top not in _checkouts:
        def out(*args: str) -> str | None:
            r = subprocess.run(["git", "-C", top, *args], capture_output=True, text=True)
            return r.stdout.strip() or None if r.returncode == 0 else None
        files = subprocess.run(["git", "-C", top, "ls-files", "-z"], capture_output=True)
        _checkouts[top] = {
            "info": {"root": top, "remote": out("remote", "get-url", "origin"), "branch": out("branch", "--show-current"), "headAt": out("log", "-1", "--format=%cI"),
                     "upstreamAt": out("log", "-1", "--format=%cI", "@{u}"), "behind": int(out("rev-list", "--count", "HEAD..@{u}") or 0)},
            "files": set(files.stdout.decode(errors="replace").split("\0")) if files.returncode == 0 else set(),
        }
    known = _checkouts[top]
    rel = os.path.relpath(path, top)
    tracked = rel in known["files"] or any(f.startswith(rel + "/") for f in known["files"]) if path.is_dir() and not path.is_symlink() else rel in known["files"]
    return dict(known["info"], tracked=tracked)


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
        found.extend(here / n for n in sorted(names) if (here / n).is_symlink() and not (here / n).exists())
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


def python_import(folder: Path, name: str) -> str | None:
    """The module Prime pre-imports for a skill, by Prime's own rule: a pyproject.toml beside SKILL.md and src/<name with _ for ->/__init__.py."""
    module = name.replace("-", "_")
    if not folder.is_dir() or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", module) or not (folder / "pyproject.toml").is_file():
        return None
    return module if (folder / "src" / module / "__init__.py").is_file() else None


def scan_entry(path: Path, box: str, how: str, runtimes: list[str], source: str, root: Path) -> dict:
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
        "root": str(root),
        "exists": skill_md.is_file(),
        "checkout": checkout_of(path),
        "disableModelInvocation": False,
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
        "disableModelInvocation": fm.get("disable-model-invocation", "").lower() == "true",
        "pythonImport": fm.get("python_import") or python_import(real, fm.get("name") or path.name),
        "skillMd": str(skill_md),
        "hash": sha256(skill_md),
        "sizeBytes": size,
        "skillMdBytes": skill_md.stat().st_size,
        "files": files,
        "lines": text.count("\n") + 1,
        "mtime": datetime.fromtimestamp(skill_md.stat().st_mtime, timezone.utc).isoformat(),
        "lastChange": last,
        "deadRefs": dead,
        "text": text if box != "us-metal02" else None,
    })
    return row


def discover(box: str, installs: list[str] | None = None) -> list[dict]:
    rows: list[dict] = []
    jobs: list[tuple] = []

    def add(root: Path, paths, how: str, runtimes: list[str], source: str) -> None:
        jobs.extend((p, box, how, runtimes, source, root) for p in paths)

    links = HOME / ".prime/agent/skills"
    if links.is_dir():
        add(links, sorted(links.iterdir()), "prime-sync link ~/.prime/agent/skills", ["prime", "pi-host"], "prime-links")
    release = prime_release_skills()
    if release:
        add(release, [p for p in sorted(release.iterdir()) if (p / "SKILL.md").exists()], "prime-agent release bundle", ["prime", "pi-host"], "prime-release")
    pihost = HOME / ".local/share/pi-host/current/packages"
    for skills in sorted(pihost.glob("*/skills")) if pihost.is_dir() else []:
        add(skills, [p for p in sorted(skills.iterdir()) if (p / "SKILL.md").exists()], f"pi-host release {skills.parent.name}", ["pi-host"], "pi-host-release")
    runtime = HOME / ".local/share/sieun-pi-runtime/current/skills"
    if runtime.is_dir():
        add(runtime, [p for p in sorted(runtime.iterdir()) if (p / "SKILL.md").exists()], "sieun-pi runtime copy", [], "sieun-pi-runtime")
    pi_links = HOME / ".pi/agent/skills"
    if pi_links.is_dir():
        add(pi_links, sorted(pi_links.iterdir()), "~/.pi/agent/skills (pi CLI)", ["pi"], "pi-links")
    for plugins, runtime_name, label, source in ((HOME / ".claude/plugins/cache", "claude", "Claude Code plugin", "claude-plugin"),
                                                 (HOME / ".codex/plugins/cache", "codex", "Codex plugin", "codex-plugin")):
        for skills in sorted(plugins.glob("*/*/*/skills")) if plugins.is_dir() else []:
            add(skills, find_skill_dirs(skills, depth=6), f"{label} {skills.parent.parent.name}", [runtime_name], source)
    for rel, runtime_name, how in USER_SKILL_DIRS:
        add(HOME / rel, find_skill_dirs(HOME / rel), how, [runtime_name], "user-dir")
    rules = HOME / ".claude/rules"
    if rules.is_dir():
        add(rules, sorted(rules.glob("*.md")), "~/.claude/rules", ["claude"], "user-rules")
    state = HOME / ".prime/agent/harness/harness_state.json"
    if box == "us-metal02" and state.is_file():
        entries = json.loads(state.read_text()).get("entries", {})
        for kind, group in entries.items():
            for entry_id, entry in (group or {}).items():
                text = entry.get("content") or json.dumps(entry.get("reference") or {})
                rows.append({
                    "box": box, "path": f"harness:{kind}:{entry_id}", "realPath": f"harness:{kind}:{entry_id}", "linkTarget": None,
                    "how": "Prime continual harness (global)", "runtimes": ["prime", "pi-host"], "source": f"harness-{kind}", "exists": True,
                    "root": str(state), "checkout": None, "disableModelInvocation": False,
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
        for repo in repo_dirs(base):
            if not repo.is_dir() or repo.is_symlink() or repo.resolve() in seen_repos:
                continue
            seen_repos.add(repo.resolve())
            if repo.name == SOURCE_REPO:
                for sub in SOURCE_SKILL_DIRS:
                    folder = repo / sub
                    add(folder, [p for p in sorted(folder.iterdir()) if (p / "SKILL.md").exists()] if folder.is_dir() else [], "sieun-pi source", [], "sieun-pi")
                for folder in sorted(repo.glob("packages/*/skills")):
                    add(folder, [p for p in sorted(folder.iterdir()) if (p / "SKILL.md").exists()], f"sieun-pi package {folder.parent.name}", ["pi-host"], "sieun-pi-package")
                add(repo / "config/claude-rules", sorted((repo / "config/claude-rules").glob("*.md")), "pi-claude-rules extension", ["prime", "pi-host"], "sieun-pi-rules")
            label = str(repo.relative_to(base))
            for rel in REPO_SKILL_DIRS + (() if repo.name == SOURCE_REPO else ("skills",)):
                runtimes = [] if rel in (".claude/skills-native", "skills") else ["claude", "codex"]
                add(repo / rel, find_skill_dirs(repo / rel), f"repo {rel} ({label})", runtimes, f"repo:{label}")
    found = {str(job[0]) for job in jobs}
    for path in map(Path, installs or []):
        if str(path) not in found and path.is_absolute() and (path.is_symlink() or (path / "SKILL.md").exists() or path.is_file()):
            add(path.parent, [path], "sw skills install", [], "sw-install")
    with ThreadPoolExecutor(8) as pool:
        rows.extend(pool.map(lambda job: scan_entry(*job), jobs))
    return rows


def repo_dirs(base: Path) -> list[Path]:
    """The folders under base to scan as repos, plus the checkouts one level inside a folder that holds checkouts, such as ~/code's symphony workspaces."""
    out = []
    for repo in sorted(base.iterdir()):
        out.append(repo)
        if not repo.is_dir() or repo.is_symlink() or (repo / ".git").exists() or any((repo / rel).is_dir() for rel in REPO_SKILL_DIRS):
            continue
        try:
            out.extend(child for child in sorted(repo.iterdir()) if child.is_dir() and not child.is_symlink() and (child / ".git").exists())
        except OSError:
            pass
    return out


def box_settings() -> dict:
    """The settings that filter which skills a runtime lists: Prime's skills and bundledSkills, Claude Code's plugins, each repo's Prime filter."""
    prime = (lambda d: d if isinstance(d, dict) else {})(load_json(HOME / ".prime/agent/settings.json"))
    claude = (lambda d: d if isinstance(d, dict) else {})(load_json(HOME / ".claude/settings.json"))
    repos = {}
    for parent in REPO_PARENTS:
        base = HOME / parent
        for repo in repo_dirs(base) if base.is_dir() else []:
            settings = load_json(repo / ".prime/agent/settings.json")
            if isinstance(settings, dict) and isinstance(settings.get("skills"), list):
                repos[str(repo.resolve())] = settings["skills"]
    return {"primeSkills": prime.get("skills"), "primeBundledSkills": prime.get("bundledSkills"),
            "claudeEnabledPlugins": claude.get("enabledPlugins"), "repos": repos}


def load_json(path: Path):
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return None


def count_usage(now: datetime, box: str) -> dict:
    if "skills_usage" not in sys.modules:
        sys.path.insert(0, str(Path(__file__).resolve().parent))
    import skills_usage
    return skills_usage.count_usage(now, box)


def scan_box(box: str, usage: bool, installs: list[str] | None = None) -> dict:
    started = time.time()
    now = datetime.now(timezone.utc)
    out = {"box": box, "scannedAt": now.isoformat(), "ok": True, "error": None}
    out["rows"] = discover(box, installs)
    out["settings"] = box_settings()
    trash = HOME / ".claude/skills/.trash"
    wt = subprocess.run(["git", "-C", str(HOME / "src/sieun-pi"), "worktree", "list", "--porcelain"], capture_output=True, text=True)
    out["extras"] = {
        "claudeSkillTrashFolders": len(list(trash.iterdir())) if trash.is_dir() else 0,
        "sieunPiWorktrees": max(0, wt.stdout.count("\nworktree ") + wt.stdout.startswith("worktree ") - 1) if wt.returncode == 0 else None,
    }
    out["usage"] = count_usage(now, box) if usage else None
    out["seconds"] = round(time.time() - started, 1)
    return out


def scan_remote(box: str, host: str, usage: bool, timeout: int, installs: list[str] | None = None) -> dict:
    args = ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", host, "python3", "-", "--scan-box", box]
    if not usage:
        args.append("--no-usage")
    if installs:
        args += ["--installs-b64", base64.b64encode(json.dumps(installs).encode()).decode()]
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
    ap.add_argument("--install-paths", help="a JSON file of {box: [path]}, the skills DB's install paths, scanned also where they sit outside every root")
    ap.add_argument("--installs-b64", help="the install paths of the box --scan-box scans, as base64 JSON, for the ssh scan")
    args = ap.parse_args()
    if args.scan_box:
        installs = json.loads(base64.b64decode(args.installs_b64)) if args.installs_b64 else None
        json.dump(scan_box(args.scan_box, not args.no_usage, installs), sys.stdout)
        return
    by_box = load_json(Path(args.install_paths)) if args.install_paths else None
    by_box = by_box if isinstance(by_box, dict) else {}
    scans = [scan_box("us-metal02", not args.no_usage, by_box.get("us-metal02"))]
    if not args.no_mac:
        scans.append(scan_remote("mac", args.mac_host, not args.no_usage, args.mac_timeout, by_box.get("mac")))
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
    if src == "sieun-pi-package":
        return src
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


def merge_usage(scans: list[dict]) -> dict:
    merged: dict[str, dict] = {}
    for scan in scans:
        usage = scan.get("usage") or {}
        for name, u in (usage.get("skills") or {}).items():
            m = merged.setdefault(name, {"uses7d": 0, "uses30d": 0, "sessions7d": 0, "sessions30d": 0, "cliUnverified": 0, "agents": set(), "uses": [],
                                         "byKind": {}, "lastUse": None})
            for k in ("uses7d", "uses30d", "sessions7d", "sessions30d", "cliUnverified"):
                m[k] += u.get(k, 0)
            m["agents"].update(a for a in u.get("agents", []) if a)
            m["uses"].extend(u.get("uses", []))
            add_kinds(m["byKind"], u.get("byKind") or {})
            m["lastUse"] = max(filter(None, (m["lastUse"], u.get("lastUse"))), default=None)
    for m in merged.values():
        m["agentsCount"] = len(m["agents"])
        m["agents"] = sorted(m["agents"])[:20]
        m["uses"] = sorted(m["uses"], key=lambda u: u.get("at") or "", reverse=True)[:10]
    return merged


def add_kinds(into: dict, more: dict) -> None:
    for kind, tally in more.items():
        cur = into.setdefault(kind, {"uses": 0, "sessions": 0})
        cur["uses"] += tally.get("uses", 0)
        cur["sessions"] += tally.get("sessions", 0)


def usage_for(row: dict, usage: dict) -> dict:
    keys = {row["name"], row.get("dirName")} | {Path(link).name for link in row.get("links", [])}
    found = [usage[k] for k in sorted(k for k in keys if k) if k in usage]
    if len(found) <= 1:
        return found[0] if found else {}
    out = {k: sum(f.get(k, 0) for f in found) for k in ("uses7d", "uses30d", "sessions7d", "sessions30d", "agentsCount", "cliUnverified")}
    out["byKind"] = {}
    for f in found:
        add_kinds(out["byKind"], f.get("byKind") or {})
    out["lastUse"] = max((f["lastUse"] for f in found if f.get("lastUse")), default=None)
    out["agents"] = sorted({a for f in found for a in f.get("agents", [])})[:20]
    out["uses"] = sorted((u for f in found for u in f.get("uses", [])), key=lambda u: u.get("at") or "", reverse=True)[:10]
    return out


def build(scans: list[dict], config: dict) -> dict:
    copies: dict[tuple[str, str], dict] = {}
    harness_rules = {h["id"]: h for h in config.get("harnessRules", [])}
    for scan in scans:
        for row in scan["rows"]:
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
            elif row["source"] in ("user-dir", "claude-plugin", "codex-plugin"):
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
        v = {"group": "harness notes"} if row.get("entryId") else {}
        u = usage_for(row, usage)
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
            "useful": {"verdict": None, "reason": None, "mergeInto": None, "action": False},
            "loadedBy": {"how": row["how"] if loaded else ["not loaded"], "agents": u.get("agents", []), "agentsCount": u.get("agentsCount", 0), "sessions30d": u.get("sessions30d", 0)},
            "uses7d": u.get("uses7d", 0),
            "uses30d": u.get("uses30d", 0),
            "sessions7d": u.get("sessions7d", 0),
            "uses": u.get("uses", []),
            "byKind": u.get("byKind", {}),
            "lastUse": u.get("lastUse"),
            "cliUnverified": u.get("cliUnverified", 0),
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
    counts = {
        "skills": len(names),
        "copies": len(out_rows),
        "copiesByKind": dict(sorted(collections_counter(r["kind"] for r in out_rows).items())),
    }
    return {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "coverage": COVERAGE,
        "definition": config.get("definition"),
        "boxes": [{"box": s["box"], "scannedAt": s["scannedAt"], "ok": s["ok"], "error": s["error"], "seconds": s.get("seconds"),
                   "usageStores": (s.get("usage") or {}).get("stores", []), "extras": s.get("extras"), "settings": s.get("settings")} for s in scans],
        "counts": counts,
        "skills": out_rows,
        "copies": [{k: v for k, v in row.items() if k != "lastChange"} for s in scans for row in s["rows"]
                   if row.get("harnessKind") in (None, "skill", "subagent")],
        "usage": {name: {k: u[k] for k in ("uses30d", "sessions30d", "byKind", "lastUse", "cliUnverified")} for name, u in usage.items()},
        "usageCounted": any(s.get("usage") for s in scans),
    }


def collections_counter(items) -> dict:
    out: dict = {}
    for i in items:
        out[i] = out.get(i, 0) + 1
    return out


if __name__ == "__main__":
    main()
