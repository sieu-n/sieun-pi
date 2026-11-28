/**
 * Three readings of agent factory's duty "Agents keep their duties" (d7, agent-boards.ts --part duties), by the owner's ask in
 * #1124-cost-management p60 (msg mx0bgshc, 11-28): "daily monitor yourself of whether children agents are doing fine and fixing recurring
 * issues, duties not being kept due to poor Duty system implementation?". It followed p56 (msg mx0b5pkg): devops guy's daily bill duty d17
 * let a PostHog sync cost up to $80 a day from 11-15 to 11-26 and never named it. Until then d7 read only that a duty exists, ran and had
 * its misses fixed.
 *
 * 1. `blindChecks`: real past problems (the past-problems file) that the owning agent's check would still miss, each proved by a replay.
 * 2. `returningProblems`: duty metrics that went red again after a fix step for them closed, 2 or more times in 14 days.
 * 3. `dutySystemFaults`: duties not kept because of the duty system itself, such as a failed precheck or a red duty with no job.
 *
 * Fable auditor's d6 "Waste and silent problems get found and fixed" (agents/fable-auditor/duties/find-waste.py) finds new waste across
 * the app; this file judges whether each agent's own checks and fixes work, and counts no vendor line, program or storage itself.
 */
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import type { DutyRow, Flag } from "./agent-boards.ts";

const DAY_MS = 86_400_000;
const squash = (text: string): string => text.replace(/\s+/g, " ").trim();
/** A time as "MM-DD HH:MM" in KST, the zone run stamps and board notes use. */
const kst = (at: number): string => new Date(at + 9 * 3_600_000).toISOString().slice(5, 16).replace("T", " ");

interface Named { id: string; name: string }
const named = (entry: { agent: string }, agent: Named): boolean => entry.agent === agent.id || entry.agent === agent.name;

/**
 * One real problem an agent's duty covered and did not name on the day: an entry of ~/work/agent-duties/past-problems.json. `source` is the
 * owner's post or the report that found it. `replay` is a shell command that feeds that day's stored numbers to the duty's precheck as it
 * is today; null while nobody has written one.
 */
export interface PastProblem { id: string; agent: string; duty: string; what: string; when: string; source: string; replay: string | null }

/** What a replay proved: today's check flags the old problem, misses it, or the replay did not run to an answer. */
export type Replayed = { result: "flagged" } | { result: "missed" } | { result: "not_measured"; why: string };

/** The past-problems file, or no entry when it is absent. Any other shape throws, so a bad write never reads as "nothing to replay". */
export function readPastProblems(file: string): PastProblem[] {
  if (!existsSync(file)) return [];
  const data: unknown = JSON.parse(readFileSync(file, "utf8"));
  const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
  const valid = (entry: Partial<PastProblem> | null): boolean => !!entry && text(entry.id) && text(entry.agent) && text(entry.duty) && text(entry.what)
    && text(entry.when) && text(entry.source) && (entry.replay === null || text(entry.replay));
  if (!Array.isArray(data) || !data.every(valid) || new Set(data.map((entry: PastProblem) => entry.id)).size !== data.length) {
    throw new Error(`${file} is not a list of {id, agent, duty, what, when, source, replay} with one entry per id; replay is a command or null`);
  }
  return data as PastProblem[];
}

/**
 * A replay may run this long. d7's precheck has a 120 s target and took a median 4.6 s over 32 runs from 11-21 to 11-28
 * (~/work/duty-shape/b-logic-record.md, section 1), and the replays run side by side, so a 60 s stop keeps the run inside that target.
 * The three replays seeded on 11-28 took 0.2 to 3.7 s each.
 */
export const REPLAY_STOP_MS = 60_000;
/** The variables a precheck run gets (server/duty-run.ts). A replay starts a precheck of its own, which must not write into d7's files. */
const RUN_ENV = ["OUTPUT_FILE", "STATE_FILE", "LAST_RUNS_FILE", "PRECHECK_MODE", "PRECHECK_TRIGGER"];

