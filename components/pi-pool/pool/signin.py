"""`pi-pool login`: an OAuth sign-in driven as JSON lines, and `pi-pool file-login`, which
files the login in the account store of the machine that holds the accounts.

A sign-in runs where its browser is. Claude uses PKCE with a localhost callback (or a
pasted code); Codex uses the device-code flow. The login is then filed by the holder:
in this process when this machine holds the accounts, else through `pi-pool serve`."""
import base64, datetime, hashlib, http.server, json, os, queue, secrets, select, signal, sys, threading, time, uuid
import urllib.error, urllib.parse, urllib.request

from . import base, registry, remote, status_view

LOGIN_TIMEOUT_SEC = 15 * 60
# Claude Code's own OAuth client (claude 2.1.301), the client every pooled grant was issued to.
CLAUDE_AUTHORIZE_URL = "https://claude.com/cai/oauth/authorize"
CLAUDE_MANUAL_REDIRECT = "https://platform.claude.com/oauth/code/callback"
CLAUDE_SUCCESS_URL = "https://platform.claude.com/oauth/code/success?app=claude-code"
CLAUDE_PROFILE_URL = "https://api.anthropic.com/api/oauth/profile"
CLAUDE_SCOPES = ["org:create_api_key", "user:profile", "user:inference", "user:sessions:claude_code",
                 "user:mcp_servers", "user:file_upload", "user:plugins"]
CLAUDE_PLANS = {"claude_max": "max", "claude_pro": "pro", "claude_enterprise": "enterprise", "claude_team": "team"}
# The Codex CLI's device-code sign-in.
CODEX_ISSUER = "https://auth.openai.com"
CODEX_DEVICE_PAGE = CODEX_ISSUER + "/codex/device"
HTTP_TIMEOUT = 30
MAX_RETRIES = 3


class LoginFailed(Exception):
    pass


class LoginRefused(Exception):
    pass


def b64url(raw):
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def post(url, body, form=False):
    """POST and parse the JSON answer; (status, body or None)."""
    data = urllib.parse.urlencode(body).encode() if form else json.dumps(body).encode()
    req = urllib.request.Request(url, data=data, method="POST", headers={
        "Content-Type": "application/x-www-form-urlencoded" if form else "application/json",
        "Accept": "application/json", "User-Agent": base.USER_AGENT})
    try:
        with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as resp:
            return resp.status, json.loads(resp.read())
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read())
        except ValueError:
            return e.code, None


def claude_profile(access_token):
    req = urllib.request.Request(CLAUDE_PROFILE_URL, headers={
        "Authorization": f"Bearer {access_token}", "Content-Type": "application/json", "User-Agent": base.USER_AGENT})
    with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as resp:
        return json.loads(resp.read())


class Callback(http.server.BaseHTTPRequestHandler):
    """The localhost redirect target: hands the code to the waiting login and sends
    the browser on to Claude's success page."""
    codes = None
    state = None

    def log_message(self, *args):
        pass

    def do_GET(self):
        url = urllib.parse.urlparse(self.path)
        got = urllib.parse.parse_qs(url.query)
        if url.path != "/callback" or got.get("state", [None])[0] != self.state or not got.get("code"):
            self.send_error(400)
            return
        self.codes.put(("callback", got["code"][0]))
        self.send_response(302)
        self.send_header("Location", CLAUDE_SUCCESS_URL)
        self.end_headers()


class Input:
    """stdin as lines without blocking; closing stdin cancels the sign-in."""

    def __init__(self):
        self.fd, self.buf, self.closed = sys.stdin.fileno(), b"", False

    def lines(self, wait):
        if self.closed:
            raise LoginFailed("cancelled")
        if select.select([self.fd], [], [], wait)[0]:
            # os.read, never readline: a pasted code without its newline must not block.
            chunk = os.read(self.fd, 4096)
            if not chunk:
                self.closed = True
                raise LoginFailed("cancelled")
            self.buf += chunk
        out = []
        while b"\n" in self.buf:
            line, self.buf = self.buf.split(b"\n", 1)
            if line.strip():
                out.append(line.strip().decode(errors="replace"))
        return out


