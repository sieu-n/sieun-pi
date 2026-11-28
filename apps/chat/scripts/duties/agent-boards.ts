/**
 * Duty precheck: every open step on every sw factory agent's board is moved or held on the owner, by the owner's rule (#sw-factory-build
 * p205, 11-24, msg mwtu5kfz: "all board items should be either user-bottlenecked or actively being worked on"). It reads each agent's
 * `GET /api/agents/:id/steps`, which counts by the same rule as the check-in (server/check-in-job.ts `checkInPrecheck`): a step is moved
 * while its own job is at work, a subagent of it works or it sleeps on a board.wake, and held while an open For you todo links it or it waits
 * on the owner's go. It also reads each agent's check-in runs (`GET /api/agents/:id/check-in`), and a check-in that is not paused and has no
 * run in 1.5 of its intervals is late, as Prime's d9 reads a late check-in (legacy/prime/user-history/src/checkin-schedule.ts). Until 11-24
 * nothing counted this for sw factory: d9 leaves sw factory boards off `stuck_steps_all`, and by the owner's rule 7 of 44 open steps had
 * neither a live owner nor an open For you todo (~/work/duty-and-nudge/part3-lazy.md).
 *
 * It also counts the agents that keep no live duty over their areas, by the owner's ask (#dev-api-portal p27, msg mwwk9n6k, 11-26: "make sure
 * all other agents are well behaved in terms of keeping their responsibilities"; p25: "think of duty as copy pasting this prompt every day").
 * A duty is live when it is not paused and has at least one run that measured something; a paused or never-run duty counts as none. An agent
 * with no live duty is uncovered. An areas file (AREAS_FILE, default ~/work/agent-duties/areas.json, `[{agent, areas: [{area, source, duty?}]}]`,
 * agent by id or name, duty by id or name) lists the areas the owner gave each agent, and an area is uncovered while it names no duty or its
 * duty is not live. A duty also stops being live when its runs stop for over 2 of its intervals, and each paused or overdue duty is a
 * flagged item of its own (duties_paused, duties_overdue), as fable auditor's d2 counted them on 11-26. An agent with no brief and no area in the file has no area, so it is left out and listed apart: on 11-26 feature probe
 * had no brief, steps, jobs or owner post, and said it owns nothing. On 11-26 at 05:13 KST, 6 of 17 agents had no duty at all.
 *
 * Usage: OUTPUT_FILE=<file> node --import tsx scripts/duties/agent-boards.ts [--part boards|duties] [--server http://127.0.0.1:5184] [--areas <file>]
 * `--part duties` is the precheck of agent factory's duty "Agents keep their duties" (agent-duties.duty.json, d7); the default is d5's. Since
 * c249 (#sw-factory-build p234, msg mwwklmfk, 11-26) d7 also checks each agent's two common duties (`agentPattern`) and its output carries
 * `messages`, one nudge per agent off the pattern in the shape of ~/work/agent-duties/messages.json, which the work thread relays. Since
 * the owner's p237 (msg mwwksq7v) it also counts wiki clutter (`wikiClutter`), read from the wiki config's content root and agents mount.
 * Since 11-28 a post the `ONGOING` words match is a candidate, and the sorted-asks file (ASKS_FILE, default ~/work/agent-duties/asks.json,
 * `--asks <file>`) decides it: `standing` gives an ask to one agent, `one_time` drops a post, and a post in neither list is handed to the duty
 * job as `ask_unsorted` (`SortedAsks`).
 * Since the owner's #1124-cost-management p60 (msg mx0bgshc, 11-28) d7 also reads whether each agent's checks and fixes work (duty-health.ts):
 * past problems a check would still miss (PAST_FILE, default ~/work/agent-duties/past-problems.json, `--past <file>`), metrics that went red
 * again after a closed fix (RETURNS_FILE, default ~/work/agent-duties/returns.json, `--returns <file>`) and duties the duty system did not keep.
 * Without OUTPUT_FILE the result prints to stdout.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { blindChecks, dutySystemFaults, fixCloses, LEFT_OUT_KIND, readPastProblems, readReturns, readsOf, replay, returningProblems, runFile, type FixStep, type MetricHistory, type MetricRead } from "./duty-health.ts";
import { isMain } from "./main-module.ts";
import { realAgents } from "./real-agents.ts";
import { homedir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { parseArgs } from "node:util";

interface Agent { id: string; name: string; archived?: boolean; test?: boolean; hostState?: string; thread?: string }
interface Step { id: string; text: string; status: string; job?: string; waitFor?: string; waitUntil?: string }
interface Steps { open: number; stuck: Step[]; gaps: { id: string; text: string }[] }
interface CheckIn { everyMs: number; paused: boolean; lastAt: number | null; runs?: { at: number; verdict: string; summary: string }[] }
/** A row of `GET /api/agents/:id/duties`, the fields this check reads. */
export interface DutyRow {
  duty: { id: string; name: string; status?: string; ownerWords?: string; goal?: string; metrics?: { key: string; op: "<=" | ">="; target: number }[] }; paused: boolean;
  runs: {
    verdict: string; at?: number; readings?: Record<string, number>; metrics?: Record<string, { value?: number }>; detail?: string; hostAway?: string; waitsOn?: string;
    /** `submission` is on the run that started the job, and `reported` once its report reached the work thread (server/boards.ts deliverReport). */
    job?: { id: string; name?: string; submission?: number; reported?: boolean };
    summary?: string; error?: string; overrun?: { ms: number; targetMs: number };
    /** Per missed metric, its fix step and whether that step's job is at work (server/duty-run.ts fixesOn). */
    fixes?: Record<string, { step: string; job?: string; live?: boolean }>;
    /** The measure taken again once the run's job ended. */
    after?: { at?: number; verdict?: string; summary?: string; metrics?: Record<string, { value?: number }> };
    flagged?: { handOff?: true; sig?: string }[];
    /** The keys of the items the run gave the job it names (server/duty-items.ts); a run beside a job that gave it nothing has none. */
    given?: string[];
  }[];
  schedule?: { kind: string; at?: string; minutes?: number }; nextAt?: number | null;
}
/** One entry of the areas file: the areas the owner made an agent responsible for, each with the duty that watches it, if any. */
export interface AgentAreas { agent: string; areas: { area: string; source?: string; duty?: string | null }[] }

const DAY_MS = 86_400_000;

/** A paused duty; it watches nothing. */
export function pausedDuty(row: DutyRow): boolean {
  return row.paused || row.duty.status === "paused";
}

/**
 * A duty whose runs stopped: not paused, and its next run (`nextAt`, one interval after its last run, or after its creation when it never
 * ran) is more than one more interval past, so nothing ran for over 2 of its intervals. fable auditor's d2 reads stopped runs the same way
 * (~/.pi/agent/agents/fable-auditor/duties/keep-responsibilities.py, 11-26).
 */
export function overdueDuty(row: DutyRow, now: number): boolean {
  const every = row.schedule?.kind === "every" && row.schedule.minutes ? row.schedule.minutes * 60_000 : DAY_MS;
  return !pausedDuty(row) && typeof row.nextAt === "number" && now - row.nextAt > every;
}

/** A duty watches its area only while it is not paused, has a run that measured something (a skipped run measured nothing) and still runs. */
export function liveDuty(row: DutyRow, now = Date.now()): boolean {
  return !pausedDuty(row) && row.runs.some(run => run.verdict !== "skipped") && !overdueDuty(row, now);
}

/**
 * The agents that keep no live duty over their responsibilities: an agent with no live duty, and each area of the areas file whose duty is
 * missing or not live. Each uncovered agent gets one `uncovered_agent` flag that names it and its uncovered areas, so the duty job can tell it.
 */
