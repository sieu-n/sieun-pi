import { authorityAllows, getWikiIndex, type WikiPageSummary } from '$lib/server/wiki';
import { getSections } from '$lib/server/wiki-tree';

const RECENT = 16;

export async function load() {
	const [index, sections] = await Promise.all([getWikiIndex(), getSections()]);
	return { recent: newestCurated(index.pages), sections };
}

/**
 * The newest pages outside sessions and archive. It stops at the 16th: getRecent filters all 118k pages,
 * which pages every summary back in on a swapped-out dev server. In one stall on 2026-10-17 at 22:41Z
 * GET / took 8.7 s while /timeline, which shares the layout, took 2.8 s.
 */
function newestCurated(pages: WikiPageSummary[]): WikiPageSummary[] {
	const recent: WikiPageSummary[] = [];
	for (const page of pages) {
		if (!authorityAllows(page.path)) continue;
		recent.push(page);
		if (recent.length === RECENT) break;
	}
	return recent;
}
