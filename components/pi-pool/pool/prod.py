"""Prod turns: a turn of a tree or session that a caller marked as on prod work runs at once, like an owner turn.

The pool does not decide what prod work is. The caller that knows (the chat service on this machine)
runs `pi-pool prod set '<json>'` with {"trees": {tree: why}, "sessions": {session: why}, "until": epoch sec}
and sends it again while the work lasts. The record lapses at `until`, so a caller that stops never leaves
a tree marked, and `pi-pool prod clear` drops it at once. state["turns"]["prod"] holds {at, until, trees, sessions}.

Why: on 10-15 the prod crawler was down from 09:16Z and ingress closed at 09:58Z during promote
10 try 3 (promote.yml run 38708750431, 08:52Z to 10:37Z). At the critical limit of 12 the release
owner 01a10810 sat 58th of 60 in this queue at 09:59Z and metal 01a11d24 63rd of 69 at 10:00:38Z.
From 09:16Z to 11:04Z metal's root ran 11 turns for 168 s and waited 6,517 s, and the release
owner's ran 9 for 96 s and waited 5,565 s (tests/live_1015_1859kst.json).
"""
import json

USAGE = "usage: pi-pool prod [set '{\"trees\": {...}, \"sessions\": {...}, \"until\": <epoch sec>}' | clear]"


def parse(text, now):
    """A record from `prod set`, or SystemExit with the usage line."""
    try:
        raw = json.loads(text)
    except ValueError:
        raise SystemExit(USAGE) from None
    if not isinstance(raw, dict) or not isinstance(raw.get("until"), (int, float)) or set(raw) - {"trees", "sessions", "until"}:
        raise SystemExit(USAGE)
    out = {"at": now, "until": float(raw["until"])}
    for part in ("trees", "sessions"):
        given = raw.get(part) or {}
        if not isinstance(given, dict) or not all(isinstance(k, str) and isinstance(v, str) for k, v in given.items()):
            raise SystemExit(USAGE)
        out[part] = dict(given)
    return out


def live(rec, now):
    """The record while it holds, else None."""
    return rec if isinstance(rec, dict) and rec.get("until", 0) >= now else None


def why(rec, session, entry, now):
    """The reason `session` (queued or asking as `entry`) gets a prod turn, or None."""
    rec = live(rec, now)
    if not rec:
        return None
    return (rec.get("sessions") or {}).get(session) or (rec.get("trees") or {}).get(entry.get("tree"))
