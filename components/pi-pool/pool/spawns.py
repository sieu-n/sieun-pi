"""The spawn gate: `spawn-gate enter`, `spawn-gate wait` and the `spawns` record of `queue --json`.

A child session that rlm.spawn starts costs memory in its Prime worker at once, before its first turn asks
for a slot: from 08:37Z to 09:37Z on 10-15 live sessions went from 66 to 133 while Prime's workers went
from 17 to 27 GiB, and 21 of those 53 feed minutes were unusable. The kernel wrapper
(components/user-history/src/message-limit-check.py) asks `enter` before it sends an "rlm.run" request. An
answer of go sends it now. An answer of held returns the parent a queued handle at once and runs `wait` in
the background, which exits when the child may start; then the wrapper sends the request. Roots
(rlm.create_session) and owner turns never pass this gate.

state.json keeps the gate under the pool flock in state["spawns"]:

    queue    [{ticket, parent, name, pid, since}]  held spawns, first in first out
    hold     whether new spawns queue: on at HOLD_ON_GB or more, off at HOLD_OFF_GB or less, unchanged between
    read     {at, gb}: the GiB the Prime daemon and its workers hold (pressure.read_workers_gb), read at most every READ_TTL_SEC
    granted  spawns started against this read

While the hold is off, each read lets (HOLD_ON_GB - gb) / SESSION_GB spawns start, so a fan-out fills the room
under HOLD_ON_GB and the rest wait for the next read. A held spawn starts in queue order. An entry whose kernel
(`pid`) is gone is dropped. A read that fails holds nothing.
"""
import math, time, uuid

from . import base, pressure, registry, turns

# Hold new spawns from this many GiB in Prime's workers. Over the 10-15 Mac usable watch minutes with a feed
# reading to 10:2xZ, 3 of 147 minutes at 16 to 18 GiB were unusable, 3 of 120 at 18 to 20, 5 of 42 at 20 to 22,
# 6 of 34 at 22 to 24 and 54 of 98 over 24 (sessions/2026/10/15/1721-spawn-burst-admission/worker_gb_minutes.py).
HOLD_ON_GB = 20
# Let held spawns start again from this many GiB or less: 0 of the 364 minutes at 16 GiB or less were unusable.
HOLD_OFF_GB = 16
# What one more live session added to the workers: 10 GiB for 67 sessions (66 to 133) from 08:37Z to 09:37Z on 10-15.
SESSION_GB = 0.15
# The workers are read at most this often, the governor's PRESSURE_TTL_SEC.
READ_TTL_SEC = turns.PRESSURE_TTL_SEC
USAGE = "usage: pi-pool spawn-gate enter --parent <session> --name <name> --pid <kernel pid> | spawn-gate wait <ticket> | spawn-gate status"


def empty():
    return {"queue": [], "hold": False, "read": None, "granted": 0}


def of(state):
    sp = state.setdefault("spawns", empty())
    for key, value in empty().items():
        sp.setdefault(key, value)
    return sp


def refresh(sp, now, read=pressure.read_workers_gb):
    """Read the workers once READ_TTL_SEC has passed and set the hold. Returns the log events."""
    last = sp.get("read") or {}
    if 0 <= now - last.get("at", -1e18) < READ_TTL_SEC:
        return []
    gb, was = read(), sp["hold"]
    sp["read"], sp["granted"] = {"at": now, "gb": gb}, 0
    sp["hold"] = False if gb is None else True if gb >= HOLD_ON_GB else False if gb <= HOLD_OFF_GB else was
    return [("spawn_hold", {"on": sp["hold"], "gb": gb, "queued": len(sp["queue"])})] if sp["hold"] != was else []


def budget(sp):
    """How many more spawns may start against the current read."""
    gb = (sp.get("read") or {}).get("gb")
    if sp["hold"]:
        return 0
    if gb is None:
        return len(sp["queue"]) + 1
    return max(0, math.floor((HOLD_ON_GB - gb) / SESSION_GB) - sp["granted"])


def sweep(sp, is_alive=turns.alive):
    gone = [e for e in sp["queue"] if not is_alive(e["pid"])]
    sp["queue"] = [e for e in sp["queue"] if is_alive(e["pid"])]
    return [("spawn_dropped", {"ticket": e["ticket"], "name": e["name"], "why": "kernel gone"}) for e in gone]


