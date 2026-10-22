import { dirname } from "node:path";
import type { DaemonClient, SessionSummary } from "prime-agent";
import { poolFreeAt, type PoolStatus, type PoolThread, type ThreadParts, threadKey } from "./chat-pool.ts";
import { lastTurnError } from "./held-turns.ts";
import type { UnloadReceipt } from "./unloaded.ts";
import { afterMove, moveOf } from "./worker-move.ts";

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

/**
 * A session with a heartbeat or another scheduled job whose file sits in the daemon's sessions root (`sessionsDir`), where the daemon's wake
 * scan finds it: Prime loads such a session again for its next tick after any stop, and its own idle eviction stops it the same way
 * (daemon-supervisor.js `isWakeBlindScheduledWorker` keeps only a scheduled worker whose root file lies outside that root resident). Until
 * 10-21 every scheduled session stayed out of the unload: from 12:57Z to 13:46Z on 10-21, with no session working on us-metal02, the
 * babysitter and tiktok shop jobs (a 30 min heartbeat each) woke for each tick and kept 0.38 GB each until Prime evicted them 16 to 19 min
 * later, and from 15:22Z d7 named both as quiet trees. A subagent's file lies under session-artifacts, so its schedule keeps it loaded.
 */
export function wokenByScan(row: SessionSummary, sessionsDir: string | undefined): boolean {
  return sessionsDir !== undefined && row.sessionFile !== undefined && dirname(row.sessionFile) === sessionsDir;
}

const scheduled = (row: SessionSummary): boolean => row.hasRegisteredHeartbeat === true || row.hasRegisteredCronJob === true;

/**
 * Nothing streams, runs a tool, bash or child, compacts or is queued in the session, no detached process of its own lives (unless the unload
 * can hand it off), no schedule keeps it that the daemon's wake scan would miss (`wokenByScan`), and no client but the service's own attach
 * (judged by the caller) holds it.
 */
function calm(row: UnloadRow, pool: ReadonlySet<string>, handoff = false, sessionsDir?: string): boolean {
  return loaded(row) && row.workerState === "ready" && (handoff || !row.holdsDetachedProcesses) &&
    !row.isStreaming && !row.isCompacting && !row.isBashRunning && !row.hasRunningRlmChildren && !row.isRunningTools && !row.directAttachedClients &&
    (row.sessionActions?.queuedCount ?? 0) === 0 && (!scheduled(row) || wokenByScan(row, sessionsDir)) && !pool.has(row.sessionId);
}

/** Nothing runs or waits in the session (`calm`, and no turn or action open). */
function still(row: UnloadRow, pool: ReadonlySet<string>, handoff = false, sessionsDir?: string): boolean {
  return calm(row, pool, handoff, sessionsDir) && row.activity === "idle" && !row.isSessionActive && !row.unfinishedActionCount;
}

const unheld = (row: SessionSummary, attached: ReadonlySet<string>): boolean => !attached.has(row.sessionId) && row.attachedClients === 0;

function quiet(row: SessionSummary, input: { attached: ReadonlySet<string>; pool: ReadonlySet<string>; handoff?: (row: SessionSummary) => boolean; sessionsDir?: string }): boolean {
  return still(row, input.pool, input.handoff?.(row), input.sessionsDir) && unheld(row, input.attached);
}

/**
 * A session the daemon lists as working that is only asleep in Prime's provider retry: its turn is open, yet nothing streams, runs, compacts or
 * is queued in it. At 01:11Z on 10-19 176 sessions sat this way after a 429 (91) or pi-pool's token hook refusal "this session waits for its
 * slot at" (85), with 148 workers and 176 kernels (31.2 GB) that the unload left alone, since Prime counts a retrying session as active
 * (agent-session.ts `isRetrying`) and Prime's retry wait may last 8 days. The caller confirms from the transcript that the turn ended on a
 * failed reply (`lastTurnError`) and from pi-pool that its tree waits past the unload's minutes (`poolHoldsPast`).
 * A chat counts too, with no client attached but the service's own, which its stop lets go of first (`UnloadSource.release`); `Chats.revive` reopens it
 * once pi-pool admits its tree. Until 10-19 every chat stayed: at 06:03Z six chats sat asleep this way, each alone on its own worker with
 * 0.20 to 0.40 GB PSS and a kernel, SEO guy 562 min after its last activity (~/scratch/idle-ram/sessions-0603.json).
 */
function retrying(row: SessionSummary, input: { attached: ReadonlySet<string>; pool: ReadonlySet<string>; chats?: ReadonlySet<string>; handoff?: (row: SessionSummary) => boolean; sessionsDir?: string }): boolean {
  return calm(row, input.pool, input.handoff?.(row), input.sessionsDir) && row.activity === "working" && own(row, input);
}

