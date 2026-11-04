import { watch, type FSWatcher } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';
import { CODE_PREFIX, getMirrorFiles, inspectWikiFile, readWikiFile, type MirrorFile } from './wiki-mirror';
import { metaDescription, type WikiMeta } from './wiki-frontmatter';
import { artifactStub, isSessionArtifact, isSessionPath, listSessionLogs } from './session-artifact-index';
import { diskPath, mounts, wikiPathOf } from './wiki-mounts';
import { wikiConfig } from '../wiki-config.mjs';
import { FolderIndex } from './wiki-folders';
import { resolveLink, WikiIndexStore, type PageChanges, type TreeLog } from './wiki-index';
import {
	IGNORED_DIR_NAMES,
	IGNORED_EXTENSIONS,
	INDEXABLE_EXTENSIONS,
	isIgnoredWikiPath,
	isRepoCopy,
	shouldSkip,
} from './wiki-paths';
import { summarize } from './wiki-summary';

export { normalizeLinkTarget } from './wiki-summary';

export type { WikiMeta };

export type WikiPageSummary = {
	path: string;
	title: string;
	kind: string;
	size: number;
	updated: string;
	headings: string[];
	links: string[];
	excerpt: string;
	/** Unique lowercase body tokens — the full-text half of `searchPages`. See `makeSearchText`. */
	searchText: string;
	meta: WikiMeta;
	/** First `<h1>` text of an HTML page; the lint rule checks metadata `title` against it. */
	firstH1Text?: string;
};

export type WikiPage = WikiPageSummary & {
	content: string;
	backlinks: WikiPageSummary[];
	truncated: boolean;
};

export type WikiManifest = {
	name: string;
	generatedAt: string;
	contentRoot: string;
	pageCount: number;
	latestUpdated: string | null;
	endpoints: string[];
	warnings: string[];
};

/** One snapshot of the index. `pages` is newest first and belongs to this snapshot; the rest is live. */
export type WikiIndex = {
	generatedAt: number;
	pages: WikiPageSummary[];
	/** The session logs of `pages`, newest first, owned by this snapshot like `pages`. */
	sessionLogs: WikiPageSummary[];
	byPath: Map<string, WikiPageSummary>;
	backlinks: Map<string, Set<string>>;
	treeLog: TreeLog;
};

const CONTENT_ROOT = wikiConfig().contentRoot;
const CACHE_TTL_MS = 5_000;
const SUMMARY_READ_CONCURRENCY = 8;
/** Whole-page reads are capped so one huge page cannot blow an agent's context. Over the cap
 *  `GET /api/agent/page` refuses with the cap named rather than answering with a prefix, and the
 *  WRITE path needs the same number to detect a read-cap round-trip — see wiki-write.ts. */
// measured: VIR-266 (2026-09-08): an agent round trip through a silently capped 64 KiB read cost crawler-v3/fleet-findings.html its closing section; the cap now refuses with 413 and wiki-write.ts refuses a prefix write with 409 (a295804c7c, 7657da782c)
export const PAGE_READ_LIMIT = 64 * 1024;
// measured: VIR-266 (2026-09-08): an agent round trip through a silently capped 64 KiB read cost crawler-v3/fleet-findings.html its closing section; the cap now refuses with 413 and wiki-write.ts refuses a prefix write with 409 (a295804c7c, 7657da782c)
const LARGE_DOC_READ_LIMIT = 2 * 1024 * 1024;
const DEFAULT_CONTEXT_BUDGET = 8_000;

const ENDPOINTS = [
	'/api/agent/manifest',
	'/api/agent/search?q=api',
	'/api/agent/grep?pattern=billing&context=2',
	'/api/agent/find?glob=apps/**',
	'/api/agent/page?path=apps/llm-wiki',
	'/api/agent/activity?path=@code/.agents/skills/apps/llm-wiki/SKILL.md',
	'/api/agent/history?path=@code/.agents/skills/apps/llm-wiki/SKILL.md',
	'/api/agent/tree?path=apps&depth=2',
	'/api/agent/backlinks?path=apps/llm-wiki',
	'/api/agent/graph',
	'/api/agent/health',
	'/api/agent/context-pack?q=api&budget=8000',
	'/api/agent/recent?limit=20',
	'/api/agent/stale',
	'/api/agent/diff?path=apps/llm-wiki/index.html',
	'/api/agent/openapi',
	'/llms.txt',
	'/llms-full.txt',
];

