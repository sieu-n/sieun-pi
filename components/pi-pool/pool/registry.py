"""Usage math, accounts and session keys, account index loading, and state.json load."""
import collections, dataclasses, json, os, re, time

from . import base


# ------------------------------------------------------------- usage math
SESSION_WINDOW_MAX_SEC = 6 * 3600
# `pi-pool sample` reads every account at least every 15 min (usage.SAMPLE_MAX_SEC),
# so a 5h sample older than this is one nobody reads: any account while the
# sampler is down.
STALE_USAGE_SEC = 20 * 60
# A `pi-pool refresh` read has landed or failed by then.
REFRESH_TIMEOUT_SEC = 180


def live_pct(window, now):
    """A window's usable-against percentage NOW: a cached reset that has passed
    means the window is empty again
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
    """A session window is classified by duration, never by position."""
    secs = window.get("windowSeconds")
    return secs is not None and secs <= SESSION_WINDOW_MAX_SEC


def session_window(account):
    """The unnamed session (5h) window."""
    return next((w for w in account.get("windows") or []
                 if w.get("name") is None and is_session_window(w)), None)


def usage_unsampled(a, now):
    """R2: the account's 5h figure is older than STALE_USAGE_SEC, so it says nothing
    about the trees that entered since. On 2026-10-13 the Virev team seat's sample was
    31.6 h old, read as 0%, and the seat took 9 trees from 22:40 to 22:56 KST before
    Anthropic refused it at 23:04."""
    window = session_window({"windows": a.windows})
    return window is not None and now - (window.get("sampledAt") or 0) / 1000 > STALE_USAGE_SEC


def weekly_window(account):
    """The longest unnamed non-session window."""
    rows = [w for w in account.get("windows") or []
            if w.get("name") is None and not is_session_window(w)]
    return max(rows, key=lambda w: w.get("windowSeconds") or 0) if rows else None


def usage_pct(account, now):
    """(session %, weekly %) from an index account's unnamed windows."""
    return live_pct(session_window(account), now), live_pct(weekly_window(account), now)


def family_tokens(name):
    """A model or limit name as tokens: lowercase, split on space, dot and dash."""
    return [t for t in re.split(r"[\s.-]+", name.strip().lower()) if t]


def gated_pct(account, cfg, now):
    """Worst live per-model cap among the gated families (switch_models), over
    the index's NAMED windows."""
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
        sessions.get(key.active_id)  # brings an archived record filed under the short id back for the scan below
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
    """Compact countdown (4d22h / 3h39m / 42m)."""
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
# the account indexes on every request. "A pin exists but its account cannot
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
    """The session tree that owns this process, or None outside one. On the machine that
    holds the accounts, `pi-pool serve` passes the asking machine's key in PI_POOL_SESSION_KEY."""
    forwarded = os.environ.get("PI_POOL_SESSION_KEY")
    if forwarded:
        given = json.loads(forwarded)
        return SessionKey(given["key"], given.get("uuid"), given.get("active"))
    active = os.environ.get(base.SESSION_ENV) or None
    uuid = None
    journal = os.environ.get(base.JOURNAL_ENV)
    if journal:
        worker_id = os.path.basename(journal).split(".", 1)[0]
        desc = base.load_json(os.path.join(os.path.dirname(journal), worker_id + ".json")) or {}
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
    if not hits:
        hits = [k for k, rec in each_archived() if rec.get("active_id") == id_str or k.startswith(id_str)]
    if len(hits) == 1:
        rec = state["sessions"][hits[0]]
        return SessionKey(hits[0], rec.get("uuid"), rec.get("active_id"))
    return None


def assert_codex_identity(token, expected_id):
    """A cheap boundary check against a stale parked file: fail closed
    rather than serve the wrong account's token."""
    got = (base.jwt_claims(token).get("https://api.openai.com/auth") or {}).get("chatgpt_account_id")
    if got != expected_id:
        raise RuntimeError(f"codex token identity mismatch: expected {expected_id}, got {got}")


# ---------------------------------------------------------- boundary parsers
def load_index(provider):
    """Parse one provider's index into Accounts. The only place the index's
    wire shape is understood. Raises when the file is unreadable, which the
    caller degrades on."""
    if provider == "anthropic":
        return _load_index_anthropic()
    if provider == "openai-codex":
        return _load_index_codex()
    raise ValueError(f"unknown provider {provider}")


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
    records = base.read_index("anthropic")["accounts"]
    cfg, now = base.config(), time.time()
    labels = record_labels(records)
    out = []
    for a in records:
        five, seven = usage_pct(a, now)
        out.append(Account(
            provider="anthropic", id=a["id"], email=a.get("email") or a["label"], label=labels[a["id"]],
            needs_reauth=bool(a.get("needsReauth")), session_pct=five, weekly_pct=seven,
            gated_pct=gated_pct(a, cfg, now), cred=Keychain(base.claude_service(a["id"])),
            tier=a.get("tier") or "", windows=tuple(a.get("windows") or ()),
            usage_at=(a.get("lastUsageAt") or 0) / 1000,
        ))
    return out