/** No client holds the session but, for a chat, the service's own attach, which the stop lets go of first (`UnloadSource.release`). */
function own(row: SessionSummary, input: { attached: ReadonlySet<string>; chats?: ReadonlySet<string> }): boolean {
  return input.chats?.has(row.sessionId) ? row.attachedClients <= (input.attached.has(row.sessionId) ? 1 : 0) : unheld(row, input.attached);
}

/**
 * Prime's quota park (agent-session.ts `_parkForQuotaReset`, `retry.provider.waitForUsage.pauseUntilReset`, and since dhx.3 a provider wait
 * that outlasts idleEvictionMinutes) ends the failed turn, writes a `provider_quota_park` entry with `resumeAt`, and leaves a durable
 * `quota-resume` job that the daemon's scheduled wake loads the session for at that time. The session then reads idle, yet it held its worker
 * and kernel until the unload's usual wait: ENDED_MS for a job the daemon judged, idleEvictionMinutes for a chat until the hub let it go. From
 * 23:58Z on 10-20 to 00:41Z on 10-21 on us-metal02 no session worked while 86 quota-resume wakes fired; each probe met the same 429 within a
 * second and parked again, and the woken workers lived a median 157 s and up to 1058 s, about 8 of them resident at any time, while d7 read
 * 7.18 GB of Agent sessions. 199 of the 290 idle stops in that stretch were of a session parked this way. The AI harness VP chat woke at
 * 00:21:29Z, parked until 02:03:20Z at 00:21:30Z, and kept its worker until the unload stopped it at 00:37:42Z.
 */
export const QUOTA_PARK = "provider_quota_park";
export const QUOTA_RESUME = "provider_quota_resume";

/**
 * When a session's transcript tail says it sits in a quota park: its newest turn ended on a failed reply (`lastTurnError`), and its newest
 * park entry comes after any resume entry and names a `resumeAt` still ahead of `now`, so the daemon's durable wake restores it then. Null
 * otherwise, such as a park whose time passed or a session that took input or worked since.
 */
export function quotaParkedUntil(tail: string, now: number): number | null {
  if (lastTurnError(tail) === undefined) return null;
  const lines = tail.split("\n");
  for (let index = lines.length - 1; index >= 0; index--) {
    let line: { type?: unknown; customType?: unknown; data?: { resumeAt?: unknown } };
    try { line = JSON.parse(lines[index]!); } catch { continue; }
    if (line.type !== "custom") continue;
    if (line.customType === QUOTA_RESUME) return null;
    if (line.customType !== QUOTA_PARK) continue;
    const at = typeof line.data?.resumeAt === "string" ? Date.parse(line.data.resumeAt) : NaN;
    return Number.isFinite(at) && at > now ? at : null;
  }
  return null;
}

/**
 * The rows that may sit in a quota park (`quotaParkedUntil`), for the caller to check against their transcripts: nothing runs, waits or is
 * scheduled in the session but the park's own wake, nothing below it is at work, and no client holds it but a chat's service attach.
 */
export function parkCandidates(rows: readonly SessionSummary[], input: PlanInput): SessionSummary[] {
  if (input.idleMs === null) return [];
  const busy = busyAncestors(rows);
  return rows.filter(row => still(row, input.pool, input.handoff?.(row), input.sessionsDir) && own(row, input) && !busy.has(row.sessionId));
}

/** A daemon row with Prime's own park flag (agent-session.ts `isQuotaParked`, true from `_parkForQuotaReset` on), which the pinned typings lack. */
type ParkRow = SessionSummary & { isQuotaParked?: boolean };

/** What `parkChanges` compares for a parked row between two reads: its turn state, its clients and its transcript's last write. */
const parkKey = (row: SessionSummary): string =>
  JSON.stringify([row.activity, row.isSessionActive, row.unfinishedActionCount ?? 0, row.attachedClients, row.directAttachedClients ?? 0, row.workerState ?? "", row.modified ?? ""]);

/**
 * The loaded rows that read idle with Prime's park flag set and changed since the last read (`seen`, updated in place): a turn that ended on a
 * quota park, whose entry Prime appends before it ends the turn (`_parkForQuotaReset`), or a parked row whose client let go since. The idle
 * unload plans for them at once (`IdleUnloader.quieted`). The first read names every such row.
 */
export function parkChanges(seen: Map<string, string>, rows: readonly SessionSummary[]): string[] {
  const found: string[] = [];
  const now = new Map<string, string>();
  for (const row of rows as readonly ParkRow[]) {
    if (!loaded(row) || row.isQuotaParked !== true) continue;
    const key = parkKey(row);
    now.set(row.sessionId, key);
    if (row.activity === "idle" && !row.isSessionActive && seen.get(row.sessionId) !== key) found.push(row.sessionId);
  }
  seen.clear();
  for (const [id, key] of now) seen.set(id, key);
  return found;
}

