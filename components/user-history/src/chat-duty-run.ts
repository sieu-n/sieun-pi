import { spawn } from "node:child_process";
import { open as openFile, copyFile, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { type DutyJobHost, dutyJobBrief, type DutyJobInput, dutyJobName } from "./chat-duty-job.ts";
import { type CheckInActor, CHECK_IN_MS } from "./checkin-settings.ts";
import type { DutyStore } from "./chat-duty-store.ts";
import { pooledProviders } from "./chat-pool.ts";
import { WAIT_READ_TREES } from "./idle-unload.ts";
import { GOAL_PUSH_LINK } from "./checkin-goals.ts";
import { goalReadingOps } from "./goal-readings.ts";
import { type AfterMeasure, CHECK_IN_DUTY, CHECK_IN_DUTY_ID, dailySlot, dutyDue, ERROR_RUNS_TARGET, errorStreak, headlineMetric, judge, nextRunAt, overrunWords, parseSchedule, type Duty, type DutyJobRef,
  type DutyCut, type DutyMetric, type DutyRunRecord, type DutySchedule, type DutyTrigger, type DutyView, type FixLink, type FlaggedSlice, type PrecheckOutput, type PrecheckOverrun, verdictMetrics } from "./shared/chat-duties.ts";
import { briefFindings, headlineWords } from "./shared/brief-cap.ts";
import { pushMisses } from "./duty-push.ts";
import { closedFixes, dutyFixes, missedKeys } from "./shared/duty-fixes.ts";
import { metricStreaks, type MetricStreak } from "./shared/duty-streak.ts";
import { type BoardOp, CHECK_IN_MIN_MINUTES, type ChatBoard, type CheckInPause, type CheckInView, type PlanItem, type PoolPriority } from "./shared/types.ts";

/** The check-in duty's side on the chat server (src/chats.ts): its setting (the header's control writes the same one) and a run now. */
export interface CheckInDutyHost {
  view(chatId: string): Promise<CheckInView | null>;
  set(chatId: string, change: { everyMs?: number; pause?: CheckInPause | null }, actor: CheckInActor): Promise<CheckInView | null>;
  /** A check-in run now; `trigger` "verify" when a fix step linked to a check-in metric closed, "rerun" with `rerunOf` for a cut run's rerun. */
  run(chatId: string, trigger?: DutyTrigger, rerunOf?: number): Promise<void>;
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
  /** The check-in prompt's body (`checkInPrompt`): the goals and the actions due. Set, the job's brief is `checkInJobBrief` and the findings go to the detail file only. */
  prompt?: string;
  /** On a rerun, the `at` of the cut run it reruns (`DutyRunRecord.rerunOf`). */
  rerunOf?: number;
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
  /** The command a precheck runs in place of its own; a replay serve's writes an empty metrics object, since a duty's precheck reads prod. */
  precheckCommand?: (duty: Duty) => readonly string[];
  /** The chat's pool class from its sidebar label (`chatPoolPriority`), for the card; absent: high, as for an unlabelled chat. */
  priority?: (chatId: string) => Promise<PoolPriority>;
  /** The chat's board, where each missed metric's fix step lives (`dutyFixes`); absent: runs record no fixes. */
  board?: (chatId: string) => Promise<ChatBoard | null>;
  /** Whether a fix step's job is at work now (`fixJobLive`); absent: no fix counts as live. */
  fixLive?: (chatId: string, item: PlanItem) => Promise<boolean>;
  /** Applies board ops to the chat's board, for each measured run's goal readings (`goalReadingOps`); absent: runs write no reading. */
  applyBoard?: (chatId: string, ops: (board: ChatBoard) => readonly BoardOp[]) => Promise<void>;
  /** Whether pi-pool would give the tree rooted at `tree` a `provider` account now (`poolAdmits`), for a cut run's rerun; absent: it admits. */
  poolAdmits?: (tree: string, provider: string) => Promise<boolean>;
}

export const DUTY_TICK_MS = 30_000;
/** The card shows this many runs per duty. */
export const VIEW_RUNS = 14;
/**
 * What the check-in job looks at besides the generic duty rules (owner 10-09: "fixes quirks like agents giving up"; Crawler VP 10-09: "split
 * tasks to subagent & Jobs actively").
 */
export const CHECK_IN_FOCUS: readonly string[] = [
  "Your number is goal_gaps, the open goals that no live job works on (owner 10-15: \"Check in 이 일을 쭉쭉 밀어줘야되는데 " +
    "it's deeply flawed. fix this\"), and every goal that says steer or start is yours to push this run. Spend the run on the goals first. The detail file's Goals section has, for each goal, its number, trend, pace " +
    "and owner job, and under each goal to push the message to send: the owner's words for that goal, the measured gap and the ask to name and " +
    "attack the biggest blocker on that number now.",
  `For a goal that says steer, send its owner job that message with agent_message.send in this run. For a goal that says start, add one push ` +
    `step under the goal with duty "${GOAL_PUSH_LINK}" and its job set to one job that names and attacks the biggest blocker: a live job of ` +
    "that goal that already works on that blocker, or a new job you start with rlm.create_session whose brief opens with that message. One " +
    "owner job per goal: when its push step's job is alive, steer it and never start a second, and when its push step has no live job, set one " +
    "on that step instead of adding another. A goal with no number gets a target from the " +
    "owner's words in this run.",
  "Then the steps: every step the detail file lists under Stuck steps ends this run with a live owner (steer its job, or start one with " +
    "rlm.create_session and set the step's job), a For you todo that links it when only the owner can unblock it, or a close on evidence. Fix " +
    "the plan shape the detail file lists with board ops: close or fold what shipped, move a loose step under its goal with plan_update parent, " +
    "and fix stale notes, so the owner never has to ask a chat to tidy its plan (c44).",
  "A goal held only by other threads or a step whose wait is over is finished work behind a wait: check the wait against the real state. When " +
    "it is met, close the step and the goal on that evidence. When it is not, send the holding thread the leftover in one message, close the " +
    "step here with a note naming that thread, and close the goal (c45).",
];
/**
 * How the check-in job reports to the chat (c80): at most 3 plain lines on the goals, never a list of step ids or finding kinds. It replaces
 * the duty job's generic report rule (`dutyJobBrief`).
 */
export const CHECK_IN_REPORT = "Send the chat one report of at most 3 plain lines when your work is done: the number and gap of the goal furthest " +
  "from its target (like \"Instagram Tier A indexed 14.9 of 100%, +4.7 points since 10-15 06:42Z, about 10 days to target at this rate\"), what " +
  "you steered or started for the goals, and the detail file path the findings name. A stuck step or plan fix goes in only when it blocks a goal. " +
  "Never a list of step ids, a finding kind or the flagged list.";
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
 * Why a slot of a standing duty ran nothing: its last run was still measuring (ops guy 10-12: the 14:35Z run took 19 min under load, and the
 * 14:45Z slot left no record). A slot that comes while the last run starts its job gets no record (`skipBusy`).
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

/**
 * The one hard stop of a precheck: its duty's schedule gap, and never less than its own soft target. A precheck still going holds every later
 * slot of its duty (each gets a skipped record), so a hung one would hold the duty for good; stopped at the gap, it costs one slot. Every
 * shorter stop is a soft target (`DutyPrecheck.timeoutMs`). On 10-19 the shortest gap of any duty was 30 min (AI harness d7), 11.5 times the
 * longest finished precheck (157.1 s) and 47 times the p95 (38.4 s) over 899 runs of every chat's duties (PRECHECK_TARGET_MS).
 */
export const precheckHardStopMs = (duty: Pick<Duty, "schedule" | "precheck">): number => Math.max(intervalMs(duty.schedule), duty.precheck.timeoutMs);

/** Why a run has no job when its start failed or a restart cut it off; a run with it is never started again. */
export const NOT_STARTED = "the duty job did not start";
/** A run's job start in progress, kept in `<dutyId>.pending.json` until the start ends, so a restart can finish it (`Duties.resume`). */
interface PendingStart {
  at: number; schedule: DutySchedule; measured: AfterMeasure | null;
  brief: Pick<DutyJobInput, "measure" | "findings" | "focus" | "misses" | "report" | "prompt">;
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

/** What a tick reads once per chat for its push runs: the chat's runs, newest first, and its check-in interval. */
type PushContext = { runs: DutyRunRecord[]; everyMs: number };

const message = (error: unknown): string => error instanceof Error ? error.message : String(error);

/** Whether a run moves its duty's lastRunAt and lastSlotAt: a push run or a rerun leaves them, since they set when the duty is due next. */
const movesSchedule = (trigger: DutyTrigger): boolean => trigger !== "push" && trigger !== "rerun";

/** The keys of the metrics a duty's verdict counts (`verdictMetrics`); old run records still carry every metric the duty once had. */
const verdictKeys = (metrics: readonly DutyMetric[]): Set<string> => new Set(verdictMetrics(metrics).map(metric => metric.key));

/** The findings line for the stuck metrics (`MetricStreak.stuck`): each one names its streak and the fix that did not move it. Empty when none is stuck. */
export function stuckFindings(misses: readonly MetricStreak[]): string {
  const stuck = misses.filter(miss => miss.stuck);
  if (!stuck.length) return "";
  return `### Change approach\n${stuck.map(miss => `- ${miss.key} missed ${miss.misses} runs in a row and did not move toward its target` +
    `${miss.fix ? `; the fix ${miss.fix.step}${miss.fix.job ? ` by ${miss.fix.job}` : ""} did not move it` : ""}. This run starts a new root-cause job for it, not the same fix again.`).join("\n")}`;
}

/** The headline metric's number in a run's record as the brief's first line (`headlineWords`); null when the duty has none or the run has no value. */
function headlineOf(metrics: readonly DutyMetric[], record: Pick<DutyRunRecord, "metrics">): { key: string; words: string } | null {
  const lead = headlineMetric(verdictMetrics(metrics));
  const value = lead && record.metrics[lead.key]?.value;
  return lead && typeof value === "number" ? { key: lead.key, words: headlineWords(lead, value) } : null;
}

/** Every flagged item of a run, one raw line each, for its detail file. */
const flaggedSection = (flagged: readonly FlaggedSlice[]): string =>
  flagged.length ? `### Flagged (${flagged.length})\n${flagged.map(slice => `- ${slice.kind}${slice.item ? ` ${slice.item}` : ""}: ${slice.excerpt}`).join("\n")}` : "";

/** The check-in duty's cadence in minutes: `{ kind: every, minutes }` with a whole number the check-in setting takes. */
function checkInMinutes(value: unknown): number {
  const minutes = typeof value === "object" && value !== null && (value as { kind?: unknown }).kind === "every" ? (value as { minutes?: unknown }).minutes : undefined;
  if (typeof minutes !== "number" || !Number.isInteger(minutes) || minutes < CHECK_IN_MIN_MINUTES) {
    throw new Error(`The check-in runs every N whole minutes, ${CHECK_IN_MIN_MINUTES} or more.`);
  }
  return minutes;
}

/**
 * Runs each chat's due duties on the server: a skip policy on overlap (a duty with a run going starts no other, and each slot it holds up while measuring gets a skipped record), one catch-up for a daily slot
 * missed by at most CATCH_UP_MS, the precheck with the file contract and its timeout, the measure against the targets, and then one duty job
 * per run with the precheck as context (src/chat-duty-job.ts), met or missed. One job per duty per slot: a run whose slot already has a job
 * starts none, and while the duty's last job still works a run measures but starts no job and says so in its summary, unless that job is stuck past
 * `stuckAfterMs` of its duty's schedule, which the run replaces. The run that starts a job retires the
 * last one: it leaves the registry at once and its archive is queued, so a slow daemon never holds up the start. A precheck that errors ERROR_RUNS_TARGET times in a row or more keeps running on schedule, and each such run's job is told the streak and to fix it. The check-in duty's
 * schedule and precheck live on the chat server, which hands each run here (`checkIn`); its card reads and edits the chat's check-in setting.
 */
export class Duties {
  /** The run going per `<chatId>/<dutyId>`; a second start shares it. */
  private readonly running = new Map<string, Promise<CheckInStart | void>>();
  /** What each standing duty run going now does, with its start time, for the record of a slot it holds up. */
  private readonly steps = new Map<string, { at: number; step: "reading the catalog" | "measuring" | "waiting for a working slot" | "starting its job" }>();
  /** Duty jobs whose archive `stopEnded` queued, so each is queued once. */
  private readonly stopped = new Set<string>();
  /** The last board each chat's watch showed, to find the fix steps a change closed (`boardChanged`). */
  private readonly boards = new Map<string, ChatBoard>();
  /** Each ended last job's after-job measure and then its archive (`stopEnded`), kept off the tick so a slow precheck holds up no due duty. */
  private readonly ending = new Set<Promise<void>>();
  /** The push check going per `<chatId>/<dutyId>`, kept off the scan so a slow daemon read holds up no due duty. */
  private readonly pushes = new Map<string, Promise<void>>();
  /**
   * The after-job measure and archive going per `<chatId>/<dutyId>` (`endJob`). A push of the duty waits for it and judges on its result, so
   * a duty has one check in flight: on 10-18 at 15:55:56Z a push run of chat-057a's Chat reopen read its last run's stale miss, measured
   * beside that run's after-job measure and started a job that ran the reopen check a second time (20261018-1556).
   */
  private readonly afters = new Map<string, Promise<void>>();
  /** Each job's cut as read from its transcript (`cutOf`), once per job. */
  private readonly cuts = new Map<string, Promise<DutyCut | null>>();
  /** The cut runs this process started a rerun of, by `<chatId>/<dutyId>@<at>`, for a rerun that ends with no record (`rerunCut`). */
  private readonly reran = new Set<string>();
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

  /**
   * One wake: every duty of every chat that is due starts, and a daily slot too late to run is recorded as skipped. Due duties start first for
   * every chat, and the push checks run beside the scan (`pushes`), since a push check waits on the daemon: from the 3c50a84 release at 05:27Z
   * on 10-18 the scan pushed Crawler VP's red duties one at a time first, jobs.working took 37 s and fixLive 18 s and more under load, the
   * chat server restarted every 3 to 9 min for releases, and no scan reached Whole system's 05:49Z slot.
   */
  tick(): Promise<void> {
    const scan = this.ticking ??= this.scan().catch(error => this.log(`duties: tick: ${message(error)}`)).finally(() => { this.ticking = undefined; });
    return scan.then(async () => { await Promise.all([...this.ending, ...this.pushes.values()]); });
  }

  private async scan(): Promise<void> {
    const chats: string[] = [];
    const gone: string[] = [];
    const idle: { chatId: string; duty: Duty }[] = [];
    for (const chatId of await this.store.chats()) {
      if (!(await this.host.isChat(chatId))) { gone.push(chatId); continue; }
      chats.push(chatId);
      await this.resume(chatId);
      for (const duty of await this.store.list(chatId)) {
        const due = dutyDue(duty, this.now());
        // An after-job measure runs the duty's precheck, so a due run waits for it instead of calling the same routes beside it.
        if (due.kind === "run" && this.afters.has(`${chatId}/${duty.id}`)) continue;
        if (due.kind === "skip") await this.skip(chatId, duty, due.slot);
        else if (due.kind === "run" && !this.start(chatId, duty.id, due.trigger, due.slot)) await this.skipBusy(chatId, duty, due.slot);
        else if (due.kind === "no" && duty.status === "active") idle.push({ chatId, duty });
      }
    }
    for (const chatId of chats) {
      if (this.boards.has(chatId)) continue;
      const board = await this.host.board?.(chatId).catch(() => null);
      if (board && !this.boards.has(chatId)) this.boards.set(chatId, board);
    }
    const contexts = new Map<string, Promise<PushContext>>();
    for (const { chatId, duty } of idle) {
      const key = `${chatId}/${duty.id}`;
      if (this.pushes.has(key)) continue;
      const pushContext = () => {
        let context = contexts.get(chatId);
        if (!context) {
          context = Promise.all([this.store.runs(chatId), this.host.checkIn?.view(chatId).catch(() => null)])
            .then(([runs, checkIn]) => ({ runs, everyMs: checkIn?.everyMs ?? CHECK_IN_MS }));
          contexts.set(chatId, context);
        }
        return context;
      };
      const task = this.push(chatId, duty, pushContext).catch(error => this.log(`duty ${chatId.slice(0, 8)}/${duty.id}: push check: ${message(error)}`))
        .finally(() => { this.pushes.delete(key); });
      this.pushes.set(key, task);
    }
    const runs = new Map<string, DutyRunRecord[]>();
    for (const chatId of chats) runs.set(chatId, await this.store.runs(chatId));
    await this.stopEnded(runs);
    await this.rerunCut(runs);
    await this.retireGone(gone);
  }

  /**
   * Starts a push run of a red standing duty that is not due (`pushMisses`) when no job is at work on it: its last duty job has ended, and no
   * open fix step linked to a missed metric has a live job (`dutyFixes`). A job that cannot be read counts as ended, so the push run's own
   * start records why it failed. The push run is an ordinary run that leaves the schedule where it was. An ended job whose run has no after-job
   * measure yet gets that measure first (`endJob`, shared with the scan), and the push judges on it, so no push measures beside it.
   */
  private async push(chatId: string, duty: Duty, context: () => Promise<PushContext>): Promise<void> {
    const key = `${chatId}/${duty.id}`;
    if (this.running.has(key)) return;
    const { runs, everyMs } = await context();
    const counted = verdictKeys(duty.metrics);
    let own = runs.filter(run => run.duty === duty.id);
    if (!pushMisses(own, counted, everyMs, this.now())) return;
    const lastRun = own.find((run): run is DutyRunRecord & { job: DutyJobRef } => run.job !== undefined);
    if (lastRun && await this.host.jobs.working(lastRun.job).catch(() => false)) return;
    // A cut run waits for its rerun once pi-pool admits its tree (`rerunCut`), so it is still going: at 15:50:20Z on 10-19 the AI harness chat's
    // d9 got a push run while its 15:34Z run waited for its slot, and at 16:15:41Z frontend bro's d1 got one while its 15:29Z push run did.
    if (lastRun && lastRun.trigger !== "rerun" && !own.some(run => run.rerunOf === lastRun.at) && await this.cutOf(chatId, lastRun)) return;
    // The last job has ended, so its after-job measure is the duty's check now: the push judges on its result instead of measuring beside it.
    if (lastRun && !lastRun.after || this.afters.has(key)) {
      await (this.afters.get(key) ?? (lastRun && !this.stopped.has(lastRun.job.id) ? this.endJob(chatId, lastRun) : undefined));
      own = (await this.store.runs(chatId)).filter(run => run.duty === duty.id);
    }
    const misses = pushMisses(own, counted, everyMs, this.now());
    if (!misses) return;
    const board = await this.host.board?.(chatId).catch(() => null) ?? null;
    if (Object.values(await this.fixesOn(board, chatId, duty.id, misses)).some(fix => fix.live)) return;
    if (this.afters.has(key)) return;
    if (this.start(chatId, duty.id, "push", this.now())) this.log(`duty ${chatId.slice(0, 8)}/${duty.id}: red on ${misses.join(", ")} with no job at work on it; a push run starts`);
  }

  /**
   * Retires the duty jobs that still work for a chat that left the chat list, such as one the owner archived. Its duties stop with the chat,
   * so its check-in job must stop too: on 10-17 the check-in job of "TikTok listing drops" (01a143d5) started at 19:57:49Z, the chat was archived
   * a minute later, and the job kept working on it, got 404 "This thread is not a chat" from job-steer and started a new job for the archived chat.
   * Only a run from the last STUCK_MAX_MS can have a job at work, so an old archived chat costs one file read per tick and no daemon call.
   */
  private async retireGone(gone: readonly string[]): Promise<void> {
    const since = this.now() - STUCK_MAX_MS;
    for (const chatId of gone) {
      const seen = new Set<string>();
      for (const run of await this.store.runs(chatId)) {
        if (run.at < since) break;
        if (!run.job || seen.has(run.duty)) continue;
        seen.add(run.duty);
        if (this.stopped.has(run.job.id)) continue;
        const job = run.job;
        const working = await this.host.jobs.working(job).catch(() => false);
        if (!working) continue;
        this.stopped.add(job.id);
        await this.host.jobs.retire(job).then(() => this.log(`duty job ${job.name}: its chat left the chat list; retired it`))
          .catch(error => this.log(`duty job ${job.name}: retire after its chat left the chat list: ${message(error)}`));
      }
    }
  }

  /**
   * Measures each duty's last job's run again once that job's turn has ended (`measureAfter`), then archives the job instead of at the next
   * run; and archives any older duty job still up. A run's verdict is read after its own fixes this way (chat 01a1164b 10-15: a check-in counted
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
      if (this.stopped.has(job.id)) continue;
      const ended = last.get(job.id);
      if (ended) { void this.endJob(ended.chatId, ended.run); continue; }
      this.stopped.add(job.id);
      await stop(job);
      this.log(`duty job ${job.name}: an older job still up; queued its archive`);
    }
  }

  /**
   * Measures an ended last job's run again and then queues the job's archive, once per duty at a time: the scan (`stopEnded`) and a push of
   * the same duty share one measure. A run of the duty going now is this job's measure (`launch` writes it as the after-job measure), so the
   * measure waits for it and runs only when the run left none. A job that ended cut did no work, so its run records the cut (`cutOf`) in place
   * of the measure and reruns (`rerunCut`).
   */
  private endJob(chatId: string, run: DutyRunRecord & { job: DutyJobRef }): Promise<void> {
    const key = `${chatId}/${run.duty}`;
    const going = this.afters.get(key);
    if (going) return going;
    this.stopped.add(run.job.id);
    const jobs = this.host.jobs;
    const task = (async () => {
      const runGoing = this.running.get(key);
      if (runGoing) await runGoing;
      const measured = runGoing && (await this.store.runs(chatId)).find(entry => entry.duty === run.duty && entry.at === run.at)?.after;
      if (!measured && !(await this.cutOf(chatId, run))) await this.measureAfter(chatId, run);
      if (!jobs.stop) return;
      await jobs.stop(run.job);
      this.log(`duty job ${run.job.name}: its turn ended; queued its archive`);
    })()
      .catch(error => this.log(`duty job ${run.job.name}: after its turn ended: ${message(error)}`))
      .finally(() => { this.afters.delete(key); this.ending.delete(task); });
    this.afters.set(key, task);
    this.ending.add(task);
    return task;
  }

  /**
   * The cut of a run's job: the record's, else its transcript's (`DutyJobHost.cut`), read once per job, written into the record and logged as
   * cut, the line a measure of the run would have logged as "after its job". A run the old code measured after its cut job counts too.
   */
  private async cutOf(chatId: string, run: DutyRunRecord & { job: DutyJobRef }): Promise<DutyCut | null> {
    if (run.cut) return run.cut;
    let read = this.cuts.get(run.job.id);
    if (!read) {
      const jobs = this.host.jobs;
      read = (async () => {
        const cut = await jobs.cut?.(run.job).catch(error => { this.log(`duty job ${run.job.name}: read its transcript: ${message(error)}`); return null; }) ?? null;
        if (!cut) return null;
        await this.store.updateRun(chatId, run.duty, run.at, record => { record.cut ??= cut; });
        const slot = cut.slotAt === undefined ? "" : `, pi-pool slot ${new Date(cut.slotAt).toISOString()}`;
        this.log(`duty ${chatId.slice(0, 8)}/${run.duty}: cut, its job ${run.job.name} ended on a failed model call at ${new Date(cut.at).toISOString()}${slot}` +
          ` (${cut.error}); ${run.trigger === "rerun" ? "a rerun is not run again" : "it reruns once pi-pool admits its tree"}`);
        return cut;
      })();
      this.cuts.set(run.job.id, read);
    }
    return read;
  }

  /**
   * Reruns each cut run once. A duty's run to look at is its newest run that started a job, after that job ended (the run has an after-job
   * measure or a cut). It reruns when its job ended cut (`cutOf`), the run is no rerun itself, no rerun names it (`rerunOf`), no run of the
   * duty goes now, the duty is active, the slot pi-pool gave the cut job has come (`DutyCut.slotAt`), and pi-pool admits the cut job's tree
   * (`poolAdmits`; a duty job is the root of its tree), asked WAIT_READ_TREES trees at a time. `who` reserves nothing, so without the slot
   * every cut tree read as admitted the moment one account freed: at 14:40:07Z on 10-19 claude-virev4 came back, 40 cut runs reran in that
   * tick, and each rerun's job met a new slot wait by 14:48Z. The slots pi-pool hands out spread the reruns the way it spreads the jobs. A newer run that started a job becomes the run to look at, so a cut run whose duty ran again first, like
   * a wiki dream push run 15 min later, gets no rerun. The rerun is a run with the trigger "rerun" and `rerunOf`, and the check-in's goes
   * through the chat server's check-in lane. On 10-19 every check-in of "Twitch gaps" (01a151ca) from 02:33Z to 05:34Z got "this session waits
   * for its slot" as its job's first reply and read as missed after its job, and its next check-in with a working job ran at 06:04Z.
   */
  private async rerunCut(runsByChat: ReadonlyMap<string, readonly DutyRunRecord[]>): Promise<void> {
    const found: { chatId: string; run: DutyRunRecord & { job: DutyJobRef }; cut: DutyCut }[] = [];
    for (const [chatId, runs] of runsByChat) {
      const seen = new Set<string>();
      for (const run of runs) {
        if (!run.job || seen.has(run.duty)) continue;
        seen.add(run.duty);
        const key = `${chatId}/${run.duty}`;
        if (run.trigger === "rerun" || (!run.cut && !run.after) || this.running.has(key) || this.afters.has(key) || this.reran.has(`${key}@${run.at}`) ||
          runs.some(other => other.duty === run.duty && other.rerunOf === run.at)) continue;
        const ended = run as DutyRunRecord & { job: DutyJobRef };
        const cut = await this.cutOf(chatId, ended);
        if (cut && !(cut.slotAt !== undefined && cut.slotAt > this.now()) && await this.dutyActive(chatId, run.duty)) found.push({ chatId, run: ended, cut });
      }
    }
    const admits = this.host.poolAdmits;
    const admitted = ({ run, cut: { provider } }: (typeof found)[number]): Promise<boolean> =>
      provider !== undefined && admits && (pooledProviders as readonly string[]).includes(provider) ? admits(run.job.id, provider).catch(() => false) : Promise.resolve(true);
    for (let from = 0; from < found.length; from += WAIT_READ_TREES) {
      const part = found.slice(from, from + WAIT_READ_TREES);
      const open = await Promise.all(part.map(admitted));
      part.forEach(({ chatId, run }, index) => {
        if (!open[index]) return;
        this.reran.add(`${chatId}/${run.duty}@${run.at}`);
        this.log(`duty ${chatId.slice(0, 8)}/${run.duty}: pi-pool admits the tree of ${run.job.name}, so its cut run of ${new Date(run.at).toISOString()} reruns`);
        if (run.duty !== CHECK_IN_DUTY_ID) this.start(chatId, run.duty, "rerun", null, run.at);
        else void this.host.checkIn?.run(chatId, "rerun", run.at).catch(error => this.log(`duty ${chatId.slice(0, 8)}/${run.duty}: rerun: ${message(error)}`));
      });
    }
  }

  /** Whether the duty runs on its own now: a standing duty that is active, or the check-in of a chat whose check-in is not paused. */
  private async dutyActive(chatId: string, dutyId: string): Promise<boolean> {
    if (dutyId === CHECK_IN_DUTY_ID) {
      const view = await this.host.checkIn?.view(chatId).catch(() => null) ?? null;
      return view !== null && !view.paused;
    }
    return (await this.store.list(chatId)).some(duty => duty.id === dutyId && duty.status === "active");
  }

  private async fixesOn(board: ChatBoard | null, chatId: string, dutyId: string, metrics: readonly string[], flagged: readonly FlaggedSlice[] = []): Promise<Record<string, FixLink>> {
    const live = this.host.fixLive;
    return dutyFixes(board, dutyId, metrics, item => live ? live(chatId, item).catch(() => false) : Promise.resolve(false), flagged);
  }

  /** Fills a missed run's `fixes` from the board, and returns its miss streaks with them (`metricStreaks`, from `previous` newest first). */
  private async missesOf(chatId: string, record: DutyRunRecord, previous: readonly DutyRunRecord[], metrics: readonly DutyMetric[]): Promise<MetricStreak[]> {
    if (record.verdict !== "missed") return [];
    const counted = verdictKeys(metrics);
    const board = this.host.board ? await this.host.board(chatId).catch(error => { this.log(`duty ${chatId.slice(0, 8)}/${record.duty}: read the board: ${message(error)}`); return null; }) : null;
    const fixes = await this.fixesOn(board, chatId, record.duty, missedKeys(record).filter(key => counted.has(key)), record.flagged);
    if (Object.keys(fixes).length) record.fixes = fixes;
    return metricStreaks([record, ...previous]).filter(streak => counted.has(streak.key));
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
    await this.writeReadings(chatId, run.duty, after);
  }

  /** Writes a measured run's values into the goals they measure (`goalReadingOps`), so the board and the next check-in read the newest number. */
  private async writeReadings(chatId: string, dutyId: string, run: Pick<DutyRunRecord, "at" | "verdict" | "metrics" | "parts">): Promise<void> {
    if (!this.host.applyBoard || (run.verdict !== "met" && run.verdict !== "missed")) return;
    const duty = dutyId === CHECK_IN_DUTY_ID ? undefined : (await this.store.list(chatId)).find(entry => entry.id === dutyId);
    const units = Object.fromEntries((duty?.metrics ?? []).map(metric => [metric.key, metric.unit]));
    await this.host.applyBoard(chatId, board => goalReadingOps(board, dutyId, run.at, { ...run.parts, ...run.metrics }, units))
      .catch(error => this.log(`duty ${chatId.slice(0, 8)}/${dutyId}: write its goal readings: ${message(error)}`));
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
   * A slot that came while the duty's last run still goes; the next slot is one interval later. A run still reading the catalog has not taken
   * its slot yet: it takes this one or leaves it due. A run that has measured and is starting its job (or waiting for a working slot) already
   * has its record, so the slot only moves on and gets no skipped record: from 10-15 to 10-18 Whole system got 30 skipped records in 72 runs,
   * each a slot that came while one run's job start waited in the daemon for up to 2 h, and the duty read as failing for the wait. A run still
   * measuring gets a skipped record, so every slot keeps one (ops guy 10-12: a 19-minute measure left the 14:45Z slot with none).
   */
  private async skipBusy(chatId: string, duty: Duty, slot: number): Promise<void> {
    const at = this.now();
    const going = this.steps.get(`${chatId}/${duty.id}`);
    if (going?.step === "reading the catalog") return;
    if (going?.step === "starting its job" || going?.step === "waiting for a working slot") {
      await this.store.update(chatId, duties => {
        const found = duties.find(entry => entry.id === duty.id);
        if (!found) return;
        if (found.schedule.kind === "every") found.lastRunAt = at;
        else found.lastSlotAt = slot;
      });
      this.log(`duty ${chatId.slice(0, 8)}/${duty.id}: the run of ${new Date(going.at).toTimeString().slice(0, 5)} is still ${going.step}, so this slot starts no run`);
      return;
    }
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

  /** Starts a run unless one is going; false when it was already running. A rerun names its cut run (`rerunOf`). */
  private start(chatId: string, dutyId: string, trigger: DutyTrigger, slot: number | null, rerunOf?: number): boolean {
    const key = `${chatId}/${dutyId}`;
    if (this.running.has(key)) return false;
    const run = this.run(chatId, dutyId, trigger, slot, rerunOf).catch(error => this.log(`duty ${chatId.slice(0, 8)}/${dutyId}: ${message(error)}`))
      .finally(async () => { await rm(this.measuringFile(chatId, dutyId), { force: true }); this.running.delete(key); this.steps.delete(key); });
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
   * A new cadence: every N minutes or a daily time. The check-in duty takes whole minutes from CHECK_IN_MIN_MINUTES up and
   * writes the chat's check-in setting (the header's control shows the change); a daily time is refused for it. A daily duty moved to a time
   * already past today waits for tomorrow's slot. Throws on a bad or refused schedule; false when the duty is unknown.
   */
  async setSchedule(chatId: string, dutyId: string, value: unknown, actor: CheckInActor): Promise<boolean> {
    if (dutyId === CHECK_IN_DUTY_ID && this.host.checkIn) return (await this.host.checkIn.set(chatId, { everyMs: checkInMinutes(value) * 60_000 }, actor)) !== null;
    const schedule = parseSchedule(value);
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
   * The brief the duty's next run sends its job, for the card's Prompt button while no run of the duty has a job yet. It is `dutyJobBrief`, as
   * `launch` builds it, with the parts the precheck fills at run time (the measure, the findings and the misses) named instead; null when the
   * chat or the duty is unknown.
   */
  async nextBrief(chatId: string, dutyId: string): Promise<{ text: string; at: number } | null> {
    const checkIn = dutyId === CHECK_IN_DUTY_ID;
    const duty = checkIn ? CHECK_IN_DUTY : (await this.store.list(chatId)).find(entry => entry.id === dutyId);
    const chat = duty ? await this.host.jobs.chat(chatId) : null;
    if (!duty || !chat) return null;
    const at = (await this.view(chatId)).find(view => view.duty.id === dutyId)?.nextAt ?? this.now();
    const job = dutyJobName(duty.name, chat.name, at);
    const text = dutyJobBrief({ duty, chat, job, at, measure: "<the precheck's measure against the targets, taken when the run starts>",
      findings: "<the precheck's findings, and a line for each metric stuck on a miss, from that run>",
      ...checkIn ? { focus: CHECK_IN_FOCUS, report: CHECK_IN_REPORT } : {} });
    return { text, at };
  }

  /**
   * One run of the check-in duty, measured by the chat server: its misses against `CHECK_IN_DUTY`'s targets, its step classes and flagged
   * items go in the record, and one check-in job starts with the findings as context (`launch`). A second call while one is going shares it.
   */
  checkIn(chatId: string, run: CheckInRun): Promise<CheckInStart> {
    const key = `${chatId}/${CHECK_IN_DUTY_ID}`;
    const going = this.running.get(key);
    if (going) {
      this.log(`duty ${chatId.slice(0, 8)}/${CHECK_IN_DUTY_ID}: a check-in run is still starting its job, so this check-in waits for it`);
      return going.then(() => "done" as const);
    }
    const task = this.checkInRun(chatId, run).catch((error): CheckInStart => { this.log(`duty ${chatId.slice(0, 8)}/${CHECK_IN_DUTY_ID}: ${message(error)}`); return "done"; })
      .finally(() => this.running.delete(key));
    this.running.set(key, task);
    return task;
  }

  private async checkInRun(chatId: string, run: CheckInRun): Promise<CheckInStart> {
    const judged = judge(CHECK_IN_DUTY.metrics, run.output);
    const record: DutyRunRecord = { duty: CHECK_IN_DUTY_ID, at: run.at, slot: run.at, trigger: run.trigger, ms: 0, verdict: judged.verdict, metrics: judged.metrics,
      summary: judged.summary, classes: run.classes, ...(run.output.flagged.length ? { flagged: run.output.flagged } : {}), ...(run.rerunOf === undefined ? {} : { rerunOf: run.rerunOf }) };
    const previous = (await this.store.runs(chatId)).filter(entry => entry.duty === CHECK_IN_DUTY_ID);
    if (previous.some(entry => entry.slot === run.at && entry.job !== undefined)) return "done";
    const misses = await this.missesOf(chatId, record, previous, CHECK_IN_DUTY.metrics);
    await this.store.updateFile(chatId, file => {
      const state = file.checkIn ??= { createdAt: run.at, runCount: 0 };
      state.runCount += 1;
      state.lastRunAt = run.at;
    });
    const detail = await this.writeDetail(chatId, `${CHECK_IN_DUTY_ID}-${runStamp(run.at)}`,
      [`# Check-in run of ${new Date(run.at).toISOString()}`, `Measured against the targets: ${judged.summary}.`, run.findings, flaggedSection(run.output.flagged)]);
    const headline = headlineOf(CHECK_IN_DUTY.metrics, record);
    const findings = briefFindings({ headline: headline?.words ?? null, flagged: run.output.flagged, ...headline ? { headlineKey: headline.key } : {}, detail });
    // goal_gaps' ask is per goal, in the findings (steer or start its owner job on a push step); the generic "land a code fix" line would contradict it.
    const stepMisses = misses.filter(miss => miss.key !== "goal_gaps");
    const started = await this.startJob(chatId, record, CHECK_IN_DUTY, {
      schedule: { kind: "every", minutes: run.everyMs / 60_000 }, measured: judged.verdict === "error" ? null : { at: run.at, ...judged },
      brief: { measure: judged.summary, findings: [findings, stuckFindings(stepMisses)].filter(Boolean).join("\n\n"), focus: CHECK_IN_FOCUS, misses: stepMisses, report: CHECK_IN_REPORT,
        ...run.prompt !== undefined ? { prompt: `${run.prompt}\n\nThe full precheck, with every step and finding, is in ${detail}. Read it for the work you take on; never paste it into a message.` } : {} } });
    return started === "failed" ? "failed" : "done";
  }

  /** When the chat's newest check-in run was recorded; undefined when it has none. The scheduler reads it at start (`Chats.load`). */
  async lastCheckIn(chatId: string): Promise<number | undefined> {
    return (await this.store.runs(chatId)).find(run => run.duty === CHECK_IN_DUTY_ID)?.at;
  }

  /**
   * Writes the full findings of a run or a notice to `<chat dir>/<name>.flagged.md` and returns its path, which the brief or the notice names
   * instead of listing every item (`briefFindings`, `cappedLines`). A write that fails is logged and the path is still named.
   */
  async writeDetail(chatId: string, name: string, parts: readonly string[]): Promise<string> {
    const dir = this.store.chatDir(chatId);
    const path = join(dir, `${name}.flagged.md`);
    try {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await writeFile(path, parts.filter(Boolean).join("\n\n") + "\n", { mode: 0o600 });
    } catch (error) { this.log(`duty ${chatId.slice(0, 8)}: write ${name}.flagged.md: ${message(error)}`); }
    return path;
  }

  private pendingFile(chatId: string, dutyId: string): string { return join(this.store.chatDir(chatId), `${dutyId}.pending.json`); }

  /**
   * A standing duty's run from its measure to its record, kept in `<dutyId>.measuring.json`, so a restart in between runs it again (`resume`).
   * The run moves lastRunAt at its start, so a release that cut the measure lost the slot with no record: d7's 06:12Z run on 10-18 measured,
   * waited on the daemon's fix reads, and the 06:15Z release ended it, so Whole system ran next at 06:42Z.
   */
  private measuringFile(chatId: string, dutyId: string): string { return join(this.store.chatDir(chatId), `${dutyId}.measuring.json`); }

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
    await rm(this.measuringFile(chatId, record.duty), { force: true });
    if (older && older.at !== record.at) await this.store.updateRun(chatId, record.duty, older.at, stored => { if (!stored.job) stored.summary += `; ${NOT_STARTED}: a later run took its place`; });
    if (append) { await this.store.appendRun(chatId, record); await this.writeReadings(chatId, record.duty, record); }
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
   * through the same turn-queue wait and is written into the run's record; a record that already has its job or is gone only clears the file.
   * A newer run replaces the file and marks this one, so the file always names the duty's newest measure. A slot one interval old started no
   * job until 10-18: 38 measured runs from 10-16 to 10-18 lost their job that way, since a start that waited in the turn queue past one
   * interval was cut by a release, and the slots due meanwhile had been skipped behind it, so no fresh run took its place.
   */
  private async resume(chatId: string): Promise<void> {
    const names = await readdir(this.store.chatDir(chatId)).catch(() => [] as string[]);
    for (const name of names.filter(entry => entry.endsWith(".measuring.json"))) {
      const dutyId = name.slice(0, -".measuring.json".length);
      if (this.running.has(`${chatId}/${dutyId}`)) continue;
      const file = this.measuringFile(chatId, dutyId);
      const measuring = await readFile(file, "utf8").then(text => JSON.parse(text) as { at: number; trigger: DutyTrigger; slot: number | null; rerunOf?: number }).catch(() => null);
      await rm(file, { force: true });
      if (!measuring || !(await this.store.list(chatId)).some(duty => duty.id === dutyId)) continue;
      this.log(`duty ${chatId.slice(0, 8)}/${dutyId}: the server restarted while the run of ${new Date(measuring.at).toISOString()} measured; it runs again`);
      this.start(chatId, dutyId, measuring.trigger, measuring.slot, measuring.rerunOf);
    }
    for (const name of names.filter(entry => entry.endsWith(".pending.json"))) {
      const dutyId = name.slice(0, -".pending.json".length);
      const key = `${chatId}/${dutyId}`;
      if (this.running.has(key)) continue;
      const file = this.pendingFile(chatId, dutyId);
      const pending = await readPending(file);
      const record = pending && (await this.store.runs(chatId)).find(run => run.duty === dutyId && run.at === pending.at);
      const duty = dutyId === CHECK_IN_DUTY_ID ? CHECK_IN_DUTY : (await this.store.list(chatId)).find(entry => entry.id === dutyId);
      if (!pending || !record || !duty || record.job || record.verdict === "skipped" || record.summary.includes(NOT_STARTED)) { await rm(file, { force: true }); continue; }
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
   * job stuck past `stuckAfterMs` of the duty's schedule is retired and replaced like a finished one. The retired job's run gets this run's measure (`measured`) as its after-job measure when it has none yet: a job that ran past the next slot, or whose end
   * `stopEnded` did not see, is still judged after its fixes.
   */
  private async launch(chatId: string, dutyId: string, schedule: DutySchedule, slot: number, at: number,
    brief: Pick<DutyJobInput, "duty" | "measure" | "findings" | "focus" | "misses" | "report" | "prompt">, measured: AfterMeasure | null): Promise<Launched> {
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
    const job = await this.host.jobs.start(chat, name, dutyJobBrief({ ...brief, chat, job: name, at }), at);
    return replaced ? { job, replaced } : { job };
  }

  /** Resolves once every run going now has ended, for tests. */
  async settled(): Promise<void> { while (this.running.size) await Promise.all([...this.running.values()]); }

  private async run(chatId: string, dutyId: string, trigger: DutyTrigger, slot: number | null, rerunOf?: number): Promise<void> {
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
    await mkdir(this.store.chatDir(chatId), { recursive: true, mode: 0o700 });
    await writeFile(this.measuringFile(chatId, dutyId), JSON.stringify({ at: started, trigger, slot, rerunOf }), { mode: 0o600 });
    if (movesSchedule(trigger)) await this.store.update(chatId, duties => {
      const found = duties.find(entry => entry.id === dutyId);
      if (!found) return;
      found.lastRunAt = started;
      if (slot !== null && found.schedule.kind === "daily") found.lastSlotAt = slot;
    });
    const markRun = () => this.store.update(chatId, duties => {
      const found = duties.find(entry => entry.id === dutyId);
      if (found) found.runCount += 1;
    });
    if ((await this.previous(chatId, dutyId, duty.schedule, at)) === null) return;
    const previous = (await this.store.runs(chatId)).filter(run => run.duty === dutyId && run.verdict !== "skipped");
    const dir = this.store.chatDir(chatId);
    const detail = join(dir, `${dutyId}-${runStamp(started)}.json`);
    let record: DutyRunRecord;
    let flagged: FlaggedSlice[] = [];
    const link = rerunOf === undefined ? {} : { rerunOf };
    // Wall time, so an overrun is measured even where tests fix `now`.
    const precheckFrom = Date.now();
    const overrunOf = (): { overrun: PrecheckOverrun } | Record<string, never> => {
      const ms = Date.now() - precheckFrom;
      return ms > duty.precheck.timeoutMs ? { overrun: { ms, targetMs: duty.precheck.timeoutMs } } : {};
    };
    try {
      const output = await this.precheck(duty, dir, detail, previous.slice(0, 10));
      const judged = judge(duty.metrics, output);
      flagged = output.flagged ?? [];
      record = { duty: dutyId, at: started, slot: at, trigger, ms: this.now() - started, verdict: judged.verdict, metrics: judged.metrics, summary: judged.summary, detail,
        ...(judged.parts ? { parts: judged.parts } : {}),
        ...(judged.verdict === "error" ? { error: judged.summary } : {}), ...overrunOf(), ...link };
    } catch (error) {
      await rm(detail, { force: true });
      record = { duty: dutyId, at: started, slot: at, trigger, ms: this.now() - started, verdict: "error", metrics: {}, summary: "the precheck failed", error: message(error).slice(0, 500),
        ...overrunOf(), ...link };
    }
    if (record.overrun) this.log(`duty ${chatId.slice(0, 8)}/${dutyId}: ${overrunWords(record.overrun)}`);
    const overrunLine = record.overrun ? `This run went over: ${overrunWords(record.overrun)}. Make the precheck faster or set its timeoutMs to what it needs.` : "";
    const streak = record.verdict === "error" ? errorStreak([record, ...previous]) : 0;
    await markRun();
    const misses = await this.missesOf(chatId, record, previous, duty.metrics);
    let findings: string;
    if (record.verdict === "error") {
      findings = [`The precheck failed: ${record.error ?? record.summary}. ${streak >= ERROR_RUNS_TARGET ? `It failed ${streak} runs in a row, over the target of ` +
        `${ERROR_RUNS_TARGET}: fix the precheck first.` : "Fix the precheck or check the duty by hand."}`, overrunLine, stuckFindings(misses)].filter(Boolean).join("\n\n");
    } else {
      const file = await this.writeDetail(chatId, `${dutyId}-${runStamp(started)}`, [`# ${duty.name} run of ${new Date(started).toISOString()}`,
        `Measured against the targets: ${record.summary}.`, overrunLine, ...record.detail ? [`The full precheck output is ${record.detail}.`] : [], flaggedSection(flagged)]);
      const headline = headlineOf(duty.metrics, record);
      findings = [briefFindings({ headline: headline?.words ?? null, flagged, ...headline ? { headlineKey: headline.key } : {}, detail: file }), overrunLine, stuckFindings(misses)]
        .filter(Boolean).join("\n\n");
    }
    this.steps.set(key, { at: started, step: "starting its job" });
    const measured = record.verdict === "met" || record.verdict === "missed" ? { at: started, verdict: record.verdict, metrics: record.metrics, summary: record.summary,
      ...(record.parts ? { parts: record.parts } : {}) } : null;
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
    const [command, ...args] = this.host.precheckCommand?.(duty) ?? duty.precheck.command;
    const file = command === "node" ? this.host.node ?? process.execPath : command!;
    const stderrFile = `${outputFile.replace(/\.json$/, "")}.stderr.log`;
    try {
      try { await this.spawnPrecheck(duty, dir, file, args, stderrFile, { STATE_FILE: nextState, LAST_RUNS_FILE: lastRunsFile, OUTPUT_FILE: outputFile }); }
      catch (error) {
        const tail = (await readFile(stderrFile, "utf8").catch(() => "")).trim().split("\n").slice(-3).join(" ").slice(0, 300);
        throw new Error(`${message(error)}${tail ? `: ${tail}` : ""} (all of stderr: ${stderrFile})`);
      }
      await rm(stderrFile, { force: true });
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

  /**
   * Runs the precheck command with its stderr in `stderrFile` and its stdout dropped, so no output size ends it. Past its soft target it keeps
   * running and the log says so; only `precheckHardStopMs` kills it. Resolves on exit 0 and rejects with the exit or the hard stop otherwise.
   */
  private async spawnPrecheck(duty: Duty, dir: string, file: string, args: string[], stderrFile: string, env: Record<string, string>): Promise<void> {
    const stderr = await openFile(stderrFile, "w", 0o600);
    try {
      await new Promise<void>((resolve, reject) => {
        const child = spawn(file, args, { cwd: duty.precheck.cwd, stdio: ["ignore", "ignore", stderr.fd], env: { ...process.env, ...env } });
        const targetS = Math.round(duty.precheck.timeoutMs / 1000);
        const hardStopMs = precheckHardStopMs(duty);
        let stopped = false;
        const pastTarget = setTimeout(() => this.log(`duty ${basename(dir).slice(0, 8)}/${duty.id}: the precheck is past its ${targetS} s target and keeps ` +
          `running, up to its hard stop of ${Math.round(hardStopMs / 60_000)} min`), duty.precheck.timeoutMs);
        const hardStop = setTimeout(() => { stopped = true; child.kill("SIGKILL"); }, hardStopMs);
        const end = (error?: Error) => { clearTimeout(pastTarget); clearTimeout(hardStop); if (error) reject(error); else resolve(); };
        child.once("error", end);
        child.once("close", (code, signal) => end(code === 0 ? undefined : new Error(stopped
          ? `stopped at its hard stop after ${Math.round(hardStopMs / 60_000)} min, its schedule gap (target ${targetS} s)` : `exit ${code ?? signal}`)));
      });
    } finally { await stderr.close(); }
  }

  close(): void { clearInterval(this.timer); }
}
