"""The Mac-wide turn queue: `admit`, `release`, `owner-turn` and `queue`.

One run of one session holds one working slot, from the run's first model call to its
agent_end. state.json keeps the queue under the pool flock in state["turns"]:

    working  {session: {tree, parent, class, kind, since, pid, lease_until}}
    queued   {session: {tree, parent, class, since, pid, waiter}}
    owner    {session: epoch sec of the owner-turn mark}

Order: an owner turn runs at once and never waits. Then queued turns take free slots
by class, high before normal before low, longest wait first inside a class, while the
Mac has under mac_working_max working turns and the tree under tree_working_max. A
queued entry moves up one class for every queue_aging_s it has waited. A child whose
parent's turn is in flight and that finds no slot borrows the parent's slot: a parent
lends at most one slot at a time, so the borrow pushes the total over the limit by at
most one per parent in flight. Every working turn counts toward both limits.

The pi-pool extension asks at a run's first model call (`admit --wait`), renews the
slot's lease every few minutes while the run is live (`admit --renew`), and releases
at agent_end or when it finds the session idle. A slot whose
lease ran out, or whose process (`pid`, the Prime worker that asked) is gone, is
dropped, and so is a queue entry whose `admit --wait` process (`waiter`) is gone, so
an abort with no agent_end or a crash cannot hold a slot.
"""
import json, os, sys, time

from . import base, registry

CLASSES = ("low", "normal", "high")
# An owner-turn mark that no admit consumed is dropped after this long. A mark waits
# for the session's next turn, which starts after the turn in flight ends: the 99th
# percentile turn was 2,956 s over the 22,675 turns of 10-11 to 10-14
# (agent-queue-design/data/turns.json, measure_turns.py).
OWNER_MARK_TTL_SEC = 3600
# `admit --wait` re-reads state.json this often while queued.
WAIT_POLL_SEC = 1.0
# The flock wait for an admit or release. A token hook waits base.STATE_LOCK_TIMEOUT.
LOCK_TIMEOUT = 6.0


def limits(cfg):
    """(mac max or None when the queue is off, tree max, aging seconds)."""
    if not int(cfg["agent_queue_on"]):
        return None, None, None
    return int(cfg["mac_working_max"]), int(cfg["tree_working_max"]), max(1, int(cfg["queue_aging_s"]))


def empty():
    return {"working": {}, "queued": {}, "owner": {}}


def of(state):
    turns = state.setdefault("turns", empty())
    for key in ("working", "queued", "owner"):
        turns.setdefault(key, {})
    return turns