/** Session logs and the archive are evidence, not curated truth: default discovery excludes them unless includeSessions= / includeArchive=. */
const ARCHIVE_PREFIXES = ['archive/'];

export type AuthorityOpts = { includeSessions?: boolean; includeArchive?: boolean };

export function pageAuthority(pagePath: string): 'session' | 'archive' | 'curated' {
	if (isSessionPath(pagePath)) return 'session';
	if (ARCHIVE_PREFIXES.some((p) => pagePath.startsWith(p))) return 'archive';
	return 'curated';
}

export function authorityAllows(pagePath: string, opts: AuthorityOpts = {}): boolean {
	const tier = pageAuthority(pagePath);
	if (tier === 'session') return opts.includeSessions === true;
	if (tier === 'archive') return opts.includeArchive === true;
	return true;
}

/** Parse the shared opt-in query params every discovery endpoint accepts. */
export function authorityOptsFrom(url: URL): AuthorityOpts {
	return {
		includeSessions: url.searchParams.get('includeSessions') === 'true',
		includeArchive: url.searchParams.get('includeArchive') === 'true',
	};
}

let cachedIndex: WikiIndex | null = null;
let inFlightIndex: Promise<WikiIndex> | null = null;

export function getContentRoot(): string {
	return CONTENT_ROOT;
}

export function normalizeRequestedPath(rawPath: string | null): string {
	if (!rawPath) throw new Error('Missing path');
	let decoded = rawPath;
	try {
		decoded = decodeURIComponent(rawPath);
	} catch {
		throw new Error('Invalid encoded path');
	}

	const normalizedInput = decoded.trim().replace(/\\/g, '/');
	if (!normalizedInput || normalizedInput.startsWith('/')) throw new Error('Invalid path');

	const normalized = path.posix.normalize(normalizedInput);
	if (normalized === '.' || normalized === '..' || normalized.startsWith('../') || normalized.includes('/../')) {
		throw new Error('Invalid path');
	}
	return normalized;
}

export async function getManifest(): Promise<WikiManifest> {
	const index = await getWikiIndex();
	const latestUpdated = index.pages[0]?.updated ?? null;
	const warnings: string[] = [];
	if (index.pages.length === 0) {
		warnings.push(`No indexable content found under ${CONTENT_ROOT} after local artifact ignores.`);
	}

	return {
		name: 'llm-wiki',
		generatedAt: new Date(index.generatedAt).toISOString(),
		contentRoot: CONTENT_ROOT,
		pageCount: index.pages.length,
		latestUpdated,
		endpoints: ENDPOINTS,
		warnings,
	};
}

export async function getHealth() {
	const index = await getWikiIndex();
	return {
		ok: true,
		contentRoot: CONTENT_ROOT,
		mounts: Object.fromEntries(mounts().map((m) => [m.name, m.dir])),
		pageCount: index.pages.length,
		cacheTtlMs: CACHE_TTL_MS,
		indexableExtensions: Array.from(INDEXABLE_EXTENSIONS).sort(),
		ignoredDirectories: Array.from(IGNORED_DIR_NAMES).sort(),
		ignoredExtensions: Array.from(IGNORED_EXTENSIONS).sort(),
	};
}

export async function searchPages(
	query: string,
	limit?: number,
	authority: AuthorityOpts = {},
): Promise<WikiPageSummary[]> {
	const index = await getWikiIndex();
	const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
	const pool = index.pages.filter((page) => authorityAllows(page.path, authority));

	if (terms.length === 0) return pool.slice(0, limit);

	return pool
		.map((page) => ({ page, ...scorePage(page, terms) }))
		.filter((item) => item.matched > 0)
		.sort((a, b) => b.matched - a.matched || b.score - a.score || b.page.updated.localeCompare(a.page.updated))
		.slice(0, limit)
		.map((item) => item.page);
}

