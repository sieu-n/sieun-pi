/**
 * The page API's lint, secret scan, duplicate check and page gate run in a worker thread, so the server's thread keeps
 * answering reads while a write is checked (devbox-wiki-public-down at 15:56Z on 2026-11-13, during a wiki dream run).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { writeChecks } from '../scripts/write-checks.mjs';
import { pageWriteReasons } from '../scripts/page-gate.mjs';

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
			worker.postMessage({ id: 7, task: 'checks', input });
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

test('the page gate of a write answers from the worker with the reasons the direct call gives', async () => {
	const page = '<!--wiki {"title":"Deploy runbook","description":"d","last_verified":"2026-10-20 15:02"}-->\n<h1>Deploy runbook</h1>\n';
	const input = { code: '.', rel: 'domains/devops/deploy-runbook.html', before: null, after: page };
	const worker = new Worker(new URL('../scripts/write-checks.mjs', import.meta.url));
	try {
		const ask = (id, task) =>
			new Promise((resolve) => {
				const on = (answer) => answer.id === id && (worker.off('message', on), resolve(answer));
				worker.on('message', on);
				worker.postMessage({ id, task, input });
			});
		const [reasons, warnings] = await Promise.all([ask(1, 'gateReasons'), ask(2, 'gateWarnings')]);
		assert.match(reasons.result[0], /new page with no last_verified/);
		assert.deepEqual(reasons.result, pageWriteReasons(input.code, input.rel, input.before, input.after));
		assert.deepEqual(warnings.result, []);
	} finally {
		await worker.terminate();
	}
});
