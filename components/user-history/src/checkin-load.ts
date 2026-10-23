import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { childWorking, type JobFact, type StepView } from "./checkin-steps.ts";
import { CI_CACHE_REPO, RUN_WAKE_DUE_MS, treeWakes, type Wake, wakeLabel } from "./wakes.ts";
import { firstClause } from "./shared/chat-board.ts";
import type { ChildAgent, PlanItem } from "./shared/types.ts";
import type { StalledCall } from "./shared/stalled-calls.ts";
import { ciRuns } from "./ci-runs.ts";

/*
 * Work spread and stale timers (owner 10-12, c51): "you seem to be using waaay too much on that ONE old session when it will be so much more
 * efficient to spawn subagents for each part. you be the mapper that defines the graph workflow ... also kill some deprecated heartbeat that
 * don't do anything, especially since you (and crawler VP) have Check-in heartbeat".
 */

const clip = (text: string, max = 60) => text.length > max ? text.slice(0, max - 1) + "\u2026" : text;
const quote = (text: string) => `"${clip(text)}"`;

/** One other session that holds too much of a goal's open work: `steps` of the goal's `open` open steps, worked by `working` subagents of its own. */
export interface SessionLoad { goal: { id: string; text: string }; thread: { id: string; name: string }; steps: PlanItem[]; open: number; working: number }
/** A session holds too much of a goal when it owns more than this many of its open steps. */
export const SESSION_LOAD_MAX = 3;
/**
 * A session that holds many steps fans them out when it has one working subagent per this many of them. On 10-23 at 17:52Z sep launch!!'s
 * p2 per-area threads on us-metal02 ran 8 working subagents for 9 steps (5180 into the real app on metal), 3 for 8 (data model on metal) and
 * 2 for 4 (mail integrations on metal), and the check-in had flagged all three 8 runs in a row.
 */
export const SESSION_LOAD_STEPS_PER_JOB = 3;
/**
 * The other sessions that carry too much of one goal: per open goal, a thread owns more than SESSION_LOAD_MAX of its open steps, or more than
 * half of them when the goal has at least 4, and has fewer working subagents (`subagents`, the daemon's roster by parent session) than one per
 * SESSION_LOAD_STEPS_PER_JOB of those steps. A thread is another session the step names as its owner (a `thread:` link, a session id or name);
 * the chat's own steps, its subagents and the roots it started (`jobs`, ids or names from the job registry) never count. A subagent works when
 * it runs or its session is in `live`, the sessions queued in pi-pool's turn queue or asleep on a board.wake. A step with a `waitFor` or
 * `waitUntil` waits on purpose, such as for a land, and leaves its thread no work, so it is no load. On 10-23 from 15:50Z to 18:31Z the six
 * builders of "data model on metal" waited 1,842 to 2,376 s in pi-pool's turn queue before each turn (pi-pool log), and from 16:00Z to 16:45Z
 * all six sat queued with none running, so the roster read none of them as working.
 */
export function oneSessionLoad(views: readonly StepView[], jobs: readonly string[] = [], subagents: ReadonlyMap<string, readonly ChildAgent[]> = new Map(),
  live: ReadonlySet<string> = new Set()): SessionLoad[] {
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
    if (own.has(id) || own.has(owner.name) || view.item.waitFor || view.item.waitUntil) continue;
    const held = entry.by.get(id) ?? { thread: { id, name: owner.name }, steps: [] };
    held.steps.push(view.item);
    entry.by.set(id, held);
  }
  return [...goals.values()].flatMap(({ goal, open, by }) => [...by.values()].flatMap(held => {
    const working = (subagents.get(held.thread.id) ?? []).filter(child => childWorking(child) || (child.sessionId !== undefined && live.has(child.sessionId))).length;
    const heavy = held.steps.length > SESSION_LOAD_MAX || (open >= 4 && held.steps.length * 2 > open);
    return heavy && working * SESSION_LOAD_STEPS_PER_JOB < held.steps.length ? [{ goal, ...held, open, working }] : [];
  }));
}
export const sessionLoadLine = ({ goal, thread, steps, open, working }: SessionLoad): string =>
  `${goal.id} ${quote(goal.text)} has ${steps.length} of its ${open} open steps on the ${clip(thread.name, 40)} thread (thread:${thread.id}), ` +
  `which runs ${working} working ${working === 1 ? "job" : "jobs"} of its own: ` +
  `${steps.map(item => item.id).join(", ")}. Split these into your own jobs per part: map the parts and their order, start one job or subagent ` +
  "per part with rlm.spawn, set each step's job to it, and tell that thread it no longer owns them";

