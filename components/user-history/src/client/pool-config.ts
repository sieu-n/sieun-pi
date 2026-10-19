import type { PoolConfig } from "../shared/types.ts";

/** pi-pool's defaults (`DEFAULTS` in pi-pool's pool/base.py) for the keys the app shows. */
export const POOL_DEFAULTS = {
  admit_5h_max_pct: 100,
  low_admit_5h_max_pct: 50,
  seven_day_max_pct: 98,
  admit_slot_sec: 120,
  admit_per_unit: 1,
  budget_wait_max_sec: 3600,
  refused_cooldown_sec: 24 * 3600,
  probe_interval_sec: 6 * 3600,
  active_session_sec: 3600,
  /** The Mac-wide turn queue's switch, on by default (agent queue plan, change 5). */
  agent_queue_on: 1,
  /** A p90 working session used 426 MB, and 6.9 GB was free for agents on 10-14 07:38 KST, so 16 fit (agent-queue-measure.md). */
  working_max: 16,
  /** Half of 16, so two chats at full fan-out fit, above the 7 working sessions VP of CI held at once on 10-14. */
  tree_working_max: 8,
} as const;
export type PoolKey = keyof typeof POOL_DEFAULTS;

/** The value pi-pool uses for `key`: this Mac's `pi-pool config` when the server read it, else the default. */
export const poolValue = (config: PoolConfig | null | undefined, key: PoolKey): number => config?.[key] ?? POOL_DEFAULTS[key];
