import { DaemonAgentConnection, DaemonClient, SessionManager, defaultDaemonSocketPath, getAgentDir, parseSkillBlock, type SessionSummary } from "prime-agent";
import { join } from "node:path";
import { ChatReadState, type ReadMarker } from "./chat-read-state.ts";
import { listPool, choosePool, type PoolListing } from "./chat-pool.ts";
import { parseChatImages, sanitizeNativeImages, type ChatImage } from "./chat-images.ts";

export interface ChatSession {
  sessionId: string;
  name: string;
  cwd: string;
  status: "running" | "idle" | "saved";
  lifecycle?: SessionSummary["lifecycle"];
  model?: string;
  canSend: boolean;
  created?: string;
  lastActivityAt?: string;
  nativeStatus?: string;
  lastAssistant?: ReadMarker;
  unread?: boolean;
  readError?: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  streaming: boolean;
  images: ChatImage[];
  timestamp?: number;
  outcome?: "error" | "aborted";
  tools?: ChatTool[];
}

type NativeSnapshot = Awaited<ReturnType<DaemonAgentConnection["getInitialSnapshot"]>>;
export type ChatTool = { id: string; name: string; args: unknown; output: string; status: "pending" | "running" | "complete" | "error" | "interrupted"; durationMs?: number; summary: string; revision: string };
export type ChatCommand = Pick<Awaited<ReturnType<DaemonAgentConnection["getCommands"]>>[number], "name" | "description" | "source" | "argumentHint">;
export type ChatWork = Pick<NativeState, "isStreaming" | "isCompacting" | "isBashRunning" | "retryAttempt" | "recap"> & { startedAt: number | null; childCount: number; label: string };
type NativeModel = Awaited<ReturnType<DaemonAgentConnection["setModel"]>>;
type NativeState = Awaited<ReturnType<DaemonAgentConnection["getState"]>>;
type NativeQueue = Awaited<ReturnType<DaemonAgentConnection["getQueue"]>>;
type NativeUsageSummary = NonNullable<SessionSummary["usage"]>;
type ChatContextUsage = NonNullable<NativeState["contextUsage"]> | null;

export type ChatModel = Pick<NativeModel, "provider" | "id" | "name" | "contextWindow" | "input"> & Partial<Pick<NativeModel, "cost">>;

export interface ChatModelCatalog {
  sessionId: string;
  models: ChatModel[];
  configuredProviders: string[];
}

export type ChatUsage =
  | (NativeUsageSummary & { kind: "native-session"; context: ChatContextUsage; providerLimits: "unavailable" })
  | { kind: "unavailable"; reason: "not-recorded"; context: ChatContextUsage; providerLimits: "unavailable" };

export interface ChatWindow { turns: number; startId?: string; older?: number; mode: "compact" | "detailed" | "questions"; expanded: string[] }
export interface ChatHistory { totalTurns: number; shownTurns: number; startId?: string; questions: { id: string; text: string; turn: number }[] }
export interface ChatView {
  session: ChatSession;
  messages: ChatMessage[];
  history?: ChatHistory;
  queueCount: number;
  queue: NativeQueue;
  work: ChatWork | null;
  children: ChatChild[];
  controls:
    | { kind: "live"; currentModel: ChatModel | null; canChangeModel: boolean; thinkingLevel: NativeState["thinkingLevel"]; availableThinkingLevels: NativeState["availableThinkingLevels"] }
    | { kind: "saved"; currentModel: null; canChangeModel: false };
  usage: ChatUsage;
}

export type ChatChild = Pick<NonNullable<NativeSnapshot["children"]>[number], "id" | "parentId" | "sessionName" | "model" | "label" | "status" | "durationMs" | "recap" | "error">;
export type SendMode = "steer" | "followUp";

export interface ChatBackend {
  create(input: { sourceSessionId?: string | undefined }): Promise<ChatSession>;
  list(): Promise<ChatSession[]>;
  read(sessionId: string, window?: ChatWindow): Promise<ChatView>;
  target(sessionId: string): Promise<ChatSession>;
  models(sessionId: string): Promise<ChatModelCatalog>;
  setModel(input: { sessionId: string; provider: string; modelId: string }): Promise<ChatModel>;
  send(input: { sessionId: string; message: string; mode?: SendMode; images?: ChatImage[] }): Promise<void>;
  commands(sessionId: string): Promise<{ sessionId: string; commands: ChatCommand[] }>;
  rename(input: { sessionId: string; name: string }): Promise<void>;
  setEffort(input: { sessionId: string; level: string }): Promise<void>;
  accounts(sessionId: string): Promise<PoolListing>;
  setAccount(input: { sessionId: string; provider: string; target: string; force: boolean }): Promise<PoolListing>;
  stop(sessionId: string): Promise<void>;
  compact(sessionId: string): Promise<void>;
  mutateQueue(input: { sessionId: string; lane: "steering" | "followUp"; index: number; expectedText: string; text?: string }): Promise<string>;
  markRead(input: { sessionId: string; entryId: string }): Promise<void>;
  close(): Promise<void>;
}

