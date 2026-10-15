import type { DutyMetric, DutyRunRecord, DutyView, FixLink } from "../shared/chat-duties.ts";
import { effectiveRun, metricStreaks } from "../shared/duty-streak.ts";
import type { ChatAgent } from "../shared/types.ts";
import { headlineLabel, metricText, metricsHeadlineFirst } from "./duty-cadence.ts";

/**
 * What a duty's card shows so the owner sees the system push (owner 10-15: "the duty system is actively pushing for code changes fixing and
 * trying to be green"): the headline metric first, one miss line per missed metric with its streak, whether it is stuck and its fix job, and the
 * labels of the metrics on target. Every verdict is the run's after-job measure when it has one (`effectiveRun`).
 */

/** A missed metric's fix: its job and whether that job works now, or none, which is the gap the owner must see. */
export type FixState = { kind: "live"; job: string; step: string } | { kind: "idle"; job?: string; step: string } | { kind: "none" };

/** One missed metric: "Usable minutes, last 24 h 96.7%, target at least 100%", missed `misses` measured runs in a row. */
export interface MissLine {
  key: string; text: string; misses: number;
  /** CHANGE_APPROACH_MISSES or more misses with no move toward the target: the next run must change approach. */
  stuck: boolean;
  fix: FixState;
}

export interface DutyCardModel {
  /** The headline metric's line, or null when the duty marks none. */
  headline: string | null;
  /** The headline metric's miss, when it missed. */
  headlineMiss: MissLine | null;
  /** The other missed metrics, in the duty's order. */
  misses: MissLine[];
  /** Labels of the other metrics the last measure met. */
  onTarget: string[];
  /** Measured runs in a row off target, newest first; skipped and error runs neither extend nor break it. */
  streak: number;
  /** The duty job the newest run started, and whether it works now. */
  job: { name: string; live: boolean } | null;
}

/**
 * Whether a job works now, from the chat's agent rows (the Agents card's states): working, waiting on the chat, queued, or with subagents
 * running. A job the rows do not list keeps what the run saw (`fallback`).
 */
export function jobLive(name: string, agents: readonly ChatAgent[], fallback = false): boolean {
  const agent = agents.find(entry => entry.name === name || entry.sender === name || entry.job === name);
  if (!agent) return fallback;
  return agent.state === "working" || agent.state === "waiting" || agent.queued !== undefined || (agent.subagentsRunning ?? 0) > 0;
}

const fixState = (fix: FixLink | undefined, agents: readonly ChatAgent[]): FixState => {
  if (!fix) return { kind: "none" };
  if (fix.job && jobLive(fix.job, agents, fix.live)) return { kind: "live", job: fix.job, step: fix.step };
  return { kind: "idle", ...(fix.job ? { job: fix.job } : {}), step: fix.step };
};

const measured = (run: DutyRunRecord): boolean => { const verdict = effectiveRun(run).verdict; return verdict === "met" || verdict === "missed"; };

/** Measured runs in a row whose verdict, after their job, was off target. */
export const missStreak = (runs: readonly DutyRunRecord[]): number => {
  let count = 0;
  for (const run of runs.filter(measured)) { if (effectiveRun(run).verdict !== "missed") break; count += 1; }
  return count;
};

const missText = (metric: DutyMetric, value: number): string =>
  `${metric.label} ${metricText(value, metric.unit)}, target ${metric.op === "<=" ? "at most" : "at least"} ${metricText(metric.target, metric.unit)}`;

export function dutyCard(view: DutyView, agents: readonly ChatAgent[]): DutyCardModel {
  const metrics = metricsHeadlineFirst(view.duty.metrics);
  const headlineMetric = metrics[0]?.headline ? metrics[0] : undefined;
  const streaks = new Map(metricStreaks(view.runs).map(streak => [streak.key, streak]));
  const last = view.runs.find(measured);
  const results = last ? effectiveRun(last).metrics : {};
  const lines = new Map<string, MissLine>();
  for (const metric of metrics) {
    const streak = streaks.get(metric.key);
    if (streak) lines.set(metric.key, { key: metric.key, text: missText(metric, streak.value), misses: streak.misses, stuck: streak.stuck, fix: fixState(streak.fix, agents) });
  }
  const others = metrics.filter(metric => metric !== headlineMetric);
  const newestJob = view.runs.find(run => run.job)?.job;
  return {
    headline: headlineLabel(view),
    headlineMiss: headlineMetric ? lines.get(headlineMetric.key) ?? null : null,
    misses: others.flatMap(metric => lines.get(metric.key) ?? []),
    onTarget: others.filter(metric => results[metric.key]?.met === true).map(metric => metric.label),
    streak: missStreak(view.runs),
    job: newestJob ? { name: newestJob.name, live: jobLive(newestJob.name, agents) } : null,
  };
}
