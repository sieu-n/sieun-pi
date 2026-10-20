#!/usr/bin/env python3
"""Resume Prime Agent runs that an interruption stopped.

An interruption is a wifi drop, a sleeping or shut-down Mac, or a sign-in
token that could not refresh while offline. A run counts as interrupted when
it is live and idle, and either:

  - its last message is an assistant error that names a network or sign-in
    failure ("Connection error.", "fetch failed", "WebSocket closed",
    "Failed to resolve API key ..."), or
  - its last message is a tool result, a user message or a tool call with no
    reply after it: the turn was cut off, or
  - its last message is an empty model reply that asked for a tool, or
  - it shows "working" but did nothing for 30 minutes with no child run or
    compaction running (120 minutes when a tool call is running): a hung model
    stream, retry wait or tool call. A message cannot reach it; it has to be aborted first, which the chat
    Resume button does before it runs this script with --unstuck.

A run whose Prime worker died (workerState "failed") cannot take an abort, a stop
or a message; every command answers "Session worker is failed". It is listed as
"worker_failed", its head is not messaged, and the chat Resume button reopens the
head from its saved file first, which starts it on a new worker.

Runs that were aborted ("Request was aborted") or archived, for example a
helper its parent deleted, do not count, with two exceptions: an abort that
ended the retry of an interruption error counts as that error, and an abort
written when the daemon shut the run's worker down (a "received SIGTERM" line
in the daemon log at that moment) counts as "worker_stopped", and an abort
with no archive written while the daemon supervisor restarted (from its last log
line to the new supervisor's "listening" line) counts as "daemon_restart". An
archive that stopped the turn counts only when it is the idle unload's, by its
idle_unload reason or the unload's record. A stop record or a stop reason on the
archive (owner_stop, owner_archive, subagent_deleted, completed, replaced and
the like) keeps the run stopped and lists it under "stopped" with that record.
Any other archive is listed under "unresolved" with its cause and gets nothing:
a line with no reason, daemon_shutdown, an update discard (named by its discard
record when exactly one matches), one the update left out under stoppedBeforeRestore,
and a reason this script does not know. Rate limits (429), overloaded (529),
5xx errors and a model refusal (often a false positive that passes on retry;
the head decides) count too, but a run is listed only once pi-pool says the
account its next request gets can serve; resuming earlier fails again at once.

Each interrupted run maps to its head (the top-level root). Idle heads get one
message (default "continue") that names the interrupted runs below them.
Working heads get the same list as a steer note. Children are not messaged:
the head re-drives them.

A run stops counting once its head got a user message after the interruption,
or once this script resumed it (the state file remembers the error time).

With --direct each interrupted run gets the message itself and no head gets a
list, and a message to the head no longer hides a run below it. The chat
server runs it that way for the jobs of its chats, naming them with --only.

A subagent the daemon no longer holds answers "Unknown active session" to a
send: the daemon finds a subagent only while its tree's worker holds it, and the
idle unload and restarts drop it from there. Its message then goes to its parent
with the subagent's name, id and last step, asking it to send the message on
through its rlm handle (agent_message), which reopens the subagent in its tree.
A parent the daemon does not hold either gets that note through its own parent.
A run named with --only is read from its file under session-artifacts when the
daemon does not list it, and an archive or abort before its cut turn does not
hide it, so `--direct --only <id>` resumes a subagent stopped mid-turn.
Only a run the list did not show live is relayed: a live job whose root came
back after it can answer "Unknown active session" for a while, and its
continue waits for the next pass.


--owners names the sessions that own an open step of a chat. Each one is looked
at even when its worker is gone or it was archived (read from its session file
on disk), an empty aborted reply counts for it ("aborted"), and a spawned job
whose worker stopped before its first task reached it ("never_started") gets
that task from its rlm-subagent.json instead of "continue". On 10-15 a worker
stop at 16:07Z lost the first task of watchlist viewers and scroll for 3 h, the
workers SIGTERMed at 17:43:22Z left stuck steps root cause unloaded and out of
the default list, and the owner's stop archived three step owners at 18:25Z;
nothing resumed any of them.

A session the chat service's idle unload stopped (browser-chat/unloaded.json) after its last turn failed on the token hook, or on a rate
limit or pi-pool hold Prime still retried, counts like one a restart archived: the unload stops a session soon after its turn ends, a
failed turn included, or while it sleeps on a pool hold, and its archive hid the failure. Any other session the unload stopped, one that
finished or was cut another way, stays stopped. The idle unload stopped 16 root jobs
and 27 check-ins between 0.2 and 1.5 min after a token hook failure in the 10-16 to 10-17 hook outage (ci train at 10:27:34Z on 10-16),
and none got a continue after the hook worked again at 19:50Z on 10-17. Such a session is read from its file even when the daemon no
longer lists it.

A run stopped on a token hook failure is resumed only once the hook gives its tree a token: the pass runs the hook the way Prime does
before it sends, and keeps the token out of every output.

A job deleted on purpose never counts: one the chat service deleted or parked
(deleted-jobs.json), one under such a job, one the RLM runtime recorded as deleted
(a delete op for its folder in the rlm ledger that no later spawn of that folder
undid, or status "deleted" in its rlm-subagent.json), and one archived right before
its aborted reply outside a daemon restart. Each of these writes the same archive
and abort a restart writes. The recheck right before each send reads these records
again, and a stop reason written after the pass found the run also holds it.

Usage:
  python3 resume_paused.py                  # find and resume heads
  python3 resume_paused.py --dry-run        # show what would be sent
  python3 resume_paused.py --since-minutes 60
  python3 resume_paused.py --message "continue"
  python3 resume_paused.py --include-children   # also message the interrupted children
  python3 resume_paused.py --direct --only <session id>,<session id>
  python3 resume_paused.py --json
"""
import argparse
import concurrent.futures
import contextlib
import datetime as dt
import functools
import hashlib
import http.client
import json
import os
import re
import shutil
import signal
import socket
import subprocess
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import sys
from pathlib import Path

INTERRUPTION_ERROR = re.compile(
    r"connection error|fetch failed|econnreset|econnrefused|enotfound|etimedout|eai_again|"
    r"socket hang up|network|terminated|other side closed|timed? ?out|websocket closed|"
    r"failed to resolve api key|rate.?limit|\b429\b|overloaded|\b529\b|\b50[234]\b|internal server error|usage limit|refused to respond",
    re.IGNORECASE,
)
BUSY_FLAGS = ("isStreaming", "isRunningTools", "isBashRunning", "hasRunningRlmChildren", "isCompacting")
# A child run or compaction may legitimately take long; a model call or retry wait with no event for 30 min is hung.
# A tool call gets 120 min: the 10-06 monitor found two stuck on `convex logs` (streams forever), but also bounded
# deploy polls inside one call that wait up to 90 and 108 min on purpose.
WORK_FLAGS = ("hasRunningRlmChildren", "isCompacting")
TOOL_FLAGS = ("isRunningTools", "isBashRunning")
HUNG_MIN = 30.0
TOOL_HUNG_MIN = 120.0
# A cut-off turn younger than this may still be between a tool result and the next model call.
CUT_OFF_GRACE_MIN = 2.0
# Full session ids the caller aborted because they were hung; their "aborted" last message still counts.
UNSTUCK = set()
DEFAULT_STATE = Path.home() / ".prime" / "agent" / "resume-paused-sessions.json"
SESSIONS_DIR = Path.home() / ".prime" / "agent" / "sessions"
ARTIFACTS_DIR = Path.home() / ".prime" / "agent" / "session-artifacts"
DELETED_JOBS = Path.home() / ".prime" / "agent" / "browser-chat" / "deleted-jobs.json"
ARCHIVED_CHATS = Path.home() / ".prime" / "agent" / "browser-chat" / "archived-chats.json"
LOG_DIR = Path.home() / ".prime" / "agent" / "logs"
SHUTDOWN_LINE = re.compile(r"^\[(\S+Z)\] supervisor: Session worker \w+ stderr: received SIGTERM", re.MULTILINE)
# A stopped worker writes "Request was aborted" to its running turn. On 10-15 the four such aborts in live chat jobs
# came 0.002 s before to 0.049 s after their worker's SIGTERM line, so an abort this close to one is the shutdown's.
SHUTDOWN_MATCH_S = 1.0
RESTART_LINE = re.compile(r"^\[(\S+Z)\] supervisor: Prime Agent daemon supervisor \S+ listening", re.MULTILINE)
# A supervisor that stops archives its live sessions just before its last log line: at the 10-16 00:19:58Z restart 14 archives fell
# 1.0 s before to 0.6 s after that line, and at the 10-15 18:25Z stop 93 fell up to 4.4 s before it.
RESTART_LEAD_S = 5.0
# A new supervisor writes these for the old workers before its "listening" line: 20 "Recovered worker" and 20 "Could not adopt worker" lines
# at 19:48:47Z to 19:48:48Z on 10-17, after the old one's last line at 19:46:18Z. They belong to the new supervisor's start.
STARTUP_LINE = re.compile(r"\] supervisor: (Recovered worker|Could not adopt worker) ")
# The daemon writes this notice into each live session when `prime-agent update` restarts it, then stops its worker, which aborts the turn:
# on 10-16 the notices came at 08:44:11.97Z and the aborts at 08:44:11Z to 08:44:24Z.
UPDATE_NOTICE = "prime-agent.update_restart"
UPDATE_ABORT_S = 60.0
# Full session ids that own an open step of a chat (--owners).
OWNERS = set()
UNLOADED_FILE = Path.home() / ".prime" / "agent" / "browser-chat" / "unloaded.json"
# {full session id: when the chat service's idle unload stopped it}, read from UNLOADED_FILE in main().
UNLOADED = {}
# The unload writes its record right after the daemon's kill returns, and the kill writes the archive.
UNLOAD_MATCH_S = 60.0
# {full session id: when the Mac's idle-reaper SIGTERMed its idle worker}, written by components/idle-reaper/reaper.py and read in main().
# Such a worker reads "failed" in the daemon list, so a row named here is judged by its last turn, as if its worker still ran; on 10-19
# the reaper's kills listed 10 to 19 finished Mac jobs as worker_failed every 5 minutes.
REAPED_FILE = Path.home() / ".local" / "share" / "idle-reaper" / "reaped.json"
REAPED = {}
TOKEN_HOOK_ERROR = re.compile(r"from shell command: \S*pi-pool-token|token hook gave no token", re.IGNORECASE)
# The providers pi-pool vends tokens for; any other provider is not pooled and has no pool answer to read.
POOLED_PROVIDERS = ("anthropic", "openai-codex")
# A provider error Prime keeps retrying until an account serves the tree again: a rate limit, a used-up plan, or pi-pool's hold on the tree.
PROVIDER_WAIT_ERROR = re.compile(r"rate.?limit|\b429\b|usage limit|waits for its slot", re.IGNORECASE)
POOL_TIME_ERROR = re.compile(r"(?:limited until|waits for its slot at) (\d{4}-\d\d-\d\dT[\d:.]+Z)")
SESSION_ENV = "PRIME_AGENT_INTERNAL_DAEMON_WORKER_ACTIVE_SESSION_ID"
# The hook models.json names for both pooled providers.
TOKEN_HOOK = Path.home() / ".config" / "pi-pool" / "bin" / "pi-pool-token"
# Prime gives the token hook 10 s.
HOOK_TIMEOUT_S = 10
RECOVERY_NOTICE = "prime-agent.worker_recovery"
NEVER_STARTED_INTRO = ("[resume] Your parent spawned you, but its worker stopped before your task reached you, so the chat service sends it now. "
                       "Your task, as your parent wrote it:\n\n")


def prime_agent_bin():
    found = os.environ.get("PRIME_AGENT_BIN") or shutil.which("prime-agent")
    if found:
        return found
    fallback = Path.home() / ".local" / "share" / "prime-agent" / "bin" / "prime-agent"
    return str(fallback) if fallback.exists() else "prime-agent"


class CommandError(Exception):
    pass


class Stopped(Exception):
    """A SIGTERM came while the pass read. With Python's default handler the pass died with no output: the chat service's old 90 s
    execFile kill logged "Command failed" with no cause at 06:52Z and 06:57Z on 10-18, although the 06:57Z pass had sent 8 continues."""


DOING = [""]
# {full session id: its transcript} for each session a pass looked at, so each send rechecks the stop records right before it goes.
FILES = {}
# Boxes or runs the pass could not finish, beyond a box that failed whole: a stop record that went unreadable during the sends.
INCOMPLETE = []
UNRESOLVED = []
STOPPED = []
HELD = []
SENDING = []
STOP = []
STARTED = time.monotonic()


def on_term(signum, _frame):
    STOP.append(signum)
    if not SENDING:
        raise Stopped()


@contextlib.contextmanager
def sending():
    """A SIGTERM inside this block waits until the current send and its state record end, then the send loop stops."""
    SENDING.append(True)
    try:
        yield
    finally:
        SENDING.pop()


