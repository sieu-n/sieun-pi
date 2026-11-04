import path from 'node:path';
import { getWikiIndex, normalizeLinkTarget, readRawContent, type WikiIndex, type WikiPageSummary } from './wiki';
import { resolveLink } from './wiki-index';
import { deriveTitleFromPath, isSessionPath } from './session-artifact-index';
import { extractHtmlHrefs } from './wiki-html';
import { metaDescription } from './wiki-frontmatter';

/** The lint rules, in report order. Style rules stay WARN tier, so `healthy` reads only broken links and orphans. */
const RULES = [
	'brokenLinks',
	'orphans',
	'stale',
	'untitled',
	'missingDescription',
	'underLinked',
	'duplicateCanonical',
	'titleH1Mismatch',
	'hubOrphans',
	'sessionLinks',
	'supersededLinked',
	'missingSummary',
] as const;
type Rule = (typeof RULES)[number];

/** One finding. `target` names a linked page (brokenLinks, sessionLinks, supersededLinked), `topic` a canonical_for claim. */
export type LintFinding = { path: string; title: string; target?: string; topic?: string; detail: string };

export type LintReport = {
	generatedAt: string;
	pageCount: number;
	healthy: boolean;
	counts: Record<Rule, number>;
} & Record<Rule, LintFinding[]>;

type Add = (rule: Rule, page: WikiPageSummary, detail: string, extra?: { target?: string; topic?: string }) => void;

const STALE_DAYS = 180;
const MIN_CURATED_LINKS = 3;
// Evidence trees are expected to be old leaves: excluded from orphan, stale and style checks. experiments/ is linted.
// agents/ is the sw factory agents' own space (briefs, notebooks, job folders), not curated pages.
const ARCHIVAL_PREFIXES = ['sessions/', 'archive/', 'agents/'];
// Entry-point file stems (any extension) legitimately have no inbound links.
const ENTRY_FILE_STEMS = new Set(['sitemap', 'index', 'readme', 'agents', 'claude', 'deploy']);
// The curated spaces the hub rules cover. Pages under a page's data/ or assets/ folder are attachments.
const CURATED_PREFIXES = ['apps/', 'domains/', 'projects/', 'experiments/'];
const HOME = 'index.html';
const RETIRED_STATUSES = new Set(['superseded', 'deprecated', 'archived', 'retired']);
const SESSION_LOG = /^sessions\/\d{4}\/\d{2}\/\d{2}\/[^/]+\/index\.html$/;
const HUB_FILE = /^(index|README)\.html$/;