/**
 * Runs one replay command with `sh -c` in `cwd`. Exit 0 means the precheck flagged the old problem and exit 1 that it ran and did not.
 * Any other end (another exit code, a signal, the stop at `stopMs`, no command) proves neither, so it reads not measured.
 */
export function replay(command: string | null, cwd: string, stopMs = REPLAY_STOP_MS): Promise<Replayed> {
  if (command === null) return Promise.resolve({ result: "not_measured", why: "it has no replay command yet" });
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !RUN_ENV.includes(key)));
  return new Promise(resolve => {
    execFile("sh", ["-c", command], { cwd, env, timeout: stopMs, maxBuffer: 16 * 1024 * 1024 }, (error, _stdout, stderr) => {
      if (!error) return resolve({ result: "flagged" });
      if (error.code === 1) return resolve({ result: "missed" });
      const last = squash(String(stderr)).slice(-160);
      const how = error.killed ? `its replay did not end in ${Math.round(stopMs / 1000)} s` : `its replay ended with ${typeof error.code === "number" ? `exit ${error.code}` : error.signal ?? String(error.code)}`;
      resolve({ result: "not_measured", why: `${how}${last ? ` (${last})` : ""}` });
    });
  });
}

/**
 * Reading 1, checks that read fine while the problem is there. `checks_blind` counts the past problems whose replay ran and did not flag
 * them. It gets no value while a past problem has no working replay and none of the others is missed, so the run reads not measured on it
 * and never met on a problem nobody replayed (`judge` in chat-duties.ts names the `gap` item as the reason). Each entry goes to the duty
 * job as a hand-off, and puts no agent off the pattern: the fix is d7's to write or to send as an exact change.
 */
export function blindChecks(problems: readonly (PastProblem & { replayed: Replayed })[], agents: readonly Named[]): { metrics: Record<string, number>; flagged: Flag[]; n: number } {
  const flagged: Flag[] = [];
  let missed = 0;
  let unmeasured = 0;
  for (const problem of problems) {
    const owner = agents.find(agent => named(problem, agent))?.name ?? problem.agent;
    const about = `${owner} ${problem.duty}, ${problem.when}: ${squash(problem.what).slice(0, 220)} (${problem.source})`;
    if (problem.replayed.result === "missed") {
      missed += 1;
      flagged.push({ kind: "check_blind", sig: `past/${problem.id}`, handOff: true, excerpt: `Today's check would still miss this past problem. ${about}. Replay: ${problem.replay}` });
    } else if (problem.replayed.result === "not_measured") {
      unmeasured += 1;
      flagged.push({ kind: "gap", sig: `past/${problem.id}/replay`, handOff: true, excerpt: `past problem ${problem.id} is not measured, because ${problem.replayed.why}. ${about}` });
    }
  }
  return {
    metrics: { ...missed > 0 || unmeasured === 0 ? { checks_blind: missed } : {}, past_problems: problems.length, past_problems_not_measured: unmeasured },
    flagged, n: problems.length - unmeasured,
  };
}

/** One measured reading of a duty metric: when, and whether it met its target. */
export interface MetricRead { at: number; met: boolean }
/** A closed fix step of a metric, a plan step with `duty` set to "<duty id>/<metric key>" and status done. `at` is its `updatedAt`. */
export interface FixClose { step: string; at: number; text: string }
/** A duty metric with its measured readings and the fix steps that closed for it. */
export interface MetricHistory { agent: Named; duty: Named; metric: string; reads: readonly MetricRead[]; closes: readonly FixClose[] }

/**
 * The sorted-returns file, ~/work/agent-duties/returns.json, which d7's duty job writes once it found why a metric keeps coming back.
 * `lasting` names the lasting cause it fixed and when, and returns before `at` no longer count. `new_work` names a metric that turns red
 * whenever new work arrives, such as unposted findings or pages behind the day's commits, where each fix is that day's work and no cause
 * is left to find. Without the file a metric with 2 returns would stay red for 14 days whatever the job did.
 */
