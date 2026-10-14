import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { type DutyMetric, judge, parseDutyInput } from "../src/shared/chat-duties.ts";
import { UNMEASURED } from "../scripts/duties/estate-reads.ts";
import { type Gauges, type WatchData, type WatchRow, freshPct, isGreen, measure, ownerGreen, parseRows, report, rowKeyOf } from "../scripts/duties/watchlist-green.ts";

const NOW = Date.parse("2026-10-12T14:00:00Z");
const HOUR = 3_600_000;
const FILE = join(import.meta.dirname, "..", "scripts", "duties", "watchlist-green.duty.json");
const dutyMetrics = async (): Promise<DutyMetric[]> => parseDutyInput(JSON.parse(await readFile(FILE, "utf8")), "d", NOW).metrics;
const row = (kind: string, target: string, fields: Partial<WatchRow> = {}): WatchRow =>
  ({ platform: "instagram", kind, target, paused: false, lastOutcome: "ok", lastRunAt: NOW - HOUR, ...fields });
const gauges = (fields: Partial<Gauges> = {}): Gauges => ({ rows: { "posts/monitor": 200, "tagged/monitor": 100 }, overdue: { "posts/monitor": 0, "tagged/monitor": 0 },
  receipts: { ok: 50, error: 0 }, loopAge: 20, ...fields });
const green = (): WatchData => ({ now: NOW, errors: [], keys: ["instagram:account:Brand_A", "instagram:tagged:brand_a", "instagram:tagged:brand_b"],
  rows: [row("posts", "brand_a"), row("tagged", "brand_a"), row("tagged", "brand_b")], prod: gauges(), staging: gauges(), pauseWatch: "false" });

test("watchlist green: the duty file parses, and the precheck writes every metric key", async () => {
  const duty = parseDutyInput(JSON.parse(await readFile(FILE, "utf8")), "d", NOW);
  assert.deepEqual(duty.schedule, { kind: "daily", at: "06:28" });
  assert.equal(duty.precheck.cwd, "../..");
  assert.deepEqual(Object.keys(report(green(), duty.metrics).metrics).sort(), duty.metrics.map(metric => metric.key).sort());
});

test("watchlist green: an all-green watchlist meets every target", async () => {
  const metrics = await dutyMetrics();
  const output = report(green(), metrics);
  assert.equal(output.metrics.owner_green_pct, 100);
  assert.equal(output.metrics.collab_pushed_pct, 100);
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

test("watchlist green: gauges give freshness, error share and loop age; a NaN loop is not measured", async () => {
  const metrics = await dutyMetrics();
  const output = report({ ...green(), prod: gauges({ overdue: { "posts/monitor": 50 }, receipts: { ok: 99, error: 1 }, loopAge: Number.NaN }),
    staging: gauges({ overdue: { "tagged/monitor": 10 } }), pauseWatch: "true" }, metrics);
  assert.equal(output.metrics.prod_posts_fresh_pct, 75);
  assert.equal(output.metrics.prod_read_error_pct, 1);
  assert.equal(output.metrics.prod_loop_age_s, UNMEASURED);
  assert.equal(output.metrics.staging_tagged_overdue, 10);
  const kinds = output.flagged!.map(item => item.kind);
  assert.ok(kinds.includes("loop") && kinds.includes("pause") && kinds.includes("read_errors") && kinds.includes("unmeasured"));
  assert.equal(freshPct({ rows: {}, overdue: {} }, "posts"), 0);
});

test("watchlist green: failed sources count in source_errors and their metrics miss", async () => {
  const metrics = await dutyMetrics();
  const data = await measure({ query: null, authError: "no secrets.env", now: NOW, keys: async () => { throw new Error("Convex authorize gave HTTP 401"); }, rows: async () => "" });
  const output = report(data, metrics);
  assert.deepEqual(Object.keys(output.metrics).sort(), metrics.map(metric => metric.key).sort());
  assert.equal(output.metrics.source_errors, 5, "grafana auth, both gauges, convex keys and an empty ssh read");
  assert.equal(output.metrics.owner_green_pct, -UNMEASURED);
  assert.equal(output.metrics.staging_tagged_overdue, UNMEASURED);
  assert.equal(judge(metrics, output).verdict, "missed");
});

test("watchlist green: the remote psql rows parse", () => {
  assert.deepEqual(parseRows("instagram\ttagged\tbrand_a\tf\t\t\ninstagram\tposts\tbrand_a\tt\tok\t1791774513000\n\njunk\n"), [
    { platform: "instagram", kind: "tagged", target: "brand_a", paused: false, lastOutcome: "", lastRunAt: null },
    { platform: "instagram", kind: "posts", target: "brand_a", paused: true, lastOutcome: "ok", lastRunAt: 1791774513000 },
  ]);
});
