#!/usr/bin/env python3
"""Export a Drifty focus snapshot from an explicitly configured local database."""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import sqlite3
import sys
import urllib.error
import urllib.request
from collections import defaultdict
from contextlib import closing
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

SCHEMA_VERSION = 2
SOURCE = "drifty-local"
HISTORY_DAYS = 365
TRANSITION_MAX_GAP_SECONDS = 900
TRANSITION_LIMIT = 8
PRODUCTIVITIES = ("focus", "drift", "neutral")
CATEGORIES = {
    "workspace",
    "learning",
    "communication",
    "utility",
    "entertainment",
    "social_media",
    "game",
    "shopping",
    "music",
    "unknown",
    "other",
}
DEFAULT_DB_PATH = Path(os.environ["DRIFTY_DB"]).expanduser() if os.environ.get("DRIFTY_DB") else None


def parse_utc(value: str) -> dt.datetime:
    parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=dt.timezone.utc)
    return parsed.astimezone(dt.timezone.utc)


def iso_utc(value: dt.datetime) -> str:
    return value.astimezone(dt.timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def local_midnight_utc(day: dt.date, timezone: ZoneInfo) -> dt.datetime:
    return dt.datetime.combine(day, dt.time.min, tzinfo=timezone).astimezone(dt.timezone.utc)


def safe_category(category: str | None) -> str:
    return category if category in CATEGORIES else "other"


def is_classified(segment: dict[str, Any]) -> bool:
    return (
        segment.get("stale") == 0
        and segment.get("productivity") in PRODUCTIVITIES
        and bool(segment.get("category"))
    )


def connect_readonly(path: Path) -> sqlite3.Connection:
    conn = sqlite3.connect(f"{path.resolve().as_uri()}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    return conn


def read_segments(
    conn: sqlite3.Connection,
    start_local: dt.date,
    end_exclusive_local: dt.date,
    timezone: ZoneInfo,
) -> list[dict[str, Any]]:
    start_utc = local_midnight_utc(start_local, timezone)
    end_utc = local_midnight_utc(end_exclusive_local, timezone)
    rows = conn.execute(
        """
        select
          s.started_at,
          s.ended_at,
          s.duration_seconds,
          s.app_name,
          s.site_domain,
          c.category,
          c.productivity,
          c.stale
        from activity_segments s
        left join activity_classifications c on c.segment_id = s.id
        where datetime(s.started_at) >= datetime(?)
          and datetime(s.started_at) < datetime(?)
        order by datetime(s.started_at) asc
        """,
        (start_utc.isoformat(), end_utc.isoformat()),
    ).fetchall()

    segments: list[dict[str, Any]] = []
    for row in rows:
        started_at = parse_utc(row["started_at"])
        segments.append(
            {
                "startedAt": started_at,
                "endedAt": parse_utc(row["ended_at"]),
                "durationSeconds": int(row["duration_seconds"]),
                "appName": row["app_name"],
                "siteDomain": row["site_domain"],
                "category": row["category"],
                "productivity": row["productivity"],
                "stale": row["stale"],
                "localDate": started_at.astimezone(timezone).date(),
                "localHour": started_at.astimezone(timezone).hour,
            }
        )
    return segments


def date_range(start: dt.date, end_inclusive: dt.date) -> list[dt.date]:
    days = (end_inclusive - start).days
    return [start + dt.timedelta(days=offset) for offset in range(days + 1)]


def weekday_label(day: dt.date) -> str:
    return day.strftime("%a")


def period_label(start: dt.date, end: dt.date) -> str:
    if start == end:
        return start.strftime("%b %-d")
    return f"{start.strftime('%b %-d')}-{end.strftime('%b %-d')}"


def summarize_period(
    segments: list[dict[str, Any]],
    period: str,
    label: str,
    start: dt.date,
    end: dt.date,
) -> dict[str, Any]:
    in_range = [s for s in segments if start <= s["localDate"] <= end]
    tracked = sum(s["durationSeconds"] for s in in_range)
    by_productivity = {name: 0 for name in PRODUCTIVITIES}
    categories: dict[tuple[str, str], dict[str, int]] = defaultdict(lambda: {"seconds": 0, "sessions": 0})
    classified = 0

    for segment in in_range:
        if not is_classified(segment):
            continue
        productivity = segment["productivity"]
        seconds = segment["durationSeconds"]
        category = safe_category(segment["category"])
        by_productivity[productivity] += seconds
        categories[(category, productivity)]["seconds"] += seconds
        categories[(category, productivity)]["sessions"] += 1
        classified += seconds

    summary = {
        "period": period,
        "label": label,
        "startLocalDate": start.isoformat(),
        "endLocalDate": end.isoformat(),
        "trackedSeconds": tracked,
        "classifiedSeconds": classified,
        "unclassifiedSeconds": tracked - classified,
        "focusSeconds": by_productivity["focus"],
        "driftSeconds": by_productivity["drift"],
        "neutralSeconds": by_productivity["neutral"],
        "sessions": len(in_range),
        "activeDays": len({s["localDate"] for s in in_range if s["durationSeconds"] > 0}),
        "focusShare": round(by_productivity["focus"] / classified, 4) if classified else 0,
        "categoryRollup": [
            {
                "category": category,
                "productivity": productivity,
                "seconds": values["seconds"],
                "sessions": values["sessions"],
            }
            for (category, productivity), values in sorted(
                categories.items(), key=lambda item: (-item[1]["seconds"], item[0][0], item[0][1])
            )
        ],
    }
    assert_summary_invariants(summary)
    return summary


def assert_summary_invariants(summary: dict[str, Any]) -> None:
    focus = summary["focusSeconds"]
    drift = summary["driftSeconds"]
    neutral = summary["neutralSeconds"]
    classified = summary["classifiedSeconds"]
    tracked = summary["trackedSeconds"]
    category_total = sum(row["seconds"] for row in summary["categoryRollup"])
    by_productivity = defaultdict(int)
    for row in summary["categoryRollup"]:
        by_productivity[row["productivity"]] += row["seconds"]

    checks = [
        (focus + drift + neutral == classified, "productivity totals must equal classifiedSeconds"),
        (classified + summary["unclassifiedSeconds"] == tracked, "classified + unclassified must equal tracked"),
        (category_total == classified, "category rollup must equal classifiedSeconds"),
        (by_productivity["focus"] == focus, "focus category sum must equal focusSeconds"),
        (by_productivity["drift"] == drift, "drift category sum must equal driftSeconds"),
        (by_productivity["neutral"] == neutral, "neutral category sum must equal neutralSeconds"),
    ]
    for ok, message in checks:
        if not ok:
            raise ValueError(f"Snapshot invariant failed: {message}")


def build_daily(segments: list[dict[str, Any]], start: dt.date, end: dt.date) -> list[dict[str, Any]]:
    daily = []
    for day in date_range(start, end):
        summary = summarize_period(segments, "day", day.strftime("%a, %b %-d"), day, day)
        summary["date"] = day.isoformat()
        summary["weekday"] = weekday_label(day)
        daily.append(summary)
    return daily


def build_attention_rhythm(
    segments: list[dict[str, Any]], start: dt.date, end: dt.date
) -> list[dict[str, Any]]:
    cells: dict[tuple[dt.date, int], dict[str, int]] = defaultdict(
        lambda: {"focusSeconds": 0, "driftSeconds": 0, "neutralSeconds": 0, "unclassifiedSeconds": 0}
    )
    for segment in segments:
        if not (start <= segment["localDate"] <= end):
            continue
        cell = cells[(segment["localDate"], segment["localHour"])]
        seconds = segment["durationSeconds"]
        if is_classified(segment):
            cell[f"{segment['productivity']}Seconds"] += seconds
        else:
            cell["unclassifiedSeconds"] += seconds

    rhythm = []
    for day in date_range(start, end):
        for hour in range(24):
            cell = cells[(day, hour)]
            tracked = sum(cell.values())
            rhythm.append(
                {
                    "date": day.isoformat(),
                    "weekday": weekday_label(day),
                    "hour": hour,
                    **cell,
                    "trackedSeconds": tracked,
                }
            )
    return rhythm


def local_day_minute(value: dt.datetime, day: dt.date, timezone: ZoneInfo, *, ceil: bool = False) -> int:
    local = value.astimezone(timezone)
    if local.date() < day:
        return 0
    if local.date() > day:
        return 1440
    minute = local.hour * 60 + local.minute
    if ceil and (local.second > 0 or local.microsecond > 0):
        minute += 1
    return max(0, min(1440, minute))


def build_today_segments(
    segments: list[dict[str, Any]],
    local_today: dt.date,
    timezone: ZoneInfo,
) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for segment in segments:
        if segment["localDate"] != local_today:
            continue
        duration = max(0, int(segment["durationSeconds"]))
        if duration <= 0:
            continue

        start_minute = local_day_minute(segment["startedAt"], local_today, timezone)
        end_minute = local_day_minute(segment["endedAt"], local_today, timezone, ceil=True)
        if end_minute <= start_minute:
            end_minute = min(1440, start_minute + max(1, round(duration / 60)))

        if is_classified(segment):
            category = safe_category(segment["category"])
            productivity = segment["productivity"]
        else:
            category = "unknown"
            productivity = "unclassified"

        row: dict[str, Any] = {
            "date": local_today.isoformat(),
            "startMinute": start_minute,
            "endMinute": end_minute,
            "durationSeconds": duration,
            "appLabel": segment["appName"],
            "category": category,
            "productivity": productivity,
        }
        if segment["siteDomain"]:
            row["siteDomain"] = segment["siteDomain"]
        rows.append(row)
    return rows


def build_history(
    segments: list[dict[str, Any]], start: dt.date, end: dt.date
) -> list[dict[str, Any]]:
    """One row per local day over [start, end] in a single aggregation pass.

    Leading days with zero tracked time are trimmed so the series starts at the
    first day Drifty actually recorded (the year axis stays honest for a
    tracker younger than a year).
    """
    buckets: dict[dt.date, dict[str, int]] = defaultdict(
        lambda: {
            "trackedSeconds": 0,
            "focusSeconds": 0,
            "driftSeconds": 0,
            "neutralSeconds": 0,
            "unclassifiedSeconds": 0,
            "sessions": 0,
        }
    )
    for segment in segments:
        day = segment["localDate"]
        if not (start <= day <= end):
            continue
        bucket = buckets[day]
        seconds = segment["durationSeconds"]
        bucket["trackedSeconds"] += seconds
        bucket["sessions"] += 1
        if is_classified(segment):
            bucket[f"{segment['productivity']}Seconds"] += seconds
        else:
            bucket["unclassifiedSeconds"] += seconds

    rows: list[dict[str, Any]] = []
    for day in date_range(start, end):
        bucket = buckets[day]
        if not rows and bucket["trackedSeconds"] == 0:
            continue
        classified = bucket["focusSeconds"] + bucket["driftSeconds"] + bucket["neutralSeconds"]
        if classified + bucket["unclassifiedSeconds"] != bucket["trackedSeconds"]:
            raise ValueError(f"History invariant failed for {day.isoformat()}")
        rows.append(
            {
                "date": day.isoformat(),
                "weekday": weekday_label(day),
                **bucket,
                "classifiedSeconds": classified,
            }
        )
    return rows


def segment_label(segment: dict[str, Any]) -> tuple[str, str]:
    if segment["siteDomain"]:
        return ("site", segment["siteDomain"])
    return ("app", segment["appName"])


def build_transitions(
    segments: list[dict[str, Any]], start: dt.date, end: dt.date
) -> dict[str, list[dict[str, Any]]]:
    """Count focus→drift hand-offs between back-to-back classified segments.

    `driftAfterFocus` ranks where attention goes when focus breaks;
    `focusBeforeDrift` ranks what was being focused on right before. Pairs
    separated by more than TRANSITION_MAX_GAP_SECONDS (walked away from the
    machine) are not treated as a hand-off.
    """
    drift_after_focus: dict[tuple[str, str], int] = defaultdict(int)
    focus_before_drift: dict[tuple[str, str], int] = defaultdict(int)
    in_range = [s for s in segments if start <= s["localDate"] <= end and is_classified(s)]
    for prev, cur in zip(in_range, in_range[1:]):
        gap = (cur["startedAt"] - prev["endedAt"]).total_seconds()
        if gap > TRANSITION_MAX_GAP_SECONDS:
            continue
        if prev["productivity"] == "focus" and cur["productivity"] == "drift":
            drift_after_focus[segment_label(cur)] += 1
            focus_before_drift[segment_label(prev)] += 1

    def ranked(counts: dict[tuple[str, str], int]) -> list[dict[str, Any]]:
        ordered = sorted(counts.items(), key=lambda item: (-item[1], item[0][1]))
        return [
            {"kind": kind, "label": label, "count": count}
            for (kind, label), count in ordered[:TRANSITION_LIMIT]
        ]

    return {
        "driftAfterFocus": ranked(drift_after_focus),
        "focusBeforeDrift": ranked(focus_before_drift),
    }


def build_app_site_rollup(segments: list[dict[str, Any]], limit: int) -> list[dict[str, Any]]:
    rows: dict[tuple[str, str], dict[str, Any]] = {}

    def add(kind: str, label: str, segment: dict[str, Any]) -> None:
        key = (kind, label)
        row = rows.setdefault(
            key,
            {
                "kind": kind,
                "label": label,
                "displayLabel": label,
                "focusSeconds": 0,
                "driftSeconds": 0,
                "neutralSeconds": 0,
                "unclassifiedSeconds": 0,
                "classifiedSeconds": 0,
                "trackedSeconds": 0,
                "sessions": 0,
                "averageSessionSeconds": 0,
                "lastUsedAt": iso_utc(segment["startedAt"]),
            },
        )
        seconds = segment["durationSeconds"]
        row["trackedSeconds"] += seconds
        row["sessions"] += 1
        row["lastUsedAt"] = max(row["lastUsedAt"], iso_utc(segment["startedAt"]))
        if is_classified(segment):
            row[f"{segment['productivity']}Seconds"] += seconds
            row["classifiedSeconds"] += seconds
        else:
            row["unclassifiedSeconds"] += seconds

    for segment in segments:
        add("app", segment["appName"], segment)
        if segment["siteDomain"]:
            add("site", segment["siteDomain"], segment)

    for row in rows.values():
        row["averageSessionSeconds"] = round(row["trackedSeconds"] / row["sessions"]) if row["sessions"] else 0

    return sorted(rows.values(), key=lambda row: (-row["trackedSeconds"], row["kind"], row["label"]))[:limit]


def build_snapshot(
    db_path: Path,
    slug: str,
    timezone_name: str,
    today: dt.date | None = None,
    app_site_limit: int = 40,
) -> dict[str, Any]:
    timezone = ZoneInfo(timezone_name)
    local_today = today or dt.datetime.now(timezone).date()
    week_start = local_today - dt.timedelta(days=6)
    history_start = local_today - dt.timedelta(days=HISTORY_DAYS - 1)
    end_exclusive = local_today + dt.timedelta(days=1)

    with closing(connect_readonly(db_path)) as conn:
        segments = read_segments(conn, history_start, end_exclusive, timezone)
    week_segments = [s for s in segments if week_start <= s["localDate"] <= local_today]

    week = summarize_period(week_segments, "week", period_label(week_start, local_today), week_start, local_today)
    today_summary = summarize_period(week_segments, "today", "Today", local_today, local_today)
    daily = build_daily(week_segments, week_start, local_today)

    return {
        "schemaVersion": SCHEMA_VERSION,
        "slug": slug,
        "timezone": timezone_name,
        "source": SOURCE,
        "generatedAt": iso_utc(dt.datetime.now(dt.timezone.utc)),
        "today": today_summary,
        "week": week,
        "daily": daily,
        "attentionRhythm": build_attention_rhythm(week_segments, week_start, local_today),
        "todaySegments": build_today_segments(week_segments, local_today, timezone),
        "appSiteRollup": build_app_site_rollup(week_segments, app_site_limit),
        "history": build_history(segments, history_start, local_today),
        "transitions": build_transitions(week_segments, week_start, local_today),
    }


def convex_site_url(explicit: str | None = None) -> str:
    if explicit:
        return explicit.rstrip("/")
    site = os.environ.get("PUBLIC_CONVEX_SITE_URL") or os.environ.get("CONVEX_SITE_URL")
    if site:
        return site.rstrip("/")
    cloud = os.environ.get("VITE_CONVEX_URL")
    if cloud and cloud.endswith(".convex.cloud"):
        return cloud[:-len(".convex.cloud")] + ".convex.site"
    raise RuntimeError("PUBLIC_CONVEX_SITE_URL or VITE_CONVEX_URL must be set for upload")


def snapshot_upload_payload(snapshot: dict[str, Any], secret: str) -> dict[str, Any]:
    return {
        "secret": secret,
        "slug": snapshot["slug"],
        "schemaVersion": snapshot["schemaVersion"],
        "timezone": snapshot["timezone"],
        "source": snapshot["source"],
        "generatedAt": snapshot["generatedAt"],
        "snapshot": snapshot,
    }


def upload_snapshot(snapshot: dict[str, Any], site_url: str, secret: str) -> dict[str, Any]:
    payload = snapshot_upload_payload(snapshot, secret)
    request = urllib.request.Request(
        f"{site_url}/api/personal-focus/upsert",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"Convex upload failed with HTTP {exc.code}: {body}") from exc


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", type=Path, default=DEFAULT_DB_PATH, required=DEFAULT_DB_PATH is None)
    parser.add_argument("--slug", default=os.environ.get("DRIFTY_SLUG"), required=not os.environ.get("DRIFTY_SLUG"))
    parser.add_argument("--timezone", default=os.environ.get("DAILY_RECAP_TZ") or "UTC")
    parser.add_argument("--today", type=dt.date.fromisoformat, help="Override local today as YYYY-MM-DD")
    parser.add_argument("--app-site-limit", type=int, default=40)
    parser.add_argument("--upload", action="store_true")
    parser.add_argument("--convex-site-url")
    parser.add_argument("--secret", default=os.environ.get("CONVEX_WEBHOOK_SECRET"))
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv if argv is not None else sys.argv[1:])
    snapshot = build_snapshot(args.db, args.slug, args.timezone, args.today, args.app_site_limit)
    if args.upload:
        if not args.secret:
            raise RuntimeError("CONVEX_WEBHOOK_SECRET must be set for upload")
        result = upload_snapshot(snapshot, convex_site_url(args.convex_site_url), args.secret)
        print(json.dumps(result, indent=2, sort_keys=True))
    else:
        print(json.dumps(snapshot, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
