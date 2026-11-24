import { cacheHitShare } from "../shared/cache-health.ts";
import { BUCKET_MS, RANGE_BUCKETS } from "../../../../../apps/chat/web/src/lib/api/shared/usage-range.ts";
import { barPath, barWidth, LABEL_PX, onStride, tickStride, USAGE_BAR, usageAxis, usageTick } from "../../../../../apps/chat/web/src/lib/api/shared/usage-chart.ts";
import { USAGE_METRICS, USAGE_WINDOWS, type UsageBucket, type UsageFeed, type UsageMetric, type UsageSeries, type UsageTokens, type UsageWindow } from "../shared/usage.ts";

/** Pure helpers for Settings > Usage: number formats, the token kind (metric) choices, the window and bucket choices and the chart layout. */

/** The token kinds a person can pick, in switch order. `short` fits the sidebar footer label. */
export const METRICS: readonly { id: UsageMetric; label: string; short: string }[] = [
  { id: "output", label: "Output", short: "Output" }, { id: "input", label: "Input", short: "Input" }, { id: "cacheRead", label: "Cache read", short: "Cache rd" },
  { id: "cacheWrite", label: "Cache write", short: "Cache wr" }, { id: "total", label: "Total", short: "Tokens" },
];
export const METRIC_LABEL: Record<UsageMetric, string> = { output: "Output", input: "Input", cacheRead: "Cache read", cacheWrite: "Cache write", total: "Total" };
export const isMetric = (value: string | null): value is UsageMetric => USAGE_METRICS.includes(value as UsageMetric);
/** One kind of a token count. */
export const metricOf = (tokens: UsageTokens, metric: UsageMetric): number => tokens[metric];
/** Group "kind" keys as the service stacks them, output at the bottom. */
export const KIND_KEYS: readonly string[] = ["output", "input", "cacheWrite", "cacheRead"];
export const kindLabel = (key: string): string => isMetric(key) ? METRIC_LABEL[key] : key;

/**
 * A `usage` feed payload this page can draw: the error the store gave, or a rate and both sparks for every metric. The page and the server can come
 * from different builds (a tab left open across a restart). A summary in a shape the page did not know used to throw inside the render, and
 * Settings > Usage then stayed on "Loading usage" with "– tok/s" in the sidebar. Such a payload is now null, and the page says to reload.
 */
export function readFeed(value: unknown): UsageFeed | null {
  const record = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
  if (!record(value) || typeof value.at !== "number") return null;
  if (value.state === "error") return typeof value.error === "string" ? value as UsageFeed : null;
  if (value.state !== "live" || typeof value.costToday !== "number") return null;
  const rate = (v: unknown) => record(v) && USAGE_METRICS.every(metric => typeof v[metric] === "number");
  const spark = (v: unknown) => record(v) && USAGE_METRICS.every(metric => Array.isArray(v[metric]) && (v[metric] as unknown[]).every(n => typeof n === "number"));
  if (!rate(value.perSecond) || !rate(value.perMinute) || !rate(value.perDay) || !spark(value.spark) || !spark(value.sparkMinutes)) return null;
  return value as UsageFeed;
}

export const WINDOWS: readonly UsageWindow[] = USAGE_WINDOWS;

/** The buckets a window offers, the default first, as sw factory's Usage page offers them. */
export const bucketsFor = (window: UsageWindow): readonly UsageBucket[] => RANGE_BUCKETS[window];
export const defaultBucket = (window: UsageWindow): UsageBucket => bucketsFor(window)[0]!;
export const BUCKET_LABEL: Record<UsageBucket, string> = { minute: "Minute", hour: "Hour", day: "Day" };

/** A token count for a headline or axis: 842, 1.2k, 84k, 1.23M, 12.4M, 1.08B. */
export function tokens(value: number): string {
  const n = Math.max(0, value);
  const trim = (text: string) => text.replace(/\.?0+$/, "");
  if (n < 1000) return String(Math.round(n));
  if (n < 10_000) return trim((n / 1000).toFixed(1)) + "k";
  if (n < 1_000_000) return Math.round(n / 1000) + "k";
  if (n < 10_000_000) return trim((n / 1_000_000).toFixed(2)) + "M";
  if (n < 100_000_000) return trim((n / 1_000_000).toFixed(1)) + "M";
  if (n < 1_000_000_000) return Math.round(n / 1_000_000) + "M";
  return trim((n / 1_000_000_000).toFixed(n < 10_000_000_000 ? 2 : 1)) + "B";
}
export const fullTokens = (value: number): string => Math.round(value).toLocaleString("en-US");

