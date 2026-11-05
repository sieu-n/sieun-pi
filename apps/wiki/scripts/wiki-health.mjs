#!/usr/bin/env node
/**
 * Wiki health: one JSON object with the facts the daily "Wiki dream" duty measures.
 *
 *   node apps/wiki/scripts/wiki-health.mjs [--since <iso>]
 *
 * Exit 0 when it measured (findings included). The content root, the git repo that holds it and the code repo the
 * pages cite come from the wiki config (src/lib/wiki-config.mjs), so it runs from any directory.
 * The link rules live in the engine (wiki-lint.ts, wiki-stale.ts) and the writing rules in prose-lint.mjs;
 * this script runs those and adds metadata, views, duplicate candidates and log signals.
 * Every page rule reads a hard-linked snapshot of the content root on disk (snapshotTree), where the page API writes.
 * An input it could not read is named in `errors` and its facts are null.
 */
import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { kstDayFolder, kstWallClock } from '../src/lib/kst.mjs';
import { siblingRef, siblingRepos } from '../src/lib/sibling-repos.mjs';
import { codeRepoDir, wikiConfig } from '../src/lib/wiki-config.mjs';

const SCRIPTS = path.dirname(fileURLToPath(import.meta.url));
const CONTENT = wikiConfig().contentRoot;
/** The code repo whose paths the pages cite. */
const REPO = codeRepoDir();
const ENGINE = path.resolve(SCRIPTS, '../src/lib/server');
// The sources of the engine's @code mirror (wiki-mirror.ts), which curated pages link to.
const MIRROR_DOCS = [
	'CLAUDE.md',
	'README.md',
	'AGENTS.md',
	'.claude/skills/README.md',
	'.claude/rules',
	'.claude/skills-native',
	'.agents/skills',
	'convex/CLAUDE.md',
	'convex/README.md',
];
const SPACES = ['apps', 'domains', 'projects', 'experiments'];
const HOME = 'index.html';
const DUP_MIN = 0.35;
export const SETTLED_STATUS = new Set(['superseded', 'deprecated', 'archived']);
const DAY = 24 * 60 * 60 * 1000;
const VIEW_WINDOW_DAYS = 60;
/** Where the content sat in the code repo's history until 2026-11, for page ages. */
const CONTENT_REL = 'apps/llm-wiki/content';
/** The candidate prefix of a ref that names a wiki page, which resolves in the content root on disk. */
const WIKI_REF = 'wiki:';
/** The content's folder inside a snapshotTree, where it sat in the repo layout the engine's @code mirror expects beside it. */
const SNAPSHOT_REL = CONTENT_REL;
/** Files over this stay out of the snapshot: on 2026-11-03 the 3,459 curated files up to 1 MB held 108 MB and the rest 2.2 GB of experiment data. A copy, because the engine refuses a hard-linked page. */
const SNAPSHOT_MAX_FILE = '1m';
export const SIGNAL_PHRASES = [
	['commit.mjs refused', /commit\.mjs refused/i],
	['guard refused', /guard refused/i],
	['OOM', /\bOOM(?:-?killed)?\b/],
	['out of memory', /out of memory/i],
	['CI red', /\bCI (?:is |was |went |turned )?red\b/i],
	['land failed', /\bland(?:\.yml)? (?:run )?failed\b/i],
	['reverted', /\breverted\b/i],
	['owner correction', /owner correction/i],
];
const DUP_STOP = new Set(
	'a an the of and or to in on for with by is are be as at from this that it its your you how what why when which page pages one every each all into per not no can do does v2 v3 app apps'.split(
		' ',
	),
);

/** The `<!--wiki {json}-->` meta block, `{}` when absent, null when it does not parse. */
export function parseMeta(html) {
	const match = html.slice(0, 20000).match(/<!--wiki\s*(\{[\s\S]*?\})\s*-->/);
	if (!match) return {};
	try {
		return JSON.parse(match[1]);
	} catch {
		return null;
	}
}

export function stripTags(html) {
	return html
		.replace(/<!--[\s\S]*?-->/g, ' ')
		.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ')
		.replace(/<[^>]+>/g, ' ')
		.replace(/&nbsp;/g, ' ')
		.replace(/&amp;/g, '&')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/\s+/g, ' ')
		.trim();
}

