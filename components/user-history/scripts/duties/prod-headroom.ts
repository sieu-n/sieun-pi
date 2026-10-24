import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { FlaggedSlice, PrecheckOutput } from "../../src/shared/chat-duties.ts";
import { type DsQuery, grafanaClient, PROM, promInstant, SOURCE_DEADLINE_MS } from "./estate-reads.ts";

/**
 * The precheck of metal-management's duty "Prod box headroom" (`node --import tsx scripts/duties/prod-headroom.ts`): whether us-metal01, the
 * prod box, keeps room for the crawl push. Two numbers, both read only from prod Prometheus (estate_prometheus) through Grafana ds/query on obs.virev.ai:
 * - `profiles_p95_s`: p95 seconds of /api/profiles GET over the last hour, from the crawler API's request histogram (goal p8).
 * - `nvme0_tb_24h`: terabytes written to nvme0n1, prod's database drive, in the last 24 h (goal p83).
 * The login is the Viewer token in browser-chat/grafana-alerts.json, the one vps-boxes.ts and the alert bridge use, so it can only read.
 * A query that fails or has no sample leaves its metric out with a `source_error` item, and the runner says not measured instead of a miss.
 * Prints the output to OUTPUT_FILE, or to stdout when OUTPUT_FILE is unset. No model call, nothing sent outside.
 */

const GRAFANA_CONFIG = join(homedir(), ".prime/agent/browser-chat/grafana-alerts.json");

export const QUERIES = {
  profiles_p95_s: 'histogram_quantile(0.95, sum by (le) (rate(crawler_v3_api_request_duration_seconds_bucket{route="/api/profiles",method="GET"}[1h])))',
  nvme0_tb_24h: 'increase(node_disk_written_bytes_total{box="us-metal01",device="nvme0n1"}[24h])',
} as const;
export type MetricKey = keyof typeof QUERIES;

/** Each metric's number from its query's raw value: seconds to 2 places, bytes as decimal TB. */
export const CONVERT: Readonly<Record<MetricKey, (raw: number) => number>> = {
  profiles_p95_s: raw => Math.round(raw * 100) / 100,
  nvme0_tb_24h: raw => Math.round(raw / 1e10) / 100,
};

const WORDS: Readonly<Record<MetricKey, (value: number) => string>> = {
  profiles_p95_s: value => `profile reads on prod took ${value} s at p95 over the last hour`,
  nvme0_tb_24h: value => `nvme0n1 on us-metal01 took ${value} TB of writes in the last 24 h`,
};

type Series = { labels: Record<string, string>; value: number }[];

/** One metric from its instant-query series: exactly one finite sample, or an error naming why it is not measured. */
export function reading(key: MetricKey, series: Series | Error): { value: number } | { error: string } {
  if (series instanceof Error) return { error: `${key}: ${series.message}` };
  const finite = series.filter(item => Number.isFinite(item.value));
  if (finite.length !== 1) return { error: `${key}: prod Prometheus gave ${finite.length} finite series for ${QUERIES[key]}, want 1` };
  return { value: CONVERT[key](finite[0]!.value) };
}

/** The precheck output from each metric's series. */
export function headroom(answers: Readonly<Record<MetricKey, Series | Error>>, at: number): PrecheckOutput {
  const metrics: Record<string, number> = {};
  const flagged: FlaggedSlice[] = [];
  for (const key of Object.keys(QUERIES) as MetricKey[]) {
    const result = reading(key, answers[key]);
    if ("error" in result) { flagged.push({ at, kind: "source_error", excerpt: result.error.slice(0, 600) }); continue; }
    metrics[key] = result.value;
    flagged.push({ at, kind: "reading", item: key, excerpt: `${WORDS[key](result.value)} (estate_prometheus: ${QUERIES[key]})`.slice(0, 600) });
  }
  return { metrics, flagged };
}

export async function measure(query: DsQuery, at: number): Promise<PrecheckOutput> {
  const keys = Object.keys(QUERIES) as MetricKey[];
  const answers = await Promise.all(keys.map(key => promInstant(query, PROM.prod, QUERIES[key]).catch((error: unknown) => error instanceof Error ? error : new Error(String(error)))));
  return headroom(Object.fromEntries(keys.map((key, index) => [key, answers[index]!])) as Record<MetricKey, Series | Error>, at);
}

async function main(): Promise<void> {
  const at = Date.now();
  let output: PrecheckOutput;
  try {
    const config = JSON.parse(await readFile(GRAFANA_CONFIG, "utf8")) as { url?: string; token?: string };
    if (!config.token) throw new Error(`${GRAFANA_CONFIG} has no token`);
    output = await measure(grafanaClient(fetch, `Bearer ${config.token}`, at, AbortSignal.timeout(SOURCE_DEADLINE_MS)), at);
  } catch (error) {
    output = { metrics: {}, flagged: [{ at, kind: "source_error", excerpt: `prod Prometheus: ${error instanceof Error ? error.message : String(error)}`.slice(0, 600) }] };
  }
  const text = JSON.stringify(output, null, 2) + "\n";
  if (process.env.OUTPUT_FILE) await writeFile(process.env.OUTPUT_FILE, text);
  else process.stdout.write(text);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
