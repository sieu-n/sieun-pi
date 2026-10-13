"""pin, unpin, switch, config, set, log, use, priority, and the usage refresh."""
import json, os, queue, re, shutil, subprocess, sys, threading, time

from . import base, registry, sched, vending, status_view


def cmd_pin(rest):
    f = status_view.parse_flags(rest)
    provider, positional = f["provider"], f["positional"]
    if not positional:
        raise SystemExit("usage: pi-pool pin <email> [--provider <p>]")
    accounts = registry.load_index(provider)
    account = registry.find_account(accounts, positional[0])
    if account is None:
        known = ", ".join(a.label for a in accounts)
        raise SystemExit(f"{positional[0]} is not in the {provider} pool ({known})")
    with base.Flock(base.LOCK, timeout=base.STATE_LOCK_TIMEOUT):
        state = registry.load_state()
        if account.id in (state["providers"][provider].get("disabled") or {}):
            raise SystemExit(f"{account.label} is off; turn it on first (pi-pool on {account.label} --provider {provider})")
        if state["providers"][provider].get("pin") == account.id:
            print(f"already pinned: {account.label}")
            return 0
        vending.IntentWriter(state).set_pool_pin(provider, account.id)
        base.save_json(base.STATE, state)
    base.log("pin", provider=provider, account=account.label)
    print(f"pinned: every {provider} request now vends {account.label} "
          f"(release with: pi-pool unpin --provider {provider})")
    return 0


def cmd_unpin(rest):
    f = status_view.parse_flags(rest)
    provider = f["provider"]
    with base.Flock(base.LOCK, timeout=base.STATE_LOCK_TIMEOUT):
        state = registry.load_state()
        was = state["providers"][provider].get("pin")
        if not was:
            print(f"nothing pinned for {provider}")
            return 0
        vending.IntentWriter(state).clear_pool_pin(provider)
        base.save_json(base.STATE, state)
    base.log("unpin", provider=provider, account=was)
    print(f"unpinned {was}; each session keeps its own account again ({provider})")
    return 0


def cmd_switch(rest):
    """This session's next request leaves the account it is on for the best
    account that takes it now (R2-R4); with none, it stays."""
    f = status_view.parse_flags(rest)
    provider = f["provider"]
    with base.Flock(base.LOCK, timeout=base.STATE_LOCK_TIMEOUT):
        state = registry.load_state()
        key = status_view.session_key_for(f["session"], state)
        current = sched.tree_for(state, key, provider).current if key else None
        if current is None:
            print(f"no {provider} account on file for this session; nothing to switch from")
            return 2
        vending.IntentWriter(state).leave(key, provider, current, time.time())
        base.save_json(base.STATE, state)
    base.log("switch_asked", provider=provider, session=key.key, account=current)
    print(f"the next {provider} request of this session moves off {current}")
    return 0


def cmd_config(rest=()):
    print(json.dumps(base.config(), indent=2))
    return 0


def cmd_set(rest):
    if len(rest) != 2:
        raise SystemExit("usage: pi-pool set <key> <value>")
    key, value = rest
    if key not in base.DEFAULTS:
        raise SystemExit(f"unknown key {key}; known: {', '.join(sorted(base.DEFAULTS))}")
    d = base.DEFAULTS[key]
    if isinstance(d, bool):
        val = value.lower() in ("1", "true", "yes", "on")
    elif isinstance(d, int):
        val = int(value)
    elif isinstance(d, float):
        val = float(value)
    elif isinstance(d, list):
        val = [s for s in value.split(",") if s]
    elif isinstance(d, dict):
        val = json.loads(value)
        if not isinstance(val, dict):
            raise SystemExit(f"{key} takes a JSON object, like {json.dumps(d)}")
    else:
        val = value
    cur = base.load_json(base.CONFIG, {}) or {}
    cur[key] = val
    base.save_json(base.CONFIG, cur)
    print(f"{key} = {json.dumps(val)} (in {base.CONFIG})")
    return 0


