"""Banked usage-limit resets: `pi-pool resets` and `pi-pool reset`."""
import concurrent.futures, datetime, json, os, re, shutil, subprocess, time, urllib.request, urllib.error, uuid

from . import base, registry, vending, status_view, limited


# ------------------------------------------------------------- reset grants
# Anthropic banks usage-limit resets on some accounts (program "cedar_ember").
# Reverse engineered from the CLIProxyAPI Management Center
# (src/services/api/claudeResetGrants.ts, resetGrantOperations.ts) and checked
# against live accounts: `GET /api/oauth/usage?cedar_ember=1` returns a
# `cedar_ember` block with the account's grants, and
# `POST /api/organizations/<org>/reset_rate_limits` spends one. The claim's
# request_id makes a retry of the same claim safe, so it is journaled before
# the POST and reused if the outcome was unknown.
RESETS = os.path.join(base.POOL, "resets.json")
RESET_CLAIMS = os.path.join(base.POOL, "reset-claims.json")
RESET_LOCK = os.path.join(base.POOL, "reset.lock")
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
        claude = shutil.which("claude") or os.path.join(base.HOME, ".local", "bin", "claude")
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
    with limited.pool_lock():
        cache = base.load_json(RESETS, {}) or {}
        cache[account_id] = entry
        base.save_json(RESETS, cache)


def reset_rows(accounts):
    """What `ls --json` shows per Claude account: the last grant read and any claim with an unknown outcome."""
    cache, claims = base.load_json(RESETS, {}) or {}, base.load_json(RESET_CLAIMS, {}) or {}
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
    f = status_view.parse_flags(rest)
    if f["provider"] != "anthropic":
        print(json.dumps({"error": "only Claude accounts have resets"}) if f["json"] else "only Claude accounts have resets")
        return 1
    accounts = registry.load_index("anthropic")
    if f["positional"]:
        chosen = []
        for sel in f["positional"]:
            a = registry.find_account(accounts, sel)
            if a is None:
                print(json.dumps({"error": f"{sel} is not in the anthropic pool"}) if f["json"] else f"{sel} is not in the anthropic pool")
                return 1
            chosen.append(a)
        accounts = chosen
    cfg = base.config()

    def read(a):
        entry = {"checked_at": round(time.time())}
        if a.needs_reauth:
            entry["error"] = "the account needs a new sign-in"
            return a, entry
        try:
            entry["status"] = read_grant_status(vending.credential_for(a, cfg)[0])
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
            with limited.pool_lock():
                cache = base.load_json(RESETS, {}) or {}
                cache[a.id] = {**(cache.get(a.id) or {}), "error": entry["error"], "error_at": entry["checked_at"]}
                base.save_json(RESETS, cache)
    base.log("resets_read", accounts=[a.label for a, _ in results], failed=[a.label for a, e in results if "error" in e])
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
    f = status_view.parse_flags(rest)

    def done(code, result, message, **extra):
        out = {"result": result, "message": message, **extra}
        print(json.dumps(out) if f["json"] else message)
        return code

    if f["provider"] != "anthropic" or len(f["positional"]) != 1:
        return done(2, "error", "usage: pi-pool reset <email|id> [--grant <id>] [--json]")
    if grant_arg is not None and not GRANT_ID_RE.match(grant_arg):
        return done(2, "error", "the grant id is not valid")
    a = registry.find_account(registry.load_index("anthropic"), f["positional"][0])
    if a is None:
        return done(1, "error", f"{f['positional'][0]} is not in the anthropic pool")
    cfg = base.config()
    held = base.Flock(RESET_LOCK, timeout=1.0)
    try:
        held.__enter__()
    except TimeoutError:
        return done(1, "error", "another reset is running")
    try:
        token = vending.credential_for(a, cfg)[0]
        org = read_organization(token)
        now = time.time()
        claims = base.load_json(RESET_CLAIMS, {}) or {}
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
                base.save_json(RESET_CLAIMS, claims)
                base.log("reset_resolved", account=a.label, grant=claim["grant_id"], spent=spent)
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
            base.save_json(RESET_CLAIMS, claims)
        payload = {"program": RESET_PROGRAM, "grant_id": claim["grant_id"], "request_id": claim["request_id"]}
        base.log("reset_claim", account=a.label, grant=claim["grant_id"], retry=retry)
        try:
            code, body = anthropic_call(RESET_URL.format(org=org), token, payload, timeout=25.0)
            result = "rate_limited" if code == 429 else "auth_error" if code in (401, 403) else (
                body.get("result") if 200 <= code < 300 and body and body.get("result") in RESET_RESULTS else None)
        except Exception:
            result = None
        # A refusal on a retry cannot prove the first POST did not spend, so only a spend settles it.
        if result is not None and (not retry or result in ("reset", "already_used")):
            claims = base.load_json(RESET_CLAIMS, {}) or {}
            claims[a.id] = {**claim, "code": result}
            base.save_json(RESET_CLAIMS, claims)
        base.log("reset_result", account=a.label, grant=claim["grant_id"], result=result or "unknown")
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
