/**
 * The page API's lint, secret scan and duplicate check run in a worker thread, so the server's thread keeps answering
 * reads while a write is checked (devbox-wiki-public-down at 15:56Z on 2026-11-13, during a wiki dream run).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { writeChecks } from '../scripts/write-checks.mjs';

const para = (i) => `<p>The crawler reads post ${i} and the watch row keeps its count for the next pass of the day.</p>`;
const PAGE = `<!--wiki {"title":"Checks","description":"write checks fixture"} -->\n<h1>Checks</h1>\n${Array.from({ length: 3000 }, (_, i) => para(i)).join('\n')}\n`;

test('the write checks answer from a worker while the calling thread keeps running', async () => {
	const root = mkdtempSync(path.join(tmpdir(), 'write-checks-'));
	const input = { root, rel: 'apps/demo/checks.html', before: null, after: PAGE };
	const worker = new Worker(new URL('../scripts/write-checks.mjs', import.meta.url));
	try {
		let ticks = 0;
		const timer = setInterval(() => ticks++, 1);
		const answer = await new Promise((resolve) => {
			worker.once('message', resolve);
			worker.postMessage({ id: 7, input });
		});
		clearInterval(timer);
		assert.equal(answer.id, 7);
		assert.ok(ticks > 0, 'the calling thread ran its timer while the worker checked the page');
		assert.deepEqual(answer.result.lint, writeChecks(input).lint);
		assert.deepEqual(answer.result.held, { value: { added: [], kept: [] } });
	} finally {
		await worker.terminate();
		rmSync(root, { recursive: true, force: true });
	}
});
