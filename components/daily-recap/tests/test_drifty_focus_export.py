#!/usr/bin/env python3
"""Fixture tests for the shared Drifty exporter."""

from __future__ import annotations

import datetime as dt
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path

import drifty_focus_export as exporter


def create_fixture_db() -> tuple[tempfile.TemporaryDirectory[str], Path]:
    temp = tempfile.TemporaryDirectory()
    path = Path(temp.name) / "tracker.sqlite3"
    conn = sqlite3.connect(path)
    conn.executescript(
        """
        create table activity_segments (
          id integer primary key,
          started_at text not null,
          ended_at text not null,
          duration_seconds integer not null,
          app_name text not null,
          bundle_id text,
          window_title text,
          site_domain text,
          site_title text,
          site_url text,
          youtube_video_id text,
          youtube_playlist_id text,
          youtube_is_shorts integer,
          browser_name text,
          site_source text,
          platform text not null,
          source text not null,
          confidence real,
          raw_context_json text
        );
        create table activity_classifications (
          segment_id integer primary key,
          input_fingerprint text not null,
          category text not null,
          productivity text not null,
          source text not null,
          confidence real not null,
          reason text,
          model text,
          prompt_version text,
          taxonomy_version text,
          request_id text,
          latency_ms integer,
          classified_at text not null,
          refreshed_at text,
          ai_result integer not null default 0,
          stale integer not null default 0,
          classification_rule_id text
        );
        """
    )
    conn.close()
    return temp, path


def insert_segment(
    conn: sqlite3.Connection,
    segment_id: int,
    started_at: str,
    duration_seconds: int,
    app_name: str,
    site_domain: str | None = None,
    window_title: str | None = None,
    site_title: str | None = None,
    site_url: str | None = None,
    raw_context_json: str | None = None,
) -> None:
    started = exporter.parse_utc(started_at)
    ended = started + dt.timedelta(seconds=duration_seconds)
    conn.execute(
        """
        insert into activity_segments (
          id, started_at, ended_at, duration_seconds, app_name, site_domain,
          window_title, site_title, site_url, raw_context_json, platform, source
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'macos', 'fixture')
        """,
        (
            segment_id,
            started_at,
            ended.isoformat(),
            duration_seconds,
            app_name,
            site_domain,
            window_title,
            site_title,
            site_url,
            raw_context_json,
        ),
    )


def insert_classification(
    conn: sqlite3.Connection,
    segment_id: int,
    category: str,
    productivity: str,
    stale: int = 0,
) -> None:
    conn.execute(
        """
        insert into activity_classifications (
          segment_id, input_fingerprint, category, productivity, source, confidence, classified_at, ai_result, stale
        ) values (?, 'fixture', ?, ?, 'fixture', 1.0, '2026-06-24T00:00:00+00:00', 0, ?)
        """,
        (segment_id, category, productivity, stale),
    )


