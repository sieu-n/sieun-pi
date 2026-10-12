#!/usr/bin/env python3
"""pi-pool: vend a pooled OAuth access token to Prime Agent (pi), for Claude
(anthropic) and Codex (openai-codex).

Prime Agent resolves a provider apiKey of the form "!<this script> [--provider
<p>]" by executing the command and using stdout as the API key. Both wire
protocols accept a bare access token as the apiKey (pi-ai sniffs
"sk-ant-oat" for the Claude OAuth path; the openai-codex provider decodes the
account id straight out of the JWT), so a short-lived ACCESS token is all
either provider ever needs.

Prime receives access tokens only. This script reads tokenmaxxing's
per-account credential stores (tokenmaxxing >= 1.37: a keychain item keyed by
stores/<uuid8> for anthropic, codex-stores/<uuid8>/auth.json for codex),
refreshes in place under the same locks tokenmaxxing and Claude Code take, and
prints only an access token.
Private rotation journals live under the pool state directory.

stdout = the token, and nothing else. All diagnostics go to the log file.
"""
import base64, collections, concurrent.futures, dataclasses, datetime, fcntl, hashlib, json, math, os, pwd, queue, re, shlex, shutil, signal, subprocess, sys, threading, time, unicodedata, urllib.request, urllib.error, uuid

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

CODE_ROOT = os.path.dirname(os.path.realpath(__file__))
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
            return "token rejected (401)"
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


# ------------------------------------------------------------- usage math
SESSION_WINDOW_MAX_SEC = 6 * 3600


def live_pct(window, now):
    """A v2 window's usable-against percentage NOW, mirroring tokenmaxxing's
    liveUsed: a cached reset that has passed means the window is empty again
    (never a block reason), and a NULL reset self-bounds at sampledAt + the
    window's own duration so a stale snapshot cannot block forever."""
    if not window:
        return 0
    pct = window.get("usedPercentage") or 0
    resets = window.get("resetsAt")
    now_ms = now * 1000
    if resets is not None:
        return 0 if resets <= now_ms else pct
    secs = window.get("windowSeconds")
    if secs is not None and now_ms >= (window.get("sampledAt") or 0) + secs * 1000:
        return 0
    return pct


def is_session_window(window):
    """tokenmaxxing's isSessionWindow: classified by duration, never by position."""
    secs = window.get("windowSeconds")
    return secs is not None and secs <= SESSION_WINDOW_MAX_SEC


def session_window(account):
    """The unnamed session (5h) window, tokenmaxxing's sessionWindow."""
    return next((w for w in account.get("windows") or []
                 if w.get("name") is None and is_session_window(w)), None)


def weekly_window(account):
    """The longest unnamed non-session window, tokenmaxxing's weeklyWindow."""
    rows = [w for w in account.get("windows") or []
            if w.get("name") is None and not is_session_window(w)]
    return max(rows, key=lambda w: w.get("windowSeconds") or 0) if rows else None


def usage_pct(account, now):
    """(session %, weekly %) from an index v2 account's unnamed windows."""
    return live_pct(session_window(account), now), live_pct(weekly_window(account), now)


def family_tokens(name):
    """tokenmaxxing's familyTokens: lowercase, split on space, dot and dash."""
    return [t for t in re.split(r"[\s.-]+", name.strip().lower()) if t]


def gated_pct(account, cfg, now):
    """Worst live per-model cap among the gated families (switch_models),
    tokenmaxxing's gatedWindows over the index's NAMED windows."""
    families = [f.lower() for f in cfg["switch_models"]]
    worst = 0
    for w in account.get("windows") or []:
        name = w.get("name")
        if name is not None and any(f in family_tokens(name) for f in families):
            worst = max(worst, live_pct(w, now))
    return worst


def model_gated(model_id, cfg):
    """Whether a model belongs to a gated family (switch_models): claude-fable-5-1
    is gated by the fable cap, claude-opus-5-5 is not."""
    return any(f.lower() in family_tokens(model_id) for f in cfg["switch_models"])


def with_models(accounts, models, cfg):
    """Lift the per-model cap for a session that runs no gated model. No known
    model keeps the cap: an unknown session may be on Fable."""
    models = [m for m in models or () if m]
    if not models or any(model_gated(m, cfg) for m in models):
        return accounts
    return [dataclasses.replace(a, gate_off=True) for a in accounts]


def tree_records(state, key):
    """The records one session tree owns: the one under its key, then any record
    the same worker wrote before its descriptor named the tree uuid. A new
    worker's session_start runs before the daemon writes rootSessionId, so
    `pi-pool model` files the model under the short active id while the first
    request already resolves the uuid (seen 2026-09-28 on 01a0e55b)."""
    if key is None:
        return []
    sessions = state["sessions"]
    recs = [sessions[key.key]] if key.key in sessions else []
    if key.active_id:
        recs += [rec for k, rec in sessions.items()
                 if k != key.key and not rec.get("uuid") and rec.get("active_id") == key.active_id]
    return recs


def session_models(state, key, provider, cfg, now):
    """The models the sessions of one tree last selected on this provider, as
    the /account extension recorded them (`pi-pool model`)."""
    entries = [e for rec in tree_records(state, key)
               for e in (((rec.get("models") or {}).get(provider)) or {}).values()]
    return [e.get("model") for e in entries if now - (e.get("at") or 0) <= cfg["pin_ttl_sec"]]


def fmt_dur(sec):
    """Compact countdown, tokenmaxxing-watch style (4d22h / 3h39m / 42m)."""
    if sec is None:
        return "-"
    sec = int(sec)
    if sec < 60:
        return "<1m"
    d, r = divmod(sec, 86400)
    h, r = divmod(r, 3600)
    m = r // 60
    if d:
        return f"{d}d{h}h"
    if h:
        return f"{h}h{m}m"
    return f"{m}m"


def reset_in(window, now):
    """Seconds until a window's cached reset; None when unset or already
    passed (live_pct reads both as an empty window: 0% and no ETA)."""
    resets = (window or {}).get("resetsAt")
    if resets is None:
        return None
    left = resets / 1000 - now
    return left if left > 0 else None


# ============================================================ v2 domain model
# state.json v2. One file, one writer per key space: intent (pins) is written
# only by the CLI, observation (vends, cooldowns) only by the hook, and
# truth (usage, needs-reauth) is never written here at all - it is read from
# tokenmaxxing's indexes on every request. "A pin exists but its account cannot
# serve" is derived per request and never stored, so it heals itself.
Keychain = collections.namedtuple("Keychain", "service store", defaults=(None,))
CredFile = collections.namedtuple("CredFile", "path")


@dataclasses.dataclass(frozen=True)
class Account:
    """One pooled account, whichever index it came from. The picker, the
    resolver and the renderer see only this shape."""
    provider: str
    id: str
    email: str
    needs_reauth: bool
    session_pct: int
    weekly_pct: int
    gated_pct: int
    is_live: bool
    cred: object
    plan: str = ""
    tier: str = ""
    windows: tuple = ()
    usage_at: float = 0
    disabled: bool = False
    # True when every model the session runs is outside the gated families, so
    # a spent per-model cap (Fable) does not stop this account serving it.
    gate_off: bool = False
    # Epoch seconds until which the provider refused this account with a 429
    # (`pi-pool limited`). 0 when no limit is on file.
    limited_until: float = 0
    # What people see: the email, plus the organization when another pooled
    # account shares the email (one login can hold several organizations).
    label: str = ""

    def __post_init__(self):
        if not self.label:
            object.__setattr__(self, "label", self.email)


@dataclasses.dataclass(frozen=True)
class SessionKey:
    """Identity of the Prime Agent session tree that asked.

    One worker process serves one ROOT session and every rlm() subagent under
    it, so this is a session-TREE key and children inherit by construction.
    The short active id changes when a session is resumed in a new worker
    (verified 2026-09-06), so the uuid from the worker descriptor is the key
    and the short id is advisory.
    """
    key: str
    uuid: "str | None"
    active_id: "str | None"


def session_key():
    """The session tree that owns this process, or None outside one."""
    active = os.environ.get(SESSION_ENV) or None
    uuid = None
    journal = os.environ.get(JOURNAL_ENV)
    if journal:
        worker_id = os.path.basename(journal).split(".", 1)[0]
        desc = load_json(os.path.join(os.path.dirname(journal), worker_id + ".json")) or {}
        uuid = desc.get("rootSessionId") or None
        if not uuid and desc.get("sessionFile"):
            # The file NAME is not the session id. A scratch session observed on
            # 2026-09-06 was 01a0759e-4100-... inside a file called
            # 01a0759e-3f5b-....jsonl, so read the id from the header line.
            try:
                with open(desc["sessionFile"]) as f:
                    uuid = json.loads(f.readline()).get("id") or None
            except Exception:
                uuid = None
    key = uuid or active
    return SessionKey(key, uuid, active) if key else None


def resolve_session_arg(id_str, state):
    """--session <id>: a uuid, a short active id, or a uuid prefix, matched
    only against sessions already on file. No match is an error, not a
    silent new record."""
    if id_str in state["sessions"]:
        rec = state["sessions"][id_str]
        return SessionKey(id_str, rec.get("uuid"), rec.get("active_id"))
    hits = [k for k, rec in state["sessions"].items()
            if rec.get("active_id") == id_str or k.startswith(id_str)]
    if len(hits) == 1:
        rec = state["sessions"][hits[0]]
        return SessionKey(hits[0], rec.get("uuid"), rec.get("active_id"))
    return None


# ---------------------------------------------------- supervised-session presence
def presence_account_ids(presence_dir):
    """Accounts a tokenmaxxing-supervised session is running on right now.

    Each presence file is {accountId, pid, startedAt}, named by session id.
    tokenmaxxing verifies the pid's start time; a live pid is enough here,
    because the answer only adds a picker penalty and blocks a codex refresh.
    An unreadable record is skipped, never guessed.
    """
    ids = set()
    try:
        names = os.listdir(presence_dir)
    except FileNotFoundError:
        return ids
    for name in names:
        rec = load_json(os.path.join(presence_dir, name))
        if not isinstance(rec, dict) or not rec.get("accountId") or not isinstance(rec.get("pid"), int):
            continue
        try:
            os.kill(rec["pid"], 0)
        except ProcessLookupError:
            continue
        except PermissionError:
            pass
        ids.add(rec["accountId"])
    return ids


def assert_codex_identity(token, expected_id):
    """A cheap boundary check against a stale parked file: fail closed
    rather than serve the wrong account's token."""
    got = (jwt_claims(token).get("https://api.openai.com/auth") or {}).get("chatgpt_account_id")
    if got != expected_id:
        raise RuntimeError(f"codex token identity mismatch: expected {expected_id}, got {got}")


# ---------------------------------------------------------- boundary parsers
def load_index(provider):
    """Parse tokenmaxxing's index for one provider into Accounts. The only
    place either wire shape is understood. Raises when the file is
    unreadable, which the caller degrades on."""
    if provider == "anthropic":
        return _load_index_anthropic()
    if provider == "openai-codex":
        return _load_index_codex()
    raise ValueError(f"unknown provider {provider}")


def _read_index(path):
    idx = load_json(path)
    if not idx:
        raise RuntimeError(f"tokenmaxxing {os.path.basename(path)} unreadable")
    if idx.get("version") != TM_INDEX_VERSION:
        raise RuntimeError(f"tokenmaxxing {os.path.basename(path)} is schema v{idx.get('version')}; "
                           f"pi-pool reads v{TM_INDEX_VERSION} (tokenmaxxing >= 1.44)")
    return idx


def org_suffix(record):
    """The organization part of a label: its name, or "personal" for the
    organization Anthropic makes for every login ("<email>'s Organization")."""
    org = record.get("oauthAccount") or {}
    name = org.get("organizationName")
    email = record.get("email") or record.get("label")
    return "personal" if not name or name == f"{email}'s Organization" else name


def record_labels(records):
    """Display label per record id: the email, or `email (organization)` when
    more than one record has that email; the id prefix breaks a remaining tie."""
    emails = collections.Counter(r.get("email") or r["label"] for r in records)
    labels = {}
    for r in records:
        email = r.get("email") or r["label"]
        labels[r["id"]] = email if emails[email] == 1 else f"{email} ({org_suffix(r)})"
    shown = collections.Counter(labels.values())
    return {i: (f"{l} {i[:8]}" if shown[l] > 1 else l) for i, l in labels.items()}


def _load_index_anthropic():
    idx = _read_index(TM_ACCOUNTS)
    cfg, now, live = config(), time.time(), presence_account_ids(TM_LIVE)
    records = idx.get("accounts", [])
    labels = record_labels(records)
    out = []
    for a in records:
        five, seven = usage_pct(a, now)
        store = store_dir(a["id"])
        out.append(Account(
            provider="anthropic", id=a["id"], email=a.get("email") or a["label"], label=labels[a["id"]],
            needs_reauth=bool(a.get("needsReauth")), session_pct=five, weekly_pct=seven,
            gated_pct=gated_pct(a, cfg, now), is_live=a["id"] in live,
            cred=Keychain(store_service(store), store),
            tier=a.get("tier") or "", windows=tuple(a.get("windows") or ()),
            usage_at=(a.get("lastUsageAt") or 0) / 1000,
        ))
    return out


def _load_index_codex():
    idx = _read_index(TM_CODEX_ACCOUNTS)
    now, live = time.time(), presence_account_ids(TM_CODEX_LIVE)
    out = []
    for a in idx.get("accounts", []):
        session_pct, weekly_pct = usage_pct(a, now)
        out.append(Account(
            provider="openai-codex", id=a["id"], email=a.get("email") or a["label"],
            needs_reauth=bool(a.get("needsReauth")), session_pct=session_pct,
            weekly_pct=weekly_pct, gated_pct=0, is_live=a["id"] in live,
            cred=CredFile(os.path.join(TM_CODEX_STORES, a["id"][:8], "auth.json")),
            plan=(a.get("tier") or "").lower(), tier=a.get("tier") or "",
            windows=tuple(a.get("windows") or ()), usage_at=(a.get("lastUsageAt") or 0) / 1000,
        ))
    return out


def find_account(accounts, selector):
    """The account an id, a label, an email or a unique id prefix names; None
    when none does. An email two accounts share names neither: that exits
    with the labels and ids to choose from."""
    for match in (lambda a: a.id == selector, lambda a: a.label == selector):
        hit = next((a for a in accounts if match(a)), None)
        if hit:
            return hit
    hits = [a for a in accounts if a.email == selector]
    if len(hits) > 1:
        raise SystemExit(f"{selector} names {len(hits)} accounts; pick one by label or id: "
                         + ", ".join(f"{a.label} ({a.id})" for a in hits))
    if hits:
        return hits[0]
    hits = [a for a in accounts if a.id.startswith(selector)]
    return hits[0] if len(hits) == 1 else None


# ---------------------------------------------------------------- state.json
def empty_provider_state():
    return {"pin": None, "cooldowns": {}, "disabled": {}, "limits": {}, "admissions": {}}


def with_pool_state(accounts, state, provider):
    """Apply what state.json knows about each account and tokenmaxxing's index
    does not: `pi-pool off` and the provider's own 429 (`pi-pool limited`)."""
    prov = state["providers"][provider]
    off = prov.get("disabled") or {}
    limits = prov.get("limits") or {}
    out = []
    for a in accounts:
        if a.id in off:
            a = dataclasses.replace(a, disabled=True)
        if a.id in limits:
            a = dataclasses.replace(a, limited_until=limits[a.id]["until"])
        out.append(a)
    return out


def migrate(raw, by_email, now, pin_ttl=DEFAULTS["pin_ttl_sec"]):
    """v1 -> v2, pure and idempotent.

    v1 keyed assignments by "<pid>:<lstart>", which no session id can be
    recovered from, so they are dropped: they were a display cache and a vend
    counter, and the next request of each live session rebuilds them. The v1
    pin holds an email; it is resolved to an account id here, the one boundary
    that has the index in hand.

    A v2 file loses what no rule reads any more: the shared seat (ended
    2026-10-08), the lost 10-11 recovery pool's `recovery_batches` and the pins it
    wrote (`by: recovery:...`), a pin the owner set more than pin_ttl ago, and the
    `force` flag.
    """
    if raw.get("version") == 2:
        for provider in PROVIDERS:
            prov = raw.setdefault("providers", {}).setdefault(provider, empty_provider_state())
            prov.setdefault("limits", {})
            prov.setdefault("admissions", {})
            prov.pop("seat", None)
            prov.pop("recovery_batches", None)
        for rec in raw.setdefault("sessions", {}).values():
            pins = rec.get("pins") or {}
            for provider, pin in list(pins.items()):
                if (not pin or str(pin.get("by") or "").startswith("recovery:")
                        or now - (pin.get("at") or 0) > pin_ttl):
                    del pins[provider]
                else:
                    pin.pop("force", None)
        return raw
    anthropic = empty_provider_state()
    if raw.get("pin"):
        hit = by_email.get(raw["pin"])
        if hit:
            anthropic["pin"] = hit
        else:
            log("migrate_pin_dropped", email=raw["pin"])
    anthropic["cooldowns"] = {u: t for u, t in (raw.get("cooldowns") or {}).items() if t > now}
    out = {"version": 2, "providers": {"anthropic": anthropic,
                                       "openai-codex": empty_provider_state()}, "sessions": {}}
    log("migrated", dropped_assignments=len(raw.get("assignments") or {}))
    return out


def load_state():
    """Read state.json, migrate a v1 file, and back a v1 file up before the
    first v2 write. Call under the pool flock."""
    raw = load_json(STATE, {}) or {}
    by_email = {}
    if raw and raw.get("version") != 2:
        os.makedirs(os.path.join(POOL, "backups"), exist_ok=True)
        save_json(os.path.join(POOL, "backups", f"state.json.{int(time.time())}"), raw)
        try:
            by_email = {a.email: a.id for a in load_index("anthropic")}
        except Exception:
            by_email = {}
    return migrate(raw, by_email, time.time(), config()["pin_ttl_sec"])


