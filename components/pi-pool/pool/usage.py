"""Usage reads: each account's windows from its provider, written into the account index.
`pi-pool refresh` reads the accounts it is asked for now; `pi-pool sample`, run every
minute by the pool host's timer, reads each account whose figure is due."""
import datetime, json, re, threading, time, urllib.error, urllib.parse, urllib.request

from . import base, registry, vending

CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage"
CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage"
READ_TIMEOUT = 10
FIVE_HOURS_SEC = 5 * 3600
WEEK_SEC = 7 * 24 * 3600
# An account is read again after SAMPLE_MIN_SEC when a window is nearly full, and
# after up to SAMPLE_MAX_SEC as its headroom grows; a full window waits for its reset.
# Both are the cadence this pool's usage was sampled at from 2026-09-23 to 2026-10-18
# (26,807 good reads and 2,672 failed ones in the old sampler's log).
SAMPLE_MIN_SEC = 90
SAMPLE_MAX_SEC = 15 * 60
READERS = 4


class RateLimited(Exception):
    def __init__(self, retry_at):
        super().__init__("rate limited")
        self.retry_at = retry_at


def instant_ms(value):
    """An ISO instant as epoch ms, else None."""
    if not isinstance(value, str):
        return None
    # Python 3.9's fromisoformat takes only 3 or 6 fraction digits and no "Z".
    text = re.sub(r"\.(\d+)", lambda m: "." + m.group(1)[:6].ljust(6, "0"), value.replace("Z", "+00:00"))
    try:
        return int(datetime.datetime.fromisoformat(text).timestamp() * 1000)
    except ValueError:
        return None


def get_json(url, headers):
    req = urllib.request.Request(url, headers={"Content-Type": "application/json", **headers})
    try:
        with urllib.request.urlopen(req, timeout=READ_TIMEOUT) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        if e.code == 429:
            after = (e.headers.get("Retry-After") or "").strip()
            raise RateLimited(time.time() + int(after) if after.isdigit() and int(after) > 0 else None) from None
        raise RuntimeError(f"usage read failed (HTTP {e.code})") from None
    except (OSError, ValueError) as e:
        raise RuntimeError(f"usage read failed ({type(e).__name__})") from None


def claude_windows(body, at_ms):
    """Windows from Claude's usage body: the 5h window, the week when the body has
    one (a team seat's has none), and each per-model weekly limit."""
    if not isinstance(body, dict) or not isinstance(body.get("five_hour"), dict) \
            or not isinstance(body["five_hour"].get("utilization"), (int, float)):
        raise RuntimeError("usage read returned no 5h window")
    rows = [("five_hour", FIVE_HOURS_SEC), ("seven_day", WEEK_SEC)]
    out = [{"name": None, "usedPercentage": body[key]["utilization"], "resetsAt": instant_ms(body[key].get("resets_at")),
            "windowSeconds": secs, "sampledAt": at_ms}
           for key, secs in rows if isinstance(body.get(key), dict) and isinstance(body[key].get("utilization"), (int, float))]
    for row in body.get("limits") or []:
        model = ((row.get("scope") or {}).get("model") or {}).get("display_name") if isinstance(row, dict) else None
        if row.get("kind") == "weekly_scoped" and isinstance(row.get("percent"), (int, float)) and isinstance(model, str):
            out.append({"name": model, "usedPercentage": row["percent"], "resetsAt": instant_ms(row.get("resets_at")),
                        "windowSeconds": WEEK_SEC, "sampledAt": at_ms})
    return out


def codex_windows(body, at_ms):
    """Windows from the ChatGPT usage body: the primary and secondary windows of the
    plan, then those of each additional limit under its name."""
    if not isinstance(body, dict):
        raise RuntimeError("usage read returned no body")

    def rows(limit, name):
        for w in ((limit or {}).get("primary_window"), (limit or {}).get("secondary_window")):
            if isinstance(w, dict) and isinstance(w.get("used_percent"), (int, float)):
                yield {"name": name, "usedPercentage": w["used_percent"],
                       "resetsAt": w["reset_at"] * 1000 if isinstance(w.get("reset_at"), (int, float)) else None,
                       "windowSeconds": w.get("limit_window_seconds"), "sampledAt": at_ms}
    out = list(rows(body.get("rate_limit"), None))
    for extra in body.get("additional_rate_limits") or []:
        if isinstance(extra, dict) and isinstance(extra.get("limit_name"), str):
            out += rows(extra.get("rate_limit"), extra["limit_name"])
    return out


