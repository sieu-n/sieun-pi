import assert from 'node:assert/strict';
import { test } from 'node:test';
import { wikiBase } from './wiki-base.mjs';

const mirrorPath = '@code/.agents/skills/repo/data-contracts/SKILL.md';

// Through the wiki server tests/run.mjs starts (GET /api/agent/context-pack runs getContextPack), so the run builds
// the wiki index once. A vite server of its own here built it again: 50 s of the 378 s llm-wiki#test took in verify-dev
// job 118281989421, and 22 CPU-seconds on 2 cores.
test('context packs read mirrored code pages', async (t) => {
	const base = await wikiBase();
	if (!base) return t.skip('llm-wiki dev server unreachable, SKIPPED, not passed');
	const query = new URLSearchParams({ q: '.agents/skills/repo/data-contracts/SKILL.md', budget: '5000' });
	const res = await fetch(`${base}/api/agent/context-pack?${query}`);
	assert.equal(res.status, 200);
	const result = await res.json();
	assert.ok(
		result.chunks.some((chunk) => chunk.path === mirrorPath && chunk.content.length > 0),
		`expected a non-empty context chunk for ${mirrorPath}`,
	);
});
