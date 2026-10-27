// Guards the Vent integrations duty (vent-integrations.ts). On 2026-10-19 prod Vent ran a478d04d0afa while staging had run newer builds since
// 06:38Z, prod's console showed resend red on a 403, and google-search-console had 81 failed calls in 24 h; each has to read as a miss.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { dutyShapeProblem, type DutyMetric } from "../src/shared/chat-duties.ts";
import { behindHours, integrationMetrics, UNMEASURED, type ConsoleRead, type IntegrationLight, type IntegrationReads, type KeyRefusal, type ModelRefusal } from "../scripts/duties/vent-integrations.ts";

const HOUR = 3_600_000;
const light = (name: string, value: IntegrationLight["light"], success: number, failures: number, top: IntegrationLight["topFailure24h"] = null): IntegrationLight =>
  ({ name, light: value, reason: `${name} reason`, windows: { "24h": { success, failures } }, topFailure24h: top });
/** The prod console's 24 h reads on 10-25 after release 21, all under 1 core-s. */
const CHEAP: ConsoleRead[] = [{ name: "usage.totals 24h", cpu_s: 0.507, read_rows: 770024 }, { name: "health.top", cpu_s: 0.035, read_rows: 94237 }];
const hosts = (production = "a478d04d0afa", staging = "a478d04d0afa", status = 200): IntegrationReads["hosts"] => ({
  production: { url: "https://vent.virev.ai", status, version: production },
  staging: { url: "https://vent-staging.virev.ai", status: 200, version: staging },
});

test("call success counts only the console's success and failure classes, and red lights count with at most 3 items", () => {
  const lights = [light("resend", "red", 0, 1, { kind: "auth", status: 403, errorCode: null, count: 1 }), light("b2", "green", 4257, 0),
    light("google-search-console", "green", 674, 81, { kind: "5xx", status: 500, errorCode: null, count: 78 }), light("a", "red", 1, 1), light("b", "red", 1, 1), light("c", "red", 1, 1)];
  const { metrics, flagged } = integrationMetrics({ lights, hosts: hosts(), spans: null, refusals: [], modelRefusals: [], consoleReads: CHEAP }, 0);
  assert.equal(metrics.vent_counted_calls_24h, 5019);
  assert.equal(metrics.vent_success_24h_pct, Math.round(100 * 4934 / 5019 * 100) / 100);
  assert.equal(metrics.red_integrations_prod, 4);
  assert.equal(flagged!.filter(flag => flag.kind === "red_light").length, 3);
  const failed = flagged!.filter(flag => flag.kind === "call_failed");
  assert.equal(failed.length, 3);
  assert.match(failed[0]!.excerpt, /^google-search-console: 81 of 755 .* mostly 5xx HTTP 500 \(78\)/);
  assert.equal(metrics.prod_vent_behind_staging_h, 0);
  assert.equal(metrics.source_errors, 0);
});

test("no counted call and a failed lights read leave the success rate unmeasured with a reason, never -1 or a pass", () => {
  const quiet = integrationMetrics({ lights: [light("b2", "grey", 0, 0)], hosts: hosts(), spans: null, refusals: [], modelRefusals: [], consoleReads: CHEAP }, 0);
  assert.equal("vent_success_24h_pct" in quiet.metrics, false);
  assert.equal(quiet.flagged!.filter(flag => flag.kind === "gap").length, 1);
  const output = integrationMetrics({ lights: { error: "Grafana ds/query HTTP 401" }, hosts: hosts(), spans: null, refusals: [], modelRefusals: [], consoleReads: CHEAP }, 0);
  assert.equal("vent_success_24h_pct" in output.metrics, false);
  assert.equal(output.metrics.red_integrations_prod, UNMEASURED);
  assert.equal(output.metrics.source_errors, 1);
});

test("prod behind staging counts from the later of prod getting its build and staging leaving it", () => {
  const now = 1792424000000;
  const prodFirst = 1792328332559;
  const stagingLast = 1792391900017;
  const spans = [{ env: "production", first: prodFirst, last: now }, { env: "staging", first: 1792328315592, last: stagingLast }];
  assert.deepEqual(behindHours(hosts("a478d04d0afa", "fd27624f5075"), spans, now), { hours: Math.round((now - stagingLast) / HOUR * 10) / 10, since: stagingLast });
  assert.equal(behindHours(hosts("a478d04d0afa", "fd27624f5075"), [spans[0]!], now)!.since, prodFirst);
  assert.equal(behindHours(hosts("a478d04d0afa", "fd27624f5075"), [], now), null);
  const output = integrationMetrics({ lights: [], hosts: hosts("a478d04d0afa", "fd27624f5075"), spans, refusals: [], modelRefusals: [], consoleReads: CHEAP }, now);
  assert.equal(output.flagged!.find(flag => flag.kind === "behind_staging")!.excerpt, "prod Vent runs a478d04d0afa and staging runs fd27624f5075; they differ since 2026-10-19T06:38Z");
  assert.equal(integrationMetrics({ lights: [], hosts: hosts("a478d04d0afa", "fd27624f5075"), spans: { error: "HTTP 400" }, refusals: [], modelRefusals: [], consoleReads: CHEAP }, now).metrics.prod_vent_behind_staging_h, UNMEASURED);
});

