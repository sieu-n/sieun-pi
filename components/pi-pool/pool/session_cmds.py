"""ls, model, limited, refused and who for one session tree, and the account admin commands
enable, off, on, unlimited and rm."""
import json, math, os, shlex, time

from . import base, registry, sched, vending, status_view, limit_resets


def tree_view(state, key, provider, accounts, f, cfg, now):
    """(accounts, tree, book, cooldowns) for a read-only command about one tree."""
    accounts = registry.with_pool_state(accounts, state, provider)
    accounts = registry.with_models(accounts, [f["model"]] if f.get("model") else registry.session_models(state, key, provider, cfg, now), cfg)
    tree = sched.tree_for(state, key, provider) if key else sched.Tree(pool_pin=state["providers"][provider].get("pin"))
    return accounts, tree, sched.book_for(state, provider, key, cfg, now), state["providers"][provider]["cooldowns"]


def selection_view(tree):
    account_id = tree.pin or tree.pool_pin
    return {"mode": "manual", "account_id": account_id} if account_id else {"mode": "auto"}


def wait_view(d):
    """The wait the tree's next request gets as {account, slot_at}; None when that
    request gets an account. The wait on file can be stale: on 10-18 at 16:21Z
    `who` printed 01a14eb4's backoff to 16:47Z on the Virev seat while its next
    request would have entered claude4, and resume_paused.py held it for that."""
    if isinstance(d, sched.Wait):
        return {"account": d.slot_account.id, "slot_at": math.ceil(d.slot_at)}
    return None


def cmd_ls(rest):
    f = status_view.parse_flags(rest)
    provider = f["provider"]
    cfg, now = base.config(), time.time()
    try:
        accounts = registry.load_index(provider)
    except Exception as e:
        msg = f"cannot load the {provider} pool: {e}"
        print(json.dumps({"error": msg}) if f["json"] else msg)
        return 1
    state = registry.load_state()
    key = status_view.session_key_for(f["session"], state)
    if f["session"] is not None and key is None:
        msg = f"--session {f['session']} matches no known session"
        print(json.dumps({"error": msg}) if f["json"] else msg)
        return 2
    accounts, tree, book, cooldowns = tree_view(state, key, provider, accounts, f, cfg, now)
    d = sched.decide(tree, accounts, book, cooldowns, cfg, now) if key else None
    rows = status_view.build_rows(accounts, tree, book, cooldowns, cfg, now,
                                  state["providers"][provider].get("cooldown_reasons"))
    if provider == "anthropic":
        resets = limit_resets.reset_rows(accounts)
        for row in rows:
            row["resets"] = resets.get(row["id"])
    pin_account = next((a for a in accounts if a.id == state["providers"][provider].get("pin")), None)
    out = {"provider": provider, "session": key.key if key else None,
           "pin": {"id": pin_account.id, "email": pin_account.email, "label": pin_account.label} if pin_account else None,
           "priority": tree.priority, "selection": selection_view(tree),
           "wait": wait_view(d) if key else None, "rows": rows}
    if f["json"]:
        print(json.dumps(out, indent=2))
        return 0
    mode = "Manual" if out["selection"]["mode"] == "manual" else "Auto"
    print(f"{provider}  session {out['session'] or '-'}  {mode}  priority {tree.priority}"
          + (f"  waits for {out['wait']['account']} at {vending.iso(out['wait']['slot_at'])}" if out["wait"] else ""))
    width = max([len("account")] + [len(r["label"]) for r in rows])
    print(f"{'account':{width}s} {'usage':>9}  flags")
    for r in rows:
        flags = []
        if r["pinned"]:
            flags.append("pinned")
        if r["current"]:
            flags.append("current")
        if r["reason"]:
            flags.append(r["reason"])
        print(f"{r['label']:{width}s} {r['usage']:>9}  {' '.join(flags) or 'available'}")
    return 0


