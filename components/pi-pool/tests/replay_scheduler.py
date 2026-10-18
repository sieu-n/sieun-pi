"""Replay a day of real Claude requests through the old resolver and the new
scheduler, and count moves, stampedes, moves into hot accounts, the cache writes
those moves cost, and the requests that waited.

    PI_POOL_DIR=<scratch dir outside the code> /usr/bin/python3 -B tests/replay_scheduler.py \
        --data <session data dir> --old <old vend.py> --new vend.py --day 20261012 [--day 20261010] [--seed 1]

The data dir holds sim-trace-<day>.json ({"requests": [[epoch, root session, cost
usd]]}), usage-samples.jsonl, requests-<day>.jsonl (for each account's tier) and
sim-snapshot-20261012.json; the schema is in research-measure.md next to it.

The model:
- An account's 5h window takes cost / dollars-per-point (7.5 for max 20x, 1.9 for
  max 5x and team, measured 2026-10-12) and its week a fifth of that. A 5h window
  starts on the first request after it reset. An account at 100% answers 429 until
  that window resets.
- The pickers see usage sampled every --sample-sec (600 s), as the pool's
  samples lag; the provider answers from the true figures.
- A 429 runs `pi-pool limited`. Old: the retry goes at once to `next`, else the
  tree sleeps until the provider's reset (Prime's wait-for-usage). New: the retry
  goes to `next`, else the tree sleeps until its slot, at most 15 min at a time,
  as the extension asks Prime.
- A tree that sleeps holds every later request of its tree until it wakes.
- A move is a tree served by another account than its previous request. It is
  warm when the previous request was under 3600 s before; a warm move costs the
  day's measured cache write per root move (--move-tokens).
"""
import argparse, collections, heapq, importlib.util, json, os, random, statistics, sys, types

FIVE_H, WEEK = 18000, 604800
WEEK_POINTS_PER_5H_POINT = 0.2
DOLLARS_PER_POINT = {"max 20x": 7.5}
DEFAULT_DOLLARS_PER_POINT = 1.9
# switch_warm cache write / moves, research-measure.md "Cache writes per day" and "Moves per day"
MOVE_TOKENS = {"20261008": 492_000, "20261009": 756_000, "20261010": 392_000, "20261012": 626_000}
RECHECK_SEC = 900
P = "anthropic"


def load(path, name):
    """The names replay() reads. An old vend.py defines them all; a newer one keeps
    them in the pool/ package it loads, one module per part."""
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    if not hasattr(module, "pool"):
        return module
    parts = (module.pool.base, module.pool.registry, module.pool.sched, module.pool.vending, module.pool.session_cmds)
    return types.SimpleNamespace(**{k: v for part in parts for k, v in vars(part).items()})


def start_state(data, day, start):
    """{id: {email, dead, five: (pct, reset), week: (pct, reset)}} at `start`."""
    if day == "20261012":
        snap = json.load(open(os.path.join(data, "sim-snapshot-20261012.json")))
        out = {}
        for a in snap["accounts"]:
            def level(secs):
                w = next((w for w in a["windows"] if w.get("name") is None and w.get("windowSeconds") == secs), {})
                reset = (w.get("resetsAt") or 0) / 1000
                return (w.get("usedPercentage") or 0, reset) if reset > start else (0, None)
            out[a["id"]] = {"email": a["email"], "dead": a["needs_reauth"] or a["disabled"],
                            "five": level(FIVE_H), "week": level(WEEK)}
        return out
    samples = [json.loads(line) for line in open(os.path.join(data, "usage-samples.jsonl"))]
    snap = json.load(open(os.path.join(data, "sim-snapshot-20261012.json")))
    out = {}
    for a in snap["accounts"]:
        mine = [s for s in samples if s["account_id"] == a["id"] and s["source"] != "pi-pool.log limited (429)"]
        near = min(mine, key=lambda s: abs(s["ts"] - start)) if mine else None

        def level(pct, reset):
            return (pct or 0, reset) if reset and reset > start else (0, None)
        out[a["id"]] = {"email": a["email"], "dead": a["needs_reauth"] or a["disabled"],
                        "five": level(near and near["five_pct"], near and near["five_resets_at"]),
                        "week": level(near and near["week_pct"], near and near["week_resets_at"])}
    return out


def tiers(data, day):
    tier = {}
    path = os.path.join(data, f"requests-{day}.jsonl")
    for line in open(path):
        r = json.loads(line)
        if r.get("account") and r.get("tier"):
            tier[r["account"]] = r["tier"]
    return tier


