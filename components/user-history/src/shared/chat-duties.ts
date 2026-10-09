/**
 * Duties: standing work a chat owns. A duty is a goal in the owner's words with numeric targets, a schedule, and a code precheck that measures
 * the targets for 0 tokens. The server runs the precheck when the duty is due; only a miss or an error wakes the chat, with one `[check-in]` line.
 * Pure types and rules here; the store is src/chat-duty-store.ts and the runner src/chat-duty-run.ts.
 */

export type DutySchedule = { kind: "daily"; at: string } | { kind: "every"; minutes: number };
export interface DutyMetric { key: string; label: string; op: "<=" | ">="; target: number; unit?: string }
/**
 * The precheck: `command` is an argv run in `cwd` with no shell (a first word `node` is this server's node). It gets the env STATE_FILE (its JSON
 * state, kept between runs, only when it exits 0), LAST_RUNS_FILE (the duty's last 10 run records) and OUTPUT_FILE, and writes a `PrecheckOutput`
 * to OUTPUT_FILE. A nonzero exit, a timeout or bad JSON is an error run.
 */
export interface DutyPrecheck { command: string[]; cwd: string; timeoutMs: number }
export interface PrecheckOutput { metrics: Record<string, number>; flagged?: FlaggedSlice[] }
/** One thing the precheck found that a person or a job should read: the chat (session id), when, what kind, and a short excerpt. */
export interface FlaggedSlice { chat?: string; at?: number; kind: string; excerpt: string }

export interface Duty {
  id: string;
  name: string;
  /** The owner's message that asked for it, verbatim. */
  ownerWords: string;
  /** What good means, in plain words. The metrics are its measurable part. */
  goal: string;
  metrics: DutyMetric[];
  schedule: DutySchedule;
  precheck: DutyPrecheck;
  /** What the chat does on a miss; it ends the `[check-in]` line. */
  onMiss: string;
  /** The plan item the fixes go under. */
  boardGoal?: string;
  status: "active" | "paused";
  createdAt: number;
  updatedAt: number;
  /** Run state, in prime-agent's schedule words. `lastSlotAt` is the daily slot the last run or skip covered. */
  runCount: number;
  lastRunAt?: number;
  lastSlotAt?: number;
  lastSkippedAt?: number;
}
export interface DutyFile { version: 1; duties: Duty[] }

export type DutyTrigger = "schedule" | "catch-up" | "owner";
export type DutyVerdict = "met" | "missed" | "error" | "skipped";
export interface MetricResult { value: number; target: number; op: DutyMetric["op"]; met: boolean }
/** One line of `<dataDir>/duties/<chatId>.runs.jsonl`. `detail` is the saved precheck output; `told` says the chat got a line. */
export interface DutyRunRecord {
  duty: string; at: number; trigger: DutyTrigger; ms: number; verdict: DutyVerdict;
  metrics: Record<string, MetricResult>; summary: string; detail?: string; error?: string; told: boolean;
}
/** What the Duties card shows per duty: the duty, when it runs next, whether a run is going now, and its last runs, newest first. */
export interface DutyView { duty: Duty; nextAt: number | null; running: boolean; runs: DutyRunRecord[] }

/** A missed daily slot still runs once after the Mac wakes if it is at most this late; later it is recorded as skipped. */
export const CATCH_UP_MS = 6 * 60 * 60_000;
/** A slot run this late counts as a catch-up rather than on schedule. */
export const LATE_MS = 5 * 60_000;
/** This many error runs in a row pause the duty until someone resumes it. */
export const ERROR_PAUSE_RUNS = 3;
export const PRECHECK_TIMEOUT_MS = 120_000;

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const KEY = /^[a-z][a-z0-9_]{0,39}$/;
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const str = (value: unknown, max: number): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= max;

/** The latest daily slot at or before `now`, in this machine's local time. */
export function dailySlot(at: string, now: number): number {
  const [, hours, minutes] = HHMM.exec(at)!;
  const slot = new Date(now);
  slot.setHours(Number(hours), Number(minutes), 0, 0);
  if (slot.getTime() > now) slot.setDate(slot.getDate() - 1);
  return slot.getTime();
}

