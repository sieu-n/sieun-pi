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
 *   job_stuck: a job that reads working whose newest entry is 45 min old or more (sieun-pi AGENTS.md rule 6 reads that as stalled), unless
 *     it waits for a model account (`waitsForAccount`, the one rule every kind reads): its turn, or the turn of a working job under it,
 *     sleeps on pi-pool's account slot, or is in flight while pi-pool holds its thread's tree `pi-durable:<thread>` in an account wait
 *     (`parkedTrees`). Such a job is alive, and `n.poolWaits` counts it. On 11-27 the 07:27, 10:28 and 12:07 KST sweeps listed two such
 *     jobs as stuck while `pi-pool who` showed each waiting for account 7bec9951 with a reserved slot.
 *   job_retrying: a job whose run pi-host flags "retrying since HH:MM: <error kind>", a transient error it has retried past 5 minutes and
 *     keeps retrying, which is no stall (packages/pi-host/src/durable/retrying.ts).
 *   job_failed: a job whose last turn failed, with an entry in the last 24 h, and an agent's work or comm thread that failed.
 *   duty_off: a duty, not paused, whose last run missed its target or errored, except a run that read not measured because its box was
 *     away or it waited outside its precheck (`notMeasured`).
 *   step_stalled: an open board step with no live job on it, no wait still running, no board.wake the app owes its job or that names it, and
 *     no open owner todo that holds it. A step whose job wrote in the last 45 min still moves, since its parent often closes the step right
 *     after the job reports (the 45 min of rule 6). A step's jobs are the job it names and every subagent under it, since a job that hands
 *     its work to subagents ends its own turn and reads idle. A step that waits for a model account is no item and `n.stepPoolWaits` counts
 *     it: one of its jobs waits, or the agent's work thread waits in its own turn and has not answered since the step last changed
 *     (`threadWaits`). The 22:31 KST sweep on 11-28 listed five such steps while 1 of 42 Claude accounts took new work: four whose jobs read
 *     idle with every subagent parked since 20:53 to 22:22 KST, and the first step of an agent made at 22:07 KST whose first turn pi-pool
 *     had parked since 22:07:51 KST.
 *   model_off: an agent other than this one whose work thread runs on Fable, which the owner keeps for this advisor (msg mwqwsgx9: "main
 *     worker들은 opus가 되면 좋겠거든? 워낙 비용이 비싸니까"), except an agent whose model he set himself from his page (`modelFindings`).
 *
 * Each item carries the context a reviewer would look up to judge it, in the detail file under its line: a duty's last three runs and its fix
 * step, a step's note, a stuck job's pi-host task state. The first Fable sweep on 11-22 spent 40 turns
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
 * Its output's `n` counts what it read, one count per kind: agents, owner posts of the window, live jobs, duties and board steps, and the
 * quiet working jobs and the open steps that wait for a model account (`poolWaits`, `stepPoolWaits`), and the duties left out as not
 * measured (`dutiesNotMeasured`).
 *
 * Usage: OUTPUT_FILE=<file> [STATE_FILE=<file>] [LAST_RUNS_FILE=<file>] [PRECHECK_MODE=run|after|peek] [PRECHECK_TRIGGER=<trigger>] node --import tsx scripts/duties/fable-sweep.ts
 *   --agent <agent id> [--server http://127.0.0.1:5184] [--threads-dir <dir>] [--data-dir <dir>]
 * Defaults: APPS_CHAT_URL else http://127.0.0.1:5184, ~/.prime/agent/pi-host/durable/threads, APPS_CHAT_DATA_DIR else ~/.pi/agent/chat, whose
 * wakes, in its folder or its chat.sqlite as the server's APPS_CHAT_DB_KINDS says, are read only. The detail file is OUTPUT_FILE with
 * `.items.md` in place of `.json`, else ~/work/fable-sweep/<stamp>.items.md, and the summary goes to OUTPUT_FILE, else stdout.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isMain } from "./main-module.ts";
import { realAgents } from "./real-agents.ts";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";
import { appsOwnerReads, wokenStep, type AppsChat } from "../../../../legacy/prime/user-history/src/apps-step-owners.ts";
import { accountSlot, pooledProviders, readPoolStatus, threadKey } from "../../../../legacy/prime/user-history/src/chat-pool.ts";
import type { Wake } from "../../../../legacy/prime/user-history/src/wakes.ts";
import { boardHold } from "../../../../legacy/prime/user-history/src/unmoved-steps.ts";
import type { HoldingTodo } from "../../../../legacy/prime/user-history/src/shared/todo-hold.ts";
import type { PlanItem as BoardItem } from "../../../../legacy/prime/user-history/src/shared/types.ts";
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
export interface Job { id: string; name: string; status: string; thread: string; conversation: number; createdAt: number; agent?: { id: string; name: string }; parent?: { id: string } | null; retrying?: string }
export interface Agent {
  id: string; name: string; status: string; thread: string; room?: string; archived?: boolean; test?: boolean; model?: { id: string; label?: string } | null;
  /** Set while the agent runs the model the owner chose for it from his own page (the server's `AgentSummary.modelSet`). */
  modelSet?: { by: string; at: number };
  comm?: { room: string; thread: string; status: string }[];
}
export interface PlanItem { id: string; text: string; status: string; note?: string; job?: string; duty?: string; waitUntil?: string | number; waitFor?: unknown; updatedAt?: string; children?: PlanItem[] }
export interface DutyRunView {
  at: number; verdict: string; summary?: string; error?: string; metrics?: Record<string, { met: boolean }>; hostAway?: string; waitsOn?: string;
  after?: { verdict?: string; summary?: string; metrics?: Record<string, { met: boolean }> }; fixes?: Record<string, { step: string; job?: string; live: boolean }> | null;
  job?: { id: string; name: string };
}
type Todo = HoldingTodo;

/** What holds a step for the owner, read by the board's own rule (`boardHold`, which d9's stuck steps read): an open For you todo that links it. */
const ownerHeld = (step: PlanItem, todos: readonly Todo[]): string | undefined => boardHold({ id: step.id, text: step.text, status: step.status as BoardItem["status"],
  ...(step.note !== undefined ? { note: step.note } : {}), ...(typeof step.waitFor === "string" ? { waitFor: step.waitFor } : {}) }, todos);

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
 * What of an agent waits for a model account (`waitsForAccount`): `job` says whether a job does, and `thread` is set while the work thread's
 * own turn does, with when that thread last answered (undefined before its first answer).
 */
export interface AgentWait { job: (job: Job) => boolean; thread?: { answered: number | undefined } }

/**
 * A step's jobs and the jobs under them, their subagents at any depth, by the `parent` each job names. A job that hands its work to
 * subagents ends its own turn and reads idle while they work or wait, so a step is read by all of them.
 */
function withSubagents(named: readonly Job[], all: readonly Job[]): Job[] {
  const ids = new Set(named.map(job => job.id));
  for (let grew = ids.size > 0; grew;) {
    grew = false;
    for (const job of all) if (job.parent && ids.has(job.parent.id) && !ids.has(job.id)) { ids.add(job.id); grew = true; }
  }
  return all.filter(job => ids.has(job.id));
}

/**
 * Whether an open step waits on the agent's work thread's wait for a model account: that thread waits in its own turn and has not answered
 * since the step last changed or one of its jobs last wrote, so it has had no turn in which to give the step an owner or to close it. A
 * step that was unowned before the thread's last answer stays an item.
 */
function threadWaits(step: PlanItem, family: readonly Job[], wait: AgentWait | undefined, last?: (job: Job) => number | undefined): boolean {
  if (!wait?.thread) return false;
  const since = Math.max(Date.parse(step.updatedAt ?? "") || 0, ...family.map(job => last?.(job) ?? 0));
  return wait.thread.answered === undefined || since > wait.thread.answered;
}

/**
 * The open steps of a plan with no live job, no running wait, no board.wake the app still owes for it and no open owner todo (`stalled`),
 * and how many more are left out because they wait for a model account (`waiting`): one of the step's jobs or their subagents waits
 * (`wait.job`), or the work thread does (`threadWaits`). A step moves while one of its jobs or their subagents works, sleeps or wrote in
 * the last 45 min; `last` gives a job's newest entry time when known. A step's wakes are read as the board tells a chat its unowned steps
 * (`wokenStep` in legacy/prime/user-history/src/apps-step-owners.ts), from the wakes in `wakes`.
 */
export function stalledSteps(input: {
  agent: Agent; plan: readonly PlanItem[]; todos: readonly Todo[]; jobs: readonly Job[]; now: number; seen: Record<string, number>; last?: (job: Job) => number | undefined;
  wakes?: readonly Wake[]; wait?: AgentWait;
}): { stalled: Item[]; waiting: number } {
  const { agent, todos, jobs, now, seen } = input;
  let waiting = 0;
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
      if ((until && until > now) || step.waitFor || ownerHeld(step, todos)) continue;
      if (wokenStep({ id: step.id, job: step.job, waitUntil: typeof step.waitUntil === "string" ? step.waitUntil : undefined }, reads)) continue;
      const named = step.job ? mine.filter(job => job.name === step.job) : [];
      const family = withSubagents(named, mine);
      if (family.some(job => input.wait?.job(job))) { waiting += 1; continue; }
      if (family.some(job => job.status === "working" || job.status === "sleeping" || now - (input.last?.(job) ?? 0) < STUCK_MS)) continue;
      if (threadWaits(step, family, input.wait, input.last)) { waiting += 1; continue; }
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
  return { stalled: items, waiting };
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
 * The `threads` whose pool tree `pi-durable:<thread>` pi-pool holds in an account wait past `now`, read as the duty card reads it (boards.ts
 * `poolWaitSince`, with the same `readPoolStatus` and `accountSlot`). A work thread, its jobs and their subagents all ask pi-pool under that
 * one tree, so this says the tree waits and not which conversation of it does (`turnOf`). Empty when the pool cannot be read.
 */
export async function parkedTrees(threads: readonly string[], now: number, read: typeof readPoolStatus = readPoolStatus): Promise<Set<string>> {
  const trees = [...new Set(threads)].map(thread => ({ session: `pi-durable:${thread}`, model: null }));
  if (!trees.length) return new Set();
  try {
    const status = await read(trees, { maxAgeMs: 0 });
    return new Set(trees.filter(tree => {
      const parts = status.threads.get(threadKey(tree));
      return !!parts && pooledProviders.some(provider => (accountSlot(parts, provider) ?? 0) > now);
    }).map(tree => tree.session.slice("pi-durable:".length)));
  } catch {
    return new Set();
  }
}

/** The deferred handle id of a task that sleeps until pi-pool has an account slot (`SLOT_HANDLE_ID`, packages/pi-pool/src/durable/pool-provider.ts). */
const SLOT_HANDLE_ID = "pi-pool-slot";

/**
 * A conversation's turn in flight, read only from its thread file: "slot" while a foreground task of it that is not terminal sleeps on
 * pi-pool's account slot, "live" while it has another such task, and undefined when it has none or the file is not on this box. It reads
 * every open foreground task, not the newest task alone: a message that reaches a parked conversation adds a newer background task.
 */
export function turnOf(file: string, conversation: number): "slot" | "live" | undefined {
  if (!existsSync(file)) return undefined;
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    // The status list and the unary pluses keep the read on the status index, a thread's few open tasks: by the conversation index it read
    // all 7,295 tasks of Search product, misc.'s work thread in 544 ms on 11-28, against 1 ms by status.
    const rows = db.prepare("SELECT json_extract(record, '$.state.checkpoint.handle.id') AS handle FROM tasks " +
      "WHERE status IN ('pending', 'running', 'waiting', 'sleeping', 'completing') AND +conversation_id = ? AND +background = 0").all(conversation) as { handle: string | null }[];
    return rows.some(row => row.handle === SLOT_HANDLE_ID) ? "slot" : rows.length ? "live" : undefined;
  } catch {
    return undefined;
  } finally {
    db.close();
  }
}

/**
 * The one rule for "waits for a model account", which stuck jobs, stalled steps, duty fix steps and an agent's own work thread all read: a
 * conversation waits when its turn sleeps on pi-pool's account slot, or is in flight while pi-pool holds its thread's tree in an account
 * wait (`parked`, from `parkedTrees`). A conversation with no turn in flight, such as a job that finished, never waits, however long its
 * agent's tree is parked.
 */
export const waitsForAccount = (turn: ReturnType<typeof turnOf>, parked: boolean): boolean => turn === "slot" || (turn === "live" && parked);

/**
 * When a conversation last got a model answer, read only from its thread file, or undefined when it has none. An answer that ended in an
 * error is none, as pi-pool's "the account slot is open" retry text is written as one.
 */
export function lastAnswer(file: string, conversation: number): number | undefined {
  if (!existsSync(file)) return undefined;
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const row = db.prepare("SELECT json_extract(record, '$.model[0].timestamp') AS at FROM entries WHERE conversation_id = ? AND json_extract(record, '$.kind') = 'pi.assistant' " +
      "AND coalesce(json_extract(record, '$.model[0].stopReason'), '') != 'error' ORDER BY id DESC LIMIT 1").get(conversation) as { at: number | null } | undefined;
    return typeof row?.at === "number" ? row.at : undefined;
  } catch {
    return undefined;
  } finally {
    db.close();
  }
}

