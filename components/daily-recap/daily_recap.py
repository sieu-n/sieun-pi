#!/usr/bin/env python3
"""Daily recap: one post to a configured Slack channel, details in the thread.

Parent message: 3 to 6 headlines for the day's product changes (topic first,
commit shas linked to GitHub), then one line each for tokens, Drifty and
Sunsama. Thread replies carry the full context:
  1. Product: conclusive changes, work in progress, features touched today with
     what changed, the rest of the feature list, and a housekeeping count.
     Source: `git log` on the local checkout since the previous run; an LLM
     (prime-agent -p, no tools) writes the text under the unslop rules and
     keeps the feature list (state/features.json) current.
  2. Personal: token usage by model (tokscale graph cached hourly by the
     drifty-focus-upload job) and the Drifty focus day (tracker.sqlite3 via
     drifty_focus_export.py).
  3. Sunsama: today's tasks, the week's objectives, the Mon-Sun grid, and what
     changed since the previous run. Source: sunsama_fetch.mjs, which reads the
     session cookie of the locally installed Sunsama app.

Every section fails on its own; a failed section becomes a line in the
message, never a missing message. The report is written to disk before the
Slack call (reports/YYYY-MM-DD.md).

Runtime layout (installed by install_daily_recap_agent.sh):
  ~/.prime/agent/daily-recap/bin/        this file + helpers (launchd copy)
  ~/.prime/agent/daily-recap/config.env  SLACK_BOT_TOKEN, SLACK_CHANNEL, REPO_DIR
  ~/.prime/agent/daily-recap/state/      features.json, last_run.json, sunsama_prev.json
  ~/.prime/agent/daily-recap/reports/    one markdown file per run
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import subprocess
import sys
import time
import traceback
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Dict, List, Optional
from zoneinfo import ZoneInfo

HERE = Path(__file__).resolve().parent
RUNTIME = Path(os.environ.get("DAILY_RECAP_HOME") or Path.home() / ".prime" / "agent" / "daily-recap")
STATE = RUNTIME / "state"
REPORTS = RUNTIME / "reports"
TZ_NAME = os.environ.get("DAILY_RECAP_TZ") or "UTC"
TZ = ZoneInfo(TZ_NAME)
REPO_DIR = Path(os.environ["REPO_DIR"]).expanduser() if os.environ.get("REPO_DIR") else None
TOKSCALE_GRAPH = Path(os.environ["TOKSCALE_GRAPH"]).expanduser() if os.environ.get("TOKSCALE_GRAPH") else None
SLACK_CHANNEL = os.environ.get("SLACK_CHANNEL", "")
GITHUB_REPO = os.environ.get("GITHUB_REPO", "").rstrip("/")
SUNSAMA_URL = os.environ.get("SUNSAMA_URL", "")
TOKENS_URL = os.environ.get("TOKENS_URL", "")
FOCUS_URL = os.environ.get("FOCUS_URL", "")
UNSLOP_RULES = Path(os.environ.get("UNSLOP_RULES") or HERE / "unslop.md").expanduser()
LLM_TIMEOUT_S = int(os.environ.get("LLM_TIMEOUT_S", "600"))
COMMIT_BODY_CHARS = 700
DIGEST_CHAR_BUDGET = 90_000
SLACK_SECTION_CHARS = 2900


def now_local() -> dt.datetime:
    return dt.datetime.now(TZ)


def hm(seconds: float) -> str:
    seconds = int(seconds)
    h, m = divmod(seconds // 60, 60)
    if h and m:
        return f"{h}h {m:02d}m"
    if h:
        return f"{h}h"
    return f"{m}m"


def fmt_int(n: float) -> str:
    return f"{int(round(n)):,}"


def fmt_tokens(n: float) -> str:
    n = float(n)
    if n >= 1e9:
        return f"{n / 1e9:.2f}B"
    if n >= 1e6:
        return f"{n / 1e6:.1f}M"
    if n >= 1e3:
        return f"{n / 1e3:.0f}K"
    return str(int(n))


def read_json(path: Path, default: Any) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return default


def write_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False, sort_keys=True), encoding="utf-8")
    tmp.replace(path)


def slack_link(url: str, label: str) -> str:
    return f"<{url}|{label}>" if url else label


def slack_escape(text: str) -> str:
    return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


class SectionResult:
    """One recap section: a one-line summary for the parent post, detail lines for the thread."""

    def __init__(self, title: str) -> None:
        self.title = title
        self.summary: str = ""
        self.lines: List[str] = []
        self.error: Optional[str] = None

    def summary_text(self) -> str:
        if self.error:
            failure = f"{self.title}: failed, {slack_escape(self.error)}"
            return f"{self.summary} · {failure}" if self.summary else failure
        return self.summary

    def detail_text(self) -> str:
        body = "\n".join(self.lines).strip()
        if self.error:
            body = (body + "\n" if body else "") + f"Failed: {slack_escape(self.error)}"
        return f"*{self.title}*\n{body or 'nothing to report'}"


def unslop_text(text: str) -> str:
    """Mechanical pass for the tells the model still emits: dashes, curly quotes, emoji ticks."""
    text = re.sub(r"\s*[\u2014\u2013]\s*", ", ", text)
    text = text.replace("\u2018", "'").replace("\u2019", "'").replace("\u201c", '"').replace("\u201d", '"')
    text = re.sub(r"[\u2705\u274c\u2b1c\u270f\ufe0f\U0001F300-\U0001FAFF]", "", text)
    text = re.sub(r"[ \t]{2,}", " ", text)
    return text.strip()


def linkify_shas(text: str, known: Dict[str, str]) -> str:
    """Turn every known short sha in the text into a GitHub commit link."""

    def repl(m: "re.Match[str]") -> str:
        sha = m.group(0)
        full = known.get(sha)
        return f"<{GITHUB_REPO}/commit/{full or sha}|{sha}>" if sha in known else sha

    return re.sub(r"\b[0-9a-f]{7,12}\b", repl, text) if GITHUB_REPO else text


# ────────────────────────────── section 1: product ──────────────────────────────


def git(args: List[str], cwd: Path) -> str:
    proc = subprocess.run(["git", *args], cwd=str(cwd), capture_output=True, text=True, timeout=120)
    if proc.returncode != 0:
        raise RuntimeError(f"git {' '.join(args[:2])} failed: {proc.stderr.strip()[:300]}")
    return proc.stdout


def collect_commits(repo: Path, since: dt.datetime, until: dt.datetime) -> List[Dict[str, Any]]:
    """Commits in (since, until] on HEAD with their numstat.

    git prints, per commit: the format line, a blank line, the numstat rows, a
    blank line. The format starts with \x1e so a new record is unambiguous even
    when a body line looks like a numstat row.
    """
    fs = "\x1f"
    fmt = "\x1e" + fs.join(["%h", "%H", "%an", "%cI", "%s"]) + fs + "%b" + fs
    raw = git(
        ["log", f"--since={since.isoformat()}", f"--until={until.isoformat()}", f"--format={fmt}", "--numstat"],
        repo,
    )
    commits: List[Dict[str, Any]] = []
    for record in raw.split("\x1e"):
        if not record.strip():
            continue
        fields = record.split(fs)
        if len(fields) < 7:
            continue
        short, full, author, date, subject, body, tail = fields[0], fields[1], fields[2], fields[3], fields[4], fields[5], fields[6]
        files: List[Dict[str, Any]] = []
        for line in tail.split("\n"):
            m = re.match(r"^(\d+|-)\t(\d+|-)\t(.+)$", line)
            if m:
                files.append(
                    {
                        "path": m.group(3),
                        "added": 0 if m.group(1) == "-" else int(m.group(1)),
                        "deleted": 0 if m.group(2) == "-" else int(m.group(2)),
                    }
                )
        commits.append(
            {
                "sha": short,
                "full": full,
                "author": author,
                "date": date,
                "subject": subject.strip(),
                "body": body.strip(),
                "files": files,
            }
        )
    return commits


def area_of(path: str) -> str:
    parts = path.split("/")
    if parts[0] in ("apps", "packages", "scripts") and len(parts) > 1:
        return f"{parts[0]}/{parts[1]}"
    if parts[0] == "convex" and len(parts) > 1:
        return f"convex/{parts[1]}"
    return parts[0]


def commit_digest(commits: List[Dict[str, Any]]) -> str:
    out: List[str] = []
    for c in commits:
        areas: Dict[str, int] = {}
        added = deleted = 0
        for f in c["files"]:
            areas[area_of(f["path"])] = areas.get(area_of(f["path"]), 0) + 1
            added += f["added"]
            deleted += f["deleted"]
        top_areas = ", ".join(f"{a} ({n})" for a, n in sorted(areas.items(), key=lambda kv: -kv[1])[:5])
        body = c["body"]
        if len(body) > COMMIT_BODY_CHARS:
            body = body[:COMMIT_BODY_CHARS] + " […]"
        out.append(
            f"### {c['sha']} {c['date'][:16]} — {c['subject']}\n"
            f"files: {len(c['files'])} (+{added}/-{deleted}) areas: {top_areas}\n"
            + (body + "\n" if body else "")
        )
    digest = "\n".join(out)
    if len(digest) > DIGEST_CHAR_BUDGET:
        digest = digest[:DIGEST_CHAR_BUDGET] + "\n[… digest truncated at budget …]"
    return digest


PRODUCT_PROMPT = """You write the daily product recap for the configured repository. The attached file has: the WRITING RULES (unslop), the current FEATURE LIST (JSON), optional PRODUCT CONTEXT from the wiki, and TODAY'S COMMITS (subject, body, files, areas).

