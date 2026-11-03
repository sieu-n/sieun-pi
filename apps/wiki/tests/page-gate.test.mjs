import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { assertFixtureRepo, fixtureGitEnv } from './test-git-env.mjs';
import { pageStackRefusal, pageWriteReasons, pageWriteWarnings } from '../scripts/page-gate.mjs';

const LINT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../scripts/prose-lint.mjs');
const DROPS = 'apps/crawler-v3/tiktok-shop-listing-drops/index.html';
const RISKS = 'apps/crawler-v3/tiktok-shop-risks/index.html';
const html = (meta, body = '', h1 = meta.title) => `<!--wiki ${JSON.stringify(meta)}-->\n<h1>${h1}</h1>\n${body}\n`;
const link = (href) => `<p>The <a href="${href}">listing drops page</a> has the history.</p>`;
const DAY = '2026-10-19';
const drops = (status) => html({ title: 'TikTok Shop listings losing views', description: 'd', status, last_verified: DAY });
const hub = (body) => html({ title: 'crawler-v3', description: 'hub', status: 'current', last_verified: DAY }, body);

test('prose-lint --ratchet-git refuses the 8cec86237b commit and passes once the link is gone', (t) => {
	const repo = mkdtempSync(path.join(tmpdir(), 'page-gate-'));
	t.after(() => rmSync(repo, { recursive: true, force: true }));
	const env = fixtureGitEnv(repo);
	const git = (...args) => execFileSync('git', args, { cwd: repo, env, encoding: 'utf8' });
	const write = (rel, text) => {
		const file = path.join(repo, 'apps/llm-wiki/content', rel);
		mkdirSync(path.dirname(file), { recursive: true });
		writeFileSync(file, text);
		return `apps/llm-wiki/content/${rel}`;
	};
	git('init', '-q');
	assertFixtureRepo(repo, env);
	git('add', write(DROPS, drops('archived')));
	git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'drops');
	const head = git('rev-parse', 'HEAD').trim();
	const risks = write(RISKS, hub(link('../tiktok-shop-listing-drops/index.html')));
	const lint = () => spawnSync(process.execPath, [LINT, '--ratchet-git', head, risks], { cwd: repo, env, encoding: 'utf8' });
	const refused = lint();
	assert.equal(refused.status, 1, refused.stdout + refused.stderr);
	assert.match(refused.stdout, /page gate: .*\n.*tiktok-shop-risks\/index\.html: it links the retired page/);
	write(RISKS, hub('<p>The duty owns these risks.</p>'));
	const passed = lint();
	assert.equal(passed.status, 0, passed.stdout + passed.stderr);
});

const RUNBOOK = 'domains/devops/deploy-runbook.html';
const runbook = (meta, body = '') => html({ title: 'Deploy runbook', description: 'd', ...meta }, body);

function codeRepo() {
	const repo = mkdtempSync(path.join(tmpdir(), 'page-gate-refs-'));
	const env = { ...fixtureGitEnv(repo), SIEUN_PI_REPO: path.join(repo, 'no-sieun-pi') };
	const git = (...args) => execFileSync('git', args, { cwd: repo, env, encoding: 'utf8' }).trim();
	const write = (rel, text) => {
		mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
		writeFileSync(path.join(repo, rel), text);
		return rel;
	};
	const page = (rel, text) => write(`apps/llm-wiki/content/${rel}`, text);
	const commit = (...files) => {
		git('add', ...files);
		git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'c');
		return git('rev-parse', 'HEAD');
	};
	git('init', '-q');
	assertFixtureRepo(repo, env);
	return { repo, env, git, write, page, commit };
}

