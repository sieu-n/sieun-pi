"""The admission scheduler: trees, the slot book, and decide() with rules R1-R7."""
import dataclasses, time

from . import base, registry


# ---------------------------------------------------------------- the pure core
# The scheduler. One tree (a root session and every subagent under it) asks for an
# account on each provider request, and `decide` answers stay, admit or wait. Rules,
# first match wins:
#   R1 stay: the tree's own account still serves (no 429, every window under 100%,
#      credential ok), warm or cold. No move because of a cutoff, a better account,
#      or another tree's move.
#   R2 admit cap: Auto enters an account only under
#      admit_5h_max_pct (low trees: low_admit_5h_max_pct) of its 5h window, under
#      seven_day_max_pct of its week and its Fable cap, and on a 5h read under
#      STALE_USAGE_SEC old. admit_5h_max_pct is 100, the vendor limit, so the 5h
#      window keeps a normal or high tree off an account only once the provider
#      stops serving it.
#   R3 score: among admissible accounts the highest weekly pace x 5h headroom / load.
#   R4 admission slots: an account admits one tree per admit_slot_sec / slot_cap(a).
#   R5 wait: no account has a cell for the tree now, so it gets its own slot_at on
#      the account that frees first: the first R4 cell at or after the account
#      passes R2 again (now, or its real reset or 429 `until`), ordered by priority,
#      then by wait start. Its own account wins a tie, so the tree keeps its cache.
#      A tree that comes back after its cell went stale keeps its wait start. A tree
#      back after its cell passed asks for the current cell in this same order.
#   R6 move budget: a tree that moved max_moves_per_day[priority] times in 24 h
#      waits for its own account, at most budget_wait_max_sec from the start of its
#      wait; a high tree is refused only optional moves.
#   R7 priority share: low trees enter only under low_admit_5h_max_pct; when one
#      account is left, the last cell of each slot window is for high trees.
PRIORITIES = ("high", "normal", "low")
PRIORITY_RANK = {p: i for i, p in enumerate(PRIORITIES)}
# The tree record the CLI and the hook keep per provider.
ADMISSION_KEEP_SEC = 1800
MOVE_WINDOW_SEC = 24 * 3600
# A wait whose slot passed this long ago with no request from the tree gives up its cell
# and keeps only its place in the queue, its wait start.
WAIT_STALE_SEC = 900
# How long after its slot a tree that gave up its cell keeps its place.
# measured: 10-21 22:00Z to 10-22 05:20Z on us-metal02, 39 of the 40 trees that asked again over WAIT_STALE_SEC after their slot asked within 124 min (pi-pool.log).
PLACE_KEEP_SEC = 3 * 3600
# How far ahead a slot is searched, in cells.
SLOT_SEARCH_CELLS = 5000


@dataclasses.dataclass(frozen=True)
class Tree:
    """What the scheduler knows about one session tree on one provider."""
    key: "str | None" = None
    # The account the tree was last vended, and when; None for a new tree.
    current: "str | None" = None
    current_at: float = 0
    pin: "str | None" = None
    pool_pin: "str | None" = None
    # The account `pi-pool switch` asked the tree to leave.
    leave: "str | None" = None
    priority: str = "normal"
    # Epoch seconds of the tree's moves in the last 24 h.
    moves: tuple = ()
    # (account id, slot_at, since) while the tree waits for a slot; the account id is
    # None once the cell went stale and the tree keeps only its place (since).
    wait: "tuple | None" = None


@dataclasses.dataclass(frozen=True)
class Book:
    """Who entered or will enter each account, as the slot rule reads it.
    `admitted`: {account id: ((at, tree key), ...)} over ADMISSION_KEEP_SEC.
    `waiting`: {account id: ((slot_at, tree key, rank), ...)} of the other trees.
    `load`: {account id: trees vended within active_session_sec}.
    `parked`: {account id: other trees whose wait names it}, for the status counts."""
    admitted: dict = dataclasses.field(default_factory=dict)
    waiting: dict = dataclasses.field(default_factory=dict)
    load: dict = dataclasses.field(default_factory=dict)
    parked: dict = dataclasses.field(default_factory=dict)


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
    # The accounts R1-R7 would admit this tree onto now but for a cell (R4).
    room: tuple = ()