/** A content href resolved to a wiki path, or null for external links, routes and anchors, tried as resolveLink in src/lib/server/wiki-index.ts tries it. */
export function resolveHref(href, fromPath, exists) {
	let target = href.trim();
	if (!target || target.startsWith('#') || /^[a-z][a-z0-9+.-]*:/i.test(target)) return null;
	let base = path.posix.dirname(fromPath);
	if (target.startsWith('/')) {
		if (!target.startsWith('/page/')) return null;
		target = target.slice('/page/'.length);
		base = '.';
	}
	target = target.split('#')[0].split('?')[0];
	try {
		target = decodeURIComponent(target);
	} catch {
		return null;
	}
	target = target.replace(/^apps\/llm-wiki\/content\//, '');
	if (!target) return null;
	const joined = path.posix.normalize(path.posix.join(base, target)).replace(/\/$/, '');
	if (joined.startsWith('../') || joined === '..') return null;
	for (const suffix of ['', '.html', '.md', '.mdx', '/index.html', '/README.html', '/README.md']) {
		if (exists(joined + suffix)) return joined + suffix;
	}
	return joined;
}

export function hrefsOf(html) {
	return [...html.matchAll(/<a\b[^>]*?\bhref\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1]);
}

function dupTokens(text) {
	return new Set(
		(
			String(text ?? '')
				.toLowerCase()
				.match(/[a-z0-9]+/g) ?? []
		).filter((w) => w.length > 2 && !DUP_STOP.has(w)),
	);
}

function jaccard(a, b) {
	let shared = 0;
	for (const w of a) if (b.has(w)) shared += 1;
	const union = a.size + b.size - shared;
	return union ? shared / union : 0;
}

/**
 * Duplicate-topic candidates: 0.5 x title Jaccard + (title+description) Jaccard. A folder page and a page under its folder are not a pair,
 * and a superseded, deprecated or archived page is already settled. A page whose meta `distinct_from` names the
 * other page, with a sentence on how they differ, settles the pair at write time (dup-gate.mjs asks for that line on
 * commit). Every pair is listed, because the
 * dream counts the ones its ledger has not judged: on 2026-10-15 a top-30 cap let one retitled page
 * push 6 judged pairs out and 6 unjudged ones in, so dup_unjudged read 6 of 21.
 */
export function dupPairs(pages, min = DUP_MIN) {
	const rows = pages
		.filter((p) => !SETTLED_STATUS.has(String(p.status).toLowerCase()))
		.map((p) => {
			const title = dupTokens(p.title);
			const distinct = p.distinctFrom && typeof p.distinctFrom === 'object' ? Object.keys(p.distinctFrom) : [];
			return {
				path: p.path,
				title,
				all: new Set([...title, ...dupTokens(p.description)]),
				distinct: new Set(distinct),
			};
		});
	const pairs = [];
	for (let i = 0; i < rows.length; i += 1) {
		for (let j = i + 1; j < rows.length; j += 1) {
			const [a, b] = [rows[i], rows[j]];
			if (isUnderFolderPage(a.path, b.path) || isUnderFolderPage(b.path, a.path)) continue;
			if (a.distinct.has(b.path) || b.distinct.has(a.path)) continue;
			if (!a.all.size || !b.all.size) continue;
			const score = 0.5 * jaccard(a.title, b.title) + jaccard(a.all, b.all);
			if (score >= min)
				pairs.push({
					a: a.path < b.path ? a.path : b.path,
					b: a.path < b.path ? b.path : a.path,
					score: Math.round(score * 100) / 100,
				});
		}
	}
	return pairs.sort((x, y) => y.score - x.score || x.a.localeCompare(y.a));
}

function isUnderFolderPage(folderPage, other) {
	return folderPage.endsWith('/index.html') && other.startsWith(folderPage.slice(0, -'index.html'.length));
}

/** Why a page fails the metadata rule: no `updated`, no description, or title not matching the H1. */
export function missingMetaReasons(meta, lintReasons = []) {
	const reasons = [];
	if (meta === null) reasons.push('meta block does not parse');
	else if (!meta.updated) reasons.push('no updated');
	return [...reasons, ...lintReasons];
}

/** Lint rows minus pages whose status is settled, since a retired page gets no style edit and would be flagged every run. */
export function liveLintRows(rows, pages) {
	const settled = new Set(pages.filter((p) => SETTLED_STATUS.has(String(p.status).toLowerCase())).map((p) => p.path));
	return rows.filter((r) => !settled.has(r.path));
}

/** Worst first: pages people read most, then the most errors. */
export function rankLintPages(rows, views30) {
	return [...rows].sort((a, b) => (views30.get(b.path) ?? 0) - (views30.get(a.path) ?? 0) || b.errors - a.errors);
}

/** A session log's start time from its folder name `sessions/YYYY/MM/DD/hhmm-slug/`, which is Korea time on any host. */
export function sessionLogTime(logPath) {
	const m = logPath.match(/^sessions\/(\d{4})\/(\d{2})\/(\d{2})\/(\d{2})(\d{2})-/);
	return m ? kstWallClock(+m[1], +m[2], +m[3], +m[4], +m[5]) : null;
}

/** The Korea day folders `sessions/YYYY/MM/DD` from `days` days before `now` to `now`, oldest first. */
export function sessionDayFolders(days, now = Date.now()) {
	const folders = [];
	for (let back = days; back >= 0; back -= 1) {
		const rel = `sessions/${kstDayFolder(new Date(now - back * DAY))}`;
		if (!folders.includes(rel)) folders.push(rel);
	}
	return folders;
}

/** One signal per phrase found in a log's text, with up to 200 characters around the first hit. */
export function matchSignals(logPath, text) {
	const out = [];
	for (const [phrase, re] of SIGNAL_PHRASES) {
		const hit = re.exec(text);
		if (!hit) continue;
		const start = Math.max(0, hit.index - 80);
		out.push({ path: logPath, phrase, excerpt: text.slice(start, start + 200) });
	}
	return out;
}

export function excerpt(text) {
	const flat = String(text ?? '')
		.replace(/\s+/g, ' ')
		.trim();
	return flat.length > 200 ? `${flat.slice(0, 197)}...` : flat;
}

function parseArgs(argv) {
	const args = { since: new Date(Date.now() - DAY) };
	for (let i = 0; i < argv.length; i += 1) {
		if (argv[i] === '--since') {
			const at = new Date(argv[i + 1] ?? '');
			if (Number.isNaN(at.getTime())) throw new Error(`--since needs an ISO time, got "${argv[i + 1]}"`);
			args.since = at;
			i += 1;
		}
	}
	return args;
}

function run(file, args, options) {
	const result = spawnSync(file, args, { maxBuffer: Infinity, ...options });
	if (result.error) throw result.error;
	if (result.status !== 0)
		throw new Error(`${file} ${args[0]} exited ${result.status}: ${String(result.stderr).trim()}`);
	return result.stdout;
}

/**
 * A fixed view for the engine reports: every top folder and file of the content root `content` except `sessions/` and the
 * dot folders, hard-linked into a new folder under `content/.wiki` (the same file system, so no data is copied), and the
 * @code mirror docs at HEAD of `mirrorRepo` beside them. Session folders stay out, because no curated-page rule reads them
 * and the engine would index 93 GiB of them; a nested one, such as the `apps/llm-wiki/content/sessions/` that two writes with a
 * disk prefix made on 2026-10-18, is no curated page either. Until 2026-11 this unpacked the content as committed at HEAD of auto-sns-agent;
 * the pages left that repo, and the page API is the one writer, so the disk is the record.
 */
export function snapshotTree(content = CONTENT, mirrorRepo = wikiConfig().mirrorDir) {
	const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'wiki-health-')));
	try {
		const into = path.join(root, SNAPSHOT_REL);
		mkdirSync(into, { recursive: true });
		run('rsync', ['-a', `--max-size=${SNAPSHOT_MAX_FILE}`, '--exclude=sessions/', '--exclude=/.*', `${content}/`, `${into}/`]);
		if (mirrorRepo) {
			const git = (args) => run('git', args, { cwd: mirrorRepo });
			const list = (buf) => String(buf).split('\0').filter(Boolean);
			const apps = list(git(['ls-tree', '-z', '--name-only', 'HEAD', 'apps/']));
			const appDocs = apps.flatMap((app) => [`${app}/CLAUDE.md`, `${app}/README.md`]);
			const docs = list(git(['ls-tree', '-r', '-z', '--name-only', 'HEAD', '--', ...MIRROR_DOCS, ...appDocs]));
			if (docs.length) run('tar', ['-x', '-C', root], { input: git(['archive', '--format=tar', 'HEAD', '--', ...docs]) });
		}
	} catch (error) {
		rmSync(root, { recursive: true, force: true });
		throw error;
	}
	return root;
}

