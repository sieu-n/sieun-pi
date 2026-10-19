import { readAgentQueue, setPoolKey, type AgentQueueKey } from "./chat-pool.ts";
import type { AgentQueueInput, AgentQueueReading, AgentQueueRow, AgentQueueView, IdleEvictionMinutes, TurnHour } from "./shared/types.ts";
import { turnHistory } from "./turn-history.ts";

/** Input bounds for the two limits. A limit above the measured 16 is the owner's call; 999 only catches a typo with extra digits. */
const LIMIT_MAX = 999;
const POOL_KEYS = { mac: "working_max", tree: "tree_working_max" } as const satisfies Record<string, AgentQueueKey>;
/** The daemon takes any whole number of minutes; a day is the longest wait the pane offers, and "off" never unloads. */
const IDLE_MAX_MINUTES = 1440;

export interface AgentQueue { view(): Promise<AgentQueueView>; apply(input: AgentQueueInput): Promise<AgentQueueView> }

/** The daemon's idle unload time in ~/.prime/agent/settings.json, read and written only through the chat's defaults store. */
export interface IdleEviction { idleEviction(): IdleEvictionMinutes; setIdleEviction(value: IdleEvictionMinutes): Promise<void> }

const whole = (value: unknown, max: number): value is number => typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= max;

export function parseAgentQueueInput(body: unknown): AgentQueueInput {
  const value = typeof body === "object" && body !== null ? body as Record<string, unknown> : {};
  if (value.action === "queue" && typeof value.on === "boolean") return { action: "queue", on: value.on };
  if ((value.action === "mac" || value.action === "tree") && whole(value.value, LIMIT_MAX)) return { action: value.action, value: value.value };
  if (value.action === "idle" && (value.value === "off" || whole(value.value, IDLE_MAX_MINUTES))) return { action: "idle", value: value.value };
  throw new Error(`Use action queue with on true or false, mac or tree with a whole number from 1 to ${LIMIT_MAX}, or idle with 1 to ${IDLE_MAX_MINUTES} minutes or "off".`);
}

type Title = (sessionId: string) => string | null;
const short = (id: string): string => id.slice(0, 8);
/** The chat and job names of one queue entry; an id the catalog does not know shows as its first 8 characters. */
export function rowNames(session: string, tree: string, title: Title): Pick<AgentQueueRow, "chat" | "job"> {
  return { chat: title(tree) ?? short(tree), job: session === tree ? null : title(session) ?? short(session) };
}

/** The live queue's rows: working turns longest first, then waiting turns in the order pi-pool admits them. */
export function queueRows(reading: Pick<AgentQueueReading, "working" | "queued">, title: Title): AgentQueueRow[] {
  const working = [...reading.working].sort((a, b) => a.since - b.since)
    .map((entry): AgentQueueRow => ({ session: entry.session, state: "working", ...rowNames(entry.session, entry.tree, title), owner: entry.kind === "owner", since: entry.since }));
  const waiting = reading.queued
    .map((entry): AgentQueueRow => ({ session: entry.session, state: "waiting", ...rowNames(entry.session, entry.tree, title), owner: false, since: entry.since }));
  return [...working, ...waiting];
}

/** `title` names a session for the queue rows; null when the catalog does not know it. `read` and `set` default to the installed pi-pool, `history` to pi-pool.log. */
export function agentQueue(title: Title, idle: IdleEviction,
  read: () => Promise<AgentQueueReading> = readAgentQueue, set: typeof setPoolKey = setPoolKey,
  history: () => Promise<TurnHour[]> = turnHistory()): AgentQueue {
  async function view(): Promise<AgentQueueView> {
    const [pool, hours] = await Promise.all([read().then(reading => ({ state: "read" as const, ...reading, rows: queueRows(reading, title) }),
      (error: unknown) => ({ state: "unread" as const, error: error instanceof Error ? error.message : String(error) })), history().catch(() => [])]);
    return { pool, idleEvictionMinutes: idle.idleEviction(), history: hours };
  }

  async function apply(input: AgentQueueInput): Promise<AgentQueueView> {
    switch (input.action) {
      case "queue": await set("agent_queue_on", input.on ? 1 : 0); break;
      case "mac": case "tree": await set(POOL_KEYS[input.action], input.value); break;
      case "idle": await idle.setIdleEviction(input.value); break;
      default: { const never: never = input; throw new Error(`Unknown action ${String(never)}`); }
    }
    return view();
  }

  return { view, apply };
}
