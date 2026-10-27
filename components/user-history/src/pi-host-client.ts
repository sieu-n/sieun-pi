import { randomUUID } from "node:crypto";
import { createConnection, type Socket } from "node:net";

/**
 * The chat's own client for pi-host (components/pi-stack/host), which speaks the subset of Prime's v7 daemon JSONL protocol listed in
 * `components/pi-stack/host/src/protocol.ts`. `HostClient` stands in for Prime's `DaemonClient` and `HostAgentConnection` for its
 * `DaemonAgentConnection`, with only the methods the chat calls. src/daemon-sdk.ts picks them when SIEUN_CHAT_BACKEND is "pi-host".
 *
 * Error texts keep Prime's wording ("the Prime Agent daemon is not reachable", "Timed out after ... handshake"), because the chat's retry and
 * fault rules match those texts (chat-threads.ts DAEMON_DOWN, daemon-faults.ts).
 */

export const HOST_PROTOCOL = { name: "prime-agent.daemon", version: 7 } as const;
const REQUEST_TIMEOUT_MS = 30_000;
const SNAPSHOT_TIMEOUT_MS = 30_000;
const RECONNECT_TIMEOUT_MS = 60_000;
const MAX_DEFERRED_EVENTS = 5_000;

type Json = Record<string, unknown>;
export type HostCommandBody = { type: string } & Json;
export type HostResponse = { id?: string; type: "response"; command: string; success: true; data?: unknown } |
  { id?: string; type: "response"; command: string; success: false; error: string; errorInfo?: { code?: string } & Json };
export type HostHello = { type: "daemon_hello"; protocol: { name: string; version: number }; serverCapabilities?: readonly string[]; appVersion?: string; replay?: true } & Json;
export type HostMessage = { type: string } & Json;
export interface HostRequestOptions {
  onProgress?: (message: HostMessage) => void;
  /** Runs before the reader dispatches the lines after this response, so an attach can claim its snapshot stream. */
  onResponse?: (response: HostResponse) => void;
  /** False rejects on a dropped link even when request recovery is on, for a caller with its own retry loop. */
  recoverable?: boolean;
}
export interface HostReconnectOptions {
  recoverDaemon: () => Promise<void>;
  timeoutMs?: number;
  onStatus?: (status: { status: "reconnecting" | "connected" | "failed"; error?: string }) => void;
}

const endpoint = (socketPath: string) => `Socket: ${socketPath}. Host: pi-host.`;
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const isRecord = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);

export class HostSocketClosedError extends Error {
  constructor(socketPath: string, readonly daemonClosingReason?: string, cause?: string) {
    super(`Connection to the Prime Agent daemon closed.${daemonClosingReason ? ` Reason: ${daemonClosingReason}.` : ""}${cause ? ` Cause: ${cause}.` : ""} ${endpoint(socketPath)}`);
    this.name = "DaemonSocketClosedError";
  }
}

/** A failed response as an Error, with the host's `errorInfo.code` on `code`, as Prime's `deserializeDaemonError` gives it. */
export function responseError(response: Extract<HostResponse, { success: false }>): Error & { code?: string; errorInfo?: Json } {
  const error = new Error(response.error) as Error & { code?: string; errorInfo?: Json };
  if (response.errorInfo) { error.errorInfo = response.errorInfo; if (typeof response.errorInfo.code === "string") error.code = response.errorInfo.code; }
  return error;
}

type Pending = { resolve: (response: HostResponse) => void; reject: (error: Error) => void; timeoutMs: number; timer: NodeJS.Timeout | undefined; type: string;
  wire: string; options: HostRequestOptions; parked: boolean };

