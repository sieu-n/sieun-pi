#!/usr/bin/env node
/**
 * Follow gate: a commit may not delete or rename a repo path that a current curated wiki page cites, in `<code>` or in
 * `source_refs`, unless the same commit rewrites the page so the citation still resolves. The page can point the line at the
 * new path, say on that line that the path was removed or deleted (wiki-health.mjs citedRefs reads that as history), or drop
 * the `source_refs` entry. A ref that still resolves somewhere else, as wiki-health.mjs missingCodeRefs resolves it, passes.
 * The same holds for a `source_refs` entry `path::name` whose file the commit keeps while it removes or renames the
 * definition (definitions.mjs, the reading wiki-stale.ts dates it by): the page drops the entry or names the new definition.
 * A `source_refs` entry counts on every page the stale report reads, experiment and settled pages included (lostSourceRefs),
 * while a `<code>` path on an experiment or settled page stays history, as in missingCodeRefs.
 *
 * auto-sns-agent's commit-run.mjs runs followRefusal and behindRefusal on the tree it is about to commit, and its land-object.mjs
 * runs followRefusal and behindWarning on the stack it lands, both loading this file through scripts/repo/agent/wiki-follow.mjs from the sieun-pi checkout the wiki config
 * names. `root` is the code repo, and the pages come from pagesAt, the content root on disk when a wiki config exists. The
 * page gate (page-gate.mjs) judges only page writes, so before this gate a code commit could leave a page behind with no check.
 *
 * Why: the wiki dream's wiki_problems missed 0 in its runs of 2026-10-19 and 2026-10-20 because code commits removed paths
 * curated pages cite. e5b1874f01 deleted apps/crawler-v3/scripts/scale_join.py, capacity_report.py and capacity_lanes.py,
 * which apps/crawler-v3/architecture/ops-controls/index.html named. 468016fb6b deleted
 * apps/crawler-v3/tests/integration/test_meta_ads_advertisers.py, which apps/search/ads-library.html cites in source_refs.
 * Of the 2,620 tip commits in the 48 h to 2026-10-19 21:30Z, 116 deleted a path outside the wiki and 22 of those left a
 * curated page citing it, each one a stale page the next dream run had to fix (this script's CLI, run as `<sha>^ <sha>` on each).
 * Of the 1,311 first-parent tip commits in the 48 h to 2026-10-25 11:23Z, 17 removed a definition a current page cites as
 * `path::name` while keeping its file, and each left that page citing a definition that was gone. The definition check
 * refuses those 17 and no other commit, at one extra read of the curated pages per code commit, about 170 ms.
 */
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { definitionText, symbolRef } from '../src/lib/definitions.mjs';
import { siblingRef, siblingRepos } from '../src/lib/sibling-repos.mjs';
import { CHECKED_FORMAT, CHECKED_TRAILER, checkedPages, under } from '../src/lib/stale-rules.mjs';
import { blobsAt, checkedAt, commitsBehind, refBehind } from './behind-commits.mjs';
import { pagesAt } from './page-gate.mjs';
import { citedRefs, missingCodeRefs, parseMeta } from './wiki-health.mjs';
import { wikiConfig } from '../src/lib/wiki-config.mjs';

const CONTENT = 'apps/llm-wiki/content/';

/**
 * How a gate message names a page and its fix. With a wiki config file the pages live under its content root and change
 * through the page API, so a commit can never carry one; with none, as in a test repo, they sit in git under CONTENT.
 */
function pageTerms() {
	const config = wikiConfig();
	if (config.file)
		return { name: (page) => `wiki ${page}`, fix: 'through the wiki page API (wiki.write or PUT /wiki/<path>)' };
	return { name: (page) => `${CONTENT}${page}`, fix: 'in this commit' };
}

function git(root, args) {
	const run = spawnSync('git', ['-C', root, ...args], { maxBuffer: Infinity });
	if (run.error || run.status !== 0)
		throw new Error(`git ${args[0]} failed: ${String(run.stderr ?? run.error).trim()}`);
	return String(run.stdout);
}

/**
 * The repo paths outside the wiki content that differ between `before` and `after`, as a map from each path to its git
 * status letter: D for a deleted file and the old side of a rename, A for an added one, M for an edit.
 */
export function changedPaths(root, before, after) {
	const fields = git(root, ['diff-tree', '-r', '-z', '--no-renames', '--name-status', before, after]).split('\0');
	const paths = new Map();
	for (let i = 0; i + 1 < fields.length; i += 2)
		if (!fields[i + 1].startsWith(CONTENT)) paths.set(fields[i + 1], fields[i]);
	return paths;
}

