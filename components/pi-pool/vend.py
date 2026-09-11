#!/usr/bin/env python3
"""pi-pool: vend a pooled OAuth access token to Prime Agent (pi), for Claude
(anthropic) and Codex (openai-codex).

Prime Agent resolves a provider apiKey of the form "!<this script> [--provider
<p>]" by executing the command and using stdout as the API key. Both wire
protocols accept a bare access token as the apiKey (pi-ai sniffs
"sk-ant-oat" for the Claude OAuth path; the openai-codex provider decodes the
account id straight out of the JWT), so a short-lived ACCESS token is all
either provider ever needs.

Prime receives access tokens only. This script reads tokenmaxxing's parked
credentials (a keychain item for anthropic, a JSON file for codex), refreshes
in place under tokenmaxxing's own flock, and prints only an access token.
Private rotation journals live under the pool state directory.

stdout = the token, and nothing else. All diagnostics go to the log file.
"""
import base64, collections, dataclasses, fcntl, json, os, shlex, subprocess, sys, time, urllib.request, urllib.error

HOME = os.path.expanduser("~")
TM = os.path.join(HOME, ".config", "tokenmaxxing")
TM_ACCOUNTS = os.path.join(TM, "accounts.json")
TM_CODEX_ACCOUNTS = os.path.join(TM, "codex-accounts.json")
TM_CODEX_CREDS = os.path.join(TM, "codex-creds")
TM_CODEX_LIVE = os.path.join(TM, "codex-live")
TM_LOCK = os.path.join(TM, "lock")
TM_CODEX_LOCK = os.path.join(TM, "codex-lock")
CODEX_AUTH_PATH = os.path.join(HOME, ".codex", "auth.json")
LIVE_SERVICE = "Claude Code-credentials"
KC_ACCOUNT = os.environ.get("USER") or "unknown"

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
JOURNAL_ENV = "PRIME_AGENT_INTERNAL_DAEMON_WORKER_RECOVERY_JOURNAL"

DEFAULTS = {
    # refresh a parked credential when it expires within this many seconds
    "refresh_skew_sec": 900,
    # an account is considered depleted at/above these cached usage percentages
    "five_hour_max_pct": 95,
    "seven_day_max_pct": 98,
    # cooldown applied to an account after a vend-failure signal
    "cooldown_sec": 1200,
    # picker smoothing: usage-% equivalent charged per session already on an
    # account, and for being the account another tool is currently live on
    "session_penalty": 8,
    "active_account_penalty": 15,
    # allow the account another tool is currently live on (read-only, never
    # refreshed here) when nothing else is available
    "allow_active_account": True,
    # anthropic-only per-model weekly caps that also count toward depletion
    "switch_models": ["fable"],
    # a session record with no vend and no fresh pin for this long is dropped
    "pin_ttl_sec": 7 * 24 * 3600,
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
    tmp = f"{path}.tmp.{os.getpid()}"
    with open(tmp, "w") as f:
        json.dump(data, f, indent=2)
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)


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
    """recover_rotation's view of one parked codex-creds/<id>.json file."""

    def __init__(self, path):
        self.path = path

    def read(self):
        return load_json(self.path)

    def expiry_ms(self, blob):
        return jwt_claims(blob["tokens"]["access_token"])["exp"] * 1000

    def write(self, blob):
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
FIVE_H_MS = 5 * 3600 * 1000
WEEK_MS = 7 * 24 * 3600 * 1000
CODEX_SESSION_WINDOW_MAX_SEC = 6 * 3600


