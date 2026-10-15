import { execFile } from "node:child_process";
import { copyFile, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type DutyJobHost, dutyJobBrief, type DutyJobInput, dutyJobName, fixJobBrief, fixJobName, fixMessage } from "./chat-duty-job.ts";
import type { CheckInActor } from "./checkin-settings.ts";
import type { DutyAdmitter } from "./chat-turn-queue.ts";
import type { DutyStore } from "./chat-duty-store.ts";
import { agentScheduleProblem, type AfterMeasure, CHECK_IN_DUTY, CHECK_IN_DUTY_ID, dailySlot, dutyDue, ERROR_PAUSE_RUNS, errorStreak, judge, nextRunAt, parseSchedule, type Duty, type DutyJobRef,
  type DutyMetric, type DutyRunRecord, type DutySchedule, type DutyTrigger, type DutyView, type FixLink, type FlaggedSlice, type PrecheckOutput, verdictMetrics } from "./shared/chat-duties.ts";
import { closedFixes, dutyFixes, dutyLink, fixStepOps, missedKeys } from "./shared/duty-fixes.ts";
import { CHANGE_APPROACH_MISSES, metricStreaks, missStreak, type MetricStreak } from "./shared/duty-streak.ts";
import { type BoardOp, CHECK_IN_MAX_MINUTES, CHECK_IN_MIN_MINUTES, type ChatBoard, type CheckInPause, type CheckInView, type PlanItem, type PoolPriority } from "./shared/types.ts";

/** The check-in duty's side on the chat server (src/chats.ts): its setting (the header's control writes the same one) and a run now. */
export interface CheckInDutyHost {
  view(chatId: string): Promise<CheckInView | null>;
  set(chatId: string, change: { everyMs?: number; pause?: CheckInPause | null }, actor: CheckInActor): Promise<CheckInView | null>;
  /** A check-in run now; `trigger` "verify" when a fix step linked to a check-in metric closed. */
  run(chatId: string, trigger?: DutyTrigger): Promise<void>;
  /**
   * The check-in measure as a run would take it now, with no side effects, for a run's after-job measure; null when it cannot be read yet.
   * Absent (test fakes): a check-in run gets its after-job measure only from the next run.
   */
  measure?(chatId: string): Promise<CheckInRun["output"] | null>;
}
/**
 * One run of the check-in duty as the chat server measured it: the slot time, its trigger, the chat's check-in interval, the misses, the step
 * classes, and the findings for the job's brief.
 */
export interface CheckInRun {
  at: number; trigger: DutyTrigger; everyMs: number; output: PrecheckOutput & { flagged: FlaggedSlice[] }; classes: Record<string, number>; findings: string;
}

/** What the runner needs from the server: which threads are chats, and the duty jobs. Tests pass fakes. */
export interface DutyHost {
  isChat(id: string): Promise<boolean>;
  jobs: DutyJobHost;
  /** The built-in check-in duty. Absent (tests of standing duties): the card lists no check-in. */
  checkIn?: CheckInDutyHost;
  log?: (line: string) => void;
  now?: () => number;
  /** How often the runner looks for due duties; 0 starts no timer (tests call `tick`). Default DUTY_TICK_MS. */
  tickMs?: number;
  /** The node binary a precheck whose first word is `node` runs with; default this process's. */
  node?: string;
  /** The daemon health gate (src/chat-daemon-gate.ts): each wake lets it probe the daemon, one probe at a time. */
  daemon?: { tick(): Promise<void> };
  /** The Mac-wide turn queue's wait before a duty job's session is created (`dutyAdmitter`); absent: every job starts at once. */
  admit?: DutyAdmitter["admit"];
  /** The chat's pool class from its sidebar label (`chatPoolPriority`), for the card; absent: high, as for an unlabelled chat. */
  priority?: (chatId: string) => Promise<PoolPriority>;
  /** The chat's board, where each missed metric's fix step lives (`dutyFixes`); absent: runs record no fixes and send no job back. */
  board?: (chatId: string) => Promise<ChatBoard | null>;
  /** Whether a fix step's job is at work now (`fixJobLive`); absent: no fix counts as live. */
  fixLive?: (chatId: string, item: PlanItem) => Promise<boolean>;
  /** Applies board ops built from the board inside the write's lock, as an agent; absent: the server opens no fix job (`ownFixes`). */
  applyBoard?: (chatId: string, ops: (board: ChatBoard) => readonly BoardOp[]) => Promise<unknown>;
}

/** The part of a duty, the check-in included, its fix job needs. */
type FixDuty = Pick<Duty, "id" | "name" | "goal" | "metrics" | "boardGoal">;
const FIX_OPEN: ReadonlySet<PlanItem["status"]> = new Set(["todo", "doing", "blocked"]);

export const DUTY_TICK_MS = 30_000;
/** The card shows this many runs per duty. */
export const VIEW_RUNS = 14;
/**
 * What the check-in job looks at besides the generic duty rules (owner 10-09: "fixes quirks like agents giving up"; Crawler VP 10-09: "split
 * tasks to subagent & Jobs actively").
 */
export const CHECK_IN_FOCUS: readonly string[] = [
  "Your number is the stuck count the precheck opens with (owner 10-14: \"all the PLAN list should clear or be stuck in FOR YOU\"). Every step " +
    "under Stuck steps ends this run with a live owner (steer its job, or start one with rlm.create_session and set the step's job), a For you " +
    "todo that links it when only the owner can unblock it, or a close on evidence. A chase message, a new wait text or a later waitUntil " +
    "leaves it stuck. Report the stuck count before and after your run.",
  "Organize the plan first, in every run, with board ops: close or fold what shipped (name the evidence), move a loose step under its goal with " +
    "plan_update parent, remove a step another thread now owns (one scratch note names the new owner), close a step a duty now covers, and fix " +
    "stale notes. A run that only rewrites notes and wait times while Plan shape or Look done lists items has not done its job: the owner should " +
    "never have to ask a chat to tidy its plan (c44, owner 10-12).",
  "A goal held only by other threads (Plan shape lists it) or a step whose wait is over is finished work behind a wait: check the wait " +
    "against the real state in this run (the release holds the commit, the land is green, the thread answered). When it is met, close the " +
    "step and the goal on that evidence. When it is not, send the holding thread the leftover in one message with what it must check, close " +
    "the step here with a note naming that thread, and close the goal. A wait being new is no reason to keep the goal open (c45, owner 10-12: " +
    "\"even for simple shit like this, it doesn't close/update plan desplite actually have finished\").",
  "Then push every goal: a job or thread that stalled, died or ended without a report gets a message, a restart or a replacement in this run, and " +
    "an open goal with independent work and no live job gets jobs at once, in parallel, each fanning out one subagent per unit of output. A finding " +
    "the last check-ins already listed is yours to finish now, not to list again.",
];
/**
 * How a check-in run ended for the scheduler: `failed` when its job could not start (a daemon create or brief error), so the chat retries in
 * CHECK_IN_RETRY_MS instead of a whole interval (slack green guy 10-12: "daemon client closed" at 04:54Z, and its next try was 05:54Z).
 */
export type CheckInStart = "done" | "failed";
/**
 * Why a run started no job because the duty's last job still works. A standing duty's run still measures and records its verdict, with this
 * after its summary (ops guy 10-10 to 10-12: 220 of 293 Local dev servers runs skipped the precheck too); a check-in run is recorded as skipped.
 */