export interface SortedReturns {
  lasting: readonly { agent: string; duty: string; metric: string; at: string; why: string }[];
  new_work: readonly { agent: string; duty: string; metric: string; why: string }[];
}
export const NO_SORTED_RETURNS: SortedReturns = { lasting: [], new_work: [] };

/** The sorted-returns file, or empty lists when it is absent. Any other shape throws. */
export function readReturns(file: string): SortedReturns {
  if (!existsSync(file)) return NO_SORTED_RETURNS;
  const data = JSON.parse(readFileSync(file, "utf8")) as { lasting?: unknown; new_work?: unknown } | null;
  const entries = (list: unknown, dated: boolean): boolean => Array.isArray(list) && list.every((entry: Record<string, unknown> | null) =>
    !!entry && ["agent", "duty", "metric", "why"].every(key => typeof entry[key] === "string") && (!dated || (typeof entry.at === "string" && Number.isFinite(Date.parse(entry.at)))));
  if (!data || !entries(data.lasting, true) || !entries(data.new_work, false)) throw new Error(`${file} is not {lasting: [{agent, duty, metric, at, why}], new_work: [{agent, duty, metric, why}]}`);
  return data as SortedReturns;
}

/** The window and the count come from agent factory's reading of p60: red again within 14 days of a closed fix, 2 or more times. */
export const RETURN_WINDOW_MS = 14 * DAY_MS;
export const RETURNS_FLAGGED = 2;

/**
 * The times a metric came back: a reading that missed right after one that met, in the last 14 days and after `since`, with a fix step for
 * the metric closed in the 14 days before it. A metric that stays red through several fix steps never left, so it has no return; its fix
 * steps are parts of one fix. A close time is the step's `updatedAt`, which a later note edit moves forward, so a return can only be
 * undercounted. Steps carry `updatedAt` since 2026-11-25 20:41Z (57b1b63fb); an older close has no time and is left out.
 */
export function returnsOf(reads: readonly MetricRead[], closes: readonly FixClose[], now: number, since = 0): number[] {
  const ordered = [...reads].sort((a, b) => a.at - b.at);
  return ordered.flatMap((read, index) => {
    const before = ordered[index - 1];
    if (read.met || !before?.met || read.at <= since || now - read.at > RETURN_WINDOW_MS) return [];
    return closes.some(close => close.at < read.at && read.at - close.at <= RETURN_WINDOW_MS) ? [read.at] : [];
  });
}

/**
 * Reading 2, problems that come back. `problems_returned` counts the duty metrics with 2 or more returns (`returnsOf`) that the
 * sorted-returns file does not settle. Each goes to the duty job, worst first, with its fix steps and the times it came back.
 */
export function returningProblems(histories: readonly MetricHistory[], sorted: SortedReturns = NO_SORTED_RETURNS, now = Date.now()): { metrics: Record<string, number>; flagged: Flag[]; n: number } {
  const found: { history: MetricHistory; returns: number[] }[] = [];
  let newWork = 0;
  for (const history of histories) {
    const same = (entry: { agent: string; duty: string; metric: string }): boolean => named(entry, history.agent) && entry.duty === history.duty.id && entry.metric === history.metric;
    const since = Math.max(0, ...sorted.lasting.filter(same).map(entry => Date.parse(entry.at)));
    const returns = returnsOf(history.reads, history.closes, now, since);
    if (returns.length < RETURNS_FLAGGED) continue;
    if (sorted.new_work.some(same)) newWork += 1;
    else found.push({ history, returns });
  }
  found.sort((a, b) => b.returns.length - a.returns.length);
  const flagged = found.map(({ history, returns }): Flag => {
    const closes = [...history.closes].filter(close => now - close.at <= 2 * RETURN_WINDOW_MS).sort((a, b) => a.at - b.at);
    return {
      kind: "problem_returned", sig: `returned/${history.agent.id}/${history.duty.id}/${history.metric}`, handOff: true,
      excerpt: `${history.agent.name} ${history.duty.id} "${history.duty.name}": ${history.metric} went red again ${returns.length} times in 14 days after a closed fix, at ${returns.map(kst).join(", ")} KST. ` +
        `Closed fix steps: ${closes.map(close => `${close.step} (${kst(close.at)}, "${squash(close.text).slice(0, 70)}")`).join("; ")}`,
    };
  });
  return { metrics: { problems_returned: found.length, returns_new_work: newWork }, flagged, n: histories.filter(history => history.closes.length > 0).length };
}

