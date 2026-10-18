import type { PoolPriority } from "./types.ts";

/**
 * Duties: standing work a chat owns. A duty is a goal in the owner's words with numeric targets, a schedule, and a code precheck that measures
 * the targets for 0 tokens. On every scheduled run the server runs the precheck, then starts one duty job linked to the chat with the precheck
 * as context (src/chat-duty-job.ts). The targets are information for that job, never a gate: a run that meets them still starts the job, and
 * the job decides what needs work. Every chat also has one built-in duty, the check-in (`CHECK_IN_DUTY`): its schedule is the chat's check-in
 * setting and its precheck the step classes (src/chat-checkin.ts, run by src/chats.ts).
 * Pure types and rules here; the store is src/chat-duty-store.ts and the runner src/chat-duty-run.ts.
 */

export type DutySchedule = { kind: "daily"; at: string } | { kind: "every"; minutes: number };
/**
 * One target of a duty. `headline` marks the one number a run is judged on moving (owner 10-14 on the Chat system duty: "this is your KPI ... the
 * fundamentals are much more important than the quantitative number of checks"): the brief leads with it, the card and the summary show it first.
 */
export interface DutyMetric { key: string; label: string; op: "<=" | ">="; target: number; unit?: string; headline?: true }
/** The duty's headline metric, or undefined when none is marked. */
export const headlineMetric = <M extends Pick<DutyMetric, "headline">>(metrics: readonly M[]): M | undefined => metrics.find(metric => metric.headline);
/**
 * A duty's shape, a soft target: one headline metric plus at most 3 supporting ones. The owner (10-15): "the Duties list should be reasonably
 * set meaningful things that are semantically meaningful (user can understand, manage)". On 10-15 26 of 30 duties missed their latest run while
 * carrying 2 to 38 metrics each, and one missed metric of 38 made a duty off target. A duty over the shape keeps every metric in its verdict,
 * and its run summary and card say to rework it (`shapeNote`); any other number belongs in the precheck output (the run detail).
 */
export const MAX_DUTY_METRICS = 4;
const SHAPE_FIX = 'keep the one number the owner would ask about as the headline ("headline": true), keep up to 3 supporting numbers he can read, ' +
  "and leave the rest in the precheck output, where the run detail shows them";
/** Why a duty's metrics break the shape (more than MAX_DUTY_METRICS, or not exactly one headline), with what to do; null for a good shape. */
export function dutyShapeProblem(metrics: readonly Pick<DutyMetric, "key" | "headline">[]): string | null {
  const headlines = metrics.filter(metric => metric.headline).map(metric => metric.key);
  const problem = metrics.length > MAX_DUTY_METRICS ? `${metrics.length} metrics, over the limit of ${MAX_DUTY_METRICS}`
    : !headlines.length ? "no headline metric"
    : headlines.length > 1 ? `${headlines.length} headlines, ${headlines.join(" and ")}`
    : null;
  return problem && `metrics: a duty targets one headline metric and at most 3 supporting ones; this one has ${problem}. Fix it: ${SHAPE_FIX}.`;
}
/** The metrics a run's verdict counts, every one, its headline first (the first metric when none is marked). */
export function verdictMetrics<M extends Pick<DutyMetric, "headline">>(metrics: readonly M[]): M[] {
  const lead = headlineMetric(metrics) ?? metrics[0];
  return lead ? [lead, ...metrics.filter(metric => metric !== lead)] : [];
}
/**
 * The precheck: `command` is an argv run in `cwd` with no shell (a first word `node` is this server's node). It gets the env STATE_FILE (its JSON
 * state, kept between runs, only when it exits 0), LAST_RUNS_FILE (the duty's last 10 run records) and OUTPUT_FILE, and writes a `PrecheckOutput`
 * to OUTPUT_FILE. A nonzero exit, a timeout or bad JSON is an error run.
 */
export interface DutyPrecheck { command: string[]; cwd: string; timeoutMs: number }
export interface PrecheckOutput { metrics: Record<string, number>; flagged?: FlaggedSlice[] }
/** One thing the precheck found that the duty job should read: the chat (session id), when, what kind, a short excerpt, and the plan item it is about. */
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
  /** What the duty job does about a miss. */
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

