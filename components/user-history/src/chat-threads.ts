import { existsSync } from "node:fs";
import { DaemonAgentConnection, DaemonClient, SessionManager, type SessionSummary } from "prime-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Catalog } from "./chat-catalog.ts";
import { ImageStore, Projector, projectChild, projectInfo, projectModel, sessionUsage } from "./chat-projection.ts";
import type { ChatImage } from "./chat-images.ts";
import { applyThreadEvent, runStartedAtFromMessages, threadStateFromSnapshot } from "./shared/thread-state.ts";
import type { ChatDefaults, Command, ModelCatalog, ProjectedSessionEvent, QueueState, SendMode, ThreadEvent, ThreadInfo, ThreadStats, ThreadSnapshot, ThreadState, ThinkingLevel } from "./shared/types.ts";

type Listener = (event: ThreadEvent) => void;

/** Native session-owned slash commands (prime-agent SESSION_SLASH_COMMAND_NAMES). The session runs them from prompt text; getCommands does not list them. */
const SESSION_COMMANDS: Command[] = [
  { name: "compact", description: "Compact the session context; optional instructions focus the summary", argumentHint: "[instructions]", source: "session" },
  { name: "refine", description: "Refine continual harness prompt notes, skills, subagents, and memory", source: "session" },
  { name: "goal", description: "Set or view a persistent goal; supports pause, resume, and clear", argumentHint: "[objective]", source: "session" },
  { name: "autonomous", description: "Set or view autonomous mode", argumentHint: "[status|on|off]", source: "session" },
];
type NativeEvent = Parameters<Parameters<DaemonAgentConnection["subscribe"]>[0]>[0];
type Live = { connection: DaemonAgentConnection; activeSessionId: string; unsubscribe: () => void };

/** The daemon's kill answer when the worker outlived the stop window; the supervisor still finishes the stop. */
const STOP_PENDING = /^Session worker \S+ did not stop/;

export class ThreadError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

class Thread {
  state: ThreadState;
  live: Live | null = null;
  sessionFile: string | undefined;
  readonly listeners = new Set<Listener>();
  touched = Date.now();
  idleSince: number | null = Date.now();
  private pendingUpdate: { timer: ReturnType<typeof setTimeout>; event: ProjectedSessionEvent } | undefined;
  constructor(readonly id: string, snapshot: ThreadSnapshot) { this.state = threadStateFromSnapshot(snapshot); }
  broadcast(event: ThreadEvent): void {
    this.state = applyThreadEvent(this.state, event);
    for (const listener of [...this.listeners]) listener(event);
  }
  coalesce(event: ProjectedSessionEvent, delayMs: number): void {
    if (event.type !== "message_update") { this.flush(); this.broadcast({ type: "event", event }); return; }
    if (this.pendingUpdate) { this.pendingUpdate.event = event; return; }
    this.pendingUpdate = { event, timer: setTimeout(() => this.flush(), delayMs) };
  }
  flush(): void {
    if (!this.pendingUpdate) return;
    const { timer, event } = this.pendingUpdate;
    clearTimeout(timer);
    this.pendingUpdate = undefined;
    this.broadcast({ type: "event", event });
  }
}

const MAX_LIVE = 8;
const MAX_SAVED = 16;
const IDLE_MS = 3 * 60 * 1000;
const UPDATE_COALESCE_MS = 40;

export class ThreadHub {
  readonly images = new ImageStore();
  readonly projector = new Projector(this.images);
  private readonly threads = new Map<string, Thread>();
  private readonly opening = new Map<string, Promise<Thread>>();
  private readonly sweeper: ReturnType<typeof setInterval>;
  private closed = false;

  constructor(private readonly socketPath: string, private readonly catalog: Catalog, private readonly defaults: () => ChatDefaults) {
    this.sweeper = setInterval(() => this.sweep(), 30000);
    this.sweeper.unref();
  }