export function dutyCoverage(agents: readonly { agent: Agent; duties: readonly DutyRow[]; brief?: string; asks?: readonly Ask[] }[], areas: readonly AgentAreas[] = [], now = Date.now()): { metrics: Record<string, number>; flagged: Flag[] } {
  const flagged: Flag[] = [];
  let uncoveredAgents = 0;
  let uncoveredAreas = 0;
  let noArea = 0;
  let paused = 0;
  let overdue = 0;
  for (const { agent, duties, brief, asks = [] } of agents) {
    for (const row of duties) {
      if (pausedDuty(row)) {
        paused += 1;
        flagged.push({ kind: "duty_paused", sig: `${agent.id}/${row.duty.id}/paused`, item: agent.id, excerpt: `${agent.name} ${row.duty.id} "${row.duty.name}" is paused` });
      } else if (overdueDuty(row, now)) {
        overdue += 1;
        const last = row.runs.find(run => run.verdict !== "skipped")?.at;
        const since = last ? `no run for ${Math.round((now - last) / 3_600_000)} h` : "no run since it was made";
        flagged.push({ kind: "duty_overdue", sig: `${agent.id}/${row.duty.id}/overdue`, item: agent.id, excerpt: `${agent.name} ${row.duty.id} "${row.duty.name}" has ${since}, due ${Math.round((now - row.nextAt!) / 3_600_000)} h ago` });
      }
    }
    const live = duties.filter(row => liveDuty(row, now));
    // An area whose source is "none found" is the file's placeholder for an agent no owner post gave an area, not an ask of his.
    const given = areas.filter(entry => entry.agent === agent.id || entry.agent === agent.name).flatMap(entry => entry.areas).filter(area => area.source?.trim().toLowerCase() !== "none found");
    // No brief, no area in the file and no ongoing ask of the owner means no area, whatever duties another job gave it: on 11-26 d7's own
    // duty job gave feature probe an Area review and a 180 min check-in, and feature probe then read as covered.
    if (given.length === 0 && !brief?.trim() && asks.length === 0) {
      noArea += 1;
      flagged.push({ kind: "no_area", sig: `${agent.id}/no-area`, item: agent.id, excerpt: `${agent.name} (${agent.id}) has no brief and no area from the owner, so it owns nothing to watch` });
      continue;
    }
    const missed = given.filter(area => !area.duty || !live.some(row => row.duty.id === area.duty || row.duty.name === area.duty));
    uncoveredAreas += missed.length;
    if (live.length > 0 && missed.length === 0) continue;
    uncoveredAgents += 1;
    const notLive = duties.filter(row => !liveDuty(row, now)).map(row => `${row.duty.id} ${pausedDuty(row) ? "paused" : overdueDuty(row, now) ? "overdue" : "never ran"}`);
    const why = [
      ...live.length === 0 ? [duties.length === 0 ? "no duty" : `no live duty (${notLive.join(", ")})`] : [],
      ...missed.map(area => `area "${area.area.slice(0, 100)}"${area.source ? ` (${area.source})` : ""} ${area.duty ? `has duty ${area.duty}, not live` : "has no duty"}`),
    ];
    flagged.push({ kind: "uncovered_agent", sig: `${agent.id}/duties`, item: agent.id, excerpt: `${agent.name} (${agent.id}): ${why.join("; ")}` });
  }
  return { metrics: { agents_uncovered: uncoveredAgents, areas_uncovered: uncoveredAreas, agents_without_area: noArea, duties_paused: paused, duties_overdue: overdue }, flagged };
}

/** The daily area review every agent keeps by the owner's c249 (#sw-factory-build p234, msg mwwklmfk); duty-rule seeds it by this name. */
export const AREA_REVIEW = "Area review";
/** c249's board push runs every 3 hours: the agent's check-in at 180 min or less. */
export const PUSH_MAX_MS = 180 * 60_000;
/** The readings area-review.ts writes for the agent's own wiki pages and memory changed in the last 24 h. */
export const REVIEW_READINGS = ["wiki_pages_touched_24h", "memory_changed_24h"] as const;
/** When the shared Area review precheck began to write n: release-11e4c28 of apps/chat went live at 2026-11-25 20:54Z. */
export const AREA_REVIEW_N_SINCE = Date.parse("2026-11-25T20:54:00Z");

/** An agent's check-in: `everyMs` is its interval now (daily while its plan is empty), `planEveryMs` the interval it keeps for a plan. */
export interface PushRead { everyMs: number; planEveryMs?: number; paused: boolean; lastAt: number | null; runs?: { at: number }[] }
export interface AgentRead {
  agent: Agent; duties: readonly DutyRow[]; brief?: string; checkIn?: PushRead; stuck?: number; boardAt?: number | null;
  /** Since when the plan has surely held an open step (`planOpenSince`), null with none; the check-in's shorter interval counts from here. */
  planOpenAt?: number | null;
  /** The owner's posts to the agent since its brief that may ask for ongoing care (`asksTo`): candidates until the sorted-asks file decides them. */
  asks?: readonly Ask[];
  /** Per paused duty id, since when it is paused (the duty's `updatedAt` in its duties file) and the sentence that gives its reason, if any. */
  pauses?: Readonly<Record<string, { since: number; reason?: string }>>;
  /** Per duty id, the sample size its newest measured run's detail file names (`sampleSize`), or null when the file names none. */
  samples?: Readonly<Record<string, number | null>>;
  /**
   * The duty ids whose newest measured run's detail file flags an `outside_wait` item: the agent named a wait on the owner, so its n = 0 is
   * nothing for it to fix. On 11-26 VP of GTM's d1 waited on his For you todos t2, t3 and t4, and d7 flagged it met_on_zero.
   */
  waitsOutside?: readonly string[];
  /** Per duty id, the hand-off sigs of each of its runs that named a job, with that job's id, one list per run (`duplicateJobs`). */
  handOffJobs?: Readonly<Record<string, readonly HandOffRun[]>>;
  /** Per duty id, whether its newest measured run's detail file holds the precheck's JSON output; absent when that was not read. */
  outputs?: Readonly<Record<string, boolean>>;
}
/** An owner post to an agent: `ref` is "#room pN", `ids` the Prime message ids its inputs carried, which an agent quotes as "msg <id>". */
export interface Ask { ref: string; ids: readonly string[]; at: number; text: string }

/** A duty run that named a job, the id of that job, and the hand-off sigs the run gave. */
export interface HandOffRun { at: number; job?: string; sigs: readonly string[] }

/**
 * The hand-off sigs that more than one job of a duty got, with how many distinct jobs: the duty runner's bug, not the agent's, so it nudges
 * nobody. Before 11-26 a run handed the same daily sig to a new job on every rerun (server/duty-run.ts `measure`). A verify or busy run
 * names the job still at work, so runs are counted by job id: counting runs read 179 on 11-26 against 57 real repeats. Only a repeat in the
 * day before `now` counts: the runner fix of 11-26 (f5da1af2) left 63 old repeats in stored history, which kept the reading from falling.
 */
