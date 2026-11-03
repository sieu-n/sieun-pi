/**
 * The typed HTTP client for every endpoint in apps/chat/API.md. Each call returns the parsed body or throws `ApiError` with the server's
 * message. Paths are relative, so the page works behind Vite's proxy on :5185 and from the server on :5184 alike.
 */
import type {
  AgentConfig, AgentFolder, AgentHostList, AgentId, AgentSummary, BoardOp, BoardRow, BoardView, CheckInPatch, CheckInView, ChatAgent, ConversationHeader, ConversationId,
  ConversationPatch, ConversationSummary, DutyAction, DutyRow, ForMeItem, ForMeList, ForMeStatus, ForYouItem, HarnessEntryView, HostsReport, ImageRef, Item, JobNode, Me, MemoryInput, ModelCatalog, ProjectList, SearchQuery, SearchResult, SendRequest,
  ReactionRequest, Room, RoomInput, RoomPatch, SendResult, Sidebar, ThinkingLevel, TimelinePage, UsageReport, AccountsView,
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

/**
 * How long the page waited for each call, posted in batches to POST /api/timings for the daily speed duty (server/request-log.ts). It holds
 * what the server's own timing misses: the network and the wait while another request blocks the server. `net` is the browser's own
 * network time for the call (Resource Timing, start to the last byte), so the duty can tell it from the time the page's main thread was
 * busy before it could send the call or read the answer: on 11-03 a thread open in the box Chrome waited 2,135 ms for /api/rooms, of which
 * the network and the server took 29 ms.
 */
const timings: { m: string; p: string; s: number; ms: number; net?: number }[] = [];
let timingsTimer: ReturnType<typeof setTimeout> | undefined;

function sendTimings(): void {
  clearTimeout(timingsTimer);
  timingsTimer = undefined;
  if (!timings.length) return;
  const body = JSON.stringify({ samples: timings.splice(0) });
  if (!navigator.sendBeacon?.("/api/timings", new Blob([body], { type: "application/json" }))) {
    void fetch("/api/timings", { method: "POST", headers: { "content-type": "application/json" }, body, keepalive: true }).catch(() => {});
  }
  // The browser keeps 250 resource entries by default and then drops new ones, so each batch empties the buffer.
  performance.clearResourceTimings();
}

/** The network time of the call to `path` that started at `started`, from its Resource Timing entry, if the browser has one. */
function networkMs(path: string, started: number): number | undefined {
  const entries = performance.getEntriesByName(new URL(path, location.href).href, "resource") as PerformanceResourceTiming[];
  const entry = entries.findLast(e => e.startTime >= started - 1);
  return entry && entry.responseEnd > 0 ? Math.round(entry.responseEnd - entry.startTime) : undefined;
}

function recordTiming(m: string, path: string, s: number, started: number): void {
  if (typeof window === "undefined") return;
  const net = networkMs(path, started);
  timings.push({ m, p: path.split("?")[0]!, s, ms: Math.round(performance.now() - started), ...(net === undefined ? {} : { net }) });
  timingsTimer ??= setTimeout(sendTimings, 10_000);
}

if (typeof window !== "undefined") addEventListener("pagehide", sendTimings);

/** A Blob body goes as its own bytes with its own type, any other body as JSON. */
async function call<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const started = performance.now();
  const blob = body instanceof Blob;
  const response = await fetch(path, {
    method,
    headers: body === undefined ? {} : { "content-type": blob ? body.type || "application/octet-stream" : "application/json" },
    ...(body === undefined ? {} : { body: blob ? body : JSON.stringify(body) }),
    ...(signal ? { signal } : {}),
  });
  const text = await response.text();
  recordTiming(method, path, response.status, started);
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

/**
 * An image the owner attached. Its bytes go to POST /api/uploads the moment it is attached, while he types, so the send names only the ref
 * and answers at once. `preview` shows it before the upload ends, and `ref()` is that upload, started again after a failure.
 */
export interface Attached { preview: string; mimeType: string; ref: () => Promise<ImageRef> }

export function attach(file: Blob): Attached {
  let upload: Promise<ImageRef> | undefined;
  const ref = (): Promise<ImageRef> => (upload ??= api.upload(file).catch((error: unknown) => {
    upload = undefined;
    throw error;
  }));
  void ref().catch(() => undefined);
  return { preview: URL.createObjectURL(file), mimeType: file.type || "image/png", ref };
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
  createAgent: (input: { name?: string; model?: string; thinkingLevel?: ThinkingLevel; cwd?: string; kind?: "chat" | "job" | "solo"; parent?: AgentId; host?: string }) =>
    call<AgentSummary>("POST", "/api/agents", input),
  /** The boxes that run pi-host and can hold an agent, the chat's own box marked `self`, each up or away (agent-model.md phase 6). */
  agentHosts: () => call<AgentHostList>("GET", "/api/agent-hosts"),
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
  /** Keeps an image's bytes on the server; a send names the ref it answers (`attach`). */
  upload: (file: Blob) => call<ImageRef>("POST", "/api/uploads", file),
  send: (id: ConversationId, request: SendRequest) => call<SendResult>("POST", `/api/c/${enc(id)}/send`, request),
  /** Tries a pending send that failed again now. */
  retrySend: (id: ConversationId, requestId: string) => call<SendResult>("POST", `/api/c/${enc(id)}/send/${enc(requestId)}/retry`),
  /** Drops a pending send that failed. */
  discardSend: (id: ConversationId, requestId: string) => call<{ ok: true }>("DELETE", `/api/c/${enc(id)}/send/${enc(requestId)}`),
  abort: (id: ConversationId) => call<{ ok: true }>("POST", `/api/c/${enc(id)}/abort`),
  /** Puts the owner's emoji on a room post, or with `on` false takes it off; the room's live `items` event carries the change too. */
  react: (id: ConversationId, post: string, emoji: string, on = true) =>
    call<{ item: Item }>("POST", `/api/c/${enc(id)}/posts/${enc(post)}/reactions`, { emoji, on } satisfies ReactionRequest),
  /** Slack's Edit message on the owner's own room post. */
  editPost: (id: ConversationId, post: string, text: string) => call<{ item: Item }>("PATCH", `/api/c/${enc(id)}/posts/${enc(post)}`, { text }),
  /** Slack's Delete message on the owner's own room post. */
  deletePost: (id: ConversationId, post: string) => call<{ item: Item }>("DELETE", `/api/c/${enc(id)}/posts/${enc(post)}`),
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
  addMembers: (id: string, agents: AgentId[], wakeOn?: "all" | "none") => call<Room>("POST", `/api/rooms/${enc(id)}/members`, { agents, ...(wakeOn ? { wakeOn } : {}) }),
  removeMember: (id: string, agent: AgentId) => call<Room>("DELETE", `/api/rooms/${enc(id)}/members/${enc(agent)}`),

  search: (params: SearchQuery, options: { signal?: AbortSignal } = {}) =>
    call<SearchResult>("GET", `/api/search${query({ ...params })}`, undefined, options.signal),

  board: (chat: string) => call<BoardView>("GET", `${boardBase(chat)}/board`),
  boardOps: (chat: string, ops: BoardOp[]) => call<BoardView>("POST", `${boardBase(chat)}/board`, { ops }),
  /** Copies a Prime chat's board, duties and check-in interval into the thread it moved to. */
  importPrime: (chat: string, prime: string) =>
    call<{ board: boolean; duties: number; runs: number; checkInMs: number | null }>("POST", `/api/threads/${enc(chat)}/import-prime`, { prime }),
  chatAgents: (chat: string) => call<{ agents: ChatAgent[] }>("GET", `${boardBase(chat)}/agents`),
  duties: (chat: string) => call<{ duties: DutyRow[] }>("GET", `${boardBase(chat)}/duties`),
  /** `result` says what a set or remove did, such as "added d3", "updated d1", "unchanged d1" or "removed d2". */
  dutyAction: (chat: string, action: DutyAction) => call<{ duties: DutyRow[]; result?: string }>("POST", `${boardBase(chat)}/duties`, action),
  checkIn: (chat: string) => call<CheckInView>("GET", `${boardBase(chat)}/check-in`),
  setCheckIn: (chat: string, patch: CheckInPatch) => call<CheckInView>("POST", `${boardBase(chat)}/check-in`, patch),
  forYou: (signal?: AbortSignal) => call<{ items: ForYouItem[] }>("GET", "/api/for-you", undefined, signal),
  /** An agent's For list, newest activity first; the counts cover the whole list whatever `status` picks (API.md, For <agent>). */
  forMe: (agent: AgentId, status: ForMeStatus | "all" = "pending") => call<ForMeList>("GET", `/api/agents/${enc(agent)}/for-me${query({ status })}`),
  /** Marks one item, `<room id>/<post id>`, completed or pending again; the same mark twice changes nothing. */
  markForMe: (agent: AgentId, messageId: string, completed: boolean) =>
    call<{ item: ForMeItem; pending: number }>("POST", `/api/agents/${enc(agent)}/for-me`, { messageId, completed }),
  boards: () => call<BoardRow[]>("GET", "/api/boards"),

  usage: (opts: { days: number; thread?: string; host?: string }) => call<UsageReport>("GET", `/api/usage${query(opts)}`),
  pool: () => call<AccountsView>("GET", "/api/pool"),
  hosts: () => call<HostsReport>("GET", "/api/hosts"),
  corrections: () => call<{ corrections: unknown[] }>("GET", "/api/corrections"),
};
