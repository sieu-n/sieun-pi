import { type DutyMetric, type DutyRunRecord, type DutyView, type FixLink, MAX_DUTY_METRICS, shapeNote, verdictMetrics } from "../shared/chat-duties.ts";
import { effectiveRun, metricStreaks, streakRuns } from "../shared/duty-streak.ts";
import type { ChatAgent } from "../shared/types.ts";
import { headlineLabel, metricText } from "./duty-cadence.ts";

/**
 * What a duty's card shows so the owner sees the system push (owner 10-15: "the duty system is actively pushing for code changes fixing and
 * trying to be green"): the headline metric first, one miss line per missed metric with its streak, whether it is stuck and its fix job, and the
 * labels of the metrics on target. Every verdict is the run's after-job measure when it has one (`effectiveRun`), over the duty's counted
 * metrics (`verdictMetrics`), which are all of them, headline first.
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
  /** The duty job the newest run started (its session id and name), and whether it works now. */
  job: { id: string; name: string; live: boolean } | null;
  /** For a duty over the shape rule (`shapeNote`), the line that tells the owner its chat must rework it; else null. */
  shape: string | null;
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

/**
 * A run as the card judges it: its after-job measure (`effectiveRun`) over the counted metrics only. A measured run is missed when one of them
 * missed; skipped and error runs keep their verdict.
 */
export function judgedRun(run: DutyRunRecord, metrics: readonly DutyMetric[]): Pick<DutyRunRecord, "verdict" | "metrics" | "summary"> {
  const judged = effectiveRun(run);
  if (judged.verdict !== "met" && judged.verdict !== "missed") return judged;
  const counted = Object.fromEntries(verdictMetrics(metrics).flatMap(metric => judged.metrics[metric.key] ? [[metric.key, judged.metrics[metric.key]!] as const] : []));
  const results = Object.values(counted);
  if (!results.length) return judged;
  return { verdict: results.some(result => !result.met) ? "missed" : "met", metrics: counted, summary: judged.summary };
}

/** The dot a duty row shows: its last verdict after its job over its counted metrics (`judgedRun`), or running, paused, or new before its first run. */
export type DutyState = "met" | "missed" | "error" | "paused" | "running" | "new";
export function dutyState(view: DutyView): DutyState {
  if (view.running) return "running";
  if (view.paused) return "paused";
  const last = view.runs.find(run => run.verdict !== "skipped");
  return last ? judgedRun(last, view.duty.metrics).verdict as Exclude<DutyRunRecord["verdict"], "skipped"> : "new";
}

const measured = (run: DutyRunRecord): boolean => { const verdict = effectiveRun(run).verdict; return verdict === "met" || verdict === "missed"; };

/** Counted runs in a row (`streakRuns`) whose counted metrics, after their job, came up short. */
export const missStreak = (runs: readonly DutyRunRecord[], metrics: readonly DutyMetric[]): number => {
  let count = 0;
  for (const run of streakRuns(runs)) { if (judgedRun(run, metrics).verdict !== "missed") break; count += 1; }
  return count;
};

/** "This duty has 38 metrics, over the target of one headline and 3 more. Its chat should rework it." */
function shapeLine(metrics: readonly DutyMetric[]): string | null {
  if (!shapeNote(metrics)) return null;
  const headlines = metrics.filter(metric => metric.headline).length;
  const has = metrics.length > MAX_DUTY_METRICS ? `${metrics.length} metrics, over the target of one headline and ${MAX_DUTY_METRICS - 1} more`
    : headlines ? `${headlines} headline metrics, over the target of one` : "no headline metric";
  return `This duty has ${has}. Its chat should rework it.`;
}

const missText = (metric: DutyMetric, value: number): string =>
  `${metric.label} ${metricText(value, metric.unit)}, target ${metric.op === "<=" ? "at most" : "at least"} ${metricText(metric.target, metric.unit)}`;

export function dutyCard(view: DutyView, agents: readonly ChatAgent[]): DutyCardModel {
  const metrics = verdictMetrics(view.duty.metrics);
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
    streak: missStreak(view.runs, view.duty.metrics),
    job: newestJob ? { id: newestJob.id, name: newestJob.name, live: jobLive(newestJob.name, agents) } : null,
    shape: shapeLine(view.duty.metrics),
  };
}

/**
 * What the row's one line says is being done about the duty (owner 10-16: "if human can't read it it's pointless"). A missed duty is `fixing`
 * when a live job works on one of its misses (`by: "fix"`) or its own run job still works (`by: "run"`), else `unfixed`.
 */
export type DutyStatus =
  | { kind: "met" } | { kind: "fixing"; job: string; by: "fix" | "run" } | { kind: "unfixed" }
  | { kind: "error" } | { kind: "running" } | { kind: "paused" } | { kind: "new" };

export function dutyStatus(view: DutyView, card: DutyCardModel): DutyStatus {
  const state = dutyState(view);
  if (state !== "missed") return { kind: state };
  const live = [card.headlineMiss, ...card.misses].find(line => line?.fix.kind === "live")?.fix;
  if (live?.kind === "live") return { kind: "fixing", job: live.job, by: "fix" };
  if (card.job?.live) return { kind: "fixing", job: card.job.name, by: "run" };
  return { kind: "unfixed" };
}

/**
 * The duty's one line: the headline number in words (`headlineWords`), then what is being done about it, as one sentence:
 * "4% of the last hour's minutes the Mac was usable, and a fix is running." A missed duty whose headline is on target says another number is off.
 */
export function dutyStatusLine(status: DutyStatus, words: string | null = null, headlineOff = true): string {
  const lead = words && status.kind !== "error" && status.kind !== "new" ? words : null;
  const off = headlineOff || (status.kind !== "fixing" && status.kind !== "unfixed") ? "" : ", but another of its numbers is off target";
  const doing = (() => {
    switch (status.kind) {
      case "met": return lead ? "" : "On target";
      case "fixing": return status.by === "fix" ? "a fix is running" : "its check job is working on it";
      case "unfixed": return "no fix is running yet";
      case "error": return "The last run could not measure it, and the next run tries again";
      case "running": return "a check is running now";
      case "paused": return "its checks are paused";
      case "new": return "Not checked yet";
    }
  })();
  if (!lead) return `${doing[0]!.toUpperCase()}${doing.slice(1)}${off}.`;
  const head = `${lead[0]!.toUpperCase()}${lead.slice(1)}${off}`;
  return doing ? `${head}, and ${doing}.` : `${head}.`;
}
