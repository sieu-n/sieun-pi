/**
 * The Accounts calls (apps/chat/API.md, "Accounts"). The server runs pi-pool through the old chat's code (server/accounts.ts), and a
 * thread is named by any sw factory id: a conversation id, an agent id `ag_<slug>` or a DM room `dm_<slug>`, which the server reads as the
 * agent's work thread.
 */
import type { AccountAction, AccountLogin, AccountsView, PoolPriority, UsageRefresh } from "$lib/api/shared/types.ts";

export type Provider = "anthropic" | "openai-codex";

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  const value = text ? (JSON.parse(text) as unknown) : undefined;
  if (!response.ok) throw new Error((value as { error?: string } | undefined)?.error ?? `${method} ${path} failed with ${response.status}`);
  return value as T;
}

const query = (params: Record<string, string | null | undefined | boolean>): string => {
  const entries = Object.entries(params).filter((entry): entry is [string, string | true] => entry[1] !== undefined && entry[1] !== null && entry[1] !== "" && entry[1] !== false);
  return entries.length ? "?" + entries.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v === true ? "1" : v)}`).join("&") : "";
};

export const accountsApi = {
  /** The pool for one thread (its resolution, wait and class), or for no thread. `model` is the thread's model id, for a per-model window. */
  view: (opts: { thread?: string | null; model?: string | null; fresh?: boolean } = {}) =>
    call<AccountsView>("GET", "/api/accounts" + query({ thread: opts.thread, model: opts.model, fresh: opts.fresh })),
  /** Runs one action. `use` and `follow` name the thread in `id`; the answer is that thread's view with the action's notice. */
  action: (action: AccountAction) => call<AccountsView>("POST", "/api/accounts", action),
  priority: (thread: string, priority: PoolPriority) => call<AccountsView>("POST", "/api/accounts/priority", { thread, priority }),
  login: () => call<AccountLogin | null>("GET", "/api/accounts/login"),
  startLogin: (provider: Provider, account: string | null) => call<AccountLogin>("POST", "/api/accounts/login", { provider, account }),
  pasteLogin: (id: string, code: string) => call<AccountLogin>("POST", "/api/accounts/login/paste", { id, code }),
  cancelLogin: (id: string) => call<AccountLogin>("POST", "/api/accounts/login/cancel", { id }),
  refreshes: () => call<UsageRefresh[]>("GET", "/api/accounts/refresh"),
  startRefresh: (provider: Provider, account: string | null) => call<UsageRefresh>("POST", "/api/accounts/refresh", { provider, account }),
};