export async function readPage(rawPath: string): Promise<WikiPage | null> {
	const requestedPath = normalizeRequestedPath(rawPath);
	const index = await getWikiIndex();
	// Resolve folder-paths (…/foo → …/foo/index.html) and bare names the same way links resolve.
	const resolvedPath = resolveLink(requestedPath, index.byPath);
	const file = await readServable(resolvedPath, index);
	if (!file) return null;
	const stored = file.bytes.toString('utf8');
	// Session artifacts are indexed from their path alone, so their title and headings come from this read.
	const indexed = index.byPath.get(resolvedPath);
	const page = indexed && !isSessionArtifact(resolvedPath) ? indexed : summarize(stored, resolvedPath, file.stat);
	if (page !== indexed) page.links = page.links.map((link) => resolveLink(link, index.byPath));

	const readLimit = readLimitFor(page.path);
	// Sized from the bytes just read, not from the index: the index is up to CACHE_TTL_MS stale,
	// and callers refuse the read on `truncated`, so it has to be exact for a page written a
	// second ago.
	const size = Buffer.byteLength(stored);
	const truncated = size > readLimit;
	const backlinkPaths = Array.from(index.backlinks.get(page.path) ?? []);
	const backlinks = backlinkPaths
		.map((linkPath) => index.byPath.get(linkPath))
		.filter((item): item is WikiPageSummary => Boolean(item));

	return {
		...page,
		size,
		content: truncated ? Buffer.from(stored, 'utf8').subarray(0, readLimit).toString('utf8') : stored,
		backlinks,
		truncated,
	};
}

/** Every stored byte of a page (confined, mirror-aware), without the backlink cost — for grep and
 *  section/line reads. Uncapped: both callers answer with a slice, so a cap here would only hide
 *  the matches and sections that live past it. */
export async function readRawContent(rawPath: string): Promise<string | null> {
	const requestedPath = normalizeRequestedPath(rawPath);
	const index = await getWikiIndex();
	const resolvedPath = resolveLink(requestedPath, index.byPath);
	return (await readServable(resolvedPath, index))?.bytes.toString('utf8') ?? null;
}

/**
 * An indexed page, or a session artifact the background scan has not listed yet, so a page written or
 * linked a moment after start still opens. Null when the path is not a page or the file is gone.
 */
async function readServable(wikiPath: string, index: WikiIndex) {
	if (!index.byPath.has(wikiPath) && (!isSessionArtifact(wikiPath) || shouldSkip(wikiPath))) return null;
	try {
		return await readWikiFile({ wikiPath, contentRoot: CONTENT_ROOT });
	} catch (error) {
		if (isMissing(error)) return null;
		throw error;
	}
}

export async function getBacklinks(rawPath: string): Promise<WikiPageSummary[]> {
	const requestedPath = normalizeRequestedPath(rawPath);
	const index = await getWikiIndex();
	// Folder-paths resolve the same way links and page reads do (…/foo → …/foo/index.html).
	const resolvedPath = resolveLink(requestedPath, index.byPath);
	return Array.from(index.backlinks.get(resolvedPath) ?? [])
		.map((linkPath) => index.byPath.get(linkPath))
		.filter((item): item is WikiPageSummary => Boolean(item))
		.sort((a, b) => b.updated.localeCompare(a.updated));
}

export async function getGraph(authority: AuthorityOpts = {}) {
	const index = await getWikiIndex();
	const nodes = index.pages.filter((page) => authorityAllows(page.path, authority));
	const nodeIds = new Set(nodes.map((page) => page.path));
	const edges = nodes.flatMap((page) =>
		page.links
			.filter((target) => nodeIds.has(target))
			.map((target) => ({
				source: page.path,
				target,
			})),
	);

	return {
		nodes: nodes.map((page) => ({
			id: page.path,
			title: page.title,
			kind: page.kind,
			updated: page.updated,
		})),
		edges,
	};
}

export async function getRecent(
	category: string | null,
	limit: number,
	authority: AuthorityOpts = {},
): Promise<WikiPageSummary[]> {
	const index = await getWikiIndex();
	const prefix = category ? `${category.replace(/^\/+|\/+$/g, '')}/` : null;
	// Explicitly asking for an excluded space (?category=history) is its own opt-in.
	const opts: AuthorityOpts =
		prefix && pageAuthority(prefix) !== 'curated' ? { includeSessions: true, includeArchive: true } : authority;
	return index.pages
		.filter((page) => (prefix ? page.path.startsWith(prefix) : true) && authorityAllows(page.path, opts))
		.slice(0, limit);
}

export async function getContextPack(query: string, budget = DEFAULT_CONTEXT_BUDGET, authority: AuthorityOpts = {}) {
	const selectedPages = await searchPages(query, 10, authority);
	const chunks: Array<{ path: string; title: string; content: string }> = [];
	let remaining = budget;

	for (const page of selectedPages) {
		if (remaining <= 0) break;
		const content = (
			await readWikiFile({
				wikiPath: page.path,
				contentRoot: CONTENT_ROOT,
				maxBytes: remaining,
			})
		).bytes.toString('utf8');
		chunks.push({ path: page.path, title: page.title, content });
		remaining -= content.length;
	}

	return {
		query,
		budget,
		used: budget - remaining,
		chunks,
	};
}