/** USD with cents; under a cent shows a third decimal so a cheap hour is not "$0.00"; null is a dash (no price for the model). */
export function cost(usd: number | null): string {
  if (usd === null || !Number.isFinite(usd)) return "–";
  if (usd === 0) return "$0.00";
  if (usd < 0.01) return "$" + usd.toFixed(3);
  return "$" + usd.toFixed(2);
}

/** A cache hit rate for a card, a cell or the hover: "96.8%", "100%", or a dash when nothing was prompted. */
export function hitRate(tokens: { input: number; cacheRead: number; cacheWrite: number }): string {
  const hit = cacheHitShare(tokens);
  if (hit === null) return "–";
  return hit >= 0.9995 ? "100%" : (hit * 100).toFixed(1) + "%";
}

/** The cache hit rate per spark bucket; a bucket with no prompt keeps the rate before it (the first known one at the start), so idle time is no drop. */
export function hitSpark(spark: Record<UsageMetric, number[]>): number[] {
  const hits = spark.cacheRead.map((cacheRead, i) => cacheHitShare({ input: spark.input[i] ?? 0, cacheRead, cacheWrite: spark.cacheWrite[i] ?? 0 }));
  let last = hits.find(hit => hit !== null) ?? 0;
  return hits.map(hit => (last = hit ?? last));
}

/** An SVG path through `values` scaled into width by height, oldest left. One flat line when every value is zero. */
export function sparkPath(values: readonly number[], width: number, height: number): string {
  if (values.length === 0) return "";
  const max = Math.max(0, ...values);
  const step = values.length > 1 ? width / (values.length - 1) : 0;
  const y = (v: number) => max > 0 ? height - 1 - (v / max) * (height - 2) : height - 1;
  return values.map((v, i) => (i === 0 ? "M" : "L") + (i * step).toFixed(1) + " " + y(v).toFixed(1)).join("");
}

/**
 * `total` is the bar's height in tokens: the series metric, or every kind for group "kind". `tokens` keeps the full split for the hover.
 * `x` and `w` are the drawn bar, `slot` the bucket's whole column from its left edge, which the hover answers in. Each stack part's `d` is its
 * drawn path, sw factory's bar shape (shared/usage-chart.ts).
 */
export type Bar = { t: number; x: number; w: number; slot: number; total: number; tokens: UsageTokens; calls: number; costUsd: number | null; stack: { key: string; value: number; y: number; h: number; d: string }[] };
export type Layout = { bars: Bar[]; from: number; to: number; top: number; step: number; keys: string[]; ticks: { x: number; label: string; anchor: "start" | "middle" | "end" }[]; grid: { y: number; label: string }[] };

/** The tokens one bar stands for: the series metric, or the sum of every kind when the kinds are stacked. */
export const barValue = (series: Pick<UsageSeries, "group" | "metric">, tokens: UsageTokens): number => series.group === "kind" ? tokens.total : metricOf(tokens, series.metric);

/**
 * Places every bucket by time inside the plot (`width` by `height` px, origin top left), so a quiet hour shows as a gap, never as a
 * collapsed step. The plot spans the series' range, whole buckets that end with the one holding now. A bar is the series metric
 * (every kind for group "kind"). Stacks follow `series.keys`; tokens not covered by the listed keys fold into "other". The y axis steps,
 * the bar width and shape and the time labels are sw factory's (shared/usage-chart.ts), so both Usage pages draw a range alike.
 * `share` draws every stacked bar at full height with its parts as fractions, so the mix of a quiet bucket reads like a busy one.
 * A stacked part that was used at all is at least 1 px tall.
 */
