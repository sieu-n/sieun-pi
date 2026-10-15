import type { FleetAsk, FleetState } from "./fleet-budget.ts";

/** A state older than this reads as open: the chat service is down or stopped publishing, and a stale "closed" must not hold every job forever. */
export const FLEET_STATE_FRESH_MS = 120_000;

/** The FleetState in `text`, or null when it is missing or unreadable. A root start then goes at once (src/message-limit-check.py). */
export function parseFleetState(text: string | null): FleetState | null {
  if (text === null) return null;
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== "object" || value === null) return null;
    const { at, closed, waiting } = value as { at?: unknown; closed?: unknown; waiting?: unknown };
    if (typeof at !== "number" || !(closed === null || typeof closed === "string")) return null;
    const asks = Array.isArray(waiting) ? waiting.filter((ask): ask is FleetAsk => typeof ask === "object" && ask !== null && typeof ask.kind === "string" &&
      typeof ask.label === "string" && (ask.chat === undefined || typeof ask.chat === "string")) : [];
    return { at, closed, ...(asks.length ? { waiting: asks } : {}) };
  } catch { return null; }
}

/** An rlm.spawn or create_session call in a kernel cell. */
const STARTS_AGENT = /\b(spawn|create_session)\s*\(/;

/**
 * While the fleet stop switch is on (FLEET_STOP_FILE exists, `stop` is its reason), a duty, check-in or fix job the server registered starts no
 * subagent and no root of its own. On 10-16 at about 04:10 KST, with the switch on, duty runs of launch main bro and frontend bro still opened
 * jobs through their own agent tools. A chat and the owner's own jobs are not held.
 */
export function fleetStopGuard(toolName: string, input: Record<string, unknown>, stop: string | null, dutyJob: boolean): { block: true; reason: string } | undefined {
  if (!stop || !dutyJob || toolName !== "ipython" || typeof input.code !== "string" || !STARTS_AGENT.test(input.code)) return undefined;
  return { block: true, reason: `Not started: ${stop}, so a duty or fix job starts no subagent and no job. Note on your step what you would start, and end this turn.` };
}
