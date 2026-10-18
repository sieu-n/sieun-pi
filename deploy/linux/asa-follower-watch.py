#!/usr/bin/python3
"""Watch the Mac's auto-sns-agent checkout from the tip host, and get it following the tip again when it stops.

The Mac checkout is a follower of this box's sieun/dev, kept along by launchd ai.virev.asa-tip-sync on the Mac.
On 2026-10-18 that job failed in three ways nobody heard of: from 11:24Z to 12:01Z it was not loaded at all
("Could not find service"), at 12:01Z launchd's /usr/bin/python3 got "Operation not permitted" on ~/Documents from
macOS privacy rules, and its own ten minute alert never went out, because the prime-agent path it calls exists only
on the box. So this check runs on the box, reads the result over ssh, and does not trust the job to report itself.

Each run reads the Mac's sieun/dev, the launchd job and the sync log with one ssh call. When the Mac's HEAD differs
from the tip and has not moved for HEAL_S, it loads the launchd job if it is missing and starts one sync run over
ssh, since sshd can read ~/Documents when launchd cannot. At ALERT_S it tells the ops chat once, and tells it again
when the Mac follows the tip.
"""
import json, os, subprocess, sys, time

REPO = os.environ.get("AFW_REPO") or os.path.expanduser("~/Documents/Github/auto-sns-agent")
BRANCH = "refs/heads/sieun/dev"
# One probe took 0.5 s at Mac load 200 (12:23Z on 2026-10-18); the 120 s subprocess timeouts below only end a hung ssh.
SSH = (os.environ.get("AFW_SSH") or "ssh -o BatchMode=yes -o ConnectTimeout=20 mac").split()
STATE = os.environ.get("AFW_STATE") or os.path.expanduser("~/.local/state/asa-follower-watch/state.json")
LOG = os.environ.get("AFW_LOG") or os.path.expanduser("~/.local/state/asa-follower-watch/watch.log")
PRIME_BIN = os.environ.get("AFW_PRIME_BIN") or os.path.expanduser("~/.local/bin/prime-agent")
# The ops chat asa-tip-sync and box-memory-guard send to.
OPS_THREAD = os.environ.get("AFW_OPS_THREAD") or "01a11af8-962e-773d-a19a-ee4104011987"
# The VP of CI asked on 2026-10-18 for an alert after 10 min blocked (asa-tip-sync's BLOCK_ALERT_S), after the box sat 73 min behind.
ALERT_S = int(os.environ.get("AFW_ALERT_S") or 600)
# launchd starts a sync every 60 s, so a HEAD that has not moved through 5 runs is not just between runs.
HEAL_S = int(os.environ.get("AFW_HEAL_S") or 300)

MAC_LABEL = "ai.virev.asa-tip-sync"
MAC_PROBE = r"""
import json, os, subprocess
home = os.path.expanduser("~")
repo = home + "/Documents/Github/auto-sns-agent"
script = home + "/.local/share/asa-tip-sync/asa-tip-sync.py"
plist = home + "/Library/LaunchAgents/LABEL.plist"
state = home + "/.local/state/asa-tip-sync"
def run(*a):
    p = subprocess.run(a, capture_output=True, text=True)
    return p.returncode, p.stdout, p.stderr
rc, head, err = run("git", "-C", repo, "rev-parse", "-q", "--verify", "refs/heads/sieun/dev")
rc2, svc, _ = run("launchctl", "print", "gui/%d/LABEL" % os.getuid())
last = ""
try:
    last = open(state + "/sync.log").read().splitlines()[-1]
except (OSError, IndexError):
    pass
runs = [l.split(None, 1) for l in run("ps", "-axo", "etime=,args=")[1].splitlines()]
runs = [e for e, a in (r for r in runs if len(r) == 2) if a.endswith("-B " + script)]
print(json.dumps({"head": head.strip() or None, "head_error": err.strip()[-300:], "loaded": rc2 == 0,
                  "plist": os.path.exists(plist), "script": os.path.exists(script),
                  "last_line": last[:600], "runs": runs}))
""".replace("LABEL", MAC_LABEL)
HEAL_RUN = ("nohup /usr/bin/python3 -B ~/.local/share/asa-tip-sync/asa-tip-sync.py "
            ">>~/.local/state/asa-tip-sync/launchd.log 2>&1 </dev/null &")
LOAD = f"launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/{MAC_LABEL}.plist"


def git(*args):
    return subprocess.run(["git", "-C", REPO, *args], capture_output=True, text=True)


