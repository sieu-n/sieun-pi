/** Documentation pages (doc_kind start, tutorial, how-to, reference, explanation) read as prose and keep the unslop rules. */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { lintHtml, ratchet } from '../src/lib/prose-lint.mjs';

const tutorial = readFileSync(fileURLToPath(new URL('fixtures/prose-lint/good-tutorial.html', import.meta.url)), 'utf8');
const NOW = Date.UTC(2026, 10, 23, 15, 0);
/** Error rule ids of a page, sorted and unique. */
const errors = (html) => [
	...new Set(
		lintHtml(html, { now: NOW })
			.findings.filter((f) => f.severity === 'error')
			.map((f) => f.rule),
	),
].sort();
/** A page with a header of the given doc_kind (none when null) and a body. */
const page = (docKind, body, title = 'Thing') =>
	`<!--wiki\n${JSON.stringify({ title, kind: docKind ?? 'reference', ...(docKind ? { doc_kind: docKind } : {}), date: '2026-11-23' })}\n-->\n<h1>${title}</h1>\n${body}`;
const para = (n) =>
	Array.from({ length: n }, (_, i) => `The wiki engine writes page ${i + 1} to the content root.`).join(' ');

test('the tutorial fixture, in paragraphs and steps with commands and output, has zero findings', () => {
	const { findings } = lintHtml(tutorial, { now: NOW });
	assert.deepEqual(findings, []);
});

test('the same tutorial with no doc_kind falls back to the numbered-line rules', () => {
	const mer = tutorial.replace('"doc_kind": "tutorial", ', '');
	assert.ok(errors(mer).includes('bullet-one-sentence'), errors(mer).join(', '));
});

test('a tutorial step with no code block or image, and a missing section, are refused', () => {
	const noProof = tutorial.replace(/<pre><code>sed -n 12p draft.html<\/code><\/pre>/, '');
	assert.deepEqual(errors(noProof), ['doc-step-proof']);
	const noCheck = tutorial.replace(/<h2 id="check-it-worked">[\s\S]*?(?=<h2 id="when)/, '');
	assert.deepEqual(errors(noCheck), ['doc-sections']);
	const proseCheck = tutorial.replace(/<pre><code>node apps\/wiki\/scripts\/prose-lint.mjs draft.html; echo \$\?\n0<\/code><\/pre>/, '');
	assert.deepEqual(errors(proseCheck), ['doc-sections']);
	assert.equal(ratchet(tutorial, noProof, { now: NOW }).ok, false, 'the page API refuses the write');
});

test('a documentation page opens with an intro paragraph, never a wiki-tldr', () => {
	const tldr = tutorial.replace(/<p>This tutorial is for[^]*?<\/p>/, '<wiki-tldr>What. A lint tutorial.</wiki-tldr>');
	assert.deepEqual(errors(tldr), ['doc-intro']);
});

test('a documentation page still gets the unslop rules', () => {
	const body = (p) => page('explanation', `<p>${p}</p>\n`);
	assert.deepEqual(errors(body(para(5))), ['doc-paragraph']);
	assert.deepEqual(errors(body(para(4))), []);
	assert.deepEqual(errors(body('The engine writes the page \u2014 then commits it.')), ['em-dash']);
	assert.deepEqual(errors(body('Owner: the wiki team runs the engine.')), ['label-opener']);
	assert.deepEqual(errors(body('The engine will leverage the content root.')).length, 1);
	assert.deepEqual(errors(body('\uc5d4\uc9c4\uc774 \ud398\uc774\uc9c0\ub97c \uc501\ub2c8\ub2e4.')), ['english-only']);
	assert.deepEqual(errors(body('The engine was removed on 2026-11-25.')), ['future-utc-time']);
	assert.deepEqual(errors(page('reference', '<p>The engine writes pages.</p><ul><li>engine</li></ul>')), ['bullet-fragment']);
});

test('an explanation over 300 words needs a diagram, and prose paragraphs pass there', () => {
	const body = Array.from({ length: 8 }, () => `<p>${para(4)}</p>`).join('\n');
	assert.deepEqual(errors(page('explanation', body)), ['doc-diagram']);
	const drawn = `${body}\n<pre class="mermaid">flowchart LR\n  a --> b</pre>\n`;
	assert.deepEqual(errors(page('explanation', drawn)), []);
	assert.ok(errors(page(null, drawn)).includes('paragraph-share'), 'the same prose fails as a numbered-line page');
});

test('a reference page may be mostly tables', () => {
	const rows = Array.from({ length: 30 }, (_, i) => `<tr><td>key_${i}</td><td>The value the engine reads at start</td></tr>`).join('');
	const body = `<p>This page lists every key in the wiki config file.</p>\n<table>${rows}</table>\n`;
	assert.deepEqual(errors(page('reference', body)), []);
	assert.ok(errors(page(null, body)).includes('table-share'));
});

test('a start page needs a Start here section', () => {
	const intro = '<p>This space is for the owner, who wants to run and change sw factory.</p>\n';
	assert.deepEqual(errors(page('start', intro)), ['doc-sections']);
	assert.deepEqual(errors(page('start', `${intro}<h2 id="start-here">Start here</h2>\n<p>Read the three pages below first.</p>\n`)), []);
});

test('an unknown doc_kind is refused, and a design page keeps the short numbered form', () => {
	assert.deepEqual(errors(page('howto', '<p>One line.</p>')), ['doc-kind']);
	const lines = (n) =>
		`<ol>${Array.from({ length: n }, (_, i) => `<li>The design keeps option ${i + 1} on the table.</li>`).join('')}</ol>\n<pre class="mermaid">flowchart LR\n  a --> b</pre>\n<pre class="mermaid">flowchart LR\n  c --> d</pre>\n`;
	assert.deepEqual(errors(page('design', lines(18))), []);
	assert.deepEqual(errors(page('design', lines(22))), ['design-length']);
	assert.ok(errors(page('design', `<p>${para(4)} ${para(2)}</p>`)).includes('paragraph-blob'));
});

test('a page whose older kind field says reference, with no doc_kind, keeps the numbered-line rules', () => {
	assert.ok(errors(page(null, `<p>${para(5)}</p>`)).includes('paragraph-blob'));
});
