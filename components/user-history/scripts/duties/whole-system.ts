import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { readdirSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { pathToFileURL } from "node:url";
import { DutyStore } from "../../src/chat-duty-store.ts";
import { ownerChats } from "../../src/owner-chats.ts";
import { type CutSpan, cutWords, readCut, readCutSpans, tailLines, type CutCause } from "../../src/cut-end.ts";
import { activePause, checkInSettings } from "../../src/checkin-settings.ts";
import { BoardStore } from "../../src/chat-board-store.ts";
import { liveWindowMs, OPEN, parkedBy, POOL_WAIT, walk } from "../../src/checkin-steps.ts";
import { waitHolds } from "../../src/checkin-end-state.ts";
import { turnError } from "../../src/shared/credential-wait.ts";
import type { ChatBoard, MemoryGroupId, PlanItem } from "../../src/shared/types.ts";
import { type AgentLine, type HostUsable, isLinuxReading, parseLinuxReading, readWatch, type TestBrowserLine, UNREAD_AT_STOP, unusable, type WaitingTree, type WatchLine, type WorkerLine, type WorkerTree } from "../../src/mac-usable-watch.ts";
import { QUIET_MINUTES, QUIET_TARGET_GB, quietMinutes } from "../../src/quiet-minutes.ts";
import type { HungCall } from "../../src/hung-calls.ts";
import type { StoppedCall } from "../../src/hung-stop.ts";
import { chatDataDir } from "../../src/owner-ok.ts";
import { beatStale, type CacheBeat, pendingWakes, readBeat, treeWakes } from "../../src/wakes.ts";
import { processEvidence } from "../../src/proc-evidence.ts";
import { harnessSlow, slowChatRead, workerMisses } from "../../src/harness-slow.ts";
import { chatNamer, type DaemonFault, faultWords, type ListedSession, listedSessions, type QueueOverrun, readQueueOverruns, readReopenedSends, readServiceFaults, readSupervisorFaults, SLOW_MS } from "../../src/daemon-faults.ts";
import { readRecords } from "../../src/orphan-services.ts";
import { readUpdateSpans, type UpdateSpan } from "../../src/prime-update.ts";
import { deliveryCandidates, outboxLandings, readSessionMarks, type SlotWaitTimeout, splitSlotWaits } from "../../src/slot-wait-timeouts.ts";
import { CHECK_IN_DUTY_ID, type DutyRunRecord, type FlaggedSlice, type PrecheckOutput } from "../../src/shared/chat-duties.ts";
import { effectiveRun, metricStreaks, missStreak, newestReading } from "../../src/shared/duty-streak.ts";
import { missedKeys, parseDutyLink } from "../../src/shared/duty-fixes.ts";
import { dutyHold, heldByTodo, withLinkedBoards } from "../../src/shared/todo-hold.ts";
import type { HostHold } from "../../src/shared/host-hold.ts";
import { readsTheShare } from "./duty-fleet.ts";

/** One box's numbers in a watch line: the box that wrote the line, then each other box it read through that box's relay (HostWatchLine). */
export interface HostView { name: string; usable: HostUsable | null; workers: number; workerGb: number; top: readonly WorkerLine[]; serviceGb?: number; agents?: AgentLine; error?: string;
  /** Tailscale read the box offline that minute (HostWatchLine.offline). */
  offline?: true;
  /** The Playwright or Puppeteer browsers agents ran on the box that minute; only the Mac's helper lists them (HostWatchLine.testBrowsers). */
  testBrowsers?: readonly TestBrowserLine[];
  /** Every worker of the box that minute (WatchLine.byWorker); absent on lines written before 10-20. */
  byWorker?: readonly WorkerTree[] }
/** Lines written before 10-18 04:5xZ name no box, and the Mac wrote every one of them. */
export const UNNAMED_HOST = "mac";

/** A Linux reading a line kept from before host-stats.ts read the CPU set, or a malformed one, is no reading (`parseLinuxReading`). */
export const OLD_LINUX_READING = "an old-format or invalid Linux reading";
const checked = (usable: HostUsable | null | undefined): { usable: HostUsable | null; error?: string } =>
  !usable || !isLinuxReading(usable) || parseLinuxReading(usable) ? { usable: usable ?? null } : { usable: null, error: OLD_LINUX_READING };

/**
 * Whether `box` read usable in the watch line just before [from, to) and in the one just after, each within a minute of it. A chat service that
 * stops while a relay read is out writes that box as unread (UNREAD_AT_STOP), which says the harness restarted, not that the box was in doubt:
 * at 14:12:29Z on 10-19 a release's stop wrote the Mac unread, the Mac read usable at 14:11:30Z and 14:13:30Z, and d7 counted 14:12Z unknown.
 * A stop next to a minute Tailscale read the box offline counts offline instead (`offlineAround`): at 20:46:25Z on 10-23 a release's stop
 * wrote the Mac unread, Tailscale read it offline 20:22Z to 20:45Z and 20:47Z to 20:51Z, and d7 counted 20:46Z unknown, 29 of 30 clean.
 */
export function usableAround(watch: readonly WatchLine[], box: string, from: number, to: number): boolean {
  const reads = (line: WatchLine | undefined): boolean => {
    const view = line && hostViews(line).find(candidate => candidate.name === box);
    return !!view?.usable && !unusable(view.usable).length;
  };
  return reads(watch.findLast(line => { const at = Date.parse(line.at); return at < from && at >= from - MINUTE; }))
    && reads(watch.find(line => { const at = Date.parse(line.at); return at >= to && at < to + MINUTE; }));
}

/**
 * A relay read that failed on the network, with no answer from the box at all. A relay that answered, even with a 500, says the box was up.
 */
export const UNREACHED = /^(?:fetch failed|The operation was aborted due to timeout)/;

/**
 * Whether Tailscale read `box` offline in the watch line just before [from, to) or in the one just after, each within a minute of it. A box
 * the relay could not reach (UNREACHED) next to such a minute was falling asleep, waking or flapping, so that minute is offline too. On 10-23
 * Tailscale read the Mac offline 13:53Z to 13:55Z and 13:57Z to 14:22Z, its relay read "fetch failed" at 13:56Z, and d7 counted the minute
 * unknown; at 14:29Z, between offline stretches, the same read came with 2 handshake timeouts to the Mac and d7 counted the minute dirty. Of the
 * Mac's 233 unreached reads from 10-01 to 10-23, 8 sat next to an offline read, 5 of them between two.
 */
export function offlineAround(watch: readonly WatchLine[], box: string, from: number, to: number): boolean {
  const offline = (line: WatchLine | undefined): boolean => !!line && !!hostViews(line).find(candidate => candidate.name === box)?.offline;
  return offline(watch.findLast(line => { const at = Date.parse(line.at); return at < from && at >= from - MINUTE; }))
    || offline(watch.find(line => { const at = Date.parse(line.at); return at >= to && at < to + MINUTE; }));
}

/** The boxes of a watch line, the writer first. Since 04:20Z on 10-18 the chat runs on us-metal02 and reads the Mac through its relay. */
export function hostViews(line: WatchLine): HostView[] {
  const own = checked(line.usable);
  return [
    { name: line.host ?? UNNAMED_HOST, usable: own.usable, workers: line.workers, workerGb: line.workerGb, top: line.top,
      ...line.serviceGb === undefined ? {} : { serviceGb: line.serviceGb }, ...line.agents ? { agents: line.agents } : {}, ...own.error ? { error: own.error } : {},
      ...line.testBrowsers ? { testBrowsers: line.testBrowsers } : {}, ...line.byWorker ? { byWorker: line.byWorker } : {} },
    ...(line.hosts ?? []).map(host => {
      const read = checked(host.usable);
      const error = host.error ?? read.error;
      return { name: host.name, usable: read.usable, workers: host.workers, workerGb: host.workerGb, top: host.top,
        ...host.agents ? { agents: host.agents } : {}, ...error ? { error } : {}, ...host.offline ? { offline: true as const } : {}, ...host.testBrowsers ? { testBrowsers: host.testBrowsers } : {},
        ...host.byWorker ? { byWorker: host.byWorker } : {} };
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
  // The harness's share holds the agent services too, which the feed groups apart from Agent sessions since 10-21.
  shares.set("agents", Math.max((shares.get("agents") ?? 0) + (shares.get("services") ?? 0), view.workerGb + (view.serviceGb ?? 0)));
  shares.delete("services");
  return shares;
}

const leads = (shares: ReadonlyMap<MemoryGroupId, number>): boolean => {
  const agents = shares.get("agents") ?? 0;
  return agents > 0 && [...shares].every(([id, gb]) => id === "agents" || gb < agents);
};

/**
 * Whose minute an unusable reading of `view` is. On the Mac it is the harness's when agent sessions hold the largest footprint of the box, or
 * the largest growth since `previous` (the same box in the line before) when that line is at most 2 minutes older. On a Linux box it is the
 * harness's when a CPU miss came with the harness's cgroups using the most cores (host-stats.ts `cpuSides`). A reading with nothing to
 * compare is unknown, never the apps': a Mac line with no groups, a Linux line from before cpuCores, or a Linux memory-only miss. d7 at 06:21Z
 * on 10-18 put all 11 CPU minutes on us-metal02 on the app and owner side, since Linux readings never carry the Mac's memory groups. A Linux
 * memory stall (`MEMORY_STALL_PCT`) goes to the group that held the most memory (AgentLine `largest`), whoever used the most cores.
 */
export function minuteSide(view: HostView, previous?: { view: HostView; gapMs: number }): MinuteSide {
  const usable = view.usable;
  if (usable && isLinuxReading(usable)) {
    const largest = view.agents?.largest;
    if (memoryStalled(usable) && largest) return largest === "agents" || largest === "services" ? "harness" : "other";
    if (!usable.cpuCores || !unusable(usable).includes("cpu")) return "unknown";
    const { harness, ...rest } = usable.cpuCores;
    return harness > 0 && Object.values(rest).every(cores => cores <= harness) ? "harness" : "other";
  }
  if (!feedGroups(usable)) return "unknown";
  const now = memoryShares(view);
  if (leads(now)) return "harness";
  if (!previous || !feedGroups(previous.view.usable) || previous.gapMs > 2 * MINUTE) return "other";
  const before = memoryShares(previous.view);
  const growth = new Map([...now].map(([id, gb]) => [id, gb - (before.get(id) ?? 0)] as const));
  return (growth.get("agents") ?? 0) > 0 && leads(growth) ? "harness" : "other";
}
export type MinuteSide = "harness" | "other" | "unknown";

/**
 * A Linux CPU miss's harness cores in the flag's words: its own work and the rigs jobs started (rig-cpu.ts), with the 3 owners whose rigs used
 * the most, each by its chat and job. Empty for any other miss or a reading without the split. Asked on 10-18 after us-metal02's 10 unusable
 * minutes from 11:23Z to 11:32Z, when scratch chat services, test rigs and iso builds of jobs held most of the harness's cores.
 */
export function rigWords(view: HostView, name: (fault: DaemonFault) => string | undefined): string {
  const usable = view.usable;
  if (!usable || !isLinuxReading(usable) || !usable.harnessSplit || !unusable(usable).includes("cpu")) return "";
  const { own, rigs, top } = usable.harnessSplit;
  const owners = top.slice(0, 3).map(line => {
    const [root = "", job] = line.owner.split("/", 2);
    const chat = /^[0-9a-f]{8}$/.test(root) ? name({ at: 0, host: view.name, session: root, what: "rig" }) ?? `chat ${root}` : root;
    return `${job ? `${chat}, job ${job}` : chat} ${line.cores} (${line.command})`;
  });
  return `; harness ${Math.round(100 * (own + rigs)) / 100} cores, ${own} its own and ${rigs} in job rigs${owners.length ? `: ${owners.join(", ")}` : ""}`;
}

/**
 * Memory full stall (avg10) from which a Linux minute reads as a memory stall. On 10-26 us-metal02 read 0.5 to 3.7% in every minute from 02:14Z
 * to 02:40Z but five, and 13.5 to 41.4% in those five, 02:22Z to 02:26Z, when CI and RepoOps' job processes grew to 231 GB, swap read 80 of
 * 80 GB, swap-outs ran 20,208 to 60,614 a second and the chat's event loop stalled 1.6 to 6.4 s. d7 read them as CPU minutes, since the
 * box's CPU miss is all a Linux reading names under LINUX_USABLE's 70%, and booked two of them to the apps by cores.
 */
export const MEMORY_STALL_PCT = 10;
const memoryStalled = (usable: HostUsable): boolean => isLinuxReading(usable) && usable.memFullAvg10 >= MEMORY_STALL_PCT;

/** A Linux memory stall in the flag's words: the stall, the swap-outs, the group that held the most and the worker tree whose work held the most. */
export function memoryWords(view: HostView): string {
  const usable = view.usable;
  if (!usable || !isLinuxReading(usable) || !memoryStalled(usable)) return "";
  const most = view.top.reduce<WorkerLine | null>((top, worker) => (worker.workGb ?? 0) > (top?.workGb ?? 0) ? worker : top, null);
  return `; memory full ${usable.memFullAvg10}% of the last 10 s with ${usable.swapoutsPerS} swap-outs a second` +
    (view.agents?.largest ? `, the ${view.agents.largest} group held the most memory` : "") + (most?.workGb ? `, the job processes of ${most.tree} ${most.workGb} GB` : "");
}

/** Whether a reading's harness cores went mostly to job rigs (rig-cpu.ts). */
export const rigsLead = (view: HostView): boolean => {
  const usable = view.usable;
  return !!usable && isLinuxReading(usable) && !!usable.harnessSplit && usable.harnessSplit.rigs > usable.harnessSplit.own;
};

/** `minuteSide` for each box of a line of `lines`, judged against the same box in the line before it there. */
export function sideOf(lines: readonly WatchLine[]): (line: WatchLine, view: HostView) => MinuteSide {
  const previous = new Map(lines.map((line, at) => [line, lines[at - 1]] as const));
  return (line, view) => {
    const before = previous.get(line);
    const same = before && hostViews(before).find(candidate => candidate.name === view.name);
    return minuteSide(view, same ? { view: same, gapMs: Date.parse(line.at) - Date.parse(before.at) } : undefined);
  };
}

/**
 * The Whole system duty's precheck (`node --import tsx scripts/duties/whole-system.ts`), run every 30 minutes on the owner's 10-15 ask
 * ("reorganize duties have a 30 minute trigger that checks all this", mva1wt2h). It reads files the chat service and pi-pool already write and
 * makes no daemon call: the usable watch, whose lines carry each box's pi-pool limits and queue, service.log, and every chat's duty
 * runs. One supporting metric is how many of the last 30 minutes ran clean (clean_min_30): a minute is clean when the watch read every box that Tailscale read online usable (a CPU miss counts
 * only when the harness itself was slow in it, src/harness-slow.ts, and is a busy_minutes detail line otherwise), no start, wake or parked
 * job had waited over HOLD_MS, and no turn sat queued while pi-pool had a slot it was allowed to give it (`freeSlotWait`), and no open, status read, send or worker start
 * failed or ran over 30 s on any box (src/daemon-faults.ts), leaving out a timed-out send or status read whose session waited for a pi-pool
 * slot and went through, which is a slot_wait_timeout detail line (src/slot-wait-timeouts.ts), and a call inside a Prime update restart its
 * box's coordinator recorded, which is a prime_update detail line (src/prime-update.ts `updateSpan`). The other two are queue holds and open steps nobody
 * moves in all chats. The headline is what Settings > Hosts reads for Agent sessions once no session has worked for the quiet window
 * (`quietAgents`, owner c92 and his words of 10-19: "when everybody's asleep it should drop ram"). The rest is detail, with each
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
/**
 * When a cut job starts to wait on nobody: at its cut, or at the slot pi-pool gave its provider error, since until then it waits in pi-pool's
 * queue, the ordinary queueing this duty leaves out, and a continue meets the same refusal (`Cut.slotAt`).
 */
export const heldFrom = (job: Pick<CutJob, "at" | "slotAt">): number => Math.max(job.at, job.slotAt ?? job.at);
/** The sessions of the cut jobs the chat's interrupted pass left because pi-pool held their tree (src/chat-resume.ts), from service.log's lines. */
export function poolHeldCuts(lines: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const line of lines) {
    const found = /^job .+: held by pi-pool until .*, ([0-9a-f]{8}-[0-9a-f-]{27})(?: on \S+)?\)$/.exec(line);
    if (found) out.add(found[1]!);
  }
  return out;
}
/** About 3 h of service.log at 10-16's rate (1.7 MB an hour, most of it held wakes), so a hold that began before the window is seen whole. */
const LOG_TAIL_BYTES = 6_000_000;

export interface Hold { what: string; from: number; to: number }
/** A continue or wake the fleet budget let through for a session (`starts after N s`): proof the start was admitted. */
export interface Grant { kind: string; session: string; at: number; waitS: number }
export interface LogFacts { holds: Hold[]; grants?: Grant[]; firstAt?: number }
/**
 * A job session whose turn was cut (`cutEnd`), found in a live chat's tree: either it got no input since, or `resumedAt` is when its next input
 * came. A resumed cut still held its minutes up to that input.
 */
export interface CutJob { session: string; name: string; chat: string; at: number; cause: CutCause; resumedAt?: number; root?: { session: string; name: string }; proof?: string;
  /** The slot pi-pool gave its provider error (`Cut.slotAt`): until then it waits in pi-pool's queue, which is not a hold (`heldFrom`). */
  slotAt?: number;
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
const WAKE_HELD = /^wakes: wake ([\w-]+) for .*; tried again next tick$/;
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
 * A tree pi-pool refused while `room` named accounts that took its class, from the first such refusal to its next account or `now`. `cell` is
 * true when every such refusal waited for a cell (R5 wait, `backoff: false`): since pi-pool 42884712 `room` names only accounts the rules let
 * the tree enter but for a cell, so the tree waited its turn at R4's pace behind trees of its priority or higher, and no slot was free.
 */
export interface PoolHold { session: string; from: number; to: number; room: readonly string[]; cell: boolean }
/**
 * pi-pool.log on us-metal02 grew 24.2 MB from 00:00Z to 19:20Z on 10-21, about 1.25 MB an hour, so this tail holds about 6.4 h, past the window
 * and a wait for a 5h window's reset.
 */
const POOL_LOG_TAIL_BYTES = 8_000_000;
const POOL_LOG = join(process.env.PI_POOL_DIR || join(homedir(), ".config", "pi-pool"), "pi-pool.log");

/**
 * The pool's refusals that held a tree while the pool had accounts for it, from pi-pool.log's `parked` lines (one per refused request, with
 * `room`, the accounts that take the tree's class on their last read) and `unparked` lines (its first account after a wait). A hold opens at the
 * first refusal with room and ends at the tree's next account, at a refusal with no room, or at `now`. On 10-18 01a14eaf was refused at
 * 15:55Z on a backoff draw for 16:45Z and got no account until 16:38Z, while claude12, krenerd77 and claude3 took its class, and queue_holds_30 and
 * queued_free_slot_min_30 both read 0.
 */
export function readPoolLog(lines: readonly string[], now: number): PoolHold[] {
  const open = new Map<string, PoolHold>();
  const holds: PoolHold[] = [];
  for (const line of lines) {
    if (!line.includes('"parked"') && !line.includes('"unparked"')) continue;
    let entry: { event?: unknown; session?: unknown; at?: unknown; slot_at?: unknown; room?: unknown; backoff?: unknown };
    try { entry = JSON.parse(line) as typeof entry; } catch { continue; }
    if (typeof entry.session !== "string" || typeof entry.at !== "number") continue;
    const at = entry.at * 1000;
    const hold = open.get(entry.session);
    const room = entry.event === "parked" && Array.isArray(entry.room) ? entry.room.filter((name): name is string => typeof name === "string") : [];
    // A refusal holds the tree until the slot it names; a tree that asks no more after its slot passed is no longer held by the pool. At 17:24Z
    // on 10-18 four trees given a cell under 2 min ahead asked no more, and the first reader held them open up to the run.
    const until = typeof entry.slot_at === "number" ? Math.max(at, entry.slot_at * 1000) : at;
    // pi-pool dropped the random backoff draw on 10-21 and writes no backoff field since; a line without one waited for a cell.
    const cell = entry.backoff !== true;
    if (room.length) {
      if (hold) { hold.to = Math.max(hold.to, until); hold.cell &&= cell; continue; }
      const fresh = { session: entry.session, from: at, to: until, room, cell };
      open.set(entry.session, fresh);
      holds.push(fresh);
    } else if (hold) {
      hold.to = Math.min(hold.to, at);
      open.delete(entry.session);
    }
  }
  for (const hold of holds) hold.to = Math.min(hold.to, now);
  return holds;
}

/** The owner's t86 answer on 10-21: "just make it work smooth". Chat head runs and parked trees, from pi-pool.log, for d7's two smoothness numbers. */
export interface Smoothness {
  /**
   * Each chat head run pi-pool admitted in the window, with its queue wait, and whether a job run started from the queue while it waited: the
   * queue's order at fault, since chat heads go first (pi-pool lead). A head that waited with no such start waited for the box's slot count.
   */
  headWaits: { session: string; waitedS: number; passed: boolean }[];
  /** Per park that ended in the window: minutes it stayed parked after a tree of its priority or lower that parked later got an account. */
  overtaken: { session: string; minutes: number }[];
}
const RANK: Readonly<Record<string, number>> = { high: 0, normal: 1, low: 2 };
const KST_MS = 9 * 60 * MINUTE;

/**
 * pi-pool stamps `ts` in its writer's local time, and on 10-21 about 45,000 of the lines since 10-19 were KST. `at` on parked and unparked lines is
 * epoch seconds, so each other line takes whichever of its `ts` read as UTC or as KST lies nearer the last `at` before it.
 */
export function readSmoothness(lines: readonly string[], heads: ReadonlySet<string>, from: number, to: number): Smoothness {
  const headWaits: Smoothness["headWaits"] = [];
  // Each head run in line, from its turn_queued line on, and whether a job run started from the queue since. pi-pool logs each turn.lock
  // holder's lines right after it lets go, so the log's order is the queue's: on 10-22 at 15:16:00Z a job run took the slot 01a11a24's ending
  // run let go, and the head's next run queued the same second after it, which the old second-stamped reading counted as a pass.
  const inLine = new Map<string, boolean>();
  // A park's rank is its tree's priority at each refusal, since a chat moves its jobs between low and normal: 01a1642b, low from
  // 20:04Z on 10-22, read as passed for 427 min by 01a164b6, a normal tree that entered claude19 at 20:13Z, because its last refusal said normal.
  const parks = new Map<string, { start: number; ranks: { at: number; rank: number }[]; manual: boolean; served?: boolean }>();
  const ended: { session: string; start: number; end: number; ranks: { at: number; rank: number }[]; led: boolean; served: boolean }[] = [];
  // Whether each session's latest wait line named an account the hook vends meanwhile (`vend`, sched.Wait): such a tree's requests go out on
  // its own account while it waits for a better one, so it is served, and only a 429 on it (a `limited` line) leaves it unserved. At 00:59:37Z
  // on 10-24 the ops guy chat 01a11af8 parked for claude-virev7 at 01:00Z with vend claude20 (left budget_overrun), its head's turn ran on
  // claude20 and ended at 00:59:57Z, and its tree asked again only at 01:12:26Z, when a job run of it left the turn queue after 1,114 s with
  // 12 of 12 slots busy; d7 read it as passed for 12.5 min.
  const vends = new Map<string, boolean>();
  // Whether each session's latest turn was a chat head's or an owner's, which pi-pool's turn queue starts before every job run. Such a tree
  // asks for its account first by design, so it passes no parked job tree: at 13:52Z on 10-23 all 12 parks read as passed for 22 to 29 min
  // had been passed by 01a1301d and 01a11af8, chat heads, or 01a168dd, an owner turn, while the job trees sat behind 97 runs whose turn
  // places dated from 09:18Z to 11:05Z.
  const led = new Map<string, boolean>();
  let anchor: number | undefined;
  for (const line of lines) {
    if (!line.includes('"turn_admitted"') && !line.includes('"turn_queued"') && !line.includes('"turn_dropped"') && !line.includes('"parked"') &&
      !line.includes('"unparked"') && !line.includes('"vend"') && !line.includes('"wait"') && !line.includes('"limited"')) continue;
    let entry: { ts?: unknown; event?: unknown; session?: unknown; at?: unknown; waited_s?: unknown; priority?: unknown; provider?: unknown; reason?: unknown; manual?: unknown;
      vend?: unknown };
    try { entry = JSON.parse(line) as typeof entry; } catch { continue; }
    if (typeof entry.session !== "string") continue;
    const head = heads.has(entry.session);
    if (entry.event === "turn_queued") {
      if (head) inLine.set(entry.session, false);
      continue;
    }
    if (entry.event === "turn_dropped") {
      inLine.delete(entry.session);
      continue;
    }
    if (entry.event === "turn_admitted") {
      const kind = (entry as { kind?: unknown }).kind;
      led.set(entry.session, head || kind === "owner" || kind === "ahead");
      const local = typeof entry.ts === "string" ? Date.parse(`${entry.ts}Z`) : NaN;
      const at = anchor === undefined || Math.abs(local - anchor) <= Math.abs(local - KST_MS - anchor) ? local : local - KST_MS;
      // Only a run the queue started counts as passing a head: an owner run or a run its owner turn moved ahead never waits in line.
      if (!head && (entry as { kind?: unknown }).kind === "slot") for (const session of inLine.keys()) inLine.set(session, true);
      if (head) {
        const passed = inLine.get(entry.session) ?? false;
        inLine.delete(entry.session);
        if (typeof entry.waited_s === "number" && at >= from && at < to) headWaits.push({ session: entry.session, waitedS: entry.waited_s, passed });
      }
      continue;
    }
    // pi-pool logs the vend right after the unparked line of the same request: a Manual pin's vend takes its tree out of Auto's order, so its park
    // neither passes nor is passed. From 05:43Z to 07:40Z on 10-22, 24 of 69 parks read as passed had been passed by trees pinned to sieunpark77.
    if (entry.event === "vend") {
      const last = ended.at(-1);
      if (last?.session === entry.session && (entry.reason === "session_pin" || entry.reason === "pool_pin")) ended.pop();
      // A vend with no unparked line before it means pi-pool had dropped the tree's wait (PLACE_KEEP_SEC after its slot), so the park was over.
      // 01a15ede parked at 01:50Z on 10-22, asked nothing until 15:41Z, entered claude19 at 16:28Z with no unparked line, and read as passed
      // for 1,060 min when its next park ended at 17:52Z.
      parks.delete(entry.session);
      continue;
    }
    if ((entry.event === "wait" || entry.event === "limited") && entry.provider === "anthropic") {
      const served = entry.event === "wait" && typeof entry.vend === "string";
      vends.set(entry.session, served);
      const park = parks.get(entry.session);
      if (park) park.served = served && park.served !== false;
      continue;
    }
    if (typeof entry.at !== "number" || entry.provider !== "anthropic") continue;
    const at = entry.at * 1000;
    anchor = at;
    // A pinned tree back on its own account writes no vend line, so pi-pool marks its parked and unparked lines `manual` since 10-22: 01a11ba8,
    // pinned to claude8, waited from 15:19Z for its 16:30Z reset and read as passed for 70 min by Auto trees that entered claude19.
    const manual = entry.manual === true;
    if (entry.event === "parked") {
      const park = parks.get(entry.session) ?? { start: at, ranks: [], manual };
      park.ranks.push({ at, rank: RANK[String(entry.priority)] ?? 1 });
      park.manual ||= manual;
      parks.set(entry.session, park);
    } else if (entry.event === "unparked") {
      const park = parks.get(entry.session);
      parks.delete(entry.session);
      if (park && !park.manual && !manual) {
        ended.push({ session: entry.session, start: park.start, end: at, ranks: park.ranks, led: led.get(entry.session) ?? false,
          served: park.served ?? vends.get(entry.session) ?? false });
      }
    }
  }
  const rankAt = (park: (typeof ended)[number], at: number) => (park.ranks.findLast(step => step.at <= at) ?? park.ranks[0])?.rank ?? 1;
  const overtaken = ended.filter(park => park.end >= from && park.end < to).map(park => {
    if (park.served) return { session: park.session, minutes: 0 };
    const passed = ended.find(other => !other.led && other.end < park.end && other.end > park.start && other.start > park.start &&
      rankAt(other, other.end) >= rankAt(park, other.end));
    return { session: park.session, minutes: passed ? Math.round((park.end - passed.end) / MINUTE * 10) / 10 : 0 };
  });
  return { headWaits, overtaken };
}

/**
 * A chat head run that waits longer than this in pi-pool's turn queue counts in queue_holds_30. With heads first, a replay of the 10-20 and 10-21
 * runs gave chat head runs a p90 wait of 4 to 9 s, against 139 s and 426 s in arrival order (~/work/pool-smooth/BASELINE.md).
 */
export const HEAD_WAIT_S = 30;

const p90 = (values: readonly number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.9) - 1)]! : 0;
};

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

