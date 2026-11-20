/**
 * The typed HTTP client for every endpoint in apps/chat/API.md. Each call returns the parsed body or throws `ApiError` with the server's
 * message. Paths are relative, so the page works behind Vite's proxy on :5185 and from the server on :5184 alike.
 */
import type {
  AgentConfig, AgentFolder, AgentHostList, AgentId, AgentSummary, BoardOp, BoardRow, BoardView, CheckInPatch, CheckInView, ChatAgent, ConversationHeader, ConversationId,
  ConversationPatch, ConversationSummary, DutyAction, DutyRow, ForMeItem, ForMeList, ForMeStatus, ForYouItem, HarnessEntryView, HostsReport, ImageRef, Item, JobNode, Me, MemoryInput, ModelCatalog, ProjectList, SearchQuery, SearchResult, SendRequest,
  LaterItem, LaterList, LaterPatch, LaterRequest, LaterState, ReactionRequest, Room, RoomInput, RoomPatch, SendResult, Sidebar, StepOutputRef, ThinkingLevel, ThreadDoneRequest, TimelinePage, UsageReport, AccountsView,
} from "./types.ts";
import type { SkillDoc, SkillsReport } from "./shared/skills.ts";
import { shrink } from "./shrink.ts";

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
type Timing = { m: string; p: string; s: number; ms: number; net?: number; enc?: number; stored?: number; err?: string; shown?: true; wait?: Wait };

/**
 * What the owner saw while a call ran, which its caller sets and may change until the batch is posted. `ahead` is a read ahead of any
 * view, such as a room's page before he opens it; the caller clears it when a view starts to wait on the read. `shown` is a refresh behind
 * a page the screen already showed from the page's cache; the caller clears it when the answer changed what the screen showed, since he
 * waited for that. Without one the screen waited on the call. The speed duty reads it as `bg` (request-log.ts).
 */
export type Wait = {
  background?: "ahead" | "shown";
  /**
   * A send: `since` is his Enter and `shownMs` the time from it until the message's bubble was painted. The bubble, with Sending and any
   * image from the page, is all he waits for, so the line's `ms` is `shownMs`; the time from Enter until the server stored the message,
   * its uploads included, goes beside it as `stored` and is no wait of his.
   */
  since?: number;
  shownMs?: number;
  /** The ms an image's encode took before its upload (shrink.ts), logged beside the call as `enc`. */
  encodeMs?: number;
};

/**
 * The page's round trip to the server: the least network time of its last 20 calls, since the fastest handlers answer in about 1 ms
 * (replies 1.2 ms and read 2.3 ms in the 11-20 duty run).
 */
const recentNet: number[] = [];
const roundTripMs = (): number | undefined => (recentNet.length ? Math.min(...recentNet) : undefined);
const timings: Timing[] = [];
let timingsTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * Posts the batch. A batch that did not reach the server goes back in the queue, so a failure seen while the server restarts reaches the log
 * once it is back; the page's last batch goes as a beacon on pagehide.
 */
function sendTimings(beacon = false): void {
  clearTimeout(timingsTimer);
  timingsTimer = undefined;
  if (!timings.length) return;
  const samples = timings.splice(0);
  const body = JSON.stringify({ samples: samples.map(({ wait, ...sample }) => (wait?.background ? { ...sample, bg: wait.background } : sample)) });
  // The browser keeps 250 resource entries by default and then drops new ones, so each batch empties the buffer.
  performance.clearResourceTimings();
  if (beacon && navigator.sendBeacon?.("/api/timings", new Blob([body], { type: "application/json" }))) return;
  const requeue = () => {
    timings.unshift(...samples);
    timingsTimer ??= setTimeout(sendTimings, 10_000);
  };
  void fetch("/api/timings", { method: "POST", headers: { "content-type": "application/json" }, body, keepalive: true })
    .then(response => (response.status >= 500 ? requeue() : undefined), requeue);
}