export function duplicateJobs(runs: readonly HandOffRun[], now: number): [string, number][] {
  // A job counts twice only within a day of the last run for its sig: a page Wiki tidiness still flags the next day is a new day's work.
  const last = new Map<string, number>();
  const jobs = new Map<string, Set<string>>();
  const counts = new Map<string, number>();
  for (const run of [...runs].sort((a, b) => a.at - b.at)) {
    for (const sig of new Set(run.sigs)) {
      const before = last.get(sig);
      const ids = before !== undefined && run.at - before < DAY_MS ? jobs.get(sig)! : new Set<string>();
      ids.add(run.job ?? `run@${run.at}`);
      jobs.set(sig, ids);
      if (ids.size > 1 && now - run.at < DAY_MS) counts.set(sig, Math.max(counts.get(sig) ?? 0, ids.size));
      last.set(sig, run.at);
    }
  }
  return [...counts].filter(([, count]) => count > 1);
}

/**
 * Words of an owner post that ask for ongoing care rather than one task (fable auditor's 11-26 audit; the owner's p25 "keep watching").
 * A bare "keep" or "monitor" read 18 asks on 11-26, among them "keep it this way" and "cosmetics monitor 가 200$/m", so each word needs
 * the verb form around it. A time word that only names a duty or the review asks for nothing: on 11-28 "ideal shape for daily duties?"
 * (#sw-factory-build p250, a design question) read as an ask. It still counts when the post approves the duty ("weekly duty sound good",
 * p245) or asks to set one up ("make this a daily duty").
 */
const EVERY = "(daily|every ?day|each day|every morning|every week|weekly)";
export const ONGOING = new RegExp([
  "\\bkeep (watching|monitoring|checking|tracking|advising|reviewing|an eye)\\b",
  `\\b${EVERY}\\b(?! (dut(y|ies)|reviews?)\\b)`, `(?<!\\b(the|your|their|its) )\\b${EVERY} reviews?\\b`,
  `\\b${EVERY} duty (sounds?|looks?|seems?|would be|works) (good|great|fine|ok|okay)\\b`, `\\b(add|make|set ?up|create|start|need|want)\\b[^.?!\\n]{0,24}\\ba ${EVERY} duty\\b`,
  "\\b(watch|monitor|review|track)(ing)? (this|it|that|the|them|our|all|every|each|for|over)\\b", "\\b(should|must) always\\b|\\balways be\\b",
  "계속 ?(확인|관찰|감시|모니터|봐|지켜)", "매일", "관찰", "감시", "항상",
].join("|"), "i");
export const ongoingAsk = (text: string): boolean => ONGOING.test(text);

/** One sorted owner post: `ref` is "#room pN" as the precheck prints it, `msg` one of its Prime message ids, which still matches after a room is renamed. */
export interface SortedAsk { ref: string; msg?: string; why?: string }
/**
 * The sorted-asks file, ~/work/agent-duties/asks.json. The `ONGOING` words cannot tell "make this chart daily" from "check this daily": on
 * 11-28 they read #sw-factory-build p250, a design question, and #1124-cost-management p33, a one-time chart change, as ongoing asks, and p33
 * put its room's three members off the pattern. So a match is a candidate, and d7's duty job reads each post and sorts it here, as d4's job
 * sorts style notes in ~/work/owner-style/notes.json. `standing` holds the asks for ongoing care, each with the one agent it is for (id or
 * name); `one_time` holds the posts that only read like one.
 */
export interface SortedAsks { standing: readonly (SortedAsk & { agent: string })[]; one_time: readonly SortedAsk[] }
export const NO_SORTED_ASKS: SortedAsks = { standing: [], one_time: [] };
/** The entry that names the ask, by its ref or by one of its message ids. */
export const sortedAs = <E extends SortedAsk>(ask: Ask, entries: readonly E[]): E | undefined =>
  entries.find(entry => entry.ref === ask.ref || (entry.msg !== undefined && ask.ids.includes(entry.msg)));

/** The sorted-asks file, or empty lists when it is absent. Any other shape throws, so a bad write never reads as sorted. */
export function readAsks(file: string): SortedAsks {
  if (!existsSync(file)) return NO_SORTED_ASKS;
  const data = JSON.parse(readFileSync(file, "utf8")) as { standing?: unknown; one_time?: unknown } | null;
  const entries = (list: unknown, agent: boolean): boolean => Array.isArray(list) && list.every((entry: Partial<SortedAsk & { agent: unknown }> | null) =>
    typeof entry?.ref === "string" && (entry.msg === undefined || typeof entry.msg === "string") && (!agent || typeof entry.agent === "string"));
  if (!data || !entries(data.standing, true) || !entries(data.one_time, false)) throw new Error(`${file} is not {standing: [{ref, msg, agent, why}], one_time: [{ref, msg, why}]}`);
  return data as SortedAsks;
}

const squash = (text: string): string => text.toLowerCase().replace(/\s+/g, " ").trim();

/** Whether a duty names the ask: its message id, its "#room pN" ref or its first 40 characters, in the duty's name, owner words or goal. */
export function askHeld(ask: Ask, duties: readonly DutyRow[]): boolean {
  return askHolder(ask, duties) !== undefined;
}