/** A plan step as the board holds it, the fields these readings use. */
export interface FixStep { id: string; text?: string; note?: string; status?: string; duty?: string; updatedAt?: string }

/** The closed fix steps of one metric of one duty, each with the time it last changed; a step with no time is left out. */
export function fixCloses(steps: readonly FixStep[], duty: string, metric: string): FixClose[] {
  return steps.flatMap(step => {
    const at = step.updatedAt ? Date.parse(step.updatedAt) : NaN;
    return step.duty === `${duty}/${metric}` && step.status === "done" && Number.isFinite(at) ? [{ step: step.id, at, text: step.text ?? "" }] : [];
  });
}

/** The value a precheck writes for a metric whose source failed (chat-duties.ts PLACEHOLDER); it is no measure. */
const PLACEHOLDER = 999_999;

/** One reading per metric of a stored precheck output (a duty run file), judged against the duty's targets of today. */
export function readsOf(output: unknown, at: number, metrics: NonNullable<DutyRow["duty"]["metrics"]>): Record<string, MetricRead> {
  const values = (output as { metrics?: Record<string, unknown> } | null)?.metrics ?? {};
  const reads: Record<string, MetricRead> = {};
  for (const metric of metrics) {
    const value = values[metric.key];
    if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) === PLACEHOLDER) continue;
    reads[metric.key] = { at, met: metric.op === "<=" ? value <= metric.target : value >= metric.target };
  }
  return reads;
}

/** A duty run file's name, "<duty id>-<YYMMDD>-<HHMMSS>.json" with the stamp in KST (server/duty-run.ts runStamp): its duty and its time. */
export function runFile(name: string): { duty: string; at: number } | null {
  const match = /^(d\d+)-(\d\d)(\d\d)(\d\d)-(\d\d)(\d\d)(\d\d)\.json$/.exec(name);
  if (!match) return null;
  const [, duty, year, month, day, hour, minute, second] = match;
  return { duty: duty!, at: Date.UTC(2000 + Number(year), Number(month) - 1, Number(day), Number(hour) - 9, Number(minute), Number(second)) };
}

/**
 * The words boards.ts `besideBusyJob` adds to a run's summary when the duty's job waits for a model account. test/server/agent-boards.test.ts
 * reads them in boards.ts, so a change there fails that test instead of turning this count to 0.
 */
export const JOB_WAITS_ACCOUNT = /\b(?:still waits|still waited|is waiting) for a model account\b/;
/** The summary of a run whose precheck exited nonzero, hit its hard stop or wrote no valid output (server/duty-run.ts `measure`). */
export const PRECHECK_FAILED = "the precheck failed";
/**
 * The words `judge` (chat-duties.ts) puts in the summary of a run that left a counted metric with no value. A metric added to the duty after
 * its newest run is no such run, so the run's own summary decides, not today's metric list; a test runs `judge` against these words.
 */
export const NOT_MEASURED = /\bthe precheck (?:gave no value|wrote the placeholder)\b/;
/** Words of a goal sentence that say the check leaves something out, and the kinds of a run's flagged items that name a left-out item. */
export const LEAVES_OUT = /\b(?:left|leaves?|leaving) (?:\w+ ){0,2}out\b|\bexclud(?:e|es|ed|ing)\b|\b(?:is|are) not counted\b/i;
export const LEFT_OUT_KIND = /left_out|skipped|excluded/;
/**
 * Words of a closed fix step that say the check was wrong, not the thing it checks. A word match finds only some: against the 31 fix steps
 * of agent factory that ~/work/duty-shape/b-logic-record.md (section 2) read as the check's own bug, these words found 8.
 */
