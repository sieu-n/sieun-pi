import './no-wiki-config.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { newPairs, pageRow } from '../scripts/dup-gate.mjs';

// 2026-11-24: 24 retired pages moved to archive/ left move stubs at their old paths, and the write dup check held a rewrite
// of apps/crawler-v3/crawler-risks/index.html on the snapchat-risks and vimeo-risks stubs, whose titles it shares.
const page = (title, extra = {}) => `<!--wiki ${JSON.stringify({ title, description: `${title} that the crawler tracks.`, ...extra })}-->\n<h1>${title}</h1>`;
const C = 'apps/llm-wiki/content/';

test('a move stub gives no dupPairs row, so a page that shares its title makes no new pair', () => {
	const stub = page('Vimeo crawler risks', { moved_to: 'archive/apps/crawler-v3/vimeo-risks/index.html' });
	assert.equal(pageRow(`${C}apps/crawler-v3/vimeo-risks/index.html`, stub), null);
	const live = pageRow(`${C}apps/crawler-v3/crawler-risks/index.html`, page('Crawler risks'));
	assert.equal(live?.path, 'apps/crawler-v3/crawler-risks/index.html');
	const before = [pageRow(`${C}apps/crawler-v3/vimeo-risks/index.html`, stub)].filter(Boolean);
	const after = [...before, live];
	assert.deepEqual(newPairs(before, after, ['apps/crawler-v3/crawler-risks/index.html']), []);
});

test('two live pages with the same title still make a pair', () => {
	const a = pageRow(`${C}apps/a/risks.html`, page('Vimeo crawler risks'));
	const b = pageRow(`${C}apps/b/risks.html`, page('Vimeo crawler risks'));
	assert.equal(newPairs([a], [a, b], ['apps/b/risks.html']).length, 1);
});