/**
 * How long a session that ended its task sits quiet before the unload stops it, instead of idleEvictionMinutes: a subagent that replied to its
 * parent (`repliedSinceTask`), a session the daemon judged (`taskState`, set only once a turn ended), one with a board.wake pending (`waking`),
 * which asked to be unloaded while it waits, or one with a heartbeat or scheduled job the daemon's wake scan runs (`wokenByScan`), which waits
 * the same way. A chat keeps idleEvictionMinutes. At 00:52Z on 10-18 the 18 idle subagents that had replied held
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

/** The session a handoff runs for, and the active session id its kill goes to. */
export type HandoffRow = { sessionId: string; activeSessionId?: string };
export type HandOffResult = { done: true } | { done: false; error: string };

/** What `unloadPlan` and `retryCandidates` read besides the rows. */
export interface PlanInput { attached: ReadonlySet<string>; pool: ReadonlySet<string>; now: number; idleMs: number | null; chats?: ReadonlySet<string>;
  waking?: ReadonlySet<string>;
  /** The rows whose detached services the unload can hand off (`UnloadSource.handsOff`), so a detached process does not keep them. */
  handoff?: (row: SessionSummary) => boolean;
  /**
   * Sessions asleep in Prime's provider retry whose tree pi-pool holds past the unload's minutes, with when the hold ends (`poolHoldsPast`);
   * null for a chat whose tree the pool names no time for.
   */
  held?: ReadonlyMap<string, number | null>;
  /** Of `parkCandidates`, the sessions whose transcript shows a quota park (`quotaParkedUntil`), with its resume time; they stop at once. */
  parked?: ReadonlyMap<string, number>;
  /** The daemon's sessions root on this box, which its wake scan reads for schedules (`wokenByScan`); absent, a scheduled session stays. */
  sessionsDir?: string }

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
 * holds attached), or a subagent, idle for `idleMs` with nothing running, attached, queued or scheduled in it or below it, each candidate
 * asleep in its provider retry that `held` names, and at once each session in a quota park that `parked` names, a chat included, since the
 * park's durable wake loads it again. `idleMs` null (idle eviction off) stops none.
 */
export function unloadPlan(rows: readonly SessionSummary[], input: PlanInput): SessionSummary[] {
  const { idleMs } = input;
  if (idleMs === null) return [];
  const busy = busyAncestors(rows);
  const ended = (row: SessionSummary): boolean => !input.chats?.has(row.sessionId) &&
    ((row.runtimeKind === "subagent" && row.repliedSinceTask === true) || row.taskState !== undefined || input.waking?.has(row.sessionId) === true ||
      (scheduled(row) && wokenByScan(row, input.sessionsDir)));
  const wait = (row: SessionSummary): number => ended(row) ? Math.min(idleMs, ENDED_MS) : idleMs;
  const idle = rows.filter(row => quiet(row, input) && !busy.has(row.sessionId) && input.now - Date.parse(row.lastActivityAt ?? "") >= wait(row));
  const held = input.held ? retryCandidates(rows, input).filter(row => input.held!.has(row.sessionId)) : [];
  const parked = input.parked ? parkCandidates(rows, input).filter(row => input.parked!.has(row.sessionId)) : [];
  const planned = new Map([...idle, ...held, ...parked].map(row => [row.sessionId, row] as const));
  return [...planned.values()];
}

/**
 * Whether the unload stops a session asleep in its provider retry whose tree pi-pool next serves at `freeAt` (epoch ms, null when the pool
 * names no time), from a pool reading that came back. It stops when that comes after the unload's minutes or the pool names no time. A tree
 * the pool would serve sooner is left to Prime's retry and the job sweep's abort (ab65b511), which continue it in place. No hold is too long
 * to stop on: a chat's revive and the job sweep's resume pass (`resumeJobs`, --since-minutes 0) ask pi-pool again with no look-back.
 * A session that already waited the unload's minutes (`waitedMs`, since its last activity) stops on any hold the pool does not lift now, near
 * or not: at 16:18Z on 10-19 13 sessions sat 15 to 26 min in their retry on workers of their own (4.9 GB) while `pi-pool who` named a slot
 * that kept moving to about now (accounts were short, 12 to 81 trees waiting on each of 6), so no reading ever came past the window, and the
 * box OOM-killed 11 processes.
 */