def cmd_model(rest):
    """Record the model one session of this process's tree runs, or clear it.
    A Fable cap then only stops an account for trees that run Fable."""
    f = status_view.parse_flags(rest)
    source = f["source"]
    model = f["positional"][0] if f["positional"] else None
    if not source or (not f["clear"] and not model):
        raise SystemExit("usage: pi-pool model (<id> --provider <p> | --clear) --source <session id>")
    key = registry.session_key()
    if key is None:
        return 0
    now = time.time()
    with base.Flock(base.LOCK, timeout=base.STATE_LOCK_TIMEOUT):
        state = registry.load_state()
        recs = registry.tree_records(state, key)
        if not recs and f["clear"]:
            return 0
        if not recs:
            recs = [state["sessions"].setdefault(key.key, {"uuid": key.uuid, "active_id": key.active_id, "last_seen": now, "pins": {}})]
        for rec in recs:
            models = rec.setdefault("models", {})
            for provider in base.PROVIDERS:
                (models.get(provider) or {}).pop(source, None)
        if not f["clear"]:
            recs[0]["models"].setdefault(f["provider"], {})[source] = {"model": model, "at": now}
        for rec in recs:
            models = rec["models"]
            for provider in [p for p, entries in models.items() if not entries]:
                del models[provider]
        base.save_json(base.STATE, state)
    return 0


def cmd_limited(rest):
    """Record a provider 429 and report the next Auto account or wait.
    Manual replies retain the selected identity and the original provider failure."""
    f = status_view.parse_flags(rest)
    provider, until = f["provider"], f["until"]
    if until is None:
        raise SystemExit("usage: pi-pool limited --until <epoch sec> [--since <epoch sec>] [--provider <p>] [--session <id>]")
    cfg, now = base.config(), time.time()
    accounts = registry.load_index(provider)
    with base.Flock(base.LOCK, timeout=base.STATE_LOCK_TIMEOUT):
        state = registry.load_state()
        key = status_view.session_key_for(f["session"], state)
        rec = state["sessions"].get(key.key) if key else None
        last = ((rec or {}).get("vends") or {}).get(provider)
        if not last:
            print(json.dumps({"error": f"no {provider} vend on file for this session"}))
            return 2
        # A request sent before the tree moved to its current account failed on an
        # earlier one, whose limit an earlier report recorded. 2026-10-08 22:28: the
        # in-flight requests of one tree re-reported one Codex account's 429 after each
        # move, and all three codex accounts got its reset (limited 4d16h, at 0% and 8% used).
        stale = f["since"] is not None and last.get("from", last.get("at", 0)) > f["since"]
        if not stale:
            vending.HookWriter(state).set_limit(provider, last["account_id"], until, key, now)
            d = plan_next(state, key, provider, accounts, cfg, now)
            base.save_json(base.STATE, state)
    selection = selection_view(sched.tree_for(state, key, provider))
    manual = selection["mode"] == "manual"
    if stale:
        out = {"account": None, "until": round(until), "next": last["email"], "retry_at": None, "stale": True}
        out["selection"] = selection
        if manual:
            out["next"] = None
        base.log("limited_stale", provider=provider, current=last["email"], session=key.key,
                 sent=vending.iso(f["since"]))
        print(json.dumps(out))
        return 0
    out = {"account": last["email"], "until": round(until), "selection": selection, **next_fields(d)}
    if manual:
        out.update(selection=selection, next=None, retry_at=None)
    base.log("limited", provider=provider, account=last["email"], session=key.key,
             until=vending.iso(until), next=out["next"], retry_at=out["retry_at"] and vending.iso(out["retry_at"]))
    print(json.dumps(out))
    return 0


def plan_next(state, key, provider, accounts, cfg, now):
    """The decision for the tree's retry after its account failed, held in
    state: the cell it enters now, or its slot."""
    return vending.schedule(state, key, provider, accounts, cfg, now, admit_now=False)[0]


def next_fields(d):
    """{"next", "retry_at"}: the account the retry enters now, or the tree's slot."""
    if isinstance(d, (sched.Admit, sched.Stay)):
        return {"next": d.account.label, "retry_at": None}
    if isinstance(d, sched.Wait):
        return {"next": None, "retry_at": math.ceil(d.slot_at)}
    return {"next": None, "retry_at": None}


