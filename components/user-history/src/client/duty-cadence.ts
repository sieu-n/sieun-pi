import { type DutyRunRecord, type DutySchedule, type DutyView, headlineMetric } from "../shared/chat-duties.ts";
import { effectiveRun } from "../shared/duty-streak.ts";
import { CHECK_IN_MIN_MINUTES } from "../shared/types.ts";

/** The Duties card's pure parts: the cadence editor's draft and its check, and what a check-in run found. */

/** The cadence editor's fields for a duty: its kind, minutes and daily time, filled from its schedule. */
export interface CadenceDraft { kind: DutySchedule["kind"]; minutes: number; at: string }
export const cadenceDraft = (schedule: DutySchedule): CadenceDraft =>
  schedule.kind === "every" ? { kind: "every", minutes: schedule.minutes, at: "09:00" } : { kind: "daily", minutes: 60, at: schedule.at };

/**
 * The schedule a draft asks for, or why it cannot be saved. The check-in runs every N whole minutes, 1 or more (its setting, shared with the
 * header's control), and has no daily time; another duty runs every N whole minutes or daily at HH:MM.
 */
export function cadenceSchedule(draft: CadenceDraft, builtin: boolean): DutySchedule | { error: string } {
  if (draft.kind === "daily") {
    if (builtin) return { error: "The check-in runs every N minutes." };
    return /^([01]\d|2[0-3]):[0-5]\d$/.test(draft.at) ? { kind: "daily", at: draft.at } : { error: "Give a time like 23:07." };
  }
  return Number.isInteger(draft.minutes) && draft.minutes >= CHECK_IN_MIN_MINUTES ? { kind: "every", minutes: draft.minutes }
    : { error: `Give a whole number of minutes, ${CHECK_IN_MIN_MINUTES} or more.` };
}

const count = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? "" : "s"}`;
const sentence = (parts: readonly string[]): string =>
  !parts.length ? "" : `${parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`}.`;

const CLASS_WORDS: Record<string, string> = {
  live: "in progress", foryou: "waiting on you", waiting: "waiting until a set time", due: "due now", "stale-chase": "gone quiet",
  orphan: "with no job", parked: "parked",
};

/** A check-in run's open steps per class, in plain words: "41 steps in progress, 7 steps waiting on you and 1 step with no job."; empty with none. */
export function classesLabel(run: DutyRunRecord | undefined): string {
  return sentence(Object.entries(run?.classes ?? {}).filter(([, n]) => n > 0).map(([cls, n]) => `${count(n, "step")} ${CLASS_WORDS[cls] ?? cls.replace(/[-_]/g, " ")}`));
}

/** Each flagged kind as a noun and what is wrong with it, or the whole finding when it names no item. */
const FLAG_WORDS: Record<string, { noun: string; words: string } | string> = {
  orphan_steps: { noun: "step", words: "with no job" },
  due_late: { noun: "step", words: "past due" },
  stale_chase_24h: { noun: "step", words: "quiet for a day" },
  job_end_unrecorded: { noun: "step", words: "not updated after its job ended" },
  job_end_silent: { noun: "step", words: "whose job failed with no report" },
  scope_misses: { noun: "step", words: "on another chat's work" },
  idle_goals: { noun: "goal", words: "with no job working" },
  stalled_steps: { noun: "step", words: "stalled" },
  go_missing: { noun: "step", words: "missing the owner's go" },
  requirements_missing: { noun: "goal", words: "missing requirements" },
  merges_without_go: { noun: "merge", words: "done without the owner's go" },
  goal_gaps: { noun: "goal", words: "with no live job" },
  goals_off_pace: { noun: "goal", words: "off pace" },
  blocked_on_others: { noun: "step", words: "blocked on others for over an hour" },
  finished_open: { noun: "item", words: "done but still open" },
  loose_goals: { noun: "goal", words: "with no steps" },
  extra_goals: { noun: "goal", words: "past the goal target with no number or no live owner" },
  open_under_closed: { noun: "item", words: "open under a closed one" },
  held_elsewhere: { noun: "goal", words: "held by other chats" },
  wait_met: { noun: "step", words: "whose wait is over" },
  no_progress: "no progress in the last hour",
  stale_steps: { noun: "item", words: "with an old record" },
  goals_to_fold: { noun: "goal", words: "to fold into a duty" },
  one_session_load: { noun: "goal", words: "with too much on one job" },
  redundant_heartbeats: { noun: "heartbeat", words: "repeating a duty's work" },
  goals_without_duty: "open goals with no duty",
  no_done_line: { noun: "goal", words: "with no done line" },
  plan_risks: { noun: "item", words: "holding a standing risk or upkeep" },
  met_open: { noun: "item", words: "met and still open" },
  stuck_steps: { noun: "step", words: "stuck" },
};

/**
 * What the last run that measured flagged, counted per kind in plain words with no step ids: "3 steps stalled and 1 goal with no steps.";
 * empty when it flagged nothing.
 */
export function flaggedLabel(view: DutyView): string {
  const run = view.runs.find(entry => entry.verdict !== "skipped");
  const items = new Map<string, Set<string>>();
  for (const [index, slice] of (run?.flagged ?? []).entries()) items.set(slice.kind, (items.get(slice.kind) ?? new Set()).add(slice.item ?? `#${index}`));
  return sentence([...items].map(([kind, found]) => {
    const words = FLAG_WORDS[kind];
    if (typeof words === "string") return words;
    return words ? `${count(found.size, words.noun)} ${words.words}` : `${found.size} ${kind.replace(/_/g, " ")}`;
  }));
}

/** A metric's value with its unit, as the metric table shows it. */
export const metricText = (number: number, unit = ""): string => `${Math.round(number * 10) / 10}${unit}`;

const NUMBER = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });
const lowerFirst = (text: string): string => /^[A-Z][a-z]/.test(text) ? text[0]!.toLowerCase() + text.slice(1) : text;
const NOT_PLURAL = new Set(["is", "was", "has", "this", "its", "his", "plus", "less"]);
/** Whether a label names a set of things in its first 4 words ("Duties in all chats ...", "On-topic real visitors ..."), so a share reads "N% of". */
const namesThings = (what: string): boolean => what.split(/\s+/).slice(0, 4).some(word => /[a-z][^s]s$/i.test(word) && !NOT_PLURAL.has(word.toLowerCase()));

