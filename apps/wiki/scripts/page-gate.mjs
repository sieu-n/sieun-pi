#!/usr/bin/env node
/**
 * Page gate: a commit may not add a wiki problem that the page API refuses (src/lib/server/wiki-write.ts) and the wiki
 * dream precheck counts.
 *   1. A page's meta title equals its first <h1> (missing_meta).
 *   2. No current hub links a retired page (superseded_linked): a hub may not gain such a link, and a page may not turn
 *      superseded, deprecated, archived or retired while a current hub links it.
 *   3. A curated page carries a `last_verified` UTC time or day (stale_vs_code): a new page needs one, a write may not drop it, and a
 *      write that adds a repo path citation to a page without one must set it.
 *   4. A repo path a write adds, in `<code>` or `source_refs`, exists (stale_vs_code), read with wiki-health.mjs
 *      missingCodeRefs: in the tree a commit.mjs commit sits on or in the checkout, or in the commit land-object.mjs lands.
 *      A line that says the path was removed or deleted is history and passes. The page API reads HEAD alone, with a
 *      `path::name` definition too, and refuses a file the checkout holds uncommitted (pageWriteReasons).
 *   5. A link a write adds leads to a page the wiki index serves (dead_link): the target, resolved as wiki-health.mjs
 *      resolveHref does, is a file with a page extension in the tree or the checkout, or under sessions/, which the
 *      sessionLinks lint judges. A file that is not a page, such as a .py or .mjs script, is linked as /raw/<path>. A bare
 *      absolute href such as /experiments/missing is dead when no route in src/routes (ROUTES) serves its first segment.
 *   6. A warning, not a refusal: a `source_refs` entry a write adds should be no newer than the page's `last_verified`
 *      (stale_vs_code). When a first-parent commit at <rev> changed the ref's file, or for `path::name` that definition,
 *      after the page's check (`verifiedAt`), the write goes through and the gate prints the page, the ref and that commit,
 *      so its writer re-verifies the page. Owner rules c81 and c98 keep a new rule soft until the d4 runs show it repeat.
 *   7. A warning, not a refusal, in the page API answer only: a write that moves `last_verified` past a first-parent commit that
 *      changed what the page states names that commit's sha in the page or its summary (hiddenCommitsReason), because the stale report reads only commits
 *      after `last_verified`. A page behind code guards no data, money, auth, outside send or vendor limit (owner rule c98).
 * Rules 3 to 6 judge only what the write adds, because 265 of 296 curated pages had no `last_verified` on 2026-10-19
 * and a rule on the whole page would refuse every edit to them.
 *
 *   node apps/llm-wiki/scripts/page-gate.mjs <rev> <changed page>...
 *
 * "Before" is every curated page and the home page at <rev>, and "after" is the same set with the changed pages read
 * from disk. commit.mjs runs it through `prose-lint.mjs --ratchet-git <head> <pages>`, and wiki-box-commit.mjs leaves a
 * refused page out of the wiki host's batch. land-object.mjs runs pageStackRefusal, which judges each landed commit
 * against its own parent from blobs. Exit 0 with no new finding, 1 with the refusal text, 2 when git fails.
 *
 * Why: on 2026-10-19 wiki-health counted 47 curated pages behind their code, and 37 of them had no `last_verified` and
 * cited a path git no longer has, such as domains/devops/deploy-runbook.html citing scripts/repo/deploy.sh.
 * On 2026-10-18 commit 8cec86237b (the TikTok Shop index duty) added apps/crawler-v3/tiktok-shop-risks/index.html
 * through commit.mjs. It linked the archived tiktok-shop-listing-drops page, the page API never saw the write, and the
 * precheck counted a new superseded_linked item.
 * In the wiki dream run of 2026-10-20 00:59 KST the page API took 4732bf65f9, where
 * projects/search-convex-refactor-backlog/index.html linked stripe-duplicate-customer-audit.mjs, and 6c215f6edf, where
 * projects/multi-platform-crawl-scale/index.html added 12 relative links to bench/*.py and data/*.py, and the precheck
 * counted 12 dead_link items from that one page.
 * On 2026-10-30 41017ab1a0 (PIN move 3 on dev/sieun-mac) swapped a source_ref of apps/search/enterprise-mock.html to
 * apps/search/src/lib/charts/TimeChart.svelte and kept its last_verified of 2026-10-29T23:21Z, though efa5e46967 had changed
 * that file at 2026-10-30T15:18Z, and the wiki dream of 2026-10-31 00:42Z counted the page behind its code on arrival.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { commitPages, isCuratedPath, landedCommits } from './dup-gate.mjs';
import { curatedOnDisk } from './dup-held.mjs';
import { wikiConfig } from '../src/lib/wiki-config.mjs';
import { codeText } from '../src/lib/code-text.mjs';
import { definitionCode, definitionText, symbolRef } from '../src/lib/definitions.mjs';
import { siblingRef, siblingRepos } from '../src/lib/sibling-repos.mjs';
import { citedWords, dayStart, under, verifiedAt, words } from '../src/lib/stale-rules.mjs';
import { citedRefs, SETTLED_STATUS, hrefsOf, missingCodeRefs, parseMeta, resolveHref } from './wiki-health.mjs';
import { checkedAt, commitsBehind } from './behind-commits.mjs';

const CONTENT = 'apps/llm-wiki/content/';
const HOME = 'index.html';
const SPACES = ['apps', 'domains', 'projects', 'experiments'];
const HUB_FILE = /^(index|README)\.html$/;
const RETIRED = new Set(['superseded', 'deprecated', 'archived', 'retired']);
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', middot: '\u00b7' };

function decode(text) {
	return text.replace(/&(#\d{1,7}|#x[0-9a-f]{1,6}|[a-z]+);/gi, (match, ref) => {
		if (ref[0] !== '#') return ENTITIES[ref.toLowerCase()] ?? match;
		const code = /^#x/i.test(ref) ? parseInt(ref.slice(2), 16) : Number(ref.slice(1));
		return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
	});
}

/** The meta title and first <h1> when they differ, as the engine lint compares them; null when they match or one is missing. */
export function titleGap(html) {
	const title = parseMeta(html)?.title;
	const inner = /<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(html)?.[1];
	const h1 = inner
		? decode(inner.replace(/<[^>]+>/g, ' '))
				.replace(/\s+/g, ' ')
				.trim()
		: '';
	if (typeof title !== 'string' || !title || !h1) return null;
	return decode(title) === h1 ? null : { title, h1 };
}

