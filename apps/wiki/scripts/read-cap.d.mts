// Types for read-cap.mjs, for the same reason as dup-held.d.mts.

/** The whole-read cap of a stored page in bytes. */
export const PAGE_READ_CAP: number;

/** The size change of one dream rewrite of a curated page at p90, in bytes. */
export const DREAM_GROWTH_P90: number;

/** The size in bytes at which a current curated page counts as near the read cap. */
export const NEAR_READ_CAP: number;

/** The statuses whose pages no writer grows. */
export const SETTLED_STATUSES: ReadonlySet<string>;

/** Whether a page header status is settled, in any case. */
export function isSettledStatus(status: unknown): boolean;