  private sweep(): void {
    const now = Date.now();
    for (const [id, thread] of this.threads) {
      if (thread.listeners.size === 0 && thread.idleSince !== null && now - thread.idleSince > IDLE_MS) void this.dispose(id);
    }
  }

  private evict(kind: "live" | "saved"): void {
    const candidates = [...this.threads.values()].filter(thread => (thread.live !== null) === (kind === "live") && thread.listeners.size === 0)
      .sort((left, right) => left.touched - right.touched);
    const total = [...this.threads.values()].filter(thread => (thread.live !== null) === (kind === "live")).length;
    const limit = kind === "live" ? MAX_LIVE : MAX_SAVED;
    for (const thread of candidates) {
      if (total - (candidates.indexOf(thread)) <= limit) break;
      void this.dispose(thread.id);
    }
  }

  private async dispose(id: string): Promise<void> {
    const thread = this.threads.get(id);
    if (!thread) return;
    this.threads.delete(id);
    thread.flush();
    if (thread.live) {
      thread.live.unsubscribe();
      await thread.live.connection.dispose().catch(() => {});
      thread.live = null;
    }
  }

  private async summary(id: string): Promise<SessionSummary> {
    const summary = await this.catalog.summary(id);
    if (!summary) throw new ThreadError(404, "This thread is not in the Prime Agent catalog.");
    return summary;
  }

  private async attach(activeSessionId: string): Promise<DaemonAgentConnection> {
    const client = new DaemonClient(this.socketPath);
    try {
      await client.connect(3000);
      await client.waitForHello(3000);
      return await DaemonAgentConnection.attach(client, activeSessionId, { directTransport: false, supportsExtensionUi: false, sendClientEnv: false, ownedSession: false, closeClientOnDispose: true });
    } catch (error) { client.close(); throw error; }
  }

  private async liveSnapshot(connection: DaemonAgentConnection, summary: SessionSummary | undefined): Promise<ThreadSnapshot> {
    const [snapshot, queue] = await Promise.all([connection.getInitialSnapshot(), connection.getQueue()]);
    const messages = this.projector.messages(snapshot.messages);
    const streaming = snapshot.streamingMessage?.role === "assistant" ? this.projector.assistant(snapshot.streamingMessage) : null;
    return { kind: "live", info: projectInfo(snapshot.state, summary), messages, streaming, queue: { steering: [...queue.steering], followUp: [...queue.followUp] },
      children: (snapshot.children ?? []).map(projectChild), tools: [], retry: null,
      runStartedAt: snapshot.state.isStreaming ? runStartedAtFromMessages(messages) : null };
  }

  private savedMessages(summary: SessionSummary): { messages: AgentMessage[]; info: ThreadInfo } {
    if (!summary.sessionFile) throw new ThreadError(409, "This saved thread has no session file.");
    if (!existsSync(summary.sessionFile)) {
      void this.catalog.refresh().catch(() => {});
      throw new ThreadError(404, "The session file for this thread was moved or deleted after Prime Agent scanned it: " + summary.sessionFile);
    }
    const manager = SessionManager.inMemory(summary.cwd);
    manager.setSessionFile(summary.sessionFile);
    if (manager.getSessionId() !== summary.sessionId) throw new ThreadError(409, "The saved thread file changed. Refresh the list.");
    const branch = manager.getBranch();
    const messages = branch.flatMap(entry => entry.type === "message" ? [entry.message] : []);
    let name: string | undefined;
    let thinkingLevel: ThinkingLevel = "off";
    for (const entry of branch) {
      if (entry.type === "session_info" && entry.name?.trim()) name = entry.name;
      if (entry.type === "thinking_level_change") thinkingLevel = entry.thinkingLevel as ThinkingLevel;
    }
    const info: ThreadInfo = { sessionId: summary.sessionId, ...(name ? { name } : {}), cwd: summary.cwd, model: summary.model ? projectModel(summary.model) : null,
      thinkingLevel: summary.thinkingLevel ?? thinkingLevel, availableThinkingLevels: [], isStreaming: false, isCompacting: false, isBashRunning: false, retryAttempt: 0,
      messageCount: messages.length, context: null, usage: sessionUsage(summary.usage), sessionAction: null, queuedActions: 0 };
    return { messages, info };
  }

