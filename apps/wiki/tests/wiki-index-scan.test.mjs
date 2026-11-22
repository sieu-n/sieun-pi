import './no-wiki-config.mjs';
import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const appRoot = fileURLToPath(new URL('..', import.meta.url));
const contentRoot = path.join(appRoot, 'content');
const repoRoot = path.resolve(appRoot, '../..');
const updated = new Date('2026-09-23T00:00:00Z');
const scannedModule = /\/src\/lib\/server\/(wiki|wiki-mirror|session-artifact-index)\.ts$/;

function fsError(code) {
	return Object.assign(new Error(code), { code });
}

/** wiki.ts watches content/ recursively on macOS and Windows, and folder by folder on Linux. */
async function onPlatform(platform, run) {
	const original = Object.getOwnPropertyDescriptor(process, 'platform');
	Object.defineProperty(process, 'platform', { ...original, value: platform });
	try {
		return await run();
	} finally {
		Object.defineProperty(process, 'platform', original);
	}
}

async function withIndex(
	files,
	run,
	{ statErrors = {}, openErrors = {}, directoryErrors = {}, heldDirectories = {} } = {},
) {
	const originalCwd = process.cwd();
	const watchers = [];
	const opened = [];
	const key = `wikiScanFs${crypto.randomUUID().replaceAll('-', '')}`;
	const contents = new Map(Object.entries(files).map(([name, content]) => [path.resolve(contentRoot, name), content]));
	// Errors keyed by full path, so a lookup costs one Map read and no path.relative per call.
	const errorsAt = (errors) =>
		new Map(Object.entries(errors).map(([name, code]) => [path.resolve(contentRoot, name), code]));
	const statErrorAt = errorsAt(statErrors);
	const openErrorAt = errorsAt(openErrors);
	const directoryErrorAt = errorsAt(directoryErrors);
	const heldAt = errorsAt(heldDirectories);
	const directories = new Map();
	const inodes = new Map();
	const visited = [];
	let active = 0;
	let peak = 0;
	let vite;
	function addEntries(fullPath) {
		let current = fullPath;
		while (current.startsWith(repoRoot + path.sep)) {
			const parent = path.dirname(current);
			const entries = directories.get(parent) ?? new Map();
			entries.set(path.basename(current), directories.has(current) ? 'directory' : 'file');
			directories.set(parent, entries);
			current = parent;
		}
	}
	/**
	 * Report a new path the way fs.watch does. A recursive watch gives the path relative to content/. A folder
	 * watch reports the first new name under it, as inotify reports the top folder of a `mkdir -p`.
	 */
	function notify(fullPath) {
		const folderWatch = watchers
			.filter(({ dir, recursive }) => !recursive && fullPath.startsWith(dir + path.sep))
			.sort((a, b) => b.dir.length - a.dir.length)[0];
		for (const { dir, recursive, listener } of watchers) {
			if (recursive) listener('rename', path.relative(contentRoot, fullPath));
			else if (dir === folderWatch?.dir) listener('rename', path.relative(dir, fullPath).split(path.sep)[0]);
		}
	}
	/** A copied tree reports only its top folder, the way fs.watch reported a repo tree copied into a session folder. */
	function copyTree(folder, tree) {
		for (const [name, content] of Object.entries(tree)) {
			const fullPath = path.resolve(contentRoot, folder, name);
			contents.set(fullPath, content);
			addEntries(fullPath);
		}
		notify(path.resolve(contentRoot, folder));
	}
	function write(name, content) {
		const fullPath = path.resolve(contentRoot, name);
		contents.set(fullPath, content);
		addEntries(fullPath);
		notify(fullPath);
	}
	/** Land a page the way wiki-write.ts writePageFile lands a curated page: a `.write` temp file renamed over it. */
	function writeThroughTemp(name, content) {
		notify(path.resolve(contentRoot, `${name}.4242.k3x9.write`));
		write(name, content);
	}
	for (const fullPath of contents.keys()) addEntries(fullPath);
	globalThis[key] = {
		async readdir(dir) {
			visited.push(dir);
			await heldAt.get(dir);
			const error = directoryErrorAt.get(dir);
			if (error) throw fsError(error);
			return [...(directories.get(dir) ?? [])].map(([name, kind]) => ({
				name,
				isDirectory: () => kind === 'directory',
				isFile: () => kind === 'file',
				isSymbolicLink: () => false,
			}));
		},
		async stat(fullPath) {
			const error = statErrorAt.get(fullPath);
			if (error) throw fsError(error);
			const directory = directories.has(fullPath);
			if (!contents.has(fullPath) && !directory) throw fsError('ENOENT');
			return {
				dev: 1,
				ino: inodes.get(fullPath) ?? inodes.set(fullPath, inodes.size + 1).size,
				nlink: directory ? 2 : 1,
				mtimeMs: updated.getTime(),
				ctimeMs: updated.getTime(),
				mtime: updated,
				size: directory ? 0 : Buffer.byteLength(contents.get(fullPath)),
				isFile: () => !directory,
				isDirectory: () => directory,
				isSymbolicLink: () => false,
			};
		},
		async realpath(fullPath) {
			if (!contents.has(fullPath) && !directories.has(fullPath)) throw fsError('ENOENT');
			return fullPath;
		},
		watch(dir, options, listener) {
			const watcher = { dir, recursive: Boolean(options?.recursive), listener };
			watchers.push(watcher);
			return {
				close() {
					watchers.splice(watchers.indexOf(watcher), 1);
				},
				on() {
					return this;
				},
			};
		},
		async open(fullPath) {
			opened.push(fullPath);
			const error = openErrorAt.get(fullPath);
			if (error) throw fsError(error);
			active++;
			peak = Math.max(peak, active);
			await new Promise((resolve) => setImmediate(resolve));
			return {
				async stat() {
					return globalThis[key].stat(fullPath);
				},
				async read(buffer, offset, length, position) {
					const bytesRead = Buffer.from(contents.get(fullPath)).copy(buffer, offset, position, position + length);
					return { bytesRead };
				},
				async close() {
					active--;
				},
			};
		},
		async readFile(fullPath) {
			return contents.get(fullPath);
		},
	};
	try {
		process.chdir(appRoot);
		vite = await createServer({
			appType: 'custom',
			configFile: false,
			logLevel: 'silent',
			root: appRoot,
			server: { middlewareMode: true, watch: null },
			optimizeDeps: { noDiscovery: true },
			plugins: [
				{
					name: 'wiki-scan-filesystem',
					enforce: 'pre',
					transform(code, id) {
						if (scannedModule.test(id))
							return code
								.replaceAll("'node:fs/promises'", "'virtual:wiki-scan-filesystem'")
								.replaceAll("'node:fs'", "'virtual:wiki-scan-watch'");
					},
					resolveId(id) {
						if (id === 'virtual:wiki-scan-filesystem' || id === 'virtual:wiki-scan-watch') return `\0${id}`;
					},
					load(id) {
						if (id === '\0virtual:wiki-scan-filesystem')
							return `export const { readdir, stat, open, readFile, realpath } = globalThis[${JSON.stringify(key)}]; export const lstat = stat;`;
						if (id === '\0virtual:wiki-scan-watch')
							return `export const { watch } = globalThis[${JSON.stringify(key)}]; export { constants } from 'node:fs';`;
					},
				},
			],
		});
		const wiki = await vite.ssrLoadModule('/src/lib/server/wiki.ts');
		const load = (id) => vite.ssrLoadModule(id);
		await run(wiki, { visited, opened, watchers, peak: () => peak, active: () => active, write, writeThroughTemp, copyTree, load });
	} finally {
		await vite?.close();
		delete globalThis[key];
		process.chdir(originalCwd);
	}
}

