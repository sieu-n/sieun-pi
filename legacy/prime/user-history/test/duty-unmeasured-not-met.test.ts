// On 2026-11-02 at 09:55Z d2's prod rows read hit the statement_timeout, the precheck wrote the placeholder for owner_green_pct,
// prod_read_error_pct and watchlist_risks, and the runner recorded the run met on staging_green_pct alone. A run that leaves a counted metric
// unmeasured and measures no miss reads error, so its job fixes the read; a measured miss still reads missed.
import assert from "node:assert/strict";
import { test } from "node:test";
import { PLACEHOLDER, judge } from "../src/shared/chat-duties.ts";

const metrics = [
  { key: "owner_green_pct", label: "owner", op: ">=", target: 100, headline: true },
  { key: "staging_green_pct", label: "staging", op: ">=", target: 100 },
  { key: "prod_read_error_pct", label: "errors", op: "<=", target: 5 },
] as never;
const flagged = [{ at: 0, kind: "source_error", excerpt: "prod rows: Grafana HTTP 400: canceling statement due to statement timeout" }];

test("a run with an unmeasured metric and no measured miss reads error, never met", () => {
  const judged = judge(metrics, { metrics: { owner_green_pct: -PLACEHOLDER, staging_green_pct: 100, prod_read_error_pct: PLACEHOLDER }, flagged });
  assert.equal(judged.verdict, "error");
  assert.equal(judged.metrics.staging_green_pct?.met, true);
  assert.match(judged.summary, /not measured: the precheck wrote the placeholder 999999 for owner_green_pct, prod_read_error_pct \(prod rows: .*statement timeout\)/);
});

test("a metric the precheck leaves out counts the same as the placeholder", () => {
  assert.equal(judge(metrics, { metrics: { owner_green_pct: 100, staging_green_pct: 100 } }).verdict, "error");
});

test("a measured miss beside an unmeasured metric still reads missed", () => {
  const judged = judge(metrics, { metrics: { owner_green_pct: -PLACEHOLDER, staging_green_pct: 99, prod_read_error_pct: 3 }, flagged });
  assert.equal(judged.verdict, "missed");
});

test("every metric measured and on target reads met", () => {
  assert.equal(judge(metrics, { metrics: { owner_green_pct: 100, staging_green_pct: 100, prod_read_error_pct: 3 } }).verdict, "met");
});