  private bind(thread: Thread, connection: DaemonAgentConnection, activeSessionId: string): void {
    const unsubscribe = connection.subscribe(event => { void this.onNativeEvent(thread, event); });
    thread.live = { connection, activeSessionId, unsubscribe };
  }

  private async refreshInfo(thread: Thread): Promise<void> {
    const live = thread.live;
    if (!live) return;
    const [state, summary] = await Promise.all([live.connection.getState(), this.catalog.summary(thread.id)]);
    if (thread.live !== live) return;
    thread.broadcast({ type: "info", info: projectInfo(state, summary) });
  }

  private async refreshQueue(thread: Thread): Promise<void> {
    const live = thread.live;
    if (!live) return;
    const queue = await live.connection.getQueue();
    if (thread.live !== live) return;
    thread.broadcast({ type: "queue", queue: { steering: [...queue.steering], followUp: [...queue.followUp] } });
  }

  private async resnapshot(thread: Thread): Promise<void> {
    const live = thread.live;
    if (!live) return;
    const snapshot = await this.liveSnapshot(live.connection, await this.catalog.summary(thread.id));
    if (thread.live !== live) return;
    thread.flush();
    thread.broadcast({ type: "snapshot", snapshot });
  }

  private async onNativeEvent(thread: Thread, event: NativeEvent): Promise<void> {
    try {
      switch (event.type) {
        case "session_event": {
          const projected = this.projector.event(event.event);
          if (projected) thread.coalesce(projected, UPDATE_COALESCE_MS);
          const native = event.event.type;
          if (native === "agent_start" || native === "agent_end" || (native === "message_end" && event.event.message.role === "user")) await this.refreshQueue(thread);
          if (native === "compaction_end" && !event.event.aborted) await this.resnapshot(thread);
          if (native === "agent_end" || native === "compaction_end" || native === "auto_retry_end" || native === "thinking_level_changed" || native === "session_info_changed") await this.refreshInfo(thread);
          return;
        }
        case "session_resynced":
        case "session_replaced":
          await this.resnapshot(thread);
          return;
        case "connection_status":
          thread.broadcast({ type: "status", connection: event.status === "connected" ? "connected" : "reconnecting", ...(event.error ? { error: event.error } : {}) });
          if (event.status === "connected") await this.resnapshot(thread);
          return;
        case "closed":
          thread.broadcast({ type: "status", connection: "closed", ...(event.error ? { error: event.error } : {}) });
          await this.dispose(thread.id);
          this.catalog.forget(thread.id);
          void this.catalog.refresh().catch(() => {});
          return;
        default: return;
      }
    } catch (error) {
      thread.broadcast({ type: "status", connection: thread.state.connection, error: error instanceof Error ? error.message : String(error) });
    }
  }

