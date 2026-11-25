import { cacheHitShare } from "../../src/shared/cache-health.ts";
import type { FlaggedSlice } from "../../src/shared/chat-duties.ts";
import { type Otel, PRIME, quote, risesSql, samples, type Sample } from "../../src/usage/otel.ts";

/**
 * The prompt cache read share for the Skills and tools duty (owner c41: "the cache read ratio of hour/day should stay high"), from Prime's
 * counters in prod otel, the one source of token usage (src/usage/otel.ts): cache read / (input + cache read + cache write) of every Prime
 * process on every box, over the providers that read or wrote any cache in the window. When a share is under its target, the duty job gets the
 * box and model pairs that wrote the most cache in that window, with each one's share.
 */

export const WINDOWS = { cache_read_ratio_1h: "1h", cache_read_ratio_24h: "24h" } as const;
export type CacheMetric = keyof typeof WINDOWS;
/** A window with fewer finished calls is no data. */
export const MIN_CALLS = 20;
/**
 * The share a window with no data reads: under every target, so no data is a miss with the reason "no data". It read 100 until 10-19, and
 * at 15:30Z that day no box sent Prime's counters yet, because the Prime OTLP exporter was not installed, so both shares read a false green.
 */
export const NO_DATA = 0;
const TOP = 3;
const MINUTE = 60_000;
const SPAN_MS: Record<(typeof WINDOWS)[CacheMetric], number> = { "1h": 3_600_000, "24h": 86_400_000 };
const TIER = "ResourceAttributes['deployment.environment.name'] = 'shared'";
/** Minute `i` of a span starting at `start` holds the points in (start + (i - 1) min, start + i min], as Prometheus count_over_time([1m]) at each step read it. */
const minuteOf = (start: number) => `toInt64(ceil((toUnixTimestamp(TimeUnix) * 1000 - ${start}) / 60000))`;
const within = (start: number, end: number) => `TimeUnix > fromUnixTimestamp64Milli(toInt64(${start - MINUTE})) AND TimeUnix <= fromUnixTimestamp64Milli(toInt64(${end}))`;
/**
 * The minutes otel heard from any box: a Prime calls point or a harness-feed point. The staging Prometheus took no sample from 10-29 03:10Z to
 * 05:00Z, and the 1h window after it held no call. A box whose calls counter is missing while its harness-feed still reports is a missing
 * feed, which stays a miss (p719).
 */
export const heardSql = (start: number, end: number): string => `SELECT DISTINCT ${minuteOf(start)} AS minute FROM (
  SELECT TimeUnix FROM otel.otel_metrics_sum WHERE ServiceName = ${quote(PRIME)} AND MetricName = 'prime_agent.calls' AND ${TIER} AND ${within(start, end)}
  UNION ALL
  SELECT TimeUnix FROM otel.otel_metrics_gauge WHERE ServiceName = 'harness' AND MetricName = 'harness.feed.rss' AND ${TIER} AND ${within(start, end)})`;
/**
 * The Claude accounts pi-pool could use in each minute, each box's last reading in it summed. Claude calls carry the share: 24,234M of the
 * 24,353M cache read tokens in the 24 h to 10-29 20:05Z. From 10-29 17:50Z to 19:30Z none of the 40 accounts was usable, no Claude call ended
 * on either box, and the 19:30Z run read 8 calls as a 0 share.
 */
export const claudeUsableSql = (start: number, end: number): string => `SELECT minute, toFloat64(sum(last)) AS value FROM (
  SELECT ResourceAttributes AS resource, ${minuteOf(start)} AS minute, argMax(Value, TimeUnix) AS last FROM otel.otel_metrics_gauge
  WHERE ServiceName = 'harness' AND MetricName = 'harness.pool.provider_usable_accounts' AND Attributes['provider'] = 'anthropic' AND ${TIER} AND ${within(start, end)}
  GROUP BY resource, minute) GROUP BY minute`;
/** Prime's tokens by box, provider, model and kind over the `spanMs` before `end`. */
export const tokensSql = (spanMs: number, end: number): string => `SELECT resource['host.name'] AS box, attributes['provider'] AS provider,
  attributes['model'] AS model, attributes['kind'] AS kind, toFloat64(sum(rise)) AS value
  FROM (${risesSql({ service: PRIME, metrics: ["prime_agent.tokens"], from: end - spanMs, to: end })}) GROUP BY box, provider, model, kind`;
