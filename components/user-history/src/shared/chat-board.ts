import { normalizeArtifactTarget } from "./artifact-link.ts";
import type { ArtifactLink, BoardActor, BoardOp, ChatBoard, OwnerTodo, PlanItem, PlanItemInput, PlanStatus, ScratchItem } from "./types.ts";

/** The chat board reducer, shared by the `chat_board` tool (agent) and `POST api/threads/<id>/board` (owner). Pure and browser-safe. */

/** A user message that starts with this is the owner acting on the board (the server's steer); the client shows it as a small action line. */
export const BOARD_PREFIX = "[board] ";
export const PLAN_STATUSES: readonly PlanStatus[] = ["todo", "doing", "done", "blocked", "dropped"];
const OWNER_OPS: ReadonlySet<BoardOp["op"]> = new Set(["todo_add", "todo_update", "todo_remove", "scratch_add", "scratch_update", "scratch_remove"]);
/** `openAsks` caps the agent's open todos: past it the agent decides for itself or removes an ask first. */
export const BOARD_LIMITS = { text: 500, note: 2000, reply: 4000, planItems: 300, depth: 6, todos: 100, openAsks: 3, scratch: 200, links: 5, label: 120,
  choices: { min: 2, max: 4, text: 80 }, ops: 50 } as const;

export type BoardErrorKind = "invalid" | "forbidden" | "unknown";
export class BoardError extends Error {
  constructor(readonly kind: BoardErrorKind, message: string) { super(message); }
}

export function emptyBoard(now: string): ChatBoard { return { v: 2, rev: 0, plan: [], scratch: [], todos: [], updatedAt: now }; }

export type IdKind = "p" | "t" | "s";
/** A `newId` that continues after the highest `p<n>` (plan) / `t<n>` (todo) / `s<n>` (scratch) already on the board. */
export function nextIds(board: ChatBoard): (kind: IdKind) => string {
  const top = { p: 0, t: 0, s: 0 };
  const see = (id: string) => {
    const match = /^([pts])(\d+)$/.exec(id);
    if (match) top[match[1] as IdKind] = Math.max(top[match[1] as IdKind], Number(match[2]));
  };
  walk(board.plan, item => see(item.id));
  for (const todo of board.todos) see(todo.id);
  for (const item of board.scratch) see(item.id);
  return kind => `${kind}${++top[kind]}`;
}

/**
 * A board file's content as v2. A v1 file kept the scratchpad as one string; each non-empty line becomes a bullet (a leading "- " or "* " is
 * dropped), with no links. Throws on anything else.
 */
export function migrateBoard(value: unknown): ChatBoard {
  const board = value as Record<string, unknown>;
  if (!isRecord(value) || typeof board.rev !== "number" || !Array.isArray(board.plan) || !Array.isArray(board.todos) || typeof board.updatedAt !== "string") {
    throw new Error("Chat board file is malformed.");
  }
  if (board.v === 2 && Array.isArray(board.scratch)) return value as unknown as ChatBoard;
  if (board.v !== 1 || typeof board.scratchpad !== "string") throw new Error("Chat board file is malformed.");
  const { scratchpad, ...rest } = board;
  const lines = (scratchpad as string).split("\n").map(line => line.replace(/^\s*[-*]\s+/, "").trim()).filter(Boolean);
  const scratch: ScratchItem[] = lines.map((text, index) => ({ id: `s${index + 1}`, text: text.slice(0, BOARD_LIMITS.text), links: [], at: board.updatedAt as string }));
  return { ...(rest as unknown as Omit<ChatBoard, "v" | "scratch">), v: 2, scratch };
}