export async function getLlmsText(full = false): Promise<string> {
	const manifest = await getManifest();
	const index = await getWikiIndex();
	const lines = [
		'# llm-wiki',
		'',
		'Local project memory for humans and agents.',
		'',
		`Content root: ${manifest.contentRoot}`,
		`Indexed pages: ${manifest.pageCount}`,
		'',
		'Agent APIs:',
		...manifest.endpoints.map((endpoint) => `- ${endpoint}`),
		'',
		'Recent pages:',
		...index.pages
			.filter((page) => authorityAllows(page.path))
			.slice(0, full ? 100 : 25)
			.map((page) => `- ${page.path} - ${page.title}`),
	];

	if (manifest.warnings.length > 0) {
		lines.push('', 'Warnings:', ...manifest.warnings.map((warning) => `- ${warning}`));
	}

	if (full) {
		const fullPages = index.pages.filter((page) => authorityAllows(page.path)).slice(0, 50);
		for (const page of fullPages) {
			const content = (await readRawContent(page.path)) ?? '';
			lines.push('', `## ${page.path}`, '', content.slice(0, 4_000).trim());
		}
	}

	return `${lines.join('\n')}\n`;
}

/**
 * A full scan walks thousands of folders and takes seconds, so only the first build blocks. After that a
 * stale index is served while one refresh runs in the background.
 */
export async function getWikiIndex(): Promise<WikiIndex> {
	if (retired) return store.snapshot();
	const watching = watchContent();
	if (!cachedIndex) return refreshWikiIndex();
	// One refresh at a time. A caller during it must not flag another full scan: the TTL is still due until
	// the running refresh re-lists the mirror, so without a watcher that flag queued a second walk of content/.
	if (inFlightIndex) return cachedIndex;
	const due = Date.now() - mirrorCheckedAt >= CACHE_TTL_MS;
	if (!watching && due) needsFullScan = true;
	if (!needsFullScan && changedPaths.size === 0 && !store.stale && !due) return cachedIndex;
	// A few changed pages re-read in milliseconds, so wait for them: a page written a moment ago resolves.
	// The check runs before the refresh starts, because the refresh takes and clears the batch at once.
	// A folder event walks and reads the whole folder, such as a repo tree copied into a session folder, and
	// the @code mirror re-list stats about 150 files. Under swap the first caller waited on those past the
	// d1 probe's 5 s (GET / 8.7 s on 2026-10-17 at 22:41Z while /health, served the cached index, took 3.6 s).
	// The background artifact listing only marks the store stale, and its snapshot builds without a read.
	const wait =
		watching &&
		!needsFullScan &&
		(changedPaths.size > 0 || store.stale) &&
		changedPaths.size <= 200 &&
		[...changedPaths].every(isPageEvent);
	const refresh = refreshWikiIndex();
	if (wait) return refresh;
	refresh.catch((error) => console.error('[llm-wiki] index refresh failed', error));
	return cachedIndex;
}

/** A watcher event for a page file. A folder or a temp file has no page extension. */
function isPageEvent(filename: string): boolean {
	return !isIgnoredWikiPath(filename.split(path.sep).join('/'));
}

function refreshWikiIndex(): Promise<WikiIndex> {
	inFlightIndex ??= updateWikiIndex()
		.then((index) => (cachedIndex = index))
		.finally(() => {
			inFlightIndex = null;
		});
	return inFlightIndex;
}

/**
 * content/ holds about 117k indexable files in 61k folders, and all but about 3.5k are session
 * artifacts: the files agents leave next to a session log. A full scan reads the curated pages and the
 * session logs, and lists sessions/ only to the depth of a log. The artifacts are walked afterwards in
 * the background and indexed from path and stat alone (see `artifactStub`). Reading them all held about
 * 1 GB of search tokens, and the walk took 100-140 s on a loaded Mac before the first page could load.
 *
 * The full scan runs once at start, and again only when the watcher reports no file name or fails.
 * Every other refresh re-reads just the paths fs.watch reported and hands them to the store as one batch
 * (see wiki-index.ts). The @code mirror lives outside content/, so no watcher reports it: it is re-listed
 * on its own timer, at most every CACHE_TTL_MS, and not on every content change.
 */
