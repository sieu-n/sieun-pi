// Guards the Vent integrations duty (vent-integrations.ts). On 2026-10-19 prod Vent ran a478d04d0afa while staging had run newer builds since
// 06:38Z, prod's console showed resend red on a 403, and google-search-console had 81 failed calls in 24 h; each has to read as a miss.
import assert from "node:assert/strict";
import { test } from "node:test";
import { behindHours, integrationMetrics, UNMEASURED, type IntegrationLight, type IntegrationReads, type KeyRefusal } from "../scripts/duties/vent-integrations.ts";

const HOUR = 3_600_000;
const light = (name: string, value: IntegrationLight["light"], success: number, failures: number, top: IntegrationLight["topFailure24h"] = null): IntegrationLight =>
  ({ name, light: value, reason: `${name} reason`, windows: { "24h": { success, failures } }, topFailure24h: top });
const hosts = (production = "a478d04d0afa", staging = "a478d04d0afa", status = 200): IntegrationReads["hosts"] => ({
  production: { url: "https://vent.virev.ai", status, version: production },
  staging: { url: "https://vent-staging.virev.ai", status: 200, version: staging },
});

test("call success counts only the console's success and failure classes, and red lights count with at most 3 items", () => {
  const lights = [light("resend", "red", 0, 1, { kind: "auth", status: 403, errorCode: null, count: 1 }), light("b2", "green", 4257, 0),
    light("google-search-console", "green", 674, 81, { kind: "5xx", status: 500, errorCode: null, count: 78 }), light("a", "red", 1, 1), light("b", "red", 1, 1), light("c", "red", 1, 1)];
  const { metrics, flagged } = integrationMetrics({ lights, hosts: hosts(), spans: null, refusals: [] }, 0);
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
  const quiet = integrationMetrics({ lights: [light("b2", "grey", 0, 0)], hosts: hosts(), spans: null, refusals: [] }, 0);
  assert.equal("vent_success_24h_pct" in quiet.metrics, false);
  assert.equal(quiet.flagged!.filter(flag => flag.kind === "gap").length, 1);
  const output = integrationMetrics({ lights: { error: "Grafana ds/query HTTP 401" }, hosts: hosts(), spans: null, refusals: [] }, 0);
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
  const output = integrationMetrics({ lights: [], hosts: hosts("a478d04d0afa", "fd27624f5075"), spans, refusals: [] }, now);
  assert.equal(output.flagged!.find(flag => flag.kind === "behind_staging")!.excerpt, "prod Vent runs a478d04d0afa and staging runs fd27624f5075; they differ since 2026-10-19T06:38Z");
  assert.equal(integrationMetrics({ lights: [], hosts: hosts("a478d04d0afa", "fd27624f5075"), spans: { error: "HTTP 400" }, refusals: [] }, now).metrics.prod_vent_behind_staging_h, UNMEASURED);
});

test("a host that does not answer 200 counts as down, and with no version the lag reads unmeasured", () => {
  const down = { production: { url: "https://vent.virev.ai", status: 0, error: "TLS" }, staging: hosts().staging };
  const output = integrationMetrics({ lights: [], hosts: down, spans: null, refusals: [] }, 0);
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
  const output = integrationMetrics({ lights, hosts: hosts(), spans: null, refusals }, last);
  assert.equal(output.metrics.vent_success_24h_pct, 100);
  assert.equal(output.metrics.vent_key_refused_sources, 2);
  const rows = output.flagged!.filter(flag => flag.kind === "key_refused");
  assert.deepEqual(rows.map(flag => flag.item), ["64.34.205.243", "155.254.27.166"]);
  assert.equal(rows[0]!.excerpt, "64.34.205.243: 196 prod Vent calls for railway, vercel refused as vent_unauthorized with a key Vent does not know in 24 h, last at 2026-10-25T03:47Z");
  assert.equal(integrationMetrics({ lights, hosts: hosts(), spans: null, refusals: [] }, last).metrics.vent_key_refused_sources, 0);
  const unread = integrationMetrics({ lights, hosts: hosts(), spans: null, refusals: { error: "HTTP 502" } }, last);
  assert.equal(unread.metrics.vent_key_refused_sources, UNMEASURED);
  assert.equal(unread.metrics.source_errors, 1);
});
