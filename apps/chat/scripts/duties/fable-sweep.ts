/**
 * Duty precheck: everything at a glance, the fable auditor's 3-hourly sweep (owner's words, dm_agent-factory, 11-22: msg mwqwpszf "Fable
 * auditor agent를 하나 만들고 싶어", then msg mwqwsgx9 "3-hourly로 모든 문제들을 전반적으로 훑어보고 문제가 될만한 부분/보고사항 제안사항
 * 특이사항을 나한테 넘기는 식으로"). It reads :5184 across every agent that is not a test or archived and lists what a reviewer should look at.
 * The Fable turn that judges it reads only this summary and, as needed, the detail file, so a quiet run costs no model turn at all.
 *
 * Kinds of items:
 *   owner_unanswered: an owner post of the last 3 h in a channel, Solo room or DM, 10 min old or more, that no agent answered: no agent post
 *     after it in its scope (its DM or thread, or for a channel root post its own thread and the channel root), no post that `answers` it, no
 *     delivery read as answered or no_reply, no agent reaction other than 👀 and no done flag. The 10 min are ten times the about one minute
 *     a comm thread takes to ack (c224).
 *   delivery_error: an owner post of the last 3 h whose delivery to an agent failed, still queued after 10 min, or that reached no agent.
 *   job_stuck: a job that reads working whose newest entry is 45 min old or more (sieun-pi AGENTS.md rule 6 reads that as stalled).
 *   job_retrying: a job whose run pi-host flags "retrying since HH:MM: <error kind>", a transient error it has retried past 5 minutes and
 *     keeps retrying, which is no stall (packages/pi-host/src/durable/retrying.ts).
 *   job_failed: a job whose last turn failed, with an entry in the last 24 h, and an agent's work or comm thread that failed.
 *   duty_off: a duty, not paused, whose last run missed its target or errored.
 *   step_stalled: an open board step with no live job on it, no wait still running and no open owner todo that holds it. A step whose job
 *     wrote in the last 45 min still moves, since its parent often closes the step right after the job reports (the 45 min of rule 6).
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
 *     record, else from the state file.
 *   sweep_age_min: minutes since the sweep before this one ran, target 195, the 180 min schedule plus 15 min.
 *   items_fresh, items_open and a count per kind are detail with no target.
 *
 * Job entry times come from the job's pi-host thread file, read only (`<threads dir>/<thread>.sqlite`), because every conversation of a
 * thread shares one `updatedAt` in the :5184 lists. A step's age is the start of the job on it, else the first run that saw it open.
 *
 * Usage: OUTPUT_FILE=<file> [STATE_FILE=<file>] [LAST_RUNS_FILE=<file>] [PRECHECK_MODE=run|after|peek] node --import tsx scripts/duties/fable-sweep.ts
 *   --agent <agent id> [--server http://127.0.0.1:5184] [--threads-dir <dir>]
 * Defaults: APPS_CHAT_URL else http://127.0.0.1:5184, ~/.prime/agent/pi-host/durable/threads. The detail file is OUTPUT_FILE with
 * `.items.md` in place of `.json`, else ~/work/fable-sweep/<stamp>.items.md, and the summary goes to OUTPUT_FILE, else stdout.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";

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

export interface Item { kind: Kind; sig: string; agent: string; text: string; link: string; at?: number; context?: string[] }
export interface SweepState { raised?: Record<string, number>; seen?: Record<string, number>; lastRun?: { at: number; fresh: number } }
/** The part of a duty run record (LAST_RUNS_FILE) this precheck reads. */
export interface RunRecord { at: number; job?: { id: string; name: string }; metrics?: Record<string, { value: number }> }

interface Author { id: string; kind: string; name?: string }
interface Delivery { target: string; name: string; state: string; at: number }
export interface Post {
  id: string; at: number; author: Author; text?: string; answers?: string; deliveries?: Delivery[];
  reactions?: { emoji: string; by: Author[] }[]; done?: { at: number }; thread?: { authors?: Author[]; lastAt?: number } | null;
}
export interface Job { id: string; name: string; status: string; thread: string; conversation: number; createdAt: number; agent?: { id: string; name: string }; retrying?: string }
interface Agent { id: string; name: string; status: string; thread: string; room?: string; model?: { id: string; label?: string }; comm?: { room: string; thread: string; status: string }[] }
interface PlanItem { id: string; text: string; status: string; note?: string; job?: string; waitUntil?: string | number; waitFor?: unknown; children?: PlanItem[] }
export interface DutyRunView { at: number; verdict: string; summary?: string; error?: string; after?: { verdict?: string; summary?: string }; fixes?: Record<string, { step: string; job?: string; live: boolean }> | null }
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
 * `scope` holds the scope's posts oldest first; `ownThread` gives a channel root post's own thread replies.
 */
