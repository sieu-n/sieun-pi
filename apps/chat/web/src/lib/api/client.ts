/**
 * The typed HTTP client for every endpoint in apps/chat/API.md. Each call returns the parsed body or throws `ApiError` with the server's
 * message. Paths are relative, so the page works behind Vite's proxy on :5185 and from the server on :5184 alike.
 */
import type {
  AgentId, AgentSummary, BoardOp, BoardRow, BoardView, Channel, ChannelInput, CheckInPatch, CheckInView, ChatAgent, ConversationHeader, ConversationId,
  ConversationPatch, ConversationSummary, DutyAction, DutyView, ForYouItem, HostsReport, Item, JobNode, Me, ModelCatalog, SearchResult, SendRequest,
  SendResult, Sidebar, ThinkingLevel, TimelinePage, UsageReport, AccountsView,
} from "./types.ts";
import type { DutyCardModel } from "./shared/duty-card.ts";

export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/** A duty row as the server sends it: today's DutyView plus the card model and the judged last run. */
export type DutyRow = DutyView & { card: DutyCardModel; last: { verdict: string; at: number; streak: number; afterJob: boolean } | null };

const enc = encodeURIComponent;

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
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
  directory: () => call<{ agents: AgentSummary[]; channels: Channel[] }>("GET", "/api/directory"),
  models: () => call<ModelCatalog>("GET", "/api/models"),

  agents: (opts: { archived?: boolean } = {}) => call<AgentSummary[]>("GET", `/api/agents${query({ archived: opts.archived ? 1 : undefined })}`),
  /** A new root thread: `kind` "job" with a `parent` files it under that chat and lists it as a DM. */
  createAgent: (input: { name?: string; model?: string; thinkingLevel?: ThinkingLevel; cwd?: string; kind?: "chat" | "job"; parent?: AgentId }) =>
    call<AgentSummary>("POST", "/api/agents", input),
  setAgentModel: (id: AgentId, model: string, thinkingLevel?: ThinkingLevel) => call<ConversationHeader>("PATCH", `/api/c/${enc(id)}`, { model, ...(thinkingLevel ? { thinkingLevel } : {}) }),
  stopAgent: (id: AgentId) => call<{ ok: true }>("POST", `/api/c/${enc(id)}/abort`),
  archiveAgent: (id: AgentId, archived = true) => call<ConversationHeader>("PATCH", `/api/c/${enc(id)}`, { archived }),

  header: (id: ConversationId) => call<ConversationHeader>("GET", `/api/c/${enc(id)}`),
  items: (id: ConversationId, opts: { before?: string; after?: string; around?: string; limit?: number } = {}) =>
    call<TimelinePage>("GET", `/api/c/${enc(id)}/items${query(opts)}`),
  replies: (id: ConversationId, root: string) => call<{ root: Item; items: Item[] }>("GET", `/api/c/${enc(id)}/replies/${enc(root)}`),
  send: (id: ConversationId, request: SendRequest) => call<SendResult>("POST", `/api/c/${enc(id)}/send`, request),
  abort: (id: ConversationId) => call<{ ok: true }>("POST", `/api/c/${enc(id)}/abort`),
  patch: (id: ConversationId, patch: ConversationPatch) => call<ConversationHeader>("PATCH", `/api/c/${enc(id)}`, patch),
  rename: (id: ConversationId, name: string) => call<ConversationHeader>("PATCH", `/api/c/${enc(id)}`, { name }),
  archive: (id: ConversationId, archived = true) => call<ConversationHeader>("PATCH", `/api/c/${enc(id)}`, { archived }),
  read: (id: ConversationId, seq?: number) => call<{ ok: true }>("POST", `/api/c/${enc(id)}/read`, seq === undefined ? {} : { seq }),
  jobs: (thread: string) => call<JobNode[]>("GET", `/api/threads/${enc(thread)}/jobs`),
  openDm: (agent: AgentId) => call<ConversationSummary>("POST", "/api/dms", { agent }),

  channels: () => call<Channel[]>("GET", "/api/channels"),
  createChannel: (input: ChannelInput) => call<Channel>("POST", "/api/channels", input),
  updateChannel: (id: string, patch: { name?: string; purpose?: string; archived?: boolean; homeChat?: string | null }) => call<Channel>("PATCH", `/api/channels/${enc(id)}`, patch),
  addMembers: (id: string, agents: AgentId[], wakeOn?: "mention" | "all" | "none") => call<Channel>("POST", `/api/channels/${enc(id)}/members`, { agents, ...(wakeOn ? { wakeOn } : {}) }),
  removeMember: (id: string, agent: AgentId) => call<Channel>("DELETE", `/api/channels/${enc(id)}/members/${enc(agent)}`),

  search: (params: { q: string; from?: string; in?: string; after?: string; before?: string; sort?: "relevance" | "recent"; limit?: number; cursor?: string }) =>
    call<SearchResult>("GET", `/api/search${query(params)}`),

  board: (chat: string) => call<BoardView>("GET", `/api/threads/${enc(chat)}/board`),
  boardOps: (chat: string, ops: BoardOp[]) => call<BoardView>("POST", `/api/threads/${enc(chat)}/board`, { ops }),
  chatAgents: (chat: string) => call<{ agents: ChatAgent[] }>("GET", `/api/threads/${enc(chat)}/agents`),
  duties: (chat: string) => call<{ duties: DutyRow[] }>("GET", `/api/threads/${enc(chat)}/duties`),
  dutyAction: (chat: string, action: DutyAction) => call<{ duties: DutyRow[] }>("POST", `/api/threads/${enc(chat)}/duties`, action),
  checkIn: (chat: string) => call<CheckInView>("GET", `/api/threads/${enc(chat)}/check-in`),
  setCheckIn: (chat: string, patch: CheckInPatch) => call<CheckInView>("POST", `/api/threads/${enc(chat)}/check-in`, patch),
  forYou: () => call<{ items: ForYouItem[] }>("GET", "/api/for-you"),
  boards: () => call<BoardRow[]>("GET", "/api/boards"),

  usage: (opts: { days: number; thread?: string; host?: string }) => call<UsageReport>("GET", `/api/usage${query(opts)}`),
  pool: () => call<AccountsView>("GET", "/api/pool"),
  hosts: () => call<HostsReport>("GET", "/api/hosts"),
  corrections: () => call<{ corrections: unknown[] }>("GET", "/api/corrections"),
};