def stop_note(where):
    return (f"stopped by {signal.Signals(STOP[0]).name} after {time.monotonic() - STARTED:.1f} s {where}"
            + (f", last step: {DOING[0]}" if DOING[0] else ""))


def run(cmd):
    DOING[0] = " ".join([Path(cmd[0]).name, *(Path(part).name if part.endswith((".mjs", ".py")) else part for part in cmd[1:5])])
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
    except subprocess.TimeoutExpired:
        raise CommandError(f"{' '.join(cmd[:6])} gave no answer in 60 s") from None
    if p.returncode != 0:
        raise CommandError(f"{' '.join(cmd)} failed ({p.returncode}): {p.stderr.strip() or p.stdout.strip()}")
    return p.stdout


class LocalBox:
    """The box this pass runs on: its own daemon through prime-agent and its own disk."""
    remote = False
    name = None

    def __init__(self):
        self.home = Path.home()

    def list(self, all_rows=False):
        return json.loads(run([prime_agent_bin(), "list", "--json", *(["--all"] if all_rows else [])]))["sessions"]

    def send(self, target, message):
        return run([prime_agent_bin(), "send", "--json", target, message])

    def read(self, path, start=0):
        with open(path, "rb") as fh:
            fh.seek(start)
            return fh.read()

    def size(self, path):
        return os.path.getsize(path)

    def tail(self, path, nbytes):
        return self.read(path, max(0, self.size(path) - nbytes))

    def mtime(self, path):
        return os.path.getmtime(path)

    def pool_queue(self):
        tool = pool_bin()
        if not tool:
            return {}
        return json.loads(subprocess.run([tool, "queue", "--json"], capture_output=True, text=True, timeout=30, check=True).stdout)

    def logs(self):
        texts = []
        for path in sorted(LOG_DIR.glob("daemon.sock.*.log*")):
            try:
                texts.append(path.read_text(errors="ignore"))
            except OSError:
                continue
        return texts


class RelayBox:
    """Another box in ~/.config/sieun-pi/hosts.json: its daemon through `sieun-pi hosts daemon`, which waits longer for the daemon's hello than
    prime-agent's 3 s, and its files through its relay's GET /v1/file. The chat service runs this pass on the box that holds the chat role, so
    one pass covers the jobs of every box: at 04:41Z on 10-18 the Mac's token hook cuts sat outside the box's pass."""
    remote = True

    def __init__(self, host, token):
        self.name = host["name"]
        self.address = host["address"]
        self.port = int(host["relayPort"])
        self.token = token
        self.home = None
        self.rows = None
        self.log_texts = None
        self.local = threading.local()

    def _get(self, path, start=None, timeout=20, target=None):
        """One GET /v1/file (or `target`) on this thread's kept-alive connection. Until 10-18 each read opened its own TCP connection, so a pass
        paid a handshake, a request and a cold slow start at 185 ms a round trip for each of its 265 reads. A connection the relay closed while
        idle is opened again once."""
        DOING[0] = f"GET {target or path} from {self.name}"
        target = target or f"/v1/file?path={urllib.parse.quote(str(path))}"
        headers = {"Authorization": f"Bearer {self.token}", **({"Range": f"bytes={start}-"} if start is not None else {})}
        for attempt in (0, 1):
            connection = getattr(self.local, "connection", None)
            if connection is None:
                connection = self.local.connection = http.client.HTTPConnection(self.address, self.port, timeout=timeout)
            try:
                connection.request("GET", target, headers=headers)
                answer = connection.getresponse()
                body = answer.read()
                if answer.will_close:
                    connection.close()
                return answer.status, dict(answer.headers), body
            except (OSError, ValueError, http.client.HTTPException) as error:
                connection.close()
                self.local.connection = None
                if attempt:
                    raise OSError(f"relay {self.name}: {error}") from None

    def _cli(self, *args):
        return run([shutil.which("node") or "node", str(HOSTS_CLI), "daemon", self.name, *args])

    def list(self, all_rows=False):
        rows = json.loads(self._cli("list", *(["--all", "1"] if all_rows else [])))["sessions"]
        if not all_rows:
            self.rows = rows
        for row in rows:
            path = row.get("sessionFile") or ""
            if self.home is None and "/.prime/agent/" in path:
                self.home = Path(path.split("/.prime/agent/")[0])
        return rows

    def send(self, target, message):
        return self._cli("send", target, message)

    def size(self, path):
        status, headers, _ = self._get(path, start=1 << 50)
        if status == 416:
            return int(headers.get("X-File-Size") or headers.get("x-file-size") or 0)
        raise OSError(f"relay {self.name}: {path}: {status}")

    def read(self, path, start=0):
        """The bytes of `path` from `start`. FileNotFoundError only when the relay says the file does not exist (404 "no such file", from
        components/prime-relay/relay.mjs); any other failure is an OSError, so a failed read is never taken for a missing file."""
        status, _, body = self._get(path, start=start or None)
        if status in (200, 206):
            return body
        if status == 416:
            return b""
        if status == 404 and relay_error(body) == "no such file":
            raise FileNotFoundError(f"relay {self.name}: {path}: no such file")
        raise OSError(f"relay {self.name}: {path}: {status}")

    def grown(self, path, size, kept):
        seam = min(RECHECK_BYTES, size, len(kept))
        status, _, body = self._get(path, start=(size - seam) or None)
        if status in (200, 206):
            return body[seam:] if len(body) >= seam and body[:seam] == kept[len(kept) - seam:] else None
        if status == 416:
            return None
        if status == 404 and relay_error(body) == "no such file":
            raise FileNotFoundError(f"relay {self.name}: {path}: no such file")
        raise OSError(f"relay {self.name}: {path}: {status}")

    def tail(self, path, nbytes):
        """The last `nbytes` of the file, kept between passes in TAIL_CACHE with the size they end at, so a pass reads only the bytes the file
        grew by. From 07:52 to 07:57Z on 10-18 each pass read about 265 Mac tails of 256 KB whole, 34 MB a pass and five passes in five minutes,
        on the link the box's attach snapshots of Mac chats also need."""
        if nbytes > TAIL_KEEP:
            return self.read(path, max(0, self.size(path) - nbytes))
        kept_at = TAIL_CACHE / self.name / (hashlib.sha256(str(path).encode()).hexdigest() + ".tail")
        try:
            head, _, kept = kept_at.read_bytes().partition(b"\n")
            size = int(head)
        except (OSError, ValueError):
            size, kept = None, b""
        new = None if size is None else self.grown(path, size, kept)
        if new is None:
            start = max(0, self.size(path) - TAIL_KEEP)
            kept = self.read(path, start)
            size = start + len(kept)
        else:
            size, kept = size + len(new), (kept + new)[-TAIL_KEEP:]
        if new != b"":
            write_atomically(kept_at, str(size).encode(), kept)
        else:
            os.utime(kept_at)
        return kept[-nbytes:]

    def saved(self, ids):
        """The rows of `ids` from the chat service's copy of this box's full list (src/session-peer.ts, saved at most every 5 min and fully
        listed every 30), so a pass does not list the box whole: the Mac's `list --all` was 38.6 MB on every pass on 10-18. A copy older than
        COPY_FRESH_S, or none, lists the box."""
        copy = COPY_DIR / f"{self.name}.sessions.json"
        try:
            if time.time() - copy.stat().st_mtime < COPY_FRESH_S:
                rows = json.loads(copy.read_text()).get("rows") or []
                return [{**{key: row[key] for key in COPY_IDENTITY_FIELDS if key in row}, "lifecycle": "archived", "activity": "idle"}
                        for row in rows if (row.get("sessionId") or row.get("id")) in ids]
        except (OSError, ValueError, AttributeError, TypeError):
            pass
        return [row for row in self.list(all_rows=True) if (row.get("sessionId") or row["id"]) in ids]

    def pool_queue(self):
        """That box's `pi-pool queue --json`, from its relay's GET /v1/host (prime-relay host-stats.ts), the read Settings > Hosts makes."""
        status, _, body = self._get(None, target="/v1/host")
        if status != 200:
            raise OSError(f"relay {self.name}: /v1/host: {status}")
        return (json.loads(body).get("pool") or {}).get("queue") or {}

    def mtime(self, path):
        status, _, body = self._get(Path(path).parent)
        if status != 200:
            raise OSError(f"relay {self.name}: {path}: {status}")
        entry = next((e for e in json.loads(body).get("entries", []) if e.get("name") == Path(path).name), None)
        if not entry:
            raise OSError(f"relay {self.name}: {path}: not listed")
        return entry["mtimeMs"] / 1000

    def logs(self):
        """The daemon logs, when the relay's roots include ~/.prime/agent/logs; else none, so no restart or shutdown window is known there.
        Read once per pass: the Mac's 17 logs held 8.7 MB and took 12.8 s through the relay at 07:05Z on 10-18."""
        if self.log_texts is None:
            self.log_texts = self.read_logs()
        return self.log_texts

    def read_logs(self):
        if self.home is None:
            return []
        folder = self.home / ".prime" / "agent" / "logs"
        try:
            status, _, body = self._get(folder)
        except OSError:
            return []
        if status != 200:
            return []
        texts = []
        for entry in json.loads(body).get("entries", []):
            if entry.get("type") == "file" and re.match(r"daemon\.sock\..*\.log", entry.get("name", "")):
                try:
                    texts.append(self.log(folder / entry["name"], entry).decode("utf-8", "ignore"))
                except OSError:
                    continue
        return texts

    def log(self, path, entry):
        kept_at = TAIL_CACHE / self.name / (hashlib.sha256(str(path).encode()).hexdigest() + ".log")
        size, mtime = int(entry.get("size") or 0), entry.get("mtimeMs")
        try:
            head, _, kept = kept_at.read_bytes().partition(b"\n")
            had, had_mtime = json.loads(head)
        except (OSError, ValueError, TypeError):
            had, had_mtime, kept = None, None, b""
        rotated = str(path).endswith(".old")
        if had is None or len(kept) != had:
            new = None
        elif rotated:
            new = b"" if (had, had_mtime) == (size, mtime) else None
        else:
            new = self.grown(path, had, kept)
        if new == b"":
            os.utime(kept_at)
            return kept
        kept = self.read(path) if new is None else kept + new
        write_atomically(kept_at, json.dumps([len(kept), mtime]).encode(), kept)
        return kept


def write_atomically(kept_at, head, body):
    kept_at.parent.mkdir(parents=True, exist_ok=True)
    fresh = kept_at.with_name(f"{kept_at.name}.{os.getpid()}.{threading.get_ident()}")
    fresh.write_bytes(head + b"\n" + body)
    os.replace(fresh, kept_at)


def relay_error(body):
    try:
        answer = json.loads(body)
    except ValueError:
        return None
    return answer.get("error") if isinstance(answer, dict) else None


# Tail reads through one relay at a time.
RELAY_READS = 16
# Another box's session file tails, kept between passes (RelayBox.tail), and how much of each is kept: the most any reader asks for.
TAIL_CACHE = Path.home() / ".cache" / "sieun-pi" / "resume-tails"
TAIL_KEEP = 256_000
RECHECK_BYTES = 256
# A kept tail no pass read for this long is deleted.
TAIL_IDLE_S = 2 * 86400
# The chat service's copies of the other boxes' session lists (src/host-catalogs.ts copyPath), and how old one may be to stand in for a full list.
COPY_DIR = Path.home() / ".cache" / "sieun-pi" / "hosts"
COPY_FRESH_S = 40 * 60
COPY_IDENTITY_FIELDS = ("id", "sessionId", "sessionFile", "sessionName", "runtimeKind", "parentSessionId", "created", "modified", "lastActivityAt")
HOSTS_FILE = Path(os.environ.get("SIEUN_PI_HOSTS") or Path.home() / ".config" / "sieun-pi" / "hosts.json")
HOSTS_CLI = Path(__file__).resolve().parents[3] / "components" / "user-history" / "src" / "hosts-cli.mjs"
BOX = LocalBox()


def other_boxes():
    """A RelayBox for each host in hosts.json other than this machine, or none when the file is missing."""
    try:
        hosts = json.loads(HOSTS_FILE.read_text()).get("hosts") or []
    except (OSError, ValueError):
        return []
    me = socket.gethostname().split(".")[0].lower()
    boxes = []
    for host in hosts:
        if str(host.get("hostname", "")).split(".")[0].lower() == me or not str(host.get("token", "")).startswith("file:"):
            continue
        ref = Path(host["token"][len("file:"):])
        try:
            token = (ref if ref.is_absolute() else HOSTS_FILE.parent / ref).read_text().strip()
        except OSError:
            continue
        boxes.append(RelayBox(host, token))
    return boxes


def list_sessions():
    return BOX.list()


