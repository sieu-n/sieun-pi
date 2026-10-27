"""The turn queue of this machine: `admit`, `release`, `owner-turn`, `lead` and `queue`.

One run of one session holds one working slot, from the run's first model call to its
agent_end. turns.json keeps the queue under its own lock, turns.lock, apart from the
account state.json and its lock:

    working  {session: {tree, kind, since, queued_since, place, pid, lease_until}}
    queued   {session: {tree, since, asked?, pid, waiter?}}
    owner    {session: epoch sec of the owner-turn mark}
    lead     [session], the sessions whose queued runs go first (`lead`)
    kept     {session: {since, slot_at, reask?}}, the place of a run let go on an account wait or with input queued,
             and for REASK_SEC (`reask`) the place of any other run let go

A queued run's `since` is its place in line and `asked` when it asked, which differ only
for a run that keeps its place. A run released while its tree waits for an account
(state.json's `wait`) ended on that wait, and the session's next run comes back at the
slot. That run asks again with the place of the run that let go, so a wait for an account
never also costs a wait at the back of the line. On 10-22 a d7 check-in run held from 06:24Z
to 08:12Z came back from each account wait 104th, 147th and 179th, and 23 trees whose
claude8 cells came at 11:30Z then queued about 90 min with working_max at 6. A replay of
10-22 00:00Z to 08:14Z (~/work/pool-smooth/reask_replay.py) cut those returns' p90 queue
wait from 1,154 s to 60 s and all job queue minutes by 11%. The place is kept until
PLACE_KEEP_SEC after the slot, as long as the tree keeps its place in the account wait.

A run released with input already queued in Prime (`release --queued-input`) keeps its
place the same way, until PLACE_KEEP_SEC after its release: a steer ends the running run
after its model step, and the session's next run starts at once to read it. Any other run
keeps its place for REASK_SEC, so a session on an extension from before --queued-input
whose next run starts at once keeps it too. On 10-22 the
metal box owner 01a11d24 got 3 runs from 09:57Z to 13:34Z, each after a wait of 2,802 s to
5,799 s at the back of the line, and each held its slot for under 70 s.

Waiting runs of the `lead` sessions start first, then every other run, each in the order
they asked, while the machine has fewer than working_max
runs working and the run's tree fewer than tree_working_max. The owner sets both by hand
in config.json, and nothing changes them (owner, 10-19: "NO auto-adjusting behaviour").

Only the chat service marks an owner turn, with `owner-turn` right before it sends the
owner's prompt to a session on this machine. That prompt starts the session's next run
(107 of 107 owner prompts on 10-14 08:06-11:02 KST did), so the mark waits for that run's
admit, which starts at once and counts toward the limit. A session queued when the mark
lands has an agent run in the way: that run starts at once as kind "ahead", and the
owner's run after it takes the mark.

The pi-pool extension asks at a run's first model call, renews the slot's lease from the
run's model calls (`admit --renew`), and releases at agent_end or when it finds the
session idle. A slot whose lease ran out (a run stuck in one tool call reaches it after
lease_s with no model call) or whose process (`pid`, the Prime worker that asked) is gone
is dropped, and so is a queue entry whose `admit --wait` process (`waiter`) is gone.
"""
import json, os, sys, time

from . import base, registry, sched

TURNS = os.path.join(base.POOL, "turns.json")
TURNS_LOCK = os.path.join(base.POOL, "turns.lock")
# An owner-turn mark that no admit consumed (a failed send) is dropped after this long.
# A mark waits for the session's next turn, which starts after the turn in flight ends:
# the 99th percentile turn was 2,956 s over the 22,675 turns of 10-11 to 10-14.
OWNER_MARK_TTL_SEC = 3600
# A run released with no flag whose session asks again this soon after keeps its place, as if released with --queued-input: its next
# run started at once, so Prime held input for it. A session keeps the extension it loaded until it reloads, and those from before
# --queued-input send none. measured: of the 8,756 re-asks on us-metal02 from 10-26 02:00Z to 10-27 03:13Z, 3,357 came within 2 s
# of the release by the 1 s stamps of pi-pool.log, 46 in the third second and 79 in the fourth and fifth.
REASK_SEC = 2.0
# `admit --wait` re-reads turns.json this often while queued.
WAIT_POLL_SEC = 1.0
LOCK_TIMEOUT = 6.0
OFF = {"state": "off", "kind": None, "position": None, "total": None}


