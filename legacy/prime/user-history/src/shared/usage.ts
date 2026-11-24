/**
 * Usage analytics contract between the chat service (src/usage/store.ts) and the browser (Settings > Usage, the sidebar Throughput line).
 * The numbers come from the usage store, ClickHouse ai_usage.model_calls, which holds every model call of every chat client on every host
 * (components/usage-collector). A token count here is every host and client together unless a row names them.
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

/** The `usage` WebSocket feed payload while the store answers, sent at subscribe and then every 5 s. */
export type UsageSummary = {
  state: "live";
  at: number;
  /** Tokens per second over the minute that ends on the 10 s tick before now. */
  perSecond: UsageRate;
  /** Tokens per minute over the last 60 min. */
  perMinute: UsageRate;
  /** Tokens over the 24 whole hours that end with the hour holding now, the chart's 24h total. */
  perDay: UsageRate;
  /** Tokens per second every 10 s over the last 10 min (61 points), oldest first. */
  spark: Record<UsageMetric, number[]>;
  /** Tokens per minute over the last 60 min (61 points), oldest first. */
  sparkMinutes: Record<UsageMetric, number[]>;
  /** USD since midnight in Seoul (Asia/Seoul), whatever zone the chat's box runs in. */
  costToday: number;
  /** When the chat last read the store, while the store has not answered since: every figure is as of then, and the rate now is unknown. */
  staleSince?: number;
};
/** The `usage` feed payload when the store has not answered: the page shows the error, never zeros. */
export type UsageDown = { state: "error"; at: number; error: string };
export type UsageFeed = UsageSummary | UsageDown;

/** The ranges of sw factory's Usage page (apps/chat/web/src/lib/api/shared/usage-range.ts), which reads the same store. */
export type UsageWindow = "1h" | "24h" | "7d" | "30d" | "90d";
export const USAGE_WINDOWS: readonly UsageWindow[] = ["1h", "24h", "7d", "30d", "90d"];
export type UsageBucket = "minute" | "hour" | "day";
export const USAGE_BUCKETS: readonly UsageBucket[] = ["minute", "hour", "day"];
/** `box` stacks per host, `client` per chat client, `model` per model, and `kind` stacks the token kinds (output, input, cache write, cache read) in one bar. */
export type UsageGroup = "none" | "box" | "client" | "model" | "kind";
export const USAGE_GROUPS: readonly UsageGroup[] = ["none", "box", "client", "model", "kind"];

/** GET api/usage/series?window=&bucket=&group=&metric= (metric defaults to output; `byKey` sums that metric; group "kind" ignores it and keys are output, input, cacheWrite, cacheRead). */
export type UsageSeries = {
  window: UsageWindow;
  bucket: UsageBucket;
  group: UsageGroup;
  metric: UsageMetric;
  /** The range in epoch ms: whole buckets that end with the one holding now, a day starting at Seoul midnight. */
  since: number;
  until: number;
  /** Group keys in display order: the costliest up to sw factory's `USAGE_CHART_SERIES`, largest of the metric first, the rest folded into "other" last. Empty for group "none". */
  keys: string[];
  /** One point per bucket that saw tokens or calls; `t` is the bucket start. */
  points: { t: number; tokens: UsageTokens; costUsd: number | null; calls: number; byKey?: Record<string, number> }[];
  /** When the chat last read the store, while the store has not answered since; the points are as of then. */
  staleSince?: number;
};

/** GET api/usage/models?window=&bucket= : one row per host, client and model over the chart's range, for the table under the chart. */
export type UsageModelRow = {
  box: string;
  client: string;
  model: string;
  calls: number;
  tokens: UsageTokens;
  costUsd: number;
};
