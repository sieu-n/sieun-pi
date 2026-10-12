import { execFile } from "node:child_process";
import { copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type DutyJobHost, dutyJobBrief, type DutyJobInput, dutyJobName } from "./chat-duty-job.ts";
import type { CheckInActor } from "./chat-checkin.ts";
import type { DutyStore } from "./chat-duty-store.ts";
import { CHECK_IN_DUTY, CHECK_IN_DUTY_ID, dailySlot, dutyDue, ERROR_PAUSE_RUNS, errorStreak, judge, nextRunAt, parseSchedule, repeatMisses, type Duty, type DutyJobRef,
  type DutyRunRecord, type DutySchedule, type DutyTrigger, type DutyView, type FlaggedSlice, type PrecheckOutput } from "./shared/chat-duties.ts";
import { CHECK_IN_MAX_MINUTES, CHECK_IN_MIN_MINUTES, type CheckInPause, type CheckInView } from "./shared/types.ts";

/** The check-in duty's side on the chat server (src/chats.ts): its setting (the header's control writes the same one) and a run now. */
export interface CheckInDutyHost {
  view(chatId: string): Promise<CheckInView | null>;
  set(chatId: string, change: { everyMs?: number; pause?: CheckInPause | null }, actor: CheckInActor): Promise<CheckInView | null>;
  run(chatId: string): Promise<void>;
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
  /** The daemon health gate (src/chat-daemon-gate.ts): each wake lets it probe the daemon, at most once a minute. */
  daemon?: { tick(): Promise<void> };
}

export const DUTY_TICK_MS = 30_000;
/** The card shows this many runs per duty. */
export const VIEW_RUNS = 14;
/**
 * What the check-in job looks at besides the generic duty rules (owner 10-09: "fixes quirks like agents giving up"; Crawler VP 10-09: "split
 * tasks to subagent & Jobs actively").
 */
