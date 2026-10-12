import type { HandoffRule } from "./chat-corrections.ts";
import { finishedOpen, looksDone, pathLike } from "./checkin-done.ts";
import { heartbeatLine, oneSessionLoad, redundantHeartbeats, sessionLoadLine, type ScheduledJob, type SessionLoad } from "./checkin-load.ts";
import { REPEAT_HEAD, repeatLines } from "./checkin-repeats.ts";
export { finishedOpen, looksDone };
import { CHECK_IN_DUTY_ID, type Duty, type FlaggedSlice, type PrecheckOutput } from "./shared/chat-duties.ts";
import { snapshotJsonFile, transactJsonFile, type JsonFile } from "./locked-json.ts";
import { areaWords, BOARD_LIMITS, buildGoal, goWaitText, isBuildStep, linksStep, mergeStep, needsGo, openGoals, planJob, prNumbers, stepGo, stepGoWait, walkItems, requirementGaps, targetState, targetText, type TargetState } from "./shared/chat-board.ts";
import { CHAT_CHECK_IN_LINE } from "./shared/chat-feed.ts";
import { CHECK_IN_MAX_MINUTES, CHECK_IN_MIN_MINUTES, type BoardOp, type ChatBoard, type CheckInPause, type ChildAgent, type GoalTarget, type OwnerTodo, type PlanItem, type PlanStatus, type SessionRow, type StopReason,
  type ThreadMessage } from "./shared/types.ts";

/**
 * The check-in duty's precheck (src/shared/chat-duties.ts, `CHECK_IN_DUTY`; src/chats.ts runs it). At the chat's own interval (CHECK_IN_MS unless
 * the owner set another, see CheckInSetting) the server reads the chat's jobs (its subagents, and every thread an open plan step names as its
 * owner) and the board, sorts every open step into a class, and hands the result to one duty job as context (`checkInPrecheckText`). Code
 * measures; the duty job decides what to do.
 */
export const CHECK_IN_MS = 15 * 60_000;
/** A job at work with no activity for this long is listed as quiet in the duty job's brief. */
export const STALE_MS = 30 * 60_000;
/**
 * Progress within this long keeps a step `live` or `waiting` (`stepClass`): its owner's activity, or its own last change. Past it, a step
 * that waits on another thread or an event is a stale chase.
 */
export const STEP_STALE_MS = 2 * 60 * 60_000;
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
/** The open steps the duty job's brief lists, oldest change first. */
const MAX_OPEN = 30;

export type JobState = "working" | "ended" | "failed";
/**
 * One owner as the check-in sees it now: a subagent of the chat, or a thread a step names. `key` is stable across ticks: the child id, or
 * `thread:<sessionId>` for a thread. `messages` is a thread's message count.
 */
export interface JobFact {
  key: string; name: string; state: JobState; activityAt?: number; replied?: boolean; error?: string; messages?: number;
  /** A subagent the chat cancelled or deleted: it ended. */
  cancelled?: true;
  /** The plan item this owner works on, an open one when it has several. */
  item?: { id: string; text: string; status: PlanStatus };
  /** A subagent's last agent message to the chat (`lastJobMessages`). */
  lastMessage?: JobMessage;
}
/** One agent message a job sent the chat: when, and its first line. */
export interface JobMessage { at: number; text: string }
/**
 * One plan item as last seen: what it said (`sig`: status, text, owner, waits) and when that last changed; its wait (`wait`: waitFor, waitUntil
 * and owner) and when that last changed (`waitAt`); and the waitUntil values it has had, oldest first (`untils`, the last STALL_UNTILS kept).
 */
export interface StepMemo { sig: string; at: number; wait?: string; waitAt?: number; untils?: string[];
  /** When the item last turned done from another status; an edit to an item already done does not move it. */
  doneAt?: number }

/** The words of a text that can tell one step from another: five letters or more, not a common word. */
const distinctiveWords = (text: string): Set<string> => new Set(text.toLowerCase().match(/[a-z][a-z0-9-]{4,}/g)?.filter(word => !STOP_WORDS.has(word)) ?? []);
/**
 * Whether an open agent todo is about the step: it names the step's id or links it (`step`), the step's wait names the todo's id, or the step is
 * blocked and shares a distinctive word with it (a blocked step that "waits for the gateway todo" is covered by the gateway todo). A step at
 * work is never covered by a shared word alone (a crawler thread 10-12: a vendor support todo t22 shared "failed" or the vendor's name with 14
 * open steps, so p92 counted as For you and the no-progress check missed it).
 */
export function todoForStep(step: Pick<PlanItem, "id" | "text" | "waitFor"> & Partial<Pick<PlanItem, "status">>,
  todos: readonly (Pick<OwnerTodo, "text"> & Partial<Pick<OwnerTodo, "id" | "step">>)[]): boolean {
  const id = new RegExp(`\\b${step.id}\\b`);
  const named = new Set(step.waitFor?.match(/\bt\d+\b/g) ?? []);
  const words = step.status === undefined || step.status === "blocked" ? distinctiveWords(`${step.text} ${step.waitFor ?? ""}`) : new Set<string>();
  return todos.some(todo => id.test(todo.text) || todo.step === step.id || (todo.id !== undefined && named.has(todo.id)) ||
    [...distinctiveWords(todo.text)].some(word => words.has(word)));
}
/** Whether an open step waits on the owner: its note says so (WAITS_ON_OWNER). */
export const waitsOnOwner = (item: PlanItem): boolean => item.status === "blocked" && WAITS_ON_OWNER.test(item.note ?? "");
/** What the last check-in saw for one chat: when it ran, and each plan item's last change. */
export interface CheckInMemory { at: number; steps: Record<string, StepMemo>;
  /** When this chat's memory began (its first check-in, kept across runs): the no-progress check needs a full hour of it. */
  since?: number;
  /** How many runs in a row flagged each finding, by `flagKey` (src/checkin-repeats.ts). */
  flags?: Record<string, number> }
/**
 * What the precheck needs besides the jobs and the board: the chat's own id and name (a step it owns is `mine`), a board read error, the
 * catalog rows (the threads a step's `waitFor` can name), and the ledger's handoffs (`handoffRules`: an open step on another thread's topics).
 */
export interface CheckInContext { self?: readonly string[]; boardError?: string; rows?: readonly Pick<SessionRow, "id" | "name" | "archived">[];
  handoffs?: readonly HandoffRule[];
  /** The ids of the owner corrections in force, for parked steps (`parkedBy`); every cited id counts when not given. */
  corrections?: readonly string[];
  /** The chat's check-in interval, for when a goal's measurement goes stale (`targetStaleMs`); CHECK_IN_MS when not given. */
  everyMs?: number;
  /** The chat's duties, for the goals they run (`goalsToFold`) and a chat with goals and no duty (`goalsWithoutDuty`); not given: neither counts them. */
  duties?: readonly DutyRef[];
  /** The roots the chat started (the job registry's names or ids): its own jobs, never another session's load (`oneSessionLoad`). */
  jobs?: readonly string[];
  /** The chat's own schedules (`readHeartbeats`), for the heartbeats the check-in covers (`redundantHeartbeats`); none when not given. */
  heartbeats?: readonly ScheduledJob[] }

const OPEN: ReadonlySet<PlanStatus> = new Set(["todo", "doing", "blocked"]);
const CLOSED: ReadonlySet<PlanStatus> = new Set(["done", "dropped"]);

function walk(items: readonly PlanItem[], visit: (item: PlanItem, parent: PlanItem | null, siblings: readonly PlanItem[], index: number) => void, parent: PlanItem | null = null): void {
  items.forEach((item, index) => { visit(item, parent, items, index); walk(item.children, visit, item); });
}

export const childWorking = (child: ChildAgent): boolean => child.status === "running" || child.status === "queued" || child.activity !== undefined;
export const childName = (child: ChildAgent): string => child.sessionName ?? child.label;

/**
 * Who owns a plan item: its `job` (a child name or id, a session name or id, `thread:<id>`), else its stored `sessionId`, else the first
 * `thread:<id>` link in its note.
 */
export function stepOwner(item: PlanItem): string | undefined {
  return planJob(item.job) ?? item.sessionId ?? /\bthread:([a-zA-Z0-9_-]{1,128})/.exec(item.note ?? "")?.[1];
}
const owns = (fact: JobFact, owner: string): boolean => fact.key === owner || fact.name === owner || fact.key === "thread:" + owner;
/** The fact that owns a step: the thread its stored session id names first, so a renamed thread keeps its steps, else the one its job names. */
const ownerOf = (item: PlanItem, facts: readonly JobFact[]): JobFact | undefined => {
  const owner = stepOwner(item);
  return (item.sessionId ? facts.find(fact => fact.key === "thread:" + item.sessionId) : undefined) ?? (owner === undefined ? undefined : facts.find(fact => owns(fact, owner)));
};

/**
 * The chat's jobs now: every subagent directly under it (one whose parent is not another listed subagent), plus every thread an open plan step
 * names as its owner (`stepOwner`) that is not one of them. An owner that names nothing known, or the chat itself (`self`, its session id), is
 * left out. A cancelled subagent ended; only an error is a failure.
 */
