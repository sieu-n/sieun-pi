import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { JobFact, StepView } from "./checkin-steps.ts";
import { type Wake, wakeLabel } from "./wakes.ts";
import type { PlanItem } from "./shared/types.ts";

/*
 * Work spread and stale timers (owner 10-12, c51): "you seem to be using waaay too much on that ONE old session when it will be so much more
 * efficient to spawn subagents for each part. you be the mapper that defines the graph workflow ... also kill some deprecated heartbeat that
 * don't do anything, especially since you (and crawler VP) have Check-in heartbeat".
 */

const clip = (text: string, max = 60) => text.length > max ? text.slice(0, max - 1) + "\u2026" : text;
const quote = (text: string) => `"${clip(text)}"`;

/** One other session that holds too much of a goal's open work: `steps` of the goal's `open` open steps. */
export interface SessionLoad { goal: { id: string; text: string }; thread: { id: string; name: string }; steps: PlanItem[]; open: number }
/** A session holds too much of a goal when it owns more than this many of its open steps. */
export const SESSION_LOAD_MAX = 3;
/**
 * The other sessions that carry too much of one goal: per open goal, a thread owns more than SESSION_LOAD_MAX of its open steps, or more than
 * half of them when the goal has at least 4. A thread is another session the step names as its owner (a `thread:` link, a session id or name);
 * the chat's own steps, its subagents and the roots it started (`jobs`, ids or names from the job registry) never count.
 */
export function oneSessionLoad(views: readonly StepView[], jobs: readonly string[] = []): SessionLoad[] {
  const own = new Set(jobs);
  const goals = new Map<string, { goal: { id: string; text: string }; open: number; by: Map<string, { thread: { id: string; name: string }; steps: PlanItem[] }> }>();
  for (const view of views) {
    const goal = view.goal ?? { id: view.item.id, text: view.item.text };
    const entry = goals.get(goal.id) ?? { goal, open: 0, by: new Map() };
    goals.set(goal.id, entry);
    entry.open++;
    const owner = view.mine ? undefined : view.owner;
    if (!owner?.key.startsWith("thread:")) continue;
    const id = owner.key.slice("thread:".length);
    if (own.has(id) || own.has(owner.name)) continue;
    const held = entry.by.get(id) ?? { thread: { id, name: owner.name }, steps: [] };
    held.steps.push(view.item);
    entry.by.set(id, held);
  }
  return [...goals.values()].flatMap(({ goal, open, by }) => [...by.values()]
    .filter(held => held.steps.length > SESSION_LOAD_MAX || (open >= 4 && held.steps.length * 2 > open)).map(held => ({ goal, ...held, open })));
}
export const sessionLoadLine = ({ goal, thread, steps, open }: SessionLoad): string =>
  `${goal.id} ${quote(goal.text)} has ${steps.length} of its ${open} open steps on the ${clip(thread.name, 40)} thread (thread:${thread.id}): ` +
  `${steps.map(item => item.id).join(", ")}. Split these into your own jobs per part: map the parts and their order, start one job or subagent ` +
  "per part with rlm.spawn, set each step's job to it, and tell that thread it no longer owns them";