class Truth:
    def __init__(self, start_levels, tier):
        self.a = {id: dict(v, tier=tier.get(v["email"], "max 20x")) for id, v in start_levels.items()}

    def tick(self, now):
        for a in self.a.values():
            if a["five"][1] is not None and a["five"][1] <= now:
                a["five"] = (0, None)
            if a["week"][1] is not None and a["week"][1] <= now:
                a["week"] = (0, a["week"][1] + WEEK)

    def serves(self, id):
        a = self.a[id]
        return not a["dead"] and a["five"][0] < 100 and a["week"][0] < 100

    def free_at(self, id, now):
        a = self.a[id]
        t = [w[1] for w in (a["five"], a["week"]) if w[0] >= 100 and w[1]]
        return max(t) if t else now + FIVE_H

    def spend(self, id, cost, now):
        a = self.a[id]
        points = cost / DOLLARS_PER_POINT.get(a["tier"], DEFAULT_DOLLARS_PER_POINT)
        pct, reset = a["five"]
        a["five"] = (pct + points, reset or now + FIVE_H)
        a["week"] = (a["week"][0] + points * WEEK_POINTS_PER_5H_POINT, a["week"][1] or now + WEEK)

    def view(self, vend, now):
        out = []
        for id, a in self.a.items():
            wins = tuple({"usedPercentage": round(min(pct, 100)), "windowSeconds": secs, "sampledAt": now * 1000,
                          "resetsAt": reset * 1000 if reset else None}
                         for (pct, reset), secs in ((a["five"], FIVE_H), (a["week"], WEEK)))
            out.append(vend.Account(provider=P, id=id, email=a["email"], label=a["email"], needs_reauth=a["dead"],
                                    session_pct=round(min(a["five"][0], 100)), weekly_pct=round(min(a["week"][0], 100)),
                                    gated_pct=0, is_live=False, cred=None, tier=a["tier"], windows=wins,
                                    usage_at=now, gate_off=True))
        return out


def replay(vend, new, levels, tier, requests, cfg, seed, sample_sec, end):
    truth = Truth(levels, tier)
    state = {"version": 2, "providers": {p: vend.empty_provider_state() for p in vend.PROVIDERS}, "sessions": {}}
    rng = random.Random(seed)
    heap = [(at, i, root, cost, at) for i, (at, root, cost) in enumerate(requests)]
    heapq.heapify(heap)
    blocked = {}
    view, view_at = None, -1e18
    served_on, served_at = {}, {}
    moves, waits, hops = [], [], 0
    unserved = 0
    while heap:
        t, seq, root, cost, orig = heapq.heappop(heap)
        if t > end:
            unserved += 1 + len(heap)
            break
        if blocked.get(root, 0) > t:
            heapq.heappush(heap, (blocked[root], seq, root, cost, orig))
            continue
        truth.tick(t)
        if t - view_at >= sample_sec:
            view, view_at = truth.view(vend, t), t
        key = vend.SessionKey(root, root, None)
        state["sessions"].setdefault(root, {"uuid": root, "active_id": None, "pins": {}, "vends": {}, "last_seen": t})
        vend.HookWriter(state).prune(cfg, t)
        pick, sleep_until = None, None
        if new:
            d, tree, _ = vend.schedule(state, key, P, view, cfg, t)
            if isinstance(d, (vend.Admit, vend.Stay)):
                pick = d.account
                vend.HookWriter(state).record_vend(key, P, pick, "store", d.reason, None, t, (1, "s"),
                                                   moved=tree.current is not None and pick.id != tree.current)
            elif isinstance(d, vend.Wait):
                sleep_until = min(d.slot_at, t + RECHECK_SEC)
            else:
                unserved += 1
                continue
        else:
            accounts = vend.with_pool_state(view, state, P)
            intent = vend.intent_for(state, key, P)
            in_use = vend.in_use_counts(state, P, t, cfg["active_session_sec"])
            res = vend.resolve(intent, accounts, in_use, {}, cfg, t, rng)
            pick = res.account if res else vend.last_resort(accounts, {}, cfg, t, intent.current, in_use)
            if pick is None:
                unserved += 1
                continue
            vend.HookWriter(state).record_vend(key, P, pick, "store", res.reason if res else "last_resort", None, t, (1, "s"))
        if pick is not None and not truth.serves(pick.id):
            hops += 1
            vend.HookWriter(state).set_limit(P, pick.id, truth.free_at(pick.id, t), key, t)
            if new:
                d = vend.plan_next(state, key, P, view, cfg, t)
                sleep_until = t + 1 if isinstance(d, (vend.Admit, vend.Stay)) else (
                    min(d.slot_at, t + RECHECK_SEC) if isinstance(d, vend.Wait) else t + RECHECK_SEC)
            else:
                nxt = vend.next_account(state, key, P, view, cfg, t)
                sleep_until = t + 1 if nxt is not None else truth.free_at(pick.id, t)
            pick = None
        if pick is None:
            blocked[root] = max(sleep_until, t + 1)
            heapq.heappush(heap, (blocked[root], seq, root, cost, orig))
            continue
        before = served_on.get(root)
        if before is not None and before != pick.id:
            warm = t - served_at[root] < cfg["cache_ttl_sec"]
            moves.append((t, root, pick.id, warm, truth.a[pick.id]["five"][0]))
        truth.spend(pick.id, cost, t)
        served_on[root], served_at[root] = pick.id, t
        if t - orig > 5:
            waits.append(t - orig)
    return moves, waits, hops, unserved


