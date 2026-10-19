import { isSessionId, normalizeArtifactTarget, parseArtifactTarget } from "./artifact-link.ts";
import { DUTY_LINK_SHAPE, parseDutyLink } from "./duty-fixes.ts";
import { JARGON_HINT, jargonTerms } from "./reply-lint.ts";
import { upkeepWords } from "./upkeep-title.ts";
import { preApprovalText, releaseGo, type PreApproval } from "./release-go.ts";
import { REQUIREMENT_STATUSES, type ArtifactLink, type BoardActor, type BoardOp, type ChatBoard, type GoalTarget, type OwnerTodo, type PlanItem, type PlanItemInput, type PlanStatus,
  type Requirement, type RequirementStatus } from "./types.ts";

/** The chat board reducer, shared by the `chat_board` tool (agent) and `POST api/threads/<id>/board` (owner). Pure and browser-safe. */

/** A user message that starts with this is the owner acting on the board (the server's steer); the client shows it as a small action line. */
export const BOARD_PREFIX = "[board] ";
export const PLAN_STATUSES: readonly PlanStatus[] = ["todo", "doing", "done", "blocked", "dropped"];
const OWNER_OPS: ReadonlySet<BoardOp["op"]> = new Set(["todo_add", "todo_update", "todo_remove"]);
export const BOARD_OP_NAMES: readonly BoardOp["op"][] = ["plan_set", "plan_add", "plan_update", "plan_remove", "todo_add", "todo_update", "todo_remove"];
/** The refusal for a scratch op: the owner removed the scratchpad on 10-15 ("remove the notepad feature completely"). */
export const SCRATCHPAD_REMOVED = "The board has no scratchpad any more; the owner removed it on 2026-10-15. Put the decision in the note of the step it concerns " +
  "(plan_update {id, note}).";
/**
 * Soft targets for board text and counts (owner 10-18: "all these should be modeled as a soft cap"): an agent's op over one still applies, and
 * its summary ends with a flag that names the target (`softFlags`). `openGoals` is the number of open goals past which the check-in asks the
 * chat to fold goals of one area (c44, owner 10-12: "a few area goals with their open steps under them").
 */
export const BOARD_LIMITS = { text: 500, note: 2000, waitFor: 200, planItems: 500, todos: 100, openGoals: 6, links: 5, label: 120,
  requirements: 30, choices: { min: 2, max: 4, text: 80 } } as const;
const OPEN_STATUSES: ReadonlySet<PlanStatus> = new Set(["todo", "doing", "blocked"]);
/** The open goals: top-level plan items that are todo, doing or blocked. */
export const openGoals = (plan: readonly PlanItem[]): PlanItem[] => plan.filter(item => OPEN_STATUSES.has(item.status));

export type BoardErrorKind = "invalid" | "forbidden" | "unknown";
export class BoardError extends Error {
  // No parameter property: message-limit-check.ts loads this file through steer-wait.ts under plain node, which only strips types.
  readonly kind: BoardErrorKind;
  constructor(kind: BoardErrorKind, message: string) { super(message); this.kind = kind; }
}

export function emptyBoard(now: string): ChatBoard { return { v: 2, rev: 0, plan: [], todos: [], updatedAt: now }; }

export type IdKind = "p" | "t";
/**
 * The highest `p<n>` (plan) and `t<n>` (todo) the board has given: its `lastIds`, or a higher id on it. Before `lastIds`, a new item took the
 * highest id on the board plus one, so a removed step's id went to the next item: on 10-18 ops guy removed the CLIProxy and CPU steps p370
 * and p371, the alert bridge put two NVMe alerts on as p370 and p371, and a refire of either old rule would have rewritten the NVMe notes.
 */
export function idsTop(board: ChatBoard): { p: number; t: number } {
  const top = { p: board.lastIds?.p ?? 0, t: board.lastIds?.t ?? 0 };
  const see = (id: string) => {
    const match = /^([pt])(\d+)$/.exec(id);
    if (match) top[match[1] as IdKind] = Math.max(top[match[1] as IdKind], Number(match[2]));
  };
  walk(board.plan, item => see(item.id));
  for (const todo of board.todos) see(todo.id);
  return top;
}

/** A `newId` that continues after `idsTop`. */
export function nextIds(board: ChatBoard): (kind: IdKind) => string {
  const top = idsTop(board);
  return kind => `${kind}${++top[kind]}`;
}

/** A board file's content as a `ChatBoard`. Throws on anything that is not a v2 board. */
export function parseBoard(value: unknown): ChatBoard {
  const board = value as Record<string, unknown>;
  if (!isRecord(value) || board.v !== 2 || typeof board.rev !== "number" || !Array.isArray(board.plan) || !Array.isArray(board.todos) || typeof board.updatedAt !== "string") {
    throw new Error("Chat board file is malformed.");
  }
  return value as unknown as ChatBoard;
}

/** The plan is a tree of items with an id; these helpers walk, count, find and rewrite it. */
interface Tree<T> { id: string; children: T[] }
function walk<T extends Tree<T>>(items: readonly T[], visit: (item: T, depth: number) => void, depth = 0): void {
  for (const item of items) { visit(item, depth); walk(item.children, visit, depth + 1); }
}
function count<T extends Tree<T>>(items: readonly T[]): number { let total = 0; walk(items, () => { total++; }); return total; }
/**
 * The open items that BOARD_LIMITS.planItems targets. Done and dropped items stay in the file but out of the agent's open plan. When this was a
 * refusal it filled the Crawler VP's board on 10-15 (500 items, 312 closed), so every plan_add failed and the alert bridge retried 18 firings every tick.
 */
const openCount = (items: readonly PlanItem[]): number => { let total = 0; walk(items, item => { if (OPEN_STATUSES.has(item.status)) total++; }); return total; };
/** The item `id` with the chain of items above it, outermost first; null when no item has that id. */
function find<T extends Tree<T>>(items: readonly T[], id: string, above: T[] = []): { item: T; ancestors: T[] } | null {
  for (const item of items) {
    if (item.id === id) return { item, ancestors: above };
    const below = find(item.children, id, [...above, item]);
    if (below) return below;
  }
  return null;
}
/**
 * The plan with each item the board reopened (`reopened`) marked done again once every step under it is closed, steps before the items above
 * them. On 10-15 the Crawler VP moved p361 under done p314 and p378 under done p202; both reopened, their new steps closed by 11:04Z, and
 * both stayed open with their close evidence in the note until the 12:30Z check-in closed them, counted in finished_open by 4 check-ins.
 */
function reclose(plan: readonly PlanItem[]): { plan: PlanItem[]; ids: string[] } {
  const ids: string[] = [];
  const visit = (items: readonly PlanItem[]): PlanItem[] => items.map(item => {
    const children = item.children.length ? visit(item.children) : item.children;
    if (!item.reopened || item.waitFor || !children.length || children.some(child => OPEN_STATUSES.has(child.status))) return children === item.children ? item : { ...item, children };
    const { reopened: _reopened, ...rest } = item;
    ids.push(item.id);
    return { ...rest, status: "done", children };
  });
  const next = visit(plan);
  return { plan: ids.length ? next : [...plan], ids };
}

/** The client's board views share the walk and the find: the mention index, the plan view's collapse-all and focus path. */
export { walk as walkItems, find as findItem };
/** The tree with the item `id` replaced by `change(item)` (null removes it with its children). */
function map<T extends Tree<T>>(items: readonly T[], id: string, change: (item: T) => T | null): T[] {
  const out: T[] = [];
  for (const item of items) {
    if (item.id === id) { const next = change(item); if (next) out.push(next); continue; }
    out.push(item.children.length ? { ...item, children: map(item.children, id, change) } : item);
  }
  return out;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
function invalid(message: string): never { throw new BoardError("invalid", message); }
function str(value: unknown, field: string): string {
  if (typeof value !== "string") invalid(`${field} must be text.`);
  if (!value.trim()) invalid(`${field} cannot be empty.`);
  return value;
}
function optStr(value: unknown, field: string): string | undefined { return value === undefined ? undefined : str(value, field); }
function dutyLinkValue(value: unknown): string {
  if (typeof value !== "string" || !parseDutyLink(value)) invalid(`${DUTY_LINK_SHAPE}.`);
  return value;
}
function nullableStr(value: unknown, field: string): string | null | undefined { return value === null ? null : optStr(value, field); }
function status(value: unknown): PlanStatus | undefined {
  if (value === undefined) return undefined;
  if (!PLAN_STATUSES.includes(value as PlanStatus)) invalid(`status must be one of ${PLAN_STATUSES.join(", ")}.`);
  return value as PlanStatus;
}
function id(value: unknown, field = "id"): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,40}$/.test(value)) invalid(`${field} must be an item id such as p1 or t1.`);
  return value;
}
/** A step's `sessionId`: a session id, `thread:<id>` or a pasted chat URL, stored as the bare id; null clears it. */
function parseSessionId(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return value;
  const text = typeof value === "string" ? value.trim() : "";
  const id = /^[a-zA-Z0-9_-]{1,128}$/.test(text) ? text : jobSession(text);
  return id ?? invalid("sessionId must be a thread's session id, thread:<id> or a chat URL.");
}
/** A step's `waitUntil`: an ISO date-time (a date alone is its midnight UTC), stored in the `toISOString` form. */
function waitUntil(value: unknown): string {
  const at = typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value) ? Date.parse(value) : NaN;
  if (!Number.isFinite(at)) invalid("waitUntil must be an ISO date-time such as 2026-10-09T09:00:00+09:00.");
  return new Date(at).toISOString();
}
const optWaitUntil = (value: unknown): string | undefined => value === undefined ? undefined : waitUntil(value);
const nullableWaitUntil = (value: unknown): string | null | undefined => value === null ? null : optWaitUntil(value);
/** The wait fields a plan item keeps from an input: only the ones set. */
const waits = (input: { waitUntil?: string; waitFor?: string }): Pick<PlanItem, "waitUntil" | "waitFor"> =>
  ({ ...(input.waitUntil ? { waitUntil: input.waitUntil } : {}), ...(input.waitFor ? { waitFor: input.waitFor } : {}) });

function planInput(value: unknown): PlanItemInput {
  if (!isRecord(value)) invalid("Each plan item must be an object with text.");
  const input: PlanItemInput = { text: str(value.text, "text") };
  if (value.id !== undefined) input.id = id(value.id);
  const s = status(value.status); if (s) input.status = s;
  const job = optStr(value.job, "job"); if (job !== undefined) input.job = job;
  const session = parseSessionId(value.sessionId); if (session) input.sessionId = session;
  const note = optStr(value.note, "note"); if (note !== undefined) input.note = note;
  const until = optWaitUntil(value.waitUntil); if (until !== undefined) input.waitUntil = until;
  const event = optStr(value.waitFor, "waitFor"); if (event !== undefined) input.waitFor = event;
  if (value.target !== undefined) input.target = goalTarget(value.target);
  if (value.duty !== undefined) input.duty = dutyLinkValue(value.duty);
  Object.assign(input, gates(value));
  if (value.children !== undefined) {
    if (!Array.isArray(value.children)) invalid("children must be a list of plan items.");
    input.children = value.children.map(planInput);
  }
  return input;
}

