"""The Mac-wide turn queue: `admit`, `release`, `owner-turn` and `queue`.

One run of one session holds one working slot, from the run's first model call to its
agent_end. state.json keeps the queue under the pool flock in state["turns"]:

    working  {session: {tree, parent, class, kind, since, pid, lease_until}}
    queued   {session: {tree, parent, class, since, pid, waiter}}
    owner    {session: epoch sec of the owner-turn mark}
    pressure {level, at, since, reading, limit, changed, memory_trees}: the governor's last read

The governor: while memory pressure is high or critical (pool/pressure.py), the Mac
limit drops to pressure_working_max[level] and a queued turn whose own class and whose
tree's class are both below high is held, so duties, check-ins and jobs of a normal or
low chat wait and a chat and the work of a High chat run under the lower limit. A held
turn keeps its place and takes a free slot under the lower limit only after every turn that
is not held, and only one per tree each admit pass, so every chat's check-in still runs; a
turn held HOLD_MAX_S queues like any other. A held child may still borrow its in-flight
parent's lent slot, so a parent waiting on it in a cell does not sit on its slot. While the
level is high or critical, a borrow starts only while slots and borrows in use are under the
limit plus PRESSURE_BORROWS, so borrows put at most that many turns over the limit. The level is
read again every PRESSURE_TTL_SEC, and the record holds only what the next read recomputes. A read at high
or critical drops the limit at once, and each ok read raises it by at most LIMIT_STEP.

While the level is high or critical, a tree that the chat service's tree-memory.json lists
over its share of RAM (pressure.read_tree_memory, read with the level) is held firmly: every
queued turn of the tree but its root session's own waits, with no HOLD_MAX_S release, no
one-per-tree pass and no borrow, until the tree leaves the file or the level is ok. The root
runs so the chat can read the service's notice and stop its job.

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
# While the level is high or critical, borrows start only while slots and borrows in use are
# under the limit plus this many. Over the 721 Mac usable watch minutes from 10-14 20:31Z to
# 10-15 08:51Z, none of the 100 high minutes with 18 or fewer turns working (16 plus 2) was
# unusable and 6 of the 28 with more were (tests/usable_minutes_1014_1015.json). Over the 101 feed minutes the governor read critical from 10-14 20:31Z
# to 10-15 08:25Z, the 39 with at most 18 turns working peaked at 92.2% kernel_task, and 22 of
# the 62 with 19 or more read over 100%, each with 15 or more slots and 2 to 8 borrows. 08:15Z
# on 10-15 held 16 slots and 6 borrows and read 152.3% while a job fanned out 26 children
# (tests/critical_minutes_1014_1015.json, from sessions/2026/10/15/1721-spawn-burst-admission/critical_borrows.py).
PRESSURE_BORROWS = 2


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


def admit_pass(turns, now, mac_max, tree_max, aging, lease=None, hold=None, firm=None, borrow_top=None):
    """Move queued entries to working: free slots by class first, then borrows. An entry
    `hold(entry)` is true for takes a free slot only after the others, one per tree each pass,
    and may borrow its in-flight parent's lent slot. An entry `firm(session, entry)` is true for
    stays queued. With `borrow_top` set, a borrow starts only while slots and borrows in use
    are under it. Returns [(session, kind)] in admission order."""
    lease = lease or base.DEFAULTS["lease_s"]
    admitted = []
    ordered = [s for s in order(turns["queued"], now, aging) if not (firm and firm(s, turns["queued"][s]))]
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
        if borrow_top is not None and used + len(lent) >= borrow_top:
            break
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


def memory_events(last, held, now, level, over=None):
    """The tree_memory_held and tree_memory_released log lines between the trees `last` held and `held`."""
    was = set(last.get("memory_trees") or [])
    events = [("tree_memory_held", dict(root=root, at=now, level=level, **{k: (over or {}).get(root, {}).get(k) for k in ("tree", "gb", "pid", "process_gb")}))
              for root in sorted(set(held) - was)]
    events += [("tree_memory_released", {"root": root, "at": now, "why": "level ok" if level == "ok" else "left tree-memory.json"})
               for root in sorted(was - set(held))]
    return events


def governor(turns, now, cfg, read=pressure.read, trees=pressure.read_tree_memory):
    """Refresh turns["pressure"] once it is PRESSURE_TTL_SEC old, with the level from `read` and, at high
    or critical, the trees `trees` lists over their share (memory_trees). Returns (refreshed, events)."""
    last = turns.get("pressure") or {}
    if not int(cfg["memory_governor_on"]):
        turns["pressure"] = {"level": "ok", "at": now, "since": now, "reading": None, "limit": working_limit(cfg, "ok"), "changed": None,
                             "on": False, "memory_trees": []}
        return last.get("on", True), memory_events(last, [], now, "ok")
    if last.get("on", True) and last.get("level") in pressure.LEVELS and 0 <= now - last.get("at", -1e18) < PRESSURE_TTL_SEC:
        limit = min(last.get("limit", working_limit(cfg, last["level"])), working_limit(cfg, last["level"]))
        turns["pressure"] = dict(last, limit=limit)
        return limit != last.get("limit"), []
    reading = read()
    level, was = pressure.level(reading), last.get("level", "ok")
    over = trees() if level != "ok" else {}
    rec = {"level": level, "at": now, "since": last.get("since", now) if level == was else now, "reading": reading,
           "limit": stepped(working_limit(cfg, level), last.get("limit")), "changed": last.get("changed"), "on": True,
           "memory_trees": sorted(over)}
    events = []
    if level != was:
        rec["changed"] = {"from": was, "to": level, "at": now, "limit_from": last.get("limit", working_limit(cfg, was)),
                          "limit_to": rec["limit"], "reading": reading}
        events.append(("pressure_level", rec["changed"]))
    elif "limit" in last and rec["limit"] != last["limit"]:
        events.append(("pressure_limit", {"level": level, "at": now, "limit_from": last["limit"], "limit_to": rec["limit"]}))
    events += memory_events(last, rec["memory_trees"], now, level, over)
    turns["pressure"] = rec
    return True, events


def held_for_memory(turns, session, entry):
    """Whether a queued turn waits for its tree's memory: its tree is in memory_trees and it is not the
    tree's root session."""
    rec = turns.get("pressure") or {}
    return rec.get("level", "ok") != "ok" and entry["tree"] != session and entry["tree"] in (rec.get("memory_trees") or [])


