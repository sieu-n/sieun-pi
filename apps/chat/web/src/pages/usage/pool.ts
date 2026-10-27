/** The account pool's state per provider and per account, from pi-pool's AccountsView. Ported from components/user-history pool-meter.ts. */
import type { AccountsView } from "$lib/api";

export type PoolProvider = AccountsView["providers"][number];
export type PoolAccount = PoolProvider["rows"][number];
export type WindowKey = "5h" | "week";

export const PROVIDER_LABEL: Readonly<Record<string, string>> = { anthropic: "Claude", "openai-codex": "Codex" };
export const WINDOW_LABEL: Readonly<Record<WindowKey, string>> = { "5h": "5h", week: "Week" };

export type PoolWindow = PoolAccount["windows"][number];
export type WindowKind = PoolWindow["kind"];
export const WINDOW_KINDS: readonly WindowKind[] = ["session", "weekly", "model"];
/** A window's name as the page shows it: "Week" for pi-pool's "week", else pi-pool's own label such as 5h, 30d or Fable. */
export const windowName = (window: PoolWindow): string => (window.label === "week" ? "Week" : window.label);
/** The window kinds any account of this provider reports, in column order. */
export const kindsOf = (provider: PoolProvider): WindowKind[] => WINDOW_KINDS.filter(kind => provider.rows.some(row => row.windows.some(window => window.kind === kind)));

/** pi-pool's admission caps per window, with pi-pool's own defaults when `pi-pool config` did not read. */
export function caps(view: AccountsView | null): Record<WindowKey, number> {
  const config = view?.poolConfig ?? null;
  return { "5h": config?.["admit_5h_max_pct"] ?? 100, week: config?.["seven_day_max_pct"] ?? 98 };
}

export const windowPct = (row: PoolAccount, key: WindowKey): number | undefined => row.windows.find(window => window.label === key)?.pct;

/** Needs a new login, in cooldown or limited by a 429: blocked whatever its usage says. */
export const blocked = (row: PoolAccount): boolean =>
  row.reason === "needs-reauth" || Boolean(row.reason?.startsWith("cooldown") || row.reason?.startsWith("limited"));

export interface PoolSummary {
  meters: { key: WindowKey; pct: number }[];
  usable: number;
  total: number;
}

/**
 * How much of a provider's pool is spent per window: the mean over the accounts that are not turned off, with a blocked account at 100%,
 * and a week-spent account at 100% in the 5h meter too, because its 5h room cannot be used. A window shows only when an account reports it.
 */
export function summary(provider: PoolProvider, cap: Record<WindowKey, number>): PoolSummary {
  const rows = provider.rows.filter(row => !row.disabled);
  const meters: PoolSummary["meters"] = [];
  for (const key of ["5h", "week"] as const) {
    if (!rows.some(row => windowPct(row, key) !== undefined)) continue;
    const values = rows.map(row => (blocked(row) || (key === "5h" && (windowPct(row, "week") ?? 0) >= cap.week) ? 100 : (windowPct(row, key) ?? 0)));
    meters.push({ key, pct: values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0 });
  }
  return { meters, usable: rows.filter(row => row.usable).length, total: rows.length };
}

const clock = (at: number): string => new Date(at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
/** A time today, or a weekday and time later. */
const when = (at: number, now: number): string =>
  at - now < 20 * 3_600_000 ? clock(at) : new Date(at).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" });

/** One account's state in words. */
export function accountState(row: PoolAccount, now: number): { text: string; tone: "ok" | "warn" | "danger" | "off" } {
  if (row.disabled) return { text: "Turned off", tone: "off" };
  if (row.reason === "needs-reauth") return { text: "Needs a new login", tone: "danger" };
  if (row.reason?.startsWith("cooldown")) return { text: row.cooldownUntil && row.cooldownUntil > now ? `Cooldown until ${clock(row.cooldownUntil)}` : "Cooldown", tone: "warn" };
  if (row.reason?.startsWith("limited")) {
    const left = row.reason.slice("limited".length).trim();
    return { text: row.limitedUntil && row.limitedUntil > now ? `Limited until ${clock(row.limitedUntil)}` : left ? `Limited for ${left}` : "Limited", tone: "warn" };
  }
  if (row.reason === "depleted") {
    const reset = Math.max(0, ...row.windows.filter(window => window.pct >= 98 && window.resetsAt).map(window => window.resetsAt!));
    return { text: reset > now ? `Spent until ${when(reset, now)}` : "Spent", tone: "warn" };
  }
  if (!row.usable) return { text: row.reason ?? "Full", tone: "warn" };
  const threads = `${row.sessions} ${row.sessions === 1 ? "thread" : "threads"}`;
  return { text: row.current ? `In use · ${threads}` : threads, tone: "ok" };
}
