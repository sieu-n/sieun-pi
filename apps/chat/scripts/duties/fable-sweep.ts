/**
 * Duty precheck: everything at a glance, the fable auditor's 3-hourly sweep (owner's words, dm_agent-factory, 11-22: msg mwqwpszf "Fable
 * auditor agent를 하나 만들고 싶어", then msg mwqwsgx9 "3-hourly로 모든 문제들을 전반적으로 훑어보고 문제가 될만한 부분/보고사항 제안사항
 * 특이사항을 나한테 넘기는 식으로"). It reads :5184 across every agent that is not a test or archived and lists what a reviewer should look at.
 * The Fable turn that judges it reads only this summary and, as needed, the detail file, so a quiet run costs no model turn at all.
 *
 * Kinds of items:
 *   owner_unanswered: an owner post of the last 3 h in a channel, Solo room or DM, 10 min old or more, that no agent answered: no agent post
 *     after it in its scope (its DM or thread, or for a channel root post its own thread and the channel root), no post that `answers` it, no
 *     delivery read as answered or no_reply, no agent reaction other than 👀, no done flag and, in a thread, no edit made after it of an
 *     earlier reply by one of the thread's agents. A thread reply is owed by the agents its root names or that replied in it, not by every
 *     member the room delivered it to. The 10 min are ten times the about one minute a comm thread takes to ack (c224).
 *   delivery_error: an owner post of the last 3 h whose delivery to an agent failed, still queued after 10 min, or that reached no agent.
 *   job_stuck: a job that reads working whose newest entry is 45 min old or more (sieun-pi AGENTS.md rule 6 reads that as stalled).
 *   job_retrying: a job whose run pi-host flags "retrying since HH:MM: <error kind>", a transient error it has retried past 5 minutes and
 *     keeps retrying, which is no stall (packages/pi-host/src/durable/retrying.ts).
 *   job_failed: a job whose last turn failed, with an entry in the last 24 h, and an agent's work or comm thread that failed.
 *   duty_off: a duty, not paused, whose last run missed its target or errored.
 *   step_stalled: an open board step with no live job on it, no wait still running, no board.wake the app owes its job or that names it, and
 *     no open owner todo that holds it. A step whose job wrote in the last 45 min still moves, since its parent often closes the step right
 *     after the job reports (the 45 min of rule 6).
 *   model_off: an agent other than this one whose work thread runs on Fable, which the owner keeps for this advisor (msg mwqwsgx9: "main
 *     worker들은 opus가 되면 좋겠거든? 워낙 비용이 비싸니까").
 *
 * Each item carries the context a reviewer would look up to judge it, in the detail file under its line: a duty's last three runs and its fix
 * step, a step's note, a stuck job's pi-host task state, such as waiting for an account slot. The first Fable sweep on 11-22 spent 40 turns
 * and $3.07 reading boards, duty runs, jobs and thread files for exactly this, so the judging turn now reads one file and posts.
 *
 * An item is fresh when it is new since the last run or was last raised 24 h ago or more, so a problem that stays shows once a day (the
 * daily cadence c66 gives a duty) and not on every 3-hourly run. A sweep that finds things is the duty working, so the headline counts
 * findings nobody has passed on yet, never the findings themselves (c67).
 *
 * Metrics:
 *   findings_unposted, the headline, target 0. In run mode (PRECHECK_MODE=run) it is the fresh count, so a sweep with findings starts the
 *     Fable job. In after mode (PRECHECK_MODE=after, once that job ended and its report reached the agent's work thread) it is 0 when the
 *     agent's DM holds a post of the agent's after the run's start or the job's last answer was "nothing to report", and else the run's
 *     fresh count again. The work thread posts the report after the job ends, so after mode waits up to 10 min for that post, ten times the
 *     about one minute a comm thread takes to post (c224). The run and its job come from LAST_RUNS_FILE, and the run's fresh count from its
 *     record, else from the state file. While the last sweep's job has had no model turn, since it waits for a model account (`noModelTurn`),
 *     a run leaves the headline out, so it reads not measured with an `outside_wait` item and starts no job, and its fresh items stay
 *     unraised so they carry to the next run.
 *     A verify run (PRECHECK_TRIGGER=verify, which the board starts when the sweep's fix step closes) measures as after mode does, so it
 *     confirms the last sweep's items reached the owner, raises nothing and starts no new sweep; its fresh items wait for the next scheduled
 *     run (`sweepMode`). A duty miss whose owner has it already, a fix step for each missed metric with a working or sleeping job or a
 *     board.wake, or the duty's first run, is listed as passed on and is never fresh (`passedOn`).
 *   sweep_age_min: minutes since the sweep before this one ran, target 195, the 180 min schedule plus 15 min.
 *   items_fresh, items_open and a count per kind are detail with no target.
 *
 * Job entry times come from the job's pi-host thread file, read only (`<threads dir>/<thread>.sqlite`), because every conversation of a
 * thread shares one `updatedAt` in the :5184 lists. A step's age is the start of the job on it, else the first run that saw it open.
 *
 * Usage: OUTPUT_FILE=<file> [STATE_FILE=<file>] [LAST_RUNS_FILE=<file>] [PRECHECK_MODE=run|after|peek] [PRECHECK_TRIGGER=<trigger>] node --import tsx scripts/duties/fable-sweep.ts
 *   --agent <agent id> [--server http://127.0.0.1:5184] [--threads-dir <dir>] [--data-dir <dir>]
 * Defaults: APPS_CHAT_URL else http://127.0.0.1:5184, ~/.prime/agent/pi-host/durable/threads, APPS_CHAT_DATA_DIR else ~/.pi/agent/chat, whose
 * wakes, in its folder or its chat.sqlite as the server's APPS_CHAT_DB_KINDS says, are read only. The detail file is OUTPUT_FILE with
 * `.items.md` in place of `.json`, else ~/work/fable-sweep/<stamp>.items.md, and the summary goes to OUTPUT_FILE, else stdout.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";
import { appsOwnerReads, wokenStep, type AppsChat } from "../../../../legacy/prime/user-history/src/apps-step-owners.ts";
import type { Wake } from "../../../../legacy/prime/user-history/src/wakes.ts";
import { owedWakesOf } from "../../server/wakes-db.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;
const POST_WINDOW_MS = 3 * HOUR;
const ANSWER_GRACE_MS = 10 * MIN;
const STUCK_MS = 45 * MIN;
const FAILED_WINDOW_MS = 24 * HOUR;
const RERAISE_MS = 24 * HOUR;

export const KINDS = ["owner_unanswered", "delivery_error", "job_stuck", "job_retrying", "job_failed", "duty_off", "step_stalled", "model_off"] as const;
export type Kind = (typeof KINDS)[number];
const KIND_WORDS: Record<Kind, [string, string]> = {
  owner_unanswered: ["owner post with no answer", "owner posts with no answer"], delivery_error: ["delivery error", "delivery errors"],
  job_stuck: ["stuck job", "stuck jobs"], job_retrying: ["job retrying an error", "jobs retrying an error"], job_failed: ["failed job or thread", "failed jobs and threads"],
  duty_off: ["duty off target", "duties off target"], step_stalled: ["step nobody moves", "steps nobody moves"],
  model_off: ["main worker on Fable", "main workers on Fable"],
};
const counted = (kind: Kind, n: number): string => `${n} ${KIND_WORDS[kind][n === 1 ? 0 : 1]}`;

export interface Item {
  kind: Kind; sig: string; agent: string; text: string; link: string; at?: number; context?: string[];
  /** Why its owner already has it (`passedOn`): such an item is listed but is never fresh, so it counts toward no findings_unposted. */
  passedOn?: string;
}
export interface SweepState { raised?: Record<string, number>; seen?: Record<string, number>; lastRun?: { at: number; fresh: number } }
/** The part of a duty run record (LAST_RUNS_FILE) this precheck reads. */
export interface RunRecord { at: number; job?: { id: string; name: string }; metrics?: Record<string, { value: number }> }

