// Types for heldByWrite, so svelte-check does not pull the untyped node scripts dup-held.mjs imports into the app's checkJs
// program, where they fail the check with implicit-any errors.

/** One curated page that `page` looks like, as a content path, with the duplicate gate's score. */
export interface HeldRow {
	other: string;
	score: number;
}

/** The pairs a write of `html` to the content path `page` starts holding (`added`) and the ones that held the page before it (`kept`). */
export function heldByWrite(contentRoot: string, page: string, html: string): { added: HeldRow[]; kept: HeldRow[] };