def cmd_refused(rest):
    """A request of this session tree failed with an error whose text names an
    account-level refusal (account_refusal). Cool the account the tree last
    vended down, as a probe refusal does, and print {"account", "reason",
    "next", "retry_at"}. Error text that names no refusal prints {"reason": null}
    and changes nothing."""
    f = status_view.parse_flags(rest)
    provider = f["provider"]
    reason = base.account_refusal(" ".join(f["positional"]))
    if reason is None:
        state = registry.load_state()
        key = status_view.session_key_for(f["session"], state)
        print(json.dumps({"reason": None, "selection": selection_view(sched.tree_for(state, key, provider))}))
        return 0
    cfg, now = base.config(), time.time()
    accounts = registry.load_index(provider)
    with base.Flock(base.LOCK, timeout=base.STATE_LOCK_TIMEOUT):
        state = registry.load_state()
        key = status_view.session_key_for(f["session"], state)
        last = ((state["sessions"].get(key.key) or {}).get("vends") or {}).get(provider) if key else None
    account = next((a for a in accounts if last and a.id == last["account_id"]), None)
    if account is None:
        print(json.dumps({"error": f"no {provider} vend on file for this session"}))
        return 2
    vending.apply_refusal(provider, account, reason, cfg, now)
    with base.Flock(base.LOCK, timeout=base.STATE_LOCK_TIMEOUT):
        state = registry.load_state()
        d = plan_next(state, key, provider, accounts, cfg, now)
        base.save_json(base.STATE, state)
    out = {"account": account.label, "reason": reason, **next_fields(d)}
    selection = selection_view(sched.tree_for(state, key, provider))
    out["selection"] = selection
    if selection["mode"] == "manual":
        out.update(next=None, retry_at=None)
    base.log("refused", provider=provider, account=account.label, reason=reason, session=key.key, next=out["next"])
    print(json.dumps(out))
    return 0


def cmd_who(rest):
    f = status_view.parse_flags(rest)
    state = registry.load_state()
    key = status_view.session_key_for(f["session"], state)
    if f["session"] is not None and key is None:
        msg = f"--session {f['session']} matches no known session"
        print(json.dumps({"error": msg}) if f["json"] else msg)
        return 2
    cfg, now = base.config(), time.time()
    providers_out = {}
    priority = "normal"
    for provider in base.PROVIDERS:
        try:
            accounts = registry.load_index(provider)
        except Exception as e:
            providers_out[provider] = {"error": str(e)}
            continue
        accounts, tree, book, cooldowns = tree_view(state, key, provider, accounts, f, cfg, now)
        priority = tree.priority
        d = sched.decide(tree, accounts, book, cooldowns, cfg, now)
        res = d if isinstance(d, (sched.Stay, sched.Admit)) else None
        by_id = {a.id: a for a in accounts}
        selected_id = tree.pin or tree.pool_pin
        current = by_id.get(selected_id) if selected_id else by_id.get(tree.current) or (res.account if res else None)
        providers_out[provider] = {
            "account": res.account.id if res else None,
            "email": res.account.email if res else None,
            "label": res.account.label if res else None,
            "reason": res.reason if res else (d.reason if isinstance(d, sched.Blocked) else "wait" if isinstance(d, sched.Wait) else None),
            "pinned": bool(tree.pin or tree.pool_pin),
            "selection": selection_view(tree),
            "shadowed": list(d.shadowed) if isinstance(d, (sched.Stay, sched.Admit, sched.Wait)) and d.shadowed else None,
            "at": tree.current_at or None,
            "wait": wait_view(d),
            "moves_today": len([t for t in tree.moves if now - t < sched.MOVE_WINDOW_SEC]),
            "current": {"id": current.id, "email": current.email, "label": current.label, "session_pct": current.session_pct,
                        "weekly_pct": current.weekly_pct, "gated_pct": current.gated_pct,
                        "next": tree.current is not None and res is not None
                                and res.account.id != tree.current and res.account.label}
                       if current else None,
        }
        if isinstance(d, sched.Blocked):
            why = state["providers"][provider].get("cooldown_reasons", {}).get(d.account_id) or d.reason
            providers_out[provider]["error"] = f"Manual account {current.label if current else d.account_id}: {why}"
    out = {"session": key.key if key else None, "priority": priority, "providers": providers_out}
    if f["json"]:
        print(json.dumps(out, indent=2))
    else:
        for provider, info in out["providers"].items():
            if info.get("error"):
                print(f"{provider:14s} unavailable: {info['error']}")
                continue
            if info["wait"]:
                label = next((a.label for a in registry.load_index(provider) if a.id == info["wait"]["account"]),
                             info["wait"]["account"])
                print(f"{provider:14s} waits for {label} until {vending.iso(info['wait']['slot_at'])}")
                continue
            if not info["email"]:
                print(f"{provider:14s} no account can serve")
                continue
            mode = "Manual" if info["selection"]["mode"] == "manual" else "Auto"
            line = f"{provider:14s} {mode} {info['label']}  ({info['reason']})"
            if info["shadowed"]:
                line += f"  pin {info['shadowed'][0]} {info['shadowed'][1]}"
            print(line)
    return 0


 # The provider entries `enable` writes. Each needs `baseUrl` and `api`: an entry with
