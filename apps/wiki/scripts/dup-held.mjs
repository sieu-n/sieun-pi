#!/usr/bin/env node
/**
 * Which curated pages a page looks like, judged by the duplicate gate's rule (dup-gate.mjs newPairs), so the page API
 * can refuse a write that starts a held pair. The pages are the curated pages on disk under the content root; until
 * 2026-11 this read them from git HEAD of auto-sns-agent, where the wiki host's batch committed them.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { isCuratedPath, newPairs, pageRow } from './dup-gate.mjs';

const CONTENT = 'apps/llm-wiki/content/';
const SPACES = ['apps', 'domains', 'projects', 'experiments'];

/** Every curated page on disk under `contentRoot`, as a map from content path to html. */
function curatedOnDisk(contentRoot) {
	const pages = new Map();
	for (const space of SPACES) {
		const dir = path.join(contentRoot, space);
		if (!existsSync(dir)) continue;
		for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
			if (!entry.isFile()) continue;
			const rel = path.relative(contentRoot, path.join(entry.parentPath, entry.name)).split(path.sep).join('/');
			if (!isCuratedPath(CONTENT + rel)) continue;
			try {
				pages.set(rel, readFileSync(path.join(contentRoot, rel), 'utf8'));
			} catch {
				// gone since the listing
			}
		}
	}
	return pages;
}

const rowsOf = (pages) => [...pages].map(([rel, html]) => pageRow(CONTENT + rel, html)).filter(Boolean);

/**
 * What writing `html` to the curated content path `page` does: `added` pairs (the page API refuses them) and `kept`
 * pairs (allowed, so a writer can always save the fix for a page that is already held), each `{ other, score }`.
 */
export function heldByWrite(contentRoot, page, html) {
	if (!isCuratedPath(CONTENT + page)) return { added: [], kept: [] };
	const before = curatedOnDisk(contentRoot);
	const after = new Map(before).set(page, html);
	const others = (pairs) =>
		pairs
			.filter((p) => p.a === page || p.b === page)
			.map((p) => ({ other: p.a === page ? p.b : p.a, score: p.score }));
	const without = new Map(before);
	without.delete(page);
	const kept = before.has(page) ? others(newPairs(rowsOf(without), rowsOf(before), [page])) : [];
	const keptOthers = new Set(kept.map((row) => row.other));
	const now = others(newPairs(rowsOf(without), rowsOf(after), [page]));
	return {
		added: now.filter((row) => !keptOthers.has(row.other)),
		kept: now.filter((row) => keptOthers.has(row.other)),
	};
}
