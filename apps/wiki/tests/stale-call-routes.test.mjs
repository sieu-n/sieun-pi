import './no-wiki-config.mjs';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { definitionCode } from '../src/lib/definitions.mjs';
import { entryKeys } from '../src/lib/stale-rules.mjs';
import { pageRepo } from './page-repo.mjs';
import { engineReports, snapshotTree } from '../scripts/wiki-health.mjs';

// 2026-11-23: `routes` in apps/chat/server/http.ts registers each route as a call, `route("GET", "/api/search", ...)`, and
// 9e08c8d5 and e1e99b12 changed other routes and flagged the pages citing `http.ts::routes` for one or two routes, because a
// ref could not name a call-form route and entryKeys narrowed only a table that holds `"GET /api/x"` quoted. A page that
// counts the routes, such as system.html's `104 HTTP routes`, still follows every call.
const routesTs = (search, ready) =>
	[
		'export function routes(app: App): Route[] {',
		'  const str = (value: string | null) => value ?? undefined;',
		'  return [',
		`    route("GET", "/api/ready", async () => ({ ready: ${ready} })),`,
		'    route("GET", "/api/search", async (_r, _p, q) => app.search.run({',
		`      q: q.get("q") ?? "", limit: ${search},`,
		'    })),',
		'    route("GET", "/api/search/recent", async () => app.search.recent()),',
		'    route("POST", "/api/search", async (_r, _p, _q, body) => {',
		'      if (!(await body())) throw new BadRequest("A search (POST) needs a body [q].");',
		'    }),',
		'  ];',
		'}',
		'',
	].join('\n');

test('a route key names each call that registers it, to its close paren', () => {
	const text = routesTs(20, true);
	const get = '    route("GET", "/api/search", async (_r, _p, q) => app.search.run({\n      q: q.get("q") ?? "", limit: 20,\n    })),';
	const post = '    route("POST", "/api/search", async (_r, _p, _q, body) => {\n      if (!(await body())) throw new BadRequest("A search (POST) needs a body [q].");\n    }),';
	assert.equal(definitionCode(text, 'GET /api/search', 'http.ts'), get);
	assert.equal(definitionCode(text, '/api/search', 'http.ts'), `${get}\n${post}`, 'a bare route names the calls of every method');
	assert.equal(definitionCode(text, '/api/ready', 'http.ts'), '    route("GET", "/api/ready", async () => ({ ready: true })),');
	assert.equal(definitionCode(text, 'PUT /api/search', 'http.ts'), null);
	assert.equal(definitionCode(text, '/api/sear', 'http.ts'), null, 'a route prefix names no call');
});

test('entryKeys keys a function of route calls only by the routes the page names', () => {
	const routes = definitionCode(routesTs(20, true), 'routes', 'http.ts') ?? '';
	const keys = (body) => entryKeys(body, routes).sort();
	assert.deepEqual(keys('<p><code>GET /api/search</code> runs it, and <code>/api/ready</code> answers.</p>'), ['/api/ready', 'GET /api/search']);
	assert.deepEqual(keys('<p><code>DELETE /api/gone</code> and <code>/api/sear</code>.</p>'), [], 'an unregistered route keys nothing');
	assert.deepEqual(keys('<p><code>search_messages</code> calls <code>app.search.run</code>.</p>'), [], 'a word keys no route call');
	assert.deepEqual(keys('<p>The server answers 104 HTTP routes, such as <code>/api/ready</code>.</p>'), [], 'a route count follows every row');
	assert.deepEqual(keys('<p>Step 1 routes <code>/api/ready</code>.</p>'), ['/api/ready'], 'one is no count of the table');
});

test('a path::name ref to a function of route calls follows only the routes the page names', (t) => {
	const repo = pageRepo(t, 'stale-call-routes-');
	repo.write('apps/llm-wiki/content/index.html', '<h1>Home</h1>\n');
	repo.write('http.ts', routesTs(20, true));
	const ref = ['http.ts::routes'];
	repo.page('search.html', ref, { body: '<p>Cmd K calls <code>GET /api/search</code>.</p>' });
	repo.page('ready.html', ['http.ts::/api/ready'], { body: '<p>The probe reads it.</p>' });
	repo.page('whole.html', ref, { body: '<p>The table holds every route.</p>' });
	repo.init();
	repo.commit('2026-10-20T01:00:00Z', 'pages');
	repo.write('http.ts', routesTs(20, false));
	repo.commit('2026-10-20T04:00:00Z', 'ready changes');
	repo.write('http.ts', routesTs(50, false));
	repo.commit('2026-10-20T05:00:00Z', 'search changes');

	const root = snapshotTree(path.join(repo.dir, 'apps/llm-wiki/content'), repo.dir);
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const rows = Object.fromEntries(engineReports(root, repo.dir).stale.stale.map((row) => [row.path, row.staleRefs]));
	const at = (since, modified = since) => ({ modified: `2026-10-20T${modified}:00:00.000Z`, since: `2026-10-20T${since}:00:00.000Z` });
	assert.deepEqual(rows['apps/search.html'], [{ ref: ref[0], ...at('05') }], 'the /api/ready edit is no change to GET /api/search');
	assert.deepEqual(rows['apps/ready.html'], [{ ref: 'http.ts::/api/ready', ...at('04') }], 'a route key ref follows its call');
	assert.deepEqual(rows['apps/whole.html'], [{ ref: ref[0], ...at('04', '05') }], 'a page naming no route follows the function');
});