def cmd_log(rest):
    n = int(rest[0]) if rest else 20
    try:
        entries = open(base.LOG).readlines()[-n:]
    except FileNotFoundError:
        entries = []
    sys.stdout.write("".join(entries))
    return 0


def write_key(f, state):
    """The tree a CLI write names: --session, else this process's tree. A tree
    with no record yet is accepted only as a full uuid with --new-session (`use`)
    or always (`priority`), since the hook keys a tree by its root uuid and a
    record under that uuid applies from the tree's first request."""
    key = status_view.session_key_for(f["session"], state)
    if key is None and base.SESSION_UUID_RE.fullmatch(f["session"] or ""):
        key = registry.SessionKey(f["session"], f["session"], None)
    if key is None:
        if f["session"] is not None:
            print(f"--session {f['session']} matches no known session")
        else:
            print("no session id in this environment. Run this inside a Prime Agent "
                  "session, or pass --session <id>.")
    return key


def cmd_use(rest):
    f = status_view.parse_flags(rest)
    provider, positional = f["provider"], f["positional"]
    if f["force"]:
        print("--force is gone: a pin applies only when its account can take the session "
              f"(5h under {base.config()['admit_5h_max_pct']}%), on the next request")
        return 2
    with base.Flock(base.LOCK, timeout=base.STATE_LOCK_TIMEOUT):
        state = registry.load_state()
        known = status_view.session_key_for(f["session"], state)
        if known is None and f["session"] is not None and not f["new_session"]:
            print(f"--session {f['session']} matches no known session")
            return 2
        key = write_key(f, state)
        if key is None:
            return 2
        rec = state["sessions"].get(key.key, {})
        prev_pin = (rec.get("pins") or {}).get(provider)

        if f["follow"]:
            if not prev_pin:
                print("already following the pool")
                return 0
            vending.IntentWriter(state).clear_pin(key, provider)
            base.save_json(base.STATE, state)
            base.log("use", session=key.key, provider=provider, account=None,
                     previous=prev_pin["account_id"])
            print(f"following the pool ({provider})")
            return 0

        if not positional:
            raise SystemExit("usage: pi-pool use <email|id> [--follow] [--new-session]")
        try:
            accounts = registry.load_index(provider)
        except Exception as e:
            print(f"cannot load the {provider} pool: {e}")
            return 2
        account = registry.find_account(accounts, positional[0])
        if account is None:
            known = ", ".join(a.label for a in accounts)
            print(f"{positional[0]} is not in the {provider} pool ({known})")
            return 2
        if account.id in (state["providers"][provider].get("disabled") or {}):
            print(f"{account.label} is off; turn it on first (pi-pool on {account.label} --provider {provider})")
            return 2
        if prev_pin and prev_pin["account_id"] == account.id:
            print(f"already on {account.label}")
            return 0
        vending.IntentWriter(state).set_pin(key, provider, account.id, "cli", time.time())
        base.save_json(base.STATE, state)
        base.log("use", session=key.key, provider=provider, account=account.label,
                 previous=prev_pin["account_id"] if prev_pin else None)
        print(f"{account.label} selected for this session tree; the next request moves there "
              f"if it can take the tree, and later moves prefer it")
        return 0


def cmd_priority(rest):
    """R7: `pi-pool priority high|normal|low [--label] [--session id]` sets the tree's class.
    One class per tree, whatever the provider. --label says the class is the owner's
    sidebar label, which the turn queue gives the tree's child sessions too."""
    labeled = "--label" in rest
    f = status_view.parse_flags([tok for tok in rest if tok != "--label"])
    positional = f["positional"]
    if len(positional) != 1 or positional[0] not in sched.PRIORITIES:
        raise SystemExit("usage: pi-pool priority high|normal|low [--label] [--session <id>] [--provider <p>]")
    with base.Flock(base.LOCK, timeout=base.STATE_LOCK_TIMEOUT):
        state = registry.load_state()
        key = write_key(f, state)
        if key is None:
            return 2
        prev = (state["sessions"].get(key.key) or {}).get("priority") or "normal"
        vending.IntentWriter(state).set_priority(key, positional[0], time.time(), labeled)
        base.save_json(base.STATE, state)
    if prev != positional[0]:
        base.log("priority", session=key.key, priority=positional[0], previous=prev)
    print(f"{key.key}: {positional[0]}")
    return 0


