"""Paths, config, the pool log and locks, the account store, the Keychain, token refresh,
refusal probes and rotation journals."""
from __future__ import annotations

import base64, dataclasses, fcntl, json, os, pwd, re, subprocess, time


HOME = os.path.expanduser("~")
# The Keychain account every pool item is filed under; a process started without USER must still read them.
KC_ACCOUNT = os.environ.get("USER") or pwd.getpwuid(os.getuid()).pw_name

# This file is pool/base.py, so the code root is the folder above it, where vend.py is.
CODE_ROOT = os.path.dirname(os.path.dirname(os.path.realpath(__file__)))
POOL = os.environ.get("PI_POOL_DIR") or os.path.join(HOME, ".config", "pi-pool")
if os.path.commonpath([CODE_ROOT, os.path.realpath(POOL)]) == CODE_ROOT:
    raise SystemExit("PI_POOL_DIR must be outside the pi-pool source directory")
STATE = os.path.join(POOL, "state.json")
LOCK = os.path.join(POOL, "lock")
LOG = os.path.join(POOL, "pi-pool.log")
CONFIG = os.path.join(POOL, "config.json")
FALLBACK = os.path.join(POOL, "fallback.json")
# The account store: one index per provider, each with its own flock, which also
# serializes every refresh of that provider's credentials. A Claude credential is a
# Keychain item (SECRETS on Linux), a Codex credential a 0600 auth.json file.
ACCOUNTS = os.path.join(POOL, "accounts")
INDEX = {"anthropic": os.path.join(ACCOUNTS, "anthropic.json"),
         "openai-codex": os.path.join(ACCOUNTS, "openai-codex.json")}
INDEX_LOCK = {provider: path[:-len(".json")] + ".lock" for provider, path in INDEX.items()}
INDEX_VERSION = 1
CODEX_SECRETS = os.path.join(ACCOUNTS, "openai-codex")

TOKEN_URL = "https://platform.claude.com/v1/oauth/token"
CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
CODEX_TOKEN_URL = "https://auth.openai.com/oauth/token"
CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"

PROVIDERS = ("anthropic", "openai-codex")
SESSION_ENV = "PRIME_AGENT_INTERNAL_DAEMON_WORKER_ACTIVE_SESSION_ID"
SESSION_UUID_RE = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
JOURNAL_ENV = "PRIME_AGENT_INTERNAL_DAEMON_WORKER_RECOVERY_JOURNAL"

