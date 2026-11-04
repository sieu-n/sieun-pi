/**
 * scripts/mermaid-check.mjs: the blocks a page holds, the parse with the mermaid the page ships, and the page API rule
 * that a write may not add a block that fails to parse while a block the page already held only warns.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mermaidBlocks, mermaidWriteCheck, parseMermaid } from '../scripts/mermaid-check.mjs';

const GOOD = 'flowchart TD\n  hash --> cmp{"label equals hash?"}\n  cmp -- yes --> keep';
// The break of apps/crawler-v3/architecture/docker-and-containers/index.html on 2026-11-04: the decision node lost its {" and "}.
const BROKEN = 'flowchart TD\n  hash --> cmplabel ai.virev.image-inputs<br/>equals hash?';
const page = (...blocks) => `<h1>T</h1>\n${blocks.map((b) => `<pre class="mermaid">\n${b}\n</pre>`).join('\n<p>x</p>\n')}\n`;

test('mermaidBlocks finds pre.mermaid and wiki-mermaid blocks with their lines, and skips comments and other pre', () => {
	const html = '<p>a</p>\n<pre class="mermaid">flowchart LR\n a --> b</pre>\n<pre>flowchart LR</pre>\n<!-- <pre class="mermaid">x</pre> -->\n<wiki-mermaid>pie\n "a": 1</wiki-mermaid>';
	assert.deepEqual(mermaidBlocks(html), [
		{ line: 2, raw: 'flowchart LR\n a --> b' },
		{ line: 6, raw: 'pie\n "a": 1' },
	]);
});

test('parseMermaid passes a good block, entity-escaped arrows and <br/>, and names the error of a broken one', async () => {
	const [good, escaped, broken] = await parseMermaid([GOOD, 'flowchart LR\n  a --&gt; b["x<br/>y &amp; z"]', BROKEN]);
	assert.equal(good, null);
	assert.equal(escaped, null);
	assert.match(broken, /Parse error on line 2/);
});

test('a write that adds a broken block is refused with its line and the parser error', async () => {
	const { reasons, warnings } = await mermaidWriteCheck(page(GOOD), page(GOOD, BROKEN));
	assert.equal(warnings.length, 0);
	assert.equal(reasons.length, 1);
	assert.match(reasons[0], /mermaid block at line 8 \("flowchart TD"\) does not parse: Parse error on line 2/);
});

test('a write that keeps a broken block the page held saves with a warning', async () => {
	const { reasons, warnings } = await mermaidWriteCheck(page(BROKEN), `${page(BROKEN)}<p>new line</p>\n`);
	assert.deepEqual(reasons, []);
	assert.equal(warnings.length, 1);
	assert.match(warnings[0], /held this block before the write, so it saved/);
});

test('a new page with only good blocks, or no block, passes', async () => {
	assert.deepEqual(await mermaidWriteCheck(null, page(GOOD)), { reasons: [], warnings: [] });
	assert.deepEqual(await mermaidWriteCheck(null, '<h1>T</h1>'), { reasons: [], warnings: [] });
});