/** One entry of a session's `scheduled-jobs.json` (Prime Agent's schedules), as far as the check-in reads it. */
export interface ScheduledJob {
  id: string; source?: string; status?: string; label?: string; prompt?: string; schedule?: { expression?: string; intervalMs?: number };
  lastRunAt?: string; lastSkippedAt?: string; nextRunAt?: string;
}
/** `<home>/.prime/agent/session-artifacts/<chat id>/scheduled-jobs.json`, where Prime Agent keeps a session's heartbeats. */
export const heartbeatsFile = (chatId: string, home: string = homedir()): string => join(home, ".prime", "agent", "session-artifacts", chatId, "scheduled-jobs.json");
/** The schedules in a `scheduled-jobs.json`; none when the file is missing or unreadable. */
export function readHeartbeats(file: string): ScheduledJob[] {
  try {
    const jobs = (JSON.parse(readFileSync(file, "utf8")) as { jobs?: unknown }).jobs;
    return Array.isArray(jobs) ? jobs.filter((job): job is ScheduledJob => typeof job === "object" && job !== null && typeof (job as ScheduledJob).id === "string") : [];
  } catch {
    return [];
  }
}
/** One land or promote run of the release train as the CI cache last read it: `key` is the land it carries ("33", "32b") or "promote". */
export interface TrainRun { id: string; key: string; running: boolean; conclusion: string | null; createdAt: number; updatedAt: number }
/** One run of any workflow as the CI cache last read it, with the branch it ran on (`ref`). */
export interface CiRun { id: string; running: boolean; conclusion: string | null; updatedAt: number; ref?: string; sha?: string; workflow?: string; event?: string; createdAt?: number }
/**
 * The release train's runs in the CI cache, and when the cache last read GitHub (`fetchedAt`). `all` is every run the cache has by id, the
 * verify-dev runs of ci/ branches too, for the steps that wait on one (`namedRuns`).
 */
export interface Train { runs: TrainRun[]; readAt: number; all?: ReadonlyMap<string, CiRun> }
/** `<home>/.cache/virev/ci-runs.json`, which launchd ai.virev.ci-cache rewrites from GitHub every 30 s for sieu-n/auto-sns-agent. */
export const trainFile = (home: string = homedir()): string => join(home, ".cache", "virev", "ci-runs.json");
const LAND_RUN = /^land:\s*land[\s-]+(\d+[a-z]?)\b/i;
/** A branch a land runs on, `land/34` or `ci/land-34-r2`, with the land it carries when the name has one. */
const LAND_BRANCH = /^(?:ci\/)?land(?:[-/_](\d+[a-z]?))?(?=$|[-/_])/i;
/**
 * The release train's runs of a ci-runs.json: land.yml and promote.yml runs, and a run of any workflow on a land branch (`LAND_BRANCH`), keyed
 * by the land its branch names (else "land"). Undefined when it has no `runs` or no `fetchedAt`.
 */
export function parseTrain(cache: unknown): Train | undefined {
  const { runs, fetchedAt } = (cache ?? {}) as { runs?: Record<string, { run?: Record<string, unknown> }>; fetchedAt?: string };
  const readAt = Date.parse(fetchedAt ?? "");
  if (!runs || !Number.isFinite(readAt)) return undefined;
  const all = new Map(Object.values(runs).flatMap(({ run }) => run?.id === undefined ? [] : [[String(run.id), { id: String(run.id), running: run.status !== "completed",
    conclusion: typeof run.conclusion === "string" ? run.conclusion : null, updatedAt: Date.parse(String(run.updated_at)), ref: String(run.head_branch ?? ""),
    sha: String(run.head_sha ?? ""), workflow: String(run.name ?? ""), event: String(run.event ?? ""), createdAt: Date.parse(String(run.created_at)) }] as const]));
  return { readAt, all, runs: Object.values(runs).flatMap(({ run }) => {
    const path = String(run?.path ?? "");
    const branch = LAND_BRANCH.exec(String(run?.head_branch ?? ""));
    const key = path.endsWith("/promote.yml") ? "promote" : path.endsWith("/land.yml") ? LAND_RUN.exec(String(run?.name ?? ""))?.[1]?.toLowerCase() :
      branch ? branch[1]?.toLowerCase() ?? "land" : undefined;
    if (!run || !key) return [];
    return [{ id: String(run.id), key, running: run.status !== "completed", conclusion: typeof run.conclusion === "string" ? run.conclusion : null,
      createdAt: Date.parse(String(run.created_at)), updatedAt: Date.parse(String(run.updated_at)) }];
  }) };
}
/** The release train in `file` (`trainFile`); undefined when the file is missing or unreadable. */
export async function readTrain(file: string): Promise<Train | undefined> {
  try {
    return parseTrain(JSON.parse(await readFile(file, "utf8")));
  } catch {
    return undefined;
  }
}
/**
 * Whether a thread with these heartbeats is live between its turns: one of its active heartbeats is due ahead, ran or was skipped within its
 * interval, or the thread acted (`activityAt`) within that interval. Crawler VP 10-13, p147: the meta ads thread runs a 30-min status beat
 * and a CI watch and reads idle between beats; at the 08:39Z check-in its beats had last run 41 to 67 min before, but it had acted 45 s before.
 */
