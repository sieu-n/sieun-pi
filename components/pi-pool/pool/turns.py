"""The machine-wide turn queue: `admit`, `release`, `owner-turn`, `prod` and `queue`.

One run of one session holds one working slot, from the run's first model call to its
agent_end. state.json keeps the queue under the pool flock in state["turns"]:

    working  {session: {tree, parent, class, kind, since, pid, lease_until}}
    queued   {session: {tree, parent, class, since, pid, waiter, line?}}
    recent   {session: {at, line}}: when a run ended, and the line time its next ask within REQUEUE_GRACE_S keeps
    owner    {session: epoch sec of the owner-turn mark}
    prod     {at, until, trees, sessions}: the trees and sessions a caller marked as on prod work (pool/prod.py)

Order: an owner turn runs at once and never waits, and so does a prod turn: one of a tree or
session the caller's `prod set` record names (pool/prod.py). Then queued turns take free slots
by class, the top class (TOP) first, then high before normal before low, longest wait first inside a class, while the
machine has under working_max slots in use and the tree under tree_working_max. A
queued entry moves up one class for every queue_aging_s it has waited. A child whose
parent's turn is in flight and that finds no slot borrows the parent's slot: a parent
lends at most one slot at a time, and a borrow rides on its lender's slot, so it counts
toward neither limit and the working total runs over the limit by at most one per
parent in flight.

Only the caller's `owner-turn` marks an owner turn, right before it sends the
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

from . import base, prod, registry

CLASSES = ("low", "normal", "high")
# The top class queues above every class, aging included, and the caller decides which turns take it.
# On 10-15, with 60 to 77 turns queued at the critical limit of 12 and every entry aged to high within
# 36 s, the chat service's check-in keys waited 49 s at p50, 179 s at p90 and 381 s at most (23 waits
# that day), so the check-in that keeps every chat's plan moving ran last; the chat service asks for
# top for that key. Shown as high in `queue --json`, which older readers parse.
TOP = "top"
# An owner-turn mark that no admit consumed (a failed send) is dropped after this long.
# A mark waits for the session's next turn, which starts after the turn in flight ends:
# the 99th percentile turn was 2,956 s over the 22,675 turns of 10-11 to 10-14
# (agent-queue-design/data/turns.json, measure_turns.py).
OWNER_MARK_TTL_SEC = 3600
# `admit --wait` re-reads state.json this often while queued.
WAIT_POLL_SEC = 1.0
# The flock wait for an admit or release. A token hook waits base.STATE_LOCK_TIMEOUT.
LOCK_TIMEOUT = 6.0
# A session that asks again this soon after its run ended keeps its place in line (`line`), so a job's
# next run goes ahead of turns that never ran. At 22:40 KST on 10-15, 106 turns were queued and 42 of the
# 50 queued roots had run and asked again. Of the 1,150 asks that followed a release from 18:00 to 23:06 KST that day, 51% came
# within 10 s, 54% within 30 s and 55% within 60 s, so 30 s takes the chained runs and little more.
REQUEUE_GRACE_S = 30


def limits(cfg):
    """(the machine max or None when the queue is off, tree max, aging seconds)."""
    if not int(cfg["agent_queue_on"]):
        return None, None, None
    return int(cfg["working_max"]), int(cfg["tree_working_max"]), max(1, int(cfg["queue_aging_s"]))


def empty():
    return {"working": {}, "queued": {}, "owner": {}, "recent": {}}


def of(state):
    turns = state.setdefault("turns", empty())
    for key in ("working", "queued", "owner", "recent"):
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


def line(entry):
    """When an entry got in line: its ask, or the first ask of the runs it chained (REQUEUE_GRACE_S)."""
    return entry.get("line", entry["since"])


def rank(entry, now, aging):
    """The class an entry queues in now: its own, one step up per aging period since it got in line."""
    if entry["class"] == TOP:
        return len(CLASSES)
    steps = int(max(0.0, now - line(entry)) // aging)
    return min(len(CLASSES) - 1, CLASSES.index(entry["class"]) + steps)


def shown(klass):
    """A class as `queue --json` names it: top reads as high."""
    return "high" if klass == TOP else klass


def order(queued, now, aging):
    """Queued session ids in admission order."""
    return sorted(queued, key=lambda s: (-rank(queued[s], now, aging), line(queued[s]), s))


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
    for session, rec in list(turns.get("recent", {}).items()):
        if not 0 <= now - rec["at"] <= REQUEUE_GRACE_S:
            del turns["recent"][session]
    return gone


def in_slots(working):
    """Working turns that hold a slot of their own: every one but a borrow."""
    return [e for e in working.values() if e.get("kind") != "borrow"]


def lending(turns):
    """Parent session -> the child running on its lent slot."""
    return {e["lender"]: s for s, e in turns["working"].items() if e.get("kind") == "borrow"}


def admit_pass(turns, now, all_max, tree_max, aging, lease=None):
    """Move queued entries to working: prod turns first, then free slots by class, then borrows.
    Returns [(session, kind)] in admission order."""
    lease = lease or base.DEFAULTS["lease_s"]
    admitted = []
    rush = {s: prod.why(turns.get("prod"), s, turns["queued"][s], now) for s in order(turns["queued"], now, aging)}
    queue = [s for s in rush if not rush[s]]
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

    for session, why in rush.items():
        if why:
            start(session, "prod", why=why)
    for session in queue:
        if used >= all_max:
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


def prod_watch(turns, now, cfg):
    """Drop the prod record once it lapses, or at once while prod_turns_on is 0.
    Returns (changed, events); a dropped record logs prod_turns."""
    last = turns.get("prod")
    if last is None or (int(cfg["prod_turns_on"]) and prod.live(last, now)):
        return False, []
    turns.pop("prod")
    return True, [("prod_turns", {"trees": {}, "sessions": {}})]


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
    all_max, tree_max, aging = limits(cfg)
    aging = aging or max(1, int(cfg["queue_aging_s"]))
    queue = order(turns["queued"], now, aging)
    working = [{"session": s, "tree": e["tree"], "parent": e.get("parent"), "class": shown(e["class"]), "kind": e["kind"],
                "since": e["since"]} for s, e in sorted(turns["working"].items(), key=lambda kv: kv[1]["since"])]
    queued = [{"session": s, "tree": turns["queued"][s]["tree"], "parent": turns["queued"][s].get("parent"),
               "class": shown(CLASSES[min(rank(turns["queued"][s], now, aging), len(CLASSES) - 1)]), "base_class": shown(turns["queued"][s]["class"]),
               "position": i + 1, "total": len(queue), "since": turns["queued"][s]["since"],
               "wait_s": round(now - turns["queued"][s]["since"])} for i, s in enumerate(queue)]
    return {"enabled": all_max is not None, "working_max": int(cfg["working_max"]),
            "working_max_set": last_set("working_max"),
            "tree_working_max": int(cfg["tree_working_max"]), "slots_used": len(in_slots(turns["working"])),
            "working": working, "queued": queued,
            "prod": {k: (prod.live(turns.get("prod"), now) or {}).get(k, {}) for k in ("trees", "sessions")}}


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
             "[--class top|high|normal|low] [--pid <n>] [--wait | --renew]")
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
    if (not out["session"] or (out["class"] is not None and out["class"] not in (*CLASSES, TOP))
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
    all_max, tree_max, aging = limits(cfg)
    if all_max is None:
        dropped = turns["queued"].pop(session, None) is not None
        return dropped, reply(turns, session, now, aging, enabled=False), []
    gone = sweep(turns, now)
    _, events = prod_watch(turns, now, cfg)
    admitted = admit_pass(turns, now, all_max, tree_max, aging, lease)
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
        recent = turns.get("recent", {}).pop(session, None)
        if recent and 0 <= now - recent["at"] <= REQUEUE_GRACE_S:
            entry["line"] = recent["line"]
        turns["queued"][session] = dict(entry, waiter=waiter)
        admitted += admit_pass(turns, now, all_max, tree_max, aging, lease)
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


def log_changes(gone, admitted, turns, now, events=()):
    for event, fields in events:
        base.log(event, **fields)
    for g in gone:
        base.log("turn_swept", session=g["session"], part=g["part"], why=g["why"])
    for session, kind in admitted:
        e = turns["working"][session]
        base.log("turn_admitted", session=session, tree=e["tree"], kind=kind, waited_s=round(now - e["queued_since"], 1))


def step(turns, now, cfg):
    """Sweep, then admit what fits. Returns (changed, gone, admitted, events)."""
    gone = sweep(turns, now)
    all_max, tree_max, aging = limits(cfg)
    if all_max is None:
        return bool(gone), gone, [], []
    refreshed, events = prod_watch(turns, now, cfg)
    admitted = admit_pass(turns, now, all_max, tree_max, aging, int(cfg["lease_s"]))
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
        all_max, tree_max, aging = limits(cfg)
        if all_max is None:
            release(session, reason="queue off")
            emit({"state": "off", "kind": None, "position": None, "total": None})
            return 0
        now = time.time()
        if mtime != seen:
            seen = mtime
            whole = base.load_json(base.STATE, {}) or {}
            snapshot = of(whole)
        trial = json.loads(json.dumps(snapshot))
        sweep(trial, now)
        prod_watch(trial, now, cfg)
        admit_pass(trial, now, all_max, tree_max, aging, int(cfg["lease_s"]))
        answer = reply(trial, session, now, aging)
        if answer["state"] != "queued" and session not in snapshot["working"]:
            def settle(state, turns, now):
                changed, gone, admitted, events = step(turns, now, cfg)
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


def leave(turns, session, now, cfg, reason=None):
    """Free `session`'s slot or drop its queue entry, then admit what fits. A freed run of its own leaves a
    `recent` record, so an ask within REQUEUE_GRACE_S keeps the run's place in line.
    Returns (changed, gone, admitted, events, answer)."""
    working = turns["working"].pop(session, None)
    queued = turns["queued"].pop(session, None)
    if working and working.get("kind") != "borrow":
        turns.setdefault("recent", {})[session] = {"at": now, "line": working.get("line", working.get("queued_since", working["since"]))}
    changed, gone, admitted, events = step(turns, now, cfg)
    if working:
        events = [("turn_released", dict(session=session, kind=working["kind"], held_s=round(now - working["since"], 1)))] + events
    elif queued:
        events = [("turn_dropped", dict(session=session, waited_s=round(now - queued["since"], 1), reason=reason))] + events
    return bool(working or queued or changed), gone, admitted, events, {"released": bool(working or queued)}


def release(session, reason=None):
    def go(state, turns, now):
        changed, gone, admitted, events, answer = leave(turns, session, now, base.config(), reason)
        log_changes(gone, admitted, turns, now, events)
        return changed, answer
    return locked(go)


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
    # The box wrote 3,956 marks on 10-19 with its queue off, each under the pool flock that every token request takes.
    if limits(base.config())[0] is None:
        emit({"session": rest[0], "state": "off"})
        return 0

    def mark(state, turns, now):
        answer, events = mark_owner(turns, rest[0], now, int(base.config()["lease_s"]))
        for event, fields in events:
            base.log(event, **fields)
        return True, answer
    emit(locked(mark))
    return 0


def cmd_prod(rest):
    """`prod set <json>` replaces the prod record and admits what it names, `prod clear` drops it,
    and `prod` prints the record that holds now."""
    if rest == []:
        state = base.load_json(base.STATE, {}) or {}
        emit(prod.live(of(state).get("prod"), time.time()))
        return 0
    if rest not in (["clear"],) and not (len(rest) == 2 and rest[0] == "set"):
        raise SystemExit(prod.USAGE)

    def put(state, turns, now):
        last = prod.live(turns.get("prod"), now) or {}
        rec = prod.parse(rest[1], now) if rest[0] == "set" else None
        if rec:
            turns["prod"] = rec
        else:
            turns.pop("prod", None)
        changed, gone, admitted, events = step(turns, now, base.config())
        events = [e for e in events if e[0] != "prod_turns"]
        now_on = prod.live(turns.get("prod"), now) or {}
        if (now_on.get("trees", {}), now_on.get("sessions", {})) != (last.get("trees", {}), last.get("sessions", {})):
            events = [("prod_turns", {"trees": now_on.get("trees", {}), "sessions": now_on.get("sessions", {})})] + events
        log_changes(gone, admitted, turns, now, events)
        return True, {"prod": prod.live(turns.get("prod"), now), "admitted": [s for s, kind in admitted if kind == "prod"]}
    emit(locked(put))
    return 0


def cmd_queue(rest):
    if rest not in ([], ["--json"]):
        raise SystemExit("usage: pi-pool queue [--json]")
    state = base.load_json(base.STATE, {}) or {}
    turns, cfg, now = of(state), base.config(), time.time()
    sweep(turns, now)
    if limits(cfg)[0] is not None:
        prod_watch(turns, now, cfg)
    out = view(turns, now, cfg)
    if rest:
        emit(out)
        return 0
    if not out["enabled"]:
        print("The queue is off.")
    else:
        borrows = len(out["working"]) - out["slots_used"]
        print(f"{out['slots_used']} slots of {out['working_max']} in use, {borrows} borrowed, {len(out['queued'])} queued.")
    for e in out["queued"]:
        print(f"  {e['position']}. {e['session']} {e['class']} (was {e['base_class']}), waiting {e['wait_s']} s")
    return 0
