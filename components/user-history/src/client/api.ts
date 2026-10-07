import type { AccountAction, AccountLogin, AccountsView, BoardOp, ChatBoard, ChatDefaults, ChatDefaultsInput, RemoteAccessInput, RemoteAccessView, SdkView, ChildUsage, Command, ImageInput, LabelAction, ModelCatalog, NewChatAccount, SendMode, SessionsEvent, ThreadEvent, ThreadNote, ThreadStats, UsageRefresh, Workspace } from "../shared/types.ts";

import { subscribeFeed } from "./feeds.ts";

const token = document.body.dataset.chatToken ?? "";

export type LocalFile = { path: string; text: string } & ({ kind: "markdown" } | { kind: "diff" } | { kind: "code"; language: string });
export interface WikiPage { path: string; title: string; url: string; text: string; headings: string[] }

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
  sdk: () => get<SdkView | null>("api/sdk"),
  updateSdk: () => post<SdkView>("api/sdk", { action: "update" }),
  setSdkAuto: (auto: boolean) => post<SdkView>("api/sdk", { action: "auto", auto }),
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
  startLogin: (provider: string, account: string | null) => post<AccountLogin>("api/accounts/login", { provider, account }),
  pasteLogin: (id: string, code: string) => post<AccountLogin>("api/accounts/login/paste", { id, code }),
  cancelLogin: (id: string) => post<AccountLogin>("api/accounts/login/cancel", { id }),
  createThread: (input: { cwd: string; name?: string; kind?: "chat"; provider?: string; modelId?: string; thinkingLevel?: string; account?: NewChatAccount; message: string; images: ImageInput[]; requestId: string }) =>
    post<{ id: string }>("api/threads", input, 120000),
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
  /** An llm-wiki page's text, fetched by the service from the wiki dev server, for a `wiki:` artifact link. */
  wikiPage: (path: string) => get<WikiPage>("api/wiki-page?path=" + encodeURIComponent(path), 8000),
};