interface Author { id: string; kind: string; name?: string }
interface Delivery { target: string; name: string; state: string; at: number }
export interface Post {
  id: string; at: number; author: Author; text?: string; answers?: string; deliveries?: Delivery[]; editedAt?: number; mentions?: string[];
  reactions?: { emoji: string; by: Author[] }[]; done?: { at: number }; thread?: { authors?: Author[]; lastAt?: number } | null;
}
export interface Job { id: string; name: string; status: string; thread: string; conversation: number; createdAt: number; agent?: { id: string; name: string }; retrying?: string }
interface Agent { id: string; name: string; status: string; thread: string; room?: string; model?: { id: string; label?: string }; comm?: { room: string; thread: string; status: string }[] }
export interface PlanItem { id: string; text: string; status: string; note?: string; job?: string; duty?: string; waitUntil?: string | number; waitFor?: unknown; children?: PlanItem[] }
export interface DutyRunView {
  at: number; verdict: string; summary?: string; error?: string; metrics?: Record<string, { met: boolean }>;
  after?: { verdict?: string; summary?: string; metrics?: Record<string, { met: boolean }> }; fixes?: Record<string, { step: string; job?: string; live: boolean }> | null;
  job?: { id: string; name: string };
}
interface Todo { id: string; done?: boolean; step?: string }

