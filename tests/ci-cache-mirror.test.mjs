import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { createServer, connect } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIRROR = path.join(HERE, '../deploy/mac/ci-cache-mirror.mjs');
const RSYNCD_CONF = path.join(HERE, '../deploy/linux/ci-cache-rsyncd.conf');

function once(source, dir, home = path.dirname(dir)) {
	execFileSync(process.execPath, [MIRROR, '--once'], { env: { ...process.env, HOME: home, CI_CACHE_SOURCE: source, CI_CACHE_DIR: dir }, stdio: 'pipe' });
}

const freePort = () =>
	new Promise((resolve) => {
		const server = createServer().listen(0, '127.0.0.1', () => {
			const { port } = server.address();
			server.close(() => resolve(port));
		});
	});

const accepts = (port) =>
	new Promise((resolve) => {
		const socket = connect(port, '127.0.0.1');
		socket.once('connect', () => resolve(socket.end() && true));
		socket.once('error', () => resolve(false));
	});

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
	writeFileSync(path.join(box, 'push-reds.json'), '{"reds":[]}');
	writeFileSync(path.join(mac, 'ci-runs.d', '9.stamp'), 'old');
	try {
		once(box, mac);
		assert.equal(readFileSync(path.join(mac, 'ci-runs.json'), 'utf8'), JSON.stringify({ runs: [1, 2] }));
		assert.equal(readFileSync(path.join(mac, 'ci-runs.d', '1.stamp'), 'utf8'), 'a');
		assert.deepEqual(readdirSync(path.join(mac, 'ci-runs.d')).sort(), ['1.stamp']);
		assert.ok(Math.abs(statSync(path.join(mac, 'ci-runs.json')).mtimeMs - statSync(path.join(box, 'ci-runs.json')).mtimeMs) < 1);
		assert.throws(() => statSync(path.join(mac, 'unrelated.json')));
		assert.equal(readFileSync(path.join(mac, 'push-reds.json'), 'utf8'), '{"reds":[]}', 'a Mac session reads the crawler reds of its commits');

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

test('ci-cache-mirror pulls through the box rsync daemon config with no ssh, hands wants to its ci-wants module and mirrors the chat host bridge file (11-03 session scopes)', async () => {
	const root = mkdtempSync(path.join(tmpdir(), 'ci-mirror-d-'));
	const boxHome = path.join(root, 'box');
	const box = path.join(boxHome, '.cache/virev');
	const macHome = path.join(root, 'mac');
	const mac = path.join(macHome, '.cache/virev');
	mkdirSync(path.join(box, 'ci-runs.d'), { recursive: true });
	mkdirSync(path.join(box, 'ci-wants'), { recursive: true });
	mkdirSync(path.join(mac, 'ci-wants'), { recursive: true });
	mkdirSync(path.join(macHome, '.config/sieun-pi'), { recursive: true });
	writeFileSync(path.join(macHome, '.config/sieun-pi/hosts.json'), JSON.stringify({ hosts: [{ name: 'us-metal02', address: '127.0.0.1', roles: { chat: {} } }] }));
	writeFileSync(path.join(box, 'ci-runs.json'), '{"runs":[7]}');
	writeFileSync(path.join(box, 'alert-bridge-status.json'), '{"ts":"2026-11-03T03:25:07.811Z"}');
	writeFileSync(path.join(box, 'ci-runs.d', '7.stamp'), 's');
	writeFileSync(path.join(mac, 'ci-wants', '99'), '');
	const port = await freePort();
	const rsyncd = spawn('rsync', ['--daemon', '--no-detach', `--config=${RSYNCD_CONF}`, '--address=127.0.0.1', `--port=${port}`], { env: { ...process.env, HOME: boxHome }, stdio: 'ignore' });
	try {
		while (!(await accepts(port))) await new Promise((resolve) => setImmediate(resolve));
		once(`rsync://127.0.0.1:${port}`, mac, macHome);
		assert.equal(readFileSync(path.join(mac, 'ci-runs.json'), 'utf8'), '{"runs":[7]}');
		assert.equal(readFileSync(path.join(mac, 'alert-bridge-status.json'), 'utf8'), '{"ts":"2026-11-03T03:25:07.811Z"}');
		assert.deepEqual(readdirSync(path.join(mac, 'ci-runs.d')), ['7.stamp']);
		assert.deepEqual(readdirSync(path.join(box, 'ci-wants')), ['99']);
		assert.deepEqual(readdirSync(path.join(mac, 'ci-wants')), []);
	} finally {
		rsyncd.kill();
		rmSync(root, { recursive: true, force: true });
	}
});