@dataclasses.dataclass(frozen=True)
class Blocked:
    account_id: str
    reason: str


def admit_cap(cfg, priority):
    """R2/R7: the 5h percentage under which an account takes a tree of this class."""
    return cfg["low_admit_5h_max_pct"] if priority == "low" else cfg["admit_5h_max_pct"]


def week_pct(a):
    return max(a.weekly_pct, 0 if a.gate_off else a.gated_pct)


def used_pct(a):
    """The fullest window that counts for this tree, 0-100."""
    return max(a.session_pct, week_pct(a))


def credential_reason(a, cooldowns, now):
    """Why the account fails every request of this tree whatever its usage, or None."""
    if a.disabled:
        return "disabled"
    if a.needs_reauth:
        return "needs-reauth"
    if a.unserved:
        return "model-unsupported"
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


def admit_reason(a, cooldowns, cfg, now, priority="normal", manual=False):
    """R2: Auto admission headroom; Manual needs only actual serving eligibility."""
    why = serve_reason(a, cooldowns, now)
    if why:
        return why
    if manual:
        return None
    if a.session_pct >= admit_cap(cfg, priority) or week_pct(a) >= cfg["seven_day_max_pct"]:
        return "depleted"
    if registry.usage_unsampled(a, now):
        return "unsampled"
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


def admissible_at(a, cooldowns, cfg, now, priority="normal", manual=False):
    """When the account passes R2 for this class again, epoch seconds; inf when
    no reset is known or its credential or plan cannot serve."""
    if a.disabled or a.needs_reauth or a.unserved:
        return float("inf")
    at = max(now, a.limited_until, cooldowns.get(a.id, 0))
    families = [f.lower() for f in cfg["switch_models"]]
    if not a.windows:
        if (used_pct(a) >= 100 if manual else
                a.session_pct >= admit_cap(cfg, priority) or week_pct(a) >= cfg["seven_day_max_pct"]):
            return float("inf")
        return at
    for w in a.windows:
        name = w.get("name")
        if name is not None and (a.gate_off or not any(f in registry.family_tokens(name) for f in families)):
            continue
        short = name is None and registry.is_session_window(w)
        # measured: serve_reason treats the provider's 100% usage as exhaustion; Manual keeps that vendor limit.
        limit = 100 if manual else admit_cap(cfg, priority) if short else cfg["seven_day_max_pct"]
        if registry.live_pct(w, now) >= limit:
            at = max(at, window_reset_at(w))
    # The hook starts a read of an unsampled account; by REFRESH_TIMEOUT_SEC it has
    # landed or failed, and a tree that waits for the account asks again then.
    return max(at, now + registry.REFRESH_TIMEOUT_SEC) if not manual and registry.usage_unsampled(a, now) else at


def by_tier(a, table, default):
    """The entry for the account's tier name or its first word."""
    tier = (a.tier or "").lower()
    return table.get(tier, table.get(tier.split(" ")[0], default)) if tier else default


