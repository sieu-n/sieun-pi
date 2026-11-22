/**
 * A page can be deleted and restored as it was, and moved to a new path that the old path redirects to, with a move back that undoes it
 * (wiki-write.ts deletePage, restorePage, movePage). The calls run in a child node over a content root the test builds, like
 * identical-write.test.mjs.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ENGINE = fileURLToPath(new URL('../src/lib/server', import.meta.url));
const TSX = import.meta.resolve('tsx');
const CALLS = `
const [engine, script] = process.argv.slice(1);
const write = await import(engine + '/wiki-write.ts');
const { listRevisions } = await import(engine + '/wiki-store.ts');
const out = [];
for (const [verb, input] of JSON.parse(script)) {
	try {
		const r = await write[verb](input);
		out.push({ ok: true, ...r, revisions: listRevisions(input.rawPath).length });
	} catch (error) {
		out.push({ ok: false, status: error.status, message: error.message });
	}
}
process.stdout.write(JSON.stringify(out));
process.exit(0);
`;

const page = (title, body) => `<!--wiki ${JSON.stringify({ title, description: `${title} fixture` })}-->\n<h1>${title}</h1>\n${body}\n`;

function run(t, files, calls) {
	const root = mkdtempSync(path.join(tmpdir(), 'move-delete-'));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const content = path.join(root, 'content');
	mkdirSync(content, { recursive: true });
	for (const [rel, text] of Object.entries(files)) {
		mkdirSync(path.dirname(path.join(content, rel)), { recursive: true });
		writeFileSync(path.join(content, rel), text);
	}
	const child = spawnSync(process.execPath, ['--import', TSX, '--input-type=module', '-e', CALLS, ENGINE, JSON.stringify(calls)], {
		cwd: root,
		encoding: 'utf8',
		env: { ...process.env, WIKI_CONFIG: path.join(root, 'no-config.json'), WIKI_CONTENT_ROOT: content, WIKI_MIRROR_ROOT: root, WIKI_AGENTS_ROOT: path.join(root, '.no-mounts') },
	});
	assert.equal(child.status, 0, child.stderr);
	return { answers: JSON.parse(child.stdout), file: (rel) => (existsSync(path.join(content, rel)) ? readFileSync(path.join(content, rel), 'utf8') : null) };
}

const NOTES = page('Notes', '<p>The notes page.</p>');

test('a deleted page leaves its path, a restore brings back the same bytes, and a second restore finds nothing', (t) => {
	const { answers, file } = run(t, { 'index.html': page('Home', ''), 'notes/a.html': NOTES }, [
		['deletePage', { rawPath: 'notes/a.html', author: 'test' }],
		['deletePage', { rawPath: 'notes/a.html', author: 'test' }],
		['restorePage', { rawPath: 'notes/a.html', author: 'test' }],
		['restorePage', { rawPath: 'notes/a.html', author: 'test' }],
	]);
	assert.equal(answers[0].ok, true);
	assert.equal(answers[0].deleted, true);
	assert.equal(answers[1].status, 404);
	assert.equal(answers[2].restored, true);
	assert.equal(answers[2].revisions, 2, 'the delete and the restore each log a revision');
	assert.equal(answers[3].status, 404);
	assert.equal(file('notes/a.html'), NOTES);
});

test('a delete with a stale base version is refused, and the home page cannot be deleted', (t) => {
	const { answers, file } = run(t, { 'index.html': page('Home', ''), 'notes/a.html': NOTES }, [
		['deletePage', { rawPath: 'notes/a.html', baseVersion: 7 }],
		['deletePage', { rawPath: 'index.html' }],
	]);
	assert.equal(answers[0].status, 409);
	assert.equal(answers[1].status, 403);
	assert.equal(file('notes/a.html'), NOTES);
});

test('a move puts the page at the new path and leaves a redirect, and a move back undoes it with no redirect left', (t) => {
	const { answers, file } = run(t, { 'index.html': page('Home', ''), 'notes/a.html': NOTES, 'notes/taken.html': page('Taken', '<p>x</p>') }, [
		['movePage', { rawPath: 'notes/a.html', to: 'notes/taken.html' }],
		['movePage', { rawPath: 'notes/a.html', to: 'plans/b.html' }],
		['movePage', { rawPath: 'notes/a.html', to: 'plans/c.html' }],
		['movePage', { rawPath: 'plans/b.html', to: 'notes/a.html' }],
	]);
	assert.equal(answers[0].status, 409, 'a move onto another page is refused');
	assert.equal(answers[1].ok, true);
	assert.equal(answers[2].status, 400, 'a redirect page does not move');
	assert.equal(answers[3].ok, true);
	assert.equal(file('notes/a.html'), NOTES);
	assert.equal(file('plans/b.html'), null);
});

test('the old path of a moved page names the new one in moved_to', (t) => {
	const { file } = run(t, { 'index.html': page('Home', ''), 'notes/a.html': NOTES }, [['movePage', { rawPath: 'notes/a.html', to: 'plans/b.html' }]]);
	assert.equal(file('plans/b.html'), NOTES);
	const meta = JSON.parse(/<!--wiki\s*([\s\S]*?)-->/.exec(file('notes/a.html'))[1]);
	assert.deepEqual(meta, { title: 'Notes', moved_to: 'plans/b.html', superseded_by: 'plans/b.html' });
});