/** The first duty that names the ask, as `askHeld` reads it. */
export function askHolder<R extends DutyRow>(ask: Ask, duties: readonly R[]): R | undefined {
  const [room, post] = ask.ref.replace(/^#/, "").split(" ");
  const ref = new RegExp(`${room!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\W+${post}\\b`, "i");
  const quote = squash(ask.text).slice(0, 40);
  return duties.find(row => {
    const text = [row.duty.name, row.duty.ownerWords ?? "", row.duty.goal ?? ""].join("\n");
    return ask.ids.some(id => text.includes(id)) || ref.test(text) || (quote.length >= 20 && squash(text).includes(quote));
  });
}

/** A pause reason that names a condition a run can recheck, such as "until the paid proxy is back". */
export const PAUSE_CONDITION = /\b(until|till|while|once|when|after|unless)\b|까지/i;
/**
 * A pause to recheck: one older than a day whose reason names a condition, since the condition may hold by now (Crawler guy's d6, d8 and
 * d9 stayed paused about 45 h after the paid proxy came back, fable auditor 11-26), else one older than 7 days.
 */
export function stalePause(pause: { since: number; reason?: string }, now: number): boolean {
  return now - pause.since > (pause.reason && PAUSE_CONDITION.test(pause.reason) ? DAY_MS : 7 * DAY_MS);
}

/**
 * The sample size a run's detail file names: its `n`, or the largest value of an `n` object per metric. A met run on 0 samples measured
 * nothing, as mcp's d1 read 100% success on 6 of 7 days with no customer call (fable auditor 11-26). Each metric of an object counts on its
 * own, so a metric with no input is covered when another one measured something: mcp's quiet_day_checks_failing on a day with no customer
 * call, or fable auditor's sweep in a quiet 3 h with no owner post that still read 18 agents. Null when the detail names no `n`.
 */
export function sampleSize(detail: unknown): number | null {
  const n = (detail as { n?: unknown } | null)?.n;
  if (typeof n === "number" && Number.isFinite(n)) return n;
  if (n && typeof n === "object") {
    const values = Object.values(n).filter((value): value is number => typeof value === "number" && Number.isFinite(value));
    if (values.length) return Math.max(...values);
  }
  return null;
}

/**
 * The misses of earlier d7 runs at least a day old that the current run still flags, with no job of their agent at work since: the sig of
 * each, so a miss counts once however many runs flagged it. `jobsAt` holds, per agent, the times its jobs and duty jobs last worked.
 */
export function unfixedMisses(earlier: readonly { at: number; flagged: readonly Flag[] }[], current: readonly Flag[], jobsAt: ReadonlyMap<string, readonly number[]>, now: number): Flag[] {
  const firstSeen = new Map<string, number>();
  for (const run of earlier) {
    if (now - run.at < DAY_MS) continue;
    for (const flag of run.flagged) if (flag.item?.startsWith("ag_") && (firstSeen.get(flag.sig) ?? Infinity) > run.at) firstSeen.set(flag.sig, run.at);
  }
  return current.filter(flag => {
    const since = firstSeen.get(flag.sig);
    return since !== undefined && !(jobsAt.get(flag.item!) ?? []).some(at => at > since);
  });
}
/** A nudge for the work thread's relay, in the shape of ~/work/agent-duties/messages.json. */
export interface Nudge { agent: string; name: string; workThreadId: string | null; text: string }

/** Flag kinds that mean the agent itself has to act, each named in its nudge. */
const NUDGE_KINDS = new Set(["uncovered_agent", "duty_paused", "duty_overdue", "common_missing", "common_late", "empty_run", "ask_unheld", "pause_stale", "met_on_zero", "no_sample_size"]);
/**
 * The kinds that put an agent off the pattern. A missing sample size n is left out: on 11-26 no precheck wrote n yet, so all 18 agents read
 * off the pattern on it alone and hid the real misses; runs_without_n is a metric of its own.
 */
const OFF_PATTERN_KINDS = new Set([...NUDGE_KINDS].filter(kind => kind !== "no_sample_size"));

/**
 * Agent factory's meta check of c249: every live agent with an area keeps a 3-hourly board push (its check-in) and a daily "Area review"
 * duty, both run on time and produce work, no duty is paused or overdue, and a live duty covers each area it was given (`dutyCoverage`).
 * A board push is empty when the board has stuck steps and has not changed in 24 h. An area review run is empty when it started no job
 * and its readings (`REVIEW_READINGS`) are 0. Each agent off the pattern gets one nudge listing its misses.
 */
export function agentPattern(agents: readonly AgentRead[], areas: readonly AgentAreas[] = [], now = Date.now(), sorted: SortedAsks = NO_SORTED_ASKS): { metrics: Record<string, number>; flagged: Flag[]; messages: Nudge[] } {
  const named = (entry: { agent: string }, agent: Agent): boolean => entry.agent === agent.id || entry.agent === agent.name;
  // An agent's standing asks: the posts the sorted file gives it, and a post in neither list that one of its own duties already names.
  const standing = (read: AgentRead): Ask[] => (read.asks ?? []).filter(ask => {
    const entry = sortedAs(ask, sorted.standing);
    return entry ? named(entry, read.agent) : !sortedAs(ask, sorted.one_time) && askHeld(ask, read.duties);
  });
  const coverage = dutyCoverage(agents.map(read => ({ ...read, asks: standing(read) })), areas, now);
  const flagged = [...coverage.flagged];
  const noArea = new Set(coverage.flagged.filter(flag => flag.kind === "no_area").map(flag => flag.item));
  let missing = 0;
  let late = 0;
  let empty = 0;
  let unheld = 0;
  const unsorted = new Map<string, { ask: Ask; reached: string[] }>();
  let stale = 0;
  let zero = 0;
  let noN = 0;
  let duplicates = 0;
  const everyDuty = agents.flatMap(({ agent, duties }) => duties.map(row => ({ ...row, agent })));
  for (const { agent, duties, checkIn, stuck = 0, boardAt, planOpenAt, asks = [], pauses = {}, samples = {}, waitsOutside = [], outputs = {}, handOffJobs = {} } of agents) {
    for (const row of duties) {
      const repeats = duplicateJobs(handOffJobs[row.duty.id] ?? [], now);
      if (!repeats.length) continue;
      const extra = repeats.reduce((sum, [, jobs]) => sum + jobs - 1, 0);
      duplicates += extra;
      const [sig, jobs] = repeats[0]!;
      flagged.push({ kind: "duplicate_job", sig: `${agent.id}/${row.duty.id}/duplicates`, item: agent.id,
        excerpt: `${agent.name}: ${row.duty.id} "${row.duty.name}" started ${extra} extra jobs for ${repeats.length} hand-off${repeats.length === 1 ? "" : "s"} within a day, such as ${jobs} jobs for ${sig.slice(0, 80)}` });
    }
    const flag = (kind: string, key: string, excerpt: string) => flagged.push({ kind, sig: `${agent.id}/${key}`, item: agent.id, excerpt: `${agent.name}: ${excerpt}` });
    for (const ask of asks) {
      // A one-time post is dropped, and a standing ask counts only for the agent the sorted file names, not for every member of its room.
      const entry = sortedAs(ask, sorted.standing);
      if (entry ? !named(entry, agent) : sortedAs(ask, sorted.one_time) !== undefined) continue;
      if (askHeld(ask, duties)) continue;
      // An ask another agent's live duty holds is held: on 11-26 product analytics bot's d3 "API portal usage" quoted #api-portal-outreach p1,
      // which d7 had given to VP of GTM and API portal as members of that room.
      const other = askHolder(ask, everyDuty.filter(entry => entry.agent.id !== agent.id && liveDuty(entry, now)));
      if (other) {
        flag("ask_held_elsewhere", `ask/${ask.ref}`, `the owner's ongoing ask ${ask.ref} is held by ${other.agent.name}'s ${other.duty.id} "${other.duty.name}"`);
        continue;
      }
      if (!entry) {
        // In neither list and named by no duty: a candidate for the duty job to sort, which puts no agent off the pattern.
        unsorted.set(ask.ref, { ask, reached: [...unsorted.get(ask.ref)?.reached ?? [], agent.name] });
        continue;
      }
      unheld += 1;
      flag("ask_unheld", `ask/${ask.ref}`, `the owner's ongoing ask ${ask.ref}${ask.ids[0] ? ` (msg ${ask.ids.at(-1)})` : ""}, "${squash(ask.text).slice(0, 140)}", is named by no duty`);
    }
    if (noArea.has(agent.id)) continue;
    for (const row of duties) {
      const pause = pauses[row.duty.id];
      if (pausedDuty(row) && pause && stalePause(pause, now)) {
        stale += 1;
        flag("pause_stale", `${row.duty.id}/pause`, `${row.duty.id} "${row.duty.name}" has been paused ${Math.round((now - pause.since) / 3_600_000)} h${pause.reason ? ` for "${pause.reason.slice(0, 120)}"; check whether that still holds` : " with no reason on record; recheck it"}`);
      }
      if (pausedDuty(row) || !(row.duty.id in samples)) continue;
      const n = samples[row.duty.id];
      const newest = row.runs.find(run => run.verdict !== "skipped");
      // The shared Area review precheck writes n since release-11e4c28, live at 2026-11-25 20:54Z; an older review run cannot hold it.
      if (n === null && row.duty.name === AREA_REVIEW && (newest?.at ?? 0) < AREA_REVIEW_N_SINCE) continue;
      if (n === null) {
        noN += 1;
        flag("no_sample_size", `${row.duty.id}/n`, `${row.duty.id} "${row.duty.name}" writes no sample size n in its precheck output, so a met run on no input looks green`);
      } else if (n === 0 && !waitsOutside.includes(row.duty.id) && row.runs.find(run => run.verdict !== "skipped")?.verdict === "met") {
        zero += 1;
        flag("met_on_zero", `${row.duty.id}/n0`, `${row.duty.id} "${row.duty.name}" read met on n = 0, so it measured nothing`);
      }
    }
    if (!checkIn) continue;
    const pushMs = checkIn.planEveryMs ?? checkIn.everyMs;
    if (checkIn.paused || pushMs > PUSH_MAX_MS) {
      missing += 1;
      flag("common_missing", "push", checkIn.paused ? "its check-in, the 3-hourly board push, is paused" : `its check-in, the board push, runs every ${Math.round(pushMs / 60_000)} min, not every 180 min or less`);
    } else {
      const newest = checkIn.runs?.[0]?.at ?? checkIn.lastAt;
      if (newest === null || now - Math.max(newest, planOpenAt ?? 0) > 2 * checkIn.everyMs) {
        late += 1;
        flag("common_late", "push/late", newest === null ? "its check-in has never run" : `its check-in last ran ${Math.round((now - newest) / 3_600_000)} h ago on a ${Math.round(checkIn.everyMs / 60_000)} min interval`);
      }
      if (stuck > 0 && (boardAt === null || boardAt === undefined || now - boardAt > DAY_MS)) {
        empty += 1;
        flag("empty_run", "push/empty", `its board push left ${stuck} stuck steps and the board has not changed in 24 h`);
      }
    }
    const review = duties.find(row => row.duty.name.trim().toLowerCase() === AREA_REVIEW.toLowerCase());
    if (!review) {
      missing += 1;
      flag("common_missing", "review", `it has no daily "${AREA_REVIEW}" duty`);
      continue;
    }
    if (pausedDuty(review) || overdueDuty(review, now)) continue; // flagged as duty_paused or duty_overdue
    const run = review.runs.find(item => item.verdict !== "skipped");
    if (!run) continue; // a review that never ran is new, and turns overdue after 2 days
    if (run.hostAway) continue; // the agent's box was away, so the run measured nothing and reruns once the box is back
    // A run that wrote no output measured nothing, even when the run started a job to fix it: on 11-26 every agent's first Area review
    // failed with "no valid JSON in OUTPUT_FILE" (the precheck's main guard missed the current symlink) and still showed a job.
    if (run.verdict === "error" || !Object.keys(run.metrics ?? {}).length || outputs[review.duty.id] === false) {
      empty += 1;
      flag("empty_run", `review/${review.duty.id}/empty`, `its ${review.duty.id} "${review.duty.name}" wrote no output${run.verdict === "error" ? " (the precheck failed)" : ""}, so it reviewed nothing`);
      continue;
    }
    const readings = REVIEW_READINGS.reduce((sum, key) => sum + (run.readings?.[key] ?? run.metrics?.[key]?.value ?? 0), 0);
    if (!run.job && readings === 0) {
      empty += 1;
      flag("empty_run", `review/${review.duty.id}/empty`, `its ${review.duty.id} "${review.duty.name}" ran with no job, no wiki page and no memory change`);
    }
  }
  for (const [ref, { ask, reached }] of unsorted) {
    flagged.push({ kind: "ask_unsorted", sig: `ask-unsorted/${ref}`, handOff: true,
      excerpt: `the owner's post ${ref}${ask.ids[0] ? ` (msg ${ask.ids.at(-1)})` : ""} may ask for ongoing care and the sorted-asks file names it in neither list; it reached ${reached.join(", ")}: "${squash(ask.text).slice(0, 300)}"` });
  }
  const messages: Nudge[] = [];
  for (const { agent } of agents) {
    const misses = flagged.filter(flag => flag.item === agent.id && NUDGE_KINDS.has(flag.kind)).map(flag => flag.excerpt.replace(/^[^:]*:\s*/, ""));
    if (!misses.length) continue;
    messages.push({
      agent: agent.id, name: agent.name, workThreadId: agent.thread ?? null,
      text: [`${agent.name}, the owner wants every agent to keep two common duties (#sw-factory-build p234, c249): a board push every 3 hours that moves the open steps on your board, which is your check-in at 180 min, and a daily "${AREA_REVIEW}" that watches your area, acts on issues, cleans up and updates your llm-wiki pages and agent files. Each has to run on time and produce work, no duty stays paused or overdue, and a duty covers each area he gave you. Today's check found:`,
        ...misses.map((miss, at) => `${at + 1}. ${miss}`), "Please fix each one yourself, then reply with what you changed and the duty ids."].join("\n"),
    });
  }
  return {
    metrics: {
      agents_off_pattern: new Set(flagged.filter(flag => OFF_PATTERN_KINDS.has(flag.kind)).map(flag => flag.item)).size, common_duties_missing: missing, common_duties_late: late, empty_runs: empty, ...coverage.metrics,
      asks_unheld: unheld, asks_unsorted: unsorted.size, pauses_stale: stale, met_on_zero: zero, runs_without_n: noN, duplicate_jobs: duplicates,
      duties_stopped: coverage.metrics.duties_paused! + coverage.metrics.duties_overdue!,
    },
    flagged, messages,
  };
}

/** A path segment that carries a date or a session, job or run stamp, such as `queue-waits-2026-10-15.html` or `d7-261126-052811`. */
export const DATED = /20\d\d-\d\d-\d\d|^20\d\d[-_]?\d\d[-_]?\d\d|\d{6}[-_]\d{4,6}|(?:session|job|run)[-_]?\d{3,}/i;
/**
 * Folders under the wiki's agents/ mount that belong to no sw factory agent and are no clutter: the template new agents copy, and
 * harness-keeper, a Prime standing agent that keeps its folder here and is not in GET /api/agents.
 */
export const AGENT_FOLDERS_KEPT = new Set(["TEMPLATE", "harness-keeper"]);
/** A moved page's redirect stub (apps/wiki movePage): the page left, and the tree shows no row for it. */
const REDIRECT_STUB = /^<!--wiki\s*\{[^\n]*"moved_to"\s*:/;
/** The curated wiki folders read for dated pages; experiments/ is left out, because its folders start with a date by design. */
export const CURATED_FOLDERS = ["apps", "domains", "projects"] as const;

/**
 * Wiki clutter by the owner's #sw-factory-build p237 (msg mwwksq7v, 11-26): "agents folder full of slop clean up". It counts the folders
 * under agents/ that belong to no live agent (test, deleted and throwaway blind agents), and the dated one-off pages in the curated folders
 * that no curated page links to. A dated unit is a page path cut after its first dated segment, so a dated folder counts once; it is linked
 * when a page that is not itself dated and lies outside the unit names the unit's last segment, as an href or a wiki: link does.
 */
export function wikiClutter(agentFolders: readonly string[], liveSlugs: ReadonlySet<string>, pages: readonly { path: string; text: string }[]): { metrics: Record<string, number>; flagged: Flag[] } {
  const flagged: Flag[] = [];
  const orphans = agentFolders.filter(name => !name.startsWith(".") && !AGENT_FOLDERS_KEPT.has(name) && !liveSlugs.has(name)).sort();
  for (const name of orphans) flagged.push({ kind: "orphan_agent_folder", sig: `agents/${name}`, item: `agents/${name}`, excerpt: `agents/${name}/ belongs to no live agent` });
  const unitOf = (path: string): string | null => {
    const parts = path.split("/");
    const at = parts.findIndex((part, index) => index > 0 && DATED.test(part));
    return at < 0 ? null : parts.slice(0, at + 1).join("/");
  };
  const units = new Map<string, string[]>();
  for (const page of pages) {
    const unit = unitOf(page.path);
    if (unit && !REDIRECT_STUB.test(page.text)) units.set(unit, [...units.get(unit) ?? [], page.path]);
  }
  const curated = pages.filter(page => !unitOf(page.path));
  let dated = 0;
  for (const [unit, inside] of [...units].sort(([a], [b]) => a.localeCompare(b))) {
    const name = unit.split("/").at(-1)!.replace(/\.(html|md)$/, "");
    const named = new RegExp(`${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`);
    if (curated.some(page => named.test(page.text))) continue;
    dated += 1;
    flagged.push({ kind: "dated_page", sig: unit, item: unit, excerpt: `${unit}${inside.length > 1 ? ` (${inside.length} pages)` : ""} is a dated one-off page that no curated page links to` });
  }
  return { metrics: { wiki_clutter: orphans.length + dated, orphan_agent_folders: orphans.length, dated_pages: dated }, flagged };
}

/** The wiki on this box from ~/.config/sieun-pi/wiki.json: its agents/ folders and the curated pages (html and md) under `CURATED_FOLDERS`. */
export function readWiki(configFile: string): { agentFolders: string[]; pages: { path: string; text: string }[] } {
  const config = JSON.parse(readFileSync(configFile, "utf8")) as { contentRoot: string; mounts?: { agents?: string } };
  const agentsDir = config.mounts?.agents ?? join(config.contentRoot, "agents");
  const agentFolders = readdirSync(agentsDir, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name);
  const pages: { path: string; text: string }[] = [];
  for (const folder of CURATED_FOLDERS) {
    const dir = join(config.contentRoot, folder);
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile() || !/\.(html|md)$/.test(entry.name)) continue;
      const file = join(entry.parentPath, entry.name);
      pages.push({ path: relative(config.contentRoot, file), text: readFileSync(file, "utf8") });
    }
  }
  pages.push(...["index.html", "index.md"].filter(name => existsSync(join(config.contentRoot, name))).map(name => ({ path: name, text: readFileSync(join(config.contentRoot, name), "utf8") })));
  return { agentFolders, pages };
}

