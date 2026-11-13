/**
 * Two writes of one page on the same baseVersion: one saves and the other answers 409 stale base, with no EACCES and no
 * temp file left. At about 09:01Z on 2026-11-09 two writers sent apps/search/campaigns/counts.html on base v28; one saved
 * v29 and the other got HTTP 400 EACCES on the first's read-only temp file, because both passed the base check while the
 * page gates ran. Two session events appended at once must both land too. The writes run in a child node over a content
 * root the test builds, like identical-write.test.mjs.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ENGINE = fileURLToPath(new URL('../src/lib/server', import.meta.url));
// The engine runs from apps/wiki, as the service does, and finds its write checks worker there.
const WIKI_DIR = fileURLToPath(new URL('..', import.meta.url));
const TSX = import.meta.resolve('tsx');
const WRITES = `
const [engine, rel, ...contents] = process.argv.slice(1);
const { commitPage } = await import(engine + '/wiki-write.ts');
const { openSession, appendEvent } = await import(engine + '/wiki-sessions.ts');
const settle = (results) => results.map((r) => (r.status === 'fulfilled' ? { version: r.value.version } : { status: r.reason.status, message: String(r.reason.message) }));
const base = (await commitPage({ rawPath: rel, content: contents[0], author: 'concurrent-write test' })).version;
const based = settle(await Promise.allSettled(contents.slice(1, 3).map((content) => commitPage({ rawPath: rel, content, author: 'concurrent-write test', baseVersion: base }))));
const unbased = settle(await Promise.allSettled(contents.slice(3, 5).map((content) => commitPage({ rawPath: rel, content, author: 'concurrent-write test' }))));
const session = await openSession({ slug: 'concurrent-events', goal: 'append two events at once' });
const events = settle(await Promise.allSettled(['first', 'second'].map((summary) => appendEvent(session.id, { summary }))));
process.stdout.write(JSON.stringify({ base, based, unbased, session: session.path, events }));
process.exit(0);
`;

const page = (title, body) =>
	`<!--wiki ${JSON.stringify({ title, description: `${title} fixture`, last_verified: '2026-11-09T09:00Z' })}-->\n<h1>${title}</h1>\n${body}\n`;

function filesUnder(dir) {
	return readdirSync(dir, { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile())
		.map((entry) => path.relative(dir, path.join(entry.parentPath, entry.name)));
}

test('two writes of one curated page on one baseVersion save once and answer 409 once, and two session events both land', (t) => {
	const root = mkdtempSync(path.join(tmpdir(), 'concurrent-write-'));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const content = path.join(root, 'content');
	mkdirSync(content, { recursive: true });
	const rel = 'apps/search/campaigns/counts.html';
	writeFileSync(path.join(content, 'index.html'), page('Home', `<a href="${rel}">Counts</a>`));
	const bodies = ['v1', 'writer A', 'writer B', 'writer C', 'writer D'].map((line) => page('Counts', `<p>${line}</p>`));
	const run = spawnSync(process.execPath, ['--import', TSX, '--input-type=module', '-e', WRITES, ENGINE, rel, ...bodies], {
		cwd: WIKI_DIR,
		encoding: 'utf8',
		env: {
			...process.env,
			WIKI_CONFIG: path.join(root, 'no-config.json'),
			WIKI_CONTENT_ROOT: content,
			WIKI_MIRROR_ROOT: root,
			WIKI_AGENTS_ROOT: path.join(root, '.no-mounts'),
		},
	});
	assert.equal(run.status, 0, run.stderr);
	const { base, based, unbased, session, events } = JSON.parse(run.stdout);
	assert.deepEqual(based[0], { version: base + 1 }, 'the first write on the base saves');
	assert.equal(based[1].status, 409, `the second write on the same base answers 409, got ${JSON.stringify(based[1])}`);
	assert.match(based[1].message, /^stale: baseVersion/);
	assert.deepEqual(unbased, [{ version: base + 2 }, { version: base + 3 }], 'writes with no base each save after the one before');
	assert.deepEqual(events.map((e) => e.status), [undefined, undefined], JSON.stringify(events));
	const html = readFileSync(path.join(content, session), 'utf8');
	assert.ok(html.includes('<h2>first</h2>') && html.includes('<h2>second</h2>'), 'both events are in the log');
	assert.deepEqual(
		filesUnder(content).filter((f) => f.endsWith('.write')),
		[],
		'no temp file is left',
	);
});