function walk(items: readonly PlanItem[], visit: (item: PlanItem, depth: number) => void, depth = 0): void {
  for (const item of items) { visit(item, depth); walk(item.children, visit, depth + 1); }
}
function countPlan(items: readonly PlanItem[]): number { let count = 0; walk(items, () => { count++; }); return count; }
function findPlan(items: readonly PlanItem[], id: string): { item: PlanItem; depth: number } | null {
  let found: { item: PlanItem; depth: number } | null = null;
  walk(items, (item, depth) => { if (!found && item.id === id) found = { item, depth }; });
  return found;
}
/** The plan with the item `id` replaced by `change(item)` (null removes it with its children). */
function mapPlan(items: readonly PlanItem[], id: string, change: (item: PlanItem) => PlanItem | null): PlanItem[] {
  const out: PlanItem[] = [];
  for (const item of items) {
    if (item.id === id) { const next = change(item); if (next) out.push(next); continue; }
    out.push(item.children.length ? { ...item, children: mapPlan(item.children, id, change) } : item);
  }
  return out;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
function invalid(message: string): never { throw new BoardError("invalid", message); }
function str(value: unknown, field: string, max: number, required = true): string {
  if (typeof value !== "string" || value.length > max) invalid(`${field} must be text up to ${max} characters.`);
  if (required && !value.trim()) invalid(`${field} cannot be empty.`);
  return value;
}
function optStr(value: unknown, field: string, max: number): string | undefined { return value === undefined ? undefined : str(value, field, max); }
function nullableStr(value: unknown, field: string, max: number): string | null | undefined { return value === null ? null : optStr(value, field, max); }
function status(value: unknown): PlanStatus | undefined {
  if (value === undefined) return undefined;
  if (!PLAN_STATUSES.includes(value as PlanStatus)) invalid(`status must be one of ${PLAN_STATUSES.join(", ")}.`);
  return value as PlanStatus;
}
function id(value: unknown, field = "id"): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,40}$/.test(value)) invalid(`${field} must be an item id such as p1 or t1.`);
  return value;
}
function planInput(value: unknown, depth: number): PlanItemInput {
  if (!isRecord(value)) invalid("Each plan item must be an object with text.");
  if (depth >= BOARD_LIMITS.depth) invalid(`The plan nests at most ${BOARD_LIMITS.depth} levels.`);
  const input: PlanItemInput = { text: str(value.text, "text", BOARD_LIMITS.text) };
  if (value.id !== undefined) input.id = id(value.id);
  const s = status(value.status); if (s) input.status = s;
  const job = optStr(value.job, "job", 200); if (job !== undefined) input.job = job;
  const note = optStr(value.note, "note", BOARD_LIMITS.note); if (note !== undefined) input.note = note;
  if (value.children !== undefined) {
    if (!Array.isArray(value.children)) invalid("children must be a list of plan items.");
    input.children = value.children.map(child => planInput(child, depth + 1));
  }
  return input;
}

const TARGET_FORMS = "job:<name>, thread:<sessionId> or thread:<sessionId>@<ms>, wiki:<path>, file:<absolute path>, or an http(s) URL";
function links(value: unknown): ArtifactLink[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > BOARD_LIMITS.links) invalid(`links must be a list of up to ${BOARD_LIMITS.links} {label, target}.`);
  return value.map(link => {
    if (!isRecord(link)) invalid("Each link must be an object with a target.");
    const target = normalizeArtifactTarget(str(link.target, "link target", 2048)) ?? invalid(`A link target must be ${TARGET_FORMS}.`);
    const label = link.label === undefined || link.label === "" ? target : str(link.label, "link label", BOARD_LIMITS.label);
    return { label: label.slice(0, BOARD_LIMITS.label), target };
  });
}
function choices(value: unknown): string[] {
  const { min, max, text } = BOARD_LIMITS.choices;
  if (!Array.isArray(value) || value.length < min || value.length > max) invalid(`choices must be a list of ${min} to ${max} answers, your recommendation first.`);
  const list = value.map(choice => str(choice, "choice", text).trim());
  if (new Set(list).size !== list.length) invalid("choices must differ from each other.");
  return list;
}

