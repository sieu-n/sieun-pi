import { bridgeHolds } from "./alert-bridge.ts";
import { BOARD_LIMITS, coversStep, planJob } from "./shared/chat-board.ts";
import type { ChatBoard, ChildAgent, OwnerTodo, PlanItem, PlanStatus, QueuePlace, SessionRow } from "./shared/types.ts";
import { clockTime, localTime } from "./checkin-settings.ts";
import { savedStatePath } from "./job-resume.ts";
import type { OwnerMessage } from "./shared/brief-check.ts";

/** The check-in's step classes: the chat's job facts, the class of each open plan step (`stepClass`), and the line the duty job reads for it. */

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
  /** A duty job's subagent's session id, which a step's stored `sessionId` names. */
  sessionId?: string;
  /** Its turn waits for a working slot in the Mac-wide turn queue (`pi-pool queue --json`). */
  queued?: QueuePlace;
  /** The pending board.wake its session sleeps on (`wakeLabel`): it ended its turn and counts as working until the wake is due (`withWakes`). */
  wake?: string;
}
/**
 * One agent message a job sent the chat: when, and its first line; `factsAt` is when the job last sent one carrying a fact (`noteFacts`), such as a
 * commit, a run id or a count. A status answer with none ("still on it") does not move its goal.
 */
export interface JobMessage { at: number; text: string; factsAt?: number;
  /** The words of the job's last reply that say it holds parked work (`parkedWork`); absent when the reply says none. */
  parked?: string }
/**
 * One plan item as last seen: what it said (`sig`: status, text, owner, waits) and when that last changed; its wait (`wait`: waitFor, waitUntil
 * and owner) and when that last changed (`waitAt`); and the waitUntil values it has had, oldest first (`untils`, the last STALL_UNTILS kept).
 */
export interface StepMemo { sig: string; at: number; wait?: string; waitAt?: number; untils?: string[];
  /** When the item last turned done from another status; an edit to an item already done does not move it. */
  doneAt?: number;
  /** An open item's note facts (`noteFacts`), and when its note last gained one. */
  facts?: string[]; factsAt?: number }
/**
 * When a step's record last moved: its sig changed (`at`) or its note gained a fact (`factsAt`). A job that ended before then has its end on the
 * board; a note edit with no new fact, such as a restamped clock, does not move it (launch main bro 10-13: p87's 02:37Z note named tip run
 * 38331878463 after its job ended at 02:11Z).
 */
export const recordedAt = (memo: StepMemo): number => Math.max(memo.at, memo.factsAt ?? memo.at);
/**
 * The words of a note that carry a number, clock times left out: "3,141", "38305551761", "r8", "64a696e59b". A note that gains one reports
 * something new; a chase note that only restamps a time ("chased again 22:10Z") does not.
 */
