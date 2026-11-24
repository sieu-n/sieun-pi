/** Number formats for the Usage and Hosts pages. A short figure always has its exact value one hover away (`full`). */
import { usageClock, usageDay } from "$lib/api/shared/usage-chart";
import type { Measure } from "./stats";

const dollars = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
const whole = new Intl.NumberFormat("en-US");

/**
 * USD on a grid of a billionth of a dollar. The page sums one range two ways, by chat rows and by chart buckets, and float sums in two orders
 * of the same calls end on either side of a half cent or half of a hundredth of a cent: 5.025149999 and 5.025150001 printed $5.0251 over the
 * kinds and $5.0252 under the chart for the same calls (usage.spec, 11-23). Both land on one value here, so every figure rounds alike.
 */
const usdGrid = (usd: number): number => Math.round(usd * 1e9) / 1e9;
/** USD to the cent, and a nonzero amount under a cent as such. */
export const cost = (usd: number): string => (usd > 0 && usd < 0.005 ? "<$0.01" : dollars.format(usdGrid(usd)));
/** USD to a hundredth of a cent, for a hover that must show what a cent hides. */
const exact = new Intl.NumberFormat("en-US", { minimumFractionDigits: 4, maximumFractionDigits: 4 });
export const exactCost = (usd: number): string => `$${exact.format(usdGrid(usd))}`;
export const percent = (share: number): string => `${Math.round(share * 100)}%`;
/** A count in short form, 12.4M, with `noun` pluralized. */
export function count(value: number, noun?: string): string {
  const number = compact.format(value);
  return noun ? `${number} ${noun}${value === 1 ? "" : "s"}` : number;
}
/** A count with every digit. */
export const full = (value: number): string => whole.format(Math.round(value));
/** The bucket a hover or a table row names: "Sat, Nov 22", "Nov 22, 3 PM" or "Nov 22, 3:05 PM". */
export const bucketName = (start: number, bucket: "minute" | "hour" | "day"): string =>
  bucket === "day" ? new Date(start).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" }) : `${usageDay(start)}, ${usageClock(start, bucket)}`;

/** How a usage chart writes its values: what one bar counts, a short figure, its exact value for a hover or the table (c191), an axis label. */
export interface ChartFormat {
  readonly label: string;
  short(value: number): string;
  exact(value: number): string;
  tick(value: number): string;
  /** A tip figure, `short` when absent: tokens show every digit there, since the tip is the hover. */
  tip?(value: number): string;
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
    : { label: measure.metric === "output" ? "Output tokens" : "Tokens", short: value => count(value), exact: full, tick: value => count(value), tip: full };
