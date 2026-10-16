"""Prod turns: a turn runs at once, like an owner turn, while its session works on prod.

Two signals make a prod turn, read by `read` at most every turns.PROD_TTL_SEC and kept in
state["turns"]["prod"] as {at, trees: {tree: why}, sessions: {session: why}}:

- A run of a prod deploy workflow (prod_deploy_owners, by workflow file) that GitHub has not
  completed, read from the ci-runs cache (prod_runs_file). Every turn of each owner's tree is a
  prod turn until the run completes. The release owner dispatches promote.yml and metal deploys
  what it ships, so both own it.
- A firing prod alert in the alert bridge's state (alert_bridge_file). The bridge drops an alert
  when it resolves. The chat session the bridge woke for it gets prod turns until then; its jobs
  queue as before.

Why: on 10-15 the prod crawler was down from 09:16Z and ingress closed at 09:58Z during promote
10 try 3 (promote.yml run 38708750431, 08:52Z to 10:37Z). At the critical limit of 12 the release
owner 01a10810 sat 58th of 60 in this queue at 09:59Z and metal 01a11d24 63rd of 69 at 10:00:38Z.
From 09:16Z to 11:04Z metal's root ran 11 turns for 168 s and waited 6,517 s, and the release
owner's ran 9 for 96 s and waited 5,565 s (tests/live_1015_1859kst.json).

Both caches refresh every 30 s (ci-runs.json intervalSeconds, the bridge's poll_every_s), so a
read every PROD_TTL_SEC sees each change within a minute. Reading the 72 MB ci-runs.json
and finding its deploy runs took 80 ms on 10-15; the scan parses only the runs whose workflow
path matches.
"""
import json, os, re

from . import base

DONE = "completed"
# A run object in ci-runs.json is the GitHub API's, a few KB with its actor and repository.
RUN_WINDOW = 1 << 16
ALERT_PROD = re.compile(r"\b(prod|production)\b", re.I)
ALERT_NOT_PROD = re.compile(r"\b(staging|stg|dev)\b", re.I)


def path(cfg, key):
    return os.path.expanduser(cfg[key])


def running_deploys(runs_file, workflows):
    """{workflow file: [run id, ...]} for runs of `workflows` that GitHub has not completed."""
    if not workflows:
        return {}
    try:
        with open(runs_file, "rb") as f:
            blob = f.read()
    except OSError:
        return {}
    names = "|".join(re.escape(w) for w in sorted(workflows))
    found = {}
    decoder = json.JSONDecoder()
    for m in re.finditer(rb'"path":\s*"\.github/workflows/(' + names.encode() + rb')"', blob):
        start = blob.rfind(b"{", 0, max(0, blob.rfind(b'"id":', 0, m.start())))
        if start < 0:
            continue
        try:
            run, _ = decoder.raw_decode(blob[start:start + RUN_WINDOW].decode("utf-8", "replace"))
        except ValueError:
            continue
        if run.get("path") == ".github/workflows/" + m.group(1).decode() and run.get("status") != DONE:
            found.setdefault(m.group(1).decode(), []).append(run.get("id"))
    return found


def prod_alert(name):
    return bool(ALERT_PROD.search(name or "")) and not ALERT_NOT_PROD.search(name or "")


def firing_alerts(bridge_file):
    """{chat session: alert name} for the prod alerts the bridge tracks as firing."""
    state = base.load_json(bridge_file, {}) or {}
    alerts = state.get("alerts") if isinstance(state, dict) else None
    out = {}
    for tracked in (alerts or {}).values():
        if isinstance(tracked, dict) and isinstance(tracked.get("chat"), str) and prod_alert(tracked.get("alertname")):
            out.setdefault(tracked["chat"], tracked["alertname"])
    return out


def read(cfg, now):
    """A fresh state["turns"]["prod"] record."""
    trees, sessions = {}, {}
    owners = cfg.get("prod_deploy_owners") or {}
    for workflow, ids in running_deploys(path(cfg, "prod_runs_file"), list(owners)).items():
        for tree in owners[workflow]:
            trees.setdefault(tree, f"{workflow} run {ids[0]}")
    for chat, name in firing_alerts(path(cfg, "alert_bridge_file")).items():
        sessions.setdefault(chat, f"alert {name}")
    return {"at": now, "trees": trees, "sessions": sessions}


def why(rec, session, entry):
    """The reason `session` (queued or asking as `entry`) gets a prod turn, or None."""
    if not rec:
        return None
    return (rec.get("sessions") or {}).get(session) or (rec.get("trees") or {}).get(entry.get("tree"))
