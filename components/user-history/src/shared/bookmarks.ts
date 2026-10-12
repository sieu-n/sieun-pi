/** A chat message the owner saved: `chat` and `at` (the message's `timestamp`) name it, the same pair a Copy link carries; `text` is its preview when saved. */
export interface Bookmark { chat: string; at: number; text: string; savedAt: number }

export type BookmarkAction = { op: "add"; chat: string; at: number; text: string } | { op: "remove"; chat: string; at: number } | { op: "clear" };

export const BOOKMARK_TEXT_MAX = 300;

export const sameMessage = (a: { chat: string; at: number }, b: { chat: string; at: number }): boolean => a.chat === b.chat && a.at === b.at;

/**
 * The one line a bookmark row shows: the message without its Reply quote, markdown marks and code fences, whitespace folded,
 * cut at BOOKMARK_TEXT_MAX with an ellipsis. A message that is only a quote keeps the quote.
 */
export function bookmarkPreview(text: string): string {
  const lines = text.split("\n").filter(line => !/^\s*```/.test(line));
  const said = lines.filter(line => !/^\s*>/.test(line));
  const kept = said.some(line => line.trim()) ? said : lines.map(line => line.replace(/^\s*>\s?/, ""));
  const plain = kept.map(line => line.replace(/^\s*(#{1,6}\s+|[-*+]\s+|\d+[.)]\s+)/, "")).join(" ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\*\*|__|`/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return plain.length > BOOKMARK_TEXT_MAX ? plain.slice(0, BOOKMARK_TEXT_MAX - 1).trimEnd() + "…" : plain;
}