def session_files(ids):
    """{full session id: its transcript} for each id found on disk: a thread under SESSIONS_DIR, a job under ARTIFACTS_DIR/<root>/sub-*/...

    `prime-agent list --all` answered in 30.9 s against its 30 s timeout on 10-16, so every resume pass that named an owner failed from 04:20Z;
    a walk of the 6,768 job folders took 3.7 s."""
    wanted = set(ids)
    found = {sid: SESSIONS_DIR / f"{sid}.jsonl" for sid in wanted if (SESSIONS_DIR / f"{sid}.jsonl").is_file()}
    stack = [ARTIFACTS_DIR]
    while stack and len(found) < len(wanted):
        try:
            entries = list(os.scandir(stack.pop()))
        except OSError:
            continue
        for entry in entries:
            if entry.name.endswith(".jsonl") and entry.name[:-6] in wanted:
                found.setdefault(entry.name[:-6], Path(entry.path))
            elif entry.is_dir(follow_symlinks=False) and (entry.name.startswith("sub-") or Path(entry.path).parent == ARTIFACTS_DIR):
                stack.append(entry.path)
    return found


def saved_rows(ids):
    """A row like `prime-agent list --all` gives for each session in `ids` the daemon does not hold, read from its file on disk. Another box's
    rows come from its daemon's full list, since its disk is read through the relay."""
    if BOX.remote:
        return BOX.saved(ids) if ids else []
    rows = []
    for sid, path in session_files(ids).items():
        try:
            meta = json.loads((path.parent / "rlm-subagent.json").read_text())
        except (OSError, ValueError):
            meta = {}
        name = meta.get("sessionName") if isinstance(meta, dict) else None
        stamp = dt.datetime.fromtimestamp(path.stat().st_mtime, dt.timezone.utc).isoformat().replace("+00:00", "Z")
        parent = parent_of(path)
        rows.append({"id": sid, "sessionId": sid, "lifecycle": "archived", "activity": "idle", "sessionFile": str(path),
                     "sessionName": name if isinstance(name, str) else sid, "runtimeKind": "subagent" if meta else "top-level",
                     "lastActivityAt": stamp, **({"parentSessionId": parent} if parent else {})})
    return rows


def parent_of(path):
    """The full session id of the job above the job file at `path` (ARTIFACTS_DIR/<root>/sub-*/.../<id>.jsonl), or None for a thread, so a
    saved job maps to its chat's tree and the token hook check asks for that tree."""
    folder = Path(path).parent
    if not folder.name.startswith("sub-"):
        return None
    above = folder.parent
    if not above.name.startswith("sub-"):
        return above.name
    return next((p.name[:-6] for p in above.glob("*.jsonl") if len(p.name) == 42), None)


class RecordError(Exception):
    """A stop record (deleted-jobs.json, archived-chats.json) exists but cannot be read or parsed. The pass then sends nothing it would
    need that record for, and reports the box as incomplete: an unreadable record is not proof that nobody stopped a run."""


class JobRecordError(RecordError):
    """A stop record of one job (its rlm-subagent.json on another box, or the transcript above it) could not be read. That job gets nothing
    and is listed as incomplete; the other jobs go on."""


# The chat service's files that say who stopped a run on purpose. They live on the chat host of hosts.json; another box's copy stopped when
# the chat moved (us-metal02, 10-18 04:19Z), so a pass on the Mac that read its own deleted-jobs.json could resume a job the owner deleted.
CHAT_FILES = {"deleted-jobs.json": "api/agent/deleted-jobs", "archived-chats.json": "api/agent/archived-chats", "unloaded.json": "api/agent/unloaded"}
# How long the chat host may take to answer, the same wait as every chat service call (components/user-history/src/chat-host.ts serviceCall).
CHAT_HOST_WAIT_S = 30
# {file name: (text or None, source)} from the chat host, read once per pass.
CHAT_HOST_TEXT = {}
# The (file name, source) pairs the stderr line already named this pass.
CHAT_FILE_SOURCES_SAID = set()


def chat_host():
    """(base URL, origin) of the chat service when hosts.json puts the chat role on another box, else None, as the board skill finds it.
    The capability comes from chat-access.json next to hosts.json; a missing or broken one raises."""
    try:
        hosts = json.loads(HOSTS_FILE.read_text()).get("hosts") or []
    except (OSError, ValueError):
        return None
    me = socket.gethostname().split(".")[0].lower()
    holder = next((host for host in hosts if "chat" in (host.get("roles") or {})), None)
    if holder is None or str(holder.get("hostname", "")).split(".")[0].lower() == me:
        return None
    role = holder["roles"]["chat"]
    origin = (role.get("url") or f"http://{holder['address']}:{role['port']}").rstrip("/")
    access = json.loads((HOSTS_FILE.parent / "chat-access.json").read_text())
    return f"{origin}/{access['capability']}/", origin


def chat_file_text(path):
    """(text or None when the file does not exist, source) for the file at `path`. A chat service file comes from the chat host when that is
    another box; this box's copy answers on the chat host, for other files, or when the chat host cannot be reached. Raises OSError for a
    local file that cannot be read. Writes one stderr line naming where each chat service file came from."""
    name = Path(path).name
    why = ""
    if name in CHAT_FILES:
        if name in CHAT_HOST_TEXT:
            return CHAT_HOST_TEXT[name]
        try:
            host = chat_host()
        except (OSError, ValueError, KeyError) as error:
            host, why = None, f", because chat-access.json did not read ({error})"
        if host:
            base, origin = host
            try:
                with urllib.request.urlopen(base + CHAT_FILES[name], timeout=CHAT_HOST_WAIT_S) as response:
                    found = (response.read().decode(), f"the chat host {origin}")
            except urllib.error.HTTPError as error:
                said = error.read().decode(errors="replace")
                found = (None, f"the chat host {origin}") if error.code == 404 and "on the chat host" in said else None
                why = f", because the chat host answered {error.code}"
            except (OSError, http.client.HTTPException) as error:
                found, why = None, f", because the chat host could not be reached ({error})"
            if found:
                CHAT_HOST_TEXT[name] = found
                print(f"resume_paused: read {name} from {found[1]}", file=sys.stderr)
                return found
    source = f"the local file {path}{why}"
    if name in CHAT_FILES and (name, source) not in CHAT_FILE_SOURCES_SAID:
        CHAT_FILE_SOURCES_SAID.add((name, source))
        print(f"resume_paused: read {name} from {source}", file=sys.stderr)
    try:
        return Path(path).read_text(), source
    except FileNotFoundError:
        return None, source


def read_record(path, shape):
    """The parsed JSON of the stop record at `path`, or None when the file does not exist. Raises RecordError when it is unreadable, is not
    JSON or fails `shape`. The chat service replaces each of these files whole, so an empty or partial file is a fault, not an empty record.
    The record is the chat host's (chat_file_text)."""
    try:
        text, _ = chat_file_text(path)
    except OSError as error:
        raise RecordError(f"{Path(path).name} is unreadable ({error.strerror or type(error).__name__})") from None
    if text is None:
        return None
    try:
        data = json.loads(text)
    except ValueError:
        raise RecordError(f"{Path(path).name} is not valid JSON ({len(text)} bytes)") from None
    if not shape(data):
        raise RecordError(f"{Path(path).name} does not have the expected shape")
    return data


def stop_record(path):
    """Why the session at `path` was stopped on purpose, by a record that says so, or None. Raises RecordError (see read_record and ledger_deletes), or JobRecordError for a record of this job alone.

    Only recorded stops count here. A Stop pressed in a Prime older than stop-provenance writes the same abort and archive lines as a daemon
    restart and leaves no record of who pressed it; archive_verdict reads the reason a newer Prime writes on the line."""
    if not path:
        return None
    deleted = deleted_on_purpose(path)
    if deleted:
        return deleted
    return owner_archived(path)
    return None


def deleted_on_purpose(path):
    """What says the job at `path` or a job above it was deleted on purpose, or None: the chat service deleted it (deleted-jobs.json, the
    parker included), or the RLM runtime recorded its delete (recorded_deletes). A delete holds after any later message: Prime writes the
    owner's prompt, a resume pass's "continue" and a wake as the same plain user message, so none of them proves the owner reopened the job.
    Only a later ledger spawn of the same job folder revives it, and rlm-subagent.json keeps "deleted" for good. Every such delete archives the job and aborts its turn
    within milliseconds, the same lines a daemon restart writes: on 10-16 the Whole system duty counted ci train, new ci server,
    fair-self-heal, spec-junit and the two jobs under the parked checkin pushes goals as cut by a restart, and a continue would have revived
    all six."""
    folder = Path(path).parent
    deleted = read_record(DELETED_JOBS, lambda data: isinstance(data, dict) and all(isinstance(chat, dict) for chat in data.values())) or {}
    gone = {child for chat in deleted.values() for child in chat}
    while folder.name.startswith("sub-"):
        if folder.name in gone:
            return "deleted on purpose"
        folder = folder.parent
    return next(iter(recorded_deletes(path)), None)


def owner_archived(path):
    """Why the owner's archive stops the session at `path`: OWNER_ARCHIVED when he archived the session itself, CHAT_ARCHIVED when he archived
    the chat whose session-artifacts tree holds it (archived-chats.json, written by the chat service's archive), else None. That record wins
    over the archive line's timing: the owner archived the run-3 test chat python refs per folder at 06:52:53Z on 10-18, and an archive line
    inside a restart window reads as the restart's. A job of an archived chat may have started after the archive, so its words never say the
    owner stopped the job: on 10-19 chat-057a, archived at 05:31:25Z, kept spawning jobs through agent messages."""
    record = read_record(ARCHIVED_CHATS, lambda data: isinstance(data, dict) and isinstance(data.get("ids"), list)
                         and all(isinstance(sid, str) for sid in data["ids"]))
    archived = set(record["ids"]) if record else set()
    if Path(path).stem in archived:
        return OWNER_ARCHIVED
    return CHAT_ARCHIVED if artifacts_root(path) in archived else None


OWNER_ARCHIVED = "archived by the owner"
CHAT_ARCHIVED = "its chat is on the owner's archived list (archived-chats.json), so the sweep does not restart it"


def artifacts_root(path):
    """The top-level session whose session-artifacts tree holds the job file at `path` (ARTIFACTS_DIR/<root>/sub-*/.../<id>.jsonl), or None
    for a thread. That session's worker serves the job, so pi-pool files the job's requests under its tree."""
    try:
        parts = Path(path).relative_to(ARTIFACTS_DIR).parts
    except ValueError:
        parts = Path(path).parts
        parts = parts[parts.index("session-artifacts") + 1:] if "session-artifacts" in parts else ()
    return parts[0] if len(parts) > 1 else None


def rlm_ledger_path():
    """The RLM runtime's ledger for SESSIONS_DIR, <agent dir>/rlm-ledger/<first 16 hex of sha256(realpath of the sessions dir)>.jsonl, as
    rlmLedgerPath in prime-agent's modes/daemon/rlm-ledger.ts names it."""
    key = hashlib.sha256(os.path.realpath(SESSIONS_DIR).encode()).hexdigest()[:16]
    return SESSIONS_DIR.parent / "rlm-ledger" / f"{key}.jsonl"


def ledger_deletes():
    """{realpath of a child's job folder: (delete time, ledger reason)} for each child the RLM ledger leaves deleted, replayed
    the way the runtime replays it: the last spawn or delete of a child wins, so a spawn after a delete revives it, a torn final line is
    still being appended and is skipped, and an op the runtime may add later is ignored. Raises RecordError when the ledger cannot be read
    or holds a line that is not a v1 record."""
    path = rlm_ledger_path()
    try:
        state = path.stat()
    except FileNotFoundError:
        return {}
    except OSError as error:
        raise RecordError(f"the rlm ledger {path.name} is unreadable ({error.strerror or type(error).__name__})") from None
    return replay_ledger(str(path), state.st_size, state.st_mtime_ns)


@functools.lru_cache(maxsize=1)
def replay_ledger(path, _size, _mtime_ns):
    try:
        text = Path(path).read_bytes().decode("utf-8")
    except (OSError, UnicodeDecodeError) as error:
        raise RecordError(f"the rlm ledger {Path(path).name} is unreadable ({getattr(error, 'strerror', None) or type(error).__name__})") from None
    last = {}
    rows = text.split("\n")
    for index, line in enumerate(rows[:-1]):
        if not line.strip():
            continue
        try:
            record = json.loads(line)
        except ValueError:
            raise RecordError(f"rlm ledger line {index + 1} is not valid JSON") from None
        version = record.get("v") if isinstance(record, dict) else None
        if version != 1 or not isinstance(record.get("at"), str):
            raise RecordError(f"rlm ledger line {index + 1} has version {version} or no time, not a v1 record")
        if record.get("op") not in ("spawn", "delete"):
            continue
        if not isinstance(record.get("child"), str) or not isinstance(record.get("childId"), str):
            raise RecordError(f"rlm ledger line {index + 1} is a {record['op']} with no child")
        last[os.path.realpath(os.path.dirname(record["child"]))] = (record["at"], record.get("reason")) if record["op"] == "delete" else None
    return {folder: delete for folder, delete in last.items() if delete}