/** One JSONL socket to pi-host: the hello, correlated requests, and every other line to `onMessage` listeners. */
export class HostClient {
  private socket: Socket | undefined;
  private buffered = "";
  private readonly listeners = new Set<(message: HostMessage) => void>();
  private readonly closeListeners = new Set<(error: Error) => void>();
  private readonly pending = new Map<string, Pending>();
  private readonly helloWaiters = new Set<{ resolve: (hello: HostHello) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private readonly clientId = `pi-host-client:${randomUUID()}`;
  private requestId = 0;
  private helloMessage: HostHello | undefined;
  private closingReason: string | undefined;
  private recovery = false;
  private reconnectOptions: HostReconnectOptions | undefined;
  private autoReconnecting: Promise<void> | undefined;
  private reconnecting: Promise<void> | undefined;
  private closed = false;

  constructor(private readonly socketPath: string) {}

  get hello(): HostHello | undefined { return this.helloMessage; }
  get isConnected(): boolean { return this.socket !== undefined && !this.socket.destroyed; }
  supportsServerCapability(capability: string): boolean { return this.helloMessage?.serverCapabilities?.includes(capability) === true; }

  async waitForHello(timeoutMs = 3000): Promise<HostHello> {
    if (this.helloMessage) return this.helloMessage;
    if (!this.isConnected) throw new Error(`Cannot wait for the Prime Agent daemon handshake because the daemon is not connected. ${endpoint(this.socketPath)}`);
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, timer: setTimeout(() => {
        this.helloWaiters.delete(waiter);
        reject(new Error(`Timed out after ${timeoutMs}ms waiting for the Prime Agent daemon handshake. ${endpoint(this.socketPath)}`));
      }, timeoutMs) };
      this.helloWaiters.add(waiter);
    });
  }

  async connect(timeoutMs = 3000): Promise<void> {
    if (this.socket) throw new Error(`Prime Agent daemon client is already connected. ${endpoint(this.socketPath)}`);
    this.helloMessage = undefined;
    this.closingReason = undefined;
    this.buffered = "";
    const socket = createConnection(this.socketPath);
    this.socket = socket;
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => this.read(socket, chunk));
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { fail(new Error(`Timed out after ${timeoutMs}ms connecting to the Prime Agent daemon. ${endpoint(this.socketPath)}`)); }, timeoutMs);
      const fail = (error: Error) => {
        clearTimeout(timer);
        socket.off("connect", onConnect);
        if (this.socket === socket) this.socket = undefined;
        socket.destroy();
        reject(error);
      };
      const onConnect = () => { clearTimeout(timer); socket.off("error", onError); resolve(); };
      const onError = (error: Error) => fail(new Error(`Failed to connect to the Prime Agent daemon: ${error.message}. ${endpoint(this.socketPath)}`));
      socket.once("connect", onConnect);
      socket.once("error", onError);
    });
    socket.on("error", error => this.dropped(socket, this.closingReason ? new HostSocketClosedError(this.socketPath, this.closingReason, error.message) : error));
    socket.on("close", () => this.dropped(socket, new HostSocketClosedError(this.socketPath, this.closingReason)));
  }

  async reconnect(timeoutMs = 3000): Promise<void> {
    if (this.reconnecting) return this.reconnecting;
    if (this.isConnected) return;
    this.reconnecting = this.connect(timeoutMs).finally(() => { this.reconnecting = undefined; });
    return this.reconnecting;
  }

  disconnectForReconnect(reason: string): void {
    const socket = this.socket;
    if (!socket || socket.destroyed) return;
    this.closingReason = reason;
    this.dropped(socket, new HostSocketClosedError(this.socketPath, reason));
    socket.destroy();
  }

  resetTransportForReconnect(): void {
    const socket = this.socket;
    if (!socket) return;
    this.socket = undefined;
    this.rejectAll(new HostSocketClosedError(this.socketPath, undefined, "reconnect attempt did not complete"), this.recovery);
    socket.destroy();
  }

  onMessage(listener: (message: HostMessage) => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  onClose(listener: (error: Error) => void): () => void { this.closeListeners.add(listener); return () => { this.closeListeners.delete(listener); }; }
  enableRequestRecovery(): void { this.recovery = true; }
  enableAutoReconnect(options: HostReconnectOptions): void { this.recovery = true; this.reconnectOptions = options; }

  async request(command: HostCommandBody, timeoutMs = REQUEST_TIMEOUT_MS, options: HostRequestOptions = {}): Promise<HostResponse> {
    if (!this.isConnected) throw new Error(`Cannot send daemon command "${command.type}" because the Prime Agent daemon is not connected. ${endpoint(this.socketPath)}`);
    const hello = this.helloMessage ?? await this.waitForHello();
    const id = `daemon_${++this.requestId}`;
    const version = Math.min(hello.protocol.version, HOST_PROTOCOL.version);
    const wire = `${JSON.stringify({ type: "command", id, protocol: { name: HOST_PROTOCOL.name, version }, clientId: this.clientId, command: { ...command, id } })}\n`;
    return new Promise((resolve, reject) => {
      const entry: Pending = { resolve, reject, timeoutMs, timer: undefined, type: command.type, wire, options, parked: false };
      this.pending.set(id, entry);
      this.arm(id, entry);
      this.socket!.write(wire);
    });
  }

  close(): void {
    this.closed = true;
    this.reconnectOptions = undefined;
    this.rejectAll(new Error(`Prime Agent daemon client closed before the operation completed. ${endpoint(this.socketPath)}`));
    const socket = this.socket;
    this.socket = undefined;
    socket?.end();
    socket?.destroy();
  }

  private arm(id: string, entry: Pending): void {
    entry.timer = setTimeout(() => {
      this.pending.delete(id);
      entry.reject(new Error(`Timed out after ${entry.timeoutMs}ms waiting for the Prime Agent daemon response to "${entry.type}". ${endpoint(this.socketPath)}`));
    }, entry.timeoutMs);
  }

  private read(socket: Socket, chunk: string): void {
    if (this.socket !== socket) return;
    this.buffered += chunk;
    let newline: number;
    while ((newline = this.buffered.indexOf("\n")) >= 0) {
      const line = this.buffered.slice(0, newline);
      this.buffered = this.buffered.slice(newline + 1);
      if (line.trim()) this.handleLine(line);
      if (this.socket !== socket) return;
    }
  }

  private handleLine(line: string): void {
    let message: unknown;
    try { message = JSON.parse(line); } catch { return; }
    if (!isRecord(message) || typeof message.type !== "string") return;
    if (message.type === "daemon_hello" && isRecord(message.protocol)) {
      this.helloMessage = message as HostHello;
      for (const waiter of [...this.helloWaiters]) { clearTimeout(waiter.timer); this.helloWaiters.delete(waiter); waiter.resolve(this.helloMessage); }
      for (const [, entry] of this.pending) {
        if (!entry.parked || !this.socket) continue;
        entry.parked = false;
        this.socket.write(entry.wire);
      }
      for (const [id, entry] of this.pending) if (!entry.timer) this.arm(id, entry);
    }
    if (message.type === "daemon_closing" && typeof message.reason === "string") this.closingReason = message.reason;
    const id = typeof message.id === "string" ? message.id : undefined;
    if (message.type === "response" && id) {
      const entry = this.pending.get(id);
      if (entry) {
        clearTimeout(entry.timer);
        this.pending.delete(id);
        try { entry.options.onResponse?.(message as HostResponse); entry.resolve(message as HostResponse); } catch (error) { entry.reject(error as Error); }
        return;
      }
    }
    if ((message.type === "session_list_progress" || message.type === "session_list_item") && id) {
      const entry = this.pending.get(id);
      if (entry) { entry.options.onProgress?.(message as HostMessage); return; }
    }
    for (const listener of [...this.listeners]) {
      try { listener(message as HostMessage); } catch { /* one listener's failure leaves the others and the reader running */ }
    }
  }

  private rejectAll(error: Error, park = false): void {
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.timer = undefined;
      if (park && entry.options.recoverable !== false) { entry.parked = true; continue; }
      this.pending.delete(id);
      entry.reject(error);
    }
    for (const waiter of [...this.helloWaiters]) { clearTimeout(waiter.timer); this.helloWaiters.delete(waiter); waiter.reject(error); }
  }

  private dropped(socket: Socket, error: Error): void {
    if (this.socket !== socket) return;
    this.socket = undefined;
    this.rejectAll(error, this.recovery);
    for (const listener of [...this.closeListeners]) listener(error);
    if (this.reconnectOptions && !this.closed) void this.autoReconnect(error);
  }

  private autoReconnect(cause: Error): Promise<void> {
    if (this.autoReconnecting) return this.autoReconnecting;
    const options = this.reconnectOptions!;
    options.onStatus?.({ status: "reconnecting", error: cause.message });
    this.autoReconnecting = (async () => {
      const deadline = Date.now() + (options.timeoutMs ?? RECONNECT_TIMEOUT_MS);
      let last = cause;
      for (let attempt = 0; !this.closed && this.reconnectOptions === options && Date.now() < deadline; attempt++) {
        try {
          await options.recoverDaemon();
          await this.connect(1000);
          await this.waitForHello(3000);
          options.onStatus?.({ status: "connected" });
          return;
        } catch (error) {
          last = error instanceof Error ? error : new Error(String(error));
          this.resetTransportForReconnect();
          await delay(Math.min(2000, 100 * 2 ** Math.min(attempt, 5)));
        }
      }
      if (this.closed || this.reconnectOptions !== options) return;
      const failure = new Error(`Daemon reconnection failed: ${last.message}`);
      this.rejectAll(failure);
      options.onStatus?.({ status: "failed", error: failure.message });
      this.reconnectOptions = undefined;
    })().finally(() => { this.autoReconnecting = undefined; });
    return this.autoReconnecting;
  }
}

