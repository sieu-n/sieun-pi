import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  type AgentSession,
  type AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import { assignIdentity, get as registryGet, registerDormant, unregisterDormant, type AgentEntry } from "@sieun-pi/pi-family/registry";
import { repliedSinceTask } from "../agent-bus/src/state.ts";
import { withPoolRetries } from "../../pi-pool/src/retries.ts";

/** A child's lifecycle. `done` is a run that settled cleanly, and the child stays open for follow-ups until it is deleted. */
export type ChildStatus = "queued" | "running" | "done" | "error" | "cancelled";

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: number;
}

/** What the parent keeps about one direct child. The JSON fields are the child index in `<parent artifact dir>/rlm-children.json`. */
export interface ChildRecord {
  id: string;
  name: string;
  sessionId: string;
  sessionDir: string;
  sessionFile?: string;
  cwd: string;
  model: string;
  thinking: ThinkingLevel;
  depth: number;
  task: string;
  status: ChildStatus;
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  error?: string;
  answerPreview?: string;
  toolUseCount: number;
  lastActivityAt: number;
  progressNote?: string;
  progressAt?: number;
  usage: Usage;
  deleted?: boolean;
}

type Activity = { kind: "waiting" | "writing" | "executing"; tool_name?: string };

interface Live {
  session: AgentSession;
  unsubscribe(): void;
  activity: Activity;
  /** True until the child's terminal notice for its current task went out, so a child that settles twice notifies once. */
  owesNotice: boolean;
  settled: Promise<void>;
  resolveSettled(): void;
}

/** How a child loads its resources. pi-host and tests set a provider; a plain `pi` CLI gets the parent's `-e` paths from argv. */
export type ChildLoaderOptions = Omit<ConstructorParameters<typeof DefaultResourceLoader>[0], "cwd" | "agentDir">;
type ChildLoaderProvider = (parentSessionId: string) => ChildLoaderOptions;

const LOADER_KEY = Symbol.for("sieun-pi.pi-stack.rlm.child-loader");
const CLOSING_KEY = Symbol.for("sieun-pi.pi-stack.rlm.closing");

/** Why a session is closing: pi-host's reason from its `closing` event, or the parent's for a child it closes. */
export type CloseReason = "killed" | "idle_unload" | "shutdown";

function closing(): Map<string, CloseReason> {
  const g = globalThis as unknown as Record<symbol, Map<string, CloseReason> | undefined>;
  return (g[CLOSING_KEY] ??= new Map());
}

export function setClosingReason(sessionId: string, reason: CloseReason | undefined): void {
  if (reason) closing().set(sessionId, reason);
  else closing().delete(sessionId);
}

export function closingReason(sessionId: string): CloseReason | undefined {
  return closing().get(sessionId);
}

const RESUME_TEXT = "[host-restart]\n\nThe session host restarted while you were working. Your Python kernel and its bash() jobs kept running. Continue your task.";
const CHILDREN_KEY = Symbol.for("sieun-pi.pi-stack.rlm.children");
const SELF = resolve(import.meta.dirname, "..", "index.ts");
const NOTE_INTERVAL_MS = 10_000;
const PREVIEW = 2000;

export function setChildLoaderOptions(provider: ChildLoaderProvider | undefined): void {
  const g = globalThis as unknown as Record<symbol, ChildLoaderProvider | undefined>;
  if (provider) g[LOADER_KEY] = provider;
  else delete g[LOADER_KEY];
}

function argvExtensions(): string[] {
  const out: string[] = [];
  const argv = process.argv;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if ((a === "-e" || a === "--extension") && argv[i + 1]) out.push(resolve(argv[++i]!));
    else if (a.startsWith("--extension=")) out.push(resolve(a.slice("--extension=".length)));
  }
  return out;
}

function childLoaderOptions(parentSessionId: string): ChildLoaderOptions {
  const provider = (globalThis as unknown as Record<symbol, ChildLoaderProvider | undefined>)[LOADER_KEY];
  const base = provider ? provider(parentSessionId) : { additionalExtensionPaths: argvExtensions() };
  const paths = base.additionalExtensionPaths ?? [];
  const hasSelf = paths.some(p => resolve(p) === SELF || resolve(p) === resolve(SELF, ".."));
  return { ...base, additionalExtensionPaths: hasSelf || base.extensionFactories?.length ? paths : [...paths, SELF] };
}

/** Every child this process opened, by child session id, so the child's own pi-rlm finds its record for `progress_note`. */
function liveChildren(): Map<string, { record: ChildRecord; owner: ChildManager }> {
  const g = globalThis as unknown as Record<symbol, Map<string, { record: ChildRecord; owner: ChildManager }> | undefined>;
  return (g[CHILDREN_KEY] ??= new Map());
}

