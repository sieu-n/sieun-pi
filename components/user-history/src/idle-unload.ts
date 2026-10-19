import type { DaemonClient, SessionSummary } from "prime-agent";
import { poolFreeAt, type PoolStatus, type PoolThread, type ThreadParts, threadKey } from "./chat-pool.ts";
import { lastTurnError } from "./held-turns.ts";

/**
 * Stopping a session that sits idle for the quiet window (src/quiet-minutes.ts, 15 min by default; the daemon's idleEvictionMinutes before
 * 10-19), because Prime's own sweeps fail under load: a worker sweep ends at
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
/**
 * The daemon holds the session loaded: a live one, or a draft, which has no message yet. Prime discards an empty draft at detach only without
 * workers, and a named one never. On 10-18 at 16:45Z the alert job 'alert VP of CI 19:58' (01a14ea9), whose brief never arrived, sat as a draft
 * since 10:58Z with its kernel and its own 216 MB worker, because only live rows were stopped. A stopped named draft stays on disk and loads
 * again on its first message.
 */
const loaded = (row: SessionSummary): boolean => (row.lifecycle === "live" || row.lifecycle === "draft") && row.activeSessionId !== undefined;

/**
 * A daemon row as a Prime newer than the pinned 0.9.8 lists it: `holdsDetachedProcesses` is true for a session whose bash() shell group still
 * holds a process it started detached, such as `nohup svc > log 2>&1 &`. Such a row reads idle on the detached-bash fix build a59cdba2, and
 * stopping it kills the service, because the kernel's shutdown killpg()s that group and the host reaper SIGKILLs it (native run DU-fix,
 * 10-18 17:51Z: the plain nohup server went from 200 to connection refused 8 s after the idle unload's kill). mem.3 never sends the field.
 */
export type UnloadRow = SessionSummary & { holdsDetachedProcesses?: boolean };

/** Nothing streams, runs a tool, bash or child, compacts, is queued or scheduled in the session, no detached process of its own lives, and no client but the service's own attach (judged by the caller) holds it. */
function calm(row: UnloadRow, pool: ReadonlySet<string>): boolean {
  return loaded(row) && row.workerState === "ready" && !row.holdsDetachedProcesses &&
    !row.isStreaming && !row.isCompacting && !row.isBashRunning && !row.hasRunningRlmChildren && !row.isRunningTools && !row.directAttachedClients &&
    (row.sessionActions?.queuedCount ?? 0) === 0 && !row.hasRegisteredHeartbeat && !row.hasRegisteredCronJob && !pool.has(row.sessionId);
}

/** Nothing runs, waits or is scheduled in the session (`calm`, and no turn or action open). */
function still(row: UnloadRow, pool: ReadonlySet<string>): boolean {
  return calm(row, pool) && row.activity === "idle" && !row.isSessionActive && !row.unfinishedActionCount;
}

const unheld = (row: SessionSummary, attached: ReadonlySet<string>): boolean => !attached.has(row.sessionId) && row.attachedClients === 0;

function quiet(row: SessionSummary, input: { attached: ReadonlySet<string>; pool: ReadonlySet<string> }): boolean {
  return still(row, input.pool) && unheld(row, input.attached);
}

/**
 * A session the daemon lists as working that is only asleep in Prime's provider retry: its turn is open, yet nothing streams, runs, compacts or
 * is queued in it. At 01:11Z on 10-19 176 sessions sat this way after a 429 (91) or pi-pool's token hook refusal "this session waits for its
 * slot at" (85), with 148 workers and 176 kernels (31.2 GB) that the unload left alone, since Prime counts a retrying session as active
 * (agent-session.ts `isRetrying`) and Prime's retry wait may last 8 days. The caller confirms from the transcript that the turn ended on a
 * failed reply (`lastTurnError`) and from pi-pool that its tree waits past the unload's minutes (`poolHoldsPast`). A chat stays: `Chats.revive`
 * restarts a chat, and the job sweep only continues sessions that are no chat.
 */
