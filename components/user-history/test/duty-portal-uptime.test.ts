import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { judge, parseDutyInput } from "../src/shared/chat-duties.ts";
import { type Answers, framesToSeries, QUERIES, type Series, TARGETS, UNMEASURED, UNMEASURED_PCT, uptimeMetrics } from "../scripts/duties/portal-uptime.ts";

const AT = Date.parse("2026-10-12T14:00:00Z");
const each = (value: number): Series[] => TARGETS.map(target => ({ labels: { env: "production", job: "api-portal-health", target }, value }));
const answers = (over: Partial<Answers> = {}): Answers => ({
  up: each(1), uptime: each(1), age: each(120), p90: [{ labels: { target: "portal_openapi" }, value: 360 }], ...over,
});
const OK = { status: 200, ms: 120 };

test("portal uptime: a Grafana instant frame becomes labels and the last value", () => {
  const frames = [
    { schema: { fields: [{ name: "Time" }, { name: "Value", labels: { target: "crawler_health" } }] }, data: { values: [[1, 2], [1, 0]] } },
    { schema: { fields: [{ name: "Time" }] }, data: { values: [[1]] } },
  ];
  assert.deepEqual(framesToSeries(frames), [{ labels: { target: "crawler_health" }, value: 0 }]);
  assert.deepEqual(framesToSeries(undefined), []);
});

test("portal uptime: every target up gives all metrics on target and no flags", async () => {
  const output = uptimeMetrics(answers(), OK, AT);
  assert.deepEqual(output.metrics, { probes_down_now: 0, probe_uptime_24h_pct: 100, probe_age_min: 2, portal_openapi_p90_ms: 360, portal_openapi_direct_ms: 120, source_errors: 0 });
  assert.deepEqual(output.flagged, []);
  const duty = parseDutyInput(JSON.parse(await readFile("scripts/duties/portal-uptime.duty.json", "utf8")), "d1", AT);
  assert.equal(judge(duty.metrics, output).verdict, "met");
});

test("portal uptime: a down target, a lost 24 h share and a stale probe are flagged", () => {
  const output = uptimeMetrics(answers({ up: each(1).map(s => s.labels.target === "crawler_health" ? { ...s, value: 0 } : s), uptime: each(0.99), age: each(1800) }), OK, AT);
  assert.equal(output.metrics.probes_down_now, 1);
  assert.equal(output.metrics.probe_uptime_24h_pct, 99);
  assert.equal(output.metrics.probe_age_min, 30);
  assert.deepEqual(output.flagged?.map(item => item.kind), ["down", "uptime", "uptime", "uptime", "stale"]);
});

test("portal uptime: Grafana errors and a missing target series give 999999, -1 for the share and source_errors, never a good value", async () => {
  const output = uptimeMetrics(answers({ up: { error: "HTTP 401: unauthorized" }, age: each(60).slice(1) }), OK, AT);
  assert.equal(output.metrics.probes_down_now, UNMEASURED);
  assert.equal(output.metrics.probe_age_min, UNMEASURED);
  assert.equal(output.metrics.source_errors, 2);
  const unread = uptimeMetrics(answers({ uptime: { error: "HTTP 502" } }), OK, AT);
  assert.equal(unread.metrics.probe_uptime_24h_pct, UNMEASURED_PCT);
  assert.match(output.flagged![0]!.excerpt, new RegExp(QUERIES.up.replace(/[{}()[\]]/g, "\\$&")));
  assert.match(output.flagged![1]!.excerpt, /no series for crawler_health/);
  const duty = parseDutyInput(JSON.parse(await readFile("scripts/duties/portal-uptime.duty.json", "utf8")), "d1", AT);
  assert.equal(judge(duty.metrics, output).verdict, "missed");
});

test("portal uptime: a failed direct GET is flagged, and so is the Convex probe still saying the portal is up", () => {
  const output = uptimeMetrics(answers(), { status: 0, ms: 15000, error: "The operation was aborted due to timeout" }, AT);
  assert.deepEqual(output.flagged?.map(item => item.kind), ["direct_down", "disagree"]);
});

test("portal uptime: the duty JSON passes parseDutyInput with the targets the script cites", async () => {
  const duty = parseDutyInput(JSON.parse(await readFile("scripts/duties/portal-uptime.duty.json", "utf8")), "d1", AT);
  assert.equal(duty.name, "Portal stays up");
  assert.deepEqual(duty.schedule, { kind: "daily", at: "07:29" });
  assert.deepEqual(duty.metrics.map(m => [m.key, m.op, m.target]), [["probe_uptime_24h_pct", ">=", 100], ["probes_down_now", "<=", 0], ["probe_age_min", "<=", 15]]);
  assert.equal(duty.metrics.find(m => m.headline)?.key, "probe_uptime_24h_pct");
});
