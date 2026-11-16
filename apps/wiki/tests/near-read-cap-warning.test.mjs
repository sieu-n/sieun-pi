/**
 * A page API write that leaves a current curated page at NEAR_READ_CAP bytes or more warns its writer, at the line the wiki dream
 * precheck counts in wiki_problems. On 2026-11-16 four pages entered the 63,172 to 65,536 B band with no word to their writers
 * (resolver.html at 64,884 B, land-and-promote-gates.html at 64,404 B, and the profile-entity-resolution index and audits pages),
 * so the 13:49Z and 15:34 KST dream runs read wiki_problems 1 and split them. The write runs in a child node over a content root
 * the test builds.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { NEAR_READ_CAP, PAGE_READ_CAP } from '../scripts/read-cap.mjs';

const ENGINE = fileURLToPath(new URL('../src/lib/server', import.meta.url));
const WIKI_DIR = fileURLToPath(new URL('..', import.meta.url));
const TSX = import.meta.resolve('tsx');
const WRITE = `
const [engine, rawPath, content] = process.argv.slice(1);
const { commitPage } = await import(engine + '/wiki-write.ts');
const result = await commitPage({ rawPath, content, author: 'near-read-cap-warning test' });
process.stdout.write(JSON.stringify(result.warnings ?? []));
process.exit(0);
`;

const REL = 'apps/infra/big.html';

/** A page of exactly `bytes` bytes, padded with one paragraph of plain sentences. */
function sized(bytes, meta = {}) {
	const head = `<!--wiki ${JSON.stringify({ title: 'Big', description: 'Big fixture', last_verified: '2026-11-16T14:00Z', ...meta })}-->\n<h1>Big</h1>\n<p>`;
	const tail = '</p>\n';
	const sentence = 'The page holds one plain sentence. ';
	const room = bytes - Buffer.byteLength(head + tail);
	const body = sentence.repeat(Math.ceil(room / sentence.length)).slice(0, room);
	const html = head + body + tail;
	assert.equal(Buffer.byteLength(html), bytes);
	return html;
}

function write(t, html, { listed = true } = {}) {
	const root = mkdtempSync(path.join(tmpdir(), 'near-read-cap-'));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const put = (rel, page) => {
		mkdirSync(path.dirname(path.join(root, 'content', rel)), { recursive: true });
		writeFileSync(path.join(root, 'content', rel), page);
	};
	const hub = (title, links) => `<!--wiki ${JSON.stringify({ title, description: `${title} hub`, last_verified: '2026-11-16T14:00Z' })}-->\n<h1>${title}</h1>\n${links}\n`;
	put('index.html', hub('Home', '<a href="apps/index.html">Apps</a>'));
	put('apps/index.html', hub('Apps', '<a href="infra/index.html">Infra</a>'));
	put('apps/infra/index.html', hub('Infra', listed ? '<a href="big.html">Big</a>' : '<p>No pages yet.</p>'));
	const run = spawnSync(process.execPath, ['--import', TSX, '--input-type=module', '-e', WRITE, ENGINE, REL, html], {
		cwd: WIKI_DIR,
		encoding: 'utf8',
		env: {
			...process.env,
			WIKI_CONFIG: path.join(root, 'no-config.json'),
			WIKI_CONTENT_ROOT: path.join(root, 'content'),
			WIKI_MIRROR_ROOT: root,
			WIKI_AGENTS_ROOT: path.join(root, '.no-mounts'),
		},
	});
	assert.equal(run.status, 0, run.stderr);
	return JSON.parse(run.stdout).filter((w) => w.includes('read cap'));
}

test('the near-cap line is the precheck line, the read cap less one dream rewrite at p90', () => {
	assert.equal(PAGE_READ_CAP, 65_536);
	assert.equal(NEAR_READ_CAP, 63_172);
});

test('a write that leaves a current curated page at 64,000 B warns with the near-cap line and the split advice', (t) => {
	const warnings = write(t, sized(64_000));
	assert.equal(warnings.length, 1, JSON.stringify(warnings));
	assert.match(warnings[0], /64000 bytes, 1536 under the 65536-byte whole-page read cap/);
	assert.match(warnings[0], /63172-byte near-cap line/);
	assert.match(warnings[0], /2364 bytes at p90/);
	assert.match(warnings[0], /Split it into a short index page and child pages by topic/);
});

test('a write that leaves a curated page at 60,000 B gives no read cap warning', (t) => {
	assert.deepEqual(write(t, sized(60_000)), []);
});

test('a settled or superseded page at 64,000 B gives no near-cap warning, as the precheck skips it', (t) => {
	// A current hub may not link a settled page, so this hub lists none.
	for (const status of ['superseded', 'archived', 'Deprecated'])
		assert.deepEqual(write(t, sized(64_000, { status }), { listed: false }), [], status);
});