# ---------------------------------------------------------------- the pure core
# The scheduler. One tree (a root session and every subagent under it) asks for an
# account on each provider request, and `decide` answers stay, admit or wait. Rules,
# first match wins:
#   R1 stay: the tree's own account still serves (no 429, every window under 100%,
#      credential ok), warm or cold. No move because of a cutoff, a better account,
#      a pin set earlier or another tree's move.
#   R2 admit cap: an account takes a tree that is not on it only under
#      admit_5h_max_pct (low trees: low_admit_5h_max_pct) of its 5h window and under
#      seven_day_max_pct of its week and its Fable cap.
#   R3 score: among admissible accounts the highest weekly pace x 5h headroom / load.
#   R4 admission slots: an account admits one tree per admit_slot_sec / slot_cap(a).
#   R5 wait: nothing passes R2-R4, so the tree gets its own slot_at on the account
#      that frees first, ordered by priority, then by wait start.
#   R6 move budget: a tree that moved max_moves_per_day[priority] times in 24 h
#      waits for its own account; a high tree is refused only optional moves.
#   R7 priority share: low trees enter only under low_admit_5h_max_pct; when one
#      account is left, the last cell of each slot window is for high trees.
PRIORITIES = ("high", "normal", "low")
PRIORITY_RANK = {p: i for i, p in enumerate(PRIORITIES)}
# The tree record the CLI and the hook keep per provider.
ADMISSION_KEEP_SEC = 1800
MOVE_WINDOW_SEC = 24 * 3600
# A wait whose slot passed this long ago with no request from the tree is dropped.
WAIT_STALE_SEC = 900
# How far ahead a slot is searched, in cells.
SLOT_SEARCH_CELLS = 5000


@dataclasses.dataclass(frozen=True)
class Tree:
    """What the scheduler knows about one session tree on one provider."""
    key: "str | None" = None
    # The account the tree was last vended, and when; None for a new tree.
    current: "str | None" = None
    current_at: float = 0
    # The owner's pin, and when it was set. A pin set after the tree's last vend
    # is pending: the next request applies it once.
    pin: "str | None" = None
    pin_at: float = 0
    pool_pin: "str | None" = None
    # The account `pi-pool switch` asked the tree to leave.
    leave: "str | None" = None
    priority: str = "normal"
    # Epoch seconds of the tree's moves in the last 24 h.
    moves: tuple = ()
    # (account id, slot_at, since) while the tree waits for a slot.
    wait: "tuple | None" = None


@dataclasses.dataclass(frozen=True)
class Book:
    """Who entered or will enter each account, as the slot rule reads it.
    `admitted`: {account id: ((at, tree key), ...)} over ADMISSION_KEEP_SEC.
    `waiting`: {account id: ((slot_at, tree key, rank), ...)} of the other trees.
    `load`: {account id: trees vended within active_session_sec}."""
    admitted: dict = dataclasses.field(default_factory=dict)
    waiting: dict = dataclasses.field(default_factory=dict)
    load: dict = dataclasses.field(default_factory=dict)


@dataclasses.dataclass(frozen=True)
class Stay:
    account: Account
    reason: str = "stay"
    shadowed: "tuple | None" = None
    # Open admissible accounts, best first, for a credential that fails.
    fallbacks: tuple = ()


@dataclasses.dataclass(frozen=True)
class Admit:
    account: Account
    # new | switch | back | session_pin | pool_pin | upgrade
    reason: str
    shadowed: "tuple | None" = None
    # (account id the tree left, why) on a move.
    left: "tuple | None" = None
    fallbacks: tuple = ()
    scores: tuple = ()


@dataclasses.dataclass(frozen=True)
class Wait:
    slot_at: float
    slot_account: Account
    # The account the hook vends meanwhile: the tree's own account when the
    # provider refuses it, so the request gets a 429 and writes no cache. None
    # when no such account exists: the hook then gives no token and the extension
    # turns that failure into a wait until slot_at.
    vend: "Account | None" = None
    shadowed: "tuple | None" = None
    left: "tuple | None" = None


def admit_cap(cfg, priority):
    """R2/R7: the 5h percentage under which an account takes a tree of this class."""
    return cfg["low_admit_5h_max_pct"] if priority == "low" else cfg["admit_5h_max_pct"]


def week_pct(a):
    return max(a.weekly_pct, 0 if a.gate_off else a.gated_pct)


def used_pct(a):
    """The fullest window that counts for this tree, 0-100."""
    return max(a.session_pct, week_pct(a))


def credential_reason(a, cooldowns, now):
    """Why the account fails every request whatever its usage, or None."""
    if a.disabled:
        return "disabled"
    if a.needs_reauth:
        return "needs-reauth"
    if cooldowns.get(a.id, 0) > now:
        return "cooldown"
    return None


def serve_reason(a, cooldowns, now):
    """R1: None while the provider still answers this account."""
    why = credential_reason(a, cooldowns, now)
    if why:
        return why
    if a.limited_until > now:
        return "limited"
    if used_pct(a) >= 100:
        return "depleted"
    return None


def admit_reason(a, cooldowns, cfg, now, priority="normal"):
    """R2: None when the account may take a tree that is not on it."""
    why = serve_reason(a, cooldowns, now)
    if why:
        return why
    if a.session_pct >= admit_cap(cfg, priority) or week_pct(a) >= cfg["seven_day_max_pct"]:
        return "depleted"
    if a.is_live and not cfg["allow_active_account"]:
        return "live-elsewhere"
    return None


def format_reason(a, cooldowns, cfg, now, priority="normal"):
    """admit_reason with a countdown, for a human or JSON row."""
    reason = admit_reason(a, cooldowns, cfg, now, priority)
    if reason == "cooldown":
        return f"cooldown {fmt_dur(max(60.0, cooldowns.get(a.id, now) - now))}"
    if reason == "limited":
        return f"limited {fmt_dur(max(60.0, a.limited_until - now))}"
    return reason


def window_reset_at(window):
    """When a window empties, epoch seconds; inf when nothing says."""
    if window.get("resetsAt") is not None:
        return window["resetsAt"] / 1000
    if window.get("windowSeconds") is not None:
        return (window.get("sampledAt") or 0) / 1000 + window["windowSeconds"]
    return float("inf")


def admissible_at(a, cooldowns, cfg, now, priority="normal"):
    """When the account passes R2 for this class again, epoch seconds; inf when
    no reset is known or its credential cannot serve."""
    if a.disabled or a.needs_reauth or (a.is_live and not cfg["allow_active_account"]):
        return float("inf")
    at = max(now, a.limited_until, cooldowns.get(a.id, 0))
    families = [f.lower() for f in cfg["switch_models"]]
    if not a.windows:
        if a.session_pct >= admit_cap(cfg, priority) or week_pct(a) >= cfg["seven_day_max_pct"]:
            return float("inf")
        return at
    for w in a.windows:
        name = w.get("name")
        if name is not None and (a.gate_off or not any(f in family_tokens(name) for f in families)):
            continue
        short = name is None and is_session_window(w)
        limit = admit_cap(cfg, priority) if short else cfg["seven_day_max_pct"]
        if live_pct(w, now) >= limit:
            at = max(at, window_reset_at(w))
    return at


def tier_units(a, cfg):
    """How many 'max 5x' plans the account is worth: max 20x 4, max 5x and team 1,
    pro 0.5. Codex plans and unknown tiers count 1."""
    if a.provider != "anthropic":
        return 1
    units = cfg["tier_units"]
    tier = (a.tier or "").lower()
    return units.get(tier, units.get(tier.split(" ")[0], 1)) if tier else 1


def slot_cap(a, cfg):
    """R4: trees the account admits per admit_slot_sec."""
    return max(1, round(cfg["admit_per_unit"] * tier_units(a, cfg)))


def slot_spacing(a, cfg):
    return cfg["admit_slot_sec"] / slot_cap(a, cfg)


def score(a, cfg, now, priority, load):
    """R3: weekly pace x 5h headroom / load. Weekly pace is the % per hour the
    account can spend before its week resets, so a week that resets soon with
    budget left is spent first and one far from its reset with little left is
    saved."""
    weekly = weekly_window({"windows": a.windows})
    left = reset_in(weekly, now) if weekly else None
    hours = left / 3600 if left else 168
    pace = max(0.0, cfg["seven_day_max_pct"] - week_pct(a)) / max(1.0, hours)
    cap = admit_cap(cfg, priority)
    headroom = max(0.0, cap - a.session_pct) / cap
    trees = load.get(a.id, 0) + 1 + int(a.is_live)
    return pace * headroom * tier_units(a, cfg) / trees


def tree_rank(tree, now):
    """R5/R7 order among waiters: priority, then wait start, then key."""
    return (PRIORITY_RANK.get(tree.priority, 1), tree.wait[2] if tree.wait else now, tree.key or "")