def live_pct(window, window_ms, sampled_at_ms, now):
    """A window's usable-against percentage NOW, mirroring tokenmaxxing's
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
    if sampled_at_ms and now_ms >= sampled_at_ms + window_ms:
        return 0
    return pct


def usage_pct(account, now):
    lu = account.get("lastUsage") or {}
    at = account.get("lastUsageAt") or 0
    five = live_pct(lu.get("fiveHour"), FIVE_H_MS, at, now)
    seven = live_pct(lu.get("sevenDay"), WEEK_MS, at, now)
    return five, seven


def gated_pct(account, cfg, now):
    """Worst live per-model weekly cap among the gated families
    (switch_models), tokenmaxxing's capForFamily over accounts.json's
    lastPerModel rows. anthropic only; codex has no per-model rows."""
    worst = 0
    at = account.get("lastPerModelAt") or account.get("lastUsageAt") or 0
    for model, w in (account.get("lastPerModel") or {}).items():
        if any(f.lower() in model.lower() for f in cfg["switch_models"]):
            worst = max(worst, live_pct(w, WEEK_MS, at, now))
    return worst


def codex_window_pcts(account, now):
    """Classify lastUsage.aggregate[] by windowSeconds, never by array
    position: some plans carry only a 30-day window, others a 5h + weekly
    pair. live_pct still applies, so a passed reset self-heals here too."""
    windows = (account.get("lastUsage") or {}).get("aggregate") or []
    at = account.get("lastUsageAt") or 0
    session_pct, weekly_pct = 0, 0
    for w in windows:
        secs = w.get("windowSeconds") or 0
        pct = live_pct(w, secs * 1000, at, now)
        if secs <= CODEX_SESSION_WINDOW_MAX_SEC:
            session_pct = max(session_pct, pct)
        else:
            weekly_pct = max(weekly_pct, pct)
    return session_pct, weekly_pct


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
# only by the CLI, observation (vends, seat, cooldowns) only by the hook, and
# truth (usage, needs-reauth) is never written here at all - it is read from
# tokenmaxxing's indexes on every request. "A pin exists but its account cannot
# serve" is derived per request and never stored, so it heals itself.
Keychain = collections.namedtuple("Keychain", "service")
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


@dataclasses.dataclass(frozen=True)
class Intent:
    """What humans asked for, for one (session, provider)."""
    session_pin: "str | None" = None
    session_pin_force: bool = False
    pool_pin: "str | None" = None
    seat: "str | None" = None


@dataclasses.dataclass(frozen=True)
class Resolution:
    account: Account
    reason: str
    shadowed: "tuple | None" = None


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


# ---------------------------------------------------------- codex identity
def codex_live_account_id():
    """The account ~/.codex/auth.json names, decoded from its own access
    token claim. No file on this machine stores that id directly."""
    blob = load_json(CODEX_AUTH_PATH)
    token = ((blob or {}).get("tokens") or {}).get("access_token")
    if not token:
        return None
    try:
        claims = jwt_claims(token)
    except Exception:
        return None
    return (claims.get("https://api.openai.com/auth") or {}).get("chatgpt_account_id")


def codex_presence_ids():
    try:
        return set(os.listdir(TM_CODEX_LIVE))
    except FileNotFoundError:
        return set()


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


def _load_index_anthropic():
    idx = load_json(TM_ACCOUNTS)
    if not idx:
        raise RuntimeError("tokenmaxxing accounts.json unreadable")
    cfg, now, active = config(), time.time(), idx.get("activeAccountUuid")
    out = []
    for a in idx.get("accounts", []):
        five, seven = usage_pct(a, now)
        out.append(Account(
            provider="anthropic", id=a["accountUuid"], email=a["email"],
            needs_reauth=bool(a.get("needsReauth")), session_pct=five, weekly_pct=seven,
            gated_pct=gated_pct(a, cfg, now), is_live=(a["accountUuid"] == active),
            cred=Keychain(a["keychainItem"]),
        ))
    return out


def _load_index_codex():
    idx = load_json(TM_CODEX_ACCOUNTS)
    if not idx:
        raise RuntimeError("tokenmaxxing codex-accounts.json unreadable")
    now, live_id = time.time(), codex_live_account_id()
    out = []
    for a in idx.get("accounts", []):
        session_pct, weekly_pct = codex_window_pcts(a, now)
        out.append(Account(
            provider="openai-codex", id=a["accountId"], email=a["email"],
            needs_reauth=bool(a.get("needsReauth")), session_pct=session_pct,
            weekly_pct=weekly_pct, gated_pct=0, is_live=(a["accountId"] == live_id),
            cred=CredFile(os.path.join(TM_CODEX_CREDS, a["credFile"] + ".json")),
            plan=(a.get("planType") or "").lower(),
        ))
    return out


def find_account(accounts, email_or_id):
    for a in accounts:
        if a.email == email_or_id or a.id == email_or_id:
            return a
    hits = [a for a in accounts if a.id.startswith(email_or_id)]
    return hits[0] if len(hits) == 1 else None


# ---------------------------------------------------------------- state.json
def empty_provider_state():
    return {"pin": None, "seat": None, "cooldowns": {}}


def migrate(raw, by_email, now):
    """v1 -> v2, pure and idempotent.

    v1 keyed assignments by "<pid>:<lstart>", which no session id can be
    recovered from, so they are dropped: they were a display cache and a vend
    counter, and the next request of each live session rebuilds them. The v1
    pin holds an email; it is resolved to an account id here, the one boundary
    that has the index in hand.
    """
    if raw.get("version") == 2:
        for provider in PROVIDERS:
            raw.setdefault("providers", {}).setdefault(provider, empty_provider_state())
        raw.setdefault("sessions", {})
        return raw
    anthropic = empty_provider_state()
    if raw.get("pin"):
        hit = by_email.get(raw["pin"])
        if hit:
            anthropic["pin"] = hit
        else:
            log("migrate_pin_dropped", email=raw["pin"])
    seat = raw.get("seat") or {}
    if seat.get("uuid"):
        anthropic["seat"] = {"account_id": seat["uuid"], "since": seat.get("assigned_at", now)}
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
    return migrate(raw, by_email, time.time())


def intent_for(state, key, provider):
    """Project state.json down to the three facts the resolver needs."""
    prov = state["providers"].get(provider) or empty_provider_state()
    rec = state["sessions"].get(key.key) if key else None
    pin = ((rec or {}).get("pins") or {}).get(provider) or {}
    seat = prov.get("seat") or {}
    return Intent(session_pin=pin.get("account_id"),
                  session_pin_force=bool(pin.get("force")),
                  pool_pin=prov.get("pin"),
                  seat=seat.get("account_id"))


# ---------------------------------------------------------------- the pure core
def unusable_reason(a, cooldowns, cfg, now):
    """None when the account can serve, else why it cannot."""
    if a.needs_reauth:
        return "needs-reauth"
    if cooldowns.get(a.id, 0) > now:
        return "cooldown"
    if a.session_pct >= cfg["five_hour_max_pct"] or a.weekly_pct >= cfg["seven_day_max_pct"]:
        return "depleted"
    if a.gated_pct >= cfg["seven_day_max_pct"]:
        return "depleted"
    if a.is_live and not cfg["allow_active_account"]:
        return "live-elsewhere"
    return None


def format_reason(a, cooldowns, cfg, now):
    """unusable_reason with a cooldown countdown, for a human or JSON row."""
    reason = unusable_reason(a, cooldowns, cfg, now)
    if reason == "cooldown":
        left = max(0.0, cooldowns.get(a.id, now) - now)
        return f"cooldown {max(1, int(left // 60))}m"
    return reason


def account_score(a, in_use, cfg):
    """Lower is better. Usage headroom leads; sessions already on the account
    and the account another tool is live on are smoothing penalties."""
    return (max(a.session_pct, a.weekly_pct)
            + in_use.get(a.id, 0) * cfg["session_penalty"]
            + (cfg["active_account_penalty"] if a.is_live else 0))


def rank(accounts, in_use, cooldowns, cfg, now):
    """Usable accounts, best first."""
    usable = [a for a in accounts if unusable_reason(a, cooldowns, cfg, now) is None]
    return sorted(usable, key=lambda a: (account_score(a, in_use, cfg), a.email))


PLAN_TIERS = {"free": 0, "plus": 1, "pro": 2, "team": 3}


def plan_tier(a):
    """Codex plan rank. An account with no plan (every anthropic account, and a
    codex account whose planType we do not know) sits at the bottom, so the
    upgrade rule below is a no-op for anthropic."""
    return PLAN_TIERS.get(a.plan, 0)


def resolve(intent, accounts, in_use, cooldowns, cfg, now):
    """The precedence table, and the only place it exists.

    session pin > pool pin > seat > best candidate. The seat alone also yields to
    a usable account on a strictly higher codex plan ("seat_upgrade"): the seat
    otherwise only moves when it cannot serve, so a free account taken while the
    paid one was depleted would hold every unpinned session after the paid
    window resets, and the API refuses several models on a free plan.

    A session pin yields when
    its account cannot serve (nothing is written, so it re-applies the moment
    the window resets) unless it was set with --force, which yields only when
    the credential itself cannot serve. A pool pin is an operator override with
    machine-wide blast radius and keeps its v1 meaning: skipped on needs-reauth
    only.
    """
    by_id = {a.id: a for a in accounts}
    shadowed = None

    if intent.session_pin:
        a = by_id.get(intent.session_pin)
        why = "missing" if a is None else unusable_reason(a, cooldowns, cfg, now)
        if a is not None and (why is None or (intent.session_pin_force and not a.needs_reauth)):
            return Resolution(a, "session_pin", None)
        shadowed = (intent.session_pin, why)

    if intent.pool_pin:
        a = by_id.get(intent.pool_pin)
        if a is not None and not a.needs_reauth:
            return Resolution(a, "pool_pin", shadowed)

    if intent.seat:
        a = by_id.get(intent.seat)
        if a is not None and unusable_reason(a, cooldowns, cfg, now) is None:
            better = [c for c in rank(accounts, in_use, cooldowns, cfg, now)
                      if plan_tier(c) > plan_tier(a)]
            if better:
                return Resolution(better[0], "seat_upgrade", shadowed)
            return Resolution(a, "seat", shadowed)

    pool = rank(accounts, in_use, cooldowns, cfg, now)
    return Resolution(pool[0], "seat_move", shadowed) if pool else None


def in_use_counts(state, provider):
    """Sessions currently vending each account, for the picker's smoothing."""
    counts = {}
    for rec in state["sessions"].values():
        vend = (rec.get("vends") or {}).get(provider)
        if vend:
            counts[vend["account_id"]] = counts.get(vend["account_id"], 0) + 1
    return counts