def alive(pid):
    if not isinstance(pid, int) or pid <= 1:
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def rank(entry, now, aging):
    """The class an entry queues in now: its own, one step up per aging period waited."""
    steps = int(max(0.0, now - entry["since"]) // aging)
    return min(len(CLASSES) - 1, CLASSES.index(entry["class"]) + steps)


def order(queued, now, aging):
    """Queued session ids in admission order."""
    return sorted(queued, key=lambda s: (-rank(queued[s], now, aging), queued[s]["since"], s))


def sweep(turns, now, is_alive=alive):
    """Drop entries whose process is gone, slots whose lease ran out, and owner marks
    past their time. Returns what went."""
    gone = []
    for part in ("working", "queued"):
        for session, entry in list(turns[part].items()):
            why = ("process gone" if not is_alive(entry.get("pid"))
                   else "waiter gone" if entry.get("waiter") is not None and not is_alive(entry["waiter"])
                   else "lease ran out" if entry.get("lease_until", now) < now else None)
            if why:
                del turns[part][session]
                gone.append({"session": session, "part": part, "since": entry.get("since"), "why": why})
    for session, at in list(turns["owner"].items()):
        if now - at > OWNER_MARK_TTL_SEC:
            del turns["owner"][session]
    return gone


def lending(turns):
    """Parent session -> the child running on its lent slot."""
    return {e["lender"]: s for s, e in turns["working"].items() if e.get("kind") == "borrow"}


def admit_pass(turns, now, mac_max, tree_max, aging, lease=None):
    """Move queued entries to working: free slots by class first, then borrows.
    Returns [(session, kind)] in the order they were admitted."""
    lease = lease or base.DEFAULTS["lease_s"]
    admitted = []
    queue = order(turns["queued"], now, aging)
    trees = {}
    for entry in turns["working"].values():
        trees[entry["tree"]] = trees.get(entry["tree"], 0) + 1

    def start(session, kind, **extra):
        entry = turns["queued"].pop(session)
        entry.pop("waiter", None)
        turns["working"][session] = dict(entry, kind=kind, since=now, queued_since=entry["since"], lease_until=now + lease, **extra)
        trees[entry["tree"]] = trees.get(entry["tree"], 0) + 1
        admitted.append((session, kind))

    for session in queue:
        if len(turns["working"]) >= mac_max:
            break
        if trees.get(turns["queued"][session]["tree"], 0) < tree_max:
            start(session, "slot")
    lent = lending(turns)
    for session in [s for s in queue if s in turns["queued"]]:
        parent = turns["queued"][session].get("parent")
        if parent and parent in turns["working"] and parent not in lent:
            start(session, "borrow", lender=parent)
            lent[parent] = session
    return admitted


def reply(turns, session, now, aging, enabled=True):
    """The admit answer for one session, as the CLI prints it."""
    if not enabled:
        return {"state": "off", "kind": None, "position": None, "total": None}
    if session in turns["working"]:
        return {"state": "admitted", "kind": turns["working"][session]["kind"], "position": None, "total": None}
    if session in turns["queued"]:
        queue = order(turns["queued"], now, aging)
        return {"state": "queued", "kind": None, "position": queue.index(session) + 1, "total": len(queue)}
    return {"state": "released", "kind": None, "position": None, "total": None}


def view(turns, now, cfg):
    """`pi-pool queue --json`."""
    mac, tree_max, aging = limits(cfg)
    aging = aging or max(1, int(cfg["queue_aging_s"]))
    queue = order(turns["queued"], now, aging)
    working = [{"session": s, "tree": e["tree"], "parent": e.get("parent"), "class": e["class"], "kind": e["kind"],
                "since": e["since"]} for s, e in sorted(turns["working"].items(), key=lambda kv: kv[1]["since"])]
    queued = [{"session": s, "tree": turns["queued"][s]["tree"], "parent": turns["queued"][s].get("parent"),
               "class": CLASSES[rank(turns["queued"][s], now, aging)], "base_class": turns["queued"][s]["class"],
               "position": i + 1, "total": len(queue), "since": turns["queued"][s]["since"],
               "wait_s": round(now - turns["queued"][s]["since"])} for i, s in enumerate(queue)]
    return {"enabled": mac is not None, "mac_working_max": int(cfg["mac_working_max"]),
            "mac_working_max_set": last_set("mac_working_max"),
            "tree_working_max": int(cfg["tree_working_max"]), "working": working, "queued": queued}


def last_set(key):
    """Who set `key` and when ({by, at} in epoch seconds) from `pi-pool set`; None while the key holds its default.
    A value written before `set` recorded its writer has by None and config.json's file time."""
    saved = base.load_json(base.CONFIG, {}) or {}
    if key not in saved:
        return None
    return (saved.get("set_by") or {}).get(key) or {"by": None, "at": round(os.path.getmtime(base.CONFIG))}


# --------------------------------------------------------------------- the CLI
def parse(rest):
    usage = ("usage: pi-pool admit <session> [--tree <root session>] [--parent <session>] "
             "[--class high|normal|low] [--pid <n>] [--wait | --renew]")
    out = {"session": None, "tree": None, "parent": None, "class": None, "pid": None, "wait": False, "renew": False}
    i = 0
    while i < len(rest):
        tok = rest[i]
        if tok in ("--wait", "--renew"):
            out[tok[2:]] = True
        elif tok in ("--tree", "--parent", "--class", "--pid"):
            if i + 1 >= len(rest):
                raise SystemExit(usage)
            out[tok[2:]] = rest[i + 1]
            i += 1
        elif out["session"] is None and not tok.startswith("--"):
            out["session"] = tok
        else:
            raise SystemExit(usage)
        i += 1
    if (not out["session"] or (out["class"] is not None and out["class"] not in CLASSES)
            or (out["wait"] and out["renew"])):
        raise SystemExit(usage)
    out["pid"] = int(out["pid"]) if out["pid"] is not None else os.getppid()
    return out


def class_for(a, sessions):
    """--class, else: a child (with --parent) is normal unless the owner labeled its
    tree High in the sidebar, and a root takes its tree's pool priority."""
    if a["class"]:
        return a["class"]
    rec = sessions.get(a["tree"]) or {}
    if a["parent"]:
        return "high" if rec.get("priority_label") == "high" else "normal"
    return rec.get("priority") or "normal"


def ask(turns, sessions, a, now, cfg, waiter=None):
    """One admit, under the flock. Returns (changed, answer, events to log).

    A session already working renews its lease. --renew comes from a run in flight:
    a session whose slot lapsed (a Mac asleep past the lease) works again at once and
    never queues, because the queue never stops a running turn."""
    session, lease = a["session"], int(cfg["lease_s"])
    mac, tree_max, aging = limits(cfg)
    if mac is None:
        dropped = turns["queued"].pop(session, None) is not None
        return dropped, reply(turns, session, now, aging, enabled=False), []
    gone = sweep(turns, now)
    admitted = admit_pass(turns, now, mac, tree_max, aging, lease)
    events = [("turn_swept", dict(session=g["session"], part=g["part"], why=g["why"])) for g in gone]
    changed = True
    entry = {"tree": a["tree"], "parent": a["parent"], "class": class_for(a, sessions), "since": now, "pid": a["pid"]}
    if session in turns["working"]:
        turns["working"][session].update(pid=a["pid"], lease_until=now + lease)
    elif session in turns["queued"] and not a["renew"]:
        turns["queued"][session].update(pid=a["pid"], waiter=waiter)
    elif turns["owner"].pop(session, None) is not None:
        turns["queued"].pop(session, None)
        turns["working"][session] = dict(entry, kind="owner", queued_since=now, lease_until=now + lease)
        admitted.append((session, "owner"))
    elif a["renew"]:
        was = turns["queued"].pop(session, None)
        turns["working"][session] = dict(entry, kind="slot", queued_since=(was or entry)["since"], lease_until=now + lease)
        events.append(("turn_renewed_after_lapse", dict(session=session, tree=a["tree"])))
    else:
        turns["queued"][session] = dict(entry, waiter=waiter)
        admitted += admit_pass(turns, now, mac, tree_max, aging, lease)
        if session in turns["queued"]:
            events.append(("turn_queued", {"session": session, "tree": a["tree"], "parent": a["parent"], "class": entry["class"],
                                           "working": len(turns["working"]), "queued": len(turns["queued"])}))
    for s, kind in admitted:
        e = turns["working"][s]
        events.append(("turn_admitted", dict(session=s, tree=e["tree"], kind=kind, waited_s=round(now - e["queued_since"], 1))))
    return changed, reply(turns, session, now, aging), events


def emit(answer):
    sys.stdout.write(json.dumps(answer) + "\n")
    sys.stdout.flush()


def locked(fn):
    """Run fn(state, turns, now) under the pool flock; save when it returns True first."""
    with base.Flock(base.LOCK, timeout=LOCK_TIMEOUT):
        state = registry.load_state()
        turns = of(state)
        now = time.time()
        changed, result = fn(state, turns, now)
        if changed:
            base.save_json(base.STATE, state)
    return result


def log_changes(gone, admitted, turns, now):
    for g in gone:
        base.log("turn_swept", session=g["session"], part=g["part"], why=g["why"])
    for session, kind in admitted:
        e = turns["working"][session]
        base.log("turn_admitted", session=session, tree=e["tree"], kind=kind, waited_s=round(now - e["queued_since"], 1))


def step(turns, now, cfg):
    """Sweep, then admit what fits. Returns (changed, gone, admitted)."""
    gone = sweep(turns, now)
    mac, tree_max, aging = limits(cfg)
    admitted = admit_pass(turns, now, mac, tree_max, aging, int(cfg["lease_s"])) if mac is not None else []
    return bool(gone or admitted), gone, admitted


def cmd_admit(rest):
    a = parse(rest)
    if a["tree"] is None:
        key = registry.session_key()
        a["tree"] = key.key if key else a["session"]
    waiter = os.getpid() if a["wait"] else None

    def enter(state, turns, now):
        changed, answer, events = ask(turns, state["sessions"], a, now, base.config(), waiter)
        for event, fields in events:
            base.log(event, **fields)
        return changed, answer

    answer = locked(enter)
    emit(answer)
    if not a["wait"] or answer["state"] != "queued":
        return 0
    return wait(a["session"], a["pid"], answer)


def wait(session, pid, last):
    """Block until `session` is admitted. Prints one JSON line each time its place
    changes, and the admitted (or off) line last. Takes the flock only when an
    unlocked read shows that a sweep and an admit pass would admit this session, so
    a hundred waiters do not queue on the lock the token hook shares."""
    seen = None
    while True:
        time.sleep(WAIT_POLL_SEC)
        if not alive(pid):
            release(session, reason="turn process gone")
            return 1
        try:
            mtime = os.stat(base.STATE).st_mtime_ns
        except OSError:
            mtime = None
        cfg = base.config()
        mac, tree_max, aging = limits(cfg)
        if mac is None:
            release(session, reason="queue off")
            emit({"state": "off", "kind": None, "position": None, "total": None})
            return 0
        now = time.time()
        if mtime != seen:
            seen = mtime
            snapshot = of(base.load_json(base.STATE, {}) or {})
        trial = json.loads(json.dumps(snapshot))
        sweep(trial, now)
        admit_pass(trial, now, mac, tree_max, aging, int(cfg["lease_s"]))
        answer = reply(trial, session, now, aging)
        if answer["state"] != "queued" and session not in snapshot["working"]:
            def settle(state, turns, now):
                changed, gone, admitted = step(turns, now, cfg)
                log_changes(gone, admitted, turns, now)
                return changed, reply(turns, session, now, aging)
            answer = locked(settle)
            seen = None
        if answer["state"] == "admitted":
            emit(answer)
            return 0
        if answer["state"] == "released":
            emit(answer)
            return 1
        if (answer["position"], answer["total"]) != (last["position"], last["total"]):
            emit(answer)
            last = answer


def release(session, reason=None):
    def leave(state, turns, now):
        cfg = base.config()
        working = turns["working"].pop(session, None)
        queued = turns["queued"].pop(session, None)
        changed, gone, admitted = step(turns, now, cfg)
        if working:
            base.log("turn_released", session=session, kind=working["kind"], held_s=round(now - working["since"], 1))
        elif queued:
            base.log("turn_dropped", session=session, waited_s=round(now - queued["since"], 1), reason=reason)
        log_changes(gone, admitted, turns, now)
        return bool(working or queued or changed), {"released": bool(working or queued)}
    return locked(leave)


def cmd_release(rest):
    if len(rest) != 1 or rest[0].startswith("--"):
        raise SystemExit("usage: pi-pool release <session>")
    emit(release(rest[0], reason="release"))
    return 0


def cmd_owner_turn(rest):
    """The session's next admit is an owner turn. A session already queued starts now."""
    if len(rest) != 1 or rest[0].startswith("--"):
        raise SystemExit("usage: pi-pool owner-turn <session>")
    session = rest[0]

    def mark(state, turns, now):
        if session in turns["queued"]:
            entry = turns["queued"].pop(session)
            entry.pop("waiter", None)
            turns["working"][session] = dict(entry, kind="owner", since=now, queued_since=entry["since"],
                                             lease_until=now + int(base.config()["lease_s"]))
            base.log("turn_admitted", session=session, tree=entry["tree"], kind="owner", waited_s=round(now - entry["since"], 1))
            return True, {"session": session, "state": "admitted"}
        turns["owner"][session] = now
        return True, {"session": session, "state": "marked"}
    emit(locked(mark))
    return 0


def cmd_queue(rest):
    if rest not in ([], ["--json"]):
        raise SystemExit("usage: pi-pool queue [--json]")
    turns = of(base.load_json(base.STATE, {}) or {})
    now = time.time()
    sweep(turns, now)
    out = view(turns, now, base.config())
    if rest:
        emit(out)
        return 0
    if not out["enabled"]:
        print("The queue is off.")
    else:
        print(f"{len(out['working'])} working of {out['mac_working_max']}, {len(out['queued'])} queued.")
    for e in out["queued"]:
        print(f"  {e['position']}. {e['session']} {e['class']} (was {e['base_class']}), waiting {e['wait_s']} s")
    return 0
