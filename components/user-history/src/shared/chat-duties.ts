import type { ChatBoard, PlanItem } from "./types.ts";

/**
 * Duties: standing work a chat owns. A duty is a goal in the owner's words with numeric targets, a schedule, and a code precheck that measures
 * the targets for 0 tokens. The server runs the precheck when the duty is due; only a miss or an error wakes the chat, with one `[check-in]` line.
 * After the chat's turn the same check runs again: an item still flagged that the chat did not touch goes back to it by name (`afterTurnCheck`).
 * Every chat also has one built-in duty, the check-in (`CHECK_IN_DUTY`): its schedule is the chat's check-in setting, its precheck the step
 * classes (src/chat-checkin.ts) and its runner the chat server's check-in (src/chats.ts), which records each run here.
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
/**
 * One thing the precheck found that a person or a job should read: the chat (session id), when, what kind, and a short excerpt. `item` is the
 * plan item id on the duty's chat board it is about; only such items are checked again after the chat's turn.
 */
export interface FlaggedSlice { chat?: string; at?: number; kind: string; excerpt: string; item?: string }

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
/** The built-in check-in duty's run state in a chat's duties file; its definition is `CHECK_IN_DUTY` and its schedule the check-in setting. */
export interface CheckInDutyState { createdAt: number; runCount: number; lastRunAt?: number }
export interface DutyFile { version: 1; duties: Duty[]; checkIn?: CheckInDutyState }

/**
 * What started a run: its schedule, a catch-up, the owner's Run now, a job event that wakes the check-in duty (a job that ended with no report,
 * one that says it waits, one that stopped on an error), or the recheck after the chat's turn.
 */
export type DutyTrigger = "schedule" | "catch-up" | "owner" | "job-ended" | "job-waiting" | "job-stopped" | "after-turn";
export type DutyVerdict = "met" | "missed" | "error" | "skipped";
export interface MetricResult { value: number; target: number; op: DutyMetric["op"]; met: boolean }
/**
 * One line of `<dataDir>/duties/<chatId>.runs.jsonl`. `detail` is the saved precheck output; `told` says the chat got a line. A check-in run
 * keeps its step counts per class and its flagged items inline (`classes`, `flagged`); a recheck after the chat's turn keeps the items the
 * chat handled and the ones it left (`handled`, `unresolved`).
 */
export interface DutyRunRecord {
  duty: string; at: number; trigger: DutyTrigger; ms: number; verdict: DutyVerdict;
  metrics: Record<string, MetricResult>; summary: string; detail?: string; error?: string; told: boolean;
  classes?: Record<string, number>; flagged?: FlaggedSlice[]; handled?: string[]; unresolved?: FlaggedSlice[];
}
/** The part of a duty the card shows; the check-in duty has the same fields. */
export type DutyCard = Pick<Duty, "id" | "name" | "ownerWords" | "goal" | "metrics" | "status"> & { boardGoal?: string };
/**
 * What the Duties card shows per duty: the duty, `builtin` for the check-in, its schedule (the check-in's is the chat's check-in setting) and
 * whether it is paused, when it runs next, whether a run is going now, and its last runs, newest first.
 */
export interface DutyView { duty: DutyCard; builtin?: "checkin"; schedule: DutySchedule; paused: boolean; nextAt: number | null; running: boolean; runs: DutyRunRecord[] }

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

