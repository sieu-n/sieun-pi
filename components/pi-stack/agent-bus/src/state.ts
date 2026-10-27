/**
 * pi-agent-bus state that outlives one extension instance: the live sessions this process loaded, the pending agent messages per target,
 * the rate buckets per sender and target, and whether a child replied to its parent since its last task.
 *
 * It lives on `globalThis`, like `shared/registry.ts`, because pi-host may import `route.ts` through a second module instance.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

type ReadonlySessionManager = ExtensionContext["sessionManager"];

export type Activity = "idle" | "model" | "tool";

export interface LiveSession {
  id: string;
  sessionManager: ReadonlySessionManager;
  activity(): Activity;
  /** Ids of agent messages this process queued for the session and the session has not started yet. */
  pending: Set<string>;
}

interface Bucket {
  tokens: number;
  updatedAt: number;
}

interface State {
  live: Map<string, LiveSession>;
  buckets: Map<string, Bucket>;
  replied: Map<string, boolean>;
}

const KEY = Symbol.for("sieun-pi.pi-stack.agent-bus");

export function state(): State {
  const g = globalThis as unknown as Record<symbol, State | undefined>;
  return (g[KEY] ??= { live: new Map(), buckets: new Map(), replied: new Map() });
}

/** Whether `childId` sent its parent a message since the parent last sent it one. pi-rlm reads it for `list_subagents()`. */
export function repliedSinceTask(childId: string): boolean {
  return state().replied.get(childId) ?? false;
}

export function pendingCount(sessionId: string): number {
  return state().live.get(sessionId)?.pending.size ?? 0;
}