export const STILL_WORKING = "skipped: previous run still working";
/**
 * Why a slot of a standing duty ran nothing: its last run was still measuring or starting its job (ops guy 10-12: the 14:35Z run took 19 min
 * to start its job under load, and the 14:45Z slot left no record).
 */
export const STILL_GOING = "skipped: previous run still";
/** A duty job may work this long before a later run counts it as stuck, however short its duty's interval. */
export const STUCK_MIN_MS = 90 * 60_000;
/**
 * A duty job still working this long after its run started is stuck, however long its duty's interval: a daily slot can run CATCH_UP_MS (6 h)
 * late, so the next slot can come 18 h after its job started, and the limit must be under that.
 */
export const STUCK_MAX_MS = 12 * 60 * 60_000;
/**
 * How long a duty job may work before the next run of its duty retires it as stuck and starts a new one: one interval, at least STUCK_MIN_MS and
 * at most STUCK_MAX_MS. A daily duty's interval is a day. Without the limit one hung job skipped every later run: slack green guy 10-10, 37 h with
 * no check-in; ops guy 10-11, a 10-minute duty skipped for 17 h; AI harness VP 10-11, three daily duties skipped a day on jobs whose model
 * requests hung for hours and were aborted at each restart.
 */
export function stuckAfterMs(schedule: DutySchedule): number {
  return Math.min(Math.max(intervalMs(schedule), STUCK_MIN_MS), STUCK_MAX_MS);
}

/** The time between two slots of a schedule; a daily duty's is a day. */
export const intervalMs = (schedule: DutySchedule): number => schedule.kind === "every" ? schedule.minutes * 60_000 : 24 * 60 * 60_000;

/** Why a run has no job when its start failed or a restart cut it off; a run with it is never started again. */
export const NOT_STARTED = "the duty job did not start";
/** A run's job start in progress, kept in `<dutyId>.pending.json` until the start ends, so a restart can finish it (`Duties.resume`). */
interface PendingStart {
  at: number; schedule: DutySchedule; measured: AfterMeasure | null;
  brief: Pick<DutyJobInput, "measure" | "findings" | "focus" | "misses">;
}
async function readPending(file: string): Promise<PendingStart | null> {
  try { const value = JSON.parse(await readFile(file, "utf8")) as PendingStart; return typeof value?.at === "number" && value.schedule && value.brief ? value : null; }
  catch { return null; }
}

const pad = (value: number): string => String(value).padStart(2, "0");
/** `261008-2307`, local time: names a run's saved output. */
export function runStamp(at: number): string {
  const date = new Date(at);
  return `${pad(date.getFullYear() % 100)}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`;
}

/** What a run's start of its duty job did: started one (`replaced` notes a stuck job it retired), skipped with why, or nothing (the slot already has its job). */
type Launched = { job: DutyJobRef; replaced?: string } | { skipped: string } | null;
/** The duty's last job as a new run finds it: the slot already has its job (null), it still works (skip), or it is the job to retire, if any. */
type Previous = { last?: DutyJobRef; lastRun?: DutyRunRecord; replaced?: string } | { skipped: string } | null;

const message = (error: unknown): string => error instanceof Error ? error.message : String(error);

/** The keys of the metrics a duty's verdict counts (`verdictMetrics`); old run records still carry every metric the duty once had. */
const verdictKeys = (metrics: readonly DutyMetric[]): Set<string> => new Set(verdictMetrics(metrics).map(metric => metric.key));

/** The findings line for the stuck metrics (`MetricStreak.stuck`): each one names its streak and the fix that did not move it. Empty when none is stuck. */
export function stuckFindings(misses: readonly MetricStreak[]): string {
  const stuck = misses.filter(miss => miss.stuck);
  if (!stuck.length) return "";
  return `### Change approach\n${stuck.map(miss => `- ${miss.key} missed ${miss.misses} runs in a row and did not move toward its target` +
    `${miss.fix ? `; the fix ${miss.fix.step}${miss.fix.job ? ` by ${miss.fix.job}` : ""} did not move it` : ""}. This run starts a new root-cause job for it, not the same fix again.`).join("\n")}`;
}

/** The check-in duty's cadence in minutes: `{ kind: every, minutes }` with a whole number the check-in setting takes. */
function checkInMinutes(value: unknown): number {
  const minutes = typeof value === "object" && value !== null && (value as { kind?: unknown }).kind === "every" ? (value as { minutes?: unknown }).minutes : undefined;
  if (typeof minutes !== "number" || !Number.isInteger(minutes) || minutes < CHECK_IN_MIN_MINUTES || minutes > CHECK_IN_MAX_MINUTES) {
    throw new Error(`The check-in runs every ${CHECK_IN_MIN_MINUTES} to ${CHECK_IN_MAX_MINUTES} minutes.`);
  }
  return minutes;
}

/**
 * Runs each chat's due duties on the server: a skip policy on overlap (a duty with a run going starts no other, and each slot it holds up gets a skipped record), one catch-up for a daily slot
 * missed by at most CATCH_UP_MS, the precheck with the file contract and its timeout, the measure against the targets, and then one duty job
 * per run with the precheck as context (src/chat-duty-job.ts), met or missed. One job per duty per slot: a run whose slot already has a job
 * starts none, and while the duty's last job still works a run measures but starts no job and says so in its summary, unless that job is stuck past
 * `stuckAfterMs` of its duty's schedule, which the run replaces. The run that starts a job retires the
 * last one: it leaves the registry at once and its archive is queued, so a slow daemon never holds up the start. A precheck that errors ERROR_PAUSE_RUNS times in a row pauses the duty; that run's job is told to fix it. The check-in duty's
 * schedule and precheck live on the chat server, which hands each run here (`checkIn`); its card reads and edits the chat's check-in setting.
 */
/**
 * What the server sends a duty job whose turn ended while a missed metric has no fix step with a live job (`unownedFixes`), so the job goes on
 * working instead of ending its run on a miss nobody owns. A stuck metric must get a new step, not the fix that did not move it.
 */
