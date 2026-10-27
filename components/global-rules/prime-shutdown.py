"""Refuses a `prime-agent shutdown` that could stop the live Prime daemon, in a Prime kernel, the Python processes it starts and its systemd-run units.

On 10-27 the live daemon on us-metal02 stopped twice, with every agent on it (~/work/d7-supervisor-exits/TRACE.md). At 16:55:07Z a kernel bash
ran `prime-agent shutdown --force` by name with a scratch HOME and TMPDIR. At 17:07:48Z the unit svh-teardown-r01 ran the release binary by
its full path, `<release>/prime-agent shutdown --force --json`, with the same scratch HOME and TMPDIR. Both runs carried the kernel's
PRIME_AGENT_CODING_AGENT_DIR, so Prime read the live workers' descriptors in ~/.prime/agent/daemon-workers and stopped the supervisor they name.
Prime's shutdown has no form that names one socket (`prime-agent --daemon-socket <s> shutdown` exits 1 with "Unknown option for shutdown"),
so it stops every daemon its environment leads it to, and only a check of those daemons at run time is exact.

unit-env/prime-agent does that check: a kernel finds it first on PATH, and it refuses a shutdown whose `prime-agent status --json`, run in the
same environment, lists the live socket. This file refuses each shutdown that would skip that check:
1. a prime-agent named by a path (a release binary, ~/.local/bin/prime-agent), since only a bare name finds the check on PATH;
2. a bare name in a command that sets PATH or runs under `env -i`, or on a PATH whose first prime-agent is another one;
3. a bare name inside a systemd-run unit that does not get the kernel's PATH with `-E PATH`, or inside ssh, where the check is not on PATH.
It reads `sh -c` strings and the shell scripts a command runs (a word ending in .sh or .bash, the script after sh or bash, and a
path-named program that starts with #!), so a nested shell or a teardown script is judged like the command itself.
kernel-guard.py runs judge() on each subprocess, os.system, os.exec* and os.posix_spawn, and unit-env/systemd-run runs this file on
a unit's command line before it starts the unit.
"""

import os
import re
import shlex
import sys

HERE = os.path.dirname(os.path.realpath(__file__))
SHIM = os.path.join(HERE, "unit-env", "prime-agent")
SHELLS = frozenset({"sh", "bash", "dash", "zsh", "ksh"})
# Options of prime-agent that take a value, so their value is not read as the command (prime-agent --help).
VALUED = frozenset({
    "--mode", "--cwd", "--daemon-socket", "--provider", "--model", "--api-key", "--models", "--thinking", "-r", "--resume", "--fork",
    "--session-dir", "--goal", "--goal-token-budget", "-t", "--tools", "-e", "--extension", "--skill", "--prompt-template", "--theme",
    "--system-prompt", "--append-system-prompt", "--autonomous-gate", "--autonomous-gate-retries", "--autonomous-gate-timeout-ms",
    "--autonomous-max-continuations", "--autonomous-max-turns", "--autonomous-max-tokens", "--autonomous-timeout-ms",
})
PATH_CHANGE = re.compile(r"(?<![\w$])PATH=|\benv\b[^;&|\n]*\s(?:-[a-zA-Z]*i\b|--ignore-environment\b|-u\s*PATH\b|--unset[= ]PATH\b)")
DURATION = re.compile(r"\d+(?:\.\d+)?[smhd]?")
ASSIGN = re.compile(r"^[A-Za-z_]\w*=")
# Programs that run the next word as a program, so `timeout 60 sh x.sh` reads x.sh as sh's script.
WRAPPERS = frozenset({"env", "timeout", "nice", "nohup", "exec", "command", "setsid", "stdbuf", "time", "sudo"})
SCRIPT_MAX = 256 * 1024
DEPTH = 4
HINT = re.compile(r"shutdown|\.(?:sh|bash)\b|(?:^|[\s;&|(])(?:\S*/)?(?:ba|da|z|k)?sh\s+[^-\s]|(?:^|[\s;&|(])\.{0,2}/|(?:^|[\s;&|(])~/")
USAGE = (
    "To stop a scratch daemon, stop its unit (systemctl --user stop <unit>), or run `prime-agent shutdown` by name from a kernel bash"
    " with HOME, TMPDIR and PRIME_AGENT_CODING_AGENT_DIR all in scratch, where unit-env/prime-agent checks which daemons it would stop."
    " To restart one stuck agent, run `prime-agent stop <agent>`."
)


class PrimeShutdownRefused(PermissionError):
    pass


def shim_first(path: str) -> bool:
    """Whether the first prime-agent on this PATH is unit-env/prime-agent."""
    for folder in path.split(os.pathsep):
        candidate = os.path.join(folder, "prime-agent")
        if folder and os.access(candidate, os.X_OK) and not os.path.isdir(candidate):
            return os.path.realpath(candidate) == os.path.realpath(SHIM)
    return False


def tokens(text: str) -> list:
    lexer = shlex.shlex(text, posix=True, punctuation_chars=";&|()<>")
    lexer.whitespace_split = True
    lexer.commenters = ""
    try:
        return list(lexer)
    except ValueError:
        return text.split()


def commands(text: str) -> list:
    out, current = [], []
    for token in tokens(text):
        if token and all(c in ";&|()<>" for c in token):
            if current:
                out.append(current)
            current = []
        else:
            current.append(token)
    if current:
        out.append(current)
    return out


def command_of(args: list, start: int) -> str:
    skip = False
    for arg in args[start:]:
        if skip:
            skip = False
        elif arg in VALUED:
            skip = True
        elif not arg.startswith("-"):
            return arg
    return ""