export function heartbeatLive(jobs: readonly ScheduledJob[], activityAt: number | undefined, now: number): boolean {
  return jobs.some(job => {
    if (job.status !== "active") return false;
    if (Date.parse(job.nextRunAt ?? "") >= now) return true;
    const every = job.schedule?.intervalMs;
    if (every === undefined) return false;
    const ran = Math.max(...[job.lastRunAt, job.lastSkippedAt].map(at => Date.parse(at ?? "")).filter(Number.isFinite), activityAt ?? -Infinity);
    return now - ran <= every;
  });
}
/**
 * The facts with each step-owner thread that the daemon lists as idle but whose heartbeats keep it live (`heartbeatLive`) marked working, as
 * `liveJobs` does for a subagent with a running worker. `heartbeatsOf` reads a thread's schedules by its session id (`readHeartbeats`).
 */
export const liveThreads = (facts: readonly JobFact[], heartbeatsOf: (sessionId: string) => readonly ScheduledJob[], now: number): JobFact[] =>
  facts.map(fact => fact.key.startsWith("thread:") && fact.state === "ended" && heartbeatLive(heartbeatsOf(fact.key.slice("thread:".length)), fact.activityAt, now)
    ? { ...fact, state: "working" } : fact);
/**
 * The facts with each job whose session sleeps on a wake the service still owes (`pendingWakes`) marked working and its wake named
 * (`JobFact.wake`): a step it owns is moved by a live owner until the wake is due. `sessionOf` gives a subagent's session by its child id; a
 * thread's is its key. launch main bro 10-14: the release driver root owned p53, p75 and p56, ended its turn at 13:40Z on a board.wake for
 * 14:40Z (its hourly check of land 35 and promote 10), and the 13:50Z check-in flagged all three stuck and blocked on others, "release driver
 * thread is idle".
 */
export function withWakes(facts: readonly JobFact[], wakes: readonly Wake[], sessionOf: (key: string) => string | undefined): JobFact[] {
  const bySession = new Map<string, Wake[]>();
  for (const wake of wakes) bySession.set(wake.session, [...bySession.get(wake.session) ?? [], wake]);
  return facts.map(fact => {
    const session = fact.key.startsWith("thread:") ? fact.key.slice("thread:".length) : fact.sessionId ?? sessionOf(fact.key);
    const owed = session === undefined ? undefined : bySession.get(session);
    return owed ? { ...fact, state: "working", wake: wakeLabel(owed) } : fact;
  });
}
/** What one session asleep on pending board.wakes watches: its wake label (`wakeLabel`), and the work its run wakes are on ("run 38790378691", "land 37"). */
export interface WakeWatch { label: string; works: ReadonlySet<string> }
/**
 * Each session with a pending board.wake (`pendingWakes`), by session id, with the work it watches: each run it waits on, and the land the CI
 * cache files that run under (`Train`). A step that waits on that run or land, or that this session owns, has a live owner in another session.
 */
