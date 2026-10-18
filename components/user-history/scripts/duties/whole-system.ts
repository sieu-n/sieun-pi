import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { DutyStore } from "../../src/chat-duty-store.ts";
import { ownerChats } from "../../src/owner-chats.ts";
import { type Cut, cutWords, readCut, tailLines, type CutCause } from "../../src/cut-end.ts";
import { activePause, checkInSettings } from "../../src/checkin-settings.ts";
import { BoardStore } from "../../src/chat-board-store.ts";
import { OPEN, walk } from "../../src/checkin-steps.ts";
import type { ChatBoard, MemoryGroupId } from "../../src/shared/types.ts";
import { type HostUsable, isLinuxReading, parseLinuxReading, readWatch, type SleepingLine, unusable, type WaitingTree, type WatchLine, type WorkerLine } from "../../src/mac-usable-watch.ts";
import { chatDataDir } from "../../src/owner-ok.ts";
import { CHECK_IN_DUTY_ID, type DutyRunRecord, type FlaggedSlice, type PrecheckOutput } from "../../src/shared/chat-duties.ts";
import { CHANGE_APPROACH_MISSES, effectiveRun, missStreak } from "../../src/shared/duty-streak.ts";

/** One box's numbers in a watch line: the box that wrote the line, then each other box it read through that box's relay (HostWatchLine). */
export interface HostView { name: string; usable: HostUsable | null; workers: number; workerGb: number; top: readonly WorkerLine[]; serviceGb?: number; sleeping?: SleepingLine; error?: string }
/** Lines written before 10-18 04:5xZ name no box, and the Mac wrote every one of them. */
export const UNNAMED_HOST = "mac";

/** A Linux reading a line kept from before host-stats.ts read the CPU set, or a malformed one, is no reading (`parseLinuxReading`). */
export const OLD_LINUX_READING = "an old-format or invalid Linux reading";
const checked = (usable: HostUsable | null | undefined): { usable: HostUsable | null; error?: string } =>
  !usable || !isLinuxReading(usable) || parseLinuxReading(usable) ? { usable: usable ?? null } : { usable: null, error: OLD_LINUX_READING };

/** The boxes of a watch line, the writer first. Since 04:20Z on 10-18 the chat runs on us-metal02 and reads the Mac through its relay. */
export function hostViews(line: WatchLine): HostView[] {
  const own = checked(line.usable);
  return [
    { name: line.host ?? UNNAMED_HOST, usable: own.usable, workers: line.workers, workerGb: line.workerGb, top: line.top,
      ...line.serviceGb === undefined ? {} : { serviceGb: line.serviceGb }, ...line.sleeping ? { sleeping: line.sleeping } : {}, ...own.error ? { error: own.error } : {} },
    ...(line.hosts ?? []).map(host => {
      const read = checked(host.usable);
      const error = host.error ?? read.error;
      return { name: host.name, usable: read.usable, workers: host.workers, workerGb: host.workerGb, top: host.top,
        ...host.sleeping ? { sleeping: host.sleeping } : {}, ...error ? { error } : {} };
    }),
  ];
}

const feedGroups = (usable: HostUsable | null): Partial<Record<MemoryGroupId, number>> | undefined => usable && !isLinuxReading(usable) ? usable.groups : undefined;

/**
 * An unusable minute is the harness's when agent sessions hold the largest share of the box's memory that minute, or of its growth since the
 * line before, by the groups the Mac's pressure feed sums every owner into (`groups`); a reading with no groups (a Linux box, or a Mac line
 * written before 10-18 01:40Z) is never the harness's. Agent sessions take
 * at least the Prime workers' footprint the watch measures itself plus the chat service, since each chat tree is its own feed owner and most
 * fall below the 8 largest. Whether a minute is unusable at all comes only from the box's reading (`unusable`). A fixed 16 GB line, and before it a
 * 14-turn line, sent minutes with 22 to 26 job turns at work to the apps' side (01:10Z and 01:24Z on 10-18).
 */
export function memoryShares(view: HostView): Map<MemoryGroupId, number> {
  const shares = new Map<MemoryGroupId, number>();
  for (const [id, gb] of Object.entries(feedGroups(view.usable) ?? {})) shares.set(id as MemoryGroupId, gb);
  shares.set("agents", Math.max(shares.get("agents") ?? 0, view.workerGb + (view.serviceGb ?? 0)));
  return shares;
}

const leads = (shares: ReadonlyMap<MemoryGroupId, number>): boolean => {
  const agents = shares.get("agents") ?? 0;
  return agents > 0 && [...shares].every(([id, gb]) => id === "agents" || gb < agents);
};

/**
 * Whether agent sessions hold the largest footprint of the box in `view`, or the largest growth since `previous` (the same box in the line
 * before) when that line is at most 2 minutes older. A reading with no groups has no shares to compare and goes to the apps' or owner's side.
 */
export function isHarnessMinute(view: HostView, previous?: { view: HostView; gapMs: number }): boolean {
  if (!feedGroups(view.usable)) return false;
  const now = memoryShares(view);
  if (leads(now)) return true;
  if (!previous || !feedGroups(previous.view.usable) || previous.gapMs > 2 * MINUTE) return false;
  const before = memoryShares(previous.view);
  const growth = new Map([...now].map(([id, gb]) => [id, gb - (before.get(id) ?? 0)] as const));
  return (growth.get("agents") ?? 0) > 0 && leads(growth);
}

