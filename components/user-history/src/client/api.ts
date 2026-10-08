import type { AccountAction, AccountLogin, AccountsView, BoardOp, ChatBoard, ChatDefaults, ChatDefaultsInput, RemoteAccessInput, RemoteAccessView, SdkView, SlackInput, SlackView, ChildUsage, Command, ImageInput, LabelAction, ModelCatalog, NewChatAccount, SendMode, SessionsEvent, ThreadEvent, ThreadNote, ThreadStats, UsageRefresh, Workspace } from "../shared/types.ts";

import { subscribeFeed } from "./feeds.ts";
import { readSummary } from "./usage.ts";
import type { UsageBucket, UsageGroup, UsageMetric, UsageModelRow, UsageSeries, UsageSummary, UsageWindow } from "../shared/usage.ts";

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

export async function post<T>(route: string, body: unknown, timeoutMs = 60000): Promise<T> {
  return parse<T>(await fetch(route, { method: "POST", headers: { "Content-Type": "application/json", "X-Chat-Token": token }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) }));
}

export function requestId(): string {
  return crypto.randomUUID().replaceAll("-", "") + Date.now().toString(36);
}

const WIKI_PAGE_TTL = 30_000;
const wikiPages = new Map<string, { at: number; page: Promise<WikiPage> }>();