def registry_delete(folder):
    """What the RLM runtime's rlm-subagent.json of the job folder `folder` says when it marked the job deleted, else None. A record that
    does not exist means not deleted; a failed read or a record that is not a JSON object raises JobRecordError."""
    where = f"{folder.name}/rlm-subagent.json" + (f" on {BOX.name}" if BOX.remote else "")
    try:
        body = BOX.read(folder / "rlm-subagent.json")
    except FileNotFoundError:
        return None
    except OSError as error:
        raise JobRecordError(f"{where} could not be read ({error})") from None
    try:
        record = json.loads(body)
    except ValueError:
        raise JobRecordError(f"{where} is not valid JSON ({len(body)} bytes)") from None
    if not isinstance(record, dict):
        raise JobRecordError(f"{where} does not have the expected shape")
    if record.get("status") != "deleted":
        return None
    at = record.get("updatedAt")
    return "rlm-subagent.json status deleted" + (f", at {at}" if isinstance(at, str) else "")


def recorded_deletes(path):
    """What to report for each delete the RLM runtime recorded for the job at `path` or a job above it, nearest first: the ledger's delete
    for the job's full folder path, and the status "deleted" in its rlm-subagent.json."""
    ledger = {} if BOX.remote else ledger_deletes()
    found = []
    folder = Path(path).parent
    while folder.name.startswith("sub-"):
        above = "" if folder == Path(path).parent else f"{folder.name}, "
        who = "its parent deleted it (" if not above else "a job above it was deleted ("
        delete = ledger.get(os.path.realpath(folder))
        if delete:
            at, reason = delete
            found.append(f"{who if reason == 'user' or above else 'the RLM runtime deleted it ('}{above}rlm ledger delete, reason {reason}, at {at})")
        registry = registry_delete(folder)
        if registry:
            found.append(f"{who}{above}{registry})")
        folder = folder.parent
    return found


# (verdict, what to report) for each of Prime's archive reasons, SESSION_ARCHIVE_REASONS in prime-agent's core/session-manager.ts from
# stop-provenance 500050f. Any other value is unresolved.
ARCHIVE_REASONS = {"owner_stop": ("stopped", "the owner stopped it"), "owner_archive": ("stopped", "the owner archived it"),
                   "subagent_deleted": ("stopped", "its parent deleted it"), "subagent_cancelled": ("stopped", "its parent cancelled it"),
                   "completed": ("stopped", "it finished"), "replaced": ("stopped", "a new session replaced it"),
                   "spawn_failed": ("stopped", "its spawn failed"), "draft_discarded": ("stopped", "Prime discarded it as an empty draft"),
                   "idle_unload": ("unload", "the idle unload stopped it"), "update_discarded": ("discarded", "an update discarded it"),
                   "daemon_shutdown": ("unresolved", "Its archive came from prime-agent shutdown, and no record says it should continue")}
# The update coordinator's status records, one per update: <agent dir>/update-restarts/<socket key>-<request id>.json.
UPDATE_RESTARTS_DIR = Path.home() / ".prime" / "agent" / "update-restarts"


def update_records():
    """The update coordinator's status records on this box, or none on another box, whose records this pass does not read. Raises
    JobRecordError for one that does not read or parse."""
    return [] if BOX.remote else read_update_records(UPDATE_RESTARTS_DIR)


@functools.cache
def read_update_records(folder):
    records = []
    for path in sorted(folder.glob("*.json")):
        try:
            record = json.loads(path.read_text())
        except FileNotFoundError:
            continue
        except (OSError, ValueError) as error:
            raise JobRecordError(f"the update record {path.name} did not read ({error})") from None
        if not isinstance(record, dict) or not all(isinstance(record.get(key, []), list) for key in ("discarded", "stoppedBeforeRestore")):
            raise JobRecordError(f"the update record {path.name} does not have the expected shape")
        records.append(record)
    return records


def update_entries(key, session_id, path, matches):
    """[(record, entry)] for each entry of list `key` in the update records that names the session `session_id` at `path` and passes
    `matches`."""
    return [(record, entry) for record in update_records() for entry in record.get(key) or []
            if isinstance(entry, dict) and entry.get("sessionId") == session_id and matches(entry)
            and os.path.realpath(entry.get("sessionFile") or path) == os.path.realpath(path)]


def update_discard(archive, session_id, path, entries):
    """archive_verdict for an archive whose reason is update_discarded. The discard entry and the archive line share no key, so an entry
    matches only when its time falls after the transcript's last line before the archive and at or before the archive, and only a single
    such entry names the cause."""
    at, stamp = archive.get("timestamp"), parse_ts(archive.get("timestamp"))
    index = next((i for i, entry in enumerate(entries) if entry is archive), len(entries))
    before = next((parse_ts(entry.get("timestamp")) for entry in reversed(entries[:index]) if parse_ts(entry.get("timestamp"))), None)

    def this_close(entry):
        closed = parse_ts(entry.get("at"))
        return entry.get("reason") == "update_discarded" and bool(closed and stamp and before) and before < closed <= stamp

    found = update_entries("discarded", session_id, path, this_close)
    if len(found) != 1:
        where = f", and the update records on {BOX.name} are not read from here" if BOX.remote else ""
        said = f"{len(found)} discard records could match it" if found else "no discard record matches it"
        return ("unresolved", f"Its archive at {at} says an update discarded it, but {said}{where}, so it is not resumed.")
    record, entry = found[0]
    if entry.get("cause") in ("empty_draft", "no_session_file"):
        return ("stopped", f"the update {record.get('requestId')} discarded it as {entry['cause']} (archive reason update_discarded, at {at})")
    return ("unresolved", f"The update {record.get('requestId')} closed it at {at} without a restart entry ({entry.get('cause')}), and no record "
                          "says it should continue, so it is not resumed.")


def archive_verdict(archive, session_id, path, unloaded_at, entries):
    """("stopped" | "unload" | "unresolved", text) for the archive line `archive` that stopped a run's turn, by the reason Prime wrote on it.
    A line with no reason is the update's stoppedBeforeRestore when that record copies its timestamp, the idle unload's when the unload's
    record follows it, and otherwise has no recorded cause. A reason this pass does not know is never read as a known one."""
    at = archive.get("timestamp")
    reason = (archive.get("state") or {}).get("reason")
    if reason is None:
        held = update_entries("stoppedBeforeRestore", session_id, path, lambda entry: entry.get("at") == at)
        if len(held) > 1:
            return ("unresolved", f"{len(held)} update records list its archive at {at} under stoppedBeforeRestore, so it is not resumed.")
        if held:
            record, entry = held[0]
            kind, said = ARCHIVE_REASONS.get(entry.get("reason"), (None, None))
            if kind == "stopped":
                return ("stopped", f"{said} after the update {record.get('requestId')} began (stoppedBeforeRestore, at {at})")
            return ("unresolved", f"The update {record.get('requestId')} did not restore it, since it was stopped at {at} after the update began "
                                  f"(stoppedBeforeRestore, cause {entry.get('reason')}), so it is not resumed.")
        if unload_archive(archive, unloaded_at):
            return ("unload", f"the idle unload stopped it (unloaded.json, archive at {at})")
        return ("unresolved", "An archive with no recorded cause stopped its turn, so it is not resumed.")
    kind, said = ARCHIVE_REASONS.get(reason, (None, None))
    if kind == "discarded":
        return update_discard(archive, session_id, path, entries)
    if kind == "unresolved":
        return ("unresolved", f"{said} (archive reason {reason}, at {at}), so it is not resumed.")
    if kind:
        return (kind, f"{said} (archive reason {reason}, at {at})")
    return ("unresolved", f"Its archive at {at} names a cause this pass does not know ({reason!r}), so it is not resumed.")


def stopped_since(entries, found_at):
    """What stopped the run after the pass found it at `found_at`: an archive line written later whose reason means the stop, or None."""
    for entry in reversed(entries):
        reason = (entry.get("state") or {}).get("reason")
        kind, said = ARCHIVE_REASONS.get(reason, (None, None))
        stamp = parse_ts(entry.get("timestamp"))
        if is_archive(entry) and kind == "stopped" and found_at and stamp and stamp > found_at:
            return f"{said} (archive reason {reason}, at {entry.get('timestamp')})"
    return None


def with_saved_owners(sessions, saved_rows, owners):
    """The resident sessions plus each owner the daemon only lists as saved (no worker, or archived), marked `saved`."""
    seen = {s.get("sessionId") or s["id"] for s in sessions}
    extra = [{**row, "saved": True} for row in saved_rows
             if (row.get("sessionId") or row["id"]) in owners and (row.get("sessionId") or row["id"]) not in seen]
    # The default list also shows a recently archived session; an owner there counts as saved too, else the next sweep skips it.
    listed = [{**s, "saved": True} if (s.get("sessionId") or s["id"]) in owners and s.get("lifecycle") != "live" else s for s in sessions]
    return [*listed, *extra]


def prune_tails(name):
    """Deletes the kept tails of box `name` that no pass read for TAIL_IDLE_S, so the files of finished sessions do not pile up."""
    cutoff = time.time() - TAIL_IDLE_S
    try:
        entries = list(os.scandir(TAIL_CACHE / name))
    except OSError:
        return
    for entry in entries:
        try:
            if entry.stat().st_mtime < cutoff:
                os.unlink(entry.path)
        except OSError:
            continue


def tail_entries(path, nbytes=256_000):
    """Parsed entries from the tail of a session jsonl, or none when it does not read."""
    try:
        return parse_lines(BOX.tail(path, nbytes))
    except OSError:
        return []


def parse_lines(chunk):
    """The JSON entries of the bytes `chunk` of a session jsonl, skipping a line cut at either end."""
    entries = []
    for line in chunk.decode("utf-8", "ignore").split("\n"):
        if not line.strip():
            continue
        try:
            entries.append(json.loads(line))
        except ValueError:
            continue
    return entries


def last_message(entries):
    for entry in reversed(entries):
        if entry.get("type") == "message":
            return entry
    return None


def run_provider(entries):
    """The provider of the last model call, so the account check asks about the right pool."""
    for entry in reversed(entries):
        msg = entry.get("message") or {}
        if entry.get("type") == "message" and msg.get("role") == "assistant" and msg.get("provider"):
            return msg["provider"]
        if entry.get("type") == "model_change" and entry.get("provider"):
            return entry["provider"]
    return None


def load_reaped(path):
    """{full session id: datetime} from this box's idle-reaper record, or {} when there is none."""
    try:
        data = json.loads(Path(path).read_text())
    except (OSError, ValueError):
        return {}
    stamps = {sid: parse_ts(value) for sid, value in data.items() if isinstance(value, str)} if isinstance(data, dict) else {}
    return {sid: stamp for sid, stamp in stamps.items() if stamp}


def load_unloaded(path):
    """{full session id: datetime} from the idle unload's record, or {} when there is none."""
    try:
        text, _ = chat_file_text(path)
        data = json.loads(text or "")
    except (OSError, ValueError):
        return {}
    stamps = {sid: parse_ts(value) for sid, value in data.items() if isinstance(value, str)} if isinstance(data, dict) else {}
    return {sid: stamp for sid, stamp in stamps.items() if stamp}


def is_archive(entry):
    return entry.get("type") == "session_state" and (entry.get("state") or {}).get("status") == "archived"


def unload_archive(archive, unloaded_at):
    """The archive `archive` came from the idle unload: its reason says idle_unload, or it has no reason and the unload's record at
    `unloaded_at` follows it. A line with any other reason was written by another stop, whatever the unload's record says."""
    reason = (archive.get("state") or {}).get("reason")
    if reason is not None:
        return reason == "idle_unload"
    stamp = parse_ts(archive.get("timestamp"))
    return bool(unloaded_at and stamp) and 0 <= (unloaded_at - stamp).total_seconds() <= UNLOAD_MATCH_S


def archived_by_unload(entries, unloaded_at):
    """The session's last archive came from the idle unload's stop at `unloaded_at`."""
    archives = [e for e in entries if is_archive(e)]
    return bool(archives) and unload_archive(archives[-1], unloaded_at)


def unload_stop_holds(session, verdict):
    """The idle unload's stop keeps a run that is not live stopped unless its turn failed on the token hook, or on a rate limit or pi-pool
    hold that Prime was still retrying when the unload stopped it: the unload stops a run asleep in its provider retry once pi-pool holds its
    tree past the unload's minutes (components/user-history/src/idle-unload.ts providerWaits). The kill writes only the archive after the
    failed reply, so such a run gets its continue once the hook or `pi-pool who` lets its tree in (account_blocker). At 01:11Z on 10-19 176
    runs slept that way, 91 on a 429 and 85 on the hook's "waits for its slot", each with "waits for its slot at" in its error."""
    if session.get("lifecycle") == "live" or verdict[0] != "error":
        return session.get("lifecycle") != "live"
    return not (TOKEN_HOOK_ERROR.search(verdict[1]) or PROVIDER_WAIT_ERROR.search(verdict[1]))


