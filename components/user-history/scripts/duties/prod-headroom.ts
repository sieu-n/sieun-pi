import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { type FiringAlert, readGrafanaAlerts } from "../../src/alert-bridge.ts";
import type { FlaggedSlice, PrecheckOutput } from "../../src/shared/chat-duties.ts";
import { type DsQuery, grafanaClient, PROM, promInstant, SOURCE_DEADLINE_MS } from "./estate-reads.ts";

/**
 * The precheck of metal-management's duty "Prod box headroom" (`node --import tsx scripts/duties/prod-headroom.ts`): whether us-metal01, the
 * prod box, keeps room for the crawl push, and whether the disks of us-metal01 and us-metal02 are healthy. The first two numbers are read only from
 * prod Prometheus (estate_prometheus) through Grafana ds/query on obs.virev.ai, the third from Grafana's alert list:
 * - `profiles_p95_s`: p95 seconds of /api/profiles GET over the last hour, from the crawler API's request histogram (goal p8).
 * - `nvme0_tb_24h`: terabytes written to nvme0n1, prod's database drive, in the last 24 h (goal p83).
 * - `disk_health_alerts_firing`: the firing alerts of the Grafana-managed `metal-disk-*` rules (disk-health.yaml, disk-health-raid.yaml and
 *   mount-io.yaml in apps/infra/metal/config/obs/grafana/alerting) on either box. us-metal01's RAID10 ran degraded from 10-14 and went offline
 *   at 10:40:38Z on 10-25 with no duty seeing it. Grafana evaluates these rules itself, so prod Prometheus has no ALERTS series for them.
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

/** The uid prefix every disk health rule shares, and the boxes the duty reads them for. */
export const DISK_RULE = /^metal-disk-/;
export const DISK_BOXES: ReadonlySet<string> = new Set(["us-metal01", "us-metal02"]);

/** The firing alerts of the disk health rules on us-metal01 and us-metal02, oldest first. */
export const diskAlerts = (alerts: readonly FiringAlert[]): FiringAlert[] =>
  alerts.filter(alert => DISK_RULE.test(alert.labels.__alert_rule_uid__ ?? "") && DISK_BOXES.has(alert.labels.box ?? ""))
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt));

type Series = { labels: Record<string, string>; value: number }[];

/** One metric from its instant-query series: exactly one finite sample, or an error naming why it is not measured. */
export function reading(key: MetricKey, series: Series | Error): { value: number } | { error: string } {
  if (series instanceof Error) return { error: `${key}: ${series.message}` };
  const finite = series.filter(item => Number.isFinite(item.value));
  if (finite.length !== 1) return { error: `${key}: prod Prometheus gave ${finite.length} finite series for ${QUERIES[key]}, want 1` };
  return { value: CONVERT[key](finite[0]!.value) };
}

/** The precheck output from each metric's series and Grafana's alert list. */
export function headroom(answers: Readonly<Record<MetricKey, Series | Error>>, alerts: readonly FiringAlert[] | Error, at: number): PrecheckOutput {
  const metrics: Record<string, number> = {};
  const flagged: FlaggedSlice[] = [];
  for (const key of Object.keys(QUERIES) as MetricKey[]) {
    const result = reading(key, answers[key]);
    if ("error" in result) { flagged.push({ at, kind: "source_error", excerpt: result.error.slice(0, 600) }); continue; }
    metrics[key] = result.value;
    flagged.push({ at, kind: "reading", item: key, excerpt: `${WORDS[key](result.value)} (estate_prometheus: ${QUERIES[key]})`.slice(0, 600) });
  }
  if (alerts instanceof Error) flagged.push({ at, kind: "source_error", excerpt: `disk_health_alerts_firing: ${alerts.message}`.slice(0, 600) });
  else {
    const firing = diskAlerts(alerts);
    metrics.disk_health_alerts_firing = firing.length;
    flagged.push(...firing.map(alert => ({ at, kind: "alert_firing", item: "disk_health_alerts_firing",
      excerpt: `${alert.labels.box}: ${alert.alertname} (${alert.labels.__alert_rule_uid__}) since ${alert.startsAt}${alert.summary ? `: ${alert.summary}` : ""}`.slice(0, 600) })));
  }
  return { metrics, flagged };
}

const asError = (error: unknown): Error => error instanceof Error ? error : new Error(String(error));

export async function measure(query: DsQuery, alerts: () => Promise<FiringAlert[]>, at: number): Promise<PrecheckOutput> {
  const keys = Object.keys(QUERIES) as MetricKey[];
  const [answers, firing] = await Promise.all([Promise.all(keys.map(key => promInstant(query, PROM.prod, QUERIES[key]).catch(asError))), alerts().catch(asError)]);
  return headroom(Object.fromEntries(keys.map((key, index) => [key, answers[index]!])) as Record<MetricKey, Series | Error>, firing, at);
}

async function grafanaAlerts(): Promise<FiringAlert[]> {
  const alerts = await readGrafanaAlerts(GRAFANA_CONFIG);
  if (!alerts) throw new Error(`${GRAFANA_CONFIG} is missing`);
  return alerts;
}

async function main(): Promise<void> {
  const at = Date.now();
  let output: PrecheckOutput;
  try {
    const config = JSON.parse(await readFile(GRAFANA_CONFIG, "utf8")) as { url?: string; token?: string };
    if (!config.token) throw new Error(`${GRAFANA_CONFIG} has no token`);
    output = await measure(grafanaClient(fetch, `Bearer ${config.token}`, at, AbortSignal.timeout(SOURCE_DEADLINE_MS)), grafanaAlerts, at);
  } catch (error) {
    output = { metrics: {}, flagged: [{ at, kind: "source_error", excerpt: `prod Prometheus: ${error instanceof Error ? error.message : String(error)}`.slice(0, 600) }] };
  }
  const text = JSON.stringify(output, null, 2) + "\n";
  if (process.env.OUTPUT_FILE) await writeFile(process.env.OUTPUT_FILE, text);
  else process.stdout.write(text);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
