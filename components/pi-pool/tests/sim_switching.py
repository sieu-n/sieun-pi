"""Replay one day of Claude requests against both pickers and count switches.

    /usr/bin/python3 -B tests/sim_switching.py --old <old vend.py> --new <new vend.py> \
        --snapshot <accounts json> --trace <requests json> [--five-hour-max 85] [--seed 1]

--snapshot holds {"at", "accounts": [{id, email, needs_reauth, disabled, windows}]},
the anthropic index at one moment. --trace holds {"requests": [[epoch, session, cost]]},
each Claude request of a day with its session tree and API-equivalent dollar cost. The
replay starts the day's requests at the snapshot's time, so the accounts start as they
were then. A request spends cost / DOLLARS_PER_5H_POINT of its account's 5h window and a
fifth of that of its week (measured 2026-10-08). A window resets at its reset time, and
a 5h window starts on the first request after it reset. An account at 100% answers 429,
which marks it limited until that window resets, as `pi-pool limited` does. The per-model
Fable cap is left out for both pickers.
"""
import argparse, collections, importlib.util, json, random, sys

DOLLARS_PER_5H_POINT = 8.8
WEEK_POINTS_PER_5H_POINT = 0.2
FIVE_H, WEEK = 18000, 604800


def load(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


class Pool:
    def __init__(self, snapshot, start):
        self.accounts = {}
        for a in snapshot["accounts"]:
            five = next((w for w in a["windows"] if w.get("name") is None and w.get("windowSeconds") == FIVE_H), {})
            week = next((w for w in a["windows"] if w.get("name") is None and w.get("windowSeconds") == WEEK), {})
            def level(w):
                reset = (w.get("resetsAt") or 0) / 1000
                return (w.get("usedPercentage") or 0, reset) if reset > start else (0, None)
            self.accounts[a["id"]] = {"email": a["email"], "dead": a["needs_reauth"] or a["disabled"],
                                      "five": level(five), "week": level(week), "limited": 0}

    def tick(self, now):
        for a in self.accounts.values():
            for k in ("five", "week"):
                if a[k][1] is not None and a[k][1] <= now:
                    a[k] = (0, None if k == "five" else a[k][1] + WEEK)
            if a["limited"] <= now:
                a["limited"] = 0

    def view(self, vend, now):
        out = []
        for id, a in self.accounts.items():
            wins = []
            for k, secs in (("five", FIVE_H), ("week", WEEK)):
                pct, reset = a[k]
                wins.append({"usedPercentage": round(pct), "windowSeconds": secs, "sampledAt": now * 1000,
                             "resetsAt": reset * 1000 if reset else None})
            out.append(vend.Account(provider="anthropic", id=id, email=a["email"], needs_reauth=a["dead"],
                                    session_pct=round(a["five"][0]), weekly_pct=round(a["week"][0]), gated_pct=0,
                                    is_live=False, cred=None, windows=tuple(wins), gate_off=True,
                                    limited_until=a["limited"]))
        return out

    def spend(self, id, cost, now):
        a = self.accounts[id]
        points = cost / DOLLARS_PER_5H_POINT
        pct, reset = a["five"]
        a["five"] = (pct + points, reset if reset else now + FIVE_H)
        a["week"] = (a["week"][0] + points * WEEK_POINTS_PER_5H_POINT, a["week"][1])
        full = [a[k][1] for k in ("five", "week") if a[k][0] >= 100 and a[k][1]]
        if full:
            a["limited"] = max(full)


class Heaviest:
    def random(self):
        return 0.0


def replay(vend, new, snapshot, requests, cfg, seed, argmax=False):
    start = snapshot["at"]
    shift = start - requests[0][0]
    pool = Pool(snapshot, start)
    state = {"version": 2, "providers": {"anthropic": vend.empty_provider_state()}, "sessions": {}}
    state["providers"]["anthropic"]["seat"] = None
    rng = Heaviest() if argmax else random.Random(seed)
    moves, warm, last_at, on = collections.Counter(), collections.Counter(), {}, {}
    unserved = 0
    for at, session, cost in requests:
        now = at + shift
        pool.tick(now)
        accounts = pool.view(vend, now)
        key = vend.SessionKey(session, session, None)
        rec = state["sessions"].setdefault(session, {"pins": {}, "vends": {}, "last_seen": now})
        intent = vend.intent_for(state, key, "anthropic")
        in_use = vend.in_use_counts(state, "anthropic", now, cfg["active_session_sec"])
        args = (intent, accounts, in_use, {}, cfg, now) + ((rng,) if new else ())
        res = vend.resolve(*args)
        if res is None:
            pick = (vend.last_resort(accounts, {}, cfg, now, intent.current) if new
                    else vend.last_resort(accounts, {}, cfg, now))
            reason = "last_resort"
        else:
            pick, reason = res.account, res.reason
        if pick is None:
            unserved += 1
            continue
        if not new and reason in ("seat_move", "seat_upgrade"):
            state["providers"]["anthropic"]["seat"] = {"account_id": pick.id, "since": now}
        if on.get(session) not in (None, pick.id):
            moves[session] += 1
            if now - last_at[session] < 300:
                warm[session] += 1
        on[session], last_at[session] = pick.id, now
        rec["vends"]["anthropic"] = {"account_id": pick.id, "email": pick.email, "at": now, "n": 1}
        if vend.provider_serves(pick, now):
            pool.spend(pick.id, cost, now)
        else:
            unserved += 1
    return moves, warm, unserved


def main():
    global DOLLARS_PER_5H_POINT
    p = argparse.ArgumentParser()
    p.add_argument("--old", required=True)
    p.add_argument("--new", required=True)
    p.add_argument("--snapshot", required=True)
    p.add_argument("--trace", required=True)
    p.add_argument("--five-hour-max", type=int, default=85)
    p.add_argument("--seed", type=int, default=1)
    p.add_argument("--dollars-per-point", type=float, default=DOLLARS_PER_5H_POINT)
    p.add_argument("--argmax", action="store_true", help="the new picker always takes the heaviest account")
    a = p.parse_args()
    DOLLARS_PER_5H_POINT = a.dollars_per_point
    snapshot = json.load(open(a.snapshot))
    requests = [tuple(r) for r in json.load(open(a.trace))["requests"]]
    sessions = sorted({r[1] for r in requests})
    result = {}
    for name, path, new in (("old", a.old, False), ("new", a.new, True)):
        vend = load(path, f"vend_{name}")
        cfg = dict(vend.DEFAULTS, five_hour_max_pct=a.five_hour_max)
        result[name] = replay(vend, new, snapshot, requests, cfg, a.seed, a.argmax)
    print(json.dumps({
        "requests": len(requests), "sessions": len(sessions),
        **{name: {"switches": sum(m.values()), "warm_switches": sum(w.values()),
                  "sessions_that_switched": len(m), "max_per_session": max(m.values(), default=0),
                  "unserved_requests": u,
                  "per_session": " ".join(map(str, sorted(m.values(), reverse=True)))}
           for name, (m, w, u) in result.items()}}, indent=1))


if __name__ == "__main__":
    main()