export function childRecordOf(sessionId: string): { record: ChildRecord; owner: ChildManager } | undefined {
  return liveChildren().get(sessionId);
}

const zeroUsage = (): Usage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 });

function addUsage(total: Usage, u: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; totalTokens?: number; cost?: { total?: number } } | undefined): void {
  if (!u) return;
  total.input += u.input ?? 0;
  total.output += u.output ?? 0;
  total.cacheRead += u.cacheRead ?? 0;
  total.cacheWrite += u.cacheWrite ?? 0;
  total.totalTokens += u.totalTokens ?? 0;
  total.cost += u.cost?.total ?? 0;
}

function label(name: string): string {
  return name.replace(/[\s,:[\]]+/g, " ").trim();
}

export interface ParentHooks {
  sessionId: string;
  sessionName(): string;
  artifactDir: string;
  /** Written as the child's header.parentSession, which user-history and global-rules read for depth, as Prime writes it. */
  sessionFile?: string;
  agentDir: string;
  cwd: string;
  depth: number;
  maxDepth(): number;
  activeTools(): string[];
  /** Steers the parent with a custom message and starts a run when it is idle. */
  notify(customType: string, content: string, details: unknown): void;
  /** Records child usage on the parent's transcript until upstream Pi has `pi.appendUsage`. */
  attributeUsage(data: unknown): void;
  /** Publishes a change for pi-host's roster. */
  changed(record: ChildRecord): void;
}

export interface SpawnRequest {
  prompt: string;
  name: string;
  model: Model<any>;
  thinking: ThinkingLevel;
}

/**
 * The direct children of one parent session. Children run in this process as their own `AgentSession`s, each with its own kernel, and
 * the index on disk lets a reopened parent list them and wake a closed one.
 */
export class ChildManager {
  private readonly records = new Map<string, ChildRecord>();
  private readonly live = new Map<string, Live>();
  private readonly indexPath: string;
  /** Children that were running when the last process closed them, to reopen and resume. */
  private readonly interrupted = new Set<string>();

  constructor(private readonly parent: ParentHooks) {
    this.indexPath = join(parent.artifactDir, "rlm-children.json");
    this.load();
  }

  private load(): void {
    if (!existsSync(this.indexPath)) return;
    let rows: ChildRecord[];
    try {
      rows = JSON.parse(readFileSync(this.indexPath, "utf8")) as ChildRecord[];
    } catch {
      return;
    }
    for (const row of rows) {
      if (row.deleted) continue;
      if (row.status === "running" || row.status === "queued") this.interrupted.add(row.id);
      this.records.set(row.id, row);
      this.registerDormantRow(row);
    }
  }