const VERIFIED = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z)?$/;

/** True when the page's meta has a `last_verified` UTC time or day in a form wiki-stale.ts parses. */
function isVerified(html) {
	return VERIFIED.test(String(parseMeta(html)?.last_verified ?? ''));
}

/** The page shape wiki-health.mjs reads: content path, meta and html. */
function pageOf(page, html) {
	const meta = parseMeta(html) ?? {};
	return { path: page, title: meta.title, meta, html };
}

/** The repo paths `html` cites that `old` (the page before the write, or undefined) did not cite. */
export function addedRefs(page, old, html) {
	const had = old === undefined ? new Map() : citedRefs(pageOf(page, old));
	return [...citedRefs(pageOf(page, html)).keys()].filter((ref) => !had.has(ref));
}

/** Why the write of `html` over `old` breaks the last_verified rule, or null. */
function unverifiedReason(page, old, html) {
	if (page === HOME || isVerified(html)) return null;
	const fix = 'add "last_verified": "YYYY-MM-DDTHH:MMZ" to its meta, the UTC time you checked the page against the code';
	if (old === undefined) return `it is a new page with no last_verified; ${fix}`;
	if (isVerified(old)) return `the write drops its last_verified; keep it, or set the UTC time you checked the page again`;
	const added = addedRefs(page, old, html);
	if (added.length) return `it adds the repo path ${added.join(', ')} and has no last_verified; ${fix}`;
	return null;
}

/** The `source_refs` entries `html` has that `old` (the page before the write, or undefined) did not have. */
function addedSourceRefs(old, html) {
	const refs = (text) => {
		const list = text === undefined ? [] : parseMeta(text)?.source_refs;
		return Array.isArray(list) ? list.filter((ref) => typeof ref === 'string') : [];
	};
	const had = new Set(refs(old));
	return refs(html).filter((ref) => !had.has(ref));
}

/**
 * The newest of `after` (`[stamp, sha]` commits that changed `file`, newest first) that changed the code of the definition
 * `name` (`codeText`), while the newest text differs from the text before the oldest, or undefined. The stale report dates a
 * `path::name` ref the same way, so a commit that only touched other code in the file passes.
 */
function definitionChanges(root, after, file, name) {
	if (!after.length) return undefined;
	const textAt = (rev) => {
		const run = spawnSync('git', ['-C', root, 'cat-file', 'blob', `${rev}:${file}`], { maxBuffer: Infinity });
		return definitionCode(run.status === 0 ? String(run.stdout) : null, name, file);
	};
	const texts = after.map(([, sha]) => textAt(sha));
	const before = textAt(`${after.at(-1)[1]}^1`);
	if (texts[0] === before) return undefined;
	return after.find((_, i) => texts[i] !== (i + 1 < after.length ? texts[i + 1] : before));
}

/**
 * Why the write of the curated page `page` (`html` over `old`) adds a `source_refs` entry whose file changed after the
 * page's `last_verified`, or null. The file's newest commit is read on the first-parent history of `rev`, as the stale
 * report (src/lib/server/wiki-stale.ts) dates it, and a `path::name` ref counts only a commit that changed that
 * definition's code (definitionChanges). A commit that changed the file and the page together still counts as
 * newer, unlike in the stale report, because the page did not cite the ref then and a take-in such as efa5e46967 changes
 * both with no writer reading either. `writtenAt` (ms) is when the write lands, which dates a bare-day `last_verified` of that same day.
 */