/**
 * The areas file, or none when it is absent. It is a list of `{agent, areas}`, or an object keyed by agent id or name whose value holds
 * `areas` and `missing` lists of `{area, source, duty?}` (the duty gaps job's 11-26 file); keys that start with "_" are notes. Any other
 * shape throws, so a typo never reads as covered.
 */
export function readAreas(file: string): AgentAreas[] {
  if (!existsSync(file)) return [];
  const data: unknown = JSON.parse(readFileSync(file, "utf8"));
  const entries: unknown[] = Array.isArray(data) ? data : data && typeof data === "object"
    ? Object.entries(data).filter(([key]) => !key.startsWith("_")).map(([agent, value]) => {
      const { areas, missing } = (value ?? {}) as { areas?: unknown; missing?: unknown };
      if (!Array.isArray(areas) && !Array.isArray(missing)) return null;
      return { agent, areas: [...Array.isArray(areas) ? areas : [], ...Array.isArray(missing) ? missing : []] };
    })
    : [];
  const valid = (entry: unknown): entry is AgentAreas => typeof (entry as AgentAreas)?.agent === "string" && Array.isArray((entry as AgentAreas).areas)
    && (entry as AgentAreas).areas.every(area => typeof area?.area === "string");
  if ((!Array.isArray(data) && (!data || typeof data !== "object")) || !entries.every(valid)) {
    throw new Error(`${file} is not a list of {agent, areas: [{area, source, duty}]} or an object of agent: {areas, missing}`);
  }
  return entries as AgentAreas[];
}

