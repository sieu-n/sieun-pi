"""Journals each write this Python process makes into a shared auto-sns-agent checkout, so that repo's commit.mjs can refuse a commit that would sweep in another session's bytes.

auto-sns-agent's scripts/repo/agent/commit.mjs stages whole files and refuses a path another live session wrote since its last commit, but only
Claude Code's Write and Edit hook filled the journal it reads. The edit skill (Path.write_text in the kernel), open() in a cell and Mac jobs that
scp into us-metal02's checkout left no record, and on 10-29 three commits (250b096c5, 7d5726a419, f856a11257) took other sessions' hunks.

1. A file opened writable (w, a, x or +) through open(), io.open() or pathlib appends one record when it closes, and so does an os.replace or
   os.rename whose destination is a checkout file. A file opened for append or update records only when its size or mtime changed.
2. A command (bash(), subprocess, os.system) that exits 0 after it ran `scp <files> <box>:<path>`, or `ssh <box>` with `> path`, `cat > path` or
   `tee path`, for a path in an auto-sns-agent checkout, has that box record the paths with `journal.mjs record --tool prime-ssh`.

A record is {"session_id", "path", "tool": "prime-kernel", "ts", "blob", "tool_use_id": null} in <root>/.cache/agent-writes/<UTC day>/<session>.jsonl,
or under $AGENT_WRITES_ROOT. `path` is relative to the checkout and `blob` is the file's blob id as `git hash-object <path>` gives it after the write, so a .gitattributes
filter, text or eol attribute counts as commit.mjs counts it. A checkout is
the nearest folder D above the file's realpath with a .git folder whose .git/agent-shared-checkout names D on its first line. The session id is
the last /session-artifacts/<id>/harness in RLM_HARNESS_STATE_DIR, else CLAUDE_CODE_SESSION_ID or CODEX_THREAD_ID when only one is set, as in
journal.mjs agentId; with none this file records nothing. The prelude in kernel-guard.ts runs it once per kernel, and python-child/sitecustomize.py
once per Python a kernel starts. A journal failure prints one line to stderr and leaves the write alone.
"""

import builtins
import io
import json
import os
import re
import shlex
import subprocess
import sys
import threading
import time
import weakref


def session_id():
    found = re.findall(r"/session-artifacts/([^/]+)/harness$", os.environ.get("RLM_HARNESS_STATE_DIR", ""))
    if found:
        return found[-1]
    ids = {os.environ.get(name) for name in ("CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID")} - {None, ""}
    return ids.pop() if len(ids) == 1 else None


SESSION = session_id()
WRITES_ROOT = os.environ.get("AGENT_WRITES_ROOT")
SKIPPED = {".git", ".cache", "node_modules", "__pycache__"}
MARKER = os.path.join(".git", "agent-shared-checkout")
roots: dict = {}
near: dict = {}
WRITING = frozenset("wax+")
busy = threading.local()
_os_open = os.open


def warn(text: str) -> None:
    """Prints one line to stderr. A closed or broken stderr drops the line, so a journal failure never reaches the write that caused it."""
    try:
        print(text, file=sys.stderr)
    except Exception:
        pass


def checkout_of(folder: str):
    """The shared checkout that holds a real folder, or None. Each folder on the walk is cached, since this runs on every write."""
    walked = []
    current = folder
    while current not in roots:
        walked.append(current)
        try:
            with open(os.path.join(current, MARKER), encoding="utf-8") as handle:
                named = handle.readline().strip()
        except (OSError, ValueError):
            named = ""
        if named and os.path.isdir(os.path.join(current, ".git")) and named == current:
            roots[current] = current
            break
        parent = os.path.dirname(current)
        if parent == current:
            roots[current] = None
            break
        current = parent
    found = roots[current]
    for folder_ in walked:
        roots[folder_] = found
    return found