/** Parses one untrusted op (an HTTP body or a tool call). The reducer trusts its input after this. */
export function parseBoardOp(value: unknown): BoardOp {
  if (!isRecord(value)) invalid("Each op must be an object with an op field.");
  switch (value.op) {
    case "plan_set":
      if (!Array.isArray(value.items)) invalid("plan_set needs items, a list of plan items.");
      return { op: "plan_set", items: value.items.map(item => planInput(item, 0)) };
    case "plan_add": {
      const op: BoardOp = { op: "plan_add", text: str(value.text, "text", BOARD_LIMITS.text) };
      if (value.parent !== undefined && value.parent !== null) op.parent = id(value.parent, "parent");
      const s = status(value.status); if (s) op.status = s;
      const job = optStr(value.job, "job", 200); if (job !== undefined) op.job = job;
      return op;
    }
    case "plan_update": {
      const op: BoardOp = { op: "plan_update", id: id(value.id) };
      const text = optStr(value.text, "text", BOARD_LIMITS.text); if (text !== undefined) op.text = text;
      const s = status(value.status); if (s) op.status = s;
      const job = nullableStr(value.job, "job", 200); if (job !== undefined) op.job = job;
      const note = nullableStr(value.note, "note", BOARD_LIMITS.note); if (note !== undefined) op.note = note;
      return op;
    }
    case "plan_remove": return { op: "plan_remove", id: id(value.id) };
    case "scratch_add": {
      const op: BoardOp = { op: "scratch_add", text: str(value.text, "text", BOARD_LIMITS.text) };
      const list = links(value.links); if (list) op.links = list;
      return op;
    }
    case "scratch_update": {
      const op: BoardOp = { op: "scratch_update", id: id(value.id) };
      const text = optStr(value.text, "text", BOARD_LIMITS.text); if (text !== undefined) op.text = text;
      const list = links(value.links); if (list) op.links = list;
      return op;
    }
    case "scratch_remove": return { op: "scratch_remove", id: id(value.id) };
    case "todo_add": {
      const op: BoardOp = { op: "todo_add", text: str(value.text, "text", BOARD_LIMITS.text) };
      if (value.choices !== undefined) op.choices = choices(value.choices);
      return op;
    }
    case "todo_update": {
      const op: BoardOp = { op: "todo_update", id: id(value.id) };
      const text = optStr(value.text, "text", BOARD_LIMITS.text); if (text !== undefined) op.text = text;
      if (value.done !== undefined) { if (typeof value.done !== "boolean") invalid("done must be true or false."); op.done = value.done; }
      if (value.reply === null) op.reply = null;
      else if (value.reply !== undefined) op.reply = str(value.reply, "reply", BOARD_LIMITS.reply);
      return op;
    }
    case "todo_remove": return { op: "todo_remove", id: id(value.id) };
    default: return invalid("op must be one of plan_set, plan_add, plan_update, plan_remove, scratch_add, scratch_update, scratch_remove, todo_add, todo_update, todo_remove.");
  }
}

export function parseBoardOps(value: unknown): BoardOp[] {
  if (!Array.isArray(value) || value.length > BOARD_LIMITS.ops) invalid(`ops must be a list of up to ${BOARD_LIMITS.ops} board ops.`);
  return value.map(parseBoardOp);
}

const quote = (text: string) => `"${text.length > 80 ? text.slice(0, 79) + "…" : text}"`;
const markdownLink = (link: ArtifactLink) => `[${link.label}](${link.target})`;
const linkText = (list: readonly ArtifactLink[]) => list.length ? ` with links ${list.map(markdownLink).join(" ")}` : "";

/**
 * Applies one op. The board is not mutated; the result has `rev + 1` and `updatedAt: now`. `summary` is one plain sentence in the actor's
 * voice ("Owner checked ..." for the owner, "Added p3 ..." for the agent), used as the steer text and the tool result.
 */
