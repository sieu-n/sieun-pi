"""The Visitors become paying users duty's PostHog reads, run by slack-green-funnel.ts. Read-only.

Usage: python3 slack-green-funnel.py <dir with slack-green's scripts/seo-agent> <days> [<weeks>]

slack-green-funnel.ts extracts slack-green's scripts/seo-agent and scripts/posthog from a git ref into a temp folder, so the 28-day numbers come
from conversion_targets.py's own window_report (the funnel dashboard's definitions) without a checkout. It adds one query: real people (the
dashboard's test, QA and likely-bot filters) who opened the home page of any locale signed out (no ?noredirect=true, the signed-in path, and
not after $identify in the same session) in the last 24 h and in the last 7 days, how many of them got an sg-exp-home exposure, and all real home visitors and flag callers in 24 h. It adds a second: the
cohort of real visitors whose first real public page was 56 to 28 days ago, and how many of them signed up and then started Pro or bought
the CLI within 28 days of that visit (the duty's headline). A fourth reads real signups from 44 to 16 days ago and how many of them started Pro
or bought the CLI within 16 days of signing up, a trial and its charge. <weeks> adds one 7-day row per week before today, like
conversion_targets.py --weeks, whose Pro or CLI column counts only payments inside that same week, and one signup row per week that ended 16
days ago or earlier, followed 16 days.
Prints one JSON object; a query that fails gives its error text instead of numbers.
"""

import json
import sys
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta
from pathlib import Path

seo_agent = Path(sys.argv[1]).resolve()
days = int(sys.argv[2]) if len(sys.argv) > 2 else 28
weeks = int(sys.argv[3]) if len(sys.argv) > 3 else 0
sys.path.insert(0, str(seo_agent))

HOME_TEST = "^sg-exp-home"
FOLLOW_DAYS = 28
# A trial lasts 14 days (223 of 230 trials that started 08-01 to 10-20). Of the 19 accounts made in that time that paid by 10-20, 12 paid
# within 16 days of signing up, 8 of them at the trial's end 14.2 to 15.9 days in, so 16 days holds a trial and the charge at its end.
PAY_DAYS = 16


def run(fn):
    try:
        return fn(), None
    except SystemExit as error:  # posthog_blog.hogql exits with a JSON error on an API error
        return None, str(error.code)
    except Exception as error:  # noqa: BLE001
        return None, f"{type(error).__name__}: {error}"


def window(start_days_ago: int, end_days_ago: int):
    from conversion_targets import PROJECT_TZ, window_report

    today = datetime.now(PROJECT_TZ).date()
    return window_report(today - timedelta(days=start_days_ago), today - timedelta(days=end_days_ago))