def limits(cfg):
    """(the machine max, the tree max), or (None, None) while the queue is off."""
    if not int(cfg["agent_queue_on"]):
        return None, None
    return int(cfg["working_max"]), int(cfg["tree_working_max"])


def empty():
    return {"working": {}, "queued": {}, "owner": {}, "lead": [], "kept": {}}


def of(raw):
    """The five parts of a turns record, with what an older writer left dropped."""
    raw = raw if isinstance(raw, dict) else {}
    out = {key: dict(raw.get(key) or {}) for key in ("working", "queued", "owner", "kept")}
    out["lead"] = [s for s in raw.get("lead") or [] if isinstance(s, str)]
    return out


def carried(old):
    """The queue that state.json's `turns` key held before 10-20, in this file's shape: a run
    on a lent slot or a prod turn keeps working on a slot of its own."""
    old = of(old)
    working = {s: {"tree": e["tree"], "kind": "slot" if e.get("kind") in ("borrow", "prod") else e.get("kind", "slot"),
                   "since": e["since"], "queued_since": e.get("queued_since", e["since"]), "pid": e.get("pid"),
                   "lease_until": e.get("lease_until", 0)} for s, e in old["working"].items()}
    queued = {s: {k: e[k] for k in ("tree", "since", "pid", "waiter") if e.get(k) is not None} for s, e in old["queued"].items()}
    return {"working": working, "queued": queued, "owner": old["owner"], "lead": [], "kept": {}}


def migrate():
    """Move the queue out of state.json, once: its `turns` key goes to turns.json and leaves state.json."""
    with base.Flock(base.LOCK, timeout=base.STATE_LOCK_TIMEOUT):
        state = base.load_json(base.STATE, None)
        old = state.pop("turns", None) if isinstance(state, dict) else None
        if old is not None:
            base.save_json(base.STATE, state)
    return carried(old)


def current():
    """turns.json as it is, or what state.json still holds before the first write; no lock."""
    if os.path.exists(TURNS):
        return of(base.load_json(TURNS, {}))
    return carried((base.load_json(base.STATE, {}) or {}).get("turns"))


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


def asked(entry):
    """When a queued run asked; its `since` is its place in line."""
    return entry.get("asked", entry["since"])


def waiting_slot(tree):
    """The latest slot `tree` waits for on any provider in state.json, read with no lock, or None when it waits for no account."""
    rec = ((base.load_json(base.STATE, {}) or {}).get("sessions") or {}).get(tree) or {}
    slots = [w["slot_at"] for w in (rec.get("wait") or {}).values() if isinstance(w, dict) and isinstance(w.get("slot_at"), (int, float))]
    return max(slots) if slots else None


def order(turns):
    """Queued session ids in admission order: the lead sessions' runs first, then the rest, each first asked, first in."""
    queued, lead = turns["queued"], set(turns["lead"])
    return sorted(queued, key=lambda s: (s not in lead, queued[s]["since"], s))


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
                gone.append({"session": session, "part": part, "why": why})
    for session, at in list(turns["owner"].items()):
        if now - at > OWNER_MARK_TTL_SEC:
            del turns["owner"][session]
    for session, kept in list(turns["kept"].items()):
        if now - kept["slot_at"] > (REASK_SEC if kept.get("reask") else sched.PLACE_KEEP_SEC):
            del turns["kept"][session]
    return gone


def start(turns, session, kind, now, lease):
    """Move a queued session to working."""
    entry = turns["queued"].pop(session)
    turns["working"][session] = {"tree": entry["tree"], "kind": kind, "since": now, "queued_since": asked(entry), "place": entry["since"],
                                 "pid": entry.get("pid"), "lease_until": now + lease}


def admit_pass(turns, now, all_max, tree_max, lease):
    """Start queued runs in `order` while slots are free. Returns [(session, "slot")]."""
    admitted = []
    trees = {}
    for entry in turns["working"].values():
        trees[entry["tree"]] = trees.get(entry["tree"], 0) + 1
    for session in order(turns):
        if len(turns["working"]) >= all_max:
            break
        tree = turns["queued"][session]["tree"]
        if trees.get(tree, 0) >= tree_max:
            continue
        start(turns, session, "slot", now, lease)
        trees[tree] = trees.get(tree, 0) + 1
        admitted.append((session, "slot"))
    return admitted


