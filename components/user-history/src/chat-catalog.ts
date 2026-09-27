import { existsSync } from "node:fs";
import { DaemonClient, parseSkillBlock, type SessionSummary } from "prime-agent";
import type { ChatLabels } from "./chat-labels.ts";
import type { ChatReadState } from "./chat-read-state.ts";
import type { ChildPulse, ChildUsage, Pulse, SessionPulse, SessionRow, SessionsEvent, ThreadLabels, ThreadSchedule, Workspace } from "./shared/types.ts";

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

export function previewTitle(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return "New chat";
  const skill = parseSkillBlock(value);
  const text = skill ? skill.userMessage ?? "" : /^\s*<(?:skill|system|instructions)(?:\s|>)/i.test(value) ? "" : value;
  return text.trim().replace(/\s+/g, " ").slice(0, 100) || "New chat";
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

export function isBusySummary(row: SessionSummary): boolean {
  return row.isStreaming || row.isCompacting || row.isBashRunning === true || row.hasRunningRlmChildren === true || row.isRunningTools === true ||
    Boolean(row.sessionActions?.active) || (row.sessionActions?.queuedCount ?? 0) > 0;
}

/** Running subagent summaries by the session id of their parent. */
export function runningByParent(children: readonly SessionSummary[]): Map<string, SessionSummary[]> {
  const map = new Map<string, SessionSummary[]>();
  for (const row of children) {
    if (!row.parentSessionId || !isBusySummary(row)) continue;
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

export interface RowExtras { labels?: ThreadLabels; schedule?: ThreadSchedule; workingSince?: number; pulse?: SessionPulse }

export function projectRow(row: SessionSummary, readMarker: number | undefined, baseline: number, extras: RowExtras = {}): SessionRow {
  const live = row.activeSessionId !== undefined;
  const named = typeof row.sessionName === "string" && row.sessionName.trim().length > 0;
  const lastActivity = Date.parse(row.lastActivityAt ?? row.modified ?? "");
  const finishedAt = Number.isFinite(lastActivity) ? lastActivity : 0;
  const status: SessionRow["status"] = !live ? "saved" : isBusySummary(row) ? "running" : "idle";
  return {
    id: row.sessionId,
    name: named ? row.sessionName!.trim() : previewTitle(row.firstMessage),
    named,
    cwd: row.cwd,
    kind: live ? "live" : "saved",
    status,
    archived: row.lifecycle === "archived",
    ...(row.model ? { model: `${row.model.provider}/${row.model.id}` } : {}),
    ...(row.thinkingLevel ? { thinkingLevel: row.thinkingLevel } : {}),
    ...(row.created ? { created: row.created } : {}),
    ...(row.lastActivityAt ? { lastActivityAt: row.lastActivityAt } : row.modified ? { lastActivityAt: row.modified } : {}),
    messageCount: row.messageCount,
    unread: status !== "running" && row.messageCount > 0 && finishedAt > Math.max(baseline, readMarker ?? 0),
    ...(row.workerState ? { workerState: row.workerState } : {}),
    ...(row.statusLabel ? { statusLabel: row.statusLabel } : {}),
    tags: extras.labels?.tags ?? [],
    priority: extras.labels?.priority ?? 0,
    progress: extras.labels?.progress ?? "none",
    ...(row.usage && Number.isFinite(row.usage.cost) ? { cost: row.usage.cost } : {}),
    ...(status === "running" && extras.workingSince !== undefined ? { workingSince: new Date(extras.workingSince).toISOString() } : {}),
    ...(status === "running" && extras.pulse ? { pulse: extras.pulse } : {}),
    ...(extras.schedule ? { schedule: extras.schedule } : {}),
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
  private readonly workingSince = new Map<string, number>();
  /** The attached thread's native run start, when the browser has that thread open. */
  runStartedAt: (sessionId: string) => number | null = () => null;
  private readonly listeners = new Set<(event: SessionsEvent) => void>();
  private daemon: "up" | "down" = "down";
  private lastError: string | undefined;
  private subscribed = false;
  private readonly heldLifecycle = new Map<string, "archived" | "active">();
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private connecting: Promise<void> | undefined;
  private refreshing: Promise<void> | undefined;
  private closed = false;

  constructor(private readonly socketPath: string, private readonly readState: ChatReadState, private readonly labels: ChatLabels) {
    this.client = new DaemonClient(socketPath);
    this.client.onMessage(message => {
      if (message.type === "roster_update") this.scheduleRefresh();
    });
    this.client.onClose(error => {
      this.subscribed = false;
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
        await this.client.waitForHello(1500);
        const response = await this.client.request({ type: "roster_subscribe" }, 10000, { recoverable: false });
        if (!response.success) throw new Error(response.error);
        this.subscribed = true;
        this.setDaemon("up");
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

  async refresh(): Promise<void> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      await this.connect();
      const [response, jobs] = await Promise.all([
        this.client.request({ type: "list", all: true }, 30000, { recoverable: false }),
        this.client.request({ type: "cron_list" }, 10000, { recoverable: false }).catch(() => null),
      ]);
      if (!response.success) throw new Error(response.error);
      if (jobs?.success) this.schedules = parseSchedules(jobs.data);
      const next = new Map<string, SessionSummary>();
      const children: SessionSummary[] = [];
      for (const row of parseSummaries(response.data)) {
        if (!isTopLevel(row)) { children.push(row); continue; }
        const existing = next.get(row.sessionId);
        if (!existing || row.activeSessionId !== undefined) next.set(row.sessionId, row);
      }
      this.summaries = next;
      this.childSummaries = children;
      await this.emit();
    })().finally(() => { this.refreshing = undefined; });
    return this.refreshing;
  }

  /** Working time starts at the attached thread's native run start, else when this server first saw the session busy. */
  private trackWorking(row: SessionSummary, now: number): number | undefined {
    if (!isBusySummary(row) || row.activeSessionId === undefined) { this.workingSince.delete(row.sessionId); return undefined; }
    const native = this.runStartedAt(row.sessionId);
    const since = Math.min(this.workingSince.get(row.sessionId) ?? now, native ?? now);
    this.workingSince.set(row.sessionId, since);
    return since;
  }

  private async project(): Promise<{ rows: SessionRow[]; tags: SessionsEvent["tags"] }> {
    const [state, labels] = await Promise.all([this.readState.snapshot().catch(() => null), this.labels.snapshot().catch(() => null)]);
    const now = Date.now();
    for (const id of this.workingSince.keys()) if (!this.summaries.has(id)) this.workingSince.delete(id);
    const running = runningByParent(this.childSummaries);
    const rows = [...this.summaries.values()]
      .filter(row => isListed(row))
      .map(row => {
        const schedule = this.schedules.get(row.sessionId);
        const labelsFor = labels && Object.hasOwn(labels.threads, row.sessionId) ? labels.threads[row.sessionId] : undefined;
        const workingSince = this.trackWorking(row, now);
        return this.applyHeld(row, projectRow(row, state?.sessions[row.sessionId]?.timestamp, state?.baseline ?? 0, {
          ...(labelsFor ? { labels: labelsFor } : {}), ...(schedule ? { schedule } : {}), ...(workingSince === undefined ? {} : { workingSince }),
          ...(isBusySummary(row) ? { pulse: sessionPulse(row, running) } : {}) }));
      })
      .sort((left, right) => Date.parse(right.lastActivityAt ?? right.created ?? "") - Date.parse(left.lastActivityAt ?? left.created ?? ""));
    return { rows, tags: labels?.tags ?? [] };
  }

  async rows(): Promise<SessionRow[]> { return (await this.project()).rows; }

  async event(): Promise<SessionsEvent> {
    const { rows, tags } = await this.project();
    return { type: "sessions", sessions: rows, tags, daemon: this.daemon, ...(this.lastError && this.daemon === "down" ? { error: this.lastError } : {}) };
  }

  private async emit(): Promise<void> {
    if (this.listeners.size === 0) return;
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
    const { pulse: _pulse, workingSince: _since, ...rest } = projected;
    return { ...rest, archived: true, kind: "saved", status: "saved", unread: false };
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
    this.listeners.clear();
    this.client.close();
  }
}
