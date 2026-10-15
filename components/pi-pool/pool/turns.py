"""The Mac-wide turn queue: `admit`, `release`, `owner-turn` and `queue`.

One run of one session holds one working slot, from the run's first model call to its
agent_end. state.json keeps the queue under the pool flock in state["turns"]:

    working  {session: {tree, parent, class, kind, since, pid, lease_until}}
    queued   {session: {tree, parent, class, since, pid, waiter}}
    owner    {session: epoch sec of the owner-turn mark}
    pressure {level, at, since, reading, limit, changed}: the governor's last read

The governor: while memory pressure is high or critical (pool/pressure.py), the Mac
limit drops to pressure_working_max[level] and a queued turn whose own class and whose
tree's class are both below high is held, so duties, check-ins and jobs of a normal or
low chat wait and a chat and the work of a High chat run under the lower limit. A held
turn keeps its place and takes a free slot under the lower limit only after every turn that
is not held, and only one per tree each admit pass, so every chat's check-in still runs; a
turn held HOLD_MAX_S queues like any other. A held child may still borrow its in-flight
parent's lent slot, so a parent waiting on it in a cell does not sit on its slot. The level is read again every
PRESSURE_TTL_SEC, and the record holds only what the next read recomputes. A read at high
or critical drops the limit at once, and each ok read raises it by at most LIMIT_STEP.

Order: an owner turn runs at once and never waits. Then queued turns take free slots
by class, high before normal before low, longest wait first inside a class, while the
Mac has under mac_working_max slots in use and the tree under tree_working_max. A
queued entry moves up one class for every queue_aging_s it has waited. A child whose
parent's turn is in flight and that finds no slot borrows the parent's slot: a parent
lends at most one slot at a time, and a borrow rides on its lender's slot, so it counts
toward neither limit and the working total runs over the limit by at most one per
parent in flight.

Only the chat service's `owner-turn` marks an owner turn, right before it sends the
owner's prompt. That prompt starts the session's next run (107 of 107 owner prompts on
10-14 08:06-11:02 KST started a run of their own and none joined a live one), so the
mark waits for that run's admit. A session queued when the mark lands has an agent run
in the way: that run starts at once as kind "ahead", logged with its own wait, and the
owner's run after it takes the mark.

The pi-pool extension asks at a run's first model call (`admit --wait`), renews the
slot's lease from the run's model calls (`admit --renew`), and releases at agent_end
or when it finds the session idle. A slot whose lease ran out, which a run stuck in one
tool call reaches after lease_s with no model call, or whose process (`pid`, the Prime
worker that asked) is gone, is dropped, and so is a queue entry whose `admit --wait`
process (`waiter`) is gone, so an abort with no agent_end, a hung tool or a crash
cannot hold a slot.
"""
import json, os, sys, time

from . import base, pressure, registry

CLASSES = ("low", "normal", "high")
# An owner-turn mark that no admit consumed (a failed send) is dropped after this long.
# A mark waits for the session's next turn, which starts after the turn in flight ends:
# the 99th percentile turn was 2,956 s over the 22,675 turns of 10-11 to 10-14
# (agent-queue-design/data/turns.json, measure_turns.py).
OWNER_MARK_TTL_SEC = 3600
# `admit --wait` re-reads state.json this often while queued.
WAIT_POLL_SEC = 1.0
# The flock wait for an admit or release. A token hook waits base.STATE_LOCK_TIMEOUT.
LOCK_TIMEOUT = 6.0
# The governor reads memory pressure at most this often and keeps the reading in
# state["turns"]["pressure"] between reads.
PRESSURE_TTL_SEC = 30
# After a read at high or critical the limit climbs back toward mac_working_max at most this
# many slots a read, so one ok read between two critical ones opens 4 slots. On 10-15 a
# single ok read at 09:17:28 KST opened 16 to 30 at once, 11 queued turns started in that
# second, and kernel_task read 146% and 120% of a core in the next two minutes. Over the
# 235 minutes of the Mac usable watch feed from 10-14 20:31Z to 10-15 00:27Z, the 33 where
# working turns grew by 3 to 8 peaked at 83.5% kernel_task, and the one that grew by 12 read
# 146% (browser-chat/mac-usable/2026-10-1{4,5}.jsonl). Two reads a minute at 4 is 8.
LIMIT_STEP = 4


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


