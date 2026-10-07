import { closeSync, existsSync, openSync, readSync } from "node:fs";
import { basename } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { DaemonClient, parseSkillBlock, type SessionSummary } from "prime-agent";
import type { ChatLabels } from "./chat-labels.ts";
import type { Chats } from "./chats.ts";
import type { ChatReadState } from "./chat-read-state.ts";
import type { ThreadOrigin, ThreadOrigins } from "./thread-origin.ts";
import type { ChatJob, CheckInState, ChildPulse, ChildUsage, Pulse, SessionPulse, SessionRow, SessionsEvent, ThreadLabels, ThreadSchedule, Workspace } from "./shared/types.ts";

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

const FIRST_MESSAGE_SCAN_BYTES = 4 * 1024 * 1024;
/** cron_list fans out to every worker; roster activity must not repeat that work. */
const SCHEDULE_REFRESH_MS = 30_000;

function userText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.flatMap((part: unknown) => isRecord(part) && part.type === "text" && typeof part.text === "string" ? [part.text] : []).join("\n");
}

/**
 * The first user message stored in a session file. Undefined when the file is missing or has no user message yet; an empty string when none
 * appears in the first FIRST_MESSAGE_SCAN_BYTES.
 */
export function fileFirstMessage(sessionFile: string): string | undefined {
  let fd: number;
  try { fd = openSync(sessionFile, "r"); } catch { return undefined; }
  try {
    const decoder = new StringDecoder("utf8");
    const chunk = Buffer.alloc(64 * 1024);
    let pending = "";
    let scanned = 0;
    while (scanned < FIRST_MESSAGE_SCAN_BYTES) {
      const read = readSync(fd, chunk, 0, chunk.length, scanned);
      if (read === 0) return undefined;
      scanned += read;
      pending += decoder.write(chunk.subarray(0, read));
      let newline = pending.indexOf("\n");
      while (newline >= 0) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        newline = pending.indexOf("\n");
        if (!line.includes('"user"')) continue;
        try {
          const entry: unknown = JSON.parse(line);
          if (isRecord(entry) && entry.type === "message" && isRecord(entry.message) && entry.message.role === "user") return userText(entry.message.content);
        } catch { /* a torn last line is still being written */ }
      }
    }
    return "";
  } finally { closeSync(fd); }
}

function messageTitle(first: string): string {
  const skill = parseSkillBlock(first);
  const text = skill ? skill.userMessage ?? "" : /^\s*<(?:skill|system|instructions)(?:\s|>)/i.test(first) ? "" : first;
  return text.replace(/\s+/g, " ").trim().slice(0, 100);
}

/** Title text of each session file's first user message. A session file only grows at its end, so a found entry never changes. */
const fileTitles = new Map<string, string>();

function storedTitle(sessionFile: string | undefined): string | undefined {
  if (!sessionFile) return undefined;
  const cached = fileTitles.get(sessionFile);
  if (cached !== undefined) return cached;
  const first = fileFirstMessage(sessionFile);
  if (first === undefined) return undefined;
  const title = messageTitle(first);
  fileTitles.set(sessionFile, title);
  return title;
}

/**
 * A thread's title: the native session name, else the first user message stored in the session file, else the folder name. The daemon's
 * `firstMessage` is used only until the file has a user message: for a live thread it is the first user message still in memory, which after a
 * compaction or a resume is a later message, so a title built from it changes.
 */
export function sessionTitle(row: Pick<SessionSummary, "sessionName" | "firstMessage"> & { cwd?: string; sessionFile?: string }): string {
  const name = row.sessionName?.replace(/\s+/g, " ").trim();
  if (name) return name;
  const text = storedTitle(row.sessionFile) ?? messageTitle(row.firstMessage ?? "");
  return text || (row.cwd ? basename(row.cwd) : "") || "New chat";
}

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

export interface Subtree { cost?: number; running: number }

/**
 * The terminal agents view's numbers for a thread's subagent tree: `recursiveCost` (own cost plus every subagent below it, live or saved, as
 * `computeRecursiveRollups` adds it) and `runningSubagentCount` (running subagents at any depth).
 */