function blob(root, spec) {
	const run = spawnSync('git', ['-C', root, 'cat-file', 'blob', spec], { maxBuffer: Infinity });
	return run.status === 0 ? String(run.stdout) : null;
}

/**
 * One `{ page, refs }` row per page of `pages` (content path to html) with a `source_refs` entry that `before` resolves and
 * `after` does not, read as the stale report (wiki-stale.ts) reads it, which marks such a ref `(missing)`: a `path::name`
 * entry whose file is in `touched` and whose definition (definitions.mjs) `before` holds and `after` lacks, and a path entry
 * under which `touched` removes a file while `after` tracks nothing. It reads every page the stale report reads, experiment
 * and settled pages included, because the wiki dream counts each one of them in wiki_problems. On 2026-10-30 053c39867a
 * removed `run_stockists` from apps/crawler-v3/scripts/resolve_undo.py, which experiments/2026-10-29-profile-entity-resolution
 * cites, and this gate let it land because it skipped experiment pages while the stale report counted the page at once. Of
 * the 4,277 first-parent tip commits from 2026-10-28 06:00Z to 2026-10-30 06:30Z, this reading refuses 2 more than the old one,
 * 053c39867a and c3eb87150a, both under experiment pages.
 */
export function lostSourceRefs(root, pages, touched, before, after) {
	const texts = new Map();
	const defined = (rev, file, name) => {
		const key = `${rev}:${file}`;
		if (!texts.has(key)) texts.set(key, blob(root, key));
		const text = texts.get(key);
		return text !== null && definitionText(text, name) !== null;
	};
	const tracks = (rev, ref) => git(root, ['ls-tree', '-r', '--name-only', rev, '--', ref.replace(/\/+$/, '')]).trim() !== '';
	const lost = (ref) => {
		if (typeof ref !== 'string' || siblingRef(ref)) return false;
		const symbol = symbolRef(ref);
		if (/^[a-z][a-z0-9+.-]*:/i.test(symbol?.file ?? ref)) return false;
		if (symbol)
			return touched.has(symbol.file) && defined(before, symbol.file, symbol.name) && !defined(after, symbol.file, symbol.name);
		return [...touched].some(([file, status]) => status === 'D' && under(ref, file)) && !tracks(after, ref);
	};
	const rows = [];
	for (const [page, html] of pages) {
		const meta = parseMeta(html) ?? {};
		const refs = (Array.isArray(meta.source_refs) ? meta.source_refs : []).filter(lost);
		if (refs.length) rows.push({ page, refs });
	}
	return rows;
}

/**
 * The pages of `pages` (content path to html) with a cited ref that names a removed path, or a folder that held one and that
 * `after` no longer has. A folder that keeps other files still resolves, so a page citing apps/crawler-v3 never counts.
 */
export function citingPages(root, pages, removed, after) {
	const gone = new Set(removed);
	const rows = [];
	const folders = new Set();
	for (const [page, html] of pages) {
		const meta = parseMeta(html) ?? {};
		const row = { path: page, title: meta.title, meta, html, hits: [] };
		for (const candidates of citedRefs(row).values())
			for (const c of candidates) {
				if (gone.has(c)) row.hits.push(c);
				else if (!c.includes(':') && removed.some((p) => p.startsWith(`${c}/`))) {
					row.hits.push(c);
					folders.add(c);
				}
			}
		if (row.hits.length) rows.push(row);
	}
	const kept = new Set();
	if (folders.size) {
		const held = git(root, ['ls-tree', '-r', '-z', '--name-only', after, '--', ...folders]).split('\0').filter(Boolean);
		for (const folder of folders) if (held.some((p) => p.startsWith(`${folder}/`))) kept.add(folder);
	}
	return rows.filter((row) => row.hits.some((c) => !kept.has(c))).map(({ hits, ...row }) => row);
}

/** The rows of brokenCitations for the paths in `removed`, which `before` has and `after` lacks. */
function removedCitations(root, all, removed, before, after, siblings) {
	if (!removed.length) return [];
	const pages = citingPages(root, all, removed, after);
	if (!pages.length) return [];
	const now = missingCodeRefs(pages, root, siblings, { rev: after });
	if (!now.length) return [];
	const was = new Map(missingCodeRefs(pages, root, siblings, { rev: before }).map((row) => [row.path, new Set(row.refs)]));
	return now
		.map((row) => ({ page: row.path, refs: row.refs.filter((ref) => !was.get(row.path)?.has(ref)) }))
		.filter((row) => row.refs.length);
}

/**
 * One `{ page, refs }` row per curated page whose cited refs resolved at `before` and resolve nowhere at `after`, judged on
 * each page as `after` holds it, so a commit that rewrites the page passes. A ref breaks when the commit removes its path,
 * or removes or renames the definition of a `path::name` ref. `before` and `after` are commits or trees.
 */
