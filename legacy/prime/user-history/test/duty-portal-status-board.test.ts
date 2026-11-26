// Guards the api-portal agent's API status board duty, which keeps the owner's ask for per-platform and slow or failing endpoint insight
// (#dev-api-portal p19, mww214m1, 2026-11-25): youtube/channel_shorts answered customers at p90 26.24 s over 323 calls on 11-25.
import assert from "node:assert/strict";
import { test } from "node:test";
import { UNMEASURED } from "../scripts/duties/estate-reads.ts";
import { ROUTE_P90_TARGET_S } from "../scripts/duties/customer-api-failures.ts";
import { checkPanels, endpointSql, p90TargetS, panelSpanMs, report } from "../scripts/duties/portal-status-board.ts";

test("an endpoint counts as slow over 15 s p90 and as failing over 5% of its calls failed on our side", () => {
  const out = report([
    { endpoint: "youtube/channel_shorts", calls: 323, oursFailed: 3, p90S: 26.24, topError: "502 scrape_blocked", lastMs: 2 },
    { endpoint: "instagram/user_feed", calls: 100, oursFailed: 6, p90S: 8.44, topError: "503 no code", lastMs: 1 },
    { endpoint: "search/languages", calls: 25, oursFailed: 0, p90S: 0, topError: "", lastMs: 1 },
  ], [{ id: 13, title: "Which customer calls failed, and why?" }], []);
  assert.deepEqual(out.metrics, { slow_endpoints_24h: 1, failing_endpoints_24h: 1, broken_panels_24h: 0 });
  assert.match(out.flagged![0]!.excerpt, /youtube\/channel_shorts: 323 customer calls in 24 h, p90 26.24 s against 15 s, 0.9% failed/);
});

test("a source that failed reads unmeasured, never 0", () => {
  assert.equal(report([], [], ["board: GET dashboard virev-api-portal answered 403"]).metrics.broken_panels_24h, UNMEASURED);
  assert.equal(report([], [], ["endpoints: Grafana HTTP 500"]).metrics.slow_endpoints_24h, UNMEASURED);
});

test("customer calls come from the view without house orgs, less the org_test_ proof orgs, as the alert reads them", () => {
  const sql = endpointSql();
  assert.match(sql, /FROM product\.customer_usage_events\n/);
  assert.match(sql, /NOT startsWith\(org_id, 'org_test_'\)/);
});

test("an endpoint is held to d4's p90 target for its route, so search/bing gets 22 s and others 15 s", () => {
  assert.equal(p90TargetS("search/bing"), ROUTE_P90_TARGET_S["search.bing"]);
  assert.equal(p90TargetS("search/bing"), 22);
  assert.equal(p90TargetS("youtube/channel_shorts"), 15);
  const out = report([
    { endpoint: "search/bing", calls: 21, oursFailed: 0, p90S: 21.5, topError: "", lastMs: 1 },
    { endpoint: "youtube/channel_shorts", calls: 23, oursFailed: 0, p90S: 15.2, topError: "", lastMs: 1 },
  ], [], []);
  assert.equal(out.metrics.slow_endpoints_24h, 1);
  assert.match(out.flagged![0]!.excerpt, /youtube\/channel_shorts: .*p90 15.2 s against 15 s/);
});

test("a panel that errors or answers nothing is broken, unless its noValue text says nothing happened", async () => {
  const dashboard = { templating: { list: [{ name: "events", type: "constant", query: "product.usage_events" }] }, panels: [
    { id: 1, type: "stat", title: "worked", targets: [{ rawSql: "SELECT 1 FROM ${events}" }] },
    { id: 2, type: "table", title: "failed", targets: [{ rawSql: "SELECT 2" }], fieldConfig: { defaults: { noValue: "No customer call failed" } } },
    { id: 3, type: "table", title: "broken", targets: [{ rawSql: "SELECT 3" }] },
  ] };
  const empty = { frames: [{ schema: { fields: [{ name: "n" }] }, data: { values: [[]] } }] };
  const checks = await checkPanels(dashboard, async target => String(target.rawSql).includes("product.usage_events") ? empty
    : target.rawSql === "SELECT 3" ? { error: "Unknown table" } : empty, Date.now());
  assert.deepEqual(checks.map(check => check.problem), ["no_data", undefined, "error"]);
  assert.equal(panelSpanMs("1h"), 3_600_000);
});

test("n is the customer calls behind the endpoint rows and the panels checked, and no rows read n 0 and say so (c249)", () => {
  const out = report([{ endpoint: "youtube/channel_shorts", calls: 323, oursFailed: 3, p90S: 26.24, topError: "", lastMs: 2 }], [{ id: 13, title: "x" }], []);
  assert.deepEqual(out.n, { slow_endpoints_24h: 323, failing_endpoints_24h: 323, broken_panels_24h: 1 });
  const empty = report([], [], []);
  assert.deepEqual(empty.n, { slow_endpoints_24h: 0, failing_endpoints_24h: 0, broken_panels_24h: 0 });
  assert.deepEqual(empty.flagged!.map(slice => slice.kind), ["no_calls", "no_panels"]);
});