export function poolHoldsPast(freeAt: number | null, now: number, idleMs: number, waitedMs = 0): boolean {
  if (freeAt === now) return false;
  return waitedMs >= idleMs || freeAt === null || freeAt > now + idleMs;
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
export function quietWorkers(rows: readonly SessionSummary[], input: { chats: ReadonlySet<string>; pool: ReadonlySet<string>; now: number; quietMs?: number; sessionsDir?: string }): QuietWorker[] {
  const quietMs = input.quietMs ?? RECYCLE_QUIET_MS;
  const byWorker = new Map<number, SessionSummary[]>();
  for (const row of rows) {
    if (!loaded(row) || row.workerPid === undefined) continue;
    byWorker.set(row.workerPid, [...byWorker.get(row.workerPid) ?? [], row]);
  }
  const depth = (row: SessionSummary): number => row.rlmDepth ?? (row.runtimeKind === "subagent" ? 1 : 0);
  const found: QuietWorker[] = [];
  for (const [pid, on] of byWorker) {
    const ok = on.every(row => still(row, input.pool, false, input.sessionsDir) && input.now - Date.parse(row.lastActivityAt ?? "") >= quietMs &&
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

/** Whether the daemon behind `hello` records a kill named `idle_unload` as an idle unload, so the stopped session stays restorable. */
export const takesKillOrigin = (hello: { serverCapabilities?: readonly string[] }) => (hello.serverCapabilities ?? []).includes(KILL_ORIGIN);

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
  /** This box's rows, which the worker recycle reads. */
  localRows(): readonly SessionSummary[];
  /**
   * Each other box's rows, which the worker recycle reads too when that box's daemon takes `kill_origin` (`recycles`): its stops then keep the
   * sessions restorable. A box without it is left to its daemon's own eviction (NO_BARE_KILL). Until 10-20 only this box's workers were
   * recycled, and the Mac's frontend bro worker 37191 held 5.9 to 6.3 GB for 10 sessions from 03:39Z to 06:10Z, 0.08 GB of it their work.
   */
  remoteBoxes?(): readonly { host: string; rows: readonly SessionSummary[]; recycles: boolean }[];
  /** The quiet window (src/quiet-minutes.ts) in ms; null when idle eviction is off. */
  idleMs(): number | null;
  /** This box's daemon sessions root (`PlanInput.sessionsDir`); absent, a session with a heartbeat or scheduled job is never stopped. */
  sessionsDir?: string;
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
  held(rows: readonly SessionSummary[], now: number, idleMs: number): Promise<ReadonlyMap<string, number | null>>;
  /** Of `rows` (`parkCandidates`), the ones whose transcript shows a quota park (`quotaParkedUntil`), with its resume time. Absent, none. */
  parked?(rows: readonly SessionSummary[], now: number): Promise<ReadonlyMap<string, number>>;
  /**
   * Lets go of the service's own attach on a chat asleep in its provider retry, right before its kill, and keeps it detached until the owner,
   * an agent message or its revive needs it. False when the service keeps it (a duty holds it or an open is under way); then it is not stopped.
   */
  release(id: string): Promise<boolean>;
  /**
   * Whether the service has an open of this session under way, chat or job (`ThreadHub.attaching`). Such a session is kept, checked right
   * before its kill: on 10-21 the quota-park kill of 01a15019 and 01a14fde went out at 08:36:06.434Z while their wake check's open was
   * attaching, and both attaches failed with "Active session ... closed during attach" at 08:36:06.7Z, a dirty d7 minute. Absent, none is.
   */
  attaching?(id: string): boolean;
  /** Each worker's own footprint in bytes, by pid, on the named box (this box when `host` is absent). */
  own(pids: readonly number[], host?: string): Promise<ReadonlyMap<number, number>>;
  restNow(id: string, quietMs: number): Promise<boolean>;
  title(id: string): string | null;
  /** `get_state` or the idle kill (`unloadRequest`) for the row's active session, through the daemon of the row's box. */
  request(row: SessionSummary, type: "get_state" | "kill"): Promise<DaemonAnswer>;
  /**
   * Runs after a kill succeeded: record the stop, and keep a chat or the owner's plain thread listed, since the kill writes the archived state.
   * `since` is when this stop began, so an explicit archive from then on wins.
   */
  stopped(row: SessionSummary, isChat: boolean, since: number): Promise<void>;
  /** Writes one unload receipt (src/unloaded.ts UNLOAD_RECEIPTS): `sent` before the kill, `stopped` or `failed` after its answer. Absent, none. */
  receipt?(receipt: UnloadReceipt): Promise<void>;
  /**
   * Hands the session's detached services to scopes of their own and then sends the idle kill (`detached-handoff.ts`), for a session the
   * guard kept. Absent, a kept session waits until its service exits. With `resume` it only finishes a handoff a crash left unfinished, and
   * answers null when there is none.
   */
  handOff?(row: HandoffRow, resume?: boolean): Promise<HandOffResult | null>;
  /**
   * Whether `handOff` can run for this row now: the row's daemon is this box's and its hello speaks the handoff (`speaksHandoff`). Absent,
   * every row can, once `handOff` is set. A row it cannot hand off keeps its old rule: a detached process keeps it out of the plan.
   */
  handsOff?(row: SessionSummary): boolean;
  /** The sessions whose handoff records hold an unfinished handoff (`orphan-services.ts` `unfinishedHandoffs`). */
  unfinishedHandoffs?(): Promise<readonly HandoffRow[]>;
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
 * root session as pi-pool keys it, the pool serves next only past the unload's minutes (`poolFreeAt`, `poolHoldsPast`), with when that
 * is. The trees are read WAIT_READ_TREES at a time.
 */
export async function providerWaits(rows: readonly SessionSummary[], now: number, idleMs: number, reads: WaitReads): Promise<Map<string, number | null>> {
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
    if (!parts) return [];
    const freeAt = poolFreeAt(parts, row.model!.provider, now);
    const waited = now - Date.parse(row.lastActivityAt ?? "");
    return poolHoldsPast(freeAt, now, idleMs, Number.isFinite(waited) ? waited : 0) ? [[row.sessionId, freeAt] as const] : [];
  }));
}

/**
 * The daemon's `get_state` shows the session doing something: a turn, a tool, a retry, a compaction, queued input, a background bash or a
 * detached process it started. For a session stopped while asleep in its provider retry (`retry`) the open turn is expected, and only a
 * stream, a compaction, a bash or a detached process keeps it: a retry that fired since the row was listed streams. With `handoff` a detached
 * process does not keep it, since the kill's guard answer hands the process off.
 */
function stateBusy(data: unknown, retry: boolean, handoff = false): boolean {
  const state = (typeof data === "object" && data !== null ? data : {}) as Partial<Pick<UnloadRow, "isSessionActive" | "isStreaming" | "isCompacting" | "isBashRunning" | "isRunningTools" | "holdsDetachedProcesses">>;
  return (!retry && state.isSessionActive !== false) || state.isStreaming === true || state.isCompacting === true || state.isBashRunning === true ||
    state.isRunningTools === true || (!handoff && state.holdsDetachedProcesses === true);
}

/**
 * The inputs queued in the session that its turn has not taken yet, steers and follow-ups, from `get_state`'s `sessionActions`. They live only in
 * the worker, so a stop drops them, and the daemon's list always reads 0 for them (agent-roster.ts writes `queuedCount: 0`). At 15:26:35Z on
 * 10-22 the stop of metal box owner (01a11d24-ac9b-757d-ac51-9b2b7598782f), asleep in a pi-pool account wait, dropped its 5 queued steers, and
 * the agent outbox had marked them delivered, so nobody sent them again. At 19:50Z, 13 of the 61 runs in pi-pool's turn queue held such input.
 */
export function queuedInputs(data: unknown): number {
  const actions = (typeof data === "object" && data !== null ? (data as { sessionActions?: { queuedCount?: unknown } }).sessionActions : undefined);
  return typeof actions?.queuedCount === "number" ? actions.queuedCount : 0;
}

/**
 * How long the sweep's line waits for one session's stop, its `get_state` and kill (30 s each) included. A stop still out then logs its own
 * line once it stops the session, and the next sweep does not ask that session again while it is out. From 22Z on 10-18 to 01:03Z on 10-19
 * the hung worker 114947 left the `get_state` of 01a150e1 timing out every minute.
 */
export const STOP_BOUND_MS = 75_000;
/** How often the service starts a sweep; a tick that finds the last sweep still running is skipped. */
export const SWEEP_EVERY_MS = 60_000;

/** A slow sweep's time in words: "312 s (chats 0 s, pool 309 s, ...)", from its start and the time each phase ended. */
export function slowWords(began: number, phases: readonly (readonly [string, number])[]): string {
  let last = began;
  const parts = phases.map(([name, at]) => { const part = `${name} ${Math.round((at - last) / 1000)} s`; last = at; return part; });
  return `${Math.round((last - began) / 1000)} s (${parts.join(", ")})`;
}

/** How long the sweep waits for `held` (transcript tails and the pool reads, one per WAIT_READ_TREES trees) before it plans without it. */
export const HELD_BOUND_MS = 45_000;

const within = <T>(work: Promise<T>, ms: number, late: T): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([work, new Promise<T>(resolve => { timer = setTimeout(() => resolve(late), ms); timer.unref?.(); })]).finally(() => clearTimeout(timer));
};
/**
 * An answer that leaves the session nothing to free until its row changes: a session the daemon does not know, a bare kill it refuses, and a
 * worker that failed after the row was listed (10-20 02:11:23Z: slack green guy 01a11b0b), which holds no live session to stop.
 */
