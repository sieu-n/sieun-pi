// The owner's t31 answer of 2026-10-21, "Keep them Stopped as they are now": an owner watch that reads Stopped because Instagram hides the
// account is an accepted state. These cases pin that d2 counts it green, keeps it out of watchlist_risks, and shows the count on its own line.
import assert from "node:assert/strict";
import { test } from "node:test";
import { type WatchRow, isAcceptedHidden, report } from "../scripts/duties/watchlist-green.ts";

const DAY = 24 * 3_600_000;
const NOW = 30 * DAY;
const metrics = [{ key: "owner_green_pct", target: 100, direction: "min" }, { key: "watchlist_risks", target: 0, direction: "max" }] as never;

function row(over: Partial<WatchRow>): WatchRow {
  const r: WatchRow = { platform: "instagram", kind: "posts", target: "a", paused: false, lastOutcome: "ok", lastRunAt: NOW - 3_600_000, lastStopReason: "",
    lastErrorCode: "", isPrivate: false, errStreak: 0, due: true, lastOkAt: null, addedAt: NOW - 10 * DAY, renamed: false, ...over };
  return "lastOkAt" in over || r.lastOutcome !== "ok" ? r : { ...r, lastOkAt: r.lastRunAt };
}

function owner(rows: WatchRow[]) {
  const keys = rows.map(r => `${r.platform}:${r.kind === "posts" ? "account" : r.kind}:${r.target}`);
  const out = report({ now: NOW, errors: [], keys, rows, streams: [], screen: [{ keys: 1, ms: 100, status: 200 }] } as never, metrics);
  const flag = (kind: string) => (out.flagged ?? []).find(f => f.kind === kind)?.excerpt ?? "";
  return { metrics: out.metrics, detail: out.metrics, hiddenLine: flag("owner_hidden"), risks: flag("watchlist_risks") };
}

test("a hidden account read a week ago is green, no risk, and counted on its own line", () => {
  const { metrics, detail, hiddenLine } = owner([
    row({ target: "a" }),
    row({ target: "b", lastStopReason: "hidden", lastRunAt: NOW - 6 * DAY }),
    row({ target: "c", lastOutcome: "error", lastErrorCode: "timeline_hidden", errStreak: 1 }),
  ]);
  assert.equal(metrics.owner_green_pct, 100);
  assert.equal(metrics.watchlist_risks, 0);
  assert.equal(detail.owner_hidden_watches, 2);
  assert.equal(detail.owner_stopped_watches, 0);
  assert.match(hiddenLine, /^2 hidden by Instagram/);
});

test("another Stopped reason still counts red and as a risk", () => {
  const { metrics, detail } = owner([
    row({ target: "a" }),
    row({ target: "b", lastOutcome: "error", lastErrorCode: "permanent_error", errStreak: 3, due: false }),
  ]);
  assert.equal(metrics.owner_green_pct, 50);
  assert.equal(metrics.watchlist_risks, 1);
  assert.equal(detail.owner_stopped_watches, 1);
  assert.equal(detail.owner_hidden_watches, 0);
});

test("the rule reads the row's state: paused or renamed hidden rows are not accepted hidden", () => {
  assert.equal(isAcceptedHidden(row({ lastStopReason: "hidden" })), true);
  assert.equal(isAcceptedHidden(row({ lastStopReason: "hidden", paused: true })), false);
  assert.equal(isAcceptedHidden(row({ lastStopReason: "hidden", renamed: true })), false);
  assert.equal(isAcceptedHidden(row({ lastStopReason: "private" })), false);
});

test("a wave of hidden owner watches is one Watchlist risk while each stays green (11-16, 676 public accounts read hidden)", () => {
  const rows = [row({ target: "a" }), ...Array.from({ length: 101 }, (_, i) => row({ target: `h${i}`, lastStopReason: "hidden" }))];
  const { metrics, risks } = owner(rows);
  assert.equal(metrics.owner_green_pct, 100);
  assert.equal(metrics.watchlist_risks, 1);
  assert.match(risks, /1 hidden wave \(101 owner watches read hidden/);
});

test("d2 counts the accounts the Watchlist foot says need a look, and the t31 states among them stay green with no risk (11-20, 775 against 398)", () => {
  const { metrics, detail } = owner([
    row({ target: "a" }),
    row({ target: "b", lastOutcome: "gone", lastErrorCode: "profile_not_found", lastOkAt: null }),
    row({ target: "c", isPrivate: true }),
    row({ target: "d", lastStopReason: "hidden" }),
    row({ target: "e", lastOutcome: "gone", lastErrorCode: "profile_not_found", lastOkAt: NOW - 20 * DAY }),
    row({ target: "f", lastOutcome: "error", lastErrorCode: "login_wall", errStreak: 2, lastOkAt: NOW - 2 * DAY }),
  ]);
  assert.equal(detail.owner_need_look, 3);
  assert.equal(detail.owner_stopped_watches, 0);
  assert.equal(metrics.watchlist_risks, 0);
  assert.equal(metrics.owner_green_pct, 83.3);
});
