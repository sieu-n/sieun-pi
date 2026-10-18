"""pin, unpin, switch, config, set, log, use, priority, and the usage refresh."""
import json, os, sys, time

from . import base, registry, sched, usage, vending, status_view


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


def setter():
    """Who runs `pi-pool set` when it has no --by: the Prime session that runs it, else the parent pid."""
    if os.environ.get(base.SESSION_ENV):
        return "Prime session " + os.environ[base.SESSION_ENV]
    return f"a shell outside Prime (parent pid {os.getppid()})"


def cmd_set(rest):
    rest = list(rest)
    by = None
    if "--by" in rest:
        i = rest.index("--by")
        by = rest[i + 1] if i + 1 < len(rest) else None
        del rest[i:i + 2]
    if len(rest) != 2 or (by is not None and not by.strip()):
        raise SystemExit("usage: pi-pool set <key> <value> [--by <who>]")
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
    was, by = base.config().get(key), by or setter()
    cur[key] = val
    cur.setdefault("set_by", {})[key] = {"by": by, "at": round(time.time())}
    base.save_json(base.CONFIG, cur)
    base.log("set", key=key, value=val, was=was, by=by)
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


def cmd_refresh(rest):
    """Read usage now for every account, or for the named ones (pool/usage.py).
    It skips no account for having been read recently, but it waits out a rate
    limit the usage endpoint set. It writes only the index's usage figures and
    moves no session or pin.
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

    errors = usage.read_many(selection, emit)
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
