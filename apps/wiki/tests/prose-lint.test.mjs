/** Prose lint fails drafts the owner rejected and passes the 메르-style page he accepted and a short one like it. */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { lintHtml, parsePage, ratchet, savedLintAnswer } from '../src/lib/prose-lint.mjs';

const fixture = (name) => readFileSync(fileURLToPath(new URL(`fixtures/prose-lint/${name}`, import.meta.url)), 'utf8');
/** Error rule ids for a snippet. */
const errors = (html) =>
	lintHtml(html)
		.findings.filter((f) => f.severity === 'error')
		.map((f) => f.rule);

test('the rejected gateway-v2 draft fails on structure rules', () => {
	const { counts } = lintHtml(fixture('bad-gateway-v2.html'));
	const ids = Object.keys(counts.byRule).filter((id) => counts.byRule[id].errors > 0);
	assert.ok(ids.includes('em-dash') || ids.includes('label-opener'), ids.join(', '));
	for (const id of ['bullet-one-sentence', 'bold-overuse', 'table-wall'])
		assert.ok(ids.includes(id), `${id} missing: ${ids.join(', ')}`);
	assert.ok(counts.errors >= 20, `only ${counts.errors} errors`);
});

test('the rejected prose-paragraph gateway-v2 rewrite fails on paragraph rules', () => {
	const { counts } = lintHtml(fixture('bad-gateway-v2-prose.html'));
	assert.ok(counts.byRule['paragraph-share']?.errors === 1, JSON.stringify(counts.byRule));
	assert.ok((counts.byRule['paragraph-blob']?.errors ?? 0) >= 3, JSON.stringify(counts.byRule));
	assert.ok(counts.byRule.visuals?.errors === 1, JSON.stringify(counts.byRule));
});

test('a prose wall with no diagram fails on paragraphs and visuals', () => {
	const ids = errors(fixture('bad-prose-wall-no-diagram.html'));
	for (const id of ['paragraph-share', 'paragraph-blob', 'visuals'])
		assert.ok(ids.includes(id), `${id} missing: ${ids}`);
});

test('the accepted 메르-style gateway-v2 page passes with zero findings', () => {
	const html = fixture('good-gateway-v2-mer.html');
	const page = parsePage(html);
	assert.ok(page.units.filter((u) => u.numbered).length >= 100, 'about 112 numbered lines');
	assert.ok(page.visuals.length >= 10, 'about 13 diagrams and images');
	const { findings, counts } = lintHtml(html);
	assert.equal(counts.errors + counts.warns, 0, JSON.stringify(findings, null, 2));
});

test('the good numbered-line fixture has zero findings', () => {
	const { findings, counts } = lintHtml(fixture('good-mer.html'));
	assert.equal(counts.errors + counts.warns, 0, JSON.stringify(findings, null, 2));
});

// A page written at 15:30Z with the owner's KST day as its date sat out of git for 7 batch runs (2026-10-28).
const WRITE = Date.UTC(2026, 9, 28, 15, 30);
const page = (updated, line) =>
	`<!--wiki\n{"title": "LinkedIn fields", "date": "2026-10-18", "updated": "${updated}", "status": "current"}\n-->\n` +
	`<h1>LinkedIn fields</h1>\n<ol>\n\t<li>${line}</li>\n</ol>\n`;
const dbaf = page('2026-10-29', 'Convex stores no LinkedIn field, because the rule tag code that read post images was removed on 2026-10-29.');
const lintAt = (html) =>
	lintHtml(html, { now: WRITE })
		.findings.filter((f) => f.severity === 'error' && f.rule.startsWith('future-'))
		.map((f) => f.rule);

test('a header date or a past event dated after the UTC write day is refused, as dbaf9ad972 wrote them', () => {
	assert.deepEqual(lintAt(dbaf).sort(), ['future-meta-date', 'future-utc-time']);
	assert.deepEqual(lintAt(page('2026-10-28T15:41Z', 'The tag code was removed on 2026-10-28.')), ['future-meta-date']);
	assert.deepEqual(lintAt(page('2026-10-28', 'On 10-29 the job landed the cut.')), ['future-utc-time']);
});

