/**
 * One duty run as today's chat does it (legacy/prime/user-history/src/chat-duty-run.ts `Duties.run`): run the duty's precheck command with
 * STATE_FILE, LAST_RUNS_FILE, OUTPUT_FILE and PRECHECK_MODE, judge its metrics against the targets, record the run, and when something is
 * due (a miss, a precheck error, an overrun, flagged items or a hand-off) start one duty job with the findings as its brief. On pi-host the
 * duty job is a durable thread filed under the chat, and what it sends with send_message comes back to the chat as an input from the job.
 */
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import type { ChatBoard, PlanItem } from "../web/src/lib/api/types.ts";
import {
  errorStreak, headlineMetric, hostAwayOf, judge, outputReadings, outsideWaitOf, overrunWords, verdictMetrics, ERROR_RUNS_TARGET,
  type AfterMeasure, type Duty, type DutyRunRecord, type DutyTrigger, type FixLink, type FlaggedSlice, type PrecheckOutput,
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

/**
 * A precheck started outside this server's control group: a transient systemd unit when the server runs under systemd (INVOCATION_ID),
 * else a detached process group. A restart of the server, every 2 to 12 min on 11-22 while d3's precheck takes 8 to 15 min, kills every
 * child in the server's group, so the next server process waits for this one and records it (`waitPrecheck`).
 */
export interface PrecheckLaunch {
  mode: "run" | "after";
  /** The OUTPUT_FILE, the file the wrapper writes the exit code into, stderr, the state copy, and the wrapper script and its env file. */
  output: string; exit: string; stderr: string; nextState: string; script: string; env: string;
  startedAt: number;
  hardStopMs: number;
  runner: { kind: "unit"; unit: string } | { kind: "pid"; pid: number };
}

/** How often a wait reads the exit file and whether the precheck still runs, after a first read at 50 ms that doubles up to it. */
const POLL_MS = 2000;
const run = promisify(execFile);
const shellQuote = (text: string): string => `'${text.replace(/'/g, `'\\''`)}'`;
/** A value of a systemd EnvironmentFile, double-quoted, which keeps newlines and needs these four escaped. */
const envQuote = (text: string): string => '"' + text.replace(/[\\"$`]/g, char => "\\" + char) + '"';
/** The server's own unit variables, which the precheck's unit sets for itself. */
const UNIT_ENV = new Set(["INVOCATION_ID", "JOURNAL_STREAM", "SYSTEMD_EXEC_PID", "MANAGERPID"]);

/**
 * Starts the precheck in its cwd with STATE_FILE, LAST_RUNS_FILE, OUTPUT_FILE and PRECHECK_MODE. An after-job measure (`after`) has its own
 * files, so it can run beside a run of the same duty. `tag` names the transient unit, such as `ag_agent-d3-251122-153000-run`.
 */
