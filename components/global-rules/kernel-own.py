"""Records each path under ~/scratch that this Prime kernel creates in $RLM_SESSION_DIR/owned.json, through board.own (owner rule c130).

A job's end deletes only the paths its owned.json names (components/user-history/src/job-leftovers.ts), and jobs that had to call board.own
by hand mostly did not: on 10-20 at 03:40Z 22 of the 23 biggest trees under ~/scratch on us-metal02 had no record, and ~/scratch grew
from 61 to 76 GB in 5 h. So the kernel records what it makes, at creation time:

1. An os.mkdir (os.makedirs, Path.mkdir and tempfile.mkdtemp call it) that creates a folder below ~/scratch records the folder, unless the
   record already holds it or a folder above it.
2. A command the kernel starts (bash(), subprocess, os.system) that names a path below ~/scratch whose folder chain is missing at its start records
   the first missing part, such as ~/scratch/job for `mkdir -p ~/scratch/job/tree`, once it exists. The watch ends with that process, so a
   path the command only names and another job creates later is never recorded.

A path that existed before is never recorded, since its maker is unknown, and neither is a path in a job's own ~/scratch/<session id>/
folder, which the job's end deletes as a whole. /tmp is left out: it is a tmpfs on us-metal02 and holds shared
sockets and caches. With no RLM_SESSION_DIR (CI, a person's shell) it records nothing. The prelude in kernel-guard.ts runs this file once per
kernel, never in a child Python.

The kernel also refuses a recursive delete below ~/scratch (`rm -r`, `find ... -delete`, shutil.rmtree) of a tree this job did not make
(`refusal`), with TreeRefused, so a disk cleanup lists other jobs' trees for their owners instead of guessing which ones have ended.
"""

import glob
import importlib.util
import json
import os
import re
import shlex
import shutil
import subprocess
import sys
import threading

HERE = os.path.dirname(os.path.realpath(__file__))
SESSION = os.environ.get("RLM_SESSION_DIR", "")
HOME = os.path.expanduser("~")
SCRATCH = os.path.join(HOME, "scratch")
KERNEL = os.getpid()
NAMED = re.compile(r"(?:~|\$HOME\b|\$\{HOME\}|" + re.escape(HOME) + r")/scratch/[^\s'\"`;|&()<>{}]+")
GLOB = re.compile(r"[*?\[]")
# ~/scratch/<session id>/ is the folder the job line gives a job (chat-brief.ts jobScratch), and that job's end deletes it, so a subagent that
# makes its job's folder first never records it as its own.
SESSION_FOLDER = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
watched: dict = {}
mine: set = set()
lock = threading.Lock()
wake = threading.Condition(lock)