let needsFullScan = true;
let artifactScan: Promise<void> | null = null;
const SESSIONS_ROOT = path.join(CONTENT_ROOT, 'sessions');
const changedPaths = new Set<string>();
let contentWatcher: FSWatcher | null = null;
/**
 * On Linux, one inotify watch per folder the walks index, keyed by wiki path. Node's recursive watch there
 * would also list and watch every repo copy and node_modules folder in sessions/. On us-metal02 on
 * 2026-10-24 the walks covered 118,904 folders, and watching them all took 1.5 s and 130 MB.
 */
let folderWatchers: Map<string, FSWatcher> | null = null;
let folderWatchFailed = false;
let mirrorCheckedAt = 0;
let mirrorPaths = new Set<string>();
let store = new WikiIndexStore();
const folders = new FolderIndex();

/**
 * In dev an edit re-evaluates this module, and Vite's SSR runner keeps the old one until every route that
 * imported it is requested again. Each evaluation retires the previous one: no watcher, no scan, no index.
 */
let retired = false;
const reloads = globalThis as { llmWikiRetire?: () => void };
reloads.llmWikiRetire?.();
reloads.llmWikiRetire = () => {
	retired = true;
	contentWatcher?.close();
	contentWatcher = null;
	stopFolderWatch();
	cachedIndex = null;
	store = new WikiIndexStore();
	folders.clear();
	summaryCache.clear();
	changedPaths.clear();
	mirrorPaths = new Set();
};

function watchContent(): boolean {
	if (contentWatcher || folderWatchers) return true;
	if (retired) return false;
	// The Vercel deploy serves a read-only copy, so it rescans on the TTL. Without per-folder watches a box rescanned
	// all of content/ after every TTL and the artifact walk ran at 0.6-0.8 of a core.
	if (process.env.VERCEL) return false;
	if (process.platform === 'linux') {
		if (folderWatchFailed) return false;
		folderWatchers = new Map();
		needsFullScan = true;
		return true;
	}
	if (process.platform !== 'darwin' && process.platform !== 'win32') return false;
	try {
		contentWatcher = watch(CONTENT_ROOT, { recursive: true, persistent: false }, (_event, filename) => {
			if (filename) changedPaths.add(String(filename));
			else needsFullScan = true;
		});
	} catch (error) {
		console.error('[llm-wiki] cannot watch content/, rescanning on a timer', error);
		return false;
	}
	contentWatcher.on('error', (error) => {
		console.error('[llm-wiki] content watcher failed, rescanning', error);
		contentWatcher?.close();
		contentWatcher = null;
		needsFullScan = true;
	});
	return true;
}

/** Watch one folder before it is read, so a file written after the read is still reported. */
function watchFolder(fullPath: string): void {
	const folder = toContentPath(fullPath);
	if (!folderWatchers || folderWatchers.has(folder)) return;
	try {
		const watcher = watch(fullPath, { persistent: false }, (_event, filename) => {
			if (filename) changedPaths.add(path.join(folder, String(filename)));
			else needsFullScan = true;
		});
		watcher.on('error', (error) => {
			console.error('[llm-wiki] content folder watcher failed, rescanning', error);
			unwatchFolders(folder);
			needsFullScan = true;
		});
		folderWatchers.set(folder, watcher);
	} catch (error) {
		if (isMissing(error)) return;
		console.error('[llm-wiki] cannot watch a content folder, rescanning on a timer', error);
		stopFolderWatch();
		folderWatchFailed = true;
		needsFullScan = true;
	}
}

/** Close the watch on a removed or moved folder and on every folder under it. */
function unwatchFolders(folder: string): void {
	const watcher = folderWatchers?.get(folder);
	if (!folderWatchers || !watcher) return;
	watcher.close();
	folderWatchers.delete(folder);
	const prefix = `${folder}/`;
	for (const [key, nested] of folderWatchers) {
		if (!key.startsWith(prefix)) continue;
		nested.close();
		folderWatchers.delete(key);
	}
}

function stopFolderWatch(): void {
	for (const watcher of folderWatchers?.values() ?? []) watcher.close();
	folderWatchers = null;
}