/** `isHarnessMinute` for each box of a line of `lines`, judged against the same box in the line before it there. */
export function harnessSide(lines: readonly WatchLine[]): (line: WatchLine, view: HostView) => boolean {
  const previous = new Map(lines.map((line, at) => [line, lines[at - 1]] as const));
  return (line, view) => {
    const before = previous.get(line);
    const same = before && hostViews(before).find(candidate => candidate.name === view.name);
    return isHarnessMinute(view, same ? { view: same, gapMs: Date.parse(line.at) - Date.parse(before.at) } : undefined);
  };
}

/**
 * The Whole system duty's precheck (`node --import tsx scripts/duties/whole-system.ts`), run every 30 minutes on the owner's 10-15 ask
 * ("reorganize duties have a 30 minute trigger that checks all this", mva1wt2h). It reads files the chat service and pi-pool already write and
 * makes no daemon call: the usable watch, whose lines carry each box's pi-pool limits and queue, service.log, and every chat's duty
 * runs. The headline is how many of the last 30 minutes ran clean: a minute is clean when the watch read every box usable, no start, wake or parked
 * job had waited over HOLD_MS, and no turn sat queued while pi-pool had a slot it was allowed to give it (`freeSlotWait`). Supporting: queue holds and open steps nobody
 * moves in all chats, and the memory sessions idle past the idle window still hold (`sleeping_gb`, owner c92). The rest is detail, with each
 * harness process far above its normal size (`oversized`).
 * A job whose last turn was cut (`cutEnd`) and that got no new input since is a start that waits too: after the restart at 00:19:57Z on 10-16 the
 * fleet budget logged a continue for local agents checks, local agents recovery and daily code health report at 00:21:17Z, none reached its
 * session, and the check-in read them as moving or gone while the agents panel showed done. A cut job with a later input, such as a continue
 * that waits in pi-pool's queue, is not cut, so ordinary queueing never counts here.
 */

export const WINDOW_MS = 30 * 60_000;
const MINUTE = 60_000;
/** A start, wake or parked job waiting longer than this is a hold: the owner's line on 10-15, when 38 jobs' wakes sat held 3,374 times. */
export const HOLD_MS = 10 * MINUTE;
/** Free slots that make a queued turn a queue fault: two, so one slot a release just freed is not counted. */
export const FREE_SLOTS = 2;
/** A queued turn counts against free slots only once the oldest one waited this long, past pi-pool's admit poll. */
export const QUEUED_WAIT_S = 120;
/** The resume rule's look-back (resume_paused.py --since-minutes defaults to 1440): a job cut longer ago than this is left to its chat. */
export const CUT_LOOKBACK_MS = 24 * 60 * MINUTE;
/**
 * Job folders read at once by `findCutJobs`. At 06:48Z on 10-16 a one-at-a-time walk of 3,458 job folders, with each folder's rlm-subagent.json
 * read before its age check, took 106 s under load and the precheck hit its 60 s limit.
 */
const WALK_AT_ONCE = 16;
/** About 3 h of service.log at 10-16's rate (1.7 MB an hour, most of it held wakes), so a hold that began before the window is seen whole. */
const LOG_TAIL_BYTES = 6_000_000;

export interface Hold { what: string; from: number; to: number }
/** A continue or wake the fleet budget let through for a session (`starts after N s`): proof the start was admitted. */
export interface Grant { kind: string; session: string; at: number; waitS: number }
export interface LogFacts { holds: Hold[]; grants?: Grant[]; firstAt?: number }
/** A job session whose last turn was cut and that got no input since (`cutEnd`), found in a live chat's tree. */
export interface CutJob { session: string; name: string; chat: string; at: number; cause: CutCause; root?: { session: string; name: string }; proof?: string;
  /** A later session in the same chat that carries the job's name: the work went to that replacement. */
  replacedBy?: string }

/**
 * When the Prime daemon stopped work nobody asked to stop, from its logs: each supervisor restart window (from DAEMON_RESTART_LEAD_MS before the
 * old supervisor's last line to the new one's "listening" line) and each worker SIGTERM. The same rules as resume_paused.py's daemon_restarts
 * and worker_shutdowns, which lost agent resumes owns.
 */
export interface DaemonStops { restarts: readonly (readonly [number, number])[]; sigterms: readonly number[] }
const DAEMON_LINE = /^\[(\S+Z)\] /;
const SUPERVISOR_LISTENING = /^\[\S+Z\] supervisor: Prime Agent daemon supervisor \S+ listening/;
const WORKER_SIGTERM = /^\[\S+Z\] supervisor: Session worker \w+ stderr: received SIGTERM/;
export const DAEMON_RESTART_LEAD_MS = 5_000;
/** An abort this close to its worker's SIGTERM line is the shutdown's: they came 0.002 s before to 0.049 s after it (resume_paused.py). */
export const SIGTERM_MATCH_MS = 1_000;

/** The restart windows and worker SIGTERMs in one daemon log's lines. */
export function readDaemonStops(lines: readonly string[]): DaemonStops {
  const restarts: [number, number][] = [];
  const sigterms: number[] = [];
  let previous: number | undefined;
  for (const line of lines) {
    const stamp = DAEMON_LINE.exec(line);
    if (!stamp) continue;
    const at = Date.parse(stamp[1]!);
    if (!Number.isFinite(at)) continue;
    if (SUPERVISOR_LISTENING.test(line) && previous !== undefined && previous <= at) restarts.push([previous - DAEMON_RESTART_LEAD_MS, at]);
    if (WORKER_SIGTERM.test(line)) sigterms.push(at);
    previous = at;
  }
  return { restarts, sigterms };
}