export function behindRefReason(root, rev, page, old, html, writtenAt) {
	const lastVerified = String(parseMeta(html)?.last_verified ?? '');
	if (page === HOME || !VERIFIED.test(lastVerified)) return null;
	const added = addedSourceRefs(old, html).filter((ref) => !siblingRef(ref) && !/^[a-z][a-z0-9+.-]*:/i.test(ref));
	if (!added.length) return null;
	const log = (format, file, ...args) =>
		String(git(root, ['log', '--first-parent', '--diff-merges=first-parent', format, ...args, rev, '--', file]))
			.trim()
			.split('\n')
			.filter(Boolean);
	const pageFile = `${CONTENT}${page}`;
	const pageCommits = lastVerified.includes('T')
		? []
		: [writtenAt, ...log('--format=%ct', pageFile, `--since=${dayStart(lastVerified) / 1000}`).map((s) => Number(s) * 1000)];
	const checked = verifiedAt(lastVerified, pageCommits);
	const behind = [];
	for (const ref of added) {
		const symbol = symbolRef(ref);
		const file = (symbol?.file ?? ref).replace(/\/+$/, '');
		const after = log('--format=%ct %H', file, `--since=${Math.floor(checked / 1000)}`)
			.map((line) => line.split(' '))
			.filter(([stamp]) => Number(stamp) * 1000 > checked);
		const changed = symbol ? definitionChanges(root, after, file, symbol.name) : after[0];
		if (changed)
			behind.push(`${ref} (changed in ${changed[1].slice(0, 10)} at ${new Date(changed[0] * 1000).toISOString().slice(0, 16)}Z)`);
	}
	if (!behind.length) return null;
	return (
		`it adds the source_refs ${behind.join(', ')}, which changed after its last_verified ${lastVerified}; read the ` +
		`page against that code, fix what changed, and set last_verified to the UTC time you checked it`
	);
}

/**
 * Why the page API (src/lib/server/wiki-write.ts) refuses one write of the curated page `page` (a content path), from
 * rules 3 and 4, as one reason each; empty when the write passes. `before` is the page on disk, or null for a new page.
 * A repo path or `path::name` definition the write adds must be in the repo at `root` at HEAD (lackingRefs); a wiki
 * page path still resolves on disk. Most page writes come through the API, and on 2026-10-19 it took the pages behind
 * 37 of the 47 stale_vs_code items with no check.
 * Why HEAD and not the checkout: on 2026-11-03 at 15:11Z the API took apps/search/campaigns.html v81 with the new
 * source_refs convex/search/campaigns/settledDrains.ts::drainSettledMoves and ::drainSettledJoins while that file sat
 * untracked in the auto-sns-agent checkout, and the wiki dream precheck counted the page at once, because the stale
 * report reads a ref HEAD lacks as missing. Pages left git that day, so no batch holds a page back until its code lands.
 */
export function pageWriteReasons(root, page, before, after) {
	if (page === HOME || !isCuratedPath(`${CONTENT}${page}`)) return [];
	const old = before ?? undefined;
	const reasons = [];
	const unverified = unverifiedReason(page, old, after);
	if (unverified) reasons.push(unverified);
	if (!addedRefs(page, old, after).length) return reasons;
	const shaped = pageOf(page, after);
	const lacking = lackingRefs(root, 'HEAD', [{ page: shaped, had: old === undefined ? [] : [old] }]).get(page) ?? [];
	const cited = citedRefs(shaped);
	const inCheckout = (ref) => {
		const file = (cited.get(ref) ?? [])
			.filter((at) => !/^[^/]*:/.test(at))
			.map((at) => path.join(root, at))
			.find((at) => existsSync(at) && statSync(at).isFile());
		const symbol = symbolRef(ref);
		return file !== undefined && (!symbol || definitionText(readFileSync(file, 'utf8'), symbol.name) !== null);
	};
	const uncommitted = lacking.filter(inCheckout);
	const dead = lacking.filter((ref) => !uncommitted.includes(ref));
	if (dead.length)
		reasons.push(
			`it cites ${dead.join(', ')}, which git does not have; fix the path, leave it out, or say on the same line that it was removed`,
		);
	if (uncommitted.length)
		reasons.push(
			`it cites ${uncommitted.join(', ')}, which the checkout holds but its HEAD does not, so the file is not committed ` +
				`yet and the wiki dream would count the page behind its code at once; write the page after the code commit lands`,
		);
	return reasons;
}

const PAGE_FILE = /\.(md|mdx|txt|ya?ml|json|html)$/i;
const UNSERVED_DIRS = new Set(
	'.batch_state .cache .git .mypy_cache .pytest_cache .ruff_cache .svelte-kit .tox .venv .vercel __pycache__ build coverage dist logs node_modules playwright-report pw reports results site-packages test-results traces venv'.split(
		' ',
	),
);

/**
 * True when the wiki index serves the content path `p` as a page, by the extension and folder rules of shouldSkip in
 * src/lib/server/wiki-paths.ts, which this node script cannot import: a page extension, no dot or build folder, and no
 * .json under sessions/ or experiments/.
 */
