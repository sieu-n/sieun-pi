/**
 * GET /api/agent/lint reads each hub's links from the whole file and caches them. The cache must see a hub edit even
 * when the index snapshot still carries the hub's old `updated`. On 2026-11-04 the LinkedIn fields split linked its
 * three children from apps/crawler-v3/platforms/linkedin/index.html, and lint kept counting them as hub orphans until
 * a second write moved the hub's `updated`. The lint runs in a child node over a content root the test builds.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ENGINE = fileURLToPath(new URL('../src/lib/server', import.meta.url));
const TSX = import.meta.resolve('tsx');

// The child lints, signals the parent through a file, waits for the hub edit, then lints again in the same process.
const LINT_TWICE = `
const [engine, ready, edited] = process.argv.slice(1);
const { existsSync, writeFileSync } = await import('node:fs');
const { getLintReport } = await import(engine + '/wiki-lint.ts');
const orphans = async () => (await getLintReport()).hubOrphans.map((finding) => finding.path);
const before = await orphans();
writeFileSync(ready, '');
while (!existsSync(edited)) await new Promise((resolve) => setTimeout(resolve, 20));
const after = await orphans();
process.stdout.write(JSON.stringify({ before, after }));
process.exit(0);
`;

const page = (title, body = '') =>
	`<!--wiki ${JSON.stringify({ title, description: `${title} fixture`, updated: '2026-11-04' })}-->\n<h1>${title}</h1>\n${body}\n`;

test('a hub edit that keeps the index updated stamp clears the hub orphan on the next lint', async (t) => {
	const root = mkdtempSync(path.join(tmpdir(), 'lint-hub-cache-'));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const file = (rel) => path.join(root, 'content', rel);
	const put = (rel, html) => {
		mkdirSync(path.dirname(file(rel)), { recursive: true });
		writeFileSync(file(rel), html);
	};
	put('index.html', page('Home', '<a href="apps/index.html">Apps</a>'));
	put('apps/index.html', page('Apps', '<a href="infra/index.html">Infra</a>'));
	put('apps/infra/index.html', page('Infra', '<a href="boards.html">Boards</a>'));
	put('apps/infra/boards.html', page('Boards', '<a href="panels.html">Panels</a>'));
	put('apps/infra/panels.html', page('Panels', '<a href="boards.html">Boards</a>'));

	const ready = path.join(root, 'ready');
	const edited = path.join(root, 'edited');
	const child = spawn(process.execPath, ['--import', TSX, '--input-type=module', '-e', LINT_TWICE, ENGINE, ready, edited], {
		cwd: root,
		env: {
			...process.env,
			WIKI_CONFIG: path.join(root, 'no-config.json'),
			WIKI_CONTENT_ROOT: path.join(root, 'content'),
			WIKI_MIRROR_ROOT: root,
			WIKI_AGENTS_ROOT: path.join(root, '.no-mounts'),
		},
	});
	let stdout = '';
	let stderr = '';
	child.stdout.on('data', (chunk) => (stdout += chunk));
	child.stderr.on('data', (chunk) => (stderr += chunk));
	const exited = new Promise((resolve) => child.once('exit', resolve));

	const deadline = Date.now() + 60_000;
	while (!statSyncOrNull(ready)) {
		assert.ok(Date.now() < deadline, `child never linted: ${stderr}`);
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	// The hub row lands, and the hub keeps its old mtime, which is the `updated` stamp the index snapshot carries.
	const hub = file('apps/infra/index.html');
	const { atime, mtime } = statSync(hub);
	writeFileSync(hub, page('Infra', '<a href="boards.html">Boards</a>\n<a href="panels.html">Panels</a>'));
	utimesSync(hub, atime, mtime);
	writeFileSync(edited, '');

	assert.equal(await exited, 0, stderr);
	const { before, after } = JSON.parse(stdout);
	assert.deepEqual(before, ['apps/infra/panels.html']);
	assert.deepEqual(after, []);
});

// The child lints once and prints the findings of every rule by path.
const LINT_ONCE = `
const engine = process.argv[1];
const { getLintReport } = await import(engine + '/wiki-lint.ts');
const report = await getLintReport();
const rules = ['brokenLinks', 'orphans', 'hubOrphans', 'underLinked', 'missingDescription', 'missingSummary'];
process.stdout.write(JSON.stringify(Object.fromEntries(rules.map((rule) => [rule, report[rule].map((f) => f.path)]))));
process.exit(0);
`;

async function lintFixture(t, pages) {
	const root = mkdtempSync(path.join(tmpdir(), 'lint-rules-'));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	for (const [rel, text] of Object.entries(pages)) {
		const file = path.join(root, 'content', rel);
		mkdirSync(path.dirname(file), { recursive: true });
		writeFileSync(file, text);
	}
	const child = spawn(process.execPath, ['--import', TSX, '--input-type=module', '-e', LINT_ONCE, ENGINE], {
		cwd: root,
		env: {
			...process.env,
			WIKI_CONFIG: path.join(root, 'no-config.json'),
			WIKI_CONTENT_ROOT: path.join(root, 'content'),
			WIKI_MIRROR_ROOT: root,
			WIKI_AGENTS_ROOT: path.join(root, '.no-mounts'),
		},
	});
	let stdout = '';
	let stderr = '';
	child.stdout.on('data', (chunk) => (stdout += chunk));
	child.stderr.on('data', (chunk) => (stderr += chunk));
	assert.equal(await new Promise((resolve) => child.once('exit', resolve)), 0, stderr);
	return JSON.parse(stdout);
}

const hubs = {
	'index.html': page('Home', '<a href="apps/index.html">Apps</a>'),
	'apps/index.html': page('Apps', '<wiki-children></wiki-children><a href="infra/index.html">Infra</a>'),
	'apps/infra/index.html': page('Infra', '<wiki-children></wiki-children><a href="boards.html">Boards</a>'),
	'apps/infra/boards.html': page('Boards', '<a href="index.html">Infra</a>'),
};

test('a moved page redirect stub counts in no page rule', async (t) => {
	const stub = `<!--wiki ${JSON.stringify({ title: 'Panels', moved_to: 'apps/infra/boards.html', superseded_by: 'apps/infra/boards.html' })}-->\n<h1>Panels</h1>\n<p>This page moved to <a href="/page/apps/infra/boards.html">Boards</a>.</p>\n`;
	const found = await lintFixture(t, { ...hubs, 'apps/infra/panels.html': stub });
	for (const [rule, paths] of Object.entries(found)) assert.ok(!paths.includes('apps/infra/panels.html'), `${rule} counts the stub`);
});

test('a data file wiki-link-like text is no broken link', async (t) => {
	const data = '{"contact_points": [["email", "-", "61", "61"]]}\n';
	const found = await lintFixture(t, { ...hubs, 'apps/infra/data/gaps.json': data });
	assert.deepEqual(found.brokenLinks, []);
});

function statSyncOrNull(file) {
	try {
		return statSync(file);
	} catch {
		return null;
	}
}
