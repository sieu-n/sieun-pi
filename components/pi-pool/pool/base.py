"""Paths, config, the pool log and locks, the Keychain, token refresh, refusal probes and
rotation journals."""
import base64, fcntl, hashlib, json, os, pwd, re, subprocess, time, unicodedata, urllib.request, urllib.error


HOME = os.path.expanduser("~")
TM = os.environ.get("TOKENMAXXING_HOME") or os.path.join(HOME, ".config", "tokenmaxxing")
TM_ACCOUNTS = os.path.join(TM, "accounts.json")
TM_CODEX_ACCOUNTS = os.path.join(TM, "codex-accounts.json")
TM_STORES = os.path.join(TM, "stores")
TM_CODEX_STORES = os.path.join(TM, "codex-stores")
TM_LIVE = os.path.join(TM, "live")
TM_CODEX_LIVE = os.path.join(TM, "codex-live")
TM_LOCK = os.path.join(TM, "lock")
TM_CODEX_LOCK = os.path.join(TM, "codex-lock")
TM_INDEX_VERSION = 2
# Claude Code and tokenmaxxing file each store under the login name; a process started without USER must still read them.
KC_ACCOUNT = os.environ.get("TOKENMAXXING_KEYCHAIN_ACCOUNT") or os.environ.get("USER") or pwd.getpwuid(os.getuid()).pw_name

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
    # what one plan is worth in tier units, by tokenmaxxing's tier name or its
    # first word; anything else is 1. Measured 2026-10-12: a max 20x account took
    # about $7.5 of API-equivalent spend per 5h point, a max 5x or team seat $1.9.
    "tier_units": {"max 20x": 4, "max 5x": 1, "team": 1, "pro": 0.5},
    # R2 projection: the 5h percentage one busy tree spends per minute, by
    # tokenmaxxing's tier name or its first word, for an account with no rate of
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
    # allow an account a supervised session is running on
    "allow_active_account": True,
    # anthropic-only per-model weekly caps that also count toward depletion
    "switch_models": ["fable"],
    # a session record with no vend and no fresh pin for this long is dropped
    "pin_ttl_sec": 7 * 24 * 3600,
    # a session counts as running on an account if it vended within this window
    "active_session_sec": 3600,
    # a session tree that vended within this window still has a prompt cache on
    # its account: the daemon runs with PI_CACHE_RETENTION=long (1 h TTL), and
    # 2026-10-12 transcripts read 58-98% of the prompt from cache up to 3600 s
    # after the previous call, then 0-8%
    "cache_ttl_sec": 3600,
    # cooldown for an anthropic account whose organization refuses OAuth
    # (HTTP 403 oauth_not_allowed_for_organization) or rejects its token
    "refused_cooldown_sec": 24 * 3600,
    # `pi-pool probe` (run by the extension at session start) checks every
    # account for a refusal at most this often
    "probe_interval_sec": 6 * 3600,
    # The Mac-wide turn queue (pool/turns.py); 0 turns it off and keeps the limits below.
    "agent_queue_on": 1,
    # At most this many session turns work at once. 10-14 07:38 KST: 6.9 GB was left for agent work
    # and a working session cost 426 MB at p90, and 6,900 / 426 is 16
    # (sessions/2026/10/14/0735-agent-queue-design/agent-queue-measure.md).
    "mac_working_max": 16,
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
    # The memory governor (turns.governor): 0 leaves the limits above as they are under any pressure.
    "memory_governor_on": 1,
    # The working limit while memory pressure is high or critical, when below mac_working_max.
    # High is the 16 that fit in the 6.9 GB free at 07:38 KST on 10-14 (426 MB per working
    # session at p90). Critical is the same 16: from 21:07 to 22:48 KST on 10-14 the
    # pressure came from cold chat-worker heap, turns asked for 11.5 slots on average, and a
    # replay of that log (tests/live_1014_2107_2248kst.json) at 8 left the 90th percentile
    # turn waiting 1,932 s, at 16 44 s.
    "pressure_working_max": {"high": 16, "critical": 16},
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
    """Advisory flock(2), same primitive tokenmaxxing uses on its lock file."""

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
def kc_read(service):
    r = subprocess.run(["/usr/bin/security", "find-generic-password", "-s", service,
                        "-a", KC_ACCOUNT, "-w"], capture_output=True, text=True)
    if r.returncode == 44:
        return None
    if r.returncode != 0:
        raise RuntimeError(f"keychain read failed for {service}: exit {r.returncode}")
    return r.stdout.rstrip("\n")


