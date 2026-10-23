"""Refuses this session's reads of another chat's session transcripts, in the Prime kernel and the Python processes it starts.

On 2026-10-19 the runtime intent trace job and on 2026-10-20 from 15:59Z to 16:10Z p8-prepare-hold, both jobs of chat-057a, opened the
session transcripts of unrelated roots under ~/.prime/agent/sessions to read their state lines, and each time a later scope reminder in its
brief came too late. A scan of the 7 days to 10-20 16:43Z on both boxes (~/work/observation-boundary/evidence-7d.md) found 1636 reads of
another chat's transcript and 2313 scans of whole transcript folders. agent_observe already limits observation to the family, but a cell
could still open the files. So a session reads only its own chat's transcripts: the chat's root tree (the chat, its jobs and their
subagents) and the trees of the root jobs the chat started, which chat-jobs.json records. The same scan found 1773 reads by check-in, alert
and root jobs of their own chat's conversation in another root, as their briefs tell them to, and those stay open. Any other
`<session id>.jsonl` under the Prime agent dir (sessions/, session-artifacts/ and their copies), or in the chat service's copy of another
host's files under ~/.cache/sieun-pi/hosts, raises TranscriptRefused, which names the
catalog, status and relay paths that stay open.

1. open(), io.open(), os.open() and Path.read_text() of such a file from cell code, or from code that is not a sieun-pi, skill or Prime tool.
2. A command the kernel starts (bash(), subprocess, os.system) that names such a file, or that reads a folder holding one as a whole
   (rg, grep -r, find ... -exec or | xargs a reader, cp -r, rsync, tar).
3. The `read`, `grep` and `bash` tools, through `--judge` (transcript-guard.ts).
4. A systemd-run unit the kernel starts: its command is judged as in 2, and install() puts unit-env/ first on PATH, whose systemd-run passes
   RLM_SESSION_DIR, PYTHONPATH and the guard's other variables to the unit with -E, so a Python the unit runs loads this file like a direct
   child. On 10-20 at 21:19Z a subagent of 'd5 cache reads' ran a scan script that way and read other chats' transcripts.

Code in a sieun-pi tree, a skill folder or the Prime release passes, so the board module, agent_observe, resume_paused.py and the d7, d9
and d10 prechecks still read what they read. Listing a folder (ls, find without a reader, os.listdir) and counting lines (wc) pass too,
since they show catalog metadata and no content. With no RLM_SESSION_DIR below session-artifacts (CI, a person's shell) nothing is judged.
Each refusal is one JSON line in ~/.prime/agent/logs/transcript-refusals.jsonl.
"""

import builtins
import glob
import io
import json
import os
import re
import shlex
import subprocess
import sys
import sysconfig
import time

HERE = os.path.dirname(os.path.realpath(__file__))
THIS = os.path.realpath(__file__)
HOME = os.path.expanduser("~")
PRIME = os.path.realpath(os.path.expanduser(os.environ.get("PRIME_AGENT_CODING_AGENT_DIR") or os.environ.get("PI_CODING_AGENT_DIR")
                                            or os.path.join(HOME, ".prime", "agent")))
