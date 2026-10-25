import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { FlaggedSlice, PrecheckOutput } from "../../src/shared/chat-duties.ts";

/**
 * The Vent chat's "Vent integrations" precheck (`node --import tsx scripts/duties/vent-integrations.ts`). No model call, no browser, no key value.
 * - vent_success_24h_pct, the headline, and red_integrations_prod come from the prod lights as the Vent console builds them: vent-health.py
 *   beside this file runs vent.health.read_health, the function behind GET /_vent/admin/health, from apps/vent/src at origin/staging against
 *   prod ClickHouse through Grafana. So a call counts the way the console and the vent-integration-health alert rules count it: success and
 *   failure only, without the caller's own 4xx, the Claude account cap, refused and cancelled calls.
 * - prod_vent_behind_staging_h: hours since staging Vent first ran another build than prod Vent. Both builds come from /healthz `version`, and
 *   the time from the service.version of Vent's own OTel rows: the later of when prod first logged its build and when staging last logged it.
 * - vent_hosts_down: how many of vent.virev.ai and vent-staging.virev.ai do not answer 200 on /healthz.
 * - vent_key_refused_sources: how many source addresses sent prod Vent a call with a key that it refused as vent_unauthorized in 24 h, any
 *   caller, read from otel.vent_calls by client.address. The console leaves refused calls out, so from 02:09Z on 10-25 the prod host services
 *   exporter on us-metal01 (64.34.205.243) got 401 on every Railway and Vercel call with a key Vent did not know, the Railway and Vercel
 *   panels froze, and this duty still read 100%. A keyless scanner gets the same refusal, and vent.key_present false leaves it out.
 * A source it cannot read gives a source_error flagged slice with its reason, counted in source_errors, and leaves each metric it feeds out of
 * the output (the 999999 placeholder for a count to drive down), so the duty runner reads it as not measured. A day with no counted call has no
 * success rate either, so vent_success_24h_pct is left out with a gap slice. Until 10-24 both wrote -1, which the runner judged as a miss.
 */

const REPO = process.env.LLM_WIKI_REPO || join(homedir(), "Documents/Github/auto-sns-agent");
export const UNMEASURED = 999999;
export const HOSTS = { production: "https://vent.virev.ai", staging: "https://vent-staging.virev.ai" } as const;
const GRAFANA = "https://obs.virev.ai";
const VENT_HEALTH = join(dirname(fileURLToPath(import.meta.url)), "vent-health.py");
/** The ref whose apps/vent/src the lights are built with: what staging runs, and what prod runs after the next promote. */
const HEALTH_REF = "origin/staging";
/** The duty report carries at most 3 items per metric (board skill check-ins.md, rule 4, owner 10-15). */
const ITEMS = 3;
const HOUR_MS = 3_600_000;

type LightName = "red" | "yellow" | "green" | "grey";
export interface IntegrationLight {
  name: string;
  light: LightName;
  reason: string;
  windows: { "24h": { success: number; failures: number } };
  topFailure24h: { kind: string | null; status: number | null; errorCode: string | null; count: number } | null;
}
export interface HostRead { url: string; status: number; version?: string; error?: string }
/** When one Vent tier logged a build first and last, from service.version on its OTel rows. */
export interface VersionSpan { env: string; first: number; last: number }
/** One source address whose keyed prod calls Vent refused as vent_unauthorized in 24 h, with the integrations its paths named. */
export interface KeyRefusal { source: string; calls: number; last: number; integrations: string[] }
type Failed = { error: string };
export interface IntegrationReads {
  lights: IntegrationLight[] | Failed;
  hosts: { production: HostRead; staging: HostRead };
  spans: VersionSpan[] | Failed | null;
  refusals: KeyRefusal[] | Failed;
}

const failed = <T extends object>(value: T | Failed): value is Failed => "error" in value && typeof (value as Failed).error === "string";
const round = (value: number, places: number) => Math.round(value * 10 ** places) / 10 ** places;
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 16) + "Z";

