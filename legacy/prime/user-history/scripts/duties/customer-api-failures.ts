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
 */

const REPO = process.env.LLM_WIKI_REPO || join(homedir(), "Documents/Github/auto-sns-agent");
const POSTHOG_QUERY = "https://us.posthog.com/api/projects/354457/query/";
const CUSTOMER_ORGS = "select org_id from api_portal_orgs where is_internal = 0";
/** The "could not measure" value, the same one portal-uptime.ts prints, so a missing source can never look on target. */
export const UNMEASURED = 999999;
const DAY_MS = 86_400_000;

export interface DayCounts { completed: number; failed: number; failed5xx: number }
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

/** The day's metrics and one flagged slice per 5xx, grouped in the excerpt by operation and error code. */
export function report(counts: DayCounts, failed: FailedCall[], day: { start: string }, gapMin: number | null): PrecheckOutput {
  const attempts = counts.completed + counts.failed;
  const share = attempts > 0 ? Math.round((counts.failed5xx / attempts) * 10_000) / 100 : 0;
  const flagged: FlaggedSlice[] = failed.map(call => ({
    at: Date.parse(call.at),
    kind: `customer_5xx ${call.endpoint} ${call.status} ${call.errorCode}`,
    excerpt: `${call.endpoint} ${call.status} ${call.errorCode}${call.handle ? ` @${call.handle}` : ""} ${call.requestId} (org ${call.orgId})`,
  }));
  flagged.unshift({ kind: "day", excerpt: `${day.start.slice(0, 10)} UTC: ${counts.failed5xx} customer 5xx of ${attempts} attempts (${share}%); ` +
    `longest stretch with no api_request event: ${gapMin === null ? "not read" : `${gapMin} min`}` });
  return { metrics: { customer_5xx_share_pct: share, source_errors: 0 }, flagged };
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
    const [[completed, failed, failed5xx]] = (await hog(key, `select countIf(event = 'api_request_completed'), countIf(event = 'api_request_failed'), ` +
      `countIf(event = 'api_request_failed' and toInt(properties.status) >= 500) from events where ${calls} and ${window} ` +
      `and properties.orgId in (${CUSTOMER_ORGS})`)) as number[][];
    const rows = await hog(key, `select timestamp, properties.endpoint, toInt(properties.status), properties.errorCode, properties.crawlerPath, ` +
      `properties.requestId, properties.orgId from events where event = 'api_request_failed' and toInt(properties.status) >= 500 and ${window} ` +
      `and properties.orgId in (${CUSTOMER_ORGS}) order by timestamp`);
    const gap = await hog(key, `select max(gap) from (select dateDiff('minute', lagInFrame(timestamp, 1, timestamp) over (order by timestamp rows between 1 preceding and current row), timestamp) as gap ` +
      `from events where ${calls} and ${window})`).catch(() => [[null]]);
    const failedCalls = rows.map(([at, endpoint, status, errorCode, path, requestId, orgId]) => ({
      at: String(at), endpoint: String(endpoint), status: Number(status), errorCode: String(errorCode ?? ""), handle: handleOf(path as string | null),
      requestId: String(requestId ?? ""), orgId: String(orgId ?? ""),
    }));
    const gapMin = gap[0]?.[0] === null || gap[0]?.[0] === undefined ? null : Number(gap[0][0]);
    return report({ completed: Number(completed), failed: Number(failed), failed5xx: Number(failed5xx) }, failedCalls, day, gapMin);
  } catch (error) {
    return { metrics: { customer_5xx_share_pct: UNMEASURED, source_errors: 1 },
      flagged: [{ kind: "source_error", excerpt: `PostHog read failed: ${error instanceof Error ? error.message : String(error)}` }] };
  }
}

async function main(): Promise<void> {
  const output = process.env.OUTPUT_FILE;
  if (!output) { process.stderr.write("customer-api-failures: OUTPUT_FILE is not set\n"); process.exit(2); }
  await writeFile(output, JSON.stringify(await measure(Date.now()), null, 2) + "\n");
}

if (process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url) await main();
