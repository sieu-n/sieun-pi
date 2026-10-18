import { readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import type { FlaggedSlice, PrecheckOutput } from "../../src/shared/chat-duties.ts";

/**
 * The precheck of the Pinterest index chat's duty "Wiki box and crawler" (`node --import tsx scripts/duties/pinterest-index-risks.ts`).
 * It checks each risk on the wiki risk page projects/pinterest-index-gaps/risks: wiki_disk_days is the days until us-metal02's root disk
 * is full at the last 24 h rate, read from the box Prometheus through Grafana ds/query, and pinterest_429_24h counts the prod crawler's
 * Pinterest reads that failed with a 429 in 24 h, from prod ClickHouse over ssh. risks_firing counts the risks past their line.
 * The duty file's timeoutMs of 90 s covers the 30 s Grafana call and the 60 s ssh call below, as in vps-boxes.duty.json.
 * The owner, 10-18: standing risks live on a risk page that a duty checks, not on the plan. A new risk on the page gets its check here.
 */

export const RISK_PAGE = "projects/pinterest-index-gaps/risks";
const GRAFANA_CONFIG = join(homedir(), ".prime/agent/browser-chat/grafana-alerts.json");
const PROMETHEUS = { uid: "estate_prometheus_stg", type: "prometheus" };
const ROOT = 'node_filesystem_avail_bytes{box="us-metal02",mountpoint="/"}';
export const DISK_DAYS_QUERY = `${ROOT} / clamp_min(-deriv(${ROOT}[24h]) * 86400, 1)`;
export const DISK_DAYS_MIN = 30;
const PROD_SSH = "root@64.34.205.243";
const CLICKHOUSE = `docker exec -i virev-prod-clickhouse sh -c 'clickhouse-client --user "$CLICKHOUSE_USER" --password "$CLICKHOUSE_PASSWORD" --format JSONEachRow'`;
const PINTEREST_LINE = "ServiceName = 'crawler-v3' AND ResourceAttributes['deployment.environment.name'] = 'production'" +
  " AND (hasToken(lower(Body), 'pinterest') OR hasToken(lower(Body), 'pinimg')) AND position(Body, 'crawl attempt failed') > 0";
export const PINTEREST_SQL = `SELECT
 (SELECT sum(attempts) FROM crawler.proxy_wire_reads WHERE observed_at > now() - INTERVAL 24 HOUR AND operation IN ('pinterest', 'pinimg')) AS reads,
 (SELECT count() FROM otel.otel_logs WHERE Timestamp > now() - INTERVAL 24 HOUR AND ${PINTEREST_LINE}
   AND (position(Body, 'status=429') > 0 OR positionCaseInsensitive(Body, 'ratelimit') > 0)) AS rate_limited`;

async function diskDays(): Promise<number> {
  const config = JSON.parse(await readFile(GRAFANA_CONFIG, "utf8")) as { url: string; token: string };
  const now = Date.now();
  const response = await fetch(new URL("/api/ds/query", config.url), {
    method: "POST", headers: { authorization: `Bearer ${config.token}`, "content-type": "application/json" },
    body: JSON.stringify({ queries: [{ refId: "A", datasource: PROMETHEUS, expr: DISK_DAYS_QUERY, instant: true, range: false }], from: String(now - 300_000), to: String(now) }),
    signal: AbortSignal.timeout(30_000), // measured: the same Grafana call in vps-boxes.ts, which answers in under 2 s
  });
  if (!response.ok) throw new Error(`Grafana ds/query answered ${response.status}`);
  const body = await response.json() as { results?: { A?: { error?: string; frames?: { data?: { values?: unknown[][] } }[] } } };
  const value = body.results?.A?.frames?.[0]?.data?.values?.[1]?.at(-1);
  if (typeof value !== "number") throw new Error(`${DISK_DAYS_QUERY}: ${body.results?.A?.error ?? "no sample"}`);
  return Math.round(value * 10) / 10;
}

async function pinterestReads(): Promise<{ reads: number; rateLimited: number }> {
  const child = promisify(execFile)("ssh", ["-o", "BatchMode=yes", PROD_SSH, CLICKHOUSE],
    { timeout: 60_000 }); // measured: the query ran in 1.3 s on 10-18 and an ssh to us-metal01 opens in about 1 s
  child.child.stdin?.end(PINTEREST_SQL);
  const { stdout } = await child;
  const row = JSON.parse(stdout.trim()) as { reads: string | number; rate_limited: string | number };
  return { reads: Number(row.reads), rateLimited: Number(row.rate_limited) };
}

async function main(): Promise<void> {
  const output = process.env.OUTPUT_FILE;
  if (!output) { process.stderr.write("pinterest-index-risks: OUTPUT_FILE is not set\n"); process.exit(2); }
  const at = Date.now();
  const flagged: FlaggedSlice[] = [{ at, kind: "page", excerpt: `risk page: ${RISK_PAGE}` }];
  const metrics: Record<string, number> = {};
  let firing = 0;
  let measured = 0;
  try {
    metrics.wiki_disk_days = await diskDays();
    measured++;
    if (metrics.wiki_disk_days < DISK_DAYS_MIN) {
      firing++;
      flagged.push({ at, kind: "firing", excerpt: `wiki box disk fills within 30 days: us-metal02 has ${metrics.wiki_disk_days} days left at the last 24 h rate` });
    }
  } catch (error) { flagged.push({ at, kind: "source_error", excerpt: `wiki_disk_days: ${error instanceof Error ? error.message : String(error)}` }); }
  try {
    const { reads, rateLimited } = await pinterestReads();
    metrics.pinterest_429_24h = rateLimited;
    measured++;
    if (rateLimited > 0) {
      firing++;
      flagged.push({ at, kind: "firing", excerpt: `Pinterest rate limit hit on the crawler's reads: ${rateLimited} reads failed with a 429 in 24 h out of ${reads} attempts` });
    } else if (!reads) flagged.push({ at, kind: "dormant", excerpt: "Pinterest rate limit: the crawler made no Pinterest reads in 24 h, so the risk cannot fire" });
  } catch (error) { flagged.push({ at, kind: "source_error", excerpt: `pinterest_429_24h: ${error instanceof Error ? error.message : String(error)}` }); }
  if (measured) metrics.risks_firing = firing;
  const result: PrecheckOutput = { metrics, flagged };
  await writeFile(output, JSON.stringify(result, null, 2) + "\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