SESSIONS = os.path.join(PRIME, "sessions")
ARTIFACTS = os.path.join(PRIME, "session-artifacts")
LOG = os.environ.get("GLOBAL_RULES_TRANSCRIPT_LOG") or os.path.join(PRIME, "logs", "transcript-refusals.jsonl")
# A clean-room run keeps the transcripts of its own test chats here, which its evaluator reads.
CLEAN_ROOM = os.path.join(PRIME, "clean-room")
# The chat service keeps a copy of each other host's session files at <this>/<host>/<path on that host> (user-history host-catalogs.ts
# MIRROR_DIR). On 10-23 at about 13:20Z the job 'd9 stuck steps job liveness 10-23' read two other chats' transcripts through the Mac's copy
# here, after the guard had refused the same read under sessions/, so a transcript in a host's copy is judged like one under PRIME.
MIRRORS = os.path.realpath(os.path.join(HOME, ".cache", "sieun-pi", "hosts"))
TRANSCRIPT = re.compile(r"^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$")
SUB = re.compile(r"^sub-[0-9a-f]+$")
UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
KERNEL = os.getpid()
STDLIB = tuple(os.path.realpath(p) + os.sep for p in {sysconfig.get_paths().get("stdlib", ""), sysconfig.get_paths().get("platstdlib", "")} if p)
# The tools whose reads stand for the catalog and the duty prechecks: this sieun-pi tree, the chat release and the runtime copy, the
# skill folders, and the Prime release with its skills. The kernel's own rlm package passes for open() only, since its bash() runs cells' commands.
TOOLS = tuple(os.path.realpath(p) + os.sep for p in (
    os.path.dirname(os.path.dirname(HERE)), os.path.join(HOME, ".local", "share", "sieun-pi-chat"),
    os.path.join(HOME, ".local", "share", "sieun-pi-runtime"), os.path.join(PRIME, "skills"), os.path.join(HOME, ".local", "share", "prime-agent"),
))
RLM = tuple(os.path.dirname(os.path.realpath(m.__file__)) + os.sep for m in [sys.modules.get("rlm")] if getattr(m, "__file__", None))
READERS = {"cat", "tac", "head", "tail", "less", "more", "bat", "nl", "grep", "egrep", "fgrep", "zgrep", "rg", "ag", "ack", "jq", "yq",
           "awk", "gawk", "mawk", "sed", "cut", "sort", "uniq", "strings", "xxd", "od", "hexdump", "base64", "diff", "cmp", "comm", "paste",
           "cp", "rsync", "scp", "tar", "zip", "gzip", "zstd", "dd", "tee", "python", "python3", "node", "perl", "ruby", "bun", "deno", "duckdb", "sqlite3"}
WHOLE = {"rg", "ag", "ack", "rsync", "tar", "zip"}
RECURSE = {"grep", "egrep", "fgrep", "zgrep", "cp", "scp"}
# Commands that show a file's name, size or line count and never its content.
METADATA = {"ls", "stat", "du", "wc", "file", "test", "[", "realpath", "readlink", "basename", "dirname", "echo", "printf", "touch", "mkdir", "find", "fd"}
SHELLS = {"sh", "bash", "dash", "zsh"}
WRAPPERS = {"sudo", "env", "nice", "ionice", "timeout", "command", "exec", "time", "nohup", "heavy", "builtin", "stdbuf"}
# systemd-run runs its command in a unit, and these of its options take the next word as their value.
UNIT_VALUES = {"-u", "--unit", "-p", "--property", "-E", "--setenv", "-H", "--host", "-M", "--machine", "-C", "--capsule", "--description",
               "--slice", "--uid", "--gid", "--nice", "--working-directory", "--service-type", "--path-property", "--socket-property",
               "--timer-property", "--on-active", "--on-boot", "--on-startup", "--on-unit-active", "--on-unit-inactive", "--on-calendar"}
# A systemd-run unit starts from the user manager's environment, so this folder's systemd-run passes the guard's variables to it with -E.
UNIT_ENV = os.path.join(HERE, "unit-env")
KEYWORDS = {"{", "}", "!", "then", "do", "else", "elif", "if", "while", "until", "time"}
REDIRECTS = {">", ">>", "<<", "<<<", ">&", "<&", "&>", ">|", "&>>"}
SEPARATORS = {";", "&", "&&", "||", "(", ")", "\n", ";;"}
DECLARE = {"export", "local", "declare", "readonly", "typeset"}
ASSIGN = re.compile(r"^([A-Za-z_]\w*)=(.*)$", re.S)
GLOB = re.compile(r"[*?\[]")
# A transcript path inside a longer word, such as the SQL of `sqlite3 :memory: "select readfile('<path>')"` or a duckdb read_json(). A Python
# child loads this guard itself, so its code is left to it.
EMBEDDED = re.compile(r"(?:~|\$\{?HOME\}?|/)[^\s'\"(),;]*\.jsonl")


