import { readFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { type UsageBucket, type UsageFeed, type UsageGroup, type UsageKind, type UsageMetric, type UsageModelRow, type UsageRate, type UsageSeries, type UsageSummary, type UsageTokens, type UsageWindow, USAGE_BUCKETS, USAGE_GROUPS, USAGE_METRICS, USAGE_WINDOWS } from "../shared/usage.ts";
import type { TokenRate } from "../shared/types.ts";

/**
 * Settings > Usage, the sidebar Throughput line and the Agents card tok/s, all read from LGTM. Each Prime process on every box exports its model
 * calls as OTLP counters, and Alloy writes them to the staging estate Prometheus (~/work/otel-tok-meter/CONTRACT.md). This module runs PromQL
 * through the Grafana datasource proxy with the Viewer token in `<data dir>/grafana-alerts.json`. Every query filters job="prime-agent", because
 * test runs export the same series under another job. A failed query reaches the page as an error, never as zeros.
 */

export const DATASOURCE = "estate_prometheus_stg";
const JOB = 'job="prime-agent"';
const TOKENS = "prime_agent_tokens_total";
const CALLS = `prime_agent_calls_total{${JOB}}`;
const COST = `prime_agent_cost_USD_total{${JOB}}`;
const SESSION_OUTPUT = "prime_agent_session_output_tokens_total";
const SESSION_SECONDS = "prime_agent_session_generation_seconds_total";
/** The exporter's kind label to the page's name for it. */
const KIND_OF: Record<string, UsageKind> = { input: "input", output: "output", cache_read: "cacheRead", cache_write: "cacheWrite" };
const LABEL_OF: Record<UsageKind, string> = { input: "input", output: "output", cacheRead: "cache_read", cacheWrite: "cache_write" };
/** The token counter for one metric: one kind, or every kind for total. */
const tokens = (metric: UsageMetric): string => metric === "total" ? `${TOKENS}{${JOB}}` : `${TOKENS}{${JOB},kind="${LABEL_OF[metric]}"}`;

export class UsageError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

const pick = <T extends string>(list: readonly T[], name: string) => (value: string | null): T => {
  if (value !== null && (list as readonly string[]).includes(value)) return value as T;
  throw new UsageError(400, `Use ${name} ${list.join(", ")}.`);
};
export const parseWindow = pick(USAGE_WINDOWS, "window");
export const parseBucket = pick(USAGE_BUCKETS, "bucket");
export const parseGroup = (value: string | null): UsageGroup => value === null ? "none" : pick(USAGE_GROUPS, "group")(value);
export const parseMetric = (value: string | null): UsageMetric => value === null ? "output" : pick(USAGE_METRICS, "metric")(value);

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
function reason(error: unknown): string {
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

const zeroTokens = (): UsageTokens => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 });
/** Per-kind samples (label `kind`) as one count per metric; a kind the page does not know is left out of every metric. */
function byKind(samples: readonly Sample[]): UsageRate {
  const rate = zeroTokens();
  for (const sample of samples) {
    const kind = KIND_OF[sample.labels.kind ?? ""];
    if (!kind) continue;
    rate[kind] += sample.value;
    rate.total += sample.value;
  }
  return rate;
}
const sum = (samples: readonly Sample[]): number => samples.reduce((total, sample) => total + sample.value, 0);

/** Per-kind range series on the grid start, start + step, ... end, one array per metric; a step with no sample is 0. */
function sparks(series: readonly Range[], start: number, end: number, stepS: number): Record<UsageMetric, number[]> {
  const count = Math.round((end - start) / (stepS * 1000)) + 1;
  const out = Object.fromEntries(USAGE_METRICS.map(metric => [metric, new Array<number>(count).fill(0)])) as Record<UsageMetric, number[]>;
  for (const row of series) {
    const kind = KIND_OF[row.labels.kind ?? ""];
    if (!kind) continue;
    for (const point of row.points) {
      const at = Math.round((point.t - start) / (stepS * 1000));
      if (at < 0 || at >= count) continue;
      out[kind][at]! += point.value;
      out.total[at]! += point.value;
    }
  }
  return out;
}

const STEP_S: Record<UsageBucket, number> = { minute: 60, hour: 3600, day: 86_400 };
const WINDOW_S: Record<UsageWindow, number> = { "1h": 3600, "24h": 86_400, "7d": 7 * 86_400, "30d": 30 * 86_400, "90d": 90 * 86_400 };
/** The most keys a stacked chart lists; the rest fold into "other". */
const MAX_KEYS = 8;
/** The spark of the per-second card and the sidebar: the rate over the last 10 min at the 10 s export interval of CONTRACT.md. */
const SPARK_S = 10;
const SPARK_SPAN_S = 600;
/** The feed asks again every 5 s, half the 10 s export interval, so a new export shows within 5 s plus LGTM's 0.5 to 5 s delay. */
const FEED_MS = 5000;
/** A session that made no call in the last minute gets its rate over the last 24 h instead (CONTRACT.md: a longer window as the fallback). */
const RATE_FALLBACK = "24h";