def stop_archive(entries, last):
    """The archive that stopped the turn ending in `last`: the latest one after it, else one right before it with no message between. An
    older archive stopped an earlier turn: air reboot proof 2 was unloaded at 06:22Z on 10-18, woken at 06:40Z and cut by the mem.3 update
    at 06:46Z, and its 06:22Z archive hid that cut."""
    index = entries.index(last) if last in entries else len(entries)
    later = [e for e in entries[index + 1:] if is_archive(e)]
    if later:
        return later[-1]
    ts = parse_ts(last.get("timestamp"))
    for entry in reversed(entries[:index]):
        if entry.get("type") == "message":
            return None
        if entry.get("type") == "session_state":
            stamp = parse_ts(entry.get("timestamp"))
            return entry if is_archive(entry) and ts and stamp and (ts - stamp).total_seconds() <= ARCHIVE_ABORT_S else None
    return None


# Token hook runs at once in a send pass. One at a time each took 1.4 to 2.7 s on us-metal02 on 10-19, so the 239 runs cut on a token hook
# error took 333 s of a 365 s pass, and chat restarts at 16:44Z, 16:49Z, 16:56Z, 17:05Z and 17:12Z killed every send pass before its sends.
# 16 at once ran 32 hooks in 6.7 s.
HOOK_RUNS = 16


def prefetch_hooks(pairs, cache):
    """Fills `cache` with hook_blocker's answer for each (root session id, provider) in `pairs`, 16 hooks at a time."""
    todo = list(dict.fromkeys(pair for pair in pairs if pair not in cache))
    if not todo:
        return
    with concurrent.futures.ThreadPoolExecutor(HOOK_RUNS) as pool:
        answers = list(pool.map(lambda pair: hook_blocker(pair[0], pair[1], {}), todo))
    cache.update(zip(todo, answers))


def hook_blocker(root_session_id, provider, cache):
    """Why the token hook gives this tree no token now, or None when it gives one or there is no hook to run.

    The hook runs as Prime runs it for the tree's next request, with the tree's session id and a 10 s limit, and its stdout, the token,
    is dropped unread."""
    if not TOKEN_HOOK.exists() or provider not in ("anthropic", "openai-codex"):
        return None
    hook = TOKEN_HOOK
    if (root_session_id, provider) not in cache:
        try:
            ran = subprocess.run([str(hook), "--provider", provider], env={**os.environ, SESSION_ENV: root_session_id},
                                 stdin=subprocess.DEVNULL, capture_output=True, timeout=HOOK_TIMEOUT_S)
            gave = ran.returncode == 0 and bool(ran.stdout.strip())
            cache[(root_session_id, provider)] = None if gave else f"the token hook gave no {provider} token (exit {ran.returncode})"
        except subprocess.TimeoutExpired:
            cache[(root_session_id, provider)] = f"the token hook gave no {provider} token in {HOOK_TIMEOUT_S} s"
        except OSError:
            cache[(root_session_id, provider)] = None
    return cache[(root_session_id, provider)]


def pool_bin():
    found = shutil.which("pi-pool") or str(Path.home() / ".config" / "pi-pool" / "bin" / "pi-pool")
    return found if Path(found).exists() else None


def account_blocker(root_session_id, provider, cache, strict=False):
    """Why the account this tree's next request gets cannot serve and when pi-pool says that ends (pool_free_at, epoch seconds or None), or
    (None, None) when it can serve (or there is no pool to ask).

    A run that stopped on a rate limit or a used-up account fails again at once if it resumes on the same account,
    so it stays off the list until pi-pool has an account for it. With `strict` (the abort of a run asleep in its provider retry) a pooled
    provider whose answer could not be read, or a resolved account `pi-pool ls` does not list, gives "unknown: ..." instead of None, since an
    unknown answer is no proof the account can serve. A provider pi-pool does not pool gives None either way.
    """
    unknown = (lambda why: (f"unknown: {why}", None)) if strict else (lambda why: (None, None))
    if provider is None:
        return unknown("the run's file names no provider")
    if provider not in POOLED_PROVIDERS:
        return None, None
    tool = pool_bin()
    if not tool:
        return unknown("no pi-pool binary")
    try:
        if provider not in cache:
            listed = subprocess.run([tool, "ls", "--json", "--provider", provider], capture_output=True, text=True, timeout=30)
            cache[provider] = {row["id"]: row for row in json.loads(listed.stdout).get("rows", [])} if listed.returncode == 0 else None
        rows = cache[provider]
        who = subprocess.run([tool, "who", "--json", "--session", root_session_id], capture_output=True, text=True, timeout=30)
        resolved = (json.loads(who.stdout).get("providers") or {}).get(provider) if who.returncode == 0 else None
    except (OSError, ValueError, KeyError, subprocess.SubprocessError) as error:
        return unknown(f"pi-pool did not answer ({type(error).__name__})")
    if rows is None:
        return unknown(f"pi-pool ls --provider {provider} failed")
    if resolved is None:
        return unknown(f"pi-pool who gave no {provider} answer for the tree")
    free_at = pool_free_at(resolved, rows, time.time())
    # A tree that pi-pool holds in a wait, its slot or R5's 0 to 120 min backoff draw (30f44c22b), gets no turn before slot_at: a continue
    # would only meet the same hold, and an abort of a run in its retry would end it early.
    wait = resolved.get("wait") or {}
    if isinstance(wait.get("slot_at"), (int, float)) and wait["slot_at"] > time.time():
        return f"pi-pool holds the tree until {dt.datetime.fromtimestamp(wait['slot_at'], dt.timezone.utc).isoformat(timespec='seconds')}", free_at
    account = resolved.get("account")
    if not account:
        return f"no {provider} account can serve", free_at
    row = rows.get(account)
    if row is None:
        return unknown(f"pi-pool ls does not list {account}")
    if not row.get("usable"):
        return f"{row.get('email')} is {row.get('reason') or 'not usable'}", free_at
    return None, None


def pool_free_at(resolved, rows, now):
    """When pi-pool next gives the tree an account, in epoch seconds, by the chat's rule (chat-pool.ts poolFreeAt): the slot of the wait `who`
    holds the tree in, the end of the limit or cooldown of the account `who` names, or with no account named the earliest time any account
    frees up (its limit or cooldown end, else the reset of a spent window). None when the pool does not say."""
    slot = (resolved.get("wait") or {}).get("slot_at")
    if isinstance(slot, (int, float)) and slot > now:
        return slot

    def ends(row, fields):
        return [at for at in (row.get(field) for field in fields) if isinstance(at, (int, float)) and at > now]

    account = resolved.get("account")
    if account:
        held = ends(rows.get(account) or {}, ("limited_until", "cooldown_until"))
        return max(held) if held else None
    if (resolved.get("selection") or {}).get("mode") == "manual":
        return None
    frees = []
    for row in rows.values():
        if row.get("disabled"):
            continue
        blocked = ends(row, ("limited_until", "cooldown_until"))
        spent = [window["resets_at"] for window in row.get("windows") or [] if (window.get("pct") or 0) >= 100 and ends(window, ("resets_at",))]
        if blocked or spent:
            frees.append(max(blocked or spent))
    return min(frees, default=None)


def error_free_at(error, now):
    """The latest pool time the run's error names that is still ahead (the extension's "limited until" and "waits for its slot at"), for a
    hold account_blocker found no end for, in epoch seconds; None when there is none."""
    ahead = [stamp.timestamp() for stamp in map(parse_ts, POOL_TIME_ERROR.findall(error)) if stamp and stamp.timestamp() > now]
    return max(ahead) if ahead else None


def last_user_at(entries):
    for entry in reversed(entries):
        if entry.get("type") == "message" and (entry.get("message") or {}).get("role") == "user":
            return parse_ts(entry.get("timestamp"))
    return None


def parse_ts(value):
    if not value:
        return None
    try:
        return dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def short_id(session):
    return session["id"][-12:]


def head_of(sid, by_id):
    seen = set()
    cur = sid
    while True:
        s = by_id.get(cur)
        if not s:
            return cur
        # The daemon gives a resident parent's short id, and a parent's full session id once it was reloaded.
        parent = s.get("parentActiveSessionId") or s.get("parentSessionId")
        parent = parent[-12:] if parent else parent
        if not parent or parent in seen or parent not in by_id:
            return cur
        seen.add(cur)
        cur = parent


def pool_tree(session, head_row):
    """The session pi-pool keys this run's tree by: the top-level session above its job file, else the head `head_of` found. head_of follows
    parentActiveSessionId, which goes stale once the chat's worker stops. At 03:13Z on 10-19 chat-057a was archived, so its jobs were their own
    heads, `pi-pool who --session <job>` answered "matches no known session", and the pass sent six of them continue into the tree's backoff."""
    return artifacts_root(session.get("sessionFile") or "") or head_row.get("sessionId") or head_row["id"]


def is_busy(session):
    return session.get("activity") == "working" or any(session.get(flag) for flag in BUSY_FLAGS)


def stopped_on_purpose(entries, last, restarts=list, unloaded_at=None):
    """The run's tool call reads "Request was aborted" with no archive and no update notice in that turn, the line an Esc abort writes. Its
    cause is not recorded either, so the run is left stopped without a claim of who stopped it. An archive that stopped the turn is not decided here: `find_paused` resumes it only when the idle unload's
    record names it, skips it when a stop record names it, and otherwise lists it as `unresolved`. Prime's archive line has no cause, and a
    restart window's timing does not prove one."""
    if stop_archive(entries, last) or update_before(entries, last):
        return False
    msg = last.get("message") or {}
    return msg.get("role") == "toolResult" and any(
        isinstance(part, dict) and part.get("text") == "Request was aborted" for part in msg.get("content") or [])


def pool_error(entries):
    """The error text when a run's last entry is an assistant reply that failed on an interruption error or on the token hook (pi-pool's own
    hold), the two failures Prime sleeps on before it tries the turn again; else None."""
    last = entries[-1] if entries else {}
    msg = last.get("message") or {}
    error = str(msg.get("errorMessage") or "")
    if last.get("type") == "message" and msg.get("role") == "assistant" and msg.get("stopReason") == "error" \
            and (INTERRUPTION_ERROR.search(error) or TOKEN_HOOK_ERROR.search(error)):
        return error
    return None


def queue_places(reading):
    """{session id: "place P of T"} for each session `pi-pool queue --json` lists as queued for a working slot."""
    return {entry["session"]: f"queued in pi-pool for a working slot, place {entry.get('position')} of {entry.get('total')}"
            for entry in (reading or {}).get("queued") or [] if isinstance(entry, dict) and entry.get("session")}


def retry_wait(entries):
    """{"retry_error": text} when a hung run's last entry is an assistant reply that failed on an interruption error: Prime is asleep in its
    provider retry, and the abort waits for account_blocker to say pi-pool would let the tree in now, so it loses no queue place. After the account outage of 10-18 ssh tailnet only,
    admin access land and p3-jobs sat in that state 113 to 144 min after a 429 at 08:20 to 08:51Z, with the accounts back."""
    last = entries[-1] if entries else {}
    msg = last.get("message") or {}
    error = str(msg.get("errorMessage") or "")
    # A token hook answer is pi-pool's own hold or a hook failure, never a stuck provider retry: a hook failure has its own path once the
    # hook gives the tree a token. A provider error the extension gave a pool hold (its "waits for its slot at", up to the 120 min backoff
    # draw) is marked too: Prime sleeps that whole draw, while the pool lets the tree in as soon as an account takes its class again
    # (032c394b). account_blocker asks `pi-pool who`, which decides live, so a hold the pool still keeps blocks the abort. On 10-18 guard-fix
    # (01a15032) slept on a 429 from 19:48:50Z to 21:13:34Z while its tree moved to claude7 at 20:38Z and claude7 served from 20:00Z.
    if last.get("type") == "message" and msg.get("role") == "assistant" and msg.get("stopReason") == "error" \
            and INTERRUPTION_ERROR.search(error) and not TOKEN_HOOK_ERROR.search(error):
        return {"retry_error": error}
    return {}