def claude_login(emit, stdin, deadline):
    """Sign in to Claude and return the harvest: {"record", "secret"}."""
    verifier = b64url(secrets.token_bytes(32))
    challenge = b64url(hashlib.sha256(verifier.encode()).digest())
    state = b64url(secrets.token_bytes(32))
    codes = queue.Queue()
    handler = type("Handler", (Callback,), {"codes": codes, "state": state})
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    local = f"http://localhost:{server.server_address[1]}/callback"

    def authorize(redirect):
        return CLAUDE_AUTHORIZE_URL + "?" + urllib.parse.urlencode({
            "code": "true", "client_id": base.CLIENT_ID, "response_type": "code", "redirect_uri": redirect,
            "scope": " ".join(CLAUDE_SCOPES), "code_challenge": challenge, "code_challenge_method": "S256", "state": state})
    try:
        emit({"event": "url", "url": authorize(local), "manual_url": authorize(CLAUDE_MANUAL_REDIRECT), "code": None, "paste": True})
        retries = 0
        while True:
            if time.time() > deadline:
                raise LoginFailed("the sign-in did not finish in time")
            found = []
            try:
                found.append(codes.get_nowait())
            except queue.Empty:
                pass
            for line in stdin.lines(0.3):
                code, _, given = line.partition("#")
                if given and given != state:
                    emit({"event": "retry", "message": "That code belongs to another sign-in. Open the link above and try again."})
                    continue
                found.append(("paste", code))
            for how, code in found:
                status, body = post(base.TOKEN_URL, {
                    "grant_type": "authorization_code", "code": code, "client_id": base.CLIENT_ID, "code_verifier": verifier,
                    "state": state, "redirect_uri": local if how == "callback" else CLAUDE_MANUAL_REDIRECT})
                if status == 200 and isinstance(body, dict) and body.get("access_token") and body.get("refresh_token"):
                    return claude_harvest(body)
                retries += 1
                base.log("login_code_refused", provider="anthropic", status=status, how=how)
                if retries >= MAX_RETRIES:
                    raise LoginFailed("Claude refused the sign-in code three times")
                emit({"event": "retry", "message": "That code was not accepted. Open the link and try again."})
    finally:
        server.shutdown()
        server.server_close()


def claude_harvest(tokens):
    """The record and credential of a fresh Claude grant, with its plan from the profile."""
    profile = claude_profile(tokens["access_token"])
    account, org = profile.get("account") or {}, profile.get("organization") or {}
    login_id = account.get("uuid") or (tokens.get("account") or {}).get("uuid")
    if not login_id:
        raise LoginFailed("Claude's profile names no account")
    email = account.get("email") or account.get("email_address") or (tokens.get("account") or {}).get("email_address")
    secret = {"accessToken": tokens["access_token"], "refreshToken": tokens["refresh_token"],
              "expiresAt": int(time.time() * 1000) + int(tokens.get("expires_in") or 8 * 3600) * 1000,
              "scopes": [s for s in (tokens.get("scope") or " ".join(CLAUDE_SCOPES)).split(" ") if s],
              "subscriptionType": CLAUDE_PLANS.get(org.get("organization_type")),
              "rateLimitTier": org.get("rate_limit_tier")}
    from .usage import tier_label
    record = {"id": login_id, "email": email, "tier": tier_label(secret),
              "oauthAccount": {"accountUuid": login_id, "emailAddress": email,
                               "organizationUuid": org.get("uuid") or (tokens.get("organization") or {}).get("uuid"),
                               "organizationName": org.get("name") or (tokens.get("organization") or {}).get("name")}}
    return {"record": record, "secret": secret}


