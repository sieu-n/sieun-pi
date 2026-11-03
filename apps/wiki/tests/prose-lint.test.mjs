/** Prose lint fails drafts the owner rejected and passes the 메르-style page he accepted and a short one like it. */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { lintHtml, parsePage, ratchet } from '../src/lib/prose-lint.mjs';

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
