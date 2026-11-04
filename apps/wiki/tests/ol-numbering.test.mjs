// The page API numbers a curated page's top-level <ol> lists on in order (scripts/ol-numbering.mjs). On 2026-11-04 the wiki
// dream found 115 of 410 curated pages whose start= values broke, such as apps/crawler-v3/workers.html showing 58 twice.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { numberBreaks, renumberLists, topLists } from '../scripts/ol-numbering.mjs';

const lines = (n, word = 'Line') => Array.from({ length: n }, (_, i) => `<li>${word} ${i + 1}.</li>`).join('');

test('a list after an inserted line moves on, and a nested or table list keeps its own numbers', () => {
	const html =
		`<ol>${lines(3)}</ol><h2 id="b">B</h2><ol start="3"><li>Four <ol><li>nested</li></ol></li>${lines(1)}</ol>` +
		`<table><tr><td><ol start="9"><li>cell</li></ol></td></tr></table><ol start="7">${lines(2)}</ol>`;
	assert.deepEqual(numberBreaks(html), [[4, 3], [5, 7]]);
	const out = renumberLists(html);
	assert.equal(out.moved, 2);
	assert.deepEqual(numberBreaks(out.html), []);
	assert.deepEqual(
		topLists(out.html).map((l) => [l.start, l.count]),
		[[1, 3], [4, 2], [6, 2]],
	);
	assert.match(out.html, /<ol start="9"><li>cell/);
});

test('a page whose lists already run on is returned as it was', () => {
	const html = `<ol>${lines(2)}</ol><p>x</p><ol start="3">${lines(2)}</ol>`;
	assert.deepEqual(renumberLists(html), { html, moved: 0, ambiguous: [] });
});

test('an "item N" reference moves with its line, and code, tags and a hyphenated word stay as written', () => {
	const html =
		`<ol>${lines(2)}</ol><ol start="5"><li>As item 5 and items 2 to 5 say.</li></ol>` +
		`<p>See item 5, a zero-item 5 and <code>item 5</code>.</p><a title="item 5">x</a>`;
	const out = renumberLists(html);
	assert.equal(out.moved, 1);
	assert.match(out.html, /<ol start="3"><li>As item 3 and items 2 to 3 say/);
	assert.match(out.html, /See item 3, a zero-item 5 and <code>item 5<\/code>/);
	assert.match(out.html, /title="item 5"/);
});

test('an "item N" that two lines shared is ambiguous, and the page is left as it was', () => {
	const html = `<ol>${lines(2)}</ol><ol start="2">${lines(1)}</ol><p>As item 2 says.</p>`;
	assert.deepEqual(renumberLists(html), { html, moved: 0, ambiguous: [2] });
});
