import { readFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { TokenRate } from "../shared/types.ts";
import { waitedOnHost } from "../chat-latency.ts";

/**
 * PromQL on LGTM for the Agents card's tok/s per session and the duties that read Prime's own counters. Each Prime process on every box
 * exports its model calls as OTLP counters, and Alloy writes them to the staging estate Prometheus (~/work/otel-tok-meter/CONTRACT.md). This
 * module runs PromQL through the Grafana datasource proxy with the Viewer token in `<data dir>/grafana-alerts.json`. Settings > Usage reads
 * the store of every client's model calls instead (src/usage/store.ts).
 */

export const DATASOURCE = "estate_prometheus_stg";
const JOB = 'job="prime-agent"';
const SESSION_OUTPUT = "prime_agent_session_output_tokens_total";
const SESSION_SECONDS = "prime_agent_session_generation_seconds_total";
/** A session that made no call in the last minute gets its rate over the last 24 h instead (CONTRACT.md: a longer window as the fallback). */
const RATE_FALLBACK = "24h";

export class UsageError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export type Labels = Record<string, string>;
export type Sample = { labels: Labels; value: number };
export type Range = { labels: Labels; points: { t: number; value: number }[] };
/** The Prometheus HTTP API: an instant query (now, or at `at` epoch ms), and a range query from `start` to `end` (epoch ms) every `stepS` seconds. */
export interface Prometheus {
  query(promql: string, at?: number): Promise<Sample[]>;
  range(promql: string, start: number, end: number, stepS: number): Promise<Range[]>;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
/** A sample value as Prometheus writes it; NaN (0/0 in a ratio) and infinities are no value. */
const number = (value: unknown): number | null => { const n = typeof value === "string" ? Number(value) : NaN; return Number.isFinite(n) ? n : null; };

/** A fetch error with its cause, because undici says only "fetch failed" and keeps ECONNRESET or UND_ERR_CONNECT_TIMEOUT in `cause`. */
export function reason(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = error.cause instanceof Error ? error.cause : null;
  const code = cause && "code" in cause && typeof cause.code === "string" ? cause.code : null;
  return cause ? `${error.message} (${[code, cause.message].filter(Boolean).join(": ")})` : error.message;
}

/**
 * A GET over HTTP/1.1, with fetch's signature. Node 26's own fetch keeps one HTTP/2 session to obs.virev.ai, and once
 * the proxy closes that session, queries fail with ERR_HTTP2_GOAWAY_SESSION or ERR_HTTP2_INVALID_SESSION, a retry
 * included: on 10-20 the sidebar read "err" in 4 of 42 readings from 22:16 to 22:21Z, and in 2 of 60 from 22:33 to
 * 22:38Z with the retry live. HTTP/1.1 has no shared session to lose.
 */
export const http1Fetch = ((input: string | URL | Request, init?: RequestInit) => new Promise<Response>((resolve, reject) => {
  const url = new URL(String(input));
  const send = url.protocol === "http:" ? httpRequest : httpsRequest;
  const req = send(url, { method: "GET", headers: Object.fromEntries(new Headers(init?.headers)) }, res => {
    const chunks: Buffer[] = [];
    res.on("data", (chunk: Buffer) => chunks.push(chunk));
    res.on("end", () => resolve(new Response(Buffer.concat(chunks), { status: res.statusCode ?? 502 })));
    res.on("error", error => reject(new TypeError("fetch failed", { cause: error })));
  });
  req.on("error", error => reject(new TypeError("fetch failed", { cause: error })));
  req.end();
})) as typeof fetch;

/** The Prometheus API behind Grafana's datasource proxy. `config` names a JSON file with `url` and `token` (a Viewer service account token), read on each query so a new token needs no restart. */
export function grafanaPrometheus(config: string, fetcher: typeof fetch = http1Fetch): Prometheus {
  async function call(path: "query" | "query_range", params: Record<string, string>): Promise<unknown> {
    let url: unknown, token: unknown;
    try { ({ url, token } = JSON.parse(await readFile(config, "utf8")) as Record<string, unknown>); }
    catch (error) { throw new UsageError(503, `No Grafana token: ${config}: ${error instanceof Error ? error.message : String(error)}`); }
    if (typeof url !== "string" || typeof token !== "string") throw new UsageError(503, `No Grafana token: ${config} needs url and token.`);
    const ask = () => fetcher(`${url.replace(/\/$/, "")}/api/datasources/proxy/uid/${DATASOURCE}/api/v1/${path}?${new URLSearchParams(params)}`, { headers: { authorization: `Bearer ${token}` } });
    // The query runs on the LGTM box, so a slow answer is its time, not this box's (chat-latency.ts waitedOnHost).
    waitedOnHost();
    // A second try covers a connection that dropped between two queries. Every query here is a read.
    const response = await ask().catch(() => ask())
      .catch((error: unknown) => { throw new UsageError(502, `LGTM unreachable: ${reason(error)}`); });
    const text = await response.text();
    let body: unknown;
    try { body = JSON.parse(text); } catch { body = null; }
    if (!response.ok || !isRecord(body) || body.status !== "success" || !isRecord(body.data)) {
      const detail = isRecord(body) && typeof body.error === "string" ? body.error : text.slice(0, 200);
      throw new UsageError(502, `LGTM query failed (HTTP ${response.status}): ${detail}`);
    }
    return body.data.result;
  }
  const labels = (row: Record<string, unknown>): Labels => isRecord(row.metric) ? Object.fromEntries(Object.entries(row.metric).filter((entry): entry is [string, string] => typeof entry[1] === "string")) : {};
  return {
    async query(promql, at) {
      const result = await call("query", { query: promql, ...at === undefined ? {} : { time: String(at / 1000) } });
      if (!Array.isArray(result)) throw new UsageError(502, "LGTM answered a query with no vector.");
      return result.filter(isRecord).flatMap(row => {
        const value = Array.isArray(row.value) ? number(row.value[1]) : null;
        return value === null ? [] : [{ labels: labels(row), value }];
      });
    },
    async range(promql, start, end, stepS) {
      const result = await call("query_range", { query: promql, start: String(start / 1000), end: String(end / 1000), step: String(stepS) });
      if (!Array.isArray(result)) throw new UsageError(502, "LGTM answered a range query with no matrix.");
      return result.filter(isRecord).map(row => ({ labels: labels(row), points: (Array.isArray(row.values) ? row.values : []).flatMap((pair: unknown) => {
        if (!Array.isArray(pair) || typeof pair[0] !== "number") return [];
        const value = number(pair[1]);
        return value === null ? [] : [{ t: Math.round(pair[0] * 1000), value }];
      }) }));
    },
  };
}

/** Output tokens per second of generation time per session id: over the last minute (live), else over the last 24 h. */
export async function sessionRates(prometheus: Prometheus, sessionIds: readonly string[]): Promise<Record<string, TokenRate>> {
  const ids = [...new Set(sessionIds)].filter(id => /^[\w-]+$/.test(id));
  if (!ids.length) return {};
  const match = `${JOB},session=~"${ids.join("|")}"`;
  const speed = (range: string) => prometheus.query(`sum by (session) (increase(${SESSION_OUTPUT}{${match}}[${range}])) / sum by (session) (increase(${SESSION_SECONDS}{${match}}[${range}]))`);
  const [live, longer] = await Promise.all([speed("1m"), speed(RATE_FALLBACK)]);
  const rates: Record<string, TokenRate> = {};
  for (const sample of longer) if (sample.labels.session) rates[sample.labels.session] = { tps: Math.round(sample.value * 10) / 10, live: false };
  for (const sample of live) if (sample.labels.session) rates[sample.labels.session] = { tps: Math.round(sample.value * 10) / 10, live: true };
  return rates;
}