def kc_write(service, secret):
    """ps-safe write: the secret travels on stdin, never in argv."""
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
    r = subprocess.run(["/usr/bin/security", "delete-generic-password", "-s", service, "-a", KC_ACCOUNT],
                       capture_output=True, text=True)
    if r.returncode not in (0, 44):
        raise RuntimeError(f"keychain delete failed for {service}: exit {r.returncode}")


def store_dir(account_id):
    """tokenmaxxing's storeDirFor: stores/<first 8 chars of the account id>."""
    return os.path.join(TM_STORES, account_id[:8])


def store_service(store):
    """tokenmaxxing's namespacedCredService, which is also the keychain service
    Claude Code itself uses when CLAUDE_SECURESTORAGE_CONFIG_DIR names `store`."""
    digest = hashlib.sha256(unicodedata.normalize("NFC", store).encode()).hexdigest()
    return f"Claude Code-credentials-{digest[:8]}"


class ClaudeRefreshLock:
    """Claude Code's credential-refresh lock on one store, mirroring
    tokenmaxxing's withClaudeRefreshLock: mkdir `<store>/.oauth_refresh.lock`
    and `<realpath store>.lock`, both treated as stale after 60s. Supervised
    claude sessions on the same store refresh under this lock, so a refresh
    here never races theirs."""

    STALE_SEC = 60.0

    def __init__(self, store, attempts=5, retry_sec=0.4):
        self.store, self.attempts, self.retry_sec = store, attempts, retry_sec
        self.held = []

    @classmethod
    def _try(cls, path):
        try:
            os.mkdir(path)
            return True
        except FileExistsError:
            pass
        try:
            if time.time() - os.stat(path).st_mtime > cls.STALE_SEC:
                os.rmdir(path)
                os.mkdir(path)
                return True
        except OSError:
            pass
        return False

    def __enter__(self):
        os.makedirs(self.store, exist_ok=True)
        primary = os.path.join(self.store, ".oauth_refresh.lock")
        legacy = os.path.realpath(self.store) + ".lock"
        for attempt in range(1, self.attempts + 1):
            if self._try(primary):
                if self._try(legacy):
                    self.held = [legacy, primary]
                    return self
                os.rmdir(primary)
            if attempt < self.attempts:
                time.sleep(self.retry_sec)
        raise TimeoutError(f"claude's refresh lock on {self.store} is contested")

    def __exit__(self, *exc):
        for path in self.held:
            try:
                os.rmdir(path)
            except OSError:
                pass
        self.held = []
        return False


def jwt_claims(token):
    """Read a JWT's payload without verifying the signature: the token was
    already handed to us by a store we trust, we are only reading its exp
    and identity claims to decide whether to refresh and whom we served."""
    payload = token.split(".")[1]
    padded = payload + "=" * (-len(payload) % 4)
    return json.loads(base64.urlsafe_b64decode(padded))


# ------------------------------------------------------------------- oauth io
DEFAULT_SCOPES = ["user:inference", "user:profile"]
# Budget for the 10s hook cap: pool lock + tokenmaxxing lock + refresh.
STATE_LOCK_TIMEOUT = 2.5
TM_LOCK_TIMEOUT = 3.0
REFRESH_TIMEOUT = 5.0
# Cloudflare fronts the token endpoint and rejects urllib's default signature
# with a 1010 "access denied"; Claude Code's own UA is the honest identity here.
USER_AGENT = "claude-cli/2.1.75"