def codex_login(emit, stdin, deadline):
    """Sign in to ChatGPT with a device code and return the harvest."""
    status, start = post(CODEX_ISSUER + "/api/accounts/deviceauth/usercode", {"client_id": base.CODEX_CLIENT_ID})
    if status != 200 or not isinstance(start, dict) or not start.get("device_auth_id"):
        raise LoginFailed(f"ChatGPT did not start a device sign-in (HTTP {status})")
    code = start.get("user_code") or start.get("usercode")
    interval = max(1.0, float(start.get("interval") or 5))
    emit({"event": "url", "url": CODEX_DEVICE_PAGE, "manual_url": None, "code": code, "paste": False})
    while True:
        if time.time() > deadline:
            raise LoginFailed("the sign-in did not finish in time")
        stdin.lines(interval)
        status, grant = post(CODEX_ISSUER + "/api/accounts/deviceauth/token",
                             {"device_auth_id": start["device_auth_id"], "user_code": code})
        if status in (403, 404):
            continue
        if status != 200 or not isinstance(grant, dict) or not grant.get("authorization_code"):
            raise LoginFailed(f"ChatGPT refused the device sign-in (HTTP {status})")
        break
    status, tokens = post(base.CODEX_TOKEN_URL, {
        "grant_type": "authorization_code", "code": grant["authorization_code"], "client_id": base.CODEX_CLIENT_ID,
        "redirect_uri": CODEX_ISSUER + "/deviceauth/callback", "code_verifier": grant.get("code_verifier")}, form=True)
    if status != 200 or not isinstance(tokens, dict) or not tokens.get("refresh_token"):
        raise LoginFailed(f"ChatGPT did not issue tokens (HTTP {status})")
    claims = base.jwt_claims(tokens["id_token"])
    auth = claims.get("https://api.openai.com/auth") or {}
    account_id = auth.get("chatgpt_account_id")
    if not account_id:
        raise LoginFailed("the ChatGPT sign-in names no account")
    secret = {"OPENAI_API_KEY": None, "tokens": {"id_token": tokens["id_token"], "access_token": tokens["access_token"],
                                                 "refresh_token": tokens["refresh_token"], "account_id": account_id},
              "last_refresh": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")}
    return {"record": {"id": account_id, "email": claims.get("email"), "tier": auth.get("chatgpt_plan_type")}, "secret": secret}


# ------------------------------------------------- filing a login, by organization
# One Claude login can belong to several organizations (a personal plan and a team
# seat, say), so a Claude account is keyed by (account uuid, organization uuid). The
# first organization of a login keeps the account uuid as its id; another
# organization gets ORG_ID_NAMESPACE's uuid5 of the pair.
ORG_ID_NAMESPACE = uuid.UUID("5a0f4b8e-6c1d-4f7a-9b2e-3d8c1e7f6a90")


def login_pair(record):
    """(account uuid, organization uuid or None) of a Claude record."""
    org = record.get("oauthAccount") or {}
    return org.get("accountUuid") or record["id"], org.get("organizationUuid")


def place_login(records, harvest):
    """(id, record or None): where a harvested Claude login belongs. A record of the
    same login and organization is signed in again; a record with no organization
    on file matches by login alone."""
    login, org = login_pair(harvest)
    for r in records:
        r_login, r_org = login_pair(r)
        if r_login == login and r_org in (org, None):
            return r["id"], r
    taken = {r["id"] for r in records}
    return (login if login not in taken else str(uuid.uuid5(ORG_ID_NAMESPACE, f"{login}:{org}"))), None


def write_secret(provider, account_id, secret):
    if provider == "anthropic":
        base.kc_write(base.claude_service(account_id), json.dumps({"claudeAiOauth": secret}))
    else:
        base.CodexFileAdapter(base.codex_secret(account_id)).write(secret)


def file_login(provider, harvest, target=None):
    """File a harvested login in this machine's store: its credential under the
    account it belongs to, its record in the index. With `target` (an id, label or
    email), a login of any other account is refused and nothing is written.
    Returns (sentence, account id)."""
    h = harvest["record"]
    with base.index_lock(provider):
        idx = base.read_index(provider)
        records = idx["accounts"]
        want = None
        if target is not None:
            want = registry.find_account(registry.load_index(provider), target)
            if want is None:
                raise LoginRefused(f"{target} is not in the {provider} pool")
        if provider == "anthropic":
            account_id, existing = place_login(records, h)
        else:
            account_id = h["id"]
            existing = next((r for r in records if r["id"] == account_id), None)
        if want is not None and account_id != want.id:
            org = f" ({registry.org_suffix(h)})" if provider == "anthropic" else ""
            raise LoginRefused(f"that sign-in is {h.get('email')}{org}, not {want.label}; nothing changed")
        write_secret(provider, account_id, harvest["secret"])
        fresh = {k: h[k] for k in ("email", "tier", "oauthAccount") if h.get(k) is not None}
        fresh["needsReauth"] = False
        if existing is not None:
            existing.update(fresh)
        else:
            shared = provider == "anthropic" and any(r.get("email") == h.get("email") for r in records)
            label = f"{h.get('email')} ({registry.org_suffix(h)})" if shared else h.get("email") or account_id
            records.append({"id": account_id, "label": label, "windows": [],
                            "addedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(), **fresh})
        base.write_index(provider, idx)
        label = registry.record_labels(records)[account_id] if provider == "anthropic" else \
            next(r for r in records if r["id"] == account_id)["label"]
        size = len(records)
    base.log("login_filed", provider=provider, account=label, id=account_id, new=existing is None)
    account = next(a for a in registry.load_index(provider) if a.id == account_id)
    drop_login_blocks(provider, account)
    try:
        from . import usage
        usage.read_account(provider, account, base.config())
    except Exception as e:
        base.log("login_read_failed", provider=provider, account=label, error=str(e)[:200])
    tier = f" ({h['tier']})" if h.get("tier") else ""
    said = f"added {label}{tier} \u2192 pool now has {size} accounts" if existing is None else f"reauthed {label}{tier}"
    return said, account_id


def cmd_file_login(rest):
    """`pi-pool file-login`: file the harvest on stdin ({"provider", "record", "secret",
    "target"}) in this machine's store. Prints {"message", "id"}; the caller is
    `pi-pool login`, here or on another machine through `pi-pool serve`."""
    try:
        harvest = json.loads(sys.stdin.read())
        provider = harvest["provider"]
    except (ValueError, KeyError, TypeError):
        raise SystemExit("file-login reads one JSON harvest on stdin")
    if provider not in base.PROVIDERS:
        raise SystemExit(f"unknown provider {provider}")
    try:
        said, account_id = file_login(provider, harvest, harvest.get("target"))
    except (LoginRefused, RuntimeError, TimeoutError) as e:
        raise SystemExit(str(e)[:300])
    print(json.dumps({"message": said, "id": account_id}))
    return 0


def file_anywhere(provider, harvest, target):
    """File the login with the machine that holds the accounts. Returns the sentence."""
    cfg = remote.client()
    if cfg is None:
        return file_login(provider, harvest, target)[0]
    try:
        code, out, err = remote.ask(cfg, ["--cli", "file-login"], stdin=json.dumps({**harvest, "provider": provider, "target": target}))
    except remote.Unreachable as e:
        raise LoginRefused(str(e))
    if code:
        raise LoginRefused((err.strip() or out.strip() or f"file-login exited {code}")[:300])
    return json.loads(out)["message"]


def cmd_login(rest):
    """`pi-pool login [<email|id>] [--provider p] [--timeout sec]`: add an account,
    or sign one in again.

    stdout is JSON lines: {"event":"url"} with the sign-in link (Claude: a localhost
    callback link, plus the paste link; Codex: the device page and code),
    {"event":"retry"}, then one {"event":"done","ok":...}. stdin takes a pasted
    Claude sign-in code per line; closing stdin cancels."""
    rest, timeout = list(rest), LOGIN_TIMEOUT_SEC
    if "--timeout" in rest:
        at = rest.index("--timeout")
        try:
            timeout = float(rest[at + 1])
        except (IndexError, ValueError):
            raise SystemExit("--timeout takes seconds")
        del rest[at:at + 2]
    f = status_view.parse_flags(rest)
    provider, positional = f["provider"], f["positional"]
    if provider not in base.PROVIDERS or len(positional) > 1 or timeout <= 0:
        raise SystemExit("usage: pi-pool login [<email|id>] [--provider <p>] [--timeout <sec>]")
    emit = lambda event: (sys.stdout.write(json.dumps(event) + "\n"), sys.stdout.flush())
    target = positional[0] if positional else None

    def stopped(signum, frame):
        raise LoginFailed("the sign-in was stopped")
    signal.signal(signal.SIGTERM, stopped)
    base.log("login_start", provider=provider, target=target)
    try:
        sign_in = claude_login if provider == "anthropic" else codex_login
        harvest = sign_in(emit, Input(), time.time() + timeout)
        result = {"event": "done", "ok": True, "message": file_anywhere(provider, harvest, target)}
    except (LoginFailed, LoginRefused, RuntimeError, OSError) as e:
        result = {"event": "done", "ok": False, "message": str(e)[:300]}
    base.log("login_end", provider=provider, ok=result["ok"], message=result["message"])
    emit(result)
    return 0 if result["ok"] else 1


def drop_login_blocks(provider, account):
    """A new sign-in replaces the credential the provider answered 429 for, so
    its `pi-pool limited` record no longer applies (2026-10-08: sieun@virev.ai
    signed in again on a fresh plan at 0% and stayed limited for 2 h). The same
    goes for a cooldown on a revoked token (2026-10-14: claude11@slack.green
    stayed cooled down 24 h after it signed in again). It also passes claude.ai,
    where updated terms are accepted, so a NEEDS_TERMS cooldown goes too
    (2026-10-08: claude7@slack.green served again right after it signed in
    again). If the terms are still pending, the next request puts the cooldown
    back and moves the turn to another account."""
    with base.Flock(base.LOCK, timeout=base.STATE_LOCK_TIMEOUT):
        state = registry.load_state()
        prov = state["providers"][provider]
        limit = prov["limits"].pop(account.id, None)
        refusal = (prov.get("cooldown_reasons") or {}).get(account.id)
        if refusal not in (base.NEEDS_TERMS, base.TOKEN_REJECTED):
            refusal = None
        if refusal:
            prov["cooldowns"].pop(account.id, None)
            prov["cooldown_reasons"].pop(account.id, None)
        if limit is None and not refusal:
            return
        base.save_json(base.STATE, state)
    if limit is not None:
        base.log("limit_dropped", provider=provider, account=account.label, reason="login")
    if refusal:
        base.log("refusal_dropped", provider=provider, account=account.label, reason="login", refusal=refusal)
