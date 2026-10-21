#!/usr/bin/env python3
"""pi-pool: vend a pooled OAuth access token to Prime Agent (pi), for Claude
(anthropic) and Codex (openai-codex).

Prime Agent resolves a provider apiKey of the form "!<this script> [--provider
<p>]" by executing the command and using stdout as the API key. Both wire
protocols accept a bare access token as the apiKey (pi-ai sniffs
"sk-ant-oat" for the Claude OAuth path; the openai-codex provider decodes the
account id straight out of the JWT), so a short-lived ACCESS token is all
either provider ever needs.

Prime receives access tokens only. This script reads the pool's own account
store (~/.config/pi-pool/accounts: an index per provider, a Keychain item or
0600 file per Claude account, a 0600 auth.json per Codex account), refreshes in
place under the index lock, and prints only an access token. A machine with
remote.json asks the machine that holds the accounts instead (pool/remote.py).
Private rotation journals live under the pool state directory.

stdout = the token, and nothing else. All diagnostics go to the log file.

This file is the entry point. It loads the pool/ package next to it (load_pool)
and holds the command table and main().
"""

import importlib.util, os, signal, sys, time


def load_pool(name):
    """The pool/ package next to the real vend.py, loaded fresh as `name`.

    The folder comes from realpath(__file__), so a link to vend.py (the installed
    ~/.config/pi-pool/vend.py) finds the release it names. The current directory,
    sys.path and PI_POOL_DIR never select a module. Each load of vend.py gets its
    own modules, so its paths come from its own environment and no state is shared
    through sys.modules with another load."""
    for loaded in [m for m in sys.modules if m == name or m.startswith(name + ".")]:
        del sys.modules[loaded]
    folder = os.path.join(os.path.dirname(os.path.realpath(__file__)), "pool")
    spec = importlib.util.spec_from_file_location(name, os.path.join(folder, "__init__.py"),
                                                  submodule_search_locations=[folder])
    package = importlib.util.module_from_spec(spec)
    sys.modules[name] = package
    spec.loader.exec_module(package)
    return package


if __name__ == "__main__":
    # Before the modules load: a run as a script writes no bytecode into the release.
    sys.dont_write_bytecode = True
pool = load_pool(__name__ + ".pool")


USAGE = """usage: pi-pool [command]
  status [--provider <p>]        one card per account: usage bars, sessions, score, waiters, switches today
  watch [sec] [--provider <p>]   full-screen status, redrawn every sec seconds (default 5)
  pin <email> [--provider <p>]   force EVERY request onto one account until unpin
  unpin [--provider <p>]         release the pool pin (each session keeps its own account again)
  switch [--provider <p>] [--session <id>]  this session's next request moves to another account
  use <email|id> [--follow] [--provider <p>] [--session <id>] [--new-session]
                                  pin (or, with --follow, unpin) this session tree
  priority high|normal|low [--label] [--session <id>]
                                  the tree's class: who gets slots first, and its daily move budget;
                                  --label: the owner's sidebar label, which the tree's children get too
  ls [--json] [--provider <p>] [--session <id>] [--model <id>]
                                  the rows /account renders; --model judges per-model caps
                                  for that model instead of the session's recorded ones
  who [--json] [--session <id>] [--model <id>]
                                  what this session resolves to now, per provider, and its wait
  limited --until <epoch sec> [--since <epoch sec>] [--provider <p>] [--session <id>]
                                  the provider answered 429 for this session's account; every
                                  pin yields to it until then. Prints the next account, or null
                                  and retry_at, the session's own slot time.
                                  --since: when the failed request was sent; a request sent before
                                  the session moved to its account marks nothing ("stale")
  unlimited <email|id> [--provider <p>]
                                  drop a limited record that was not this account's (a real
                                  limit comes back on the next 429)
  token <email|id> [--provider <p>]
                                  print the account's access token to a pipe (never a terminal),
                                  refreshed under the index lock as the hook does; holder only
  refused <error text> [--provider <p>] [--session <id>]
                                  a request failed with an account-level refusal (terms not
                                  accepted, OAuth off); cool this session's account down for
                                  24 h. Prints the next account or null
  model (<id> --provider <p> | --clear) --source <session id>
                                  record the model one session of this tree runs; the
                                  /account extension calls it on session start and model change
  enable openai-codex            wire the openai-codex provider into models.json
  off <email|id> [--provider <p>]
                                  keep an account pooled but never pick it
  on <email|id> [--provider <p>] let the pool pick it again
  rm <email|id> [--provider <p>] delete the account's credential and record, then drop its pins here
  login [<email|id>] [--provider <p>] [--timeout <sec>]
                                  sign in (Claude: OAuth with a localhost callback or a pasted code;
                                  Codex: a device code) as JSON lines, then file the login with
                                  the machine that holds the accounts
  refresh [<email|id> ...] [--provider <p>] [--json | --stream]
                                  read usage now for every account or the named ones;
                                  --stream prints one JSON line per event while the reads run
  resets [<email|id> ...] [--json]
                                  read each Claude account's banked usage-limit resets (spends nothing)
  reset <email|id> [--grant <id>] [--json]
                                  spend one banked reset; rerun within 10 min after an unknown outcome
  probe [--force]                check every anthropic account for an API refusal (no refresh);
                                  the extension runs it at session start, at most every 6h
  adopt-logins                   move a stored /login that would bypass the pool into
                                  fallback.json (the /account extension runs this per session)
  admit <session> [--tree <root>] [--pid <n>] [--wait | --renew]
                                  ask for a working slot for one session run; prints
                                  {"state","kind","position","total"}. --wait blocks until admitted;
                                  --renew renews a running session's lease and never queues it.
                                  --tree defaults to this process's session tree, --pid to the
                                  caller, whose exit ends the run
  release <session>              free the turn's slot or drop its queue entry
  owner-turn <session>           the session's next admit is the owner's and runs at once
  lead [<session>...]            replace the sessions whose queued runs start first; no
                                  sessions clears the list
  queue [--json]                 working and queued turns
  snapshot --json [--thread <session> <model>]... [--tree <session>]...
                                  queue --json, config, and per thread who --json and ls --json for
                                  each provider, as one JSON object of {code, out, err} parts, each
                                  what the separate command prints; "" for no session or model;
                                  per --tree the class and label its record holds, null for none
  config                         print the merged config
  set <key> <value>              persist a config override
  log [n]                        last n pool events (default 20)
  sample                         read each account whose usage figure is due (the pool host's
                                  timer runs it every minute)
  file-login                     file the sign-in harvest on stdin in this machine's store
  serve                          answer another machine's token requests and account commands
                                  on the tailnet address in serve.json (pool/remote.py)
  hookd [--release <link>]       answer the token hook and pool commands on <pool dir>/hook.sock
                                  from one resident Python (pool/hookd.py); exits when <link>
                                  stops naming the release it loaded
"""


