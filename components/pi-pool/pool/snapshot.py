"""`pi-pool snapshot --json`: the reads the chat service polls, answered by one process.

Each part is what the separate command prints, from the same handler with the same
argv, as {"code", "out", "err"}: `queue --json`, `config`, and per thread `who --json`
and `ls --json --provider <p>` with its --session and --model. A part that the
separate command would send to the machine that holds the accounts (remote.json)
goes there the same way. It writes nothing and takes the locks those commands take."""
import contextlib, io, json, sys, traceback

from . import base, remote

USAGE = 'usage: pi-pool snapshot --json [--thread <session or ""> <model or "">]...'


def parse(rest):
    """[(session or None, model or None)] from the --thread pairs."""
    threads, i = [], 0
    while i < len(rest):
        if rest[i] == "--json":
            i += 1
        elif rest[i] == "--thread" and i + 2 < len(rest):
            threads.append((rest[i + 1] or None, rest[i + 2] or None))
            i += 3
        else:
            raise SystemExit(USAGE)
    return threads


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
    threads = parse(list(rest))
    out = {"queue": captured(cli, ["queue", "--json"]), "config": captured(cli, ["config"]), "threads": [
        {"session": session, "model": model, "who": captured(cli, ["who", "--json", *thread_args(session, model)]),
         "ls": {provider: captured(cli, ["ls", "--json", "--provider", provider, *thread_args(session, model)])
                for provider in base.PROVIDERS}}
        for session, model in threads]}
    sys.stdout.write(json.dumps(out) + "\n")
    return 0