export function isServedPath(p) {
	const dirs = p.split('/').slice(0, -1);
	if (!PAGE_FILE.test(p) || dirs.some((dir) => dir.startsWith('.') || UNSERVED_DIRS.has(dir))) return false;
	return !(/^(sessions|experiments)\//.test(p) && /\.json$/i.test(p));
}

/**
 * The first path segments the wiki's router serves, one per folder or file in src/routes. The list is written out
 * because the ci-scope closure walk follows files only and refuses a directory read; page-gate.test.mjs fails when it
 * drifts from src/routes.
 */
export const ROUTES = new Set([
	'api',
	'edit',
	'graph',
	'health',
	'lint',
	'llms-full.txt',
	'llms.txt',
	'page',
	'playground',
	'raw',
	'skills',
	'specs',
	'timeline',
]);

/**
 * The path of a bare absolute href, such as /experiments/missing, whose first segment no route serves, or null. The
 * router has no catch-all, so such a link answers 404 even when content/ holds a page at that path. /page/ and /raw/
 * are routes, and a protocol-relative //host link is external.
 */
function unroutedPath(href) {
	const target = href.trim().split('#')[0].split('?')[0];
	if (!target.startsWith('/') || target.startsWith('//')) return null;
	const first = target.split('/')[1];
	return first === '' || ROUTES.has(first) ? null : target;
}

/**
 * The link targets `after` adds over `before` (undefined for a new page) that lead to no page. A page-relative or
 * /page/ href resolves to a content path as wiki-health.mjs resolveHref does, and `exists` says whether the index
 * serves it. A bare absolute href that no route serves, such as /experiments/missing, is dead as written. A link the
 * page already had is old debt, and a link into sessions/ is left to the sessionLinks lint.
 */
export function deadLinksAdded(page, before, after, exists) {
	const served = (p) => p === page || exists(p);
	const targets = (html) => {
		const out = new Map();
		for (const href of hrefsOf(html)) {
			const bare = unroutedPath(href);
			const target = bare ?? resolveHref(href, page, served);
			if (target) out.set(target, Boolean(bare));
		}
		return out;
	};
	const had = before === undefined ? new Map() : targets(before);
	return [...targets(after)]
		.filter(([t, bare]) => !had.has(t) && (bare || (!t.startsWith('sessions/') && !served(t))))
		.map(([t]) => t);
}

/** The refusal reason for the dead link targets `dead`, which the page API and the page gate both print. */
export function deadLinkReason(dead) {
	const file = dead.find((t) => !t.startsWith('/') && !isServedPath(t));
	const bare = dead.find((t) => t.startsWith('/'));
	return [
		`it adds ${dead.length} link(s) that lead to no wiki page: ${dead.join(', ')}. Link a page that exists, write ` +
			`the linked page first, or leave the link out`,
		...(bare
			? [
					`The wiki serves a page at /page/<path> and no page at a bare path such as ${bare}, so write the link ` +
						`page-relative or as /page${bare}`,
				]
			: []),
		...(file
			? [
					`The wiki serves no page for a file such as a .py or .mjs script, so link it as /raw/<path>, such as ` +
						`/raw/${file}`,
				]
			: []),
	].join('. ');
}

/**
 * An `exists` predicate for the content paths `scan` asks about, where `tree` ({ rev, onDisk }) says to look: the
 * checkout when `onDisk`, then the tree at `rev`, asked with one git process. `scan` runs once with a recorder.
 */
function servedIn(root, tree, scan) {
	const asked = new Set();
	scan((p) => {
		asked.add(p);
		return false;
	});
	const candidates = [...asked].filter(isServedPath);
	const found = new Set();
	if (tree.onDisk)
		for (const p of candidates) {
			const file = path.join(root, CONTENT, p);
			if (existsSync(file) && statSync(file).isFile()) found.add(p);
		}
	const rest = candidates.filter((p) => !found.has(p));
	if (tree.rev && rest.length) {
		const query = rest.map((p) => `${tree.rev}:${CONTENT}${p}`).join('\n') + '\n';
		const types = String(git(root, ['cat-file', '--batch-check=%(objecttype)'], query)).split('\n');
		rest.forEach((p, i) => {
			if (types[i] === 'blob') found.add(p);
		});
	}
	return (p) => found.has(p);
}

/**
 * One `{ page, reason }` row per changed page that adds a link to no page (rule 5). `before` and `changed` map content
 * paths to html, a deleted page is null in `changed`, and `tree` is where a linked page must exist.
 */
export function deadLinkRows(root, before, changed, tree) {
	const pages = [...changed].filter(([, html]) => html !== null);
	const scan = (exists) =>
		pages.map(([page, html]) => ({ page, dead: deadLinksAdded(page, before.get(page), html, exists) }));
	return scan(servedIn(root, tree, scan))
		.filter((row) => row.dead.length)
		.map((row) => ({ page: row.page, reason: deadLinkReason(row.dead) }));
}

function isRetired(html) {
	return RETIRED.has(String(parseMeta(html)?.status ?? '').toLowerCase());
}

/** `hub|target` for every link from a current hub to a retired curated page. `pages` maps content paths to html. */
export function retiredLinks(pages) {
	const pairs = new Set();
	const exists = (p) => pages.has(p);
	for (const [hub, html] of pages) {
		if (!HUB_FILE.test(hub.split('/').pop()) || isRetired(html)) continue;
		for (const href of hrefsOf(html)) {
			const target = resolveHref(href, hub, exists);
			if (target && target !== hub && target !== HOME && pages.has(target) && isRetired(pages.get(target)))
				pairs.add(`${hub}|${target}`);
		}
	}
	return pairs;
}

/** One `{ page, reason }` row per problem the changed pages add between `before` and `after` (content path maps). */
export function newFindings(before, after, changed) {
	const touched = new Set(changed);
	const rows = [];
	for (const page of changed) {
		const unverified = after.has(page) ? unverifiedReason(page, before.get(page), after.get(page)) : null;
		if (unverified) rows.push({ page, reason: unverified });
		const gap = after.has(page) ? titleGap(after.get(page)) : null;
		if (gap && !(before.has(page) && titleGap(before.get(page))))
			rows.push({
				page,
				reason: `its meta title "${gap.title}" and first <h1> "${gap.h1}" differ; change both together`,
			});
	}
	const old = retiredLinks(before);
	for (const pair of retiredLinks(after)) {
		if (old.has(pair)) continue;
		const [hub, target] = pair.split('|');
		if (touched.has(hub))
			rows.push({
				page: hub,
				reason: `it links the retired page ${target}; link the page that replaced it, or leave the link out`,
			});
		else if (touched.has(target))
			rows.push({
				page: target,
				reason: `it turns retired while the current hub ${hub} links it; repoint that link first, or keep its status and POST /api/agent/supersede`,
			});
	}
	return rows;
}

function git(root, args, input) {
	const run = spawnSync('git', ['-C', root, ...args], { input, maxBuffer: Infinity });
	if (run.error || run.status !== 0)
		throw new Error(`git ${args[0]} failed: ${String(run.stderr ?? run.error).trim()}`);
	return run.stdout;
}

/**
 * Every curated page and the home page, as a map from content path to html. With a wiki config file the pages come from
 * its content root on disk, where the page API writes, because the pages left auto-sns-agent's git on 2026-11-03 and a
 * read at `rev` would find none there. With no config file, as in a test repo, they come from `rev` in `root`, read with
 * one cat-file process.
 */
export function pagesAt(root, rev) {
	const config = wikiConfig();
	if (config.file) {
		const pages = curatedOnDisk(config.contentRoot);
		const home = path.join(config.contentRoot, HOME);
		if (existsSync(home)) pages.set(HOME, readFileSync(home, 'utf8'));
		return pages;
	}
	const blobs = String(
		git(root, ['ls-tree', '-r', '-z', rev, '--', ...SPACES.map((s) => `${CONTENT}${s}/`), `${CONTENT}${HOME}`]),
	)
		.split('\0')
		.filter(Boolean)
		.map((row) => [row.split('\t')[1], row.split('\t')[0].split(' ')[2]])
		.filter(([rel]) => isCuratedPath(rel) || rel === `${CONTENT}${HOME}`);
	const pages = new Map();
	if (!blobs.length) return pages;
	const out = git(root, ['cat-file', '--batch'], blobs.map(([, sha]) => sha).join('\n') + '\n');
	let at = 0;
	for (const [rel] of blobs) {
		const eol = out.indexOf(10, at);
		const size = Number(String(out.subarray(at, eol)).split(' ')[2]);
		pages.set(rel.slice(CONTENT.length), String(out.subarray(eol + 1, eol + 1 + size)));
		at = eol + 1 + size + 1;
	}
	return pages;
}

/**
 * One `{ page, reason }` row per changed page that adds a repo path missingCodeRefs finds nowhere; `tree` holds its
 * `rev` and `onDisk` options. `before` and `changed` map content paths to html, and a deleted page is null in `changed`.
 */
export function deadRefRows(root, before, changed, tree) {
	const pages = [...changed]
		.filter(([page, html]) => html !== null && page !== HOME)
		.map(([page, html]) => pageOf(page, html));
	if (!pages.length) return [];
	const rows = [];
	for (const { path: page, refs } of missingCodeRefs(pages, root, siblingRepos(), tree)) {
		const added = new Set(addedRefs(page, before.get(page), changed.get(page)));
		const dead = refs.filter((ref) => added.has(ref));
		if (dead.length)
			rows.push({
				page,
				reason: `it cites ${dead.join(', ')}, which git does not have; fix the path, leave it out, or say on the same line that it was removed`,
			});
	}
	return rows;
}

/**
 * The rows `{ path, reason }` a change adds against `rev`; `changed` maps each changed content path to its html, or null.
 * `tree` is where a cited repo path must exist (deadRefRows).
 */
function rowsOver(root, rev, changed, tree) {
	if (!changed.size) return [];
	const before = pagesAt(root, rev);
	const after = new Map(before);
	for (const [page, html] of changed) {
		if (html === null) after.delete(page);
		else after.set(page, html);
	}
	const rows = [
		...newFindings(before, after, [...changed.keys()]),
		...deadRefRows(root, before, changed, tree),
		...deadLinkRows(root, before, changed, tree),
	];
	return rows.map((row) => ({
		path: `${CONTENT}${row.page}`,
		reason: row.reason,
	}));
}

const isGated = (rel) => isCuratedPath(rel) || rel === `${CONTENT}${HOME}`;

/**
 * The refs of each `{ page, had }` row that `rev` lacks: a repo path missingCodeRefs finds nowhere at `rev`, with no checkout
 * file counted, or a `source_refs` definition `path::name` that definitions.mjs does not find in the file at `rev`, as
 * follow-gate.mjs reads it. Only refs none of the earlier copies `had` cited count, and an experiment or settled page is
 * skipped, as missingCodeRefs skips it. The result maps each content path to its refs.
 */
function lackingRefs(root, rev, rows) {
	const shaped = rows
		.map(({ page, had }) => {
			const old = had.map((html) => citedRefs(pageOf(page.path, html)));
			return { page, added: new Set([...citedRefs(page).keys()].filter((ref) => !old.some((refs) => refs.has(ref)))) };
		})
		.filter((row) => row.added.size);
	const lacks = new Map();
	if (!shaped.length) return lacks;
	const note = (page, ref) => lacks.set(page, [...(lacks.get(page) ?? []), ref]);
	for (const { path: page, refs } of missingCodeRefs(
		shaped.map((row) => row.page),
		root,
		siblingRepos(),
		{ rev },
	))
		for (const ref of refs) if (shaped.find((row) => row.page.path === page).added.has(ref)) note(page, ref);
	const texts = new Map();
	const defined = (file, name) => {
		if (!texts.has(file)) texts.set(file, blobText(root, rev, file));
		const text = texts.get(file);
		return text === null || definitionText(text, name) !== null;
	};
	for (const { page, added } of shaped) {
		if (isHistory(page)) continue;
		for (const ref of Array.isArray(page.meta.source_refs) ? page.meta.source_refs : []) {
			const symbol = typeof ref === 'string' && added.has(ref) ? symbolRef(ref) : null;
			if (symbol && !lacks.get(page.path)?.includes(ref) && !defined(symbol.file, symbol.name)) note(page.path, ref);
		}
	}
	return lacks;
}

const isHistory = (page) =>
	page.meta.kind === 'experiment' ||
	page.path.startsWith('experiments/') ||
	SETTLED_STATUS.has(String(page.meta.status).toLowerCase());

function blobText(root, rev, file) {
	const run = spawnSync('git', ['-C', root, 'cat-file', 'blob', `${rev}:${file}`], { maxBuffer: Infinity });
	return run.status === 0 ? String(run.stdout) : null;
}

/**
 * The refs of each `{ page, had }` row whose file differs between `rev` and the checkout while the edit names what only one
 * side holds in its code, read without comments (code-text.mjs): a distinctive `<code>` word (stale-rules.mjs citedWords) the edit adds that the checkout's text has and `rev`'s
 * lacks, or one it drops that `rev`'s text has and the checkout's lacks. The text of a `path::name` ref is that definition
 * when both sides hold it, else the whole file. A page reads its `source_refs` and, unless it is an experiment or settled
 * page, its `<code>` paths too. The result maps each content path to its refs.
 *
 * Why: at 02:11Z on 2026-10-31 a crawler job edited experiments/2026-10-29-profile-entity-resolution/index.html to say
 * `rules-graph-v19` and `RuntimeProfile.parent_evidence` while that code sat uncommitted in
 * apps/crawler-v3/src/catalog/resolve/policy.py, and batch a79df72960 landed the page at 02:53Z with the tip at v18,
 * because lackingRefs reads only refs an edit adds. Every dirty file the edit names nothing of stays out of it: at 02:58Z
 * on 2026-10-31, 44 code files sat uncommitted and 84 curated pages cited one of them, through a folder ref for most.
 */
function uncommittedRefs(root, rev, rows) {
	const named = rows
		.map(({ page, had }) => {
			const now = citedWords(page.html).tokens;
			const old = had.map((html) => citedWords(html).tokens);
			const added = [...now].filter((word) => !old.some((set) => set.has(word)));
			const dropped = old.length ? [...old[0]].filter((word) => !now.has(word) && old.every((set) => set.has(word))) : [];
			const sources = Array.isArray(page.meta.source_refs) ? page.meta.source_refs : [];
			const refs = [...citedRefs(page)]
				.filter(([ref]) => !isHistory(page) || sources.includes(ref))
				.map(([ref, paths]) => [ref, paths.filter((at) => at && !at.includes(':') && !at.startsWith(CONTENT))]);
			return { page, added, dropped, refs };
		})
		.filter((row) => (row.added.length || row.dropped.length) && row.refs.length);
	const found = new Map();
	if (!named.length) return found;
	const pathspecs = new Set(named.flatMap((row) => row.refs.flatMap(([, paths]) => paths)));
	const dirty = String(git(root, ['diff', '--name-only', '-z', rev, '--', ...[...pathspecs].map((at) => `:(literal)${at}`)]))
		.split('\0')
		// A page is prose, and a folder ref such as apps/llm-wiki/ holds the page's own edit, so wiki content never counts.
		.filter((file) => file && !file.startsWith(CONTENT));
	if (!dirty.length) return found;
	const texts = new Map();
	const sides = (file) => {
		if (!texts.has(file)) {
			const disk = path.join(root, file);
			texts.set(file, [existsSync(disk) ? readFileSync(disk, 'utf8') : '', blobText(root, rev, file) ?? '']);
		}
		return texts.get(file);
	};
	for (const { page, added, dropped, refs } of named)
		for (const [ref, paths] of refs) {
			const files = dirty.filter((file) => paths.some((at) => under(at, file)));
			if (files.some((file) => namesChange(file, ...sides(file), symbolRef(ref)?.name, added, dropped)))
				found.set(page.path, [...(found.get(page.path) ?? []), ref]);
		}
	return found;
}

/** Whether `added` holds a code word of the checkout's `disk` text of `file` (or of its definition `name`) that the tip's lacks, or `dropped` the reverse. */
function namesChange(file, disk, tip, name, added, dropped) {
	const part = (text) => (name === undefined ? null : definitionText(text, name));
	const [now, was] = part(disk) !== null && part(tip) !== null ? [part(disk), part(tip)] : [disk, tip];
	const nowWords = new Set(words(codeText(now, file)));
	const wasWords = new Set(words(codeText(was, file)));
	return (
		added.some((word) => nowWords.has(word) && !wasWords.has(word)) ||
		dropped.some((word) => wasWords.has(word) && !nowWords.has(word))
	);
}

/**
 * One `{ path, reason }` row per page that cites code the tip does not hold as the page describes it: a ref `rev` lacks
 * (lackingRefs), or a ref whose uncommitted change the edit describes (uncommittedRefs). `pages` holds `{ path, html, had }`
 * rows: the repo path, the page on disk and the copies it was edited from.
 * wiki-box-commit.mjs holds such a page out of the wiki host's batch, so it reaches git only with the code commit that
 * makes it true. pageGateRows passes it, because commit.mjs commits a page beside its code from the checkout.
 */
export function aheadOfTipRows(root, rev, pages) {
	const rows = pages
		.filter((row) => isCuratedPath(row.path))
		.map((row) => ({ page: pageOf(row.path.slice(CONTENT.length), row.html), had: row.had }));
	if (!rows.length) return [];
	const lacks = lackingRefs(root, rev, rows);
	for (const [page, refs] of uncommittedRefs(root, rev, rows))
		lacks.set(page, [...new Set([...(lacks.get(page) ?? []), ...refs])]);
	return [...lacks].map(([page, refs]) => ({
		path: `${CONTENT}${page}`,
		reason: `it cites ${refs.join(', ')}, which the tip does not have yet; the page reaches git with the code commit that adds it`,
	}));
}

/**
 * The findings `files` (paths from the cwd) add against `rev`, as rows `{ path, reason }` with `path` from the repo root,
 * so a batch can leave out every refused `path` and commit the rest. A changed page reads from disk; a deleted one drops out.
 * A cited repo path passes when `rev` has it or the checkout holds it, because commit.mjs commits the page beside its code.
 */
export function pageGateRows(rev, files) {
	const { root, changed } = changedOnDisk(files);
	return rowsOver(root, rev, changed, { rev, onDisk: true });
}

/** The repo root and a map from each gated content path of `files` (paths from the cwd) to its html on disk, or null. */
function changedOnDisk(files) {
	const root = String(git('.', ['rev-parse', '--show-toplevel'])).trim();
	const changed = new Map();
	for (const file of files) {
		const rel = path.relative(root, path.resolve(file)).split(path.sep).join('/');
		if (!isGated(rel)) continue;
		const disk = path.join(root, rel);
		changed.set(rel.slice(CONTENT.length), existsSync(disk) ? readFileSync(disk, 'utf8') : null);
	}
	return { root, changed };
}

/**
 * One `{ path, reason }` row per changed page of `changed` (content path to html, or null) that adds a `source_refs`
 * entry newer than its `last_verified` against `rev` (rule 6, a warning), for a change that lands at `writtenAt` (ms).
 */
function behindRows(root, rev, changed, writtenAt) {
	const before = pagesAt(root, rev);
	return [...changed]
		.filter(([, html]) => html !== null)
		.map(([page, html]) => ({
			path: `${CONTENT}${page}`,
			reason: behindRefReason(root, rev, page, before.get(page), html, writtenAt),
		}))
		.filter((row) => row.reason);
}

/** The rule 6 warning lines, one per row, which the page gate prints and lets the write through. */
export function warningText(rows) {
	return rows.map((row) => `page gate warning: ${row.path}: ${row.reason}`).join('\n');
}

/** The rule 6 warning rows `files` (paths from the cwd) add against `rev`; prose-lint.mjs prints them for commit.mjs. */
export function pageGateWarnings(rev, files) {
	const { root, changed } = changedOnDisk(files);
	return behindRows(root, rev, changed, Date.now());
}

/**
 * Why the write of `html` over `old` moves the page's `last_verified` past first-parent commits of `rev` that changed what the
 * page states (behind-commits.mjs commitsBehind) that neither the page nor the write's `summary` names by a short sha, or null. The stale report
 * reads only commits after the new `last_verified`, so the write hides each such commit unless its writer checked it.
 * Why: on 2026-11-03 at 08:02Z a session set last_verified on 4 pages after checking only its revert 1e85d90226, and the stamp
 * hid 65328f3db6 (07:18Z) and 17778738bc (07:26Z) from the stale report until the wiki dream rewrote the pages at 08:04Z to
 * 08:06Z. A wiki dream writer did the same to retrieval.html on 2026-11-02.
 */
export function hiddenCommitsReason(root, rev, page, old, html, writtenAt, summary = '') {
	const was = String(parseMeta(old ?? '')?.last_verified ?? '');
	const now = String(parseMeta(html)?.last_verified ?? '');
	if (page === HOME || !VERIFIED.test(was) || !VERIFIED.test(now) || was === now) return null;
	const from = checkedAt(root, rev, page, was);
	const to = checkedAt(root, rev, page, now, writtenAt);
	if (to <= from) return null;
	const hidden = commitsBehind(root, rev, page, html, from, to)
		.map((c) => c.sha.slice(0, 10))
		.filter((sha) => !html.includes(sha.slice(0, 7)) && !summary.includes(sha.slice(0, 7)));
	if (!hidden.length) return null;
	return (
		`it moves last_verified from ${was} to ${now} past ${hidden.join(', ')}, which changed code its source_refs state and ` +
		`which the page does not name; a later last_verified hides each from the stale report, so read the page against ` +
		`each of those diffs, fix what they changed, and name each sha you checked in the page or the write's summary`
	);
}

/** The page gate warning reasons for one page API write (rule 6 and hiddenCommitsReason), which wiki-write.ts returns with the write. */
export function pageWriteWarnings(root, page, before, after, summary = '') {
	if (page === HOME || !isCuratedPath(`${CONTENT}${page}`)) return [];
	const writtenAt = Date.now();
	return [
		behindRefReason(root, 'HEAD', page, before ?? undefined, after, writtenAt),
		hiddenCommitsReason(root, 'HEAD', page, before ?? undefined, after, writtenAt, summary),
	].filter(Boolean);
}

const REFUSAL = 'page gate: this commit adds wiki problems the page API refuses';

/** The refusal text for the findings `files` add against `rev`, or null. */
export function pageGateRefusal(rev, files) {
	const rows = pageGateRows(rev, files);
	if (!rows.length) return null;
	return `${REFUSAL}\n${rows
		.map((row) => `  ${row.path}: ${row.reason}`)
		.join('\n')}\nFix each page, then commit again.`;
}

/**
 * The `{ path, reason }` rows of the pageGateRefusal text in `output`, such as a refused commit.mjs run's, or [] when it
 * holds none. wiki-box-commit.mjs leaves those pages out when commit.mjs refuses a batch its own page gate run passed.
 */
export function refusalRows(output) {
	const lines = String(output).split('\n');
	const rows = [];
	for (let at = lines.indexOf(REFUSAL) + 1; at > 0 && at < lines.length; at++) {
		const row = /^ {2}(\S+): (.+)$/.exec(lines[at]);
		if (!row) break;
		rows.push({ path: row[1], reason: row[2] });
	}
	return rows;
}

/**
 * The refusal text when a commit in `old..top` adds a finding against its own parent, read from blobs, else null.
 * land-object.mjs runs it on every commit it lands. On 2026-10-18 686d4b302d (grafana, built off-tree and landed with
 * land-object.mjs) set observability-dashboards to superseded while 4 current hubs linked it, and superseded_linked went
 * from 0 to 4.
 */
export function pageStackRefusal(root, old, top) {
	const lines = [];
	for (const c of landedCommits(root, old, top)) {
		const { parent, pages } = commitPages(
			root,
			c,
			[...SPACES.map((s) => `${CONTENT}${s}/`), `${CONTENT}${HOME}`],
			isGated,
		);
		const changed = new Map([...pages].map(([rel, html]) => [rel.slice(CONTENT.length), html]));
		const [stamp, merged] = String(git(root, ['show', '-s', '--format=%ct%n%(trailers:key=Staging-Merged,valueonly)', c]))
			.trim()
			.split('\n');
		const warned = merged ? [] : behindRows(root, parent, changed, Number(stamp) * 1000);
		if (warned.length) process.stderr.write(`${c.slice(0, 10)} ${warningText(warned)}\n`);
		const rows = rowsOver(root, parent, changed, { rev: c });
		if (rows.length) lines.push(`  ${c.slice(0, 10)}`, ...rows.map((row) => `    ${row.path}: ${row.reason}`));
	}
	if (!lines.length) return null;
	return `refusing: these commits add wiki problems the page API refuses, so nothing moved\n${lines.join('\n')}\nFix each page, rebuild the commit on the tip and land it again.`;
}

function main() {
	const [rev, ...files] = process.argv.slice(2);
	if (!rev) {
		process.stderr.write('usage: node apps/llm-wiki/scripts/page-gate.mjs <rev> <changed page>...\n');
		return 2;
	}
	let text;
	try {
		text = pageGateRefusal(rev, files);
	} catch (error) {
		process.stderr.write(`page-gate: ${error.message}\n`);
		return 2;
	}
	if (!text) return 0;
	process.stdout.write(`${text}\n`);
	return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main();