  async open(id: string): Promise<Thread> {
    if (this.closed) throw new ThreadError(410, "Chat is stopping.");
    const cached = this.threads.get(id);
    if (cached) { cached.touched = Date.now(); return cached; }
    const pending = this.opening.get(id);
    if (pending) return pending;
    const promise = (async () => {
      const started = performance.now();
      const summary = await this.summary(id);
      let thread: Thread;
      const marks: string[] = [];
      const mark = (label: string, from: number) => { marks.push(`${label} ${Math.round(performance.now() - from)}ms`); return performance.now(); };
      let at = mark("catalog", started);
      if (summary.activeSessionId !== undefined) {
        this.evict("live");
        const connection = await this.attach(summary.activeSessionId);
        at = mark("attach", at);
        try {
          thread = new Thread(id, await this.liveSnapshot(connection, summary));
          at = mark("snapshot+project", at);
          this.bind(thread, connection, summary.activeSessionId);
        } catch (error) { await connection.dispose().catch(() => {}); throw error; }
      } else {
        this.evict("saved");
        const { messages, info } = this.savedMessages(summary);
        at = mark("read", at);
        thread = new Thread(id, { kind: "saved", info, messages: this.projector.messages(messages), streaming: null, queue: { steering: [], followUp: [] }, children: [], tools: [], retry: null, runStartedAt: null });
        mark("project", at);
        thread.sessionFile = summary.sessionFile;
      }
      this.threads.set(id, thread);
      process.stderr.write(`open ${id.slice(0, 8)} ${thread.live ? "live" : "saved"} ${thread.state.messages.length} messages: ${marks.join(", ")}, total ${Math.round(performance.now() - started)}ms\n`);
      return thread;
    })().finally(() => { this.opening.delete(id); });
    this.opening.set(id, promise);
    return promise;
  }

  async subscribe(id: string, listener: Listener): Promise<() => void> {
    const thread = await this.open(id);
    thread.listeners.add(listener);
    thread.idleSince = null;
    const { connection: _connection, error: _error, ...snapshot } = thread.state;
    listener({ type: "snapshot", snapshot });
    if (thread.state.connection !== "connected") listener({ type: "status", connection: thread.state.connection, ...(thread.state.error ? { error: thread.state.error } : {}) });
    return () => {
      thread.listeners.delete(listener);
      if (thread.listeners.size === 0) thread.idleSince = Date.now();
    };
  }

  state(id: string): ThreadState | undefined { return this.threads.get(id)?.state; }

  private async requireLive(id: string): Promise<{ thread: Thread; live: Live }> {
    const thread = await this.open(id);
    if (!thread.live) throw new ThreadError(409, "Reply to resume this thread first.");
    return { thread, live: thread.live };
  }

  async resume(id: string): Promise<Thread> {
    const thread = await this.open(id);
    if (thread.live) return thread;
    const summary = await this.summary(id);
    if (summary.activeSessionId === undefined) {
      if (!summary.sessionFile) throw new ThreadError(409, "This thread has no session file to resume.");
      await this.catalog.connect();
      const response = await this.catalog.client.request({ type: "create", lifecycle: "resident", sessionPath: summary.sessionFile, config: {} }, 60000, { recoverable: false });
      if (!response.success) throw new ThreadError(502, response.error);
    }
    await this.catalog.refresh();
    const resumed = await this.summary(id);
    if (resumed.activeSessionId === undefined) throw new ThreadError(502, "Prime Agent did not resume this thread.");
    this.evict("live");
    const connection = await this.attach(resumed.activeSessionId);
    try {
      const snapshot = await this.liveSnapshot(connection, resumed);
      this.bind(thread, connection, resumed.activeSessionId);
      thread.broadcast({ type: "snapshot", snapshot });
    } catch (error) { await connection.dispose().catch(() => {}); throw error; }
    return thread;
  }

  async create(input: { cwd: string; provider?: string; modelId?: string; thinkingLevel?: ThinkingLevel }): Promise<Thread> {
    await this.catalog.connect();
    const response = await this.catalog.client.request({ type: "create", lifecycle: "resident", config: { cwd: input.cwd,
      ...(input.provider && input.modelId ? { provider: input.provider, model: input.modelId } : {}), ...(input.thinkingLevel ? { thinking: input.thinkingLevel } : {}) } }, 60000, { recoverable: false });
    if (!response.success) throw new ThreadError(502, response.error);
    const data = response.data;
    if (typeof data !== "object" || data === null || !("sessionId" in data) || typeof data.sessionId !== "string" || !("activeSessionId" in data) || typeof data.activeSessionId !== "string") {
      throw new ThreadError(502, "Prime Agent returned no session for the new thread.");
    }
    this.evict("live");
    const connection = await this.attach(data.activeSessionId);
    let thread: Thread;
    try {
      thread = new Thread(data.sessionId, await this.liveSnapshot(connection, data as SessionSummary));
      this.bind(thread, connection, data.activeSessionId);
    } catch (error) { await connection.dispose().catch(() => {}); throw error; }
    this.threads.set(thread.id, thread);
    void this.catalog.refresh().catch(() => {});
    return thread;
  }