/**
 * A worker's own footprint for each session it hosts: the worker tree less what its sessions' work holds (`workGb`, src/mac-usable-watch.ts
 * `workBytes`), so a waste check reads Prime's memory and not a job's. Prime runs a chat and every job it spawns in one worker, so a whole
 * worker grows with the chat's fan-out. At 06:21Z on 10-18 worker 1811158 held 7.79 GB for VP of CI's 28 sessions, 20 of them jobs at work
 * whose kernels held 7.2 GB of CI history and pandas frames, and the day's whole-worker median flagged every busy chat (Crawler VP in 74 of
 * 112 lines). At 07:30Z both flagged workers held work: 1.19 GB of 852974's 1.7 GB was a release's svelte-check, and 3.6 GB of Mac worker
 * 4111's 3.91 GB was a job's kernel at work. A line written before `workGb` counts the whole tree.
 */
const perSession = (line: WorkerLine): number => (line.gb - (line.workGb ?? 0)) / Math.max(line.sessions, 1);

/**
 * The harness processes in the newest watch line over FAR_ABOVE times their kind's median in `day` on the same box: Prime workers by their
 * own footprint per hosted session (`perSession`), and the chat service.
 */
/** A harness process far above its kind's normal size: the box it runs on, a Prime worker's pid (null for the chat service) and the finding. */
export interface Oversized { host: string; pid: number | null; text: string }