export async function launchPrecheck(duty: Duty, dir: string, outputFile: string, lastRuns: readonly DutyRunRecord[], mode: "run" | "after", tag: string): Promise<PrecheckLaunch> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const stateFile = join(dir, `${duty.id}.state.json`);
  const base = outputFile.replace(/\.json$/, "");
  // Each launch has its own state copy, which `clearPrecheck` deletes after its run is saved. Until 11-23 every run of a duty shared
  // `<duty>.state.next.json`, so a cleanup of one run that landed late deleted the STATE_FILE of the next.
  const nextState = `${base}.next-state.json`;
  const lastRunsFile = join(dir, `${duty.id}.last-runs${mode === "run" ? "" : ".after"}.json`);
  const files = { output: outputFile, exit: `${base}.exit`, stderr: `${base}.stderr.log`, nextState, script: `${base}.sh`, env: `${base}.env` };
  await copyFile(stateFile, nextState).catch(async () => writeFile(nextState, "{}", { mode: 0o600 }));
  await writeFile(lastRunsFile, JSON.stringify(lastRuns), { mode: 0o600 });
  await Promise.all([rm(outputFile, { force: true }), rm(files.exit, { force: true })]);
  const [command, ...args] = duty.precheck.command;
  const file = command === "node" ? process.execPath : command!;
  const env = { ...process.env, STATE_FILE: nextState, LAST_RUNS_FILE: lastRunsFile, OUTPUT_FILE: outputFile, PRECHECK_MODE: mode, PRECHECK_STDERR_FILE: files.stderr };
  await writeFile(files.script, [
    `${[file, ...args].map(shellQuote).join(" ")} </dev/null >/dev/null 2>${shellQuote(files.stderr)}`,
    `printf '%s\\n' "$?" >${shellQuote(`${files.exit}.part`)}`,
    `mv ${shellQuote(`${files.exit}.part`)} ${shellQuote(files.exit)}`,
  ].join("\n") + "\n", { mode: 0o600 });
  const cwd = duty.precheck.cwd || process.cwd();
  const hardStopMs = precheckHardStopMs(duty);
  const startedAt = Date.now();
  if (process.env.INVOCATION_ID) {
    const lines = Object.entries(env).filter(([key, value]) => value !== undefined && /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && !UNIT_ENV.has(key));
    await writeFile(files.env, lines.map(([key, value]) => `${key}=${envQuote(value!)}\n`).join(""), { mode: 0o600 });
    const unit = `duty-${tag.replace(/[^A-Za-z0-9_.-]/g, "-")}`;
    await run("systemd-run", ["--user", `--unit=${unit}`, "--collect", "--quiet", `--working-directory=${cwd}`, "-p", `RuntimeMaxSec=${Math.ceil(hardStopMs / 1000)}`,
      "-p", `EnvironmentFile=${files.env}`, "/bin/sh", files.script]);
    return { mode, ...files, startedAt, hardStopMs, runner: { kind: "unit", unit } };
  }
  const child = spawn("/bin/sh", [files.script], { cwd, env, detached: true, stdio: "ignore" });
  await new Promise<void>((resolve, reject) => child.once("spawn", resolve).once("error", reject));
  child.unref();
  return { mode, ...files, startedAt, hardStopMs, runner: { kind: "pid", pid: child.pid! } };
}

const readExit = async (file: string): Promise<number | null> => {
  const text = await readFile(file, "utf8").catch(() => null);
  return text === null ? null : Number(text.trim());
};

/**
 * Whether a pid's /proc cmdline (null: no such process) shows the precheck's wrapper; a reused pid runs something else. An empty cmdline is a
 * process inside its execve, before the kernel has set its new arguments, or one that ended and is not reaped yet. Node's spawn event can
 * come inside that window: on 11-23, under load, a first read 36 ms after it was empty, and the run recorded "it ended with no exit code"
 * while its wrapper went on.
 */
export const runsScript = (cmdline: string | null, script: string): boolean => cmdline !== null && (cmdline === "" || cmdline.includes(script));

