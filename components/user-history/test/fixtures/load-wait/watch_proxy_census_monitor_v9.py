#!/usr/bin/env python3
"""Watch a crawler tier's proxy lanes and print what they do. It never pauses anything.

  python3 watch_proxy_census_monitor_v9.py --tier production --minutes 300 --every 30 --monitor-read

v9 (2026-10-12, strip-arbitrary-limits job, owner: "even being blocked 50% of time is fine ...
it's rotating proxy so make use of that", and "strip every ... arbitrary overly safe limit"):
v8's stop rules are gone, because no measurement backed any of their numbers. Gone are the
5% failed-jobs and /api/live 5xx aborts (--max-error, JOB_MIN 20), the 90 s supply-hold
clock (HOLD_CLEAR_SECONDS), the dead-gateway test (NO_ANSWER_MIN_TRANSPORT 20 in 1 min, a copy
of the crawler's own SUPPLY_HOLD_UNREACHABLE rule), the per-lane no-ok rule
(LANE_NO_OK_MIN_ATTEMPTS 20), the watch-monitor 85% receipts rule with its stale, walk-idle
and walk-max ages, the two-failed-staging-reads rule, the 3-ticks-blind and 3-failed-box-read
aborts, the api/* WARN line, the staging 30 min WARN line, the old-account grace and the whole
--act pause path (PAUSE_KEYS, the audited write, the manual curl). The crawler's own supply
hold already stops a lane whose gateway is dead, and sirocco retries a blocked attempt on a
fresh exit, so a watch that paused every lane on top of that only stopped good work.

Each tick reads, through the tier ingress with that tier's CRAWLER_API_KEY (decrypted
from apps/search/.env{,.staging}; never printed), and prints:
  /ops/proxy-bytes            attempts, ok and wire MB per lane since the start and this tick
  /ops/census/instagram/ramp  the census window since the start: jobs, failed jobs,
                              401/429 and transport shares
  /ops/request-timings/recent every /api/live/instagram status since the start
  /ops/status                 supply holds (and staging's with --staging)
With --monitor-read (production only), one read-only ssh + docker exec psql on the prod box
(PGAPPNAME=metal-g4-watch-read, BEGIN READ ONLY) every --monitor-every seconds prints the
watch-monitor lanes' last-10-minute receipts and wire-attempt classes.
"""
import argparse, json, math, subprocess, sys, time
import urllib.error
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parents[9]
BASE = {"staging": "https://crawler-staging.virev.ai", "production": "https://crawler.virev.ai",
        "local": "http://localhost:8787"}
FILE = {"staging": ".env.staging", "production": ".env"}
#: Bounds a read on a dead peer; urlopen has no timeout of its own.
TIMEOUT_S = 20
METAL = "root@64.34.205.243"
MONITOR_CONTAINER = "virev-prod-postgres"
ERRORS = (urllib.error.URLError, TimeoutError, KeyError, TypeError, ValueError)


def key(tier):
    if tier == "local":
        for line in (REPO / "apps/crawler-v3/.env.local").read_text().splitlines():
            if line.startswith("CRAWLER_API_KEY="):
                return line.split("=", 1)[1].split("  #")[0].strip()
        sys.exit("no local CRAWLER_API_KEY")
    r = subprocess.run(["dotenvx", "get", "CRAWLER_API_KEY", "-f", FILE[tier]], cwd=REPO / "apps/search",
                       capture_output=True, text=True)
    if r.returncode or not r.stdout.strip():
        sys.exit("cannot decrypt CRAWLER_API_KEY")
    return r.stdout.strip()


def get(tier, k, path):
    req = urllib.request.Request(BASE[tier] + path, headers={"X-API-Key": k})
    with urllib.request.urlopen(req, timeout=TIMEOUT_S) as resp:
        return json.load(resp)["data"]


def describe(exc):
    """The error class plus the HTTP status when there is one (HTTPError 502)."""
    return f"{type(exc).__name__} {exc.code}" if isinstance(exc, urllib.error.HTTPError) else type(exc).__name__


def lanes(pb):
    out = {}
    for day in pb["days"]:
        for ln in day["lanes"]:
            acc = out.setdefault(f'{ln["lane"]}/{ln["operation"]}', [0, 0, 0])
            acc[0] += ln["attempts"]; acc[1] += ln["ok"]; acc[2] += ln["wire_bytes"]
    return out


def share(n, d):
    return f"{n / d:.0%}" if d else "-"


