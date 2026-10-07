/**
 * Usage analytics contract between the chat service (src/usage/*) and the browser (Settings > Usage).
 * The coordinator owns this file. Change it only by asking the coordinator.
 *
 * Source of truth is the raw agent transcripts on this Mac. usage.duckdb is a derived cache:
 * delete it and the service rebuilds it from the transcripts.
 */

/** One client whose local transcripts are read. Matches tokscale client ids where one exists. */
export type UsageSource = "prime-agent" | "claude-code" | "codex" | "hermes" | "pi" | "opencode" | (string & {});

/** One model call, one row in the `calls` table. */
export type UsageCall = {
  source: UsageSource;
  /** Stable id inside the source: provider response id, message id, or file+line when nothing else exists. */
  callId: string;
  sessionId: string | null;
  /** Wall-clock end of the call (when the transcript wrote it), epoch ms. */
  endedAt: number;
  /** Request start, epoch ms, when the source records it (Prime Agent `message.timestamp`). */
  startedAt: number | null;
  provider: string | null;
  model: string | null;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  /** USD. From the source when it records cost, else from the price table, else null. */
  costUsd: number | null;
  cwd: string | null;
};

export type UsageTokens = { input: number; output: number; cacheRead: number; cacheWrite: number; reasoning: number; total: number };

/** The token kinds a metric can show. `total` sums the other four (reasoning is counted inside output where the source reports it). */
export type UsageMetric = "output" | "input" | "cacheRead" | "cacheWrite" | "total";
export const USAGE_METRICS: readonly UsageMetric[] = ["output", "input", "cacheRead", "cacheWrite", "total"];

/** Rolling throughput for all agents together, one number per metric. */
export type UsageRate = Record<UsageMetric, number>;

/** GET api/usage/summary, and the `usage` WebSocket feed payload (pushed about every 2 s while subscribed). */
export type UsageSummary = {
  at: number;
  /** Tokens per second over the last 60 s. */
  perSecond: UsageRate;
  /** Tokens per minute over the last 60 min. */
  perMinute: UsageRate;
  /** Tokens over the last 24 h. */
  perDay: UsageRate;
  /** Last 60 one-second buckets, then last 60 one-minute buckets, oldest first; per metric, tokens per bucket. */
  sparkSeconds: Record<UsageMetric, number[]>;
  sparkMinutes: Record<UsageMetric, number[]>;
  costToday: number | null;
  ingest: UsageIngest;
};

export type UsageIngest = {
  state: "building" | "syncing" | "idle" | "error";
  /** Initial build progress; equal when the build is done. */
  filesDone: number;
  filesTotal: number;
  lastSyncAt: number | null;
  error: string | null;
  sources: { source: UsageSource; calls: number; firstCallAt: number | null; lastCallAt: number | null }[];
};

export type UsageWindow = "1h" | "24h" | "7d" | "30d" | "90d" | "all";
export type UsageBucket = "second" | "minute" | "hour" | "day";
/** `kind` stacks the token kinds (output, input, cache write, cache read) in one bar. */
export type UsageGroup = "none" | "source" | "model" | "kind";

/** GET api/usage/series?window=&bucket=&group=&metric= (metric defaults to output; `byKey` sums that metric; group "kind" ignores it and keys are output, input, cacheWrite, cacheRead). */
export type UsageSeries = {
  window: UsageWindow;
  bucket: UsageBucket;
  group: UsageGroup;
  metric: UsageMetric;
  /** Group keys in display order (largest first, at most 8, the rest folded into "other"). Empty for group "none". */
  keys: string[];
  points: { t: number; tokens: UsageTokens; costUsd: number | null; calls: number; byKey?: Record<string, number> }[];
};

/** GET api/usage/models?window= : one row per model, for the table under the chart. */
export type UsageModelRow = {
  source: UsageSource;
  model: string;
  calls: number;
  tokens: UsageTokens;
  costUsd: number | null;
  /** Median output tokens per second per call (output / (endedAt - startedAt)), only where startedAt exists and output > 200. */
  medianOutputTps: number | null;
};
