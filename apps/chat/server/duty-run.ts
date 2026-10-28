/**
 * One duty run as today's chat does it (legacy/prime/user-history/src/chat-duty-run.ts `Duties.run`): run the duty's precheck command with
 * STATE_FILE, LAST_RUNS_FILE, OUTPUT_FILE and PRECHECK_MODE, judge its metrics against the targets, record the run, and when something is
 * due (a miss, a precheck error, an overrun, flagged items or a hand-off) start one duty job with the findings as its brief. On pi-host the
 * duty job is a durable thread filed under the chat, and its final answer comes back to the chat as an input from the job.
 */
import { execFile } from "node:child_process";
import { copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ChatBoard, PlanItem } from "../web/src/lib/api/types.ts";
import {
  errorStreak, headlineMetric, hostAwayOf, judge, outputReadings, overrunWords, verdictMetrics, ERROR_RUNS_TARGET,
  type Duty, type DutyRunRecord, type DutyTrigger, type FixLink, type FlaggedSlice, type PrecheckOutput,
} from "../web/src/lib/api/shared/chat-duties.ts";
import { metricStreaks, type MetricStreak } from "../web/src/lib/api/shared/duty-streak.ts";
import { briefFindings } from "./brief-cap.ts";

/** A precheck that runs past its own `timeoutMs` keeps running (c98) up to this hard stop: its schedule's gap, a destructive-runaway guard. */
export const intervalMs = (duty: Pick<Duty, "schedule">): number => duty.schedule.kind === "every" ? duty.schedule.minutes * 60_000 : 24 * 60 * 60_000;
export const precheckHardStopMs = (duty: Pick<Duty, "schedule" | "precheck">): number => Math.max(intervalMs(duty), duty.precheck.timeoutMs);