export function brokenCitations(root, before, after, siblings = siblingRepos()) {
	const touched = new Map([...changedPaths(root, before, after)].filter(([, status]) => status !== 'A'));
	if (!touched.size) return [];
	const removed = [...touched].filter(([, status]) => status === 'D').map(([file]) => file);
	const all = pagesAt(root, after);
	const rows = new Map(lostSourceRefs(root, all, touched, before, after).map((row) => [row.page, row.refs]));
	for (const row of removedCitations(root, all, removed, before, after, siblings))
		rows.set(row.page, [...new Set([...(rows.get(row.page) ?? []), ...row.refs])]);
	return [...rows].map(([page, refs]) => ({ page, refs }));
}

/** The refusal text for a commit from `before` to `after` that leaves a page citing a removed path, or null. */
export function followRefusal(root, before, after, siblings = siblingRepos()) {
	const rows = brokenCitations(root, before, after, siblings);
	if (!rows.length) return null;
	const terms = pageTerms();
	return [
		'follow gate: this commit removes repo paths or definitions that curated wiki pages cite, so the pages would describe code that is gone',
		...rows.map((row) => `  ${terms.name(row.page)}: cites ${row.refs.join(', ')}`),
		`Update each page ${terms.fix}: point the line at the new path or name, say on the same line that the path was removed, or drop`,
		'the source_refs entry, then commit again (sieun-pi apps/wiki/scripts/follow-gate.mjs).',
	].join('\n');
}

/**
 * The pages a commit vouches for in `Wiki-Checked` trailers (CHECKED_TRAILER): those of `message` as git reads its trailer block,
 * or with no message, those of every commit in `before..after` when both are commits, as land-object.mjs lands a stack.
 */
export function vouchedPages(root, before, after, message) {
	if (typeof message === 'string') {
		const run = spawnSync('git', ['interpret-trailers', '--parse', '--no-divider'], { input: message, maxBuffer: Infinity });
		const prefix = `${CHECKED_TRAILER.toLowerCase()}:`;
		const values = String(run.stdout)
			.split('\n')
			.filter((line) => line.toLowerCase().startsWith(prefix))
			.map((line) => line.slice(prefix.length));
		return new Set(checkedPages(values.join('\x1d')));
	}
	const commit = (rev) => git(root, ['cat-file', '-t', rev]).trim() === 'commit';
	if (!commit(before) || !commit(after)) return new Set();
	return new Set(checkedPages(git(root, ['log', `--format=${CHECKED_FORMAT}`, `${before}..${after}`]).replace(/\n/g, '\x1d')));
}

/**
 * One `{ page, refs, lastVerified, earlier }` row per curated page with a `last_verified` that this commit leaves out while it
 * changes code the page cites in `source_refs`, by the stale report's rules (refBehind). The stale report reads a page changed in
 * the same commit, or named in its `Wiki-Checked` trailer (vouchedPages, given the commit's `message`), as checked against that
 * commit's code, so such a page passes. `earlier` holds the short shas of the
 * first-parent commits of `before` after the page's check that changed what it states too (commitsBehind), oldest first, empty
 * when `before` is a tree.
 * Why: on 2026-11-03 at 08:02Z a session followed this warning for its revert 1e85d90226 and set last_verified on 4 pages that
 * were already behind 65328f3db6 (07:18Z) and 17778738bc (07:26Z), and the later stamp hid both from the stale report until the
 * wiki dream rewrote the pages at 08:04Z to 08:06Z. The warning named only the one commit, so its writer checked only that one.
 */
export function behindPages(root, before, after, message) {
	const changed = [...changedPaths(root, before, after).keys()];
	if (!changed.length) return [];
	const vouched = vouchedPages(root, before, after, message);
	const inCommit = new Set(
		git(root, ['diff-tree', '-r', '-z', '--no-renames', '--name-only', before, after, '--', CONTENT])
			.split('\0')
			.filter(Boolean),
	);
	const texts = blobsAt(root, changed.flatMap((file) => [`${before}:${file}`, `${after}:${file}`]));
	const read = (rev, file) => texts.get(`${rev}:${file}`) ?? null;
	const isCommit = git(root, ['cat-file', '-t', before]).trim() === 'commit';
	const rows = [];
	for (const [page, html] of pagesAt(root, after)) {
		if (inCommit.has(`${CONTENT}${page}`) || vouched.has(page)) continue;
		const meta = parseMeta(html) ?? {};
		if (!meta.last_verified || !Array.isArray(meta.source_refs)) continue;
		const refs = meta.source_refs.filter(
			(ref) => typeof ref === 'string' && refBehind(html, ref, changed, before, after, read),
		);
		if (!refs.length) continue;
		const checked = isCommit ? checkedAt(root, before, page, String(meta.last_verified)) : null;
		const earlier = checked === null ? [] : commitsBehind(root, before, page, html, checked).map((c) => c.sha.slice(0, 10));
		rows.push({ page, refs, lastVerified: String(meta.last_verified), earlier });
	}
	return rows;
}

