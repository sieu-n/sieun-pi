import { parseArtifactTarget, normalizeArtifactTarget, type ArtifactTarget } from "../shared/artifact-link.ts";
import type { ArtifactLink, ChatBoard, OwnerTodo, PlanItem, PlanStatus } from "../shared/types.ts";

export const PLAN_STATUS_LABEL: Record<PlanStatus, string> = { todo: "To do", doing: "In progress", done: "Done", blocked: "Blocked", dropped: "Dropped" };

export interface PlanProgress { done: number; total: number }
/** Steps under a goal: every item below it that is not dropped, and how many are done. Null for an item with nothing below it. */
export function planProgress(item: PlanItem): PlanProgress | null {
  if (!item.children.length) return null;
  const progress = { done: 0, total: 0 };
  const walk = (items: readonly PlanItem[]) => {
    for (const child of items) {
      if (child.status !== "dropped") { progress.total++; if (child.status === "done") progress.done++; }
      walk(child.children);
    }
  };
  walk(item.children);
  return progress;
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
