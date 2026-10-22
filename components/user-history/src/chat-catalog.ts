import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { performance as loopPerformance } from "node:perf_hooks";
import { basename, dirname, join } from "node:path";
import { DaemonClient, parseSkillBlock, type SessionSummary } from "prime-agent";
import type { ChatLabels } from "./chat-labels.ts";
import { keptChatAgents, stepSessions, withQueue, withRates, withWaits, type AgentRow, type SubagentSession } from "./chat-agents.ts";
import { type Cut, cutActivity, SessionCuts, type CutSource } from "./cut-end.ts";
import { planCounts } from "./shared/chat-board.ts";
import { unreadCount } from "./shared/chat-feed.ts";
import type { Chats } from "./chats.ts";
import type { ChatReadState } from "./chat-read-state.ts";
import type { ThreadOrigin, ThreadOrigins } from "./thread-origin.ts";
import type { Wake } from "./wakes.ts";
import { remotePath, type HostCatalogs } from "./host-catalogs.ts";
import { SessionPeer } from "./session-peer.ts";
import type { Host } from "./hosts.ts";
import type { ChatAgent, ChatBriefState, CheckInState, ChildAgent, QueuePlace, TokenRate, ChildPulse, ChildUsage, Pulse, SessionPulse, SessionRow, SessionsEvent, ThreadLabels, ThreadMessage, ThreadSchedule, Workspace } from "./shared/types.ts";

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

const FIRST_MESSAGE_SCAN_BYTES = 4 * 1024 * 1024;
/** cron_list fans out to every worker; roster activity must not repeat that work. */
const SCHEDULE_REFRESH_MS = 30_000;

function userText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.flatMap((part: unknown) => isRecord(part) && part.type === "text" && typeof part.text === "string" ? [part.text] : []).join("\n");
}

/** A session file's first user message as `scanFirst` reads it, from byte `from` on: the message, "" past FIRST_MESSAGE_SCAN_BYTES, or the byte
 * after the last whole line it read, where the next scan of the same file can start. */
type FirstScan = { first: string } | { first?: undefined; upTo: number };
const USER_MARK = Buffer.from('"user"');

function scanFirst(sessionFile: string, from: number): FirstScan | undefined {
  let fd: number;
  try { fd = openSync(sessionFile, "r"); } catch { return undefined; }
  try {
    const chunk = Buffer.alloc(64 * 1024);
    let carry = Buffer.alloc(0);
    // A file shorter than the byte the last read reached was rewritten (a repair), so it is read from its start again.
    let at = from <= fstatSync(fd).size ? from : 0;
    while (at - carry.length < FIRST_MESSAGE_SCAN_BYTES) {
      const read = readSync(fd, chunk, 0, chunk.length, at);
      if (read === 0) return { upTo: at - carry.length };
      at += read;
      const block = carry.length ? Buffer.concat([carry, chunk.subarray(0, read)]) : chunk.subarray(0, read);
      let start = 0;
      for (let newline = block.indexOf(0x0a); newline >= 0; start = newline + 1, newline = block.indexOf(0x0a, start)) {
        const line = block.subarray(start, newline);
        if (line.indexOf(USER_MARK) < 0) continue;
        try {
          const entry: unknown = JSON.parse(line.toString("utf8"));
          if (isRecord(entry) && entry.type === "message" && isRecord(entry.message) && entry.message.role === "user") return { first: userText(entry.message.content) };
        } catch { /* a line that is not JSON */ }
      }
      carry = Buffer.from(block.subarray(start));
    }
    return { first: "" };
  } finally { closeSync(fd); }
}

/**
 * The first user message stored in a session file. Undefined when the file is missing or has no user message yet; an empty string when none
 * appears in the first FIRST_MESSAGE_SCAN_BYTES.
 */
export function fileFirstMessage(sessionFile: string): string | undefined { return scanFirst(sessionFile, 0)?.first; }

function messageTitle(first: string): string {
  const skill = parseSkillBlock(first);
  const text = skill ? skill.userMessage ?? "" : /^\s*<(?:skill|system|instructions)(?:\s|>)/i.test(first) ? "" : first;
  return text.replace(/\s+/g, " ").trim().slice(0, 100);
}

/** What a session file's daemon row says about its writes: a new message or write changes it, so a read that found nothing waits for it to change. */
type FileRow = Pick<SessionSummary, "sessionFile"> & Partial<Pick<SessionSummary, "modified" | "messageCount" | "lastActivityAt">>;
const writeKey = (row: FileRow): string => `${row.modified ?? ""}|${row.messageCount ?? ""}|${row.lastActivityAt ?? ""}`;

/**
 * Session files that held no first user message when read, with the row's `writeKey` then and the byte the read reached, or null for one
 * scanned past FIRST_MESSAGE_SCAN_BYTES (it never gets one). Measured 10-13 on the live list: 498 of 1,372 rows, mostly subagent sessions,
 * were read again on every projection, about 560 MB and half of the service's main-thread time. Measured 10-18: a stat per such row on every
 * projection, and a failed open for each of the other box's rows with no local copy yet, still took 1.3 s of every 20 s of the service's main
 * thread, so a file is read again only once its row changes. A working session's row changes on every roster update, and until 10-19 each
 * change read its file from the start again (fileFirstMessage was 193 MB of the 3.4 GB a scratch serve allocated in 30 s), so a read goes on
 * from the byte the last one reached: a session file only grows at its end.
 */
const noFirst = new Map<string, { key: string; upTo: number } | null>();
function storedFirst(row: FileRow & { sessionFile: string }): string | undefined {
  const readAt = noFirst.get(row.sessionFile);
  if (readAt === null) return "";
  const key = writeKey(row);
  if (readAt?.key === key) return undefined;
  const scan = scanFirst(row.sessionFile, readAt?.upTo ?? 0);
  if (scan?.first) noFirst.delete(row.sessionFile);
  else noFirst.set(row.sessionFile, scan?.first === "" ? null : { key, upTo: scan && "upTo" in scan ? scan.upTo : 0 });
  return scan?.first;
}

/** Title text of each session file's first user message. A session file only grows at its end, so a found entry never changes. */
const fileTitles = new Map<string, string>();

/** The raw first user message of each session file, cut to 2000 characters, for derived display names. */
const fileFirsts = new Map<string, string>();
/** Session files with no task in the file or beside it, with the row's `writeKey` then: neither is read again until the row changes. */
const noTask = new Map<string, string>();
/**
 * The first task text of a session: a subagent's spawn prompt, else the stored first user message, else the daemon's `firstMessage`. Empty when
 * there is none yet. A subagent's prompt is read first: its file holds no user message, and on 10-18 scanning up to FIRST_MESSAGE_SCAN_BYTES of
 * each one for none took 40% of the first projection after a restart.
 */
export function firstTask(row: Pick<SessionSummary, "firstMessage"> & Partial<Pick<SessionSummary, "parentSessionId">> & FileRow): string {
  if (row.sessionFile) {
    const cached = fileFirsts.get(row.sessionFile);
    if (cached !== undefined) return cached;
    const key = writeKey(row);
    if (noTask.get(row.sessionFile) !== key) {
      const file = { ...row, sessionFile: row.sessionFile };
      const first = row.parentSessionId ? subagentPrompt(row.sessionFile) || storedFirst(file) : storedFirst(file) || subagentPrompt(row.sessionFile);
      if (first) { const cut = taskText(first).slice(0, 2000); fileFirsts.set(row.sessionFile, cut); noTask.delete(row.sessionFile); return cut; }
      noTask.set(row.sessionFile, key);
    }
  }
  return row.firstMessage === NO_MESSAGES ? "" : taskText(row.firstMessage ?? "");
}
/** The daemon's `firstMessage` for a session with no message yet: a placeholder, not a task. */
const NO_MESSAGES = "(no messages)";
/** A skill invocation stored expanded reads as what the person typed. */
const taskText = (first: string): string => first.trimStart().startsWith("<skill") ? parseSkillBlock(first)?.userMessage ?? "" : first;
/** A subagent's session file holds no user message: its task is the `prompt` of the rlm-subagent.json beside it. */
function subagentPrompt(sessionFile: string): string {
  try {
    const record: unknown = JSON.parse(readFileSync(join(dirname(sessionFile), "rlm-subagent.json"), "utf8"));
    return isRecord(record) && typeof record.prompt === "string" ? record.prompt : "";
  } catch { return ""; }
}

function storedTitle(row: FileRow): string | undefined {
  if (!row.sessionFile) return undefined;
  const cached = fileTitles.get(row.sessionFile);
  if (cached !== undefined) return cached;
  const first = storedFirst({ ...row, sessionFile: row.sessionFile });
  if (first === undefined) return undefined;
  const title = messageTitle(first);
  fileTitles.set(row.sessionFile, title);
  return title;
}

/**
 * A thread's title: the native session name, else the first user message stored in the session file, else the folder name. The daemon's
 * `firstMessage` is used only until the file has a user message: for a live thread it is the first user message still in memory, which after a
 * compaction or a resume is a later message, so a title built from it changes.
 */
export function sessionTitle(row: Pick<SessionSummary, "sessionName" | "firstMessage"> & FileRow & { cwd?: string }): string {
  const name = row.sessionName?.replace(/\s+/g, " ").trim();
  if (name) return name;
  const text = storedTitle(row) ?? messageTitle(row.firstMessage ?? "");
  return text || (row.cwd ? basename(row.cwd) : "") || "New chat";
}

/**
 * A row as the last projection built it, with what it was built from: the daemon's summary object (the copy keeps an unchanged row's object
 * across roster updates), the read marker, labels, schedule, subtree numbers, origin, box and the owner's archive. On 10-18 a scratch serve
 * on this box's 562 rows and the Mac's 3,123 spent 33.8 s of a 131 s profile in project(), most of it building the same 3,700 rows again for
 * each roster update that changed two of them.
 */