/**
 * The warning text for a stack of commits that changes code a curated page states while no commit of it names the page in a
 * `Wiki-Checked` trailer, or null. land-object.mjs prints it, because its stack is already written and commit.mjs refused
 * each of its commits that left a page out (behindRefusal). Why it exists: in the 7 days to 2026-10-29 20:14Z, 665 code commits put 1,557 page flags on the wiki, 621 of them from agent
 * sessions that could have updated the page, and those sessions updated it themselves within 70 min for 15 of 1,452 flags. The
 * dream rewrote the rest, and 88% of the 867 page-hours that counted in wiki_problems fell while it made no commit for over 45 min,
 * mostly while its one job was parked on model quota (~/work/wiki-stale-churn-1030/FINDINGS.md).
 */
export function behindWarning(root, before, after) {
	const rows = behindPages(root, before, after);
	if (!rows.length) return null;
	const terms = pageTerms();
	return [
		'follow gate warning: this commit changes code that curated wiki pages state and leaves the pages out, so they will read as behind their code',
		...behindLines(rows, terms),
		`Read each page against this diff, and against each commit it is already behind, and update it ${terms.fix} next: fix each`,
		`fact those diffs changed. Set last_verified to the current UTC minute, such as ${new Date().toISOString().slice(0, 16)}Z, only once every one`,
		'of those diffs is in the page or changes nothing it states, because a later last_verified hides each older commit from the',
		'stale report (sieun-pi apps/wiki/scripts/follow-gate.mjs).',
	].join('\n');
}

/** The page lines of a behind warning or refusal: each page, the refs this commit changes and the older commits it is behind. */
function behindLines(rows, terms) {
	return rows.map((row) => {
		const line = `  ${terms.name(row.page)}: cites ${row.refs.join(', ')}`;
		if (!row.earlier.length) return line;
		return `${line}, and is already behind ${row.earlier.join(', ')} since its last_verified ${row.lastVerified}`;
	});
}

/**
 * The refusal text for a commit with the message `message` that changes code curated pages state while its message vouches for
 * none of those pages in a `Wiki-Checked` trailer, or null. commit.mjs refuses such a commit, because its writer holds the diff
 * and is the one session that can say what the page should state now.
 * Hard limit, data integrity: a curated page that states code the tip no longer runs is a wrong record that every reader trusts.
 * Why it refuses: the warning (behindWarning) let every such commit through from 2026-10-29, and in the 7 days to 2026-11-14
 * 23:13Z its sessions ended 27 of the 1,231 page flags themselves, 14 of the 485 flags whose maker the wiki dream asked as well.
 * 1,036 waited for the dream's rewrite, and so did 93% of the 1,420 counted page-hours (~/work/wiki-pages-follow-commit-1115/).
 * Commits made with commit.mjs put 940 of those page-hours on the wiki and their replays by land-object.mjs 168 more.
 */
export function behindRefusal(root, before, after, message) {
	const rows = behindPages(root, before, after, message);
	if (!rows.length) return null;
	const terms = pageTerms();
	return [
		`follow gate: this commit changes code that curated wiki pages state, and its message has no ${CHECKED_TRAILER} line for them`,
		...behindLines(rows, terms),
		`Read each page against this diff and each older commit named, and fix every fact they change ${terms.fix}. Then commit`,
		`again with one trailer per page as the last paragraph of the message, such as -m "${CHECKED_TRAILER}: ${rows[0].page}". The`,
		'trailer is the page check of this commit, so the page never reads as behind it and last_verified can stay as it is. Add a',
		'source_refs entry for a file or definition this commit creates once the commit is on the tip, because the page API refuses a',
		'ref HEAD lacks (sieun-pi apps/wiki/scripts/follow-gate.mjs).',
	].join('\n');
}

function main() {
	const [before, after] = process.argv.slice(2);
	if (!before || !after) {
		process.stderr.write('usage: node apps/wiki/scripts/follow-gate.mjs <before rev> <after rev>, run in the code repo\n');
		return 2;
	}
	let text;
	try {
		text = followRefusal('.', before, after);
	} catch (error) {
		process.stderr.write(`follow-gate: ${error.message}\n`);
		return 2;
	}
	if (!text) return 0;
	process.stdout.write(`${text}\n`);
	return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main();
