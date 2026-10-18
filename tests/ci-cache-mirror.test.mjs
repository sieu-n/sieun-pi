import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const MIRROR = path.join(path.dirname(fileURLToPath(import.meta.url)), '../deploy/mac/ci-cache-mirror.mjs');

function once(source, dir) {
	execFileSync(process.execPath, [MIRROR, '--once'], { env: { ...process.env, CI_CACHE_SOURCE: source, CI_CACHE_DIR: dir }, stdio: 'pipe' });
}

test('ci-cache-mirror copies the box cache with rsync, follows changes and drops stamps the box dropped', () => {
	const root = mkdtempSync(path.join(tmpdir(), 'ci-mirror-'));
	const box = path.join(root, 'box');
	const mac = path.join(root, 'mac');
	mkdirSync(path.join(box, 'ci-runs.d'), { recursive: true });
	mkdirSync(path.join(mac, 'ci-runs.d'), { recursive: true });
	writeFileSync(path.join(box, 'ci-runs.json'), JSON.stringify({ runs: [1, 2] }));
	writeFileSync(path.join(box, 'ci-cache.log'), 'one\n');
	writeFileSync(path.join(box, 'ci-cache.heartbeat.json'), '{"at":1}');
	writeFileSync(path.join(box, 'ci-runs.d', '1.stamp'), 'a');
	writeFileSync(path.join(box, 'unrelated.json'), 'x');
	writeFileSync(path.join(mac, 'ci-runs.d', '9.stamp'), 'old');
	try {
		once(box, mac);
		assert.equal(readFileSync(path.join(mac, 'ci-runs.json'), 'utf8'), JSON.stringify({ runs: [1, 2] }));
		assert.equal(readFileSync(path.join(mac, 'ci-runs.d', '1.stamp'), 'utf8'), 'a');
		assert.deepEqual(readdirSync(path.join(mac, 'ci-runs.d')).sort(), ['1.stamp']);
		assert.ok(Math.abs(statSync(path.join(mac, 'ci-runs.json')).mtimeMs - statSync(path.join(box, 'ci-runs.json')).mtimeMs) < 1);
		assert.throws(() => statSync(path.join(mac, 'unrelated.json')));

		writeFileSync(path.join(box, 'ci-runs.json'), JSON.stringify({ runs: [1, 2, 3] }));
		utimesSync(path.join(box, 'ci-runs.json'), new Date(), new Date(Date.now() + 5000));
		writeFileSync(path.join(box, 'ci-cache.log'), 'one\ntwo\n');
		rmSync(path.join(box, 'ci-runs.d', '1.stamp'));
		writeFileSync(path.join(box, 'ci-runs.d', '2.stamp'), 'b');
		mkdirSync(path.join(mac, 'ci-wants'));
		writeFileSync(path.join(mac, 'ci-wants', '42'), '');
		once(box, mac);
		assert.equal(readFileSync(path.join(mac, 'ci-runs.json'), 'utf8'), JSON.stringify({ runs: [1, 2, 3] }));
		assert.equal(readFileSync(path.join(mac, 'ci-cache.log'), 'utf8'), 'one\ntwo\n');
		assert.deepEqual(readdirSync(path.join(mac, 'ci-runs.d')).sort(), ['2.stamp']);
		assert.deepEqual(readdirSync(path.join(box, 'ci-wants')), ['42']);
		assert.deepEqual(readdirSync(path.join(mac, 'ci-wants')), []);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