def enter(sp, now, parent, name, pid, read=pressure.read_workers_gb, is_alive=turns.alive):
    """(answer, events) for one spawn: go, or held with its ticket and place."""
    events = sweep(sp, is_alive) + refresh(sp, now, read)
    if not sp["queue"] and budget(sp) > 0:
        sp["granted"] += 1
        return {"state": "go"}, events
    ticket = uuid.uuid4().hex[:12]
    sp["queue"].append({"ticket": ticket, "parent": parent, "name": name, "pid": pid, "since": now})
    gb = sp["read"]["gb"]
    events.append(("spawn_held", {"ticket": ticket, "parent": parent, "name": name, "gb": gb, "position": len(sp["queue"])}))
    return {"state": "held", "ticket": ticket, "position": len(sp["queue"]), "total": len(sp["queue"]), "gb": gb,
            "hold_on_gb": HOLD_ON_GB, "hold_off_gb": HOLD_OFF_GB}, events


def grant(sp, ticket, now):
    """Start `ticket` when its place is inside the budget. Returns (state, events): go, held or gone."""
    places = [e["ticket"] for e in sp["queue"]]
    if ticket not in places:
        return "gone", []
    if places.index(ticket) >= budget(sp):
        return "held", []
    entry = sp["queue"].pop(places.index(ticket))
    sp["granted"] += 1
    return "go", [("spawn_started", {"ticket": ticket, "name": entry["name"], "parent": entry["parent"], "waited_s": round(now - entry["since"], 1),
                                     "gb": sp["read"]["gb"]})]


def view(sp, now):
    """What `spawn-gate status` prints."""
    return {"hold": sp["hold"], "workers_gb": (sp.get("read") or {}).get("gb"), "hold_on_gb": HOLD_ON_GB, "hold_off_gb": HOLD_OFF_GB,
            "queued": [{"ticket": e["ticket"], "parent": e["parent"], "name": e["name"], "wait_s": round(now - e["since"])} for e in sp["queue"]]}


def locked(fn):
    with base.Flock(base.LOCK, timeout=turns.LOCK_TIMEOUT):
        state = registry.load_state()
        result, events = fn(of(state), time.time())
        base.save_json(base.STATE, state)
    for event, fields in events:
        base.log(event, **fields)
    return result


def cmd_enter(rest):
    opts = dict(zip(rest[0::2], rest[1::2]))
    if len(rest) % 2 or set(opts) - {"--parent", "--name", "--pid"} or "--pid" not in opts:
        raise SystemExit(USAGE)
    if not int(base.config()["spawn_hold_on"]):
        turns.emit({"state": "go"})
        return 0
    pid = int(opts["--pid"])
    turns.emit(locked(lambda sp, now: enter(sp, now, opts.get("--parent"), opts.get("--name"), pid)))
    return 0


def cmd_wait(ticket):
    """Block until the ticket may start; print go (or gone, when the entry was dropped) and exit 0."""
    while True:
        if not int(base.config()["spawn_hold_on"]):
            locked(lambda sp, now: (None, [("spawn_started", {"ticket": ticket, "why": "gate off"})] if drop(sp, ticket) else []))
            turns.emit({"state": "go"})
            return 0
        whole = base.load_json(base.STATE, {}) or {}
        sp, now = of(whole), time.time()
        places = [e["ticket"] for e in sp["queue"]]
        stale = not (0 <= now - (sp.get("read") or {}).get("at", -1e18) < READ_TTL_SEC)
        if ticket not in places or stale or places.index(ticket) < budget(sp):
            def settle(sp, now):
                events = sweep(sp) + refresh(sp, now)
                state, more = grant(sp, ticket, now)
                return state, events + more
            state = locked(settle)
            if state != "held":
                turns.emit({"state": "go" if state == "go" else "gone"})
                return 0
        time.sleep(turns.WAIT_POLL_SEC)


def drop(sp, ticket):
    before = len(sp["queue"])
    sp["queue"] = [e for e in sp["queue"] if e["ticket"] != ticket]
    return len(sp["queue"]) != before


def cmd_spawn_gate(rest):
    if rest[:1] == ["enter"]:
        return cmd_enter(rest[1:])
    if rest[:1] == ["wait"] and len(rest) == 2:
        return cmd_wait(rest[1])
    if rest == ["status"]:
        state = base.load_json(base.STATE, {}) or {}
        turns.emit(view(of(state), time.time()))
        return 0
    raise SystemExit(USAGE)
