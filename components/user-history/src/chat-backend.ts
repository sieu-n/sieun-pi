import { DaemonAgentConnection, DaemonClient, SessionManager, defaultDaemonSocketPath, type SessionSummary } from "prime-agent";
import { parseChatImages, sanitizeNativeImages, type ChatImage } from "./chat-images.ts";

export interface ChatSession {
  sessionId: string;
  name: string;
  cwd: string;
  kind: "root" | "agent";
  status: "running" | "idle" | "saved";
  parentSessionId?: string;
  model?: string;
  canSend: boolean;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  streaming: boolean;
  images: ChatImage[];
}

type NativeModel = Awaited<ReturnType<DaemonAgentConnection["setModel"]>>;
type NativeState = Awaited<ReturnType<DaemonAgentConnection["getState"]>>;
type NativeQueue = Awaited<ReturnType<DaemonAgentConnection["getQueue"]>>;
type NativeUsageSummary = NonNullable<SessionSummary["usage"]>;
type ChatContextUsage = NonNullable<NativeState["contextUsage"]> | null;

export type ChatModel = Pick<NativeModel, "provider" | "id" | "name" | "contextWindow" | "input">;

export interface ChatModelCatalog {
  sessionId: string;
  models: ChatModel[];
  configuredProviders: string[];
}

export type ChatUsage =
  | (NativeUsageSummary & { kind: "native-session"; context: ChatContextUsage; providerLimits: "unavailable" })
  | { kind: "unavailable"; reason: "not-recorded"; context: ChatContextUsage; providerLimits: "unavailable" };

export interface ChatView {
  session: ChatSession;
  messages: ChatMessage[];
  queueCount: number;
  controls:
    | { kind: "live"; currentModel: ChatModel | null; canChangeModel: boolean }
    | { kind: "saved"; currentModel: null; canChangeModel: false };
  usage: ChatUsage;
}

export interface ChatBackend {
  list(): Promise<ChatSession[]>;
  read(sessionId: string): Promise<ChatView>;
  models(sessionId: string): Promise<ChatModelCatalog>;
  setModel(input: { sessionId: string; provider: string; modelId: string }): Promise<ChatModel>;
  send(input: { sessionId: string; message: string; images?: ChatImage[] }): Promise<void>;
  close(): Promise<void>;
}

type CatalogRow = { session: ChatSession; usage: NativeUsageSummary | null } & (
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
    input: [...model.input] };
}

function isBusy(state: NativeState, queue: NativeQueue): boolean {
  return state.isStreaming || state.isBashRunning || state.isCompacting || state.retryAttempt > 0 ||
    state.sessionActions.queuedCount > 0 || queue.steering.length > 0 || queue.followUp.length > 0;
}

function catalogRows(value: unknown): CatalogRow[] {
  if (!isRecord(value) || !Array.isArray(value.sessions)) throw new Error("Invalid daemon session catalog");
  return value.sessions.map((row: unknown): CatalogRow => {
    if (!isRecord(row) || typeof row.sessionId !== "string" || typeof row.cwd !== "string") {
      throw new Error("Invalid daemon session row");
    }
    const activeSessionId = typeof row.activeSessionId === "string" ? row.activeSessionId : undefined;
    const canSend = activeSessionId !== undefined && (row.workerState === undefined || row.workerState === "ready");
    const session: ChatSession = {
      sessionId: row.sessionId,
      name: typeof row.sessionName === "string" && row.sessionName.trim() ? row.sessionName
        : typeof row.firstMessage === "string" && row.firstMessage.trim() ? row.firstMessage.slice(0, 100) : row.sessionId,
      cwd: row.cwd,
      kind: row.runtimeKind === "subagent" || typeof row.rlmChildId === "string" ||
        (typeof row.rlmDepth === "number" && row.rlmDepth > 0) ? "agent" : "root",
      status: activeSessionId === undefined ? "saved" : row.activity === "working" ? "running" : "idle",
      canSend,
      ...(typeof row.parentSessionId === "string" ? { parentSessionId: row.parentSessionId } : {}),
      ...(isRecord(row.model) && typeof row.model.provider === "string" && typeof row.model.id === "string"
        ? { model: `${row.model.provider}/${row.model.id}` } : {}),
    };
    const usage = usageSummary(row.usage);
    return activeSessionId === undefined
      ? { kind: "saved", session, usage, sessionFile: typeof row.sessionFile === "string" ? row.sessionFile : undefined }
      : { kind: "live", session, usage, activeSessionId };
  });
}