export interface HostConnectionOptions {
  closeClientOnDispose?: boolean;
  /** Hold session events from the attach until `flushBufferedSessionEvents`, so the first render uses the attach snapshot as it came. */
  deferSessionEvents?: boolean;
  /** Reattach after a dropped link, calling this before each try; without it a dropped link ends the connection with `closed`. */
  recoverDaemon?: () => Promise<void>;
  reconnectTimeoutMs?: number;
  snapshotTimeoutMs?: number;
  supportsExtensionUi?: boolean;
  directTransport?: boolean;
  sendClientEnv?: boolean;
  ownedSession?: boolean;
}

type Cursor = { generation: string; sequence: number };
type WireSnapshot = { activeSessionId: string; summary: Json & { streamingMessage?: unknown }; state: Json; messages: unknown[]; lastEventSequence: number;
  lastEventCursor: Cursor; children?: unknown[] };
export type HostSnapshot = { state: Json; messages: unknown[]; streamingMessage?: unknown; children?: unknown[]; lastEventSequence: number; lastEventCursor: Cursor };
export type HostConnectionEvent = { type: "session_event"; event: HostMessage } | { type: "session_resynced"; snapshot: HostSnapshot } |
  { type: "connection_status"; status: "reconnecting" | "connected"; error?: string } | { type: "closed"; error?: string } | { type: "heartbeats_changed" } |
  { type: "extension_error"; extensionPath: string; event: string; error: string };