def _load_index_codex():
    now = time.time()
    out = []
    for a in base.read_index("openai-codex")["accounts"]:
        session_pct, weekly_pct = usage_pct(a, now)
        out.append(Account(
            provider="openai-codex", id=a["id"], email=a.get("email") or a["label"],
            needs_reauth=bool(a.get("needsReauth")), session_pct=session_pct,
            weekly_pct=weekly_pct, gated_pct=0, cred=CredFile(base.codex_secret(a["id"])),
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
    """Apply what state.json knows about each account and the index does not: `pi-pool off` and the provider's own 429 (`pi-pool limited`)."""
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


def normalize(raw):
    """A v2 state with every provider. Pure and idempotent."""
    if raw.get("version") != 2:
        raw = {"version": 2, "providers": {}, "sessions": {}}
    for provider in base.PROVIDERS:
        raw.setdefault("providers", {}).setdefault(provider, empty_provider_state())
    raw.setdefault("sessions", {})
    return raw


def load_state():
    """Read state.json. Call under the pool flock."""
    now, ttl = time.time(), base.config()["pin_ttl_sec"]
    state = normalize(base.load_json(base.STATE, {}) or {})
    state["sessions"] = Sessions(state["sessions"], now, ttl)
    return state


# The session archive: one file per session record that has gone quiet. state.json holds only the records a
# full scan can count (in_use_counts, waits, admissions all look back at most active_session_sec), and every
# hook reads and writes all of state.json under the pool flock. On us-metal02 on 10-18 it held 7,718 records,
# 5,886 of them quiet for over a day, the 2.7 MB file cost about 80 ms a hold, and the flock was held 91% of
# the time. A record looked up by key comes back from the archive whole, so pins, models, moves and priority
# work as before.
SAFE_KEY = re.compile(r"^[0-9A-Za-z][0-9A-Za-z._-]{0,127}$")


def archive_dir():
    return os.path.join(base.POOL, "sessions-archive")


def last_active(rec):
    """When a session record last changed: its last request or its newest pin."""
    return max([rec.get("last_seen") or 0] + [(p or {}).get("at", 0) for p in (rec.get("pins") or {}).values()])


def archive_record(key, rec):
    """Write one record to the archive in one rename. False for a key that is no plain file name."""
    if not SAFE_KEY.match(key):
        return False
    folder = archive_dir()
    os.makedirs(folder, mode=0o700, exist_ok=True)
    path = os.path.join(folder, key + ".json")
    tmp = f"{path}.tmp.{os.getpid()}"
    with open(tmp, "w") as f:
        f.write(json.dumps(rec, separators=(",", ":")))
    os.chmod(tmp, 0o600)
    stamp = last_active(rec)
    os.utime(tmp, (stamp, stamp))
    os.replace(tmp, path)
    return True


def archived_record(key, now, pin_ttl):
    """Read an archived record. Manual selections never expire."""
    if not isinstance(key, str) or not SAFE_KEY.match(key):
        return None
    rec = base.load_json(os.path.join(archive_dir(), key + ".json"))
    if not isinstance(rec, dict) or (not rec.get("pins") and now - last_active(rec) > pin_ttl):
        return None
    return normalize({"version": 2, "sessions": {key: rec}})["sessions"][key]


def sweep_archive(now, pin_ttl):
    """Delete expired automatic records and temporary files left by dead writers."""
    try:
        entries = list(os.scandir(archive_dir()))
    except FileNotFoundError:
        return
    for entry in entries:
        try:
            if ".tmp." in entry.name:
                if not pid_alive(entry.name.rsplit(".", 1)[-1]):
                    os.remove(entry.path)
            elif now - entry.stat().st_mtime > pin_ttl:
                rec = base.load_json(entry.path)
                if not isinstance(rec, dict) or not rec.get("pins"):
                    os.remove(entry.path)
        except FileNotFoundError:
            pass


def pid_alive(pid):
    try:
        os.kill(int(pid), 0)
    except (ValueError, ProcessLookupError):
        return False
    except PermissionError:
        pass
    return True


def each_archived():
    """(key, record) for every archived record, for the rare command that must change them all (forget_account)."""
    try:
        names = sorted(os.listdir(archive_dir()))
    except FileNotFoundError:
        return
    for name in names:
        if name.endswith(".json"):
            rec = base.load_json(os.path.join(archive_dir(), name))
            if isinstance(rec, dict):
                yield name[:-5], rec


class Sessions(dict):
    """state["sessions"]: the records in state.json, and on a lookup by key (`in`, [], get, setdefault) the
    archived record under that key, which then joins state.json at the next save. Iterating sees state.json's
    records only."""

    def __init__(self, hot, now, pin_ttl):
        super().__init__(hot)
        self._now, self._ttl, self._absent = now, pin_ttl, set()

    def _promote(self, key):
        if key in self._absent:
            return None
        rec = archived_record(key, self._now, self._ttl)
        if rec is None:
            self._absent.add(key)
        else:
            dict.__setitem__(self, key, rec)
        return rec

    def __missing__(self, key):
        rec = self._promote(key)
        if rec is None:
            raise KeyError(key)
        return rec

    def __contains__(self, key):
        return dict.__contains__(self, key) or self._promote(key) is not None

    def get(self, key, default=None):
        return self[key] if key in self else default

    def setdefault(self, key, default=None):
        if key not in self:
            dict.__setitem__(self, key, default)
        return dict.__getitem__(self, key)