  async prompt(id: string, input: { message: string; images: ChatImage[]; mode: SendMode }): Promise<void> {
    const thread = await this.resume(id);
    const live = thread.live!;
    if (input.images.length) {
      const state = await live.connection.getState();
      if (!state.model?.input.includes("image")) throw new ThreadError(400, "Choose a model that accepts images.");
    }
    if (input.message.trimStart().startsWith("/")) {
      const invocation = input.message.trimStart().split(/\s/, 1)[0]?.slice(1);
      const commands = await this.commands(id);
      const command = commands.find(command => command.name === invocation);
      if (!command) throw new ThreadError(400, "Unknown slash command. The draft was kept.");
      if (command.source === "extension") throw new ThreadError(400, "Use this extension command in the Prime Agent terminal. Browser dialogs are unavailable.");
    }
    await live.connection.prompt(input.message, { source: "interactive", streamingBehavior: input.mode, queueIfBusy: true, ...(input.images.length ? { images: input.images } : {}) });
    void this.refreshQueue(thread).catch(() => {});
  }

  async abort(id: string): Promise<void> {
    const { live } = await this.requireLive(id);
    const state = await live.connection.getState();
    if (state.isCompacting) await live.connection.abortCompaction();
    if (state.isBashRunning) await live.connection.abortBash();
    if (state.retryAttempt) await live.connection.abortRetry();
    await live.connection.abort();
  }

  /**
   * Archive the way the terminal agents view deactivates an agent (Ctrl+X): tell open tabs, drop this server's own attachment, kill the resident
   * session ("Unknown active session" means it already ended), record the native archived state in its session file, and hide the row at once.
   */
  async archive(id: string): Promise<void> {
    const summary = await this.catalog.summary(id);
    if (!summary) throw new ThreadError(404, "Thread not found.");
    this.threads.get(id)?.broadcast({ type: "status", connection: "closed", error: "This thread was archived." });
    await this.dispose(id);
    if (summary.activeSessionId) {
      await this.catalog.connect();
      const response = await this.catalog.client.request({ type: "kill", activeSessionId: summary.activeSessionId }, 30000, { recoverable: false });
      if (!response.success && !response.error.startsWith("Unknown active session:")) {
        if (!STOP_PENDING.test(response.error)) throw new ThreadError(502, response.error);
        this.finishKill(id, summary.activeSessionId);
      }
    }
    this.setSessionState(summary, "archived");
    this.catalog.holdLifecycle(id, "archived");
    this.catalog.forget(id);
    await this.catalog.refresh();
  }

  /** The supervisor gave up waiting (its graceful window is 2 s) and keeps stopping the worker; if it is still listed a little later, ask once more. */
  private finishKill(id: string, activeSessionId: string): void {
    setTimeout(() => {
      void (async () => {
        await this.catalog.refresh().catch(() => {});
        if ((await this.catalog.summary(id))?.activeSessionId !== activeSessionId) return;
        await this.catalog.client.request({ type: "kill", activeSessionId }, 30000, { recoverable: false }).catch(() => {});
        await this.catalog.refresh().catch(() => {});
      })();
    }, 5000).unref();
  }

  /** Undo an archive: the thread comes back as a saved thread that resumes on the next reply. */
  async unarchive(id: string): Promise<void> {
    const summary = await this.catalog.summary(id);
    if (!summary) throw new ThreadError(404, "Thread not found.");
    this.setSessionState(summary, "active");
    this.catalog.holdLifecycle(id, "active");
    this.catalog.forget(id);
    await this.catalog.refresh();
  }

