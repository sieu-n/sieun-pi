import { createHash } from "node:crypto";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { HandoffRule } from "./chat-corrections.ts";
import type { FlaggedSlice, PrecheckOutput } from "./shared/chat-duties.ts";
import { snapshotJsonFile, transactJsonFile, type JsonFile } from "./locked-json.ts";
import { BOARD_LIMITS, planJob } from "./shared/chat-board.ts";
import { CHAT_CHECK_IN_LINE, NUDGE_PREFIX } from "./shared/chat-feed.ts";
import { CHECK_IN_MAX_MINUTES, CHECK_IN_MIN_MINUTES, type ChatBoard, type CheckInPause, type ChildAgent, type OwnerTodo, type PlanItem, type PlanStatus, type SessionRow, type StopReason,
  type ThreadMessage } from "./shared/types.ts";

/**
 * The check-in duty's precheck and prompt (src/shared/chat-duties.ts, `CHECK_IN_DUTY`; src/chats.ts runs it). The server's check-in for a chat: at its own interval (CHECK_IN_MS unless the owner set another, see CheckInSetting) it reads the chat's jobs (its subagents, and every thread an open plan step names as its
 * owner) and the board, compares them with what it saw last time, and steers the chat only with the changes that need the VP. No change, no
 * model call.
 */
export const CHECK_IN_MS = 15 * 60_000;
/** A job that runs with no activity for this long is reported once as stale, until its activity moves again. */
export const STALE_MS = 30 * 60_000;
/** A check-in this soon after the last steer the server sent the chat waits and joins the next one. */
export const CHECK_IN_MERGE_MS = 60_000;
/**
 * Progress within this long keeps a step `live` or `waiting` (`stepClass`): its owner's activity, or its own last change. Past it, a step
 * that waits on another thread or an event is a stale chase. A board read error and an ask overflow are told again after this long too.
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
/** One agent message a job sent the chat: when, its first line, and its first 160 characters with the lines joined (the report a step note quotes). */
export interface JobMessage { at: number; text: string; head?: string }
/** `failedAt`/`retries`/`retriedAt`: an owner of an open step that stays failed is reported again on the RETRY_BACKOFF_MS schedule. */
export interface JobMemo {
  state: JobState; activityAt?: number; messages?: number; stale?: true; failedAt?: number; retries?: number; retriedAt?: number;
  /** The time of the job message last reported as waiting. */
  waited?: number;
}
/**
 * One plan item as last seen: what it said (`sig`: status, text, owner, waits) and when that last changed, its note's hash and when that last
 * changed, the `sig` at which it was reported as waiting on the owner with no ask, when the server last nudged the thread it waits on, and
 * the end of its job seen unrecorded (`ended`) and already written into its note (`noted`).
 */
export interface StepMemo { sig: string; at: number; nh?: string; noteAt?: number; asked?: string; chased?: number; ended?: number; noted?: number;
  /** When its "looks done" line was last told (`looksDone`). */
  done?: number;
  /** When its scope line (`scopeLine`: it belongs to another thread) was last told. */
  scope?: number }

/** The words of a text that can tell one step from another: five letters or more, not a common word. */
const distinctiveWords = (text: string): Set<string> => new Set(text.toLowerCase().match(/[a-z][a-z0-9-]{4,}/g)?.filter(word => !STOP_WORDS.has(word)) ?? []);
/** Whether an open agent todo is about the step: it names the step's id, the step's wait names the todo's id, or it shares a distinctive word with
 * the step's text or wait (a step that "waits for the gateway todo" is covered by the gateway todo). */
export function todoForStep(step: Pick<PlanItem, "id" | "text" | "waitFor">, todos: readonly (Pick<OwnerTodo, "text"> & Partial<Pick<OwnerTodo, "id">>)[]): boolean {
  const id = new RegExp(`\\b${step.id}\\b`);
  const named = new Set(step.waitFor?.match(/\bt\d+\b/g) ?? []);
  const words = distinctiveWords(`${step.text} ${step.waitFor ?? ""}`);
  return todos.some(todo => id.test(todo.text) || (todo.id !== undefined && named.has(todo.id)) || [...distinctiveWords(todo.text)].some(word => words.has(word)));
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
  /** When the server last told the chat to start a check-in job (`checkInJobDue`), kept across restarts. */
  jobAt?: number;
}
/**
 * What the digest needs besides the facts and the board: the chat's own id and name (a step it owns says "you"; `name` signs a nudge), a board
 * read error, and the catalog rows (the threads a step's `waitFor` can name).
 */
export interface CheckInContext { self?: readonly string[]; name?: string; boardError?: string; rows?: readonly Pick<SessionRow, "id" | "name" | "archived">[];
  /** The server can write a check-in job's brief: a tick past the threshold returns `job` (`checkInJobDue`). */
  fanOut?: boolean;
  /** The ledger's handoffs (`handoffRules`): an open step on another thread's topics gets the scope line. */
  handoffs?: readonly HandoffRule[] }

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
export type StepClass = "live" | "foryou" | "waiting" | "due" | "stale-chase" | "orphan";
export const STEP_CLASSES: readonly StepClass[] = ["live", "foryou", "waiting", "due", "stale-chase", "orphan"];
/** The classes a check-in line asks the chat to act on, every tick while they hold. */
export const ACT_CLASSES: ReadonlySet<StepClass> = new Set(["due", "stale-chase", "orphan"]);
/** A chase this old must become a For you todo or a new plan. */
export const CHASE_ESCALATE_MS = 24 * 60 * 60_000;
/** The thread a stale step waits on is nudged by the server at most this often per step. */
export const NUDGE_EVERY_MS = 2 * 60 * 60_000;

