/**
 * The searches the owner ran, newest first, which the empty Cmd K field lists to pick again, remove one by one or clear, as Slack's
 * search box does. They live in this browser's localStorage. The full results page adds each search it shows, and the Cmd K dialog adds
 * the words of a message hit it opens.
 *
 * `last` is what the global Cmd K field held when it closed, so the next opening shows it again, selected, in this page's session.
 */
import { NO_FILTERS, readFilters, filterParams, type Filters } from "./filters.ts";
import { recentKey, type RecentSearch } from "./search-model.ts";

const KEY = "chat.recentSearches";
/** The dialog lists 5; a few more are kept so removing some still leaves a full list. */
const KEPT = 10;

function read(): RecentSearch[] {
  try {
    const data: unknown = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    if (!Array.isArray(data)) return [];
    return data.flatMap((entry: unknown) => {
      if (!entry || typeof entry !== "object") return [];
      const { q, filters } = entry as { q?: unknown; filters?: unknown };
      if (typeof q !== "string") return [];
      const params = filters && typeof filters === "object" ? (filters as Record<string, string | undefined>) : {};
      return [{ q, filters: readFilters(params) }];
    });
  } catch {
    return [];
  }
}

class RecentSearches {
  items = $state<RecentSearch[]>(read());
  last: { text: string; filters: Filters } = { text: "", filters: NO_FILTERS };

  /** Puts a search at the top; a search with no words and no filters is not one. */
  add(search: RecentSearch): void {
    const q = search.q.trim();
    if (!q && !Object.keys(filterParams(search.filters)).length) return;
    const entry = { q, filters: search.filters };
    const key = recentKey(entry);
    this.save([entry, ...this.items.filter(one => recentKey(one) !== key)].slice(0, KEPT));
  }

  /** Removes one search and returns the list before, for an Undo. */
  remove(search: RecentSearch): RecentSearch[] {
    const before = this.items;
    const key = recentKey(search);
    this.save(before.filter(one => recentKey(one) !== key));
    return before;
  }

  /** Clears the list and returns it, for an Undo. */
  clear(): RecentSearch[] {
    const before = this.items;
    this.save([]);
    return before;
  }

  restore(items: RecentSearch[]): void {
    this.save(items);
  }

  private save(items: RecentSearch[]): void {
    this.items = items;
    try {
      localStorage.setItem(KEY, JSON.stringify(items.map(one => ({ q: one.q, filters: filterParams(one.filters) }))));
    } catch {}
  }
}

export const recentSearches = new RecentSearches();
