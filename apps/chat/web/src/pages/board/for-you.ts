import type { BoardOp } from "$lib/api/shared/types";
import type { Ask } from "./model.ts";
import { toast } from "$lib/ui/toast.svelte";
import { snoozed } from "$lib/api/shared/snooze";

export interface ForYouItem {
  chatId: string;
  chatName: string;
  todo: Ask;
  step?: { id: string; text: string; status: string };
}

export type ForYouType = "all" | "asks" | "go" | "notes";
export type ForYouStatus = "open" | "snoozed" | "done";

export interface ForYouFilter {
  type: ForYouType;
  status: ForYouStatus;
  unansweredOnly: boolean;
}

export const DEFAULT_FILTER: ForYouFilter = { type: "all", status: "open", unansweredOnly: false };

export const TYPE_LABEL: Record<ForYouType, string> = { all: "All", asks: "Asks", go: "Needs your go", notes: "Your notes" };
export const STATUS_LABEL: Record<ForYouStatus, string> = { open: "Open", snoozed: "Snoozed", done: "Done" };

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

const statusOf = (item: ForYouItem, now: number): ForYouStatus => item.todo.done ? "done" : snoozed(item.todo, now) ? "snoozed" : "open";

/** When the row last came to the owner: when it was asked, or when its Remind me came due. */
export const shownAt = (todo: Pick<Ask, "at" | "remindAt">, now: number): string =>
  todo.remindAt && todo.remindAt > todo.at && Date.parse(todo.remindAt) <= now ? todo.remindAt : todo.at;

/** The rows the filter keeps, newest first, a todo whose Remind me came due as new as that time; snoozed rows soonest first. */
export function visibleItems(items: readonly ForYouItem[], filter: ForYouFilter, now = Date.now()): ForYouItem[] {
  const kept = items
    .filter(item => statusOf(item, now) === filter.status)
    .filter(item => ofType(item, filter.type))
    .filter(item => !filter.unansweredOnly || (item.todo.from === "agent" && !item.todo.reply));
  return filter.status === "snoozed"
    ? kept.sort((left, right) => left.todo.remindAt!.localeCompare(right.todo.remindAt!))
    : kept.sort((left, right) => shownAt(right.todo, now).localeCompare(shownAt(left.todo, now)));
}

/** The words on the filter button: "All open", "Asks, done, unanswered only". */
export function filterSummary(filter: ForYouFilter): string {
  const parts = [filter.type === "all" ? "All" : TYPE_LABEL[filter.type], STATUS_LABEL[filter.status].toLowerCase()];
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
  if (filter.status === "snoozed") return { title: "Nothing snoozed", description: "Remind me on an ask hides it here until its time." };
  if (filter.type === "notes") return { title: "No notes of yours", description: "Add a note to any chat's board to keep a todo of your own here." };
  if (filter.unansweredOnly) return { title: "No unanswered asks", description: "Every ask from your chats has your reply." };
  return { title: "Nothing waiting on you", description: "Your chats' asks, go requests and your own notes appear here." };
}

/** A one-click change on an ask that its toast can undo. */
export type AskChange = "done" | "reopen" | "remove" | "remind";

/** The op that puts an ask back as it was before `change`, which the change's toast runs as Undo. A removed note comes back as a new todo. */
export function undoOp(ask: Ask, change: AskChange): BoardOp {
  switch (change) {
    case "done": return { op: "todo_update", id: ask.id, done: false };
    case "reopen": return { op: "todo_update", id: ask.id, done: true };
    case "remind": return { op: "todo_update", id: ask.id, remindAt: ask.remindAt ?? null };
    case "remove": return {
      op: "todo_add", text: ask.text, ...(ask.choices?.length ? { choices: ask.choices } : {}), ...(ask.step ? { step: ask.step } : {}),
      ...(ask.links?.length ? { links: ask.links } : {}),
    };
  }
}

/** The toast line of a change, "Dismissed t4" for a chat's ask and "Done t9" for the owner's note; Remind me words its own (lib/remind.ts). */
export function changeWords(ask: Pick<Ask, "id" | "from">, change: Exclude<AskChange, "remind">): string {
  switch (change) {
    case "done": return `${ask.from === "agent" ? "Dismissed" : "Done"} ${ask.id}`;
    case "reopen": return `Reopened ${ask.id}`;
    case "remove": return `Removed your note ${ask.id}`;
  }
}

/**
 * Applies a one-click change on an ask and shows its toast with Undo for 6 s, as Slack's "Marked complete · Undo"; Undo applies `undoOp`.
 * A failed change or Undo shows the board's error and throws nothing.
 */
export async function changeAsk(apply: (ops: BoardOp[]) => Promise<void>, ask: Ask, change: AskChange, ops: BoardOp[], words: string): Promise<void> {
  const undo = undoOp(ask, change);
  try {
    await apply(ops);
  } catch (error) {
    toast.error(error instanceof Error ? error.message : "The board did not take that change.");
    return;
  }
  toast.success(words, {
    duration: 6000,
    action: { label: "Undo", run: () => void apply([undo]).catch((error: unknown) => toast.error(error instanceof Error ? error.message : "Undo did not reach the board.")) },
  });
}
