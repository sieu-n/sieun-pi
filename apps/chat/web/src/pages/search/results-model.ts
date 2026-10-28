/**
 * The full results page's state lives in its address, `#/search?q=&from=&in=&after=&before=&sort=&type=`, so back, forward and links
 * work. These turn the address into the server's search params and the filter chips into address changes.
 */
import { dayString } from "./operators.ts";
import type { Sort } from "./search-model.ts";

export type ResultType = "messages" | "tools";
export type Results = { q: string; from?: string; in?: string; after?: string; before?: string; sort: Sort; type?: ResultType };

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function readResults(params: Record<string, string>): Results {
  const out: Results = { q: (params.q ?? "").trim(), sort: params.sort === "recent" ? "recent" : "relevance" };
  if (params.from) out.from = params.from;
  if (params.in) out.in = params.in;
  if (params.after && DATE.test(params.after)) out.after = params.after;
  if (params.before && DATE.test(params.before)) out.before = params.before;
  if (params.type === "messages" || params.type === "tools") out.type = params.type;
  return out;
}

/** The address params, with defaults left out so a plain search reads `#/search?q=relay`. */
export function resultParams(results: Partial<Results>): Record<string, string | undefined> {
  return {
    q: results.q || undefined,
    from: results.from,
    in: results.in,
    after: results.after,
    before: results.before,
    sort: results.sort === "recent" ? "recent" : undefined,
    type: results.type,
  };
}

/** What the server reads; it returns nothing for an empty query. */
export function searchParams(results: Results): { q: string; from?: string; in?: string; after?: string; before?: string; sort: Sort; type?: ResultType } {
  const { q, sort, ...rest } = results;
  return { q, sort, ...Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined)) };
}

export type DateRange = { id: string; label: string; after?: string; before?: string };

/** Any time, Today, Yesterday, Last 7 days, Last 30 days and Last 12 months, as after/before days. */
export function dateRanges(now: Date): DateRange[] {
  const day = (back: number) => {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - back);
    return dayString(d);
  };
  return [
    { id: "any", label: "Any time" },
    { id: "today", label: "Today", after: day(0) },
    { id: "yesterday", label: "Yesterday", after: day(1), before: day(0) },
    { id: "7d", label: "Last 7 days", after: day(6) },
    { id: "30d", label: "Last 30 days", after: day(29) },
    { id: "12m", label: "Last 12 months", after: day(364) },
  ];
}

/** The chip label of a date filter: a preset's name, or the days themselves. */
export function dateLabel(results: Pick<Results, "after" | "before">, now: Date): string | undefined {
  if (!results.after && !results.before) return undefined;
  const preset = dateRanges(now).find(range => range.after === results.after && range.before === results.before);
  if (preset) return preset.label;
  if (results.after && results.before) return `${results.after} to ${results.before}`;
  return results.after ? `After ${results.after}` : `Before ${results.before}`;
}

export const resultCount = (n: number): string => `${n.toLocaleString("en-US")} ${n === 1 ? "result" : "results"}`;
