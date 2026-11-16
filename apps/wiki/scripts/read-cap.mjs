// The page read cap and the near-cap line, shared by the page API (src/lib/server/wiki.ts, wiki-write.ts) and the wiki dream precheck
// (sieun-pi legacy/prime/user-history/scripts/duties/wiki-dream.ts), so the write warning and the duty's wiki_problems count cannot drift.

/** The whole-read cap of a stored page: past it GET /api/agent/page and the markdown view answer 413. */
export const PAGE_READ_CAP = 64 * 1024;

/**
 * measured: the size change between consecutive wiki-dream revisions of one curated page in wiki.db was 2,364 B at p90 (n=2,923,
 * 2026-10-12 to 11-08 20:44Z), and every one of the 12 dream writes that took a curated page over the cap started at 63,798 B or more.
 */
export const DREAM_GROWTH_P90 = 2_364;

/**
 * A current curated page this size or more counts in the dream duty's wiki_problems, since one dream rewrite at p90 takes it over the cap,
 * and the page API warns its writer at the same line. On 2026-11-16 four pages entered this band with no write-time warning.
 */
export const NEAR_READ_CAP = PAGE_READ_CAP - DREAM_GROWTH_P90;

/** The statuses whose pages no writer grows, as wiki-health.mjs reads them (`SETTLED_STATUS`). */
export const SETTLED_STATUSES = new Set(['superseded', 'deprecated', 'archived']);

/** Whether a page header status is settled, in any case. */
export function isSettledStatus(status) {
	return SETTLED_STATUSES.has(String(status ?? '').toLowerCase());
}
