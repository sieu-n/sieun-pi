import { snapshotJsonFile, transactJsonFile, type JsonFile } from "./locked-json.ts";
import type { ChatBoard, ChildAgent, PlanItem, PlanStatus, SessionRow } from "./shared/types.ts";

/**
 * The server's check-in for a chat: every CHECK_IN_MS it reads the chat's jobs (its subagents, and any thread a plan item links by name or id)
 * and the board, compares them with what it saw last time, and steers the chat only with the changes that need the VP. No change, no model call.
 */
export const CHECK_IN_MS = 10 * 60_000;
/** A job that runs with no activity for this long is reported once as stale, until its activity moves again. */
export const STALE_MS = 30 * 60_000;
const MAX_LINES = 6;

export type JobState = "working" | "ended" | "failed";
/** One job as the check-in sees it now. `key` is stable across ticks: the child id, or `thread:<sessionId>` for a linked thread. */
export interface JobFact {
  key: string; name: string; state: JobState; activityAt?: number; replied?: boolean; error?: string;
  /** The plan item that links this job, when one does. */
  item?: { id: string; text: string; status: PlanStatus };
}
export interface JobMemo { state: JobState; activityAt?: number; stale?: true }
/** What the last tick saw for one chat: each job, the agent todos the owner had answered, the plan steps already reported as ready. */
export interface CheckInMemory { at: number; jobs: Record<string, JobMemo>; answered: string[]; ready: string[] }

const OPEN: ReadonlySet<PlanStatus> = new Set(["todo", "doing", "blocked"]);
const CLOSED: ReadonlySet<PlanStatus> = new Set(["done", "dropped"]);

function walk(items: readonly PlanItem[], visit: (item: PlanItem, parent: PlanItem | null, siblings: readonly PlanItem[], index: number) => void, parent: PlanItem | null = null): void {
  items.forEach((item, index) => { visit(item, parent, items, index); walk(item.children, visit, item); });
}

const childWorking = (child: ChildAgent): boolean => child.status === "running" || child.status === "queued" || child.activity !== undefined;
export const childName = (child: ChildAgent): string => child.sessionName ?? child.label;

/**
 * The chat's jobs now: every subagent directly under it (one whose parent is not another listed subagent), plus every thread a plan item links
 * by session name or id that is not one of them. A plan item's `job` that names nothing known is left out.
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
    if (!item.job) return;
    const link = { id: item.id, text: item.text, status: item.status };
    const child = [...facts.values()].find(fact => fact.name === item.job || fact.key === item.job);
    if (child) { child.item ??= link; return; }
    const row = rows.find(candidate => candidate.id === item.job || candidate.name === item.job);
    if (!row || facts.has("thread:" + row.id)) return;
    const at = Date.parse(row.lastActivityAt ?? "");
    facts.set("thread:" + row.id, { key: "thread:" + row.id, name: item.job, state: row.working ? "working" : row.failure ? "failed" : "ended",
      ...(Number.isFinite(at) ? { activityAt: at } : {}), ...(row.failure ? { error: row.failure } : {}), item: link });
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

/**
 * One tick: the memory to keep and the lines that need the VP. With no memory (the first tick) only conditions are reported (a stale job, a
 * ready step); transitions need a before. A job counts as finished when it was working last tick, or when it is new since then and its last
 * activity came after it.
 */
export function checkInDigest(previous: CheckInMemory | undefined, facts: readonly JobFact[], board: ChatBoard | null, now: number): { memory: CheckInMemory; lines: string[] } {
  const lines: string[] = [];
  const jobs: Record<string, JobMemo> = {};
  for (const fact of facts) {
    const before = previous?.jobs[fact.key];
    const label = `job ${fact.name}${fact.item ? ` (${fact.item.id} ${quote(fact.item.text)})` : ""}`;
    const wasWorking = before ? before.state === "working" : previous !== undefined && (fact.activityAt ?? 0) > previous.at;
    if (fact.state !== "working" && wasWorking) {
      const stale = fact.item && !CLOSED.has(fact.item.status) && fact.item.status !== "blocked" ? `; the board still says ${fact.item.status}` : "";
      if (fact.state === "failed") lines.push(`${label} failed${fact.error ? `: ${clip(fact.error, 120)}` : ""}${stale}`);
      else lines.push(`${label} finished${fact.replied === false ? " with no report" : ""}${stale}`);
    }
    const memo: JobMemo = { state: fact.state, ...(fact.activityAt !== undefined ? { activityAt: fact.activityAt } : {}) };
    if (fact.state === "working" && fact.activityAt !== undefined && now - fact.activityAt > STALE_MS) {
      memo.stale = true;
      if (!(before?.stale && before.activityAt === fact.activityAt)) lines.push(`${label}: no activity for ${Math.round((now - fact.activityAt) / 60_000)} min`);
    }
    jobs[fact.key] = memo;
  }
  const answered = (board?.todos ?? []).filter(todo => todo.from === "agent" && todo.reply !== undefined);
  if (previous) for (const todo of answered) if (!previous.answered.includes(todo.id)) lines.push(`owner answered ${todo.id} ${quote(todo.text)}: ${clip(todo.reply!, 120)}`);
  const ready = readySteps(board);
  for (const step of ready) if (!previous?.ready.includes(step.id)) lines.push(`${step.id} ${quote(step.text)} can start: the steps before it are done and it has no job`);
  const shown = lines.length > MAX_LINES ? [...lines.slice(0, MAX_LINES - 1), `and ${lines.length - MAX_LINES + 1} more`] : lines;
  return { memory: { at: now, jobs, answered: answered.map(todo => todo.id), ready: ready.map(step => step.id) }, lines: shown };
}

/** The steer text for a tick's lines. */
export const checkInMessage = (prefix: string, lines: readonly string[]): string => `${prefix}What changed:\n${lines.map(line => `- ${line}`).join("\n")}`;

/**
 * Subagents that just ended a follow-up task (one sent after the first, so the status did not change) without messaging the chat. The daemon's
 * own notice (`rlm_child_terminal_notice`) covers a first task that ends with no reply, and a failure; this covers the rest. A child the daemon
 * cannot vouch for (`repliedSinceTask` unknown) is not reported.
 */
export function endedWithoutReport(before: readonly ChildAgent[], after: readonly ChildAgent[]): ChildAgent[] {
  const previous = new Map(before.map(child => [child.id, child]));
  return after.filter(child => {
    const was = previous.get(child.id);
    return was !== undefined && childWorking(was) && !childWorking(child) && was.status === child.status && child.repliedSinceTask === false;
  });
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
  return value as unknown as CheckInMemory;
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