class DriftyFocusExportTest(unittest.TestCase):
    def test_snapshot_invariants_category_remap_and_unclassified_app_site_lane(self) -> None:
        temp, path = create_fixture_db()
        self.addCleanup(temp.cleanup)
        conn = sqlite3.connect(path)
        insert_segment(conn, 1, "2026-06-23T15:05:00+00:00", 60, "Cursor")
        insert_classification(conn, 1, "workspace", "focus")
        insert_segment(
            conn,
            2,
            "2026-06-24T01:00:00+00:00",
            30,
            "Google Chrome",
            "youtube.com",
            window_title="SECRET_WINDOW_TITLE_SHOULD_NOT_UPLOAD",
            site_title="SECRET_SITE_TITLE_SHOULD_NOT_UPLOAD",
            site_url="https://private-url.invalid/deep/path?token=SECRET_URL_TOKEN",
            raw_context_json='{"sensitive":"SECRET_RAW_CONTEXT_SHOULD_NOT_UPLOAD"}',
        )
        insert_classification(conn, 2, "entertainment", "drift")
        insert_segment(conn, 3, "2026-06-24T02:00:00+00:00", 20, "Google Chrome", "example.com")
        insert_segment(conn, 4, "2026-06-24T03:00:00+00:00", 10, "Helium")
        insert_classification(conn, 4, "social_media", "drift", stale=1)
        insert_segment(conn, 5, "2026-06-24T04:00:00+00:00", 40, "Claude")
        insert_classification(conn, 5, "ai_weird", "focus")
        conn.commit()
        conn.close()

        snapshot = exporter.build_snapshot(path, "fixture-user", "Asia/Seoul", today=dt.date(2026, 6, 24))
        week = snapshot["week"]

        self.assertEqual(week["trackedSeconds"], 160)
        self.assertEqual(week["classifiedSeconds"], 130)
        self.assertEqual(week["unclassifiedSeconds"], 30)
        self.assertEqual(week["focusSeconds"], 100)
        self.assertEqual(week["driftSeconds"], 30)
        categories = {(row["category"], row["productivity"]): row["seconds"] for row in week["categoryRollup"]}
        self.assertEqual(categories[("workspace", "focus")], 60)
        self.assertEqual(categories[("entertainment", "drift")], 30)
        self.assertEqual(categories[("other", "focus")], 40)
        today_segments = snapshot["todaySegments"]
        self.assertEqual(sum(row["durationSeconds"] for row in today_segments), snapshot["today"]["trackedSeconds"])
        self.assertEqual(
            [
                (row["appLabel"], row.get("siteDomain"), row["startMinute"], row["endMinute"], row["category"], row["productivity"])
                for row in today_segments
            ],
            [
                ("Cursor", None, 5, 6, "workspace", "focus"),
                ("Google Chrome", "youtube.com", 600, 601, "entertainment", "drift"),
                ("Google Chrome", "example.com", 660, 661, "unknown", "unclassified"),
                ("Helium", None, 720, 721, "unknown", "unclassified"),
                ("Claude", None, 780, 781, "other", "focus"),
            ],
        )

        chrome = next(row for row in snapshot["appSiteRollup"] if row["kind"] == "app" and row["label"] == "Google Chrome")
        self.assertEqual(chrome["trackedSeconds"], 50)
        self.assertEqual(chrome["driftSeconds"], 30)
        self.assertEqual(chrome["unclassifiedSeconds"], 20)
        upload_json = json.dumps(exporter.snapshot_upload_payload(snapshot, "dummy-secret"), sort_keys=True)
        for forbidden_key in (
            "id",
            "segment_id",
            "segmentId",
            "window_title",
            "windowTitle",
            "site_title",
            "siteTitle",
            "site_url",
            "siteUrl",
            "raw_context_json",
            "rawContextJson",
            "started_at",
            "ended_at",
            "startedAt",
            "endedAt",
            "input_fingerprint",
            "inputFingerprint",
            "request_id",
            "requestId",
            "reason",
        ):
            self.assertNotIn(f'"{forbidden_key}"', upload_json)
        for forbidden_value in (
            "SECRET_WINDOW_TITLE_SHOULD_NOT_UPLOAD",
            "SECRET_SITE_TITLE_SHOULD_NOT_UPLOAD",
            "https://private-url.invalid/deep/path?token=SECRET_URL_TOKEN",
            "SECRET_RAW_CONTEXT_SHOULD_NOT_UPLOAD",
        ):
            self.assertNotIn(forbidden_value, upload_json)

    def test_history_single_pass_matches_daily_and_trims_leading_empty_days(self) -> None:
        temp, path = create_fixture_db()
        self.addCleanup(temp.cleanup)
        conn = sqlite3.connect(path)
        # 40 days back, inside the 365d history window, outside the 7d week.
        insert_segment(conn, 1, "2026-05-15T03:00:00+00:00", 300, "Cursor")
        insert_classification(conn, 1, "workspace", "focus")
        insert_segment(conn, 2, "2026-06-24T03:00:00+00:00", 120, "Google Chrome", "youtube.com")
        insert_classification(conn, 2, "entertainment", "drift")
        insert_segment(conn, 3, "2026-06-24T04:00:00+00:00", 60, "Helium")
        conn.commit()
        conn.close()

        snapshot = exporter.build_snapshot(path, "fixture-user", "Asia/Seoul", today=dt.date(2026, 6, 24))
        history = snapshot["history"]

        self.assertEqual(snapshot["schemaVersion"], 2)
        # Leading empty days trimmed: series starts on the first tracked day.
        self.assertEqual(history[0]["date"], "2026-05-15")
        self.assertEqual(history[-1]["date"], "2026-06-24")
        by_date = {row["date"]: row for row in history}
        self.assertEqual(by_date["2026-05-15"]["focusSeconds"], 300)
        self.assertEqual(by_date["2026-06-24"]["driftSeconds"], 120)
        self.assertEqual(by_date["2026-06-24"]["unclassifiedSeconds"], 60)
        self.assertEqual(by_date["2026-06-24"]["trackedSeconds"], 180)
        self.assertEqual(by_date["2026-06-24"]["sessions"], 2)
        # Interior zero days are present (continuous axis for the chart).
        self.assertEqual(by_date["2026-06-01"]["trackedSeconds"], 0)
        for row in history:
            self.assertEqual(
                row["focusSeconds"] + row["driftSeconds"] + row["neutralSeconds"],
                row["classifiedSeconds"],
            )
            self.assertEqual(row["classifiedSeconds"] + row["unclassifiedSeconds"], row["trackedSeconds"])
        # History days outside the week must not leak into week aggregates.
        self.assertEqual(snapshot["week"]["trackedSeconds"], 180)

    def test_transitions_count_focus_to_drift_handoffs(self) -> None:
        temp, path = create_fixture_db()
        self.addCleanup(temp.cleanup)
        conn = sqlite3.connect(path)
        # focus → drift back-to-back: counts once for each side.
        insert_segment(conn, 1, "2026-06-24T03:00:00+00:00", 60, "Cursor")
        insert_classification(conn, 1, "workspace", "focus")
        insert_segment(conn, 2, "2026-06-24T03:01:00+00:00", 30, "Google Chrome", "instagram.com")
        insert_classification(conn, 2, "social_media", "drift")
        # focus → (unclassified skipped) → drift still pairs the classified neighbours.
        insert_segment(conn, 3, "2026-06-24T04:00:00+00:00", 60, "Claude")
        insert_classification(conn, 3, "workspace", "focus")
        insert_segment(conn, 4, "2026-06-24T04:01:00+00:00", 20, "Finder")
        insert_segment(conn, 5, "2026-06-24T04:02:00+00:00", 30, "Google Chrome", "instagram.com")
        insert_classification(conn, 5, "social_media", "drift")
        # focus → drift across a >15min gap: NOT a hand-off.
        insert_segment(conn, 6, "2026-06-24T05:00:00+00:00", 60, "Cursor")
        insert_classification(conn, 6, "workspace", "focus")
        insert_segment(conn, 7, "2026-06-24T06:00:00+00:00", 30, "Google Chrome", "youtube.com")
        insert_classification(conn, 7, "entertainment", "drift")
        conn.commit()
        conn.close()

        snapshot = exporter.build_snapshot(path, "fixture-user", "Asia/Seoul", today=dt.date(2026, 6, 24))
        transitions = snapshot["transitions"]

        self.assertEqual(
            transitions["driftAfterFocus"],
            [{"kind": "site", "label": "instagram.com", "count": 2}],
        )
        self.assertEqual(
            [(row["label"], row["count"]) for row in transitions["focusBeforeDrift"]],
            [("Claude", 1), ("Cursor", 1)],
        )

    def test_segments_are_bucketed_by_started_at_local_day(self) -> None:
        temp, path = create_fixture_db()
        self.addCleanup(temp.cleanup)
        conn = sqlite3.connect(path)
        insert_segment(conn, 1, "2026-06-24T14:59:00+00:00", 120, "Cursor")
        insert_classification(conn, 1, "workspace", "focus")
        conn.commit()
        conn.close()

        snapshot = exporter.build_snapshot(path, "fixture-user", "Asia/Seoul", today=dt.date(2026, 6, 25))
        daily = {row["date"]: row for row in snapshot["daily"]}

        self.assertEqual(daily["2026-06-24"]["trackedSeconds"], 120)
        self.assertEqual(daily["2026-06-25"]["trackedSeconds"], 0)
        rhythm = {
            (row["date"], row["hour"]): row["trackedSeconds"]
            for row in snapshot["attentionRhythm"]
            if row["trackedSeconds"]
        }
        self.assertEqual(rhythm[("2026-06-24", 23)], 120)


if __name__ == "__main__":
    unittest.main()