/**
 * The proof that an archived cut was an interruption: its archive or abort fell inside a supervisor restart window or at a worker SIGTERM.
 * Undefined when there is none, which is a deliberate stop (a parent's rlm.delete_subagent, the parker, a person) or work replaced since.
 */
export function interruptionProof(cut: { at: number; archivedAt?: number }, stops: DaemonStops): string | undefined {
  const moments = [cut.archivedAt, cut.at].filter((at): at is number => at !== undefined && Number.isFinite(at));
  const window = stops.restarts.find(([from, to]) => moments.some(at => from <= at && at <= to));
  if (window) return `archived inside the supervisor restart from ${clock(window[0])} to ${clock(window[1])}`;
  const sigterm = stops.sigterms.find(stamp => moments.some(at => Math.abs(at - stamp) <= SIGTERM_MATCH_MS));
  return sigterm === undefined ? undefined : `aborted at its worker's SIGTERM at ${new Date(sigterm).toISOString().slice(11, 19)}Z`;
}
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const TIME = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z) (.*)$/;
/** A due wake the service could not send this tick: held by the old fleet budget, or a send the daemon failed. */
const WAKE_HELD = /^wakes: wake (\w{8}) for .*; tried again next tick$/;
/**
 * A run wake whose run read failed this tick. On 10-18 the CI cache answered "not in the cache" for three slack-green runs every 2 min for 60
 * to 71 h, and the jobs that set those wakes were never woken, while queue_holds_30 read 0.
 */
const RUN_UNREADABLE = /^wakes: run (\d+): /;
const STARTED_AFTER = /^fleet budget: (\S+) (.+) starts after (\d+) s$/;
/** Lines of one wake held this far apart are one hold; the wake loop tries each held wake every tick. */
const HOLD_GAP_MS = 5 * MINUTE;

/** The holds in service.log lines from `since` on; a hold may start before `since`, so the caller reads back far enough. */
export function readServiceLog(lines: readonly string[]): LogFacts {
  const wakes = new Map<string, Hold>();
  const runs = new Map<string, Hold>();
  const holds: Hold[] = [];
  const extend = (open: Map<string, Hold>, key: string, what: string, at: number) => {
    const hold = open.get(key);
    if (hold && at - hold.to <= HOLD_GAP_MS) hold.to = at;
    else { const fresh = { what, from: at, to: at }; open.set(key, fresh); holds.push(fresh); }
  };
  const grants: Grant[] = [];
  let at = NaN;
  for (const raw of lines) {
    const match = TIME.exec(raw);
    if (match) at = Date.parse(match[1]!);
    if (!Number.isFinite(at)) continue;
    const text = match ? match[2]! : raw;
    let found: RegExpExecArray | null;
    if ((found = WAKE_HELD.exec(text))) extend(wakes, found[1]!, `wake of ${found[1]}`, at);
    else if ((found = RUN_UNREADABLE.exec(text))) extend(runs, found[1]!, `wake on unreadable run ${found[1]}`, at);
    else if ((found = STARTED_AFTER.exec(text))) {
      holds.push({ what: `${found[1]} ${found[2]}`, from: at - Number(found[3]) * 1000, to: at });
      if ((found[1] === "continue" || found[1] === "wake") && SESSION_ID.test(found[2]!)) grants.push({ kind: found[1], session: found[2]!, at, waitS: Number(found[3]) });
    }
  }
  const first = lines.find(line => TIME.test(line));
  return { holds, grants, ...(first ? { firstAt: Date.parse(TIME.exec(first)![1]!) } : {}) };
}

/**
 * The tree of a turn queued QUEUED_WAIT_S or longer that pi-pool was allowed to admit and did not, by its own rule (`admit_pass` in
 * pool/turns.py): the machine under working_max slots and the turn's tree under tree_working_max, each with FREE_SLOTS to spare, since a
 * waiter takes a slot a release just freed on its next 1 s poll. A turn its tree's cap holds is pi-pool's limit at work: at 04:30Z on 10-18
 * metal-management's turns waited 167 s at 8 of 8 while the box held 12 of 16 slots, and the old machine-only test called it a free slot.
 * A line written before the watch recorded pi-pool's limits and slots is not judged.
 */
export function freeSlotWait(line: WatchLine): WaitingTree | undefined {
  const queue = line.queue;
  if (!queue?.waiting || queue.workingMax === undefined || queue.treeWorkingMax === undefined || queue.slots === undefined) return undefined;
  if (queue.slots > queue.workingMax - FREE_SLOTS) return undefined;
  return queue.waiting.find(tree => tree.oldestWaitS >= QUEUED_WAIT_S && tree.slots <= queue.treeWorkingMax! - FREE_SLOTS);
}

/**
 * A harness process is far above its normal size at FAR_ABOVE times its kind's median over the last day of watch lines: on 10-17 at 23:45Z
 * workers holding one idle session read 145 to 360 MB, a 2.5x spread, so 3x the median sits past ordinary variation.
 */
export const FAR_ABOVE = 3;
const DAY_MS = 24 * 60 * MINUTE;

const median = (values: readonly number[]): number | undefined => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : undefined;
};