const skipUntilRowChanges = (error: string): boolean => /Unknown active session|Session worker is failed/.test(error) || error === NO_BARE_KILL;

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
  /** The sessions `quieted` named that its plan under way has not read yet, and that plan. */
  private readonly pending = new Set<string>();
  private quick: Promise<void> | undefined;

  constructor(private readonly source: UnloadSource) {}

  /**
   * Plans from the rows now and starts each stop and recycle. Resolves once they have started, not once they end (`settled`). With `only` it
   * plans for those sessions alone and recycles no worker (`quieted`).
   */
  async sweep(only?: ReadonlySet<string>): Promise<void> {
    const source = this.source;
    const idleMs = source.idleMs();
    if (only && (idleMs === null || !only.size)) return;
    const began = source.now();
    const phases: [string, number][] = [];
    const lap = (name: string): void => { phases.push([name, source.now()]); };
    const chats = await source.chats();
    const attached = new Set([...chats].filter(id => !source.dormant(id)));
    lap("chats");
    // A park plan reads neither the pool nor the wakes: a parked session holds no turn in pi-pool, and a wake only sets an idle session's wait.
    // From 17:30:39Z to 17:35:57Z on 10-21 every sweep and every park plan of us-metal02 sent no stop at all, and 18 parked sessions were
    // stopped together at 17:35:57Z, so one of these reads held them all.
    const pool = only ? new Set<string>() : await source.pool();
    lap("pool");
    const now = source.now();
    const waking = only ? new Set<string>() : await source.waking(now);
    lap("wakes");
    const input: PlanInput = { attached, pool, now, idleMs, chats, waking, handoff: row => this.handsOff(row), ...source.sessionsDir === undefined ? {} : { sessionsDir: source.sessionsDir } };
    const fresh = (row: SessionSummary): boolean => (!only || only.has(row.sessionId)) && !this.out.has(row.sessionId) && !this.gone.has(goneKey(row));
    const candidates = retryCandidates(source.rows(), input).filter(fresh);
    const held = candidates.length && idleMs !== null
      ? await within(source.held(candidates, now, idleMs).catch(error => { source.log(`idle unload: provider waits: ${error instanceof Error ? error.message : String(error)}`); return new Map<string, number | null>(); }),
        HELD_BOUND_MS, new Map<string, number | null>())
      : new Map<string, number | null>();
    lap("pool waits");
    const parkable = source.parked ? parkCandidates(source.rows(), input).filter(fresh) : [];
    const parked = parkable.length
      ? await within(source.parked!(parkable, now).catch(error => { source.log(`idle unload: quota parks: ${error instanceof Error ? error.message : String(error)}`); return new Map<string, number>(); }),
        HELD_BOUND_MS, new Map<string, number>())
      : new Map<string, number>();
    lap("parks");
    const plan = unloadPlan(source.rows(), { ...input, held, parked }).filter(fresh);
    if (!only && source.handOff && source.unfinishedHandoffs) this.track(this.resumeUnloaded(source.handOff.bind(source), source.unfinishedHandoffs()));
    if (plan.length) {
      // Each stop is bounded on its own (STOP_BOUND_MS). The sweep's line names the stops done by then; a later one logs its own line.
      const named = (row: SessionSummary): string => {
        const name = row.sessionName?.trim() || row.sessionId;
        const park = parked.get(row.sessionId);
        if (park !== undefined && !held.has(row.sessionId)) return `${name} (parked on its provider quota until ${new Date(park).toISOString().slice(11, 16)}Z)`;
        const until = held.get(row.sessionId);
        if (until === undefined) return name;
        return until === null ? `${name} (waits on pi-pool, which names no time)` : `${name} (waits on pi-pool until ${new Date(until).toISOString().slice(11, 16)}Z)`;
      };
      this.track(Promise.all(plan.map(row => {
        const stop = this.stop(row, chats, held.has(row.sessionId) ? "pool wait" : parked.has(row.sessionId) ? "quota park" : "idle");
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
    if (idleMs === null || only) return;
    // Pids repeat across boxes, so each box's workers are judged and measured apart.
    const boxes = [{ host: undefined as string | undefined, rows: source.localRows() },
      ...(source.remoteBoxes?.() ?? []).filter(box => box.recycles).map(box => ({ host: box.host as string | undefined, rows: box.rows }))];
    for (const box of boxes) await this.recycle(box.rows, box.host, chats, pool);
    lap("recycle");
    // A sweep past SWEEP_EVERY_MS holds off the next one (the service skips a tick while one runs), so it names where its time went.
    if (source.now() - began > SWEEP_EVERY_MS) source.log(`idle unload: the sweep took ${slowWords(began, phases)}`);
  }

  /**
   * Plans at once for sessions whose row just read parked (`parkChanges`), between the minute sweeps, so a session that parked on its
   * provider quota stops seconds after its park instead of at the next sweep. From 13:41:13Z to 13:41:29Z on 10-21, with no session working on
   * us-metal02, 27 quota-resume wakes fired, each met the same 429 and parked within a second, and all of them kept their workers until the
   * 13:42:07Z sweep; the 13:41:30Z watch line read 5.07 GB of Agent sessions against 2.95 GB two minutes before (d7 target 5 GB). One such
   * plan runs at a time, and sessions that read parked meanwhile go into the next.
   */
  quieted(ids: Iterable<string>): Promise<void> {
    for (const id of ids) this.pending.add(id);
    if (!this.quick && this.pending.size) this.quick = this.drain();
    return this.quick ?? Promise.resolve();
  }

  private async drain(): Promise<void> {
    try {
      while (this.pending.size) {
        const only = new Set(this.pending);
        this.pending.clear();
        await this.sweep(only).catch(error => this.source.log(`idle unload: ${error instanceof Error ? error.message : String(error)}`));
      }
    } finally { this.quick = undefined; }
  }

  /** Recycles the quiet workers of one box whose own footprint reached RECYCLE_OWN_BYTES. */
  private async recycle(rows: readonly SessionSummary[], host: string | undefined, chats: ReadonlySet<string>, pool: ReadonlySet<string>): Promise<void> {
    const source = this.source;
    const quiet = quietWorkers(rows, { chats, pool, now: source.now(), ...host === undefined && source.sessionsDir !== undefined ? { sessionsDir: source.sessionsDir } : {} })
      .filter(worker => !worker.stop.some(row => this.out.has(row.sessionId)));
    if (!quiet.length) return;
    const own = await (host === undefined ? source.own(quiet.map(worker => worker.pid)) : source.own(quiet.map(worker => worker.pid), host));
    const on = host === undefined ? "" : ` on ${host}`;
    for (const worker of recyclePlan(quiet, own)) {
      const gb = ((own.get(worker.pid) ?? 0) / 1024 ** 3).toFixed(2);
      if (worker.attached.length) {
        const detached = await Promise.all(worker.attached.map(id => source.restNow(id, RECYCLE_QUIET_MS)));
        if (detached.some(Boolean)) source.log(`idle unload: worker ${worker.pid}${on} holds ${gb} GB of its own with every session quiet; detached ${worker.attached.filter((_, at) => detached[at]).map(id => source.title(id) ?? id).join(", ")} to recycle it`);
        continue;
      }
      // Deepest first, one after another, as before: the worker exits once its last session stops.
      this.track((async () => {
        const names: string[] = [];
        for (const row of worker.stop) if (await this.stop(row, chats)) names.push(row.sessionName?.trim() || row.sessionId);
        if (names.length) source.log(`idle unload: recycled worker ${worker.pid}${on} (${gb} GB of its own) by stopping ${names.length} quiet sessions: ${names.join(", ")}`);
      })());
    }
  }

  /**
   * Finishes the handoffs a crash left unfinished for sessions the daemon no longer holds loaded, such as one killed after its receipt was
   * written. A loaded session's handoff is finished by its own stop (`stopNow`), after the daemon shows it idle.
   */
  private async resumeUnloaded(handOff: NonNullable<UnloadSource["handOff"]>, unfinished: Promise<readonly HandoffRow[]>): Promise<void> {
    const live = new Set(this.source.rows().filter(loaded).map(row => row.sessionId));
    for (const row of await unfinished) {
      if (live.has(row.sessionId) || this.out.has(row.sessionId)) continue;
      const resumed = await handOff(row, true);
      if (resumed) this.source.log(`idle unload: ${row.sessionId}: ${resumed.done ? "finished the handoff a crash left open" : `the handoff a crash left open: ${resumed.error}`}`);
    }
  }

  /** Whether this row's detached services can be handed off now (`UnloadSource.handOff` and `handsOff`). */
  private handsOff(row: SessionSummary): boolean {
    return this.source.handOff !== undefined && (this.source.handsOff?.(row) ?? true);
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
  private stop(row: SessionSummary, chats: ReadonlySet<string>, why: UnloadReceipt["why"] = "idle"): Promise<boolean> {
    const known = this.out.get(row.sessionId);
    if (known) return known;
    const run = this.stopNow(row, chats, why).catch(error => {
      this.source.log(`idle unload: ${row.sessionId}: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }).finally(() => { this.out.delete(row.sessionId); });
    this.out.set(row.sessionId, run);
    return run;
  }

  /**
   * The daemon's answer to `type` for `row`; when it refuses because the session's worker is stopping or starting, get_state is read every
   * MOVE_READ_MS until it answers otherwise, and `type` goes once more (src/worker-move.ts `afterMove`). `moved` hears that it waited.
   */
  private async askedThroughMove(row: SessionSummary, type: "get_state" | "kill", moved?: () => void): Promise<DaemonAnswer> {
    let refused: DaemonAnswer | undefined;
    const ask = async (): Promise<DaemonAnswer> => {
      const answer = await this.source.request(row, type);
      if (!answer.success && moveOf(answer.error) !== undefined) { refused = answer; throw new Error(answer.error); }
      return answer;
    };
    try { return await afterMove(ask, () => this.source.request(row, "get_state"), () => moved?.()); }
    catch (error) { if (refused && moveOf(error) !== undefined) return refused; throw error; }
  }

  private async stopNow(row: SessionSummary, chats: ReadonlySet<string>, why: UnloadReceipt["why"]): Promise<boolean> {
    const source = this.source;
    const retry = why === "pool wait";
    const failed = (answer: { error: string }): false => {
      if (skipUntilRowChanges(answer.error)) this.gone.add(goneKey(row));
      source.log(`idle unload: ${row.sessionId}: ${answer.error}${skipUntilRowChanges(answer.error) ? "; skipped until its row changes" : ""}`);
      return false;
    };
    const since = source.now();
    // A worker that is stopping or starting is waited out and asked once more (`askedThroughMove`). A session that its worker's stop took
    // along has nothing left to stop: on 10-21 at 19:46:07Z this check met ops guy (+observability)'s stopping worker and failed, a d7 minute.
    let moved = false;
    const state = await this.askedThroughMove(row, "get_state", () => { moved = true; });
    if (!state.success && moved && skipUntilRowChanges(state.error)) {
      this.gone.add(goneKey(row));
      source.log(`idle unload: ${row.sessionId}: its worker exited with it while this check waited; nothing left to stop`);
      return false;
    }
    if (!state.success) return failed(state);
    const queued = queuedInputs(state.data);
    if (queued > 0) { source.log(`idle unload: ${row.sessionId}: holds ${queued} queued inputs that a stop would drop; kept`); return false; }
    if (stateBusy(state.data, retry, this.handsOff(row))) { source.log(`idle unload: ${row.sessionId}: the daemon shows it at work since the row was listed; kept`); return false; }
    // The service lets go of a chat first: the kill closes the session under its attach, and the hub would open it again at once.
    if (why !== "idle" && chats.has(row.sessionId) && !await source.release(row.sessionId)) { source.log(`idle unload: ${row.sessionId}: the service holds the chat for a duty or an open; kept`); return false; }
    // A handoff a crash left open ends with its own kill: after its commit no detached group is left for the guard to refuse.
    const receipt = (phase: UnloadReceipt["phase"], error?: string) => source.receipt?.({ at: new Date(source.now()).toISOString(), phase, sessionId: row.sessionId,
      activeSessionId: row.activeSessionId ?? "", why, ...error === undefined ? {} : { error } })
      .catch(failure => source.log(`idle unload: ${row.sessionId}: receipt: ${failure instanceof Error ? failure.message : String(failure)}`));
    const opening = (): boolean => source.attaching?.(row.sessionId) === true;
    if (opening()) { source.log(`idle unload: ${row.sessionId}: an open is attaching to it; kept`); return false; }
    await receipt("sent");
    const resumed = this.handsOff(row) ? await source.handOff!(row, true) : null;
    if (resumed && !resumed.done) { await receipt("failed", resumed.error); source.log(`idle unload: ${row.sessionId}: kept, the handoff a crash left open: ${resumed.error}`); return false; }
    if (resumed) source.log(`idle unload: ${row.sessionId}: finished the handoff a crash left open`);
    else {
      if (opening()) { await receipt("failed", "an open is attaching to it"); source.log(`idle unload: ${row.sessionId}: an open is attaching to it; kept`); return false; }
      const killed = await this.askedThroughMove(row, "kill");
      // The daemon's guard kept a detached service. With a handoff source the services move to scopes of their own and the kill goes out
      // again; without one only this sweep skips the session, and once the service exits the next sweep stops it.
      if (!killed.success && killed.detachedHold) {
        const handed = this.handsOff(row) && row.activeSessionId ? await source.handOff!(row) : null;
        if (!handed?.done) { await receipt("failed", handed?.error ?? killed.error); source.log(`idle unload: ${row.sessionId}: kept, it holds detached processes${handed ? `; handoff: ${handed.error}` : ""}`); return false; }
        source.log(`idle unload: ${row.sessionId}: handed its detached services to their own scopes`);
      }
      else if (!killed.success) { await receipt("failed", killed.error); return failed(killed); }
    }
    await receipt("stopped");
    this.gone.add(goneKey(row));
    await source.stopped(row, chats.has(row.sessionId), since);
    return true;
  }
}

/** A row's active session at its last activity; a reload or new work changes it, so only the stale row itself is skipped. */
const goneKey = (row: SessionSummary): string => `${row.activeSessionId ?? ""}@${row.lastActivityAt ?? ""}`;