class TranscriptRefused(PermissionError):
    """A read of a session transcript outside this session's family."""


def folder_of(session_dir: str) -> str:
    return os.path.realpath(session_dir) if session_dir else ""


def under(path: str, root: str) -> bool:
    return path == root or path.startswith(root + os.sep)


def prime_of(real: str):
    """The Prime agent dir that holds a real path: this box's, or another host's in its copy under MIRRORS; None for any other path.

    A copied file outside a `.prime/agent` folder counts as held by its host's copy as a whole.
    """
    if under(real, PRIME):
        return PRIME
    if not under(real, MIRRORS) or real == MIRRORS:
        return None
    parts = os.path.relpath(real, MIRRORS).split(os.sep)
    for index in range(1, len(parts) - 1):
        if parts[index] == ".prime" and parts[index + 1] == "agent":
            return os.path.join(MIRRORS, *parts[:index + 2])
    return os.path.join(MIRRORS, parts[0])


def transcript_id(path: str):
    """The session id of a transcript under the Prime agent dir or a host's copy of one, or None for any other file."""
    match = TRANSCRIPT.match(os.path.basename(path))
    if not match:
        return None
    real = os.path.realpath(path)
    prime = prime_of(real)
    return match.group(1) if prime and not under(real, os.path.join(prime, "clean-room")) else None


def artifact_root(path: str):
    """The folder after session-artifacts/ in a path, live or in a copy, or None."""
    parts = os.path.relpath(path, PRIME).split(os.sep)
    if "session-artifacts" in parts:
        index = parts.index("session-artifacts")
        if index + 2 < len(parts) and UUID.match(parts[index + 1]):
            return parts[index + 1]
    return None


_ledger = {"key": None, "roots": {}}


def spawned_roots() -> dict:
    """Each subagent's session id and the root whose tree holds its transcript, from the spawn records in Prime's rlm-ledger.

    On 10-21 at 16:52Z a root of chat-057a opened sessions/<its direct child's id>.jsonl, the path a root's transcript has, and was refused
    as outside its family, since the path named no root. Prime keeps a subagent's transcript in its parent's artifact folder and writes the
    path in each spawn record.
    """
    paths = sorted(glob.glob(os.path.join(PRIME, "rlm-ledger", "*.jsonl")))
    try:
        key = tuple((path, os.stat(path).st_mtime_ns) for path in paths)
    except OSError:
        key = None
    if key != _ledger["key"]:
        roots = {}
        for path in paths:
            try:
                with _open(path, "rb") as handle:
                    lines = handle.read().decode("utf-8", "replace").splitlines()
            except OSError:
                continue
            for line in lines:
                if '"op":"spawn"' not in line:
                    continue
                try:
                    child = json.loads(line).get("child")
                except ValueError:
                    continue
                match = TRANSCRIPT.match(os.path.basename(child)) if isinstance(child, str) else None
                root = artifact_root(child) if match else None
                if root:
                    roots[match.group(1)] = root
        _ledger.update(key=key, roots=roots)
    return _ledger["roots"]


def root_of(real: str, sid: str) -> str:
    """The root session whose tree holds a transcript: the folder after session-artifacts/, else the root that spawned a subagent's id, else the id."""
    root = artifact_root(real)
    if root:
        return root
    if os.path.isdir(os.path.join(ARTIFACTS, sid)):
        return sid
    return spawned_roots().get(sid, sid)


def board_module():
    """The board skill a kernel pre-imports, or its file in this sieun-pi tree, for the chat host's job registry."""
    module = sys.modules.get("board")
    if module is not None and hasattr(module, "_chat_host"):
        return module
    module = sys.modules.get("global_rules_board")
    if module is None:
        import importlib.util
        spec = importlib.util.spec_from_file_location("global_rules_board", os.path.join(HERE, "..", "..", "skills", "board", "src", "board", "__init__.py"))
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        sys.modules["global_rules_board"] = module
    return module