def hung_since(session, now, entries=None):
    # `entries`: a call that gives the session's tail entries, when the caller holds them.
    """Minutes a session has shown as working with no activity and nothing legitimately long running, else None.

    After a sleep or a network drop a model stream or a retry wait can hang for hours while the session still reads
    "working". Sending it a message does nothing: it has to be aborted first (the chat's Resume button does that).
    """
    if not is_busy(session) or any(session.get(flag) for flag in WORK_FLAGS):
        return None
    # lastActivityAt can lag: a retry loop keeps writing error messages to the session file without moving it. It never runs ahead of the
    # file, so a recent one settles it without a read.
    limit = TOOL_HUNG_MIN if any(session.get(flag) for flag in TOOL_FLAGS) else HUNG_MIN
    listed = parse_ts(session.get("lastActivityAt") or session.get("modified"))
    if listed and (now - listed).total_seconds() / 60 < limit:
        return None
    stamps = [listed]
    path = session.get("sessionFile")
    entries = entries() if entries else tail_entries(path, 64_000) if path else []
    stamps += [parse_ts(entry.get("timestamp")) for entry in entries[-5:]]
    if not BOX.remote:
        try:
            stamps.append(dt.datetime.fromtimestamp(BOX.mtime(path), dt.timezone.utc) if path else None)
        except OSError:
            pass
    stamps = [stamp for stamp in stamps if stamp]
    if not stamps:
        return None
    last = last_message(entries)
    msg = (last or {}).get("message") or {}
    if msg.get("role") == "assistant" and msg.get("stopReason") == "stop":
        return None  # the turn finished; the daemon's "working" is stale, and there is nothing to resume
    idle = (now - max(stamps)).total_seconds() / 60
    return idle if idle >= limit else None


def worker_shutdowns():
    """Each time the daemon sent a session worker SIGTERM, from its logs and their rotated .old files, oldest first."""
    stamps = []
    for text in BOX.logs():
        stamps += [stamp for stamp in map(parse_ts, SHUTDOWN_LINE.findall(text)) if stamp]
    return sorted(stamps)


def daemon_restarts():
    """(start, end) of each time the Prime daemon supervisor stopped and a new one started, from its logs, oldest first.

    The window runs from RESTART_LEAD_S before the old supervisor's last log line to the new one's "listening" line.
    A daemon restart archives every live session and aborts its turn, which no one asked for.
    """
    windows = []
    for text in BOX.logs():
        previous = None
        for line in text.splitlines():
            if not line.startswith("["):
                continue
            stamp = parse_ts(line[1:line.find("]")])
            match = RESTART_LINE.match(line)
            if match and stamp and previous and previous <= stamp:
                windows.append((previous - dt.timedelta(seconds=RESTART_LEAD_S), stamp))
            if not STARTUP_LINE.search(line):
                previous = stamp or previous
    return sorted(set(windows))


# An archive writes its aborted reply within milliseconds; RESTART_ABORT_MS in components/user-history/src/cut-end.ts uses the same 5 s.
ARCHIVE_ABORT_S = 5.0


def update_before(entries, last):
    """The daemon's update notice came at most UPDATE_ABORT_S before `last` in the same turn, with no new input between them: the update
    stopped the turn. The turn may run more steps first: probe queue trust ran three tool steps after the mem.3 notice at 06:46:02Z on 10-18
    and its tool call was aborted 37 s after it."""
    ts = parse_ts(last.get("timestamp"))
    index = entries.index(last) if last in entries else -1
    for entry in reversed(entries[:max(index, 0)]):
        if entry.get("type") == "custom_message" and entry.get("customType") == UPDATE_NOTICE:
            stamp = parse_ts(entry.get("timestamp"))
            return bool(ts and stamp) and 0 <= (ts - stamp).total_seconds() <= UPDATE_ABORT_S
        if entry.get("type") == "custom_message" or (entry.get("type") == "message" and (entry.get("message") or {}).get("role") == "user"):
            return False
    return False


def aborted_reply(entry):
    """The reply a stopped worker writes to the turn it cut: an aborted assistant message or a "Request was aborted" tool result."""
    msg = entry.get("message") or {}
    return (msg.get("role") == "assistant" and msg.get("stopReason") == "aborted") or (msg.get("role") == "toolResult" and any(
        isinstance(part, dict) and part.get("text") == "Request was aborted" for part in msg.get("content") or []))


def in_restart(stamp, restarts):
    return bool(stamp) and any(start <= stamp <= end for start, end in restarts())


def archived_by_restart(entries, restarts):
    """The session's last archive came from a daemon restart, not from a person or a parent. A Prime update marks the sessions it stops with
    a prime-agent.update_restart notice and logs its restart window up to 40 s later (run-6's job: notice at 06:46:02Z, window 06:46:44 to
    06:47:22Z on 10-18), so a notice with no archive and at most the cut turn's aborted reply after it counts too. census writer speed
    (01a14d5d-b858) had the idle unload's 05:33Z archive in its file, worked again, and Prime's update cut its tool call at 06:46:02Z with the
    abort 11 s later, so the old unload archive hid it and it got no continue for 29 min."""
    notice = next((i for i in range(len(entries) - 1, -1, -1)
                   if entries[i].get("type") == "custom_message" and entries[i].get("customType") == UPDATE_NOTICE), None)
    if notice is not None:
        after = entries[notice + 1:]
        replies = [e for e in after if e.get("type") == "message"]
        if not any(e.get("type") == "session_state" and (e.get("state") or {}).get("status") == "archived" for e in after) \
                and (not replies or (len(replies) == 1 and aborted_reply(replies[0]))):
            return True
    archives = [e for e in entries if e.get("type") == "session_state" and (e.get("state") or {}).get("status") == "archived"]
    return bool(archives) and in_restart(parse_ts(archives[-1].get("timestamp")), restarts)


def aborted_verdict(last, entries, shutdowns, owner=False, restarts=list):
    """("error", text) for an abort that ended the retry of an interruption error, ("worker_stopped", text) for one the
    daemon wrote when it shut the run's worker down, ("aborted", text) for an empty one of a step owner, else None: the
    user or a parent stopped the run."""
    before = last_message(entries[:entries.index(last)]) if last in entries else None
    msg = (before or {}).get("message") or {}
    err = str(msg.get("errorMessage") or "")
    if msg.get("role") == "assistant" and msg.get("stopReason") == "error" and INTERRUPTION_ERROR.search(err):
        return ("error", err)
    ts = parse_ts(last.get("timestamp"))
    if ts and any(abs((ts - stamp).total_seconds()) <= SHUTDOWN_MATCH_S for stamp in shutdowns()):
        return ("worker_stopped", f"The daemon shut its worker down at {last.get('timestamp')} in the middle of the turn.")
    if in_restart(ts, restarts) or update_before(entries, last):
        return ("daemon_restart", f"The Prime daemon restarted at {last.get('timestamp')} in the middle of the turn.")
    if owner and not reply_text(last):
        return ("aborted", "Its turn was aborted with no reply while it owned an open step.")
    return None


def reply_text(entry):
    content = (entry.get("message") or {}).get("content")
    if isinstance(content, str):
        return content.strip()
    return "".join(part.get("text") or "" for part in content or [] if isinstance(part, dict) and part.get("type") == "text").strip()


def never_started(session, entries, nbytes=256_000):
    """(notice, task) for a spawned job whose worker stopped before its first task reached it: its whole file holds no
    message, a worker recovery notice, and rlm-subagent.json next to it keeps the task its parent gave rlm.spawn."""
    path = session.get("sessionFile")
    notice = next((e for e in reversed(entries) if e.get("type") == "custom_message" and e.get("customType") == RECOVERY_NOTICE), None)
    if not path or not notice or last_message(entries):
        return None
    try:
        if BOX.size(path) > nbytes:
            return None
        record = json.loads(BOX.read(Path(path).parent / "rlm-subagent.json"))
    except (OSError, ValueError):
        return None
    task = record.get("prompt") if isinstance(record, dict) else None
    return (notice, task) if isinstance(task, str) and task.strip() else None


def recovered_after(entries, ts):
    """The daemon wrote its worker recovery notice after the message at `ts`: the worker that ran the turn died and its in-flight work was
    not replayed, so the turn is cut now and needs no grace. On 10-18 the pass that reopened chat 01a14ec0 ran 65 s after its job's cut, and
    the 2 min grace would have left the job's continue to the next pass, 10 min later."""
    return any(e.get("type") == "custom_message" and e.get("customType") == RECOVERY_NOTICE and (parse_ts(e.get("timestamp")) or ts) > ts
               for e in entries)


def classify(last, now, entries=(), shutdowns=list, owner=False, restarts=list):
    """("error" | "cut_off" | "empty_reply" | "worker_stopped" | "aborted", text) when the last message shows the run stopped mid-work, else None."""
    if not last:
        return None
    msg = last.get("message") or {}
    role, stop = msg.get("role"), msg.get("stopReason")
    if role == "assistant" and stop == "aborted":
        return aborted_verdict(last, list(entries), shutdowns, owner, restarts)
    if role == "assistant" and stop == "toolUse" and not msg.get("content"):
        ts = parse_ts(last.get("timestamp"))
        if ts is None or (now - ts).total_seconds() / 60 < CUT_OFF_GRACE_MIN:
            return None
        return ("empty_reply", "The model returned an empty reply that asked for a tool, so the turn ended.")
    if role == "assistant" and stop == "error":
        err = str(msg.get("errorMessage") or "")
        return ("error", err) if INTERRUPTION_ERROR.search(err) else None
    cut_off = role in ("user", "toolResult") or (role == "assistant" and stop == "toolUse")
    if not cut_off:
        return None
    ts = parse_ts(last.get("timestamp"))
    if ts is None or ((now - ts).total_seconds() / 60 < CUT_OFF_GRACE_MIN and not recovered_after(entries, ts)):
        return None
    return ("cut_off", "The turn stopped with no reply after a " + ("tool call" if role != "user" else "message") + ".")


def load_state(path):
    try:
        data = json.loads(Path(path).read_text())
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def save_state(path, state, now, keep_minutes):
    cutoff = now - dt.timedelta(minutes=max(keep_minutes, 1440))
    kept = {k: v for k, v in state.items() if (parse_ts(v) or now) >= cutoff}
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(kept, indent=1))
    tmp.replace(path)


def hook_pairs(sessions, only, by_id, entries_of):
    """(tree, provider) for each run named with --only whose last message failed on the token hook: the hooks the send pass asks about,
    so prefetch_hooks runs them together before the loop."""
    pairs = []
    for s in sessions:
        if (s.get("sessionId") or s["id"]) not in only:
            continue
        sid = short_id(s)
        entries = entries_of(sid)
        msg = (last_message(entries) or {}).get("message") or {}
        if msg.get("role") == "assistant" and msg.get("stopReason") == "error" and TOKEN_HOOK_ERROR.search(str(msg.get("errorMessage") or "")):
            pairs.append((pool_tree(s, by_id.get(head_of(sid, by_id), s)), run_provider(entries)))
    return pairs


