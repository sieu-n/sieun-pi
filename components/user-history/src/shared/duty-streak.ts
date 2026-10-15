import type { DutyRunRecord, FixLink, MetricResult } from "./chat-duties.ts";

/**
 * Miss streaks per metric, read from a duty's runs. A run's verdict is its measure after its own job ended when it has one (`effectiveRun`),
 * so a check-in that fixed its own finding is not counted as a miss. Skipped and error runs neither extend nor break a streak.
 */

/** After this many misses in a row with no move toward the target, a run must change approach: a new root-cause job, not the same fix. */
export const CHANGE_APPROACH_MISSES = 3;

/** One metric's current miss streak: how many measured runs in a row missed it, whether its value moved toward the target over the streak, and its fix step. */
export interface MetricStreak {
  key: string;
  misses: number;
  /** The newest value is closer to the target than the value at the start of the streak. */
  moved: boolean;
  /** The time of the oldest run in the streak. */
  since: number;
  value: number; target: number; op: MetricResult["op"];
  /** The fix step the newest run of the streak found, if any. */
  fix?: FixLink;
  /** CHANGE_APPROACH_MISSES or more misses and no move toward the target. */
  stuck: boolean;
}

/** The run as judged: its after-job measure when it has one, else its own. */
export function effectiveRun(run: DutyRunRecord): Pick<DutyRunRecord, "verdict" | "metrics" | "summary"> {
  return run.after ? { verdict: run.after.verdict, metrics: run.after.metrics, summary: run.after.summary } : run;
}

const measured = (run: DutyRunRecord): boolean => { const verdict = effectiveRun(run).verdict; return verdict === "met" || verdict === "missed"; };
const gap = (result: MetricResult): number => Math.abs(result.value - result.target);

/** The current miss streak of every metric the newest measured run missed, from runs newest first. */
export function metricStreaks(runs: readonly DutyRunRecord[]): MetricStreak[] {
  const ordered = runs.filter(measured);
  const newest = ordered[0];
  if (!newest) return [];
  const streaks: MetricStreak[] = [];
  for (const [key, result] of Object.entries(effectiveRun(newest).metrics)) {
    if (result.met) continue;
    let oldest = result;
    let since = newest.at;
    let misses = 0;
    for (const run of ordered) {
      const found = effectiveRun(run).metrics[key];
      if (!found || found.met) break;
      misses += 1;
      oldest = found;
      since = run.at;
    }
    const moved = gap(result) < gap(oldest);
    streaks.push({ key, misses, moved, since, value: result.value, target: result.target, op: result.op, ...(newest.fixes?.[key] ? { fix: newest.fixes[key] } : {}),
      stuck: misses >= CHANGE_APPROACH_MISSES && !moved });
  }
  return streaks;
}