/** Prime's late rule (checkin-schedule.ts): a check-in with no run in 1.5 intervals is late. */
export const LATE_INTERVALS = 1.5;

/** `handOff` gives the item to the duty job, once a day per sig (server/duty-run.ts `measure`). */
export interface Flag { kind: string; sig: string; item?: string; excerpt: string; handOff?: true }

/** The precheck output for the agents' steps and check-ins read at `now`; `n` is the count of agents it read. */
export function agentBoards(agents: readonly { agent: Agent; steps: Steps; checkIn: CheckIn; planOpenAt?: number | null }[], now: number): { n: number; metrics: Record<string, number>; flagged: Flag[] } {
  const flagged: Flag[] = [];
  let open = 0;
  let stuck = 0;
  let gaps = 0;
  let late = 0;
  for (const { agent, steps, checkIn, planOpenAt } of agents) {
    open += steps.open;
    stuck += steps.stuck.length;
    gaps += steps.gaps.length;
    for (const step of steps.stuck) {
      const why = [step.job ? `job ${step.job} not at work` : "no job", ...step.waitFor ? [`waits for "${step.waitFor}"`] : [], ...step.waitUntil ? [`waits until ${step.waitUntil}`] : []];
      flagged.push({ kind: "stuck_step", sig: `${agent.id}/${step.id}`, item: step.id, excerpt: `${agent.name} ${step.id} "${step.text.slice(0, 120)}" ${step.status}: ${why.join(", ")}` });
    }
    for (const goal of steps.gaps) flagged.push({ kind: "goal_gap", sig: `${agent.id}/${goal.id}`, item: goal.id, excerpt: `${agent.name} ${goal.id} "${goal.text.slice(0, 120)}" is short of its target and no live job owns it` });
    const newest = checkIn.runs?.[0]?.at ?? checkIn.lastAt;
    if (!checkIn.paused && newest !== null && now - Math.max(newest, planOpenAt ?? 0) > LATE_INTERVALS * checkIn.everyMs) {
      late += 1;
      flagged.push({ kind: "checkin_late", sig: `${agent.id}/checkin/${newest}`, excerpt: `${agent.name}'s check-in last ran ${Math.round((now - newest) / 60_000)} min ago on a ${Math.round(checkIn.everyMs / 60_000)} min interval` });
    }
  }
  return { n: agents.length, metrics: { stuck_steps_all: stuck, goal_gaps_all: gaps, checkins_late: late, open_steps_all: open }, flagged };
}

/** An agent's board as GET /board returns it, the fields `pauseReason` reads. */
interface BoardRead { updatedAt?: string; plan?: (Partial<FixStep> & { children?: unknown[] })[]; todos?: { text?: string; note?: string }[] }

/** Every step of a plan, parents and children, in one list. */
export function planSteps(board: BoardRead | undefined): FixStep[] {
  const steps: FixStep[] = [];
  const walk = (items: NonNullable<BoardRead["plan"]> = []) => {
    for (const item of items) {
      if (item.id) steps.push({ ...item, id: item.id });
      walk(item.children as typeof items | undefined);
    }
  };
  walk(board?.plan);
  return steps;
}

/** The step statuses that keep a plan open (server/check-in-job.ts `planHasOpenStep`). */
const OPEN_STEP = new Set(["todo", "doing", "blocked"]);
/**
 * Since when the plan has surely held an open step: the oldest `updatedAt` among its open steps, 0 when one carries none, null with no open
 * step. The server runs the check-in daily while the plan has no open step and at its set interval from the moment one opens
 * (server/check-in-job.ts `planEveryMs`), so a check-in is late only when no run came in that interval's allowance after the later of its
 * last run and this time. On 11-28 at 19:55:30 KST fable auditor's plan got its first open step 13 h after its daily check-in; d7 read the
 * check-in 18 s before the server's next tick ran it and flagged "last ran 13 h ago on a 180 min interval".
 */
export function planOpenSince(board: BoardRead | undefined): number | null {
  let since: number | null = null;
  const walk = (steps: NonNullable<BoardRead["plan"]> = []) => {
    for (const step of steps) {
      if (OPEN_STEP.has(step.status ?? "")) since = Math.min(since ?? Infinity, (step.updatedAt && Date.parse(step.updatedAt)) || 0);
      walk(step.children as typeof steps | undefined);
    }
  };
  walk(board?.plan);
  return since;
}

/** A JSON file, or undefined when it is absent or not JSON. */
function readJson<T = unknown>(file: string): T | undefined {
  try { return JSON.parse(readFileSync(file, "utf8")) as T; } catch { return undefined; }
}

