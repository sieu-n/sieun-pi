import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

const scripts = resolve('scripts');

async function python(root, code) {
	const { stdout } = await promisify(execFile)('uv', ['run', '--no-project', '--with', 'duckdb', 'python', '-c', code], {
		env: { ...process.env, WIKI_CONTENT_ROOT: root, PYTHONPATH: scripts },
	});
	return JSON.parse(stdout);
}

const RECORD = `
import json, multiprocessing as mp, time
import run_history as rh

def record(loaded, run_id, first):
    if first:
        load = rh.load_runs
        def slow_load(*args):
            runs = load(*args)
            loaded.set()
            time.sleep(1)
            return runs
        rh.load_runs = slow_load
    else:
        loaded.wait()
    rh.record_run({"component": "email-finder", "run_id": run_id, "kind": "benchmark",
                   "started_at": "2026-11-08T22:01:53Z", "source": "test", "commit": None})

ids = IDS
loaded = mp.Event()
if len(ids) == 1: loaded.set()
procs = [mp.Process(target=record, args=(loaded, run_id, i == 0 and len(ids) > 1)) for i, run_id in enumerate(ids)]
for p in procs: p.start()
for p in procs: p.join()
print(json.dumps([p.exitcode for p in procs]))
`;
const EXPORT = 'import json, run_history as rh; print(json.dumps(rh.export("email-finder")))';

const leftovers = (root) => readdirSync(join(root, '.wiki')).filter((name) => name.includes('.tmp'));

test('a run written while another build runs still lands in the store', async (t) => {
	const root = mkdtempSync(join(tmpdir(), 'run-history-'));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const ids = Array.from({ length: 3 }, (_, i) => `parallel-${i}`);
	assert.deepEqual(await python(root, RECORD.replace('IDS', JSON.stringify(ids))), ids.map(() => 0));
	const { runs } = await python(root, EXPORT);
	assert.deepEqual(runs.map((r) => r.run_id).sort(), ids);
	assert.deepEqual(leftovers(root), []);
});

test('a build removes the temp stores a killed build left behind', async (t) => {
	const root = mkdtempSync(join(tmpdir(), 'run-history-'));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	mkdirSync(join(root, '.wiki'));
	for (const name of ['.run-history.duckdb.4242.tmp', '.run-history.duckdb.4242.tmp.wal', '.run-history.duckdb.x9k2.tmp']) {
		writeFileSync(join(root, '.wiki', name), 'partial');
	}
	assert.deepEqual(await python(root, RECORD.replace('IDS', '["after-kill"]')), [0]);
	assert.deepEqual(leftovers(root), []);
	const { runs } = await python(root, EXPORT);
	assert.deepEqual(runs.map((r) => r.run_id), ['after-kill']);
});