class HookWriter:
    """The hook's whole mutation surface on state.json. It never writes a pin."""

    def __init__(self, state):
        self._state = state

    def record_vend(self, key, provider, account, source, reason, shadowed, now):
        rec = self._state["sessions"].setdefault(key.key, {})
        rec["uuid"], rec["active_id"] = key.uuid, key.active_id
        rec["pid"], rec["pid_start"] = os.getppid(), (proc_info(os.getppid()) or {}).get("start")
        rec["last_seen"] = now
        rec.setdefault("pins", {})
        prev = (rec.setdefault("vends", {})).get(provider) or {}
        same = prev.get("account_id") == account.id
        rec["vends"][provider] = {
            "account_id": account.id, "email": account.email, "source": source,
            "reason": reason, "shadowed": list(shadowed) if shadowed else None,
            "at": now, "n": (prev.get("n", 0) + 1) if same else 1,
        }
        return rec["vends"][provider]

    def move_seat(self, provider, account, now):
        self._state["providers"][provider]["seat"] = {"account_id": account.id, "since": now}

    def set_cooldown(self, provider, account_id, until):
        self._state["providers"][provider]["cooldowns"][account_id] = until

    def prune(self, cfg, now):
        """Drop expired cooldowns, and sessions that have not vended for
        pin_ttl_sec. Returns whether anything changed, so a request that prunes
        nothing does not rewrite the file. Liveness is NOT a pid test: a session
        resumed in a new worker keeps its pin, which is the whole point of
        keying by uuid."""
        dropped = 0
        for provider in PROVIDERS:
            cd = self._state["providers"][provider]["cooldowns"]
            for account_id in [u for u, t in cd.items() if t <= now]:
                del cd[account_id]
                dropped += 1
        ttl = cfg["pin_ttl_sec"]
        for key in list(self._state["sessions"]):
            rec = self._state["sessions"][key]
            last = max([rec.get("last_seen") or 0]
                       + [(p or {}).get("at", 0) for p in (rec.get("pins") or {}).values()])
            if now - last > ttl:
                del self._state["sessions"][key]
                dropped += 1
        return dropped > 0


