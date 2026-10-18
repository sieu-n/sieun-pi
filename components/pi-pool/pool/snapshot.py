"""`pi-pool snapshot --json`: the reads the chat service polls, answered by one process.

Each part is what the separate command prints, from the same handler with the same
argv, as {"code", "out", "err"}: `queue --json`, `config`, and per thread `who --json`
and `ls --json --provider <p>` with its --session and --model. A part that the
separate command would send to the machine that holds the accounts (remote.json)
goes there the same way. Per --tree session it gives the class `priority --session` keeps on
that tree's record (`trees`). It writes nothing and takes the locks those commands take."""
import contextlib, io, json, sys, traceback

from . import base, registry, remote, status_view

USAGE = 'usage: pi-pool snapshot --json [--thread <session or ""> <model or "">]... [--tree <session>]...'


def parse(rest):
    """([(session or None, model or None)] from the --thread pairs, [session] from the --tree flags)."""
    threads, trees, i = [], [], 0
    while i < len(rest):
        if rest[i] == "--json":
            i += 1
        elif rest[i] == "--thread" and i + 2 < len(rest):
            threads.append((rest[i + 1] or None, rest[i + 2] or None))
            i += 3
        elif rest[i] == "--tree" and i + 1 < len(rest) and rest[i + 1]:
            trees.append(rest[i + 1])
            i += 2
        else:
            raise SystemExit(USAGE)
    return threads, trees


def tree_classes(sessions):
    """Per session, the record `priority --session <session>` writes (commands.write_key): its class as
    the pool reads it (rec.get("priority") or "normal") and its sidebar label, or null priority when
    the tree has no record yet."""
    if not sessions:
        return []
    with base.Flock(base.LOCK, timeout=base.STATE_LOCK_TIMEOUT):
        state = registry.load_state()
        out = []
        for session in sessions:
            key = status_view.session_key_for(session, state)
            if key is None and base.SESSION_UUID_RE.fullmatch(session):
                key = registry.SessionKey(session, session, None)
            rec = state["sessions"].get(key.key) if key else None
            out.append({"session": session, "priority": (rec.get("priority") or "normal") if rec is not None else None,
                        "label": rec.get("priority_label") if rec is not None else None})
    return out


def captured(cli, argv):
    """{"code", "out", "err"} of `pi-pool <argv>` as main() runs it."""
    cfg = remote.client()
    if cfg and remote.forwards(["--cli", *argv]):
        try:
            code, out, err = remote.ask(cfg, ["--cli", *argv])
        except remote.Unreachable as e:
            return {"code": 1, "out": "", "err": f"pi-pool: {e}\n"}
        return {"code": code, "out": out, "err": err}
    out, err = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        try:
            code = cli(argv) or 0
        except SystemExit as e:
            code = e.code if isinstance(e.code, int) else 0 if e.code is None else 1
            if not isinstance(e.code, int) and e.code is not None:
                print(e.code, file=sys.stderr)
        except Exception:
            traceback.print_exc()
            code = 1
    return {"code": code, "out": out.getvalue(), "err": err.getvalue()}


def thread_args(session, model):
    return [*(["--session", session] if session else []), *(["--model", model] if model else [])]


def cmd_snapshot(rest, cli):
    threads, trees = parse(list(rest))
    out = {"queue": captured(cli, ["queue", "--json"]), "config": captured(cli, ["config"]), "threads": [
        {"session": session, "model": model, "who": captured(cli, ["who", "--json", *thread_args(session, model)]),
         "ls": {provider: captured(cli, ["ls", "--json", "--provider", provider, *thread_args(session, model)])
                for provider in base.PROVIDERS}}
        for session, model in threads], "trees": tree_classes(trees)}
    sys.stdout.write(json.dumps(out) + "\n")
    return 0
