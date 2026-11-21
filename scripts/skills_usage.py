"""Count real skill use in the agent session stores of the box it runs on, for the skills health check.

A use is a tool call that reads a skill's SKILL.md, calls a skill's Python module (`board.get(`, `await edit(`), runs a skill's CLI as the
first word of a shell command, or invokes Claude Code's Skill tool. A skill listed in a system prompt does not count, since only the
arguments of tool calls are read. Each use counts once per (session, skill, how, turn).

Stores: pi-host durable threads (SQLite), Prime and Pi session JSONL, Claude Code projects and Codex sessions, each from files changed in
the last 30 days. Results per file are cached under ~/.cache/skills-health/ by inode, size and offset (JSONL) or last entry id (SQLite),
so a rerun reads only what was appended since.

Pure stdlib and Python 3.9 compatible, since scripts/skills-inventory.py pipes it to `ssh mac python3 -`. Importing it has no side effects.
"""

import argparse
import bisect
import datetime
import io
import json
import os
import re
import socket
import sqlite3
import sys
import time
import tokenize

DAY_MS = 86400000
# Bump when the matcher or an event changes shape, so old cached events are dropped.
CACHE_VERSION = 6
HOW_READ = "read SKILL.md"
HOW_PY = "python call"
HOW_CLI = "cli"
HOW_TOOL = "skill tool"

# Prime's bundled Python skills and their imports, used when no skill folder on the box names them.
DEFAULT_IMPORTS = {
    "aside_browser": "aside-browser", "board": "board", "wiki": "wiki", "websearch": "websearch", "edit": "edit", "goal": "goal",
    "refine": "refine", "attach_image": "attach-image", "agent_observe": "agent-observe", "compact": "compact",
    "agent_message": "agent-message", "rlm_heartbeat": "rlm-heartbeat", "linear_ticket": "linear-ticket", "mcp": "mcp",
}
SKILL_MD = re.compile(r"skills/(?:[\w.-]+/)*?([A-Za-z0-9][\w.-]*)/SKILL\.md")
READ_SKILL = re.compile(r"read-skill\.mjs\s+['\"]?([\w./-]+)")
BASH_CALL = re.compile(r"""\bbash\(\s*[rRfFbBuU]{0,2}('''|\"\"\"|'|")(.*?)\1""", re.S)
SEGMENT_SPLIT = re.compile(r"\n|;|&&|\|\||\||\$\(|`|\(|\)")
WRAPPERS = {"sudo", "env", "nice", "ionice", "time", "command", "exec", "nohup", "stdbuf", "uv", "run", "uvx", "heavy", "timeout"}
ASSIGN = re.compile(r"^[A-Za-z_]\w*=")
STRING_LITERAL = re.compile(r"(\"\"\"|\'\'\')[\s\S]*?\1|\"(?:\\.|[^\"\\\n])*\"|\'(?:\\.|[^\'\\\n])*\'")
USER_KEY = b'"role":"user"'
TOOLCALL_KEY = b'"type":"toolCall"'
TRANSCRIPT_NAME = re.compile(r"^(?:[^_/]+_)?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$")


def home():
    return os.path.expanduser("~")


def skill_roots():
    h = home()
    roots = [os.path.join(h, "src", "sieun-pi", "skills"), os.path.join(h, "Documents", "Github", "sieun-pi", "skills"),
             os.path.join(h, ".prime", "agent", "skills"), os.path.join(h, ".claude", "skills"), os.path.join(h, ".codex", "skills"),
             os.path.join(h, ".agents", "skills")]
    releases = os.path.join(h, ".local", "share", "prime-agent", "releases")
    if os.path.isdir(releases):
        roots += sorted(os.path.join(releases, name, "skills") for name in os.listdir(releases))
    return [root for root in roots if os.path.isdir(root)]


def skill_index():
    """Every skill name found on the box, the Python import of each Python skill, and the shell words that run a skill's CLI."""
    names, imports = set(), dict(DEFAULT_IMPORTS)
    for root in skill_roots():
        for name in os.listdir(root):
            folder = os.path.join(root, name)
            if not os.path.isfile(os.path.join(folder, "SKILL.md")):
                continue
            names.add(name)
            src = os.path.join(folder, "src")
            if os.path.isdir(src):
                for package in os.listdir(src):
                    if os.path.isfile(os.path.join(src, package, "__init__.py")):
                        imports[package] = name
    names.update(imports.values())
    cli = {}
    for module, name in imports.items():
        cli[module] = name
        cli[name] = name
    return sorted(names), imports, cli


