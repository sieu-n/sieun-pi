import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { assertFixtureRepo, fixtureGitEnv } from './test-git-env.mjs';
import { addLandedClaims, landedClaims, landedRef, notLandedLines, stagingLands } from '../scripts/wiki-health.mjs';

// 2026-11-09: the 01:19 dream run found 6 pages that said a commit had not landed on staging after a land carried it. The stale
// report dates refs on HEAD (dev/sieun), and a land on staging is a one-parent commit titled `land: dev/sieun <sha>`, so no report
// saw the land.
test('a sentence that pairs a commit with a not-landed phrase is a claim, and a rule about any commit is none', () => {
	const html = [
		'<!--wiki {"title":"T"}-->',
		'<ol>',
		'<li>Since <code>9cf9e582c6</code> on 2026-11-08, the staging target is <code>self-hosted</code>.</li>',
		'<li>At 14:38Z on 2026-11-08 that commit had not landed, so <code>origin/staging</code> still read cloud.</li>',
		'<li>Both <a href="https://github.com/sieu-n/auto-sns-agent/commit/abc1234def">fixes</a> were on dev/sieun and not yet on staging at 14:38Z.</li>',
		'<li>The pool of 6 comes from commit <code>73ca23e07f</code>, which had not reached origin/staging at 14:38Z.</li>',
		'<li>Since <code>8f36ca0cd</code> the promote refuses a sha whose crawler code is not on staging.</li>',
		'<li>The final harvest cancels every task that has not landed by then, as <code>5ae006bacc</code> set.</li>',
		'<li>A refusal names the commits that no staging land holds yet, since <code>e4b067b1d1</code>.</li>',
		'<li>On 11-08 <code>c0cac2b9d6</code> had not yet landed on main.</li>',
		'<li>It slept <wiki-cite src="https://github.com/sieu-n/auto-sns-agent/commit/8b8a0797aa" note="dev/sieun 8b8a0797aa, not yet landed on staging at 14:44Z">20 seconds</wiki-cite>.</li>',
		'<li>It had not landed on <code>staging</code> by 18:29Z, when the staging head was the land <code>7f655237dc</code>.</li>',
		'</ol>',
		'<pre class="mermaid">a -->|"swap 1a2b3c4d5e not on staging yet"| b</pre>',
	].join('\n');
	assert.deepEqual(notLandedLines(html), [
		{ line: 'At 14:38Z on 2026-11-08 that commit had not landed, so origin/staging still read cloud.', shas: ['9cf9e582c6'], stage: 'staging' },
		{ line: 'Both fixes were on dev/sieun and not yet on staging at 14:38Z.', shas: ['abc1234def'], stage: 'staging' },
		{ line: 'The pool of 6 comes from commit 73ca23e07f , which had not reached origin/staging at 14:38Z.', shas: ['73ca23e07f'], stage: 'staging' },
		{ line: 'On 11-08 c0cac2b9d6 had not yet landed on main.', shas: ['c0cac2b9d6'], stage: 'prod' },
		{ line: 'It slept 20 seconds (dev/sieun 8b8a0797aa, not yet landed on staging at 14:44Z).', shas: ['8b8a0797aa'], stage: 'staging' },
		{ line: 'It had not landed on staging by 18:29Z, when the staging head was the land 7f655237dc .', shas: ['8b8a0797aa'], stage: 'staging' },
	]);
});

