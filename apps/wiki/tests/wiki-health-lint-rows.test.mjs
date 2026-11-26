import './no-wiki-config.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lintPageRows } from '../scripts/wiki-health.mjs';

// 2026-11-27: prose-lint returns the home page, which wiki-health hands it by name, as the relative `index.html`, and a run from the
// sieun-pi checkout listed it as `../../../../../home/sieun/src/sieun-pi/index.html`.
const err = (rule) => ({ rule, severity: 'error' });

test('a relative lint path is read against the lint root, not the cwd', () => {
	const rows = lintPageRows(
		[
			{ file: 'index.html', skipped: false, findings: [err('lead-visual')] },
			{ file: '/snap/content/apps/a/page.html', skipped: false, findings: [err('doc-paragraph'), err('doc-paragraph'), { rule: 'x', severity: 'warning' }] },
			{ file: 'apps/a/skipped.html', skipped: true, findings: [] },
		],
		'/snap/content',
	);
	assert.deepEqual(rows, [
		{ path: 'index.html', errors: 1, byRule: { 'lead-visual': 1 } },
		{ path: 'apps/a/page.html', errors: 2, byRule: { 'doc-paragraph': 2 } },
	]);
});