def probe():
    """The Mac's state as a dict, or {"error": ...} when ssh or the probe fails."""
    try:
        p = subprocess.run([*SSH, "/usr/bin/python3", "-"], input=MAC_PROBE, capture_output=True, text=True, timeout=120)
    except subprocess.TimeoutExpired:
        return {"error": "ssh timed out after 120 s"}
    if p.returncode != 0:
        return {"error": f"ssh exit {p.returncode}: {p.stderr.strip()[-300:]}"}
    try:
        return json.loads(p.stdout.strip().splitlines()[-1])
    except (ValueError, IndexError):
        return {"error": f"probe printed {p.stdout[-300:]!r}"}


def decide(state, mac, tip, now):
    """(new state, actions) for one run. Actions are ("load",), ("run",), ("alert", text) and ("recovered", text)."""
    head = mac.get("head")
    if head and head == tip:
        acts = [("recovered", f"[asa-follower-watch] The Mac follows the tip host again at {tip[:10]}.")] if state.get("alerted") else []
        return {}, acts
    new = dict(state)
    if mac.get("error"):
        new.setdefault("since", now)
    elif head != state.get("head"):
        new.update(head=head, since=now)
    else:
        new.setdefault("since", now)
    stale = now - new["since"]
    acts = []
    if not mac.get("error"):
        if not mac.get("loaded") and mac.get("plist"):
            acts.append(("load",))
        if stale >= HEAL_S and not mac.get("runs") and mac.get("script") and now - state.get("healed", 0) >= HEAL_S:
            acts.append(("run",))
            new["healed"] = now
    if stale >= ALERT_S and not state.get("alerted"):
        acts.append(("alert", alert_text(mac, tip, int(stale // 60), [a[0] for a in acts])))
        new["alerted"] = True
    return new, acts


def alert_text(mac, tip, mins, healing):
    if mac.get("error"):
        return f"[asa-follower-watch] The box cannot read the Mac checkout for {mins} min: {mac['error']}. Tip {tip[:10]}."
    why = []
    if not mac.get("loaded"):
        why.append(f"launchd {MAC_LABEL} is not loaded" + ("" if mac.get("plist") else " and its plist is missing"))
    if mac.get("runs"):
        why.append(f"a sync run has been going for {mac['runs'][0]}")
    if "Operation not permitted" in mac.get("last_line", ""):
        why.append("macOS refuses the launchd run the Documents folder")
    behind = git("rev-list", "--count", f"{mac['head']}..{tip}").stdout.strip() if mac.get("head") else ""
    did = {"load": "loaded the launchd job", "run": "started a sync run over ssh"}
    return (f"[asa-follower-watch] The Mac's auto-sns-agent sieun/dev has not followed the tip host for {mins} min. "
            f"Mac HEAD {(mac.get('head') or 'unknown')[:10]}, tip {tip[:10]}" + (f", {behind} commits behind" if behind else "") + ". "
            + ("; ".join(why)[:1].upper() + "; ".join(why)[1:] + ". " if why else "")
            + (f"This check {' and '.join(did[h] for h in healing)}. " if healing else "")
            + f"Last sync log line: {mac.get('last_line') or 'none'}")


def act(a):
    if a[0] in ("load", "run"):
        cmd = LOAD if a[0] == "load" else HEAL_RUN
        p = subprocess.run([*SSH, cmd], capture_output=True, text=True, timeout=120)
        return p.returncode == 0, p.stderr.strip()[-300:]
    p = subprocess.run([PRIME_BIN, "send", OPS_THREAD, a[1]], capture_output=True, text=True, timeout=120)
    return p.returncode == 0, p.stderr.strip()[-300:]


def main():
    tip = git("rev-parse", BRANCH).stdout.strip()
    try:
        state = json.load(open(STATE))
    except (OSError, ValueError):
        state = {}
    mac = probe()
    now = time.time()
    new, acts = decide(state, mac, tip, now)
    done = [(a[0], *act(a)) for a in acts]
    if any(k == "alert" and not ok for k, ok, _ in done):
        new.pop("alerted", None)
    os.makedirs(os.path.dirname(STATE), exist_ok=True)
    with open(STATE + ".tmp", "w") as f:
        json.dump(new, f)
    os.replace(STATE + ".tmp", STATE)
    line = {"ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now)), "tip": tip[:10], "mac": (mac.get("head") or "")[:10],
            "stale_s": int(now - new["since"]) if "since" in new else 0, "error": mac.get("error"), "actions": done}
    with open(LOG, "a") as f:
        f.write(json.dumps(line) + "\n")
    print(json.dumps(line))


if __name__ == "__main__" and "--probe" in sys.argv:
    print(json.dumps(probe()))
elif __name__ == "__main__":
    main()