export function oversized(latest: WatchLine | undefined, day: readonly WatchLine[]): Oversized[] {
  if (!latest) return [];
  const found: Oversized[] = [];
  const dayViews = day.flatMap(hostViews);
  for (const view of hostViews(latest)) {
    const own = dayViews.filter(candidate => candidate.name === view.name);
    const session = median(own.flatMap(candidate => candidate.top.filter(line => line.sessions > 0).map(perSession)));
    if (session !== undefined) for (const line of view.top) if (perSession(line) > FAR_ABOVE * session) found.push({ host: view.name, pid: line.pid, text: `${view.name}: Prime worker ${line.pid} (${line.tree || "no tree"}) holds ${line.gb} GB for ${line.sessions} sessions${line.workGb ? `, ${line.workGb} GB of it their work` : ""}, ${perSession(line).toFixed(2)} GB each of its own, over ${FAR_ABOVE}x the day's median there of ${session.toFixed(2)} GB per session` });
    const service = median(own.flatMap(candidate => candidate.serviceGb === undefined ? [] : [candidate.serviceGb]));
    if (service !== undefined && view.serviceGb !== undefined && view.serviceGb > FAR_ABOVE * service) found.push({ host: view.name, pid: null, text: `${view.name}: the chat service holds ${view.serviceGb} GB, over ${FAR_ABOVE}x its day's median of ${service.toFixed(2)} GB` });
  }
  return found;
}

/** An agent's Playwright or Puppeteer browser on the Mac: the chat tree and session that started it ("" when unknown) and the finding. */
export interface TestBrowser { root: string; session: string; text: string }

/**
 * Every Chrome for Testing or chrome-headless-shell main process in the newest watch line, which only the Mac's helper lists, since agent
 * browsers run on us-metal02 (skills/aside-browser/SKILL.md, c103). At 16:35Z on 10-19 a 'teams green add-on' job's rig ran one on the Mac
 * and frontend bro had to ask whose it was.
 */
export function testBrowsers(latest: WatchLine | undefined): TestBrowser[] {
  if (!latest) return [];
  return hostViews(latest).flatMap(view => (view.testBrowsers ?? []).map(browser => ({ root: browser.root, session: browser.session,
    text: `${view.name}: ${browser.command.includes("chrome-headless-shell") ? "chrome-headless-shell" : "Chrome for Testing"} pid ${browser.pid}` +
      `${browser.started === null ? "" : ` since ${clock(browser.started * 1000)}`}, started by ${browser.session ? `${browser.tree || browser.root} session ${browser.session}` : "no agent session its env names (a duty or an ssh command)"}; ` +
      `agent browsers run on us-metal02 (aside-browser box Chrome, or apps/virev-demo/scripts/shot-browser.mjs for 5180)` })));
}

/**
 * A box's Agent sessions in one watch minute that sat past the quiet window: no session of the box had worked (src/agent-states.ts, a retry or
 * pool wait is no work) in any line for `quietMs`, so the box should have dropped its agents' memory by then. `since` is the first line of
 * that quiet stretch, at or after the last turn's end.
 */
export interface QuietMinute { host: string; at: number; since: number; agents: AgentLine & { gb: number } }

/** A gap between a box's lines past this breaks its quiet stretch, since a turn may have run unseen in it. */
const QUIET_GAP_MS = 2 * MINUTE;

/**
 * Every minute in [`from`, `to`) where a box had sat quiet for `quietMs`, read from each box's `agents` (absent on lines before 10-19). A
 * stretch starts at the first line after one with a session at work, after a line with no `agents` or no `gb`, or after a gap over
 * QUIET_GAP_MS; lines from before `from` count toward it, so the caller reads back at least `quietMs` further.
 */
export function quietAgents(lines: readonly WatchLine[], from: number, to: number, quietMs: number): QuietMinute[] {
  const since = new Map<string, number | null>();
  const last = new Map<string, number>();
  const found: QuietMinute[] = [];
  for (const line of lines) {
    const at = Date.parse(line.at);
    if (!(at < to)) continue;
    for (const view of hostViews(line)) {
      const agents = view.agents;
      const before = last.get(view.name);
      last.set(view.name, at);
      if (!agents || agents.gb === null || agents.working > 0) { since.set(view.name, null); continue; }
      const start = before !== undefined && at - before <= QUIET_GAP_MS ? since.get(view.name) ?? at : at;
      since.set(view.name, start);
      if (at >= from && at - start >= quietMs) found.push({ host: view.name, at, since: start, agents: { ...agents, gb: agents.gb } });
    }
  }
  return found;
}

/** A worker in one watch minute whose sessions had not worked for the quiet window: its pid, lead chat tree, GB and the first line of that stretch. */
export interface QuietTree { pid: number; root: string; tree: string; gb: number; since: number }
/**
 * One box's quiet memory in one watch minute: `gb` sums the workers in `trees`, or is the whole box's Agent sessions when no session of the box
 * had worked for the quiet window (`whole`, from `quietAgents`).
 */
export interface QuietReading { host: string; at: number; gb: number; trees: QuietTree[]; whole?: QuietMinute }

/**
 * Every box minute in [`from`, `to`) with the workers (WatchLine.byWorker) none of whose sessions had worked in any line for `quietMs`. Prime
 * runs a chat and all its jobs in one worker, so a worker is a tree, and a quiet tree should have dropped its memory by then while the rest of
 * the box works. A worker's stretch starts at its first line with no session working, and breaks on a line where one works, on a line with no
 * `byWorker`, and on a gap over QUIET_GAP_MS; lines from before `from` count toward it. A box minute with `byWorker` gives a reading even with no
 * quiet tree (0 GB), so d7 reads one every run while autonomous jobs work day and night. At 17:52Z on 10-19 us-metal02 ran 119 sessions working
 * over 71 workers and had not gone 15 min with none since 14:29Z.
 */
export function quietTrees(lines: readonly WatchLine[], from: number, to: number, quietMs: number): QuietReading[] {
  const stretches = new Map<string, Map<number, number>>();
  const last = new Map<string, number>();
  const found: QuietReading[] = [];
  for (const line of lines) {
    const at = Date.parse(line.at);
    if (!(at < to)) continue;
    for (const view of hostViews(line)) {
      const before = last.get(view.name);
      last.set(view.name, at);
      if (!view.byWorker) { stretches.delete(view.name); continue; }
      const held = before !== undefined && at - before <= QUIET_GAP_MS ? stretches.get(view.name) ?? new Map<number, number>() : new Map<number, number>();
      const next = new Map<number, number>();
      for (const worker of view.byWorker) if (worker.working === 0) next.set(worker.pid, held.get(worker.pid) ?? at);
      stretches.set(view.name, next);
      if (at < from) continue;
      const trees = view.byWorker.flatMap(worker => {
        const since = next.get(worker.pid);
        return since !== undefined && at - since >= quietMs ? [{ pid: worker.pid, root: worker.root, tree: worker.tree, gb: worker.gb, since }] : [];
      }).sort((a, b) => b.gb - a.gb);
      found.push({ host: view.name, at, gb: Math.round(100 * trees.reduce((sum, tree) => sum + tree.gb, 0)) / 100, trees });
    }
  }
  return found;
}

/**
 * Each box minute's quiet reading: the whole box's Agent sessions where the box sat quiet (`quietAgents`), else the GB of its quiet trees
 * (`quietTrees`).
 */
export function quietReadings(lines: readonly WatchLine[], from: number, to: number, quietMs: number): QuietReading[] {
  const whole = new Map(quietAgents(lines, from, to, quietMs).map(minute => [`${minute.host} ${minute.at}`, minute] as const));
  const readings = quietTrees(lines, from, to, quietMs).map(reading => {
    const box = whole.get(`${reading.host} ${reading.at}`);
    whole.delete(`${reading.host} ${reading.at}`);
    return box ? { ...reading, gb: box.agents.gb, whole: box } : reading;
  });
  for (const box of whole.values()) readings.push({ host: box.host, at: box.at, gb: box.agents.gb, trees: [], whole: box });
  return readings.sort((a, b) => a.at - b.at);
}

/**
 * The hung tool calls (src/hung-calls.ts) in the newest watch line of the window that judges them, or undefined when no line in the window was
 * written by a watch that judges calls (lines before 10-19 12Z carry neither `calls` nor `hung`, and agents.hung).
 */
export function hungNow(lines: readonly WatchLine[], from: number): { at: number; calls: HungCall[] } | undefined {
  const line = lines.findLast(entry => Date.parse(entry.at) >= from && entry.agents?.hung !== undefined);
  return line ? { at: Date.parse(line.at), calls: line.hung ?? [] } : undefined;
}

/** The hung calls the watch stopped (src/hung-stop.ts) in the lines from `from` on, oldest first, each with its line's time. */
export function stoppedSince(lines: readonly WatchLine[], from: number): { at: number; call: StoppedCall }[] {
  return lines.filter(line => Date.parse(line.at) >= from).flatMap(line => (line.stopped ?? []).map(call => ({ at: Date.parse(line.at), call })));
}

export interface Inputs {
  now: number;
  /** The quiet window (src/quiet-minutes.ts) in ms; absent, QUIET_MINUTES. */
  quietMs?: number;
  watch: readonly WatchLine[];
  /** The last day of watch lines, for each harness process's normal size (`oversized`); absent, no process is judged. */
  day?: readonly WatchLine[];
  log: LogFacts;
  /** Trees pi-pool refused while an account took their class (`readPoolLog`). */
  pool?: readonly PoolHold[];
  /** Chat head queue waits and parks overtaken by later trees in the window (`readSmoothness`); absent, neither number is written. */
  smooth?: Smoothness;
  /** Every chat's duty runs, newest first, with its active duty ids (the check-in included unless paused), and whether its check-in is paused. */
  chats: readonly { id: string; name: string; duties: readonly { id: string; name: string; metrics?: readonly { key: string }[] }[]; runs: readonly DutyRunRecord[]; everyMs?: number; paused?: boolean }[];
  /** Jobs in live chats whose last turn was cut and that got no input since (`cutEnd`). */
  cut?: readonly CutJob[];
  /** The cut jobs whose continue pi-pool held until its tree's accounts served again (`poolHeldCuts`). */
  poolHeldJobs?: ReadonlySet<string>;
  /** Each chat's live board, for a check-in whose snapshot is older than the board's last write (`liveStuck`). */
  boards?: ReadonlyMap<string, ChatBoard | null>;
  /** When each session that owns an open step last wrote its transcript, ms. */
  ownerActivity?: ReadonlyMap<string, number>;
  /** Sessions that own an open step and sleep on a board.wake, they or a subagent below them (`treeWakes`): a live owner, as for check-ins (80cbdd1). */
  waking?: ReadonlySet<string>;
  /**
   * Sessions that own an open step and whose last turn ended waiting for a pi-pool slot (`endsOnPoolWait`): a live owner that goes on when its
   * slot comes, as the check-in reads one (`poolWait`).
   */
  poolWaiting?: ReadonlySet<string>;
  /** Per chat, each job name with the sessions of its jobs that are not deleted (`jobSessions`), for a step whose session id is an old copy's. */
  named?: ReadonlyMap<string, ReadonlyMap<string, readonly string[]>>;
  /** Opens, status reads, sends and worker starts that failed or ran over SLOW_MS, from service.log and the supervisor's log (src/daemon-faults.ts). */
  daemonFaults?: readonly DaemonFault[];
  /** The handoffs this box's records hold that have not reached `unloaded` (src/orphan-services.ts), with when each began. */
  openHandoffs?: readonly { session: string; state: string; at: number }[];
  /** Timed-out sends and status reads the session's file showed waiting for a pi-pool slot and going through, left out of daemonFaults. */
  slotWaits?: readonly SlotWaitTimeout[];
  /** When the supervisor's poll of a worker went unanswered on this box (src/harness-slow.ts `workerMisses`). */
  workerMisses?: readonly number[];
  /** Sends that met a target over the daemon's pending message limit and waited in the agent outbox: detail, never a dirty minute (owner c98). */
  queueOverruns?: readonly QueueOverrun[];
  /** The sessions those faults name as the boxes' catalog copies list them, to name each one's chat (`listedSessions`). */
  listed?: ReadonlyMap<string, ListedSession>;
  /** The CI cache poller's heartbeat on this box (`readBeat`); absent or null, no CI cache line. */
  ciCache?: CacheBeat | null;
  /** The Prime update restarts each box's coordinator recorded (src/prime-update.ts `readUpdateSpans`), by that box's name. */
  primeUpdates?: readonly (UpdateSpan & { host: string })[];
}

/**
 * The stuck steps of a check-in snapshot still stuck on the live board. A snapshot taken before the board's last write is out of date: at 04:48Z
 * on 10-18 d7 counted chat-057a's steps from its 04:32Z check-in, taken before the chat moved to us-metal02, while its board had moved on to rev
 * 217 with every open step owned by a live box job. A flagged step counts only while it is still open on the live board and its owner session
 * has not written since the snapshot; a step the chat closed, removed, or gave to a job that is working drops out. An up-to-date snapshot counts as read.
 */