/** Hours since staging first ran another build than prod, 0 when they match, null when a read is missing. */
export function behindHours(hosts: IntegrationReads["hosts"], spans: VersionSpan[] | null, now: number): { hours: number; since?: number } | null {
  const prod = hosts.production.version;
  const staging = hosts.staging.version;
  if (!prod || !staging) return null;
  if (prod === staging) return { hours: 0 };
  const prodFirst = spans?.find(span => span.env === "production")?.first;
  if (prodFirst === undefined) return null;
  const since = Math.max(prodFirst, spans?.find(span => span.env === "staging")?.last ?? 0);
  return { hours: round(Math.max(0, now - since) / HOUR_MS, 1), since };
}

export function integrationMetrics(reads: IntegrationReads, at: number): PrecheckOutput {
  const flagged: FlaggedSlice[] = [];
  const metrics: Record<string, number> = {};
  let sourceErrors = 0;
  const sourceError = (excerpt: string) => { sourceErrors++; flagged.push({ at, kind: "source_error", excerpt: excerpt.slice(0, 300) }); };

  if (failed(reads.lights)) {
    sourceError(`prod integration lights could not be built: ${reads.lights.error}`);
    metrics.red_integrations_prod = UNMEASURED;
  } else {
    const lights = reads.lights;
    const counted = (light: IntegrationLight) => light.windows["24h"].success + light.windows["24h"].failures;
    const ok = lights.reduce((sum, light) => sum + light.windows["24h"].success, 0);
    const total = lights.reduce((sum, light) => sum + counted(light), 0);
    metrics.vent_counted_calls_24h = total;
    metrics.vent_failed_calls_24h = total - ok;
    if (total) metrics.vent_success_24h_pct = round(100 * ok / total, 2);
    else flagged.push({ at, kind: "gap", excerpt: "prod Vent logged no counted outbound call in 24 h, so there is no success rate to read" });
    const failing = lights.filter(light => light.windows["24h"].failures > 0).sort((a, b) => b.windows["24h"].failures - a.windows["24h"].failures);
    for (const light of failing.slice(0, ITEMS)) {
      const top = light.topFailure24h;
      const mostly = top ? `, mostly ${[top.kind, top.status && `HTTP ${top.status}`, top.errorCode].filter(Boolean).join(" ")} (${top.count})` : "";
      flagged.push({ at, kind: "call_failed", item: light.name, excerpt: `${light.name}: ${light.windows["24h"].failures} of ${counted(light)} counted prod calls failed in 24 h${mostly}`.slice(0, 300) });
    }
    const red = lights.filter(light => light.light === "red");
    metrics.red_integrations_prod = red.length;
    metrics.yellow_integrations_prod = lights.filter(light => light.light === "yellow").length;
    for (const light of red.slice(0, ITEMS)) flagged.push({ at, kind: "red_light", item: light.name, excerpt: `${light.name} is red on the prod Vent console: ${light.reason}`.slice(0, 300) });
  }

  const hosts = [reads.hosts.production, reads.hosts.staging];
  metrics.vent_hosts_down = hosts.filter(host => host.status !== 200).length;
  for (const host of hosts) if (host.status !== 200) flagged.push({ at, kind: "host_down", item: host.url, excerpt: `${host.url}/healthz gave ${host.error ?? `HTTP ${host.status}`}`.slice(0, 300) });

  if (failed(reads.refusals)) {
    sourceError(`refused prod Vent calls could not be read from ClickHouse: ${reads.refusals.error}`);
    metrics.vent_key_refused_sources = UNMEASURED;
  } else {
    const refusals = [...reads.refusals].sort((a, b) => b.calls - a.calls);
    metrics.vent_key_refused_sources = refusals.length;
    for (const refusal of refusals.slice(0, ITEMS)) {
      const named = refusal.integrations.length ? ` for ${refusal.integrations.join(", ")}` : "";
      flagged.push({ at, kind: "key_refused", item: refusal.source, excerpt: `${refusal.source}: ${refusal.calls} prod Vent calls${named} refused as vent_unauthorized with a key Vent does not know in 24 h, last at ${iso(refusal.last)}`.slice(0, 300) });
    }
  }

  if (reads.spans && failed(reads.spans)) sourceError(`Vent build history could not be read from ClickHouse: ${reads.spans.error}`);
  const behind = behindHours(reads.hosts, reads.spans && !failed(reads.spans) ? reads.spans : null, at);
  const { production, staging } = reads.hosts;
  if (!behind) {
    if (!reads.spans || !failed(reads.spans)) sourceError(`no build to compare: prod /healthz version ${production.version ?? "unread"}, staging ${staging.version ?? "unread"}, or no OTel row for prod's build`);
    metrics.prod_vent_behind_staging_h = UNMEASURED;
  } else {
    metrics.prod_vent_behind_staging_h = behind.hours;
    if (behind.since !== undefined) {
      flagged.push({ at, kind: "behind_staging", item: production.version ?? "", excerpt: `prod Vent runs ${production.version} and staging runs ${staging.version}; they differ since ${iso(behind.since)}` });
    }
  }
  metrics.source_errors = sourceErrors;
  return { metrics, flagged };
}