/** One entry of a session's `scheduled-jobs.json` (Prime Agent's schedules), as far as the check-in reads it. */
export interface ScheduledJob {
  id: string; source?: string; status?: string; label?: string; prompt?: string; schedule?: { expression?: string; intervalMs?: number };
  lastRunAt?: string; lastSkippedAt?: string; nextRunAt?: string;
  /** The session the job runs in: a root's own, or for a subagent's quota resume the subagent's, kept in its root's file. */
  sessionId?: string;
}
/** `<home>/.prime/agent/session-artifacts/<chat id>/scheduled-jobs.json`, where Prime Agent keeps a session's heartbeats. */
export const heartbeatsFile = (chatId: string, home: string = homedir()): string => join(home, ".prime", "agent", "session-artifacts", chatId, "scheduled-jobs.json");
/** The schedules in a `scheduled-jobs.json`; none when the file is missing or unreadable. */
export function readHeartbeats(file: string): ScheduledJob[] {
  try { return parseHeartbeats(readFileSync(file, "utf8")); } catch { return []; }
}
/** The schedules in a `scheduled-jobs.json` text; none when it does not parse. */
export function parseHeartbeats(text: string): ScheduledJob[] {
  try {
    const jobs = (JSON.parse(text) as { jobs?: unknown }).jobs;
    return Array.isArray(jobs) ? jobs.filter((job): job is ScheduledJob => typeof job === "object" && job !== null && typeof (job as ScheduledJob).id === "string") : [];
  } catch {
    return [];
  }
}
/** One land or promote run of the release train as the CI cache last read it: `key` is the land it carries ("33", "32b") or "promote". */
export interface TrainRun { id: string; key: string; running: boolean; conclusion: string | null; createdAt: number; updatedAt: number;
  /** The sieun/dev commit a land.yml run lands (its head sha); absent for promote runs and runs on a land branch. */
  sha?: string }
/** One run of any workflow as the CI cache last read it, with the branch it ran on (`ref`). */
export interface CiRun { id: string; running: boolean; conclusion: string | null; updatedAt: number; ref?: string; sha?: string; workflow?: string; event?: string; createdAt?: number;
  /** The CI cache reads it as a ghost (ci-cache.mjs isGhost): GitHub lists it as queued, but it will never run to a result. */
  ghost?: true;
  /** The run's latest attempt (GitHub's run_attempt), which a rerun raises under the same run id. */
  attempt?: number }
/**
 * The release train's runs in the CI cache, and when the cache last read GitHub (`fetchedAt`). `all` is every run the cache has by id, the
 * verify-dev runs of ci/ branches too, for the steps that wait on one (`namedRuns`).
 */
export interface Train { runs: TrainRun[]; readAt: number; all?: ReadonlyMap<string, CiRun> }
/** `<home>/.cache/virev/ci-runs.json`, which launchd ai.virev.ci-cache rewrites from GitHub every 30 s for sieu-n/auto-sns-agent. */
export const trainFile = (home: string = homedir()): string => join(home, ".cache", "virev", "ci-runs.json");
/** The checkout of sieu-n/auto-sns-agent, the repo the release train in `trainFile` runs for. */
export const trainRepo = (home: string = homedir()): string => join(home, "Documents", "Github", "auto-sns-agent");
const LAND_RUN = /^land:\s*land[\s-]+(\d+[a-z]?)\b/i;
/** A branch a land runs on, `land/34` or `ci/land-34-r2`, with the land it carries when the name has one. */
const LAND_BRANCH = /^(?:ci\/)?land(?:[-/_](\d+[a-z]?))?(?=$|[-/_])/i;
/**
 * The release train's runs of a ci-runs.json: land.yml and promote.yml runs, and a run of any workflow on a land branch (`LAND_BRANCH`), keyed
 * by the land its branch names (else "land"). Undefined when it has no `runs` or no `fetchedAt`.
 */