type KeptRow = { key: readonly unknown[]; row: SessionRow };
/** Whether a kept row's key holds the entries of `fixed` and then those of `below`. */
function sameKey(left: readonly unknown[], fixed: readonly unknown[], below: readonly unknown[]): boolean {
  if (left.length !== fixed.length + below.length) return false;
  for (let at = 0; at < fixed.length; at++) if (left[at] !== fixed[at]) return false;
  for (let at = 0; at < below.length; at++) if (left[fixed.length + at] !== below[at]) return false;
  return true;
}
/** The fixed part of the key `project` builds for each row before it knows whether the row is kept: one array, written over for each row. */
const scratchKey: unknown[] = Array.from({ length: 13 });
/**
 * How long a projection or a frame's fan-out holds the main thread before it lets the loop run (`setImmediate`). On a scratch serve on a copy of
 * the live data dir with its chats on 10-20, a projection's own code was a median 73 to 85 ms in one piece and the loop's longest delay a minute
 * was 280 to 510 ms at box load 50; live under load the same work waited behind about 3.7 runnable threads per core and stalled 4.4 to 12.9 s.
 */
export const PROJECTION_SLICE_MS = 10;
/** Rows the projection builds between two looks at the clock: about 2 ms of them on that serve. */
const BREATHE_ROWS = 256;
const NO_ROWS: readonly SessionSummary[] = [];

/** Equal to `depth` levels: the same value, or arrays and plain objects of the same size whose items are equal one level down. It allocates nothing. */
function sameValue(left: unknown, right: unknown, depth: number): boolean {
  if (left === right) return true;
  if (depth === 0 || typeof left !== "object" || typeof right !== "object" || left === null || right === null || Array.isArray(left) !== Array.isArray(right)) return false;
  if (Array.isArray(left)) {
    const other = right as unknown[];
    if (left.length !== other.length) return false;
    for (let at = 0; at < left.length; at++) if (!sameValue(left[at], other[at], depth - 1)) return false;
    return true;
  }
  const a = left as Record<string, unknown>, b = right as Record<string, unknown>;
  let fields = 0;
  for (const field in a) { fields++; if (!Object.hasOwn(b, field) || !sameValue(a[field], b[field], depth - 1)) return false; }
  for (const _field in b) if (--fields < 0) return false;
  return fields === 0;
}

/**
 * A chat row as the last projection gave it out when it came out the same, else the new row with each agent that came out the same as that
 * projection's object (and the same list when every agent did). A chat row is built again on each projection, and so is each of its agents:
 * on 10-20 a scratch serve on a copy of the live data dir with its chats grew its old space 1.0 to 1.3 GB between two major GCs, whose pauses
 * were 0.4 to 0.6 s, and each feed wrote every new agent and row to JSON again. A kept object is never changed: the next projection builds its own.
 */
function keptChat(before: SessionRow | undefined, row: SessionRow): SessionRow {
  if (!before) return row;
  const was = before.agents;
  if (row.agents && was) {
    // Agents mostly keep their places, so the one at the same place is tried first and the map is built only for one that moved.
    let previous: Map<string, ChatAgent> | undefined;
    const agents = row.agents.map((agent, at) => {
      const old = was[at]?.key === agent.key ? was[at] : (previous ??= new Map(was.map(entry => [entry.key, entry]))).get(agent.key);
      return old && sameValue(old, agent, 3) ? old : agent;
    });
    row.agents = agents.length === was.length && agents.every((agent, at) => agent === was[at]) ? was : agents;
  }
  return sameValue(before, row, 4) ? before : row;
}
/** A projected row's sort time, parsed once per row object: a kept row is the same object in each projection. */
const sortTimes = new WeakMap<SessionRow, number>();
function sortTime(row: SessionRow): number {
  let at = sortTimes.get(row);
  if (at === undefined) { at = Date.parse(row.lastActivityAt ?? row.created ?? ""); sortTimes.set(row, at); }
  return at;
}
/**
 * Whether this box's daemon row is listed, kept per row object: a roster update replaces only the rows it changed, and asking the disk for every
 * saved row's file on each projection was 3.3 of 54 ms of a projection's own code on a bench over a copy of the live rows on 10-19. A file gone
 * while its row is unchanged leaves the sidebar with the row's next change or the next full list.
 */
const listedRows = new WeakMap<SessionSummary, boolean>();
function listedHere(row: SessionSummary): boolean {
  let listed = listedRows.get(row);
  if (listed === undefined) { listed = isListed(row); listedRows.set(row, listed); }
  return listed;
}
/** Each projected row's entry for `chatAgents`, so a kept row keeps its entry and its first task is not looked up again. */
const agentRowOf = new WeakMap<SessionRow, AgentRow>();

export function isTopLevel(row: SessionSummary): boolean {
  return row.runtimeKind !== "subagent" && typeof row.rlmChildId !== "string" && !(typeof row.rlmDepth === "number" && row.rlmDepth > 0);
}

/** Empty unnamed drafts and saved rows whose file is gone (moved or deleted after the daemon scanned it) stay out of the sidebar. */
export function isListed(row: SessionSummary, fileExists: (path: string) => boolean = existsSync): boolean {
  if (row.activeSessionId !== undefined) return true;
  if (row.messageCount === 0 && !row.sessionName?.trim()) return false;
  return row.sessionFile !== undefined && fileExists(row.sessionFile);
}

/**
 * The status the terminal agents view shows: the daemon roster's `rosterStatus`, else the same formula the daemon uses
 * (`classifySessionRosterStatus`: not resident is inactive; `activity` "working" or `isSessionActive` is running; else idle).
 * This is the thread's own turn only; `isWorking` adds running subagents.
 */
export function nativeStatus(row: SessionSummary): "running" | "idle" | "inactive" {
  if (row.rosterStatus) return row.rosterStatus;
  if (row.activeSessionId === undefined) return "inactive";
  return row.activity === "working" || row.isSessionActive ? "running" : "idle";
}

/** Running subagent summaries by the session id of their parent. */
export function runningByParent(children: readonly SessionSummary[]): Map<string, SessionSummary[]> {
  const map = new Map<string, SessionSummary[]>();
  for (const row of children) {
    if (!row.parentSessionId || nativeStatus(row) !== "running") continue;
    const list = map.get(row.parentSessionId) ?? [];
    list.push(row);
    map.set(row.parentSessionId, list);
  }
  return map;
}

/** Latest activity of a session or of any running subagent below it. */
function latestActivity(row: SessionSummary, running: ReadonlyMap<string, SessionSummary[]>, seen = new Set<string>()): number {
  if (seen.has(row.sessionId)) return 0;
  seen.add(row.sessionId);
  const own = Date.parse(row.lastActivityAt ?? row.modified ?? "");
  return Math.max(Number.isFinite(own) ? own : 0, ...(running.get(row.sessionId) ?? []).map(child => latestActivity(child, running, seen)));
}

/** The running subagent rows below a session at any depth, the rows `sessionPulse` reads. */
function runningBelow(row: SessionSummary, running: ReadonlyMap<string, SessionSummary[]>): SessionSummary[] {
  const below: SessionSummary[] = [];
  const seen = new Set([row.sessionId]);
  const pending = [...(running.get(row.sessionId) ?? [])];
  for (let child = pending.pop(); child; child = pending.pop()) {
    if (seen.has(child.sessionId)) continue;
    seen.add(child.sessionId);
    below.push(child);
    pending.push(...(running.get(child.sessionId) ?? []));
  }
  return below;
}

function pulseOf(row: SessionSummary, running: ReadonlyMap<string, SessionSummary[]>): Pulse {
  const at = latestActivity(row, running);
  return {
    streaming: row.isStreaming, tools: row.isRunningTools === true, bash: row.isBashRunning === true, children: row.hasRunningRlmChildren === true,
    ...(at > 0 ? { activityAt: new Date(at).toISOString() } : {}), ...(row.summary?.trim() ? { summary: row.summary.trim().slice(0, 400) } : {}),
    ...(row.taskState !== undefined ? { summaryCurrent: true } : {}),
    ...(row.lastHeardFromAt ? { silentSince: row.lastHeardFromAt } : {}), ...(row.statusLabel === "failed" || row.workerState === "failed" ? { failed: true } : {}),
  };
}

/** Freshness of a running thread and its running direct subagents, from the summaries the roster push already refreshed. */
export function sessionPulse(row: SessionSummary, running: ReadonlyMap<string, SessionSummary[]>): SessionPulse {
  const subagents: ChildPulse[] = (running.get(row.sessionId) ?? []).flatMap(child => child.rlmChildId ? [{ ...pulseOf(child, running), rlmChildId: child.rlmChildId, sessionId: child.sessionId }] : []);
  return { ...pulseOf(row, running), subagents };
}

/**
 * The daemon writes "Model request failed: ..." with task state "error" when a session settles idle on an assistant error, judged at its present
 * message count; a later message replaces the state, so the pair means the last turn failed. The wire type predates the "error" state.
 */
export function settledOnFailure(row: SessionSummary): boolean {
  return (row.taskState as string | undefined) === "error" && Boolean(row.summary?.trim());
}

const daemonSaysFailed = (row: SessionSummary): boolean => row.statusLabel === "failed" || row.workerState === "failed" || settledOnFailure(row);

/**
 * The session files of children that are not running, for `SessionCuts`: the daemon's rows carry no stop reason, and a job that was archived and
 * aborted settles idle with no failure, so the panel read it as done (10-16 00:19:57Z). A new message changes the key.
 */
export const cutSources = (children: readonly SessionSummary[]): CutSource[] => children.flatMap(row => {
  let source = cutSourceOf.get(row);
  if (source === undefined) {
    source = row.sessionFile && nativeStatus(row) !== "running" ? { file: row.sessionFile, key: `${row.modified ?? ""}|${row.messageCount}` } : null;
    cutSourceOf.set(row, source);
  }
  return source ? [source] : [];
});
/** Each daemon row object's `cutSources` entry, built once per row object as `rosterReads` is. */
const cutSourceOf = new WeakMap<SessionSummary, CutSource | null>();

/** Subagent summaries by parent session id, one per session id (the resident copy wins over a saved one). */
export function childrenByParent(children: readonly SessionSummary[]): Map<string, SessionSummary[]> {
  const byId = new Map<string, SessionSummary>();
  for (const row of children) {
    const existing = byId.get(row.sessionId);
    if (!existing || (existing.activeSessionId === undefined && row.activeSessionId !== undefined)) byId.set(row.sessionId, row);
  }
  const map = new Map<string, SessionSummary[]>();
  for (const row of byId.values()) {
    if (!row.parentSessionId) continue;
    const list = map.get(row.parentSessionId) ?? [];
    list.push(row);
    map.set(row.parentSessionId, list);
  }
  return map;
}

