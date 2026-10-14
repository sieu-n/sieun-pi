import { basename, dirname, join } from "node:path";
import type { IdIndex } from "./id-index.ts";
import { agentChildren } from "./chat-agents.ts";
import { activeCorrections, handoffRules } from "./chat-corrections.ts";
import { heartbeatsFile, liveThreads, readHeartbeats, readTrain, trainFile } from "./checkin-load.ts";
import { flagStreaks } from "./checkin-repeats.ts";
import { GateHolds } from "./chat-daemon-gate.ts";
import { activePause, changeCheckIn, type CheckInActor, type CheckInChange, CheckInRefused, type CheckInSetting, DEFAULT_CHECK_IN, nextCheckIn } from "./checkin-settings.ts";
import { checkInDue, childName, childWorking, jobFacts, liveJobs, liveWindowMs } from "./checkin-steps.ts";
import { withQueuePlaces } from "./chat-turn-queue.ts";
import { checkInPrecheck, checkInPrecheckText, classCounts, convergenceMisses, endedWithoutReport, finishedJobs, JOB_CLEANUP_EVERY_MS, jobEnd, jobEndText,
  jobReport, lastJobMessages, noReportNotice, retryDue, waitingJobs } from "./chat-checkin.ts";
import { jobBrief, savedStateNote, waitText } from "./job-resume.ts";
import { BOARD_LIMITS } from "./shared/chat-board.ts";
import { noticeStands } from "./no-report.ts";
import { statusAsks } from "./status-ask.ts";
import { newestReportAt, opsSteer, tailMessages } from "./checkin-ops.ts";
import { previousSpawn, spawnRecord } from "./spawn-record.ts";
import { checkInLane, type ClaudeState, claudeDown, failureCause, hungMessage, hungTurn, jobWake, type JobWake, ownerPause, revivalMessage, type Stall, stallAction, strandedInput, turnStall, turnViewOf, wokeFromSleep } from "./chat-recovery.ts";
import { JOB_NOTICE_PREFIX, TELL_OWNER_LIMIT, TELL_OWNER_TOOL } from "./shared/chat-feed.ts";
import { replyCheck } from "./shared/reply-lint.ts";
import { briefCheckNote, ownerSaid, turnOwnerAt } from "./shared/brief-check.ts";
import { briefCheckWithHistory } from "./owner-history.ts";
import type { CheckInRun } from "./chat-duty-run.ts";
import type { ChatAgent, ChatBoard, ChatBriefState, CheckInState, CheckInView, ChildAgent, PlanItem, QueuePlace, SessionRow, ThinkingLevel, ThreadMessage } from "./shared/types.ts";
import { briefNote, chatBrief, type LoadRecord, reloadAction } from "./chat-brief.ts";
import { BRIEF_CHECK_MAX_AGE_MS, type ChatLinks, type ChatSummary, type ChatThreads, type CheckInSource, REPLY_CHECK_MAX_AGE_MS, type SubagentDelete } from "./chat-sources.ts";
import { chatName, fileHasChatMarker } from "./chat-guard.ts";

export { TELL_OWNER_LIMIT, TELL_OWNER_TOOL };

/** The daemon's answer for an active session id it does not hold: that session ended, whatever its list still says. */
export const UNKNOWN_ACTIVE = "Unknown active session:";
/** A thread the daemon no longer has: not in the catalog (404), or listed active with a session the daemon does not hold. */
const threadGone = (error: unknown): boolean =>
  error instanceof Error && ((error as { status?: unknown }).status === 404 || error.message.startsWith(UNKNOWN_ACTIVE));
/** The prompt of the daemon heartbeat that did the check-in before the server tick; an attach clears a heartbeat whose prompt starts with it. */
export const OLD_CHECK_IN = "Check-in. Read the board";
/** A job quiet this long with no report is told to the chat; shorter gaps are a job between tool calls or one that a reply woke again. */
export const NO_REPORT_GRACE_MS = 90_000;
/** Two ends of one job whose last activity is this close are one end: told once. */
export const NO_REPORT_SAME_END_MS = 60_000;
/** How many graces a no-report check waits while the chat is mid-turn before it tells the chat anyway. */
export const NO_REPORT_BUSY_TRIES = 6;
/**
 * A root session's artifacts folder, where the daemon keeps each direct subagent's folder by child id: `session-artifacts/<session id>`
 * beside the folder of its session file (prime-agent `getSessionArtifactPathForFile`).
 */
export const artifactsDir = (sessionFile: string): string => join(dirname(dirname(sessionFile)), "session-artifacts", basename(sessionFile, ".jsonl"));
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
 * An attached chat's children with what the daemon's rows add: the later of the two last activities, and a running turn the attach missed,
 * kept as `followUps` keeps it. The parent's record of a finished job can freeze (VP of CI 10-13: the attach kept "repo rules check fix" at
 * 09:20:49Z and stopped it mid-tool while its session file shows work until 09:47:48Z), and the row reads the job's own session.
 */
