// Guards the api-portal agent's API status board duty, which keeps the owner's ask for per-platform and slow or failing endpoint insight
// (#dev-api-portal p19, mww214m1, 2026-11-25): youtube/channel_shorts answered customers at p90 26.24 s over 323 calls on 11-25.
import assert from "node:assert/strict";
import { test } from "node:test";
import { UNMEASURED } from "../scripts/duties/estate-reads.ts";
import { ROUTE_P90_TARGET_S } from "../scripts/duties/customer-api-failures.ts";
import { billedDay, billedDays, checkPanels, endpointSql, functionJump, p90TargetS, panelSpanMs, report, type Charge } from "../scripts/duties/portal-status-board.ts";

test("an endpoint counts as slow over 15 s p90 and as failing over 5% of its calls failed on our side", () => {
  const out = report([
    { endpoint: "youtube/channel_shorts", calls: 323, oursFailed: 3, p90S: 26.24, topError: "502 scrape_blocked", lastMs: 2 },
    { endpoint: "instagram/user_feed", calls: 100, oursFailed: 6, p90S: 8.44, topError: "503 no code", lastMs: 1 },
    { endpoint: "search/languages", calls: 25, oursFailed: 0, p90S: 0, topError: "", lastMs: 1 },
  ], [{ id: 13, title: "Which customer calls failed, and why?" }], []);
  assert.deepEqual(out.metrics, { slow_endpoints_24h: 1, failing_endpoints_24h: 1, broken_panels_24h: 0, function_hours_day: UNMEASURED, function_time_jump: UNMEASURED });
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
  assert.deepEqual(out.n, { slow_endpoints_24h: 323, failing_endpoints_24h: 323, broken_panels_24h: 1, function_hours_day: 0, function_time_jump: 0 });
  const empty = report([], [], []);
  assert.deepEqual(empty.n, { slow_endpoints_24h: 0, failing_endpoints_24h: 0, broken_panels_24h: 0, function_hours_day: 0, function_time_jump: 0 });
  assert.deepEqual(empty.flagged!.map(slice => slice.kind), ["no_calls", "no_panels"]);
});

// auto-sns-agent p243: summed REPORT durations read 10.18 h (20.35 GB-h) for the billing day from 08:00Z 11-27, while Vercel billed 15.40 GB-h.
test("function_hours_day reads Vercel's billed Fluid GB-hours of auto-sns-api over its newest ended billing day, flags one over 8 h", () => {
  const row = (start: string, end: string, service: string, quantity: number, project = "auto-sns-api"): Charge =>
    ({ ServiceName: service, ConsumedQuantity: quantity, ChargePeriodStart: start, ChargePeriodEnd: end, Tags: { ProjectName: project } });
  const charges = [
    row("2026-11-26T08:00:00.000Z", "2026-11-27T08:00:00.000Z", "Fluid Provisioned Memory", 37.154),
    row("2026-11-27T08:00:00.000Z", "2026-11-28T08:00:00.000Z", "Fluid Provisioned Memory", 15.4),
    row("2026-11-27T08:00:00.000Z", "2026-11-28T08:00:00.000Z", "Fluid Active CPU", 0.733),
    row("2026-11-27T08:00:00.000Z", "2026-11-28T08:00:00.000Z", "Function Invocations", 106_828.6),
    row("2026-11-27T08:00:00.000Z", "2026-11-28T08:00:00.000Z", "Fluid Provisioned Memory", 99, "auto-sns-search"),
    row("2026-11-28T08:00:00.000Z", "2026-11-29T08:00:00.000Z", "Fluid Provisioned Memory", 3),
  ];
  const day = billedDay(charges, Date.parse("2026-11-28T09:00:00Z"))!;
  assert.deepEqual(day, { start: "2026-11-27T08:00:00.000Z", gbHours: 15.4, cpuHours: 0.733, invocations: 106_829 });
  const under = report([], [], [], day);
  assert.equal(under.metrics.function_hours_day, 7.7);
  assert.equal(under.n.function_hours_day, 106_829);
  assert.equal(under.flagged!.some(slice => slice.kind === "function_time"), false);
  const over = report([], [], [], billedDay(charges, Date.parse("2026-11-27T09:00:00Z")));
  assert.equal(over.metrics.function_hours_day, 18.577);
  assert.match(over.flagged!.find(slice => slice.kind === "function_time")!.excerpt, /Vercel billed auto-sns-api 18.577 instance hours \(37.15 GB-h/);
  assert.equal(report([], [], ["function: Vercel billing charges answered 403"], null).metrics.function_hours_day, UNMEASURED);
});

// Owner, #1124-cost-management p52 and p54 (11-28): a PostHog sync cost up to $80 a day for 11 days because its duty judged only a fixed line.
// Vercel billed auto-sns-api 2.91, 5.69 and 17.30 instance hours on the days from 08:00Z 11-23, 11-24 and 11-25, all but one under 8 h.
test("function_time_jump flags a billing day over 2 times the median of the 7 before it, also under 8 h, and needs 8 days", () => {
  const hours = [4.219, 1.938, 0.822, 1.178, 3.258, 1.229, 0.364, 1.947, 0.79, 0.311, 0.85, 2.908, 5.69, 17.298];
  const charges: Charge[] = hours.map((value, index) => {
    const start = Date.parse("2026-11-12T08:00:00Z") + index * 86_400_000;
    return { ServiceName: "Fluid Provisioned Memory", ConsumedQuantity: 2 * value, ChargePeriodStart: new Date(start).toISOString(),
      ChargePeriodEnd: new Date(start + 86_400_000).toISOString(), Tags: { ProjectName: "auto-sns-api" } };
  });
  const until = (day: string) => functionJump(billedDays(charges, Date.parse(`${day}T09:00:00Z`)));
  const quiet = until("2026-11-23")!;
  assert.deepEqual([quiet.hours, quiet.medianHours], [0.85, 1.178]);
  assert.equal(report([], [], [], null, quiet).metrics.function_time_jump, 0);
  const jump = until("2026-11-25")!;
  assert.equal(jump.day.start, "2026-11-24T08:00:00.000Z");
  const out = report([], [], [], billedDays(charges, Date.parse("2026-11-25T09:00:00Z")).at(-1)!, jump);
  assert.equal(out.metrics.function_hours_day, 5.69);
  assert.equal(out.metrics.function_time_jump, 1);
  assert.equal(out.n.function_time_jump, 8);
  assert.match(out.flagged!.find(slice => slice.kind === "function_time_jump")!.excerpt,
    /billed auto-sns-api 5.69 instance hours on the billing day from 2026-11-24T08:00:00.000Z, 6.7 times the median of 0.85 h over the 7 days from 2026-11-17 to 2026-11-23/);
  assert.equal(functionJump(billedDays(charges, Date.parse("2026-11-25T09:00:00Z")).slice(-7)), null, "7 days are too few");
  assert.equal(report([], [], [], null, null).metrics.function_time_jump, UNMEASURED);
});
