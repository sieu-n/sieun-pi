"""Usage math, accounts and session keys, tokenmaxxing index loading, and state.json load
and migration."""
import collections, dataclasses, json, os, re, time

from . import base


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
        rec = base.load_json(os.path.join(presence_dir, name))
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
    got = (base.jwt_claims(token).get("https://api.openai.com/auth") or {}).get("chatgpt_account_id")
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
    idx = base.load_json(path)
    if not idx:
        raise RuntimeError(f"tokenmaxxing {os.path.basename(path)} unreadable")
    if idx.get("version") != base.TM_INDEX_VERSION:
        raise RuntimeError(f"tokenmaxxing {os.path.basename(path)} is schema v{idx.get('version')}; "
                           f"pi-pool reads v{base.TM_INDEX_VERSION} (tokenmaxxing >= 1.44)")
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
    idx = _read_index(base.TM_ACCOUNTS)
    cfg, now, live = base.config(), time.time(), presence_account_ids(base.TM_LIVE)
    records = idx.get("accounts", [])
    labels = record_labels(records)
    out = []
    for a in records:
        five, seven = usage_pct(a, now)
        store = base.store_dir(a["id"])
        out.append(Account(
            provider="anthropic", id=a["id"], email=a.get("email") or a["label"], label=labels[a["id"]],
            needs_reauth=bool(a.get("needsReauth")), session_pct=five, weekly_pct=seven,
            gated_pct=gated_pct(a, cfg, now), is_live=a["id"] in live,
            cred=Keychain(base.store_service(store), store),
            tier=a.get("tier") or "", windows=tuple(a.get("windows") or ()),
            usage_at=(a.get("lastUsageAt") or 0) / 1000,
        ))
    return out


def _load_index_codex():
    idx = _read_index(base.TM_CODEX_ACCOUNTS)
    now, live = time.time(), presence_account_ids(base.TM_CODEX_LIVE)
    out = []
    for a in idx.get("accounts", []):
        session_pct, weekly_pct = usage_pct(a, now)
        out.append(Account(
            provider="openai-codex", id=a["id"], email=a.get("email") or a["label"],
            needs_reauth=bool(a.get("needsReauth")), session_pct=session_pct,
            weekly_pct=weekly_pct, gated_pct=0, is_live=a["id"] in live,
            cred=CredFile(os.path.join(base.TM_CODEX_STORES, a["id"][:8], "auth.json")),
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


def migrate(raw, by_email, now, pin_ttl=base.DEFAULTS["pin_ttl_sec"]):
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
        for provider in base.PROVIDERS:
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
            base.log("migrate_pin_dropped", email=raw["pin"])
    anthropic["cooldowns"] = {u: t for u, t in (raw.get("cooldowns") or {}).items() if t > now}
    out = {"version": 2, "providers": {"anthropic": anthropic,
                                       "openai-codex": empty_provider_state()}, "sessions": {}}
    base.log("migrated", dropped_assignments=len(raw.get("assignments") or {}))
    return out


def load_state():
    """Read state.json, migrate a v1 file, and back a v1 file up before the
    first v2 write. Call under the pool flock."""
    raw = base.load_json(base.STATE, {}) or {}
    by_email = {}
    if raw and raw.get("version") != 2:
        os.makedirs(os.path.join(base.POOL, "backups"), exist_ok=True)
        base.save_json(os.path.join(base.POOL, "backups", f"state.json.{int(time.time())}"), raw)
        try:
            by_email = {a.email: a.id for a in load_index("anthropic")}
        except Exception:
            by_email = {}
    return migrate(raw, by_email, time.time(), base.config()["pin_ttl_sec"])