/** Whether the duty runs now, and why; or a slot that is too late to run and is recorded as skipped. A paused duty is never due. */
export function dutyDue(duty: Duty, now: number): { kind: "no" } | { kind: "run"; trigger: DutyTrigger; slot: number } | { kind: "skip"; slot: number } {
  if (duty.status !== "active") return { kind: "no" };
  if (duty.schedule.kind === "every") {
    return now - (duty.lastRunAt ?? duty.createdAt) >= duty.schedule.minutes * 60_000 ? { kind: "run", trigger: "schedule", slot: now } : { kind: "no" };
  }
  const slot = dailySlot(duty.schedule.at, now);
  if (slot <= Math.max(duty.lastSlotAt ?? 0, duty.createdAt)) return { kind: "no" };
  if (now - slot > CATCH_UP_MS) return { kind: "skip", slot };
  return { kind: "run", trigger: now - slot > LATE_MS ? "catch-up" : "schedule", slot };
}

/** When the duty runs next, for the card; null while paused. */
export function nextRunAt(duty: Duty, now: number): number | null {
  if (duty.status !== "active") return null;
  if (duty.schedule.kind === "every") return Math.max(now, (duty.lastRunAt ?? duty.createdAt) + duty.schedule.minutes * 60_000);
  const due = dutyDue(duty, now);
  if (due.kind === "run") return now;
  const next = new Date(dailySlot(duty.schedule.at, now));
  next.setDate(next.getDate() + 1);
  return next.getTime();
}

const met = (metric: DutyMetric, value: number): boolean => metric.op === "<=" ? value <= metric.target : value >= metric.target;
const show = (metric: DutyMetric, value: number): string => `${Math.round(value * 10) / 10}${metric.unit ?? ""}`;

/**
 * The verdict of one precheck output against the duty's targets: met when every metric is on target, missed otherwise, error when the output
 * lacks a metric. The summary names each miss with its target, or says all are on target.
 */
export function judge(metrics: readonly DutyMetric[], output: PrecheckOutput): { verdict: "met" | "missed" | "error"; metrics: Record<string, MetricResult>; summary: string } {
  const results: Record<string, MetricResult> = {};
  const absent = metrics.filter(metric => typeof output.metrics[metric.key] !== "number" || !Number.isFinite(output.metrics[metric.key]));
  if (absent.length) return { verdict: "error", metrics: results, summary: `the precheck gave no value for ${absent.map(metric => metric.key).join(", ")}` };
  const misses: string[] = [];
  for (const metric of metrics) {
    const value = output.metrics[metric.key]!;
    results[metric.key] = { value, target: metric.target, op: metric.op, met: met(metric, value) };
    if (!results[metric.key]!.met) misses.push(`${metric.key} ${show(metric, value)} (target ${metric.op === "<=" ? "at most" : "at least"} ${show(metric, metric.target)})`);
  }
  return misses.length ? { verdict: "missed", metrics: results, summary: misses.join(", ") } : { verdict: "met", metrics: results, summary: `all ${metrics.length} on target` };
}

/** The metrics that missed in this run and in the run before it. */
export function repeatMisses(record: DutyRunRecord, previous: DutyRunRecord | undefined): string[] {
  if (!previous || previous.verdict !== "missed") return [];
  return Object.entries(record.metrics).filter(([key, result]) => !result.met && previous.metrics[key]?.met === false).map(([key]) => key);
}

/** How many runs in a row, newest first, ended in error. */
export function errorStreak(runs: readonly DutyRunRecord[]): number {
  let count = 0;
  for (const run of runs) { if (run.verdict === "skipped") continue; if (run.verdict !== "error") break; count++; }
  return count;
}

/**
 * The line the chat gets for a run, or null for a met or skipped run (quiet days stay quiet). A metric that missed twice in a row, or an error
 * streak that paused the duty, asks for one tell_owner.
 */