class IntentWriter:
    """`pi-pool use` / `pin` / `unpin` / `switch`. It never writes a vend."""

    def __init__(self, state):
        self._state = state

    def set_pin(self, key, provider, account_id, force, by, now):
        rec = self._state["sessions"].setdefault(key.key, {})
        rec["uuid"], rec["active_id"] = key.uuid, key.active_id
        rec.setdefault("vends", {})
        rec.setdefault("last_seen", now)
        rec.setdefault("pins", {})[provider] = {"account_id": account_id, "at": now,
                                                "force": bool(force), "by": by}

    def clear_pin(self, key, provider):
        rec = self._state["sessions"].get(key.key)
        if rec:
            (rec.get("pins") or {}).pop(provider, None)

    def set_pool_pin(self, provider, account_id):
        self._state["providers"][provider]["pin"] = account_id

    def clear_pool_pin(self, provider):
        self._state["providers"][provider]["pin"] = None

    def clear_seat(self, provider):
        self._state["providers"][provider]["seat"] = None


# ----------------------------------------------------------------- credentials
def credential_for_keychain(a, cfg):
    """(access_token, source). Never refreshes the live item: while an
    account is live, Claude Code owns its rotation."""
    service = LIVE_SERVICE if a.is_live else a.cred.service
    raw = kc_read(service)
    if not raw:
        raise RuntimeError(f"no credential in {service}")
    creds = json.loads(raw)["claudeAiOauth"]
    remaining = (creds["expiresAt"] - time.time() * 1000) / 1000
    if remaining > cfg["refresh_skew_sec"]:
        return creds["accessToken"], ("live" if a.is_live else "parked")
    if a.is_live:
        raise RuntimeError("live credential expiring; leaving rotation to Claude Code")

    with Flock(TM_LOCK, timeout=TM_LOCK_TIMEOUT):
        creds2 = recover_rotation(service, KeychainAdapter(service))
        if (creds2["expiresAt"] - time.time() * 1000) / 1000 > cfg["refresh_skew_sec"]:
            return creds2["accessToken"], "parked"
        merged = refresh_token(creds2)
        # A refresh rotates the grant server-side the instant it returns: journal
        # it BEFORE the keychain write, or a crash in between strands the account
        # on a superseded refresh token that neither pi nor Claude Code can use.
        journal_write(service, merged)
        KeychainAdapter(service).write(merged)
        journal_clear(service)
        log("refreshed", account=a.email, provider="anthropic",
            expires_in_h=round((merged["expiresAt"] - time.time() * 1000) / 3600000, 2))
        return merged["accessToken"], "refreshed"