const isAgent = (author: Author): boolean => author.kind !== "owner";
const ago = (ms: number): string => {
  const minutes = Math.round(ms / MIN);
  return minutes >= 48 * 60 ? `${Math.round(minutes / 1440)} d` : minutes >= 120 ? `${Math.round(minutes / 60)} h` : `${minutes} min`;
};
const oneLine = (text: string, max: number): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}\u2026` : flat;
};

/**
 * The owner posts of one room's scope (its DM root, a thread, or a channel's root) that no agent answered, and their delivery errors.
 * `scope` holds the scope's posts oldest first; `ownThread` gives a channel root post's own thread replies. `involved` are a thread's agents,
 * the ones its root names or that replied in it: a reply in the thread is theirs to answer, and an edit one of them makes of its earlier
 * reply after his post answers it, as a comm thread fills in its first reply (#komodo p2 answered p3 and p4 by edit on 11-24).
 */
export function postFindings(input: {
  room: string; roomName: string; kind: "dm" | "channel"; scope: readonly Post[]; ownThread?: (root: string) => readonly Post[]; link: (post: Post) => string; now: number;
  involved?: readonly { id: string; name: string }[];
}): Item[] {
  const { room, roomName, kind, scope, now } = input;
  const involved = input.involved?.length ? input.involved : undefined;
  const theirs = (author: Author): boolean => isAgent(author) && (!involved || involved.some(agent => agent.id === author.id));
  const items: Item[] = [];
  const answeredIds = new Set(scope.filter(p => isAgent(p.author) && p.answers).map(p => p.answers!));
  const direct = (post: Post): boolean => answeredIds.has(post.id) || !!post.done
    || (post.deliveries ?? []).some(d => d.state === "answered" || d.state === "no_reply")
    || (post.reactions ?? []).some(r => r.emoji !== "👀" && r.by.some(isAgent))
    || (input.ownThread?.(post.id) ?? []).some(reply => isAgent(reply.author) && reply.at > post.at);
  scope.forEach((post, at) => {
    if (isAgent(post.author) || post.at < now - POST_WINDOW_MS) return;
    const later = scope.slice(at + 1);
    const where = `${roomName} ${post.id}`;
    const deliveries = post.deliveries ?? [];
    for (const d of deliveries) {
      if (d.state === "failed" || (d.state === "queued" && now - post.at >= ANSWER_GRACE_MS)) {
        items.push({ kind: "delivery_error", sig: `delivery:${room}/${post.id}/${d.target}`, agent: d.name, text: `${where} to ${d.name} is ${d.state} after ${ago(now - post.at)}`, link: input.link(post), at: post.at });
      }
    }
    if (now - post.at < ANSWER_GRACE_MS) return;
    const edited = scope.slice(0, at).some(prev => theirs(prev.author) && (prev.editedAt ?? 0) > post.at);
    const covered = direct(post) || edited || later.some(next => isAgent(next.author) || direct(next));
    if (covered) return;
    if (!deliveries.length && kind === "channel") {
      items.push({ kind: "delivery_error", sig: `delivery:${room}/${post.id}/none`, agent: "", text: `${where} reached no agent: "${oneLine(post.text ?? "", 60)}"`, link: input.link(post), at: post.at });
      return;
    }
    const to = involved?.map(agent => agent.name).join(", ") || deliveries.map(d => d.name).join(", ") || roomName;
    items.push({ kind: "owner_unanswered", sig: `post:${room}/${post.id}`, agent: to, text: `${where}, ${ago(now - post.at)} with no answer from ${to}: "${oneLine(post.text ?? "", 70)}"`, link: input.link(post), at: post.at });
  });
  return items;
}

/**
 * The open steps of a plan with no live job, no running wait, no board.wake the app still owes for it and no open owner todo; `last` gives a
 * job's newest entry time when known. A step's wakes are read as the board tells a chat its unowned steps (`wokenStep` in
 * legacy/prime/user-history/src/apps-step-owners.ts), from the wakes in `wakes`.
 */
export function stalledSteps(input: {
  agent: Agent; plan: readonly PlanItem[]; todos: readonly Todo[]; jobs: readonly Job[]; now: number; seen: Record<string, number>; last?: (job: Job) => number | undefined;
  wakes?: readonly Wake[];
}): Item[] {
  const { agent, todos, jobs, now, seen } = input;
  const held = new Set(todos.filter(t => !t.done && t.step).map(t => t.step!));
  const mine = jobs.filter(job => job.agent?.id === agent.id);
  const chat: AppsChat = { id: agent.id, name: agent.name, board: null, duties: [], thread: agent.thread, jobs: mine.map(job => ({ name: job.name, state: job.status, sessionId: job.id })) };
  const reads = appsOwnerReads(chat, [], input.wakes ?? [], now);
  const items: Item[] = [];
  const visit = (list: readonly PlanItem[]): void => {
    for (const step of list) {
      visit(step.children ?? []);
      if (step.status === "done" || step.status === "dropped") continue;
      if ((step.children ?? []).some(child => child.status !== "done" && child.status !== "dropped")) continue;
      const until = typeof step.waitUntil === "string" ? Date.parse(step.waitUntil) : step.waitUntil;
      if ((until && until > now) || step.waitFor || held.has(step.id)) continue;
      if (wokenStep({ id: step.id, job: step.job, waitUntil: typeof step.waitUntil === "string" ? step.waitUntil : undefined }, reads)) continue;
      const named = step.job ? mine.filter(job => job.name === step.job) : [];
      if (named.some(job => job.status === "working" || job.status === "sleeping" || now - (input.last?.(job) ?? 0) < STUCK_MS)) continue;
      const key = `${agent.id}/${step.id}`;
      const since = Math.min(seen[key] ?? now, ...named.map(job => job.createdAt));
      const job = named.find(j => j.status === "failed") ?? named[0];
      const why = step.job ? (job ? `its job ${step.job} is ${job.status}` : `its job ${step.job} is gone`) : "no job";
      items.push({
        kind: "step_stalled", sig: `step:${key}`, agent: agent.name, text: `${agent.name} ${step.id} ${step.status}, ${why}, open ${since < now ? `${ago(now - since)}+` : "since this run"}: ${oneLine(step.text, 70)}`,
        link: `#/agents/${agent.id}`, at: since, ...(step.note?.trim() ? { context: [`note: ${oneLine(step.note, 240)}`] } : {}),
      });
    }
  };
  visit(input.plan);
  return items;
}

/** The newest entry time of each conversation asked for in one thread file, read only; empty when the file is not on this box. */
export function lastEntries(file: string, conversations: readonly number[]): Map<number, number> {
  const out = new Map<number, number>();
  if (!existsSync(file) || !conversations.length) return out;
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const rows = db.prepare("SELECT record FROM entries WHERE conversation_id = ? ORDER BY id DESC LIMIT 5");
    for (const conversation of conversations) {
      for (const row of rows.all(conversation) as { record: string }[]) {
        const record = JSON.parse(row.record) as { model?: { timestamp?: number }[] };
        const at = Math.max(0, ...(record.model ?? []).map(m => m.timestamp ?? 0));
        if (at > (out.get(conversation) ?? 0)) out.set(conversation, at);
      }
    }
  } finally {
    db.close();
  }
  return out;
}

