import { cacheHitShare } from "../../src/shared/cache-health.ts";
import type { FlaggedSlice } from "../../src/shared/chat-duties.ts";
import type { Prometheus, Sample } from "../../src/usage/lgtm.ts";

/**
 * The prompt cache read share for the Skills and tools duty (owner c41: "the cache read ratio of hour/day should stay high"), from LGTM, the one
 * source of token usage (src/usage/lgtm.ts): cache read / (input + cache read + cache write) of every Prime process on every box, over the
 * providers that read or wrote any cache in the window. When a share is under its target, the duty job gets the box and model pairs that wrote
 * the most cache in that window, with each one's share.
 */

export const WINDOWS = { cache_read_ratio_1h: "1h", cache_read_ratio_24h: "24h" } as const;
export type CacheMetric = keyof typeof WINDOWS;
/** A window with fewer finished calls is no data: the metric reads 100 and a flagged line says so. */
export const MIN_CALLS = 20;
const TOP = 3;
const JOB = 'job="prime-agent"';

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

/** Both shares, and for a share under its target the box and model pairs that wrote the most cache in that window. */
export async function measureCache(prometheus: Prometheus, targets: Record<CacheMetric, number>): Promise<{ metrics: Record<CacheMetric, number>; flagged: FlaggedSlice[] }> {
  const metrics = {} as Record<CacheMetric, number>;
  const flagged: FlaggedSlice[] = [];
  for (const [key, span] of Object.entries(WINDOWS) as [CacheMetric, string][]) {
    const [tokens, calls] = await Promise.all([
      prometheus.query(`sum by (box, provider, model, kind) (increase(prime_agent_tokens_total{${JOB}}[${span}]))`),
      prometheus.query(`sum by (provider, stop_reason) (increase(prime_agent_calls_total{${JOB}}[${span}]))`),
    ]);
    const window = windowShare(tokens, calls);
    const alsoFailed = window.failures ? ` (${window.failures} more ended in an error)` : "";
    if (window.calls < MIN_CALLS) {
      metrics[key] = 100;
      flagged.push({ kind: key, excerpt: `no data: ${window.calls} calls in the window, under ${MIN_CALLS}, so it reads 100${alsoFailed}` });
      continue;
    }
    metrics[key] = window.share;
    if (window.share >= targets[key]) continue;
    flagged.push(...window.writers.map(line => ({ kind: key, excerpt: `${window.share}% < ${targets[key]}% over ${window.calls} calls${alsoFailed}; top cache writer ${line}` })));
  }
  return { metrics, flagged };
}
