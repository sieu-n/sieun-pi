import { open, readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { homedir } from "node:os";
import type { IdIndex } from "./id-index.ts";
import { ArchiveLeftWork, ScheduledJobsLeft } from "./saved-archive.ts";
import { artifactsDir } from "./moved-images.ts";
import { agentChildren } from "./chat-agents.ts";
import { activeCorrections, handoffRules } from "./chat-corrections.ts";
import { deadWakes, heartbeatsFile, landCarries, liveThreads, localDisk, parkSchedules, quotaParks, readHeartbeats, readTrain, trainFile, trainRepo, withDeadWakes, withQuotaParks, withStalls, withWakes } from "./checkin-load.ts";
import { flagStreaks, sentAfter, unsentFindings } from "./checkin-repeats.ts";
import { boardPrs, type DoneFacts, metricFacts } from "./checkin-done.ts";
import { activePause, changeCheckIn, type CheckInActor, type CheckInChange, CheckInRefused, type CheckInSetting, DEFAULT_CHECK_IN, nextCheckIn, planCheckIn } from "./checkin-settings.ts";
import { checkInDue, childName, childWorking, type JobFact, jobFacts, liveJobs, liveWindowMs, nestedJobs, OPEN, parkedBy, planHasOpenStep, poolWait, walk } from "./checkin-steps.ts";
import { treeWakes, type Wake } from "./wakes.ts";
import { withQueuePlaces } from "./chat-turn-queue.ts";
import { type CheckInContext, type CheckInMemory, checkInPrecheck, checkInPrecheckText, classCounts, convergenceMisses, endedJobs, endedWithoutReport, finishedJobs, JOB_CLEANUP_EVERY_MS, ROOT_END_EVERY_MS, jobEnd, jobEndText,
  handBackNote, handBackSteps, handBackText, idleRoots, jobReport, lastJobMessages, leftOpenSteps, noReportNotice, openStepLines, openStepsNotice, reportedRoot, retryDue, waitingJobs } from "./chat-checkin.ts";
import { jobBase, jobBrief, jobModel, keptCopyNote, replacedJob, resumeBrief, resumedNote, resumeJobName, savedStateNote, sessionBrief, sessionModel, waitText } from "./job-resume.ts";
import { type AwayHost, hostHolds } from "./shared/host-hold.ts";
import { heldByTodo, withBoardLinks } from "./shared/todo-hold.ts";
import { PoolHeldJobs, resumeChatJobs } from "./chat-resume.ts";
import { readEndsParked, readQuotaPark, withFailedTurns, withHeldTurns } from "./held-turns.ts";
import { withUnstarted } from "./brief-keeper.ts";
import { planJob } from "./shared/chat-board.ts";
import { noticeStands } from "./no-report.ts";
import { statusAsks } from "./status-ask.ts";
import { owedLinkLines } from "./owed-links.ts";
import { tailMessages } from "./checkin-ops.ts";
import { unpushed } from "./checkin-goals.ts";
import { BRIEF_ITEMS } from "./shared/brief-cap.ts";
import { spawnRecord } from "./spawn-record.ts";
import { pooledProviders } from "./chat-pool.ts";
import { checkInLane, type ClaudeState, claudeDown, failureCause, hungMessage, hungTurn, jobWake, type JobWake, ownerPause, revivalMessage, type Stall, stallAction, strandedInput, turnStall, turnViewOf, wokeFromSleep } from "./chat-recovery.ts";
import { CHECK_IN_PREFIX, JOB_NOTICE_PREFIX, poolSlot, TELL_OWNER_TOOL } from "./shared/chat-feed.ts";
import { checkInIdle, checkInPrompt } from "./chat-checkin.ts";
import { type JobPush, jobPushLine, jobPushMessage } from "./checkin-jobs.ts";
import { correctionStep } from "./correction-refine.ts";
import { briefCheck, briefCheckNote, ownerSaid } from "./shared/brief-check.ts";
import { type CheckInRun, runStamp } from "./chat-duty-run.ts";
import { CHECK_IN_DUTY_ID } from "./shared/chat-duties.ts";
import type { ChatAgent, ChatBoard, ChatBriefState, CheckInState, CheckInView, ChildAgent, FirstMessage, OwnerTodo, PlanItem, QueuePlace, SessionRow, ThinkingLevel, ThreadMessage } from "./shared/types.ts";
import { chatBrief, type LoadRecord, reloadAction } from "./chat-brief.ts";
import { BRIEF_CHECK_MAX_AGE_MS, type ChatLinks, type ChatSummary, type ChatThreads, type CheckInSource, CHECK_MAX_AGE_MS, type SubagentDelete } from "./chat-sources.ts";
import { chatName, fileHasChatMarker, ownerStopSinceActive } from "./chat-guard.ts";
import { ARTIFACTS, type Leftovers, sessionTree } from "./job-leftovers.ts";
import { type CancelBy, cancelAsker, cancelPurpose, cancelWords, type JobCancel, jobPlace } from "./job-cancels.ts";
import type { ArchiveBy } from "./service-archives.ts";
import type { PrimeUpdate } from "./prime-update.ts";

export { TELL_OWNER_TOOL };

/** The daemon's answer for an active session id it does not hold: that session ended, whatever its list still says. */
export const UNKNOWN_ACTIVE = "Unknown active session:";
/** A thread the daemon no longer has: not in the catalog (404), or listed active with a session the daemon does not hold. */
const threadGone = (error: unknown): boolean =>
  error instanceof Error && ((error as { status?: unknown }).status === 404 || error.message.startsWith(UNKNOWN_ACTIVE));
/** The prompt of the daemon heartbeat that did the check-in before the server tick; an attach clears a heartbeat whose prompt starts with it. */
/** The daemon client's answer for a call whose link this side closed. */
const CLIENT_CLOSED = /daemon client closed before the operation completed/;
export const OLD_CHECK_IN = "Check-in. Read the board";
/** A job quiet this long with no report is told to the chat; shorter gaps are a job between tool calls or one that a reply woke again. */
export const NO_REPORT_GRACE_MS = 90_000;
/** Two ends of one job whose last activity is this close are one end: told once. */
export const NO_REPORT_SAME_END_MS = 60_000;
/** How many graces a no-report check waits while the chat is mid-turn before it tells the chat anyway. */
export const NO_REPORT_BUSY_TRIES = 6;
/**
 * The daemon's rows say only whether a subagent runs. The hub's attach keeps a finished job "done" while a follow-up task runs and shows the work
 * in `activity`, which is what `endedWithoutReport` looks for, so a job seen ended that runs again keeps its status here too.
 */
export function followUps(before: readonly ChildAgent[] | undefined, roster: readonly ChildAgent[]): ChildAgent[] {
  return roster.map(child => {
    const was = before?.find(candidate => candidate.id === child.id);
    if (child.status !== "running" || !was || was.status === "running" || was.status === "queued") return child;
    return { ...child, status: was.status, activity: { kind: "executing" } };
  });
}

/**
 * An attached chat's children with what the daemon's rows add: its session id, the later of the two last activities, and a running turn the attach missed,
 * kept as `followUps` keeps it. The parent's record of a finished job can freeze (VP of CI 10-13: the attach kept "repo rules check fix" at
 * 09:20:49Z and stopped it mid-tool while its session file shows work until 09:47:48Z), and the row reads the job's own session.
 */
export function withRoster(attached: readonly ChildAgent[], roster: readonly ChildAgent[]): ChildAgent[] {
  return attached.map(child => {
    const row = roster.find(candidate => candidate.id === child.id);
    if (!row) return child;
    const at = Math.max(child.lastActivityAt ?? -Infinity, row.lastActivityAt ?? -Infinity);
    const running = row.status === "running" && !childWorking(child);
    const settled = settledLater(child, row);
    const sessionId = child.sessionId ?? row.sessionId;
    if (at === (child.lastActivityAt ?? -Infinity) && !running && !settled && sessionId === child.sessionId) return child;
    return { ...child, ...(sessionId !== undefined ? { sessionId } : {}), ...(Number.isFinite(at) ? { lastActivityAt: at } : {}), ...(running ? { activity: { kind: "executing" as const } } : {}),
      ...(settled ? { status: row.status, ...(row.repliedSinceTask !== undefined ? { repliedSinceTask: row.repliedSinceTask } : {}) } : {}) };
  });
}

/**
 * Whether the daemon's row shows a later end of the job than the chat's attached record: the row is newer, the job is not working in either,
 * and the owner did not cancel it. Its status and `repliedSinceTask` then come from the row. frontend bro 10-14: the chat's record of email list
 * funnel columns froze at 02:19:44Z with status error and no reply, while the job was woken, worked until 06:14Z and reported, so the cleanup
 * never deleted it; the daemon's row said done and replied.
 */
const settledLater = (child: ChildAgent, row: ChildAgent): boolean => (row.lastActivityAt ?? -Infinity) > (child.lastActivityAt ?? -Infinity) &&
  row.status !== "running" && !childWorking(child) && child.status !== "cancelled" && (row.status !== child.status || row.repliedSinceTask !== child.repliedSinceTask);

/**
 * The chat's children with each subagent the daemon lists under it that they lack and that is live: at work, or with a pending board.wake on its
 * session or one below it (`treeWakes`). Crawler VP 10-18 03:00Z: the idle unload stopped census canary run, query mcp build and census seed
 * order at 02:57:26Z, the service restarted at 02:58:56Z, and the check-in a minute later read p252 "(census canary run not found)" and about
 * 70 steps "(crawler ops train not found)" while each slept on its run and time wakes.
 */
export function withLiveRoster(children: readonly ChildAgent[], roster: readonly ChildAgent[], wakes: readonly Wake[], below: (session: string) => readonly string[]): ChildAgent[] {
  const known = new Set(children.map(child => child.id));
  const live = roster.filter(row => !known.has(row.id) && (childWorking(row) || (row.sessionId !== undefined && treeWakes(row.sessionId, below, wakes).length > 0)));
  return live.length ? [...children, ...live] : [...children];
}

/** The check-in scheduler wakes this often; each chat runs at its own interval, so an interval is kept to within this much. */
export const CHECK_IN_TICK_MS = 30_000;
/**
 * After the 10-18 update the new supervisor listened at 06:47:22Z, a wake sent at 06:47:36Z failed with "Session worker is starting", and one
 * at 06:48:44Z went through, 82 s after the start.
 */
export const SUPERVISOR_RESUME_MS = 90_000;
/** A check-in whose job could not start runs again after this long, not a whole interval later (`CheckInStart`). */
export const CHECK_IN_RETRY_MS = 5 * 60_000;
/** How often the scheduler looks for chats the index lost, and how recent a thread must be to be looked at. */
export const ADOPT_SCAN_MS = 10 * 60_000;
export const ADOPT_RECENT_MS = 7 * 24 * 60 * 60_000;
/** A job of a chat quiet for longer than this is not looked at for a failed turn. */
export const JOB_WAKE_WINDOW_MS = 24 * 60 * 60_000;
/** How long after a change the quiet jobs are written (`Chats.keepQuiet`). */
export const QUIET_WRITE_MS = 5_000;
/** A bad job end found later than this after it happened (the first wake after a deploy reads a day of jobs) is left to the check-in. */
export const JOB_END_NOTE_MAX_AGE_MS = 2 * 60 * 60_000;
/** The queue lane of a chat's notices (`Chats.tell`): apart from the chat's own lane, since a notice is sent from tasks on that lane. */
const heldLane = (id: string): string => `notices:${id}`;
/** A job as the scheduler found it in its chat's row: the chat and its Agents entry. */
interface ChatJob { chat: string; agent: ChatAgent }
/** What `gather` read for one check-in measure. */
interface Gathered {
  board: ChatBoard | null; boardError?: string; rows: readonly SessionRow[]; facts: ReturnType<typeof jobFacts>;
  queued: ReadonlyMap<string, QueuePlace>; asleep: ReadonlySet<string>; wakes: readonly Wake[]; name?: string;
  /** Each subagent's session id by its child id, for a job the check-in pushes (`pushJobs`). */
  sessions?: ReadonlyMap<string, string>;
}

/**
 * Chats on the server: the index, residency (pinned, so they stay attached and resident), steering mode `all` after every attach (it is runtime
 * state), the check-in scheduler (each chat at its own interval, none while the owner paused it), the restart of
 * a chat whose last turn failed, the no-report notice, and the extension build: a chat that last loaded an older build than the one on disk is
 * reloaded when it attaches, at once if idle, else at the end of its turn. Everything converges from the index plus the daemon list, so a restart
 * re-adopts what it finds, and a scan of the session files brings back a chat the index lost.
 */
/** The log's note of the repo copies a gone job left in its wiki session folders, the kernel states and repo copies it left in session-artifacts and the units and paths its ownership records name, which the service stopped or deleted. */
function copiesNote(left: Leftovers): string {
  return (left.copies.length ? `, deleted ${left.copies.length} repo copies (${left.copies.join(", ")})` : "") +
    (left.artifacts.length ? `, deleted ${left.artifacts.length} kernel states and repo copies in session-artifacts (${left.artifacts.slice(0, 5).join(", ")}${left.artifacts.length > 5 ? ` and ${left.artifacts.length - 5} more` : ""})` : "") +
    (left.units.length ? `, stopped its units ${left.units.join(", ")}` : "") +
    (left.owned.length ? `, deleted ${left.owned.length} paths it owned (${left.owned.slice(0, 5).join(", ")}${left.owned.length > 5 ? ` and ${left.owned.length - 5} more` : ""})` : "") +
    (left.kept?.length ? `, kept ${left.kept.length} paths its records name (${left.kept.join("; ")})` : "") +
    (left.containers?.length ? `, removed the containers on them ${left.containers.join(", ")}` : "");
}

/** Whether a session file's last session_state entry is "archived" and was written at or after `since`; read from its last 256 KB. */
export async function endsArchivedSince(file: string, since: number): Promise<boolean> {
  const handle = await open(file, "r").catch(() => null);
  if (!handle) return false;
  try {
    const size = (await handle.stat()).size;
    const length = Math.min(size, 256 * 1024);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    const last = buffer.toString("utf8").split("\n").filter(line => line.includes('"type":"session_state"')).at(-1);
    if (!last) return false;
    const entry = JSON.parse(last) as { timestamp?: string; state?: { status?: string } };
    return entry.state?.status === "archived" && Date.parse(entry.timestamp ?? "") >= since;
  } catch { return false; } finally { await handle.close(); }
}

export class Chats {
  private readonly chatIds = new Set<string>();
  /** The children last seen per thread: the tick reads them, and each change is compared with them to find a job that ended with no report. */
  private readonly children = new Map<string, readonly ChildAgent[]>();
  /** An attached chat's children as its attach last gave them, before `withRoster`. */
  private readonly attachedChildren = new Map<string, readonly ChildAgent[]>();
  /** The daemon's subagents by parent session at the last catalog refresh (`roster`), for the subagents of a chat's duty jobs. */
  private subagents: ReadonlyMap<string, readonly ChildAgent[]> = new Map();
  /** Sessions whose leftovers were stopped (`leftovers`), so a job is stopped once. */
  private readonly leftoversEnded = new Set<string>();
  private deletedSweptAt = -Infinity;
  /**
   * When each job was last seen starting to work, and the end (its last activity) last told to the chat, with the time of the job message it
   * was told as waiting on (none for "ended with no report").
   */
  private readonly workingSince = new Map<string, number>();
  private readonly noticedEnd = new Map<string, { end: number; waited?: number }>();
  /** The job end and steps each open-steps notice told, by child id, so one end is told once. */
  private readonly openStepsTold = new Map<string, string>();
  /** Chats found stale while mid-turn; the end of the turn reloads them. */
  private readonly reloadWaiting = new Set<string>();
  /** Chats the owner's Update all chats reloads even on the current build; each leaves the set once its reload ran. */
  private readonly forced = new Set<string>();
  /** The brief this service's chats load (CHAT_BRIEF): what a chat on an older one is updated to. */
  private readonly brief = chatBrief();
  /** Told when a chat's brief state changes (a reload queued, waiting or done), so the sessions stream sends the rows again. */
  briefChanged: () => void = () => {};
  private readonly syncing = new Map<string, Promise<void>>();
  private loaded: Promise<void> | undefined;
  private readonly unobserve: () => void;
  private readonly timer: ReturnType<typeof setInterval> | undefined;
  private readonly now: () => number;
  /** When each chat's check-in last ran: the check-in memory's time after a restart, the service start for a chat with none. */
  private readonly lastCheckIn = new Map<string, number>();
  private readonly started: number;
  /** Restarts sent per chat since its last turn that ended well: how many, and when the last one went. */
  private readonly revivals = new Map<string, { attempts: number; at: number }>();
  /** Chats with a revive queued and not yet run, so a chat whose queue is held gets one waiting revive, not one per wake. */
  private readonly reviving = new Set<string>();
  /** When the server last stopped a hung turn of each chat. */
  private readonly hungRestarts = new Map<string, number>();
  /** When each chat's current stall was first seen, for a provider retry whose failed reply the hub does not hold. */
  private readonly stallSeen = new Map<string, number>();
  /** Wakes sent per stranded step-owner thread: how many, and when the last one went. */
  private readonly ownerWakes = new Map<string, { attempts: number; at: number }>();
  /** When the scheduler last woke; a longer gap than SLEEP_GAP_MS means the Mac slept. */
  private lastTick: number | null = null;
  /** The last wake that followed a sleep, or the service start: a hung-turn count starts there at the latest. */
  private wokeAt: number;
  /** The subagents and create_session roots of the chats, as the last wake found them, and the wakes sent to each for a transient failure. */
  private jobThreads = new Set<string>();
  /** The jobs of the chats seen since the first look after this service started (undefined before it), and the ones known on this build. */
  private jobsSeen: Set<string> | undefined;
  private readonly jobsCurrent = new Set<string>();
  private readonly jobWakes = new Map<string, JobWake>();
  /**
   * The activity stamp at which a job thread was last found with no transient failure; it is looked at again once the stamp changes. It is
   * read from `quietJobs` before the first look and written back a few seconds after a change (`keepQuiet`).
   */
  private readonly jobQuiet = new Map<string, string>();
  private quietRead: Promise<void> | undefined;
  private quietWrite: ReturnType<typeof setTimeout> | undefined;
  /** When each chat's finished jobs were last checked, and the jobs already deleted (or tried once). */
  private readonly cleanedAt = new Map<string, number>();
  private readonly deletedJobs = new Set<string>();
  /**
   * When the idle roots were last looked at, and each root archived, being archived or found archived in this serve, at the activity stamp it
   * had then: a root that runs again (an agent message resumes it) gets a newer stamp and is looked at again.
   */
  private rootsSweptAt = -Infinity;
  private passWaits = false;
  /**
   * True once the #jobs pass of the first tick and the #interrupted pass it queued ended; check-in lanes can run minutes and are left out. GET /ready answers it,
   * and scripts/release-chat.mjs keeps a new release on trial until then: on 10-23 release fbd5a0a0 answered 3 s after each start and passed the
   * release's 8 s check, then the #interrupted pass of its first tick threw 30 s after each start, and the service crash-looped for 3.5 min.
   */
  ready = false;
  private ticked = false;
  private readonly heldJobs: PoolHeldJobs;
  private rootsEndedAt = -Infinity;
  private readonly rootsEnded = new Map<string, string | undefined>();
  /** Roots the cleanup started whose steps now name other workers (`replacedRoots`): no pass resumes or wakes them, and each is archived once idle. */
  private replaced = new Set<string>();
  private readonly retired = new Set<string>();
  /** The Prime update each retirement path last held for (`updateHold`), so each logs an update once. */
  private readonly heldFor = new Map<string, string>();
  /** Job threads found gone (`threadGone`) at an activity stamp: never looked at again unless the stamp changes. */
  private readonly jobGone = new Map<string, string>();
  /** When the scheduler last looked for lost chats, and the threads with messages found plain (their head never changes). */
  private lastScan: number;
  private readonly plain = new Set<string>();
  /** Jobs whose brief was read for the brief check. */
  private readonly briefSeen = new Set<string>();
  /** The owner's archives of each chat (`archives`), and the last chat-list write of each chat (`membership`). */
  private readonly archiveCounts = new Map<string, number>();
  private readonly membershipTail = new Map<string, Promise<void>>();
  /** The chat list writes to the turn queue (`leadChats`), one at a time, and whether one waits to start. */
  private leadTail: Promise<void> = Promise.resolve();
  private leadWaits = false;

  /**
   * `index` is `<data dir>/chats.json`: the session ids that are chats, newest first. The chat side's one definition of "chat"; the session entry
   * is the agent side's. `build` is the extension build on disk (`extensionBuild()`), `loads` the one each chat last loaded.
   */
  constructor(readonly index: IdIndex, private readonly threads: ChatThreads, private readonly summary: ChatSummary, private readonly build: string,
    private readonly loads: LoadRecord, private readonly source: CheckInSource, private readonly log: (line: string) => void = () => {}) {
    this.now = source.now ?? Date.now;
    this.heldJobs = new PoolHeldJobs((tree, provider) => source.poolAdmits?.(tree, provider) ?? Promise.resolve(false), source.poolHeldFile);
    this.started = this.now();
    this.lastScan = this.started;
    this.wokeAt = this.started;
    this.unobserve = threads.observe({
      live: (id, attached) => {
        this.attachedChildren.set(id, attached);
        const children = withRoster(attached, this.subagents.get(id) ?? []);
        this.children.set(id, children);
        for (const child of children) if (!this.briefSeen.has(child.id)) this.queue(id, () => this.briefCheck(id, child));
        this.queue(id, () => this.attached(id));
        this.queue(id, () => this.refreshExtension(id));
        // A turn that ended just before a restart ended on the old server; an idle chat gets its correction check when it attaches.
        if (!this.threads.busy(id)) this.queue(id, () => this.correctionCheck(id));
      },
      children: (id, attached) => { this.attachedChildren.set(id, attached); this.childrenChanged(id, withRoster(attached, this.subagents.get(id) ?? [])); },
      idle: id => {
        if (this.reloadWaiting.has(id)) this.queue(id, () => this.refreshExtension(id));
        this.cleanSoon(id);
        this.queue(id, () => this.correctionCheck(id));
      },
    });
    const tickMs = source.tickMs ?? CHECK_IN_TICK_MS;
    if (tickMs > 0) {
      this.timer = setInterval(() => { void this.tick(); }, tickMs);
      this.timer.unref();
    }
  }

  private childrenChanged(id: string, children: readonly ChildAgent[]): void {
    const before = this.children.get(id);
    this.children.set(id, children);
    for (const child of children) if (childWorking(child) && !before?.some(was => was.id === child.id && childWorking(was))) this.workingSince.set(child.id, this.now());
    if (before) for (const child of endedWithoutReport(before, children)) this.laterNoReport(id, child.id);
    if (before) for (const child of endedJobs(before, children)) this.laterOpenSteps(id, child.id);
    for (const child of children) if (!this.briefSeen.has(child.id)) this.queue(id, () => this.briefCheck(id, child));
    if (before?.some(was => childWorking(was) && children.some(child => child.id === was.id && !childWorking(child)))) this.cleanSoon(id);
  }

  /**
   * The detail file of a notice that names more than BRIEF_ITEMS items: every line, written next to the chat's duty runs (`writeDetail`);
   * undefined when the notice lists them all or the server runs no duties.
   */
  private async noticeDetail(id: string, kind: string, lines: readonly string[]): Promise<string | undefined> {
    if (lines.length <= BRIEF_ITEMS || !this.source.duty?.writeDetail) return undefined;
    return this.source.duty.writeDetail(id, `${kind}-${runStamp(this.now())}`, [`# ${kind} notice of ${new Date(this.now()).toISOString()}`, lines.map(line => `- ${line}`).join("\n")]);
  }

  /** A job of the chat just ended its turn, or the chat went idle with its reports in: its finished jobs are deleted now, not at the next sweep. */
  private cleanSoon(id: string): void {
    if (!this.children.get(id)?.length) return;
    this.cleanedAt.set(id, this.now());
    this.queue(id, () => this.cleanJobs(id));
  }

  /**
   * Each catalog refresh: the subagents the daemon lists under each chat (`rosterChildren`) become the chat's children while the hub holds no
   * attach of it, so the no-report notice and the check-in read them even when every attach fails (frontend bro 10-13: its worker answered
   * no root-session request, while the daemon's list answered in 540 ms). The brief check still needs the transcript the hub holds. An attached
   * chat keeps the hub's children, with each one's clock and running turn from its row (`withRoster`). A chat the hub opened whose attach has
   * not given its children yet reads the roster too (VP of CI 10-15 13:50Z: right after a restart that gap left 22 steps owned by nobody).
   */
  async roster(byChat: ReadonlyMap<string, readonly ChildAgent[]>): Promise<void> {
    this.subagents = byChat;
    await this.load();
    for (const id of this.chatIds) {
      const before = this.children.get(id);
      const attached = this.threads.isLive?.(id) ? this.attachedChildren.get(id) : undefined;
      const children = attached ? withRoster(attached, byChat.get(id) ?? []) : followUps(before, byChat.get(id) ?? []);
      if (before && JSON.stringify(before) === JSON.stringify(children)) continue;
      this.childrenChanged(id, children);
    }
  }

  /** Tasks of one thread run one after another; `settled` resolves once every queue is empty, for tests. */
  /**
   * Runs `task` after the key's last one. A task that throws is logged, so it never ends the service with an unhandled rejection or skips the
   * key's later tasks: on 10-23 a throw in the #interrupted pass stopped the us-metal02 service 4 times from 01:22Z.
   */
  private queue(id: string, task: () => Promise<void>): void {
    const next = (this.syncing.get(id) ?? Promise.resolve()).then(task)
      .catch((error: unknown) => this.log(`chats: ${id.slice(0, 12)}: ${error instanceof Error ? error.message : String(error)}`));
    this.syncing.set(id, next);
    void next.finally(() => { if (this.syncing.get(id) === next) this.syncing.delete(id); });
  }

  async settled(): Promise<void> {
    while (this.syncing.size) await Promise.all([...this.syncing.values()]);
    await this.leadTail;
  }

  /** Writes the whole chat list to the turn queue (`CheckInSource.lead`). A write that waits reads the list when it starts, so it covers every change before it. */
  private leadChats(): void {
    const lead = this.source.lead;
    if (!lead || this.leadWaits) return;
    this.leadWaits = true;
    this.leadTail = this.leadTail.then(() => { this.leadWaits = false; return lead([...this.chatIds]); })
      .catch((error: unknown) => { this.log(`turn queue: chat list: ${error instanceof Error ? error.message : String(error)}`); });
  }

  /**
   * The index, and each chat's last check-in, so a service restart keeps every chat's schedule instead of starting it over (10-09: three
   * restarts in 16 min kept a 15-min chat from any check-in). The last check-in is the duty runner's newest recorded run, and the check-in
   * memory only without a duty runner: the memory is written when a run is measured, before its record, so a restart in between counted a run
   * that never started (01a1164b 10-15: measured 10:09:38Z, cut off by the 10:12:28Z restart, next check-in set for 12:09Z, none logged).
   */
  private load(): Promise<void> {
    return this.loaded ??= this.index.ids().then(ids => this.mine(ids)).then(async ids => {
      for (const id of ids) this.chatIds.add(id);
      for (const id of ids) {
        const at = this.source.duty ? await this.source.duty.lastCheckIn(id).catch(() => undefined) : (await this.source.memory.get(id).catch(() => undefined))?.at;
        if (at !== undefined && !this.lastCheckIn.has(id)) this.lastCheckIn.set(id, Math.min(at, this.now()));
      }
      this.leadChats();
    });
  }

  /** The ids of `ids` this service acts on: all of them, or only the ones it created when it does not own the live chats. */
  private async mine(ids: readonly string[]): Promise<string[]> {
    if (!this.source.owned) return [...ids];
    const owned = new Set(await this.source.owned.ids());
    return ids.filter(id => owned.has(id));
  }

  async ids(): Promise<ReadonlySet<string>> { await this.load(); return this.chatIds; }
  /** The ids `load` has listed so far, for a shell that cannot wait for the rest (chat-server.ts `shellParts`). */
  known(): ReadonlySet<string> { return this.chatIds; }

  /** `host` is the hosts.json box whose daemon runs the chat; absent means this box. `first` is the owner's first message, which the thread create sends before its attach (ThreadHub.create). */
  async create(input: { cwd: string; provider?: string; modelId?: string; thinkingLevel?: ThinkingLevel; name?: string; host?: string; first?: FirstMessage }): Promise<{ id: string; name: string }> {
    await this.load();
    const name = input.name?.trim() || chatName();
    const { id } = await this.threads.create({ cwd: input.cwd, ...(input.provider ? { provider: input.provider } : {}), ...(input.modelId ? { modelId: input.modelId } : {}),
      ...(input.thinkingLevel ? { thinkingLevel: input.thinkingLevel } : {}), ...(input.host ? { host: input.host } : {}), ...(input.first ? { first: input.first } : {}), name, kind: "chat" });
    await this.source.owned?.add(id);
    await this.index.add(id);
    this.chatIds.add(id);
    this.leadChats();
    this.threads.pin(id);
    await this.threads.setSteeringMode(id, "all");
    await this.loads.set(id, this.build, this.brief);
    return { id, name };
  }

  /**
   * At service start: pin every chat in the index and forget the ones the daemon does not list. With the daemon down the catalog cannot answer,
   * so the chat stays pinned and the pin resumes or drops it on the first catalog update. A pinned saved chat resumes the same way.
   * A chat the daemon lists as archived is unarchived: the archive route forgets a chat the moment it archives it, so an archived chat still in
   * the index was archived by the daemon itself. `prime-agent shutdown --force` and an update restart write the archived state into every live
   * session (10-12 11:38: a forced shutdown archived 25 sessions, and this serve then dropped all 9 chats from the index). A chat the owner
   * archived is forgotten here too, in case the archive route stopped before it left the index.
   */
  async adopt(): Promise<{ pinned: string[]; forgotten: string[]; adopted: string[] }> {
    await this.load();
    const pinned: string[] = [];
    const forgotten: string[] = [];
    const archived = await this.archivedIds();
    for (const id of await this.mine(await this.index.ids())) {
      const summary = await this.summary(id).then(summary => summary ?? "missing", () => "unknown" as const);
      if (summary === "missing" || archived.has(id)) {
        await this.forget(id);
        forgotten.push(id);
        this.log(`chat ${id.slice(0, 8)}: forgotten, ${summary === "missing" ? "the daemon does not list it" : "the owner archived it"}`);
        continue;
      }
      if (summary !== "unknown" && summary.lifecycle === "archived") {
        try {
          await this.threads.unarchive(id);
          this.log(`chat ${id.slice(0, 8)}: unarchived: the daemon archived it, the chat list did not`);
        } catch (error) { this.log(`chat ${id.slice(0, 8)}: unarchive: ${error instanceof Error ? error.message : String(error)}`); }
      }
      this.threads.pin(id);
      pinned.push(id);
    }
    return { pinned, forgotten, adopted: await this.rescan() };
  }

  /**
   * The owner's archive of a chat: the session is archived, the chat leaves the index, and the archived-chats file keeps it out of the chats and
   * the sidebar. An agent message may resume the session later (10-12 20:38 KST: a relayed broadcast resumed "stripe and payments"); it answers
   * as a plain hidden session, with no brief reload, check-in or duty, and nothing archives it again (owner 10-12: "the thread should be able to
   * respond, but not be in the Chats list"). When the daemon did not confirm that the chat's scheduled jobs were cancelled, the chat still leaves
   * the index and the archive throws ScheduledJobsLeft; the route answers 502 only when no retry of the cancel was recorded. When only Prime's stop of a
   * handed-off service waits on a receipt, the chat leaves the index the same way and the archive throws ServicesStopPending, which says so.
   */
  async archive(id: string, by: ArchiveBy): Promise<void> {
    this.archiveCounts.set(id, this.archives(id) + 1);
    const stop = this.threads.archive(id, by);
    stop.catch(() => {});
    await this.membership(id, async () => {
      const left = await stop.then(() => undefined, (error: unknown) => { if (error instanceof ArchiveLeftWork) return error; throw error; });
      await this.source.archived?.add(id);
      await this.forget(id);
      if (left) throw left;
    });
  }

  /**
   * The owner's archive of a job (the agents dialog's Archive, or Stop then Archive): the job's session is archived as before, and then what the
   * job owns is released through the same `endLeftovers` a deleted job gets, its default folder ~/scratch/<session id> and what its own
   * owned.json records name, with the processes that still use a path kept. On 10-20 the clean-room cancel of job "user history test run" at
   * 11:20:16Z archived it while its folder held a 0.6 GB export, and nothing released it, since only a deleted job's end and the deleted-jobs
   * sweep ran endLeftovers and the job ended "completed". Only a session under the session-artifacts folder of a chat this service owns counts,
   * and the release runs only while the session's own file still ends archived at or after this archive began, so a reopen (the chat's
   * "finish the task" at 11:20:49Z brought this job back) keeps its new work. The job is not marked ended, so its later delete releases again.
   * Only an archive the owner or the job's chat asked for (`by` "owner", with `asker`) records a cancel; a script's teardown that names a
   * service reason records none.
   */
  async archiveJob(id: string, by: ArchiveBy, asker: CancelBy = { by: "owner" }): Promise<void> {
    await this.load();
    if (by === "owner") await this.cancelJob(id, "archive", asker);
    const since = this.now();
    const sessionFile = await this.summary(id).then(summary => summary?.sessionFile, () => undefined);
    let archived = false;
    try { await this.threads.archive(id, by); archived = true; }
    catch (error) { if (error instanceof ScheduledJobsLeft) archived = true; throw error; }
    finally { if (archived && sessionFile) await this.releaseArchivedJob(id, sessionFile, since); }
  }

  private async releaseArchivedJob(id: string, sessionFile: string, since: number): Promise<void> {
    if (!sessionFile.startsWith(ARTIFACTS + "/") || !sessionFile.endsWith(`/${id}.jsonl`)) return;
    const chat = sessionFile.slice(ARTIFACTS.length + 1).split("/")[0]!;
    const dir = dirname(sessionFile);
    if (chat === id || !basename(dir).startsWith("sub-")) return;
    if (!this.chatIds.has(chat) && !(await this.mine([chat])).length) return;
    if (!this.chatIds.has(chat) && !(await this.archivedIds()).has(chat)) return;
    if (!(await endsArchivedSince(sessionFile, since))) { this.log(`chat ${chat.slice(0, 8)}: kept what archived job ${id.slice(0, 8)} owns: its session is no longer archived`); return; }
    if (!this.source.leftovers) return;
    const left = await this.source.leftovers(dir).catch(error => {
      this.log(`chat ${chat.slice(0, 8)}: leftovers of archived job ${id.slice(0, 8)}: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    });
    if (left && (left.stopped.length || left.tabs || left.copies.length || left.artifacts.length || left.owned.length || left.units.length || left.kept?.length))
      this.log(`chat ${chat.slice(0, 8)}: archived job ${id.slice(0, 8)} ended; stopped ${left.stopped.map(entry => entry.pid).join(", ") || "no process"}, closed ${left.tabs} Aside tabs${copiesNote(left)}`);
  }

  /**
   * A Stop or Archive of a thread that is not a chat, such as a job, by the owner or at its chat's request (`asker`), recorded as a cancel
   * (`<data dir>/job-cancels.json`) before the route aborts or archives it. Prime tells the parent "[child-exited: no-reply ...]" within milliseconds of the abort, and the parent's context
   * hook rewrites that notice to "stopped by the owner at HH:MM, don't reopen it" (`withCancelledNotices`). The failed-turn wakes, the job-end,
   * no-report and open-steps notices, the check-in's pushes and steers, the waiting-job restart and the resume pass skip the job until the owner
   * sends it a message or unarchives it (`reopenJob`). On 10-20 run7's Stop and Archive of job "user history test run" at 11:20:16Z reached the chat
   * as a plain exit, and its "You exited without a reply. Finish the task" reopened the job 34 s later. A record that cannot be written is logged
   * and the stop goes on. Null for a chat, or when no record is kept.
   */
  async cancelJob(id: string, how: JobCancel["how"], asker: CancelBy = { by: "owner" }): Promise<JobCancel | null> {
    const record = this.source.cancels;
    if (!record) return null;
    await this.load();
    if (this.chatIds.has(id) || (await this.archivedIds()).has(id)) return null;
    try {
      const sessionFile = await this.summary(id).then(summary => summary?.sessionFile, () => undefined);
      const cancel = await record.cancel(id, { ...asker, at: this.now(), how, ...sessionFile ? await jobPlace(sessionFile) : {} });
      this.log(`thread ${id.slice(0, 8)}: ${cancelWords(cancel)}; no recovery reopens it until the owner sends to it or unarchives it`);
      return cancel;
    } catch (error) {
      this.log(`thread ${id.slice(0, 8)}: the ${how} ${cancelAsker(asker)} asked for was not recorded as a cancel: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  /** The owner's send to a thread or his unarchive of it ends his cancel of it (`cancelJob`). */
  async reopenJob(id: string): Promise<void> {
    if (this.source.cancels && await this.source.cancels.reopen(id, this.now()).catch(() => false)) this.log(`thread ${id.slice(0, 8)}: the owner reopened it; his cancel no longer holds`);
  }

  /** The owner's cancel of the job session `session` while it holds; undefined when none holds or the record does not read. */
  private async cancelled(session: string | undefined): Promise<JobCancel | undefined> {
    if (!session || !this.source.cancels) return undefined;
    return this.source.cancels.holding(session).catch(() => undefined);
  }

  /** `cancelled` for a subagent of `chat`, by the session the hub or the daemon's list gives it. */
  private cancelledChild(chat: string, child: ChildAgent): Promise<JobCancel | undefined> {
    return this.cancelled(child.sessionId ?? this.subagents.get(chat)?.find(row => row.id === child.id)?.sessionId);
  }

  /** How many times the owner archived the chat since the service started; a send that began at another count stops before it goes. */
  archives(id: string): number { return this.archiveCounts.get(id) ?? 0; }

  /**
   * The owner's send to a chat he archived reopens it, the same way his unarchive does (10-18 run-2: the send was answered while the chat stayed
   * archived, and GET agents answered 404 "This thread is not a chat."). False when the owner did not archive it, or archived it again after the
   * send began (`archives` is no longer `since`).
   */
  reopen(id: string, since: number): Promise<boolean> {
    return this.membership(id, async () => {
      if (this.archives(id) !== since || !(await this.archivedIds()).has(id)) return false;
      const rearchivedSince = async (): Promise<boolean> => {
        if (this.archives(id) === since) return false;
        await this.threads.archive(id, "owner");
        return true;
      };
      await this.threads.unarchive(id);
      if (await rearchivedSince()) return false;
      await this.threads.resume(id).catch((error: unknown) => { if (this.archives(id) === since) throw error; });
      if (await rearchivedSince()) return false;
      const restored = await this.restore(id);
      return !(await rearchivedSince()) && restored;
    });
  }

  /**
   * Runs one chat's chat-list writes (archive, reopen) one at a time, in the order the owner's actions came in.
   */
  private membership<T>(id: string, task: () => Promise<T>): Promise<T> {
    const run = (this.membershipTail.get(id) ?? Promise.resolve()).then(task, task);
    const tail = run.then(() => {}, () => {});
    this.membershipTail.set(id, tail);
    void tail.then(() => { if (this.membershipTail.get(id) === tail) this.membershipTail.delete(id); });
    return run;
  }

  /** The chats the owner archived, for the sidebar rows: such a row stays archived while an agent message keeps its session live. */
  async archivedIds(): Promise<Set<string>> { return new Set(await this.source.archived?.ids() ?? []); }

  /**
   * Brings back chats the index lost (an unarchive outside this server, a lost index write): every recent unarchived thread whose session file
   * carries the chat_mode entry is restored and logged. A thread with messages found plain is not read again: the entry precedes the first message.
   */
  async rescan(): Promise<string[]> {
    if (this.source.owned) return [];
    await this.load();
    const now = this.now();
    let rows: readonly SessionRow[];
    try { rows = await this.source.rows(); }
    catch (error) { this.log(`chats: scan: ${error instanceof Error ? error.message : String(error)}`); return []; }
    const adopted: string[] = [];
    const stopped = new Set([...await this.archivedIds(), ...await this.source.cleanRoomChats?.ids() ?? []]);
    for (const row of rows) {
      if (this.chatIds.has(row.id) || this.plain.has(row.id) || row.archived || stopped.has(row.id)) continue;
      if (now - (Date.parse(row.lastActivityAt ?? row.created ?? "") || 0) > ADOPT_RECENT_MS) continue;
      // The rows and the records above may be minutes old by this row, so the check runs again in turn with the owner's archive: on 10-18 a
      // scan that waited on session copies from the Mac re-adopted plan-and-duties run-1's chat at 14:29:52Z, 1.5 min after its teardown archived it.
      const restored = await this.membership(row.id, async () => {
        const stop = await this.adoptStop(row.id);
        if (!stop) return this.restore(row.id);
        this.log(`chat ${row.id.slice(0, 8)}: not re-adopted: ${stop}`);
        return null;
      }).catch((error: unknown) => {
        this.log(`chat ${row.id.slice(0, 8)}: scan: ${error instanceof Error ? error.message : String(error)}`);
        return null;
      });
      if (restored) {
        adopted.push(row.id);
        this.log(`chat ${row.id.slice(0, 8)}: re-adopted: its session file has the chat_mode entry, the chat index did not`);
      } else if (restored === false && row.messageCount > 0) this.plain.add(row.id);
    }
    return adopted;
  }

  /**
   * Why the scan must not take a lost chat back, or null: the owner archived it, it is a clean-room test chat, or its file records the owner's
   * stop or archive after its last active state, which files it in archived-chats.json. Only the owner's unarchive or send (`restore`, `reopen`)
   * takes such a chat back. An archived session_state with no owner reason is no reason: the daemon's eviction and the Mac copy write it too,
   * and on 10-18 that rule kept the owner's chats Fable and the metal box owner out of the chat list.
   */
  private async adoptStop(id: string): Promise<string | null> {
    if ((await this.archivedIds()).has(id)) return "the owner archived it";
    if ((await this.source.cleanRoomChats?.ids() ?? []).includes(id)) return "it is a clean-room test chat";
    const sessionFile = (await this.summary(id))?.sessionFile;
    const stop = sessionFile && await fileHasChatMarker(sessionFile) ? await ownerStopSinceActive(sessionFile, await this.threads.serviceArchiveOf(id)) : null;
    if (!stop) return null;
    await this.source.archived?.add(id);
    return `its session file records the owner's stop (${stop}) after its last active state, so it is filed as archived`;
  }

  /**
   * Whether the archive route archives `id` as a chat: one in the index, one the owner archived, or a session whose file carries the chat_mode
   * entry that the index never took, such as a create whose service restarted before it answered (stray 01a157fb on 10-20). Such an archive
   * goes through `archive`, in turn with the scan, and archived-chats.json keeps the scan from taking it back.
   */
  async archivesAsChat(id: string): Promise<boolean> {
    if ((await this.ids()).has(id) || (await this.archivedIds()).has(id)) return true;
    if (!(await this.mine([id])).length) return false;
    const sessionFile = await this.summary(id).then(summary => summary?.sessionFile, () => undefined);
    return sessionFile !== undefined && await fileHasChatMarker(sessionFile);
  }

  /**
   * After an unarchive: a session whose file carries the chat_mode entry is a chat again, back in the index, pinned, with steering `all`. False for a
   * plain thread. Steering resumes the session; a failure there is logged, since the pin resumes it again and the attach re-applies steering.
   * The owner's unarchive (the route) and the scan call it; the scan skips the chats the owner archived, so only the owner takes one back.
   */
  async restore(id: string): Promise<boolean> {
    await this.load();
    if (!(await this.mine([id])).length) return false;
    await this.source.archived?.forget(id);
    const sessionFile = (await this.summary(id))?.sessionFile;
    if (!sessionFile || !(await fileHasChatMarker(sessionFile))) return false;
    await this.index.add(id);
    this.chatIds.add(id);
    this.leadChats();
    this.threads.pin(id);
    try { await this.threads.setSteeringMode(id, "all"); }
    catch (error) { this.log(`chat ${id.slice(0, 8)}: ${error instanceof Error ? error.message : String(error)}`); }
    return true;
  }

  async forget(id: string): Promise<void> {
    this.threads.unpin(id);
    this.children.delete(id);
    this.reloadWaiting.delete(id);
    this.forced.delete(id);
    this.chatIds.delete(id);
    this.leadChats();
    await this.index.forget(id);
    await this.loads.forget(id);
    await this.source.memory.forget(id);
    await this.source.heldNotices?.forget(id);
  }

  /** The owner's settings, or none when the file cannot be read (logged): every chat then runs at the default interval. */
  private async settings(): Promise<Record<string, CheckInSetting>> {
    try { return await this.source.settings.all(); }
    catch (error) { this.log(`check-in settings: ${error instanceof Error ? error.message : String(error)}`); return {}; }
  }

  /**
   * Whether each chat's plan has an open step, read before a wake queues anything: the hub's board while it holds the chat, else the file view,
   * which parses a board again only once its file changed. A board that cannot be read counts as open, so its chat keeps its own interval.
   */
  private async plansOpen(ids: Iterable<string>): Promise<Map<string, boolean>> {
    return new Map(await Promise.all([...ids].map(async id => {
      const state = this.threads.state?.(id);
      const board = state?.board !== undefined ? Promise.resolve(state.board) : (this.source.boardView ?? this.source.board).call(this.source, id);
      return [id, await board.then(planHasOpenStep, () => true)] as const;
    })));
  }

  /** The chats whose check-in the owner paused now (`ownerPause`): their threads are parked by him, so a check-in asks them for nothing. */
  private async ownerPaused(now: number): Promise<Set<string>> {
    const settings = await this.settings();
    return new Set(Object.entries(settings).filter(([id, setting]) => this.chatIds.has(id) && activePause(setting, now) !== null && ownerPause(setting)).map(([id]) => id));
  }

  /**
   * One scheduler wake: queues the check-in of every chat whose interval has passed since its last one and that is not paused; the time is
   * taken before the run is queued, so a second wake in the same slot does not queue it again. Every chat the owner has not paused is also
   * checked for a failed last turn (`revive`), and so are its jobs (`jobs`); a wake that follows a sleep restarts every transient failure at
   * once. A pause by the chat itself stops only check-ins: on 10-12 a pause of 7 chats from 13:35Z on would have held their failed
   * turns until the resume. A check-in runs in its own lane (`checkInLane`), so a revive never waits behind a check-in
   * whose duty job start hangs: on 10-11 from 20:35Z to 10-12 01:42Z no chat got a revive or a check-in while the hub attached sessions in
   * under 0.3 s, and 4 chats aborted by the 19:08Z Prime update sat 0.5 to 7.7 h (unretried_errors, dead_hours). Every ADOPT_SCAN_MS the
   * session files are scanned for chats the index lost. Returns the ids checked in.
   */
  async tick(): Promise<string[]> {
    await this.load();
    const settings = await this.settings();
    const open = await this.plansOpen(this.chatIds);
    const now = this.now();
    const woke = wokeFromSleep(this.lastTick, now);
    if (woke) this.log(`chats: woke after ${Math.round((now - this.lastTick!) / 1000)} s; transient failures restart now`);
    this.lastTick = now;
    if (woke) this.wokeAt = now;
    if (now - this.lastScan >= ADOPT_SCAN_MS) { this.lastScan = now; this.queue("#scan", async () => { await this.rescan(); }); }
    const due: string[] = [];
    const active = new Set<string>();
    for (const id of this.chatIds) {
      if (this.children.has(id) && now - (this.cleanedAt.get(id) ?? -Infinity) >= JOB_CLEANUP_EVERY_MS) { this.cleanedAt.set(id, now); this.queue(id, () => this.cleanJobs(id)); }
      const setting = planCheckIn(settings[id] ?? DEFAULT_CHECK_IN, open.get(id) ?? true);
      const paused = activePause(setting, now) !== null;
      if (paused && ownerPause(setting)) continue;
      active.add(id);
      if (!this.reviving.has(id)) { this.reviving.add(id); this.queue(id, () => this.revive(id, woke).finally(() => this.reviving.delete(id))); }
      const lastAt = this.lastCheckIn.get(id) ?? now - setting.everyMs;
      if (paused) continue;
      // A chat with no check-in on record is due now, not one interval after this service started: every release restart pushed ops guy's
      // 2 h check-in back again (10-12: none from 10-10 11:33Z on, with its owner pause lifted at 05:28Z).
      const next = nextCheckIn(setting, lastAt, now);
      if (next === null || next > now) continue;
      due.push(id);
      this.lastCheckIn.set(id, now);
      this.queue(checkInLane(id), async () => { await this.checkIn(id); });
    }
    for (const id of this.reloadWaiting) if (!this.threads.running(id)) this.queue(id, () => this.refreshExtension(id));
    this.queue("#jobs", () => this.jobs(active, woke));
    if (this.source.heldNotices) this.queue("#held", () => this.releaseHeld());
    if (now - this.deletedSweptAt >= JOB_CLEANUP_EVERY_MS) { this.deletedSweptAt = now; this.queue("#deleted", () => this.sweepDeleted()); }
    if (!this.ticked) {
      this.ticked = true;
      const started = this.now();
      void (async () => {
        await this.syncing.get("#jobs");
        await this.syncing.get("#interrupted");
        this.ready = true;
        this.log(`chats: first pass ended ${Math.round((this.now() - started) / 1000)} s after the first tick`);
      })();
    }
    return due;
  }

  /**
   * Hands the open steps a reported job still owns to the chat (`handBack`), deletes each finished job of a chat (`finishedJobs`) once, with
   * one log line, so its Python kernel and session stop holding memory, and ends each job whose only open work is a board wait
   * (`waitingJobs`) with its state saved on the step (`parkJob`). A board that cannot be read deletes nothing; a failed delete is logged and
   * not tried again in this serve. A job the daemon deleted, or one the chat no longer holds (`not_held`), goes on the deleted job record,
   * so a restart does not try it again while the daemon still lists it.
   */
  private async cleanJobs(id: string): Promise<void> {
    await this.load();
    // The hub reports every thread it attaches, and a serve on its own chats opens live chats too (a profile serve read 01a14d31 on 10-18).
    if (!this.chatIds.has(id)) return;
    const children = this.children.get(id);
    if (!children?.length) return;
    let board: ChatBoard | null;
    try { board = await this.source.board(id); }
    catch (error) { this.log(`chat ${id.slice(0, 8)}: job cleanup: ${error instanceof Error ? error.message : String(error)}`); return; }
    const record = this.source.deletedJobs;
    const listed = children.map(child => child.id);
    const gone = await record?.gone(id, listed).catch(error => {
      this.log(`chat ${id.slice(0, 8)}: job cleanup: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    });
    if (record && !gone) return;
    const now = this.now();
    const messages = this.messages(id) ?? [];
    const said = lastJobMessages(messages);
    if (this.source.resumes) {
      let handed = false;
      for (const { child, steps } of handBackSteps(children, board, said)) if (!gone?.has(child.id)) handed = await this.handBack(id, child, steps) || handed;
      if (handed) board = await this.source.board(id).catch(() => board);
    }
    // A job the update's prepare drained reads finished or quiet before its restore resumes it, so none is deleted or ended while one runs.
    const finished = finishedJobs(children, board, said);
    const waiting = this.source.resumes ? waitingJobs(children, board, now, said) : [];
    if ((finished.length || waiting.length) && await this.updateHold("job is deleted or ended")) return;
    for (const child of finished) {
      if (gone?.has(child.id)) continue;
      const result = await this.deleteJob(id, child, listed, now);
      if (result === "deleted") this.log(`chat ${id.slice(0, 8)}: deleted finished job ${childName(child)} (reported, quiet ${Math.round((now - child.lastActivityAt!) / 60_000)} min, no open step)`);
    }
    for (const { child, steps } of waiting) if (!gone?.has(child.id)) await this.parkJob(id, child, steps, jobReport(messages, childName(child)), listed, now, board?.todos ?? []);
  }

  /**
   * Deletes one job of the chat unless it works: the hub's view of it is read again first, then the daemon's state of its session (a tool call
   * such as `ci-run-status --wait`, or a background bash its kernel waits on, keeps it), and the daemon refuses a job that streams or holds
   * an unfinished action in the same request (`running`), so a job that started a turn since the cleanup read its children is kept and looked
   * at again later. A delete that fails is tried again at the next sweep: on 10-14 at 12:3xZ the daemon answered neither of Crawler VP's census
   * write cuts and live route parity fixes within 30 s, and the job id stayed in `deletedJobs` until the next service start. The session comes
   * from the hub's child or the daemon's list, and a job with neither is kept while the service reads wakes: slack green guy 10-15 11:07Z, the
   * hub's children carry no session id, so the sweep skipped the wake check and deleted blog signup fix, asleep on a 10-22 board.wake for p143.
   */
  private async deleteJob(id: string, child: ChildAgent, listed: readonly string[], now: number): Promise<SubagentDelete | "kept"> {
    const current = this.children.get(id)?.find(candidate => candidate.id === child.id);
    if (this.deletedJobs.has(child.id) || !current || childWorking(current)) return "kept";
    const sessionId = current.sessionId ?? this.subagents.get(id)?.find(row => row.id === child.id)?.sessionId;
    if (sessionId === undefined && this.source.waking) {
      this.log(`chat ${id.slice(0, 8)}: kept job ${childName(child)}: the daemon's list has not given its session yet, so its board.wakes cannot be read`);
      return "kept";
    }
    this.deletedJobs.add(child.id);
    try {
      const busy = await this.jobBusy(id, current, sessionId);
      if (busy !== undefined) {
        this.deletedJobs.delete(child.id);
        this.log(`chat ${id.slice(0, 8)}: kept job ${childName(child)}: ${busy}`);
        return "kept";
      }
      const result = await this.threads.deleteSubagent(id, child.id);
      if (result === "running") {
        this.deletedJobs.delete(child.id);
        this.log(`chat ${id.slice(0, 8)}: kept job ${childName(child)}: the daemon shows it running`);
        return result;
      }
      await this.endLeftovers(id, childName(child), join(ARTIFACTS, id, child.id), sessionId, "was deleted.");
      await this.source.deletedJobs?.add(id, child.id, now, listed);
      if (result === "not_held") this.log(`chat ${id.slice(0, 8)}: finished job ${childName(child)} is no longer a subagent of the chat (the daemon still lists its session); recorded, not tried again`);
      return result;
    } catch (error) {
      this.deletedJobs.delete(child.id);
      this.log(`chat ${id.slice(0, 8)}: delete job ${childName(child)}: ${error instanceof Error ? error.message : String(error)}; tried again at the next sweep`);
      return "kept";
    }
  }

  /**
   * Why a job that ended its turn is still at work, or undefined when nothing under it works: a board.wake of its session or of one under it, a
   * subagent at work under it (`jobLive`), a turn it is owed (`jobHeld`), or the daemon showing its session or one under it in a turn, a tool
   * call or a background bash. A job that ends its turn while its subagents work waits for their replies: metal-management 10-18, crawler lanes
   * to box sent "Step landed: ..." at 06:53:20Z and ended its turn waiting on crawl-deploy and crawl-verify, and the cleanup deleted it at
   * 06:53:57Z and cut both mid tool call.
   */
  private async jobBusy(id: string, child: ChildAgent, sessionId: string | undefined): Promise<string | undefined> {
    if (sessionId !== undefined && await this.source.waking?.(sessionId)) return "it waits on a board.wake";
    if (await this.jobLive(id, sessionId !== undefined ? { ...child, sessionId } : child)) return "a session under it waits on a board.wake or a subagent under it works";
    if (sessionId === undefined) return undefined;
    const held = await this.jobHeld(child, sessionId);
    if (held !== undefined) return held;
    if (await this.threads.sessionActive(sessionId)) return "its session runs a tool call or a background bash";
    for (const session of this.treeBelow(sessionId)) if (await this.threads.sessionActive(session)) return "a subagent under it runs a turn, a tool call or a background bash";
    return undefined;
  }

  /**
   * Why a quiet job is owed a turn that nothing shows as work yet, or undefined: a message for it or a session under it that went through its
   * parent after its last activity (`relayed`), a cut turn the resume pass gives back (`held`), a tree pi-pool holds until its pool time, or a
   * quota park Prime resumes by itself. mac-management 10-21 and 10-22: the cleanup ended metal agent queue at 20:50Z and 01:47Z after its
   * wakes went through the parked chat at 20:16Z and 01:16Z, and 5180 into the real app at 21:50Z, seconds after its wake went the same way,
   * and at 01:57Z while pi-pool held its tree until 02:01:30Z. Each delete cut its subagents, and the chat's relays then met "No child matches".
   */
  private async jobHeld(child: ChildAgent, sessionId: string): Promise<string | undefined> {
    const now = this.now();
    const sessions = [sessionId, ...this.treeBelow(sessionId)];
    const rows = [...this.subagents.values()].flat();
    const ranAt = (session: string): number => session === sessionId ? child.lastActivityAt ?? 0 : rows.find(row => row.sessionId === session)?.lastActivityAt ?? 0;
    const turns = await this.source.held?.(now).catch(() => undefined);
    const pool = this.heldJobs.sessions();
    for (const session of sessions) {
      const whose = session === sessionId ? "its" : "a subagent's";
      const relayedAt = await this.source.relayed?.at(session).catch(() => undefined);
      if (relayedAt !== undefined && relayedAt > ranAt(session))
        return `a message for ${session === sessionId ? "it" : "a subagent under it"} went through its parent at ${new Date(relayedAt).toISOString().slice(11, 19)}Z, and that session has not run since`;
      if (turns?.sessions.has(session)) return `the resume pass gives back ${whose} cut turn`;
      if (pool.has(session)) return `pi-pool holds ${whose} tree until its pool time`;
      const file = await this.summary(session).then(summary => summary?.sessionFile, () => undefined);
      const parked = file ? await readQuotaPark(file, now).catch(() => null) : null;
      if (parked !== null) return `Prime parks ${whose} turn on its provider quota until ${new Date(parked).toISOString().slice(11, 16)}Z`;
    }
    return undefined;
  }

  /** Every session the daemon lists at any depth under `session`. */
  private treeBelow(session: string): string[] {
    const found: string[] = [];
    const seen = new Set([session]);
    for (let index = -1; index < found.length; index++) {
      for (const below of this.below(index < 0 ? session : found[index]!)) if (!seen.has(below)) { seen.add(below); found.push(below); }
    }
    return found;
  }

  /**
   * Hands the open steps a reported job still owns (`handBackSteps`) to the chat: the chat gets one turn to close or continue them
   * (`handBackText`), then each step's job becomes the chat and its note names the job. The steer goes first, so a steer that fails leaves the
   * steps on the job for the next sweep: metal-management 10-18 06:46Z, the steer for p11 failed with "Daemon is preparing an update restart"
   * after the board write, and p11 became the chat's without the chat being told. The note keeps the job named, so it is kept and later saved on the
   * step (`parkJob`) unless the chat steers it. A job still at work (`jobBusy`), one whose last turn parked with no reply (`endsParked`), or one
   * whose wakes cannot be read yet, keeps its steps.
   */
  private async handBack(id: string, child: ChildAgent, steps: readonly PlanItem[]): Promise<boolean> {
    const name = childName(child);
    try {
      const sessionId = child.sessionId ?? this.subagents.get(id)?.find(row => row.id === child.id)?.sessionId;
      if (this.source.waking && sessionId === undefined) return false;
      if (await this.jobBusy(id, child, sessionId) !== undefined) return false;
      // A job whose last turn parked on a quota or pool wait with no reply has not reported, so it keeps its steps (`endsParked`).
      const file = sessionId !== undefined ? await this.summary(sessionId).then(summary => summary?.sessionFile, () => undefined) : undefined;
      if (file && await readEndsParked(file).catch(() => false)) return false;
      const line = handBackNote(name, child.lastActivityAt ?? this.now());
      await this.tell(id, JOB_NOTICE_PREFIX + handBackText(child, steps));
      await this.source.resumes!.applyBoard(id, steps.map(step => ({ op: "plan_update", id: step.id, job: id,
        note: [line, step.note].filter(Boolean).join("\n") })));
      this.log(`chat ${id.slice(0, 8)}: handed ${steps.map(step => step.id).join(", ")} back to the chat: job ${name} reported with them open`);
      return true;
    } catch (error) {
      this.log(`chat ${id.slice(0, 8)}: hand back the steps of ${name}: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  /**
   * Ends a quiet job that open steps name (`waitingJobs`): its brief (`jobBrief`), last report and the steps' waits are saved first
   * (`<data dir>/job-resumes`), then the job is deleted, then a fresh root job starts at once from the saved state (`resumeBrief`) and owns
   * each step that no correction parks and no open For you todo holds, and each step's note names the saved state. A step whose fresh job
   * could not start keeps only the note, and the check-in's line for it (`classLine`) tells the chat to spawn one. A job whose brief cannot
   * be read is kept.
   */
  private async parkJob(id: string, child: ChildAgent, steps: readonly PlanItem[], report: string, listed: readonly string[], now: number,
    todos: readonly OwnerTodo[]): Promise<void> {
    const resumes = this.source.resumes!;
    const name = childName(child);
    const cancel = await this.cancelledChild(id, child);
    if (cancel) { this.log(`chat ${id.slice(0, 8)}: kept waiting job ${name} as it is: ${cancelWords(cancel)}, so no fresh job takes its steps`); return; }
    try {
      const sessionFile = (await this.summary(id))?.sessionFile;
      const childDir = sessionFile ? join(artifactsDir(sessionFile), child.id) : undefined;
      const brief = childDir ? await jobBrief(childDir) : undefined;
      if (brief === undefined || childDir === undefined) { this.log(`chat ${id.slice(0, 8)}: kept waiting job ${name}: its brief could not be read`); return; }
      const event = steps.map(waitText).join("; ");
      const owed = steps.filter(step => parkedBy(step) === undefined && !heldByTodo(step, todos));
      const model = await jobModel(childDir);
      const resume = { chat: id, childId: child.id, job: name, steps: owed.map(step => step.id), event: owed.map(waitText).join("; "), brief, report, endedAt: now,
        ...model ? { model } : {} };
      const saved = { ...resume, steps: steps.map(step => step.id), event };
      const path = await resumes.store.save(saved);
      if (await this.deleteJob(id, child, listed, now) !== "deleted") return;
      const live = owed.length ? await this.liveCopy(id, child) : undefined;
      const fresh = live ?? (owed.length && resumes.restart ? await resumes.restart(id, resumeJobName(name, now), chat => resumeBrief(resume, path, chat, now), model)
        .catch(error => { this.log(`chat ${id.slice(0, 8)}: resume waiting job ${name}: ${error instanceof Error ? error.message : String(error)}`); return undefined; }) : undefined);
      if (fresh && !live) await resumes.store.save({ ...saved, resumed: { id: fresh.id, name: fresh.name } })
        .catch(error => this.log(`chat ${id.slice(0, 8)}: saved state of ${name}: ${error instanceof Error ? error.message : String(error)}`));
      const line = savedStateNote(name, now, path);
      await resumes.applyBoard(id, steps.map(step => {
        const taken = fresh !== undefined && owed.includes(step);
        return { op: "plan_update", id: step.id, ...taken ? { job: fresh.name, sessionId: fresh.id } : {},
          note: [line, taken ? (live ? keptCopyNote(fresh.name, now) : resumedNote(fresh.name, now)) : undefined, step.note].filter(Boolean).join("\n") };
      }));
      this.log(`chat ${id.slice(0, 8)}: ended waiting job ${name} (quiet ${Math.round((now - child.lastActivityAt!) / 60_000)} min, ${event}); saved state ${path}` +
        (live ? `; started no copy, since ${live.name} (${live.id}) still carries it: ${live.why}; it takes ${owed.map(step => step.id).join(", ")}`
          : fresh ? `; started ${fresh.name} (${fresh.id.slice(0, 8)}) for ${owed.map(step => step.id).join(", ")}` : ""));
    } catch (error) { this.log(`chat ${id.slice(0, 8)}: end waiting job ${name}: ${error instanceof Error ? error.message : String(error)}`); }
  }

  /**
   * Another session of the chat on any box that carries the same job as `child` (`jobBase` of its name), and works or is owed a turn
   * (`jobBusy`), so the cleanup starts no copy for it. The chat's row lists its subagents and roots on every box; the hub's children add the
   * subagents it holds. mac-management 10-22: the cleanup started "metal agent queue resumed 10:47" at 01:47Z and "5180 into the real app
   * resumed 10:57" at 01:57Z while the copies "resumed 05:50" (01a1603b) and "resumed 06:50" (01a16071) were parked on the Claude limit, and
   * the new copies sat parked or queued for pi-pool slots beside them.
   */
  private async liveCopy(id: string, child: ChildAgent): Promise<{ id: string; name: string; why: string } | undefined> {
    const base = jobBase(childName(child));
    const own = child.sessionId ?? this.subagents.get(id)?.find(row => row.id === child.id)?.sessionId;
    const rows = await this.source.rows().catch(() => [] as SessionRow[]);
    const archived = new Set(rows.flatMap(row => row.archived ? [row.id] : []));
    const agents = rows.find(row => row.id === id)?.agents ?? [];
    const candidates = new Map<string, ChildAgent>();
    for (const other of this.children.get(id) ?? []) {
      const session = other.sessionId ?? this.subagents.get(id)?.find(row => row.id === other.id)?.sessionId;
      if (session !== undefined) candidates.set(session, { ...other, sessionId: session });
    }
    for (const agent of agents) {
      if (agent.sessionId === undefined || candidates.has(agent.sessionId)) continue;
      const at = Date.parse(agent.lastActivityAt ?? "");
      candidates.set(agent.sessionId, { id: agent.childId ?? agent.sessionId, label: agent.sender, sessionName: agent.sender, sessionId: agent.sessionId,
        status: agent.state === "working" ? "running" : agent.state === "failed" ? "error" : "done", ...Number.isFinite(at) ? { lastActivityAt: at } : {} });
    }
    for (const [session, other] of candidates) {
      if (session === own || other.id === child.id || other.status === "cancelled" || archived.has(session) || jobBase(childName(other)) !== base) continue;
      const why = childWorking(other) ? "it works" : await this.jobBusy(id, other, session);
      if (why !== undefined) return { id: session, name: childName(other), why };
    }
    return undefined;
  }

  /**
   * The roots the cleanup started from a saved state (`parkJob`) whose steps now name another worker of the chat, its own subagent or another
   * root of it, while no step names the root (`replacedJob`). A step that names a worker below the root itself keeps the root.
   */
  private async replacedRoots(chatRows: readonly SessionRow[]): Promise<{ chat: string; id: string; name: string; steps: string[]; by: string[] }[]> {
    const store = this.source.resumes?.store;
    if (!store) return [];
    const found: { chat: string; id: string; name: string; steps: string[]; by: string[] }[] = [];
    for (const row of chatRows) {
      const agents = row.agents ?? [];
      const roots = agents.filter(agent => agent.link === "root" && agent.sessionId !== undefined && !this.chatIds.has(agent.sessionId));
      if (!roots.length) continue;
      const board = await this.source.board(row.id).catch(() => null);
      if (!board) continue;
      for (const { resume } of await store.list(row.id).catch(() => [])) {
        const job = replacedJob(resume, board.plan);
        if (!job) continue;
        const root = roots.find(agent => agent.sessionId === job.id);
        if (!root) continue;
        const moved = job.steps.filter(step => step.sessionId !== undefined && step.sessionId !== root.sessionId &&
          agents.some(agent => agent.sessionId === step.sessionId && (agent.link === "subagent" || agent.link === "root")));
        if (moved.length) found.push({ chat: row.id, id: root.sessionId!, name: root.name, steps: moved.map(step => step.id), by: moved.map(step => step.job) });
      }
    }
    return found;
  }

  /**
   * The Prime update preparing or restoring this box's daemon now (`updating`), or null. While one runs, a session the prepare drained reads
   * idle before its restore resumes it, so no retirement path archives, deletes or ends a job then. `what` names the path in its one log line
   * per update.
   */
  private async updateHold(what: string): Promise<PrimeUpdate | null> {
    const update = await this.source.updating?.().catch(() => null) ?? null;
    if (update && this.heldFor.get(what) !== update.requestId) {
      this.heldFor.set(what, update.requestId);
      this.log(`chats: Prime update ${update.requestId} is ${update.phase}; no ${what} until it ends`);
    }
    return update;
  }

  /**
   * Archives a root whose steps now name other workers (`replacedRoots`) once it runs no turn and waits on no board.wake, on that root's queue
   * key, so the resume pass and the failed-turn wake never continue it and its leftovers end. Archived once per serve; an archived one is left
   * as it is. None is archived while a Prime update prepares or restores (`updateHold`): on 10-23 at 23:06:50Z, 30 s into the prepare of update
   * 793302-1792796780311 on us-metal02, the sweep archived "crawler prod deploy resumed 13:31" (01a16707-1c9d), which the update's plan had
   * recorded as streaming with an accepted prompt in flight and shouldResume true. The prepare had drained its turn, so it read idle; the update
   * listed it under stoppedBeforeRestore with reason unknown and never resumed it, and its board.wake for run 40036134910 reopened it at 23:30:21Z.
   */
  private async retireReplaced(job: { chat: string; id: string; name: string; steps: string[]; by: string[] }): Promise<void> {
    if (this.retired.has(job.id)) return;
    await new Promise<void>(resolve => this.queue(job.id, async () => {
      try {
        if ((await this.summary(job.id))?.lifecycle === "archived") { this.retired.add(job.id); return; }
        if (await this.updateHold("replaced root is archived")) return;
        if (await this.source.waking?.(job.id) || await this.threads.sessionActive(job.id)) return;
        await this.threads.archive(job.id, "replaced_job_end");
        this.retired.add(job.id);
        const left = await this.leftovers(job.chat, join(ARTIFACTS, job.id), job.id);
        this.log(`chat ${job.chat.slice(0, 8)}: archived replaced root ${job.name} instead of resuming it: ${job.steps.join(", ")} now name ${[...new Set(job.by)].join(", ")}; ` +
          `stopped ${left.stopped.map(entry => entry.pid).join(", ") || "no process"}, closed ${left.tabs} Aside tabs${copiesNote(left)}`);
      } catch (error) {
        this.log(`chat ${job.chat.slice(0, 8)}: archive replaced root ${job.name}: ${error instanceof Error ? error.message : String(error)}; tried again at the next sweep`);
      } finally { resolve(); }
    }));
  }

  /**
   * The sessions that own an open step of these chats, by the step's stored session id or a linked thread that lists the step, less the
   * chats. The resume pass looks at each one even with no worker or archived (resume_paused.py --owners): on
   * 10-15 a worker stop, a SIGTERM of every worker and the owner's stop each left a frontend bro step owner cut, and none was resumed.
   * A step with open children counts too: on 10-23 Crawler VP's p689 (doing, with p935 open under it) named instagram posts search resumed
   * 06:42, which the idle unload stopped at 22:01:51Z in its pi-pool wait for 22:02Z, and the pass read it as owed no work until a check-in
   * restarted it at 23:48Z, so d7 read a tree parked 106 min while later trees got accounts.
   */
  private async stepOwners(chatRows: readonly SessionRow[]): Promise<Set<string>> {
    const owners = new Set<string>();
    for (const row of chatRows) {
      const board = await this.source.board(row.id).catch(() => null);
      const open = new Set<string>();
      walk(board?.plan ?? [], item => {
        if (!OPEN.has(item.status)) return;
        open.add(item.id);
        if (item.sessionId) owners.add(item.sessionId);
      });
      for (const agent of row.agents ?? []) if (agent.sessionId && agent.steps.some(step => open.has(step))) owners.add(agent.sessionId);
    }
    for (const id of owners) if (this.chatIds.has(id)) owners.delete(id);
    return owners;
  }

  /**
   * The pass over interrupted jobs runs `inMs` from now, at the next tick after that, instead of up to JOB_CLEANUP_EVERY_MS later, and never
   * later than it was due. A new daemon supervisor (a Prime update or a restart) cut the turns it stopped and passes SUPERVISOR_RESUME_MS; a
   * cut job the catalog just read (`resumesNow`) passes 0, and so does a held job whose tree pi-pool admits at its pool time (`PoolHeldJobs`).
   * census writer speed, cut by the 06:46:02Z update on 10-18, waited 29 min.
   */
  interruptedSoon(inMs = SUPERVISOR_RESUME_MS): void {
    this.rootsSweptAt = Math.min(this.rootsSweptAt, this.now() - JOB_CLEANUP_EVERY_MS + inMs);
  }

  /**
   * The jobs of the chats, from the catalog rows: tells `awake` whether any chat or job works, and looks at each subagent and create_session
   * root of a chat that is not paused for a turn that ended in a transient failure (`wakeJob`). A job is read again only when its activity
   * changed since it was last found fine, or while a failure of it waits for its wake.
   */
  private async jobs(active: ReadonlySet<string>, woke: boolean): Promise<void> {
    let rows: readonly SessionRow[];
    try { rows = await this.source.rows(); }
    catch (error) { this.log(`chats: jobs: ${error instanceof Error ? error.message : String(error)}`); return; }
    const chatRows = rows.filter(row => this.chatIds.has(row.id));
    this.refreshJobs(chatRows);
    if (this.now() - this.rootsEndedAt >= ROOT_END_EVERY_MS) {
      this.rootsEndedAt = this.now();
      for (const row of chatRows) if (active.has(row.id)) this.queue(row.id, () => this.endRoots(row));
    }
    if ((await this.heldJobs.admitted(this.now())).length) this.interruptedSoon(0);
    // A pass waiting behind a running one already covers every cut seen since: one run per pass at most stays queued, however many jobs are cut.
    if (this.now() - this.rootsSweptAt >= JOB_CLEANUP_EVERY_MS && !this.passWaits) {
      this.rootsSweptAt = this.now();
      if (this.source.interrupted || this.source.resumes) {
        const resume = this.source.interrupted;
        const swept = chatRows.filter(row => active.has(row.id));
        this.passWaits = true;
        this.queue("#interrupted", async () => {
          this.passWaits = false;
          // A failed read retires nothing this pass and keeps the last set; it never stops the pass or the service.
          const replaced = await this.replacedRoots(swept).catch(error => {
            this.log(`chats: replaced roots: ${error instanceof Error ? error.message : String(error)}`);
            return null;
          });
          if (replaced) {
            this.replaced = new Set(replaced.map(job => job.id));
            for (const job of replaced) await this.retireReplaced(job);
          }
          if (!resume) return;
          const hidden = new Set(await this.mine([...await this.archivedIds()]).catch(() => []));
          await resumeChatJobs(swept, this.chatIds, resume, line => this.log(line), await this.stepOwners(swept), this.heldJobs, hidden, this.replaced);
        });
      }
    }
    this.source.awake?.(chatRows.some(row => row.working || (row.agents ?? []).some(agent => agent.state === "working")));
    await (this.quietRead ??= this.readQuiet());
    const now = this.now();
    const threads = new Set<string>();
    for (const row of chatRows) {
      if (!active.has(row.id)) continue;
      for (const agent of row.agents ?? []) {
        const threadId = agent.sessionId;
        if (!threadId || (agent.link !== "subagent" && agent.link !== "root") || this.chatIds.has(threadId) || threads.has(threadId) || this.replaced.has(threadId)) continue;
        threads.add(threadId);
        const stamp = agent.lastActivityAt ?? "";
        if (agent.state === "working" || now - (Date.parse(stamp) || 0) > JOB_WAKE_WINDOW_MS) { this.jobQuiet.delete(threadId); this.jobWakes.delete(threadId); continue; }
        if (this.jobGone.get(threadId) === stamp || (!this.jobWakes.has(threadId) && this.jobQuiet.get(threadId) === stamp)) continue;
        this.queue(threadId, () => this.wakeJob(threadId, stamp, woke, { chat: row.id, agent }));
      }
    }
    for (const threadId of this.jobThreads) if (!threads.has(threadId)) { this.jobQuiet.delete(threadId); this.jobWakes.delete(threadId); this.jobGone.delete(threadId); }
    this.jobThreads = threads;
    this.keepQuiet();
  }

  private async readQuiet(): Promise<void> {
    const kept = await this.source.quietJobs?.read().catch(error => { this.log(`chats: quiet jobs: ${error instanceof Error ? error.message : String(error)}`); return null; });
    for (const [threadId, stamp] of kept ?? []) if (!this.jobQuiet.has(threadId)) this.jobQuiet.set(threadId, stamp);
  }

  /** Writes `jobQuiet` to `quietJobs` QUIET_WRITE_MS after a change, once for every change in that time. */
  private keepQuiet(): void {
    const record = this.source.quietJobs;
    if (!record || this.quietWrite) return;
    this.quietWrite = setTimeout(() => {
      this.quietWrite = undefined;
      void record.write(new Map(this.jobQuiet)).catch(error => this.log(`chats: quiet jobs: ${error instanceof Error ? error.message : String(error)}`));
    }, QUIET_WRITE_MS);
    this.quietWrite.unref();
  }

  /**
   * The extension build of each job of a chat (a subagent or a create_session root), kept the way `refreshExtension` keeps a chat's: a job
   * that last loaded an older build than the one on disk, or that already ran when this service first looked, is reloaded once it runs
   * nothing, one job at a time; a job that shows up later started on this build. A working job is looked at again on a later tick. A job that
   * ended its task (`done`) is not reloaded: a reload rebuilds its Python kernel, and at the 10-14 07:12Z service start 70 kernels (4.3 GB)
   * came back within 60 s of their job's reload, 13 of them in finished jobs. It is looked at again once its state changes; a message to it
   * runs on the build it loaded, and after the daemon passivates it, the next message hydrates it on the build on disk.
   */
  private refreshJobs(chatRows: readonly SessionRow[]): void {
    const first = this.jobsSeen === undefined;
    const seen = this.jobsSeen ??= new Set();
    for (const row of chatRows) {
      const said = lastJobMessages(this.messages(row.id) ?? []);
      for (const agent of row.agents ?? []) {
        const id = agent.sessionId;
        if (!id || (agent.link !== "subagent" && agent.link !== "root") || this.chatIds.has(id) || this.jobsCurrent.has(id)) continue;
        const fresh = !first && !seen.has(id);
        seen.add(id);
        if (agent.state === "done" || reportedRoot(agent, said) || (agent.state === "working" && !fresh)) continue;
        // On the job's key too: at 11:14:12Z on 10-19 the reload of 01a152c0 closed it while its wake check was opening it ("Active session
        // 01a152c0-... is closing"). "#reload" still runs one reload at a time.
        this.queue("#reload", () => new Promise<void>(resolve => this.queue(id, () => this.refreshJob(id, fresh, row.id).finally(resolve))));
      }
    }
  }

  /**
   * Ends each create_session root of a chat that reported and has been quiet PARK_IDLE_MS while no open step names it (`idleRoots`): its brief,
   * last report and the chat it reports to are saved in `<data dir>/job-resumes`, then it is archived, so its worker ends, and the chat gets a
   * notice naming the file. A root is its own worker: on 10-14 at 12:39Z 8 roots idle with their reports in held 2.81 GB. Never a
   * chat, a duty run (the duty code archives those), a root that waits on a board.wake, or one the daemon shows in a turn, a tool call or a
   * background bash at the moment of the archive. A root the daemon lists as archived is skipped: it keeps its row under the chat, so before,
   * each service start archived it again and sent a second notice (10-14 17:50Z: stale tree guard land, vp worker heap fix and harness
   * footprint fix, archived 16:03Z to 17:15Z, were archived again at 17:50Z, a minute after the 17:49Z start, each with a second notice).
   * Each root's archive runs on that root's queue key: on 10-18 at 16:35:25Z, the first tick after a service restart, it ran beside the wake
   * check of "repo prod secrets move" and closed the session while the check was attaching to it ("Daemon session closed during attach").
   * No root ends while a Prime update restores the daemon's sessions (`updating`), as no duty job does: on 10-21 at 11:19:39Z to 11:19:40Z,
   * during update 723509-1792581529564, the sweep archived 4 roots that were mid-turn when the update began (shouldResume true) and read idle
   * before their restore. The daemon refused each saved archive, the update listed all 4 under stoppedBeforeRestore with reason unknown, and
   * none was resumed.
   */
  private async endRoots(row: SessionRow): Promise<void> {
    const resumes = this.source.resumes;
    if (!resumes) return;
    let board: ChatBoard | null;
    try { board = await this.source.board(row.id); }
    catch (error) { this.log(`chat ${row.id.slice(0, 8)}: root cleanup: ${error instanceof Error ? error.message : String(error)}`); return; }
    const messages = this.messages(row.id) ?? [];
    const duty = new Set(await this.source.dutyJobs?.(row.id).catch(() => []) ?? []);
    const now = this.now();
    for (const agent of idleRoots(row.agents ?? [], board, lastJobMessages(messages))) {
      const id = agent.sessionId!;
      if (this.chatIds.has(id) || duty.has(id) || (this.rootsEnded.has(id) && this.rootsEnded.get(id) === agent.lastActivityAt)) continue;
      this.rootsEnded.set(id, agent.lastActivityAt);
      await new Promise<void>(resolve => this.queue(id, async () => {
        try {
          const summary = await this.summary(id);
          if (summary?.lifecycle === "archived") return;
          if (await this.source.waking?.(id) || await this.threads.sessionActive(id)) { this.rootsEnded.delete(id); return; }
          if (await this.updateHold("idle root is archived")) { this.rootsEnded.delete(id); return; }
          const sessionFile = summary?.sessionFile;
          const brief = sessionFile ? await sessionBrief(sessionFile) : undefined;
          if (brief === undefined) { this.log(`chat ${row.id.slice(0, 8)}: kept root ${agent.name}: its brief could not be read`); return; }
          const quiet = Math.round((now - Date.parse(agent.lastActivityAt!)) / 60_000);
          const model = sessionFile ? await sessionModel(sessionFile) : undefined;
          const path = await resumes.store.save({ chat: row.id, childId: id, job: agent.sender, steps: [], event: "no open step names it", brief,
            report: jobReport(messages, agent.sender), endedAt: now, ...model ? { model } : {} });
          await this.threads.archive(id, "idle_root_end");
          const left = await this.leftovers(row.id, join(ARTIFACTS, id), id);
          this.log(`chat ${row.id.slice(0, 8)}: archived idle root ${agent.name} (quiet ${quiet} min); saved state ${path}; stopped ${left.stopped.map(entry => entry.pid).join(", ") || "no process"}, closed ${left.tabs} Aside tabs${copiesNote(left)}`);
        } catch (error) {
          this.rootsEnded.delete(id);
          this.log(`chat ${row.id.slice(0, 8)}: archive idle root ${agent.name}: ${error instanceof Error ? error.message : String(error)}; tried again at the next sweep`);
        } finally { resolve(); }
      }));
    }
  }

  /**
   * A duty job is never reloaded: its run ends with an archive, and 10-18 at 12:30:36Z the reload of check-in AI harness developer environment
   * 21:27 met the stop of that archive, queued 15 s before, and the daemon refused it with "Daemon worker client closed".
   */
  private async refreshJob(id: string, fresh: boolean, chat: string): Promise<void> {
    if (this.jobsCurrent.has(id)) return;
    try {
      const loaded = await this.loads.get(id);
      if (!(loaded === undefined && fresh) && reloadAction(loaded, this.build, false) === "reload") {
        if ((await this.source.dutyJobs?.(chat).catch((): readonly string[] => []))?.includes(id)) { this.jobsCurrent.add(id); return; }
        const result = await this.threads.reloadIdle(id);
        if (result === "busy") return;
        if (result === "reloaded") this.log(`job ${id.slice(0, 8)}: extension reloaded, build ${this.build}`);
      }
      if (loaded !== this.build) await this.loads.set(id, this.build);
      this.jobsCurrent.add(id);
    } catch (error) {
      this.log(`job ${id.slice(0, 8)}: reload: ${error instanceof Error ? error.message : String(error)}`);
      if (threadGone(error)) { this.jobsCurrent.add(id); await this.loads.forget(id).catch(() => {}); }
    }
  }

  /**
   * A job whose last turn ended in a transient failure is woken the way the owner did it by hand: abort when a provider retry holds it, a
   * `continue` steer, resume the queue. Once per failure, on the TRANSIENT_RETRY_BACKOFF_MS schedule, and at once after a sleep. Any other bad
   * end goes to `jobEndNote`; the wake runs first, so a job it revives gets no note.
   */
  private async wakeJob(threadId: string, stamp: string, woke: boolean, job?: ChatJob): Promise<void> {
    const now = this.now();
    if (await this.cancelled(threadId)) { this.jobWakes.delete(threadId); this.jobQuiet.set(threadId, stamp); this.keepQuiet(); return; }
    try {
      const state = await this.threads.view(threadId);
      const stall = state ? turnStall(turnViewOf(state, this.threads.running(threadId)), now) : null;
      const last = this.jobWakes.get(threadId);
      const action = jobWake({ stall, last, woke, now });
      if (action === "none") {
        this.jobWakes.delete(threadId);
        this.jobQuiet.set(threadId, stamp);
        this.keepQuiet();
        if (job && state && jobEnd(state.messages)) this.queue(job.chat, () => this.jobEndNote(threadId, job));
        return;
      }
      this.jobQuiet.delete(threadId);
      if (action === "wait") { if (!last) this.jobWakes.set(threadId, { failureAt: Number.NaN, attempts: 0, at: stall!.at }); return; }
      const attempts = woke ? 1 : (last?.attempts ?? 0) + 1;
      this.jobWakes.set(threadId, { failureAt: stall!.at, attempts, at: now });
      await this.threads.restart(threadId, "continue", stall!.retrying);
      this.log(`job ${threadId.slice(0, 8)}: last turn failed (${stall!.error}); woke it${woke ? " after a sleep" : ""}, try ${attempts}`);
    } catch (error) {
      const gone = threadGone(error);
      if (gone) { this.jobGone.set(threadId, stamp); this.jobWakes.delete(threadId); this.jobQuiet.delete(threadId); }
      this.log(`job ${threadId.slice(0, 8)}: ${gone ? "gone, not woken again" : "wake"}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Stops what a gone job left (`CheckInSource.leftovers`) once per session; nothing when the stop fails, which is logged. */
  private async leftovers(chat: string, dir: string, session?: string): Promise<Leftovers> {
    const none = { stopped: [], tabs: 0, copies: [], artifacts: [], owned: [], units: [] };
    if (!this.source.leftovers || (session !== undefined && this.leftoversEnded.has(session))) return none;
    if (session !== undefined) this.leftoversEnded.add(session);
    return this.source.leftovers(dir, session).catch(error => {
      this.log(`chat ${chat.slice(0, 8)}: leftovers of ${dir}: ${error instanceof Error ? error.message : String(error)}`);
      return none;
    });
  }

  /** Stops what a gone job left and logs it. */
  private async endLeftovers(chat: string, name: string, dir: string, session: string | undefined, what: string): Promise<void> {
    const left = await this.leftovers(chat, dir, session);
    if (!left.stopped.length && !left.tabs && !left.copies.length && !left.artifacts.length && !left.owned.length && !left.units.length && !left.kept?.length && !left.containers?.length) return;
    this.log(`chat ${chat.slice(0, 8)}: job ${name} ${what.replace(/\.$/, "")}; stopped ${left.stopped.map(entry => entry.pid).join(", ") || "no process"}, closed ${left.tabs} Aside tabs${copiesNote(left)}`);
  }

  /**
   * Each JOB_CLEANUP_EVERY_MS: stops what the subagents the daemon marked deleted under each chat left (`deletedFolders`), the jobs a chat
   * deleted itself included, and logs it. A job the chat deletes stays in the daemon's list, so the roster cannot tell it is gone. The chats the
   * owner archived are swept too, read from their session folders only and never opened: on 10-19 chat-057a (01a14210), archived at 05:31:26Z,
   * went on running jobs, and the tree, rig unit and detached process of its deleted job stayed because the sweep read only the live chats.
   */
  private async sweepDeleted(): Promise<void> {
    if (!this.source.deletedLeftovers) return;
    const archived = new Set(await this.mine([...await this.archivedIds()]).catch(() => []));
    for (const id of new Set([...this.chatIds, ...archived])) {
      const name = `chat ${id.slice(0, 8)}${this.chatIds.has(id) ? "" : " (archived)"}`;
      const left: Leftovers = await this.source.deletedLeftovers(id).catch(error => {
        this.log(`${name}: deleted job leftovers: ${error instanceof Error ? error.message : String(error)}`);
        return { stopped: [], tabs: 0, copies: [], artifacts: [], owned: [], units: [] };
      });
      if (left.stopped.length || left.tabs || left.copies.length || left.artifacts.length || left.owned.length || left.units.length || left.kept?.length || left.containers?.length) this.log(`${name}: deleted jobs ended; stopped ${left.stopped.map(entry => entry.pid).join(", ") || "no process"}, closed ${left.tabs} Aside tabs${copiesNote(left)}`);
    }
  }

  private messages(id: string): readonly ThreadMessage[] | undefined { return this.threads.state?.(id)?.messages; }

  /** The stall of a chat's last turn as the hub holds it: a failure with nothing running, or a provider retry holding the turn after one. */
  private stall(id: string): Stall | null {
    const state = this.threads.state?.(id);
    return state ? turnStall(turnViewOf(state, this.threads.running(id)), this.now()) : null;
  }

  private async claude(): Promise<ClaudeState | null> {
    return this.source.claude ? this.source.claude().catch(() => null) : null;
  }

  private async revive(id: string, woke = false): Promise<void> {
    if (!this.chatIds.has(id)) return;
    const state = this.threads.state?.(id);
    if (!state) return;
    const view = turnViewOf(state, this.threads.running(id));
    const now = this.now();
    const quiet = this.threads.quietSince?.(id) ?? null;
    // A restart that brought no event yet counts as one, so a daemon that does not answer gets one restart per HUNG_TURN_MS, not one per wake.
    const from = Math.max(this.wokeAt, this.hungRestarts.get(id) ?? -Infinity);
    if (quiet !== null && hungTurn(quiet, from, now)) {
      const since = Math.max(quiet, from);
      this.hungRestarts.set(id, now);
      try {
        await this.threads.restart(id, hungMessage(since, now), true);
        this.log(`chat ${id.slice(0, 8)}: turn hung ${Math.round((now - since) / 60_000)} min with no session event; stopped it and started a new turn`);
      } catch (error) { this.log(`chat ${id.slice(0, 8)}: hung turn restart: ${error instanceof Error ? error.message : String(error)}`); }
      return;
    }
    // A turn that runs with no retry ends any wait the feed shows; a pool wait inside the turn reads as retrying and goes on below.
    if (view.running && !view.retrying) { this.threads.setWait(id, null); return; }
    const stall = turnStall(view, now);
    if (!stall) {
      this.revivals.delete(id);
      this.stallSeen.delete(id);
      this.threads.setWait(id, null);
      return;
    }
    const provider = state.info?.model?.provider ?? null;
    const claude = provider === "anthropic" ? await this.claude() : null;
    const down = claudeDown(stall.error, provider, claude);
    const seen = this.stallSeen.get(id) ?? now;
    this.stallSeen.set(id, seen);
    // After a sleep a transient failure starts its schedule over.
    const last = woke && failureCause(stall.error) === "transient" ? undefined : this.revivals.get(id);
    // A chat the hub holds no attach for runs no provider retry of Prime's: the idle unload stopped it asleep in one, or a service start left it
    // detached. A failure the pool decides then waits for pi-pool to admit its tree (`stallAction`, `stopped`).
    const stopped = this.threads.isLive?.(id) === false && provider !== null && (pooledProviders as readonly string[]).includes(provider) &&
      !stall.aborted && failureCause(stall.error) !== "other";
    // A chat is its tree's root, so the pool is asked about the chat's own id, for a stopped chat and for a hold with input waiting behind it.
    const admits = (stopped || (stall.queued > 0 && stall.slotAt !== undefined && stall.slotAt > now)) && provider !== null && this.source.poolAdmits
      ? await this.source.poolAdmits(id, provider).catch(() => false) : false;
    const action = stallAction({ stall, down, claude, attempts: last?.attempts ?? 0, since: last?.at ?? Math.min(stall.at, seen), now, woke, admits, stopped });
    if (action.kind !== "restart") { this.threads.setWait(id, action.kind === "wait" ? action.wait : null); return; }
    const attempts = (last?.attempts ?? 0) + 1;
    this.revivals.set(id, { attempts, at: now });
    this.threads.setWait(id, null);
    try {
      await this.threads.restart(id, action.message, action.abort);
      this.log(`chat ${id.slice(0, 8)}: last turn failed (${stall.error}); started a new turn, try ${attempts}${woke ? " after a sleep" : ""}`);
    } catch (error) {
      this.log(`chat ${id.slice(0, 8)}: restart: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * A thread that owns an open step, whose last turn failed and that still holds queued input (an owner message, a job report), is woken the
   * way the owner did it by hand: abort, a `continue` steer, resume the queue. Again on the RETRY_BACKOFF_MS schedule while it stays stranded.
   */
  private async wakeOwner(threadId: string): Promise<void> {
    if (this.chatIds.has(threadId) || await this.cancelled(threadId)) return;
    const now = this.now();
    const last = this.ownerWakes.get(threadId);
    if (last && !retryDue(last.attempts - 1, last.at, now)) return;
    try {
      const state = await this.threads.view(threadId);
      const stall = state ? turnStall(turnViewOf(state, this.threads.running(threadId)), now) : null;
      if (!strandedInput(stall, now)) { this.ownerWakes.delete(threadId); return; }
      // A job's transient failure is woken by `wakeJob` on its faster schedule.
      if (this.jobThreads.has(threadId) && failureCause(stall!.error) === "transient") return;
      this.ownerWakes.set(threadId, { attempts: (last?.attempts ?? 0) + 1, at: now });
      await this.threads.restart(threadId, "continue", true);
      this.log(`thread ${threadId.slice(0, 8)}: last turn failed (${stall!.error}) with ${stall!.queued} queued; woke it`);
    } catch (error) {
      this.log(`thread ${threadId.slice(0, 8)}: wake: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * After the owner changes a thread's model or account: a stalled turn goes again now, on the new choice. A chat restarts its turn (quoting
   * the owner's message when the owner started it); a plain thread only gets its provider retry stopped and its queued input resumed, so the
   * next send runs at once. A no-op for a thread whose last turn ended well.
   */
  async retryNow(id: string): Promise<void> {
    await this.load();
    const chat = this.chatIds.has(id);
    await new Promise<void>(resolve => this.queue(id, async () => {
      try {
        const state = chat ? this.threads.state?.(id) : await this.threads.view(id);
        if (!state) return;
        const view = turnViewOf(state, this.threads.running(id));
        if (view.running && !view.retrying) return;
        const stall = turnStall(view, this.now());
        if (!stall) return;
        if (chat) {
          this.revivals.set(id, { attempts: 1, at: this.now() });
          this.threads.setWait(id, null);
          await this.threads.restart(id, revivalMessage(stall), stall.retrying);
          this.log(`chat ${id.slice(0, 8)}: the owner changed its model or account; started a new turn`);
        } else if (stall.retrying || stall.queued > 0) {
          await this.threads.abort(id);
          await this.threads.resumeQueue(id);
        }
      } catch (error) {
        this.log(`thread ${id.slice(0, 8)}: retry after a change: ${error instanceof Error ? error.message : String(error)}`);
      } finally { resolve(); }
    }));
  }

  /** A chat's check-in as it runs, with the daily interval while its plan has no open step (`planCheckIn`). */
  private state(id: string, own: CheckInSetting, planOpen: boolean, now: number): CheckInView {
    const setting = planCheckIn(own, planOpen);
    const pausedUntil = activePause(setting, now);
    const lastAt = this.lastCheckIn.get(id) ?? null;
    return { everyMs: setting.everyMs, ...(setting !== own ? { planEveryMs: own.everyMs } : {}), paused: pausedUntil !== null,
      nextAt: nextCheckIn(setting, lastAt ?? now - setting.everyMs, now), pausedUntil, lastAt };
  }

  /**
   * What `chatAgents` needs from the chat side for one chat: the hub's child snapshots, the board (the hub's copy while attached, else the file),
   * the roots the registry lists under the chat's id and each of its names, and the transcript the hub holds. Empty for a thread that is not a
   * chat. `name` is the catalog's title of the chat: the hub knows a name only while it holds the chat, and a root filed before 10-18 has no
   * chatId, so on 10-15 the roots filed under a detached chat's name fell back to step links.
   */
  async links(id: string, name?: string): Promise<ChatLinks> {
    await this.load();
    if (!this.chatIds.has(id)) return { children: [], board: null, roots: [], messages: [] };
    const state = this.threads.state?.(id);
    const board = state?.board !== undefined ? state.board : await (this.source.boardView ?? this.source.board).call(this.source, id).catch(() => null);
    const keys = [...new Set([id, state?.info?.name?.trim(), name?.trim()].filter((key): key is string => !!key))];
    const roots = this.source.registry ? await this.source.registry.rootsOf(keys).catch(() => []) : [];
    return { children: this.children.get(id) ?? state?.children ?? [], board, roots, messages: state?.messages ?? [] };
  }

  /** The sessions stream's check-in field for every chat. */
  async checkIns(): Promise<ReadonlyMap<string, CheckInState>> {
    await this.load();
    const settings = await this.settings();
    const open = await this.plansOpen(this.chatIds);
    const now = this.now();
    return new Map([...this.chatIds].map(id => {
      const { lastAt: _lastAt, ...state } = this.state(id, settings[id] ?? DEFAULT_CHECK_IN, open.get(id) ?? true, now);
      return [id, state];
    }));
  }

  /** A chat's check-in as the owner's control shows it; null for a thread that is not a chat. */
  /** The sessions of the cut jobs pi-pool holds, from the last interrupted pass (`PoolHeldJobs.sessions`). */
  poolHeldSessions(): ReadonlySet<string> { return this.heldJobs.sessions(); }

  async checkInView(id: string): Promise<CheckInView | null> {
    await this.load();
    if (!this.chatIds.has(id)) return null;
    const setting = await this.source.settings.get(id);
    return this.state(id, setting, (await this.plansOpen([id])).get(id) ?? true, this.now());
  }

  /**
   * A change to a chat's check-in by the owner's page or an agent; null for a thread that is not a chat, CheckInRefused when an agent changes a
   * pause it may not. The scheduler reads the new setting at its next wake.
   */
  async setCheckIn(id: string, change: CheckInChange, actor: CheckInActor): Promise<CheckInView | null> {
    await this.load();
    if (!this.chatIds.has(id)) return null;
    const now = this.now();
    let refused: string | undefined;
    const setting = await this.source.settings.update(id, current => {
      const result = changeCheckIn(current, change, now, actor);
      if ("refused" in result) { refused = result.refused; return current; }
      return result.setting;
    });
    if (refused) throw new CheckInRefused(`check-in refused: ${refused}`);
    return this.state(id, setting, (await this.plansOpen([id])).get(id) ?? true, now);
  }

  /**
   * One check-in run for a chat (Chats.tick at its interval, or the owner's Run now): the precheck in code (`checkInPrecheck`: each step's
   * class, the misses against the duty's targets), kept as the new memory, then handed to the duty runner, which starts one check-in job with
   * it as context (src/chat-duty-run.ts). Every run with something to check starts a job, met targets included; the job decides what needs
   * work. A chat with no job at work, no open plan step, no board read error and no ask overflow has nothing to check. A rerun names the cut
   * run it reruns (`rerunOf`).
   */
  async checkIn(id: string, trigger: CheckInRun["trigger"] = "schedule", rerunOf?: number): Promise<void> {
    await this.load();
    if (!this.chatIds.has(id)) return;
    try {
      const gathered = await this.gather(id);
      const { board, boardError, rows, facts } = gathered;
      // With no catalog rows yet and no hub children, every job of the chat reads as missing (frontend bro 10-13 01:09 and 01:24, while the
      // daemon's list timed out after restarts: 7 false orphans each, and the duty runner skipped both runs anyway).
      if (!rows.length && !this.children.has(id)) {
        this.log(`chat ${id.slice(0, 8)}: check-in waits: the catalog has no rows yet and the hub has not attached the chat, so its jobs cannot be read`);
        const everyMs = (await this.source.settings.get(id)).everyMs;
        if (everyMs > CHECK_IN_RETRY_MS) this.lastCheckIn.set(id, this.now() - everyMs + CHECK_IN_RETRY_MS);
        return;
      }
      const paused = await this.ownerPaused(this.now());
      for (const fact of facts) {
        if (fact.state === "failed" && fact.key.startsWith("thread:") && !paused.has(fact.key.slice("thread:".length))) this.queue(fact.key, () => this.wakeOwner(fact.key.slice("thread:".length)));
      }
      if (!checkInDue(facts, board, boardError)) {
        this.log(`chat ${id.slice(0, 8)}: check-in: nothing to check (no job at work, no open plan step, no board error)`);
        await this.source.duty?.checkInClean?.(id, this.now(), trigger);
        return;
      }
      const at = this.now();
      const everyMs = (await this.source.settings.get(id)).everyMs;
      const previous = await this.source.memory.get(id);
      const { precheck, output } = await this.measure(id, gathered, previous, everyMs, at);
      // A job at work an hour with no report gets one status ask through the chat; the check-in job cannot message the chat's subagents.
      const said = this.stall(id) ? undefined : this.messages(id);
      for (const ask of said ? statusAsks(said, facts, key => this.workingSince.get(key), at) : []) {
        await this.tell(id, ask).catch(error => this.log(`chat ${id.slice(0, 8)}: status ask: ${error instanceof Error ? error.message : String(error)}`));
      }
      // A job whose screens render on 5180 while the owner has no link to them gets one line to the chat (c124, frontend bro 10-19).
      for (const line of said ? owedLinkLines(said, facts, board?.todos ?? []) : []) {
        await this.tell(id, line).catch(error => this.log(`chat ${id.slice(0, 8)}: owed link: ${error instanceof Error ? error.message : String(error)}`));
      }
      // A finding with a sig that a started check-in job already got, unchanged since, goes out no more (`unsentFindings`).
      const flagged = unsentFindings(previous?.sent, output.flagged);
      const flags = flagStreaks(previous?.flags, flagged);
      const [unsent, sentNow] = [false, true].map(started => sentAfter(previous?.sent, output.flagged, started));
      const sent = (next: Record<string, string>) => Object.keys(next).length ? { sent: next } : {};
      await this.source.memory.set(id, { ...precheck.memory, flags, ...sent(unsent!) });
      const pushed = await this.pushJobs(id, precheck.jobs, gathered.sessions ?? new Map());
      const start = await this.source.duty?.checkIn(id, { at, trigger, everyMs, output: { ...output, flagged }, classes: classCounts(precheck.steps),
        findings: checkInPrecheckText(precheck, facts, flagged, at, flags), prompt: checkInPrompt(precheck, pushed), ...checkInIdle(precheck, pushed) ? { idle: true as const } : {}, ...rerunOf === undefined ? {} : { rerunOf } });
      if (start === "failed" && everyMs > CHECK_IN_RETRY_MS) this.lastCheckIn.set(id, at - everyMs + CHECK_IN_RETRY_MS);
      // A check-in that did not start sent no goal push, so its retry pushes again (quietPush).
      if (start === "failed") await this.source.memory.set(id, { ...precheck.memory, flags, ...sent(unsent!), goals: unpushed(precheck.memory.goals, previous?.goals, at) });
      if (start === "started" && JSON.stringify(sentNow) !== JSON.stringify(unsent)) await this.source.memory.set(id, { ...precheck.memory, flags, ...sent(sentNow!) });
    } catch (error) {
      this.log(`chat ${id.slice(0, 8)}: check-in: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Nudges or restarts each job the precheck found with no progress (`jobPushes`): a nudge is a steer into its session, a restart starts a new
   * turn with the same message (`jobPushMessage`). Then the chat gets one line saying which jobs were pushed (`jobPushLine`), which the check-in
   * prompt repeats. A failed request leaves delivery unknown; the chat checks the existing job before retrying it.
   */
  private async pushJobs(chat: string, all: readonly JobPush[], sessions: ReadonlyMap<string, string>): Promise<string | null> {
    const failed = new Set<string>();
    const sessionOf = (push: JobPush) => push.fact.key.startsWith("thread:") ? push.fact.key.slice("thread:".length) : sessions.get(push.fact.key) ?? push.fact.sessionId;
    const pushes: JobPush[] = [];
    for (const push of all) {
      const cancel = await this.cancelled(sessionOf(push));
      if (cancel) this.log(`chat ${chat.slice(0, 8)}: check-in left job ${push.fact.name} alone: ${cancelWords(cancel)}`);
      else pushes.push(push);
    }
    for (const push of pushes) {
      const session = sessionOf(push);
      try {
        if (!session) throw new Error("no session id");
        if (push.act === "restart") await this.threads.restart(session, jobPushMessage(push), true);
        else await this.threads.prompt(session, { message: jobPushMessage(push), images: [], mode: "steer" });
        this.log(`chat ${chat.slice(0, 8)}: check-in ${push.act === "restart" ? "restarted" : "nudged"} job ${push.fact.name}: ${push.why}`);
      } catch (error) {
        failed.add(push.fact.key);
        this.log(`chat ${chat.slice(0, 8)}: check-in could not ${push.act} job ${push.fact.name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const line = jobPushLine(pushes, failed);
    if (line) await this.tell(chat, CHECK_IN_PREFIX + line)
      .catch(error => this.log(`chat ${chat.slice(0, 8)}: check-in job line: ${error instanceof Error ? error.message : String(error)}`));
    return line;
  }

  /**
   * Delivers a check-in job's message to a job of its chat (`scripts/job-steer.ts`, `POST api/threads/<chat>/job-steer`). A chat's jobs are its
   * subagents, which a check-in job, a root, cannot reach with agent_message (slack green guy 10-16: "No sibling matches"), so the server
   * sends it the way `pushJobs` does: a steer into the job's session, or a restart with the message when its last turn ended in an error.
   * The job is named by its name or its session id. A board step's stored session id names its job's session when the hub and the catalog do
   * not: on 10-16 at 07:5xZ the daemon's list timed out, the catalog had no rows, and "blog reader demo" got a 404 by name and by its session
   * id though step p146 held both. A job whose session the server cannot reach gets the message through its chat (`relay`). Null for a thread
   * that is not a chat; `jobs` lists the chat's job names when none matches. A job asleep on a board.wake, a time or a CI run, gets the message
   * at once and its wake stays as a later backstop: on 10-18 VP of CI's check-in told "repo design count" to attack p75 at 12:00Z and the message
   * waited in its wake note for 19:50Z, 7.5 h away.
   */
  async steerJob(chat: string, job: string, message: string): Promise<{ session: string; act: "steer" | "restart" | "relay" } | { jobs: string[] } | { cancelled: string } |
    { otherChat: string } | null> {
    await this.load();
    if (!this.chatIds.has(chat)) return null;
    // The daemon's list can time out for minutes after a restart (502 at 08:2xZ on 10-16), so the board alone then names the job's session.
    const gathered = await this.gather(chat).catch(error => { this.log(`chat ${chat.slice(0, 8)}: job steer reads only the board: ${error instanceof Error ? error.message : String(error)}`); return null; });
    const board = gathered ? gathered.board : await this.source.board(chat).catch(() => null);
    const facts = gathered?.facts ?? [];
    const sessions = gathered?.sessions;
    const wanted = job.trim().toLowerCase();
    const stepSessions = new Map<string, string>();
    walk(board?.plan ?? [], item => { const name = planJob(item.job)?.trim().toLowerCase(); if (name && item.sessionId) stepSessions.set(name, item.sessionId); });
    const sessionOf = (fact: JobFact): string | undefined => fact.key.startsWith("thread:") ? fact.key.slice("thread:".length) :
      sessions?.get(fact.key) ?? fact.sessionId ?? stepSessions.get(fact.name.trim().toLowerCase());
    const fact = facts.find(candidate => candidate.name.trim().toLowerCase() === wanted || sessionOf(candidate) === job.trim());
    const session = fact ? sessionOf(fact) : stepSessions.get(wanted) ?? [...stepSessions.values()].find(id => id === job.trim());
    if (!session) return { jobs: facts.map(candidate => candidate.name) };
    // Another chat that owns a step on this board is no job of this chat, and this chat's goals and words are not its own: on 10-23 at 16:25Z
    // VP of CI's check-in steered the AI harness chat with VP of CI's p1 goal, because p342 under p1 named that chat.
    if (session !== chat && (this.chatIds.has(session) || (await this.archivedIds()).has(session))) return { otherChat: fact?.name ?? job.trim() };
    const cancel = await this.cancelled(session);
    if (cancel) {
      this.log(`chat ${chat.slice(0, 8)}: check-in job's message for job ${fact?.name ?? job.trim()} not sent: ${cancelWords(cancel)}`);
      return { cancelled: `${fact?.name ?? job.trim()} was ${cancelWords(cancel)}. ${cancelPurpose(cancel)}, so nothing reopens it; don't start a copy of it.` };
    }
    // A job waiting for an account slot still ahead gets the message as a steer, which waits in its turn: a restart now starts a turn the pool
    // refuses again. Past the slot a steer would sit in a stopped queue, as on 10-18 until the owner's 20:56Z hand fix, so it restarts.
    const slot = fact && poolWait(fact) ? poolSlot(fact.error ?? "") : null;
    const waitsForSlot = slot !== null && slot > this.now();
    const act = fact && !waitsForSlot && (fact.state === "failed" || (fact.state === "ended" && fact.error !== undefined)) ? "restart" : "steer";
    const name = fact?.name ?? job.trim();
    try {
      if (act === "restart") await this.threads.restart(session, CHECK_IN_PREFIX + message, true);
      else await this.threads.prompt(session, { message: CHECK_IN_PREFIX + message, images: [], mode: "steer" });
    } catch (error) {
      // A finished subagent the daemon no longer lists takes no prompt from the server ("blog reader demo" 10-16 08:2xZ), but its chat can message it.
      if ((error as { status?: unknown }).status !== 404 || session === chat) throw error;
      await this.tell(chat, `${CHECK_IN_PREFIX}The server cannot reach your job "${name}", so send it this with ` +
        `agent_message.send(text, receiver_role="child", receiver_name=${JSON.stringify(name)}): ${message}`);
      this.log(`chat ${chat.slice(0, 8)}: check-in job's message for job ${name} went through the chat: ${error instanceof Error ? error.message : String(error)}`);
      return { session: chat, act: "relay" };
    }
    this.log(`chat ${chat.slice(0, 8)}: check-in job ${act === "restart" ? "restarted" : "steered"} job ${name}`);
    return { session, act };
  }

  /**
   * The check-in measure as a run would take it now, for a run's after-job measure: the same precheck over the board, the jobs and the last
   * run's memory, with none of a run's side effects (no memory write, no status ask, no owner wake). Null for a thread that is not a chat, or
   * while the catalog has no rows and the hub has not attached the chat, when every job reads as missing.
   */
  async measureCheckIn(id: string): Promise<CheckInRun["output"] | null> {
    await this.load();
    if (!this.chatIds.has(id)) return null;
    const gathered = await this.gather(id);
    if (!gathered.rows.length && !this.children.has(id)) return null;
    const everyMs = (await this.source.settings.get(id)).everyMs;
    return (await this.measure(id, gathered, await this.source.memory.get(id), everyMs, this.now())).output;
  }

  /** One check-in measure from what `gather` read: the precheck and its misses against the check-in duty's targets. */
  private async measure(id: string, { board, boardError, rows, facts, queued, asleep, wakes, name }: Gathered, previous: CheckInMemory | undefined, everyMs: number, at: number) {
    const self = name ? [id, name] : [id];
    const duties = await this.source.duties?.(id).catch(error => { this.log(`chat ${id.slice(0, 8)}: check-in duties: ${error instanceof Error ? error.message : String(error)}`); return undefined; });
    const jobs = this.source.registry ? await this.source.registry.rootsOf(self).catch(() => []) : [];
    const heartbeats = readHeartbeats(heartbeatsFile(id, this.source.home));
    const train = await readTrain(trainFile(this.source.home));
    const carried = await landCarries(board?.plan ?? [], wakes, train, trainRepo(this.source.home));
    const doneFacts = await this.doneFacts(id, board, rows);
    const read = (chat: string) => (this.source.boardView ?? this.source.board).call(this.source, chat);
    const hosts = await this.hostHolds(id, rows);
    const precheck = checkInPrecheck(previous, facts, board ? await withBoardLinks(board, id, read) : board, at,
      { self, rows, ...await this.ledger(id), everyMs, doneFacts, ...(duties ? { duties } : {}), jobs, subagents: this.subagents, heartbeats, queued, asleep, wakes, carried, ...(train ? { train } : {}), ...(boardError !== undefined ? { boardError } : {}),
        ...(hosts ? { hosts } : {}),
        paused: await this.ownerPaused(at),
        owner: ownerSaid(this.messages(id) ?? []) });
    return { precheck, output: convergenceMisses(id, precheck.steps, precheck, await this.source.memory.ends(id), everyMs, at) };
  }

  /**
   * The chat's box and each offline box its catalog rows run on, with the open For you todo on any of the owner's chats that asks him to bring
   * it back (`hostHolds`); undefined while every box reads online. sep launch!!'s and Railway Breach's jobs on the sleeping MacBook Pro read
   * as 41 stuck steps on 10-23 while For you t96 on the AI harness chat asked the owner to wake it.
   */
  private async hostHolds(id: string, rows: readonly SessionRow[]): Promise<CheckInContext["hosts"]> {
    const away = this.source.hostAway;
    if (!away) return undefined;
    const names = [...new Set(rows.flatMap(row => row.host ? [row.host] : []))];
    const offline = (await Promise.all(names.map(name => away(name).catch(() => null)))).filter((host): host is AwayHost => host !== null);
    if (!offline.length) return undefined;
    const read = (chat: string) => (this.source.boardView ?? this.source.board).call(this.source, chat).catch(() => null);
    const todos = (await Promise.all([...this.chatIds].map(async chat => ((await read(chat))?.todos ?? []).map(todo => ({ chat, todo }))))).flat();
    const chatHost = rows.find(row => row.id === id)?.host;
    return { ...chatHost ? { chatHost } : {}, held: hostHolds(offline, todos) };
  }

  /** What a check-in reads: the board (or why it cannot be read), the catalog rows, the chat's name, and its jobs with their last messages. */
  private async gather(id: string): Promise<Gathered> {
    let board: ChatBoard | null = null;
    let boardError: string | undefined;
    try { board = await this.source.board(id); }
    catch (error) { boardError = error instanceof Error ? error.message : String(error); this.log(`chat ${id.slice(0, 8)}: check-in board: ${boardError}`); }
    const rows = await this.source.rows();
    const said = lastJobMessages(this.messages(id) ?? []);
    // A chat not attached on this serve has no hub children; its row lists the daemon's sessions under it. A step's owner may be a subagent of
    // one of its duty jobs (10-13 02:39: busy chat inbox ran under the 01:54 check-in job, and p334 read "(busy chat inbox not found)").
    const dutyJobs = await this.source.dutyJobs?.(id).catch(() => []) ?? [];
    // A job that ended its turn on a board.wake the service still owes is at work until the wake is due (`withWakes`), unless the wake is a
    // dead wait on a run that ended (`deadWakes`).
    const owed = await this.source.wakes?.(this.now()).catch(error => { this.log(`chat ${id.slice(0, 8)}: check-in wakes: ${error instanceof Error ? error.message : String(error)}`); return []; }) ?? [];
    const { live: wakes, dead } = deadWakes(owed, await readTrain(trainFile(this.source.home)), this.now());
    const children = withLiveRoster(this.children.get(id) ?? agentChildren(rows.find(row => row.id === id)?.agents ?? []), this.subagents.get(id) ?? [], wakes, this.below);
    const nested = nestedJobs(dutyJobs, children, this.subagents);
    const sessions = new Map([...this.subagents.values()].flat().concat(children, nested).flatMap(child => child.sessionId ? [[child.id, child.sessionId] as const] : []));
    const asleep = new Set(wakes.map(wake => wake.session));
    const live = liveJobs([...children, ...nested], this.subagents, this.now(), liveWindowMs((await this.source.settings.get(id)).everyMs), asleep);
    // A cut owner the resume pass continues is the service's to give back (`readHeldTurns`).
    const held = await this.source.held?.(this.now()).catch(error => { this.log(`chat ${id.slice(0, 8)}: check-in held turns: ${error instanceof Error ? error.message : String(error)}`); return undefined; });
    // A job Prime admitted whose session never got its first prompt reads as not started, whatever its RLM status says (`withUnstarted`).
    const unstarted = await this.source.unstarted?.(this.now()).catch(error => { this.log(`chat ${id.slice(0, 8)}: check-in unstarted jobs: ${error instanceof Error ? error.message : String(error)}`); return []; }) ?? [];
    // A job stalled in one tool call past STALL_MS moves nothing until it returns, so it owns no step (`withStalls`).
    const threads = withStalls(withUnstarted(withHeldTurns(withDeadWakes(withWakes(liveThreads(jobFacts(children, board, rows, id, nested, live), session => readHeartbeats(heartbeatsFile(session, this.source.home)), this.now()),
      wakes, key => sessions.get(key), this.below), dead, key => sessions.get(key), this.below), held?.sessions ?? new Map(), key => sessions.get(key)), unstarted),
      this.source.stalls?.(this.now()) ?? new Map(), key => sessions.get(key));
    // A job Prime parked on a provider limit waits for an account until the daemon's quota resume, not failed (`withQuotaParks`).
    const roots = threads.flatMap(fact => fact.key.startsWith("thread:") ? [fact.key.slice("thread:".length)] : []);
    // A chat on another box keeps its jobs' parks on that box's disk, read through its relay (`chatDisk`).
    const jobSessions = new Set(threads.flatMap(fact => {
      const session = fact.key.startsWith("thread:") ? fact.key.slice("thread:".length) : fact.sessionId ?? sessions.get(fact.key);
      return session ? [session] : [];
    }));
    const disk = await this.source.artifacts?.(id).catch(() => null) ?? localDisk(this.source.home);
    const parks = quotaParks(await parkSchedules(id, roots, jobSessions, disk), this.now());
    const pool = await this.source.queue?.().catch(() => undefined);
    const queued = pool?.queued ?? new Map<string, QueuePlace>();
    const pooled = await withFailedTurns(threads, join(this.source.home ?? homedir(), ".prime", "agent"), id, key => sessions.get(key),
      async session => (await this.summary(session))?.sessionFile);
    const facts = withQueuePlaces(withQuotaParks(pooled, parks, key => sessions.get(key)).map(fact => {
      // A thread's report to the chat counts like a job's: at 16:10Z on 10-18 the check-in restarted "wiki memory moves 10-18b" for "nothing
      // moved" one minute after its 16:09Z report ("243 repo-fact memories are deleted ... 127 wiki-dream skill commits").
      const lastMessage = said.get(fact.name);
      return lastMessage ? { ...fact, lastMessage } : fact;
    }), pool ?? { queued, working: new Set() }, [...this.subagents.values()].flat().concat(children, nested));
    const name = rows.find(row => row.id === id)?.name;
    return { board, ...(boardError !== undefined ? { boardError } : {}), rows, facts, queued, asleep, wakes, ...(name ? { name } : {}), sessions };
  }

  /** The facts that say an item is done: the chat's duty metric verdicts, and the state of the PRs its open items name in the repo of its folder. */
  private async doneFacts(id: string, board: ChatBoard | null, rows: readonly SessionRow[]): Promise<DoneFacts> {
    const fail = (what: string) => (error: unknown) => { this.log(`chat ${id.slice(0, 8)}: check-in ${what}: ${error instanceof Error ? error.message : String(error)}`); return undefined; };
    const runs = await this.source.dutyRuns?.(id).catch(fail("duty runs")) ?? [];
    const cwd = rows.find(row => row.id === id)?.cwd;
    const numbers = boardPrs(board);
    const prs = cwd && numbers.length ? await this.source.prs?.(cwd, numbers).catch(fail("PR states")) : undefined;
    return { metrics: metricFacts(runs), prs: prs ?? new Map() };
  }

  /**
   * The ledger's handoffs for the scope check and the ids of the corrections in force, for parked steps; no handoffs and no ids (every cited id
   * counts) when the ledger cannot be read (logged).
   */
  private async ledger(id: string): Promise<{ handoffs: ReturnType<typeof handoffRules>; corrections?: string[] }> {
    if (!this.source.corrections) return { handoffs: [] };
    return this.source.corrections().then(ledger => ({ handoffs: handoffRules(ledger), corrections: activeCorrections(ledger) }), error => {
      this.log(`chat ${id.slice(0, 8)}: check-in corrections: ${error instanceof Error ? error.message : String(error)}`);
      return { handoffs: [] };
    });
  }

  /**
   * The owner's Run now on the check-in duty, a verify run or a cut run's rerun (`rerunOf`, `Duties.rerunCut`): a check-in at once, in the
   * chat's check-in lane, and its schedule starts over. A rerun runs only while no check-in after the cut one started a job, since a scheduled
   * one may have run ahead of it in the lane.
   */
  runCheckIn(id: string, trigger: CheckInRun["trigger"] = "owner", rerunOf?: number): Promise<void> {
    return new Promise(resolve => this.queue(checkInLane(id), async () => {
      try {
        if (!this.chatIds.has(id)) return;
        if (rerunOf !== undefined && (await this.source.dutyRuns?.(id) ?? []).some(run => run.duty === CHECK_IN_DUTY_ID && run.at > rerunOf && run.job)) {
          this.log(`chat ${id.slice(0, 8)}: check-in rerun of the cut run of ${new Date(rerunOf).toISOString()}: a later check-in started a job, so it does not run`);
          return;
        }
        this.lastCheckIn.set(id, this.now());
        await this.checkIn(id, trigger, rerunOf);
      } finally { resolve(); }
    }));
  }

  /**
   * A job that stopped working without a report is checked again after a grace period: a job between two tool calls, resumed by a reply, or
   * deleted in the meantime is not reported, and neither is a job live through a board.wake or a subagent at work in its tree (`jobLive`).
   * Each end is reported once. While the chat is mid-turn, the daemon holds a job's report to it
   * until the chat's tool call ends, so the check waits for that, up to NO_REPORT_BUSY_TRIES graces (VP of CI 10-13: a report queued at 09:47:30Z
   * landed at 09:52:15Z, 3 s after a notice that said the job sent none).
   */
  private laterNoReport(id: string, childId: string, tries = 0): void {
    const timer = setTimeout(() => this.queue(id, () => this.noReport(id, childId, tries)), this.source.noReportGraceMs ?? NO_REPORT_GRACE_MS);
    timer.unref?.();
  }

  /** The sessions right below `session` in the daemon's list (`subagents`), for the wakes of a job's whole tree (`treeWakes`). */
  private readonly below = (session: string): string[] => (this.subagents.get(session) ?? []).flatMap(child => child.sessionId ? [child.sessionId] : []);

  /**
   * Whether a job that ended its turn still has live work: a board.wake file of its own session (`waking`), a pending wake of a session at any
   * depth below it, or a subagent at work below it (`liveJobs`). The no-report and open-steps notices skip such a job: ops guy 10-18, crawler
   * prod alerts was told "ended" at 01:14Z and 01:17Z while its subagents slept on board.wakes for their CI runs, and the AI harness chat got
   * "ended at 09:04 with no report" for multi host fixes six times in 40 min while it or its subagents slept on board.wakes.
   */
  private async jobLive(id: string, child: ChildAgent): Promise<boolean> {
    const session = child.sessionId ?? this.subagents.get(id)?.find(row => row.id === child.id)?.sessionId;
    // The job's session folder names its own session and every one below it, before the daemon's list or the hub gives them (clean room
    // 10-18 01:46Z: "disk space check" set a time wake at 01:44:56Z and was told "ended its turn" 2 min later, with no session id known yet).
    const folder = this.source.home ? join(this.source.home, ".prime", "agent", "session-artifacts", id, child.id) : join(ARTIFACTS, id, child.id);
    const tree = (await sessionTree(folder).catch(() => ({ sessions: [] as string[] }))).sessions;
    for (const each of new Set([...session !== undefined ? [session] : [], ...tree])) if (await this.source.waking?.(each).catch(() => false)) return true;
    const wakes = await this.source.wakes?.(this.now()).catch(() => []) ?? [];
    return liveJobs([session !== undefined ? { ...child, sessionId: session } : child], this.subagents, this.now(), 0, new Set(wakes.map(wake => wake.session))).size > 0;
  }

  private async noReport(id: string, childId: string, tries: number): Promise<void> {
    await this.load();
    if (!this.chatIds.has(id)) return;
    const child = this.children.get(id)?.find(candidate => candidate.id === childId);
    if (!child || childWorking(child) || child.status === "cancelled" || child.repliedSinceTask !== false) return;
    if (await this.cancelledChild(id, child) || await this.jobLive(id, child)) return;
    if (this.threads.busy(id) && tries < NO_REPORT_BUSY_TRIES && !this.stall(id)) { this.laterNoReport(id, childId, tries + 1); return; }
    const lastMessage = lastJobMessages(this.messages(id) ?? []).get(childName(child));
    const wokeAt = this.workingSince.get(child.id) ?? 0;
    const waited = lastMessage !== undefined && lastMessage.at >= wokeAt ? lastMessage.at : undefined;
    const end = child.lastActivityAt ?? this.now();
    const told = this.noticedEnd.get(child.id);
    if (told !== undefined && Math.abs(end - told.end) < NO_REPORT_SAME_END_MS && told.waited === waited) return;
    this.noticedEnd.set(child.id, { end, ...(waited !== undefined ? { waited } : {}) });
    if (this.stall(id)) { this.log(`chat ${id.slice(0, 8)}: no notice for ${childName(child)}: the chat's last turn failed; the next check-in job sees it`); return; }
    const line = `${JOB_NOTICE_PREFIX}${noReportNotice(childName(child), lastMessage, wokeAt, end, child.status === "error" ? child.error : undefined)}`;
    if (noticeStands(this.messages(id) ?? [], childName(child), line)) return;
    try {
      await this.tell(id, line);
    } catch (error) { this.log(`chat ${id.slice(0, 8)}: no-report notice: ${error instanceof Error ? error.message : String(error)}`); }
  }

  /**
   * A job whose turn ended while open steps still name it (`leftOpenSteps`) is told to the chat as one steer after the no-report grace, so the
   * chat closes, steers or restarts in that turn rather than at the next check-in, up to 2 h later. Its report lands first, and while the chat
   * is mid-turn the check waits for it, up to NO_REPORT_BUSY_TRIES graces, so a chat that closes the step on the report gets nothing. A job at
   * work again, or live through a board.wake or a subagent at work in its tree (`jobLive`), is not told; each end is told once.
   */
  private laterOpenSteps(id: string, childId: string, tries = 0): void {
    const timer = setTimeout(() => this.queue(id, () => this.openSteps(id, childId, tries)), this.source.noReportGraceMs ?? NO_REPORT_GRACE_MS);
    timer.unref?.();
  }

  private async openSteps(id: string, childId: string, tries: number): Promise<void> {
    await this.load();
    if (!this.chatIds.has(id)) return;
    const children = this.children.get(id) ?? [];
    const child = children.find(candidate => candidate.id === childId);
    if (!child || childWorking(child) || await this.cancelledChild(id, child) || await this.jobLive(id, child)) return;
    if (this.threads.busy(id) && tries < NO_REPORT_BUSY_TRIES && !this.stall(id)) { this.laterOpenSteps(id, childId, tries + 1); return; }
    let board: ChatBoard | null;
    try { board = await this.source.board(id); }
    catch (error) { this.log(`chat ${id.slice(0, 8)}: open-steps notice: ${error instanceof Error ? error.message : String(error)}`); return; }
    const steps = leftOpenSteps(child, children, board);
    if (!steps.length) return;
    const told = `${child.lastActivityAt ?? ""}:${steps.map(step => step.id).join(",")}`;
    if (this.openStepsTold.get(child.id) === told) return;
    this.openStepsTold.set(child.id, told);
    try {
      const detail = await this.noticeDetail(id, "open-steps", openStepLines(steps));
      await this.tell(id, JOB_NOTICE_PREFIX + openStepsNotice(child, steps, detail));
      this.log(`chat ${id.slice(0, 8)}: told the chat ${childName(child)} ended with ${steps.map(step => step.id).join(", ")} open`);
    } catch (error) { this.log(`chat ${id.slice(0, 8)}: open-steps notice: ${error instanceof Error ? error.message : String(error)}`); }
  }

  /**
   * A job (a subagent, or a root the chat started with rlm.create_session) whose last turn ended on a provider error, an abort, a stop mid-tool
   * or the length limit, and that sent the chat no report since its last start, is told to the chat at once as one plain `[job]` line with the
   * cause (`jobEndText`); the chat decides what to do. Once per end: the end is kept in the check-in record, so a restart does not tell it
   * again, the check-in counts it in `job_end_silent`, and the no-report notice skips it. A cancelled job, a job
   * at work again, a subagent with no child snapshot, an end older than JOB_END_NOTE_MAX_AGE_MS, and a chat whose transcript the server does not
   * hold are left out.
   */
  private async jobEndNote(threadId: string, job: ChatJob): Promise<void> {
    const { chat, agent } = job;
    if (!this.chatIds.has(chat) || await this.cancelled(threadId)) return;
    // Read when the note runs: it waits on the chat's queue, and a view taken before the final reply ends at the last tool result.
    const state = await this.threads.view(threadId).catch(() => null);
    if (!state || this.threads.running(threadId)) return;
    const end = jobEnd(state.messages);
    const now = this.now();
    if (!end || now - end.at > JOB_END_NOTE_MAX_AGE_MS) return;
    const child = agent.childId !== undefined ? this.children.get(chat)?.find(candidate => candidate.id === agent.childId) : undefined;
    // A subagent the server holds no snapshot of cannot be told apart from a cancelled job or one that replied.
    if (agent.link === "subagent" ? !child || childWorking(child) || child.status === "cancelled" : false) return;
    const transcript = this.messages(chat);
    if (!transcript) return;
    const said = lastJobMessages(transcript).get(agent.sender);
    if (child?.repliedSinceTask === true || (said !== undefined && said.at >= end.startedAt)) return;
    const key = agent.link === "subagent" && agent.childId !== undefined ? agent.childId : "thread:" + threadId;
    try {
      if ((await this.source.memory.ends(chat))[key]?.at === end.at) return;
      const name = agent.sender || agent.name;
      await this.tell(chat, JOB_NOTICE_PREFIX + jobEndText(name, end));
      await this.source.memory.told(chat, key, { at: end.at, cause: end.cause, ...end.error ? { error: end.error } : {} });
      this.log(`chat ${chat.slice(0, 8)}: job ${name} ended (${end.cause}) with no report; told the chat`);
      if (child) this.noticedEnd.set(child.id, { end: child.lastActivityAt ?? end.at });
    } catch (error) {
      this.log(`chat ${chat.slice(0, 8)}: job end note for ${agent.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Sends a server notice to a chat as a steer, or holds it while Prime has the chat parked on a provider wait until a later time
   * (`readQuotaPark`). A steer to a parked chat starts a turn that fails at once on the same 429, and its messages move the chat's idle clock, so
   * the idle unload never frees the chat: on 10-20 Crawler VP was parked from 08:35Z to 10:16Z, took 27 notices from 08:57Z to 09:46Z, never
   * 12 min apart, and kept its 1.05 GB worker throughout. Held notices wait in `heldNotices`, behind any the chat already holds, and the tick
   * sends them in order once the park ended (`sendHeld`), so they join the resumed turn. The owner's own messages never come here: the owner
   * outbox sends each at once as an owner turn.
   */
  /** A server notice to an owner chat from outside the chat service's own passes, such as a duty precheck's push (`DutyHost.tell`). */
  async notice(chat: string, message: string): Promise<void> {
    await this.load();
    if (!this.chatIds.has(chat)) throw new Error(`${chat.slice(0, 8)} is not a chat`);
    await this.tell(chat, message);
  }

  private tell(chat: string, message: string): Promise<void> {
    const record = this.source.heldNotices;
    if (!record) return this.threads.prompt(chat, { message, images: [], mode: "steer" });
    return new Promise((resolve, reject) => this.queue(heldLane(chat), async () => {
      try {
        const until = await this.parkedUntil(chat);
        if (until === null && !(await record.read()).get(chat)?.length) await this.threads.prompt(chat, { message, images: [], mode: "steer" });
        else {
          const held = await record.add(chat, message);
          if (until === null) await this.sendHeld(chat);
          else this.log(`chat ${chat.slice(0, 8)}: held a notice, Prime parks the chat until ${new Date(until).toISOString()} (${held} held)`);
        }
        resolve();
      } catch (error) { reject(error); }
    }));
  }

  /** When Prime resumes the chat it parked on a provider wait, from its session file; null when it is not parked or the file cannot be read. */
  private async parkedUntil(chat: string): Promise<number | null> {
    const file = (await this.summary(chat).catch(() => undefined))?.sessionFile;
    return file ? readQuotaPark(file, this.now()).catch(() => null) : null;
  }

  /** Sends the notices held for a chat whose park ended, oldest first; each leaves the record once it went, and a failed send waits for the next tick. */
  private async sendHeld(chat: string): Promise<void> {
    const record = this.source.heldNotices!;
    try {
      const held = (await record.read()).get(chat) ?? [];
      if (!held.length || await this.parkedUntil(chat) !== null) return;
      let sent = 0;
      try { for (const message of held) { await this.threads.prompt(chat, { message, images: [], mode: "steer" }); sent++; } }
      finally { if (sent) await record.drop(chat, sent); }
      this.log(`chat ${chat.slice(0, 8)}: the park ended; sent the ${sent} notices held while it was parked`);
    } catch (error) {
      this.log(`chat ${chat.slice(0, 8)}: held notices: ${error instanceof Error ? error.message : String(error)}; sent at the next tick`);
    }
  }

  /** At each tick: the held notices of every chat whose park ended go now (`sendHeld`). */
  private async releaseHeld(): Promise<void> {
    const held = await this.source.heldNotices!.read().catch(error => { this.log(`chats: held notices: ${error instanceof Error ? error.message : String(error)}`); return new Map(); });
    for (const chat of held.keys()) if (this.chatIds.has(chat)) this.queue(heldLane(chat), () => this.sendHeld(chat));
  }

  /** After each attach: steering `all` again (runtime state), and the old daemon check-in heartbeat cleared, since the server tick replaced it. */
  private async attached(id: string): Promise<void> {
    await this.load();
    if (!this.chatIds.has(id)) return;
    try {
      await this.threads.setSteeringMode(id, "all");
      if ((await this.threads.heartbeat(id))?.startsWith(OLD_CHECK_IN)) {
        await this.threads.clearHeartbeat(id);
        this.log(`chat ${id.slice(0, 8)}: cleared the old check-in heartbeat`);
      }
    } catch (error) {
      // The idle unload can let go of the chat asleep in its provider retry while this runs (`ThreadHub.restAsleep`), which closes the link the
      // call was on. Steering is runtime state that the next attach sets again, so nothing is lost: on 10-21 at 21:50:24Z the VP chat's call
      // failed that way and d7 read the minute dirty.
      if (this.threads.isLive?.(id) === false && CLIENT_CLOSED.test(error instanceof Error ? error.message : String(error))) {
        this.log(`chat ${id.slice(0, 8)}: let go asleep before its steering was set; its next attach sets it`);
        return;
      }
      this.log(`chat ${id.slice(0, 8)}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Reloads the chat when the build it last loaded is not the one on disk, or the owner asked to update every chat: now if no turn runs, else
   * once one does not, at its idle event or the next tick. Input queued for the chat does not hold the reload, since a reload keeps the queue
   * (10-20: 12 of 17 chats ran an older build for hours because input kept arriving, so tell_owner fixes reached them late or not at all). The reload keeps the brief the chat pinned in its system prompt, so its cached prompt stays valid, and the chat reads a
   * changed brief after its next compaction.
   */
  private async refreshExtension(id: string): Promise<void> {
    await this.load();
    if (!this.chatIds.has(id)) return;
    const forced = this.forced.has(id);
    let action: "reload" | "wait" | null = null;
    try {
      action = reloadAction(await this.loads.get(id), this.build, this.threads.running(id), forced);
      if (action === "wait") { this.reloadWaiting.add(id); return; }
      this.reloadWaiting.delete(id);
      if (!action) return;
      await this.threads.reload(id);
      await this.loads.set(id, this.build, this.brief);
      this.log(`chat ${id.slice(0, 8)}: extension reloaded, build ${this.build}, brief ${this.brief.version}`);
    } catch (error) {
      this.log(`chat ${id.slice(0, 8)}: reload: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      if (!this.reloadWaiting.has(id)) this.forced.delete(id);
      if (action !== null || forced) this.briefChanged();
    }
  }

  /**
   * At a turn's end, and when an idle chat attaches: a correction the chat recorded since the owner's newest message gets one global `/refine`
   * aimed at it, which Prime runs in the chat's session, and an owner message that reads as a correction with nothing recorded gets one
   * `[correction check]` line (`correctionStep`). Each once across restarts (`correctionChecks`). The owner asked on 10-15 that every correction
   * refines the harness without anyone remembering to (c86).
   */
  private async correctionCheck(id: string): Promise<void> {
    const record = this.source.correctionChecks;
    if (!record || !this.source.corrections) return;
    await this.load();
    const messages = this.chatIds.has(id) ? this.messages(id) : undefined;
    if (!messages) return;
    try {
      const scratch = await this.source.cleanRoom?.(id) ?? null;
      const step = correctionStep(id, scratch ?? await this.source.corrections(), messages, this.now(), CHECK_MAX_AGE_MS, scratch === null);
      if (!step || !await record.claim(step.kind === "ask" ? `${id}:ask` : id, step.at)) return;
      await this.tell(id, step.message);
      this.log(`chat ${id.slice(0, 8)}: correction ${step.kind === "ask" ? "check sent" : "refine started"}`);
    } catch (error) { this.log(`chat ${id.slice(0, 8)}: correction check: ${error instanceof Error ? error.message : String(error)}`); }
  }

  /**
   * When a chat's direct subagent first shows up: its brief, the `prompt` the daemon stored at the spawn, is checked for an invented gate or
   * wait (`briefCheck`, c47). On findings the chat gets one `[brief check]` steer naming the job; the spawn is never held. Once per job across
   * restarts (`briefChecks`); a job spawned more than BRIEF_CHECK_MAX_AGE_MS before the server first reads it is left alone. A spawn record not
   * written yet is read again at the next children change.
   */
  private async briefCheck(chat: string, child: ChildAgent): Promise<void> {
    const record = this.source.briefChecks;
    if (!record || this.briefSeen.has(child.id)) return;
    await this.load();
    if (!this.chatIds.has(chat)) return;
    try {
      const sessionFile = (await this.summary(chat))?.sessionFile;
      if (!sessionFile) return;
      const spawn = await spawnRecord(join(artifactsDir(sessionFile), child.id));
      if (!spawn) return;
      this.briefSeen.add(child.id);
      if (this.now() - spawn.createdAt > BRIEF_CHECK_MAX_AGE_MS) return;
      const findings = briefCheck(spawn.prompt);
      if (!findings.length || !await record.claim(child.id, spawn.createdAt)) return;
      await this.tell(chat, briefCheckNote(childName(child), findings));
      this.log(`chat ${chat.slice(0, 8)}: brief check for job ${childName(child)}: ${findings.map(finding => finding.kind).join(", ")}`);
    } catch (error) { this.log(`chat ${chat.slice(0, 8)}: brief check: ${error instanceof Error ? error.message : String(error)}`); }
  }

  /** The owner's Update all chats: every chat reloads onto the current extension and brief, an idle one now, a busy one at the end of its turn. */
  async updateAll(): Promise<number> {
    await this.load();
    for (const id of this.chatIds) { this.forced.add(id); this.queue(id, () => this.refreshExtension(id)); }
    this.briefChanged();
    return this.chatIds.size;
  }

  /** The sessions stream's brief field for every chat: the version it last loaded, the current one, and whether a reload is due or under way. */
  async briefs(): Promise<ReadonlyMap<string, ChatBriefState>> {
    await this.load();
    const loaded = await this.loads.briefs();
    return new Map([...this.chatIds].map(id => [id, { version: loaded[id] ?? null, current: this.brief.version, updating: this.forced.has(id) || this.reloadWaiting.has(id) }]));
  }

  close(): void {
    clearInterval(this.timer);
    this.unobserve();
    if (this.quietWrite) { clearTimeout(this.quietWrite); this.quietWrite = undefined; void this.source.quietJobs?.write(new Map(this.jobQuiet)).catch(() => {}); }
  }
}
