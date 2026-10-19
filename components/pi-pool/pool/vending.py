"""The token hook: state writers, credentials, the fallback login and adopt-logins, the
refusal probe, and vend()."""
import dataclasses, os, subprocess, sys, time

from . import base, registry, sched


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

    def set_wait(self, key, provider, account_id, slot_at, now, backoff=False):
        """R5: the tree waits for its slot on `account_id`, or with `backoff` until
        its random draw. Its wait start stays the first one, so a tree keeps its
        place in the queue."""
        rec = self._rec(key, now)
        waits = rec.setdefault("wait", {})
        since = (waits.get(provider) or {}).get("since", now)
        waits[provider] = {"account": account_id, "slot_at": slot_at, "since": since}
        if backoff:
            waits[provider]["backoff"] = True

    def set_cooldown(self, provider, account_id, until, reason=None):
        prov = self._state["providers"][provider]
        prov["cooldowns"][account_id] = until
        if reason:
            prov.setdefault("cooldown_reasons", {})[account_id] = reason

    def start_reads(self, provider, ids, now):
        """A background usage read of these accounts starts now."""
        reads = self._state["providers"][provider].setdefault("usage_reads", {})
        reads.update({account_id: now for account_id in ids})

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
        WAIT_STALE_SEC ago, and automatic sessions inactive for pin_ttl_sec.
        Moves a record quiet for active_session_sec with no wait to the session
        archive (registry.Sessions). Returns whether anything changed, so a request that prunes nothing does
        not rewrite the file. Liveness is NOT a pid test: a session resumed in a
        new worker keeps its pin, which is the whole point of keying by uuid."""
        dropped = 0
        for provider in base.PROVIDERS:
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
            reads = prov.get("usage_reads") or {}
            for account_id in [u for u, at in reads.items() if now - at > registry.REFRESH_TIMEOUT_SEC]:
                del reads[account_id]
                dropped += 1
            admissions = prov.get("admissions") or {}
            for account_id, entries in list(admissions.items()):
                kept = [e for e in entries if now - e[0] <= sched.ADMISSION_KEEP_SEC]
                if len(kept) != len(entries):
                    dropped += 1
                    if kept:
                        admissions[account_id] = kept
                    else:
                        del admissions[account_id]
        ttl, quiet = cfg["pin_ttl_sec"], cfg["active_session_sec"]
        archived = 0
        for key in list(self._state["sessions"]):
            rec = self._state["sessions"][key]
            last = registry.last_active(rec)
            if now - last > ttl and not rec.get("pins"):
                del self._state["sessions"][key]
                dropped += 1
                continue
            waits = rec.get("wait") or {}
            for provider in [p for p, w in waits.items() if w["slot_at"] < now - sched.WAIT_STALE_SEC]:
                del waits[provider]
                dropped += 1
            moves = rec.get("moves") or {}
            for provider, times in list(moves.items()):
                kept = [t for t in times if now - t < sched.MOVE_WINDOW_SEC]
                if len(kept) != len(times):
                    dropped += 1
                    if kept:
                        moves[provider] = kept
                    else:
                        del moves[provider]
            if now - last > quiet and not rec.get("wait") and registry.archive_record(key, rec):
                del self._state["sessions"][key]
                archived += 1
        if archived:
            registry.sweep_archive(now, ttl)
        return dropped + archived > 0


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

    def set_priority(self, key, priority, now, labeled=False):
        """R7: the tree's class. A tree with no record yet (a thread made a moment
        ago) gets one, so its first request already counts as this class. `labeled`:
        the class is the owner's sidebar label, which `snapshot --tree` reports."""
        rec = self._rec(key, now)
        rec["priority"] = priority
        if labeled:
            rec["priority_label"] = priority
        else:
            rec.pop("priority_label", None)


    def clear_pin(self, key, provider):
        rec = self._state["sessions"].get(key.key)
        if rec:
            (rec.get("pins") or {}).pop(provider, None)
            if os.path.isfile(os.path.join(registry.archive_dir(), key.key + ".json")):
                registry.archive_record(key.key, rec)

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
        """Drop account health and waits, but keep explicit account selections."""
        prov = self._state["providers"][provider]
        for key in ("disabled", "cooldowns", "cooldown_reasons", "limits", "admissions"):
            (prov.get(key) or {}).pop(account_id, None)
        for rec in self._state["sessions"].values():
            waits = rec.get("wait") or {}
            if (waits.get(provider) or {}).get("account") == account_id:
                del waits[provider]