/** A duty schedule from a file or a request: `{ kind: daily, at: HH:MM }` or `{ kind: every, minutes }` with 5 or more whole minutes. Throws otherwise. */
export function parseSchedule(schedule: unknown): DutySchedule {
  if (isRecord(schedule) && schedule.kind === "daily" && typeof schedule.at === "string" && HHMM.test(schedule.at)) return { kind: "daily", at: schedule.at };
  if (isRecord(schedule) && schedule.kind === "every" && typeof schedule.minutes === "number" && Number.isInteger(schedule.minutes) && schedule.minutes >= 5 &&
    schedule.minutes <= 7 * 24 * 60) return { kind: "every", minutes: schedule.minutes };
  throw new Error("schedule: { kind: daily, at: HH:MM } or { kind: every, minutes } (5 to 10080).");
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
  if (!Array.isArray(metrics) || !metrics.length || metrics.length > 20) throw new Error("metrics: 1 to 20.");
  const parsedMetrics = metrics.map((metric: unknown, index): DutyMetric => {
    if (!isRecord(metric) || typeof metric.key !== "string" || !KEY.test(metric.key) || !str(metric.label, 80) || (metric.op !== "<=" && metric.op !== ">=") ||
      typeof metric.target !== "number" || !Number.isFinite(metric.target) || (metric.unit !== undefined && typeof metric.unit !== "string")) throw new Error(`metrics[${index}]: key, label, op (<= or >=) and target.`);
    return { key: metric.key, label: metric.label, op: metric.op, target: metric.target, ...(typeof metric.unit === "string" ? { unit: metric.unit } : {}) };
  });
  const parsedSchedule = parseSchedule(schedule);
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

/** The next duty id in a chat: d1, d2, ... never reused. */
export function nextDutyId(duties: readonly Duty[]): string {
  return `d${duties.reduce((max, duty) => Math.max(max, Number(duty.id.slice(1)) || 0), 0) + 1}`;
}

/** A duties file as stored; unreadable duties are dropped rather than failing the chat's whole list. */
export function parseDutyFile(value: unknown): DutyFile {
  const duties = isRecord(value) && Array.isArray(value.duties) ? value.duties : [];
  const checkIn = isRecord(value) && isRecord(value.checkIn) && typeof value.checkIn.createdAt === "number" && typeof value.checkIn.runCount === "number"
    ? { createdAt: value.checkIn.createdAt, runCount: value.checkIn.runCount, ...(typeof value.checkIn.lastRunAt === "number" ? { lastRunAt: value.checkIn.lastRunAt } : {}) } : undefined;
  return { version: 1, duties: duties.filter((duty): duty is Duty => isRecord(duty) && typeof duty.id === "string" && isRecord(duty.schedule) && isRecord(duty.precheck) &&
    Array.isArray(duty.metrics) && (duty.status === "active" || duty.status === "paused") && typeof duty.runCount === "number"), ...(checkIn ? { checkIn } : {}) };
}

export const CHECK_IN_DUTY_ID = "checkin";
/**
 * The built-in duty every chat has: the check-in. It runs on the chat's check-in setting (the header's control and this card edit the same
 * setting) and on job events; its precheck sorts every open step into a class and its prompt is the `[check-in]` steer or the check-in job.
 * These metrics are what a run measures; the steer lines act on each miss, so a miss needs no line of its own.
 */
export const CHECK_IN_DUTY: Omit<DutyCard, "status"> = {
  id: CHECK_IN_DUTY_ID,
  name: "Check-in",
  ownerWords: "look, eventually on it's own all threads should resolve to\nsome items in FOR YOU\nTODO all cleared, only ones blocked by FOR YOU remaining.\n" +
    "manage stale shit, properly nudge push through, ... is you (chat agent's responsiblitity).\n" +
    "그럴거면 check in은 왜있어? checkin이 그렇게 되도록 해야지. check in을 duty로 모델링을 하는건 좋은거 같아",
  goal: "Every open plan step is done, moved by a live owner, or blocked only by an open For you todo. The board matches what the jobs reported.",
  metrics: [
    { key: "orphan_steps", label: "Open steps with no live owner, todo or wait", op: "<=", target: 0 },
    { key: "due_late", label: "Steps due for more than one check-in", op: "<=", target: 0 },
    { key: "stale_chase_24h", label: "Chases over 24 h with no For you todo", op: "<=", target: 0 },
    { key: "job_end_unrecorded", label: "Steps whose job ended a check-in ago, not updated", op: "<=", target: 0 },
    { key: "job_end_silent", label: "Steps whose job stopped on an error with no report, not updated", op: "<=", target: 0 },
    { key: "scope_misses", label: "Open steps the owner gave to another thread", op: "<=", target: 0 },
  ],
};

/** A flagged item checked again after the chat's turn: the slice, and its plan step as it was when the chat was told (`stepMark`). */
export interface ArmedItem { slice: FlaggedSlice & { item: string }; mark: string | null }

/** A plan item by id, anywhere in the plan. */
export function planItem(board: ChatBoard | null, id: string): PlanItem | undefined {
  const find = (items: readonly PlanItem[]): PlanItem | undefined => {
    for (const item of items) { if (item.id === id) return item; const below = find(item.children); if (below) return below; }
    return undefined;
  };
  return find(board?.plan ?? []);
}
/** What the chat can change on a step to handle it: status, text, owner, waits and note. Null when the step is gone. */
export function stepMark(board: ChatBoard | null, id: string): string | null {
  const item = planItem(board, id);
  return item ? JSON.stringify([item.status, item.text, item.job ?? "", item.waitFor ?? "", item.waitUntil ?? "", item.note ?? ""]) : null;
}
/** The flagged items the after-turn recheck follows: those that name a plan item, with their step as the chat saw it. */
export function armItems(flagged: readonly FlaggedSlice[], board: ChatBoard | null): ArmedItem[] {
  return flagged.filter((slice): slice is FlaggedSlice & { item: string } => typeof slice.item === "string")
    .map(slice => ({ slice, mark: stepMark(board, slice.item) }));
}
/**
 * The recheck after the chat's turn: an item is handled when its step changed (a board change, a job started for it, a wait set) or the check no
 * longer flags it; it is unresolved when the same check flags it again and its step is as it was.
 */
export function afterTurnCheck(armed: readonly ArmedItem[], flagged: readonly FlaggedSlice[], board: ChatBoard | null): { handled: string[]; unresolved: FlaggedSlice[] } {
  const handled: string[] = [];
  const unresolved: FlaggedSlice[] = [];
  for (const { slice, mark } of armed) {
    const again = flagged.find(next => next.item === slice.item && next.kind === slice.kind);
    if (again && stepMark(board, slice.item) === mark) unresolved.push(again);
    else handled.push(slice.item);
  }
  return { handled: [...new Set(handled)], unresolved };
}
/** Flagged slices grouped by their item, in first-seen order: one entry per step, with every kind it was flagged for. */
export function byItem(slices: readonly FlaggedSlice[]): { item: string; kinds: string[]; excerpt: string }[] {
  const groups = new Map<string, { item: string; kinds: string[]; excerpt: string }>();
  for (const slice of slices) {
    const key = slice.item ?? slice.kind;
    const group = groups.get(key);
    if (group) { if (!group.kinds.includes(slice.kind)) group.kinds.push(slice.kind); }
    else groups.set(key, { item: key, kinds: [slice.kind], excerpt: slice.excerpt });
  }
  return [...groups.values()];
}
/** The line that sends the unresolved items back to the chat, one per step. */
export function afterTurnLine(duty: Pick<DutyCard, "id" | "name">, unresolved: readonly FlaggedSlice[]): string {
  const items = byItem(unresolved);
  return `duty ${duty.id} "${duty.name}": after your turn the same check still flags ${items.length === 1 ? "this step" : `these ${items.length} steps`} ` +
    `and the board shows no change on ${items.length === 1 ? "it" : "them"}. Act on each now (a board change, a job for it, or a wait):\n` +
    items.map(group => `- ${group.item} (${group.kinds.join(", ")}): ${group.excerpt}`).join("\n");
}