type CatalogRow = { session: ChatSession; usage: NativeUsageSummary | null; revision: string; hasName: boolean } & (
  | { kind: "live"; activeSessionId: string }
  | { kind: "saved"; sessionFile: string | undefined });
type NativeMessage = Awaited<ReturnType<DaemonAgentConnection["getMessages"]>>[number];
type NativeTree = Awaited<ReturnType<DaemonAgentConnection["getSessionTree"]>>;
type NativeEntry = NativeTree["tree"][number]["entry"];
type CachedConnection = {
  client: DaemonClient;
  connection: Promise<DaemonAgentConnection>;
  users: number;
  touched: number;
  tree?: { sessionId: string; value: NativeTree };
  read?: Promise<{ snapshot: NativeSnapshot; queue: NativeQueue; branch: NativeEntry[] }>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function usageSummary(value: unknown): NativeUsageSummary | null {
  if (!isRecord(value)) return null;
  const { inputTokens, outputTokens, cost } = value;
  if (typeof inputTokens !== "number" || !Number.isFinite(inputTokens) || inputTokens < 0 ||
    typeof outputTokens !== "number" || !Number.isFinite(outputTokens) || outputTokens < 0 ||
    typeof cost !== "number" || !Number.isFinite(cost) || cost < 0) return null;
  return { inputTokens, outputTokens, cost };
}

function chatUsage(usage: NativeUsageSummary | null, context: ChatContextUsage): ChatUsage {
  return usage ? { kind: "native-session", ...usage, context, providerLimits: "unavailable" }
    : { kind: "unavailable", reason: "not-recorded", context, providerLimits: "unavailable" };
}

function chatModel(model: NativeModel): ChatModel {
  return { provider: model.provider, id: model.id, name: model.name, contextWindow: model.contextWindow,
    input: [...model.input], cost: model.cost };
}

function isBusy(state: NativeState, queue: NativeQueue): boolean {
  return state.isStreaming || state.isBashRunning || state.isCompacting || state.retryAttempt > 0 ||
    Boolean(state.sessionActions.active) || state.sessionActions.queuedCount > 0 || queue.steering.length > 0 || queue.followUp.length > 0;
}

function catalogRows(value: unknown): CatalogRow[] {
  if (!isRecord(value) || !Array.isArray(value.sessions)) throw new Error("Invalid daemon session catalog");
  return value.sessions.filter((row: unknown) => isRecord(row) && row.runtimeKind !== "subagent" && typeof row.rlmChildId !== "string" && !(typeof row.rlmDepth === "number" && row.rlmDepth > 0)).map((row: unknown): CatalogRow => {
    if (!isRecord(row) || typeof row.sessionId !== "string" || typeof row.cwd !== "string") {
      throw new Error("Invalid daemon session row");
    }
    const activeSessionId = typeof row.activeSessionId === "string" ? row.activeSessionId : undefined;
    const canSend = activeSessionId !== undefined && (row.workerState === undefined || row.workerState === "ready");
    const session: ChatSession = {
      sessionId: row.sessionId,
      name: typeof row.sessionName === "string" && row.sessionName.trim() ? row.sessionName : previewTitle(row.firstMessage),
      cwd: row.cwd,
      ...(row.lifecycle === "archived" || row.lifecycle === "live" || row.lifecycle === "draft" ? { lifecycle: row.lifecycle } : {}),
      status: activeSessionId === undefined ? "saved" : row.isStreaming === true || row.isCompacting === true || row.isBashRunning === true || row.hasRunningRlmChildren === true || row.isRunningTools === true || (isRecord(row.sessionActions) && (Boolean(row.sessionActions.active) || typeof row.sessionActions.queuedCount === "number" && row.sessionActions.queuedCount > 0)) ? "running" : "idle",
      canSend,
      ...(typeof row.created === "string" ? { created: row.created } : {}),
      ...(typeof row.lastActivityAt === "string" ? { lastActivityAt: row.lastActivityAt } : {}),
      ...(typeof row.statusLabel === "string" ? { nativeStatus: row.statusLabel } : row.workerState === "failed" || row.workerState === "recovering" ? { nativeStatus: row.workerState } : {}),
      ...(isRecord(row.model) && typeof row.model.provider === "string" && typeof row.model.id === "string"
        ? { model: `${row.model.provider}/${row.model.id}` } : {}),
    };
    const usage = usageSummary(row.usage);
    const revision = JSON.stringify([row.messageCount, row.lastActivityAt, row.modified]);
    const hasName = typeof row.sessionName === "string" && !!row.sessionName.trim();
    return activeSessionId === undefined
      ? { kind: "saved", session, usage, revision, hasName, sessionFile: typeof row.sessionFile === "string" ? row.sessionFile : undefined }
      : { kind: "live", session, usage, revision, hasName, activeSessionId };
  });
}

export function previewTitle(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return "Untitled session";
  const skill = parseSkillBlock(value);
  const text = skill ? skill.userMessage ?? "" : /^\s*<(?:skill|system|instructions)(?:\s|>)/i.test(value) ? "" : value;
  return text.trim().replace(/\s+/g, " ").slice(0, 100) || "Untitled session";
}
function chatMessage(id: string, message: NativeMessage, streaming = false): ChatMessage[] {
  if (message.role !== "user" && message.role !== "assistant") return [];
  const images = sanitizeNativeImages(message);
  const body = typeof message.content === "string" ? message.content : message.content.flatMap(part =>
    part.type === "text" ? [part.text] : []).join("\n\n");
  const omittedImageCount = typeof message.content === "string" ? 0
    : message.content.filter(part => part.type === "image").length - images.length;
  const outcome = message.role === "assistant" && (message.stopReason === "error" || message.stopReason === "aborted") ? message.stopReason : undefined;
  const text = [body, ...(outcome ? [message.role === "assistant" ? message.errorMessage || (outcome === "aborted" ? "Response aborted" : "Native request failed") : ""] : []),
    ...Array.from({ length: omittedImageCount }, () => "[Saved image]")].filter(Boolean).join("\n\n");
  const tools: ChatTool[] = message.role === "assistant" ? message.content.flatMap(part => part.type === "toolCall"
    ? [{ id: part.id, name: part.name, args: part.arguments, output: "", status: streaming ? "pending" as const : "interrupted" as const, summary: streaming ? "Preparing arguments" : "Result unavailable", revision: part.id }] : []) : [];
  return text.trim() || images.length || tools.length ? [{ id, role: message.role, text, streaming, images, timestamp: message.timestamp,
    ...(outcome ? { outcome } : {}), ...(tools.length ? { tools } : {}) }] : [];
}
export function transcriptMessages(branch: NativeEntry[], snapshot?: NativeSnapshot, includeToolOutput = true): ChatMessage[] {
  const messages = branch.flatMap(entry => entry.type === "message" ? chatMessage(entry.id, entry.message) : []);
  const streaming = snapshot?.streamingMessage;
  if (streaming && !branch.some(entry => entry.type === "message" && entry.message.role === streaming.role &&
    "timestamp" in entry.message && "timestamp" in streaming && entry.message.timestamp === streaming.timestamp)) {
    messages.push(...chatMessage("streaming:" + snapshot.state.sessionId, streaming, true));
  }
  const results = new Map(branch.flatMap(entry => entry.type === "message" && entry.message.role === "toolResult" ? [[entry.message.toolCallId, entry.message] as const] : []));
  for (const message of messages) for (const tool of message.tools ?? []) {
    const result = results.get(tool.id);
    if (result) {
      tool.output = includeToolOutput ? result.content.flatMap(part => part.type === "text" ? [part.text] : []).join("\n") : "";
      tool.status = result.isError ? "error" : "complete";
      const firstText = result.content.find(part => part.type === "text" && part.text.trim());
      tool.summary = firstText?.type === "text" ? firstText.text.trimStart().split("\n", 1)[0]?.slice(0, 160) || "Completed" : result.isError ? "Tool failed" : "Completed";
      if (isRecord(result.details) && typeof result.details.durationMs === "number") tool.durationMs = result.details.durationMs;
    } else if (snapshot?.state.isStreaming && !message.streaming && message === messages.at(-1)) {
      tool.status = "running"; tool.summary = "Running";
    }
    tool.revision = result ? tool.id + ':' + result.timestamp + ':' + tool.status
      : tool.id + ':' + tool.status + ':' + (snapshot?.lastEventCursor?.generation ?? '') + ':' + (snapshot?.lastEventSequence ?? 0);
  }
  return messages;
}
export function nativeWork(snapshot: NativeSnapshot, messages: ChatMessage[] = []): ChatWork {
  const state = snapshot.state;
  let startedAt: number | null = null;
  if (state.isStreaming) for (const message of [...snapshot.messages].reverse()) {
    if (message.role === "user" || message.role === "custom" && ["agent_message", "heartbeat_prompt", "async_bash_completion"].includes(message.customType)) startedAt = message.timestamp;
    else if (message.role === "assistant" && message.stopReason !== "toolUse") break;
  }
  const childCount = (snapshot.children ?? []).filter(child => child.status === "running" || child.status === "queued").length;
  return { isStreaming: state.isStreaming, isCompacting: state.isCompacting, isBashRunning: state.isBashRunning,
    retryAttempt: state.retryAttempt, ...(state.recap ? { recap: state.recap } : {}), startedAt, childCount,
    label: state.isCompacting ? "Compacting" : state.retryAttempt > 0 ? "Retrying" : state.isBashRunning ? "Running bash" :
      messages.some(message => message.tools?.some(tool => tool.status === "running")) ? "Executing " + messages.flatMap(message => message.tools?.filter(tool => tool.status === "running").map(tool => tool.name) ?? []).join(", ") : state.isStreaming ? (snapshot.streamingMessage?.role === "assistant" && snapshot.streamingMessage.content.some(part => part.type === "text") ? "Writing" : "Waiting") : childCount ? "Child work" : state.sessionActions.active?.label || (state.sessionActions.queuedCount ? "Queued" : "") };
}

function branchFromTree({ tree, leafId }: NativeTree): NativeEntry[] {
  const entries = new Map<string, NativeEntry>();
  const pending = [...tree];
  while (pending.length) {
    const node = pending.pop();
    if (!node) break;
    if (entries.has(node.entry.id)) throw new Error("Duplicate native session entry");
    entries.set(node.entry.id, node.entry);
    for (const child of node.children) pending.push(child);
  }
  const branch: NativeEntry[] = [];
  const visited = new Set<string>();
  let id = leafId;
  while (id !== null) {
    if (visited.has(id)) throw new Error("Invalid native session branch");
    visited.add(id);
    const entry = entries.get(id);
    if (!entry) throw new Error("Native session branch is incomplete");
    branch.push(entry);
    id = entry.parentId;
  }
  return branch.reverse();
}

function messageText(message: NativeMessage): string {
  if (!("content" in message)) return "";
  return typeof message.content === "string" ? message.content : Array.isArray(message.content)
    ? message.content.flatMap(part => part.type === "text" ? [part.text] : []).join("\n") : "";
}

function historyWindow(branch: NativeEntry[], window: ChatWindow, snapshot?: NativeSnapshot): { branch: NativeEntry[]; history: ChatHistory } {
  const groups: NativeEntry[][] = [];
  for (const entry of branch) {
    if (entry.type === "message" && entry.message.role === "user" || groups.length === 0) groups.push([]);
    groups[groups.length - 1]?.push(entry);
  }
  const visibleGroups = groups.filter(group => group.some(entry => entry.type === "message" && (entry.message.role === "user" || entry.message.role === "assistant")));
  const questions = visibleGroups.flatMap((group, turn) => group.flatMap(entry => entry.type === "message" && entry.message.role === "user"
    ? [{ id: entry.id, text: previewTitle(messageText(entry.message)), turn }] : []));
  const anchorIndex = window.startId ? visibleGroups.findIndex(group => group.some(entry => entry.id === window.startId)) : -1;
  const start = anchorIndex >= 0 ? Math.max(0, anchorIndex - (window.older ?? 0)) : Math.max(0, visibleGroups.length - window.turns);
  const shown = visibleGroups.slice(start);
  const selected = shown.flatMap(group => {
    if (window.mode === "questions") return group.filter(entry => entry.type === "message" && entry.message.role === "user");
    const first = group.find(entry => entry.type === "message" && (entry.message.role === "user" || entry.message.role === "assistant"));
    if (window.mode === "detailed" || first && window.expanded.includes(first.id)) return group;
    const assistant = group.findLast(entry => entry.type === "message" && entry.message.role === "assistant" &&
      (messageText(entry.message).trim() || entry.message.stopReason === "error" || entry.message.stopReason === "aborted")) ??
      group.findLast(entry => entry.type === "message" && entry.message.role === "assistant");
    const lastAssistant = group.findLast(entry => entry.type === "message" && entry.message.role === "assistant");
    const hasStreamingText = group === groups.at(-1) && snapshot?.streamingMessage?.role === "assistant" && messageText(snapshot.streamingMessage).trim();
    return group.filter(entry => entry.type === "message" && (entry.message.role === "user" ||
      entry.message.role === "toolResult" || entry === assistant && !hasStreamingText || entry === lastAssistant && entry.message.role === "assistant" && entry.message.content.some(part => part.type === "toolCall")));
  });
  const startId = shown[0]?.find(entry => entry.type === "message" && (entry.message.role === "user" || entry.message.role === "assistant"))?.id;
  return { branch: selected, history: { totalTurns: visibleGroups.length, shownTurns: shown.length, ...(startId ? { startId } : {}), questions } };
}

export async function createChatBackend(options: { socketPath?: string; readStatePath?: string } = {}): Promise<ChatBackend> {
  const socketPath = options.socketPath ?? defaultDaemonSocketPath();
  const catalogClient = new DaemonClient(socketPath);
  const connections = new Map<string, CachedConnection>();
  const toolUpdates = new Map<string, { output: string; durationMs?: number }>();
  let closed = false;
  let clock = 0;
  const readState = new ChatReadState(options.readStatePath ?? join(getAgentDir(), "browser-chat", "read-state.json"));
  const observed = new Map<string, { revision: string; name?: string; lastAssistant?: ReadMarker }>();
  const failedMetadata = new Map<string, string>();
  let metadataRefresh: Promise<void> | undefined;
  const initialReadState = await readState.snapshot().catch(() => null);
  const responseBaseline = initialReadState?.baseline ?? Date.now();

  function assertOpen(): void {
    if (closed) throw new Error("Agent chat is closed");
  }

  async function catalog(): Promise<CatalogRow[]> {
    assertOpen();
    try {
      await catalogClient.reconnect(1500);
      await catalogClient.waitForHello(1500);
    } catch (error) {
      catalogClient.resetTransportForReconnect();
      throw new Error("Native daemon disconnected. Start Prime Agent and retry. " + (error instanceof Error ? error.message : String(error)));
    }
    const response = await catalogClient.request({ type: "list", all: true }, 30000, { recoverable: false });
    if (!response.success) throw new Error(response.error);
    return catalogRows(response.data);
  }

  async function resolve(sessionId: string): Promise<CatalogRow> {
    const rows = await catalog();
    const row = rows.find(item => item.session.sessionId === sessionId && item.kind === "live") ??
      rows.find(item => item.session.sessionId === sessionId);
    if (!row) throw new Error("This session is not in the daemon catalog");
    return row;
  }

  async function retire(key: string, cached: CachedConnection): Promise<void> {
    if (connections.get(key) === cached) connections.delete(key);
    cached.client.close();
    await cached.connection.then(connection => connection.dispose()).catch(() => {});
  }

  async function withConnection<T>(row: Extract<CatalogRow, { kind: "live" }>,
    run: (connection: DaemonAgentConnection, cached: CachedConnection) => Promise<T>): Promise<T> {
    assertOpen();
    let cached = connections.get(row.activeSessionId);
    if (!cached) {
      if (connections.size >= 4) {
        const unused = [...connections].filter(([, entry]) => entry.users === 0)
          .sort((left, right) => left[1].touched - right[1].touched)[0];
        if (!unused) throw new Error("Too many concurrent session requests. Try again after they finish.");
        void retire(unused[0], unused[1]);
      }
      const client = new DaemonClient(socketPath);
      const connection = (async () => {
        await client.connect();
        await client.waitForHello();
        const attached = await DaemonAgentConnection.attach(client, row.activeSessionId, {
          directTransport: false,
          supportsExtensionUi: false,
          sendClientEnv: false,
          ownedSession: false,
          closeClientOnDispose: true,
        });
        attached.subscribe(event => {
          if (event.type !== "session_event") return;
          const update = event.event;
          if (update.type !== "tool_execution_update" && update.type !== "tool_execution_end") return;
          const result: unknown = update.type === "tool_execution_update" ? update.partialResult : update.result;
          if (!isRecord(result) || !Array.isArray(result.content)) return;
          const output = result.content.flatMap((part: unknown) => isRecord(part) && part.type === "text" && typeof part.text === "string" ? [part.text] : []).join("\n");
          const details = result.details;
          toolUpdates.set(update.toolCallId, { output, ...(isRecord(details) && typeof details.durationMs === "number" ? { durationMs: details.durationMs } : {}) });
          if (toolUpdates.size > 128) toolUpdates.delete(toolUpdates.keys().next().value!);
        });
        return attached;
      })();
      cached = { client, connection, users: 0, touched: ++clock };
      connections.set(row.activeSessionId, cached);
    }
    cached.users++;
    cached.touched = ++clock;
    try {
      const connection = await cached.connection;
      const header = await connection.getSessionHeader();
      if (header?.id !== row.session.sessionId) throw new Error("The live session changed. Refresh before sending.");
      return await run(connection, cached);
    } catch (error) {
      if (cached.users === 1) await retire(row.activeSessionId, cached);
      throw error;
    } finally {
      cached.users--;
    }
  }

  async function observe(row: CatalogRow, messages: ChatMessage[], branch?: NativeEntry[]) {
    const nativeLast = branch?.findLast(entry => entry.type === "message" && entry.message.role === "assistant");
    const last = nativeLast?.type === "message" ? { id: nativeLast.id, timestamp: nativeLast.message.timestamp } : messages.findLast(message => message.role === "assistant" && !message.streaming);
    const lastAssistant = last?.timestamp ? { entryId: last.id, timestamp: last.timestamp } : undefined;
    const firstUser = messages.find(message => message.role === "user");
    const name = !row.hasName && firstUser ? previewTitle(firstUser.text) : row.session.name;
    if (!row.hasName) row.session.name = name;
    const retained = lastAssistant ?? observed.get(row.session.sessionId)?.lastAssistant;
    observed.set(row.session.sessionId, { revision: row.revision, name, ...(retained ? { lastAssistant: retained } : {}) });
    failedMetadata.delete(row.session.sessionId);
    if (lastAssistant) {
      const state = await readState.snapshot().catch(() => null);
      row.session.lastAssistant = lastAssistant;
      if (state) row.session.unread = lastAssistant.timestamp > Math.max(state.baseline, state.sessions[row.session.sessionId]?.timestamp ?? 0);
      else row.session.readError = "Browser read markers unavailable";
    }
  }
  async function live(sessionId: string) {
    const row = await resolve(sessionId);
    if (row.kind !== "live" || !row.session.canSend) throw new Error("Resume this session in Prime Agent to use this control");
    return row;
  }
  async function idle(connection: DaemonAgentConnection, row: CatalogRow) {
    const [state, queue, children] = await Promise.all([connection.getState(), connection.getQueue(), connection.getRlmChildSnapshots()]);
    if (isBusy(state, queue) || children.some(child => child.status === "running" || child.status === "queued")) throw new Error("Wait for native work to finish before changing this control");
    return state;
  }
  async function commandCatalog(connection: DaemonAgentConnection): Promise<ChatCommand[]> {
    const [commands, resources] = await Promise.all([connection.getCommands(), connection.getResourceSnapshot()]);
    const result: ChatCommand[] = commands.map(({ name, description, source, argumentHint }) => ({ name, source, ...(description ? { description } : {}), ...(argumentHint ? { argumentHint } : {}) }));
    for (const skill of resources.skills) if (!result.some(command => command.source === "skill" && command.name === "skill:" + skill.name)) {
      result.push({ name: "skill:" + skill.name, ...(skill.description ? { description: skill.description } : {}), source: "skill" });
    }
    return result;
  }
  const backend: ChatBackend = {
    async create({ sourceSessionId }) {
      const source = sourceSessionId ? await resolve(sourceSessionId) : null;
      const model = source?.kind === "live" ? await withConnection(source, async connection => (await connection.getState()).model) : null;
      await catalog();
      const response = await catalogClient.request({ type: "create", lifecycle: "resident",
        config: { ...(source ? { cwd: source.session.cwd } : {}),
          ...(model ? { provider: model.provider, model: model.id } : {}) } }, 30000, { recoverable: false });
      if (!response.success) throw new Error(response.error);
      const created = catalogRows({ sessions: [response.data] })[0];
      if (!created) throw new Error("Native creation returned no root session. Check the sidebar before creating another.");
      return created.session;
    },
    async list() {
      const unique = new Map<string, CatalogRow>();
      for (const row of await catalog()) if (!unique.has(row.session.sessionId) || row.kind === "live") unique.set(row.session.sessionId, row);
      const markers = await readState.snapshot().catch(() => null);
      const refresh: CatalogRow[] = [];
      const sessions: ChatSession[] = [];
      for (const row of unique.values()) {
        const session = row.session;
        if (!row.hasName) session.name = observed.get(session.sessionId)?.name ?? session.name;
        const changed = observed.get(session.sessionId)?.revision !== row.revision;
        const recent = Date.parse(session.lastActivityAt ?? "") > responseBaseline || (observed.has(session.sessionId) && changed);
        if (changed && recent) {
          refresh.push(row);
          session.readError = failedMetadata.get(session.sessionId) === row.revision ? "Response status unavailable" : "Response status pending";
        }
        const last = observed.get(session.sessionId)?.lastAssistant;
        if (last) { session.lastAssistant = last; if (markers) session.unread = last.timestamp > Math.max(markers.baseline, markers.sessions[session.sessionId]?.timestamp ?? 0); }
        if (!markers) session.readError = "Browser read markers unavailable";
        sessions.push(session);
      }
      if (!metadataRefresh && refresh.length) {
        const batch = refresh.sort((left, right) => Number(failedMetadata.get(left.session.sessionId) === left.revision) -
          Number(failedMetadata.get(right.session.sessionId) === right.revision)).slice(0, 4);
        metadataRefresh = new Promise<void>(resolve => setImmediate(resolve)).then(async () => {
          for (const row of batch) {
            if (closed) return;
            try { await backend.read(row.session.sessionId, { turns: 1, mode: "compact", expanded: [] }); }
            catch { failedMetadata.set(row.session.sessionId, row.revision); }
          }
        }).finally(() => { metadataRefresh = undefined; });
      }
      return sessions;
    },
    async target(sessionId) {
      const row = await resolve(sessionId);
      if (row.kind === "saved") return row.session;
      const [state, header] = await Promise.all([
        catalogClient.request({ type: "get_connection_state", activeSessionId: row.activeSessionId }, 10000, { recoverable: false }),
        catalogClient.request({ type: "get_session_header", activeSessionId: row.activeSessionId }, 10000, { recoverable: false }),
      ]);
      if (!state.success) throw new Error(state.error);
      if (!header.success) throw new Error(header.error);
      if (!isRecord(state.data) || state.data.sessionId !== sessionId || !isRecord(header.data) ||
        !isRecord(header.data.header) || header.data.header.id !== sessionId) throw new Error("The native target changed. Refresh before sending.");
      return row.session;
    },
    async read(sessionId, window) {
      const row = await resolve(sessionId);
      if (row.kind === "saved") {
        if (!row.sessionFile) throw new Error("This saved session has no history file");
        const manager = SessionManager.inMemory(row.session.cwd);
        manager.setSessionFile(row.sessionFile);
        if (manager.getSessionId() !== sessionId) throw new Error("The saved session is missing or has changed");
        const branch = manager.getBranch();
        const projected = window ? historyWindow(branch, window) : null;
        const messages = transcriptMessages(projected?.branch ?? branch, undefined, !window);
        const firstUser = branch.find(entry => entry.type === "message" && entry.message.role === "user");
        if (!row.hasName && firstUser?.type === "message") { row.session.name = previewTitle(messageText(firstUser.message)); row.hasName = true; }
        await observe(row, messages, branch);
        return { session: row.session, queueCount: 0, queue: { steering: [], followUp: [] }, work: null, children: [],
          controls: { kind: "saved", currentModel: null, canChangeModel: false }, usage: chatUsage(row.usage, null),
          messages, ...(projected ? { history: projected.history } : {}) };
      }
      return withConnection(row, async (connection, cached) => {
        const pending = cached.read ??= (async () => {
          const [initialSnapshot, queue, children] = await Promise.all([connection.getInitialSnapshot(), connection.getQueue(), connection.getRlmChildSnapshots()]);
          const snapshot = { ...initialSnapshot, children };
          const tree = cached.tree?.sessionId === sessionId && cached.tree.value.leafId === snapshot.state.leafId
            ? cached.tree.value : await connection.getSessionTree();
          const header = await connection.getSessionHeader();
          if (snapshot.state.sessionId !== sessionId || header?.id !== sessionId) {
            throw new Error("The live session changed. Refresh the session list.");
          }
          cached.tree = { sessionId, value: tree };
          return { snapshot, queue, branch: branchFromTree(tree) };
        })();
        let native;
        try { native = await pending; }
        finally { if (cached.read === pending) delete cached.read; }
        const { snapshot, queue, branch } = native;
        const projected = window ? historyWindow(branch, window, snapshot) : null;
        const messages = transcriptMessages(projected?.branch ?? branch, window?.mode === "questions" ? undefined : snapshot, !window);
        const firstUser = branch.find(entry => entry.type === "message" && entry.message.role === "user");
        if (!row.hasName && firstUser?.type === "message") { row.session.name = previewTitle(messageText(firstUser.message)); row.hasName = true; }
        for (const message of messages) for (const tool of message.tools ?? []) {
          const update = toolUpdates.get(tool.id);
          if (update && tool.status === "running") { tool.output = update.output; tool.summary = update.output.trim().split("\n")[0]?.slice(0, 160) || "Running"; }
        }
        await observe(row, messages, branch);
        const lastAssistantIndex = branch.findLastIndex(entry => entry.type === "message" && entry.message.role === "assistant");
        const activityMessages = transcriptMessages(lastAssistantIndex >= 0 ? branch.slice(lastAssistantIndex) : [], snapshot, false);
        const work = nativeWork(snapshot, activityMessages);
        const currentModel = snapshot.state.model ? chatModel(snapshot.state.model) : null;
        const busy = isBusy(snapshot.state, queue) || work.childCount > 0;
        return { session: { ...row.session, name: snapshot.state.sessionName?.trim() ? snapshot.state.sessionName : row.session.name,
          ...(currentModel ? { model: `${currentModel.provider}/${currentModel.id}` } : {}),
          status: busy ? "running" : "idle" },
          controls: { kind: "live", currentModel, canChangeModel: row.session.canSend && !busy, thinkingLevel: snapshot.state.thinkingLevel, availableThinkingLevels: snapshot.state.availableThinkingLevels },
          usage: chatUsage(row.usage, snapshot.state.contextUsage ?? null),
          children: (snapshot.children ?? []).map(({ id, parentId, sessionName, model, label, status, durationMs, recap, error }) =>
            ({ id, label, status, ...(parentId !== undefined ? { parentId } : {}), ...(sessionName !== undefined ? { sessionName } : {}),
              ...(model !== undefined ? { model } : {}), ...(durationMs !== undefined ? { durationMs } : {}),
              ...(recap !== undefined ? { recap } : {}), ...(error !== undefined ? { error } : {}) })),
          messages, ...(projected ? { history: projected.history } : {}), work, queue, queueCount: queue.steering.length + queue.followUp.length };
      });
    },
    async models(sessionId) {
      const row = await resolve(sessionId);
      if (row.kind !== "live") throw new Error("Resume this session in Prime Agent before choosing a model");
      return withConnection(row, async connection => {
        const catalog = await connection.getModelCatalog();
        const header = await connection.getSessionHeader();
        if (header?.id !== sessionId) throw new Error("The live session changed. Refresh the session list.");
        return { sessionId, models: catalog.models.map(chatModel), configuredProviders: catalog.configuredProviders };
      });
    },
    async setModel({ sessionId, provider, modelId }) {
      if (!provider.trim() || !modelId.trim()) throw new Error("Choose a provider and model");
      const row = await resolve(sessionId);
      if (row.kind !== "live" || !row.session.canSend) {
        throw new Error("Resume this session in Prime Agent before changing its model");
      }
      return withConnection(row, async connection => {
        const state = await idle(connection, row);
        const header = await connection.getSessionHeader();
        if (state.sessionId !== sessionId || header?.id !== sessionId) throw new Error("The live session changed. Refresh before changing its model.");
        return chatModel(await connection.setModel(provider, modelId));
      });
    },
    async send({ sessionId, message, mode = "followUp", images: inputImages }) {
      const images = parseChatImages(inputImages);
      if (!message.trim() && !images.length) throw new Error("Add a message or image");
      const row = await resolve(sessionId);
      if (row.kind !== "live" || !row.session.canSend) throw new Error("Resume this session in Prime Agent before sending");
      return withConnection(row, async connection => {
        if (images.length) {
          const state = await connection.getState();
          if (!state.model?.input.includes("image")) throw new Error("Choose a model that accepts images");
          const header = await connection.getSessionHeader();
          if (header?.id !== sessionId) throw new Error("The live session changed. Refresh before sending.");
        }
        if (message.trimStart().startsWith("/")) {
          const invocation = message.trimStart().split(/\s/, 1)[0]?.slice(1);
          const commands = await commandCatalog(connection);
          const command = commands.find(command => command.name === invocation);
          if (!command) throw new Error("Unknown slash command. The draft was kept.");
          if (command.source === "extension") throw new Error("Use this extension command in the Prime Agent terminal. Browser dialogs are unavailable.");
        }
        await connection.prompt(message, {
          source: "interactive", streamingBehavior: mode, queueIfBusy: true, ...(images.length ? { images } : {}),
        });
      });
    },
    async commands(sessionId) { return withConnection(await live(sessionId), async connection => ({ sessionId, commands: await commandCatalog(connection) })); },
    async rename({ sessionId, name }) {
      if (!name.trim() || name.length > 200) throw new Error("Use a session name of 1 to 200 characters");
      const row = await resolve(sessionId);
      if (row.kind === "live") await withConnection(row, connection => connection.setSessionName(name.trim()));
      else {
        if (!row.sessionFile) throw new Error("This saved session has no native file");
        const owner = (await catalog()).find(row => row.kind === "live" && row.session.canSend);
        if (!owner || owner.kind !== "live") throw new Error("Open a native session before renaming saved sessions");
        await withConnection(owner, connection => connection.renameSavedSession(row.sessionFile!, name.trim()));
      }
    },
    async setEffort({ sessionId, level }) {
      const row = await live(sessionId);
      await withConnection(row, async connection => {
        const state = await idle(connection, row);
        const nativeLevel = state.availableThinkingLevels.find(value => value === level);
        if (!nativeLevel) throw new Error("Choose a native effort level for this model");
        await connection.setThinkingLevel(nativeLevel);
      });
    },
    async accounts(sessionId) {
      const row = await live(sessionId);
      return withConnection(row, async connection => listPool((await connection.getState()).model?.provider ?? "", sessionId));
    },
    async setAccount(input) {
      const row = await live(input.sessionId);
      return withConnection(row, async connection => {
        if ((await connection.getState()).model?.provider !== input.provider) throw new Error("The model provider changed. Reopen the account picker.");
        return choosePool(input);
      });
    },
    async stop(sessionId) {
      await withConnection(await live(sessionId), async connection => {
        const state = await connection.getState();
        if (state.isCompacting) await connection.abortCompaction();
        if (state.isBashRunning) await connection.abortBash();
        if (state.retryAttempt) await connection.abortRetry();
        await connection.abort();
      });
    },
    async compact(sessionId) {
      const row = await live(sessionId);
      await withConnection(row, async connection => { await idle(connection, row); await connection.compact(); });
    },
    async mutateQueue({ sessionId, lane, index, expectedText, text }) {
      return withConnection(await live(sessionId), connection => connection.mutateQueuedMessage(lane, index, expectedText,
        text === undefined ? { type: "delete" } : { type: "replace", text, lane }));
    },
    async markRead({ sessionId, entryId }) {
      const view = await backend.read(sessionId);
      const message = view.messages.find(message => message.id === entryId && message.role === "assistant" && !message.streaming);
      if (!message?.timestamp) throw new Error("This committed assistant entry is unavailable");
      await readState.mark(sessionId, { entryId, timestamp: message.timestamp });
    },
    async close() {
      if (closed) return;
      closed = true;
      catalogClient.close();
      await Promise.all([...connections].map(([key, cached]) => retire(key, cached)));
    },
  };
  return backend;
}
