/**
 * pi-host's scheduler: Prime's heartbeats, RLM heartbeats and cron prompts, kept in one file in the host's data dir and fired whether or not a
 * client is attached or the target session is loaded.
 *
 * A loaded session reaches the scheduler through the handle that `scheduler-extension.ts` attaches at `session_start`. A due job whose session
 * has no handle asks the host to reopen it (`SchedulerDeps.reopen`), which loads the session from its file and so attaches a handle.
 *
 * A due tick is claimed before it is delivered: the claim moves `nextRunAt` on and writes `claimedAt` to disk, and the result clears it. A host
 * that dies between the two finds the claim at its next start, records it as interrupted and does not replay the tick, as Prime's daemon does
 * (docs/daemon.md "Scheduling"). Ticks missed while the host was down come due once, then the schedule continues from that run.
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  defers, heartbeatMessage, isHeartbeat, isLive, nextRunAfter, normalizeHeartbeatSchedule, parseSchedule, type Activity, type DeliveryMode, type Job,
  type JobSource,
} from "./schedule.ts";

export const JOBS_FILE = "scheduled-jobs.json";
const MAX_TIMEOUT_MS = 2_147_483_647;

export type SendMode = "start" | "steer" | "followUp";
export type ScheduledMessage = ReturnType<typeof heartbeatMessage> | { text: string };

/** One loaded session as the scheduler sees it. */
export interface SessionHandle {
  sessionId: string;
  sessionFile?: string;
  cwd: string;
  role: "root" | "child";
  rootSessionId?: string;
  activity(): Activity;
  send(message: ScheduledMessage, mode: SendMode): void;
}

export interface SchedulerDeps {
  dataDir: string;
  /** Opens the job's session (its root first, for a child) so its handle attaches. Throws when the session is gone. */
  reopen(job: Job): Promise<void>;
  /** The heartbeat catalog changed: a heartbeat was set, paused, resumed, edited or cancelled. pi-host sends `heartbeats_changed`. */
  changed?(): void;
  log(line: string): void;
  now?(): Date;
}

export type HeartbeatAction = "pause" | "resume" | "clear";
export type ManageAction = "pause" | "resume" | "stop";

/** The catalog fields a client shows; a tick changes none of them, so ticks send no `heartbeats_changed`. */
function catalogSignature(jobs: readonly Job[]): string {
  return JSON.stringify(jobs.filter(job => isHeartbeat(job) && isLive(job)).map(job => [job.id, job.status, job.source, job.deliveryMode, job.activeSessionId, job.label, job.prompt, job.schedule]));
}

export class Scheduler {
  readonly file: string;
  private jobs: Job[] = [];
  private readonly handles = new Map<string, SessionHandle>();
  private readonly lanes = new Map<string, Promise<void>>();
  private timer: NodeJS.Timeout | undefined;
  private stopped = true;
  private running: Promise<void> | undefined;