def script_text(word: str, cwd: str, program: bool) -> str:
    path = os.path.join(cwd, os.path.expanduser(word))
    try:
        if not os.path.isfile(path) or os.path.getsize(path) > SCRIPT_MAX:
            return ""
        with open(path, "rb") as handle:
            head = handle.read(2)
            if program and head != b"#!":
                return ""
            data = head + handle.read(SCRIPT_MAX)
    except OSError:
        return ""
    return data.decode("utf-8", "replace")


class Judge:
    def __init__(self, path: str, cwd: str):
        self.path = path
        self.cwd = cwd

    def text(self, text: str, remote: bool, depth: int):
        if depth > DEPTH or not HINT.search(text):
            return None
        changed = bool(PATH_CHANGE.search(text))
        for words in commands(text):
            if words[0] == "cd" and len(words) > 1:
                self.cwd = os.path.join(self.cwd, os.path.expanduser(words[1]))
            hit = self.argv(words, remote, depth, changed)
            if hit:
                return hit
        return None

    def argv(self, words: list, remote: bool, depth: int, changed: bool = False):
        program = True
        script_next = False
        for i, word in enumerate(words):
            name = os.path.basename(word)
            if program and ASSIGN.match(word):
                continue
            if name == "prime-agent" and command_of(words, i + 1) == "shutdown":
                hit = self.verdict(word, remote, changed)
                if hit:
                    return hit
            if name == "ssh" or (name == "systemd-run" and not unit_gets_path(words[i + 1:])):
                remote = True
            body = ""
            if any(c in word for c in " \n;&|"):
                hit = self.text(word, remote, depth + 1)
                if hit:
                    return hit
            elif word.endswith((".sh", ".bash")) or (script_next and not word.startswith("-")):
                body = script_text(word, self.cwd, False)
            elif program and "/" in word:
                body = script_text(word, self.cwd, True)
            if body:
                hit = self.text(body, remote, depth + 1)
                if hit:
                    return hit
            if program and (word.startswith("-") or DURATION.fullmatch(word)) and i:
                continue
            if program:
                script_next = name in SHELLS
                program = name in WRAPPERS
            elif script_next and not word.startswith("-"):
                script_next = False
        return None

    def verdict(self, word: str, remote: bool, changed: bool):
        if "/" in word:
            if os.path.realpath(os.path.expanduser(word)) == os.path.realpath(SHIM):
                return None
            return f"`{word} shutdown` names prime-agent by its path, which skips unit-env/prime-agent's check of the daemons it would stop"
        if remote:
            return "`prime-agent shutdown` runs in a systemd-run unit without `-E PATH` or over ssh, where unit-env/prime-agent is not on PATH"
        if changed:
            return "`prime-agent shutdown` runs with PATH set or under `env -i`, so it may not find unit-env/prime-agent"
        if not shim_first(self.path):
            return "`prime-agent shutdown` runs on a PATH whose first prime-agent is not unit-env/prime-agent"
        return None


def unit_gets_path(args: list) -> bool:
    """Whether systemd-run's options pass the caller's PATH to the unit (-E PATH or --setenv=PATH with no value)."""
    return any(a == "PATH" and p in ("-E", "--setenv") for p, a in zip(args, args[1:])) or "--setenv=PATH" in args


def refusal(args, cwd=None, env=None, unit: bool = False):
    """The reason this command would run an unchecked `prime-agent shutdown`, or None. `args` is a shell string or an argv list, and
    `unit` says it runs where unit-env/prime-agent is not on PATH."""
    names = env if isinstance(env, dict) else os.environ
    path = os.fsdecode(names.get("PATH", names.get(b"PATH", b"")) if isinstance(names, dict) else os.environ.get("PATH", ""))
    judge = Judge(path, os.fsdecode(cwd) if cwd else os.getcwd())
    if isinstance(args, (str, bytes, os.PathLike)):
        return judge.text(os.fsdecode(args), unit, 0)
    words = [os.fsdecode(a) for a in args]
    if not HINT.search(" ".join(words)):
        return None
    return judge.argv(words, unit, 0, any(PATH_CHANGE.search(w) for w in words))


def message(reason: str) -> str:
    return f"prime-agent shutdown refused: {reason}. It could stop the live daemon and every agent on this box, as on 10-27 at 16:55Z and 17:07Z. {USAGE}"


def program_argv(program, argv):
    """argv with the program that really runs in front, since Popen's executable and os.exec*'s path win over argv[0]."""
    if program is None or isinstance(argv, (str, bytes, os.PathLike)):
        return argv
    return [program, *list(argv)[1:]]


def hook(event: str, args: tuple) -> None:
    if event == "subprocess.Popen":
        reason = refusal(program_argv(args[0], args[1]), args[2], args[3])
    elif event == "os.system":
        reason = refusal(args[0])
    elif event in ("os.exec", "os.posix_spawn"):
        reason = refusal(program_argv(args[0], args[1]), None, args[2])
    else:
        return
    if reason:
        raise PrimeShutdownRefused(message(reason))


def install() -> None:
    if getattr(sys, "global_rules_prime_shutdown", False):
        return
    sys.global_rules_prime_shutdown = True
    sys.addaudithook(hook)


def main(argv: list) -> int:
    """unit-env/systemd-run's check of a unit: `python3 prime-shutdown.py --unit <systemd-run args>`. A unit gets the kernel's PATH only
    through -E PATH (or --setenv=PATH), so a bare `prime-agent shutdown` passes only then."""
    args = argv[1:] if argv[:1] == ["--unit"] else argv
    reason = refusal(args, unit=not unit_gets_path(args))
    if reason:
        print(f"systemd-run: {message(reason)}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
elif __name__ == "global_rules_prime_shutdown":
    install()
