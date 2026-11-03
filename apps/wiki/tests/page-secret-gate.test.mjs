/**
 * Page writes refuse content the wiki secret scan flags with a 422 naming the line and rule, and change no byte.
 * The fixture key is built at run time with every hex digit twice, so this file passes the secrets job.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { wikiBase } from './wiki-base.mjs';

const FAKE_KEY = [...'0123456789abcdef'].map((c, i, all) => c + all[(i * 7 + 3) % 16]).join('');
const LEAK = `<pre>chrome_crashpad_handler --url=https://slack.com/apps/sentryproxy/api/1234567/minidump/?sentry_key=${FAKE_KEY} --annotation=_productName=Slack</pre>\n`;
const PAGE =
	'<!--wiki {"title":"Secret gate fixture","description":"secret gate fixture"} -->\n<h1>Secret gate fixture</h1>\n';

let BASE = '';
let folder = '';

const send = (method, route, body) =>
	fetch(`${BASE}${route}`, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const raw = (p) => fetch(`${BASE}/raw/${p}`).then((r) => r.text());

before(async () => {
	BASE = (await wikiBase()) ?? '';
	if (!BASE) return;
	const opened = await send('POST', '/api/agent/sessions', {
		slug: `page-secret-gate-${Date.now().toString(36)}`,
		goal: 'Automated fixture workspace for the page secret gate test run.',
		apps: ['llm-wiki'],
		tags: ['test-fixture'],
	}).then((r) => r.json());
	folder = String(opened.id ?? '');
	assert.ok(folder, `fixture session must open: ${JSON.stringify(opened).slice(0, 200)}`);
	assert.equal((await send('POST', '/api/agent/page', { path: `${folder}/notes.html`, content: PAGE })).status, 201);
});

after(async () => {
	if (!BASE || !folder) return;
	await send('POST', `/api/agent/sessions/${folder}/close`, {
		outcome: 'automated page secret gate fixtures',
		no_durable_knowledge: true,
	}).catch(() => {});
});

async function assertRefused(res) {
	assert.equal(res.status, 422, await res.clone().text());
	const body = await res.json();
	assert.match(body.error, /secret scan: .*line 3 \S+.*node scripts\/redact\.mjs/, body.error);
	assert.deepEqual(
		body.findings.map((f) => f.line),
		[3],
	);
	assert.ok(!JSON.stringify(body).includes(FAKE_KEY), 'the refusal never prints the key');
	assert.equal(await raw(`${folder}/notes.html`), PAGE, 'a refused write changes no byte');
}

test('a POST whose content the secret scan flags answers 422 with the line and rule', async (t) => {
	if (!BASE) return t.skip('llm-wiki dev server unreachable, SKIPPED, not passed');
	await assertRefused(await send('POST', '/api/agent/page', { path: `${folder}/notes.html`, content: PAGE + LEAK }));
});

test('a PATCH that adds a flagged line answers 422 with the line and rule', async (t) => {
	if (!BASE) return t.skip('llm-wiki dev server unreachable, SKIPPED, not passed');
	const edits = [{ old_string: '</h1>\n', new_string: `</h1>\n${LEAK}` }];
	await assertRefused(await send('PATCH', '/api/agent/page', { path: `${folder}/notes.html`, edits }));
});
