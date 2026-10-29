/**
 * The typed HTTP client for every endpoint in apps/chat/API.md. Each call returns the parsed body or throws `ApiError` with the server's
 * message. Paths are relative, so the page works behind Vite's proxy on :5185 and from the server on :5184 alike.
 */
import type {
  AgentConfig, AgentFolder, AgentId, AgentSummary, BoardOp, BoardRow, BoardView, CheckInPatch, CheckInView, ChatAgent, ConversationHeader, ConversationId,
  ConversationPatch, ConversationSummary, DutyAction, DutyRow, ForYouItem, HarnessEntryView, HostsReport, Item, JobNode, Me, MemoryInput, ModelCatalog, ProjectList, SearchQuery, SearchResult, SendRequest,
  Room, RoomInput, RoomPatch, SendResult, Sidebar, ThinkingLevel, TimelinePage, UsageReport, AccountsView,
} from "./types.ts";

export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}


const enc = encodeURIComponent;

/** The DM room of an agent id: `ag_<slug>` has `dm_<slug>`. A job's or a root thread's id names its own conversation. */
export const roomOf = (id: AgentId): ConversationId => (id.startsWith("ag_") ? `dm_${id.slice(3)}` : id);

/** A Solo room (`so_<id>`): a group chat of invited agents around one agenda. An untitled root chat in the Solo group is not one. */
export const isSoloRoom = (id: ConversationId): boolean => id.startsWith("so_");

/**
 * Where a board, its duties and its check-in live: `/api/agents/<id>` for an agent (`ag_<slug>`), and `/api/threads/<id>` for a root
 * thread that no agent owns yet.
 */
const boardBase = (chat: string): string => (chat.startsWith("ag_") ? `/api/agents/${enc(chat)}` : `/api/threads/${enc(chat)}`);

async function call<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    ...(signal ? { signal } : {}),
  });
  const text = await response.text();
  const value = text ? (JSON.parse(text) as unknown) : undefined;
  if (!response.ok) throw new ApiError(response.status, (value as { error?: string } | undefined)?.error ?? `${method} ${path} failed with ${response.status}`);
  return value as T;
}

const query = (params: Record<string, string | number | boolean | undefined | null>): string => {
  const entries = Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== "") as [string, string | number | boolean][];
  return entries.length ? `?${entries.map(([k, v]) => `${enc(k)}=${enc(String(v))}`).join("&")}` : "";
};

