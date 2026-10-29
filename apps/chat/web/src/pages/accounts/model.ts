/**
 * What the Accounts tab, the account chip and the picker show, as pure functions of pi-pool's AccountsView. Ported from the old chat's
 * accounts helpers (legacy/prime/user-history/src/client/accounts.ts and the row notes and reset rules in AccountsSettings.svelte).
 */
import type { AccountResets, PoolAccount, PoolConfig, PoolPriority, PoolProvider, PoolWindow, ResetGrant } from "$lib/api/shared/types.ts";

export type { PoolAccount, PoolProvider, PoolWindow };
export type ProviderId = PoolProvider["provider"];

export const PROVIDER_LABEL: Record<ProviderId, string> = { anthropic: "Claude", "openai-codex": "Codex" };

/** The path segment of each provider's page, `#/accounts/claude` and `#/accounts/codex`. */
export const PROVIDER_SLUG: Record<ProviderId, string> = { anthropic: "claude", "openai-codex": "codex" };

export function providerFromSlug(slug: string | undefined): ProviderId | null {
  return (Object.keys(PROVIDER_SLUG) as ProviderId[]).find((id) => PROVIDER_SLUG[id] === slug) ?? null;
}

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

/** The provider whose account a thread draws on: the model's provider, else the first provider with a resolution, else the first. */
export function threadProvider(providers: readonly PoolProvider[], modelProvider: string | null | undefined): PoolProvider | undefined {
  return providers.find(entry => entry.provider === modelProvider) ?? providers.find(entry => entry.resolution?.email) ?? providers[0];
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

const REASON_TEXT: Record<string, string> = { session_pin: "pinned for this thread", pool_pin: "pinned for all sessions" };
export function reasonText(reason: string | null | undefined): string | null {
  if (!reason) return null;
  return REASON_TEXT[reason] ?? reason.replaceAll("_", " ");
}

/** "15:42" in the browser's time zone, or "Oct 14 15:42" when the time is not today. */
export function clockText(ms: number, now = Date.now()): string {
  const at = new Date(ms);
  const time = at.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
  return at.toDateString() === new Date(now).toDateString() ? time : `${at.toLocaleDateString(undefined, { month: "short", day: "numeric" })} ${time}`;
}

/** The thread's sentence: the account the pool holds it for and when it comes back, else the account it uses and why. */
export function resolutionSentence(provider: PoolProvider, now = Date.now()): string {
  const label = PROVIDER_LABEL[provider.provider];
  const resolution = provider.resolution;
  if (resolution?.selection.mode === "manual") {
    const account = resolvedAccount(provider)?.label ?? resolution.selection.account_id;
    const scope = provider.poolPin === resolution.selection.account_id ? " for all sessions" : " for this thread";
    const wait = provider.wait ? (provider.wait.slotAt > now ? ` Admission waits until ${clockText(provider.wait.slotAt, now)}.` : " Admission is due now.") : "";
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
export const POOL_PRIORITY_HINT = "The pool admits high threads first and holds low ones for the emptiest accounts. A new thread is normal until you set its class here.";

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

/** "5h", "Week", "30d", "Fable": a window's header in the table and its label in a meter. */
export const windowLabel = (window: PoolWindow): string => (window.label === "week" ? "Week" : window.label);

/** Column keys for one provider's table: every window any account has, session first, then weekly, then per model. */
export function windowColumns(rows: readonly PoolAccount[]): string[] {
  const order: Record<PoolWindow["kind"], number> = { session: 0, weekly: 1, model: 2 };
  const seen = new Map<string, PoolWindow["kind"]>();
  for (const row of rows) for (const window of row.windows) if (!seen.has(windowLabel(window))) seen.set(windowLabel(window), window.kind);
  return [...seen].sort((a, b) => order[a[1]] - order[b[1]]).map(([label]) => label);
}

/** Usage older than pi-pool's own stale mark (20 min), as "Usage from 4d ago", else null. */
export function staleText(row: PoolAccount, now = Date.now()): string | null {
  if (!row.usageAt) return row.windows.length ? null : "Usage never read";
  return now - row.usageAt > 20 * 60_000 ? `Usage from ${span(now - row.usageAt)} ago` : null;
}

export const meterTone = (pct: number): "low" | "mid" | "high" => (pct >= 90 ? "high" : pct >= 70 ? "mid" : "low");

/** A per-model window (Fable) only for the model the thread runs; `model` is its id and name. */
export const shownWindows = (windows: readonly PoolWindow[], model?: string | null): PoolWindow[] =>
  windows.filter(window => window.kind !== "model" || (model ?? "").toLowerCase().includes(windowLabel(window).toLowerCase()));

/** "28 threads" for a row the pool counts in use, with the window it counts over; null when no thread used it. */
export function threadsText(row: PoolAccount, config: PoolConfig | null | undefined): { label: string; hint: string } | null {
  if (!row.sessions) return null;
  const one = row.sessions === 1;
  const minutes = Math.round((config?.["active_session_sec"] ?? 3600) / 60);
  return {
    label: `${row.sessions} thread${one ? "" : "s"}`,
    hint: `${row.sessions} thread${one ? " (with its jobs)" : "s (with their jobs)"} sent a request through this account in the last ${minutes} min.`,
  };
}

export const planText = (row: PoolAccount): string | null => {
  const plan = row.plan ?? row.tier;
  return plan ? plan.charAt(0).toUpperCase() + plan.slice(1) : null;
};

const RANK: Record<AccountState | "ready", number> = { pinned: 1, ready: 2, depleted: 3, limited: 3, cooldown: 4, refused: 4, "needs-terms": 4, "needs-login": 5, off: 6 };
/** Rows in table order: the thread's account first, then pinned, ready, spent, refused, needs login, off, each by label. */
export function sortedRows(provider: PoolProvider): PoolAccount[] {
  const rank = (row: PoolAccount): number =>
    isManualAccount(provider, row.id) || row.id === provider.resolution?.account ? 0 : RANK[accountState(row) ?? "ready"];
  return [...provider.rows].sort((a, b) => rank(a) - rank(b) || a.label.localeCompare(b.label));
}

export const RESET_WINDOW: Record<string, string> = { five_hour: "5h", seven_day: "week", seven_day_overage_included: "overage" };
const INELIGIBLE: Record<string, string> = {
  tenure: "the account is too new", tier: "the plan has none", seat: "team seats have none", surface: "this client cannot see them",
  cli_version: "the Claude Code version is too old", no_grant: "no reset was granted", config_off: "resets are off", mobile: "mobile only",
  other_experiment: "another experiment", unavailable: "unavailable",
};
/** Claims with an unknown outcome can be retried with the same request id for this long; pi-pool enforces it too. */
export const RESET_RETRY_MS = 10 * 60_000;
const day = (ms: number): string => new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });

/** The grant `pi-pool reset` would spend: Anthropic's pick when it can be spent, else the first usable one. Mirrors grant_blocker in pi-pool's pool/limit_resets.py. */
export function usableGrant(resets: AccountResets | null | undefined, now = Date.now()): ResetGrant | undefined {
  if (!resets?.eligible || (resets.cooldownUntil && resets.cooldownUntil > now)) return undefined;
  const usable = resets.grants
    .filter(grant => !grant.paused && grant.usableNow && grant.resetsLeft > 0 && (!grant.useRequiresLimit || resets.atLimit)
      && (!grant.startsAt || grant.startsAt <= now) && (!grant.endsAt || grant.endsAt > now))
    .sort((a, b) => a.id.localeCompare(b.id));
  return usable.find(grant => grant.id === resets.nextGrantId) ?? usable[0];
}

export const pendingReset = (resets: AccountResets | null | undefined, now = Date.now()) =>
  resets?.pending && now - resets.pending.createdAt < RESET_RETRY_MS ? resets.pending : null;

/** One note about a Claude account's banked resets, or null when they were never read. */
export function resetNote(resets: AccountResets | null | undefined, now = Date.now()): string | null {
  if (!resets) return null;
  const checked = resets.checkedAt ? ` Checked ${span(now - resets.checkedAt)} ago.` : "";
  if (resets.pending) {
    return now - resets.pending.createdAt < RESET_RETRY_MS
      ? `A reset claim got no answer, so a reset may be spent. Use reset within ${span(resets.pending.createdAt + RESET_RETRY_MS - now)} to retry the same claim.`
      : "A reset claim got no answer. Use reset again to check the count; it sends nothing new if the reset was spent.";
  }
  const failed = resets.error ? ` Last check failed: ${resets.error.replace(/\.$/, "")}.` : "";
  if (resets.eligible === null) return `Resets not read: ${resets.error ?? "unknown error"}.`;
  if (!resets.eligible) return `No banked resets: ${INELIGIBLE[resets.ineligibleReason ?? ""] ?? resets.ineligibleReason ?? "not eligible"}.` + checked + failed;
  const left = resets.grants.reduce((sum, grant) => sum + grant.resetsLeft, 0);
  if (!left) return "No banked resets left." + checked + failed;
  const grant = usableGrant(resets, now) ?? resets.grants.find(entry => entry.resetsLeft > 0)!;
  const ends = grant.endsAt ? ` Expires ${day(grant.endsAt)}.` : "";
  return `${left} banked reset${left === 1 ? "" : "s"} left${grant.label ? `: ${grant.label}` : ""}.${ends}` + (usableGrant(resets, now) ? "" : " Not usable right now.") + checked + failed;
}

/** The plain-words notes under a row. `unread` is the reason a usage read of this row just failed, if one did. */
export function rowNotes(row: PoolAccount, now = Date.now(), unread: string | null = null): string[] {
  const state = accountState(row);
  const notRead = unread ? [`Not read: ${unread.replace(/\.$/, "")}.`] : [];
  if (state === "off") return ["Off excludes this account from Auto. Manual can still use it.", ...notRead];
  const out: string[] = [];
  if (state === "needs-login") out.push("The sign-in expired.");
  else if (state === "needs-terms")
    out.push(`Anthropic refuses every request until the updated Consumer Terms are accepted. Open claude.ai signed in as ${row.label}, accept them, then choose Check again.`);
  else if (state === "refused" || state === "cooldown") {
    const left = row.cooldownUntil && row.cooldownUntil > now ? ` The pool tries it again in ${span(row.cooldownUntil - now)}.` : "";
    out.push((row.cooldownReason ? `Refused: ${row.cooldownReason}.` : "Cooling down after a failure.") + left);
  } else if (state === "limited" && row.limitedUntil && row.limitedUntil > now)
    out.push(`The provider answered 429. Auto skips it for ${span(row.limitedUntil - now)}. Manual stays on it and reports the limit.`);
  out.push(...notRead);
  const stale = staleText(row, now);
  if (stale && state !== "needs-login") out.push(stale + ".");
  const resets = state === "needs-login" ? null : resetNote(row.resets, now);
  if (resets) out.push(resets);
  return out;
}

/** The confirm text for spending a reset on `row`, or null when it has none to spend. Mirrors askReset in the old AccountsSettings. */
export function resetConfirm(row: PoolAccount, now = Date.now()): { title: string; body: string; label: string; grant: string } | null {
  const pending = pendingReset(row.resets, now);
  if (pending) {
    return { title: `Retry the reset on ${row.label}?`, label: "Retry the same claim", grant: pending.grantId,
      body: "The last claim got no answer, so a reset may already be spent. A retry sends the same request id, so Anthropic counts it at most once." };
  }
  const grant = usableGrant(row.resets, now);
  if (!grant) return null;
  const clears = grant.clears.map(window => RESET_WINDOW[window] ?? window);
  const week = row.windows.find(window => window.kind === "weekly");
  const weekSoon = week?.resetsAt && week.resetsAt > now && week.resetsAt - now < 24 * 3600_000 ? ` The week resets by itself in ${span(week.resetsAt - now)}.` : "";
  const usage = row.windows.filter(window => window.kind !== "model").map(window => `${windowLabel(window)} ${Math.round(window.pct)}%`).join(", ");
  return {
    title: `Use a reset on ${row.label}?`, label: "Use reset", grant: grant.id,
    body: `This spends 1 of ${grant.resetsLeft} banked reset${grant.resetsLeft === 1 ? "" : "s"}${grant.label ? ` (${grant.label})` : ""}. It clears the ${clears.join(", ") || "eligible"} usage limits now`
      + (usage ? `; usage is ${usage}.` : ".") + weekSoon + " A spent reset cannot be given back.",
  };
}