async function updateWikiIndex(): Promise<WikiIndex> {
	const full = needsFullScan || !cachedIndex;
	const changed = full ? [] : [...changedPaths];
	needsFullScan = false;
	changedPaths.clear();
	try {
		if (full) {
			const files = [
				...(await walkContent(CONTENT_ROOT, SESSIONS_ROOT)),
				...(await listSessionLogs(SESSIONS_ROOT, (dir) => shouldSkip(toContentPath(dir), true), watchFolder)),
			];
			for (const mount of mounts()) await walkContent(mount.dir, undefined, files);
			const scanned = (wikiPath: string) => !wikiPath.startsWith(CODE_PREFIX) && !isSessionsArtifact(wikiPath);
			replaceTier(scanned, await readSummaries(asContentFiles(files)));
			// One artifact scan at a time. Without a watcher a full scan comes every CACHE_TTL_MS, and the artifact walk of
			// sessions/ (1.1M files, 272k indexed) takes about 4.5 minutes, so starting one per full scan stacked
			// dozens of walks, each holding every path, until the heap ran out (exit 134 three times on us-metal02
			// on 2026-10-18, and a copy of that code grew 110 MB a minute without one walk finishing).
			artifactScan ??= scanSessionArtifacts()
				.catch((error) => {
					console.error('[llm-wiki] session artifact scan failed', error);
					needsFullScan = true;
				})
				.finally(() => {
					artifactScan = null;
				});
		} else {
			// A copied or removed tree reports every folder in it. The top folder's walk covers the rest.
			const batch = new Set(changed);
			const changes: PageChanges = new Map();
			for (const filename of changed) {
				if (!hasAncestorIn(filename, batch)) await readContentChange(filename, changes);
			}
			commit(changes);
		}
		if (full || Date.now() - mirrorCheckedAt >= CACHE_TTL_MS) await refreshMirror();
		return store.snapshot();
	} catch (error) {
		needsFullScan = true;
		throw error;
	}
}

function hasAncestorIn(filename: string, batch: Set<string>): boolean {
	for (let folder = path.dirname(filename); folder !== '.'; folder = path.dirname(folder)) {
		if (batch.has(folder)) return true;
	}
	return false;
}

/** Apply a batch, and forget the read memo of every page it removes. */
function commit(changes: PageChanges): void {
	for (const [wikiPath, page] of changes) {
		if (!page) {
			summaryCache.delete(wikiPath);
			folders.remove(wikiPath);
		} else if (!wikiPath.startsWith(CODE_PREFIX)) {
			folders.add(wikiPath);
		}
	}
	store.apply(changes);
}

/** Make `pages` the whole of the tier `inTier` claims: a stored page of that tier missing from `pages` is removed. */
function replaceTier(inTier: (wikiPath: string) => boolean, pages: Map<string, WikiPageSummary>): void {
	const changes: PageChanges = new Map(pages);
	for (const wikiPath of store.byPath.keys()) {
		if (inTier(wikiPath) && !pages.has(wikiPath)) changes.set(wikiPath, null);
	}
	commit(changes);
}

/** Re-list the @code mirror. It is about 150 files, and an unchanged file keeps its memoized summary. */
async function refreshMirror(): Promise<void> {
	mirrorCheckedAt = Date.now();
	const pages = await readSummaries(await getMirrorFiles(isIgnoredWikiPath));
	const changes: PageChanges = new Map(pages);
	for (const wikiPath of mirrorPaths) {
		if (!pages.has(wikiPath)) changes.set(wikiPath, null);
	}
	mirrorPaths = new Set(pages.keys());
	commit(changes);
}

async function scanSessionArtifacts(): Promise<void> {
	const pages = new Map<string, WikiPageSummary>();
	await stubArtifacts(SESSIONS_ROOT, pages);
	if (!retired) replaceTier(isSessionsArtifact, pages);
}

/** Stub the session artifacts under `root` into `pages`, one folder's files at a time, so no list of every path is held. */
async function stubArtifacts(root: string, pages: Map<string, WikiPageSummary>): Promise<void> {
	if (retired) return;
	watchFolder(root);
	let entries;
	try {
		entries = await readdir(root, { withFileTypes: true });
	} catch (error) {
		if (isMissing(error)) return;
		throw error;
	}
	if (isRepoCopy(entries)) return unwatchFolders(toContentPath(root));
	const files: MirrorFile[] = [];
	for (const entry of entries) {
		if (entry.isSymbolicLink()) continue;
		const fullPath = path.join(root, entry.name);
		const wikiPath = toContentPath(fullPath);
		if (shouldSkip(wikiPath, entry.isDirectory())) continue;
		if (entry.isDirectory()) await stubArtifacts(fullPath, pages);
		else if (entry.isFile() && isSessionArtifact(wikiPath)) files.push({ fullPath, wikiPath });
	}
	await readSummaries(files, pages);
}

