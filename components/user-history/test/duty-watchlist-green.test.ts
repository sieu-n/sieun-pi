import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { type DutyMetric, judge, parseDutyInput } from "../src/shared/chat-duties.ts";
import { UNMEASURED } from "../scripts/duties/estate-reads.ts";
import {
  type Gauges, type WatchData, type WatchRow, freshPct, isClosed, isGreen, measure, ownerGreen, parseReceipts, parseRows, report, rowKeyOf, rowsGreen,
} from "../scripts/duties/watchlist-green.ts";

const NOW = Date.parse("2026-10-12T14:00:00Z");
const HOUR = 3_600_000;
const FILE = join(import.meta.dirname, "..", "scripts", "duties", "watchlist-green.duty.json");
const dutyMetrics = async (): Promise<DutyMetric[]> => parseDutyInput(JSON.parse(await readFile(FILE, "utf8")), "d", NOW).metrics;
const row = (kind: string, target: string, fields: Partial<WatchRow> = {}): WatchRow =>
  ({ platform: "instagram", kind, target, paused: false, lastOutcome: "ok", lastRunAt: NOW - HOUR, lastStopReason: "", lastErrorCode: "", isPrivate: false,
    ...fields });
const gauges = (fields: Partial<Gauges> = {}): Gauges => ({ rows: { "posts/monitor": 200, "tagged/monitor": 100 }, overdue: { "posts/monitor": 0, "tagged/monitor": 0 },
  loopAge: 20, ...fields });
const green = (): WatchData => ({ now: NOW, errors: [], keys: ["instagram:account:Brand_A", "instagram:tagged:brand_a", "instagram:tagged:brand_b"],
  rows: [row("posts", "brand_a"), row("tagged", "brand_a"), row("tagged", "brand_b")], receipts: { ok: 99, error: 1, starved: 40, superseded: 3 },
  staging: [row("posts", "s1"), row("tagged", "s1"), row("posts", "old", { paused: true, lastRunAt: NOW - 90 * HOUR })], prod: gauges(), pauseWatch: "false" });

test("watchlist green: the duty file has one headline and 3 more, and the precheck writes each judged key plus the detail keys", async () => {
  const duty = parseDutyInput(JSON.parse(await readFile(FILE, "utf8")), "d", NOW);
  assert.deepEqual(duty.schedule, { kind: "daily", at: "06:28" });
  assert.equal(duty.precheck.cwd, "../..");
  assert.deepEqual(duty.metrics.filter(metric => metric.headline).map(metric => metric.key), ["owner_green_pct"]);
  assert.deepEqual(duty.metrics.map(metric => metric.key), ["owner_green_pct", "staging_green_pct", "collab_pushed_pct", "prod_read_error_pct"]);
  const keys = Object.keys(report(green(), duty.metrics).metrics);
  for (const metric of duty.metrics) assert.ok(keys.includes(metric.key), metric.key);
  for (const key of ["prod_posts_fresh_pct", "prod_loop_age_s", "staging_posts_green_pct", "staging_tagged_not_green", "source_errors"]) assert.ok(keys.includes(key), key);
});

test("watchlist green: an all-green watchlist meets every target", async () => {
  const metrics = await dutyMetrics();
  const output = report(green(), metrics);
  assert.equal(output.metrics.owner_green_pct, 100);
  assert.equal(output.metrics.collab_pushed_pct, 100);
  assert.equal(output.metrics.staging_green_pct, 100, "the paused staging row is out of the staging Watchlist");
  assert.equal(output.metrics.prod_read_error_pct, 1, "starved and superseded runs never asked Instagram");
  assert.equal(judge(metrics, output).verdict, "met");
});

test("watchlist green: an account is green only when every watch on it is, and each reason is counted", () => {
  const keys = ["instagram:account:a", "instagram:tagged:a", "instagram:tagged:b", "instagram:tagged:c", "instagram:tagged:d", "instagram:tagged:e", "bad"];
  const rows = [row("posts", "a"), row("tagged", "a", { lastOutcome: "", lastRunAt: null }), row("tagged", "b", { paused: true }),
    row("tagged", "c", { lastRunAt: NOW - 25 * HOUR }), row("tagged", "d", { lastOutcome: "error" })];
  const owner = ownerGreen(keys, rows, NOW);
  assert.equal(owner.accounts, 5);
  assert.equal(owner.green, 0);
  assert.equal(owner.collabs, 5);
  assert.equal(owner.pushed, 3, "a, c and d have an unpaused tagged row; b is paused and e has none");
  assert.equal(owner.unread, 1);
  assert.deepEqual(Object.fromEntries(owner.why), { "tagged never ran": 1, "tagged paused": 1, "tagged ok but older than 24 h": 1, "tagged last error": 1, "tagged no monitor row": 1 });
  assert.deepEqual(rowKeyOf("instagram:account:Foo.Bar"), { platform: "instagram", kind: "posts", target: "foo.bar" });
  assert.equal(isGreen(undefined, NOW), false);
});