/**
 * The headline number in plain words for the duty's one line: "4% of the last hour the Mac was usable", "17 open steps nobody is moving",
 * "2 days since a new article went live", "Portal prod uptime is 99.2%". The label is cut at its first colon, bracket or comma, so the detail keeps
 * the rest. Null before the headline is measured or for a duty with none.
 */
export function headlineWords(view: DutyView): string | null {
  const metric = headlineMetric(view.duty.metrics);
  if (!metric) return null;
  const result = view.runs.map(effectiveRun).find(run => run.verdict !== "skipped" && run.metrics[metric.key] !== undefined)?.metrics[metric.key];
  if (!result) return null;
  const what = metric.label.split(/:|\(|, /)[0]!.trim();
  const value = NUMBER.format(result.value);
  if (!metric.unit) return `${value} ${lowerFirst(what)}`;
  if (metric.unit === "%") {
    const share = /^share of (.+)$/i.exec(what)?.[1];
    if (share) return `${value}% of ${share}`;
    if (namesThings(what)) return `${value}% of ${lowerFirst(what)}`;
  }
  const unit = result.value === 1 && / \w+s$/.test(metric.unit) ? metric.unit.slice(0, -1) : metric.unit;
  const noun = /^ ([a-z]{3,})$/.exec(metric.unit)?.[1];
  if (noun && what.toLowerCase().startsWith(noun.replace(/s$/, ""))) return `${value} ${lowerFirst(what).replace(/^(\w+?)s\b/, (word, stem: string) => result.value === 1 ? stem : word)}`;
  return `${what} is ${value}${unit}`;
}

/**
 * The headline line a duty row shows first: "Open steps in the owner's end state 43%, target at least 100%, off target", from the last run that
 * measured it, after its job when it has an after-job measure; null for a duty with no headline metric. Before its first such run it reads "not measured yet".
 */
export function headlineLabel(view: DutyView): string | null {
  const metric = headlineMetric(view.duty.metrics);
  if (!metric) return null;
  const result = view.runs.map(effectiveRun).find(run => run.verdict !== "skipped" && run.metrics[metric.key] !== undefined)?.metrics[metric.key];
  const target = `target ${metric.op === "<=" ? "at most" : "at least"} ${metricText(metric.target, metric.unit)}`;
  return result ? `${metric.label} ${metricText(result.value, metric.unit)}, ${target}, ${result.met ? "met" : "off target"}` : `${metric.label}: not measured yet, ${target}`;
}