test("a host that does not answer 200 counts as down, and with no version the lag reads unmeasured", () => {
  const down = { production: { url: "https://vent.virev.ai", status: 0, error: "TLS" }, staging: hosts().staging };
  const output = integrationMetrics({ lights: [], hosts: down, spans: null, refusals: [], modelRefusals: [], consoleReads: CHEAP }, 0);
  assert.equal(output.metrics.vent_hosts_down, 1);
  assert.equal(output.metrics.prod_vent_behind_staging_h, UNMEASURED);
  assert.equal(output.flagged!.find(flag => flag.kind === "host_down")!.excerpt, "https://vent.virev.ai/healthz gave TLS");
});

// From 02:09Z on 10-25 the prod host services exporter on us-metal01 (64.34.205.243) called prod Vent with a key Vent did not know, so every
// Railway and Vercel call was 401 vent_unauthorized with caller unknown. The console leaves refused calls out and this duty read 100%.
test("keyed calls refused as vent_unauthorized count per source address and read off target, and a failed read is unmeasured", () => {
  const last = Date.UTC(2026, 9, 25, 3, 47);
  const refusals: KeyRefusal[] = [{ source: "155.254.27.166", calls: 22, last, integrations: ["clerk", "slack-dev"] },
    { source: "64.34.205.243", calls: 196, last, integrations: ["railway", "vercel"] }];
  const lights = [light("railway", "green", 40, 0), light("vercel", "green", 40, 0)];
  const output = integrationMetrics({ lights, hosts: hosts(), spans: null, refusals, modelRefusals: [], consoleReads: CHEAP }, last);
  assert.equal(output.metrics.vent_success_24h_pct, 100);
  assert.equal(output.metrics.vent_key_refused_sources, 2);
  const rows = output.flagged!.filter(flag => flag.kind === "key_refused");
  assert.deepEqual(rows.map(flag => flag.item), ["64.34.205.243", "155.254.27.166"]);
  assert.equal(rows[0]!.excerpt, "64.34.205.243: 196 prod Vent calls for railway, vercel refused as vent_unauthorized with a key Vent does not know in 24 h, last at 2026-10-25T03:47Z");
  assert.equal(output.lastEventAt?.vent_key_refused_sources, last);
  const none = integrationMetrics({ lights, hosts: hosts(), spans: null, refusals: [], modelRefusals: [], consoleReads: CHEAP }, last);
  assert.equal(none.metrics.vent_key_refused_sources, 0);
  assert.equal(none.lastEventAt, undefined);
  const unread = integrationMetrics({ lights, hosts: hosts(), spans: null, refusals: { error: "HTTP 502" }, modelRefusals: [], consoleReads: CHEAP }, last);
  assert.equal(unread.metrics.vent_key_refused_sources, UNMEASURED);
  assert.equal(unread.metrics.source_errors, 1);
});

// On 10-26 at 02:48Z d9 read d2 as stuck: 64.34.205.243 last refused at 10:01Z and 155.254.27.166 at 12:18Z on 10-25, and with no
// lastEventAt the runner never set quietSince, so a count that only ages out read as a red duty with no fix.
test("lastEventAt for refused key sources is the newest refusal across sources", () => {
  const refusals: KeyRefusal[] = [{ source: "64.34.205.243", calls: 196, last: Date.UTC(2026, 9, 25, 10, 1), integrations: ["railway"] },
    { source: "155.254.27.166", calls: 3, last: Date.UTC(2026, 9, 25, 12, 18), integrations: ["langfuse"] }];
  const output = integrationMetrics({ lights: [], hosts: hosts(), spans: null, refusals, modelRefusals: [], consoleReads: CHEAP }, Date.UTC(2026, 9, 26, 2, 48));
  assert.deepEqual(output.lastEventAt, { vent_key_refused_sources: Date.UTC(2026, 9, 25, 12, 18) });
  assert.equal(integrationMetrics({ lights: [], hosts: hosts(), spans: null, refusals: { error: "HTTP 502" }, modelRefusals: [], consoleReads: CHEAP }, 0).lastEventAt, undefined);
});

