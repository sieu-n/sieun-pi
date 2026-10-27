/**
 * Usage analytics contract between the chat service (src/usage/lgtm.ts) and the browser (Settings > Usage, the sidebar Throughput line).
 * The numbers come from LGTM: every Prime process on every box exports its model calls as OTLP counters (~/work/otel-tok-meter/CONTRACT.md).
 * A token count here is every box together unless a row names its box.
 */

/** The token kinds of a model call. Output counts reasoning where the provider reports it inside output. */
export type UsageKind = "output" | "input" | "cacheRead" | "cacheWrite";
export const USAGE_KINDS: readonly UsageKind[] = ["output", "input", "cacheRead", "cacheWrite"];
/** The token kinds a metric can show. `total` sums the four kinds. */
export type UsageMetric = UsageKind | "total";
export const USAGE_METRICS: readonly UsageMetric[] = ["output", "input", "cacheRead", "cacheWrite", "total"];

export type UsageTokens = Record<UsageMetric, number>;
/** Throughput of every box together, one number per metric. */
export type UsageRate = UsageTokens;

/** The `usage` WebSocket feed payload while LGTM answers, sent at subscribe and then every 5 s. */
export type UsageSummary = {
  state: "live";
  at: number;
  /** Tokens per second over the last 60 s. */
  perSecond: UsageRate;
  /** Tokens per minute over the last 60 min. */
  perMinute: UsageRate;
  /** Tokens over the last 24 h. */
  perDay: UsageRate;
  /** Tokens per second every 10 s over the last 10 min (61 points), oldest first. */
  spark: Record<UsageMetric, number[]>;
  /** Tokens per minute over the last 60 min (61 points), oldest first. */
  sparkMinutes: Record<UsageMetric, number[]>;
  /** USD since local midnight, as the providers report it. */
  costToday: number;
};
/** The `usage` feed payload when a query failed: the page shows the error, never zeros. */
export type UsageDown = { state: "error"; at: number; error: string };
export type UsageFeed = UsageSummary | UsageDown;

/** 90d reaches the first token log on 08-14 (the owner on 10-19: "can you upload this box and mac historical usage here"); staging Prometheus keeps 90 days. */
export type UsageWindow = "1h" | "24h" | "7d" | "30d" | "90d";
export const USAGE_WINDOWS: readonly UsageWindow[] = ["1h", "24h", "7d", "30d", "90d"];
export type UsageBucket = "minute" | "hour" | "day";
export const USAGE_BUCKETS: readonly UsageBucket[] = ["minute", "hour", "day"];
/** `box` stacks per machine, `model` per model, and `kind` stacks the token kinds (output, input, cache write, cache read) in one bar. */
export type UsageGroup = "none" | "box" | "model" | "kind";
export const USAGE_GROUPS: readonly UsageGroup[] = ["none", "box", "model", "kind"];

/** GET api/usage/series?window=&bucket=&group=&metric= (metric defaults to output; `byKey` sums that metric; group "kind" ignores it and keys are output, input, cacheWrite, cacheRead). */
export type UsageSeries = {
  window: UsageWindow;
  bucket: UsageBucket;
  group: UsageGroup;
  metric: UsageMetric;
  /** Group keys in display order (largest first, at most 8, the rest folded into "other"). Empty for group "none". */
  keys: string[];
  /** One point per bucket that saw tokens or calls; `t` is the bucket start. */
  points: { t: number; tokens: UsageTokens; costUsd: number | null; calls: number; byKey?: Record<string, number> }[];
};

/** GET api/usage/models?window= : one row per box and model, for the table under the chart. */
export type UsageModelRow = {
  box: string;
  model: string;
  calls: number;
  tokens: UsageTokens;
  costUsd: number;
  /** Output tokens per second of generation time over the window, from the per-session series; null when no call was timed. */
  outputTps: number | null;
};
