/**
 * A page can be deleted and restored as it was, and moved to a new path that the old path redirects to, with a move back that undoes it
 * (wiki-write.ts deletePage, restorePage, movePage). A move rebases the page's own relative links and repoints the links of other pages. The calls run in a child node over a content root the test builds, like
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
		const relinkLog = (r.relinked ?? []).map((p) => ({ path: p, author: listRevisions(p)[0]?.author, summary: listRevisions(p)[0]?.summary }));
		out.push({ ok: true, ...r, revisions: listRevisions(input.rawPath).length, relinkLog });
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

const HUB = page('Hub', '<p><a href="hub/child.html">Child</a>, <a href="sibling.html#top">Sibling</a>, <a href="old.html">Old</a>, <a href="#here">here</a>, <a href="/page/x.html">x</a>.</p><img src="pic.png">');

test('a page moved one folder down keeps every relative link on the page it opened, and a link to a moved page names its new path', (t) => {
	const files = {
		'index.html': page('Home', ''),
		'ops/hub.html': HUB,
		'ops/hub/child.html': page('Child', ''),
		'ops/sibling.html': page('Sibling', ''),
		'ops/old.html': `<!--wiki ${JSON.stringify({ title: 'Old', moved_to: 'ops/new/index.html' })}-->\n<h1>Old</h1>\n`,
		'ops/new/index.html': page('Old', ''),
	};
	const { answers, file } = run(t, files, [['movePage', { rawPath: 'ops/hub.html', to: 'ops/hub/index.html' }]]);
	assert.equal(answers[0].ok, true, answers[0].message);
	const moved = file('ops/hub/index.html');
	for (const href of ['href="child.html"', 'href="../sibling.html#top"', 'href="../new/index.html"', 'href="#here"', 'href="/page/x.html"', 'src="../pic.png"'])
		assert.ok(moved.includes(href), `${href} missing from ${moved}`);
});

test('a page that linked the old path links the new one after the move, in a revision by the moving author', (t) => {
	const files = {
		'index.html': page('Home', '<p><a href="ops/hub.html">Hub</a></p>'),
		'ops/hub.html': page('Hub', ''),
		'ops/other.html': page('Other', '<p><a href="hub.html#part">Hub part</a>, <a href="other.html">self</a></p>'),
	};
	const { answers, file } = run(t, files, [['movePage', { rawPath: 'ops/hub.html', to: 'ops/hub/index.html', author: 'mover' }]]);
	assert.equal(answers[0].ok, true, answers[0].message);
	assert.ok(file('index.html').includes('href="ops/hub/index.html"'));
	assert.ok(file('ops/other.html').includes('href="hub/index.html#part"'));
	assert.ok(file('ops/other.html').includes('href="other.html"'));
	assert.deepEqual(answers[0].relinked.sort(), ['index.html', 'ops/other.html']);
	for (const entry of answers[0].relinkLog) {
		assert.equal(entry.author, 'mover');
		assert.equal(entry.summary, 'link to ops/hub.html now names ops/hub/index.html, where it moved');
	}
});