export function dutyLine(duty: Duty, record: DutyRunRecord, repeats: readonly string[], paused: boolean): string | null {
  const head = `duty ${duty.id} "${duty.name}"`;
  if (record.verdict === "missed") {
    const detail = record.detail ? ` Details: ${record.detail}.` : "";
    const repeat = repeats.length ? ` ${repeats.join(", ")} missed two runs in a row: call tell_owner once.` : "";
    const under = duty.boardGoal ? ` File each fix as a step under ${duty.boardGoal}.` : "";
    return `${head} missed: ${record.summary}.${detail} ${duty.onMiss}${under}${repeat}`;
  }
  if (record.verdict === "error") {
    const pause = paused ? ` It failed ${ERROR_PAUSE_RUNS} runs in a row and is paused until resumed: give the precheck to a job, then call tell_owner once.` : " Give the precheck to a job if it fails again.";
    return `${head} precheck failed: ${record.error ?? record.summary}.${pause}`;
  }
  return null;
}

/** Parses a duty definition from a file or a request: the fields a person writes. Run state starts empty. Throws with the first bad field. */
export function parseDutyInput(value: unknown, id: string, now: number): Duty {
  if (!isRecord(value)) throw new Error("A duty is an object.");
  const { name, ownerWords, goal, metrics, schedule, precheck, onMiss, boardGoal } = value;
  if (!str(name, 80)) throw new Error("name: 1 to 80 characters.");
  if (!str(ownerWords, 4000)) throw new Error("ownerWords: the owner's words, verbatim.");
  if (!str(goal, 400)) throw new Error("goal: what good means, in plain words.");
  if (!str(onMiss, 1000)) throw new Error("onMiss: what the chat does on a miss.");
  if (boardGoal !== undefined && !(typeof boardGoal === "string" && /^p\d+$/.test(boardGoal))) throw new Error("boardGoal: a plan item id like p87.");
  if (!Array.isArray(metrics) || !metrics.length || metrics.length > 12) throw new Error("metrics: 1 to 12.");
  const parsedMetrics = metrics.map((metric: unknown, index): DutyMetric => {
    if (!isRecord(metric) || typeof metric.key !== "string" || !KEY.test(metric.key) || !str(metric.label, 80) || (metric.op !== "<=" && metric.op !== ">=") ||
      typeof metric.target !== "number" || !Number.isFinite(metric.target) || (metric.unit !== undefined && typeof metric.unit !== "string")) throw new Error(`metrics[${index}]: key, label, op (<= or >=) and target.`);
    return { key: metric.key, label: metric.label, op: metric.op, target: metric.target, ...(typeof metric.unit === "string" ? { unit: metric.unit } : {}) };
  });
  if (!isRecord(schedule)) throw new Error("schedule: { kind: daily, at: HH:MM } or { kind: every, minutes }.");
  let parsedSchedule: DutySchedule;
  if (schedule.kind === "daily" && typeof schedule.at === "string" && HHMM.test(schedule.at)) parsedSchedule = { kind: "daily", at: schedule.at };
  else if (schedule.kind === "every" && typeof schedule.minutes === "number" && Number.isInteger(schedule.minutes) && schedule.minutes >= 5) parsedSchedule = { kind: "every", minutes: schedule.minutes };
  else throw new Error("schedule: { kind: daily, at: HH:MM } or { kind: every, minutes } (5 or more).");
  if (!isRecord(precheck) || !Array.isArray(precheck.command) || !precheck.command.length || !precheck.command.every(word => typeof word === "string" && word.length > 0) ||
    !str(precheck.cwd, 1024)) throw new Error("precheck: { command: [argv], cwd, timeoutMs? }.");
  const timeoutMs = typeof precheck.timeoutMs === "number" && precheck.timeoutMs > 0 ? Math.min(precheck.timeoutMs, PRECHECK_TIMEOUT_MS) : PRECHECK_TIMEOUT_MS;
  return { id, name: name.trim(), ownerWords, goal: goal.trim(), metrics: parsedMetrics, schedule: parsedSchedule,
    precheck: { command: precheck.command as string[], cwd: precheck.cwd, timeoutMs }, onMiss: onMiss.trim(), ...(boardGoal ? { boardGoal } : {}),
    status: "active", createdAt: now, updatedAt: now, runCount: 0 };
}

