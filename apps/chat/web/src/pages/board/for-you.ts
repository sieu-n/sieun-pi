import type { Ask } from "./model.ts";

export interface ForYouItem {
  chatId: string;
  chatName: string;
  todo: Ask;
  step?: { id: string; text: string; status: string };
}

export type ForYouType = "all" | "asks" | "go" | "notes";
export type ForYouStatus = "open" | "done";

export interface ForYouFilter {
  type: ForYouType;
  status: ForYouStatus;
  unansweredOnly: boolean;
}

export const DEFAULT_FILTER: ForYouFilter = { type: "all", status: "open", unansweredOnly: false };

export const TYPE_LABEL: Record<ForYouType, string> = { all: "All", asks: "Asks", go: "Needs your go", notes: "Your notes" };
export const STATUS_LABEL: Record<ForYouStatus, string> = { open: "Open", done: "Done" };

/** The key a row and the route share: "<chatId>/<todoId>". */
export const itemKey = (item: Pick<ForYouItem, "chatId"> & { todo: Pick<Ask, "id"> }): string => `${item.chatId}/${item.todo.id}`;

const ofType = (item: ForYouItem, type: ForYouType): boolean => {
  switch (type) {
    case "all": return true;
    case "asks": return item.todo.from === "agent";
    case "go": return item.todo.step !== undefined;
    case "notes": return item.todo.from === "owner";
  }
};

/** The rows the filter keeps, newest first. */
export function visibleItems(items: readonly ForYouItem[], filter: ForYouFilter): ForYouItem[] {
  return items
    .filter(item => (filter.status === "done") === item.todo.done)
    .filter(item => ofType(item, filter.type))
    .filter(item => !filter.unansweredOnly || (item.todo.from === "agent" && !item.todo.reply))
    .sort((left, right) => right.todo.at.localeCompare(left.todo.at));
}

/** The words on the filter button: "All open", "Asks, done, unanswered only". */
export function filterSummary(filter: ForYouFilter): string {
  const parts = [filter.type === "all" ? "All" : TYPE_LABEL[filter.type], filter.status === "open" ? "open" : "done"];
  return parts.join(" ") + (filter.unansweredOnly ? ", unanswered only" : "");
}

/** Buzz's relative times for a list row: "just now", "5 minutes ago", "3 hours ago", "yesterday", then "Oct 6". */
export function shortAge(at: string, now: number): string {
  const ms = now - Date.parse(at);
  if (!Number.isFinite(ms)) return "";
  const minutes = Math.floor(ms / 60_000);
  const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"} ago`;
  if (minutes < 1) return "just now";
  if (minutes < 60) return plural(minutes, "minute");
  if (minutes < 24 * 60) return plural(Math.floor(minutes / 60), "hour");
  if (minutes < 48 * 60) return "yesterday";
  if (minutes < 7 * 24 * 60) return plural(Math.floor(minutes / (24 * 60)), "day");
  return new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** The empty state for a filter. */
export function emptyWords(filter: ForYouFilter): { title: string; description: string } {
  if (filter.status === "done") return { title: "Nothing done in this view", description: "Asks you answer or dismiss move here." };
  if (filter.unansweredOnly) return { title: "No unanswered asks", description: "Every ask from your chats has your reply." };
  return { title: "Nothing waiting on you", description: "Your chats' asks, go requests and your own notes appear here." };
}