_registry = {"key": None, "jobs": {}, "names": {}}


def registry(fresh: bool) -> tuple:
    """The chat job registry (chat-jobs.json): which chat started each root job, by session id or name, and each chat name's id.

    The chat host reads its own file, and another box reads it through the chat service (api/agent/jobs), as the board skill does. A local
    file is read again when it changes, and the chat host's copy when `fresh` asks for it. A registry that cannot be read counts as empty.
    """
    path = os.path.join(os.environ.get("AGENT_CHAT_DATA_DIR") or os.path.join(PRIME, "browser-chat"), "chat-jobs.json")
    try:
        remote = board_module()._chat_host() is not None
    except Exception:
        remote = False
    try:
        key = "remote" if remote else os.stat(path).st_mtime_ns
    except OSError:
        key = "missing"
    if key != _registry["key"] or (remote and fresh):
        jobs = {}
        try:
            if remote:
                raw = board_module()._call("api/agent/jobs") or b"{}"
            else:
                with _open(path, "rb") as handle:
                    raw = handle.read()
            jobs = json.loads(raw).get("jobs", {})
        except Exception:
            jobs = {}
        names = {entry["chat"]: entry["chatId"] for entry in jobs.values()
                 if isinstance(entry, dict) and isinstance(entry.get("chatId"), str) and isinstance(entry.get("chat"), str)}
        _registry.update(key=key, jobs=jobs, names=names)
    return _registry["jobs"], _registry["names"]


_names: dict = {}


def name_of(root: str):
    """A root session's name, from the session_info line near the start of its own transcript here or in a host's copy; None when it has none."""
    if root not in _names:
        _names[root] = None
        copies = sorted(glob.glob(os.path.join(MIRRORS, "*", "**", ".prime", "agent", "sessions", root + ".jsonl"), recursive=True))
        for path in [os.path.join(SESSIONS, root + ".jsonl"), *copies]:
            try:
                with _open(path, "rb") as handle:
                    head = handle.read(65536).decode("utf-8", "replace")
            except OSError:
                continue
            match = re.search(r'"type":"session_info"[^\n]*?"name":"((?:[^"\\]|\\.)*)"', head)
            try:
                _names[root] = json.loads(f'"{match.group(1)}"') if match else None
            except ValueError:
                pass
            break
    return _names[root]


def chat_of(root: str, fresh: bool) -> str:
    """The chat a root belongs to: the root itself, or the chat that started it, followed up the registry (a job's own root jobs)."""
    jobs, names = registry(fresh)
    seen, current = set(), root
    while current not in seen:
        seen.add(current)
        entry = jobs.get(current) or jobs.get(name_of(current) or "\0")
        parent = (entry.get("chatId") or names.get(entry.get("chat"))) if isinstance(entry, dict) else None
        if not isinstance(parent, str) or not UUID.match(parent):
            break
        current = parent
    return current


def scan(path: str) -> list:
    try:
        return list(os.scandir(path))
    except OSError:
        return []


def transcripts_in(folder: str) -> list:
    return [m.group(1) for m in (TRANSCRIPT.match(e.name) for e in scan(folder) if e.is_file(follow_symlinks=False)) if m]


_fresh = {"done": False}


def in_family(path: str, sid: str, folder: str) -> bool:
    """Whether the transcript at `path` belongs to this session's chat: the same root tree, or a root the same chat started.

    The first miss in a check reads the chat host's registry again, so a job the chat started a moment ago counts.
    """
    if not folder:
        return True
    real = os.path.realpath(path)
    mine = os.path.relpath(folder, ARTIFACTS).split(os.sep)[0]
    theirs = root_of(real, sid)
    if theirs == mine or chat_of(theirs, False) == chat_of(mine, False):
        return True
    if not _fresh["done"]:
        _fresh["done"] = True
        return chat_of(theirs, True) == chat_of(mine, True)
    return False