def governed(turns, sessions, now, cfg, read=pressure.read, trees=pressure.read_tree_memory):
    """(working limit, hold rule or None, firm hold rule or None, borrow top or None, refreshed, events) under
    the current pressure. The borrow top is the limit plus PRESSURE_BORROWS while the level is high or critical."""
    refreshed, events = governor(turns, now, cfg, read, trees)
    rec = turns["pressure"]
    hold = None if rec["level"] == "ok" else (lambda entry: holds(entry, sessions, now))
    firm = (lambda session, entry: held_for_memory(turns, session, entry)) if rec.get("memory_trees") else None
    top = None if rec["level"] == "ok" else rec["limit"] + PRESSURE_BORROWS
    return rec["limit"], hold, firm, top, refreshed, events


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
    """`queue --json`'s pressure record: the governor's last read, the count of queued turns it holds, and
    memory_trees, the root session ids whose trees are held for memory."""
    rec = turns.get("pressure")
    if not rec:
        return None
    held = sum(1 for s, e in turns["queued"].items() if holds(e, sessions, now) or held_for_memory(turns, s, e)) if rec["level"] != "ok" else 0
    return {k: rec.get(k) for k in ("level", "on", "at", "since", "reading", "limit", "changed")} | {"held": held, "memory_trees": rec.get("memory_trees") or []}


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


def ask(turns, sessions, a, now, cfg, waiter=None, read=pressure.read, trees=pressure.read_tree_memory):
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
    mac, hold, firm, top, _, events = governed(turns, sessions, now, cfg, read, trees)
    admitted = admit_pass(turns, now, mac, tree_max, aging, lease, hold, firm, top)
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
        admitted += admit_pass(turns, now, mac, tree_max, aging, lease, hold, firm, top)
        if session in turns["queued"]:
            memory = bool(firm and firm(session, entry))
            events.append(("turn_queued", {"session": session, "tree": a["tree"], "parent": a["parent"], "class": entry["class"],
                                           "working": len(turns["working"]), "queued": len(turns["queued"]),
                                           "held": memory or bool(hold and hold(entry)), "memory_held": memory}))
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


def step(turns, sessions, now, cfg, read=pressure.read, trees=pressure.read_tree_memory):
    """Sweep, then admit what fits under the governor. Returns (changed, gone, admitted, events)."""
    gone = sweep(turns, now)
    mac, tree_max, aging = limits(cfg)
    if mac is None:
        return bool(gone), gone, [], []
    mac, hold, firm, top, refreshed, events = governed(turns, sessions, now, cfg, read, trees)
    admitted = admit_pass(turns, now, mac, tree_max, aging, int(cfg["lease_s"]), hold, firm, top)
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
    a hundred waiters do not queue on the lock the token hook shares. A fresh governor read
    stays in the snapshot, so a waiter reads pressure and tree-memory.json at most once
    each PRESSURE_TTL_SEC while state.json holds an old record."""
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
        limit, hold, firm, top, refreshed, _ = governed(trial, sessions, now, cfg)
        if refreshed:
            snapshot["pressure"] = trial["pressure"]
        admit_pass(trial, now, limit, tree_max, aging, int(cfg["lease_s"]), hold, firm, top)
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
