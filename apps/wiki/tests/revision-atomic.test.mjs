/**
 * A page write and its revision row land together or not at all. At about 14:59Z on 2026-11-13, during a wiki dream run
 * of 46 page writers, a write of domains/architecture/outside-calls/vendors.html changed the file, then failed to insert
 * its revision with "database is locked" because the metadata DB had no busy timeout and another process held its write
 * lock. The writer got HTTP 400, the page kept the edit and the revision log stayed at v7. Here a second process holds the
 * write lock while a page write runs, and a trigger makes the revision insert fail. The writes run in a child node over a
 * content root the test builds, like concurrent-write.test.mjs.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ENGINE = fileURLToPath(new URL('../src/lib/server', import.meta.url));
const TSX = import.meta.resolve('tsx');
const HOLD_MS = 1500;
const LOCKER = `
const { DatabaseSync } = await import('node:sqlite');
const db = new DatabaseSync(process.argv[1]);
db.exec('BEGIN IMMEDIATE');
db.prepare("INSERT INTO views (path, viewer_kind, ts) VALUES ('locker', 'agent', ?)").run(new Date().toISOString());
process.stdout.write('locked\\n');
setTimeout(() => { db.exec('COMMIT'); process.exit(0); }, Number(process.argv[2]));
`;
const WRITES = `
import { spawn } from 'node:child_process';
const [engine, dbFile, locker, holdMs, rel, fresh, ...bodies] = process.argv.slice(1);
const { commitPage } = await import(engine + '/wiki-write.ts');
const { listRevisions } = await import(engine + '/wiki-store.ts');
const { DatabaseSync } = await import('node:sqlite');
const settle = (promise) => promise.then((r) => ({ version: r.version }), (e) => ({ status: e.status, message: String(e.message) }));
const first = await settle(commitPage({ rawPath: rel, content: bodies[0], author: 'revision-atomic test' }));
const child = spawn(process.execPath, ['--input-type=module', '-e', locker, dbFile, holdMs], { stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((resolve) => child.stdout.once('data', resolve));
const started = performance.now();
const locked = await settle(commitPage({ rawPath: rel, content: bodies[1], author: 'revision-atomic test' }));
const waitedMs = performance.now() - started;
await new Promise((resolve) => child.once('exit', resolve));
const other = new DatabaseSync(dbFile);
other.exec("CREATE TRIGGER refuse_revision BEFORE INSERT ON revisions BEGIN SELECT RAISE(ABORT, 'forced revision failure'); END");
other.close();
const refused = await settle(commitPage({ rawPath: rel, content: bodies[2], author: 'revision-atomic test' }));
const refusedNew = await settle(commitPage({ rawPath: fresh, content: bodies[2], author: 'revision-atomic test' }));
const revisions = listRevisions(rel).map((r) => r.version);
process.stdout.write(JSON.stringify({ first, locked, waitedMs, refused, refusedNew, revisions, freshRevisions: listRevisions(fresh).length }));
process.exit(0);
`;

const page = (title, body) =>
	`<!--wiki ${JSON.stringify({ title, description: `${title} fixture`, last_verified: '2026-11-13T15:00Z' })}-->\n<h1>${title}</h1>\n${body}\n`;

test('a page write waits out another process\'s write lock and logs its revision, and a failed revision insert leaves the file as it was', (t) => {
	const root = mkdtempSync(path.join(tmpdir(), 'revision-atomic-'));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const content = path.join(root, 'content');
	mkdirSync(content, { recursive: true });
	const rel = 'domains/architecture/outside-calls/vendors.html';
	const fresh = 'domains/architecture/outside-calls/new-vendor.html';
	writeFileSync(path.join(content, 'index.html'), page('Home', `<a href="${rel}">Vendors</a> <a href="${fresh}">New vendor</a>`));
	const bodies = ['v1', 'written under a held lock', 'refused by the trigger'].map((line) => page('Vendors', `<p>${line}</p>`));
	const run = spawnSync(
		process.execPath,
		['--import', TSX, '--input-type=module', '-e', WRITES, ENGINE, path.join(content, '.wiki', 'wiki.db'), LOCKER, String(HOLD_MS), rel, fresh, ...bodies],
		{
			cwd: root,
			encoding: 'utf8',
			env: {
				...process.env,
				WIKI_CONFIG: path.join(root, 'no-config.json'),
				WIKI_CONTENT_ROOT: content,
				WIKI_MIRROR_ROOT: root,
				WIKI_AGENTS_ROOT: path.join(root, '.no-mounts'),
			},
		},
	);
	assert.equal(run.status, 0, run.stderr);
	const out = JSON.parse(run.stdout);
	assert.deepEqual(out.first, { version: 1 });
	assert.deepEqual(out.locked, { version: 2 }, `the write under a held lock saves as v2, got ${JSON.stringify(out.locked)}`);
	assert.ok(out.waitedMs >= HOLD_MS - 200, `the write waited for the lock (${Math.round(out.waitedMs)} ms)`);
	assert.match(out.refused.message ?? '', /forced revision failure/);
	assert.match(out.refusedNew.message ?? '', /forced revision failure/);
	assert.deepEqual(out.revisions, [2, 1], 'the refused write logs no revision');
	assert.equal(readFileSync(path.join(content, rel), 'utf8'), bodies[1], 'the refused write leaves the page as v2 left it');
	assert.equal(existsSync(path.join(content, fresh)), false, 'a refused create leaves no file');
	assert.equal(out.freshRevisions, 0);
});
