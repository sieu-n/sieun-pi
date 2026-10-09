import type { DutyRunRecord, DutySchedule, DutyView } from "../shared/chat-duties.ts";
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

/** What the last run flagged, by step, and what the recheck after the chat's turn found handled or still flagged. Empty parts are left out. */
export function flaggedLabel(view: DutyView): { flagged: string; handled: string; left: string } {
  const run = view.runs.find(entry => entry.trigger !== "after-turn" && entry.verdict !== "skipped");
  const after = view.runs.find(entry => entry.trigger === "after-turn");
  const items = (slices: DutyRunRecord["flagged"]) => [...new Set((slices ?? []).map(slice => slice.item ? `${slice.item} ${slice.kind.replace(/_/g, " ")}` : slice.kind))].join(", ");
  const recent = after !== undefined && run !== undefined && after.at >= run.at;
  return { flagged: items(run?.flagged), handled: recent ? (after.handled ?? []).join(", ") : "", left: recent ? items(after.unresolved) : "" };
}

