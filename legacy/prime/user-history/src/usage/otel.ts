import { readFileSync } from "node:fs";
import type { TokenRate } from "../shared/types.ts";
import { waitedOnHost } from "../chat-latency.ts";

/**
 * Prime's own counters in prod otel, for the Agents card's tok/s per session and the duties that read them. Every box sends its OTLP metrics
 * to the prod collector (AGENTS rule 10), which writes Prime's counters to otel.otel_metrics_sum under their OTLP names with ServiceName
 * prime-agent, the box in ResourceAttributes['host.name'] and the tier 'shared'. This module reads them as SQL through Grafana's /api/ds/query
 * on the ClickHouse datasource with the Viewer token in `<data dir>/grafana-alerts.json`. It imports nothing outside src/, because harness-feed's
 * release holds only src/ (components/harness-feed/install.mjs). Settings > Usage reads the store of every client's model calls instead
 * (src/usage/store.ts).
 */

export const DATASOURCE = "grafana_clickhouse";
export const PRIME = "prime-agent";
const SESSION_OUTPUT = "prime_agent.session.output_tokens";
const SESSION_SECONDS = "prime_agent.session.generation_seconds";
const MINUTE = 60_000;
/** A session that made no call in the last minute gets its rate over the last 24 h instead (~/work/otel-tok-meter/CONTRACT.md: a longer window as the fallback). */
const RATE_FALLBACK_MS = 86_400_000;

export class UsageError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

export type Row = Record<string, unknown>;
export type Sample = { labels: Record<string, string>; value: number };
/** SQL on prod ClickHouse; each row is one object by column name. */
export interface Otel { rows(sql: string): Promise<Row[]> }

/** A fetch error with its cause, because undici says only "fetch failed" and keeps ECONNRESET or UND_ERR_CONNECT_TIMEOUT in `cause`. */
export function reason(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = error.cause instanceof Error ? error.cause : null;
  const code = cause && "code" in cause && typeof cause.code === "string" ? cause.code : null;
  return cause ? `${error.message} (${[code, cause.message].filter(Boolean).join(": ")})` : error.message;
}

type Frame = { schema?: { fields?: { name: string }[] }; data?: { values?: unknown[][] } };

/** One SQL query through Grafana's /api/ds/query, as rows; throws on an HTTP or query error. The SQL names its own time bounds. */
async function dsQuery(url: string, token: string, sql: string): Promise<Row[]> {
  const response = await fetch(`${url.replace(/\/+$/, "")}/api/ds/query`, {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ queries: [{ refId: "A", datasource: { uid: DATASOURCE }, rawSql: sql, format: 1 }], from: "now-1h", to: "now" }),
  });
  const answer = await response.json().catch(() => ({})) as { results?: Record<string, { error?: string; frames?: Frame[] }> };
  const result = answer.results?.A;
  if (!response.ok || result?.error) throw new Error(`grafana ${response.status}: ${(result?.error ?? JSON.stringify(answer)).slice(0, 400)}`);
  const frame = result?.frames?.[0];
  const names = frame?.schema?.fields?.map(field => field.name) ?? [];
  return Array.from({ length: frame?.data?.values?.[0]?.length ?? 0 }, (_, i) => Object.fromEntries(names.map((name, column) => [name, frame?.data?.values?.[column]?.[i]])));
}

/** prod otel through Grafana. `config` names a JSON file with `url` and `token` (a Viewer service account token), read on each query so a new token needs no restart. */
export function grafanaOtel(config: string): Otel {
  return {
    async rows(sql) {
      let url: unknown, token: unknown;
      try { ({ url, token } = JSON.parse(readFileSync(config, "utf8")) as Record<string, unknown>); }
      catch (error) { throw new UsageError(503, `No Grafana token: ${config}: ${error instanceof Error ? error.message : String(error)}`); }
      if (typeof url !== "string" || typeof token !== "string" || !token) throw new UsageError(503, `No Grafana token: ${config} needs url and token.`);
      // The query runs on the obs box, so a slow answer is its time, not this box's (chat-latency.ts waitedOnHost).
      waitedOnHost();
      // A second try covers a connection that dropped between two queries. Every query here is a read.
      const ask = () => dsQuery(url as string, token as string, sql);
      return ask().catch(error => error instanceof TypeError ? ask() : Promise.reject(error))
        .catch((error: unknown) => { throw new UsageError(502, `otel query failed: ${reason(error)}`); });
    },
  };
}