/** What the class of one open leaf step depends on: its last change (status, text, owner or wait), whether the chat owns it, its owner's fact. */
export interface StepFacts { item: PlanItem; changedAt: number; mine: boolean; owner?: JobFact | undefined; openTodos: readonly Pick<OwnerTodo, "id" | "text">[] }
export function stepClass({ item, changedAt, mine, owner, openTodos }: StepFacts, now: number): StepClass {
  const thread = owner?.key.startsWith("thread:") === true;
  if (owner?.state === "working") return "live";
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
 * The thread a step's `waitFor` names, so the server can nudge it: a `thread:<id>` link, a session id, or a session name of at least 6
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
    const name = row.name.trim().toLowerCase();
    if (name.length < 6 || (best && best.name.length >= name.length)) continue;
    const at = text.indexOf(name);
    if (at >= 0 && !/[a-z0-9]/.test(text[at - 1] ?? "") && !/[a-z0-9]/.test(text[at + name.length] ?? "")) best = { id: row.id, name: row.name.trim() };
  }
  return best;
}

/**
 * Every open leaf step of a board (an open item with no open child) with its class, in board order. `changedAt` gives each step's last change
 * (the check-in memory); `self` holds the chat's id and name, so a step it owns is `mine`.
 */
export function classifyBoard(board: ChatBoard | null, facts: readonly JobFact[], changedAt: (item: PlanItem) => number, self: ReadonlySet<string>,
  rows: readonly Pick<SessionRow, "id" | "name" | "archived">[], now: number): StepView[] {
  const openTodos = (board?.todos ?? []).filter(todo => todo.from === "agent" && !todo.done);
  const views: StepView[] = [];
  const visit = (item: PlanItem): boolean => {
    let openBelow = false;
    for (const child of item.children) openBelow = visit(child) || openBelow;
    if (!OPEN.has(item.status)) return openBelow;
    if (!openBelow) views.push(stepView(item, changedAt(item), self, facts, openTodos, rows, now));
    return true;
  };
  for (const item of board?.plan ?? []) visit(item);
  return views;
}
/** One open leaf step's view: its owner (none when the chat owns it), its class, and the thread a stale chase goes to. */
export function stepView(item: PlanItem, changedAt: number, self: ReadonlySet<string>, facts: readonly JobFact[], openTodos: readonly Pick<OwnerTodo, "id" | "text">[],
  rows: readonly Pick<SessionRow, "id" | "name" | "archived">[], now: number): StepView {
  const mine = self.has(stepOwner(item) ?? "");
  const owner = mine ? undefined : ownerOf(item, facts);
  const base = { item, changedAt, mine, owner, openTodos };
  const cls = stepClass(base, now);
  const thread = owner?.key.startsWith("thread:") ? { id: owner.key.slice("thread:".length), name: owner.name } : undefined;
  const target = cls === "stale-chase" ? waitTarget(item.waitFor, rows, self) ?? thread : undefined;
  return { ...base, cls, ...(target ? { target } : {}) };
}

/** One open leaf step as the check-in sees it: its class and what the line about it names. */
export interface StepView extends StepFacts { cls: StepClass; target?: { id: string; name: string } | undefined }

/** The line a step in an ACT_CLASSES class gives at every tick, naming what the chat must do now; null for the others. */
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

/**
 * A note that says the work shipped: shipped, merged, deployed, landed, released, or live (is live, now live, live on production), unless a
 * word up to three words before it, in the same clause, makes it a condition or a wait ("not merged", "after it is deployed", "until landed",
 * "to be released").
 */
const SAYS_SHIPPED = /(?<!\b(?:not|until|after|once|before|when|if|be|awaiting|for|on)\s+(?:\w+\s+){0,3})\b(?:shipped|merged|deployed|landed|released|(?:is|are|now|went|already)\s+live|live\s+on\s+(?:prod|production|staging|main))\b/i;
/**
 * Why an open plan item looks done, or null: every item under it is closed, or its note says it shipped (SAYS_SHIPPED). The check-in then
 * asks for a check against the real state (dev env VP 10-09: a goal stayed open after it was live on production).
 */
export function looksDone(item: Pick<PlanItem, "status" | "note" | "children">): string | null {
  if (!OPEN.has(item.status)) return null;
  if (item.children.length > 0 && item.children.every(child => CLOSED.has(child.status))) return "every step under it is closed";
  const said = SAYS_SHIPPED.exec(item.note ?? "");
  return said ? `its note says "${said[0]}"` : null;
}

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
  const visit = (item: PlanItem) => {
    if (OPEN.has(item.status)) {
      const text = `${item.text}\n${item.note ?? ""}`;
      for (const rule of mine) {
        // The step's own text may name any topic; its note only a phrase of two or more words, because notes mention machines as context
        // (VP of CI 10-09: p56 "CI dashboard" was flagged for "swap" in a note about the ops thread's Grafana panels).
        const topic = matchTopic(item.text, rule.topics) ?? matchTopic(item.note ?? "", rule.topics.filter(topic => /\s/.test(topic.trim())));
        if (topic === undefined) continue;
        if (HANDED_OFF.test(text) || namesTarget(item.waitFor, rule.to) || namesTarget(stepOwner(item), rule.to)) return;
        misses.push({ item, rule, topic });
        return;
      }
    }
    item.children.forEach(visit);
  };
  (board?.plan ?? []).forEach(visit);
  return misses;
}
/** The line for a step that belongs to another thread. */
export const scopeLine = ({ item, rule }: ScopeMiss): string =>
  `${item.id} ${quote(item.text)} belongs to ${rule.to} (correction ${rule.correction}): hand it off with a message to that thread and remove it from this plan`;