export const CHECK_WAS_WRONG = new RegExp([
  "\\bstop (?:the |its |this |one |a )?[\\w' ,.-]{0,60}?\\b(?:counting|failing|marking|flagging|reading|turning|grading)\\b",
  "\\b(?:check|precheck|duty|d\\d+|sweep)(?:'s)? (?:own )?(?:bug|fault)\\b", "\\b(?:bug|fault) in the (?:check|precheck)\\b",
  "\\b(?:check|precheck|duty|d\\d+) (?:itself )?(?:counted|counts|read|reads|flagged|flags|graded|grades|marked|marks) [^.]{0,100}\\b(?:twice|wrong|wrongly|by mistake|its own)\\b",
  "\\bgrade [^.]{0,80}\\bright\\b", "\\bmatch words? (?:lacked|missed)\\b", "\\bfalse (?:red|miss|positive|alarm)s?\\b", "\\b(?:the|its) (?:check|precheck) (?:was|is) wrong\\b",
  "\\bcount(?:ed|s)? [^.]{0,60}\\b(?:once|twice)\\b",
].join("|"), "i");

type Run = DutyRow["runs"][number];
/** A run's verdict and summary once its job's fixes are in: the after-job measure when it has one. */
const effective = (run: Run): { verdict: string; summary: string } => ({ verdict: run.after?.verdict ?? run.verdict, summary: run.after?.summary ?? run.summary ?? "" });

/**
 * A duty one job holds: 3 or more runs of a not-met streak older than 24 h started no job and gave the same job nothing. The numbers are
 * the survey's of 11-28 (~/work/bill-check-miss/survey.md, "Hole 5"): devops guy's d17 had 7 such runs behind one job in 62 h, 5180
 * designer's d1 had 9 and agent factory's d2 had 3, and no duty with fewer runs behind one job had a finding that reached nobody.
 */
export const HELD_RUNS = 3;

/**
 * The jobs that hold a duty, from its measured runs, newest first: per job, the runs of the newest not-met streak that named it, started
 * none (the run holds no `submission`) and gave it nothing (`given`, server/duty-items.ts), when the streak has HELD_RUNS runs, began over
 * 24 h ago and HELD_RUNS of them stand behind that job. `now` says whether the job is the one the newest run names, which a fix can still
 * move, and `waits` how many of its runs said the job waited for a model account, which is pi-pool's line and no fault of the duty system.
 */
export function heldJobs(runs: readonly Run[], now: number): { job: string; name: string; runs: number; waits: number; since: number; now: boolean }[] {
  const end = runs.findIndex(run => effective(run).verdict === "met");
  const streak = end < 0 ? runs : runs.slice(0, end);
  const since = streak.at(-1)?.at;
  if (streak.length < HELD_RUNS || since === undefined || now - since <= DAY_MS) return [];
  const held = new Map<string, { job: string; name: string; runs: number; waits: number }>();
  for (const run of streak) {
    if (!run.job || run.job.submission !== undefined || run.given?.length) continue;
    const entry = held.get(run.job.id) ?? { job: run.job.id, name: run.job.name ?? run.job.id, runs: 0, waits: 0 };
    entry.runs += 1;
    if (JOB_WAITS_ACCOUNT.test(run.summary ?? "")) entry.waits += 1;
    held.set(run.job.id, entry);
  }
  return [...held.values()].filter(entry => entry.runs >= HELD_RUNS).map(entry => ({ ...entry, since, now: streak[0]!.job?.id === entry.job }));
}