export async function getLintReport(): Promise<LintReport> {
	const index = await getWikiIndex();
	const staleThreshold = Date.now() - STALE_DAYS * 24 * 60 * 60 * 1000;
	const found = Object.fromEntries(RULES.map((rule) => [rule, [] as LintFinding[]])) as Record<Rule, LintFinding[]>;
	const add: Add = (rule, page, detail, extra = {}) =>
		found[rule].push({ path: page.path, title: page.title, ...extra, detail });
	const canonicalOwners = new Map<string, string>();
	const curated = await readCuratedFiles(index);

	for (const page of index.pages) {
		// The @code/ tier mirrors repo source docs read-only, which is not wiki content to lint.
		if (page.path.startsWith('@code/')) continue;

		// Frozen evidence trees (sessions/, archive/) 403 on edit, so a broken link from there is unfixable noise once
		// its target moves. Links from curated pages into archive/ and sessions/ are still checked.
		if (!isArchival(page)) {
			for (const target of page.links) {
				if (!index.byPath.has(target) && isInternalTarget(target))
					add('brokenLinks', page, `links to missing "${target}"`, { target });
			}
		}

		if (isCuratedPage(page) || page.path === HOME) {
			for (const target of curated.get(page.path)?.links ?? []) {
				if (target.startsWith('sessions/') && !SESSION_LOG.test(target))
					add('sessionLinks', page, `links into session folder "${target}"`, { target });
				const linked = index.byPath.get(target);
				// Links into archive/ are history links; the defect is a retired page still listed as current.
				if (isHub(page.path) && !isRetired(page) && linked && isCuratedPage(linked) && isRetired(linked))
					add('supersededLinked', page, `hub links "${target}" (status ${linked.meta.status})`, { target });
			}
		}

		// Orphanhood applies to page documents; .txt/.json/.yaml files are co-located attachments reached through their page.
		const isPageKind = page.kind === 'html' || page.kind === 'md' || page.kind === 'mdx';
		const inbound = index.backlinks.get(page.path);
		if ((!inbound || inbound.size === 0) && isPageKind && !isEntryFile(page) && !isArchival(page))
			add('orphans', page, 'no inbound links');
		if (!isArchival(page) && Date.parse(page.updated) < staleThreshold)
			add('stale', page, `last modified ${page.updated.slice(0, 10)}`);
		if (isUntitled(page)) add('untitled', page, 'no H1 heading — title derived from filename');

		if (!isPageKind || isArchival(page)) continue;
		if (!metaDescription(page.meta))
			add(
				'missingDescription',
				page,
				'no `description` (or legacy `summary`) — every result row needs the triage snippet',
			);
		const resolvedLinks = page.links.filter((target) => index.byPath.has(target));
		if (resolvedLinks.length < MIN_CURATED_LINKS && !isEntryFile(page))
			add(
				'underLinked',
				page,
				`${resolvedLinks.length} resolved internal link(s) — curated pages need ≥${MIN_CURATED_LINKS}`,
			);
		for (const topic of page.meta.canonical_for ?? []) {
			const owner = canonicalOwners.get(topic);
			if (owner && owner !== page.path)
				add('duplicateCanonical', page, `canonical_for "${topic}" already claimed by ${owner}`, { topic });
			else canonicalOwners.set(topic, page.path);
		}
		if (
			page.kind === 'html' &&
			page.meta.title &&
			page.firstH1Text !== undefined &&
			!titleMatchesH1(page.meta.title, page.firstH1Text)
		)
			add('titleH1Mismatch', page, `metadata title "${page.meta.title}" does not match first H1 "${page.firstH1Text}"`);
	}

	checkHubListing(index, curated, add);
	const counts = Object.fromEntries(RULES.map((rule) => [rule, found[rule].length])) as Record<Rule, number>;
	return {
		generatedAt: new Date(index.generatedAt).toISOString(),
		pageCount: index.pages.length,
		healthy: counts.brokenLinks === 0 && counts.orphans === 0,
		counts,
		...(Object.fromEntries(RULES.map((rule) => [rule, found[rule].slice(0, 200)])) as Record<Rule, LintFinding[]>),
	};
}

/**
 * Hub listing checks. A hub lists a page when it links it or when its `<wiki-children>` tag covers it.
 * hubOrphans: a curated page no ancestor hub lists. A retired page is left out, because its fix is to
 * drop it from the hub. missingSummary: a page a `<wiki-children>` tag lists with no frontmatter
 * `summary`, so its row renders empty.
 */
function checkHubListing(index: WikiIndex, curated: Map<string, CuratedFile>, add: Add): void {
	const hasIndex = (folder: string) =>
		index.byPath.has(`${folder}/index.html`) || index.byPath.has(`${folder}/README.html`);
	for (const page of index.pages) {
		if (!isCuratedPage(page) || isRetired(page)) continue;
		const hubs = ancestorHubs(page.path, (candidate) => index.byPath.has(candidate));
		const byTag = hubs.some((hub) =>
			(curated.get(hub)?.tags ?? []).some((tag) => childrenTagCovers(tag, page.path, hasIndex)),
		);
		if (byTag && !(page.meta.summary ?? '').trim())
			add('missingSummary', page, 'a <wiki-children> hub lists it, and it has no `summary` for the row');
		if (byTag || hubs.some((hub) => curated.get(hub)?.links.has(page.path))) continue;
		add('hubOrphans', page, `no ancestor hub lists it (nearest hub ${hubs.at(-1)})`);
	}
}

type CuratedFile = { updated: string; links: Set<string>; tags: ChildrenTag[] };
const curatedCache = new Map<string, CuratedFile>();

/**
 * Resolved links and `<wiki-children>` tags of every curated page and the home page, read from the
 * whole file. The index keeps links from the first 64 KiB and drops `/page/<path>` hrefs as app
 * routes, and hubs use both.
 */
async function readCuratedFiles(index: WikiIndex): Promise<Map<string, CuratedFile>> {
	const out = new Map<string, CuratedFile>();
	for (const page of index.pages) {
		if (!isCuratedPage(page) && page.path !== HOME) continue;
		const cached = curatedCache.get(page.path);
		if (cached?.updated === page.updated) {
			out.set(page.path, cached);
			continue;
		}
		const html = await readRawContent(page.path).catch(() => null);
		const links = new Set<string>([...page.links, ...(html ? hrefTargets(html, page.path, index) : [])]);
		const file = { updated: page.updated, links, tags: html ? parseWikiChildren(html, page.path) : [] };
		curatedCache.set(page.path, file);
		out.set(page.path, file);
	}
	return out;
}