// 2026-11-08 17:05Z: a dream writer found 3 lines on census-scheduling.html v13 that said a commit was not on staging or prod after a
// land carried it, and notLandedLines read none of them: "neither the staging nor the prod crawler ran", "reaches prod only with a full
// promote" under the line that names the commit, and a table cell "4, or up to 84 on dev/sieun" whose sha sits on a later line.
test('a commit on neither crawler, one that reaches prod only with a promote and a dev-branch value are claims', () => {
	const html = [
		'<!--wiki {"title":"Census scheduling"}-->',
		'<h2 id="leases">Leases</h2>',
		'<ol>',
		'<li>Since <code>8acb3c6307</code> at 06:29Z on 11-01, every settle ends its row\'s lease.</li>',
		'<li>The commit adds migration <code>0236_census_leases</code>, so it reaches prod only with a full promote.</li>',
		'<li>Since <code>b2d0bfffc5</code> a blob pushed from a dev/sieun commit reaches prod only after it lands on staging.</li>',
		'<li>When the control fails, the land marks dev/sieun only when the errors name a file it changed, as judgeSolos has done since <code>ee2466da11</code>.</li>',
		'</ol>',
		'<h2 id="lanes">Lanes</h2>',
		'<table><tbody>',
		'<tr><td><code>history</code></td><td>logged-out grid</td><td>4, or up to 84 on <code>dev/sieun</code></td><td>since <code>7537b8f69</code> 23 days</td></tr>',
		'</tbody></table>',
		'<ol>',
		'<li>Since <code>03c2d63a58</code> on <code>sieun/dev</code> at 12:40Z on 10-26, which neither the staging nor the prod crawler ran at 13:19Z, the cadence reads only the follower count.</li>',
		'<li>That commit was on <code>dev/sieun</code> and not yet on <code>staging</code> at 11:57Z that day.</li>',
		'<li>Since <code>42d3206e43</code> at 20:00Z on 10-29 on <code>dev/sieun</code>, one history job reads the whole walk, up to 84 pages of 12 posts.</li>',
		'</ol>',
		'<h2 id="other">Other</h2>',
		'<p>Some line names no commit.</p>',
		'<p>That commit was not on staging at 12:00Z.</p>',
		'<p>At 17:18Z on 2026-11-08 main did not hold that land, so <code>2b93c04fc8</code> had not reached prod.</p>',
	].join('\n');
	assert.deepEqual(notLandedLines(html), [
		{ line: 'The commit adds migration 0236_census_leases , so it reaches prod only with a full promote.', shas: ['8acb3c6307'], stage: 'prod' },
		{ line: '4, or up to 84 on dev/sieun', shas: ['42d3206e43'], stage: 'staging' },
		{
			line: 'Since 03c2d63a58 on sieun/dev at 12:40Z on 10-26, which neither the staging nor the prod crawler ran at 13:19Z, the cadence reads only the follower count.',
			shas: ['03c2d63a58'],
			stage: 'staging',
		},
		{ line: 'That commit was on dev/sieun and not yet on staging at 11:57Z that day.', shas: ['03c2d63a58'], stage: 'staging' },
		{ line: 'At 17:18Z on 2026-11-08 main did not hold that land, so 2b93c04fc8 had not reached prod.', shas: ['2b93c04fc8'], stage: 'prod' },
	]);
});

// 2026-11-09 10:30Z: the d4 precheck read "At 10:26Z on 2026-11-09 `8c1f60df87` had not landed, and the newest staging land
// `b0056d7fa9` carried `dev/sieun` `b6a5b7ad5`" on docker-and-containers.html as a not-landed claim about b6a5b7ad5, which that land
// carried. The subject of "had not landed" is 8c1f60df87, and b6a5b7ad5 sits in a later clause.
test('a not-landed phrase is about the sha before it in its clause, not one in a later clause', () => {
	const html = [
		'<ol>',
		'<li>At 10:26Z on 2026-11-09 <code>8c1f60df87</code> had not landed, and the newest staging land <code>b0056d7fa9</code> carried <code>dev/sieun</code> <code>b6a5b7ad5</code>.</li>',
		'<li>On 11-09 <code>b6a5b7ad5</code> landed at 09:21Z, but <code>8c1f60df87</code> was not on staging yet.</li>',
		'<li>Since <code>aa11bb22cc</code> the pool reads 6; it had not landed by 11:00Z, so <code>dd33ee44ff</code> still ran.</li>',
		'<li>Not yet on staging at 11:00Z were <code>ab12cd34ef</code> and <code>12ab34cd56</code>.</li>',
		'</ol>',
	].join('\n');
	assert.deepEqual(
		notLandedLines(html).map((l) => l.shas),
		[['8c1f60df87'], ['8c1f60df87'], ['aa11bb22cc'], ['ab12cd34ef', '12ab34cd56']],
	);
});

