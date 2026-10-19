#!/usr/bin/env python3
"""Move one running Prime thread, with its subagents, between the owner's Mac and us-metal02, only on the owner's explicit ask.

Owner, 10-19 (c131): "exactly don't make this convineint. make it unnatural unless explicitly asked to do that to already running thread."
On 10-19 a job moved frontend bro and slack green guy off the Mac on a broad "ALL" answer he never meant for them (c128), with scratch
movers any session could rerun. This is the one mover. It refuses unless --owner-ask names an owner message in the asking chat's session
file whose own words name this thread (by name or id) and ask to move it. It moves one thread per run and logs every run, refused or not.

Usage, on us-metal02:
  python3 -B scripts/move-thread-host.py --thread <session id> --chat <asking chat session id or file> --owner-ask <owner message id> [--stop-busy]

The owner message id is the `[message id: ...]` the chat reads after his message (his message's timestamp in base 36). The thread moves from
the host whose sessions/ holds it to the other one. A thread whose tree is mid-turn is refused unless --stop-busy, which stops its live
sessions first; pass it only when the owner asked for the move now. MOVE_THREAD_HOSTS names a JSON file with other hosts, for tests.
"""
import argparse, getpass, hashlib, json, os, re, shlex, socket, subprocess, sys, tempfile, time
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
ADOPT = REPO / "components/prime-relay/adopt-moved-subagents.py"
DAEMON_CLIENT = REPO / "node_modules/prime-agent/dist/index.js"
LOG = Path(os.environ.get("MOVE_THREAD_LOG", "~/.prime/agent/thread-moves.jsonl")).expanduser()
HOSTS = {
    "box": {"ssh": None, "agent": str(Path("~/.prime/agent").expanduser()), "socket": "/tmp/prime-agent-1001/daemon.sock",
            "prime": "prime-agent", "rsync": "rsync"},
    "mac": {"ssh": "sieunpark@100.66.173.18", "agent": "/Users/sieunpark/.prime/agent",
            "socket": "/var/folders/xr/dg7p5bwj479742q3nl2t23b80000gn/T/prime-agent-501/daemon.sock",
            "prime": "/Users/sieunpark/.local/share/prime-agent/bin/prime-agent", "rsync": "/opt/homebrew/bin/rsync"},
}
SSH = ["ssh", "-o", "BatchMode=yes", "-o", "ControlPath=none"]
MOVE_WORDS = re.compile(r"\b(?:move|moving|moved|migrat\w*|transfer\w*|relocat\w*)\b|\b(?:bring|send|put|take)\b.*\bback\b|옮|이동|이전|돌려|넘겨|되돌", re.I | re.S)
SERVER_NOTE = re.compile(r"^\[(?:check-in|job|reply check|brief check|correction check|from [^\]]*|board\] (?:Ops|Decisions|Owner chose))")
ANSWERED = re.compile(r"^\[board\] Owner checked .* and answered: ", re.S)
SESSION_ID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")


class Refused(Exception):
    pass


def run(cmd, **kw):
    r = subprocess.run(cmd, capture_output=True, text=True, **kw)
    return r.returncode, r.stdout, r.stderr


def on(host, argv, **kw):
    """Runs argv on a host: locally with the host's env, or through ssh."""
    if host["ssh"]:
        return run(SSH + [host["ssh"], shlex.join(argv)], **kw)
    return run(argv, env={**os.environ, **host.get("env", {})}, **kw)


def prime(host, *args):
    return on(host, [host["prime"], "--daemon-socket", host["socket"], *args])


def owner_words(text):
    """What the owner typed in a user message: the quote of a chat line he replied to and server notes are not his words."""
    if ANSWERED.match(text):
        text = ANSWERED.sub("", text, count=1)
    elif SERVER_NOTE.match(text):
        return ""
    return "\n".join(line for line in text.splitlines() if not line.lstrip().startswith(">")).strip()