/** Prime's calls by provider and stop reason over the `spanMs` before `end`. */
export const callsSql = (spanMs: number, end: number): string => `SELECT attributes['provider'] AS provider, attributes['stop_reason'] AS stop_reason, toFloat64(sum(rise)) AS value
  FROM (${risesSql({ service: PRIME, metrics: ["prime_agent.calls"], from: end - spanMs, to: end })}) GROUP BY provider, stop_reason`;

type Prompt = { input: number; cacheRead: number; cacheWrite: number };
const KIND: Record<string, keyof Prompt> = { input: "input", cache_read: "cacheRead", cache_write: "cacheWrite" };
const percent = (prompt: Prompt): number => { const hit = cacheHitShare(prompt); return hit === null ? 100 : Math.round(1000 * hit) / 10; };
const add = (into: Map<string, Prompt>, key: string, sample: Sample) => {
  const kind = KIND[sample.labels.kind ?? ""];
  if (!kind) return;
  const prompt = into.get(key) ?? { input: 0, cacheRead: 0, cacheWrite: 0 };
  prompt[kind] += sample.value;
  into.set(key, prompt);
};

/** One window's share, its finished and failed calls, and the box and model pairs that wrote the most cache, from per-box, provider and model counts. */
export function windowShare(tokens: readonly Sample[], calls: readonly Sample[]): { share: number; calls: number; failures: number; writers: string[] } {
  const byProvider = new Map<string, Prompt>();
  for (const sample of tokens) add(byProvider, sample.labels.provider ?? "", sample);
  const caching = new Set([...byProvider].filter(([, prompt]) => prompt.cacheRead + prompt.cacheWrite > 0).map(([provider]) => provider));
  const total: Prompt = { input: 0, cacheRead: 0, cacheWrite: 0 };
  const byPair = new Map<string, Prompt>();
  for (const sample of tokens) {
    if (!caching.has(sample.labels.provider ?? "")) continue;
    const kind = KIND[sample.labels.kind ?? ""];
    if (kind) total[kind] += sample.value;
    add(byPair, `${sample.labels.box ?? "unknown"} ${sample.labels.model ?? "unknown"}`, sample);
  }
  let finished = 0, failures = 0;
  for (const sample of calls) {
    if (sample.labels.stop_reason === "error") failures += sample.value;
    else if (caching.has(sample.labels.provider ?? "")) finished += sample.value;
  }
  const writers = [...byPair].sort((a, b) => b[1].cacheWrite - a[1].cacheWrite).slice(0, TOP)
    .map(([pair, prompt]) => `${pair}: ${percent(prompt)}% read, ${(prompt.cacheWrite / 1e6).toFixed(1)}M cache tokens written`);
  return { share: percent(total), calls: Math.round(finished), failures: Math.round(failures), writers };
}

/** The `source_error` item for shares otel could not answer: the duty judge reads a share left out of the output as not measured, with this reason. */
export const otelFailure = (keys: readonly CacheMetric[], error: unknown): FlaggedSlice =>
  ({ kind: "source_error", excerpt: `${keys.join(" and ")} not measured: otel did not answer: ${error instanceof Error ? error.message : String(error)}` });

export type Lost = "silent" | "blocked";
const LOST_WORDS: Record<Lost, string> = { silent: "otel heard from no box", blocked: "pi-pool had no usable Claude account" };

/** Each minute of the `spanMs` window ending at `end` (a whole minute) in which otel heard from no box (silent) or no Claude call could start (blocked). */
export async function lostMinutes(otel: Otel, spanMs: number, end: number): Promise<{ at: number; why: Lost }[]> {
  const start = end - spanMs + MINUTE;
  const [heard, usable] = await Promise.all([otel.rows(heardSql(start, end)), otel.rows(claudeUsableSql(start, end))]);
  const live = new Set(heard.map(row => Number(row.minute)));
  const blocked = new Set(usable.filter(row => Number(row.value) === 0).map(row => Number(row.minute)));
  const lost: { at: number; why: Lost }[] = [];
  for (let i = 0; start + i * MINUTE <= end; i += 1) {
    const why: Lost | null = !live.has(i) ? "silent" : blocked.has(i) ? "blocked" : null;
    if (why) lost.push({ at: start + i * MINUTE, why });
  }
  return lost;
}

