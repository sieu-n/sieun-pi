import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { sanitizeHtml } from '../src/lib/server/sanitize-html.mjs';

setFlagsFromString('--expose-gc');
const gc = runInNewContext('gc');

const row = '<tr><td>cell <b>bold</b></td><td><a href="/page/x">link</a></td><td>more text here</td></tr>';
const section = (i) => `<h2 id="section-${i}">Section ${i}</h2><p>${'Plain words in a paragraph. '.repeat(40)}</p><table><tbody>${row.repeat(12)}</tbody></table>`;
const page = Array.from({ length: 20 }, (_, i) => section(i)).join('');

async function settledHeap() {
	for (let i = 0; i < 3; i++) {
		gc();
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	return process.memoryUsage().heapUsed;
}

test('sanitizeHtml keeps heading ids and the target attribute and drops script', () => {
	const html = sanitizeHtml('<h2 id="a">A</h2><a href="https://x.dev" target="_blank">x</a><script>alert(1)</script>', ['target']);
	assert.equal(html, '<h2 id="a">A</h2><a href="https://x.dev" target="_blank">x</a>');
	assert.equal(sanitizeHtml('<a href="/p" target="_blank">p</a>'), '<a href="/p">p</a>');
});

test('sanitizeHtml frees each parsed page', async () => {
	sanitizeHtml(page);
	const before = await settledHeap();
	const calls = 30;
	for (let i = 0; i < calls; i++) sanitizeHtml(page);
	const perCallKb = (await settledHeap() - before) / 1024 / calls;
	// measured: on 2026-10-29 a 58 KB wiki page with 19 heading ids kept 5,410 KB per call in the shared window and 37 KB per call with a fresh one.
	assert.ok(perCallKb < 1024, `sanitizeHtml kept ${perCallKb.toFixed(0)} KB per call`);
});