// 2026-11-03: session push-verdict-tail-11-03 checked 4 pages against its revert 1e85d90226 only and set last_verified at
// 08:02Z, which hid 65328f3db6 (07:18Z) and 17778738bc (07:26Z) from the stale report. Rule 7 names the hidden commits in the
// page API answer and lets the write through (c98).
test('the page gate warns on a write whose later last_verified hides a commit the page does not name, and lets it through', (t) => {
	const f = codeRepo();
	t.after(() => rmSync(f.repo, { recursive: true, force: true }));
	const at = (when, ...files) => {
		f.git('add', ...files);
		execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'c'], {
			cwd: f.repo,
			env: { ...f.env, GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when },
		});
		return f.git('rev-parse', 'HEAD');
	};
	const PUSH = 'domains/devops/stability-pipeline/push-ci.html';
	const PLAN = 'scripts/ci/plan.mjs';
	const plan = (shards, legs) => `export function searchE2e() {\n\treturn ${shards};\n}\nexport function searchUnit() {\n\treturn ${legs};\n}\n`;
	const push = (verified, body) =>
		html({ title: 'Push CI', description: 'd', last_verified: verified, source_refs: [`${PLAN}::searchE2e`, `${PLAN}::searchUnit`] }, body);
	const before = push('2026-11-03T07:10Z', '<p>search / e2e runs on one leg, and search unit tests on two.</p>');
	at('2026-11-03T07:00:00Z', f.write(PLAN, plan(1, 2)), f.page(PUSH, before));
	const split = at('2026-11-03T07:18:56Z', f.write(PLAN, plan(2, 2)));
	const revert = at('2026-11-03T07:59:38Z', f.write(PLAN, plan(2, 1)));

	const stamped = push('2026-11-03T08:02Z', '<p>search / e2e runs on one leg, and search unit tests on one again since 1e85d90226.</p>');
	assert.deepEqual(pageWriteReasons(f.repo, PUSH, before, stamped), [], 'rule 7 never refuses');
	const warned = pageWriteWarnings(f.repo, PUSH, before, stamped).join('\n');
	assert.match(
		warned,
		new RegExp(`it moves last_verified from 2026-11-03T07:10Z to 2026-11-03T08:02Z past ${split.slice(0, 10)}, ${revert.slice(0, 10)}, which`),
	);
	const named = push('2026-11-03T08:02Z', `<p>search / e2e runs on two shard legs since ${split.slice(0, 10)}, and search unit tests on one since ${revert.slice(0, 10)}.</p>`);
	assert.deepEqual(pageWriteWarnings(f.repo, PUSH, before, named), [], 'a write that names each commit it checked passes');
	assert.deepEqual(
		pageWriteWarnings(f.repo, PUSH, before, stamped, `wiki-dream: checked ${split.slice(0, 10)} and ${revert.slice(0, 10)}`),
		[],
		'a summary that names each commit counts too',
	);
	assert.deepEqual(pageWriteWarnings(f.repo, PUSH, before, before), [], 'a write that keeps last_verified passes');
	const early = push('2026-11-03T07:15Z', '<p>search / e2e runs on one leg.</p>');
	assert.deepEqual(pageWriteWarnings(f.repo, PUSH, before, early), [], 'a last_verified before the commits hides none');
});

// A relative link to a .py or .mjs file in git is a dead_link, because the index serves no .py or .mjs page.
const SCALE = 'projects/multi-platform-crawl-scale/index.html';
const scale = (body) => html({ title: 'Multi-platform crawl scale', description: 'd', last_verified: DAY }, body);

test('the page gate refuses a dead link a commit adds, in commit.mjs and land-object.mjs, and names /raw/<path>', (t) => {
	const f = codeRepo();
	const pi = process.env.SIEUN_PI_REPO;
	process.env.SIEUN_PI_REPO = f.env.SIEUN_PI_REPO;
	t.after(() => {
		if (pi === undefined) delete process.env.SIEUN_PI_REPO;
		else process.env.SIEUN_PI_REPO = pi;
		rmSync(f.repo, { recursive: true, force: true });
	});
	const probe = 'apps/llm-wiki/content/projects/multi-platform-crawl-scale/bench/ig_probe.py';
	const base = f.commit(f.write(probe, 'print(1)\n'), f.page(SCALE, scale('<p>The scale plan.</p>')));
	const page = f.page(SCALE, scale('<p>The scale plan runs <a href="bench/ig_probe.py">the probe</a>.</p>'));
	const lint = () => spawnSync(process.execPath, [LINT, '--ratchet-git', base, page], { cwd: f.repo, env: f.env, encoding: 'utf8' });
	const refused = lint();
	assert.equal(refused.status, 1, refused.stdout + refused.stderr);
	assert.match(refused.stdout, /multi-platform-crawl-scale\/index\.html: it adds 1 link\(s\) that lead to no wiki page: projects\/multi-platform-crawl-scale\/bench\/ig_probe\.py\..*\/raw\/projects\/multi-platform-crawl-scale\/bench\/ig_probe\.py/);
	const landed = f.commit(page);
	assert.match(pageStackRefusal(f.repo, base, landed), /index\.html: it adds 1 link\(s\) that lead to no wiki page/);
	f.page(SCALE, scale('<p>The scale plan runs <a href="/raw/projects/multi-platform-crawl-scale/bench/ig_probe.py">the probe</a>.</p>'));
	const raw = spawnSync(process.execPath, [LINT, '--ratchet-git', landed, page], { cwd: f.repo, env: f.env, encoding: 'utf8' });
	assert.equal(raw.status, 0, `a /raw/ link passes, and the dead link it replaced was old debt\n${raw.stdout}${raw.stderr}`);
	const sibling = f.page('projects/multi-platform-crawl-scale/plan.html', scale('<p>The plan.</p>').replaceAll('Multi-platform crawl scale', 'Plan'));
	f.page(SCALE, scale('<p>The <a href="plan">plan</a> and <a href="bench/ig_probe.py">the probe</a>.</p>'));
	const kept = spawnSync(process.execPath, [LINT, '--ratchet-git', landed, page, sibling], { cwd: f.repo, env: f.env, encoding: 'utf8' });
	assert.equal(kept.status, 0, `a page the same commit adds is a live link, and an old dead link stays editable\n${kept.stdout}${kept.stderr}`);
});

