/**
 * A page API create of a curated page that no ancestor hub lists answers with a warning that names the hub and the
 * row to add. On 2026-11-04 a split wrote 9 child pages beside their parents with no word, and the 02:10Z wiki dream
 * run read 9 hub orphans. The write runs in a child node over a content root the test builds.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ENGINE = fileURLToPath(new URL('../src/lib/server', import.meta.url));
// The engine runs from apps/wiki, as the service does, and finds its write checks worker there.
const WIKI_DIR = fileURLToPath(new URL('..', import.meta.url));

// wiki-write.ts has a parameter property that node's type stripping refuses, so the child loads the engine through tsx.
const TSX = import.meta.resolve('tsx');
const WRITE = `
const [engine, rawPath, content] = process.argv.slice(1);
const { commitPage } = await import(engine + '/wiki-write.ts');
const result = await commitPage({ rawPath, content, author: 'hub-row-warning test' });
process.stdout.write(JSON.stringify(result.warnings ?? []));
process.exit(0);
`;

const page = (title, body = '', meta = {}) =>
	`<!--wiki ${JSON.stringify({ title, description: `${title} fixture`, last_verified: '2026-11-04T02:00Z', ...meta })}-->\n<h1>${title}</h1>\n${body}\n`;

function contentRoot(t) {
	const root = mkdtempSync(path.join(tmpdir(), 'hub-row-warning-'));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const put = (rel, html) => {
		mkdirSync(path.dirname(path.join(root, 'content', rel)), { recursive: true });
		writeFileSync(path.join(root, 'content', rel), html);
	};
	put('index.html', page('Home', '<a href="apps/index.html">Apps</a>'));
	put('apps/index.html', page('Apps', '<a href="infra/index.html">Infra</a>'));
	put('apps/infra/index.html', page('Infra', '<a href="grafana-boards.html">Grafana boards</a>\n<wiki-children path="listed"></wiki-children>'));
	put('apps/infra/grafana-boards.html', page('Grafana boards', '<a href="grafana-boards-panels.html">Panels</a>'));
	return { root, put };
}

function create(root, rel, html) {
	const run = spawnSync(process.execPath, ['--import', TSX, '--input-type=module', '-e', WRITE, ENGINE, rel, html], {
		cwd: WIKI_DIR,
		encoding: 'utf8',
		env: {
			...process.env,
			WIKI_CONFIG: path.join(root, 'no-config.json'),
			WIKI_CONTENT_ROOT: path.join(root, 'content'),
			WIKI_MIRROR_ROOT: root,
			WIKI_AGENTS_ROOT: path.join(root, '.no-mounts'),
		},
	});
	assert.equal(run.status, 0, run.stderr);
	return JSON.parse(run.stdout);
}

const hubWarnings = (warnings) => warnings.filter((w) => w.includes('hub orphan'));

test('creating a curated child page that only its parent page links warns and names the hub row to add', (t) => {
	const { root } = contentRoot(t);
	const warnings = hubWarnings(create(root, 'apps/infra/grafana-boards-panels.html', page('Panels')));
	assert.equal(warnings.length, 1, JSON.stringify(warnings));
	assert.match(warnings[0], /apps\/infra\/index\.html/);
	assert.match(warnings[0], /href="grafana-boards-panels\.html"/);
});

test('creating a curated page an ancestor hub links or a <wiki-children> tag covers gives no hub warning', (t) => {
	const { root, put } = contentRoot(t);
	put('apps/infra/index.html', page('Infra', '<a href="new-page.html">New</a>\n<wiki-children path="listed"></wiki-children>'));
	assert.deepEqual(hubWarnings(create(root, 'apps/infra/new-page.html', page('New'))), []);
	assert.deepEqual(hubWarnings(create(root, 'apps/infra/listed/child.html', page('Child'))), []);
});

test('a retired page and a markdown page get no hub warning', (t) => {
	const { root } = contentRoot(t);
	assert.deepEqual(hubWarnings(create(root, 'apps/infra/old.html', page('Old', '', { status: 'archived' }))), []);
	assert.deepEqual(hubWarnings(create(root, 'apps/infra/index-notes.md', '# Notes\n')), []);
});