  constructor(private readonly deps: SchedulerDeps) {
    mkdirSync(deps.dataDir, { recursive: true, mode: 0o700 });
    this.file = join(deps.dataDir, JOBS_FILE);
    this.jobs = this.read();
    const interrupted = this.jobs.filter(job => job.claimedAt);
    if (interrupted.length) {
      for (const job of interrupted) this.patch(job, { claimedAt: undefined, lastError: `interrupted: pi-host stopped before the tick claimed at ${job.claimedAt} was delivered` });
      this.write();
      deps.log(`scheduler: ${interrupted.length} tick(s) were claimed when the host stopped; they are not replayed`);
    }
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private read(): Job[] {
    if (!existsSync(this.file)) return [];
    try {
      const jobs = (JSON.parse(readFileSync(this.file, "utf8")) as { jobs?: unknown }).jobs;
      return Array.isArray(jobs) ? jobs.filter((job): job is Job => typeof job === "object" && job !== null && typeof (job as Job).id === "string") : [];
    } catch (error) {
      const aside = `${this.file}.unreadable-${Date.now()}`;
      renameSync(this.file, aside);
      this.deps.log(`scheduler: ${this.file} did not parse (${error instanceof Error ? error.message : String(error)}); moved it to ${aside}`);
      return [];
    }
  }

  private write(): void {
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ jobs: this.jobs }, null, 1)}\n`, { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  /** Applies `edit` to the job list, writes the file, re-arms the timer and reports a catalog change. */
  private mutate<T>(edit: () => T): T {
    const before = catalogSignature(this.jobs);
    const result = edit();
    this.write();
    if (catalogSignature(this.jobs) !== before) this.deps.changed?.();
    this.arm();
    return result;
  }

  private patch(job: Job, fields: Partial<Job>): Job {
    Object.assign(job, fields);
    for (const key of Object.keys(fields) as (keyof Job)[]) if (fields[key] === undefined) delete job[key];
    return job;
  }

  // ---- sessions ----

  attach(handle: SessionHandle): () => void {
    this.handles.set(handle.sessionId, handle);
    return () => { if (this.handles.get(handle.sessionId) === handle) this.handles.delete(handle.sessionId); };
  }

  handle(sessionId: string): SessionHandle | undefined {
    return this.handles.get(sessionId);
  }

  private owner(sessionId: string): SessionHandle {
    const handle = this.handles.get(sessionId);
    if (!handle) throw new Error(`Session ${sessionId} is not loaded in pi-host, so it cannot own a schedule now.`);
    if (!handle.sessionFile) throw new Error("Schedules need a persisted session file.");
    return handle;
  }

  private create(sessionId: string, source: JobSource, input: { schedule: string; prompt: string; label?: string; deliveryMode?: DeliveryMode; recurring?: boolean }): Job {
    const handle = this.owner(sessionId);
    const now = this.now();
    const prompt = input.prompt.trim();
    if (!prompt) throw new Error(source === "cron" ? "Cron job prompt cannot be empty" : "Heartbeat instruction cannot be empty");
    const parsed = parseSchedule(input.schedule, now);
    if (input.recurring && parsed.schedule.kind === "once") throw new Error("Heartbeat schedule must be recurring");
    const at = now.toISOString();
    const label = input.label?.trim();
    return {
      id: randomUUID(), status: "active", source, runtimeKind: handle.role === "child" ? "subagent" : "top-level",
      ...(source === "cron" ? {} : { deliveryMode: input.deliveryMode ?? "steer" }),
      activeSessionId: sessionId, sessionId, sessionFile: handle.sessionFile!, cwd: handle.cwd, ...(label ? { label } : {}), prompt, schedule: parsed.schedule,
      createdAt: at, updatedAt: at, nextRunAt: parsed.nextRunAt.toISOString(), runCount: 0, ...(handle.rootSessionId ? { rootSessionId: handle.rootSessionId } : {}),
    };
  }

  // ---- reads ----

  /** Every job, soonest first; `cron_list` drops completed and cancelled ones unless asked. */
  list(filter: { sessionId?: string; includeInactive?: boolean; source?: JobSource } = {}): Job[] {
    return this.jobs
      .filter(job => (filter.includeInactive || isLive(job)) && (!filter.sessionId || job.activeSessionId === filter.sessionId) && (!filter.source || job.source === filter.source))
      .sort((a, b) => (a.nextRunAt ?? "~").localeCompare(b.nextRunAt ?? "~"))
      .map(job => ({ ...job }));
  }

  /** The session's user heartbeat (`/heartbeat`), the newest active or paused one. */
  heartbeat(sessionId: string): Job | undefined {
    return this.list({ sessionId, source: "heartbeat" }).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  }

  private find(id: string): Job | undefined {
    return this.jobs.find(job => job.id === id);
  }

  // ---- user heartbeat and cron ----

  /** Sets the session's one user heartbeat and cancels the one it replaces. */
  setHeartbeat(sessionId: string, schedule: string, prompt: string, deliveryMode?: DeliveryMode): Job {
    const previous = this.heartbeat(sessionId);
    const job = this.create(sessionId, "heartbeat", { schedule: normalizeHeartbeatSchedule(schedule), prompt, deliveryMode: deliveryMode ?? previous?.deliveryMode, recurring: true });
    return this.mutate(() => {
      const at = job.createdAt;
      for (const old of this.jobs) if (old.activeSessionId === sessionId && old.source === "heartbeat" && isLive(old)) this.patch(old, { status: "cancelled", nextRunAt: undefined, updatedAt: at });
      this.jobs.push(job);
      return { ...job };
    });
  }

  updateHeartbeat(sessionId: string, action: HeartbeatAction): Job | undefined {
    const current = this.heartbeat(sessionId);
    if (!current) return undefined;
    return this.manage(sessionId, current.id, action === "clear" ? "stop" : action);
  }

  /** Pauses, resumes or stops one heartbeat or RLM heartbeat of a session; undefined when it has no live one with that id. */
  manage(sessionId: string, id: string, action: ManageAction): Job | undefined {
    const job = this.find(id);
    if (!job || job.activeSessionId !== sessionId || !isHeartbeat(job) || !isLive(job)) return undefined;
    return this.mutate(() => {
      const now = this.now();
      if (action === "pause") this.patch(job, { status: "paused", nextRunAt: undefined });
      else if (action === "stop") this.patch(job, { status: "cancelled", nextRunAt: undefined });
      else this.patch(job, { status: "active", nextRunAt: nextRunAfter(job.schedule, now)!.toISOString() });
      this.patch(job, { updatedAt: now.toISOString() });
      return { ...job };
    });
  }

  addCron(sessionId: string, schedule: string, prompt: string): Job {
    const job = this.create(sessionId, "cron", { schedule, prompt });
    return this.mutate(() => { this.jobs.push(job); return { ...job }; });
  }

  cancel(id: string): Job | undefined {
    const job = this.find(id);
    if (!job || job.status === "cancelled") return undefined;
    return this.mutate(() => { this.patch(job, { status: "cancelled", nextRunAt: undefined, updatedAt: this.now().toISOString() }); return { ...job }; });
  }

  /** Cancels every live job of a session, as Prime does when a session is killed or its file is gone. */
  cancelSession(sessionId: string): Job[] {
    const live = this.jobs.filter(job => job.activeSessionId === sessionId && isLive(job));
    if (!live.length) return [];
    return this.mutate(() => {
      const at = this.now().toISOString();
      return live.map(job => ({ ...this.patch(job, { status: "cancelled", nextRunAt: undefined, updatedAt: at }) }));
    });
  }

  /** Cancels the live jobs of a session and of every child below it, for a `kill`. */
  cancelTree(sessionId: string): Job[] {
    const ids = new Set(this.jobs.filter(job => job.activeSessionId === sessionId || job.rootSessionId === sessionId).map(job => job.activeSessionId));
    return [...ids].flatMap(id => this.cancelSession(id));
  }

  // ---- RLM heartbeats (the rlm_heartbeat skill) ----

  createRlmHeartbeat(sessionId: string, input: { instruction: string; interval?: string; label?: string; deliveryMode?: DeliveryMode }): Job {
    const job = this.create(sessionId, "rlm_heartbeat", { schedule: normalizeHeartbeatSchedule(input.interval), prompt: input.instruction, label: input.label, deliveryMode: input.deliveryMode, recurring: true });
    return this.mutate(() => { this.jobs.push(job); return { ...job }; });
  }

  updateRlmHeartbeat(sessionId: string, id: string, update: { instruction?: string; interval?: string; label?: string; status?: "pause" | "resume"; deliveryMode?: DeliveryMode }): Job | undefined {
    const job = this.find(id);
    if (!job || job.activeSessionId !== sessionId || job.source !== "rlm_heartbeat" || !isLive(job)) return undefined;
    const now = this.now();
    const next: Partial<Job> = {};
    if (update.label !== undefined) next.label = update.label.trim() || undefined;
    if (update.deliveryMode !== undefined) next.deliveryMode = update.deliveryMode;
    if (update.instruction !== undefined) {
      if (!update.instruction.trim()) throw new Error("RLM heartbeat instruction cannot be empty");
      next.prompt = update.instruction.trim();
    }
    let status = job.status;
    if (update.status === "pause") status = "paused";
    if (update.status === "resume") status = "active";
    if (update.interval !== undefined) {
      const parsed = parseSchedule(normalizeHeartbeatSchedule(update.interval), now);
      if (parsed.schedule.kind === "once") throw new Error("RLM heartbeat schedule must be recurring");
      next.schedule = parsed.schedule;
      next.nextRunAt = parsed.nextRunAt.toISOString();
    }
    next.status = status;
    if (status === "paused") next.nextRunAt = undefined;
    else if (update.status === "resume") next.nextRunAt = nextRunAfter(next.schedule ?? job.schedule, now)!.toISOString();
    next.updatedAt = now.toISOString();
    return this.mutate(() => ({ ...this.patch(job, next) }));
  }

  deleteRlmHeartbeat(sessionId: string, id: string): Job | undefined {
    const job = this.find(id);
    if (!job || job.activeSessionId !== sessionId || job.source !== "rlm_heartbeat") return undefined;
    return this.mutate(() => ({ ...this.patch(job, { status: "cancelled", nextRunAt: undefined, updatedAt: this.now().toISOString() }) }));
  }

  // ---- the clock ----

  start(): void {
    this.stopped = false;
    this.arm();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** Resolves once every dispatch started so far has reported back. */
  async idle(): Promise<void> {
    await this.running;
    await Promise.all([...this.lanes.values()]);
  }

  private arm(): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const next = this.jobs.filter(job => job.status === "active" && job.nextRunAt && !job.claimedAt).map(job => Date.parse(job.nextRunAt!)).filter(Number.isFinite);
    if (!next.length) return;
    const delay = Math.max(0, Math.min(...next) - this.now().getTime());
    this.timer = setTimeout(() => { this.timer = undefined; void this.runDue(); }, Math.min(delay, MAX_TIMEOUT_MS));
    this.timer.unref();
  }

  /** Claims every due job, writes the claims, and starts each delivery in its session's lane. Returns the number claimed. */
  async runDue(): Promise<number> {
    if (this.running) await this.running;
    let claimed: Job[] = [];
    this.running = (async () => {
      const now = this.now();
      const due = this.jobs.filter(job => job.status === "active" && !job.claimedAt && job.nextRunAt && Date.parse(job.nextRunAt) <= now.getTime());
      if (!due.length) return;
      for (const job of due) {
        const next = job.schedule.kind === "cron" ? nextRunAfter(job.schedule, new Date(now.getTime() + 1)) : nextRunAfter(job.schedule, now);
        this.patch(job, { claimedAt: now.toISOString(), nextRunAt: next?.toISOString() });
      }
      this.write();
      claimed = due;
    })();
    try { await this.running; } finally { this.running = undefined; }
    for (const job of claimed) this.queue(job);
    this.arm();
    return claimed.length;
  }

  private queue(job: Job): void {
    const lane = job.activeSessionId;
    const run = (this.lanes.get(lane) ?? Promise.resolve()).then(() => this.dispatch(job)).catch(error => this.deps.log(`scheduler: ${job.id.slice(0, 8)}: ${error instanceof Error ? error.message : String(error)}`));
    this.lanes.set(lane, run);
    void run.finally(() => { if (this.lanes.get(lane) === run) this.lanes.delete(lane); });
  }

  private async dispatch(job: Job): Promise<void> {
    let outcome: "ran" | "skipped" = "skipped";
    let error: string | undefined;
    try {
      if (job.status !== "active") return;
      let handle = this.handles.get(job.activeSessionId);
      if (!handle) {
        if (!existsSync(job.sessionFile)) {
          error = `session file ${job.sessionFile} is gone; the job was cancelled`;
          this.patch(job, { status: "cancelled", nextRunAt: undefined });
          return;
        }
        this.deps.log(`scheduler: reopening ${job.activeSessionId.slice(0, 8)} for ${job.source} ${job.id.slice(0, 8)}`);
        await this.deps.reopen(job);
        handle = this.handles.get(job.activeSessionId);
        if (!handle) throw new Error(`session ${job.activeSessionId} opened but attached no scheduler handle; is the scheduler extension loaded?`);
      }
      const activity = handle.activity();
      if (defers(job, activity)) return;
      const busy = activity.streaming;
      if (isHeartbeat(job)) {
        handle.send(heartbeatMessage({ ...job, runCount: job.runCount + 1 }), busy ? (job.deliveryMode === "follow_up" ? "followUp" : "steer") : "start");
      } else {
        handle.send({ text: job.prompt }, busy ? "followUp" : "start");
      }
      outcome = "ran";
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
      outcome = "ran";
    } finally {
      const at = this.now().toISOString();
      const fields: Partial<Job> = { claimedAt: undefined, updatedAt: at };
      if (outcome === "ran") Object.assign(fields, { runCount: job.runCount + 1, lastRunAt: at, lastError: error });
      else Object.assign(fields, { lastSkippedAt: at, lastError: error });
      if (job.schedule.kind === "once" && job.status === "active" && outcome === "ran") Object.assign(fields, { status: "completed", nextRunAt: undefined });
      this.mutate(() => this.patch(job, fields));
      this.deps.log(`scheduler: ${job.source} ${job.id.slice(0, 8)} for ${job.activeSessionId.slice(0, 8)} ${outcome}${error ? `: ${error}` : ""}`);
    }
  }
}