Return ONLY one JSON object, no prose, no code fence:
{
  "headlines": ["<one line>", "..."],
  "conclusive": ["<one sentence>", "..."],
  "in_progress": ["<one sentence>", "..."],
  "features": [
    {"name": "<stable short name>", "summary": "<one plain sentence: what it lets a user or operator do>", "today": "<shipped|changed|unchanged>", "today_note": "<one clause when today != unchanged, else empty string>"}
  ],
  "housekeeping": "<one sentence counting docs, wiki, agent-journal and test-only commits, or empty string>"
}

How to write:
- Every string follows the WRITING RULES. No em dashes, no colons as connectors, no emoji, no praise, no marketing words, active voice, common words, one idea per sentence.
- headlines: the 3 to 6 changes of the day that matter most to a user or an operator. Topic first, never the app or platform name ("Onboarding removed; sign-up lands on /app or the paywall", not "Platform: onboarding removed"). Under 140 characters. Say what now happens differently. End with the commit shas in parentheses.
- conclusive: every change finished today that a user or operator can see, or a decision that closes a question (a migration completed, a path deleted, a model replaced). One sentence each, under 200 characters, the topic first, shas in parentheses at the end. At most 12. Internal refactors go here only if they delete or replace something for good.
- in_progress: multi-commit work that is not finished (phase 1 of N, scaffolding, WIP). At most 6, same style.
- features: keep existing names stable. Add a feature only when commits introduce a capability no existing feature covers. Merge duplicates. Remove nothing; mark a removed capability today="changed" and say so in today_note. Name features by what they do, not by app. "today" = shipped when the commits finish a capability or make it live, changed when they alter it, unchanged otherwise. today_note is one clause, under 120 characters.
- Docs, wiki, agent journals, memory notes and test-only commits are not features, not headlines and not conclusive; count them in housekeeping.
"""


def run_llm(context_path: Path, instruction: str) -> str:
    cmd = [
        "prime-agent",
        "-p",
        "-nt",
        "-ns",
        "-ne",
        "-nc",
        "-np",
        "--no-session",
        "--offline",
        "--thinking",
        os.environ.get("LLM_THINKING", "low"),
        f"@{context_path}",
        instruction,
    ]
    env = dict(os.environ)
    env.setdefault("NO_COLOR", "1")
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=LLM_TIMEOUT_S, env=env, cwd=str(RUNTIME))
    if proc.returncode != 0:
        raise RuntimeError(f"prime-agent -p exit {proc.returncode}: {(proc.stderr or proc.stdout)[-400:]}")
    return proc.stdout


def parse_json_object(text: str) -> Dict[str, Any]:
    text = text.strip()
    if text.startswith("```"):
        text = re.sub(r"^```[a-zA-Z]*\n|\n```$", "", text).strip()
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end < 0:
        raise ValueError("no JSON object in LLM output")
    return json.loads(text[start : end + 1])


def wiki_context(repo: Path) -> str:
    """Plain text of the wiki app hubs, used only while the feature list is empty."""
    from html.parser import HTMLParser

    class Stripper(HTMLParser):
        def __init__(self) -> None:
            super().__init__()
            self.parts: List[str] = []
            self.skip = False

        def handle_starttag(self, tag: str, attrs: Any) -> None:
            if tag in ("script", "style"):
                self.skip = True

        def handle_endtag(self, tag: str) -> None:
            if tag in ("script", "style"):
                self.skip = False

        def handle_data(self, data: str) -> None:
            if not self.skip and data.strip():
                self.parts.append(data.strip())

    pages = json.loads(os.environ.get("WIKI_PAGES_JSON") or "[]")
    if not isinstance(pages, list) or any(not isinstance(page, str) for page in pages):
        raise ValueError("WIKI_PAGES_JSON must be a JSON array of relative paths")
    out: List[str] = []
    for rel in pages:
        p = (repo / rel).resolve()
        if not p.is_relative_to(repo.resolve()):
            raise ValueError("WIKI_PAGES_JSON paths must stay inside REPO_DIR")
        if not p.exists():
            continue
        s = Stripper()
        s.feed(p.read_text(encoding="utf-8", errors="replace"))
        out.append(f"## {rel}\n" + "\n".join(s.parts)[:12_000])
    return "\n\n".join(out)


def trim_shas(text: str, keep: int) -> str:
    """Keep at most `keep` shas in the trailing parenthesis; the thread has the rest."""
    m = re.search(r"\(([0-9a-f]{7,12}(?:,\s*[0-9a-f]{7,12})*)\)\s*\.?\s*$", text)
    if not m:
        return text
    shas = [s.strip() for s in m.group(1).split(",")]
    if len(shas) <= keep:
        return text
    return text[: m.start()] + "(" + ", ".join(shas[:keep]) + f", +{len(shas) - keep} more)"


def clean_list(items: Any, limit: int, known: Dict[str, str], max_shas: int = 3) -> List[str]:
    out: List[str] = []
    for item in items or []:
        if isinstance(item, str) and item.strip():
            out.append(linkify_shas(slack_escape(trim_shas(unslop_text(item), max_shas)), known))
        if len(out) >= limit:
            break
    return out


def section_product(since: dt.datetime, until: dt.datetime, skip_repo: bool, run_dir: Path) -> SectionResult:
    sec = SectionResult("Product")
    if skip_repo:
        sec.summary = "Product skipped (--no-repo; launchd uses this without an existing tmux server)."
        return sec
    if REPO_DIR is None or os.environ.get("LLM_ENABLED") != "1":
        sec.summary = "Product not configured (set REPO_DIR and LLM_ENABLED=1)."
        return sec
    features_path = STATE / "features.json"
    features = read_json(features_path, {"features": []})
    commits = collect_commits(REPO_DIR, since, until)
    known = {c["sha"]: c["full"] for c in commits}
    window = f"{since.astimezone(TZ):%b %-d %H:%M} to {until.astimezone(TZ):%b %-d %H:%M}"
    if not commits and features.get("features"):
        sec.summary = f"No commits ({window})."
        sec.lines.append(f"No commits in the window ({window}).")
        sec.lines.extend(render_features(features["features"], mark_today=False))
        return sec

    ctx: List[str] = []
    if os.environ.get("PRODUCT_CONTEXT"):
        ctx.append("# PRODUCT CONTEXT\n" + os.environ["PRODUCT_CONTEXT"])
    if UNSLOP_RULES.exists():
        ctx.append("# WRITING RULES (unslop)\n" + UNSLOP_RULES.read_text(encoding="utf-8"))
    ctx.append("# FEATURE LIST (current)\n" + json.dumps(features, ensure_ascii=False, indent=1))
    if not features.get("features"):
        ctx.append("# PRODUCT CONTEXT (wiki hubs; use to seed the feature list)\n" + wiki_context(REPO_DIR))
    ctx.append(f"# TODAY'S COMMITS ({len(commits)} commits, window {window})\n" + commit_digest(commits))
    context_path = run_dir / "product-context.md"
    context_path.write_text("\n\n".join(ctx), encoding="utf-8")

    raw = run_llm(context_path, PRODUCT_PROMPT)
    (run_dir / "product-llm-raw.txt").write_text(raw, encoding="utf-8")
    data = parse_json_object(raw)
    new_features = [f for f in data.get("features", []) if isinstance(f, dict) and f.get("name")]
    if not new_features and features.get("features"):
        raise RuntimeError("LLM returned an empty feature list; keeping the previous one")
    for f in new_features:
        f["name"] = unslop_text(str(f["name"]))
        f["summary"] = unslop_text(str(f.get("summary") or ""))
        f["today_note"] = unslop_text(str(f.get("today_note") or ""))
        f.pop("product", None)
    features = {"features": new_features, "updatedAt": until.isoformat()}
    write_json(features_path, features)

    headlines = clean_list(data.get("headlines"), 6, known, max_shas=2)
    conclusive = clean_list(data.get("conclusive"), 12, known)
    in_progress = clean_list(data.get("in_progress"), 6, known)
    touched = [f for f in new_features if str(f.get("today") or "unchanged") != "unchanged"]

    sec.summary = "\n".join(f"• {h}" for h in headlines) if headlines else "No headline-sized change today."
    sec.lines.append(f"{len(commits)} commits, {window}. {len(conclusive)} conclusive changes, {len(touched)} features touched.")
    sec.lines.append("")
    sec.lines.append("*Conclusive changes*")
    if conclusive:
        sec.lines.extend(f"• {b}" for b in conclusive)
    else:
        sec.lines.append("• none")
    if in_progress:
        sec.lines.append("*In progress*")
        sec.lines.extend(f"• {b}" for b in in_progress)
    sec.lines.append("")
    sec.lines.extend(render_features(new_features, mark_today=True))
    hk = data.get("housekeeping")
    if isinstance(hk, str) and hk.strip():
        sec.lines.append(slack_escape(unslop_text(hk)))
    return sec


def render_features(features: List[Dict[str, Any]], mark_today: bool) -> List[str]:
    """Features touched today with their note, then the rest of the list on one line."""
    lines: List[str] = []
    touched = [f for f in features if mark_today and str(f.get("today") or "unchanged") != "unchanged"]
    rest = [f for f in features if f not in touched]
    if touched:
        lines.append("*Features touched today*")
        for f in touched:
            state = "shipped" if f.get("today") == "shipped" else "changed"
            note = str(f.get("today_note") or "").strip()
            lines.append(f"• {slack_escape(str(f['name']))} ({state})" + (f": {slack_escape(note)}" if note else ""))
    if rest:
        lines.append("*Other features, unchanged today*" if touched else "*All features*")
        lines.append(" · ".join(slack_escape(str(f["name"])) for f in rest))
    return lines


# ────────────────────────────── section 2: personal ──────────────────────────────


def section_personal(today: dt.date) -> SectionResult:
    sec = SectionResult("Personal")
    errors: List[str] = []
    summaries: List[str] = []
    try:
        tok_summary, tok_lines = token_block(today)
        summaries.append(tok_summary)
        sec.lines.extend(tok_lines)
    except Exception as exc:  # noqa: BLE001 — each sub-block reports its own failure
        errors.append(f"tokens: {exc}")
    try:
        dr_summary, dr_lines = drifty_block(today)
        summaries.append(dr_summary)
        sec.lines.extend(dr_lines)
    except Exception as exc:  # noqa: BLE001
        errors.append(f"drifty: {exc}")
    sec.summary = " · ".join(summaries)
    if errors:
        sec.error = "; ".join(errors)
    return sec


def load_token_graph() -> Dict[str, Any]:
    """The live tokscale graph, or the last good copy while a scan is rewriting it.

    drifty-focus-upload/run.sh truncates .tokscale-graph.json before the ~60s
    `tokscale graph` scan fills it; under memory pressure that scan has taken
    10+ minutes (2026-09-02 21:31), so the 21:00 run can meet an empty file.
    """
    cache = STATE / "tokscale-graph.cache.json"
    graph = read_json(TOKSCALE_GRAPH, None)
    if isinstance(graph, dict) and graph.get("contributions"):
        try:
            cache.write_bytes(TOKSCALE_GRAPH.read_bytes())
        except OSError:
            pass
        graph["_source"] = "live"
        return graph
    cached = read_json(cache, None)
    if isinstance(cached, dict) and cached.get("contributions"):
        cached["_source"] = "cache"
        return cached
    raise RuntimeError(f"no tokscale graph at {TOKSCALE_GRAPH} and no cached copy yet")


def token_block(today: dt.date) -> "tuple[str, List[str]]":
    if TOKSCALE_GRAPH is None:
        return "Tokens not configured.", ["Tokens not configured (set TOKSCALE_GRAPH)."]
    graph = load_token_graph()
    generated = str((graph.get("meta") or {}).get("generatedAt") or "")
    contributions = graph.get("contributions") or []
    by_date = {c["date"]: c for c in contributions if c.get("date")}
    day = by_date.get(today.isoformat())
    lines = [f"*{slack_link(TOKENS_URL, 'Tokens')}*"]
    if day is None:
        summary = f"{slack_link(TOKENS_URL, 'tokens')} none recorded yet"
        lines.append(f"• today: no usage recorded yet (graph generated {generated[:16]}Z)")
    else:
        totals = day.get("totals") or {}
        summary = f"{slack_link(TOKENS_URL, 'tokens')} ${totals.get('cost', 0):,.0f} ({fmt_tokens(totals.get('tokens', 0))})"
        lines.append(
            f"• today: {fmt_tokens(totals.get('tokens', 0))} tokens · ${totals.get('cost', 0):,.0f} · "
            f"{fmt_int(totals.get('messages', 0))} messages"
        )
        models: Dict[str, Dict[str, float]] = {}
        for c in day.get("clients") or []:
            key = f"{c.get('client')}/{c.get('modelId')}"
            tb = c.get("tokens") or {}
            tok = sum(int(tb.get(k, 0)) for k in ("input", "output", "cacheRead", "cacheWrite", "reasoning"))
            row = models.setdefault(key, {"tokens": 0, "cost": 0.0})
            row["tokens"] += tok
            row["cost"] += float(c.get("cost") or 0)
        top = sorted(models.items(), key=lambda kv: -kv[1]["cost"])[:3]
        if top:
            lines.append(
                "• top: " + " · ".join(f"{k} ${v['cost']:,.0f} ({fmt_tokens(v['tokens'])})" for k, v in top)
            )
    week_cost = sum(
        float((by_date.get((today - dt.timedelta(days=i)).isoformat()) or {}).get("totals", {}).get("cost", 0))
        for i in range(7)
    )
    month_prefix = today.strftime("%Y-%m")
    month_cost = sum(float((c.get("totals") or {}).get("cost", 0)) for c in contributions if c["date"].startswith(month_prefix))
    yesterday = float((by_date.get((today - dt.timedelta(days=1)).isoformat()) or {}).get("totals", {}).get("cost", 0))
    stamp = generated[11:16] + "Z" if len(generated) >= 16 else "unknown time"
    origin = "graph refreshed" if graph.get("_source") == "live" else "live graph empty (scan running), cached graph from"
    lines.append(f"• yesterday ${yesterday:,.0f} · last 7 days ${week_cost:,.0f} · month to date ${month_cost:,.0f} · {origin} {stamp}")
    return summary, lines


def drifty_block(today: dt.date) -> "tuple[str, List[str]]":
    db_path = os.environ.get("DRIFTY_DB")
    slug = os.environ.get("DRIFTY_SLUG")
    if not db_path or not slug:
        return "Drifty not configured.", ["Drifty not configured (set DRIFTY_DB and DRIFTY_SLUG)."]
    sys.path.insert(0, str(HERE))
    import drifty_focus_export as dfe

    snap = dfe.build_snapshot(Path(db_path).expanduser(), slug, TZ_NAME, today=today, app_site_limit=40)
    t = snap["today"]
    tracked, focus, drift, neutral = (t["trackedSeconds"], t["focusSeconds"], t["driftSeconds"], t["neutralSeconds"])
    classified = t["classifiedSeconds"]
    lines = [f"*{slack_link(FOCUS_URL, 'Drifty')}, today*"]
    if tracked == 0:
        lines.append("• no activity tracked today")
        return f"{slack_link(FOCUS_URL, 'Drifty')} nothing tracked", lines
    share = f"{focus / classified:.0%}" if classified else "n/a"
    summary = f"{slack_link(FOCUS_URL, 'Drifty')} focus {hm(focus)} of {hm(classified)} classified ({share})"
    unclassified = tracked - classified
    lines.append(
        f"• tracked {hm(tracked)} · focus {hm(focus)} ({share} of classified) · drift {hm(drift)} · neutral {hm(neutral)}"
        + (f" · not yet classified {hm(unclassified)}" if unclassified >= 600 else "")
    )
    segs = snap.get("todaySegments") or []
    if segs:
        first = min(s["startMinute"] for s in segs)
        last = max(s["endMinute"] for s in segs)
        lines.append(f"• active {first // 60:02d}:{first % 60:02d} to {last // 60:02d}:{last % 60:02d}")
    # hour strip: one glyph per hour between the first and last active hour. The glyph is the
    # dominant classified state of that hour; an hour with under five classified minutes but
    # some tracked time is "·"; an idle hour is a space.
    hours: Dict[int, Dict[str, int]] = {}
    for s in segs:
        h = s["startMinute"] // 60
        cell = hours.setdefault(h, {"focus": 0, "drift": 0, "neutral": 0, "unclassified": 0})
        cell[s["productivity"] if s["productivity"] in cell else "unclassified"] += s["durationSeconds"]
    if hours:
        glyph = {"focus": "█", "drift": "▒", "neutral": "▄"}
        lo, hi = min(hours), max(hours)
        strip = ""
        for h in range(lo, hi + 1):
            cell = hours.get(h)
            if not cell or sum(cell.values()) < 300:
                strip += " "
                continue
            classified_cell = {k: cell[k] for k in glyph}
            if sum(classified_cell.values()) < 300:
                strip += "·"
                continue
            strip += glyph[max(classified_cell, key=lambda k: classified_cell[k])]
        lines.append(f"• hours {lo:02d} to {hi:02d}: `{strip}`  (█ focus ▒ drift ▄ neutral · unclassified)")
    # today-only app/site rollup (snapshot's appSiteRollup spans the week)
    rollup: Dict[str, Dict[str, int]] = {}
    for s in segs:
        label = s.get("siteDomain") or s.get("appLabel") or "?"
        row = rollup.setdefault(label, {"focus": 0, "drift": 0, "neutral": 0, "unclassified": 0})
        row[s["productivity"] if s["productivity"] in row else "unclassified"] += s["durationSeconds"]
    top_focus = sorted(((k, v["focus"]) for k, v in rollup.items() if v["focus"] >= 60), key=lambda kv: -kv[1])[:4]
    if top_focus:
        lines.append("• focus went to: " + " · ".join(f"{slack_escape(k)} {hm(v)}" for k, v in top_focus))
    top_drift = sorted(((k, v["drift"]) for k, v in rollup.items() if v["drift"] >= 60), key=lambda kv: -kv[1])[:3]
    if top_drift:
        lines.append("• drift went to: " + " · ".join(f"{slack_escape(k)} {hm(v)}" for k, v in top_drift))
    week = snap["week"]
    if week["classifiedSeconds"]:
        lines.append(
            f"• week ({week['label']}): tracked {hm(week['trackedSeconds'])} · focus {hm(week['focusSeconds'])} "
            f"({week['focusSeconds'] / week['classifiedSeconds']:.0%} of classified)"
        )
    return summary, lines


# ────────────────────────────── section 3: sunsama ──────────────────────────────


def sunsama_fetch(today: dt.date) -> Dict[str, Any]:
    script = HERE / "sunsama_fetch.mjs"
    env = dict(os.environ)
    env["SUNSAMA_TZ"] = TZ_NAME
    env["SUNSAMA_TODAY"] = today.isoformat()
    proc = subprocess.run(["node", str(script)], capture_output=True, text=True, timeout=180, env=env, cwd=str(RUNTIME))
    if proc.returncode != 0:
        raise RuntimeError(f"sunsama_fetch.mjs exit {proc.returncode}: {proc.stderr.strip()[-400:]}")
    return json.loads(proc.stdout)


def task_key(t: Dict[str, Any]) -> str:
    return str(t.get("_id"))


def section_sunsama(today: dt.date) -> SectionResult:
    sec = SectionResult("Sunsama")
    if not os.environ.get("SUNSAMA_COOKIE_DB"):
        sec.summary = "Sunsama not configured (set SUNSAMA_COOKIE_DB)."
        return sec
    data = sunsama_fetch(today)
    prev = read_json(STATE / "sunsama_prev.json", None)
    write_json(STATE / "sunsama_prev.json", data)

    todays = data["today"]["tasks"]
    done = [t for t in todays if t.get("completed")]
    open_ = [t for t in todays if not t.get("completed")]
    est_total = sum(int(t.get("timeEstimate") or 0) for t in todays)
    est_done = sum(int(t.get("timeEstimate") or 0) for t in done)
    actual = sum(int(t.get("actualMinutes") or 0) for t in todays)
    objectives = data.get("objectives") or []
    if data.get("objectivesError"):
        sec.error = f"Sunsama objectives: {data['objectivesError']}"
    obj_done = sum(1 for o in objectives if o.get("completed"))
    sec.summary = (
        f"{slack_link(SUNSAMA_URL, 'Sunsama')} {len(done)} of {len(todays)} tasks done, "
        f"{obj_done} of {len(objectives)} weekly objectives done"
    )

    def task_line(t: Dict[str, Any]) -> str:
        text = slack_escape(t["text"])
        est = f" ({t['timeEstimate']}m)" if t.get("timeEstimate") else ""
        logged = f", logged {t['actualMinutes']}m" if t.get("actualMinutes") else ""
        return f"• ~{text}~{est}{logged}" if t.get("completed") else f"• {text}{est}{logged}"

    sec.lines.append(
        f"*{slack_link(SUNSAMA_URL, today.strftime('Today, %a %b %-d'))}*, {len(done)} of {len(todays)} done, planned {hm(est_total * 60)}, "
        f"done {hm(est_done * 60)}, logged {hm(actual * 60)}"
    )
    sec.lines.extend(task_line(t) for t in done)
    sec.lines.extend(task_line(t) for t in open_)

    sec.lines.append(f"*Weekly objectives, week of {dt.date.fromisoformat(data['week']['start']):%b %-d}*")
    if not objectives:
        sec.lines.append("• none set")
    for o in objectives:
        text = slack_escape(o["text"])
        text = f"~{text}~" if o.get("completed") else text
        linked = len(o.get("taskIds") or [])
        stream = f" [{slack_escape(o['streamName'])}]" if o.get("streamName") else ""
        sec.lines.append(f"• {text}{stream}" + (f", {linked} linked tasks" if linked else ""))

    sec.lines.append("*Week*")
    grid: List[str] = []
    for day in data["week"]["days"]:
        d = dt.date.fromisoformat(day["date"])
        tasks = day["tasks"]
        n_done = sum(1 for t in tasks if t.get("completed"))
        est = sum(int(t.get("timeEstimate") or 0) for t in tasks)
        label = f"*{d:%a}*" if d == today else f"{d:%a}"
        grid.append(f"{label} {n_done}/{len(tasks)}" + (f" {hm(est * 60)}" if est else ""))
    sec.lines.append("• " + " · ".join(grid))
    if data.get("backlogCount"):
        sec.lines.append(f"• backlog: {data['backlogCount']} tasks")

    if prev:
        prev_tasks = {task_key(t): t for day in prev["week"]["days"] for t in day["tasks"]}
        cur_tasks = {task_key(t): t for day in data["week"]["days"] for t in day["tasks"]}
        added = [t for k, t in cur_tasks.items() if k not in prev_tasks]
        completed = [t for k, t in cur_tasks.items() if t.get("completed") and not (prev_tasks.get(k) or {}).get("completed")]
        moved = [
            (prev_tasks[k].get("day"), t)
            for k, t in cur_tasks.items()
            if k in prev_tasks and prev_tasks[k].get("day") != t.get("day")
        ]
        removed = [t for k, t in prev_tasks.items() if k not in cur_tasks]
        prev_obj = {o["_id"]: o for o in prev.get("objectives") or []}
        obj_added = [o for o in objectives if o["_id"] not in prev_obj]
        obj_completed = [o for o in objectives if o.get("completed") and not (prev_obj.get(o["_id"]) or {}).get("completed")]
        changes: List[str] = []
        changes.extend(f"• completed: {slack_escape(t['text'])}" for t in completed)
        changes.extend(f"• added ({t.get('day')}): {slack_escape(t['text'])}" for t in added)
        changes.extend(f"• moved {frm} to {t.get('day')}: {slack_escape(t['text'])}" for frm, t in moved)
        changes.extend(f"• dropped from the week: {slack_escape(t['text'])}" for t in removed)
        changes.extend(f"• new objective: {slack_escape(o['text'])}" for o in obj_added)
        changes.extend(f"• objective completed: {slack_escape(o['text'])}" for o in obj_completed)
        prev_at = prev.get("fetchedAt") or ""
        try:
            prev_label = dt.datetime.fromisoformat(prev_at.replace("Z", "+00:00")).astimezone(TZ).strftime("%b %-d %H:%M")
        except ValueError:
            prev_label = prev_at[:16]
        sec.lines.append(f"*Plan changes since {prev_label}*")
        sec.lines.extend(changes[:25] if changes else ["• none"])
    else:
        sec.lines.append("First run; plan changes appear from the next run.")
    return sec


# ────────────────────────────── slack ──────────────────────────────


def split_chunks(text: str, limit: int = SLACK_SECTION_CHARS) -> List[str]:
    chunks: List[str] = []
    cur = ""
    for line in text.split("\n"):
        if len(line) > limit:
            line = line[: limit - 3] + "..."
        if len(cur) + len(line) + 1 > limit:
            chunks.append(cur)
            cur = line
        else:
            cur = line if not cur else cur + "\n" + line
    if cur:
        chunks.append(cur)
    return chunks


def slack_call(token: str, method: str, payload: Dict[str, Any], attempts: int = 5) -> Dict[str, Any]:
    """POST to Slack; retries transport errors (DNS gone right after wake, 2026-09-07) with a 30s gap."""
    req = urllib.request.Request(
        f"https://slack.com/api/{method}",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json; charset=utf-8"},
        method="POST",
    )
    last: Optional[Exception] = None
    for attempt in range(attempts):
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                body = json.loads(resp.read().decode("utf-8"))
            break
        except (urllib.error.URLError, OSError) as exc:
            last = exc
            if attempt + 1 < attempts:
                time.sleep(30)
    else:
        raise RuntimeError(f"Slack {method}: no answer after {attempts} attempts: {last}")
    if not body.get("ok"):
        raise RuntimeError(f"Slack {method}: {body.get('error')} {body.get('response_metadata', '')}")
    return body


def mrkdwn_blocks(text: str, header: Optional[str] = None) -> List[Dict[str, Any]]:
    blocks: List[Dict[str, Any]] = []
    if header:
        blocks.append({"type": "header", "text": {"type": "plain_text", "text": header[:150]}})
    for chunk in split_chunks(text):
        blocks.append({"type": "section", "text": {"type": "mrkdwn", "text": chunk}})
    return blocks[:50]


def slack_post_thread(token: str, channel: str, header: str, parent: str, replies: List[str]) -> Dict[str, Any]:
    """Parent post with the headlines, one thread reply per detail section."""
    root = slack_call(
        token,
        "chat.postMessage",
        {"channel": channel, "text": header, "blocks": mrkdwn_blocks(parent, header), "unfurl_links": False, "unfurl_media": False},
    )
    reply_ts: List[str] = []
    for text in replies:
        res = slack_call(
            token,
            "chat.postMessage",
            {
                "channel": root["channel"],
                "thread_ts": root["ts"],
                "text": text.split("\n", 1)[0][:200],
                "blocks": mrkdwn_blocks(text),
                "unfurl_links": False,
                "unfurl_media": False,
            },
        )
        reply_ts.append(res["ts"])
    return {"ts": root["ts"], "channel": root["channel"], "replies": reply_ts}


# ────────────────────────────── main ──────────────────────────────


def parse_args(argv: List[str]) -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--no-repo", action="store_true", help="skip section 1 (no access to the checkout)")
    p.add_argument("--dry-run", action="store_true", help="build and print the message, do not post, do not touch state")
    p.add_argument("--force", action="store_true", help="post even when state/last_run.json already has today's date")
    p.add_argument("--since", help="ISO timestamp overriding the previous-run marker")
    p.add_argument("--today", type=dt.date.fromisoformat, help="override the local date (YYYY-MM-DD)")
    p.add_argument("--channel", default=SLACK_CHANNEL)
    return p.parse_args(argv)


def main(argv: Optional[List[str]] = None) -> int:
    global STATE, REPORTS
    args = parse_args(argv if argv is not None else sys.argv[1:])
    if not args.dry_run:
        if not os.environ.get("SLACK_BOT_TOKEN") or not args.channel:
            print("Posting disabled: set SLACK_BOT_TOKEN and SLACK_CHANNEL (or --channel).", file=sys.stderr)
            return 2
        return run_recap(args)

    import shutil
    import tempfile

    original_state, original_reports = STATE, REPORTS
    with tempfile.TemporaryDirectory(prefix="daily-recap-preview-") as temporary:
        STATE, REPORTS = Path(temporary) / "state", Path(temporary) / "reports"
        try:
            STATE.mkdir()
            for name in ("last_run.json", "features.json", "sunsama_prev.json", "tokscale-graph.cache.json"):
                source = original_state / name
                if source.is_file():
                    shutil.copyfile(source, STATE / name)
            return run_recap(args)
        finally:
            STATE, REPORTS = original_state, original_reports


def run_recap(args: argparse.Namespace) -> int:
    started = now_local()
    # A run between midnight and 06:00 is a late run of the previous day (the machine slept through
    # 21:00 and launchd fired on wake, 2026-09-07); the 21:00 schedule never runs in that window.
    today = args.today or (started.date() - dt.timedelta(days=1) if started.hour < 6 else started.date())
    for d in (STATE, REPORTS):
        d.mkdir(parents=True, exist_ok=True)
    run_dir = REPORTS / f"{today.isoformat()}-run"
    run_dir.mkdir(parents=True, exist_ok=True)

    last_run = read_json(STATE / "last_run.json", {})
    # Two triggers exist (launchd 21:00, the session heartbeat 21:05); whichever runs first posts.
    if not args.dry_run and not args.force and last_run.get("date") == today.isoformat():
        print(json.dumps({"ok": True, "skipped": "already posted today", "ts": last_run.get("ts")}))
        return 0
    # A trigger replayed hours late (the heartbeat turn dropped by sleep on 2026-09-10 arrived at
    # 12:25 the next day) must not post a half-day recap. Posting is allowed from 20:30 to 05:59 only.
    daytime = 6 <= started.hour < 20 or (started.hour == 20 and started.minute < 30)
    if not args.dry_run and not args.force and args.today is None and daytime:
        print(json.dumps({"ok": True, "skipped": f"outside the posting window at {started:%H:%M}; next post at 21:00"}))
        return 0
    if args.since:
        since = dt.datetime.fromisoformat(args.since)
    elif last_run.get("at"):
        since = dt.datetime.fromisoformat(last_run["at"])
    else:
        since = started - dt.timedelta(hours=24)
    if since.tzinfo is None:
        since = since.replace(tzinfo=TZ)
    until = started

    sections: List[SectionResult] = []
    names = ["Product", "Personal", "Sunsama"]
    for builder in (
        lambda: section_product(since, until, args.no_repo, run_dir),
        lambda: section_personal(today),
        lambda: section_sunsama(today),
    ):
        try:
            sections.append(builder())
        except Exception as exc:  # noqa: BLE001 — a failed section is a line in the message
            sec = SectionResult(names[len(sections)])
            sec.error = f"{type(exc).__name__}: {exc}"
            (run_dir / f"error-{len(sections) + 1}.txt").write_text(traceback.format_exc(), encoding="utf-8")
            sections.append(sec)

    header = f"Daily recap, {today:%a %b %-d}"
    product, personal, sunsama = sections
    parent_lines = [product.summary_text()]
    status = " · ".join(s for s in (personal.summary_text(), sunsama.summary_text()) if s)
    if status:
        parent_lines.append(status)
    parent_lines.append("Full context in the thread.")
    parent = "\n".join(parent_lines)
    replies = [s.detail_text() for s in sections]
    footer = f"generated {started:%H:%M %Z}, window since {since.astimezone(TZ):%b %-d %H:%M}, report {REPORTS.name}/{today.isoformat()}.md"
    replies[-1] = replies[-1] + "\n" + footer
    report = "# " + header + "\n\n" + parent + "\n\n## Thread\n\n" + "\n\n---\n\n".join(replies) + "\n"
    # a dry run must not overwrite the report of a real post (it did to 2026-09-07.md)
    report_path = run_dir / "dry-run.md" if args.dry_run else REPORTS / f"{today.isoformat()}.md"
    report_path.write_text(report, encoding="utf-8")

    if args.dry_run:
        print(report)
        return 0

    token = os.environ.get("SLACK_BOT_TOKEN")
    try:
        result = slack_post_thread(token, args.channel, header, parent, replies)
    except Exception as exc:
        print(f"Slack post failed ({type(exc).__name__}): {exc}", file=sys.stderr)
        return 1
    write_json(
        STATE / "last_run.json",
        {"at": until.isoformat(), "ts": result["ts"], "channel": result["channel"], "replies": result["replies"], "date": today.isoformat()},
    )
    print(json.dumps({"ok": True, **result}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