export function liveStuck(value: number, at: number, flagged: readonly FlaggedSlice[] | undefined, board: ChatBoard | null | undefined,
  activity: ReadonlyMap<string, number>, waking: ReadonlySet<string> = new Set()): number {
  return !board || Date.parse(board.updatedAt) <= at ? value : liveStuckIds(at, flagged, board, activity, waking).length;
}

/**
 * The ids of the steps a check-in snapshot flagged stuck that `liveStuck` still counts: all of them while the snapshot is up to date, unless
 * `always` asks for the open and owner checks on an up-to-date one too, as a step held on a box that is back needs (`planCounts`).
 */
export function liveStuckIds(at: number, flagged: readonly FlaggedSlice[] | undefined, board: ChatBoard | null | undefined,
  activity: ReadonlyMap<string, number>, waking: ReadonlySet<string> = new Set(), always = false): string[] {
  const items = [...new Set((flagged ?? []).filter(slice => slice.kind === "stuck_steps" && slice.item).map(slice => slice.item!))];
  if (!board || (!always && Date.parse(board.updatedAt) <= at)) return items;
  const open = new Map<string, { sessionId?: string }>();
  walk(board.plan, item => { if (OPEN.has(item.status)) open.set(item.id, item); });
  return items.filter(id => {
    const step = open.get(id);
    if (!step) return false;
    if (step.sessionId && waking.has(step.sessionId)) return false;
    const wrote = step.sessionId ? activity.get(step.sessionId) : undefined;
    return wrote === undefined || wrote <= at;
  });
}

/**
 * Whether a red duty has a live fix now: an open step on the chat's live board linked to one of the newest run's missed metrics
 * (`<dutyId>/<metric>`), whose owner sleeps on a board.wake or wrote its transcript after that run was measured, as `liveStuck` reads a step owner.
 * A run's `fixes[].live` is frozen when it ran: at 07:25Z on 10-18 d7 flagged launch main bro's d1 and d3 from 05:21Z runs while deep walks 99
 * (p125), hand run lanes autoscale (p145) and undesigned hand writes cause (p146) slept on CI run wakes, and Crawler VP's d1 from its 07:13Z
 * run while census canary run (p364) slept on one. A step's owner is its session and every live job of the chat that carries its job's name
 * (`stepSessions`). With no board read, the run's own record is all there is.
 */
export function liveFix(run: DutyRunRecord, dutyId: string, board: ChatBoard | null | undefined, activity: ReadonlyMap<string, number>,
  waking: ReadonlySet<string>, named: ReadonlyMap<string, readonly string[]> = new Map()): boolean {
  if (!board) return Object.values(run.fixes ?? {}).some(fix => fix.live);
  const missed = new Set(missedKeys(effectiveRun(run)));
  const measuredAt = run.after?.at ?? run.at;
  let live = false;
  walk(board.plan, item => {
    const link = item.duty ? parseDutyLink(item.duty) : null;
    if (live || !link || link.duty !== dutyId || (missed.size > 0 && !missed.has(link.metric)) || !OPEN.has(item.status)) return;
    live = stepSessions(item, named).some(session => waking.has(session) || (activity.get(session) ?? 0) > measuredAt);
  });
  return live;
}

/**
 * The sessions that own a step: its session id, and each session of a job of the chat, not deleted, that carries the step's job name (`named`).
 * At 07:40Z on 10-18 Crawler VP's p510 and p700 kept the session of the stopped "crawler ops train before move" while "crawler ops train",
 * its continuation after the host move, slept on 9 CI run wakes. A job field that holds a session id names that session: at 06:05Z on 10-25
 * SEO guy's p101 had job set to the thread "sep launch!!" (01a15427-145f) with no sessionId, so d9 read it as running on the chat's own
 * us-metal02 and counted it stuck, though that thread sat on the offline Mac that For you t30 asked the owner to bring back.
 */
export function stepSessions(item: { sessionId?: string; job?: string }, named: ReadonlyMap<string, readonly string[]>): string[] {
  const job = item.job ? named.get(item.job) ?? (SESSION_ID.test(item.job) ? [item.job] : []) : [];
  return [...new Set([...item.sessionId ? [item.sessionId] : [], ...job])];
}

const clock = (at: number): string => new Date(at).toISOString().slice(11, 16) + "Z";
/** A box's AgentLine in the flag's words: its GB as Settings > Hosts shows them, then its sessions by state. */
const agentWords = (agents: AgentLine): string => `${agents.gb === null ? "an unread number of" : agents.gb} GB` +
  (agents.swapGb ? ` (${agents.swapGb} GB of it in swap)` : "") + (agents.cacheGb !== undefined ? ` with ${agents.cacheGb} GB of file cache beside it` : "") +
  (agents.servicesGb !== undefined ? ` and ${agents.servicesGb} GB in Agent services (the chat service, relay, pi-pool and Prime supervisor), counted apart` : "") +
  `, with ${agents.working} sessions working, ${agents.retry} waiting on the provider or the pool, ${agents.children} on their subagents` +
  (agents.hung ? `, ${agents.idle} idle and ${agents.hung} in a hung tool call` : ` and ${agents.idle} idle`);
/**
 * A box minute's quiet trees in the flag's words: their GB, the 5 largest by tree, pid, GB and the time their stretch began, and the workers
 * still at work beside them.
 */
function quietTreeWords(reading: QuietReading, quietWords: number): string {
  const named = reading.trees.slice(0, 5).map(tree => `${tree.tree || tree.root.slice(0, 8) || "no live session"} (pid ${tree.pid}, ${tree.gb} GB, quiet since ${clock(tree.since)})`);
  const rest = reading.trees.length - named.length;
  return `${reading.host}'s ${reading.trees.length} ${reading.trees.length === 1 ? "tree" : "trees"} with no session working for ${quietWords} min or more held ${reading.gb} GB ` +
    `at ${clock(reading.at)}${named.length ? `: ${named.join(", ")}${rest > 0 ? ` and ${rest} more` : ""}` : ""}. The rest of the box had a session at work, so its whole ` +
    `Agent sessions reading is no quiet number. The target is under ${QUIET_TARGET_GB} GB for what quiet trees hold.`;
}
const minutes = (ms: number): number => Math.round(ms / MINUTE);
/** What `planCounts` reads: the chats with their duty runs, their live boards and the owners of their open steps. */
export type PlanInputs = Pick<Inputs, "now" | "chats" | "boards" | "ownerActivity" | "waking" | "poolWaiting" | "named"> & {
  /** The boxes of hosts.json that Tailscale reads offline now (`awayHosts`); absent: every box reads online, so a held step counts by its job again. */
  away?: ReadonlySet<string>;
  /** The box each session and chat runs on, by the catalog copy that lists it (`copyHosts`); absent: every one runs on this box. */
  hosts?: ReadonlyMap<string, string>;
  /** Each offline box with the open For you todo that asks the owner to bring it back (`hostHolds`); absent: no box is held. */
  holds?: ReadonlyMap<string, HostHold>;
};
/**
 * An open step a check-in held on an offline box (`host_held`), or a red duty of a chat that runs there: its chat, step or duty id, the box and
 * the For you todo that asks the owner to bring it back.
 */
export interface HostHeldStep { chat: PlanInputs["chats"][number]; id: string; host: string; todo: string;
  /** The held step this one's wait names (`waitHolds`); absent: its own job runs on the box. */
  waitsOn?: string;
  /** The red duty's name when the held item is a duty of a chat on the box; absent: a plan step. */
  duty?: string }
/** A red duty whose missed windowed counts give no `lastEventAt` (`unreadWindows`): d9 reads them as lagging and asks the chat to add the field. */
export interface LaggingDuty { chat: string; duty: string; keys: string[]; line: string }
/** One chat's open steps that nobody moves (`liveStuck`), with the ids of those its check-in flagged. */
export interface StuckSteps { chat: PlanInputs["chats"][number]; value: number; at: number | undefined; items: string[] }

/**
 * A metric that counts events over a trailing window, like false_reds_24h or repeat_corrections_7d; a share, a ratio or a volume over a window
 * is no count. Nor is a count of things in a state now for longer than an age (`_over_24h`, `_overdue_1d`, `_waiting_24h`): Crawler VP's
 * prod_alerts_over_24h counts alert kinds firing now for over 24 h, which drop out when they stop firing, and on 10-22 d9 asked the chat to add
 * a lastEventAt it cannot have.
 */
export const WINDOW_COUNT = /^(?!.*(?:_pct|_ratio|_p\d\d|_[kmgt]b|_over|_overdue|_waiting)_\d+[mhd]$).*_\d+[mhd]$/;

/**
 * The missed windowed counts of a duty's newest reading whose precheck gives no `lastEventAt`: the runner cannot tell whether a new event
 * raised them or old events only wait to leave the window. On 10-20 CI and RepoOps' d5 held false_reds_24h at 4 for 8 runs from ci02 reds of
 * 10-19 17:05Z, after their fix went live at 03:28Z, and 11 other red windowed counts in 6 chats gave no lastEventAt either.
 */
export function unreadWindows(missed: readonly string[], metrics: DutyRunRecord["metrics"]): string[] {
  // Only a count capped from above waits for old events to leave: a count that must reach a floor, like report_days_7d, misses on too few.
  return missed.filter(key => WINDOW_COUNT.test(key) && metrics[key]?.op !== ">=" && metrics[key]?.lastEventAt === undefined);
}

/**
 * The missed metrics of a red duty that still owe a fix job, newest run first in `runs`. Three kinds owe none, as the duty runner reads them.
 * A count over a trailing window with no new event since the run before (`MetricStreak.quietSince`) only waits for old events to leave the
 * window, and the duty job's brief says to start no job for it (`missLine`): frontend bro's d1 restarts_24h read 3 from a 14:07Z stop on 10-19
 * and its d6 repeated_design_notes_24h 14 from a 17:33Z note, and d9 counted both as stuck from 03:29Z to 06:16Z on 10-20. A windowed count
 * with no `lastEventAt` reads as such a lagging window too (`unreadWindows`), and d9's push asks its chat to add the field. A check-in's
 * stuck_steps owes none once none of the steps it flagged is stuck on the live board (`liveStuck`, which stuck_steps_all reads): launch main
 * bro's and CI and RepoOps' check-ins counted at 03:29Z and 03:52Z while stuck_steps_all read 0.
 */
export function owedKeys(missed: readonly string[], runs: readonly DutyRunRecord[], stepsMoving: boolean): string[] {
  const quiet = new Set(metricStreaks(runs).filter(streak => streak.quietSince !== undefined).map(streak => streak.key));
  const newest = newestReading(runs);
  const unread = new Set(newest ? unreadWindows(missed, effectiveRun(newest).metrics) : []);
  return missed.filter(key => !quiet.has(key) && !unread.has(key) && !(stepsMoving && key === "stuck_steps"));
}

/**
 * The open steps nobody moves in each chat and the red duties with no live fix, which the Chat system duty (d9) counts as stuck_steps_all and
 * stuck_duties. They moved there from this duty (d7) on 10-19 (owner msg mvfb7zt0). A red duty whose owed metrics' fix steps all wait on an
 * open For you todo (`dutyHold`) waits on the owner and is no red duty here; `ownerHeld` lists each duty with such a metric and its todo.
 */