/**
 * What pi-host's newest task of a conversation is doing, read only from its thread file, such as "sleeping: waiting for an account slot";
 * undefined when the file or the task is not there.
 */
export function taskState(file: string, conversation: number): string | undefined {
  if (!existsSync(file)) return undefined;
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const row = db.prepare("SELECT status, record FROM tasks WHERE conversation_id = ? ORDER BY id DESC LIMIT 1").get(conversation) as { status: string; record: string } | undefined;
    if (!row) return undefined;
    const record = JSON.parse(row.record) as { state?: { checkpoint?: { handle?: { data?: { message?: unknown } } } } };
    const said = record.state?.checkpoint?.handle?.data?.message;
    return `pi-host task ${row.status}${typeof said === "string" ? `: ${said}` : ""}`;
  } catch {
    return undefined;
  } finally {
    db.close();
  }
}

/**
 * Whether a duty job's thread has had no model turn yet while its newest task still runs, read only from its thread file: it waits for a
 * model account. On 11-24 the 10:23 KST sweep's job waited from 10:24 KST past 13:40 KST, and the 13:24 run read findings_unposted 2 as a
 * miss, which a sweep nobody could judge does not earn.
 */
export function noModelTurn(file: string): boolean {
  if (!existsSync(file)) return false;
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const answered = db.prepare("SELECT 1 FROM entries WHERE json_extract(record, '$.kind') = 'pi.assistant' LIMIT 1").get();
    const task = db.prepare("SELECT status FROM tasks WHERE conversation_id = 1 ORDER BY id DESC LIMIT 1").get() as { status: string } | undefined;
    return !answered && !!task && task.status !== "terminal";
  } catch {
    return false;
  } finally {
    db.close();
  }
}

/**
 * The jobs pi-host flags as retrying, the working jobs with no entry for 45 min and the jobs that failed in the last 24 h; `task` gives a
 * stuck job's pi-host task state. A retrying job reads as retrying, never as stuck, since its run still tries.
 */
export function jobFindings(jobs: readonly Job[], last: (job: Job) => number | undefined, now: number, task?: (job: Job) => string | undefined): Item[] {
  const items: Item[] = [];
  for (const job of jobs) {
    const at = last(job);
    const agent = job.agent?.name ?? "";
    if (job.retrying && (job.status === "working" || job.status === "sleeping")) {
      items.push({
        kind: "job_retrying", sig: `retrying:${job.id}`, agent, text: `${agent} job "${job.name}" is ${job.retrying}`, link: `#/c/${job.id}`,
        ...(at === undefined ? {} : { at }), context: [`started ${ago(now - job.createdAt)} ago, ${job.retrying}`],
      });
    } else if (job.status === "working" && at !== undefined && now - at >= STUCK_MS) {
      const state = task?.(job);
      items.push({
        kind: "job_stuck", sig: `stuck:${job.id}`, agent, text: `${agent} job "${job.name}" reads working with no new entry for ${ago(now - at)}${state?.includes("account slot") ? ", waiting for a model account" : ""}`,
        link: `#/c/${job.id}`, at, ...(state ? { context: [`started ${ago(now - job.createdAt)} ago, ${state}`] } : {}),
      });
    } else if (job.status === "failed" && at !== undefined && now - at < FAILED_WINDOW_MS) {
      items.push({ kind: "job_failed", sig: `failed:${job.id}`, agent, text: `${agent} job "${job.name}" failed ${ago(now - at)} ago`, link: `#/c/${job.id}`, at });
    }
  }
  return items;
}

/** Stuck jobs that wait for a model account fold into one item when there are 3 or more, since they share one cause: the pool. */
export function poolWaits(items: readonly Item[], now: number): Item[] {
  const waiting = items.filter(item => item.kind === "job_stuck" && item.text.endsWith("waiting for a model account"));
  if (waiting.length < 3) return [...items];
  const oldest = Math.min(...waiting.map(item => item.at ?? now));
  const folded: Item = {
    kind: "job_stuck", sig: "stuck:pool", agent: [...new Set(waiting.map(item => item.agent).filter(Boolean))].join(", "),
    text: `${waiting.length} jobs wait for a model account, the oldest with no new entry for ${ago(now - oldest)}`, link: waiting[0]!.link, at: oldest,
    context: [...waiting.slice(0, 5).map(item => `${item.text.replace(/, waiting for a model account$/, "")} (${item.link})`), ...(waiting.length > 5 ? [`and ${waiting.length - 5} more`] : [])],
  };
  return [...items.filter(item => !waiting.includes(item)), folded];
}

/** A duty's last three measured runs and the fix step of its newest, one line each, for the reviewer to judge a miss without opening it. */
export function dutyContext(runs: readonly DutyRunView[]): string[] {
  const kst = (at: number): string => new Date(at + 9 * HOUR).toISOString().slice(5, 16).replace("T", " ");
  const lines = runs.filter(run => run.verdict !== "skipped").slice(0, 3).map(run =>
    `${kst(run.at)} KST ${run.after?.verdict ?? run.verdict}: ${oneLine(run.after?.summary ?? run.error ?? run.summary ?? "", 120)}`);
  const fixes = Object.entries(runs[0]?.fixes ?? {}).map(([key, fix]) => `${key} fix step ${fix.step}${fix.job ? `, job ${fix.job} ${fix.live ? "live" : "not live"}` : ", no job"}`);
  return [...lines, ...fixes];
}