/** Rows as samples: each string column a label and the column `value` the number; a row whose value is no finite number is left out. */
export const samples = (rows: readonly Row[]): Sample[] => rows.flatMap(row => {
  const value = Number(row.value);
  if (row.value === null || row.value === undefined || !Number.isFinite(value)) return [];
  return [{ labels: Object.fromEntries(Object.entries(row).filter((entry): entry is [string, string] => entry[0] !== "value" && typeof entry[1] === "string")), value }];
});

export const quote = (value: string): string => `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
const at = (ms: number): string => `fromUnixTimestamp64Milli(toInt64(${Math.round(ms)}))`;

/**
 * SQL of each series' rise over (from, to], as Prometheus increase() counts it without its extrapolation to the window's edges: the sum of a
 * series' steps up, where a step down is a restart that counts the new value. A series is one MetricName, ResourceAttributes and Attributes,
 * so a restarted sender with a new service.instance.id is a new series. Columns: metric, resource, attributes, rise. `table` is sum for a
 * counter and gauge for a counter a scrape writes untyped, such as node_vmstat_oom_kill.
 */
export function risesSql({ service, metrics, from, to, where = "", table = "sum" }: { service: string; metrics: readonly string[]; from: number; to: number; where?: string; table?: "sum" | "gauge" }): string {
  return `SELECT MetricName AS metric, ResourceAttributes AS resource, Attributes AS attributes,
    arrayMap(p -> p.2, arraySort(p -> p.1, groupArray((TimeUnix, Value)))) AS points,
    arraySum(arrayMap((d, v) -> if(d < 0, v, d), arrayDifference(points), points)) AS rise
  FROM otel.otel_metrics_${table}
  WHERE ServiceName = ${quote(service)} AND ResourceAttributes['deployment.environment.name'] = 'shared'
    AND MetricName IN (${metrics.map(quote).join(", ")}) AND TimeUnix > ${at(from)} AND TimeUnix <= ${at(to)}${where ? ` AND ${where}` : ""}
  GROUP BY MetricName, ResourceAttributes, Attributes`;
}

/**
 * Output tokens per second of generation time per session over the `spanMs` before `end`, of `ids` or of every session; a session with no
 * generation time in the window has no rate.
 */
export function ratesSql(spanMs: number, end: number, ids: readonly string[] | null): string {
  const where = ids ? `Attributes['session'] IN (${ids.map(quote).join(", ")})` : "";
  return `SELECT attributes['session'] AS session, toFloat64(sumIf(rise, metric = '${SESSION_OUTPUT}') / sumIf(rise, metric = '${SESSION_SECONDS}')) AS value
  FROM (${risesSql({ service: PRIME, metrics: [SESSION_OUTPUT, SESSION_SECONDS], from: end - spanMs, to: end, where })})
  GROUP BY session HAVING isFinite(value)`;
}

/** Output tokens per second of generation time per session id: over the last minute (live), else over the last 24 h. */
export async function sessionRates(otel: Otel, sessionIds: readonly string[], now = Date.now()): Promise<Record<string, TokenRate>> {
  const ids = [...new Set(sessionIds)].filter(id => /^[\w-]+$/.test(id));
  if (!ids.length) return {};
  const [live, longer] = await Promise.all([otel.rows(ratesSql(MINUTE, now, ids)), otel.rows(ratesSql(RATE_FALLBACK_MS, now, ids))]);
  const rates: Record<string, TokenRate> = {};
  for (const sample of samples(longer)) if (sample.labels.session) rates[sample.labels.session] = { tps: Math.round(sample.value * 10) / 10, live: false };
  for (const sample of samples(live)) if (sample.labels.session) rates[sample.labels.session] = { tps: Math.round(sample.value * 10) / 10, live: true };
  return rates;
}