export function planCounts(input: PlanInputs): { stuck: StuckSteps[]; redDuties: { chat: string; duty: string; line: string }[]; lagging: LaggingDuty[]; hostHeld: HostHeldStep[];
  ownerHeld: { chat: string; duty: string; line: string }[] } {
  const hostHeld: HostHeldStep[] = [];
  // Each chat's newest measured check-in, only while it is under one check-in interval old, read after its job when that job has finished: the
  // check-in job gives an ended job's step a new owner or a close in the same run, so the run's own count is the board before that work. On 10-17
  // VP of CI's 19:36Z run measured 26 and its after-job measure at 20:09Z read 1, and its next run at 20:04Z (skipped behind that job) read 0.
  // On 10-18 d7 at 02:13Z counted frontend bro's p197, whose job had ended, though that chat's check-in job had set a live job on it. A count
  // older than the interval is left out: after no check-in ran from 00:05Z on 10-17, 20 h old counts read as current.
  // A fix step's owner asleep on a board.wake or waiting for its pi-pool slot is live: at 16:33Z on 10-18 d7 flagged Vent's check-in while
  // p8's job vent cutover train had ended its last turn on "pi-pool: this session waits for its slot at 2026-10-18T16:45".
  const live = new Set([...input.waking ?? [], ...input.poolWaiting ?? []]);
  const stuck = input.chats.map(chat => {
    // A chat whose check-in is paused runs no check-in to count from, so its board and step owners are read here (`unmovedSteps`). On 10-24 the
    // owner had paused the check-ins of SEO guy, frontend bro, ops guy and metal-management, and stuck_steps_all read 0 while ops guy's p506
    // named a job unloaded 23 h before with no wake.
    // A step whose owners all run on an offline box that a For you todo asks the owner to bring back waits on him (`pausedHold`), as a
    // check-in's host_held slice does: at 10:03Z on 10-24 frontend bro's p330 and p332 counted while their jobs sat on the Mac, off Tailscale.
    if (chat.paused) {
      // Its waits read the open todos of the other chats they name (`withLinkedBoards`), wherever those chats run: at 08:19Z on 10-25 SEO guy's
      // p101 waited on "01a15427-145f-751d-ba15-d27b6c30f65f t30", sep launch!!'s open ask to wake the Mac, and counted as stuck.
      const own = input.boards?.get(chat.id);
      const board = own ? withLinkedBoards(own, chat.id, input.boards!) : own;
      const items = unmovedSteps(board, input.now, chat.everyMs, input.ownerActivity ?? new Map(), live, input.named?.get(chat.id));
      const held = new Map<string, HostHold>();
      const unmoved: PlanItem[] = [];
      walk(board?.plan ?? [], item => {
        if (!items.includes(item.id)) return;
        unmoved.push(item);
        const hold = pausedHold(item, chat.id, input.named?.get(chat.id), input.hosts, input.holds);
        if (hold) held.set(item.id, hold);
      });
      // A step whose wait names such a held step waits on the same box and todo (`waitHolds`): at 11:25Z on 10-24 frontend bro's p333, whose job
      // ran on us-metal02, counted while it waited for p332 to push its commit from the offline Mac.
      const waits = waitHolds(unmoved, held);
      hostHeld.push(...[...held].map(([id, hold]) => ({ chat, id, host: hold.host, todo: hold.todo })),
        ...[...waits].map(([id, wait]) => ({ chat, id, host: wait.hold.host, todo: wait.hold.todo, waitsOn: wait.on })));
      for (const id of waits.keys()) held.set(id, waits.get(id)!.hold);
      const left = items.filter(id => !held.has(id));
      return { chat, value: left.length, at: input.now, items: left };
    }
    // A run skipped because the job before it still worked measured the board all the same, so it counts when it carries the metric: frontend
    // bro's 23:15:37Z run on 10-18 read 0 stuck steps, while d7 at 00:41Z still took 2 from its 23:13Z run. A skip with no metrics measured nothing.
    const run = chat.runs.find(entry => entry.duty === CHECK_IN_DUTY_ID && entry.verdict !== "error" && entry.metrics?.stuck_steps !== undefined);
    const after = run?.after?.metrics?.stuck_steps;
    // A check-in whose job still works (it has a job and no after-job measure yet) is the live owner of every step it flagged, so none is stuck
    // until that job ends and its after-job count says what it left: at 06:54Z on 10-18 d7 read 27, 26 of them ops guy's Grafana rule steps
    // that its 06:49Z check-in job was giving jobs, and that chat's after-job measure at 06:55Z read 0.
    const at = run === undefined ? undefined : after ? Math.max(run.at, run.after!.at) : run.at;
    const fresh = at !== undefined && (chat.everyMs === undefined || input.now - at <= chat.everyMs);
    const board = input.boards?.get(chat.id);
    // A step the check-in held on an offline box (`host_held`) waits on the owner while the box stays offline, and counts as stuck again once
    // the box reads online and its owner has not written since the snapshot, as `liveStuckIds` reads a stuck one.
    const onHost = fresh ? hostHeldSlices(run!.flagged, board) : [];
    const back = onHost.filter(slice => !input.away?.has(slice.host!)).map(slice => slice.item!);
    hostHeld.push(...onHost.filter(slice => input.away?.has(slice.host!)).map(slice => ({ chat, id: slice.item!, host: slice.host!, todo: slice.todo ?? "" })));
    if (run?.job && !run.after) return { chat, value: 0, at: run.at, items: [] as string[] };
    const read = fresh ? (after ?? run!.metrics.stuck_steps)?.value ?? 0 : 0;
    const value = read > 0 ? liveStuck(read, at!, run!.flagged, board, input.ownerActivity ?? new Map(), input.waking) : 0;
    const returned = back.length ? liveStuckIds(at!, back.map(item => ({ kind: "stuck_steps", excerpt: "", item })), board, input.ownerActivity ?? new Map(), input.waking, true) : [];
    return { chat, value: value + returned.length, at,
      items: [...value > 0 ? liveStuckIds(at!, run!.flagged, board, input.ownerActivity ?? new Map(), input.waking) : [], ...returned] };
  }).filter(entry => entry.value > 0);
  const lagging: LaggingDuty[] = [];
  const ownerHeld: { chat: string; duty: string; line: string }[] = [];
  const redDuties = input.chats.flatMap(chat => chat.duties.flatMap(duty => {
    // A duty that reads the fleet's share (d9) misses only as the other duties miss, and this count judges each of those on its own line, as
    // `readsTheShare` keeps it out of the share. Counted in, it needed a standing fix step on its own roll-up, which is a zombie step: d9 named
    // itself as a red duty with no live fix in 7 of its 63 detail files from 10-20 16:40Z to 10-23 19:40Z, the last two at 18:41Z and 19:40Z.
    if (duty.metrics && readsTheShare({ metrics: duty.metrics })) return [];
    const own = chat.runs.filter(run => run.duty === duty.id);
    // The duty is judged on its newest reading by the time it was taken (`newestReading`), as the duty runner's push and the fleet's green
    // share judge it, so a skipped run older than another run's after-job measure no longer reads a green duty as red.
    const newest = newestReading(own);
    // A red duty needs a live fix from its first miss (c75: every missed metric gets a live fix job each run). Until 10-20 a duty was left out
    // until 3 missed runs in a row, so at 02:30Z frontend bro d4, metal-management d2, CI and RepoOps d2 and Crawler VP d6 and d8
    // sat red with no fix step and no push. The duty's own run job still at work is left out by the precheck (`withoutWorkingRuns`).
    if (!newest || effectiveRun(newest).verdict !== "missed" || missStreak(own) < 1) return [];
    const unread = unreadWindows(missedKeys(effectiveRun(newest)), effectiveRun(newest).metrics);
    if (unread.length) lagging.push({ chat: chat.id, duty: duty.id, keys: unread, line: `${chat.name}: ${duty.name} misses ${unread.join(" and ")}, ` +
      `${unread.length === 1 ? "a count" : "counts"} over a trailing window with no lastEventAt, so d9 reads ${unread.length === 1 ? "it" : "them"} as a lagging window. ` +
      `Add lastEventAt, the time in ms of the newest event each count counts, to the duty's precheck output, so a count no new event raised reads quiet and a fresh one reads live` });
    const missed = missedKeys(effectiveRun(newest));
    const fresh = chat.everyMs === undefined || input.now - (newest.after?.at ?? newest.at) <= chat.everyMs;
    const owed = owedKeys(missed, own, duty.id === CHECK_IN_DUTY_ID && fresh && !stuck.some(entry => entry.chat.id === chat.id));
    if (missed.length && !owed.length) return [];
    // Each owed metric whose open fix step an open For you todo holds (`dutyHold`) waits on the owner and leaves the line: at 11:25Z on 10-24
    // d9 named d5/owner_fixes, whose p919 waited on t97, beside d5/skills_or_tools_to_fix, the one miss nobody owned.
    const board = input.boards?.get(chat.id);
    const linked = board ? withLinkedBoards(board, chat.id, input.boards!) : undefined;
    const holds = owed.map(key => ({ key, hold: dutyHold(duty.id, [key], linked) }));
    const waits = holds.filter(entry => entry.hold).map(entry => `${entry.key} waits on the owner (${entry.hold})`).join(", ");
    if (waits) ownerHeld.push({ chat: chat.id, duty: duty.id, line: `${chat.name}: ${duty.name} (${duty.id}) ${waits}, an open For you todo, so it owes no fix job` });
    const left = holds.filter(entry => !entry.hold).map(entry => entry.key);
    if (owed.length && !left.length) return [];
    if (liveFix(newest, duty.id, board, input.ownerActivity ?? new Map(), live, input.named?.get(chat.id))) return [];
    // A chat that runs on an offline box a For you todo asks the owner to bring back gets no duty job and no push until the box answers: from
    // 00:30Z on 10-26 slack green guy's d1 read red on the Mac's chat, every run's start read "the catalog does not list the chat", and d9
    // counted it as the one stuck duty. It waits on the owner as a step whose job runs there does (`host_held`).
    const box = input.hosts?.get(chat.id);
    const hold = box === undefined ? undefined : input.holds?.get(box);
    if (hold) { hostHeld.push({ chat, id: duty.id, host: hold.host, todo: hold.todo, duty: duty.name }); return []; }
    const links = left.map(key => `${duty.id}/${key}`);
    return [{ chat: chat.id, duty: duty.id, line: `${chat.name}: ${duty.name} read off target in ${missStreak(own) === 1 ? "its last run" : `its last ${missStreak(own)} runs`}, and no open step linked to it ` +
      `(duty field ${links.length ? links.join(" or ") : `${duty.id}/<metricKey>`}) has a live owner now${waits ? `, while ${waits}` : ""}` }];
  }));
  return { stuck, redDuties, lagging, hostHeld, ownerHeld };
}

/**
 * The open leaf steps of a board that nobody moves, read from the board and the step owners alone, for a chat with no check-in snapshot to
 * count from. A step is held when an open For you todo links it (its step field or `heldByTodo`) or an owner correction parks it (`parkedBy`),
 * and moving when one of its owners (`stepSessions`) sleeps on a board.wake, waits for its pi-pool slot (`live`) or wrote within the check-in's
 * live window (`liveWindowMs`), as `goalsWithNoJob` in chat-system.ts reads a goal's owner.
 */
export function unmovedSteps(board: ChatBoard | null | undefined, now: number, everyMs: number | undefined, activity: ReadonlyMap<string, number>,
  live: ReadonlySet<string>, named: ReadonlyMap<string, readonly string[]> = new Map()): string[] {
  const todos = board?.todos ?? [];
  const asked = new Set(todos.filter(todo => !todo.done && todo.step).map(todo => todo.step));
  const window = liveWindowMs(everyMs ?? Infinity);
  const out: string[] = [];
  walk(board?.plan ?? [], item => {
    if (!OPEN.has(item.status) || item.children.some(child => OPEN.has(child.status))) return;
    if (asked.has(item.id) || heldByTodo(item, todos) || parkedBy(item) !== undefined) return;
    if (stepSessions(item, named).some(session => live.has(session) || now - (activity.get(session) ?? -Infinity) <= window)) return;
    out.push(item.id);
  });
  return out;
}

/**
 * The hold on a paused chat's step whose owners (`stepSessions`) all run on a box in `holds`, or, with no owner, whose chat does. A session no
 * catalog copy lists runs on its chat's box: frontend bro's p332 named 01a164b0, which the Mac's copy no longer listed on 10-24.
 */
export function pausedHold(item: { sessionId?: string; job?: string }, chat: string, named: ReadonlyMap<string, readonly string[]> | undefined,
  hosts: ReadonlyMap<string, string> | undefined, holds: ReadonlyMap<string, HostHold> | undefined): HostHold | undefined {
  if (!hosts || !holds?.size) return undefined;
  const sessions = stepSessions(item, named ?? new Map());
  const boxes = (sessions.length ? sessions : [chat]).map(session => hosts.get(session) ?? hosts.get(chat));
  return boxes.every(box => box !== undefined && holds.has(box)) ? holds.get(boxes[0]!) : undefined;
}

/**
 * The box of each session and chat in the boxes' catalog copies (`catalogCopyFiles`), this box's copy first, so a session both list runs here.
 * `self` names this box.
 */
export function copyHosts(copies: readonly { host: string | null; rows: readonly { sessionId?: string }[] }[], self: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const copy of [...copies].sort((a, b) => Number(a.host !== null) - Number(b.host !== null))) {
    for (const row of copy.rows) if (row.sessionId && !out.has(row.sessionId)) out.set(row.sessionId, copy.host ?? self);
  }
  return out;
}

/**
 * Each other box's sessions whose files or job folders this box keeps copies of (`mirrorPath` in src/host-catalogs.ts), as a copy with that box's
 * name, for `copyHosts` to read after the catalog copies. The chat service prunes them after each full list, so only a box that listed the session
 * leaves one. At 08:25Z on 10-25 the Mac's catalog copy held 2 test fixture rows, so d9 placed none of frontend bro's, ops guy's and SEO guy's steps
 * on the offline Mac and read stuck_steps_all 5, while this box still kept the copy of frontend bro's chat file.
 */
export async function mirroredSessions(dir = join(homedir(), ".cache/sieun-pi/hosts")): Promise<{ host: string; rows: { sessionId: string }[] }[]> {
  const hosts = (await readdir(dir, { withFileTypes: true }).catch(() => [])).filter(entry => entry.isDirectory()).map(entry => entry.name);
  return Promise.all(hosts.map(async host => {
    const ids = new Set<string>();
    for (const path of await readdir(join(dir, host), { recursive: true }).catch(() => [] as string[])) {
      const name = basename(path).replace(/\.jsonl$/, "");
      if (SESSION_ID.test(name)) ids.add(name);
    }
    return { host, rows: [...ids].map(sessionId => ({ sessionId })) };
  }));
}

/** The `host_held` slices of a check-in snapshot whose step is still open on the live board, each once. */
export function hostHeldSlices(flagged: readonly FlaggedSlice[] | undefined, board: ChatBoard | null | undefined): FlaggedSlice[] {
  const open = new Set<string>();
  walk(board?.plan ?? [], item => { if (OPEN.has(item.status)) open.add(item.id); });
  const seen = new Set<string>();
  return (flagged ?? []).filter(slice => {
    if (slice.kind !== "host_held" || !slice.item || !slice.host || seen.has(slice.item) || (board && !open.has(slice.item))) return false;
    seen.add(slice.item);
    return true;
  });
}

/** Minute starts, oldest first, as runs of whole minutes: "15:40Z to 16:09Z, 16:12Z". */
const spans = (starts: readonly number[]): string => {
  const runs: [number, number][] = [];
  for (const at of starts) { const last = runs.at(-1); if (last && at - last[1] === MINUTE) last[1] = at; else runs.push([at, at]); }
  return runs.map(([from, to]) => from === to ? clock(from) : `${clock(from)} to ${clock(to)}`).join(", ");
};

/**
 * A hung worker's faults named by the tree this box's watch lines list for its pid, with how far it grew, since the supervisor's line names
 * only the worker id (src/daemon-faults.ts `readWorkerHangs`).
 */
export function nameHungWorkers(faults: readonly DaemonFault[], watch: readonly WatchLine[]): DaemonFault[] {
  return faults.map(fault => {
    if (fault.pid === undefined) return fault;
    const hungAt = Math.min(...faults.filter(other => other.pid === fault.pid).map(other => other.at));
    const seen = watch.flatMap(line => (line.byWorker ?? []).filter(worker => worker.pid === fault.pid).map(worker => ({ at: Date.parse(line.at), worker })));
    if (!seen.length) return fault;
    const before = seen.findLast(entry => entry.at <= hungAt)?.worker.gb, most = Math.max(...seen.map(entry => entry.worker.gb));
    const grew = before !== undefined && most > before ? `, after it grew from ${before} to ${most} GB` : "";
    return { ...fault, title: seen.at(-1)!.worker.tree, what: fault.what + grew };
  });
}

