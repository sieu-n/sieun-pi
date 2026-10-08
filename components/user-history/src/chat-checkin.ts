import { snapshotJsonFile, transactJsonFile, type JsonFile } from "./locked-json.ts";
import { BOARD_LIMITS, planJob } from "./shared/chat-board.ts";
import { CHAT_CHECK_IN_LINE } from "./shared/chat-feed.ts";
import { CHECK_IN_MAX_MINUTES, CHECK_IN_MIN_MINUTES, type ChatBoard, type CheckInPause, type ChildAgent, type OwnerTodo, type PlanItem, type PlanStatus, type SessionRow } from "./shared/types.ts";

/**
 * The server's check-in for a chat: at its own interval (CHECK_IN_MS unless the owner set another, see CheckInSetting) it reads the chat's jobs (its subagents, and every thread an open plan step names as its
 * owner) and the board, compares them with what it saw last time, and steers the chat only with the changes that need the VP. No change, no
 * model call.
 */
export const CHECK_IN_MS = 15 * 60_000;
/** A job that runs with no activity for this long is reported once as stale, until its activity moves again. */
export const STALE_MS = 30 * 60_000;
/** A thread that owns a todo or doing step and stays idle this long is reported, once per idle stretch. */
export const THREAD_IDLE_MS = 60 * 60_000;
/** A check-in this soon after the last steer the server sent the chat waits and joins the next one. */
export const CHECK_IN_MERGE_MS = 60_000;
/** An open step with no board change and no owner activity for this long is reported, once per stretch of this length. */
export const STEP_STALE_MS = 2 * 60 * 60_000;
/** A step with `waitFor` is left alone for this long after the chat last changed it; then it counts as quiet like any other. */
export const STEP_WAIT_FOR_MS = 24 * 60 * 60_000;
/** A todo or doing step the chat itself owns that has not moved for this long is pushed, once per stretch of this length. */
export const OWN_STEP_MS = 60 * 60_000;
/**
 * A blocked step whose note says it waits on the owner's choice or action ("waits on the owner's approval", "needs your go", "owner must decide",
 * "waiting for you to sign in"). A single word such as "owner" or "go" is not enough: notes name the owner and land events ("delete after land 25
 * is live, per the owner") without waiting on them. The status must be blocked too: later phases are blocked by design and a todo or doing
 * step is being worked.
 */
