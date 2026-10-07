import { snapshotJsonFile, transactJsonFile, type JsonFile } from "./locked-json.ts";
import { planJob } from "./shared/chat-board.ts";
import { CHECK_IN_MAX_MINUTES, CHECK_IN_MIN_MINUTES, type ChatBoard, type CheckInPause, type ChildAgent, type PlanItem, type PlanStatus, type SessionRow } from "./shared/types.ts";

/**
 * The server's check-in for a chat: at its own interval (CHECK_IN_MS unless the owner set another, see CheckInSetting) it reads the chat's jobs (its subagents, and every thread an open plan step names as its
 * owner) and the board, compares them with what it saw last time, and steers the chat only with the changes that need the VP. No change, no
 * model call.
 */
export const CHECK_IN_MS = 5 * 60_000;
/** A job that runs with no activity for this long is reported once as stale, until its activity moves again. */
export const STALE_MS = 30 * 60_000;
/** An open step with no board change and no owner activity for this long is reported, once per stretch of this length. */
export const STEP_STALE_MS = 2 * 60 * 60_000;
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
  /** The plan item this owner works on, an open one when it has several. */
  item?: { id: string; text: string; status: PlanStatus };
}
export interface JobMemo { state: JobState; activityAt?: number; messages?: number; stale?: true }
/** One plan item as last seen: what it said, when that last changed, and when it was last reported as quiet. */
export interface StepMemo { sig: string; at: number; nudged?: number }
/**
 * What the last tick saw for one chat: each job, each plan item, the agent todos the owner had answered, the plan steps already reported as
 * ready.
 */
export interface CheckInMemory { at: number; jobs: Record<string, JobMemo>; steps: Record<string, StepMemo>; answered: string[]; ready: string[] }

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
 * names as its owner (`stepOwner`) that is not one of them. An owner that names nothing known is left out.
 */