# ----------------------------------------------------------------- credentials
def credential_for_keychain(a, cfg, refresh=True):
    """(access_token, source) from the account's Keychain item. A refresh takes
    the index flock, then re-reads before rotating. With refresh=False, None
    instead of a refresh."""
    service = a.cred.service
    adapter = base.KeychainAdapter(service)
    creds = adapter.read()
    if not creds:
        raise RuntimeError(f"no credential in {a.label}'s store; run `pi-pool login {a.id}`")
    if not creds.get("accessToken") or not creds.get("refreshToken"):
        raise RuntimeError(f"{a.label}'s store was cleared after a failed refresh (needs reauth)")
    remaining = (creds["expiresAt"] - time.time() * 1000) / 1000
    if remaining > cfg["refresh_skew_sec"]:
        return creds["accessToken"], "store"
    if not refresh:
        return None

    with base.index_lock("anthropic"):
        creds2 = base.recover_rotation(service, adapter)
        if (creds2["expiresAt"] - time.time() * 1000) / 1000 > cfg["refresh_skew_sec"]:
            return creds2["accessToken"], "store"
        try:
            merged = base.refresh_token(creds2)
        except RuntimeError as e:
            if str(e).startswith("invalid_grant"):
                base.mark_needs_reauth("anthropic", a.id)
            raise
        # A refresh rotates the grant server-side the instant it returns: journal
        # it BEFORE the keychain write, or a crash in between strands the account
        # on a superseded refresh token.
        base.journal_write(service, merged)
        adapter.write(merged)
        base.journal_clear(service)
        base.log("refreshed", account=a.label, provider="anthropic",
                 expires_in_h=round((merged["expiresAt"] - time.time() * 1000) / 3600000, 2))
        return merged["accessToken"], "refreshed"


def credential_for_codex(a, cfg, refresh=True):
    """(access_token, source) from the account's auth.json; with refresh=False, None instead of a refresh."""
    adapter = base.CodexFileAdapter(a.cred.path)
    store_key = "codex-" + a.id
    blob = adapter.read()
    if not blob or not (blob.get("tokens") or {}).get("access_token"):
        raise RuntimeError(f"no credential in {a.label}'s codex store; run `pi-pool login {a.id} --provider openai-codex`")
    token = blob["tokens"]["access_token"]
    if base.jwt_claims(token)["exp"] - time.time() > cfg["refresh_skew_sec"]:
        registry.assert_codex_identity(token, a.id)
        return token, "store"
    if not refresh:
        return None

    with base.index_lock("openai-codex"):
        blob = base.recover_rotation(store_key, adapter)
        token = blob["tokens"]["access_token"]
        if base.jwt_claims(token)["exp"] - time.time() > cfg["refresh_skew_sec"]:
            registry.assert_codex_identity(token, a.id)
            return token, "store"
        try:
            fresh = base.refresh_codex_token(blob["tokens"]["refresh_token"])
        except RuntimeError as e:
            if str(e).startswith("refresh_token_reused"):
                base.mark_needs_reauth("openai-codex", a.id)
            raise
        merged = base.merge_codex_tokens(blob, fresh)
        base.journal_write(store_key, merged)
        adapter.write(merged)
        base.journal_clear(store_key)
        token = merged["tokens"]["access_token"]
        registry.assert_codex_identity(token, a.id)
        base.log("refreshed", account=a.label, provider="openai-codex",
                 expires_in_h=round((base.jwt_claims(token)["exp"] - time.time()) / 3600, 2))
        return token, "refreshed"


