import { api } from "./api.ts";
import type { AccountsView, PoolAccount, PoolProvider, PoolWindow } from "../shared/types.ts";

const MAX_AGE_MS = 60_000;
const STALE_USAGE_MS = 20 * 60_000;
const cache = new Map<string, { at: number; view: AccountsView }>();
const inflight = new Map<string, Promise<AccountsView>>();

const key = (id: string | null): string => id ?? "";

export function loadAccounts(id: string | null, options: { fresh?: boolean } = {}): Promise<AccountsView> {
  const cached = cache.get(key(id));
  if (cached && !options.fresh && Date.now() - cached.at < MAX_AGE_MS) return Promise.resolve(cached.view);
  const pending = inflight.get(key(id));
  if (pending) return pending;
  const request = api.accounts(id).then(view => { rememberAccounts(id, view); return view; }).finally(() => inflight.delete(key(id)));
  inflight.set(key(id), request);
  return request;
}

export function rememberAccounts(id: string | null, view: AccountsView): void {
  cache.set(key(id), { at: Date.now(), view });
}

export function forgetAccounts(): void { cache.clear(); }

export const PROVIDER_LABEL: Record<PoolProvider["provider"], string> = { anthropic: "Claude", "openai-codex": "Codex" };

export type Tone = "accent" | "success" | "muted" | "warning" | "danger";
export type AccountState = "off" | "needs-login" | "refused" | "cooldown" | "depleted" | "pinned" | "seat" | "live";
export const STATE_LABEL: Record<AccountState, { label: string; tone: Tone }> = {
  off: { label: "Off", tone: "muted" },
  "needs-login": { label: "Needs login", tone: "danger" },
  refused: { label: "Refused", tone: "danger" },
  cooldown: { label: "Cooldown", tone: "warning" },
  depleted: { label: "Depleted", tone: "warning" },
  pinned: { label: "Pinned", tone: "accent" },
  seat: { label: "Seat", tone: "accent" },
  live: { label: "Live", tone: "success" },
};

/** The one badge a row shows: what stops it serving first, else its role in the pool. A ready account shows none. */
export function accountState(row: PoolAccount): AccountState | null {
  if (row.disabled) return "off";
  if (row.reason === "needs-reauth") return "needs-login";
  if (row.reason?.startsWith("cooldown")) return row.cooldownReason ? "refused" : "cooldown";
  if (row.reason === "depleted") return "depleted";
  if (row.pinned) return "pinned";
  if (row.seat) return "seat";
  if (row.live || row.reason === "live-elsewhere") return "live";
  return null;
}

/** The provider whose account this thread draws on: the model's provider, else the first provider with a resolution, else the first. */
export function threadProvider(view: AccountsView, modelProvider: string | undefined): PoolProvider | undefined {
  return view.providers.find(entry => entry.provider === modelProvider) ?? view.providers.find(entry => entry.resolution?.email) ?? view.providers[0];
}

/** The account `pi-pool who` resolves for this thread on this provider; never falls back to a guess. */
export function resolvedAccount(provider: PoolProvider): PoolAccount | undefined {
  const account = provider.resolution?.account;
  return account ? provider.rows.find(row => row.id === account) : undefined;
}

const REASON_TEXT: Record<string, string> = {
  session_pin: "pinned for this thread",
  pool_pin: "pinned for all sessions",
  seat: "pool seat",
  seat_upgrade: "higher plan than the seat",
  seat_move: "best available account",
};

export function reasonText(reason: string | null): string | null {
  if (!reason) return null;
  return REASON_TEXT[reason] ?? reason.replaceAll("_", " ");
}

/** "This thread uses X (reason)" for the Accounts header. */
export function resolutionSentence(provider: PoolProvider): string {
  const label = PROVIDER_LABEL[provider.provider];
  const resolution = provider.resolution;
  if (!resolution) return provider.error ?? `The ${label} pool did not say which account this thread uses.`;
  if (resolution.email) {
    const why = reasonText(resolution.reason);
    return `This thread uses ${resolution.email}` + (why ? ` (${why}).` : ".");
  }
  return resolution.pinned ? `The pinned ${label} account cannot serve, and no other ${label} account can.` : `No ${label} account can serve this thread right now.`;
}

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