export function withRoster(attached: readonly ChildAgent[], roster: readonly ChildAgent[]): ChildAgent[] {
  return attached.map(child => {
    const row = roster.find(candidate => candidate.id === child.id);
    if (!row) return child;
    const at = Math.max(child.lastActivityAt ?? -Infinity, row.lastActivityAt ?? -Infinity);
    const running = row.status === "running" && !childWorking(child);
    if (at === (child.lastActivityAt ?? -Infinity) && !running) return child;
    return { ...child, ...(Number.isFinite(at) ? { lastActivityAt: at } : {}), ...(running ? { activity: { kind: "executing" as const } } : {}) };
  });
}

/** The check-in scheduler wakes this often; each chat runs at its own interval, so an interval is kept to within this much. */
export const CHECK_IN_TICK_MS = 30_000;
/** A check-in whose job could not start runs again after this long, not a whole interval later (`CheckInStart`). */
export const CHECK_IN_RETRY_MS = 5 * 60_000;
/** How often the scheduler looks for chats the index lost, and how recent a thread must be to be looked at. */
export const ADOPT_SCAN_MS = 10 * 60_000;
export const ADOPT_RECENT_MS = 7 * 24 * 60 * 60_000;
/** A job of a chat quiet for longer than this is not looked at for a failed turn. */
export const JOB_WAKE_WINDOW_MS = 24 * 60 * 60_000;
/** A bad job end found later than this after it happened (the first wake after a deploy reads a day of jobs) is left to the check-in. */
export const JOB_END_NOTE_MAX_AGE_MS = 2 * 60 * 60_000;
/** A job as the scheduler found it in its chat's row: the chat and its Agents entry. */
interface ChatJob { chat: string; agent: ChatAgent }

/**
 * Chats on the server: the index, residency (pinned, so they stay attached and resident), steering mode `all` after every attach (it is runtime
 * state), the check-in scheduler (each chat at its own interval, none while the owner paused it), the restart of
 * a chat whose last turn failed, the no-report notice, and the extension build: a chat that last loaded an older build than the one on disk is
 * reloaded when it attaches, at once if idle, else at the end of its turn. Everything converges from the index plus the daemon list, so a restart
 * re-adopts what it finds, and a scan of the session files brings back a chat the index lost.
 */
export class Chats {
  private readonly chatIds = new Set<string>();
  /** The children last seen per thread: the tick reads them, and each change is compared with them to find a job that ended with no report. */
  private readonly children = new Map<string, readonly ChildAgent[]>();
  /** An attached chat's children as its attach last gave them, before `withRoster`. */
  private readonly attachedChildren = new Map<string, readonly ChildAgent[]>();
  /** The daemon's subagents by parent session at the last catalog refresh (`roster`), for the subagents of a chat's duty jobs. */
  private subagents: ReadonlyMap<string, readonly ChildAgent[]> = new Map();
  /**
   * When each job was last seen starting to work, and the end (its last activity) last told to the chat, with the time of the job message it
   * was told as waiting on (none for "ended with no report").
   */
  private readonly workingSince = new Map<string, number>();
  private readonly noticedEnd = new Map<string, { end: number; waited?: number }>();
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
  /** Check-ins the daemon gate held, logged when each falls due and when it runs. */
  private readonly holds = new GateHolds(line => this.log(line));
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
  /** The activity stamp at which a job thread was last found with no transient failure; it is looked at again once the stamp changes. */
  private readonly jobQuiet = new Map<string, string>();
  /** When each chat's finished jobs were last checked, and the jobs already deleted (or tried once). */
  private readonly cleanedAt = new Map<string, number>();
  private readonly deletedJobs = new Set<string>();
  /** Job threads found gone (`threadGone`) at an activity stamp: never looked at again unless the stamp changes. */
  private readonly jobGone = new Map<string, string>();
  /** When the scheduler last looked for lost chats, and the threads with messages found plain (their head never changes). */
  private lastScan: number;
  private readonly plain = new Set<string>();
  /** Jobs whose brief was read for the brief check, and the spawn time of each subagent folder read so far (they never change). */
  private readonly briefSeen = new Set<string>();
  private readonly spawnTimes = new Map<string, number>();
  /** Each chat's newest duty report with board ops that `opsCheck` judged after its turn ended, by its time. */
  private readonly opsJudged = new Map<string, number>();