def refresh_token(creds):
    """Rotate an anthropic grant, mirroring tokenmaxxing's refreshCredential
    contract: the server may omit refresh_token (reuse the old one) and may
    return updated scope / refresh_token_expires_in. Non-token fields are
    preserved."""
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


def anthropic_refusal(access_token, infer=False):
    """Why the API refuses this token, or None. Uses count_tokens: it costs
    nothing, it is not rate limited like the usage endpoint, and it answers
    with the same 403 as inference when the account's organization has OAuth
    turned off (verified 2026-09-23 on an account whose usage figures looked
    fine). 401 is a revoked token. `infer` sends a one-token message instead,
    for the terms check, which count_tokens is not known to apply. Any other
    answer (429, 5xx, network) is not a refusal."""
    url, payload, timeout = (
        (INFER_URL, {"model": INFER_MODEL, "max_tokens": 1, "system": OAUTH_SYSTEM}, INFER_TIMEOUT) if infer
        else (PROBE_URL, {"model": PROBE_MODEL}, PROBE_TIMEOUT))
    body = json.dumps({**payload, "messages": [{"role": "user", "content": "ok"}]}).encode()
    req = urllib.request.Request(url, data=body, method="POST", headers={
        "Authorization": f"Bearer {access_token}", "anthropic-beta": "oauth-2025-04-20",
        "anthropic-version": "2023-06-01", "Content-Type": "application/json", "User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(req, timeout=timeout):
            return None
    except urllib.error.HTTPError as e:
        if e.code == 401:
            return TOKEN_REJECTED
        refusal = account_refusal(e.read().decode(errors="replace"))
        return refusal or ("forbidden (403)" if e.code == 403 else None)
    except Exception:
        return None


def update_tm_account(index_path, account_id, change):
    """Apply `change(record)` to one account in tokenmaxxing's own index and
    write it back atomically when it returns True. Call under that index's flock."""
    idx = load_json(index_path)
    if not idx or idx.get("version") != TM_INDEX_VERSION:
        return False
    for rec in idx.get("accounts", []):
        if rec.get("id") == account_id and change(rec):
            tmp = f"{index_path}.tmp.{os.getpid()}"
            with open(tmp, "w") as f:
                f.write(json.dumps(idx, indent=2) + "\n")
            os.chmod(tmp, 0o600)
            os.replace(tmp, index_path)
            return True
    return False


def mark_needs_reauth(index_path, account_id):
    """Flag a dead grant in tokenmaxxing's own index, so `tokenmaxxing auth
    --all` offers it and no later request retries the dead refresh. Call under
    that index's flock."""
    def change(rec):
        if rec.get("needsReauth"):
            return False
        rec["needsReauth"] = True
        return True
    if update_tm_account(index_path, account_id, change):
        log("marked_needs_reauth", account_id=account_id)


def mark_refused(account_id, until):
    """Tell tokenmaxxing an account is refused until `until` (epoch seconds) via
    its own enforcedUntil field, the one it sets when the server walls an
    account. Its picker then keeps supervised `claude` sessions off it too."""
    until_ms = int(until * 1000)

    def change(rec):
        if (rec.get("enforcedUntil") or 0) >= until_ms:
            return False
        rec["enforcedUntil"] = until_ms
        return True
    with Flock(TM_LOCK, timeout=TM_LOCK_TIMEOUT):
        update_tm_account(TM_ACCOUNTS, account_id, change)


def refresh_codex_token(refresh_token_value):
    """Rotate a codex grant. The response has no expiry field; expiry is
    always read back out of the new access token's own exp claim."""
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
    """recover_rotation's view of one codex-stores/<uuid8>/auth.json file."""

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
    r = subprocess.run(["ps", "-o", "ppid=,lstart=,comm=", "-p", str(pid)],
                       capture_output=True, text=True)
    out = r.stdout.strip()
    if not out:
        return None
    ppid, rest = out.split(None, 1)
    parts = rest.split()
    return {"ppid": int(ppid), "start": " ".join(parts[:5]), "comm": parts[-1]}