export function subtreeOf(row: SessionSummary, children: ReadonlyMap<string, SessionSummary[]>): Subtree {
  let cost = row.usage && Number.isFinite(row.usage.cost) ? row.usage.cost : undefined;
  let running = 0;
  const seen = new Set<string>([row.sessionId]);
  const pending = [...(children.get(row.sessionId) ?? [])];
  for (let child = pending.pop(); child; child = pending.pop()) {
    if (seen.has(child.sessionId)) continue;
    seen.add(child.sessionId);
    if (child.usage && Number.isFinite(child.usage.cost)) cost = (cost ?? 0) + child.usage.cost;
    if (nativeStatus(child) === "running") running++;
    pending.push(...(children.get(child.sessionId) ?? []));
  }
  return { ...(cost !== undefined ? { cost } : {}), running };
}

export interface RowExtras { labels?: ThreadLabels; schedule?: ThreadSchedule; pulse?: SessionPulse; subtree?: Subtree; chat?: boolean; origin?: ThreadOrigin; jobs?: ChatJob[]; checkIn?: CheckInState }

/** A chat's direct subagent sessions as sidebar jobs, running first, then by latest activity. */
export function chatJobs(children: readonly SessionSummary[]): ChatJob[] {
  const jobs = children.map((row): ChatJob => {
    const status = nativeStatus(row);
    const failed = row.statusLabel === "failed" || row.workerState === "failed" || settledOnFailure(row);
    const activity = status === "running" ? row.statusLabel ?? row.summary?.trim().slice(0, 200) : failed ? row.summary?.trim().slice(0, 200) : undefined;
    const at = row.lastActivityAt ?? row.modified;
    return { id: row.sessionId, ...(row.rlmChildId ? { childId: row.rlmChildId } : {}), name: sessionTitle(row),
      status: status === "running" ? "running" : row.activeSessionId !== undefined ? "idle" : "saved",
      ...(activity ? { activity } : {}), ...(at ? { lastActivityAt: at } : {}), ...(failed ? { failed: true } : {}) };
  });
  const at = (job: ChatJob) => Date.parse(job.lastActivityAt ?? "") || 0;
  return jobs.sort((left, right) => Number(right.status === "running") - Number(left.status === "running") || at(right) - at(left));
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
  const subagentsRunning = Math.max(extras.subtree?.running ?? 0, row.hasRunningRlmChildren === true ? 1 : 0);
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
    progress: extras.labels?.progress ?? "none",
    ...(cost !== undefined ? { cost } : {}),
    ...(working && extras.pulse ? { pulse: extras.pulse } : {}),
    ...(extras.schedule ? { schedule: extras.schedule } : {}),
    ...(extras.chat ? { chat: true, jobs: extras.jobs ?? [], ...(extras.checkIn ? { checkIn: extras.checkIn } : {}) } : {}),
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

export class Catalog {
  readonly client: DaemonClient;
  private summaries = new Map<string, SessionSummary>();
  private childSummaries: SessionSummary[] = [];
  private schedules = new Map<string, ThreadSchedule>();
  /** Called with `daemon_hello.appVersion` after each daemon connect, so a Prime Agent update is seen when the daemon comes back. */
  onDaemonVersion: (version: string | undefined) => void = () => {};
  private readonly listeners = new Set<(event: SessionsEvent) => void>();
  private daemon: "up" | "down" = "down";
  private lastError: string | undefined;
  private subscribed = false;
  /** A session list arrived on the present daemon connection. Until it does, an "up" frame would show an empty sidebar. */
  private listed = false;
  private readonly heldLifecycle = new Map<string, "archived" | "active">();
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private connecting: Promise<void> | undefined;
  private refreshing: Promise<void> | undefined;
  private schedulesRefreshing: Promise<void> | undefined;
  private schedulesTimer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;

  constructor(private readonly socketPath: string, private readonly readState: ChatReadState, private readonly labels: ChatLabels, private readonly chats: Pick<Chats, "ids" | "checkIns">,
    private readonly origins: ThreadOrigins) {
    this.client = new DaemonClient(socketPath);
    this.client.onMessage(message => {
      if (message.type === "roster_update") this.scheduleRefresh();
      if (message.type === "heartbeats_changed") this.scheduleSchedulesRefresh();
    });
    this.client.onClose(error => {
      this.subscribed = false;
      this.listed = false;
      clearTimeout(this.schedulesTimer);
      this.schedulesTimer = undefined;
      this.setDaemon("down", error.message);
      this.scheduleReconnect();
    });
  }

  private setDaemon(state: "up" | "down", error?: string): void {
    const changed = this.daemon !== state || this.lastError !== error;
    this.daemon = state;
    this.lastError = error;
    if (changed && state === "down") void this.emit();
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer || this.listeners.size === 0) return;
    this.reconnectTimer = setTimeout(() => { this.reconnectTimer = undefined; void this.refresh().catch(() => {}); }, 2000);
  }

  async connect(): Promise<void> {
    if (this.closed) throw new Error("Chat catalog is closed");
    if (this.client.isConnected && this.subscribed) return;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      try {
        await this.client.reconnect(1500);
        const hello = await this.client.waitForHello(1500);
        this.onDaemonVersion(hello.appVersion);
        const response = await this.client.request({ type: "roster_subscribe" }, 10000, { recoverable: false });
        if (!response.success) throw new Error(response.error);
        this.subscribed = true;
        this.setDaemon("up");
        this.scheduleSchedulesRefresh(0);
      } catch (error) {
        this.client.resetTransportForReconnect();
        const message = "Prime Agent daemon is not reachable. " + (error instanceof Error ? error.message : String(error));
        this.setDaemon("down", message);
        this.scheduleReconnect();
        throw new Error(message);
      } finally { this.connecting = undefined; }
    })();
    return this.connecting;
  }

  private scheduleRefresh(): void {
    if (this.refreshTimer || this.closed) return;
    this.refreshTimer = setTimeout(() => { this.refreshTimer = undefined; void this.refresh().catch(() => {}); }, 150);
  }

  /** Schedules are a separate native projection: a slow worker never gates session delivery. */
  private scheduleSchedulesRefresh(delay = SCHEDULE_REFRESH_MS): void {
    if (this.closed || this.schedulesTimer || !this.subscribed) return;
    this.schedulesTimer = setTimeout(() => {
      this.schedulesTimer = undefined;
      void this.refreshSchedules();
    }, delay);
    this.schedulesTimer.unref();
  }

  private async refreshSchedules(): Promise<void> {
    if (this.schedulesRefreshing) return this.schedulesRefreshing;
    this.schedulesRefreshing = (async () => {
      try {
        const jobs = await this.client.request({ type: "cron_list" }, 10000, { recoverable: false });
        if (!jobs.success) throw new Error(jobs.error);
        if (this.closed || !this.subscribed) return;
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

  async refresh(): Promise<void> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      await this.connect();
      const response = await this.client.request({ type: "list", all: true }, 30000, { recoverable: false });
      if (!response.success) throw new Error(response.error);
      const next = new Map<string, SessionSummary>();
      const children: SessionSummary[] = [];
      for (const row of parseSummaries(response.data)) {
        if (!isTopLevel(row)) { children.push(row); continue; }
        const existing = next.get(row.sessionId);
        if (!existing || row.activeSessionId !== undefined) next.set(row.sessionId, row);
      }
      this.summaries = next;
      this.childSummaries = children;
      this.listed = true;
      this.setDaemon("up");
      await this.emit();
    })().catch(error => {
      if (!this.closed) {
        this.setDaemon("down", error instanceof Error ? error.message : String(error));
        this.scheduleReconnect();
      }
      throw error;
    }).finally(() => { this.refreshing = undefined; });
    return this.refreshing;
  }

  private async project(): Promise<{ rows: SessionRow[]; tags: SessionsEvent["tags"] }> {
    const [state, labels, chats, checkIns] = await Promise.all([this.readState.snapshot().catch(() => null), this.labels.snapshot().catch(() => null), this.chats.ids().catch(() => null),
      this.chats.checkIns().catch(() => null)]);
    const originOf = await this.origins.resolver(chats ?? new Set());
    const running = runningByParent(this.childSummaries);
    const children = childrenByParent(this.childSummaries);
    const rows = [...this.summaries.values()]
      .filter(row => isListed(row))
      .map(row => {
        const schedule = this.schedules.get(row.sessionId);
        const labelsFor = labels && Object.hasOwn(labels.threads, row.sessionId) ? labels.threads[row.sessionId] : undefined;
        const subtree = subtreeOf(row, children);
        const checkIn = checkIns?.get(row.sessionId);
        return this.applyHeld(row, projectRow(row, state?.sessions[row.sessionId]?.timestamp, state?.baseline ?? 0, {
          ...(labelsFor ? { labels: labelsFor } : {}), ...(schedule ? { schedule } : {}), subtree, origin: originOf(row),
          ...(chats?.has(row.sessionId) ? { chat: true, jobs: chatJobs(children.get(row.sessionId) ?? []), ...(checkIn ? { checkIn } : {}) } : {}),
          ...(isWorking(row, subtree) ? { pulse: sessionPulse(row, running) } : {}) }));
      })
      .sort((left, right) => Date.parse(right.lastActivityAt ?? right.created ?? "") - Date.parse(left.lastActivityAt ?? left.created ?? ""));
    return { rows, tags: labels?.tags ?? [] };
  }

  async rows(): Promise<SessionRow[]> { return (await this.project()).rows; }

  async event(): Promise<SessionsEvent> {
    const { rows, tags } = await this.project();
    return { type: "sessions", sessions: rows, tags, daemon: this.daemon, ...(this.lastError && this.daemon === "down" ? { error: this.lastError } : {}) };
  }

  /** Frames wait for the first session list of a connection: a schedule reply or a notify that lands before it would report "up" with no rows. */
  private async emit(): Promise<void> {
    if (this.listeners.size === 0 || (this.daemon === "up" && !this.listed)) return;
    const event = await this.event();
    for (const listener of [...this.listeners]) listener(event);
  }

  notify(): Promise<void> { return this.emit(); }

  subscribe(listener: (event: SessionsEvent) => void): () => void {
    this.listeners.add(listener);
    void this.refresh().catch(async () => { listener(await this.event()); });
    return () => { this.listeners.delete(listener); };
  }

  /** A top-level thread, else a subagent session, so a child transcript opens read the same way as its parent. */
  async summary(sessionId: string): Promise<SessionSummary | undefined> {
    const cached = this.find(sessionId);
    if (cached) return cached;
    await this.refresh();
    return this.find(sessionId);
  }

  private find(sessionId: string): SessionSummary | undefined {
    const top = this.summaries.get(sessionId);
    if (top) return top;
    const children = this.childSummaries.filter(row => row.sessionId === sessionId);
    return children.find(row => row.activeSessionId !== undefined) ?? children[0];
  }

  /** Native usage cost of each subagent under a parent session, from the daemon summaries of non-top-level sessions. */
  childUsage(parentSessionId: string): ChildUsage[] {
    return this.childSummaries.filter(row => row.parentSessionId === parentSessionId).map(row => ({ sessionId: row.sessionId,
      ...(row.rlmChildId ? { rlmChildId: row.rlmChildId } : {}), ...(row.sessionName ? { sessionName: row.sessionName } : {}),
      ...(row.usage && Number.isFinite(row.usage.cost) ? { cost: row.usage.cost } : {}) }));
  }

  forget(sessionId: string): void { this.summaries.delete(sessionId); }

  /**
   * The row shows this lifecycle until the daemon list agrees (archived: listed as archived with no active session). The daemon scan can lag
   * behind the session file, and the terminal agents view hides a deactivated row the same way until it does.
   */
  holdLifecycle(sessionId: string, lifecycle: "archived" | "active"): void { this.heldLifecycle.set(sessionId, lifecycle); }

  private applyHeld(row: SessionSummary, projected: SessionRow): SessionRow {
    const held = this.heldLifecycle.get(row.sessionId);
    if (!held) return projected;
    const agrees = held === "archived" ? row.lifecycle === "archived" && row.activeSessionId === undefined : row.lifecycle !== "archived";
    if (agrees) { this.heldLifecycle.delete(row.sessionId); return projected; }
    if (held === "active") return { ...projected, archived: false };
    const { pulse: _pulse, ...rest } = projected;
    return { ...rest, archived: true, kind: "saved", status: "saved", working: false, subagentsRunning: 0, unread: false };
  }

  async workspaces(): Promise<Workspace[]> {
    if (this.summaries.size === 0) await this.refresh().catch(() => {});
    const byCwd = new Map<string, Workspace>();
    for (const row of this.summaries.values()) {
      const at = row.lastActivityAt ?? row.modified ?? row.created;
      const entry = byCwd.get(row.cwd) ?? { cwd: row.cwd, count: 0 };
      entry.count++;
      if (at && (!entry.lastUsedAt || at > entry.lastUsedAt)) entry.lastUsedAt = at;
      byCwd.set(row.cwd, entry);
    }
    return [...byCwd.values()].sort((left, right) => (right.lastUsedAt ?? "").localeCompare(left.lastUsedAt ?? "")).slice(0, 30);
  }

  async close(): Promise<void> {
    this.closed = true;
    clearTimeout(this.refreshTimer);
    clearTimeout(this.reconnectTimer);
    clearTimeout(this.schedulesTimer);
    this.listeners.clear();
    this.client.close();
  }
}
