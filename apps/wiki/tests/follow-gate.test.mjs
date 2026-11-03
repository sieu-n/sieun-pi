import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { behindPages, behindWarning, brokenCitations, followRefusal } from '../scripts/follow-gate.mjs';
import { pageRepo } from './page-repo.mjs';

// A git repo with curated pages (page-repo.mjs) whose pages were checked at 2026-10-20T03:00Z.
function fixture(t) {
	const repo = pageRepo(t, 'follow-gate-');
	repo.init();
	let minute = 0;
	return { ...repo, commit: (message) => repo.commit(`2026-10-20T04:${String(minute++).padStart(2, '0')}:00Z`, message) };
}

const routes = (complete, find) =>
	`def contact_complete():\n    # the route\n    return ${complete}\n\n\ndef contact_find():\n    return ${find}\n`;
const limits = (reads, writes) => `LIMITS = {\n    'reads_per_s': ${reads},\n    'writes_per_s': ${writes},\n}\n`;

// 2026-10-29: in the 7 days to 2026-10-29 20:14Z, 621 agent code commits put pages behind their code and left them for the
// wiki dream, whose one job sat parked on model quota while 88% of the counted page-hours fell.
test('a code commit that changes what a curated page states names the page until the page is in the commit', (t) => {
	const w = fixture(t);
	w.write('routes.py', routes(1, 1));
	w.write('settings.py', limits(10, 5));
	w.write('jobs/run.py', 'RUN_EVERY_S = 60\n');
	w.page('complete.html', ['routes.py::contact_complete'], { body: '<p>The route returns 1.</p>' });
	w.page('find.html', ['routes.py::contact_find'], { body: '<p>Find returns 1.</p>' });
	w.page('reads.html', ['settings.py::LIMITS'], { body: '<p>The cap is <code>reads_per_s</code> 10.</p>' });
	w.page('jobs.html', ['jobs/'], { body: '<p>A run starts every <code>RUN_EVERY_S</code> seconds.</p>' });
	const base = w.commit('pages');

	w.write('routes.py', routes(2, 1));
	w.write('settings.py', limits(10, 6));
	w.write('jobs/run.py', 'RUN_EVERY_S = 30\n');
	const code = w.commit('code alone');
	const verified = { lastVerified: '2026-10-20T03:00Z', earlier: [] };
	assert.deepEqual(behindPages(w.dir, base, code), [
		{ page: 'apps/complete.html', refs: ['routes.py::contact_complete'], ...verified },
		{ page: 'apps/jobs.html', refs: ['jobs/'], ...verified },
	]);
	assert.match(
		behindWarning(w.dir, base, code),
		/^follow gate warning: .*\n {2}apps\/llm-wiki\/content\/apps\/complete\.html: cites routes\.py::contact_complete\n {2}apps\/llm-wiki\/content\/apps\/jobs\.html: cites jobs\/\n/,
	);

	w.page('complete.html', ['routes.py::contact_complete'], { body: '<p>The route returns 2.</p>' });
	w.page('jobs.html', ['jobs/'], { body: '<p>A run starts every <code>RUN_EVERY_S</code> seconds, 30 since 2026-10-29.</p>' });
	const followed = w.commit('code with its pages');
	assert.deepEqual(behindPages(w.dir, base, followed), [], 'a page in the commit passes');
	assert.equal(behindWarning(w.dir, base, followed), null);
});

// 2026-11-03: session push-verdict-tail-11-03 followed this warning for its revert 1e85d90226 and set last_verified at 08:02Z on
// 4 pages that were already behind 65328f3db6 (07:18Z) and 17778738bc (07:26Z). The stamp hid both commits from the stale
// report until the wiki dream rewrote the pages, because the warning named only the commit being written.
test('the warning names the older commits a page is already behind, so a new last_verified cannot hide them', (t) => {
	const w = fixture(t);
	w.write('routes.py', routes(1, 1));
	w.write('settings.py', limits(10, 5));
	w.page('complete.html', ['routes.py::contact_complete', 'settings.py::LIMITS'], {
		body: '<p>The route returns 1 under the <code>reads_per_s</code> cap of 10.</p>',
	});
	const base = w.commit('code and page together, the page\'s own check');
	w.write('routes.py', routes(2, 1));
	const split = w.commit('the split, page left out');
	w.write('routes.py', routes(2, 2).replace('# the route', '# the complete route'));
	w.write('settings.py', limits(10, 6));
	w.commit('a comment, another definition and an unnamed table row');
	w.write('settings.py', limits(20, 6));
	const cap = w.commit('the cap the page names, page left out');
	w.write('routes.py', routes(3, 2));
	const head = w.commit('the next change');
	w.write('routes.py', routes(4, 2));
	const revert = w.commit('the commit being written');

	assert.deepEqual(behindPages(w.dir, head, revert), [
		{
			page: 'apps/complete.html',
			refs: ['routes.py::contact_complete'],
			lastVerified: '2026-10-20T03:00Z',
			earlier: [split, cap, head].map((sha) => sha.slice(0, 10)),
		},
	]);
	const warning = behindWarning(w.dir, head, revert);
	assert.match(
		warning,
		new RegExp(
			`complete\\.html: cites routes\\.py::contact_complete, and is already behind ${split.slice(0, 10)}, ${cap.slice(0, 10)}, ${head.slice(0, 10)} since its last_verified 2026-10-20T03:00Z\n`,
		),
	);
	assert.match(warning, /only once every one\nof those diffs is in the page or changes nothing it states/);
	assert.ok(!warning.includes(base.slice(0, 10)), 'a commit that changed the page with its code is the page\'s check');

	w.page('complete.html', ['routes.py::contact_complete', 'settings.py::LIMITS'], {
		verified: '2026-10-20T04:05Z',
		body: '<p>The route returns 3 under the <code>reads_per_s</code> cap of 20.</p>',
	});
	const checked = w.commit('the page checked after every commit so far');
	w.write('routes.py', routes(5, 2));
	const next = w.commit('a change after the check');
	assert.deepEqual(
		behindPages(w.dir, checked, next).map((row) => row.earlier),
		[[]],
		'a commit before the page\'s last_verified minute is checked',
	);
});

