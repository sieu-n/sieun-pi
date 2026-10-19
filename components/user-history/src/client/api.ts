import type { AccountAction, AccountLogin, AgentQueueInput, AgentQueueView, AccountsView, BoardOp, ChatBoard, ChatDefaults, ChatDefaultsInput, HostsView, RemoteAccessInput, RemoteAccessView, SdkView, SlackChannelOption, SlackChannelSetup, SlackChatInput, SlackInput, SlackView, ChildUsage, Command, ImageInput, LabelAction, SkillsView, ToolsView, ModelCatalog, NewChatAccount, OlderPage, SendMode, SessionRow, SessionsDelta, SessionsEvent, ThreadEvent, ThreadHave, ThreadStats, UsageRefresh, Workspace } from "../shared/types.ts";

import type { NewChatSettings } from "../shared/start-skill.ts";
import type { OutboxAccepted } from "../shared/outbox.ts";
import type { PromptView } from "../shared/prompt-view.ts";
import { subscribeFeed } from "./feeds.ts";
import type { MessageKey } from "../shared/message-key.ts";
import type { ThreadSide } from "../shared/thread-side.ts";
import { agentsHave, applyAgentsFrame, applySessionsDelta, sessionsHave, type AgentsDelta, type AgentsView } from "../shared/sessions-delta.ts";
import { readFeed } from "./usage.ts";
import type { UsageBucket, UsageFeed, UsageGroup, UsageMetric, UsageModelRow, UsageSeries, UsageWindow } from "../shared/usage.ts";

const token = document.body.dataset.chatToken ?? "";

export type LocalFile = { path: string; text: string } & ({ kind: "markdown" } | { kind: "diff" } | { kind: "code"; language: string });
/** A wiki page as the service reads it (readWikiPage): its own HTML, drawn in a sandboxed frame, or its markdown, rendered as a reply; `dir` is its folder on this Mac. */
export type WikiPage = { path: string; title: string; url: string; dir: string } & ({ kind: "html"; html: string } | { kind: "markdown"; text: string });

export class ApiError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

async function parse<T>(response: Response): Promise<T> {
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message = typeof body === "object" && body !== null && "error" in body && typeof body.error === "string" ? body.error : `HTTP ${response.status}`;
    throw new ApiError(response.status, message);
  }
  return body as T;
}

export async function get<T>(route: string, timeoutMs = 20000): Promise<T> {
  return parse<T>(await fetch(route, { signal: AbortSignal.timeout(timeoutMs) }));
}

export async function post<T>(route: string, body: unknown, timeoutMs = 60000, headers: Record<string, string> = {}): Promise<T> {
  return parse<T>(await fetch(route, { method: "POST", headers: { ...headers, "Content-Type": "application/json", "X-Chat-Token": token }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) }));
}

/** Marks a check-in change as the owner's own, made on this page (src/chat-server.ts checkInActor); an agent's call without it is an agent's. */
export const OWNER_UI_HEADERS = { "X-Chat-Owner-Ui": "1" };

export function requestId(): string {
  return crypto.randomUUID().replaceAll("-", "") + Date.now().toString(36);
}

const WIKI_PAGE_TTL = 30_000;
const wikiPages = new Map<string, { at: number; page: Promise<WikiPage> }>();