def outside_in(directory: str, folder: str):
    """The first transcript outside the family that a read of `directory` as a whole would read, or None."""
    real = os.path.realpath(directory)
    if not os.path.isdir(real) or (folder and under(real, folder)):
        return None
    if real in (HOME, "/"):
        return None
    starts = [real if under(real, base) else top for base, top in ((PRIME, SESSIONS), (MIRRORS, MIRRORS)) if under(real, base) or under(base, real)]
    for start in dict.fromkeys(starts):
        for top, dirs, files in os.walk(start):
            dirs.sort()
            for name in sorted(files):
                sid = transcript_id(os.path.join(top, name)) if TRANSCRIPT.match(name) else None
                if sid and not in_family(os.path.join(top, name), sid, folder):
                    return os.path.join(top, name)
    return None


def allowed_paths(folder: str) -> str:
    mine = os.path.relpath(folder, ARTIFACTS).split(os.sep)[0] if folder else ""
    chat = chat_of(mine, False) if mine else ""
    return (f"the transcripts of its own chat {chat}: the chat, its jobs and their subagents under {os.path.join(ARTIFACTS, chat)}, "
            "and the root jobs that chat started") if chat else "its own chat's transcripts"


def reason(path: str, sid: str, folder: str, whole: str = "") -> str:
    what = f"reading {whole} as a whole, which holds {path}" if whole else f"reading {path}"
    return (f"global-rules refused {what}: it is the transcript of session {sid}, outside this session's family, which is its own chat. A session reads only "
            f"{allowed_paths(folder)}. For another session, use its catalog and status: agent_observe.list_agents() and its message "
            "previews, `prime-agent status`, the board (board.open(chat=...), board.get(...)), the chat's job-resumes and duty files, and the "
            "daemon-workers descriptors with the worker and supervisor logs, or ask the chat that owns it to relay what you need. A fact that "
            "only that transcript holds is 'unknown, owner relay needed'. Fleet audits read transcripts through the d7, d9 and d10 prechecks. "
            "chat-057a reported jobs reading unrelated transcripts on 10-19 and 10-20.")


def record(path: str, sid: str, via: str) -> None:
    try:
        os.makedirs(os.path.dirname(LOG), exist_ok=True)
        line = json.dumps({"at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "session": os.environ.get("RLM_SESSION_DIR", ""),
                           "pid": os.getpid(), "via": via, "path": path, "of": sid})
        fd = _os_open(LOG, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o644)
        try:
            os.write(fd, (line + "\n").encode())
        finally:
            os.close(fd)
    except Exception:
        pass


def judge_path(path: str, folder: str):
    """(transcript, session id) when reading `path` reads a transcript outside the family, else None."""
    sid = transcript_id(path)
    if sid and not in_family(path, sid, folder):
        return path, sid
    return None


def shell_names(env) -> dict:
    """The variables a shell text starts with, each name to the values it can hold: the command's environment, else the kernel's."""
    return {name: [os.fsdecode(value)] for name, value in (env if isinstance(env, dict) else os.environ).items()}


def expand(word: str, names: dict) -> list:
    """Each text `word` can stand for once ~, $HOME and the variables in `names` are put in; none when it uses a variable the text never set."""
    raw = re.sub(r"^(?:~(?=/|$)|\$HOME\b|\$\{HOME\})", lambda m: HOME, word)
    match = re.search(r"\$\{?([A-Za-z_]\w*)\}?", raw)
    if not match:
        return [] if "$" in raw or "`" in raw else [raw]
    return [raw[:match.start()] + value + rest for value in names.get(match.group(1), []) for rest in expand(raw[match.end():], names)]


def resolve(word: str, cwd: str, names: dict) -> list:
    paths = []
    for raw in expand(word, names):
        if raw:
            raw = os.path.normpath(os.path.join(cwd, raw))
            paths.extend([os.path.normpath(p) for p in glob.glob(raw)] if GLOB.search(raw) else [raw])
    return paths