USAGE_READ = os.path.join(base.CODE_ROOT, "app", "usage-read.ts")
_WRAPPER_RUN = re.compile(r'exec\s+"([^"]+)"\s.*?\brun\s+"([^"]+)/main\.ts"')


def tokenmaxxing_exe():
    own = os.path.join(base.TM, "bin", "tokenmaxxing")
    return own if os.access(own, os.X_OK) else shutil.which("tokenmaxxing")


def tokenmaxxing_runtime():
    """The Bun binary and the `src` directory of the tokenmaxxing install the
    wrapper runs. usage-read.ts imports tokenmaxxing's own read and save code
    from that directory, so the read always matches the installed release."""
    exe = tokenmaxxing_exe()
    if not exe:
        raise RuntimeError("tokenmaxxing is not installed")
    real = os.path.realpath(exe)
    if real.endswith(os.path.join("src", "main.ts")):
        bun = shutil.which("bun")
        if not bun:
            raise RuntimeError("bun is not on PATH")
        return bun, os.path.dirname(real)
    try:
        with open(real, encoding="utf-8", errors="replace") as fh:
            match = _WRAPPER_RUN.search(fh.read(4096))
    except OSError as e:
        raise RuntimeError(f"cannot read {exe}: {e}")
    if not match:
        raise RuntimeError(f"cannot find the tokenmaxxing source behind {exe}")
    return match.group(1), match.group(2)


def read_usage(selection, emit, timeout=registry.REFRESH_TIMEOUT_SEC):
    """Run usage-read.ts once per provider, all at once, and pass each event to
    `emit` with its provider, email and label. `selection` maps a provider to account
    ids, or to None for every account. An account still unread at the deadline
    is reported as not finished. Returns the providers that failed as a whole."""
    bun, src = tokenmaxxing_runtime()
    env = dict(os.environ, TOKENMAXXING_HOME=base.TM)
    events, procs, errors, pumps = queue.Queue(), {}, {}, []
    for provider, ids in selection.items():
        proc = subprocess.Popen([bun, "--no-env-file", USAGE_READ, src, provider, *(ids or [])], stdin=subprocess.DEVNULL,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env)
        procs[provider] = proc

        def pump(provider=provider, proc=proc):
            for line in proc.stdout:
                events.put((provider, line))
            events.put((provider, None))
        pumps.append(threading.Thread(target=pump, daemon=True))
        pumps[-1].start()
    emails, pending, open_, listed = {}, {p: set() for p in procs}, set(procs), set()
    labels = {}
    for provider in procs:
        try:
            labels.update({(provider, a.id): a.label for a in registry.load_index(provider)})
        except Exception:
            pass
    deadline = time.monotonic() + timeout
    while open_:
        try:
            provider, line = events.get(timeout=max(0.0, deadline - time.monotonic()))
        except queue.Empty:
            break
        if line is None:
            open_.discard(provider)
            continue
        try:
            event = json.loads(line)
        except ValueError:
            continue
        if not isinstance(event, dict):
            continue
        kind = event.get("event")
        if kind == "accounts":
            listed.add(provider)
            for a in event.get("accounts") or []:
                emails[(provider, a.get("id"))] = a.get("email")
                a["label"] = labels.get((provider, a.get("id"))) or a.get("email")
                pending[provider].add(a.get("id"))
        elif kind == "read":
            pending[provider].discard(event.get("id"))
        elif kind == "error":
            errors[provider] = str(event.get("message") or "usage-read failed")
        if kind in ("reading", "read"):
            event["email"] = emails.get((provider, event.get("id")))
            event["label"] = labels.get((provider, event.get("id"))) or event["email"]
        emit(dict(event, provider=provider))
    for provider, proc in procs.items():
        killed = proc.poll() is None
        if killed:
            proc.kill()
        proc.wait()
        said = (proc.stderr.read() or "").strip().splitlines()
        if proc.returncode and provider not in errors and provider not in listed:
            errors[provider] = (f"usage-read did not finish in {timeout}s" if killed
                                else said[-1] if said else f"usage-read exited {proc.returncode}")[:300]
            emit({"event": "error", "provider": provider, "message": errors[provider]})
        for account in sorted(pending[provider], key=str):
            emit({"event": "read", "provider": provider, "id": account, "email": emails.get((provider, account)),
                  "label": labels.get((provider, account)) or emails.get((provider, account)),
                  "ok": False, "reason": f"the read did not finish in {timeout}s", "retry_at": None})
    for pump in pumps:
        pump.join(timeout=5)
    for proc in procs.values():
        proc.stdout.close()
        proc.stderr.close()
    return errors