def reply(turns, session):
    """The admit answer for one session, as the CLI prints it."""
    if session in turns["working"]:
        return {"state": "admitted", "kind": turns["working"][session]["kind"], "position": None, "total": None}
    if session in turns["queued"]:
        queue = order(turns)
        return {"state": "queued", "kind": None, "position": queue.index(session) + 1, "total": len(queue)}
    return {"state": "released", "kind": None, "position": None, "total": None}


def view(turns, now, cfg):
    """`pi-pool queue --json`."""
    queue, lead = order(turns), set(turns["lead"])
    working = [{"session": s, "tree": e["tree"], "kind": e["kind"], "since": e["since"]}
               for s, e in sorted(turns["working"].items(), key=lambda kv: kv[1]["since"])]
    queued = [{"session": s, "tree": turns["queued"][s]["tree"], "position": i + 1, "total": len(queue),
               "since": asked(turns["queued"][s]), "wait_s": round(now - asked(turns["queued"][s])), "lead": s in lead} for i, s in enumerate(queue)]
    return {"enabled": limits(cfg)[0] is not None, "working_max": int(cfg["working_max"]),
            "working_max_set": last_set("working_max"), "tree_working_max": int(cfg["tree_working_max"]),
            "working": working, "queued": queued, "lead": turns["lead"]}


def last_set(key):
    """Who set `key` and when ({by, at} in epoch seconds) from `pi-pool set`; None while the key holds its default.
    A value written before `set` recorded its writer has by None and config.json's file time."""
    saved = base.load_json(base.CONFIG, {}) or {}
    if key not in saved:
        return None
    return (saved.get("set_by") or {}).get(key) or {"by": None, "at": round(os.path.getmtime(base.CONFIG))}


# --------------------------------------------------------------------- the CLI
USAGE = "usage: pi-pool admit <session> [--tree <root session>] [--pid <n>] [--wait | --renew]"
# A running session keeps the extension code it loaded, and the extension before 10-20 passes these; they are read and ignored.
IGNORED = ("--parent", "--class")


def parse(rest):
    out = {"session": None, "tree": None, "pid": None, "wait": False, "renew": False}
    i = 0
    while i < len(rest):
        tok = rest[i]
        if tok in ("--wait", "--renew"):
            out[tok[2:]] = True
        elif tok in ("--tree", "--pid", *IGNORED):
            if i + 1 >= len(rest):
                raise SystemExit(USAGE)
            if tok not in IGNORED:
                out[tok[2:]] = rest[i + 1]
            i += 1
        elif out["session"] is None and not tok.startswith("--"):
            out["session"] = tok
        else:
            raise SystemExit(USAGE)
        i += 1
    if not out["session"] or (out["wait"] and out["renew"]):
        raise SystemExit(USAGE)
    out["pid"] = int(out["pid"]) if out["pid"] is not None else os.getppid()
    return out


def ask(turns, a, now, cfg, waiter=None):
    """One admit, under the lock. Returns (changed, answer, events to log).

    A session already working renews its lease. --renew comes from a run in flight: a
    session whose slot lapsed works again at once and never queues, because the queue
    never stops a running turn."""
    session = a["session"]
    all_max, tree_max = limits(cfg)
    if all_max is None:
        return turns["queued"].pop(session, None) is not None, OFF, []
    lease = int(cfg["lease_s"])
    events = [("turn_swept", g) for g in sweep(turns, now)]
    admitted = admit_pass(turns, now, all_max, tree_max, lease)
    entry = {"tree": a["tree"], "since": now, "pid": a["pid"]}
    if session in turns["working"]:
        turns["working"][session].update(pid=a["pid"], lease_until=now + lease)
    elif session in turns["queued"] and not a["renew"]:
        turns["queued"][session].update(pid=a["pid"], waiter=waiter)
    elif turns["owner"].pop(session, None) is not None:
        turns["queued"].pop(session, None)
        turns["kept"].pop(session, None)
        turns["working"][session] = dict(entry, kind="owner", queued_since=now, lease_until=now + lease)
        admitted.append((session, "owner"))
    elif a["renew"]:
        was = turns["queued"].pop(session, None)
        turns["working"][session] = dict(entry, kind="slot", queued_since=asked(was or entry), lease_until=now + lease)
        events.append(("turn_renewed_after_lapse", {"session": session, "tree": a["tree"]}))
    else:
        kept = turns["kept"].pop(session, None)
        turns["queued"][session] = dict(entry, waiter=waiter, **({"since": kept["since"], "asked": now} if kept else {}))
        admitted += admit_pass(turns, now, all_max, tree_max, lease)
        if session in turns["queued"]:
            events.append(("turn_queued", {"session": session, "tree": a["tree"], "working": len(turns["working"]), "queued": len(turns["queued"]),
                                           **({"kept_since": kept["since"]} if kept else {})}))
    return True, reply(turns, session), events + admitted_events(turns, admitted, now)