const run = (file: string, args: string[], options: { env?: NodeJS.ProcessEnv } = {}) => new Promise<string>((resolve, reject) => {
  execFile(file, args, { cwd: REPO, env: options.env ?? process.env, encoding: "utf8", maxBuffer: 64 << 20 },
    (error, stdout, stderr) => error ? reject(new Error(`${file} ${args.slice(0, 2).join(" ")}: ${String(stderr).trim().split("\n").slice(-2).join(" ").slice(-200) || error.message}`)) : resolve(stdout));
});
const errorText = (error: unknown) => {
  if (!(error instanceof Error)) return String(error);
  const code = (error.cause as { code?: string } | undefined)?.code;
  return code ? `${error.message} (${code})` : error.message;
};

async function grafanaToken(): Promise<string> {
  if (process.env.GRAFANA_AGENT_TOKEN) return process.env.GRAFANA_AGENT_TOKEN;
  const token = (await new Promise<string>((resolve, reject) => execFile("npx", ["--no-install", "dotenvx", "get", "GRAFANA_AGENT_TOKEN", "-f", ".env"],
    { cwd: join(REPO, "apps/infra"), encoding: "utf8" }, (error, stdout) => error ? reject(error) : resolve(stdout)))).trim();
  if (!token) throw new Error("GRAFANA_AGENT_TOKEN missing in apps/infra/.env");
  return token;
}

async function host(url: string): Promise<HostRead> {
  try {
    const response = await fetch(`${url}/healthz`);
    const body = await response.json().catch(() => null) as { version?: unknown } | null;
    return { url, status: response.status, ...(typeof body?.version === "string" ? { version: body.version } : {}) };
  } catch (error) { return { url, status: 0, error: errorText(error) }; }
}

/** The prod lights, built by vent.health from apps/vent/src at HEALTH_REF with the checkout's apps/vent python. */
async function lights(token: string, dir: string): Promise<IntegrationLight[]> {
  const tar = join(dir, "vent-src.tar");
  await run("git", ["fetch", "--quiet", "origin", "staging"]);
  await run("git", ["archive", "--output", tar, HEALTH_REF, "apps/vent/src"]);
  await run("tar", ["-xf", tar, "-C", dir]);
  const stdout = await run(join(REPO, "apps/vent/.venv/bin/python"), [VENT_HEALTH, "production", GRAFANA], {
    env: { ...process.env, GRAFANA_AGENT_TOKEN: token, PYTHONPATH: join(dir, "apps/vent/src") },
  });
  return (JSON.parse(stdout) as { integrations: IntegrationLight[] }).integrations;
}

/** One ClickHouse query through Grafana, as a column reader and its row count. */
async function clickhouse(token: string, sql: string): Promise<{ rows: number; column: (name: string) => unknown[] }> {
  const response = await fetch(`${GRAFANA}/api/ds/query`, {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ queries: [{ refId: "A", datasource: { uid: "grafana_clickhouse" }, rawSql: sql, format: 1, queryType: "table" }], from: "now-1h", to: "now" }),
  });
  const body = await response.json().catch(() => null) as { results?: { A?: { frames?: { schema: { fields: { name: string }[] }; data: { values: unknown[][] } }[]; error?: string } } } | null;
  const result = body?.results?.A;
  if (!response.ok || !result || result.error) throw new Error(`HTTP ${response.status}: ${String(result?.error ?? "no result").slice(0, 160)}`);
  const frame = result.frames?.[0];
  if (!frame) return { rows: 0, column: () => [] };
  const names = frame.schema.fields.map(field => field.name);
  const column = (name: string) => frame.data.values[names.indexOf(name)] ?? [];
  return { rows: frame.data.values[0]?.length ?? 0, column };
}

