import type { ChatBoard, OwnerTodo, PlanItem, PlanStatus } from "../shared/types.ts";

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

/** For you: open items first, then done ones; newest first within each half. */
export function orderTodos(todos: readonly OwnerTodo[]): OwnerTodo[] {
  const byTime = (left: OwnerTodo, right: OwnerTodo) => right.at.localeCompare(left.at);
  return [...todos.filter(todo => !todo.done).sort(byTime), ...todos.filter(todo => todo.done).sort(byTime)];
}

/** Asks from the agent the owner has not handled; the dot on the Board tab. */
export const openAgentTodos = (board: ChatBoard | null | undefined): number => board?.todos.filter(todo => !todo.done && todo.from === "agent").length ?? 0;

export const isEmptyBoard = (board: ChatBoard | null | undefined): boolean => !board || (!board.plan.length && !board.todos.length && !board.scratchpad.trim());

/** A user message the owner's board action sent; the feed shows it as one small line, not a bubble. */
export const BOARD_PREFIX = "[board] ";
export const isBoardAction = (text: string): boolean => text.startsWith(BOARD_PREFIX);
export const boardActionText = (text: string): string => text.slice(BOARD_PREFIX.length).trim();