/**
 * The nearest hub of a curated page no ancestor hub lists, with the href a row there needs, or null when a hub
 * links it or a `<wiki-children>` tag covers it. Hubs are read from disk, because the page API asks right after a
 * create, before a hub row could pass the dead-link gate. On 2026-11-04 a split made 9 child pages beside their
 * parents, and the 02:10Z wiki dream run read them as 9 hub orphans.
 */
export async function missingHubRow(pagePath: string): Promise<{ hub: string; href: string } | null> {
	const index = await getWikiIndex();
	const exists = (wikiPath: string) => index.byPath.has(wikiPath);
	const hasIndex = (folder: string) => exists(`${folder}/index.html`) || exists(`${folder}/README.html`);
	const targets = new Set([pagePath, pagePath.replace(/\.html$/, '')]);
	const hubs = ancestorHubs(pagePath, exists);
	for (const hub of hubs) {
		const html = await readRawContent(hub).catch(() => null);
		if (html === null) continue;
		if ([...hrefTargets(html, hub, index)].some((target) => targets.has(target))) return null;
		if (parseWikiChildren(html, hub).some((tag) => childrenTagCovers(tag, pagePath, hasIndex))) return null;
	}
	const hub = hubs.at(-1) ?? HOME;
	return { hub, href: path.posix.relative(path.posix.dirname(hub), pagePath) };
}

/** Hub pages of every folder above `pagePath`, home first. A folder page is not above itself. */
export function ancestorHubs(pagePath: string, exists: (wikiPath: string) => boolean): string[] {
	const parts = pagePath.split('/');
	const folders = parts.slice(0, -1);
	if (HUB_FILE.test(parts.at(-1) ?? '')) folders.pop();
	const hubs = [HOME];
	for (let depth = 1; depth <= folders.length; depth += 1) {
		const folder = folders.slice(0, depth).join('/');
		for (const name of ['index.html', 'README.html']) {
			if (exists(`${folder}/${name}`)) hubs.push(`${folder}/${name}`);
		}
	}
	return hubs.filter((hub) => hub !== pagePath);
}

export type ChildrenTag = { folder: string; exclude: Set<string> };

/**
 * The `<wiki-children>` tags in a hub. No `path` lists the hub's own folder; `path` is page-relative.
 * `exclude` is a page-relative comma list of pages the tag hides. A path that leaves content/ is dropped.
 */
export function parseWikiChildren(html: string, hubPath: string): ChildrenTag[] {
	const hubFolder = path.posix.dirname(hubPath);
	const resolve = (relative: string): string | null => {
		const joined = path.posix.normalize(path.posix.join(hubFolder, relative));
		if (joined === '..' || joined.startsWith('../')) return null;
		return joined === '.' ? '' : joined.replace(/\/$/, '');
	};
	const tags: ChildrenTag[] = [];
	for (const match of html.matchAll(/<wiki-children\b([^>]*)>/gi)) {
		const attrs = match[1] ?? '';
		const folder = resolve(attributeValue(attrs, 'path') ?? '.');
		if (folder === null) continue;
		const exclude = new Set<string>();
		for (const item of (attributeValue(attrs, 'exclude') ?? '').split(',')) {
			const resolved = item.trim() ? resolve(item.trim()) : null;
			if (resolved) exclude.add(resolved);
		}
		tags.push({ folder, exclude });
	}
	return tags;
}

/**
 * Whether a `<wiki-children>` tag lists `pagePath`. The tag lists the pages in its folder and the index
 * page of each sub-folder, and walks through a sub-folder that has no index page. A page below a
 * sub-folder with its own index page belongs to that sub-hub.
 */
export function childrenTagCovers(tag: ChildrenTag, pagePath: string, hasIndex: (folder: string) => boolean): boolean {
	if (tag.exclude.has(pagePath) || pagePath.startsWith('sessions/') || pagePath.startsWith('archive/')) return false;
	const parts = pagePath.split('/');
	const isFolderPage = HUB_FILE.test(parts.at(-1) ?? '');
	let folder = parts.slice(0, isFolderPage ? -2 : -1).join('/');
	if (isFolderPage && parts.length === 1) return false;
	for (;;) {
		if (folder === tag.folder) return true;
		if (folder === '' || (tag.folder !== '' && !folder.startsWith(`${tag.folder}/`))) return false;
		if (hasIndex(folder)) return false;
		folder = folder.includes('/') ? folder.slice(0, folder.lastIndexOf('/')) : '';
	}
}