/**
 * When each curated page path was first added at HEAD in `repo`, as ms keyed by content-relative path, from one
 * `git log --diff-filter=A` pass. Renames count as adds, because views are counted per path.
 */
export function pageAddedTimes(repo) {
	const out = run(
		'git',
		[
			'log',
			'--diff-filter=A',
			'--no-renames',
			'--format=@%ct',
			'--name-only',
			'-z',
			'HEAD',
			'--',
			...SPACES.map((space) => `${CONTENT_REL}/${space}`),
			`${CONTENT_REL}/${HOME}`,
		],
		{ cwd: repo },
	);
	const added = new Map();
	let at = null;
	for (const token of String(out).split('\0')) {
		const name = token.replace(/^\n/, '');
		if (/^@\d+$/.test(name)) at = Number(name.slice(1)) * 1000;
		else if (name && at !== null) added.set(name.slice(CONTENT_REL.length + 1), at);
	}
	return added;
}

/**
 * Pages with 0 views and no curated inbound link that have existed for the whole view window, so a new page is never
 * a candidate. The age is the git add time from `addedAt`, else the meta `created` or `date`; a page with neither
 * stays a candidate.
 */
export function archiveCandidates(pages, { views60, inbound, addedAt, now = Date.now() }) {
	const oldest = now - VIEW_WINDOW_DAYS * DAY;
	return pages.filter((p) => {
		if (views60.get(p.path) || inbound.get(p.path) || SETTLED_STATUS.has(String(p.status).toLowerCase())) return false;
		const added = addedAt.get(p.path) ?? Date.parse(p.meta?.created ?? p.meta?.date);
		return Number.isNaN(added) || added <= oldest;
	});
}