def checkout_near(path: str):
    """(checkout, real folder) for the folder that holds a path, or None, cached by the unresolved folder. A write outside every checkout
    then costs a dict lookup instead of a realpath walk, which took about 30 of the 80 microseconds a small write took on us-metal02 on 10-29.
    A file symlink from an outside folder into a checkout is not followed."""
    folder = os.path.dirname(path if path[:1] == os.sep else os.path.abspath(path))
    found = near.get(folder, False)
    if found is False:
        real = os.path.realpath(folder)
        root = checkout_of(real)
        found = near[folder] = (root, real) if root else None
    return found


def target_of(file):
    """(checkout, repo-relative POSIX path, real path) for a file in a shared checkout that the journal covers, else None."""
    if not SESSION or isinstance(file, int) or not isinstance(file, (str, bytes, os.PathLike)):
        return None
    path = os.fsdecode(file)
    found = checkout_near(path)
    if found is None:
        return None
    if os.path.islink(path):
        real = os.path.realpath(path)
        root = checkout_of(os.path.dirname(real))
    else:
        root, folder = found
        real = os.path.join(folder, os.path.basename(path))
    if root is None:
        return None
    parts = os.path.relpath(real, root).split(os.sep)
    if SKIPPED.intersection(parts) or ".." in parts or parts == ["."]:
        return None
    if WRITES_ROOT and (real + os.sep).startswith(os.path.realpath(WRITES_ROOT) + os.sep):
        return None
    return root, "/".join(parts), real


# Attributes that make `git hash-object <path>` hash other bytes than the disk holds, as commit.mjs and journal.mjs hash them.
CONVERTING = {"text", "eol", "filter", "ident", "working-tree-encoding", "crlf"}
settings: dict = {}
parsed: dict = {}


def converts(file: str) -> bool:
    """Whether an attributes file sets a converting attribute on any pattern. Each file is read again only when its size or mtime moves."""
    try:
        info = os.stat(file)
    except OSError:
        return False
    key = (info.st_mtime_ns, info.st_size)
    seen = parsed.get(file)
    if seen and seen[0] == key:
        return seen[1]
    found = False
    try:
        with io.FileIO(file) as handle:
            for line in handle.read().decode("utf-8", "replace").splitlines():
                words = line.split()
                if words and not words[0].startswith("#") and any(w.lstrip("-!").split("=")[0] in CONVERTING for w in words[1:]):
                    found = True
                    break
    except OSError:
        found = True
    parsed[file] = (key, found)
    return found


def checkout_settings(root: str):
    """(core.autocrlf converts, attributes files outside the tree) for a checkout, read once per process with `git var -l`. Only the files
    outside the tree that exist then are watched, while each .gitattributes in the tree is checked at every record."""
    if root not in settings:
        try:
            run = subprocess.run(["git", "-C", root, "var", "-l"], capture_output=True, text=True, stdin=subprocess.DEVNULL, check=True)
            values = dict(line.split("=", 1) for line in run.stdout.splitlines() if "=" in line)
            autocrlf = values.get("core.autocrlf", "false").lower() in ("true", "yes", "on", "1", "input")
            files = [values[name] for name in ("GIT_ATTR_SYSTEM", "GIT_ATTR_GLOBAL") if values.get(name)]
        except Exception:
            autocrlf, files = True, []
        outside = files + [os.path.join(root, ".git", "info", "attributes")]
        settings[root] = (autocrlf, [file for file in outside if os.path.exists(file)])
    return settings[root]


def needs_git(root: str, path: str) -> bool:
    """Whether git would convert the path's bytes when it hashes them, so the raw sha1 would differ from commit.mjs's blob."""
    autocrlf, files = checkout_settings(root)
    if autocrlf:
        return True
    folders = path.split("/")[:-1]
    scoped = [os.path.join(root, *folders[:depth], ".gitattributes") for depth in range(len(folders) + 1)]
    return any(converts(file) for file in files + scoped)