def assign(words: list, cwd: str, names: dict) -> bool:
    """Records the variables a command sets (`f=path`, `export f=path`, `for f in paths`) in `names`; whether that is all it does.

    On 10-21 at 08:10Z a job ran `f=~/.prime/agent/sessions/<id>.jsonl; head -c 1500 $f` and read another chat's transcript, because `$f`
    was not in the environment and the command named no file.
    """
    while words and words[0] in KEYWORDS:
        words = words[1:]
    if len(words) > 2 and words[0] == "for" and words[2] == "in":
        names[words[1]] = [p for w in words[3:] for raw in expand(w, names) if raw
                           for p in (sorted(glob.glob(os.path.join(cwd, raw))) if GLOB.search(raw) else [raw])]
        return True
    sets = [ASSIGN.match(w) for w in words[1 if words and words[0] in DECLARE else 0:]]
    if not sets or not all(sets):
        return False
    for match in sets:
        names[match.group(1)] = expand(match.group(2), names)
    return True


def words_of(text: str) -> list:
    lexer = shlex.shlex(text, posix=True, punctuation_chars=";&|()<>\n")
    lexer.whitespace = " \t\r"
    lexer.whitespace_split = True
    try:
        return list(lexer)
    except ValueError:
        return text.split()


def pipelines(text: str) -> list:
    """The pipelines of a shell text, each a list of commands, each a list of words, with redirect targets kept as operands."""
    out, pipe, command = [], [], []
    for word in words_of(text):
        if word in SEPARATORS:
            pipe.append(command)
            out.append(pipe)
            pipe, command = [], []
        elif word in ("|", "|&"):
            pipe.append(command)
            command = []
        elif word in REDIRECTS or word == "<":
            continue
        else:
            command.append(word)
    pipe.append(command)
    out.append(pipe)
    return out


def bare(words: list) -> list:
    while words and (words[0] in KEYWORDS or re.match(r"^[A-Za-z_]\w*=", words[0])):
        words = words[1:]
    while words and os.path.basename(words[0]) in WRAPPERS | {"systemd-run"}:
        if os.path.basename(words[0]) == "systemd-run":
            words = words[1:]
            while words and words[0].startswith("-"):
                if words[0] == "--":
                    words = words[1:]
                    break
                words = words[2:] if words[0] in UNIT_VALUES else words[1:]
            continue
        words = words[1:]
        while words and (words[0].startswith("-") or re.match(r"^[A-Za-z_]\w*=", words[0]) or re.match(r"^\d+[smhd]?$", words[0])):
            words = words[1:]
    return words


def reads_whole(name: str, words: list) -> bool:
    if name in WHOLE:
        return True
    flags = [w for w in words[1:] if w.startswith("-")]
    if name in RECURSE:
        return any(f in ("--recursive", "--dereference-recursive", "--archive") or (not f.startswith("--") and any(c in f[1:] for c in "rRa")) for f in flags)
    return False


