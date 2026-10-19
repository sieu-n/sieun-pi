import { api } from "./api.ts";
import type { AccountsView, PoolAccount, PoolConfig, PoolPriority, PoolProvider, PoolWindow } from "../shared/types.ts";
import { poolValue } from "./pool-config.ts";

const MAX_AGE_MS = 60_000;
const STALE_USAGE_MS = 20 * 60_000;
const cache = new Map<string, { at: number; view: AccountsView }>();
const inflight = new Map<string, Promise<AccountsView>>();

const key = (id: string | null, model?: string | null): string => (id ?? "") + "|" + (model ?? "");

/** `model` is the model id the chat runs: the pool then judges a per-model cap (Fable) for that model only. */
export function loadAccounts(id: string | null, options: { fresh?: boolean; model?: string | null } = {}): Promise<AccountsView> {
  const model = options.model ?? null;
  const cached = cache.get(key(id, model));
  if (cached && !options.fresh && Date.now() - cached.at < MAX_AGE_MS) return Promise.resolve(cached.view);
  const pending = inflight.get(key(id, model));
  if (pending) return pending;
  const request = api.accounts(id, model).then(view => { rememberAccounts(id, view, model); return view; }).finally(() => inflight.delete(key(id, model)));
  inflight.set(key(id, model), request);
  return request;
}

/** A row's model (`<provider>/<id>`) as the model id the thread's info names, so the chip asks with one key before and after the snapshot. */
export const rowModelId = (model: string | undefined): string | undefined => model === undefined ? undefined : model.slice(model.indexOf("/") + 1);

/**
 * The last answer for the thread and model at any age, else the thread's newest answer for another model (the feed judges a thread before its
 * model is known), so a switch back paints the chip at once while `loadAccounts` refreshes it.
 */
export function cachedAccounts(id: string | null, model: string | null = null): AccountsView | undefined {
  const exact = cache.get(key(id, model));
  if (exact) return exact.view;
  let newest: { at: number; view: AccountsView } | undefined;
  for (const [name, entry] of cache) if (name.startsWith(key(id)) && (!newest || entry.at > newest.at)) newest = entry;
  return newest?.view;
}

export function rememberAccounts(id: string | null, view: AccountsView, model: string | null = null): void {
  cache.set(key(id, model), { at: Date.now(), view });
}

export function forgetAccounts(): void { cache.clear(); }

export const PROVIDER_LABEL: Record<PoolProvider["provider"], string> = { anthropic: "Claude", "openai-codex": "Codex" };

export type Tone = "accent" | "success" | "muted" | "warning" | "danger";
export type AccountState = "off" | "needs-login" | "needs-terms" | "refused" | "cooldown" | "limited" | "depleted" | "pinned";
/** The pool's cooldown reason for an account whose updated Consumer Terms are not accepted on claude.ai yet (pi-pool's pool/base.py NEEDS_TERMS). */
export const NEEDS_TERMS = "needs terms";
export const STATE_LABEL: Record<AccountState, { label: string; tone: Tone }> = {
  off: { label: "Off", tone: "muted" },
  "needs-login": { label: "Needs login", tone: "danger" },
  "needs-terms": { label: "Needs terms", tone: "danger" },
  refused: { label: "Refused", tone: "danger" },
  cooldown: { label: "Cooldown", tone: "warning" },
  limited: { label: "Limited", tone: "warning" },
  depleted: { label: "Depleted", tone: "warning" },
  pinned: { label: "Pinned", tone: "accent" },
};

/** The one badge a row shows: what stops it serving first, else its role in the pool. A ready account shows none. */
export function accountState(row: PoolAccount): AccountState | null {
  if (row.disabled) return "off";
  if (row.reason === "needs-reauth") return "needs-login";
  if (row.reason?.startsWith("cooldown")) return row.cooldownReason === NEEDS_TERMS ? "needs-terms" : row.cooldownReason ? "refused" : "cooldown";
  if (row.reason?.startsWith("limited")) return "limited";
  if (row.reason === "depleted") return "depleted";
  if (row.pinned) return "pinned";
  return null;
}

/** The provider whose account this thread draws on: the model's provider, else the first provider with a resolution, else the first. */
export function threadProvider(view: AccountsView, modelProvider: string | undefined): PoolProvider | undefined {
  return view.providers.find(entry => entry.provider === modelProvider) ?? view.providers.find(entry => entry.resolution?.email) ?? view.providers[0];
}

/** The intended manual account, or the account the pool resolves in Auto. */
export function resolvedAccount(provider: PoolProvider): PoolAccount | undefined {
  const selection = provider.resolution?.selection;
  const account = selection?.mode === "manual" ? selection.account_id : provider.resolution?.account;
  return account ? provider.rows.find(row => row.id === account) : undefined;
}

export function isManualAccount(provider: PoolProvider, account: string): boolean {
  const selection = provider.resolution?.selection;
  return selection?.mode === "manual" && selection.account_id === account;
}