def blob_of(root: str, path: str, real: str):
    """git's blob id of the file as `git hash-object <path>` gives it, or None when the file cannot be read. Raw bytes are hashed here,
    and git runs only when an attribute or core.autocrlf could convert them."""
    if needs_git(root, path):
        run = subprocess.run(["git", "-C", root, "hash-object", "--", path], capture_output=True, text=True, stdin=subprocess.DEVNULL, check=False)
        return run.stdout.strip() if run.returncode == 0 else None
    try:
        fd = _os_open(real, os.O_RDONLY)
    except OSError:
        return None
    try:
        import hashlib  # Imported at the first record, since loading OpenSSL took most of the 12 ms this file added to each Python's start.

        info = os.fstat(fd)
        digest = hashlib.sha1(b"blob %d\0" % info.st_size)
        while True:
            chunk = os.read(fd, io.DEFAULT_BUFFER_SIZE)
            if not chunk:
                break
            digest.update(chunk)
        return digest.hexdigest()
    except OSError:
        return None
    finally:
        os.close(fd)


def record(target) -> None:
    """Appends one record for a write that just finished. A failure never reaches the caller."""
    if getattr(busy, "on", False):
        return
    busy.on = True
    try:
        root, path, real = target
        day = time.strftime("%Y-%m-%d", time.gmtime())
        folder = os.path.join(WRITES_ROOT or os.path.join(root, ".cache", "agent-writes"), day)
        line = json.dumps({"session_id": SESSION, "path": path, "tool": "prime-kernel", "ts": int(time.time() * 1000),
                           "blob": blob_of(root, path, real), "tool_use_id": None}) + "\n"
        name = os.path.join(folder, f"{SESSION}.jsonl")
        try:
            fd = _os_open(name, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o644)
        except FileNotFoundError:
            os.makedirs(folder, exist_ok=True)
            fd = _os_open(name, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o644)
        try:
            os.write(fd, line.encode("utf-8"))
        finally:
            os.close(fd)
    except Exception as error:
        warn(f"global-rules: could not journal the write to {target[2]}: {error}")
    finally:
        busy.on = False


def stamp(raw):
    try:
        info = os.fstat(raw.fileno())
        return info.st_size, info.st_mtime_ns
    except (OSError, ValueError):
        return None


def watch_close(handle, target, mode: str) -> None:
    """Hooks the close of the FileIO under an open file. The hook holds the FileIO weakly, so dropping the file still closes it at once."""
    raw = getattr(getattr(handle, "buffer", handle), "raw", handle)
    if not isinstance(raw, io.FileIO):
        return
    before = None if ("w" in mode or "x" in mode) else stamp(raw)
    ref = weakref.ref(raw)

    def close():
        file = ref()
        if file is None:
            return None
        was_closed = file.closed
        after = None if was_closed or before is None else stamp(file)
        try:
            return io.FileIO.close(file)
        finally:
            if not was_closed and (before is None or after != before):
                record(target)

    raw.close = close


def journaling_open(original):
    def open(file, mode="r", *args, **kwargs):
        handle = original(file, mode, *args, **kwargs)
        if SESSION and isinstance(mode, str) and not WRITING.isdisjoint(mode) and not getattr(busy, "on", False):
            try:
                target = target_of(file)
                if target:
                    watch_close(handle, target, mode)
            except Exception as error:
                warn(f"global-rules: could not watch the write to {file!r}: {error}")
        return handle

    open.journals_writes = True
    open.__doc__ = original.__doc__
    if getattr(original, "refuses_transcripts", False):
        open.refuses_transcripts = True
    return open


def journaling_move(original):
    def move(src, dst, *args, **kwargs):
        result = original(src, dst, *args, **kwargs)
        if SESSION and kwargs.get("dst_dir_fd") is None and not getattr(busy, "on", False):
            try:
                target = target_of(dst)
                if target:
                    record(target)
            except Exception as error:
                warn(f"global-rules: could not journal the move to {dst!r}: {error}")
        return result

    move.journals_writes = True
    move.__doc__ = original.__doc__
    return move