/** Session artifacts are listed in the background after the first index, so wait for one to arrive. */
async function indexWith(wiki, wikiPath) {
	for (;;) {
		const index = await wiki.getWikiIndex();
		if (index.byPath.has(wikiPath)) return index;
		await new Promise((resolve) => setImmediate(resolve));
	}
}

for (const stage of ['stat', 'open', 'directory']) {
	test(`index propagates ${stage} errors other than ENOENT`, async () => {
		const options = {
			statErrors: stage === 'stat' ? { 'page.md': 'EACCES' } : {},
			openErrors: stage === 'open' ? { 'page.md': 'EIO' } : {},
			directoryErrors: stage === 'directory' ? { '': 'EACCES' } : {},
		};
		await withIndex(
			{ 'page.md': '# Page' },
			async (wiki) => {
				await assert.rejects(wiki.getWikiIndex(), { code: stage === 'open' ? 'EIO' : 'EACCES' });
			},
			options,
		);
	});
}

// On 11-22 a Cmd K search in sw factory for a job page's exact title, "Ideal Slack replies in sw factory rooms", found nothing,
// because the index named the artifact "Ideal Replies" after its file name.
test('an HTML session artifact is indexed under the title and description its head names, a markdown one by its path', async () => {
	const session = 'sessions/2026/11/20/1139-slack-style-replies';
	await withIndex(
		{
			[`${session}/index.html`]: '<h1>slack style replies</h1>',
			[`${session}/ideal-replies.html`]:
				'<!--wiki\n{ "title": "Ideal Slack replies in sw factory rooms", "summary": "Seventeen pairs." }\n-->\n<h1>Other</h1>',
			[`${session}/plain-page.html`]: '<p>intro</p><h1>A page with only an h1</h1>',
			[`${session}/notes.md`]: '# Notes heading',
		},
		async (wiki) => {
			const index = await indexWith(wiki, `${session}/notes.md`);
			const ideal = index.byPath.get(`${session}/ideal-replies.html`);
			assert.equal(ideal.title, 'Ideal Slack replies in sw factory rooms');
			assert.equal(ideal.meta.description, 'Seventeen pairs.');
			assert.equal(index.byPath.get(`${session}/plain-page.html`).title, 'A page with only an h1');
			assert.equal(index.byPath.get(`${session}/notes.md`).title, 'Notes');
			const hits = await wiki.searchPages('Ideal Slack replies in sw factory rooms', 3, { includeSessions: true });
			assert.equal(hits[0]?.path, `${session}/ideal-replies.html`);
		},
	);
});

