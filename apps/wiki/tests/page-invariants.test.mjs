/**
 * Page writes refuse a meta title apart from the first <h1> (422) and a retired page that a current hub links (409).
 * The target is a real curated page whose bytes the after hook restores; tests/wiki-base.mjs picks the server.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { wikiBase } from './wiki-base.mjs';

// The engine spec: a current curated page that the home page links by hand. RETIRED is a superseded page. The three are
// the only content/ pages in test:content's turbo inputs (apps/llm-wiki/turbo.json), so a change to any of them reruns this.
const PAGE = 'apps/llm-wiki/index.html';
const HUB = 'index.html';
const RETIRED = 'apps/crawler-v2/index.html';

let BASE = '';
let original = null;

const send = (method, route, body) =>
	fetch(`${BASE}${route}`, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const raw = (p) => fetch(`${BASE}/raw/${p}`).then((r) => r.text());
const patch = (edits) => send('PATCH', '/api/agent/page', { path: PAGE, edits, author: 'page-invariants test' });

before(async () => {
	BASE = (await wikiBase()) ?? '';
	if (BASE) original = await raw(PAGE);
});

after(async () => {
	if (!BASE || original === null) return;
	if ((await raw(PAGE)) === original) return;
	await send('POST', '/api/agent/page', { path: PAGE, content: original, author: 'page-invariants test restore' });
});

const metaTitle = (html) => /"title"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(html)?.[1];
const firstH1 = (html) => /<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(html)?.[1];
const metaStatus = (html) => /"status"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(html);

test('a write that changes the meta title and not the first <h1> is refused', async (t) => {
	if (!BASE) return t.skip('llm-wiki dev server unreachable, SKIPPED, not passed');
	const title = metaTitle(original);
	assert.ok(title, `${PAGE} needs a meta title`);
	const res = await patch([{ old_string: `"title":"${title}"`, new_string: `"title":"${title} (test output)"` }]);
	assert.equal(res.status, 422, await res.clone().text());
	const { error } = await res.json();
	assert.match(error, /first <h1>/, error);
	assert.equal(await raw(PAGE), original, 'a refused write changes no byte');
});

test('a write that changes the first <h1> and not the meta title is refused', async (t) => {
	if (!BASE) return t.skip('llm-wiki dev server unreachable, SKIPPED, not passed');
	const h1 = firstH1(original);
	const res = await patch([{ old_string: `<h1>${h1}</h1>`, new_string: `<h1>${h1} (test output)</h1>` }]);
	assert.equal(res.status, 422, await res.clone().text());
	assert.equal(await raw(PAGE), original, 'a refused write changes no byte');
});

for (const status of ['archived', 'retired', 'superseded']) {
	test(`status "${status}" is refused while a current hub links the page, and the error names the hub`, async (t) => {
		if (!BASE) return t.skip('llm-wiki dev server unreachable, SKIPPED, not passed');
		const current = metaStatus(original);
		assert.ok(current, `${PAGE} needs a meta status`);
		const res = await patch([{ old_string: current[0], new_string: `"status":"${status}"` }]);
		assert.equal(res.status, 409, await res.clone().text());
		const { error } = await res.json();
		assert.ok(error.includes(HUB), `the error must name the linking hub: ${error}`);
		assert.ok(error.includes('/api/agent/supersede'), `the error must name the supersede route: ${error}`);
		assert.equal(await raw(PAGE), original, 'a refused write changes no byte');
	});
}

test('a write that makes a current hub link a retired page is refused, and the error names the page', async (t) => {
	if (!BASE) return t.skip('llm-wiki dev server unreachable, SKIPPED, not passed');
	const retired = RETIRED;
	assert.equal(metaStatus(await raw(retired))?.[1], 'superseded', `${retired} must stay superseded, or name another superseded page here and in apps/llm-wiki/turbo.json`);
	const h1 = `<h1>${firstH1(original)}</h1>`;
	const link = `${h1}\n<p>The <a href="/page/${retired}">old page</a> holds the history.</p>`;
	const res = await patch([{ old_string: h1, new_string: link }]);
	assert.equal(res.status, 409, await res.clone().text());
	const { error } = await res.json();
	assert.ok(error.includes(retired), `the error must name the retired page: ${error}`);
	assert.equal(await raw(PAGE), original, 'a refused write changes no byte');
});

// The page API runs the page gate rules 3 and 4 (apps/llm-wiki/scripts/page-gate.mjs) that commit.mjs runs.
test('a write that adds a repo path git does not have is refused, and one that names a removed path passes the check', async (t) => {
	if (!BASE) return t.skip('llm-wiki dev server unreachable, SKIPPED, not passed');
	const h1 = firstH1(original);
	const dead = '<p>The deploy runs <code>scripts/repo/no-such-deploy-p698.sh</code>.</p>';
	const res = await patch([{ old_string: `<h1>${h1}</h1>`, new_string: `<h1>${h1}</h1>\n${dead}` }]);
	assert.equal(res.status, 422, await res.clone().text());
	const { error } = await res.json();
	assert.match(error, /scripts\/repo\/no-such-deploy-p698\.sh, which git does not have/, error);
	assert.equal(await raw(PAGE), original, 'a refused write changes no byte');
});

test('a write that drops last_verified is refused, and a new curated page needs one', async (t) => {
	if (!BASE) return t.skip('llm-wiki dev server unreachable, SKIPPED, not passed');
	const verified = /"last_verified"\s*:\s*"[^"]*",?/.exec(original);
	assert.ok(verified, `${PAGE} needs a last_verified`);
	const res = await patch([{ old_string: verified[0], new_string: '' }]);
	assert.equal(res.status, 422, await res.clone().text());
	assert.match((await res.json()).error, /drops its last_verified/);
	assert.equal(await raw(PAGE), original, 'a refused write changes no byte');
	const fresh = 'apps/llm-wiki/page-gate-fixture-p698.html';
	const content = '<!--wiki {"title":"Gate fixture","description":"page gate fixture"}-->\n<h1>Gate fixture</h1>\n';
	const created = await send('POST', '/api/agent/page', { path: fresh, content, author: 'page-invariants test' });
	assert.equal(created.status, 422, await created.clone().text());
	assert.match((await created.json()).error, /new page with no last_verified/);
	assert.equal((await fetch(`${BASE}/raw/${fresh}`)).status, 404, 'a refused page is never written');
});
