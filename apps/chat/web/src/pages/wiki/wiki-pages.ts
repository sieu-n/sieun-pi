/**
 * Wiki pages in the app: the Wiki view at `#/c/wiki` (WikiPage.svelte), which lists the favorites and the pages updated last and finds a
 * page by its title, and the Cmd K "Pages" group (pages/search/search-model.ts). Both read GET /api/pages and open a page in the viewer.
 */
import type { WikiPageRow } from "../../lib/api/types.ts";

/** The Wiki view, with the words of a title search when given, as router.svelte.ts `hrefFor("messages", ["wiki"], { q })` writes it. */
export const wikiHref = (q = ""): string => (q.trim() ? `#/c/wiki?${new URLSearchParams({ q: q.trim() })}` : "#/c/wiki");

/** The wiki's own home page, the content root's index.html, which the view's header opens in the viewer. */
export const WIKI_HOME = "index.html";

const words = (slug: string): string => slug.replace(/^\d{4}-/, "").replace(/[-_]+/g, " ").trim();

/**
 * Where a page lives, in words: "agent factory job · slack style replies" for a page an agent's job wrote, "Session · walk" for a
 * session's, else its folder path, such as "domains / devops". A page at the root has no place.
 */
export function pagePlace(path: string): string {
  const job = /^agents\/([^/]+)\/jobs\/\d{4}\/\d{2}\/\d{2}\/([^/]+)\//.exec(path);
  if (job) return `${words(job[1]!)} job · ${words(job[2]!)}`;
  const session = /^sessions\/\d{4}\/\d{2}\/\d{2}\/([^/]+)\//.exec(path);
  if (session) return `Session · ${words(session[1]!)}`;
  return path.split("/").slice(0, -1).join(" / ");
}

/** The rows a list shows once per page: a favorite that is also a recent page shows under Favorites only. */
export function withoutFavorites(pages: readonly WikiPageRow[], favorites: readonly WikiPageRow[]): WikiPageRow[] {
  const liked = new Set(favorites.map(page => page.path));
  return pages.filter(page => !liked.has(page.path));
}