export function measure(input: Inputs): PrecheckOutput {
  const { now } = input;
  // A call that failed inside a supported Prime update restart on its box met the update's planned stop, not a harness fault: at 20:10:21Z on
  // 10-25 the crc.1 update's prepare made an open answer "Active session 680443071bdf is recovering; retry shortly", and two outbox sends the
  // new supervisor took 30 s to answer while it restored 42 sessions landed on their first try at 20:10:53Z. A crash or hang in it stays Prime's.
  const updates = input.primeUpdates ?? [];
  const updateOf = (fault: DaemonFault) => fault.prime ? undefined : updates.find(update => update.host === fault.host && fault.at >= update.from && fault.at <= update.to);
  const allFaults = nameHungWorkers(input.daemonFaults ?? [], input.watch);
  const daemonFaults = allFaults.filter(fault => !updateOf(fault));
  const updateFaults = allFaults.filter(fault => updateOf(fault));
  // The 30 whole wall-clock minutes before `now`'s, each read by the watch line in it; the watch samples at each minute's middle (`nextSampleAt`).
  const start = Math.floor(now / MINUTE) * MINUTE - WINDOW_MS;
  const flagged: FlaggedSlice[] = [];
  // A cut job whose continue pi-pool holds waits for its tree's accounts to serve again, the cell wait below: at 00:44Z on 10-20 dead-ts of CI
  // and RepoOps, cut on a provider error at 23:31Z with pi-pool holding its tree to 01:16Z, made all 30 minutes dirty while every box read usable.
  const poolCut = (input.cut ?? []).filter(job => input.poolHeldJobs?.has(job.session) && (job.resumedAt ?? now) - heldFrom(job) > HOLD_MS && (job.resumedAt ?? now) >= start);
  const cutWaiting = (input.cut ?? []).filter(job => !poolCut.includes(job));
  const queueHolds: Hold[] = [
    ...input.log.holds,
    ...cutWaiting.map(job => ({ what: `cut job ${job.name} (${job.session})`, from: heldFrom(job), to: job.resumedAt ?? now })),
  ].filter(hold => hold.to - hold.from > HOLD_MS && hold.to >= start);
  const poolHeld = (input.pool ?? []).filter(hold => hold.to - hold.from > HOLD_MS && hold.to >= start);
  // A hold that only waited for a cell is pi-pool's R4 pace at work with no slot free, like a turn its tree's cap holds (`freeSlotWait`): it
  // counts in cell_holds_30 and cell_wait_min_30, and leaves the minute clean. At 17:37Z on 10-18, after pi-pool 42884712, 26 minutes read
  // dirty from low trees whose every refusal waited for a krenerd77 or claude11 cell while higher trees took them. It stays out of
  // queue_holds_30: the owner answered t73 on 10-19 "wait for the limits to reset" for these waits on a short fleet, and at 14:52Z 10 holds
  // there were all cell waits (8 of them his duty fix subagents started at once on claude-virev4 and claude-virev5), with no slot free.
  const poolAt = (from: number, to: number, cell: boolean): PoolHold | undefined => poolHeld.find(hold => hold.cell === cell && hold.from + HOLD_MS < to && hold.to >= from);
  const cutHeld = cutWaiting.filter(job => job.resumedAt === undefined && now - heldFrom(job) > HOLD_MS);
  const heldAt = (at: number): boolean => queueHolds.some(hold => hold.from + HOLD_MS <= at && hold.to >= at - MINUTE);
  // Each box is judged on its own reading. A box with no reading that minute (a stale feed, a relay that did not answer, no line at all) is
  // unknown, never clean or dirty: a minute is dirty when a box read unusable or a hold or free-slot queue happened, else unknown when any box
  // went unread, else clean. From 04:22:55Z on 10-18 the box's lines carried usable: null, and the old loop counted each as dirty.
  // A box Tailscale read offline is offline that minute, neither unknown nor dirty, and the daemon calls that minute to it are left out, so a
  // minute is clean when every box that is online is clean. From about 14:00Z on 10-18 the MacBook Pro slept with its lid closed, and its
  // outbox handshake timeouts made every minute a daemon fault while us-metal02 read usable in all of them.
  const offlineMin = new Map<string, number[]>();
  let offlineAny = 0, offlineFaults = 0;
  const flappedMin: string[] = [];
  let clean = 0, usable = 0, fed = 0, unwatched = 0, unknownMin = 0, held = 0, freeSlot = 0, cellWait = 0, harness = 0, rigMin = 0, busyMin = 0, other = 0, unattributed = 0, daemonFail = 0, primeMin = 0;
  const faultName = chatNamer(input.chats, input.named, input.listed);
  const slotWaits = (input.slotWaits ?? []).filter(wait => wait.fault.at >= start && wait.fault.at < start + WINDOW_MS);
  const side = sideOf(input.watch);
  const dirty: string[] = [];
  const busy: string[] = [];
  const unknownLines: string[] = [];
  const perHost = new Map<string, { usable: number; unusable: number; unknown: number; offline: number }>();
  const hostCount = (name: string) => { const known = perHost.get(name) ?? { usable: 0, unusable: 0, unknown: 0, offline: 0 }; perHost.set(name, known); return known; };
  for (let minute = 0; minute < 30; minute++) {
    const from = start + minute * MINUTE, to = from + MINUTE;
    const line = input.watch.findLast(entry => { const at = Date.parse(entry.at); return at >= from && at < to; });
    const why: string[] = [];
    const unknown: string[] = [];
    const sides = new Set<MinuteSide>();
    let rigged = false;
    const offline = new Set<string>();
    if (!line) { unwatched++; unknown.push("no watch line"); }
    else for (const view of hostViews(line)) {
      const count = hostCount(view.name);
      const flapped = !view.offline && !view.usable && (UNREACHED.test(view.error ?? "") || view.error === UNREAD_AT_STOP) && offlineAround(input.watch, view.name, from, to);
      if (view.offline || flapped) {
        count.offline++; offline.add(view.name); offlineMin.set(view.name, [...offlineMin.get(view.name) ?? [], from]);
        if (flapped) flappedMin.push(`${clock(from)} ${view.name}`);
        continue;
      }
      if (!view.usable && view.error === UNREAD_AT_STOP && usableAround(input.watch, view.name, from, to)) { count.usable++; continue; }
      if (!view.usable) { count.unknown++; unknown.push(view.error ? `${view.name} unread (${view.error.slice(0, 80)})` : `${view.name} no reading`); continue; }
      const found = unusable(view.usable);
      const own = view.name === (line.host ?? UNNAMED_HOST);
      const slow = found.includes("cpu")
        ? harnessSlow({ box: view.name, own, latency: line.chat, from, to, misses: input.workerMisses ?? [], faults: daemonFaults }) : [];
      // A CPU miss the harness stayed fast through is real job work on a busy box, a detail line and no fault (harness-slow.ts).
      const miss = found.filter(kind => kind !== "cpu" || slow.length > 0);
      if (found.includes("cpu") && !slow.length) {
        busyMin++;
        const runnable = isLinuxReading(view.usable) ? ` at ${view.usable.runnablePerCore} runnable a core` : "";
        busy.push(`${clock(from)} ${view.name} busy${runnable}${rigWords(view, faultName).replace(/^; /, ", ")}`);
      }
      if (!miss.length) { count.usable++; continue; }
      count.unusable++;
      why.push(`${view.name} unusable (${miss.join(", ")}${slow.length ? `: ${slow.join(", ")}` : ""}${memoryWords(view)}${rigWords(view, faultName)})`);
      // A slow read of the chat service is the harness's own code, whoever used the most cores: at 20:32Z on 10-24 api/threads/<id>/agents
      // took 2.8 s waiting for a projection at 1.09 runnable a core, and the minute went to the apps' side for their 21.99 cores to the harness's 20.12.
      const read = found.includes("cpu") && slowChatRead(own, line.chat) ? "harness" : side(line, view);
      sides.add(read);
      if (read === "harness" && rigsLead(view)) rigged = true;
    }
    if (line && !unknown.length) { fed++; if (!sides.size) usable++; }
    if (sides.has("harness")) { harness++; if (rigged) rigMin++; }
    else if (sides.has("unknown")) unattributed++;
    else if (sides.size) other++;
    if (heldAt(to)) { held++; why.push("a start, wake or parked job held over 10 min"); }
    const waited = line && freeSlotWait(line);
    const parked = poolAt(from, to, false);
    if (waited || parked) freeSlot++;
    if (poolAt(from, to, true) || poolCut.some(job => heldFrom(job) + HOLD_MS < to && (job.resumedAt ?? now) >= from)) cellWait++;
    if (waited) why.push(`a turn of ${waited.tree} queued ${waited.oldestWaitS} s with free slots (${line.queue!.slots} of ${line.queue!.workingMax} in use, its tree at ${waited.slots} of ${line.queue!.treeWorkingMax})`);
    if (parked) why.push(`pi-pool refused ${parked.session.slice(0, 8)} for over 10 min while ${parked.room.join(", ")} took its class`);
    if (offline.size) offlineAny++;
    const minuteFaults = daemonFaults.filter(fault => fault.at >= from && fault.at < to);
    const faults = minuteFaults.filter(fault => !offline.has(fault.host));
    offlineFaults += minuteFaults.length - faults.length;
    if (faults.length) {
      daemonFail++;
      const prime = [...new Set(faults.flatMap(fault => fault.prime ? [fault.prime] : []))];
      if (prime.length) primeMin++;
      why.push(`${prime.length ? `a Prime fault, ${prime.join(" and ")}: ` : ""}daemon calls failed or ran over ${SLOW_MS / 1000} s for ${faultWords(faults, faultName)}`);
    }
    if (why.length) dirty.push(`${clock(from)} ${why.join(", ")}`);
    else if (unknown.length) { unknownMin++; unknownLines.push(`${clock(from)} ${unknown.join(", ")}`); }
    else clean++;
  }
  const inWindow = updates.filter(update => update.to >= start && update.from < start + WINDOW_MS);
  const updateMin = Array.from({ length: 30 }, (_, minute) => start + minute * MINUTE)
    .filter(from => inWindow.some(update => update.from < from + MINUTE && update.to >= from)).length;
  if (inWindow.length) flagged.push({ kind: "prime_update", excerpt: inWindow.map(update => {
    const left = updateFaults.filter(fault => fault.host === update.host && fault.at >= update.from && fault.at <= update.to);
    return `Prime update ${update.requestId} restarted the ${update.host} daemon from ${clock(update.from)} to ${clock(update.to)}; ` +
      `${left.length} daemon call${left.length === 1 ? "" : "s"} that failed or ran over ${SLOW_MS / 1000} s inside it count as planned maintenance, not dirty` +
      (left.length ? ` (${faultWords(left, faultName)})` : "");
  }).join("; ") });
  const { stuck, redDuties } = planCounts(input);
  const quietMs = input.quietMs ?? QUIET_MINUTES * MINUTE;
  const quiet = quietReadings(input.watch, start, start + WINDOW_MS + MINUTE, quietMs);
  const worst = quiet.reduce<QuietReading | undefined>((top, reading) => !top || reading.gb >= top.gb ? reading : top, undefined);
  const worstByHost = new Map<string, QuietReading>();
  for (const reading of quiet) if ((worstByHost.get(reading.host)?.gb ?? -1) <= reading.gb) worstByHost.set(reading.host, reading);
  const latest = input.watch.findLast(line => Date.parse(line.at) > start);
  const oversize = oversized(latest, input.day ?? []);
  const browsers = testBrowsers(latest);
  const hung = hungNow(input.watch, start);
  // Each idle unload sweep (every 60 s) finishes an open handoff (src/idle-unload.ts `resumeUnloaded`), so one still open a whole window later is stuck.
  const stuckHandoffs = (input.openHandoffs ?? []).filter(entry => entry.at < now - WINDOW_MS);
  // The owner's t86 answer on 10-21, "just make it work smooth": a chat head run a job run passed in the turn queue that waited over HEAD_WAIT_S,
  // and a parked tree passed by a later tree of its priority or lower for over HOLD_MS, are holds too. A head that waited with every slot busy and
  // no job run started ahead of it waited for the box's slot count, the owner's number, like a cell wait: from 02:19Z to 03:31Z on 10-22, 11
  // of 688 head runs waited over 30 s while working_max sat at 7 to 16 with about 90 runs queued, and no job run started ahead of any of them.
  const slowAll = (input.smooth?.headWaits ?? []).filter(run => run.waitedS > HEAD_WAIT_S);
  const slowHeads = slowAll.filter(run => run.passed);
  const overtakenLong = (input.smooth?.overtaken ?? []).filter(park => park.minutes * MINUTE > HOLD_MS);
  const metrics: Record<string, number> = {
    clean_min_30: clean,
    queue_holds_30: queueHolds.length + poolHeld.filter(hold => !hold.cell).length + slowHeads.length + overtakenLong.length,
    head_waits_over_30s: slowHeads.length,
    head_waits_full_box: slowAll.length - slowHeads.length,
    parked_overtaken_over_10min: overtakenLong.length,
    cell_holds_30: poolHeld.filter(hold => hold.cell).length + poolCut.length,
    stuck_steps_all: stuck.reduce((sum, entry) => sum + entry.value, 0),
    ...worst ? { quiet_agent_gb: worst.gb } : {},
    oversized_procs: oversize.length,
    mac_test_browsers: browsers.length,
    usable_min_30: usable,
    fed_min_30: fed,
    harness_unusable_min_30: harness,
    harness_rig_unusable_min_30: rigMin,
    cpu_busy_min_30: busyMin,
    other_unusable_min_30: other,
    unattributed_unusable_min_30: unattributed,
    held_min_30: held,
    queued_free_slot_min_30: freeSlot,
    cell_wait_min_30: cellWait,
    daemon_fail_min_30: daemonFail,
    prime_fault_min_30: primeMin,
    prime_update_min_30: updateMin,
    slot_wait_timeouts_30: slotWaits.length,
    offline_min_30: offlineAny,
    unwatched_min_30: unwatched,
    unknown_min_30: unknownMin,
    stuck_duties: redDuties.length,
    cut_jobs_held: cutHeld.length,
    ...hung ? { hung_calls: hung.calls.length } : {},
    ...latest?.services ? { handed_off_services: latest.services.count, handed_off_live: latest.services.live } : {},
    handoffs_stuck: stuckHandoffs.length,
    ...input.smooth ? { head_queue_wait_p90_s: p90(input.smooth.headWaits.map(run => run.waitedS)), parked_overtaken_min_p90: p90(input.smooth.overtaken.map(park => park.minutes)) } : {},
  };
  if (input.smooth) {
    const late = [...overtakenLong].sort((a, b) => b.minutes - a.minutes);
    const slow = [...slowAll].sort((a, b) => b.waitedS - a.waitedS);
    flagged.push({ kind: "smoothness", excerpt: `${input.smooth.headWaits.length} chat head runs started in the window, ${slow.length} of them after over ${HEAD_WAIT_S} s in pi-pool's turn queue` +
      (slow.length ? ` (${slow.slice(0, 5).map(run => `${run.session.slice(0, 8)} ${run.waitedS} s${run.passed ? " behind a job run" : ""}`).join(", ")})` : "") +
      `, ${slowHeads.length} of them passed by a job run and the rest waited for a free slot, p90 ${metrics.head_queue_wait_p90_s} s. ` +
      `${input.smooth.overtaken.length} parked trees got an account, and ${late.length} of them stayed parked over ${HOLD_MS / MINUTE} min after a tree of their priority or lower that parked later got one` +
      (late.length ? ` (${late.slice(0, 5).map(park => `${park.session.slice(0, 8)} ${park.minutes} min`).join(", ")})` : "") + `, p90 ${metrics.parked_overtaken_min_p90} min.` });
  }
  for (const [name, reading] of worstByHost) {
    const key = name.replace(/[^A-Za-z0-9]+/g, "_");
    metrics[`quiet_agent_gb_${key}`] = reading.gb;
    // The agent services in the same minute, a line of their own beside the quiet number, which leaves them out (host-stats.ts CGROUP_RULES).
    const services = reading.whole?.agents.servicesGb;
    if (services !== undefined) metrics[`quiet_services_gb_${key}`] = services;
  }
  for (const [name, count] of perHost) {
    const key = name.replace(/[^A-Za-z0-9]+/g, "_");
    metrics[`usable_min_30_${key}`] = count.usable;
    metrics[`unusable_min_30_${key}`] = count.unusable;
    metrics[`unknown_min_30_${key}`] = count.unknown;
    metrics[`offline_min_30_${key}`] = count.offline;
  }
  const byHost = [...perHost].map(([name, count]) => `${name} read usable in ${count.usable}, unusable in ${count.unusable}, unknown in ${count.unknown} and offline in ${count.offline}`).join("; ");
  flagged.push({ kind: "minutes", excerpt: `${clean} of the last 30 minutes ran clean and ${unknownMin} are unknown. ${byHost || "No box was read"} ` +
    `(${harness} unusable minutes on the harness side, ${other} on the app or owner side, ${unattributed} with no cause read, ${unwatched} with no watch line, and ${rigMin} harness minutes went mostly to job rigs); a start, wake or parked job was held over ` +
    `10 min in ${held}; a turn sat queued while pi-pool had ${FREE_SLOTS} or more slots it could give it, or pi-pool refused a tree for over 10 min while an account took its class, in ${freeSlot}; ` +
    `a tree waited over 10 min for a pi-pool cell at R4's pace, not counted dirty, in ${cellWait}; ` +
    `an open, status read, send or worker start failed or ran over ${SLOW_MS / 1000} s in ${daemonFail}, ${primeMin} of them a Prime fault, a worker crash or hang or a create Prime took over ${SLOW_MS / 1000} s to answer.` +
    (offlineMin.size ? ` Tailscale read ${[...offlineMin].map(([name, at]) => `${name} offline in ${at.length}`).join(" and ")}, and ${offlineFaults} daemon calls to a box while it was offline are left out.` : "") });
  if (input.ciCache) {
    metrics.ci_cache_age_s = Math.max(0, Math.round((now - input.ciCache.fetchedAt) / 1000));
    if (beatStale(input.ciCache, now)) flagged.push({ kind: "ci_cache_stale", excerpt: `The CI cache last read GitHub at ${clock(input.ciCache.fetchedAt)}, ` +
      `${Math.round((now - input.ciCache.fetchedAt) / MINUTE)} min ago at a ${input.ciCache.intervalSeconds} s pace${input.ciCache.error ? ` (last cycle: ${input.ciCache.error})` : ""}. ` +
      "Run wakes read GitHub with gh run view meanwhile; ci-run-status and the gh shim answer from the old cache until it is 10 min old. Read ~/.cache/virev/ci-cache.log and systemctl --user status ci-cache." });
  }
  if (stuckHandoffs.length) flagged.push({ kind: "handoff_stuck", excerpt: `${stuckHandoffs.length} detached-service handoffs stayed open over ${WINDOW_MS / MINUTE} min, ` +
    `though each idle unload sweep resumes them: ${stuckHandoffs.slice(0, 5).map(entry => `${entry.session.slice(0, 8)} ${entry.state} since ${clock(entry.at)}`).join(", ")}. ` +
    "Read ~/.prime/agent/orphan-services/<session>.json and the service log's \"idle unload: <session>\" lines." });
  if (offlineMin.size) flagged.push({ kind: "offline_minutes", excerpt: [...offlineMin].map(([name, at]) => `${name} offline ${spans(at)}`).join("; ") +
    (flappedMin.length ? `; ${flappedMin.length} of these the relay could not read next to a minute Tailscale read offline (${flappedMin.join(", ")})` : "") });
  for (const wait of slotWaits) {
    const fault = wait.fault;
    flagged.push({ kind: "slot_wait_timeout", excerpt: `${clock(fault.at)} ${faultName(fault) ?? `session ${fault.session!.slice(0, 8)}`} on ${fault.host}: ${fault.what}, ` +
      `while it waited for a pi-pool slot from ${clock(wait.slotFrom)}, and ${wait.how === "landed" ? "the outbox found its message landed" : "its worker wrote"} ` +
      `${Math.round((wait.deliveredAt - wait.sentAt) / 1000)} s after it went; a queue wait, not a daemon fault.` });
  }
  if (dirty.length) flagged.push({ kind: "dirty_minutes", excerpt: dirty.slice(-10).join("; ") });
  if (unknownLines.length) flagged.push({ kind: "unknown_minutes", excerpt: unknownLines.slice(-10).join("; ") });
  if (busy.length) flagged.push({ kind: "busy_minutes", excerpt: `${busy.length} minutes the box was CPU-busy and the harness stayed fast, not counted dirty: ${busy.slice(-10).join("; ")}` });
  const quietWords = Math.round(quietMs / MINUTE);
  if (worst?.whole) flagged.push({ kind: "quiet_agents", excerpt: `${worst.host}'s Agent sessions held ${agentWords(worst.whole.agents)} at ${clock(worst.at)}, ` +
    `${Math.round((worst.at - worst.whole.since) / MINUTE)} min into a stretch with no session working that began by ${clock(worst.whole.since)}; ` +
    `the target is under ${QUIET_TARGET_GB} GB once ${quietWords} min pass with nobody working. ${quiet.filter(reading => reading.whole).length} box minutes in the window sat past that mark.` });
  else if (worst) flagged.push({ kind: "quiet_agents", excerpt: quietTreeWords(worst, quietWords) });
  else flagged.push({ kind: "gap", excerpt: `No box line in the last 30 minutes listed its workers or went ${quietWords} min with no session working, so quiet_agent_gb has no minute to judge` });
  const reads = latest ? hostViews(latest).filter(view => view.agents) : [];
  if (latest && reads.length) flagged.push({ kind: "agents_now", excerpt: `At ${clock(Date.parse(latest.at))}: ${reads.map(view => `${view.name} ${agentWords(view.agents!)}`).join("; ")}.` });
  for (const entry of oversize) flagged.push({ kind: "oversized", excerpt: entry.text });
  for (const entry of browsers) flagged.push({ kind: "test_browser", ...entry.root ? { chat: entry.root } : {}, ...entry.session ? { item: entry.session } : {}, excerpt: entry.text });
  for (const call of hung?.calls ?? []) flagged.push({ kind: "hung_call", chat: call.root, item: call.session, excerpt: `${call.tree}: ${call.name} (${call.session}) ` +
    `has run one tool call for ${call.silentMin} min with no output${call.why === "kernel burning" ? `, its kernel burning ${call.kernelCores} cores` : `, its commands at ${call.workCores} cores`}` +
    `${call.command ? ` (${call.command})` : ""}, at ${clock(hung!.at)}.` });
  for (const { at, call } of stoppedSince(input.watch, start)) flagged.push({ kind: "hung_call_stopped", chat: call.root, item: call.session,
    excerpt: call.cell !== undefined
      ? `${call.tree}: ${call.name} (${call.session}) ran one tool call ${call.silentMin} min with no output, its kernel at ${call.kernelCores} cores, so the ` +
        `watch interrupted the cell in kernel ${call.cell} at ${clock(at)}${call.command ? ` (${call.command})` : ""}.`
      : `${call.tree}: ${call.name} (${call.session}) ran one tool call ${call.silentMin} min with no output at ${call.workCores} cores, so the watch stopped ` +
        `its bash() command at ${clock(at)} and the call returned (${call.handles.map(handle => `${handle.pid} ${handle.command.slice(0, 80)}`).join("; ")}).` });
  const overruns = (input.queueOverruns ?? []).filter(entry => entry.at >= start && entry.at < start + WINDOW_MS);
  if (overruns.length) {
    const byTarget = new Map<string, QueueOverrun[]>();
    for (const entry of overruns) byTarget.set(`${entry.session} on ${entry.host}`, [...byTarget.get(`${entry.session} on ${entry.host}`) ?? [], entry]);
    const words = [...byTarget.values()].map(list => {
      const most = Math.max(...list.map(entry => entry.pending ?? entry.limit));
      const name = faultName({ at: list[0]!.at, host: list[0]!.host, session: list[0]!.session, what: "" }) ?? `session ${list[0]!.session}`;
      return `${name} on ${list[0]!.host} at up to ${most} of ${list[0]!.limit} (${list.length} ${list.length === 1 ? "send" : "sends"} from ${clock(list[0]!.at)})`;
    });
    flagged.push({ kind: "queue_overruns", excerpt: `${byTarget.size} ${byTarget.size === 1 ? "target" : "targets"} held more pending messages than the daemon's target, and their sends waited in the agent outbox, not counted dirty: ${words.join("; ")}` });
  }
  for (const hold of queueHolds.sort((a, b) => a.from - b.from).slice(0, 12)) {
    flagged.push({ kind: "queue_hold", item: hold.what, excerpt: `${hold.what} waited ${minutes(hold.to - hold.from)} min${hold.from - (input.log.firstAt ?? -Infinity) < MINUTE ? " or more (held when the log read starts)" : ""}, ${clock(hold.from)} to ${clock(hold.to)}.` });
  }
  for (const hold of poolHeld.sort((a, b) => a.from - b.from).slice(0, 12)) {
    flagged.push({ kind: "queue_hold", item: hold.session, excerpt: `pi-pool refused ${hold.session} for ${minutes(hold.to - hold.from)} min, ${clock(hold.from)} to ${clock(hold.to)}, ` +
      (hold.cell ? `waiting for a cell of ${hold.room.join(", ")} at R4's pace while trees of its priority or higher took them.` : `while ${hold.room.join(", ")} took its class.`) });
  }
  for (const entry of stuck) flagged.push({ kind: "stuck_steps", item: entry.chat.id,
    excerpt: `${entry.chat.name}: ${entry.value} open steps nobody moves${entry.items.length ? ` (${entry.items.join(", ")})` : ""}, from its check-in at ${clock(entry.at!)}.` });
  for (const duty of redDuties) flagged.push({ kind: "stuck_duty", chat: duty.chat, excerpt: duty.line });
  for (const job of poolCut) flagged.push({ kind: "queue_hold", chat: job.chat, item: job.session, excerpt: `cut job ${job.name} (${job.session}) waited from ` +
    `${clock(heldFrom(job))}${job.resumedAt === undefined ? "" : ` to ${clock(job.resumedAt)}`} for pi-pool to admit its tree again, not counted dirty.` });
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
  const candidates: { chat: string; chain: readonly Folder[]; path: string; end: CutSpan }[] = [];
  // Cuts that some input ended at or after this still held minutes of measure's window, which starts at most WINDOW_MS + 1 min before now.
  const since = now - WINDOW_MS - MINUTE;
  /** Per chat, each job name read in the look-back with the latest session that carries it, for `replacedBy`. */
  const latest = new Map<string, Map<string, string>>();
  const gone = new Set(Object.values(deleted).flatMap(chat => Object.keys(chat ?? {})));
  const parents = new Map<string, Promise<Set<string>>>();
  const deletedBy = (file: string): Promise<Set<string>> => {
    if (!parents.has(file)) parents.set(file, readFile(file).then(deletedChildren, () => new Set<string>()));
    return parents.get(file)!;
  };
  const metas = new Map<string, Promise<{ sessionName?: unknown; status?: unknown } | null>>();
  const metaOf = (folder: string) => {
    if (!metas.has(folder)) metas.set(folder, readJson(join(folder, "rlm-subagent.json")) as Promise<{ sessionName?: unknown; status?: unknown } | null>);
    return metas.get(folder)!;
  };
  /** Whether this folder's job was deleted on purpose: the RLM runtime marked it deleted, the chat service deleted or parked it, or its parent's delete_subagent named it. */
  const deletedOnPurpose = async (folder: Folder): Promise<boolean> =>
    gone.has(basename(folder.dir)) || (await metaOf(folder.dir))?.status === "deleted" || (await deletedBy(folder.parentFile)).has(basename(folder.dir));
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
        // A file last written before `since` got no input since then, so only the cut it ends on can hold the window.
        const spans = changed >= since ? await readCutSpans(path, since) : [await readCut(path)].filter((cut): cut is CutSpan => cut !== null);
        for (const end of spans) if (end.resumedAt !== undefined || now - end.at <= CUT_LOOKBACK_MS) candidates.push({ chat, chain: here, path, end });
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
    const later = end.resumedAt === undefined ? latest.get(chat)?.get(job.name) : undefined;
    found.push({ ...job, chat, at: end.at, cause: end.cause, ...end.resumedAt === undefined ? {} : { resumedAt: end.resumedAt },
      ...end.slotAt === undefined ? {} : { slotAt: end.slotAt }, root: await jobOf(chain[0]!),
      ...(proof ? { proof } : {}), ...(later !== undefined && later > job.session ? { replacedBy: later } : {}) });
  }
  return found;
}