// On 2026-10-18 jobs had copied repo trees into their session folders, and sessions/ held 1.1M files.
test('a repo copy in a session folder (a .git or pnpm-workspace.yaml in it) is never walked or indexed', async () => {
	const session = 'sessions/2026/10/18/1408-demo';
	await withIndex(
		{
			[`${session}/index.html`]: '<h1>Demo</h1>',
			[`${session}/report.md`]: '# Report',
			[`${session}/export-tip/pnpm-workspace.yaml`]: 'packages: []',
			[`${session}/export-tip/README.md`]: '# Repo',
			[`${session}/export-tip/docs/a.md`]: '# A',
			[`${session}/clone/.git/HEAD`]: 'ref: refs/heads/main',
			[`${session}/clone/notes.md`]: '# Notes',
		},
		async (wiki, fs) => {
			const index = await indexWith(wiki, `${session}/report.md`);
			assert.deepEqual([...index.byPath.keys()].sort(), [`${session}/index.html`, `${session}/report.md`]);
			assert.ok(!fs.visited.includes(path.join(contentRoot, session, 'export-tip/docs')));
		},
	);
	await onPlatform('darwin', () =>
		withIndex({ 'first.md': '# First' }, async (wiki, fs) => {
			await wiki.getWikiIndex();
			fs.copyTree('copied', { 'pnpm-workspace.yaml': 'packages: []', 'a.md': '# A', 'nested/b.md': '# B' });
			await wiki.getWikiIndex();
			fs.write('after.md', '# After');
			const index = await indexWith(wiki, 'after.md');
			assert.deepEqual([...index.byPath.keys()].sort(), ['after.md', 'first.md']);
		}),
	);
});