function asContentFiles(files: string[]): MirrorFile[] {
	return files.map((fullPath) => ({ fullPath, wikiPath: toContentPath(fullPath) }));
}

/** Re-read one path fs.watch reported into `changes`. */
async function readContentChange(filename: string, changes: PageChanges): Promise<void> {
	const wikiPath = filename.split(path.sep).join('/');
	const fullPath = diskPath(wikiPath);
	let info;
	try {
		info = await lstat(fullPath);
	} catch (error) {
		if (!isMissing(error)) throw error;
	}
	if (info?.isFile() && !shouldSkip(wikiPath)) {
		if (folders.has(wikiPath)) removeUnder(wikiPath, changes); // a folder replaced by a file
		const page = (await readSummaries([{ fullPath, wikiPath }])).get(wikiPath);
		if (page) changes.set(wikiPath, page);
		else removeUnder(wikiPath, changes);
	} else if (info?.isDirectory()) {
		if (shouldSkip(wikiPath, true)) return;
		// A folder created or moved in: its files may arrive as one event for the folder. The walk is diffed
		// against the pages stored under it, and an unchanged file keeps its memoized summary.
		const pages = await readSummaries(asContentFiles(await walkContent(fullPath)));
		const prefix = `${wikiPath}/`;
		for (const pagePath of [...folders.pagesUnder(wikiPath), ...changes.keys()]) {
			if (pagePath.startsWith(prefix) && !pages.has(pagePath)) changes.set(pagePath, null);
		}
		for (const [pagePath, page] of pages) changes.set(pagePath, page);
	} else {
		removeUnder(wikiPath, changes);
	}
}

/** Mark a removed page, or every page under a removed folder, as gone. */
function removeUnder(wikiPath: string, changes: PageChanges): void {
	unwatchFolders(wikiPath);
	if (store.byPath.has(wikiPath) || changes.has(wikiPath)) {
		changes.set(wikiPath, null);
		return;
	}
	// Atomic writes remove a temp file on every save. Only a folder that held pages has pages to drop.
	const prefix = `${wikiPath}/`;
	folders.remove(wikiPath);
	for (const key of [...folders.pagesUnder(wikiPath, true), ...changes.keys()]) {
		if (key.startsWith(prefix)) changes.set(key, null);
	}
}

/** Summaries by wiki path. A file that is gone by the time it is read is left out. */
async function readSummaries(
	files: MirrorFile[],
	pages = new Map<string, WikiPageSummary>(),
): Promise<Map<string, WikiPageSummary>> {
	const pending = files.values();
	await Promise.all(
		Array.from({ length: SUMMARY_READ_CONCURRENCY }, async () => {
			for (const { wikiPath } of pending) {
				if (retired) return;
				try {
					// Keyed by the summary's own path, so an unchanged page keeps the string the index already holds
					// and the walk's copy of it is freed.
					const page = await readSummary(wikiPath);
					pages.set(page.path, page);
				} catch (error) {
					if (!isMissing(error)) throw error;
					summaryCache.delete(wikiPath);
				}
			}
		}),
	);
	return pages;
}

/**
 * Every indexable file under `root`, leaving out the folder `prune`, appended to `files`. One list is
 * passed down: spreading a folder's 100k+ files into `push` overflowed the call stack.
 */
async function walkContent(root: string, prune?: string, files: string[] = []): Promise<string[]> {
	if (retired) return files;
	watchFolder(root);
	let entries;
	try {
		entries = await readdir(root, { withFileTypes: true });
	} catch (error) {
		if (isMissing(error)) return files;
		throw error;
	}
	if (isRepoCopy(entries)) {
		unwatchFolders(toContentPath(root));
		return files;
	}

	for (const entry of entries) {
		if (entry.isSymbolicLink()) continue;
		const fullPath = path.join(root, entry.name);
		const relativePath = toContentPath(fullPath);
		if (fullPath === prune || shouldSkip(relativePath, entry.isDirectory())) continue;

		if (entry.isDirectory()) {
			await walkContent(fullPath, prune, files);
		} else if (entry.isFile()) {
			files.push(fullPath);
		}
	}

	return files;
}

/**
 * Extraction memo for read pages, keyed by wiki path and stamped with (mtime, size).
 *
 * A full scan would otherwise re-read and re-parse ~93 MB from disk. The summary for an
 * unchanged file is reused, so only changed files pay the parse. The same object comes back,
 * which is how the store sees that a page did not change. Session artifacts skip the memo:
 * a stub is made from path, size and mtime alone, so the stored stub is its own memo.
 */
