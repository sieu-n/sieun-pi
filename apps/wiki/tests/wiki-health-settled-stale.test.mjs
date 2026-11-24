import './no-wiki-config.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { liveStale } from '../scripts/wiki-health.mjs';

// 2026-11-23T16:09Z: the dream precheck flagged 40 pages as stale_vs_code, and 5 of them were superseded, such as
// domains/devops/sw-factory-threads/architecture.html. A writer rechecked each one, though a superseded page sends readers on.
test('a superseded, deprecated or archived page leaves the stale report, and a live page stays', () => {
	const row = (p) => ({ path: p, title: p, last_verified: '2026-11-01', staleRefs: [{ ref: 'apps/a.ts', modified: '2026-11-23T10:00:00Z' }] });
	const stale = { count: 4, stale: ['live', 'old', 'gone', 'retired'].map((n) => row(`domains/a/${n}.html`)) };
	const pages = [
		{ path: 'domains/a/live.html', status: 'current' },
		{ path: 'domains/a/old.html', status: 'superseded' },
		{ path: 'domains/a/gone.html', status: 'Deprecated' },
		{ path: 'domains/a/retired.html', status: 'archived' },
	];
	liveStale(stale, pages);
	assert.deepEqual(
		stale.stale.map((s) => s.path),
		['domains/a/live.html'],
	);
	assert.equal(stale.count, 1);
});

// 2026-11-24: four of the 24 retired pages moved to archive/ counted as pages behind code in the next precheck.
test('a page under archive/ leaves the stale report', () => {
	const row = (p) => ({ path: p, title: p, last_verified: '2026-11-22', staleRefs: [{ ref: 'apps/a.ts', modified: '2026-11-24T01:00:00Z' }] });
	const stale = { count: 2, stale: [row('archive/domains/devops/agent-memory.html'), row('domains/a/live.html')] };
	liveStale(stale, [{ path: 'domains/a/live.html', status: 'current' }]);
	assert.deepEqual(
		stale.stale.map((s) => s.path),
		['domains/a/live.html'],
	);
	assert.equal(stale.count, 1);
});