def cmd_refresh(rest):
    """Read usage now for every account, or for the named ones, through
    tokenmaxxing's own read (app/usage-read.ts). It skips no account for having
    been read recently, but it waits out a rate limit the usage endpoint set.
    It writes only tokenmaxxing's usage figures and moves no session or pin.
    --stream prints each event as one JSON line while the reads run; --json
    prints one report at the end. Never prints a credential."""
    stream = "--stream" in rest
    f = status_view.parse_flags([tok for tok in rest if tok != "--stream"], provider_default=None)
    as_json = f["json"] or stream

    def fail(msg):
        print(json.dumps({"event": "error", "message": msg} if stream else {"error": msg}) if as_json else msg, flush=True)
        return 1

    if f["provider"] is not None and f["provider"] not in base.PROVIDERS:
        return fail(f"unknown provider {f['provider']}")
    if f["positional"] and f["provider"] is None:
        return fail("name the provider with --provider when choosing accounts")
    selection = {}
    for provider in [f["provider"]] if f["provider"] else list(base.PROVIDERS):
        if not f["positional"]:
            selection[provider] = None
            continue
        try:
            accounts = registry.load_index(provider)
        except Exception as e:
            return fail(f"cannot load the {provider} pool: {e}")
        ids = []
        for sel in f["positional"]:
            account = registry.find_account(accounts, sel)
            if account is None:
                return fail(f"{sel} is not in the {provider} pool")
            ids.append(account.id)
        selection[provider] = ids

    rows = {provider: [] for provider in selection}

    def emit(event):
        if event.get("event") == "read":
            rows[event["provider"]].append({k: event.get(k) for k in ("id", "email", "label", "ok", "reason", "retry_at", "usage_at")})
        if stream:
            print(json.dumps(event), flush=True)
        elif not as_json and event.get("event") == "read":
            print(f"{event['provider']:14s} {event.get('label') or event.get('id')}  {'read' if event.get('ok') else event.get('reason')}", flush=True)

    try:
        errors = read_usage(selection, emit)
    except RuntimeError as e:
        return fail(str(e))
    failed = [r["label"] or r["id"] for provider_rows in rows.values() for r in provider_rows if not r["ok"]]
    base.log("usage_refresh", providers=list(selection), accounts=sum(len(r) for r in rows.values()), failed=failed, errors=errors)
    failed_claude = {r["id"] for r in rows.get("anthropic", []) if not r["ok"]}
    if failed_claude:
        vending.probe_failed_reads(failed_claude)
    if stream:
        print(json.dumps({"event": "end"}), flush=True)
    elif as_json:
        print(json.dumps({"providers": rows, **({"errors": errors} if errors else {})}, indent=2))
    else:
        for provider, message in errors.items():
            print(f"{provider:14s} {message}")
    return 1 if errors else 0