test('the UTC day, a past event on it and a plan day with no past verb pass', () => {
	assert.deepEqual(lintAt(page('2026-10-28T15:30Z', 'The tag code was removed on 2026-10-28.')), []);
	assert.deepEqual(lintAt(page('2026-10-28', 'The ignore expires on 2026-11-30, and the review is scheduled on 11-02.')), []);
	const nextDay = lintHtml(dbaf, { now: Date.UTC(2026, 9, 29, 0, 5) }).findings.filter((f) => f.rule.startsWith('future-'));
	assert.deepEqual(nextDay, [], 'the same text passes once the UTC day reaches it');
});

test('the page API ratchet refuses a write that adds a future date and keeps a page that already held one editable', () => {
	const clean = page('2026-10-28', 'The tag code was removed on 2026-10-28.');
	const added = ratchet(clean, dbaf, { now: WRITE });
	assert.equal(added.ok, false);
	assert.deepEqual(Object.keys(added.grown).sort(), ['future-meta-date', 'future-utc-time']);
	assert.equal(ratchet(dbaf, dbaf.replace('LinkedIn field,', 'LinkedIn field itself,'), { now: WRITE }).ok, true);
});

// On 2026-11-04 32 wiki dream writers ran `prose-lint.mjs apps/search/campaigns.html` and got "no such file", because the
// CLI looked under the checkout instead of the content root.
test('the CLI lints a page by wiki path and --recent from the content root', () => {
	const root = mkdtempSync(path.join(tmpdir(), 'prose-lint-root-'));
	const elsewhere = mkdtempSync(path.join(tmpdir(), 'prose-lint-cwd-'));
	try {
		const bad = '<!--wiki\n{"title": "Campaigns"}\n-->\n<h1>Campaigns</h1>\n<p>The page lists campaigns \u2014 one per row.</p>\n';
		mkdirSync(path.join(root, 'apps/search'), { recursive: true });
		writeFileSync(path.join(root, 'apps/search/campaigns.html'), bad);
		mkdirSync(path.join(root, 'sessions/2026/11/04/0509-dream'), { recursive: true });
		writeFileSync(path.join(root, 'sessions/2026/11/04/0509-dream/notes.html'), bad);
		const cli = fileURLToPath(new URL('../scripts/prose-lint.mjs', import.meta.url));
		const run = (...args) =>
			spawnSync(process.execPath, [cli, '--json', ...args], {
				cwd: elsewhere,
				encoding: 'utf8',
				env: { ...process.env, WIKI_CONTENT_ROOT: root, WIKI_CONFIG: path.join(elsewhere, 'none.json') },
			});
		for (const args of [['apps/search/campaigns.html'], ['--recent', '5']]) {
			const out = run(...args);
			assert.equal(out.status, 1, out.stderr);
			const { results } = JSON.parse(out.stdout);
			assert.equal(results.length, 1, out.stdout);
			assert.ok(results[0].counts.byRule['em-dash']?.errors >= 1, JSON.stringify(results[0].counts));
		}
		assert.equal(run('apps/search/missing.html').status, 2);
	} finally {
		rmSync(root, { recursive: true, force: true });
		rmSync(elsewhere, { recursive: true, force: true });
	}
});

test('a write the ratchet lets through answers with the warnings it kept, so the writer fixes them without a lint run', () => {
	// On 2026-11-04 wiki-dream writers made 10 extra revisions in 7 days by linting after a 201 that named no warning.
	const long = Array.from({ length: 40 }, (_, i) => `word${i}`).join(' ');
	const html = `<!--wiki {"title":"Lint answer fixture","description":"lint answer fixture"} -->\n<h1>Lint answer fixture</h1>\n<p>The engine saves the page. It then answers with ${long} at the end.</p>\n`;
	const result = ratchet(null, html);
	assert.equal(result.ok, true, JSON.stringify(result.grown));
	const answer = savedLintAnswer(result.findings);
	assert.ok(answer, 'a page with a warning gets a lint answer');
	assert.deepEqual(
		answer.lint.map((f) => [f.rule, f.severity, f.line]),
		[['long-sentence', 'warn', 3]],
	);
	assert.match(answer.lint[0].fix, /Split any sentence/);
	assert.match(answer.warning, /saved with 1 finding\(s\) \(long-sentence 1\)/);
	assert.equal(savedLintAnswer(ratchet(null, html.replace(` ${long}`, '')).findings), null, 'a clean page gets none');
});