def owner_message(chat_file, ask):
    for line in open(chat_file, encoding="utf8"):
        if '"role":"user"' not in line.replace(" ", ""):
            continue
        entry = json.loads(line)
        message = entry.get("message") or {}
        at = message.get("timestamp")
        if entry.get("type") != "message" or message.get("role") != "user" or not isinstance(at, int) or base36(at) != ask:
            continue
        content = message.get("content")
        text = content if isinstance(content, str) else "\n".join(p.get("text", "") for p in content if p.get("type") == "text")
        return text
    raise Refused(f"no owner message {ask} in {chat_file}")


def base36(n):
    digits = "0123456789abcdefghijklmnopqrstuvwxyz"
    out = ""
    while n:
        n, r = divmod(n, 36)
        out = digits[r] + out
    return out or "0"


def thread_names(host, sid):
    code, out, err = on(host, ["grep", "session_info", f"{host['agent']}/sessions/{sid}.jsonl"])
    names = []
    for line in out.splitlines():
        entry = json.loads(line)
        name = (entry.get("name") or "").strip() if entry.get("type") == "session_info" else ""
        if name and name not in names:
            names.append(name)
    return names


def check_ask(words, sid, names):
    """Refuses unless the owner's own words name this thread and ask to move it."""
    if not words:
        raise Refused("the owner message holds no words he typed (a server note, a board choice or only a quote)")
    folded = " ".join(words.lower().split())
    named = [n for n in names if " ".join(n.lower().split()) in folded] + [i for i in (sid, sid[:8]) if i in folded]
    if not named:
        raise Refused(f"the owner message does not name this thread (names {names or 'none'}, id {sid[:8]})")
    if not MOVE_WORDS.search(words):
        raise Refused("the owner message names the thread but does not ask to move it")
    return named[0]


def rows(host):
    code, out, err = prime(host, "list", "--json")
    if code:
        raise Refused(f"cannot list agents on {host['name']}: {err.strip()[-300:]}")
    data = json.loads(out)
    return data if isinstance(data, list) else data.get("sessions", [])


def tree(sid, listed):
    return [r for r in listed if r.get("sessionId") == sid or f"/session-artifacts/{sid}/" in str(r.get("sessionFile") or "")]


def busy(row):
    return bool(row.get("isStreaming") or row.get("isRunningTools") or row.get("isBashRunning") or row.get("isCompacting"))


def stop_tree(host, sid, stop_busy):
    live = tree(sid, rows(host))
    running = [r.get("sessionName") or r["sessionId"][:8] for r in live if busy(r)]
    if running and not stop_busy:
        raise Refused(f"the tree is mid-turn on {host['name']} ({', '.join(running)}); rerun with --stop-busy only if the owner asked for the move now")
    for row in live:
        code, out, err = prime(host, "stop", row.get("activeSessionId") or row["sessionId"], "--json")
        print("stopped", row.get("sessionName") or row["sessionId"][:8], "rc", code, flush=True)
    still = [r.get("sessionName") or r["sessionId"][:8] for r in tree(sid, rows(host)) if busy(r)]
    if still:
        raise Refused(f"still mid-turn after the stop: {', '.join(still)}")
    return [r["sessionId"] for r in live]


def where(host, path):
    return f"{host['ssh']}:{path}" if host["ssh"] else path


def rsync(src, dst, a, b):
    remote = src if src["ssh"] else dst if dst["ssh"] else None
    cmd = ["rsync", "-a", "-e", shlex.join(SSH)] + ([f"--rsync-path={remote['rsync']}"] if remote else [])
    return run(cmd + [where(src, a), where(dst, b)])


def sha(host, path):
    code, out, err = on(host, ["shasum", "-a", "256", path] if host["ssh"] else ["sha256sum", path])
    return out.split()[0] if out.strip() else ""


OPEN_JS = """
import { pathToFileURL } from "node:url";
const [lib, socketPath, sessionPath, startMs, message] = process.argv.slice(1);
const { DaemonClient } = await import(pathToFileURL(lib).href);
const client = new DaemonClient(socketPath);
await client.connect();
await client.waitForHello();
const created = await client.request({ type: "create", lifecycle: "resident", sessionPath }, Number(startMs), { recoverable: false });
const out = { created };
if (created.success && message) out.sent = await client.request({ type: "prompt", activeSessionId: created.data.activeSessionId, message, source: "interactive", queueIfBusy: true }, undefined, { recoverable: false });
console.log(JSON.stringify(out));
client.close();
process.exit(created.success ? 0 : 1);
"""
DAEMON_WORKER_START_MS = "1500000"  # measured: components/user-history/src/daemon-worker-start.ts DAEMON_WORKER_START_MS, a worker's cold start