/** The network time of the call to `path` that started at `started`, from its Resource Timing entry, if the browser has one. */
function networkMs(path: string, started: number): number | undefined {
  const entries = performance.getEntriesByName(new URL(path, location.href).href, "resource") as PerformanceResourceTiming[];
  const entry = entries.findLast(e => e.startTime >= started - 1);
  return entry && entry.responseEnd > 0 ? Math.round(entry.responseEnd - entry.startTime) : undefined;
}

/** Records one call; a failed call names its error and goes out at once, so the server log holds it beside the request it failed on. */
function recordTiming(m: string, path: string, s: number, started: number, err?: string, wait?: Wait): void {
  if (typeof window === "undefined") return;
  const net = networkMs(path, started);
  if (net !== undefined && s > 0) {
    recentNet.push(net);
    if (recentNet.length > 20) recentNet.shift();
  }
  const now = performance.now();
  timings.push({
    m, p: path.split("?")[0]!, s, ms: Math.round(wait?.shownMs ?? now - (wait?.since ?? started)), ...(net === undefined ? {} : { net }),
    ...(wait?.encodeMs === undefined ? {} : { enc: wait.encodeMs }), ...(wait?.since === undefined ? {} : { stored: Math.round(now - wait.since) }),
    ...(err ? { err } : {}), ...(wait ? { wait } : {}),
  });
  if (err) sendTimings();
  else timingsTimer ??= setTimeout(sendTimings, 10_000);
}

if (typeof window !== "undefined") addEventListener("pagehide", () => sendTimings(true));

/**
 * A send the page gave up on and showed as Not delivered, with the last call's status (0 when it never reached the server) and error. Each
 * failed call already has its own line, and a send that lands on a later try is no failure, so the speed duty counts only these lines.
 */
export function reportNotDelivered(conversation: ConversationId, status: number, err: string): void {
  if (typeof window === "undefined") return;
  timings.push({ m: "POST", p: `/api/c/${enc(conversation)}/send`, s: status, ms: 0, err, shown: true });
  sendTimings();
}

/**
 * A Blob body goes as its own bytes with its own type, any other body as JSON. A call that fails, refused by the server or never reaching
 * it, posts its error with its timing (`recordTiming`), so the server's log holds every failure the page shows, such as a Not delivered send.
 */
async function call<T>(method: string, path: string, body?: unknown, signal?: AbortSignal, wait?: Wait): Promise<T> {
  const started = performance.now();
  const blob = body instanceof Blob;
  let response: Response;
  let text: string;
  try {
    response = await fetch(path, {
      method,
      headers: body === undefined ? {} : { "content-type": blob ? body.type || "application/octet-stream" : "application/json" },
      ...(body === undefined ? {} : { body: blob ? body : JSON.stringify(body) }),
      ...(signal ? { signal } : {}),
    });
    text = await response.text();
  } catch (error) {
    if (!signal?.aborted) recordTiming(method, path, 0, started, error instanceof Error ? `${error.name}: ${error.message}` : String(error), wait);
    throw error;
  }
  let value: unknown;
  let error: string | undefined;
  try {
    value = text ? (JSON.parse(text) as unknown) : undefined;
  } catch {
    error = `${method} ${path} answered ${response.status} with a body that is not JSON`;
  }
  const failure = response.ok ? error : (value as { error?: string } | undefined)?.error ?? error ?? `${method} ${path} failed with ${response.status}`;
  recordTiming(method, path, response.status, started, failure, wait);
  if (failure !== undefined) throw response.ok ? new Error(failure) : new ApiError(response.status, failure);
  return value as T;
}

const query = (params: Record<string, string | number | boolean | undefined | null>): string => {
  const entries = Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== "") as [string, string | number | boolean][];
  return entries.length ? `?${entries.map(([k, v]) => `${enc(k)}=${enc(String(v))}`).join("&")}` : "";
};