const CODE_REF = /<code>((?:apps|convex|packages|scripts|ops)\/[^<\s]*)/g;
const REMOVAL = /\b(?:removed|removal|deleted|no longer exists?)\b/i;

/**
 * The repo paths `page` cites, as a map from each ref to the paths it may resolve to: every `<code>` path under apps,
 * convex, packages, scripts or ops on a line that does not say the path was removed, then every string in its
 * `source_refs` meta. A ref resolves from the repo root, under any app in the page's `apps` meta, or as a wiki page under
 * the content folder; a `<code>` path also resolves in any sibling repo (`*:<path>`), and a `source_refs` entry in the form
 * `sieun-pi:<path>` resolves only in that repo, as wiki-stale.ts reads it. page-gate.mjs reads it to tell the refs a write
 * adds from the refs the page already had.
 */
export function citedRefs(page) {
	const meta = page.meta ?? {};
	const apps = Array.isArray(meta.apps) ? meta.apps.filter((app) => typeof app === 'string') : [];
	const refs = new Map();
	const add = (ref, inCode) => {
		if (/[*{}$&<>]|\.\.\./.test(ref) || refs.has(ref)) return;
		const bare = ref.replace(/(?::\d+(?:-\d+)?|::.*)$/, '').replace(/\/+$/, '');
		const sibling = siblingRef(bare);
		if (sibling) refs.set(ref, [`${sibling.repo}:${sibling.path}`]);
		// The wiki content by its old repo path: a page's own file, which left git on 2026-11-03 and resolves on disk.
		else if (bare.startsWith(`${CONTENT_REL}/`)) refs.set(ref, [`${WIKI_REF}${bare.slice(CONTENT_REL.length + 1)}`]);
		else
			refs.set(ref, [
				bare,
				`${WIKI_REF}${bare}`,
				...apps.map((app) => `apps/${app}/${bare}`),
				...(inCode ? [`*:${bare}`] : []),
			]);
	};
	for (const line of page.html.split('\n')) {
		if (REMOVAL.test(stripTags(line))) continue;
		for (const match of line.matchAll(CODE_REF)) add(match[1].replace(/[.,;:)]+$/, ''), true);
	}
	for (const ref of Array.isArray(meta.source_refs) ? meta.source_refs : [])
		if (typeof ref === 'string') add(ref, false);
	return refs;
}