type Gates = Pick<PlanItem, "go" | "kind" | "requirements">;
/** A plan op's gate fields: `go` only "needed" (it never clears), `kind` only "build", `requirements` a list of one or more lines. */
function gates(value: Record<string, unknown>): Gates {
  const out: Gates = {};
  if (value.go !== undefined) { if (value.go !== "needed") invalid('go must be "needed"; once a step needs the owner\'s go, it keeps needing it.'); out.go = "needed"; }
  if (value.kind !== undefined) { if (value.kind !== "build") invalid('kind must be "build".'); out.kind = "build"; }
  if (value.requirements !== undefined) out.requirements = requirements(value.requirements);
  return out;
}
function requirements(value: unknown): Requirement[] {
  if (!Array.isArray(value) || !value.length) invalid("requirements must be a list of lines {text, status, evidence?, note?}; null clears it.");
  return value.map(line => {
    if (!isRecord(line)) invalid("Each requirement must be an object with text and status.");
    if (!REQUIREMENT_STATUSES.includes(line.status as RequirementStatus)) invalid(`A requirement's status must be one of ${REQUIREMENT_STATUSES.join(", ")}.`);
    const out: Requirement = { text: str(line.text, "requirement text"), status: line.status as RequirementStatus };
    const evidence = optStr(line.evidence, "requirement evidence"); if (evidence !== undefined) out.evidence = evidence;
    const note = optStr(line.note, "requirement note"); if (note !== undefined) out.note = note;
    return out;
  });
}

const TARGET_SHAPE = "target must be {metric, target, unit, current?, measuredAt?, source?, cadence?, direction?}";
/** A goal's target from an op: metric, a non-negative target and unit; the measurement (current, measuredAt, source) all three or none; cadence only "daily". */
function goalTarget(value: unknown): GoalTarget {
  if (!isRecord(value)) invalid(`${TARGET_SHAPE}.`);
  // A target of 0 is the natural end of a lower-is-better number, such as stuck steps reach 0 (AI harness p529, 10-18), so it is allowed.
  const amount = (field: "target" | "current"): number => {
    const n = value[field];
    if (typeof n !== "number" || !Number.isFinite(n) || n < 0) invalid(`target.${field} must be a non-negative number.`);
    return n;
  };
  const out: GoalTarget = { metric: str(value.metric, "target.metric"), target: amount("target"), unit: str(value.unit, "target.unit") };
  const measured = ["current", "measuredAt", "source"].filter(field => value[field] !== undefined && value[field] !== null);
  if (measured.length && measured.length < 3) invalid("A measurement is target.current, target.measuredAt and target.source together: give all three, or none for a goal not measured yet.");
  if (measured.length) {
    out.current = amount("current");
    const at = typeof value.measuredAt === "string" && /^\d{4}-\d{2}-\d{2}/.test(value.measuredAt) ? Date.parse(value.measuredAt) : NaN;
    if (!Number.isFinite(at)) invalid("target.measuredAt must be an ISO date-time such as 2026-10-09T09:00:00+09:00.");
    out.measuredAt = new Date(at).toISOString();
    out.source = str(value.source, "target.source");
  }
  if (value.cadence !== undefined && value.cadence !== null) { if (value.cadence !== "daily") invalid('target.cadence must be "daily".'); out.cadence = "daily"; }
  if (value.direction !== undefined && value.direction !== null) {
    if (value.direction !== "up" && value.direction !== "down") invalid('target.direction must be "up" (higher is better) or "down" (lower is better).');
    out.direction = value.direction;
  }
  return out;
}

/** Metric words that make lower better: a wait, a time, a latency, a delay or lag, misses, errors, failures, cancels and stuck items. */
const LOWER_IS_BETTER = /\b(waits?|waiting|times?|latenc(?:y|ies)|durations?|delays?|lag|miss(?:es|ed)?|errors?|fail(?:s|ed|ures?)?|cancel(?:l?ed|s)?|stuck)\b/i;
/**
 * Which way a goal's number must go to reach its target: `<=` for lower is better, else `>=`. The target's `direction` decides, then its metric
 * words. VP of CI's p1 "m1-air job start wait from the push, p90" read 157.8 against 10 min and p60 "passed land run time, p50" 141.7 against
 * 45 min, and both were taken as at target on 10-18, which hid the two biggest CI goals from goal_gaps. A target of 0 is always lower is better,
 * and a metric's words count across underscores: AI harness p529 "stuck_steps_all" 6 of target 0 read as done on 10-18.
 */
export const targetOp = (target: Pick<GoalTarget, "metric" | "direction"> & Partial<Pick<GoalTarget, "target">>): ">=" | "<=" =>
  target.direction ? (target.direction === "down" ? "<=" : ">=") : target.target === 0 || LOWER_IS_BETTER.test(target.metric.replace(/_/g, " ")) ? "<=" : ">=";
/**
 * The target to store when an op sets `next` over `kept`: the newer reading of the same metric wins. A check-in job writes the number its
 * precheck read, which can be older than a reading taken since (AI harness p453 10-17: a check-in wrote 29.7% back over the 31.5% that
 * duty-fleet.ts had measured at 22:27Z), and a target given with no measurement keeps the reading it had. A kept reading stamped after `now`,
 * the time of this write, is no newer than anything: in r3c on 10-18 the chat stamped 2 of 10 at 00:45Z at 00:42Z, and the job's real 3 and 6
 * of 10 a minute later read "no change".
 */
export function newerReading(next: GoalTarget, kept: GoalTarget | undefined, now?: string): GoalTarget {
  if (!kept?.measuredAt || kept.current === undefined || kept.metric !== next.metric) return next;
  if (now !== undefined && Date.parse(kept.measuredAt) > Date.parse(now)) return next;
  if (next.measuredAt && Date.parse(next.measuredAt) >= Date.parse(kept.measuredAt)) return next;
  return { ...next, current: kept.current, measuredAt: kept.measuredAt, ...(kept.source !== undefined ? { source: kept.source } : {}) };
}
/** Whether a measured goal reaches its target in its direction (`targetOp`). */
export const targetMet = (target: GoalTarget): boolean =>
  target.current !== undefined && (targetOp(target) === "<=" ? target.current <= target.target : target.current >= target.target);

/** A measurement from the future would never go stale: measuredAt may be at most 5 minutes after now. */
function measuredBy(target: GoalTarget | undefined, now: string): void {
  if (target?.measuredAt && Date.parse(target.measuredAt) > Date.parse(now) + 5 * 60_000) invalid("target.measuredAt is in the future; give the time the measurement was taken.");
}

/** A measurement older than this many check-in intervals is stale; a daily metric's (`cadence: "daily"`) after 24 h. */
export const TARGET_STALE_INTERVALS = 2;
export const targetStaleMs = (target: Pick<GoalTarget, "cadence">, everyMs: number): number => target.cadence === "daily" ? 24 * 60 * 60_000 : TARGET_STALE_INTERVALS * everyMs;
/**
 * How far a measured goal is toward its target, 1 at or past it: current over target for higher-is-better, target over current for
 * lower-is-better (`targetOp`), so a target of 0 reads 1 at 0 and 0 above it.
 */
export function targetRatio(target: GoalTarget): number {
  const current = target.current ?? 0;
  if (targetOp(target) === "<=") return current <= target.target ? 1 : target.target / current;
  return target.target === 0 ? 1 : current / target.target;
}
const amountText = (n: number): string => n.toLocaleString("en-US", { maximumFractionDigits: 2 });
const unitText = (unit: string): string => unit === "%" ? unit : ` ${unit}`;
/** "8 / 200 Mbps (4%)", or "target 200 Mbps, not measured". */
export const targetText = (target: GoalTarget): string => target.current === undefined ? `target ${amountText(target.target)}${unitText(target.unit)}, not measured` :
  `${amountText(target.current)} / ${amountText(target.target)}${unitText(target.unit)} (${Math.round(targetRatio(target) * 100)}%)`;

/** Words that say nothing about a goal's area: plan phases, time words and common words. */
const AREA_STOP_WORDS = new Set(["about", "after", "again", "also", "before", "being", "both", "build", "check", "could", "does", "done", "each", "every", "first",
  "from", "full", "goal", "have", "into", "just", "make", "more", "most", "only", "other", "over", "owner", "plan", "ready", "real", "should", "some", "step",
  "still", "than", "that", "their", "them", "then", "there", "these", "they", "this", "those", "today", "under", "until", "verify", "when", "where", "which",
  "while", "whole", "will", "with", "without", "would", "work"]);
/** The area words of a goal's text: words of 4 letters or more, lowercase, a plural `s` cut, not a stop word. */
export const areaWords = (text: string): Set<string> => new Set((text.toLowerCase().match(/[a-z][a-z0-9]*/g) ?? [])
  .filter(word => word.length >= 4 && !AREA_STOP_WORDS.has(word)).map(word => word.length > 4 && word.endsWith("s") && !word.endsWith("ss") ? word.slice(0, -1) : word));
/**
 * The open goal a new goal's text shares its area with (correction c44, owner 10-10: "new work goes under the goal it belongs to instead of a
 * new top-level goal"): the open goal sharing the most area words, when it shares at least 2 and at least half of the new text's; a tie goes to
 * the first in board order. One shared word is not enough: a vendor name can sit in three separate goals of one board.
 */
export function sameAreaGoal(plan: readonly PlanItem[], text: string): PlanItem | undefined {
  const words = areaWords(text);
  let best: { goal: PlanItem; shared: number } | undefined;
  for (const goal of openGoals(plan)) {
    const other = areaWords(goal.text);
    const shared = [...words].filter(word => other.has(word)).length;
    if (shared >= 2 && shared * 2 >= words.size && shared > (best?.shared ?? 0)) best = { goal, shared };
  }
  return best?.goal;
}

const TARGET_FORMS = "job:<name>, thread:<sessionId> or thread:<sessionId>@<ms>, wiki:<path>, file:<absolute path>, or an http(s) URL";
function links(value: unknown): ArtifactLink[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) invalid("links must be a list of {label, target}.");
  return value.map(link => {
    if (!isRecord(link)) invalid("Each link must be an object with a target.");
    const target = normalizeArtifactTarget(str(link.target, "link target")) ?? invalid(`A link target must be ${TARGET_FORMS}.`);
    const label = link.label === undefined || link.label === "" ? target : str(link.label, "link label");
    return { label, target };
  });
}
function choices(value: unknown): string[] {
  if (!Array.isArray(value)) invalid("choices must be a list of answers, your recommendation first.");
  return value.map(choice => str(choice, "choice").trim());
}

/**
 * A review ask with nothing to open (c32 repeat, owner 10-14: "is any other tabs ready for review? keep listing them in FOR YOU with the links i
 * need to check"): a todo that asks the owner to review, look at or pick something carries the page he checks, in `links` or as an http URL in
 * its text. "Links and screenshots are in the chat" sent him searching the feed (t11 to t14).
 */