export const runStamp = (at: number): string => {
  const d = new Date(at + 9 * 3600_000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${String(d.getUTCFullYear()).slice(2)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
};

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Runs the precheck in its cwd and returns its parsed OUTPUT_FILE; the state file moves forward only on a good run. */
export async function precheck(duty: Duty, dir: string, outputFile: string, lastRuns: readonly DutyRunRecord[], log: (line: string) => void = () => {}): Promise<PrecheckOutput> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const stateFile = join(dir, `${duty.id}.state.json`);
  const nextState = join(dir, `${duty.id}.state.next.json`);
  const lastRunsFile = join(dir, `${duty.id}.last-runs.json`);
  await copyFile(stateFile, nextState).catch(async () => writeFile(nextState, "{}", { mode: 0o600 }));
  await writeFile(lastRunsFile, JSON.stringify(lastRuns), { mode: 0o600 });
  await rm(outputFile, { force: true });
  const [command, ...args] = duty.precheck.command;
  const file = command === "node" ? process.execPath : command!;
  const stderrFile = `${outputFile.replace(/\.json$/, "")}.stderr.log`;
  const hardStopMs = precheckHardStopMs(duty);
  const pastTarget = setTimeout(() => log(`duty ${duty.id}: the precheck is past its ${Math.round(duty.precheck.timeoutMs / 1000)} s target and keeps running`), duty.precheck.timeoutMs);
  try {
    await new Promise<void>((resolve, reject) => {
      execFile("/bin/sh", ["-c", 'exec "$0" "$@" </dev/null >/dev/null 2>"$PRECHECK_STDERR_FILE"', file, ...args], {
        cwd: duty.precheck.cwd, timeout: hardStopMs, killSignal: "SIGKILL",
        env: { ...process.env, STATE_FILE: nextState, LAST_RUNS_FILE: lastRunsFile, OUTPUT_FILE: outputFile, PRECHECK_MODE: "run", PRECHECK_STDERR_FILE: stderrFile },
      }, error => {
        if (!error) return resolve();
        reject(new Error(error.killed ? `stopped at its hard stop after ${Math.round(hardStopMs / 60_000)} min` : typeof error.code === "number" ? `exit ${error.code}` : error.message));
      });
    }).catch(async error => {
      const tail = (await readFile(stderrFile, "utf8").catch(() => "")).trim().split("\n").slice(-3).join(" ").slice(0, 300);
      throw new Error(`${message(error)}${tail ? `: ${tail}` : ""} (all of stderr: ${stderrFile})`);
    });
    await rm(stderrFile, { force: true });
    let output: unknown;
    try {
      output = JSON.parse(await readFile(outputFile, "utf8"));
    } catch {
      throw new Error("no valid JSON in OUTPUT_FILE");
    }
    if (typeof output !== "object" || output === null || typeof (output as { metrics?: unknown }).metrics !== "object" || (output as { metrics?: unknown }).metrics === null) {
      throw new Error("OUTPUT_FILE has no metrics object");
    }
    await rename(nextState, stateFile);
    return output as PrecheckOutput;
  } finally {
    clearTimeout(pastTarget);
    await rm(nextState, { force: true });
  }
}

function walk(plan: readonly PlanItem[], visit: (item: PlanItem) => void): void {
  for (const item of plan) {
    visit(item);
    walk(item.children, visit);
  }
}

/** The fix step for each missed metric: an open plan step whose `duty` is `<dutyId>/<metricKey>`. */
export function fixesOn(board: ChatBoard | null, dutyId: string, keys: readonly string[], liveJob: (job: string) => boolean): Record<string, FixLink> {
  const out: Record<string, FixLink> = {};
  if (!board) return out;
  walk(board.plan, item => {
    if (item.status === "done" || item.status === "dropped" || !item.duty) return;
    const [id, key] = item.duty.split("/");
    if (id !== dutyId || !key || !keys.includes(key) || out[key]) return;
    out[key] = { step: item.id, ...(item.job ? { job: item.job } : {}), live: item.job ? liveJob(item.job) : false };
  });
  return out;
}

const flaggedSection = (flagged: readonly FlaggedSlice[]): string =>
  flagged.length ? ["## Flagged", ...flagged.map(slice => `- ${slice.kind}${slice.item ? ` (${slice.item})` : ""}: ${slice.excerpt}`)].join("\n") : "";

export interface DutyRunResult {
  record: DutyRunRecord;
  /** The duty job's brief when something is due, else null (a met run with nothing flagged ends with no job). */
  brief: string | null;
}

/** Measures one run and writes its detail and findings files into `dir`. */
export async function measure(input: {
  duty: Duty; chat: { id: string; name: string }; dir: string; trigger: DutyTrigger; previous: readonly DutyRunRecord[]; board: ChatBoard | null;
  liveJob: (job: string) => boolean; boardApi: string; now?: number; log?: (line: string) => void;
}): Promise<DutyRunResult> {
  const { duty, dir, trigger, previous } = input;
  const started = input.now ?? Date.now();
  const detail = join(dir, `${duty.id}-${runStamp(started)}.json`);
  const wall = Date.now();
  const overrunOf = () => {
    const ms = Date.now() - wall;
    return ms > duty.precheck.timeoutMs ? { overrun: { ms, targetMs: duty.precheck.timeoutMs } } : {};
  };
  let record: DutyRunRecord;
  let flagged: FlaggedSlice[] = [];
  try {
    const output = await precheck(duty, dir, detail, previous.slice(0, 10), input.log);
    const judged = judge(duty.metrics, output, { now: started, runs: previous });
    const readings = outputReadings(duty.readings, output);
    const hostAway = hostAwayOf(output);
    flagged = output.flagged ?? [];
    record = {
      duty: duty.id, at: started, slot: started, trigger, ms: Date.now() - wall, verdict: judged.verdict, metrics: judged.metrics, summary: judged.summary, detail,
      ...(judged.parts ? { parts: judged.parts } : {}), ...(judged.items ? { items: judged.items } : {}), ...(readings ? { readings } : {}),
      ...(judged.verdict === "error" ? { error: judged.summary } : {}), ...overrunOf(), ...(hostAway ? { hostAway } : {}),
    };
  } catch (error) {
    await rm(detail, { force: true });
    record = { duty: duty.id, at: started, slot: started, trigger, ms: Date.now() - wall, verdict: "error", metrics: {}, summary: "the precheck failed", error: message(error).slice(0, 500), ...overrunOf() };
  }
  const counted = new Set(verdictMetrics(duty.metrics).map(m => m.key));
  const missed = Object.entries(record.metrics).filter(([key, result]) => !result.met && counted.has(key)).map(([key]) => key);
  if (record.verdict === "missed") {
    const fixes = fixesOn(input.board, duty.id, missed, input.liveJob);
    if (Object.keys(fixes).length) record.fixes = fixes;
  }
  const misses: MetricStreak[] = record.verdict === "missed" ? metricStreaks([record, ...previous]).filter(streak => counted.has(streak.key)) : [];
  const overrunLine = record.overrun ? `This run went over: ${overrunWords(record.overrun)}. Make the precheck faster or set its timeoutMs to what it needs.` : "";
  let findings: string;
  if (record.verdict === "error") {
    const streak = errorStreak([record, ...previous]);
    findings = [`The precheck failed: ${record.error ?? record.summary}. ${streak >= ERROR_RUNS_TARGET ? `It failed ${streak} runs in a row, over the target of ${ERROR_RUNS_TARGET}: fix the precheck first.` : "Fix the precheck or check the duty by hand."}`, overrunLine].filter(Boolean).join("\n\n");
  } else {
    const findingsFile = join(dir, `${duty.id}-${runStamp(started)}.findings.md`);
    await writeFile(findingsFile, [`# ${duty.name} run of ${new Date(started).toISOString()}`, `Measured against the targets: ${record.summary}.`, overrunLine,
      `The full precheck output is ${detail}.`, flaggedSection(flagged)].filter(Boolean).join("\n\n") + "\n", { mode: 0o600 });
    const headline = headlineMetric(duty.metrics);
    const value = headline ? record.metrics[headline.key] : undefined;
    findings = [briefFindings({ headline: headline && value ? `${headline.label} ${value.value}${headline.unit ?? ""} against ${headline.op} ${headline.target}${headline.unit ?? ""}` : null,
      flagged, ...(headline ? { headlineKey: headline.key } : {}), detail: findingsFile }), overrunLine].filter(Boolean).join("\n\n");
  }
  const acts = flagged.some(slice => slice.item !== undefined || slice.handOff);
  const idle = record.verdict === "met" && !misses.length && !record.overrun && !acts;
  return { record, brief: idle ? null : dutyJobBrief({ duty, chat: input.chat, at: started, measure: record.verdict === "error" ? `no measure (${record.summary})` : record.summary, findings, misses, record, boardApi: input.boardApi }) };
}

/** The duty job's brief, after today's `dutyJobBrief`, with the board and the report through the chat server instead of Prime's tools. */
export function dutyJobBrief(input: { duty: Duty; chat: { id: string; name: string }; at: number; measure: string; findings: string; misses: readonly MetricStreak[]; record: DutyRunRecord; boardApi: string }): string {
  const { duty, chat, at, measure, findings, misses, record, boardApi } = input;
  const headline = headlineMetric(duty.metrics);
  const counted = verdictMetrics(duty.metrics);
  const when = new Date(at + 9 * 3600_000).toISOString().slice(0, 16).replace("T", " ");
  return [
    `# The ${duty.name} duty of the chat "${chat.name}"`,
    `You are the duty job of the chat "${chat.name}" (thread ${chat.id}), started ${when} KST. The chat server starts one duty job on each run of this duty that ` +
      "has something due, with the precheck below as context. Act as the chat's VP for this duty.",
    "## The duty",
    `Goal: ${duty.goal}`,
    `Owner's words (verbatim):\n\n${duty.ownerWords.split("\n").map(line => `> ${line}`).join("\n")}`,
    ...(duty.onMiss ? [`What to do about a miss: ${duty.onMiss}${duty.boardGoal ? ` Fixes go under the plan item ${duty.boardGoal}.` : ""}`] : []),
    ...(headline ? [`## Headline KPI\nThis run is judged on moving one number: ${headline.label} (${headline.key} ${headline.op} ${headline.target}${headline.unit ?? ""}).`] : []),
    `Targets: ${counted.map(metric => `${metric.key} ${metric.op} ${metric.target}${metric.unit ?? ""} (${metric.label})`).join("; ")}.`,
    "## What the precheck found",
    `Measured against the targets: ${measure}. This is information, not a verdict: check the real state.`,
    findings,
    ...(misses.length ? [`## Missed metrics: each one needs a fix step with a live job\n` + misses.map(streak => {
      const fix = record.fixes?.[streak.key];
      return `- ${streak.key}: missed ${streak.misses} run${streak.misses === 1 ? "" : "s"} in a row${fix ? `, fix step ${fix.step}${fix.job ? ` (job ${fix.job}${fix.live ? ", working" : ", not working"})` : ""}` : ", no fix step yet"}.`;
    }).join("\n") + "\n\nA miss is never accepted as it stands. A fix step is a plan step with `duty` set to `" + duty.id + "/<metricKey>`."] : []),
    "## How to work",
    `The chat's board is GET ${boardApi} (JSON with the plan and the owner's todos). Change it with POST ${boardApi} and the body {"actor": "agent", "ops": [...]}, ` +
      "where the ops are the board's plan_add, plan_update, todo_add and the rest; read it first, then check the real state behind it.",
    "Fix what you find, script what can be scripted, and skip nitpicks. Use the subagent tool for each separate part of the work.",
    "## Report",
    "End with one plain report of at most 3 lines: the headline number and its gap, what you changed, and what is left. The chat server posts your final answer to the chat; " +
      "when nothing needs the chat, answer exactly: nothing to report.",
  ].join("\n\n");
}