def home_test():
    from conversion_targets import FILTERS
    from posthog_blog import hogql
    from setup_acquisition_dashboard import LIKELY_BOT, LOCALE

    day = "timestamp >= now() - INTERVAL 24 HOUR"
    flag = f"event = '$feature_flag_called' AND match(properties.$feature_flag, '{HOME_TEST}')"
    # slack-green PR #256 (207d4d5, 10-15) runs the home test on the home page of all 11 locales, so a signed-out visit to any of them counts.
    home = f"event = '$pageview' AND match(properties.$pathname, '^{LOCALE}/?$')"
    eligible = f"{home} AND NOT match(coalesce(properties.$current_url, ''), 'noredirect=true')"
    # A home view after $identify in the same visit (session) is a signed-in view: a blog reader who signs up with One Tap and then clicks
    # through to /en arrives by client navigation, which the proxy's signed-in redirect never sees. On 10-19 one such person was 1 of the
    # 3 misses that put home_test_reach_pct at 25 of 28; posthog-js sends experiment_arm_mismatch there, because identify moves the flag.
    signed_out = "(identified = 0 OR first_home < signed_in_at)"
    signed_out_24h = "(identified = 0 OR first_home_24h < signed_in_at)"
    rows = hogql(
        f"""
SELECT countIf(home_24h) AS eligible, countIf(home_24h AND got) AS eligible_exposed, countIf(got_24h) AS exposed,
       countIf(home) AS eligible_7d, countIf(home AND got) AS eligible_exposed_7d, countIf(any_home_24h) AS home_visitors,
       arrayDistinct(arrayFlatten(groupArray(flags))) AS flags, countIf(signed_in_home_24h AND NOT home_24h) AS signed_in_24h
FROM (
    SELECT person_id,
           max(homes > 0 AND {signed_out}) AS home,
           max(homes_24h > 0 AND {signed_out_24h}) AS home_24h,
           max(homes_24h > 0 AND NOT {signed_out_24h}) AS signed_in_home_24h,
           max(any_homes_24h > 0) AS any_home_24h,
           max(flags_called > 0) AS got,
           max(flags_called_24h > 0) AS got_24h,
           arrayDistinct(arrayFlatten(groupArray(session_flags))) AS flags
    FROM (
        SELECT person_id, properties.$session_id AS session,
               countIf({eligible}) AS homes,
               countIf({eligible} AND {day}) AS homes_24h,
               minIf(timestamp, {eligible}) AS first_home,
               minIf(timestamp, {eligible} AND {day}) AS first_home_24h,
               countIf(event = '$identify') AS identified,
               minIf(timestamp, event = '$identify') AS signed_in_at,
               countIf({home} AND {day}) AS any_homes_24h,
               countIf({flag}) AS flags_called,
               countIf({flag} AND {day}) AS flags_called_24h,
               groupUniqArrayIf(properties.$feature_flag, {flag} AND {day}) AS session_flags
        FROM events
        WHERE timestamp >= now() - INTERVAL 7 DAY
          AND event IN ('$feature_flag_called', '$pageview', '$identify')
          AND NOT ({LIKELY_BOT})
          AND {{filters}}
        GROUP BY person_id, session
    )
    GROUP BY person_id
)
""",
        FILTERS,
    )
    eligible, eligible_exposed, exposed, eligible_7d, eligible_exposed_7d, home_visitors, flags, signed_in_24h = rows[0]
    return {"eligible": eligible, "eligible_exposed": eligible_exposed, "exposed": exposed, "eligible_7d": eligible_7d,
            "eligible_exposed_7d": eligible_exposed_7d, "home_visitors": home_visitors, "flags": sorted(flags), "signed_in_24h": signed_in_24h}


def cohort():
    from conversion_targets import APP_PATHS, ENTRY_CLASS, FILTERS, LIKELY_BOT, ON_TOPIC_CLASSES, PROJECT_TZ, PURCHASES
    from posthog_blog import hogql

    today = datetime.now(PROJECT_TZ).date()
    end = today - timedelta(days=FOLLOW_DAYS)
    start = end - timedelta(days=days)
    # windowFunnel needs the signup after a public pageview. A visitor who opens /auth/login straight away, or signs up on another device,
    # has user_signed_up before the first public pageview PostHog saw, so the funnel stopped at level 1: in the cohort run of 10-20,
    # 00fb6658 signed up 09-02 15:11, opened /en at 15:19 and paid 09-28, and the headline read 8 of 1583 instead of 9.
    # Such a signup counts when it falls before entry + 28 days, and its purchase when it follows the signup inside the same 28 days.
    late = f"signups > 0 AND signup_at <= entry_at + INTERVAL {FOLLOW_DAYS} DAY"
    rows = hogql(
        f"""
SELECT {ENTRY_CLASS} AS entry_class, count() AS visitors,
       countIf(level >= 2 OR ({late})) AS signed_up,
       countIf(level >= 3 OR ({late} AND arrayExists(t -> t > signup_at AND t <= entry_at + INTERVAL {FOLLOW_DAYS} DAY, purchases))) AS paid
FROM (
    SELECT person_id,
           argMinIf(properties.$pathname, timestamp, is_entry) AS entry_path,
           minIf(timestamp, is_entry) AS entry_at,
           countIf(event = 'user_signed_up') AS signups,
           minIf(timestamp, event = 'user_signed_up') AS signup_at,
           groupArrayIf(timestamp, event IN ({PURCHASES})) AS purchases,
           windowFunnel({FOLLOW_DAYS * 86400})(toDateTime(timestamp), is_entry,
               event = 'user_signed_up', event IN ({PURCHASES})) AS level
    FROM (
        SELECT person_id, timestamp, event, properties,
               event = '$pageview' AND timestamp < toDateTime('{end} 00:00:00')
                   AND NOT match(properties.$pathname, '{APP_PATHS}') AND NOT ({LIKELY_BOT}) AS is_entry
        FROM events
        WHERE timestamp >= toDateTime('{start} 00:00:00')
          AND timestamp < toDateTime('{today} 00:00:00')
          AND event IN ('$pageview', 'user_signed_up', {PURCHASES})
          AND {{filters}}
    )
    GROUP BY person_id
    HAVING level >= 1
)
GROUP BY entry_class
""",
        FILTERS,
    )
    classes = {name: {"visitors": visitors, "signed_up": signed_up, "paid": paid} for name, visitors, signed_up, paid in rows}
    on_topic = {key: sum(classes.get(name, {}).get(key, 0) for name in ON_TOPIC_CLASSES) for key in ("visitors", "signed_up", "paid")}
    return {"start": str(start), "end": str(end), "follow_end": str(today), "follow_days": FOLLOW_DAYS,
            "on_topic_visitors": on_topic["visitors"], "on_topic_signed_up": on_topic["signed_up"], "on_topic_paid": on_topic["paid"],
            "entry_classes": classes}


