import path from 'node:path';
import { Worker } from 'node:worker_threads';
import type { WriteTasks } from '../../../scripts/write-checks.mjs';

/**
 * One worker thread (scripts/write-checks.mjs, whose header has the measurements) for the CPU and git work of a page
 * write, so the server's thread keeps answering while a write is checked.
 */
let worker: Worker | null = null;
let nextId = 0;
const pending = new Map<number, { resolve: (value: never) => void; reject: (error: Error) => void }>();

function writeWorker(): Worker {
	if (worker) return worker;
	// The worker's modules are plain .mjs, and a parent's --input-type (a test's `node --input-type=module -e`) makes a
	// worker file fail to load, so it takes none of the parent's flags.
	const started = new Worker(path.resolve(process.cwd(), 'scripts/write-checks.mjs'), { execArgv: [] });
	started.unref();
	started.on('message', ({ id, result, error }: { id: number; result?: never; error?: string }) => {
		const waiting = pending.get(id);
		pending.delete(id);
		if (error !== undefined) waiting?.reject(new Error(error));
		else waiting?.resolve(result as never);
	});
	const fail = (error: Error) => {
		if (worker === started) worker = null;
		for (const waiting of pending.values()) waiting.reject(error);
		pending.clear();
	};
	started.on('error', fail);
	started.on('exit', (code) => fail(new Error(`the write checks worker exited with ${code}`)));
	worker = started;
	return started;
}

/** Run one write task in the worker and answer its result; a throw in the task rejects with its stack. */
export function inWriteWorker<K extends keyof WriteTasks>(task: K, input: WriteTasks[K]['input']): Promise<WriteTasks[K]['output']> {
	const id = nextId++;
	return new Promise((resolve, reject) => {
		pending.set(id, { resolve: resolve as (value: never) => void, reject });
		writeWorker().postMessage({ id, task, input });
	});
}