def find_paused(sessions, since_minutes, state, now, direct=False, only=frozenset(), check_hook=False):
    by_id = {short_id(s): s for s in sessions}
    tails = {}
    accounts = {}
    hooks = {}
    pool_reads = {}
    stops = []

    def shutdowns():
        if not stops:
            stops.append(worker_shutdowns())
        return stops[0]

    restart_windows = []

    def restarts():
        if not restart_windows:
            restart_windows.append(daemon_restarts())
        return restart_windows[0]

    def head_session(head, s):
        row = by_id.get(head, s)
        return row.get("sessionId") or row["id"]

    def entries_of(sid):
        if sid not in tails:
            tails[sid] = tail_entries(by_id[sid].get("sessionFile", ""))
        return tails[sid]

    def asleep_in_retry(s, sid, head):
        """retry_wait's mark, which lets the job sweep abort the run and continue it, only when the continue would go through right now: no
        stop record names the run, and pi-pool has an account that can serve its tree and holds the tree in no wait or backoff. A run asleep
        on a 429 or a token hook hold whose tree pi-pool still holds gets `pool_hold` and `pool_at` (epoch seconds) instead, which
        waits_for_pool turns into a HELD entry. A run asleep in its retry that fails another check gets `retry_blocked` with the reason, so a
        stop record that did not read or a pool answer that is unknown shows in the report (and the record also under "incomplete") and the
        run stays with the Resume button."""
        error = pool_error(entries_of(sid))
        if not error:
            return {}
        mark = retry_wait(entries_of(sid))
        try:
            if stop_record(s.get("sessionFile")):
                return {"retry_blocked": "a stop record names it"} if mark else {}
        except RecordError as record_error:
            INCOMPLETE.append({"host": BOX.name, "error": f"not checked {sid}: {record_error}"})
            return {"retry_blocked": f"its stop record did not read: {record_error}"} if mark else {}
        blocker, free_at = account_blocker(pool_tree(s, by_id.get(head, s)), run_provider(entries_of(sid)), accounts, strict=True)
        if blocker and not blocker.startswith("unknown:"):
            return {"pool_hold": blocker, "pool_at": free_at or error_free_at(error, time.time())}
        return ({"retry_blocked": blocker} if blocker else mark) if mark else {}

    def queued_in_pool(full):
        """Where pi-pool's turn queue holds the session, read once a pass from the box's pool; None when it is not queued or the read failed."""
        if "queue" not in pool_reads:
            try:
                pool_reads["queue"] = queue_places(BOX.pool_queue())
            except (OSError, ValueError, AttributeError, subprocess.SubprocessError) as error:
                sys.stderr.write(f"resume: pi-pool queue on {BOX.name or 'this box'} did not read: {error}\n")
                pool_reads["queue"] = {}
        return pool_reads["queue"].get(full)

    def waits_for_pool(s, sid, head, hung, wait):
        """A hung run that only waits for pi-pool goes to HELD ("waiting for its provider"), not to `paused`: its turn sits in pi-pool's queue,
        or Prime sleeps on a 429 or a token hook hold while `pi-pool who` still holds its tree. An abort would only drop its queue place or
        meet the same hold, and the chat service asks the pool again at its pool time. On 10-20 from 23:34Z every Claude account on the Mac was
        limited, and d1 counted 32 such runs as stopped for 3 runs in a row."""
        full = s.get("sessionId") or s["id"]
        held_by = queued_in_pool(full) or wait.get("pool_hold")
        if not held_by:
            return False
        pool_at = wait.get("pool_at")
        HELD.append({"id": sid, "session_id": full, "name": s.get("sessionName") or "(unnamed)", "head": head, "head_session_id": head_session(head, s),
                     "tree": pool_tree(s, by_id.get(head, s)), "provider": run_provider(entries_of(sid)), "reason": "hung", "hung_min": round(hung, 1),
                     "errored_at": s.get("lastActivityAt") or s.get("modified"), "held_by": held_by,
                     "pool_at": dt.datetime.fromtimestamp(pool_at, dt.timezone.utc).isoformat(timespec="seconds") if pool_at else None,
                     **({"host": BOX.name} if BOX.remote else {})})
        return True

    if BOX.remote:
        # Each relay read takes 0.4 to 1.6 s from us-metal02 to the Mac (10-18), so the tails this pass may read are fetched at once.
        def wanted(s):
            full = s.get("sessionId") or s["id"]
            if only and full not in only:
                return False
            seen_at = parse_ts(s.get("lastActivityAt") or s.get("modified"))
            fresh = not since_minutes or not seen_at or (now - seen_at).total_seconds() / 60 <= since_minutes + 5
            listed = parse_ts(s.get("lastActivityAt") or s.get("modified"))
            hung = listed and (now - listed).total_seconds() / 60 >= HUNG_MIN
            return bool(s.get("sessionFile")) and (full in OWNERS or full in UNLOADED or full in only or (fresh and (not is_busy(s) or hung)))
        ids = [short_id(s) for s in sessions if wanted(s)]
        pool = concurrent.futures.ThreadPoolExecutor(RELAY_READS)
        try:
            tails.update(zip(ids, pool.map(lambda sid: tail_entries(by_id[sid]["sessionFile"]), ids)))
        finally:
            pool.shutdown(wait=not STOP, cancel_futures=True)

    def stopped(s, sid, why, at=None, cut=None, last=None):
        """`cut` is the verdict on the run's last turn and `last` that message: the report keeps why the turn stopped apart from why the sweep
        leaves it."""
        head = head_of(sid, by_id)
        STOPPED.append({"id": sid, "session_id": s.get("sessionId") or s["id"], "name": s.get("sessionName") or "(unnamed)", "head": head,
                        "head_session_id": head_session(head, s), "stopped_at": at, "stopped_by": why,
                        **({"cut": cut[0], "cut_error": cut[1][:400], "cut_at": (last or {}).get("timestamp")} if cut else {}),
                        **({"host": BOX.name} if BOX.remote else {})})

    if check_hook and only:
        prefetch_hooks(hook_pairs(sessions, only, by_id, entries_of), hooks)

    paused = []
    for s in sessions:
        sid = short_id(s)
        full = s.get("sessionId") or s["id"]
        FILES[full] = s.get("sessionFile")
        if only and full not in only:
            continue
        owner = full in OWNERS
        # A run named with --only is the caller's pick: it is read from its file when the daemon does not hold it, and an archive or abort
        # before its cut turn does not hide it (a deleted job still does).
        named = full in only
        unloaded_at = UNLOADED.get(full)
        seen_at = parse_ts(s.get("lastActivityAt") or s.get("modified"))
        if s.get("lifecycle") != "live" and not ((owner or named) and s.get("saved")) and unloaded_at is None and not named and since_minutes \
                and seen_at and (now - seen_at).total_seconds() / 60 > since_minutes + 5:
            continue  # an old archive, read no further
        if s.get("lifecycle") != "live" and not ((owner or named) and s.get("saved")) and not archived_by_unload(entries_of(sid), unloaded_at) \
                and not archived_by_restart(entries_of(sid), restarts) and not update_before(entries_of(sid), last_message(entries_of(sid)) or {}):
            continue
        reaped_at = REAPED.get(full) if not BOX.remote else None
        if s.get("workerState") == "failed" and not (reaped_at and (not seen_at or seen_at <= reaped_at)):
            if BOX.remote:
                # Reopening another box's head would restart a tree that may have moved: after the chats moved to us-metal02 at 05:30Z on
                # 10-18 the Mac listed 17 of their old root jobs with failed workers, already replaced on the box.
                continue
            head = head_of(sid, by_id)
            paused.append({"id": sid, "session_id": s.get("sessionId") or s["id"], "name": s.get("sessionName") or "(unnamed)",
                           "kind": s.get("runtimeKind"), "reason": "worker_failed",
                           "error": "Its Prime worker died; reopening its head starts it on a new worker.",
                           "errored_at": s.get("lastActivityAt") or s.get("modified"), "age_min": None, "head": head,
                           "head_session_id": by_id.get(head, s).get("sessionId") or by_id.get(head, s)["id"]})
            continue
        if is_busy(s):
            hung = hung_since(s, now, (lambda: entries_of(sid)) if BOX.remote else None)
            if hung is None or (since_minutes and hung > since_minutes):
                continue
            head = head_of(sid, by_id)
            wait = asleep_in_retry(s, sid, head)
            if waits_for_pool(s, sid, head, hung, wait):
                continue
            paused.append({"id": sid, "session_id": s.get("sessionId") or s["id"], "name": s.get("sessionName") or "(unnamed)",
                           "kind": s.get("runtimeKind"), "reason": "hung", "error": (f"Stuck in one tool call for {hung:.0f} min." if any(s.get(flag) for flag in TOOL_FLAGS)
                                     else f"Shows working but did nothing for {hung:.0f} min."),
                           "errored_at": s.get("lastActivityAt") or s.get("modified"), "age_min": round(hung, 1), "head": head,
                           "head_session_id": head_session(head, s), **wait})
            continue
        seen_at = parse_ts(s.get("lastActivityAt") or s.get("modified"))
        if since_minutes and seen_at and (now - seen_at).total_seconds() / 60 > since_minutes + 5:
            continue
        last = last_message(entries_of(sid))
        task = None
        if not last:
            started = never_started(s, entries_of(sid)) if owner else None
            if not started:
                continue
            last, task = started
            verdict = ("never_started", "Its worker stopped before its first task reached it.")
        else:
            unstuck = full in UNSTUCK
            if not unstuck and not named and stopped_on_purpose(entries_of(sid), last, restarts, unloaded_at):
                continue
            verdict = ("hung", "Was hung; the Resume button aborted it.") if unstuck else classify(last, now, entries_of(sid), shutdowns, owner or named, restarts)
            if not verdict:
                continue
            stopper = stop_archive(entries_of(sid), last)
            if stopper and not unstuck and not named:
                try:
                    recorded = stop_record(s.get("sessionFile"))
                    kind, why = ("stopped", recorded) if recorded else archive_verdict(stopper, full, s.get("sessionFile"), unloaded_at, entries_of(sid))
                except JobRecordError as error:
                    INCOMPLETE.append({"host": BOX.name, "error": f"not checked {sid}: {error}"})
                    continue
                if kind == "stopped":
                    stopped(s, sid, why, stopper.get("timestamp"), verdict, last)
                    continue
                if kind == "unresolved":
                    UNRESOLVED.append({"id": sid, "session_id": full, "name": s.get("sessionName") or "(unnamed)", "head": head_of(sid, by_id),
                                       "head_session_id": head_session(head_of(sid, by_id), s), "archived_at": stopper.get("timestamp"),
                                       "error": why, **({"host": BOX.name} if BOX.remote else {})})
                    continue
                if unload_stop_holds(s, verdict):
                    stopped(s, sid, f"{why} after a turn that did not fail on the token hook", stopper.get("timestamp"))
                    continue
        try:
            recorded = stop_record(s.get("sessionFile"))
        except JobRecordError as error:
            INCOMPLETE.append({"host": BOX.name, "error": f"not checked {sid}: {error}"})
            continue
        if recorded:
            stopped(s, sid, recorded, cut=verdict, last=last)
            continue
        ts = parse_ts(last.get("timestamp"))
        age_min = (now - ts).total_seconds() / 60 if ts else None
        if since_minutes and age_min is not None and age_min > since_minutes:
            continue
        if state.get(s.get("sessionId") or s["id"]) == last.get("timestamp"):
            continue  # this script already resumed this interruption
        head = head_of(sid, by_id)
        if not direct and head != sid and head in by_id and ts:
            redriven = last_user_at(entries_of(head))
            if redriven and redriven > ts:
                continue  # someone sent the head a message after the interruption
        root_id, provider = pool_tree(s, by_id.get(head, s)), run_provider(entries_of(sid))
        if verdict[0] == "error" and TOKEN_HOOK_ERROR.search(verdict[1]):
            blocker, free_at = (hook_blocker(root_id, provider, hooks) if check_hook else None), None
        else:
            blocker, free_at = account_blocker(root_id, provider, accounts)
        if blocker:
            free_at = free_at or error_free_at(verdict[1], time.time())
            HELD.append({"id": sid, "session_id": full, "name": s.get("sessionName") or "(unnamed)", "head": head, "head_session_id": head_session(head, s),
                         "tree": root_id, "provider": provider, "errored_at": last.get("timestamp"), "held_by": blocker,
                         "pool_at": dt.datetime.fromtimestamp(free_at, dt.timezone.utc).isoformat(timespec="seconds") if free_at else None,
                         **({"host": BOX.name} if BOX.remote else {})})
            continue
        paused.append({
            "id": sid,
            # The short id changes when a session is reloaded; the state file keys by the full session id.
            "session_id": s.get("sessionId") or s["id"],
            "name": s.get("sessionName") or "(unnamed)",
            "kind": s.get("runtimeKind"),
            "reason": verdict[0],
            "error": verdict[1][:160],
            "errored_at": last.get("timestamp"),
            "age_min": round(age_min, 1) if age_min is not None else None,
            "head": head,
            "head_session_id": head_session(head, s),
            **({"aborted": True} if full in UNSTUCK else {}),
            # A saved session has no short id the daemon answers to; it takes its full id, and the message reopens it.
            **({"target": full} if s.get("saved") or s.get("lifecycle") != "live" else {}),
            **({"task": task} if task else {}),
        })
    return paused


def compose(message, head_id, runs, working):
    others = [p for p in runs if p["id"] != head_id]
    if not others:
        return message
    lines = [f"- {p['name']} ({p['id']}), {p['errored_at']}: {p['error']}" for p in others]
    intro = "Note while you work:" if working else message + "\n\n"
    return (intro + ("\n" if working else "") +
            "These runs below you stopped on an interruption (network drop, sleep or sign-in refresh) and are idle:\n" +
            "\n".join(lines) + "\nCheck each one and re-drive it if it still has work.")


def send(target, message):
    out = BOX.send(target, message)
    try:
        j = json.loads(out)
    except ValueError:
        return {"deliveryStatus": "unknown", "raw": out[:200]}
    return {"deliveryStatus": j.get("deliveryStatus"), "deliveryMode": j.get("deliveryMode")}


def live_id(session_id):
    """The short id the daemon now runs `session_id` under, or None. A job the chat service just reopened from its file runs on a new
    worker, and a send to its full id answers "Unknown active session": at 19:51Z on 10-17 six reopened jobs ran again while the log
    said their continue failed."""
    try:
        rows = list_sessions()
    except CommandError:
        return None
    row = next((s for s in rows if (s.get("sessionId") or s["id"]) == session_id and s.get("lifecycle") == "live"), None)
    return row["id"] if row else None


UNKNOWN_SESSION = "Unknown active session"


def last_step(path):
    """The last thing the run at `path` did: its last reply text or tool call, cut to 200 characters."""
    for entry in reversed(tail_entries(path)):
        msg = entry.get("message") or {}
        if entry.get("type") != "message" or msg.get("role") != "assistant":
            continue
        for part in reversed(msg.get("content") or []):
            if isinstance(part, dict) and part.get("type") == "toolCall":
                return f"{part.get('name')} {json.dumps(part.get('arguments'))[:180]}"
        if reply_text(entry):
            return reply_text(entry)[:200]
    return None


def relay_note(name, session_id, text, doing=None):
    return (f'[relay] Your subagent "{name}" ({session_id}) is stopped, so the chat service could not reach it. '
            f'Send it the message below with agent_message.send(message, receiver_role="child", receiver_name={json.dumps(name)}), '
            "which reopens it in your tree. Skip it only if you stopped that subagent on purpose."
            + (f"\nThe last thing it did: {doing}" if doing else "") + "\n\n" + text)