def census_line(win, minutes):
    """The census window as one line. Pure: the offline cases call it."""
    jobs, att = win["jobs"], win["attempts"]
    failed = jobs - win["succeeded"]
    return (f"instagram_census last {minutes} min: failed jobs {failed}/{jobs} ({share(failed, jobs)}), "
            f"attempts {att}: 401/429 {win['rate_limited_attempts']} ({share(win['rate_limited_attempts'], att)}), "
            f"transport {win['transport_failed_attempts']} ({share(win['transport_failed_attempts'], att)})")


MONITOR_SQL = """\\set SHOW_CONTEXT never
\\set QUIET on
BEGIN READ ONLY;
WITH claims AS (
  SELECT c.* FROM watch_target_claims c
  JOIN watch_targets w ON w.platform = c.platform AND w.kind = c.kind AND w.target = c.target
  WHERE c.platform = 'instagram' AND w.tier <> 'base' AND c.claimed_at >= now() - interval '2 hours')
SELECT json_build_object(
  'issued', count(*) FILTER (WHERE claimed_at >= now() - interval '10 minutes'),
  'settled', count(*) FILTER (WHERE settled_at >= now() - interval '10 minutes'),
  'settled_ok', count(*) FILTER (WHERE settled_at >= now() - interval '10 minutes' AND outcome IN ('ok', 'gone')),
  'settled_error', count(*) FILTER (WHERE settled_at >= now() - interval '10 minutes' AND outcome = 'error'),
  'settled_starved', count(*) FILTER (WHERE settled_at >= now() - interval '10 minutes' AND outcome = 'starved'),
  'open', count(*) FILTER (WHERE settled_at IS NULL)) FROM claims;
SELECT json_build_object(
  'attempts', count(*),
  'ok', count(*) FILTER (WHERE a.outcome = 'ok'),
  'r401_429', count(*) FILTER (WHERE a.http_status IN (401, 429) OR a.error_class = 'RateLimitError'),
  'r400_asset', count(*) FILTER (WHERE a.http_status = 400 AND a.error_class = 'UpstreamAssetServingError'),
  'r404_phantom', count(*) FILTER (WHERE a.http_status = 404 AND a.error_class = 'PhantomNotFoundError'),
  'transport', count(*) FILTER (WHERE a.outcome IN ('transport_error', 'timeout') OR a.error_class IN ('TransientError', 'ProxyQuotaExhaustedError')
                                   OR (a.proxy_connect_status IS NOT NULL AND a.proxy_connect_status <> 200)),
  'r5xx', count(*) FILTER (WHERE a.http_status >= 500))
FROM ig_anon_wire_attempts a
JOIN (SELECT DISTINCT c.batch_id, i AS target_index
      FROM watch_target_claims c
      CROSS JOIN LATERAL unnest(c.op_indexes) AS i
      JOIN watch_targets w ON w.platform = c.platform AND w.kind = c.kind AND w.target = c.target
      WHERE c.platform = 'instagram' AND w.tier <> 'base' AND c.claimed_at >= now() - interval '2 hours') m
  ON m.batch_id = a.batch_id AND m.target_index = a.target_index
WHERE a.started_at >= now() - interval '10 minutes';
COMMIT;
"""


def monitor_read():
    """(receipts, attempts) dicts from one ssh + docker exec psql, or the reason it failed."""
    inner = (f"docker exec -i -e PGAPPNAME=metal-g4-watch-read {MONITOR_CONTAINER} sh -c "
             "'psql -U \"$POSTGRES_USER\" -d crawler_v3 -X -At -v ON_ERROR_STOP=1 -v VERBOSITY=terse'")
    try:
        r = subprocess.run(["ssh", "-o", "BatchMode=yes", METAL, inner], input=MONITOR_SQL,
                           capture_output=True, text=True, timeout=TIMEOUT_S)
        rows = [json.loads(line) for line in r.stdout.splitlines() if line.startswith("{")]
    except (subprocess.TimeoutExpired, OSError, ValueError) as exc:
        return type(exc).__name__
    return (rows[0], rows[1]) if not r.returncode and len(rows) == 2 else f"exit {r.returncode}: {r.stderr.strip()[:200]}"