  /** Skips a file deleted since the listing: SessionManager.open would recreate a stub at the old path. */
  private setSessionState(summary: SessionSummary, status: "archived" | "active"): void {
    if (!summary.sessionFile || !existsSync(summary.sessionFile)) return;
    const manager = SessionManager.open(summary.sessionFile);
    const current = manager.getSessionState()?.status;
    if (status === "archived" ? current !== "archived" : current === "archived") manager.appendSessionState({ status });
  }

  async rename(id: string, name: string): Promise<void> {
    const thread = await this.open(id);
    if (thread.live) { await thread.live.connection.setSessionName(name); await this.refreshInfo(thread); return; }
    if (!thread.sessionFile) throw new ThreadError(409, "This thread has no session file to rename.");
    const owner = [...this.threads.values()].find(candidate => candidate.live) ?? null;
    if (!owner?.live) throw new ThreadError(409, "Open a live thread first, then rename saved threads.");
    await owner.live.connection.renameSavedSession(thread.sessionFile, name);
    thread.broadcast({ type: "info", info: { ...thread.state.info, name } });
    void this.catalog.refresh().catch(() => {});
  }

  async setModel(id: string, provider: string, modelId: string): Promise<void> {
    const { thread, live } = await this.requireLive(id);
    await live.connection.setModel(provider, modelId);
    await this.refreshInfo(thread);
  }

  async setThinking(id: string, level: string): Promise<void> {
    const { thread, live } = await this.requireLive(id);
    const state = await live.connection.getState();
    const nativeLevel = state.availableThinkingLevels.find(value => value === level);
    if (!nativeLevel) throw new ThreadError(400, "Choose an effort level this model supports.");
    await live.connection.setThinkingLevel(nativeLevel);
    await this.refreshInfo(thread);
  }

  async mutateQueue(id: string, input: { lane: "steering" | "followUp"; index: number; expectedText: string; text?: string }): Promise<string> {
    const { thread, live } = await this.requireLive(id);
    const status = await live.connection.mutateQueuedMessage(input.lane, input.index, input.expectedText,
      input.text === undefined ? { type: "delete" } : { type: "replace", text: input.text, lane: input.lane });
    await this.refreshQueue(thread);
    return status;
  }

  async models(id: string | null): Promise<ModelCatalog> {
    return this.withConnection(id, (connection, thread) => this.catalogFrom(connection, thread));
  }

  /** The thread's own connection, or any live one so the new-chat screen and saved threads can read the catalog and commands. */
  private async withConnection<T>(id: string | null, use: (connection: DaemonAgentConnection, thread: Thread | null) => Promise<T>): Promise<T> {
    const thread = id ? await this.open(id) : null;
    const live = thread?.live ?? [...this.threads.values()].find(candidate => candidate.live)?.live ?? null;
    if (live) return use(live.connection, thread?.live ? thread : null);
    const first = (await this.liveSummaries())[0];
    if (!first?.activeSessionId) throw new ThreadError(409, "Open a live thread once so models and commands can load.");
    const connection = await this.attach(first.activeSessionId);
    try { return await use(connection, null); } finally { await connection.dispose().catch(() => {}); }
  }

  private async liveSummaries(): Promise<SessionSummary[]> {
    await this.catalog.refresh();
    const rows = await this.catalog.rows();
    const summaries: SessionSummary[] = [];
    for (const row of rows) if (row.kind === "live") { const summary = await this.catalog.summary(row.id); if (summary?.activeSessionId) summaries.push(summary); }
    return summaries;
  }

