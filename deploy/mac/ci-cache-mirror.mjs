#!/usr/bin/env node
// ci-cache-mirror: keeps the Mac's ~/.cache/virev a read copy of the CI cache that ci-cache.service writes on the box
// (deploy/linux/ci-cache.service, scripts/dev/ci-cache.mjs poll from auto-sns-agent). One poller runs, on the box, so the
// sieu-n token's 5,000/h GitHub quota is spent once. Mac readers (ci-run-status, the gh shim, gh run watch, ci-monitor,
// commit.mjs --probed, the repo rules duty, login-health) read the local files as before and need no change.
//   node ci-cache-mirror.mjs [host name in ~/.config/sieun-pi/hosts.json, default us-metal02] [--once]
// Every 15 s, over one shared ssh connection (ControlMaster):
//   1. hands the Mac's ci-wants (runs a reader asked for and did not find) to the box;
//   2. runs one `rsync -az` of the mirrored box files into ~/.cache/virev/.mirror, which keeps the last copy as rsync's
//      delta basis. The poller rewrites the 32 MB ci-runs.json every cycle, and a whole copy through the relay took
//      longer than the 15 s cycle at the 360 KB/s one flow gets from Korea, so the old mirror streamed it without pause;
//      the rsync delta of one cycle is about 140 KB;
//   3. clones the changed files into place in the old order: the whole files, the logs, the ci-runs.d stamps, and the
//      heartbeat last. rsync reads ci-runs.d before ci-runs.json on the box, so a stamp never runs ahead of ci-runs.json.
// Each file is cloned to a temp name, given the box file's mtime and renamed into place, so readers never see half a
// file. When the box or the tailnet is down the copy stops moving, and readers report a late cache as they do when the
// poller is late.
import { execFile } from 'node:child_process';
import { constants, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const DIR = process.env.CI_CACHE_DIR || path.join(homedir(), '.cache/virev');
const STAGE = path.join(DIR, '.mirror');
const CONFIG = path.join(homedir(), '.config/sieun-pi');
const INTERVAL_MS = 15_000;
const WHOLE = ['ci-runs.json', 'infra-rerun-state.json', 'release-runner-state.json'];
const APPEND = ['infra-rerun.log', 'release-runner-toggle.log', 'quota-low.jsonl', 'ci-cache.log'];
const HEARTBEAT = 'ci-cache.heartbeat.json';
const STAMPS = 'ci-runs.d';
const RSYNC = ['/opt/homebrew/bin/rsync', '/usr/local/bin/rsync'].find((p) => existsSync(p)) ?? 'rsync';
const SSH = ['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=30', '-o', 'ControlMaster=auto', '-o', `ControlPath=${homedir()}/.ssh/cm-ci-cache-mirror-%C`, '-o', 'ControlPersist=10m'];

const args = process.argv.slice(2);
const once = args.includes('--once');
const hostName = args.find((a) => !a.startsWith('--')) ?? 'us-metal02';
// CI_CACHE_SOURCE (a local folder or user@host:folder) replaces the hosts.json lookup, for tests.
const source = process.env.CI_CACHE_SOURCE || (() => {
	const host = JSON.parse(readFileSync(path.join(CONFIG, 'hosts.json'), 'utf8')).hosts.find((h) => h.name === hostName);
	if (!host) throw new Error(`no host ${hostName} in ${CONFIG}/hosts.json`);
	return `${host.ssh}:${process.env.CI_CACHE_REMOTE_DIR || '.cache/virev'}`;
})();
const sep = source.indexOf(':');
const remoteHost = sep > 0 ? source.slice(0, sep) : null;
const remoteDir = sep > 0 ? source.slice(sep + 1) : source;

const run = (cmd, argv) =>
	new Promise((resolve, reject) =>
		execFile(cmd, argv, { timeout: 120_000, maxBuffer: 1 << 20 }, (error, stdout, stderr) =>
			error ? reject(new Error(`${path.basename(cmd)}: ${(stderr || error.message).trim().split('\n').pop()}`)) : resolve(stdout),
		),
	);

const stat = (file) => {
	try {
		return statSync(file);
	} catch {
		return null;
	}
};
const same = (a, b) => a && b && a.size === b.size && Math.abs(a.mtimeMs - b.mtimeMs) < 1;

function place(from, to) {
	const info = stat(from);
	if (!info || same(stat(to), info)) return false;
	copyFileSync(from, `${to}.mirror.tmp`, constants.COPYFILE_FICLONE);
	utimesSync(`${to}.mirror.tmp`, new Date(), info.mtime);
	renameSync(`${to}.mirror.tmp`, to);
	return true;
}

// A new stage starts from the files the old mirror already wrote, so the first rsync is a delta too.
function seedStage() {
	mkdirSync(path.join(STAGE, STAMPS), { recursive: true });
	for (const file of [...WHOLE, ...APPEND, HEARTBEAT]) if (!stat(path.join(STAGE, file))) place(path.join(DIR, file), path.join(STAGE, file));
	if (readdirSync(path.join(STAGE, STAMPS)).length || !existsSync(path.join(DIR, STAMPS))) return;
	for (const name of readdirSync(path.join(DIR, STAMPS))) place(path.join(DIR, STAMPS, name), path.join(STAGE, STAMPS, name));
}

async function handWants() {
	const dir = path.join(DIR, 'ci-wants');
	const wants = existsSync(dir) ? readdirSync(dir).filter((id) => /^\d+$/.test(id)) : [];
	if (!wants.length) return;
	const touch = `mkdir -p ${remoteDir}/ci-wants && cd ${remoteDir}/ci-wants && touch ${wants.join(' ')}`;
	if (remoteHost) await run(SSH[0], [...SSH.slice(1), '-n', remoteHost, touch]);
	else await run('sh', ['-c', touch]);
	for (const id of wants) rmSync(path.join(dir, id), { force: true });
	console.log(`${new Date().toISOString()} asked the box poller for ${wants.join(' ')}`);
}

async function pull() {
	const filters = [`/${STAMPS}/`, `/${STAMPS}/*`, ...[...WHOLE, ...APPEND, HEARTBEAT].map((f) => `/${f}`)].flatMap((f) => ['--include', f]);
	await run(RSYNC, ['-az', '--delete', '--timeout=60', ...(remoteHost ? ['-e', SSH.join(' ')] : []), ...filters, '--exclude', '*', `${source.replace(/\/?$/, '/')}`, `${STAGE}/`]);
}

async function cycle() {
	await handWants();
	await pull();
	mkdirSync(path.join(DIR, STAMPS), { recursive: true });
	for (const file of [...WHOLE, ...APPEND]) place(path.join(STAGE, file), path.join(DIR, file));
	const stamps = new Set(readdirSync(path.join(STAGE, STAMPS)));
	let moved = 0;
	for (const name of stamps) if (place(path.join(STAGE, STAMPS, name), path.join(DIR, STAMPS, name))) moved++;
	for (const name of readdirSync(path.join(DIR, STAMPS))) if (name.endsWith('.stamp') && !stamps.has(name)) rmSync(path.join(DIR, STAMPS, name), { force: true });
	place(path.join(STAGE, HEARTBEAT), path.join(DIR, HEARTBEAT));
	return moved;
}

seedStage();
let state = 'start';
for (;;) {
	const start = Date.now();
	try {
		const moved = await cycle();
		if (state !== 'ok') console.log(`${new Date().toISOString()} mirror ok from ${source} (${moved} stamps moved)`);
		state = 'ok';
	} catch (error) {
		if (once) throw error;
		if (state !== 'failing') console.error(`${new Date().toISOString()} mirror cycle failed: ${error.message}; retrying every ${INTERVAL_MS / 1000} s`);
		state = 'failing';
	}
	if (once) break;
	await new Promise((resolve) => setTimeout(resolve, Math.max(1000, INTERVAL_MS - (Date.now() - start))));
}
