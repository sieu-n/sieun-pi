"""Merge, rewrite or delete global harness entries with an undo log, from a Prime kernel.

harness-keeper loads this on its wake to act on data/harness-check-latest.json:

    import sys; sys.path.insert(0, "/home/sieun/src/sieun-pi/components/standing-agents/harness-keeper")
    import harness_edit as he
    he.merge(rlm, "memory", keep="<id>", drop=["<id>"], title=..., content=..., why=...)
    he.rewrite(rlm, "memory", "<id>", title=..., content=..., why=...)
    he.delete(rlm, "memory", "<id>", why=...)
    he.undo(rlm, n=1)  # reverts the newest n logged changes

Each change appends one JSON line to UNDO_LOG before the store is written, holding the full
entry before and after, so undo() can restore it. Other jobs edit the global store at the same
time, so every call reads the entry fresh and refuses one that is gone. An entry the latest check
listed under agent_scoped is refused, because the per-agent mem-<slug> jobs own those.
"""
import dataclasses
import datetime
import json
import os

UNDO_LOG = os.path.expanduser("~/work/agent-memory/harness-keeper/undo.jsonl")
CHECK = os.path.expanduser("~/.pi/agent/agents/harness-keeper/data/harness-check-latest.json")


def _now():
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _entry(rlm, kind, id):
    e = rlm.harness.get(kind, id, global_=True)
    return dataclasses.asdict(e) if e is not None else None


def _agent_scoped(kind, id):
    try:
        scoped = json.load(open(CHECK)).get("agent_scoped", [])
    except (OSError, ValueError):
        return None
    return next((s["agent"] for s in scoped if s["kind"] == kind and s["id"] == id), None)


def _key(rec):
    return f"{rec['at']}|{rec['action']}|{rec['kind']}|{rec['id']}"


def _log(action, kind, id, before, after, why, group=None, undoes=None):
    os.makedirs(os.path.dirname(UNDO_LOG), exist_ok=True)
    rec = {"at": _now(), "by": "harness-keeper", "action": action, "kind": kind, "id": id,
           "group": group, "before": before, "after": after, "why": why}
    if undoes:
        rec["undoes"] = undoes
    with open(UNDO_LOG, "a") as f:
        f.write(json.dumps(rec) + "\n")


def _require(rlm, kind, id):
    agent = _agent_scoped(kind, id)
    if agent:
        raise ValueError(f"{kind} {id!r} names agent {agent!r}; its mem-{agent} job owns it")
    before = _entry(rlm, kind, id)
    if before is None:
        raise ValueError(f"{kind} {id!r} is no longer in the global store")
    return before


def rewrite(rlm, kind, id, title, content, why, path=None, group=None):
    before = _require(rlm, kind, id)
    after = {**before, "title": title, "content": content, "path": path or before["path"]}
    _log("update", kind, id, before, after, why, group)
    rlm.harness.update(kind, id, title, content, path=path or before["path"], global_=True)
    return _entry(rlm, kind, id)


def delete(rlm, kind, id, why, group=None):
    before = _require(rlm, kind, id)
    _log("delete", kind, id, before, None, why, group)
    rlm.harness.delete(kind, id, global_=True)
    return before


def merge(rlm, kind, keep, drop, title, content, why, path=None):
    """Rewrite keep to hold the merged text, then delete every id in drop."""
    for id in drop:
        _require(rlm, kind, id)
    group = f"merge:{keep}:{_now()}"
    rewrite(rlm, kind, keep, title, content, why, path=path, group=group)
    for id in drop:
        delete(rlm, kind, id, f"merged into {keep}: {why}", group=group)
    return _entry(rlm, kind, keep)


def undo(rlm, n=1):
    """Revert the newest n logged changes, newest first, and log each revert."""
    lines = [json.loads(line) for line in open(UNDO_LOG)]
    undone = {r.get("undoes") for r in lines}
    done = []
    for rec in [r for r in lines if r["action"] in ("update", "delete") and _key(r) not in undone][::-1][:n]:
        b, kind, id = rec["before"], rec["kind"], rec["id"]
        current = _entry(rlm, kind, id)
        if current is None:
            rlm.harness.create(kind, b["title"], b["content"], id=id, path=b["path"], metadata=b.get("metadata") or {}, global_=True)
        else:
            rlm.harness.update(kind, id, b["title"], b["content"], path=b["path"], global_=True)
        _log("undo", kind, id, current, b, f"undo of {rec['action']} at {rec['at']}", undoes=_key(rec))
        done.append((rec["action"], kind, id))
    return done