type DutyMissInput = {
  agent: Agent; dutyId: string; runs: readonly DutyRunView[]; plan: readonly PlanItem[]; jobs: readonly Job[]; now: number; wakes?: readonly Wake[];
};

/**
 * Why a duty's miss is with its owner already, or undefined: the duty's first measured run, whose own duty job got its brief, or for each
 * metric the newest run missed an open fix step that names that duty and metric (`duty` is `<dutyId>/<metric>`) whose job works or sleeps
 * or that a board.wake or a working subagent moves (`wokenStep`), or a closed fix step for it that a board.wake of the agent's work thread
 * still names. A step for another metric of the duty covers nothing: agent factory d2 read passed on through p235 while its
 * slowest_api_p90_ms step p155 had no job. On 11-24 Crawler guy's d1 and d2 missed on their first runs at 15:00 KST, each with fix steps
 * (p48, p50, p42) whose jobs worked, and the auditor's 15:32 KST verify run still counted both as findings nobody had passed on. At 10:24 KST
 * on 11-25 agent factory d2 read not passed on: p155 was moved by its wake, but search_p90_ms and thread_open_p90_ms had only p279 and p278,
 * closed once their fixes were live, while the work thread's wake "p278 and p279: ..." waited to read his new lines.
 */
export function passedOn(input: DutyMissInput): string | undefined {
  const fixes = dutyFixes(input);
  if (typeof fixes === "string") return fixes;
  const { missed, moved } = fixes;
  return missed.length && missed.every(key => moved.has(key)) ? missed.map(key => moved.get(key)!).join("; ") : undefined;
}

/** The missed metrics of a duty's newest run that no fix step moves (`passedOn`), as the line its item shows; undefined when none. */
export function unmovedMetrics(input: DutyMissInput): string | undefined {
  const fixes = dutyFixes(input);
  if (typeof fixes === "string") return undefined;
  const left = fixes.missed.filter(key => !fixes.moved.has(key));
  return left.length ? `not passed on: no fix step a job, board.wake or subagent moves for ${left.join(", ")}` : undefined;
}

function dutyFixes(input: DutyMissInput): string | { missed: string[]; moved: Map<string, string> } {
  const { agent, dutyId, now } = input;
  const measured = input.runs.filter(run => run.verdict !== "skipped");
  if (measured.length === 1 && measured[0]!.job) return `first run of the duty, its job ${measured[0]!.job.name} has it`;
  const newest = measured[0];
  const metrics = newest?.after?.metrics ?? newest?.metrics ?? {};
  const missed = Object.entries(metrics).filter(([, result]) => !result.met).map(([key]) => key);
  if (!missed.length) return { missed, moved: new Map() };
  const mine = input.jobs.filter(job => job.agent?.id === agent.id);
  const chat: AppsChat = { id: agent.id, name: agent.name, board: null, duties: [], thread: agent.thread, jobs: mine.map(job => ({ name: job.name, state: job.status, sessionId: job.id })) };
  const reads = appsOwnerReads(chat, [], input.wakes ?? [], now);
  const moved = new Map<string, string>();
  const visit = (list: readonly PlanItem[]): void => {
    for (const step of list) {
      visit(step.children ?? []);
      if (!step.duty) continue;
      const [id, key] = step.duty.split("/");
      if (id !== dutyId || !key || !missed.includes(key) || moved.has(key)) continue;
      if (step.status === "done" || step.status === "dropped") {
        // Only a wake the work thread owes moves a closed step, never its job, which may sleep on other work.
        if (wokenStep({ id: step.id }, reads)) moved.set(key, `${key} fix step ${step.id} (closed), a board.wake of the work thread still names it`);
        continue;
      }
      const live = step.job ? mine.find(job => job.name === step.job && (job.status === "working" || job.status === "sleeping")) : undefined;
      if (live) moved.set(key, `${key} fix step ${step.id}, job ${live.name} ${live.status}`);
      else if (wokenStep({ id: step.id, job: step.job, waitUntil: typeof step.waitUntil === "string" ? step.waitUntil : undefined }, reads)) moved.set(key, `${key} fix step ${step.id}, a board.wake or subagent moves it`);
    }
  };
  visit(input.plan);
  return { missed, moved };
}

/**
 * Splits items into the ones worth a look now (new, or last raised 24 h ago or more) and the state the next run reads. With `mark` false the
 * fresh items stay unraised, so they carry to the next run, as while an earlier sweep's job has had no model turn (`noModelTurn`).
 */
export function worthALook(items: readonly Item[], state: SweepState, now: number, mark = true): { fresh: Item[]; next: SweepState } {
  const raised = state.raised ?? {};
  const fresh = items.filter(item => !item.passedOn && (raised[item.sig] === undefined || now - raised[item.sig]! >= RERAISE_MS));
  const keep = new Set(items.map(item => item.sig));
  const nextRaised = Object.fromEntries(Object.entries(raised).filter(([sig]) => keep.has(sig)));
  if (mark) for (const item of fresh) nextRaised[item.sig] = now;
  return { fresh, next: { raised: nextRaised } };
}

