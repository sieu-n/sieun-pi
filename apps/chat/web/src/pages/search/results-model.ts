/**
 * The full results page's state lives in its address, `#/search?q=&from=&place=&in=&after=&before=&has=&sort=&tab=`, so back, forward and links
 * work. These turn the address into the server's search params and the filter chips (FilterBar.svelte) into address changes.
 */
import { filterParams, filterQuery, hasFilters, readFilters, type Filters } from "./filters.ts";
import type { Sort } from "./search-model.ts";

/** The results page's tabs, as Slack's: the messages, then the channels and the people whose name matches, then the wiki pages. */
export type ResultTab = "messages" | "channels" | "people" | "pages";
const TABS: readonly ResultTab[] = ["messages", "channels", "people", "pages"];

export type Results = { q: string; sort: Sort; filters: Filters; tab?: ResultTab | undefined };

export function readResults(params: Record<string, string>): Results {
  const tab = TABS.find(one => one === params.tab);
  return { q: (params.q ?? "").trim(), sort: params.sort === "recent" ? "recent" : "relevance", filters: readFilters(params), ...(tab && tab !== "messages" ? { tab } : {}) };
}

/** The address params, with defaults left out so a plain search reads `#/search?q=relay`. */
export function resultParams(results: Results): Record<string, string | undefined> {
  return { q: results.q || undefined, ...filterParams(results.filters), sort: results.sort === "recent" ? "recent" : undefined, tab: results.tab && results.tab !== "messages" ? results.tab : undefined };
}

/** What the server reads, with `from` and `place` as lists. A search with no words but a filter lists newest first; with neither it lists nothing. */
export function searchParams(results: Results): { q: string; sort: Sort } & ReturnType<typeof filterQuery> {
  return { q: results.q, sort: results.q ? results.sort : "recent", ...filterQuery(results.filters) };
}

/** Whether the page has a search to run: words, or a filter alone. */
export const searchable = (results: Results): boolean => !!results.q || hasFilters(results.filters);

export const resultCount = (n: number): string => `${n.toLocaleString("en-US")} ${n === 1 ? "result" : "results"}`;
