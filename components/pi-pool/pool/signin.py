"""`pi-pool login`: tokenmaxxing add or auth driven as JSON lines, and filing a Claude
login by organization."""
import datetime, fcntl, json, os, re, shutil, sys, time, uuid

from . import base, registry, status_view, commands


TM_FLAGS = {"anthropic": [], "openai-codex": ["--codex"]}
ANSI_ANY_RE = re.compile(r"\x1b\[[0-9;?<>=]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][0-9A-Za-z]|\x1b[=>78]")
LOGIN_TIMEOUT_SEC = 15 * 60
LOGIN_SETTLE_SEC = 0.8
LOGIN_BROWSER = os.path.join(base.CODE_ROOT, "app", "login-browser")
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
    harvested = (base.load_json(os.path.join(scratch, "accounts.json")) or {}).get("accounts") or []
    if len(harvested) != 1:
        raise LoginRefused("no sign-in was recorded")
    h = harvested[0]
    blob = base.kc_read(base.store_service(os.path.join(scratch, "stores", h["id"][:8])))
    if not blob:
        raise LoginRefused("the sign-in left no credential")
    with base.Flock(base.TM_LOCK, timeout=base.TM_LOCK_TIMEOUT):
        idx = registry._read_index(base.TM_ACCOUNTS)
        records = idx["accounts"]
        account_id, existing = place_login(records, h)
        if target_id is not None and account_id != target_id:
            want = next((r for r in records if r["id"] == target_id), {})
            raise LoginRefused(f"that sign-in is {h.get('email')} ({registry.org_suffix(h)}), not "
                               f"{want.get('email')} ({registry.org_suffix(want)}); nothing changed")
        store = base.store_dir(account_id)
        os.makedirs(store, mode=0o700, exist_ok=True)
        with base.ClaudeRefreshLock(store):
            base.kc_write(base.store_service(store), blob)
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
            records.append({"id": account_id, "label": f"{h.get('email')} ({registry.org_suffix(h)})" if shared else h.get("label") or h.get("email"),
                            "addedAt": h.get("addedAt") or datetime.datetime.now(datetime.timezone.utc).isoformat(),
                            "windows": [], **{k: h[k] for k in ("usageRetryAt",) if k in h}, **fresh})
        tmp = f"{base.TM_ACCOUNTS}.tmp.{os.getpid()}"
        with open(tmp, "w") as f:
            f.write(json.dumps(idx, indent=2) + "\n")
        os.chmod(tmp, 0o600)
        os.replace(tmp, base.TM_ACCOUNTS)
        label = registry.record_labels(records)[account_id]
        size = len(records)
    base.log("login_filed", account=label, id=account_id, new=existing is None)
    tier = f" ({h['tier']})" if h.get("tier") else ""
    said = f"added {label}{tier} \u2192 pool now has {size} accounts" if existing is None else f"reauthed {label}{tier}"
    return said, account_id


def scratch_login_home():
    """A private tokenmaxxing home for one sign-in, with the real config (so
    the same claude binary runs) and nothing else."""
    home = os.path.join(base.POOL, "logins", str(os.getpid()))
    shutil.rmtree(home, ignore_errors=True)
    os.makedirs(home, mode=0o700)
    if os.path.exists(os.path.join(base.TM, "config.json")):
        shutil.copy(os.path.join(base.TM, "config.json"), os.path.join(home, "config.json"))
    return home


def drop_scratch_login(home):
    """Delete every credential a scratch sign-in can leave: the harvested
    store's Keychain item, claude's onboarding item, and the folder."""
    services = [base.store_service(os.path.join(home, "onboard"))]
    for r in (base.load_json(os.path.join(home, "accounts.json")) or {}).get("accounts") or []:
        services.append(base.store_service(os.path.join(home, "stores", r["id"][:8])))
    stores = os.path.join(home, "stores")
    if os.path.isdir(stores):
        services += [base.store_service(os.path.join(stores, name)) for name in os.listdir(stores)]
    for service in dict.fromkeys(services):
        try:
            base.kc_delete(service)
        except RuntimeError as e:
            base.log("login_cleanup_failed", error=str(e))
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
    f = status_view.parse_flags(rest)
    provider, positional = f["provider"], f["positional"]
    if provider not in base.PROVIDERS or len(positional) > 1 or timeout <= 0:
        raise SystemExit("usage: pi-pool login [<email|id>] [--provider <p>] [--timeout <sec>]")
    emit = lambda event: (sys.stdout.write(json.dumps(event) + "\n"), sys.stdout.flush())
    exe = commands.tokenmaxxing_exe()
    if not exe:
        emit({"event": "done", "ok": False, "message": "tokenmaxxing is not installed"})
        return 1
    account = None
    if positional:
        account = registry.find_account(registry.load_index(provider), positional[0])
        if account is None:
            emit({"event": "done", "ok": False, "message": f"{positional[0]} is not in the {provider} pool"})
            return 1
    # Claude always signs in through `add` in a scratch home; file_claude_login
    # then files it by organization (see ORG_ID_NAMESPACE).
    if positional and provider != "anthropic":
        argv = [exe, "auth", *TM_FLAGS[provider], account.id]
    else:
        argv = [exe, "add", *TM_FLAGS[provider]]
    os.makedirs(base.POOL, exist_ok=True)
    home = scratch_login_home() if provider == "anthropic" else None
    try:
        return run_login(provider, argv, home, account, timeout, emit)
    finally:
        if home:
            drop_scratch_login(home)


def run_login(provider, argv, home, account, timeout, emit):
    import pty, select, signal, struct, termios
    url_file = os.path.join(base.POOL, f"login-{os.getpid()}.urls")
    env = dict(os.environ, TOKENMAXXING_HOME=home or base.TM, BROWSER=LOGIN_BROWSER, PI_POOL_LOGIN_URLS=url_file,
               TERM="xterm-256color")
    for name in (base.SESSION_ENV, base.JOURNAL_ENV):
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
    base.log("login_start", provider=provider, mode=argv[1])
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
            signed_in = next((a for a in registry.load_index(provider) if a.id == signed_id), None)
        except (LoginRefused, RuntimeError, TimeoutError) as e:
            result = {"event": "done", "ok": False, "message": str(e)[:300]}
    elif result["ok"]:
        said = result["message"].split()
        signed_in = account or (
            registry.find_account(registry.load_index(provider), said[1]) if len(said) > 1 and said[0] in ("added", "reauthed") else None)
    base.log("login_end", provider=provider, mode=argv[1], ok=result["ok"], message=result["message"])
    if signed_in is not None:
        drop_login_blocks(provider, signed_in)
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
