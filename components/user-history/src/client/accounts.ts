import { api } from "./api.ts";
import type { AccountsView, PoolAccount, PoolProvider } from "../shared/types.ts";

const MAX_AGE_MS = 60_000;
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

export const PROVIDER_LABEL: Record<PoolProvider["provider"], string> = { anthropic: "Anthropic", "openai-codex": "OpenAI Codex" };

export type AccountState = "seat" | "live" | "available" | "depleted" | "cooldown" | "needs-reauth" | "unavailable";
export const STATE_LABEL: Record<AccountState, { label: string; tone: "accent" | "success" | "muted" | "warning" | "danger" }> = {
  seat: { label: "Seat", tone: "accent" },
  live: { label: "Live", tone: "success" },
  available: { label: "Available", tone: "muted" },
  depleted: { label: "Depleted", tone: "warning" },
  cooldown: { label: "Cooldown", tone: "warning" },
  "needs-reauth": { label: "Needs reauth", tone: "danger" },
  unavailable: { label: "Unavailable", tone: "muted" },
};

export function accountState(row: PoolAccount): AccountState {
  if (row.reason === "needs-reauth") return "needs-reauth";
  if (row.reason === "depleted") return "depleted";
  if (row.reason?.startsWith("cooldown")) return "cooldown";
  if (row.live || row.reason === "live-elsewhere") return "live";
  if (row.seat) return "seat";
  return row.usable ? "available" : "unavailable";
}

export function stateDetail(row: PoolAccount): string | null {
  if (row.reason?.startsWith("cooldown")) return row.reason;
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
  seat: "it holds the pool seat",
  session_pin: "it is pinned for this thread",
  session: "it is pinned for this thread",
  force: "it was forced for this thread",
  forced: "it was forced for this thread",
  pin: "it is pinned for all sessions",
  pinned: "it is pinned for all sessions",
  follow: "the thread follows the pool",
};

export function reasonText(reason: string | null): string | null {
  if (!reason) return null;
  return REASON_TEXT[reason] ?? reason.replaceAll("_", " ");
}

/** One sentence for the drawer header: what this thread resolves to and why. */
export function resolutionSentence(provider: PoolProvider): string {
  const label = PROVIDER_LABEL[provider.provider];
  const resolution = provider.resolution;
  if (!resolution) return provider.error ? provider.error : `Pool resolution for ${label} is unavailable.`;
  if (resolution.email) {
    const why = reasonText(resolution.reason);
    return `This thread uses ${resolution.email}` + (why ? ` because ${why}.` : ".");
  }
  return resolution.pinned ? `The pinned ${label} account is unavailable, so no account resolves for this thread right now.` : `No ${label} account resolves for this thread right now.`;
}