# A held turn waits at most this long, then queues like any other: the 90th percentile wait of
# the 6,125 slot admits pi-pool logged on 10-14 from 08:06 to 20:03 KST, before the governor.
HOLD_MAX_S = 141


def in_slots(working):
    """Working turns that hold a slot of their own: every one but a borrow."""
    return [e for e in working.values() if e.get("kind") != "borrow"]


def lending(turns):
    """Parent session -> the child running on its lent slot."""
    return {e["lender"]: s for s, e in turns["working"].items() if e.get("kind") == "borrow"}


def admit_pass(turns, now, mac_max, tree_max, aging, lease=None, hold=None):
    """Move queued entries to working: free slots by class first, then borrows. An entry
    `hold(entry)` is true for takes a free slot only after the others, one per tree each pass,
    and may borrow its in-flight parent's lent slot. Returns [(session, kind)] in admission order."""
    lease = lease or base.DEFAULTS["lease_s"]
    admitted = []
    ordered = order(turns["queued"], now, aging)
    held_ids = {s for s in ordered if hold and hold(turns["queued"][s])}
    queue = [s for s in ordered if s not in held_ids]
    trees = {}
    held = in_slots(turns["working"])
    for entry in held:
        trees[entry["tree"]] = trees.get(entry["tree"], 0) + 1
    used = len(held)

    def start(session, kind, **extra):
        nonlocal used
        entry = turns["queued"].pop(session)
        entry.pop("waiter", None)
        turns["working"][session] = dict(entry, kind=kind, since=now, queued_since=entry["since"], lease_until=now + lease, **extra)
        if kind != "borrow":
            trees[entry["tree"]] = trees.get(entry["tree"], 0) + 1
            used += 1
        admitted.append((session, kind))

    for session in queue:
        if used >= mac_max:
            break
        if trees.get(turns["queued"][session]["tree"], 0) < tree_max:
            start(session, "slot")
    let_through = set()
    for session in [s for s in ordered if s in held_ids]:
        tree = turns["queued"][session]["tree"]
        if used >= mac_max:
            break
        if tree not in let_through and trees.get(tree, 0) < tree_max:
            start(session, "slot")
            let_through.add(tree)
    lent = lending(turns)
    for session in [s for s in ordered if s in turns["queued"]]:
        parent = turns["queued"][session].get("parent")
        if parent and parent in turns["working"] and parent not in lent:
            start(session, "borrow", lender=parent)
            lent[parent] = session
    return admitted


def holds(entry, sessions, now=None):
    """Whether pressure holds a queued turn: its own class and its tree's class are both below high, and it
    has waited under HOLD_MAX_S."""
    if now is not None and now - entry["since"] >= HOLD_MAX_S:
        return False
    rec = sessions.get(entry["tree"]) or {}
    tree = "high" if rec.get("priority_label") == "high" else rec.get("priority") or entry["class"]
    return entry["class"] != "high" and tree != "high"


def working_limit(cfg, level):
    mac = int(cfg["mac_working_max"])
    return mac if level == "ok" else max(1, min(mac, int(cfg["pressure_working_max"][level])))


def stepped(target, last):
    """The limit after one read: down to `target` at once, up from `last` by at most LIMIT_STEP."""
    return target if last is None or last >= target else min(target, last + LIMIT_STEP)


