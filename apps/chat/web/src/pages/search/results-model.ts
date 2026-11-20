/**
 * The full results page's state lives in its address, `#/search?q=&from=&where=&in=&after=&before=&sort=`, so back, forward and links
 * work. These turn the address into the server's search params and the filter chips (FilterBar.svelte) into address changes.
 */
import { filterParams, filterQuery, readFilters, type Filters } from "./filters.ts";
import type { Sort } from "./search-model.ts";

export type Results = { q: string; sort: Sort; filters: Filters };

export function readResults(params: Record<string, string>): Results {
  return { q: (params.q ?? "").trim(), sort: params.sort === "recent" ? "recent" : "relevance", filters: readFilters(params) };
}

/** The address params, with defaults left out so a plain search reads `#/search?q=relay`. */
export function resultParams(results: Results): Record<string, string | undefined> {
  return { q: results.q || undefined, ...filterParams(results.filters), sort: results.sort === "recent" ? "recent" : undefined };
}

/** What the server reads, with `from` and `where` as lists; it returns nothing for an empty query. */
export function searchParams(results: Results): { q: string; sort: Sort } & ReturnType<typeof filterQuery> {
  return { q: results.q, sort: results.sort, ...filterQuery(results.filters) };
}

export const resultCount = (n: number): string => `${n.toLocaleString("en-US")} ${n === 1 ? "result" : "results"}`;
