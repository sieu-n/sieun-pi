"""Reads for the SEO guy's duty prechecks (scripts/duties/seo-search-visits.ts and seo-new-articles.ts). No model call, no writes
to the program's daily metrics file. Run inside auto-sns-agent's SEO CLI project, from that repo's root:
`uv run --project scripts/seo --frozen python <this file> visits|inspect`. Prints one JSON object on stdout.

visits: PostHog blog and tool visits (virev_seo.traffic), Search Console totals and impressions per page (virev_seo.gsc) and 28-day
sign-ups with their first page (virev_seo.signups and virev_seo.goal). Each source is read on its own, so one failure leaves the others.
inspect: URL Inspection for the URLs on stdin (one per line), each POST, re-asks included, counted in metrics/inspect-quota.json by
virev_seo.gsc.VentSession.post like every other caller.
"""

from __future__ import annotations

import json
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta
from email.utils import parsedate_to_datetime
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
    # Impressions per page and day over the 17 final days that end on the last one (DROP_BASE_DAYS + DROP_RECENT_DAYS), for dropped_pages
    # in seo-search-visits.ts, which splits them into its base and recent windows.
    end = datetime.fromisoformat(last_final).date()
    start = end - timedelta(days=16)
    rows = gsc.query(sess, start, end, ["page", "date"])
    out["pages"] = {"start": start.isoformat(), "end": end.isoformat(),
                    "rows": [{"page": r["page"], "date": r["date"], "impressions": r["impressions"]} for r in rows]}
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


# Google's URL Inspection API sometimes answers 500 "Internal error encountered" or 503 for minutes at a time. On 10-18 at 16:45:11Z
# a 32-thread run met one: 81 calls failed until 16:48:36Z, many of them the old 1 s and 2 s retries of URLs that had just failed,
# and calls from 16:49:22Z answered 200 (Vent prod vent.call rows). So the first 5xx, 429 or unanswered call stops the run from starting
# more calls, and the failed and unasked URLs are asked once more after Google's Retry-After or, with none, after REASK_WAIT_S.
# Google's API error guide says to retry 500, 502, 503 and 504 with backoff (developers.google.com/workspace/drive/api/guides/handle-errors).
# measured: the 10-18 failure ran from the first 500 at 16:45:24Z to the last at 16:48:36Z, and calls at 16:49:22Z, 238 s in, answered 200
REASK_WAIT_S = 240
NOT_ASKED = "not asked: URL Inspection failed earlier in this run"
# Beside metrics/inspect-quota.json; it holds the time of the last 429 until a call answers 200.
REFUSED_FILE = "inspect-refused.json"


def _not_asked(url: str) -> dict[str, Any]:
    return {"url": url, "http": 0, "verdict": None, "coverage_state": None, "error": NOT_ASKED}


def _failed(row: dict[str, Any]) -> bool:
    return row["http"] == 0 or row["http"] == 429 or row["http"] >= 500


def _retry_after_s(value: str | None) -> float | None:
    if not value:
        return None
    if value.strip().isdigit():
        return float(value)
    try:
        return max(0.0, (parsedate_to_datetime(value) - datetime.now(UTC)).total_seconds())
    except (TypeError, ValueError):
        return None


def inspect(urls: list[str]) -> dict[str, Any]:
    from virev_seo import gsc
    from virev_seo.config import GSC_SITE, INSPECT_DAILY_QUOTA

    day = gsc.quota_day()
    left = INSPECT_DAILY_QUOTA - gsc._quota_used(day)
    asked = urls[: max(0, left)]
    sess = gsc.session()
    stop = threading.Event()
    retry_after: list[float] = []

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
        row = {"url": url, "http": resp.status_code, "verdict": st.get("verdict"), "coverage_state": st.get("coverageState"),
               "error": (payload.get("error") or {}).get("message")}
        if _failed(row) and (wait := _retry_after_s(getattr(resp, "headers", {}).get("Retry-After"))) is not None:
            retry_after.append(wait)
        return row

    def one(url: str) -> dict[str, Any]:
        if stop.is_set():
            return _not_asked(url)
        row = attempt(url)
        if _failed(row):
            stop.set()
        return row

    def run(batch: list[str]) -> list[dict[str, Any]]:
        stop.clear()
        # Measured 10-12: one inspection takes about 7.4 s, and 32 parallel calls inspected 32 URLs in 8.5 s, all HTTP 200. That is
        # about 230 a minute, under Google's 600 a minute per property (virev_seo.config INSPECT_PER_MINUTE).
        with ThreadPoolExecutor(32) as pool:
            return list(pool.map(one, batch))

    # After a 429 any caller recorded, one URL goes first and the rest only when it answers, because a run that copies d2's state, such as
    # ~/work/second-google-user/windows.py, still sent 32 calls at 00:56:10Z on 10-26 that all got 429 (Vent prod otel.vent_calls).
    refused = gsc.QUOTA_FILE.with_name(REFUSED_FILE)
    if refused.exists() and len(asked) > 1:
        done = run(asked[:1])
        done += run(asked[1:]) if not _failed(done[0]) else [_not_asked(url) for url in asked[1:]]
    else:
        done = run(asked)
    # A 429 is the property's daily quota, which Google does not give back within the run, so a URL is never asked again after one.
    # measured: on 10-25 Google answered 429 "Quota exceeded for sc-domain:virev.ai" to 9 calls at 19:01Z and to all 32 asked again at 19:05Z
    if any(row["http"] == 429 for row in done):
        refused.write_text(json.dumps({"at": datetime.now(UTC).isoformat()}) + "\n")
    elif any(row["http"] == 200 for row in done):
        refused.unlink(missing_ok=True)
    again = [] if any(row["http"] == 429 for row in done) else [row["url"] for row in done if _failed(row)]
    if again:
        time.sleep(max(retry_after) if retry_after else REASK_WAIT_S)
        redone = {row["url"]: row for row in run(again)}
        done = [redone.get(row["url"], row) for row in done]
    return {"quota_day": day, "quota_left_before": left, "rows": done, "not_asked": urls[len(asked):]}


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
