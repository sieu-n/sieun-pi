/**
 * The verify gate's L2 check counts an ancestor hub's <wiki-children> row as a way in. Before 2026-11-20 only links
 * counted, so the desired-outcome pages a self-building hub table listed failed L2 with inbound 0. A retired page
 * needs no way in, because the page API refuses a current hub's new link to it.
 * The check runs in a child node over a content root the test builds, as hub-row-warning.test.mjs does.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ENGINE = fileURLToPath(new URL('../src/lib/server', import.meta.url));
const WIKI_DIR = fileURLToPath(new URL('..', import.meta.url));
const TSX = import.meta.resolve('tsx');
const CHECK = `
const [engine, ...paths] = process.argv.slice(1);
const { readPage } = await import(engine + '/wiki.ts');
const { linkCheck } = await import(engine + '/wiki-lint.ts');
const out = {};
for (const rel of paths) out[rel] = await linkCheck(await readPage(rel));
process.stdout.write(JSON.stringify(out));
process.exit(0);
`;

const page = (title, body = '', meta = {}) =>
	`<!--wiki ${JSON.stringify({ title, kind: 'reference', date: '2026-11-20', ...meta })}-->\n<h1>${title}</h1>\n${body}\n`;

function check(t, files, paths) {
	const root = mkdtempSync(path.join(tmpdir(), 'verify-links-'));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	for (const [rel, html] of Object.entries(files)) {
		mkdirSync(path.dirname(path.join(root, 'content', rel)), { recursive: true });
		writeFileSync(path.join(root, 'content', rel), html);
	}
	const run = spawnSync(process.execPath, ['--import', TSX, '--input-type=module', '-e', CHECK, ENGINE, ...paths], {
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

test('a page only a <wiki-children> hub lists or a retired page passes L2, and a current page nothing lists fails it', (t) => {
	const got = check(
		t,
		{
			'index.html': page('Home', '<a href="projects/index.html">Projects</a>'),
			'projects/index.html': page('Projects', '<a href="email/index.html">Email</a>'),
			'projects/email/index.html': page('Email', '<wiki-children exclude="hidden.html"></wiki-children>'),
			'projects/email/rubric.html': page('Rubric'),
			'projects/email/hidden.html': page('Hidden'),
			'projects/email/old.html': page('Old', '', { status: 'archived' }),
		},
		['projects/email/rubric.html', 'projects/email/hidden.html', 'projects/email/index.html', 'projects/email/old.html'],
	);
	assert.deepEqual(got['projects/email/rubric.html'], { ok: true, broken: [], inbound: 0, hubListed: true, retired: false });
	assert.equal(got['projects/email/hidden.html'].ok, false);
	assert.deepEqual(got['projects/email/index.html'], { ok: true, broken: [], inbound: 1, hubListed: false, retired: false });
	assert.deepEqual(got['projects/email/old.html'], { ok: true, broken: [], inbound: 0, hubListed: false, retired: true });
});