/** The harness processes in the newest watch line over FAR_ABOVE times their kind's median in `day` on the same box: Prime workers by tree, and the chat service. */
export function oversized(latest: WatchLine | undefined, day: readonly WatchLine[]): string[] {
  if (!latest) return [];
  const found: string[] = [];
  const dayViews = day.flatMap(hostViews);
  for (const view of hostViews(latest)) {
    const own = dayViews.filter(candidate => candidate.name === view.name);
    const worker = median(own.filter(candidate => candidate.workers > 0).map(candidate => candidate.workerGb / candidate.workers));
    if (worker !== undefined) for (const line of view.top) if (line.gb > FAR_ABOVE * worker) found.push(`${view.name}: Prime worker ${line.pid} (${line.tree || "no tree"}, ${line.sessions} sessions) holds ${line.gb} GB, over ${FAR_ABOVE}x the day's median worker there of ${worker.toFixed(2)} GB`);
    const service = median(own.flatMap(candidate => candidate.serviceGb === undefined ? [] : [candidate.serviceGb]));
    if (service !== undefined && view.serviceGb !== undefined && view.serviceGb > FAR_ABOVE * service) found.push(`${view.name}: the chat service holds ${view.serviceGb} GB, over ${FAR_ABOVE}x its day's median of ${service.toFixed(2)} GB`);
  }
  return found;
}

export interface Inputs {
  now: number;
  watch: readonly WatchLine[];
  /** The last day of watch lines, for each harness process's normal size (`oversized`); absent, no process is judged. */
  day?: readonly WatchLine[];
  log: LogFacts;
  /** Every chat's duty runs, newest first, with its active duty ids (the check-in included unless paused), and whether its check-in is paused. */
  chats: readonly { id: string; name: string; duties: readonly { id: string; name: string }[]; runs: readonly DutyRunRecord[]; everyMs?: number; paused?: boolean }[];
  /** Jobs in live chats whose last turn was cut and that got no input since (`cutEnd`). */
  cut?: readonly CutJob[];
  /** Each chat's live board, for a check-in whose snapshot is older than the board's last write (`liveStuck`). */
  boards?: ReadonlyMap<string, ChatBoard | null>;
  /** When each session that owns an open step last wrote its transcript, ms. */
  ownerActivity?: ReadonlyMap<string, number>;
}

/**
 * The stuck steps of a check-in snapshot still stuck on the live board. A snapshot taken before the board's last write is out of date: at 04:48Z
 * on 10-18 d7 counted chat-057a's steps from its 04:32Z check-in, taken before the chat moved to us-metal02, while its board had moved on to rev
 * 217 with every open step owned by a live box job. A flagged step counts only while it is still open on the live board and its owner session
 * has not written since the snapshot; a step the chat closed, removed, or gave to a job that is working drops out. An up-to-date snapshot counts as read.
 */
export function liveStuck(value: number, at: number, flagged: readonly FlaggedSlice[] | undefined, board: ChatBoard | null | undefined,
  activity: ReadonlyMap<string, number>): number {
  if (!board || Date.parse(board.updatedAt) <= at) return value;
  const open = new Map<string, { sessionId?: string }>();
  walk(board.plan, item => { if (OPEN.has(item.status)) open.set(item.id, item); });
  const items = new Set((flagged ?? []).filter(slice => slice.kind === "stuck_steps" && slice.item).map(slice => slice.item!));
  return [...items].filter(id => {
    const step = open.get(id);
    if (!step) return false;
    const wrote = step.sessionId ? activity.get(step.sessionId) : undefined;
    return wrote === undefined || wrote <= at;
  }).length;
}

const clock = (at: number): string => new Date(at).toISOString().slice(11, 16) + "Z";
const minutes = (ms: number): number => Math.round(ms / MINUTE);