test('a definition an older commit changed and a later one put back is not named', (t) => {
	const w = fixture(t);
	w.write('routes.py', routes(1, 1));
	w.page('complete.html', ['routes.py::contact_complete'], { body: '<p>The route returns 1.</p>' });
	w.commit('pages');
	w.write('routes.py', routes(2, 1));
	w.commit('a change');
	w.write('routes.py', routes(1, 1));
	const back = w.commit('its revert');
	w.write('routes.py', routes(3, 1));
	const code = w.commit('the commit being written');
	assert.deepEqual(behindPages(w.dir, back, code).map((row) => row.earlier), [[]]);
});

test('a comment edit, another definition or an unnamed table row names no page', (t) => {
	const w = fixture(t);
	w.write('routes.py', routes(1, 1));
	w.write('settings.py', limits(10, 5));
	w.page('complete.html', ['routes.py::contact_complete'], { body: '<p>The route returns 1.</p>' });
	w.page('reads.html', ['settings.py::LIMITS'], { body: '<p>The cap is <code>reads_per_s</code> 10.</p>' });
	const base = w.commit('pages');
	w.write('routes.py', routes(1, 2).replace('# the route', '# the complete route'));
	w.write('settings.py', limits(10, 6));
	const code = w.commit('elsewhere');
	assert.deepEqual(behindPages(w.dir, base, code), []);
});

const page = (w, rel, meta, refs) =>
	w.write(
		`apps/llm-wiki/content/${rel}`,
		`<!--wiki ${JSON.stringify({ title: rel, description: 'd', last_verified: '2026-10-20T03:00Z', ...meta, source_refs: refs })}-->\n<h1>${rel}</h1>\n`,
	);

// 2026-10-30: 053c39867a removed run_stockists from apps/crawler-v3/scripts/resolve_undo.py while
// experiments/2026-10-29-profile-entity-resolution cited it. The gate skipped experiment pages, and the wiki dream counted the
// page in wiki_problems at once.
test('a commit that removes a definition or path an experiment or settled page cites in source_refs is refused until the page follows', (t) => {
	const w = fixture(t);
	w.write('scripts/undo.py', 'def run_stockists():\n    return 1\n\n\ndef run_lists():\n    return 1\n');
	w.write('jobs/run.py', 'RUN = 1\n');
	page(w, 'experiments/2026-10-29-resolve/index.html', { kind: 'experiment', status: 'current' }, ['scripts/undo.py::run_stockists']);
	page(w, 'apps/old.html', { status: 'superseded' }, ['jobs/']);
	const base = w.commit('pages');

	w.write('scripts/undo.py', 'def run_lists():\n    return 1\n');
	rmSync(path.join(w.dir, 'jobs/run.py'));
	const code = w.commit('code alone');
	assert.deepEqual(brokenCitations(w.dir, base, code), [
		{ page: 'apps/old.html', refs: ['jobs/'] },
		{ page: 'experiments/2026-10-29-resolve/index.html', refs: ['scripts/undo.py::run_stockists'] },
	]);
	assert.match(followRefusal(w.dir, base, code), /cites scripts\/undo\.py::run_stockists/);

	page(w, 'experiments/2026-10-29-resolve/index.html', { kind: 'experiment', status: 'current' }, ['scripts/undo.py::run_lists']);
	page(w, 'apps/old.html', { status: 'superseded' }, []);
	const followed = w.commit('code with its pages');
	assert.equal(followRefusal(w.dir, base, followed), null);
});