const REVIEW_ASK = /\b(?:review|look\s+(?:at|over|through)|(?:take|have)\s+a\s+look|pick|choose|check\s+out|try\s+out)\b/i;
const HTTP_URL = /https?:\/\/\S/i;
export const reviewAskWithoutLink = (todo: Pick<OwnerTodo, "text" | "links">): boolean =>
  REVIEW_ASK.test(todo.text) && !todo.links?.length && !HTTP_URL.test(todo.text);
export const REVIEW_LINK_FLAG = "This todo asks the owner to review, look at or pick something, so it should carry what he opens: " +
  "add links [{label, target}] with each exact page, like {label: \"Connections on Staging\", target: \"http://localhost:5180/app/connections?line=staging\"}, " +
  "or put the URL in the text, with todo_update. \"Links are in the chat\" is not enough (c32).";
/**
 * The flag for a todo whose text uses our internal terms (`jargonTerms`), or null (c32, owner 10-09: "unslop easy word"). Links, URLs and
 * page paths stay: they are what the owner opens.
 */
export function todoJargon(text: string): string | null {
  const terms = jargonTerms(text);
  return terms.length ? `For you is read by the owner in one pass, and this todo uses ${terms.map(term => `"${term}"`).join(", ")}: ` +
    `reword it with todo_update; ${JARGON_HINT} (c32).` : null;
}
/** The c32 and c47 flags on an agent's todo: a leave ask, internal terms, a review ask with nothing to open. The todo is saved either way. */
function todoFlags(todo: OwnerTodo): string[] {
  const jargon = todoJargon(todo.text);
  return [...leaveAsk(todo) ? [LEAVE_ASK_FLAG] : [], ...jargon ? [jargon] : [], ...reviewAskWithoutLink(todo) ? [REVIEW_LINK_FLAG] : []];
}

/** The parts of an agent's op over a soft target in BOARD_LIMITS: long text, many links or requirements, a choice list off 2 to 4. */
function softFlags(op: BoardOp): string[] {
  const flags: string[] = [];
  const long = (what: string, value: string | null | undefined, max: number) => {
    if (typeof value === "string" && value.length > max) flags.push(`${what} is ${value.length} characters, over the ${max} target`);
  };
  const lines = (list: readonly Requirement[] | null | undefined) => {
    if (!list) return;
    if (list.length > BOARD_LIMITS.requirements) flags.push(`requirements has ${list.length} lines, over the ${BOARD_LIMITS.requirements} target`);
    list.forEach((line, index) => { long(`requirement ${index + 1} text`, line.text, BOARD_LIMITS.text); long(`requirement ${index + 1} evidence`, line.evidence, BOARD_LIMITS.note); long(`requirement ${index + 1} note`, line.note, BOARD_LIMITS.note); });
  };
  const target = (value: GoalTarget | null | undefined) => { if (value) { long("target.metric", value.metric, BOARD_LIMITS.label); long("target.source", value.source, BOARD_LIMITS.waitFor); } };
  const item = (input: { text?: string; note?: string | null; waitFor?: string | null; requirements?: readonly Requirement[] | null; target?: GoalTarget | null }) => {
    long("text", input.text, BOARD_LIMITS.text); long("note", input.note, BOARD_LIMITS.note); long("waitFor", input.waitFor, BOARD_LIMITS.waitFor);
    lines(input.requirements); target(input.target);
  };
  const todo = (input: { text?: string; choices?: readonly string[] | null; links?: readonly ArtifactLink[] }) => {
    long("text", input.text, BOARD_LIMITS.text);
    const { min, max, text } = BOARD_LIMITS.choices;
    if (input.choices && (input.choices.length < min || input.choices.length > max)) flags.push(`${input.choices.length} choices, off the ${min} to ${max} target`);
    input.choices?.forEach((choice, index) => long(`choice ${index + 1}`, choice, text));
    if (input.choices && new Set(input.choices).size !== input.choices.length) flags.push("two choices are the same");
    if (input.links && input.links.length > BOARD_LIMITS.links) flags.push(`${input.links.length} links, over the ${BOARD_LIMITS.links} target`);
    input.links?.forEach((link, index) => long(`link ${index + 1} label`, link.label, BOARD_LIMITS.label));
  };
  if (op.op === "plan_set") walkInputs(op.items, item);
  else if (op.op === "plan_add" || op.op === "plan_update") item(op);
  else if (op.op === "todo_add" || op.op === "todo_update") todo(op);
  return flags.length ? [`Saved over a soft target: ${flags.join("; ")}. Shorten it if a shorter one says the same.`] : [];
}

/**
 * The internal detail in a plan title, or null (c61, owner 10-13: "the titles should be human-readable (like fix bug in X, instead of the internal
 * file name , /...)"). It finds a file name with a code or doc extension, a path, a git sha, a CI run id or a ci/ ref; they go in the step's note.
 * A slash word counts as a path when it starts at ~/, ./, ../ or /, carries a scheme, has three or more parts, names a repo folder first
 * (src/x, apps/web), or has a dot or underscore in a part. So "and/or", "UI/UX", "A/B", "24/7" and "10/13" stay plain.
 */
const FILE_EXT = "ts|tsx|mts|cts|js|jsx|mjs|cjs|json|jsonl|md|mdx|py|sh|bash|zsh|svelte|vue|css|scss|html|yml|yaml|toml|ini|cfg|conf|env|lock|txt|log|csv|tsv|sql|db|" +
  "sqlite|go|rs|rb|php|java|kt|swift|c|h|cpp|hpp|plist|xml|png|jpe?g|gif|webp|svg|pdf|zip|tgz|gz|tar|patch|diff|wasm|ipynb";
const FILE_NAME = new RegExp(`(?<![\\w.-])[\\w-]+(?:\\.[\\w-]+)*\\.(?:${FILE_EXT})(?![\\w-])`, "i");
const PRODUCT_JS = /^(?:node|next|nuxt|vue|react|three|chart|express|deno|ember|backbone|d3|p5|alpine|solid)\.js$/i;
const REPO_DIRS = new Set(["src", "lib", "test", "tests", "app", "apps", "components", "packages", "scripts", "docs", "config", "bin", "dist", "build",
  "extension", "extensions", "skills", "node_modules", ".github", ".agents", "public", "static", "server", "client", "shared"]);
