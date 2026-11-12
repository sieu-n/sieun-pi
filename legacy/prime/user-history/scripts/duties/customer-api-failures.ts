import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { FlaggedSlice, PrecheckOutput } from "../../src/shared/chat-duties.ts";

/**
 * The api portal vp chat's "Customer API failures" precheck (`node --import tsx scripts/duties/customer-api-failures.ts`). No model call,
 * reads only. It keeps board goal p80 met: from 10-13 to 10-26 about 31% of real customers' calls on api.virev.ai failed, and p80 drove the
 * customer prod 5xx share of the day to 0.67% on 10-31 and 0.32% on 11-01. The headline, customer_5xx_share_pct, is the 5xx answers out of
 * every answered call (PostHog api_request_completed plus api_request_failed) of the last full UTC day, for the orgs PostHog's api_portal_orgs
 * marks is_internal = 0. Each 5xx comes back as a flagged slice with its operation, error code, handle and request id, so a miss starts with
 * the calls themselves. The key is apps/vent's POSTHOG_PERSONAL_API_KEY (query:read only), read through dotenvx in the auto-sns-agent checkout.
 * PostHog missed every event from 03:48 to 06:19Z on 11-01 while prod Vent was down (p1257), so the run also names the day's longest stretch
 * with no api_request event at all as detail; it judges nothing, and a reader checks Vercel's request logs for that stretch.
 * Each count and each 5xx row is by event uuid, because PostHog stored one event twice on 11-09 (req_cd46890275732bd3e299db679e4774ee at
 * 07:45:13Z and 07:46:53Z), 25 such rows in 14 days of 147,178 api_request events.
 * Only answered calls count in a route's p90, so a route that fails fast reads unknown and never on target.
 * slow_route_p90_s keeps board goal p111 met (owner 10-30: "이거 왜 20초 30초나 걸리냐"): the slowest p90 durationMs of the day's calls to
 * SLOW_ROUTES by every org, internal ones included, because no is_internal = 0 org called them from 10-20 to 11-02 and the owner's own calls come
 * from internal orgs; 3.30 s after crawler p1381 at 20:36Z on 11-02 against 5 s, while Bing's p90 over all orgs read 30.7 s from 00:00 to 20:42Z that day.
 * Both day metrics name the next UTC midnight as their rollsAt, so the runner starts no push or verify run that would read the same day again.
 * Each day metric's lastEventAt is the newest call it counts, so a rerun of a day that closed before its fix went live reads quiet
 * (`MetricStreak.quietSince`) and owes no fix job: on 11-05 d4 read slow_route_p90_s 22.59 s for 11-04, while Bing after the 01:53Z fix read p90 2.76 s.
 */

const REPO = process.env.LLM_WIKI_REPO || join(homedir(), "Documents/Github/auto-sns-agent");
const POSTHOG_QUERY = "https://us.posthog.com/api/projects/354457/query/";
const CUSTOMER_ORGS = "select org_id from api_portal_orgs where is_internal = 0";
/** The "could not measure" value, the same one portal-uptime.ts prints, so a missing source can never look on target. */
export const UNMEASURED = 999999;
const DAY_MS = 86_400_000;
/** The operations of /v1/search/bing, /v1/crawl/google/play-app and /v1/crawl/google/news (apps/api-portal/src/lib/server/operations.ts). */
export const SLOW_ROUTES = ["search.bing", "crawl.google.play_app", "crawl.google.news"] as const;
/** The brief's floor for one route's p90: under 20 calls the p90 rests on the day's slowest one or two calls, so it reads as unknown. */
export const MIN_ROUTE_CALLS = 20;

/** The day's customer calls; `lastAt` is the newest one's epoch ms, absent with no call. */
export interface DayCounts { completed: number; failed: number; failed5xx: number; lastAt?: number }
/** One operation's answered calls of the day (api_request_completed), their p90 durationMs (null with none), the newest one's epoch ms,
 *  and the day's 5xx answers, which count in no p90: on 11-10 to 11-12 every Bing call answered 503 in about 0.35 s while GeoNode was down. */
export interface RouteLatency { endpoint: string; calls: number; p90Ms: number | null; lastAt?: number; failed5xx?: number }
export interface FailedCall { at: string; endpoint: string; status: number; errorCode: string; handle: string | null; requestId: string; orgId: string }

/** The last full UTC day before `now`, as [start, end) ISO strings without the zone, the form HogQL's toDateTime reads. */
export function lastFullDay(now: number): { start: string; end: string } {
  const end = Math.floor(now / DAY_MS) * DAY_MS;
  const iso = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");
  return { start: iso(end - DAY_MS), end: iso(end) };
}

