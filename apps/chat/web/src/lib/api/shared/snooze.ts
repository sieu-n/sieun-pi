import type { OwnerTodo } from "./types.ts";

/** True while the owner's Remind me hides an open todo from For you and its count (server/boards.ts, pages/board/for-you.ts). */
export const snoozed = (todo: Pick<OwnerTodo, "done" | "remindAt">, now: number): boolean =>
  !todo.done && todo.remindAt !== undefined && Date.parse(todo.remindAt) > now;

/** An ask that waits on the owner now: open, and no Remind me hides it. */
export const waiting = (todo: Pick<OwnerTodo, "done" | "remindAt">, now: number): boolean => !todo.done && !snoozed(todo, now);

/**
 * How many asks wait on the owner now. The For you badge, each board's row on All boards and the Board sidebar, a board's own For you heading
 * and an agent's page all count with this, so a snoozed ask leaves every count until its time and comes back to all of them.
 */
export const waitingAsks = (todos: readonly Pick<OwnerTodo, "done" | "remindAt">[], now: number): number => todos.filter(todo => waiting(todo, now)).length;