def stampedes(moves, window=600, roots=4):
    count = 0
    by_account = collections.defaultdict(list)
    for t, root, account, _, _ in sorted(moves):
        by_account[account].append((t, root))
    for entries in by_account.values():
        cluster, last = set(), None
        for t, root in entries:
            if last is not None and t - last > window:
                count += len(cluster) >= roots
                cluster = set()
            cluster.add(root)
            last = t
        count += len(cluster) >= roots
    return count


def burst(moves, window=120):
    """The most moves onto one account within `window` seconds."""
    by_account = collections.defaultdict(list)
    for t, _, account, _, _ in moves:
        by_account[account].append(t)
    best = 0
    for times in by_account.values():
        times.sort()
        lo = 0
        for hi, t in enumerate(times):
            while t - times[lo] > window:
                lo += 1
            best = max(best, hi - lo + 1)
    return best


def summary(moves, waits, hops, unserved, move_tokens):
    per_root = collections.Counter(root for _, root, _, _, _ in moves)
    counts = sorted(per_root.values())

    def q(p):
        return counts[min(len(counts) - 1, int(p * len(counts)))] if counts else 0
    warm = sum(1 for m in moves if m[3])
    return {"moves": len(moves), "roots_moved": len(per_root),
            "per_root_p50": statistics.median(counts) if counts else 0, "per_root_p90": q(0.9), "per_root_max": max(counts, default=0),
            "stampedes": stampedes(moves), "max_moves_onto_one_account_in_120s": burst(moves), "moves_into_70": sum(1 for m in moves if m[4] >= 70),
            "warm_moves": warm, "move_cache_write_tokens": warm * move_tokens,
            "requests_429": hops, "requests_waited": len(waits),
            "longest_wait_min": round(max(waits, default=0) / 60, 1), "unserved": unserved}


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--data", required=True)
    p.add_argument("--old", required=True)
    p.add_argument("--new", required=True)
    p.add_argument("--day", action="append", required=True)
    p.add_argument("--seed", type=int, default=1)
    p.add_argument("--sample-sec", type=int, default=600)
    p.add_argument("--five-hour-max", type=int, default=85, help="the old resolver's five_hour_max_pct (this Mac's config)")
    a = p.parse_args()
    # the old resolver's next_account draws from the random module itself
    random.seed(a.seed)
    old = load(a.old, "vend_old")
    new = load(a.new, "vend_new")
    out = {}
    for day in a.day:
        requests = [tuple(r) for r in json.load(open(os.path.join(a.data, f"sim-trace-{day}.json")))["requests"]]
        requests.sort()
        start = requests[0][0]
        levels, tier = start_state(a.data, day, start), tiers(a.data, day)
        end = requests[-1][0] + 8 * 3600
        out[day] = {"requests": len(requests), "roots": len({r[1] for r in requests})}
        for name, vend, is_new, cfg in (("old", old, False, dict(old.DEFAULTS, five_hour_max_pct=a.five_hour_max)),
                                        ("new", new, True, dict(new.DEFAULTS))):
            result = replay(vend, is_new, levels, tier, requests, cfg, a.seed, a.sample_sec, end)
            out[day][name] = summary(*result, MOVE_TOKENS.get(day, 500_000))
        print(json.dumps({day: out[day]}), flush=True)


if __name__ == "__main__":
    main()