def governor(turns, now, cfg, read=pressure.read):
    """Refresh turns["pressure"] once it is PRESSURE_TTL_SEC old. Returns (refreshed, events)."""
    last = turns.get("pressure") or {}
    if not int(cfg["memory_governor_on"]):
        turns["pressure"] = {"level": "ok", "at": now, "since": now, "reading": None, "limit": working_limit(cfg, "ok"), "changed": None, "on": False}
        return last.get("on", True), []
    if last.get("on", True) and last.get("level") in pressure.LEVELS and 0 <= now - last.get("at", -1e18) < PRESSURE_TTL_SEC:
        limit = min(last.get("limit", working_limit(cfg, last["level"])), working_limit(cfg, last["level"]))
        turns["pressure"] = dict(last, limit=limit)
        return limit != last.get("limit"), []
    reading = read()
    level, was = pressure.level(reading), last.get("level", "ok")
    rec = {"level": level, "at": now, "since": last.get("since", now) if level == was else now, "reading": reading,
           "limit": stepped(working_limit(cfg, level), last.get("limit")), "changed": last.get("changed"), "on": True}
    events = []
    if level != was:
        rec["changed"] = {"from": was, "to": level, "at": now, "limit_from": last.get("limit", working_limit(cfg, was)),
                          "limit_to": rec["limit"], "reading": reading}
        events.append(("pressure_level", rec["changed"]))
    elif "limit" in last and rec["limit"] != last["limit"]:
        events.append(("pressure_limit", {"level": level, "at": now, "limit_from": last["limit"], "limit_to": rec["limit"]}))
    turns["pressure"] = rec
    return True, events


def governed(turns, sessions, now, cfg, read=pressure.read):
    """(working limit, hold rule or None, refreshed, events) under the current pressure."""
    refreshed, events = governor(turns, now, cfg, read)
    rec = turns["pressure"]
    hold = None if rec["level"] == "ok" else (lambda entry: holds(entry, sessions, now))
    return rec["limit"], hold, refreshed, events


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


def view(turns, now, cfg, sessions=None):
    """`pi-pool queue --json`. Run `governed` on `turns` first for a current pressure record."""
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
            "tree_working_max": int(cfg["tree_working_max"]), "slots_used": len(in_slots(turns["working"])),
            "working": working, "queued": queued, "pressure": pressure_view(turns, sessions or {}, now)}


def pressure_view(turns, sessions, now=None):
    rec = turns.get("pressure")
    if not rec:
        return None
    held = sum(1 for e in turns["queued"].values() if holds(e, sessions, now)) if rec["level"] != "ok" else 0
    return {k: rec.get(k) for k in ("level", "on", "at", "since", "reading", "limit", "changed")} | {"held": held}


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


def ask(turns, sessions, a, now, cfg, waiter=None, read=pressure.read):
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
    mac, hold, _, events = governed(turns, sessions, now, cfg, read)
    admitted = admit_pass(turns, now, mac, tree_max, aging, lease, hold)
    events += [("turn_swept", dict(session=g["session"], part=g["part"], why=g["why"])) for g in gone]
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
        admitted += admit_pass(turns, now, mac, tree_max, aging, lease, hold)
        if session in turns["queued"]:
            events.append(("turn_queued", {"session": session, "tree": a["tree"], "parent": a["parent"], "class": entry["class"],
                                           "working": len(turns["working"]), "queued": len(turns["queued"]),
                                           "held": bool(hold and hold(entry))}))
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


def log_changes(gone, admitted, turns, now, events=()):
    for event, fields in events:
        base.log(event, **fields)
    for g in gone:
        base.log("turn_swept", session=g["session"], part=g["part"], why=g["why"])
    for session, kind in admitted:
        e = turns["working"][session]
        base.log("turn_admitted", session=session, tree=e["tree"], kind=kind, waited_s=round(now - e["queued_since"], 1))