/**
 * Whether a sweep's findings reached the owner: "posted" when the agent's DM holds a post of the agent's after `since`, "nothing" when the
 * job's last answer was "nothing to report", "pending" while the job sent a report the work thread has not posted yet, and "none" when the
 * job sent nothing at all.
 */
export function reportState(input: { dm: readonly Post[]; agent: string; since: number; answer: readonly string[] }): "posted" | "nothing" | "pending" | "none" {
  if (input.dm.some(post => post.author.id === input.agent && post.at > input.since)) return "posted";
  const said = input.answer.map(text => text.trim()).filter(Boolean);
  if (said.some(text => /^nothing to report\.?$/i.test(text))) return "nothing";
  return said.length ? "pending" : "none";
}

/**
 * The texts of a job's newest finished turn that said something: what it sent with send_message, and its final answer. A later empty
 * turn, such as one on a [skill-route] notice the job got after its report (11-22), does not hide the report.
 */
export function answerOf(items: readonly { kind: string; live?: boolean; text?: string; sent?: string[] }[]): string[] {
  const turn = [...items].reverse().find(item => item.kind === "turn" && !item.live && [...(item.sent ?? []), item.text ?? ""].some(text => text.trim()));
  return turn ? [...(turn.sent ?? []), turn.text ?? ""] : [];
}

/**
 * How a run of the sweep counts, from PRECHECK_MODE and PRECHECK_TRIGGER. `confirm`: the headline asks whether the last sweep's findings
 * were passed on (after mode, and a verify run, which the board starts when the sweep's fix step closes). `mark`: this run's fresh items are
 * raised and the state moves on, which only a scheduled, owner or push run does. A verify run that marked its items started a new sweep job:
 * on 11-24 the auditor closed p18 at 15:32 KST with d1 at 0, and the verify run found 2 fresh items and read red until that job got a turn.
 */
export function sweepMode(mode: string | undefined, trigger: string | undefined): { mode: "run" | "after" | "peek"; confirm: boolean; mark: boolean } {
  if (mode === "after") return { mode: "after", confirm: true, mark: false };
  if (mode === "peek") return { mode: "peek", confirm: false, mark: false };
  return trigger === "verify" ? { mode: "run", confirm: true, mark: false } : { mode: "run", confirm: false, mark: true };
}

async function get<T>(server: string, path: string): Promise<T> {
  const res = await fetch(`${server}${path}`);
  if (!res.ok) throw new Error(`GET ${path} answered ${res.status}`);
  return await res.json() as T;
}

interface Hit { conversation: { id: string; kind: string; name: string }; messageId: string; threadRoot?: string; kind: string; role: string; at: number; link: string }

