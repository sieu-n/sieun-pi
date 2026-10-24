// Guards the Vent integrations duty (vent-integrations.ts). On 2026-10-19 prod Vent ran a478d04d0afa while staging had run newer builds since
// 06:38Z, prod's console showed resend red on a 403, and google-search-console had 81 failed calls in 24 h; each has to read as a miss.
import assert from "node:assert/strict";
import { test } from "node:test";
import { behindHours, integrationMetrics, UNMEASURED, type IntegrationLight, type IntegrationReads } from "../scripts/duties/vent-integrations.ts";

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
  const { metrics, flagged } = integrationMetrics({ lights, hosts: hosts(), spans: null }, 0);
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
  const quiet = integrationMetrics({ lights: [light("b2", "grey", 0, 0)], hosts: hosts(), spans: null }, 0);
  assert.equal("vent_success_24h_pct" in quiet.metrics, false);
  assert.equal(quiet.flagged!.filter(flag => flag.kind === "gap").length, 1);
  const output = integrationMetrics({ lights: { error: "Grafana ds/query HTTP 401" }, hosts: hosts(), spans: null }, 0);
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
  const output = integrationMetrics({ lights: [], hosts: hosts("a478d04d0afa", "fd27624f5075"), spans }, now);
  assert.equal(output.flagged!.find(flag => flag.kind === "behind_staging")!.excerpt, "prod Vent runs a478d04d0afa and staging runs fd27624f5075; they differ since 2026-10-19T06:38Z");
  assert.equal(integrationMetrics({ lights: [], hosts: hosts("a478d04d0afa", "fd27624f5075"), spans: { error: "HTTP 400" } }, now).metrics.prod_vent_behind_staging_h, UNMEASURED);
});

test("a host that does not answer 200 counts as down, and with no version the lag reads unmeasured", () => {
  const down = { production: { url: "https://vent.virev.ai", status: 0, error: "TLS" }, staging: hosts().staging };
  const output = integrationMetrics({ lights: [], hosts: down, spans: null }, 0);
  assert.equal(output.metrics.vent_hosts_down, 1);
  assert.equal(output.metrics.prod_vent_behind_staging_h, UNMEASURED);
  assert.equal(output.flagged!.find(flag => flag.kind === "host_down")!.excerpt, "https://vent.virev.ai/healthz gave TLS");
});