// 2026-10-30: 41017ab1a0 swapped a source_ref of apps/search/enterprise-mock.html to TimeChart.svelte, which efa5e46967 had
// changed after the page's last_verified, and the wiki dream counted the page behind its code the moment it landed.
// Rule 6 warns and lets the write through until the d4 runs show it repeat (c81, c98).
test('the page gate warns on a source_ref a write adds whose file changed after last_verified, and lets it through', (t) => {
	const f = codeRepo();
	t.after(() => rmSync(f.repo, { recursive: true, force: true }));
	const at = (when, ...files) => {
		f.git('add', ...files);
		execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'c'], {
			cwd: f.repo,
			env: { ...f.env, GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when },
		});
		return f.git('rev-parse', 'HEAD');
	};
	const MOCK = 'apps/search/enterprise-mock.html';
	const OLD = 'apps/virev-demo/overlay/src/lib/charts/TimeChart.svelte';
	const NEW = 'apps/search/src/lib/charts/TimeChart.svelte';
	const mock = (ref, verified) =>
		html({ title: 'Enterprise mock', description: 'd', last_verified: verified, source_refs: [ref] }, '<p>The chart kit.</p>');
	const base = at('2026-10-29T23:00:00Z', f.write(OLD, 'a\n'), f.write(NEW, 'a\n'), f.page(MOCK, mock(OLD, '2026-10-29T23:21Z')));
	const changed = at('2026-10-30T15:18:00Z', f.write(NEW, 'b\n'));
	const before = mock(OLD, '2026-10-29T23:21Z');
	const swapped = mock(NEW, '2026-10-29T23:21Z');
	const reason = new RegExp(`it adds the source_refs ${NEW} \\(changed in ${changed.slice(0, 10)} at 2026-10-30T15:18Z\\), which changed after its last_verified 2026-10-29T23:21Z`);
	assert.deepEqual(pageWriteReasons(f.repo, MOCK, before, swapped), [], 'rule 6 never refuses');
	assert.match(pageWriteWarnings(f.repo, MOCK, before, swapped).join('\n'), reason);
	const page = f.page(MOCK, swapped);
	const lint = spawnSync(process.execPath, [LINT, '--ratchet-git', changed, page], { cwd: f.repo, env: f.env, encoding: 'utf8' });
	assert.equal(lint.status, 0, lint.stdout + lint.stderr);
	assert.match(lint.stdout, new RegExp(`page gate warning: apps/llm-wiki/content/${MOCK}: ${reason.source}`));
	const landed = at('2026-10-30T22:50:21Z', page);
	const printed = t.mock.method(process.stderr, 'write', () => true);
	assert.equal(pageStackRefusal(f.repo, changed, landed), null);
	assert.match(printed.mock.calls.map((call) => call.arguments[0]).join(''), reason);
	assert.deepEqual(pageWriteWarnings(f.repo, MOCK, before, mock(NEW, '2026-10-30T22:49Z'), `checked ${changed.slice(0, 10)}`), [], 'a recheck after the change passes');
	assert.deepEqual(pageWriteWarnings(f.repo, MOCK, swapped, swapped), [], 'a ref the page already cited is the stale report\'s');
	f.page(MOCK, before);
	const reverted = at('2026-10-30T22:51:00Z', page);
	f.page(MOCK, swapped);
	f.git('add', page);
	execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'take-in\n\nStaging-Merged: ' + base], {
		cwd: f.repo,
		env: f.env,
	});
	printed.mock.resetCalls();
	assert.equal(pageStackRefusal(f.repo, reverted, f.git('rev-parse', 'HEAD')), null);
	assert.equal(printed.mock.callCount(), 0, 'a take-in carries pages another branch wrote');
	printed.mock.restore();
	const OPS = 'apps/search/src/lib/charts/ticks.ts';
	at('2026-10-30T23:00:00Z', f.write(OPS, 'export function niceTicks() {\n\treturn 1;\n}\nexport const other = 1;\n'));
	f.page(MOCK, before);
	at('2026-10-30T23:01:00Z', page);
	const symbol = mock(`${OPS}::niceTicks`, '2026-10-30T23:05Z');
	at('2026-10-30T23:10:00Z', f.write(OPS, 'export function niceTicks() {\n\treturn 1;\n}\nexport const other = 2;\n'));
	assert.deepEqual(pageWriteWarnings(f.repo, MOCK, before, symbol), [], 'a change to other code in the file passes');
	const moved = at('2026-10-30T23:20:00Z', f.write(OPS, 'export function niceTicks() {\n\treturn 2;\n}\nexport const other = 2;\n'));
	at('2026-10-30T23:30:00Z', f.write(OPS, 'export function niceTicks() {\n\treturn 2;\n}\nexport const other = 3;\n'));
	assert.match(pageWriteWarnings(f.repo, MOCK, before, symbol).join('\n'), new RegExp(`::niceTicks \\(changed in ${moved.slice(0, 10)} at 2026-10-30T23:20Z\\)`));
});