def relay(session_id, text, describe=True):
    """Sends `text` for the stopped subagent `session_id` to its parent, whose rlm handle reopens it; a parent the daemon does not hold
    either gets it through its own parent, up to the root, whose send reopens it from its file. None when `session_id` is no subagent.

    The daemon finds a subagent only while its tree's worker holds it: `prime-agent send <id>` to one the idle unload or a restart dropped
    answers "Unknown active session" (10-18 04:29Z e9280d6280ea, and five Crawler VP subagents whose wakes were dropped at 05:00Z)."""
    path = session_files([session_id]).get(session_id)
    folder = Path(path).parent if path else None
    try:
        name = json.loads((folder / "rlm-subagent.json").read_text()).get("sessionName") if folder and folder.name.startswith("sub-") else None
    except (OSError, ValueError, AttributeError):
        name = None
    parent = parent_of(path) if name else None
    if not parent:
        return None
    note = relay_note(name, session_id, text, last_step(path) if describe else None)
    try:
        result = send(parent, note)
    except CommandError as error:
        result = relay(parent, note, describe=False) if UNKNOWN_SESSION in str(error) else None
        if result is None:
            raise
    return {**result, "relayed_through": parent}


def send_guard(p, found_at):
    """None when the run `p`, which the pass found at `found_at`, may get its message now, else what to report instead. The stop records are read again right before each send:
    a chat or a parent may delete or archive a run after the pass found it and before its turn in the send loop, and the owner may stop it.
    A transcript that does not read sends nothing."""
    path = FILES.get(p["session_id"])
    try:
        try:
            entries = parse_lines(BOX.tail(path, 256_000)) if path else []
        except OSError as error:
            raise JobRecordError(f"the transcript of {p['id']} could not be read ({error})") from None
        why = stop_record(path) or stopped_since(entries, found_at)
    except RecordError as error:
        INCOMPLETE.append({"host": BOX.name, "error": f"not sent to {p['id']}: {error}"})
        return {"error": f"not sent: {error}"}
    return f"skipped: {why} after the pass found it" if why else None


def sent_ok(res):
    return isinstance(res, dict) and "error" not in res


def direct_resume(paused, args, state, now):
    """--direct: each interrupted run gets the message itself, and no head gets a list. A hung run takes no message until
    it is aborted, and a run in a dead worker takes none at all."""
    actions = []
    with sending():
        for p in paused:
            if STOP:
                break
            if p["reason"] in ("hung", "worker_failed") and not p.get("aborted"):
                res = f"skipped: {p['reason']}"
            elif args.dry_run:
                res = "dry-run"
            elif (blocked := send_guard(p, now)) is not None:
                res = blocked
            else:
                text = NEVER_STARTED_INTRO + p["task"] if "task" in p else args.message
                try:
                    res = send(p.get("target", p["id"]), text)
                except CommandError as error:
                    unlisted = "target" in p
                    gone = unlisted and UNKNOWN_SESSION in str(error)
                    live = live_id(p["session_id"]) if gone else None
                    try:
                        res = send_guard(p, now) or (send(live, text) if live else (gone and relay(p["session_id"], text)) or {"error": str(error)[:300]})
                    except CommandError as again:
                        res = {"error": str(again)[:300]}
                if sent_ok(res):
                    state[p["session_id"]] = p["errored_at"]
                    save_state(args.state, state, now, args.since_minutes)
            actions.append({"id": p["id"], "name": p["name"], "head": p["head"], "result": res})
    return {"paused": paused, "heads": [], "children": actions, "message": args.message,
            "since_minutes": args.since_minutes, "checked_at": now.isoformat()}


def resume(sessions, args, now):
    by_id = {short_id(s): s for s in sessions}
    state = load_state(args.state)
    direct = getattr(args, "direct", False)
    only = set(filter(None, getattr(args, "only", "").split(",")))
    paused = find_paused(sessions, args.since_minutes, state, now, direct, only, check_hook=not args.dry_run)
    if direct:
        return direct_resume(paused, args, state, now)

    heads = {}
    for p in paused:
        heads.setdefault(p["head"], []).append(p)

    actions = []
    with sending():
        for h, runs in heads.items():
            if STOP:
                break
            hs = by_id.get(h, {})
            working = is_busy(hs)
            row = {
                "id": h,
                "name": hs.get("sessionName") or "(unnamed)",
                "activity": hs.get("activity"),
                "working": working,
                "paused_in_tree": [p["id"] for p in runs],
            }
            own_hang = any(p["id"] == h and p["reason"] == "hung" and not p.get("aborted") for p in runs)
            if hs.get("workerState") == "failed" and not args.dry_run:
                row["result"] = "skipped: its worker failed, reopen it first (the chat's Resume button does)"
            elif own_hang and not args.dry_run:
                row["result"] = "skipped: hung, abort it first (the chat's Resume button does)"
            elif working and not own_hang and all(p["id"] == h for p in runs):
                row["result"] = "skipped: already working"
            elif args.dry_run:
                row["result"] = "dry-run"
            else:
                guards = [(p, send_guard(p, now)) for p in runs]
                runs = [p for p, blocked in guards if blocked is None]
                failed = next((blocked for _, blocked in guards if isinstance(blocked, dict)), None)
                row["paused_in_tree"] = [p["id"] for p in runs]
                if failed or not runs:
                    row["result"] = failed or "skipped: every run below it was stopped on purpose after the pass found it"
                    actions.append(row)
                    continue
                try:
                    row["result"] = send(h, compose(args.message, h, runs, working))
                except CommandError as error:
                    row["result"] = {"error": str(error)[:300]}
                else:
                    for p in runs:
                        state[p["session_id"]] = p["errored_at"]
                    save_state(args.state, state, now, args.since_minutes)
            actions.append(row)

    child_actions = []
    if args.include_children:
        with sending():
            for p in paused:
                if STOP:
                    break
                if p["id"] in heads:
                    continue
                if args.dry_run:
                    res = "dry-run"
                elif p["reason"] == "worker_failed":
                    res = "skipped: its worker failed, its head is reopened instead"
                elif (blocked := send_guard(p, now)) is not None:
                    res = blocked
                else:
                    try:
                        res = send(p["id"], args.message)
                    except CommandError as error:
                        res = {"error": str(error)[:300]}
                    else:
                        state[p["session_id"]] = p["errored_at"]
                        save_state(args.state, state, now, args.since_minutes)
                child_actions.append({"id": p["id"], "name": p["name"], "head": p["head"], "result": res})

    return {"paused": paused, "heads": actions, "children": child_actions, "message": args.message,
            "since_minutes": args.since_minutes, "checked_at": now.isoformat()}


def resume_box(box, args, seen=None):
    """One box's pass: its sessions, the saved ones the owners and the idle unload's record name, and their resume. Another box's runs carry
    its name in `host`. `seen` holds the sessions a box before this one listed or read from its disk: another box looks only for the rest, so
    it skips its daemon's full list (18 s for the Mac's 3069 rows on 10-18, against 3 s for the plain list) when every named session is
    local. With that full list each pass took 56 s, and the chat service's 90 s limit killed the 06:56Z send pass that named run-6's job."""
    global BOX
    BOX = box
    seen = set() if seen is None else seen
    try:
        sessions = list_sessions()
        read = (OWNERS | set(UNLOADED) | set(filter(None, args.only.split(",")))) - seen
        if read:
            sessions = with_saved_owners(sessions, saved_rows(read - {s.get("sessionId") or s["id"] for s in sessions}), read)
        seen.update(s.get("sessionId") or s["id"] for s in sessions)
        part = resume(sessions, args, dt.datetime.now(dt.timezone.utc))
    finally:
        BOX = LocalBox()
    if box.remote:
        prune_tails(box.name)
        for key in ("paused", "heads", "children"):
            part[key] = [{**row, "host": box.name} for row in part[key]]
    return part


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--message", default="continue", help='message to send (default "continue")')
    ap.add_argument("--since-minutes", type=float, default=1440, help="ignore interruptions older than this (default 1440 = 24 h; 0 = no limit)")
    ap.add_argument("--dry-run", action="store_true", help="show targets, send nothing")
    ap.add_argument("--include-children", action="store_true", help="also message interrupted child sessions, not only heads")
    ap.add_argument("--state", default=str(DEFAULT_STATE), help="file that remembers resumed interruptions")
    ap.add_argument("--json", action="store_true", help="print JSON")
    ap.add_argument("--unstuck", default="", help="comma-separated full session ids the caller aborted because they were hung")
    ap.add_argument("--direct", action="store_true", help="message each interrupted run itself and send no head a list")
    ap.add_argument("--only", default="", help="comma-separated full session ids: act only on these interrupted runs, read from their files when the daemon does not list them")
    ap.add_argument("--this-box", action="store_true", help="look only at this box's daemon, not at the other boxes in hosts.json")
    ap.add_argument("--owners", default="", help="comma-separated full session ids that own an open step of a chat (see above)")
    args = ap.parse_args()
    UNSTUCK.update(filter(None, args.unstuck.split(",")))
    OWNERS.update(filter(None, args.owners.split(",")))
    since = dt.datetime.now(dt.timezone.utc) - dt.timedelta(minutes=args.since_minutes or 1e7)
    UNLOADED.update({sid: stamp for sid, stamp in load_unloaded(UNLOADED_FILE).items() if stamp >= since})
    REAPED.update(load_reaped(REAPED_FILE))

    signal.signal(signal.SIGTERM, on_term)
    report = None
    seen = set()
    incomplete = []
    for box in [LocalBox(), *([] if args.this_box else other_boxes())]:
        try:
            part = resume_box(box, args, seen)
        except Stopped:
            incomplete.append({"host": box.name, "error": stop_note(f"while it checked {box.name or 'this box'}")})
            break
        except RecordError as error:
            sys.stderr.write(f"resume: {box.name or 'this box'}: {error}\n")
            incomplete.append({"host": box.name, "error": f"sent nothing: {error}"})
            continue
        except (CommandError, OSError, ValueError, KeyError) as error:
            if not box.remote:
                raise SystemExit(str(error))
            sys.stderr.write(f"resume: {box.name}: {error}\n")
            incomplete.append({"host": box.name, "error": str(error)[:300]})
            continue
        report = part if report is None else {**report, **{key: report[key] + part[key] for key in ("paused", "heads", "children")}}
        if STOP:
            incomplete.append({"host": box.name, "error": stop_note(f"during the sends on {box.name or 'this box'}")})
            break
    signal.signal(signal.SIGTERM, lambda signum, _frame: STOP.append(signum))
    report = report or {"paused": [], "heads": [], "children": [], "checked_at": dt.datetime.now(dt.timezone.utc).isoformat()}
    incomplete = [*INCOMPLETE, *incomplete]
    if incomplete:
        report["incomplete"] = incomplete
    if UNRESOLVED:
        report["unresolved"] = UNRESOLVED
    if STOPPED:
        report["stopped"] = STOPPED
    if HELD:
        report["held"] = HELD
    if args.json:
        print(json.dumps(report, indent=1))
        return finish()

    for entry in incomplete:
        print(f"not finished on {entry['host'] or 'this box'}: {entry['error']}")
    for entry in UNRESOLVED:
        print(f"not resumed: {entry['id']}  {entry['name'][:40]}  archived {entry['archived_at']}: {entry['error']}")
    for entry in STOPPED:
        print(f"stopped on purpose: {entry['id']}  {entry['name'][:40]}: {entry['stopped_by']}")
    for entry in HELD:
        print(f"waiting for {entry['provider'] or 'its provider'} in pi-pool: {entry['id']}  {entry['name'][:40]}: {entry['held_by']}, pool time {entry['pool_at'] or 'unknown'}")
    paused, actions, child_actions = report["paused"], report["heads"], report["children"]
    if not paused:
        print(f"no interrupted live run in the last {args.since_minutes:g} min")
        return finish()
    print(f"interrupted runs ({len(paused)}):")
    for p in paused:
        print(f"  {p['id']}  {p['name'][:40]:<40} {p['kind'] or '':<9} head={p['head']}  {p['errored_at']}  {p['error'][:80]}")
    print(f"\nheads ({len(actions)}), message={args.message!r}:")
    for a in actions:
        print(f"  {a['id']}  {a['name'][:40]:<40} {a['activity'] or '':<8} -> {a['result']}")
    if child_actions:
        print(f"\nchildren ({len(child_actions)}):")
        for c in child_actions:
            print(f"  {c['id']}  {c['name'][:40]:<40} head={c['head']} -> {c['result']}")
    return finish()


def finish():
    """After a stop the pass exits at once with the signal's code, so a relay read still in flight cannot hold it past the caller's kill."""
    if STOP:
        sys.stdout.flush()
        os._exit(128 + STOP[0])


if __name__ == "__main__":
    sys.exit(main())