export function jobFacts(children: readonly ChildAgent[], board: ChatBoard | null, rows: readonly SessionRow[], self?: string): JobFact[] {
  const ids = new Set(children.map(child => child.id));
  const facts = new Map<string, JobFact>();
  // A job that waits on its own subagent is at work (frontend bro 10-12: watchlist table rework waited on its working helper, and p78 was
  // flagged orphan and p14 idle).
  const busy = new Set<string>();
  for (const child of children) {
    if (!childWorking(child)) continue;
    for (let at: ChildAgent | undefined = child; at; at = at.parentId !== undefined ? children.find(other => other.id === at!.parentId) : undefined) {
      if (busy.has(at.id)) break;
      busy.add(at.id);
    }
  }
  for (const child of children) {
    if (child.parentId !== undefined && ids.has(child.parentId)) continue;
    const state: JobState = busy.has(child.id) ? "working" : child.status === "error" ? "failed" : "ended";
    facts.set(child.id, { key: child.id, name: childName(child), state, ...(state === "ended" && child.status === "cancelled" ? { cancelled: true as const } : {}),
      ...(child.lastActivityAt !== undefined ? { activityAt: child.lastActivityAt } : {}),
      ...(child.repliedSinceTask !== undefined ? { replied: child.repliedSinceTask } : {}), ...(child.error ? { error: child.error } : {}) });
  }
  walk(board?.plan ?? [], item => {
    const owner = stepOwner(item);
    if (owner === undefined) return;
    const link = { id: item.id, text: item.text, status: item.status };
    const known = ownerOf(item, [...facts.values()]);
    if (known) { if (!known.item || (CLOSED.has(known.item.status) && OPEN.has(item.status))) known.item = link; return; }
    if (!OPEN.has(item.status)) return;
    const row = rows.find(candidate => candidate.id === item.sessionId) ?? rows.find(candidate => candidate.id === owner || candidate.name === owner);
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
 * The check-in runs for a chat with a job at work, an open plan step (todo, doing, blocked), a board it cannot read, or more open owner asks
 * than the limit; a chat with none of these has nothing to check, and no duty job starts.
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

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
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

/**
 * The class of one open leaf step at a tick; every chat converges to steps that are `live`, `foryou` or `waiting`. `live`: its owner is a job
 * at work, a thread active in the last STEP_STALE_MS, or the chat itself on a step it changed in that time. `foryou`: an open owner todo covers
 * it (`todoForStep`). `waiting`: its `waitUntil` is ahead, or its `waitFor` (or thread owner) has seen progress within STEP_STALE_MS. The three
 * the chat must act on at once: `due` (its `waitUntil` passed and it has not changed since), `stale-chase` (it waits on another thread or an
 * event with no progress for STEP_STALE_MS), `orphan` (no live owner, no todo, no wait).
 */
export type StepClass = "live" | "foryou" | "waiting" | "due" | "stale-chase" | "orphan" | "parked";
export const STEP_CLASSES: readonly StepClass[] = ["live", "foryou", "waiting", "due", "stale-chase", "orphan", "parked"];
/** The classes whose steps need someone to act (`classLine`). */
export const ACT_CLASSES: ReadonlySet<StepClass> = new Set(["due", "stale-chase", "orphan"]);
/** A chase this old must become a For you todo or a new plan. */
export const CHASE_ESCALATE_MS = 24 * 60 * 60_000;

/** What the class of one open leaf step depends on: its last change (status, text, owner or wait), whether the chat owns it, its owner's fact. */
export interface StepFacts { item: PlanItem; changedAt: number; mine: boolean; owner?: JobFact | undefined; openTodos: readonly Pick<OwnerTodo, "id" | "text">[];
  /** The owner correction that parks the step (`parkedBy`). */
  parked?: string | undefined }
export function stepClass({ item, changedAt, mine, owner, openTodos, parked }: StepFacts, now: number): StepClass {
  const thread = owner?.key.startsWith("thread:") === true;
  if (owner?.state === "working") return "live";
  if (parked !== undefined) return "parked";
  if (thread && owner!.state !== "failed" && now - (owner!.activityAt ?? 0) < STEP_STALE_MS) return "live";
  if (todoForStep(item, openTodos)) return "foryou";
  const until = Date.parse(item.waitUntil ?? "");
  if (Number.isFinite(until) && until > now) return "waiting";
  if (Number.isFinite(until) && changedAt < until) return "due";
  if (mine && now - changedAt < STEP_STALE_MS) return "live";
  if (item.waitFor !== undefined || thread) return now - Math.max(changedAt, thread ? owner!.activityAt ?? 0 : 0) < STEP_STALE_MS ? "waiting" : "stale-chase";
  return "orphan";
}

/**
 * The thread a step's `waitFor` names, the one to chase: a `thread:<id>` link, a session id, or a session name of at least 6
 * characters as whole words (the longest one wins). Never the chat itself, never an archived thread.
 */
export function waitTarget(waitFor: string | undefined, rows: readonly Pick<SessionRow, "id" | "name" | "archived">[], self: ReadonlySet<string>): { id: string; name: string } | undefined {
  if (!waitFor) return undefined;
  const text = waitFor.toLowerCase();
  const linked = /\bthread:([a-zA-Z0-9_-]{1,128})/.exec(waitFor)?.[1];
  let best: { id: string; name: string } | undefined;
  for (const row of rows) {
    if (row.archived || self.has(row.id) || self.has(row.name)) continue;
    if (row.id === linked || waitFor.includes(row.id)) return { id: row.id, name: row.name };
    // A chat is also named by its short name, the part before " (": "ops guy" for "ops guy (+observability)" (AI harness 10-12: p285 waited
    // for "ops guy's 05:46Z check-in ... folds its p53", and that p53 read as this board's done p53).
    for (const name of new Set([row.name.trim().toLowerCase(), row.name.split(" (")[0]!.trim().toLowerCase()])) {
      if (name.length < 6 || (best && best.name.length >= name.length)) continue;
      const at = text.indexOf(name);
      if (at >= 0 && !/[a-z0-9]/.test(text[at - 1] ?? "") && !/[a-z0-9]/.test(text[at + name.length] ?? "")) best = { id: row.id, name: row.name.trim() };
    }
  }
  return best;
}

/**
 * Every open leaf step of a board (an open item with no open child) with its class, in board order. `changedAt` gives each step's last change
 * (the check-in memory); `self` holds the chat's id and name, so a step it owns is `mine`.
 */
export function classifyBoard(board: ChatBoard | null, facts: readonly JobFact[], changedAt: (item: PlanItem) => number, self: ReadonlySet<string>,
  rows: readonly Pick<SessionRow, "id" | "name" | "archived">[], now: number, active?: ReadonlySet<string>): StepView[] {
  const openTodos = (board?.todos ?? []).filter(todo => todo.from === "agent" && !todo.done);
  const views: StepView[] = [];
  const visit = (item: PlanItem): boolean => {
    let openBelow = false;
    for (const child of item.children) openBelow = visit(child) || openBelow;
    if (!OPEN.has(item.status)) return openBelow;
    if (!openBelow) views.push(stepView(item, changedAt(item), self, facts, openTodos, rows, now, active));
    return true;
  };
  for (const item of board?.plan ?? []) visit(item);
  return withGoals(views, board);
}
/** Each step's goal: the top-level plan item it is under, or itself. */
function withGoals(views: StepView[], board: ChatBoard | null): StepView[] {
  const goals = new Map<string, PlanItem>();
  for (const top of board?.plan ?? []) walk([top], item => goals.set(item.id, top));
  for (const view of views) { const goal = goals.get(view.item.id); if (goal) view.goal = { id: goal.id, text: goal.text }; }
  return views;
}
/** One open leaf step's view: its owner (none when the chat owns it), its class, and the thread to chase for a stale chase. */
export function stepView(item: PlanItem, changedAt: number, self: ReadonlySet<string>, facts: readonly JobFact[], openTodos: readonly Pick<OwnerTodo, "id" | "text">[],
  rows: readonly Pick<SessionRow, "id" | "name" | "archived">[], now: number, active?: ReadonlySet<string>): StepView {
  const mine = self.has(stepOwner(item) ?? "");
  const owner = mine ? undefined : ownerOf(item, facts);
  const parked = parkedBy(item, active);
  const base = { item, changedAt, mine, owner, openTodos, ...(parked ? { parked } : {}) };
  const cls = stepClass(base, now);
  const thread = owner?.key.startsWith("thread:") ? { id: owner.key.slice("thread:".length), name: owner.name } : undefined;
  const target = cls === "stale-chase" ? waitTarget(item.waitFor, rows, self) ?? thread : undefined;
  return { ...base, cls, ...(target ? { target } : {}) };
}

/**
 * The owner correction that parks a step, or undefined (frontend bro 10-12: c40 parks every real-app fix until the owner says 5180 is good
 * enough, with no For you question; the check-in still flagged p52 and p31 as stalled, stale chases and a missing go todo every 15 min). The
 * step is blocked, its note says it is parked, and it names a correction id that is in force (`active`, the ledger's ids not retired; every
 * id when no ledger was read). A parked step is the owner's to release: no chase, no stall, no go question.
 */
export function parkedBy(item: Pick<PlanItem, "status" | "note">, active?: ReadonlySet<string>): string | undefined {
  if (item.status !== "blocked" || !/\bpark(?:ed|s)?\b/i.test(item.note ?? "")) return undefined;
  return (item.note!.match(/\bc\d+\b/g) ?? []).find(id => active === undefined || active.has(id));
}
/** One open leaf step as the check-in sees it: its class and the thread to chase. */
export interface StepView extends StepFacts { cls: StepClass; target?: { id: string; name: string } | undefined;
  /** The goal (top-level plan item) the step is under; itself for a top-level step. */
  goal?: { id: string; text: string } }

/** The line for a step in an ACT_CLASSES class, naming what it needs now; null for the others. */
export function classLine(view: StepView, now: number): string | null {
  const { item, cls, changedAt, owner, mine } = view;
  const head = `${item.id} ${quote(item.text)}`;
  if (cls === "due") {
    const until = Date.parse(item.waitUntil!);
    return `${head} is due since ${now - until < 24 * 60 * 60_000 ? clockTime(until) : localTime(until)}: act on it or set a new waitUntil`;
  }
  if (cls === "stale-chase") {
    const on = item.waitFor !== undefined ? `waits for ${quote(item.waitFor)}` : `waits on ${owner ? ownerLabel(owner) : "its owner"}`;
    const age = now - changedAt;
    return age >= CHASE_ESCALATE_MS ? `${head} ${on} for ${ago(age)}: make it a For you todo or replan it now`
      : `${head} ${on} for ${ago(age)}: chase it now; after 24 h make it a For you todo or replan`;
  }
  if (cls === "orphan") {
    if (mine) return `${head} is yours and has not moved for ${ago(now - changedAt)}: start a job, do it now, or ask the owner in For you`;
    const who = owner ? ` (${ownerLabel(owner)} ${owner.cancelled ? "ended" : STATE_WORD[owner.state]})` : item.job ? ` (${item.job} not found)` : "";
    return `${head} has no live owner${who}: start a job, take it yourself, or ask the owner in For you`;
  }
  return null;
}

/*
 * The plan's shape (c44, reopened 10-12: p253 sat as a top-level item with no steps, status doing, after its work shipped, and the owner had to
 * ask the chat to tidy the plan). The plan is a few area goals with their open steps under them.
 */
/** The open goals with no step under them: a step filed as a goal. */
export const looseGoals = (board: ChatBoard | null): PlanItem[] => openGoals(board?.plan ?? []).filter(goal => !goal.children.length);
/** The open goals when there are more than BOARD_LIMITS.openGoals; a board from before the limit can still hold more. */
export function extraGoals(board: ChatBoard | null): PlanItem[] {
  const open = openGoals(board?.plan ?? []);
  return open.length > BOARD_LIMITS.openGoals ? open : [];
}
/** The open items right under a closed (done or dropped) item, board order: a closed goal with open work is a lie. */
export function openUnderClosed(board: ChatBoard | null): { item: PlanItem; parent: PlanItem }[] {
  const found: { item: PlanItem; parent: PlanItem }[] = [];
  walkItems(board?.plan ?? [], item => { if (CLOSED.has(item.status)) for (const child of item.children) if (OPEN.has(child.status)) found.push({ item: child, parent: item }); });
  return found;
}
export const underClosedLine = ({ item, parent }: { item: PlanItem; parent: PlanItem }): string =>
  `${item.id} ${quote(item.text)} is open under closed ${parent.id}: close it, or reopen ${parent.id} if the work is real`;
export const lookDoneLine = ({ item, reason }: { item: PlanItem; reason: string }): string => `${item.id} ${quote(item.text)} ${item.status}, looks done: ${reason}`;
export const looseGoalLine = (goal: PlanItem): string => `${goal.id} ${quote(goal.text)} is a top-level item with no steps: move it under the goal it belongs to with ` +
  "plan_update parent, give it steps, or close it if its work shipped";
export const extraGoalsLine = (goals: readonly PlanItem[]): string => `${goals.length} open goals, the limit is ${BOARD_LIMITS.openGoals}: fold goals of one area under one ` +
  `area goal (${goals.map(goal => `${goal.id} ${quote(goal.text)}`).join(", ")})`;

/**
 * A goal held only by other threads (c45, owner 10-12 on chat bugfix temp: p1 "Old chats show in the sidebar again" stayed open after its fix
 * shipped, because its last step p3 waited for "next chat release with the fix", owned by the AI harness VP thread; that thread was busy with
 * other work, so p3 counted as live and no line named it). The goal has a closed step (its own work happened), no target it is short of, and
 * every open leaf step under it is held by another thread: its owner is a thread, or it has no owner of this chat and its waitFor names a
 * thread (`waitTarget`). A step of the chat, a subagent's step and a step with a For you todo keep the goal here, and so does a target gap: a
 * goal short of its number is still this chat's to push (Crawler VP 10-12: p19, 32 of 180 Mbps, waited on the release owner's ramp). The
 * check-in checks the wait against the real state and closes the goal on that evidence, or hands the leftover to the holding thread and
 * closes it here, or adds the step of its own that comes after the wait.
 */
export interface HeldGoal { goal: { id: string; text: string }; steps: { item: PlanItem; thread: { id: string; name: string } }[] }
export function heldElsewhere(views: readonly StepView[], board: ChatBoard | null, rows: readonly Pick<SessionRow, "id" | "name" | "archived">[], self: ReadonlySet<string>): HeldGoal[] {
  const settled = (goal: PlanItem): boolean => goal.children.some(child => CLOSED.has(child.status)) &&
    (!goal.target || (goal.target.current !== undefined && goal.target.current >= goal.target.target));
  const tops = new Map((board?.plan ?? []).map(goal => [goal.id, goal]));
  const holder = (view: StepView): { id: string; name: string } | undefined => {
    if (view.mine || view.cls === "foryou") return undefined;
    if (view.owner) return view.owner.key.startsWith("thread:") ? { id: view.owner.key.slice("thread:".length), name: view.owner.name } : undefined;
    return waitTarget(view.item.waitFor, rows, self);
  };
  const goals = new Map<string, HeldGoal | null>();
  for (const view of views) {
    const goal = view.goal ?? { id: view.item.id, text: view.item.text };
    const thread = holder(view);
    const held = goals.get(goal.id);
    if (held === null) continue;
    goals.set(goal.id, thread ? { goal, steps: [...held?.steps ?? [], { item: view.item, thread }] } : null);
  }
  return [...goals.values()].filter((held): held is HeldGoal => held !== null && tops.get(held.goal.id) !== undefined && settled(tops.get(held.goal.id)!));
}
export const heldLine = ({ goal, steps }: HeldGoal): string => `${goal.id} ${quote(goal.text)} has no open work of its own: ` +
  steps.map(({ item, thread }) => `${item.id} ${quote(item.text)} is held by the ${clip(thread.name, 40)} thread (thread:${thread.id})` +
    (item.waitFor ? ` and waits for ${quote(item.waitFor)}` : "")).join("; ") +
  ". Check the wait against the real state now: if it is met, close the step and the goal on that evidence; if not, send that thread the " +
  "leftover in one message with what it must check, close the step here with a note naming the thread, and close the goal. Keep the goal " +
  "only when more work of this chat comes after the wait, and add that step now";

/**
 * An open step whose wait is over (c45): its waitFor names plan steps or For you todos of this board (`p67`, `t8`), and every one is closed or
 * answered. A waitFor that names another thread is left out, since its ids may be that thread's. The step is due now, whatever its waitUntil.
 */
export interface WaitMet { view: StepView; over: string[] }
export function waitsMet(views: readonly StepView[], board: ChatBoard | null, rows: readonly Pick<SessionRow, "id" | "name" | "archived">[], self: ReadonlySet<string>): WaitMet[] {
  const items = new Map<string, PlanItem>();
  walkItems(board?.plan ?? [], item => { items.set(item.id, item); });
  const todos = new Map((board?.todos ?? []).map(todo => [todo.id, todo]));
  return views.flatMap(view => {
    const { waitFor } = view.item;
    const named = [...new Set(waitFor?.match(/\b[pt]\d+\b/g) ?? [])].filter(id => id !== view.item.id);
    if (!named.length || /\bthreads?\b/i.test(waitFor!) || waitTarget(waitFor, rows, self)) return [];
    const over = named.flatMap(id => {
      const item = items.get(id);
      if (item) return CLOSED.has(item.status) ? [`${id} is ${item.status}`] : [];
      const todo = todos.get(id);
      return todo && (todo.done || (todo.reply ?? "").trim() !== "") ? [`${id} is answered (read the answer: a hold is not a go)`] : [];
    });
    return over.length === named.length ? [{ view, over }] : [];
  });
}
export const waitMetLine = ({ view, over }: WaitMet): string =>
  `${view.item.id} ${quote(view.item.text)} waits for ${quote(view.item.waitFor ?? "")}, and ${over.join(" and ")}: the wait is over, act on it ` +
  "now (start it, or close it if the wait made it moot)";

/** The fields of a chat duty (`<data dir>/duties/<chat>.json`) the fold reads. */
export type DutyRef = Pick<Duty, "id" | "name" | "goal" | "status" | "boardGoal">;
/**
 * The active duty that runs a goal's work: the duty whose `boardGoal` is the goal, else the first whose name and goal share at least
 * FOLD_AREA_WORDS area words (`areaWords`) with the goal's text, and at least half of the goal's. On VP of CI's board p72 shares 6 of 11 with the
 * duty "Git rules" and p75 7 of 9 with "Repo design"; p10 "Staging promotes to prod on its own" shares 2 with "Git rules" and p60 4 of 9 with
 * "Repo design", and neither is that duty's work.
 */
export const FOLD_AREA_WORDS = 3;
export function dutyFor(goal: Pick<PlanItem, "id" | "text">, duties: readonly DutyRef[]): DutyRef | undefined {
  const active = duties.filter(duty => duty.status === "active");
  const words = areaWords(goal.text);
  const shared = (duty: DutyRef) => { const other = areaWords(`${duty.name} ${duty.goal}`); return [...words].filter(word => other.has(word)).length; };
  return active.find(duty => duty.boardGoal === goal.id) ?? active.find(duty => shared(duty) >= FOLD_AREA_WORDS && shared(duty) * 2 >= words.size);
}

/**
 * A goal to fold (c46, owner 10-12 via VP of CI: he asked whether p15 was done and whether every item was pushed through). p15, p72 and p75 stayed
 * open at the 14:07 check-in: their own work ran as the chat's duties and their open steps rode other goals' jobs. An open goal folds when an
 * active duty of the chat runs its work (`dutyFor`), or when every open step right under it has a home in another goal: an open item there with
 * the same job (not the chat itself, not a thread); for a step with no job of its own, the item its waitFor names by id or whose job its waitFor
 * names. A step with its own job that no other goal shares stays, whatever it waits for. `moves` puts each
 * step with a home under that home; `left` are a duty goal's open steps with no home, which the check-in places itself. A goal another fold
 * moves steps into does not fold, and a duty's goal is never a home. Board order.
 */
export interface FoldMove { item: PlanItem; home: PlanItem; why: string }
export interface FoldGoal { goal: PlanItem; duty?: DutyRef; moves: FoldMove[]; left: PlanItem[] }
export function goalsToFold(board: ChatBoard | null, facts: readonly JobFact[], self: ReadonlySet<string>, duties: readonly DutyRef[]): FoldGoal[] {
  const goals = (board?.plan ?? []).filter(goal => OPEN.has(goal.status));
  const byDuty = new Map(goals.flatMap(goal => { const duty = dutyFor(goal, duties); return duty ? [[goal.id, duty] as const] : []; }));
  /** A job that names work of this chat: not the chat itself and not another thread. */
  const workJob = (item: PlanItem): string | undefined => {
    const job = planJob(item.job);
    return job === undefined || self.has(job) || facts.some(fact => fact.key.startsWith("thread:") && owns(fact, job)) ? undefined : job;
  };
  const folds: FoldGoal[] = [];
  const homeGoals = new Set<string>();
  for (const goal of goals) {
    const duty = byDuty.get(goal.id);
    if (!duty && homeGoals.has(goal.id)) continue;
    const homes: { item: PlanItem; goal: string }[] = [];
    for (const other of goals) {
      if (other === goal || byDuty.has(other.id) || folds.some(fold => fold.goal === other)) continue;
      walkItems([other], item => { if (OPEN.has(item.status)) homes.push({ item, goal: other.id }); });
    }
    const homeOf = (step: PlanItem): { home: { item: PlanItem; goal: string }; why: string } | undefined => {
      const job = workJob(step);
      // A step with a job of its own rides another goal only on that job: p96 has its own job and waits for p97 of another goal, and stays.
      if (job !== undefined) {
        const same = homes.find(entry => workJob(entry.item) === job);
        return same ? { home: same, why: `${same.item.id} has its job ${job}` } : undefined;
      }
      for (const id of step.waitFor?.match(/\bp\d+\b/g) ?? []) {
        const home = homes.find(entry => entry.item.id === id);
        if (home) return { home, why: `it waits for ${id}` };
      }
      const named = step.waitFor ? homes.find(entry => { const other = workJob(entry.item); return other !== undefined && phrasePattern(other)?.test(step.waitFor!) === true; }) : undefined;
      return named ? { home: named, why: `it waits for the job ${workJob(named.item)} of ${named.item.id}` } : undefined;
    };
    const moves: FoldMove[] = [];
    const left: PlanItem[] = [];
    const found = new Set<string>();
    for (const step of goal.children.filter(child => OPEN.has(child.status))) {
      const home = homeOf(step);
      if (home) { moves.push({ item: step, home: home.home.item, why: home.why }); found.add(home.home.goal); }
      else left.push(step);
    }
    if (!duty && (!moves.length || left.length)) continue;
    folds.push({ goal, ...(duty ? { duty } : {}), moves, left });
    for (const id of found) homeGoals.add(id);
  }
  return folds;
}
/**
 * The open top-level goals of a chat that has no active duty, in board order; none when the chat has one (duty proposals 10-12: five chats
 * held open goals with no duty and no metric flagged them). The built-in check-in is no duty here.
 */
export function goalsWithoutDuty(board: ChatBoard | null, duties: readonly DutyRef[]): PlanItem[] {
  if (duties.some(duty => duty.status === "active" && duty.id !== CHECK_IN_DUTY_ID)) return [];
  return (board?.plan ?? []).filter(goal => OPEN.has(goal.status));
}
export const noDutyLine = (goals: readonly PlanItem[]): string =>
  `${plural(goals.length, "open goal")} (${goals.map(goal => `${goal.id} ${quote(goal.text)}`).join(", ")}) and no active duty: draft a duty for the chat's ` +
  "standing work (the owner's words, a goal, metrics and a precheck) and ask the owner on For you whether to add it, unless For you already asks";
/** The board ops of a fold, in order: each move, then the goal's close with a note naming where its work lives now. A step in `left` moves first, by the check-in's own op. */
export function foldOps({ goal, duty, moves }: FoldGoal): BoardOp[] {
  const where = duty ? `the duty ${duty.id} "${duty.name}" runs this goal's work` : "its open steps ride other goals' jobs";
  const moved = moves.length ? `; ${moves.map(move => `${move.item.id} moved under ${move.home.id}`).join(", ")}` : "";
  return [...moves.map(move => ({ op: "plan_update" as const, id: move.item.id, parent: move.home.id })),
    { op: "plan_update", id: goal.id, status: "done", note: `Folded (c46): ${where}${moved}.` }];
}
export const foldLine = (fold: FoldGoal): string => {
  const { goal, duty, moves, left } = fold;
  const ops = foldOps(fold).map(op => JSON.stringify(op));
  const close = ops.pop()!;
  return `${goal.id} ${quote(goal.text)}: ${duty ? `the duty ${duty.id} "${duty.name}" runs its work` : "every open step under it rides another goal's job"}. ` +
    (moves.length ? `Move ${moves.map(move => `${move.item.id} under ${move.home.id} (${move.why})`).join(", ")}: ${ops.join(", ")}. ` : "") +
    (left.length ? `${left.map(item => `${item.id} ${quote(item.text)}`).join(", ")} ${left.length > 1 ? "have" : "has"} no home on another goal: move ` +
      `${left.length > 1 ? "each" : "it"} under the goal its work belongs to with plan_update parent, or make it a goal of its own (parent null) after the close. ` : "") +
    `Then close the goal: ${close}`;
};

/** The no-progress check looks back this long. */
export const PROGRESS_MS = 60 * 60_000;
/**
 * No progress (owner 10-12: the check-in needs a code check that in the last hour either a checklist item turned
 * done or every open task is blocked, since work should keep moving). It passes when a plan item turned done
 * in the last PROGRESS_MS (its memo changed then and it is done now), or when every open step is held: blocked, waiting on an open For you todo,
 * waiting on purpose for a waitUntil still ahead, or waiting on another thread (its owner, or a thread its waitFor names). A waitUntil that
 * passed is not held. No verdict (null) until the chat's memory spans PROGRESS_MS. `moving` are the open steps that are not held.
 */
export interface NoProgress { moving: StepView[] }
export function noProgress(board: ChatBoard | null, views: readonly StepView[], memos: Readonly<Record<string, StepMemo>>, since: number,
  rows: readonly Pick<SessionRow, "id" | "name" | "archived">[], self: ReadonlySet<string>, now: number): NoProgress | null {
  if (now - since < PROGRESS_MS) return null;
  let done = false;
  walkItems(board?.plan ?? [], item => { if (item.status === "done" && (memos[item.id]?.doneAt ?? 0) >= now - PROGRESS_MS) done = true; });
  if (done) return null;
  const held = (view: StepView): boolean => view.item.status === "blocked" || view.cls === "foryou" || Date.parse(view.item.waitUntil ?? "") > now ||
    (!view.mine && view.owner?.key.startsWith("thread:") === true) || waitTarget(view.item.waitFor, rows, self) !== undefined;
  const moving = views.filter(view => !held(view));
  return moving.length ? { moving } : null;
}
export const noProgressLine = ({ moving }: NoProgress): string => `No plan item was done in the last hour and ${plural(moving.length, "open step")} ` +
  `${moving.length === 1 ? "is" : "are"} not blocked (${moving.slice(0, 8).map(view => `${view.item.id} ${quote(view.item.text)} ${view.cls}`).join(", ")}` +
  `${moving.length > 8 ? `, and ${moving.length - 8} more` : ""}): move one in this run (finish or close a step on evidence, start or chase its job), ` +
  "or block it with the exact thing that unblocks it; waiting is not progress";

/** A waitUntil that passed this long ago is a stale step (c44: steps still waiting 30 h after a fleet outage ended their slots). */
export const STALE_STEP_MS = 24 * 60 * 60_000;
/**
 * An open plan item whose record is stale (c44): its waitUntil passed more than STALE_STEP_MS ago, or the job its `job` names (a subagent, not a
 * thread) ended more than one check-in interval (`everyMs`) ago and the item has not changed since. A waitUntil still ahead is a planned wait, so
 * a job that idles under one is not stale. Any open item counts, a goal or a step with open steps under it too. Board order.
 */
export interface StaleStep { item: PlanItem; why: string }
export function staleSteps(board: ChatBoard | null, facts: readonly JobFact[], changedAt: (item: PlanItem) => number, self: ReadonlySet<string>,
  everyMs: number, now: number): StaleStep[] {
  const stale: StaleStep[] = [];
  walk(board?.plan ?? [], item => {
    if (!OPEN.has(item.status)) return;
    const until = Date.parse(item.waitUntil ?? "");
    if (Number.isFinite(until) && now - until > STALE_STEP_MS) {
      stale.push({ item, why: `its waitUntil ${localTime(until)} passed ${ago(now - until)} ago` });
      return;
    }
    const job = planJob(item.job);
    const owner = job === undefined || self.has(job) ? undefined : facts.find(fact => owns(fact, job));
    if (!owner || owner.key.startsWith("thread:") || owner.state === "working" || owner.activityAt === undefined || until > now) return;
    const end = owner.activityAt;
    if (end > changedAt(item) && now - end > everyMs) {
      stale.push({ item, why: `job ${owner.name} ${owner.cancelled ? "was cancelled" : owner.state === "failed" ? "failed" : "ended"} ${ago(now - end)} ago and the step has not changed since` });
    }
  });
  return stale;
}
export const staleLine = ({ item, why }: StaleStep): string => `${item.id} ${quote(item.text)} ${item.status}: ${why}; update it or close it in this run`;

/** The whole-word, case-insensitive pattern of a phrase: its words joined by spaces or hyphens, a plural `s` allowed at the end. */
const phrasePattern = (phrase: string): RegExp | null => {
  const words = phrase.toLowerCase().match(/[\p{L}\p{N}]+/gu);
  return words ? new RegExp(`(?<![\\p{L}\\p{N}])${words.map(word => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[\\s-]+")}s?(?![\\p{L}\\p{N}])`, "iu") : null;
};
/** The first topic the text names as whole words, or undefined. */
export function matchTopic(text: string, topics: readonly string[]): string | undefined {
  return topics.find(topic => phrasePattern(topic)?.test(text) === true);
}
/**
 * The names a handoff's `to` goes by: each comma-separated name in it, with and without its parenthesis ("ops guy (+observability)" is also
 * "ops guy"); session ids and `thread:` links are left to `namesTarget`.
 */
const targetNames = (to: string): string[] => {
  const bare = to.replace(/\bthread:\S+|[0-9a-f]{8}-[0-9a-f-]{20,}/gi, " ");
  return [...new Set([...bare.split(","), ...bare.replace(/\([^)]*\)/g, " ").split(",")].map(name => name.replace(/\s+/g, " ").trim()).filter(name => name.length >= 3))];
};
/** Whether a text names a handoff's target: one of its names as whole words, or a session id that `to` holds. */
export function namesTarget(text: string | undefined, to: string): boolean {
  if (!text) return false;
  const ids = to.match(/[0-9a-f]{8}-[0-9a-f-]{20,}/gi) ?? [];
  return ids.some(id => text.includes(id)) || targetNames(to).some(name => phrasePattern(name)?.test(text) === true);
}
/** Whether the chat (its session id and name, `self`) is a handoff's target, so the work is its own: `to` holds its id, or they share a name. */
export function isHandoffTarget(to: string, self: readonly string[]): boolean {
  const names = new Set(targetNames(to).map(name => name.toLowerCase()));
  return self.some(own => own.trim() !== "" && (to.includes(own.trim()) && /^[0-9a-f]{8}-[0-9a-f-]{20,}$/i.test(own.trim()) ||
    targetNames(own).some(name => names.has(name.toLowerCase()))));
}
/** A step that says its work was already handed off ("handed off to ops guy", "handed over"). */
const HANDED_OFF = /\bhanded[\s-]*(?:it\s+|this\s+)?(?:off|over)\b|\bhanded\s+to\b/i;

/**
 * CI work, named as the capital word CI in a step's text or in the text of an item above it. A handoff whose topics do not name CI never
 * takes it: c13 gives CI to the VP of CI, and c36's "health check" (local uptime of the wiki, the frontend app, Convex and the crawler API)
 * flagged its CI health check steps p37, p69 and p70 on every run from 10-10 to 10-12. 95bed8a's `with` words were meant to stop that,
 * but the ledger entry never got them.
 */
const CI_WORK = /\bCI\b/;
/** An open plan item whose work belongs to another thread by a ledger handoff: the rule, and the topic its text or note names. */
export interface ScopeMiss { item: PlanItem; rule: HandoffRule; topic: string }
/**
 * The open plan items of a chat (session id and name in `self`) that belong to another thread (correction c7, owner 10-09: machine management goes to
 * ops guy and never runs in another chat): the text or note names a handoff topic as whole words. Not in the target chat itself, and not an item
 * that says it was handed off, or whose owner or `waitFor` names the target. An item that matches covers the items under it. Board order.
 */
export function scopeMisses(board: ChatBoard | null, rules: readonly HandoffRule[], self: readonly string[]): ScopeMiss[] {
  const mine = rules.filter(rule => !isHandoffTarget(rule.to, self));
  const misses: ScopeMiss[] = [];
  const visit = (item: PlanItem, underCi: boolean) => {
    const ci = underCi || CI_WORK.test(item.text);
    if (OPEN.has(item.status)) {
      const text = `${item.text}\n${item.note ?? ""}`;
      for (const rule of mine) {
        // Only the step's own text says what the work is; a note names machines as context (VP of CI 10-09: p56 "CI dashboard" flagged for
        // "swap" in its note; a crawler thread 10-10: five crawler builds flagged for "runner-a", the CI runner their land queued on).
        const topic = matchTopic(item.text, rule.topics);
        if (topic === undefined) continue;
        if (rule.with?.length && matchTopic(item.text, rule.with) === undefined) continue;
        if (ci && !rule.topics.some(topic => CI_WORK.test(topic.toUpperCase()))) continue;
        if (HANDED_OFF.test(text) || namesTarget(item.waitFor, rule.to) || namesTarget(stepOwner(item), rule.to)) return;
        misses.push({ item, rule, topic });
        return;
      }
    }
    item.children.forEach(child => visit(child, ci));
  };
  (board?.plan ?? []).forEach(goal => visit(goal, false));
  return misses;
}
/** The line for a step that belongs to another thread. */
export const scopeLine = ({ item, rule }: ScopeMiss): string =>
  `${item.id} ${quote(item.text)} belongs to ${rule.to} (correction ${rule.correction}): hand it off with a message to that thread and remove it from this plan`;

/** What one check-in precheck found: the memory to keep, every open leaf step with its class, the steps on another thread's work, the open items that look done, and other facts. */
export interface CheckInPrecheck {
  memory: CheckInMemory; steps: StepView[]; scope: ScopeMiss[]; gates: GateFinding[]; stalled: StalledStep[]; goals: GoalGap[]; blocked: BlockedStep[];
  done: { item: PlanItem; reason: string }[]; loose: PlanItem[]; extra: PlanItem[]; underClosed: { item: PlanItem; parent: PlanItem }[];
  held: HeldGoal[]; waitsMet: WaitMet[]; noProgress: NoProgress | null; stale: StaleStep[]; fold: FoldGoal[]; load: SessionLoad[]; heartbeats: ScheduledJob[];
  /** The open goals when the chat has no active duty (`goalsWithoutDuty`); none when the context gave no duties. */
  noDuty: PlanItem[];
  /** A board read error, an ask overflow, steps that can start, and steps that wait on the owner with no question in For you. */
  facts: string[];
}

/**
 * The check-in's precheck, code only: each plan item's last change (when its status, text, owner or wait last differed; the board's `updatedAt`
 * for one never seen before; a note edit is no change), every open leaf step's class (`stepClass`), the open items on another thread's work by a
 * ledger handoff (`scopeMisses`), the open items that look done (`looksDone`), and the facts around them. A board read error keeps the last
 * steps. Nothing here decides what happens next: the duty job reads it as context.
 */
export function checkInPrecheck(previous: CheckInMemory | undefined, facts: readonly JobFact[], board: ChatBoard | null, now: number, context: CheckInContext = {}): CheckInPrecheck {
  const self = new Set(context.self ?? []);
  const openTodos = (board?.todos ?? []).filter(todo => todo.from === "agent" && !todo.done);
  /** Asks already answered: a step whose question the owner answered does not need a new one. */
  const answeredTodos = (board?.todos ?? []).filter(todo => todo.done || (todo.reply ?? "").trim() !== "");
  const firstSeen = Math.min(now, Date.parse(board?.updatedAt ?? "") || now);
  const steps: Record<string, StepMemo> = context.boardError ? { ...previous?.steps } : {};
  const views: StepView[] = [];
  const notes: string[] = [];
  const active = context.corrections ? new Set(context.corrections) : undefined;
  const visit = (item: PlanItem): boolean => {
    let openBelow = false;
    for (const child of item.children) openBelow = visit(child) || openBelow;
    const before = previous?.steps[item.id];
    const memo = stepMemo(item, before, now, firstSeen);
    steps[item.id] = memo;
    const isOpen = OPEN.has(item.status);
    if (!isOpen || openBelow) return isOpen || openBelow;
    views.push(stepView(item, memo.at, self, facts, openTodos, context.rows ?? [], now, active));
    if (waitsOnOwner(item) && parkedBy(item, active) === undefined && !todoForStep(item, openTodos) && !todoForStep(item, answeredTodos)) notes.push(`${item.id} ${quote(item.text)} waits on the owner but For you has no question for it`);
    const leave = stepGoWait(item);
    if (leave) notes.push(`${item.id} ${quote(item.text)} ${goWaitText(leave)}, a wait nobody needs (c47): take the action now and clear the waitFor`);
    return true;
  };
  if (!context.boardError) for (const item of board?.plan ?? []) visit(item);
  if (context.boardError) notes.push(`the board cannot be read: ${clip(context.boardError, 160)}`);
  const asks = openAsks(board);
  if (!context.boardError && asks > BOARD_LIMITS.openAsks) notes.push(`${asks} open owner todos; the limit is ${BOARD_LIMITS.openAsks}`);
  const gates = context.boardError ? [] : gateFindings(board, facts, active);
  const held = new Set(gates.map(gate => gate.item.id));
  if (!context.boardError) {
    for (const step of readySteps(board)) if (!held.has(step.id)) notes.push(`${step.id} ${quote(step.text)} can start: the steps before it are done and it has no job`);
  }
  for (const gate of gates) if (gate.kind === "go_waiting") notes.push(gateLine(gate));
  const goaled = withGoals(views, board);
  const since = previous?.since ?? previous?.at ?? now;
  return { memory: { at: now, steps, since }, steps: goaled, scope: context.boardError ? [] : scopeMisses(board, context.handoffs ?? [], context.self ?? []), gates,
    stalled: context.boardError ? [] : stalledSteps(goaled, steps, context.rows ?? [], self, now), goals: context.boardError ? [] : goalGaps(board, goaled, context.everyMs ?? CHECK_IN_MS, now),
    blocked: context.boardError ? [] : blockedOnOthers(goaled, context.rows ?? [], self, now), done: context.boardError ? [] : finishedOpen(board),
    loose: context.boardError ? [] : looseGoals(board), extra: context.boardError ? [] : extraGoals(board), underClosed: context.boardError ? [] : openUnderClosed(board),
    held: context.boardError ? [] : heldElsewhere(goaled, board, context.rows ?? [], self),
    noProgress: context.boardError ? null : noProgress(board, goaled, steps, since, context.rows ?? [], self, now), waitsMet: context.boardError ? [] : waitsMet(goaled, board, context.rows ?? [], self),
    stale: context.boardError ? [] : staleSteps(board, facts, item => steps[item.id]?.at ?? now, self, context.everyMs ?? CHECK_IN_MS, now),
    fold: context.boardError ? [] : goalsToFold(board, facts, self, context.duties ?? []), load: oneSessionLoad(goaled, context.jobs),
    heartbeats: redundantHeartbeats(context.heartbeats ?? []), noDuty: context.boardError || !context.duties ? [] : goalsWithoutDuty(board, context.duties), facts: notes };
}

/** A step's memo at this run: `at` moves when its sig changes, `waitAt` when its wait changes, and a new waitUntil joins `untils`. */
export function stepMemo(item: PlanItem, before: StepMemo | undefined, now: number, firstSeen: number): StepMemo {
  const sig = stepSig(item);
  const wait = waitSig(item);
  const seen = before?.untils ?? [];
  const untils = item.waitUntil && seen.at(-1) !== item.waitUntil ? [...seen, item.waitUntil].slice(-STALL_UNTILS) : seen;
  const turnedDone = item.status === "done" && before !== undefined && !before.sig.startsWith('["done"');
  const doneAt = turnedDone ? now : item.status === "done" ? before?.doneAt : undefined;
  return { sig, at: before ? before.sig === sig ? before.at : now : firstSeen, wait, ...(doneAt !== undefined ? { doneAt } : {}),
    // A memo from before `wait` existed counts its last change (its sig holds the waits) as the wait's start.
    waitAt: !before ? firstSeen : before.wait === undefined ? before.at : before.wait === wait ? before.waitAt ?? before.at : now, ...(untils.length ? { untils } : {}) };
}
/** What a step waits on: its waitFor, its waitUntil and its owner. */
const waitSig = (item: PlanItem): string => JSON.stringify([item.waitFor ?? "", item.waitUntil ?? "", stepOwner(item) ?? ""]);

/** The waitUntil values a step's memo keeps. */
export const STALL_UNTILS = 5;
/** A wait that stays the same this long is stalled. */
export const STALL_MS = 2 * 60 * 60_000;
/**
 * An open step that sits on a passive wait (c23 reopened, owner 10-09 via stripe and payments: duties should push these): it waits
 * (a waitFor, a waitUntil, or a thread owner), nobody is on it now (not live, not For you), and its wait has stayed the same for STALL_MS, or its
 * waitUntil was pushed later more than once. `why` says which. A waitUntil still ahead and never moved is a planned wait unless the step also
 * waits on a thread or on CI, a land, a release or a pin; `rows` and `self` find a thread its waitFor names (`waitTarget`).
 */
export interface StalledStep { view: StepView; why: string }
export function stalledSteps(views: readonly StepView[], memos: Readonly<Record<string, StepMemo>>, rows: readonly Pick<SessionRow, "id" | "name" | "archived">[],
  self: ReadonlySet<string>, now: number): StalledStep[] {
  return views.flatMap(view => {
    const { item } = view;
    const waits = item.waitFor !== undefined || item.waitUntil !== undefined || view.owner?.key.startsWith("thread:") === true;
    if (!waits || view.cls === "live" || view.cls === "foryou" || view.cls === "parked") return [];
    const memo = memos[item.id];
    const untils = memo?.untils ?? [];
    const pushes = untils.filter((until, index) => index > 0 && Date.parse(until) > Date.parse(untils[index - 1]!)).length;
    const since = memo?.waitAt ?? view.changedAt;
    if (pushes >= 2) return [{ view, why: `its waitUntil was pushed later ${pushes} times` }];
    // A fixed date still ahead, never moved, is a planned wait, not a stall (10-10, p168: a 2-day audit window), unless the step also waits on
    // someone to chase: a thread owner, or a waitFor naming CI, a land, a release, a pin or a thread. The 2 h rule is for waits with no date,
    // a passed date, and those.
    const chase = view.owner?.key.startsWith("thread:") === true || othersWord(item.waitFor) !== undefined || waitTarget(item.waitFor, rows, self) !== undefined;
    if (!chase && pushes === 0 && Date.parse(item.waitUntil ?? "") > now) return [];
    return now - since > STALL_MS ? [{ view, why: `it has waited on the same thing for ${ago(now - since)}` }] : [];
  });
}
export const stalledLine = ({ view, why }: StalledStep): string => {
  const on = view.item.waitFor !== undefined ? `waits for ${quote(view.item.waitFor)}` : view.item.waitUntil !== undefined ? `waits until ${localTime(Date.parse(view.item.waitUntil))}`
    : `waits on ${view.owner ? ownerLabel(view.owner) : "its owner"}`;
  return `${view.item.id} ${quote(view.item.text)} ${on} and ${why}: act on it in this run`;
};

/** A step blocked on others this long with no live job needs a fix job (W56). */
export const BLOCKED_MS = 60 * 60_000;
/** Words in a step's waitFor or note that name a blocker outside the chat: CI, a land, promote or release, a pin, or another thread. */
const OTHERS = /\b(?:ci|github actions|land(?:\.yml)?|promote(?:\.yml)?|release(?: queue| train| owner)?|pin(?:ned)?|threads?)\b/i;
/** The OTHERS word in a waitFor or note, read with its paths and dated folder names left out; undefined when there is none. */
const othersWord = (text: string | undefined): string | undefined =>
  text ? OTHERS.exec(text.split(/\s+/).filter(token => !pathLike(token)).join(" "))?.[0] : undefined;
/**
 * An open step blocked on CI, the release queue or another thread with nobody fixing it (W56, owner 10-10: when CI or the like blocks
 * a step, work out how to fix it and get involved): it waits (a waitFor, or blocked), its waitFor or note names such a blocker or
 * its waitFor or owner is another thread, it has not changed for BLOCKED_MS, and no job of it is working. A step an open For you todo covers
 * waits on the owner, not on others (AI harness 10-12: p288 on t41 and p277 on t42 read as blocked on a release and on SEO guy). `on` names the blocker.
 */
export interface BlockedStep { view: StepView; on: string }
export function blockedOnOthers(views: readonly StepView[], rows: readonly Pick<SessionRow, "id" | "name" | "archived">[], self: ReadonlySet<string>, now: number): BlockedStep[] {
  return views.flatMap(view => {
    const { item, owner } = view;
    if ((item.waitFor === undefined && item.status !== "blocked") || owner?.state === "working" || view.cls === "parked" || view.cls === "foryou" ||
      now - view.changedAt <= BLOCKED_MS) return [];
    const thread = waitTarget(item.waitFor, rows, self) ?? (owner?.key.startsWith("thread:") ? { name: owner.name } : undefined);
    const word = othersWord(item.waitFor) ?? othersWord(item.note);
    const on = thread ? `the ${clip(thread.name, 40)} thread` : word;
    return on ? [{ view, on }] : [];
  });
}
export const blockedLine = ({ view, on }: BlockedStep, now: number): string => {
  const { item, owner } = view;
  const job = owner ? `${ownerLabel(owner)} is ${owner.cancelled ? "ended" : STATE_WORD[owner.state]}` : "no job works on it";
  return `${item.id} ${quote(item.text)} is blocked on ${on} for ${ago(now - view.changedAt)} and ${job}: find out why and start a job that fixes the ` +
    "blocker, or send the blocker's owner a concrete patch";
};

/**
 * The two hard gates as the check-in sees them (W50): `go_waiting` a go-needed step that has not started and has no owner go (`todo` the open
 * todo that asks for it, if any); `go_missing` a go-needed step at work (doing, or its job working) with no owner go; `requirements_missing` a
 * goal with a Build step doing whose requirements check fails (`reason`); `merges_without_go` a merge or default-branch push step done with no
 * owner go that names its PR or push (c49), a repo rule breach. The board refuses these moves for the agent; an older board, a go flag set on a step already at work, or an owner
 * answer that later took the go back can still hold them. The board is the record: no GitHub call.
 */
export type GateFinding =
  | { kind: "go_waiting"; item: PlanItem; todo?: OwnerTodo }
  | { kind: "go_missing"; item: PlanItem }
  | { kind: "requirements_missing"; item: PlanItem; step: PlanItem; reason: string }
  | { kind: "merges_without_go"; item: PlanItem };
export function gateFindings(board: ChatBoard | null, facts: readonly JobFact[], active?: ReadonlySet<string>): GateFinding[] {
  if (!board) return [];
  const found: GateFinding[] = [];
  const failing = new Set<string>();
  const visit = (items: readonly PlanItem[], above: PlanItem[]) => {
    for (const item of items) {
      if (item.status === "done" && mergeStep(item.text) && needsGo(item) && !stepGo(board, item)) found.push({ kind: "merges_without_go", item });
      if (needsGo(item) && OPEN.has(item.status) && !stepGo(board, item)) {
        if (item.status === "doing" || ownerOf(item, facts)?.state === "working") found.push({ kind: "go_missing", item });
        else if (parkedBy(item, active) === undefined) {
          const todo = board.todos.find(entry => !entry.done && linksStep(entry, item.id));
          found.push({ kind: "go_waiting", item, ...(todo ? { todo } : {}) });
        }
      }
      if (item.status === "doing" && isBuildStep(item)) {
        const goal = buildGoal(item, above);
        const reason = requirementGaps(goal);
        if (reason && !failing.has(goal.id)) { failing.add(goal.id); found.push({ kind: "requirements_missing", item: goal, step: item, reason }); }
      }
      visit(item.children, [...above, item]);
    }
  };
  visit(board.plan, []);
  return found;
}
export function gateLine(gate: GateFinding): string {
  const head = `${gate.item.id} ${quote(gate.item.text)}`;
  switch (gate.kind) {
    case "go_waiting": return gate.todo ? `${head} needs the owner's go and waits for the answer on ${gate.todo.id}` :
      `${head} needs the owner's go and For you has no question for it: add one todo with step "${gate.item.id}" and choices, the go first`;
    case "go_missing": return `${head} is at work without the owner's go: stop its job and ask the owner in For you with step "${gate.item.id}"`;
    case "requirements_missing": return `${head} has Build step ${gate.step.id} doing and ${gate.reason}: have the plan or design job ` +
      "quote each line of the owner's request and check it against the design";
    case "merges_without_go": {
      const prs = prNumbers(gate.item.text).map(pr => `PR #${pr}`).join(" and ") || "the merge or push";
      return `${head} is done, and the board shows no owner go that names ${prs}: a repo rule breach. Tell the owner in this run, and add one ` +
        `For you todo with step "${gate.item.id}" naming ${prs}, choices like "Yes, keep it" and "No, revert it"`;
    }
  }
}

/**
 * A goal with a target that is short of it, not measured, or measured too long ago (W54, owner 10-09 on a 200 Mbps proxy plan used at 8 Mbps
 * while every step waited: the check-in should push harder toward each goal). `live` when one of its open steps has a live job.
 * Largest gap first; a goal never measured counts as the largest.
 */
export interface GoalGap { goal: PlanItem; target: GoalTarget; state: TargetState; live: boolean }
export function goalGaps(board: ChatBoard | null, views: readonly StepView[], everyMs: number, now: number): GoalGap[] {
  const gaps = (board?.plan ?? []).flatMap(goal => {
    if (!goal.target || !OPEN.has(goal.status)) return [];
    const state = targetState(goal.target, everyMs, now);
    if (state.kind === "measured" && state.ratio >= 1 && !state.stale) return [];
    return [{ goal, target: goal.target, state, live: views.some(view => view.goal?.id === goal.id && view.cls === "live") }];
  });
  const short = (gap: GoalGap) => gap.state.kind === "unmeasured" ? 1 : 1 - gap.state.ratio;
  return gaps.sort((a, b) => short(b) - short(a));
}
/** A goal gap the duty counts in `goal_gaps`: its last measurement is under half the target and no job of it is live. */
export const countedGap = (gap: GoalGap): boolean => gap.state.kind === "measured" && gap.state.ratio < 0.5 && !gap.live;
export function goalGapLine({ goal, target, state, live }: GoalGap): string {
  const head = `${goal.id} ${quote(goal.text)}: ${target.metric} ${targetText(target)}`;
  const jobs = live ? "a job of it is live" : "no live job";
  if (state.kind === "unmeasured") return `${head}; ${jobs}: measure it in this run`;
  const short = `${Math.max(0, 100 - state.percent)}% short`;
  return state.stale ? `${head}, ${short} at its last measurement, not measured since ${localTime(state.measuredAt)}; ${jobs}: measure it again in this run`
    : `${head}, ${short}, measured ${localTime(state.measuredAt)} by ${quote(target.source ?? "")}; ${jobs}`;
}

/** One job of the chat as the brief lists it: its name, state, last activity, its step and its last message. */
function jobLine(fact: JobFact, now: number): string {
  const state = fact.cancelled ? "ended (cancelled)" : STATE_WORD[fact.state];
  const quiet = fact.state === "working" && fact.activityAt !== undefined && now - fact.activityAt > STALE_MS ? `, no activity for ${ago(now - fact.activityAt)}` : "";
  const last = fact.activityAt !== undefined ? `, last activity ${ago(now - fact.activityAt)} ago` : "";
  const step = fact.item ? `, on ${fact.item.id} ${quote(fact.item.text)} (${fact.item.status})` : "";
  const error = fact.state === "failed" && fact.error ? `, error: ${clip(fact.error, 120)}` : "";
  const said = fact.lastMessage ? `, last message at ${clockTime(fact.lastMessage.at)}: ${quote(fact.lastMessage.text)}` : "";
  return `${ownerLabel(fact)}: ${state}${quiet || last}${step}${error}${said}`;
}

/**
 * The check-in precheck as the duty job's brief gives it, plain markdown: the goals nobody works on (`idleGoals`), the steps whose class needs action (`classLine`), the open items that
 * look done, the steps on another thread's work, the other facts, the flagged items the class lines do not cover (a job end with no update),
 * the chat's jobs, and every open step with its class, owner and age, oldest change first. Findings flagged in REPEAT_RUNS or more runs in a
 * row (`streaks`, `flagStreaks`) come first, under Flagged again.
 */
export function checkInPrecheckText(precheck: CheckInPrecheck, facts: readonly JobFact[], flagged: readonly FlaggedSlice[], now: number,
  streaks: Readonly<Record<string, number>> = {}): string {
  const stale = flagged.filter(slice => slice.kind === "stale_steps");
  /** A stale step is listed once, under Stale steps. */
  const staleIds = new Set(stale.map(slice => slice.item));
  const act = precheck.steps.flatMap(view => {
    /** An orphan that looks done needs a check and a close, not a new job: it is listed under Look done only. */
    const line = staleIds.has(view.item.id) || (view.cls === "orphan" && looksDone(view.item) !== null) ? null : classLine(view, now);
    return line ? [view.target ? `${line} (the thread to chase: ${clip(view.target.name, 40)}, thread:${view.target.id})` : line] : [];
  });
  const ended = flagged.filter(slice => slice.kind === "job_end_unrecorded" || slice.kind === "job_end_silent").map(slice => slice.excerpt);
  const idle = flagged.filter(slice => slice.kind === "idle_goals").map(slice => slice.excerpt);
  const gated = flagged.filter(slice => slice.kind === "go_missing" || slice.kind === "requirements_missing").map(slice => slice.excerpt);
  const merged = flagged.filter(slice => slice.kind === "merges_without_go").map(slice => slice.excerpt);
  const open = [...precheck.steps].sort((a, b) => a.changedAt - b.changedAt).map(view => {
    const { item, owner, mine, cls } = view;
    const who = mine ? "owner the chat" : owner ? `owner ${ownerLabel(owner)} (${owner.cancelled ? "ended" : STATE_WORD[owner.state]})` : item.job ? `owner ${item.job} (not found)` : "no owner";
    const until = Date.parse(item.waitUntil ?? "");
    const waits = `${Number.isFinite(until) ? `, waits until ${localTime(until)}` : ""}${item.waitFor ? `, waits for ${quote(item.waitFor)}` : ""}`;
    const note = item.note ? `; note: "${clip(item.note.replace(/\s+/g, " "), 300)}"` : "";
    return `${item.id} (${cls}) ${quote(item.text)} ${item.status}, ${who}${waits}, last change ${ago(now - view.changedAt)} ago${note}`;
  });
  const listed = open.length > MAX_OPEN ? [...open.slice(0, MAX_OPEN - 1), `and ${open.length - MAX_OPEN + 1} more`] : open;
  const section = (head: string, lines: readonly string[]) => lines.length ? [`### ${head}\n${lines.map(line => `- ${line}`).join("\n")}`] : [];
  /** A goal to fold is listed once, under Goals to fold. */
  const folded = new Set(precheck.fold.map(fold => fold.goal.id));
  return [
    ...section(REPEAT_HEAD, repeatLines(streaks, flagged)),
    ...section("Merged without the owner's go (a repo rule breach: report each to the owner in this run; never merge without his go on that PR)", merged),
    ...section("Hard gates broken (the owner's go, the requirements check): fix each now", gated),
    ...section("Goals to fold (apply these board ops in this run, in this order; no goal stays open only to wait)", precheck.fold.map(foldLine)),
    ...section("Plan shape (fix it in this run with board ops: close or fold what shipped, move a loose step under its goal with plan_update parent, " +
      "hand off or remove the rest; the owner should never have to tidy the plan)", [...precheck.held.filter(held => !folded.has(held.goal.id)).map(heldLine),
      ...precheck.loose.filter(goal => !folded.has(goal.id)).map(looseGoalLine),
      ...precheck.extra.length ? [extraGoalsLine(precheck.extra)] : [], ...precheck.underClosed.map(underClosedLine)]),
    ...section("Waits that are over (act on each in this run)", precheck.waitsMet.map(waitMetLine)),
    ...section("No progress in the last hour (work should be moving)", precheck.noProgress ? [noProgressLine(precheck.noProgress)] : []),
    ...section("Goal gaps, largest first (for the largest gaps, push the next concrete step that closes the gap in this run: start or steer a job, " +
      "pull a slot forward; confirming that steps are waiting is not an answer)", precheck.goals.map(goalGapLine)),
    ...section("Blocked on CI, a release or another thread with no job on it (start a job that fixes each blocker in this run, or send its owner a " +
      "concrete patch; marking the step waiting is not an answer)", precheck.blocked.map(blocked => blockedLine(blocked, now))),
    ...section("One session carries too much (split these into your own jobs per part)", flagged.filter(slice => slice.kind === "one_session_load").map(slice => slice.excerpt)),
    ...section("Heartbeats the check-in covers (have the chat delete each)", flagged.filter(slice => slice.kind === "redundant_heartbeats").map(slice => slice.excerpt)),
    ...section("Open goals and no duty", flagged.filter(slice => slice.kind === "goals_without_duty").map(slice => slice.excerpt)),
    ...section("Goals nobody works on (start parallel jobs for their independent work)", idle),
    ...section("Stalled waits (take one action on each in this run: pull the slot forward, start or steer a job, or add a For you todo; \"still waiting\" is not an answer)",
      precheck.stalled.map(stalledLine)),
    ...section("Stale steps (update or close each in this run: a new waitUntil, the job's result, done or dropped)", stale.map(slice => slice.excerpt)),
    ...section("Steps whose class needs action", act),
    ...section("Look done (check the real state: close, keep or reopen)", precheck.done.filter(found => !folded.has(found.item.id)).map(lookDoneLine)),
    ...section("Owned by another thread by an owner ruling", precheck.scope.map(scopeLine)),
    ...section("Job ends the board does not show", ended),
    ...section("Other facts", precheck.facts),
    ...section("Jobs", facts.map(fact => jobLine(fact, now))),
    ...section("Every open step, oldest change first", listed),
  ].join("\n\n") || "The board has no open step and no job.";
}

/** What a step's last change compares: its status, text, owner and waits. A note edit is no change, so a chase note does not hide a stall. */
export const stepSig = (item: PlanItem): string =>
  JSON.stringify([item.status, item.text, planJob(item.job) ?? "", ...(item.waitUntil || item.waitFor ? [item.waitUntil ?? "", item.waitFor ?? ""] : [])]);

/**
 * The check-in duty's metrics (`CHECK_IN_DUTY`), each at most 0. `idle_goals` is an open goal nobody works on (`idleGoals`). `job_end_silent` is a step whose job ended badly (a provider error, an abort,
 * a stop mid-tool, the length limit) with no report, which the server told the chat at once (the check-in record's told ends), not updated a
 * check-in later; such a step is counted there and not again in `job_end_unrecorded`. `scope_misses` is an open step on another thread's work
 * by a ledger handoff (`scopeMisses`, correction c7). `stalled_steps` is a step on a passive wait (`stalledSteps`, c23). `go_missing` and
 * `requirements_missing` are the broken hard gates (`gateFindings`, W50), `merges_without_go` a merge step done without the owner's go on its PR (c49). `goal_gaps` is a goal under half its target with no live job (`countedGap`, W54).
 * `blocked_on_others` is a step blocked on CI, a release or another thread for over an hour with no live job (`blockedOnOthers`, W56).
 * `finished_open` is an open item that looks done (`looksDone`), `loose_goals` an open goal with no step under it (`looseGoals`) and
 * `extra_goals` the open goals over BOARD_LIMITS.openGoals (`extraGoals`), `open_under_closed` an open item right under a closed one
 * (`openUnderClosed`), the plan's shape (c44). `held_elsewhere` is a goal whose every open step another thread holds (`heldElsewhere`) and
 * `wait_met` a step whose named wait is over (`waitsMet`), finished work left open behind a wait (c45). `no_progress` is 1 when no plan
 * item was done in the last hour and some open step is not blocked (`noProgress`). `stale_steps` is an open item with a waitUntil over 24 h
 * past or a job that ended with no update (`staleSteps`, c44); an item counted in `finished_open` or `wait_met` is not counted again. A step's
 * record is counted once, by the first that applies: `job_end_silent`, `job_end_unrecorded`, `stale_steps`, `due_late`. `goals_to_fold` is an
 * open goal whose work runs as a duty or rides other goals' jobs (`goalsToFold`, c46); that goal is not counted again in `finished_open`,
 * `loose_goals` or `held_elsewhere`. `one_session_load` is a goal and another session that owns too many of its open steps (`oneSessionLoad`, c51),
 * `redundant_heartbeats` an active heartbeat of the chat whose work the check-in already does (`redundantHeartbeats`, c51).
 * `goals_without_duty` is 1 for a chat with an open goal and no active duty (`goalsWithoutDuty`).
 */
export type ConvergenceMisses = { orphan_steps: number; due_late: number; stale_chase_24h: number; job_end_unrecorded: number; job_end_silent: number; scope_misses: number;
  idle_goals: number; stalled_steps: number; go_missing: number; requirements_missing: number; merges_without_go: number; goal_gaps: number; blocked_on_others: number; finished_open: number;
  loose_goals: number; extra_goals: number; open_under_closed: number; held_elsewhere: number; wait_met: number;
  no_progress: number; stale_steps: number; goals_to_fold: number; one_session_load: number; redundant_heartbeats: number; goals_without_duty: number };
export const NO_MISSES: ConvergenceMisses = { orphan_steps: 0, due_late: 0, stale_chase_24h: 0, job_end_unrecorded: 0, job_end_silent: 0, scope_misses: 0, idle_goals: 0,
  stalled_steps: 0, go_missing: 0, requirements_missing: 0, merges_without_go: 0, goal_gaps: 0, blocked_on_others: 0, finished_open: 0, loose_goals: 0, extra_goals: 0, open_under_closed: 0,
  held_elsewhere: 0, wait_met: 0, no_progress: 0, stale_steps: 0, goals_to_fold: 0, one_session_load: 0, redundant_heartbeats: 0, goals_without_duty: 0 };
/** What the precheck found on the board besides the step classes: steps on another thread's work, broken hard gates, stalled waits, the plan's shape. */
export interface BoardFindings { scope: readonly ScopeMiss[]; gates: readonly GateFinding[]; stalled: readonly StalledStep[]; goals: readonly GoalGap[]; blocked: readonly BlockedStep[];
  done: readonly { item: PlanItem; reason: string }[]; loose: readonly PlanItem[]; extra: readonly PlanItem[]; underClosed: readonly { item: PlanItem; parent: PlanItem }[];
  held: readonly HeldGoal[]; waitsMet: readonly WaitMet[]; noProgress: NoProgress | null; stale: readonly StaleStep[]; fold: readonly FoldGoal[];
  load?: readonly SessionLoad[]; heartbeats?: readonly ScheduledJob[]; noDuty?: readonly PlanItem[] }

/**
 * The open goals nobody works on (correction c11, Crawler VP 10-09: split work into subagents and jobs actively): a goal none of whose open steps
 * is live (no job at work on it, no thread moving it, the chat not on it) and at least one of whose open steps is an orphan (no live owner, no
 * For you todo, no wait) that does not look done (that one needs a check and a close, not a job). A goal with a live job, or with only waiting
 * and For you steps, is not idle. Board order, with its orphan steps.
 */
export function idleGoals(steps: readonly StepView[]): { goal: { id: string; text: string }; steps: StepView[] }[] {
  const goals = new Map<string, { goal: { id: string; text: string }; views: StepView[] }>();
  for (const view of steps) {
    const goal = view.goal ?? { id: view.item.id, text: view.item.text };
    const entry = goals.get(goal.id) ?? { goal, views: [] };
    entry.views.push(view);
    goals.set(goal.id, entry);
  }
  const unowned = (view: StepView) => view.cls === "orphan" && looksDone(view.item) === null;
  return [...goals.values()].filter(({ views }) => !views.some(view => view.cls === "live") && views.some(unowned))
    .map(({ goal, views }) => ({ goal, steps: views.filter(unowned) }));
}
/** The finding for an idle goal: its open steps with no owner, and the ask to start jobs. */
export const idleGoalLine = ({ goal, steps }: ReturnType<typeof idleGoals>[number]): string =>
  `${goal.id} ${quote(goal.text)} has no live job and ${plural(steps.length, "open step")} nobody owns (${steps.map(view => view.item.id).join(" ")}): ` +
  "start jobs for its independent work now, in parallel";

/**
 * The misses of one chat's classified steps: orphan steps; due steps whose waitUntil passed more than one tick (`everyMs`) ago; stale chases of
 * 24 h or more (a step with an open For you todo is `foryou`, never a chase); steps whose job ended more than one tick ago, after the step last
 * changed (`job_end_silent` when the server told that end as a bad one, else `job_end_unrecorded`); open steps on another thread's work; stalled
 * waits; and broken hard gates (a go still waiting is a fact, not a miss). Each flagged slice names its step (`item`).
 */
export function convergenceMisses(chat: string, steps: readonly StepView[], { scope, gates, stalled, goals, blocked, done, loose, extra, underClosed, held, waitsMet: over,
  noProgress: still, stale, fold, load = [], heartbeats = [], noDuty = [] }: BoardFindings, told: Readonly<Record<string, ToldEnd>>, everyMs: number, now: number): PrecheckOutput & { metrics: ConvergenceMisses; flagged: FlaggedSlice[] } {
  const misses: ConvergenceMisses = { ...NO_MISSES };
  const flagged: FlaggedSlice[] = [];
  const flag = (kind: keyof ConvergenceMisses, item: string, excerpt: string) => { misses[kind]++; flagged.push({ chat, at: now, kind, excerpt, item }); };
  const counted = new Set([...done.map(found => found.item.id), ...over.map(met => met.view.item.id)]);
  const staleById = new Map(stale.filter(entry => !counted.has(entry.item.id)).map(entry => [entry.item.id, entry]));
  for (const view of steps) {
    const id = view.item.id;
    const line = classLine(view, now) ?? `${id} ${view.cls}`;
    if (view.cls === "orphan") flag("orphan_steps", id, line);
    if (view.cls === "stale-chase" && now - view.changedAt >= CHASE_ESCALATE_MS) flag("stale_chase_24h", id, line);
    const owner = view.owner;
    const silent = owner && owner.state !== "working" ? told[owner.key] : undefined;
    const end = owner && !owner.key.startsWith("thread:") && owner.state !== "working" && !owner.cancelled && !holdsOnWait(view.item, now) ? owner.activityAt : undefined;
    const staleStep = staleById.get(id);
    staleById.delete(id);
    if (silent && silent.at > view.changedAt) {
      if (now - silent.at > everyMs) {
        flag("job_end_silent", id, `${id} "${view.item.text.slice(0, 60)}": job ${owner!.name} ${jobEndWords(silent)} ${Math.round((now - silent.at) / 60_000)} min ago with no report and the step has not changed since`);
        continue;
      }
    } else if (end !== undefined && end > view.changedAt && now - end > everyMs) {
      flag("job_end_unrecorded", id, `${id} "${view.item.text.slice(0, 60)}": job ${owner!.name} ended ${Math.round((now - end) / 60_000)} min ago and the step has not changed since`);
      continue;
    }
    if (staleStep) flag("stale_steps", id, staleLine(staleStep));
    else if (view.cls === "due" && now - Date.parse(view.item.waitUntil!) > everyMs) flag("due_late", id, line);
  }
  // An open item with open steps under it is no step view; its stale record still counts.
  for (const entry of staleById.values()) flag("stale_steps", entry.item.id, staleLine(entry));
  for (const miss of scope) { misses.scope_misses++; flagged.push({ chat, at: now, kind: "scope_misses", excerpt: scopeLine(miss), item: miss.item.id }); }
  for (const idle of idleGoals(steps)) { misses.idle_goals++; flagged.push({ chat, at: now, kind: "idle_goals", excerpt: idleGoalLine(idle), item: idle.goal.id }); }
  for (const stall of stalled) { misses.stalled_steps++; flagged.push({ chat, at: now, kind: "stalled_steps", excerpt: stalledLine(stall), item: stall.view.item.id }); }
  for (const gate of gates) {
    if (gate.kind === "go_waiting") continue;
    misses[gate.kind]++;
    flagged.push({ chat, at: now, kind: gate.kind, excerpt: gateLine(gate), item: gate.item.id });
  }
  for (const gap of goals.filter(countedGap)) { misses.goal_gaps++; flagged.push({ chat, at: now, kind: "goal_gaps", excerpt: goalGapLine(gap), item: gap.goal.id }); }
  for (const block of blocked) { misses.blocked_on_others++; flagged.push({ chat, at: now, kind: "blocked_on_others", excerpt: blockedLine(block, now), item: block.view.item.id }); }
  const folded = new Set(fold.map(entry => entry.goal.id));
  for (const entry of fold) flag("goals_to_fold", entry.goal.id, foldLine(entry));
  for (const found of done.filter(found => !folded.has(found.item.id))) { misses.finished_open++; flagged.push({ chat, at: now, kind: "finished_open", excerpt: lookDoneLine(found), item: found.item.id }); }
  for (const goal of loose.filter(goal => !folded.has(goal.id))) { misses.loose_goals++; flagged.push({ chat, at: now, kind: "loose_goals", excerpt: looseGoalLine(goal), item: goal.id }); }
  if (extra.length) { misses.extra_goals = extra.length - BOARD_LIMITS.openGoals; flagged.push({ chat, at: now, kind: "extra_goals", excerpt: extraGoalsLine(extra) }); }
  for (const found of underClosed) { misses.open_under_closed++; flagged.push({ chat, at: now, kind: "open_under_closed", excerpt: underClosedLine(found), item: found.item.id }); }
  for (const goal of held.filter(goal => !folded.has(goal.goal.id))) { misses.held_elsewhere++; flagged.push({ chat, at: now, kind: "held_elsewhere", excerpt: heldLine(goal), item: goal.goal.id }); }
  if (still) { misses.no_progress = 1; flagged.push({ chat, at: now, kind: "no_progress", excerpt: noProgressLine(still) }); }
  for (const met of over) { misses.wait_met++; flagged.push({ chat, at: now, kind: "wait_met", excerpt: waitMetLine(met), item: met.view.item.id }); }
  for (const entry of load) flag("one_session_load", entry.goal.id, sessionLoadLine(entry));
  for (const job of heartbeats) { misses.redundant_heartbeats++; flagged.push({ chat, at: now, kind: "redundant_heartbeats", excerpt: heartbeatLine(job) }); }
  if (noDuty.length) flag("goals_without_duty", noDuty[0]!.id, noDutyLine(noDuty));
  return { metrics: misses, flagged };
}

/** Step counts per class, for a check-in run's record. */
export function classCounts(steps: readonly Pick<StepView, "cls">[]): Record<StepClass, number> {
  const counts = Object.fromEntries(STEP_CLASSES.map(cls => [cls, 0])) as Record<StepClass, number>;
  for (const view of steps) counts[view.cls]++;
  return counts;
}

/**
 * A step that names its wait (a `waitFor`, or a `waitUntil` still ahead): a job that went idle under it is holding on purpose (Crawler VP 10-09:
 * obs-p0 idled for a CI slot and was flagged "ended, unrecorded" every hour). Its end is not "unrecorded"; the wait's own class (waiting, then
 * stale-chase after 2 h without change, or due) keeps the step moving. A bad end (error, abort, length) is still told at once.
 */
export function holdsOnWait(item: Pick<PlanItem, "waitFor" | "waitUntil">, now: number): boolean {
  return item.waitFor !== undefined || Date.parse(item.waitUntil ?? "") > now;
}

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
    const body = text.slice(header[0].length);
    last.set(header[1]!.trim(), { at: message.timestamp ?? 0, text: body.split("\n").map(line => line.trim()).find(Boolean) ?? "" });
  }
  return last;
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

/**
 * How a job's last turn ended when it ended badly (audit 10-09: 51 of 397 finished jobs sent no report; 20 stopped mid-tool, 18 on a provider
 * error, 7 aborted, 5 at the length limit): `error` a provider error (`error` its message), `aborted`, `mid-tool` (the last message is a tool
 * call or a tool result the model never answered), `length` the output length limit. `startedAt` is the job's last start: the last user
 * message or agent message before that end (0 when none).
 */
export type JobEndCause = "error" | "aborted" | "mid-tool" | "length";
export interface JobEnd { cause: JobEndCause; at: number; error?: string; startedAt: number }
const ENDED_BADLY: Partial<Record<StopReason, JobEndCause>> = { error: "error", aborted: "aborted", length: "length", toolUse: "mid-tool" };
/** A job's bad end from its transcript, or null when its last turn ended well or a new input waits after it. Notices and summaries are skipped. */
export function jobEnd(messages: readonly ThreadMessage[]): JobEnd | null {
  let end: Omit<JobEnd, "startedAt"> | null = null;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    if (!end) {
      if (message.role === "user") return null;
      if (message.role === "toolResult") end = { cause: "mid-tool", at: message.timestamp };
      else if (message.role === "assistant") {
        const cause = ENDED_BADLY[message.stopReason];
        if (!cause) return null;
        const error = cause === "error" ? message.errorMessage?.trim().replace(/\s+/g, " ") : undefined;
        end = { cause, at: message.timestamp, ...(error ? { error } : {}) };
      }
      continue;
    }
    if (message.role === "user" || (message.role === "custom" && message.customType === "agent_message")) return { ...end, startedAt: message.timestamp };
  }
  return end ? { ...end, startedAt: 0 } : null;
}
/** The cause in plain words: a provider error with the first 120 characters of its message, aborted, stopped mid-tool, the length limit. */
export function jobEndWords(end: Pick<JobEnd, "cause" | "error">): string {
  switch (end.cause) {
    case "error": return `stopped on a provider error${end.error ? ` ("${clip(end.error, 120)}")` : ""}`;
    case "aborted": return "was aborted";
    case "mid-tool": return "stopped in the middle of a tool call";
    case "length": return "hit the output length limit";
  }
}
/** The `[job]` line the server sends the chat about a job that ended badly with no report: information, the chat decides what to do. */
export const jobEndText = (name: string, end: Pick<JobEnd, "cause" | "error" | "at">): string =>
  `${name} ${jobEndWords(end)} at ${clockTime(end.at)} and sent no report`;

