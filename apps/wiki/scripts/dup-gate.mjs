#!/usr/bin/env node
/**
 * Duplicate gate: a commit may not make a curated wiki page look like another one (dupPairs score at or over 0.35)
 * unless the page says how they differ.
 *
 *   node apps/llm-wiki/scripts/dup-gate.mjs <rev> <changed page>...
 *
 * "Before" is every curated page at <rev>, and "after" is the same set with the changed pages read from disk, which is
 * the tree commit.mjs stages. commit.mjs runs it through `prose-lint.mjs --ratchet-git <head> <pages>`.
 * Exit 0 with no new pair, exit 1 with the refusal text, exit 2 when it cannot read git.
 *
 * land-object.mjs runs dupStackRefusal, which judges each landed commit against its own parent from blobs. On 2026-10-18
 * 8cec86237b (the TikTok Shop risk page) was built off-tree and landed with land-object.mjs, which never ran this gate,
 * and dup_unjudged read 2 at 11:48Z from its two pairs.
 *
 * Why: the daily wiki dream judged every pair it found, and dup_unjudged still read 1 on 2026-10-16 06:28, 2026-10-17
 * and 2026-10-18, each time from a curated page that landed after the last run. On 2026-10-17 the run died before it
 * started, so domains/devops/agent-code-metrics/daily-report/index.html and domains/devops/code-health-system/index.html
 * sat unjudged for 2 runs. The writer knows both pages at write time, so the writer judges the pair there.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { dupPairs, parseMeta } from './wiki-health.mjs';

const CONTENT = 'apps/llm-wiki/content/';
const SPACES = ['apps', 'domains', 'projects', 'experiments'].map((space) => `${CONTENT}${space}/`);

/** A content path is a curated page when it is an .html file in a space, outside data/, assets/ and dot folders. */
export function isCuratedPath(rel) {
	if (!rel.endsWith('.html') || !SPACES.some((space) => rel.startsWith(space))) return false;
	const dirs = rel.slice(CONTENT.length).split('/').slice(0, -1);
	return (
		!dirs.some((d) => d === 'data' || d === 'assets' || d.startsWith('.')) && !rel.split('/').pop().startsWith('.')
	);
}

/** The dupPairs row for one page, or null when its meta block does not parse. */
export function pageRow(rel, html) {
	const meta = parseMeta(html);
	if (meta === null) return null;
	return {
		path: rel.slice(CONTENT.length),
		title: meta.title,
		description: meta.description || meta.summary,
		status: meta.status,
		distinctFrom: meta.distinct_from,
	};
}

/** Pairs in `after` that touch a changed page and were not a pair in `before`. Paths are content-relative. */
export function newPairs(before, after, changed) {
	const touched = new Set(changed);
	const old = new Set(dupPairs(before).map((p) => `${p.a}|${p.b}`));
	const names = (row, other) =>
		Boolean(row?.distinctFrom && typeof row.distinctFrom === 'object' && other in row.distinctFrom);
	const byPath = new Map(after.map((row) => [row.path, row]));
	return dupPairs(after).filter(
		(p) =>
			(touched.has(p.a) || touched.has(p.b)) &&
			!old.has(`${p.a}|${p.b}`) &&
			!names(byPath.get(p.a), p.b) &&
			!names(byPath.get(p.b), p.a),
	);
}

/** One line per new pair, naming the changed page, the page it looks like and the score. */
function pairLines(pairs, changed, indent = '  ') {
	const touched = new Set(changed);
	return pairs.map((p) => {
		const [page, other] = touched.has(p.a) ? [p.a, p.b] : [p.b, p.a];
		return `${indent}${page} looks like ${other} (score ${p.score}, the bar is 0.35)`;
	});
}

const FIX =
	'Merge the two pages into one (mark the old page superseded with POST /api/agent/supersede), or add ' +
	'"distinct_from": {"<other page>": "<one sentence on how they differ>"} to the meta block of the changed page';

/** The refusal text for one commit's new pairs. */
export function refusal(pairs, changed) {
	return (
		`dup gate: this commit makes a wiki page look like another one, and the wiki dream would have to judge the pair\n${pairLines(pairs, changed).join('\n')}\n` +
		`${FIX}, then commit again.`
	);
}

function git(args, input) {
	const run = spawnSync('git', args, { input, maxBuffer: Infinity });
	if (run.error || run.status !== 0)
		throw new Error(`git ${args[0]} failed: ${String(run.stderr ?? run.error).trim()}`);
	return run.stdout;
}

/** [repo path, blob] for every curated page at `rev`. */
function listBlobs(root, rev) {
	return String(git(['-C', root, 'ls-tree', '-r', '-z', rev, '--', ...SPACES]))
		.split('\0')
		.filter(Boolean)
		.map((row) => {
			const [info, rel] = row.split('\t');
			return [rel, info.split(' ')[2]];
		})
		.filter(([rel]) => isCuratedPath(rel));
}

/** Reads every blob with one cat-file process and gives [repo path, html]. */
function readBlobs(root, blobs) {
	if (!blobs.length) return [];
	const out = git(['-C', root, 'cat-file', '--batch'], blobs.map(([, sha]) => sha).join('\n') + '\n');
	const pages = [];
	let at = 0;
	for (const [rel] of blobs) {
		const eol = out.indexOf(10, at);
		const size = Number(String(out.subarray(at, eol)).split(' ')[2]);
		pages.push([rel, String(out.subarray(eol + 1, eol + 1 + size))]);
		at = eol + 1 + size + 1;
	}
	return pages;
}

/**
 * The new pairs a change makes against the curated pages at `rev`. `pages` maps each changed curated repo path to its
 * new html, or to null when the change deletes it. The changed pages come back as content paths in `short`.
 */