def signups(start_days_ago: int, end_days_ago: int):
    """Real signups from start_days_ago to end_days_ago, and the ones who started Pro or bought the CLI within PAY_DAYS of signing up."""
    from conversion_targets import FILTERS, PROJECT_TZ, PURCHASES
    from posthog_blog import hogql

    today = datetime.now(PROJECT_TZ).date()
    start, end = today - timedelta(days=start_days_ago), today - timedelta(days=end_days_ago)
    rows = hogql(
        f"""
SELECT count() AS signed_up, countIf(arrayExists(t -> t > signup_at AND t <= signup_at + INTERVAL {PAY_DAYS} DAY, purchases)) AS paid
FROM (
    SELECT person_id, minIf(timestamp, event = 'user_signed_up') AS signup_at, groupArrayIf(timestamp, event IN ({PURCHASES})) AS purchases
    FROM events
    WHERE timestamp >= toDateTime('{start} 00:00:00')
      AND timestamp < toDateTime('{today} 00:00:00')
      AND event IN ('user_signed_up', {PURCHASES})
      AND {{filters}}
    GROUP BY person_id
    HAVING countIf(event = 'user_signed_up') > 0 AND signup_at < toDateTime('{end} 00:00:00')
)
""",
        FILTERS,
    )
    signed_up, paid = rows[0] if rows else (0, 0)
    return {"start": str(start), "end": str(end), "follow_days": PAY_DAYS, "signed_up": signed_up, "paid": paid}


with ThreadPoolExecutor(max_workers=4 + 2 * weeks) as pool:
    window_job = pool.submit(run, lambda: window(days, 0))
    home_job = pool.submit(run, home_test)
    cohort_job = pool.submit(run, cohort)
    signups_job = pool.submit(run, lambda: signups(days + PAY_DAYS, PAY_DAYS))
    week_jobs = [pool.submit(run, lambda k=k: window(7 * k, 7 * (k - 1))) for k in range(1, weeks + 1)]
    signup_week_jobs = [pool.submit(run, lambda k=k: signups(7 * k + PAY_DAYS, 7 * (k - 1) + PAY_DAYS)) for k in range(1, weeks + 1)]
    (report, report_error), (home, home_error), (paid, paid_error) = window_job.result(), home_job.result(), cohort_job.result()
    signup_paid, signup_paid_error = signups_job.result()
    week_rows = [job.result() for job in week_jobs]
    signup_week_rows = [job.result() for job in signup_week_jobs]
print(json.dumps({
    "window": report, "window_error": report_error, "home": home, "home_error": home_error, "cohort": paid, "cohort_error": paid_error,
    "signups": signup_paid, "signups_error": signup_paid_error,
    "weeks": [row for row, _ in week_rows], "weeks_errors": [error for _, error in week_rows + signup_week_rows if error],
    "signup_weeks": [row for row, _ in signup_week_rows],
}))