def credential_for_codex(a, cfg):
    """(access_token, source). Never refreshes the account named by
    ~/.codex/auth.json, nor one with a live-session presence file; both are
    tokenmaxxing's own refusal rules for a grant another tool owns."""
    if a.is_live:
        blob = load_json(CODEX_AUTH_PATH)
        token = ((blob or {}).get("tokens") or {}).get("access_token")
        if not token:
            raise RuntimeError("no credential in ~/.codex/auth.json")
        remaining = jwt_claims(token)["exp"] - time.time()
        if remaining <= cfg["refresh_skew_sec"]:
            raise RuntimeError("live codex credential expiring; leaving rotation to the codex CLI")
        assert_codex_identity(token, a.id)
        return token, "live"

    if a.id in codex_presence_ids():
        raise RuntimeError("codex session running on it")

    store_key = os.path.splitext(os.path.basename(a.cred.path))[0]
    with Flock(TM_CODEX_LOCK, timeout=TM_LOCK_TIMEOUT):
        blob = recover_rotation(store_key, CodexFileAdapter(a.cred.path))
        token = blob["tokens"]["access_token"]
        remaining = jwt_claims(token)["exp"] - time.time()
        if remaining > cfg["refresh_skew_sec"]:
            assert_codex_identity(token, a.id)
            return token, "parked"
        fresh = refresh_codex_token(blob["tokens"]["refresh_token"])
        merged = merge_codex_tokens(blob, fresh)
        journal_write(store_key, merged)
        CodexFileAdapter(a.cred.path).write(merged)
        journal_clear(store_key)
        token = merged["tokens"]["access_token"]
        assert_codex_identity(token, a.id)
        log("refreshed", account=a.email, provider="openai-codex",
            expires_in_h=round((jwt_claims(token)["exp"] - time.time()) / 3600, 2))
        return token, "refreshed"


def credential_for(a, cfg):
    if isinstance(a.cred, Keychain):
        return credential_for_keychain(a, cfg)
    if isinstance(a.cred, CredFile):
        return credential_for_codex(a, cfg)
    raise RuntimeError(f"unknown credential kind for {a.id}")


def fallback_token(cfg):
    """The user's own anthropic OAuth grant (independent family), used only
    when no pooled account can serve. Codex has no equivalent: a codex vend
    failure exits non-zero and the daemon falls back to the stored login."""
    fb = load_json(FALLBACK)
    if not fb:
        return None
    if "anthropic" not in fb:
        fb = {"anthropic": fb}
    creds = fb["anthropic"]
    if creds.get("type") != "oauth":
        return None
    if (creds["expires"] - time.time() * 1000) / 1000 > cfg["refresh_skew_sec"]:
        return creds["access"]
    fresh = refresh_token({"refreshToken": creds["refresh"], "scopes": creds.get("scopes")})
    creds = {"type": "oauth", "access": fresh["accessToken"],
             "refresh": fresh["refreshToken"], "expires": fresh["expiresAt"]}
    fb["anthropic"] = creds
    save_json(FALLBACK, fb)
    log("fallback_refreshed")
    return creds["access"]


# ---------------------------------------------------------------------- vend
def vend(provider):
    """Resolve one account for this session and write its access token to
    stdout. stdout is the token and nothing else; every other byte goes to
    the log.

    Lock discipline: take the pool flock for read + prune + resolve only,
    release it, fetch or refresh the credential under tokenmaxxing's own
    lock, then re-take the pool flock to record the vend. The pool flock is
    never held across a refresh, so `pi-pool use` never queues behind one.
    """
    cfg = config()
    accounts = load_index(provider)
    key = session_key()

    with Flock(LOCK, timeout=STATE_LOCK_TIMEOUT):
        state = load_state()
        now = time.time()
        if HookWriter(state).prune(cfg, now):
            save_json(STATE, state)
        intent = intent_for(state, key, provider)
        in_use = in_use_counts(state, provider)
        cooldowns = dict(state["providers"][provider]["cooldowns"])
        res = resolve(intent, accounts, in_use, cooldowns, cfg, now)

    if res is None:
        raise RuntimeError(f"no usable {provider} account")

    order = [res.account] + [a for a in rank(accounts, in_use, cooldowns, cfg, now)
                             if a.id != res.account.id]
    errors = []
    for account in order:
        try:
            token, source = credential_for(account, cfg)
        except Exception as e:
            errors.append(f"{account.email}: {e}")
            log("account_unusable", provider=provider, account=account.email, error=str(e))
            continue
        reason = res.reason if account.id == res.account.id else "seat_move"
        with Flock(LOCK, timeout=STATE_LOCK_TIMEOUT):
            state = load_state()
            writer = HookWriter(state)
            if reason in ("seat_move", "seat_upgrade"):
                writer.move_seat(provider, account, now)
            vended = writer.record_vend(key, provider, account, source, reason,
                                        res.shadowed, now) if key else None
            save_json(STATE, state)
        # The hook runs on every provider request, so a line per vend would be a log of
        # thousands. Log the transitions only: a session changing account, and a seat move.
        if vended is None or vended["n"] == 1 or reason in ("seat_move", "seat_upgrade"):
            log("vend", provider=provider, account=account.email, source=source,
                reason=reason, shadowed=res.shadowed and res.shadowed[0])
        sys.stdout.write(token)
        return

    raise RuntimeError("no usable account; " + "; ".join(errors))