export const noteFacts = (note: string | undefined): string[] =>
  [...new Set((note ?? "").replace(/\b\d{1,2}:[0-5x][0-9x](?::\d\d)?Z?/gi, " ").split(/\s+/).map(word => word.replace(/^[("'[]+|[)"',.;:\]]+$/g, ""))
    .filter(word => /\d/.test(word)))];

/** The words of a text that can tell one step from another: five letters or more, not a common word. */
const distinctiveWords = (text: string): Set<string> => new Set(text.toLowerCase().match(/[a-z][a-z0-9-]{4,}/g)?.filter(word => !STOP_WORDS.has(word)) ?? []);
/**
 * Whether an open agent todo is about the step: it names the step's id or links it (`step`), it names a PR the step names (`coversStep`), the step's wait names the todo's id, or the step is
 * blocked and shares a distinctive word with it (a blocked step that "waits for the gateway todo" is covered by the gateway todo). A step at
 * work is never covered by a shared word alone (a crawler thread 10-12: a vendor support todo t22 shared "failed" or the vendor's name with 14
 * open steps, so p92 counted as For you and the no-progress check missed it).
 */
export function todoForStep(step: Pick<PlanItem, "id" | "text" | "waitFor"> & Partial<Pick<PlanItem, "status">>,
  todos: readonly (Pick<OwnerTodo, "text"> & Partial<Pick<OwnerTodo, "id" | "step">>)[]): boolean {
  const id = new RegExp(`\\b${step.id}\\b`);
  const named = new Set(step.waitFor?.match(/\bt\d+\b/g) ?? []);
  const words = step.status === undefined || step.status === "blocked" ? distinctiveWords(`${step.text} ${step.waitFor ?? ""}`) : new Set<string>();
  return todos.some(todo => id.test(todo.text) || coversStep(todo, step) || (todo.id !== undefined && named.has(todo.id)) ||
    [...distinctiveWords(todo.text)].some(word => words.has(word)));
}
/**
 * A step that asks the owner to look at or pick something ("You look at the new Connections on Staging and say good or what to change"), a
 * check step that drives the page in a browser ("Check the list app in Aside at 1440x900"), and a note that says such a check or walk passed.
 */
const OWNER_LOOK = /^\s*you\s+(?:look\s+at|pick|choose|review|try)\b/i;
const BROWSER_CHECK = /^\s*(?:check|walk|test|re-?walk)\b.*\b(?:browser|aside)\b|^\s*(?:walk|re-?walk)\b/i;
const CHECK_PASSED = new RegExp([
  String.raw`\b(?:walk|re-?walk|browser[- ]check|check(?:ed)?\s+in\s+(?:the\s+)?(?:browser|aside))\w*\b[^.\n]{0,80}?\bpass(?:ed|es)?\b`,
  String.raw`\bbrowser[- ]checked\b`, String.raw`\bchecked\s+in\s+(?:the\s+)?(?:browser|aside)\b`,
  String.raw`\bpass(?:ed|es)?\b[^.\n]{0,80}?\bin\s+(?:the\s+)?(?:browser|aside)\b`,
].join("|"), "i");
/** A review that is ready: the owner's look or pick step, and the step whose browser check or walk passed. */
export interface ReadyReview { look: PlanItem; passed: PlanItem }
/**
 * What orders a passed check against the owner's rulings: this run's step memos (when a step turned done, or its note last gained a fact) and
 * what the owner wrote in the chat, his messages and board answers, oldest first.
 */
export interface ReviewHistory { memos: Readonly<Record<string, StepMemo>>; owner: readonly OwnerMessage[] }
/**
 * The owner's look and pick steps that are ready for him and have no question in For you (c32 repeat, owner 10-14: "is any other tabs ready for
 * review? keep listing them in FOR YOU with the links i need to check"). A look step is ready when a step under the same parent passed its browser
 * check: a done check step (BROWSER_CHECK), or a note that says the check or walk passed (CHECK_PASSED). An open check step under that parent
 * means the next round is not checked yet. A todo covers the look step when it links it (`coversStep`) and is open or answered and not yet
 * closed; a shared word is not enough, since t21 about the Inbox named Staging like the Connections step. A step parked by an active rule is left,
 * and so is one whose own wait is not over (`waitOver`). With `history`, the check must have passed after the owner's last ruling on the goal
 * (`lastRuling`): frontend bro's round 2 walk p114 passed at 10-13 23:52Z, the owner asked for round 3 at 10-14 00:44Z, and the check-in still
 * called p115 ready at 03:40Z.
 */
export function readyReviews(board: ChatBoard | null, active?: ReadonlySet<string>, history?: ReviewHistory): ReadyReview[] {
  const ready: ReadyReview[] = [];
  const todos = board?.todos ?? [];
  const asks = todos.filter(todo => !todo.done);
  const byId = new Map<string, PlanItem>();
  walk(board?.plan ?? [], item => { byId.set(item.id, item); });
  const visit = (items: readonly PlanItem[]): void => {
    for (const item of items) {
      const below: PlanItem[] = [];
      const collect = (list: readonly PlanItem[]) => { for (const child of list) { below.push(child); collect(child.children); } };
      collect(item.children);
      const checking = below.some(step => OPEN.has(step.status) && BROWSER_CHECK.test(step.text) && !OWNER_LOOK.test(step.text));
      const passed = below.find(step => (step.status === "done" && BROWSER_CHECK.test(step.text)) || CHECK_PASSED.test(step.note ?? ""));
      if (passed && !checking) {
        const at = history && passedAt(passed, history.memos);
        for (const look of item.children) {
          if (!OPEN.has(look.status) || !OWNER_LOOK.test(look.text) || look === passed || parkedBy(look, active) !== undefined || !waitOver(look, byId, todos)) continue;
          if (asks.some(todo => coversStep(todo, look))) continue;
          if (history && at !== undefined && at <= lastRuling(item, look, todos, history.owner)) continue;
          ready.push({ look, passed });
        }
      }
      visit(item.children);
    }
  };
  visit(board?.plan ?? []);
  return ready;
}
/**
 * Whether a step's wait is over: it has no waitFor, or every step its waitFor names is closed and every todo it names is answered. A wait that
 * names no step or todo ("round 3's review page") lasts until the chat clears it.
 */
function waitOver(step: PlanItem, items: ReadonlyMap<string, PlanItem>, todos: readonly OwnerTodo[]): boolean {
  if (!step.waitFor?.trim()) return true;
  const named = step.waitFor.match(/\b[pt]\d+\b/g) ?? [];
  return named.length > 0 && named.every(id => {
    const item = items.get(id);
    if (item) return CLOSED.has(item.status);
    const todo = todos.find(entry => entry.id === id);
    return todo !== undefined && (todo.done || (todo.reply ?? "").trim() !== "");
  });
}
/** When a check passed: the time its step turned done, or for a note that says it passed, the time the note last gained a fact; unknown with no memo. */
const passedAt = (step: PlanItem, memos: Readonly<Record<string, StepMemo>>): number | undefined => {
  const memo = memos[step.id];
  return memo && (step.status === "done" ? memo.doneAt ?? memo.at : recordedAt(memo));
};
/**
 * When the owner last ruled on a review: his last message or board answer that names the goal or look step by id or names the review's subject
 * (a word both their texts have, "connections" for p106 and p115), or the ask time of the last todo on either step that he answered.
 */
function lastRuling(goal: PlanItem, look: PlanItem, todos: readonly OwnerTodo[], owner: readonly OwnerMessage[]): number {
  const ids = new RegExp(`\\b(?:${goal.id}|${look.id})\\b`);
  const goalWords = distinctiveWords(goal.text);
  const subject = [...distinctiveWords(look.text)].filter(word => goalWords.has(word));
  const said = owner.filter(message => ids.test(message.text) || subject.some(word => distinctiveWords(message.text).has(word))).map(message => message.at);
  const answered = todos.filter(todo => (todo.step === goal.id || todo.step === look.id) && (todo.reply ?? "").trim() !== "").map(todo => Date.parse(todo.at));
  return Math.max(-Infinity, ...said, ...answered);
}
export const readyReviewLine = ({ look, passed }: ReadyReview): string =>
  `${look.id} ${quote(look.text)} is ready for the owner: ${passed.id} passed its browser check, and For you has no todo for it. Add one todo now ` +
  `with step "${look.id}" and links to each page he checks (the exact URL), in plain words`;

/** Whether an open step waits on the owner: its note says so (WAITS_ON_OWNER). */
export const waitsOnOwner = (item: PlanItem): boolean => item.status === "blocked" && WAITS_ON_OWNER.test(item.note ?? "");

export const OPEN: ReadonlySet<PlanStatus> = new Set(["todo", "doing", "blocked"]);
export const CLOSED: ReadonlySet<PlanStatus> = new Set(["done", "dropped"]);

export function walk(items: readonly PlanItem[], visit: (item: PlanItem, parent: PlanItem | null, siblings: readonly PlanItem[], index: number) => void, parent: PlanItem | null = null): void {
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
export const owns = (fact: JobFact, owner: string): boolean => fact.key === owner || fact.name === owner || fact.key === "thread:" + owner;
/**
 * The fact that owns a step: the thread its stored session id names first, so a renamed thread keeps its steps, else the one its job names, a
 * working one first, so a job the chat started again under the same name owns the steps, not its ended first run.
 */
export const ownerOf = (item: PlanItem, facts: readonly JobFact[]): JobFact | undefined => {
  const owner = stepOwner(item);
  return (item.sessionId ? facts.find(fact => fact.key === "thread:" + item.sessionId || fact.sessionId === item.sessionId) : undefined) ??
    (owner === undefined ? undefined : facts.find(fact => owns(fact, owner) && fact.state === "working") ?? facts.find(fact => owns(fact, owner)));
};

/**
 * The chat's jobs now: every subagent directly under it (one whose parent is not another listed subagent), plus every thread an open plan step
 * names as its owner (`stepOwner`) that is not one of them. An owner that names nothing known, or the chat itself (`self`, its session id), is
 * left out. A cancelled subagent ended; only an error is a failure. `nested` holds the subagents of the chat's duty jobs (a check-in job's
 * helpers): one joins only when an open step names it, by session id or name, a working one first. A subagent in `live` (`liveJobs`) works.
 */
export function jobFacts(children: readonly ChildAgent[], board: ChatBoard | null, rows: readonly SessionRow[], self?: string,
  nested: readonly ChildAgent[] = [], live: ReadonlySet<string> = new Set()): JobFact[] {
  const ids = new Set(children.map(child => child.id));
  const facts = new Map<string, JobFact>();
  // A job that waits on its own subagent is at work (frontend bro 10-12: watchlist table rework waited on its working helper, and p78 was
  // flagged orphan and p14 idle).
  const busy = new Set<string>();
  for (const child of children) {
    if (!childWorking(child) && !live.has(child.id)) continue;
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
    const named = (child: ChildAgent) => (item.sessionId !== undefined && child.sessionId === item.sessionId) || child.id === owner || childName(child) === owner;
    const sub = nested.find(child => named(child) && childWorking(child)) ?? nested.find(named);
    if (sub) {
      facts.set(sub.id, { key: sub.id, name: childName(sub), state: childWorking(sub) || live.has(sub.id) ? "working" : sub.status === "error" ? "failed" : "ended",
        ...(sub.sessionId ? { sessionId: sub.sessionId } : {}), ...(sub.lastActivityAt !== undefined ? { activityAt: sub.lastActivityAt } : {}),
        ...(sub.error ? { error: sub.error } : {}), item: link });
      return;
    }
    const row = rows.find(candidate => candidate.id === item.sessionId) ?? rows.find(candidate => candidate.id === owner || candidate.name === owner);
    if (!row || row.id === self) return;
    const at = Date.parse(row.lastActivityAt ?? "");
    facts.set("thread:" + row.id, { key: "thread:" + row.id, name: row.name, state: row.working ? "working" : row.failure ? "failed" : "ended",
      ...(Number.isFinite(at) ? { activityAt: at } : {}), ...(row.failure ? { error: row.failure } : {}), messages: row.messageCount, item: link });
  });
  return [...facts.values()];
}

/**
 * The subagents that work although their own turn ended: one with a running subagent at any depth below it, or one whose session changed
 * within `windowMs` (the check-in interval). `subagents` holds the daemon's subagents by parent session id (`rosterChildren`), which gives a
 * hub child its session id and last activity too. frontend bro 10-13: its 5 jobs end each turn while their browser checkers and fix jobs run,
 * and the 02:39 and 02:57 check-ins flagged p92 to p97 as orphans with each job "idle". A subagent whose session is in `asleep` (it sleeps on a
 * pending board.wake, `pendingWakes`) works too, so the job above it does.
 */
export function liveJobs(children: readonly ChildAgent[], subagents: ReadonlyMap<string, readonly ChildAgent[]>, now: number, windowMs: number,
  asleep: ReadonlySet<string> = new Set()): Set<string> {
  const listed = new Map([...subagents.values()].flat().map(child => [child.id, child] as const));
  const runningBelow = (session: string, seen: Set<string>): boolean => (subagents.get(session) ?? []).some(child => childWorking(child) ||
    (child.sessionId !== undefined && !seen.has(child.sessionId) && runningBelow(child.sessionId, seen.add(child.sessionId))));
  return new Set(children.filter(child => {
    const session = child.sessionId ?? listed.get(child.id)?.sessionId;
    const at = Math.max(child.lastActivityAt ?? 0, listed.get(child.id)?.lastActivityAt ?? 0);
    return (session !== undefined && (asleep.has(session) || runningBelow(session, new Set([session])))) || now - at < windowMs;
  }).map(child => child.id));
}

/**
 * The longest quiet a working job's session shows between model calls: 157 s at p99 and 1,508 s at p99.9 over 27,578 turns (ff68338). A job
 * quiet longer is not at work, so the check-in's `liveJobs` window is the chat's interval capped at this. With the 2 h interval of AI harness and
 * ops guy, a job that ended 1 h 50 min before still counted as working, and 49 steps read as stuck at 10-14 02:25Z where a 30 min window gave 101.
 */
export const LIVE_GAP_MS = 30 * 60_000;
export const liveWindowMs = (everyMs: number): number => Math.min(everyMs, LIVE_GAP_MS);

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

export const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
export const clip = (text: string, max = 60) => text.length > max ? text.slice(0, max - 1) + "…" : text;
export const quote = (text: string) => `"${clip(text)}"`;
export const ownerLabel = (fact: JobFact) => fact.key.startsWith("thread:") ? `${clip(fact.name, 40)} thread` : `job ${fact.name}`;
/** "p7 (usage backend thread)" for an owner with a plan item, else "job api-audit" or "usage backend thread". */
const factLabel = (fact: JobFact) => fact.item ? `${fact.item.id} (${ownerLabel(fact)})` : ownerLabel(fact);
export const STATE_WORD: Record<JobState, string> = { working: "working", ended: "idle", failed: "failed" };
/** An owner's state as a precheck line names it: "ended" when cancelled, "asleep on a board.wake at 14:40Z" while it sleeps on a wake. */
export const ownerState = (fact: JobFact): string => fact.cancelled ? "ended" : fact.wake ? `asleep on ${fact.wake}` : STATE_WORD[fact.state];
export function ago(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 120) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} h` : `${Math.round(hours / 24)} d`;
}

/**
 * The class of one open leaf step at a tick; every chat converges to steps that are `live`, `foryou` or `waiting`. `live`: its owner is a job
 * at work, a thread active in the last STEP_STALE_MS, the chat itself on a step it changed in that time, or the alert bridge on a step it just
 * added (`bridgeHolds`). `foryou`: an open owner todo covers
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
  return bridgeHolds(item, changedAt, now) ? "live" : "orphan";
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

/** Whether `text` names `name` as whole words, case folded: no letter or digit right before or after one of its occurrences. */
export function namesWhole(text: string, name: string): boolean {
  const hay = text.toLowerCase();
  const needle = name.trim().toLowerCase();
  if (!needle) return false;
  for (let at = hay.indexOf(needle); at >= 0; at = hay.indexOf(needle, at + 1)) {
    if (!/[a-z0-9]/.test(hay[at - 1] ?? "") && !/[a-z0-9]/.test(hay[at + needle.length] ?? "")) return true;
  }
  return false;
}
/** A job name shorter than this never counts as named in a step's free text, as in `waitTarget`: "dev" would hit "sieun/dev". */
export const JOB_NAME_MIN = 6;
/** The first clause of a wait: what it waits on before "then". */
export const firstClause = (text: string): string => text.split(/;|,? then |\. /i)[0]!;
/**
 * The working job of this chat that the first clause of a wait names (`namesWhole`, a name of JOB_NAME_MIN characters or more, or its child id),
 * the longest name first. A thread is left out: a wait on another thread is a chase. VP of CI 10-15: p200 waited for "ci train lands the d2 and
 * d3 precheck objects; then git rules duty reshape ...", its job git rules duty reshape was deleted once its part ended, and three check-ins in
 * a row counted it stuck on a release while the job ci train worked on that land.
 */
export function waitCarrier(wait: string, facts: readonly JobFact[]): JobFact | undefined {
  if (!wait) return undefined;
  const head = firstClause(wait);
  return facts.filter(fact => fact.state === "working" && !fact.key.startsWith("thread:") &&
    ((fact.name.trim().length >= JOB_NAME_MIN && namesWhole(head, fact.name)) || namesWhole(head, fact.key)))
    .sort((a, b) => b.name.length - a.name.length)[0];
}

/**
 * Whether an open step still owes a job work: the step's owner (`stepOwner`) is the job's id or name, or its job, waitFor, note or text names
 * the job's id or one of its names (JOB_NAME_MIN characters or more) as whole words (`namesWhole`). launch main bro 10-14 04:1xZ to 04:2xZ: the
 * 04:11Z check-in gave 13 build steps the job "release driver" and wrote in each note which build job still pushes its commits ("has the chat
 * wake fair crawl queue for the push"), and a rule that read only the owner and the waitFor deleted four of those jobs.
 */
export function stepNamesJob(item: PlanItem, job: { id: string; names: readonly (string | undefined)[] }): boolean {
  const names = job.names.filter((name): name is string => name !== undefined && name.trim() !== "");
  const owner = stepOwner(item);
  if (owner !== undefined && (owner === job.id || names.includes(owner))) return true;
  const text = [item.job, item.waitFor, item.note, item.text].filter(Boolean).join("\n");
  return namesWhole(text, job.id) || names.some(name => name.trim().length >= JOB_NAME_MIN && namesWhole(text, name));
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
export function withGoals(views: StepView[], board: ChatBoard | null): StepView[] {
  const goals = new Map<string, PlanItem>();
  for (const top of board?.plan ?? []) walk([top], item => goals.set(item.id, top));
  for (const view of views) { const goal = goals.get(view.item.id); if (goal) view.goal = { id: goal.id, text: goal.text }; }
  return views;
}
/** One open leaf step's view: its owner (none when the chat owns it), its class, and the thread to chase for a stale chase. */
export function stepView(item: PlanItem, changedAt: number, self: ReadonlySet<string>, facts: readonly JobFact[], openTodos: readonly Pick<OwnerTodo, "id" | "text">[],
  rows: readonly Pick<SessionRow, "id" | "name" | "archived">[], now: number, active?: ReadonlySet<string>): StepView {
  const named = stepOwner(item);
  const mine = self.has(named ?? "");
  // A job deleted once its part ended leaves its name on the step; the working job its wait names carries the step on (`waitCarrier`).
  const owner = mine ? undefined : ownerOf(item, facts) ?? (named !== undefined ? waitCarrier(item.waitFor ?? "", facts) : undefined);
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
  const line = actLine(view, now);
  const saved = savedStatePath(view.item);
  return line !== null && saved !== undefined ? `${line}. Its job was ended while it waited: spawn a fresh job with the brief, last report and wait saved in ${saved}` : line;
}
function actLine(view: StepView, now: number): string | null {
  const { item, cls, changedAt, owner, mine } = view;
  const head = `${item.id} ${quote(item.text)}`;
  if (cls === "due") {
    const until = Date.parse(item.waitUntil!);
    return `${head} is due since ${now - until < 24 * 60 * 60_000 ? clockTime(until) : localTime(until)}: act on it now (check whether what it waited for happened, then do the next action); the board refuses a later waitUntil (c47)`;
  }
  if (cls === "stale-chase") {
    const on = item.waitFor !== undefined ? `waits for ${quote(item.waitFor)}` : `waits on ${owner ? ownerLabel(owner) : "its owner"}`;
    const age = now - changedAt;
    return age >= CHASE_ESCALATE_MS ? `${head} ${on} for ${ago(age)}: make it a For you todo or replan it now`
      : `${head} ${on} for ${ago(age)}: chase it now; after 24 h make it a For you todo or replan`;
  }
  if (cls === "orphan") {
    if (mine) return `${head} is yours and has not moved for ${ago(now - changedAt)}: start a job, do it now, or ask the owner in For you`;
    const who = owner ? ` (${ownerLabel(owner)} ${ownerState(owner)})` : item.job ? ` (${item.job} not found)` : "";
    return `${head} has no live owner${who}: start a job, take it yourself, or ask the owner in For you`;
  }
  return null;
}