type Assembly = { begin?: { messageCount: number; snapshot: Omit<WireSnapshot, "messages"> }; chunks: Map<number, unknown[]>;
  resolve: (snapshot: WireSnapshot) => void; reject: (error: Error) => void; promise: Promise<WireSnapshot> };

const toSnapshot = (wire: WireSnapshot): HostSnapshot => ({ state: wire.state, messages: wire.messages,
  ...(wire.summary?.streamingMessage ? { streamingMessage: wire.summary.streamingMessage } : {}), ...(wire.children ? { children: wire.children } : {}),
  lastEventSequence: wire.lastEventSequence, lastEventCursor: wire.lastEventCursor });

/** One attached session on a `HostClient`: its snapshot, its event stream in sequence order, and the session's commands. */
export class HostAgentConnection {
  private readonly listeners = new Set<(event: HostConnectionEvent) => void | Promise<void>>();
  private readonly assemblies = new Map<string, Assembly>();
  private readonly clientId = `pi-host-connection:${randomUUID()}`;
  private cursor: Cursor | undefined;
  private latest: HostSnapshot | undefined;
  private fresh = false;
  private deferring: boolean;
  private deferred: { event: HostMessage; cursor?: Cursor }[] = [];
  private overflowed = false;
  private closedEmitted = false;
  private disposed = false;
  private reattaching: Promise<void> | undefined;
  private hostStopping = false;
  private readonly offMessage: () => void;
  private readonly offClose: () => void;

