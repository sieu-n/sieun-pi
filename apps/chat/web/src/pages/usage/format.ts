/** Number formats for the Usage and Hosts pages. A short figure always has its exact value one hover away (`full`). */
import type { Measure } from "./stats";

const dollars = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
const whole = new Intl.NumberFormat("en-US");

/** USD to the cent, and a nonzero amount under a cent as such. */
export const cost = (usd: number): string => (usd > 0 && usd < 0.005 ? "<$0.01" : dollars.format(usd));
/** USD to a hundredth of a cent, for a hover that must show what a cent hides. */
const exact = new Intl.NumberFormat("en-US", { minimumFractionDigits: 4, maximumFractionDigits: 4 });
export const exactCost = (usd: number): string => `$${exact.format(usd)}`;
export const percent = (share: number): string => `${Math.round(share * 100)}%`;
/** A count in short form, 12.4M, with `noun` pluralized. */
export function count(value: number, noun?: string): string {
  const number = compact.format(value);
  return noun ? `${number} ${noun}${value === 1 ? "" : "s"}` : number;
}
/** A count with every digit. */
export const full = (value: number): string => whole.format(Math.round(value));
export const day = (start: number): string => new Date(start).toLocaleDateString(undefined, { month: "short", day: "numeric" });
/** "3 PM" for an hour or a whole-hour minute, else "3:05 PM". */
const clock = (start: number, bucket: "minute" | "hour", short = false): string => {
  const whole = bucket === "hour" || (short && new Date(start).getMinutes() === 0);
  return new Date(start).toLocaleTimeString(undefined, whole ? { hour: "numeric" } : { hour: "numeric", minute: "2-digit" });
};
/** Milliseconds since the local midnight before `start`, in the browser's zone. */
const sinceMidnight = (start: number): number => {
  const date = new Date(start);
  return start - new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
};
/** An axis label: "Nov 22" for a day or a local midnight, else "3 PM" on a whole hour and "3:05 PM" for any other minute. */
export const bucketTick = (start: number, bucket: "minute" | "hour" | "day"): string =>
  bucket === "day" || sinceMidnight(start) === 0 ? day(start) : clock(start, bucket, true);
/** The bucket a hover or a table row names: "Sat, Nov 22", "Nov 22, 3 PM" or "Nov 22, 3:05 PM". */
export const bucketName = (start: number, bucket: "minute" | "hour" | "day"): string =>
  bucket === "day" ? new Date(start).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" }) : `${day(start)}, ${clock(start, bucket)}`;
/** Where an axis label may sit: on a bucket whose local time is a whole `stride` of buckets, so 6-hour labels land on 0, 6, 12 and 18. */
export const onStride = (start: number, step: number, stride: number): boolean =>
  Math.round((start - new Date(start).getTimezoneOffset() * 60_000) / step) % stride === 0;

/** How a usage chart writes its values: what one bar counts, a short figure, its exact value for a hover or the table (c191), an axis label. */
export interface ChartFormat {
  readonly label: string;
  short(value: number): string;
  exact(value: number): string;
  tick(value: number): string;
}
/** A muted tip row a chart's caller adds under the bucket's split. */
export interface TipRow {
  readonly label: string;
  readonly value: string;
  readonly title?: string;
}

const dollarTick = (value: number): string => (value === 0 ? "$0" : `$${value < 1 ? value.toFixed(2).replace(/0$/, "") : value.toLocaleString("en-US")}`);

/** Dollars to the cent with the exact amount on hover, or tokens short with every digit on hover. */
export const chartFormat = (measure: Measure): ChartFormat =>
  measure.unit === "usd"
    ? { label: "Cost", short: cost, exact: exactCost, tick: dollarTick }
    : { label: measure.metric === "output" ? "Output tokens" : "Tokens", short: value => count(value), exact: full, tick: value => count(value) };
