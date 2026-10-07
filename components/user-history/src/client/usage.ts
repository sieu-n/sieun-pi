import type { UsageBucket, UsageIngest, UsageSeries, UsageWindow } from "../shared/usage.ts";

/** Pure helpers for Settings > Usage: number formats, the window and bucket choices, the chart layout and the ingest line. */

export const BUCKET_MS: Record<UsageBucket, number> = { second: 1000, minute: 60_000, hour: 3_600_000, day: 86_400_000 };
export const WINDOW_MS: Record<Exclude<UsageWindow, "all">, number> = { "1h": 3_600_000, "24h": 86_400_000, "7d": 7 * 86_400_000, "30d": 30 * 86_400_000, "90d": 90 * 86_400_000 };
export const WINDOWS: readonly UsageWindow[] = ["1h", "24h", "7d", "30d", "90d", "all"];

/** The buckets a window offers, the default first. A choice never draws more than about 1,500 bars. */
export function bucketsFor(window: UsageWindow): readonly UsageBucket[] {
  switch (window) {
    case "1h": return ["minute"];
    case "24h": return ["hour", "minute"];
    case "7d": return ["hour", "day"];
    case "30d": return ["day", "hour"];
    default: return ["day"];
  }
}
export const defaultBucket = (window: UsageWindow): UsageBucket => bucketsFor(window)[0]!;
export const BUCKET_LABEL: Record<UsageBucket, string> = { second: "Second", minute: "Minute", hour: "Hour", day: "Day" };

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

/** Median output tokens per second: 42.3, 128, or a dash when no call qualified. */
export function tps(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "–";
  return value < 100 ? value.toFixed(1) : String(Math.round(value));
}

/** An SVG path through `values` scaled into width by height, oldest left. One flat line when every value is zero. */
export function sparkPath(values: readonly number[], width: number, height: number): string {
  if (values.length === 0) return "";
  const max = Math.max(0, ...values);
  const step = values.length > 1 ? width / (values.length - 1) : 0;
  const y = (v: number) => max > 0 ? height - 1 - (v / max) * (height - 2) : height - 1;
  return values.map((v, i) => (i === 0 ? "M" : "L") + (i * step).toFixed(1) + " " + y(v).toFixed(1)).join("");
}

/** The y axis top: the smallest 1, 2, 2.5 or 5 times a power of ten at or above `max`; 1 when nothing was used (the labels stay blank then). */
export function niceMax(max: number): number {
  if (!(max > 0)) return 1;
  const power = 10 ** Math.floor(Math.log10(max));
  for (const step of [1, 2, 2.5, 5, 10]) if (step * power >= max) return step * power;
  return 10 * power;
}

export type Bar = { t: number; x: number; w: number; total: number; calls: number; costUsd: number | null; stack: { key: string; value: number; y: number; h: number }[] };
export type Layout = { bars: Bar[]; from: number; to: number; top: number; keys: string[]; ticks: { x: number; label: string }[]; grid: { y: number; label: string }[] };

/** Time axis label for a bucket start, per bucket size. */
export function tickLabel(t: number, bucket: UsageBucket, spanMs: number): string {
  const date = new Date(t);
  if (bucket === "day" || spanMs > 3 * BUCKET_MS.day) return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const time = date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return spanMs > BUCKET_MS.day ? date.toLocaleDateString(undefined, { weekday: "short" }) + " " + time : time;
}

/**
 * Places every bucket by time inside the plot (`width` by `height` px, origin top left), so a quiet hour shows as a gap, never as a
 * collapsed step. A fixed window spans [now - window, now]; "all" spans the first bucket to the last. Stacks follow `series.keys`;
 * tokens not covered by the listed keys fold into "other".
 */