/** When each tier first and last logged a call on prod's build. otel.vent_calls holds only Vent's call rows: the same scan of otel.otel_logs took 26 to 60 s and hit Grafana's deadline on 10-24, this one 0.4 to 2.3 s. */
async function spans(token: string, version: string): Promise<VersionSpan[]> {
  if (!/^[\w.-]+$/.test(version)) throw new Error(`prod /healthz version ${JSON.stringify(version).slice(0, 40)} is not a build id`);
  const sql = "SELECT ResourceAttributes['deployment.environment.name'] AS env, toFloat64(toUnixTimestamp64Milli(min(Timestamp))) AS first, " +
    "toFloat64(toUnixTimestamp64Milli(max(Timestamp))) AS last FROM otel.vent_calls " +
    `WHERE ResourceAttributes['service.version'] = '${version}' GROUP BY env`;
  const { rows, column } = await clickhouse(token, sql);
  return Array.from({ length: rows }, (_, index) => ({ env: String(column("env")[index]), first: Number(column("first")[index]), last: Number(column("last")[index]) }));
}

/** Prod calls Vent refused as vent_unauthorized in 24 h that carried a key, per source address, from the columns telemetry.py writes on a refusal. */
async function keyRefusals(token: string): Promise<KeyRefusal[]> {
  const sql = "SELECT `client.address` AS source, toFloat64(sum(greatest(toUInt64OrZero(`vent.count`), 1))) AS calls, " +
    "toFloat64(toUnixTimestamp64Milli(max(Timestamp))) AS last, arrayStringConcat(arraySort(groupUniqArrayIf(`vent.requested_integration`, `vent.requested_integration` != '')), ',') AS integrations " +
    "FROM otel.vent_calls WHERE ResourceAttributes['deployment.environment.name'] = 'production' AND Timestamp > now() - INTERVAL 24 HOUR " +
    "AND `vent.outcome` = 'refused' AND `vent.error_code` = 'vent_unauthorized' AND `vent.key_present` = 'true' GROUP BY source";
  const { rows, column } = await clickhouse(token, sql);
  return Array.from({ length: rows }, (_, index) => ({
    source: String(column("source")[index]) || "no address", calls: Number(column("calls")[index]), last: Number(column("last")[index]),
    integrations: String(column("integrations")[index] ?? "").split(",").filter(Boolean),
  }));
}

async function main(): Promise<void> {
  const output = process.env.OUTPUT_FILE;
  if (!output) { process.stderr.write("vent-integrations: OUTPUT_FILE is not set\n"); process.exit(2); }
  const at = Date.now();
  const dir = await mkdtemp(join(tmpdir(), "vent-integrations-"));
  try {
    const token = await grafanaToken().catch((error: unknown) => ({ error: errorText(error) }));
    const hostsRead = Promise.all([host(HOSTS.production), host(HOSTS.staging)]).then(([production, staging]) => ({ production, staging }));
    const spansRead = hostsRead.then(({ production, staging }) => {
      if (typeof token !== "string") return token;
      if (!production.version || !staging.version || production.version === staging.version) return null;
      return spans(token, production.version).catch((error: unknown) => ({ error: errorText(error) }));
    });
    const [lightsRead, hosts, history, refusals] = await Promise.all([
      typeof token === "string" ? lights(token, dir).catch((error: unknown) => ({ error: errorText(error) })) : Promise.resolve(token),
      hostsRead,
      spansRead,
      typeof token === "string" ? keyRefusals(token).catch((error: unknown) => ({ error: errorText(error) })) : Promise.resolve(token),
    ]);
    await writeFile(output, JSON.stringify(integrationMetrics({ lights: lightsRead, hosts, spans: history, refusals }, at), null, 2) + "\n");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
