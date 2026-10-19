import { parseArtifactTarget, type ArtifactTarget } from "../shared/artifact-link.ts";
import { findItem, walkItems } from "../shared/chat-board.ts";
import { ARTIFACT_ICON, type IconName } from "./icons.ts";
import type { AgentLink, AgentState, ArtifactLink, ChatAgent, ChatBoard, OwnerTodo, PlanItem, PlanStatus, QueuePlace } from "../shared/types.ts";

export const PLAN_STATUS_LABEL: Record<PlanStatus, string> = { todo: "To do", doing: "In progress", done: "Done", blocked: "Blocked", dropped: "Dropped" };
/** The Agents card's words for an agent's state and for how it is linked to the chat (its row's title). */
export const AGENT_STATE_LABEL: Record<AgentState, string> = { working: "Working", waiting: "Waiting for the chat", idle: "Idle", done: "Done", failed: "Failed" };
export const AGENT_LINK_LABEL: Record<AgentLink, string> = { subagent: "a job of this chat", root: "a thread this chat started", step: "owns a plan step", message: "exchanged messages with this chat today" };
/** An Agents row's count of the subagents it spawned, "3 sub", how many of them run (a dot in the row) and its title; null when it spawned none. */
export const agentSubagents = (agent: ChatAgent): { text: string; running: number; title: string } | null => {
  const running = agent.subagentsRunning ?? 0;
  const total = Math.max(agent.subagentsTotal ?? 0, running);
  if (!total) return null;
  const spawned = `${total} ${total === 1 ? "subagent" : "subagents"}`;
  return { text: `${total} sub`, running, title: running ? `${spawned}, ${running} running` : `${spawned}, none running` };
};

/**
 * The agent chip after a plan step's text: the Agents row that owns the step (`ChatAgent.steps`), else the thread the step stored in `sessionId`
 * (or a `thread:<id>` owner) with no state known, else the owner the chat wrote in `job`. A bare session id shows as its first 8 characters.
 * Null for a step with no owner.
 */
export interface StepAgent { name: string; state: AgentState | null; sessionId?: string; agent?: ChatAgent; job?: string }
export function stepAgent(item: PlanItem, agents: readonly ChatAgent[]): StepAgent | null {
  const agent = agents.find(entry => entry.steps.includes(item.id));
  if (agent) return { name: agent.name, state: agent.state, ...(agent.sessionId ? { sessionId: agent.sessionId } : {}), agent };
  const job = item.job?.trim() || undefined;
  const target = job ? parseArtifactTarget(job) : null;
  const sessionId = item.sessionId ?? (target?.kind === "thread" ? target.sessionId : undefined);
  const short = (name: string) => /^[0-9a-f]{8}-/.test(name) ? name.slice(0, 8) : name;
  if (sessionId) return { name: short(job && target?.kind !== "thread" ? job : sessionId), state: null, sessionId };
  return job ? { name: short(job), state: null, job } : null;
}
/** A queued agent's place, from `pi-pool queue --json`: "Queued 3 of 7, waiting 4 min". Only tooltips show it. */
export function queueText(place: QueuePlace, now: number): string {
  const minutes = Math.floor(Math.max(0, now - place.since) / 60_000);
  const wait = minutes < 1 ? "under 1 min" : minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
  return `Queued ${place.position} of ${place.total}, waiting ${wait}`;
}
/** What the Agents card writes for a queued agent; its place in the queue and the wait go in the tooltip (owner 10-16: the queue numbers were noise). */
export const QUEUED_TEXT = "waiting for a turn";
/** The chip's tooltip: the agent's name, its state in the Agents card's words, its queue place when it waits for a turn, and its session id. */
export const stepAgentTitle = (chip: StepAgent, name = chip.name, queued = ""): string =>
  [name, queued || (chip.state ? AGENT_STATE_LABEL[chip.state] : ""), chip.sessionId ?? ""].filter(Boolean).join(" · ");

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
 * the list until `showDone(parent)` is on for their parent.
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
 * What a chat's text turns into chips: the board's plan and todo ids (`p<n>`, `t<n>`) and the chat's duty ids (`d<n>`), with a short title
 * each, and the names of its jobs.
 * `jobs` matches one job name written as a whole word (`at` at the start of the text, `start` anywhere; neither matches inside a word or
 * a hyphenated word). `key` changes with every board op, every new job and every duty change, so a render cache can key on it. Null when
 * the chat has no board, job or duty.
 */