def credential_for(a, cfg, refresh=True):
    if isinstance(a.cred, registry.Keychain):
        return credential_for_keychain(a, cfg, refresh)
    if isinstance(a.cred, registry.CredFile):
        return credential_for_codex(a, cfg, refresh)
    raise RuntimeError(f"unknown credential kind for {a.id}")


def stay_now(state, d, tree, key, provider, cfg, now, parent):
    """The token of a tree that stays on its account, with the vend recorded in `state`, so the hook takes the
    pool flock once instead of twice. Only for a stay whose credential is a file read with no refresh: a Keychain
    read runs security(1), which the flock must not wait on. None sends the vend down the two-flock path.
    On us-metal02 on 10-18 the flock was held 91% of the time, each hold read and wrote the 2.7 MB state.json,
    and 23 hooks in 10 min gave up after STATE_LOCK_TIMEOUT."""
    if key is None or not isinstance(d, (sched.Stay, sched.Admit)) or d.account.id != tree.current:
        return None
    if isinstance(d.account.cred, registry.Keychain) and not base.FILE_SECRETS:
        return None
    try:
        got = credential_for(d.account, cfg, refresh=False)
    except Exception:
        return None
    if got is None:
        return None
    HookWriter(state).record_vend(key, provider, d.account, got[1], d.reason, d.shadowed, now, parent)
    return got[0]


def agent_dir():
    return os.environ.get("PRIME_AGENT_CODING_AGENT_DIR") or os.path.join(base.HOME, ".prime", "agent")


def load_fallback():
    return base.load_json(base.FALLBACK) or {}