def merge_named(fresh, old):
    """Keep the old per-model rows when a read brings none newer: Claude leaves a
    model limit out of a body now and then."""
    named = lambda ws: [w for w in ws if w.get("name") is not None]
    newest = lambda ws: max([0] + [w.get("sampledAt") or 0 for w in ws])
    keep = named(fresh) if named(fresh) and newest(named(old)) <= newest(named(fresh)) else named(old)
    return [w for w in fresh if w.get("name") is None] + keep


def tier_label(creds):
    """'max 20x', 'team', 'pro' from a Claude credential's subscription and rate tier."""
    sub = creds.get("subscriptionType")
    multiplier = next((seg for seg in (creds.get("rateLimitTier") or "").split("_")
                       if len(seg) > 1 and seg.endswith("x") and seg[:-1].isdigit()), None)
    if sub is None:
        return multiplier
    return f"{sub} {multiplier}" if multiplier else sub


def read_account(provider, account, cfg):
    """Read one account's usage and save it in the index. Returns
    {"ok": True, "usage_at"} or {"ok": False, "reason", "retry_at"}."""
    now = time.time()
    record = next((r for r in base.read_index(provider)["accounts"] if r["id"] == account.id), None)
    if record is None:
        return {"ok": False, "reason": "the account left the pool", "retry_at": None}
    retry_at = (record.get("usageRetryAt") or 0) / 1000
    if retry_at > now:
        return {"ok": False, "reason": f"the usage endpoint rate limited this account, next read in "
                                       f"{max(1, round((retry_at - now) / 60))}m", "retry_at": round(retry_at)}
    started = int(now * 1000)
    change, outcome = None, None
    try:
        token, _ = vending.credential_for(account, cfg)
        if provider == "anthropic":
            body = get_json(CLAUDE_USAGE_URL + "?" + urllib.parse.urlencode({"at_wall": 1, "skip_spend": 1}),
                            {"Authorization": f"Bearer {token}", "anthropic-beta": "oauth-2025-04-20"})
            windows = claude_windows(body, started)
            tier = tier_label(base.KeychainAdapter(account.cred.service).read() or {})
            extra = {"tier": tier} if tier else {}
        else:
            body = get_json(CODEX_USAGE_URL, {"Authorization": f"Bearer {token}", "User-Agent": "codex-cli",
                                              "ChatGPT-Account-Id": account.id})
            windows = codex_windows(body, started)
            extra = {k: body[v] for k, v in (("email", "email"), ("tier", "plan_type")) if isinstance(body.get(v), str)}

        def change(rec):
            rec["lastProbeAt"] = started
            if (rec.get("lastUsageAt") or 0) >= started:
                return True
            rec["windows"] = merge_named(windows, rec.get("windows") or []) if provider == "anthropic" else windows
            rec["lastUsageAt"] = started
            rec.pop("usageRetryAt", None)
            rec.update(extra)
            return True
        outcome = {"ok": True, "usage_at": round(started / 1000)}
    except RateLimited as e:
        until = e.retry_at

        def change(rec):
            rec["lastProbeAt"] = started
            if until:
                rec["usageRetryAt"] = int(until * 1000)
            return True
        outcome = {"ok": False, "reason": "the usage endpoint rate limited this account", "retry_at": round(until) if until else None}
    except Exception as e:
        def change(rec):
            rec["lastProbeAt"] = started
            return True
        outcome = {"ok": False, "reason": str(e)[:200], "retry_at": None}
    with base.index_lock(provider):
        if not base.update_account(provider, account.id, change):
            return {"ok": False, "reason": "the account left the pool during the read", "retry_at": None}
    return outcome