# ------------------------------------------------------------------------ CLI
def parse_flags(rest, provider_default="anthropic"):
    provider, session, as_json, force, follow, positional = provider_default, None, False, False, False, []
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
        else:
            positional.append(tok)
        i += 1
    return {"provider": provider, "session": session, "json": as_json,
            "force": force, "follow": follow, "positional": positional}


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


def build_rows(accounts, intent, in_use, cooldowns, cfg, now, current_id, seat_id):
    """The rows /account renders. Pure: no I/O, no clock reads beyond `now`."""
    rows = []
    for a in accounts:
        reason = format_reason(a, cooldowns, cfg, now)
        pinned = a.id in (intent.session_pin, intent.pool_pin)
        force = a.id == intent.session_pin and intent.session_pin_force
        usable = reason is None
        row = {
            "id": a.id, "email": a.email,
            "usage": f"{a.session_pct}%/{a.weekly_pct}%",
            "session_pct": a.session_pct, "weekly_pct": a.weekly_pct,
            "usable": usable, "reason": reason,
            "current": a.id == current_id, "pinned": pinned, "force": force,
            "live": a.is_live, "seat": a.id == seat_id,
            "score": round(account_score(a, in_use, cfg)) if usable else None,
        }
        if a.plan:
            row["plan"] = a.plan
        rows.append(row)
    return rows


def _bundle_patched():
    try:
        import importlib.util
        spec = importlib.util.spec_from_file_location(
            "patch_prime_agent", os.path.join(CODE_ROOT, "app", "patch_prime_agent.py"))
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        return mod.check(quiet=True) == 0
    except Exception:
        return False