/** The end of the bucket that holds `now`: the next local midnight for days, else the next multiple of the step. */
function bucketEnd(now: number, bucket: UsageBucket): number {
  if (bucket !== "day") { const step = STEP_S[bucket] * 1000; return Math.ceil(now / step) * step; }
  const midnight = new Date(now);
  midnight.setHours(24, 0, 0, 0);
  return midnight.getTime();
}

export class Usage {
  private readonly listeners = new Set<(feed: UsageFeed) => void>();
  private feed: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly prometheus: Prometheus, private readonly now: () => number = Date.now) {}

  /** The headline numbers of every box together; throws when any query fails. */
  async summary(): Promise<UsageSummary> {
    const now = this.now();
    const midnight = new Date(now);
    midnight.setHours(0, 0, 0, 0);
    const sinceMidnight = Math.max(1, Math.floor((now - midnight.getTime()) / 1000));
    const all = tokens("total");
    const sparkStart = now - SPARK_SPAN_S * 1000;
    const hourStart = now - 3600_000;
    const [perSecond, perMinute, perDay, cost, spark, sparkMinutes] = await Promise.all([
      this.prometheus.query(`sum by (kind) (rate(${all}[1m]))`),
      this.prometheus.query(`sum by (kind) (increase(${all}[1h])) / 60`),
      this.prometheus.query(`sum by (kind) (increase(${all}[24h]))`),
      this.prometheus.query(`sum(increase(${COST}[${sinceMidnight}s]))`),
      this.prometheus.range(`sum by (kind) (rate(${all}[1m]))`, sparkStart, now, SPARK_S),
      this.prometheus.range(`sum by (kind) (increase(${all}[1m]))`, hourStart, now, 60),
    ]);
    return { state: "live", at: now, perSecond: byKind(perSecond), perMinute: byKind(perMinute), perDay: byKind(perDay), costToday: sum(cost),
      spark: sparks(spark, sparkStart, now, SPARK_S), sparkMinutes: sparks(sparkMinutes, hourStart, now, 60) };
  }

  /** Tokens over time for the chart, one point per bucket that saw tokens or calls; `t` is the bucket start. */
  async series(window: UsageWindow, bucket: UsageBucket, group: UsageGroup, metric: UsageMetric = "output"): Promise<UsageSeries> {
    const stepS = STEP_S[bucket];
    const end = bucketEnd(this.now(), bucket);
    const start = end - WINDOW_S[window] * 1000 + stepS * 1000;
    const over = (series: string) => `increase(${series}[${stepS}s])`;
    const [kinds, calls, cost, keyed] = await Promise.all([
      this.prometheus.range(`sum by (kind) (${over(tokens("total"))})`, start, end, stepS),
      this.prometheus.range(`sum(${over(CALLS)})`, start, end, stepS),
      this.prometheus.range(`sum(${over(COST)})`, start, end, stepS),
      group === "box" || group === "model" ? this.prometheus.range(`sum by (${group}) (${over(tokens(metric))})`, start, end, stepS) : Promise.resolve([]),
    ]);
    const at = new Map<number, UsageSeries["points"][number]>();
    const point = (t: number) => {
      let found = at.get(t);
      if (!found) at.set(t, found = { t: t - stepS * 1000, tokens: zeroTokens(), costUsd: 0, calls: 0, ...group === "none" ? {} : { byKey: {} } });
      return found;
    };
    for (const row of kinds) {
      const kind = KIND_OF[row.labels.kind ?? ""];
      if (!kind) continue;
      for (const { t, value } of row.points) { const p = point(t); p.tokens[kind] += value; p.tokens.total += value; if (group === "kind") p.byKey![kind] = (p.byKey![kind] ?? 0) + value; }
    }
    for (const row of calls) for (const { t, value } of row.points) point(t).calls += value;
    for (const row of cost) for (const { t, value } of row.points) point(t).costUsd = (point(t).costUsd ?? 0) + value;
    const totals = new Map<string, number>();
    for (const row of keyed) {
      const key = row.labels[group] || "unknown";
      for (const { t, value } of row.points) { const p = point(t); p.byKey![key] = (p.byKey![key] ?? 0) + value; totals.set(key, (totals.get(key) ?? 0) + value); }
    }
    let keys = group === "kind" ? ["output", "input", "cacheWrite", "cacheRead"] : [...totals].sort((a, b) => b[1] - a[1]).map(([key]) => key);
    if (keys.length > MAX_KEYS && group !== "kind") {
      const kept = new Set(keys.slice(0, MAX_KEYS - 1));
      for (const p of at.values()) for (const [key, value] of Object.entries(p.byKey ?? {})) {
        if (kept.has(key)) continue;
        delete p.byKey![key];
        p.byKey!.other = (p.byKey!.other ?? 0) + value;
      }
      keys = [...kept, "other"];
    }
    const points = [...at.values()].filter(p => p.tokens.total > 0 || p.calls > 0).sort((a, b) => a.t - b.t);
    return { window, bucket, group, metric, keys, points };
  }

  /** One row per box and model that used tokens in the window, with calls, cost and output tokens per second of generation time. */
  async models(window: UsageWindow): Promise<{ models: UsageModelRow[] }> {
    const span = WINDOW_S[window];
    const by = "box, model";
    const [kinds, calls, cost, speed] = await Promise.all([
      this.prometheus.query(`sum by (${by}, kind) (increase(${tokens("total")}[${span}s]))`),
      this.prometheus.query(`sum by (${by}) (increase(${CALLS}[${span}s]))`),
      this.prometheus.query(`sum by (${by}) (increase(${COST}[${span}s]))`),
      this.prometheus.query(`sum by (${by}) (increase(${SESSION_OUTPUT}{${JOB}}[${span}s])) / sum by (${by}) (increase(${SESSION_SECONDS}{${JOB}}[${span}s]))`),
    ]);
    const rows = new Map<string, UsageModelRow>();
    const row = (labels: Labels) => {
      const box = labels.box || "unknown", model = labels.model || "unknown", key = `${box}\n${model}`;
      let found = rows.get(key);
      if (!found) rows.set(key, found = { box, model, calls: 0, tokens: zeroTokens(), costUsd: 0, outputTps: null });
      return found;
    };
    for (const sample of kinds) {
      const kind = KIND_OF[sample.labels.kind ?? ""];
      if (!kind) continue;
      const found = row(sample.labels);
      found.tokens[kind] += sample.value;
      found.tokens.total += sample.value;
    }
    for (const sample of calls) row(sample.labels).calls += sample.value;
    for (const sample of cost) row(sample.labels).costUsd += sample.value;
    for (const sample of speed) row(sample.labels).outputTps = sample.value;
    return { models: [...rows.values()].filter(found => found.tokens.total > 0 || found.calls > 0) };
  }

  /** Output tokens per second of generation time per session id: over the last minute (live), else over the last 24 h. */
  async rates(sessionIds: readonly string[]): Promise<Record<string, TokenRate>> {
    const ids = [...new Set(sessionIds)].filter(id => /^[\w-]+$/.test(id));
    if (!ids.length) return {};
    const match = `${JOB},session=~"${ids.join("|")}"`;
    const speed = (range: string) => this.prometheus.query(`sum by (session) (increase(${SESSION_OUTPUT}{${match}}[${range}])) / sum by (session) (increase(${SESSION_SECONDS}{${match}}[${range}]))`);
    const [live, longer] = await Promise.all([speed("1m"), speed(RATE_FALLBACK)]);
    const rates: Record<string, TokenRate> = {};
    for (const sample of longer) if (sample.labels.session) rates[sample.labels.session] = { tps: Math.round(sample.value * 10) / 10, live: false };
    for (const sample of live) if (sample.labels.session) rates[sample.labels.session] = { tps: Math.round(sample.value * 10) / 10, live: true };
    return rates;
  }

  /** The feed payload now: the summary, or the error that kept it from LGTM. */
  async reading(): Promise<UsageFeed> {
    try { return await this.summary(); }
    catch (error) { return { state: "error", at: this.now(), error: error instanceof Error ? error.message : String(error) }; }
  }

  /** The `usage` feed: one reading now, then one every FEED_MS while anyone listens. */
  subscribe(listener: (feed: UsageFeed) => void): () => void {
    this.listeners.add(listener);
    void this.reading().then(feed => { if (this.listeners.has(listener)) listener(feed); });
    if (!this.feed) {
      let busy = false;
      this.feed = setInterval(() => {
        if (busy) return;
        busy = true;
        void this.reading().then(feed => { for (const each of this.listeners) each(feed); }).finally(() => { busy = false; });
      }, FEED_MS);
      this.feed.unref();
    }
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0 && this.feed) { clearInterval(this.feed); this.feed = null; }
    };
  }

  close(): void {
    if (this.feed) clearInterval(this.feed);
    this.feed = null;
    this.listeners.clear();
  }
}
