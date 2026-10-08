import { parseArtifactTarget, normalizeArtifactTarget, type ArtifactTarget } from "../shared/artifact-link.ts";
import { findItem, walkItems } from "../shared/chat-board.ts";
import type { AgentLink, AgentState, ArtifactLink, ChatBoard, OwnerTodo, PlanItem, PlanStatus } from "../shared/types.ts";

export const PLAN_STATUS_LABEL: Record<PlanStatus, string> = { todo: "To do", doing: "In progress", done: "Done", blocked: "Blocked", dropped: "Dropped" };
/** The Agents card's words for an agent's state and for how it is linked to the chat (its row's title). */
export const AGENT_STATE_LABEL: Record<AgentState, string> = { working: "Working", waiting: "Waiting for the chat", idle: "Idle", done: "Done", failed: "Failed" };
export const AGENT_LINK_LABEL: Record<AgentLink, string> = { subagent: "a job of this chat", root: "a thread this chat started", step: "owns a plan step", message: "exchanged messages with this chat today" };

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

/**
 * What a step waits on, for the muted words after its text: `waitUntil` (an ISO time) reads "waits until Oct 9, 2:30 PM" in local time (the
 * year shows when it is not this year), `waitFor` reads "waits for <text>", and a step with both reads "waits for <text> until Oct 9, 2:30 PM".
 * Null when the step waits on nothing or its time does not parse.
 */
export function planWait(item: PlanItem, now = Date.now()): string | null {
  const text = item.waitFor?.trim();
  const at = item.waitUntil ? Date.parse(item.waitUntil) : NaN;
  const when = Number.isFinite(at) ? new Date(at).toLocaleString(undefined, { ...(new Date(at).getFullYear() === new Date(now).getFullYear() ? {} : { year: "numeric" }), month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "";
  if (!text && !when) return null;
  return `waits${text ? ` for ${text}` : ""}${when ? ` until ${when}` : ""}`;
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

/**
 * What a chat's text turns into chips: the board's ids with a short title each (`p<n>` plan steps, `s<n>` notes) and the names of its jobs.
 * `jobs` matches one job name written as a whole word (`at` at the start of the text, `start` anywhere; neither matches inside a word or
 * a hyphenated word). `key` changes with every board op and every new job, so a render cache can key on it. Null when the chat has
 * neither a board nor a job.
 */
export interface MentionIndex { chatId: string; key: string; titles: Map<string, string>; jobs: { at: RegExp; start: RegExp } | null }
const NAME_LIMIT = 80;
export function mentionIndex(chatId: string, board: ChatBoard | null | undefined, jobNames: readonly string[] = []): MentionIndex | null {
  const names = [...new Set(jobNames.filter(name => name.length > 1 && name.length <= NAME_LIMIT && !/\n/.test(name)))].sort((a, b) => b.length - a.length);
  if (!board && !names.length) return null;
  const titles = new Map<string, string>();
  const add = (item: { id: string; text: string }) => titles.set(item.id, shortTitle(item.text));
  walkItems(board?.plan ?? [], add);
  walkItems(board?.scratch ?? [], add);
  const alternatives = names.map(name => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const jobs = names.length ? { at: new RegExp(`^(?:${alternatives})(?![\\w-])`), start: new RegExp(`(^|[^\\w-])(?:${alternatives})(?![\\w-])`) } : null;
  return { chatId, key: `${chatId}:${board?.rev ?? 0}:${names.join("\0")}`, titles, jobs };
}
/** An item's text cut for a tooltip: the first 60 characters. */
export const shortTitle = (text: string): string => text.length > 60 ? text.slice(0, 59).trimEnd() + "\u2026" : text;

/** Every item with children, in reading order: what the plan view's collapse-all folds. */
export function parentIds<T extends { id: string; children: T[] }>(items: readonly T[]): string[] {
  const ids: string[] = [];
  walkItems(items, item => { if (item.children.length) ids.push(item.id); });
  return ids;
}
/**
 * What the plan view does to show `focus`: the parents to unfold (its ancestors), whether done items must show (the step or one above it is
 * done or dropped), and which section holds it. Null when neither tree has the id.
 */
export interface FocusPlan { section: "plan" | "notes"; unfold: string[]; showDone: boolean }
export function focusPlan(board: ChatBoard, focus: string): FocusPlan | null {
  const step = findItem(board.plan, focus);
  if (step) return { section: "plan", unfold: step.ancestors.map(item => item.id), showDone: [...step.ancestors, step.item].some(isFinished) };
  const note = findItem(board.scratch, focus);
  return note ? { section: "notes", unfold: note.ancestors.map(item => item.id), showDone: false } : null;
}

/**
 * The dot color of an item's id chip: one of ID_COLORS muted colors, the same on every reload, from a hash of the chat id and the item id.
 * The colors live in app.css (`.id-0` to `.id-9` set `--dot`), so rendered HTML can carry the color as a class: the page's CSP has no
 * inline styles.
 */
export const ID_COLORS = 10;
export function idIndex(chatId: string, itemId: string): number {
  let hash = 0x811c9dc5;
  for (const char of `${chatId}:${itemId}`) { hash ^= char.codePointAt(0)!; hash = Math.imul(hash, 0x01000193) >>> 0; }
  return hash % ID_COLORS;
}
export const idClass = (chatId: string, itemId: string): string => `id-${idIndex(chatId, itemId)}`;

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