/** A job folder on the walk: its folder, the transcript of the job above it and its own transcript's file name. */
interface Folder { dir: string; parentFile: string; file: string }

/**
 * The children an rlm.delete_subagent call in a parent transcript deleted: each `rlm_child_id='sub-...'` whose line is a toolResult and
 * whose call line before it calls delete_subagent, as resume_paused.py's parent_deleted reads it. A plain substring of the id missed
 * fair-self-heal (sub-6430b61d) on 10-16. One scan reads every child of the parent: a scan per child of a 68 to 114 MB chat transcript held
 * the chat's event loop 0.4 to 0.57 s at a time on us-metal02 on 10-20 (cpu-profiles, 10.7 s of 70 min).
 */
export function deletedChildren(text: Buffer): Set<string> {
  const marker = "rlm_child_id='";
  const deleted = new Set<string>();
  for (let at = text.indexOf(marker); at >= 0; at = text.indexOf(marker, at + marker.length)) {
    const idAt = at + marker.length;
    const close = text.indexOf("'", idAt);
    if (close < 0) break;
    const child = text.toString("utf8", idAt, close);
    if (deleted.has(child)) continue;
    const start = text.lastIndexOf(10, at) + 1;
    const result = text.indexOf('"toolResult"', start);
    const call = text.lastIndexOf('"toolCall"', start);
    if (result < 0 || result > at || call < 0) continue;
    const deleteAt = text.indexOf("delete_subagent", text.lastIndexOf(10, call) + 1);
    if (deleteAt >= 0 && deleteAt < start) deleted.add(child);
  }
  return deleted;
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
    // A cut that a later input ended was work someone wanted back, whatever the board says now: once its step is done the board no longer names it.
    if (job.resumedAt !== undefined) return true;
    const open = steps.get(job.chat);
    if (!open) return true;
    // A later session took the work: a newer job of the same name (ci train 01a13a70 and its replacement 01a14068 on 10-16), or a step that names
    // the job and points at a later session.
    if (job.replacedBy !== undefined) return false;
    return [job, job.root ?? job].some(one => open.some(step => step.sessionId === one.session ||
      (step.job === one.name && (step.sessionId === undefined || step.sessionId <= one.session))));
  });
}