  constructor(private readonly client: HostClient, private activeSessionId: string, private readonly options: HostConnectionOptions = {}) {
    this.deferring = options.deferSessionEvents === true;
    this.offMessage = client.onMessage(message => { void this.onHostMessage(message); });
    this.offClose = client.onClose(error => { void this.onDropped(error); });
  }

  static async attach(client: HostClient, activeSessionId: string, options: HostConnectionOptions = {}): Promise<HostAgentConnection> {
    const connection = new HostAgentConnection(client, activeSessionId, options);
    try { await connection.attach(); } catch (error) { connection.offMessage(); connection.offClose(); throw error; }
    return connection;
  }

  async attach(options: { recoverable?: boolean } = {}): Promise<void> {
    if (this.disposed) throw new Error("Daemon session closed during attach");
    let stream: Promise<WireSnapshot> | undefined;
    const result = await this.data<{ activeSessionId: string; snapshot: WireSnapshot; snapshotStream?: { id: string } }>({
      type: "attach", activeSessionId: this.activeSessionId, supportsExtensionUi: false, clientId: this.clientId,
      capabilities: ["attach_snapshot", "event_sequence", "slim_attach", "chunked_snapshot"],
    }, undefined, { ...options, onResponse: response => {
      const data = response.success ? response.data as { snapshotStream?: { id: string } } : undefined;
      if (data?.snapshotStream) stream = this.assembly(data.snapshotStream.id).promise;
    } });
    this.activeSessionId = result.activeSessionId ?? this.activeSessionId;
    const wire = stream ? await this.timed(stream, result.snapshotStream!.id) : result.snapshot;
    this.apply(wire);
  }

  subscribe(listener: (event: HostConnectionEvent) => void | Promise<void>): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  async getInitialSnapshot(): Promise<HostSnapshot> {
    if (this.fresh && this.latest) return this.latest;
    const [state, messages] = await Promise.all([this.getState(), this.getMessages()]);
    return { ...(this.latest ?? { lastEventSequence: 0, lastEventCursor: { generation: "", sequence: 0 } }), state, messages,
      ...(this.cursor ? { lastEventSequence: this.cursor.sequence, lastEventCursor: this.cursor } : {}) };
  }

  async flushBufferedSessionEvents(): Promise<void> {
    if (!this.deferring) return;
    this.deferring = false;
    const held = this.deferred;
    this.deferred = [];
    if (this.overflowed) {
      this.overflowed = false;
      await this.resync();
      return;
    }
    for (const { event } of held) await this.emit({ type: "session_event", event });
  }

