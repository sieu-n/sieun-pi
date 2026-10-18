import type { SessionRow } from "../shared/types.ts";

export interface ActiveAgents { total: number; threads: number; subagents: number }

/**
 * Prime Agent sessions running a turn right now, the daemon's `rosterStatus` "running" summed over every session: each thread whose own turn
 * runs (chats, plain threads and duty jobs are all top-level rows) plus its running subagents at any depth (`subagentsRunning`). An archived
 * thread's own turn is left out.
 */
export function activeAgents(rows: readonly Pick<SessionRow, "status" | "archived" | "subagentsRunning">[]): ActiveAgents {
  let threads = 0;
  let subagents = 0;
  for (const row of rows) {
    if (row.status === "running" && !row.archived) threads++;
    subagents += row.subagentsRunning;
  }
  return { total: threads + subagents, threads, subagents };
}