def tier_units(a, cfg):
    """How many 'max 5x' plans the account is worth: max 20x 4, max 5x and team 1,
    pro 0.5. Codex plans and unknown tiers count 1."""
    return by_tier(a, cfg["tier_units"], 1) if a.provider == "anthropic" else 1


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
    trees = load.get(a.id, 0) + 1
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
    """Stay, Admit, Wait or Blocked for one request. Manual selection never
    changes identity; automatic selection returns None when no account can serve.
    Pure: the caller writes what it decides under the pool flock, so trees that
    ask together see each other's admissions and waits."""
    manual = tree.pin or tree.pool_pin
    pin_reason = "session_pin" if tree.pin else "pool_pin"
    if manual:
        accounts = [dataclasses.replace(a, disabled=False) for a in accounts if a.id == manual]
        if not accounts:
            return Blocked(manual, "missing")
        reason = credential_reason(accounts[0], cooldowns, now)
        if reason:
            return Blocked(manual, reason)
    else:
        accounts = [a for a in accounts if not a.disabled]
    by_id = {a.id: a for a in accounts}
    p = tree.priority if tree.priority in PRIORITY_RANK else "normal"
    rank = tree_rank(tree, now)
    cur = by_id.get(tree.current)
    load = book.load

    def why_not(a):
        return "missing" if a is None else admit_reason(a, cooldowns, cfg, now, p, manual=bool(manual))

    admissible = [a for a in accounts if why_not(a) is None]
    sole = len(admissible) == 1
    # A higher codex plan comes first: the API refuses several models on a free
    # plan (2026-10-09 drill). Anthropic accounts carry no plan.
    ranked = sorted(admissible, key=lambda a: (-plan_tier(a), -score(a, cfg, now, p, load), a.label))
    scores = tuple((a.label, round(score(a, cfg, now, p, load), 2)) for a in ranked)

    def own_cell(a):
        """The tree's reservation on `a` is due, its cell has not passed, and nobody ranked ahead took it.
        A tree back after its cell passed asks for the current cell like any other tree (`first_open`). On 10-22
        01a15c6c, back at 15:30:00Z for its 15:28:00Z cell on claude19, entered the 15:30:00Z cell that 01a15984,
        waiting since 15:23Z, held, and 01a15984 lost its cell twice before it got in at 15:32:03Z."""
        if not tree.wait or tree.wait[0] != a.id or tree.wait[1] > now + 2:
            return False
        sp = slot_spacing(a, cfg)
        cell = int(tree.wait[1] // sp)
        return cell >= int(now // sp) and not cell_taken(a, cell, tree, rank, book, cfg)

    def open_now(a):
        return own_cell(a) or first_open(a, now, tree, rank, book, cfg, sole) <= now

    def others(skip):
        return tuple(a for a in ranked if a.id != skip and open_now(a))

    cur_why = "missing" if tree.current and cur is None else (serve_reason(cur, cooldowns, now) if cur else None)
    left = (tree.current, "pin" if manual and tree.current != manual else cur_why) if tree.current else None
    shadowed = None
    own_ok = cur is not None and credential_reason(cur, cooldowns, now) is None
    vend = cur if own_ok and cur_why is not None else None

    if cur_why is None and cur is not None and not tree.wait and (manual or tree.leave != cur.id):
        better = [a for a in ranked if plan_tier(a) > plan_tier(cur) and open_now(a)]
        if better:
            return Admit(better[0], "upgrade", shadowed, (cur.id, "plan"), others(better[0].id), scores)
        return Stay(cur, pin_reason if manual else "stay", shadowed, others(cur.id))

    # The tree enters an account: it is new, its account stopped serving, it was
    # asked to leave, or it waits for a slot.
    if left and cur_why is None:
        left = (tree.current, "asked" if tree.leave == tree.current else "waiting")
    optional = cur is not None and cur_why is None
    moved = sum(1 for t in tree.moves if now - t < MOVE_WINDOW_SEC)
    budget = cfg["max_moves_per_day"].get(p, cfg["max_moves_per_day"].get("normal", 3))
    stuck = own_ok and moved >= budget and (p != "high" or optional)
    # R6 holds only while the tree's own account takes it within budget_wait_max_sec
    # of the start of its wait. Past that the tree moves anyway:
    # a stalled tree costs the owner the work, a move costs one cache rewrite (about
    # 0.5M tokens). On 10-18 01a11a24, a low tree out of moves, waited from 15:09Z to
    # 17:21Z for claude9, since each request measured the hour from itself. Trees
    # that escape together still enter at R4's slot pace, in R5's wait order.
    deadline = (tree.wait[2] if tree.wait else now) + cfg["budget_wait_max_sec"]
    if stuck and (now >= deadline or admissible_at(cur, cooldowns, cfg, now, p) > deadline):
        stuck = False
        left = (tree.current, "budget_overrun")

    def leaving(a):
        return not manual and tree.leave is not None and a.id == tree.leave == tree.current

    def allowed(a):
        return not leaving(a) and (not stuck or a.id == tree.current)

    candidates = [a for a in ranked if allowed(a)]
    for a in candidates:
        if open_now(a):
            reason = (pin_reason if manual else "back" if a.id == tree.current
                      else "switch" if tree.current else "new")
            return Admit(a, reason, shadowed, None if a.id == tree.current else left, others(a.id), scores)
    if tree.leave and cur is not None and tree.leave == cur.id and cur_why is None and not tree.wait:
        return Stay(cur, "stay", shadowed)

    frees = [(a, admissible_at(a, cooldowns, cfg, now, p, manual=bool(manual)))
             for a in accounts if allowed(a) and not credential_reason(a, cooldowns, now)]
    frees = [(a, t0) for a, t0 in frees if t0 != float("inf")]
    options = []
    for a, t0 in frees:
        if tree.wait and tree.wait[0] == a.id and tree.wait[1] >= t0 and not cell_taken(
                a, int(tree.wait[1] // slot_spacing(a, cfg)), tree, rank, book, cfg):
            t = max(tree.wait[1], now)
        else:
            t = first_open(a, t0, tree, rank, book, cfg, len(frees) == 1)
        options.append((t, a.id != tree.current, -score(a, cfg, t, p, load), a.label, a))
    if not options:
        return Blocked(manual, why_not(by_id[manual]) or "busy") if manual else None
    slot_at, _, _, _, slot_account = min(options, key=lambda o: o[:4])
    if stuck:
        slot_at = min(slot_at, deadline)
    if slot_at == float("inf"):
        return Blocked(manual, "busy") if manual else None
    return Wait(slot_at, slot_account, vend, shadowed, left, room=tuple(candidates))


def in_use_counts(state, provider, now=None, window_sec=None):
    """Count active vends for R3 load. Archived Manual pins remain persistent but add no idle load."""
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
                pin=pin.get("account_id"), pool_pin=prov.get("pin"),
                leave=((rec.get("leave") or {}).get(provider) or {}).get("account_id"),
                priority=rec.get("priority") or "normal",
                moves=tuple((rec.get("moves") or {}).get(provider) or ()),
                wait=(wait.get("account"), wait["slot_at"], wait["since"]) if wait else None)


def selection_view(tree):
    """The tree's selection as the extension reads it: Manual names its account."""
    account_id = tree.pin or tree.pool_pin
    return {"mode": "manual", "account_id": account_id} if account_id else {"mode": "auto"}


def book_for(state, provider, key, cfg, now):
    """The admissions and waits of every tree on this provider but `key`'s own."""
    prov = state["providers"].get(provider) or registry.empty_provider_state()
    admitted = {a: tuple((at, t) for at, t in entries if now - at <= ADMISSION_KEEP_SEC)
                for a, entries in (prov.get("admissions") or {}).items()}
    waiting, parked = {}, {}
    for k, rec in state["sessions"].items():
        wait = (rec.get("wait") or {}).get(provider)
        if not wait or not wait.get("account") or (key and k == key.key):
            continue
        parked[wait["account"]] = parked.get(wait["account"], 0) + 1
        rank = (PRIORITY_RANK.get(rec.get("priority") or "normal", 1), wait["since"], k)
        waiting.setdefault(wait["account"], []).append((wait["slot_at"], k, rank))
    return Book(admitted, {a: tuple(v) for a, v in waiting.items()},
                in_use_counts(state, provider, now, cfg["active_session_sec"]), parked)