def open_on(host, session_file, message):
    """Opens the moved thread on the host's daemon (through an ssh socket forward for a remote host) and sends it the move note."""
    sock, fwd = host["socket"], None
    if host["ssh"]:
        sock = os.path.join(tempfile.mkdtemp(prefix="move-thread-"), "daemon.sock")
        fwd = subprocess.Popen(SSH + ["-N", "-o", "ExitOnForwardFailure=yes", "-L", f"{sock}:{host['socket']}", host["ssh"]])
        while not os.path.exists(sock) and fwd.poll() is None:
            time.sleep(0.1)
    try:
        return run(["node", "--input-type=module", "-e", OPEN_JS, str(DAEMON_CLIENT), sock, session_file, DAEMON_WORKER_START_MS, message])
    finally:
        if fwd:
            fwd.terminate()
            fwd.wait()


def retire_old_copies(dst, sid):
    """Renames the copy an earlier move left on the box the thread now comes back to, in `moved-to-<host>/sessions/`. sieun-pi's extension
    (components/user-history/src/moved-copy.ts `movedTo`) refuses every tool call of a session whose file sits there, so on 10-19 slack green guy,
    moved back to the Mac at 12:46Z, ran without tools and let two audit messages go unanswered until a job renamed its old copy at 15:58Z."""
    script = (f"for f in {shlex.quote(dst['agent'])}/moved-to-*/sessions/{sid}.jsonl; do [ -e \"$f\" ] || continue; "
              f"mv \"$f\" \"$f.returned-to-{dst['name']}\" && echo \"$f\"; done")
    code, out, err = on(dst, ["sh", "-c", script])
    if code:
        raise Refused(f"could not rename the old copy of {sid} on {dst['name']}: {err.strip()[-300:]}")
    return [line for line in out.splitlines() if line.strip()]


def move(src, dst, sid, stop_busy, ask, words):
    if on(dst, ["test", "-e", f"{dst['agent']}/sessions/{sid}.jsonl"])[0] == 0:
        raise Refused(f"{dst['name']} already has sessions/{sid}.jsonl")
    stopped = stop_tree(src, sid, stop_busy)
    aside = f"{src['agent']}/moved-to-{dst['name']}/{time.strftime('%Y%m%dT%H%M%SZ', time.gmtime())}"
    code, out, err = on(src, ["sh", "-c", f"mkdir -p {aside}/sessions {aside}/session-artifacts && mv {src['agent']}/sessions/{sid}.jsonl {aside}/sessions/ && "
                              f"if [ -d {src['agent']}/session-artifacts/{sid} ]; then mv {src['agent']}/session-artifacts/{sid} {aside}/session-artifacts/; fi"])
    if code:
        raise Refused(f"could not move the files aside on {src['name']}: {err.strip()[-300:]}")
    on(dst, ["mkdir", "-p", f"{dst['agent']}/sessions", f"{dst['agent']}/session-artifacts"])
    a = rsync(src, dst, f"{aside}/sessions/{sid}.jsonl", f"{dst['agent']}/sessions/")
    b = (0, "", "")
    if on(src, ["test", "-d", f"{aside}/session-artifacts/{sid}"])[0] == 0:
        b = rsync(src, dst, f"{aside}/session-artifacts/{sid}/", f"{dst['agent']}/session-artifacts/{sid}/")
    here, there = sha(src, f"{aside}/sessions/{sid}.jsonl"), sha(dst, f"{dst['agent']}/sessions/{sid}.jsonl")
    if a[0] or b[0] or not here or here != there:
        raise Refused(f"copy failed (rsync {a[0]} {b[0]}, sha {here[:12]} vs {there[:12]}); the source copy sits in {aside}")
    retired = retire_old_copies(dst, sid)
    adopt = on(dst, ["env", f"PRIME_AGENT_DIR={dst['agent']}", "python3", "-B", "-", "--apply", "--root", sid[:8]], input=ADOPT.read_text())
    note = (f"This thread moved from {src['name']} to {dst['name']} because the owner asked for it (message {ask}: \"{words[:300]}\"). "
            "Carry on with your open work from where your session file ends.")
    code, out, err = open_on(dst, f"{dst['agent']}/sessions/{sid}.jsonl", note)
    if code:
        raise Refused(f"copied, but {dst['name']} did not open it: {(out + err).strip()[-300:]}")
    opened = json.loads(out.strip().splitlines()[-1])
    sent = opened.get("sent") or {}
    return {"stopped": stopped, "sha": here, "retired": retired, "adopt": adopt[0], "opened": opened["created"]["data"].get("activeSessionId"),
            "noteSent": sent.get("success", False), "noteError": sent.get("error")}


