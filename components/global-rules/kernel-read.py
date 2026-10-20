"""Refuses this session's reads of another family's session transcripts, in the Prime kernel and the Python processes it starts.

On 2026-10-19 the runtime intent trace job and on 2026-10-20 from 15:59Z to 16:10Z p8-prepare-hold, a job of chat-057a, opened the
session transcripts of unrelated roots under ~/.prime/agent/sessions to read their state lines, and each time a later scope reminder in its
brief came too late. agent_observe already limits observation to the parent, siblings and children, but a cell could still open the files.
So a session reads only its own family's transcripts: itself, the sessions above it up to its root, its siblings and the sessions below it.
Any other `<session id>.jsonl` under the Prime agent dir (sessions/, session-artifacts/ and their copies) raises TranscriptRefused, which
names the catalog, status and relay paths that stay open.

1. open(), io.open(), os.open() and Path.read_text() of such a file from cell code, or from code that is not a sieun-pi, skill or Prime tool.
2. A command the kernel starts (bash(), subprocess, os.system) that names such a file, or that reads a folder holding one as a whole
   (rg, grep -r, find ... -exec or | xargs a reader, cp -r, rsync, tar).
3. The `read`, `grep` and `bash` tools, through `--judge` (transcript-guard.ts).

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
TRANSCRIPT = re.compile(r"^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$")
SUB = re.compile(r"^sub-[0-9a-f]+$")
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
KEYWORDS = {"{", "}", "!", "then", "do", "else", "elif", "if", "while", "until", "time"}
REDIRECTS = {">", ">>", "<<", "<<<", ">&", "<&", "&>", ">|", "&>>"}
SEPARATORS = {";", "&", "&&", "||", "(", ")", "\n", ";;"}
GLOB = re.compile(r"[*?\[]")
_family_ids = None


class TranscriptRefused(PermissionError):
    """A read of a session transcript outside this session's family."""


def folder_of(session_dir: str) -> str:
    return os.path.realpath(session_dir) if session_dir else ""


def under(path: str, root: str) -> bool:
    return path == root or path.startswith(root + os.sep)


def transcript_id(path: str):
    """The session id of a transcript under the Prime agent dir, or None for any other file."""
    match = TRANSCRIPT.match(os.path.basename(path))
    if not match:
        return None
    real = os.path.realpath(path)
    return match.group(1) if under(real, PRIME) and not under(real, CLEAN_ROOM) else None


def session_folder(real: str, sid: str) -> str:
    if under(real, SESSIONS):
        return os.path.join(ARTIFACTS, sid)
    return os.path.dirname(real)


def family_ids(folder: str) -> set:
    """The ids of this family's sessions, for a transcript copy outside the live tree (premove-sessions, backups)."""
    global _family_ids
    if _family_ids is not None:
        return _family_ids
    ids = set()
    if under(folder, ARTIFACTS) and folder != ARTIFACTS:
        ids.add(os.path.relpath(folder, ARTIFACTS).split(os.sep)[0])
        current = folder
        while current != ARTIFACTS and under(current, ARTIFACTS):
            ids.update(transcripts_in(current))
            current = os.path.dirname(current)
        if SUB.match(os.path.basename(folder)):
            for entry in scan(os.path.dirname(folder)):
                if entry.is_dir(follow_symlinks=False) and SUB.match(entry.name):
                    ids.update(transcripts_in(entry.path))
        for _, dirs, files in os.walk(folder):
            ids.update(m.group(1) for m in map(TRANSCRIPT.match, files) if m)
    _family_ids = ids
    return ids


def scan(path: str) -> list:
    try:
        return list(os.scandir(path))
    except OSError:
        return []


def transcripts_in(folder: str) -> list:
    return [m.group(1) for m in (TRANSCRIPT.match(e.name) for e in scan(folder) if e.is_file(follow_symlinks=False)) if m]


def in_family(path: str, sid: str, folder: str) -> bool:
    """Whether the transcript at `path` is this session's, an ancestor's, a sibling's or a descendant's."""
    if not folder:
        return True
    real = os.path.realpath(path)
    other = session_folder(real, sid)
    if under(other, folder) or under(folder, other):
        return True
    if SUB.match(os.path.basename(other)) and SUB.match(os.path.basename(folder)) and os.path.dirname(other) == os.path.dirname(folder):
        return True
    return sid in family_ids(folder)


def outside_in(directory: str, folder: str):
    """The first transcript outside the family that a read of `directory` as a whole would read, or None."""
    real = os.path.realpath(directory)
    if not os.path.isdir(real) or (folder and under(real, folder)):
        return None
    if real in (HOME, "/") or not (under(real, PRIME) or under(PRIME, real)):
        return None
    start = SESSIONS if under(PRIME, real) and real != PRIME else real
    for top, dirs, files in os.walk(start):
        dirs.sort()
        for name in sorted(files):
            match = TRANSCRIPT.match(name)
            if match and not in_family(os.path.join(top, name), match.group(1), folder):
                return os.path.join(top, name)
    return None


def allowed_paths(folder: str) -> str:
    if not folder:
        return "its own session folder"
    own = transcripts_in(folder)
    own_file = os.path.join(folder, own[0] + ".jsonl") if own else os.path.join(SESSIONS, os.path.basename(folder) + ".jsonl")
    return f"its own transcript {own_file}, the transcripts of the sessions above it and its siblings, and everything below {folder}"


def reason(path: str, sid: str, folder: str, whole: str = "") -> str:
    what = f"reading {whole} as a whole, which holds {path}" if whole else f"reading {path}"
    return (f"global-rules refused {what}: it is the transcript of session {sid}, outside this session's family. A session reads only "
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


def resolve(word: str, cwd: str, env) -> list:
    names = env if isinstance(env, dict) else os.environ
    raw = re.sub(r"^(?:~(?=/|$)|\$HOME\b|\$\{HOME\})", lambda m: HOME, word)
    raw = re.sub(r"\$\{?([A-Za-z_]\w*)\}?", lambda m: os.fsdecode(names.get(m.group(1), m.group(0))), raw)
    if "$" in raw or "`" in raw or not raw:
        return []
    raw = os.path.normpath(os.path.join(cwd, raw))
    return [os.path.normpath(p) for p in glob.glob(raw)] if GLOB.search(raw) else [raw]


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
    while words and os.path.basename(words[0]) in WRAPPERS:
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


def judge_shell(text: str, cwd: str, env=None, folder: str = "", depth: int = 0):
    """(transcript, session id, folder read as a whole or "") for the first outside transcript a shell text reads, or None."""
    if not folder:
        return None
    for pipe in pipelines(text):
        listed = []
        for index, raw in enumerate(pipe):
            words = bare(raw)
            if not words:
                continue
            name = os.path.basename(words[0])
            if name == "cd" and len(words) > 1:
                target = resolve(words[1], cwd, env)
                if target:
                    cwd = target[0]
                continue
            if name in SHELLS and "-c" in words[1:-1] and depth < 3:
                hit = judge_shell(words[words.index("-c", 1) + 1], cwd, env, folder, depth + 1)
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
                paths = [p for w in operands for p in resolve(w, cwd, env)] or [cwd]
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
            paths = [p for w in operands for p in resolve(w, cwd, env)]
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
    builtins.TranscriptRefused = TranscriptRefused


def judge_tool(request: dict):
    """The tool_call half (transcript-guard.ts): the reason to refuse a `read`, `grep` or `bash` tool call, or None."""
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