/** Lost minutes as runs, such as "pi-pool had no usable Claude account from 10-29 18:30Z to 19:30Z"; the minute stamped `at` ends at `at`. */
export function describeLost(lost: readonly { at: number; why: Lost }[]): string {
  const runs: { why: Lost; from: number; to: number }[] = [];
  for (const { at, why } of lost) {
    const last = runs.at(-1);
    if (last && last.why === why && last.to === at - MINUTE) last.to = at;
    else runs.push({ why, from: at - MINUTE, to: at });
  }
  const day = (t: number) => new Date(t).toISOString().slice(5, 10);
  const clock = (t: number) => `${new Date(t).toISOString().slice(11, 16)}Z`;
  const words = runs.slice(0, TOP).map(run => `${LOST_WORDS[run.why]} from ${day(run.from)} ${clock(run.from)} to ${day(run.to) === day(run.from) ? "" : `${day(run.to)} `}${clock(run.to)}`);
  return `${words.join(", ")}${runs.length > TOP ? ` and ${runs.length - TOP} more gaps` : ""}`;
}

/**
 * Both shares, and for a share under its target the box and model pairs that wrote the most cache in that window. A window whose query fails
 * has no value and one `otelFailure` item. On 10-28 at 18:50Z a staging deploy recreated the staging Prometheus that held these counters then,
 * it answered HTTP 502, and both shares read 0, a red duty with a false cause. A window under MIN_CALLS that lost half its minutes or more (`lostMinutes`) has no value
 * and one `source_error` item naming the gap, because on 10-29 at 19:30Z the 1h share read 0 while no Claude account had been usable all hour.
 */
export async function measureCache(otel: Otel, targets: Record<CacheMetric, number>, now = Date.now()): Promise<{ metrics: Partial<Record<CacheMetric, number>>; flagged: FlaggedSlice[] }> {
  const end = Math.floor(now / MINUTE) * MINUTE;
  const metrics: Partial<Record<CacheMetric, number>> = {};
  const flagged: FlaggedSlice[] = [];
  // Every window asks the same source, so once one query fails the next windows take its error unasked. On 10-29 at 03:25Z the staging
  // Prometheus timed out on connect (ETIMEDOUT), each query waited out a connect and its retry, and asking both windows took the d10 precheck to 559 s.
  let down: unknown;
  for (const [key, span] of Object.entries(WINDOWS) as [CacheMetric, (typeof WINDOWS)[CacheMetric]][]) {
    if (down !== undefined) { flagged.push(otelFailure([key], down)); continue; }
    let tokens: Sample[], calls: Sample[];
    try {
      [tokens, calls] = (await Promise.all([otel.rows(tokensSql(SPAN_MS[span], end)), otel.rows(callsSql(SPAN_MS[span], end))])).map(samples) as [Sample[], Sample[]];
    } catch (error) {
      down = error;
      flagged.push(otelFailure([key], error));
      continue;
    }
    const window = windowShare(tokens, calls);
    const alsoFailed = window.failures ? ` (${window.failures} more ended in an error)` : "";
    if (window.calls < MIN_CALLS) {
      // A window that lost at least half its minutes to a gap is not measured, and a quiet window with otel and the pool up stays a miss.
      // Both 10-29 gaps (03:10Z to 05:00Z and 17:50Z to 19:30Z) covered every minute of the 1h window that read 0.
      let lost: { at: number; why: Lost }[];
      try { lost = await lostMinutes(otel, SPAN_MS[span], end); }
      catch (error) { down = error; flagged.push(otelFailure([key], error)); continue; }
      if (2 * lost.length * MINUTE >= SPAN_MS[span]) {
        flagged.push({ kind: "source_error", excerpt: `${key} not measured: ${window.calls} calls in the window${alsoFailed}, because ${describeLost(lost)}` });
        continue;
      }
      metrics[key] = NO_DATA;
      flagged.push({ kind: key, excerpt: `no data: ${window.calls} calls in the window, under ${MIN_CALLS}, so it counts as a miss${alsoFailed}` });
      continue;
    }
    metrics[key] = window.share;
    if (window.share >= targets[key]) continue;
    flagged.push(...window.writers.map(line => ({ kind: key, excerpt: `${window.share}% < ${targets[key]}% over ${window.calls} calls${alsoFailed}; top cache writer ${line}` })));
  }
  return { metrics, flagged };
}
