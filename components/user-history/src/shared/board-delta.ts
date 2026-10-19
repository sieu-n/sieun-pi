import type { ChatBoard, OwnerTodo, PlanItem } from "./types.ts";

/** A board's revision as a reconnecting page names it (`ThreadHave.board`), and the base a `BoardDelta` follows. */
export const boardKey = (board: ChatBoard): string => `${board.rev}|${board.updatedAt}`;

/**
 * The board as a page gets it: the fields `ChatBoard` names. A board file can carry more, such as the `scratch` list v1 boards kept, which
 * nothing reads; on 10-18 it was 92 KB of 01a1164b's 459 KB board, and a board delta carried it on every change.
 */
export function feedBoard(board: ChatBoard): ChatBoard {
  const { v, rev, plan, todos, updatedAt, lastIds } = board;
  return { v, rev, plan, todos, updatedAt, ...(lastIds ? { lastIds } : {}) };
}

/** A plan item with its children named by id, so a change to one item sends that item and not the subtree under it. */
export type FlatPlanItem = Omit<PlanItem, "children"> & { children: string[] };

/**
 * A board change for a page that holds the board `base` names: the board's own fields (`top`), the plan items and todos that changed or came
 * new, and the top-level plan order (`roots`) and todo order (`todoIds`) only when they changed. An item no root reaches any more is gone.
 * On 10-18 the feed sent the whole board on every change, 456 KB for 01a1164b, while a change touched one item.
 */
export interface BoardDelta {
  type: "board-delta";
  base: string;
  top: Omit<ChatBoard, "plan" | "todos">;
  plan: FlatPlanItem[];
  roots?: string[];
  todos: OwnerTodo[];
  todoIds?: string[];
}

/** What one board change touched: the ids of the plan items and todos that differ or came new, and whether either order changed. */
export interface BoardStep { plan: string[]; roots: boolean; todos: string[]; todoIds: boolean }

/** The board's plan items by id, children as ids, or null when two items share an id and no delta can name them. */
export function flatPlan(board: ChatBoard): Map<string, FlatPlanItem> | null {
  const items = new Map<string, FlatPlanItem>();
  const walk = (list: readonly PlanItem[]): boolean => list.every(item => {
    if (items.has(item.id)) return false;
    const { children, ...rest } = item;
    items.set(item.id, { ...rest, children: children.map(child => child.id) });
    return walk(children);
  });
  return walk(board.plan) ? items : null;
}

const same = (left: readonly string[], right: readonly string[]) => left.length === right.length && left.every((id, index) => id === right[index]);

/** What changed from `before` to `after`, or null when either board repeats an id. */
export function boardStep(before: ChatBoard, after: ChatBoard): BoardStep | null {
  const old = flatPlan(before), now = flatPlan(after);
  const oldTodos = new Map(before.todos.map(todo => [todo.id, todo])), nowTodos = new Map(after.todos.map(todo => [todo.id, todo]));
  if (!old || !now || oldTodos.size !== before.todos.length || nowTodos.size !== after.todos.length) return null;
  const changed = <Item>(was: Map<string, Item>, is: Map<string, Item>) => [...is].filter(([id, item]) => JSON.stringify(was.get(id)) !== JSON.stringify(item)).map(([id]) => id);
  return { plan: changed(old, now), roots: !same(before.plan.map(item => item.id), after.plan.map(item => item.id)),
    todos: changed(oldTodos, nowTodos), todoIds: !same(before.todos.map(todo => todo.id), after.todos.map(todo => todo.id)) };
}

/** The delta from the board `base` names to `board`, given every step between them in order. */
export function boardDelta(base: string, board: ChatBoard, steps: readonly BoardStep[]): BoardDelta {
  const { plan, todos, ...top } = board;
  const items = flatPlan(board)!;
  const planIds = new Set(steps.flatMap(step => step.plan)), todoIds = new Set(steps.flatMap(step => step.todos));
  return { type: "board-delta", base, top, plan: [...planIds].flatMap(id => items.get(id) ?? []), todos: todos.filter(todo => todoIds.has(todo.id)),
    ...(steps.some(step => step.roots) ? { roots: plan.map(item => item.id) } : {}), ...(steps.some(step => step.todoIds) ? { todoIds: todos.map(todo => todo.id) } : {}) };
}

/** The board after `delta`, or null when `board` is not the one the delta follows. */
export function applyBoardDelta(board: ChatBoard, delta: BoardDelta): ChatBoard | null {
  const items = boardKey(board) === delta.base ? flatPlan(board) : null;
  if (!items) return null;
  for (const item of delta.plan) items.set(item.id, item);
  const tree = (ids: readonly string[]): PlanItem[] => ids.flatMap(id => {
    const item = items.get(id);
    return item ? [{ ...item, children: tree(item.children) }] : [];
  });
  const todos = new Map(board.todos.map(todo => [todo.id, todo]));
  for (const todo of delta.todos) todos.set(todo.id, todo);
  return { ...delta.top, plan: tree(delta.roots ?? board.plan.map(item => item.id)), todos: (delta.todoIds ?? board.todos.map(todo => todo.id)).flatMap(id => todos.get(id) ?? []) };
}

/**
 * The board a page holds from its thread feed. A delta that follows it applies; one that does not, after a missed frame or the owner's own
 * change shown before the server's, makes it ask for the whole board once (`fetchBoard`) and apply the deltas that came meanwhile. A board or
 * delta older than the one held is dropped.
 */
export class BoardFollower {
  board: ChatBoard | null = null;
  private waiting: BoardDelta[] | null = null;

  constructor(private readonly fetchBoard: () => Promise<ChatBoard | null>, private readonly onBoard: (board: ChatBoard) => void) {}

  get key(): string | undefined { return this.board ? boardKey(this.board) : undefined; }

  /**
   * The board this browser kept from an earlier load (client/board-cache.ts), which the feed was told the page holds. Deltas wait until it is
   * read; a read that finds none asks for the whole board, since the feed sends none for a board it takes the page to hold.
   */
  seed(cached: Promise<ChatBoard | null>): void {
    if (this.board || this.waiting) return;
    this.waiting = [];
    void cached.catch(() => null).then(board => {
      const queued = this.waiting ?? [];
      this.waiting = null;
      if (board) this.hold(board);
      if (this.board) for (const delta of queued) this.take(delta);
      else this.refetch(queued);
    });
  }

  take(event: { type: "board"; board: ChatBoard } | BoardDelta): void {
    if (event.type === "board") { this.hold(event.board); return; }
    if (this.waiting) { this.waiting.push(event); return; }
    if (this.board && event.top.rev <= this.board.rev && event.base !== this.key) return;
    const next = this.board && applyBoardDelta(this.board, event);
    if (next) { this.board = next; this.onBoard(next); return; }
    this.refetch([event]);
  }

  private refetch(queued: BoardDelta[]): void {
    this.waiting = queued;
    void this.fetchBoard().catch(() => null).then(board => {
      const queued = this.waiting ?? [];
      this.waiting = null;
      if (board) this.hold(board);
      for (const delta of queued) if (this.board && delta.top.rev > this.board.rev) { const next = applyBoardDelta(this.board, delta); if (next) { this.board = next; this.onBoard(next); } }
    });
  }

  private hold(board: ChatBoard): void {
    if (this.board && board.rev < this.board.rev) return;
    this.board = board;
    this.onBoard(board);
  }
}