/** `<data dir>/check-ins.json`: the last precheck's memory per chat, and the bad job ends told to each chat (`ends`), through locked-json. */
export interface CheckInRecord {
  get(id: string): Promise<CheckInMemory | undefined>;
  set(id: string, memory: CheckInMemory): Promise<void>;
  forget(id: string): Promise<void>;
  /** The bad job ends already told to a chat, by job key (a child id, or `thread:<sessionId>` for a root): once per end, across restarts. */
  ends(id: string): Promise<Record<string, ToldEnd>>;
  /** Records a told end; ends older than TOLD_END_KEEP_MS before it go. */
  told(id: string, key: string, end: ToldEnd): Promise<void>;
}
/** A bad job end the server told the chat at once: when the job ended and why. Kept apart from the precheck's memory, which each run rewrites. */
export interface ToldEnd { at: number; cause: JobEndCause }
export const TOLD_END_KEEP_MS = 7 * 24 * 60 * 60_000;
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isStepMemo = (value: unknown): value is StepMemo => isRecord(value) && typeof value.sig === "string" && typeof value.at === "number";
const stepMemoOf = (memo: StepMemo): StepMemo => ({ sig: memo.sig, at: memo.at, ...(typeof memo.wait === "string" ? { wait: memo.wait } : {}),
  ...(typeof memo.waitAt === "number" ? { waitAt: memo.waitAt } : {}),
  ...(typeof memo.doneAt === "number" ? { doneAt: memo.doneAt } : {}),
  ...(Array.isArray(memo.untils) && memo.untils.every(until => typeof until === "string") ? { untils: memo.untils.slice(-STALL_UNTILS) } : {}) });