export function layout(series: UsageSeries, width: number, height: number, share = false): Layout {
  const step = BUCKET_MS[series.bucket];
  const points = [...series.points].sort((a, b) => a.t - b.t);
  const from = series.since;
  const to = series.until;
  const span = Math.max(step, to - from);
  const value = (point: UsageSeries["points"][number]) => barValue(series, point.tokens);
  const stacked = series.group !== "none";
  const shares = share && stacked;
  const most = Math.max(0, ...points.map(value));
  const axis = usageAxis(most);
  const top = shares ? 1 : axis.top;
  const scaleX = (t: number) => ((t - from) / span) * width;
  const stepPx = (width / span) * step;
  const barW = barWidth(stepPx);
  const listed = (point: UsageSeries["points"][number]) => series.keys.reduce((sum, key) => sum + (point.byKey?.[key] ?? 0), 0);
  // A real fold is the server's "other" key; this only catches a server that listed fewer keys than it summed (rounding never counts).
  const foldsOther = stacked && points.some(point => value(point) - listed(point) > Math.max(1, value(point) * 0.01));
  const keys = foldsOther && !series.keys.includes("other") ? [...series.keys, "other"] : [...series.keys];
  const bars = points.map(point => {
    const slot = scaleX(point.t);
    const x = slot + (stepPx - barW) / 2;
    const w = barW;
    const total = value(point);
    const parts = stacked ? keys.map(key => ({ key, value: point.byKey?.[key] ?? 0 })) : [{ key: "", value: total }];
    if (foldsOther) parts.find(part => part.key === "other")!.value += Math.max(0, total - listed(point));
    const scale = shares ? (total > 0 ? height / total : 0) : height / top;
    // Every kind that was used shows at least 1 px (output is 0.2% of a cache-heavy bar); the largest part gives up the excess, so the bar's height stays exact.
    const heights = parts.filter(part => part.value > 0).map(part => ({ key: part.key, value: part.value, h: stacked ? Math.max(1, part.value * scale) : part.value * scale }));
    const excess = heights.reduce((sum, part) => sum + part.h, 0) - total * scale;
    if (excess > 0 && heights.length > 1) { const largest = heights.reduce((a, b) => (b.h > a.h ? b : a)); largest.h = Math.max(1, largest.h - excess); }
    let used = 0;
    const stack = heights.map((part, index) => {
      used += part.h;
      const y = height - used;
      const last = index === heights.length - 1;
      const drawn = Math.max(1, part.h - (!last && w > 4 ? USAGE_BAR.gap : 0));
      return { key: part.key, value: part.value, y, h: part.h, d: barPath(x, y + part.h - drawn, w, drawn, last && w > 4) };
    });
    return { t: point.t, x, w, slot, total, tokens: point.tokens, calls: point.calls, costUsd: point.costUsd, stack };
  });
  const stride = tickStride(series.bucket, Math.round(span / step), width);
  const ticks: Layout["ticks"] = [];
  for (let t = from; t < to; t += step) {
    if (!onStride(t, series.bucket, stride)) continue;
    const x = scaleX(t) + stepPx / 2;
    ticks.push({ x, label: usageTick(t, series.bucket), anchor: x < LABEL_PX / 2 ? "start" : x > width - LABEL_PX / 2 ? "end" : "middle" });
  }
  const grid = shares ? [0.25, 0.5, 0.75, 1].map(f => ({ y: height - f * height, label: `${f * 100}%` })) : axis.ticks.map(value => ({ y: height - (value / top) * height, label: tokens(value) }));
  return { bars, from, to, top, step: stepPx, keys, ticks, grid };
}

/** A part's share of its bar for the hover: "63%", "0.4%", or "<0.1%". */
export function share(value: number, total: number): string {
  if (!(total > 0) || !(value > 0)) return "0%";
  const pct = (value / total) * 100;
  if (pct < 0.1) return "<0.1%";
  return (pct < 10 ? pct.toFixed(1).replace(/\.0$/, "") : String(Math.round(pct))) + "%";
}

/** The bar under a pointer at plot x, if the pointer sits inside a bucket's column (`step` px wide). */
export function barAt(bars: readonly Bar[], x: number, step: number): Bar | null {
  return bars.find(bar => x >= bar.slot && x < bar.slot + Math.max(step, 2)) ?? null;
}

/** The time a hover shows for one bucket: its start, or its day for day buckets. */
export function bucketTitle(t: number, bucket: UsageBucket): string {
  const date = new Date(t);
  if (bucket === "day") return date.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
  const time = date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" }) + " " + time;
}

/** A short model name for the table: the id after the provider prefix, without a date suffix. */
export function modelLabel(model: string): string {
  return model.replace(/^[a-z0-9-]+\//i, "").replace(/-\d{8}$/, "");
}
