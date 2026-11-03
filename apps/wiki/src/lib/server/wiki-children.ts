import { open, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { getWikiIndex, type WikiPageSummary } from './wiki';
import { diskPath } from './wiki-mounts';
import { escapeAttr, escapeHtml } from './wiki-html';

/**
 * `<wiki-children>` renders a hub's article list from the page index, so the list cannot drift
 * from the folder. It lists every page directly in the folder plus the index.html or README.html
 * of each sub-folder; a sub-folder with no index page is walked through. Pages below a sub-folder
 * that has its own index page belong to that sub-hub's list.
 *
 *   <wiki-children>                            the folder of the page that holds the tag
 *   <wiki-children path="apps">                another folder, page-relative like <wiki-gallery dir>
 *   <wiki-children exclude="old.html,x/">      hide named pages or folders (page-relative, comma list)
 *   <wiki-children as="list">                  an <ol> of "title · description" lines instead of a table
 *   <wiki-children headers="Page,Covers">      the table's two column headers
 *
 * The second cell is the child's one-line frontmatter `summary`, never its long `description`. A child with
 * no summary gets an empty cell marked `data-missing-summary`, which wiki-health counts.
 * Hidden: status superseded, deprecated or archived, and archive/, sessions/ and @code/ pages.
 * Order: an optional numeric frontmatter `order` (lower first, pages without one last), then title.
 */

const HIDDEN_STATUS = new Set(['superseded', 'deprecated', 'archived']);
const HIDDEN_ROOTS = ['archive/', 'sessions/', 'agents/', '@code/'];
const HUB_FILES = ['index.html', 'README.html'];
const META_HEAD_BYTES = 4096;

type Child = { page: WikiPageSummary; order: number };

export async function renderChildren(attrs: Record<string, string>, sourcePath: string): Promise<string> {
	const pageDir = dirOf(sourcePath);
	const folder = attrs.path === undefined ? pageDir : joinConfined(pageDir, attrs.path);
	if (folder === null) return note(`children: "${attrs.path}" is outside the wiki`);
	const index = await getWikiIndex();
	const excluded = new Set(
		(attrs.exclude ?? '')
			.split(',')
			.map((item) => item.trim())
			.filter(Boolean)
			.map((item) => joinConfined(pageDir, item.replace(/\/$/, '')))
			.filter((item): item is string => item !== null),
	);
	const listed = listChildren(folder, sourcePath, index.pages, index.byPath).filter(
		(page) => !isExcluded(page.path, excluded),
	);
	if (listed.length === 0) return note(`children: no pages under "${folder || '/'}"`);
	const children = await Promise.all(listed.map(async (page) => ({ page, order: await readOrder(page.path) })));
	children.sort(byOrderThenTitle);
	return attrs.as === 'list' ? renderList(children, pageDir) : renderTable(children, pageDir, attrs.headers);
}

function listChildren(
	folder: string,
	sourcePath: string,
	pages: WikiPageSummary[],
	byPath: Map<string, WikiPageSummary>,
): WikiPageSummary[] {
	const prefix = folder ? `${folder}/` : '';
	const found = new Map<string, WikiPageSummary>();
	for (const page of pages) {
		if (page.kind !== 'html' || !page.path.startsWith(prefix) || page.path === sourcePath) continue;
		if (HIDDEN_ROOTS.some((root) => page.path.startsWith(root))) continue;
		const segments = page.path.slice(prefix.length).split('/');
		if (segments.length === 1 && HUB_FILES.includes(segments[0])) continue;
		const entry = entryFor(prefix, segments, byPath) ?? page;
		if (found.has(entry.path) || HIDDEN_STATUS.has((entry.meta.status ?? '').toLowerCase())) continue;
		found.set(entry.path, entry);
	}
	return [...found.values()];
}

/** The nearest sub-folder hub between the folder and the page, or null when the page is listed itself. */
function entryFor(prefix: string, segments: string[], byPath: Map<string, WikiPageSummary>): WikiPageSummary | null {
	for (let depth = 1; depth < segments.length; depth += 1) {
		const sub = prefix + segments.slice(0, depth).join('/');
		for (const name of HUB_FILES) {
			const hub = byPath.get(`${sub}/${name}`);
			if (hub) return hub;
		}
	}
	return null;
}

function isExcluded(pagePath: string, excluded: Set<string>): boolean {
	if (excluded.has(pagePath)) return true;
	return [...excluded].some((item) => pagePath.startsWith(`${item}/`));
}

/** Frontmatter `order` is not in the index's meta, so read it from the head of each listed page. */
async function readOrder(pagePath: string): Promise<number> {
	let handle: FileHandle | undefined;
	try {
		handle = await open(diskPath(pagePath), 'r');
		const buffer = Buffer.alloc(META_HEAD_BYTES);
		const { bytesRead } = await handle.read(buffer, 0, META_HEAD_BYTES, 0);
		const head = buffer.subarray(0, bytesRead).toString('utf8');
		const meta = /<!--wiki([\s\S]*?)-->/.exec(head)?.[1] ?? '';
		const value = /"order"\s*:\s*"?(-?\d+(?:\.\d+)?)/.exec(meta)?.[1];
		return value === undefined ? Number.POSITIVE_INFINITY : Number(value);
	} catch {
		return Number.POSITIVE_INFINITY;
	} finally {
		await handle?.close();
	}
}

function byOrderThenTitle(a: Child, b: Child): number {
	if (a.order !== b.order) return a.order < b.order ? -1 : 1;
	return a.page.title.localeCompare(b.page.title, 'en', { sensitivity: 'base' });
}

function renderTable(children: Child[], pageDir: string, headers: string | undefined): string {
	const [first, second] = (headers ?? 'Page,Covers').split(',').map((cell) => cell.trim());
	const rows = children
		.map(({ page }) => {
			const summary = summaryOf(page);
			const cell = summary ? `<td>${escapeHtml(summary)}</td>` : '<td data-missing-summary></td>';
			return `<tr><td>${link(page, pageDir)}</td>${cell}</tr>`;
		})
		.join('');
	return `<table class="wiki-children"><thead><tr><th>${escapeHtml(first ?? 'Page')}</th><th>${escapeHtml(second ?? '')}</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function renderList(children: Child[], pageDir: string): string {
	const items = children
		.map(({ page }) => {
			const summary = summaryOf(page);
			if (!summary) return `<li data-missing-summary>${link(page, pageDir)}</li>`;
			return `<li>${link(page, pageDir)} · ${escapeHtml(summary)}</li>`;
		})
		.join('');
	return `<ol class="wiki-children">${items}</ol>`;
}

function summaryOf(page: WikiPageSummary): string {
	return (page.meta.summary ?? '').trim();
}

/** A page-relative href, so the render pass resolves it like a hand-written link. */
function link(page: WikiPageSummary, pageDir: string): string {
	const href = path.posix.relative(pageDir || '.', page.path);
	return `<a href="${escapeAttr(href)}">${escapeHtml(page.title)}</a>`;
}

function dirOf(pagePath: string): string {
	const dir = path.posix.dirname(pagePath);
	return dir === '.' ? '' : dir;
}

function joinConfined(base: string, relative: string): string | null {
	const joined = path.posix.normalize(path.posix.join(base || '.', relative));
	if (joined === '..' || joined.startsWith('../') || joined.startsWith('/')) return null;
	return joined === '.' ? '' : joined.replace(/\/$/, '');
}

export function note(message: string): string {
	return `<p class="wiki-empty">⚠ ${escapeHtml(message)}</p>`;
}
