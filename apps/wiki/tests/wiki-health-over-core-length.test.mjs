import './no-wiki-config.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lintHtml } from '../src/lib/prose-lint.mjs';
import { isRedirect, overCoreLength, parseMeta } from '../scripts/wiki-health.mjs';

// Owner, 2026-11-24 (#dev-crawler p23, c243): an apps/ or domains/ page holds only the layers a reader can check, near 800 words. On that day
// 391 of 548 such pages were over the line, so the wiki dream counts each one in wiki_problems to keep the rewrite from sliding back.
const page = (words) =>
	`<!--wiki {"title":"Queue","description":"The queue.","status":"current"}-->\n<h1>Queue</h1>\n` +
	Array.from({ length: Math.ceil(words / 10) }, () => '<p>The worker reads one row from the queue table and writes it back.</p>').join('\n');
const result = (file, html) => ({ file, skipped: false, findings: lintHtml(html, { path: file }).findings });

test('a live apps/ or domains/ page past the core-length line is counted with its words, most read first', () => {
	const results = [
		result('apps/a/long.html', page(900)),
		result('domains/b/longer.html', page(1200)),
		result('apps/a/short.html', page(300)),
		result('projects/c/long.html', page(1200)),
		{ file: 'apps/a/skipped.html', skipped: true, findings: [] },
	];
	const pages = ['apps/a/long.html', 'domains/b/longer.html', 'apps/a/short.html', 'projects/c/long.html'].map((p) => ({ path: p, status: 'current' }));
	const rows = overCoreLength(results, '/snap', pages, new Map([['apps/a/long.html', 9]]));
	assert.deepEqual(
		rows.map((r) => r.path),
		['apps/a/long.html', 'domains/b/longer.html'],
	);
	assert.ok(rows.every((r) => r.words > 800));
});

test('a settled page leaves the count, and an absolute lint path is read relative to the lint root', () => {
	const results = ['apps/a/long.html', 'apps/a/old.html'].map((p) => ({ ...result(p, page(900)), file: `/snap/content/${p}` }));
	const pages = [
		{ path: 'apps/a/long.html', status: 'living' },
		{ path: 'apps/a/old.html', status: 'superseded' },
	];
	assert.deepEqual(
		overCoreLength(results, '/snap/content', pages, new Map()).map((r) => r.path),
		['apps/a/long.html'],
	);
});

// 2026-11-24: moving 24 retired pages to archive/ left 24 move stubs, which wiki-health read as pages with no description, date or hub row.
test('a move stub is a redirect, not a page to check', () => {
	const stub = '<!--wiki\n{"title":"Vimeo risks","moved_to":"archive/apps/v/index.html","superseded_by":"archive/apps/v/index.html"}\n-->\n<h1>Vimeo risks</h1>';
	assert.equal(isRedirect(parseMeta(stub)), true);
	assert.equal(isRedirect(parseMeta('<!--wiki {"title":"Queue","status":"current"}-->')), false);
	assert.equal(isRedirect(null), false);
});