# The Mac's jobs write us-metal02's checkout over ssh, and that box's journal.mjs computes the blob from its own disk.
CHECKOUT_PATH = re.compile(r"(?:^|/)auto-sns-agent(?:/|$)")
SSH_VALUED = set("BbcDEeFIiJLlmOoPpQRSWw")
SCP_VALUED = set("cDFiJloPSX")
SEPARATORS = {";", "&", "&&", "|", "||", "|&", "(", ")", "\n", ";;"}
REDIRECTS = {"<", "<<", "<<<", "<&", ">", ">>", ">&", "&>", ">|", "&>>"}
SHELLS = {"sh", "bash", "dash", "zsh"}
KEPT_OPTIONS = set("FiJ")


def words_of(text: str) -> list:
    lexer = shlex.shlex(text, posix=True, punctuation_chars=";&|()<>\n")
    lexer.whitespace = " \t\r"
    lexer.whitespace_split = True
    try:
        return list(lexer)
    except ValueError:
        return text.split()


def remote_paths(text: str) -> list:
    """The checkout files a remote shell command writes: the targets of > and >>, and the operands of tee."""
    words = words_of(text)
    found = []
    for index, word in enumerate(words):
        if word in (">", ">>") and index + 1 < len(words):
            found.append(words[index + 1])
        elif os.path.basename(word) == "tee":
            for operand in words[index + 1:]:
                if operand in SEPARATORS or operand in REDIRECTS:
                    break
                if not operand.startswith("-"):
                    found.append(operand)
    return [p for p in found if CHECKOUT_PATH.search(p)]


def options_of(rest: list, valued: set, port: str):
    """Pops the leading options of an ssh or scp word list and keeps the ones the record call needs, as ssh options."""
    kept = []
    while rest and rest[0].startswith("-") and rest[0] != "--":
        flag = rest.pop(0)
        if flag[-1] in valued and rest:
            value = rest.pop(0)
            if flag[-1] == port:
                kept += ["-p", value]
            elif flag[-1] in KEPT_OPTIONS or (flag[-1] == "o" and value.split("=")[0].lower() in ("user", "port", "identityfile", "proxyjump", "hostname")):
                kept += [flag, value]
    if rest and rest[0] == "--":
        rest.pop(0)
    return tuple(kept)


def remote_writes(text: str) -> list:
    """(ssh destination, ssh options, path) for each checkout file a command writes on another box through scp or ssh."""
    words = words_of(text)
    found = []
    for index, word in enumerate(words):
        name = os.path.basename(word)
        if name in SHELLS and words[index + 1:index + 2] == ["-c"] and index + 2 < len(words):
            found += remote_writes(words[index + 2])
            continue
        if name not in ("ssh", "scp"):
            continue
        rest = []
        for item in words[index + 1:]:
            if item in SEPARATORS or item in REDIRECTS:
                break
            rest.append(item)
        if name == "ssh":
            options = options_of(rest, SSH_VALUED, "p")
            if len(rest) > 1:
                found += [(rest[0], options, p) for p in remote_paths(" ".join(rest[1:]))]
            continue
        options = options_of(rest, SCP_VALUED, "P")
        operands = [w for w in rest if not w.startswith("-")]
        if len(operands) < 2:
            continue
        host, sep, path = operands[-1].partition(":")
        if not sep or not host or "/" in host or not CHECKOUT_PATH.search(path):
            continue
        sources = operands[:-1]
        if path.endswith("/") or len(sources) > 1:
            found += [(host, options, path.rstrip("/") + "/" + os.path.basename(s.rstrip("/"))) for s in sources]
        else:
            found.append((host, options, path))
    return found


def remote_word(path: str) -> str:
    """A remote path as one shell word, with ~ and a home-relative scp path put under $HOME."""
    if path.startswith("~/"):
        return '"$HOME"/' + shlex.quote(path[2:])
    if not path.startswith("/"):
        return '"$HOME"/' + shlex.quote(path)
    return shlex.quote(path)