  /** A thread reports its own model and effort. With no thread the catalog carries the Prime Agent defaults, which a new session starts with. */
  private async catalogFrom(connection: DaemonAgentConnection, thread: Thread | null): Promise<ModelCatalog> {
    const [catalog, state] = await Promise.all([connection.getModelCatalog(), connection.getState()]);
    const models = catalog.models.map(projectModel);
    const shared = { models, configuredProviders: [...catalog.configuredProviders] };
    if (thread) return { ...shared, current: state.model ? projectModel(state.model) : null, thinkingLevel: state.thinkingLevel, availableThinkingLevels: [...state.availableThinkingLevels] };
    const defaults = this.defaults();
    const current = models.find(model => model.provider === defaults.provider && model.id === defaults.modelId) ?? null;
    const availableThinkingLevels = current?.thinkingLevels ?? [];
    return { ...shared, current, thinkingLevel: defaults.thinkingLevel && availableThinkingLevels.includes(defaults.thinkingLevel) ? defaults.thinkingLevel : null, availableThinkingLevels };
  }

  async commands(id: string | null): Promise<Command[]> {
    return this.withConnection(id, async connection => {
      const [commands, resources] = await Promise.all([connection.getCommands(), connection.getResourceSnapshot()]);
      const result: Command[] = [...SESSION_COMMANDS, ...commands.map(({ name, description, source, argumentHint }): Command => ({ name, source, ...(description ? { description } : {}), ...(argumentHint ? { argumentHint } : {}) }))];
      for (const skill of resources.skills) if (!result.some(command => command.source === "skill" && command.name === "skill:" + skill.name)) {
        result.push({ name: "skill:" + skill.name, ...(skill.description ? { description: skill.description } : {}), source: "skill" });
      }
      return result;
    });
  }

  async stats(id: string): Promise<ThreadStats> {
    const { live } = await this.requireLive(id);
    const stats = await live.connection.getSessionStats();
    return { tokens: { ...stats.tokens }, cost: stats.cost };
  }

  private async rawMessages(id: string): Promise<AgentMessage[]> {
    const thread = await this.open(id);
    if (thread.live) return thread.live.connection.getMessages();
    return this.savedMessages(await this.summary(id)).messages;
  }

  async toolOutput(id: string, toolCallId: string): Promise<{ toolCallId: string; toolName: string; arguments: unknown; output: string; isError: boolean | null }> {
    const messages = await this.rawMessages(id);
    let call: { name: string; arguments: unknown } | undefined;
    let result: { text: string; isError: boolean } | undefined;
    for (const message of messages) {
      if (message.role === "assistant") for (const part of message.content) if (part.type === "toolCall" && part.id === toolCallId) call = { name: part.name, arguments: part.arguments };
      if (message.role === "toolResult" && message.toolCallId === toolCallId) result = { text: message.content.flatMap(part => part.type === "text" ? [part.text] : []).join("\n"), isError: message.isError };
    }
    if (!call && !result) throw new ThreadError(404, "This tool call is not in the thread.");
    return { toolCallId, toolName: call?.name ?? "", arguments: call?.arguments ?? {}, output: result?.text ?? "", isError: result?.isError ?? null };
  }

  async part(id: string, messageIndex: number, partIndex: number): Promise<{ text: string }> {
    const messages = await this.rawMessages(id);
    let seen = -1;
    for (const message of messages) {
      const projected = this.projector.message(message);
      if (!projected) continue;
      seen++;
      if (seen !== messageIndex) continue;
      const content = "content" in message ? message.content : undefined;
      if (typeof content === "string") return { text: content };
      const part = Array.isArray(content) ? content[partIndex] : undefined;
      if (!part) throw new ThreadError(404, "This part is not in the thread.");
      if (part.type === "text") return { text: part.text };
      if (part.type === "thinking") return { text: part.thinking };
      throw new ThreadError(400, "This part has no text.");
    }
    throw new ThreadError(404, "This message is not in the thread.");
  }

  async warm(id: string): Promise<void> { await this.open(id); }

  async close(): Promise<void> {
    this.closed = true;
    clearInterval(this.sweeper);
    await Promise.all([...this.threads.keys()].map(id => this.dispose(id)));
  }
}