// Until release 21 (10-25) prod's console decoded each call row's whole LogAttributes map: on 10-24 at 15:21Z its 24 h usage reads took
// 1.07 to 1.34 core-s on prod ClickHouse (goal p44). Each slow read has to read as a miss, and a read with no cost row as unmeasured.
test("console reads at 1 core-s or more count as slow with at most 3 items, and an unread cost is unmeasured", () => {
  const before: ConsoleRead[] = [{ name: "usage.totals 24h", cpu_s: 1.336, read_rows: 421570 }, { name: "usage.by_caller 24h", cpu_s: 1.073, read_rows: 421570 },
    { name: "usage.by_integration 24h", cpu_s: 1.121, read_rows: 421570 }, { name: "usage.by_operation 24h", cpu_s: 1.121, read_rows: 421570 },
    { name: "calls.all 24h", cpu_s: 0.486, read_rows: 421581 }, { name: "health.top", cpu_s: 1, read_rows: 71117 }];
  const slow = integrationMetrics({ lights: [], hosts: hosts(), spans: null, refusals: [], modelRefusals: [], consoleReads: before }, 0);
  assert.equal(slow.metrics.vent_console_slow_reads_24h, 5);
  const rows = slow.flagged!.filter(flag => flag.kind === "slow_console_read");
  assert.deepEqual(rows.map(flag => flag.item), ["usage.totals 24h", "usage.by_integration 24h", "usage.by_operation 24h"]);
  assert.equal(rows[0]!.excerpt, "prod Vent console read usage.totals 24h took 1.336 core-s on prod ClickHouse for 421570 rows");
  assert.equal(integrationMetrics({ lights: [], hosts: hosts(), spans: null, refusals: [], modelRefusals: [], consoleReads: CHEAP }, 0).metrics.vent_console_slow_reads_24h, 0);
  for (const consoleReads of [{ error: "Grafana ds/query HTTP 502" }, [], [{ name: "health.top", cpu_s: null, read_rows: null }]]) {
    const output = integrationMetrics({ lights: [], hosts: hosts(), spans: null, refusals: [], modelRefusals: [], consoleReads }, 0);
    assert.equal(output.metrics.vent_console_slow_reads_24h, UNMEASURED);
    assert.equal(output.metrics.source_errors, 1);
  }
});

// Owner rule c185 (10-28): Vent lets through only the newest model of each tier and refuses the rest as vent_model_not_allowed. The console
// leaves refused calls out, so in the 7 days to 10-27 the 52,913 claude-opus-5 calls research-agent-be and convex sent would have read as 100%.
test("calls refused as vent_model_not_allowed count per caller with their models, and a failed read is unmeasured", () => {
  const last = Date.UTC(2026, 9, 28, 3, 0);
  const modelRefusals: ModelRefusal[] = [{ caller: "convex", calls: 4, last: last - HOUR, models: ["gpt-6-sol"], operations: ["search_onboarding_suggest"] },
    { caller: "research-agent-be", calls: 41, last, models: ["claude-opus-5", "gpt-5.6-terra"], operations: ["search_email_draft", "search_template_generate"] }];
  const lights = [light("cliproxy-openai", "green", 100, 0)];
  const output = integrationMetrics({ lights, hosts: hosts(), spans: null, refusals: [], modelRefusals, consoleReads: CHEAP }, last);
  assert.equal(output.metrics.vent_success_24h_pct, 100);
  assert.equal(output.metrics.vent_model_refused_callers, 2);
  const rows = output.flagged!.filter(flag => flag.kind === "model_refused");
  assert.deepEqual(rows.map(flag => flag.item), ["research-agent-be", "convex"]);
  assert.equal(rows[0]!.excerpt, "research-agent-be: 41 prod Vent calls on search_email_draft, search_template_generate refused as vent_model_not_allowed for claude-opus-5, gpt-5.6-terra in 24 h, last at 2026-10-28T03:00Z");
  assert.equal(output.lastEventAt?.vent_model_refused_callers, last);
  const none = integrationMetrics({ lights, hosts: hosts(), spans: null, refusals: [], modelRefusals: [], consoleReads: CHEAP }, last);
  assert.equal(none.metrics.vent_model_refused_callers, 0);
  assert.equal(none.lastEventAt, undefined);
  const unread = integrationMetrics({ lights, hosts: hosts(), spans: null, refusals: [], modelRefusals: { error: "HTTP 502" }, consoleReads: CHEAP }, last);
  assert.equal(unread.metrics.vent_model_refused_callers, UNMEASURED);
  assert.equal(unread.metrics.source_errors, 1);
});

// c75: a duty keeps one headline metric and at most 3 more. On 10-25 d2 had 5, and its prod_vent_behind_staging_h reading is one no Vent job
// can move under c154, so the duty keeps the 24 h success headline, refused keys and slow console reads, and the rest stay in the run detail.
// On 10-28 refused models (c185) took the third supporting slot.
test("the duty keeps one headline and at most 3 metrics, and the precheck writes each of them", () => {
  const duty = JSON.parse(readFileSync(new URL("../scripts/duties/vent-integrations.duty.json", import.meta.url), "utf8")) as { metrics: DutyMetric[]; readings?: unknown };
  assert.equal(dutyShapeProblem(duty.metrics), null);
  assert.deepEqual(duty.metrics.map(metric => metric.key), ["vent_success_24h_pct", "vent_key_refused_sources", "vent_console_slow_reads_24h", "vent_model_refused_callers"]);
  assert.equal(duty.readings, undefined);
  const { metrics } = integrationMetrics({ lights: [light("b2", "green", 10, 0)], hosts: hosts(), spans: null, refusals: [], modelRefusals: [], consoleReads: CHEAP }, 0);
  for (const metric of duty.metrics) assert.equal(typeof metrics[metric.key], "number", metric.key);
});
