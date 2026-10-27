/**
 * pi-agent-bus state that outlives one extension instance: the live sessions this process loaded, the pending agent messages per target,
 * the rate buckets per sender and target, and whether a child replied to its parent since its last task.
 *
 * It lives on `globalThis`, like `pi-family/registry.ts`, because pi-host may import `route.ts` through a second module instance.
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
  /** Ids of every agent message the session holds: in its transcript, in its durable inbox, or delivered since it opened. */
  seen: Set<string>;
}

interface Bucket {
  tokens: number;
  updatedAt: number;
}

interface State {
  live: Map<string, LiveSession>;
  buckets: Map<string, Bucket>;
  replied: Map<string, boolean>;
  /** The last receipts by message id, so a repeated keyed send gets its first receipt back. Bounded to RECEIPTS_KEPT. */
  receipts: Map<string, unknown>;
}

export const RECEIPTS_KEPT = 10_000;

const KEY = Symbol.for("sieun-pi.pi-stack.agent-bus");

export function state(): State {
  const g = globalThis as unknown as Record<symbol, State | undefined>;
  const s = (g[KEY] ??= { live: new Map(), buckets: new Map(), replied: new Map(), receipts: new Map() });
  s.receipts ??= new Map();
  return s;
}

/** Whether `childId` sent its parent a message since the parent last sent it one. pi-rlm reads it for `list_subagents()`. */
export function repliedSinceTask(childId: string): boolean {
  return state().replied.get(childId) ?? false;
}

export function pendingCount(sessionId: string): number {
  return state().live.get(sessionId)?.pending.size ?? 0;
}

export function rememberReceipt(id: string, receipt: unknown): void {
  const receipts = state().receipts;
  receipts.delete(id);
  receipts.set(id, receipt);
  while (receipts.size > RECEIPTS_KEPT) receipts.delete(receipts.keys().next().value!);
}
