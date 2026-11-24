/**
 * How both Usage charts draw a range: sw factory's (pages/usage/UsageChart.svelte) and Prime chat's
 * (legacy/prime/user-history/src/client/UsageSettings.svelte, which imports this file). One color per client, host and model, the y axis
 * steps, the bar width and shape, and the time labels all come from here, so one range, bucket and split look the same on both (owner,
 * 11-24, msg mwtu3137: "the chart looks different in both places").
 */
import type { UsageBucket } from "../types.ts";
import { BUCKET_MS } from "./usage-range.ts";

/** The colors a key can get. */
export const USAGE_PALETTE: readonly string[] = ["#0d74ce", "#ef5f00", "#2b9a66", "#8e4ec6", "#d6409f", "#12a594", "#c28e00", "#e5484d", "#3e63dd", "#a07553"];
/** The color of the one series that sums every key past the chart's colors. */
export const USAGE_OTHER_COLOR = "#8b8d98";

/** The keys the store holds, each with its own palette color. One chart shows one split, so a client and a model may share a color. */
const FIXED: Readonly<Record<string, number>> = {
  "pi-host": 0, prime: 1, vent: 2, "claude-code": 3, codex: 4, hermes: 5, aside: 6, "claude-desktop": 7, copilot: 8, cursor: 9,
  "us-metal02": 0, "us-metal01": 1, mac: 2,
  "claude-opus-5-5": 0, "claude-fable-5-1": 1, "gpt-6-luna": 2, "gpt-6-astra": 3, "claude-fable-5-2": 4, "gpt-6.1-sol": 5, "gpt-6-sol": 6,
  "claude-opus-5-5(high)": 7, "gpt-6.1-terra": 8, "claude-opus-5": 9,
};

/** A key's color on both pages: its own from the table, Other's gray, else one picked from its name, the same on every page and range. */
export function usageColor(key: string): string {
  if (key.toLowerCase() === "other") return USAGE_OTHER_COLOR;
  const bare = key.replace(/^[a-z0-9-]+\//i, "");
  const fixed = FIXED[bare];
  if (fixed !== undefined) return USAGE_PALETTE[fixed]!;
  let hash = 2166136261;
  for (let i = 0; i < bare.length; i++) hash = Math.imul(hash ^ bare.charCodeAt(i), 16777619);
  return USAGE_PALETTE[(hash >>> 0) % USAGE_PALETTE.length]!;
}

/** The axis top and its ticks: the smallest 1, 2, 2.5 or 5 times a power of ten at or above a quarter of `max`, as many steps as reach it. */
export function usageAxis(max: number): { top: number; ticks: number[] } {
  if (!(max > 0)) return { top: 1, ticks: [0] };
  const quarter = max / 4;
  const power = 10 ** Math.floor(Math.log10(quarter));
  const step = [1, 2, 2.5, 5, 10].map(m => m * power).find(s => s >= quarter) ?? 10 * power;
  const top = step * Math.ceil(max / step - 1e-9);
  const ticks: number[] = [];
  for (let t = 0; t <= top + step / 2; t += step) ticks.push(Number(t.toPrecision(12)));
  return { top, ticks };
}

/** The widest bar in px, the gap between two parts of a stack and the radius of a stack's top corners. */
export const USAGE_BAR = { max: 24, gap: 2, radius: 4 } as const;
/** A bar's width in a bucket `step` px wide: three quarters of it up to `USAGE_BAR.max`, and all of it when the bucket is 4 px or less. */
export const barWidth = (step: number): number => Math.max(1, Math.min(USAGE_BAR.max, step > 4 ? step * 0.75 : step));
/** One part of a stack as an SVG path, its top corners rounded when it ends the stack. */
export function barPath(x: number, top: number, w: number, h: number, round: boolean): string {
  const r = round ? Math.min(USAGE_BAR.radius, h, w / 2) : 0;
  return `M${x},${top + h}V${top + r}Q${x},${top} ${x + r},${top}H${x + w - r}Q${x + w},${top} ${x + w},${top + r}V${top + h}Z`;
}

/** The least room a time label takes, in px. */
export const LABEL_PX = 72;
/** Label strides in buckets, so labels land on round local times: 15 min, 6 h, 7 days. */
const STRIDES: Record<UsageBucket, readonly number[]> = {
  minute: [1, 5, 10, 15, 30, 60, 120, 180, 360, 720, 1440],
  hour: [1, 2, 3, 6, 12, 24, 48, 72, 168, 336],
  day: [1, 2, 7, 14, 30],
};
/** How many buckets apart the time labels of `count` buckets sit in a plot `width` px wide. */
export function tickStride(bucket: UsageBucket, count: number, width: number): number {
  const room = Math.max(2, Math.floor(Math.max(0, width) / LABEL_PX));
  const options = STRIDES[bucket];
  return options.find(option => count / option <= room) ?? options[options.length - 1]!;
}
/** Whether a time label sits on the bucket that starts at `start`: on a whole `stride` of buckets in local time, so 6-hour labels land on 0, 6, 12 and 18. */
export const onStride = (start: number, bucket: UsageBucket, stride: number): boolean =>
  Math.round((start - new Date(start).getTimezoneOffset() * 60_000) / BUCKET_MS[bucket]) % stride === 0;

export const usageDay = (start: number): string => new Date(start).toLocaleDateString(undefined, { month: "short", day: "numeric" });
/** "3 PM" for an hour or, when `short`, a whole-hour minute, else "3:05 PM". */
export const usageClock = (start: number, bucket: "minute" | "hour", short = false): string => {
  const whole = bucket === "hour" || (short && new Date(start).getMinutes() === 0);
  return new Date(start).toLocaleTimeString(undefined, whole ? { hour: "numeric" } : { hour: "numeric", minute: "2-digit" });
};
/** Milliseconds since the local midnight before `start`, in the browser's zone. */
const sinceMidnight = (start: number): number => {
  const date = new Date(start);
  return start - new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
};
/** A time label: "Nov 22" for a day or a local midnight, else "3 PM" on a whole hour and "3:05 PM" for any other minute. */
export const usageTick = (start: number, bucket: UsageBucket): string =>
  bucket === "day" || sinceMidnight(start) === 0 ? usageDay(start) : usageClock(start, bucket, true);
