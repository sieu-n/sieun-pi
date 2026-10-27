/**
 * Prime's schedule grammar and job record, ported from prime-agent 0.9.8 `dist/core/cron-jobs.js` (MIT, the npm package under
 * `legacy/prime/user-history/node_modules/prime-agent`). The grammar and the job fields stay the same, so `cron_list`, `heartbeat_get` and the
 * `rlm_heartbeat` skill answer what the chat and the check-in already parse (user-history `src/chat-catalog.ts` parseSchedules,
 * `src/checkin-load.ts` ScheduledJob).
 *
 * Schedules: `in 10m` and `at <ISO date>` run once; `every 30s` (10 s or more) repeats; five cron fields or `@hourly`, `@daily`, `@weekly`,
 * `@monthly` follow the host's local time.
 */

export type JobStatus = "active" | "paused" | "completed" | "cancelled";
export type JobSource = "cron" | "heartbeat" | "rlm_heartbeat";
export type DeliveryMode = "steer" | "follow_up";
export type ScheduleKind = "once" | "cron" | "interval";

export interface Schedule {
  kind: ScheduleKind;
  expression: string;
  intervalMs?: number;
}

/** Prime's `AgentCronJob`, plus `claimedAt` while a tick is being delivered and `rootSessionId` for a child's job. */
export interface Job {
  id: string;
  status: JobStatus;
  source: JobSource;
  runtimeKind?: "top-level" | "subagent";
  deliveryMode?: DeliveryMode;
  activeSessionId: string;
  sessionId: string;
  sessionFile: string;
  cwd: string;
  label?: string;
  prompt: string;
  schedule: Schedule;
  createdAt: string;
  updatedAt: string;
  nextRunAt?: string;
  lastRunAt?: string;
  lastSkippedAt?: string;
  lastError?: string;
  runCount: number;
  /** Set when a tick was claimed and its delivery has not reported back. A host that restarts finds it and does not replay the tick. */
  claimedAt?: string;
  /** The root whose host session reopens a child's tree after a host restart. */
  rootSessionId?: string;
}

export const DEFAULT_HEARTBEAT_SCHEDULE = "every 5m";
const SECOND = 1000;
const MINUTE = 60_000;

export const isHeartbeat = (job: Job): boolean => job.source === "heartbeat" || job.source === "rlm_heartbeat";
export const isLive = (job: Job): boolean => job.status === "active" || job.status === "paused";

export function parseSchedule(input: string, now = new Date()): { schedule: Schedule; nextRunAt: Date } {
  const text = stripQuotes(input.trim());
  if (!text) throw new Error("Cron schedule cannot be empty");
  const inMatch = /^in\s+(\d+)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)$/i.exec(text);
  if (inMatch) {
    const unit = inMatch[2]!.toLowerCase();
    const ms = unit.startsWith("m") ? MINUTE : unit.startsWith("h") ? 60 * MINUTE : 24 * 60 * MINUTE;
    return { schedule: { kind: "once", expression: text }, nextRunAt: new Date(now.getTime() + Number(inMatch[1]) * ms) };
  }
  const every = /^(?:every|each)\s+(\d+)\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours)$/i.exec(text);
  if (every) {
    const unit = every[2]!.toLowerCase();
    const intervalMs = Number(every[1]) * (unit.startsWith("s") ? SECOND : unit.startsWith("m") ? MINUTE : 60 * MINUTE);
    if (intervalMs < 10 * SECOND) throw new Error("Recurring interval must be at least 10 seconds");
    return { schedule: { kind: "interval", expression: text, intervalMs }, nextRunAt: new Date(now.getTime() + intervalMs) };
  }
  if (text.toLowerCase().startsWith("at ")) {
    const when = new Date(text.slice(3).trim());
    if (!Number.isFinite(when.getTime())) throw new Error("Invalid one-shot schedule. Use: at <ISO date>");
    if (when.getTime() <= now.getTime()) throw new Error("One-shot schedule must be in the future");
    return { schedule: { kind: "once", expression: text }, nextRunAt: when };
  }
  const expression = CRON_ALIASES[text] ?? text;
  return { schedule: { kind: "cron", expression }, nextRunAt: nextCronRun(expression, now) };
}

