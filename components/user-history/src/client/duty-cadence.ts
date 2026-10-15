import { type DutyMetric, type DutyRunRecord, type DutySchedule, type DutyView, headlineMetric } from "../shared/chat-duties.ts";
import { effectiveRun } from "../shared/duty-streak.ts";
import { CHECK_IN_MAX_MINUTES, CHECK_IN_MIN_MINUTES } from "../shared/types.ts";

/** The Duties card's pure parts: the cadence editor's draft and its check, and what a check-in run found. */

/** The cadence editor's fields for a duty: its kind, minutes and daily time, filled from its schedule. */
export interface CadenceDraft { kind: DutySchedule["kind"]; minutes: number; at: string }
export const cadenceDraft = (schedule: DutySchedule): CadenceDraft =>
  schedule.kind === "every" ? { kind: "every", minutes: schedule.minutes, at: "09:00" } : { kind: "daily", minutes: 60, at: schedule.at };

/**
 * The schedule a draft asks for, or why it cannot be saved. The check-in runs every 1 to 240 minutes (its setting's range, shared with the
 * header's control) and has no daily time; another duty runs every 5 to 10080 minutes or daily at HH:MM.
 */
export function cadenceSchedule(draft: CadenceDraft, builtin: boolean): DutySchedule | { error: string } {
  if (draft.kind === "daily") {
    if (builtin) return { error: "The check-in runs every N minutes." };
    return /^([01]\d|2[0-3]):[0-5]\d$/.test(draft.at) ? { kind: "daily", at: draft.at } : { error: "Give a time like 23:07." };
  }
  const [min, max] = builtin ? [CHECK_IN_MIN_MINUTES, CHECK_IN_MAX_MINUTES] : [5, 7 * 24 * 60];
  return Number.isInteger(draft.minutes) && draft.minutes >= min && draft.minutes <= max ? { kind: "every", minutes: draft.minutes } : { error: `Give ${min} to ${max} minutes.` };
}

/** A check-in run's open steps per class, the classes with steps only: "live 6 · waiting 1 · orphan 1". */
export function classesLabel(run: DutyRunRecord | undefined): string {
  return Object.entries(run?.classes ?? {}).filter(([, count]) => count > 0).map(([cls, count]) => `${cls} ${count}`).join(" · ");
}

/** What the last run that measured flagged, by step: "p56 orphan steps, p18 due late"; empty when it flagged nothing. */
export function flaggedLabel(view: DutyView): string {
  const run = view.runs.find(entry => entry.verdict !== "skipped");
  return [...new Set((run?.flagged ?? []).map(slice => slice.item ? `${slice.item} ${slice.kind.replace(/_/g, " ")}` : slice.kind))].join(", ");
}

/** The duty's metrics with its headline metric first. */
export const metricsHeadlineFirst = (metrics: readonly DutyMetric[]): DutyMetric[] => {
  const headline = headlineMetric(metrics);
  return headline ? [headline, ...metrics.filter(metric => metric !== headline)] : [...metrics];
};

/** A metric's value with its unit, as the metric table shows it. */
export const metricText = (number: number, unit = ""): string => `${Math.round(number * 10) / 10}${unit}`;

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