/** A fresh id for `SendRequest.requestId`, so a retried send lands once. */
export const requestId = (): string => (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`);

/**
 * An image the owner attached. Its bytes, a PNG as a smaller WebP when that pays (`shrink`), go to POST /api/uploads the moment it is
 * attached, while he types, so the send names only the ref. `preview` shows it before the upload ends, `file` is what he attached, and
 * `ref()` is that upload, started again after a failure. The thumbnail and the sent message show without the upload, so its line is
 * background (`Wait`).
 */
export interface Attached { preview: string; mimeType: string; file: Blob; ref: () => Promise<ImageRef> }

export function attach(file: Blob): Attached {
  const smaller = shrink(file, roundTripMs());
  let upload: Promise<ImageRef> | undefined;
  const ref = (): Promise<ImageRef> => (upload ??= smaller.then(({ blob, encodeMs }) =>
    api.upload(blob, { background: "shown", ...(encodeMs === undefined ? {} : { encodeMs }) })).catch((error: unknown) => {
    upload = undefined;
    throw error;
  }));
  void ref().catch(() => undefined);
  return { preview: URL.createObjectURL(file), mimeType: file.type || "image/png", file, ref };
}

/**
 * A GET whose answer the page keeps and shows before it reads it again (kept.svelte.ts): its path and, in the type only, its answer.
 * `live` marks one the socket keeps current between reads, by the event that carries its whole answer.
 */
export interface Read<T> { readonly path: string; readonly live?: true; readonly answer?: T }
const read = <T>(path: string, live?: true): Read<T> => ({ path, ...(live ? { live } : {}) });
export const get = <T>(of: Read<T>, wait?: Wait): Promise<T> => call<T>("GET", of.path, undefined, undefined, wait);

/** The reads of the panels the owner opens: the Agents page, an agent's page, and a chat's board with its duties, check-in and jobs. */
export const reads = {
  agents: () => read<AgentSummary[]>("/api/agents"),
  models: () => read<ModelCatalog>("/api/models"),
  /** Channels and Solo rooms; a DM is listed by agent, never here. */
  rooms: () => read<Room[]>("/api/rooms"),
  boards: () => read<BoardRow[]>("/api/boards"),
  /** One agent as a role: purpose, where it runs, its board, memory, instructions and swarm (API.md, Agents). */
  agentConfig: (id: AgentId) => read<AgentConfig>(`/api/agents/${enc(id)}/config`),
  /** An agent's For list, newest activity first; the counts cover the whole list whatever `status` picks (API.md, For <agent>). */
  forMe: (agent: AgentId, status: ForMeStatus | "all" = "pending") => read<ForMeList>(`/api/agents/${enc(agent)}/for-me${query({ status })}`),
  board: (chat: string) => read<BoardView>(`${boardBase(chat)}/board`, true),
  duties: (chat: string) => read<{ duties: DutyRow[] }>(`${boardBase(chat)}/duties`, true),
  checkIn: (chat: string) => read<CheckInView>(`${boardBase(chat)}/check-in`),
  chatAgents: (chat: string) => read<{ agents: ChatAgent[] }>(`${boardBase(chat)}/agents`),
};

export const api = {
  me: () => call<Me>("GET", "/api/me"),
  sidebar: () => call<Sidebar>("GET", "/api/sidebar"),
  conversations: (opts: { archived?: boolean } = {}) => call<ConversationSummary[]>("GET", `/api/conversations${query({ archived: opts.archived ? 1 : undefined })}`),

  jobs: (opts: { archived?: boolean } = {}) => call<AgentSummary[]>("GET", `/api/jobs${query({ archived: opts.archived ? 1 : undefined })}`),
  /** A new agent with its work thread and DM room (`room`); `kind` "job" with a `parent` files a root thread under that agent as a job instead. */
  createAgent: (input: { name?: string; model?: string; thinkingLevel?: ThinkingLevel; cwd?: string; kind?: "chat" | "job"; parent?: AgentId; host?: string }) =>
    call<AgentSummary>("POST", "/api/agents", input),
  /** The boxes that run pi-host and can hold an agent, the chat's own box marked `self`, each up or away (agent-model.md phase 6). */
  agentHosts: () => call<AgentHostList>("GET", "/api/agent-hosts"),
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

  header: (id: ConversationId, wait?: Wait) => call<ConversationHeader>("GET", `/api/c/${enc(id)}`, undefined, undefined, wait),
  items: (id: ConversationId, opts: { before?: string; after?: string; around?: string; limit?: number } = {}, wait?: Wait) =>
    call<TimelinePage>("GET", `/api/c/${enc(id)}/items${query(opts)}`, undefined, undefined, wait),
  replies: (id: ConversationId, root: string, wait?: Wait) =>
    call<{ root: Item; items: Item[] }>("GET", `/api/c/${enc(id)}/replies/${enc(root)}`, undefined, undefined, wait),
  /** A tool step's output, which a page leaves out until the owner opens it. */
  stepOutput: (ref: StepOutputRef) => call<{ output: string }>("GET", `/api/c/${enc(ref.conversation)}/output/${ref.entry}`),
  /** Keeps an image's bytes on the server; a send names the ref it answers (`attach`). */
  upload: (file: Blob, wait?: Wait) => call<ImageRef>("POST", "/api/uploads", file, undefined, wait),
  send: (id: ConversationId, request: SendRequest, wait?: Wait) => call<SendResult>("POST", `/api/c/${enc(id)}/send`, request, undefined, wait),
  /** Tries a pending send that failed again now. */
  retrySend: (id: ConversationId, requestId: string) => call<SendResult>("POST", `/api/c/${enc(id)}/send/${enc(requestId)}/retry`),
  /** Drops a pending send that failed. */
  discardSend: (id: ConversationId, requestId: string) => call<{ ok: true }>("DELETE", `/api/c/${enc(id)}/send/${enc(requestId)}`),
  abort: (id: ConversationId) => call<{ ok: true }>("POST", `/api/c/${enc(id)}/abort`),
  /** Puts the owner's emoji on a room post, or with `on` false takes it off; the room's live `items` event carries the change too. */
  react: (id: ConversationId, post: string, emoji: string, on = true) =>
    call<{ item: Item }>("POST", `/api/c/${enc(id)}/posts/${enc(post)}/reactions`, { emoji, on } satisfies ReactionRequest),
  /** Marks the thread of a room post done, or with `done` false reopens it; the flag sits on the thread's root (server/thread-done.ts). */
  threadDone: (id: ConversationId, post: string, done: boolean) =>
    call<{ item: Item }>("POST", `/api/c/${enc(id)}/posts/${enc(post)}/done`, { done } satisfies ThreadDoneRequest),
  /** The owner's Save for later rows in one tab, newest first, with both tabs' counts (server/later.ts). */
  later: (state?: LaterState) => call<LaterList>("GET", `/api/later${query({ state })}`),
  /** Saves a room post for later; saving a saved post keeps its one item and opens it again when it was done. */
  saveLater: (room: ConversationId, post: string, remindAt?: number) =>
    call<{ item: LaterItem }>("POST", "/api/later", { room, post, ...(remindAt !== undefined ? { remindAt } : {}) } satisfies LaterRequest),
  /** Checks a saved post off (`done`) or opens it again, and sets or clears (`null`) its reminder. */
  patchLater: (id: string, patch: LaterPatch) => call<{ item: LaterItem }>("PATCH", `/api/later/${enc(id)}`, patch),
  /** Unsaves a post; unsaving one that is gone answers `{item: null}`. */
  unsaveLater: (id: string) => call<{ item: LaterItem | null }>("DELETE", `/api/later/${enc(id)}`),
  /** Slack's Edit message on the owner's own room post. */
  editPost: (id: ConversationId, post: string, text: string) => call<{ item: Item }>("PATCH", `/api/c/${enc(id)}/posts/${enc(post)}`, { text }),
  /** Slack's Delete message on the owner's own room post. */
  deletePost: (id: ConversationId, post: string) => call<{ item: Item }>("DELETE", `/api/c/${enc(id)}/posts/${enc(post)}`),
  patch: (id: ConversationId, patch: ConversationPatch) => call<ConversationHeader>("PATCH", `/api/c/${enc(id)}`, patch),
  rename: (id: ConversationId, name: string) => call<ConversationHeader>("PATCH", `/api/c/${enc(id)}`, { name }),
  archive: (id: ConversationId, archived = true) => call<ConversationHeader>("PATCH", `/api/c/${enc(id)}`, { archived }),
  read: (id: ConversationId, seq?: number) => call<{ ok: true }>("POST", `/api/c/${enc(id)}/read`, seq === undefined ? {} : { seq }),
  markUnread: (id: ConversationId, post: string) => call<{ ok: true }>("POST", `/api/c/${enc(id)}/read`, { unreadFrom: post }),
  threadJobs: (thread: string) => call<JobNode[]>("GET", `/api/threads/${enc(thread)}/jobs`),
  openDm: (agent: AgentId) => call<ConversationSummary>("POST", "/api/dms", { agent }),

  createRoom: (input: RoomInput) => call<Room>("POST", "/api/rooms", input),
  /** `closed` closes or reopens a Solo room. */
  updateRoom: (id: string, patch: RoomPatch) => call<Room>("PATCH", `/api/rooms/${enc(id)}`, patch),
  /** Only registered agents join; the server refuses a job, a work thread or a comm thread. */
  addMembers: (id: string, agents: AgentId[], wakeOn?: "all" | "none") => call<Room>("POST", `/api/rooms/${enc(id)}/members`, { agents, ...(wakeOn ? { wakeOn } : {}) }),
  removeMember: (id: string, agent: AgentId) => call<Room>("DELETE", `/api/rooms/${enc(id)}/members/${enc(agent)}`),

  search: (params: SearchQuery, options: { signal?: AbortSignal } = {}) =>
    call<SearchResult>("GET", `/api/search${query({ ...params, brief: params.brief ? 1 : undefined })}`, undefined, options.signal),
  /** The recent messages the Cmd K search matches in the page (pages/search/recent.ts), only those after `after` when given. */
  searchRecent: (params: { after?: number } = {}) => call<SearchResult>("GET", `/api/search/recent${query(params)}`, undefined, undefined, { background: "ahead" }),

  boardOps: (chat: string, ops: BoardOp[]) => call<BoardView>("POST", `${boardBase(chat)}/board`, { ops }),
  /** Copies a Prime chat's board, duties and check-in interval into the thread it moved to. */
  importPrime: (chat: string, prime: string) =>
    call<{ board: boolean; duties: number; runs: number; checkInMs: number | null }>("POST", `/api/threads/${enc(chat)}/import-prime`, { prime }),
  /** `result` says what a set or remove did, such as "added d3", "updated d1", "unchanged d1" or "removed d2". */
  dutyAction: (chat: string, action: DutyAction) => call<{ duties: DutyRow[]; result?: string }>("POST", `${boardBase(chat)}/duties`, action),
  setCheckIn: (chat: string, patch: CheckInPatch) => call<CheckInView>("POST", `${boardBase(chat)}/check-in`, patch),
  forYou: (signal?: AbortSignal) => call<{ items: ForYouItem[] }>("GET", "/api/for-you", undefined, signal),
  /** Marks one item, `<room id>/<post id>`, completed or pending again; the same mark twice changes nothing. */
  markForMe: (agent: AgentId, messageId: string, completed: boolean) =>
    call<{ item: ForMeItem; pending: number }>("POST", `/api/agents/${enc(agent)}/for-me`, { messageId, completed }),

  usage: (opts: { days: number; thread?: string; host?: string }) => call<UsageReport>("GET", `/api/usage${query(opts)}`),
  pool: () => call<AccountsView>("GET", "/api/pool"),
  hosts: () => call<HostsReport>("GET", "/api/hosts"),
  skills: (opts: { wait?: boolean } = {}) => call<SkillsReport>("GET", `/api/skills${opts.wait ? "?wait=1" : ""}`),
  skillDoc: (id: string) => call<SkillDoc>("GET", `/api/skills/doc?id=${enc(id)}`),
  corrections: () => call<{ corrections: unknown[] }>("GET", "/api/corrections"),
};
