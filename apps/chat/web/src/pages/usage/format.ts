/** Number formats for the Usage and Hosts pages. A short figure always has its exact value one hover away (`full`). */

const dollars = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
const whole = new Intl.NumberFormat("en-US");

/** USD to the cent, and a nonzero amount under a cent as such. */
export const cost = (usd: number): string => (usd > 0 && usd < 0.005 ? "<$0.01" : dollars.format(usd));
/** USD to a hundredth of a cent, for a hover that must show what a cent hides. */
export const exactCost = (usd: number): string => `$${usd.toFixed(4)}`;
export const percent = (share: number): string => `${Math.round(share * 100)}%`;
/** A count in short form, 12.4M, with `noun` pluralized. */
export function count(value: number, noun?: string): string {
  const number = compact.format(value);
  return noun ? `${number} ${noun}${value === 1 ? "" : "s"}` : number;
}
/** A count with every digit. */
export const full = (value: number): string => whole.format(Math.round(value));
export const day = (start: number): string => new Date(start).toLocaleDateString(undefined, { month: "short", day: "numeric" });