def monitor_line(rec, att):
    """The watch-monitor read as one line. Pure: the offline cases call it."""
    n = att["attempts"]
    return (f"watch-monitor 10 min: receipts ok {rec['settled_ok']}/{rec['settled']} ({share(rec['settled_ok'], rec['settled'])}; "
            f"issued {rec['issued']}, error {rec['settled_error']}, starved {rec['settled_starved']}, open {rec['open']}), "
            f"attempts {n}: ok {att['ok']}, 401/429 {share(att['r401_429'], n)}, transport {share(att['transport'], n)}, "
            f"400 asset {att['r400_asset']}, 404 phantom {att['r404_phantom']}, 5xx {att['r5xx']}")


def holds_line(tier, holds):
    if not holds:
        return f"no supply hold on {tier}"
    return "; ".join(f"HOLD {tier} {h.get('provider')} {h.get('account')} {h.get('code')} {h.get('connect_status')}"
                     for h in holds)


def tick(a, k, sk, state):
    stamp = time.strftime("%H:%M:%SZ", time.gmtime())
    out = []
    now = lanes(get(a.tier, k, "/ops/proxy-bytes"))
    if any(n.startswith("instagram_census/") for n in now):
        minutes = max(1, math.ceil((time.time() - state["started"]) / 60))
        try:
            cur = get(a.tier, k, f"/ops/census/instagram/ramp?minutes={minutes}")["windows"]["current"]
            out.append(census_line({f: int(cur[f]) for f in cur if f in (
                "jobs", "succeeded", "attempts", "rate_limited_attempts", "transport_failed_attempts")}, minutes))
        except ERRORS as exc:
            out.append(f"instagram_census ramp read failed ({describe(exc)})")
    if a.monitor_read and time.time() >= state["next_monitor"]:
        state["next_monitor"] = time.time() + a.monitor_every
        read = monitor_read()
        out.append(monitor_line(*read) if isinstance(read, tuple) else f"watch-monitor read failed ({read})")
    last = state["last_lanes"] or state["start"]
    state["last_lanes"] = now
    for name, (att, ok, wb) in sorted(now.items()):
        s, p = state["start"].get(name, [0, 0, 0]), last.get(name, [0, 0, 0])
        if att - s[0]:
            out.append(f"{name}: +{att - s[0]} attempts, +{ok - s[1]} ok ({share(ok - s[1], att - s[0])}), "
                       f"+{(wb - s[2]) / 1e6:.1f} MB wire; this tick +{att - p[0]} attempts, +{ok - p[1]} ok")
    # 500 is the route's own `le=500` (src/http/routes/ops_health.py); its default is 100.
    rows = get(a.tier, k, f"/ops/request-timings/recent?since={state['since']}&limit=500").get("rows", [])
    if rows:
        codes = {}
        for row in rows:
            codes[row["status"]] = codes.get(row["status"], 0) + 1
        out.append(f"/api/live/instagram since start: {dict(sorted(codes.items()))}")
    out.append(holds_line(a.tier, get(a.tier, k, "/ops/status").get("supply_holds", [])))
    if sk:
        try:
            out.append(holds_line("staging", get("staging", sk, "/ops/status").get("supply_holds", [])))
        except ERRORS as exc:
            out.append(f"staging /ops/status unreadable ({describe(exc)})")
    for line in out:
        print(f"{stamp} {line}", flush=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tier", required=True, choices=list(BASE))
    ap.add_argument("--minutes", type=float, required=True)
    ap.add_argument("--every", type=float, required=True, help="seconds between ticks")
    ap.add_argument("--staging", action="store_true", help="also print staging's supply holds (shared GeoNode account)")
    ap.add_argument("--monitor-read", action="store_true",
                    help="read the watch-monitor lanes from the prod box (read-only); production only")
    ap.add_argument("--monitor-every", type=float, default=60, help="seconds between box reads")
    a = ap.parse_args()
    if a.monitor_read and a.tier != "production":
        sys.exit("--monitor-read reads the production box only")
    k = key(a.tier)
    sk = key("staging") if a.staging else None
    state = {"start": lanes(get(a.tier, k, "/ops/proxy-bytes")), "last_lanes": None, "started": time.time(),
             "since": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "next_monitor": 0.0}
    end = time.time() + a.minutes * 60
    while time.time() < end:
        try:
            tick(a, k, sk, state)
        except ERRORS as exc:
            print(f"{time.strftime('%H:%M:%SZ', time.gmtime())} {a.tier} read failed ({describe(exc)})", flush=True)
        time.sleep(a.every)
    print(f"{time.strftime('%H:%M:%SZ', time.gmtime())} watch done", flush=True)


if __name__ == "__main__":
    main()