function chatMessage(id: string, message: NativeMessage, streaming = false): ChatMessage[] {
  if (message.role !== "user" && message.role !== "assistant") return [];
  const images = sanitizeNativeImages(message);
  const body = typeof message.content === "string" ? message.content : message.content.flatMap(part =>
    part.type === "text" ? [part.text] : []).join("\n\n");
  const omittedImageCount = typeof message.content === "string" ? 0
    : message.content.filter(part => part.type === "image").length - images.length;
  const text = [body, ...Array.from({ length: omittedImageCount }, () => "[Saved image]")]
    .filter(part => part.length > 0).join("\n\n");
  return text.trim() || images.length ? [{ id, role: message.role, text, streaming, images }] : [];
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

export async function createChatBackend(options: { socketPath?: string } = {}): Promise<ChatBackend> {
  const socketPath = options.socketPath ?? defaultDaemonSocketPath();
  const catalogClient = new DaemonClient(socketPath);
  const connections = new Map<string, CachedConnection>();
  let closed = false;
  let clock = 0;
  try {
    await catalogClient.connect();
    await catalogClient.waitForHello();
  } catch (error) {
    catalogClient.close();
    throw error;
  }

  function assertOpen(): void {
    if (closed) throw new Error("Agent chat is closed");
  }

  async function catalog(): Promise<CatalogRow[]> {
    assertOpen();
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
    run: (connection: DaemonAgentConnection) => Promise<T>): Promise<T> {
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
        return DaemonAgentConnection.attach(client, row.activeSessionId, {
          directTransport: false,
          supportsExtensionUi: false,
          sendClientEnv: false,
          ownedSession: false,
          closeClientOnDispose: true,
        });
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
      return await run(connection);
    } catch (error) {
      if (cached.users === 1) await retire(row.activeSessionId, cached);
      throw error;
    } finally {
      cached.users--;
    }
  }

  return {
    async list() {
      const unique = new Map<string, ChatSession>();
      for (const row of await catalog()) {
        if (!unique.has(row.session.sessionId) || row.kind === "live") unique.set(row.session.sessionId, row.session);
      }
      return [...unique.values()];
    },
    async read(sessionId) {
      const row = await resolve(sessionId);
      if (row.kind === "saved") {
        if (!row.sessionFile) throw new Error("This saved session has no history file");
        const manager = SessionManager.inMemory(row.session.cwd);
        manager.setSessionFile(row.sessionFile);
        if (manager.getSessionId() !== sessionId) throw new Error("The saved session is missing or has changed");
        return { session: row.session, queueCount: 0,
          controls: { kind: "saved", currentModel: null, canChangeModel: false }, usage: chatUsage(row.usage, null),
          messages: manager.getBranch().flatMap(entry => entry.type === "message" ? chatMessage(entry.id, entry.message) : []) };
      }
      return withConnection(row, async connection => {
        const [tree, snapshot, queue] = await Promise.all([
          connection.getSessionTree(), connection.getInitialSnapshot(), connection.getQueue(),
        ]);
        const header = await connection.getSessionHeader();
        if (snapshot.state.sessionId !== sessionId || header?.id !== sessionId) {
          throw new Error("The live session changed. Refresh the session list.");
        }
        const branch = branchFromTree(tree);
        const messages = branch.flatMap(entry => entry.type === "message" ? chatMessage(entry.id, entry.message) : []);
        const streaming = snapshot.streamingMessage;
        if (streaming && !branch.some(entry => entry.type === "message" && entry.message.role === streaming.role &&
          "timestamp" in entry.message && "timestamp" in streaming && entry.message.timestamp === streaming.timestamp)) {
          messages.push(...chatMessage(`streaming:${sessionId}`, streaming, true));
        }
        const currentModel = snapshot.state.model ? chatModel(snapshot.state.model) : null;
        const busy = isBusy(snapshot.state, queue);
        return { session: { ...row.session, name: snapshot.state.sessionName ?? row.session.name,
          ...(currentModel ? { model: `${currentModel.provider}/${currentModel.id}` } : {}),
          status: busy ? "running" : "idle" },
          controls: { kind: "live", currentModel, canChangeModel: row.session.canSend && !busy },
          usage: chatUsage(row.usage, snapshot.state.contextUsage ?? null),
          messages, queueCount: queue.steering.length + queue.followUp.length };
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
        const [state, queue] = await Promise.all([connection.getState(), connection.getQueue()]);
        const header = await connection.getSessionHeader();
        if (state.sessionId !== sessionId || header?.id !== sessionId) {
          throw new Error("The live session changed. Refresh before changing its model.");
        }
        if (isBusy(state, queue)) throw new Error("Wait for this session to finish before changing its model");
        return chatModel(await connection.setModel(provider, modelId));
      });
    },
    async send({ sessionId, message, images: inputImages }) {
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
        await connection.prompt(message, {
          source: "interactive", streamingBehavior: "followUp", queueIfBusy: true, ...(images.length ? { images } : {}),
        });
      });
    },
    async close() {
      if (closed) return;
      closed = true;
      catalogClient.close();
      await Promise.all([...connections].map(([key, cached]) => retire(key, cached)));
    },
  };
}
