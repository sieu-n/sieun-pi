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

test('the same tutorial with no doc_kind passes too, because no page kind asks for numbered one-sentence lines', () => {
	const plain = tutorial.replace('"doc_kind": "tutorial", ', '');
	assert.deepEqual(errors(plain), []);
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
	assert.deepEqual(errors(page(null, drawn)), [], 'the same prose passes with no doc_kind');
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

test('an unknown doc_kind is refused, and a design page stays short', () => {
	assert.deepEqual(errors(page('howto', '<p>One line.</p>')), ['doc-kind']);
	const lines = (n) =>
		`<ol>${Array.from({ length: n }, (_, i) => `<li>The design keeps option ${i + 1} on the table.</li>`).join('')}</ol>\n<pre class="mermaid">flowchart LR\n  a --> b</pre>\n<pre class="mermaid">flowchart LR\n  c --> d</pre>\n`;
	assert.deepEqual(errors(page('design', lines(18))), []);
	const oneDiagram = (n) =>
		`<ol>${Array.from({ length: n }, (_, i) => `<li>The design keeps option ${i + 1} of the plan on the table for now.</li>`).join('')}</ol>\n<pre class="mermaid">flowchart LR\n  a --> b</pre>\n`;
	assert.deepEqual(errors(page('design', oneDiagram(20))), [], 'one diagram is enough at the design-length limit');
	assert.deepEqual(errors(page('design', oneDiagram(20).replace(/<pre[^]*<\/pre>/, ''))), ['visuals']);
	assert.deepEqual(errors(page(null, oneDiagram(20))), [], 'numbered lines no longer set the diagram count');
	assert.deepEqual(errors(page('design', lines(22))), [], 'a design page is cut by words, not by numbered lines');
	const long = Array.from({ length: 20 }, () => `<p>${para(4)}</p>`).join('\n');
	assert.deepEqual(errors(page('design', `${long}\n<pre class="mermaid">flowchart LR\n  a --> b</pre>\n`)), ['design-length']);
	assert.ok(errors(page('design', `<p>${para(4)} ${para(2)}</p>`)).includes('doc-paragraph'));
});

test('a page with no doc_kind gets the same paragraph rule as a documentation page', () => {
	assert.deepEqual(errors(page(null, `<p>${para(5)}</p>`)), ['doc-paragraph']);
	assert.deepEqual(errors(page(null, `<p>${para(4)}</p>`)), []);
});

/** Warning rule ids of a page at a wiki path. */
const warns = (html, path) => [
	...new Set(
		lintHtml(html, { now: NOW, path })
			.findings.filter((f) => f.severity === 'warn')
			.map((f) => f.rule),
	),
].sort();
const core = (rule, html, path) => warns(html, path).includes(rule);

// Owner, 2026-11-24 (#dev-crawler p23, c243): a page under apps/ or domains/ holds only the core a reader can check.
test('an apps/ or domains/ page over the size target gets a core-length warning, and a session page does not', () => {
	const body = Array.from({ length: 22 }, () => `<p>${para(4)}</p>`).join('\n');
	const table = '<table><tr><th>Key</th><th>Value</th></tr><tr><td>root</td><td>content</td></tr></table>\n';
	const drawn = `${body}\n${table}<pre class="mermaid">flowchart LR\n  a --> b</pre>\n`;
	assert.ok(core('core-length', page('reference', drawn), 'domains/devops/thing.html'));
	assert.ok(core('core-length', page(null, drawn), 'apps/search/thing.html'));
	assert.ok(!core('core-length', page(null, drawn), 'sessions/2026/11/24/0900-thing/thing.html'));
	assert.ok(!core('core-length', page('tutorial', drawn), 'domains/devops/thing.html'), 'a tutorial is as long as its steps');
	const short = `<p>${para(4)}</p>\n${table}`;
	assert.ok(!core('core-length', page('reference', short), 'domains/devops/thing.html'));
	assert.equal(errors(page('reference', drawn)).includes('core-length'), false, 'the length rule only warns (c98)');
});

test('an apps/ or domains/ page with no flow, table, field list or code gets a core-layers warning', () => {
	const prose = page('explanation', `<p>${para(3)}</p>\n<p>${para(2)}</p>`);
	assert.ok(core('core-layers', prose, 'domains/devops/thing.html'));
	assert.ok(!core('core-layers', prose, 'sessions/2026/11/24/0900-thing/thing.html'));
	const withTable = page('explanation', `<p>${para(3)}</p>\n<table><tr><td>chat.sqlite</td><td>posts</td></tr></table>`);
	assert.ok(!core('core-layers', withTable, 'domains/devops/thing.html'));
	const withFields = page('reference', `<p>${para(3)}</p>\n<dl><dt>path</dt><dd>The page path.</dd></dl>`);
	assert.ok(!core('core-layers', withFields, 'domains/devops/thing.html'));
	const hub = page(null, `<ul>${Array.from({ length: 6 }, (_, i) => `<li><a href="p${i}.html">Page ${i}</a></li>`).join('')}</ul>`);
	assert.ok(!core('core-layers', hub, 'domains/devops/index.html'), 'a hub of links is exempt');
});

test('a diagram that counts a few instances in one node, or a flat graph of many nodes, gets a diagram-shape warning', () => {
	const draw = (src) => page('explanation', `<p>${para(3)}</p>\n<pre class="mermaid">\n${src}\n</pre>\n`);
	const at = 'domains/devops/thing.html';
	assert.ok(core('diagram-shape', draw('flowchart LR\n  chat["chat server"] --> relays["relay x2"]'), at));
	assert.ok(core('diagram-shape', draw('flowchart LR\n  s["chat server"] --> t["3 tiers"]'), at));
	assert.ok(!core('diagram-shape', draw('flowchart LR\n  s["chat server"] --> r1["relay"]\n  s --> r2["relay"]'), at));
	assert.ok(!core('diagram-shape', draw('flowchart LR\n  s["scheduler"] --> w@{ shape: procs, label: "24 workers" }'), at), 'many instances may stack');
	const flat = Array.from({ length: 14 }, (_, i) => `  n${i}["step ${i}"] --> n${i + 1}["step ${i + 1}"]`).join('\n');
	assert.ok(core('diagram-shape', draw(`flowchart TD\n${flat}`), at));
	assert.ok(!core('diagram-shape', draw(`flowchart TD\n  subgraph box["us-metal02"]\n${flat}\n  end`), at));
	assert.ok(!core('diagram-shape', draw('sequenceDiagram\n  A->>B: 3 workers'), at), 'only flowcharts are read');
});