if (import.meta.url === `file://${process.argv[1]}`) {
  const { values } = parseArgs({ options: { agent: { type: "string" }, server: { type: "string" }, "threads-dir": { type: "string" }, "data-dir": { type: "string" } } });
  // peek reads like run and writes no state: the judging turn runs it when it starts late, so it judges fresh data (PRECHECK_MODE=peek).
  const { mode, confirm, mark } = sweepMode(process.env.PRECHECK_MODE, process.env.PRECHECK_TRIGGER);
  const lastRuns: RunRecord[] = process.env.LAST_RUNS_FILE && existsSync(process.env.LAST_RUNS_FILE) ? JSON.parse(readFileSync(process.env.LAST_RUNS_FILE, "utf8") || "[]") : [];
  const server = values.server ?? process.env.APPS_CHAT_URL ?? "http://127.0.0.1:5184";
  const threadsDir = values["threads-dir"] ?? join(homedir(), ".prime/agent/pi-host/durable/threads");
  const started = Date.now();
  const now = started;
  const state: SweepState & { seen?: Record<string, number> } = process.env.STATE_FILE && existsSync(process.env.STATE_FILE)
    ? JSON.parse(readFileSync(process.env.STATE_FILE, "utf8") || "{}") : {};

  const [agents, jobs, recent, wakes] = await Promise.all([
    get<Agent[]>(server, "/api/agents"), get<Job[]>(server, "/api/jobs"), get<{ hits: Hit[] }>(server, `/api/search/recent?after=${now - POST_WINDOW_MS}`),
    owedWakesOf(values["data-dir"] ?? process.env.APPS_CHAT_DATA_DIR ?? join(homedir(), ".pi/agent/chat"), now),
  ]);
  const agentIds = new Set(agents.map(agent => agent.id));
  const liveJobs = jobs.filter(job => job.agent && agentIds.has(job.agent.id));
  const items: Item[] = [];

  // Owner posts of the last 3 h, read with their rooms' posts so every answer, delivery and reaction is in view.
  const ownerHits = recent.hits.filter(hit => hit.kind === "post" && hit.role === "owner");
  const byRoom = new Map<string, Hit[]>();
  for (const hit of ownerHits) byRoom.set(hit.conversation.id, [...byRoom.get(hit.conversation.id) ?? [], hit]);
  await Promise.all([...byRoom].map(async ([room, hits]) => {
    const first = hits[0]!.conversation;
    const kind = first.kind === "dm" ? "dm" : "channel";
    const name = kind === "dm" ? `DM ${first.name}` : `#${first.name}`;
    const roots = (await get<{ items: (Post & { kind: string })[] }>(server, `/api/c/${room}/items?limit=200`)).items.filter(p => p.kind === "message");
    const threadIds = new Set([...hits.flatMap(hit => hit.threadRoot ? [hit.threadRoot] : []),
      ...roots.filter(p => p.author.kind === "owner" && p.at >= now - POST_WINDOW_MS && p.thread).map(p => p.id)]);
    const threads = new Map(await Promise.all([...threadIds].map(async root =>
      [root, (await get<{ items: Post[] }>(server, `/api/c/${room}/replies/${root}`)).items.filter(p => p.id !== root)] as const)));
    const link = (root?: string) => (post: Post) => `#/c/${room}${root ? `?thread=${root}&m=${post.id}` : `?m=${post.id}`}`;
    items.push(...postFindings({ room, roomName: name, kind, scope: roots, ownThread: kind === "channel" ? root => threads.get(root) ?? [] : undefined, link: link(), now }));
    const names = new Map(agents.map(agent => [agent.id, agent.name]));
    for (const [root, replies] of threads) {
      const head = roots.find(p => p.id === root);
      const ids = new Set([...head?.author && isAgent(head.author) ? [head.author.id] : [], ...head?.mentions ?? [], ...replies.filter(p => isAgent(p.author)).map(p => p.author.id)]);
      const involved = [...ids].flatMap(id => names.has(id) ? [{ id, name: names.get(id)! }] : []);
      items.push(...postFindings({ room, roomName: name, kind, scope: replies, link: link(root), now, involved }));
    }
  }));

  // Jobs: entry times from each thread file, read once per job.
  const times = new Map<string, number | undefined>();
  const lastOf = (job: Job): number | undefined => {
    if (!times.has(job.id)) times.set(job.id, lastEntries(join(threadsDir, `${job.thread}.sqlite`), [job.conversation]).get(job.conversation));
    return times.get(job.id);
  };
  const taskOf = (job: Job): string | undefined => taskState(join(threadsDir, `${job.thread}.sqlite`), job.conversation);
  items.push(...poolWaits(jobFindings(liveJobs.filter(job => job.status === "working" || job.status === "failed"), lastOf, now, taskOf), now));
  for (const agent of agents) {
    if (agent.id === values.agent || !/fable/i.test(agent.model?.id ?? "")) continue;
    items.push({ kind: "model_off", sig: `model:${agent.id}/${agent.model!.id}`, agent: agent.name, text: `${agent.name}'s work thread runs ${agent.model!.label ?? agent.model!.id}, so its comm threads and duty jobs do too`, link: `#/agents/${agent.id}` });
  }
  for (const agent of agents) {
    if (agent.status === "failed") items.push({ kind: "job_failed", sig: `failed:${agent.thread}`, agent: agent.name, text: `${agent.name}'s work thread failed`, link: `#/c/${agent.thread}` });
    for (const comm of agent.comm ?? []) {
      if (comm.status === "failed") items.push({ kind: "job_failed", sig: `failed:${comm.thread}`, agent: agent.name, text: `${agent.name}'s comm thread for ${comm.room} failed`, link: `#/c/${comm.thread}` });
    }
  }

  // Boards and duties, per agent.
  const seen: Record<string, number> = {};
  await Promise.all(agents.map(async agent => {
    const [board, duties] = await Promise.all([
      get<{ board: { plan: PlanItem[]; todos: Todo[] } | null }>(server, `/api/agents/${agent.id}/board`).catch(() => ({ board: null })),
      get<{ duties: { duty: { id: string; name: string }; paused: boolean; last: { verdict: string; at: number; streak: number } | null; runs: DutyRunView[] }[] }>(server, `/api/agents/${agent.id}/duties`).catch(() => ({ duties: [] })),
    ]);
    if (board.board) {
      const steps = stalledSteps({ agent, plan: board.board.plan, todos: board.board.todos ?? [], jobs: liveJobs, now, seen: state.seen ?? {}, last: lastOf, wakes });
      for (const step of steps) seen[step.sig.slice("step:".length)] = Math.min(state.seen?.[step.sig.slice("step:".length)] ?? now, step.at ?? now);
      items.push(...steps);
    }
    for (const row of duties.duties) {
      // This agent's own sweep duty is the one judging, so its misses are never a finding of it.
      if (agent.id === values.agent || row.paused || !row.last || (row.last.verdict !== "missed" && row.last.verdict !== "error")) continue;
      const run = row.runs[0];
      const why = oneLine(run?.after?.summary ?? run?.error ?? run?.summary ?? "", 110);
      const miss = { agent, dutyId: row.duty.id, runs: row.runs, plan: board.board?.plan ?? [], jobs: liveJobs, now, wakes };
      const has = passedOn(miss);
      const left = has ? undefined : unmovedMetrics(miss);
      items.push({ kind: "duty_off", sig: `duty:${agent.id}/${row.duty.id}`, agent: agent.name, text: `${agent.name} ${row.duty.id} "${row.duty.name}" ${row.last.verdict}${row.last.streak > 1 ? `, ${row.last.streak} runs in a row` : ""}: ${why}`, link: `#/agents/${agent.id}`, at: row.last.at,
        context: [...dutyContext(row.runs), ...(has ? [`passed on: ${has}`] : []), ...(left ? [left] : [])], ...(has ? { passedOn: has } : {}) });
    }
  }));

  // A run while the last sweep's job has had no model turn measures nothing it could pass on: the headline is left out (not measured), the
  // fresh items stay unraised so they carry to the next run, and the job reads them when its turn comes (its brief's peek).
  const waiting = mode === "run" ? lastRuns.find(run => run.job) : undefined;
  const waits = waiting?.job && noModelTurn(join(threadsDir, `${waiting.job.id}.sqlite`)) ? waiting : undefined;
  const { fresh, next } = worthALook(items, state, now, mark && !waits);
  const freshSigs = new Set(fresh.map(item => item.sig));
  const stamp = new Date(now).toISOString().slice(0, 19).replace(/[-T:]/g, "");
  const detailFile = process.env.OUTPUT_FILE ? process.env.OUTPUT_FILE.replace(/\.json$/, "") + ".items.md" : join(homedir(), "work/fable-sweep", `${stamp}.items.md`);
  mkdirSync(dirname(detailFile), { recursive: true });
  const sections = KINDS.map(kind => {
    const list = items.filter(item => item.kind === kind).sort((a, b) => (a.at ?? now) - (b.at ?? now));
    return list.length ? [`## ${KIND_WORDS[kind][1]} (${list.length})`, ...list.map(item => [`- ${freshSigs.has(item.sig) ? "" : item.passedOn ? "(passed on) " : "(raised before) "}${item.text} [open](${item.link})`, ...(item.context ?? []).map(line => `  - ${line}`)].join("\n"))].join("\n") : "";
  }).filter(Boolean);
  writeFileSync(detailFile, [`# Everything at a glance, ${new Date(now).toISOString().slice(0, 16)}Z`,
    `${fresh.length} items worth a look of ${items.length} open. Items marked "raised before" were in a sweep less than 24 h ago, and items marked "passed on" ` +
    "have a fix step its owner works on or are a duty's first run. Links open on :5184.", ...sections].join("\n\n") + "\n");

  // The headline: in run mode this sweep's fresh findings; in after mode and a verify run the measured run's findings until the owner's DM
  // has them, so a verify run's fresh items wait for the next scheduled sweep.
  let unposted = fresh.length;
  let report = "";
  const measured = lastRuns.find(run => run.job);
  if (confirm) {
    const runFresh = measured ? measured.metrics?.findings_unposted?.value ?? state.lastRun?.fresh ?? 0 : 0;
    unposted = runFresh;
    const agent = agents.find(a => a.id === values.agent);
    if (runFresh && measured?.job && agent?.room) {
      const deadline = Date.now() + ANSWER_GRACE_MS;
      for (;;) {
        const [dm, job] = await Promise.all([
          get<{ items: Post[] }>(server, `/api/c/${agent.room}/items?limit=20`),
          get<{ items: { kind: string; live?: boolean; text?: string; sent?: string[] }[] }>(server, `/api/c/${measured.job.id}/items?limit=50`),
        ]);
        report = reportState({ dm: dm.items, agent: agent.id, since: measured.at, answer: answerOf(job.items) });
        if (report === "posted" || report === "nothing") unposted = 0;
        if (report !== "pending" || Date.now() >= deadline) break;
        await new Promise(done => setTimeout(done, 15_000));
      }
    }
  }
  const previous = lastRuns[0];

  const counts = (list: readonly Item[]) => KINDS.map(kind => [kind, list.filter(item => item.kind === kind).length] as const).filter(([, n]) => n);
  const flagged = confirm
    ? [{ kind: "findings_unposted", sig: "unposted", excerpt: `The sweep of ${measured ? new Date(measured.at).toISOString().slice(0, 16) : "?"}Z found ${unposted} items, and its report ${report === "none" ? "was empty" : "is not in the owner's DM yet"}. Every item is in ${detailFile}.` }]
    : [
      { kind: "findings_unposted", sig: "summary", excerpt: `${fresh.length} worth a look of ${items.length} open: ${counts(fresh).map(([kind, n]) => counted(kind, n)).join(", ") || "nothing new"}. Every item with its link is in ${detailFile}.` },
      ...KINDS.flatMap(kind => {
        const list = fresh.filter(item => item.kind === kind);
        return list.length ? [{ kind, sig: kind, excerpt: `${oneLine(list[0]!.text, 150)} (${list[0]!.link})${list.length > 1 ? `, and ${list.length - 1} more` : ""}` }] : [];
      }),
    ];
  const held = waits ? [{ kind: "outside_wait", sig: "account", excerpt: `the sweep job ${waits.job!.name} has had no model turn since ${new Date(waits.at).toISOString().slice(0, 16)}Z ` +
    `(${taskState(join(threadsDir, `${waits.job!.id}.sqlite`), 1) ?? "no task state"}), so its ${fresh.length} fresh items carry to the next run` }] : [];
  const output = {
    metrics: {
      ...waits ? {} : { findings_unposted: unposted }, sweep_age_min: previous ? Math.round((now - previous.at) / MIN) : 0,
      items_fresh: fresh.length, items_open: items.length, ...Object.fromEntries(counts(items)),
    },
    flagged: waits ? held : unposted ? flagged : [],
    mode, ...(report ? { report } : {}), detailFile, ms: Date.now() - started,
    items: items.map(item => ({ ...item, fresh: freshSigs.has(item.sig) })),
  };
  if (process.env.STATE_FILE && mark) writeFileSync(process.env.STATE_FILE, JSON.stringify({ ...next, seen, lastRun: { at: now, fresh: fresh.length } }));
  const json = JSON.stringify(output, null, 1);
  if (process.env.OUTPUT_FILE) writeFileSync(process.env.OUTPUT_FILE, json);
  else process.stdout.write(`${json}\n`);
}