/** The handle a crawler path names, or null. */
export const handleOf = (crawlerPath: string | null | undefined): string | null =>
  /[?&]handle=([^&]+)/.exec(crawlerPath ?? "")?.[1] ?? null;

const routeP90 = (rows: RouteLatency[], endpoint: string): number => {
  const row = rows.find(candidate => candidate.endpoint === endpoint);
  return !row || row.calls < MIN_ROUTE_CALLS || row.p90Ms === null ? UNMEASURED : Math.round(row.p90Ms / 10) / 100;
};

/** The slowest p90 of SLOW_ROUTES in seconds over answered calls; a route under MIN_ROUTE_CALLS of them makes it UNMEASURED, so a quiet
 *  or a failing route never passes. */
export const slowRouteP90 = (routes: RouteLatency[]): number => Math.max(...SLOW_ROUTES.map(endpoint => routeP90(routes, endpoint)));

const latencyLine = (rows: RouteLatency[]): string => SLOW_ROUTES.map(endpoint => {
  const row = rows.find(candidate => candidate.endpoint === endpoint);
  const p90 = row?.p90Ms === null || row?.p90Ms === undefined ? "none" : `${Math.round(row.p90Ms / 10) / 100} s`;
  return `${endpoint} ${row?.calls ?? 0} calls p90 ${p90}${row?.failed5xx ? `, ${row.failed5xx} answered 5xx` : ""}`;
}).join(", ");

/** The day's metrics and one flagged slice per 5xx, grouped in the excerpt by operation and error code. */
export function report(counts: DayCounts, failed: FailedCall[], day: { start: string }, gapMin: number | null,
  latency: RouteLatency[]): PrecheckOutput {
  const attempts = counts.completed + counts.failed;
  const share = attempts > 0 ? Math.round((counts.failed5xx / attempts) * 10_000) / 100 : 0;
  const flagged: FlaggedSlice[] = failed.map(call => ({
    at: Date.parse(call.at),
    kind: `customer_5xx ${call.endpoint} ${call.status} ${call.errorCode}`,
    excerpt: `${call.endpoint} ${call.status} ${call.errorCode}${call.handle ? ` @${call.handle}` : ""} ${call.requestId} (org ${call.orgId})`,
  }));
  flagged.unshift({ kind: "day", excerpt: `${day.start.slice(0, 10)} UTC: ${counts.failed5xx} customer 5xx of ${attempts} attempts (${share}%); ` +
    `longest stretch with no api_request event: ${gapMin === null ? "not read" : `${gapMin} min`}` });
  const slow = slowRouteP90(latency);
  flagged.splice(1, 0, { kind: "slow_routes", excerpt: `slowest p90, all orgs: ${slow === UNMEASURED ? `unknown, a route has under ${MIN_ROUTE_CALLS} calls` : `${slow} s`}; ` +
    latencyLine(latency) });
  const rollsAt = Date.parse(`${day.start.replace(" ", "T")}Z`) + 2 * DAY_MS;
  const routeLasts = latency.filter(row => (SLOW_ROUTES as readonly string[]).includes(row.endpoint) && row.lastAt !== undefined).map(row => row.lastAt!);
  const lastEventAt = { ...counts.lastAt === undefined ? {} : { customer_5xx_share_pct: counts.lastAt },
    ...routeLasts.length ? { slow_route_p90_s: Math.max(...routeLasts) } : {} };
  // The window each newest call waits to leave ends when the day rolls, so d9's aging time (`agingUntil`) is the next UTC midnight.
  const windowMs = Object.fromEntries(Object.entries(lastEventAt).map(([key, at]) => [key, rollsAt - at]));
  return { metrics: { customer_5xx_share_pct: share, slow_route_p90_s: slow, source_errors: 0 }, flagged,
    rollsAt: { customer_5xx_share_pct: rollsAt, slow_route_p90_s: rollsAt }, ...Object.keys(lastEventAt).length ? { lastEventAt, windowMs } : {} };
}

// ---- I/O ----

const sh = (command: string, cwd: string) => new Promise<string>((resolve, reject) => {
  execFile("/bin/sh", ["-c", command], { cwd, encoding: "utf8" }, (error, stdout, stderr) =>
    error ? reject(new Error(`${error.message.split("\n")[0]} ${String(stderr).trim().slice(-200)}`)) : resolve(stdout));
});