export const api = {
  /**
   * The sessions list, without archived rows unless `archived` (src/shared/sessions-delta.ts `withoutArchived`). The event's `archived` counts
   * the archived rows either way.
   */
  sessionsStream(archived: boolean, onEvent: (event: SessionsEvent & { archived: number }) => void, onError: () => void, onBuild: (build: { version: string; assets?: string[] }) => void): () => void {
    /** The list this subscription holds; a reconnect names its rows (`sessionsHave`), and the server sends only the rows that differ. */
    let rows: SessionRow[] = [];
    return subscribeFeed(() => { const have = sessionsHave(rows); return { feed: "sessions", delta: true, ...(archived ? { archived: true as const } : {}), ...(have ? { have } : {}) }; }, (event, data) => {
      if (event === "build") { onBuild(data as { version: string; assets?: string[] }); return; }
      if (event !== "sessions") return;
      const frame = data as SessionsEvent | SessionsDelta;
      rows = frame.type === "sessions" ? frame.sessions : applySessionsDelta(rows, frame);
      onEvent({ type: "sessions", sessions: rows, tags: frame.tags, daemon: frame.daemon, ...(frame.error !== undefined ? { error: frame.error } : {}),
        archived: frame.archived ?? rows.filter(row => row.archived).length });
    }, onError);
  },
  /**
   * The agents of a chat, or of the chat a job's session belongs to, while a page shows them; the sessions feed leaves them out. The feed
   * sends the agents that changed, and a reconnect names the agents this feed holds (`agentsHave`), so it gets only what changed since.
   */
  agentsStream(id: string, onView: (view: AgentsView) => void): () => void {
    let view: AgentsView | null = null;
    return subscribeFeed(() => { const have = view ? agentsHave(view.agents) : undefined; return { feed: "agents", id, delta: true, ...(have ? { have } : {}) }; }, (event, data) => {
      if (event !== "agents") return;
      view = applyAgentsFrame(view, data as AgentsView | AgentsDelta);
      onView(view);
    });
  },
  /** `onSide` gets the feed's `side` frames: what the view shows beside the messages, pushed after the snapshot (shared/thread-side.ts). */
  threadStream(id: string, onEvent: (event: ThreadEvent) => void, onError: () => void, onSide: (side: ThreadSide) => void = () => {}, have: () => ThreadHave | undefined = () => undefined): () => void {
    const stop = subscribeFeed(() => { const held = have(); return { feed: "thread", id, delta: true, ...(held ? { have: held } : {}) }; }, (event, data) => {
      if (event === "side") { onSide(data as ThreadSide); return; }
      if (event !== "thread") return;
      const parsed = data as ThreadEvent;
      if (parsed.type === "status" && parsed.connection === "closed" && parsed.error) stop();
      onEvent(parsed);
    }, onError);
    return stop;
  },
  workspaces: () => get<{ workspaces: Workspace[] }>("api/workspaces").then(body => body.workspaces),
  resolveWorkspace: (path: string) => post<{ cwd: string }>("api/workspaces/resolve", { path }).then(body => body.cwd),
  chooseFolder: (start: string) => post<{ cwd: string | null }>("api/workspaces/choose", { start }, 11 * 60_000).then(body => body.cwd),
  models: (id: string | null) => get<ModelCatalog>("api/models" + (id ? "?id=" + encodeURIComponent(id) : ""), 30000),
  defaults: () => get<ChatDefaults>("api/defaults"),
  setDefaults: (input: ChatDefaultsInput) => post<ChatDefaults>("api/defaults", input),
  newChat: () => get<NewChatSettings>("api/new-chat"),
  setNewChat: (input: NewChatSettings) => post<NewChatSettings>("api/new-chat", input),
  remote: () => get<RemoteAccessView>("api/remote"),
  setRemote: (input: RemoteAccessInput) => post<RemoteAccessView>("api/remote", input, 60000),
  checkRemote: () => post<RemoteAccessView>("api/remote/check", {}, 60000),
  slack: () => get<SlackView | null>("api/slack"),
  setSlack: (input: SlackInput) => post<SlackView>("api/slack", input, 60000),
  checkSlack: () => post<SlackView>("api/slack/check", {}, 60000),
  slackChannels: () => get<{ channels: SlackChannelOption[] | null }>("api/slack/channels", 30000).then(body => body.channels),
  slackChat: (id: string, input: SlackChatInput) => post<SlackView>("api/threads/" + encodeURIComponent(id) + "/slack", input, 60000),
  hosts: () => get<HostsView>("api/hosts"),
  agentQueue: () => get<AgentQueueView>("api/agent-queue"),
  setAgentQueue: (input: AgentQueueInput) => post<AgentQueueView>("api/agent-queue", input),
  tools: () => get<ToolsView>("api/tools", 120000),
  checkTools: () => post<ToolsView>("api/tools/check", {}, 120000),
  skills: () => get<SkillsView>("api/skills"),
  sdk: () => get<SdkView | null>("api/sdk"),
  updateSdk: () => post<SdkView>("api/sdk", { action: "update" }),
  setSdkAuto: (auto: boolean) => post<SdkView>("api/sdk", { action: "auto", auto }),
  updateChats: () => post<{ chats: number }>("api/chats/update", {}),
  commands: (id: string | null) => get<{ commands: Command[] }>(id ? "api/threads/" + encodeURIComponent(id) + "/commands" : "api/commands", 30000).then(body => body.commands),
  childUsage: (id: string) => get<{ children: ChildUsage[] }>("api/threads/" + encodeURIComponent(id) + "/child-usage").then(body => body.children),
  /** The whole label of each job the feed sent cut (`ChildAgent.labelMore`), by job id. */
  /** A sidebar row's prefetched first frames (`primeThread`). */
  firstFrame: async (id: string): Promise<unknown[]> => parse<unknown[]>(await fetch("api/threads/" + encodeURIComponent(id) + "/first-frame", { priority: "low", signal: AbortSignal.timeout(20000) })),
  childLabels: (id: string) => get<{ labels: Record<string, string> }>("api/threads/" + encodeURIComponent(id) + "/child-labels").then(body => body.labels),
  stats: (id: string) => get<ThreadStats>("api/threads/" + encodeURIComponent(id) + "/stats"),
  promptView: (id: string, via: readonly string[] = []) =>
    get<PromptView>("api/threads/" + encodeURIComponent(id) + "/prompt" + (via.length ? "?via=" + via.map(encodeURIComponent).join(",") : ""), 60000),
  nextDutyBrief: (chat: string, duty: string) => get<PromptView>("api/threads/" + encodeURIComponent(chat) + "/duty-brief?duty=" + encodeURIComponent(duty), 60000),
  toolOutput: (id: string, toolCallId: string) => get<{ toolCallId: string; toolName: string; arguments: unknown; output: string; isError: boolean | null }>(
    "api/threads/" + encodeURIComponent(id) + "/tool-output?toolCallId=" + encodeURIComponent(toolCallId)),
  /** Part `part` of the message `key` names (`messageKey` of an index into the loaded messages), whole: the snapshot clips long parts. */
  part: (id: string, key: MessageKey, part: number) => get<{ text: string }>("api/threads/" + encodeURIComponent(id) + `/part?at=${key.at}&n=${key.n}&part=${part}`),
  accounts: (id: string | null, model: string | null = null) => {
    const query = new URLSearchParams({ ...(id ? { id } : {}), ...(model ? { model } : {}) }).toString();
    return get<AccountsView>("api/accounts" + (query ? "?" + query : ""), 30000);
  },
  accountAction: (action: AccountAction) => post<AccountsView>("api/accounts", action, 100000, OWNER_UI_HEADERS),
  loginStream(onLogin: (login: AccountLogin | null) => void): () => void {
    return subscribeFeed({ feed: "login" }, (event, data) => { if (event === "login") onLogin(data as AccountLogin | null); });
  },
  refreshStream(onRefresh: (refresh: UsageRefresh) => void): () => void {
    return subscribeFeed({ feed: "refresh" }, (event, data) => { if (event === "refresh") onRefresh(data as UsageRefresh); });
  },
  startRefresh: (provider: string, account: string | null) => post<UsageRefresh>("api/accounts/refresh", { provider, account }),
  /**
   * Settings > Usage and the sidebar Throughput line: the throughput of every box from LGTM, or the error that kept it, pushed every 5 s while
   * subscribed (`src/shared/usage.ts`). `onUnreadable` gets a payload from a server build whose shape this page does not know (see `readFeed`); a
   * reload fixes it.
   */
  usageStream(onFeed: (feed: UsageFeed) => void, onError: () => void = () => {}, onUnreadable: () => void = () => {}): () => void {
    return subscribeFeed({ feed: "usage" }, (event, data) => {
      if (event !== "usage") return;
      const feed = readFeed(data);
      if (feed) onFeed(feed); else onUnreadable();
    }, onError);
  },
  usageSeries: (window: UsageWindow, bucket: UsageBucket, group: UsageGroup, metric: UsageMetric) => get<UsageSeries>(`api/usage/series?window=${window}&bucket=${bucket}&group=${group}&metric=${metric}`, 30000),
  usageModels: (window: UsageWindow) => get<{ models: UsageModelRow[] }>(`api/usage/models?window=${window}`, 30000).then(body => body.models),
  startLogin: (provider: string, account: string | null) => post<AccountLogin>("api/accounts/login", { provider, account }),
  pasteLogin: (id: string, code: string) => post<AccountLogin>("api/accounts/login/paste", { id, code }),
  cancelLogin: (id: string) => post<AccountLogin>("api/accounts/login/cancel", { id }),
  createThread: (input: { cwd: string; host?: string; name?: string; kind?: "chat"; slack?: SlackChannelSetup; provider?: string; modelId?: string; thinkingLevel?: string; account?: NewChatAccount; message: string; images: ImageInput[]; requestId: string }) =>
    post<{ id: string; notice?: string }>("api/threads", input, 120000),
  warm: (id: string) => post<{ ok: true }>("api/warm", { id }),
  prompt: (id: string, input: { message: string; images: ImageInput[]; mode: SendMode; requestId: string }) =>
    post<OutboxAccepted>("api/threads/" + encodeURIComponent(id) + "/prompt", input, 120000),
  abort: (id: string) => post<{ ok: true }>("api/threads/" + encodeURIComponent(id) + "/abort", {}),
  /** Reads the thread's whole session file; the thread's stream then sends a snapshot with every message. */
  olderPage: (id: string, cursor: string) => get<OlderPage>("api/threads/" + encodeURIComponent(id) + "/older?cursor=" + encodeURIComponent(cursor), 60000),
  unarchive: (id: string) => post<{ ok: true }>("api/threads/" + encodeURIComponent(id) + "/unarchive", {}, 60000),
  archive: (id: string) => post<{ ok: true }>("api/threads/" + encodeURIComponent(id) + "/archive", {}, 60000),
  rename: (id: string, name: string) => post<{ ok: true }>("api/threads/" + encodeURIComponent(id) + "/rename", { name }),
  setModel: (id: string, provider: string, modelId: string) => post<{ ok: true }>("api/threads/" + encodeURIComponent(id) + "/model", { provider, modelId }),
  setThinking: (id: string, level: string) => post<{ ok: true }>("api/threads/" + encodeURIComponent(id) + "/thinking", { level }),
  queue: (id: string, input: { lane: "steering" | "followUp"; index: number; expectedText: string; text?: string }) =>
    post<{ status: string; error?: string }>("api/threads/" + encodeURIComponent(id) + "/queue", input),
  labels: (action: LabelAction) => post<{ ok: true; tagId?: string }>("api/labels", action),
  read: (id: string) => post<{ ok: true }>("api/threads/" + encodeURIComponent(id) + "/read", {}),
  boardNow: (id: string) => get<{ board: ChatBoard | null }>("api/threads/" + encodeURIComponent(id) + "/board").then(body => body.board),
  board: (id: string, ops: BoardOp[]) => post<ChatBoard>("api/threads/" + encodeURIComponent(id) + "/board", { ops }),
  /** A text file on this Mac, for a `file:` artifact link (readLocalText: any UTF-8 text under the allowed folders), with how to show it. */
  localFile: (path: string) => get<LocalFile>("api/local-file?path=" + encodeURIComponent(path)),
  /** An llm-wiki page, fetched by the service from the wiki dev server (or its file), for a `wiki:` link or a report's linked page. The card and the reader ask within seconds of each other, so one answer serves both for a while. */
  wikiPage: (path: string): Promise<WikiPage> => {
    const cached = wikiPages.get(path);
    if (cached && cached.at > Date.now() - WIKI_PAGE_TTL) return cached.page;
    const page = get<WikiPage>("api/wiki-page?path=" + encodeURIComponent(path), 8000);
    wikiPages.set(path, { at: Date.now(), page });
    page.catch(() => wikiPages.delete(path));
    return page;
  },
};