export function applyBoardOp(board: ChatBoard, op: BoardOp, actor: BoardActor, now: string, newId: (kind: IdKind) => string): { board: ChatBoard; summary: string } {
  if (actor === "owner" && !OWNER_OPS.has(op.op)) throw new BoardError("forbidden", "The owner changes the todos and the scratchpad; the agent keeps the plan.");
  // Summaries are written lowercase ("checked ...") and voiced here: "Owner checked ..." for the owner, "Checked ..." for the agent.
  const voice = (sentence: string) => actor === "owner" ? `Owner ${sentence}` : sentence[0]!.toUpperCase() + sentence.slice(1);
  const done = (next: Partial<ChatBoard>, summary: string) => ({ board: { ...board, ...next, rev: board.rev + 1, updatedAt: now }, summary: voice(summary) });
  const unknown = (what: string, missing: string): never => { throw new BoardError("unknown", `No ${what} ${missing} on the board. Read it again with no ops.`); };
  switch (op.op) {
    case "plan_set": {
      // Ids the items keep are claimed first, so a fresh id never takes one of them; a repeated id gets a fresh one.
      const claimed = new Set<string>();
      walkInputs(op.items, input => { if (input.id) claimed.add(input.id); });
      const used = new Set<string>();
      const fresh = () => { let next = newId("p"); while (claimed.has(next)) next = newId("p"); claimed.add(next); return next; };
      const build = (input: PlanItemInput): PlanItem => {
        const itemId = input.id && !used.has(input.id) ? input.id : fresh();
        used.add(itemId);
        return { id: itemId, text: input.text, status: input.status ?? "todo", ...(input.job ? { job: input.job } : {}), ...(input.note ? { note: input.note } : {}),
          children: (input.children ?? []).map(build) };
      };
      const plan = op.items.map(build);
      if (countPlan(plan) > BOARD_LIMITS.planItems) invalid(`The plan holds at most ${BOARD_LIMITS.planItems} items.`);
      return done({ plan }, `Set the plan: ${countPlan(plan)} items`);
    }
    case "plan_add": {
      if (countPlan(board.plan) >= BOARD_LIMITS.planItems) invalid(`The plan holds at most ${BOARD_LIMITS.planItems} items.`);
      const item: PlanItem = { id: newId("p"), text: op.text, status: op.status ?? "todo", ...(op.job ? { job: op.job } : {}), children: [] };
      if (op.parent === undefined) return done({ plan: [...board.plan, item] }, `added ${item.id} ${quote(item.text)}`);
      const parent = findPlan(board.plan, op.parent) ?? unknown("plan item", op.parent);
      if (parent.depth + 1 >= BOARD_LIMITS.depth) invalid(`The plan nests at most ${BOARD_LIMITS.depth} levels.`);
      return done({ plan: mapPlan(board.plan, op.parent, p => ({ ...p, children: [...p.children, item] })) },
        `added ${item.id} ${quote(item.text)} under ${parent.item.id}`);
    }
    case "plan_update": {
      const { item } = findPlan(board.plan, op.id) ?? unknown("plan item", op.id);
      const next: PlanItem = { ...item };
      const parts: string[] = [];
      if (op.text !== undefined && op.text !== item.text) { next.text = op.text; parts.push(`renamed it ${quote(op.text)}`); }
      if (op.status !== undefined && op.status !== item.status) { next.status = op.status; parts.push(`marked it ${op.status}`); }
      if (op.job === null) { delete next.job; if (item.job) parts.push("unlinked its job"); }
      else if (op.job !== undefined && op.job !== item.job) { next.job = op.job; parts.push(`linked job ${op.job}`); }
      if (op.note === null) { delete next.note; if (item.note) parts.push("cleared its note"); }
      else if (op.note !== undefined && op.note !== item.note) { next.note = op.note; parts.push("updated its note"); }
      return done({ plan: mapPlan(board.plan, op.id, () => next) }, `updated ${item.id} ${quote(item.text)}: ${parts.join(", ") || "no change"}`);
    }
    case "plan_remove": {
      const { item } = findPlan(board.plan, op.id) ?? unknown("plan item", op.id);
      const removed = countPlan([item]);
      return done({ plan: mapPlan(board.plan, op.id, () => null) },
        `removed ${item.id} ${quote(item.text)}${removed > 1 ? ` and its ${removed - 1} ${removed === 2 ? "step" : "steps"}` : ""}`);
    }
    case "scratch_add": {
      if (board.scratch.length >= BOARD_LIMITS.scratch) invalid(`The scratchpad holds at most ${BOARD_LIMITS.scratch} notes; remove old ones first.`);
      const item: ScratchItem = { id: newId("s"), text: op.text, links: op.links ?? [], at: now };
      return done({ scratch: [...board.scratch, item] }, `added a note${actor === "owner" ? "" : " " + item.id}: ${quote(item.text)}${linkText(item.links)}`);
    }
    case "scratch_update": {
      const item = board.scratch.find(entry => entry.id === op.id) ?? unknown("note", op.id);
      const next: ScratchItem = { ...item };
      const parts: string[] = [];
      if (op.text !== undefined && op.text !== item.text) { next.text = op.text; parts.push(`rewrote it to ${quote(op.text)}`); }
      if (op.links !== undefined && JSON.stringify(op.links) !== JSON.stringify(item.links)) {
        next.links = op.links; parts.push(op.links.length ? `set its links to ${op.links.map(markdownLink).join(" ")}` : "cleared its links");
      }
      return done({ scratch: board.scratch.map(entry => entry.id === op.id ? next : entry) },
        `edited the note${actor === "owner" ? "" : " " + item.id} ${quote(item.text)}: ${parts.join(", ") || "no change"}`);
    }
    case "scratch_remove": {
      const item = board.scratch.find(entry => entry.id === op.id) ?? unknown("note", op.id);
      return done({ scratch: board.scratch.filter(entry => entry.id !== op.id) }, `removed the note ${quote(item.text)}`);
    }
    case "todo_add": {
      if (board.todos.length >= BOARD_LIMITS.todos) invalid(`The todo list holds at most ${BOARD_LIMITS.todos} items; remove done ones first.`);
      if (actor === "agent" && board.todos.filter(todo => todo.from === "agent" && !todo.done).length >= BOARD_LIMITS.openAsks) {
        invalid(`The owner already has ${BOARD_LIMITS.openAsks} open asks. Decide this yourself and note it in the scratchpad, or remove an ask first.`);
      }
      const todo: OwnerTodo = { id: newId("t"), text: op.text, done: false, ...(op.choices ? { choices: op.choices } : {}), from: actor, at: now };
      return done({ todos: [...board.todos, todo] },
        `added a todo ${actor === "owner" ? "" : todo.id + " "}${quote(todo.text)}${todo.choices ? ` with choices ${todo.choices.map(quote).join(" / ")}` : ""}`);
    }
    case "todo_update": {
      const todo = board.todos.find(entry => entry.id === op.id) ?? unknown("todo", op.id);
      const next: OwnerTodo = { ...todo };
      const parts: string[] = [];
      if (op.text !== undefined && op.text !== todo.text) { next.text = op.text; parts.push(`renamed ${quote(todo.text)} to ${quote(op.text)}`); }
      // The first part names the todo, later parts say "it".
      const label = () => parts.length ? "it" : quote(next.text);
      // A reply that is one of the offered choices is a tap: "chose X for Q", which also covers the check that comes with it.
      const chose = op.reply !== undefined && op.reply !== null && op.reply !== todo.reply && todo.choices?.includes(op.reply) === true;
      if (op.done !== undefined && op.done !== todo.done) { next.done = op.done; if (!(chose && op.done)) parts.push(`${op.done ? "checked" : "unchecked"} ${label()}`); }
      if (op.reply === null) { delete next.reply; if (todo.reply) parts.push(`cleared the answer on ${label()}`); }
      else if (chose) { next.reply = op.reply!; parts.push(`chose ${quote(op.reply!)} for ${quote(next.text)}`); }
      else if (op.reply !== undefined && op.reply !== todo.reply) { next.reply = op.reply; parts.push(parts.length ? `answered: ${op.reply}` : `answered ${label()}: ${op.reply}`); }
      return done({ todos: board.todos.map(entry => entry.id === op.id ? next : entry) }, parts.length ? parts.join(" and ") : `left ${quote(todo.text)} as it was`);
    }
    case "todo_remove": {
      const todo = board.todos.find(entry => entry.id === op.id) ?? unknown("todo", op.id);
      return done({ todos: board.todos.filter(entry => entry.id !== op.id) }, `removed the todo ${quote(todo.text)}`);
    }
  }
}