export function parseTrain(cache: unknown): Train | undefined {
  const { runs, fetchedAt } = (cache ?? {}) as { runs?: Record<string, { run?: Record<string, unknown>; ghost?: unknown }>; fetchedAt?: string };
  const readAt = Date.parse(fetchedAt ?? "");
  if (!runs || !Number.isFinite(readAt)) return undefined;
  const all = new Map(Object.values(runs).flatMap(({ run, ghost }) => run?.id === undefined ? [] : [[String(run.id), { id: String(run.id), running: run.status !== "completed",
    conclusion: typeof run.conclusion === "string" ? run.conclusion : null, updatedAt: Date.parse(String(run.updated_at)), ref: String(run.head_branch ?? ""),
    sha: String(run.head_sha ?? ""), workflow: String(run.name ?? ""), event: String(run.event ?? ""), createdAt: Date.parse(String(run.created_at)),
    ...typeof run.run_attempt === "number" ? { attempt: run.run_attempt } : {}, ...ghost === true ? { ghost: true as const } : {} }] as const]));
  return { readAt, all, runs: Object.values(runs).flatMap(({ run }) => {
    const path = String(run?.path ?? "");
    const branch = LAND_BRANCH.exec(String(run?.head_branch ?? ""));
    const key = path.endsWith("/promote.yml") ? "promote" : path.endsWith("/land.yml") ? LAND_RUN.exec(String(run?.name ?? ""))?.[1]?.toLowerCase() :
      branch ? branch[1]?.toLowerCase() ?? "land" : undefined;
    if (!run || !key) return [];
    return [{ id: String(run.id), key, running: run.status !== "completed", conclusion: typeof run.conclusion === "string" ? run.conclusion : null,
      createdAt: Date.parse(String(run.created_at)), updatedAt: Date.parse(String(run.updated_at)),
      ...path.endsWith("/land.yml") && typeof run.head_sha === "string" ? { sha: run.head_sha } : {} }];
  }) };
}
/** The release train in `file` (`trainFile`); undefined when the file is missing or unreadable. */
export async function readTrain(file: string): Promise<Train | undefined> {
  return parseTrain(await ciRuns(file) ?? undefined);
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
 * thread is idle". A wake of a session below the job (`below` gives a session's child sessions, `treeWakes`) counts too: on 10-18 at 01:14Z crawler
 * prod alerts had ended its turn while its subagents slept on their CI runs.
 */
export function withWakes(facts: readonly JobFact[], wakes: readonly Wake[], sessionOf: (key: string) => string | undefined,
  below: (session: string) => readonly string[] = () => []): JobFact[] {
  return facts.map(fact => {
    const session = fact.key.startsWith("thread:") ? fact.key.slice("thread:".length) : fact.sessionId ?? sessionOf(fact.key);
    const owed = session === undefined ? [] : treeWakes(session, below, wakes);
    return owed.length ? { ...fact, state: "working", wake: wakeLabel(owed) } : fact;
  });
}
/**
 * The facts with each working owner whose session sits in one tool call past STALL_MS (`stalls`, from `stalledCalls`) turned to ended, with its
 * stall: such a job moves nothing until the call returns, so its steps are stuck (end state `stalled_call`). An owner asleep on a board.wake is
 * left as it is. On 10-23 the job "codex fhnyq29tw5 sign-in" sat 2 h 53 min in one glob over all of home and p919 read moving all that time.
 */
export function withStalls(facts: readonly JobFact[], stalls: ReadonlyMap<string, StalledCall>, sessionOf: (key: string) => string | undefined): JobFact[] {
  if (!stalls.size) return [...facts];
  return facts.map(fact => {
    if (fact.state !== "working" || fact.wake !== undefined) return fact;
    const session = fact.key.startsWith("thread:") ? fact.key.slice("thread:".length) : fact.sessionId ?? sessionOf(fact.key);
    const call = session === undefined ? undefined : stalls.get(session);
    return call ? { ...fact, state: "ended", stalled: call } : fact;
  });
}
/**
 * The sessions Prime parked on a provider limit, by session id, with when the daemon loads each again: every active `quota-resume` job
 * (agent-session.ts `_parkForQuotaReset`) whose next run is ahead of `now`. A root's file holds its subagents' quota resumes too.
 */
export function quotaParks(jobs: readonly ScheduledJob[], now: number): Map<string, number> {
  const parks = new Map<string, number>();
  for (const job of jobs) {
    const at = Date.parse(job.nextRunAt ?? /^at (\S+)$/.exec(job.schedule?.expression ?? "")?.[1] ?? "");
    if (job.label !== "quota-resume" || job.status !== "active" || job.sessionId === undefined || !(at > now)) continue;
    parks.set(job.sessionId, Math.max(at, parks.get(job.sessionId) ?? at));
  }
  return parks;
}
/**
 * The disk that holds a chat's Prime artifacts, as the check-in reads it: this box's (`localDisk`), or the chat's box through its relay
 * (`hostDisk` in src/chat-disk.ts). sep launch!! runs on the Mac, and on 10-22 the 16:51Z and 17:06Z check-ins on us-metal02 looked on their own disk for its
 * jobs' quota parks, found none, and called mail integrations and mcp connector failed while Prime held both until 19:20Z.
 */
export interface ArtifactDisk {
  /** The home on that box whose `.prime/agent/session-artifacts` holds the chat's folder. */
  home: string;
  /** The entry names of a folder; none when it is missing or cannot be read. */
  list(dir: string): Promise<string[]>;
  /** A file's text; null when it is missing or cannot be read. */
  read(file: string): Promise<string | null>;
}
export const localDisk = (home: string = homedir()): ArtifactDisk => ({ home,
  list: dir => readdir(dir).catch(() => []), read: file => readFile(file, "utf8").catch(() => null) });
/**
 * The `scheduled-jobs.json` files on `disk` that hold the quota resumes of a chat's jobs: the chat's own, each root's it names (`roots`, session
 * ids, such as its step-owner threads), and for each job session in `sessions` the one Prime keeps in the chat's folder, under
 * `<chat>/session-artifacts/<session>/` for a subagent of the chat or `<chat>/sub-*\/session-artifacts/<session>/` for one below a subagent.
 * Until 10-23 the first of those two was not read, and on us-metal02 it held 410 of the 494 subagent quota resumes: from 10-20 04:50Z to 10-22
 * 19:38Z, 141 check-ins in 7 chats called 23 such jobs failed while their park was pending (chat reply speed parked from 04:04Z to 05:06Z on
 * 10-22, read failed at 04:21Z, 04:36Z and 04:51Z), and on the Mac sep launch!!'s 16:51Z check-in counted 5 steps stuck on its 2
 * parked jobs, which d9 read as stuck_steps_all 5 at 17:03Z.
 */
export async function parkFiles(chat: string, roots: readonly string[], sessions: ReadonlySet<string>, disk: ArtifactDisk = localDisk()): Promise<string[]> {
  const artifacts = join(disk.home, ".prime", "agent", "session-artifacts", chat);
  const folders = [join(artifacts, "session-artifacts"), ...(await disk.list(artifacts)).filter(name => name.startsWith("sub-")).map(sub => join(artifacts, sub, "session-artifacts"))];
  const nested = await Promise.all(folders.map(async folder => (await disk.list(folder)).filter(session => sessions.has(session)).map(session => join(folder, session, "scheduled-jobs.json"))));
  return [...new Set([...[chat, ...roots].map(id => heartbeatsFile(id, disk.home)), ...nested.flat()])];
}
/** The schedules in the files `parkFiles` names, read from `disk`. */
export async function parkSchedules(chat: string, roots: readonly string[], sessions: ReadonlySet<string>, disk: ArtifactDisk = localDisk()): Promise<ScheduledJob[]> {
  const files = await parkFiles(chat, roots, sessions, disk);
  return (await Promise.all(files.map(async file => parseHeartbeats(await disk.read(file) ?? "")))).flat();
}
/**
 * The facts with each job parked on a provider limit (`quotaParks`) marked working until the daemon's quota resume (`JobFact.parkedUntil`): it
 * waits for an account, and the daemon gives its turn back by itself. A job whose turn failed with no pending park still reads failed. AI harness
 * 10-21 14:00Z: d9 residuals 10-21 sat parked until 14:45Z and digest cache integration until 14:48Z, and the check-in read both failed on
 * their 429 and flagged p773, p804, p818 and p831 as stalled_steps.
 */
export function withQuotaParks(facts: readonly JobFact[], parks: ReadonlyMap<string, number>, sessionOf: (key: string) => string | undefined): JobFact[] {
  if (!parks.size) return [...facts];
  return facts.map(fact => {
    if (fact.cancelled) return fact;
    const session = fact.key.startsWith("thread:") ? fact.key.slice("thread:".length) : fact.sessionId ?? sessionOf(fact.key);
    const until = session === undefined ? undefined : parks.get(session);
    return until === undefined ? fact : { ...fact, state: "working", parkedUntil: until };
  });
}
/** A run wake the service owes but should have sent: its run ended (`why`, as in "run 39323562100 ended cancelled at 21:07Z") over RUN_WAKE_DUE_MS ago. */
export interface DeadWake { wake: Wake; why: string }
/**
 * The pending wakes split into the live ones and the dead waits: a run wake on a run of the CI cache's repo that the cache (`train`) reads as
 * ended or a ghost, and whose last update is over RUN_WAKE_DUE_MS old, so a ticking service would have sent it. A job asleep only on dead waits
 * is no live owner. Crawler VP 10-20 07:45Z: about 15 jobs had slept since 10-19 21:07Z on promote run 39323562100, cancelled before any job
 * ran, and the check-in listed each as asleep on it. A wake for a later attempt than the run's latest waits for a rerun and stays live.
 */
export function deadWakes(wakes: readonly Wake[], train: Train | undefined, now: number): { live: Wake[]; dead: DeadWake[] } {
  const live: Wake[] = [];
  const dead: DeadWake[] = [];
  for (const wake of wakes) {
    const run = wake.on.kind === "run" && (!wake.on.repo || wake.on.repo === CI_CACHE_REPO) ? train?.all?.get(String(wake.on.run)) : undefined;
    const later = wake.on.kind === "run" && (wake.on.attempt ?? 1) > (run?.attempt ?? 1);
    if (!run || later || (run.running && !run.ghost) || !(now - run.updatedAt > RUN_WAKE_DUE_MS)) { live.push(wake); continue; }
    const how = run.ghost ? "as a ghost with no result" : run.conclusion ?? "with no conclusion";
    dead.push({ wake, why: `run ${run.id} ended ${how} at ${new Date(run.updatedAt).toISOString().slice(11, 16)}Z` });
  }
  return { live, dead };
}
/**
 * The facts with each job that is not working and whose session, or a session below it, sleeps on dead waits (`deadWakes`) given
 * `JobFact.deadWake`, which names the wake and how its run ended.
 */
export function withDeadWakes(facts: readonly JobFact[], dead: readonly DeadWake[], sessionOf: (key: string) => string | undefined,
  below: (session: string) => readonly string[] = () => []): JobFact[] {
  if (!dead.length) return [...facts];
  return facts.map(fact => {
    if (fact.state === "working") return fact;
    const session = fact.key.startsWith("thread:") ? fact.key.slice("thread:".length) : fact.sessionId ?? sessionOf(fact.key);
    if (session === undefined) return fact;
    const mine = new Set(treeWakes(session, below, dead.map(({ wake }) => wake)));
    const found = dead.filter(({ wake }) => mine.has(wake));
    return found.length ? { ...fact, deadWake: `${wakeLabel(found.map(({ wake }) => wake))}, but ${[...new Set(found.map(({ why }) => why))].join(" and ")}` } : fact;
  });
}
/** What one session asleep on pending board.wakes watches: its wake label (`wakeLabel`), and the work its run wakes are on ("run 38790378691", "land 37"). */
export interface WakeWatch { label: string; works: ReadonlySet<string>;
  /** The commits named in open steps' waits that a land run this session sleeps on carries (`landCarries`), and that land, as in "land 40". */
  carries?: { land: string; commits: ReadonlySet<string> } }
/**
 * Each session with a pending board.wake (`pendingWakes`), by session id, with the work it watches: each run it waits on, and the land the CI
 * cache files that run under (`Train`). A step that waits on that run or land, or that this session owns, has a live owner in another session.
 */
export function wakeWatches(wakes: readonly Wake[], train?: Train, carried: ReadonlyMap<string, ReadonlySet<string>> = new Map()): Map<string, WakeWatch> {
  const bySession = new Map<string, Wake[]>();
  for (const wake of wakes) bySession.set(wake.session, [...bySession.get(wake.session) ?? [], wake]);
  const works = ({ on }: Wake): string[] => {
    if (on.kind !== "run") return [];
    const id = String(on.run);
    const land = train?.runs.find(run => run.id === id)?.key;
    return [`run ${id}`, ...(land !== undefined && land !== "land" && land !== "promote" ? [`land ${land}`] : [])];
  };
  const carries = (owed: readonly Wake[]): WakeWatch["carries"] => {
    for (const { on } of owed) {
      if (on.kind !== "run") continue;
      const commits = carried.get(String(on.run));
      if (!commits?.size) continue;
      const key = train?.runs.find(run => run.id === String(on.run))?.key;
      return { land: key && key !== "land" ? `land ${key}` : `run ${on.run}`, commits };
    }
    return undefined;
  };
  return new Map([...bySession].map(([session, owed]) => {
    const carry = carries(owed);
    return [session, { label: wakeLabel(owed), works: new Set(owed.flatMap(works)), ...carry ? { carries: carry } : {} }];
  }));
}

/** A wait's first clause that names a land, promote or release, whose commits a land run can carry. */
export const LAND_WAIT = /\b(?:land|lands|landed|promote|promotes|release|released)\b/i;
/** A commit id as a wait names it: 7 to 40 hex characters with a digit and a letter, not part of a session id ("01a14fbe-a688-..."). */
const COMMIT = /(?<![\w-])(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}(?![\w-])/g;
/** The commits the first clause of a wait on a land names (`LAND_WAIT`), lower case; none for any other wait. */
export function landWaitCommits(waitFor: string | undefined): string[] {
  const head = firstClause(waitFor ?? "").toLowerCase();
  return LAND_WAIT.test(head) ? [...new Set(head.match(COMMIT) ?? [])] : [];
}
const git = promisify(execFile);
const ancestry = new Map<string, Promise<boolean>>();
/**
 * Whether `commit` is in the history of `head` in `repo`; a commit the repo does not have yet is not. A yes is kept, since history never
 * changes, and a no is asked again, since the checkout may fetch either commit later.
 */
const isAncestor = (repo: string, commit: string, head: string): Promise<boolean> => {
  const key = `${repo}\0${commit}\0${head}`;
  let answer = ancestry.get(key);
  if (!answer) {
    answer = git("git", ["-C", repo, "merge-base", "--is-ancestor", commit, head], { env: { ...process.env, GIT_DIR: undefined, GIT_INDEX_FILE: undefined, GIT_WORK_TREE: undefined } })
      .then(() => true, () => { ancestry.delete(key); return false; });
    ancestry.set(key, answer);
  }
  return answer;
};
/**
 * For each land.yml run a pending board.wake waits on, the commits that open steps' land waits name (`landWaitCommits`) and that run lands,
 * read with git in the train's checkout (`trainRepo`). A step that waits for "the next land and promote that carry <commit>" is then moved by
 * the session asleep on the land that carries it (`wakeMover`). Crawler VP 10-18 16:31Z: p542 waited for "the next land and promote 13 carry bf3ebaf4fa,
 * 39ffdfb8b4, ..." and counted stuck, while "land 39 rerun" slept on land 40's run 39144738917, whose pin e375b4cc0a carries all five commits.
 */
export async function landCarries(plan: readonly PlanItem[], wakes: readonly Wake[], train: Train | undefined, repo: string): Promise<Map<string, Set<string>>> {
  const carried = new Map<string, Set<string>>();
  const named = new Set<string>();
  const visit = (items: readonly PlanItem[]) => {
    for (const item of items) {
      if (item.status === "todo" || item.status === "doing" || item.status === "blocked") for (const commit of landWaitCommits(item.waitFor)) named.add(commit);
      visit(item.children);
    }
  };
  visit(plan);
  if (!train || !named.size) return carried;
  for (const id of new Set(wakes.flatMap(({ on }) => on.kind === "run" ? [String(on.run)] : []))) {
    const head = train.runs.find(run => run.id === id)?.sha;
    if (!head) continue;
    const commits = new Set<string>();
    for (const commit of named) if (await isAncestor(repo, commit, head)) commits.add(commit);
    if (commits.size) carried.set(id, commits);
  }
  return carried;
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
/** `chat`: a duty of another chat, which runs no heartbeat of this one. */
export type HeartbeatDuty = { id: string; name: string; status: string; schedule?: { kind: string; at?: string }; onMiss?: string; chat?: string };
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
    const duty = at === undefined ? undefined : duties.find(duty => duty.status === "active" && duty.chat === undefined && duty.schedule?.kind === "daily" && duty.schedule.at === at &&
      [...pathTails(duty.onMiss ?? "")].some(tail => files.has(tail)));
    return duty ? [{ job, duty }] : [];
  });
}
export const heartbeatLine = ({ job, duty }: RedundantHeartbeat): string =>
  `heartbeat ${quote(job.label ?? job.id)}${job.schedule?.expression ? ` (${job.schedule.expression})` : ""}, ${quote((job.prompt ?? "").replace(/\s+/g, " "))}: ` +
  `${duty ? `the duty ${duty.id} ${quote(duty.name)} runs this work at ${duty.schedule?.at}` : "the check-in covers this"}. Ask the chat to delete it in its own ` +
  `REPL with \`await rlm_heartbeat.delete("${job.id}")\``;