/**
 * Curated pages whose citedRefs resolve nowhere in `repo` at `rev`: not in its tree, not in a sibling repo of `siblings`
 * (siblingRepos, from its root or under one of its `components/<name>/`), not gitignored, and with `onDisk` not as a file
 * in the checkout, which holds the files a commit.mjs commit adds beside the page. A `sieun-pi:<path>` ref is unmeasured
 * when `siblings` has no sieun-pi checkout. An experiment page (kind or folder) or a retired page keeps its old
 * paths, and with `history` only its `<code>` paths, because the stale report reads `source_refs` on every page. The `<code>` paths matter because a page with no `source_refs` still describes code, and the sibling-repo and
 * wiki-page lookups keep paths that exist from reading as missing.
 */
export function missingCodeRefs(pages, repo, siblings = new Map(), { rev = 'HEAD', onDisk = false, history = false } = {}) {
	const known = new Set();
	const addPaths = (file, prefix = '') => {
		const parts = file.split('/');
		for (let i = 1; i <= parts.length; i += 1) known.add(prefix + parts.slice(0, i).join('/'));
	};
	const tree = (cwd, at) =>
		String(run('git', ['ls-tree', '-r', '-z', '--name-only', at], { cwd }))
			.split('\0')
			.filter(Boolean);
	for (const file of tree(repo, rev)) addPaths(file);
	for (const [name, root] of siblings) {
		for (const file of tree(root, 'HEAD')) {
			addPaths(file, `${name}:`);
			addPaths(file, '*:');
			const component = file.match(/^components\/[^/]+\/(.+)$/);
			if (component) addPaths(component[1], '*:');
		}
	}
	const resolves = (c) =>
		c.startsWith(WIKI_REF) ? existsSync(path.join(CONTENT, c.slice(WIKI_REF.length))) : known.has(c) || (onDisk && existsSync(path.join(repo, c)));
	const unmeasured = (ref) => {
		const sibling = siblingRef(ref);
		return sibling !== null && !siblings.has(sibling.repo);
	};
	const cited = [];
	for (const page of pages) {
		const meta = page.meta ?? {};
		const past =
			meta.kind === 'experiment' || page.path.startsWith('experiments/') || SETTLED_STATUS.has(String(meta.status).toLowerCase());
		if (past && !history) continue;
		for (const [ref, candidates] of citedRefs(past ? { ...page, html: '' } : page))
			if (!unmeasured(ref) && !candidates.some(resolves)) cited.push({ page, ref, candidates });
	}
	if (!cited.length) return [];
	const asked = [...new Set(cited.flatMap((c) => c.candidates))].filter((c) => !/^[^/]*:/.test(c));
	const ignored = new Set();
	if (asked.length) {
		const check = spawnSync('git', ['check-ignore', '--stdin', '-z'], { cwd: repo, input: asked.join('\0') });
		if (check.error || check.status > 1) throw new Error(`git check-ignore exited ${check.status}: ${check.stderr}`);
		for (const file of String(check.stdout).split('\0').filter(Boolean)) ignored.add(file);
	}
	const byPage = new Map();
	for (const { page, ref, candidates } of cited) {
		if (candidates.some((c) => ignored.has(c))) continue;
		byPage.set(page.path, [...(byPage.get(page.path) ?? []), ref]);
	}
	return pages
		.filter((p) => byPage.has(p.path))
		.map((p) => ({ path: p.path, title: p.title, lastVerified: p.meta?.last_verified, refs: byPage.get(p.path) }));
}

