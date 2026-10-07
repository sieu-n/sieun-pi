import { parseArtifactTarget, normalizeArtifactTarget, type ArtifactTarget } from "../shared/artifact-link.ts";
import type { ArtifactLink, ChatBoard, OwnerTodo, PlanItem, PlanStatus } from "../shared/types.ts";

export const PLAN_STATUS_LABEL: Record<PlanStatus, string> = { todo: "To do", doing: "In progress", done: "Done", blocked: "Blocked", dropped: "Dropped" };

export interface PlanProgress { done: number; total: number }
/** Steps under a goal: every item below it that is not dropped, and how many are done. Null for an item with nothing below it. */
export function planProgress(item: PlanItem): PlanProgress | null { return item.children.length ? planTotals(item.children) : null; }
/** The same count over a list of goals, for the card header. */
export function planTotals(items: readonly PlanItem[]): PlanProgress {
  const progress = { done: 0, total: 0 };
  const walk = (list: readonly PlanItem[]) => {
    for (const child of list) {
      if (child.status !== "dropped") { progress.total++; if (child.status === "done") progress.done++; }
      walk(child.children);
    }
  };
  walk(items);
  return progress;
}

/** Every item in a tree, nested ones included. */
export const countItems = <T extends { children: T[] }>(items: readonly T[]): number => items.reduce((total, item) => total + 1 + countItems(item.children), 0);

/** A plan step the owner is done with: the chat marked it done, or dropped it. Hidden unless "Show done" is on for its parent. */
export const isFinished = (item: PlanItem): boolean => item.status === "done" || item.status === "dropped";

/** The top level's key in the per-parent "Show done" state. */
export const ROOT = "root";
/**
 * One line of a tree card, flattened in reading order. An `item` row is a plan step or a note with its depth and parent id (`ROOT` at the top).
 * A `finished` row follows a parent's shown children when some of them are done or dropped: the "Show done (n)" / "Hide done" toggle.
 */
export type TreeRow<T> = { kind: "item"; item: T; depth: number; parent: string } | { kind: "finished"; parent: string; depth: number; count: number; shown: boolean };
export interface TreeView { open: (id: string) => boolean; showDone: (parent: string) => boolean }
/**
 * The rows a tree card shows. Every item with children starts folded and opens when `open(id)` says so; finished items (per `finished`) stay off
 * the list until `showDone(parent)` is on for their parent. Notes pass no `finished` and never hide.
 */
export function treeRows<T extends { id: string; children: T[] }>(items: readonly T[], view: TreeView, finished: (item: T) => boolean = () => false): TreeRow<T>[] {
  const rows: TreeRow<T>[] = [];
  const visit = (list: readonly T[], depth: number, parent: string) => {
    const shown = view.showDone(parent);
    const hidden = list.filter(finished).length;
    for (const item of list) {
      if (!shown && finished(item)) continue;
      rows.push({ kind: "item", item, depth, parent });
      if (item.children.length && view.open(item.id)) visit(item.children, depth + 1, item.id);
    }
    if (hidden) rows.push({ kind: "finished", parent, depth, count: hidden, shown });
  };
  visit(items, 0, ROOT);
  return rows;
}

/** The dot color of an item's id chip: the same muted color on every reload, from a hash of the chat id and the item id. */
export const ID_PALETTE: readonly string[] = ["#c56b7c", "#c98a48", "#a89c38", "#67a35b", "#45a48d", "#4b9ac6", "#7b86d0", "#a878c4", "#c26ea7", "#8e8e8e"];
export function idColor(chatId: string, itemId: string): string {
  let hash = 0x811c9dc5;
  for (const char of `${chatId}:${itemId}`) { hash ^= char.codePointAt(0)!; hash = Math.imul(hash, 0x01000193) >>> 0; }
  return ID_PALETTE[hash % ID_PALETTE.length]!;
}

/** For you: the open items, newest first, and the done ones behind the "Done (N)" fold, newest first. */
export function groupTodos(todos: readonly OwnerTodo[]): { open: OwnerTodo[]; done: OwnerTodo[] } {
  const byTime = (left: OwnerTodo, right: OwnerTodo) => right.at.localeCompare(left.at);
  return { open: todos.filter(todo => !todo.done).sort(byTime), done: todos.filter(todo => todo.done).sort(byTime) };
}

/** Asks from the agent the owner has not handled; the dot on the Board tab. */
export const openAgentTodos = (board: ChatBoard | null | undefined): number => board?.todos.filter(todo => !todo.done && todo.from === "agent").length ?? 0;

export const isEmptyBoard = (board: ChatBoard | null | undefined): boolean => !board || (!board.plan.length && !board.todos.length && !board.scratch.length);

/** A user message the owner's board action sent; the feed shows it as one small line, not a bubble. */
export const BOARD_PREFIX = "[board] ";
export const isBoardAction = (text: string): boolean => text.startsWith(BOARD_PREFIX);
export const boardActionText = (text: string): string => text.slice(BOARD_PREFIX.length).trim();

/** The chip for a note's link: what kind of thing it opens, its icon, and the parsed target (null when the stored target is not one the page can open). */
export type LinkIcon = "bolt" | "message" | "book" | "file" | "globe" | "link";
export type LinkChip = { kind: ArtifactTarget["kind"] | "broken"; icon: LinkIcon; label: string; target: ArtifactTarget | null };
const LINK_ICON: Record<ArtifactTarget["kind"] | "broken", LinkIcon> = { job: "bolt", thread: "message", wiki: "book", file: "file", url: "globe", broken: "link" };
export function linkChip(link: ArtifactLink): LinkChip {
  const target = parseArtifactTarget(link.target);
  const kind = target?.kind ?? "broken";
  return { kind, icon: LINK_ICON[kind], label: link.label.trim() || linkLabel(link.target), target };
}

/** A label for a link the owner pasted: the job name, the file or page name, the site, or a short thread id. */
export function linkLabel(target: string): string {
  const parsed = parseArtifactTarget(target);
  if (!parsed) return target;
  switch (parsed.kind) {
    case "job": return parsed.name;
    case "thread": return (parsed.at === undefined ? "thread " : "message in ") + parsed.sessionId.slice(0, 8);
    case "wiki": return parsed.path.split("/").filter(Boolean).at(-1) ?? parsed.path;
    case "file": return parsed.path.split("/").filter(Boolean).at(-1) ?? parsed.path;
    case "url": {
      const url = new URL(parsed.url);
      const path = url.pathname.replace(/\/+$/, "");
      return url.hostname.replace(/^www\./, "") + (path.length > 1 && path.length <= 40 ? path : "");
    }
  }
}

/**
 * The link offer under the "Add a note" field: the last word of the draft that is a link target (a pasted URL, chat link, wiki page or
 * absolute path), with the draft text left without it. Null when no word is one.
 */
export function offeredLink(draft: string): { text: string; target: string } | null {
  const words = draft.trim().split(/\s+/).filter(Boolean);
  for (let index = words.length - 1; index >= 0; index--) {
    const target = normalizeArtifactTarget(words[index]!);
    if (target) return { text: [...words.slice(0, index), ...words.slice(index + 1)].join(" "), target };
  }
  return null;
}