export function measure(input: Inputs): PrecheckOutput {
  const { now } = input;
  // The 30 whole wall-clock minutes before `now`'s, each read by the watch line in it; the watch samples at each minute's middle (`nextSampleAt`).
  const start = Math.floor(now / MINUTE) * MINUTE - WINDOW_MS;
  const flagged: FlaggedSlice[] = [];
  const queueHolds: Hold[] = [
    ...input.log.holds,
    ...(input.cut ?? []).map(job => ({ what: `cut job ${job.name} (${job.session})`, from: job.at, to: now })),
  ].filter(hold => hold.to - hold.from > HOLD_MS && hold.to >= start);
  const cutHeld = (input.cut ?? []).filter(job => now - job.at > HOLD_MS);
  const heldAt = (at: number): boolean => queueHolds.some(hold => hold.from + HOLD_MS <= at && hold.to >= at - MINUTE);
  // Each box is judged on its own reading. A box with no reading that minute (a stale feed, a relay that did not answer, no line at all) is
  // unknown, never clean or dirty: a minute is dirty when a box read unusable or a hold or free-slot queue happened, else unknown when any box
  // went unread, else clean. From 04:22:55Z on 10-18 the box's lines carried usable: null, and the old loop counted each as dirty.
  let clean = 0, usable = 0, fed = 0, unwatched = 0, unknownMin = 0, held = 0, freeSlot = 0, harness = 0, other = 0;
  const isHarness = harnessSide(input.watch);
  const dirty: string[] = [];
  const unknownLines: string[] = [];
  const perHost = new Map<string, { usable: number; unusable: number; unknown: number }>();
  const hostCount = (name: string) => { const known = perHost.get(name) ?? { usable: 0, unusable: 0, unknown: 0 }; perHost.set(name, known); return known; };
  for (let minute = 0; minute < 30; minute++) {
    const from = start + minute * MINUTE, to = from + MINUTE;
    const line = input.watch.findLast(entry => { const at = Date.parse(entry.at); return at >= from && at < to; });
    const why: string[] = [];
    const unknown: string[] = [];
    let harnessMinute = false, unusableMinute = false;
    if (!line) { unwatched++; unknown.push("no watch line"); }
    else for (const view of hostViews(line)) {
      const count = hostCount(view.name);
      if (!view.usable) { count.unknown++; unknown.push(view.error ? `${view.name} unread (${view.error.slice(0, 80)})` : `${view.name} no reading`); continue; }
      const miss = unusable(view.usable);
      if (!miss.length) { count.usable++; continue; }
      count.unusable++;
      unusableMinute = true;
      why.push(`${view.name} unusable (${miss.join(", ")})`);
      if (isHarness(line, view)) harnessMinute = true;
    }
    if (line && !unknown.length) { fed++; if (!unusableMinute) usable++; }
    if (unusableMinute) { if (harnessMinute) harness++; else other++; }
    if (heldAt(to)) { held++; why.push("a start, wake or parked job held over 10 min"); }
    const waited = line && freeSlotWait(line);
    if (waited) {
      freeSlot++;
      why.push(`a turn of ${waited.tree} queued ${waited.oldestWaitS} s with free slots (${line.queue!.slots} of ${line.queue!.workingMax} in use, its tree at ${waited.slots} of ${line.queue!.treeWorkingMax})`);
    }
    if (why.length) dirty.push(`${clock(from)} ${why.join(", ")}`);
    else if (unknown.length) { unknownMin++; unknownLines.push(`${clock(from)} ${unknown.join(", ")}`); }
    else clean++;
  }
  // Each chat's newest measured check-in, only while it is under one check-in interval old, read after its job when that job has finished: the
  // check-in job gives an ended job's step a new owner or a close in the same run, so the run's own count is the board before that work. On 10-17
  // VP of CI's 19:36Z run measured 26 and its after-job measure at 20:09Z read 1, and its next run at 20:04Z (skipped behind that job) read 0.
  // On 10-18 d7 at 02:13Z counted frontend bro's p197, whose job had ended, though that chat's check-in job had set a live job on it. A count
  // older than the interval is left out: after no check-in ran from 00:05Z on 10-17, 20 h old counts read as current.
  // A chat whose check-in is paused is parked by the owner, so its steps are his to hold: at 00:09Z on 10-18 slack green guy's 22:11Z check-in,
  // under its 2 h interval, still put its 3 stuck steps in the count after the owner's focus pause stopped the chat at 23:03Z.
  const stuck = input.chats.filter(chat => !chat.paused).map(chat => {
    // A run skipped because the job before it still worked measured the board all the same, so it counts when it carries the metric: frontend
    // bro's 23:15:37Z run on 10-18 read 0 stuck steps, while d7 at 00:41Z still took 2 from its 23:13Z run. A skip with no metrics measured nothing.
    const run = chat.runs.find(entry => entry.duty === CHECK_IN_DUTY_ID && entry.verdict !== "error" && entry.metrics?.stuck_steps !== undefined);
    const after = run?.after?.metrics?.stuck_steps;
    const at = run === undefined ? undefined : after ? Math.max(run.at, run.after!.at) : run.at;
    const fresh = at !== undefined && (chat.everyMs === undefined || now - at <= chat.everyMs);
    const read = fresh ? (after ?? run!.metrics.stuck_steps)?.value ?? 0 : 0;
    return { chat, value: read > 0 ? liveStuck(read, at!, run!.flagged, input.boards?.get(chat.id), input.ownerActivity ?? new Map()) : 0, at };
  }).filter(entry => entry.value > 0);
  const redDuties = input.chats.flatMap(chat => chat.duties.flatMap(duty => {
    const own = chat.runs.filter(run => run.duty === duty.id);
    const newest = own.find(run => { const verdict = effectiveRun(run).verdict; return verdict === "met" || verdict === "missed"; });
    if (!newest || missStreak(own) < CHANGE_APPROACH_MISSES) return [];
    const live = Object.values(newest.fixes ?? {}).some(fix => fix.live);
    return live ? [] : [`${chat.name}: ${duty.name} missed ${missStreak(own)} runs in a row, with no live fix job on its last run`];
  }));
  // Every box's sleeping sessions count: each line's total over its boxes, averaged over the lines that measured any.
  const sleepingTotals = input.watch.filter(line => Date.parse(line.at) > start).flatMap(line => {
    const measured = hostViews(line).filter(view => view.sleeping);
    return measured.length ? [measured.reduce((sum, view) => sum + view.sleeping!.gb, 0)] : [];
  });
  const latest = input.watch.findLast(line => Date.parse(line.at) > start);
  const oversize = oversized(latest, input.day ?? []);
  const metrics: Record<string, number> = {
    clean_min_30: clean,
    queue_holds_30: queueHolds.length,
    stuck_steps_all: stuck.reduce((sum, entry) => sum + entry.value, 0),
    sleeping_gb: Math.round(100 * (sleepingTotals.reduce((sum, gb) => sum + gb, 0) / (sleepingTotals.length || 1))) / 100,
    oversized_procs: oversize.length,
    usable_min_30: usable,
    fed_min_30: fed,
    harness_unusable_min_30: harness,
    other_unusable_min_30: other,
    held_min_30: held,
    queued_free_slot_min_30: freeSlot,
    unwatched_min_30: unwatched,
    unknown_min_30: unknownMin,
    stuck_duties: redDuties.length,
    cut_jobs_held: cutHeld.length,
  };
  for (const [name, count] of perHost) {
    const key = name.replace(/[^A-Za-z0-9]+/g, "_");
    metrics[`usable_min_30_${key}`] = count.usable;
    metrics[`unusable_min_30_${key}`] = count.unusable;
    metrics[`unknown_min_30_${key}`] = count.unknown;
  }
  const byHost = [...perHost].map(([name, count]) => `${name} read usable in ${count.usable}, unusable in ${count.unusable} and unknown in ${count.unknown}`).join("; ");
  flagged.push({ kind: "minutes", excerpt: `${clean} of the last 30 minutes ran clean and ${unknownMin} are unknown. ${byHost || "No box was read"} ` +
    `(${harness} unusable minutes on the harness side, ${other} on the app or owner side, ${unwatched} with no watch line); a start, wake or parked job was held over ` +
    `10 min in ${held}; a turn sat queued while pi-pool had ${FREE_SLOTS} or more slots it could give it in ${freeSlot}.` });
  if (dirty.length) flagged.push({ kind: "dirty_minutes", excerpt: dirty.slice(-10).join("; ") });
  if (unknownLines.length) flagged.push({ kind: "unknown_minutes", excerpt: unknownLines.slice(-10).join("; ") });
  const asleep = latest ? hostViews(latest).filter(view => view.sleeping && view.sleeping.gb > 0) : [];
  if (latest && asleep.length) {
    flagged.push({ kind: "sleeping", excerpt: `Sessions idle past the idle window held ${metrics.sleeping_gb} GB on average over the last 30 minutes. At ${clock(Date.parse(latest.at))}: ` +
      asleep.map(view => `${view.name} ${view.sleeping!.gb} GB in ${view.sleeping!.workers} whole workers and ${view.sleeping!.kernels} kernels (${view.sleeping!.trees.map(entry => `${entry.tree} ${entry.gb} GB`).join(", ")})`).join("; ") + "." });
  }
  for (const line of oversize) flagged.push({ kind: "oversized", excerpt: line });
  for (const hold of queueHolds.sort((a, b) => a.from - b.from).slice(0, 12)) {
    flagged.push({ kind: "queue_hold", item: hold.what, excerpt: `${hold.what} waited ${minutes(hold.to - hold.from)} min${hold.from - (input.log.firstAt ?? -Infinity) < MINUTE ? " or more (held when the log read starts)" : ""}, ${clock(hold.from)} to ${clock(hold.to)}.` });
  }
  for (const entry of stuck) flagged.push({ kind: "stuck_steps", item: entry.chat.id, excerpt: `${entry.chat.name}: ${entry.value} open steps nobody moves, from its check-in at ${clock(entry.at!)}.` });
  for (const line of redDuties) flagged.push({ kind: "stuck_duty", excerpt: line });
  for (const job of cutHeld.sort((a, b) => a.at - b.at)) {
    const grants = (input.log.grants ?? []).filter(grant => grant.session === job.session && grant.at >= job.at);
    const admitted = grants.map(grant => {
      const watched = input.watch.findLast(entry => Date.parse(entry.at) <= grant.at)?.queue;
      const slots = watched?.workingMax === undefined ? "" : `, pi-pool then held ${watched.slots ?? watched.working} of ${watched.workingMax} slots with ${watched.queued} queued`;
      return `the fleet budget let its ${grant.kind} start at ${clock(grant.at)} after ${grant.waitS} s${slots}`;
    });
    flagged.push({ kind: "cut_job", chat: job.chat, item: job.session, excerpt: `${job.name} (${job.session}, chat ${job.chat}) was ${cutWords(job.cause)} at ` +
      `${clock(job.at)}${job.proof ? `, ${job.proof},` : ""} and got no input in ${minutes(now - job.at)} min: ${admitted.length ? `${admitted.join("; ")}, and nothing reached the session` : "no continue or wake was let through for it"}.` });
  }
  return { metrics, flagged };
}