function walkInputs(items: readonly PlanItemInput[], visit: (input: PlanItemInput) => void): void {
  for (const item of items) { visit(item); walkInputs(item.children ?? [], visit); }
}

/**
 * The board as compact text for the agent: this chat's own link target, the plan as an indented checklist, the owner's todos with their choices
 * and answers, then the scratchpad bullets with their links.
 */
export function renderBoard(board: ChatBoard | null, sessionId?: string): string {
  const self = sessionId ? [`This chat: thread:${sessionId}`] : [];
  if (!board) return [...self, "The board is empty: no plan, no todos, no scratchpad."].join("\n");
  const mark: Record<PlanStatus, string> = { todo: "[ ]", doing: "[~]", done: "[x]", blocked: "[!]", dropped: "[-]" };
  const lines = [...self, `Board rev ${board.rev}, updated ${board.updatedAt}`, "Plan:"];
  if (!board.plan.length) lines.push("  (empty)");
  walk(board.plan, (item, depth) => {
    lines.push(`${"  ".repeat(depth + 1)}${mark[item.status]} ${item.id} ${item.text} (${item.status}${item.job ? `, job ${item.job}` : ""})`);
    if (item.note) lines.push(`${"  ".repeat(depth + 2)}note: ${item.note}`);
  });
  lines.push("Owner todos:");
  if (!board.todos.length) lines.push("  (empty)");
  for (const todo of board.todos) {
    const offered = todo.choices ? `, choices: ${todo.choices.map((choice, index) => quote(choice) + (index === 0 ? " (recommended)" : "")).join(" / ")}` : "";
    lines.push(`  ${todo.done ? "[x]" : "[ ]"} ${todo.id} ${todo.text} (from ${todo.from})${offered}${todo.reply !== undefined ? `, answer: ${todo.reply}` : ""}`);
  }
  lines.push("Scratchpad:");
  if (!board.scratch.length) lines.push("  (empty)");
  for (const item of board.scratch) lines.push(`  - ${item.id} ${item.text}${item.links.length ? " " + item.links.map(markdownLink).join(" ") : ""}`);
  return lines.join("\n");
}
