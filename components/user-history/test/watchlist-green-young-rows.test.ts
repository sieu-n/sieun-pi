// On 10-20 at 01:30:40Z d2 read staging_green_pct 98.1% for one tagged row 40 s old (a hosted e2e glossier watch, claimed at 01:31Z, deleted at
// 01:37Z); these cases pin that a row has its first 24 h to be read, as crawler health.py _NO_GOOD_READ gives it, and stays red after that.
import assert from "node:assert/strict";
import { test } from "node:test";
import { type WatchRow, isClosed, parseRows, report, stopReason } from "../scripts/duties/watchlist-green.ts";

const DAY = 24 * 3_600_000;
const NOW = 30 * DAY;
const metrics = [{ key: "staging_green_pct", target: 100, direction: "min" }] as never;

function row(over: Partial<WatchRow>): WatchRow {
  return { platform: "instagram", kind: "tagged", target: "a", paused: false, lastOutcome: "ok", lastRunAt: NOW - 3_600_000, lastStopReason: "",
    lastErrorCode: "", isPrivate: false, errStreak: 0, due: true, noAccountSince: null, addedAt: NOW - 10 * DAY, renamed: false, ...over };
}

function staging(rows: WatchRow[]) {
  const out = report({ now: NOW, errors: [], staging: rows }, metrics);
  return { pct: out.metrics.staging_green_pct, excerpt: (out.flagged ?? []).find(flag => flag.kind === "staging_monitor_rows")!.excerpt };
}

test("a tagged row added 40 s ago that never ran is green and named as not read yet", () => {
  const { pct, excerpt } = staging([row({ target: "b" }), row({ target: "glossier", lastOutcome: "", lastRunAt: null, addedAt: NOW - 40_000 })]);
  assert.equal(pct, 100);
  assert.match(excerpt, /2 of 2 unpaused staging monitor rows/);
  assert.match(excerpt, /1 added under 24 h ago and not read ok yet/);
});

test("a row added more than 24 h ago that never ran stays red", () => {
  const { pct, excerpt } = staging([row({ target: "b" }), row({ target: "c", lastOutcome: "", lastRunAt: null, addedAt: NOW - DAY - 1 })]);
  assert.equal(pct, 50);
  assert.match(excerpt, /1 tagged never ran/);
});

test("a young row the Watchlist reads Stopped stays red", () => {
  const { pct } = staging([row({ lastOutcome: "ok", lastStopReason: "hidden", addedAt: NOW - 60_000 })]);
  assert.equal(pct, 0);
});

test("parseRows reads created_at as addedAt from the 13th column", () => {
  const [parsed] = parseRows(["instagram", "tagged", "glossier", "f", "", "", "", "", "f", "0", "t", "", String(NOW - 40_000), "f"].join("\t"));
  assert.equal(parsed!.addedAt, NOW - 40_000);
  assert.equal(parsed!.lastRunAt, null);
});

test("a hidden row whose last run named a newer handle reads closed, as the screen's Removed on Instagram, and a plain hidden row stays Stopped", () => {
  const renamed = parseRows(["instagram", "posts", "haruna_kr", "f", "ok", String(NOW - 60_000), "hidden", "", "f", "0", "t", "", String(NOW - 10 * DAY), "t"].join("\t"))[0]!;
  assert.equal(renamed.renamed, true);
  assert.equal(isClosed(renamed), true);
  assert.equal(stopReason(renamed, NOW), null);
  assert.equal(isClosed(row({ lastOutcome: "ok", lastStopReason: "hidden" })), false);
  assert.equal(stopReason(row({ lastOutcome: "ok", lastStopReason: "hidden" }), NOW), "Instagram hides this account");
});
