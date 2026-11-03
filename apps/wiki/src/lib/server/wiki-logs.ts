import { isSessionLog } from './session-artifact-index';
import { getWikiIndex, type WikiPageSummary } from './wiki';
import { kstDay } from '../kst.mjs';

/** Session logs (`sessions/YYYY/MM/DD/hhmm-{slug}/index.html`) as a queryable dataset, so the timeline is a view. */

export type LogEntry = {
	path: string;
	title: string;
	date: string; // YYYY-MM-DD (frontmatter date, else parsed from the filename)
	apps: string[];
	tags: string[];
	status: string;
};

export type LogQuery = {
	app?: string;
	tags?: string[]; // match ANY
	status?: string;
	since?: string;
	until?: string;
	limit?: number;
};

const DATE_RE = /(\d{4}-\d{2}-\d{2})/;

export async function getLogIndex(): Promise<LogEntry[]> {
	const index = await getWikiIndex();
	return index.pages
		.filter((page) => isSessionLog(page.path))
		.map(toLogEntry)
		.sort((a, b) => b.date.localeCompare(a.date) || a.title.localeCompare(b.title));
}

/** Session `status` is free text, so filters use a small bucket enum; the raw text stays on each entry. */
export function normalizeStatus(status: string): string {
	const s = status.toLowerCase();
	if (s.includes('abandon')) return 'abandoned';
	if (s.includes('blocked')) return 'blocked';
	if (s.includes('closed')) return 'closed';
	if (s.includes('complete')) return 'complete';
	return 'other';
}

/** Synchronous filter over an already-loaded log index — used by queryLogs and the render directive. */
export function filterLogs(logs: LogEntry[], query: LogQuery): LogEntry[] {
	const tags = (query.tags ?? []).map((t) => t.toLowerCase());
	const filtered = logs.filter((log) => {
		if (query.app && !log.apps.some((a) => a === query.app || a.startsWith(`${query.app}/`))) return false;
		if (query.status && normalizeStatus(log.status ?? '') !== query.status) return false;
		if (tags.length && !log.tags.some((t) => tags.includes(t.toLowerCase()))) return false;
		if (query.since && log.date < query.since) return false;
		if (query.until && log.date > query.until) return false;
		return true;
	});
	return query.limit ? filtered.slice(0, query.limit) : filtered;
}

/** Facets for the timeline filter UI — apps ranked by frequency (one-offs dropped). */
export async function getLogFacets(): Promise<{ apps: string[]; tags: string[]; statuses: string[] }> {
	const logs = await getLogIndex();
	const appCount = new Map<string, number>();
	const tags = new Set<string>();
	const statuses = new Set<string>();
	for (const log of logs) {
		log.apps.forEach((a) => appCount.set(a, (appCount.get(a) ?? 0) + 1));
		log.tags.forEach((t) => tags.add(t));
		if (log.status) statuses.add(normalizeStatus(log.status));
	}
	const apps = [...appCount.entries()]
		.filter(([, n]) => n >= 3)
		.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
		.map(([app]) => app);
	return { apps, tags: [...tags].sort(), statuses: [...statuses].sort() };
}

function toLogEntry(page: WikiPageSummary): LogEntry {
	// sessions/YYYY/MM/DD/hhmm-{slug}/index.html encodes the date in the folder shape.
	const pathDate = page.path.match(/^sessions\/(\d{4})\/(\d{2})\/(\d{2})\//);
	const date =
		page.meta.date ||
		page.meta.created ||
		(pathDate ? `${pathDate[1]}-${pathDate[2]}-${pathDate[3]}` : undefined) ||
		page.path.match(DATE_RE)?.[1] ||
		kstDay(new Date(page.updated));
	return {
		path: page.path,
		title: page.title,
		date,
		apps: page.meta.apps,
		tags: page.meta.tags,
		status: page.meta.status ?? '',
	};
}
