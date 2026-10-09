import { execFile } from "node:child_process";
import { copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DutyStore } from "./chat-duty-store.ts";
import { CHECK_IN_PREFIX } from "./shared/chat-feed.ts";
import { afterTurnCheck, afterTurnLine, armItems, type ArmedItem, CHECK_IN_DUTY, CHECK_IN_DUTY_ID, dailySlot, dutyDue, dutyLine, ERROR_PAUSE_RUNS, errorStreak, judge,
  nextRunAt, parseSchedule, repeatMisses, type Duty, type DutyRunRecord, type DutyTrigger, type DutyView, type FlaggedSlice,
  type PrecheckOutput } from "./shared/chat-duties.ts";
import { CHECK_IN_MAX_MINUTES, CHECK_IN_MIN_MINUTES, type ChatBoard, type CheckInPause, type CheckInView } from "./shared/types.ts";

/**
 * The check-in duty's side on the chat server (src/chats.ts): its setting (the header's control writes the same one), a run now, and its
 * precheck alone, with no steer, for the recheck after the chat's turn.
 */
export interface CheckInDutyHost {
  view(chatId: string): Promise<CheckInView | null>;
  set(chatId: string, change: { everyMs?: number; pause?: CheckInPause | null }): Promise<CheckInView | null>;
  run(chatId: string): Promise<void>;
  measure(chatId: string): Promise<PrecheckOutput | null>;
}
/** One run of the check-in duty as the chat server ran it: the measure (none for a job event), the step classes, what it told the chat. */
export interface CheckInRun {
  at: number; trigger: DutyTrigger; summary: string; told: boolean;
  output?: PrecheckOutput & { flagged: FlaggedSlice[] }; classes?: Record<string, number>;
  /** False when the run handed its items to a check-in job: the job is the work started for them, so no recheck after the chat's turn. */
  recheck?: boolean;
}
/** A check-in run with no tell, no event and the same metrics as the last record is kept at most this often. */
export const CHECK_IN_RECORD_EVERY_MS = 60 * 60_000;

/** What the runner needs from the server: which threads are chats, and a way to steer a chat. Tests pass fakes. */
export interface DutyHost {
  isChat(id: string): Promise<boolean>;
  notify(chatId: string, message: string): Promise<void>;
  /** The chat's board, for the after-turn recheck (did the chat touch a flagged step). Absent: no recheck. */
  board?: (chatId: string) => Promise<ChatBoard | null>;
  /** The built-in check-in duty. Absent (tests of standing duties): the card lists no check-in. */
  checkIn?: CheckInDutyHost;
  log?: (line: string) => void;
  now?: () => number;
  /** How often the runner looks for due duties; 0 starts no timer (tests call `tick`). Default DUTY_TICK_MS. */
  tickMs?: number;
  /** The node binary a precheck whose first word is `node` runs with; default this process's. */
  node?: string;
}

export const DUTY_TICK_MS = 30_000;
/** The card shows this many runs per duty. */
export const VIEW_RUNS = 14;

const pad = (value: number): string => String(value).padStart(2, "0");
/** `261008-2307`, local time: names a run's saved output. */
export function runStamp(at: number): string {
  const date = new Date(at);
  return `${pad(date.getFullYear() % 100)}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`;
}

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
 * missed by at most CATCH_UP_MS, the precheck with the file contract and its timeout, the verdict against the targets, one `[check-in]` line to
 * the chat for a miss or an error, and a pause after ERROR_PAUSE_RUNS errors in a row. A met run tells nobody. A told run whose flagged items
 * name plan steps is checked again when the chat's turn ends (`afterTurn`). The check-in duty runs on the chat server; its runs are recorded
 * here (`recordCheckIn`) and its card reads and edits the chat's check-in setting.
 */
export class Duties {
  private readonly running = new Map<string, Promise<void>>();
  /** Told runs waiting for the end of the chat's turn, by `<chatId>/<dutyId>`: when the chat was told, and the items to check again. */
  private readonly armed = new Map<string, { at: number; items: ArmedItem[] }>();
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
    await this.store.appendRun(chatId, { duty: duty.id, at, trigger: "schedule", ms: 0, verdict: "skipped", metrics: {},
      summary: `the ${new Date(slot).toTimeString().slice(0, 5)} run was missed by more than 6 h (machine asleep)`, told: false });
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