# only `apiKey` fails Prime's validateConfig and takes every model down.
ENABLE = {
    "anthropic": {"baseUrl": "https://api.anthropic.com", "api": "anthropic-messages", "args": ""},
    "openai-codex": {"baseUrl": "https://chatgpt.com/backend-api", "api": "openai-codex-responses",
                     "args": " --provider openai-codex"},
}


def cmd_enable(rest):
    if len(rest) != 1 or rest[0] not in ENABLE:
        raise SystemExit("usage: pi-pool enable anthropic|openai-codex")
    provider = rest[0]
    models_path = os.path.join(vending.agent_dir(), "models.json")

    models = base.load_json(models_path, {}) or {}
    providers = models.setdefault("providers", {})
    # The installer's runtime link follows each new release; CODE_ROOT is one
    # installed release, which a later install replaces and prunes.
    hook = os.path.join(base.POOL, "bin", "pi-pool-token")
    if not os.path.exists(hook):
        hook = os.path.join(base.CODE_ROOT, "bin", "pi-pool-token")
    spec = ENABLE[provider]
    # An existing entry keeps its other fields (custom models, overrides); only these three change.
    entry = {**(providers.get(provider) or {}), "baseUrl": spec["baseUrl"], "api": spec["api"],
             "apiKey": f"!{shlex.quote(hook)}{spec['args']}"}
    changed = providers.get(provider) != entry
    if changed:
        providers[provider] = entry
        base.save_json(models_path, models)

    base.log("enable", provider=provider, agent_dir=vending.agent_dir(), changed=changed)
    status = "enabled" if changed else "already enabled"
    print(f"{provider} {status} in {models_path}. The native login remains managed by Prime.")
    return 0


def cmd_toggle(rest, off):
    """`pi-pool off` removes an account from Auto, while Manual pins may use it."""
    verb = "off" if off else "on"
    f = status_view.parse_flags(rest)
    provider, positional = f["provider"], f["positional"]
    if len(positional) != 1:
        raise SystemExit(f"usage: pi-pool {verb} <email|id> [--provider <p>]")
    accounts = registry.load_index(provider)
    account = registry.find_account(accounts, positional[0])
    if account is None:
        raise SystemExit(f"{positional[0]} is not in the {provider} pool ({', '.join(a.label for a in accounts)})")
    with base.Flock(base.LOCK, timeout=base.STATE_LOCK_TIMEOUT):
        state = registry.load_state()
        was_off = account.id in (state["providers"][provider].get("disabled") or {})
        if was_off == off:
            print(f"{account.label} is already {verb}")
            return 0
        vending.IntentWriter(state).set_disabled(provider, account.id, off, time.time())
        base.save_json(base.STATE, state)
    base.log("account_" + verb, provider=provider, account=account.label)
    print(f"{account.label} is {verb}" + ("; excluded from Auto, available in Manual" if off else "; Auto can pick it again"))
    return 0


