"""A provider 429 for one session tree: `pi-pool limited`, and the spool that keeps the report while the pool flock is busy.

On 10-19 35 of 1,927 anthropic 429s on us-metal02 met a pool flock busy past STATE_LOCK_TIMEOUT. `limited` exited 1
with no log line, and each session kept the vendor reset and slept 72 to 250 min (drought-resume/ext-429). A report
that cannot take the flock now writes one file to SPOOL without the lock and answers from state.json with the spool
applied on top, as the locked run would have answered. Every holder of the pool flock (pool_lock) applies the spooled
reports to state.json first, once each, and logs each one. Unlocked readers (`who`, `ls`, `status`, the hook's
lock-busy path) see them through unlocked_state until then."""
import contextlib, json, math, os, time, uuid

from . import base, registry, sched, vending

SPOOL = os.path.join(base.POOL, "limited-spool")
# The ids of the reports a drain applied, in state.json, so a drain that dies before it removes a file never applies
# that file again.
DRAINED = "limited_spool_drained"


@contextlib.contextmanager
def pool_lock():
    """The pool flock, with every spooled report applied to state.json before the caller reads it."""
    with base.Flock(base.LOCK, timeout=base.STATE_LOCK_TIMEOUT) as lock:
        drain()
        yield lock


def unlocked_state():
    """state.json as a reader without the flock sees it, with each report still in the spool applied on top. The
    spool is read before state.json, so a report that a drain removes in between is already in the file."""
    events = [event for _, event in spooled()]
    state = registry.load_state()
    done = set(state.get(DRAINED) or ())
    for event in events:
        if event and event["id"] not in done:
            mark(state, event)
    return state


def spooled():
    """[(file name, report or None when unreadable)] in the order they were written."""
    try:
        names = sorted(n for n in os.listdir(SPOOL) if n.endswith(".json") and not n.startswith("."))
    except OSError:
        return []
    out = []
    for name in names:
        try:
            with open(os.path.join(SPOOL, name)) as f:
                event = json.load(f)
        except FileNotFoundError:
            continue
        except (OSError, ValueError):
            event = None
        if not isinstance(event, dict) or event.get("provider") not in base.PROVIDERS or not event.get("tree"):
            event = None
        out.append((name, event))
    return out


def write(event):
    """One report as one file, in one rename, without the pool flock."""
    os.makedirs(SPOOL, mode=0o700, exist_ok=True)
    tmp = os.path.join(SPOOL, f".{event['id']}.{os.getpid()}.tmp")
    with open(tmp, "w") as f:
        f.write(json.dumps(event))
    os.replace(tmp, os.path.join(SPOOL, event["id"] + ".json"))


def sweep_dead_writers():
    """Remove `.<id>.<pid>.tmp` files whose writer is gone."""
    try:
        names = os.listdir(SPOOL)
    except OSError:
        return
    for name in names:
        parts = name.split(".")
        if not name.startswith(".") or not name.endswith(".tmp") or len(parts) < 4 or not parts[-2].isdigit():
            continue
        try:
            os.kill(int(parts[-2]), 0)
        except ProcessLookupError:
            with contextlib.suppress(FileNotFoundError):
                os.remove(os.path.join(SPOOL, name))
        except PermissionError:
            pass


def drain():
    """Apply each spooled report to state.json, under the pool flock the caller holds: the same writes and the same
    log line as a `limited` run that took the flock, with `spool` naming the report. The state write carries the ids
    it applied (DRAINED), and the files go only after it, so a crash at any point applies each report once."""
    try:
        if not os.listdir(SPOOL):
            return
    except OSError:
        return
    try:
        if not os.listdir(SPOOL):
            return
    except OSError:
        return
    try:
        sweep_dead_writers()
        files = spooled()
        if not files:
            return
        state = registry.load_state()
        done = set(state.get(DRAINED) or ())
        cfg, now = base.config(), time.time()
        indexes, applied = {}, []
        for _, event in files:
            if event is None or event["id"] in done:
                continue
            provider = event["provider"]
            if provider not in indexes:
                indexes[provider] = registry.load_index(provider)
            applied.append((event, *apply(state, event, indexes[provider], cfg, now)))
        state[DRAINED] = [event["id"] for _, event in files if event]
        base.save_json(base.STATE, state)
        for event, last, stale, d in applied:
            log_report(state, event, last, stale, d, spool=event["id"])
        for name, event in files:
            if event is None:
                base.log("limited_spool_unreadable", file=name)
            with contextlib.suppress(FileNotFoundError):
                os.remove(os.path.join(SPOOL, name))
    except Exception as e:
        base.log("limited_spool_drain_failed", error=f"{type(e).__name__}: {e}"[:300])


def key_of(event):
    return registry.SessionKey(event["tree"], event.get("uuid"), event.get("session"))


def last_vend(state, key, provider):
    rec = state["sessions"].get(key.key) if key else None
    return ((rec or {}).get("vends") or {}).get(provider)


def is_stale(last, since):
    """A request sent before the tree moved to its current account failed on an earlier one, whose limit an earlier
    report recorded. 2026-10-08 22:28: the in-flight requests of one tree re-reported one Codex account's 429 after
    each move, and all three codex accounts got its reset (limited 4d16h, at 0% and 8% used)."""
    return since is not None and last.get("from", last.get("at", 0)) > since


