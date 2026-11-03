import { base } from '$app/paths';
import { getWikiIndex, type WikiPageSummary } from './wiki';
import type { TreeLog } from './wiki-index';

export type WikiTreeNode = {
	name: string;
	path: string;
	type: 'dir' | 'file';
	title?: string;
	kind?: string;
	/** Folder-as-page: the dir's own index.html/README.html — the folder row links here. */
	pagePath?: string;
	children: WikiTreeNode[];
	/** Set on trimmed trees: the real number of children when `children` was left empty. */
	childCount?: number;
};

/**
 * The tree plus what it needs to patch itself: every folder by path, and how far into the log it has read.
 * `sections` counts the pages under each top-level folder, kept as pages come and go, because counting them
 * walks every node in the tree, and on a swapped-out dev server that walk held GET / for 192 s.
 */
export type TreeState = {
	epoch: number;
	seen: number;
	root: WikiTreeNode;
	folders: Map<string, WikiTreeNode>;
	sections: Map<string, number>;
};

/** The pages a folder row stands for, in order of precedence. */
const FOLDED_PAGES = ['index.html', 'README.html'];

let state: TreeState | null = null;
const reloads = globalThis as { llmWikiTreeRetire?: () => void };
reloads.llmWikiTreeRetire?.();
reloads.llmWikiTreeRetire = () => {
	state = null;
};

/**
 * The whole tree. Callers must not mutate it, and must copy what they keep: the next call patches it in
 * place. Most writes only change a file's date and leave it alone.
 */
export async function getTree(): Promise<WikiTreeNode[]> {
	const { byPath, treeLog } = await getWikiIndex();
	state = syncTree(state, byPath, treeLog);
	return state.root.children;
}

/**
 * The tree for the live pages. It replays the tree log: each logged page was added, removed, retitled or
 * changed kind, and only that page's row and folders change. A new log epoch rebuilds the tree.
 */
export function syncTree(current: TreeState | null, byPath: Map<string, WikiPageSummary>, log: TreeLog): TreeState {
	if (!current || current.epoch !== log.epoch) return buildTree(byPath, log);
	for (; current.seen < log.paths.length; current.seen += 1) placePage(current, byPath, log.paths[current.seen]);
	return current;
}

/**
 * The folder `base` ('' for the root), `depth` levels deep. Folders below that come back with empty
 * `children` and their `childCount`. Null when `base` is not a folder.
 */
export async function getSubtree(base: string, depth: number): Promise<WikiTreeNode[] | null> {
	let nodes = await getTree();
	for (const segment of base.split('/').filter(Boolean)) {
		const dir = nodes.find((node) => node.type === 'dir' && node.name === segment);
		if (!dir) return null;
		nodes = dir.children;
	}
	return nodes.map((node) => trim(node, depth));
}

/**
 * The page rail's tree: the top level, plus the children of every folder on the way to `openPath`.
 * The full tree is ~25k pages and ~13 MB, so the rail loads any other folder when the reader opens it.
 */
export async function getRailTree(openPath: string): Promise<WikiTreeNode[]> {
	const open = openPath.split('/').filter(Boolean);
	const branch = (node: WikiTreeNode, level: number): WikiTreeNode => ({
		...node,
		childCount: node.children.length,
		children:
			node.type === 'dir' && open[level] === node.name ? node.children.map((child) => branch(child, level + 1)) : [],
	});
	return (await getTree()).map((node) => branch(node, 0));
}

function trim(node: WikiTreeNode, depth: number): WikiTreeNode {
	if (depth <= 1) return { ...node, childCount: node.children.length, children: [] };
	return { ...node, children: node.children.map((child) => trim(child, depth - 1)) };
}

/** The home page's section cards: each top-level folder, its link and its page count. */
export async function getSections(): Promise<{ name: string; path: string; href: string; pages: number }[]> {
	const nodes = await getTree();
	const sections = state?.sections ?? new Map<string, number>();
	return nodes
		.filter((node) => node.type === 'dir')
		.map((node) => ({
			name: node.name,
			path: node.path,
			href: sectionHref(node),
			pages: sections.get(node.name) ?? 0,
		}));
}

function sectionHref(node: WikiTreeNode): string {
	if (node.name === 'sessions') return `${base}/timeline`;
	if (node.pagePath) return `${base}/page/${node.pagePath}`;
	const firstFile = node.children.find((child) => child.type === 'file');
	return `${base}/page/${firstFile?.path ?? node.path}`;
}

/** Build a sorted folder tree (dirs first, alpha) from every page. */
function buildTree(byPath: Map<string, WikiPageSummary>, log: TreeLog): TreeState {
	const root: WikiTreeNode = { name: '', path: '', type: 'dir', children: [] };
	const tree: TreeState = {
		epoch: log.epoch,
		seen: log.paths.length,
		root,
		folders: new Map([['', root]]),
		sections: new Map(),
	};
	for (const page of byPath.values()) {
		folderAt(tree, folderOf(page.path)).children.push(fileNode(page));
		countSection(tree, page.path, 1);
	}
	sortTree(root.children);
	for (const folder of tree.folders.values()) {
		if (folder.path) fold(folder, byPath);
	}
	return tree;
}

