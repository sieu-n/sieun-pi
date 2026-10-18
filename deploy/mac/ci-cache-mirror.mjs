#!/usr/bin/env node
// ci-cache-mirror: keeps the Mac's ~/.cache/virev a read copy of the CI cache that ci-cache.service writes on the box
// (deploy/linux/ci-cache.service, scripts/dev/ci-cache.mjs poll from auto-sns-agent). One poller runs, on the box, so the
// sieu-n token's 5,000/h GitHub quota is spent once. Mac readers (ci-run-status, the gh shim, gh run watch, ci-monitor,
// commit.mjs --probed, the repo rules duty, login-health) read the local files as before and need no change.
//   node ci-cache-mirror.mjs [host name in ~/.config/sieun-pi/hosts.json, default us-metal02]
// Every 15 s, through the box's prime-relay (GET /v1/file, ~/.cache/virev in its roots):
//   1. hands the Mac's ci-wants (runs a reader asked for and did not find) to the box over ssh, since the relay only reads;
//   2. reads the box's ci-runs.d listing and every stamp whose size or mtime differs from the local one, into memory;
//   3. copies the changed whole files, then appends the new bytes of the append-only logs (a shorter remote log is copied whole);
//   4. writes the staged stamps, so a stamp never moves before the ci-runs.json beside it, then copies the heartbeat last.
// Each copy is written to a temp name, renamed into place and given the box file's mtime, so the next cycle compares
// size and mtime with the box listing and fetches only what moved. When the box or the tailnet is down the copy stops
// moving, and readers report a late cache as they do when the poller is late.
import { execFile } from 'node:child_process';
import { appendFileSync, createWriteStream, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const DIR = process.env.CI_CACHE_DIR || path.join(homedir(), '.cache/virev');
const CONFIG = path.join(homedir(), '.config/sieun-pi');
const INTERVAL_MS = 15_000;
const WHOLE = ['ci-runs.json', 'infra-rerun-state.json', 'release-runner-state.json'];
const APPEND = ['infra-rerun.log', 'release-runner-toggle.log', 'quota-low.jsonl', 'ci-cache.log'];
const HEARTBEAT = 'ci-cache.heartbeat.json';

const host = JSON.parse(readFileSync(path.join(CONFIG, 'hosts.json'), 'utf8')).hosts.find((h) => h.name === (process.argv[2] ?? 'us-metal02'));
if (!host) throw new Error(`no host ${process.argv[2] ?? 'us-metal02'} in ${CONFIG}/hosts.json`);
const token = (host.token.startsWith('file:') ? readFileSync(path.join(CONFIG, host.token.slice(5)), 'utf8') : host.token).trim();
const remote = process.env.CI_CACHE_REMOTE_DIR || `/home/${host.ssh.split('@')[0]}/.cache/virev`;
const base = `http://${host.address}:${host.relayPort}/v1/file?path=`;

async function open(file, headers = {}) {
	const response = await fetch(base + encodeURIComponent(`${remote}/${file}`), { headers: { Authorization: `Bearer ${token}`, ...headers }, signal: AbortSignal.timeout(60_000) });
	if (!response.ok) throw new Error(`GET ${file} answered ${response.status}`);
	return response;
}
const get = async (file, headers) => Buffer.from(await (await open(file, headers)).arrayBuffer());
const list = async (dir) => new Map(JSON.parse(await get(dir)).entries.filter((e) => e.type === 'file').map((e) => [e.name, e]));
const local = (file) => {
	try {
		return statSync(path.join(DIR, file));
	} catch {
		return null;
	}
};
const same = (info, entry) => info && info.size === entry.size && Math.abs(info.mtimeMs - entry.mtimeMs) < 1;

// ci-runs.json is about 24 MB, so whole files stream to disk instead of sitting in memory.
async function copy(file, mtimeMs) {
	const target = path.join(DIR, file);
	await pipeline(Readable.fromWeb((await open(file)).body), createWriteStream(`${target}.mirror.tmp`));
	utimesSync(`${target}.mirror.tmp`, new Date(), new Date(mtimeMs));
	renameSync(`${target}.mirror.tmp`, target);
}

function put(file, body, mtimeMs) {
	const target = path.join(DIR, file);
	writeFileSync(`${target}.mirror.tmp`, body);
	utimesSync(`${target}.mirror.tmp`, new Date(), new Date(mtimeMs));
	renameSync(`${target}.mirror.tmp`, target);
}

function handWants() {
	const wants = (() => {
		try {
			return readdirSync(path.join(DIR, 'ci-wants')).filter((id) => /^\d+$/.test(id));
		} catch {
			return [];
		}
	})();
	if (!wants.length) return Promise.resolve();
	const rdir = path.relative(`/home/${host.ssh.split('@')[0]}`, remote);
	return new Promise((resolve, reject) =>
		execFile('ssh', ['-n', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', host.ssh, `mkdir -p ${rdir}/ci-wants && cd ${rdir}/ci-wants && touch ${wants.join(' ')}`], { timeout: 30_000 }, (error) => {
			if (error) return reject(new Error(`ssh wants: ${error.message.split('\n')[0]}`));
			for (const id of wants) rmSync(path.join(DIR, 'ci-wants', id), { force: true });
			console.log(`${new Date().toISOString()} asked the box poller for ${wants.join(' ')}`);
			resolve();
		}),
	);
}

async function cycle() {
	await handWants();
	mkdirSync(path.join(DIR, 'ci-runs.d'), { recursive: true });
	const stamps = await list('ci-runs.d');
	const moved = [...stamps].filter(([name, entry]) => !same(local(`ci-runs.d/${name}`), entry));
	const staged = [];
	for (let i = 0; i < moved.length; i += 16) staged.push(...(await Promise.all(moved.slice(i, i + 16).map(async ([name, entry]) => [name, await get(`ci-runs.d/${name}`), entry.mtimeMs]))));
	const top = await list('');
	for (const file of WHOLE) {
		const entry = top.get(file);
		if (entry && !same(local(file), entry)) await copy(file, entry.mtimeMs);
	}
	for (const file of APPEND) {
		const entry = top.get(file);
		const info = local(file);
		if (!entry || same(info, entry)) continue;
		if (info && info.size < entry.size) {
			appendFileSync(path.join(DIR, file), await get(file, { Range: `bytes=${info.size}-` }));
			utimesSync(path.join(DIR, file), new Date(), new Date(entry.mtimeMs));
		} else await copy(file, entry.mtimeMs);
	}
	for (const [name, body, mtimeMs] of staged) put(`ci-runs.d/${name}`, body, mtimeMs);
	for (const name of readdirSync(path.join(DIR, 'ci-runs.d'))) if (name.endsWith('.stamp') && !stamps.has(name)) rmSync(path.join(DIR, 'ci-runs.d', name), { force: true });
	const beat = top.get(HEARTBEAT);
	if (beat && !same(local(HEARTBEAT), beat)) await copy(HEARTBEAT, beat.mtimeMs);
	return staged.length;
}

let state = 'start';
for (;;) {
	const start = Date.now();
	try {
		const moved = await cycle();
		if (state !== 'ok') console.log(`${new Date().toISOString()} mirror ok from ${host.name}:${remote} (${moved} stamps moved)`);
		state = 'ok';
	} catch (error) {
		if (state !== 'failing') console.error(`${new Date().toISOString()} mirror cycle failed: ${error.message}${error.cause ? ` (${error.cause.code ?? error.cause.message})` : ''}; retrying every ${INTERVAL_MS / 1000} s`);
		state = 'failing';
	}
	await new Promise((resolve) => setTimeout(resolve, Math.max(1000, INTERVAL_MS - (Date.now() - start))));
}
