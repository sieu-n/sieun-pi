"""The admission scheduler: trees, the slot book, and decide() with rules R1-R7."""
import dataclasses, time

from . import base, registry


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
    account: registry.Account
    reason: str = "stay"
    shadowed: "tuple | None" = None
    # Open admissible accounts, best first, for a credential that fails.
    fallbacks: tuple = ()


@dataclasses.dataclass(frozen=True)
class Admit:
    account: registry.Account
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
    slot_account: registry.Account
    # The account the hook vends meanwhile: the tree's own account when the
    # provider refuses it, so the request gets a 429 and writes no cache. None
    # when no such account exists: the hook then gives no token and the extension
    # turns that failure into a wait until slot_at.
    vend: "registry.Account | None" = None
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
        return f"cooldown {registry.fmt_dur(max(60.0, cooldowns.get(a.id, now) - now))}"
    if reason == "limited":
        return f"limited {registry.fmt_dur(max(60.0, a.limited_until - now))}"
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
        if name is not None and (a.gate_off or not any(f in registry.family_tokens(name) for f in families)):
            continue
        short = name is None and registry.is_session_window(w)
        limit = admit_cap(cfg, priority) if short else cfg["seven_day_max_pct"]
        if registry.live_pct(w, now) >= limit:
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
    weekly = registry.weekly_window({"windows": a.windows})
    left = registry.reset_in(weekly, now) if weekly else None
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
    window_sec = base.config()["active_session_sec"] if window_sec is None else window_sec
    counts = {}
    for rec in state["sessions"].values():
        vend = (rec.get("vends") or {}).get(provider)
        if vend and now - (vend.get("at") or 0) <= window_sec:
            counts[vend["account_id"]] = counts.get(vend["account_id"], 0) + 1
    return counts


def tree_for(state, key, provider):
    """Project state.json down to the facts `decide` reads for one tree."""
    prov = state["providers"].get(provider) or registry.empty_provider_state()
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
    prov = state["providers"].get(provider) or registry.empty_provider_state()
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
