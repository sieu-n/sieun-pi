/**
 * The page tree gives a moved page's redirect stub no row (wiki-tree.ts listed), both when it builds the tree and when it
 * replays the tree log after a move, because the page the stub points to has its own row.
 */
import './no-wiki-config.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const appRoot = fileURLToPath(new URL('..', import.meta.url));

async function loadTree() {
	const vite = await createServer({
		appType: 'custom',
		configFile: false,
		logLevel: 'silent',
		root: appRoot,
		server: { middlewareMode: true, watch: null },
		optimizeDeps: { noDiscovery: true },
		resolve: { alias: { $lib: `${appRoot}src/lib` } },
		plugins: [
			{
				name: 'app-paths',
				resolveId: (id) => (id === '$app/paths' ? '\0app-paths' : undefined),
				load: (id) => (id === '\0app-paths' ? "export const base = '/wiki';" : undefined),
			},
		],
	});
	return { vite, tree: await vite.ssrLoadModule('/src/lib/server/wiki-tree.ts') };
}

const page = (path, meta = {}) => ({ path, title: path, kind: 'html', meta });
const stub = (path, to) => page(path, { moved_to: to, superseded_by: to });
const byPathOf = (pages) => new Map(pages.map((p) => [p.path, p]));

function rows(nodes, out = []) {
	for (const node of nodes) {
		if (node.type === 'file') out.push(node.path);
		if (node.pagePath) out.push(node.pagePath);
		rows(node.children, out);
	}
	return out.sort();
}

test('a redirect stub gets no row when the tree is built', async (t) => {
	const { vite, tree } = await loadTree();
	t.after(() => vite.close());
	const byPath = byPathOf([
		page('d/live.html'),
		stub('d/old.html', 'archive/d/old.html'),
		page('archive/d/old.html'),
		stub('gone/index.html', 'archive/gone/index.html'),
	]);
	const state = tree.syncTree(null, byPath, { epoch: 1, paths: [] });
	assert.deepEqual(rows(state.root.children), ['archive/d/old.html', 'd/live.html']);
	assert.equal(state.folders.has('gone'), false, 'a folder that holds only a stub is not shown');
	assert.equal(state.sections.get('d'), 1);
});

test('a page that turns into a redirect stub loses its row when the log replays', async (t) => {
	const { vite, tree } = await loadTree();
	t.after(() => vite.close());
	const before = byPathOf([page('d/live.html'), page('d/old.html'), page('e/index.html')]);
	const state = tree.syncTree(null, before, { epoch: 1, paths: [] });
	assert.deepEqual(rows(state.root.children), ['d/live.html', 'd/old.html', 'e/index.html']);

	const after = byPathOf([
		page('d/live.html'),
		stub('d/old.html', 'archive/d/old.html'),
		page('archive/d/old.html'),
		stub('e/index.html', 'archive/e/index.html'),
		page('archive/e/index.html'),
	]);
	const log = { epoch: 1, paths: ['d/old.html', 'archive/d/old.html', 'e/index.html', 'archive/e/index.html'] };
	tree.syncTree(state, after, log);
	assert.deepEqual(rows(state.root.children), ['archive/d/old.html', 'archive/e/index.html', 'd/live.html']);
	assert.equal(state.folders.has('e'), false);
	assert.equal(state.sections.get('d'), 1);
});