/**
 * The kinds of work a check-in job takes over: the three ACT_CLASSES, an open item that looks done (`looksDone`), an open item that belongs to
 * another thread (`scopeMisses`), and a job that ended with no report or whose step was not updated after it ended.
 */
export type CheckInKind = "due" | "stale-chase" | "orphan" | "looks done" | "scope" | "job ended";
const KIND_ORDER: readonly CheckInKind[] = ["looks done", "scope", "due", "stale-chase", "orphan", "job ended"];
/** One item for a check-in job: its kind, its plan item id (a job name for a job with no step), the line the chat would get, and what a checker needs. */
export interface CheckInItem { kind: CheckInKind; id: string; line: string; facts: string;
  /** The top-level plan item (the goal) the item's step is under; none for a job with no step. */
  goal?: string }
/** A check-in job to start: when, its name, its items, and the tick's other lines, which stay the chat's own. */
export interface CheckInJob { at: number; name: string; items: CheckInItem[]; lines: string[] }
/** A chat starts a check-in job at most this often. */
export const CHECK_IN_JOB_EVERY_MS = 60 * 60_000;
/** A tick needs a check-in job at this many items, or this many kinds of item. */
export const CHECK_IN_JOB_MIN_ITEMS = 3;
export const CHECK_IN_JOB_MIN_KINDS = 2;
/** A check-in job's name: `check-in HH:MM`. */
export const isCheckInJob = (name: string): boolean => /^check-in\b/i.test(name.trim());
/**
 * Whether a tick hands its items to a check-in job: at least CHECK_IN_JOB_MIN_ITEMS items or CHECK_IN_JOB_MIN_KINDS kinds, no check-in job of
 * the chat at work, and none started in the last CHECK_IN_JOB_EVERY_MS (`jobAt`, from the check-in memory).
 */
export function checkInJobDue(items: readonly Pick<CheckInItem, "kind">[], facts: readonly Pick<JobFact, "name" | "state">[], jobAt: number | undefined, now: number): boolean {
  if (items.length < CHECK_IN_JOB_MIN_ITEMS && new Set(items.map(item => item.kind)).size < CHECK_IN_JOB_MIN_KINDS) return false;
  if (facts.some(fact => fact.state === "working" && isCheckInJob(fact.name))) return false;
  return jobAt === undefined || now - jobAt >= CHECK_IN_JOB_EVERY_MS;
}

/** Whether a reminder for `key` is due: a new or changed condition at once, the same one again after STEP_STALE_MS. */
const reminderDue = (before: Reminder | undefined, key: string, now: number): boolean => before?.key !== key || now - before.at >= STEP_STALE_MS;

/**
 * One tick: the memory to keep, the lines that need the VP, every open leaf step (an open item with no open child) as a line with its class,
 * oldest change first, to list under them, the nudges the server sends to the threads stale steps wait on, and the notes it writes on steps
 * whose job ended unrecorded. With no memory (the first tick) only conditions are reported (a stale job, a step's class, a ready step);
 * transitions need a before. A job counts as finished when it was working last tick, or when it is new since then and its last activity came
 * after it; a cancelled one gives no line, one whose last message since its wake says it waits gives that message once, and a message since its
 * wake is its report. A thread owner gives no line for going idle: it is reported when it posted messages since the last tick. An owner of an
 * open step that stays failed is reported again on the RETRY_BACKOFF_MS schedule. A plan item's last change is when its status, text, owner or
 * wait last differed (the board's `updatedAt` for one never seen before); a note edit is no change. Each open leaf step gets its class
 * (`stepClass`), and every step in ACT_CLASSES gives its line (`classLine`) at every tick while it holds. A stale chase whose `waitFor` names a
 * thread (`waitTarget`), or whose owner is a thread, nudges that thread at most every NUDGE_EVERY_MS. A step whose job (a subagent) ended or
 * replied after the step's last change or note edit, and is still not updated at the next tick, gets that job's report written into its note,
 * once per end, with a line. A board read error keeps the last steps and is reported, and so are more open owner asks than
 * BOARD_LIMITS.openAsks; each again every STEP_STALE_MS while it holds. An open item on another thread's work by a ledger handoff
 * (`scopeMisses`) gives its scope line when first seen, then every STEP_STALE_MS, and is a `scope` item.
 */