def admitted_events(turns, admitted, now):
    return [("turn_admitted", {"session": s, "tree": turns["working"][s]["tree"], "kind": kind,
                               "waited_s": round(now - turns["working"][s]["queued_since"], 1)}) for s, kind in admitted]


def emit(answer):
    sys.stdout.write(json.dumps(answer) + "\n")
    sys.stdout.flush()


def locked(fn):
    """Run fn(turns, now) under turns.lock, and log and save what it returns.
    fn returns (changed, result, events)."""
    with base.Flock(TURNS_LOCK, timeout=LOCK_TIMEOUT):
        first = not os.path.exists(TURNS)
        turns = migrate() if first else of(base.load_json(TURNS, {}))
        now = time.time()
        changed, result, events = fn(turns, now)
        if changed or first:
            base.save_json(TURNS, turns)
    for event, fields in events:
        base.log(event, **fields)
    return result


def step(turns, now, cfg):
    """Sweep, then start what fits. Returns (changed, events)."""
    gone = sweep(turns, now)
    events = [("turn_swept", g) for g in gone]
    all_max, tree_max = limits(cfg)
    if all_max is None:
        return bool(gone), events
    admitted = admit_pass(turns, now, all_max, tree_max, int(cfg["lease_s"]))
    return bool(gone or admitted), events + admitted_events(turns, admitted, now)


def cmd_admit(rest):
    a = parse(rest)
    if a["tree"] is None:
        key = registry.session_key()
        a["tree"] = key.key if key else a["session"]
    waiter = os.getpid() if a["wait"] else None
    answer = locked(lambda turns, now: ask(turns, a, now, base.config(), waiter))
    emit(answer)
    if not a["wait"] or answer["state"] != "queued":
        return 0
    return wait(a["session"], a["pid"], answer)


def wait(session, pid, last):
    """Block until `session` is admitted. Prints one JSON line each time its place
    changes, and the admitted (or off) line last. Takes the lock only when an unlocked
    read shows that a sweep and an admit pass would admit this session."""
    seen, snapshot = None, empty()
    while True:
        time.sleep(WAIT_POLL_SEC)
        if not alive(pid):
            release(session, reason="turn process gone")
            return 1
        cfg = base.config()
        all_max, tree_max = limits(cfg)
        if all_max is None:
            release(session, reason="queue off")
            emit(OFF)
            return 0
        try:
            mtime = os.stat(TURNS).st_mtime_ns
        except OSError:
            mtime = None
        if mtime != seen:
            seen, snapshot = mtime, current()
        now = time.time()
        trial = json.loads(json.dumps(snapshot))
        sweep(trial, now)
        admit_pass(trial, now, all_max, tree_max, int(cfg["lease_s"]))
        answer = reply(trial, session)
        if answer["state"] != "queued" and session not in snapshot["working"]:
            def settle(turns, now):
                changed, events = step(turns, now, cfg)
                return changed, reply(turns, session), events
            answer = locked(settle)
            seen = None
        if answer["state"] in ("admitted", "released"):
            emit(answer)
            return 0 if answer["state"] == "admitted" else 1
        if (answer["position"], answer["total"]) != (last["position"], last["total"]):
            emit(answer)
            last = answer