/**
 * Every job under the live chats' session folders (`session-artifacts/<chat>/sub-*` at any depth) whose transcript changed within CUT_LOOKBACK_MS
 * and ends cut (`cutEnd`). A child the chat deleted (deleted-jobs.json) or its parent deleted with rlm.delete_subagent is left out.
 */
export async function findCutJobs(artifacts: string, chats: readonly string[], deleted: Readonly<Record<string, Readonly<Record<string, number>>>>, now: number,
  stops: DaemonStops = { restarts: [], sigterms: [] }): Promise<CutJob[]> {
  const candidates: { chat: string; chain: readonly Folder[]; path: string; end: Cut }[] = [];
  /** Per chat, each job name read in the look-back with the latest session that carries it, for `replacedBy`. */
  const latest = new Map<string, Map<string, string>>();
  const gone = new Set(Object.values(deleted).flatMap(chat => Object.keys(chat ?? {})));
  const parents = new Map<string, Promise<Buffer>>();
  const parentBytes = (file: string): Promise<Buffer> => {
    if (!parents.has(file)) parents.set(file, readFile(file).catch(() => Buffer.alloc(0)));
    return parents.get(file)!;
  };
  const metas = new Map<string, Promise<{ sessionName?: unknown; status?: unknown } | null>>();
  const metaOf = (folder: string) => {
    if (!metas.has(folder)) metas.set(folder, readJson(join(folder, "rlm-subagent.json")) as Promise<{ sessionName?: unknown; status?: unknown } | null>);
    return metas.get(folder)!;
  };
  /** Whether this folder's job was deleted on purpose: the RLM runtime marked it deleted, the chat service deleted or parked it, or its parent's delete_subagent named it. */
  const deletedOnPurpose = async (folder: Folder): Promise<boolean> =>
    gone.has(basename(folder.dir)) || (await metaOf(folder.dir))?.status === "deleted" || parentDeleted(await parentBytes(folder.parentFile), basename(folder.dir));
  const walk = async (chat: string, dir: string, parentFile: string, chain: readonly Folder[]): Promise<void> => {
    const entries = (await readdir(dir, { withFileTypes: true }).catch(() => [])).filter(item => item.isDirectory() && item.name.startsWith("sub-"));
    for (let index = 0; index < entries.length; index += WALK_AT_ONCE) {
      await Promise.all(entries.slice(index, index + WALK_AT_ONCE).map(async entry => {
        const child = join(dir, entry.name);
        const file = (await readdir(child).catch(() => [] as string[])).find(name => SESSION_ID.test(name.replace(/\.jsonl$/, "")) && name.endsWith(".jsonl"));
        if (!file) return;
        const path = join(child, file);
        const here = [...chain, { dir: child, parentFile, file }];
        await walk(chat, child, path, here);
        const changed = (await stat(path).catch(() => null))?.mtimeMs ?? 0;
        if (now - changed > CUT_LOOKBACK_MS) return;
        const name = (await metaOf(child))?.sessionName;
        const session = file.slice(0, -".jsonl".length);
        if (typeof name === "string") {
          const names = latest.get(chat) ?? new Map<string, string>();
          if ((names.get(name) ?? "") < session) names.set(name, session);
          latest.set(chat, names);
        }
        const end = await readCut(path);
        if (end && now - end.at <= CUT_LOOKBACK_MS) candidates.push({ chat, chain: here, path, end });
      }));
    }
  };
  for (const chat of chats) await walk(chat, join(artifacts, chat), join(artifacts, "..", "sessions", `${chat}.jsonl`), []);
  const found: CutJob[] = [];
  for (const { chat, chain, end } of candidates) {
    // An explicit delete of the job or any job above it wins over any restart or SIGTERM timing: such a delete archives and aborts too.
    if ((await Promise.all(chain.map(deletedOnPurpose))).some(Boolean)) continue;
    const proof = end.archivedAt === undefined ? undefined : interruptionProof(end, stops);
    if (end.archivedAt !== undefined && proof === undefined) continue;
    const jobOf = async (folder: Folder) => {
      const name = (await metaOf(folder.dir))?.sessionName;
      return { session: folder.file.slice(0, -".jsonl".length), name: typeof name === "string" ? name : basename(folder.dir) };
    };
    const job = await jobOf(chain.at(-1)!);
    const later = latest.get(chat)?.get(job.name);
    found.push({ ...job, chat, at: end.at, cause: end.cause, root: await jobOf(chain[0]!), ...(proof ? { proof } : {}),
      ...(later !== undefined && later > job.session ? { replacedBy: later } : {}) });
  }
  return found;
}