export interface Subtree { cost?: number; running: number; total: number }

/** The subtree of each row object with no subagent, built once: most rows have none, and every projection asks for each. */
const leafSubtrees = new WeakMap<SessionSummary, Subtree>();
/**
 * The terminal agents view's numbers for a thread's subagent tree: `recursiveCost` (own cost plus every subagent below it, live or saved, as
 * `computeRecursiveRollups` adds it), `runningSubagentCount` (running subagents at any depth) and `total`, every subagent the daemon still lists
 * below it.
 */
export function subtreeOf(row: SessionSummary, children: ReadonlyMap<string, SessionSummary[]>): Subtree {
  let cost = row.usage && Number.isFinite(row.usage.cost) ? row.usage.cost : undefined;
  // Most of the 3,700 rows have no subagent, and the catalog asks for each of them on every projection.
  if (!children.has(row.sessionId)) {
    let leaf = leafSubtrees.get(row);
    if (!leaf) { leaf = { ...(cost !== undefined ? { cost } : {}), running: 0, total: 0 }; leafSubtrees.set(row, leaf); }
    return leaf;
  }
  let running = 0;
  let total = 0;
  const seen = new Set<string>([row.sessionId]);
  const pending = [...(children.get(row.sessionId) ?? [])];
  for (let child = pending.pop(); child; child = pending.pop()) {
    if (seen.has(child.sessionId)) continue;
    seen.add(child.sessionId);
    total++;
    if (child.usage && Number.isFinite(child.usage.cost)) cost = (cost ?? 0) + child.usage.cost;
    if (nativeStatus(child) === "running") running++;
    pending.push(...(children.get(child.sessionId) ?? []));
  }
  return { ...(cost !== undefined ? { cost } : {}), running, total };
}

export interface RowExtras { labels?: ThreadLabels; schedule?: ThreadSchedule; pulse?: SessionPulse; subtree?: Subtree; chat?: boolean; origin?: ThreadOrigin; agents?: ChatAgent[]; checkIn?: CheckInState; brief?: ChatBriefState }

/** Running subagents below a session at any depth, the count the sidebar shows under a thread ("2 subagents"). */
export const runningSubagents = (row: SessionSummary, subtree?: Subtree): number => Math.max(subtree?.running ?? 0, row.hasRunningRlmChildren === true ? 1 : 0);

/**
 * A chat's direct subagent sessions as `chatAgents` takes them: the daemon status, the failure (a cut end in `cuts` counts), the first task text
 * for a derived display name, and the running and listed subagents below each one, from `tree` (sessions by parent id).
 */
export function subagentSessions(children: readonly SessionSummary[], tree: ReadonlyMap<string, SessionSummary[]> = new Map(), cuts?: SessionCuts): SubagentSession[] {
  return children.map((row): SubagentSession => {
    const running = nativeStatus(row) === "running";
    const daemonFailed = daemonSaysFailed(row);
    const cut = running ? null : cuts?.of(row.sessionFile) ?? null;
    const failed = daemonFailed || cut !== null;
    // A provider error reads as its cause from the transcript (`turnErrorCause`): the daemon's summary ends 200 characters into the provider's
    // prose, before pi-pool's account and retry time.
    const activity = running ? row.statusLabel ?? row.summary?.trim().slice(0, 200) : cut?.error ? cutActivity(cut)
      : daemonFailed ? row.summary?.trim().slice(0, 200) : cut ? cutActivity(cut) : undefined;
    const at = row.lastActivityAt ?? row.modified;
    const name = row.sessionName?.replace(/\s+/g, " ").trim();
    const first = firstTask(row);
    const subtree = subtreeOf(row, tree);
    const subagents = runningSubagents(row, subtree);
    const total = Math.max(subtree.total, subagents);
    return { sessionId: row.sessionId, ...(row.rlmChildId ? { childId: row.rlmChildId } : {}), ...(name ? { name } : {}), ...(first ? { first } : {}), running, failed,
      ...(activity ? { activity } : {}), ...(at ? { lastActivityAt: at } : {}), ...(subagents ? { subagentsRunning: subagents } : {}), ...(total ? { subagentsTotal: total } : {}) };
  });
}

/**
 * Each chat's direct subagents as the hub's attach lists them (`projectChild`), from the daemon's own rows, so Chats knows them while no attach
 * succeeds: an RLM child id, its session name, running, failed (`error`, also for a cut end in `cuts`) or done, whether it replied since its task,
 * and its last activity.
 */
export function rosterChildren(children: readonly SessionSummary[], cuts?: SessionCuts): Map<string, ChildAgent[]> {
  const byChat = new Map<string, ChildAgent[]>();
  for (const [parent, rows] of childrenByParent(children)) {
    const listed = rows.flatMap((row): ChildAgent[] => {
      if (!row.rlmChildId) return [];
      let read = rosterReads.get(row);
      if (!read) { read = { running: nativeStatus(row) === "running", failed: daemonSaysFailed(row) }; rosterReads.set(row, read); }
      const found = read.running ? null : cuts?.of(row.sessionFile) ?? null;
      const cut = read.failed && !found?.error ? null : found;
      if (read.agent === undefined || read.cut !== cut) { read.cut = cut; read.agent = rosterAgent(row, row.rlmChildId, read.running, read.failed, cut); }
      return [read.agent];
    });
    if (listed.length) byChat.set(parent, listed);
  }
  return byChat;
}

/**
 * What `rosterChildren` read of each daemon row object, and the agent it built with the cut it had then. A roster update replaces only the rows
 * it changed, so an unchanged row is not read again: on 10-19 a scratch serve at the live rate (13.3 roster updates a second) built every
 * subagent's agent on each update, 6.9 s of its 68 s of main-thread time in 300 s. Callers must not change the agents.
 */
const rosterReads = new WeakMap<SessionSummary, { running: boolean; failed: boolean; cut?: Cut | null; agent?: ChildAgent }>();

function rosterAgent(row: SessionSummary, id: string, running: boolean, failed: boolean, cut: Cut | null): ChildAgent {
  const name = row.sessionName?.replace(/\s+/g, " ").trim();
  const status = running ? "running" : failed || cut ? "error" : "done";
  // The session file's change counts as activity: a job between turns still gets its workers' reports (`liveJobs`).
  const at = Math.max(...[row.lastActivityAt, row.modified].map(value => Date.parse(value ?? "")).filter(Number.isFinite));
  return { id, label: name || id, ...(name ? { sessionName: name } : {}), sessionId: row.sessionId, status, ...(cut ? { error: cutActivity(cut) } : {}),
    ...(row.repliedSinceTask === undefined ? {} : { repliedSinceTask: row.repliedSinceTask }), ...(Number.isFinite(at) ? { lastActivityAt: at } : {}) };
}

/**
 * The folder whose `sub-*` folders are a session's spawned subagents: a subagent's own folder beside its session file, a top-level session's
 * `session-artifacts/<id>`. Undefined without a session file.
 */
export function subagentFolder(row: Pick<SessionSummary, "sessionId" | "sessionFile" | "parentSessionId">): string | undefined {
  if (!row.sessionFile) return undefined;
  return row.parentSessionId ? dirname(row.sessionFile) : join(dirname(dirname(row.sessionFile)), "session-artifacts", row.sessionId);
}

/** How long a folder's spawned count is reused; the daemon tree covers subagents spawned since. */
export const SPAWNED_MS = 30_000;
async function countSpawned(folder: string): Promise<number> {
  const entries = await readdir(folder, { withFileTypes: true }).catch(() => []);
  const counts = await Promise.all(entries.filter(entry => entry.isDirectory() && entry.name.startsWith("sub-")).map(async entry => {
    const child = join(folder, entry.name);
    const inner = await readdir(child).catch(() => [] as string[]);
    return (inner.includes("rlm-subagent.json") ? 1 : 0) + await countSpawned(child);
  }));
  return counts.reduce((sum, count) => sum + count, 0);
}
/**
 * Every subagent ever spawned below a folder at any depth, finished and deleted ones included: each `sub-*` folder holding an rlm-subagent.json.
 * The daemon drops a subagent from its list once rlm.delete_subagent removes it, but its folder stays. A count is read again in the background
 * once it is SPAWNED_MS old, and `onChange` runs when a read changes it, so a projection never waits for the folders: on 10-18 a scratch serve
 * at the live rate awaited a count for each of about 1,000 agents on every projection, and the reads of the counts that had expired held it.
 */
export class SpawnedCounts {
  private readonly counts = new Map<string, { at: number; count: number }>();
  private readonly reading = new Set<string>();
  constructor(private readonly onChange: () => void) {}
  /** The last count of `folder`, 0 before its first read ends. */
  of(folder: string, now = Date.now()): number {
    const known = this.counts.get(folder);
    if ((!known || now - known.at >= SPAWNED_MS) && !this.reading.has(folder)) {
      this.reading.add(folder);
      void countSpawned(folder).then(count => {
        this.reading.delete(folder);
        this.counts.set(folder, { at: now, count });
        if (count !== (known?.count ?? 0)) this.onChange();
      });
    }
    return known?.count ?? 0;
  }
}

/** Working: the thread's own turn runs, or any subagent below it runs (`isSessionSummaryBusy` in the daemon counts both). */
export function isWorking(row: SessionSummary, subtree?: Subtree): boolean {
  if (row.activeSessionId === undefined) return false;
  return nativeStatus(row) === "running" || row.hasRunningRlmChildren === true || (subtree?.running ?? 0) > 0;
}

