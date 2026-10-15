import type { FleetState } from "./fleet-budget.ts";

/** A state older than this reads as open: the chat service is down or stopped publishing, and a stale "closed" must not hold every job forever. */
export const FLEET_STATE_FRESH_MS = 120_000;

/** An rlm.create_session call in a kernel cell (also `create_session(` after `from rlm import create_session`). */
const CREATE_SESSION = /\bcreate_session\s*\(/;

export const fleetHeldReason = (why: string): string =>
  `Not started: the Mac has no room for another root job now (${why}). The chat service's fleet budget holds its own jobs for the same reason. ` +
  "Add the plan step without a job and set board.wake(at=<now + 15 min>) to start it then, or end this turn. " +
  "If the owner asked for this job just now, tell the owner the Mac is full and that it starts once there is room.";

/** The FleetState in `text`, or null when it is missing or unreadable (the guard then lets the call through). */
export function parseFleetState(text: string | null): FleetState | null {
  if (text === null) return null;
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== "object" || value === null) return null;
    const { at, closed } = value as { at?: unknown; closed?: unknown };
    if (typeof at !== "number" || !(closed === null || typeof closed === "string")) return null;
    return { at, closed };
  } catch { return null; }
}

/**
 * Blocks a kernel cell that starts a root session while the fleet budget is shut. Subagents (rlm.spawn) are left to pi-pool's spawn gate and
 * turn queue; this only covers new roots, which each load a worker of their own. Fails open on a missing, unreadable or stale state.
 */
export function fleetGuard(toolName: string, input: Record<string, unknown>, state: FleetState | null, now: number): { block: true; reason: string } | undefined {
  if (toolName !== "ipython" || typeof input.code !== "string" || !CREATE_SESSION.test(input.code)) return undefined;
  if (!state?.closed || now - state.at > FLEET_STATE_FRESH_MS) return undefined;
  return { block: true, reason: fleetHeldReason(state.closed) };
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
