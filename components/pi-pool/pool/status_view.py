"""Flag parsing, ls rows, and the status cards that `pi-pool status` and `watch` draw."""
import json, os, re, shutil, sys, time

from . import base, limited, registry, sched


# ------------------------------------------------------------------------ CLI
def parse_flags(rest, provider_default="anthropic"):
    provider, session, as_json, follow, new_session, positional = provider_default, None, False, False, False, []
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
            "follow": follow, "new_session": new_session, "positional": positional,
            "model": model, "source": source, "clear": clear, "until": until, "since": since}


def session_key_for(session_arg, state):
    if session_arg is None:
        return registry.session_key()
    match = registry.resolve_session_arg(session_arg, state)
    if match:
        return match
    # /account names the session it is running in, which has no record until its
    # first vend. This process inherits that session's env, so derive the key the
    # hook will use instead of refusing a session that is plainly here.
    here = registry.session_key()
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
        reason = sched.format_reason(a, cooldowns, cfg, now, p)
        row = {
            "id": a.id, "email": a.email, "label": a.label,
            "usage": f"{a.session_pct}%/{a.weekly_pct}%",
            "session_pct": a.session_pct, "weekly_pct": a.weekly_pct, "gated_pct": a.gated_pct,
            "usable": reason is None, "serves": sched.serve_reason(a, cooldowns, now) is None, "reason": reason,
            "current": a.id == tree.current, "pinned": a.id in (tree.pin, tree.pool_pin),
            "disabled": a.disabled,
            "score": round(sched.score(a, cfg, now, p, book.load), 2) if reason is None else None,
            "slot_cap": sched.slot_cap(a, cfg),
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
            "waiting": book.parked.get(a.id, 0),
            "cooldown_until": round(cooldowns[a.id]) if cooling else None,
            "cooldown_reason": cooldown_reasons.get(a.id) if cooling else None,
            "limited_until": round(a.limited_until) if limited else None,
        })
        rows.append(row)
    return rows


# ------------------------------------------------------------------ rendering
# `status` and `watch` draw one card per account in a grid: its usage windows,
# pins, the sessions on each account, cooldowns, waiters, and its score.
ANSI_RE = re.compile(r"\x1b\[[0-9;]*m")
CARD_GAP = 3
NOTE_INDENT = "    "
BAR_WIDTH = 16
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
    return "just now" if sec < 60 else f"{registry.fmt_dur(sec)} ago"


def usage_windows(a, now):
    """Every usage window of one account, in display order: the session window,
    the weekly window, then each named per-model cap (Fable, Sonnet, a codex
    additional limit). pct is the live figure, so a passed reset reads 0 with
    no reset time."""
    session, weekly = registry.session_window(dict(windows=a.windows)), registry.weekly_window(dict(windows=a.windows))
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
        left = registry.reset_in(w, now)
        out.append({"kind": kind, "label": label, "name": w.get("name"), "pct": registry.live_pct(w, now),
                    "window_sec": secs, "resets_at": round(now + left) if left else None,
                    "sampled_at": round((w.get("sampledAt") or 0) / 1000) or None})
    return out


def window_rows(p, a, now):
    rows = []
    for w in usage_windows(a, now):
        label = w["label"].lower()[:6] if w["kind"] == "model" else w["label"]
        reset = w["resets_at"] - now if w["resets_at"] else None
        rows.append(f"{NOTE_INDENT}{label:6s}{usage_bar(p, w['pct'])}"
                    + (p.dim(f"  {registry.fmt_dur(reset)}") if reset and w["pct"] > 0 else ""))
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
        notes.append((p.dim, "Off excludes Auto; a Manual selection can still use this account"))
    elif reason == "needs-reauth":
        flag = " --provider openai-codex" if a.provider == "openai-codex" else ""
        notes.append((p.red, f"login is dead: pi-pool login {a.id}{flag}"))
    elif reason and reason.startswith("cooldown"):
        why = ctx["cooldown_reasons"].get(a.id)
        notes.append((p.yellow, f"refused: {why}" if why else "cooling down after a failure"))
    elif reason and reason.startswith("limited"):
        notes.append((p.yellow, "the provider answered 429; skipped until the limit ends"))
    if a.windows and reason != "needs-reauth" and now - a.usage_at > registry.STALE_USAGE_SEC:
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
        with open(base.LOG) as f:
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
    cfg, state = base.config(), limited.unlocked_state()
    out = [p.dim(f"new trees enter under 5h {cfg['admit_5h_max_pct']}% (low {cfg['low_admit_5h_max_pct']}%)"
                 f"  week {cfg['seven_day_max_pct']}%  {'/'.join(cfg['switch_models'])} {cfg['seven_day_max_pct']}%"
                 f"  one per {cfg['admit_slot_sec']}s per tier unit"), ""]
    for provider in providers:
        title = PROVIDER_TITLES.get(provider, provider)
        try:
            accounts = registry.load_index(provider)
        except Exception as e:
            out += [p.red(f"{title}: {e}"), ""]
            continue
        accounts = registry.with_pool_state(accounts, state, provider)
        prov = state["providers"][provider]
        book = sched.book_for(state, provider, None, cfg, now)
        cooldowns = prov["cooldowns"]
        reasons = {a.id: sched.format_reason(a, cooldowns, cfg, now) for a in accounts}
        ctx = {"now": now, "in_use": book.load, "pool_pin": prov.get("pin"),
               "scores": {a.id: sched.score(a, cfg, now, "normal", book.load) for a in accounts if reasons[a.id] is None},
               "serves": {a.id: sched.serve_reason(a, cooldowns, now) is None for a in accounts},
               "waiting": dict(book.parked),
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
    providers = [f["provider"]] if f["provider"] else list(base.PROVIDERS)
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
    providers = [f["provider"]] if f["provider"] else list(base.PROVIDERS)
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