test("watchlist green: a removed or private account is green at any age, as the Watchlist reads it checked", () => {
  const old = NOW - 6 * 24 * HOUR;
  const closed = [
    row("posts", "private_ok", { lastStopReason: "private", lastRunAt: old }),
    row("tagged", "private_flag", { lastStopReason: "exhausted", isPrivate: true, lastRunAt: old }),
    row("posts", "gone", { lastOutcome: "gone", lastRunAt: old }),
    row("tagged", "not_found", { lastOutcome: "error", lastErrorCode: "profile_not_found", lastRunAt: old }),
  ];
  for (const watch of closed) {
    assert.equal(isClosed(watch), true, watch.target);
    assert.equal(isGreen(watch, NOW), true, watch.target);
  }
  assert.equal(isGreen(row("posts", "paused_private", { isPrivate: true, paused: true }), NOW), false, "a paused row is never green");
  assert.equal(isGreen(row("posts", "blocked", { lastOutcome: "error", lastErrorCode: "scrape_blocked" }), NOW), false);
  assert.equal(isGreen(row("posts", "hidden", { lastStopReason: "hidden", lastRunAt: old }), NOW), false, "a hidden account still reads Stopped");
  assert.equal(isGreen(row("posts", "private_error", { lastOutcome: "error", lastStopReason: "private", lastRunAt: old }), NOW), false);
  const owner = ownerGreen(["instagram:account:private_ok", "instagram:tagged:private_flag", "instagram:account:gone", "instagram:tagged:not_found"], closed, NOW);
  assert.equal(owner.green, owner.accounts);
});

test("watchlist green: staging counts unpaused posts and collab rows, and a row whose reads fail is not green", async () => {
  const rows = [row("posts", "a"), row("posts", "b", { lastOutcome: "error" }), row("tagged", "a"), row("tagged", "b", { lastRunAt: NOW - 30 * HOUR }),
    row("posts", "c", { paused: true }), row("ads", "x")];
  const staging = rowsGreen(rows, NOW);
  assert.equal(staging.rows, 4);
  assert.equal(staging.green, 2);
  assert.deepEqual(Object.fromEntries(staging.why), { "posts last error": 1, "tagged ok but older than 24 h": 1 });
  const output = report({ ...green(), staging: rows }, await dutyMetrics());
  assert.equal(output.metrics.staging_green_pct, 50);
  assert.equal(output.metrics.staging_posts_green_pct, 50);
  assert.equal(output.metrics.staging_tagged_not_green, 1);
  assert.equal(report({ ...green(), staging: [row("posts", "c", { paused: true })] }, await dutyMetrics()).metrics.staging_green_pct, 0, "an empty staging Watchlist is not green");
});

test("watchlist green: the read error share uses finished reads, and no reads or a stalled loop miss it", async () => {
  const metrics = await dutyMetrics();
  const errors = report({ ...green(), receipts: { ok: 90, error: 9, gone: 1, starved: 500 } }, metrics);
  assert.equal(errors.metrics.prod_read_error_pct, 9);
  assert.equal(judge(metrics, errors).verdict, "missed");
  const none = report({ ...green(), receipts: { starved: 20 } }, metrics);
  assert.equal(none.metrics.prod_read_error_pct, UNMEASURED);
  assert.ok(none.flagged!.some(item => item.kind === "no_reads"));
  const nan = report({ ...green(), prod: gauges({ loopAge: Number.NaN }), pauseWatch: "true" }, metrics);
  assert.equal(nan.metrics.prod_read_error_pct, UNMEASURED);
  const stalled = report({ ...green(), prod: gauges({ loopAge: 900, overdue: { "posts/monitor": 50 } }) }, metrics);
  assert.equal(stalled.metrics.prod_read_error_pct, UNMEASURED);
  assert.equal(stalled.metrics.prod_loop_age_s, 900);
  assert.equal(stalled.metrics.prod_posts_fresh_pct, 75);
  const kinds = [...nan.flagged!, ...stalled.flagged!].map(item => item.kind);
  assert.ok(kinds.includes("loop") && kinds.includes("pause") && kinds.includes("unmeasured"));
  assert.equal(freshPct({ rows: {}, overdue: {} }, "posts"), 0);
});

test("watchlist green: failed sources count in source_errors and miss every metric they feed", async () => {
  const metrics = await dutyMetrics();
  const data = await measure({ query: null, authError: "no secrets.env", now: NOW, keys: async () => { throw new Error("Convex authorize gave HTTP 401"); },
    rows: async () => "", staging: async () => { throw new Error("ssh exit 255"); } });
  const output = report(data, metrics);
  assert.equal(output.metrics.source_errors, 6, "grafana auth, prod gauges, prod config, convex keys, staging rows and an empty prod read");
  assert.equal(output.metrics.owner_green_pct, -UNMEASURED);
  assert.equal(output.metrics.staging_green_pct, -UNMEASURED);
  assert.equal(output.metrics.collab_pushed_pct, -UNMEASURED);
  assert.equal(output.metrics.prod_read_error_pct, UNMEASURED);
  assert.equal(judge(metrics, output).verdict, "missed");
  assert.ok(output.flagged!.filter(item => item.kind === "source_error").some(item => item.excerpt.startsWith("staging rows:")));
});

test("watchlist green: the remote psql rows and receipts parse", () => {
  const text = "instagram\ttagged\tbrand_a\tf\t\t\t\t\tf\ninstagram\tposts\tbrand_a\tt\tok\t1791774513000\tprivate\t\tt\n\njunk\nreceipt\tok\t120\nreceipt\terror\t3\n";
  assert.deepEqual(parseRows(text), [
    { platform: "instagram", kind: "tagged", target: "brand_a", paused: false, lastOutcome: "", lastRunAt: null, lastStopReason: "", lastErrorCode: "", isPrivate: false },
    { platform: "instagram", kind: "posts", target: "brand_a", paused: true, lastOutcome: "ok", lastRunAt: 1791774513000, lastStopReason: "private", lastErrorCode: "",
      isPrivate: true },
  ]);
  assert.deepEqual(parseReceipts(text), { ok: 120, error: 3 });
});
