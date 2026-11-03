import path from 'node:path';
import type { WikiIndex, WikiPageSummary } from './wiki';

/**
 * Pages whose tree row changed, in order: a path is logged when its page is added, removed, retitled or
 * changes kind. A batch too large to log starts a new epoch instead, and the tree rebuilds once.
 */
export type TreeLog = { epoch: number; paths: string[] };

/** A batch of page changes by wiki path: the new summary as read from disk, or null for a removed page. */
export type PageChanges = Map<string, WikiPageSummary | null>;

/** Above this many order moves one filter and sort beats a splice per page, which each move the whole array. */
const SPLICE_LIMIT = 256;
const TREE_LOG_LIMIT = 4_096;
const PAGE_EXTENSIONS = ['.html', '.md', '.mdx'];
const FOLDER_PAGES = ['index.html', 'README.html', 'README.md'];

/** The first page a link target names: the path itself, then with a page extension, then as a folder. */
export function resolveLink(target: string, byPath: Map<string, WikiPageSummary>): string {
	if (byPath.has(target)) return target;
	for (const extension of PAGE_EXTENSIONS) {
		if (byPath.has(target + extension)) return target + extension;
	}
	for (const name of FOLDER_PAGES) {
		const candidate = path.posix.join(target, name);
		if (byPath.has(candidate)) return candidate;
	}
	return target;
}

/**
 * Every link target that `resolveLink` can resolve to `pagePath`. Targets come from `normalizeLinkTarget`,
 * so a folder target is `dir` or `dir/`. When a page appears or goes, only links to these targets can
 * resolve differently.
 */
function targetsResolvingTo(pagePath: string): string[] {
	const targets = [pagePath];
	for (const extension of PAGE_EXTENSIONS) {
		if (pagePath.endsWith(extension)) targets.push(pagePath.slice(0, -extension.length));
	}
	const slash = pagePath.lastIndexOf('/');
	if (FOLDER_PAGES.includes(pagePath.slice(slash + 1))) {
		const folder = pagePath.slice(0, Math.max(slash, 0));
		targets.push(folder, `${folder}/`);
	}
	return targets;
}

