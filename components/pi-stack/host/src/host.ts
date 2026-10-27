/**
 * pi-host: many Pi `AgentSessionRuntime`s in one Node process, served over the v7 subset in `protocol.ts` and the in-process `HostApi`.
 *
 * A session is keyed by its Pi session id, which is also its v7 `activeSessionId`. Opening one takes a lease on its file (`lease.ts`); `kill`
 * and idle unload dispose the runtime, release the lease and leave a dormant row in `shared/registry.ts`, so any later command, `deliver` or
 * `wake()` reopens it from the file (lazy restore).
 */

import { randomUUID } from "node:crypto";
import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ImageContent } from "@earendil-works/pi-ai";
import {
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  SessionManager,
  type AgentSessionRuntime,
  type CreateAgentSessionRuntimeFactory,
  type CreateAgentSessionServicesOptions,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import * as registry from "../../shared/registry.ts";
import type { AgentEntry, BusMessage, Delivery, Identity } from "../../shared/registry.ts";
import { publishHostApi, type HostApi, type HostEvent, type HostSessionInfo, type OpenRequest } from "./api.ts";
import { Leases, SessionLockedError } from "./lease.ts";
import {
  fail, HOST_COMMANDS, ok, PROTOCOL, unknownCommand, type AttachResult, type ClientCapability, type HostCommand, type Outbound, type ReplayInfo,
  type Response, type RosterEntry, type SavedSessionInfo,
} from "./protocol.ts";
import { HostedSession, modelRef, type Sink } from "./session.ts";

export interface HostOptions {
  agentDir: string;
  /** Where new sessions go. Unset: Pi's per-cwd folder under `<agentDir>/sessions`. */
  sessionDir?: string;
  /** Extension files loaded into every session, such as the pi-stack parts. */
  extensions?: string[];
  /** In-process extensions loaded into every session (tests, probes). */
  extensionFactories?: ExtensionFactory[];
  resourceLoaderOptions?: Omit<NonNullable<CreateAgentSessionServicesOptions["resourceLoaderOptions"]>, "additionalExtensionPaths" | "extensionFactories">;
  /** The model a session gets when the create names none and the session has none. */
  defaultModel?: { provider: string; id: string };
  defaultCwd?: string;
  /** Unload a session idle this long with no client attached. 0 turns idle unload off. */
  idleUnloadMs?: number;
  replayLimit?: number;
  chunkBytes?: number;
  /** Adds `replay: true` to the hello, which a scratch chat serve needs before it passes writes (user-history `src/read-only-daemon.ts`). */
  scratchChatMark?: boolean;
  log?: (line: string) => void;
}

/** One socket client as the host sees it; `server.ts` implements it. */
export interface Connection extends Sink {
  roster: boolean;
}

type SessionCommand = Extract<HostCommand, { activeSessionId: string }>;

const WAKE_MS = 15_000;

function headerCwd(path: string): string | undefined {
  try {
    const fd = openSync(path, "r");
    try {
      const buffer = Buffer.alloc(64 * 1024);
      const read = readSync(fd, buffer, 0, buffer.length, 0);
      const line = buffer.subarray(0, read).toString("utf8").split("\n")[0];
      const header = JSON.parse(line) as { type?: string; cwd?: string };
      return header.type === "session" ? header.cwd : undefined;
    } finally { closeSync(fd); }
  } catch { return undefined; }
}

function saved(info: { path: string; id: string; cwd: string; name?: string; parentSessionPath?: string; created: Date; modified: Date; messageCount: number; firstMessage: string; allMessagesText: string }): SavedSessionInfo {
  return { ...info, created: info.created.toISOString(), modified: info.modified.toISOString() };
}

let busRoute: Promise<{ sendFromClient?: (input: { target: string; message: string; mode?: string; clientId?: string; from?: { id: string; name: string } }) => Promise<unknown> } | undefined> | undefined;
function loadBusRoute() {
  busRoute ??= import(new URL("../../agent-bus/src/route.ts", import.meta.url).href).catch(() => undefined);
  return busRoute;
}

export class PiHost implements HostApi {
  readonly pid = process.pid;
  readonly agentDir: string;
  socketPath?: string;
  readonly generation = randomUUID();
  readonly sessions = new Map<string, HostedSession>();
  readonly leases = new Leases();
  readonly faults: { kind: string; message: string; at: string }[] = [];
  private readonly knownPaths = new Map<string, string>();
  private readonly opening = new Map<string, Promise<HostedSession>>();
  private readonly connections = new Set<Connection>();
  private readonly listeners = new Set<(event: HostEvent) => void>();
  private readonly idleTimer: NodeJS.Timeout | undefined;
  private closing = false;

  constructor(readonly options: HostOptions) {
    this.agentDir = options.agentDir;
    const idle = options.idleUnloadMs ?? 0;
    if (idle > 0) {
      this.idleTimer = setInterval(() => void this.unloadIdle(), Math.max(1000, Math.min(60_000, idle / 4)));
      this.idleTimer.unref();
    }
    publishHostApi(this);
  }

  log(line: string): void {
    (this.options.log ?? (text => process.stderr.write(`${new Date().toISOString()} pi-host ${text}\n`)))(line);
  }

  private emitHost(event: HostEvent): void {
    for (const listener of this.listeners) {
      try { listener(event); } catch (error) { this.log(`host listener threw: ${String(error)}`); }
    }
  }

  onEvent(listener: (event: HostEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // ---- connections and roster ----

  addConnection(connection: Connection): void {
    this.connections.add(connection);
  }

  removeConnection(connection: Connection): void {
    this.connections.delete(connection);
    for (const session of this.sessions.values()) session.sinks.delete(connection.clientId);
  }

  rosterEntry(session: HostedSession): RosterEntry {
    const { streamingMessage: _s, sessionActions: _a, diagnostics: _d, ...summary } = session.summary();
    return { agentId: session.id, status: summary.rosterStatus, summary };
  }

  private broadcastRoster(update: Extract<Outbound, { type: "roster_update" }>): void {
    for (const connection of this.connections) if (connection.roster) connection.write(update);
  }

  // ---- open, restore, kill ----

  list(): HostSessionInfo[] {
    return [...this.sessions.values()].map(session => ({
      sessionId: session.id, sessionFile: session.session.sessionFile, cwd: session.session.sessionManager.getCwd(), name: session.session.sessionName,
      loaded: true, streaming: session.session.isStreaming, attachedClients: session.sinks.size, lastActivityAt: session.lastActivityAt,
    }));
  }

  runtime(sessionId: string): AgentSessionRuntime | undefined {
    return this.sessions.get(sessionId)?.runtime;
  }

  async open(request: OpenRequest): Promise<HostSessionInfo> {
    const session = await this.openSession(request);
    return this.list().find(info => info.sessionId === session.id)!;
  }

  /** Opens a session, or returns the loaded one when `sessionPath` names a file this host already holds. */
  async openSession(request: OpenRequest): Promise<HostedSession> {
    if (this.closing) throw new Error("pi-host is shutting down.");
    if (request.sessionPath) {
      const holder = this.leases.holderOf(request.sessionPath);
      const loaded = holder ? this.sessions.get(holder) : undefined;
      if (loaded) return loaded;
      const pending = this.opening.get(request.sessionPath);
      if (pending) return pending;
    }
    const opening = this.openFresh(request);
    if (request.sessionPath) this.opening.set(request.sessionPath, opening);
    try { return await opening; } finally { if (request.sessionPath) this.opening.delete(request.sessionPath); }
  }

  private async openFresh(request: OpenRequest): Promise<HostedSession> {
    const fallbackCwd = request.cwd ?? this.options.defaultCwd ?? process.cwd();
    let manager: SessionManager;
    if (request.sessionPath) {
      if (!existsSync(request.sessionPath)) throw new Error(`No session file at ${request.sessionPath}.`);
      const saved = headerCwd(request.sessionPath);
      const override = request.cwd ?? (saved && existsSync(saved) ? undefined : fallbackCwd);
      manager = SessionManager.open(request.sessionPath, undefined, override);
    } else {
      manager = SessionManager.create(fallbackCwd, this.options.sessionDir);
    }
    const sessionId = manager.getSessionId();
    const file = manager.getSessionFile();
    const realPath = file ? this.leases.acquire(file, sessionId) : undefined;
    try {
      const identity: Identity = request.identity ?? registry.identityOf(sessionId, request.name ?? sessionId.slice(0, 8));
      registry.assignIdentity(sessionId, identity);
      const runtime = await this.createRuntime(manager, request);
      const session = new HostedSession(runtime, realPath, identity, this.options.replayLimit ?? 2000, (s, line) => this.onSessionLine(s, line));
      this.sessions.set(session.id, session);
      if (file) this.knownPaths.set(session.id, file);
      await runtime.session.bindExtensions({
        onError: error => this.extensionError(session, error),
        shutdownHandler: () => { void this.kill(session.id); },
      });
      if (!runtime.session.model && this.options.defaultModel) {
        const model = runtime.services.modelRuntime.getModel(this.options.defaultModel.provider, this.options.defaultModel.id);
        if (model) await runtime.session.setModel(model);
      }
      if (request.name && request.name !== runtime.session.sessionName) runtime.session.setSessionName(request.name);
      this.emitHost({ type: "opened", sessionId: session.id });
      this.broadcastRoster({ type: "roster_update", changed: [this.rosterEntry(session)] });
      return session;
    } catch (error) {
      this.sessions.delete(sessionId);
      if (realPath) this.leases.release(realPath);
      throw error;
    }
  }

  private async createRuntime(manager: SessionManager, request: OpenRequest): Promise<AgentSessionRuntime> {
    const flags = new Map(Object.entries(request.extensionFlagValues ?? {}));
    const options = this.options;
    const factory: CreateAgentSessionRuntimeFactory = async ({ cwd, agentDir, sessionManager, sessionStartEvent }) => {
      const services = await createAgentSessionServices({
        cwd, agentDir, extensionFlagValues: flags,
        resourceLoaderOptions: { ...options.resourceLoaderOptions, additionalExtensionPaths: options.extensions ?? [], extensionFactories: options.extensionFactories ?? [] },
      });
      const model = request.provider && request.model ? services.modelRuntime.getModel(request.provider, request.model) : undefined;
      if (request.provider && request.model && !model) throw new Error(`Unknown model ${request.provider}/${request.model}.`);
      const created = await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, model, thinkingLevel: request.thinking });
      return { ...created, services, diagnostics: services.diagnostics };
    };
    return createAgentSessionRuntime(factory, { cwd: manager.getCwd(), agentDir: this.agentDir, sessionManager: manager });
  }

  private extensionError(session: HostedSession, error: { extensionPath: string; event: string; error: string; stack?: string }): void {
    this.log(`extension error in ${session.id.slice(0, 8)}: ${error.extensionPath} ${error.event}: ${error.error}`);
    const line: Outbound = { type: "extension_error", activeSessionId: session.id, extensionPath: error.extensionPath, event: error.event, error: error.error };
    for (const sink of session.sinks.values()) sink.write(line);
  }

  private onSessionLine(session: HostedSession, line: { event: { type: string; [key: string]: unknown } }): void {
    this.emitHost({ type: "session_event", sessionId: session.id, event: line.event });
    const type = line.event.type;
    if (type === "agent_start" || type === "agent_end" || type === "session_info_changed" || type === "compaction_start" || type === "compaction_end") {
      this.broadcastRoster({ type: "roster_update", changed: [this.rosterEntry(session)] });
    }
  }

  async sessionPath(sessionId: string): Promise<string | undefined> {
    const loaded = this.sessions.get(sessionId)?.session.sessionFile;
    if (loaded) return loaded;
    const known = this.knownPaths.get(sessionId) ?? registry.dormantOf(sessionId)?.sessionFile;
    if (known) return known;
    const roots = [this.options.sessionDir, join(this.agentDir, "sessions")].filter((dir): dir is string => Boolean(dir && existsSync(dir)));
    for (const root of roots) {
      const stack = [root];
      while (stack.length) {
        const dir = stack.pop()!;
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          if (entry.isDirectory()) stack.push(join(dir, entry.name));
          else if (entry.name.endsWith(`${sessionId}.jsonl`)) {
            const path = join(dir, entry.name);
            this.knownPaths.set(sessionId, path);
            return path;
          }
        }
      }
    }
    return undefined;
  }

  async restore(sessionIdOrPath: string): Promise<AgentSessionRuntime> {
    return (await this.ensure(sessionIdOrPath)).runtime;
  }

  /** The loaded session, or the one reopened from its file. */
  async ensure(sessionIdOrPath: string): Promise<HostedSession> {
    const loaded = this.sessions.get(sessionIdOrPath);
    if (loaded) return loaded;
    const path = sessionIdOrPath.endsWith(".jsonl") ? sessionIdOrPath : await this.sessionPath(sessionIdOrPath);
    if (!path) throw new Error(`Unknown session ${sessionIdOrPath}: pi-host has no loaded session or session file with that id.`);
    const dormantRow = registry.dormantOf(sessionIdOrPath);
    return this.openSession({ sessionPath: path, ...(dormantRow ? { identity: { name: dormantRow.name, role: dormantRow.role, parentId: dormantRow.parentId, depth: dormantRow.depth } } : {}) });
  }

  async kill(sessionId: string, reason: "killed" | "idle_unload" | "shutdown" = "killed"): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.sessions.delete(sessionId);
    const file = session.session.sessionFile;
    const sinks = [...session.sinks.values()];
    const firstMessage = session.summary().firstMessage;
    try { await session.dispose(); } catch (error) { this.log(`dispose ${sessionId.slice(0, 8)} threw: ${String(error)}`); }
    if (session.realPath) this.leases.release(session.realPath);
    for (const sink of sinks) sink.write({ type: "session_closed", activeSessionId: sessionId, reason: reason === "shutdown" ? "shutdown" : "killed" });
    if (file && reason !== "shutdown") this.registerDormant(session, file, firstMessage);
    this.emitHost({ type: "closed", sessionId, reason });
    if (reason !== "shutdown") this.broadcastRoster({ type: "roster_update", changed: [], removed: [sessionId] });
  }

  private registerDormant(session: HostedSession, file: string, firstMessage: string | undefined): void {
    const { name, role, parentId, depth } = session.identity;
    registry.registerDormant({
      id: session.id, name: session.session.sessionName ?? name, role, parentId, depth, cwd: session.session.sessionManager.getCwd(), sessionFile: file, firstMessage,
      wake: () => this.wake(session.id),
    });
  }

  /** Reopens a dormant session and resolves with the registry entry its extensions register (pi-agent-bus registers at `session_start`). */
  private async wake(sessionId: string): Promise<AgentEntry> {
    const present = registry.get(sessionId);
    if (present) return present;
    const registered = new Promise<AgentEntry>((resolve, reject) => {
      const timer = setTimeout(() => { stop(); reject(new Error(`Session ${sessionId} opened but nothing registered it within ${WAKE_MS / 1000} s.`)); }, WAKE_MS);
      const stop = registry.onChange(event => {
        const entry = event.type === "registered" && event.id === sessionId ? registry.get(sessionId) : undefined;
        if (entry) { clearTimeout(timer); stop(); resolve(entry); }
      });
    });
    registered.catch(() => {});
    await this.ensure(sessionId);
    return registry.get(sessionId) ?? registered;
  }

  private async unloadIdle(): Promise<void> {
    const limit = this.options.idleUnloadMs ?? 0;
    const now = Date.now();
    for (const session of [...this.sessions.values()]) {
      if (session.busy || session.sinks.size > 0 || session.session.pendingMessageCount > 0) continue;
      if (registry.childrenOf(session.id).some(child => child.activity() === "working")) continue;
      if (now - session.lastActivityAt < limit) continue;
      this.log(`idle unload ${session.id.slice(0, 8)} after ${Math.round((now - session.lastActivityAt) / 1000)} s`);
      await this.kill(session.id, "idle_unload");
    }
  }

  // ---- input ----

  /** Starts or queues a prompt and resolves once Pi accepted it, without waiting for the run. */
  startPrompt(session: HostedSession, text: string, options: { images?: ImageContent[]; streamingBehavior?: "steer" | "followUp"; source?: string; expandPromptTemplates?: boolean } = {}): Promise<string> {
    return new Promise((resolve, reject) => {
      let accepted = false;
      session.session.prompt(text, {
        images: options.images, streamingBehavior: options.streamingBehavior, expandPromptTemplates: options.expandPromptTemplates,
        source: options.source as never,
        preflightResult: disposition => { accepted = true; resolve(disposition); },
      }).then(() => { if (!accepted) resolve("handled"); }, error => {
        if (!accepted) reject(error);
        else this.log(`run in ${session.id.slice(0, 8)} failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    });
  }

  async deliver(targetId: string, message: BusMessage): Promise<Delivery> {
    const entry = registry.get(targetId);
    if (entry) return entry.deliver(message);
    const session = await this.ensure(targetId);
    const woke = registry.get(targetId);
    if (woke) return woke.deliver(message);
    return this.deliverDirect(session, message);
  }

  /** The host's own delivery for a session with no registry entry: idle gets `prompt`, busy gets `steer`, or `followUp` for `follow_up`. */
  async deliverDirect(session: HostedSession, message: BusMessage): Promise<Delivery> {
    const fromAgent = message.from.role === "root" || message.from.role === "child";
    const text = fromAgent ? `Message from ${message.from.name} (${message.from.id}):\n\n${message.text}` : message.text;
    if (!session.session.isStreaming) {
      const disposition = await this.startPrompt(session, text, { source: fromAgent ? "extension" : "interactive" });
      return disposition === "started" ? "started" : "queued";
    }
    if (message.mode === "follow_up") await session.session.followUp(text);
    else await session.session.steer(text);
    return "queued";
  }

  // ---- commands ----

  private async target(command: SessionCommand): Promise<HostedSession> {
    return this.ensure(command.activeSessionId);
  }

  /** Answers one command. Returns undefined when the handler wrote its own response, as attach does before its snapshot chunks. */
  async handle(command: HostCommand, connection: Connection): Promise<Response | undefined> {
    const id = command.id;
    const type = command.type as string;
    if (!HOST_COMMANDS.has(command.type)) return fail(id, type, unknownCommand(type));
    try {
      return await this.dispatch(command, connection);
    } catch (error) {
      if (error instanceof SessionLockedError) {
        const holder = error.inHost ? error.holder?.sessionId : undefined;
        return fail(id, type, error, error.inHost
          ? { code: "session_already_active", sessionPath: error.sessionPath, ...(holder ? { activeSessionId: holder } : {}) }
          : { code: "session_locked", sessionPath: error.sessionPath, holderPid: error.holder?.pid });
      }
      return fail(id, type, error);
    }
  }

  private async dispatch(command: HostCommand, connection: Connection): Promise<Response | undefined> {
    const id = command.id;
    const done = (data?: unknown) => ok(id, command.type, data);
    switch (command.type) {
      case "list": {
        const sessions = [...this.sessions.values()].map(session => session.summary());
        if (command.all) {
          for (const row of registry.dormant()) {
            if (this.sessions.has(row.id)) continue;
            sessions.push({
              id: row.id, activeSessionId: row.id, sessionId: row.id, sessionFile: row.sessionFile, sessionName: row.name, cwd: row.cwd, lifecycle: "resident",
              activity: "idle", isSessionActive: false, runtimeKind: row.role === "child" ? "subagent" : "top-level", rlmDepth: row.depth, isStreaming: false,
              isCompacting: false, isBashRunning: false, isRunningTools: false, hasRunningRlmChildren: false, attachedClients: 0, messageCount: 0,
              unfinishedActionCount: 0, sessionActions: { queuedCount: 0, steering: [], followUps: [] }, firstMessage: row.firstMessage,
              ...(row.parentId ? { parentSessionId: row.parentId, parentActiveSessionId: row.parentId } : {}),
              rosterStatus: "inactive", workerState: "ready", workerPid: process.pid,
            });
          }
        }
        return done({ sessions });
      }
      case "list_saved_sessions": {
        const cwd = command.cwd ?? (command.activeSessionId ? this.sessions.get(command.activeSessionId)?.session.sessionManager.getCwd() : undefined) ?? this.options.defaultCwd ?? process.cwd();
        const dir = command.sessionDir ?? this.options.sessionDir;
        const progress = (loaded: number, total: number) => { if (id) connection.write({ type: "session_list_progress", id, command: "list_saved_sessions", loaded, total }); };
        const infos = command.scope === "all" ? await SessionManager.listAll(dir, progress) : await SessionManager.list(cwd, dir, progress);
        return done({ sessions: infos.map(saved) });
      }
      case "roster_subscribe": {
        connection.roster = true;
        const response = done({ subscribed: true });
        connection.write(response);
        connection.write({ type: "roster_update", changed: [...this.sessions.values()].map(session => this.rosterEntry(session)), resync: true });
        return undefined;
      }
      case "roster_unsubscribe":
        connection.roster = false;
        return done({ subscribed: false });
      case "create": {
        const config = command.config ?? {};
        const session = await this.openSession({
          sessionPath: command.sessionPath, cwd: config.cwd, name: command.name, provider: config.provider, model: config.model, thinking: config.thinking,
          extensionFlagValues: config.extensionFlagValues,
        });
        return done(session.summary());
      }
      case "attach":
        return this.attach(command, connection);
      case "detach":
        for (const session of this.sessions.values()) {
          if (!command.activeSessionId || session.id === command.activeSessionId) session.sinks.delete(connection.clientId);
        }
        return done();
      case "kill":
        await this.kill(command.activeSessionId);
        return done({ activeSessionId: command.activeSessionId });
      case "rename":
      case "set_session_name": {
        const session = await this.target(command);
        session.session.setSessionName(command.name);
        this.broadcastRoster({ type: "roster_update", changed: [this.rosterEntry(session)] });
        return done(session.summary());
      }
      case "rename_saved_session": {
        const loaded = this.leases.holderOf(command.sessionPath);
        if (loaded && this.sessions.has(loaded)) {
          this.sessions.get(loaded)!.session.setSessionName(command.name);
          return done();
        }
        const manager = SessionManager.open(command.sessionPath);
        const real = this.leases.acquire(command.sessionPath, manager.getSessionId());
        try { manager.appendSessionInfo(command.name); } finally { this.leases.release(real); }
        return done();
      }
      case "prompt": {
        const session = await this.target(command);
        const images = command.images ?? command.content?.filter((part): part is ImageContent => part.type === "image");
        let behavior = command.streamingBehavior;
        if (session.session.isStreaming && !behavior) {
          if (!command.queueIfBusy) throw new Error("The session is busy. Send with streamingBehavior steer or followUp, or with queueIfBusy.");
          behavior = "followUp";
        }
        const disposition = await this.startPrompt(session, command.message, { images, streamingBehavior: behavior, source: command.source, expandPromptTemplates: command.expandPromptTemplates });
        return done({ disposition, activeSessionId: session.id });
      }
      case "steer":
      case "follow_up": {
        const session = await this.target(command);
        const images = command.images ?? command.content?.filter((part): part is ImageContent => part.type === "image");
        if (!session.session.isStreaming) {
          const disposition = await this.startPrompt(session, command.message, { images });
          return done({ disposition });
        }
        if (command.type === "steer") await session.session.steer(command.message, images);
        else await session.session.followUp(command.message, images);
        return done({ disposition: "queued" });
      }
      case "abort": {
        const session = await this.target(command);
        await session.session.abort();
        return done();
      }
      case "abort_bash": (await this.target(command)).session.abortBash(); return done();
      case "abort_compaction": (await this.target(command)).session.abortCompaction(); return done();
      case "abort_retry": (await this.target(command)).session.abortRetry(); return done();
      case "abort_branch_summary": (await this.target(command)).session.abortBranchSummary(); return done();
      case "clear_queue": return done((await this.target(command)).session.clearQueue());
      case "abort_and_clear_queue": {
        const session = await this.target(command);
        const cleared = session.session.clearQueue();
        await session.session.abort();
        return done(cleared);
      }
      case "resume_queue":
        await this.target(command);
        return done({ resumed: false, reason: "Pi has no input pump to resume." });
      case "append_custom_message": {
        const session = await this.target(command);
        await session.session.sendCustomMessage(command.message);
        return done();
      }
      case "mutate_queued_message":
        return done({ status: await this.mutateQueue(await this.target(command), command) });
      case "send_message":
        return done(await this.sendMessage(command, connection));
      case "get_state":
        return done((await this.target(command)).summary());
      case "get_connection_state":
        return done((await this.target(command)).state());
      case "get_messages":
        return done({ messages: (await this.target(command)).session.messages });
      case "get_queue": {
        const session = await this.target(command);
        return done({ steering: [...session.session.getSteeringMessages()], followUp: [...session.session.getFollowUpMessages()] });
      }
      case "get_session_stats":
        return done((await this.target(command)).session.getSessionStats());
      case "get_commands": {
        const session = await this.target(command);
        const commands = session.session.extensionRunner?.getRegisteredCommands?.() ?? [];
        return done({ commands: commands.map(item => ({ name: item.name, description: item.description, source: "extension" })) });
      }
      case "get_available_models":
      case "get_model_catalog": {
        const session = await this.target(command);
        const models = (await session.runtime.services.modelRuntime.getAvailable()).map(model => modelRef(model)!);
        return done({ models, configuredProviders: [...new Set(models.map(model => model.provider))] });
      }
      case "get_session_header":
        return done((await this.target(command)).session.sessionManager.getHeader());
      case "get_session_context": {
        const session = await this.target(command);
        const model = session.session.model;
        return done({ messages: session.session.messages, thinkingLevel: session.session.thinkingLevel, serviceTier: "auto", model: model ? { provider: model.provider, modelId: model.id } : null });
      }
      case "get_last_assistant_text":
        return done({ text: (await this.target(command)).session.getLastAssistantText() });
      case "get_system_prompt":
        return done({ systemPrompt: (await this.target(command)).session.systemPrompt });
      case "get_rlm_children": {
        const session = await this.target(command);
        return done({ children: session.children(), eventSequence: session.sequence });
      }
      case "wait_for_idle":
        await (await this.target(command)).session.waitForIdle();
        return done();
      case "set_model": {
        const session = await this.target(command);
        const model = session.runtime.services.modelRuntime.getModel(command.provider, command.modelId);
        if (!model) throw new Error(`Unknown model ${command.provider}/${command.modelId}.`);
        await session.session.setModel(model);
        return done(modelRef(model));
      }
      case "set_thinking_level": {
        const session = await this.target(command);
        session.session.setThinkingLevel(command.level as ThinkingLevel);
        return done({ level: session.session.thinkingLevel });
      }
      case "set_steering_mode": (await this.target(command)).session.setSteeringMode(command.mode); return done();
      case "set_follow_up_mode": (await this.target(command)).session.setFollowUpMode(command.mode); return done();
      case "set_auto_compaction": (await this.target(command)).session.setAutoCompactionEnabled(command.enabled); return done();
      case "set_auto_retry": (await this.target(command)).session.setAutoRetryEnabled(command.enabled); return done();
      case "compact":
        return done(await (await this.target(command)).session.compact(command.customInstructions));
      case "reload":
        await (await this.target(command)).session.reload();
        return done();
      case "cancel_rlm_child":
      case "delete_rlm_subagent": {
        await this.target(command);
        const child = registry.get(command.childId) as (AgentEntry & { cancel?: () => Promise<void>; dispose?: () => Promise<void> }) | undefined;
        if (!child) throw new Error(`No child ${command.childId} under ${command.activeSessionId}.`);
        if (command.type === "cancel_rlm_child") {
          if (!child.cancel) throw new Error(`Child ${command.childId} has no cancel; pi-rlm supplies it.`);
          await child.cancel();
        } else if (child.dispose) {
          await child.dispose();
        } else {
          registry.unregister(command.childId);
        }
        return done();
      }
      case "cron_list": return done({ jobs: [] });
      case "heartbeats_list": return done({ heartbeats: [] });
      case "heartbeat_get": await this.target(command); return done({ heartbeat: null });
      case "ack_result": return undefined;
      case "shutdown":
        setImmediate(() => void this.shutdown());
        return done();
    }
  }

  private async attach(command: Extract<HostCommand, { type: "attach" }>, connection: Connection): Promise<undefined> {
    const session = await this.target(command);
    const capabilities = [...(command.capabilities ?? [])] as ClientCapability[];
    const has = (capability: ClientCapability) => capabilities.includes(capability);
    const snapshot = session.snapshot();
    const resume = command.resumeCursor;
    const resumeSequence = resume?.sequence ?? resume?.eventSequence;
    let replay: ReplayInfo = { status: "complete", toSequence: session.sequence, toCursor: session.cursor() };
    let replayLines: Outbound[] = [];
    if (resume && resumeSequence !== undefined) {
      const sameGeneration = resume.generation === undefined || resume.generation === session.generation;
      const lines = sameGeneration ? session.replayAfter(resumeSequence) : undefined;
      replay = lines
        ? { status: "complete", fromSequence: resumeSequence, toSequence: session.sequence, toCursor: session.cursor() }
        : { status: "unavailable", fromSequence: resumeSequence, toSequence: session.sequence, toCursor: session.cursor(), reason: sameGeneration ? "replay_buffer_exceeded" : "event_generation_changed" };
      replayLines = lines ?? [];
    }
    const chunkBytes = this.options.chunkBytes ?? 256 * 1024;
    const chunked = has("chunked_snapshot");
    const snapshotId = chunked ? randomUUID() : undefined;
    const result: AttachResult = {
      protocol: PROTOCOL, activeSessionId: session.id,
      ...(has("slim_attach") ? {} : { state: snapshot.summary, messages: snapshot.messages }),
      snapshot: chunked ? { ...snapshot, messages: [] } : snapshot,
      replay, lastEventSequence: snapshot.lastEventSequence, lastEventCursor: snapshot.lastEventCursor,
      ...(snapshotId ? { snapshotStream: { id: snapshotId, messageCount: snapshot.messages.length, targetChunkBytes: chunkBytes } } : {}),
      client: { id: command.clientId ?? connection.clientId, capabilities },
    };
    session.sinks.set(connection.clientId, connection);
    connection.write(ok(command.id, "attach", result));
    if (snapshotId) {
      const { messages, ...rest } = snapshot;
      connection.write({ type: "session_snapshot_begin", activeSessionId: session.id, snapshotId, snapshot: rest, messageCount: messages.length, targetChunkBytes: chunkBytes, purpose: "attach" });
      let index = 0;
      let chunk: typeof messages = [];
      let bytes = 0;
      const flush = () => {
        connection.write({ type: "session_snapshot_chunk", activeSessionId: session.id, snapshotId, index: index++, messages: chunk });
        chunk = [];
        bytes = 0;
      };
      for (const message of messages) {
        const size = JSON.stringify(message).length;
        if (chunk.length > 0 && bytes + size > chunkBytes) flush();
        chunk.push(message);
        bytes += size;
      }
      if (chunk.length > 0 || index === 0) flush();
      connection.write({ type: "session_snapshot_end", activeSessionId: session.id, snapshotId, chunkCount: index, lastEventSequence: snapshot.lastEventSequence, lastEventCursor: snapshot.lastEventCursor });
    }
    for (const line of replayLines) connection.write(line);
    return undefined;
  }

  private async mutateQueue(session: HostedSession, command: Extract<HostCommand, { type: "mutate_queued_message" }>): Promise<"applied" | "rejected" | "invalid"> {
    const steering = [...session.session.getSteeringMessages()];
    const followUp = [...session.session.getFollowUpMessages()];
    const lane = command.lane === "steering" ? steering : followUp;
    if (command.index < 0 || command.index >= lane.length) return "invalid";
    if (lane[command.index] !== command.expectedText) return "rejected";
    const [removed] = lane.splice(command.index, 1);
    if (command.mutation.type === "replace") {
      const target = (command.mutation.lane ?? command.lane) === "steering" ? steering : followUp;
      target.splice(target === lane ? command.index : target.length, 0, command.mutation.text ?? removed);
    }
    session.session.clearQueue();
    for (const text of steering) await session.session.steer(text);
    for (const text of followUp) await session.session.followUp(text);
    return "applied";
  }

  private async sendMessage(command: Extract<HostCommand, { type: "send_message" }>, connection: Connection): Promise<unknown> {
    const target = command.targetActiveSessionId;
    const fromId = command.fromActiveSessionId;
    const fromName = (command as { fromName?: string }).fromName ?? (fromId ? registry.get(fromId)?.name ?? this.sessions.get(fromId)?.identity.name ?? fromId.slice(0, 8) : undefined);
    if (!registry.get(target)) await this.ensure(target);
    const route = registry.get(target) ? await loadBusRoute() : undefined;
    if (route?.sendFromClient) {
      return route.sendFromClient({ target, message: command.message, mode: command.deliveryMode, clientId: connection.clientId, ...(fromId ? { from: { id: fromId, name: fromName! } } : {}) });
    }
    const fromEntry = fromId ? registry.get(fromId) : undefined;
    const message: BusMessage = {
      id: `msg-${randomUUID()}`,
      from: fromId ? { id: fromId, name: fromName!, role: fromEntry?.role ?? "root" } : { id: connection.clientId, name: "owner", role: "owner" },
      text: command.message, mode: command.deliveryMode ?? "auto", sentAt: Date.now(),
    };
    const delivery = await this.deliver(target, message);
    return { targetActiveSessionId: target, delivery, id: message.id };
  }

  // ---- shutdown ----

  /** Tells clients, disposes every runtime (extensions get `session_shutdown`) and releases every lease. Safe to call twice. */
  async shutdown(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    if (this.idleTimer) clearInterval(this.idleTimer);
    for (const connection of this.connections) connection.write({ type: "daemon_closing", reason: "shutdown" });
    await Promise.all([...this.sessions.keys()].map(id => this.kill(id, "shutdown")));
    this.leases.releaseAll();
    publishHostApi(undefined);
  }
}
