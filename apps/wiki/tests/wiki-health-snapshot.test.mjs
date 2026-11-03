import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { engineReports, snapshotTree } from '../scripts/wiki-health.mjs';

// 2026-11-03: the pages left auto-sns-agent's git for ~/.pi/wiki/content, and the d4 precheck failed with "git archive exited 128:
// pathspec 'apps/llm-wiki/content' did not match any files". wiki-health now measures a copy of the content root on disk, which no
// git repo holds.
test('the health snapshot copies the curated pages of a content root in no git repo, without sessions or big files', (t) => {
	const content = mkdtempSync(path.join(tmpdir(), 'wiki-health-content-'));
	t.after(() => rmSync(content, { recursive: true, force: true }));
	const put = (rel, text) => {
		mkdirSync(path.dirname(path.join(content, rel)), { recursive: true });
		writeFileSync(path.join(content, rel), text);
	};
	put('index.html', '<!--wiki {"title":"Home"}-->\n<h1>Home</h1>\n<a href="/page/apps/a.html">a</a>\n');
	put('apps/a.html', '<!--wiki {"title":"A","description":"d","kind":"reference"}-->\n<h1>A</h1>\n');
	put('apps/llm-wiki/content/sessions/2026/10/18/x/requests.html', '<h1>stray</h1>\n');
	put('sessions/2026/11/03/0000-x/index.html', '<h1>log</h1>\n');
	put('experiments/e/data/big.json', 'x'.repeat(1_100_000));
	put('.wiki/wiki.db', 'db');
	const root = snapshotTree(content, null);
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const copy = path.join(root, 'apps/llm-wiki/content');
	assert.ok(existsSync(path.join(copy, 'apps/a.html')));
	assert.ok(existsSync(path.join(copy, 'index.html')));
	for (const gone of ['sessions', 'apps/llm-wiki/content/sessions', 'experiments/e/data/big.json', '.wiki']) assert.ok(!existsSync(path.join(copy, gone)), gone);
	const repo = mkdtempSync(path.join(tmpdir(), 'wiki-health-repo-'));
	t.after(() => rmSync(repo, { recursive: true, force: true }));
	const git = (...args) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args]);
	git('init', '-q');
	git('commit', '-q', '--allow-empty', '-m', 'root');
	const { lint } = engineReports(root, repo);
	assert.equal(lint.brokenLinks.length, 0);
	assert.equal(lint.pageCount, 2, 'the engine indexed the two curated pages of the copy and no session page');
});