DEFAULTS = {
    # refresh a parked credential when it expires within this many seconds
    "refresh_skew_sec": 900,
    # R2: an account takes a tree that is not on it only under this 5h percentage
    # (low-priority trees: under low_admit_5h_max_pct) and under seven_day_max_pct
    # of its week and of its Fable cap. A tree already on an account stays there
    # until the provider stops serving it (429 or a window at 100%).
    "admit_5h_max_pct": 70,
    "low_admit_5h_max_pct": 50,
    "seven_day_max_pct": 98,
    # R4: an account admits admit_per_unit trees per tier unit (at least one) every
    # admit_slot_sec, so trees that leave one account together, or wake on one reset,
    # enter at slot pace. 2026-10-12 15:30: 25 vends landed on claude7 in 4 s.
    "admit_slot_sec": 120,
    "admit_per_unit": 1,
    # R5: a tree that finds no account under its admit cap waits a uniform random
    # 0 to this many seconds, a fresh draw each time, before it asks again. The
    # owner asked for it on 2026-10-18 ("prevent that with super long random
    # backoff on depleted", then "make it random 0-120m"): when accounts revived
    # a few minutes apart, every waiting tree met the first one at once
    # (2026-10-10 20:59:59 claude9: 27 trees in 10 s, a 429 44 s later).
    "depleted_backoff_max_sec": 7200,
    # what one plan is worth in tier units, by the account's tier name or its
    # first word; anything else is 1. Measured 2026-10-12: a max 20x account took
    # about $7.5 of API-equivalent spend per 5h point, a max 5x or team seat $1.9.
    "tier_units": {"max 20x": 4, "max 5x": 1, "team": 1, "pro": 0.5},
    # R2 projection: the 5h percentage one busy tree spends per minute, by
    # the account's tier name or its first word, for an account with no rate of
    # its own yet (sched.observed_rate: none in a window's first 20 min); a tier
    # not listed is not projected. Measured from 23 windows on 10-12 and 10-13 that pi-pool.log shows
    # going from their start (429 `until` - 5 h) to the 429, with each request's
    # API-equivalent cost from the trees' transcripts: 100% cost a team seat $250,
    # a max 5x $186 and a max 20x $601 (medians). A busy tree spent $1.71 a minute
    # (the Virev seat 10-13 22:40-23:04: 9 trees, $246, 144 tree-minutes; second
    # of the 23 windows, median $0.49). $1.71 / ($ per 1%) gives each rate.
    "tree_5h_pct_per_min": {"team": 0.68, "max 5x": 0.92, "max 20x": 0.28},
    # R2 projection: a tree is spending on an account while it sent a request
    # there within this window, the window the rates above were measured with
    "spending_tree_sec": 900,
    # R6: moves a tree may make in 24 h before it waits for its own account, and
    # the longest such wait; when its own account frees later, the tree moves anyway
    "max_moves_per_day": {"high": 6, "normal": 3, "low": 1},
    "budget_wait_max_sec": 3600,
    # cooldown applied to an account after a vend-failure signal
    "cooldown_sec": 1200,
    # anthropic-only per-model weekly caps that also count toward depletion
    "switch_models": ["fable"],
    "pin_ttl_sec": 7 * 24 * 3600,
    # a session counts as running on an account if it vended within this window
    "active_session_sec": 3600,
    # cooldown for an anthropic account whose organization refuses OAuth
    # (HTTP 403 oauth_not_allowed_for_organization) or rejects its token
    "refused_cooldown_sec": 24 * 3600,
    # `pi-pool probe` (run by the extension at session start) checks every
    # account for a refusal at most this often
    "probe_interval_sec": 6 * 3600,
    # The machine-wide turn queue (pool/turns.py); 0 turns it off and keeps the limits below.
    "agent_queue_on": 1,
    # At most this many session turns work at once. 10-14 07:38 KST: 6.9 GB was left for agent work
    # and a working session cost 426 MB at p90, and 6,900 / 426 is 16
    # (sessions/2026/10/14/0735-agent-queue-design/agent-queue-measure.md).
    "working_max": 16,
    # At most this many turns of one session tree work at once: half of 16, so two
    # chats at full fan-out fit, above the 7 working sessions VP of CI held at 07:38.
    "tree_working_max": 8,
    # A queued turn moves up one class for every this many seconds it waits: the median
    # turn, first user or custom message to the last assistant message, was 18.1 s over
    # 27,578 turns in the 4 days to 10-14 08 KST (0735-agent-queue-design/data/measure_turns.py).
    "queue_aging_s": 18,
    # A working slot lapses when its session makes no model call for this long, so an
    # abort with no agent_end cannot hold it. 174,119 gaps between model calls inside
    # one turn over the 3 days to 10-14 08 KST: p99 157 s, p99.9 1,508 s, and 110 over
    # 1,800 s (0735-agent-queue-design/data/measure_gaps.py).
    "lease_s": 1800,
    # Prod turns (pool/prod.py): 0 queues a session a caller marked as on prod work like any other.
    "prod_turns_on": 1,
}


def log(event, **kw):
    try:
        with open(LOG, "a") as f:
            f.write(json.dumps({"ts": time.strftime("%Y-%m-%dT%H:%M:%S"), "event": event, **kw}) + "\n")
    except Exception:
        pass


def load_json(path, default=None):
    try:
        with open(path) as f:
            return json.load(f)
    except Exception:
        return default


def save_json(path, data):
    # One C-encoded string and one write. json.dump(indent=2) streams through the
    # pure-Python encoder: 130 ms for the 900 KB state.json, under the pool flock.
    text = json.dumps(data, separators=(",", ":"))
    tmp = f"{path}.tmp.{os.getpid()}"
    with open(tmp, "w") as f:
        f.write(text)
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)
    sweep_dead_writers(path)