/** The first sentence of the agent's board or the duty's goal that names the pause and the duty, by its id or name. */
export function pauseReason(row: DutyRow, board: BoardRead | undefined): string | undefined {
  const texts: string[] = [];
  const walk = (steps: readonly { text?: string; note?: string; children?: unknown[] }[] = []) => {
    for (const step of steps) {
      texts.push(step.text ?? "", step.note ?? "");
      walk(step.children as typeof steps | undefined);
    }
  };
  walk(board?.plan);
  for (const todo of board?.todos ?? []) texts.push(todo.text ?? "", todo.note ?? "");
  texts.push(row.duty.goal ?? "");
  const id = new RegExp(`\\b${row.duty.id}\\b`);
  for (const sentence of texts.flatMap(text => text.split(/(?<=[.!?])\s+/))) {
    if (/paus/i.test(sentence) && (id.test(sentence) || sentence.includes(row.duty.name))) return sentence.trim();
  }
  return undefined;
}

/**
 * The owner's posts to an agent since `since` that may ask for ongoing care: his DM posts and the group posts that tag it, or reach it
 * untagged as a member, whose words match `ONGOING`. A post one of the `given` entries names, the standing asks the sorted file gives this
 * agent, counts in any real room whatever its words, tags and members: the agent an ask is for may sit outside the room it was posted in.
 */
