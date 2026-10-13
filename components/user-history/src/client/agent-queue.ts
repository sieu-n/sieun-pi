import type { AgentQueueView } from "../shared/types.ts";
import { duration } from "./format.ts";

export const POOL_SILENT = "The pool did not answer. The queue is off until it does.";

/** The live line of Settings > This Mac > Agent queue: how many turns work and wait, and which one goes next. */
export function queueLine(view: AgentQueueView): string {
  if (view.state === "unread") return POOL_SILENT;
  if (!view.enabled) return "The queue is off, so every turn starts at once.";
  const head = `${view.working.length} working, ${view.queued.length} queued.`;
  const next = view.queued[0];
  if (!next) return head;
  const name = view.nextTitle ?? next.session.slice(0, 8);
  const kind = next.basePriority === next.priority ? `a ${next.priority} turn` : `a ${next.basePriority} turn moved up to ${next.priority}`;
  return `${head} Next: ${name}, ${kind}, queued for ${duration(next.waitMs)}.`;
}