export const api = {
  sessionsStream(onEvent: (event: SessionsEvent) => void, onError: () => void, onBuild: (version: string) => void): () => void {
    return subscribeFeed({ feed: "sessions" }, (event, data) => {
      if (event === "build") onBuild((data as { version: string }).version);
      else if (event === "sessions") onEvent(data as SessionsEvent);
    }, onError);
  },
  threadStream(id: string, onEvent: (event: ThreadEvent) => void, onError: () => void): () => void {
    const stop = subscribeFeed({ feed: "thread", id }, (event, data) => {
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
  remote: () => get<RemoteAccessView>("api/remote"),
  setRemote: (input: RemoteAccessInput) => post<RemoteAccessView>("api/remote", input, 60000),
  checkRemote: () => post<RemoteAccessView>("api/remote/check", {}, 60000),
  slack: () => get<SlackView | null>("api/slack"),
  setSlack: (input: SlackInput) => post<SlackView>("api/slack", input, 60000),
  checkSlack: () => post<SlackView>("api/slack/check", {}, 60000),
  setChatSlack: (id: string, on: boolean) => post<SlackView>("api/threads/" + encodeURIComponent(id) + "/slack", { on }, 60000),
  sdk: () => get<SdkView | null>("api/sdk"),
  updateSdk: () => post<SdkView>("api/sdk", { action: "update" }),
  setSdkAuto: (auto: boolean) => post<SdkView>("api/sdk", { action: "auto", auto }),
  updateChats: () => post<{ chats: number }>("api/chats/update", {}),
  commands: (id: string | null) => get<{ commands: Command[] }>(id ? "api/threads/" + encodeURIComponent(id) + "/commands" : "api/commands", 30000).then(body => body.commands),
  childUsage: (id: string) => get<{ children: ChildUsage[] }>("api/threads/" + encodeURIComponent(id) + "/child-usage").then(body => body.children),
  stats: (id: string) => get<ThreadStats>("api/threads/" + encodeURIComponent(id) + "/stats"),
  toolOutput: (id: string, toolCallId: string) => get<{ toolCallId: string; toolName: string; arguments: unknown; output: string; isError: boolean | null }>(
    "api/threads/" + encodeURIComponent(id) + "/tool-output?toolCallId=" + encodeURIComponent(toolCallId)),
  part: (id: string, message: number, part: number) => get<{ text: string }>("api/threads/" + encodeURIComponent(id) + `/part?message=${message}&part=${part}`),
  accounts: (id: string | null, model: string | null = null) => {
    const query = new URLSearchParams({ ...(id ? { id } : {}), ...(model ? { model } : {}) }).toString();
    return get<AccountsView>("api/accounts" + (query ? "?" + query : ""), 30000);
  },
  note: (id: string) => get<ThreadNote>("api/threads/" + encodeURIComponent(id) + "/note"),
  setNote: (id: string, text: string) => post<ThreadNote>("api/threads/" + encodeURIComponent(id) + "/note", { text }),
  accountAction: (action: AccountAction) => post<AccountsView>("api/accounts", action, 100000),
  loginStream(onLogin: (login: AccountLogin | null) => void): () => void {
    return subscribeFeed({ feed: "login" }, (event, data) => { if (event === "login") onLogin(data as AccountLogin | null); });
  },
  refreshStream(onRefresh: (refresh: UsageRefresh) => void): () => void {
    return subscribeFeed({ feed: "refresh" }, (event, data) => { if (event === "refresh") onRefresh(data as UsageRefresh); });
  },
  startRefresh: (provider: string, account: string | null) => post<UsageRefresh>("api/accounts/refresh", { provider, account }),
  /**
   * Settings > Usage: the rolling throughput summary, pushed about every 2 s while subscribed (`src/shared/usage.ts`). `onUnreadable` gets a
   * summary from a server build whose shape this page does not know (see `readSummary`); a reload fixes it.
   */
  usageStream(onSummary: (summary: UsageSummary) => void, onError: () => void = () => {}, onUnreadable: () => void = () => {}): () => void {
    return subscribeFeed({ feed: "usage" }, (event, data) => {
      if (event !== "usage") return;
      const summary = readSummary(data);
      if (summary) onSummary(summary); else onUnreadable();
    }, onError);
  },
  usageSummary: () => get<UsageSummary>("api/usage/summary"),
  usageSeries: (window: UsageWindow, bucket: UsageBucket, group: UsageGroup, metric: UsageMetric) => get<UsageSeries>(`api/usage/series?window=${window}&bucket=${bucket}&group=${group}&metric=${metric}`, 30000),
  usageModels: (window: UsageWindow) => get<{ models: UsageModelRow[] }>(`api/usage/models?window=${window}`, 30000).then(body => body.models),
  startLogin: (provider: string, account: string | null) => post<AccountLogin>("api/accounts/login", { provider, account }),
  pasteLogin: (id: string, code: string) => post<AccountLogin>("api/accounts/login/paste", { id, code }),
  cancelLogin: (id: string) => post<AccountLogin>("api/accounts/login/cancel", { id }),
  createThread: (input: { cwd: string; name?: string; kind?: "chat"; slack?: boolean; provider?: string; modelId?: string; thinkingLevel?: string; account?: NewChatAccount; message: string; images: ImageInput[]; requestId: string }) =>
    post<{ id: string; notice?: string }>("api/threads", input, 120000),
  warm: (id: string) => post<{ ok: true }>("api/warm", { id }),
  prompt: (id: string, input: { message: string; images: ImageInput[]; mode: SendMode; requestId: string }) =>
    post<{ accepted: true }>("api/threads/" + encodeURIComponent(id) + "/prompt", input, 120000),
  abort: (id: string) => post<{ ok: true }>("api/threads/" + encodeURIComponent(id) + "/abort", {}),
  unarchive: (id: string) => post<{ ok: true }>("api/threads/" + encodeURIComponent(id) + "/unarchive", {}, 60000),
  archive: (id: string) => post<{ ok: true }>("api/threads/" + encodeURIComponent(id) + "/archive", {}, 60000),
  rename: (id: string, name: string) => post<{ ok: true }>("api/threads/" + encodeURIComponent(id) + "/rename", { name }),
  setModel: (id: string, provider: string, modelId: string) => post<{ ok: true }>("api/threads/" + encodeURIComponent(id) + "/model", { provider, modelId }),
  setThinking: (id: string, level: string) => post<{ ok: true }>("api/threads/" + encodeURIComponent(id) + "/thinking", { level }),
  queue: (id: string, input: { lane: "steering" | "followUp"; index: number; expectedText: string; text?: string }) =>
    post<{ status: string; error?: string }>("api/threads/" + encodeURIComponent(id) + "/queue", input),
  labels: (action: LabelAction) => post<{ ok: true; tagId?: string }>("api/labels", action),
  read: (id: string) => post<{ ok: true }>("api/threads/" + encodeURIComponent(id) + "/read", {}),
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
