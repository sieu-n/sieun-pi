import { parseSkillBlock } from "prime-agent";

/** A skill invocation stored expanded reads as what the person typed. */
export const taskText = (first: string): string => first.trimStart().startsWith("<skill") ? parseSkillBlock(first)?.userMessage ?? "" : first;
/**
 * The most of a first task that `firstTask` and `sessionTitle` read. A row keeps its `firstMessage` cut to it (`keptFirst`): on 11-03 the 9,200
 * rows of us-metal02's session copy held 62.2 M characters of firstMessage, 60 MB of the copy's 66 MB, and the heap profile of the 10:03Z
 * start held 176 MB of its 353 MB live heap under readCopy. Cut, the same rows hold 14.8 M characters.
 */
export const FIRST_TASK_CHARS = 2000;
export function keptFirst<T extends { firstMessage?: string }>(row: T): T {
  const first = row.firstMessage;
  if (typeof first !== "string" || (first.length <= FIRST_TASK_CHARS && !first.trimStart().startsWith("<skill"))) return row;
  return { ...row, firstMessage: taskText(first).slice(0, FIRST_TASK_CHARS) };
}