/** What started a run: its schedule, a catch-up, or the owner's Run now. */
/** `verify`: a re-measure after a fix step linked to one of the duty's metrics closed (src/shared/duty-streak.ts). */
/** `push`: a red standing duty with no job at work on it, run again at the chat's check-in interval (`pushMisses` in src/chat-duty-run.ts). */
export type DutyTrigger = "schedule" | "catch-up" | "owner" | "verify" | "push";
export type DutyVerdict = "met" | "missed" | "error" | "skipped";
export interface MetricResult { value: number; target: number; op: DutyMetric["op"]; met: boolean }
/** A duty job the server started: its session id and name. */
export interface DutyJobRef { id: string; name: string }
/**
 * One line of `<dataDir>/duties/<chatId>.runs.jsonl`. `slot` is the scheduled time the run covers (one duty job per duty per slot); `detail` the
 * saved precheck output; `job` the duty job the run started. The verdict is the measure against the targets, kept as information; `skipped`
 * is a run that started no job (a missed daily slot, or the last duty job still at work). A check-in run keeps its step counts per class and its
 * flagged items inline (`classes`, `flagged`).
 */
export interface DutyRunRecord {
  duty: string; at: number; slot?: number; trigger: DutyTrigger; ms: number; verdict: DutyVerdict;
  metrics: Record<string, MetricResult>; summary: string; detail?: string; error?: string;
  classes?: Record<string, number>; flagged?: FlaggedSlice[]; job?: DutyJobRef;
  /** Per missed metric, the fix step the run found on the chat's board for it (a plan step whose `duty` is `<dutyId>/<metricKey>`). */
  fixes?: Record<string, FixLink>;
  /** The measure taken after this run's own job ended: the run's verdict once its fixes are in (`effectiveRun`). */
  after?: AfterMeasure;
}
/** A fix step on the board for one missed metric: its plan step id, the job that owns it, and whether that job was live when the run looked. */
export interface FixLink { step: string; job?: string; live: boolean }
/** A run's re-measure after its own job ended. */
export interface AfterMeasure { at: number; verdict: "met" | "missed" | "error"; metrics: Record<string, MetricResult>; summary: string }
/** The part of a duty the card shows; the check-in duty has the same fields. */
export type DutyCard = Pick<Duty, "id" | "name" | "ownerWords" | "goal" | "metrics" | "status"> & { boardGoal?: string };
/**
 * What the Duties card shows per duty: the duty, `builtin` for the check-in, its schedule (the check-in's is the chat's check-in setting) and
 * whether it is paused, when it runs next, whether a run is going now, and its last runs, newest first.
 */
export interface DutyView {
  duty: DutyCard; builtin?: "checkin"; schedule: DutySchedule; paused: boolean; nextAt: number | null; running: boolean; runs: DutyRunRecord[];
  /** The chat's pool class from its sidebar label (`chatPoolPriority`): it picks the duty's morning band. The duty job itself always runs low. */
  priority: PoolPriority;
}

/**
 * The morning window a new duty's daily time comes from, as [first, last] minute of the local day, one 100-minute band per pool class so a
 * high-priority chat's duties run first: high 06:00-07:39, normal 07:40-09:19, low 09:20-10:59. The owner (c66, 10-14): "when creating duty it
 * should kind of default to daily at some random morning time", then "also remember the priority system?".
 */
export const MORNING_BANDS: Readonly<Record<PoolPriority, readonly [number, number]>> = { high: [360, 459], normal: [460, 559], low: [560, 659] };

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
const str = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;

/** The latest daily slot at or before `now`, in this machine's local time. */
export function dailySlot(at: string, now: number): number {
  const [, hours, minutes] = HHMM.exec(at)!;
  const slot = new Date(now);
  slot.setHours(Number(hours), Number(minutes), 0, 0);
  if (slot.getTime() > now) slot.setDate(slot.getDate() - 1);
  return slot.getTime();
}