function parseMemory(value: unknown): CheckInMemory | undefined {
  if (!isRecord(value) || typeof value.at !== "number") return undefined;
  const steps = isRecord(value.steps) ? Object.entries(value.steps).flatMap(([id, memo]) => isStepMemo(memo) ? [[id, stepMemoOf(memo)] as const] : []) : [];
  const flags = isRecord(value.flags) ? Object.entries(value.flags).filter((entry): entry is [string, number] => typeof entry[1] === "number") : [];
  return { at: value.at, steps: Object.fromEntries(steps), ...(typeof value.since === "number" ? { since: value.since } : {}),
    ...(flags.length ? { flags: Object.fromEntries(flags) } : {}) };
}
const JOB_END_CAUSES: Record<JobEndCause, true> = { error: true, aborted: true, "mid-tool": true, length: true };
const isToldEnd = (value: unknown): value is ToldEnd => isRecord(value) && typeof value.at === "number" && typeof value.cause === "string" && value.cause in JOB_END_CAUSES;
export function checkInRecord(path: string): CheckInRecord {
  type State = { chats: Record<string, CheckInMemory>; ends: Record<string, Record<string, ToldEnd>> };
  const file: JsonFile<State> = { path, label: "Check-in record", initial: () => ({ chats: {}, ends: {} }), parse(value: unknown) {
    const chats = isRecord(value) && isRecord(value.chats) ? value.chats : {};
    const ends = isRecord(value) && isRecord(value.ends) ? value.ends : {};
    return { chats: Object.fromEntries(Object.entries(chats).flatMap(([id, memo]) => { const parsed = parseMemory(memo); return parsed ? [[id, parsed]] : []; })),
      ends: Object.fromEntries(Object.entries(ends).flatMap(([id, told]) => isRecord(told)
        ? [[id, Object.fromEntries(Object.entries(told).filter((entry): entry is [string, ToldEnd] => isToldEnd(entry[1])))]] : [])) };
  } };
  return {
    async get(id) { return (await snapshotJsonFile(file)).chats[id]; },
    async set(id, memory) { await transactJsonFile(file, state => { state.chats[id] = memory; }); },
    async forget(id) { await transactJsonFile(file, state => { delete state.chats[id]; delete state.ends[id]; }); },
    async ends(id) { return { ...(await snapshotJsonFile(file)).ends[id] }; },
    async told(id, key, end) {
      await transactJsonFile(file, state => {
        const told = state.ends[id] ??= {};
        for (const [other, entry] of Object.entries(told)) if (end.at - entry.at > TOLD_END_KEEP_MS) delete told[other];
        told[key] = end;
      });
    },
  };
}