def fallback_token(provider, cfg):
    """The user's own OAuth login for `provider`, adopted out of Prime's
    auth.json (see adopt-logins). Used only when no pooled account can serve.
    It is an independent grant family, so refreshing it never touches a store."""
    with base.Flock(os.path.join(base.POOL, "fallback.lock"), timeout=base.INDEX_LOCK_TIMEOUT):
        fb = load_fallback()
        creds = fb.get(provider)
        if not creds or creds.get("type") != "oauth":
            return None
        if (creds["expires"] - time.time() * 1000) / 1000 > cfg["refresh_skew_sec"]:
            return creds["access"]
        if provider == "anthropic":
            fresh = base.refresh_token({"refreshToken": creds["refresh"], "scopes": creds.get("scopes")})
            creds = dict(creds, access=fresh["accessToken"], refresh=fresh["refreshToken"],
                         expires=fresh["expiresAt"])
        else:
            fresh = base.refresh_codex_token(creds["refresh"])
            creds = dict(creds, access=fresh["access_token"],
                         refresh=fresh.get("refresh_token") or creds["refresh"],
                         expires=base.jwt_claims(fresh["access_token"])["exp"] * 1000)
        fb[provider] = creds
        base.save_json(base.FALLBACK, fb)
        base.log("fallback_refreshed", provider=provider)
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
    providers = (base.load_json(os.path.join(agent_dir(), "models.json"), {}) or {}).get("providers") or {}
    return [p for p in base.PROVIDERS
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
        auth = base.load_json(auth_path)
        if not isinstance(auth, dict):
            return 0
        hits = [p for p in wanted if p in auth]
        if not hits:
            return 0
        with base.Flock(os.path.join(base.POOL, "fallback.lock"), timeout=base.INDEX_LOCK_TIMEOUT):
            fb = load_fallback()
            stamp = time.strftime("%Y%m%d-%H%M%S")
            os.makedirs(os.path.join(base.POOL, "backups"), mode=0o700, exist_ok=True)
            for p in hits:
                if fb.get(p):
                    base.save_json(os.path.join(base.POOL, "backups", f"fallback.{p}.{stamp}.json"), fb[p])
                fb[p] = auth.pop(p)
                moved.append(p)
            base.save_json(base.FALLBACK, fb)
        base.save_json(auth_path, auth)
    base.log("adopted_logins", providers=moved)
    print(f"moved the stored {', '.join(moved)} login into the pool fallback; the pool now serves "
          f"{'these providers' if len(moved) > 1 else 'this provider'}")
    return 0


def apply_refusal(provider, account, refusal, cfg, now):
    """Cool an API-refused account down in the pool."""
    until = now + cfg["refused_cooldown_sec"]
    with base.Flock(base.LOCK, timeout=base.STATE_LOCK_TIMEOUT):
        state = registry.load_state()
        HookWriter(state).set_cooldown(provider, account.id, until, refusal)
        base.save_json(base.STATE, state)


def record_probe(state, account_id, result, expected, cfg, now):
    prov = state["providers"]["anthropic"]
    reasons = prov.get("cooldown_reasons") or {}
    if (reasons.get(account_id), prov["cooldowns"].get(account_id)) != expected:
        return False
    if isinstance(result, base.ProbeRefused):
        HookWriter(state).set_cooldown("anthropic", account_id, now + cfg["refused_cooldown_sec"], result.reason)
        return True
    if isinstance(result, base.ProbeAccepted) and expected[0] is not None:
        prov["cooldowns"].pop(account_id, None)
        reasons.pop(account_id, None)
        return True
    return False


def cmd_probe(rest=()):
    """Probe every anthropic account with a still-valid access token for an
    API refusal, at most once per probe_interval_sec unless --force. Never
    refreshes a token, so it rotates nothing. The extension runs this at session
    start, which is how a refusal is found before any request lands on it."""
    cfg, now = base.config(), time.time()
    with base.Flock(base.LOCK, timeout=base.STATE_LOCK_TIMEOUT):
        state = registry.load_state()
        prov = state["providers"]["anthropic"]
        if "--force" not in rest and now - (prov.get("last_probe") or 0) < cfg["probe_interval_sec"]:
            return 0
        prov["last_probe"] = now
        base.save_json(base.STATE, state)
    lines = probe_accounts(registry.load_index("anthropic"), prov.get("cooldown_reasons") or {}, cfg, now)
    if lines:
        print("; ".join(lines))
    return 0


def probe_failed_reads(ids):
    """Probe the anthropic accounts whose usage read just failed. A revoked token
    fails the read with nothing in its reason, and an account with no fresh read
    is the one waiting trees are held for, so without this they waited until the
    next 6 h probe (2026-10-14: claude11@slack.green's token was revoked at 02:53,
    91 of 114 waits in 30 min were for it, and the 05:57 probe freed them)."""
    cfg, now = base.config(), time.time()
    prov = registry.load_state()["providers"]["anthropic"]
    accounts = [a for a in registry.load_index("anthropic") if a.id in ids]
    probe_accounts(accounts, prov.get("cooldown_reasons") or {}, cfg, now)


def probe_accounts(accounts, reasons, cfg, now):
    """Probe each account, cool a refused one down and free one accepted again.
    Logs one probe event and returns its lines."""
    lines = []
    for a in accounts:
        if a.needs_reauth:
            continue
        try:
            creds = base.KeychainAdapter(a.cred.service).read()
        except Exception:
            continue
        if not creds or (creds.get("expiresAt") or 0) / 1000 - now < 60:
            continue
        prov = registry.load_state()["providers"]["anthropic"]
        expected = (reasons.get(a.id), prov["cooldowns"].get(a.id))
        result = base.anthropic_probe(creds["accessToken"], infer=expected[0] == base.NEEDS_TERMS)
        if isinstance(result, base.ProbeUnavailable):
            continue
        with base.Flock(base.LOCK, timeout=base.STATE_LOCK_TIMEOUT):
            state = registry.load_state()
            changed = record_probe(state, a.id, result, expected, cfg, now)
            if changed:
                base.save_json(base.STATE, state)
        if changed:
            message = result.reason if isinstance(result, base.ProbeRefused) else "accepted again"
            lines.append(f"{a.label}: {message}")
    base.log("probe", results=lines)
    return lines


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
    """The last vended account when it still serves and matches manual selection.
    An Off account serves only an explicit manual selection."""
    if key is None or state.get("version") != 2:
        return None
    last = (((state.get("sessions") or {}).get(key.key) or {}).get("vends") or {}).get(provider)
    prov = (state.get("providers") or {}).get(provider)
    if not last or not prov:
        return None
    tree = sched.tree_for(state, key, provider)
    manual = tree.pin or tree.pool_pin
    if tree.wait or (manual and last["account_id"] != manual):
        return None
    cfg = base.config()
    candidates = registry.with_pool_state(accounts, state, provider)
    candidates = registry.with_models(candidates, registry.session_models(state, key, provider, cfg, now), cfg)
    account = next((a for a in candidates if a.id == last["account_id"]), None)
    if account is None:
        return None
    if manual:
        account = dataclasses.replace(account, disabled=False)
    if sched.serve_reason(account, prov.get("cooldowns") or {}, now):
        return None
    return account


def schedule(state, key, provider, accounts, cfg, now, admit_now=True):
    """Run `decide` for this tree and write what it takes, under the pool flock
    the caller holds: an admission takes its cell, a wait its slot. With
    `admit_now` false (`pi-pool limited` and `refused`, whose retry vends a second
    later) an admission is held as a wait due now. Returns the decision, the tree
    and whether state changed."""
    accounts = registry.with_pool_state(accounts, state, provider)
    accounts = registry.with_models(accounts, registry.session_models(state, key, provider, cfg, now), cfg)
    tree = sched.tree_for(state, key, provider)
    cooldowns = dict(state["providers"][provider]["cooldowns"])
    writer = HookWriter(state)
    d = sched.decide(tree, accounts, sched.book_for(state, provider, key, cfg, now), cooldowns, cfg, now)
    if key is None or d is None or isinstance(d, sched.Blocked):
        return d, tree, False
    if isinstance(d, sched.Wait):
        # One line per refused request, for the Whole system duty: `room` names the accounts the rules let this
        # tree enter now but for a cell, so a refusal with room is a turn held while the pool has accounts free.
        base.log("parked", provider=provider, session=key.key, at=round(now, 1), account=d.slot_account.label,
                 slot_at=round(d.slot_at), backoff=d.backoff, priority=tree.priority, room=[a.label for a in d.room])
    elif tree.wait and admit_now:
        base.log("unparked", provider=provider, session=key.key, at=round(now, 1), account=d.account.label)
    if isinstance(d, sched.Admit) and admit_now:
        writer.admit(key, provider, d.account.id, now)
        return d, tree, True
    if isinstance(d, sched.Admit):
        writer.set_wait(key, provider, d.account.id, now, now)
        return d, tree, True
    if isinstance(d, sched.Wait) and (tree.wait is None or tree.wait[:2] != (d.slot_account.id, d.slot_at)):
        writer.set_wait(key, provider, d.slot_account.id, d.slot_at, now, d.backoff)
        base.log("wait", provider=provider, session=key.key, account=d.slot_account.label,
                 slot_at=iso(d.slot_at), priority=tree.priority, vend=d.vend and d.vend.label,
                 left=d.left and d.left[1], backoff=d.backoff)
        return d, tree, True
    return d, tree, False


def reads_due(state, provider, accounts, cfg, now):
    """The accounts that would take a tree but for an unsampled 5h figure, and that
    no read started for in the last REFRESH_TIMEOUT_SEC."""
    prov = state["providers"][provider]
    reading, cooldowns = prov.get("usage_reads") or {}, prov["cooldowns"]
    return [a for a in registry.with_pool_state(accounts, state, provider)
            if sched.admit_reason(a, cooldowns, cfg, now) == "unsampled"
            and now - reading.get(a.id, 0) > registry.REFRESH_TIMEOUT_SEC]


def start_usage_read(provider, accounts):
    """`pi-pool refresh` these accounts in its own session, detached from the hook's
    pipes, so the hook returns its token at once and the read outlives it."""
    subprocess.Popen([sys.executable, "-B", os.path.join(base.CODE_ROOT, "vend.py"), "--cli", "refresh",
                      *(a.id for a in accounts), "--provider", provider, "--json"],
                     stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                     start_new_session=True)
    base.log("usage_read", provider=provider, accounts=[a.label for a in accounts])


def vend(provider):
    """Decide one account for this session tree and write its access token to
    stdout. stdout is the token and nothing else; every other byte goes to
    the log.

    Lock discipline: take the pool flock to read, prune, decide and write the
    admission or wait, release it, fetch or refresh the credential under
    the index lock, then re-take the pool flock to record the vend. The
    pool flock is never held across a refresh, so `pi-pool use` never queues
    behind one. A tree that stays on its account with a file credential that
    needs no refresh records its vend in the first hold (`stay_now`). When the flock stays busy past STATE_LOCK_TIMEOUT, the tree keeps
    the account it was last vended, if that account can still serve.

    A tree that waits gets its own account while the provider refuses it, so the
    request comes back as a 429 that writes no cache and `pi-pool limited` hands
    the extension the slot time. With no such account the hook exits non-zero
    with no token, and the extension turns that failure into the same wait.
    """
    from . import remote
    deadline = time.monotonic() + remote.TOKEN_WAIT_SEC
    cfg = base.config()
    accounts = registry.load_index(provider)
    key = registry.session_key()
    parent_pid = os.getppid()
    parent = (parent_pid, (base.proc_info(parent_pid) or {}).get("start")) if key else None

    try:
        with base.Flock(base.LOCK, timeout=base.STATE_LOCK_TIMEOUT):
            state = registry.load_state()
            now = time.time()
            pruned = HookWriter(state).prune(cfg, now)
            d, tree, wrote = schedule(state, key, provider, accounts, cfg, now)
            reads = reads_due(state, provider, accounts, cfg, now)
            HookWriter(state).start_reads(provider, [a.id for a in reads], now)
            token = stay_now(state, d, tree, key, provider, cfg, now, parent)
            if pruned or wrote or reads or token:
                base.save_json(base.STATE, state)
    except TimeoutError:
        # save_json replaces state.json in one rename, so an unlocked read sees a whole file.
        unlocked = base.load_json(base.STATE, {}) or {}
        unlocked["sessions"] = registry.Sessions(unlocked.get("sessions") or {}, time.time(), cfg["pin_ttl_sec"])
        account = last_vend_account(unlocked, key, provider, accounts, time.time())
        if account is None:
            raise
        token, source = credential_for(account, cfg)
        base.log("vend_lock_busy", provider=provider, account=account.label, source=source, session=key.key)
        sys.stdout.write(token)
        return

    if reads:
        try:
            start_usage_read(provider, reads)
        except OSError as e:
            base.log("usage_read_failed", provider=provider, error=str(e))
    if token:
        sys.stdout.write(token)
        return
    if d is None:
        raise RuntimeError(f"no {provider} account can serve this session")
    revalidated = None
    if provider == "anthropic" and isinstance(d, sched.Blocked) and d.reason == "cooldown":
        prov = state["providers"][provider]
        expected = ((prov.get("cooldown_reasons") or {}).get(d.account_id), prov["cooldowns"].get(d.account_id))
        selected = next((a for a in accounts if a.id == d.account_id), None)
        if selected and expected[0] in (base.NEEDS_TERMS, base.OAUTH_OFF, base.TOKEN_REJECTED, "forbidden (403)"):
            try:
                probe_token, probe_source = credential_for(selected, cfg)
            except Exception as e:
                base.log("account_unusable", provider=provider, account=selected.label, error=str(e))
            else:
                # measured: remote's 9 s precedes Prime's 10 s cap; reserve the reschedule and vend state locks.
                remaining = deadline - time.monotonic() - 2 * base.STATE_LOCK_TIMEOUT
                result = (base.anthropic_probe(probe_token, infer=expected[0] == base.NEEDS_TERMS, timeout=remaining)
                          if remaining > 0 else base.ProbeUnavailable())
                if not isinstance(result, base.ProbeUnavailable):
                    with base.Flock(base.LOCK, timeout=base.STATE_LOCK_TIMEOUT):
                        state = registry.load_state()
                        changed = record_probe(state, selected.id, result, expected, cfg, time.time())
                        if changed:
                            base.save_json(base.STATE, state)
                        if changed and isinstance(result, base.ProbeAccepted):
                            revalidated = (selected.id, probe_token, probe_source)
                            tree = sched.tree_for(state, key, provider)
                            if (tree.pin or tree.pool_pin) != selected.id:
                                raise RuntimeError("manual account selection changed during revalidation; request again")
                            now = time.time()
                            d, tree, wrote = schedule(state, key, provider, accounts, cfg, now)
                            if wrote:
                                base.save_json(base.STATE, state)
    if isinstance(d, sched.Blocked):
        selected = next((a for a in accounts if a.id == d.account_id), None)
        label = selected.label if selected else d.account_id
        reason = ((state["providers"][provider].get("cooldown_reasons") or {}).get(d.account_id) or d.reason
                  if d.reason == "cooldown" else d.reason)
        raise RuntimeError(f"pinned {provider} account {label}: {reason}")
    if isinstance(d, sched.Wait):
        if d.vend is not None:
            try:
                token, _ = credential_for(d.vend, cfg)
            except Exception as e:
                base.log("account_unusable", provider=provider, account=d.vend.label, error=str(e))
            else:
                sys.stdout.write(token)
                return
        raise SystemExit(f"pi-pool: this session waits for a slot on {d.slot_account.label} "
                         f"at {iso(d.slot_at)}")

    order = [d.account] + list(d.fallbacks)
    errors = []
    for account in order:
        try:
            token, source = revalidated[1:] if revalidated and account.id == revalidated[0] else credential_for(account, cfg)
        except Exception as e:
            errors.append(f"{account.label}: {e}")
            base.log("account_unusable", provider=provider, account=account.label, error=str(e))
            continue
        reason = d.reason if account.id == d.account.id else ("switch" if tree.current else "new")
        entering = account.id != tree.current
        # Entering an account is rare (hours apart per tree), so it can afford one
        # no-spend probe; that is where an organization-level OAuth refusal shows
        # up, which usage figures and needsReauth never reflect.
        if provider == "anthropic" and revalidated is None and (source == "refreshed" or entering):
            result = base.anthropic_probe(token)
            if isinstance(result, base.ProbeRefused):
                errors.append(f"{account.label}: {result.reason}")
                base.log("account_refused", provider=provider, account=account.label, error=result.reason)
                apply_refusal(provider, account, result.reason, cfg, now)
                continue
        prev = vended = None
        try:
            with base.Flock(base.LOCK, timeout=base.STATE_LOCK_TIMEOUT):
                state = registry.load_state()
                writer = HookWriter(state)
                prev = ((state["sessions"].get(key.key) or {}).get("vends") or {}).get(provider) if key else None
                if key and account.id != d.account.id:
                    writer.admit(key, provider, account.id, now)
                vended = writer.record_vend(key, provider, account, source, reason, d.shadowed, now, parent,
                                            moved=entering and tree.current is not None) if key else None
                base.save_json(base.STATE, state)
        except TimeoutError:
            # The token is valid; a vend left off the record only skews the next decision.
            base.log("vend_unrecorded", provider=provider, account=account.label, session=key and key.key)
        # The hook runs on every provider request, so a line per vend would be a log of
        # thousands. Log the transitions only: a tree entering an account.
        # `why` says why the pin in `shadowed` did not serve (depleted, limited, busy, ...).
        if vended is None or vended["n"] == 1:
            base.log("vend", provider=provider, account=account.label, source=source,
                     reason=reason, shadowed=d.shadowed and d.shadowed[0],
                     why=d.shadowed and d.shadowed[1],
                     previous=(prev or {}).get("email"), session=key and key.key)
        if prev and prev.get("account_id") != account.id:
            # One line per move of one tree: `pi-pool status` and the chat
            # health review count these.
            base.log("switch", provider=provider, session=key.key, previous=prev.get("email"),
                     account=account.label, reason=reason, why=switch_why(d, account),
                     scores=dict(getattr(d, "scores", ())[:6]))
        sys.stdout.write(token)
        return

    raise RuntimeError("no usable account; " + "; ".join(errors))