/**
 * The agents other than `self`, the advisor, whose work thread runs on Fable. An agent whose model the owner set himself is his choice and
 * no item: on 11-28 the sweep flagged agent factory for the Fable 5.2 he had set from his page at 19:19 KST. A Fable model an agent, a job
 * or a script set is still listed.
 */
export function modelFindings(agents: readonly Agent[], self: string | undefined): Item[] {
  return agents.filter(agent => agent.id !== self && /fable/i.test(agent.model?.id ?? "") && agent.modelSet?.by !== "owner").map(agent => ({
    kind: "model_off", sig: `model:${agent.id}/${agent.model!.id}`, agent: agent.name,
    text: `${agent.name}'s work thread runs ${agent.model!.label ?? agent.model!.id}, so its comm threads and duty jobs do too`, link: `#/agents/${agent.id}`,
  }));
}

/**
 * The jobs pi-host flags as retrying, the working jobs with no entry for 45 min and the jobs that failed in the last 24 h; `task` gives a
 * stuck job's pi-host task state. A retrying job reads as retrying, never as stuck, since its run still tries. A quiet job that waits for a
 * model account, one of `waits` (`waitsForAccount`), is alive and is no item.
 */
export function jobFindings(jobs: readonly Job[], last: (job: Job) => number | undefined, now: number, task?: (job: Job) => string | undefined,
  waits: ReadonlySet<string> = new Set()): Item[] {
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
      if (waits.has(job.id)) continue;
      const state = task?.(job);
      items.push({
        kind: "job_stuck", sig: `stuck:${job.id}`, agent, text: `${agent} job "${job.name}" reads working with no new entry for ${ago(now - at)}`,
        link: `#/c/${job.id}`, at, ...(state ? { context: [`started ${ago(now - job.createdAt)} ago, ${state}`] } : {}),
      });
    } else if (job.status === "failed" && at !== undefined && now - at < FAILED_WINDOW_MS) {
      items.push({ kind: "job_failed", sig: `failed:${job.id}`, agent, text: `${agent} job "${job.name}" failed ${ago(now - at)} ago`, link: `#/c/${job.id}`, at });
    }
  }
  return items;
}

