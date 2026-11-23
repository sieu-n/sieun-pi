/**
 * What the Saved page's search box and filters keep of the owner's saved items (pages/later/LaterPage.svelte), apart from the store, so
 * the rules run in a unit test (test/later/saved-filter.test.ts). The page keeps them in its URL: `?q=` the search, `?kind=` the kind and
 * `?in=` the room.
 */
import type { LaterRow, LaterState, PostLaterRow } from "./api/types";

/** A saved room post, a saved wiki page, or a /remind reminder of the owner's own text. */
export type SavedKind = "message" | "page" | "reminder";

export const SAVED_KINDS: readonly { id: SavedKind; label: string }[] = [
  { id: "message", label: "Messages" },
  { id: "page", label: "Wiki pages" },
  { id: "reminder", label: "Reminders" },
];

export type SavedFilter = { q: string; kind: SavedKind | null; room: string | null };

/** The wiki page a saved note keeps, when its text is the `[title](wiki:path)` link the viewer's Save writes. */
export function savedPage(text: string): { title: string; path: string } | null {
  const match = /^\[([^\]]*)\]\(wiki:([^)\s]+)\)$/.exec(text.trim());
  return match ? { title: match[1]!, path: match[2]! } : null;
}

export function kindOf(row: LaterRow): SavedKind {
  if (row.room !== undefined) return "message";
  return savedPage(row.text) ? "page" : "reminder";
}

/** Reads the filter from the route's params; a kind it does not know reads as none. */
export function filterOf(params: Record<string, string>): SavedFilter {
  const kind = SAVED_KINDS.find((k) => k.id === params.kind)?.id ?? null;
  return { q: params.q ?? "", kind, room: params.in || null };
}

export const filtering = (filter: SavedFilter): boolean => !!filter.q.trim() || !!filter.kind || !!filter.room;

/** The search matches the item's text, its wiki page's title, its room's name and its memo, in any case. */
export function matches(row: LaterRow, filter: SavedFilter): boolean {
  if (filter.kind && kindOf(row) !== filter.kind) return false;
  if (filter.room && row.room !== filter.room) return false;
  const q = filter.q.trim().toLowerCase();
  if (!q) return true;
  const page = savedPage(row.text);
  return [page ? page.title : row.text, row.roomName, row.memo].some((field) => !!field && field.toLowerCase().includes(q));
}

/** How many rows of each tab the filter keeps, from the three full lists the page reads. */
export function filteredCounts(lists: Record<LaterState, LaterRow[] | null>, filter: SavedFilter): Record<LaterState, number> {
  const count = (list: LaterRow[] | null) => list?.filter((row) => matches(row, filter)).length ?? 0;
  return { open: count(lists.open), archived: count(lists.archived), done: count(lists.done) };
}

/** The rooms the owner's saved posts sit in, across all three tabs, by name, for the In filter. */
export function savedRooms(lists: Record<LaterState, LaterRow[] | null>): { id: string; name: string; kind: PostLaterRow["roomKind"] }[] {
  const rooms = new Map<string, { id: string; name: string; kind: PostLaterRow["roomKind"] }>();
  for (const row of [lists.open, lists.archived, lists.done].flatMap((list) => list ?? [])) {
    if (row.room !== undefined && !rooms.has(row.room)) rooms.set(row.room, { id: row.room, name: row.roomName, kind: row.roomKind });
  }
  return [...rooms.values()].sort((a, b) => a.name.localeCompare(b.name));
}