def sweep_dead_writers(path):
    """Remove `<path>.tmp.<pid>` files whose writer is gone. A writer killed between
    the open and the rename leaves one: Prime stops a hook at its 10 s timeout, and
    on 2026-10-08 six of them, 80 KB to 835 KB each, sat next to state.json."""
    folder, prefix = os.path.split(path)
    prefix += ".tmp."
    for name in os.listdir(folder or "."):
        pid = name[len(prefix):]
        if not name.startswith(prefix) or not pid.isdigit() or int(pid) == 0:
            continue
        try:
            os.kill(int(pid), 0)
        except ProcessLookupError:
            try:
                os.remove(os.path.join(folder, name))
            except FileNotFoundError:
                pass
        except PermissionError:
            pass


def config():
    cfg = dict(DEFAULTS)
    cfg.update(load_json(CONFIG, {}) or {})
    return cfg


class Flock:
    """Advisory flock(2) on one lock file."""

    def __init__(self, path, timeout=6.0):
        self.path, self.timeout, self.fd = path, timeout, None

    def __enter__(self):
        os.makedirs(os.path.dirname(self.path), exist_ok=True)
        self.fd = os.open(self.path, os.O_CREAT | os.O_APPEND | os.O_RDWR, 0o600)
        deadline = time.time() + self.timeout
        while True:
            try:
                fcntl.flock(self.fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                return self
            except OSError:
                if time.time() >= deadline:
                    os.close(self.fd)
                    self.fd = None
                    raise TimeoutError(f"could not lock {self.path}")
                time.sleep(0.05)

    def __exit__(self, *exc):
        if self.fd is not None:
            fcntl.flock(self.fd, fcntl.LOCK_UN)
            os.close(self.fd)
            self.fd = None
        return False


# ---------------------------------------------------------------- keychain io
# Linux has no Keychain and no /usr/bin/security, so off macOS each item is a 0600 file named by its
# service in a 0700 folder inside the account store. PI_POOL_SECRETS=file picks the files on macOS too.
SECRETS = os.path.join(ACCOUNTS, "secrets")
FILE_SECRETS = os.environ.get("PI_POOL_SECRETS") == "file" or not os.path.exists("/usr/bin/security")


def secret_path(service):
    if not service or "/" in service or service.startswith("."):
        raise RuntimeError(f"bad keychain service name {service!r}")
    return os.path.join(SECRETS, service)


def file_read(service):
    try:
        with open(secret_path(service)) as f:
            return f.read()
    except FileNotFoundError:
        return None


def file_write(service, secret):
    os.makedirs(SECRETS, mode=0o700, exist_ok=True)
    path = secret_path(service)
    tmp = f"{path}.tmp.{os.getpid()}"
    fd = os.open(tmp, os.O_CREAT | os.O_TRUNC | os.O_WRONLY, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(secret)
    os.replace(tmp, path)


def file_delete(service):
    try:
        os.unlink(secret_path(service))
    except FileNotFoundError:
        pass


def kc_read(service):
    if FILE_SECRETS:
        return file_read(service)
    r = subprocess.run(["/usr/bin/security", "find-generic-password", "-s", service,
                        "-a", KC_ACCOUNT, "-w"], capture_output=True, text=True)
    if r.returncode == 44:
        return None
    if r.returncode != 0:
        raise RuntimeError(f"keychain read failed for {service}: exit {r.returncode}")
    return r.stdout.rstrip("\n")


def kc_write(service, secret):
    """ps-safe write: the secret travels on stdin, never in argv."""
    if FILE_SECRETS:
        return file_write(service, secret)
    if "'" in secret:
        quoted = '"' + secret.replace("\\", "\\\\").replace('"', '\\"') + '"'
    else:
        quoted = f"'{secret}'"
    line = f'add-generic-password -U -a "{KC_ACCOUNT}" -s "{service}" -w {quoted}\n'
    if len(line) > 4000:
        raise RuntimeError("keychain write line exceeds security(1) buffer")
    r = subprocess.run(["/usr/bin/security", "-i"], input=line, capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(f"keychain write failed for {service}: {r.stderr.strip()[:200]}")


def kc_delete(service):
    if FILE_SECRETS:
        return file_delete(service)
    r = subprocess.run(["/usr/bin/security", "delete-generic-password", "-s", service, "-a", KC_ACCOUNT],
                       capture_output=True, text=True)
    if r.returncode not in (0, 44):
        raise RuntimeError(f"keychain delete failed for {service}: exit {r.returncode}")


def claude_service(account_id):
    """The Keychain service of one Claude account's credential."""
    return f"pi-pool.anthropic.{account_id}"


def codex_secret(account_id):
    """The 0600 auth.json of one Codex account."""
    return os.path.join(CODEX_SECRETS, f"{account_id}.json")


def jwt_claims(token):
    """Read a JWT's payload without verifying the signature: the token was
    already handed to us by a store we trust, we are only reading its exp
    and identity claims to decide whether to refresh and whom we served."""
    payload = token.split(".")[1]
    padded = payload + "=" * (-len(payload) % 4)
    return json.loads(base64.urlsafe_b64decode(padded))


# ------------------------------------------------------------------- oauth io
DEFAULT_SCOPES = ["user:inference", "user:profile"]
# Budget for the 10s hook cap: pool lock + account index lock + refresh.
STATE_LOCK_TIMEOUT = 2.5
INDEX_LOCK_TIMEOUT = 3.0
REFRESH_TIMEOUT = 5.0
# Cloudflare fronts the token endpoint and rejects urllib's default signature
# with a 1010 "access denied"; Claude Code's own UA is the honest identity here.
USER_AGENT = "claude-cli/2.1.75"


def refresh_token(creds):
    """Rotate an anthropic grant. The server may omit refresh_token (reuse the
    old one) and may return updated scope / refresh_token_expires_in. Non-token
    fields are preserved."""
    import urllib.error, urllib.request
    scopes = creds.get("scopes") or DEFAULT_SCOPES
    body = json.dumps({
        "grant_type": "refresh_token",
        "refresh_token": creds["refreshToken"],
        "client_id": CLIENT_ID,
        "scope": " ".join(scopes),
    }).encode()
    req = urllib.request.Request(TOKEN_URL, data=body, method="POST",
                                 headers={"Content-Type": "application/json",
                                          "Accept": "application/json",
                                          "User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(req, timeout=REFRESH_TIMEOUT) as resp:
            data = json.loads(resp.read())
    except urllib.error.HTTPError as e:
        text = e.read().decode()
        if e.code == 400 and "invalid_grant" in text:
            raise RuntimeError("invalid_grant: refresh token is dead (needs reauth)")
        raise RuntimeError(f"refresh failed http {e.code}")

    now_ms = int(time.time() * 1000)
    out = dict(creds)
    out["accessToken"] = data["access_token"]
    out["refreshToken"] = data.get("refresh_token") or creds["refreshToken"]
    out["expiresAt"] = now_ms + int(data.get("expires_in") or 8 * 3600) * 1000
    if data.get("refresh_token_expires_in") is not None:
        out["refreshTokenExpiresAt"] = now_ms + int(data["refresh_token_expires_in"]) * 1000
    if data.get("scope"):
        out["scopes"] = [s for s in data["scope"].split(" ") if s]
    return out


PROBE_URL = "https://api.anthropic.com/v1/messages/count_tokens"
PROBE_MODEL = "claude-opus-4-8"
PROBE_TIMEOUT = 3.0
INFER_URL = "https://api.anthropic.com/v1/messages"
INFER_MODEL = "claude-haiku-4-5"
INFER_TIMEOUT = 15.0
OAUTH_SYSTEM = "You are Claude Code, Anthropic's official CLI for Claude."
OAUTH_OFF = "oauth not allowed for organization"
NEEDS_TERMS = "needs terms"
TOKEN_REJECTED = "token rejected (401)"


def account_refusal(text):
    """The account-level refusal an API error body names, or None. These fail
    every request on the account whatever the model or the prompt, so the pool
    takes the account out instead of letting turns fail on it. NEEDS_TERMS is the
    400 Anthropic sends until someone signed in as the account accepts updated
    Consumer Terms on claude.ai (2026-10-08: claude7@slack.green failed every turn
    for 3 min after it was added)."""
    if "OAuth authentication is currently not allowed" in text or "oauth_not_allowed" in text:
        return OAUTH_OFF
    if "updated our Consumer Terms" in text:
        return NEEDS_TERMS
    return None


@dataclasses.dataclass(frozen=True)
class ProbeAccepted:
    pass


@dataclasses.dataclass(frozen=True)
class ProbeRefused:
    reason: str


@dataclasses.dataclass(frozen=True)
class ProbeUnavailable:
    pass


def anthropic_probe(access_token, infer=False, timeout=None) -> ProbeAccepted | ProbeRefused | ProbeUnavailable:
    """Check provider acceptance. Terms require inference, not count_tokens."""
    import urllib.error, urllib.request
    url, payload, default_timeout = (
        (INFER_URL, {"model": INFER_MODEL, "max_tokens": 1, "system": OAUTH_SYSTEM}, INFER_TIMEOUT) if infer
        else (PROBE_URL, {"model": PROBE_MODEL}, PROBE_TIMEOUT))
    body = json.dumps({**payload, "messages": [{"role": "user", "content": "ok"}]}).encode()
    req = urllib.request.Request(url, data=body, method="POST", headers={
        "Authorization": f"Bearer {access_token}", "anthropic-beta": "oauth-2025-04-20",
        "anthropic-version": "2023-06-01", "Content-Type": "application/json", "User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(req, timeout=default_timeout if timeout is None else min(timeout, default_timeout)):
            return ProbeAccepted()
    except urllib.error.HTTPError as e:
        if e.code == 401:
            return ProbeRefused(TOKEN_REJECTED)
        refusal = account_refusal(e.read().decode(errors="replace"))
        if refusal or e.code == 403:
            return ProbeRefused(refusal or "forbidden (403)")
        return ProbeUnavailable()
    except Exception:
        return ProbeUnavailable()


def read_index(provider):
    """One provider's index, {"version", "accounts"}. A missing file is an empty
    pool (a fresh machine before its first `pi-pool login`); an unreadable or
    foreign one raises."""
    path = INDEX[provider]
    if not os.path.exists(path):
        return {"version": INDEX_VERSION, "accounts": []}
    idx = load_json(path)
    if not isinstance(idx, dict) or idx.get("version") != INDEX_VERSION or not isinstance(idx.get("accounts"), list):
        raise RuntimeError(f"{os.path.basename(path)} unreadable")
    return idx


def write_index(provider, idx):
    """Write one provider's index atomically, mode 0600. Call under its flock."""
    os.makedirs(ACCOUNTS, mode=0o700, exist_ok=True)
    path = INDEX[provider]
    tmp = f"{path}.tmp.{os.getpid()}"
    with open(tmp, "w") as f:
        f.write(json.dumps(idx, indent=2) + "\n")
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)


def index_lock(provider):
    return Flock(INDEX_LOCK[provider], timeout=INDEX_LOCK_TIMEOUT)


def update_account(provider, account_id, change):
    """Apply `change(record)` to one account of the index and write it back when
    it returns True. Call under that index's flock."""
    idx = read_index(provider)
    for rec in idx["accounts"]:
        if rec.get("id") == account_id and change(rec):
            write_index(provider, idx)
            return True
    return False


def mark_needs_reauth(provider, account_id):
    """Flag a dead grant in the index, so no later request retries the dead
    refresh and the account shows Sign in again. Call under that index's flock."""
    def change(rec):
        if rec.get("needsReauth"):
            return False
        rec["needsReauth"] = True
        return True
    if update_account(provider, account_id, change):
        log("marked_needs_reauth", provider=provider, account_id=account_id)


def refresh_codex_token(refresh_token_value):
    """Rotate a codex grant. The response has no expiry field; expiry is
    always read back out of the new access token's own exp claim."""
    import urllib.error, urllib.request
    body = json.dumps({
        "client_id": CODEX_CLIENT_ID,
        "grant_type": "refresh_token",
        "refresh_token": refresh_token_value,
    }).encode()
    req = urllib.request.Request(CODEX_TOKEN_URL, data=body, method="POST",
                                 headers={"Content-Type": "application/json",
                                          "Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=REFRESH_TIMEOUT) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        text = e.read().decode()
        if e.code == 400 and "refresh_token_reused" in text:
            raise RuntimeError("refresh_token_reused: codex grant is dead (needs reauth)")
        raise RuntimeError(f"codex refresh failed http {e.code}")


def merge_codex_tokens(blob, fresh):
    """Write the rotation back into the whole blob, preserving sibling keys
    (auth_mode, OPENAI_API_KEY) the codex CLI's own schema needs."""
    out = dict(blob)
    tokens = dict(blob.get("tokens") or {})
    tokens["access_token"] = fresh["access_token"]
    if fresh.get("refresh_token"):
        tokens["refresh_token"] = fresh["refresh_token"]
    if fresh.get("id_token"):
        tokens["id_token"] = fresh["id_token"]
    out["tokens"] = tokens
    out["last_refresh"] = time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime()) + ".000Z"
    return out


# ------------------------------------------------- rotation crash-safe journal
JOURNAL = os.path.join(POOL, "rotations")


def journal_path(store_key):
    safe = "".join(ch if ch.isalnum() or ch in "-_." else "_" for ch in store_key)
    return os.path.join(JOURNAL, f"{safe}.json")


def journal_write(store_key, blob):
    os.makedirs(JOURNAL, exist_ok=True)
    os.chmod(JOURNAL, 0o700)
    save_json(journal_path(store_key), {"blob": blob})


def journal_clear(store_key):
    try:
        os.remove(journal_path(store_key))
    except FileNotFoundError:
        pass


def recover_rotation(store_key, adapter):
    """Read a credential, healing a rotation whose store write was lost.

    Call under the store's own flock. A journalled credential that expires
    later than the stored one means the previous run refreshed (rotating the
    grant) but died before persisting; the stored token is dead, the
    journalled one is live, so the journal wins.
    """
    stored = adapter.read()
    pending = (load_json(journal_path(store_key)) or {}).get("blob")
    if pending and (not stored or adapter.expiry_ms(pending) > adapter.expiry_ms(stored)):
        adapter.write(pending)
        journal_clear(store_key)
        log("rotation_recovered", store=store_key)
        return pending
    if pending:
        journal_clear(store_key)
    if not stored:
        raise RuntimeError(f"no credential for {store_key}")
    return stored


class KeychainAdapter:
    """recover_rotation's view of one anthropic keychain item."""

    def __init__(self, service):
        self.service = service

    def read(self):
        raw = kc_read(self.service)
        return json.loads(raw)["claudeAiOauth"] if raw else None

    def expiry_ms(self, blob):
        return blob["expiresAt"]

    def write(self, blob):
        kc_write(self.service, json.dumps({"claudeAiOauth": blob}))


class CodexFileAdapter:
    """recover_rotation's view of one Codex account's auth.json file."""

    def __init__(self, path):
        self.path = path

    def read(self):
        return load_json(self.path)

    def expiry_ms(self, blob):
        return jwt_claims(blob["tokens"]["access_token"])["exp"] * 1000

    def write(self, blob):
        os.makedirs(os.path.dirname(self.path), mode=0o700, exist_ok=True)
        save_json(self.path, blob)


# ------------------------------------------------------------ caller identity
def proc_info(pid):
    """{"ppid", "start", "comm"} as `ps -o ppid=,lstart=,comm=` gives them, or None for no such process.
    Linux reads /proc instead of running ps, which costs about 80 ms of CPU on every hook call."""
    if os.path.isdir("/proc/self"):
        return linux_proc_info(pid)
    r = subprocess.run(["ps", "-o", "ppid=,lstart=,comm=", "-p", str(pid)],
                       capture_output=True, text=True)
    out = r.stdout.strip()
    if not out:
        return None
    ppid, rest = out.split(None, 1)
    parts = rest.split()
    return {"ppid": int(ppid), "start": " ".join(parts[:5]), "comm": parts[-1]}


def linux_proc_info(pid):
    """procps' lstart is the boot time in /proc/stat plus the start tick in /proc/<pid>/stat, in local time."""
    try:
        with open(f"/proc/{int(pid)}/stat", "rb") as f:
            stat = f.read()
        with open("/proc/stat", "rb") as f:
            boot = next(int(line.split()[1]) for line in f if line.startswith(b"btime "))
    except (OSError, StopIteration, ValueError):
        return None
    comm, fields = stat[stat.index(b"(") + 1:stat.rindex(b")")], stat[stat.rindex(b")") + 2:].split()
    at = time.localtime(boot + int(fields[19]) // os.sysconf("SC_CLK_TCK"))
    words = comm.decode(errors="replace").split() or [""]
    return {"ppid": int(fields[1]), "start": time.strftime(f"%a %b {at.tm_mday} %H:%M:%S %Y", at),
            "comm": "<defunct>" if fields[0] == b"Z" else words[-1]}