OPEN_OPS = re.compile(r"open\(|read_text\(|read_bytes\(|\bread\(|\bcat\s|\bhead\s|\btail\s|sed\s+-n|\bnl\s|\bless\s|\bbat\s|\brg\s|\bgrep\s|"
                      r"\bawk\s|\bjq\s|read-skill\.mjs|\bwiki\.read|\bPath\(|print\(.*SKILL\.md|\b\w{1,6}\(\s*f?['\"][^'\"\n]*SKILL\.md['\"]")
NOT_OPEN = re.compile(r"\bgit\s+(-C\s+\S+\s+)?(log|show|diff|add|commit|status|blame|rev-list|ls-files|mv|rm|checkout|restore|grep|cat-file)\b|"
                      r"\bls\s|\bstat\s|\bwc\s|\bfind\s|\btest\s+-[ef]|\[\s*-[ef]\s|\bcp\s|\bmv\s|\brm\s|\bln\s|sed\s+-i|\bdiff\s|\bsha256sum\s|"
                      r"\bmd5sum\s|os\.path\.(exists|getsize|getmtime|isfile|islink|realpath)|\.exists\(\)|\.stat\(\)|\.is_file\(\)|readlink")
WRITE_OPS = re.compile(r"write_text\(|open\([^)]*['\"][wa]\+?['\"]|\bedit\(|>\s*\S*SKILL\.md|\btee\s|apply_patch")
# A string longer than this that names the path is a brief or message for another session, not a read: the hand rule in
# ~/work/skills-tab/skills-use/count.py (`open_kind`), checked against 18,816 pi-host tool calls on 11-21.
BRIEF_CHARS = 400


def opened(text, name):
    """Whether code or a shell command opened the skill's SKILL.md, also through a list, a variable or a helper such as rd('...')."""
    needles = [m.group(0) for m in SKILL_MD.finditer(text) if m.group(1) == name]
    if not needles:
        return False
    bare = text
    for lit in STRING_LITERAL.finditer(text):
        if len(lit.group(0)) > BRIEF_CHARS and any(n in lit.group(0) for n in needles):
            bare = bare.replace(lit.group(0), '""')
    if not any(n in bare for n in needles):
        return False
    if WRITE_OPS.search(bare) and not OPEN_OPS.search(bare):
        return False
    if not OPEN_OPS.search(bare):
        return False
    lines = [line for line in bare.splitlines() if any(n in line for n in needles)]
    return not all(NOT_OPEN.search(line) and not OPEN_OPS.search(line) for line in lines)