export const CHECK_IN_FOCUS: readonly string[] = [
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
  const intervalMs = schedule.kind === "every" ? schedule.minutes * 60_000 : 24 * 60 * 60_000;
  return Math.min(Math.max(intervalMs, STUCK_MIN_MS), STUCK_MAX_MS);
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
type Previous = { last?: DutyJobRef; replaced?: string } | { skipped: string } | null;

const message = (error: unknown): string => error instanceof Error ? error.message : String(error);

/** The check-in duty's cadence in minutes: `{ kind: every, minutes }` with a whole number the check-in setting takes. */
function checkInMinutes(value: unknown): number {
  const minutes = typeof value === "object" && value !== null && (value as { kind?: unknown }).kind === "every" ? (value as { minutes?: unknown }).minutes : undefined;
  if (typeof minutes !== "number" || !Number.isInteger(minutes) || minutes < CHECK_IN_MIN_MINUTES || minutes > CHECK_IN_MAX_MINUTES) {
    throw new Error(`The check-in runs every ${CHECK_IN_MIN_MINUTES} to ${CHECK_IN_MAX_MINUTES} minutes.`);
  }
  return minutes;
}

/**
 * Runs each chat's due duties on the server: a skip policy on overlap (a duty with a run going starts no other), one catch-up for a daily slot
 * missed by at most CATCH_UP_MS, the precheck with the file contract and its timeout, the measure against the targets, and then one duty job
 * per run with the precheck as context (src/chat-duty-job.ts), met or missed. One job per duty per slot: a run whose slot already has a job
 * starts none, and while the duty's last job still works a run measures but starts no job and says so in its summary, unless that job is stuck past
 * `stuckAfterMs` of its duty's schedule, which the run replaces. The run that starts a job retires the
 * last one: it leaves the registry at once and its archive is queued, so a slow daemon never holds up the start. A precheck that errors ERROR_PAUSE_RUNS times in a row pauses the duty; that run's job is told to fix it. The check-in duty's
 * schedule and precheck live on the chat server, which hands each run here (`checkIn`); its card reads and edits the chat's check-in setting.
 */
export class Duties {
  /** The run going per `<chatId>/<dutyId>`; a second start shares it. */
  private readonly running = new Map<string, Promise<CheckInStart | void>>();
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
    return this.ticking ??= this.scan().catch(error => this.log(`duties: tick: ${message(error)}`)).finally(() => { this.ticking = undefined; });
  }

  private async scan(): Promise<void> {
    for (const chatId of await this.store.chats()) {
      if (!(await this.host.isChat(chatId))) continue;
      for (const duty of await this.store.list(chatId)) {
        const due = dutyDue(duty, this.now());
        if (due.kind === "skip") await this.skip(chatId, duty, due.slot);
        else if (due.kind === "run") this.start(chatId, duty.id, due.trigger, due.slot);
      }
    }
  }

  private async skip(chatId: string, duty: Duty, slot: number): Promise<void> {
    const at = this.now();
    await this.store.update(chatId, duties => { const found = duties.find(entry => entry.id === duty.id); if (found) { found.lastSlotAt = slot; found.lastSkippedAt = at; } });
    await this.store.appendRun(chatId, { duty: duty.id, at, slot, trigger: "schedule", ms: 0, verdict: "skipped", metrics: {},
      summary: `the ${new Date(slot).toTimeString().slice(0, 5)} run was missed by more than 6 h (machine asleep)` });
    this.log(`duty ${chatId.slice(0, 8)}/${duty.id}: skipped a slot missed by more than 6 h`);
  }

  /** Starts a run unless one is going; false when it was already running. */
  private start(chatId: string, dutyId: string, trigger: DutyTrigger, slot: number | null): boolean {
    const key = `${chatId}/${dutyId}`;
    if (this.running.has(key)) return false;
    const run = this.run(chatId, dutyId, trigger, slot).catch(error => this.log(`duty ${chatId.slice(0, 8)}/${dutyId}: ${message(error)}`))
      .finally(() => this.running.delete(key));
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
   * writes the chat's check-in setting (the header's control shows the change); a daily time is refused for it. A daily duty moved to a time
   * already past today waits for tomorrow's slot. Throws on a bad schedule; false when the duty is unknown.
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
    const [file, runs, checkIn] = await Promise.all([this.store.read(chatId), this.store.runs(chatId), this.host.checkIn?.view(chatId) ?? null]);
    const now = this.now();
    const views: DutyView[] = file.duties.map(duty => ({ duty, schedule: duty.schedule, paused: duty.status === "paused", nextAt: nextRunAt(duty, now),
      running: this.running.has(`${chatId}/${duty.id}`), runs: runs.filter(run => run.duty === duty.id).slice(0, VIEW_RUNS) }));
    if (!checkIn) return views;
    return [{ duty: { ...CHECK_IN_DUTY, status: checkIn.paused ? "paused" : "active" }, builtin: "checkin", schedule: { kind: "every", minutes: Math.round(checkIn.everyMs / 60_000) },
      paused: checkIn.paused, nextAt: checkIn.nextAt, running: this.running.has(`${chatId}/${CHECK_IN_DUTY_ID}`),
      runs: runs.filter(run => run.duty === CHECK_IN_DUTY_ID).slice(0, VIEW_RUNS) }, ...views];
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
    let launched: Launched;
    let failed = false;
    try {
      launched = await this.launch(chatId, CHECK_IN_DUTY_ID, { kind: "every", minutes: run.everyMs / 60_000 }, run.at, run.at,
        { duty: CHECK_IN_DUTY, measure: judged.summary, findings: run.findings, focus: CHECK_IN_FOCUS });
    }
    catch (error) { failed = true; launched = { skipped: `the duty job did not start: ${message(error).slice(0, 300)}` }; }
    if (launched === null) return "done";
    if ("skipped" in launched) { record.verdict = "skipped"; record.summary = launched.skipped; }
    else { record.job = launched.job; if (launched.replaced) record.summary += launched.replaced; }
    record.ms = Math.max(0, this.now() - run.at);
    await this.store.updateFile(chatId, file => {
      const state = file.checkIn ??= { createdAt: run.at, runCount: 0 };
      state.runCount += 1;
      state.lastRunAt = run.at;
    });
    await this.store.appendRun(chatId, record);
    this.log(`duty ${chatId.slice(0, 8)}/${CHECK_IN_DUTY_ID}: ${record.verdict}, ${record.job ? `started ${record.job.name}` : record.summary}`);
    return failed ? "failed" : "done";
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
    if (!started || !last || !(await this.host.jobs.working(last))) return last ? { last } : {};
    const workingMs = this.now() - started.at;
    if (workingMs <= stuckAfterMs(schedule)) return { skipped: `${STILL_WORKING} (job ${last.name})` };
    return { last, replaced: ` (replaced stuck job ${last.name}, working ${Math.round(workingMs / 60_000)} min)` };
  }

  /**
   * Starts the duty job of one run: null when the slot already has its job (a re-entrant tick or a restart), skipped while the duty's last job
   * still works, else the last job is retired (its archive queued) and a new one starts with the brief. A chat the catalog does not list is
   * skipped too. A last job stuck past `stuckAfterMs` of the duty's schedule is retired and replaced like a finished one.
   */
  private async launch(chatId: string, dutyId: string, schedule: DutySchedule, slot: number, at: number,
    brief: Pick<DutyJobInput, "duty" | "measure" | "findings" | "focus">): Promise<Launched> {
    const previous = await this.previous(chatId, dutyId, schedule, slot);
    if (previous === null || "skipped" in previous) return previous;
    const { last, replaced } = previous;
    const chat = await this.host.jobs.chat(chatId);
    if (!chat) return { skipped: "skipped: the catalog does not list the chat" };
    if (last) await this.host.jobs.retire(last).catch(error => this.log(`duty ${chatId.slice(0, 8)}/${dutyId}: retire ${last.name}: ${message(error)}`));
    const name = dutyJobName(brief.duty.name, chat.name, at);
    const job = await this.host.jobs.start(chat, name, dutyJobBrief({ ...brief, chat, job: name, at }));
    return replaced ? { job, replaced } : { job };
  }

  /** Resolves once every run going now has ended, for tests. */
  async settled(): Promise<void> { while (this.running.size) await Promise.all([...this.running.values()]); }

  private async run(chatId: string, dutyId: string, trigger: DutyTrigger, slot: number | null): Promise<void> {
    const duty = (await this.store.list(chatId)).find(entry => entry.id === dutyId);
    if (!duty) return;
    const started = this.now();
    const at = slot ?? started;
    const markRun = (pause: boolean) => this.store.update(chatId, duties => {
      const found = duties.find(entry => entry.id === dutyId);
      if (!found) return;
      found.runCount += 1;
      found.lastRunAt = started;
      if (slot !== null && found.schedule.kind === "daily") found.lastSlotAt = slot;
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
    const repeats = repeatMisses(record, previous[0]);
    const findings = [
      ...(record.verdict === "error" ? [`The precheck failed: ${record.error ?? record.summary}. ${pause ? `It failed ${ERROR_PAUSE_RUNS} runs in a row and the duty is ` +
        "paused until resumed: fix the precheck, then tell the chat to resume the duty." : "Fix the precheck or check the duty by hand."}`] : []),
      ...(record.detail && record.verdict !== "error" ? [`The full precheck output is ${record.detail}.`] : []),
      ...(repeats.length ? [`Missed in the last run too: ${repeats.join(", ")}.`] : []),
      ...(flagged.length ? [`### Flagged\n${flagged.map(slice => `- ${slice.kind}${slice.item ? ` ${slice.item}` : ""}: ${slice.excerpt}`).join("\n")}`] : []),
    ].join("\n\n");
    try {
      const launched = await this.launch(chatId, dutyId, duty.schedule, at, started,
        { duty, measure: record.verdict === "error" ? `no measure (${record.summary})` : record.summary, findings });
      if (launched && "job" in launched) { record.job = launched.job; if (launched.replaced) record.summary += launched.replaced; }
      else if (launched) record.summary += `; ${launched.skipped}`;
    } catch (error) { this.log(`duty ${chatId.slice(0, 8)}/${dutyId}: start the duty job: ${message(error)}`); }
    await this.store.appendRun(chatId, record);
    this.log(`duty ${chatId.slice(0, 8)}/${dutyId}: ${record.verdict}, ${record.summary}${record.job ? `, started ${record.job.name}` : ""}`);
  }

  /** Runs the precheck with the file contract; its state advances only when it exits 0 with a valid output. Throws with the reason otherwise. */
  private async precheck(duty: Duty, dir: string, outputFile: string, lastRuns: readonly DutyRunRecord[]): Promise<PrecheckOutput> {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const stateFile = join(dir, `${duty.id}.state.json`);
    const nextState = join(dir, `${duty.id}.state.next.json`);
    const lastRunsFile = join(dir, `${duty.id}.last-runs.json`);
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
      await rename(nextState, stateFile);
      return output as PrecheckOutput;
    } finally { await rm(nextState, { force: true }); }
  }

  close(): void { clearInterval(this.timer); }
}
