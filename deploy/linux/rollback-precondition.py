#!/usr/bin/python3
"""Rollback precondition for the box's Prime install: does a pointer move to TARGET drop ownership of a detached service?

usage: rollback-precondition.py [AGENT_DIR] --target EXE [--checker EXE]
  AGENT_DIR  defaults to ~/.prime/agent.
  --target   the prime-agent executable the rollback would activate.
  --checker  the release that runs Prime's own target check, `<checker> update --internal-check-update-target <target>`
             (cli/update-target-guard.ts). It defaults to the executable bin/prime-agent names, the same release install.sh
             passes as PRIME_AGENT_UPDATE_TARGET_CHECK. It runs with PRIME_AGENT_INTERACTIVE_SELF_UPDATE=1, as
             install.sh's callers set it, because without it `update` is read as the package command.

Read only. Prints JSON and exits 0 when the rollback drops no ownership, 1 otherwise.
A receipt that is not stopped or aborted, a stop intent, or an unreadable receipt blocks only a target that cannot honor it.
With no such file the rollback is clean. With one, the checker probes the target's daemon capabilities and refuses a target
that serves no detached_handoff. The checker's refusal, or any failure to run it, blocks."""
import argparse, glob, json, os, subprocess, sys

p = argparse.ArgumentParser()
p.add_argument("agent", nargs="?", default=os.path.expanduser("~/.prime/agent"))
p.add_argument("--target", required=True)
p.add_argument("--checker")
a = p.parse_args()
checker = a.checker or os.path.realpath(os.path.expanduser("~/.local/share/prime-agent/bin/prime-agent"))

holders = []
for path in sorted(glob.glob(f"{a.agent}/daemon-workers/*/detached-handoffs/**/*.json", recursive=True)):
    if "/stop-intents/" in path:
        holders.append({"kind": "stop-intent", "path": path})
        continue
    try:
        body = json.load(open(path))
    except Exception as e:
        holders.append({"kind": "unreadable-receipt", "path": path, "error": type(e).__name__})
        continue
    if body.get("state") not in ("stopped", "aborted"):
        holders.append({"kind": "receipt", "state": body.get("state"), "handoffId": body.get("handoffId"), "sessionId": body.get("sessionId"),
                        "pids": [g.get("leader", {}).get("pid") for g in body.get("groups", [])], "path": path})

out = {"target": a.target, "checker": checker, "holders": holders}
if not holders:
    out |= {"ok": True, "verdict": "clean"}
else:
    env = dict(os.environ, PRIME_AGENT_CODING_AGENT_DIR=a.agent, PRIME_AGENT_INTERACTIVE_SELF_UPDATE="1")
    try:
        r = subprocess.run([checker, "update", "--internal-check-update-target", a.target], env=env, capture_output=True, text=True)
        out |= {"ok": r.returncode == 0, "verdict": "capable" if r.returncode == 0 else "refused", "checkerExit": r.returncode,
                "checkerStderr": r.stderr.strip()[-2000:]}
    except OSError as e:
        out |= {"ok": False, "verdict": "checker-failed", "error": f"{type(e).__name__}: {e}"}
print(json.dumps(out, indent=1))
sys.exit(0 if out["ok"] else 1)
