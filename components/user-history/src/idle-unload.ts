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
 * A chat the service detached for idleEvictionMinutes (dormant) is stopped too. Before 10-18 every chat was left out, and the detach alone did
 * not free memory: at 23:45Z on 10-17, 18 of 23 workers held only sleeping sessions (5.3 GB, plus 1.2 GB in their kernels), among them six
 * paused chats idle 31 to 50 min (api portal vp, frontend bro, launch main bro, spec and monitoring, SEO guy, ops guy).
 */
/** Nothing runs, waits or is scheduled in the session, and no client but the service's own attach (judged by the caller) holds it. */
function still(row: SessionSummary, pool: ReadonlySet<string>): boolean {
  return row.lifecycle === "live" && row.activeSessionId !== undefined && row.workerState === "ready" &&
    row.activity === "idle" && !row.isSessionActive && !row.isStreaming && !row.isCompacting && !row.isBashRunning && !row.hasRunningRlmChildren &&
    !row.isRunningTools && !row.directAttachedClients && !row.unfinishedActionCount &&
    (row.sessionActions?.queuedCount ?? 0) === 0 && !row.hasRegisteredHeartbeat && !row.hasRegisteredCronJob && !pool.has(row.sessionId);
}

function quiet(row: SessionSummary, input: { attached: ReadonlySet<string>; pool: ReadonlySet<string> }): boolean {
  return still(row, input.pool) && !input.attached.has(row.sessionId) && row.attachedClients === 0;
}

/**
 * How long a session that ended its task sits quiet before the unload stops it, instead of idleEvictionMinutes: a subagent that replied to its
 * parent (`repliedSinceTask`), a session the daemon judged (`taskState`, set only once a turn ended), or one with a board.wake pending (`waking`),
 * which asked to be unloaded while it waits. A chat keeps idleEvictionMinutes. At 00:52Z on 10-18 the 18 idle subagents that had replied held
 * 0.85 GB in their Python kernels. At 01:16Z, with swap at 12.56 GB, 14 of the 17 idle sessions that were no chat and had nothing below them at
 * work had ended their task this way, quiet 0.3 to 8.4 min: 9 subagents and 5 root jobs, each root holding a whole worker of 0.30 to 0.51 GB of
 * its own. A stopped session loads again on its next message or wake.
 */
export const ENDED_MS = 2 * 60_000;

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
 * The rows the daemon lists that `unload` may stop (after ENDED_MS for a session that ended its task): a top-level session (a job, or a chat that is not in `attached`, the chats the service still
 * holds attached), or a subagent, idle for `idleMs` with nothing running, attached, queued or scheduled in it or below it. `idleMs` null (idle
 * eviction off) stops none.
 */
export function unloadPlan(rows: readonly SessionSummary[], input: { attached: ReadonlySet<string>; pool: ReadonlySet<string>; now: number; idleMs: number | null;
  chats?: ReadonlySet<string>; waking?: ReadonlySet<string> }): SessionSummary[] {
  const { idleMs } = input;
  if (idleMs === null) return [];
  const busy = busyAncestors(rows);
  const ended = (row: SessionSummary): boolean => !input.chats?.has(row.sessionId) &&
    ((row.runtimeKind === "subagent" && row.repliedSinceTask === true) || row.taskState !== undefined || input.waking?.has(row.sessionId) === true);
  const wait = (row: SessionSummary): number => ended(row) ? Math.min(idleMs, ENDED_MS) : idleMs;
  return rows.filter(row => quiet(row, input) && !busy.has(row.sessionId) && input.now - Date.parse(row.lastActivityAt ?? "") >= wait(row));
}

/**
 * Prime keeps about 18 MB of JS heap in a worker for each child it ever hosted, until the worker exits (sessions/2026/10/18/0844-idle-ram-unload):
 * at 00:46Z on 10-18 the AI harness VP's worker 5784, up 5 h with 31 passive children listed on it, held 1.50 GB of its own against 0.28 to
 * 0.58 GB for the 24 other workers. A chat that never rests for idleEvictionMinutes keeps that worker for hours. Stopping every session on such
 * a worker once all of them are quiet lets the worker exit, and the chat loads in a fresh worker on its next message, wake or open. This is
 * the worker's own footprint at which a quiet worker is recycled, about twice the largest fresh worker's; it holds back no work.
 */
export const RECYCLE_OWN_BYTES = 1024 ** 3;
/** How long every session on a worker stays quiet before the recycle, so a chat in a live talk with the owner is not stopped between messages. */
export const RECYCLE_QUIET_MS = 3 * 60_000;

/** A worker whose loaded sessions are all quiet: the chats the service still holds attached, and every session to stop, deepest first. */
export interface QuietWorker { pid: number; attached: string[]; stop: SessionSummary[] }

/**
 * The workers where every loaded session has been quiet for `quietMs` with nothing running, queued or scheduled. A session with a client
 * attached that is not the service's own attach to a chat in `chats` keeps its worker. `recyclePlan` picks the ones to recycle.
 */
export function quietWorkers(rows: readonly SessionSummary[], input: { chats: ReadonlySet<string>; pool: ReadonlySet<string>; now: number; quietMs?: number }): QuietWorker[] {
  const quietMs = input.quietMs ?? RECYCLE_QUIET_MS;
  const byWorker = new Map<number, SessionSummary[]>();
  for (const row of rows) {
    if (row.lifecycle !== "live" || row.activeSessionId === undefined || row.workerPid === undefined) continue;
    byWorker.set(row.workerPid, [...byWorker.get(row.workerPid) ?? [], row]);
  }
  const depth = (row: SessionSummary): number => row.rlmDepth ?? (row.runtimeKind === "subagent" ? 1 : 0);
  const found: QuietWorker[] = [];
  for (const [pid, on] of byWorker) {
    const ok = on.every(row => still(row, input.pool) && input.now - Date.parse(row.lastActivityAt ?? "") >= quietMs &&
      (row.attachedClients === 0 || input.chats.has(row.sessionId)));
    if (!ok) continue;
    found.push({ pid, attached: on.filter(row => row.attachedClients > 0).map(row => row.sessionId), stop: [...on].sort((a, b) => depth(b) - depth(a)) });
  }
  return found;
}

/** The quiet workers whose own footprint (`own`, by pid, from src/worker-footprint.py) reached `recycleBytes`. */
export function recyclePlan(quiet: readonly QuietWorker[], own: ReadonlyMap<number, number>, recycleBytes = RECYCLE_OWN_BYTES): QuietWorker[] {
  return quiet.filter(worker => (own.get(worker.pid) ?? 0) >= recycleBytes);
}