/** The next tick after `after`, or undefined for a one-shot schedule. */
export function nextRunAfter(schedule: Schedule, after: Date): Date | undefined {
  if (schedule.kind === "once") return undefined;
  if (schedule.kind === "interval") {
    if (!schedule.intervalMs || schedule.intervalMs <= 0) throw new Error(`Invalid interval schedule: ${schedule.expression}`);
    return new Date(after.getTime() + schedule.intervalMs);
  }
  return nextCronRun(schedule.expression, after);
}

/** `5m` becomes `every 5m`, and nothing becomes the 5-minute default. */
export function normalizeHeartbeatSchedule(input: string | undefined): string {
  const text = input?.trim();
  if (!text) return DEFAULT_HEARTBEAT_SCHEDULE;
  if (/^\d+\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours)$/i.test(text)) return `every ${text}`;
  return text;
}

export function parseDeliveryMode(value: unknown): DeliveryMode | undefined {
  if (value === undefined || value === null) return undefined;
  if (value === "steer" || value === "follow_up") return value;
  throw new Error('Heartbeat delivery mode must be "steer" or "follow_up"');
}

export type HeartbeatCommand =
  | { type: "status" | "pause" | "resume" | "clear" }
  | { type: "set"; schedule: string; instruction: string; deliveryMode?: DeliveryMode };

const HEARTBEAT_USAGE = "Usage: /heartbeat [every <interval>|--every <interval>] [--steer|--follow-up] <instruction>";

/** Prime's `/heartbeat` arguments: status, pause, resume, clear or stop, or a schedule, a delivery flag and the instruction. */
export function parseHeartbeatCommand(input: string): HeartbeatCommand {
  const text = input.replace(/^\/heartbeat\b/, "").trim();
  if (!text || text === "status") return { type: "status" };
  if (text === "pause" || text === "resume") return { type: text };
  if (text === "clear" || text === "stop") return { type: "clear" };
  let deliveryMode: DeliveryMode | undefined;
  let rest = text;
  const takeFlags = () => {
    for (;;) {
      const lead = /^--(steer|follow[-_]up)(?:\s+|$)([\s\S]*)$/i.exec(rest);
      if (lead) { deliveryMode = lead[1]!.toLowerCase().startsWith("s") ? "steer" : "follow_up"; rest = lead[2]!.trim(); continue; }
      const trail = /^([\s\S]*?)\s+--(steer|follow[-_]up)$/i.exec(rest);
      if (trail) { deliveryMode = trail[2]!.toLowerCase().startsWith("s") ? "steer" : "follow_up"; rest = trail[1]!.trim(); continue; }
      return;
    }
  };
  takeFlags();
  let schedule = DEFAULT_HEARTBEAT_SCHEDULE;
  const option = /^--every(?:=|\s+)(?:"([^"]+)"|'([^']+)'|(\d+\s*[a-z]+)|(\S+))(?:\s+|$)([\s\S]*)$/i.exec(rest);
  const leading = /^(every|each)\s+\d+\s*(?:s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours)\b/i.exec(rest);
  if (option) {
    schedule = normalizeHeartbeatSchedule(option[1] ?? option[2] ?? option[3] ?? option[4]);
    rest = option[5]!.trim();
  } else if (leading) {
    schedule = normalizeHeartbeatSchedule(leading[0]);
    rest = rest.slice(leading[0].length).trim().replace(/^--(?=\s|$)/, "").trim();
  }
  takeFlags();
  if (!rest) throw new Error(HEARTBEAT_USAGE);
  return { type: "set", schedule, instruction: rest, ...(deliveryMode ? { deliveryMode } : {}) };
}

/** What a session is doing when a heartbeat comes due, as Prime's `shouldDeferHeartbeatCronJob` reads it. */
export interface Activity {
  streaming: boolean;
  compacting: boolean;
  retrying: boolean;
  pending: boolean;
}

/**
 * Whether a due heartbeat skips this tick: never while the session compacts, retries or holds queued input, and for a `follow_up` heartbeat
 * also while it streams. A `steer` heartbeat goes into a streaming turn. Prime 0.9.8 CHANGELOG: heartbeats defer while the target works
 * instead of piling prompts onto a busy agent, and steer by default.
 */
export function defers(job: Job, activity: Activity): boolean {
  if (!isHeartbeat(job)) return false;
  if (activity.compacting || activity.retrying || activity.pending) return true;
  return (job.deliveryMode ?? "steer") === "follow_up" && activity.streaming;
}