function attributeValue(attrs: string, name: string): string | undefined {
	const match = attrs.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i'));
	return match ? (match[1] ?? match[2]) : undefined;
}

/** A curated space path outside a page's data/ or assets/ folder. */
export function isCuratedPath(pagePath: string): boolean {
	return CURATED_PREFIXES.some((prefix) => pagePath.startsWith(prefix)) && !/\/(data|assets)\//.test(pagePath);
}

function isCuratedPage(page: WikiPageSummary): boolean {
	return page.kind === 'html' && isCuratedPath(page.path);
}

function isHub(pagePath: string): boolean {
	return pagePath === HOME || HUB_FILE.test(pagePath.split('/').at(-1) ?? '');
}

export function isRetiredStatus(status: string | undefined): boolean {
	return RETIRED_STATUSES.has((status ?? '').toLowerCase());
}

function isRetired(page: WikiPageSummary): boolean {
	return isRetiredStatus(page.meta.status);
}

/** The titleH1Mismatch rule: the meta title equals the first H1 once both are entity-decoded. */
export function titleMatchesH1(title: string, h1: string): boolean {
	return decodeHtmlEntities(title) === decodeHtmlEntities(h1);
}

/**
 * The current hubs (the home page and curated folder pages) that link `target`, the pages that
 * would turn into superseded_linked findings if `target` retired. The index is up to 5 s old, so
 * each candidate is read again from disk, and a hub repointed a moment ago no longer counts.
 */
export async function hubsLinking(target: string): Promise<string[]> {
	const index = await getWikiIndex();
	const curated = await readCuratedFiles(index);
	const hubs: string[] = [];
	for (const page of index.pages) {
		if (page.path === target || !isHub(page.path) || isRetired(page)) continue;
		if (!(isCuratedPage(page) || page.path === HOME) || !curated.get(page.path)?.links.has(target)) continue;
		const html = await readRawContent(page.path).catch(() => null);
		if (html && hrefTargets(html, page.path, index).has(target)) hubs.push(page.path);
	}
	return hubs;
}

/** Retired curated pages that hub `hubPath` links in `after` and did not in `before`: new superseded_linked findings. */
export async function retiredLinksAdded(hubPath: string, before: string | null, after: string): Promise<string[]> {
	if (!isHub(hubPath)) return [];
	const index = await getWikiIndex();
	const old = before === null ? new Set<string>() : hrefTargets(before, hubPath, index);
	return [...hrefTargets(after, hubPath, index)].filter((target) => {
		const page = index.byPath.get(target);
		return target !== hubPath && !old.has(target) && page !== undefined && isCuratedPage(page) && isRetired(page);
	});
}

function hrefTargets(html: string, pagePath: string, index: WikiIndex): Set<string> {
	const links = new Set<string>();
	for (const href of extractHtmlHrefs(html)) {
		const routed = href.trim().startsWith('/page/') ? href.trim().slice('/page/'.length) : href;
		const target = normalizeLinkTarget(routed, routed === href ? pagePath : HOME);
		if (target) links.add(resolveLink(target, index.byPath));
	}
	return links;
}

function isInternalTarget(target: string): boolean {
	// Resolved internal targets are bare relative paths; skip anything that still looks external.
	return !/^[a-z][a-z0-9+.-]*:/i.test(target) && !target.startsWith('#');
}

function isEntryFile(page: WikiPageSummary): boolean {
	if (!page.path.includes('/')) return true;
	const stem = (page.path.split('/').at(-1)?.toLowerCase() ?? '').replace(/\.[^.]+$/, '');
	return ENTRY_FILE_STEMS.has(stem);
}

function isArchival(page: WikiPageSummary): boolean {
	return ARCHIVAL_PREFIXES.some((prefix) => page.path.startsWith(prefix));
}

/** Decode common named and numeric HTML entities for title comparison. */
function decodeHtmlEntities(text: string): string {
	return text
		.replace(/&amp;/g, '&')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)))
		.replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}

function isUntitled(page: WikiPageSummary): boolean {
	if (page.kind !== 'md' && page.kind !== 'mdx' && page.kind !== 'html') return false;
	// Session artifacts are indexed unread, so their titles are filename-derived by design.
	if (isSessionPath(page.path)) return false;
	if (page.meta.title) return false;
	const derived = deriveTitleFromPath(page.path);
	// A page whose headings carry its title is titled — even when that title happens to
	// coincide with the filename-derived fallback (e.g. campaigns.html -> "Campaigns").
	return page.title === derived && !page.headings.includes(page.title);
}