  /** The owner's "Run now": false when the duty is unknown or already running. Paused duties run too; the pause only stops the schedule. */
  async runNow(chatId: string, dutyId: string): Promise<boolean> {
    if (dutyId === CHECK_IN_DUTY_ID && this.host.checkIn) {
      const key = `${chatId}/${dutyId}`;
      if (this.running.has(key)) return false;
      const run = this.host.checkIn.run(chatId).catch(error => this.log(`duty ${chatId.slice(0, 8)}/${dutyId}: ${message(error)}`)).finally(() => this.running.delete(key));
      this.running.set(key, run);
      return true;
    }
    if (!(await this.store.list(chatId)).some(duty => duty.id === dutyId)) return false;
    return this.start(chatId, dutyId, "owner", null);
  }

  /**
   * Pause or resume; resuming a daily duty does not run the slots it missed while paused. False when the duty is unknown. The check-in duty's
   * pause is the chat's check-in pause until resumed, the same one the header's control sets.
   */
  async setStatus(chatId: string, dutyId: string, status: Duty["status"]): Promise<boolean> {
    if (dutyId === CHECK_IN_DUTY_ID && this.host.checkIn) return (await this.host.checkIn.set(chatId, { pause: status === "paused" ? "forever" : null })) !== null;
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
  async setSchedule(chatId: string, dutyId: string, value: unknown): Promise<boolean> {
    if (dutyId === CHECK_IN_DUTY_ID && this.host.checkIn) return (await this.host.checkIn.set(chatId, { everyMs: checkInMinutes(value) * 60_000 })) !== null;
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
   * Records one check-in run as a run of the check-in duty: its metrics against `CHECK_IN_DUTY`'s targets (a job event has none), its step
   * classes and flagged items. A quiet scheduled run with the same metrics as the last record is kept at most every CHECK_IN_RECORD_EVERY_MS,
   * so the history stays readable. A told run whose items name steps is checked again when the chat's turn ends.
   */
  async recordCheckIn(chatId: string, run: CheckInRun): Promise<void> {
    const judged = run.output ? judge(CHECK_IN_DUTY.metrics, run.output) : undefined;
    const record: DutyRunRecord = { duty: CHECK_IN_DUTY_ID, at: run.at, trigger: run.trigger, ms: Math.max(0, this.now() - run.at),
      verdict: judged?.verdict ?? "missed", metrics: judged?.metrics ?? {}, summary: run.summary, told: run.told,
      ...(run.classes ? { classes: run.classes } : {}), ...(run.output?.flagged.length ? { flagged: run.output.flagged } : {}) };
    if (run.told && run.recheck !== false && run.output && this.host.board) {
      const items = armItems(run.output.flagged, await this.host.board(chatId).catch(() => null));
      if (items.length) this.armed.set(`${chatId}/${CHECK_IN_DUTY_ID}`, { at: run.at, items });
    }
    const last = (await this.store.runs(chatId)).find(entry => entry.duty === CHECK_IN_DUTY_ID && entry.trigger !== "after-turn" && Object.keys(entry.metrics).length > 0);
    const same = last !== undefined && JSON.stringify(last.metrics) === JSON.stringify(record.metrics);
    if (!run.told && run.trigger === "schedule" && same && run.at - last.at < CHECK_IN_RECORD_EVERY_MS) return;
    await this.store.updateFile(chatId, file => {
      const state = file.checkIn ??= { createdAt: run.at, runCount: 0 };
      state.runCount += 1;
      state.lastRunAt = run.at;
    });
    await this.store.appendRun(chatId, record);
  }

  /**
   * The end of a chat's turn: each told run of the chat waiting for it is checked again with the same check (the precheck, or the check-in's
   * classes), once. An item the check still flags on a step the chat did not touch goes back to the chat by name, and the record keeps it as
   * unresolved (Chat health's `unresolved_after_turn`). An item the chat handled, or the check no longer flags, is kept as handled.
   */
  afterTurn(chatId: string): Promise<void> {
    const now = this.now();
    const due = [...this.armed].filter(([key, armed]) => key.startsWith(chatId + "/") && armed.at < now);
    return Promise.all(due.map(async ([key, armed]) => {
      this.armed.delete(key);
      const dutyId = key.slice(chatId.length + 1);
      try { await this.recheck(chatId, dutyId, armed.items); }
      catch (error) { this.log(`duty ${chatId.slice(0, 8)}/${dutyId}: after-turn recheck: ${message(error)}`); }
    })).then(() => {});
  }

  private async recheck(chatId: string, dutyId: string, items: readonly ArmedItem[]): Promise<void> {
    const started = this.now();
    const standing = dutyId === CHECK_IN_DUTY_ID ? undefined : (await this.store.list(chatId)).find(entry => entry.id === dutyId);
    const duty = standing ?? (dutyId === CHECK_IN_DUTY_ID ? CHECK_IN_DUTY : undefined);
    if (!duty) return;
    let output: PrecheckOutput | null;
    if (standing) {
      const dir = this.store.chatDir(chatId);
      output = await this.precheck(standing, dir, join(dir, `${dutyId}-${runStamp(started)}-after-turn.json`), []);
    } else output = await this.host.checkIn!.measure(chatId);
    if (!output) return;
    const board = await this.host.board!(chatId).catch(() => null);
    const { handled, unresolved } = afterTurnCheck(items, output.flagged ?? [], board);
    const judged = judge(duty.metrics, output);
    const record: DutyRunRecord = { duty: dutyId, at: started, trigger: "after-turn", ms: this.now() - started, verdict: judged.verdict, metrics: judged.metrics,
      summary: `after the chat's turn: ${handled.length} handled, ${unresolved.length} still flagged with no change`, told: false,
      ...(handled.length ? { handled } : {}), ...(unresolved.length ? { unresolved } : {}) };
    if (unresolved.length) {
      try { await this.host.notify(chatId, CHECK_IN_PREFIX + afterTurnLine(duty, unresolved)); record.told = true; }
      catch (error) { this.log(`duty ${chatId.slice(0, 8)}/${dutyId}: tell the chat: ${message(error)}`); }
    }
    await this.store.appendRun(chatId, record);
    this.log(`duty ${chatId.slice(0, 8)}/${dutyId}: after-turn recheck: ${record.summary}`);
  }

  /** Resolves once every run going now has ended, for tests. */
  async settled(): Promise<void> { while (this.running.size) await Promise.all([...this.running.values()]); }

  private async run(chatId: string, dutyId: string, trigger: DutyTrigger, slot: number | null): Promise<void> {
    const duty = (await this.store.list(chatId)).find(entry => entry.id === dutyId);
    if (!duty) return;
    const started = this.now();
    const previous = (await this.store.runs(chatId)).filter(run => run.duty === dutyId && run.verdict !== "skipped");
    const dir = this.store.chatDir(chatId);
    const detail = join(dir, `${dutyId}-${runStamp(started)}.json`);
    let record: DutyRunRecord;
    try {
      const output = await this.precheck(duty, dir, detail, previous.slice(0, 10));
      const judged = judge(duty.metrics, output);
      record = { duty: dutyId, at: started, trigger, ms: this.now() - started, verdict: judged.verdict, metrics: judged.metrics, summary: judged.summary, detail,
        ...(judged.verdict === "error" ? { error: judged.summary } : {}), told: false };
    } catch (error) {
      await rm(detail, { force: true });
      record = { duty: dutyId, at: started, trigger, ms: this.now() - started, verdict: "error", metrics: {}, summary: "the precheck failed", error: message(error).slice(0, 500), told: false };
    }
    const pause = record.verdict === "error" && errorStreak([record, ...previous]) >= ERROR_PAUSE_RUNS;
    await this.store.update(chatId, duties => {
      const found = duties.find(entry => entry.id === dutyId);
      if (!found) return;
      found.runCount += 1;
      found.lastRunAt = started;
      if (slot !== null && found.schedule.kind === "daily") found.lastSlotAt = slot;
      if (pause) { found.status = "paused"; found.updatedAt = this.now(); }
    });
    const line = dutyLine(duty, record, repeatMisses(record, previous[0]), pause);
    if (line) {
      try { await this.host.notify(chatId, CHECK_IN_PREFIX + line); record.told = true; }
      catch (error) { this.log(`duty ${chatId.slice(0, 8)}/${dutyId}: tell the chat: ${message(error)}`); }
    }
    if (record.told && record.verdict === "missed" && this.host.board) {
      const flagged = await readFile(detail, "utf8").then(text => (JSON.parse(text) as PrecheckOutput).flagged ?? [], () => []);
      const items = armItems(flagged, await this.host.board(chatId).catch(() => null));
      if (items.length) this.armed.set(`${chatId}/${dutyId}`, { at: started, items });
    }
    await this.store.appendRun(chatId, record);
    this.log(`duty ${chatId.slice(0, 8)}/${dutyId}: ${record.verdict}, ${record.summary}`);
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