/**
 * Adds a duty definition to a chat's duties, or updates the definition of the duty with the same name and keeps its run state, so applying it
 * twice changes nothing. Returns what it did: "added d3", "updated d1" or "unchanged d1".
 */
export function upsertDuty(duties: Duty[], definition: unknown, now: number): string {
  const parsed = parseDutyInput(definition, nextDutyId(duties), now);
  const existing = duties.find(duty => duty.name === parsed.name);
  if (!existing) { duties.push(parsed); return `added ${parsed.id}`; }
  const { id: _id, status: _status, createdAt: _createdAt, updatedAt: _updatedAt, runCount: _runCount, ...fields } = parsed;
  if (JSON.stringify({ ...existing, ...fields, updatedAt: existing.updatedAt }) === JSON.stringify(existing)) return `unchanged ${existing.id}`;
  Object.assign(existing, fields, { updatedAt: now });
  return `updated ${existing.id}`;
}

export const CONVERGENCE_DUTY = "Board convergence";
/**
 * The duty every chat gets (`Chats.chatAdded`): every hour, the board classes script (scripts/duties/board-classes.ts, run in `cwd`, the
 * user-history component) measures the chat's board, and only a miss wakes the chat.
 */
export function convergenceDuty(chatId: string, cwd: string): Record<string, unknown> {
  return {
    name: CONVERGENCE_DUTY,
    ownerWords: "look, eventually on it's own all threads should resolve to\nsome items in FOR YOU\nTODO all cleared, only ones blocked by FOR YOU remaining.\n" +
      "manage stale shit, properly nudge push through, ... is you (chat agent's responsiblitity). and since your job is to make this work on it's own automagically via the right prompts logic add to duties, ..\n" +
      "todo must be suuuper up to date lauer (i know it need active management, but the child agent must try it's best to return callback when done, main thread and check-in should try it's best to keep it up to date)\n" +
      "it doesn't seem like it has been working at all.",
    goal: "Every open plan step is done, moved by a live owner, or blocked only by an open For you todo. The board matches what the jobs reported.",
    metrics: [
      { key: "orphan_steps", label: "Open steps with no live owner, todo or wait", op: "<=", target: 0 },
      { key: "due_late", label: "Steps due for more than one check-in", op: "<=", target: 0 },
      { key: "stale_chase_24h", label: "Chases over 24 h with no For you todo", op: "<=", target: 0 },
      { key: "job_end_unrecorded", label: "Steps whose job ended a check-in ago, not updated", op: "<=", target: 0 },
      { key: "job_end_silent", label: "Steps whose job stopped on an error with no report, not updated", op: "<=", target: 0 },
    ],
    schedule: { kind: "every", minutes: 60 },
    precheck: { command: ["node", "--import", "tsx", "scripts/duties/board-classes.ts", "--chat", chatId], cwd, timeoutMs: 90_000 },
    onMiss: "In this turn, act on each step the details file lists: an orphan gets a job, you, or one For you todo; a due step gets done or a new waitUntil; " +
      "a chase over 24 h becomes a For you todo or a new plan; a step whose job ended gets that job's result on the board; a step whose job stopped " +
      "with no report gets that job re-briefed, restarted or replaced. If the same miss comes back, " +
      "send the details file to the thread named realtime layer.",
  };
}

/** The next duty id in a chat: d1, d2, ... never reused. */
export function nextDutyId(duties: readonly Duty[]): string {
  return `d${duties.reduce((max, duty) => Math.max(max, Number(duty.id.slice(1)) || 0), 0) + 1}`;
}

/** A duties file as stored; unreadable duties are dropped rather than failing the chat's whole list. */
export function parseDutyFile(value: unknown): DutyFile {
  const duties = isRecord(value) && Array.isArray(value.duties) ? value.duties : [];
  return { version: 1, duties: duties.filter((duty): duty is Duty => isRecord(duty) && typeof duty.id === "string" && isRecord(duty.schedule) && isRecord(duty.precheck) &&
    Array.isArray(duty.metrics) && (duty.status === "active" || duty.status === "paused") && typeof duty.runCount === "number") };
}
