import { execFile } from "node:child_process";
import { copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DutyStore } from "./chat-duty-store.ts";
import { CHECK_IN_PREFIX } from "./shared/chat-feed.ts";
import { dutyDue, dutyLine, ERROR_PAUSE_RUNS, errorStreak, judge, nextRunAt, repeatMisses, upsertDuty, type Duty, type DutyRunRecord, type DutyTrigger, type DutyView,
  type PrecheckOutput } from "./shared/chat-duties.ts";

/** What the runner needs from the server: which threads are chats, and a way to steer a chat. Tests pass fakes. */
export interface DutyHost {
  isChat(id: string): Promise<boolean>;
  notify(chatId: string, message: string): Promise<void>;
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

/**
 * Runs each chat's due duties on the server: a skip policy on overlap (a duty with a run going starts no other), one catch-up for a daily slot
 * missed by at most CATCH_UP_MS, the precheck with the file contract and its timeout, the verdict against the targets, one `[check-in]` line to
 * the chat for a miss or an error, and a pause after ERROR_PAUSE_RUNS errors in a row. A met run tells nobody.
 */
export class Duties {
  private readonly running = new Map<string, Promise<void>>();
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

  /** Gives the chat a duty definition, or updates the one with the same name (`upsertDuty`); a second call changes nothing. Returns what it did. */
  async ensure(chatId: string, definition: unknown): Promise<string> {
    const now = this.now();
    return this.store.update(chatId, duties => upsertDuty(duties, definition, now));
  }

  /** The owner's "Run now": false when the duty is unknown or already running. Paused duties run too; the pause only stops the schedule. */
  async runNow(chatId: string, dutyId: string): Promise<boolean> {
    if (!(await this.store.list(chatId)).some(duty => duty.id === dutyId)) return false;
    return this.start(chatId, dutyId, "owner", null);
  }

  /** Pause or resume; resuming a daily duty does not run the slots it missed while paused. False when the duty is unknown. */
  async setStatus(chatId: string, dutyId: string, status: Duty["status"]): Promise<boolean> {
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

  async view(chatId: string): Promise<DutyView[]> {
    const [duties, runs] = await Promise.all([this.store.list(chatId), this.store.runs(chatId)]);
    const now = this.now();
    return duties.map(duty => ({ duty, nextAt: nextRunAt(duty, now), running: this.running.has(`${chatId}/${duty.id}`),
      runs: runs.filter(run => run.duty === duty.id).slice(0, VIEW_RUNS) }));
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