// GET /api/agent/sessions read every page's path for the ~5k logs among 100k+ pages, about 400 ms a call on 2026-11-04.
test('the index lists its session logs apart from the other pages, and a new log joins them', async () => {
	await withIndex(
		{
			'apps/hub/index.html': '<h1>Hub</h1>',
			'sessions/2026/11/03/0900-old/index.html': '<h1>Old</h1>',
			'sessions/2026/11/03/0900-old/notes/index.html': '<h1>Notes</h1>',
			'sessions/2026/11/03/0900-old/report.md': '# Report',
		},
		async (wiki, fs) => {
			const first = await indexWith(wiki, 'sessions/2026/11/03/0900-old/report.md');
			assert.deepEqual(
				first.sessionLogs.map((page) => page.path),
				['sessions/2026/11/03/0900-old/index.html'],
			);
			fs.write('sessions/2026/11/04/1000-new/index.html', '<h1>New</h1>');
			const next = await indexWith(wiki, 'sessions/2026/11/04/1000-new/index.html');
			assert.deepEqual(next.sessionLogs.map((page) => page.path).sort(), [
				'sessions/2026/11/03/0900-old/index.html',
				'sessions/2026/11/04/1000-new/index.html',
			]);
		},
	);
});

test('concurrent cold index consumers share one completion-stamped result', async () => {
	const originalDateNow = Date.now;
	let clock = 100;
	try {
		await withIndex({ 'apps/hub/index.html': '<h1>Hub</h1>' }, async (wiki) => {
			Date.now = () => clock;
			const first = wiki.getWikiIndex();
			const second = wiki.getWikiIndex();
			// The build waits on the fake open, which yields to the next macrotask, so the clock moves before it ends.
			await new Promise((resolve) => setImmediate(resolve));
			clock = 200;
			const [a, b] = await Promise.all([first, second]);
			assert.ok(a === b, 'concurrent callers must receive the same WikiIndex object');
			assert.equal(a.generatedAt, 200, 'generatedAt must use the completion clock, not the pre-build clock');
		});
	} finally {
		Date.now = originalDateNow;
	}
});

/** Move the clock past the TTL, ask for the index, and wait until the refresh it starts has re-listed the mirror. */
async function afterTtl(wiki, fs, clock) {
	clock.now += 60_000;
	const listed = fs.visited.length;
	await wiki.getWikiIndex();
	while (!fs.visited.slice(listed).some((dir) => !dir.startsWith(contentRoot))) {
		await new Promise((resolve) => setImmediate(resolve));
	}
	for (let n = 0; n < 20; n += 1) await new Promise((resolve) => setImmediate(resolve));
}

async function withClock(run) {
	const originalDateNow = Date.now;
	const clock = { now: originalDateNow() };
	Date.now = () => clock.now;
	try {
		return await run(clock);
	} finally {
		Date.now = originalDateNow;
	}
}