const WAITS_ON_OWNER = /\b(?:wait(?:s|ing)?\s+(?:on|for)\s+(?:the\s+)?(?:owner|you|your)|needs?\s+(?:the\s+)?(?:owner|you|your)|(?:owner|you)\s+(?:must|has\s+to|have\s+to|needs?\s+to|should)|(?:owner|your)'?s?\s+(?:go|approval|decision|answer|choice|login|sign[ -]?in|ok)\b)/i;
const STOP_WORDS = new Set(["about", "after", "again", "before", "could", "every", "first", "other", "owner", "should", "still", "their", "there", "these", "think", "those", "under", "until", "which", "while", "would"]);
/** A failed turn (the chat's own, or a step owner's) is acted on again after these waits, then every 20 min while it stays failed. */
export const RETRY_BACKOFF_MS: readonly number[] = [5 * 60_000, 10 * 60_000, 20 * 60_000];
/** Whether retry number `attempts` (0 for the first) is due: its wait has passed since `since` (the failure, or the last retry). */
export const retryDue = (attempts: number, since: number, now: number): boolean =>
  now - since >= RETRY_BACKOFF_MS[Math.min(attempts, RETRY_BACKOFF_MS.length - 1)]!;
const MAX_LINES = 6;
/** The open steps listed under the changes when a tick wakes the chat, oldest change first. */
const MAX_OPEN = 30;

export type JobState = "working" | "ended" | "failed";
/**
 * One owner as the check-in sees it now: a subagent of the chat, or a thread a step names. `key` is stable across ticks: the child id, or
 * `thread:<sessionId>` for a thread. `messages` is a thread's message count.
 */
export interface JobFact {
  key: string; name: string; state: JobState; activityAt?: number; replied?: boolean; error?: string; messages?: number;
  /** A subagent the chat cancelled or deleted: it ended, and no line reports it. */
  cancelled?: true;
  /** The plan item this owner works on, an open one when it has several. */
  item?: { id: string; text: string; status: PlanStatus };
  /** A subagent's last agent message to the chat (`lastJobMessages`), and when the server last saw it start working. */
  lastMessage?: JobMessage; wokeAt?: number;
}
/** One agent message a job sent the chat: when, and its first line. */
export interface JobMessage { at: number; text: string }
/** `failedAt`/`retries`/`retriedAt`: an owner of an open step that stays failed is reported again on the RETRY_BACKOFF_MS schedule. */
export interface JobMemo {
  state: JobState; activityAt?: number; messages?: number; stale?: true; failedAt?: number; retries?: number; retriedAt?: number;
  /** The time of the job message last reported as waiting, and the activity time of the thread owner last reported as idle. */
  waited?: number; idle?: number;
}
/**
 * One plan item as last seen: what it said, when that last changed, when it was last reported as quiet, the `sig` at which it was reported as
 * waiting on the owner with no ask, and the `waitUntil` already reported as come.
 */
export interface StepMemo { sig: string; at: number; nudged?: number; asked?: string; due?: string }

/** The words of a text that can tell one step from another: five letters or more, not a common word. */
const distinctiveWords = (text: string): Set<string> => new Set(text.toLowerCase().match(/[a-z][a-z0-9-]{4,}/g)?.filter(word => !STOP_WORDS.has(word)) ?? []);
/** Whether an open agent todo is about the step: it names the step's id, else it shares a distinctive word with the step's text. */
export function todoForStep(step: Pick<PlanItem, "id" | "text">, todos: readonly Pick<OwnerTodo, "text">[]): boolean {
  const id = new RegExp(`\\b${step.id}\\b`);
  const words = distinctiveWords(step.text);
  return todos.some(todo => id.test(todo.text) || [...distinctiveWords(todo.text)].some(word => words.has(word)));
}
/** Whether an open step waits on the owner: its note says so (WAITS_ON_OWNER). */
export const waitsOnOwner = (item: PlanItem): boolean => item.status === "blocked" && WAITS_ON_OWNER.test(item.note ?? "");
/** A condition reported once when it starts or changes (`key`), then again every STEP_STALE_MS while it holds. */
export interface Reminder { key: string; at: number }
/**
 * What the last tick saw for one chat: each job, each plan item, the agent todos the owner had answered, the plan steps already reported as
 * ready, and the board read error and the open-ask overflow last reported.
 */
export interface CheckInMemory {
  at: number; jobs: Record<string, JobMemo>; steps: Record<string, StepMemo>; answered: string[]; ready: string[];
  boardError?: Reminder; asks?: Reminder;
}
/** What the digest needs besides the facts and the board: the chat's own id and name (a step it owns says "you"), and a board read error. */
export interface CheckInContext { self?: readonly string[]; boardError?: string }

const OPEN: ReadonlySet<PlanStatus> = new Set(["todo", "doing", "blocked"]);
const CLOSED: ReadonlySet<PlanStatus> = new Set(["done", "dropped"]);

function walk(items: readonly PlanItem[], visit: (item: PlanItem, parent: PlanItem | null, siblings: readonly PlanItem[], index: number) => void, parent: PlanItem | null = null): void {
  items.forEach((item, index) => { visit(item, parent, items, index); walk(item.children, visit, item); });
}

export const childWorking = (child: ChildAgent): boolean => child.status === "running" || child.status === "queued" || child.activity !== undefined;
export const childName = (child: ChildAgent): string => child.sessionName ?? child.label;

/** Who owns a plan item: its `job` (a child name or id, a session name or id, `thread:<id>`), else the first `thread:<id>` link in its note. */
export function stepOwner(item: PlanItem): string | undefined {
  return planJob(item.job) ?? /\bthread:([a-zA-Z0-9_-]{1,128})/.exec(item.note ?? "")?.[1];
}
const owns = (fact: JobFact, owner: string): boolean => fact.key === owner || fact.name === owner || fact.key === "thread:" + owner;
const ownerOf = (item: PlanItem, facts: readonly JobFact[]): JobFact | undefined => {
  const owner = stepOwner(item);
  return owner === undefined ? undefined : facts.find(fact => owns(fact, owner));
};

/**
 * The chat's jobs now: every subagent directly under it (one whose parent is not another listed subagent), plus every thread an open plan step
 * names as its owner (`stepOwner`) that is not one of them. An owner that names nothing known, or the chat itself (`self`, its session id), is
 * left out. A cancelled subagent ended; only an error is a failure.
 */
export function jobFacts(children: readonly ChildAgent[], board: ChatBoard | null, rows: readonly SessionRow[], self?: string): JobFact[] {
  const ids = new Set(children.map(child => child.id));
  const facts = new Map<string, JobFact>();
  for (const child of children) {
    if (child.parentId !== undefined && ids.has(child.parentId)) continue;
    const state: JobState = childWorking(child) ? "working" : child.status === "error" ? "failed" : "ended";
    facts.set(child.id, { key: child.id, name: childName(child), state, ...(state === "ended" && child.status === "cancelled" ? { cancelled: true as const } : {}),
      ...(child.lastActivityAt !== undefined ? { activityAt: child.lastActivityAt } : {}),
      ...(child.repliedSinceTask !== undefined ? { replied: child.repliedSinceTask } : {}), ...(child.error ? { error: child.error } : {}) });
  }
  walk(board?.plan ?? [], item => {
    const owner = stepOwner(item);
    if (owner === undefined) return;
    const link = { id: item.id, text: item.text, status: item.status };
    const known = [...facts.values()].find(fact => owns(fact, owner));
    if (known) { if (!known.item || (CLOSED.has(known.item.status) && OPEN.has(item.status))) known.item = link; return; }
    if (!OPEN.has(item.status)) return;
    const row = rows.find(candidate => candidate.id === owner || candidate.name === owner);
    if (!row || row.id === self) return;
    const at = Date.parse(row.lastActivityAt ?? "");
    facts.set("thread:" + row.id, { key: "thread:" + row.id, name: row.name, state: row.working ? "working" : row.failure ? "failed" : "ended",
      ...(Number.isFinite(at) ? { activityAt: at } : {}), ...(row.failure ? { error: row.failure } : {}), messages: row.messageCount, item: link });
  });
  return [...facts.values()];
}

/** The agent's todos the owner has not answered yet; the board refuses a new one past BOARD_LIMITS.openAsks, but older ones stay. */
export const openAsks = (board: ChatBoard | null): number => (board?.todos ?? []).filter(todo => todo.from === "agent" && !todo.done).length;

/**
 * The tick runs for a chat with a job at work, an open plan step (todo, doing, blocked), a board it cannot read, or more open owner asks than
 * the limit; otherwise it is paused.
 */
export function checkInDue(facts: readonly JobFact[], board: ChatBoard | null, boardError?: string): boolean {
  if (boardError || openAsks(board) > BOARD_LIMITS.openAsks || facts.some(fact => fact.state === "working")) return true;
  let open = false;
  walk(board?.plan ?? [], item => { if (OPEN.has(item.status)) open = true; });
  return open;
}

/** Plan steps that can start: status todo, no job, every earlier step under the same goal done or dropped, and the goal itself still open. */
export function readySteps(board: ChatBoard | null): PlanItem[] {
  const ready: PlanItem[] = [];
  walk(board?.plan ?? [], (item, parent, siblings, index) => {
    if (!parent || CLOSED.has(parent.status) || item.status !== "todo" || item.job) return;
    if (siblings.slice(0, index).every(earlier => CLOSED.has(earlier.status))) ready.push(item);
  });
  return ready;
}

const clip = (text: string, max = 60) => text.length > max ? text.slice(0, max - 1) + "…" : text;
const quote = (text: string) => `"${clip(text)}"`;
const ownerLabel = (fact: JobFact) => fact.key.startsWith("thread:") ? `${clip(fact.name, 40)} thread` : `job ${fact.name}`;
/** "p7 (usage backend thread)" for an owner with a plan item, else "job api-audit" or "usage backend thread". */
const factLabel = (fact: JobFact) => fact.item ? `${fact.item.id} (${ownerLabel(fact)})` : ownerLabel(fact);
const STATE_WORD: Record<JobState, string> = { working: "working", ended: "idle", failed: "failed" };
function ago(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 120) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} h` : `${Math.round(hours / 24)} d`;
}

/** What a quiet-step line asks of the chat. */
export const STALL_ACT = ": change it at this check-in (chase the blocker, start a job, add one owner todo, or set waitUntil or waitFor)";

/** Whether a reminder for `key` is due: a new or changed condition at once, the same one again after STEP_STALE_MS. */
const reminderDue = (before: Reminder | undefined, key: string, now: number): boolean => before?.key !== key || now - before.at >= STEP_STALE_MS;

/**
 * One tick: the memory to keep, the lines that need the VP, and every open leaf step (an open item with no open child) as a line, oldest change
 * first, to list under them. With no memory (the first tick) only conditions are reported (a stale job or step, a ready step); transitions need
 * a before. A job counts as finished when it was working last tick, or when it is new since then and its last activity came after it; a
 * cancelled one gives no line, one whose last message since its wake says it waits gives that message once, and a message since its wake is
 * its report. A thread owner gives no line for going idle: it is reported when it posted messages since the last tick, and once per idle
 * stretch when it owns a todo or doing step and stays idle THREAD_IDLE_MS. An owner of an open step
 * that stays failed is reported again on the RETRY_BACKOFF_MS schedule. A plan item's last change is when its status, text or owner last
 * differed (the board's `updatedAt` for one never seen before); a note edit is no change. An open item with no open child that had no change,
 * no change below it and no owner activity for STEP_STALE_MS is reported, once per stretch of that length, as a line the chat must act on. A
 * step that waits on purpose is not: one with `waitUntil` still ahead, or with `waitFor` for STEP_WAIT_FOR_MS after its last change. When its
 * `waitUntil` passes, that is reported once, and the quiet count starts again from then. A board read error keeps the last
 * steps and is reported, and so are more open owner asks than BOARD_LIMITS.openAsks; each again every STEP_STALE_MS while it holds.
 */
export function checkInDigest(previous: CheckInMemory | undefined, facts: readonly JobFact[], board: ChatBoard | null, now: number, context: CheckInContext = {}):
  { memory: CheckInMemory; lines: string[]; open: string[] } {
  const lines: string[] = [];
  const jobs: Record<string, JobMemo> = {};
  /** Steps whose thread owner was just reported idle: their quiet-step line would say the same. */
  const idleSteps = new Set<string>();
  for (const fact of facts) {
    const before = previous?.jobs[fact.key];
    const label = factLabel(fact);
    const thread = fact.key.startsWith("thread:");
    const stale = fact.item && !CLOSED.has(fact.item.status) && fact.item.status !== "blocked" ? `; the board still says ${fact.item.status}` : "";
    const wasWorking = before ? before.state === "working" : previous !== undefined && (fact.activityAt ?? 0) > previous.at;
    const ended = fact.state !== "working" && (wasWorking || (before !== undefined && before.state !== fact.state));
    const report = jobReport(fact);
    const memo: JobMemo = { state: fact.state, ...(fact.activityAt !== undefined ? { activityAt: fact.activityAt } : {}), ...(fact.messages !== undefined ? { messages: fact.messages } : {}),
      ...(before?.waited !== undefined ? { waited: before.waited } : {}), ...(before?.idle !== undefined && before.idle === fact.activityAt ? { idle: before.idle } : {}) };
    const added = before?.messages !== undefined && fact.messages !== undefined ? fact.messages - before.messages : 0;
    const jobEnded = ended && !thread && !fact.cancelled && fact.state === "ended";
    if (ended && fact.state === "failed") lines.push(`${label} failed${fact.error ? `: ${clip(fact.error, 120)}` : ""}${stale}`);
    else if (jobEnded && report.waits) {
      if (before?.waited !== report.waits.at) lines.push(`${label} waits: ${quote(report.waits.text)}`);
      memo.waited = report.waits.at;
    } else if (jobEnded) lines.push(`${label} finished${report.reported ? "" : " with no report"}${stale}`);
    else if ((!ended || thread) && fact.state !== "working" && added > 0) lines.push(`${label} has ${added} new ${added === 1 ? "message" : "messages"} and is ${STATE_WORD[fact.state]}${stale}`);
    if (thread && fact.state === "ended" && fact.item && (fact.item.status === "todo" || fact.item.status === "doing") && fact.activityAt !== undefined &&
      now - fact.activityAt >= THREAD_IDLE_MS && memo.idle !== fact.activityAt) {
      lines.push(`${label} idle for ${ago(now - fact.activityAt)}`);
      memo.idle = fact.activityAt;
      idleSteps.add(fact.item.id);
    }
    if (fact.state === "working" && fact.activityAt !== undefined && now - fact.activityAt > STALE_MS) {
      memo.stale = true;
      if (!(before?.stale && before.activityAt === fact.activityAt)) lines.push(`${label}: no activity for ${Math.round((now - fact.activityAt) / 60_000)} min`);
    }
    if (fact.state === "failed" && fact.item && OPEN.has(fact.item.status)) {
      const failedAt = before?.state === "failed" ? before.failedAt ?? now : now;
      let retries = before?.state === "failed" ? before.retries ?? 0 : 0;
      let retriedAt = before?.state === "failed" ? before.retriedAt : undefined;
      if (retryDue(retries, retriedAt ?? failedAt, now)) {
        lines.push(`${label} is still stopped: its last turn failed ${ago(now - failedAt)} ago${fact.error ? `: ${clip(fact.error, 120)}` : ""}`);
        retries++;
        retriedAt = now;
      }
      Object.assign(memo, { failedAt, ...(retries ? { retries } : {}), ...(retriedAt !== undefined ? { retriedAt } : {}) });
    }
    jobs[fact.key] = memo;
  }

  const self = new Set(context.self ?? []);
  const openTodos = (board?.todos ?? []).filter(todo => todo.from === "agent" && !todo.done);
  /** Asks already answered: a step whose question the owner answered does not need a new one. */
  const answeredTodos = (board?.todos ?? []).filter(todo => todo.done || (todo.reply ?? "").trim() !== "");
  const firstSeen = Math.min(now, Date.parse(board?.updatedAt ?? "") || now);
  const steps: Record<string, StepMemo> = context.boardError ? { ...previous?.steps } : {};
  const open: { at: number; line: string }[] = [];
  /** Visits an item after its children; returns when it or anything below it last moved (a board change or owner activity). */
  const visit = (item: PlanItem): { moved: number; open: boolean } => {
    let moved = 0, openBelow = false;
    for (const child of item.children) { const below = visit(child); moved = Math.max(moved, below.moved); openBelow ||= below.open; }
    const sig = JSON.stringify([item.status, item.text, planJob(item.job) ?? "", ...(item.waitUntil || item.waitFor ? [item.waitUntil ?? "", item.waitFor ?? ""] : [])]);
    const before = previous?.steps[item.id];
    const memo: StepMemo = { sig, at: before ? before.sig === sig ? before.at : now : firstSeen, ...(before?.nudged !== undefined ? { nudged: before.nudged } : {}),
      ...(before?.due !== undefined && before.due === item.waitUntil ? { due: before.due } : {}) };
    const mine = self.has(stepOwner(item) ?? "");
    const owner = mine ? undefined : ownerOf(item, facts);
    moved = Math.max(moved, memo.at, owner?.activityAt ?? 0);
    const isOpen = OPEN.has(item.status);
    const until = Date.parse(item.waitUntil ?? "");
    const waiting = (Number.isFinite(until) && until > now) || (item.waitFor !== undefined && now - memo.at < STEP_WAIT_FOR_MS);
    if (isOpen && !openBelow && Number.isFinite(until) && until <= now && memo.due !== item.waitUntil) {
      lines.push(`${item.id} was waiting until ${localTime(until)}; that time has come`);
      memo.due = item.waitUntil!;
      memo.nudged = now;
    } else if (!waiting && mine && !openBelow && (item.status === "todo" || item.status === "doing") && now - Math.max(moved, memo.nudged ?? 0) >= OWN_STEP_MS) {
      lines.push(`${item.id} is yours and has not moved for ${ago(now - moved)}: act now, start a job or decide`);
      memo.nudged = now;
    } else if (!waiting && isOpen && !openBelow && now - Math.max(moved, memo.nudged ?? 0) >= STEP_STALE_MS) {
      if (!idleSteps.has(item.id)) lines.push(`${item.id} ${quote(item.text)} is ${item.status} with no board change and no owner activity for ${ago(now - moved)}${STALL_ACT}`);
      memo.nudged = now;
    }
    if (isOpen && !openBelow && waitsOnOwner(item) && !todoForStep(item, openTodos) && !todoForStep(item, answeredTodos)) {
      if (before?.asked !== sig) lines.push(`${item.id} waits on the owner but For you has no question for it: add one with choices`);
      memo.asked = sig;
    }
    if (isOpen && !openBelow) {
      const who = mine ? "owner you" : owner ? `owner ${ownerLabel(owner)} (${owner.cancelled ? "ended" : STATE_WORD[owner.state]})` : item.job ? `owner ${item.job} (not found)` : "no owner";
      const waits = `${Number.isFinite(until) ? `, waits until ${localTime(until)}` : ""}${item.waitFor ? `, waits for ${quote(item.waitFor)}` : ""}`;
      open.push({ at: memo.at, line: `${item.id} ${quote(item.text)} ${item.status}, ${who}${waits}, last change ${ago(now - memo.at)} ago` });
    }
    steps[item.id] = memo;
    return { moved, open: isOpen || openBelow };
  };
  for (const item of board?.plan ?? []) visit(item);

  /** The reminder to keep for a condition that holds now; `line` is added when it is due. */
  const remind = (before: Reminder | undefined, key: string, line: string): Reminder => {
    if (!reminderDue(before, key, now)) return before!;
    lines.push(line);
    return { key, at: now };
  };
  const boardError = context.boardError ? remind(previous?.boardError, context.boardError, `the board cannot be read: ${clip(context.boardError, 160)}; call chat_board again`) : undefined;
  const askCount = openAsks(board);
  const asks = context.boardError ? previous?.asks : askCount > BOARD_LIMITS.openAsks
    ? remind(previous?.asks, String(askCount), `${askCount} open owner todos; keep ${BOARD_LIMITS.openAsks}: decide or remove the rest`) : undefined;

  const answered = context.boardError ? undefined : (board?.todos ?? []).filter(todo => todo.from === "agent" && todo.reply !== undefined);
  if (previous && answered) for (const todo of answered) if (!previous.answered.includes(todo.id)) lines.push(`owner answered ${todo.id} ${quote(todo.text)}: ${clip(todo.reply!, 120)}`);
  const ready = context.boardError ? undefined : readySteps(board);
  if (ready) for (const step of ready) if (!previous?.ready.includes(step.id)) lines.push(`${step.id} ${quote(step.text)} can start: the steps before it are done and it has no job`);
  const shown = lines.length > MAX_LINES ? [...lines.slice(0, MAX_LINES - 1), `and ${lines.length - MAX_LINES + 1} more`] : lines;
  const sorted = open.sort((a, b) => a.at - b.at).map(entry => entry.line);
  const listed = sorted.length > MAX_OPEN ? [...sorted.slice(0, MAX_OPEN - 1), `and ${sorted.length - MAX_OPEN + 1} more`] : sorted;
  return { memory: { at: now, jobs, steps, answered: answered?.map(todo => todo.id) ?? previous?.answered ?? [], ready: ready?.map(step => step.id) ?? previous?.ready ?? [],
    ...(boardError ? { boardError } : {}), ...(asks ? { asks } : {}) }, lines: shown, open: listed };
}

/** The steer text for a tick that wakes the chat: what changed, then every open plan item so none is skipped. */
export const checkInMessage = (prefix: string, lines: readonly string[], open: readonly string[]): string =>
  `${prefix}What changed:\n${lines.map(line => `- ${line}`).join("\n")}` +
  (open.length ? `\n\nOpen steps, oldest change first:\n${open.map(line => `- ${line}`).join("\n")}` : "");

/**
 * Subagents that just ended a follow-up task (one sent after the first, so the status did not change) without messaging the chat. The daemon's
 * own notice (`rlm_child_terminal_notice`) covers a first task that ends with no reply, and a failure; this covers the rest. A child the daemon
 * cannot vouch for (`repliedSinceTask` unknown) is not reported.
 */
export function endedWithoutReport(before: readonly ChildAgent[], after: readonly ChildAgent[]): ChildAgent[] {
  const previous = new Map(before.map(child => [child.id, child]));
  return after.filter(child => {
    const was = previous.get(child.id);
    return was !== undefined && childWorking(was) && !childWorking(child) && was.status === child.status && child.status !== "cancelled" &&
      child.repliedSinceTask === false;
  });
}

/** A finished job is deleted once it has been quiet this long; the check runs at most once per JOB_CLEANUP_EVERY_MS per chat. */
export const JOB_CLEANUP_IDLE_MS = 60 * 60_000;
export const JOB_CLEANUP_EVERY_MS = 10 * 60_000;

/**
 * The chat's finished jobs to delete (each holds a worker process and a Python kernel until it is deleted): a direct subagent that is done, sent
 * its final report (`repliedSinceTask` true), has been quiet JOB_CLEANUP_IDLE_MS, and that no open step keeps: one it owns, or one waiting on
 * purpose (`waitUntil`, `waitFor`) whose `waitFor` names it.
 */
export function finishedJobs(children: readonly ChildAgent[], board: ChatBoard | null, now: number): ChildAgent[] {
  const ids = new Set(children.map(child => child.id));
  const keeps: { owner?: string; waitFor?: string }[] = [];
  walk(board?.plan ?? [], item => {
    if (!OPEN.has(item.status)) return;
    const owner = stepOwner(item);
    keeps.push({ ...(owner !== undefined ? { owner } : {}), ...(item.waitFor ? { waitFor: item.waitFor } : {}) });
  });
  return children.filter(child => {
    if (child.parentId !== undefined && ids.has(child.parentId)) return false;
    if (child.status !== "done" || childWorking(child) || child.repliedSinceTask !== true) return false;
    if (child.lastActivityAt === undefined || now - child.lastActivityAt < JOB_CLEANUP_IDLE_MS) return false;
    const names = [child.id, childName(child), child.label];
    return !keeps.some(keep => (keep.owner !== undefined && names.includes(keep.owner)) || (keep.waitFor !== undefined && names.some(name => keep.waitFor!.includes(name))));
  });
}

/** Each job's last agent message to the chat, by the name its header gives (`[agent-message from child:<name>]`, the `child:` cut). */
export function lastJobMessages(messages: readonly { role: string; customType?: string; content?: unknown; timestamp?: number }[]): Map<string, JobMessage> {
  const last = new Map<string, JobMessage>();
  for (const message of messages) {
    if (message.role !== "custom" || message.customType !== "agent_message") continue;
    const text = typeof message.content === "string" ? message.content
      : Array.isArray(message.content) ? message.content.map(part => typeof part === "object" && part && "text" in part ? String((part as { text: unknown }).text) : "").join("") : "";
    const header = /^\s*\[agent-message from\s+(?:child:)?([^\]]+)\]/.exec(text);
    if (!header) continue;
    last.set(header[1]!.trim(), { at: message.timestamp ?? 0, text: text.slice(header[0].length).split("\n").map(line => line.trim()).find(Boolean) ?? "" });
  }
  return last;
}
/** A job message that says the job waits on someone: a slot, a go, a review, an answer. */
const SAYS_WAITS = /\b(?:wait(?:s|ing)?\b|slot\b|(?:your|the owner's|a)\s+(?:go|ok|word|call|review|answer|approval)\b|ready\s+for\s+(?:review|your)|blocked\s+(?:on|by)\b|before\s+i\s+(?:go\s+on|continue|push|commit))/i;
/**
 * What a job that stopped told the chat: `reported` unless the daemon says it did not reply and it sent no message at or after its last wake
 * (an unknown wake counts any message); `waits` when that message says it waits on someone.
 */
export function jobReport(fact: Pick<JobFact, "replied" | "lastMessage" | "wokeAt">): { reported: boolean; waits?: JobMessage } {
  const message = fact.lastMessage;
  const after = message !== undefined && message.at >= (fact.wokeAt ?? 0);
  return { reported: fact.replied !== false || after, ...(after && SAYS_WAITS.test(message.text) ? { waits: message } : {}) };
}

/**
 * The `[job]` notice for a job that went quiet while the daemon says it did not reply to its task: one that messaged the chat at or after its
 * last wake asked something and waits for an answer, since that message; any other ended at its last activity with no report.
 */
export function noReportNotice(name: string, message: JobMessage | undefined, wokeAt: number, end: number): string {
  return message !== undefined && message.at >= wokeAt
    ? `${name} is waiting for you since ${clockTime(message.at)} (last message: "${clip(message.text, 140)}")`
    : `${name} ended at ${clockTime(end)} with no report`;
}

/** `<data dir>/check-ins.json`: the last tick's memory per chat, through locked-json. */
export interface CheckInRecord {
  get(id: string): Promise<CheckInMemory | undefined>;
  set(id: string, memory: CheckInMemory): Promise<void>;
  forget(id: string): Promise<void>;
}
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
function parseMemory(value: unknown): CheckInMemory | undefined {
  if (!isRecord(value) || typeof value.at !== "number" || !isRecord(value.jobs) || !Array.isArray(value.answered) || !Array.isArray(value.ready)) return undefined;
  return { ...(value as unknown as CheckInMemory), steps: isRecord(value.steps) ? value.steps as CheckInMemory["steps"] : {} };
}
export function checkInRecord(path: string): CheckInRecord {
  const file: JsonFile<{ chats: Record<string, CheckInMemory> }> = { path, label: "Check-in record", initial: () => ({ chats: {} }), parse(value: unknown) {
    const chats = isRecord(value) && isRecord(value.chats) ? value.chats : {};
    return { chats: Object.fromEntries(Object.entries(chats).flatMap(([id, memo]) => { const parsed = parseMemory(memo); return parsed ? [[id, parsed]] : []; })) };
  } };
  return {
    async get(id) { return (await snapshotJsonFile(file)).chats[id]; },
    async set(id, memory) { await transactJsonFile(file, state => { state.chats[id] = memory; }); },
    async forget(id) { await transactJsonFile(file, state => { delete state.chats[id]; }); },
  };
}

/** A chat's check-in choices: its interval, and a pause until a time or until the owner resumes it, with who paused it. */
export type CheckInPausedUntil = number | "forever";
export type CheckInBy = "owner" | "chat";
export interface CheckInSetting { everyMs: number; pausedUntil?: CheckInPausedUntil; pausedBy?: CheckInBy }
export const DEFAULT_CHECK_IN: CheckInSetting = { everyMs: CHECK_IN_MS };

/** An interval the owner may set: whole minutes from 1 to 240. */
export const validCheckInEvery = (ms: unknown): ms is number =>
  typeof ms === "number" && Number.isSafeInteger(ms) && ms % 60_000 === 0 && ms >= CHECK_IN_MIN_MINUTES * 60_000 && ms <= CHECK_IN_MAX_MINUTES * 60_000;

/** When a pause the owner picks at `now` ends: in an hour, at the next 09:00 local time, or never. */
export function pauseEnd(pause: CheckInPause, now: number): CheckInPausedUntil {
  if (pause === "forever") return "forever";
  if (pause === "1h") return now + 60 * 60_000;
  const nine = new Date(now);
  nine.setHours(9, 0, 0, 0);
  if (nine.getTime() <= now) nine.setDate(nine.getDate() + 1);
  return nine.getTime();
}

/** The pause still in force at `now`; an expired one is no pause. */
export const activePause = (setting: CheckInSetting, now: number): CheckInPausedUntil | null =>
  setting.pausedUntil === "forever" || (setting.pausedUntil !== undefined && setting.pausedUntil > now) ? setting.pausedUntil : null;

/** When the chat's next check-in runs, given its last one: never while paused until resumed, not before a pause ends. Due when it is not after `now`. */
export function nextCheckIn(setting: CheckInSetting, lastAt: number, now: number): number | null {
  const pause = activePause(setting, now);
  if (pause === "forever") return null;
  return Math.max(lastAt + setting.everyMs, pause ?? 0);
}

/** A time as the owner's local "YYYY-MM-DD HH:MM". */
export const localTime = (at: number): string => {
  const date = new Date(at);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
};
/** A time as the owner's local "HH:MM", for a notice about one event today. */
export const clockTime = (at: number): string => localTime(at).slice(11);
/** The line the chat_board tool shows the chat about its own check-in. */
export function checkInLine(setting: CheckInSetting, now: number): string {
  const pause = activePause(setting, now);
  if (pause === "forever") return "Check-in: paused until the owner resumes it";
  if (pause !== null) return `Check-in: paused until ${localTime(pause)}`;
  return `Check-in: every ${setting.everyMs / 60_000} min`;
}

/** What the owner (through the chat server) or the chat (through chat_board `check_in`) changes: the interval, and a pause (null resumes). */
export interface CheckInChange { everyMs?: number; pause?: CheckInPause | null }

/**
 * A change applied to a chat's setting at `now`. Whoever writes later wins, with one limit: the chat cannot pause or resume over a pause the
 * owner set that is still in force (the refusal says why), and it cannot pause until resumed. Its interval change always applies.
 */
export function changeCheckIn(current: CheckInSetting, change: CheckInChange, now: number, by: CheckInBy): { setting: CheckInSetting } | { refused: string } {
  const pause = activePause(current, now);
  if (by === "chat" && change.pause !== undefined) {
    if (change.pause === "forever") return { refused: "a chat pauses its check-ins for 1h or until tomorrow 09:00; only the owner pauses them until resumed" };
    if (pause !== null && current.pausedBy !== "chat") return { refused: `the owner paused check-ins ${pause === "forever" ? "until they resume them" : `until ${localTime(pause)}`}; that stays` };
  }
  const everyMs = change.everyMs ?? current.everyMs;
  if (change.pause === undefined) return { setting: { everyMs, ...(pause !== null ? { pausedUntil: pause, ...(current.pausedBy ? { pausedBy: current.pausedBy } : {}) } : {}) } };
  if (change.pause === null) return { setting: { everyMs } };
  return { setting: { everyMs, pausedUntil: pauseEnd(change.pause, now), pausedBy: by } };
}

/** The chat_board `check_in` argument, parsed: `pause` "1h", "tomorrow" or null (resume), `every_minutes` a whole number from 1 to 240. Throws on anything else. */
export function parseChatCheckIn(value: unknown): CheckInChange {
  if (!isRecord(value)) throw new Error("check_in: give {pause} and/or {every_minutes}");
  const change: CheckInChange = {};
  if ("pause" in value) {
    if (value.pause !== null && value.pause !== "1h" && value.pause !== "tomorrow") throw new Error('check_in.pause: "1h", "tomorrow" (09:00) or null to resume');
    change.pause = value.pause;
  }
  if ("every_minutes" in value) {
    const everyMs = typeof value.every_minutes === "number" ? value.every_minutes * 60_000 : NaN;
    if (!validCheckInEvery(everyMs)) throw new Error(`check_in.every_minutes: a whole number from ${CHECK_IN_MIN_MINUTES} to ${CHECK_IN_MAX_MINUTES}`);
    change.everyMs = everyMs;
  }
  if (change.pause === undefined && change.everyMs === undefined) throw new Error("check_in: give {pause} and/or {every_minutes}");
  return change;
}

/**
 * The chat's own change to its check-in, written to the owner's setting store under its lock: the line the tool returns first (the feed
 * shows it as a quiet line), or an error with the refusal.
 */
export async function chatCheckIn(settings: CheckInSettings, id: string, change: CheckInChange, now: number): Promise<string> {
  let refused: string | undefined;
  const setting = await settings.update(id, current => {
    const result = changeCheckIn(current, change, now, "chat");
    if ("refused" in result) { refused = result.refused; return current; }
    return result.setting;
  });
  if (refused) throw new Error(`check_in refused: ${refused}`);
  const pause = activePause(setting, now);
  const what = change.pause === undefined ? `every ${setting.everyMs / 60_000} min` : pause === null ? `resumed, every ${setting.everyMs / 60_000} min`
    : `paused until ${pause === "forever" ? "the owner resumes it" : localTime(pause)}${change.everyMs !== undefined ? `, then every ${setting.everyMs / 60_000} min` : ""}`;
  return CHAT_CHECK_IN_LINE + what;
}

/** `<data dir>/check-in-settings.json`: `{ [chatId]: CheckInSetting }` through locked-json. The owner writes it through the chat server, the chat through chat_board `check_in`. */
export interface CheckInSettings {
  all(): Promise<Record<string, CheckInSetting>>;
  get(id: string): Promise<CheckInSetting>;
  update(id: string, change: (setting: CheckInSetting) => CheckInSetting): Promise<CheckInSetting>;
}
function parseSetting(value: unknown): CheckInSetting | undefined {
  if (!isRecord(value) || !validCheckInEvery(value.everyMs)) return undefined;
  const until = value.pausedUntil;
  const pausedUntil = until === "forever" || (typeof until === "number" && Number.isFinite(until)) ? until : undefined;
  const pausedBy = value.pausedBy === "owner" || value.pausedBy === "chat" ? value.pausedBy : undefined;
  return { everyMs: value.everyMs, ...(pausedUntil !== undefined ? { pausedUntil, ...(pausedBy ? { pausedBy } : {}) } : {}) };
}
export function checkInSettings(path: string): CheckInSettings {
  const file: JsonFile<Record<string, CheckInSetting>> = { path, label: "Check-in settings", initial: () => ({}), parse(value: unknown) {
    return Object.fromEntries(Object.entries(isRecord(value) ? value : {}).flatMap(([id, entry]) => { const parsed = parseSetting(entry); return parsed ? [[id, parsed]] : []; }));
  } };
  return {
    all: () => snapshotJsonFile(file),
    async get(id) { return (await snapshotJsonFile(file))[id] ?? DEFAULT_CHECK_IN; },
    async update(id, change) {
      const { result } = await transactJsonFile(file, state => (state[id] = change(state[id] ?? DEFAULT_CHECK_IN)));
      return result;
    },
  };
}