export function projectRow(row: SessionSummary, readMarker: number | undefined, baseline: number, extras: RowExtras = {}): SessionRow {
  const live = row.activeSessionId !== undefined;
  const lastActivity = Date.parse(row.lastActivityAt ?? row.modified ?? "");
  const finishedAt = Number.isFinite(lastActivity) ? lastActivity : 0;
  const status: SessionRow["status"] = !live ? "saved" : nativeStatus(row) === "running" ? "running" : "idle";
  const working = isWorking(row, extras.subtree);
  const subagentsRunning = runningSubagents(row, extras.subtree);
  const cost = extras.subtree ? extras.subtree.cost : row.usage && Number.isFinite(row.usage.cost) ? row.usage.cost : undefined;
  return {
    id: row.sessionId,
    name: sessionTitle(row),
    cwd: row.cwd,
    kind: live ? "live" : "saved",
    status,
    archived: row.lifecycle === "archived",
    ...(row.model ? { model: `${row.model.provider}/${row.model.id}` } : {}),
    ...(row.thinkingLevel ? { thinkingLevel: row.thinkingLevel } : {}),
    ...(row.created ? { created: row.created } : {}),
    ...(row.lastActivityAt ? { lastActivityAt: row.lastActivityAt } : row.modified ? { lastActivityAt: row.modified } : {}),
    messageCount: row.messageCount,
    working,
    subagentsRunning,
    unread: (extras.chat === true || !working) && row.messageCount > 0 && finishedAt > Math.max(baseline, readMarker ?? 0),
    ...(row.workerState ? { workerState: row.workerState } : {}),
    ...(row.statusLabel ? { statusLabel: row.statusLabel } : {}),
    ...(status !== "running" && settledOnFailure(row) ? { failure: row.summary!.trim().slice(0, 400) } : {}),
    tags: extras.labels?.tags ?? [],
    priority: extras.labels?.priority ?? 0,
    ...(cost !== undefined ? { cost } : {}),
    ...(working && extras.pulse ? { pulse: extras.pulse } : {}),
    ...(extras.schedule ? { schedule: extras.schedule } : {}),
    ...(extras.chat ? { chat: true, agents: extras.agents ?? [], ...(extras.checkIn ? { checkIn: extras.checkIn } : {}), ...(extras.brief ? { brief: extras.brief } : {}) } : {}),
    origin: extras.origin ?? "user",
  };
}

/** Active and paused scheduled jobs per session, from the daemon `cron_list` reply. One schedule per session: active before paused, then the next run. */
export function parseSchedules(value: unknown): Map<string, ThreadSchedule> {
  const byId = new Map<string, ThreadSchedule>();
  const jobs = isRecord(value) && Array.isArray(value.jobs) ? value.jobs : [];
  for (const job of jobs) {
    if (!isRecord(job) || typeof job.sessionId !== "string" || (job.status !== "active" && job.status !== "paused")) continue;
    const schedule: ThreadSchedule = {
      kind: job.source === "heartbeat" || job.source === "rlm_heartbeat" ? "heartbeat" : "cron",
      status: job.status,
      expression: isRecord(job.schedule) && typeof job.schedule.expression === "string" ? job.schedule.expression : "",
      ...(typeof job.label === "string" && job.label ? { label: job.label } : {}),
      ...(typeof job.nextRunAt === "string" ? { nextRunAt: job.nextRunAt } : {}),
    };
    const current = byId.get(job.sessionId);
    const earlier = (left: ThreadSchedule, right: ThreadSchedule) => (left.nextRunAt ?? "~").localeCompare(right.nextRunAt ?? "~") < 0;
    if (!current || (schedule.status === "active" && current.status === "paused") || (schedule.status === current.status && earlier(schedule, current))) byId.set(job.sessionId, schedule);
  }
  return byId;
}

export function parseSummaries(value: unknown): SessionSummary[] {
  if (!isRecord(value) || !Array.isArray(value.sessions)) throw new Error("Invalid daemon session catalog");
  return value.sessions.filter((row: unknown): row is SessionSummary => isRecord(row) && typeof row.sessionId === "string" && typeof row.cwd === "string");
}

/**
 * `unreadCount` kept per messages array and read marker. The hub replaces a chat's array on each new message, and on 10-18 counting every unread
 * chat's feed again on each projection took 10% of it.
 */
const unreadCounts = new WeakMap<readonly ThreadMessage[], { since: number; count: number }>();
function unreadOf(messages: readonly ThreadMessage[], since: number): number {
  const known = unreadCounts.get(messages);
  if (known?.since === since) return known.count;
  const count = unreadCount(messages, since);
  unreadCounts.set(messages, { since, count });
  return count;
}

/** How often the service logs its catalog projections' wall times (`projectionLine`). */
export const PROJECTION_LOG_MS = 60_000;
const rank = (sorted: readonly number[], share: number): number => sorted[Math.max(0, Math.ceil(share * sorted.length) - 1)]!;
/**
 * One service.log line on the projections of the last PROJECTION_LOG_MS: their count and median, 90th percentile and longest wall time, so
 * the live number reads from the log without a profiler, which owner rule c106 keeps off the live service; the median and 90th percentile of
 * the time their own code ran (`own`, the wall time without the awaits); and the share of the window the main thread was busy (`busy`, 0 to
 * 1). Wall time far above own time is a projection waiting behind other work. Null when none ran.
 */
export function projectionLine(ms: readonly number[], windowMs = PROJECTION_LOG_MS, busy?: number, own: readonly number[] = []): string | null {
  if (!ms.length) return null;
  const sorted = [...ms].sort((left, right) => left - right);
  const ran = [...own].sort((left, right) => left - right);
  const round = (value: number) => Math.round(value);
  return `catalog: ${sorted.length} projections in ${round(windowMs / 1000)} s, median ${round(rank(sorted, 0.5))} ms, p90 ${round(rank(sorted, 0.9))} ms, max ${round(sorted.at(-1)!)} ms`
    + (ran.length ? `, own code median ${round(rank(ran, 0.5))} ms, p90 ${round(rank(ran, 0.9))} ms` : "")
    + (busy === undefined ? "" : `, main thread ${round(busy * 100)}% busy`);
}

/** How often a working agent's output rate is read again and pushed with the rows; the usage feed's own cadence. */
export const RATES_MS = 2000;

/** How long a refresh waits for a session list: the SDK's default request deadline, which every list used before p349. */
const LIST_WAIT_MS = 30000;

