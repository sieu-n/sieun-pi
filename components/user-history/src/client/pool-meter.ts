import type { PoolAccount, PoolProvider } from "../shared/types.ts";

/** pi-pool's own caps (`pi-pool config`: five_hour_max_pct 95, seven_day_max_pct 98): at these an account stops serving. */
const CAP = { "5h": 95, week: 98 } as const;
export type PoolWindowKey = keyof typeof CAP;

export interface PoolMeter { key: PoolWindowKey; pct: number }
export interface PoolSummary {
  meters: PoolMeter[];
  /** Accounts that can serve a request now, out of the accounts that are not turned off. */
  usable: number; total: number;
  /** Epoch ms when the first blocked account can serve again; null when none is blocked or none will free up by itself. */
  nextFree: number | null;
}

const windowPct = (row: PoolAccount, key: PoolWindowKey): number | undefined => row.windows.find(window => window.label === key)?.pct;

/** needs a new login, or refused by the API: blocked until a person acts or the cooldown ends, whatever its usage says. */
const blocked = (row: PoolAccount): boolean => row.reason === "needs-reauth" || Boolean(row.reason?.startsWith("cooldown"));

/**
 * How much of a provider's pool is spent, per window: the mean over the accounts that are not turned off. A blocked account
 * counts as 100%, and so does a week-depleted account in the 5h meter, because its 5h headroom cannot be used.
 * A window shows only when some account reports it (Codex has no 5h window).
 */
export function poolSummary(provider: PoolProvider, now = Date.now()): PoolSummary {
  const rows = provider.rows.filter(row => !row.disabled);
  const meters: PoolMeter[] = [];
  for (const key of ["5h", "week"] as const) {
    if (!rows.some(row => windowPct(row, key) !== undefined)) continue;
    const values = rows.map(row => {
      if (blocked(row)) return 100;
      if (key === "5h" && (windowPct(row, "week") ?? 0) >= CAP.week) return 100;
      return windowPct(row, key) ?? 0;
    });
    meters.push({ key, pct: values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0 });
  }
  let nextFree: number | null = null;
  for (const row of rows) {
    if (row.usable || row.reason === "needs-reauth") continue;
    const at = row.reason?.startsWith("cooldown") ? row.cooldownUntil
      : Math.max(0, ...row.windows.filter(window => window.pct >= (window.label === "5h" ? CAP["5h"] : CAP.week) && window.resetsAt).map(window => window.resetsAt!)) || null;
    if (at && at > now && (nextFree === null || at < nextFree)) nextFree = at;
  }
  return { meters, usable: rows.filter(row => row.usable).length, total: rows.length, nextFree };
}