/**
 * A chat's check-in choices: its interval, and a pause until a time or until resumed, with who paused it (`pausedBy`) and which one (`setter`).
 * The server pauses with `daemon` while the Prime Agent daemon is slow (src/chat-daemon-gate.ts) and resumes only those, each at its own
 * `startAt` so the chats do not all run at once. An older file's `chat` reads as `agent`; an `owner` pause with no setter stays the owner's.
 */
export type CheckInPausedUntil = number | "forever";
export type CheckInBy = "owner" | "agent" | "daemon";
export interface CheckInSetting { everyMs: number; pausedUntil?: CheckInPausedUntil; pausedBy?: CheckInBy; setter?: string; startAt?: number }
/**
 * Who changes a check-in. Only the owner's own page is the owner (`setter` "ui"); the chat through chat_board `check_in` and any other caller of
 * the chat server's API are agents, with their session id as `setter` ("unknown" when the caller did not name itself).
 */
export type CheckInActor = { by: "owner"; setter: "ui" } | { by: "agent"; setter: string };
export const OWNER_UI: CheckInActor = { by: "owner", setter: "ui" };
export const UNKNOWN_AGENT = "unknown";
/** A change the rules refuse; the chat server answers it with 409. */
export class CheckInRefused extends Error {
  readonly status = 409;
}
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
  return Math.max(lastAt + setting.everyMs, pause ?? 0, setting.startAt ?? 0);
}

