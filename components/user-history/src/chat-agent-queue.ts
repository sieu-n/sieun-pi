import { readAgentQueue, readQueueTimers, setPoolKey, type AgentQueueKey } from "./chat-pool.ts";
import type { AgentQueueInput, AgentQueueReading, AgentQueueTimers, AgentQueueView, IdleEvictionMinutes } from "./shared/types.ts";

/** Input bounds for the two limits. A limit above the measured 16 is the owner's call; 999 only catches a typo with extra digits. */
const LIMIT_MAX = 999;
/** Input bound for the two timers, in seconds: a day, far above the measured 18 s aging and 1,800 s lease. */
const TIMER_MAX_S = 86_400;
const POOL_KEYS = { mac: "mac_working_max", tree: "tree_working_max", aging: "queue_aging_s", lease: "lease_s" } as const satisfies Record<string, AgentQueueKey>;
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
  if ((value.action === "aging" || value.action === "lease") && whole(value.value, TIMER_MAX_S)) return { action: value.action, value: value.value };
  if (value.action === "idle" && (value.value === "off" || whole(value.value, IDLE_MAX_MINUTES))) return { action: "idle", value: value.value };
  throw new Error(`Use action queue with on true or false, mac or tree with a whole number from 1 to ${LIMIT_MAX}, aging or lease with 1 to ${TIMER_MAX_S} seconds, or idle with 1 to ${IDLE_MAX_MINUTES} minutes or "off".`);
}

/** `title` names a session for the Next line; null when the catalog does not know it. `read` and `set` default to the installed pi-pool. */
export function agentQueue(title: (sessionId: string) => string | null, idle: IdleEviction,
  read: () => Promise<AgentQueueReading> = readAgentQueue, timers: () => Promise<AgentQueueTimers> = readQueueTimers, set: typeof setPoolKey = setPoolKey): AgentQueue {
  async function view(): Promise<AgentQueueView> {
    const pool = await Promise.all([read(), timers()]).then(([reading, timing]) => ({ state: "read" as const, ...reading, ...timing,
      nextTitle: reading.queued[0] ? title(reading.queued[0].session) : null }),
      (error: unknown) => ({ state: "unread" as const, error: error instanceof Error ? error.message : String(error) }));
    return { pool, idleEvictionMinutes: idle.idleEviction() };
  }

  async function apply(input: AgentQueueInput): Promise<AgentQueueView> {
    switch (input.action) {
      case "queue": await set("agent_queue_on", input.on ? 1 : 0); break;
      case "mac": case "tree": case "aging": case "lease": await set(POOL_KEYS[input.action], input.value); break;
      case "idle": await idle.setIdleEviction(input.value); break;
      default: { const never: never = input; throw new Error(`Unknown action ${String(never)}`); }
    }
    return view();
  }

  return { view, apply };
}