export function postFindings(input: {
  room: string; roomName: string; kind: "dm" | "channel"; scope: readonly Post[]; ownThread?: (root: string) => readonly Post[]; link: (post: Post) => string; now: number;
}): Item[] {
  const { room, roomName, kind, scope, now } = input;
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
    const covered = direct(post) || later.some(next => isAgent(next.author) || direct(next));
    if (covered) return;
    if (!deliveries.length && kind === "channel") {
      items.push({ kind: "delivery_error", sig: `delivery:${room}/${post.id}/none`, agent: "", text: `${where} reached no agent: "${oneLine(post.text ?? "", 60)}"`, link: input.link(post), at: post.at });
      return;
    }
    const to = deliveries.map(d => d.name).join(", ") || roomName;
    items.push({ kind: "owner_unanswered", sig: `post:${room}/${post.id}`, agent: to, text: `${where}, ${ago(now - post.at)} with no answer from ${to}: "${oneLine(post.text ?? "", 70)}"`, link: input.link(post), at: post.at });
  });
  return items;
}

/** The open steps of a plan with no live job, no running wait and no open owner todo; `last` gives a job's newest entry time when known. */
export function stalledSteps(input: {
  agent: Agent; plan: readonly PlanItem[]; todos: readonly Todo[]; jobs: readonly Job[]; now: number; seen: Record<string, number>; last?: (job: Job) => number | undefined;
}): Item[] {
  const { agent, todos, jobs, now, seen } = input;
  const held = new Set(todos.filter(t => !t.done && t.step).map(t => t.step!));
  const mine = jobs.filter(job => job.agent?.id === agent.id);
  const items: Item[] = [];
  const visit = (list: readonly PlanItem[]): void => {
    for (const step of list) {
      visit(step.children ?? []);
      if (step.status === "done" || step.status === "dropped") continue;
      if ((step.children ?? []).some(child => child.status !== "done" && child.status !== "dropped")) continue;
      const until = typeof step.waitUntil === "string" ? Date.parse(step.waitUntil) : step.waitUntil;
      if ((until && until > now) || step.waitFor || held.has(step.id)) continue;
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

/** Splits items into the ones worth a look now (new, or last raised 24 h ago or more) and the state the next run reads. */
export function worthALook(items: readonly Item[], state: SweepState, now: number): { fresh: Item[]; next: SweepState } {
  const raised = state.raised ?? {};
  const fresh = items.filter(item => raised[item.sig] === undefined || now - raised[item.sig]! >= RERAISE_MS);
  const keep = new Set(items.map(item => item.sig));
  const nextRaised = Object.fromEntries(Object.entries(raised).filter(([sig]) => keep.has(sig)));
  for (const item of fresh) nextRaised[item.sig] = now;
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

async function get<T>(server: string, path: string): Promise<T> {
  const res = await fetch(`${server}${path}`);
  if (!res.ok) throw new Error(`GET ${path} answered ${res.status}`);
  return await res.json() as T;
}

interface Hit { conversation: { id: string; kind: string; name: string }; messageId: string; threadRoot?: string; kind: string; role: string; at: number; link: string }

if (import.meta.url === `file://${process.argv[1]}`) {
  const { values } = parseArgs({ options: { agent: { type: "string" }, server: { type: "string" }, "threads-dir": { type: "string" } } });
  // peek reads like run and writes no state: the judging turn runs it when it starts late, so it judges fresh data (PRECHECK_MODE=peek).
  const mode = process.env.PRECHECK_MODE === "after" ? "after" : process.env.PRECHECK_MODE === "peek" ? "peek" : "run";
  const lastRuns: RunRecord[] = process.env.LAST_RUNS_FILE && existsSync(process.env.LAST_RUNS_FILE) ? JSON.parse(readFileSync(process.env.LAST_RUNS_FILE, "utf8") || "[]") : [];
  const server = values.server ?? process.env.APPS_CHAT_URL ?? "http://127.0.0.1:5184";
  const threadsDir = values["threads-dir"] ?? join(homedir(), ".prime/agent/pi-host/durable/threads");
  const started = Date.now();
  const now = started;
  const state: SweepState & { seen?: Record<string, number> } = process.env.STATE_FILE && existsSync(process.env.STATE_FILE)
    ? JSON.parse(readFileSync(process.env.STATE_FILE, "utf8") || "{}") : {};

  const [agents, jobs, recent] = await Promise.all([
    get<Agent[]>(server, "/api/agents"), get<Job[]>(server, "/api/jobs"), get<{ hits: Hit[] }>(server, `/api/search/recent?after=${now - POST_WINDOW_MS}`),
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
    for (const [root, replies] of threads) items.push(...postFindings({ room, roomName: name, kind, scope: replies, link: link(root), now }));
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
      const steps = stalledSteps({ agent, plan: board.board.plan, todos: board.board.todos ?? [], jobs: liveJobs, now, seen: state.seen ?? {}, last: lastOf });
      for (const step of steps) seen[step.sig.slice("step:".length)] = Math.min(state.seen?.[step.sig.slice("step:".length)] ?? now, step.at ?? now);
      items.push(...steps);
    }
    for (const row of duties.duties) {
      // This agent's own sweep duty is the one judging, so its misses are never a finding of it.
      if (agent.id === values.agent || row.paused || !row.last || (row.last.verdict !== "missed" && row.last.verdict !== "error")) continue;
      const run = row.runs[0];
      const why = oneLine(run?.after?.summary ?? run?.error ?? run?.summary ?? "", 110);
      items.push({ kind: "duty_off", sig: `duty:${agent.id}/${row.duty.id}`, agent: agent.name, text: `${agent.name} ${row.duty.id} "${row.duty.name}" ${row.last.verdict}${row.last.streak > 1 ? `, ${row.last.streak} runs in a row` : ""}: ${why}`, link: `#/agents/${agent.id}`, at: row.last.at, context: dutyContext(row.runs) });
    }
  }));

  const { fresh, next } = worthALook(items, state, now);
  const freshSigs = new Set(fresh.map(item => item.sig));
  const stamp = new Date(now).toISOString().slice(0, 19).replace(/[-T:]/g, "");
  const detailFile = process.env.OUTPUT_FILE ? process.env.OUTPUT_FILE.replace(/\.json$/, "") + ".items.md" : join(homedir(), "work/fable-sweep", `${stamp}.items.md`);
  mkdirSync(dirname(detailFile), { recursive: true });
  const sections = KINDS.map(kind => {
    const list = items.filter(item => item.kind === kind).sort((a, b) => (a.at ?? now) - (b.at ?? now));
    return list.length ? [`## ${KIND_WORDS[kind][1]} (${list.length})`, ...list.map(item => [`- ${freshSigs.has(item.sig) ? "" : "(raised before) "}${item.text} [open](${item.link})`, ...(item.context ?? []).map(line => `  - ${line}`)].join("\n"))].join("\n") : "";
  }).filter(Boolean);
  writeFileSync(detailFile, [`# Everything at a glance, ${new Date(now).toISOString().slice(0, 16)}Z`,
    `${fresh.length} items worth a look of ${items.length} open. Items marked "raised before" were in a sweep less than 24 h ago. Links open on :5184.`, ...sections].join("\n\n") + "\n");

  // The headline: in run mode this sweep's fresh findings; in after mode the measured run's findings until the owner's DM has them.
  let unposted = fresh.length;
  let report = "";
  const measured = lastRuns.find(run => run.job);
  if (mode === "after") {
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
  const flagged = mode === "after"
    ? [{ kind: "findings_unposted", sig: "unposted", excerpt: `The sweep of ${measured ? new Date(measured.at).toISOString().slice(0, 16) : "?"}Z found ${unposted} items, and its report ${report === "none" ? "was empty" : "is not in the owner's DM yet"}. Every item is in ${detailFile}.` }]
    : [
      { kind: "findings_unposted", sig: "summary", excerpt: `${fresh.length} worth a look of ${items.length} open: ${counts(fresh).map(([kind, n]) => counted(kind, n)).join(", ") || "nothing new"}. Every item with its link is in ${detailFile}.` },
      ...KINDS.flatMap(kind => {
        const list = fresh.filter(item => item.kind === kind);
        return list.length ? [{ kind, sig: kind, excerpt: `${oneLine(list[0]!.text, 150)} (${list[0]!.link})${list.length > 1 ? `, and ${list.length - 1} more` : ""}` }] : [];
      }),
    ];
  const output = {
    metrics: {
      findings_unposted: unposted, sweep_age_min: previous ? Math.round((now - previous.at) / MIN) : 0,
      items_fresh: fresh.length, items_open: items.length, ...Object.fromEntries(counts(items)),
    },
    flagged: unposted ? flagged : [],
    mode, ...(report ? { report } : {}), detailFile, ms: Date.now() - started,
    items: items.map(item => ({ ...item, fresh: freshSigs.has(item.sig) })),
  };
  if (process.env.STATE_FILE && mode === "run") writeFileSync(process.env.STATE_FILE, JSON.stringify({ ...next, seen, lastRun: { at: now, fresh: fresh.length } }));
  const json = JSON.stringify(output, null, 1);
  if (process.env.OUTPUT_FILE) writeFileSync(process.env.OUTPUT_FILE, json);
  else process.stdout.write(`${json}\n`);
}