/** The server's pause of a chat while the daemon is slow; null when the chat is already paused (by the owner, the chat or the server), which stays. */
export function daemonPause(setting: CheckInSetting, now: number): CheckInSetting | null {
  return activePause(setting, now) !== null ? null : { everyMs: setting.everyMs, pausedUntil: "forever", pausedBy: "daemon", setter: "gate" };
}

/** The server's resume of a chat it paused, with the first check-in not before `startAt`; null when the server did not pause it. */
export function daemonResume(setting: CheckInSetting, startAt: number): CheckInSetting | null {
  return setting.pausedBy === "daemon" && setting.pausedUntil !== undefined ? { everyMs: setting.everyMs, startAt } : null;
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
  if (pause === "forever") {
    if (setting.pausedBy === "daemon") return "Check-in: paused while the daemon is slow; it resumes on its own";
    if (setting.pausedBy === "agent") return `Check-in: paused by agent ${setting.setter ?? UNKNOWN_AGENT} until resumed; check_in {pause: null} resumes it`;
    return "Check-in: paused until the owner resumes it";
  }
  if (pause !== null) return `Check-in: paused until ${localTime(pause)}`;
  return `Check-in: every ${setting.everyMs / 60_000} min`;
}

/** What the owner's page or an agent (the chat server's API, or the chat through chat_board `check_in`) changes: the interval, and a pause (null resumes). */
export interface CheckInChange { everyMs?: number; pause?: CheckInPause | null }