def record_command(destination: str, options: tuple, paths: list) -> list:
    """The ssh argv that has the box journal the paths through its checkout's journal.mjs record."""
    words = [remote_word(p) for p in paths]
    script = (f'r=$(git -C "$(dirname {words[0]})" rev-parse --show-toplevel) && node "$r/scripts/repo/agent/journal.mjs" record '
              f"--session {shlex.quote(SESSION)} --tool prime-ssh {' '.join(words)}")
    return ["ssh", "-o", "BatchMode=yes", *options, destination, script]


def record_remote(writes: list) -> None:
    """Has each box record the paths written there. A failure prints one line and lets the command's result stand."""
    if getattr(busy, "on", False):
        return
    groups: dict = {}
    for destination, options, path in writes:
        groups.setdefault((destination, options), []).append(path)
    busy.on = True
    try:
        for (destination, options), paths in groups.items():
            try:
                run = subprocess.run(record_command(destination, options, list(dict.fromkeys(paths))), capture_output=True, text=True,
                                     stdin=subprocess.DEVNULL, check=False)
                if run.returncode != 0:
                    detail = (run.stderr.strip().splitlines() or [f"exit {run.returncode}"])[-1]
                    warn(f"global-rules: {destination} did not journal {', '.join(paths)}: {detail}")
            except Exception as error:
                warn(f"global-rules: {destination} did not journal {', '.join(paths)}: {error}")
    finally:
        busy.on = False


def command_text(args) -> str:
    if isinstance(args, (str, bytes, os.PathLike)):
        return os.fsdecode(args)
    return " ".join(shlex.quote(os.fsdecode(a)) for a in args)


def writes_of(args) -> list:
    if not SESSION or getattr(busy, "on", False):
        return []
    try:
        text = command_text(args)
        return remote_writes(text) if ("scp" in text or "ssh" in text) else []
    except Exception:
        return []


def journaling_init(original):
    def __init__(self, args, *rest, **kwargs):
        writes = writes_of(args)
        original(self, args, *rest, **kwargs)
        if writes:
            self.global_rules_remote_writes = writes

    __init__.journals_writes = True
    for flag in ("records_owner", "refuses_others", "refuses_transcripts"):
        if getattr(original, flag, False):
            setattr(__init__, flag, True)
    return __init__


def journaling_exit(original):
    """Popen sets returncode only here, from wait() or poll(), so a remote record runs once, after the command exits 0."""
    def _handle_exitstatus(self, *args, **kwargs):
        result = original(self, *args, **kwargs)
        writes = self.__dict__.pop("global_rules_remote_writes", None)
        if writes and self.returncode == 0:
            record_remote(writes)
        return result

    _handle_exitstatus.journals_writes = True
    return _handle_exitstatus


def journaling_system(original):
    def system(command):
        writes = writes_of(command)
        status = original(command)
        if writes and status == 0:
            record_remote(writes)
        return status

    system.journals_writes = True
    for flag in ("records_owner", "refuses_others", "refuses_transcripts"):
        if getattr(original, flag, False):
            setattr(system, flag, True)
    system.__doc__ = original.__doc__
    return system


def install() -> None:
    if not SESSION or getattr(builtins.open, "journals_writes", False):
        return
    builtins.open = io.open = journaling_open(builtins.open)
    for name in ("replace", "rename"):
        setattr(os, name, journaling_move(getattr(os, name)))
    if not getattr(subprocess.Popen.__init__, "journals_writes", False):
        subprocess.Popen.__init__ = journaling_init(subprocess.Popen.__init__)
    exit_hook = getattr(subprocess.Popen, "_handle_exitstatus", None)
    if exit_hook is not None and not getattr(exit_hook, "journals_writes", False):
        subprocess.Popen._handle_exitstatus = journaling_exit(exit_hook)
    if not getattr(os.system, "journals_writes", False):
        os.system = journaling_system(os.system)


install()