export function layout(series: UsageSeries, width: number, height: number, now: number): Layout {
  const step = BUCKET_MS[series.bucket];
  const points = [...series.points].sort((a, b) => a.t - b.t);
  const first = points[0]?.t ?? now - step;
  const last = (points.at(-1)?.t ?? now - step) + step;
  const from = series.window === "all" ? first : Math.min(now - WINDOW_MS[series.window], first);
  const to = series.window === "all" ? last : Math.max(now, last);
  const span = Math.max(step, to - from);
  const most = Math.max(0, ...points.map(point => point.tokens.total));
  const top = niceMax(most);
  const scaleX = (t: number) => ((t - from) / span) * width;
  const listed = (point: UsageSeries["points"][number]) => series.keys.reduce((sum, key) => sum + (point.byKey?.[key] ?? 0), 0);
  // A real fold is the server's "other" key; this only catches a server that listed fewer keys than it summed (rounding never counts).
  const foldsOther = series.group !== "none" && points.some(point => point.tokens.total - listed(point) > Math.max(1, point.tokens.total * 0.01));
  const keys = foldsOther && !series.keys.includes("other") ? [...series.keys, "other"] : [...series.keys];
  const bars = points.map(point => {
    const x = scaleX(point.t);
    const w = Math.max(1, scaleX(point.t + step) - x - (width / span * step > 4 ? 1 : 0));
    const parts = series.group === "none" ? [{ key: "", value: point.tokens.total }] : keys.map(key => ({ key, value: point.byKey?.[key] ?? 0 }));
    if (foldsOther) parts.find(part => part.key === "other")!.value += Math.max(0, point.tokens.total - listed(point));
    let used = 0;
    const stack = parts.filter(part => part.value > 0).map(part => {
      const h = (part.value / top) * height;
      used += h;
      return { key: part.key, value: part.value, y: height - used, h };
    });
    return { t: point.t, x, w, total: point.tokens.total, calls: point.calls, costUsd: point.costUsd, stack };
  });
  const tickCount = Math.max(2, Math.min(6, Math.floor(width / 110)));
  const ticks = Array.from({ length: tickCount }, (_, i) => {
    const t = from + (span * i) / (tickCount - 1);
    return { x: scaleX(t), label: tickLabel(t, series.bucket, span) };
  });
  const grid = [0.25, 0.5, 0.75, 1].map(f => ({ y: height - f * height, label: most > 0 ? tokens(top * f) : "" }));
  return { bars, from, to, top, keys, ticks, grid };
}

/** The bar under a pointer at plot x, if the pointer sits inside a bucket. */
export function barAt(bars: readonly Bar[], x: number): Bar | null {
  return bars.find(bar => x >= bar.x && x < bar.x + Math.max(bar.w, 2)) ?? null;
}

/** The time a hover shows for one bucket: its start, or its day for day buckets. */
export function bucketTitle(t: number, bucket: UsageBucket): string {
  const date = new Date(t);
  if (bucket === "day") return date.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
  const time = date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", ...(bucket === "second" ? { second: "2-digit" } : {}) });
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" }) + " " + time;
}

/** The one ingest line under the chart. */
export function ingestLine(ingest: UsageIngest, now: number): { text: string; tone: "quiet" | "busy" | "error" } {
  if (ingest.state === "error") return { text: ingest.error ? "Usage sync failed: " + ingest.error : "Usage sync failed", tone: "error" };
  if (ingest.state === "building") return { text: `Building: ${fullTokens(ingest.filesDone)} of ${fullTokens(ingest.filesTotal)} files`, tone: "busy" };
  if (ingest.lastSyncAt === null) return { text: ingest.state === "syncing" ? "Syncing" : "Not synced yet", tone: ingest.state === "syncing" ? "busy" : "quiet" };
  const ago = Math.max(0, now - ingest.lastSyncAt);
  const when = ago < 60_000 ? `${Math.round(ago / 1000)} s ago` : ago < 3_600_000 ? `${Math.floor(ago / 60_000)} min ago` : `${Math.floor(ago / 3_600_000)} h ago`;
  return { text: `Synced ${when}`, tone: ingest.state === "syncing" ? "busy" : "quiet" };
}

/** Hover text for the ingest line: calls per source. */
export function sourceCounts(ingest: UsageIngest): string {
  if (!ingest.sources.length) return "No calls read yet";
  return ingest.sources.map(entry => `${entry.source} ${fullTokens(entry.calls)} calls`).join(" · ");
}

/** A short model name for the table: the id after the provider prefix, without a date suffix. */
export function modelLabel(model: string): string {
  return model.replace(/^[a-z0-9-]+\//i, "").replace(/-\d{8}$/, "");
}