def leave(turns, session, now, cfg, reason=None, slot_of=waiting_slot, queued_input=False):
    """Free `session`'s slot or drop its queue entry, then start what fits. A run let go while its tree
    waits for an account, or with input queued for the session's next run, leaves its place in `kept`
    for that next run. Returns (changed, answer, events)."""
    working = turns["working"].pop(session, None)
    queued = turns["queued"].pop(session, None)
    slot_at = slot_of(working["tree"]) if working else None
    if working:
        place = working.get("place", working["queued_since"])
        turns["kept"][session] = ({"since": place, "slot_at": slot_at} if slot_at is not None else {"since": place, "slot_at": now} if queued_input
                                  else {"since": place, "slot_at": now, "reask": True})
    changed, events = step(turns, now, cfg)
    if working:
        events = [("turn_released", {"session": session, "kind": working["kind"], "held_s": round(now - working["since"], 1),
                                     **({"account_wait": True} if slot_at is not None else {}),
                                     **({"queued_input": True} if queued_input else {})})] + events
    elif queued:
        events = [("turn_dropped", {"session": session, "waited_s": round(now - asked(queued), 1), "reason": reason})] + events
    return bool(working or queued or changed), {"released": bool(working or queued)}, events


def release(session, reason=None, queued_input=False):
    return locked(lambda turns, now: leave(turns, session, now, base.config(), reason, queued_input=queued_input))


def cmd_release(rest):
    """`release <session> [--queued-input]`: the extension adds --queued-input at an agent_end with input queued in Prime."""
    flags = [tok for tok in rest if tok.startswith("--")]
    sessions = [tok for tok in rest if not tok.startswith("--")]
    if len(sessions) != 1 or any(tok != "--queued-input" for tok in flags):
        raise SystemExit("usage: pi-pool release <session> [--queued-input]")
    emit(release(sessions[0], reason="release", queued_input=bool(flags)))
    return 0


def mark_owner(turns, session, now, lease):
    """The owner's prompt to `session` goes out next: mark its next admit as the owner's.
    A queued agent run of the session would hold that prompt behind the queue, so it
    starts now as kind "ahead". Returns (answer, events to log)."""
    turns["owner"][session] = now
    events = [("turn_owner_marked", {"session": session})]
    if session not in turns["queued"]:
        return {"session": session, "state": "marked"}, events
    start(turns, session, "ahead", now, lease)
    return {"session": session, "state": "marked", "ahead": True}, events + admitted_events(turns, [(session, "ahead")], now)


def cmd_owner_turn(rest):
    """The session's next admit is an owner turn. A queued run of the session starts now."""
    if len(rest) != 1 or rest[0].startswith("--"):
        raise SystemExit("usage: pi-pool owner-turn <session>")
    cfg = base.config()
    # The box wrote 3,956 marks on 10-19 with its queue off, each under the pool flock that every token request takes.
    if limits(cfg)[0] is None:
        emit({"session": rest[0], "state": "off"})
        return 0

    def mark(turns, now):
        answer, events = mark_owner(turns, rest[0], now, int(cfg["lease_s"]))
        return True, answer, events
    emit(locked(mark))
    return 0


def cmd_lead(rest):
    """Replace the lead list with these sessions, whose queued runs start before every other run; no sessions clears it.
    The same list again changes nothing, so turns.json and its waiters are left alone."""
    if any(s.startswith("-") for s in rest):
        raise SystemExit("usage: pi-pool lead [<session>...]")
    sessions = sorted(set(rest))

    def put(turns, now):
        if turns["lead"] == sessions:
            return False, {"lead": sessions}, []
        turns["lead"] = sessions
        return True, {"lead": sessions}, [("turn_lead_set", {"sessions": len(sessions)})]
    emit(locked(put))
    return 0


def cmd_queue(rest):
    if rest not in ([], ["--json"]):
        raise SystemExit("usage: pi-pool queue [--json]")
    turns, cfg, now = current(), base.config(), time.time()
    sweep(turns, now)
    out = view(turns, now, cfg)
    if rest:
        emit(out)
        return 0
    if not out["enabled"]:
        print("The queue is off.")
    else:
        print(f"{len(out['working'])} of {out['working_max']} working, {len(out['queued'])} queued.")
    for e in out["queued"]:
        print(f"  {e['position']}. {e['session']} waiting {e['wait_s']} s")
    return 0