export function wakeWatches(wakes: readonly Wake[], train?: Train): Map<string, WakeWatch> {
  const bySession = new Map<string, Wake[]>();
  for (const wake of wakes) bySession.set(wake.session, [...bySession.get(wake.session) ?? [], wake]);
  const works = ({ on }: Wake): string[] => {
    if (on.kind !== "run") return [];
    const id = String(on.run);
    const land = train?.runs.find(run => run.id === id)?.key;
    return [`run ${id}`, ...(land !== undefined && land !== "land" && land !== "promote" ? [`land ${land}`] : [])];
  };
  return new Map([...bySession].map(([session, owed]) => [session, { label: wakeLabel(owed), works: new Set(owed.flatMap(works)) }]));
}
/** Words in a heartbeat's label or prompt that name work the check-in already does: a check-in, the board, watching, monitoring, status, nudging. */
const CHECK_IN_WORK = /\bcheck[- ]?ins?\b|\bboard\b|\bwatch(?:er|ers|es|ing)?\b|\bmonitor(?:s|ing)?\b|\bstatus\b|\bnudge[sd]?\b|\bguides?\b|\bstall(?:s|ed)?\b|\bprogress\b/i;
/** A heartbeat prompt that starts a job: its work is that job's, and its "update the board" or "send the owner the status" is the job's report. */
const SPAWNS_JOB = /\brlm\.spawn\b|\bspawn\s+(?:one|a)\s+job\b/i;
/** The daily time of a cron heartbeat ("0 9 * * *" is 09:00), undefined for any other schedule. */
const cronDaily = (expression: string | undefined): string | undefined => {
  const match = /^(\d{1,2})\s+(\d{1,2})\s+\*\s+\*\s+\*$/.exec((expression ?? "").trim());
  return match ? `${match[2]!.padStart(2, "0")}:${match[1]!.padStart(2, "0")}` : undefined;
};
/** The last two parts of each file path a text names ("program/brief.md", "seo-recrawl/README.md"). */
const pathTails = (text: string): Set<string> =>
  new Set([...text.matchAll(/[\w.-]+(?:\/[\w.-]+)+\.\w+/g)].map(([path]) => path!.split("/").slice(-2).join("/").toLowerCase()));
/** The duty fields that tell whether a duty runs a heartbeat's work. */
export type HeartbeatDuty = { id: string; name: string; status: string; schedule?: { kind: string; at?: string }; onMiss?: string };
/** A heartbeat of the chat that repeats work the check-in does, or that an active duty (`duty`) runs. */
export interface RedundantHeartbeat { job: ScheduledJob; duty?: HeartbeatDuty }
/**
 * The chat's own active rlm heartbeats whose work the check-in or a duty already does. The check-in covers one whose label names check-in work,
 * or whose prompt does when it starts no job. A duty covers a daily cron heartbeat when it is active, runs daily at the same time and its onMiss
 * names a file the prompt names. SEO guy 10-13: "virev-seo-daily" (0 9 * * *) and "virev-seo-recrawl" (20 10 * * *) spawn the daily SEO jobs and
 * were flagged as check-in work only for "put the job on the board" and "send the owner ... the status" in their prompts; the real cover was
 * the duties d1 (09:00, onMiss "program/brief.md ... the work the 09:00 heartbeat did") and d2 (10:20, "workers/seo-recrawl/README.md").
 */
export function redundantHeartbeats(jobs: readonly ScheduledJob[], duties: readonly HeartbeatDuty[] = []): RedundantHeartbeat[] {
  return jobs.flatMap(job => {
    if (job.source !== "rlm_heartbeat" || job.status !== "active") return [];
    const prompt = job.prompt ?? "";
    if (CHECK_IN_WORK.test(job.label ?? "") || (!SPAWNS_JOB.test(prompt) && CHECK_IN_WORK.test(prompt))) return [{ job }];
    const at = cronDaily(job.schedule?.expression);
    const files = pathTails(prompt);
    const duty = at === undefined ? undefined : duties.find(duty => duty.status === "active" && duty.schedule?.kind === "daily" && duty.schedule.at === at &&
      [...pathTails(duty.onMiss ?? "")].some(tail => files.has(tail)));
    return duty ? [{ job, duty }] : [];
  });
}
export const heartbeatLine = ({ job, duty }: RedundantHeartbeat): string =>
  `heartbeat ${quote(job.label ?? job.id)}${job.schedule?.expression ? ` (${job.schedule.expression})` : ""}, ${quote((job.prompt ?? "").replace(/\s+/g, " "))}: ` +
  `${duty ? `the duty ${duty.id} ${quote(duty.name)} runs this work at ${duty.schedule?.at}` : "the check-in covers this"}. Ask the chat to delete it in its own ` +
  `REPL with \`await rlm_heartbeat.delete("${job.id}")\``;