def cell_taken(a, cell, tree, rank, book, cfg):
    """A cell holds one tree: one admitted in it, or one waiting for it that ranks
    ahead of this tree. A lower-ranked waiter yields its cell and is given a later
    one on its next request."""
    sp = slot_spacing(a, cfg)
    if any(t != tree.key and int(at // sp) == cell for at, t in book.admitted.get(a.id, ())):
        return True
    return any(t != tree.key and int(at // sp) == cell and r < rank
               for at, t, r in book.waiting.get(a.id, ()))


def first_open(a, t0, tree, rank, book, cfg, sole):
    """The first time at or after t0 the account has a cell for this tree."""
    sp, cap = slot_spacing(a, cfg), slot_cap(a, cfg)
    cell = int(t0 // sp)
    for c in range(cell, cell + SLOT_SEARCH_CELLS):
        if sole and cap > 1 and tree.priority != "high" and c % cap == cap - 1:
            continue
        if not cell_taken(a, c, tree, rank, book, cfg):
            return max(t0, c * sp)
    return float("inf")


PLAN_TIERS = {"free": 0, "plus": 1, "pro": 2, "team": 3}


def plan_tier(a):
    """Codex plan rank. An account with no plan (every anthropic account, and a
    codex account whose planType we do not know) sits at the bottom, so the
    upgrade rule is a no-op for anthropic."""
    return PLAN_TIERS.get(a.plan, 0)


def decide(tree, accounts, book, cooldowns, cfg, now):
    """Stay, Admit or Wait for one request of one tree; None when no account can
    ever serve it. Pure: the caller writes what it decides under the pool flock,
    so trees that ask together see each other's admissions and waits."""
    by_id = {a.id: a for a in accounts}
    p = tree.priority if tree.priority in PRIORITY_RANK else "normal"
    rank = tree_rank(tree, now)
    cur = by_id.get(tree.current)
    load = book.load

    def why_not(a):
        return "missing" if a is None else admit_reason(a, cooldowns, cfg, now, p)

    admissible = [a for a in accounts if why_not(a) is None]
    sole = len(admissible) == 1
    # A higher codex plan comes first: the API refuses several models on a free
    # plan (2026-10-09 drill). Anthropic accounts carry no plan.
    ranked = sorted(admissible, key=lambda a: (-plan_tier(a), -score(a, cfg, now, p, load), a.label))
    scores = tuple((a.label, round(score(a, cfg, now, p, load), 2)) for a in ranked)

    def own_cell(a):
        """The tree's reservation on `a` is due and nobody ranked ahead took its cell."""
        if not tree.wait or tree.wait[0] != a.id or tree.wait[1] > now + 2:
            return False
        return not cell_taken(a, int(tree.wait[1] // slot_spacing(a, cfg)), tree, rank, book, cfg)

    def open_now(a):
        return own_cell(a) or first_open(a, now, tree, rank, book, cfg, sole) <= now

    def others(skip):
        return tuple(a for a in ranked if a.id != skip and open_now(a))

    cur_why = "missing" if tree.current and cur is None else (serve_reason(cur, cooldowns, now) if cur else None)
    left = (tree.current, cur_why) if tree.current else None
    shadowed = None

    pending = tree.pin and tree.pin != tree.current and tree.pin_at > tree.current_at
    if pending:
        a = by_id.get(tree.pin)
        why = why_not(a)
        if why is None and (p == "high" or open_now(a)):
            return Admit(a, "session_pin", None, left and (left[0], "pin"), others(a.id), scores)
        shadowed = (tree.pin, why or "busy")
    if tree.pool_pin and tree.pool_pin != tree.current:
        a = by_id.get(tree.pool_pin)
        why = why_not(a)
        if why is None and open_now(a):
            return Admit(a, "pool_pin", shadowed, left and (left[0], "pin"), others(a.id), scores)
        shadowed = shadowed or (tree.pool_pin, why or "busy")
    if cur_why and tree.current in (tree.pin, tree.pool_pin):
        shadowed = shadowed or (tree.current, cur_why)

    if cur_why is None and cur is not None and not tree.wait and tree.leave != cur.id:
        better = [a for a in ranked if plan_tier(a) > plan_tier(cur) and open_now(a)]
        if better:
            return Admit(better[0], "upgrade", shadowed, (cur.id, "plan"), others(better[0].id), scores)
        cold = now - tree.current_at >= cfg["cache_ttl_sec"]
        pin = by_id.get(tree.pin) if tree.pin and tree.pin != cur.id else None
        if cold and pin is not None and why_not(pin) is None and open_now(pin):
            return Admit(pin, "session_pin", shadowed, (cur.id, "pin"), others(pin.id), scores)
        return Stay(cur, "session_pin" if tree.pin == cur.id else "stay", shadowed, others(cur.id))

    # The tree enters an account: it is new, its account stopped serving, it was
    # asked to leave, or it waits for a slot.
    if left and cur_why is None:
        left = (tree.current, "asked" if tree.leave == tree.current else "waiting")
    optional = cur is not None and cur_why is None
    moved = sum(1 for t in tree.moves if now - t < MOVE_WINDOW_SEC)
    budget = cfg["max_moves_per_day"].get(p, cfg["max_moves_per_day"].get("normal", 3))
    own_ok = cur is not None and credential_reason(cur, cooldowns, now) is None
    stuck = own_ok and moved >= budget and (p != "high" or optional)
    # R6 holds only while the tree's own account frees within budget_wait_max_sec.
    # Past that the tree moves anyway: a stalled tree costs the owner the work, a
    # move costs one cache rewrite (about 0.5M tokens).
    if stuck and admissible_at(cur, cooldowns, cfg, now, p) - now > cfg["budget_wait_max_sec"]:
        stuck = False
        left = (tree.current, "budget_overrun")

    def leaving(a):
        return tree.leave is not None and a.id == tree.leave == tree.current

    def allowed(a):
        return not leaving(a) and (not stuck or a.id == tree.current)

    candidates = [a for a in ranked if allowed(a)]
    pin = next((a for a in candidates if a.id == tree.pin), None)
    if pin is not None:
        candidates = [pin] + [a for a in candidates if a.id != pin.id]
    for a in candidates:
        if open_now(a):
            reason = ("session_pin" if a.id == tree.pin else "back" if a.id == tree.current
                      else "switch" if tree.current else "new")
            return Admit(a, reason, shadowed, None if a.id == tree.current else left, others(a.id), scores)
    if tree.leave and cur is not None and tree.leave == cur.id and cur_why is None and not tree.wait:
        return Stay(cur, "stay", shadowed)

    frees = [(a, admissible_at(a, cooldowns, cfg, now, p)) for a in accounts
             if allowed(a) and not credential_reason(a, cooldowns, now)]
    frees = [(a, t0) for a, t0 in frees if t0 != float("inf")]
    options = []
    for a, t0 in frees:
        if tree.wait and tree.wait[0] == a.id and tree.wait[1] >= t0 and not cell_taken(
                a, int(tree.wait[1] // slot_spacing(a, cfg)), tree, rank, book, cfg):
            t = max(tree.wait[1], now)
        else:
            t = first_open(a, t0, tree, rank, book, cfg, len(frees) == 1)
        options.append((t, -score(a, cfg, t, p, load), a.label, a))
    if not options:
        return None
    slot_at, _, _, slot_account = min(options, key=lambda o: o[:3])
    if slot_at == float("inf"):
        return None
    vend = cur if own_ok and cur_why is not None else None
    return Wait(slot_at, slot_account, vend, shadowed, left)


def in_use_counts(state, provider, now=None, window_sec=None):
    """Trees vended each account within active_session_sec: the load in R3.
    A session record lives for pin_ttl_sec (a week) after its last request, and
    counting those idle records charged an account for sessions that ended days ago."""
    now = time.time() if now is None else now
    window_sec = config()["active_session_sec"] if window_sec is None else window_sec
    counts = {}
    for rec in state["sessions"].values():
        vend = (rec.get("vends") or {}).get(provider)
        if vend and now - (vend.get("at") or 0) <= window_sec:
            counts[vend["account_id"]] = counts.get(vend["account_id"], 0) + 1
    return counts


def tree_for(state, key, provider):
    """Project state.json down to the facts `decide` reads for one tree."""
    prov = state["providers"].get(provider) or empty_provider_state()
    rec = (state["sessions"].get(key.key) if key else None) or {}
    pin = (rec.get("pins") or {}).get(provider) or {}
    last = (rec.get("vends") or {}).get(provider) or {}
    wait = (rec.get("wait") or {}).get(provider)
    return Tree(key=key.key if key else None,
                current=last.get("account_id"), current_at=last.get("at") or 0,
                pin=pin.get("account_id"), pin_at=pin.get("at") or 0, pool_pin=prov.get("pin"),
                leave=((rec.get("leave") or {}).get(provider) or {}).get("account_id"),
                priority=rec.get("priority") or "normal",
                moves=tuple((rec.get("moves") or {}).get(provider) or ()),
                wait=(wait["account"], wait["slot_at"], wait["since"]) if wait else None)


def book_for(state, provider, key, cfg, now):
    """The admissions and waits of every tree on this provider but `key`'s own."""
    prov = state["providers"].get(provider) or empty_provider_state()
    admitted = {a: tuple((at, t) for at, t in entries if now - at <= ADMISSION_KEEP_SEC)
                for a, entries in (prov.get("admissions") or {}).items()}
    waiting = {}
    for k, rec in state["sessions"].items():
        wait = (rec.get("wait") or {}).get(provider)
        if not wait or (key and k == key.key):
            continue
        rank = (PRIORITY_RANK.get(rec.get("priority") or "normal", 1), wait["since"], k)
        waiting.setdefault(wait["account"], []).append((wait["slot_at"], k, rank))
    return Book(admitted, {a: tuple(v) for a, v in waiting.items()},
                in_use_counts(state, provider, now, cfg["active_session_sec"]))


class HookWriter:
    """The hook's mutation surface on state.json: vends, admissions, waits,
    cooldowns and limits. It never writes a pin. `pi-pool limited` and `refused`
    write through it too, because they record what the provider answered."""

    def __init__(self, state):
        self._state = state

    def _rec(self, key, now):
        rec = self._state["sessions"].setdefault(key.key, {})
        rec.setdefault("uuid", key.uuid)
        rec.setdefault("active_id", key.active_id)
        rec.setdefault("pins", {})
        rec.setdefault("last_seen", now)
        return rec

    def record_vend(self, key, provider, account, source, reason, shadowed, now, parent, moved=False):
        """`parent` is (pid, start) of the calling process, read before the flock.
        A vend ends the tree's wait; `moved` adds one move to its 24 h budget."""
        rec = self._rec(key, now)
        rec["uuid"], rec["active_id"] = key.uuid, key.active_id
        rec["pid"], rec["pid_start"] = parent
        rec["last_seen"] = now
        prev = (rec.setdefault("vends", {})).get(provider) or {}
        same = prev.get("account_id") == account.id
        rec["vends"][provider] = {
            "account_id": account.id, "email": account.label, "source": source,
            "reason": reason, "shadowed": list(shadowed) if shadowed else None,
            "at": now, "n": (prev.get("n", 0) + 1) if same else 1,
            # since when the tree has been on this account: a 429 from a request sent
            # before it belongs to the account the tree had then (cmd_limited --since)
            "from": prev.get("from", prev.get("at", now)) if same else now,
        }
        (rec.get("wait") or {}).pop(provider, None)
        if moved:
            rec.setdefault("moves", {}).setdefault(provider, []).append(now)
        return rec["vends"][provider]

    def admit(self, key, provider, account_id, now):
        """R4: one tree entered `account_id` now; its cell is taken."""
        entries = self._state["providers"][provider].setdefault("admissions", {}).setdefault(account_id, [])
        entries.append([now, key.key if key else None])

    def set_wait(self, key, provider, account_id, slot_at, now):
        """R5: the tree waits for its slot on `account_id`. Its wait start stays
        the first one, so a tree keeps its place in the queue."""
        rec = self._rec(key, now)
        waits = rec.setdefault("wait", {})
        since = (waits.get(provider) or {}).get("since", now)
        waits[provider] = {"account": account_id, "slot_at": slot_at, "since": since}

    def set_cooldown(self, provider, account_id, until, reason=None):
        prov = self._state["providers"][provider]
        prov["cooldowns"][account_id] = until
        if reason:
            prov.setdefault("cooldown_reasons", {})[account_id] = reason

    def set_limit(self, provider, account_id, until, key, now):
        """The provider answered 429 for this account until `until`. Several
        sessions can report one limit; the latest reset wins."""
        limits = self._state["providers"][provider].setdefault("limits", {})
        prev = limits.get(account_id) or {}
        limits[account_id] = {"until": max(until, prev.get("until", 0)), "at": now,
                              "session": key.key if key else None}

    def prune(self, cfg, now):
        """Drop expired cooldowns and limits, admissions older than
        ADMISSION_KEEP_SEC, moves older than a day, waits whose slot passed
        WAIT_STALE_SEC ago, and sessions that have not vended for pin_ttl_sec.
        Returns whether anything changed, so a request that prunes nothing does
        not rewrite the file. Liveness is NOT a pid test: a session resumed in a
        new worker keeps its pin, which is the whole point of keying by uuid."""
        dropped = 0
        for provider in PROVIDERS:
            prov = self._state["providers"][provider]
            cd = prov["cooldowns"]
            reasons = prov.get("cooldown_reasons") or {}
            for account_id in [u for u, t in cd.items() if t <= now]:
                del cd[account_id]
                dropped += 1
            for account_id in [u for u in reasons if u not in cd]:
                del reasons[account_id]
                dropped += 1
            limits = prov.get("limits") or {}
            for account_id in [u for u, rec in limits.items() if rec["until"] <= now]:
                del limits[account_id]
                dropped += 1
            admissions = prov.get("admissions") or {}
            for account_id, entries in list(admissions.items()):
                kept = [e for e in entries if now - e[0] <= ADMISSION_KEEP_SEC]
                if len(kept) != len(entries):
                    dropped += 1
                    if kept:
                        admissions[account_id] = kept
                    else:
                        del admissions[account_id]
        ttl = cfg["pin_ttl_sec"]
        for key in list(self._state["sessions"]):
            rec = self._state["sessions"][key]
            last = max([rec.get("last_seen") or 0]
                       + [(p or {}).get("at", 0) for p in (rec.get("pins") or {}).values()])
            if now - last > ttl:
                del self._state["sessions"][key]
                dropped += 1
                continue
            waits = rec.get("wait") or {}
            for provider in [p for p, w in waits.items() if w["slot_at"] < now - WAIT_STALE_SEC]:
                del waits[provider]
                dropped += 1
            moves = rec.get("moves") or {}
            for provider, times in list(moves.items()):
                kept = [t for t in times if now - t < MOVE_WINDOW_SEC]
                if len(kept) != len(times):
                    dropped += 1
                    if kept:
                        moves[provider] = kept
                    else:
                        del moves[provider]
        return dropped > 0


class IntentWriter:
    """`pi-pool use` / `pin` / `unpin` / `switch` / `priority`. It never writes a vend."""

    def __init__(self, state):
        self._state = state

    def _rec(self, key, now):
        rec = self._state["sessions"].setdefault(key.key, {})
        rec["uuid"], rec["active_id"] = key.uuid, key.active_id
        rec.setdefault("vends", {})
        rec.setdefault("last_seen", now)
        return rec

    def set_pin(self, key, provider, account_id, by, now):
        self._rec(key, now).setdefault("pins", {})[provider] = {"account_id": account_id, "at": now, "by": by}

    def set_priority(self, key, priority, now):
        """R7: the tree's class. A tree with no record yet (a thread made a moment
        ago) gets one, so its first request already counts as this class."""
        self._rec(key, now)["priority"] = priority


    def clear_pin(self, key, provider):
        rec = self._state["sessions"].get(key.key)
        if rec:
            (rec.get("pins") or {}).pop(provider, None)

    def set_pool_pin(self, provider, account_id):
        self._state["providers"][provider]["pin"] = account_id

    def clear_pool_pin(self, provider):
        self._state["providers"][provider]["pin"] = None

    def leave(self, key, provider, account_id, now):
        """`pi-pool switch`: the session's next request moves off `account_id`.
        Inert once the session is on another account, so nothing clears it."""
        rec = self._state["sessions"].setdefault(key.key, {})
        rec["uuid"], rec["active_id"] = key.uuid, key.active_id
        rec.setdefault("vends", {})
        rec.setdefault("last_seen", now)
        rec.setdefault("leave", {})[provider] = {"account_id": account_id, "at": now}

    def set_disabled(self, provider, account_id, off, now):
        disabled = self._state["providers"][provider].setdefault("disabled", {})
        if off:
            disabled.setdefault(account_id, now)
        else:
            disabled.pop(account_id, None)

    def forget_account(self, provider, account_id):
        """Drop every intent that names an account tokenmaxxing no longer has.
        Vends are the hook's records and stay; the next request rewrites them."""
        prov = self._state["providers"][provider]
        if prov.get("pin") == account_id:
            prov["pin"] = None
        for key in ("disabled", "cooldowns", "cooldown_reasons", "limits", "admissions"):
            (prov.get(key) or {}).pop(account_id, None)
        for rec in self._state["sessions"].values():
            pins = rec.get("pins") or {}
            if (pins.get(provider) or {}).get("account_id") == account_id:
                del pins[provider]
            waits = rec.get("wait") or {}
            if (waits.get(provider) or {}).get("account") == account_id:
                del waits[provider]


# ----------------------------------------------------------------- credentials
def credential_for_keychain(a, cfg):
    """(access_token, source) from the account's tokenmaxxing store.

    Supervised claude sessions share the same store and refresh it themselves,
    so a refresh here takes tokenmaxxing's pool flock and Claude Code's own
    refresh lock on the store, then re-reads before rotating."""
    service, store = a.cred.service, a.cred.store
    adapter = KeychainAdapter(service)
    creds = adapter.read()
    if not creds:
        raise RuntimeError(f"no credential in {a.label}'s store; run `pi-pool login {a.id}`")
    if not creds.get("accessToken") or not creds.get("refreshToken"):
        raise RuntimeError(f"{a.label}'s store was cleared after a failed refresh (needs reauth)")
    remaining = (creds["expiresAt"] - time.time() * 1000) / 1000
    if remaining > cfg["refresh_skew_sec"]:
        return creds["accessToken"], "store"

    with Flock(TM_LOCK, timeout=TM_LOCK_TIMEOUT), ClaudeRefreshLock(store):
        creds2 = recover_rotation(service, adapter)
        if (creds2["expiresAt"] - time.time() * 1000) / 1000 > cfg["refresh_skew_sec"]:
            return creds2["accessToken"], "store"
        try:
            merged = refresh_token(creds2)
        except RuntimeError as e:
            if str(e).startswith("invalid_grant"):
                mark_needs_reauth(TM_ACCOUNTS, a.id)
            raise
        # A refresh rotates the grant server-side the instant it returns: journal
        # it BEFORE the keychain write, or a crash in between strands the account
        # on a superseded refresh token that neither pi nor Claude Code can use.
        journal_write(service, merged)
        adapter.write(merged)
        journal_clear(service)
        log("refreshed", account=a.label, provider="anthropic",
            expires_in_h=round((merged["expiresAt"] - time.time() * 1000) / 3600000, 2))
        return merged["accessToken"], "refreshed"


def credential_for_codex(a, cfg):
    """(access_token, source) from the account's codex-stores/<uuid8>/auth.json.
    Never refreshes a store a supervised codex session is running on: the codex
    CLI holds that grant and a rotation here would revoke it."""
    adapter = CodexFileAdapter(a.cred.path)
    store_key = "codex-" + a.id[:8]
    blob = adapter.read()
    if not blob or not (blob.get("tokens") or {}).get("access_token"):
        raise RuntimeError(f"no credential in {a.label}'s codex store; run `pi-pool login {a.id} --provider openai-codex`")
    token = blob["tokens"]["access_token"]
    if jwt_claims(token)["exp"] - time.time() > cfg["refresh_skew_sec"]:
        assert_codex_identity(token, a.id)
        return token, "store"
    if a.is_live:
        raise RuntimeError("codex store expiring while a codex session runs on it; leaving rotation to the codex CLI")

    with Flock(TM_CODEX_LOCK, timeout=TM_LOCK_TIMEOUT):
        blob = recover_rotation(store_key, adapter)
        token = blob["tokens"]["access_token"]
        if jwt_claims(token)["exp"] - time.time() > cfg["refresh_skew_sec"]:
            assert_codex_identity(token, a.id)
            return token, "store"
        try:
            fresh = refresh_codex_token(blob["tokens"]["refresh_token"])
        except RuntimeError as e:
            if str(e).startswith("refresh_token_reused"):
                mark_needs_reauth(TM_CODEX_ACCOUNTS, a.id)
            raise
        merged = merge_codex_tokens(blob, fresh)
        journal_write(store_key, merged)
        adapter.write(merged)
        journal_clear(store_key)
        token = merged["tokens"]["access_token"]
        assert_codex_identity(token, a.id)
        log("refreshed", account=a.label, provider="openai-codex",
            expires_in_h=round((jwt_claims(token)["exp"] - time.time()) / 3600, 2))
        return token, "refreshed"


def credential_for(a, cfg):
    if isinstance(a.cred, Keychain):
        return credential_for_keychain(a, cfg)
    if isinstance(a.cred, CredFile):
        return credential_for_codex(a, cfg)
    raise RuntimeError(f"unknown credential kind for {a.id}")


def agent_dir():
    return os.environ.get("PRIME_AGENT_CODING_AGENT_DIR") or os.path.join(HOME, ".prime", "agent")


def load_fallback():
    fb = load_json(FALLBACK) or {}
    # The first fallback.json held one bare anthropic credential.
    return {"anthropic": fb} if fb and "type" in fb else fb


def fallback_token(provider, cfg):
    """The user's own OAuth login for `provider`, adopted out of Prime's
    auth.json (see adopt-logins). Used only when no pooled account can serve.
    It is an independent grant family, so refreshing it never touches a store."""
    with Flock(os.path.join(POOL, "fallback.lock"), timeout=TM_LOCK_TIMEOUT):
        fb = load_fallback()
        creds = fb.get(provider)
        if not creds or creds.get("type") != "oauth":
            return None
        if (creds["expires"] - time.time() * 1000) / 1000 > cfg["refresh_skew_sec"]:
            return creds["access"]
        if provider == "anthropic":
            fresh = refresh_token({"refreshToken": creds["refresh"], "scopes": creds.get("scopes")})
            creds = dict(creds, access=fresh["accessToken"], refresh=fresh["refreshToken"],
                         expires=fresh["expiresAt"])
        else:
            fresh = refresh_codex_token(creds["refresh"])
            creds = dict(creds, access=fresh["access_token"],
                         refresh=fresh.get("refresh_token") or creds["refresh"],
                         expires=jwt_claims(fresh["access_token"])["exp"] * 1000)
        fb[provider] = creds
        save_json(FALLBACK, fb)
        log("fallback_refreshed", provider=provider)
        return creds["access"]


class AuthJsonLock:
    """Prime's own lock on auth.json: proper-lockfile's `<file>.lock` directory,
    stale after 30s, the lock AuthStorage.withLockAsync takes before a write."""

    STALE_SEC = 30.0

    def __init__(self, path, timeout=5.0):
        self.dir, self.timeout = path + ".lock", timeout

    def __enter__(self):
        deadline = time.time() + self.timeout
        while True:
            try:
                os.mkdir(self.dir)
                return self
            except FileExistsError:
                try:
                    if time.time() - os.stat(self.dir).st_mtime > self.STALE_SEC:
                        os.rmdir(self.dir)
                        continue
                except OSError:
                    continue
            if time.time() >= deadline:
                raise TimeoutError(f"{self.dir} is held")
            time.sleep(0.1)

    def __exit__(self, *exc):
        try:
            os.rmdir(self.dir)
        except OSError:
            pass
        return False


def pooled_providers():
    """Providers whose models.json apiKey is this pool's hook."""
    providers = (load_json(os.path.join(agent_dir(), "models.json"), {}) or {}).get("providers") or {}
    return [p for p in PROVIDERS
            if isinstance((providers.get(p) or {}).get("apiKey"), str)
            and providers[p]["apiKey"].startswith("!") and "pi-pool" in providers[p]["apiKey"]]


def cmd_adopt_logins(rest=()):
    """Prime reads auth.json before the models.json hook, so a stored /login for a
    pooled provider silently bypasses the pool. Move each such login into
    fallback.json, where it still serves when the whole pool cannot."""
    auth_path = os.path.join(agent_dir(), "auth.json")
    wanted = pooled_providers()
    if not wanted or not os.path.exists(auth_path):
        return 0
    moved = []
    with AuthJsonLock(auth_path):
        auth = load_json(auth_path)
        if not isinstance(auth, dict):
            return 0
        hits = [p for p in wanted if p in auth]
        if not hits:
            return 0
        with Flock(os.path.join(POOL, "fallback.lock"), timeout=TM_LOCK_TIMEOUT):
            fb = load_fallback()
            stamp = time.strftime("%Y%m%d-%H%M%S")
            os.makedirs(os.path.join(POOL, "backups"), mode=0o700, exist_ok=True)
            for p in hits:
                if fb.get(p):
                    save_json(os.path.join(POOL, "backups", f"fallback.{p}.{stamp}.json"), fb[p])
                fb[p] = auth.pop(p)
                moved.append(p)
            save_json(FALLBACK, fb)
        save_json(auth_path, auth)
    log("adopted_logins", providers=moved)
    print(f"moved the stored {', '.join(moved)} login into the pool fallback; the pool now serves "
          f"{'these providers' if len(moved) > 1 else 'this provider'}")
    return 0


def apply_refusal(provider, account, refusal, cfg, now):
    """Cool an API-refused account down in the pool, and an anthropic one in
    tokenmaxxing too."""
    until = now + cfg["refused_cooldown_sec"]
    with Flock(LOCK, timeout=STATE_LOCK_TIMEOUT):
        state = load_state()
        HookWriter(state).set_cooldown(provider, account.id, until, refusal)
        save_json(STATE, state)
    if provider != "anthropic":
        return
    try:
        mark_refused(account.id, until)
    except Exception as e:
        log("mark_refused_failed", account=account.label, error=str(e))


def cmd_probe(rest=()):
    """Probe every anthropic account with a still-valid access token for an
    API refusal, at most once per probe_interval_sec unless --force. Never
    refreshes a token, so it rotates nothing. The extension runs this at session
    start, which is how a refusal is found before any request lands on it."""
    cfg, now = config(), time.time()
    with Flock(LOCK, timeout=STATE_LOCK_TIMEOUT):
        state = load_state()
        prov = state["providers"]["anthropic"]
        if "--force" not in rest and now - (prov.get("last_probe") or 0) < cfg["probe_interval_sec"]:
            return 0
        prov["last_probe"] = now
        save_json(STATE, state)
    reasons = prov.get("cooldown_reasons") or {}
    lines = []
    for a in load_index("anthropic"):
        if a.needs_reauth:
            continue
        try:
            creds = KeychainAdapter(a.cred.service).read()
        except Exception:
            continue
        if not creds or (creds.get("expiresAt") or 0) / 1000 - now < 60:
            continue
        # Only a message shows whether the terms were accepted since.
        refusal = anthropic_refusal(creds["accessToken"], infer=reasons.get(a.id) == NEEDS_TERMS)
        if refusal:
            apply_refusal("anthropic", a, refusal, cfg, now)
            lines.append(f"{a.label}: {refusal}")
        elif a.id in reasons:
            with Flock(LOCK, timeout=STATE_LOCK_TIMEOUT):
                state = load_state()
                p = state["providers"]["anthropic"]
                p["cooldowns"].pop(a.id, None)
                (p.get("cooldown_reasons") or {}).pop(a.id, None)
                save_json(STATE, state)
            lines.append(f"{a.label}: accepted again")
    log("probe", results=lines)
    if lines:
        print("; ".join(lines))
    return 0


# ---------------------------------------------------------------------- vend
def switch_why(d, account):
    """Why a tree left its account, for the switch log line."""
    if account.id != d.account.id:
        return "credential"
    if getattr(d, "left", None):
        return d.left[1]
    if d.reason in ("session_pin", "pool_pin"):
        return "pin"
    return d.reason


def iso(epoch):
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(epoch))


def last_vend_account(state, key, provider, accounts, now):
    """The account this session was last vended, for a request that cannot take
    the pool flock. None when the session has no vend on file, or that account
    is off, needs reauth, is cooling down after a refusal, or holds the
    provider's 429."""
    if key is None or state.get("version") != 2:
        return None
    last = (((state.get("sessions") or {}).get(key.key) or {}).get("vends") or {}).get(provider)
    prov = (state.get("providers") or {}).get(provider)
    if not last or not prov:
        return None
    account = next((a for a in with_pool_state(accounts, state, provider) if a.id == last["account_id"]), None)
    if account is None or account.disabled or account.needs_reauth or account.limited_until > now:
        return None
    if (prov.get("cooldowns") or {}).get(account.id, 0) > now:
        return None
    return account


def schedule(state, key, provider, accounts, cfg, now, admit_now=True):
    """Run `decide` for this tree and write what it takes, under the pool flock
    the caller holds: an admission takes its cell, a wait its slot. With
    `admit_now` false (`pi-pool limited` and `refused`, whose retry vends a second
    later) an admission is held as a wait due now. Returns the decision, the tree
    and whether state changed."""
    accounts = with_pool_state(accounts, state, provider)
    accounts = with_models(accounts, session_models(state, key, provider, cfg, now), cfg)
    tree = tree_for(state, key, provider)
    cooldowns = dict(state["providers"][provider]["cooldowns"])
    d = decide(tree, accounts, book_for(state, provider, key, cfg, now), cooldowns, cfg, now)
    writer = HookWriter(state)
    if key is None or d is None:
        return d, tree, False
    if isinstance(d, Admit) and admit_now:
        writer.admit(key, provider, d.account.id, now)
        return d, tree, True
    if isinstance(d, Admit):
        writer.set_wait(key, provider, d.account.id, now, now)
        return d, tree, True
    if isinstance(d, Wait) and (tree.wait is None or tree.wait[:2] != (d.slot_account.id, d.slot_at)):
        writer.set_wait(key, provider, d.slot_account.id, d.slot_at, now)
        log("wait", provider=provider, session=key.key, account=d.slot_account.label,
            slot_at=iso(d.slot_at), priority=tree.priority, vend=d.vend and d.vend.label,
            left=d.left and d.left[1])
        return d, tree, True
    return d, tree, False


def vend(provider):
    """Decide one account for this session tree and write its access token to
    stdout. stdout is the token and nothing else; every other byte goes to
    the log.

    Lock discipline: take the pool flock to read, prune, decide and write the
    admission or wait, release it, fetch or refresh the credential under
    tokenmaxxing's own lock, then re-take the pool flock to record the vend. The
    pool flock is never held across a refresh, so `pi-pool use` never queues
    behind one. When the flock stays busy past STATE_LOCK_TIMEOUT, the tree keeps
    the account it was last vended, if that account can still serve.

    A tree that waits gets its own account while the provider refuses it, so the
    request comes back as a 429 that writes no cache and `pi-pool limited` hands
    the extension the slot time. With no such account the hook exits non-zero
    with no token, and the extension turns that failure into the same wait.
    """
    cfg = config()
    accounts = load_index(provider)
    key = session_key()
    parent_pid = os.getppid()
    parent = (parent_pid, (proc_info(parent_pid) or {}).get("start")) if key else None

    try:
        with Flock(LOCK, timeout=STATE_LOCK_TIMEOUT):
            state = load_state()
            now = time.time()
            pruned = HookWriter(state).prune(cfg, now)
            d, tree, wrote = schedule(state, key, provider, accounts, cfg, now)
            if pruned or wrote:
                save_json(STATE, state)
    except TimeoutError:
        # save_json replaces state.json in one rename, so an unlocked read sees a whole file.
        account = last_vend_account(load_json(STATE, {}) or {}, key, provider, accounts, time.time())
        if account is None:
            raise
        token, source = credential_for(account, cfg)
        log("vend_lock_busy", provider=provider, account=account.label, source=source, session=key.key)
        sys.stdout.write(token)
        return

    if d is None:
        raise RuntimeError(f"no {provider} account can serve this session")
    if isinstance(d, Wait):
        if d.vend is not None:
            try:
                token, _ = credential_for(d.vend, cfg)
            except Exception as e:
                log("account_unusable", provider=provider, account=d.vend.label, error=str(e))
            else:
                sys.stdout.write(token)
                return
        raise SystemExit(f"pi-pool: this session waits for a slot on {d.slot_account.label} "
                         f"at {iso(d.slot_at)}")

    order = [d.account] + list(d.fallbacks)
    errors = []
    for account in order:
        try:
            token, source = credential_for(account, cfg)
        except Exception as e:
            errors.append(f"{account.label}: {e}")
            log("account_unusable", provider=provider, account=account.label, error=str(e))
            continue
        reason = d.reason if account.id == d.account.id else ("switch" if tree.current else "new")
        entering = account.id != tree.current
        # Entering an account is rare (hours apart per tree), so it can afford one
        # no-spend probe; that is where an organization-level OAuth refusal shows
        # up, which usage figures and needsReauth never reflect.
        if provider == "anthropic" and (source == "refreshed" or entering):
            refusal = anthropic_refusal(token)
            if refusal:
                errors.append(f"{account.label}: {refusal}")
                log("account_refused", provider=provider, account=account.label, error=refusal)
                apply_refusal(provider, account, refusal, cfg, now)
                continue
        prev = vended = None
        try:
            with Flock(LOCK, timeout=STATE_LOCK_TIMEOUT):
                state = load_state()
                writer = HookWriter(state)
                prev = ((state["sessions"].get(key.key) or {}).get("vends") or {}).get(provider) if key else None
                if key and account.id != d.account.id:
                    writer.admit(key, provider, account.id, now)
                vended = writer.record_vend(key, provider, account, source, reason, d.shadowed, now, parent,
                                            moved=entering and tree.current is not None) if key else None
                save_json(STATE, state)
        except TimeoutError:
            # The token is valid; a vend left off the record only skews the next decision.
            log("vend_unrecorded", provider=provider, account=account.label, session=key and key.key)
        # The hook runs on every provider request, so a line per vend would be a log of
        # thousands. Log the transitions only: a tree entering an account.
        # `why` says why the pin in `shadowed` did not serve (depleted, limited, busy, ...).
        if vended is None or vended["n"] == 1:
            log("vend", provider=provider, account=account.label, source=source,
                reason=reason, shadowed=d.shadowed and d.shadowed[0],
                why=d.shadowed and d.shadowed[1],
                previous=(prev or {}).get("email"), session=key and key.key)
        if prev and prev.get("account_id") != account.id:
            # One line per move of one tree: `pi-pool status` and the chat
            # health review count these.
            log("switch", provider=provider, session=key.key, previous=prev.get("email"),
                account=account.label, reason=reason, why=switch_why(d, account),
                scores=dict(getattr(d, "scores", ())[:6]))
        sys.stdout.write(token)
        return

    raise RuntimeError("no usable account; " + "; ".join(errors))


# ------------------------------------------------------------------------ CLI
def parse_flags(rest, provider_default="anthropic"):
    provider, session, as_json, force, follow, new_session, positional = provider_default, None, False, False, False, False, []
    model, source, clear, until, since = None, None, False, None, None
    i = 0
    while i < len(rest):
        tok = rest[i]
        if tok == "--provider":
            i += 1
            provider = rest[i]
        elif tok == "--session":
            i += 1
            session = rest[i]
        elif tok == "--json":
            as_json = True
        elif tok == "--force":
            force = True
        elif tok == "--follow":
            follow = True
        elif tok == "--new-session":
            new_session = True
        elif tok == "--model":
            i += 1
            model = rest[i]
        elif tok == "--source":
            i += 1
            source = rest[i]
        elif tok == "--clear":
            clear = True
        elif tok == "--until":
            i += 1
            until = float(rest[i])
        elif tok == "--since":
            i += 1
            since = float(rest[i])
        else:
            positional.append(tok)
        i += 1
    return {"provider": provider, "session": session, "json": as_json,
            "force": force, "follow": follow, "new_session": new_session, "positional": positional,
            "model": model, "source": source, "clear": clear, "until": until, "since": since}


def session_key_for(session_arg, state):
    if session_arg is None:
        return session_key()
    match = resolve_session_arg(session_arg, state)
    if match:
        return match
    # /account names the session it is running in, which has no record until its
    # first vend. This process inherits that session's env, so derive the key the
    # hook will use instead of refusing a session that is plainly here.
    here = session_key()
    if here and session_arg in (here.key, here.uuid, here.active_id):
        return here
    return None


def build_rows(accounts, tree, book, cooldowns, cfg, now, cooldown_reasons=None):
    """The rows /account and Settings > Accounts render, for one tree. Pure: no
    I/O, no clock reads beyond `now`. `usable` means the account takes this tree
    now (R2); `serves` means a tree already on it keeps it (R1); `score` is R3,
    null when the account cannot take the tree."""
    cooldown_reasons = cooldown_reasons or {}
    p = tree.priority
    rows = []
    for a in accounts:
        reason = format_reason(a, cooldowns, cfg, now, p)
        row = {
            "id": a.id, "email": a.email, "label": a.label,
            "usage": f"{a.session_pct}%/{a.weekly_pct}%",
            "session_pct": a.session_pct, "weekly_pct": a.weekly_pct, "gated_pct": a.gated_pct,
            "usable": reason is None, "serves": serve_reason(a, cooldowns, now) is None, "reason": reason,
            "current": a.id == tree.current, "pinned": a.id in (tree.pin, tree.pool_pin),
            # user-history's parsePoolRows requires a boolean `seat`; false until it drops the field.
            "live": a.is_live, "seat": False, "disabled": a.disabled,
            "score": round(score(a, cfg, now, p, book.load), 2) if reason is None else None,
            "slot_cap": slot_cap(a, cfg),
        }
        if a.plan:
            row["plan"] = a.plan
        cooling = cooldowns.get(a.id, 0) > now
        limited = a.limited_until > now
        row.update({
            "tier": a.tier or None,
            "windows": usage_windows(a, now),
            "usage_at": round(a.usage_at) if a.usage_at else None,
            "usage_age_sec": max(0, round(now - a.usage_at)) if a.usage_at else None,
            "sessions": book.load.get(a.id, 0),
            "admitted_recently": sum(1 for at, _ in book.admitted.get(a.id, ()) if now - at <= cfg["admit_slot_sec"]),
            "waiting": len(book.waiting.get(a.id, ())),
            "cooldown_until": round(cooldowns[a.id]) if cooling else None,
            "cooldown_reason": cooldown_reasons.get(a.id) if cooling else None,
            "limited_until": round(a.limited_until) if limited else None,
        })
        rows.append(row)
    return rows


# ------------------------------------------------------------------ rendering
# `status` and `watch` draw one card per account in a grid, the same layout as
# `tokenmaxxing status`, plus what only the pool knows: pins, the
# sessions on each account, cooldowns, waiters, and each account's score.
ANSI_RE = re.compile(r"\x1b\[[0-9;]*m")
CARD_GAP = 3
NOTE_INDENT = "    "
BAR_WIDTH = 16
STALE_USAGE_SEC = 20 * 60
PROVIDER_TITLES = {"anthropic": "claude", "openai-codex": "codex"}


class Paint:
    def __init__(self, enabled):
        self.enabled = enabled

    def _wrap(self, code, s):
        return f"\x1b[{code}m{s}\x1b[0m" if self.enabled else s

    def dim(self, s): return self._wrap("2", s)
    def bold(self, s): return self._wrap("1", s)
    def green(self, s): return self._wrap("32", s)
    def yellow(self, s): return self._wrap("33", s)
    def red(self, s): return self._wrap("31", s)
    def cyan(self, s): return self._wrap("36", s)


def visible_len(s):
    return len(ANSI_RE.sub("", s))


def usage_bar(p, pct):
    pct = max(0, min(100, pct))
    filled = round(pct / 100 * BAR_WIDTH)
    body = "\u2588" * filled + "\u2591" * (BAR_WIDTH - filled)
    paint = p.red if pct >= 95 else p.yellow if pct >= 75 else p.green
    return f"{paint(body)} {pct:3.0f}%"


def fmt_ago(sec):
    return "just now" if sec < 60 else f"{fmt_dur(sec)} ago"


def usage_windows(a, now):
    """Every usage window of one account, in display order: the session window,
    the weekly window, then each named per-model cap (Fable, Sonnet, a codex
    additional limit). pct is the live figure, so a passed reset reads 0 with
    no reset time."""
    session, weekly = session_window(dict(windows=a.windows)), weekly_window(dict(windows=a.windows))
    picked = [("session", session)] if session else []
    picked += [("weekly", weekly)] if weekly else []
    picked += [("model", w) for w in a.windows if w.get("name") is not None]
    out = []
    for kind, w in picked:
        secs = w.get("windowSeconds")
        if kind == "session":
            label = f"{round((secs or 0) / 3600)}h"
        elif kind == "weekly":
            label = "week" if (secs or 0) <= 8 * 86400 else f"{round(secs / 86400)}d"
        else:
            label = w["name"]
        left = reset_in(w, now)
        out.append({"kind": kind, "label": label, "name": w.get("name"), "pct": live_pct(w, now),
                    "window_sec": secs, "resets_at": round(now + left) if left else None,
                    "sampled_at": round((w.get("sampledAt") or 0) / 1000) or None})
    return out


def window_rows(p, a, now):
    rows = []
    for w in usage_windows(a, now):
        label = w["label"].lower()[:6] if w["kind"] == "model" else w["label"]
        reset = w["resets_at"] - now if w["resets_at"] else None
        rows.append(f"{NOTE_INDENT}{label:6s}{usage_bar(p, w['pct'])}"
                    + (p.dim(f"  {fmt_dur(reset)}") if reset and w["pct"] > 0 else ""))
    return rows


def account_card(p, a, ctx):
    """(lines, notes) for one account. Notes wrap to the cell width later."""
    now, reason = ctx["now"], ctx["reasons"].get(a.id)
    sessions = ctx["in_use"].get(a.id, 0)
    marker = p.green("\u25cf") if sessions else p.dim("\u25cb")
    badges = []
    if ctx["pool_pin"] == a.id:
        badges.append(p.cyan("pool pin"))
    if a.id in ctx["scores"]:
        badges.append(p.cyan(f"score {ctx['scores'][a.id]:.2f}"))
    if ctx["waiting"].get(a.id):
        badges.append(p.yellow(f"{ctx['waiting'][a.id]} waiting"))
    if sessions:
        badges.append(p.green(f"{sessions} session{'s' if sessions != 1 else ''}"))
    if a.is_live:
        badges.append(p.cyan("supervised"))
    if reason == "disabled":
        badges.append(p.dim("disabled"))
    elif reason == "needs-reauth":
        badges.append(p.red("needs-reauth"))
    elif reason == "depleted":
        badges.append(p.yellow("full" if ctx["serves"].get(a.id) is False else "takes no new trees"))
    elif reason and reason.startswith(("cooldown", "limited")):
        badges.append(p.yellow(reason))
    tier = f" {p.dim(a.tier)}" if a.tier else ""
    lines = [f"{marker} {p.bold(a.label)}{tier}" + (f" {' '.join(badges)}" if badges else "")]
    lines += window_rows(p, a, now) if a.windows else [f"{NOTE_INDENT}{p.dim('never sampled')}"]
    notes = []
    if reason == "disabled":
        notes.append((p.dim, f"off: never picked until pi-pool on {a.label}"))
    elif reason == "needs-reauth":
        flag = " --provider openai-codex" if a.provider == "openai-codex" else ""
        notes.append((p.red, f"login is dead: pi-pool login {a.id}{flag}"))
    elif reason and reason.startswith("cooldown"):
        why = ctx["cooldown_reasons"].get(a.id)
        notes.append((p.yellow, f"refused: {why}" if why else "cooling down after a failure"))
    elif reason and reason.startswith("limited"):
        notes.append((p.yellow, "the provider answered 429; skipped until the limit ends"))
    if a.windows and reason != "needs-reauth" and now - a.usage_at > STALE_USAGE_SEC:
        notes.append((p.dim, f"usage from {fmt_ago(now - a.usage_at)}"))
    return lines, notes


def wrap_words(text, width):
    out, line = [], ""
    for word in text.split(" "):
        while len(word) > width:
            if line:
                out.append(line)
                line = ""
            out.append(word[:width])
            word = word[width:]
        if line and len(line) + 1 + len(word) > width:
            out.append(line)
            line = word
        else:
            line = f"{line} {word}" if line else word
    if line:
        out.append(line)
    return out


def render_grid(cards, term_width):
    """Lay cards out left to right, as many columns as the terminal fits."""
    if not cards:
        return []
    body = max(visible_len(l) for lines, _ in cards for l in lines)
    columns = max(1, min(len(cards), (term_width + CARD_GAP) // (body + CARD_GAP)))
    cell = term_width if columns == 1 else (term_width + CARD_GAP) // columns - CARD_GAP
    blocks = []
    for lines, notes in cards:
        block = list(lines)
        for paint, text in notes:
            block += [NOTE_INDENT + paint(l) for l in wrap_words(text, max(10, cell - len(NOTE_INDENT)))]
        blocks.append(block)
    width = max(visible_len(l) for b in blocks for l in b)
    out = []
    for start in range(0, len(blocks), columns):
        row = blocks[start:start + columns]
        for i in range(max(len(b) for b in row)):
            cells = [b[i] if i < len(b) else "" for b in row]
            out.append("".join(c + " " * (width + CARD_GAP - visible_len(c)) if k < len(cells) - 1 else c
                               for k, c in enumerate(cells)).rstrip())
        out.append("")
    return out


def card_order(a, ctx):
    reason = ctx["reasons"].get(a.id)
    rank = (0 if reason is None else 3 if reason == "disabled" else 2 if reason == "needs-reauth" else 1)
    return (rank, -ctx["scores"].get(a.id, 0), a.label)


def switches_today(provider, now):
    """(switches, sessions that switched) in today's log, local time. Scans
    backward and stops at the first line from an earlier day."""
    day = time.strftime("%Y-%m-%d", time.localtime(now))
    moves, sessions = 0, set()
    try:
        with open(LOG) as f:
            lines = f.readlines()
    except FileNotFoundError:
        return 0, 0
    for line in reversed(lines):
        if not line.startswith('{"ts": "' + day):
            if line[8:18] < day:
                break
            continue
        if '"event": "switch"' not in line:
            continue
        e = json.loads(line)
        if e.get("provider") == provider:
            moves += 1
            sessions.add(e.get("session"))
    return moves, len(sessions)


def status_lines(providers, p, term_width, now=None):
    now = time.time() if now is None else now
    cfg, state = config(), load_state()
    out = [p.dim(f"new trees enter under 5h {cfg['admit_5h_max_pct']}% (low {cfg['low_admit_5h_max_pct']}%)"
                 f"  week {cfg['seven_day_max_pct']}%  {'/'.join(cfg['switch_models'])} {cfg['seven_day_max_pct']}%"
                 f"  one per {cfg['admit_slot_sec']}s per tier unit"), ""]
    for provider in providers:
        title = PROVIDER_TITLES.get(provider, provider)
        try:
            accounts = load_index(provider)
        except Exception as e:
            out += [p.red(f"{title}: {e}"), ""]
            continue
        accounts = with_pool_state(accounts, state, provider)
        prov = state["providers"][provider]
        book = book_for(state, provider, None, cfg, now)
        cooldowns = prov["cooldowns"]
        reasons = {a.id: format_reason(a, cooldowns, cfg, now) for a in accounts}
        ctx = {"now": now, "in_use": book.load, "pool_pin": prov.get("pin"),
               "scores": {a.id: score(a, cfg, now, "normal", book.load) for a in accounts if reasons[a.id] is None},
               "serves": {a.id: serve_reason(a, cooldowns, now) is None for a in accounts},
               "waiting": {a: len(w) for a, w in book.waiting.items()},
               "reasons": reasons, "cooldown_reasons": prov.get("cooldown_reasons") or {}}
        head = [f"{title}  ({len(accounts)} accounts)"]
        if prov.get("pin"):
            pinned = next((a.label for a in accounts if a.id == prov["pin"]), prov["pin"])
            head.append(f"pool pinned to {pinned}")
        moves, movers = switches_today(provider, now)
        head.append(f"{moves} switches today ({movers} sessions)")
        if ctx["scores"]:
            head.append(f"{len(ctx['scores'])} take new trees")
        else:
            head.append(p.yellow("0 take new trees, new trees wait for a slot"))
        waiting = sum(ctx["waiting"].values())
        if waiting:
            head.append(p.yellow(f"{waiting} waiting"))
        head.append(f"{sum(book.load.values())} active sessions")
        out += [p.dim("  \u00b7  ".join(head)), ""]
        cards = [account_card(p, a, ctx) for a in sorted(accounts, key=lambda a: card_order(a, ctx))]
        out += render_grid(cards, term_width)
    return out


def cmd_status(rest=()):
    f = parse_flags(rest, provider_default=None)
    providers = [f["provider"]] if f["provider"] else list(PROVIDERS)
    p = Paint(sys.stdout.isatty() and not os.environ.get("NO_COLOR"))
    width = shutil.get_terminal_size((120, 40)).columns
    print("\n".join(status_lines(providers, p, width)).rstrip())
    return 0


def cmd_watch(rest):
    """Full-screen `status`, redrawn in place every `sec` seconds (default 5)."""
    interval, passthrough = 5, []
    for tok in rest:
        if tok.isdigit():
            interval = max(1, int(tok))
        else:
            passthrough.append(tok)
    f = parse_flags(passthrough, provider_default=None)
    providers = [f["provider"]] if f["provider"] else list(PROVIDERS)
    p = Paint(not os.environ.get("NO_COLOR"))
    sys.stdout.write("\x1b[?1049h\x1b[?25l")
    try:
        while True:
            size = shutil.get_terminal_size((120, 40))
            try:
                lines = status_lines(providers, p, size.columns)
            except Exception as e:
                lines = [p.red(f"pi-pool status failed: {type(e).__name__}: {e}")]
            header = p.dim(f"pi-pool watch  {time.strftime('%H:%M:%S')}  every {interval}s  ctrl-c to quit")
            frame = [header, ""] + lines
            sys.stdout.write("\x1b[H" + "".join(l + "\x1b[K\n" for l in frame[:size.lines - 1]) + "\x1b[J")
            sys.stdout.flush()
            time.sleep(interval)
    except KeyboardInterrupt:
        return 0
    finally:
        sys.stdout.write("\x1b[?25h\x1b[?1049l")
        sys.stdout.flush()


def cmd_pin(rest):
    f = parse_flags(rest)
    provider, positional = f["provider"], f["positional"]
    if not positional:
        raise SystemExit("usage: pi-pool pin <email> [--provider <p>]")
    accounts = load_index(provider)
    account = find_account(accounts, positional[0])
    if account is None:
        known = ", ".join(a.label for a in accounts)
        raise SystemExit(f"{positional[0]} is not in the {provider} pool ({known})")
    with Flock(LOCK, timeout=STATE_LOCK_TIMEOUT):
        state = load_state()
        if account.id in (state["providers"][provider].get("disabled") or {}):
            raise SystemExit(f"{account.label} is off; turn it on first (pi-pool on {account.label} --provider {provider})")
        if state["providers"][provider].get("pin") == account.id:
            print(f"already pinned: {account.label}")
            return 0
        IntentWriter(state).set_pool_pin(provider, account.id)
        save_json(STATE, state)
    log("pin", provider=provider, account=account.label)
    print(f"pinned: every {provider} request now vends {account.label} "
          f"(release with: pi-pool unpin --provider {provider})")
    return 0


def cmd_unpin(rest):
    f = parse_flags(rest)
    provider = f["provider"]
    with Flock(LOCK, timeout=STATE_LOCK_TIMEOUT):
        state = load_state()
        was = state["providers"][provider].get("pin")
        if not was:
            print(f"nothing pinned for {provider}")
            return 0
        IntentWriter(state).clear_pool_pin(provider)
        save_json(STATE, state)
    log("unpin", provider=provider, account=was)
    print(f"unpinned {was}; each session keeps its own account again ({provider})")
    return 0


def cmd_switch(rest):
    """This session's next request leaves the account it is on for the best
    account that takes it now (R2-R4); with none, it stays."""
    f = parse_flags(rest)
    provider = f["provider"]
    with Flock(LOCK, timeout=STATE_LOCK_TIMEOUT):
        state = load_state()
        key = session_key_for(f["session"], state)
        current = tree_for(state, key, provider).current if key else None
        if current is None:
            print(f"no {provider} account on file for this session; nothing to switch from")
            return 2
        IntentWriter(state).leave(key, provider, current, time.time())
        save_json(STATE, state)
    log("switch_asked", provider=provider, session=key.key, account=current)
    print(f"the next {provider} request of this session moves off {current}")
    return 0


def cmd_config(rest=()):
    print(json.dumps(config(), indent=2))
    return 0


def cmd_set(rest):
    if len(rest) != 2:
        raise SystemExit("usage: pi-pool set <key> <value>")
    key, value = rest
    if key not in DEFAULTS:
        raise SystemExit(f"unknown key {key}; known: {', '.join(sorted(DEFAULTS))}")
    d = DEFAULTS[key]
    if isinstance(d, bool):
        val = value.lower() in ("1", "true", "yes", "on")
    elif isinstance(d, int):
        val = int(value)
    elif isinstance(d, float):
        val = float(value)
    elif isinstance(d, list):
        val = [s for s in value.split(",") if s]
    elif isinstance(d, dict):
        val = json.loads(value)
        if not isinstance(val, dict):
            raise SystemExit(f"{key} takes a JSON object, like {json.dumps(d)}")
    else:
        val = value
    cur = load_json(CONFIG, {}) or {}
    cur[key] = val
    save_json(CONFIG, cur)
    print(f"{key} = {json.dumps(val)} (in {CONFIG})")
    return 0


def cmd_log(rest):
    n = int(rest[0]) if rest else 20
    try:
        entries = open(LOG).readlines()[-n:]
    except FileNotFoundError:
        entries = []
    sys.stdout.write("".join(entries))
    return 0


def write_key(f, state):
    """The tree a CLI write names: --session, else this process's tree. A tree
    with no record yet is accepted only as a full uuid with --new-session (`use`)
    or always (`priority`), since the hook keys a tree by its root uuid and a
    record under that uuid applies from the tree's first request."""
    key = session_key_for(f["session"], state)
    if key is None and SESSION_UUID_RE.fullmatch(f["session"] or ""):
        key = SessionKey(f["session"], f["session"], None)
    if key is None:
        if f["session"] is not None:
            print(f"--session {f['session']} matches no known session")
        else:
            print("no session id in this environment. Run this inside a Prime Agent "
                  "session, or pass --session <id>.")
    return key


def cmd_use(rest):
    f = parse_flags(rest)
    provider, positional = f["provider"], f["positional"]
    if f["force"]:
        print("--force is gone: a pin applies only when its account can take the session "
              f"(5h under {config()['admit_5h_max_pct']}%), on the next request")
        return 2
    with Flock(LOCK, timeout=STATE_LOCK_TIMEOUT):
        state = load_state()
        known = session_key_for(f["session"], state)
        if known is None and f["session"] is not None and not f["new_session"]:
            print(f"--session {f['session']} matches no known session")
            return 2
        key = write_key(f, state)
        if key is None:
            return 2
        rec = state["sessions"].get(key.key, {})
        prev_pin = (rec.get("pins") or {}).get(provider)

        if f["follow"]:
            if not prev_pin:
                print("already following the pool")
                return 0
            IntentWriter(state).clear_pin(key, provider)
            save_json(STATE, state)
            log("use", session=key.key, provider=provider, account=None,
                previous=prev_pin["account_id"])
            print(f"following the pool ({provider})")
            return 0

        if not positional:
            raise SystemExit("usage: pi-pool use <email|id> [--follow] [--new-session]")
        try:
            accounts = load_index(provider)
        except Exception as e:
            print(f"cannot load the {provider} pool: {e}")
            return 2
        account = find_account(accounts, positional[0])
        if account is None:
            known = ", ".join(a.label for a in accounts)
            print(f"{positional[0]} is not in the {provider} pool ({known})")
            return 2
        if account.id in (state["providers"][provider].get("disabled") or {}):
            print(f"{account.label} is off; turn it on first (pi-pool on {account.label} --provider {provider})")
            return 2
        if prev_pin and prev_pin["account_id"] == account.id:
            print(f"already on {account.label}")
            return 0
        IntentWriter(state).set_pin(key, provider, account.id, "cli", time.time())
        save_json(STATE, state)
        log("use", session=key.key, provider=provider, account=account.label,
            previous=prev_pin["account_id"] if prev_pin else None)
        print(f"{account.label} selected for this session tree; the next request moves there "
              f"if it can take the tree, and later moves prefer it")
        return 0


def cmd_priority(rest):
    """R7: `pi-pool priority high|normal|low [--session id]` sets the tree's class.
    One class per tree, whatever the provider."""
    f = parse_flags(rest)
    positional = f["positional"]
    if len(positional) != 1 or positional[0] not in PRIORITIES:
        raise SystemExit("usage: pi-pool priority high|normal|low [--session <id>] [--provider <p>]")
    with Flock(LOCK, timeout=STATE_LOCK_TIMEOUT):
        state = load_state()
        key = write_key(f, state)
        if key is None:
            return 2
        prev = (state["sessions"].get(key.key) or {}).get("priority") or "normal"
        IntentWriter(state).set_priority(key, positional[0], time.time())
        save_json(STATE, state)
    if prev != positional[0]:
        log("priority", session=key.key, priority=positional[0], previous=prev)
    print(f"{key.key}: {positional[0]}")
    return 0


REFRESH_TIMEOUT_SEC = 180
USAGE_READ = os.path.join(CODE_ROOT, "app", "usage-read.ts")
_WRAPPER_RUN = re.compile(r'exec\s+"([^"]+)"\s.*?\brun\s+"([^"]+)/main\.ts"')


def tokenmaxxing_exe():
    own = os.path.join(TM, "bin", "tokenmaxxing")
    return own if os.access(own, os.X_OK) else shutil.which("tokenmaxxing")


def tokenmaxxing_runtime():
    """The Bun binary and the `src` directory of the tokenmaxxing install the
    wrapper runs. usage-read.ts imports tokenmaxxing's own read and save code
    from that directory, so the read always matches the installed release."""
    exe = tokenmaxxing_exe()
    if not exe:
        raise RuntimeError("tokenmaxxing is not installed")
    real = os.path.realpath(exe)
    if real.endswith(os.path.join("src", "main.ts")):
        bun = shutil.which("bun")
        if not bun:
            raise RuntimeError("bun is not on PATH")
        return bun, os.path.dirname(real)
    try:
        with open(real, encoding="utf-8", errors="replace") as fh:
            match = _WRAPPER_RUN.search(fh.read(4096))
    except OSError as e:
        raise RuntimeError(f"cannot read {exe}: {e}")
    if not match:
        raise RuntimeError(f"cannot find the tokenmaxxing source behind {exe}")
    return match.group(1), match.group(2)


def read_usage(selection, emit, timeout=REFRESH_TIMEOUT_SEC):
    """Run usage-read.ts once per provider, all at once, and pass each event to
    `emit` with its provider, email and label. `selection` maps a provider to account
    ids, or to None for every account. An account still unread at the deadline
    is reported as not finished. Returns the providers that failed as a whole."""
    bun, src = tokenmaxxing_runtime()
    env = dict(os.environ, TOKENMAXXING_HOME=TM)
    events, procs, errors, pumps = queue.Queue(), {}, {}, []
    for provider, ids in selection.items():
        proc = subprocess.Popen([bun, "--no-env-file", USAGE_READ, src, provider, *(ids or [])], stdin=subprocess.DEVNULL,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env)
        procs[provider] = proc

        def pump(provider=provider, proc=proc):
            for line in proc.stdout:
                events.put((provider, line))
            events.put((provider, None))
        pumps.append(threading.Thread(target=pump, daemon=True))
        pumps[-1].start()
    emails, pending, open_, listed = {}, {p: set() for p in procs}, set(procs), set()
    labels = {}
    for provider in procs:
        try:
            labels.update({(provider, a.id): a.label for a in load_index(provider)})
        except Exception:
            pass
    deadline = time.monotonic() + timeout
    while open_:
        try:
            provider, line = events.get(timeout=max(0.0, deadline - time.monotonic()))
        except queue.Empty:
            break
        if line is None:
            open_.discard(provider)
            continue
        try:
            event = json.loads(line)
        except ValueError:
            continue
        if not isinstance(event, dict):
            continue
        kind = event.get("event")
        if kind == "accounts":
            listed.add(provider)
            for a in event.get("accounts") or []:
                emails[(provider, a.get("id"))] = a.get("email")
                a["label"] = labels.get((provider, a.get("id"))) or a.get("email")
                pending[provider].add(a.get("id"))
        elif kind == "read":
            pending[provider].discard(event.get("id"))
        elif kind == "error":
            errors[provider] = str(event.get("message") or "usage-read failed")
        if kind in ("reading", "read"):
            event["email"] = emails.get((provider, event.get("id")))
            event["label"] = labels.get((provider, event.get("id"))) or event["email"]
        emit(dict(event, provider=provider))
    for provider, proc in procs.items():
        killed = proc.poll() is None
        if killed:
            proc.kill()
        proc.wait()
        said = (proc.stderr.read() or "").strip().splitlines()
        if proc.returncode and provider not in errors and provider not in listed:
            errors[provider] = (f"usage-read did not finish in {timeout}s" if killed
                                else said[-1] if said else f"usage-read exited {proc.returncode}")[:300]
            emit({"event": "error", "provider": provider, "message": errors[provider]})
        for account in sorted(pending[provider], key=str):
            emit({"event": "read", "provider": provider, "id": account, "email": emails.get((provider, account)),
                  "label": labels.get((provider, account)) or emails.get((provider, account)),
                  "ok": False, "reason": f"the read did not finish in {timeout}s", "retry_at": None})
    for pump in pumps:
        pump.join(timeout=5)
    for proc in procs.values():
        proc.stdout.close()
        proc.stderr.close()
    return errors


def cmd_refresh(rest):
    """Read usage now for every account, or for the named ones, through
    tokenmaxxing's own read (app/usage-read.ts). It skips no account for having
    been read recently, but it waits out a rate limit the usage endpoint set.
    It writes only tokenmaxxing's usage figures and moves no session or pin.
    --stream prints each event as one JSON line while the reads run; --json
    prints one report at the end. Never prints a credential."""
    stream = "--stream" in rest
    f = parse_flags([tok for tok in rest if tok != "--stream"], provider_default=None)
    as_json = f["json"] or stream

    def fail(msg):
        print(json.dumps({"event": "error", "message": msg} if stream else {"error": msg}) if as_json else msg, flush=True)
        return 1

    if f["provider"] is not None and f["provider"] not in PROVIDERS:
        return fail(f"unknown provider {f['provider']}")
    if f["positional"] and f["provider"] is None:
        return fail("name the provider with --provider when choosing accounts")
    selection = {}
    for provider in [f["provider"]] if f["provider"] else list(PROVIDERS):
        if not f["positional"]:
            selection[provider] = None
            continue
        try:
            accounts = load_index(provider)
        except Exception as e:
            return fail(f"cannot load the {provider} pool: {e}")
        ids = []
        for sel in f["positional"]:
            account = find_account(accounts, sel)
            if account is None:
                return fail(f"{sel} is not in the {provider} pool")
            ids.append(account.id)
        selection[provider] = ids

    rows = {provider: [] for provider in selection}

    def emit(event):
        if event.get("event") == "read":
            rows[event["provider"]].append({k: event.get(k) for k in ("id", "email", "label", "ok", "reason", "retry_at", "usage_at")})
        if stream:
            print(json.dumps(event), flush=True)
        elif not as_json and event.get("event") == "read":
            print(f"{event['provider']:14s} {event.get('label') or event.get('id')}  {'read' if event.get('ok') else event.get('reason')}", flush=True)

    try:
        errors = read_usage(selection, emit)
    except RuntimeError as e:
        return fail(str(e))
    failed = [r["label"] or r["id"] for provider_rows in rows.values() for r in provider_rows if not r["ok"]]
    log("usage_refresh", providers=list(selection), accounts=sum(len(r) for r in rows.values()), failed=failed, errors=errors)
    if stream:
        print(json.dumps({"event": "end"}), flush=True)
    elif as_json:
        print(json.dumps({"providers": rows, **({"errors": errors} if errors else {})}, indent=2))
    else:
        for provider, message in errors.items():
            print(f"{provider:14s} {message}")
    return 1 if errors else 0


# ------------------------------------------------------------- reset grants
# Anthropic banks usage-limit resets on some accounts (program "cedar_ember").
# Reverse engineered from the CLIProxyAPI Management Center
# (src/services/api/claudeResetGrants.ts, resetGrantOperations.ts) and checked
# against live accounts: `GET /api/oauth/usage?cedar_ember=1` returns a
# `cedar_ember` block with the account's grants, and
# `POST /api/organizations/<org>/reset_rate_limits` spends one. The claim's
# request_id makes a retry of the same claim safe, so it is journaled before
# the POST and reused if the outcome was unknown.
RESETS = os.path.join(POOL, "resets.json")
RESET_CLAIMS = os.path.join(POOL, "reset-claims.json")
RESET_LOCK = os.path.join(POOL, "reset.lock")
GRANT_STATUS_URL = "https://api.anthropic.com/api/oauth/usage?cedar_ember=1&skip_spend=1"
PROFILE_URL = "https://api.anthropic.com/api/oauth/profile"
RESET_URL = "https://api.anthropic.com/api/organizations/{org}/reset_rate_limits"
RESET_PROGRAM = "cedar_ember"
RESET_WINDOWS = ("five_hour", "seven_day", "seven_day_overage_included")
RESET_RESULTS = ("reset", "already_used", "not_limited", "cooldown", "ineligible", "unavailable")
RESET_RETRY_SEC = 600
RESET_READ_WORKERS = 4
GRANT_ID_RE = re.compile(r"^[a-z0-9_-]{1,40}$")
ORG_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I)
RESET_MESSAGES = {
    "reset": "Usage limits reset.",
    "already_used": "This reset was already used.",
    "not_limited": "Not reset: the account is not limited right now.",
    "cooldown": "Not reset: Anthropic's reset cooldown is active.",
    "ineligible": "Not reset: this account is not eligible.",
    "unavailable": "Not reset: resets are unavailable right now.",
    "rate_limited": "Not reset: Anthropic rate limited the request. Nothing was spent.",
    "auth_error": "Not reset: Anthropic refused the account's token. Nothing was spent.",
}
RESET_BLOCKERS = {
    "ineligible": "the account is not eligible for resets",
    "unknown_grant": "the account has no such reset",
    "paused": "the reset is paused",
    "not_usable": "Anthropic says the reset cannot be used now",
    "exhausted": "no reset is left",
    "not_limited": "this reset can only be used while the account is limited",
    "not_started": "the reset is not available yet",
    "ended": "the reset has expired",
    "cooldown": "Anthropic's reset cooldown is active",
}


class ResetError(RuntimeError):
    pass


_reset_agent = None


def reset_user_agent():
    """Claude Code's own User-Agent, with the installed version. Anthropic
    decides grant eligibility by client: pi-pool's plain USER_AGENT reads every
    account as ineligible ("surface"), this one reads the real grants."""
    global _reset_agent
    if _reset_agent is None:
        version = "2.1.280"
        claude = shutil.which("claude") or os.path.join(HOME, ".local", "bin", "claude")
        try:
            out = subprocess.run([claude, "--version"], capture_output=True, text=True, timeout=10).stdout
            found = re.match(r"\s*(\d+\.\d+\.\d+)", out)
            version = found.group(1) if found else version
        except Exception:
            pass
        _reset_agent = f"claude-cli/{version} (external, cli)"
    return _reset_agent


def anthropic_call(url, token, payload=None, timeout=12.0):
    """(status, JSON object or None) for one call made as the account. A network
    failure raises; for a claim that means the outcome is unknown."""
    data = None if payload is None else json.dumps(payload).encode()
    req = urllib.request.Request(url, data=data, method="GET" if payload is None else "POST", headers={
        "Authorization": f"Bearer {token}", "anthropic-beta": "oauth-2025-04-20",
        "Content-Type": "application/json", "User-Agent": reset_user_agent()})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            status, raw = resp.status, resp.read()
    except urllib.error.HTTPError as e:
        status, raw = e.code, e.read()
    try:
        body = json.loads(raw)
    except ValueError:
        body = None
    return status, body if isinstance(body, dict) else None


def _iso(value):
    """An ISO timestamp kept as text, None when absent; False when unparsable."""
    if value is None:
        return None
    if not isinstance(value, str):
        return False
    try:
        datetime.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return False
    return value


def _epoch(value):
    return datetime.datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp() if value else None


def _count(value):
    return isinstance(value, int) and not isinstance(value, bool) and value >= 0


def parse_grant_status(block):
    """The `cedar_ember` block, normalized, or None when it is missing or changed
    shape. One bad grant rejects the block: a reset is never offered from a
    half-understood answer. Missing usability flags default to refusing."""
    if not isinstance(block, dict) or not isinstance(block.get("eligible"), bool):
        return None
    raw_grants = block.get("grants") or []
    if not isinstance(raw_grants, list):
        return None
    grants, seen = [], set()
    for g in raw_grants:
        if not isinstance(g, dict) or not isinstance(g.get("id"), str) or not GRANT_ID_RE.match(g["id"]) or g["id"] in seen:
            return None
        total, left = g.get("resets_total"), g.get("resets_left")
        if not _count(total) or not _count(left) or left > total:
            return None
        starts, ends = _iso(g.get("starts_at")), _iso(g.get("ends_at"))
        clears = g.get("clears") or []
        flags = {k: g.get(k, d) if g.get(k) is not None else d for k, d in (("paused", False), ("usable_now", False), ("use_requires_limit", True))}
        if starts is False or ends is False or not isinstance(clears, list) or not all(isinstance(v, bool) for v in flags.values()):
            return None
        used = g.get("percent_used") if isinstance(g.get("percent_used"), dict) else {}
        label = re.sub(r"\s+", " ", re.sub(r"[\x00-\x1f\x7f-\x9f]", " ", g.get("label") if isinstance(g.get("label"), str) else "")).strip()[:120]
        seen.add(g["id"])
        grants.append({"id": g["id"], "label": label, "resets_total": total, "resets_left": left,
                       "starts_at": starts, "ends_at": ends, "clears": [w for w in RESET_WINDOWS if w in clears],
                       **flags, "percent_used": {w: used[w] for w in RESET_WINDOWS
                                                 if isinstance(used.get(w), int) and not isinstance(used.get(w), bool) and 0 <= used[w] <= 100}})
    reason = block.get("ineligible_reason")
    at_limit = block.get("at_limit", False) if block.get("at_limit") is not None else False
    weekly, cooldown = _iso(block.get("weekly_resets_at")), _iso(block.get("cooldown_until"))
    if (reason is not None and not isinstance(reason, str)) or not isinstance(at_limit, bool) or weekly is False or cooldown is False:
        return None
    nxt = block.get("next_grant_id")
    return {"eligible": block["eligible"], "ineligible_reason": reason, "at_limit": at_limit, "grants": grants,
            "next_grant_id": nxt if isinstance(nxt, str) and nxt in seen else None,
            "weekly_resets_at": weekly, "cooldown_until": cooldown}


def grant_blocker(status, grant_id, now):
    """Why this grant cannot be spent now (a RESET_BLOCKERS key), or None."""
    if not status["eligible"]:
        return "ineligible"
    grant = next((g for g in status["grants"] if g["id"] == grant_id), None)
    if grant is None:
        return "unknown_grant"
    if grant["paused"]:
        return "paused"
    if not grant["usable_now"]:
        return "not_usable"
    if grant["resets_left"] <= 0:
        return "exhausted"
    if grant["use_requires_limit"] and not status["at_limit"]:
        return "not_limited"
    if grant["starts_at"] and _epoch(grant["starts_at"]) > now:
        return "not_started"
    if grant["ends_at"] and _epoch(grant["ends_at"]) <= now:
        return "ended"
    if status["cooldown_until"] and _epoch(status["cooldown_until"]) > now:
        return "cooldown"
    return None


def pick_grant(status, now):
    """Anthropic's recommended grant when it can be spent, else the first usable one by id."""
    usable = sorted((g for g in status["grants"] if grant_blocker(status, g["id"], now) is None), key=lambda g: g["id"])
    return next((g for g in usable if g["id"] == status["next_grant_id"]), usable[0] if usable else None)


def read_grant_status(token):
    try:
        code, body = anthropic_call(GRANT_STATUS_URL, token)
    except Exception as e:
        raise ResetError(f"the usage endpoint did not answer ({type(e).__name__})")
    if code == 429:
        raise ResetError("the usage endpoint rate limited this account; try again later")
    if code in (401, 403):
        raise ResetError(f"Anthropic refused the account's token ({code})")
    if code != 200 or body is None:
        raise ResetError(f"the usage endpoint answered {code}")
    status = parse_grant_status(body.get("cedar_ember"))
    if status is None:
        raise ResetError("the reset block is missing or changed shape")
    return status


def read_organization(token):
    try:
        code, body = anthropic_call(PROFILE_URL, token)
    except Exception as e:
        raise ResetError(f"the profile endpoint did not answer ({type(e).__name__})")
    org = (body or {}).get("organization")
    uuid = org.get("uuid") if isinstance(org, dict) else None
    if code != 200 or not isinstance(uuid, str) or not ORG_RE.match(uuid):
        raise ResetError(f"the account's organization could not be read ({code})")
    return uuid.lower()


def save_reset_status(account_id, entry):
    with Flock(LOCK, timeout=STATE_LOCK_TIMEOUT):
        cache = load_json(RESETS, {}) or {}
        cache[account_id] = entry
        save_json(RESETS, cache)


def reset_rows(accounts):
    """What `ls --json` shows per Claude account: the last grant read and any claim with an unknown outcome."""
    cache, claims = load_json(RESETS, {}) or {}, load_json(RESET_CLAIMS, {}) or {}
    out = {}
    for a in accounts:
        entry = dict(cache.get(a.id) or {})
        claim = claims.get(a.id)
        if claim and not claim.get("code"):
            entry["pending"] = {"grant_id": claim["grant_id"], "created_at": claim["created_at"]}
        out[a.id] = entry or None
    return out


def cmd_resets(rest):
    """Read every Claude account's banked resets now (or the named ones), save
    them for `ls --json`, and print them. A read spends nothing."""
    f = parse_flags(rest)
    if f["provider"] != "anthropic":
        print(json.dumps({"error": "only Claude accounts have resets"}) if f["json"] else "only Claude accounts have resets")
        return 1
    accounts = load_index("anthropic")
    if f["positional"]:
        chosen = []
        for sel in f["positional"]:
            a = find_account(accounts, sel)
            if a is None:
                print(json.dumps({"error": f"{sel} is not in the anthropic pool"}) if f["json"] else f"{sel} is not in the anthropic pool")
                return 1
            chosen.append(a)
        accounts = chosen
    cfg = config()

    def read(a):
        entry = {"checked_at": round(time.time())}
        if a.needs_reauth:
            entry["error"] = "the account needs a new sign-in"
            return a, entry
        try:
            entry["status"] = read_grant_status(credential_for(a, cfg)[0])
        except Exception as e:
            entry["error"] = str(e)[:200]
            return a, entry
        save_reset_status(a.id, entry)
        return a, entry

    with concurrent.futures.ThreadPoolExecutor(RESET_READ_WORKERS) as pool:
        results = list(pool.map(read, accounts))
    for a, entry in results:
        if "error" in entry:
            # A failed read keeps the last good grants and notes the failure next to them.
            with Flock(LOCK, timeout=STATE_LOCK_TIMEOUT):
                cache = load_json(RESETS, {}) or {}
                cache[a.id] = {**(cache.get(a.id) or {}), "error": entry["error"], "error_at": entry["checked_at"]}
                save_json(RESETS, cache)
    log("resets_read", accounts=[a.label for a, _ in results], failed=[a.label for a, e in results if "error" in e])
    rows = [{"id": a.id, "email": a.email, "label": a.label, **e} for a, e in results]
    if f["json"]:
        print(json.dumps({"accounts": rows}, indent=2))
        return 0
    for r in rows:
        if "error" in r:
            print(f"{r['label']}  not read: {r['error']}")
            continue
        st = r["status"]
        left = sum(g["resets_left"] for g in st["grants"])
        print(f"{r['label']}  {left} reset(s) left" + ("" if st["eligible"] else f"  (ineligible: {st['ineligible_reason']})"))
    return 0


def cmd_reset(rest):
    """Spend one banked reset on a Claude account. Checks the grant first and
    sends nothing when it cannot be spent. The claim's request_id is journaled
    before the POST; when the outcome is unknown, running the same command
    within 10 minutes retries with the same request_id, and after that the
    grant count shows whether it was spent."""
    rest, grant_arg = list(rest), None
    if "--grant" in rest:
        at = rest.index("--grant")
        grant_arg = rest[at + 1] if at + 1 < len(rest) else ""
        del rest[at:at + 2]
    f = parse_flags(rest)

    def done(code, result, message, **extra):
        out = {"result": result, "message": message, **extra}
        print(json.dumps(out) if f["json"] else message)
        return code

    if f["provider"] != "anthropic" or len(f["positional"]) != 1:
        return done(2, "error", "usage: pi-pool reset <email|id> [--grant <id>] [--json]")
    if grant_arg is not None and not GRANT_ID_RE.match(grant_arg):
        return done(2, "error", "the grant id is not valid")
    a = find_account(load_index("anthropic"), f["positional"][0])
    if a is None:
        return done(1, "error", f"{f['positional'][0]} is not in the anthropic pool")
    cfg = config()
    held = Flock(RESET_LOCK, timeout=1.0)
    try:
        held.__enter__()
    except TimeoutError:
        return done(1, "error", "another reset is running")
    try:
        token = credential_for(a, cfg)[0]
        org = read_organization(token)
        now = time.time()
        claims = load_json(RESET_CLAIMS, {}) or {}
        claim = claims.get(a.id)
        if claim and not claim.get("code"):
            if claim["org"] != org:
                return done(1, "error", "the account's organization changed since the unknown claim; check the account in Claude")
            if now - claim["created_at"] >= RESET_RETRY_SEC:
                status = read_grant_status(token)
                save_reset_status(a.id, {"checked_at": round(now), "status": status})
                grant = next((g for g in status["grants"] if g["id"] == claim["grant_id"]), None)
                spent = grant is None or grant["resets_left"] < claim["left_before"]
                claim["code"] = "reset" if spent else "not_spent"
                save_json(RESET_CLAIMS, claims)
                log("reset_resolved", account=a.label, grant=claim["grant_id"], spent=spent)
                if spent:
                    return done(0, "reset", "The earlier claim did spend the reset; usage limits were reset.", grant_id=claim["grant_id"])
                claim = None
            elif grant_arg and grant_arg != claim["grant_id"]:
                return done(1, "error", "a claim with an unknown outcome is open for another reset; retry that one first")
        retry = bool(claim and not claim.get("code"))
        if not retry:
            status = read_grant_status(token)
            save_reset_status(a.id, {"checked_at": round(now), "status": status})
            grant = next((g for g in status["grants"] if g["id"] == grant_arg), None) if grant_arg else pick_grant(status, now)
            blocker = grant_blocker(status, grant["id"] if grant else grant_arg or "", now) if (grant or grant_arg) else (
                "ineligible" if not status["eligible"] else "exhausted")
            if blocker:
                return done(1, "blocked", f"Not sent: {RESET_BLOCKERS[blocker]}.", blocker=blocker)
            claim = {"grant_id": grant["id"], "org": org, "request_id": uuid.uuid4().hex, "created_at": now,
                     "left_before": grant["resets_left"], "code": None}
            claims[a.id] = claim
            save_json(RESET_CLAIMS, claims)
        payload = {"program": RESET_PROGRAM, "grant_id": claim["grant_id"], "request_id": claim["request_id"]}
        log("reset_claim", account=a.label, grant=claim["grant_id"], retry=retry)
        try:
            code, body = anthropic_call(RESET_URL.format(org=org), token, payload, timeout=25.0)
            result = "rate_limited" if code == 429 else "auth_error" if code in (401, 403) else (
                body.get("result") if 200 <= code < 300 and body and body.get("result") in RESET_RESULTS else None)
        except Exception:
            result = None
        # A refusal on a retry cannot prove the first POST did not spend, so only a spend settles it.
        if result is not None and (not retry or result in ("reset", "already_used")):
            claims = load_json(RESET_CLAIMS, {}) or {}
            claims[a.id] = {**claim, "code": result}
            save_json(RESET_CLAIMS, claims)
        log("reset_result", account=a.label, grant=claim["grant_id"], result=result or "unknown")
        try:
            save_reset_status(a.id, {"checked_at": round(time.time()), "status": read_grant_status(token)})
        except Exception:
            pass
        if result is None or (retry and result not in ("reset", "already_used")):
            return done(3, "unknown", "The outcome is unknown; a reset may have been spent. Run the same reset again within "
                        "10 minutes to retry the same claim; after that the grant count settles it.", grant_id=claim["grant_id"])
        return done(0 if result == "reset" else 1, result, RESET_MESSAGES[result], grant_id=claim["grant_id"])
    except ResetError as e:
        return done(1, "error", f"Not sent: {e}.")
    except RuntimeError as e:
        return done(1, "error", f"Not sent: {e}.")
    finally:
        held.__exit__(None, None, None)



def tree_view(state, key, provider, accounts, f, cfg, now):
    """(accounts, tree, book, cooldowns) for a read-only command about one tree."""
    accounts = with_pool_state(accounts, state, provider)
    accounts = with_models(accounts, [f["model"]] if f.get("model") else session_models(state, key, provider, cfg, now), cfg)
    tree = tree_for(state, key, provider) if key else Tree(pool_pin=state["providers"][provider].get("pin"))
    return accounts, tree, book_for(state, provider, key, cfg, now), state["providers"][provider]["cooldowns"]


def wait_view(tree, d):
    """The tree's wait as {account, slot_at}: the one on file, else the one the
    next request would get; None when it does not wait."""
    if tree.wait:
        return {"account": tree.wait[0], "slot_at": math.ceil(tree.wait[1])}
    if isinstance(d, Wait):
        return {"account": d.slot_account.id, "slot_at": math.ceil(d.slot_at)}
    return None


def cmd_ls(rest):
    f = parse_flags(rest)
    provider = f["provider"]
    cfg, now = config(), time.time()
    try:
        accounts = load_index(provider)
    except Exception as e:
        msg = f"cannot load the {provider} pool: {e}"
        print(json.dumps({"error": msg}) if f["json"] else msg)
        return 1
    state = load_state()
    key = session_key_for(f["session"], state)
    if f["session"] is not None and key is None:
        msg = f"--session {f['session']} matches no known session"
        print(json.dumps({"error": msg}) if f["json"] else msg)
        return 2
    accounts, tree, book, cooldowns = tree_view(state, key, provider, accounts, f, cfg, now)
    d = decide(tree, accounts, book, cooldowns, cfg, now) if key else None
    rows = build_rows(accounts, tree, book, cooldowns, cfg, now,
                      state["providers"][provider].get("cooldown_reasons"))
    if provider == "anthropic":
        resets = reset_rows(accounts)
        for row in rows:
            row["resets"] = resets.get(row["id"])
    pin_account = next((a for a in accounts if a.id == state["providers"][provider].get("pin")), None)
    out = {"provider": provider, "session": key.key if key else None,
           "pin": {"id": pin_account.id, "email": pin_account.email, "label": pin_account.label} if pin_account else None,
           "priority": tree.priority, "wait": wait_view(tree, d) if key else None,
           "rows": rows}
    if f["json"]:
        print(json.dumps(out, indent=2))
        return 0
    print(f"{provider}  session {out['session'] or '-'}  priority {tree.priority}"
          + (f"  waits for {out['wait']['account']} at {iso(out['wait']['slot_at'])}" if out["wait"] else ""))
    width = max([len("account")] + [len(r["label"]) for r in rows])
    print(f"{'account':{width}s} {'usage':>9}  flags")
    for r in rows:
        flags = []
        if r["pinned"]:
            flags.append("pinned")
        if r["current"]:
            flags.append("current")
        if r["live"]:
            flags.append("live")
        if r["reason"]:
            flags.append(r["reason"])
        print(f"{r['label']:{width}s} {r['usage']:>9}  {' '.join(flags) or 'available'}")
    return 0


def cmd_model(rest):
    """Record the model one session of this process's tree runs, or clear it.
    A Fable cap then only stops an account for trees that run Fable."""
    f = parse_flags(rest)
    source = f["source"]
    model = f["positional"][0] if f["positional"] else None
    if not source or (not f["clear"] and not model):
        raise SystemExit("usage: pi-pool model (<id> --provider <p> | --clear) --source <session id>")
    key = session_key()
    if key is None:
        return 0
    now = time.time()
    with Flock(LOCK, timeout=STATE_LOCK_TIMEOUT):
        state = load_state()
        recs = tree_records(state, key)
        if not recs and f["clear"]:
            return 0
        if not recs:
            recs = [state["sessions"].setdefault(key.key, {"uuid": key.uuid, "active_id": key.active_id, "last_seen": now, "pins": {}})]
        for rec in recs:
            models = rec.setdefault("models", {})
            for provider in PROVIDERS:
                (models.get(provider) or {}).pop(source, None)
        if not f["clear"]:
            recs[0]["models"].setdefault(f["provider"], {})[source] = {"model": model, "at": now}
        for rec in recs:
            models = rec["models"]
            for provider in [p for p, entries in models.items() if not entries]:
                del models[provider]
        save_json(STATE, state)
    return 0


def cmd_limited(rest):
    """The provider answered 429 for the account this session tree last vended.
    Record the limit until `--until` (epoch seconds), so every tree on that
    account and every pin yield to it, and print what the tree's next request
    gets: {"account", "until", "next", "retry_at"}. `next` names the account the
    retry enters now. When it is null the tree waits, and `retry_at` is its own
    slot time (epoch sec): the extension sets the message's retryAfterMs to it, so
    Prime sleeps until the tree's slot, not until the provider's reset."""
    f = parse_flags(rest)
    provider, until = f["provider"], f["until"]
    if until is None:
        raise SystemExit("usage: pi-pool limited --until <epoch sec> [--since <epoch sec>] [--provider <p>] [--session <id>]")
    cfg, now = config(), time.time()
    accounts = load_index(provider)
    with Flock(LOCK, timeout=STATE_LOCK_TIMEOUT):
        state = load_state()
        key = session_key_for(f["session"], state)
        rec = state["sessions"].get(key.key) if key else None
        last = ((rec or {}).get("vends") or {}).get(provider)
        if not last:
            print(json.dumps({"error": f"no {provider} vend on file for this session"}))
            return 2
        # A request sent before the tree moved to its current account failed on an
        # earlier one, whose limit an earlier report recorded. 2026-10-08 22:28: the
        # in-flight requests of one tree re-reported one Codex account's 429 after each
        # move, and all three codex accounts got its reset (limited 4d16h, at 0% and 8% used).
        stale = f["since"] is not None and last.get("from", last.get("at", 0)) > f["since"]
        if not stale:
            HookWriter(state).set_limit(provider, last["account_id"], until, key, now)
            d = plan_next(state, key, provider, accounts, cfg, now)
            save_json(STATE, state)
    if stale:
        out = {"account": None, "until": round(until), "next": last["email"], "retry_at": None, "stale": True}
        log("limited_stale", provider=provider, current=last["email"], session=key.key,
            sent=iso(f["since"]))
        print(json.dumps(out))
        return 0
    out = {"account": last["email"], "until": round(until), **next_fields(d)}
    log("limited", provider=provider, account=last["email"], session=key.key,
        until=iso(until), next=out["next"], retry_at=out["retry_at"] and iso(out["retry_at"]))
    print(json.dumps(out))
    return 0


def plan_next(state, key, provider, accounts, cfg, now):
    """The decision for the tree's retry after its account failed, held in
    state: the cell it enters now, or its slot."""
    return schedule(state, key, provider, accounts, cfg, now, admit_now=False)[0]


def next_fields(d):
    """{"next", "retry_at"}: the account the retry enters now, or the tree's slot."""
    if isinstance(d, (Admit, Stay)):
        return {"next": d.account.label, "retry_at": None}
    if isinstance(d, Wait):
        return {"next": None, "retry_at": math.ceil(d.slot_at)}
    return {"next": None, "retry_at": None}


def cmd_refused(rest):
    """A request of this session tree failed with an error whose text names an
    account-level refusal (account_refusal). Cool the account the tree last
    vended down, as a probe refusal does, and print {"account", "reason",
    "next", "retry_at"}. Error text that names no refusal prints {"reason": null}
    and changes nothing."""
    f = parse_flags(rest)
    provider = f["provider"]
    reason = account_refusal(" ".join(f["positional"]))
    if reason is None:
        print(json.dumps({"reason": None}))
        return 0
    cfg, now = config(), time.time()
    accounts = load_index(provider)
    with Flock(LOCK, timeout=STATE_LOCK_TIMEOUT):
        state = load_state()
        key = session_key_for(f["session"], state)
        last = ((state["sessions"].get(key.key) or {}).get("vends") or {}).get(provider) if key else None
    account = next((a for a in accounts if last and a.id == last["account_id"]), None)
    if account is None:
        print(json.dumps({"error": f"no {provider} vend on file for this session"}))
        return 2
    apply_refusal(provider, account, reason, cfg, now)
    with Flock(LOCK, timeout=STATE_LOCK_TIMEOUT):
        state = load_state()
        d = plan_next(state, key, provider, accounts, cfg, now)
        save_json(STATE, state)
    out = {"account": account.label, "reason": reason, **next_fields(d)}
    log("refused", provider=provider, account=account.label, reason=reason, session=key.key, next=out["next"])
    print(json.dumps(out))
    return 0


def cmd_who(rest):
    f = parse_flags(rest)
    state = load_state()
    key = session_key_for(f["session"], state)
    if f["session"] is not None and key is None:
        msg = f"--session {f['session']} matches no known session"
        print(json.dumps({"error": msg}) if f["json"] else msg)
        return 2
    cfg, now = config(), time.time()
    providers_out = {}
    priority = "normal"
    for provider in PROVIDERS:
        try:
            accounts = load_index(provider)
        except Exception as e:
            providers_out[provider] = {"error": str(e)}
            continue
        accounts, tree, book, cooldowns = tree_view(state, key, provider, accounts, f, cfg, now)
        priority = tree.priority
        d = decide(tree, accounts, book, cooldowns, cfg, now)
        res = d if isinstance(d, (Stay, Admit)) else None
        by_id = {a.id: a for a in accounts}
        current = by_id.get(tree.current) or (res.account if res else None)
        providers_out[provider] = {
            "account": res.account.id if res else None,
            "email": res.account.email if res else None,
            "label": res.account.label if res else None,
            "reason": res.reason if res else ("wait" if isinstance(d, Wait) else None),
            "pinned": bool(tree.pin),
            "shadowed": list(d.shadowed) if d is not None and d.shadowed else None,
            "at": tree.current_at or None,
            "wait": wait_view(tree, d),
            "moves_today": len([t for t in tree.moves if now - t < MOVE_WINDOW_SEC]),
            # What the session's requests actually use: its last vend, else what the
            # next vend resolves to. The extension's footer status shows this.
            "current": {"email": current.email, "label": current.label, "session_pct": current.session_pct,
                        "weekly_pct": current.weekly_pct, "gated_pct": current.gated_pct,
                        "next": tree.current is not None and res is not None
                                and res.account.id != tree.current and res.account.label}
                       if current else None,
        }
    out = {"session": key.key if key else None, "priority": priority, "providers": providers_out}
    if f["json"]:
        print(json.dumps(out, indent=2))
    else:
        for provider, info in out["providers"].items():
            if info.get("error"):
                print(f"{provider:14s} unavailable: {info['error']}")
                continue
            if info["wait"]:
                label = next((a.label for a in load_index(provider) if a.id == info["wait"]["account"]),
                             info["wait"]["account"])
                print(f"{provider:14s} waits for {label} until {iso(info['wait']['slot_at'])}")
                continue
            if not info["email"]:
                print(f"{provider:14s} no account can serve")
                continue
            line = f"{provider:14s} {info['label']}  ({info['reason']})"
            if info["shadowed"]:
                line += f"  pin {info['shadowed'][0]} {info['shadowed'][1]}"
            print(line)
    return 0


 # The provider entries `enable` writes. Each needs `baseUrl` and `api`: an entry with
# only `apiKey` fails Prime's validateConfig and takes every model down.
ENABLE = {
    "anthropic": {"baseUrl": "https://api.anthropic.com", "api": "anthropic-messages", "args": ""},
    "openai-codex": {"baseUrl": "https://chatgpt.com/backend-api", "api": "openai-codex-responses",
                     "args": " --provider openai-codex"},
}


def cmd_enable(rest):
    if len(rest) != 1 or rest[0] not in ENABLE:
        raise SystemExit("usage: pi-pool enable anthropic|openai-codex")
    provider = rest[0]
    models_path = os.path.join(agent_dir(), "models.json")

    models = load_json(models_path, {}) or {}
    providers = models.setdefault("providers", {})
    # The installer's runtime link follows each new release; CODE_ROOT is one
    # installed release, which a later install replaces and prunes.
    hook = os.path.join(POOL, "bin", "pi-pool-token")
    if not os.path.exists(hook):
        hook = os.path.join(CODE_ROOT, "bin", "pi-pool-token")
    spec = ENABLE[provider]
    # An existing entry keeps its other fields (custom models, overrides); only these three change.
    entry = {**(providers.get(provider) or {}), "baseUrl": spec["baseUrl"], "api": spec["api"],
             "apiKey": f"!{shlex.quote(hook)}{spec['args']}"}
    changed = providers.get(provider) != entry
    if changed:
        providers[provider] = entry
        save_json(models_path, models)

    log("enable", provider=provider, agent_dir=agent_dir(), changed=changed)
    status = "enabled" if changed else "already enabled"
    print(f"{provider} {status} in {models_path}. The native login remains managed by Prime.")
    return 0


def cmd_toggle(rest, off):
    """`pi-pool off` / `pi-pool on`: keep an account in tokenmaxxing's pool but
    never pick it while off. Every pin on it yields."""
    verb = "off" if off else "on"
    f = parse_flags(rest)
    provider, positional = f["provider"], f["positional"]
    if len(positional) != 1:
        raise SystemExit(f"usage: pi-pool {verb} <email|id> [--provider <p>]")
    accounts = load_index(provider)
    account = find_account(accounts, positional[0])
    if account is None:
        raise SystemExit(f"{positional[0]} is not in the {provider} pool ({', '.join(a.label for a in accounts)})")
    with Flock(LOCK, timeout=STATE_LOCK_TIMEOUT):
        state = load_state()
        was_off = account.id in (state["providers"][provider].get("disabled") or {})
        if was_off == off:
            print(f"{account.label} is already {verb}")
            return 0
        IntentWriter(state).set_disabled(provider, account.id, off, time.time())
        save_json(STATE, state)
    log("account_" + verb, provider=provider, account=account.label)
    print(f"{account.label} is {verb}" + ("; the pool never picks it until pi-pool on" if off else "; the pool can pick it again"))
    return 0


def cmd_unlimited(rest):
    """`pi-pool unlimited <email|id>`: drop a `pi-pool limited` record the provider
    never meant for this account (2026-10-09: one 429 from one Codex account was
    re-reported after each move and marked all three Codex accounts until
    10-14). A real limit comes back on the next 429."""
    f = parse_flags(rest)
    provider, positional = f["provider"], f["positional"]
    if len(positional) != 1:
        raise SystemExit("usage: pi-pool unlimited <email|id> [--provider <p>]")
    accounts = load_index(provider)
    account = find_account(accounts, positional[0])
    if account is None:
        raise SystemExit(f"{positional[0]} is not in the {provider} pool ({', '.join(a.label for a in accounts)})")
    with Flock(LOCK, timeout=STATE_LOCK_TIMEOUT):
        state = load_state()
        limit = (state["providers"][provider].get("limits") or {}).pop(account.id, None)
        if limit is None:
            print(f"{account.label} has no limit on file")
            return 0
        save_json(STATE, state)
    log("limit_dropped", provider=provider, account=account.label, reason="unlimited")
    print(f"{account.label} is no longer limited (was until {time.strftime('%Y-%m-%dT%H:%M:%S', time.localtime(limit['until']))})")
    return 0


def cmd_rm(rest):
    """Remove an account the way tokenmaxxing does (`tokenmaxxing rm`, which
    deletes its credential store), then drop every pin and flag that
    names it here."""
    f = parse_flags(rest)
    provider, positional = f["provider"], f["positional"]
    if len(positional) != 1:
        raise SystemExit("usage: pi-pool rm <email|id> [--provider <p>]")
    accounts = load_index(provider)
    account = find_account(accounts, positional[0])
    if account is None:
        raise SystemExit(f"{positional[0]} is not in the {provider} pool ({', '.join(a.label for a in accounts)})")
    exe = tokenmaxxing_exe()
    if not exe:
        raise SystemExit("tokenmaxxing is not installed")
    try:
        done = subprocess.run([exe, "rm", *TM_FLAGS[provider], account.id], capture_output=True, text=True,
                              timeout=60, env=dict(os.environ, TOKENMAXXING_HOME=TM))
    except subprocess.TimeoutExpired:
        raise SystemExit("tokenmaxxing rm did not finish in 60s")
    if done.returncode != 0:
        said = ANSI_ANY_RE.sub("", done.stderr or done.stdout).strip().splitlines()
        raise SystemExit(said[-1] if said else f"tokenmaxxing rm exited {done.returncode}")
    with Flock(LOCK, timeout=STATE_LOCK_TIMEOUT):
        state = load_state()
        IntentWriter(state).forget_account(provider, account.id)
        save_json(STATE, state)
    log("account_removed", provider=provider, account=account.label)
    print(f"removed {account.label} from the {provider} pool")
    return 0


TM_FLAGS = {"anthropic": [], "openai-codex": ["--codex"]}
ANSI_ANY_RE = re.compile(r"\x1b\[[0-9;?<>=]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][0-9A-Za-z]|\x1b[=>78]")
LOGIN_TIMEOUT_SEC = 15 * 60
LOGIN_SETTLE_SEC = 0.8
LOGIN_BROWSER = os.path.join(CODE_ROOT, "app", "login-browser")
# Screens the isolated `claude` shows before and after /login, and the key that
# moves past each one. Matched with all whitespace removed: the TUI draws
# spaces as cursor moves, so the plain text has none.
CLAUDE_SCREENS = (("choosethetextstyle", "theme"), ("selectloginmethod", "method"),
                  ("oautherror", "error"), ("loginsuccessful", "success"))
CODEX_CODE_RE = re.compile(r"one-time code.*?\n\s*([A-Z0-9]{4,}-[A-Z0-9]{4,})", re.S)
CODEX_URL_RE = re.compile(r"(https://auth\.openai\.com/\S+)")


def squash(text):
    return re.sub(r"\s+", "", text).lower()


OSC8_OAUTH_RE = re.compile(r"\x1b\]8;[^;\x07\x1b]*;(https://[^\x07\x1b]*oauth/authorize\?[^\x07\x1b]*)(?:\x07|\x1b\\)")


def manual_oauth_url(raw, text):
    """The sign-in URL claude prints for a pasted code: the newest terminal
    hyperlink to it, else the printed text, which wraps across lines and ends
    at the paste prompt."""
    links = [url for url in OSC8_OAUTH_RE.findall(raw) if "state=" in url and "code_challenge=" in url]
    if links:
        return links[-1]
    start = text.rfind("https://")
    while start != -1 and "oauth/authorize" not in squash(text[start:start + 200]):
        start = text.rfind("https://", 0, start)
    if start == -1:
        return None
    end = text.find("Paste", start)
    if end == -1:
        return None
    url = re.sub(r"\s+", "", text[start:end])
    return url if "state=" in url and "code_challenge=" in url else None


class LoginDriver:
    """Runs `tokenmaxxing add|auth` on a pseudo-terminal and reports each step
    as one JSON line. The only input is a pasted sign-in code."""

    def __init__(self, provider, argv, url_file, emit):
        self.provider, self.argv, self.url_file, self.emit = provider, argv, url_file, emit
        self.raw, self.mark, self.sent, self.retries = "", 0, set(), 0
        self.announced = self.stale = None
        self.quiet_since = time.time()

    def feed(self, chunk, write):
        if chunk:
            self.raw += chunk
            self.quiet_since = time.time()
        if self.provider == "anthropic":
            self.claude_step(write)
        else:
            self.codex_step()

    @property
    def text(self):
        return ANSI_ANY_RE.sub("", self.raw)

    def claude_step(self, write):
        # The TUI drops keys it gets while still drawing a screen.
        if time.time() - self.quiet_since < LOGIN_SETTLE_SEC:
            return
        text = self.text
        tail = squash(text[self.mark:])
        for marker, step in CLAUDE_SCREENS:
            if marker in tail and (step == "error" or step not in self.sent):
                self.sent.add(step)
                self.mark = len(text)
                if step == "error":
                    self.retries += 1
                    if self.retries > 3:
                        raise LoginFailed("claude refused the sign-in code three times")
                    self.stale = self.announced
                    self.announced = None
                    self.sent -= {"method", "success"}
                    self.emit({"event": "retry", "message": "That code was not accepted. Open the new link and try again."})
                write(b"\r")
                return
        manual = manual_oauth_url(self.raw, text)
        callback = None
        try:
            with open(self.url_file) as f:
                urls = [line.strip() for line in f if line.strip()]
            callback = urls[-1] if urls else None
        except FileNotFoundError:
            pass
        if self.stale and (manual == self.stale[0] or callback == self.stale[1]):
            return
        if manual and (manual, callback) != self.announced:
            self.announced = (manual, callback)
            self.emit({"event": "url", "url": callback or manual, "manual_url": manual, "code": None, "paste": True})

    def codex_step(self):
        text = self.text
        url, code = CODEX_URL_RE.search(text), CODEX_CODE_RE.search(text)
        if url and code and self.announced != (url.group(1), code.group(1)):
            self.announced = (url.group(1), code.group(1))
            self.emit({"event": "url", "url": url.group(1), "manual_url": None, "code": code.group(1), "paste": False})

    def outcome(self, status):
        lines = [line.strip(" \u2713\r") for line in self.text.splitlines() if line.strip()]
        if status == 0:
            said = next((line for line in reversed(lines) if line.startswith(("added ", "reauthed "))), None)
            return {"event": "done", "ok": True, "message": said or "signed in"}
        return {"event": "done", "ok": False, "message": (lines[-1] if lines else f"tokenmaxxing exited {status}")[:300]}


class LoginFailed(Exception):
    pass


def stop_login(pid, fd):
    """Ctrl-C twice, the way a person leaves claude, so tokenmaxxing runs its
    own cleanup of the isolated login. After 5s the whole terminal's process
    group gets a hangup, then a kill. Never waits without a deadline."""
    import select, signal
    for key in (b"\x03", b"\x03"):
        try:
            os.write(fd, key)
        except OSError:
            break
        time.sleep(0.5)
    for sig, grace in ((None, 5), (signal.SIGHUP, 2), (signal.SIGKILL, 2)):
        if sig is not None:
            try:
                os.killpg(pid, sig)
            except ProcessLookupError:
                pass
        deadline = time.time() + grace
        while time.time() < deadline:
            done, raw = os.waitpid(pid, os.WNOHANG)
            if done:
                return os.waitstatus_to_exitcode(raw)
            if select.select([fd], [], [], 0.1)[0]:
                try:
                    os.read(fd, 65536)
                except OSError:
                    pass
    return None


# ------------------------------------------------- claude sign-in, by organization
# One Claude login can belong to several organizations (a personal plan and a
# team seat, say). tokenmaxxing keys an account by the login's account uuid
# alone, so `tokenmaxxing add` for a second organization overwrites the first.
# pi-pool therefore runs `tokenmaxxing add` against a scratch home and files the
# result itself, keyed by (account uuid, organization uuid). The first
# organization of a login keeps the account uuid as its id, as tokenmaxxing
# would give it; another organization gets ORG_ID_NAMESPACE's uuid5 of the pair.
ORG_ID_NAMESPACE = uuid.UUID("5a0f4b8e-6c1d-4f7a-9b2e-3d8c1e7f6a90")


class LoginRefused(Exception):
    pass


def login_pair(record):
    """(account uuid, organization uuid or None) of a tokenmaxxing record."""
    org = record.get("oauthAccount") or {}
    return org.get("accountUuid") or record["id"], org.get("organizationUuid")


def place_login(records, harvest):
    """(id, record or None): where a harvested login belongs. A record of the
    same login and organization is signed in again; a record with no
    organization on file matches by login alone."""
    login, org = login_pair(harvest)
    for r in records:
        r_login, r_org = login_pair(r)
        if r_login == login and r_org in (org, None):
            return r["id"], r
    taken = {r["id"] for r in records}
    new_id = login if login not in taken else str(uuid.uuid5(ORG_ID_NAMESPACE, f"{login}:{org}"))
    if any(i[:8] == new_id[:8] for i in taken):
        raise LoginRefused(f"the store for {new_id} would share stores/{new_id[:8]} with another account")
    return new_id, None


def file_claude_login(scratch, target_id=None):
    """Move the login `tokenmaxxing add` harvested into `scratch` into the real
    pool: its credential into the store of the account it belongs to, its
    record into accounts.json under tokenmaxxing's lock. With `target_id`, a
    login of any other account is refused and nothing is written. Returns the
    sentence to show."""
    harvested = (load_json(os.path.join(scratch, "accounts.json")) or {}).get("accounts") or []
    if len(harvested) != 1:
        raise LoginRefused("no sign-in was recorded")
    h = harvested[0]
    blob = kc_read(store_service(os.path.join(scratch, "stores", h["id"][:8])))
    if not blob:
        raise LoginRefused("the sign-in left no credential")
    with Flock(TM_LOCK, timeout=TM_LOCK_TIMEOUT):
        idx = _read_index(TM_ACCOUNTS)
        records = idx["accounts"]
        account_id, existing = place_login(records, h)
        if target_id is not None and account_id != target_id:
            want = next((r for r in records if r["id"] == target_id), {})
            raise LoginRefused(f"that sign-in is {h.get('email')} ({org_suffix(h)}), not "
                               f"{want.get('email')} ({org_suffix(want)}); nothing changed")
        store = store_dir(account_id)
        os.makedirs(store, mode=0o700, exist_ok=True)
        with ClaudeRefreshLock(store):
            kc_write(store_service(store), blob)
        fresh = {k: h[k] for k in ("email", "tier", "oauthAccount") if k in h}
        fresh["needsReauth"] = False
        if h.get("lastUsageAt"):
            fresh.update(windows=h.get("windows") or [], lastUsageAt=h["lastUsageAt"])
        if existing is not None:
            if h.get("lastUsageAt"):
                existing.pop("usageRetryAt", None)
            existing.update(fresh)
        else:
            shared = any(r.get("email") == h.get("email") for r in records)
            records.append({"id": account_id, "label": f"{h.get('email')} ({org_suffix(h)})" if shared else h.get("label") or h.get("email"),
                            "addedAt": h.get("addedAt") or datetime.datetime.now(datetime.timezone.utc).isoformat(),
                            "windows": [], **{k: h[k] for k in ("usageRetryAt",) if k in h}, **fresh})
        tmp = f"{TM_ACCOUNTS}.tmp.{os.getpid()}"
        with open(tmp, "w") as f:
            f.write(json.dumps(idx, indent=2) + "\n")
        os.chmod(tmp, 0o600)
        os.replace(tmp, TM_ACCOUNTS)
        label = record_labels(records)[account_id]
        size = len(records)
    log("login_filed", account=label, id=account_id, new=existing is None)
    tier = f" ({h['tier']})" if h.get("tier") else ""
    said = f"added {label}{tier} \u2192 pool now has {size} accounts" if existing is None else f"reauthed {label}{tier}"
    return said, account_id


def scratch_login_home():
    """A private tokenmaxxing home for one sign-in, with the real config (so
    the same claude binary runs) and nothing else."""
    home = os.path.join(POOL, "logins", str(os.getpid()))
    shutil.rmtree(home, ignore_errors=True)
    os.makedirs(home, mode=0o700)
    if os.path.exists(os.path.join(TM, "config.json")):
        shutil.copy(os.path.join(TM, "config.json"), os.path.join(home, "config.json"))
    return home


def drop_scratch_login(home):
    """Delete every credential a scratch sign-in can leave: the harvested
    store's Keychain item, claude's onboarding item, and the folder."""
    services = [store_service(os.path.join(home, "onboard"))]
    for r in (load_json(os.path.join(home, "accounts.json")) or {}).get("accounts") or []:
        services.append(store_service(os.path.join(home, "stores", r["id"][:8])))
    stores = os.path.join(home, "stores")
    if os.path.isdir(stores):
        services += [store_service(os.path.join(stores, name)) for name in os.listdir(stores)]
    for service in dict.fromkeys(services):
        try:
            kc_delete(service)
        except RuntimeError as e:
            log("login_cleanup_failed", error=str(e))
    shutil.rmtree(home, ignore_errors=True)


def cmd_login(rest):
    """`pi-pool login [<email|id>] [--provider p]`: add an account, or sign one
    in again, through tokenmaxxing's own isolated login, driven for a browser.
    Claude runs `tokenmaxxing add` in a scratch home and file_claude_login
    files the result by organization; codex runs `tokenmaxxing add|auth`.

    stdout is JSON lines: {"event":"url"} with the sign-in link (and the codex
    device code), {"event":"retry"}, then one {"event":"done","ok":...}.
    stdin takes a pasted claude sign-in code per line; closing stdin cancels.
    claude's own browser opener is replaced by app/login-browser, which
    records the localhost-callback link instead of opening a tab."""
    rest, timeout = list(rest), LOGIN_TIMEOUT_SEC
    if "--timeout" in rest:
        at = rest.index("--timeout")
        try:
            timeout = float(rest[at + 1])
        except (IndexError, ValueError):
            raise SystemExit("--timeout takes seconds")
        del rest[at:at + 2]
    f = parse_flags(rest)
    provider, positional = f["provider"], f["positional"]
    if provider not in PROVIDERS or len(positional) > 1 or timeout <= 0:
        raise SystemExit("usage: pi-pool login [<email|id>] [--provider <p>] [--timeout <sec>]")
    emit = lambda event: (sys.stdout.write(json.dumps(event) + "\n"), sys.stdout.flush())
    exe = tokenmaxxing_exe()
    if not exe:
        emit({"event": "done", "ok": False, "message": "tokenmaxxing is not installed"})
        return 1
    account = None
    if positional:
        account = find_account(load_index(provider), positional[0])
        if account is None:
            emit({"event": "done", "ok": False, "message": f"{positional[0]} is not in the {provider} pool"})
            return 1
    # Claude always signs in through `add` in a scratch home; file_claude_login
    # then files it by organization (see ORG_ID_NAMESPACE).
    if positional and provider != "anthropic":
        argv = [exe, "auth", *TM_FLAGS[provider], account.id]
    else:
        argv = [exe, "add", *TM_FLAGS[provider]]
    os.makedirs(POOL, exist_ok=True)
    home = scratch_login_home() if provider == "anthropic" else None
    try:
        return run_login(provider, argv, home, account, timeout, emit)
    finally:
        if home:
            drop_scratch_login(home)


def run_login(provider, argv, home, account, timeout, emit):
    import pty, select, signal, struct, termios
    url_file = os.path.join(POOL, f"login-{os.getpid()}.urls")
    env = dict(os.environ, TOKENMAXXING_HOME=home or TM, BROWSER=LOGIN_BROWSER, PI_POOL_LOGIN_URLS=url_file,
               TERM="xterm-256color")
    for name in (SESSION_ENV, JOURNAL_ENV):
        env.pop(name, None)
    pid, fd = pty.fork()
    if pid == 0:
        try:
            fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack("HHHH", 50, 400, 0, 0))
            os.execve(argv[0], argv, env)
        finally:
            os._exit(127)
    driver = LoginDriver(provider, argv, url_file, emit)
    write = lambda data: os.write(fd, data)

    def stopped(signum, frame):
        raise LoginFailed("the sign-in was stopped")
    signal.signal(signal.SIGTERM, stopped)
    log("login_start", provider=provider, mode=argv[1])
    deadline, status, cancelled, failure = time.time() + timeout, None, False, None
    stdin, pasted = sys.stdin.fileno(), b""
    inputs = [fd, stdin]
    try:
        while status is None:
            if time.time() > deadline:
                failure = f"the sign-in did not finish in {max(1, round(timeout / 60))} min"
                break
            ready, _, _ = select.select(inputs, [], [], 0.3)
            if fd in ready:
                try:
                    chunk = os.read(fd, 65536)
                except OSError:
                    chunk = b""
                if chunk:
                    driver.feed(chunk.decode("utf-8", "replace"), write)
                else:
                    inputs.remove(fd)
            elif driver.provider == "anthropic":
                driver.feed("", write)
            if stdin in ready:
                # os.read, never readline: a pasted code without its newline
                # must not block the terminal loop.
                chunk = os.read(stdin, 4096)
                if not chunk:
                    cancelled = True
                    break
                pasted += chunk
                while b"\n" in pasted:
                    line, pasted = pasted.split(b"\n", 1)
                    if line.strip():
                        write(line.strip() + b"\r")
            done, raw = os.waitpid(pid, os.WNOHANG)
            if done:
                status = os.waitstatus_to_exitcode(raw)
    except LoginFailed as e:
        failure = str(e)
    finally:
        if status is None:
            status = stop_login(pid, fd)
        drain_until = time.time() + 1
        while time.time() < drain_until and select.select([fd], [], [], 0.1)[0]:
            try:
                chunk = os.read(fd, 65536)
            except OSError:
                break
            if not chunk:
                break
            driver.raw += chunk.decode("utf-8", "replace")
        try:
            os.killpg(pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            pass
        os.close(fd)
        try:
            os.unlink(url_file)
        except FileNotFoundError:
            pass
    if cancelled or failure:
        result = {"event": "done", "ok": False, "message": failure or "cancelled"}
    else:
        result = driver.outcome(status)
    signed_in = None
    if result["ok"] and home:
        try:
            result["message"], signed_id = file_claude_login(home, account.id if account else None)
            signed_in = next((a for a in load_index(provider) if a.id == signed_id), None)
        except (LoginRefused, RuntimeError, TimeoutError) as e:
            result = {"event": "done", "ok": False, "message": str(e)[:300]}
    elif result["ok"]:
        said = result["message"].split()
        signed_in = account or (
            find_account(load_index(provider), said[1]) if len(said) > 1 and said[0] in ("added", "reauthed") else None)
    log("login_end", provider=provider, mode=argv[1], ok=result["ok"], message=result["message"])
    if signed_in is not None:
        drop_login_blocks(provider, signed_in)
    emit(result)
    return 0 if result["ok"] else 1


def drop_login_blocks(provider, account):
    """A new sign-in replaces the credential the provider answered 429 for, so
    its `pi-pool limited` record no longer applies (2026-10-08: sieun@virev.ai
    signed in again on a fresh plan at 0% and stayed limited for 2 h). It also
    passes claude.ai, where updated terms are accepted, so a NEEDS_TERMS
    cooldown goes too (2026-10-08: claude7@slack.green served again right
    after it signed in again). If the terms are still pending, the next request
    puts the cooldown back and moves the turn to another account."""
    with Flock(LOCK, timeout=STATE_LOCK_TIMEOUT):
        state = load_state()
        prov = state["providers"][provider]
        limit = prov["limits"].pop(account.id, None)
        terms = (prov.get("cooldown_reasons") or {}).get(account.id) == NEEDS_TERMS
        if terms:
            prov["cooldowns"].pop(account.id, None)
            prov["cooldown_reasons"].pop(account.id, None)
        if limit is None and not terms:
            return
        save_json(STATE, state)
    if limit is not None:
        log("limit_dropped", provider=provider, account=account.label, reason="login")
    if terms:
        log("refusal_dropped", provider=provider, account=account.label, reason="login", refusal=NEEDS_TERMS)


USAGE = """usage: pi-pool [command]
  status [--provider <p>]        one card per account: usage bars, sessions, score, waiters, switches today
  watch [sec] [--provider <p>]   full-screen status, redrawn every sec seconds (default 5)
  pin <email> [--provider <p>]   force EVERY request onto one account until unpin
  unpin [--provider <p>]         release the pool pin (each session keeps its own account again)
  switch [--provider <p>] [--session <id>]  this session's next request moves to another account
  use <email|id> [--follow] [--provider <p>] [--session <id>] [--new-session]
                                  pin (or, with --follow, unpin) this session tree
  priority high|normal|low [--session <id>]
                                  the tree's class: who gets slots first, and its daily move budget
  ls [--json] [--provider <p>] [--session <id>] [--model <id>]
                                  the rows /account renders; --model judges per-model caps
                                  for that model instead of the session's recorded ones
  who [--json] [--session <id>] [--model <id>]
                                  what this session resolves to now, per provider, and its wait
  limited --until <epoch sec> [--since <epoch sec>] [--provider <p>] [--session <id>]
                                  the provider answered 429 for this session's account; every
                                  pin yields to it until then. Prints the next account, or null
                                  and retry_at, the session's own slot time.
                                  --since: when the failed request was sent; a request sent before
                                  the session moved to its account marks nothing ("stale")
  unlimited <email|id> [--provider <p>]
                                  drop a limited record that was not this account's (a real
                                  limit comes back on the next 429)
  refused <error text> [--provider <p>] [--session <id>]
                                  a request failed with an account-level refusal (terms not
                                  accepted, OAuth off); cool this session's account down for
                                  24 h. Prints the next account or null
  model (<id> --provider <p> | --clear) --source <session id>
                                  record the model one session of this tree runs; the
                                  /account extension calls it on session start and model change
  enable openai-codex            wire the openai-codex provider into models.json
  off <email|id> [--provider <p>]
                                  keep an account pooled but never pick it
  on <email|id> [--provider <p>] let the pool pick it again
  rm <email|id> [--provider <p>] tokenmaxxing rm, then drop its pins here
  login [<email|id>] [--provider <p>] [--timeout <sec>]
                                  tokenmaxxing add (or auth <account>) driven as JSON lines
  refresh [<email|id> ...] [--provider <p>] [--json | --stream]
                                  read usage now for every account or the named ones (tokenmaxxing's own read);
                                  --stream prints one JSON line per event while the reads run
  resets [<email|id> ...] [--json]
                                  read each Claude account's banked usage-limit resets (spends nothing)
  reset <email|id> [--grant <id>] [--json]
                                  spend one banked reset; rerun within 10 min after an unknown outcome
  probe [--force]                check every anthropic account for an API refusal (no refresh);
                                  the extension runs it at session start, at most every 6h
  adopt-logins                   move a stored /login that would bypass the pool into
                                  fallback.json (the /account extension runs this per session)
  config                         print the merged config
  set <key> <value>              persist a config override
  log [n]                        last n pool events (default 20)
"""


def cli(args):
    cmd, rest = (args[0] if args else "status"), args[1:]
    handlers = {
        "status": cmd_status, "watch": cmd_watch, "pin": cmd_pin, "unpin": cmd_unpin,
        "switch": cmd_switch, "use": cmd_use, "ls": cmd_ls, "who": cmd_who,
        "config": cmd_config, "set": cmd_set, "log": cmd_log, "enable": cmd_enable,
        "adopt-logins": cmd_adopt_logins, "probe": cmd_probe, "refresh": cmd_refresh,
        "resets": cmd_resets, "reset": cmd_reset,
        "off": lambda rest: cmd_toggle(rest, True), "on": lambda rest: cmd_toggle(rest, False),
        "rm": cmd_rm, "login": cmd_login, "model": cmd_model, "limited": cmd_limited,
        "refused": cmd_refused, "unlimited": cmd_unlimited, "priority": cmd_priority,
    }
    if cmd in handlers:
        return handlers[cmd](rest)
    raise SystemExit(USAGE)


def log_when_killed(provider):
    """Prime runs the hook under a 10 s timeout and drops its stderr, so a hook it
    kills leaves no trace anywhere. Log the kill. Both clocks start at main();
    `wall_sec` far above `awake_sec`
    means the Mac slept while the hook ran (2026-10-08 21:20-21:44: every failed
    hook call fell in a sleep or dark-wake window and the log had no line)."""
    wall, awake = time.time(), time.monotonic()

    def on_term(signum, frame):
        at = []
        while frame is not None and len(at) < 8:
            at.append(f"{frame.f_code.co_name}:{frame.f_lineno}")
            frame = frame.f_back
        log("hook_killed", provider=provider, signal=signum, session=os.environ.get(SESSION_ENV),
            wall_sec=round(time.time() - wall, 1), awake_sec=round(time.monotonic() - awake, 1), at=at)
        raise SystemExit(128 + signum)
    signal.signal(signal.SIGTERM, on_term)


def main():
    argv = sys.argv[1:]
    if argv and argv[0] == "--cli":
        return cli(argv[1:])
    if "--status" in argv:
        return cmd_status([])
    provider = "anthropic"
    if "--provider" in argv:
        provider = argv[argv.index("--provider") + 1]
    log_when_killed(provider)
    try:
        vend(provider)
    except SystemExit:
        raise
    except Exception as e:
        # This hook IS the credential path for every request on this provider: a
        # crash here would surface as "No API key found". Both providers degrade
        # to the user's own login that adopt-logins moved into fallback.json.
        log("vend_error", error=f"{type(e).__name__}: {e}", provider=provider)
        try:
            token = fallback_token(provider, config())
        except Exception as fe:
            log("fallback_error", error=f"{type(fe).__name__}: {fe}", provider=provider)
            token = None
        if token:
            sys.stdout.write(token)
            return
        raise


if __name__ == "__main__":
    sys.dont_write_bytecode = True
    sys.exit(main() or 0)