/** Prime's `heartbeat_prompt` custom message: `[heartbeat: <schedule> run#<n>]`, then the instruction. */
export function heartbeatMessage(job: Job): { customType: "heartbeat_prompt"; content: string; display: true; details: Record<string, unknown> } {
  return {
    customType: "heartbeat_prompt",
    content: `[heartbeat: ${job.schedule.expression.replace(/[\r\n\]]+/g, " ")} run#${job.runCount}]\n\n${job.prompt}`,
    display: true,
    details: { jobId: job.id, schedule: job.schedule.expression, status: job.status, runCount: job.runCount, nextRunAt: job.nextRunAt, lastRunAt: job.lastRunAt },
  };
}

/** The `rlm_heartbeat` skill's view of one job, Prime's `rlmHeartbeatHostResponse`. */
export function rlmHeartbeatView(job: Job): Record<string, unknown> {
  return {
    id: job.id, status: job.status, label: job.label ?? null, delivery_mode: job.deliveryMode ?? "steer", instruction: job.prompt, schedule: job.schedule,
    created_at: job.createdAt, updated_at: job.updatedAt, next_run_at: job.nextRunAt ?? null, last_run_at: job.lastRunAt ?? null,
    last_error: job.lastError ?? null, run_count: job.runCount,
  };
}

const CRON_ALIASES: Record<string, string> = { "@hourly": "0 * * * *", "@daily": "0 0 * * *", "@weekly": "0 0 * * 0", "@monthly": "0 0 1 * *" };

function stripQuotes(value: string): string {
  const quoted = value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")));
  return quoted ? value.slice(1, -1) : value;
}

interface CronFields { minute: Set<number>; hour: Set<number>; day: Set<number>; month: Set<number>; weekday: Set<number> }

function nextCronRun(expression: string, after: Date): Date {
  const fields = parseCron(expression);
  const candidate = new Date(after.getTime());
  candidate.setSeconds(0, 0);
  candidate.setMinutes(candidate.getMinutes() + 1);
  const deadline = candidate.getTime() + 366 * 24 * 60 * MINUTE;
  while (candidate.getTime() <= deadline) {
    const weekday = candidate.getDay();
    if (fields.minute.has(candidate.getMinutes()) && fields.hour.has(candidate.getHours()) && fields.day.has(candidate.getDate())
      && fields.month.has(candidate.getMonth() + 1) && (fields.weekday.has(weekday) || (weekday === 0 && fields.weekday.has(7)))) return candidate;
    candidate.setMinutes(candidate.getMinutes() + 1);
  }
  throw new Error(`Cron schedule did not match within one year: ${expression}`);
}

function parseCron(expression: string): CronFields {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error("Unsupported cron schedule. Use 'in 10m', 'at <ISO date>', @hourly, or five fields: minute hour day month weekday");
  const [minute, hour, day, month, weekday] = parts as [string, string, string, string, string];
  return { minute: field(minute, 0, 59), hour: field(hour, 0, 23), day: field(day, 1, 31), month: field(month, 1, 12), weekday: field(weekday, 0, 7) };
}

function field(text: string, min: number, max: number): Set<number> {
  const values = new Set<number>();
  for (const part of text.split(",")) {
    if (!part) throw new Error(`Invalid cron field: ${text}`);
    const [range, stepText] = part.split("/") as [string, string | undefined];
    const step = stepText === undefined ? 1 : number(stepText, 1, max);
    let start: number;
    let end: number;
    if (range === "*") { start = min; end = max; }
    else if (range.includes("-")) {
      const [a, b] = range.split("-") as [string, string];
      start = number(a, min, max);
      end = number(b, min, max);
      if (start > end) throw new Error(`Invalid cron range: ${range}`);
    } else { start = end = number(range, min, max); }
    for (let value = start; value <= end; value += step) values.add(value);
  }
  return values;
}

function number(value: string, min: number, max: number): number {
  if (!/^\d+$/.test(value)) throw new Error(`Invalid cron number: ${value}`);
  const parsed = Number.parseInt(value, 10);
  if (parsed < min || parsed > max) throw new Error(`Cron number out of range: ${value}`);
  return parsed;
}