export function unownedMessage(duty: string, dutyId: string, misses: readonly { key: string; stuck: boolean; fix?: FixLink }[]): string {
  const lines = misses.map(miss => `- ${miss.key}: ${miss.stuck ? `missed ${CHANGE_APPROACH_MISSES} or more runs with no move${miss.fix ? `, and ${miss.fix.step} did not move it` : ""}. ` +
    "Start a new root-cause job with rlm.create_session that finds why the last fix did not work, and add a new plan step for it" :
    miss.fix ? `${miss.fix.step} has no live job. Start a fix job with rlm.create_session and set it as ${miss.fix.step}'s job, or add a new step if it is closed` :
    "no plan step fixes it. Start a fix job with rlm.create_session and add a plan step for it"} with duty ${JSON.stringify(dutyLink(dutyId, miss.key))} and that job.`);
  return `[duty] Your ${duty} run is not done: ${misses.length === 1 ? "a missed metric has" : `${misses.length} missed metrics have`} no fix step with a live job.\n` +
    `${lines.join("\n")}\nApply the board change with board-apply in this turn. Each fix job lands a code change that moves its number; a note or a ` +
    "later wait is not a fix. The server checks again when this turn ends.";
}

export class Duties {
  /** The run going per `<chatId>/<dutyId>`; a second start shares it. */
  private readonly running = new Map<string, Promise<CheckInStart | void>>();
  /** What each standing duty run going now does, with its start time, for the record of a slot it holds up. */
  private readonly steps = new Map<string, { at: number; step: "reading the catalog" | "measuring" | "waiting for a working slot" | "starting its job" }>();
  /** Duty jobs whose archive `stopEnded` queued, so each is queued once. */
  private readonly stopped = new Set<string>();
  /** The board rev each duty job was sent back at for its unowned misses; a job that ends again with no board change since is stopped. */
  private readonly sentBack = new Map<string, number>();
  /** Duty jobs whose ended turn `stopEnded` handles now (after-job measure, then send back or archive); `ownFixes` leaves their duty to it. */
  private readonly handling = new Set<string>();
  /** The duties (`<chatId>/<dutyId>`) whose fix job `ownFixes` opens or sends back now. */
  private readonly owning = new Set<string>();
  /** The board rev each fix job was sent back at (`ownFixes`); a fix job that ends again with no board change since gets a new fix job in its place. */
  private readonly fixSentBack = new Map<string, number>();
  /** The last board each chat's watch showed, to find the fix steps a change closed (`boardChanged`). */
  private readonly boards = new Map<string, ChatBoard>();
  /** Each ended last job's after-job measure and then its archive (`stopEnded`), kept off the tick so a slow precheck holds up no due duty. */
  private readonly ending = new Set<Promise<void>>();
  private readonly timer: ReturnType<typeof setInterval> | undefined;
  private readonly now: () => number;
  private ticking: Promise<void> | undefined;

  constructor(readonly store: DutyStore, private readonly host: DutyHost) {
    this.now = host.now ?? Date.now;
    const tickMs = host.tickMs ?? DUTY_TICK_MS;
    if (tickMs > 0) {
      this.timer = setInterval(() => { void this.tick(); }, tickMs);
      this.timer.unref();
    }
  }

  private log(line: string): void { this.host.log?.(line); }

  /** One wake: every duty of every chat that is due starts, and a daily slot too late to run is recorded as skipped. */
  tick(): Promise<void> {
    void this.host.daemon?.tick().catch(error => this.log(`duties: daemon probe: ${message(error)}`));
    const scan = this.ticking ??= this.scan().catch(error => this.log(`duties: tick: ${message(error)}`)).finally(() => { this.ticking = undefined; });
    return scan.then(async () => { await Promise.all([...this.ending]); });
  }

  private async scan(): Promise<void> {
    const chats: string[] = [];
    for (const chatId of await this.store.chats()) {
      if (!(await this.host.isChat(chatId))) continue;
      chats.push(chatId);
      await this.resume(chatId);
      if (!this.boards.has(chatId)) {
        const board = await this.host.board?.(chatId).catch(() => null);
        if (board && !this.boards.has(chatId)) this.boards.set(chatId, board);
      }
      for (const duty of await this.store.list(chatId)) {
        const due = dutyDue(duty, this.now());
        if (due.kind === "skip") await this.skip(chatId, duty, due.slot);
        else if (due.kind === "run" && !this.start(chatId, duty.id, due.trigger, due.slot)) await this.skipBusy(chatId, duty, due.slot);
      }
    }
    const runs = new Map<string, DutyRunRecord[]>();
    for (const chatId of chats) runs.set(chatId, await this.store.runs(chatId));
    await this.stopEnded(runs);
    await this.ownFixes(runs);
  }

  /**
   * Measures each duty's last job's run again once that job's turn has ended (`measureAfter`), then sends the job back while a miss has no fix
   * step with a live job (`sendBack`) or archives it, instead of at the next run; and archives any older duty job still up. A run's verdict is read after its own fixes this way (chat 01a1164b 10-15: a check-in counted
   * loose_goals as a miss after its job gave p447 a step). The measure and archive run off the tick, since a precheck may take up to its
   * timeout (120 s by default; SEO new-articles took 74 s on 10-15). The archive matters because an ended job kept its
   * worker and Python kernel until then (10-13 00:10 KST: 6 ended duty jobs held 1.9 GB on a 32 GB Mac with 30.4 of 30.7 GB swap used, and a
   * daemon gate pause kept the 22:15 to 22:33 check-in jobs 88 to 102 min). An older job is one a later run retired whose archive did not stop it:
   * "local dev servers ops guy (+observability) 22:24" of 10-10 was still loaded on 10-13 after its file said archived. A duty with a run going
   * keeps its last job for that run. Each job is queued once; an agent message resumes it.
   */
  private async stopEnded(runsByChat: ReadonlyMap<string, readonly DutyRunRecord[]>): Promise<void> {
    const jobs = this.host.jobs;
    if (!jobs.ended || !jobs.stop) return;
    const stop = jobs.stop.bind(jobs);
    const last = new Map<string, { chatId: string; run: DutyRunRecord & { job: DutyJobRef } }>();
    const older = new Map<string, DutyJobRef>();
    for (const [chatId, runs] of runsByChat) {
      const seen = new Set<string>();
      for (const run of runs) {
        if (!run.job) continue;
        const newest = !seen.has(run.duty);
        seen.add(run.duty);
        if (this.stopped.has(run.job.id)) continue;
        if (!newest) older.set(run.job.id, run.job);
        else if (!this.running.has(`${chatId}/${run.duty}`)) last.set(run.job.id, { chatId, run: run as DutyRunRecord & { job: DutyJobRef } });
      }
    }
    for (const id of last.keys()) older.delete(id);
    for (const job of await jobs.ended([...last.values()].map(entry => entry.run.job), [...older.values()])) {
      this.stopped.add(job.id);
      const ended = last.get(job.id);
      if (!ended) {
        await stop(job);
        this.log(`duty job ${job.name}: an older job still up; queued its archive`);
        continue;
      }
      const task = this.measureAfter(ended.chatId, ended.run)
        .then(async () => {
          if (await this.sendBack(ended.chatId, job, ended.run.duty)) { this.stopped.delete(job.id); return; }
          await stop(job);
          this.log(`duty job ${job.name}: its turn ended; queued its archive`);
        })
        .catch(error => this.log(`duty job ${job.name}: after its turn ended: ${message(error)}`))
        .finally(() => { this.ending.delete(task); this.handling.delete(job.id); });
      this.handling.add(job.id);
      this.ending.add(task);
    }
  }

  private async fixesOn(board: ChatBoard | null, chatId: string, dutyId: string, metrics: readonly string[]): Promise<Record<string, FixLink>> {
    const live = this.host.fixLive;
    return dutyFixes(board, dutyId, metrics, item => live ? live(chatId, item).catch(() => false) : Promise.resolve(false));
  }

  /** Fills a missed run's `fixes` from the board, and returns its miss streaks with them (`metricStreaks`, from `previous` newest first). */
  private async missesOf(chatId: string, record: DutyRunRecord, previous: readonly DutyRunRecord[], metrics: readonly DutyMetric[]): Promise<MetricStreak[]> {
    if (record.verdict !== "missed") return [];
    const counted = verdictKeys(metrics);
    const board = this.host.board ? await this.host.board(chatId).catch(error => { this.log(`duty ${chatId.slice(0, 8)}/${record.duty}: read the board: ${message(error)}`); return null; }) : null;
    const fixes = await this.fixesOn(board, chatId, record.duty, missedKeys(record).filter(key => counted.has(key)));
    if (Object.keys(fixes).length) record.fixes = fixes;
    return metricStreaks([record, ...previous]).filter(streak => counted.has(streak.key));
  }

  /**
   * The newest measured verdict's missed metrics (`effectiveRun`, so the after-job measure when there is one) that have no fix step with a live
   * job on the board now. A stuck metric needs a new step: the fix the job's own run found (`own.fixes`) does not count for it.
   */
  private async unownedFixes(chatId: string, runs: readonly DutyRunRecord[], own: DutyRunRecord | undefined, metrics: readonly DutyMetric[]):
    Promise<{ rev: number; misses: { key: string; stuck: boolean; fix?: FixLink }[] }> {
    const counted = verdictKeys(metrics);
    const streaks = metricStreaks(runs).filter(streak => counted.has(streak.key));
    if (!streaks.length || !this.host.board) return { rev: 0, misses: [] };
    const board = await this.host.board(chatId);
    const fixes = await this.fixesOn(board, chatId, runs[0]!.duty, streaks.map(streak => streak.key));
    const owned = (streak: MetricStreak): boolean => {
      const fix = fixes[streak.key];
      return fix?.live === true && !(streak.stuck && own?.fixes?.[streak.key]?.step === fix.step);
    };
    const misses = streaks.filter(streak => !owned(streak)).map(streak => {
      const fix = fixes[streak.key] ?? own?.fixes?.[streak.key];
      return { key: streak.key, stuck: streak.stuck, ...(fix ? { fix } : {}) };
    });
    return { rev: board?.rev ?? 0, misses };
  }

  /**
   * A duty job whose turn ended goes back to work while its run's misses have no fix step with a live job (`unownedFixes`): the server sends it
   * one message naming each metric and what to do, and true says it was sent back. A job that ends again with the board where it was at the
   * last message did not act on it, so it is stopped like any ended job and the next run's brief names the miss again.
   */
  private async sendBack(chatId: string, job: DutyJobRef, dutyId: string): Promise<boolean> {
    const steer = this.host.jobs.steer;
    if (!steer) return false;
    // Read now, after the turn ended, so the run's after-job measure counts.
    const runs = (await this.store.runs(chatId)).filter(run => run.duty === dutyId);
    const own = runs.find(run => run.job?.id === job.id);
    const duty = own ? (own.duty === CHECK_IN_DUTY_ID ? CHECK_IN_DUTY : (await this.store.list(chatId)).find(entry => entry.id === own.duty)) : undefined;
    if (!own || !duty) return false;
    const { rev, misses } = await this.unownedFixes(chatId, runs, own, duty.metrics).catch(error => { this.log(`duty job ${job.name}: read its fixes: ${message(error)}`); return { rev: 0, misses: [] }; });
    if (!misses.length) { this.sentBack.delete(job.id); return false; }
    if (this.sentBack.get(job.id) === rev) {
      this.sentBack.delete(job.id);
      this.log(`duty job ${job.name}: ended again with ${misses.map(miss => miss.key).join(", ")} unowned and no board change since it was sent back`);
      return false;
    }
    try { await steer(job, unownedMessage(duty.name, own.duty, misses)); }
    catch (error) { this.log(`duty job ${job.name}: send it back: ${message(error)}`); return false; }
    this.sentBack.set(job.id, rev);
    this.log(`duty job ${job.name}: its turn ended with ${misses.map(miss => miss.key).join(", ")} unowned; sent it back`);
    return true;
  }

  /**
   * Gives every stuck duty a fix job that works, each tick. A duty that missed CHANGE_APPROACH_MISSES measured runs in a row, with no run going and
   * its last duty job over, and with a missed verdict metric that has no fix step whose job is live, gets one: an idle fix job on those steps is
   * sent back once per board change (`fixMessage`), else the server opens a fix job (`fixJobBrief`) and sets it on each metric's step
   * (`fixStepOps`). The send-back reaches a duty job only when its turn ends, so a duty whose job ended without a fix sat stuck until its next
   * slot: on 10-15 at 20:25 KST, 11 of the 12 stuck duties in 9 chats were daily ones whose last job had ended hours before with no linked step,
   * and the send-back had fired twice since it shipped at 18:22 KST.
   */
  private async ownFixes(runsByChat: ReadonlyMap<string, readonly DutyRunRecord[]>): Promise<void> {
    const readBoard = this.host.board;
    if (!readBoard || !this.host.applyBoard) return;
    for (const [chatId, runs] of runsByChat) {
      const checkIn = this.host.checkIn ? await this.host.checkIn.view(chatId).catch(() => null) : null;
      const duties: FixDuty[] = [...(checkIn && !checkIn.paused ? [CHECK_IN_DUTY] : []), ...(await this.store.list(chatId)).filter(duty => duty.status === "active")];
      let board: { value: ChatBoard | null } | undefined;
      for (const duty of duties) {
        const key = `${chatId}/${duty.id}`;
        if (this.running.has(key) || this.owning.has(key)) continue;
        const own = runs.filter(run => run.duty === duty.id);
        if (missStreak(own) < CHANGE_APPROACH_MISSES) continue;
        const last = own.find(run => run.job)?.job;
        if (last && (this.handling.has(last.id) || await this.host.jobs.working(last).catch(() => true))) continue;
        const counted = verdictKeys(duty.metrics);
        const streaks = metricStreaks(own).filter(streak => counted.has(streak.key));
        if (!streaks.length) continue;
        try { board ??= { value: await readBoard(chatId) }; }
        catch (error) { this.log(`duty ${chatId.slice(0, 8)}: read the board for its fix jobs: ${message(error)}`); break; }
        const fixes = await this.fixesOn(board.value, chatId, duty.id, streaks.map(streak => streak.key));
        const unowned = streaks.filter(streak => fixes[streak.key]?.live !== true).map(streak => {
          const fix = fixes[streak.key] ?? streak.fix;
          return fix ? { ...streak, fix } : streak;
        });
        if (!unowned.length) continue;
        this.owning.add(key);
        const task = this.ownFix(chatId, duty, board.value, unowned).catch(error => this.log(`duty ${chatId.slice(0, 8)}/${duty.id}: own its fix: ${message(error)}`))
          .finally(() => { this.owning.delete(key); this.ending.delete(task); });
        this.ending.add(task);
      }
    }
  }

  private async ownFix(chatId: string, duty: FixDuty, board: ChatBoard | null, misses: readonly MetricStreak[]): Promise<void> {
    const jobs = this.host.jobs;
    const rev = board?.rev ?? 0;
    const links = new Set(misses.map(miss => dutyLink(duty.id, miss.key)));
    const held = new Map<string, { job: DutyJobRef; steps: string[] }>();
    const visit = (items: readonly PlanItem[]) => {
      for (const item of items) {
        if (item.duty && links.has(item.duty) && FIX_OPEN.has(item.status) && item.job && item.sessionId) {
          const entry = held.get(item.sessionId) ?? { job: { id: item.sessionId, name: item.job }, steps: [] };
          entry.steps.push(item.id);
          held.set(item.sessionId, entry);
        }
        visit(item.children);
      }
    };
    visit(board?.plan ?? []);
    const idle = held.size && jobs.ended ? await jobs.ended([...held.values()].map(entry => entry.job)) : [];
    const back = jobs.steer ? idle.find(job => this.fixSentBack.get(job.id) !== rev) : undefined;
    if (back && jobs.steer) {
      const steps = held.get(back.id)?.steps ?? [];
      await jobs.steer(back, fixMessage(duty.name, steps, misses));
      this.fixSentBack.set(back.id, rev);
      this.log(`duty ${chatId.slice(0, 8)}/${duty.id}: fix job ${back.name} ended with ${steps.join(", ")} still missing; sent it back`);
      return;
    }
    const chat = await jobs.chat(chatId);
    if (!chat) return;
    const at = this.now();
    const name = fixJobName(duty.name, chat.name, at);
    const release = await this.host.admit?.(chatId, `${duty.id}-fix`) ?? null;
    let job: DutyJobRef;
    try { job = await jobs.start(chat, name, fixJobBrief({ duty, chat, job: name, at, misses })); }
    finally { await release?.().catch(error => this.log(`duty ${chatId.slice(0, 8)}/${duty.id}: release its fix job's turn queue key: ${message(error)}`)); }
    await this.host.applyBoard!(chatId, current => fixStepOps(current, duty, misses, job));
    this.log(`duty ${chatId.slice(0, 8)}/${duty.id}: ${misses.map(miss => miss.key).join(", ")} had no fix step with a live job after ` +
      `${CHANGE_APPROACH_MISSES} or more missed runs; opened ${job.name}`);
  }

  /**
   * A change to a chat's board, from its watch: each duty with a fix step that closed in it (`closedFixes`) starts one verify run, so the land is
   * measured at once instead of at the next slot. The first board seen for a chat only sets the base.
   */
  async boardChanged(chatId: string, board: ChatBoard): Promise<void> {
    const before = this.boards.get(chatId);
    this.boards.set(chatId, board);
    if (!before) return;
    const closed = closedFixes(before, board);
    for (const dutyId of new Set(closed.map(fix => fix.duty))) {
      const steps = closed.filter(fix => fix.duty === dutyId).map(fix => fix.step).join(", ");
      if (dutyId === CHECK_IN_DUTY_ID) {
        if (!this.host.checkIn) continue;
        this.log(`duty ${chatId.slice(0, 8)}/${dutyId}: fix ${steps} closed; a verify run starts`);
        void this.host.checkIn.run(chatId, "verify").catch(error => this.log(`duty ${chatId.slice(0, 8)}/${dutyId}: verify: ${message(error)}`));
        continue;
      }
      if (!(await this.store.list(chatId)).some(duty => duty.id === dutyId)) continue;
      const started = this.start(chatId, dutyId, "verify", null);
      this.log(`duty ${chatId.slice(0, 8)}/${dutyId}: fix ${steps} closed; ${started ? "a verify run starts" : "a run is going, so no verify run starts"}`);
    }
  }

  /**
   * Writes a run's after-job measure into its record (`after`), so `effectiveRun` reads the run's verdict once its job's fixes are in. The check-in
   * is measured by the chat server (`CheckInDutyHost.measure`); a standing duty reruns its precheck once with the file contract, keeping no state.
   * A precheck that fails gives an error measure; a check-in the server cannot read yet gives none.
   */
  private async measureAfter(chatId: string, run: DutyRunRecord): Promise<void> {
    const after = await this.afterMeasure(chatId, run.duty)
      .catch((error): AfterMeasure => ({ at: this.now(), verdict: "error", metrics: {}, summary: `the after-job measure failed: ${message(error).slice(0, 300)}` }));
    if (!after) return;
    await this.store.updateRun(chatId, run.duty, run.at, record => { record.after = after; });
    this.log(`duty ${chatId.slice(0, 8)}/${run.duty}: after its job, ${after.verdict}, ${after.summary}`);
  }

  private async afterMeasure(chatId: string, dutyId: string): Promise<AfterMeasure | null> {
    const at = this.now();
    if (dutyId === CHECK_IN_DUTY_ID) {
      const output = await this.host.checkIn?.measure?.(chatId);
      return output ? { at, ...judge(CHECK_IN_DUTY.metrics, output) } : null;
    }
    const duty = (await this.store.list(chatId)).find(entry => entry.id === dutyId);
    if (!duty) return null;
    const lastRuns = (await this.store.runs(chatId)).filter(run => run.duty === dutyId && run.verdict !== "skipped").slice(0, 10);
    const dir = this.store.chatDir(chatId);
    return { at, ...judge(duty.metrics, await this.precheck(duty, dir, join(dir, `${dutyId}.after.json`), lastRuns, "after")) };
  }

  private async skip(chatId: string, duty: Duty, slot: number): Promise<void> {
    const at = this.now();
    await this.store.update(chatId, duties => { const found = duties.find(entry => entry.id === duty.id); if (found) { found.lastSlotAt = slot; found.lastSkippedAt = at; } });
    await this.store.appendRun(chatId, { duty: duty.id, at, slot, trigger: "schedule", ms: 0, verdict: "skipped", metrics: {},
      summary: `the ${new Date(slot).toTimeString().slice(0, 5)} run was missed by more than 6 h (machine asleep)` });
    this.log(`duty ${chatId.slice(0, 8)}/${duty.id}: skipped a slot missed by more than 6 h`);
  }

  /**
   * Records a slot that came while the duty's last run still goes, so every slot has a record; the next slot is one interval later. A run still
   * reading the catalog has not taken its slot yet: it takes this one or leaves it due.
   */
  private async skipBusy(chatId: string, duty: Duty, slot: number): Promise<void> {
    const at = this.now();
    const going = this.steps.get(`${chatId}/${duty.id}`);
    if (going?.step === "reading the catalog") return;
    const summary = `${STILL_GOING} ${going?.step ?? "going"}${going ? ` (run of ${new Date(going.at).toTimeString().slice(0, 5)}, ${Math.round((at - going.at) / 1000)} s ago)` : ""}`;
    await this.store.update(chatId, duties => {
      const found = duties.find(entry => entry.id === duty.id);
      if (!found) return;
      found.lastSkippedAt = at;
      if (found.schedule.kind === "every") found.lastRunAt = at;
      else found.lastSlotAt = slot;
    });
    await this.store.appendRun(chatId, { duty: duty.id, at, slot, trigger: "schedule", ms: 0, verdict: "skipped", metrics: {}, summary });
    this.log(`duty ${chatId.slice(0, 8)}/${duty.id}: ${summary}`);
  }

  /** Starts a run unless one is going; false when it was already running. */
  private start(chatId: string, dutyId: string, trigger: DutyTrigger, slot: number | null): boolean {
    const key = `${chatId}/${dutyId}`;
    if (this.running.has(key)) return false;
    const run = this.run(chatId, dutyId, trigger, slot).catch(error => this.log(`duty ${chatId.slice(0, 8)}/${dutyId}: ${message(error)}`))
      .finally(() => { this.running.delete(key); this.steps.delete(key); });
    this.running.set(key, run);
    return true;
  }

  /**
   * The owner's "Run now": false when the duty is unknown or already running. Paused duties run too; the pause only stops the schedule. The
   * check-in's run goes through the chat server's queue, which measures and hands it to `checkIn`.
   */
  async runNow(chatId: string, dutyId: string): Promise<boolean> {
    if (dutyId === CHECK_IN_DUTY_ID && this.host.checkIn) {
      if (this.running.has(`${chatId}/${dutyId}`)) return false;
      void this.host.checkIn.run(chatId).catch(error => this.log(`duty ${chatId.slice(0, 8)}/${dutyId}: ${message(error)}`));
      return true;
    }
    if (!(await this.store.list(chatId)).some(duty => duty.id === dutyId)) return false;
    return this.start(chatId, dutyId, "owner", null);
  }

  /**
   * Pause or resume; resuming a daily duty does not run the slots it missed while paused. False when the duty is unknown. The check-in duty's
   * pause is the chat's check-in pause until resumed, the same one the header's control sets, recorded as `actor`'s.
   */
  async setStatus(chatId: string, dutyId: string, status: Duty["status"], actor: CheckInActor): Promise<boolean> {
    if (dutyId === CHECK_IN_DUTY_ID && this.host.checkIn) return (await this.host.checkIn.set(chatId, { pause: status === "paused" ? "forever" : null }, actor)) !== null;
    const at = this.now();
    return this.store.update(chatId, duties => {
      const duty = duties.find(entry => entry.id === dutyId);
      if (!duty) return false;
      if (duty.status === "paused" && status === "active" && duty.schedule.kind === "daily") duty.lastSlotAt = at;
      duty.status = status;
      duty.updatedAt = at;
      return true;
    });
  }

  /**
   * A new cadence: every N minutes or a daily time. The check-in duty takes whole minutes from CHECK_IN_MIN_MINUTES to CHECK_IN_MAX_MINUTES and
   * writes the chat's check-in setting (the header's control shows the change); a daily time is refused for it. An agent may not run a standing
   * duty more often than daily (`agentScheduleProblem`, c66); the owner's page may. A daily duty moved to a time already past today waits for
   * tomorrow's slot. Throws on a bad or refused schedule; false when the duty is unknown.
   */
  async setSchedule(chatId: string, dutyId: string, value: unknown, actor: CheckInActor): Promise<boolean> {
    if (dutyId === CHECK_IN_DUTY_ID && this.host.checkIn) return (await this.host.checkIn.set(chatId, { everyMs: checkInMinutes(value) * 60_000 }, actor)) !== null;
    const schedule = parseSchedule(value);
    const refused = actor.by === "agent" ? agentScheduleProblem(schedule) : null;
    if (refused) throw new Error(refused);
    const at = this.now();
    return this.store.update(chatId, duties => {
      const duty = duties.find(entry => entry.id === dutyId);
      if (!duty) return false;
      duty.schedule = schedule;
      if (schedule.kind === "daily") duty.lastSlotAt = Math.max(duty.lastSlotAt ?? 0, dailySlot(schedule.at, at));
      duty.updatedAt = at;
      return true;
    });
  }

  async view(chatId: string): Promise<DutyView[]> {
    const [file, runs, checkIn, priority] = await Promise.all([this.store.read(chatId), this.store.runs(chatId), this.host.checkIn?.view(chatId) ?? null,
      this.host.priority?.(chatId) ?? "high" as const]);
    const now = this.now();
    const views: DutyView[] = file.duties.map(duty => ({ duty, schedule: duty.schedule, paused: duty.status === "paused", nextAt: nextRunAt(duty, now),
      running: this.running.has(`${chatId}/${duty.id}`), runs: runs.filter(run => run.duty === duty.id).slice(0, VIEW_RUNS), priority }));
    if (!checkIn) return views;
    return [{ duty: { ...CHECK_IN_DUTY, status: checkIn.paused ? "paused" : "active" }, builtin: "checkin", schedule: { kind: "every", minutes: Math.round(checkIn.everyMs / 60_000) },
      paused: checkIn.paused, nextAt: checkIn.nextAt, running: this.running.has(`${chatId}/${CHECK_IN_DUTY_ID}`),
      runs: runs.filter(run => run.duty === CHECK_IN_DUTY_ID).slice(0, VIEW_RUNS), priority }, ...views];
  }

  /**
   * One run of the check-in duty, measured by the chat server: its misses against `CHECK_IN_DUTY`'s targets, its step classes and flagged
   * items go in the record, and one check-in job starts with the findings as context (`launch`). A second call while one is going shares it.
   */
  checkIn(chatId: string, run: CheckInRun): Promise<CheckInStart> {
    const key = `${chatId}/${CHECK_IN_DUTY_ID}`;
    const going = this.running.get(key);
    if (going) return going.then(() => "done" as const);
    const task = this.checkInRun(chatId, run).catch((error): CheckInStart => { this.log(`duty ${chatId.slice(0, 8)}/${CHECK_IN_DUTY_ID}: ${message(error)}`); return "done"; })
      .finally(() => this.running.delete(key));
    this.running.set(key, task);
    return task;
  }

  private async checkInRun(chatId: string, run: CheckInRun): Promise<CheckInStart> {
    const judged = judge(CHECK_IN_DUTY.metrics, run.output);
    const record: DutyRunRecord = { duty: CHECK_IN_DUTY_ID, at: run.at, slot: run.at, trigger: run.trigger, ms: 0, verdict: judged.verdict, metrics: judged.metrics,
      summary: judged.summary, classes: run.classes, ...(run.output.flagged.length ? { flagged: run.output.flagged } : {}) };
    const previous = (await this.store.runs(chatId)).filter(entry => entry.duty === CHECK_IN_DUTY_ID);
    if (previous.some(entry => entry.slot === run.at && entry.job !== undefined)) return "done";
    const misses = await this.missesOf(chatId, record, previous, CHECK_IN_DUTY.metrics);
    await this.store.updateFile(chatId, file => {
      const state = file.checkIn ??= { createdAt: run.at, runCount: 0 };
      state.runCount += 1;
      state.lastRunAt = run.at;
    });
    const started = await this.startJob(chatId, record, CHECK_IN_DUTY, {
      schedule: { kind: "every", minutes: run.everyMs / 60_000 }, measured: judged.verdict === "error" ? null : { at: run.at, ...judged },
      brief: { measure: judged.summary, findings: [run.findings, stuckFindings(misses)].filter(Boolean).join("\n\n"), focus: CHECK_IN_FOCUS, misses } });
    return started === "failed" ? "failed" : "done";
  }

  private pendingFile(chatId: string, dutyId: string): string { return join(this.store.chatDir(chatId), `${dutyId}.pending.json`); }

  /**
   * Appends a measured run's record, then starts its duty job (`launch`) and writes the job, or why none started, into the record. The record
   * comes first because the start waits for a working slot in the Mac-wide turn queue, and a restart during that wait lost it: on 10-15 the
   * cc3dcb8 and 1ba8ab0 releases each dropped a measured Skills and tools Run now, and about 8 restarts from 09:11Z to 09:41Z left no check-in
   * recorded in any chat after 08:41Z. The job's brief is kept in `<dutyId>.pending.json` until the start ends, so `resume` can start the job
   * after a restart. A check-in run that starts no job is recorded as skipped; a standing duty's keeps its verdict and says why in its summary.
   */
  private async startJob(chatId: string, record: DutyRunRecord, duty: DutyJobInput["duty"], pending: Omit<PendingStart, "at">, append = true): Promise<"started" | "none" | "failed"> {
    const file = this.pendingFile(chatId, record.duty);
    const older = await readPending(file);
    await mkdir(this.store.chatDir(chatId), { recursive: true, mode: 0o700 });
    await writeFile(file, JSON.stringify({ at: record.at, ...pending } satisfies PendingStart), { mode: 0o600 });
    if (older && older.at !== record.at) await this.store.updateRun(chatId, record.duty, older.at, stored => { if (!stored.job) stored.summary += `; ${NOT_STARTED}: a later run took its place`; });
    if (append) await this.store.appendRun(chatId, record);
    let launched: Launched;
    let failed = false;
    try { launched = await this.launch(chatId, record.duty, pending.schedule, record.slot ?? record.at, record.at, { duty, ...pending.brief }, pending.measured); }
    catch (error) { failed = true; launched = { skipped: `${NOT_STARTED}: ${message(error).slice(0, 300)}` }; }
    const checkIn = record.duty === CHECK_IN_DUTY_ID;
    const ms = Math.max(0, this.now() - record.at);
    const attach = (stored: DutyRunRecord) => {
      if (launched && "job" in launched) { stored.job = launched.job; if (launched.replaced) stored.summary += launched.replaced; }
      else if (launched && checkIn) { stored.verdict = "skipped"; stored.summary = launched.skipped; }
      else if (launched) stored.summary += `; ${launched.skipped}`;
      if (checkIn) stored.ms = ms;
    };
    attach(record);
    if (launched) await this.store.updateRun(chatId, record.duty, record.at, attach);
    if ((await readPending(file))?.at === record.at) await rm(file, { force: true });
    this.log(`duty ${chatId.slice(0, 8)}/${record.duty}: ${record.verdict}, ${record.summary}${record.job ? `, started ${record.job.name}` : ""}`);
    return failed ? "failed" : record.job ? "started" : "none";
  }

  /**
   * Starts the job of each run whose start a restart cut off: a `<dutyId>.pending.json` left with no run of this process going. The job starts
   * through the same turn-queue wait and is written into the run's record, while the run's slot is under one interval old; an older slot, or a
   * record that already has its job or is gone, only clears the file.
   */
  private async resume(chatId: string): Promise<void> {
    const names = await readdir(this.store.chatDir(chatId)).catch(() => [] as string[]);
    for (const name of names.filter(entry => entry.endsWith(".pending.json"))) {
      const dutyId = name.slice(0, -".pending.json".length);
      const key = `${chatId}/${dutyId}`;
      if (this.running.has(key)) continue;
      const file = this.pendingFile(chatId, dutyId);
      const pending = await readPending(file);
      const record = pending && (await this.store.runs(chatId)).find(run => run.duty === dutyId && run.at === pending.at);
      const duty = dutyId === CHECK_IN_DUTY_ID ? CHECK_IN_DUTY : (await this.store.list(chatId)).find(entry => entry.id === dutyId);
      if (!pending || !record || !duty || record.job || record.verdict === "skipped" || record.summary.includes(NOT_STARTED)) { await rm(file, { force: true }); continue; }
      if (this.now() - (record.slot ?? record.at) >= intervalMs(pending.schedule)) {
        await this.store.updateRun(chatId, dutyId, record.at, stored => { stored.summary += `; ${NOT_STARTED}: the server restarted and its slot passed`; });
        await rm(file, { force: true });
        continue;
      }
      this.log(`duty ${chatId.slice(0, 8)}/${dutyId}: the server restarted before the job of the run of ${new Date(record.at).toISOString()} started; starting it`);
      this.steps.set(key, { at: record.at, step: "starting its job" });
      const task = this.startJob(chatId, record, duty, { schedule: pending.schedule, measured: pending.measured, brief: pending.brief }, false)
        .then(() => {}, error => this.log(`duty ${chatId.slice(0, 8)}/${dutyId}: resume its job: ${message(error)}`))
        .finally(() => { this.running.delete(key); this.steps.delete(key); });
      this.running.set(key, task);
    }
  }

  /**
   * The duty's last job as a run for `slot` finds it: null when a run already started a job for the slot, a skip while the last job still works
   * and has not worked past `stuckAfterMs(schedule)` since its run started, else the job to retire, with a note when it was stuck.
   */
  private async previous(chatId: string, dutyId: string, schedule: DutySchedule, slot: number): Promise<Previous> {
    const runs = (await this.store.runs(chatId)).filter(run => run.duty === dutyId);
    if (runs.some(run => run.slot === slot && run.job !== undefined)) return null;
    const started = runs.find(run => run.job);
    const last = started?.job;
    if (!started || !last || !(await this.host.jobs.working(last))) return last ? { last, lastRun: started } : {};
    const workingMs = this.now() - started.at;
    if (workingMs <= stuckAfterMs(schedule)) return { skipped: `${STILL_WORKING} (job ${last.name})` };
    return { last, lastRun: started, replaced: ` (replaced stuck job ${last.name}, working ${Math.round(workingMs / 60_000)} min)` };
  }

  /**
   * Starts the duty job of one run: null when the slot already has its job (a re-entrant tick or a restart), skipped while the duty's last job
   * still works, else the last job is retired (its archive queued) and a new one starts with the brief. A chat the daemon's list does not show is
   * skipped too, and a list that fails throws. The chat comes first, so whether the last job works is read from a catalog that lists it. A last
   * job stuck past `stuckAfterMs` of the duty's schedule is retired and replaced like a finished one. The job's session is created only once the
   * Mac-wide turn queue admits the run (`admit`), and the run's queue key is released once the session exists or its start failed. The retired
   * job's run gets this run's measure (`measured`) as its after-job measure when it has none yet: a job that ran past the next slot, or whose end
   * `stopEnded` did not see, is still judged after its fixes.
   */
  private async launch(chatId: string, dutyId: string, schedule: DutySchedule, slot: number, at: number,
    brief: Pick<DutyJobInput, "duty" | "measure" | "findings" | "focus" | "misses">, measured: AfterMeasure | null): Promise<Launched> {
    const chat = await this.host.jobs.chat(chatId);
    const previous = await this.previous(chatId, dutyId, schedule, slot);
    if (previous === null || "skipped" in previous) return previous;
    const { last, lastRun, replaced } = previous;
    if (!chat) return { skipped: "skipped: the catalog does not list the chat" };
    if (last) await this.host.jobs.retire(last).catch(error => this.log(`duty ${chatId.slice(0, 8)}/${dutyId}: retire ${last.name}: ${message(error)}`));
    if (lastRun && !lastRun.after && measured) {
      await this.store.updateRun(chatId, dutyId, lastRun.at, record => { record.after ??= measured; })
        .catch(error => this.log(`duty ${chatId.slice(0, 8)}/${dutyId}: after-job measure of ${lastRun.job?.name ?? "the last run"}: ${message(error)}`));
    }
    const name = dutyJobName(brief.duty.name, chat.name, at);
    // The wait runs here, outside the job host's one start lane, so a queued duty never holds up another chat's start.
    const key = `${chatId}/${dutyId}`;
    const step = this.steps.get(key);
    if (step) this.steps.set(key, { at: step.at, step: "waiting for a working slot" });
    const release = await this.host.admit?.(chatId, dutyId) ?? null;
    if (step) this.steps.set(key, step);
    let job: DutyJobRef;
    try { job = await this.host.jobs.start(chat, name, dutyJobBrief({ ...brief, chat, job: name, at })); }
    finally { await release?.().catch(error => this.log(`duty ${chatId.slice(0, 8)}/${dutyId}: release its turn queue key: ${message(error)}`)); }
    return replaced ? { job, replaced } : { job };
  }

  /** Resolves once every run going now has ended, for tests. */
  async settled(): Promise<void> { while (this.running.size) await Promise.all([...this.running.values()]); }

  private async run(chatId: string, dutyId: string, trigger: DutyTrigger, slot: number | null): Promise<void> {
    const duty = (await this.store.list(chatId)).find(entry => entry.id === dutyId);
    if (!duty) return;
    const key = `${chatId}/${dutyId}`;
    // A run whose chat the catalog cannot list yet (no rows after a restart while the daemon's full list times out) measures nothing and
    // leaves its slot due for the next tick, instead of measuring and then losing the slot's job.
    this.steps.set(key, { at: this.now(), step: "reading the catalog" });
    try { await this.host.jobs.chat(chatId); }
    catch (error) { this.log(`duty ${chatId.slice(0, 8)}/${dutyId}: waits for the catalog: ${message(error)}`); return; }
    const started = this.now();
    const at = slot ?? started;
    this.steps.set(key, { at: started, step: "measuring" });
    await this.store.update(chatId, duties => {
      const found = duties.find(entry => entry.id === dutyId);
      if (!found) return;
      found.lastRunAt = started;
      if (slot !== null && found.schedule.kind === "daily") found.lastSlotAt = slot;
    });
    const markRun = (pause: boolean) => this.store.update(chatId, duties => {
      const found = duties.find(entry => entry.id === dutyId);
      if (!found) return;
      found.runCount += 1;
      if (pause) { found.status = "paused"; found.updatedAt = this.now(); }
    });
    if ((await this.previous(chatId, dutyId, duty.schedule, at)) === null) return;
    const previous = (await this.store.runs(chatId)).filter(run => run.duty === dutyId && run.verdict !== "skipped");
    const dir = this.store.chatDir(chatId);
    const detail = join(dir, `${dutyId}-${runStamp(started)}.json`);
    let record: DutyRunRecord;
    let flagged: FlaggedSlice[] = [];
    try {
      const output = await this.precheck(duty, dir, detail, previous.slice(0, 10));
      const judged = judge(duty.metrics, output);
      flagged = output.flagged ?? [];
      record = { duty: dutyId, at: started, slot: at, trigger, ms: this.now() - started, verdict: judged.verdict, metrics: judged.metrics, summary: judged.summary, detail,
        ...(judged.verdict === "error" ? { error: judged.summary } : {}) };
    } catch (error) {
      await rm(detail, { force: true });
      record = { duty: dutyId, at: started, slot: at, trigger, ms: this.now() - started, verdict: "error", metrics: {}, summary: "the precheck failed", error: message(error).slice(0, 500) };
    }
    const pause = record.verdict === "error" && errorStreak([record, ...previous]) >= ERROR_PAUSE_RUNS;
    await markRun(pause);
    const misses = await this.missesOf(chatId, record, previous, duty.metrics);
    const findings = [
      ...(record.verdict === "error" ? [`The precheck failed: ${record.error ?? record.summary}. ${pause ? `It failed ${ERROR_PAUSE_RUNS} runs in a row and the duty is ` +
        "paused until resumed: fix the precheck, then tell the chat to resume the duty." : "Fix the precheck or check the duty by hand."}`] : []),
      ...(record.detail && record.verdict !== "error" ? [`The full precheck output is ${record.detail}.`] : []),
      ...(flagged.length ? [`### Flagged\n${flagged.map(slice => `- ${slice.kind}${slice.item ? ` ${slice.item}` : ""}: ${slice.excerpt}`).join("\n")}`] : []),
      stuckFindings(misses),
    ].filter(Boolean).join("\n\n");
    this.steps.set(key, { at: started, step: "starting its job" });
    const measured = record.verdict === "met" || record.verdict === "missed" ? { at: started, verdict: record.verdict, metrics: record.metrics, summary: record.summary } : null;
    await this.startJob(chatId, record, duty, { schedule: duty.schedule, measured,
      brief: { measure: record.verdict === "error" ? `no measure (${record.summary})` : record.summary, findings, misses } });
  }

  /**
   * Runs the precheck with the file contract; its state advances only when a scheduled run's precheck exits 0 with a valid output. An after-job
   * measure (`after`) reads the state but keeps none, so the next run's precheck counts from the same point, and it has its own files, so it can
   * run beside a run of the same duty. Throws with the reason otherwise.
   */
  private async precheck(duty: Duty, dir: string, outputFile: string, lastRuns: readonly DutyRunRecord[], mode: "run" | "after" = "run"): Promise<PrecheckOutput> {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const stateFile = join(dir, `${duty.id}.state.json`);
    const nextState = join(dir, `${duty.id}.state.${mode === "run" ? "next" : "after"}.json`);
    const lastRunsFile = join(dir, `${duty.id}.last-runs${mode === "run" ? "" : ".after"}.json`);
    await copyFile(stateFile, nextState).catch(async () => { await writeFile(nextState, "{}", { mode: 0o600 }); });
    await writeFile(lastRunsFile, JSON.stringify(lastRuns), { mode: 0o600 });
    await rm(outputFile, { force: true });
    const [command, ...args] = duty.precheck.command;
    const file = command === "node" ? this.host.node ?? process.execPath : command!;
    try {
      await new Promise<void>((resolve, reject) => {
        execFile(file, args, { cwd: duty.precheck.cwd, timeout: duty.precheck.timeoutMs, killSignal: "SIGKILL", maxBuffer: 1 << 20,
          env: { ...process.env, STATE_FILE: nextState, LAST_RUNS_FILE: lastRunsFile, OUTPUT_FILE: outputFile } }, (error, _stdout, stderr) => {
          if (!error) { resolve(); return; }
          const timedOut = error.killed || error.signal === "SIGKILL";
          const tail = String(stderr).trim().split("\n").slice(-3).join(" ").slice(0, 300);
          reject(new Error(timedOut ? `timed out after ${Math.round(duty.precheck.timeoutMs / 1000)} s` : `exit ${error.code ?? error.signal}${tail ? `: ${tail}` : ""}`));
        });
      });
      let output: unknown;
      try { output = JSON.parse(await readFile(outputFile, "utf8")); }
      catch { throw new Error("no valid JSON in OUTPUT_FILE"); }
      if (typeof output !== "object" || output === null || typeof (output as { metrics?: unknown }).metrics !== "object" || (output as { metrics?: unknown }).metrics === null) {
        throw new Error("OUTPUT_FILE has no metrics object");
      }
      if (mode === "run") await rename(nextState, stateFile);
      return output as PrecheckOutput;
    } finally { await rm(nextState, { force: true }); }
  }

  close(): void { clearInterval(this.timer); }
}