export interface DutyHealthRead {
  agent: Named; duties: readonly DutyRow[]; steps: readonly FixStep[];
  /** Per duty id, the flagged item of its newest run whose kind names something the run left out (`LEFT_OUT_KIND`), read from the run's detail file. */
  leftOut?: Readonly<Record<string, string>>;
}

/**
 * Reading 3, duties not kept because of the duty system itself. `duty_system_faults` counts, per duty that is not paused, each fault its
 * newest measured run shows, so a fix and a rerun clear it:
 * - precheck_failed: the precheck exited nonzero, hit its hard stop or wrote no valid output, or ran past its timeoutMs.
 * - not_measured: the run left a metric with no value while no box was away and no outside wait was named, so the card shows no number.
 * - red_no_job: the duty reads missed, the run names no job and no fix step has a job at work, so nobody moves it.
 * - job_unreported: the duty's newest job ended (its after-job measure ran) and its report never reached the agent's work thread.
 * - held_by_one_job: the job its newest run names holds the duty (`heldJobs`), with HELD_RUNS runs that gave it nothing while it waited for
 *   no model account. Since 11-28 the duty runner steers such a job with each new item and replaces it past its stuck limit
 *   (server/duty-items.ts), so one that shows here slipped through that rule.
 * They go to d7's own duty job to fix in the shared duty code or text, never to the agent, and put no agent off the pattern.
 *
 * Five more counts are readings with no target, because the duty job cannot move them by a fix of its own: the failed and unmeasured runs
 * of the last 24 h, the duties whose job waits for a model account (pi-pool's line, held on the owner's account todos), the fix steps
 * closed in 24 h whose words say the check was wrong (`CHECK_WAS_WRONG`), the duties that read met while their goal or newest run
 * names something they leave out (`LEAVES_OUT`), as devops guy's d17 left out PostHog's unpriced rows and read nothing for them, and the
 * duties whose not-met streak holds HELD_RUNS runs behind any one job, also a job that ended or only waited for an account
 * (`duties_held_in_streak`, the survey's count, which stays until those runs leave the streak).
 */
