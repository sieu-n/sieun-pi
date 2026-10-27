// On staging at 02:35Z on 2026-10-25, d2 read staging_green_pct 99.8 for @dr.altheaglobal's collab row: its routine pass found no free fleet
// account from 01:42Z, was released starved at 01:57Z, and its retry settled ok at 02:48Z, while its last ok read (03:23Z the day before) was
// inside 24 h and the Watchlist read it Checked. These cases pin that a row's green state follows its last ok read, as words.ts reads it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { type WatchRow, parseRows, report } from "../scripts/duties/watchlist-green.ts";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = 30 * DAY;
const metrics = [{ key: "staging_green_pct", target: 100, direction: "min" }] as never;

function row(over: Partial<WatchRow>): WatchRow {
  return { platform: "instagram", kind: "tagged", target: "a", paused: false, lastOutcome: "ok", lastRunAt: NOW - HOUR, lastStopReason: "",
    lastErrorCode: "", isPrivate: false, errStreak: 0, due: true, lastOkAt: NOW - HOUR, addedAt: NOW - 10 * DAY, renamed: false, ...over };
}

function staging(rows: WatchRow[]) {
  const out = report({ now: NOW, errors: [], staging: rows }, metrics);
  return { pct: out.metrics.staging_green_pct, excerpt: (out.flagged ?? []).find(flag => flag.kind === "staging_monitor_rows")!.excerpt };
}

const starved = { lastOutcome: "starved", lastRunAt: NOW - 38 * 60_000, lastErrorCode: "fleet_exhausted" } as const;

test("a row whose last run starved is green while its last ok read is inside 24 h", () => {
  const { pct } = staging([row({ target: "dr.altheaglobal", ...starved, lastOkAt: NOW - (23 * HOUR + 11 * 60_000) })]);
  assert.equal(pct, 100);
});

test("a row whose last run starved and whose last ok read is past 24 h is not green, and the flag says why", () => {
  const { pct, excerpt } = staging([row({ target: "b" }), row({ ...starved, lastOkAt: NOW - 25 * HOUR })]);
  assert.equal(pct, 50);
  assert.match(excerpt, /1 tagged last starved, no ok read in 24 h/);
});

test("a row with no account for 2 days reads Stopped and is not green", () => {
  const { pct, excerpt } = staging([row({ ...starved, lastOkAt: NOW - 2 * DAY - HOUR })]);
  assert.equal(pct, 0);
  assert.match(excerpt, /tagged Stopped, no account for 2 days/);
});

test("an error row with its retry due is green on a fresh ok read, and a failed check that no longer retries is not", () => {
  const retrying = row({ kind: "posts", lastOutcome: "error", lastErrorCode: "rate_limited", errStreak: 1, lastOkAt: NOW - 5 * HOUR });
  const forGood = row({ kind: "posts", target: "c", lastOutcome: "error", lastErrorCode: "schema", errStreak: 3, lastOkAt: NOW - 5 * HOUR });
  const { pct, excerpt } = staging([retrying, forGood]);
  assert.equal(pct, 50);
  assert.match(excerpt, /1 posts Stopped, failed schema/);
});

test("parseRows reads last_ok_at from the 12th column", () => {
  const [parsed] = parseRows(["instagram", "tagged", "a", "f", "starved", String(NOW - HOUR), "", "fleet_exhausted", "f", "0", "t", String(NOW - 23 * HOUR), String(NOW - 10 * DAY), "f"].join("\t"));
  assert.equal(parsed!.lastOkAt, NOW - 23 * HOUR);
  assert.equal(parseRows(["instagram", "tagged", "a", "f", "", "", "", "", "f", "0", "t", "", String(NOW), "f"].join("\t"))[0]!.lastOkAt, null);
});