const summaryCache = new Map<string, { mtimeMs: number; size: number; summary: WikiPageSummary }>();

async function readSummary(wikiPath: string): Promise<WikiPageSummary> {
	const { stat: fileStat } = await inspectWikiFile({ wikiPath, contentRoot: CONTENT_ROOT });
	if (isSessionArtifact(wikiPath)) {
		const stored = store.byPath.get(wikiPath);
		if (stored?.size === fileStat.size && stored.updated === fileStat.mtime.toISOString()) return stored;
		return artifactStub(wikiPath, fileStat);
	}
	const cached = summaryCache.get(wikiPath);
	if (cached && cached.mtimeMs === fileStat.mtimeMs && cached.size === fileStat.size) return cached.summary;

	const summary = summarize(
		(await readWikiFile({ wikiPath, contentRoot: CONTENT_ROOT })).bytes.toString('utf8'),
		wikiPath,
		fileStat,
	);
	summaryCache.set(wikiPath, { mtimeMs: fileStat.mtimeMs, size: fileStat.size, summary });
	return summary;
}

function toContentPath(fullPath: string): string {
	return wikiPathOf(fullPath);
}

/** A session artifact under sessions/, the tier the background walk of SESSIONS_ROOT owns; a job folder's artifacts in a mount are walked with the mount. */
function isSessionsArtifact(wikiPath: string): boolean {
	return wikiPath.startsWith('sessions/') && isSessionArtifact(wikiPath);
}

function isMissing(error: unknown): boolean {
	return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

/** The fields a query is matched against, most authoritative first. */
function haystacksFor(page: WikiPageSummary): Array<{ value: string; weight: number }> {
	const facets = [...page.meta.tags, ...page.meta.apps, ...(page.meta.projects ?? []), ...(page.meta.domains ?? [])];
	return [
		{ value: page.title.toLowerCase(), weight: 10 },
		{ value: page.headings.join(' ').toLowerCase(), weight: 6 },
		{ value: (metaDescription(page.meta) ?? '').toLowerCase(), weight: 5 },
		{ value: page.path.toLowerCase(), weight: 4 },
		{ value: facets.join(' ').toLowerCase(), weight: 4 },
		{ value: page.excerpt.toLowerCase(), weight: 2 },
		{ value: page.searchText, weight: 1 },
	];
}

/**
 * Whole-token hits beat mid-word hits. Without this, `tracking` scored the same in
 * "Brand tracking" as inside "backtracking", and the ranking read as noise.
 */
function fieldScore(haystack: string, term: string): number {
	const at = haystack.indexOf(term);
	if (at === -1) return 0;
	const before = haystack[at - 1] ?? ' ';
	const after = haystack[at + term.length] ?? ' ';
	const wholeToken = !/[\p{L}\p{N}]/u.test(before) && !/[\p{L}\p{N}]/u.test(after);
	return wholeToken ? 1 : 0.4;
}

/**
 * Weighted relevance plus `matched`, the count of query terms the page carries. Ranking sorts on `matched` first,
 * so a page loud on one term does not outrank a page with every term.
 */
function scorePage(page: WikiPageSummary, terms: string[]): { score: number; matched: number } {
	const haystacks = haystacksFor(page);
	let score = 0;
	let matched = 0;

	for (const term of terms) {
		let termScore = 0;
		for (const haystack of haystacks) termScore += haystack.weight * fieldScore(haystack.value, term);
		if (termScore > 0) matched += 1;
		score += termScore;
	}

	// Whole-phrase hit in an authoritative field: "agent sql gateway" should out-rank
	// a page that merely mentions all three words in scattered places.
	if (terms.length > 1) {
		const phrase = terms.join(' ');
		for (const haystack of haystacks.slice(0, 4)) {
			if (haystack.value.includes(phrase)) score += haystack.weight * 2;
		}
	}

	return { score, matched };
}

/** The whole-read cap of a content path: past it GET /api/agent/page answers 413 instead of the page. */
export function readLimitFor(relativePath: string): number {
	return isLargeTextDoc(relativePath) ? LARGE_DOC_READ_LIMIT : PAGE_READ_LIMIT;
}

function isLargeTextDoc(relativePath: string): boolean {
	const name = path.posix.basename(relativePath).toLowerCase();
	return name === 'index.md' || name === 'sitemap.md';
}