def past_moves():
    return [json.loads(line) for line in open(LOG, encoding="utf8") if line.strip()] if LOG.exists() else []


def runner():
    return {"user": getpass.getuser(), "host": socket.gethostname(), "pid": os.getpid(),
            "session": os.environ.get("PRIME_AGENT_INTERNAL_DAEMON_WORKER_ACTIVE_SESSION_ID"), "sessionDir": os.environ.get("RLM_SESSION_DIR"),
            "parent": Path(f"/proc/{os.getppid()}/cmdline").read_text().replace("\0", " ")[:200] if Path(f"/proc/{os.getppid()}/cmdline").exists() else None}


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--thread", required=True, help="the session id of the one thread to move")
    ap.add_argument("--chat", required=True, help="the session id or file of the chat the owner asked in")
    ap.add_argument("--owner-ask", required=True, help="the id of the owner message that asks for this move")
    ap.add_argument("--stop-busy", action="store_true", help="stop the tree's running turns first (only when he asked for the move now)")
    args = ap.parse_args()
    hosts = json.loads(Path(os.environ["MOVE_THREAD_HOSTS"]).read_text()) if os.environ.get("MOVE_THREAD_HOSTS") else HOSTS
    for name, host in hosts.items():
        host["name"] = name
    record = {"at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "thread": args.thread, "chat": args.chat, "ownerAsk": args.owner_ask,
              "ranBy": runner()}
    try:
        if not SESSION_ID.match(args.thread):
            raise Refused("--thread takes one full session id; one thread per run")
        local = next(h for h in hosts.values() if not h["ssh"])
        chat_file = args.chat if os.path.isfile(args.chat) else f"{local['agent']}/sessions/{args.chat}.jsonl"
        if not os.path.isfile(chat_file):
            raise Refused(f"no chat session file {chat_file}")
        if any(r.get("outcome") == "moved" and r.get("ownerAsk") == args.owner_ask and r.get("thread") == args.thread for r in past_moves()):
            raise Refused(f"owner message {args.owner_ask} already moved this thread once; a new move needs a new ask")
        words = owner_words(owner_message(chat_file, args.owner_ask))
        record["ownerWords"] = words
        found = [h for h in hosts.values() if on(h, ["test", "-e", f"{h['agent']}/sessions/{args.thread}.jsonl"])[0] == 0]
        if len(found) != 1:
            raise Refused(f"the thread's sessions/ file is on {len(found)} hosts; it must be on exactly one")
        src = found[0]
        dst = next(h for h in hosts.values() if h is not src)
        record.update({"from": src["name"], "to": dst["name"]})
        record["named"] = check_ask(words, args.thread, thread_names(src, args.thread))
        record["result"] = move(src, dst, args.thread, args.stop_busy, args.owner_ask, words)
        record["outcome"] = "moved"
    except Refused as e:
        record["outcome"] = "refused"
        record["reason"] = str(e)
    LOG.parent.mkdir(parents=True, exist_ok=True)
    with open(LOG, "a") as f:
        f.write(json.dumps(record, ensure_ascii=False) + "\n")
    print(json.dumps(record, ensure_ascii=False, indent=1))
    sys.exit(0 if record["outcome"] == "moved" else 2)


if __name__ == "__main__":
    main()