/** A fresh id for `SendRequest.requestId`, so a retried send lands once. */
export const requestId = (): string => (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`);

/** Reads a File as `{data, mimeType}` for `SendRequest.images`. */
export async function imageUpload(file: Blob): Promise<{ data: string; mimeType: string }> {
  const buffer = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let i = 0; i < buffer.length; i += 0x8000) binary += String.fromCharCode(...buffer.subarray(i, i + 0x8000));
  return { data: btoa(binary), mimeType: file.type || "image/png" };
}

export const api = {
  me: () => call<Me>("GET", "/api/me"),
  sidebar: () => call<Sidebar>("GET", "/api/sidebar"),
  conversations: (opts: { archived?: boolean } = {}) => call<ConversationSummary[]>("GET", `/api/conversations${query({ archived: opts.archived ? 1 : undefined })}`),
  models: () => call<ModelCatalog>("GET", "/api/models"),

  agents: (opts: { archived?: boolean } = {}) => call<AgentSummary[]>("GET", `/api/agents${query({ archived: opts.archived ? 1 : undefined })}`),
  jobs: (opts: { archived?: boolean } = {}) => call<AgentSummary[]>("GET", `/api/jobs${query({ archived: opts.archived ? 1 : undefined })}`),
  /**
   * A new agent with its work thread and DM room (`room`); `kind` "job" with a `parent` files a root thread under that agent as a job instead,
   * and `kind` "solo" makes a root chat no agent holds.
   */
  createAgent: (input: { name?: string; model?: string; thinkingLevel?: ThinkingLevel; cwd?: string; kind?: "chat" | "job" | "solo"; parent?: AgentId }) =>
    call<AgentSummary>("POST", "/api/agents", input),
  /** One agent as a role: purpose, where it runs, its board, memory, instructions and swarm (API.md, Agents). */
  agentConfig: (id: AgentId) => call<AgentConfig>("GET", `/api/agents/${enc(id)}/config`),
  /** The agent folder: its brief and its memory, which every thread of the agent loads (API.md, Agent folder). */
  agentFolder: (id: AgentId) => call<AgentFolder>("GET", `/api/agents/${enc(id)}/folder`),
  setBrief: (id: AgentId, text: string) => call<AgentFolder>("PUT", `/api/agents/${enc(id)}/brief`, { text }),
  addMemory: (id: AgentId, input: MemoryInput) => call<AgentFolder>("POST", `/api/agents/${enc(id)}/memory`, input),
  updateMemory: (id: AgentId, entry: string, input: MemoryInput, kind: HarnessEntryView["kind"] = "memory") =>
    call<AgentFolder>("PUT", `/api/agents/${enc(id)}/memory/${enc(entry)}${query({ kind })}`, input),
  deleteMemory: (id: AgentId, entry: string, kind: HarnessEntryView["kind"] = "memory") =>
    call<AgentFolder>("DELETE", `/api/agents/${enc(id)}/memory/${enc(entry)}${query({ kind })}`),
  projects: () => call<ProjectList>("GET", "/api/projects"),
  /** These act on an agent through its DM (`PATCH` and abort of `/api/c/dm_<slug>`), and on a job or a root thread through itself. */
  setAgentCwd: (id: AgentId, cwd: string) => call<ConversationHeader>("PATCH", `/api/c/${enc(roomOf(id))}`, { cwd }),
  setAgentModel: (id: AgentId, model: string, thinkingLevel?: ThinkingLevel) =>
    call<ConversationHeader>("PATCH", `/api/c/${enc(roomOf(id))}`, { model, ...(thinkingLevel ? { thinkingLevel } : {}) }),
  stopAgent: (id: AgentId) => call<{ ok: true }>("POST", `/api/c/${enc(roomOf(id))}/abort`),
  archiveAgent: (id: AgentId, archived = true) => call<ConversationHeader>("PATCH", `/api/c/${enc(roomOf(id))}`, { archived }),

  header: (id: ConversationId) => call<ConversationHeader>("GET", `/api/c/${enc(id)}`),
  items: (id: ConversationId, opts: { before?: string; after?: string; around?: string; limit?: number } = {}) =>
    call<TimelinePage>("GET", `/api/c/${enc(id)}/items${query(opts)}`),
  replies: (id: ConversationId, root: string) => call<{ root: Item; items: Item[] }>("GET", `/api/c/${enc(id)}/replies/${enc(root)}`),
  send: (id: ConversationId, request: SendRequest) => call<SendResult>("POST", `/api/c/${enc(id)}/send`, request),
  /** Tries a pending send that failed again now. */
  retrySend: (id: ConversationId, requestId: string) => call<SendResult>("POST", `/api/c/${enc(id)}/send/${enc(requestId)}/retry`),
  /** Drops a pending send that failed. */
  discardSend: (id: ConversationId, requestId: string) => call<{ ok: true }>("DELETE", `/api/c/${enc(id)}/send/${enc(requestId)}`),
  abort: (id: ConversationId) => call<{ ok: true }>("POST", `/api/c/${enc(id)}/abort`),
  patch: (id: ConversationId, patch: ConversationPatch) => call<ConversationHeader>("PATCH", `/api/c/${enc(id)}`, patch),
  rename: (id: ConversationId, name: string) => call<ConversationHeader>("PATCH", `/api/c/${enc(id)}`, { name }),
  archive: (id: ConversationId, archived = true) => call<ConversationHeader>("PATCH", `/api/c/${enc(id)}`, { archived }),
  read: (id: ConversationId, seq?: number) => call<{ ok: true }>("POST", `/api/c/${enc(id)}/read`, seq === undefined ? {} : { seq }),
  threadJobs: (thread: string) => call<JobNode[]>("GET", `/api/threads/${enc(thread)}/jobs`),
  openDm: (agent: AgentId) => call<ConversationSummary>("POST", "/api/dms", { agent }),

  /** Channels and Solo rooms; a DM is listed by agent, never here. */
  rooms: () => call<Room[]>("GET", "/api/rooms"),
  createRoom: (input: RoomInput) => call<Room>("POST", "/api/rooms", input),
  /** `closed` closes or reopens a Solo room. */
  updateRoom: (id: string, patch: RoomPatch) => call<Room>("PATCH", `/api/rooms/${enc(id)}`, patch),
  /** Only registered agents join; the server refuses a job, a work thread or a comm thread. */
  addMembers: (id: string, agents: AgentId[], wakeOn?: "mention" | "all" | "none") => call<Room>("POST", `/api/rooms/${enc(id)}/members`, { agents, ...(wakeOn ? { wakeOn } : {}) }),
  removeMember: (id: string, agent: AgentId) => call<Room>("DELETE", `/api/rooms/${enc(id)}/members/${enc(agent)}`),

  search: (params: SearchQuery) =>
    call<SearchResult>("GET", `/api/search${query({ ...params })}`),

  board: (chat: string) => call<BoardView>("GET", `${boardBase(chat)}/board`),
  boardOps: (chat: string, ops: BoardOp[]) => call<BoardView>("POST", `${boardBase(chat)}/board`, { ops }),
  /** Copies a Prime chat's board, duties and check-in interval into the thread it moved to. */
  importPrime: (chat: string, prime: string) =>
    call<{ board: boolean; duties: number; runs: number; checkInMs: number | null }>("POST", `/api/threads/${enc(chat)}/import-prime`, { prime }),
  chatAgents: (chat: string) => call<{ agents: ChatAgent[] }>("GET", `${boardBase(chat)}/agents`),
  duties: (chat: string) => call<{ duties: DutyRow[] }>("GET", `${boardBase(chat)}/duties`),
  dutyAction: (chat: string, action: DutyAction) => call<{ duties: DutyRow[] }>("POST", `${boardBase(chat)}/duties`, action),
  checkIn: (chat: string) => call<CheckInView>("GET", `${boardBase(chat)}/check-in`),
  setCheckIn: (chat: string, patch: CheckInPatch) => call<CheckInView>("POST", `${boardBase(chat)}/check-in`, patch),
  forYou: (signal?: AbortSignal) => call<{ items: ForYouItem[] }>("GET", "/api/for-you", undefined, signal),
  boards: () => call<BoardRow[]>("GET", "/api/boards"),

  usage: (opts: { days: number; thread?: string; host?: string }) => call<UsageReport>("GET", `/api/usage${query(opts)}`),
  pool: () => call<AccountsView>("GET", "/api/pool"),
  hosts: () => call<HostsReport>("GET", "/api/hosts"),
  corrections: () => call<{ corrections: unknown[] }>("GET", "/api/corrections"),
};