def judge_shell(text: str, cwd: str, env=None, folder: str = "", depth: int = 0, names=None):
    """(transcript, session id, folder read as a whole or "") for the first outside transcript a shell text reads, or None.

    `names` holds the shell variables, from `env` and from what the text sets as it goes, so a `$f` the text set reads as its path.
    """
    if not folder:
        return None
    names = shell_names(env) if names is None else names
    for pipe in pipelines(text):
        listed = []
        for index, raw in enumerate(pipe):
            if assign(raw, cwd, names):
                continue
            words = bare(raw)
            if not words:
                continue
            name = os.path.basename(words[0])
            if name == "cd" and len(words) > 1:
                target = resolve(words[1], cwd, names)
                if target:
                    cwd = target[0]
                continue
            if name in SHELLS and "-c" in words[1:-1] and depth < 3:
                hit = judge_shell(words[words.index("-c", 1) + 1], cwd, env, folder, depth + 1, dict(names))
                if hit:
                    return hit
                continue
            operands = [w for w in words[1:] if not w.startswith("-") or w == "-"]
            if name == "xargs":
                inner = [w for w in words[1:] if not w.startswith("-")]
                if any(os.path.basename(w) in READERS for w in inner[:2]):
                    for directory in listed:
                        hit = outside_in(directory, folder)
                        if hit:
                            return hit, transcript_id(hit), directory
                    for path in [p for d in listed for p in [d] if not os.path.isdir(p)]:
                        found = judge_path(path, folder)
                        if found:
                            return found[0], found[1], ""
                continue
            if name in ("find", "fd", "ls"):
                paths = [p for w in operands for p in resolve(w, cwd, names)] or [cwd]
                execs = [w for w in words if w in ("-exec", "-execdir", "-ok", "-x", "-X", "--exec", "--exec-batch")]
                if execs:
                    after = words[words.index(execs[0]) + 1:]
                    if after and os.path.basename(after[0]) in READERS:
                        for directory in paths:
                            hit = outside_in(directory, folder) if os.path.isdir(directory) else (directory if judge_path(directory, folder) else None)
                            if hit:
                                return hit, transcript_id(hit), directory if hit != directory else ""
                listed.extend(paths)
                continue
            if name in METADATA:
                continue
            whole = reads_whole(name, words)
            paths = [p for w in operands for p in resolve(w, cwd, names)]
            if not name.startswith("python"):
                paths += [p for w in operands if not w.endswith(".jsonl") for inner in EMBEDDED.findall(w) for p in resolve(inner, cwd, names)]
            if whole and not [p for p in paths if os.path.isdir(p)] and name in ("rg", "ag", "ack") and len(operands) <= 1:
                paths.append(cwd)
            for path in paths:
                found = judge_path(path, folder)
                if found:
                    return found[0], found[1], ""
                if whole and os.path.isdir(path):
                    hit = outside_in(path, folder)
                    if hit:
                        return hit, transcript_id(hit), path
    return None


def tool_caller() -> bool:
    """Whether the nearest caller outside the standard library and this file is a sieun-pi, skill or Prime tool, or the kernel's rlm package."""
    frame = sys._getframe(2)
    while frame is not None:
        name = frame.f_code.co_filename
        real = os.path.realpath(name) if name.startswith("/") else name
        if name.startswith("<frozen") or real == THIS or real.startswith(HERE + os.sep):
            frame = frame.f_back
            continue
        if real.startswith(STDLIB) and "site-packages" not in real:
            frame = frame.f_back
            continue
        return real.startswith(TOOLS) or real.startswith(RLM)
    return False


def any_tool_frame() -> bool:
    """Whether a sieun-pi, skill or Prime tool frame is on the stack, other than the kernel's rlm package, whose bash() runs cells' commands."""
    frame = sys._getframe(2)
    while frame is not None:
        name = frame.f_code.co_filename
        real = os.path.realpath(name) if name.startswith("/") else ""
        if real.startswith(TOOLS) and not real.startswith(RLM) and not real.startswith(HERE + os.sep):
            return True
        frame = frame.f_back
    return False


FOLDER = folder_of(os.environ.get("RLM_SESSION_DIR", ""))
ACTIVE = bool(FOLDER) and under(FOLDER, ARTIFACTS) and FOLDER != ARTIFACTS
_open = builtins.open
_os_open = os.open


def check_open(file) -> None:
    if not ACTIVE or not isinstance(file, (str, bytes, os.PathLike)):
        return
    name = os.fsdecode(file)
    if not name.endswith(".jsonl"):
        return
    _fresh["done"] = False
    found = judge_path(os.path.abspath(name), FOLDER)
    if found and not tool_caller():
        record(found[0], found[1], "open")
        raise TranscriptRefused(reason(found[0], found[1], FOLDER))


def guarded_open(file, *args, **kwargs):
    check_open(file)
    return _open(file, *args, **kwargs)