function retrying(row: SessionSummary, input: { attached: ReadonlySet<string>; pool: ReadonlySet<string>; chats?: ReadonlySet<string> }): boolean {
  return calm(row, input.pool) && row.activity === "working" && unheld(row, input.attached) && !input.chats?.has(row.sessionId);
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

/** The sessions with a session below them, at any depth, that is not idle or holds a detached process, which the daemon's guard would refuse to close. */
function busyAncestors(rows: readonly UnloadRow[]): Set<string> {
  const parent = new Map(rows.flatMap(row => row.parentSessionId ? [[row.sessionId, row.parentSessionId] as const] : []));
  const busy = new Set<string>();
  for (const row of rows) {
    if (row.activity === "idle" && !row.isSessionActive && !row.holdsDetachedProcesses) continue;
    for (let up = parent.get(row.sessionId); up !== undefined && !busy.has(up); up = parent.get(up)) busy.add(up);
  }
  return busy;
}

/** What `unloadPlan` and `retryCandidates` read besides the rows. */
export interface PlanInput { attached: ReadonlySet<string>; pool: ReadonlySet<string>; now: number; idleMs: number | null; chats?: ReadonlySet<string>;
  waking?: ReadonlySet<string>;
  /** Sessions asleep in Prime's provider retry whose tree pi-pool holds past the unload's minutes, with when the hold ends (`poolHoldsPast`). */
  held?: ReadonlyMap<string, number> }

/**
 * The rows that may be asleep in Prime's provider retry (`retrying`), quiet ENDED_MS since their last failed attempt with nothing at work below
 * them, for the caller to check against their transcripts and pi-pool. Idle eviction off gives none.
 */
export function retryCandidates(rows: readonly SessionSummary[], input: PlanInput): SessionSummary[] {
  if (input.idleMs === null) return [];
  const busy = busyAncestors(rows);
  return rows.filter(row => retrying(row, input) && !busy.has(row.sessionId) && input.now - Date.parse(row.lastActivityAt ?? "") >= ENDED_MS);
}

/**
 * The rows the daemon lists that `unload` may stop (after ENDED_MS for a session that ended its task): a top-level session (a job, or a chat that is not in `attached`, the chats the service still
 * holds attached), or a subagent, idle for `idleMs` with nothing running, attached, queued or scheduled in it or below it, and each candidate
 * asleep in its provider retry that `held` names. `idleMs` null (idle eviction off) stops none.
 */
export function unloadPlan(rows: readonly SessionSummary[], input: PlanInput): SessionSummary[] {
  const { idleMs } = input;
  if (idleMs === null) return [];
  const busy = busyAncestors(rows);
  const ended = (row: SessionSummary): boolean => !input.chats?.has(row.sessionId) &&
    ((row.runtimeKind === "subagent" && row.repliedSinceTask === true) || row.taskState !== undefined || input.waking?.has(row.sessionId) === true);
  const wait = (row: SessionSummary): number => ended(row) ? Math.min(idleMs, ENDED_MS) : idleMs;
  const idle = rows.filter(row => quiet(row, input) && !busy.has(row.sessionId) && input.now - Date.parse(row.lastActivityAt ?? "") >= wait(row));
  const held = input.held ? retryCandidates(rows, input).filter(row => input.held!.has(row.sessionId)) : [];
  return [...idle, ...held];
}

/**
 * How far ahead a pool hold may end for the unload to stop a session asleep on it: the resume pass reads a failed turn for 24 h after it
 * (resume_paused.py --since-minutes 1440), so a session stopped on a longer hold would get no continue. Such a session keeps Prime's own wait.
 */
export const HOLD_REACH_MS = 20 * 60 * 60_000;

/**
 * Whether the unload stops a session asleep in its provider retry whose tree pi-pool next serves at `freeAt` (epoch ms, null when the pool
 * does not say): only when that comes after the unload's minutes and within HOLD_REACH_MS. A tree the pool would serve sooner is left to
 * Prime's retry and the job sweep's abort (ab65b511), which continue it in place.
 */
export function poolHoldsPast(freeAt: number | null, now: number, idleMs: number): boolean {
  return freeAt !== null && freeAt > now + idleMs && freeAt <= now + HOLD_REACH_MS;
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
    if (!loaded(row) || row.workerPid === undefined) continue;
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

/**
 * A daemon's answer to one request, as `DaemonClient.request` resolves it. `detachedHold` marks the idle kill a daemon with DETACHED_GUARD
 * refused because the session or one below it holds detached processes.
 */
export type DaemonAnswer = { success: true; data?: unknown } | { success: false; error: string; detachedHold?: true };

/**
 * The `daemon_hello` server capability of a Prime that takes `origin: "idle_unload"` on a kill and records the stop as an idle unload. That
 * Prime records a kill with no origin as the owner's stop, and a Prime without it ignores the field (mem.3, checked by metal agent runtime on
 * 10-18), so only the capability tells the two apart.
 */
export const KILL_ORIGIN = "kill_origin";

/** The kill the idle unload sends under `hello`: named as an idle unload to a daemon that lists KILL_ORIGIN, a bare kill to any other. */
export function idleKillCommand(activeSessionId: string, hello: { serverCapabilities?: readonly string[] }) {
  return takesKillOrigin(hello) ? { type: "kill" as const, activeSessionId, origin: "idle_unload" as const } : { type: "kill" as const, activeSessionId };
}

const takesKillOrigin = (hello: { serverCapabilities?: readonly string[] }) => (hello.serverCapabilities ?? []).includes(KILL_ORIGIN);

/**
 * The `daemon_hello` server capability (protocol 7) of a Prime that refuses `{type: "kill", origin: "idle_unload"}` for a session that holds
 * detached processes, or has one below it that does. The refusal is `success: false` with `errorInfo.code` DETACHED_REFUSAL and changes
 * nothing, so the service keeps running (p8-metal/detached-guard-contract.md, 10-18). A Prime without it never lists such a session as idle.
 */
export const DETACHED_GUARD = "idle_unload_detached_guard";
export const DETACHED_REFUSAL = "idle_unload_detached_processes";

const guardsDetached = (hello: { serverCapabilities?: readonly string[] }) => (hello.serverCapabilities ?? []).includes(DETACHED_GUARD);

export type UnloadClient = Pick<DaemonClient, "hello" | "waitForHello" | "request">;

/**
 * The idle unload's answer, in place of a kill, for a session whose daemon lists no KILL_ORIGIN and whose box cannot restore it. A bare kill
 * writes the archived state, and the service rewrites it as active only for a file on its own box. On 10-18 at 12:53:05Z such a kill archived
 * the Mac's runner reviewer root (01a11d25), which gates land 39, and 159 Mac sessions that day, so sends to them read 'No sibling matches'.
 * The daemon's own idle eviction passivates them instead (Mac daemon.sock.bab13329.log: "Evicted idle worker ... root=01a11d25").
 */
export const NO_BARE_KILL = "Left to its daemon's idle eviction: that daemon has no kill_origin, so a kill would archive a session this box cannot restore.";

/**
 * `get_state` or the idle kill for an active session. The kill reads the hello of the connection it goes out on, since `DaemonClient.connect`
 * drops the last one and a reconnect may meet another Prime build. In prime-agent 0.9.8 `request` reaches its socket write with no await once a
 * hello is held, so no reconnect falls between the read and the send. It is never replayed onto a later connection (`recoverable: false`).
 */
export async function unloadRequest(client: UnloadClient, activeSessionId: string, type: "get_state" | "kill", restorable = true): Promise<DaemonAnswer> {
  try {
    if (type === "get_state") return await client.request({ type, activeSessionId }, 30_000, { recoverable: false });
    if (!client.hello) await client.waitForHello(30_000);
    const hello = client.hello;
    if (!hello) return { success: false, error: "The daemon connection closed before its hello; the kill was not sent." };
    if (!restorable && !takesKillOrigin(hello)) return { success: false, error: NO_BARE_KILL };
    const answer = await client.request(idleKillCommand(activeSessionId, hello), 30_000, { recoverable: false });
    if (answer.success) return answer;
    const info: { code: string } | undefined = answer.errorInfo;
    const held = info?.code === DETACHED_REFUSAL && guardsDetached(hello);
    return held ? { success: false, error: answer.error, detachedHold: true } : answer;
  } catch (error) {
    return { success: false, error: String(error) };
  }
}

/** What one sweep of `IdleUnloader` reads and calls. The chat backend wires it to the catalog, the hub and each box's daemon. */
export interface UnloadSource {
  /** Every box's daemon rows, which the plan reads. */
  rows(): readonly SessionSummary[];
  /** This box's rows, which the worker recycle reads, since only this box's footprints are measured. */
  localRows(): readonly SessionSummary[];
  /** The quiet window (src/quiet-minutes.ts) in ms; null when idle eviction is off. */
  idleMs(): number | null;
  chats(): Promise<ReadonlySet<string>>;
  /** Whether the hub detached the chat as dormant. */
  dormant(id: string): boolean;
  /** The sessions with a turn working or queued in pi-pool. */
  pool(): Promise<ReadonlySet<string>>;
  /** The sessions with a board.wake pending at `now`. */
  waking(now: number): Promise<ReadonlySet<string>>;
  /**
   * Of `rows` (`retryCandidates`), the ones whose transcript ends on a failed reply and whose tree pi-pool holds past the unload's minutes
   * (`poolHoldsPast`), with when the hold ends.
   */
  held(rows: readonly SessionSummary[], now: number, idleMs: number): Promise<ReadonlyMap<string, number>>;
  /** Each worker's own footprint in bytes, by pid. */
  own(pids: readonly number[]): Promise<ReadonlyMap<number, number>>;
  restNow(id: string, quietMs: number): Promise<boolean>;
  title(id: string): string | null;
  /** `get_state` or the idle kill (`unloadRequest`) for the row's active session, through the daemon of the row's box. */
  request(row: SessionSummary, type: "get_state" | "kill"): Promise<DaemonAnswer>;
  /**
   * Runs after a kill succeeded: record the stop, and keep a chat or the owner's plain thread listed, since the kill writes the archived state.
   * `since` is when this stop began, so an explicit archive from then on wins.
   */
  stopped(row: SessionSummary, isChat: boolean, since: number): Promise<void>;
  log(line: string): void;
  now(): number;
}

/**
 * How many trees one pool read for `providerWaits` names. The shared reader keeps 100 thread readings (chat-pool.ts KEPT_THREADS) and fails
 * a read that names more: at 02:02Z on 10-19 the first sweep of 576ccfb6 asked for 153 trees and logged "pi-pool gave no reading". One
 * `pi-pool snapshot` of 40 trees took 0.85 s on us-metal02.
 */
export const WAIT_READ_TREES = 40;

/** What `providerWaits` reads: every row of this box (for each tree's root), which rows are this box's, a transcript's tail, and the pool. */
export interface WaitReads {
  all: readonly SessionSummary[];
  local: (row: SessionSummary) => boolean;
  tail: (sessionFile: string) => Promise<string>;
  read: (threads: readonly PoolThread[]) => Promise<Pick<PoolStatus, "threads">>;
}

/**
 * Of `rows` (`retryCandidates`), each one of this box whose transcript ends on a failed reply (`lastTurnError`) and whose tree, keyed by its
 * root session as pi-pool keys it, the pool serves next only past the unload's minutes (`poolFreeAt`, `poolHoldsPast`), with when that is.
 * The trees are read WAIT_READ_TREES at a time.
 */
export async function providerWaits(rows: readonly SessionSummary[], now: number, idleMs: number, reads: WaitReads): Promise<Map<string, number>> {
  const byId = new Map(reads.all.map(row => [row.sessionId, row] as const));
  const rootOf = (row: SessionSummary): string => {
    const seen = new Set([row.sessionId]);
    let top = row;
    for (let up = byId.get(top.parentSessionId ?? ""); up && !seen.has(up.sessionId); up = byId.get(up.parentSessionId ?? "")) { seen.add(up.sessionId); top = up; }
    return top.sessionId;
  };
  const failed = await Promise.all(rows.filter(row => reads.local(row) && row.sessionFile && row.model?.provider)
    .map(async row => lastTurnError(await reads.tail(row.sessionFile!).catch(() => "")) === undefined ? [] : [row]));
  const waiting = failed.flat();
  if (!waiting.length) return new Map();
  const trees = [...new Set(waiting.map(rootOf))].map(session => ({ session, model: null }));
  const found = new Map<string, ThreadParts>();
  for (let from = 0; from < trees.length; from += WAIT_READ_TREES) {
    for (const [key, parts] of (await reads.read(trees.slice(from, from + WAIT_READ_TREES))).threads) found.set(key, parts);
  }
  return new Map(waiting.flatMap(row => {
    const parts = found.get(threadKey({ session: rootOf(row), model: null }));
    const freeAt = parts ? poolFreeAt(parts, row.model!.provider, now) : null;
    return freeAt !== null && poolHoldsPast(freeAt, now, idleMs) ? [[row.sessionId, freeAt] as const] : [];
  }));
}

/**
 * The daemon's `get_state` shows the session doing something: a turn, a tool, a retry, a compaction, queued input, a background bash or a
 * detached process it started. For a session stopped while asleep in its provider retry (`retry`) the open turn is expected, and only a
 * stream, a compaction, a bash or a detached process keeps it: a retry that fired since the row was listed streams.
 */
function stateBusy(data: unknown, retry: boolean): boolean {
  const state = (typeof data === "object" && data !== null ? data : {}) as Partial<Pick<UnloadRow, "isSessionActive" | "isStreaming" | "isCompacting" | "isBashRunning" | "isRunningTools" | "holdsDetachedProcesses">>;
  return (!retry && state.isSessionActive !== false) || state.isStreaming === true || state.isCompacting === true || state.isBashRunning === true ||
    state.isRunningTools === true || state.holdsDetachedProcesses === true;
}

/**
 * How long the sweep's line waits for one session's stop, its `get_state` and kill (30 s each) included. A stop still out then logs its own
 * line once it stops the session, and the next sweep does not ask that session again while it is out. From 22Z on 10-18 to 01:03Z on 10-19
 * the hung worker 114947 left the `get_state` of 01a150e1 timing out every minute.
 */
export const STOP_BOUND_MS = 75_000;
/** How long the sweep waits for `held` (transcript tails and the pool reads, one per WAIT_READ_TREES trees) before it plans without it. */
export const HELD_BOUND_MS = 45_000;

const within = <T>(work: Promise<T>, ms: number, late: T): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([work, new Promise<T>(resolve => { timer = setTimeout(() => resolve(late), ms); timer.unref?.(); })]).finally(() => clearTimeout(timer));
};
const skipUntilRowChanges = (error: string): boolean => /Unknown active session/.test(error) || error === NO_BARE_KILL;

/**
 * Runs the idle unload once a minute without letting one slow kill hold up the rest. Up to 10-18 every kill of a sweep waited for the one
 * before it, and the next sweep waited for the whole sweep. With the daemon answering a kill only after its 30 s timeout, the sweep that
 * stopped 'alerts-h-proxy' at 03:12:53Z was followed by one that ran until 03:36:49Z through 22 kill timeouts, then one until 03:48:24Z. Its
 * plan was read when it started, so a session that went quiet meanwhile waited for the next sweep: the 26 sessions stopped at 03:48:24Z had
 * been quiet 10.5 to 15.7 min, the Douyin index gaps jobs among them, and '***launch main bro***', detached as dormant just after the sweep
 * read its plan, kept a whole 0.54 GB worker until Prime evicted it at 03:46:59Z. sleeping_gb read 0.8 GB over the 30 min to 03:46Z against
 * its 0.25 GB target.
 * Now each sweep reads its plan fresh and starts every stop at once, and a session whose stop is still out is not asked again. Each stop asks
 * the daemon for the session's state first and keeps a session that started a turn since the row was listed, so no kill lands mid-turn.
 * An active session the daemon does not know is skipped until its row changes: on 10-18 from 03:12Z the same stale rows of 01a14cf1 and
 * 01a14cf2 were asked to stop in four sweeps.
 */
export class IdleUnloader {
  /** The stop under way for each session id. */
  private readonly out = new Map<string, Promise<boolean>>();
  /** Rows the daemon no longer knows or that were stopped, by active session id and lastActivityAt, so a stale row is not asked again. */
  private readonly gone = new Set<string>();
  private readonly running = new Set<Promise<unknown>>();

  constructor(private readonly source: UnloadSource) {}

  /** Plans from the rows now and starts each stop and recycle. Resolves once they have started, not once they end (`settled`). */
  async sweep(): Promise<void> {
    const source = this.source;
    const idleMs = source.idleMs();
    const chats = await source.chats();
    const attached = new Set([...chats].filter(id => !source.dormant(id)));
    const pool = await source.pool();
    const now = source.now();
    const waking = await source.waking(now);
    const input: PlanInput = { attached, pool, now, idleMs, chats, waking };
    const fresh = (row: SessionSummary): boolean => !this.out.has(row.sessionId) && !this.gone.has(goneKey(row));
    const candidates = retryCandidates(source.rows(), input).filter(fresh);
    const held = candidates.length && idleMs !== null
      ? await within(source.held(candidates, now, idleMs).catch(error => { source.log(`idle unload: provider waits: ${error instanceof Error ? error.message : String(error)}`); return new Map<string, number>(); }),
        HELD_BOUND_MS, new Map<string, number>())
      : new Map<string, number>();
    const plan = unloadPlan(source.rows(), { ...input, held }).filter(fresh);
    if (plan.length) {
      // Each stop is bounded on its own (STOP_BOUND_MS). The sweep's line names the stops done by then; a later one logs its own line.
      const named = (row: SessionSummary): string => {
        const name = row.sessionName?.trim() || row.sessionId.slice(0, 8);
        const until = held.get(row.sessionId);
        return until === undefined ? name : `${name} (waits on pi-pool until ${new Date(until).toISOString().slice(11, 16)}Z)`;
      };
      this.track(Promise.all(plan.map(row => {
        const stop = this.stop(row, chats, held.has(row.sessionId));
        return within(stop.then(done => done ? "stopped" as const : "kept" as const), STOP_BOUND_MS, "late" as const).then(outcome => {
          if (outcome === "late") void stop.then(done => { if (done) source.log(`idle unload: stopped ${named(row)} after the sweep's ${STOP_BOUND_MS / 1000} s`); });
          return outcome === "stopped" ? [named(row)] : [];
        });
      })).then(names => {
        const stopped = names.flat();
        if (stopped.length) source.log(`idle unload: stopped ${stopped.length} idle sessions: ${stopped.join(", ")}`);
      }));
    }
    // A quiet worker that grew past RECYCLE_OWN_BYTES of its own is recycled: its attached chat detaches now, and the next sweep stops every
    // session on it so the worker exits. Idle eviction off recycles none.
    if (idleMs === null) return;
    const quiet = quietWorkers(source.localRows(), { chats, pool, now: source.now() }).filter(worker => !worker.stop.some(row => this.out.has(row.sessionId)));
    if (!quiet.length) return;
    const own = await source.own(quiet.map(worker => worker.pid));
    for (const worker of recyclePlan(quiet, own)) {
      const gb = ((own.get(worker.pid) ?? 0) / 1024 ** 3).toFixed(2);
      if (worker.attached.length) {
        const detached = await Promise.all(worker.attached.map(id => source.restNow(id, RECYCLE_QUIET_MS)));
        if (detached.some(Boolean)) source.log(`idle unload: worker ${worker.pid} holds ${gb} GB of its own with every session quiet; detached ${worker.attached.filter((_, at) => detached[at]).map(id => source.title(id) ?? id.slice(0, 8)).join(", ")} to recycle it`);
        continue;
      }
      // Deepest first, one after another, as before: the worker exits once its last session stops.
      this.track((async () => {
        const names: string[] = [];
        for (const row of worker.stop) if (await this.stop(row, chats)) names.push(row.sessionName?.trim() || row.sessionId.slice(0, 8));
        if (names.length) source.log(`idle unload: recycled worker ${worker.pid} (${gb} GB of its own) by stopping ${names.length} quiet sessions: ${names.join(", ")}`);
      })());
    }
  }

  /** Waits until no stop is under way. */
  async settled(): Promise<void> {
    while (this.running.size) await Promise.allSettled([...this.running]);
  }

  private track(work: Promise<unknown>): void {
    const tracked = work.catch(error => this.source.log(`idle unload: ${error instanceof Error ? error.message : String(error)}`)).finally(() => { this.running.delete(tracked); });
    this.running.add(tracked);
  }

  /** The session's stop, shared by every caller while it is under way; true once the daemon stopped it. */
  private stop(row: SessionSummary, chats: ReadonlySet<string>, retry = false): Promise<boolean> {
    const known = this.out.get(row.sessionId);
    if (known) return known;
    const run = this.stopNow(row, chats, retry).catch(error => {
      this.source.log(`idle unload: ${row.sessionId.slice(0, 8)}: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }).finally(() => { this.out.delete(row.sessionId); });
    this.out.set(row.sessionId, run);
    return run;
  }

  private async stopNow(row: SessionSummary, chats: ReadonlySet<string>, retry: boolean): Promise<boolean> {
    const source = this.source;
    const failed = (answer: { error: string }): false => {
      if (skipUntilRowChanges(answer.error)) this.gone.add(goneKey(row));
      source.log(`idle unload: ${row.sessionId.slice(0, 8)}: ${answer.error}${skipUntilRowChanges(answer.error) ? "; skipped until its row changes" : ""}`);
      return false;
    };
    const since = source.now();
    const state = await source.request(row, "get_state");
    if (!state.success) return failed(state);
    if (stateBusy(state.data, retry)) { source.log(`idle unload: ${row.sessionId.slice(0, 8)}: the daemon shows it at work since the row was listed; kept`); return false; }
    const killed = await source.request(row, "kill");
    // The daemon's guard kept a detached service. Only this sweep skips the session: once the service exits, the next sweep stops it.
    if (!killed.success && killed.detachedHold) { source.log(`idle unload: ${row.sessionId.slice(0, 8)}: kept, it holds detached processes`); return false; }
    if (!killed.success) return failed(killed);
    this.gone.add(goneKey(row));
    await source.stopped(row, chats.has(row.sessionId), since);
    return true;
  }
}

/** A row's active session at its last activity; a reload or new work changes it, so only the stale row itself is skipped. */
const goneKey = (row: SessionSummary): string => `${row.activeSessionId ?? ""}@${row.lastActivityAt ?? ""}`;
