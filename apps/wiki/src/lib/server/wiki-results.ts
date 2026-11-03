/** The result row every list endpoint and the ⌘K palette return, with freshness and trust fields. */
import type { WikiPageSummary } from './wiki';
import { metaCreated, metaDescription } from './wiki-frontmatter';
import { statsFor } from './wiki-store';

export type ResultRow = {
	path: string;
	title: string;
	kind: string;
	status: string | null;
	/** The triage snippet: frontmatter `description`, or `summary` as its alias. */
	description: string | null;
	apps: string[];
	projects: string[];
	domains: string[];
	owner: string | null;
	created: string | null;
	updated: string;
	last_verified: string | null;
	/** The page that replaced this one (frontmatter `superseded_by`), else null. */
	superseded_by: string | null;
	views: number;
	edits: number;
	score?: number;
	match?: { line: number; text: string; context: string[] };
};

export function rowFor(
	page: WikiPageSummary,
	extra: { views?: number; edits?: number; score?: number; match?: ResultRow['match'] } = {},
): ResultRow {
	return {
		path: page.path,
		title: page.title,
		kind: page.meta.kind ?? page.kind, // semantic kind, else file extension
		status: page.meta.status ?? null,
		description: metaDescription(page.meta),
		apps: page.meta.apps,
		projects: page.meta.projects ?? [],
		domains: page.meta.domains ?? [],
		owner: page.meta.owner ?? null,
		created: metaCreated(page.meta),
		updated: page.meta.updated ?? page.updated,
		last_verified: page.meta.last_verified ?? null,
		superseded_by: page.meta.superseded_by ?? null,
		views: extra.views ?? 0,
		edits: extra.edits ?? 0,
		...(extra.score !== undefined ? { score: extra.score } : {}),
		...(extra.match ? { match: extra.match } : {}),
	};
}

/** Batch-project pages, joining one SQLite stats lookup. */
export function rowsFor(pages: WikiPageSummary[], scoreByPath?: Map<string, number>): ResultRow[] {
	const stats = statsFor(pages.map((p) => p.path));
	return pages.map((p) => {
		const s = stats.get(p.path);
		return rowFor(p, { views: s?.views, edits: s?.edits, score: scoreByPath?.get(p.path) });
	});
}