/**
 * Why a duty's newest run measured nothing it could miss, or undefined: it read error because its box was away (`hostAway`) or it waited on
 * something outside its precheck (`waitsOn`). Such a run reads not measured, so it is no finding. From 11-26 to 11-28 the sweep listed 5180
 * designer's d1 and d2 as errors while the owner's Mac slept.
 */
export function notMeasured(runs: readonly DutyRunView[]): string | undefined {
  const newest = runs.find(run => run.verdict !== "skipped");
  if (newest?.verdict !== "error") return undefined;
  return newest.hostAway ? `its box ${newest.hostAway} is away` : newest.waitsOn ? `it waits on ${newest.waitsOn}` : undefined;
}

/**
 * A duty's last three measured runs and the fix step of its newest, one line each, for the reviewer to judge a miss without opening it. A
 * fix line is what that run stored, so it says "at that run": on 11-28 agent factory's d2 item read "p279, no job" from its 22:04:23 KST
 * run at 22:31 KST, 26 min after the board put a job on p279 at 22:05:47 KST. The board as it is now is in the item's passed on line.
 */
export function dutyContext(runs: readonly DutyRunView[]): string[] {
  const kst = (at: number): string => new Date(at + 9 * HOUR).toISOString().slice(5, 16).replace("T", " ");
  const lines = runs.filter(run => run.verdict !== "skipped").slice(0, 3).map(run =>
    `${kst(run.at)} KST ${run.after?.verdict ?? run.verdict}: ${oneLine(run.after?.summary ?? run.error ?? run.summary ?? "", 120)}`);
  const fixes = Object.entries(runs[0]?.fixes ?? {}).map(([key, fix]) => `${key} fix step ${fix.step} at that run${fix.job ? `, job ${fix.job} ${fix.live ? "live" : "not live"}` : ", no job"}`);
  return [...lines, ...fixes];
}