  getState(): Promise<Json> { return this.data({ type: "get_connection_state", activeSessionId: this.activeSessionId }); }
  async getMessages(): Promise<unknown[]> { return (await this.data<{ messages: unknown[] }>({ type: "get_messages", activeSessionId: this.activeSessionId })).messages; }
  getQueue(): Promise<{ steering: string[]; followUp: string[] }> { return this.data({ type: "get_queue", activeSessionId: this.activeSessionId }); }
  async getRlmChildSnapshots(): Promise<unknown[]> { return (await this.data<{ children: unknown[] }>({ type: "get_rlm_children", activeSessionId: this.activeSessionId })).children; }
  getSessionStats(): Promise<Json> { return this.data({ type: "get_session_stats", activeSessionId: this.activeSessionId }); }
  getModelCatalog(): Promise<{ models: Json[]; configuredProviders: string[] }> { return this.data({ type: "get_model_catalog", activeSessionId: this.activeSessionId }); }
  async getAvailableModels(): Promise<Json[]> { return (await this.data<{ models: Json[] }>({ type: "get_available_models", activeSessionId: this.activeSessionId })).models; }
  async getCommands(): Promise<Json[]> { return (await this.data<{ commands: Json[] }>({ type: "get_commands", activeSessionId: this.activeSessionId })).commands; }
  /** pi-host has no resource snapshot command; the chat reads skills and extensions from it, so an empty one stands in. */
  async getResourceSnapshot(): Promise<Json> { return { skills: [], extensions: [], prompts: [], themes: [], contextFiles: [], diagnostics: [] }; }
  async getHeartbeat(): Promise<Json | undefined> {
    return (await this.data<{ heartbeat?: Json | null }>({ type: "heartbeat_get", activeSessionId: this.activeSessionId })).heartbeat ?? undefined;
  }
  async updateHeartbeat(action: unknown): Promise<Json | undefined> {
    return (await this.data<{ heartbeat?: Json | null }>({ type: "heartbeat_update", activeSessionId: this.activeSessionId, action })).heartbeat ?? undefined;
  }
  async getLastAssistantText(): Promise<string | undefined> { return (await this.data<{ text?: string }>({ type: "get_last_assistant_text", activeSessionId: this.activeSessionId })).text; }
  async getSystemPrompt(): Promise<string> { return (await this.data<{ systemPrompt: string }>({ type: "get_system_prompt", activeSessionId: this.activeSessionId })).systemPrompt; }
  async mutateQueuedMessage(lane: string, index: number, expectedText: string, mutation: unknown): Promise<string> {
    if (!this.client.supportsServerCapability("queue_message_mutation")) return "unsupported";
    return (await this.data<{ status: string }>({ type: "mutate_queued_message", activeSessionId: this.activeSessionId, lane, index, expectedText, mutation })).status;
  }
  clearQueue(): Promise<Json> { return this.data({ type: "clear_queue", activeSessionId: this.activeSessionId }); }
  abortAndClearQueue(): Promise<Json> { return this.data({ type: "abort_and_clear_queue", activeSessionId: this.activeSessionId }); }
  async prompt(message: string, options: { images?: unknown[]; streamingBehavior?: "steer" | "followUp"; source?: string } = {}): Promise<void> {
    await this.data({ type: "prompt", activeSessionId: this.activeSessionId, message, ...options });
  }
  async steer(message: string, images?: unknown[]): Promise<void> { await this.data({ type: "steer", activeSessionId: this.activeSessionId, message, ...(images ? { images } : {}) }); }
  async followUp(message: string, images?: unknown[]): Promise<void> { await this.data({ type: "follow_up", activeSessionId: this.activeSessionId, message, ...(images ? { images } : {}) }); }
  async abort(): Promise<void> { await this.data({ type: "abort", activeSessionId: this.activeSessionId }); }
  async abortBash(): Promise<void> { await this.data({ type: "abort_bash", activeSessionId: this.activeSessionId }); }
  async abortCompaction(): Promise<void> { await this.data({ type: "abort_compaction", activeSessionId: this.activeSessionId }); }
  async abortRetry(): Promise<void> { await this.data({ type: "abort_retry", activeSessionId: this.activeSessionId }); }
  async cancelRlmChild(childId: string): Promise<boolean> { await this.data({ type: "cancel_rlm_child", activeSessionId: this.activeSessionId, childId }); return true; }
  async waitForIdle(): Promise<void> { await this.data({ type: "wait_for_idle", activeSessionId: this.activeSessionId }, 24 * 3600_000); }
  async appendCustomMessage(message: Json): Promise<void> { await this.data({ type: "append_custom_message", activeSessionId: this.activeSessionId, message }); }
  setModel(provider: string, modelId: string): Promise<Json> { return this.data({ type: "set_model", activeSessionId: this.activeSessionId, provider, modelId }); }
  async setThinkingLevel(level: string): Promise<void> { await this.data({ type: "set_thinking_level", activeSessionId: this.activeSessionId, level }); }
  async setSteeringMode(mode: string): Promise<void> { await this.data({ type: "set_steering_mode", activeSessionId: this.activeSessionId, mode }); }
  async setFollowUpMode(mode: string): Promise<void> { await this.data({ type: "set_follow_up_mode", activeSessionId: this.activeSessionId, mode }); }
  async setAutoCompactionEnabled(enabled: boolean): Promise<void> { await this.data({ type: "set_auto_compaction", activeSessionId: this.activeSessionId, enabled }); }
  async setAutoRetryEnabled(enabled: boolean): Promise<void> { await this.data({ type: "set_auto_retry", activeSessionId: this.activeSessionId, enabled }); }
  compact(customInstructions?: string): Promise<Json> {
    return this.data({ type: "compact", activeSessionId: this.activeSessionId, ...(customInstructions ? { customInstructions } : {}) }, 30 * 60_000);
  }
  async reload(): Promise<void> { await this.data({ type: "reload", activeSessionId: this.activeSessionId }, 120_000); }
  async setSessionName(name: string): Promise<void> { await this.data({ type: "set_session_name", activeSessionId: this.activeSessionId, name }); }
  async renameSavedSession(sessionPath: string, name: string): Promise<void> {
    await this.data({ type: "rename_saved_session", activeSessionId: this.activeSessionId, sessionPath, name });
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    for (const [, assembly] of this.assemblies) assembly.reject(new Error("The connection closed before its snapshot arrived"));
    this.assemblies.clear();
    try { if (this.client.isConnected) await this.client.request({ type: "detach", activeSessionId: this.activeSessionId }, 5000, { recoverable: false }); } catch { /* the link is gone, so nothing is attached */ }
    this.offMessage();
    this.offClose();
    this.listeners.clear();
    if (this.options.closeClientOnDispose) this.client.close();
  }

