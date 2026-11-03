// Types for pageWriteReasons, pageWriteWarnings and the dead link check, for the same reason as dup-held.d.mts.

/** Why the page API refuses one write of a curated page, one reason per rule; empty when the write passes. */
export function pageWriteReasons(root: string, page: string, before: string | null, after: string): string[];

/** The rule 6 warnings for one page API write: a source_ref it adds whose code changed after its last_verified. */
export function pageWriteWarnings(root: string, page: string, before: string | null, after: string): string[];

/** The link targets `after` adds over `before` that lead to no page; `exists` says whether the index serves a content path. */
export function deadLinksAdded(
	page: string,
	before: string | undefined,
	after: string,
	exists: (contentPath: string) => boolean,
): string[];

/** The refusal reason for dead link targets, which the page API and the page gate both print. */
export function deadLinkReason(dead: string[]): string;
