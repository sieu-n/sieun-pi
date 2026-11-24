import './no-wiki-config.mjs';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { definitionCode } from '../src/lib/definitions.mjs';
import { followed, namedSubsections } from '../src/lib/stale-rules.mjs';
import { pageRepo } from './page-repo.mjs';
import { engineReports, snapshotTree } from '../scripts/wiki-health.mjs';

// 2026-11-24: auto-sns-agent 384298d8e5, f1792f19e0 and 19b0969bb5 changed only the "Grafana production read identity"
// and "Query MCP read layer" subsections under apps/infra/metal/README.md::Staging crawler containers, and each flagged
// the three pages citing that heading, whose 6 rechecks changed only `last_verified`. A heading ref now skips a
// subsection whose heading the page does not name, and keeps one it names, as apps/vent/index.html names "Test targets".
const readme = (staging, grafana, tests) =>
	[
		'# us-metal01',
		'',
		'## Staging crawler containers',
		'',
		`Staging runs the crawler in ${staging} containers.`,
		'',
		'### Grafana production read identity',
		'',
		`The datasource pool is bounded to ${grafana} connections.`,
		'',
		'#### Search users',
		'',
		'`search_ro` reads the search tables.',
		'',
		'### Test targets',
		'',
		`A test call goes to the fake's \`.mock\` host ${tests}.`,
		'',
		'## Kafka',
		'',
		'One broker.',
		'',
	].join('\n');
const ref = 'README.md::Staging crawler containers';
const section = (staging, grafana, tests) => definitionCode(readme(staging, grafana, tests), 'Staging crawler containers', 'README.md');

test('a heading ref skips each subsection whose heading the page does not name', () => {
	const page = '<!--wiki {"source_refs":["README.md::Staging crawler containers"]}-->\n<p>Staging runs two containers.</p>';
	assert.equal(
		namedSubsections(page, section('two', 'two', 'at once')),
		'## Staging crawler containers\n\nStaging runs the crawler in two containers.\n',
		'the cited heading in the frontmatter names no subsection',
	);
	const named = '<p>Under <em>Test   Targets</em> a call goes to the <code>.mock</code> host.</p>';
	assert.match(namedSubsections(named, section('two', 'two', 'at once')) ?? '', /### Test targets\n\nA test call goes/);
	assert.doesNotMatch(namedSubsections(named, section('two', 'two', 'at once')) ?? '', /Grafana|search_ro/);
	const nested = '<p>The grafana production read identity has search users.</p>';
	assert.match(namedSubsections(nested, section('two', 'two', 'at once')) ?? '', /#### Search users/, 'a named subsection judges its own subsections');
	assert.equal(namedSubsections(page, null), null);
	const follow = followed(page, section('two', 'two', 'at once'));
	assert.equal(follow(section('two', 'ten', 'later')), follow(section('two', 'two', 'at once')), 'a subsection edit is no change');
	assert.notEqual(follow(section('three', 'two', 'at once')), follow(section('two', 'two', 'at once')), 'an edit of its own body is');
});

test('a page citing a Markdown heading is behind only an edit of the parts it names', (t) => {
	const repo = pageRepo(t, 'stale-md-subsections-');
	repo.write('apps/llm-wiki/content/index.html', '<h1>Home</h1>\n');
	repo.write('README.md', readme('two', 'two', 'at once'));
	repo.page('containers.html', [ref], { body: '<p>Staging runs two crawler containers.</p>' });
	repo.page('vent.html', [ref], { body: '<p>The Test targets rules send a test call to the fake.</p>' });
	repo.init();
	repo.commit('2026-10-20T01:00:00Z', 'pages');
	repo.write('README.md', readme('two', 'ten', 'at once'));
	repo.commit('2026-10-20T04:00:00Z', 'grafana subsection changes');
	repo.write('README.md', readme('two', 'ten', 'later'));
	repo.commit('2026-10-20T05:00:00Z', 'test targets subsection changes');

	const root = snapshotTree(path.join(repo.dir, 'apps/llm-wiki/content'), repo.dir);
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const rows = Object.fromEntries(engineReports(root, repo.dir).stale.stale.map((row) => [row.path, row.staleRefs]));
	assert.equal(rows['apps/containers.html'], undefined, 'no edit touched the section body the page states');
	assert.deepEqual(rows['apps/vent.html'], [{ ref, modified: '2026-10-20T05:00:00.000Z', since: '2026-10-20T05:00:00.000Z' }]);
});
