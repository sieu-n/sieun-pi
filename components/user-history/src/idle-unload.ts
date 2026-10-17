import type { SessionSummary } from "prime-agent";

/**
 * Stopping the worker of a root job that sits idle. Prime's own idle sweep does this after idleEvictionMinutes (10), but a sweep ends at the
 * first worker that "did not stop" (99 such sweeps on 10-15 in daemon.sock.bab13329.log), so idle roots kept their workers far longer: at 21:22Z
 * on 10-15, 25 workers held 20.77 GB of the 32 GB Mac, 6 of them idle top-level jobs with no turn, tool, child or schedule, and the hour read
 * 71.7% usable with 15 harness minutes. A stopped root stays listed and loads again on its next message or wake, as after Prime's own eviction.
 */
export const UNLOAD_IDLE_MS = 60_000;

/**
 * A subagent idle for the daemon's idleEvictionMinutes is stopped the same way, since Prime's child passivation sweep times out under load
 * ("Timed out waiting for daemon worker response to list"; 97 failed eviction sweeps in daemon.sock.bab13329.log on 10-17). At 21:33Z on 10-17,
 * 106 sessions sat resident with one Python kernel each, 57 of them idle subagents in trees that still ran, and swap read 15.3 of 16 GB.
 * A stopped subagent reads inactive to its parent and loads again on its next agent message (checked with a probe child on 10-18 06:38 KST).
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
 * The rows the daemon lists that `unload` may stop, each idle with nothing running, attached, queued or scheduled: a top-level job that is not
 * a chat after UNLOAD_IDLE_MS, and a subagent with nothing at work below it after `childIdleMs` (none when idle eviction is off).
 */
export function unloadPlan(rows: readonly SessionSummary[], input: { chats: ReadonlySet<string>; pool: ReadonlySet<string>; now: number; childIdleMs: number | null }): SessionSummary[] {
  const busy = busyAncestors(rows);
  return rows.filter(row => {
    if (!quiet(row, input)) return false;
    const idleMs = input.now - Date.parse(row.lastActivityAt ?? "");
    if ((row.rlmDepth ?? 0) === 0 && row.runtimeKind !== "subagent") return idleMs >= UNLOAD_IDLE_MS;
    return input.childIdleMs !== null && !busy.has(row.sessionId) && idleMs >= input.childIdleMs;
  });
}