/** Put one page's row where the live pages say it belongs, or take it out. */
function placePage(tree: TreeState, byPath: Map<string, WikiPageSummary>, pagePath: string): void {
	const folderPath = folderOf(pagePath);
	const name = pagePath.slice(pagePath.lastIndexOf('/') + 1);
	const page = byPath.get(pagePath);
	const folder = page ? folderAt(tree, folderPath) : tree.folders.get(folderPath);
	if (!folder) return;
	countSection(tree, pagePath, (page ? 1 : 0) - (hasRow(folder, pagePath, name) ? 1 : 0));
	if (folderPath && FOLDED_PAGES.includes(name)) {
		fold(folder, byPath);
	} else {
		removeNode(folder.children, 'file', name);
		if (page) insertNode(folder.children, fileNode(page));
	}
	prune(tree, folder);
}

/** True when the tree shows `pagePath`, as `folder`'s own page or as a file row in it. */
function hasRow(folder: WikiTreeNode, pagePath: string, name: string): boolean {
	if (folder.pagePath === pagePath) return true;
	const row = folder.children[lowerBound(folder.children, { type: 'file', name })];
	return row?.type === 'file' && row.name === name;
}

function countSection(tree: TreeState, pagePath: string, delta: number): void {
	const slash = pagePath.indexOf('/');
	if (slash < 0 || delta === 0) return;
	const section = pagePath.slice(0, slash);
	tree.sections.set(section, (tree.sections.get(section) ?? 0) + delta);
}

function folderOf(pagePath: string): string {
	const slash = pagePath.lastIndexOf('/');
	return slash < 0 ? '' : pagePath.slice(0, slash);
}

function fileNode(page: WikiPageSummary): WikiTreeNode {
	return {
		name: page.path.slice(page.path.lastIndexOf('/') + 1),
		path: page.path,
		type: 'file',
		title: page.title,
		kind: page.kind,
		children: [],
	};
}

function folderAt(tree: TreeState, folderPath: string): WikiTreeNode {
	let folder = tree.folders.get(folderPath);
	if (folder) return folder;
	folder = { name: folderPath.slice(folderPath.lastIndexOf('/') + 1), path: folderPath, type: 'dir', children: [] };
	insertNode(folderAt(tree, folderOf(folderPath)).children, folder);
	tree.folders.set(folderPath, folder);
	return folder;
}

/**
 * A folder with its own index.html or README.html is that page: the folder row links to it and the index child is
 * dropped, so single-page folders collapse to one row. The content root never folds.
 */
function fold(folder: WikiTreeNode, byPath: Map<string, WikiPageSummary>): void {
	if (folder.pagePath !== undefined) {
		delete folder.pagePath;
		delete folder.title;
	}
	for (const name of FOLDED_PAGES) {
		removeNode(folder.children, 'file', name);
		const page = byPath.get(`${folder.path}/${name}`);
		if (!page) continue;
		if (folder.pagePath === undefined) {
			folder.pagePath = page.path;
			folder.title = page.title;
		} else {
			insertNode(folder.children, fileNode(page));
		}
	}
}

/** Drop a folder left with no page, and each parent that leaves empty. */
function prune(tree: TreeState, folder: WikiTreeNode): void {
	while (folder.path && folder.children.length === 0 && folder.pagePath === undefined) {
		const parent = tree.folders.get(folderOf(folder.path));
		if (!parent) return;
		tree.folders.delete(folder.path);
		removeNode(parent.children, 'dir', folder.name);
		folder = parent;
	}
}

type NodeKey = Pick<WikiTreeNode, 'type' | 'name'>;

function compareNodes(a: NodeKey, b: NodeKey): number {
	if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
	// Meta tiers (e.g. the read-only @code mirror) sort after content folders.
	const aMeta = a.name.startsWith('@');
	const bMeta = b.name.startsWith('@');
	if (aMeta !== bMeta) return aMeta ? 1 : -1;
	return a.name.localeCompare(b.name);
}

function lowerBound(nodes: WikiTreeNode[], key: NodeKey): number {
	let low = 0;
	let high = nodes.length;
	while (low < high) {
		const mid = (low + high) >>> 1;
		if (compareNodes(nodes[mid], key) < 0) low = mid + 1;
		else high = mid;
	}
	return low;
}

function insertNode(nodes: WikiTreeNode[], node: WikiTreeNode): void {
	nodes.splice(lowerBound(nodes, node), 0, node);
}

function removeNode(nodes: WikiTreeNode[], type: WikiTreeNode['type'], name: string): void {
	const at = lowerBound(nodes, { type, name });
	if (nodes[at]?.type === type && nodes[at].name === name) nodes.splice(at, 1);
}

function sortTree(nodes: WikiTreeNode[]): void {
	nodes.sort(compareNodes);
	for (const node of nodes) {
		if (node.children.length > 0) sortTree(node.children);
	}
}