/** The lines of every daemon.sock.*.log and its rotated copies under `logs`. */
async function daemonLogs(logs: string): Promise<string[][]> {
  const names = (await readdir(logs).catch(() => [] as string[])).filter(name => name.startsWith("daemon.sock.") && name.includes(".log")).sort();
  return Promise.all(names.map(async name => (await readFile(join(logs, name), "utf8").catch(() => "")).split("\n")));
}

/** The daemon's stops in each daemon log's lines. */
function daemonStops(logs: readonly (readonly string[])[]): DaemonStops {
  const all = logs.map(readDaemonStops);
  return { restarts: all.flatMap(stops => stops.restarts), sigterms: all.flatMap(stops => stops.sigterms) };
}

/** When each session that owns an open step last wrote its transcript: a root's under sessions, a job's under its chat's session-artifacts. */
async function ownerActivity(agentDir: string, boards: ReadonlyMap<string, ChatBoard | null>, named: Inputs["named"] = new Map()): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const mtime = async (file: string) => (await stat(file).catch(() => null))?.mtimeMs;
  for (const [chat, board] of boards) {
    const owners = new Set<string>();
    walk(board?.plan ?? [], item => { if (OPEN.has(item.status)) for (const session of stepSessions(item, named.get(chat) ?? new Map())) owners.add(session); });
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

/** How much of a transcript's end `poolWaitingOwners` reads: in 1,448 job transcripts on 10-18 the last assistant line started at most 155 KB before the end. */
export const POOL_TAIL_BYTES = 1_000_000;
/** Whether a transcript's last assistant turn ended on a pi-pool slot wait (`POOL_WAIT`), from its last lines. */
export function endsOnPoolWait(lines: readonly string[]): boolean {
  for (let at = lines.length - 1; at >= 0; at--) {
    if (!lines[at]!.includes('"role":"assistant"')) continue;
    try {
      const message = (JSON.parse(lines[at]!) as { message?: { stopReason?: unknown; errorMessage?: unknown; diagnostics?: unknown } }).message;
      return message?.stopReason === "error" && POOL_WAIT.test(turnError(message) ?? "");
    } catch { continue; }
  }
  return false;
}

/** The step owners whose transcript, a root's under sessions or a job's under its chat's session-artifacts, ends on a pi-pool slot wait. */
async function poolWaitingOwners(agentDir: string, boards: ReadonlyMap<string, ChatBoard | null>, named: Inputs["named"] = new Map()): Promise<Set<string>> {
  const out = new Set<string>();
  for (const [chat, board] of boards) {
    const owners = new Set<string>();
    walk(board?.plan ?? [], item => { if (OPEN.has(item.status)) for (const session of stepSessions(item, named.get(chat) ?? new Map())) owners.add(session); });
    if (owners.size === 0) continue;
    const subs = (await readdir(join(agentDir, "session-artifacts", chat)).catch(() => [] as string[])).filter(name => name.startsWith("sub-"));
    for (const session of owners) {
      const files = [join(agentDir, "sessions", `${session}.jsonl`), ...subs.map(sub => join(agentDir, "session-artifacts", chat, sub, `${session}.jsonl`))];
      const found = (await Promise.all(files.map(async file => ({ file, at: (await stat(file).catch(() => null))?.mtimeMs })))).filter(entry => entry.at !== undefined);
      const newest = found.sort((a, b) => b.at! - a.at!)[0];
      if (newest && endsOnPoolWait(await tailLines(newest.file, POOL_TAIL_BYTES))) out.add(session);
    }
  }
  return out;
}

/**
 * The step owners that sleep on an owed board.wake, they or a subagent below them: launch main bro's deep walks 99 (p137) and hand run lanes
 * autoscale (p145) slept on CI run wakes on 10-18 and wrote nothing while they waited.
 */
async function wakingOwners(agentDir: string, wakesDir: string, boards: ReadonlyMap<string, ChatBoard | null>, now: number, named: Inputs["named"] = new Map()): Promise<Set<string>> {
  const wakes = await pendingWakes(wakesDir, now);
  const out = new Set<string>();
  if (!wakes.length) return out;
  const below = (session: string): string[] => {
    const dir = join(agentDir, "session-artifacts", session);
    try {
      return readdirSync(dir).filter(name => name.startsWith("sub-")).flatMap(sub => {
        try { return readdirSync(join(dir, sub)).filter(name => name.endsWith(".jsonl")).map(name => name.slice(0, -".jsonl".length)); } catch { return []; }
      });
    } catch { return []; }
  };
  for (const [chat, board] of boards) {
    walk(board?.plan ?? [], item => {
      if (!OPEN.has(item.status)) return;
      for (const session of stepSessions(item, named.get(chat) ?? new Map())) if (!out.has(session) && treeWakes(session, below, wakes).length) out.add(session);
    });
  }
  return out;
}

/** Per chat, each job name with the sessions of its jobs (the `sub-*` folders right under the chat) that the runtime has not marked deleted. */
async function jobSessions(artifacts: string, chats: readonly string[]): Promise<Map<string, Map<string, string[]>>> {
  const out = new Map<string, Map<string, string[]>>();
  for (const chat of chats) {
    const names = new Map<string, string[]>();
    const subs = (await readdir(join(artifacts, chat)).catch(() => [] as string[])).filter(name => name.startsWith("sub-"));
    const read = await Promise.all(subs.map(async sub => {
      const folder = join(artifacts, chat, sub);
      const meta = await readJson(join(folder, "rlm-subagent.json")) as { sessionName?: unknown; status?: unknown } | null;
      const file = (await readdir(folder).catch(() => [] as string[])).find(name => name.endsWith(".jsonl") && SESSION_ID.test(name.slice(0, -".jsonl".length)));
      return typeof meta?.sessionName === "string" && meta.status !== "deleted" && file ? { name: meta.sessionName, session: file.slice(0, -".jsonl".length) } : null;
    }));
    for (const job of read) if (job) names.set(job.name, [...names.get(job.name) ?? [], job.session]);
    out.set(chat, names);
  }
  return out;
}

/** This box's catalog copy (`session-copy.json`, host null) and each other box's (`MIRROR_DIR/<host>.sessions.json` in src/host-catalogs.ts). */
export async function catalogCopyFiles(dataDir: string): Promise<{ host: string | null; text: string }[]> {
  const mirror = join(homedir(), ".cache/sieun-pi/hosts");
  const files = [{ host: null, file: join(dataDir, "session-copy.json") }, ...(await readdir(mirror).catch(() => [] as string[]))
    .filter(name => name.endsWith(".sessions.json")).map(name => ({ host: name.slice(0, -".sessions.json".length), file: join(mirror, name) }))];
  return Promise.all(files.map(async ({ host, file }) => ({ host, text: await readFile(file, "utf8").catch(() => "") })));
}

/** The text of each box's catalog copy (`catalogCopyFiles`). */
export async function catalogCopies(dataDir: string): Promise<string[]> {
  return (await catalogCopyFiles(dataDir)).map(copy => copy.text);
}

const readJson = async (file: string): Promise<unknown> => JSON.parse(await readFile(file, "utf8").catch(() => "null")) as unknown;

/**
 * The chats, live boards and step owners `planCounts` reads, from the chat service's data dir. Only the owner's chats (`ownerChats`): an archived
 * or clean-room test chat stays out of his counts and the job's messages. `names` titles a chat; one it lacks reads as its short id.
 */
export async function planInputs(dataDir: string, now: number, names: ReadonlyMap<string, string>): Promise<Required<Omit<PlanInputs, "now" | "away" | "hosts" | "holds">> & { now: number; pausedChats: Set<string> }> {
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
      duties: [...paused ? [] : [{ id: CHECK_IN_DUTY_ID, name: "Check-in" }], ...file.duties.filter(duty => duty.status === "active").map(duty => ({ id: duty.id, name: duty.name, metrics: duty.metrics }))] });
  }
  const boardStore = new BoardStore(dataDir);
  const boards = new Map(await Promise.all(ids.map(async id => [id, await boardStore.read(id).catch(() => null)] as const)));
  const agentDir = join(dataDir, "..");
  const named = await jobSessions(join(agentDir, "session-artifacts"), ids);
  return { now, chats, pausedChats, boards, named, ownerActivity: await ownerActivity(agentDir, boards, named),
    waking: await wakingOwners(agentDir, join(dataDir, "wakes"), boards, now, named), poolWaiting: await poolWaitingOwners(agentDir, boards, named) };
}

async function main(): Promise<void> {
  const output = process.env.OUTPUT_FILE;
  if (!output) { process.stderr.write("whole-system: OUTPUT_FILE is not set\n"); process.exit(2); }
  const now = Date.now();
  const dataDir = chatDataDir();
  const day = await readWatch(dataDir, now - DAY_MS, now);
  const quietMs = quietMinutes(dataDir) * MINUTE;
  const watch = day.filter(line => Date.parse(line.at) >= now - Math.max(2 * WINDOW_MS, WINDOW_MS + quietMs + 2 * MINUTE));
  const names = new Map<string, string>();
  for (const line of watch) for (const tree of [...line.top, ...line.trees ?? []]) if (tree.root && tree.tree) names.set(tree.root, tree.tree);
  const plan = await planInputs(dataDir, now, names);
  const live = plan.chats.map(chat => chat.id);
  const supervisorLogs = await daemonLogs(join(dataDir, "..", "logs"));
  const cut = await findCutJobs(join(dataDir, "..", "session-artifacts"), live,
    (await readJson(join(dataDir, "deleted-jobs.json")) ?? {}) as Record<string, Record<string, number>>, now, daemonStops(supervisorLogs));
  const serviceLines = await tailLines(join(dataDir, "service.log"), LOG_TAIL_BYTES);
  const box = watch.at(-1)?.host ?? hostname();
  const workerPolls = supervisorLogs.flatMap(workerMisses).filter(at => at >= now - WINDOW_MS - 2 * MINUTE);
  const reopened = readReopenedSends(serviceLines);
  const allFaults = [...readServiceFaults(serviceLines, box), ...supervisorLogs.flatMap(lines => readSupervisorFaults(lines, box, reopened))]
    .filter(fault => fault.at >= now - WINDOW_MS - 2 * MINUTE);
  const queueOverruns = readQueueOverruns(serviceLines, box).filter(entry => entry.at >= now - WINDOW_MS - 2 * MINUTE);
  const listed = listedSessions(await catalogCopies(dataDir), [...allFaults.flatMap(fault => fault.session ? [fault.session.slice(0, 8)] : []), ...queueOverruns.map(entry => entry.session)]);
  const marks = await readSessionMarks(deliveryCandidates(allFaults), short => listed.get(short)?.file, box, now);
  const { faults: daemonFaults, slotWaits } = splitSlotWaits(allFaults, outboxLandings(serviceLines), fault => marks.get(fault.session!.slice(0, 8)));
  const poolLines = await tailLines(POOL_LOG, POOL_LOG_TAIL_BYTES);
  const turns = (await readJson(join(dirname(POOL_LOG), "turns.json")) ?? {}) as { lead?: unknown };
  const poolLead = Array.isArray(turns.lead) ? turns.lead.filter((id): id is string => typeof id === "string") : [];
  const result = measure({
    ...plan,
    watch, day, quietMs,
    log: readServiceLog(serviceLines),
    pool: readPoolLog(poolLines, now),
    // The heads are the sessions pi-pool leads, as its turns.json lists them, beside the owner's chats. At 03:31:09Z on 10-23 "three things 3"
    // (01a1664f), a lead the owner chat list did not name, started ahead of 01a1164b and read as a job run that passed a head. An archived chat
    // still runs jobs but leads nothing: counting archived chats as heads read 01a14210's 2,330 s wait as a head held at the 10:21Z run.
    smooth: readSmoothness(poolLines, new Set([...live, ...poolLead]), now - WINDOW_MS, now),
    daemonFaults,
    primeUpdates: (await readUpdateSpans(join(dataDir, ".."))).map(update => ({ ...update, host: box })),
    workerMisses: workerPolls,
    queueOverruns,
    slotWaits,
    listed,
    cut: cutJobsHoldingWork(cut, plan.boards, plan.pausedChats),
    poolHeldJobs: poolHeldCuts(serviceLines),
    ciCache: await readBeat(),
    openHandoffs: (await readRecords().catch(() => [])).flatMap(record => record.handoffs.filter(handoff => handoff.state !== "unloaded")
      .map(handoff => ({ session: record.sessionId, state: handoff.state, at: Date.parse(handoff.at) }))),
  });
  // A flagged worker on this box keeps read-only evidence of what it holds beside the run's output (src/proc-evidence.ts).
  const here = watch.at(-1)?.host;
  for (const entry of oversized(watch.at(-1), day)) {
    if (entry.pid === null || entry.host !== here) continue;
    const text = await processEvidence(entry.pid);
    if (!text) continue;
    const file = `${output.replace(/\.json$/, "")}.worker-${entry.pid}.txt`;
    await writeFile(file, text);
    const slice = result.flagged?.find(item => item.kind === "oversized" && item.excerpt === entry.text);
    if (slice) slice.excerpt += `; its memory map and threads: ${file}`;
  }
  // The Chat system duty (d9, chat-system.ts) has counted stuck steps and stuck duties since 10-19, so this duty's job gets neither.
  delete result.metrics.stuck_steps_all;
  delete result.metrics.stuck_duties;
  if (result.flagged) result.flagged = result.flagged.filter(slice => slice.kind !== "stuck_steps" && slice.kind !== "stuck_duty");
  await writeFile(output, JSON.stringify(result, null, 2) + "\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