async function hog(key: string, query: string): Promise<unknown[][]> {
  const response = await fetch(POSTHOG_QUERY, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ query: { kind: "HogQLQuery", query }, refresh: "blocking" }),
  });
  if (!response.ok) throw new Error(`PostHog query answered ${response.status}: ${(await response.text()).slice(0, 200)}`);
  return ((await response.json()) as { results: unknown[][] }).results;
}

export async function measure(now: number): Promise<PrecheckOutput> {
  const day = lastFullDay(now);
  const window = `timestamp >= toDateTime('${day.start}') and timestamp < toDateTime('${day.end}')`;
  const calls = "event in ('api_request_completed', 'api_request_failed')";
  try {
    const key = (await sh("node_modules/.bin/dotenvx get POSTHOG_PERSONAL_API_KEY -f apps/vent/.env", REPO)).trim().split("\n").at(-1)!.trim();
    const [[completed, failed, failed5xx, lastCall]] = (await hog(key, `select uniqIf(uuid, event = 'api_request_completed'), uniqIf(uuid, event = 'api_request_failed'), ` +
      `uniqIf(uuid, event = 'api_request_failed' and toInt(properties.status) >= 500), max(timestamp) from events where ${calls} and ${window} ` +
      `and properties.orgId in (${CUSTOMER_ORGS})`)) as [[number, number, number, unknown]];
    // HogQL's max over no rows is the epoch, so a time before the day reads as no call.
    const inDay = (at: unknown): { lastAt?: number } => {
      const ms = Date.parse(String(at));
      return ms >= Date.parse(`${day.start.replace(" ", "T")}Z`) ? { lastAt: ms } : {};
    };
    const rows = await hog(key, `select timestamp, properties.endpoint, toInt(properties.status), properties.errorCode, properties.crawlerPath, ` +
      `properties.requestId, properties.orgId from events where event = 'api_request_failed' and toInt(properties.status) >= 500 and ${window} ` +
      `and properties.orgId in (${CUSTOMER_ORGS}) order by timestamp limit 1 by uuid`);
    const gap = await hog(key, `select max(gap) from (select dateDiff('minute', lagInFrame(timestamp, 1, timestamp) over (order by timestamp rows between 1 preceding and current row), timestamp) as gap ` +
      `from events where ${calls} and ${window})`).catch(() => [[null]]);
    const failedCalls = rows.map(([at, endpoint, status, errorCode, path, requestId, orgId]) => ({
      at: String(at), endpoint: String(endpoint), status: Number(status), errorCode: String(errorCode ?? ""), handle: handleOf(path as string | null),
      requestId: String(requestId ?? ""), orgId: String(orgId ?? ""),
    }));
    // HogQL has no quantileExactIf, and quantileExact skips nulls.
    const answered = "event = 'api_request_completed'";
    const durations = `select properties.endpoint, countIf(${answered}), quantileExact(0.9)(if(${answered}, toFloat(properties.durationMs), null)), ` +
      `maxIf(timestamp, ${answered}), countIf(event = 'api_request_failed' and toInt(properties.status) >= 500) from events where ${calls} and ${window} ` +
      `and properties.endpoint in (${SLOW_ROUTES.map(endpoint => `'${endpoint}'`).join(", ")}) and properties.durationMs is not null`;
    const latencyRows = (rows: unknown[][]): RouteLatency[] => rows.map(([endpoint, count, p90, last, failed5xx]) =>
      ({ endpoint: String(endpoint), calls: Number(count), p90Ms: p90 === null || p90 === undefined ? null : Number(p90), ...inDay(last),
        failed5xx: Number(failed5xx ?? 0) }));
    const latency = latencyRows(await hog(key, `${durations} group by 1`));
    const gapMin = gap[0]?.[0] === null || gap[0]?.[0] === undefined ? null : Number(gap[0][0]);
    return report({ completed: Number(completed), failed: Number(failed), failed5xx: Number(failed5xx), ...inDay(lastCall) }, failedCalls, day, gapMin, latency);
  } catch (error) {
    return { metrics: { customer_5xx_share_pct: UNMEASURED, slow_route_p90_s: UNMEASURED, source_errors: 1 },
      flagged: [{ kind: "source_error", excerpt: `PostHog read failed: ${error instanceof Error ? error.message : String(error)}` }] };
  }
}

async function main(): Promise<void> {
  const output = process.env.OUTPUT_FILE;
  if (!output) { process.stderr.write("customer-api-failures: OUTPUT_FILE is not set\n"); process.exit(2); }
  await writeFile(output, JSON.stringify(await measure(Date.now()), null, 2) + "\n");
}

if (process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url) await main();
