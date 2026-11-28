import { writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import type { FlaggedSlice, PrecheckOutput } from "../../src/shared/chat-duties.ts";
import { type DsQuery, SOURCE_DEADLINE_MS, grafanaClient, readGrafanaAuth, sqlRows } from "./estate-reads.ts";

/**
 * The api portal vp chat's "Customer API failures" precheck (`node --import tsx scripts/duties/customer-api-failures.ts`). No model call,
 * reads only. It keeps board goal p80 met: from 10-13 to 10-26 about 31% of real customers' calls on api.virev.ai failed, and p80 drove the
 * customer prod 5xx share of the day to 0.67% on 10-31 and 0.32% on 11-01. The headline, customer_5xx_share_pct, is the 5xx answers out of
 * every customer call of the last full UTC day.
 * It reads prod ClickHouse through Grafana (estate_ch_prod, the grafana-read key in estate-reads.ts), the same rows the API portal alert,
 * board 52 and billing read. Until 11-26 it read PostHog's api_request events, and that HogQL query hit PostHog's max execution time on every
 * run from 11-21, so each metric read UNMEASURED.
 * A customer call is a keyed crawl_read row (the crawler's answer) or a keyed data_api_request row (a call the portal refused before the
 * crawler, or cut when its caller hung up or it timed out) in product.customer_usage_events, the view that leaves out every org of
 * auto-sns-agent convex/org/houseOrgs.json, less the org_test_ orgs a prod proof makes as paying customers. That is the alert's
 * api-portal-customer-calls-failing definition (apps/infra/metal/config/obs/grafana/alerting/api-portal.yaml).
 * One call is one request id (charge_id): a cut call has the crawler's row and the portal's, and the portal's row wins, because the crawler's
 * reads as its crawl went. Each 5xx comes back as a flagged slice with its operation, error code and request id.
 * The day line names the day's longest stretch with no keyed call row at all, from any org, as detail; PostHog missed 03:48 to 06:19Z on
 * 11-01 while prod Vent was down (p1257), and the same stretch in the ledger means rows went missing. It judges nothing.
 * slow_route_over_target_s keeps board goal p111 met (owner 10-30: "이거 왜 20초 30초나 걸리냐"): the most seconds any route's p90 gateway
 * duration of the day sits over that route's own target in ROUTE_P90_TARGET_S, so 0 or less is on target. Its answered calls are the
 * data_api_call charge rows Convex writes for each answered call, whose route is the operation id and whose duration_ms is the gateway's
 * own time. The crawler's crawl_read rows cannot tell Google Play from Google News, because both run through /api/crawl/fetch. It counts
 * every org, internal ones included, because no is_internal = 0 org called these routes from 10-20 to 11-02 and the owner's own calls come
 * from internal orgs. Only answered calls count in a route's p90, so a route that fails fast never reads fast.
 * A route with under MIN_ROUTE_CALLS answered calls in the day reads the p90 of its newest MIN_ROUTE_CALLS answered calls up to the day's
 * end instead (`RouteLatency.pool`): from 11-14 to 11-16 the three routes got 1 to 11 answered calls a day, so d4 wrote the placeholder for
 * three runs in a row and read error, while the newest 20 calls up to 11-16 00:00Z read Bing 9.20 s (back to 11-09), Play 1.03 s and News 0.96 s.
 * org_operation_jumps counts the (org, operation) pairs whose calls or 5xx answers on the day are over JUMP_TIMES times the pair's own
 * median of the 7 days before, at JUMP_FLOOR or more (owner, #1124-cost-management p52 and p54, 11-28: a PostHog sync cost up to $80 a day for 11
 * days because its duty judged only a total). It reads every org of product.usage_events, house orgs included, because our own callers cost
 * money too (org_virev_gtm_outreach ran 6,804 web-scraping calls on 11-26 from none), less org_test_ orgs and the one-run proof orgs whose id
 * ends in a 13-digit time, each of which would read as new. portal-jumps.replay.md holds the replay that picked the numbers.
 * Both day metrics name the next UTC midnight as their rollsAt, so the runner starts no push or verify run that would read the same day again.
 * Each day metric's lastEventAt is the newest call it counts, so a rerun of a day that closed before its fix went live reads quiet
 * (`MetricStreak.quietSince`) and owes no fix job: on 11-05 d4 read Bing's p90 22.59 s for 11-04, while Bing after the 01:53Z fix read p90 2.76 s.
 */

const CLICKHOUSE = "estate_ch_prod";
/** The "could not measure" value, the same one portal-uptime.ts prints, so a missing source can never look on target. */
export const UNMEASURED = 999999;
const DAY_MS = 86_400_000;
/**
 * Each slow route's p90 target in seconds, by its operation (apps/api-portal/src/lib/server/operations.ts): /v1/search/bing,
 * /v1/crawl/google/play-app and /v1/crawl/google/news. Play and News hold the 5 s of p111 (about 3 s on 11-25). Bing's decoys come from Bing's
 * side, and the crawler gives up on a Bing call at 20 s (auto-sns-agent 4940339b9), so its target tracks that give-up point: of 239 prod Bing
 * calls from 11-24 to 11-26, 4.2% of the 200s answered after 20 s, while a 10 s cut would have lost 11.8% (~/work/crawler-guy/bing-budget-1126).
 */
export const ROUTE_P90_TARGET_S = { "search.bing": 22, "crawl.google.play_app": 5, "crawl.google.news": 5 } as const satisfies Record<string, number>;
export type SlowRoute = keyof typeof ROUTE_P90_TARGET_S;
export const SLOW_ROUTES = Object.keys(ROUTE_P90_TARGET_S) as SlowRoute[];
/** The brief's floor for one route's p90: under 20 calls the p90 rests on the slowest one or two calls, so a quiet day reads its newest 20. */
export const MIN_ROUTE_CALLS = 20;

/**
 * A pair jumps when its day is over JUMP_TIMES times its median of the BASELINE_DAYS before. Replayed over 11-14 to 11-27 UTC: at 3, 5xx
 * answers flag 3Irto's crawl.fetch at 5.3 and 4.0 times and 3Ez44's search.google at 3.3 times on 11-21, and stay quiet on 3Ez44's daily
 * search.google 5xx, which read 0.7 to 2.5 times. Calls flag only from a median of 0, except one pair at 37.9 times, so 3 to 10 read the same.
 */
export const JUMP_TIMES = 3;
export const BASELINE_DAYS = 7;
/**
 * The least calls or 5xx answers a pair's day needs to count, so 0 to 1 is no jump. At 1000 calls the replay flags 6 of 14 days: the health
 * probe's 1,439 Instagram reads a day from 11-24, the websearch parity run's 4,699 Google searches on 11-25, the CRM web-scraping burst on 11-26
 * and 11-27 and two customers starting a new use on 11-16 and 11-17. At 500 it also flags 841 Instagram reads of one customer on 11-23. At
 * 20 5xx answers it flags 9 of 14 days: the 11-20 to 11-23 Instagram, crawl.fetch and YouTube shorts errors, the websearch run's 1,353 failed
 * searches on 11-25, the CRM's 628 failed scrapes on 11-27 and two new pairs with 26 and 22 on 11-17 and 11-24. At 50 it misses YouTube shorts'
 * 46 on 11-20. The 23 min GeoNode outage on 11-27 gave no pair more than 9 5xx answers, so the hourly alert api-portal-customer-calls-failing
 * holds that kind of failure, and this check does not.
 */
export const JUMP_FLOOR = { calls: 1000, failed5xx: 20 } as const;

/** The day's customer calls; `lastAt` is the newest one's epoch ms, absent with no call. */
export interface DayCounts { calls: number; failed5xx: number; lastAt?: number }
/** One operation's answered calls of the day, their p90 duration in ms (null with none), the newest one's epoch ms, and the day's 5xx
 *  answers, which count in no p90: on 11-10 to 11-12 every Bing call answered 503 in about 0.35 s while GeoNode was down. */
export interface RouteLatency { endpoint: string; calls: number; p90Ms: number | null; lastAt?: number; failed5xx?: number; pool?: RoutePool }
/** A route's newest MIN_ROUTE_CALLS answered calls up to the day's end, from whatever days they fall in; `since` is the oldest one's epoch ms. */
export interface RoutePool { calls: number; p90Ms: number | null; since: number }
/** One (org, operation) pair's calls and 5xx answers on one UTC day ("YYYY-MM-DD"). */
export interface PairDay { day: string; org: string; endpoint: string; calls: number; failed5xx: number }
export interface PairJump { org: string; endpoint: string; kind: "calls" | "failed5xx"; value: number; median: number }
export interface FailedCall { at: number; endpoint: string; status: number; errorCode: string; requestId: string; orgId: string }

/** The last full UTC day before `now`, as [start, end) "YYYY-MM-DD hh:mm:ss" UTC strings. */
export function lastFullDay(now: number): { start: string; end: string } {
  const end = Math.floor(now / DAY_MS) * DAY_MS;
  const iso = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");
  return { start: iso(end - DAY_MS), end: iso(end) };
}

const median = (values: readonly number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
};

/** The pairs that jump on `day` ("YYYY-MM-DD") against their own BASELINE_DAYS before, a day with no row counting 0, and how many pairs
 *  had a call in those days. */
export function pairJumps(rows: readonly PairDay[], day: string): { jumps: PairJump[]; pairs: number } {
  const dayMs = Date.parse(`${day}T00:00:00Z`);
  const before = Array.from({ length: BASELINE_DAYS }, (_, back) => new Date(dayMs - (back + 1) * DAY_MS).toISOString().slice(0, 10));
  const byPair = new Map<string, Map<string, PairDay>>();
  for (const row of rows) {
    const key = `${row.org}\u0000${row.endpoint}`;
    if (!byPair.has(key)) byPair.set(key, new Map());
    byPair.get(key)!.set(row.day, row);
  }
  const jumps: PairJump[] = [];
  let pairs = 0;
  for (const [key, days] of byPair) {
    if (![day, ...before].some(date => days.has(date))) continue;
    pairs += 1;
    const [org, endpoint] = key.split("\u0000") as [string, string];
    for (const kind of ["calls", "failed5xx"] as const) {
      const value = days.get(day)?.[kind] ?? 0;
      const typical = median(before.map(date => days.get(date)?.[kind] ?? 0));
      if (value >= JUMP_FLOOR[kind] && value > JUMP_TIMES * typical) jumps.push({ org, endpoint, kind, value, median: typical });
    }
  }
  return { jumps: jumps.sort((a, b) => b.value - a.value), pairs };
}

/** The answered calls a route's p90 rests on: the day's when it has MIN_ROUTE_CALLS of them, else its pool when that has. */
const basis = (row: RouteLatency | undefined): { calls: number; p90Ms: number | null; since?: number } | undefined =>
  !row ? undefined : row.calls >= MIN_ROUTE_CALLS ? row : row.pool && row.pool.calls >= MIN_ROUTE_CALLS ? row.pool : undefined;

const routeOverTarget = (rows: RouteLatency[], endpoint: SlowRoute): number => {
  const used = basis(rows.find(candidate => candidate.endpoint === endpoint));
  return !used || used.p90Ms === null ? UNMEASURED : Math.round((used.p90Ms - ROUTE_P90_TARGET_S[endpoint] * 1000) / 10) / 100;
};

/** The most seconds a route's p90 over answered calls sits over its own target; a route with under MIN_ROUTE_CALLS of them in the day and in
 *  its pool makes it UNMEASURED, so a route with no answers never passes. */
export const slowRouteOverTarget = (routes: RouteLatency[]): number => Math.max(...SLOW_ROUTES.map(endpoint => routeOverTarget(routes, endpoint)));

const latencyLine = (rows: RouteLatency[]): string => SLOW_ROUTES.map(endpoint => {
  const row = rows.find(candidate => candidate.endpoint === endpoint);
  const p90 = row?.p90Ms === null || row?.p90Ms === undefined ? "none" : `${Math.round(row.p90Ms / 10) / 100} s`;
  const pooled = row && row.calls < MIN_ROUTE_CALLS && row.pool && row.pool.p90Ms !== null
    ? ` (newest ${row.pool.calls} since ${new Date(row.pool.since).toISOString().slice(0, 16)}Z: p90 ${Math.round(row.pool.p90Ms / 10) / 100} s)` : "";
  return `${endpoint} ${row?.calls ?? 0} calls p90 ${p90}${pooled} against ${ROUTE_P90_TARGET_S[endpoint]} s${row?.failed5xx ? `, ${row.failed5xx} answered 5xx` : ""}`;
}).join(", ");

/** The precheck output with `n`, the calls each duty metric read (agent factory's sampleSize in apps/chat/scripts/duties/agent-boards.ts). */
export type FailuresOutput = PrecheckOutput & { n: Record<string, number> };

/** The day's metrics and one flagged slice per 5xx, grouped in the excerpt by operation and error code. */
export function report(counts: DayCounts, failed: FailedCall[], day: { start: string }, gapMin: number | null,
  latency: RouteLatency[], pairDays: readonly PairDay[] = []): FailuresOutput {
  const share = counts.calls > 0 ? Math.round((counts.failed5xx / counts.calls) * 10_000) / 100 : 0;
  const flagged: FlaggedSlice[] = failed.map(call => ({
    at: call.at,
    kind: `customer_5xx ${call.endpoint} ${call.status} ${call.errorCode}`,
    excerpt: `${call.endpoint} ${call.status} ${call.errorCode} ${call.requestId} (org ${call.orgId})`,
  }));
  flagged.unshift({ kind: "day", excerpt: `${day.start.slice(0, 10)} UTC: ${counts.failed5xx} customer 5xx of ${counts.calls} calls (${share}%${counts.calls ? "" : ", so the share read 0 calls and measured nothing"}); ` +
    `longest stretch with no keyed call row: ${gapMin === null ? "not read" : `${gapMin} min`}` });
  const slow = slowRouteOverTarget(latency);
  flagged.splice(1, 0, { kind: "slow_routes", excerpt: `most over its own p90 target, all orgs: ${slow === UNMEASURED ? `unknown, a route has under ${MIN_ROUTE_CALLS} answered calls` : `${slow} s`}; ` +
    latencyLine(latency) });
  const { jumps, pairs } = pairJumps(pairDays, day.start.slice(0, 10));
  flagged.push(...jumps.map(jump => ({ kind: `jump_${jump.kind} ${jump.endpoint}`,
    excerpt: `${jump.org} ${jump.endpoint}: ${jump.value} ${jump.kind === "calls" ? "calls" : "5xx answers"} on ${day.start.slice(0, 10)} UTC against a median ` +
      `of ${jump.median} a day over the ${BASELINE_DAYS} days before, over ${JUMP_TIMES} times and ${JUMP_FLOOR[jump.kind]} or more` })));
  if (!pairs) flagged.push({ kind: "no_pairs", excerpt: `No (org, operation) pair had a keyed call in the ${BASELINE_DAYS + 1} days to ${day.start.slice(0, 10)}, so org_operation_jumps read 0 pairs and measured nothing.` });
  const rollsAt = Date.parse(`${day.start.replace(" ", "T")}Z`) + 2 * DAY_MS;
  const routeLasts = latency.filter(row => (SLOW_ROUTES as string[]).includes(row.endpoint) && row.lastAt !== undefined).map(row => row.lastAt!);
  const lastEventAt = { ...counts.lastAt === undefined ? {} : { customer_5xx_share_pct: counts.lastAt },
    ...routeLasts.length ? { slow_route_over_target_s: Math.max(...routeLasts) } : {} };
  // The window each newest call waits to leave ends when the day rolls, so d9's aging time (`agingUntil`) is the next UTC midnight.
  const windowMs = Object.fromEntries(Object.entries(lastEventAt).map(([key, at]) => [key, rollsAt - at]));
  const routeCalls = slow === UNMEASURED ? 0 : SLOW_ROUTES.reduce((sum, endpoint) => sum + (basis(latency.find(row => row.endpoint === endpoint))?.calls ?? 0), 0);
  return { metrics: { customer_5xx_share_pct: share, slow_route_over_target_s: slow, org_operation_jumps: jumps.length, source_errors: 0 }, flagged,
    n: { customer_5xx_share_pct: counts.calls, slow_route_over_target_s: routeCalls, org_operation_jumps: pairs, source_errors: 1 },
    rollsAt: { customer_5xx_share_pct: rollsAt, slow_route_over_target_s: rollsAt, org_operation_jumps: rollsAt }, ...Object.keys(lastEventAt).length ? { lastEventAt, windowMs } : {} };
}

// ---- SQL ----

const at = (time: string) => `toDateTime64('${time}', 3, 'UTC')`;
const routeList = SLOW_ROUTES.map(endpoint => `'${endpoint}'`).join(", ");
/** One row per keyed call (crawl_read or data_api_request) in [start, end): its operation, final status, error code, org and time. The
 *  portal's own row wins over the crawler's, and a crawl_read row before the crawler names its operation reads its route as one
 *  (/api/live/search/bing as search.bing). */
const callsSql = (table: string, start: string, end: string, where = "") => `SELECT if(charge_id = '', event_id, charge_id) AS call,
 argMax(if(operation != '', operation, replaceAll(replaceRegexpOne(route, '^/api/(live/)?', ''), '/', '.')), (action = 'data_api_request', ts)) AS endpoint,
 argMax(http_status, (action = 'data_api_request', ts)) AS status, argMax(error_code, (action = 'data_api_request', ts)) AS error_code,
 any(org_id) AS org, max(ts) AS at
FROM ${table} WHERE ts >= ${at(start)} AND ts < ${at(end)} AND action IN ('crawl_read', 'data_api_request') AND api_key_id != ''${where}
GROUP BY call`;
const CUSTOMER = "product.customer_usage_events";
const NOT_PROOF = " AND NOT startsWith(org_id, 'org_test_')";
const NOT_ONE_RUN = `${NOT_PROOF} AND NOT match(org_id, '_[0-9]{13}$')`;
const shiftDays = (time: string, days: number) => new Date(Date.parse(`${time.replace(" ", "T")}Z`) - days * DAY_MS).toISOString().slice(0, 19).replace("T", " ");

export const daySql = (day: { start: string; end: string }) => `SELECT count() AS calls, countIf(status >= 500) AS failed5xx,
 toUnixTimestamp64Milli(max(at)) AS last_ms FROM (${callsSql(CUSTOMER, day.start, day.end, NOT_PROOF)})`;
export const failedSql = (day: { start: string; end: string }) => `SELECT toUnixTimestamp64Milli(at) AS at_ms, endpoint, status, error_code, call, org
FROM (${callsSql(CUSTOMER, day.start, day.end, NOT_PROOF)}) WHERE status >= 500 ORDER BY at`;
export const gapSql = (day: { start: string; end: string }) => `SELECT max(gap) AS gap_min FROM (SELECT dateDiff('minute',
 lagInFrame(ts, 1, ts) OVER (ORDER BY ts ROWS BETWEEN 1 PRECEDING AND CURRENT ROW), ts) AS gap FROM product.usage_events
 WHERE ts >= ${at(day.start)} AND ts < ${at(day.end)} AND action IN ('crawl_read', 'data_api_request') AND api_key_id != '')`;
/** Answered calls of the slow routes, every org: one Convex charge per request id (a multi-part charge has one row per unit kind). */
const answered = (where: string) => `SELECT charge_id, any(route) AS endpoint, max(duration_ms) AS ms, max(ts) AS at FROM product.usage_events
 WHERE action = 'data_api_call' AND kind = 'charge' AND http_status BETWEEN 200 AND 399 AND duration_ms > 0 AND route IN (${routeList}) AND ${where}
 GROUP BY charge_id`;
export const routesSql = (day: { start: string; end: string }) => `SELECT endpoint, count() AS calls, quantileExact(0.9)(ms) AS p90_ms,
 toUnixTimestamp64Milli(max(at)) AS last_ms FROM (${answered(`ts >= ${at(day.start)} AND ts < ${at(day.end)}`)}) GROUP BY endpoint`;
export const route5xxSql = (day: { start: string; end: string }) => `SELECT endpoint, count() AS failed5xx
 FROM (${callsSql("product.usage_events", day.start, day.end)}) WHERE status >= 500 AND endpoint IN (${routeList}) GROUP BY endpoint`;
export const poolSql = (day: { end: string }) => `SELECT endpoint, count() AS calls, quantileExact(0.9)(ms) AS p90_ms,
 toUnixTimestamp64Milli(min(at)) AS since_ms FROM (SELECT * FROM (${answered(`ts < ${at(day.end)}`)}) ORDER BY at DESC LIMIT ${MIN_ROUTE_CALLS} BY endpoint)
 GROUP BY endpoint`;

/** Every org's calls and 5xx answers per (org, operation) and UTC day, over the day and the BASELINE_DAYS before it. */
export const pairsSql = (day: { start: string; end: string }) => `SELECT toString(toDate(at)) AS day, org, endpoint, count() AS calls,
 countIf(status >= 500) AS failed5xx FROM (${callsSql("product.usage_events", shiftDays(day.start, BASELINE_DAYS), day.end, NOT_ONE_RUN)})
GROUP BY day, org, endpoint`;

// ---- I/O ----

const p90 = (value: unknown): number | null => value === null || value === undefined ? null : Number(value);

/** The day's report from one prod ClickHouse read per question. */
export async function read(query: DsQuery, now: number): Promise<FailuresOutput> {
  const day = lastFullDay(now);
  const sql = (text: string) => sqlRows(query, CLICKHOUSE, text);
  const [[totals], failedRows, gapRows, routeRows, fiveRows, poolRows, pairRows] = await Promise.all([
    sql(daySql(day)), sql(failedSql(day)), sql(gapSql(day)), sql(routesSql(day)), sql(route5xxSql(day)), sql(poolSql(day)), sql(pairsSql(day))]);
  const calls = Number(totals?.calls ?? 0);
  const failed: FailedCall[] = failedRows.map(row => ({ at: Number(row.at_ms), endpoint: String(row.endpoint), status: Number(row.status),
    errorCode: String(row.error_code ?? ""), requestId: String(row.call), orgId: String(row.org) }));
  const fives = new Map(fiveRows.map(row => [String(row.endpoint), Number(row.failed5xx)]));
  const pools = new Map(poolRows.map(row => [String(row.endpoint), { calls: Number(row.calls), p90Ms: p90(row.p90_ms), since: Number(row.since_ms) }]));
  const latency = SLOW_ROUTES.map((endpoint): RouteLatency => {
    const row = routeRows.find(candidate => String(candidate.endpoint) === endpoint);
    return { endpoint, calls: Number(row?.calls ?? 0), p90Ms: p90(row?.p90_ms), ...row ? { lastAt: Number(row.last_ms) } : {},
      ...fives.has(endpoint) ? { failed5xx: fives.get(endpoint)! } : {}, ...pools.has(endpoint) ? { pool: pools.get(endpoint)! } : {} };
  });
  const gap = gapRows[0]?.gap_min;
  return report({ calls, failed5xx: Number(totals?.failed5xx ?? 0), ...calls ? { lastAt: Number(totals!.last_ms) } : {} }, failed, day,
    gap === null || gap === undefined ? null : Number(gap), latency, pairRows.map(row => ({ day: String(row.day), org: String(row.org),
      endpoint: String(row.endpoint), calls: Number(row.calls), failed5xx: Number(row.failed5xx) })));
}

export async function measure(now: number): Promise<FailuresOutput> {
  try {
    return await read(grafanaClient(fetch, await readGrafanaAuth(), now, AbortSignal.timeout(SOURCE_DEADLINE_MS)), now);
  } catch (error) {
    return { metrics: { customer_5xx_share_pct: UNMEASURED, slow_route_over_target_s: UNMEASURED, org_operation_jumps: UNMEASURED, source_errors: 1 },
      n: { customer_5xx_share_pct: 0, slow_route_over_target_s: 0, org_operation_jumps: 0, source_errors: 0 },
      flagged: [{ kind: "source_error", excerpt: `prod ClickHouse read failed: ${error instanceof Error ? error.message : String(error)}` }] };
  }
}

async function main(): Promise<void> {
  const output = process.env.OUTPUT_FILE;
  if (!output) { process.stderr.write("customer-api-failures: OUTPUT_FILE is not set\n"); process.exit(2); }
  await writeFile(output, JSON.stringify(await measure(Date.now()), null, 2) + "\n");
}

if (process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url) await main();