/**
 * A change applied to a chat's setting at `now`. Whoever writes later wins, with one limit: an agent cannot pause or resume over a pause in
 * force that the owner or the daemon gate made (the refusal says why); a pause with no author counts as the owner's. An agent's pause, the
 * chat's own or another session's, any agent may change. The interval change always applies.
 */
export function changeCheckIn(current: CheckInSetting, change: CheckInChange, now: number, actor: CheckInActor): { setting: CheckInSetting } | { refused: string } {
  const pause = activePause(current, now);
  if (actor.by === "agent" && change.pause !== undefined && pause !== null && current.pausedBy !== "agent") {
    if (current.pausedBy === "daemon") return { refused: "the server paused check-ins while the daemon is slow; they resume on their own" };
    return { refused: `the owner paused check-ins ${pause === "forever" ? "until they resume them" : `until ${localTime(pause)}`}; that stays` };
  }
  const everyMs = change.everyMs ?? current.everyMs;
  if (change.pause === undefined) {
    return { setting: { everyMs, ...(pause !== null ? { pausedUntil: pause, ...(current.pausedBy ? { pausedBy: current.pausedBy } : {}), ...(current.setter ? { setter: current.setter } : {}) } : {}),
      ...(current.startAt !== undefined ? { startAt: current.startAt } : {}) } };
  }
  if (change.pause === null) return { setting: { everyMs } };
  return { setting: { everyMs, pausedUntil: pauseEnd(change.pause, now), pausedBy: actor.by, setter: actor.setter } };
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
    const result = changeCheckIn(current, change, now, { by: "agent", setter: id });
    if ("refused" in result) { refused = result.refused; return current; }
    return result.setting;
  });
  if (refused) throw new Error(`check_in refused: ${refused}`);
  const pause = activePause(setting, now);
  const what = change.pause === undefined ? `every ${setting.everyMs / 60_000} min` : pause === null ? `resumed, every ${setting.everyMs / 60_000} min`
    : `paused until ${pause === "forever" ? "the owner resumes it" : localTime(pause)}${change.everyMs !== undefined ? `, then every ${setting.everyMs / 60_000} min` : ""}`;
  return CHAT_CHECK_IN_LINE + what;
}