export interface MentionIndex { chatId: string; key: string; titles: Map<string, string>; jobs: { at: RegExp; start: RegExp } | null }
const NAME_LIMIT = 80;
export function mentionIndex(chatId: string, board: ChatBoard | null | undefined, jobNames: readonly string[] = [],
  duties: readonly { id: string; name: string }[] = []): MentionIndex | null {
  const names = [...new Set(jobNames.filter(name => name.length > 1 && name.length <= NAME_LIMIT && !/\n/.test(name)))].sort((a, b) => b.length - a.length);
  if (!board && !names.length && !duties.length) return null;
  const titles = new Map<string, string>();
  const add = (item: { id: string; text: string }) => titles.set(item.id, shortTitle(item.text));
  walkItems(board?.plan ?? [], add);
  for (const todo of board?.todos ?? []) add(todo);
  for (const duty of duties) if (/^d\d+$/.test(duty.id)) titles.set(duty.id, shortTitle(duty.name));
  const alternatives = names.map(name => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const jobs = names.length ? { at: new RegExp(`^(?:${alternatives})(?![\\w-])`), start: new RegExp(`(^|[^\\w-])(?:${alternatives})(?![\\w-])`) } : null;
  return { chatId, key: `${chatId}:${board?.rev ?? 0}:${names.join("\0")}:${duties.map(duty => duty.id + duty.name).join("\0")}`, titles, jobs };
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
 * What the plan view does to show `focus`: the parents to unfold (its ancestors) and whether done items must show (the step or one above it
 * is done or dropped). Null when the plan has no such id.
 */
export interface FocusPlan { unfold: string[]; showDone: boolean }
export function focusPlan(board: ChatBoard, focus: string): FocusPlan | null {
  const step = findItem(board.plan, focus);
  return step ? { unfold: step.ancestors.map(item => item.id), showDone: [...step.ancestors, step.item].some(isFinished) } : null;
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

export const isEmptyBoard = (board: ChatBoard | null | undefined): boolean => !board || (!board.plan.length && !board.todos.length);

/** A user message the owner's board action sent; the feed shows it as one small line, not a bubble. */
export const BOARD_PREFIX = "[board] ";
export const isBoardAction = (text: string): boolean => text.startsWith(BOARD_PREFIX);
export const boardActionText = (text: string): string => text.slice(BOARD_PREFIX.length).trim();

/** The chip for a note's link: what kind of thing it opens, its icon, and the parsed target (null when the stored target is not one the page can open). */
export type LinkChip = { kind: ArtifactTarget["kind"] | "broken"; icon: IconName; label: string; target: ArtifactTarget | null };
export function linkChip(link: ArtifactLink): LinkChip {
  const target = parseArtifactTarget(link.target);
  const kind = target?.kind ?? "broken";
  return { kind, icon: ARTIFACT_ICON[kind], label: link.label.trim() || linkLabel(link.target), target };
}

/** A label for a link: the job name, the file or page name, the site, or a short thread id. */
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
 * What a plan row shows besides its title and its "needs your go" mark, in the board panel or in the plan view. In the panel a goal (a row
 * with children) shows its progress only, and a step shows its agent and its wait; neither shows a note or requirement lines, folded or open
 * (owner 10-16: "if human can't read it it's pointless"). The plan view adds the agent to goals and shows the note and requirement lines.
 */
export interface RowParts { progress: boolean; agent: boolean; wait: boolean; note: boolean; requirements: boolean }
export function rowParts(item: { children: readonly unknown[] }, where: "panel" | "view"): RowParts {
  const goal = item.children.length > 0;
  if (where === "panel") return { progress: goal, agent: !goal, wait: !goal, note: false, requirements: false };
  return { progress: goal, agent: true, wait: false, note: true, requirements: true };
}

/** Words that end in a period inside a sentence, so the cut does not stop after them. */
const ABBREVIATIONS = new Set(["e.g", "i.e", "vs", "etc", "approx", "incl", "no", "cf", "mr", "ms", "dr"]);
/** Above this many words a first sentence is cut at the limit and ends in an ellipsis. */
export const NOTE_WORDS = 25;
/**
 * A step note cut for the plan view: its first sentence, or its first line when that comes first. A sentence ends at ".", "!" or "?" before a
 * space, except after an abbreviation such as "e.g." or a list number at the start. A first sentence over NOTE_WORDS words keeps its first
 * NOTE_WORDS words and an ellipsis. `cut` is true when `text` is shorter than the whole note, so the view offers the rest on a click.
 */
export function firstSentence(note: string): { text: string; cut: boolean } {
  const whole = note.trim();
  const line = whole.split(/\n/, 1)[0]!.trim();
  let sentence = line;
  for (const match of line.matchAll(/[.!?]+(?=\s|$)/g)) {
    const before = line.slice(0, match.index);
    const word = before.split(/\s+/).at(-1)!.toLowerCase();
    if (match[0] === "." && (ABBREVIATIONS.has(word) || (/^\d+$/.test(word) && !before.trim().includes(" ")))) continue;
    sentence = line.slice(0, match.index + match[0].length);
    break;
  }
  const words = sentence.split(/\s+/).filter(Boolean);
  const text = words.length > NOTE_WORDS ? words.slice(0, NOTE_WORDS).join(" ").replace(/[,;:.]+$/, "") + "\u2026" : sentence;
  return { text, cut: text !== whole };
}