class Matcher:
    """Finds skill uses in one tool call's name and arguments."""

    def __init__(self, imports, cli):
        self.cli = cli
        alternatives = "|".join(sorted((re.escape(m) for m in imports), key=len, reverse=True))
        self.imports = imports
        self.py_call = re.compile(r"(?<![\w.])(" + alternatives + r")(?:\.[A-Za-z_]\w*)?\s*\(")
        words = "|".join(sorted((re.escape(w) for w in cli), key=len, reverse=True))
        # A cheap byte filter: the text a use leaves in a raw transcript line or SQLite record.
        self.prefilter = re.compile(
            (r"SKILL\.md|read-skill\.mjs|(?<![\w.])(?:" + alternatives + r")(?:\.\w+)?\s*\(|(?:(?<![\w./-])|(?<=\\n))(?:" + words + r")\s").encode())
        self.like_terms = ["SKILL.md"] + sorted(imports) + sorted(set(cli) - set(imports))
        self.key = sorted(cli.items())

    def skill_reads(self, text):
        return {m.group(1) for m in SKILL_MD.finditer(text) if "<" not in m.group(1)}

    def shell(self, text, out):
        if "SKILL.md" in text:
            for name in self.skill_reads(text):
                if opened(text, name):
                    out.add((name, HOW_READ))
        for m in READ_SKILL.finditer(text):
            parts = [part for part in m.group(1).split("/") if part and part != "SKILL.md"]
            if parts:
                out.add((parts[-1], HOW_READ))
        for segment in SEGMENT_SPLIT.split(text):
            words = segment.strip().split()
            while words and (ASSIGN.match(words[0]) or words[0] in WRAPPERS or words[0].startswith("-") or words[0].isdigit()):
                words.pop(0)
            if words:
                first = os.path.basename(words[0].strip("'\""))
                if first in self.cli:
                    out.add((self.cli[first], HOW_CLI))

    def python_calls(self, code, out):
        """Calls of a skill module outside string literals and comments, from Python's own tokenizer."""
        try:
            tokens = [t for t in tokenize.generate_tokens(io.StringIO(code).readline)
                      if t.type in (tokenize.NAME, tokenize.OP)]
        except (tokenize.TokenError, IndentationError, SyntaxError):
            stripped = STRING_LITERAL.sub('""', code)
            for line in stripped.splitlines():
                if not line.lstrip().startswith(("#", "import ", "from ")):
                    for m in self.py_call.finditer(line.split("#")[0]):
                        out.add((self.imports[m.group(1)], HOW_PY))
            return
        words = [t.string for t in tokens]
        for i, word in enumerate(words):
            if word not in self.imports or (i and words[i - 1] in (".", "import", "from", "def", "class", "as")):
                continue
            if words[i + 1:i + 2] == ["("] or (words[i + 1:i + 2] == ["."] and words[i + 3:i + 4] == ["("]):
                out.add((self.imports[word], HOW_PY))

    def python(self, code, out):
        self.python_calls(code, out)
        if "SKILL.md" in code:
            for name in self.skill_reads(code):
                if opened(code, name):
                    out.add((name, HOW_READ))
        for m in BASH_CALL.finditer(code):
            self.shell(m.group(2), out)

    def call(self, tool, args):
        """The (skill, how) pairs one tool call shows."""
        out = set()
        tool_l = (tool or "").lower()
        if isinstance(args, str):
            try:
                args = json.loads(args)
            except ValueError:
                args = {"command": args}
        if not isinstance(args, dict):
            return out
        if tool_l == "skill":
            name = args.get("skill") or args.get("command") or args.get("name")
            if isinstance(name, str) and name.strip():
                out.add((name.strip().lstrip("/").split(":")[-1].split()[0], HOW_TOOL))
            return out
        if tool_l in ("read", "read_file", "view", "grep", "glob"):
            path = args.get("path") or args.get("file_path") or args.get("filePath")
            if isinstance(path, str):
                for name in self.skill_reads(path):
                    out.add((name, HOW_READ))
            return out
        code = args.get("code")
        if isinstance(code, str):
            self.python(code, out)
        command = args.get("command", args.get("cmd"))
        if isinstance(command, list):
            command = command[-1] if command else ""
        if isinstance(command, str) and tool_l not in ("edit", "write", "multiedit", "notebookedit"):
            self.shell(command, out)
        return out


# Events are lists so the cache stays small JSON: [at ms, skill, how, session key, turn key, conversation, entry].


