/**
 * How long a duty job may hold its duty before a later run replaces it. Prime's duty runner (src/chat-duty-run.ts `previous`) and sw factory's
 * (apps/chat/server/duty-items.ts) read the one rule here.
 */
import type { DutySchedule } from "./shared/chat-duties.ts";

/** The time between two slots of a schedule; a daily duty's is a day. */
export const intervalMs = (schedule: DutySchedule): number => schedule.kind === "every" ? schedule.minutes * 60_000 : 24 * 60 * 60_000;

/** A duty job may work this long before a later run counts it as stuck, however short its duty's interval. */
export const STUCK_MIN_MS = 90 * 60_000;
/**
 * A duty job still working this long after its run started is stuck, however long its duty's interval: a daily slot can run CATCH_UP_MS (6 h)
 * late, so the next slot can come 18 h after its job started, and the limit must be under that.
 */
export const STUCK_MAX_MS = 12 * 60 * 60_000;
/**
 * How long a duty job may work before the next run of its duty retires it as stuck and starts a new one: one interval, at least STUCK_MIN_MS and
 * at most STUCK_MAX_MS. A daily duty's interval is a day. Without the limit one hung job skipped every later run: slack green guy 10-10, 37 h with
 * no check-in; ops guy 10-11, a 10-minute duty skipped for 17 h; AI harness VP 10-11, three daily duties skipped a day on jobs whose model
 * requests hung for hours and were aborted at each restart. On sw factory, which had no limit until 11-28, one job held devops guy's d17 from
 * 11-25 21:10Z for 62 h and 7 runs (~/work/bill-check-miss/survey.md).
 */
export function stuckAfterMs(schedule: DutySchedule): number {
  return Math.min(Math.max(intervalMs(schedule), STUCK_MIN_MS), STUCK_MAX_MS);
}