// The engine's `modified` text for a source_ref that no longer exists (wiki-stale.ts).
const MISSING_REF = 'missing — ref no longer exists';
const NEVER_VERIFIED = '1970-01-01';

/**
 * Puts the pages from missingCodeRefs into the engine's stale report, which the precheck reads as pages behind their code.
 * A page with no `last_verified` was never checked, so it gets 1970-01-01: the precheck drops a ref whose deleting commit
 * is older than that day, and the page's git add day would hide a page that cites code deleted before the page was added.
 */
export function addMissingCodeRefs(stale, missing) {
	for (const page of missing) {
		const row = stale.stale.find((s) => s.path === page.path);
		const refs = page.refs.map((ref) => ({ ref, modified: MISSING_REF }));
		if (row) row.staleRefs.push(...refs.filter((r) => !row.staleRefs.some((s) => s.ref === r.ref)));
		else
			stale.stale.push({
				path: page.path,
				title: page.title ?? page.path,
				last_verified: page.lastVerified ?? NEVER_VERIFIED,
				staleRefs: refs,
			});
	}
	stale.count = stale.stale.length;
	return stale;
}

// Node strips the engine's types; this hook adds the `.ts` its extensionless relative imports leave out.
const ENGINE_RUN = `
import { registerHooks } from 'node:module';
registerHooks({ resolve(spec, context, next) {
	try { return next(spec, context); } catch (error) {
		if (error?.code !== 'ERR_MODULE_NOT_FOUND' || !spec.startsWith('.')) throw error;
		return next(spec + '.ts', context);
	}
} });
const [engine, repo] = process.argv.slice(1);
const { getLintReport } = await import(engine + '/wiki-lint.ts');
const { getStaleReport } = await import(engine + '/wiki-stale.ts');
const lint = await getLintReport();
process.stdout.write(JSON.stringify({ lint, stale: await getStaleReport(repo) }));
`;

/** The engine's lint and stale reports over the committed tree at `root`; stale compares refs against `repo`. */
export function engineReports(root, repo = REPO, rel = SNAPSHOT_REL) {
	const out = run(process.execPath, ['--input-type=module', '-e', ENGINE_RUN, ENGINE, repo], {
		cwd: root,
		env: { ...process.env, WIKI_CONTENT_ROOT: path.join(root, rel), WIKI_MIRROR_ROOT: root, WIKI_AGENTS_ROOT: path.join(root, '.no-mounts') },
	});
	return JSON.parse(String(out));
}

function walkHtml(dir, rel, out) {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
		const childRel = rel ? `${rel}/${entry.name}` : entry.name;
		if (entry.isDirectory()) {
			if (entry.name !== 'data' && entry.name !== 'assets') walkHtml(path.join(dir, entry.name), childRel, out);
		} else if (entry.isFile() && entry.name.endsWith('.html')) out.push(childRel);
	}
	return out;
}

function readCurated(content) {
	const paths = SPACES.flatMap((space) => walkHtml(path.join(content, space), space, []));
	return [...paths, HOME].map((p) => {
		const html = readFileSync(path.join(content, p), 'utf8');
		const meta = parseMeta(html);
		return {
			path: p,
			html,
			meta,
			title: meta?.title,
			description: meta?.description || meta?.summary,
			status: meta?.status,
			distinctFrom: meta?.distinct_from,
		};
	});
}

/** prose-lint exits before a pipe drains, so its JSON goes to a file descriptor, not a pipe. */
function runProseLint(content) {
	const out = path.join(tmpdir(), `wiki-health-prose-${process.pid}.json`);
	const fd = openSync(out, 'w');
	try {
		const run = spawnSync(process.execPath, [path.join(SCRIPTS, 'prose-lint.mjs'), '--json', ...SPACES, HOME], {
			cwd: content,
			stdio: ['ignore', fd, 'pipe'],
		});
		if (run.error) throw run.error;
		closeSync(fd);
		return JSON.parse(readFileSync(out, 'utf8'));
	} finally {
		try {
			closeSync(fd);
		} catch {}
		rmSync(out, { force: true });
	}
}