def guarded_os_open(path, *args, **kwargs):
    if kwargs.get("dir_fd") is None:
        check_open(path)
    return _os_open(path, *args, **kwargs)


def command_text(args) -> str:
    if isinstance(args, (str, bytes, os.PathLike)):
        return os.fsdecode(args)
    words = [os.fsdecode(a) for a in args]
    if words and os.path.basename(words[0]) in SHELLS and "-c" in words[1:-1]:
        return words[words.index("-c", 1) + 1]
    return " ".join(shlex.quote(w) for w in words)


def check_command(args, cwd, env) -> None:
    if not ACTIVE:
        return
    _fresh["done"] = False
    try:
        hit = judge_shell(command_text(args), os.fsdecode(cwd or os.getcwd()), env, FOLDER)
    except Exception:
        hit = None
    if hit and not any_tool_frame():
        record(hit[0], hit[1], "command")
        raise TranscriptRefused(reason(hit[0], hit[1], FOLDER, hit[2]))


def guarded_init(original):
    def __init__(self, args, *rest, **kwargs):
        check_command(args, kwargs.get("cwd"), kwargs.get("env"))
        original(self, args, *rest, **kwargs)

    __init__.refuses_transcripts = True
    for flag in ("records_owner", "refuses_others"):
        if getattr(original, flag, False):
            setattr(__init__, flag, True)
    return __init__


def guarded_system(original):
    def system(command):
        check_command(command, None, None)
        return original(command)

    system.refuses_transcripts = True
    for flag in ("records_owner", "refuses_others"):
        if getattr(original, flag, False):
            setattr(system, flag, True)
    system.__doc__ = original.__doc__
    return system


def install() -> None:
    if not ACTIVE or getattr(builtins.open, "refuses_transcripts", False):
        return
    guarded_open.refuses_transcripts = True
    guarded_open.__doc__ = _open.__doc__
    builtins.open = guarded_open
    io.open = guarded_open
    os.open = guarded_os_open
    if not getattr(subprocess.Popen.__init__, "refuses_transcripts", False):
        subprocess.Popen.__init__ = guarded_init(subprocess.Popen.__init__)
    if not getattr(os.system, "refuses_transcripts", False):
        os.system = guarded_system(os.system)
    path = os.environ.get("PATH", "").split(os.pathsep)
    if UNIT_ENV not in path:
        os.environ["PATH"] = os.pathsep.join([UNIT_ENV, *path])
    builtins.TranscriptRefused = TranscriptRefused


def judge_tool(request: dict):
    """The tool_call half (transcript-guard.ts): the reason to refuse a `read`, `grep` or `bash` tool call, or None."""
    _fresh["done"] = False
    folder = folder_of(request.get("session", ""))
    if not folder or not under(folder, ARTIFACTS) or folder == ARTIFACTS:
        return None
    cwd = request.get("cwd") or os.getcwd()
    if request.get("tool") == "bash":
        hit = judge_shell(request.get("text", ""), cwd, None, folder)
        if hit:
            return reason(hit[0], hit[1], folder, hit[2]), hit
        return None
    path = os.path.normpath(os.path.join(cwd, os.path.expanduser(request.get("path", ""))))
    found = judge_path(path, folder)
    if found:
        return reason(found[0], found[1], folder), (found[0], found[1], "")
    hit = outside_in(path, folder) if request.get("tool") == "grep" and os.path.isdir(path) else None
    if hit:
        return reason(hit, transcript_id(hit), folder, path), (hit, transcript_id(hit), path)
    return None


if __name__ == "__main__" and sys.argv[1:] == ["--judge"]:
    request = json.loads(sys.stdin.read())
    verdict = judge_tool(request)
    if verdict:
        os.environ["RLM_SESSION_DIR"] = request.get("session", "")
        record(verdict[1][0], verdict[1][1], request.get("tool", "tool"))
    print(json.dumps({"refuse": verdict[0] if verdict else None}))
else:
    install()