export function asksTo(store: { rooms: { rooms: readonly unknown[] }; postsOf(room: string): readonly unknown[] }, agent: Agent, since: number, given: readonly SortedAsk[] = []): Ask[] {
  const asks: Ask[] = [];
  for (const room of store.rooms.rooms as { id: string; kind: string; agent?: string; name?: string; test?: true; archived: boolean; members?: { agent: string; wakeOn: string }[] }[]) {
    if (room.test || room.archived) continue;
    const dm = room.kind === "dm";
    const member = dm ? room.agent === agent.id : room.members?.some(entry => entry.agent === agent.id) ?? false;
    if (!member && !given.length) continue;
    for (const post of store.postsOf(room.id) as { id: string; author: string; text?: string; at: number; deletedAt?: number; mentions?: string[]; inputs?: { at: number }[] }[]) {
      if (post.author !== "owner" || post.deletedAt !== undefined || post.at <= since) continue;
      const ask: Ask = { ref: `${dm ? room.id : `#${room.name ?? room.id}`} ${post.id}`, ids: (post.inputs ?? []).map(input => input.at.toString(36)), at: post.at, text: post.text ?? "" };
      if (!sortedAs(ask, given)) {
        if (!member || !ongoingAsk(ask.text)) continue;
        const tagged = (post.mentions ?? []).filter(id => id !== "owner");
        if (!dm && tagged.length && !tagged.includes(agent.id)) continue;
      }
      asks.push(ask);
    }
  }
  return asks;
}

/**
 * Each metric of an agent's duties with its readings of the last 15 days, from the duty run files in `dir`, and its closed fix steps. 15
 * days hold the reading before a return at the edge of the 14-day window (duty-health.ts `returnsOf`).
 */
export function metricHistories(agent: Agent, duties: readonly DutyRow[], steps: readonly FixStep[], dir: string, now: number): MetricHistory[] {
  const reads = new Map<string, MetricRead[]>();
  const defs = new Map(duties.map(row => [row.duty.id, row.duty.metrics ?? []]));
  for (const name of existsSync(dir) ? readdirSync(dir) : []) {
    const file = runFile(name);
    const metrics = file && defs.get(file.duty);
    if (!file || !metrics?.length || now - file.at > 15 * DAY_MS) continue;
    for (const [key, read] of Object.entries(readsOf(readJson(join(dir, name)), file.at, metrics))) {
      const id = `${file.duty}/${key}`;
      reads.set(id, [...reads.get(id) ?? [], read]);
    }
  }
  return duties.flatMap(row => (row.duty.metrics ?? []).map(metric => ({
    agent, duty: { id: row.duty.id, name: row.duty.name }, metric: metric.key, reads: reads.get(`${row.duty.id}/${metric.key}`) ?? [], closes: fixCloses(steps, row.duty.id, metric.key),
  })));
}

async function get<T>(server: string, path: string): Promise<T> {
  const res = await fetch(`${server}${path}`);
  if (!res.ok) throw new Error(`GET ${path} answered ${res.status}`);
  return await res.json() as T;
}

if (isMain(import.meta.url)) {
  // `--part boards` (the default, d5 "Agent boards") reads steps and check-ins; `--part duties` (agent factory's "Agents keep their duties")
  // reads each agent's duties, brief and areas.
  const { values } = parseArgs({ options: { server: { type: "string" }, areas: { type: "string" }, asks: { type: "string" }, past: { type: "string" }, returns: { type: "string" }, part: { type: "string" }, wiki: { type: "string" }, "data-dir": { type: "string" } } });
  const part = values.part ?? "boards";
  if (part !== "boards" && part !== "duties") throw new Error(`--part ${part} is neither boards nor duties`);
  const server = values.server ?? process.env.APPS_CHAT_URL ?? "http://127.0.0.1:5184";
  const areasFile = values.areas ?? process.env.AREAS_FILE ?? join(homedir(), "work/agent-duties/areas.json");
  const asksFile = values.asks ?? process.env.ASKS_FILE ?? join(homedir(), "work/agent-duties/asks.json");
  const pastFile = values.past ?? process.env.PAST_FILE ?? join(homedir(), "work/agent-duties/past-problems.json");
  const returnsFile = values.returns ?? process.env.RETURNS_FILE ?? join(homedir(), "work/agent-duties/returns.json");
  const agents = realAgents(await get<Agent[]>(server, "/api/agents")).filter(agent => agent.hostState !== "away");
  const json = part === "boards"
    ? JSON.stringify(agentBoards(await Promise.all(agents.map(async agent => ({
      agent, steps: await get<Steps>(server, `/api/agents/${agent.id}/steps`), checkIn: await get<CheckIn>(server, `/api/agents/${agent.id}/check-in`),
      planOpenAt: planOpenSince((await get<{ board?: BoardRead }>(server, `/api/agents/${agent.id}/board`)).board),
    }))), Date.now()), null, 1)
    : JSON.stringify(await (async () => {
      const now = Date.now();
      const dataDir = values["data-dir"] ?? process.env.APPS_CHAT_DATA_DIR ?? join(homedir(), ".pi/agent/chat");
      const { AgentStore } = await import("../../server/agent-store.ts");
      const store = new AgentStore(dataDir);
      const sorted = readAsks(asksFile);
      // A standing ask given to a name no agent has, an archived one included, would count for nobody: stop, so a typo never reads as held.
      const known = new Set((await get<Agent[]>(server, "/api/agents?archived=1")).flatMap(agent => [agent.id, agent.name]));
      const stray = sorted.standing.filter(entry => !known.has(entry.agent));
      if (stray.length) throw new Error(`${asksFile} gives ${stray.map(entry => `${entry.ref} to "${entry.agent}"`).join(", ")}, which names no agent: use an id or name from GET /api/agents`);
      const reads = await Promise.all(agents.map(async agent => {
        const [board, duties, folder, checkIn, steps, jobs] = await Promise.all([
          get<{ board?: BoardRead }>(server, `/api/agents/${agent.id}/board`).then(answer => answer.board),
          get<{ duties: DutyRow[] }>(server, `/api/agents/${agent.id}/duties`).then(answer => answer.duties),
          // A folder on a box that is away answers 503 (5180 designer's Mac at 06:33 KST 11-26, right after a chat release): read it as unknown.
          get<{ brief?: { text?: string; modifiedAt?: number | null } }>(server, `/api/agents/${agent.id}/folder`).catch(() => null),
          get<PushRead>(server, `/api/agents/${agent.id}/check-in`),
          get<Steps>(server, `/api/agents/${agent.id}/steps`),
          get<{ agents: { lastActivityAt?: string }[] }>(server, `/api/agents/${agent.id}/agents`).then(answer => answer.agents),
        ]);
        const stored = readJson<{ duties?: { id: string; updatedAt?: number }[] }>(join(dataDir, "agents", agent.id, "duties.json"))?.duties ?? [];
        const pauses = Object.fromEntries(duties.filter(pausedDuty).map(row => [row.duty.id, {
          since: stored.find(duty => duty.id === row.duty.id)?.updatedAt ?? now, ...pauseReason(row, board) ? { reason: pauseReason(row, board)! } : {},
        }]));
        // Each run that started a job, with the hand-off sigs it gave: from the record since 11-26, else from its precheck output.
        const handOffJobs = Object.fromEntries(duties.map(row => [row.duty.id, row.runs.filter(run => run.job).map(run => {
          const slices = run.flagged ?? (run.detail?.endsWith(".json") && existsSync(run.detail) ? readJson<{ flagged?: { handOff?: true; sig?: string }[] }>(run.detail)?.flagged : undefined) ?? [];
          return { at: run.at ?? 0, ...(run.job?.id ? { job: run.job.id } : {}), sigs: slices.flatMap(slice => slice.handOff && slice.sig ? [slice.sig] : []) };
        })]));
        const leftOut: Record<string, string> = {};
        const samples: Record<string, number | null> = {};
        const outputs: Record<string, boolean> = {};
        const waitsOutside: string[] = [];
        for (const row of duties) {
          const newest = row.runs.find(run => run.verdict !== "skipped");
          const detail = newest?.detail;
          if (!detail) continue;
          const output = existsSync(detail) ? readJson<{ metrics?: unknown; flagged?: { kind?: string; excerpt?: string }[] }>(detail) : undefined;
          const left = output?.flagged?.find(item => LEFT_OUT_KIND.test(item?.kind ?? ""));
          if (left) leftOut[row.duty.id] = `${left.kind}: ${left.excerpt}`;
          // A run whose box was away measured nothing on purpose; it is neither empty nor met on no input.
          if (newest.hostAway || output?.flagged?.some(item => item?.kind === "host_away")) continue;
          outputs[row.duty.id] = !!output && typeof output.metrics === "object";
          if (outputs[row.duty.id]) samples[row.duty.id] = sampleSize(output);
          if (newest.waitsOn || output?.flagged?.some(item => item?.kind === "outside_wait")) waitsOutside.push(row.duty.id);
        }
        const jobsAt = [...jobs.flatMap(job => job.lastActivityAt ? [Date.parse(job.lastActivityAt)] : []), ...duties.flatMap(row => row.runs.flatMap(run => run.job && run.at ? [run.at] : []))];
        return {
          read: {
            agent, duties, checkIn, stuck: steps.stuck.length, boardAt: board?.updatedAt ? Date.parse(board.updatedAt) : null, planOpenAt: planOpenSince(board), pauses, samples, waitsOutside, outputs, handOffJobs,
            // An unread folder leaves its brief unknown: the agent keeps its area and its asks wait for a run that reads the brief.
            ...folder ? { brief: folder.brief?.text ?? "", asks: asksTo(store, agent, folder.brief?.text?.trim() ? folder.brief.modifiedAt ?? 0 : 0, sorted.standing.filter(entry => entry.agent === agent.id || entry.agent === agent.name)) } : { brief: "(its folder did not answer)", asks: [] },
          } satisfies AgentRead,
          jobsAt, health: { agent, duties, steps: planSteps(board), leftOut },
          histories: metricHistories(agent, duties, planSteps(board), join(dataDir, "agents", agent.id, "duties"), now),
        };
      }));
      const pattern = agentPattern(reads.map(entry => entry.read), readAreas(areasFile), now, sorted);
      // Every agent that is not archived keeps its folder, an away one too; GET /api/agents lists no test agent.
      const live = realAgents(await get<Agent[]>(server, "/api/agents"));
      // A test agent at work now, such as d3's memory-recall agents during its run, is no leftover; one idle for a day is.
      const working = (await get<(Agent & { updatedAt?: number })[]>(server, "/api/agents?test=1")).filter(agent => agent.test && !agent.archived && now - (agent.updatedAt ?? 0) < DAY_MS);
      const slugs = new Set(await Promise.all([...live, ...working].map(async agent => basename((await get<{ dir?: string }>(server, `/api/agents/${agent.id}/folder`).catch(() => null))?.dir ?? agent.id.replace(/^ag_/, "")))));
      const wiki = readWiki(values.wiki ?? process.env.WIKI_CONFIG ?? join(homedir(), ".config/sieun-pi/wiki.json"));
      const clutter = wikiClutter(wiki.agentFolders, slugs, wiki.pages);
      // This duty's own earlier runs, read back from their detail files, for the misses no job took up in a day.
      const own = (await get<{ duties: DutyRow[] }>(server, "/api/agents/ag_agent-factory/duties")).duties.find(row => row.duty.name === "Agents keep their duties");
      const earlier = (own?.runs ?? []).flatMap(run => run.detail && run.at && existsSync(run.detail) ? [{ at: run.at, flagged: readJson<{ flagged?: Flag[] }>(run.detail)?.flagged ?? [] }] : []);
      const unfixed = unfixedMisses(earlier, pattern.flagged, new Map(reads.map(entry => [entry.read.agent.id, entry.jobsAt])), now);
      // Whether the agents' checks and fixes work (duty-health.ts): each past problem replayed, the metrics that came back, the duty system's faults.
      const past = readPastProblems(pastFile);
      const strayPast = past.filter(problem => !known.has(problem.agent));
      if (strayPast.length) throw new Error(`${pastFile} names ${strayPast.map(problem => `"${problem.agent}" (${problem.id})`).join(", ")}, which is no agent: use an id or name from GET /api/agents`);
      const blind = blindChecks(await Promise.all(past.map(async problem => ({ ...problem, replayed: await replay(problem.replay, dirname(pastFile)) }))), agents);
      const returned = returningProblems(reads.flatMap(entry => entry.histories), readReturns(returnsFile), now);
      const system = dutySystemFaults(reads.map(entry => entry.health), now);
      const flagged = [...pattern.flagged, ...blind.flagged, ...returned.flagged, ...system.flagged, ...clutter.flagged, ...unfixed.map(flag => ({ ...flag, kind: "miss_unfixed_24h", sig: `unfixed/${flag.sig}`, excerpt: `${flag.excerpt} (flagged over a day ago, and no job of the agent worked since)` }))];
      return {
        metrics: { ...pattern.metrics, ...blind.metrics, ...returned.metrics, ...system.metrics, ...clutter.metrics, misses_unfixed_24h: unfixed.length },
        // What each counted metric measured: agents, past problems with a replay that ran, metrics with a closed fix step, duties with a run.
        n: { agents_off_pattern: agents.length, checks_blind: blind.n, problems_returned: returned.n, duty_system_faults: system.n }, flagged, messages: pattern.messages,
        areasFile: existsSync(areasFile) ? areasFile : null, asksFile: existsSync(asksFile) ? asksFile : null, pastFile: existsSync(pastFile) ? pastFile : null, returnsFile: existsSync(returnsFile) ? returnsFile : null,
      };
    })(), null, 1);
  if (process.env.OUTPUT_FILE) writeFileSync(process.env.OUTPUT_FILE, json);
  else console.log(json);
}