async function readViews(paths) {
	const { DatabaseSync } = await import('node:sqlite');
	const db = new DatabaseSync(path.join(CONTENT, '.wiki/wiki.db'), { readOnly: true });
	try {
		const count = (days) => {
			const since = new Date(Date.now() - days * DAY).toISOString();
			const rows = db.prepare('select path, count(*) as n from views where ts >= ? group by path').all(since);
			const wanted = new Set(paths);
			return new Map(rows.filter((r) => wanted.has(r.path)).map((r) => [r.path, Number(r.n)]));
		};
		return { views30: count(30), views60: count(VIEW_WINDOW_DAYS) };
	} finally {
		db.close();
	}
}

/** Session logs (index.html) started in the last `days` days, read from the day folders only. */
function recentSessionLogs(days) {
	const logs = [];
	for (const rel of sessionDayFolders(days)) {
		const dir = path.join(CONTENT, rel);
		if (!existsSync(dir)) continue;
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const log = `${rel}/${entry.name}/index.html`;
			if (entry.isDirectory() && existsSync(path.join(CONTENT, log))) logs.push(log);
		}
	}
	return logs;
}

function itemsFor(kind, rows, toItem) {
	return rows.map((row) => ({ kind, ...toItem(row) }));
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	const root = snapshotTree();
	try {
		process.stdout.write(`${JSON.stringify(await measure(args, root, SNAPSHOT_REL), null, 1)}\n`);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

/** The report over the snapshot that snapshotTree made at `root`. */
async function measure(args, root, rel) {
	const committed = path.join(root, rel);
	const { lint, stale } = engineReports(root, REPO, rel);
	const errors = [];
	const curated = readCurated(committed);
	const pages = curated.filter((p) => p.path !== HOME);
	const pagePaths = new Set(pages.map((p) => p.path));
	const isCuratedSource = (p) => pagePaths.has(p) || p === HOME;

	let views30 = new Map();
	let views60 = null;
	try {
		({ views30, views60 } = await readViews([...pagePaths]));
	} catch (error) {
		errors.push(`views: ${error.message}`);
	}

	let prose = null;
	try {
		prose = runProseLint(committed);
	} catch (error) {
		errors.push(`prose-lint: ${error.message}`);
	}

	const deadLinks = lint.brokenLinks.filter((f) => isCuratedSource(f.path) && !f.target.startsWith('sessions/'));

	const lintReasons = new Map();
	const addReason = (p, reason) => lintReasons.set(p, [...(lintReasons.get(p) ?? []), reason]);
	for (const f of lint.missingDescription) if (pagePaths.has(f.path)) addReason(f.path, 'no description');
	for (const f of lint.titleH1Mismatch) if (pagePaths.has(f.path)) addReason(f.path, f.detail);
	// A page a <wiki-children> hub lists renders an empty row when it has no `summary` (engine rule).
	const missingSummary = (lint.missingSummary ?? []).filter((f) => pagePaths.has(f.path));
	for (const f of missingSummary) addReason(f.path, 'no summary');
	const missingMeta = pages
		.map((p) => ({ path: p.path, reasons: missingMetaReasons(p.meta, lintReasons.get(p.path)) }))
		.filter((row) => row.reasons.length);

	let lintRows = [];
	let lintErrors = null;
	if (prose) {
		lintRows = liveLintRows(
			prose.results
				.filter((r) => !r.skipped)
				.map((r) => {
					const errs = r.findings.filter((f) => f.severity === 'error');
					const byRule = {};
					for (const f of errs) byRule[f.rule] = (byRule[f.rule] ?? 0) + 1;
					return { path: path.relative(committed, r.file).split(path.sep).join('/'), errors: errs.length, byRule };
				}),
			curated,
		);
		lintErrors = lintRows.reduce((sum, r) => sum + r.errors, 0);
		lintRows = rankLintPages(
			lintRows.filter((r) => r.errors > 0),
			views30,
		);
	}

	const exists = (p) => pagePaths.has(p) || p === HOME || existsSync(path.join(committed, p));
	const inbound = new Map();
	for (const page of curated) {
		for (const href of hrefsOf(page.html)) {
			const target = resolveHref(href, page.path, exists);
			if (target && target !== page.path && pagePaths.has(target)) inbound.set(target, (inbound.get(target) ?? 0) + 1);
		}
	}
	let addedAt = new Map();
	try {
		addedAt = pageAddedTimes(REPO);
	} catch (error) {
		errors.push(`page ages: ${error.message}`);
	}
	const archive = views60 ? archiveCandidates(pages, { views60, inbound, addedAt }) : [];
	try {
		addMissingCodeRefs(stale, missingCodeRefs(pages, REPO, siblingRepos()));
	} catch (error) {
		errors.push(`code refs: ${error.message}`);
	}

	const sinceMs = args.since.getTime();
	const days = Math.max(7, Math.ceil((Date.now() - sinceMs) / DAY) + 1);
	let openLogs = 0;
	const signals = [];
	for (const log of recentSessionLogs(days)) {
		let html;
		try {
			html = readFileSync(path.join(CONTENT, log), 'utf8');
		} catch {
			continue;
		}
		const started = sessionLogTime(log);
		if (started && started.getTime() >= Date.now() - 7 * DAY && parseMeta(html)?.status === 'open') openLogs += 1;
		if (started && started.getTime() > sinceMs) signals.push(...matchSignals(log, stripTags(html)));
	}

	const dups = dupPairs(pages.filter((p) => p.meta));
	const items = [
		...itemsFor('hub_orphan', lint.hubOrphans, (f) => ({ path: f.path, excerpt: excerpt(f.detail) })),
		...itemsFor('dead_link', deadLinks, (f) => ({ path: f.path, target: f.target, excerpt: excerpt(f.detail) })),
		...itemsFor('session_link', lint.sessionLinks, (f) => ({
			path: f.path,
			target: f.target,
			excerpt: excerpt(f.detail),
		})),
		...itemsFor('superseded_linked', lint.supersededLinked, (f) => ({
			path: f.path,
			target: f.target,
			excerpt: excerpt(f.detail),
		})),
		...itemsFor('missing_meta', missingMeta, (r) => ({ path: r.path, excerpt: excerpt(r.reasons.join('; ')) })),
		...itemsFor('missing_summary', missingSummary, (f) => ({ path: f.path, excerpt: excerpt(f.detail) })),
		...itemsFor('stale_vs_code', stale.stale, (s) => ({
			path: s.path,
			excerpt: excerpt(
				`last_verified ${s.last_verified}; changed since: ${s.staleRefs
					.map((r) => (r.modified === MISSING_REF ? `${r.ref} (missing)` : r.ref))
					.join(', ')}`,
			),
		})),
		...itemsFor('lint_page', lintRows, (r) => ({
			path: r.path,
			excerpt: excerpt(
				`${r.errors} errors, ${views30.get(r.path) ?? 0} views in 30 days: ${Object.entries(r.byRule)
					.sort((a, b) => b[1] - a[1])
					.map(([rule, n]) => `${rule} ${n}`)
					.join(', ')}`,
			),
		})),
		...itemsFor('archive_candidate', archive, (p) => ({
			path: p.path,
			excerpt: excerpt(`0 views in 60 days, no curated inbound link: ${p.title ?? ''}`),
		})),
		...itemsFor('signal', signals, (s) => ({ path: s.path, excerpt: excerpt(`${s.phrase}: ${s.excerpt}`) })),
	];

	return {
		at: new Date().toISOString(),
		since: args.since.toISOString(),
		curatedPages: pages.length,
		facts: {
			hub_orphans: lint.counts.hubOrphans,
			dead_links: deadLinks.length,
			session_links: lint.counts.sessionLinks,
			superseded_linked: lint.counts.supersededLinked,
			missing_meta: missingMeta.length,
			stale_vs_code: stale.count,
			lint_failing_pages: prose ? lintRows.length : null,
			lint_errors: lintErrors,
			open_session_logs: openLogs,
			unread_unlinked_60d: views60 ? archive.length : null,
		},
		items,
		dupPairs: dups,
		signals,
		stale,
		errors,
	};
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().catch((error) => {
		console.error(`wiki-health: ${error.stack ?? error.message}`);
		process.exit(1);
	});
}