/** A job folder on the walk: its folder, the transcript of the job above it and its own transcript's file name. */
interface Folder { dir: string; parentFile: string; file: string }

/**
 * Whether a parent transcript holds an rlm.delete_subagent call whose result names `child` (`rlm_child_id='sub-...'`), as resume_paused.py's
 * parent_deleted reads it: the result line is a toolResult, and the call line before it calls delete_subagent. A plain substring of the id
 * missed fair-self-heal (sub-6430b61d) on 10-16.
 */
export function parentDeleted(text: Buffer, child: string): boolean {
  const named = `rlm_child_id='${child}'`;
  for (let at = text.indexOf(named); at >= 0; at = text.indexOf(named, at + named.length)) {
    const start = text.lastIndexOf(10, at) + 1;
    const result = text.indexOf('"toolResult"', start);
    const call = text.lastIndexOf('"toolCall"', start);
    if (result < 0 || result > at || call < 0) continue;
    const deleteAt = text.indexOf("delete_subagent", text.lastIndexOf(10, call) + 1);
    if (deleteAt >= 0 && deleteAt < start) return true;
  }
  return false;
}

/**
 * The cut jobs that hold owner work: an open step of the job's chat names the job or the chat's own job above it, by session id or job name.
 * A cut job no open step names waits for nobody, and a cut job of a chat whose check-in is paused is parked by the owner. At 06:27Z on 10-16 the duty counted 40 cut jobs as holds, and 37 of them sat under no open
 * step: their steps were done, or a later job had taken the work (metal-inventory, cut 10-15 08:34Z, under metal dev environment and its r2).
 */