def cmd_unlimited(rest):
    """`pi-pool unlimited <email|id>`: drop a `pi-pool limited` record the provider
    never meant for this account (2026-10-09: one 429 from one Codex account was
    re-reported after each move and marked all three Codex accounts until
    10-14). A real limit comes back on the next 429."""
    f = status_view.parse_flags(rest)
    provider, positional = f["provider"], f["positional"]
    if len(positional) != 1:
        raise SystemExit("usage: pi-pool unlimited <email|id> [--provider <p>]")
    accounts = registry.load_index(provider)
    account = registry.find_account(accounts, positional[0])
    if account is None:
        raise SystemExit(f"{positional[0]} is not in the {provider} pool ({', '.join(a.label for a in accounts)})")
    with base.Flock(base.LOCK, timeout=base.STATE_LOCK_TIMEOUT):
        state = registry.load_state()
        limit = (state["providers"][provider].get("limits") or {}).pop(account.id, None)
        if limit is None:
            print(f"{account.label} has no limit on file")
            return 0
        base.save_json(base.STATE, state)
    base.log("limit_dropped", provider=provider, account=account.label, reason="unlimited")
    print(f"{account.label} is no longer limited (was until {time.strftime('%Y-%m-%dT%H:%M:%S', time.localtime(limit['until']))})")
    return 0


def cmd_rm(rest):
    """Remove credentials and the index record, preserving Manual selections as missing."""
    f = status_view.parse_flags(rest)
    provider, positional = f["provider"], f["positional"]
    if len(positional) != 1:
        raise SystemExit("usage: pi-pool rm <email|id> [--provider <p>]")
    accounts = registry.load_index(provider)
    account = registry.find_account(accounts, positional[0])
    if account is None:
        raise SystemExit(f"{positional[0]} is not in the {provider} pool ({', '.join(a.label for a in accounts)})")
    with base.index_lock(provider):
        idx = base.read_index(provider)
        idx["accounts"] = [r for r in idx["accounts"] if r["id"] != account.id]
        base.write_index(provider, idx)
        if provider == "anthropic":
            base.kc_delete(base.claude_service(account.id))
        else:
            try:
                os.unlink(base.codex_secret(account.id))
            except FileNotFoundError:
                pass
    with base.Flock(base.LOCK, timeout=base.STATE_LOCK_TIMEOUT):
        state = registry.load_state()
        vending.IntentWriter(state).forget_account(provider, account.id)
        base.save_json(base.STATE, state)
    base.log("account_removed", provider=provider, account=account.label)
    print(f"removed {account.label} from the {provider} pool")
    return 0


def cmd_token(rest):
    """`pi-pool token <email|id> [--provider <p>]`: print the named account's access
    token to a pipe, refreshed under the index lock when it is near expiry, as the
    hook vends it. A terminal gets nothing, so the token never lands in a scrollback.
    It records no vend and moves no tree, and it runs only on the machine that holds
    the accounts."""
    f = status_view.parse_flags(rest)
    provider, positional = f["provider"], f["positional"]
    if len(positional) != 1:
        raise SystemExit("usage: pi-pool token <email|id> [--provider <p>] | <reader>")
    if os.isatty(1):
        raise SystemExit("pi-pool token prints only to a pipe, never a terminal")
    accounts = registry.load_index(provider)
    account = registry.find_account(accounts, positional[0])
    if account is None:
        raise SystemExit(f"{positional[0]} is not in the {provider} pool ({', '.join(a.label for a in accounts)})")
    token, source = vending.credential_for(account, base.config())
    base.log("token_read", provider=provider, account=account.label, source=source)
    os.write(1, token.encode())
    return 0