/**
 * `<data dir>/check-in-settings.json`: `{ [chatId]: CheckInSetting }` through locked-json. The owner's page and other agents write it through the
 * chat server, the chat through chat_board `check_in`, the daemon gate in the server.
 */
export interface CheckInSettings {
  all(): Promise<Record<string, CheckInSetting>>;
  get(id: string): Promise<CheckInSetting>;
  update(id: string, change: (setting: CheckInSetting) => CheckInSetting): Promise<CheckInSetting>;
}
function parseSetting(value: unknown): CheckInSetting | undefined {
  if (!isRecord(value) || !validCheckInEvery(value.everyMs)) return undefined;
  const until = value.pausedUntil;
  const pausedUntil = until === "forever" || (typeof until === "number" && Number.isFinite(until)) ? until : undefined;
  const by = value.pausedBy === "chat" ? "agent" : value.pausedBy;
  const pausedBy = by === "owner" || by === "agent" || by === "daemon" ? by : undefined;
  const setter = typeof value.setter === "string" && value.setter !== "" ? value.setter : undefined;
  const startAt = typeof value.startAt === "number" && Number.isFinite(value.startAt) ? value.startAt : undefined;
  return { everyMs: value.everyMs, ...(pausedUntil !== undefined ? { pausedUntil, ...(pausedBy ? { pausedBy } : {}), ...(setter ? { setter } : {}) } : {}),
    ...(startAt !== undefined ? { startAt } : {}) };
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