  private save(): void {
    mkdirSync(this.parent.artifactDir, { recursive: true });
    const tmp = `${this.indexPath}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify([...this.records.values()], null, 1));
    renameSync(tmp, this.indexPath);
  }

  private touch(record: ChildRecord): void {
    record.lastActivityAt = Date.now();
    this.parent.changed(record);
  }

  private registerDormantRow(row: ChildRecord): void {
    if (!row.sessionFile) return;
    registerDormant({
      id: row.sessionId,
      name: row.name,
      role: "child",
      parentId: this.parent.sessionId,
      depth: row.depth,
      cwd: row.cwd,
      sessionFile: row.sessionFile,
      firstMessage: row.task.slice(0, 200),
      wake: () => this.wake(row.id),
    });
  }

  /**
   * Reopens every child that was running when the last process closed it and tells it to continue, and reopens every child whose kernel
   * still runs under its relay, so the events that kernel buffered arrive. Each one keeps its own kernel and `bash()` jobs.
   */
  async resumeInterrupted(relaySocket: (record: ChildRecord) => string): Promise<void> {
    for (const record of this.all()) {
      const resume = this.interrupted.has(record.id);
      if (!resume && !existsSync(relaySocket(record))) continue;
      this.interrupted.delete(record.id);
      try {
        await this.wake(record.id);
      } catch (error) {
        if (resume) this.fail(record, error);
        continue;
      }
      const live = this.live.get(record.id);
      if (!resume || !live) continue;
      live.owesNotice = true;
      record.status = "running";
      this.touch(record);
      this.save();
      live.session.sendCustomMessage({ customType: "rlm_resume", content: RESUME_TEXT, display: true }, { triggerTurn: true }).catch(error => this.fail(record, error));
    }
  }

  all(): ChildRecord[] {
    return [...this.records.values()].filter(r => !r.deleted);
  }

  /** Finds one child by child id, session id or unique name. */
  find(selector: string): ChildRecord {
    const rows = this.all();
    const exact = rows.find(r => r.id === selector || r.sessionId === selector);
    if (exact) return exact;
    const named = rows.filter(r => r.name === selector);
    if (named.length === 1) return named[0]!;
    if (named.length > 1) throw new Error(`more than one child is named ${JSON.stringify(selector)}; use its rlm_child_id`);
    throw new Error(`no direct child matches ${JSON.stringify(selector)}`);
  }

  spawn(request: SpawnRequest): ChildRecord {
    if (this.parent.depth >= this.parent.maxDepth()) {
      throw new Error(`rlm.spawn refused: this session is at depth ${this.parent.depth} and RLM_MAX_DEPTH is ${this.parent.maxDepth()}`);
    }
    if (!request.name.trim()) throw new Error("rlm.spawn needs a non-empty name");
    if (this.all().some(r => r.name === request.name)) throw new Error(`a child named ${JSON.stringify(request.name)} already exists; pick another name or delete it first`);
    const id = `sub-${randomBytes(4).toString("hex")}`;
    const sessionDir = join(this.parent.artifactDir, id);
    mkdirSync(sessionDir, { recursive: true });
    const sessionManager = SessionManager.create(this.parent.cwd, sessionDir, this.parent.sessionFile ? { parentSession: this.parent.sessionFile } : undefined);
    const record: ChildRecord = {
      id,
      name: request.name,
      sessionId: sessionManager.getSessionId(),
      sessionDir,
      sessionFile: sessionManager.getSessionFile(),
      cwd: this.parent.cwd,
      model: `${request.model.provider}/${request.model.id}`,
      thinking: request.thinking,
      depth: this.parent.depth + 1,
      task: request.prompt,
      status: "queued",
      createdAt: Date.now(),
      toolUseCount: 0,
      lastActivityAt: Date.now(),
      usage: zeroUsage(),
    };
    this.records.set(id, record);
    this.save();
    void this.open(record, sessionManager, request.model).then(
      live => this.sendTask(record, live, request.prompt),
      error => this.fail(record, error),
    );
    return record;
  }

  private async open(record: ChildRecord, sessionManager: SessionManager, model: Model<any> | undefined): Promise<Live> {
    assignIdentity(record.sessionId, { name: record.name, role: "child", parentId: this.parent.sessionId, depth: record.depth });
    const loader = new DefaultResourceLoader({ cwd: record.cwd, agentDir: this.parent.agentDir, ...childLoaderOptions(this.parent.sessionId) });
    await loader.reload();
    const { session } = await createAgentSession({
      cwd: record.cwd,
      agentDir: this.parent.agentDir,
      resourceLoader: loader,
      sessionManager,
      thinkingLevel: record.thinking,
      ...(model ? { model } : {}),
      tools: this.parent.activeTools(),
    });
    // A retry the pool takes on stays off Pi's retry budget, as in pi-host (pi-pool/src/retries.ts).
    withPoolRetries(session.settingsManager, record.sessionId);
    await session.bindExtensions({});
    const [provider, ...rest] = record.model.split("/");
    const own = session.modelRuntime.getModel(provider!, rest.join("/"));
    if (own && (session.model?.provider !== own.provider || session.model?.id !== own.id)) await session.setModel(own);
    if (!session.model) throw new Error(`child model ${record.model} is not available in the child session`);
    session.setThinkingLevel(record.thinking);
    let resolveSettled!: () => void;
    const live: Live = {
      session,
      activity: { kind: "waiting" },
      owesNotice: false,
      unsubscribe: () => {},
      settled: new Promise(r => (resolveSettled = r)),
      resolveSettled: () => resolveSettled(),
    };
    live.unsubscribe = session.subscribe(event => this.onChildEvent(record, live, event));
    this.live.set(record.id, live);
    liveChildren().set(record.sessionId, { record, owner: this });
    return live;
  }

  private sendTask(record: ChildRecord, live: Live, task: string): void {
    const content = `[task from parent]\n\n${task}`;
    live.owesNotice = true;
    record.status = "running";
    record.startedAt ??= Date.now();
    this.touch(record);
    this.save();
    const details = {
      id: `agentmsg_${randomUUID()}`,
      message: task,
      from: { sessionId: this.parent.sessionId, sessionName: this.parent.sessionName() },
      fromRelationship: "parent",
      target: { sessionId: record.sessionId, sessionName: record.name },
    };
    live.session.sendCustomMessage({ customType: "agent_message", content, display: true, details }, { triggerTurn: true }).catch(error => this.fail(record, error));
  }

  private onChildEvent(record: ChildRecord, live: Live, event: AgentSessionEvent): void {
    switch (event.type) {
      case "agent_start":
        if (record.status !== "running") {
          record.status = "running";
          live.settled = new Promise(r => (live.resolveSettled = r));
        }
        live.activity = { kind: "waiting" };
        this.touch(record);
        return;
      case "message_start":
        if (event.message.role === "assistant") live.activity = { kind: "writing" };
        if (event.message.role === "custom" && event.message.customType === "agent_message") {
          const d = event.message.details as { fromRelationship?: string } | undefined;
          if (d?.fromRelationship === "parent") live.owesNotice = true;
        }
        return;
      case "message_end":
        if (event.message.role === "assistant") {
          addUsage(record.usage, event.message.usage as never);
          this.parent.attributeUsage({
            rlm_child_id: record.id,
            child_session_id: record.sessionId,
            provider: event.message.provider,
            model: event.message.model,
            usage: event.message.usage,
            aggregate: record.usage,
          });
        }
        live.activity = { kind: "waiting" };
        this.touch(record);
        return;
      case "tool_execution_start":
        record.toolUseCount += 1;
        live.activity = { kind: "executing", tool_name: event.toolName };
        this.touch(record);
        return;
      case "tool_execution_end":
        live.activity = { kind: "waiting" };
        return;
      case "agent_settled":
        this.settle(record, live, event.aborted);
        return;
      default:
        return;
    }
  }

  private settle(record: ChildRecord, live: Live, aborted: boolean): void {
    if (record.deleted || record.status === "cancelled" || !this.live.has(record.id)) return;
    const last = [...live.session.messages].reverse().find(m => m.role === "assistant") as { stopReason?: string; errorMessage?: string } | undefined;
    const text = live.session.getLastAssistantText();
    record.answerPreview = text ? text.slice(0, PREVIEW) : undefined;
    record.endedAt = Date.now();
    if (!aborted && last?.stopReason === "error") {
      record.status = "error";
      record.error = last.errorMessage ?? "the child's last model call failed";
    } else {
      record.status = aborted ? "cancelled" : "done";
    }
    this.touch(record);
    this.save();
    live.resolveSettled();
    if (!live.owesNotice) return;
    live.owesNotice = false;
    if (record.status === "error") {
      this.parent.notify("rlm_child_failure", `[child-failed child:${label(record.name)}]\n\n${record.error}`, { rlm_child_id: record.id, sessionName: record.name, error: record.error });
    } else if (!repliedSinceTask(record.sessionId)) {
      const preview = record.answerPreview ? `\n\nLast assistant text: ${record.answerPreview}` : "";
      const kind = record.status === "cancelled" ? "cancelled" : "no-reply";
      this.parent.notify("rlm_child_terminal_notice", `[child-exited: ${kind} child:${label(record.name)}]${preview}`, {
        rlm_child_id: record.id,
        sessionName: record.name,
        kind,
        lastAssistantTextPreview: record.answerPreview,
      });
    }
  }

  private fail(record: ChildRecord, error: unknown): void {
    if (record.deleted) return;
    record.status = "error";
    record.error = error instanceof Error ? error.message : String(error);
    record.endedAt = Date.now();
    this.touch(record);
    this.save();
    this.live.get(record.id)?.resolveSettled();
    this.parent.notify("rlm_child_failure", `[child-failed child:${label(record.name)}]\n\n${record.error}`, { rlm_child_id: record.id, sessionName: record.name, error: record.error });
  }

  /** Reopens a closed child from its session file and resolves once pi-agent-bus registered it. */
  async wake(childId: string): Promise<AgentEntry> {
    const record = this.find(childId);
    if (!this.live.has(record.id)) {
      if (!record.sessionFile || !existsSync(record.sessionFile)) throw new Error(`child ${record.name} has no session file to reopen`);
      const sm = SessionManager.open(record.sessionFile, record.sessionDir, record.cwd);
      await this.open(record, sm, undefined);
    }
    const entry = registryGet(record.sessionId);
    if (!entry) throw new Error(`child ${record.name} reopened, but no agent-bus entry registered it; load pi-agent-bus into children`);
    return entry;
  }

  liveSession(childId: string): AgentSession | undefined {
    return this.live.get(childId)?.session;
  }

  progress(record: ChildRecord, message: string): { accepted: boolean; retry_after_ms?: number } {
    const now = Date.now();
    if (record.progressAt && now - record.progressAt < NOTE_INTERVAL_MS) return { accepted: false, retry_after_ms: NOTE_INTERVAL_MS - (now - record.progressAt) };
    record.progressNote = message;
    record.progressAt = now;
    this.touch(record);
    this.save();
    return { accepted: true };
  }

  row(record: ChildRecord): Record<string, unknown> {
    const live = this.live.get(record.id);
    const status = record.status === "error" ? "error" : record.status === "running" || record.status === "queued" ? "running" : "completed";
    return {
      rlm_child_id: record.id,
      active_session_id: live ? record.sessionId : null,
      session_id: record.sessionId,
      session_name: record.name,
      session_dir: record.sessionDir,
      status,
      activity: live && status === "running" ? live.activity : null,
      tool_use_count: record.toolUseCount,
      duration_ms: record.startedAt ? (record.endedAt ?? Date.now()) - record.startedAt : null,
      answer_preview: record.answerPreview ?? null,
      replied_since_task: repliedSinceTask(record.sessionId),
      progress_note: record.progressNote ?? null,
      last_activity_at: Math.round(record.lastActivityAt),
    };
  }

  result(record: ChildRecord): Record<string, unknown> {
    return {
      rlm_child_id: record.id,
      session_name: record.name,
      session_dir: record.sessionDir,
      status: record.status,
      settled: record.status !== "running" && record.status !== "queued",
      answer_preview: record.answerPreview ?? null,
      error: record.error ?? null,
      duration_ms: record.startedAt ? (record.endedAt ?? Date.now()) - record.startedAt : null,
      tool_use_count: record.toolUseCount,
      replied_since_task: repliedSinceTask(record.sessionId),
    };
  }

  async collect(selectors: string[], timeoutMs: number): Promise<Record<string, unknown>[]> {
    const rows = selectors.length ? selectors.map(s => this.find(s)) : this.all();
    const unsettled = rows.filter(r => r.status === "running" || r.status === "queued");
    if (timeoutMs > 0 && unsettled.length) {
      const waits = unsettled.map(r => this.waitSettled(r));
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([Promise.all(waits), new Promise<void>(r => (timer = setTimeout(r, timeoutMs)))]);
      clearTimeout(timer);
    }
    return rows.map(r => this.result(r));
  }

  private async waitSettled(record: ChildRecord): Promise<void> {
    while (record.status === "running" || record.status === "queued") {
      const live = this.live.get(record.id);
      if (live) await live.settled;
      else await new Promise(r => setTimeout(r, 50));
    }
  }

  /** Cancels and closes one child, writes its tombstone and drops it from messaging. Its files stay on disk. */
  async delete(selector: string): Promise<Record<string, unknown>> {
    const record = this.find(selector);
    const row = this.row(record);
    record.deleted = true;
    if (record.status === "running" || record.status === "queued") record.status = "cancelled";
    this.save();
    unregisterDormant(record.sessionId);
    await this.close(record.id);
    this.parent.changed(record);
    return { ...row, status: record.status === "cancelled" ? "completed" : row.status, active_session_id: null };
  }

  private async close(childId: string): Promise<void> {
    const live = this.live.get(childId);
    if (!live) return;
    this.live.delete(childId);
    const record = this.records.get(childId)!;
    liveChildren().delete(record.sessionId);
    live.unsubscribe();
    try {
      if (live.session.isStreaming) await live.session.abort();
    } catch {}
    // AgentSession.dispose() emits no session_shutdown, which only AgentSessionRuntime sends, so the child's own extensions (its pi-rlm
    // kernel, its pi-agent-bus entry) would never close. Send it here, as the runtime does.
    try {
      const runner = live.session.extensionRunner;
      if (runner.hasHandlers("session_shutdown")) await runner.emit({ type: "session_shutdown", reason: "quit" });
    } catch {}
    live.session.dispose();
    live.resolveSettled();
  }

  /** Closes every open child with the parent, leaving dormant rows so the bus can wake them. A host stop keeps running children running for the next host. */
  async closeAll(reason?: CloseReason): Promise<void> {
    for (const record of this.all()) {
      if ((record.status === "running" || record.status === "queued") && reason !== "shutdown") {
        record.status = "cancelled";
        record.error = "the parent session shut down";
      }
    }
    this.save();
    await Promise.all(
      [...this.live.keys()].map(id => {
        const record = this.records.get(id)!;
        setClosingReason(record.sessionId, reason);
        return this.close(id);
      }),
    );
    for (const record of this.all()) this.registerDormantRow(record);
  }
}