export function dutySystemFaults(reads: readonly DutyHealthRead[], now = Date.now()): { metrics: Record<string, number>; flagged: Flag[]; n: number } {
  const flagged: Flag[] = [];
  const counts = { precheck_failed: 0, not_measured: 0, red_no_job: 0, job_unreported: 0, held_by_one_job: 0 };
  let heldInStreak = 0;
  let duties = 0;
  let failedRuns = 0;
  let unmeasuredRuns = 0;
  let accountWaits = 0;
  let leavesOut = 0;
  let checkWrong = 0;
  const failed = (run: Run): boolean => run.summary === PRECHECK_FAILED || run.overrun !== undefined;
  const held = (run: Run): boolean => run.hostAway !== undefined || run.waitsOn !== undefined;
  const unmeasured = (run: Run): boolean => !failed(run) && !held(run) && NOT_MEASURED.test(effective(run).summary);
  for (const { agent, duties: rows, steps, leftOut = {} } of reads) {
    for (const step of steps) {
      const at = step.updatedAt ? Date.parse(step.updatedAt) : NaN;
      if (step.status !== "done" || !/^d\d+\//.test(step.duty ?? "") || !(now - at < DAY_MS) || !CHECK_WAS_WRONG.test(`${step.text ?? ""}. ${step.note ?? ""}`)) continue;
      checkWrong += 1;
      flagged.push({ kind: "fix_blames_check", sig: `${agent.id}/${step.id}/check-wrong`, excerpt: `${agent.name} ${step.id} (${step.duty}), closed ${kst(at)} KST, fixed the check itself: "${squash(step.text ?? "").slice(0, 160)}"` });
    }
    for (const row of rows) {
      if (row.paused || row.duty.status === "paused") continue;
      const measured = row.runs.filter(run => run.verdict !== "skipped");
      const newest = measured[0];
      if (!newest) continue;
      duties += 1;
      const recent = measured.filter(run => now - (run.at ?? 0) < DAY_MS);
      failedRuns += recent.filter(failed).length;
      unmeasuredRuns += recent.filter(unmeasured).length;
      const flag = (kind: keyof typeof counts, excerpt: string) => {
        counts[kind] += 1;
        flagged.push({ kind: `system_${kind}`, sig: `${agent.id}/${row.duty.id}/system/${kind}`, handOff: true, excerpt: `${agent.name} ${row.duty.id} "${row.duty.name}": ${excerpt}` });
      };
      const { verdict, summary } = effective(newest);
      if (failed(newest)) {
        flag("precheck_failed", newest.overrun && newest.summary !== PRECHECK_FAILED ? `its newest run's precheck ran ${Math.round(newest.overrun.ms / 1000)} s against a target of ${Math.round(newest.overrun.targetMs / 1000)} s`
          : `its newest run's precheck failed: ${squash(newest.error ?? "no error on record").slice(0, 200)}`);
      } else if (unmeasured(newest)) {
        flag("not_measured", `its newest run left a metric with no value, with no box away and no outside wait named: ${squash(summary).slice(-220)}`);
      }
      if (verdict === "missed" && !held(newest) && !newest.job && !Object.values(newest.fixes ?? {}).some(fix => fix.live)) {
        flag("red_no_job", `it reads missed, its newest run started no job and no fix step has a job at work: ${squash(summary).slice(0, 200)}`);
      }
      const started = measured.find(run => run.job?.submission !== undefined);
      if (started?.after && !started.job!.reported) flag("job_unreported", `its job ${started.job!.name ?? started.job!.id} ended and its report never reached the work thread`);
      const holders = heldJobs(measured, now);
      if (holders.length) heldInStreak += 1;
      const holder = holders.find(entry => entry.now && entry.runs - entry.waits >= HELD_RUNS);
      if (holder) {
        flag("held_by_one_job", `it is not met since ${kst(holder.since)} KST, and ${holder.runs} of its runs started no job and gave its job ${holder.name} nothing` +
          `${holder.waits ? `, ${holder.waits} of them while that job waited for a model account` : ""}: ${squash(summary).slice(0, 160)}`);
      }
      if (JOB_WAITS_ACCOUNT.test(newest.summary ?? "")) {
        accountWaits += 1;
        const first = [...measured].reverse().find(run => run.job?.id === newest.job?.id);
        flagged.push({ kind: "job_waits_account", sig: `${agent.id}/${row.duty.id}/account-wait`,
          excerpt: `${agent.name} ${row.duty.id} "${row.duty.name}": its job ${newest.job?.name ?? ""} waits for a model account${first?.at ? `, started ${kst(first.at)} KST` : ""}` });
      }
      const sentence = (row.duty.goal ?? "").split(/(?<=[.!?;])\s+/).find(part => LEAVES_OUT.test(part));
      const left = leftOut[row.duty.id] ?? sentence;
      if (verdict === "met" && left) {
        leavesOut += 1;
        flagged.push({ kind: "met_leaving_out", sig: `${agent.id}/${row.duty.id}/leaves-out`, excerpt: `${agent.name} ${row.duty.id} "${row.duty.name}" reads met and leaves something out: "${squash(left).slice(0, 200)}"` });
      }
    }
  }
  const faults = counts.precheck_failed + counts.not_measured + counts.red_no_job + counts.job_unreported + counts.held_by_one_job;
  return {
    metrics: {
      duty_system_faults: faults, prechecks_failed: counts.precheck_failed, duties_not_measured: counts.not_measured, red_duties_no_job: counts.red_no_job, duty_jobs_unreported: counts.job_unreported,
      duties_held_by_one_job: counts.held_by_one_job,
      precheck_failed_runs_24h: failedRuns, unmeasured_runs_24h: unmeasuredRuns, duty_jobs_waiting_account: accountWaits, fixes_blaming_check_24h: checkWrong, duties_met_leaving_out: leavesOut,
      duties_held_in_streak: heldInStreak,
    },
    flagged, n: duties,
  };
}
