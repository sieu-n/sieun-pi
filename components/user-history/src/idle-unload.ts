import type { SessionSummary } from "prime-agent";

/**
 * Stopping the worker of a root job that sits idle. Prime's own idle sweep does this after idleEvictionMinutes (10), but a sweep ends at the
 * first worker that "did not stop" (99 such sweeps on 10-15 in daemon.sock.bab13329.log), so idle roots kept their workers far longer: at 21:22Z
 * on 10-15, 25 workers held 20.77 GB of the 32 GB Mac, 6 of them idle top-level jobs with no turn, tool, child or schedule, and the hour read
 * 71.7% usable with 15 harness minutes. A stopped root stays listed and loads again on its next message or wake, as after Prime's own eviction.
 */
export const UNLOAD_IDLE_MS = 60_000;

/** The rows the daemon lists that `unload` may stop: a top-level job, not a chat, idle with nothing running, attached, queued or scheduled. */
export function unloadPlan(rows: readonly SessionSummary[], input: { chats: ReadonlySet<string>; pool: ReadonlySet<string>; now: number }): SessionSummary[] {
  return rows.filter(row => (row.rlmDepth ?? 0) === 0 && row.runtimeKind !== "subagent" && row.lifecycle === "live" && row.activeSessionId !== undefined &&
    row.workerState === "ready" && !input.chats.has(row.sessionId) && row.activity === "idle" && !row.isSessionActive && !row.isStreaming && !row.isCompacting &&
    !row.isBashRunning && !row.hasRunningRlmChildren && !row.isRunningTools && row.attachedClients === 0 && !row.directAttachedClients &&
    !row.unfinishedActionCount && (row.sessionActions?.queuedCount ?? 0) === 0 && !row.hasRegisteredHeartbeat && !row.hasRegisteredCronJob &&
    !input.pool.has(row.sessionId) && input.now - Date.parse(row.lastActivityAt ?? "") >= UNLOAD_IDLE_MS);
}