// On us-metal02 on 2026-10-24 the box wiki rescanned content/ on every request after the TTL, and the
// artifact walk of sessions/ ran back to back at 0.6-0.8 of a core.
test('on a Linux box the index watches each folder it walks and does not rescan content/ when nothing changed', async () => {
	const session = 'sessions/2026/10/24/0600-demo';
	await onPlatform('linux', () =>
		withClock((clock) =>
			withIndex(
				{
					'apps/hub/index.html': '<h1>Hub</h1>',
					'apps/hub/deep/guide.md': '# Guide',
					[`${session}/index.html`]: '<h1>Demo</h1>',
					[`${session}/data/notes.md`]: '# Notes',
				},
				async (wiki, fs) => {
					await indexWith(wiki, `${session}/data/notes.md`);
					const watched = fs.watchers.map(({ dir }) => path.relative(contentRoot, dir)).sort();
					for (const folder of ['', 'apps/hub/deep', 'sessions', `${session}`, `${session}/data`]) {
						assert.ok(watched.includes(folder), `${folder || 'content/'} is watched`);
					}
					assert.ok(fs.watchers.every(({ recursive }) => !recursive));
					const walked = () => fs.visited.filter((dir) => dir.startsWith(contentRoot)).length;
					const before = walked();
					await afterTtl(wiki, fs, clock);
					await afterTtl(wiki, fs, clock);
					assert.equal(walked(), before, 'no folder of content/ was listed again');

					fs.write('apps/hub/deep/new.md', '# New');
					fs.write(`${session}/index.html`, '<h1>Demo, edited</h1>');
					fs.write(`${session}/data/more/late.md`, '# Late');
					await indexWith(wiki, 'apps/hub/deep/new.md');
					const index = await indexWith(wiki, `${session}/data/more/late.md`);
					assert.equal(index.byPath.get(`${session}/index.html`).title, 'Demo, edited');
					assert.equal(walked(), before + 1, 'only the new folder was listed');
				},
			),
		),
	);
});


// On 2026-11-19 at 18:10Z wiki.publish wrote three new apps/convex pages and each verify answered 404 "Page not found",
// because the `.write` temp name in the watcher batch made the index serve its stale copy without the new page.
test('a curated page written through a temp file resolves on the next index read', async () => {
	for (const platform of ['linux', 'darwin']) {
		await onPlatform(platform, () =>
			withIndex({ 'apps/hub/index.html': '<h1>Hub</h1>' }, async (wiki, fs) => {
				await indexWith(wiki, 'apps/hub/index.html');
				fs.writeThroughTemp('apps/hub/new.html', '<h1>New</h1>');
				const index = await wiki.getWikiIndex();
				assert.ok(index.byPath.has('apps/hub/new.html'), `${platform}: the new page is in the index`);
				assert.ok(!index.byPath.has('apps/hub/new.html.4242.k3x9.write'), `${platform}: the temp file is not`);
			}),
		);
	}
});

// On 2026-11-04 about 20 jobs split pages at once, and verify answered 404 for new pages while another write's refresh ran.
test('a page written while a refresh runs resolves on the next index read', async () => {
	await onPlatform('linux', () =>
		withIndex({ 'apps/hub/index.html': '<h1>Hub</h1>' }, async (wiki, fs) => {
			await indexWith(wiki, 'apps/hub/index.html');
			fs.write('apps/hub/first.html', '<h1>First</h1>');
			const running = wiki.getWikiIndex();
			fs.write('apps/hub/second.html', '<h1>Second</h1>');
			const index = await wiki.getWikiIndex();
			await running;
			assert.ok(index.byPath.has('apps/hub/second.html'), 'the page written during the refresh is in the index');
		}),
	);
});

// On 2026-11-20 a probe's wiki.publish of experiments/verify-404-probe-1120/index.html, a page in a new folder, got 404
// from verify: the watcher reported the folder, and no read waits for a folder walk.
test('a page the page API writes into a new folder resolves on the next index read', async () => {
	await onPlatform('linux', () =>
		withIndex({ 'apps/hub/index.html': '<h1>Hub</h1>' }, async (wiki, fs) => {
			await indexWith(wiki, 'apps/hub/index.html');
			fs.write('apps/hub/new/page.html', '<h1>New</h1>');
			const missed = await wiki.getWikiIndex();
			assert.ok(!missed.byPath.has('apps/hub/new/page.html'), 'a folder event alone leaves the read without the page');
			await wiki.indexWrittenPage('apps/hub/new/page.html');
			const index = await wiki.getWikiIndex();
			assert.equal(index.byPath.get('apps/hub/new/page.html')?.title, 'New');
		}),
	);
});
