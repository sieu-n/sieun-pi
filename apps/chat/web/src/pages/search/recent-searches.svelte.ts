/**
 * The searches the owner ran, newest first, which the empty Cmd K field lists to pick again, remove one by one or clear, as Slack's
 * search box does. The server keeps them, so every browser and the Mac app list the same ones (lib/owner-settings.svelte.ts). The full
 * results page adds each search it shows, and the Cmd K dialog adds the words of a message hit it opens.
 *
 * `last` is what the global Cmd K field held when it closed, so the next opening shows it again, selected, in this page's session.
 */
import { RECENT_KEPT } from "$lib/api/shared/owner-settings";
import { ownerSettings } from "$lib/owner-settings.svelte";
import { NO_FILTERS, readFilters, filterParams, type Filters } from "./filters.ts";
import { recentKey, type RecentSearch } from "./search-model.ts";

class RecentSearches {
  last: { text: string; filters: Filters } = { text: "", filters: NO_FILTERS };

  get items(): RecentSearch[] {
    return ownerSettings.value.recentSearches.map(one => ({ q: one.q, filters: readFilters(one.filters) }));
  }

  /** Puts a search at the top; a search with no words and no filters is not one. */
  add(search: RecentSearch): void {
    const q = search.q.trim();
    if (!q && !Object.keys(filterParams(search.filters)).length) return;
    const entry = { q, filters: search.filters };
    const key = recentKey(entry);
    this.save([entry, ...this.items.filter(one => recentKey(one) !== key)].slice(0, RECENT_KEPT));
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
    ownerSettings.set({ recentSearches: items.map(one => ({ q: one.q, filters: filterParams(one.filters) })) });
  }
}

export const recentSearches = new RecentSearches();