function pairsOver(root, rev, pages) {
	if (!pages.size) return { pairs: [], short: [] };
	const before = new Map(readBlobs(root, listBlobs(root, rev)));
	const after = new Map(before);
	for (const [rel, html] of pages) {
		if (html === null) after.delete(rel);
		else after.set(rel, html);
	}
	const rows = (all) => [...all].map(([rel, html]) => pageRow(rel, html)).filter(Boolean);
	const short = [...pages.keys()].map((rel) => rel.slice(CONTENT.length));
	return { pairs: newPairs(rows(before), rows(after), short), short };
}

/**
 * The new pairs `files` make against `rev`, with each changed page read from disk, or from `drafts` (repo path to html)
 * for a page the page API has not saved yet.
 */
function gatePairs(rev, files, drafts = new Map()) {
	const root = String(git(['rev-parse', '--show-toplevel'])).trim();
	const pages = new Map();
	for (const file of files) {
		const rel = path.relative(root, path.resolve(file)).split(path.sep).join('/');
		if (!isCuratedPath(rel)) continue;
		const disk = path.join(root, rel);
		pages.set(rel, drafts.has(rel) ? drafts.get(rel) : existsSync(disk) ? readFileSync(disk, 'utf8') : null);
	}
	return pairsOver(root, rev, pages);
}

// git's empty tree, the parent side of a root commit.
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/**
 * What `commit` changed against its first parent (git's empty tree for a root commit), read from blobs and never from
 * disk: `pages` maps each changed repo path under `paths` that `keep` accepts to its new text, or to null when deleted.
 */
export function commitPages(root, commit, paths, keep) {
	const parents = String(git(['-C', root, 'rev-list', '--parents', '-n', '1', commit]))
		.trim()
		.split(' ')
		.slice(1);
	const parent = parents[0] ?? EMPTY_TREE;
	const raw = String(
		git(['-C', root, 'diff-tree', '-r', '-z', '--no-renames', '--no-abbrev', parent, commit, '--', ...paths]),
	).split('\0');
	const pages = new Map();
	const blobs = [];
	for (let i = 0; i + 1 < raw.length; i += 2) {
		const rel = raw[i + 1];
		if (!keep(rel)) continue;
		const [, newMode, , newBlob] = raw[i].slice(1).split(' ');
		pages.set(rel, null);
		if (newMode !== '000000') blobs.push([rel, newBlob]);
	}
	for (const [rel, html] of readBlobs(root, blobs)) pages.set(rel, html);
	return { parent, pages };
}

/**
 * The commits in `old..top` that land, oldest first, with merges left out. Only the first-parent line counts: a commit a
 * merge brings in from another branch passed these gates when it landed there. On 2026-10-19 land-object.mjs refused the
 * merge of sieun/dev f0af491213 into dev/sieun-mac-a for 3 sieun/dev wiki commits that staging already held.
 */
export function landedCommits(root, old, top) {
	return String(git(['-C', root, 'rev-list', '--reverse', '--first-parent', '--no-merges', `${old}..${top}`]))
		.split('\n')
		.filter(Boolean);
}

/**
 * The refusal text when a commit in `old..top` makes a new pair against its own parent, else null. land-object.mjs runs
 * it on every commit it lands, the way commit.mjs runs gateRefusal on the pages it stages.
 */
export function dupStackRefusal(root, old, top) {
	const lines = [];
	for (const c of landedCommits(root, old, top)) {
		const { parent, pages } = commitPages(root, c, SPACES, isCuratedPath);
		const { pairs, short } = pairsOver(root, parent, pages);
		if (pairs.length) lines.push(`  ${c.slice(0, 10)}`, ...pairLines(pairs, short, '    '));
	}
	if (!lines.length) return null;
	return (
		`refusing: these commits make a wiki page look like another one, and the wiki dream would have to judge the pair, so nothing moved\n${lines.join('\n')}\n` +
		`${FIX}, rebuild the commit on the tip and land it again.`
	);
}

/**
 * The refusal text for the new pairs `files` make against `rev`, or null. Files are paths from the cwd; a changed page
 * reads from disk, and a deleted one drops out.
 */
export function gateRefusal(rev, files) {
	const { pairs, short } = gatePairs(rev, files);
	return pairs.length ? refusal(pairs, short) : null;
}

/**
 * One row per new pair `files` make against `rev`, so a batch committer can leave the refused pages out:
 * `path` is the changed page from the repo root, `other` the content-relative page it looks like, `score` the
 * dupPairs score and `reason` the line the refusal prints. A page that looks like two pages gives two rows.
 * Empty when nothing is refused; throws when git cannot read `rev`. wiki-box-commit.mjs on the wiki host uses it, and
 * the page API passes the page it is about to save in `drafts` (repo path to html).
 */
export function refusedPages(rev, files, drafts) {
	const { pairs, short } = gatePairs(rev, files, drafts);
	const touched = new Set(short);
	return pairs.map((p) => {
		const [page, other] = touched.has(p.a) ? [p.a, p.b] : [p.b, p.a];
		return {
			path: `${CONTENT}${page}`,
			other,
			score: p.score,
			reason: `${page} looks like ${other} (score ${p.score}, the bar is 0.35)`,
		};
	});
}

function main() {
	const [rev, ...files] = process.argv.slice(2);
	if (!rev) {
		process.stderr.write('usage: node apps/llm-wiki/scripts/dup-gate.mjs <rev> <changed page>...\n');
		return 2;
	}
	let text;
	try {
		text = gateRefusal(rev, files);
	} catch (error) {
		process.stderr.write(`dup-gate: ${error.message}\n`);
		return 2;
	}
	if (!text) return 0;
	process.stdout.write(`${text}\n`);
	return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main();