def iso(ms):
    return datetime.datetime.fromtimestamp(ms / 1000, tz=datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_ts(value):
    if isinstance(value, (int, float)):
        return int(value if value > 1e11 else value * 1000)
    if isinstance(value, str) and value:
        try:
            return int(datetime.datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp() * 1000)
        except ValueError:
            return None
    return None


class Cache:
    def __init__(self, box, kind, enabled, key):
        self.key = json.loads(json.dumps([CACHE_VERSION, key]))
        self.path = os.path.join(home(), ".cache", "skills-health", "%s-%s.json" % (box, kind))
        self.enabled = enabled
        self.data = {}
        if enabled and os.path.isfile(self.path):
            try:
                with open(self.path) as handle:
                    raw = json.load(handle)
                if raw.get("version") == self.key:
                    self.data = raw.get("files", {})
            except (OSError, ValueError):
                self.data = {}

    def save(self, files, keep_from):
        if not self.enabled:
            return
        for state in files.values():
            state["events"] = [e for e in state.get("events", []) if e[0] >= keep_from]
        os.makedirs(os.path.dirname(self.path), exist_ok=True)
        tmp = self.path + ".tmp"
        with open(tmp, "w") as handle:
            json.dump({"version": self.key, "files": files}, handle, separators=(",", ":"))
        os.replace(tmp, self.path)


def recent_files(paths, cutoff_s):
    out = []
    for path in paths:
        try:
            st = os.stat(path)
        except OSError:
            continue
        if st.st_mtime >= cutoff_s:
            out.append((path, st))
    return out


# Prime and Pi session JSONL --------------------------------------------------------------------------------------------------------------


def prime_files(cutoff_s):
    base = os.path.join(home(), ".prime", "agent")
    found = []
    for folder in (os.path.join(base, "sessions"), os.path.join(base, "pi-sessions")):
        found += walk_transcripts(folder, cutoff_s, deep=True)
    found += walk_transcripts(os.path.join(base, "session-artifacts"), cutoff_s, deep=True)
    return found


def walk_transcripts(folder, cutoff_s, deep):
    out = []
    stack = [folder]
    while stack:
        current = stack.pop()
        try:
            entries = list(os.scandir(current))
        except OSError:
            continue
        for entry in entries:
            try:
                if entry.is_dir(follow_symlinks=False):
                    if deep:
                        stack.append(entry.path)
                elif TRANSCRIPT_NAME.match(entry.name):
                    st = entry.stat(follow_symlinks=False)
                    if st.st_mtime >= cutoff_s:
                        out.append((entry.path, st))
            except OSError:
                continue
    return out


def scan_jsonl_prime(path, state, matcher):
    """Read a Prime or Pi transcript from the cached offset on, and return the updated state."""
    with open(path, "rb") as handle:
        handle.seek(state["offset"])
        data = handle.read()
    end = data.rfind(b"\n") + 1
    data = data[:end]
    users = []
    pos = data.find(USER_KEY)
    while pos != -1:
        users.append(pos)
        pos = data.find(USER_KEY, pos + 1)
    seen_lines = set()
    for m in re.finditer(rb'"type":"session_info"', data):
        start = data.rfind(b"\n", 0, m.start()) + 1
        line = data[start:data.find(b"\n", m.start())]
        try:
            name = json.loads(line).get("name")
            if isinstance(name, str) and name:
                state["name"] = name
        except ValueError:
            pass
    pos = data.find(TOOLCALL_KEY)
    while pos != -1:
        start = data.rfind(b"\n", 0, pos) + 1
        stop = data.find(b"\n", pos)
        if start not in seen_lines:
            seen_lines.add(start)
            line = data[start:stop]
            if matcher.prefilter.search(line):
                events_from_prime_line(line, state, matcher, state["turn"] + bisect.bisect_left(users, start))
        pos = data.find(TOOLCALL_KEY, stop)
    state["turn"] += len(users)
    state["offset"] += end
    return state


def events_from_prime_line(line, state, matcher, turn):
    try:
        record = json.loads(line)
    except ValueError:
        return
    message = record.get("message") if isinstance(record.get("message"), dict) else record
    if message.get("role") != "assistant" or not isinstance(message.get("content"), list):
        return
    at = parse_ts(record.get("timestamp")) or parse_ts(message.get("timestamp"))
    if at is None:
        return
    for block in message["content"]:
        if isinstance(block, dict) and block.get("type") == "toolCall":
            for skill, how in matcher.call(block.get("name"), block.get("arguments")):
                state["events"].append([at, skill, how, state["sid"], turn, None, record.get("id")])


def scan_prime(box, now_ms, matcher, use_cache, workers):
    cutoff_s = (now_ms - 30 * DAY_MS) / 1000
    cache = Cache(box, "prime", use_cache, matcher.key)
    files = prime_files(cutoff_s)
    todo, states = [], {}
    for path, st in files:
        state = cache.data.get(path)
        if not state or state.get("ino") != st.st_ino or st.st_size < state.get("size", 0):
            state = {"ino": st.st_ino, "size": 0, "offset": 0, "turn": 0, "name": None, "events": [],
                     "sid": TRANSCRIPT_NAME.match(os.path.basename(path)).group(1)}
        states[path] = state
        if st.st_size != state["size"]:
            todo.append((path, state, st.st_size))
    results = run_parallel(scan_prime_one, todo, matcher, workers)
    errors = {}
    for path, state, error in results:
        states[path] = state
        if error:
            errors[path] = error
    cache.save({path: state for path, state in states.items() if path not in errors}, now_ms - 31 * DAY_MS)
    return files, states, errors


def scan_prime_one(item, matcher):
    """Scan one transcript; a read that fails, such as a transcript guard refusal, leaves the file out of the cache and names the error."""
    path, state, size = item
    try:
        state = scan_jsonl_prime(path, state, matcher)
    except OSError as error:
        return path, state, "%s: %s" % (type(error).__name__, str(error)[:200])
    state["size"] = size
    return path, state, None


_WORK = {}


def _work(item):
    return _WORK["fn"](item, _WORK["matcher"])


def run_parallel(fn, items, matcher, workers):
    if workers > 1 and len(items) > 8 and sys.platform.startswith("linux"):
        import multiprocessing
        _WORK.update(fn=fn, matcher=matcher)
        items = sorted(items, key=lambda item: -(item[1].get("size") or 0))
        with multiprocessing.get_context("fork").Pool(workers) as pool:
            return pool.map(_work, items, chunksize=1)
    return [fn(item, matcher) for item in items]


# pi-host durable threads -------------------------------------------------------------------------------------------------------------


def connect_ro(path):
    return sqlite3.connect("file:%s?mode=ro" % path, uri=True, timeout=5)


def scan_pihost(box, now_ms, matcher, use_cache, workers):
    base = os.path.join(home(), ".prime", "agent", "pi-host", "durable")
    folder = os.path.join(base, "threads")
    cache = Cache(box, "pihost", use_cache, matcher.key)
    cutoff_s = (now_ms - 30 * DAY_MS) / 1000
    files = []
    if os.path.isdir(folder):
        for name in sorted(os.listdir(folder)):
            if not name.endswith(".sqlite"):
                continue
            path = os.path.join(folder, name)
            stats = [s for s in (safe_stat(path), safe_stat(path + "-wal")) if s]
            if stats and max(s.st_mtime for s in stats) >= cutoff_s:
                files.append((path, stats[0], max(s.st_mtime for s in stats), sum(s.st_size for s in stats)))
    states, todo = {}, []
    for path, st, mtime, _size in files:
        state = cache.data.get(path) or {"maxId": 0, "mtime": 0, "events": []}
        states[path] = state
        if state["mtime"] != mtime:
            state["mtime"] = mtime
            todo.append((path, state))
    for path, state in run_parallel(scan_pihost_one, todo, matcher, workers):
        states[path] = state
    names = thread_names(os.path.join(base, "index.sqlite"))
    cache.save(states, now_ms - 31 * DAY_MS)
    return [(p, s, size) for p, s, _m, size in files], states, names


def safe_stat(path):
    try:
        return os.stat(path)
    except OSError:
        return None


def scan_pihost_one(item, matcher):
    path, state = item
    thread = os.path.basename(path)[: -len(".sqlite")]
    like = " OR ".join("record LIKE ?" for _ in matcher.like_terms)
    sql = ("SELECT id, conversation_id, record FROM entries WHERE id > ? AND record LIKE '%\"toolCall\"%' AND (" + like + ") ORDER BY id")
    try:
        db = connect_ro(path)
        try:
            top = db.execute("SELECT max(id) FROM entries").fetchone()[0] or 0
            rows = db.execute(sql, [state["maxId"]] + ["%" + term + "%" for term in matcher.like_terms]).fetchall()
        finally:
            db.close()
    except sqlite3.Error as error:
        state["error"] = str(error)
        return path, state
    for entry_id, conversation, raw in rows:
        if not matcher.prefilter.search(raw.encode("utf-8", "replace")):
            continue
        try:
            record = json.loads(raw)
        except ValueError:
            continue
        turn = record.get("byTaskId", entry_id)
        for message in record.get("model") or []:
            if not isinstance(message, dict) or message.get("role") != "assistant":
                continue
            at = parse_ts(message.get("timestamp"))
            if at is None:
                continue
            for block in message.get("content") or []:
                if isinstance(block, dict) and block.get("type") == "toolCall":
                    for skill, how in matcher.call(block.get("name"), block.get("arguments")):
                        state["events"].append([at, skill, how, "%s:%s" % (thread, conversation), turn, conversation, entry_id])
    state["maxId"] = max(state["maxId"], top)
    state.pop("error", None)
    return path, state


def thread_names(index_path):
    try:
        db = connect_ro(index_path)
        try:
            return {row[0]: row[1] for row in db.execute("SELECT id, name FROM threads")}
        finally:
            db.close()
    except sqlite3.Error:
        return {}


def conversation_names(path):
    """Each conversation's own child name and its owner conversation, for agent labels and exclusions."""
    names, owners = {}, {}
    try:
        db = connect_ro(path)
        try:
            for cid, owner in db.execute("SELECT id, owner_conversation_id FROM conversations"):
                owners[cid] = owner
            rows = db.execute(
                "SELECT d.owner_id, r.content FROM documents d JOIN document_revisions r ON r.document_id = d.id "
                "WHERE d.kind = '\"rlm.child\"' AND d.scope_kind = 'conversation' ORDER BY r.seq")
            for owner_id, content in rows:
                try:
                    name = json.loads(content).get("name")
                except (ValueError, AttributeError):
                    continue
                if isinstance(name, str) and name:
                    names[owner_id] = name
        finally:
            db.close()
    except sqlite3.Error:
        pass
    return names, owners


# Claude Code and Codex ----------------------------------------------------------------------------------------------------------------


def walk_jsonl(folder, cutoff_s):
    out = []
    for top, _dirs, names in os.walk(folder):
        for name in names:
            if name.endswith(".jsonl"):
                path = os.path.join(top, name)
                st = safe_stat(path)
                if st and st.st_mtime >= cutoff_s:
                    out.append((path, st))
    return out


def scan_claude_file(path, matcher):
    events, turn, sid = [], 0, os.path.basename(path)[:-6]
    project = os.path.basename(os.path.dirname(path))
    with open(path, "rb") as handle:
        for raw in handle:
            if b'"type":"user"' in raw[:400] or b'"type": "user"' in raw[:400]:
                try:
                    record = json.loads(raw)
                except ValueError:
                    continue
                content = (record.get("message") or {}).get("content")
                if isinstance(content, str) or (isinstance(content, list) and any(
                        isinstance(b, dict) and b.get("type") == "text" for b in content)):
                    turn += 1
                continue
            if b"tool_use" not in raw:
                continue
            try:
                record = json.loads(raw)
            except ValueError:
                continue
            message = record.get("message")
            if record.get("type") != "assistant" or not isinstance(message, dict):
                continue
            sid = record.get("sessionId") or sid
            at = parse_ts(record.get("timestamp"))
            for block in message.get("content") or []:
                if isinstance(block, dict) and block.get("type") == "tool_use" and at:
                    for skill, how in matcher.call(block.get("name"), block.get("input")):
                        events.append([at, skill, how, sid, turn, None, record.get("uuid"), project])
    return events


def scan_codex_file(path, matcher):
    events, turn, sid, cwd = [], None, None, None
    with open(path, "rb") as handle:
        for raw in handle:
            if b'"session_meta"' in raw[:200] or b'"turn_context"' in raw[:200] or b'"function_call"' in raw or b'"custom_tool_call"' in raw:
                try:
                    record = json.loads(raw)
                except ValueError:
                    continue
                payload = record.get("payload") or {}
                if record.get("type") == "session_meta":
                    sid = payload.get("id") or sid
                    cwd = payload.get("cwd") or cwd
                elif record.get("type") == "turn_context":
                    turn = payload.get("turn_id") or turn
                elif payload.get("type") in ("function_call", "custom_tool_call"):
                    at = parse_ts(record.get("timestamp"))
                    args = payload.get("arguments", payload.get("input"))
                    if at:
                        for skill, how in matcher.call(payload.get("name"), args):
                            events.append([at, skill, how, sid or os.path.basename(path), turn, None, payload.get("call_id"), cwd])
    return events


def scan_small(box, kind, folder, now_ms, matcher, use_cache, fn):
    cutoff_s = (now_ms - 30 * DAY_MS) / 1000
    cache = Cache(box, kind, use_cache, matcher.key)
    files = walk_jsonl(folder, cutoff_s) if os.path.isdir(folder) else []
    states = {}
    for path, st in files:
        state = cache.data.get(path)
        if not state or state.get("mtime") != st.st_mtime or state.get("size") != st.st_size:
            try:
                state = {"mtime": st.st_mtime, "size": st.st_size, "events": fn(path, matcher)}
            except OSError:
                state = {"mtime": st.st_mtime, "size": st.st_size, "events": []}
        states[path] = state
    cache.save(states, now_ms - 31 * DAY_MS)
    return files, states



# Thread kinds -------------------------------------------------------------------------------------------------------------------------

UUID_PART = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
DUTY_NAME = re.compile(r"\d\d:\d\d$")


def load_json(path, default):
    try:
        with open(path) as handle:
            return json.load(handle)
    except (OSError, ValueError):
        return default


class Kinds:
    """The thread kind of a use, from the browser chat's chat lists (Prime) and sw factory's agents and threads (pi-host), as count.py does."""

    def __init__(self):
        chat = os.path.join(home(), ".prime", "agent", "browser-chat")
        self.chats = set()
        for name in ("chats.json", "archived-chats.json", "threads.json"):
            raw = load_json(os.path.join(chat, name), {})
            self.chats |= set(raw.get("ids", [])) if isinstance(raw, dict) else set()
        self.jobs = (load_json(os.path.join(chat, "chat-jobs.json"), {}) or {}).get("jobs", {})
        store = os.path.join(home(), ".pi", "agent", "chat")
        agents = (load_json(os.path.join(store, "agents.json"), {}) or {}).get("agents", [])
        self.roles = {}
        for agent in agents:
            if agent.get("workThread"):
                self.roles[agent["workThread"]] = "work"
            for thread in (agent.get("comm") or {}).values():
                self.roles[thread] = "comm"
        for thread in ((load_json(os.path.join(store, "state.json"), {}) or {}).get("threads") or {}):
            self.roles.setdefault(thread, "job")

    def prime(self, path, names):
        """A Prime transcript's kind from its root session and its depth under session-artifacts."""
        parts = path.split("/.prime/agent/", 1)[-1].split("/")
        depth, root = 0, TRANSCRIPT_NAME.match(os.path.basename(path)).group(1)
        marks = [i for i, part in enumerate(parts) if part == "session-artifacts" and i + 1 < len(parts) and UUID_PART.match(parts[i + 1])]
        if parts[0] not in ("sessions", "pi-sessions") and marks:
            root = parts[marks[-1] + 1]
            depth = sum(1 for part in parts[marks[-1] + 2:] if part.startswith("sub-"))
        name = names.get(root) or ""
        if root in self.chats:
            return "prime-chat" if depth == 0 else "prime-job" if depth == 1 else "prime-subagent"
        if DUTY_NAME.search(name.strip()):
            return "prime-duty"
        return "prime-job" if depth == 0 else "prime-subagent"

    def pihost(self, thread, conversation, owners, name):
        depth, current = 0, conversation
        while owners.get(current) is not None and depth < 50:
            current, depth = owners[current], depth + 1
        role = self.roles.get(thread)
        if " duty " in (name or "") and role in (None, "job"):
            return "sw-duty" if depth == 0 else "sw-subagent"
        if role == "comm":
            return "sw-comm" if depth == 0 else "sw-job"
        if role == "work":
            return "sw-work" if depth == 0 else "sw-job" if depth == 1 else "sw-subagent"
        return "sw-job" if depth == 0 else "sw-subagent"


# Assembly ----------------------------------------------------------------------------------------------------------------------------


def count_usage(now, box, prime=True, use_cache=True, workers=None, exclude_agents=("skills health",)):
    """Scan this box's session stores and return per-skill use counts for the 30 days before `now`."""
    if now.tzinfo is None:
        now = now.replace(tzinfo=datetime.timezone.utc)
    now_ms = int(now.timestamp() * 1000)
    workers = workers or min(16, os.cpu_count() or 1)
    names, imports, cli = skill_index()
    matcher = Matcher(imports, cli)
    stores, events = [], []
    kinds = Kinds()

    started = time.time()
    files, states, threads = scan_pihost(box, now_ms, matcher, use_cache, workers)
    labels = {}
    for path, state in states.items():
        if not state["events"]:
            continue
        thread = os.path.basename(path)[: -len(".sqlite")]
        child_names, owners = conversation_names(path)
        for event in state["events"]:
            conversation = event[5]
            key = (thread, conversation)
            if key not in labels:
                chain, current, guard = [], conversation, 0
                while current is not None and guard < 50:
                    if current in child_names:
                        chain.append(child_names[current])
                    current, guard = owners.get(current), guard + 1
                excluded = any(name in exclude_agents for name in chain)
                own = child_names.get(conversation)
                label = threads.get(thread) or thread
                labels[key] = None if excluded else (label + " / " + own if own else label)
            if (thread, conversation) in labels and labels[key] is not None:
                events.append(("pi-host", thread, event, labels[key], kinds.pihost(thread, conversation, owners, threads.get(thread))))
    stores.append({"path": os.path.join(home(), ".prime/agent/pi-host/durable/threads"), "kind": "pi-host", "files": len(files),
                   "bytes": sum(size for _p, _s, size in files), "seconds": round(time.time() - started, 2)})

    if prime:
        started = time.time()
        files, states, errors = scan_prime(box, now_ms, matcher, use_cache, workers)
        roots = {state["sid"]: state.get("name") for state in states.values()}
        for path, state in states.items():
            kind = kinds.prime(path, roots)
            for event in state["events"]:
                events.append(("prime", event[3], event, state.get("name"), kind))
        stores.append({"path": os.path.join(home(), ".prime/agent/{sessions,pi-sessions,session-artifacts}"), "kind": "prime",
                       "files": len(files), "bytes": sum(st.st_size for _p, st in files), "seconds": round(time.time() - started, 2),
                       "unreadFiles": len(errors), "firstError": next(iter(errors.values()), None)})

    for kind, folder, fn in (("claude", os.path.join(home(), ".claude", "projects"), scan_claude_file),
                             ("codex", os.path.join(home(), ".codex", "sessions"), scan_codex_file)):
        started = time.time()
        files, states = scan_small(box, kind, folder, now_ms, matcher, use_cache, fn)
        for state in states.values():
            for event in state["events"]:
                events.append((kind, event[3], event, event[7] if len(event) > 7 else None, kind))
        stores.append({"path": folder, "kind": kind, "files": len(files), "bytes": sum(st.st_size for _p, st in files),
                       "seconds": round(time.time() - started, 2)})

    return {"box": box, "scannedAt": iso(now_ms), "stores": stores, "skills": aggregate(events, names, now_ms, box)}


def aggregate(events, names, now_ms, box):
    since30, since7 = now_ms - 30 * DAY_MS, now_ms - 7 * DAY_MS
    first = {}
    cli = {}
    for runtime, session, event, agent, kind in events:
        at, skill, how, session_key, turn = event[0], event[1], event[2], event[3], event[4]
        if at < since30 or at > now_ms + DAY_MS:
            continue
        if how == HOW_CLI:
            cli[skill] = cli.get(skill, 0) + 1
            continue
        key = (runtime, session_key, turn, skill, how)
        if key not in first or at < first[key][0]:
            first[key] = (at, runtime, session, event, agent, kind)
    empty = lambda: {"uses7d": 0, "uses30d": 0, "sessions7d": 0, "sessions30d": 0, "agents": [], "uses": [], "byKind": {}, "lastUse": None,
                     "cliUnverified": 0}
    skills = {name: empty() for name in names}
    sessions = {}
    for (runtime, session_key, _turn, skill, how), (at, _r, session, event, agent, kind) in first.items():
        entry = skills.setdefault(skill, empty())
        per = sessions.setdefault(skill, {"s7": set(), "s30": set(), "agents": set(), "uses": [], "kinds": {}})
        entry["uses30d"] += 1
        per["s30"].add((runtime, session_key))
        tally = per["kinds"].setdefault(kind, [0, set()])
        tally[0] += 1
        tally[1].add((runtime, session_key))
        if entry["lastUse"] is None or iso(at) > entry["lastUse"]:
            entry["lastUse"] = iso(at)
        if at >= since7:
            entry["uses7d"] += 1
            per["s7"].add((runtime, session_key))
        if agent:
            per["agents"].add(agent)
        use = {"at": iso(at), "session": session, "agent": agent, "how": how, "runtime": runtime, "box": box}
        if runtime == "pi-host":
            use["conversation"] = event[5]
            use["entry"] = event[6]
        elif event[6] is not None:
            use["entry"] = event[6]
        per["uses"].append((at, use))
    for skill, per in sessions.items():
        entry = skills[skill]
        entry["sessions7d"], entry["sessions30d"] = len(per["s7"]), len(per["s30"])
        entry["agents"] = sorted(per["agents"])
        entry["uses"] = [use for _at, use in sorted(per["uses"], key=lambda pair: -pair[0])[:10]]
        entry["byKind"] = {kind: {"uses": n, "sessions": len(seen)} for kind, (n, seen) in sorted(per["kinds"].items())}
    for skill, n in cli.items():
        skills.setdefault(skill, empty())["cliUnverified"] = n
    return dict(sorted(skills.items(), key=lambda pair: (-pair[1]["uses30d"], pair[0])))


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--box", default=socket.gethostname().split(".")[0])
    parser.add_argument("--no-prime", action="store_true", help="skip Prime and Pi session JSONL")
    parser.add_argument("--no-cache", action="store_true", help="ignore and do not write ~/.cache/skills-health")
    parser.add_argument("--workers", type=int, default=0)
    parser.add_argument("--now", help="ISO time to count back from (default: now)")
    args = parser.parse_args(argv)
    now = datetime.datetime.fromisoformat(args.now.replace("Z", "+00:00")) if args.now else datetime.datetime.now(datetime.timezone.utc)
    result = count_usage(now, args.box, prime=not args.no_prime, use_cache=not args.no_cache, workers=args.workers or None)
    json.dump(result, sys.stdout, indent=1)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
