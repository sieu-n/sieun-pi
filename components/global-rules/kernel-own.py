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
"""

import importlib.util
import json
import os
import re
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


install()