/** Whether the precheck still runs: its unit is active, or its pid runs its wrapper script (`runsScript`). */
async function running(launch: PrecheckLaunch): Promise<boolean> {
  if (launch.runner.kind === "unit") {
    try {
      const { stdout } = await run("systemctl", ["--user", "show", "-p", "ActiveState", "--value", launch.runner.unit]);
      return ["active", "activating", "deactivating", "reloading"].includes(stdout.trim());
    } catch {
      return true;
    }
  }
  if (existsSync("/proc/self")) return runsScript(await readFile(`/proc/${launch.runner.pid}/cmdline`, "utf8").catch(() => null), launch.script);
  try {
    process.kill(launch.runner.pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** The precheck's exit code once it ended, or how it ended with none: at its hard stop, or before it. A stop of the server aborts the wait. */
async function ended(launch: PrecheckLaunch, signal?: AbortSignal): Promise<number | "hard stop" | "no exit code"> {
  for (let wait = 50; ; wait = Math.min(wait * 2, POLL_MS)) {
    const code = await readExit(launch.exit);
    if (code !== null) return code;
    const past = Date.now() - launch.startedAt >= launch.hardStopMs;
    if (!(await running(launch))) return (await readExit(launch.exit)) ?? (past ? "hard stop" : "no exit code");
    if (past && launch.runner.kind === "pid") {
      try { process.kill(-launch.runner.pid, "SIGKILL"); } catch { /* it ended meanwhile */ }
      return "hard stop";
    }
    await sleep(wait, undefined, { signal });
  }
}

/**
 * The stderr lines that name a failed precheck's error, for its run's error line: the last line that reads as an error, such as `Error: ...`,
 * `TypeError [ERR_X]: ...` or Python's `ValueError: ...`, else the last 3 lines that are no stack frame and no Node version banner. Node
 * prints a crash's error above its stack and `Node.js v26.12.1` last, so until 11-23 the last 3 lines showed a frame, a blank and the banner.
 */
export function stderrGist(text: string): string {
  const lines = text.split("\n").map(line => line.trimEnd()).filter(line => line.trim() && !/^Node\.js v\d/.test(line) && !/^\s+at /.test(line));
  const error = lines.findLast(line => /^\s*(Uncaught\b|[\w.$]*(Error|Exception)\b)/.test(line));
  return (error ? error.trim() : lines.slice(-3).join(" ")).slice(0, 300);
}

/**
 * Waits for a launched precheck, in this server process or the next one, and returns its parsed OUTPUT_FILE; the state file moves forward
 * only on a good run, and an after-job measure keeps none, so the next run counts from the same point. The exit and output files stay until
 * `clearPrecheck`, which runs after the save that records the run, so a server that stops after the precheck ended and before that save
 * leaves the next server process the same result to read. A stop of the server rejects with the abort.
 */
export async function waitPrecheck(duty: Duty, launch: PrecheckLaunch, log: (line: string) => void = () => {}, signal?: AbortSignal): Promise<PrecheckOutput> {
  const targetIn = launch.startedAt + duty.precheck.timeoutMs - Date.now();
  const pastTarget = targetIn > 0
    ? setTimeout(() => log(`duty ${duty.id}: the precheck is past its ${Math.round(duty.precheck.timeoutMs / 1000)} s target and keeps running`), targetIn) : undefined;
  let code: Awaited<ReturnType<typeof ended>>;
  try {
    code = await ended(launch, signal);
  } finally {
    clearTimeout(pastTarget);
  }
  // A failed run keeps its whole stderr in its own file, which the run record names as its detail (`measure`).
  const failed = async (words: string): Promise<Error> => {
    const gist = stderrGist(await readFile(launch.stderr, "utf8").catch(() => ""));
    return new Error(`${words}${gist ? `: ${gist}` : ""} (all of stderr: ${launch.stderr})`);
  };
  if (code !== 0) throw await failed(code === "hard stop" ? `stopped at its hard stop after ${Math.round(launch.hardStopMs / 60_000)} min` : code === "no exit code" ? "it ended with no exit code" : `exit ${code}`);
  let output: unknown;
  try {
    output = JSON.parse(await readFile(launch.output, "utf8"));
  } catch {
    throw await failed("no valid JSON in OUTPUT_FILE");
  }
  if (typeof output !== "object" || output === null || typeof (output as { metrics?: unknown }).metrics !== "object" || (output as { metrics?: unknown }).metrics === null) {
    throw await failed("OUTPUT_FILE has no metrics object");
  }
  await rm(launch.stderr, { force: true });
  // A server that stopped after this rename leaves no state copy, and the state file already holds it.
  if (launch.mode === "run") await rename(launch.nextState, join(dirname(launch.nextState), `${duty.id}.state.json`)).catch(error => {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  });
  return output as PrecheckOutput;
}

/** Deletes a precheck's state copy, wrapper, env file and exit file, once the save that records its run went through. */
export async function clearPrecheck(launch: PrecheckLaunch): Promise<void> {
  await Promise.all([launch.nextState, launch.script, launch.env, launch.exit].map(file => rm(file, { force: true })));
}

/** Where a measure's precheck stands: `resume` is one a stopped server launched, and `launched` hears of a new one before the wait. */
export interface PrecheckHooks {
  resume?: PrecheckLaunch;
  launched?: (launch: PrecheckLaunch) => void;
  signal?: AbortSignal;
  log?: (line: string) => void;
}

/** The precheck's output: of the launch a stopped server left (`resume`), else of a new launch, which `launched` hears of before the wait. */
async function precheckOf(duty: Duty, dir: string, outputFile: string, lastRuns: readonly DutyRunRecord[], mode: "run" | "after", tag: string, hooks: PrecheckHooks): Promise<PrecheckOutput> {
  let launch = hooks.resume;
  if (!launch) {
    launch = await launchPrecheck(duty, dir, outputFile, lastRuns, mode, tag);
    hooks.launched?.(launch);
  }
  return waitPrecheck(duty, launch, hooks.log, hooks.signal);
}

/**
 * A run's re-measure after its own job ended (Prime's `Duties.afterMeasure`): the precheck once more in `after` mode, judged against the
 * targets and the duty's last 10 measured runs. A precheck that fails gives an error measure, so the run still records that it was looked at.
 */
export async function measureAfter(input: { duty: Duty; chat: string; dir: string; runs: readonly DutyRunRecord[]; now?: number } & PrecheckHooks): Promise<AfterMeasure> {
  const { duty, dir } = input;
  const at = input.now ?? Date.now();
  const lastRuns = input.runs.filter(run => run.verdict !== "skipped").slice(0, 10);
  try {
    const output = await precheckOf(duty, dir, join(dir, `${duty.id}.after.json`), lastRuns, "after", `${input.chat.slice(0, 8)}-${duty.id}-${runStamp(at)}-after`, input);
    const readings = outputReadings(duty.readings, output);
    const hostAway = hostAwayOf(output);
    return { at, ...judge(duty.metrics, output, { now: at, runs: lastRuns }), ...(readings ? { readings } : {}), ...(hostAway ? { hostAway } : {}) };
  } catch (error) {
    if (input.signal?.aborted) throw error;
    return { at, verdict: "error", metrics: {}, summary: `the after-job measure failed: ${message(error).slice(0, 300)}` };
  }
}

/** A measured run as the after-job measure of the run before it (Prime's `launch`), or null for an error or a skip. */
export function asAfter(record: DutyRunRecord): AfterMeasure | null {
  if (record.verdict !== "met" && record.verdict !== "missed") return null;
  return { at: record.at, verdict: record.verdict, metrics: record.metrics, summary: record.summary,
    ...(record.parts ? { parts: record.parts } : {}), ...(record.items ? { items: record.items } : {}), ...(record.readings ? { readings: record.readings } : {}) };
}

function walk(plan: readonly PlanItem[], visit: (item: PlanItem) => void): void {
  for (const item of plan) {
    visit(item);
    walk(item.children, visit);
  }
}

/**
 * The fix step for each missed metric: an open plan step whose `duty` is `<dutyId>/<metricKey>`, with `hold` naming the open For you todo that
 * links it, since only the owner's answer moves such a step and its miss owes no fix job (`Boards.pushDuty`).
 */
export function fixesOn(board: ChatBoard | null, dutyId: string, keys: readonly string[], liveJob: (job: string) => boolean): Record<string, FixLink> {
  const out: Record<string, FixLink> = {};
  if (!board) return out;
  const held = new Map(board.todos.flatMap(todo => !todo.done && todo.step ? [[todo.step, todo.id] as const] : []));
  walk(board.plan, item => {
    if (item.status === "done" || item.status === "dropped" || !item.duty) return;
    const [id, key] = item.duty.split("/");
    if (id !== dutyId || !key || !keys.includes(key) || out[key]) return;
    const hold = held.get(item.id);
    out[key] = { step: item.id, ...(item.job ? { job: item.job } : {}), live: item.job ? liveJob(item.job) : false, ...(hold ? { hold } : {}) };
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
  liveJob: (job: string) => boolean; boardApi: string; now?: number;
} & PrecheckHooks): Promise<DutyRunResult> {
  const { duty, dir, trigger } = input;
  // A skipped run measured nothing, so the precheck's LAST_RUNS_FILE and the streaks read the measured runs only, as Prime's `Duties.run` does.
  const previous = input.previous.filter(run => run.verdict !== "skipped");
  const started = input.now ?? Date.now();
  const detail = join(dir, `${duty.id}-${runStamp(started)}.json`);
  const wall = input.resume?.startedAt ?? Date.now();
  const overrunOf = () => {
    const ms = Date.now() - wall;
    return ms > duty.precheck.timeoutMs ? { overrun: { ms, targetMs: duty.precheck.timeoutMs } } : {};
  };
  let record: DutyRunRecord;
  let flagged: FlaggedSlice[] = [];
  try {
    const output = await precheckOf(duty, dir, detail, previous.slice(0, 10), "run", `${input.chat.id.slice(0, 8)}-${duty.id}-${runStamp(started)}-run`, input);
    const judged = judge(duty.metrics, output, { now: started, runs: previous });
    const readings = outputReadings(duty.readings, output);
    const hostAway = hostAwayOf(output);
    const waitsOn = judged.verdict === "error" ? outsideWaitOf(output) : undefined;
    flagged = output.flagged ?? [];
    record = {
      duty: duty.id, at: started, slot: started, trigger, ms: Date.now() - wall, verdict: judged.verdict, metrics: judged.metrics, summary: judged.summary, detail,
      ...(judged.parts ? { parts: judged.parts } : {}), ...(judged.items ? { items: judged.items } : {}), ...(readings ? { readings } : {}),
      ...(judged.verdict === "error" ? { error: judged.summary } : {}), ...overrunOf(), ...(hostAway ? { hostAway } : {}), ...(waitsOn ? { waitsOn } : {}),
    };
  } catch (error) {
    if (input.signal?.aborted) throw error;
    await rm(detail, { force: true });
    // The detail of a failed run is its whole stderr, which `launchPrecheck` writes beside the output file and `waitPrecheck` keeps.
    const stderr = detail.replace(/\.json$/, ".stderr.log");
    record = { duty: duty.id, at: started, slot: started, trigger, ms: Date.now() - wall, verdict: "error", metrics: {}, summary: "the precheck failed", error: message(error).slice(0, 500),
      ...(existsSync(stderr) ? { detail: stderr } : {}), ...overrunOf() };
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
  if (record.verdict === "error" && record.waitsOn) {
    findings = [`No measure: ${record.summary}. It waits on something outside the precheck: ${record.waitsOn} The precheck is not broken, so leave it as it is ` +
      "and start no fix job for it; this run counts toward no error streak.", overrunLine].filter(Boolean).join("\n\n");
  } else if (record.verdict === "error") {
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
  // A run that reads error only because its headline waits outside the precheck, with every number it read on target, has nothing a job can do.
  const waits = record.verdict === "error" && record.waitsOn !== undefined && Object.values(record.metrics).every(result => result.met);
  const idle = (record.verdict === "met" || waits) && !misses.length && !record.overrun && !acts;
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
    `You are the duty job of the chat "${chat.name}" (${chat.id.startsWith("ag_") ? "agent" : "thread"} ${chat.id}), started ${when} KST. The chat server starts one duty job on each run of this duty that ` +
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
    }).join("\n") + "\n\nA miss is never accepted as it stands. A fix step is a plan step with `duty` set to `" + duty.id + "/<metricKey>`. " +
      "When a fix step closes, the chat server runs this duty again at once, and while the duty stays red with no job on it, again each check-in interval."] : []),
    "## How to work",
    `The precheck is \`${duty.precheck.command.join(" ")}\` in ${duty.precheck.cwd}; read its script there and its per-run output in the findings file above.`,
    "Search only named folders with rg, and never walk all of home with find, grep -r or a glob: home holds repo copies that take hours to scan (sieun-pi AGENTS.md rule 6).",
    `The chat's board is GET ${boardApi} (JSON with the plan and the owner's todos). Change it with POST ${boardApi} and the body {"actor": "agent", "ops": [...]}, ` +
      "where the ops are the board's plan_add, plan_update, todo_add and the rest; read it first, then check the real state behind it.",
    "Fix what you find, script what can be scripted, and skip nitpicks. Use the subagent tool for each separate part of the work.",
    "## Report",
    "End with one plain report of at most 3 lines: the headline number and its gap, what you changed, and what is left. Send it with send_message " +
      "(with no such tool, make it your final answer), and the chat server posts it to the chat; when nothing needs the chat, send nothing.",
  ].join("\n\n");
}