// 2026-11-09: notLandedLines dropped every block whose text opens on an inline tag, so it never read
// "<li><code>8c1f60df87</code> was not on staging yet.</li>".
test('a line that opens on a code tag or a commit link is read', () => {
	const html = [
		'<ol>',
		'<li><code>8c1f60df87</code> was not on staging yet at 10:30Z.</li>',
		'<li><a href="https://github.com/sieu-n/auto-sns-agent/commit/abc1234def"><code>abc1234def</code></a> had not landed at 10:30Z.</li>',
		'</ol>',
	].join('\n');
	assert.deepEqual(
		notLandedLines(html).map((l) => l.shas),
		[['8c1f60df87'], ['abc1234def']],
	);
});

test('a claim counts once a staging land names a dev tip that holds the commit, dated by the first such land', (t) => {
	const dir = mkdtempSync(path.join(tmpdir(), 'landed-claims-'));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const env = fixtureGitEnv(dir);
	const git = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: dir, env, encoding: 'utf8' }).trim();
	git('init', '-q', '-b', 'dev/sieun');
	assertFixtureRepo(dir, env);
	const commit = (message, when) => {
		execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', message], {
			cwd: dir,
			env: { ...env, GIT_COMMITTER_DATE: when, GIT_AUTHOR_DATE: when },
		});
		return git('rev-parse', 'HEAD');
	};
	const a = commit('a', '2026-11-08T10:00:00Z');
	const b = commit('b', '2026-11-08T11:00:00Z');
	const c = commit('c', '2026-11-08T12:00:00Z');
	git('checkout', '-q', '--orphan', 'staging');
	commit('staging root', '2026-11-08T09:00:00Z');
	const first = commit(`land: dev/sieun ${a.slice(0, 9)}`, '2026-11-08T10:30:00Z');
	const second = commit(`land: dev/sieun ${b.slice(0, 9)}, dev/sieun-mac 1234abcd5`, '2026-11-08T11:30:00Z');
	git('checkout', '-q', 'dev/sieun');

	const claim = (sha) => `<li>At 09:50Z on 2026-11-08 <code>${sha.slice(0, 10)}</code> was not on staging yet.</li>`;
	const pages = [
		{ path: 'apps/a.html', title: 'A', meta: { last_verified: '2026-11-08T09:50Z' }, html: `<ol>${claim(a)}${claim(b)}${claim(c)}</ol>` },
		{ path: 'experiments/x/index.html', meta: {}, html: claim(a) },
		{ path: 'apps/old.html', meta: { status: 'superseded' }, html: claim(a) },
	];
	const lands = stagingLands(dir, 'staging');
	assert.deepEqual(
		lands.map((land) => land.tips),
		[[{ branch: 'dev/sieun', tip: a.slice(0, 9) }], [{ branch: 'dev/sieun', tip: b.slice(0, 9) }, { branch: 'dev/sieun-mac', tip: '1234abcd5' }]],
	);
	const claims = landedClaims(pages, dir, lands);
	assert.deepEqual(
		claims.map((x) => [x.path, x.sha, x.land.commit, x.land.at]),
		[
			['apps/a.html', a.slice(0, 10), first, '2026-11-08T10:30:00.000Z'],
			['apps/a.html', b.slice(0, 10), second, '2026-11-08T11:30:00.000Z'],
		],
		'the commit no land carries and the experiment and retired pages are left out',
	);

	git('branch', 'main', first);
	const prod = (sha) => `<li>At 09:50Z on 2026-11-08 <code>${sha.slice(0, 10)}</code> was not on prod yet.</li>`;
	const promoted = landedClaims([{ path: 'apps/p.html', meta: {}, html: `<ol>${prod(a)}${prod(b)}</ol>` }], dir, lands, 'main');
	assert.deepEqual(
		promoted.map((x) => [x.sha, x.stage, x.land.commit]),
		[[a.slice(0, 10), 'prod', first]],
		'a prod line counts only once main holds the land that carried the commit',
	);
	assert.match(landedRef(promoted[0]), /, on main\): "/);

	const stale = addLandedClaims({ count: 0, stale: [] }, claims);
	assert.equal(stale.count, 1);
	assert.deepEqual(stale.stale[0].staleRefs[0], {
		ref: `landed:${a.slice(0, 10)} (${first.slice(0, 10)} land: dev/sieun ${a.slice(0, 9)}): "At 09:50Z on 2026-11-08 ${a.slice(0, 10)} was not on staging yet."`,
		modified: '2026-11-08T10:30:00.000Z',
	});
	assert.equal(landedRef(claims[1]), stale.stale[0].staleRefs[1].ref);
});
