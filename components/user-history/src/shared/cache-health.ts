import type { ThreadMessage } from "./types.ts";

/** Thresholds from 13,583 warm calls in 40 recent Prime Agent threads (2026-09-23): median hit 99.5%, p5 93.9%, p1 0.2%; cache write p99 17% of the prompt. */
export const CACHE_COLD_GAP_MS = 5 * 60_000;
export const CACHE_MIN_PROMPT = 10_000;
export const CACHE_MISS_HIT = 0.5;
export const CACHE_LOW_HIT = 0.9;
export const CACHE_BELOW_USUAL = 0.1;
export const CACHE_WRITE_SHARE = 0.2;
export const CACHE_RECENT_CALLS = 20;

export interface CallCache { messageIndex: number; prompt: number; input: number; cacheRead: number; cacheWrite: number; hit: number; warm: boolean }
export interface CacheHealth {
  calls: number;
  last: CallCache | null;
  usualHit: number | null;
  recentMisses: number;
  totals: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number };
  level: "ok" | "warn" | "bad";
  reasons: string[];
}

const percent = (value: number) => (value * 100).toFixed(value > 0.99 && value < 1 ? 1 : 0) + "%";

/**
 * Cache health from native per-call assistant `usage`. A call is warm when an earlier call in the same model ran
 * less than five minutes before it; only warm calls with a large prompt can show a broken cache.
 */
export function cacheHealth(messages: readonly ThreadMessage[]): CacheHealth {
  const calls: CallCache[] = [];
  const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  let previous: { timestamp: number; model: string } | null = null;
  messages.forEach((message, messageIndex) => {
    if (message.role !== "assistant" || !message.usage) return;
    const { input, output, cacheRead, cacheWrite, cost } = message.usage;
    totals.input += input; totals.output += output; totals.cacheRead += cacheRead; totals.cacheWrite += cacheWrite; totals.cost += cost;
    const prompt = input + cacheRead + cacheWrite;
    if (prompt === 0) return;
    const model = message.provider + "/" + message.model;
    const warm = previous !== null && previous.model === model && message.timestamp - previous.timestamp < CACHE_COLD_GAP_MS;
    calls.push({ messageIndex, prompt, input, cacheRead, cacheWrite, hit: cacheRead / prompt, warm });
    previous = { timestamp: message.timestamp, model };
  });
  const warm = calls.filter(call => call.warm && call.prompt >= CACHE_MIN_PROMPT);
  const hits = warm.map(call => call.hit).sort((a, b) => a - b);
  const usualHit = hits.length ? hits[Math.floor(hits.length / 2)]! : null;
  const recentMisses = warm.slice(-CACHE_RECENT_CALLS).filter(call => call.hit < CACHE_MISS_HIT).length;
  const last = calls.at(-1) ?? null;
  const reasons: string[] = [];
  let level: CacheHealth["level"] = "ok";
  const raise = (to: "warn" | "bad", reason: string) => { reasons.push(reason); if (to === "bad" || level === "ok") level = to; };
  if (last?.warm && last.prompt >= CACHE_MIN_PROMPT) {
    if (last.hit < CACHE_MISS_HIT) raise("bad", last.cacheRead === 0
      ? `The last call read nothing from the cache. ${last.prompt.toLocaleString()} prompt tokens were sent again at full price.`
      : `The last call read only ${percent(last.hit)} of its prompt from the cache.`);
    else if (last.hit < CACHE_LOW_HIT || (usualHit !== null && last.hit < usualHit - CACHE_BELOW_USUAL)) raise("warn", `The last call hit ${percent(last.hit)} of the cache. This thread usually hits ${percent(usualHit ?? 1)}.`);
    if (last.cacheWrite / last.prompt > CACHE_WRITE_SHARE) raise("warn", `The last call wrote ${last.cacheWrite.toLocaleString()} tokens to the cache, ${percent(last.cacheWrite / last.prompt)} of its prompt.`);
  }
  if (recentMisses >= 2) raise("warn", `${recentMisses} of the last ${Math.min(CACHE_RECENT_CALLS, warm.length)} calls missed the cache.`);
  return { calls: calls.length, last, usualHit, recentMisses, totals, level, reasons };
}