const GIT_SHA = /(?<![\w])(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}(?![\w])/;
const RUN_ID = /(?<![\w])\d{8,}(?![\w])/;
function slashPath(word: string): boolean {
  if (/^(?:~|\.{1,2})?\/[\w.~-]/.test(word) || word.includes("://")) return true;
  const parts = word.split("/").filter(Boolean);
  if (parts.length < 2) return false;
  if (parts.length >= 3) return parts.some(part => /\p{L}/u.test(part));
  return REPO_DIRS.has(parts[0]!.toLowerCase()) || parts.some(part => /[._]/.test(part) && /\p{L}/u.test(part));
}
export function titleDetail(text: string): string | null {
  const words = text.split(/\s+/).map(word => word.replace(/^[(["'`\u201c\u2018]+|[)\]"'`\u201d\u2019.,;:!?]+$/g, "")).filter(Boolean);
  for (const word of words) if (/^ci\/\S/i.test(word) || (word.includes("/") && slashPath(word))) return word;
  for (const word of words) { const file = word.match(FILE_NAME)?.[0]; if (file && !PRODUCT_JS.test(file)) return file; }
  return text.match(GIT_SHA)?.[0] ?? text.match(RUN_ID)?.[0] ?? null;
}

/** Parses one untrusted op (an HTTP body or a tool call). The reducer trusts its input after this. */
export function parseBoardOp(value: unknown): BoardOp {
  if (!isRecord(value)) invalid("Each op must be an object with an op field.");
  switch (value.op) {
    case "plan_set":
      if (!Array.isArray(value.items)) invalid("plan_set needs items, a list of plan items.");
      return { op: "plan_set", items: value.items.map(planInput) };
    case "plan_add": {
      const op: BoardOp = { op: "plan_add", text: str(value.text, "text") };
      if (value.parent !== undefined && value.parent !== null) op.parent = id(value.parent, "parent");
      const s = status(value.status); if (s) op.status = s;
      const job = optStr(value.job, "job"); if (job !== undefined) op.job = job;
      const session = parseSessionId(value.sessionId); if (session) op.sessionId = session;
      const until = optWaitUntil(value.waitUntil); if (until !== undefined) op.waitUntil = until;
      const event = optStr(value.waitFor, "waitFor"); if (event !== undefined) op.waitFor = event;
      if (value.target !== undefined) op.target = goalTarget(value.target);
      if (value.duty !== undefined) op.duty = dutyLinkValue(value.duty);
      return Object.assign(op, gates(value));
    }
    case "plan_update": {
      const op: BoardOp = { op: "plan_update", id: id(value.id) };
      if (value.parent !== undefined) op.parent = value.parent === null ? null : id(value.parent, "parent");
      const text = optStr(value.text, "text"); if (text !== undefined) op.text = text;
      const s = status(value.status); if (s) op.status = s;
      const job = nullableStr(value.job, "job"); if (job !== undefined) op.job = job;
      const session = parseSessionId(value.sessionId); if (session !== undefined) op.sessionId = session;
      const note = nullableStr(value.note, "note"); if (note !== undefined) op.note = note;
      const until = nullableWaitUntil(value.waitUntil); if (until !== undefined) op.waitUntil = until;
      const event = nullableStr(value.waitFor, "waitFor"); if (event !== undefined) op.waitFor = event;
      if (value.target !== undefined) op.target = value.target === null ? null : goalTarget(value.target);
      if (value.duty !== undefined) op.duty = value.duty === null ? null : dutyLinkValue(value.duty);
      const set = gates({ go: value.go, kind: value.kind ?? undefined, requirements: value.requirements ?? undefined });
      return Object.assign(op, set, value.kind === null ? { kind: null } : {}, value.requirements === null ? { requirements: null } : {});
    }
    case "plan_remove": return { op: "plan_remove", id: id(value.id) };
    case "scratch_add": case "scratch_update": case "scratch_remove": return invalid(SCRATCHPAD_REMOVED);
    case "todo_add": {
      const op: BoardOp = { op: "todo_add", text: str(value.text, "text") };
      if (value.choices !== undefined) { const list = choices(value.choices); if (list.length) op.choices = list; }
      if (value.step !== undefined) op.step = id(value.step, "step");
      const list = links(value.links); if (list?.length) op.links = list;
      return op;
    }
    case "todo_update": {
      const op: BoardOp = { op: "todo_update", id: id(value.id) };
      const text = optStr(value.text, "text"); if (text !== undefined) op.text = text;
      const list = links(value.links); if (list) op.links = list;
      if (value.choices === null) op.choices = null; else if (value.choices !== undefined) op.choices = choices(value.choices);
      if (value.done !== undefined) { if (typeof value.done !== "boolean") invalid("done must be true or false."); op.done = value.done; }
      if (value.reply === null) op.reply = null;
      else if (value.reply !== undefined) op.reply = str(value.reply, "reply");
      return op;
    }
    case "todo_remove": return { op: "todo_remove", id: id(value.id) };
    default: return invalid(`op must be one of ${BOARD_OP_NAMES.join(", ")}.`);
  }
}

export function parseBoardOps(value: unknown): BoardOp[] {
  if (!Array.isArray(value)) invalid("ops must be a list of board ops.");
  return value.map(parseBoardOp);
}

const quote = (text: string) => `"${text.length > 80 ? text.slice(0, 79) + "…" : text}"`;

/**
 * Applies one op. The board is not mutated; the result has `rev + 1` and `updatedAt: now`. `summary` is one plain sentence in the actor's
 * voice ("Owner checked ..." for the owner, "Added p3 ..." for the agent), used as the steer text and the tool result. An agent's summary
 * then has one "Saved, but ..." line per soft flag: a soft target passed (`softFlags`, the plan or todo count), a c32 todo, a c47 wait or an
 * upkeep title.
 */
export function applyBoardOp(board: ChatBoard, op: BoardOp, actor: BoardActor, now: string, newId: (kind: IdKind) => string): { board: ChatBoard; summary: string } {
  if (actor === "owner" && !OWNER_OPS.has(op.op)) throw new BoardError("forbidden", "The owner changes the todos; the agent keeps the plan.");
  // Summaries are written lowercase ("checked ...") and voiced here: "Owner checked ..." for the owner, "Checked ..." for the agent.
  const voice = (sentence: string) => actor === "owner" ? `Owner ${sentence}` : sentence[0]!.toUpperCase() + sentence.slice(1);
  const done = (next: Partial<ChatBoard>, summary: string, extra: readonly string[] = []) => {
    if (next.plan) {
      const closed = reclose(next.plan);
      if (closed.ids.length) { next = { ...next, plan: closed.plan }; summary += `, closed ${closed.ids.join(", ")} again now that no open step is left under ${closed.ids.length === 1 ? "it" : "them"}`; }
    }
    const flags: string[] = [...extra];
    if (actor === "agent") {
      flags.push(...softFlags(op));
      if (next.plan) {
        flags.push(...waitPushes(board, next.plan), ...goWaits(board, next.plan), ...upkeepTitles(board, next.plan));
        const open = openCount(next.plan);
        if (open > BOARD_LIMITS.planItems && open > openCount(board.plan)) flags.push(`The open plan has ${open} goals and steps, over the ${BOARD_LIMITS.planItems} target; mark finished ones done or dropped.`);
        next = { ...next, plan: markMerges(next.plan) };
      }
      if (next.todos && next.todos.length > BOARD_LIMITS.todos && next.todos.length > board.todos.length) {
        flags.push(`The todo list has ${next.todos.length} items, over the ${BOARD_LIMITS.todos} target; remove done ones.`);
      }
    }
    return { board: { ...board, ...next, rev: board.rev + 1, updatedAt: now }, summary: [voice(summary), ...flags].join("\n") };
  };
  const unknown = (what: string, missing: string): never => { throw new BoardError("unknown", `No ${what} ${missing} on the board. Read it again with no ops.`); };
  switch (op.op) {
    case "plan_set": {
      // Ids the items keep are claimed first, so a fresh id never takes one of them; a repeated id gets a fresh one.
      const claimed = new Set<string>();
      walkInputs(op.items, input => { if (input.id) claimed.add(input.id); });
      const used = new Set<string>();
      const fresh = () => { let next = newId("p"); while (claimed.has(next)) next = newId("p"); claimed.add(next); return next; };
      const build = (input: PlanItemInput): PlanItem => {
        const itemId = input.id && !used.has(input.id) ? input.id : fresh();
        used.add(itemId);
        // An item that keeps its id keeps the gate fields and the target its input leaves out: plan_set never drops a go, a requirements check or a target.
        // It keeps its job's session id too while its job stays the same.
        const kept = itemId === input.id ? find(board.plan, itemId)?.item : undefined;
        const job = planJob(input.job);
        const session = input.sessionId ?? jobSession(input.job) ?? (job && job === kept?.job ? kept.sessionId : undefined);
        const target = input.target ? newerReading(input.target, kept?.target, now) : kept?.target;
        const duty = input.duty ?? kept?.duty;
        if (input.target) measuredBy(input.target, now);
        return { id: itemId, text: input.text, status: input.status ?? "todo", ...(job ? { job } : {}), ...(session ? { sessionId: session } : {}), ...(input.note ? { note: input.note } : {}), ...waits(input),
          ...gateFields({ go: input.go ?? kept?.go, kind: input.kind ?? kept?.kind, requirements: input.requirements ?? kept?.requirements }), ...(target ? { target } : {}), ...(duty ? { duty } : {}),
          children: (input.children ?? []).map(build) };
      };
      const plan = op.items.map(build);
      return done({ plan }, `Set the plan: ${count(plan)} items`);
    }
    case "plan_add": {
      const job = planJob(op.job);
      const session = op.sessionId ?? jobSession(op.job);
      if (op.target) measuredBy(op.target, now);
      const item: PlanItem = { id: newId("p"), text: op.text, status: op.status ?? "todo", ...(job ? { job } : {}), ...(session ? { sessionId: session } : {}), ...waits(op), ...gateFields(op), ...(op.target ? { target: op.target } : {}),
        ...(op.duty ? { duty: op.duty } : {}), children: [] };
      if (op.parent === undefined) {
        const area = actor === "agent" ? sameAreaGoal(board.plan, item.text) : undefined;
        return done({ plan: [...board.plan, item] }, `added ${item.id} ${quote(item.text)}${gateText(item)}${item.target ? `, ${item.target.metric} ${targetText(item.target)}` : ""}${dutyText(item)}` +
          (area ? `. ${area.id} ${quote(area.text)} covers the same area: put new work under it unless it is a separate area` : ""));
      }
      const parent = find(board.plan, op.parent) ?? unknown("plan item", op.parent);
      // A step under a finished goal reopens the goal and every finished goal above it: a done parent with open work is a lie.
      const reopened = [...parent.ancestors, parent.item].filter(above => above.status === "done").map(above => above.id);
      let plan = map(board.plan, op.parent, p => ({ ...p, children: [...p.children, item] }));
      for (const above of reopened) plan = map(plan, above, p => ({ ...p, status: "todo", reopened: true }));
      return done({ plan }, `added ${item.id} ${quote(item.text)}${gateText(item)}${dutyText(item)} under ${parent.item.id}${reopened.length ? `, reopened ${reopened.join(", ")}` : ""}`);
    }
    case "plan_update": {
      const { item, ancestors } = find(board.plan, op.id) ?? unknown("plan item", op.id);
      const from = ancestors.at(-1)?.id ?? null;
      const to = op.parent === undefined || op.parent === from ? undefined : op.parent === null ? null : find(board.plan, op.parent) ?? unknown("plan item", op.parent);
      if (to && (to.item.id === item.id || to.ancestors.some(above => above.id === item.id))) invalid(`${item.id} cannot move under itself or under one of its own steps.`);
      const next: PlanItem = { ...item };
      const parts: string[] = [];
      if (op.text !== undefined && op.text !== item.text) { next.text = op.text; parts.push(`renamed it ${quote(op.text)}`); }
      if (op.status !== undefined) delete next.reopened;
      if (op.status !== undefined && op.status !== item.status) { next.status = op.status; parts.push(`marked it ${op.status}`); }
      const job = op.job === null ? null : op.job === undefined ? undefined : planJob(op.job) ?? null;
      // A new job drops the old job's session id; the same job keeps it. sessionId null clears it, a given one replaces it.
      const session = job === null || op.sessionId === null ? undefined
        : op.sessionId ?? jobSession(op.job ?? undefined) ?? (job === undefined || job === item.job ? item.sessionId : undefined);
      if (job === null) { delete next.job; delete next.sessionId; if (item.job || item.sessionId) parts.push("unlinked its job"); }
      else if ((job !== undefined && job !== item.job) || session !== item.sessionId) {
        if (job !== undefined) next.job = job;
        if (session) next.sessionId = session; else delete next.sessionId;
        parts.push(session ? `linked ${next.job ? `job ${next.job}` : "thread"}${session !== next.job ? ` (thread:${session})` : ""}` : job !== undefined ? `linked job ${job}` : "unlinked its thread");
      }
      if (op.note === null) { delete next.note; if (item.note) parts.push("cleared its note"); }
      else if (op.note !== undefined && op.note !== item.note) { next.note = op.note; parts.push("updated its note"); }
      if (op.waitUntil === null) { delete next.waitUntil; if (item.waitUntil) parts.push("cleared its wait time"); }
      else if (op.waitUntil !== undefined && op.waitUntil !== item.waitUntil) { next.waitUntil = op.waitUntil; parts.push(`set it to wait until ${op.waitUntil}`); }
      if (op.waitFor === null) { delete next.waitFor; if (item.waitFor) parts.push("cleared what it waits for"); }
      else if (op.waitFor !== undefined && op.waitFor !== item.waitFor) { next.waitFor = op.waitFor; parts.push(`set it to wait for ${quote(op.waitFor)}`); }
      if (op.go && !item.go) { next.go = op.go; parts.push("marked it as needing the owner's go"); }
      if (op.kind === null) { delete next.kind; if (item.kind) parts.push("cleared its Build mark"); }
      else if (op.kind && !item.kind) { next.kind = op.kind; parts.push("marked it a Build step"); }
      if (op.requirements === null) { delete next.requirements; if (item.requirements) parts.push("cleared its requirements"); }
      else if (op.requirements && JSON.stringify(op.requirements) !== JSON.stringify(item.requirements)) { next.requirements = op.requirements; parts.push(`set its requirements: ${requirementCount(op.requirements)}`); }
      if (op.duty === null) { delete next.duty; if (item.duty) parts.push("unlinked its duty metric"); }
      else if (op.duty && op.duty !== item.duty) { next.duty = op.duty; parts.push(`linked duty metric ${op.duty}`); }
      if (op.target === null) { delete next.target; if (item.target) parts.push("cleared its target"); }
      else if (op.target && JSON.stringify(newerReading(op.target, item.target, now)) !== JSON.stringify(item.target)) {
        measuredBy(op.target, now);
        next.target = newerReading(op.target, item.target, now);
        parts.push(`set its target: ${targetText(next.target)}${next.target.current !== op.target.current ? ", keeping its newer reading" : ""}`);
      }
      if (to === undefined) return done({ plan: map(board.plan, op.id, () => next) }, `updated ${item.id} ${quote(item.text)}: ${parts.join(", ") || "no change"}`);
      // The item moves with its steps and keeps its id; an open item under a finished goal reopens it and every finished goal above it, as plan_add does.
      const rest = map(board.plan, op.id, () => null);
      if (to === null) return done({ plan: [...rest, next] }, `updated ${item.id} ${quote(item.text)}: ${[...parts, "moved it to the top level"].join(", ")}`);
      const reopened = OPEN_STATUSES.has(next.status) ? [...to.ancestors, to.item].filter(above => above.status === "done").map(above => above.id) : [];
      let plan = map(rest, to.item.id, p => ({ ...p, children: [...p.children, next] }));
      for (const above of reopened) plan = map(plan, above, p => ({ ...p, status: "todo", reopened: true }));
      parts.push(`moved it under ${to.item.id}${reopened.length ? `, reopened ${reopened.join(", ")}` : ""}`);
      return done({ plan }, `updated ${item.id} ${quote(item.text)}: ${parts.join(", ")}`);
    }
    case "plan_remove": {
      const { item } = find(board.plan, op.id) ?? unknown("plan item", op.id);
      const removed = count([item]);
      return done({ plan: map(board.plan, op.id, () => null) },
        `removed ${item.id} ${quote(item.text)}${removed > 1 ? ` and its ${removed - 1} ${removed === 2 ? "step" : "steps"}` : ""}`);
    }
    case "todo_add": {
      if (actor === "agent" && op.step !== undefined && !find(board.plan, op.step)) unknown("plan item", op.step);
      const todo: OwnerTodo = { id: newId("t"), text: op.text, done: false, ...(op.choices ? { choices: op.choices } : {}), ...(op.step ? { step: op.step } : {}),
        ...(op.links ? { links: op.links } : {}), from: actor, at: now };
      return done({ todos: [...board.todos, todo] },
        `added a todo ${actor === "owner" ? "" : todo.id + " "}${quote(todo.text)}${todo.step ? ` for ${todo.step}` : ""}${todo.choices ? ` with choices ${todo.choices.map(quote).join(" / ")}` : ""}` +
        `${todo.links ? ` with ${todo.links.length === 1 ? "a link" : `${todo.links.length} links`}` : ""}`, actor === "agent" ? todoFlags(todo) : []);
    }
    case "todo_update": {
      const todo = board.todos.find(entry => entry.id === op.id) ?? unknown("todo", op.id);
      if (actor === "agent" && op.reply !== undefined) throw new BoardError("forbidden", AGENT_REPLY_ERROR);
      const newChoices = op.choices !== undefined && (op.choices ?? []).join("\n") !== (todo.choices ?? []).join("\n");
      if (actor === "agent" && todo.answeredBy === "owner" && (op.text !== undefined && op.text !== todo.text || newChoices)) {
        throw new BoardError("forbidden", "The owner answered this todo; its question stays as asked. Add a new todo for a new question.");
      }
      const next: OwnerTodo = { ...todo };
      const parts: string[] = [];
      if (op.text !== undefined && op.text !== todo.text) {
        next.text = op.text;
        parts.push(`renamed ${quote(todo.text)} to ${quote(op.text)}`);
      }
      if (op.links !== undefined) {
        if (op.links.length) next.links = op.links; else delete next.links;
        parts.push(op.links.length ? `set ${op.links.length === 1 ? "a link" : `${op.links.length} links`} on ${parts.length ? "it" : quote(next.text)}` : `cleared the links on ${parts.length ? "it" : quote(next.text)}`);
      }
      // Choices on an open ask let the owner answer it with a tap, with no re-post that resets its age: every review todo open past 48 h on
      // 10-18 had none (t25 at 92 h), while the asks with choices in the live chats were open at most 44 h.
      if (newChoices) {
        if (op.choices?.length) next.choices = op.choices; else delete next.choices;
        parts.push(op.choices?.length ? `offered ${op.choices.map(quote).join(" / ")} on ${parts.length ? "it" : quote(next.text)}` : `cleared the choices on ${parts.length ? "it" : quote(next.text)}`);
      }
      // The first part names the todo, later parts say "it".
      const label = () => parts.length ? "it" : quote(next.text);
      // A reply that is one of the offered choices is a tap: "chose X for Q", which also covers the check that comes with it.
      const chose = op.reply !== undefined && op.reply !== null && op.reply !== todo.reply && todo.choices?.includes(op.reply) === true;
      if (op.done !== undefined && op.done !== todo.done) { next.done = op.done; if (!(chose && op.done)) parts.push(`${op.done ? "checked" : "unchecked"} ${label()}`); }
      if (op.reply === null) { delete next.reply; delete next.answeredBy; if (todo.reply) parts.push(`cleared the answer on ${label()}`); }
      else if (chose) { next.reply = op.reply!; next.answeredBy = "owner"; parts.push(`chose ${quote(op.reply!)} for ${quote(next.text)}`); }
      else if (op.reply !== undefined && op.reply !== todo.reply) { next.reply = op.reply; next.answeredBy = "owner"; parts.push(parts.length ? `answered: ${op.reply}` : `answered ${label()}: ${op.reply}`); }
      return done({ todos: board.todos.map(entry => entry.id === op.id ? next : entry) }, parts.length ? parts.join(" and ") : `left ${quote(todo.text)} as it was`,
        actor === "agent" && (op.text !== undefined && op.text !== todo.text || op.links !== undefined || newChoices) ? todoFlags(next) : []);
    }
    case "todo_remove": {
      const todo = board.todos.find(entry => entry.id === op.id) ?? unknown("todo", op.id);
      return done({ todos: board.todos.filter(entry => entry.id !== op.id) }, `removed the todo ${quote(todo.text)}`);
    }
  }
}

/**
 * The stored form of a plan item's `job`, its owner: a child name, a session name, or a session id. `thread:<id>`, `thread:<id>@<ms>` and a pasted
 * chat URL keep only the session id; `job:<name>` keeps the name. Undefined when nothing is left.
 */
export function planJob(job: string | undefined): string | undefined {
  const text = job?.trim();
  if (!text) return undefined;
  const target = normalizeArtifactTarget(text);
  const parsed = target ? parseArtifactTarget(target) : null;
  return parsed?.kind === "thread" ? parsed.sessionId : parsed?.kind === "job" ? parsed.name : text;
}

/** The session id a job names itself: `thread:<id>`, `thread:<id>@<ms>`, a pasted chat URL or a bare session id. Undefined for a job name. */
export function jobSession(job: string | undefined): string | undefined {
  const text = job?.trim();
  if (!text) return undefined;
  const target = normalizeArtifactTarget(text);
  const parsed = target ? parseArtifactTarget(target) : null;
  return parsed?.kind === "thread" ? parsed.sessionId : isSessionId(text) ? text : undefined;
}

/**
 * The board with each step in `links` given its owner's session id, where the step has none yet and still names the same job; null when no step
 * changed. The server stores these when it finds a step's job among the chat's agents, so the link survives the job's delete or rename.
 */
export function linkStepSessions(board: ChatBoard, links: ReadonlyMap<string, { job: string; sessionId: string }>, now: string): ChatBoard | null {
  const visit = (items: PlanItem[]): PlanItem[] => {
    let changed = false;
    const out = items.map(item => {
      const link = links.get(item.id);
      const children = visit(item.children);
      const own = link !== undefined && !item.sessionId && item.job === link.job;
      if (!own && children === item.children) return item;
      changed = true;
      return { ...item, ...(own ? { sessionId: link.sessionId } : {}), children };
    });
    return changed ? out : items;
  };
  const plan = visit(board.plan);
  return plan === board.plan ? null : { ...board, plan, rev: board.rev + 1, updatedAt: now };
}

/** A wait on the owner: its first clause names his answer, go, ok, login, review or merge. */
export const OWNER_WAIT = /\b(?:owner|sieun|you)(?:'s|r)?\b.*\b(?:go|ok|approval|answer|decision|choice|login|sign[ -]?in|review|reply|merge|says|decides|confirms|approves|picks)\b/i;
/** The first clause of a wait: what it waits on before "then". */
export const firstClause = (text: string): string => text.split(/;|,? then |\. /i)[0]!;

/**
 * The board after a batch with every open step that still waits on a For you todo the batch closed (checked or removed) handed back to the chat:
 * its wait is cleared, a blocked step reads todo, a step with no owner gets the chat's session id, and its note names the todo, so a go link
 * by id holds. Null when no step waits on a closed todo. A step waits on a todo when its waitFor names the todo's id, or the todo links it and
 * its wait is on the owner or it has none. On 10-18 frontend bro checked off t28 and t25 after the owner approved in the chat at 07:31Z, and
 * p115 and p129 stayed blocked on them until a nudge at 07:41Z, so the 07:38Z whole-system run counted both as stuck.
 */
export function releaseClosedAsks(before: ChatBoard, after: ChatBoard, chatId: string, now: string): { board: ChatBoard; summaries: string[] } | null {
  const closed = before.todos.filter(todo => !todo.done && todo.id !== undefined).flatMap(todo => {
    const next = after.todos.find(entry => entry.id === todo.id);
    return next === undefined ? [todo] : next.done ? [next] : [];
  });
  if (!closed.length) return null;
  const summaries: string[] = [];
  const clock = now.slice(11, 16) + "Z";
  const release = (item: PlanItem): PlanItem => {
    const children = item.children.map(release);
    const same = children.every((child, index) => child === item.children[index]);
    const todo = OPEN_STATUSES.has(item.status) ? closed.find(entry => {
      const named = new RegExp(`(?<![\\w-])${entry.id}(?![\\w-])`).test(item.waitFor ?? "");
      return named || linksStep(entry, item.id) && (item.waitFor === undefined || OWNER_WAIT.test(firstClause(item.waitFor)));
    }) : undefined;
    const owner = item.job !== undefined || item.sessionId !== undefined;
    if (!todo || (item.waitFor === undefined && item.status !== "blocked" && owner)) return same ? item : { ...item, children };
    const answer = todo.reply ? `the owner answered ${quote(todo.reply)}` : "with no answer";
    const next: PlanItem = { ...item, status: item.status === "blocked" ? "todo" : item.status, ...(owner ? {} : { sessionId: chatId }),
      note: `${todo.id} closed at ${clock} ${answer}, so this step waits on nothing and is the chat's to move.${item.note ? " " + item.note : ""}`, children };
    delete next.waitFor;
    summaries.push(`${item.id} ${quote(item.text)} waited on ${todo.id}, which closed ${answer}: it waits on nothing now and is ${owner ? "its owner's" : "the chat's"}; ` +
      "give it its next state (a job, a new For you todo, or done)");
    return next;
  };
  const plan = after.plan.map(release);
  if (!summaries.length) return null;
  return { board: { ...after, plan, rev: after.rev + 1, updatedAt: now }, summaries };
}

/** What the reducer says when the agent writes a todo's answer. */
export const AGENT_REPLY_ERROR = "Only the owner answers a todo; the agent cannot write or clear an answer. Ask with a todo and let the owner answer it on the board.";

/*
 * The owner's go and the requirements check (W50, frontend bro 10-09): a design the owner picked on the demo reached production as if it were
 * approved ("only move things to 5174 when i say 5180 is good enough"), and a variant system missed the owner's ask for separate implementations.
 * Code holds these two gates for the agent; the agents decide everything else.
 */
const HOLD = /\b(?:no|nope|not|wait|hold|later|stop|never|cancel|reject(?:ed)?|don['’]?t|do\s+not)\b|아직|아니|잠깐|보류|말고|하지\s*마|안\s*돼|기다|멈춰|나중/i;
const APPROVE = /\b(?:go|ship|approved?|yes|yep|ok|okay|lgtm|proceed)\b|좋아|ㄱㄱ|고고|승인|진행|ㅇㅋ|오케이|ㅇㅇ/i;
/**
 * Whether an owner's answer is a go: it says go, ship, approve, yes, 좋아 or ㄱㄱ, and nothing that holds it back (not yet, wait, no, 아직).
 * A tapped choice is judged by its lead, up to the first comma or dash: the chat writes choices like "Go, 5.5 high with no fallback", whose
 * "no" is part of what is approved (10-09, t29 on p234 read as no go).
 */
export const approves = (reply: string, choices: readonly string[] = []): boolean => {
  const text = choiceLead(reply, choices);
  return !HOLD.test(text) && APPROVE.test(text);
};
/** A tapped choice's lead, up to the first comma or dash; a typed answer whole. */
const choiceLead = (reply: string, choices: readonly string[]): string =>
  choices.includes(reply.trim()) ? reply.trim().split(/[,;:.\u2013\u2014]|\s-\s/)[0]! : reply;
/** Whether the owner tapped the first choice, the agent's recommendation ("Send it"), and its lead holds nothing back. */
export const tapsFirstChoice = (reply: string, choices: readonly string[] = []): boolean =>
  choices.length > 0 && reply.trim() === choices[0]!.trim() && !HOLD.test(choiceLead(reply, choices));
/** Whether a todo asks about a plan step: its `step` field, or the step id as a whole word in its text. */
export const linksStep = (todo: Pick<OwnerTodo, "text" | "step">, stepId: string): boolean =>
  todo.step === stepId || new RegExp(`(?<![\\w-])${stepId}(?![\\w-])`).test(todo.text);
/** A plan step as the go checks read it: its id, text, note and waitFor. */
type GoStep = Pick<PlanItem, "id" | "text"> & Partial<Pick<PlanItem, "note" | "waitFor">>;
/** The PR numbers a step names in its text, note or waitFor (p57 "merge validated onboarding replay", waitFor "a green re-run of #218"). */
export const stepPrs = (step: Omit<GoStep, "id">): string[] => prNumbers(`${step.text}\n${step.note ?? ""}\n${step.waitFor ?? ""}`);
/**
 * Whether a todo is about a plan step: it links the step (`linksStep`), the step's text, note or waitFor names the todo's id ("after the owner's
 * go on t20"), or the todo's text or the owner's answer names a PR the step names (`stepPrs`). slack green guy 10-13: t18 asked fifteen PRs by
 * number but could link only p109, so the check-in read eleven merge steps as having no question in For you. 10-14: t16 named #247 but linked
 * p71, so p94, which waits for #247, read as at work without the owner's go, and p133 waits for "the owner's go on t20" while t20 links p132.
 */
export const coversStep = (todo: Pick<OwnerTodo, "text" | "step" | "reply"> & Partial<Pick<OwnerTodo, "id">>, step: GoStep): boolean =>
  linksStep(todo, step.id) ||
  (todo.id !== undefined && new RegExp(`(?<![\\w-])${todo.id}(?![\\w-])`).test(`${step.text}\n${step.note ?? ""}\n${step.waitFor ?? ""}`)) ||
  stepPrs(step).some(pr => namesPr(`${todo.text}\n${todo.reply ?? ""}`, pr));
/** Whether an answer is a go or a hold; a reply to a side question on the step ("Leave it in the old history") is neither. */
const goOrHold = (reply: string, choices: readonly string[]): boolean => {
  const text = choiceLead(reply, choices);
  return HOLD.test(text) || APPROVE.test(text);
};
/*
 * Merges (owner 10-12, c49): "never auto merge anything without my approval". A step whose text merges a PR or a branch, turns on auto-merge or
 * lands code needs the owner's go even when the chat did not mark it, and a go on it counts only when the approving todo names the PR the step
 * names. A merge word about something else (a merge conflict, merge-ready, a merge train, merged versions) is no merge step.
 */
const MERGE = new RegExp([
  String.raw`\bauto-?merg`,
  String.raw`\bgh\s+pr\s+merge\b`,
  String.raw`^\s*(?:[\w ]{1,20}:\s*)?merge\b(?![-\s]?(?:conflicts?|ready|train|queue)\b)`,
  String.raw`\bmerg(?:e|es|ed|ing)\s+(?:(?:the|this|that|its?|my|our|both|all|open|green)\s+)?(?:[\w-]+\s+)?(?:prs?\b|pull\s+requests?\b|branch(?:es)?\b|#\d+|\S*\/pulls?\/\d+)`,
  String.raw`\bmerg(?:e|es|ed|ing)\s+(?:(?:it|them|this|that)\s+)?(?:in)?to\s+(?:main|master|staging|dev|prod|production|origin|the\s+[\w-]+\s+branch)\b`,
  String.raw`\b(?:prs?|pull\s+requests?)\s*#?\d+\s+(?:is\s+|was\s+|gets\s+)?merged?(?![-\w])`,
  String.raw`\bland(?:s|ed|ing)?\s+(?!pages?\b)(?:(?:the|this|that|its?|my|our|both|all)\s+)?(?:[\w-]+\s+)?(?:prs?\b|pull\s+requests?\b|branch(?:es)?\b|code\b|changes?\b|commits?\b|patch(?:es)?\b|fix(?:es)?\b|#\d+)`,
].join("|"), "i");
/**
 * A push that moves main or master: "push the fix to main", "git push origin
 * HEAD:main", "land it on master". A push to staging or a dev branch such as sieun/dev is none: staging needs no go.
 */
const PUSH = new RegExp([
  String.raw`\bpush(?:es|ed|ing)?\s+(?:[\w.'#/-]+\s+){0,4}?(?:to|into|onto)\s+(?:origin\s+|upstream\s+)?(?:main|master)\b`,
  String.raw`\bgit\s+push\s+(?:-\S+\s+)*[\w.:/@-]+\s+(?:\+?[\w./-]+:)?(?:refs\/heads\/)?(?:main|master)\b`,
  String.raw`\bland(?:s|ed|ing)?\s+(?:[\w.'#/-]+\s+){0,3}?(?:on|to|into)\s+(?:main|master)\b`,
].join("|"), "i");
/**
 * The merge rule as every brief says it: the chat brief, the job reply guideline and the duty job brief. While the owner's standing go is on
 * (`releaseGo`, c74), merges, pushes to main and promotes go ahead with no todo; without it, each needs his go on a For you todo (c49).
 */
export const MERGE_RULE = releaseGo.preapproval
  ? "Never ask the owner to confirm a staging land, merge or deploy: do it on your own (owner 10-12). " + preApprovalText(releaseGo.preapproval) +
    " An outside send (an email, a ticket or support reply, a customer message, a post) still needs the owner's ok on a For you todo first (c37)."
  : "Never ask the owner to confirm a staging land, merge or deploy: do it on your own (owner 10-12). Production needs his " +
    "explicit approval of that specific PR or push in For you (c49): never merge a PR into the production branch, turn on auto-merge for one, push to " +
    "main or master, or promote to production before a todo linked to the step, whose text names the PR (for a push, the repo and the branch or the " +
    "word push), is answered by him with a go and checked off. There is no standing \"merge once checks pass\" approval, and a go on another step, PR " +
    "or push does not carry over.";
/** A step that states the merge rule itself ("Nothing merges without your go", "the guard refuses gh pr merge") merges nothing. */
const RULE_TEXT = /\bwithout\s+(?:the\s+owner['\u2019]?s|your|his|an?)\s+(?:explicit\s+)?(?:go|approval|ok)\b|\b(?:refuses?|blocks?)\s+(?:gh\s+pr\s+merge|auto-?merges?|merges?|pushes)\b/i;
/** MERGE_RULE in one sentence, for the short job reply guideline. */
export const MERGE_RULE_SHORT = releaseGo.preapproval
  ? "Never ask the owner to confirm a staging land, a deploy, a merge, a push to main or master or a prod promote. " + preApprovalText(releaseGo.preapproval)
  : "Never ask the owner to confirm a staging land or deploy; never merge a PR into production, push to main or master, or " +
    "promote to production without his go on a For you todo that names that PR or push (c49).";
/** Whether a step's text says it merges a PR or a branch, turns on auto-merge, lands code or pushes to main or master. */
export const mergeStep = (text: string): boolean => (MERGE.test(text) || PUSH.test(text)) && !RULE_TEXT.test(text);
/** The default branch a push step moves, or null when the step pushes nothing to main or master. */
export const pushBranch = (text: string): string | null => PUSH.exec(text)?.[0].match(/\b(main|master)\b(?![\s\S]*\b(?:main|master)\b)/i)?.[1]!.toLowerCase() ?? null;
/** The PR numbers a text names: "#123", "PR 123", "pull request 123", "gh pr merge 123" or a ".../pull/123" URL. */
export const prNumbers = (text: string): string[] =>
  [...new Set([...text.matchAll(/(?:#|\bprs?\s*#?\s*|\bpr\s+merge\s+|\bpull(?:\s+requests?)?\s*#?\s*|\/pulls?\/)(\d+)(?!\d)/gi)].map(match => match[1]!))];
/** Whether a todo's text names the PR: `#123`, `PR 123`, `pull request 123` or a `/pull/123` link. */
export const namesPr = (text: string, pr: string): boolean => new RegExp(String.raw`(?:#|\bPRs?\s*#?\s*|\bpull(?:\s+request)?\s*#?\s*|/pulls?/)${pr}(?!\d)`, "i").test(text);
/**
 * Whether an owner's answer approves an action the way owner-ok.ts and the global-rules guards read it: the todo is checked off, and the owner
 * tapped its first choice or answered with another go.
 */
export const approvedTodo = (todo: Pick<OwnerTodo, "answeredBy" | "reply" | "done" | "choices">): boolean =>
  todo.answeredBy === "owner" && !!todo.reply?.trim() && todo.done && (tapsFirstChoice(todo.reply, todo.choices ?? []) || approves(todo.reply, todo.choices ?? []));
/*
 * Staging needs no go (owner 10-12, after a chat asked to land 32b to staging: "bro never fucking ask me for any confirmation to deploy to staging
 * ever again"). A step whose target is staging only, by its text, is exempt even when the chat marked it: it names staging, sieun/dev or a dev
 * branch, or it lands with no PR number, and it names no production target (prod, production, promote, main, master, a real app, a live site
 * or app, public).
 */
const PRODUCTION = /\bprod(?:uction)?\b|\bpromot(?:e|es|ed|ing|ion)\b|\bmain\b|\bmaster\b|\breal\s+(?:[\w-]+\s+){0,2}app\b|\blive\s+(?:site|app)\b|\bpublic\b/i;
const STAGING = /\bstaging\b|\bsieun\/dev\b|\bdev\s+branch\b/i;
const LAND = /\bland(?:s|ed)?\b/i;
/** Whether a step's only target is staging, so it never needs the owner's go. */
export const stagingOnly = (text: string): boolean => !PRODUCTION.test(text) && (STAGING.test(text) || (LAND.test(text) && !prNumbers(text).length));
/*
 * Waiting for leave (c47, repeated by the owner 10-12: "NEVER wait for something, or ask for my permission to push to Github etc.", then
 * "especially staging"). That day VP of CI held built ci/ pushes for Fable's "ON STAGING" word, and steps across 8 boards waited for "Fable's go
 * for our slot", "Crawler VP's GO line" or "push fifth in line". A step or brief whose next action waits on another thread's go, word or slot,
 * or on the owner's ok for a push, a staging land or a ci/ push, is a wait nobody needs. Production (prod, promote, main, master, a PR merge)
 * keeps the owner's go (c49) and is left out, and so is a sentence that states the rule ("never ask", "without waiting").
 */
export type GoWait = { kind: "thread" | "owner"; phrase: string };
const RULE_SENTENCE = /\b(?:never|nothing|without|don['\u2019]?t|do\s+not|does\s+not|no\s+need|needs?\s+no|stop\s+waiting|instead\s+of\s+waiting|flags?|refuses?)\b/i;
const WAIT_CUE = /\b(?:wait(?:s|ed|ing)?|until|till|after|once|hold(?:s|ing)?|held|pending|blocked\s+on|at|asks?|asking|confirm)\b/i;
const OWNER_GO = new RegExp([
  String.raw`(?<!(?:release|thread|code|repo)\s)\b(?:the\s+owner|owner|sieun|your|his)(?:['\u2019]s)?\s+(?:explicit\s+|final\s+)?(?:go(?![-\w])|ok(?:ay)?\b|approval|confirmation|sign-?off|green\s+light|permission|say-?so)`,
  String.raw`(?<!(?:release|thread|code|repo)\s)\b(?:owner|sieun)\s+(?:approves|oks|okays|confirms|says\s+go)\b`,
  String.raw`\bask(?:s|ing)?\s+(?:the\s+owner|sieun|him)\s+(?:for|to|before|whether|if)\b`,
].join("|"), "i");
const THREAD_GO = new RegExp([
  String.raw`\b(?!(?:owner|sieun|today|tomorrow|tonight|it|that|there|here|what|who|he|she|let)['\u2019]s)[\w-]+['\u2019]s\s+(?:[^\s.;,()]+\s+){0,5}?(?:go(?![-\w])|go\s+line|word\b|ok(?:ay)?\b|ack\b|nod\b|green\s+light|say-?so\b|sign-?off\b|approval\b|slots?\b)`,
  String.raw`\bin\s+[\w-]+['\u2019]s\s+order\b|\b(?:our|its|their|the\s+next)\s+slot\b|\bslot\s+\d+\b`,
  String.raw`\b(?:next|first|second|third|fourth|fifth|sixth|\d+(?:st|nd|rd|th))\s+in\s+line\b`,
  String.raw`\bon\s+staging['"\u2019]?\s+(?:word|call|signal|line)\b`,
].join("|"), "i");
/** "metal GO about 14:00Z", "g-jev2 OKs": capitals only, so the verb "go" and a plain "ok" stay out, and so does an "OK," that opens a sentence or follows a colon as a reply. */
const CAPS_GO = /\bGO\b|(?<!(?:^|:)\s*)\bOKs?\b(?!['\u2019]d)/;
const GIT_MOVE = /\bpush|\bland(?:s|ed|ing)?\b|\bmerg|\bstaging\b|\bci\/|\bgithub\b|\bsieun\/dev\b|\bdeploy/i;
/** A step whose own action is a push, land, merge or deploy, so an owner's go in its waitFor is a go on that move. */
const GIT_STEP = /\b(?:push|land|merg|deploy)\w*\b/i;
/**
 * A PR merge ("merge #233", "the PR is merged", a merge that names no staging branch), a public release (a web store, publish) or an outside
 * send (an email, c37).
 */
const KEEPS_OWNER_OK = /\b(?:e-?mails?|web\s+store|publish(?:es|ed|ing)?)\b/i;
const PR_MERGE = (text: string): boolean => /\bmerg/i.test(text) && (/\b(?:PRs?|pull\s+requests?)\b/i.test(text) || prNumbers(text).length > 0 || !STAGING.test(text));
/** Whether a text names production, a PR merge, a public release or an outside send: what keeps the owner's go (c49, c37). */
export const namesProduction = (text: string): boolean =>
  PRODUCTION.test(text) || (mergeStep(text) && !stagingOnly(text)) || PR_MERGE(text) || KEEPS_OWNER_OK.test(text);
/**
 * The first wait for leave in a text, sentence by sentence. `cued`: the text is a wait already (a step's waitFor), so no wait word is needed.
 * `scope`: the step the wait holds (its text and waitFor). An owner's ok counts when its sentence names a push, land, merge, staging or
 * deploy, or the step's own text does.
 */
export function goWait(text: string, { cued = false, scope }: { cued?: boolean; scope?: string } = {}): GoWait | null {
  for (const sentence of text.split(/(?<=[.!?;])\s+|\n+/)) {
    if (RULE_SENTENCE.test(sentence) || namesProduction(scope ?? sentence) || (!cued && !WAIT_CUE.test(sentence))) continue;
    const owner = OWNER_GO.exec(sentence);
    if (owner && (GIT_MOVE.test(sentence) || (scope !== undefined && GIT_STEP.test(scope)))) return { kind: "owner", phrase: owner[0] };
    const thread = THREAD_GO.exec(sentence) ?? CAPS_GO.exec(sentence);
    if (thread) return { kind: "thread", phrase: thread[0] };
  }
  return null;
}
/** A plan step's wait for leave: in its waitFor, or in its text with a wait word. A production step is left out. */
export function stepGoWait(item: Pick<PlanItem, "text" | "waitFor">): GoWait | null {
  const scope = `${item.text}\n${item.waitFor ?? ""}`;
  if (namesProduction(scope)) return null;
  return (item.waitFor ? goWait(item.waitFor, { cued: true, scope }) : null) ?? goWait(item.text, { scope });
}
/** The fix for a wait for leave, said the same way by the board flag, the check-in and the brief check. */
export const GO_WAIT_FIX = "Staging, sieun/dev, ci/ and other GitHub pushes and staging lands need nobody's go or word (c47, c50; the owner 10-12: " +
  "\"NEVER wait for something, or ask for my permission to push to Github etc.\"). Do the next action now: push or land it yourself, and if a land " +
  "is busy, push to a ci/ ref and go on. " + (releaseGo.preapproval
    ? `Production merges, pushes to main and promotes need no go either: ${preApprovalText(releaseGo.preapproval)}`
    : "Only production (prod, promote, main, master, a PR merge) keeps the owner's go (c49).");
export const goWaitText = (wait: GoWait): string =>
  `waits for ${wait.kind === "owner" ? "the owner's ok on a push or a staging land" : "another thread's go, word or slot"} (${quote(wait.phrase)})`;
/** A todo sentence that asks for leave: "Go on staging ...?", "Approve the next staging release?", "Can we push ...?". */
const LEAVE_ASK = /^\s*(?:go(?:\s+ahead)?|approve|ship|push|land|deploy|merge|promote|ok(?:ay)?|(?:can|may|should)\s+(?:i|we))\b/i;
const LEAVE_MOVE = /\bpush(?:es|ed|ing)?\b|\bci\/|\bstaging\b|\bsieun\/dev\b|\bland\s+(?:\d+\w*|it|them|this|that)\b/i;
/**
 * Whether an agent's todo asks the owner for leave he never needs to give (c47, c50): it offers a go choice, and a question that asks for a go
 * names a push, a staging land, a ci/ push or another thread's go or slot and no production target. A todo about a PR merge, a public release
 * or an outside send keeps its ask (c49, c37).
 */
export const leaveAsk = (todo: Pick<OwnerTodo, "text" | "choices">): boolean =>
  !!todo.choices?.some(choice => APPROVE.test(choice)) && !PR_MERGE(todo.text) && !KEEPS_OWNER_OK.test(todo.text) &&
  todo.text.split(/(?<=[.!?;])\s+|\n+/).some(sentence => sentence.trim().endsWith("?") && LEAVE_ASK.test(sentence) && !namesProduction(sentence) &&
    (LEAVE_MOVE.test(sentence) || THREAD_GO.test(sentence)));
export const LEAVE_ASK_FLAG = `This todo asks the owner for leave on a non-production move. ${GO_WAIT_FIX} Do it, remove the todo with todo_remove, and tell the owner what shipped in a chat message.`;
/**
 * Whether the owner's standing go (`releaseGo`, c74) covers a text: it merges, pushes to main or master, promotes or names another production
 * target, and it names no outside send or public release (c37), which keep their todo.
 */
export const preApproved = (text: string, preapproval: PreApproval | null = releaseGo.preapproval): boolean =>
  !!preapproval && !KEEPS_OWNER_OK.test(text) && (mergeStep(text) || PRODUCTION.test(text) || PR_MERGE(text));
/**
 * Whether a step needs the owner's go: the chat marked it, or it is a merge step, its target is not staging only, and the owner's standing go
 * (`preApproved`, c74) does not cover it.
 */
export const needsGo = (item: Pick<PlanItem, "go" | "text">, preapproval: PreApproval | null = releaseGo.preapproval): boolean =>
  (item.go === "needed" || mergeStep(item.text)) && !stagingOnly(item.text) && !preApproved(item.text, preapproval);
/** The PRs a merge step merges: the ones its text names, less one it names as replaced ("#236, replaces #207"). */
export const mergedPrs = (text: string): string[] =>
  prNumbers(text).filter(pr => !new RegExp(String.raw`\b(?:replac|supersed)\w*\s+(?:PR\s*)?#?${pr}(?!\d)|\binstead\s+of\s+(?:PR\s*)?#?${pr}(?!\d)`, "i").test(text));
/**
 * The owner's go that counts for this step: of the owner's go-or-hold answers on todos about the step, the last one approves, so a later "not
 * yet" takes a go back. On most steps a todo is about the step when it covers it (`coversStep`: its step field, the step id in its text, or a PR
 * the step's text, note or waitFor names in the todo's text or answer, or the todo's id the step names), so t16, which names #247 and links p71, is the go of p94, which waits
 * for #247. A merge step needs that go for each PR it merges (`mergedPrs`): the last answer on a todo that links the step or names the PR in its
 * text, approved (`approvedTodo`), naming the PR, and on a push to main, master or staging saying push or naming the branch. A go on a PR the step
 * only waits for is that PR's merge, not this one: t18 names #234, which p82 waits for, and t17 stays p82's go on #229. A merge step that names
 * no PR takes the last answer on a todo that covers it.
 */
export function stepGo(board: Pick<ChatBoard, "todos">, item: GoStep): OwnerTodo | null {
  const answered = board.todos.filter(todo => todo.answeredBy === "owner");
  if (!mergeStep(item.text)) {
    const last = answered.filter(todo => coversStep(todo, item) && goOrHold(todo.reply ?? "", todo.choices ?? [])).at(-1);
    return last && approves(last.reply!, last.choices ?? []) ? last : null;
  }
  const decides = (todo: OwnerTodo): boolean => goOrHold(todo.reply ?? "", todo.choices ?? []) || tapsFirstChoice(todo.reply ?? "", todo.choices ?? []);
  const branch = pushBranch(item.text);
  const counts = (todo: OwnerTodo | undefined, pr?: string): todo is OwnerTodo => !!todo && approvedTodo(todo) && (pr === undefined || namesPr(todo.text, pr)) &&
    (branch === null || new RegExp(String.raw`\bpush|(?<![\w/-])${branch}(?![\w-])`, "i").test(todo.text));
  const prs = mergedPrs(item.text);
  if (!prs.length) {
    const last = answered.filter(todo => coversStep(todo, item) && decides(todo)).at(-1);
    return counts(last) ? last : null;
  }
  const gos = prs.map(pr => answered.filter(todo => (linksStep(todo, item.id) || namesPr(todo.text, pr)) && decides(todo)).at(-1));
  if (!gos.every((go, index) => counts(go, prs[index]))) return null;
  return answered.findLast(todo => gos.includes(todo)) ?? null;
}
/** The plan with every merge step marked `go: "needed"`, so renaming it later does not drop its gate. */
const markMerges = (plan: readonly PlanItem[]): PlanItem[] => plan.map(item => {
  const children = markMerges(item.children);
  return !item.go && mergeStep(item.text) && !stagingOnly(item.text) ? { ...item, go: "needed", children } : { ...item, children };
});
/** A Build step: its text starts with "Build", or it carries `kind: build`. */
export const isBuildStep = (item: Pick<PlanItem, "text" | "kind">): boolean => item.kind === "build" || /^build\b/i.test(item.text.trim());
/** The goal a Build step answers to (`above` is the chain over it, outermost first): the nearest item above with requirements, else its parent, else itself. */
export const buildGoal = (item: PlanItem, above: readonly PlanItem[]): PlanItem => [...above].reverse().find(goal => goal.requirements) ?? above.at(-1) ?? item;
/**
 * Why a goal's requirements check fails, as words that follow the goal ("p1 has no requirements list"), or null when it passes: no list, a met
 * line with no evidence, an unmet or open line with no note.
 */
export function requirementGaps(goal: Pick<PlanItem, "requirements">): string | null {
  const lines = goal.requirements ?? [];
  if (!lines.length) return "has no requirements list";
  const gaps = lines.flatMap((line, index) => line.status === "met"
    ? line.evidence?.trim() ? [] : [`line ${index + 1} ${quote(line.text)} is met with no evidence`]
    : line.note?.trim() ? [] : [`line ${index + 1} ${quote(line.text)} is ${line.status} with no note`]);
  return gaps.length ? `fails its requirements check: ${gaps.join("; ")}` : null;
}

/**
 * c47 reopened 10-12 (owner: "stop making up these bullshit rules on waiting", then "NEVER wait for something"): a step's waitUntil moved later
 * is flagged. That day Crawler VP moved p42, p46 and p47 later 2 to 3 times with fresh waitFor words, and they sat through 12 to 17 check-ins.
 * An earlier time, a cleared wait and a first wait pass, and so does a step the owner holds on an open For you todo.
 */
function waitPushes(before: ChatBoard, plan: readonly PlanItem[]): string[] {
  const was = new Map<string, PlanItem>();
  walk(before.plan, item => was.set(item.id, item));
  const flags: string[] = [];
  walk(plan, item => {
    const prior = was.get(item.id);
    if (!prior?.waitUntil || !item.waitUntil || Date.parse(item.waitUntil) <= Date.parse(prior.waitUntil)) return;
    if (before.todos.some(todo => !todo.done && coversStep(todo, item))) return;
    flags.push(`${item.id} ${quote(item.text)} already waited until ${prior.waitUntil}` +
      `${prior.waitFor ? ` for ${quote(prior.waitFor)}` : ""}, and a later waitUntil is a new wait the owner did not ask for (c47). Act on the step in ` +
      "this run: check whether what it waits for already happened, do its next action yourself, or start a job that removes the blocker. If only the " +
      `owner can unblock it, add a For you todo with step "${item.id}". If nothing you can do moves it, clear waitUntil with null, mark it ` +
      "blocked and name the blocker in its note.");
  });
  return flags;
}
/** The agent's plan change against waits for leave (c47): an open step whose text or waitFor is new or changed and waits on someone's go (`stepGoWait`). */
function goWaits(before: ChatBoard, plan: readonly PlanItem[]): string[] {
  const was = new Map<string, PlanItem>();
  walk(before.plan, item => was.set(item.id, item));
  const flags: string[] = [];
  walk(plan, item => {
    const prior = was.get(item.id);
    if (!OPEN_STATUSES.has(item.status) || (prior && prior.text === item.text && prior.waitFor === item.waitFor)) return;
    const wait = stepGoWait(item);
    if (wait) flags.push(`${item.id} ${quote(item.text)} ${goWaitText(wait)}. ${GO_WAIT_FIX} Set the step to that action, and give it a waitFor ` +
      "only for a real event the action needs, like a run's result.");
  });
  return flags;
}
/** The agent's plan change against zombie plans (owner 10-19, src/shared/upkeep-title.ts): an open item whose new or changed title reads like upkeep. */
function upkeepTitles(before: ChatBoard, plan: readonly PlanItem[]): string[] {
  const was = new Map<string, string>();
  walk(before.plan, item => was.set(item.id, item.text));
  const flags: string[] = [];
  walk(plan, item => {
    const words = OPEN_STATUSES.has(item.status) && was.get(item.id) !== item.text ? upkeepWords(item.text) : null;
    if (words) flags.push(`${item.id} ${quote(item.text)} reads like upkeep (${quote(words)}), and a plan holds only tasks that finish. Make the keeping a ` +
      "duty metric and close this item, or retitle it as the one fix it is with a \"Done when\" note. A request with both parts gets one step for the fix " +
      "and one duty metric for the keeping (board skill, references/plan-and-duties.md).");
  });
  return flags;
}
/** The gate fields that are set, for a stored plan item. */
const gateFields = ({ go, kind, requirements: lines }: { [K in keyof Gates]?: Gates[K] | undefined }): Gates => ({ ...(go ? { go } : {}), ...(kind ? { kind } : {}), ...(lines?.length ? { requirements: lines } : {}) });
const gateText = (item: PlanItem): string => needsGo(item) ? ", which needs the owner's go" : "";
const dutyText = (item: PlanItem): string => item.duty ? `, fixing duty metric ${item.duty}` : "";
const requirementCount = (lines: readonly Requirement[]): string => `${lines.length} ${lines.length === 1 ? "line" : "lines"}, ${lines.filter(line => line.status === "met").length} met`;

function walkInputs(items: readonly PlanItemInput[], visit: (input: PlanItemInput) => void): void {
  for (const item of items) { visit(item); walkInputs(item.children ?? [], visit); }
}

/** Where the agent reads what the open checklist leaves out: the board Python skill. */
export const BOARD_PY_CALLS = "board.get(id), board.done(), board.todos(all=True)";
const MARKS: Record<PlanStatus, string> = { todo: "[ ]", doing: "[~]", done: "[x]", blocked: "[!]", dropped: "[-]" };

/**
 * The board as the agent reads it from chat_board: this chat's link target and check-in line, the goals and steps that are open or hold an open
 * step, one line each, then the open owner todos, then one line counting what it left out. Step notes, requirements, done items and answered
 * todos stay in the board file, read on demand through the board Python skill.
 */
export function renderOpenPlan(board: ChatBoard | null, sessionId?: string, checkIn?: string): string {
  const lines = [...(sessionId ? [`This chat: thread:${sessionId}`] : []), ...(checkIn ? [checkIn] : [])];
  if (!board) return [...lines, "The board is empty: no plan, no todos."].join("\n");
  lines.push(`Board rev ${board.rev}. Open plan (goals and steps not done):`);
  const hidden = { steps: 0, notes: 0 };
  const hasOpen = (item: PlanItem): boolean => OPEN_STATUSES.has(item.status) || item.children.some(hasOpen);
  const visit = (items: readonly PlanItem[], depth: number) => {
    for (const item of items) {
      if (!hasOpen(item)) { hidden.steps += count([item]); continue; }
      if (item.note || item.requirements?.length) hidden.notes++;
      const go = needsGo(item) ? stepGo(board, item) : null;
      const marks = [
        ...(item.job ? [`job ${item.job}${item.sessionId && item.sessionId !== item.job ? ` (thread:${item.sessionId})` : ""}`] : item.sessionId ? [`thread:${item.sessionId}`] : []),
        ...(item.waitUntil ? [`waits until ${item.waitUntil}`] : []),
        ...(item.waitFor ? [`waits for ${item.waitFor}`] : []),
        ...(isBuildStep(item) ? ["build"] : []),
        ...(needsGo(item) ? [go ? `owner's go on ${go.id}` : "needs owner's go"] : []),
        ...(item.target ? [targetText(item.target)] : []),
        ...(item.duty ? [`fixes ${item.duty}`] : []),
      ];
      lines.push(`${"  ".repeat(depth + 1)}${MARKS[item.status]} ${item.id} ${item.text}${marks.length ? ` (${marks.join(", ")})` : ""}`);
      visit(item.children, depth + 1);
    }
  };
  visit(board.plan, 0);
  if (lines.at(-1)?.endsWith("not done):")) lines.push("  (none)");
  const open = board.todos.filter(todo => !todo.done);
  lines.push(`Owner todos open: ${open.length ? "" : "none"}`.trimEnd());
  for (const todo of open) {
    const offered = todo.choices ? `, choices: ${todo.choices.map(choice => quote(choice)).join(" / ")}` : "";
    const linked = todo.links?.length ? `, links: ${todo.links.map(link => link.target).join(" ")}` : "";
    lines.push(`  [ ] ${todo.id} ${todo.text} (from ${todo.from}${todo.step ? `, for ${todo.step}` : ""})${offered}${linked}`);
  }
  const left = [`${hidden.steps} done or dropped steps`, `${board.todos.length - open.length} answered todos`,
    `${hidden.notes} step notes and requirements`];
  lines.push(`Not shown: ${left.join(", ")}. Read them with ${BOARD_PY_CALLS} in Python.`);
  return lines.join("\n");
}

/** The one line a chat_board call with ops returns after the op summaries. */
export function boardRevLine(board: ChatBoard): string {
  let steps = 0;
  walk(board.plan, item => { if (OPEN_STATUSES.has(item.status)) steps++; });
  return `Board rev ${board.rev}: ${steps} open steps, ${board.todos.filter(todo => !todo.done).length} open todos.`;
}

/** Plan steps of a chat for its sidebar line: every item that is not dropped, and how many are done (the board card counts the same way). */
export function planCounts(items: readonly PlanItem[]): { done: number; total: number } {
  const counts = { done: 0, total: 0 };
  const walk = (list: readonly PlanItem[]) => {
    for (const item of list) {
      if (item.status !== "dropped") { counts.total++; if (item.status === "done") counts.done++; }
      walk(item.children);
    }
  };
  walk(items);
  return counts;
}