def read_many(selection, emit, timeout=registry.REFRESH_TIMEOUT_SEC):
    """Read the accounts of `selection` ({provider: ids or None for all}), READERS at a
    time, and pass each event to `emit`: accounts, reading, read, error. An account
    still unread at the deadline is reported as not finished. Returns the providers
    that failed as a whole."""
    cfg, errors, jobs, lock = base.config(), {}, [], threading.Lock()
    for provider, ids in selection.items():
        try:
            accounts = registry.load_index(provider)
        except Exception as e:
            errors[provider] = str(e)[:300]
            emit({"event": "error", "provider": provider, "message": errors[provider]})
            continue
        chosen = [next((a for a in accounts if a.id == i), i) for i in ids] if ids else accounts
        emit({"event": "accounts", "provider": provider, "accounts": [
            {"id": a, "email": None, "label": a} if isinstance(a, str) else {"id": a.id, "email": a.email, "label": a.label}
            for a in chosen]})
        jobs += [(provider, a) for a in chosen]
    pending = list(jobs)

    def say(event):
        with lock:
            emit(event)

    def worker():
        while True:
            with lock:
                if not jobs:
                    return
                provider, a = jobs.pop(0)
            if isinstance(a, str):
                say({"event": "read", "provider": provider, "id": a, "email": None, "label": a,
                     "ok": False, "reason": "not in the pool", "retry_at": None})
                pending.remove((provider, a))
                continue
            say({"event": "reading", "provider": provider, "id": a.id, "email": a.email, "label": a.label})
            try:
                result = read_account(provider, a, cfg)
            except Exception as e:
                result = {"ok": False, "reason": str(e)[:200], "retry_at": None}
            with lock:
                if (provider, a) in pending:
                    pending.remove((provider, a))
                    emit({"event": "read", "provider": provider, "id": a.id, "email": a.email, "label": a.label, **result})
    threads = [threading.Thread(target=worker, daemon=True) for _ in range(min(READERS, len(jobs)))]
    for t in threads:
        t.start()
    deadline = time.monotonic() + timeout
    for t in threads:
        t.join(max(0.0, deadline - time.monotonic()))
    with lock:
        for provider, a in list(pending):
            emit({"event": "read", "provider": provider, "id": a.id, "email": a.email, "label": a.label,
                  "ok": False, "reason": f"the read did not finish in {timeout}s", "retry_at": None})
        pending.clear()
        jobs.clear()
    return errors


def sample_interval(record, cfg, now):
    """Seconds between two reads of one account: SAMPLE_MAX_SEC scaled by the
    headroom of its fullest window (unnamed, and the gated model caps), never under
    SAMPLE_MIN_SEC; SAMPLE_MAX_SEC once a window is full."""
    families = [f.lower() for f in cfg["switch_models"]]
    windows = [w for w in record.get("windows") or []
               if w.get("name") is None or any(f in registry.family_tokens(w["name"]) for f in families)]
    if not any(w.get("name") is None for w in windows):
        return SAMPLE_MIN_SEC
    used = max(registry.live_pct(w, now) for w in windows)
    if used >= 100:
        return SAMPLE_MAX_SEC
    return max(SAMPLE_MIN_SEC, SAMPLE_MAX_SEC * (1 - used / 100))


def due(provider, cfg, now):
    """The accounts whose figure is older than their sample interval."""
    out = []
    records = {r["id"]: r for r in base.read_index(provider)["accounts"]}
    for a in registry.load_index(provider):
        rec = records.get(a.id) or {}
        last = max(rec.get("lastUsageAt") or 0, rec.get("lastProbeAt") or 0) / 1000
        if not a.needs_reauth and now - last > sample_interval(rec, cfg, now):
            out.append(a.id)
    return out


def cmd_sample(rest=()):
    """`pi-pool sample`: read every account whose usage figure is due. The pool
    host's timer runs it every minute."""
    cfg, now = base.config(), time.time()
    selection = {}
    for provider in base.PROVIDERS:
        try:
            ids = due(provider, cfg, now)
        except Exception as e:
            base.log("sample_failed", provider=provider, error=str(e)[:200])
            continue
        if ids:
            selection[provider] = ids
    if not selection:
        return 0
    failed = []
    read_many(selection, lambda e: failed.append(e.get("label")) if e.get("event") == "read" and not e.get("ok") else None)
    base.log("usage_sample", accounts=sum(len(v) for v in selection.values()), failed=failed)
    failed_claude = set(selection.get("anthropic") or ()) & {a.id for a in registry.load_index("anthropic") if a.label in failed}
    if failed_claude:
        vending.probe_failed_reads(failed_claude)
    return 0
