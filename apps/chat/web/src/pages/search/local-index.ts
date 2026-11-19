/**
 * The messages the Cmd K search matches in the page, so a keystroke shows message rows without a round trip to the server. On 11-20 the
 * owner's round trip was 197 ms, and each keystroke's rows waited 399 to 474 ms at a simulated 200 ms
 * (~/work/p101-search-rtt/before-200ms.json). The pool is the server's feed of recent messages (GET /api/search/recent) and the hits of
 * the answer on screen. The server's answer replaces these rows when it comes, so the final results are the server's.
 */
import type { Hit } from "./hit-view.ts";

const fold = (text: string): string => text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

/** The word prefixes a query matches, as the server reads them (server/search-engine.ts `queryWords`). */
export function queryWords(q: string): string[] {
  return [...new Set(fold(q).match(/[\p{L}\p{N}]+/gu) ?? [])];
}

const ENTITIES: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'" };
/** A server snippet as the plain text it was cut from: its <mark> tags gone and its entities read. */
export const plainOf = (snippet: string): string => snippet.replace(/<\/?mark>/g, "").replace(/&(?:amp|lt|gt|quot|#39);/g, entity => ENTITIES[entity]!);

const escapeHtml = (text: string): string => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * About `size` words around the first match, escaped, with each matching word in <mark>: the server's snippet (pi-host index-db.ts
 * `snippetOf` under search-snippet.ts `safeSnippet`), which imports node:sqlite and so cannot load in the page.
 */
export function localSnippet(text: string, terms: readonly string[], size = 36): string {
  const words = [...text.matchAll(/[\p{L}\p{N}]+/gu)].map(m => ({ at: m.index, end: m.index + m[0].length, hit: terms.some(t => fold(m[0]).startsWith(t)) }));
  if (!words.length) return escapeHtml(text.slice(0, 200));
  const first = Math.max(0, words.findIndex(w => w.hit));
  const from = Math.max(0, Math.min(first - Math.floor(size / 4), words.length - size));
  const shown = words.slice(from, from + size);
  const start = from === 0 ? 0 : shown[0]!.at;
  const end = from + size >= words.length ? text.length : shown.at(-1)!.end;
  let out = from === 0 ? "" : "…";
  let cursor = start;
  for (const word of shown) {
    if (!word.hit) continue;
    out += `${escapeHtml(text.slice(cursor, word.at))}<mark>${escapeHtml(text.slice(word.at, word.end))}</mark>`;
    cursor = word.end;
  }
  return `${out}${escapeHtml(text.slice(cursor, end))}${end < text.length ? "…" : ""}`;
}

/** One message of the pool: its hit, its plain text and that text's folded words, read once. */
export type LocalEntry = { hit: Hit; plain: string; words: readonly string[] };

export function entryOf(hit: Hit): LocalEntry {
  const plain = plainOf(hit.text ?? hit.snippet);
  return { hit, plain, words: fold(plain).match(/[\p{L}\p{N}]+/gu) ?? [] };
}

/** How many words of the entry start with a query word, or 0 when one query word starts none: the server's rule for a document it has not indexed yet (`docMatches`). */
function score(entry: LocalEntry, terms: readonly string[]): number {
  let total = 0;
  for (const term of terms) {
    let count = 0;
    for (const word of entry.words) if (word.startsWith(term)) count++;
    if (!count) return 0;
    total += count;
  }
  return total;
}

export type LocalQuery = { q: string; in?: string | undefined; sort?: "relevance" | "recent" | undefined; limit: number };

/**
 * The hits to show before the server answers. The hits already on screen that still match stay first in their order, since the server
 * ranked them, and the feed's matches follow by score, then newest first; `recent` sorts all of them by time. Each hit's snippet is cut
 * and marked here for the new words.
 */
export function localHits(onScreen: readonly Hit[], feed: readonly LocalEntry[], query: LocalQuery): Hit[] {
  const terms = queryWords(query.q);
  if (!terms.length) return [];
  const inScope = (entry: LocalEntry) => !query.in || entry.hit.conversation.id === query.in;
  const kept = onScreen.map(entryOf).filter(entry => inScope(entry) && score(entry, terms) > 0);
  const seen = new Set(kept.map(entry => entry.hit.id));
  const found = feed.flatMap(entry => {
    if (seen.has(entry.hit.id) || !inScope(entry)) return [];
    const points = score(entry, terms);
    return points ? [{ entry, points }] : [];
  }).sort((a, b) => b.points - a.points || b.entry.hit.at - a.entry.hit.at).map(one => one.entry);
  const all = [...kept, ...found];
  if (query.sort === "recent") all.sort((a, b) => b.hit.at - a.hit.at);
  return all.slice(0, query.limit).map(({ hit: { text: _text, ...hit }, plain }) => ({ ...hit, snippet: localSnippet(plain, terms) }));
}

/** The feed of recent messages, newest first, with one entry per hit id. */
export class LocalFeed {
  private readonly byId = new Map<string, LocalEntry>();
  private sorted: LocalEntry[] | undefined;

  /** The time of the newest message held, which the next read asks the server to start after. */
  get newest(): number | undefined {
    return this.entries()[0]?.hit.at;
  }

  add(hits: readonly Hit[]): void {
    for (const hit of hits) this.byId.set(hit.id, entryOf(hit));
    this.sorted = undefined;
  }

  entries(): readonly LocalEntry[] {
    return (this.sorted ??= [...this.byId.values()].sort((a, b) => b.hit.at - a.hit.at));
  }
}
