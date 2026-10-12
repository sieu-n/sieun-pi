import type { PoolConfig } from "../shared/types.ts";

/** pi-pool's defaults (`DEFAULTS` in vend.py) for the keys the app shows; test/how-it-works.test.ts checks them against vend.py. */
export const POOL_DEFAULTS = {
  admit_5h_max_pct: 70,
  low_admit_5h_max_pct: 50,
  seven_day_max_pct: 98,
  admit_slot_sec: 120,
  admit_per_unit: 1,
  budget_wait_max_sec: 3600,
  cache_ttl_sec: 3600,
  refused_cooldown_sec: 24 * 3600,
  probe_interval_sec: 6 * 3600,
  active_session_sec: 3600,
} as const;
export type PoolKey = keyof typeof POOL_DEFAULTS;

/** The value pi-pool uses for `key`: this Mac's `pi-pool config` when the server read it, else the default. */
export const poolValue = (config: PoolConfig | null | undefined, key: PoolKey): number => config?.[key] ?? POOL_DEFAULTS[key];