const clock = (minute: number): string => `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;

/**
 * A new duty's daily time, "HH:MM": a uniformly random minute of the priority's MORNING_BANDS band that no daily duty in any chat uses (`taken`).
 * When the band is full, the first free minute after it inside the window; when that is full too, a random minute of the band, shared.
 */
export function morningTime(taken: ReadonlySet<string>, priority: PoolPriority, random: () => number): string {
  const [first, last] = MORNING_BANDS[priority];
  const minutes = (from: number, to: number): number[] => Array.from({ length: Math.max(0, to - from + 1) }, (_, index) => from + index);
  const free = minutes(first, last).filter(minute => !taken.has(clock(minute)));
  if (free.length) return clock(free[Math.min(free.length - 1, Math.floor(random() * free.length))]!);
  const after = minutes(last + 1, MORNING_BANDS.low[1]).find(minute => !taken.has(clock(minute)));
  return clock(after ?? first + Math.min(last - first, Math.floor(random() * (last - first + 1))));
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
 * The line a run of a duty over the shape rule ends its summary with, so the duty job (which reads the summary as its measure) tells the
 * chat to rework the duty; null for a duty of good shape.
 */
export function shapeNote(metrics: readonly Pick<DutyMetric, "key" | "headline">[]): string | null {
  if (!dutyShapeProblem(metrics)) return null;
  const headlines = metrics.filter(metric => metric.headline).length;
  return `this duty is over the shape target of one headline and 3 more (${metrics.length} metrics, ${headlines === 1 ? "1 headline" : `${headlines} headlines`}), ` +
    `and the verdict counts all of them; tell the chat to rework it with scripts/duties/add.ts: ${SHAPE_FIX}`;
}

/**
 * The value a precheck writes for a metric whose source failed, or its negative for an at-least target: the convention of auto-sns-agent
 * scripts/duties/ci/duty-sources.mjs and of estate-reads, seo-new-articles and wiki-dream here. It is no measure. From 10-15 to 10-17 GeoNode
 * proxy use read working_exits_dropped 999999 in every run because prod had no crawler.sticky_walks table, and each run counted it as a miss.
 */
export const PLACEHOLDER = 999_999;
const isPlaceholder = (value: number): boolean => value === PLACEHOLDER || value === -PLACEHOLDER;

/** Why the precheck could not read its inputs, from its `source_error` and `gap` items, for the summary of a run with unmeasured metrics. */
function sourceReasons(output: PrecheckOutput): string {
  const reasons = [...new Set((output.flagged ?? []).filter(slice => slice.kind === "source_error" || slice.kind === "gap").map(slice => slice.excerpt.trim()))];
  const text = reasons.slice(0, 4).join("; ");
  return text.length > 300 ? `${text.slice(0, 299)}…` : text;
}

/**
 * The verdict of one precheck output against the duty's targets: met when every counted metric (`verdictMetrics`) it gives is on target,
 * missed when one is off, error when it gives none. A counted metric it leaves out or writes as the `PLACEHOLDER` is not measured: it gets no
 * result, so it is neither met nor missed, and the summary names it with the precheck's source errors as the reason. Other numbers in the
 * output never change it. The summary leads with the headline, names each miss with its target or says the measured ones are on target, and
 * ends with the `shapeNote` of a duty over the shape rule. On 10-18 a GitHub 403 left Apps reach staging without demo_ci_ok, and the run must
 * still judge apps_picked and open_review_max_h; a run with no counted metric measured is an error, which pauses the duty after ERROR_PAUSE_RUNS.
 */
export function judge(metrics: readonly DutyMetric[], output: PrecheckOutput): { verdict: "met" | "missed" | "error"; metrics: Record<string, MetricResult>; summary: string } {
  const note = shapeNote(metrics);
  const counted = verdictMetrics(metrics);
  const results: Record<string, MetricResult> = {};
  const valueOf = (metric: DutyMetric): unknown => output.metrics[metric.key];
  const missing = counted.filter(metric => typeof valueOf(metric) !== "number" || !Number.isFinite(valueOf(metric)));
  const placeholders = counted.filter(metric => !missing.includes(metric) && isPlaceholder(valueOf(metric) as number));
  const absent = [...missing, ...placeholders];
  const reasons = absent.length ? sourceReasons(output) : "";
  const unmeasured = [
    ...missing.length ? [`the precheck gave no value for ${missing.map(metric => metric.key).join(", ")}`] : [],
    ...placeholders.length ? [`the precheck wrote the placeholder ${PLACEHOLDER} for ${placeholders.map(metric => metric.key).join(", ")}`] : [],
  ].join(" and ") + (reasons ? ` (${reasons})` : "");
  const withNote = (parts: string[]): string => [...parts, ...note ? [note] : []].join("; ");
  if (absent.length && absent.length === counted.length) return { verdict: "error", metrics: results, summary: withNote([unmeasured]) };
  const end = (summary: string): string => withNote([summary, ...absent.length ? [`not measured: ${unmeasured}`] : []]);
  const measured = counted.filter(metric => !absent.includes(metric));
  const misses: string[] = [];
  const headline = headlineMetric(measured);
  for (const metric of measured) {
    const value = output.metrics[metric.key]!;
    results[metric.key] = { value, target: metric.target, op: metric.op, met: met(metric, value) };
    if (!results[metric.key]!.met) misses.push(`${metric.key} ${show(metric, value)} (target ${metric.op === "<=" ? "at most" : "at least"} ${show(metric, metric.target)})`);
  }
  const lead = headline && results[headline.key]!.met ? `${headline.key} ${show(headline, results[headline.key]!.value)} (on target)` : undefined;
  const all = `all ${measured.length}${absent.length ? " measured" : ""} on target`;
  if (!misses.length) return { verdict: "met", metrics: results, summary: end(lead ? `${lead}; ${all}` : all) };
  return { verdict: "missed", metrics: results, summary: end((lead ? [lead, ...misses] : misses).join(", ")) };
}

/** How many runs in a row, newest first, ended in error. */
export function errorStreak(runs: readonly DutyRunRecord[]): number {
  let count = 0;
  for (const run of runs) { if (run.verdict === "skipped") continue; if (run.verdict !== "error") break; count++; }
  return count;
}

/** A duty schedule from a file or a request: `{ kind: daily, at: HH:MM }` or `{ kind: every, minutes }` with a whole number of minutes, 1 or more. Throws otherwise. */
export function parseSchedule(schedule: unknown): DutySchedule {
  if (isRecord(schedule) && schedule.kind === "daily" && typeof schedule.at === "string" && HHMM.test(schedule.at)) return { kind: "daily", at: schedule.at };
  if (isRecord(schedule) && schedule.kind === "every" && typeof schedule.minutes === "number" && Number.isInteger(schedule.minutes) && schedule.minutes >= 1) {
    return { kind: "every", minutes: schedule.minutes };
  }
  throw new Error("schedule: { kind: daily, at: HH:MM } or { kind: every, minutes } with a whole number of minutes.");
}

/**
 * Parses a duty definition from a file or a request: the fields a person writes. Run state starts empty. A definition with no `schedule` takes
 * `schedule` from the caller (upsertDuty). Throws with the first bad field.
 */
export function parseDutyInput(value: unknown, id: string, now: number, schedule?: DutySchedule): Duty {
  if (!isRecord(value)) throw new Error("A duty is an object.");
  const { name, ownerWords, goal, metrics, precheck, onMiss, boardGoal } = value;
  if (!str(name)) throw new Error("name: the system the duty looks after, in plain words.");
  if (!str(ownerWords)) throw new Error("ownerWords: the owner's words, verbatim.");
  if (!str(goal)) throw new Error("goal: what good means, in plain words.");
  if (!str(onMiss)) throw new Error("onMiss: what the duty job does about a miss.");
  if (boardGoal !== undefined && !(typeof boardGoal === "string" && /^p\d+$/.test(boardGoal))) throw new Error("boardGoal: a plan item id like p87.");
  if (!Array.isArray(metrics) || !metrics.length) throw new Error("metrics: at least one, with the headline marked.");
  const parsedMetrics = metrics.map((metric: unknown, index): DutyMetric => {
    if (!isRecord(metric) || typeof metric.key !== "string" || !KEY.test(metric.key) || !str(metric.label) || (metric.op !== "<=" && metric.op !== ">=") ||
      typeof metric.target !== "number" || !Number.isFinite(metric.target) || (metric.unit !== undefined && typeof metric.unit !== "string")) throw new Error(`metrics[${index}]: key, label, op (<= or >=) and target.`);
    const parsed: DutyMetric = { key: metric.key, label: metric.label, op: metric.op, target: metric.target, ...(typeof metric.unit === "string" ? { unit: metric.unit } : {}),
      ...(metric.headline === true ? { headline: true as const } : {}) };
    return parsed;
  });
  // A duty of one metric has nothing else to lead, so that metric is its headline.
  if (parsedMetrics.length === 1) parsedMetrics[0]!.headline = true;
  const parsedSchedule = value.schedule === undefined && schedule ? schedule : parseSchedule(value.schedule);
  if (!isRecord(precheck) || !Array.isArray(precheck.command) || !precheck.command.length || !precheck.command.every(word => typeof word === "string" && word.length > 0) ||
    !str(precheck.cwd)) throw new Error("precheck: { command: [argv], cwd, timeoutMs? }.");
  const timeoutMs = typeof precheck.timeoutMs === "number" && precheck.timeoutMs > 0 ? Math.min(precheck.timeoutMs, PRECHECK_TIMEOUT_MS) : PRECHECK_TIMEOUT_MS;
  return { id, name: name.trim(), ownerWords, goal: goal.trim(), metrics: parsedMetrics, schedule: parsedSchedule,
    precheck: { command: precheck.command as string[], cwd: precheck.cwd, timeoutMs }, onMiss: onMiss.trim(), ...(boardGoal ? { boardGoal } : {}),
    status: "active", createdAt: now, updatedAt: now, runCount: 0 };
}

/**
 * Adds a duty definition to a chat's duties, or updates the definition of the duty with the same name and keeps its run state, so applying it
 * twice changes nothing. A definition with no `schedule` keeps the existing duty's schedule, and a new one runs daily at `morning`
 * (`morningTime`). Returns what it did: "added d3", "updated d1" or "unchanged d1".
 */
export function upsertDuty(duties: Duty[], definition: unknown, now: number, morning?: string): string {
  const name = isRecord(definition) && typeof definition.name === "string" ? definition.name.trim() : undefined;
  const before = duties.find(duty => duty.name === name);
  const parsed = parseDutyInput(definition, nextDutyId(duties), now, before?.schedule ?? (morning ? { kind: "daily", at: morning } : undefined));
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
 * setting); its precheck reads each open goal's number, trend, pace and owner job (src/checkin-goals.ts) and sorts every open step into a
 * class (src/chat-checkin.ts), and its run starts one check-in job with that as context. Its headline is goal_gaps, the open goals whose
 * number is off pace or that no live job owns (owner 10-15: "Check in 이 일을 쭉쭉 밀어줘야되는데 it's deeply flawed"), then stuck_steps, the
 * end state of the steps, then finished_open and stalled_steps for a plan that matches reality. Every other count of the measure
 * (`ConvergenceMisses`) stays in its output and its flagged items, which the check-in job reads in its findings.
 */
export const CHECK_IN_DUTY: Omit<DutyCard, "status"> = {
  id: CHECK_IN_DUTY_ID,
  name: "Check-in",
  ownerWords: "YES. it - checks and synchronizes the agent swarm with user intent ( todo ). it's like driving the agent swarm - set the interface layer " +
    "for user: report message when needed, syncs plan and for you. - fixes quirks like agents giving up, .. so this is a core component in this AI " +
    "harness for steering agent swarm\n\n" +
    "look, eventually on it's own all threads should resolve to\nsome items in FOR YOU\nTODO all cleared, only ones blocked by FOR YOU remaining.\n" +
    "manage stale shit, properly nudge push through, ... is you (chat agent's responsiblitity).\n" +
    "그럴거면 check in은 왜있어? checkin이 그렇게 되도록 해야지. check in을 duty로 모델링을 하는건 좋은거 같아\n\n" +
    "Check in 이 일을 쭉쭉 밀어줘야되는데 it's deeply flawed. fix this",
  goal: "The check-in pushes every open goal to its outcome, so the owner never has to ask whether it is working. Each run it reads each goal's " +
    "number against its target, its trend since the last check-in and the pace to the target, and makes sure one live job owns that number: it " +
    "steers that job with the owner's words and the measured gap when the number is off pace, and starts one when no job owns it. Second, every " +
    "open step is moved by a live owner, held by an open For you todo, or closed, and the plan matches reality.",
  metrics: [
    { key: "goal_gaps", label: "Open goals off pace or with no live job that owns their number", op: "<=", target: 0, headline: true },
    { key: "stuck_steps", label: "Open steps nobody is moving (no live job, For you todo or owner ruling holds them)", op: "<=", target: 0 },
    { key: "finished_open", label: "Done items still open", op: "<=", target: 0 },
    { key: "stalled_steps", label: "Steps waiting over 2 hours on the same thing", op: "<=", target: 0 },
  ],
};
