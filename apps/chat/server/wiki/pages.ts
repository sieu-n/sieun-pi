/**
 * The wiki pages a person can open from the app: GET /api/pages answers the Cmd K "Pages" group and the Wiki view (#/c/wiki).
 *
 *   GET /api/pages?q=<words>&limit=<n>   the pages whose title, headings, description or path match, a title match first
 *   GET /api/pages                       the owner's favorite pages and the pages updated last
 *
 * Both read the wiki engine's agent API (search, recent, favorites, find) with session and job folders included, because the pages
 * agents write land in their job folders. Only pages are listed, HTML and markdown, so a job's .txt and .json files stay out.
 *
 * The list with no words is kept (`WikiPageList`) and answered at once. Read fresh, it took 196 to 260 ms on 11-24 and up to 826 ms on the
 * owner's own call of 11-23 22:18Z: the engine's recent rows came to 4.6 MB for 160 rows, since a job's harness_state.json carries 320 KB
 * of search text, and the four favorites were four finds the engine runs one after another (~/work/wiki-page-list/report.md).
 */
import type { WikiPageRow, WikiPages } from "../../web/src/lib/api/types.ts";
import type { WikiEngine } from "./engine.ts";

type Engine = Pick<WikiEngine, "call">;

const PAGE = /\.(html?|md)$/i;
/** A session or job log, the folder's own index.html; the Wiki view's recent list shows the pages in the folder instead. */
const SESSION_LOG = /^(?:sessions|agents\/[^/]+\/jobs)\/\d{4}\/\d{2}\/\d{2}\/[^/]+\/index\.html$/;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
/** The engine ranks by how many words match and returns its top rows; a wider pool lets an exact title from lower down move up. */
const POOL = 80;

type EngineRow = { path?: unknown; title?: unknown; description?: unknown; updated?: unknown };

const rowOf = (row: EngineRow): WikiPageRow | null => {
  if (typeof row.path !== "string" || !PAGE.test(row.path)) return null;
  return {
    path: row.path,
    title: typeof row.title === "string" && row.title.trim() ? row.title.trim() : row.path.split("/").at(-1)!,
    description: typeof row.description === "string" && row.description.trim() ? row.description.trim() : null,
    updated: typeof row.updated === "string" ? row.updated : "",
  };
};

const fold = (text: string): string => text.toLowerCase().replace(/\s+/g, " ").trim();

/** 0 for a title that is the query, 1 for one that starts with it, 2 for one that holds every word, 3 for any other match. */
export function titleRank(title: string, query: string): number {
  const t = fold(title);
  const q = fold(query);
  if (t === q) return 0;
  if (t.startsWith(q)) return 1;
  return q.split(" ").every(word => t.includes(word)) ? 2 : 3;
}

async function rows(engine: Engine, path: string): Promise<WikiPageRow[]> {
  const got = await engine.call("GET", path);
  const body = got.body as { results?: EngineRow[] } | null;
  if (got.status !== 200 || !Array.isArray(body?.results)) throw new Error(`The wiki engine answered ${got.status} to ${path.split("?")[0]}.`);
  return body.results.flatMap(row => rowOf(row) ?? []);
}

async function favorites(engine: Engine): Promise<WikiPageRow[]> {
  const got = await engine.call("GET", "/api/agent/favorites");
  const paths = (got.body as { favorites?: unknown } | null)?.favorites;
  if (got.status !== 200 || !Array.isArray(paths)) return [];
  const found = await Promise.all(
    paths.filter((p): p is string => typeof p === "string").slice(0, MAX_LIMIT).map(p =>
      rows(engine, `/api/agent/find?${new URLSearchParams({ glob: p, includeSessions: "true", limit: "1" })}`).then(r => r[0] ?? null, () => null),
    ),
  );
  return found.filter((row): row is WikiPageRow => row !== null);
}

/** The favorites and the pages updated last, `MAX_LIMIT` of them, which each answer cuts to its own limit. */
async function listed(engine: Engine): Promise<Omit<WikiPages, "query" | "refreshing">> {
  const [liked, recent] = await Promise.all([
    favorites(engine),
    rows(engine, `/api/agent/recent?${new URLSearchParams({ limit: String(POOL * 2), includeSessions: "true" })}`),
  ]);
  return { favorites: liked, pages: recent.filter(row => !SESSION_LOG.test(row.path)).slice(0, MAX_LIMIT) };
}

/** How old the kept list may be before an answer reads the wiki again behind it: the engine's own index is up to 5 s old (apps/wiki wiki.ts `CACHE_TTL_MS`). */
export const FRESH_MS = 5_000;

/**
 * GET /api/pages. A search asks the engine each time, so its matches are the engine's own. The list with no words comes from the last read
 * of it, and an answer from a read older than `FRESH_MS` starts the next read behind it and says so (`refreshing`), so the page asks once
 * more for the pages written since. Only the first call, or one after a failed first read, waits on the engine.
 */
export class WikiPageList {
  private kept: { at: number; list: Omit<WikiPages, "query" | "refreshing"> } | undefined;
  private reading: Promise<void> | undefined;

  constructor(private readonly engine: Engine, private readonly now: () => number = Date.now) {}

  async get(q: string, limit = DEFAULT_LIMIT): Promise<WikiPages> {
    const query = q.trim().slice(0, 256);
    const size = Math.min(Math.max(1, Math.floor(limit) || DEFAULT_LIMIT), MAX_LIMIT);
    if (query) {
      const found = await rows(this.engine, `/api/agent/search?${new URLSearchParams({ q: query, limit: String(POOL), includeSessions: "true" })}`);
      const ranked = found.map((row, at) => ({ row, at, rank: titleRank(row.title, query) })).sort((a, b) => a.rank - b.rank || a.at - b.at);
      return { query, favorites: [], pages: ranked.slice(0, size).map(one => one.row), refreshing: false };
    }
    if (!this.kept) await this.read();
    else if (this.now() - this.kept.at >= FRESH_MS) void this.read().catch(() => undefined);
    const { list } = this.kept!;
    return { query, favorites: list.favorites, pages: list.pages.slice(0, size), refreshing: this.reading !== undefined };
  }

  /** One read of the list at a time; a call that comes while one runs shares it. */
  private read(): Promise<void> {
    if (this.reading) return this.reading;
    const at = this.now();
    const reading = listed(this.engine).then(list => {
      this.kept = { at, list };
    }).finally(() => {
      this.reading = undefined;
    });
    this.reading = reading;
    return reading;
  }
}