  private async data<T = Json>(command: HostCommandBody, timeoutMs?: number, options?: HostRequestOptions): Promise<T> {
    const response = await this.client.request(command, timeoutMs, options);
    if (!response.success) throw responseError(response);
    if (command.type !== "attach" && !command.type.startsWith("get_")) this.fresh = false;
    return response.data as T;
  }

  private assembly(id: string): Assembly {
    let assembly = this.assemblies.get(id);
    if (!assembly) {
      let resolve!: Assembly["resolve"];
      let reject!: Assembly["reject"];
      const promise = new Promise<WireSnapshot>((yes, no) => { resolve = yes; reject = no; });
      promise.catch(() => {});
      assembly = { chunks: new Map(), resolve, reject, promise };
      this.assemblies.set(id, assembly);
    }
    return assembly;
  }

  private timed(promise: Promise<WireSnapshot>, id: string): Promise<WireSnapshot> {
    const ms = this.options.snapshotTimeoutMs ?? SNAPSHOT_TIMEOUT_MS;
    let timer: NodeJS.Timeout | undefined;
    return Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`Snapshot ${id} did not arrive within ${ms}ms`)), ms); })])
      .finally(() => { clearTimeout(timer); this.assemblies.delete(id); });
  }

  private apply(wire: WireSnapshot): void {
    this.cursor = wire.lastEventCursor;
    this.latest = toSnapshot(wire);
    this.fresh = true;
    const cursor = this.cursor;
    this.deferred = this.deferred.filter(held => !held.cursor || held.cursor.generation !== cursor.generation || held.cursor.sequence > cursor.sequence);
  }

  /** True for an event at or before the cursor of this generation, which the snapshot or an earlier line already holds. */
  private stale(cursor: Cursor | undefined): boolean {
    return Boolean(cursor && this.cursor && cursor.generation === this.cursor.generation && cursor.sequence <= this.cursor.sequence);
  }

  private async onHostMessage(message: HostMessage): Promise<void> {
    if (this.disposed || this.closedEmitted) return;
    if (message.type === "heartbeats_changed") { await this.emit({ type: "heartbeats_changed" }); return; }
    if (message.activeSessionId !== this.activeSessionId) return;
    const id = typeof message.snapshotId === "string" ? message.snapshotId : undefined;
    if (message.type === "session_snapshot_begin" && id) {
      this.assembly(id).begin = { messageCount: message.messageCount as number, snapshot: message.snapshot as Omit<WireSnapshot, "messages"> };
      return;
    }
    if (message.type === "session_snapshot_chunk" && id) { this.assembly(id).chunks.set(message.index as number, message.messages as unknown[]); return; }
    if (message.type === "session_snapshot_end" && id) {
      const assembly = this.assembly(id);
      const count = message.chunkCount as number;
      const messages: unknown[] = [];
      for (let index = 0; index < count; index++) {
        const chunk = assembly.chunks.get(index);
        if (!chunk) { assembly.reject(new Error(`Snapshot ${id} is missing chunk ${index}`)); return; }
        messages.push(...chunk);
      }
      if (!assembly.begin) { assembly.reject(new Error(`Snapshot ${id} ended before it began`)); return; }
      assembly.resolve({ ...assembly.begin.snapshot, messages } as WireSnapshot);
      return;
    }
    if (message.type === "session_closed") {
      // A host stop closes every session and then the socket; the drop that follows reattaches, as Prime's connection does after a
      // shutdown (`reconnectAfterShutdown`), so a pi-host restart does not leave each open thread closed until someone presses Retry.
      if (message.reason === "shutdown") { this.hostStopping = true; return; }
      this.closedEmitted = true;
      await this.emit({ type: "closed", error: `Daemon session ${this.activeSessionId} closed: ${String(message.reason ?? "closed")}` });
      return;
    }
    if (message.type === "extension_error") {
      await this.emit({ type: "extension_error", extensionPath: String(message.extensionPath), event: String(message.event), error: String(message.error) });
      return;
    }
    if (message.type !== "session_event" || !isRecord(message.event)) return;
    const cursor = isRecord(message.meta) ? message.meta.cursor as Cursor | undefined : undefined;
    const event = message.event as HostMessage;
    if (this.deferring) {
      if (this.overflowed) return;
      if (this.deferred.length >= MAX_DEFERRED_EVENTS) { this.deferred = []; this.overflowed = true; return; }
      this.deferred.push({ event, ...(cursor ? { cursor } : {}) });
      return;
    }
    if (this.stale(cursor)) return;
    if (cursor) this.cursor = cursor;
    this.fresh = false;
    await this.emit({ type: "session_event", event });
  }

  /** A fresh attach on the same link, whose snapshot goes out as `session_resynced`. */
  private async resync(): Promise<void> {
    await this.attach({ recoverable: false });
    if (this.latest) await this.emit({ type: "session_resynced", snapshot: this.latest });
  }

  private async onDropped(error: Error): Promise<void> {
    if (this.disposed || this.closedEmitted) return;
    const recover = this.options.recoverDaemon ?? (this.hostStopping ? async () => {} : undefined);
    if (!recover) {
      this.closedEmitted = true;
      await this.emit({ type: "closed", error: error.message });
      return;
    }
    if (this.reattaching) return;
    this.reattaching = (async () => {
      await this.emit({ type: "connection_status", status: "reconnecting", error: error.message });
      const deadline = Date.now() + (this.options.reconnectTimeoutMs ?? RECONNECT_TIMEOUT_MS);
      let last = error;
      for (let attempt = 0; !this.disposed && Date.now() < deadline; attempt++) {
        try {
          await recover();
          if (!this.client.isConnected) await this.client.reconnect(1000);
          await this.client.waitForHello(3000);
          await this.resync();
          this.hostStopping = false;
          await this.emit({ type: "connection_status", status: "connected" });
          return;
        } catch (failure) {
          last = failure instanceof Error ? failure : new Error(String(failure));
          this.client.resetTransportForReconnect();
          await delay(Math.min(2000, 100 * 2 ** Math.min(attempt, 5)));
        }
      }
      if (this.disposed) return;
      this.closedEmitted = true;
      await this.emit({ type: "closed", error: `Daemon reconnection failed: ${last.message}` });
    })().finally(() => { this.reattaching = undefined; });
  }

  private async emit(event: HostConnectionEvent): Promise<void> {
    for (const listener of [...this.listeners]) {
      try { await listener(event); } catch { /* a listener's failure leaves the stream running */ }
    }
  }
}
