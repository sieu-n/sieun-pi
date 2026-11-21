import type { OwnerTodo } from "./types.ts";

/** True while the owner's Remind me hides an open todo from For you and its count (server/boards.ts, pages/board/for-you.ts). */
export const snoozed = (todo: Pick<OwnerTodo, "done" | "remindAt">, now: number): boolean =>
  !todo.done && todo.remindAt !== undefined && Date.parse(todo.remindAt) > now;
