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
		{ line: 'At 14:38Z on 2026-11-08 that commit had not landed, so origin/staging still read cloud.', shas: ['9cf9e582c6'] },
		{ line: 'Both fixes were on dev/sieun and not yet on staging at 14:38Z.', shas: ['abc1234def'] },
		{ line: 'The pool of 6 comes from commit 73ca23e07f , which had not reached origin/staging at 14:38Z.', shas: ['73ca23e07f'] },
		{ line: 'It slept 20 seconds (dev/sieun 8b8a0797aa, not yet landed on staging at 14:44Z).', shas: ['8b8a0797aa'] },
		{ line: 'It had not landed on staging by 18:29Z, when the staging head was the land 7f655237dc .', shas: ['8b8a0797aa'] },
	]);
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

	const stale = addLandedClaims({ count: 0, stale: [] }, claims);
	assert.equal(stale.count, 1);
	assert.deepEqual(stale.stale[0].staleRefs[0], {
		ref: `landed:${a.slice(0, 10)} (${first.slice(0, 10)} land: dev/sieun ${a.slice(0, 9)}): "At 09:50Z on 2026-11-08 ${a.slice(0, 10)} was not on staging yet."`,
		modified: '2026-11-08T10:30:00.000Z',
	});
	assert.equal(landedRef(claims[1]), stale.stale[0].staleRefs[1].ref);
});
