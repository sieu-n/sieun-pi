/**
 * A curated page the page API writes lands read-only, so a direct file write fails with EACCES instead of skipping the page
 * gate and the revision log, while the API still rewrites the page and a page outside the curated spaces stays writable. At 01:10:06Z on
 * 2026-11-05 a session wrote apps/crawler-v3/architecture/instagram-authed-engage/dms-and-reads.html with Python's open()
 * through the code checkout's apps/llm-wiki/content symlink, with a source_ref the checkout's HEAD lacked, the page API
 * logged no revision, and the wiki dream precheck counted the page in wiki_problems at once. The writes run in a child node
 * over a content root the test builds, like identical-write.test.mjs.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ENGINE = fileURLToPath(new URL('../src/lib/server', import.meta.url));
const TSX = import.meta.resolve('tsx');
const WRITES = `
const [engine, ...pairs] = process.argv.slice(1);
const { commitPage } = await import(engine + '/wiki-write.ts');
for (let i = 0; i < pairs.length; i += 2) await commitPage({ rawPath: pairs[i], content: pairs[i + 1], author: 'page-file-mode test' });
process.exit(0);
`;

const page = (title, body = '<p>Body.</p>') =>
	`<!--wiki ${JSON.stringify({ title, description: `${title} fixture`, last_verified: '2026-11-05T01:00Z' })}-->\n<h1>${title}</h1>\n${body}\n`;

test('the page API leaves a curated page read-only, rewrites it again, and leaves a page outside the curated spaces writable', (t) => {
	const root = mkdtempSync(path.join(tmpdir(), 'page-file-mode-'));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const content = path.join(root, 'content');
	mkdirSync(content, { recursive: true });
	writeFileSync(path.join(content, 'index.html'), page('Home', '<a href="apps/crawler-v3/dms.html">DMs</a>'));
	const DMS = 'apps/crawler-v3/dms.html';
	const NOTE = 'notes/probe.html';
	const write = (...pairs) =>
		spawnSync(process.execPath, ['--import', TSX, '--input-type=module', '-e', WRITES, ENGINE, ...pairs], {
			cwd: root,
			env: {
				...process.env,
				WIKI_CONFIG: path.join(root, 'no-config.json'),
				WIKI_CONTENT_ROOT: content,
				WIKI_MIRROR_ROOT: root,
				WIKI_AGENTS_ROOT: path.join(root, '.no-mounts'),
			},
			encoding: 'utf8',
		});
	const first = write(DMS, page('DMs'), NOTE, page('Probe'));
	assert.equal(first.status, 0, first.stderr);
	assert.equal(statSync(path.join(content, DMS)).mode & 0o222, 0, 'no write bit');
	assert.throws(() => writeFileSync(path.join(content, DMS), page('DMs', '<p>Off the API.</p>')), { code: 'EACCES' });
	const second = write(DMS, page('DMs', '<p>Through the API.</p>'));
	assert.equal(second.status, 0, second.stderr);
	assert.equal(statSync(path.join(content, DMS)).mode & 0o222, 0, 'no write bit');
	writeFileSync(path.join(content, NOTE), page('Probe', '<p>A note stays a plain file.</p>'));
});