export function checkInDigest(previous: CheckInMemory | undefined, facts: readonly JobFact[], board: ChatBoard | null, now: number, context: CheckInContext = {}):
  { memory: CheckInMemory; lines: string[]; open: string[]; nudges: Nudge[]; notes: StepNote[]; job?: CheckInJob; steps: StepView[]; scope: ScopeMiss[] } {
  const lines: string[] = [];
  const jobs: Record<string, JobMemo> = {};
  /** The work a check-in job would take over (`checkInJobDue`), and the lines about it. */
  const items: CheckInItem[] = [];
  const covered = new Set<string>();
  /** Each plan item's goal: the top-level item it is under, or itself. */
  const goalOf = new Map<string, string>();
  for (const top of board?.plan ?? []) walk([top], item => goalOf.set(item.id, top.id));
  const take = (item: CheckInItem) => {
    const goal = goalOf.get(item.id);
    items.push(goal !== undefined ? { ...item, goal } : item);
    covered.add(item.line);
  };
  for (const fact of facts) {
    const before = previous?.jobs[fact.key];
    const label = factLabel(fact);
    const thread = fact.key.startsWith("thread:");
    const stale = fact.item && !CLOSED.has(fact.item.status) && fact.item.status !== "blocked" ? `; the board still says ${fact.item.status}` : "";
    const wasWorking = before ? before.state === "working" : previous !== undefined && (fact.activityAt ?? 0) > previous.at;
    const ended = fact.state !== "working" && (wasWorking || (before !== undefined && before.state !== fact.state));
    const report = jobReport(fact);
    const memo: JobMemo = { state: fact.state, ...(fact.activityAt !== undefined ? { activityAt: fact.activityAt } : {}), ...(fact.messages !== undefined ? { messages: fact.messages } : {}),
      ...(before?.waited !== undefined ? { waited: before.waited } : {}) };
    const added = before?.messages !== undefined && fact.messages !== undefined ? fact.messages - before.messages : 0;
    const jobEnded = ended && !thread && !fact.cancelled && fact.state === "ended";
    if (ended && fact.state === "failed") lines.push(`${label} failed${fact.error ? `: ${clip(fact.error, 120)}` : ""}${stale}`);
    else if (jobEnded && report.waits) {
      if (before?.waited !== report.waits.at) lines.push(`${label} waits: ${quote(report.waits.text)}`);
      memo.waited = report.waits.at;
    } else if (jobEnded) {
      const line = `${label} finished${report.reported ? "" : " with no report"}${stale}`;
      lines.push(line);
      if (!report.reported && !isCheckInJob(fact.name)) {
        take({ kind: "job ended", id: fact.item?.id ?? fact.name, line,
          facts: `job ${fact.name} ended with no report${fact.item ? ` on ${fact.item.id} ${quote(fact.item.text)} (${fact.item.status})` : ""}` });
      }
    }
    else if ((!ended || thread) && fact.state !== "working" && added > 0) lines.push(`${label} has ${added} new ${added === 1 ? "message" : "messages"} and is ${STATE_WORD[fact.state]}${stale}`);
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
  const chatName = context.name ?? context.self?.[1] ?? context.self?.[0] ?? "the chat";
  const openTodos = (board?.todos ?? []).filter(todo => todo.from === "agent" && !todo.done);
  /** Asks already answered: a step whose question the owner answered does not need a new one. */
  const answeredTodos = (board?.todos ?? []).filter(todo => todo.done || (todo.reply ?? "").trim() !== "");
  const firstSeen = Math.min(now, Date.parse(board?.updatedAt ?? "") || now);
  const steps: Record<string, StepMemo> = context.boardError ? { ...previous?.steps } : {};
  const open: { at: number; line: string }[] = [];
  const views: StepView[] = [];
  const nudges: Nudge[] = [];
  const notes: StepNote[] = [];
  /** The class lines go after every other line: the open-steps list repeats each class, so a fold cuts them first. */
  const classLines: string[] = [];
  const scoped = new Map(scopeMisses(board, context.handoffs ?? [], context.self ?? []).map(miss => [miss.item.id, miss]));
  /** Visits an item after its children; returns whether it or anything below it is open. */
  const visit = (item: PlanItem): boolean => {
    let openBelow = false;
    for (const child of item.children) openBelow = visit(child) || openBelow;
    const sig = stepSig(item);
    const before = previous?.steps[item.id];
    const nh = noteHash(item.note);
    const noteAt = before === undefined ? undefined : before.nh === nh ? before.noteAt : now;
    const memo: StepMemo = { sig, at: before ? before.sig === sig ? before.at : now : firstSeen, ...(nh ? { nh } : {}), ...(noteAt !== undefined ? { noteAt } : {}),
      ...(before?.chased !== undefined ? { chased: before.chased } : {}), ...(before?.noted !== undefined ? { noted: before.noted } : {}) };
    steps[item.id] = memo;
    const isOpen = OPEN.has(item.status);
    const done = looksDone(item);
    const noteFacts = item.note ? `; note: "${clip(item.note.replace(/\s+/g, " "), 600)}"` : "";
    const scope = scoped.get(item.id);
    /** A step on another thread's work, told when first seen, then again every STEP_STALE_MS while it stays. */
    if (scope) {
      const line = scopeLine(scope);
      const tell = before?.scope === undefined || now - before.scope >= STEP_STALE_MS;
      memo.scope = tell ? now : before!.scope!;
      if (tell) classLines.push(line);
      take({ kind: "scope", id: item.id, line, facts: `${item.id} ${quote(item.text)} ${item.status}, belongs to ${scope.rule.to} by correction ${scope.rule.correction} ` +
        `(topic "${scope.topic}")${noteFacts}` });
    }
    /** A "looks done" item, told when it starts or its note changes, then again every STEP_STALE_MS while it holds. */
    const tellDone = (reason: string, facts: string) => {
      const line = `${item.id} ${quote(item.text)} looks done (${reason}): verify and close it`;
      const tell = before?.done === undefined || (memo.noteAt ?? 0) > before.done || now - before.done >= STEP_STALE_MS;
      memo.done = tell || before?.done === undefined ? now : before.done;
      if (tell) classLines.push(line);
      take({ kind: "looks done", id: item.id, line, facts: facts + noteFacts });
    };
    if (isOpen && openBelow && done) {
      tellDone(done, `${item.id} ${quote(item.text)} ${item.status}, ${plural(item.children.filter(child => OPEN.has(child.status)).length, "open step")} under it`);
    }
    if (!isOpen || openBelow) return isOpen || openBelow;
    const view = stepView(item, memo.at, self, facts, openTodos, context.rows ?? [], now);
    views.push(view);
    /** An orphan that looks done needs a check and a close, not a new job: its "looks done" line replaces the orphan line. */
    const line = done && view.cls === "orphan" ? null : classLine(view, now);
    if (view.cls === "stale-chase" && view.target && now - (memo.chased ?? -Infinity) >= NUDGE_EVERY_MS) {
      nudges.push({ id: view.target.id, step: item.id, message: nudgeMessage(chatName, item, now - memo.at) });
      memo.chased = now;
    }
    const told = line && (view.cls === "stale-chase" && view.target && memo.chased !== undefined ? `${line} (I asked ${clip(view.target.name, 40)} at ${clockTime(memo.chased)})` : line);
    if (told) classLines.push(told);
    const owner = view.owner;
    if (owner && !owner.key.startsWith("thread:") && owner.state !== "working" && !owner.cancelled && !holdsOnWait(item, now)) {
      const end = Math.max(owner.activityAt ?? 0, owner.lastMessage?.at ?? 0);
      if (end > Math.max(memo.at, memo.noteAt ?? 0)) {
        if (before?.ended === end && memo.noted !== end) {
          const report = owner.lastMessage ? `report: ${owner.lastMessage.head ?? owner.lastMessage.text}` : "no report";
          const auto = `Job ${owner.name} ended at ${clockTime(end)}, ${clip(report, 168)}`;
          notes.push({ step: item.id, note: clip(item.note ? `${auto}\n${item.note}` : auto, BOARD_LIMITS.note) });
          const ended = `${item.id} ${quote(item.text)}: job ${owner.name} ended at ${clockTime(end)} and the step was not updated; I put its report in the step's note: update the step now`;
          lines.push(ended);
          if (!isCheckInJob(owner.name)) take({ kind: "job ended", id: item.id, line: ended, facts: `${item.id} ${quote(item.text)} ${item.status}, job ${owner.name} ended at ${clockTime(end)}, ${report}` });
          memo.noted = end;
        }
        memo.ended = end;
      }
    }
    if (waitsOnOwner(item) && !todoForStep(item, openTodos) && !todoForStep(item, answeredTodos)) {
      if (before?.asked !== sig) lines.push(`${item.id} waits on the owner but For you has no question for it: add one with choices`);
      memo.asked = sig;
    }
    const who = view.mine ? "owner you" : owner ? `owner ${ownerLabel(owner)} (${owner.cancelled ? "ended" : STATE_WORD[owner.state]})` : item.job ? `owner ${item.job} (not found)` : "no owner";
    const until = Date.parse(item.waitUntil ?? "");
    const waits = `${Number.isFinite(until) ? `, waits until ${localTime(until)}` : ""}${item.waitFor ? `, waits for ${quote(item.waitFor)}` : ""}`;
    const openLine = `${item.id} (${view.cls}) ${quote(item.text)} ${item.status}, ${who}${waits}, last change ${ago(now - memo.at)} ago${done ? ", looks done" : ""}`;
    open.push({ at: memo.at, line: openLine });
    if (done) tellDone(done, openLine);
    else if (told && ACT_CLASSES.has(view.cls)) take({ kind: view.cls as CheckInKind, id: item.id, line: told, facts: openLine + noteFacts });
    return true;
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
  lines.push(...classLines);
  const fold = (all: readonly string[]) => all.length > MAX_LINES ? [...all.slice(0, MAX_LINES - 1), `and ${all.length - MAX_LINES + 1} more`] : [...all];
  const sorted = open.sort((a, b) => a.at - b.at).map(entry => entry.line);
  const listed = sorted.length > MAX_OPEN ? [...sorted.slice(0, MAX_OPEN - 1), `and ${sorted.length - MAX_OPEN + 1} more`] : sorted;
  /** A quiet tick (no line) never starts a job. */
  const fanOut = context.fanOut === true && lines.length > 0 && checkInJobDue(items, facts, previous?.jobAt, now);
  const jobAt = fanOut ? now : previous?.jobAt;
  const job: CheckInJob | undefined = fanOut ? { at: now, name: `check-in ${clockTime(now)}`,
    items: KIND_ORDER.flatMap(kind => items.filter(item => item.kind === kind)), lines: fold(lines.filter(line => !covered.has(line))) } : undefined;
  return { memory: { at: now, jobs, steps, answered: answered?.map(todo => todo.id) ?? previous?.answered ?? [], ready: ready?.map(step => step.id) ?? previous?.ready ?? [],
    ...(boardError ? { boardError } : {}), ...(asks ? { asks } : {}), ...(jobAt !== undefined ? { jobAt } : {}) }, lines: fold(lines), open: listed, nudges, notes, ...(job ? { job } : {}), steps: views, scope: [...scoped.values()] };
}

/** What a step's last change compares: its status, text, owner and waits. A note edit is no change, so a chase note does not hide a stall. */
export const stepSig = (item: PlanItem): string =>
  JSON.stringify([item.status, item.text, planJob(item.job) ?? "", ...(item.waitUntil || item.waitFor ? [item.waitUntil ?? "", item.waitFor ?? ""] : [])]);

/**
 * The check-in duty's metrics (`CHECK_IN_DUTY`), each at most 0. `job_end_silent` is a step whose job ended badly (a provider error, an abort,
 * a stop mid-tool, the length limit) with no report, which the server told the chat at once (the check-in record's told ends), not updated a
 * check-in later; such a step is counted there and not again in `job_end_unrecorded`. `scope_misses` is an open step on another thread's work
 * by a ledger handoff (`scopeMisses`, correction c7).
 */
export type ConvergenceMisses = { orphan_steps: number; due_late: number; stale_chase_24h: number; job_end_unrecorded: number; job_end_silent: number; scope_misses: number };
export const NO_MISSES: ConvergenceMisses = { orphan_steps: 0, due_late: 0, stale_chase_24h: 0, job_end_unrecorded: 0, job_end_silent: 0, scope_misses: 0 };

/**
 * The misses of one chat's classified steps: orphan steps; due steps whose waitUntil passed more than one tick (`everyMs`) ago; stale chases of
 * 24 h or more (a step with an open For you todo is `foryou`, never a chase); steps whose job ended more than one tick ago, after the step last
 * changed (`job_end_silent` when the server told that end as a bad one, else `job_end_unrecorded`); and open steps on another thread's work. Each
 * flagged slice names its step (`item`), so the duty can check it again after the chat's turn.
 */
export function convergenceMisses(chat: string, steps: readonly StepView[], scope: readonly ScopeMiss[], told: Readonly<Record<string, ToldEnd>>, everyMs: number, now: number):
  PrecheckOutput & { metrics: ConvergenceMisses; flagged: FlaggedSlice[] } {
  const misses: ConvergenceMisses = { ...NO_MISSES };
  const flagged: FlaggedSlice[] = [];
  const flag = (kind: keyof ConvergenceMisses, view: StepView, excerpt: string) => { misses[kind]++; flagged.push({ chat, at: now, kind, excerpt, item: view.item.id }); };
  for (const view of steps) {
    const line = classLine(view, now) ?? `${view.item.id} ${view.cls}`;
    if (view.cls === "orphan") flag("orphan_steps", view, line);
    if (view.cls === "due" && now - Date.parse(view.item.waitUntil!) > everyMs) flag("due_late", view, line);
    if (view.cls === "stale-chase" && now - view.changedAt >= CHASE_ESCALATE_MS) flag("stale_chase_24h", view, line);
    const owner = view.owner;
    const silent = owner && owner.state !== "working" ? told[owner.key] : undefined;
    if (silent && silent.at > view.changedAt) {
      if (now - silent.at > everyMs) {
        flag("job_end_silent", view, `${view.item.id} "${view.item.text.slice(0, 60)}": job ${owner!.name} ${jobEndWords(silent)} ${Math.round((now - silent.at) / 60_000)} min ago with no report and the step has not changed since`);
      }
      continue;
    }
    const end = owner && !owner.key.startsWith("thread:") && owner.state !== "working" && !owner.cancelled && !holdsOnWait(view.item, now) ? owner.activityAt : undefined;
    if (end !== undefined && end > view.changedAt && now - end > everyMs) {
      flag("job_end_unrecorded", view, `${view.item.id} "${view.item.text.slice(0, 60)}": job ${owner!.name} ended ${Math.round((now - end) / 60_000)} min ago and the step has not changed since`);
    }
  }
  for (const miss of scope) { misses.scope_misses++; flagged.push({ chat, at: now, kind: "scope_misses", excerpt: scopeLine(miss), item: miss.item.id }); }
  return { metrics: misses, flagged };
}

/** Step counts per class, for a check-in run's record. */
export function classCounts(steps: readonly Pick<StepView, "cls">[]): Record<StepClass, number> {
  const counts = Object.fromEntries(STEP_CLASSES.map(cls => [cls, 0])) as Record<StepClass, number>;
  for (const view of steps) counts[view.cls]++;
  return counts;
}

/** A nudge the server sends to the thread a stale step waits on: the thread's session id, the step, the text. */
export interface Nudge { id: string; step: string; message: string }
/**
 * A step that names its wait (a `waitFor`, or a `waitUntil` still ahead): a job that went idle under it is holding on purpose (Crawler VP 10-09:
 * obs-p0 idled for a CI slot and was flagged "ended, unrecorded" every hour). Its end is not "unrecorded"; the wait's own class (waiting, then
 * stale-chase after 2 h without change, or due) keeps the step moving. A bad end (error, abort, length) is still told at once.
 */
export function holdsOnWait(item: Pick<PlanItem, "waitFor" | "waitUntil">, now: number): boolean {
  return item.waitFor !== undefined || Date.parse(item.waitUntil ?? "") > now;
}

/** A note the server writes on a step whose job ended unrecorded: the whole new note, the job's line first. */
export interface StepNote { step: string; note: string }
/** The text a thread a step waits on gets, in the owner's words: who asks, which step, how long, and how to answer. */
export function nudgeMessage(chat: string, item: Pick<PlanItem, "id" | "text" | "waitFor">, age: number): string {
  const waits = item.waitFor ? ` (it waits for ${quote(item.waitFor)})` : "";
  return `${NUDGE_PREFIX}${chat}] your step ${item.id} ${quote(item.text)}${waits} has waited ${ago(age)}: what is left, and when? ` +
    `Answer with \`await agent_message.send(answer, receiver_role="sibling", receiver_name="${chat}")\`.`;
}
/** A short hash of a step's note, so the memory sees a note edit without keeping the text. */
const noteHash = (note: string | undefined): string | undefined => note ? createHash("sha256").update(note).digest("hex").slice(0, 12) : undefined;

/** The steer text for a tick that wakes the chat: what changed, then every open plan item so none is skipped. */
export const checkInMessage = (prefix: string, lines: readonly string[], open: readonly string[]): string =>
  `${prefix}What changed:\n${lines.map(line => `- ${line}`).join("\n")}` +
  (open.length ? `\n\nOpen steps, oldest change first:\n${open.map(line => `- ${line}`).join("\n")}` : "");

/** What a check-in job's brief names besides its items: the chat's session id and name, and its board file. */
export interface CheckInJobChat { id: string; name?: string | undefined; board: string }
const KIND_HEAD: Record<CheckInKind, string> = {
  "looks done": "Look done (check the real state: close, keep or reopen)",
  scope: "Scope (the owner gave this work to another thread: hand it off and remove it from the plan)",
  due: "Due (the wait time passed)",
  "stale-chase": "Stale chase (waits on another thread or an event, no progress for 2 h)",
  orphan: "Orphan (no live owner, no todo, no wait)",
  "job ended": "Job ended (no report, or the step was not updated after it)",
};
/** The kinds a goal's verifier takes; each other kind gets its own subagent. */
const VERIFIED: ReadonlySet<CheckInKind> = new Set(["looks done", "due", "orphan"]);
/**
 * The subagents a check-in job must start (frontend bro 10-09: the first check-in job checked its 6 items inline): one verifier per goal for its
 * looks-done, due and orphan items, and one per other kind. None for a single item, which the job checks itself.
 */
export function checkInSubagents(items: readonly CheckInItem[]): string[] {
  if (items.length < 2) return [];
  const goals = new Map<string, string[]>();
  for (const item of items) if (VERIFIED.has(item.kind)) goals.set(item.goal ?? item.id, [...goals.get(item.goal ?? item.id) ?? [], item.id]);
  const verifiers = [...goals].map(([goal, ids]) => `- A verifier for the goal ${goal}: ${[...new Set(ids)].join(" ")}`);
  const others = KIND_ORDER.filter(kind => !VERIFIED.has(kind)).flatMap(kind => {
    const ids = items.filter(item => item.kind === kind).map(item => item.id);
    return ids.length ? [`- One for ${kind}: ${[...new Set(ids)].join(" ")}`] : [];
  });
  return [...verifiers, ...others];
}

/** The Python call the chat runs to start a check-in job from its brief file. */
export const checkInJobCall = (path: string, name: string): string => `await rlm.spawn(open(${JSON.stringify(path)}).read(), name=${JSON.stringify(name)})`;

/**
 * The brief of a check-in job (owner 10-09: "it should spawn subagents to see different things, not the main agent sequentially checking"):
 * the chat only triages; this job starts the subagents `checkInSubagents` names, each with a fresh context, and sends the chat back board ops
 * and owner lines. It checks inline only a single item.
 */
export function checkInJobBrief(job: CheckInJob, chat: CheckInJobChat): string {
  const name = chat.name ?? chat.id;
  const subagents = checkInSubagents(job.items);
  const sections = KIND_ORDER.flatMap(kind => {
    const mine = job.items.filter(item => item.kind === kind);
    return mine.length ? [`### ${KIND_HEAD[kind]}\n${mine.map(item => `- ${item.facts}`).join("\n")}`] : [];
  });
  return [
    `# Check-in job for the chat "${name}"`,
    `You are the check-in job of the chat "${name}" (session id ${chat.id}), started ${localTime(job.at)}. The chat only triages; you check. ` +
      `Its board is the JSON file ${chat.board} (plan, scratch, todos): read it for the full notes and for the owner's rulings in the scratch notes. ` +
      "Do not edit the board and do not do the steps' own work: send the chat what to change.",
    "## How to work",
    subagents.length
      ? "Do not check the items yourself. Start at least these subagents, each with a fresh context and only its own items: one verifier per goal " +
        "and one per other kind. You may split further, never merge:\n" + subagents.join("\n") + "\n" +
        "A verifier checks each of its steps against the real state (the commit on the remote, the live page, the production sha, the other " +
        "thread's last message) and says close, keep or reopen, with what it saw. A stale-chase subagent works out what is left and writes the " +
        "question with an ETA ask that the chat sends to that thread (only the chat can message other threads). A scope subagent reads the scratch " +
        "notes for owner rulings and confirms which thread each step goes to. A job-ended subagent reads that job's last messages and says what the " +
        "step should become.\n" +
        "Start them all at once with `await rlm.spawn(brief, name=...)`. Each brief ends with `await agent_message.send(report, receiver_role=\"parent\")`. " +
        "End your turn and read each reply as it comes. Delete each subagent after you read its report."
      : "There is a single item: check it yourself against the real state (the commit on the remote, the live page, the production sha, the other " +
        "thread's last message), with no subagent.",
    `## Items (${job.items.length})`,
    ...sections,
    "## Reply",
    "When every check has reported, send the chat one message with `await agent_message.send(report, receiver_role=\"parent\")`, then end:\n" +
      "- Board ops: one chat_board op JSON per line, for example " +
      "`{\"op\":\"plan_update\",\"id\":\"p4\",\"status\":\"done\",\"note\":\"live on production at 4f1c2a, checked on the live page\"}`. " +
      "Close a step only on evidence you name in its note.\n" +
      "- Messages: one line per thread the chat should nudge, its name and the question, or \"none\".\n" +
      "- Owner lines: at most 3 short plain lines the owner should hear, or \"none\".",
  ].join("\n\n") + "\n";
}

/** The `[check-in]` steer that hands a tick's items to a check-in job: the items by kind, the call, then the tick's other lines. */
export function checkInJobMessage(prefix: string, job: CheckInJob, path: string): string {
  const kinds = KIND_ORDER.flatMap(kind => {
    const ids = job.items.filter(item => item.kind === kind).map(item => item.id);
    return ids.length ? [`${kind} ${[...new Set(ids)].join(" ")}`] : [];
  });
  return `${prefix}${job.items.length} items need checking: ${kinds.join(", ")}. Do not check them yourself. ` +
    `Start one check-in job now with this call, then end the turn:\n\`${checkInJobCall(path, job.name)}\`\n` +
    "It checks each item in its own subagents and sends you board ops and owner lines. Apply them, and tell the owner only what matters." +
    (job.lines.length ? `\n\nWhat changed:\n${job.lines.map(line => `- ${line}`).join("\n")}` : "");
}

/** Brief files a chat keeps in the check-in jobs folder; older ones are deleted when a new one is written. */
export const CHECK_IN_BRIEFS_KEPT = 5;
/** Writes a check-in job's brief to `<dir>/<chat>-<YYYY-MM-DD-HHMM>.md`, keeps the chat's last CHECK_IN_BRIEFS_KEPT, and returns the path. */
export async function writeCheckInBrief(dir: string, chat: string, at: number, text: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${chat}-${localTime(at).replace(" ", "-").replace(":", "")}.md`);
  await writeFile(path, text);
  const mine = (await readdir(dir)).filter(file => file.startsWith(chat + "-") && file.endsWith(".md")).sort();
  for (const old of mine.slice(0, -CHECK_IN_BRIEFS_KEPT)) await rm(join(dir, old), { force: true });
  return path;
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
    last.set(header[1]!.trim(), { at: message.timestamp ?? 0, text: body.split("\n").map(line => line.trim()).find(Boolean) ?? "", head: body.replace(/\s+/g, " ").trim().slice(0, 160) });
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
/** What the server tells the chat about a job that ended badly with no report, and writes at the top of its step's note. */
export const jobEndText = (name: string, end: Pick<JobEnd, "cause" | "error" | "at">): string =>
  `Job ${name} ${jobEndWords(end)} at ${clockTime(end.at)} and sent no report: re-brief it with a follow-up, restart it, or replace it`;
/** The open plan step a job owns (`stepOwner` names one of `names`: its child id, session id or session name), the first in board order. */
export function ownedStep(board: ChatBoard | null, names: readonly string[]): PlanItem | undefined {
  let found: PlanItem | undefined;
  walk(board?.plan ?? [], item => {
    const owner = stepOwner(item);
    if (!found && owner !== undefined && OPEN.has(item.status) && names.some(name => name === owner || name === "thread:" + owner)) found = item;
  });
  return found;
}
/** The `[check-in]` line for a bad job end, led by its step when it has one; the step's note gets `jobEndText` at the top, its old note under it. */
export function jobEndNotice(name: string, end: Pick<JobEnd, "cause" | "error" | "at">, step?: Pick<PlanItem, "id" | "text" | "note">): { line: string; note?: StepNote } {
  const text = jobEndText(name, end);
  if (!step) return { line: text };
  return { line: `${step.id} ${quote(step.text)}: ${text}`, note: { step: step.id, note: clip(step.note ? `${text}\n${step.note}` : text, BOARD_LIMITS.note) } };
}

/** `<data dir>/check-ins.json`: the last tick's memory per chat, and the bad job ends told to each chat (`ends`), through locked-json. */
export interface CheckInRecord {
  get(id: string): Promise<CheckInMemory | undefined>;
  set(id: string, memory: CheckInMemory): Promise<void>;
  forget(id: string): Promise<void>;
  /** The bad job ends already told to a chat, by job key (a child id, or `thread:<sessionId>` for a root): once per end, across restarts. */
  ends(id: string): Promise<Record<string, ToldEnd>>;
  /** Records a told end; ends older than TOLD_END_KEEP_MS before it go. */
  told(id: string, key: string, end: ToldEnd): Promise<void>;
}
/** A bad job end the server told the chat at once: when the job ended and why. Kept apart from the tick's memory, which each digest rewrites. */
export interface ToldEnd { at: number; cause: JobEndCause }
export const TOLD_END_KEEP_MS = 7 * 24 * 60 * 60_000;
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
function parseMemory(value: unknown): CheckInMemory | undefined {
  if (!isRecord(value) || typeof value.at !== "number" || !isRecord(value.jobs) || !Array.isArray(value.answered) || !Array.isArray(value.ready)) return undefined;
  return { ...(value as unknown as CheckInMemory), steps: isRecord(value.steps) ? value.steps as CheckInMemory["steps"] : {} };
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