export function jobFacts(children: readonly ChildAgent[], board: ChatBoard | null, rows: readonly SessionRow[]): JobFact[] {
  const ids = new Set(children.map(child => child.id));
  const facts = new Map<string, JobFact>();
  for (const child of children) {
    if (child.parentId !== undefined && ids.has(child.parentId)) continue;
    const state: JobState = childWorking(child) ? "working" : child.status === "error" || child.status === "cancelled" ? "failed" : "ended";
    facts.set(child.id, { key: child.id, name: childName(child), state, ...(child.lastActivityAt !== undefined ? { activityAt: child.lastActivityAt } : {}),
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
    if (!row) return;
    const at = Date.parse(row.lastActivityAt ?? "");
    facts.set("thread:" + row.id, { key: "thread:" + row.id, name: row.name, state: row.working ? "working" : row.failure ? "failed" : "ended",
      ...(Number.isFinite(at) ? { activityAt: at } : {}), ...(row.failure ? { error: row.failure } : {}), messages: row.messageCount, item: link });
  });
  return [...facts.values()];
}

/** The tick runs for a chat with a job at work or an open plan step (todo, doing, blocked); otherwise it is paused. */
export function checkInDue(facts: readonly JobFact[], board: ChatBoard | null): boolean {
  if (facts.some(fact => fact.state === "working")) return true;
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

/**
 * One tick: the memory to keep, the lines that need the VP, and every open plan item as a line (oldest change first) to list under them. With
 * no memory (the first tick) only conditions are reported (a stale job or step, a ready step); transitions need a before. A job counts as
 * finished when it was working last tick, or when it is new since then and its last activity came after it. A thread owner also counts when
 * it stayed idle but posted messages since the last tick. A plan item's last change is when its status, text, owner or note last differed
 * (the board's `updatedAt` for one never seen before); an open item with no open child that had no change, no change below it and no owner
 * activity for STEP_STALE_MS is reported, once per stretch of that length.
 */
export function checkInDigest(previous: CheckInMemory | undefined, facts: readonly JobFact[], board: ChatBoard | null, now: number):
  { memory: CheckInMemory; lines: string[]; open: string[] } {
  const lines: string[] = [];
  const jobs: Record<string, JobMemo> = {};
  for (const fact of facts) {
    const before = previous?.jobs[fact.key];
    const label = factLabel(fact);
    const thread = fact.key.startsWith("thread:");
    const stale = fact.item && !CLOSED.has(fact.item.status) && fact.item.status !== "blocked" ? `; the board still says ${fact.item.status}` : "";
    const wasWorking = before ? before.state === "working" : previous !== undefined && (fact.activityAt ?? 0) > previous.at;
    if (fact.state !== "working" && (wasWorking || (before !== undefined && before.state !== fact.state))) {
      if (fact.state === "failed") lines.push(`${label} failed${fact.error ? `: ${clip(fact.error, 120)}` : ""}${stale}`);
      else lines.push(`${label} ${thread ? "went idle" : "finished"}${fact.replied === false ? " with no report" : ""}${stale}`);
    } else if (fact.state !== "working" && before && before.messages !== undefined && fact.messages !== undefined && fact.messages > before.messages) {
      const added = fact.messages - before.messages;
      lines.push(`${label} has ${added} new ${added === 1 ? "message" : "messages"} and is ${STATE_WORD[fact.state]}${stale}`);
    }
    const memo: JobMemo = { state: fact.state, ...(fact.activityAt !== undefined ? { activityAt: fact.activityAt } : {}), ...(fact.messages !== undefined ? { messages: fact.messages } : {}) };
    if (fact.state === "working" && fact.activityAt !== undefined && now - fact.activityAt > STALE_MS) {
      memo.stale = true;
      if (!(before?.stale && before.activityAt === fact.activityAt)) lines.push(`${label}: no activity for ${Math.round((now - fact.activityAt) / 60_000)} min`);
    }
    jobs[fact.key] = memo;
  }

  const firstSeen = Math.min(now, Date.parse(board?.updatedAt ?? "") || now);
  const steps: Record<string, StepMemo> = {};
  const open: { at: number; line: string }[] = [];
  /** Visits an item after its children; returns when it or anything below it last moved (a board change or owner activity). */
  const visit = (item: PlanItem): { moved: number; open: boolean } => {
    let moved = 0, openBelow = false;
    for (const child of item.children) { const below = visit(child); moved = Math.max(moved, below.moved); openBelow ||= below.open; }
    const sig = JSON.stringify([item.status, item.text, planJob(item.job) ?? "", item.note ?? ""]);
    const before = previous?.steps[item.id];
    const memo: StepMemo = { sig, at: before ? before.sig === sig ? before.at : now : firstSeen, ...(before?.nudged !== undefined ? { nudged: before.nudged } : {}) };
    const owner = ownerOf(item, facts);
    moved = Math.max(moved, memo.at, owner?.activityAt ?? 0);
    const isOpen = OPEN.has(item.status);
    if (isOpen && !openBelow && now - Math.max(moved, memo.nudged ?? 0) >= STEP_STALE_MS) {
      lines.push(`${item.id} ${quote(item.text)} is ${item.status} with no board change and no owner activity for ${ago(now - moved)}`);
      memo.nudged = now;
    }
    if (isOpen) {
      const who = owner ? `owner ${ownerLabel(owner)} (${STATE_WORD[owner.state]})` : item.job ? `owner ${item.job} (not found)` : "no owner";
      open.push({ at: memo.at, line: `${item.id} ${quote(item.text)} ${item.status}, ${who}, last change ${ago(now - memo.at)} ago` });
    }
    steps[item.id] = memo;
    return { moved, open: isOpen || openBelow };
  };
  for (const item of board?.plan ?? []) visit(item);

  const answered = (board?.todos ?? []).filter(todo => todo.from === "agent" && todo.reply !== undefined);
  if (previous) for (const todo of answered) if (!previous.answered.includes(todo.id)) lines.push(`owner answered ${todo.id} ${quote(todo.text)}: ${clip(todo.reply!, 120)}`);
  const ready = readySteps(board);
  for (const step of ready) if (!previous?.ready.includes(step.id)) lines.push(`${step.id} ${quote(step.text)} can start: the steps before it are done and it has no job`);
  const shown = lines.length > MAX_LINES ? [...lines.slice(0, MAX_LINES - 1), `and ${lines.length - MAX_LINES + 1} more`] : lines;
  const sorted = open.sort((a, b) => a.at - b.at).map(entry => entry.line);
  const listed = sorted.length > MAX_OPEN ? [...sorted.slice(0, MAX_OPEN - 1), `and ${sorted.length - MAX_OPEN + 1} more`] : sorted;
  return { memory: { at: now, jobs, steps, answered: answered.map(todo => todo.id), ready: ready.map(step => step.id) }, lines: shown, open: listed };
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

/** A job that went quiet is told to the chat once per end: the same child at the same last activity is one end. */
export const noReportKey = (child: ChildAgent): string => `${child.id}@${child.lastActivityAt ?? ""}`;

/**
 * The notice for a job that went quiet without a report. A job that messaged the chat during the run that just ended asked something and
 * waits for an answer; it did not end silently. `messages` is the chat's transcript, `since` when the chat last saw the job start working.
 */
export function noReportNotice(name: string, messages: readonly { role: string; customType?: string; content?: unknown; timestamp?: number }[], since: number): string {
  const header = `[agent-message from child:${name}]`;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    if ((message.timestamp ?? 0) < since) break;
    if (message.role !== "custom" || message.customType !== "agent_message") continue;
    const text = typeof message.content === "string" ? message.content
      : Array.isArray(message.content) ? message.content.map(part => typeof part === "object" && part && "text" in part ? String((part as { text: unknown }).text) : "").join("") : "";
    if (!text.startsWith(header)) continue;
    const first = text.slice(header.length).split("\n").map(line => line.trim()).find(Boolean) ?? "";
    return `${name} is waiting for you (last message: "${first.length > 140 ? first.slice(0, 139) + "…" : first}")`;
  }
  return `${name} ended with no report`;
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

/** The owner's check-in choices for one chat: its interval, and a pause until a time or until the owner resumes it. */
export type CheckInPausedUntil = number | "forever";
export interface CheckInSetting { everyMs: number; pausedUntil?: CheckInPausedUntil }
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

const localTime = (at: number): string => {
  const date = new Date(at);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
};
/** The line the chat_board tool shows the chat about its own check-in. */
export function checkInLine(setting: CheckInSetting, now: number): string {
  const pause = activePause(setting, now);
  if (pause === "forever") return "Check-in: paused until the owner resumes it";
  if (pause !== null) return `Check-in: paused until ${localTime(pause)}`;
  return `Check-in: every ${setting.everyMs / 60_000} min`;
}

/** `<data dir>/check-in-settings.json`: `{ [chatId]: CheckInSetting }` through locked-json. Only the owner writes it, through the chat server. */
export interface CheckInSettings {
  all(): Promise<Record<string, CheckInSetting>>;
  get(id: string): Promise<CheckInSetting>;
  update(id: string, change: (setting: CheckInSetting) => CheckInSetting): Promise<CheckInSetting>;
}
function parseSetting(value: unknown): CheckInSetting | undefined {
  if (!isRecord(value) || !validCheckInEvery(value.everyMs)) return undefined;
  const until = value.pausedUntil;
  const pausedUntil = until === "forever" || (typeof until === "number" && Number.isFinite(until)) ? until : undefined;
  return { everyMs: value.everyMs, ...(pausedUntil !== undefined ? { pausedUntil } : {}) };
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