/** The promise's result, or a rejection after `ms` for this caller only; the promise itself keeps running. */
function waitFor<T>(promise: Promise<T>, ms: number, box: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms waiting for the session list of ${box}; the list keeps running and the copy takes it when it answers.`)), ms); });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

export class Catalog {
  readonly client: DaemonClient;
  /** Output rates by session id, from LGTM once the backend wires it; the default answers with none. */
  ratesSource: (sessionIds: readonly string[]) => Promise<Record<string, TokenRate>> = async () => ({});
  /** The sessions the Mac-wide turn queue holds (`queueReader`), once the backend wires the pool; the default answers with none. It never rejects. */
  queueSource: () => Promise<ReadonlyMap<string, QueuePlace>> = async () => new Map();
  /** The board.wakes the service still owes (`pendingWakes`), for the wait each job row shows (`withWaits`). */
  wakesSource: (now: number) => Promise<readonly Wake[]> = async () => [];
  /** Stores a chat's step owners' session ids on its board (`stepSessions`), once the backend wires the board store; it never rejects. The default stores none. */
  linkSessions: (chatId: string, links: ReadonlyMap<string, { job: string; sessionId: string }>) => Promise<void> = async () => {};
  private rates: { key: string; at: number; value: Record<string, TokenRate> } | undefined;
  private ratesTimer: ReturnType<typeof setTimeout> | undefined;
  private summaries = new Map<string, SessionSummary>();
  private childSummaries: SessionSummary[] = [];
  /**
   * Each subagent session id's row, the resident copy over a saved one, else the first listed. On 10-18 a filter of every child row per chat
   * agent on each projection took 12% of its time.
   */
  private childById = new Map<string, SessionSummary>();
  private readonly cutListeners = new Set<(cut: Cut) => void>();
  /** Children's cut ends (`SessionCuts`), read after each list; each cut that came or moved goes to `onCut`'s listeners. */
  readonly cuts = new SessionCuts(cut => { for (const listener of this.cutListeners) listener(cut); });
  /** Runs `listener` for each job cut a read of the children's transcripts finds new. */
  onCut(listener: (cut: Cut) => void): void { this.cutListeners.add(listener); }
  private cutsReading = false;
  private schedules = new Map<string, ThreadSchedule>();
  private observedDaemonVersion: { version: string | undefined } | undefined;
  private daemonVersionListener: (version: string | undefined) => void = () => {};
  private supervisorGeneration: string | undefined;
  private readonly supervisorListeners = new Set<() => void>();
  /** Runs `listener` when a connect meets a new supervisor (`daemon_hello.supervisorGeneration` changed): a Prime update or a daemon restart, which cut the turns it stopped. */
  onSupervisorChange(listener: () => void): void { this.supervisorListeners.add(listener); }
  private readonly rowListeners = new Set<() => void>();
  /** Runs `listener` after each change of this box's daemon rows (`daemonRows`), which the copy lays into one call per 150 ms. */
  onDaemonRows(listener: () => void): () => void {
    this.rowListeners.add(listener);
    return () => { this.rowListeners.delete(listener); };
  }
  /** A backend can connect before SDK sync is attached. Replay that hello as well as later reconnects. */
  set onDaemonVersion(listener: (version: string | undefined) => void) {
    this.daemonVersionListener = listener;
    if (this.observedDaemonVersion) listener(this.observedDaemonVersion.version);
  }
  private readonly listeners = new Set<(event: SessionsEvent) => void>();
  private daemon: "up" | "down" = "down";
  private lastError: string | undefined;
  /** This box's sessions, kept the way every other box's are (`SessionPeer`): the roster stream keeps them current, and no page waits on a list. */
  private readonly peer: SessionPeer;
  private readonly heldLifecycle = new Map<string, "archived" | "active">();
  /** Each agent folder's spawned count; a count that a background read changed sends the rows again. */
  private readonly spawned = new SpawnedCounts(() => { if (!this.closed) void this.emit(); });
  /** The chat rows the last projection gave out, by session id (`keptChat`). */
  private keptChats = new Map<string, SessionRow>();
  /** The rows the last projection built, by session id, that the next one may reuse (`KeptRow`). */
  private keptRows = new Map<string, KeptRow>();
  private schedulesRefreshing: Promise<void> | undefined;
  private schedulesTimer: ReturnType<typeof setTimeout> | undefined;
  /** Wall ms of each projection since the last `projectionLine`, and the ms of each that its own code ran. */
  private projectionMs: number[] = [];
  private projectionOwnMs: number[] = [];
  private loopUse = loopPerformance.eventLoopUtilization();
  private readonly projectionTimer = setInterval(() => {
    const use = loopPerformance.eventLoopUtilization(this.loopUse);
    this.loopUse = loopPerformance.eventLoopUtilization();
    const line = projectionLine(this.projectionMs, PROJECTION_LOG_MS, use.utilization, this.projectionOwnMs);
    this.projectionMs = [];
    this.projectionOwnMs = [];
    if (line) process.stderr.write(`${new Date().toISOString()} ${line}\n`);
  }, PROJECTION_LOG_MS).unref();
  private closed = false;

  constructor(private readonly socketPath: string, private readonly readState: ChatReadState, private readonly labels: ChatLabels, private readonly chats: Pick<Chats, "ids" | "checkIns" | "links"> & Partial<Pick<Chats, "briefs" | "archivedIds" | "roster">>,
    private readonly origins: ThreadOrigins, private readonly hosts: HostCatalogs | null = null, copyFile: string | null = null) {
    this.client = new DaemonClient(socketPath);
    // Roster updates were up to 116 a minute (10-12); this box's lay into one frame per 150 ms, the wait its roster refresh had before.
    this.peer = new SessionPeer({ name: hosts?.selfName ?? "this box", client: this.client, file: copyFile, deadlines: { socketMs: 1500, helloMs: 1500 }, changeMs: 150,
      reconnectMs: 2000, log: line => process.stderr.write(`catalog: ${line}\n`), onChange: () => this.peerChanged(),
      onHello: hello => {
        this.observedDaemonVersion = { version: hello.appVersion };
        this.daemonVersionListener(hello.appVersion);
        const generation = hello.supervisorGeneration;
        if (generation && this.supervisorGeneration && generation !== this.supervisorGeneration) for (const listener of this.supervisorListeners) listener();
        if (generation) this.supervisorGeneration = generation;
      } });
    if (hosts) {
      // Another box's list or reachability changed: its rows go into the next frame with this box's copy.
      hosts.onChange = () => { if (this.peer.listed && !this.closed) void this.apply().catch(() => {}); };
      hosts.start();
    }
    this.client.onMessage(message => {
      if (message.type === "heartbeats_changed") this.scheduleSchedulesRefresh();
    });
    this.client.onClose(() => {
      clearTimeout(this.schedulesTimer);
      this.schedulesTimer = undefined;
    });
  }

  /**
   * This box's copy or link changed. A link that closes and comes back within the copy's reconnect shows no banner; one whose connect failed
   * shows a banner that names this box, over the rows it last had.
   */
  private peerChanged(): void {
    if (this.closed) return;
    if (this.peer.state === "down") this.setDaemon("down", this.unreachable(this.peer.error));
    if (this.peer.state === "up") { this.setDaemon("up"); this.scheduleSchedulesRefresh(0); }
    if (!this.peer.listed) return;
    void this.apply().catch(() => {});
    for (const listener of this.rowListeners) listener();
  }

  private unreachable(cause: string | undefined): string {
    return `The Prime Agent daemon on ${this.peer.name} is not reachable.${cause ? " " + cause : ""}`;
  }

  private setDaemon(state: "up" | "down", error?: string): void {
    const changed = this.daemon !== state || this.lastError !== error;
    this.daemon = state;
    this.lastError = error;
    if (changed && state === "down") void this.emit();
  }

  /** A link to this box's daemon subscribed to its roster; the copy connects again on its own after a failure. */
  async connect(): Promise<void> {
    if (this.closed) throw new Error("Chat catalog is closed");
    try { await this.peer.connect(); } catch (error) {
      const message = this.unreachable(error instanceof Error ? error.message : String(error));
      this.setDaemon("down", message);
      throw new Error(message);
    }
  }

  /** Schedules are a separate native projection: a slow worker never gates session delivery. */
  private scheduleSchedulesRefresh(delay = SCHEDULE_REFRESH_MS): void {
    if (this.closed || this.schedulesTimer || !this.peer.subscribed) return;
    this.schedulesTimer = setTimeout(() => {
      this.schedulesTimer = undefined;
      void this.refreshSchedules();
    }, delay);
    this.schedulesTimer.unref();
  }

  /** Each session's active or paused scheduled job as the daemon lists it now, for a stop that must not cancel one (`dutyJobHost.schedules`). */
  async schedulesNow(): Promise<ReadonlyMap<string, ThreadSchedule>> {
    const jobs = await this.client.request({ type: "cron_list" }, undefined, { recoverable: false });
    if (!jobs.success) throw new Error(jobs.error);
    return parseSchedules(jobs.data);
  }

  private async refreshSchedules(): Promise<void> {
    if (this.schedulesRefreshing) return this.schedulesRefreshing;
    this.schedulesRefreshing = (async () => {
      try {
        const jobs = await this.client.request({ type: "cron_list" }, undefined, { recoverable: false });
        if (!jobs.success) throw new Error(jobs.error);
        if (this.closed || !this.peer.subscribed) return;
        this.schedules = parseSchedules(jobs.data);
        await this.emit();
      } catch (error) {
        if (!this.closed) process.stderr.write(`catalog schedules: ${error instanceof Error ? error.message : String(error)}\n`);
      } finally {
        this.schedulesRefreshing = undefined;
        this.scheduleSchedulesRefresh();
      }
    })();
    return this.schedulesRefreshing;
  }

  /**
   * Brings this box's copy up to date (`SessionPeer.sync`: a roster list over the copy, a full list only when there is no copy) and lays it into
   * the rows. Until 10-18 a refresh ran a full list and waited for its frame to go out too, and a wait past 30 s set the whole page's daemon
   * state down: 7 of 9 "Timed out after 30000ms" lines from 04:22Z to 06:20Z were such waits, while this box's full list never took over 5.8 s.
   * A wait past LIST_WAIT_MS now rejects for its caller only, and the sync keeps running.
   */
  async refresh(): Promise<void> {
    await waitFor(this.peer.sync(() => this.connect()), LIST_WAIT_MS, this.peer.name);
    this.inputs++;
    this.index(this.peer.list());
    void this.emit().catch(() => {});
  }

  /**
   * A copy changed: the rows are indexed again once, when a reader next needs them (`settle`), and at the latest after emitGapMs. Until 10-19
   * each change indexed all rows at once: this box's copy changes every 150 ms at the live roster rate, and a projection runs at most every
   * emitGapMs, so on a scratch serve on a copy of the live data dir (`steady-profile.md`) the index ran about twice per projection and was 31 s
   * of 124 s of main-thread time from minute 3 on.
   */
  private async apply(): Promise<void> {
    if (this.closed) return;
    this.inputs++;
    if (!this.stale) {
      this.stale = true;
      this.staleTimer = setTimeout(() => { this.staleTimer = undefined; this.settle(); }, this.emitGapMs);
      this.staleTimer.unref();
    }
    await this.emit();
  }

  /** True while a copy changed since the last `index`; every reader of the indexed rows calls `settle` first. */
  private stale = false;
  private staleTimer: ReturnType<typeof setTimeout> | undefined;
  private settle(): void {
    if (!this.stale) return;
    this.stale = false;
    clearTimeout(this.staleTimer);
    this.staleTimer = undefined;
    if (!this.closed && this.peer.listed) this.index(this.peer.list());
  }

  /** The rows of this box's copy and the other boxes' copies, as the catalog reads them. */
  private index(rows: SessionSummary[]): void {
    const next = new Map<string, SessionSummary>();
    const children: SessionSummary[] = [];
    const own = new Set<string>();
    const ownActive = new Set<string>();
    for (const row of rows) {
      own.add(row.sessionId);
      if (row.activeSessionId === undefined) continue;
      own.add(row.activeSessionId);
      ownActive.add(row.sessionId);
      ownActive.add(row.activeSessionId);
    }
    this.own = own;
    this.ownActive = ownActive;
    for (const row of this.hosts ? [...rows, ...this.hosts.rows()] : rows) {
      if (!isTopLevel(row)) { children.push(row); continue; }
      const existing = next.get(row.sessionId);
      // A session on two boxes (a copy, or one moving between them) shows as the box whose daemon runs it, this box's row when both or neither do.
      if (!existing || (row.activeSessionId !== undefined && existing.activeSessionId === undefined)) next.set(row.sessionId, row);
      else if (row.activeSessionId !== undefined && !this.duplicates.has(row.sessionId)) {
        this.duplicates.add(row.sessionId);
        process.stderr.write(`catalog: session ${row.sessionId.slice(0, 8)} runs on this box and on ${this.hosts?.hostOf(row.sessionId)?.name ?? "another box"}; the list shows this box's\n`);
      }
    }
    this.summaries = next;
    this.childSummaries = children;
    this.childById = new Map();
    for (const row of children) {
      const existing = this.childById.get(row.sessionId);
      if (!existing || (existing.activeSessionId === undefined && row.activeSessionId !== undefined)) this.childById.set(row.sessionId, row);
    }
    const roster = rosterChildren(children, this.cuts);
    void Promise.resolve().then(() => this.chats.roster?.(roster)).catch(() => {});
    void this.readCuts();
  }

  /** Reads the cut ends of children that changed since the last read, one pass at a time, and hands the roster on again when one moved. */
  private async readCuts(): Promise<void> {
    if (this.cutsReading) return;
    this.cutsReading = true;
    try {
      let changed = false;
      for (let read: SessionSummary[] | undefined; read !== this.childSummaries && !this.closed;) {
        read = this.childSummaries;
        if (await this.cuts.update(cutSources(read))) changed = true;
      }
      if (!changed || this.closed) return;
      await this.chats.roster?.(rosterChildren(this.childSummaries, this.cuts));
      await this.emit();
    } catch (error) {
      if (!this.closed) process.stderr.write(`catalog: cut ends: ${error instanceof Error ? error.message : String(error)}\n`);
    } finally { this.cutsReading = false; }
  }

  private async project(): Promise<{ rows: SessionRow[]; tags: SessionsEvent["tags"] }> {
    // The time this projection's own code holds the main thread: its wall time without the awaits (`projectionLine`).
    let own = 0;
    let ran = performance.now();
    const wait = async <T>(promise: Promise<T>): Promise<T> => {
      own += performance.now() - ran;
      try { return await promise; } finally { ran = performance.now(); }
    };
    // The loop gets a turn once this projection's code ran PROJECTION_SLICE_MS since the last one (`breathe`).
    let slice = performance.now();
    const breathe = async (): Promise<void> => {
      if (performance.now() - slice < PROJECTION_SLICE_MS) return;
      await wait(new Promise<void>(resolve => { setImmediate(resolve); }));
      slice = performance.now();
    };
    const [state, labels, chats, checkIns, briefs, archivedByOwner] = await wait(Promise.all([this.readState.snapshot().catch(() => null), this.labels.snapshot().catch(() => null),
      this.chats.ids().catch(() => null), this.chats.checkIns().catch(() => null), this.chats.briefs?.().catch(() => null) ?? null, this.chats.archivedIds?.().catch(() => null) ?? null]));
    // The reads the chat loop below needs start now and run while the rows are built: one after another, each waited behind whatever else the
    // main thread ran, and on 10-19 live projections waited about as long as their own code ran (wall p90 100 to 133 ms, own code p90 58 to 66 ms).
    const startedAt = Date.now();
    const linksOf = new Map([...chats ?? []].map(id => [id, this.chats.links(id, this.title(id) ?? undefined).catch(() => null)] as const));
    const queuedRead = this.queueSource();
    const wakesRead = this.wakesSource(startedAt).catch(() => []);
    const originOf = await wait(this.origins.resolver(chats ?? new Set()));
    this.settle();
    const running = runningByParent(this.childSummaries);
    const children = childrenByParent(this.childSummaries);
    const selfName = this.hosts?.selfName ?? null;
    const kept = new Map<string, KeptRow>();
    const rows: SessionRow[] = [];
    // The read markers by session in a Map: looking each of the 4,500 rows up in the parsed read state's object was 1.9 of 29 ms of a
    // projection's own code on a bench over a copy of the live rows on 10-19.
    const readAts = new Map(Object.entries(state?.sessions ?? {}).map(([id, marker]) => [id, marker?.timestamp] as const));
    let since = 0;
    for (const row of [...this.summaries.values()]) {
      if (++since === BREATHE_ROWS) { since = 0; await breathe(); }
      const remote = this.hostOf(row.sessionId);
      // Another box's saved session is listed by its daemon's word: its file is on that box's disk, not this one.
      if (!(remote ? isListed(row, () => true) : listedHere(row)) || this.spares.has(row.sessionId)) continue;
      const host = remote ?? selfName;
      const schedule = this.schedules.get(row.sessionId);
      const labelsFor = labels && Object.hasOwn(labels.threads, row.sessionId) ? labels.threads[row.sessionId] : undefined;
      const subtree = subtreeOf(row, children);
      const chat = chats?.has(row.sessionId) === true;
      const working = isWorking(row, subtree);
      const origin = originOf(row);
      const archived = archivedByOwner?.has(row.sessionId) === true;
      // A working row's pulse reads the rows of its running subagents at any depth, so they are part of its key.
      // The key is built in one reused array and copied only for a row built again: most rows are kept, and a new 14-entry array for each of the
      // 4,500 rows on every projection was about 4 of 54 ms of its own code on a bench over a copy of the live rows on 10-19.
      const readAt = readAts.get(row.sessionId);
      const baseline = state?.baseline ?? 0;
      const fixed = scratchKey;
      fixed[0] = row; fixed[1] = readAt; fixed[2] = baseline; fixed[3] = labelsFor; fixed[4] = schedule; fixed[5] = subtree.cost; fixed[6] = subtree.running;
      fixed[7] = subtree.total; fixed[8] = origin; fixed[9] = host; fixed[10] = archived; fixed[11] = this.heldLifecycle.get(row.sessionId); fixed[12] = working;
      const below = working ? runningBelow(row, running) : NO_ROWS;
      const before = this.keptRows.get(row.sessionId);
      // A chat row gets its agents and counts written onto it below, so it is built again.
      if (!chat && before && sameKey(before.key, fixed, below)) { kept.set(row.sessionId, before); rows.push(before.row); continue; }
      const key = [...fixed, ...below];
      const checkIn = checkIns?.get(row.sessionId);
      const brief = briefs?.get(row.sessionId);
      const projected = this.applyHeld(row, projectRow(row, readAt, baseline, {
        ...(labelsFor ? { labels: labelsFor } : {}), ...(schedule ? { schedule } : {}), subtree, origin,
        ...(chat ? { chat: true, ...(checkIn ? { checkIn } : {}), ...(brief ? { brief } : {}) } : {}),
        ...(working ? { pulse: sessionPulse(row, running) } : {}) }));
      if (host) projected.host = host;
      // A chat the owner archived stays out of the sidebar when an agent message resumes its session; only his unarchive brings it back.
      if (archived) projected.archived = true;
      if (!chat) kept.set(row.sessionId, { key, row: projected });
      rows.push(projected);
    }
    this.keptRows = kept;
    await breathe();
    // Each row's time is read once, not once per comparison: the sort compares about 50,000 pairs of the 4,500 rows.
    const times = new Float64Array(rows.length);
    const order = new Uint32Array(rows.length);
    for (let at = 0; at < rows.length; at++) {
      if (at % BREATHE_ROWS === 0) await breathe();
      times[at] = sortTime(rows[at]!); order[at] = at;
    }
    order.sort((left, right) => times[right]! - times[left]! || left - right);
    const unsorted = rows.slice();
    for (let at = 0; at < order.length; at++) rows[at] = unsorted[order[at]!]!;
    await breathe();
    // A chat's agents resolve step owners and message partners against every other row, so they are filled in once all rows exist.
    const agentRows: AgentRow[] = [];
    for (const row of rows) {
      if (agentRows.length % BREATHE_ROWS === 0) await breathe();
      let entry = agentRowOf.get(row);
      if (!entry) { const first = firstTask(this.summaries.get(row.id) ?? {}); entry = first ? { row, first } : { row }; agentRowOf.set(row, entry); }
      agentRows.push(entry);
    }
    const now = Date.now();
    const chatRows = rows.filter(row => row.chat);
    for (const row of chatRows) {
      await breathe();
      const links = await wait(linksOf.get(row.id) ?? this.chats.links(row.id, row.name).catch(() => null));
      row.agents = keptChatAgents({ self: { id: row.id, name: row.name }, children: links?.children ?? [], childSessions: subagentSessions(children.get(row.id) ?? [], children, this.cuts),
        board: links?.board ?? null, roots: links?.roots ?? [], messages: links?.messages ?? [], rows: agentRows, now });
      const sessions = stepSessions(links?.board ?? null, row.agents);
      if (sessions.size) void this.linkSessions(row.id, sessions);
      if (links?.board?.plan.length) row.plan = planCounts(links.board.plan);
      const forYou = links?.board?.todos.filter(todo => !todo.done).length ?? 0;
      if (forYou) row.forYou = forYou;
      if (row.unread && links?.messages.length) {
        const count = unreadOf(links.messages, Math.max(state?.baseline ?? 0, state?.sessions[row.id]?.timestamp ?? 0));
        if (count) row.unreadCount = count;
      }
    }
    const rates = this.ratesFor(chatRows.flatMap(row => (row.agents ?? []).flatMap(agent => agent.sessionId ? [agent.sessionId] : [])), now);
    const queued = await wait(queuedRead);
    const wakes = await wait(wakesRead);
    const below = (session: string) => (children.get(session) ?? []).map(child => child.sessionId);
    await breathe();
    for (const row of chatRows) row.agents = withWaits(withQueue(withRates(row.agents ?? [], rates), queued), wakes, below);
    await breathe();
    for (const agent of chatRows.flatMap(row => row.agents ?? [])) {
      const session = agent.sessionId ? this.find(agent.sessionId) : undefined;
      const folder = session ? subagentFolder(session) : undefined;
      const spawned = folder ? this.spawned.of(folder, now) : 0;
      if (spawned > (agent.subagentsTotal ?? 0)) agent.subagentsTotal = spawned;
    }
    // A chat row that came out as the last projection built it is that projection's object again (`keptChat`).
    const keptChats = new Map<string, SessionRow>();
    for (let at = 0; at < rows.length; at++) {
      const row = rows[at]!;
      if (!row.chat) continue;
      await breathe();
      const kept = keptChat(this.keptChats.get(row.id), row);
      rows[at] = kept;
      keptChats.set(row.id, kept);
    }
    this.keptChats = keptChats;
    // A queued agent's place moves as the queue drains, so the rows go out again while one waits too.
    this.scheduleRates(chatRows.some(row => row.agents?.some(agent => agent.state === "working" || agent.queued !== undefined)));
    this.projectionOwnMs.push(own + performance.now() - ran);
    return { rows, tags: labels?.tags ?? [] };
  }

  /**
   * Output rates per session from LGTM (src/usage/lgtm.ts), asked at most once per RATES_MS for the same ids; nothing when no source is wired. A
   * projection never waits for the answer: it takes the last answer and asks again in the background, and the next frame, which comes within
   * RATES_MS while an agent works (`scheduleRates`), carries the new one. On 10-18 a scratch serve at the live rate waited about 225 ms for
   * the usage worker on every fourth projection, and those waits were the projections' whole 90th percentile (300 ms against 60 ms median).
   */
  private ratesFor(sessionIds: string[], now: number): Record<string, TokenRate> {
    const ids = [...new Set(sessionIds)].sort();
    const key = ids.join(",");
    const known = this.rates;
    if (!this.ratesReading && !(known && known.key === key && now - known.at < RATES_MS)) {
      const reading = this.ratesReading = (ids.length ? this.ratesSource(ids).catch(() => ({})) : Promise.resolve({}))
        .then(value => { this.rates = { key, at: now, value }; }).finally(() => { if (this.ratesReading === reading) this.ratesReading = undefined; });
    }
    return known?.value ?? {};
  }
  private ratesReading: Promise<void> | undefined;

  /** While an agent of a chat works, the rows go out again every RATES_MS with fresh rates; the timer stops once nothing works. */
  private scheduleRates(working: boolean): void {
    if (!working || this.ratesTimer || this.closed || this.listeners.size === 0) return;
    this.ratesTimer = setTimeout(() => { this.ratesTimer = undefined; void this.emit(); }, RATES_MS);
    this.ratesTimer.unref();
  }

  /**
   * The rows now. A call while a projection runs on the same inputs takes that projection's rows instead of building its own: on 10-18 a scratch
   * serve of this box's chats got 22 to 98 rows() calls per 30 s, from duty, check-in and archive code looking up one row each, and every call
   * built all 3,700 rows and every chat's agents beside the frames' own projections. A change to the daemon rows or a notify() starts a new one.
   */
  async rows(): Promise<SessionRow[]> {
    const running = this.running;
    if (running && running.inputs === this.inputs) return (await running.result).rows;
    if (this.lastFrame?.inputs === this.inputs && Date.now() - this.lastFrame.at < this.emitGapMs) return [...this.lastFrame.rows];
    // A frame that waits out emitGapMs starts after this call's change, so its rows serve the call too.
    const waiting = this.emitRun;
    if (waiting && !waiting.started && this.listeners.size) {
      const asked = this.inputs;
      await waiting.promise.catch(() => {});
      if (this.lastFrame && this.lastFrame.inputs >= asked) return [...this.lastFrame.rows];
    }
    return (await this.tracked()).rows;
  }
  /**
   * The rows of the last frame and the inputs it began on. Until 10-20 a rows() call between frames built its own projection: on a scratch serve
   * on a copy of the live data dir with its chats, 140 to 220 projections ran a minute while frames went out at most every emitGapMs (120).
   */
  private lastFrame: { inputs: number; rows: SessionRow[]; at: number } | undefined;
  /** Bumped by each change the catalog hears of (new daemon rows, and every emit: notify, schedules, cut ends, rates), so rows() never takes a projection that began before one. */
  private inputs = 0;
  private running: { inputs: number; result: ReturnType<Catalog["project"]> } | undefined;
  private tracked(): ReturnType<Catalog["project"]> {
    const started = performance.now();
    const run = { inputs: this.inputs, result: this.project() };
    void run.result.then(() => { this.projectionMs.push(performance.now() - started); }, () => {});
    this.running = run;
    void run.result.finally(() => { if (this.running === run) this.running = undefined; }).catch(() => {});
    return run.result;
  }

  async event(): Promise<SessionsEvent> {
    const { rows, tags } = await this.tracked();
    return { type: "sessions", sessions: rows, tags, daemon: this.daemon, ...(this.lastError && this.daemon === "down" ? { error: this.lastError } : {}) };
  }

  private emitRun: { started: boolean; promise: Promise<void> } | undefined;
  private emitNext: Promise<void> | undefined;
  private emittedAt = 0;
  /** The last frame sent, which a new subscriber gets at once. */
  private lastEvent: SessionsEvent | undefined;
  /**
   * The least time between two frame projections, from a sweep on 10-18. Scratch serve on a copy of browser-chat, fake daemons at the live
   * rate (13.3 roster updates a second), one held page, 120 s each: a window of 0, 100, 150, 250, 500 and 1000 ms made 4.9, 4.6, 4.9, 4.0,
   * 2.05 and 1.08 frames a second, and the main thread was 29.1, 29.1, 28.4, 24.6, 16.5 and 13.5% busy. A projection took about 200 ms
   * there, so a window under that changes nothing. 500 ms keeps most of the cut and halves the sidebar's lag against 1 s. The first change
   * after a quiet window goes out at once.
   */
  emitGapMs = 500;
  /**
   * One projection at a time, at most one per `emitGapMs`: an emit asked for while one waits joins it, and one asked for while one runs waits
   * for it, and every such ask shares one run after it, so each caller still gets a frame built after its change. On 10-18 the service's main
   * thread was about 95% busy and project() took half of it, and frames went out in bursts of 4 identical lists within 140 ms from projections
   * that overlapped.
   */
  private emit(): Promise<void> {
    this.inputs++;
    const running = this.emitRun;
    if (running && !running.started) return running.promise;
    if (running) {
      this.emitNext ??= running.promise.catch(() => {}).then(() => { this.emitNext = undefined; return this.emit(); });
      return this.emitNext;
    }
    const wait = this.emittedAt + this.emitGapMs - Date.now();
    const run = { started: false, promise: Promise.resolve() };
    const start = (): Promise<void> => { run.started = true; return this.emitOnce(); };
    run.promise = (wait > 0 ? new Promise<void>(resolve => { setTimeout(resolve, wait).unref(); }).then(start) : start())
      .finally(() => { if (this.emitRun === run) this.emitRun = undefined; });
    this.emitRun = run;
    return run.promise;
  }

  /**
   * Frames wait for the copy's first rows: a schedule reply or a notify that lands before them would report "up" with no rows. A "down" frame
   * goes out only with its cause, so a service start shows no banner before its first connect.
   */
  private async emitOnce(): Promise<void> {
    if (this.listeners.size === 0 || (this.daemon === "up" && !this.peer.listed) || (this.daemon === "down" && !this.lastError)) return;
    this.emittedAt = Date.now();
    const inputs = this.inputs;
    const event = await this.event();
    this.lastEvent = event;
    this.lastFrame = { inputs, rows: event.sessions, at: Date.now() };
    // Each listener diffs and sends the frame on its own socket; the loop gets a turn between them once they ran PROJECTION_SLICE_MS.
    let slice = performance.now();
    for (const listener of [...this.listeners]) {
      if (performance.now() - slice >= PROJECTION_SLICE_MS) { await new Promise<void>(resolve => { setImmediate(resolve); }); slice = performance.now(); }
      if (this.listeners.has(listener)) listener(event);
    }
  }

  notify(): Promise<void> { return this.emit(); }

  /**
   * The rows of the last frame while a listener holds the feed, so that every change the catalog hears of sends a new frame within emitGapMs and
   * one projection; null with no listener or before the first frame. A read of one row takes these instead of building every row and every
   * chat's agents again: on 10-18 the chat_board tool's api/threads/<id>/agents read started its own projection on each call, since the inputs
   * change 13.3 times a second, and it answered in 1.0 to 3.5 s 34 times between 15:13Z and 17:03Z while projections ran a p90 of 0.7 to 2.7 s.
   */
  framedRows(): readonly SessionRow[] | null {
    return this.listeners.size && this.lastEvent ? this.lastEvent.sessions : null;
  }

  /** Like `subscribe`, without the refresh a page load asks for: a page's agents feed starts on each chat it opens or unfolds. */
  watch(listener: (event: SessionsEvent) => void): () => void {
    this.listeners.add(listener);
    if (this.lastEvent) listener(this.lastEvent);
    else void this.event().then(listener, () => {});
    return () => { this.listeners.delete(listener); };
  }

  subscribe(listener: (event: SessionsEvent) => void): () => void {
    this.listeners.add(listener);
    // A page load gets the list as it was at the last frame at once, and the fresh one when the refresh's projection lands.
    if (this.lastEvent) listener(this.lastEvent);
    void this.refresh().catch(async () => { listener(await this.event()); });
    return () => { this.listeners.delete(listener); };
  }

  /** A top-level thread, else a subagent session, so a child transcript opens read the same way as its parent. */
  async summary(sessionId: string): Promise<SessionSummary | undefined> {
    let summary = this.find(sessionId);
    if (!summary) { await this.refresh(); summary = this.find(sessionId); }
    // Until every other box listed once, a session this box lacks may run there: the service start's adopt would forget a chat on the Mac.
    if (!summary && await this.unplaced(sessionId)) throw new Error(`Session ${sessionId.slice(0, 8)} is not on this box, and another box has not listed its sessions yet.`);
    summary ??= this.find(sessionId);
    // Another box's session file is read here from its local copy, so the copy is brought up to date for whoever asked (check-ins, briefs, history).
    if (summary && this.hosts && this.hostOf(sessionId)) await this.localFile(summary).catch(error => {
      process.stderr.write(`catalog: copy of ${sessionId.slice(0, 8)} from ${this.hostOf(sessionId)}: ${error instanceof Error ? error.message : String(error)}\n`);
    });
    if (!summary || this.heldLifecycle.get(sessionId) !== "archived") return summary;
    const { activeSessionId: _activeSessionId, ...saved } = summary;
    return { ...saved, lifecycle: "archived" };
  }

  /**
   * Whether the session has a worker of its own (an activeSessionId) in the row the catalog holds now, with no refresh, null when it is not
   * listed. The row is a box's that runs it when two boxes list it, so false means no box's list shows it loaded. A stopped subagent stays
   * listed in its loaded tree with no activeSessionId: 63 of the 114 subagent rows of the 10-18 00:54Z list read so.
   */
  resident(sessionId: string): boolean | null {
    const row = this.find(sessionId);
    return row ? row.activeSessionId !== undefined : null;
  }

  /** A session's title from what the catalog holds now, with no refresh; null when it is not listed. */
  title(sessionId: string): string | null {
    const row = this.find(sessionId);
    return row ? sessionTitle(row) : null;
  }

  /** True once every other box of hosts.json listed its sessions, and always without hosts.json. */
  hostsListed(): boolean { return this.hosts?.allListed() ?? true; }

  /** True once every other box of hosts.json answered a list in this run, so an id none lists is on none; always without hosts.json. */
  hostsSynced(): boolean { return this.hosts?.allSynced() ?? true; }

  /** The other boxes' rows, live ones only from a box whose daemon answers now; empty without hosts.json. */
  remoteRows(): readonly SessionSummary[] { return this.hosts?.rows() ?? []; }
  /** Each other host with its rows, for the watch line's per-host numbers. */
  remoteHosts(): { host: Host; rows: SessionSummary[] }[] { return this.hosts?.hostRows() ?? []; }
  /** This box's name in hosts.json; null without the file or when this box is not in it. */
  selfHostName(): string | null { return this.hosts?.self?.name ?? null; }

  /** The daemon's rows from the last list as it sent them, live roster rows laid over; empty before the first full list. */
  daemonRows(): readonly SessionSummary[] {
    return this.peer.listed ? this.peer.list() : [];
  }

  private find(sessionId: string): SessionSummary | undefined {
    this.settle();
    return this.summaries.get(sessionId) ?? this.childById.get(sessionId);
  }

  /** The last activity of each session the daemon lists below `sessionId` at any depth, in epoch ms, NaN for one with none. */
  childActivity(sessionId: string): number[] {
    this.settle();
    const children = childrenByParent(this.childSummaries);
    const times: number[] = [];
    const seen = new Set([sessionId]);
    const pending = [...(children.get(sessionId) ?? [])];
    for (let child = pending.pop(); child; child = pending.pop()) {
      if (seen.has(child.sessionId)) continue;
      seen.add(child.sessionId);
      times.push(Date.parse(child.lastActivityAt ?? ""));
      pending.push(...(children.get(child.sessionId) ?? []));
    }
    return times;
  }

  /** The session and every session the daemon lists below it at any depth, as the catalog holds them now; empty when it is not listed. */
  tree(sessionId: string): SessionSummary[] {
    const root = this.find(sessionId);
    if (!root) return [];
    const children = childrenByParent(this.childSummaries);
    const rows = [root];
    const seen = new Set([sessionId]);
    for (let at = 0; at < rows.length; at++) {
      for (const child of children.get(rows[at]!.sessionId) ?? []) {
        if (seen.has(child.sessionId)) continue;
        seen.add(child.sessionId);
        rows.push(child);
      }
    }
    return rows;
  }

  /** Native usage cost of each subagent under a parent session, from the daemon summaries of non-top-level sessions. */
  childUsage(parentSessionId: string): ChildUsage[] {
    this.settle();
    return this.childSummaries.filter(row => row.parentSessionId === parentSessionId).map(row => ({ sessionId: row.sessionId,
      ...(row.rlmChildId ? { rlmChildId: row.rlmChildId } : {}), ...(row.sessionName ? { sessionName: row.sessionName } : {}),
      ...(row.usage && Number.isFinite(row.usage.cost) ? { cost: row.usage.cost } : {}) }));
  }

  forget(sessionId: string): void { this.settle(); this.summaries.delete(sessionId); this.inputs++; }

  /** Changes the row of a session this server changed itself, such as a saved session's new name, in the copy of the box that lists it. */
  patchRow(sessionId: string, fields: Partial<SessionSummary>): void {
    if (!this.hosts?.patch(sessionId, fields) && !this.peer.patch(sessionId, fields)) return;
    if (this.peer.listed) void this.apply().catch(() => {});
  }

  /** This box's session ids and active session ids from its last list, and the ones of them with a worker now. */
  private own = new Set<string>();
  private ownActive = new Set<string>();
  /** Sessions already logged as running on two boxes. */
  private readonly duplicates = new Set<string>();
  /** The box of each session id and active session id this server started on another box, until that box's list names it (`place`). */
  private readonly placed = new Map<string, string>();

  /**
   * Sends the commands for a session this server just started on another box to that box before its list names the session. On 10-19 three
   * new Mac threads in a row answered 502 "Unknown active session" and lost their first message: the prompt right after the create went to
   * this box's daemon, because the Mac's roster had not listed the session yet.
   */
  place(host: string, ...ids: string[]): void { for (const id of ids) this.placed.set(id, host); this.inputs++; }
  /** A spare session made for a new thread the owner is still writing (ThreadHub.prewarm) stays out of the sidebar until his send takes it. */
  spare(sessionId: string, on: boolean): void { if (on) this.spares.add(sessionId); else this.spares.delete(sessionId); this.inputs++; }
  private readonly spares = new Set<string>();

  /**
   * The hosts.json box whose daemon runs `id` (a session id or active session id); null for this box and when there is no hosts.json. A session
   * this box lists too is this box's unless only the other box has a worker for it.
   */
  hostOf(id: string): string | null {
    const host = this.hosts?.hostOf(id);
    if (!host) return this.placed.get(id) ?? null;
    this.placed.delete(id);
    this.settle();
    if (!this.own.has(id)) return host.name;
    return !this.ownActive.has(id) && this.hosts!.isActive(id) ? host.name : null;
  }

  /** The path the session's own daemon knows its file by: another box's path for a row whose file the catalog names by its local copy. */
  daemonPath(summary: Pick<SessionSummary, "sessionId" | "sessionFile">): string | undefined {
    const host = this.hostOf(summary.sessionId);
    return host && summary.sessionFile ? remotePath({ name: host }, summary.sessionFile) : summary.sessionFile;
  }

  /** The client of the daemon that runs `id`: another box's through its bridge socket, else this box's. It may still be connecting. */
  clientFor(id: string): DaemonClient {
    const host = this.hostOf(id);
    return (host && this.hosts?.client(host)) || this.client;
  }

  /** True for a hosts.json box other than this one, whose folders and files are on its own disk. */
  isOtherHost(name: string | null | undefined): boolean { return !!name && !!this.hosts?.client(name); }

  /** The hello this service last read from the named box's daemon (this box's when the name is null or its own), without connecting. */
  helloOf(name: string | null): DaemonClient["hello"] {
    return (name && name !== this.hosts?.selfName ? this.hosts?.client(name) : this.client)?.hello;
  }

  /** Whether the named box's daemon link is up now (this box's when the name is null or its own). */
  reachable(name: string | null): boolean {
    if (!name || name === this.hosts?.selfName) return this.daemon === "up";
    return this.hosts?.status().some(host => host.name === name && host.up) === true;
  }

  /** A connected client for the named box, this box's when the name is absent or its own; it throws for a name hosts.json does not list. */
  async hostClient(name?: string | null): Promise<DaemonClient> {
    if (!name || name === this.hosts?.selfName) { await this.connect(); return this.client; }
    const client = await this.hosts?.ready(name);
    if (!client) throw new Error(`There is no host ${name} in hosts.json.`);
    return client;
  }

  /**
   * A connected client of the daemon that runs `id`. Until every other box listed once, an id this box does not list may be another box's, so
   * it throws rather than send it here: at 04:22Z on 10-18 the box service's first wake tick ran 2 s before the Mac's list and dropped 3 Mac
   * jobs' wakes as "no such session".
   */
  async daemonFor(id: string): Promise<DaemonClient> {
    if (await this.unplaced(id)) throw new Error(`Session ${id.slice(0, 8)} is not on this box, and another box has not listed its sessions yet.`);
    return this.hostClient(this.hostOf(id));
  }

  /**
   * True while `id` is not this box's and some other box has not listed yet, so it may run there. It first waits for the disk copies of the
   * last run: at 06:57:21Z on 10-18 a restart read the Mac's 3,060-row copy 2 s after its start, and a chat list at 06:57:22.8Z still found
   * the Mac unlisted. Before the copies each restart refused every Mac session for the 8 to 43 s the Mac's full list took (11 restarts from
   * 05:41 to 06:53Z; the first wake tick after the 06:15:41Z one refused 16 wakes). A session the copies lack stays unplaced until every box
   * answered a list this run: on 10-18 each restart's adopt forgot Mac chat 01a11ba8, which the Mac's copy held, because the copy was read
   * during this wait and the row was never looked up again, and a copy up to 30 min old may lack a newer chat.
   */
  private async unplaced(id: string): Promise<boolean> {
    this.settle();
    if (!this.hosts || this.hosts.allSynced() || this.own.has(id)) return false;
    await Promise.all([this.peer.loaded(), this.hosts.loaded()]);
    this.settle();
    return !this.hosts.allSynced() && !this.own.has(id) && !this.hosts.hostOf(id);
  }

  /** The socket a new DaemonClient opens for the named box: its bridge socket, else this box's daemon socket. */
  socketPathFor(name?: string | null): string {
    return name && this.hosts && name !== this.hosts.selfName ? this.hosts.socketPath(name) : this.socketPath;
  }

  /** A path on this disk that holds the session's file: the file itself, or for another box's session a copy kept current through its relay. */
  async localFile(summary: Pick<SessionSummary, "sessionId" | "sessionFile">): Promise<string | undefined> {
    if (!summary.sessionFile) return undefined;
    const name = this.hostOf(summary.sessionId);
    const host = name ? this.hosts?.registry.hosts.find(candidate => candidate.name === name) : undefined;
    return host ? await this.hosts!.mirror(host, remotePath(host, summary.sessionFile)) : summary.sessionFile;
  }

  /**
   * The row shows this lifecycle until the daemon list agrees (archived: listed as archived with no active session). The daemon scan can lag
   * behind the session file, and the terminal agents view hides a deactivated row the same way until it does.
   */
  holdLifecycle(sessionId: string, lifecycle: "archived" | "active"): void { this.heldLifecycle.set(sessionId, lifecycle); this.inputs++; }

  private applyHeld(row: SessionSummary, projected: SessionRow): SessionRow {
    const held = this.heldLifecycle.get(row.sessionId);
    if (!held) return projected;
    const agrees = held === "archived" ? row.lifecycle === "archived" && row.activeSessionId === undefined : row.lifecycle !== "archived";
    if (agrees) { this.heldLifecycle.delete(row.sessionId); return projected; }
    if (held === "active") return { ...projected, archived: false };
    const { pulse: _pulse, ...rest } = projected;
    return { ...rest, archived: true, kind: "saved", status: "saved", working: false, subagentsRunning: 0, unread: false };
  }

  /** This box's hosts.json name; null without hosts.json. */
  selfHost(): string | null { return this.hosts?.selfName ?? null; }

  /** Each box's folders, its 30 most recently used, so New chat offers a box only the folders on its own disk. */
  async workspaces(): Promise<Workspace[]> {
    this.settle();
    if (this.summaries.size === 0) await this.refresh().catch(() => {});
    const byFolder = new Map<string, Workspace>();
    for (const row of this.summaries.values()) {
      const at = row.lastActivityAt ?? row.modified ?? row.created;
      const host = this.hostOf(row.sessionId) ?? this.selfHost();
      const key = `${host ?? ""}\0${row.cwd}`;
      const entry = byFolder.get(key) ?? { cwd: row.cwd, host, count: 0 };
      entry.count++;
      if (at && (!entry.lastUsedAt || at > entry.lastUsedAt)) entry.lastUsedAt = at;
      byFolder.set(key, entry);
    }
    const perHost = new Map<string | null, number>();
    return [...byFolder.values()].sort((left, right) => (right.lastUsedAt ?? "").localeCompare(left.lastUsedAt ?? ""))
      .filter(entry => { const shown = perHost.get(entry.host) ?? 0; perHost.set(entry.host, shown + 1); return shown < 30; });
  }

  async close(): Promise<void> {
    this.closed = true;
    clearInterval(this.projectionTimer);
    this.peer.close();
    clearTimeout(this.schedulesTimer);
    clearTimeout(this.ratesTimer);
    clearTimeout(this.staleTimer);
    this.listeners.clear();
    this.client.close();
    this.hosts?.close();
  }
}