  /**
   * `index` is `<data dir>/chats.json`: the session ids that are chats, newest first. The chat side's one definition of "chat"; the session entry
   * is the agent side's. `build` is the extension build on disk (`extensionBuild()`), `loads` the one each chat last loaded.
   */
  constructor(readonly index: IdIndex, private readonly threads: ChatThreads, private readonly summary: ChatSummary, private readonly build: string,
    private readonly loads: LoadRecord, private readonly source: CheckInSource, private readonly log: (line: string) => void = () => {}) {
    this.now = source.now ?? Date.now;
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
        // A reply sent just before a restart ended its turn on the old server; an idle chat gets its check when it attaches.
        if (!this.threads.busy(id)) { this.queue(id, () => this.replyCheck(id)); this.queue(id, () => this.opsCheck(id)); }
      },
      children: (id, attached) => { this.attachedChildren.set(id, attached); this.childrenChanged(id, withRoster(attached, this.subagents.get(id) ?? [])); },
      idle: id => {
        if (this.reloadWaiting.has(id)) this.queue(id, () => this.refreshExtension(id));
        this.cleanSoon(id);
        this.queue(id, () => this.replyCheck(id));
        this.queue(id, () => this.opsCheck(id));
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
    for (const child of children) if (!this.briefSeen.has(child.id)) this.queue(id, () => this.briefCheck(id, child));
    if (before?.some(was => childWorking(was) && children.some(child => child.id === was.id && !childWorking(child)))) this.cleanSoon(id);
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
   * chat keeps the hub's children, with each one's clock and running turn from its row (`withRoster`).
   */
  async roster(byChat: ReadonlyMap<string, readonly ChildAgent[]>): Promise<void> {
    this.subagents = byChat;
    await this.load();
    for (const id of this.chatIds) {
      const before = this.children.get(id);
      const live = this.threads.isLive?.(id) ?? false;
      const attached = live ? this.attachedChildren.get(id) : undefined;
      if (live && !attached) continue;
      const children = attached ? withRoster(attached, byChat.get(id) ?? []) : followUps(before, byChat.get(id) ?? []);
      if (before && JSON.stringify(before) === JSON.stringify(children)) continue;
      this.childrenChanged(id, children);
    }
  }

  /** Tasks of one thread run one after another; `settled` resolves once every queue is empty, for tests. */
  private queue(id: string, task: () => Promise<void>): void {
    const next = (this.syncing.get(id) ?? Promise.resolve()).then(task);
    this.syncing.set(id, next);
    void next.finally(() => { if (this.syncing.get(id) === next) this.syncing.delete(id); });
  }

  async settled(): Promise<void> { while (this.syncing.size) await Promise.all([...this.syncing.values()]); }

  /**
   * The index, and each chat's last check-in from the check-in memory, so a service restart keeps every chat's schedule instead of starting it
   * over (10-09: three restarts in 16 min kept a 15-min chat from any check-in).
   */
  private load(): Promise<void> {
    return this.loaded ??= this.index.ids().then(ids => this.mine(ids)).then(async ids => {
      for (const id of ids) {
        this.chatIds.add(id);
        const at = (await this.source.memory.get(id).catch(() => undefined))?.at;
        if (at !== undefined && !this.lastCheckIn.has(id)) this.lastCheckIn.set(id, Math.min(at, this.now()));
      }
    });
  }

  /** The ids of `ids` this service acts on: all of them, or only the ones it created when it does not own the live chats. */
  private async mine(ids: readonly string[]): Promise<string[]> {
    if (!this.source.owned) return [...ids];
    const owned = new Set(await this.source.owned.ids());
    return ids.filter(id => owned.has(id));
  }

  async ids(): Promise<ReadonlySet<string>> { await this.load(); return this.chatIds; }

  async create(input: { cwd: string; provider?: string; modelId?: string; thinkingLevel?: ThinkingLevel; name?: string }): Promise<{ id: string; name: string }> {
    await this.load();
    const name = input.name?.trim() || chatName();
    const { id } = await this.threads.create({ cwd: input.cwd, ...(input.provider ? { provider: input.provider } : {}), ...(input.modelId ? { modelId: input.modelId } : {}),
      ...(input.thinkingLevel ? { thinkingLevel: input.thinkingLevel } : {}), name, kind: "chat" });
    await this.source.owned?.add(id);
    await this.index.add(id);
    this.chatIds.add(id);
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
   * respond, but not be in the Chats list").
   */
  async archive(id: string): Promise<void> {
    await this.threads.archive(id);
    await this.source.archived?.add(id);
    await this.forget(id);
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
    const archived = await this.archivedIds();
    for (const row of rows) {
      if (this.chatIds.has(row.id) || this.plain.has(row.id) || row.archived || archived.has(row.id)) continue;
      if (now - (Date.parse(row.lastActivityAt ?? row.created ?? "") || 0) > ADOPT_RECENT_MS) continue;
      const restored = await this.restore(row.id).catch((error: unknown) => {
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
    await this.index.forget(id);
    await this.loads.forget(id);
    await this.source.memory.forget(id);
  }

  /** The owner's settings, or none when the file cannot be read (logged): every chat then runs at the default interval. */
  private async settings(): Promise<Record<string, CheckInSetting>> {
    try { return await this.source.settings.all(); }
    catch (error) { this.log(`check-in settings: ${error instanceof Error ? error.message : String(error)}`); return {}; }
  }

  /**
   * One scheduler wake: queues the check-in of every chat whose interval has passed since its last one and that is not paused; the time is
   * taken before the run is queued, so a second wake in the same slot does not queue it again. Every chat the owner has not paused is also
   * checked for a failed last turn (`revive`), and so are its jobs (`jobs`); a wake that follows a sleep restarts every transient failure at
   * once. A pause by the daemon gate or by the chat itself stops only check-ins: on 10-12 the gate paused 7 chats from 13:35Z on, and their
   * failed turns would have waited for the resume. A check-in runs in its own lane (`checkInLane`), so a revive never waits behind a check-in
   * whose duty job start hangs: on 10-11 from 20:35Z to 10-12 01:42Z no chat got a revive or a check-in while the hub attached sessions in
   * under 0.3 s, and 4 chats aborted by the 19:08Z Prime update sat 0.5 to 7.7 h (unretried_errors, dead_hours). Every ADOPT_SCAN_MS the
   * session files are scanned for chats the index lost. Returns the ids checked in.
   */
  async tick(): Promise<string[]> {
    await this.load();
    const settings = await this.settings();
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
      const setting = settings[id] ?? DEFAULT_CHECK_IN;
      const paused = activePause(setting, now) !== null;
      if (paused && ownerPause(setting)) continue;
      active.add(id);
      if (!this.reviving.has(id)) { this.reviving.add(id); this.queue(id, () => this.revive(id, woke).finally(() => this.reviving.delete(id))); }
      const lastAt = this.lastCheckIn.get(id) ?? now - setting.everyMs;
      if (paused) {
        if (setting.pausedBy === "daemon") this.holds.hold(id, lastAt + setting.everyMs, now);
        continue;
      }
      // A chat with no check-in on record is due now, not one interval after this service started: every release restart pushed ops guy's
      // 2 h check-in back again (10-12: none from 10-10 11:33Z on, with its owner pause lifted at 05:28Z).
      const next = nextCheckIn(setting, lastAt, now);
      if (next === null || next > now) continue;
      due.push(id);
      this.lastCheckIn.set(id, now);
      this.holds.ran(id, now);
      this.queue(checkInLane(id), async () => { await this.checkIn(id); });
    }
    this.queue("#jobs", () => this.jobs(active, woke));
    return due;
  }

  /**
   * Deletes each finished job of a chat (`finishedJobs`) once, with one log line, so its Python kernel and session stop holding memory, and
   * ends each job whose only open work is a board wait (`waitingJobs`) with its state saved on the step (`parkJob`). A board that cannot be
   * read deletes nothing; a failed delete is logged and not tried again in this serve. A job the daemon deleted, or one the chat no longer
   * holds (`not_held`), goes on the deleted job record, so a restart does not try it again while the daemon still lists it.
   */
  private async cleanJobs(id: string): Promise<void> {
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
    for (const child of finishedJobs(children, board, said)) {
      if (gone?.has(child.id)) continue;
      const result = await this.deleteJob(id, child, listed, now);
      if (result === "deleted") this.log(`chat ${id.slice(0, 8)}: deleted finished job ${childName(child)} (reported, quiet ${Math.round((now - child.lastActivityAt!) / 60_000)} min, no open step)`);
    }
    if (!this.source.resumes) return;
    for (const { child, steps } of waitingJobs(children, board, now, said)) if (!gone?.has(child.id)) await this.parkJob(id, child, steps, jobReport(messages, childName(child)), listed, now);
  }

  /**
   * Deletes one job of the chat unless it works: the hub's view of it is read again first, then the daemon's state of its session (a tool call
   * such as `ci-run-status --wait`, or a background bash its kernel waits on, keeps it), and the daemon refuses a job that streams or holds
   * an unfinished action in the same request (`running`), so a job that started a turn since the cleanup read its children is kept and looked
   * at again later.
   */
  private async deleteJob(id: string, child: ChildAgent, listed: readonly string[], now: number): Promise<SubagentDelete | "kept"> {
    const current = this.children.get(id)?.find(candidate => candidate.id === child.id);
    if (this.deletedJobs.has(child.id) || !current || childWorking(current)) return "kept";
    this.deletedJobs.add(child.id);
    try {
      if (current.sessionId !== undefined && await this.threads.sessionActive(current.sessionId)) {
        this.deletedJobs.delete(child.id);
        this.log(`chat ${id.slice(0, 8)}: kept job ${childName(child)}: its session runs a tool call or a background bash`);
        return "kept";
      }
      const result = await this.threads.deleteSubagent(id, child.id);
      if (result === "running") {
        this.deletedJobs.delete(child.id);
        this.log(`chat ${id.slice(0, 8)}: kept job ${childName(child)}: the daemon shows it running`);
        return result;
      }
      await this.source.deletedJobs?.add(id, child.id, now, listed);
      if (result === "not_held") this.log(`chat ${id.slice(0, 8)}: finished job ${childName(child)} is no longer a subagent of the chat (the daemon still lists its session); recorded, not tried again`);
      return result;
    } catch (error) {
      this.log(`chat ${id.slice(0, 8)}: delete job ${childName(child)}: ${error instanceof Error ? error.message : String(error)}`);
      return "kept";
    }
  }

  /**
   * Ends a job whose only open work is a board wait: its brief (`jobBrief`), last report and the steps' waits are saved first
   * (`<data dir>/job-resumes`), then the job is deleted, then each step's note names the saved state, so the check-in's line for the step when
   * its wait is due or stale (`classLine`) tells the chat to spawn a fresh job from it, and the chat gets a notice now. A job whose brief cannot
   * be read is kept.
   */
  private async parkJob(id: string, child: ChildAgent, steps: readonly PlanItem[], report: string, listed: readonly string[], now: number): Promise<void> {
    const resumes = this.source.resumes!;
    const name = childName(child);
    try {
      const sessionFile = (await this.summary(id))?.sessionFile;
      const brief = sessionFile ? await jobBrief(join(artifactsDir(sessionFile), child.id)) : undefined;
      if (brief === undefined) { this.log(`chat ${id.slice(0, 8)}: kept waiting job ${name}: its brief could not be read`); return; }
      const event = steps.map(waitText).join("; ");
      const path = await resumes.store.save({ chat: id, childId: child.id, job: name, steps: steps.map(step => step.id), event, brief, report, endedAt: now });
      if (await this.deleteJob(id, child, listed, now) !== "deleted") return;
      const line = savedStateNote(name, now, path);
      await resumes.applyBoard(id, steps.map(step => ({ op: "plan_update", id: step.id, note: [line, step.note].filter(Boolean).join("\n").slice(0, BOARD_LIMITS.note) })));
      await this.threads.notice(id, `${JOB_NOTICE_PREFIX}${name} was ended after ${Math.round((now - child.lastActivityAt!) / 60_000)} min quiet while it waited (${event}). ` +
        `Its brief, last report and wait are saved in ${path}; when the wait is over, or to send it more work, spawn a fresh job from that file.`);
      this.log(`chat ${id.slice(0, 8)}: ended waiting job ${name} (quiet ${Math.round((now - child.lastActivityAt!) / 60_000)} min, ${event}); saved state ${path}`);
    } catch (error) { this.log(`chat ${id.slice(0, 8)}: end waiting job ${name}: ${error instanceof Error ? error.message : String(error)}`); }
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
    this.source.awake?.(chatRows.some(row => row.working || (row.agents ?? []).some(agent => agent.state === "working")));
    const now = this.now();
    const threads = new Set<string>();
    for (const row of chatRows) {
      if (!active.has(row.id)) continue;
      for (const agent of row.agents ?? []) {
        const threadId = agent.sessionId;
        if (!threadId || (agent.link !== "subagent" && agent.link !== "root") || this.chatIds.has(threadId) || threads.has(threadId)) continue;
        threads.add(threadId);
        const stamp = agent.lastActivityAt ?? "";
        if (agent.state === "working" || now - (Date.parse(stamp) || 0) > JOB_WAKE_WINDOW_MS) { this.jobQuiet.delete(threadId); this.jobWakes.delete(threadId); continue; }
        if (this.jobGone.get(threadId) === stamp || (!this.jobWakes.has(threadId) && this.jobQuiet.get(threadId) === stamp)) continue;
        this.queue(threadId, () => this.wakeJob(threadId, stamp, woke, { chat: row.id, agent }));
      }
    }
    for (const threadId of this.jobThreads) if (!threads.has(threadId)) { this.jobQuiet.delete(threadId); this.jobWakes.delete(threadId); this.jobGone.delete(threadId); }
    this.jobThreads = threads;
  }

  /**
   * The extension build of each job of a chat (a subagent or a create_session root), kept the way `refreshExtension` keeps a chat's: a job
   * that last loaded an older build than the one on disk, or that already ran when this service first looked, is reloaded once it runs
   * nothing, one job at a time; a job that shows up later started on this build. A working job is looked at again on a later tick.
   */
  private refreshJobs(chatRows: readonly SessionRow[]): void {
    const first = this.jobsSeen === undefined;
    const seen = this.jobsSeen ??= new Set();
    for (const agent of chatRows.flatMap(row => row.agents ?? [])) {
      const id = agent.sessionId;
      if (!id || (agent.link !== "subagent" && agent.link !== "root") || this.chatIds.has(id) || this.jobsCurrent.has(id)) continue;
      const fresh = !first && !seen.has(id);
      seen.add(id);
      if (agent.state === "working" && !fresh) continue;
      this.queue("#reload", () => this.refreshJob(id, fresh));
    }
  }

  private async refreshJob(id: string, fresh: boolean): Promise<void> {
    if (this.jobsCurrent.has(id)) return;
    try {
      const loaded = await this.loads.get(id);
      if (!(loaded === undefined && fresh) && reloadAction(loaded, this.build, false) === "reload") {
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
    try {
      const state = await this.threads.view(threadId);
      const stall = state ? turnStall(turnViewOf(state, this.threads.running(threadId)), now) : null;
      const last = this.jobWakes.get(threadId);
      const action = jobWake({ stall, last, woke, now });
      if (action === "none") {
        this.jobWakes.delete(threadId);
        this.jobQuiet.set(threadId, stamp);
        if (job && state) this.queue(job.chat, () => this.jobEndNote(threadId, job));
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
    if (view.running && !view.retrying) return;
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
    const action = stallAction({ stall, down, claude, attempts: last?.attempts ?? 0, since: last?.at ?? Math.min(stall.at, seen), now, woke });
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
    if (this.chatIds.has(threadId)) return;
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

  private state(id: string, setting: CheckInSetting, now: number): CheckInView {
    const pausedUntil = activePause(setting, now);
    const lastAt = this.lastCheckIn.get(id) ?? null;
    return { everyMs: setting.everyMs, paused: pausedUntil !== null, nextAt: nextCheckIn(setting, lastAt ?? now - setting.everyMs, now), pausedUntil, lastAt };
  }

  /**
   * What `chatAgents` needs from the chat side for one chat: the hub's child snapshots, the board (the hub's copy while attached, else the file),
   * the roots the registry lists under the chat's name or id, and the transcript the hub holds. Empty for a thread that is not a chat.
   */
  async links(id: string): Promise<ChatLinks> {
    await this.load();
    if (!this.chatIds.has(id)) return { children: [], board: null, roots: [], messages: [] };
    const state = this.threads.state?.(id);
    const board = state?.board !== undefined ? state.board : await this.source.board(id).catch(() => null);
    const name = state?.info?.name?.trim();
    const roots = this.source.registry ? await this.source.registry.rootsOf(name ? [id, name] : [id]).catch(() => []) : [];
    return { children: this.children.get(id) ?? state?.children ?? [], board, roots, messages: state?.messages ?? [] };
  }

  /** The sessions stream's check-in field for every chat. */
  async checkIns(): Promise<ReadonlyMap<string, CheckInState>> {
    await this.load();
    const settings = await this.settings();
    const now = this.now();
    return new Map([...this.chatIds].map(id => {
      const { lastAt: _lastAt, ...state } = this.state(id, settings[id] ?? DEFAULT_CHECK_IN, now);
      return [id, state];
    }));
  }

  /** A chat's check-in as the owner's control shows it; null for a thread that is not a chat. */
  async checkInView(id: string): Promise<CheckInView | null> {
    await this.load();
    if (!this.chatIds.has(id)) return null;
    return this.state(id, await this.source.settings.get(id), this.now());
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
    return this.state(id, setting, now);
  }

  /**
   * One check-in run for a chat (Chats.tick at its interval, or the owner's Run now): the precheck in code (`checkInPrecheck`: each step's
   * class, the misses against the duty's targets), kept as the new memory, then handed to the duty runner, which starts one check-in job with
   * it as context (src/chat-duty-run.ts). Every run with something to check starts a job, met targets included; the job decides what needs
   * work. A chat with no job at work, no open plan step, no board read error and no ask overflow has nothing to check.
   */
  async checkIn(id: string, trigger: CheckInRun["trigger"] = "schedule"): Promise<void> {
    await this.load();
    if (!this.chatIds.has(id)) return;
    try {
      const { board, boardError, rows, facts, queued, name } = await this.gather(id);
      // With no catalog rows yet and no hub children, every job of the chat reads as missing (frontend bro 10-13 01:09 and 01:24, while the
      // daemon's list timed out after restarts: 7 false orphans each, and the duty runner skipped both runs anyway).
      if (!rows.length && !this.children.has(id)) {
        this.log(`chat ${id.slice(0, 8)}: check-in waits: the catalog has no rows yet and the hub has not attached the chat, so its jobs cannot be read`);
        const everyMs = (await this.source.settings.get(id)).everyMs;
        if (everyMs > CHECK_IN_RETRY_MS) this.lastCheckIn.set(id, this.now() - everyMs + CHECK_IN_RETRY_MS);
        return;
      }
      for (const fact of facts) if (fact.state === "failed" && fact.key.startsWith("thread:")) this.queue(fact.key, () => this.wakeOwner(fact.key.slice("thread:".length)));
      if (!checkInDue(facts, board, boardError)) return;
      const at = this.now();
      const self = name ? [id, name] : [id];
      const everyMs = (await this.source.settings.get(id)).everyMs;
      const duties = await this.source.duties?.(id).catch(error => { this.log(`chat ${id.slice(0, 8)}: check-in duties: ${error instanceof Error ? error.message : String(error)}`); return undefined; });
      const jobs = this.source.registry ? await this.source.registry.rootsOf(self).catch(() => []) : [];
      const heartbeats = readHeartbeats(heartbeatsFile(id, this.source.home));
      const train = await readTrain(trainFile(this.source.home));
      const previous = await this.source.memory.get(id);
      const precheck = checkInPrecheck(previous, facts, board, at,
        { self, rows, ...await this.ledger(id), everyMs, ...(duties ? { duties } : {}), jobs, heartbeats, queued, ...(train ? { train } : {}), ...(boardError !== undefined ? { boardError } : {}),
          owner: ownerSaid(this.messages(id) ?? []) });
      // A job at work an hour with no report gets one status ask through the chat; the check-in job cannot message the chat's subagents.
      const said = this.stall(id) ? undefined : this.messages(id);
      for (const ask of said ? statusAsks(said, facts, key => this.workingSince.get(key), at) : []) {
        await this.threads.prompt(id, { message: ask, images: [], mode: "steer" }).catch(error => this.log(`chat ${id.slice(0, 8)}: status ask: ${error instanceof Error ? error.message : String(error)}`));
      }
      const output = convergenceMisses(id, precheck.steps, precheck, await this.source.memory.ends(id), everyMs, at);
      const flags = flagStreaks(previous?.flags, output.flagged);
      await this.source.memory.set(id, { ...precheck.memory, flags });
      const start = await this.source.duty?.checkIn(id, { at, trigger, everyMs, output, classes: classCounts(precheck.steps),
        findings: checkInPrecheckText(precheck, facts, output.flagged, at, flags) });
      if (start === "failed" && everyMs > CHECK_IN_RETRY_MS) this.lastCheckIn.set(id, at - everyMs + CHECK_IN_RETRY_MS);
    } catch (error) {
      this.log(`chat ${id.slice(0, 8)}: check-in: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** What a check-in reads: the board (or why it cannot be read), the catalog rows, the chat's name, and its jobs with their last messages. */
  private async gather(id: string): Promise<{ board: ChatBoard | null; boardError?: string; rows: readonly SessionRow[]; facts: ReturnType<typeof jobFacts>;
    queued: ReadonlyMap<string, QueuePlace>; name?: string }> {
    let board: ChatBoard | null = null;
    let boardError: string | undefined;
    try { board = await this.source.board(id); }
    catch (error) { boardError = error instanceof Error ? error.message : String(error); this.log(`chat ${id.slice(0, 8)}: check-in board: ${boardError}`); }
    const rows = await this.source.rows();
    const said = lastJobMessages(this.messages(id) ?? []);
    // A chat not attached on this serve has no hub children; its row lists the daemon's sessions under it. A step's owner may be a subagent of
    // one of its duty jobs (10-13 02:39: busy chat inbox ran under the 01:54 check-in job, and p334 read "(busy chat inbox not found)").
    const dutyJobs = await this.source.dutyJobs?.(id).catch(() => []) ?? [];
    const nested = dutyJobs.flatMap(job => (this.subagents.get(job) ?? []).map(child => ({ ...child, parentId: job })));
    const children = this.children.get(id) ?? agentChildren(rows.find(row => row.id === id)?.agents ?? []);
    const live = liveJobs([...children, ...nested], this.subagents, this.now(), liveWindowMs((await this.source.settings.get(id)).everyMs));
    const threads = liveThreads(jobFacts(children, board, rows, id, nested, live), session => readHeartbeats(heartbeatsFile(session, this.source.home)), this.now());
    const queued = await this.source.queue?.().catch(() => undefined) ?? new Map<string, QueuePlace>();
    const facts = withQueuePlaces(threads.map(fact => {
      const lastMessage = fact.key.startsWith("thread:") ? undefined : said.get(fact.name);
      return lastMessage ? { ...fact, lastMessage } : fact;
    }), queued, [...this.subagents.values()].flat().concat(children, nested));
    const name = rows.find(row => row.id === id)?.name;
    return { board, ...(boardError !== undefined ? { boardError } : {}), rows, facts, queued, ...(name ? { name } : {}) };
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

  /** The owner's Run now on the check-in duty: a check-in at once, in the chat's check-in lane, and its schedule starts over. */
  runCheckIn(id: string): Promise<void> {
    return new Promise(resolve => this.queue(checkInLane(id), async () => {
      try { if (this.chatIds.has(id)) { this.lastCheckIn.set(id, this.now()); await this.checkIn(id, "owner"); } } finally { resolve(); }
    }));
  }

  /**
   * A job that stopped working without a report is checked again after a grace period: a job between two tool calls, resumed by a reply, or
   * deleted in the meantime is not reported. Each end is reported once. While the chat is mid-turn, the daemon holds a job's report to it
   * until the chat's tool call ends, so the check waits for that, up to NO_REPORT_BUSY_TRIES graces (VP of CI 10-13: a report queued at 09:47:30Z
   * landed at 09:52:15Z, 3 s after a notice that said the job sent none).
   */
  private laterNoReport(id: string, childId: string, tries = 0): void {
    const timer = setTimeout(() => this.queue(id, () => this.noReport(id, childId, tries)), this.source.noReportGraceMs ?? NO_REPORT_GRACE_MS);
    timer.unref?.();
  }

  private async noReport(id: string, childId: string, tries: number): Promise<void> {
    await this.load();
    if (!this.chatIds.has(id)) return;
    const child = this.children.get(id)?.find(candidate => candidate.id === childId);
    if (!child || childWorking(child) || child.status === "cancelled" || child.repliedSinceTask !== false) return;
    if (this.threads.busy(id) && tries < NO_REPORT_BUSY_TRIES && !this.stall(id)) { this.laterNoReport(id, childId, tries + 1); return; }
    const lastMessage = lastJobMessages(this.messages(id) ?? []).get(childName(child));
    const wokeAt = this.workingSince.get(child.id) ?? 0;
    const waited = lastMessage !== undefined && lastMessage.at >= wokeAt ? lastMessage.at : undefined;
    const end = child.lastActivityAt ?? this.now();
    const told = this.noticedEnd.get(child.id);
    if (told !== undefined && Math.abs(end - told.end) < NO_REPORT_SAME_END_MS && told.waited === waited) return;
    this.noticedEnd.set(child.id, { end, ...(waited !== undefined ? { waited } : {}) });
    if (this.stall(id)) { this.log(`chat ${id.slice(0, 8)}: no notice for ${childName(child)}: the chat's last turn failed; the next check-in job sees it`); return; }
    const line = `${JOB_NOTICE_PREFIX}${noReportNotice(childName(child), lastMessage, wokeAt, end)}`;
    if (noticeStands(this.messages(id) ?? [], childName(child), line)) return;
    try {
      await this.threads.prompt(id, { message: line, images: [], mode: "steer" });
    } catch (error) { this.log(`chat ${id.slice(0, 8)}: no-report notice: ${error instanceof Error ? error.message : String(error)}`); }
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
    if (!this.chatIds.has(chat)) return;
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
      await this.threads.prompt(chat, { message: JOB_NOTICE_PREFIX + jobEndText(name, end), images: [], mode: "steer" });
      await this.source.memory.told(chat, key, { at: end.at, cause: end.cause });
      this.log(`chat ${chat.slice(0, 8)}: job ${name} ended (${end.cause}) with no report; told the chat`);
      if (child) this.noticedEnd.set(child.id, { end: child.lastActivityAt ?? end.at });
    } catch (error) {
      this.log(`chat ${chat.slice(0, 8)}: job end note for ${agent.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
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
      this.log(`chat ${id.slice(0, 8)}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Reloads the chat when the build it last loaded is not the one on disk, or the owner asked to update every chat: now if it is idle, else once
   * its turn ends. The reload keeps the brief the chat pinned in its system prompt, so its cached prompt stays valid; a reload onto a changed
   * brief leaves one notice in the transcript with what changed. The model reads it on its next turn, whatever starts that turn, and it starts
   * no turn itself.
   */
  private async refreshExtension(id: string): Promise<void> {
    await this.load();
    if (!this.chatIds.has(id)) return;
    const forced = this.forced.has(id);
    let action: "reload" | "wait" | null = null;
    try {
      action = reloadAction(await this.loads.get(id), this.build, this.threads.busy(id), forced);
      if (action === "wait") { this.reloadWaiting.add(id); return; }
      this.reloadWaiting.delete(id);
      if (!action) return;
      await this.threads.reload(id);
      const before = await this.loads.set(id, this.build, this.brief);
      this.log(`chat ${id.slice(0, 8)}: extension reloaded, build ${this.build}, brief ${this.brief.version}`);
      const note = before && briefNote(before, this.brief.lines);
      if (note) await this.threads.notice(id, note);
    } catch (error) {
      this.log(`chat ${id.slice(0, 8)}: reload: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      if (!this.reloadWaiting.has(id)) this.forced.delete(id);
      if (action !== null || forced) this.briefChanged();
    }
  }

  /**
   * At a turn's end, and when an idle chat attaches: when the chat's last reply on an owner turn has reply-lint findings (`replyCheck`) and is
   * at most REPLY_CHECK_MAX_AGE_MS old, one `[reply check]` steer naming them, once per reply across restarts (`replyChecks`). Plain text is
   * not stopped before the owner reads it; this asks for a corrected short reply when it misled, and the model's view carries the findings into
   * the next owner message either way.
   */
  private async replyCheck(id: string): Promise<void> {
    await this.load();
    const messages = this.chatIds.has(id) ? this.messages(id) : undefined;
    const check = messages && replyCheck(messages);
    if (!check || this.now() - check.at > REPLY_CHECK_MAX_AGE_MS) return;
    try {
      if (!await this.source.replyChecks.claim(id, check.at)) return;
      await this.threads.prompt(id, { message: check.message, images: [], mode: "steer" });
    } catch (error) { this.log(`chat ${id.slice(0, 8)}: reply check: ${error instanceof Error ? error.message : String(error)}`); }
  }

  /**
   * At a turn's end, and when an idle chat attaches: once the turn that read the chat's newest duty report with board ops ended, one `[board]`
   * steer naming the ops it left off the board (`opsSteer`). The hub clips the report and the chat_board arguments, so this reads the session file.
   */
  private async opsCheck(id: string): Promise<void> {
    await this.load();
    const said = this.chatIds.has(id) ? this.messages(id) : undefined;
    const at = said && newestReportAt(said);
    if (at === undefined || this.opsJudged.get(id) === at) return;
    try {
      const sessionFile = (await this.summary(id))?.sessionFile;
      const messages = sessionFile ? await tailMessages(sessionFile) : undefined;
      const line = messages && opsSteer(messages, await this.source.board(id));
      if (line === undefined) return;
      if (line) await this.threads.prompt(id, { message: line, images: [], mode: "steer" });
      this.opsJudged.set(id, at);
    } catch (error) { this.log(`chat ${id.slice(0, 8)}: board ops check: ${error instanceof Error ? error.message : String(error)}`); }
  }

  /**
   * When a chat's direct subagent first shows up: its brief, the `prompt` the daemon stored at the spawn, is checked against the Jobs rule
   * (`briefCheckWithHistory`) with the chat's owner messages, the owner message that started the spawning turn and the chat's previous spawn. On findings
   * the chat gets one `[brief check]` steer naming the job; the spawn is never held. Once per job across restarts (`briefChecks`); a job
   * spawned more than BRIEF_CHECK_MAX_AGE_MS before the server first reads it is left alone. A spawn record not written yet is read again
   * at the next children change.
   */
  private async briefCheck(chat: string, child: ChildAgent): Promise<void> {
    const record = this.source.briefChecks;
    if (!record || this.briefSeen.has(child.id)) return;
    await this.load();
    const messages = this.chatIds.has(chat) ? this.messages(chat) : undefined;
    if (!messages) return;
    try {
      const sessionFile = (await this.summary(chat))?.sessionFile;
      if (!sessionFile) return;
      const dir = artifactsDir(sessionFile);
      const spawn = await spawnRecord(join(dir, child.id));
      if (!spawn) return;
      this.briefSeen.add(child.id);
      this.spawnTimes.set(join(dir, child.id), spawn.createdAt);
      if (this.now() - spawn.createdAt > BRIEF_CHECK_MAX_AGE_MS) return;
      const findings = await briefCheckWithHistory({ brief: spawn.prompt, turnOwner: turnOwnerAt(messages, spawn.createdAt),
        previousSpawnAt: await previousSpawn(dir, spawn.createdAt, this.spawnTimes) }, messages, sessionFile);
      if (!findings.length || !await record.claim(child.id, spawn.createdAt)) return;
      await this.threads.prompt(chat, { message: briefCheckNote(childName(child), findings), images: [], mode: "steer" });
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

  close(): void { clearInterval(this.timer); this.unobserve(); }
}