def cli(args):
    cmd, rest = (args[0] if args else "status"), args[1:]
    handlers = {
        "status": pool.status_view.cmd_status, "watch": pool.status_view.cmd_watch,
        "pin": pool.commands.cmd_pin, "unpin": pool.commands.cmd_unpin, "switch": pool.commands.cmd_switch,
        "use": pool.commands.cmd_use, "ls": pool.session_cmds.cmd_ls, "who": pool.session_cmds.cmd_who,
        "config": pool.commands.cmd_config, "set": pool.commands.cmd_set, "log": pool.commands.cmd_log,
        "enable": pool.session_cmds.cmd_enable, "adopt-logins": pool.vending.cmd_adopt_logins,
        "probe": pool.vending.cmd_probe, "refresh": pool.commands.cmd_refresh,
        "resets": pool.limit_resets.cmd_resets, "reset": pool.limit_resets.cmd_reset,
        "off": lambda rest: pool.session_cmds.cmd_toggle(rest, True),
        "on": lambda rest: pool.session_cmds.cmd_toggle(rest, False),
        "rm": pool.session_cmds.cmd_rm, "login": pool.signin.cmd_login, "model": pool.session_cmds.cmd_model,
        "limited": pool.limited.cmd_limited, "refused": pool.session_cmds.cmd_refused,
        "unlimited": pool.session_cmds.cmd_unlimited, "token": pool.session_cmds.cmd_token, "priority": pool.commands.cmd_priority,
        "admit": pool.turns.cmd_admit, "release": pool.turns.cmd_release,
        "owner-turn": pool.turns.cmd_owner_turn, "lead": pool.turns.cmd_lead, "queue": pool.turns.cmd_queue,
        "serve": pool.remote.cmd_serve, "hookd": pool.hookd.cmd_hookd, "sample": pool.usage.cmd_sample, "file-login": pool.signin.cmd_file_login,
        "snapshot": lambda rest: pool.snapshot.cmd_snapshot(rest, cli),
    }
    if cmd in handlers:
        return handlers[cmd](rest)
    raise SystemExit(USAGE)


def log_when_killed(provider):
    """Prime runs the hook under a 10 s timeout and drops its stderr, so a hook it
    kills leaves no trace anywhere. Log the kill. Both clocks start at main();
    `wall_sec` far above `awake_sec`
    means the Mac slept while the hook ran (2026-10-08 21:20-21:44: every failed
    hook call fell in a sleep or dark-wake window and the log had no line)."""
    wall, awake = time.time(), time.monotonic()

    def on_term(signum, frame):
        at = []
        while frame is not None and len(at) < 8:
            at.append(f"{frame.f_code.co_name}:{frame.f_lineno}")
            frame = frame.f_back
        pool.base.log("hook_killed", provider=provider, signal=signum, session=os.environ.get(pool.base.SESSION_ENV),
                      wall_sec=round(time.time() - wall, 1), awake_sec=round(time.monotonic() - awake, 1), at=at)
        raise SystemExit(128 + signum)
    signal.signal(signal.SIGTERM, on_term)


def main():
    argv = sys.argv[1:]
    remote = pool.remote.client()
    if remote and pool.remote.forwards(argv):
        return pool.remote.run_remote(remote, argv)
    if argv and argv[0] == "--cli":
        return cli(argv[1:])
    if "--status" in argv:
        return pool.status_view.cmd_status([])
    provider = "anthropic"
    if "--provider" in argv:
        provider = argv[argv.index("--provider") + 1]
    log_when_killed(provider)
    try:
        pool.vending.vend(provider)
    except SystemExit:
        raise
    except Exception as e:
        # This hook IS the credential path for every request on this provider: a
        # crash here would surface as "No API key found". Both providers degrade
        # to the user's own login that adopt-logins moved into fallback.json.
        pool.base.log("vend_error", error=f"{type(e).__name__}: {e}", provider=provider)
        try:
            token = pool.vending.fallback_token(provider, pool.base.config())
        except Exception as fe:
            pool.base.log("fallback_error", error=f"{type(fe).__name__}: {fe}", provider=provider)
            token = None
        if token:
            sys.stdout.write(token)
            return
        raise


if __name__ == "__main__":
    sys.exit(main() or 0)