def board():
    """The board skill a kernel pre-imports, or its file in this checkout."""
    module = sys.modules.get("board")
    if module is not None and hasattr(module, "own"):
        return module
    module = sys.modules.get("global_rules_board")
    if module is None:
        path = os.path.join(HERE, "..", "..", "skills", "board", "src", "board", "__init__.py")
        spec = importlib.util.spec_from_file_location("global_rules_board", path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        sys.modules["global_rules_board"] = module
    return module


def below_scratch(path: str) -> bool:
    return path.startswith(SCRATCH + "/")


def recorded() -> list:
    try:
        with open(os.path.join(SESSION, "owned.json"), encoding="utf-8") as handle:
            return [p for p in json.load(handle).get("paths", []) if isinstance(p, str)]
    except (OSError, ValueError, AttributeError):
        return []


def claim(path: str) -> None:
    """Records a path this kernel made, unless the record holds it or a folder above it. A failure never reaches the cell."""
    if not SESSION or os.getpid() != KERNEL or not below_scratch(path) or SESSION_FOLDER.match(path[len(SCRATCH) + 1:].split("/")[0]):
        return
    try:
        if any(path == p or path.startswith(p + "/") for p in mine) or any(path == p or path.startswith(p + "/") for p in recorded()):
            return
        board().own(path)
        mine.add(path)
    except Exception as error:
        print(f"global-rules: could not record {path} as this session's: {error}", file=sys.stderr)


def first_missing(text: str, env) -> list:
    """For each path below ~/scratch the command names, the first folder of its chain that does not exist yet."""
    names = env if isinstance(env, dict) else os.environ
    found = []
    for match in NAMED.finditer(text):
        raw = re.sub(r"^(?:~|\$HOME\b|\$\{HOME\})", lambda m: HOME, match.group(0))
        raw = re.sub(r"\$\{?([A-Za-z_]\w*)\}?", lambda m: os.fsdecode(names.get(m.group(1), m.group(0))), raw)
        path = os.path.normpath(raw)
        if not below_scratch(path):
            continue
        current = SCRATCH
        for part in path[len(SCRATCH) + 1:].split("/"):
            if GLOB.search(part) or "$" in part:
                break
            current = os.path.join(current, part)
            if not os.path.lexists(current):
                if current not in found:
                    found.append(current)
                break
    return found


def alive(pid: int) -> bool:
    try:
        with open(f"/proc/{pid}/stat", encoding="utf-8") as handle:
            return handle.read().rsplit(")", 1)[1].split()[0] != "Z"
    except FileNotFoundError:
        return False
    except OSError:
        pass
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def watch() -> None:
    """Records each watched path once it exists, and drops it once the process that named it has ended without making it."""
    while True:
        with wake:
            while not watched:
                wake.wait()
            items = list(watched.items())
        for path, pid in items:
            running = alive(pid)
            if os.path.lexists(path):
                claim(path)
            elif running:
                continue
            with lock:
                watched.pop(path, None)
        with wake:
            if watched:
                wake.wait(1)


def text_of(args) -> str:
    if isinstance(args, (str, bytes, os.PathLike)):
        return os.fsdecode(args)
    return " ".join(os.fsdecode(a) for a in args)


def recording_mkdir(original):
    def mkdir(path, *args, **kwargs):
        result = original(path, *args, **kwargs)
        if kwargs.get("dir_fd") is None:
            try:
                claim(os.path.abspath(os.fsdecode(path)))
            except Exception:
                pass
        return result

    mkdir.records_owner = True
    mkdir.__doc__ = original.__doc__
    return mkdir


def recording_init(original):
    def __init__(self, args, *rest, **kwargs):
        try:
            paths = first_missing(text_of(args), kwargs.get("env")) if os.getpid() == KERNEL else []
        except Exception:
            paths = []
        original(self, args, *rest, **kwargs)
        if paths:
            with wake:
                for path in paths:
                    watched.setdefault(path, self.pid)
                wake.notify()

    __init__.records_owner = True
    return __init__


def recording_system(original):
    def system(command):
        try:
            paths = first_missing(text_of(command), None) if os.getpid() == KERNEL else []
        except Exception:
            paths = []
        try:
            return original(command)
        finally:
            for path in paths:
                if os.path.lexists(path):
                    claim(path)

    system.records_owner = True
    system.__doc__ = original.__doc__
    return system


def install() -> None:
    if not SESSION:
        return
    if not getattr(os.mkdir, "records_owner", False):
        os.mkdir = recording_mkdir(os.mkdir)
    if not getattr(os.system, "records_owner", False):
        os.system = recording_system(os.system)
    if not getattr(subprocess.Popen.__init__, "records_owner", False):
        subprocess.Popen.__init__ = recording_init(subprocess.Popen.__init__)
    threading.Thread(target=watch, name="global-rules-own", daemon=True).start()


# The other half of c130 on this box: only the owner, or a job's end through its owned.json, deletes a tree under ~/scratch. On 10-19 the
# box-scratch-sweep deleted live work by guessing which trees had ended, and on 10-20 at 04:00Z the scratch-r3 pass of the job wiki box disk fix
# guessed again (no process inside, newest file over 1 h old, no live session naming it) and deleted ~/scratch/crawler-lab-window-2/build-b12
# and build-b13, which a live Crawler ops lab job still needed. So the kernel refuses a recursive delete below ~/scratch unless this job made
# the tree: a path in an owned.json of this session, the sessions above it up to its root, or its subagents, a job's own
# ~/scratch/<session id>/ folder of those sessions, or a folder this kernel made. A tree that does not exist yet passes.
ARTIFACTS = os.path.join(os.path.expanduser(os.environ.get("PRIME_AGENT_CODING_AGENT_DIR") or os.environ.get("PI_CODING_AGENT_DIR")
                                            or os.path.join(HOME, ".prime", "agent")), "session-artifacts")
SUBAGENT_FOLDER = re.compile(r"^sub-[0-9a-f]+$")
SHELLS = {"sh", "bash", "dash", "zsh"}
WRAPPERS = {"sudo", "env", "nice", "ionice", "timeout", "command", "exec", "time", "nohup", "heavy", "builtin"}
KEYWORDS = {"{", "}", "!", "then", "do", "else", "elif", "if", "while", "until", "time"}
REDIRECTS = {"<", ">", ">>", "<<", "<<<", ">&", "<&", "&>", ">|", "&>>"}
SEPARATORS = {";", "&", "&&", "|", "||", "|&", "(", ")", "\n", ";;"}


class TreeRefused(PermissionError):
    """A recursive delete of a tree below ~/scratch that this job did not make."""


def job_dirs() -> list:
    """This session's folder, the folders above it up to its root session's folder, and the session folders below it (its subagents)."""
    session = os.path.normpath(SESSION)
    dirs = []
    current = session
    while current.startswith(ARTIFACTS + "/"):
        dirs.append(current)
        current = os.path.dirname(current)
    stack = [session]
    while stack:
        try:
            entries = list(os.scandir(stack.pop()))
        except OSError:
            continue
        for entry in entries:
            if entry.is_dir(follow_symlinks=False) and (SUBAGENT_FOLDER.match(entry.name) or SESSION_FOLDER.match(entry.name)
                                                       or entry.name == "session-artifacts"):
                dirs.append(entry.path)
                stack.append(entry.path)
    return dirs


def owned_in(folder: str) -> list:
    try:
        with open(os.path.join(folder, "owned.json"), encoding="utf-8") as handle:
            return [os.path.normpath(p) for p in json.load(handle).get("paths", []) if isinstance(p, str) and p.startswith("/")]
    except (OSError, ValueError, AttributeError):
        return []


def session_ids(folder: str) -> list:
    """The session ids a session folder stands for: its own name for a root session, the transcripts in it for a subagent's folder."""
    found = [os.path.basename(folder)] if SESSION_FOLDER.match(os.path.basename(folder)) else []
    try:
        found += [name[:-6] for name in os.listdir(folder) if name.endswith(".jsonl") and SESSION_FOLDER.match(name[:-6])]
    except OSError:
        pass
    return found


def within(path: str, roots) -> bool:
    return any(path == root or path.startswith(root + "/") for root in roots)


def other_owner(path: str, dirs: list) -> str:
    """The session folder of another job whose owned.json holds the path, a folder above it or a path in it, or whose ~/scratch/<id>/ holds it."""
    top = path[len(SCRATCH) + 1:].split("/")[0] if below_scratch(path) else ""
    if SESSION_FOLDER.match(top):
        return f"session {top}, whose job's own folder it is"
    mine_dirs = set(dirs)
    pattern = os.path.join(ARTIFACTS, "*")
    for _ in range(5):
        for record in glob.glob(os.path.join(pattern, "owned.json")):
            folder = os.path.dirname(record)
            if folder in mine_dirs:
                continue
            for owned in owned_in(folder):
                if within(path, [owned]) or owned.startswith(path + "/"):
                    return f"the session in {folder}, whose owned.json records {owned}"
        pattern = os.path.join(pattern, "sub-*")
    return ""


def refusal(path: str):
    """Why this job may not delete the tree at `path`, or None when it may."""
    if not (path == SCRATCH or below_scratch(path)) or not os.path.lexists(path):
        return None
    dirs = job_dirs()
    allowed = set(mine)
    for folder in dirs:
        allowed.update(owned_in(folder))
        allowed.update(os.path.join(SCRATCH, sid) for sid in session_ids(folder))
    if path != SCRATCH and within(path, allowed):
        return None
    owner = other_owner(path, dirs)
    return (f"global-rules refused deleting {path}: this job did not make it. No owned.json of this session, the sessions above it or its "
            "subagents records it or a folder above it, it is not in their own ~/scratch/<session id>/ folders, and this kernel did not make it"
            + (f". It belongs to {owner}" if owner else ", so its owner is unknown") + ". Only the owner, or a job's end through its own "
            "board.own record, deletes a tree on this box (c130); a guess that a tree has ended deleted live work on 10-19 and on 10-20. "
            "List the path, its size and its likely owner for the chat that owns it instead, and never record another job's tree with "
            "board.own to delete it. If you made it yourself before the kernel recorded folders, record it with board.own(path) and delete it.")


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


def doomed(text: str, cwd: str, env, depth: int = 0) -> list:
    """The paths a shell command deletes as trees: the operands of `rm -r` and the start paths of `find ... -delete` or `-exec rm`."""
    found = []
    command: list = []
    skip = False

    def judge(words):
        nonlocal cwd
        while words and (words[0] in KEYWORDS or re.match(r"^[A-Za-z_]\w*=", words[0])):
            words = words[1:]
        if words and os.path.basename(words[0]) in WRAPPERS:
            start = next((i for i, w in enumerate(words) if os.path.basename(w) in SHELLS | {"rm", "find", "cd"}), None)
            words = words[start:] if start is not None else []
        if not words:
            return
        name = os.path.basename(words[0])
        if name == "cd" and len(words) > 1:
            target = resolve(words[1], cwd, env)
            if target:
                cwd = target[0]
        elif name in SHELLS and "-c" in words[1:-1] and depth < 3:
            found.extend(doomed(words[words.index("-c", 1) + 1], cwd, env, depth + 1))
        elif name == "rm":
            flags = [w for w in words[1:] if w.startswith("-") and w != "--"]
            if any(f in ("--recursive",) or (not f.startswith("--") and ("r" in f or "R" in f)) for f in flags):
                ends = words.index("--") if "--" in words else len(words)
                operands = [w for w in words[1:ends] if not w.startswith("-")] + words[ends + 1:]
                for operand in operands:
                    found.extend(resolve(operand, cwd, env))
        elif name == "find" and ("-delete" in words or any(os.path.basename(w) == "rm" for w in words)):
            for operand in words[1:]:
                if operand.startswith(("-", "(", "!")):
                    break
                found.extend(resolve(operand, cwd, env))

    for word in words_of(text):
        if skip:
            skip = False
            continue
        if word in REDIRECTS:
            skip = True
            continue
        if word in SEPARATORS:
            judge(command)
            command = []
            continue
        command.append(word)
    judge(command)
    return found


def check_delete(paths) -> None:
    """Raises TreeRefused for the first path this job may not delete. A failure to judge lets the delete run, like the send guard."""
    for path in paths:
        try:
            reason = refusal(path)
        except Exception:
            reason = None
        if reason:
            raise TreeRefused(reason)


def command_paths(args, cwd, env) -> list:
    if isinstance(args, (list, tuple)) and args and os.path.basename(os.fsdecode(args[0])) in SHELLS and "-c" in [os.fsdecode(a) for a in args[1:-1]]:
        words = [os.fsdecode(a) for a in args]
        return doomed(words[words.index("-c", 1) + 1], cwd, env)
    if isinstance(args, (list, tuple)):
        return doomed(" ".join(shlex.quote(os.fsdecode(a)) for a in args), cwd, env)
    return doomed(os.fsdecode(args), cwd, env)


def refusing_init(original):
    def __init__(self, args, *rest, **kwargs):
        if os.getpid() == KERNEL:
            try:
                cwd = os.fsdecode(kwargs.get("cwd") or os.getcwd())
                paths = command_paths(args, cwd, kwargs.get("env"))
            except Exception:
                paths = []
            check_delete(paths)
        original(self, args, *rest, **kwargs)

    __init__.refuses_others = True
    __init__.records_owner = getattr(original, "records_owner", False)
    return __init__


def refusing_system(original):
    def system(command):
        if os.getpid() == KERNEL:
            try:
                paths = doomed(os.fsdecode(command), os.getcwd(), None)
            except Exception:
                paths = []
            check_delete(paths)
        return original(command)

    system.refuses_others = True
    system.records_owner = getattr(original, "records_owner", False)
    system.__doc__ = original.__doc__
    return system


def refusing_rmtree(original):
    def rmtree(path, *args, **kwargs):
        if os.getpid() == KERNEL and isinstance(path, (str, bytes, os.PathLike)):
            check_delete([os.path.normpath(os.path.abspath(os.fsdecode(path)))])
        return original(path, *args, **kwargs)

    rmtree.refuses_others = True
    rmtree.__doc__ = original.__doc__
    rmtree.avoids_symlink_attacks = getattr(original, "avoids_symlink_attacks", False)
    return rmtree


def install_refusal() -> None:
    if not SESSION:
        return
    if not getattr(os.system, "refuses_others", False):
        os.system = refusing_system(os.system)
    if not getattr(subprocess.Popen.__init__, "refuses_others", False):
        subprocess.Popen.__init__ = refusing_init(subprocess.Popen.__init__)
    if not getattr(shutil.rmtree, "refuses_others", False):
        shutil.rmtree = refusing_rmtree(shutil.rmtree)


install()
install_refusal()
