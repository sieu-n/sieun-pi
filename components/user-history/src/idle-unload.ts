import type { SessionSummary } from "prime-agent";

/**
 * Stopping a session that sits idle, at the daemon's idleEvictionMinutes (10), because Prime's own sweeps fail under load: a worker sweep ends at
 * the first worker that "did not stop" (99 such sweeps on 10-15), and the child passivation sweep times out ("Timed out waiting for daemon worker
 * response to list"; 97 failed eviction sweeps in daemon.sock.bab13329.log on 10-17). At 21:33Z on 10-17, 106 sessions sat resident with one
 * Python kernel each, 57 of them idle subagents in trees that still ran, and swap read 15.3 of 16 GB. A stopped root stays listed, and a stopped
 * subagent reads inactive to its parent; each loads again on its next message or wake (checked with a probe child on 10-18 06:38 KST).
 * Roots once stopped after one quiet minute, and on 10-17 from 21:29Z babysitter, 01a10810 and 'wiki dream memory moves 10-18' were each stopped
 * 4 times in 11 minutes, each time reloaded 1 to 2 minutes later by an agent message, a board.wake or a check-in, so one quiet minute only
 * traded a kernel for a reload.
 */
function quiet(row: SessionSummary, input: { chats: ReadonlySet<string>; pool: ReadonlySet<string> }): boolean {
  return row.lifecycle === "live" && row.activeSessionId !== undefined && row.workerState === "ready" && !input.chats.has(row.sessionId) &&
    row.activity === "idle" && !row.isSessionActive && !row.isStreaming && !row.isCompacting && !row.isBashRunning && !row.hasRunningRlmChildren &&
    !row.isRunningTools && row.attachedClients === 0 && !row.directAttachedClients && !row.unfinishedActionCount &&
    (row.sessionActions?.queuedCount ?? 0) === 0 && !row.hasRegisteredHeartbeat && !row.hasRegisteredCronJob && !input.pool.has(row.sessionId);
}

/** The sessions with a session below them, at any depth, that is not idle. */
function busyAncestors(rows: readonly SessionSummary[]): Set<string> {
  const parent = new Map(rows.flatMap(row => row.parentSessionId ? [[row.sessionId, row.parentSessionId] as const] : []));
  const busy = new Set<string>();
  for (const row of rows) {
    if (row.activity === "idle" && !row.isSessionActive) continue;
    for (let up = parent.get(row.sessionId); up !== undefined && !busy.has(up); up = parent.get(up)) busy.add(up);
  }
  return busy;
}

/**
 * The rows the daemon lists that `unload` may stop: a top-level job that is not a chat, or a subagent, idle for `idleMs` with nothing running,
 * attached, queued or scheduled in it or below it. `idleMs` null (idle eviction off) stops none.
 */
export function unloadPlan(rows: readonly SessionSummary[], input: { chats: ReadonlySet<string>; pool: ReadonlySet<string>; now: number; idleMs: number | null }): SessionSummary[] {
  const { idleMs } = input;
  if (idleMs === null) return [];
  const busy = busyAncestors(rows);
  return rows.filter(row => quiet(row, input) && !busy.has(row.sessionId) && input.now - Date.parse(row.lastActivityAt ?? "") >= idleMs);
}
