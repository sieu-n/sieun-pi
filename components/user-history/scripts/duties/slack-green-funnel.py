"""The Visitors become paying users duty's PostHog reads, run by slack-green-funnel.ts. Read-only.

Usage: python3 slack-green-funnel.py <dir with slack-green's scripts/seo-agent> <days> [<weeks>]

slack-green-funnel.ts extracts slack-green's scripts/seo-agent and scripts/posthog from a git ref into a temp folder, so the 28-day numbers come
from conversion_targets.py's own window_report (the funnel dashboard's definitions) without a checkout. It adds one query: real people (the
dashboard's test, QA and likely-bot filters) who got an sg-exp-home flag, and real home page visitors, in the last 24 h. <weeks> adds
one 7-day row per week before today, like conversion_targets.py --weeks.
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

    flag = f"event = '$feature_flag_called' AND match(properties.$feature_flag, '{HOME_TEST}')"
    rows = hogql(
        f"""
SELECT uniqIf(person_id, {flag}) AS exposed,
       uniqIf(person_id, event = '$pageview' AND match(properties.$pathname, '^{LOCALE}/?$')) AS home_visitors,
       groupUniqArrayIf(properties.$feature_flag, {flag}) AS flags
FROM events
WHERE timestamp >= now() - INTERVAL 24 HOUR
  AND event IN ('$feature_flag_called', '$pageview')
  AND NOT ({LIKELY_BOT})
  AND {{filters}}
""",
        FILTERS,
    )
    exposed, home_visitors, flags = rows[0]
    return {"exposed": exposed, "home_visitors": home_visitors, "flags": sorted(flags)}


with ThreadPoolExecutor(max_workers=2 + weeks) as pool:
    window_job = pool.submit(run, lambda: window(days, 0))
    home_job = pool.submit(run, home_test)
    week_jobs = [pool.submit(run, lambda k=k: window(7 * k, 7 * (k - 1))) for k in range(1, weeks + 1)]
    (report, report_error), (home, home_error) = window_job.result(), home_job.result()
    week_rows = [job.result() for job in week_jobs]
print(json.dumps({
    "window": report, "window_error": report_error, "home": home, "home_error": home_error,
    "weeks": [row for row, _ in week_rows], "weeks_errors": [error for _, error in week_rows if error],
}))
