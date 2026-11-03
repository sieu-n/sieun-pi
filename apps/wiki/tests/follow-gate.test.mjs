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
	assert.deepEqual(behindPages(w.dir, base, code), [
		{ page: 'apps/complete.html', refs: ['routes.py::contact_complete'] },
		{ page: 'apps/jobs.html', refs: ['jobs/'] },
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
