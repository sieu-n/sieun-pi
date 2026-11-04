/**
 * A page write whose content equals the stored page logs no revision and answers the current version with
 * changed: false. On 2026-11-04 golden-and-release v71 and v72 had one content hash and 0/0 lines changed. The writes
 * run in a child node over a content root the test builds, like hub-row-warning.test.mjs.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ENGINE = fileURLToPath(new URL('../src/lib/server', import.meta.url));

// wiki-write.ts has a parameter property that node's type stripping refuses, so the child loads the engine through tsx.
const TSX = import.meta.resolve('tsx');
const WRITES = `
const [engine, rawPath, ...contents] = process.argv.slice(1);
const { commitPage } = await import(engine + '/wiki-write.ts');
const { listRevisions } = await import(engine + '/wiki-store.ts');
const answers = [];
for (const content of contents) {
	const r = await commitPage({ rawPath, content, author: 'identical-write test' });
	answers.push({ version: r.version, changed: r.changed, linesAdded: r.linesAdded, linesRemoved: r.linesRemoved, diff: r.diff });
}
process.stdout.write(JSON.stringify({ answers, revisions: listRevisions(rawPath).length }));
process.exit(0);
`;

const page = (title, body) =>
	`<!--wiki ${JSON.stringify({ title, description: `${title} fixture`, last_verified: '2026-11-04T12:00Z' })}-->\n<h1>${title}</h1>\n${body}\n`;

function writeAll(t, rel, contents) {
	const root = mkdtempSync(path.join(tmpdir(), 'identical-write-'));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	mkdirSync(path.join(root, 'content'), { recursive: true });
	writeFileSync(path.join(root, 'content', 'index.html'), page('Home', `<a href="${rel}">Page</a>`));
	const run = spawnSync(process.execPath, ['--import', TSX, '--input-type=module', '-e', WRITES, ENGINE, rel, ...contents], {
		cwd: root,
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

test('writing the stored content again answers changed: false with the same version and logs no revision', (t) => {
	const html = page('Same page', '<p>The page has one line.</p>');
	const { answers, revisions } = writeAll(t, 'notes/same-page.html', [html, html]);
	assert.equal(answers[0].changed, true);
	assert.deepEqual(answers[1], { version: answers[0].version, changed: false, linesAdded: 0, linesRemoved: 0, diff: '' });
	assert.equal(revisions, 1, 'only the first write logs a revision');
});

test('a write that changes the page still logs a new version', (t) => {
	const first = page('Changed page', '<p>The page has one line.</p>');
	const second = page('Changed page', '<p>The page has two lines.</p>');
	const { answers, revisions } = writeAll(t, 'notes/changed-page.html', [first, second]);
	assert.deepEqual(
		answers.map((a) => a.changed),
		[true, true],
	);
	assert.equal(answers[1].version, answers[0].version + 1);
	assert.equal(revisions, 2);
});