def _run_patch_module(argv):
    import importlib.util
    spec = importlib.util.spec_from_file_location(
        "patch_prime_agent", os.path.join(CODE_ROOT, "app", "patch_prime_agent.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod.main(argv)


def cmd_status(rest=()):
    f = parse_flags(rest, provider_default=None)
    cfg, now = config(), time.time()
    state = load_state()
    for provider in ([f["provider"]] if f["provider"] else list(PROVIDERS)):
        try:
            accounts = load_index(provider)
        except Exception as e:
            print(f"=== {provider} ===\n{e}\n")
            continue
        in_use = in_use_counts(state, provider)
        cooldowns = state["providers"][provider]["cooldowns"]
        pool_pin = state["providers"][provider].get("pin")
        seat = state["providers"][provider].get("seat")
        by_id = {a.id: a for a in accounts}
        print(f"=== {provider} ===")
        if pool_pin:
            hit = by_id.get(pool_pin)
            print(f"pool pin: {hit.email if hit else pool_pin}")
        elif seat:
            hit = by_id.get(seat["account_id"])
            print(f"seat: {hit.email if hit else seat['account_id']}, "
                  f"held {fmt_dur(now - seat.get('since', now))}")
        else:
            print("seat: unset (first vend picks)")
        print(f"{'account':30s} {'usage':>10} {'sessions':>9} {'score':>6}  state")
        for a in sorted(accounts, key=lambda a: a.email):
            reason = format_reason(a, cooldowns, cfg, now)
            n = in_use.get(a.id, 0)
            sc = f"{account_score(a, in_use, cfg):6.0f}" if reason is None else "     -"
            flags = []
            if seat and seat.get("account_id") == a.id:
                flags.append("seat")
            if pool_pin == a.id:
                flags.append("pinned")
            if a.is_live:
                flags.append("live")
            if reason:
                flags.append(reason)
            usage = f"{a.session_pct}%/{a.weekly_pct}%"
            print(f"{a.email:30s} {usage:>9} {n:9d} {sc}  {' '.join(flags) or 'available'}")
        active = sum(1 for rec in state["sessions"].values() if (rec.get("vends") or {}).get(provider))
        print(f"active sessions: {active}\n")
    return 0


def cmd_watch(rest):
    interval, passthrough = 30, []
    for tok in rest:
        if tok.isdigit():
            interval = int(tok)
        else:
            passthrough.append(tok)
    while True:
        sys.stdout.write("\x1b[2J\x1b[H")
        print(time.strftime("%H:%M:%S"), f"(every {interval}s, ctrl-c to quit)")
        cmd_status(passthrough)
        time.sleep(interval)


def cmd_pin(rest):
    f = parse_flags(rest)
    provider, positional = f["provider"], f["positional"]
    if not positional:
        raise SystemExit("usage: pi-pool pin <email> [--provider <p>]")
    accounts = load_index(provider)
    account = find_account(accounts, positional[0])
    if account is None:
        known = ", ".join(a.email for a in accounts)
        raise SystemExit(f"{positional[0]} is not in the {provider} pool ({known})")
    with Flock(LOCK, timeout=STATE_LOCK_TIMEOUT):
        state = load_state()
        if state["providers"][provider].get("pin") == account.id:
            print(f"already pinned: {account.email}")
            return 0
        IntentWriter(state).set_pool_pin(provider, account.id)
        save_json(STATE, state)
    log("pin", provider=provider, account=account.email)
    print(f"pinned: every {provider} request now vends {account.email} "
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
    print(f"unpinned {was}; seat rules take over for {provider}")
    return 0


def cmd_switch(rest):
    f = parse_flags(rest)
    provider = f["provider"]
    with Flock(LOCK, timeout=STATE_LOCK_TIMEOUT):
        state = load_state()
        was = state["providers"][provider].get("seat")
        IntentWriter(state).clear_seat(provider)
        save_json(STATE, state)
    log("seat_cleared", provider=provider, account=was and was.get("account_id"))
    print(f"seat cleared for {provider} (was {was['account_id'] if was else 'unset'}); "
          f"the next request re-picks the best account")
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


def cmd_use(rest):
    f = parse_flags(rest)
    provider, positional = f["provider"], f["positional"]
    with Flock(LOCK, timeout=STATE_LOCK_TIMEOUT):
        state = load_state()
        key = session_key_for(f["session"], state)
        if key is None:
            if f["session"] is not None:
                print(f"--session {f['session']} matches no known session")
                return 2
            print("no session id in this environment. Run this inside a Prime Agent "
                  "session, or pass --session <id>.")
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
            raise SystemExit("usage: pi-pool use <email|id> [--force] [--follow]")
        try:
            accounts = load_index(provider)
        except Exception as e:
            print(f"cannot load the {provider} pool: {e}")
            return 2
        account = find_account(accounts, positional[0])
        if account is None:
            known = ", ".join(a.email for a in accounts)
            print(f"{positional[0]} is not in the {provider} pool ({known})")
            return 2
        if prev_pin and prev_pin["account_id"] == account.id and bool(prev_pin.get("force")) == f["force"]:
            print(f"already on {account.email}")
            return 0
        IntentWriter(state).set_pin(key, provider, account.id, f["force"], "cli", time.time())
        save_json(STATE, state)
        log("use", session=key.key, provider=provider, account=account.email,
            previous=prev_pin["account_id"] if prev_pin else None, force=f["force"])
        print(f"{account.email} selected for this session tree; applies on the next request")
        return 0


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
    intent = intent_for(state, key, provider) if key else Intent()
    in_use = in_use_counts(state, provider)
    cooldowns = state["providers"][provider]["cooldowns"]
    current_id = None
    if key:
        rec = state["sessions"].get(key.key) or {}
        current_id = ((rec.get("vends") or {}).get(provider) or {}).get("account_id")
    seat_id = (state["providers"][provider].get("seat") or {}).get("account_id")
    rows = build_rows(accounts, intent, in_use, cooldowns, cfg, now, current_id, seat_id)
    seat_account = next((a for a in accounts if a.id == seat_id), None) if seat_id else None
    out = {"provider": provider, "session": key.key if key else None, "patched": _bundle_patched(),
           "seat": {"id": seat_account.id, "email": seat_account.email} if seat_account else None,
           "rows": rows}
    if f["json"]:
        print(json.dumps(out, indent=2))
        return 0
    print(f"{provider}  session {out['session'] or '-'}  patched {out['patched']}")
    if out["seat"]:
        print(f"seat: {out['seat']['email']}")
    width = max([len("account")] + [len(r["email"]) for r in rows])
    print(f"{'account':{width}s} {'usage':>9}  flags")
    for r in rows:
        flags = []
        if r["seat"]:
            flags.append("seat")
        if r["pinned"]:
            flags.append("pinned+force" if r["force"] else "pinned")
        if r["current"]:
            flags.append("current")
        if r["live"]:
            flags.append("live")
        if r["reason"]:
            flags.append(r["reason"])
        print(f"{r['email']:{width}s} {r['usage']:>9}  {' '.join(flags) or 'available'}")
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
    for provider in PROVIDERS:
        try:
            accounts = load_index(provider)
        except Exception as e:
            providers_out[provider] = {"error": str(e)}
            continue
        intent = intent_for(state, key, provider) if key else Intent()
        in_use = in_use_counts(state, provider)
        cooldowns = state["providers"][provider]["cooldowns"]
        res = resolve(intent, accounts, in_use, cooldowns, cfg, now)
        rec = state["sessions"].get(key.key) if key else None
        vend_rec = ((rec or {}).get("vends") or {}).get(provider) or {}
        providers_out[provider] = {
            "account": res.account.id if res else None,
            "email": res.account.email if res else None,
            "reason": res.reason if res else None,
            "pinned": bool(intent.session_pin),
            "shadowed": list(res.shadowed) if res and res.shadowed else None,
            "at": vend_rec.get("at"),
        }
    out = {"session": key.key if key else None, "providers": providers_out}
    if f["json"]:
        print(json.dumps(out, indent=2))
    else:
        for provider, info in out["providers"].items():
            if info.get("error"):
                print(f"{provider:14s} unavailable: {info['error']}")
                continue
            if not info["email"]:
                print(f"{provider:14s} no usable account")
                continue
            why = "pinned" if info["pinned"] else info["reason"]
            line = f"{provider:14s} {info['email']}  ({why})"
            if info["shadowed"]:
                line += f"  pin {info['shadowed'][0]} {info['shadowed'][1]}"
            print(line)
    return 0


def cmd_enable(rest):
    if rest != ["openai-codex"]:
        raise SystemExit("usage: pi-pool enable openai-codex")
    agent_dir = os.environ.get("PRIME_AGENT_CODING_AGENT_DIR") or os.path.join(HOME, ".prime", "agent")
    models_path = os.path.join(agent_dir, "models.json")

    models = load_json(models_path, {}) or {}
    providers = models.setdefault("providers", {})
    entry = {"baseUrl": "https://chatgpt.com/backend-api",
             "api": "openai-codex-responses",
             "apiKey": f"!{shlex.quote(os.path.join(CODE_ROOT, 'bin', 'pi-pool-token'))} --provider openai-codex"}
    changed = providers.get("openai-codex") != entry
    if changed:
        providers["openai-codex"] = entry
        save_json(models_path, models)

    log("enable", provider="openai-codex", agent_dir=agent_dir, changed=changed)
    status = "enabled" if changed else "already enabled"
    print(f"openai-codex {status} in {models_path}. The native login remains managed by Prime.")
    return 0


USAGE = """usage: pi-pool [command]
  status [--provider <p>]        pool, seat, scores, per provider (default: both)
  watch [sec] [--provider <p>]   repaint status every sec seconds (default 30)
  pin <email> [--provider <p>]   force EVERY request onto one account until unpin
  unpin [--provider <p>]         release the pool pin (seat rules take over again)
  switch [--provider <p>]        drop the seat; the next request re-picks the best account
  use <email|id> [--force] [--follow] [--provider <p>] [--session <id>]
                                  pin (or, with --follow, unpin) this session tree
  ls [--json] [--provider <p>] [--session <id>]
                                  the rows /account renders
  who [--json] [--session <id>]  what this session resolves to now, per provider
  enable openai-codex            wire the openai-codex provider into models.json
  config                         print the merged config
  set <key> <value>              persist a config override
  log [n]                        last n pool events (default 20)
  patch [--check]                put the pool into the Prime Agent TUI (tray, splash, agents
                                  view) and make the models.json hook win over a stored /login;
                                  re-run after prime-agent update
  unpatch                        restore the unpatched prime-agent bundle"""


def cli(args):
    cmd, rest = (args[0] if args else "status"), args[1:]
    handlers = {
        "status": cmd_status, "watch": cmd_watch, "pin": cmd_pin, "unpin": cmd_unpin,
        "switch": cmd_switch, "use": cmd_use, "ls": cmd_ls, "who": cmd_who,
        "config": cmd_config, "set": cmd_set, "log": cmd_log, "enable": cmd_enable,
    }
    if cmd in handlers:
        return handlers[cmd](rest)
    if cmd in ("patch", "unpatch"):
        return _run_patch_module(["unpatch"] if cmd == "unpatch" else (rest or ["apply"]))
    raise SystemExit(USAGE)


def main():
    argv = sys.argv[1:]
    if argv and argv[0] == "--cli":
        return cli(argv[1:])
    if "--status" in argv:
        return cmd_status([])
    provider = "anthropic"
    if "--provider" in argv:
        provider = argv[argv.index("--provider") + 1]
    try:
        vend(provider)
    except SystemExit:
        raise
    except Exception as e:
        # This hook IS the credential path for every request on this provider: a
        # crash here would surface as "No API key found". anthropic degrades to the
        # user's own grant; codex has none, so it exits non-zero and the daemon
        # falls through to the stored /login on a patched bundle.
        log("vend_error", error=f"{type(e).__name__}: {e}", provider=provider)
        if provider == "anthropic":
            token = fallback_token(config())
            if token:
                sys.stdout.write(token)
                return
        raise


if __name__ == "__main__":
    sys.dont_write_bytecode = True
    sys.exit(main() or 0)
