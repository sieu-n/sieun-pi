#!/usr/bin/python3 -B
"""Drives the real `pi` TUI with the pool extension through a slot wait, in tmux, against a fake pool and a fake
Anthropic server, and writes the pane snapshots and a verdict.

    python3 pi-pool/check/tui-hold.py --name hold --wait-sec 600 --scratch <dir> --out <evidence dir>
    python3 pi-pool/check/tui-hold.py --name esc --wait-sec 3600 --escape-after 120 --scratch <dir> --out <dir>

The fake pool answers exit 75 until --wait-sec from the prompt, so the extension's header hook holds the request
that long. With --escape-after the rig presses Escape in the TUI after that many seconds of holding.
"""
import argparse, glob, json, os, shlex, subprocess, sys, time

HERE = os.path.dirname(os.path.abspath(__file__))
STACK = os.path.dirname(os.path.dirname(HERE))

p = argparse.ArgumentParser()
p.add_argument("--name", required=True)
p.add_argument("--wait-sec", type=float, required=True)
p.add_argument("--escape-after", type=float)
p.add_argument("--scratch", required=True)
p.add_argument("--out", required=True)
a = p.parse_args()

root = os.path.join(a.scratch, f"tui-{a.name}")
dirs = {k: os.path.join(root, k) for k in ("agent", "pool", "ws", "sessions")}
for d in dirs.values():
    os.makedirs(d, exist_ok=True)
with open(os.path.join(dirs["agent"], "settings.json"), "w") as f:
    json.dump({"quietStartup": True, "retry": {"baseDelayMs": 200}}, f)
open(os.path.join(dirs["pool"], "turns.json"), "w").write("{}")
os.makedirs(a.out, exist_ok=True)
log_path = os.path.join(a.out, f"tui-{a.name}.jsonl")
log = open(log_path, "w")
t0 = time.time()


def note(step, **kw):
    log.write(json.dumps({"t": round(time.time() - t0, 1), "step": step, **kw}) + "\n")
    log.flush()


def pane():
    return subprocess.run(["tmux", "capture-pane", "-p", "-t", session], capture_output=True, text=True).stdout


def set_wait(until):
    with open(os.path.join(dirs["pool"], "state.json"), "w") as f:
        json.dump({"accounts": ["A", "B"], "current": 0, "waitUntil": until}, f)


set_wait(0)
port_file = os.path.join(root, "url")
if os.path.exists(port_file):
    os.remove(port_file)
requests = os.path.join(root, "requests.jsonl")
open(requests, "w").close()
server_env = dict(os.environ, FAKE_ANSWERS=json.dumps([{"status": 200, "text": f"reply after the {a.name} hold"}]), FAKE_LOG=requests)
server = subprocess.Popen(["node", "--import", "tsx", "pi-pool/check/fake-anthropic-server.ts", port_file], cwd=STACK, env=server_env)
while not os.path.exists(port_file):
    time.sleep(0.2)
url = open(port_file).read().strip()

env = {
    "PI_CODING_AGENT_DIR": dirs["agent"], "PI_OFFLINE": "1", "PI_TELEMETRY": "0", "PI_SKIP_VERSION_CHECK": "1",
    "PI_POOL_TOKEN_BIN": os.path.join(STACK, "pi-pool", "test", "fake-pool.mjs"), "PI_POOL_DIR": dirs["pool"],
    "FAKE_POOL_DIR": dirs["pool"], "FAKE_ANTHROPIC_URL": url, "TERM": "xterm-256color",
}
pi = [os.path.join(STACK, "node_modules", ".bin", "pi"), "-ne", "-e", os.path.join(STACK, "pi-pool", "src", "pi", "index.ts"),
      "-e", os.path.join(STACK, "pi-pool", "check", "anthropic-at.ts"), "--model", "anthropic/claude-sonnet-4-5",
      "--session-dir", dirs["sessions"], "--no-skills", "--no-context-files", "--no-mcp", "-nt"]
session = f"p1135-{a.name}"
subprocess.run(["tmux", "kill-session", "-t", session], capture_output=True)
command = "cd " + shlex.quote(dirs["ws"]) + " && env " + " ".join(f"{k}={shlex.quote(v)}" for k, v in env.items()) + " " + " ".join(map(shlex.quote, pi))
subprocess.run(["tmux", "new-session", "-d", "-s", session, "-x", "160", "-y", "40", command], check=True)
time.sleep(6)
note("started", pane=pane()[-1500:])

held_at = time.time()
set_wait(held_at + a.wait_sec)
subprocess.run(["tmux", "send-keys", "-t", session, "hi", "Enter"], check=True)
note("prompted", wait_until=held_at + a.wait_sec)
escaped = None
deadline = held_at + a.wait_sec + 120
last_snap = 0
while time.time() < deadline:
    time.sleep(1)
    lines = [json.loads(l) for l in open(requests) if l.strip()]
    if lines:
        note("request_seen", request=lines[0], held_sec=round(lines[0]["at"] / 1000 - held_at, 1))
        time.sleep(5)
        break
    if a.escape_after is not None and escaped is None and time.time() - held_at >= a.escape_after:
        note("escape_pressed", held_sec=round(time.time() - held_at, 1), pane=pane()[-1500:])
        subprocess.run(["tmux", "send-keys", "-t", session, "Escape"], check=True)
        escaped = time.time()
    if escaped is not None and time.time() - escaped >= 20:
        break
    if time.time() - last_snap >= 60:
        last_snap = time.time()
        note("holding", held_sec=round(time.time() - held_at, 1), pane=pane()[-800:])

final = pane()
files = glob.glob(os.path.join(dirs["sessions"], "**", "*.jsonl"), recursive=True)
assistant = []
for path in files:
    for line in open(path):
        entry = json.loads(line)
        msg = entry.get("message") or {}
        if entry.get("type") == "message" and msg.get("role") == "assistant":
            assistant.append({"stopReason": msg.get("stopReason"), "errorMessage": msg.get("errorMessage"), "text": "".join(c.get("text", "") for c in msg.get("content", []) if c.get("type") == "text")})
calls = [json.loads(l) for l in open(os.path.join(dirs["pool"], "calls.jsonl"))]
vends = [c for c in calls if c["argv"][:1] == ["--provider"]]
reqs = [json.loads(l) for l in open(requests) if l.strip()]
verdict = {
    "name": a.name, "wait_sec": a.wait_sec, "escape_after": a.escape_after,
    "held_sec": round((reqs[0]["at"] / 1000 if reqs else (escaped or time.time())) - held_at, 1),
    "requests": len(reqs), "first_request_auth": reqs[0]["authorization"] if reqs else None,
    "vend_asks": len(vends), "assistant": assistant, "session_files": files,
    "escape_to_end_sec": None,
}
if escaped is not None:
    ends = [c["at"] / 1000 for c in calls if c["argv"][:2] == ["--cli", "release"] and c["at"] / 1000 >= escaped]
    verdict["escape_to_end_sec"] = round(ends[0] - escaped, 2) if ends else None
    verdict["vend_asks_after_escape"] = len([c for c in vends if c["at"] / 1000 > escaped + 0.5])
note("final", pane=final[-2000:])
note("verdict", **verdict)
subprocess.run(["tmux", "kill-session", "-t", session], capture_output=True)
server.terminate()
print(json.dumps(verdict))
