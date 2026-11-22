/**
 * The lists of every board, All boards (GET /api/boards) and For you (GET /api/for-you), brought up to date from one board's change
 * (server/boards.ts `BoardLists`), the same way on the server and in the page.
 */
import type { BoardRow, ForYouItem } from "../types.ts";

/** For you's order: newest ask first, and asks of one time in the order the server lists their chats and each board lists them. */
export const newestAskFirst = (a: ForYouItem, b: ForYouItem): number => b.todo.at.localeCompare(a.todo.at);

/**
 * All boards with one chat's row in place of its old one, or without it for `null`. A row the list does not hold yet has no known place,
 * since the server lists chats in its own order, so the answer is `undefined` and the caller reads the list again.
 */
export function withRow(rows: readonly BoardRow[], chatId: string, row: BoardRow | null): BoardRow[] | undefined {
  const at = rows.findIndex(each => each.chatId === chatId);
  if (row === null) return at < 0 ? [...rows] : rows.filter(each => each.chatId !== chatId);
  if (at < 0) return undefined;
  return rows.map((each, i) => (i === at ? row : each));
}

/** For you with one chat's asks in place of its old ones. */
export const withAsks = (items: readonly ForYouItem[], chatId: string, asks: readonly ForYouItem[]): ForYouItem[] =>
  [...items.filter(item => item.chatId !== chatId), ...asks].sort(newestAskFirst);
