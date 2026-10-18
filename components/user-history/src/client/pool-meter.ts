import type { PoolAccount, PoolConfig, PoolPriority, PoolProvider } from "../shared/types.ts";
import { poolValue } from "./pool-config.ts";

export type PoolWindowKey = "5h" | "week";
/**
 * The usage share at which pi-pool stops admitting a thread of this priority to an account, per window: `admit_5h_max_pct`
 * (`low_admit_5h_max_pct` for a low thread) and `seven_day_max_pct` of `pi-pool config`. A thread with no priority is normal, as in pi-pool.
 */
export type PoolCaps = Readonly<Record<PoolWindowKey, number>>;
export const poolCaps = (config: PoolConfig | null | undefined, priority?: PoolPriority | null): PoolCaps =>
  ({ "5h": poolValue(config, priority === "low" ? "low_admit_5h_max_pct" : "admit_5h_max_pct"), week: poolValue(config, "seven_day_max_pct") });

export interface PoolMeter { key: PoolWindowKey; pct: number }
export interface PoolSummary {
  meters: PoolMeter[];
  /** Accounts that can serve a request now, out of the accounts that are not turned off. */
  usable: number; total: number;
  /** Epoch ms when the first blocked account can serve again; null when none is blocked or none will free up by itself. */
  nextFree: number | null;
}

const windowPct = (row: PoolAccount, key: PoolWindowKey): number | undefined => row.windows.find(window => window.label === key)?.pct;

/** needs a new login, refused by the API, or limited by a 429: blocked until a person acts or the cooldown or limit ends, whatever its usage says. */
const blocked = (row: PoolAccount): boolean => row.reason === "needs-reauth" || Boolean(row.reason?.startsWith("cooldown") || row.reason?.startsWith("limited"));

/**
 * How much of a provider's pool is spent, per window: the mean over the accounts that are not turned off. A blocked account
 * counts as 100%, and so does a week-depleted account in the 5h meter, because its 5h headroom cannot be used.
 * A window shows only when some account reports it (Codex has no 5h window).
 */
export function poolSummary(provider: PoolProvider, caps: PoolCaps = poolCaps(null), now = Date.now()): PoolSummary {
  const rows = provider.rows.filter(row => !row.disabled);
  const meters: PoolMeter[] = [];
  for (const key of ["5h", "week"] as const) {
    if (!rows.some(row => windowPct(row, key) !== undefined)) continue;
    const values = rows.map(row => {
      if (blocked(row)) return 100;
      if (key === "5h" && (windowPct(row, "week") ?? 0) >= caps.week) return 100;
      return windowPct(row, key) ?? 0;
    });
    meters.push({ key, pct: values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0 });
  }
  let nextFree: number | null = null;
  for (const row of rows) {
    if (row.usable || row.reason === "needs-reauth") continue;
    const at = row.reason?.startsWith("cooldown") ? row.cooldownUntil : row.reason?.startsWith("limited") ? row.limitedUntil
      : Math.max(0, ...row.windows.filter(window => window.pct >= (window.label === "5h" ? caps["5h"] : caps.week) && window.resetsAt).map(window => window.resetsAt!)) || null;
    if (at && at > now && (nextFree === null || at < nextFree)) nextFree = at;
  }
  return { meters, usable: rows.filter(row => row.usable).length, total: rows.length, nextFree };
}