export function cutJobsHoldingWork(cut: readonly CutJob[], boards: ReadonlyMap<string, ChatBoard | null>, paused: ReadonlySet<string> = new Set()): CutJob[] {
  const steps = new Map<string, { job?: string; sessionId?: string }[]>();
  for (const [chat, board] of boards) {
    const open: { job?: string; sessionId?: string }[] = [];
    walk(board?.plan ?? [], item => { if (OPEN.has(item.status)) open.push({ ...(item.job ? { job: item.job } : {}), ...(item.sessionId ? { sessionId: item.sessionId } : {}) }); });
    steps.set(chat, open);
  }
  return cut.filter(job => {
    // A chat whose check-in the owner paused is parked: the owner's focus pause at 23:03Z on 10-17 stopped watchlist last fixes in launch main
    // bro, and the duty counted it as a start held from 23:15Z on, 25 of the 30 minutes at 23:39Z.
    if (paused.has(job.chat)) return false;
    const open = steps.get(job.chat);
    if (!open) return true;
    // A later session took the work: a newer job of the same name (ci train 01a13a70 and its replacement 01a14068 on 10-16), or a step that names
    // the job and points at a later session.
    if (job.replacedBy !== undefined) return false;
    return [job, job.root ?? job].some(one => open.some(step => step.sessionId === one.session ||
      (step.job === one.name && (step.sessionId === undefined || step.sessionId <= one.session))));
  });
}

/** The daemon's stops from every daemon.sock.*.log and its rotated copies under `logs`. */
async function daemonStops(logs: string): Promise<DaemonStops> {
  const names = (await readdir(logs).catch(() => [] as string[])).filter(name => name.startsWith("daemon.sock.") && name.includes(".log")).sort();
  const all = await Promise.all(names.map(async name => readDaemonStops((await readFile(join(logs, name), "utf8").catch(() => "")).split("\n"))));
  return { restarts: all.flatMap(stops => stops.restarts), sigterms: all.flatMap(stops => stops.sigterms) };
}

/** When each session that owns an open step last wrote its transcript: a root's under sessions, a job's under its chat's session-artifacts. */
async function ownerActivity(agentDir: string, boards: ReadonlyMap<string, ChatBoard | null>): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const mtime = async (file: string) => (await stat(file).catch(() => null))?.mtimeMs;
  for (const [chat, board] of boards) {
    const owners = new Set<string>();
    walk(board?.plan ?? [], item => { if (OPEN.has(item.status) && item.sessionId) owners.add(item.sessionId); });
    if (owners.size === 0) continue;
    const subs = (await readdir(join(agentDir, "session-artifacts", chat)).catch(() => [] as string[])).filter(name => name.startsWith("sub-"));
    for (const session of owners) {
      const times = await Promise.all([join(agentDir, "sessions", `${session}.jsonl`), ...subs.map(sub => join(agentDir, "session-artifacts", chat, sub, `${session}.jsonl`))].map(mtime));
      const newest = Math.max(...times.filter((time): time is number => time !== undefined));
      if (Number.isFinite(newest)) out.set(session, newest);
    }
  }
  return out;
}

const readJson = async (file: string): Promise<unknown> => JSON.parse(await readFile(file, "utf8").catch(() => "null")) as unknown;

async function main(): Promise<void> {
  const output = process.env.OUTPUT_FILE;
  if (!output) { process.stderr.write("whole-system: OUTPUT_FILE is not set\n"); process.exit(2); }
  const now = Date.now();
  const dataDir = chatDataDir();
  const day = await readWatch(dataDir, now - DAY_MS, now);
  const watch = day.filter(line => Date.parse(line.at) >= now - 2 * WINDOW_MS);
  const names = new Map<string, string>();
  for (const line of watch) for (const tree of [...line.top, ...line.trees ?? []]) if (tree.root && tree.tree) names.set(tree.root, tree.tree);
  // Only the owner's chats (`ownerChats`): an archived or clean-room test chat stays out of his counts and the job's messages.
  const ids = await ownerChats(dataDir);
  const store = new DutyStore(dataDir);
  const settings = checkInSettings(join(dataDir, "check-in-settings.json"));
  const chats: Inputs["chats"][number][] = [];
  const pausedChats = new Set<string>();
  for (const id of ids) {
    const file = await store.read(id);
    const paused = activePause(await settings.get(id), now) !== null;
    if (paused) pausedChats.add(id);
    chats.push({ id, name: names.get(id) ?? id.slice(0, 8), runs: await store.runs(id), everyMs: (await settings.get(id)).everyMs, paused,
      duties: [...paused ? [] : [{ id: CHECK_IN_DUTY_ID, name: "Check-in" }], ...file.duties.filter(duty => duty.status === "active").map(duty => ({ id: duty.id, name: duty.name }))] });
  }
  const live = ids;
  const cut = await findCutJobs(join(dataDir, "..", "session-artifacts"), live,
    (await readJson(join(dataDir, "deleted-jobs.json")) ?? {}) as Record<string, Record<string, number>>, now, await daemonStops(join(dataDir, "..", "logs")));
  const boardStore = new BoardStore(dataDir);
  const boards = new Map(await Promise.all(live.map(async id => [id, await boardStore.read(id).catch(() => null)] as const)));
  const result = measure({
    now, watch, day,
    log: readServiceLog(await tailLines(join(dataDir, "service.log"), LOG_TAIL_BYTES)),
    chats,
    cut: cutJobsHoldingWork(cut, boards, pausedChats),
    boards,
    ownerActivity: await ownerActivity(join(dataDir, ".."), boards),
  });
  await writeFile(output, JSON.stringify(result, null, 2) + "\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