def mark(state, event):
    """A report's writes before the scheduler runs: the limit on the account the tree last vended, and the wait the
    report promised when the tree has none on file. Returns (vend on file or None, stale)."""
    key, provider = key_of(event), event["provider"]
    last = last_vend(state, key, provider)
    if not last:
        return None, False
    if is_stale(last, event["since"]):
        return last, True
    writer = vending.HookWriter(state)
    writer.set_limit(provider, last["account_id"], event["until"], key, event["at"])
    wait = event.get("wait")
    if wait and not sched.tree_for(state, key, provider).wait:
        writer.set_wait(key, provider, wait["account"], wait["slot_at"], event["at"])
    return last, False


def apply(state, event, accounts, cfg, now):
    """A report's writes under the pool flock: mark, then the scheduler's next step for the tree. Returns
    (vend on file or None, stale, decision)."""
    last, stale = mark(state, event)
    if not last or stale:
        return last, stale, None
    return last, stale, plan_next(state, key_of(event), event["provider"], accounts, cfg, now)


def plan_next(state, key, provider, accounts, cfg, now):
    """The decision for the tree's retry after its account failed, held in
    state: the cell it enters now, or its slot."""
    return vending.schedule(state, key, provider, accounts, cfg, now, admit_now=False)[0]


def promised(d, now):
    """The wait `schedule(admit_now=False)` writes for decision `d`, which a spooled report carries so the drain
    holds the slot its answer named."""
    if isinstance(d, sched.Admit):
        return {"account": d.account.id, "slot_at": now}
    if isinstance(d, sched.Wait):
        return {"account": d.slot_account.id, "slot_at": d.slot_at}
    return None


def next_fields(d):
    """{"next", "retry_at"}: the account the retry enters now, or the tree's slot."""
    if isinstance(d, (sched.Admit, sched.Stay)):
        return {"next": d.account.label, "retry_at": None}
    if isinstance(d, sched.Wait):
        return {"next": None, "retry_at": math.ceil(d.slot_at)}
    return {"next": None, "retry_at": None}


def answer(state, event, last, stale, d):
    """The JSON `limited` prints. Manual replies retain the selected identity and the original provider failure."""
    selection = sched.selection_view(sched.tree_for(state, key_of(event), event["provider"]))
    manual = selection["mode"] == "manual"
    if stale:
        return {"account": None, "until": round(event["until"]), "next": None if manual else last["email"],
                "retry_at": None, "stale": True, "selection": selection}
    out = {"account": last["email"], "until": round(event["until"]), "selection": selection, **next_fields(d)}
    if manual:
        out.update(next=None, retry_at=None)
    return out


def log_report(state, event, last, stale, d, name=None, **extra):
    out = answer(state, event, last, stale, d)
    if stale:
        base.log(name or "limited_stale", provider=event["provider"], current=last["email"], session=event["tree"],
                 sent=vending.iso(event["since"]), **extra)
    else:
        base.log(name or "limited", provider=event["provider"], account=last["email"], session=event["tree"],
                 until=vending.iso(event["until"]), next=out["next"],
                 retry_at=out["retry_at"] and vending.iso(out["retry_at"]), **extra)
    return out


def new_event(key, provider, last, until, since, now):
    return {"id": f"{int(now * 1e6)}-{os.getpid()}-{uuid.uuid4().hex[:8]}", "provider": provider,
            "tree": key.key, "uuid": key.uuid, "session": key.active_id,
            "account_id": last["account_id"], "email": last["email"],
            "until": until, "since": since, "at": now, "wait": None}


def cmd_limited(rest):
    """Record a provider 429 and report the next Auto account or wait. When the pool flock stays busy past
    STATE_LOCK_TIMEOUT, spool the report and answer from unlocked_state; only a failed spool write fails the run."""
    from . import status_view
    f = status_view.parse_flags(rest)
    provider, until = f["provider"], f["until"]
    if until is None:
        raise SystemExit("usage: pi-pool limited --until <epoch sec> [--since <epoch sec>] [--provider <p>] [--session <id>]")
    cfg, now = base.config(), time.time()
    accounts = registry.load_index(provider)
    try:
        with pool_lock():
            state = registry.load_state()
            key = status_view.session_key_for(f["session"], state)
            last = last_vend(state, key, provider)
            if last:
                event = new_event(key, provider, last, until, f["since"], now)
                last, stale, d = apply(state, event, accounts, cfg, now)
                if not stale:
                    base.save_json(base.STATE, state)
    except TimeoutError as busy:
        state = unlocked_state()
        key = status_view.session_key_for(f["session"], state)
        last = last_vend(state, key, provider)
        if last:
            event = new_event(key, provider, last, until, f["since"], now)
            last, stale = mark(state, event)
            d = None if stale else vending.decision(state, key, provider, accounts, cfg, now)[0]
            if not stale:
                event["wait"] = promised(d, now)
                try:
                    write(event)
                except OSError as e:
                    # The e6f11e98 path: the run fails, and the extension drops the reset of an Auto session.
                    base.log("limited_spool_failed", provider=provider, account=last["email"], session=key.key,
                             error=f"{type(e).__name__}: {e}"[:300])
                    raise busy
                print(json.dumps(log_report(state, event, last, stale, d, name="limited_spooled", spool=event["id"])))
                return 0
    if not last:
        print(json.dumps({"error": f"no {provider} vend on file for this session"}))
        return 2
    print(json.dumps(log_report(state, event, last, stale, d)))
    return 0
