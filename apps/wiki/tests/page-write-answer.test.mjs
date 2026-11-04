/**
 * The page API answer to a write: an identical POST or PATCH keeps the version and answers changed: false, a saved
 * write names the prose-lint warnings it kept, and a lint refusal names the real lint script. On 2026-11-04
 * wiki-dream writers made 10 extra revisions in 7 days, linting after a 201 that listed no warning.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { wikiBase } from './wiki-base.mjs';

const LONG = Array.from({ length: 40 }, (_, i) => `word${i}`).join(' ');
const PAGE =
	'<!--wiki {"title":"Write answer fixture","description":"write answer fixture"} -->\n<h1>Write answer fixture</h1>\n<p>The page has one line.</p>\n';

let BASE = '';
let folder = '';

const send = (method, route, body) =>
	fetch(`${BASE}${route}`, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

before(async () => {
	BASE = (await wikiBase()) ?? '';
	if (!BASE) return;
	const opened = await send('POST', '/api/agent/sessions', {
		slug: `page-write-answer-${Date.now().toString(36)}`,
		goal: 'Automated fixture workspace for the page write answer test run.',
		apps: ['llm-wiki'],
		tags: ['test-fixture'],
	}).then((r) => r.json());
	folder = String(opened.id ?? '');
	assert.ok(folder, `fixture session must open: ${JSON.stringify(opened).slice(0, 200)}`);
});

after(async () => {
	if (!BASE || !folder) return;
	await send('POST', `/api/agent/sessions/${folder}/close`, {
		outcome: 'automated page write answer fixtures',
		no_durable_knowledge: true,
	}).catch(() => {});
});

test('an identical POST and an identical PATCH keep the version and answer changed: false', async (t) => {
	if (!BASE) return t.skip('wiki server unreachable, SKIPPED, not passed');
	const path = `${folder}/same.html`;
	const first = await send('POST', '/api/agent/page', { path, content: PAGE });
	assert.equal(first.status, 201, await first.clone().text());
	const made = await first.json();
	assert.equal(made.changed, true);
	const again = await send('POST', '/api/agent/page', { path, content: PAGE });
	assert.equal(again.status, 200, await again.clone().text());
	const same = await again.json();
	assert.equal(same.version, made.version);
	assert.equal(same.changed, false);
	// The edits run in order, so the second puts back what the first changed.
	const edits = [
		{ old_string: 'one line', new_string: 'two lines' },
		{ old_string: 'two lines', new_string: 'one line' },
	];
	const patched = await send('PATCH', '/api/agent/page', { path, edits }).then((r) => r.json());
	assert.equal(patched.version, made.version, JSON.stringify(patched));
	assert.equal(patched.changed, false);
});

test('a saved write lists the prose-lint warnings it kept', async (t) => {
	if (!BASE) return t.skip('wiki server unreachable, SKIPPED, not passed');
	const content = PAGE.replace('<p>The page has one line.</p>', `<p>The page has one line. It then goes on with ${LONG} at the end.</p>`);
	const res = await send('POST', '/api/agent/page', { path: `${folder}/warned.html`, content });
	assert.equal(res.status, 201, await res.clone().text());
	const body = await res.json();
	assert.deepEqual(
		body.lint.map((f) => f.rule),
		['long-sentence'],
	);
	assert.ok(body.warnings.some((w) => w.startsWith('prose lint: the page is saved with 1 finding')), JSON.stringify(body.warnings));
});

test('a write the prose lint refuses names apps/wiki/scripts/prose-lint.mjs', async (t) => {
	if (!BASE) return t.skip('wiki server unreachable, SKIPPED, not passed');
	const content = PAGE.replace('one line.', 'one line \u2014 and a dash.');
	const res = await send('POST', '/api/agent/page', { path: `${folder}/refused.html`, content });
	assert.equal(res.status, 422, await res.clone().text());
	const body = await res.json();
	assert.match(body.error, /node apps\/wiki\/scripts\/prose-lint\.mjs <file>/, body.error);
});
