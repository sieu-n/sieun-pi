import './no-wiki-config.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { newPairs, pageRow } from '../scripts/dup-gate.mjs';
import { dupPairs } from '../scripts/wiki-health.mjs';

// 2026-11-24: 24 retired pages moved to archive/ left move stubs at their old paths, and the write dup check held a rewrite
// of apps/crawler-v3/crawler-risks/index.html on the snapchat-risks and vimeo-risks stubs, whose titles it shares.
const page = (title, extra = {}) => `<!--wiki ${JSON.stringify({ title, description: `${title} that the crawler tracks.`, ...extra })}-->\n<h1>${title}</h1>`;
const C = 'apps/llm-wiki/content/';

test('a move stub pairs with nothing, so a page that shares its title makes no new pair', () => {
	const stub = page('Vimeo crawler risks', { moved_to: 'archive/apps/crawler-v3/vimeo-risks/index.html' });
	assert.deepEqual(pageRow(`${C}apps/crawler-v3/vimeo-risks/index.html`, stub), {
		path: 'apps/crawler-v3/vimeo-risks/index.html',
		movedTo: 'archive/apps/crawler-v3/vimeo-risks/index.html',
	});
	const live = pageRow(`${C}apps/crawler-v3/crawler-risks/index.html`, page('Crawler risks'));
	assert.equal(live?.path, 'apps/crawler-v3/crawler-risks/index.html');
	const before = [pageRow(`${C}apps/crawler-v3/vimeo-risks/index.html`, stub)];
	const after = [...before, live];
	assert.deepEqual(newPairs(before, after, ['apps/crawler-v3/crawler-risks/index.html']), []);
});

test('two live pages with the same title still make a pair', () => {
	const a = pageRow(`${C}apps/a/risks.html`, page('Vimeo crawler risks'));
	const b = pageRow(`${C}apps/b/risks.html`, page('Vimeo crawler risks'));
	assert.equal(newPairs([a], [a, b], ['apps/b/risks.html']).length, 1);
});

// 2026-11-25: the move API took domains/devops/ci-cd-pipeline/land-and-promote-deploy.html to land-and-promote/deploy/index.html at
// 20:30:55Z, and domains/architecture/ci-deploy/deploys-staging.html, whose distinct_from still named the old path, made an unjudged
// pair with it (0.56), one of the 9 dup_unjudged read at 20:35Z.
const OLD = 'domains/devops/ci-cd-pipeline/land-and-promote-deploy.html';
const NEW = 'domains/devops/ci-cd-pipeline/land-and-promote/deploy/index.html';
const STAGING = 'domains/architecture/ci-deploy/deploys-staging.html';
const deployPage = page('Staging deploy run');
const stagingPage = page('Staging deploy run', { distinct_from: { [OLD]: 'That page walks the release path, while this page lists one run.' } });

test("a distinct_from that names a moved page's old path still settles the pair at its new path", () => {
	const rows = [
		pageRow(`${C}${STAGING}`, stagingPage),
		pageRow(`${C}${OLD}`, page('Staging deploy run', { moved_to: NEW })),
		pageRow(`${C}${NEW}`, deployPage),
	];
	assert.deepEqual(dupPairs(rows), []);
	const before = [rows[0], pageRow(`${C}${OLD}`, deployPage)];
	assert.deepEqual(newPairs(before, rows, [OLD, NEW]), []);
});

test('a distinct_from follows a page moved twice, and a page it does not name still pairs', () => {
	const LAST = 'archive/domains/devops/ci-cd-pipeline/land-and-promote/deploy/index.html';
	const rows = [
		pageRow(`${C}${STAGING}`, stagingPage),
		pageRow(`${C}${OLD}`, page('Staging deploy run', { moved_to: NEW })),
		{ path: NEW, movedTo: LAST },
		{ path: LAST, title: 'Staging deploy run', description: 'Staging deploy run that the crawler tracks.' },
		pageRow(`${C}domains/devops/other.html`, page('Staging deploy run')),
	];
	assert.deepEqual(
		dupPairs(rows).map((p) => `${p.a}|${p.b}`),
		[`${LAST}|domains/devops/other.html`, `${STAGING}|domains/devops/other.html`],
	);
});