const REASON_TEXT: Record<string, string> = {
  session_pin: "pinned for this thread",
  pool_pin: "pinned for all sessions",
};

export function reasonText(reason: string | null): string | null {
  if (!reason) return null;
  return REASON_TEXT[reason] ?? reason.replaceAll("_", " ");
}

/** "15:42", or "Oct 14 15:42" when the time is not today. */
export function clockText(ms: number, now = Date.now()): string {
  const at = new Date(ms);
  const time = at.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
  return at.toDateString() === new Date(now).toDateString() ? time : `${at.toLocaleDateString(undefined, { month: "short", day: "numeric" })} ${time}`;
}

/** The Accounts header: the account the pool holds this thread for and when it comes back, else the account it uses and why. */
export function resolutionSentence(provider: PoolProvider, now = Date.now()): string {
  const label = PROVIDER_LABEL[provider.provider];
  const resolution = provider.resolution;
  if (resolution?.selection.mode === "manual") {
    const account = resolvedAccount(provider)?.label ?? resolution.selection.account_id;
    const scope = provider.poolPin === resolution.selection.account_id ? " for all sessions" : " for this thread";
    const wait = provider.wait ? provider.wait.slotAt > now ? ` Admission waits until ${clockText(provider.wait.slotAt, now)}.` : " Admission is due now." : "";
    return `Manual keeps ${account} selected${scope}.` + (resolution.error ? ` ${resolution.error}` : "") + wait;
  }
  if (resolution?.error) return resolution.error;
  if (provider.wait) {
    const account = provider.rows.find(row => row.id === provider.wait!.account)?.label ?? provider.wait.account;
    return provider.wait.slotAt > now ? `Waiting for ${account}, back at ${clockText(provider.wait.slotAt, now)}.` : `Waiting for ${account}, due back now.`;
  }
  if (!resolution) return provider.error ?? `The ${label} pool did not say which account this thread uses.`;
  if (resolution.email) {
    const why = reasonText(resolution.reason);
    return `Auto uses ${resolvedAccount(provider)?.label ?? resolution.email}` + (why ? ` (${why}).` : ".");
  }
  return `No ${label} account can serve this thread right now.`;
}

export const POOL_PRIORITY_LABEL: Record<PoolPriority, string> = { high: "High priority", normal: "Normal priority", low: "Low priority" };
/** Why a thread has its pool class, for the tooltip on it. */
export const POOL_PRIORITY_HINT = "The pool admits high threads first and holds low ones for the emptiest accounts. A chat is high, a job takes its chat's priority, " +
  "a check-in job is normal and every other duty run is low. The thread's priority label overrides it: High is high, Medium is normal, Low is low.";

/** "3h 46m", "2d 5h", "12m", "<1m". */
export function span(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "<1m";
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  if (days) return hours ? `${days}d ${hours}h` : `${days}d`;
  if (hours) return `${hours}h ${minutes % 60}m`;
  return `${minutes}m`;
}

export const resetText = (window: PoolWindow, now = Date.now()): string | null =>
  window.resetsAt && window.resetsAt > now ? "resets in " + span(window.resetsAt - now) : null;

/** "5h", "Week", "30d", "Fable": the header a window gets in the account table and the chip. */
export const windowLabel = (window: PoolWindow): string => window.label === "week" ? "Week" : window.label;

/** Column keys for one provider's table: every window any account has, session first, then weekly, then per model. */
export function windowColumns(rows: PoolAccount[]): string[] {
  const order: Record<PoolWindow["kind"], number> = { session: 0, weekly: 1, model: 2 };
  const seen = new Map<string, PoolWindow["kind"]>();
  for (const row of rows) for (const window of row.windows) if (!seen.has(windowLabel(window))) seen.set(windowLabel(window), window.kind);
  return [...seen].sort((a, b) => order[a[1]] - order[b[1]]).map(([label]) => label);
}

/** Usage older than pi-pool's own stale mark, as "Usage from 4d ago", else null. */
export function staleText(row: PoolAccount, now = Date.now()): string | null {
  if (!row.usageAt) return row.windows.length ? null : "Usage never read";
  return now - row.usageAt > STALE_USAGE_MS ? `Usage from ${span(now - row.usageAt)} ago` : null;
}

export const meterTone = (pct: number): "low" | "mid" | "high" => pct >= 90 ? "high" : pct >= 70 ? "mid" : "low";

/** "28 threads" for a row the pool counts in use, with the window it counts over; null when no thread used it. */
export function threadsText(row: PoolAccount, config: PoolConfig | null | undefined): { label: string; hint: string } | null {
  if (!row.sessions) return null;
  const one = row.sessions === 1;
  const minutes = Math.round(poolValue(config, "active_session_sec") / 60);
  return { label: `${row.sessions} thread${one ? "" : "s"}`,
    hint: `${row.sessions} thread${one ? " (with its jobs)" : "s (with their jobs)"} sent a request through this account in the last ${minutes} min.` };
}
