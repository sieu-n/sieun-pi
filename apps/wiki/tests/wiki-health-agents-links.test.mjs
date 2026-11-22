import './no-wiki-config.mjs';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { deadLinksOf, engineReports, snapshotTree } from '../scripts/wiki-health.mjs';

const LOG = 'agents/blind-follow-x/jobs/2026/11/22/0016-adoption-page/index.html';
const DEEP = 'agents/blind-follow-x/jobs/2026/11/22/0016-adoption-page/notes.html';
const GONE = 'agents/blind-follow-x/jobs/2026/11/22/0017-gone/index.html';

function put(root, rel, text) {
	mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
	writeFileSync(path.join(root, rel), text);
}

// 2026-11-21: the d4 precheck read wiki_problems 1 for a link from projects/symphony-orchestration/adoption.html to a pi-host job
// log that answered 200, because the engine report runs with an empty agents/ mount.
test('a curated link into agents/ is dead only when the real agents mount lacks it, and a link past a job log is a session link', (t) => {
	const content = mkdtempSync(path.join(tmpdir(), 'wiki-health-content-'));
	const agents = mkdtempSync(path.join(tmpdir(), 'wiki-health-agents-'));
	const repo = mkdtempSync(path.join(tmpdir(), 'wiki-health-repo-'));
	t.after(() => [content, agents, repo].forEach((dir) => rmSync(dir, { recursive: true, force: true })));
	put(content, 'index.html', '<!--wiki {"title":"Home"}-->\n<h1>Home</h1>\n<a href="/page/projects/p.html">p</a>\n');
	const links = [LOG, DEEP, GONE].map((target) => `<a href="../${target}">x</a>`).join('\n');
	put(content, 'projects/p.html', `<!--wiki {"title":"P","description":"d","kind":"reference"}-->\n<h1>P</h1>\n${links}\n`);
	put(agents, LOG.slice('agents/'.length), '<h1>log</h1>\n');
	put(agents, DEEP.slice('agents/'.length), '<h1>notes</h1>\n');

	const root = snapshotTree(content, null);
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const git = (...args) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args]);
	git('init', '-q');
	git('commit', '-q', '--allow-empty', '-m', 'root');
	const { lint } = engineReports(root, repo);

	assert.deepEqual(lint.brokenLinks.map((f) => f.target).sort(), [LOG, DEEP, GONE].sort(), 'the snapshot report sees no agents/ mount');
	const dead = deadLinksOf(lint.brokenLinks, (p) => p === 'projects/p.html', agents);
	assert.deepEqual(dead.map((f) => f.target), [GONE]);
	assert.deepEqual(lint.sessionLinks.map((f) => f.target), [DEEP]);
});