type DutyMissInput = {
  agent: Agent; dutyId: string; runs: readonly DutyRunView[]; plan: readonly PlanItem[]; todos?: readonly Todo[]; jobs: readonly Job[]; now: number; wakes?: readonly Wake[];
  wait?: AgentWait; last?: (job: Job) => number | undefined;
};

/**
 * Why a duty's miss is with its owner already, or undefined: the duty's first measured run, whose own duty job got its brief, or for each
 * metric the newest run missed an open fix step that names that duty and metric (`duty` is `<dutyId>/<metric>`) whose job works or sleeps
 * or that a board.wake or a working subagent moves (`wokenStep`), or that an open For you todo holds (`boardHold`, as d9 reads it), or that
 * waits for a model account as a stalled step does (`stalledSteps`): at 22:31 KST on 11-28 agent factory d2 read not passed on for
 * search_p90_ms while the job on its step p279 read idle with both subagents asleep on the account slot since 22:20 KST. A closed
 * step covers nothing, and neither does a step for another metric of the duty: agent factory d2 read passed on through p235 while its
 * slowest_api_p90_ms step p155 had no job. On 11-24 Crawler guy's d1 and d2
 * missed on their first runs at 15:00 KST, each with fix steps (p48, p50, p42) whose jobs worked, and the auditor's 15:32 KST verify run still
 * counted both as findings nobody had passed on. At 10:24 KST on 11-25 agent factory d2 read not passed on because its search_p90_ms and
 * thread_open_p90_ms steps p279 and p278 were closed, and the item named only p155, which its wake moved (`unmovedMetrics` now names them).
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
      if (step.status === "done" || step.status === "dropped" || !step.duty) continue;
      const [id, key] = step.duty.split("/");
      if (id !== dutyId || !key || !missed.includes(key) || moved.has(key)) continue;
      const named = step.job ? mine.filter(job => job.name === step.job) : [];
      const family = withSubagents(named, mine);
      const works = (job: Job): boolean => job.status === "working" || job.status === "sleeping";
      const waits = family.find(job => input.wait?.job(job));
      const live = named.find(works) ?? family.find(works);
      const who = (job: Job): string => named.includes(job) ? `job ${job.name}` : `subagent ${job.name} of job ${step.job}`;
      if (waits) moved.set(key, `${key} fix step ${step.id}, ${who(waits)} waits for a model account`);
      else if (live) moved.set(key, `${key} fix step ${step.id}, ${who(live)} ${live.status}`);
      else if (wokenStep({ id: step.id, job: step.job, waitUntil: typeof step.waitUntil === "string" ? step.waitUntil : undefined }, reads)) moved.set(key, `${key} fix step ${step.id}, a board.wake or subagent moves it`);
      else {
        const hold = ownerHeld(step, input.todos ?? []);
        if (hold) moved.set(key, `${key} fix step ${step.id}, held for the owner by ${hold}`);
        else if (threadWaits(step, family, input.wait, input.last)) moved.set(key, `${key} fix step ${step.id}, the work thread waits for a model account`);
      }
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

if (isMain(import.meta.url)) {
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
    get<Agent[]>(server, "/api/agents").then(realAgents), get<Job[]>(server, "/api/jobs"), get<{ hits: Hit[] }>(server, `/api/search/recent?after=${now - POST_WINDOW_MS}`),
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
  const fileOf = (thread: string): string => join(threadsDir, `${thread}.sqlite`);
  const taskOf = (job: Job): string | undefined => taskState(fileOf(job.thread), job.conversation);
  const quiet = liveJobs.filter(job => job.status === "working" && !job.retrying && now - (lastOf(job) ?? now) >= STUCK_MS);
  // Who waits for a model account, by the one rule (`waitsForAccount`): each agent's work thread in its own turn, and each quiet working job
  // when it or a working job under it does, since a duty job whose own turn ended reads working while a subagent waits (11-27). pi-pool is
  // asked only about the trees of turns in flight that do not sleep on the slot themselves.
  const families = new Map(quiet.map(job => [job.id, withSubagents([job], liveJobs).filter(each => each.status === "working")] as const));
  const turnKey = (thread: string, conversation: number): string => `${thread}:${conversation}`;
  const judged = new Map([...[...families.values()].flat().map(job => [job.thread, job.conversation] as const), ...agents.map(agent => [agent.thread, 1] as const)]
    .map(([thread, conversation]) => [turnKey(thread, conversation), { thread, turn: turnOf(fileOf(thread), conversation) }] as const));
  const parked = await parkedTrees([...judged.values()].filter(each => each.turn === "live").map(each => each.thread), now);
  const waitingTurns = new Set([...judged].filter(([, each]) => waitsForAccount(each.turn, parked.has(each.thread))).map(([key]) => key));
  const waitingJobs = new Set(quiet.filter(job => families.get(job.id)!.some(each => waitingTurns.has(turnKey(each.thread, each.conversation)))).map(job => job.id));
  const agentWait = (agent: Agent): AgentWait =>
    ({ job: job => waitingJobs.has(job.id), ...(waitingTurns.has(turnKey(agent.thread, 1)) ? { thread: { answered: lastAnswer(fileOf(agent.thread), 1) } } : {}) });
  items.push(...jobFindings(liveJobs.filter(job => job.status === "working" || job.status === "failed"), lastOf, now, taskOf, waitingJobs));
  items.push(...modelFindings(agents, values.agent));
  for (const agent of agents) {
    if (agent.status === "failed") items.push({ kind: "job_failed", sig: `failed:${agent.thread}`, agent: agent.name, text: `${agent.name}'s work thread failed`, link: `#/c/${agent.thread}` });
    for (const comm of agent.comm ?? []) {
      if (comm.status === "failed") items.push({ kind: "job_failed", sig: `failed:${comm.thread}`, agent: agent.name, text: `${agent.name}'s comm thread for ${comm.room} failed`, link: `#/c/${comm.thread}` });
    }
  }

  // Boards and duties, per agent.
  const seen: Record<string, number> = {};
  const read = { agents: agents.length, posts: ownerHits.length, jobs: liveJobs.length, duties: 0, dutiesNotMeasured: 0, steps: 0, poolWaits: waitingJobs.size, stepPoolWaits: 0 };
  await Promise.all(agents.map(async agent => {
    const [board, duties] = await Promise.all([
      get<{ board: { plan: PlanItem[]; todos: Todo[] } | null }>(server, `/api/agents/${agent.id}/board`).catch(() => ({ board: null })),
      get<{ duties: { duty: { id: string; name: string }; paused: boolean; last: { verdict: string; at: number; streak: number } | null; runs: DutyRunView[] }[] }>(server, `/api/agents/${agent.id}/duties`).catch(() => ({ duties: [] })),
    ]);
    read.duties += duties.duties.length;
    read.steps += board.board?.plan.length ?? 0;
    const wait = agentWait(agent);
    if (board.board) {
      const steps = stalledSteps({ agent, plan: board.board.plan, todos: board.board.todos ?? [], jobs: liveJobs, now, seen: state.seen ?? {}, last: lastOf, wakes, wait });
      for (const step of steps.stalled) seen[step.sig.slice("step:".length)] = Math.min(state.seen?.[step.sig.slice("step:".length)] ?? now, step.at ?? now);
      items.push(...steps.stalled);
      read.stepPoolWaits += steps.waiting;
    }
    for (const row of duties.duties) {
      // This agent's own sweep duty is the one judging, so its misses are never a finding of it.
      if (agent.id === values.agent || row.paused || !row.last || (row.last.verdict !== "missed" && row.last.verdict !== "error")) continue;
      if (notMeasured(row.runs)) { read.dutiesNotMeasured += 1; continue; }
      const run = row.runs[0];
      const why = oneLine(run?.after?.summary ?? run?.error ?? run?.summary ?? "", 110);
      const miss = { agent, dutyId: row.duty.id, runs: row.runs, plan: board.board?.plan ?? [], todos: board.board?.todos ?? [], jobs: liveJobs, now, wakes, wait, last: lastOf };
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
    n: read,
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
