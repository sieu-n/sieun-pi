"""Reads for the SEO guy's duty prechecks (scripts/duties/seo-search-visits.ts and seo-new-articles.ts). No model call, no writes
to the program's daily metrics file. Run inside auto-sns-agent's SEO CLI project, from that repo's root:
`uv run --project scripts/seo --frozen python <this file> visits|inspect`. Prints one JSON object on stdout.

visits: PostHog blog and tool visits (virev_seo.traffic), Search Console totals (virev_seo.gsc) and 28-day sign-ups with
their first page (virev_seo.signups and virev_seo.goal). Each source is read on its own, so one failure leaves the others.
inspect: URL Inspection for the URLs on stdin (one per line), counted in metrics/inspect-quota.json like `seo gsc inspect`, retries included.
"""

from __future__ import annotations

import json
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta
from typing import Any


def _error(exc: BaseException) -> dict[str, str]:
    return {"error": f"{type(exc).__name__}: {exc}"}


def traffic_read() -> dict[str, Any]:
    from virev_seo import traffic

    t = traffic.collect(days=28)  # the longest window the duty reads, goal_visits_d28
    return {
        "windows": {
            name: {k: w[k] for k in ("start", "end", "per_day", "goal_by_source_per_day")} for name, w in t["windows"].items()
        },
        "last_day": t["daily"][-1],
        "sessions_read": t["sessions_read"],
        "top_goal_entries_d28": t["top_goal_entries_d28"][:5],
    }


def gsc_read() -> dict[str, Any]:
    from virev_seo import gsc
    from virev_seo.config import today_kst

    sess = gsc.session()
    today = today_kst()
    # The same 10-day look-back as virev_seo.gsc.latest_dates, without its fallback that guesses a final day when none is found.
    finals = gsc.query(sess, today - timedelta(days=10), today, ["date"], data_state="final")
    last_final = max((r["date"] for r in finals), default=None)
    out: dict[str, Any] = {"today": today.isoformat(), "last_final": last_final}
    if last_final is None:
        return out
    wins = {w.name: w for w in gsc.windows(datetime.fromisoformat(last_final).date())}
    for name in ("d7", "d7_prior"):
        out[name] = {"start": wins[name].start.isoformat(), "end": wins[name].end.isoformat(), **gsc._totals(sess, wins[name])}
    return out


def signups_read() -> dict[str, Any]:
    from virev_seo import goal, signups
    from virev_seo.config import today_kst

    end = today_kst()
    users = signups.clerk_users()
    external = [u for u in users if not signups.is_internal(u)]
    # The 28 Seoul days ending today, the same window as signups.collect() (window_counts d28 and its attribution list).
    recent = [u["id"] for u in external if signups._kst_day(u["created_at"]) >= end - timedelta(days=27)]
    attribution = signups.posthog_first_touch(recent)
    out: dict[str, Any] = {"clerk_users": len(users), "d28": len(recent), "attribution": attribution.get("status")}
    if attribution.get("status") != "ok":
        out["attribution_error"] = str(attribution.get("message") or attribution.get("what_is_missing") or "")
        return out
    out["matched"] = attribution["matched"]
    out["by_section"] = goal.first_touch_sections(attribution)
    return out


def visits() -> dict[str, Any]:
    out: dict[str, Any] = {}
    with ThreadPoolExecutor(3) as pool:
        futures = {name: pool.submit(read) for name, read in (("traffic", traffic_read), ("gsc", gsc_read), ("signups", signups_read))}
        for name, future in futures.items():
            try:
                out[name] = future.result()
            except Exception as exc:  # each source fails on its own; the precheck reports it
                out[name] = _error(exc)
    return out


# A row that came back 5xx or with no answer (a connection error, http 0) is asked again after each wait here. Google's API error guide
# says to retry 500, 502, 503 and 504 with exponential backoff (developers.google.com/workspace/drive/api/guides/handle-errors), and on
# 10-18 05:21 one 500 "Internal error encountered" for /ko/blog/kol-key-opinion-leader read PASS when inspected again minutes later.
# Two waits, 1 s then 2 s, keep a URL that fails every time at about 3 x 7.4 s + 3 s = 25 s, inside the 120 s precheck timeout
# (src/shared/chat-duties.ts PRECHECK_TIMEOUT_MS). Each retry spends one more inspection of the 2,000 a day, added to the quota file.
INSPECT_RETRY_WAITS_S = (1, 2)


def inspect(urls: list[str]) -> dict[str, Any]:
    from virev_seo import gsc
    from virev_seo.config import GSC_SITE, INSPECT_DAILY_QUOTA

    pt_day = (datetime.now(UTC) - timedelta(hours=7)).date().isoformat()
    left = INSPECT_DAILY_QUOTA - gsc._quota_used(pt_day)
    asked = urls[: max(0, left)]
    sess = gsc.session(write=True)

    def attempt(url: str) -> dict[str, Any]:
        try:
            resp = sess.post(gsc.INSPECT_URL, json={"inspectionUrl": url, "siteUrl": GSC_SITE})
        except Exception as exc:
            return {"url": url, "http": 0, **_error(exc)}
        try:
            payload = resp.json() if resp.content else {}
        except ValueError:
            payload = {}
        st = payload.get("inspectionResult", {}).get("indexStatusResult", {})
        return {"url": url, "http": resp.status_code, "verdict": st.get("verdict"), "coverage_state": st.get("coverageState"),
                "error": (payload.get("error") or {}).get("message")}

    def one(url: str) -> tuple[dict[str, Any], int]:
        row = attempt(url)
        tries = 1
        for wait in INSPECT_RETRY_WAITS_S:
            if row["http"] != 0 and row["http"] < 500:
                break
            time.sleep(wait)
            row = attempt(url)
            tries += 1
        if tries > 1:
            row["tries"] = tries
        return row, tries

    # Measured 10-12: one inspection takes about 7.4 s, and 32 parallel calls inspected 32 URLs in 8.5 s, all HTTP 200. That is about
    # 230 a minute, under Google's 600 a minute per property (virev_seo.config INSPECT_PER_MINUTE). The 2,000 a day quota is checked above.
    with ThreadPoolExecutor(32) as pool:
        done = list(pool.map(one, asked))
    rows = [row for row, _ in done]
    spent = sum(tries for _, tries in done)
    if spent:
        gsc._quota_add(pt_day, spent)
    return {"pt_day": pt_day, "quota_left_before": left, "rows": rows, "not_asked": urls[len(asked):]}


def main() -> None:
    command = sys.argv[1] if len(sys.argv) > 1 else ""
    if command == "visits":
        result = visits()
    elif command == "inspect":
        result = inspect([line.strip() for line in sys.stdin if line.strip()])
    else:
        sys.exit("usage: seo-sources.py visits|inspect")
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