// 2026-11-03: the page API took apps/search/campaigns.html v81 with source_refs on convex/search/campaigns/settledDrains.ts
// while that file sat untracked in the checkout, and the wiki dream precheck counted the page behind its code at once.
test('the page API refuses a ref to a file or definition only the checkout holds, and passes once the code commit lands', (t) => {
	const f = codeRepo();
	const pi = process.env.SIEUN_PI_REPO;
	process.env.SIEUN_PI_REPO = f.env.SIEUN_PI_REPO;
	t.after(() => {
		if (pi === undefined) delete process.env.SIEUN_PI_REPO;
		else process.env.SIEUN_PI_REPO = pi;
		rmSync(f.repo, { recursive: true, force: true });
	});
	const CAMPAIGNS = 'apps/search/campaigns.html';
	const DRAINS = 'convex/search/campaigns/settledDrains.ts';
	const MOVES = 'convex/search/campaigns/moves.ts';
	const campaigns = (refs) =>
		html({ title: 'Campaigns', description: 'd', last_verified: '2026-11-03T15:00Z', source_refs: refs }, '<p>Campaigns.</p>');
	const before = campaigns([MOVES]);
	f.commit(f.write(MOVES, 'export function applyMove() {\n\treturn 1;\n}\n'), f.page(CAMPAIGNS, before));
	f.write(DRAINS, 'export function drainSettledMoves() {\n\treturn 1;\n}\n');
	f.write(MOVES, 'export function applyMove() {\n\treturn 1;\n}\nexport function drainSettledJoins() {\n\treturn 1;\n}\n');
	const v81 = campaigns([MOVES, `${DRAINS}::drainSettledMoves`, `${MOVES}::drainSettledJoins`]);
	const [reason, ...rest] = pageWriteReasons(f.repo, CAMPAIGNS, before, v81);
	assert.deepEqual(rest, []);
	assert.match(
		reason,
		new RegExp(`it cites ${DRAINS}::drainSettledMoves, ${MOVES}::drainSettledJoins, which the checkout holds but its HEAD does not, so the file is not committed yet.*write the page after the code commit lands`),
	);
	assert.match(pageWriteReasons(f.repo, CAMPAIGNS, before, campaigns([MOVES, `${MOVES}::nowhere`]))[0], /::nowhere, which git does not have/);
	assert.deepEqual(pageWriteReasons(f.repo, CAMPAIGNS, v81, v81), [], 'a ref the page already had passes as before');
	f.commit(DRAINS, MOVES);
	assert.deepEqual(pageWriteReasons(f.repo, CAMPAIGNS, before, v81), [], 'the write passes once the code commit lands');
});

// 2026-10-20: a bare last_verified day cannot tell a second check on the same day from no check, so a check sets the UTC time.
test('a last_verified UTC time passes the last_verified rule, and a time in another form does not', () => {
	const verified = (lastVerified) => runbook({ last_verified: lastVerified });
	assert.deepEqual(pageWriteReasons('.', RUNBOOK, null, verified('2026-10-20T15:02Z')), []);
	assert.deepEqual(pageWriteReasons('.', RUNBOOK, null, verified(DAY)), []);
	assert.match(pageWriteReasons('.', RUNBOOK, null, verified('2026-10-20 15:02'))[0], /new page with no last_verified/);
});