function newestFirst(a: WikiPageSummary, b: WikiPageSummary): number {
	if (a.updated !== b.updated) return a.updated < b.updated ? 1 : -1;
	return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

function sameLinks(a: string[], b: string[]): boolean {
	return a.length === b.length && a.every((link, i) => link === b[i]);
}

/**
 * The page index, kept current one batch at a time. A batch costs work for its own pages and for the pages
 * that link into it, never a pass over every page, apart from the one array copy a new snapshot takes.
 *
 * `byPath`, `backlinks` and `treeLog` are live and shared by every snapshot. Each snapshot owns its `pages`
 * array, so a caller that awaits while it walks the pages never sees them move.
 */
export class WikiIndexStore {
	readonly byPath = new Map<string, WikiPageSummary>();
	readonly backlinks = new Map<string, Set<string>>();
	readonly treeLog: TreeLog = { epoch: 0, paths: [] };
	/** Newest first, by `updated` and then path. */
	private order: WikiPageSummary[] = [];
	/** The summary as read, for each page with links. `byPath` holds a copy whose links are resolved. */
	private readonly linked = new Map<string, WikiPageSummary>();
	/** Raw link target to the pages whose links name it. */
	private readonly linkers = new Map<string, Set<string>>();
	private last: WikiIndex | null = null;

	/** True when a page changed since the last snapshot. */
	get stale(): boolean {
		return this.last === null;
	}

	snapshot(): WikiIndex {
		this.last ??= {
			generatedAt: Date.now(),
			pages: this.order.slice(),
			byPath: this.byPath,
			backlinks: this.backlinks,
			treeLog: this.treeLog,
		};
		return this.last;
	}

	/** Apply a batch. A summary identical to the stored one is not a change. */
	apply(changes: PageChanges): void {
		const removed: WikiPageSummary[] = [];
		const added: WikiPageSummary[] = [];
		const relinked: Array<[WikiPageSummary, WikiPageSummary]> = [];
		const appeared: string[] = [];
		const fresh = new Set<string>();
		const treePaths: string[] = [];
		for (const [pagePath, next] of changes) {
			const old = this.byPath.get(pagePath);
			const oldRaw = this.linked.get(pagePath) ?? old;
			if ((next ?? undefined) === oldRaw) continue;
			if (old && oldRaw) {
				this.dropEdges(pagePath, old.links);
				this.indexLinks(pagePath, oldRaw.links, false);
				this.linked.delete(pagePath);
				removed.push(old);
			}
			if (next) {
				this.indexLinks(pagePath, next.links, true);
				if (next.links.length > 0) this.linked.set(pagePath, next);
				this.byPath.set(pagePath, next);
				fresh.add(pagePath);
			} else {
				this.byPath.delete(pagePath);
			}
			if (!old || !next) appeared.push(pagePath);
			if (!old || !next || old.title !== next.title || old.kind !== next.kind) treePaths.push(pagePath);
		}
		if (removed.length === 0 && fresh.size === 0) return;

		const relink = new Set(fresh);
		for (const pagePath of appeared) {
			for (const target of targetsResolvingTo(pagePath)) {
				for (const source of this.linkers.get(target) ?? []) relink.add(source);
			}
		}
		for (const source of relink) {
			const current = this.byPath.get(source);
			const raw = this.linked.get(source) ?? current;
			if (!current || !raw) continue;
			const links = raw.links.map((link) => resolveLink(link, this.byPath));
			const isFresh = fresh.has(source);
			// A link can keep its text and still gain or lose its edge: a target that did not resolve is the page
			// that now appears, or the page that went. So edges are rebuilt for every relinked source.
			if (!isFresh) this.dropEdges(source, current.links);
			if (isFresh || !sameLinks(current.links, links)) {
				const page = links.length > 0 ? { ...raw, links } : raw;
				this.byPath.set(source, page);
				if (isFresh) added.push(page);
				else relinked.push([current, page]);
			}
			for (const target of links) {
				if (this.byPath.has(target)) this.edgesInto(target).add(source);
			}
		}

		// Same date and path, so the same place: a relinked page is swapped in where it was.
		for (const [before, after] of relinked) this.order[this.position(before)] = after;
		this.reorder(removed, added);
		this.logTree(treePaths);
		this.last = null;
	}

	private reorder(removed: WikiPageSummary[], added: WikiPageSummary[]): void {
		if (removed.length + added.length > SPLICE_LIMIT) {
			const gone = new Set(removed);
			this.order = this.order.filter((page) => !gone.has(page)).concat(added);
			this.order.sort(newestFirst);
			return;
		}
		for (const page of removed) this.order.splice(this.position(page), 1);
		for (const page of added) this.order.splice(this.position(page), 0, page);
	}

	/** Where `page` sits, or would sit, in `order`: a binary search, since paths are unique. */
	private position(page: WikiPageSummary): number {
		let low = 0;
		let high = this.order.length;
		while (low < high) {
			const mid = (low + high) >>> 1;
			if (newestFirst(this.order[mid], page) < 0) low = mid + 1;
			else high = mid;
		}
		return low;
	}

	private logTree(paths: string[]): void {
		if (paths.length === 0) return;
		if (this.treeLog.paths.length + paths.length > TREE_LOG_LIMIT) {
			this.treeLog.epoch += 1;
			this.treeLog.paths = [];
			return;
		}
		this.treeLog.paths.push(...paths);
	}

	private indexLinks(source: string, targets: string[], add: boolean): void {
		for (const target of targets) {
			let sources = this.linkers.get(target);
			if (add) {
				if (!sources) this.linkers.set(target, (sources = new Set<string>()));
				sources.add(source);
			} else if (sources?.delete(source) && sources.size === 0) {
				this.linkers.delete(target);
			}
		}
	}

	private edgesInto(target: string): Set<string> {
		let sources = this.backlinks.get(target);
		if (!sources) this.backlinks.set(target, (sources = new Set<string>()));
		return sources;
	}

	private dropEdges(source: string, links: string[]): void {
		for (const target of links) {
			const sources = this.backlinks.get(target);
			if (sources?.delete(source) && sources.size === 0) this.backlinks.delete(target);
		}
	}
}