def step(turns, sessions, now, cfg, read=pressure.read):
    """Sweep, then admit what fits under the governor. Returns (changed, gone, admitted, events)."""
    gone = sweep(turns, now)
    mac, tree_max, aging = limits(cfg)
    if mac is None:
        return bool(gone), gone, [], []
    mac, hold, refreshed, events = governed(turns, sessions, now, cfg, read)
    admitted = admit_pass(turns, now, mac, tree_max, aging, int(cfg["lease_s"]), hold)
    return bool(gone or admitted or refreshed), gone, admitted, events


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
            whole = base.load_json(base.STATE, {}) or {}
            snapshot, sessions = of(whole), whole.get("sessions") or {}
        trial = json.loads(json.dumps(snapshot))
        sweep(trial, now)
        limit, hold, _, _ = governed(trial, sessions, now, cfg)
        admit_pass(trial, now, limit, tree_max, aging, int(cfg["lease_s"]), hold)
        answer = reply(trial, session, now, aging)
        if answer["state"] != "queued" and session not in snapshot["working"]:
            def settle(state, turns, now):
                changed, gone, admitted, events = step(turns, state["sessions"], now, cfg)
                log_changes(gone, admitted, turns, now, events)
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
        changed, gone, admitted, events = step(turns, state["sessions"], now, cfg)
        if working:
            base.log("turn_released", session=session, kind=working["kind"], held_s=round(now - working["since"], 1))
        elif queued:
            base.log("turn_dropped", session=session, waited_s=round(now - queued["since"], 1), reason=reason)
        log_changes(gone, admitted, turns, now, events)
        return bool(working or queued or changed), {"released": bool(working or queued)}
    return locked(leave)


def cmd_release(rest):
    if len(rest) != 1 or rest[0].startswith("--"):
        raise SystemExit("usage: pi-pool release <session>")
    emit(release(rest[0], reason="release"))
    return 0


def mark_owner(turns, session, now, lease):
    """The owner's prompt to `session` goes out next: mark its next admit as the owner's.
    A queued agent run of the session would hold that prompt behind the queue, so it
    starts now as kind "ahead". Returns (answer, events to log)."""
    turns["owner"][session] = now
    events = [("turn_owner_marked", {"session": session})]
    if session not in turns["queued"]:
        return {"session": session, "state": "marked"}, events
    entry = turns["queued"].pop(session)
    entry.pop("waiter", None)
    turns["working"][session] = dict(entry, kind="ahead", since=now, queued_since=entry["since"], lease_until=now + lease)
    events.append(("turn_admitted", dict(session=session, tree=entry["tree"], kind="ahead", waited_s=round(now - entry["since"], 1))))
    return {"session": session, "state": "marked", "ahead": True}, events


def cmd_owner_turn(rest):
    """The session's next admit is an owner turn. A queued run of the session starts now."""
    if len(rest) != 1 or rest[0].startswith("--"):
        raise SystemExit("usage: pi-pool owner-turn <session>")

    def mark(state, turns, now):
        answer, events = mark_owner(turns, rest[0], now, int(base.config()["lease_s"]))
        for event, fields in events:
            base.log(event, **fields)
        return True, answer
    emit(locked(mark))
    return 0


def cmd_queue(rest):
    if rest not in ([], ["--json"]):
        raise SystemExit("usage: pi-pool queue [--json]")
    state = base.load_json(base.STATE, {}) or {}
    turns, sessions, cfg, now = of(state), state.get("sessions") or {}, base.config(), time.time()
    sweep(turns, now)
    if limits(cfg)[0] is not None:
        governed(turns, sessions, now, cfg)
    out = view(turns, now, cfg, sessions)
    if rest:
        emit(out)
        return 0
    if not out["enabled"]:
        print("The queue is off.")
    else:
        borrows = len(out["working"]) - out["slots_used"]
        print(f"{out['slots_used']} slots of {out['mac_working_max']} in use, {borrows} borrowed, {len(out['queued'])} queued.")
        p = out["pressure"]
        if p and p["level"] != "ok":
            print(f"Memory pressure {p['level']}: the limit is {p['limit']}, and {p['held']} queued turns are held.")
    for e in out["queued"]:
        print(f"  {e['position']}. {e['session']} {e['class']} (was {e['base_class']}), waiting {e['wait_s']} s")
    return 0
