import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { codeText } from '../code-text.mjs';
import { definitionCode, symbolRef } from '../definitions.mjs';
import { siblingRef, siblingRepos } from '../sibling-repos.mjs';
import {
	changedLines,
	citedWords,
	citesLines,
	dayStart,
	followed,
	linesTouch,
	under,
	verifiedAt,
} from '../stale-rules.mjs';
import { getWikiIndex } from './wiki';
import { diskPath } from './wiki-mounts';

const MISSING = 'missing — ref no longer exists';
const PAGES = 'apps/llm-wiki/content/';
const execFileAsync = promisify(execFile);

/** Runs git in `root`, with `input` on its stdin when given, and gives its stdout; rejects on a nonzero exit. */
async function git(root: string, args: string[], input?: string): Promise<string> {
	const run = execFileAsync('git', ['--literal-pathspecs', ...args], { cwd: root, maxBuffer: Infinity });
	if (input !== undefined) run.child.stdin?.end(input);
	return (await run).stdout;
}

/**
 * Reads `rev:path` blobs through one `git cat-file --batch` process, in request order; null for a path the rev lacks. One process
 * per report, because the whole-file check reads two versions of a cited file per commit after each page's check.
 */
function blobReader(root: string): { read: (spec: string) => Promise<string | null>; close: () => void } {
	const child = spawn('git', ['cat-file', '--batch'], { cwd: root, stdio: ['pipe', 'pipe', 'ignore'] });
	const waiting: Array<(value: string | null) => void> = [];
	let buffer = Buffer.alloc(0);
	child.stdout.on('data', (chunk: Buffer) => {
		buffer = Buffer.concat([buffer, chunk]);
		for (;;) {
			const newline = buffer.indexOf(10);
			if (newline < 0) return;
			const header = buffer.subarray(0, newline).toString();
			if (/ missing$| ambiguous$/.test(header)) {
				buffer = buffer.subarray(newline + 1);
				waiting.shift()?.(null);
				continue;
			}
			const size = Number(header.split(' ')[2]);
			if (buffer.length < newline + 1 + size + 1) return;
			const body = buffer.subarray(newline + 1, newline + 1 + size).toString('utf8');
			buffer = buffer.subarray(newline + 1 + size + 1);
			waiting.shift()?.(body);
		}
	});
	const failAll = (): void => {
		while (waiting.length) waiting.shift()!(null);
	};
	child.on('close', failAll);
	child.on('error', failAll);
	return {
		read: (spec) =>
			new Promise((resolve) => {
				if (/\n/.test(spec) || child.exitCode !== null) return resolve(null);
				waiting.push(resolve);
				child.stdin.write(`${spec}\n`);
			}),
		close: () => child.stdin.end(),
	};
}

export type Change = { at: number; sha: string; parent: string; files: string[] };

type StaleRef = { ref: string; modified: string; since?: string };

/** One page's result at the state's pin: its check time and, per `source_refs` entry in order, the stale row or null. */
type PageEntry = { key: string; verifiedAt: number; refs: Array<StaleRef | null> };

/**
 * What one report leaves for the next, in the code repo's git dir (`wiki-stale/report-state.json`) and in memory: the pinned
 * HEAD, the first-parent commits back to `since` with their files, each sibling repo's `root sha`, and each page's result.
 * A later report diffs only the commits after `pin` and recomputes only the pages whose inputs or cited files changed. On
 * 2026-11-04 the full report took 54 to 80 s on us-metal02 at load 236, and Tailscale Serve answered 502 through :5184:
 * 570 per-ref git processes (239 show, 269 log, 62 ls-tree) and 17 s of definition parsing ran for 253 pages on every call.
 */
type StaleState = {
	version: typeof STATE_VERSION;
	pin: string;
	since: number | null;
	changes: Change[];
	siblings: Record<string, string>;
	pages: Record<string, PageEntry>;
};

/**
 * `--since-as-filter`, never `--since`, for a date-limited walk that must list every commit: `--since` stops at the first commit
 * dated before the cutoff, and parallel lands leave the auto-sns-agent tip dated out of order, so on 2026-11-04
 * `--since=13:12:40Z` stopped at addbbf5329 (13:12:35Z) and missed afc3ff7332 (13:13:02Z) below it.
 * Version 2 drops a held list read with `--since`.
 */
const STATE_VERSION = 2;
const states = new Map<string, StaleState>();

async function statePath(root: string): Promise<string> {
	return path.resolve(root, (await git(root, ['rev-parse', '--git-path', 'wiki-stale/report-state.json'])).trim());
}

async function readState(store: string): Promise<StaleState | null> {
	const held = states.get(store);
	if (held) return held;
	const state = await readFile(store, 'utf8')
		.then((text) => JSON.parse(text) as StaleState)
		.catch(() => null);
	return state?.version === STATE_VERSION ? state : null;
}

async function writeState(store: string, state: StaleState): Promise<void> {
	states.set(store, state);
	await mkdir(path.dirname(store), { recursive: true });
	const temp = `${store}.${process.pid}.${Math.random().toString(36).slice(2)}`;
	await writeFile(temp, JSON.stringify(state));
	await rename(temp, store);
}

const coversSince = (held: number | null, since: number | null): boolean =>
	held === null || (since !== null && held <= since);

/**
 * The first-parent commits of `pin` in `root` since `since`, newest first, each with every file it changed against its first
 * parent, the files changed after `held.pin`, or null when `held.pin` is not on this history, and the time the list reaches back to. Git lists and diffs only the
 * commits after `held.pin`, or on a new history the commits `held` lacks. On 2026-11-02 one `git log --name-only` over 1,737
 * pathspecs (1,521 refs and 216 pages) and the 20,024 first-parent commits since 2026-10-19 took 514 s of a 531 s report on
 * us-metal02 at load 139 to 218, and the same log with no pathspec took 42 s at load 100.
 */
async function firstParentChanges(
	root: string,
	pin: string,
	since: number | null,
	held: StaleState | null,
): Promise<{ changes: Change[]; touched: Set<string> | null; since: number | null }> {
	const parse = (text: string) =>
		text
			.split('\n')
			.map((line) => line.trim().split(' '))
			.filter(([stamp, sha]) => stamp && sha)
			.map(([stamp, sha, parent]) => ({ at: Number(stamp) * 1000, sha: sha!, parent: parent ?? '', files: [] as string[] }));
	const format = '--format=%ct %H %P';
	let listed: Change[] | null = null;
	let reach = since;
	if (held && coversSince(held.since, since)) {
		if (held.pin === pin) return { changes: held.changes, touched: new Set(), since: held.since };
		const added = parse(await git(root, ['log', pin, '--first-parent', format, `^${held.pin}`]));
		if (added.length && added[added.length - 1]!.parent === held.pin) {
			listed = [...added, ...held.changes];
			reach = held.since;
		}
	}
	listed ??= parse(
		await git(root, ['log', pin, '--first-parent', format, ...(since === null ? [] : [`--since-as-filter=${new Date(since).toISOString()}`])]),
	);
	const known = new Map((held?.changes ?? []).map((change) => [change.sha, change.files]));
	const missing = listed.filter(({ sha }) => !known.has(sha));
	if (missing.length) {
		const diff = await git(
			root,
			['diff-tree', '--stdin', '-r', '--root', '--name-only', '--no-renames', '--always', '--format=%x1e%H'],
			missing.map(({ sha, parent }) => `${sha} ${parent}`.trim()).join('\n') + '\n',
		);
		for (const block of diff.split('\x1e')) {
			const [sha = '', ...files] = block.trim().split('\n');
			if (sha) known.set(sha.trim(), files.map((line) => line.trim()).filter(Boolean));
		}
	}
	const changes = listed.map((change) => ({ ...change, files: known.get(change.sha) ?? [] }));
	const heldAt = held ? changes.findIndex(({ sha }) => sha === held.pin) : -1;
	const touched = heldAt < 0 ? null : new Set(changes.slice(0, heldAt).flatMap(({ files }) => files));
	return { changes, touched, since: reach };
}

/** Whether `file` is one of `paths` or lies under one, as a literal pathspec of them matches it. */
function matchesPath(paths: ReadonlySet<string>, file: string): boolean {
	for (let end = file.length; end > 0; end = file.lastIndexOf('/', end - 1))
		if (paths.has(file.slice(0, end))) return true;
	return false;
}

type Pin = { sha: string; at: number };

/**
 * HEAD of `root` as one commit sha and its time in ms. A report reads every git call at this sha, because on 2026-10-25
 * sieun/dev moved four times while one report ran, so its log lacked 3d9cee54e0 while HEAD's text had it, and
 * apps/search/monitor-data-model.html read as behind `searchWatchedBrands` since an older commit that never changed it.
 */
async function pinHead(root: string): Promise<Pin> {
	const [sha = '', stamp = ''] = (await git(root, ['show', '-s', '--format=%H %ct', 'HEAD'])).trim().split(' ');
	return { sha, at: Number(stamp) * 1000 };
}

/**
 * When a definition fell behind and last changed, read from `after`, the commits after the check that touched its file, oldest
 * first: the first and newest that changed its text, or null when the pinned `head` text equals the text at the check. When the
 * text differs while no listed commit changed it, the change dates itself at the pinned commit, never at the oldest listed one.
 */
async function definitionDates(
	after: readonly FileCommit[],
	head: string,
	textAt: (rev: string) => Promise<string | null>,
	pin: Pin,
): Promise<{ first: number; newest: number } | null> {
	let previous = await textAt(`${after[0]!.sha}^1`);
	if (previous === head) return null;
	let first: number | undefined;
	let newest = pin.at;
	for (const { at, sha } of after) {
		const text = await textAt(sha);
		if (text !== previous) {
			first ??= at;
			newest = at;
		}
		previous = text;
	}
	return { first: first ?? pin.at, newest };
}

/**
 * When the definition `name` in `file` changed after `checked`, on the first-parent history of the pinned HEAD: the first and
 * newest commit that changed its text while the pinned text differs; `missing` when the pinned commit lacks it, null when
 * unchanged. A `sieun-pi:<path>::<name>` ref reads its repo this way.
 */
async function definitionChange(
	root: string,
	pin: Pin,
	file: string,
	name: string,
	checked: number,
): Promise<'missing' | { first: number; newest: number } | null> {
	const at = async (rev: string): Promise<string | null> =>
		definitionCode(await git(root, ['show', `${rev}:${file}`]).catch(() => null), name, file);
	const head = await at(pin.sha);
	if (head === null) return 'missing';
	const after = (
		await git(root, [
			'log',
			pin.sha,
			'--first-parent',
			'--format=%ct %H',
			`--since-as-filter=${Math.floor(checked / 1000)}`,
			'--',
			file,
		])
	)
		.split('\n')
		.map((line) => line.trim().split(' '))
		.filter(([stamp, sha]) => stamp && sha && Number(stamp) * 1000 > checked)
		.map(([stamp, sha]) => ({ at: Number(stamp) * 1000, sha: sha! }))
		.reverse();
	if (!after.length) return null;
	return definitionDates(after, head, at, pin);
}

export type FileCommit = { at: number; sha: string };

/** The commits in ms and sha of each file that `keep` accepts, in the order of `changes`. */
export function fileCommits(changes: readonly Change[], keep: (file: string) => boolean): Map<string, FileCommit[]> {
	const commits = new Map<string, FileCommit[]>();
	for (const { at, sha, files } of changes) {
		if (!Number.isFinite(at)) continue;
		for (const file of files.filter(keep)) {
			const list = commits.get(file) ?? [];
			list.push({ at, sha });
			commits.set(file, list);
		}
	}
	return commits;
}

export type StaleReport = {
	checkable: number;
	count: number;
	stale: Array<{
		path: string;
		title: string;
		last_verified: string;
		verified_at: string;
		staleRefs: StaleRef[];
	}>;
};

type Page = Awaited<ReturnType<typeof getWikiIndex>>['pages'][number];

/** Each sibling repo the pages cite, with its checkout and pinned HEAD, or null with no checkout here. */
type SiblingPins = Map<string, { root: string; pin: Pin } | null>;

/**
 * The files changed in sibling `name` since the state's `held` value, or null when its checkout or history moved elsewhere.
 * Every commit `old..new` counts, a superset of the first-parent commits a sibling ref reads.
 */
async function siblingTouched(held: string | undefined, now: { root: string; pin: Pin } | null): Promise<Set<string> | null> {
	const value = now ? `${now.root} ${now.pin.sha}` : '';
	if (held === value) return new Set();
	const [root, old] = (held ?? '').split(' ');
	if (!now || !old || root !== now.root) return null;
	const ancestor = await git(now.root, ['merge-base', '--is-ancestor', old, now.pin.sha]).then(
		() => true,
		() => false,
	);
	if (!ancestor) return null;
	const names = await git(now.root, ['log', '--format=', '--name-only', `${old}..${now.pin.sha}`]);
	return new Set(names.split('\n').map((line) => line.trim()).filter(Boolean));
}

/**
 * Pages whose `source_refs` changed after the page's check (`verifiedAt`), dated on the first-parent history of a HEAD pinned
 * once per report (pinHead), so file mtimes from a checkout count for nothing. `since` is the first commit after the check.
 * A `path::name` ref counts only commits that changed that definition's code (codeText), or for a table only its entries keyed by
 * the keys the page names (`entryKeys`), or for a class all but the fields added with a default the page does not name
 * (`memberKeys`), and only while the pinned code differs.
 * A commit that changes a ref and the page together counts as the page's check of that ref, since its writer updated the page with
 * the code, as the follow gate (scripts/follow-gate.mjs) asks. Until 2026-10-29 such a commit was dated after the page's minute
 * `last_verified`, and 109 of the 1,557 page flags in the 7 days to 2026-10-29 20:14Z came from a commit that had updated that page.
 * A whole-file or folder ref counts only commits that touch what the page states (`touchingChanges`). A ref the pinned tree
 * lacks reads as missing even when a gitignored file sits at its path, so its writer swaps it for a tracked file: until
 * 2026-10-29 such a ref was dated by mtime, and each materialize of apps/virev-demo rewrote
 * `apps/virev-demo/src/routes/dev/design/charts/+page.svelte` and flagged apps/search/enterprise-mock.html again, 4 times in
 * the 7 days to 2026-10-29 06:20Z. A `sieun-pi:<path>` whole-file or folder ref reads the same way on its sibling repo's first-parent
 * history (siblingCommits), and goes unmeasured with no checkout. Until 2026-11-08 it was dated by `git log -1` alone: in the 7 days
 * to 2026-11-08 12:47Z, 71 sieun-pi commits touched a file a curated page cites whole, 58 of them after a citing page's check, for
 * 66 page flags. d0799f3f changed only a comment and flagged 2 pages, and 6 more flags touched nothing their page states. Of these 8,
 * 5 ended in a `last_verified`-only recheck, 1 page fix had a `path::name` flag from the same commit, and 2 page fixes of
 * apps/llm-wiki/index.html added a fact the page had not named (after 0f695503 and d0799f3f).
 * A page's result is kept in the StaleState and reused while its meta, its text and every file it cites stay unchanged, so a
 * report reads git per page only for the pages a commit since the last report touched.
 * GET /api/agent/stale and wiki-health.mjs use it.
 */
export async function getStaleReport(
	repoRoot: string,
	app: string | null = null,
	siblings: Map<string, string> = siblingRepos(),
): Promise<StaleReport> {
	const index = await getWikiIndex();
	const candidates = index.pages.filter(
		(p) => !p.path.startsWith('@code/') && p.meta.last_verified && (p.meta.source_refs?.length ?? 0) > 0,
	);
	const checkable = candidates.filter((p) => !app || p.meta.apps.includes(app));
	const fileOf = (ref: string): string => symbolRef(ref)?.file ?? ref;
	const local = (ref: string): boolean => {
		const file = fileOf(ref);
		if (siblingRef(ref) || /^[a-z][a-z0-9+.-]*:/i.test(file)) return false;
		const full = path.resolve(repoRoot, file);
		return full !== repoRoot && full.startsWith(`${repoRoot}${path.sep}`);
	};
	// A ref into the wiki content by its old repo path names a page's own file, which left git with the content on
	// 2026-11-03: it resolves on disk under the content root, and no code commit dates it, so no state keeps it.
	const onDisk = (ref: string): boolean => fileOf(ref).startsWith(PAGES);
	const days = candidates.map((p) => dayStart(p.meta.last_verified!)).filter(Number.isFinite);
	const since = days.length ? Math.min(...days) : null;
	const store = await statePath(repoRoot);
	const [pin, held] = await Promise.all([pinHead(repoRoot), readState(store)]);
	const siblingNames = new Set(
		candidates.flatMap((p) => (p.meta.source_refs ?? []).map((ref) => siblingRef(ref)?.repo).filter((name) => name !== undefined)),
	);
	const siblingPins: SiblingPins = new Map(
		await Promise.all(
			[...siblingNames].map(async (name) => {
				const root = siblings.get(name);
				return [name, root ? { root, pin: await pinHead(root) } : null] as const;
			}),
		),
	);
	const [{ changes, touched, since: reach }, siblingChanges] = await Promise.all([
		firstParentChanges(repoRoot, pin.sha, since, held),
		Promise.all(
			[...siblingPins].map(async ([name, now]) => [name, await siblingTouched(held?.siblings[name], now)] as const),
		).then((rows) => new Map(rows)),
	]);

	const sources = new Map(
		await Promise.all(
			candidates.map(async (p) => [p.path, await readFile(diskPath(p.path), 'utf8').catch(() => '')] as const),
		),
	);
	const keyOf = (p: Page): string =>
		JSON.stringify([
			p.title,
			p.meta.last_verified,
			p.meta.source_refs,
			createHash('sha1').update(sources.get(p.path) ?? '').digest('hex'),
		]);
	const untouched = (p: Page): boolean => {
		if (!touched) return false;
		const cited = new Set([`${PAGES}${p.path}`]);
		for (const ref of p.meta.source_refs ?? []) {
			const sibling = siblingRef(ref);
			if (sibling) {
				const files = siblingChanges.get(sibling.repo);
				if (!files) return false;
				const file = (symbolRef(sibling.path)?.file ?? sibling.path).replace(/\/+$/, '');
				for (const changed of files) if (under(file, changed)) return false;
			} else if (local(ref) && !onDisk(ref)) cited.add(fileOf(ref).replace(/\/+$/, ''));
		}
		for (const changed of touched) if (matchesPath(cited, changed)) return false;
		return true;
	};
	const pages: Record<string, PageEntry> = {};
	for (const p of candidates) {
		const entry = held?.pages[p.path];
		const key = keyOf(p);
		if (entry && entry.key === key && untouched(p)) pages[p.path] = entry;
	}
	const todo = checkable.filter((p) => !pages[p.path]);
	if (todo.length) {
		const { evaluate, close } = await pageEvaluator(repoRoot, pin, changes, todo, siblingPins, sources, { fileOf, local, onDisk });
		try {
			for (const p of todo) pages[p.path] = { key: keyOf(p), ...(await evaluate(p)) };
		} finally {
			close();
		}
	}
	const siblingState = Object.fromEntries(
		[...siblingPins].map(([name, now]) => [name, now ? `${now.root} ${now.pin.sha}` : '']),
	);
	const next: StaleState = {
		version: STATE_VERSION,
		pin: pin.sha,
		since: reach,
		changes,
		siblings: siblingState,
		pages,
	};
	if (
		!held ||
		todo.length ||
		held.pin !== next.pin ||
		held.since !== next.since ||
		JSON.stringify(held.siblings) !== JSON.stringify(next.siblings) ||
		Object.keys(held.pages).length !== Object.keys(pages).length
	)
		await writeState(store, next);
	else states.set(store, held);

	const stale: StaleReport['stale'] = [];
	for (const p of checkable) {
		const entry = pages[p.path]!;
		const staleRefs = (p.meta.source_refs ?? []).flatMap((ref, i): StaleRef[] => {
			if (onDisk(ref) && !siblingRef(ref))
				return existsSync(diskPath(fileOf(ref).slice(PAGES.length))) ? [] : [{ ref, modified: MISSING }];
			return entry.refs[i] ? [entry.refs[i]!] : [];
		});
		if (staleRefs.length > 0)
			stale.push({
				path: p.path,
				title: p.title,
				last_verified: p.meta.last_verified!,
				verified_at: new Date(entry.verifiedAt).toISOString(),
				staleRefs,
			});
	}
	return { checkable: checkable.length, count: stale.length, stale };
}

type RepoReader = {
	definitionAt: (rev: string, file: string, name: string) => Promise<string | null>;
	codeAt: (rev: string, file: string) => Promise<string | null>;
	close: () => void;
};

/**
 * Reads of `rev:file` in `root`, each once per report: a definition's code (definitionCode) and a file's code with its comments and
 * docstrings removed (codeText), through one `git cat-file --batch` started at the first read.
 */
function repoReader(root: string): RepoReader {
	const versions = new Map<string, Promise<string | null>>();
	let blobs: ReturnType<typeof blobReader> | null = null;
	const definitions = new Map<string, Map<string, string | null>>();
	const versionAt = (rev: string, file: string): Promise<string | null> => {
		const key = `${rev}:${file}`;
		blobs ??= blobReader(root);
		if (!versions.has(key)) versions.set(key, blobs.read(key));
		return versions.get(key)!;
	};
	const definitionAt = async (rev: string, file: string, name: string): Promise<string | null> => {
		const text = await versionAt(rev, file);
		if (text === null || !text.includes(name)) return null;
		// Consecutive commits share a file's text, so one text's definitions are read once per name.
		const known = definitions.get(text) ?? new Map<string, string | null>();
		definitions.set(text, known);
		if (!known.has(name)) known.set(name, definitionCode(text, name, file));
		return known.get(name)!;
	};
	const codes = new Map<string, Promise<string | null>>();
	const codeAt = (rev: string, file: string): Promise<string | null> => {
		const key = `${rev}:${file}`;
		if (!codes.has(key))
			codes.set(
				key,
				versionAt(rev, file).then((text) => (text === null ? null : codeText(text, file))),
			);
		return codes.get(key)!;
	};
	return { definitionAt, codeAt, close: () => blobs?.close() };
}

/** A commit after a page's check that changed a whole-file or folder ref, with the files it changed under that ref. */
type RefCommit = { at: number; sha: string; files: string[] };

/**
 * The first-parent commits of `pin` in sibling checkout `root` after `checked` that changed `rel` or a file under it, oldest first,
 * each with its changed files against its first parent; null when the pinned tree lacks `rel`.
 */
async function siblingCommits(root: string, pin: string, rel: string, checked: number): Promise<RefCommit[] | null> {
	const file = rel.replace(/\/+$/, '');
	if (!(await git(root, ['ls-tree', '--name-only', pin, '--', file])).trim()) return null;
	const log = await git(root, [
		'log',
		pin,
		'--first-parent',
		'--diff-merges=first-parent',
		'--no-renames',
		'--name-only',
		'--format=%x1e%ct %H',
		`--since-as-filter=${Math.floor(checked / 1000)}`,
		'--',
		file,
	]);
	const after: RefCommit[] = [];
	for (const block of log.split('\x1e')) {
		const [head = '', ...files] = block.trim().split('\n');
		const [stamp, sha] = head.trim().split(' ');
		if (!stamp || !sha || Number(stamp) * 1000 <= checked) continue;
		after.push({ at: Number(stamp) * 1000, sha, files: files.map((line) => line.trim()).filter(Boolean) });
	}
	return after.reverse();
}

/**
 * The per-page check of getStaleReport for `todo`, reading git at `pin`: per `source_refs` entry the stale row or null, with
 * null for a ref into the wiki content (getStaleReport reads those on disk). `close` ends the `git cat-file --batch` of each repo it read.
 */
async function pageEvaluator(
	repoRoot: string,
	pin: Pin,
	changes: Change[],
	todo: Page[],
	siblingPins: SiblingPins,
	sources: Map<string, string>,
	{ fileOf, local, onDisk }: { fileOf: (ref: string) => string; local: (ref: string) => boolean; onDisk: (ref: string) => boolean },
): Promise<{ evaluate: (page: Page) => Promise<Omit<PageEntry, 'key'>>; close: () => void }> {
	const refs = [
		...new Set(todo.flatMap((p) => (p.meta.source_refs ?? []).filter((ref) => local(ref) && !onDisk(ref)).map(fileOf))),
	];
	const tree = refs.length ? await git(repoRoot, ['ls-tree', '-r', '-z', '--name-only', pin.sha, '--', ...refs]) : '';
	const watched = new Set([...refs.map((ref) => ref.replace(/\/+$/, '')), ...todo.map((p) => `${PAGES}${p.path}`)]);
	const commits = fileCommits(changes, (file) => matchesPath(watched, file));
	const filesOf = new Map<string, string[]>();
	for (const [file, list] of commits)
		for (const { sha } of list) {
			const files = filesOf.get(sha);
			if (files) files.push(file);
			else filesOf.set(sha, [file]);
		}
	const tracked = new Set(tree.split('\0').filter(Boolean));
	const trackedUnder = (file: string): boolean => [...tracked].some((entry) => under(file, entry));
	const readers = new Map<string, RepoReader>();
	const readerOf = (root: string): RepoReader => {
		let reader = readers.get(root);
		if (!reader) readers.set(root, (reader = repoReader(root)));
		return reader;
	};
	const { definitionAt } = readerOf(repoRoot);
	const sourceOf = (page: string): string => sources.get(page) ?? '';
	/** The commits of the code repo after `checked` that changed a whole-file or folder `ref`, oldest first. */
	const localCommits = (ref: string, checked: number): RefCommit[] => {
		const byCommit = new Map<string, RefCommit>();
		for (const [file, list] of commits)
			if (under(ref, file))
				for (const { at, sha } of list)
					if (at > checked) {
						const row = byCommit.get(sha) ?? { at, sha, files: [] };
						row.files.push(file);
						byCommit.set(sha, row);
					}
		return [...byCommit.values()].sort((a, b) => a.at - b.at);
	};
	/**
	 * The times, oldest first, of the commits in `after` that changed a whole-file or folder `ref` in a way the page states, read
	 * from the repo of `reader`. A commit
	 * touches the page when the page cites line numbers of the ref, since a comment cut moves them too, else when it changed the code
	 * of a file (`codeText`, comments and docstrings removed) and a changed code line holds a distinctive word or a whole path of the
	 * page's `<code>` spans (`linesTouch`), the code of a definition the page names changed, or the page cites neither. On the 2026-10-26 comment
	 * sweep (23:20Z to 00:18Z) that cut comments only, a replay at c842f86a0c read 116 pages as behind code before this filter and 11 after it.
	 */
	const touchingChanges = async (
		pagePath: string,
		ref: string,
		after: readonly RefCommit[],
		{ codeAt, definitionAt }: RepoReader,
	): Promise<number[]> => {
		if (!after.length) return [];
		const source = sourceOf(pagePath);
		const cited = citedWords(source);
		if (citesLines(source, ref)) return after.map(({ at }) => at);
		const touching: number[] = [];
		for (const { at, sha, files } of after) {
			let touches = false;
			for (const file of files) {
				if (touches) break;
				const before = await codeAt(`${sha}^1`, file);
				const code = await codeAt(sha, file);
				if (before === code) continue;
				touches = linesTouch(changedLines(before, code), cited);
				for (const name of cited.names) {
					if (touches) break;
					if ((await definitionAt(`${sha}^1`, file, name)) !== (await definitionAt(sha, file, name))) {
						touches = true;
						break;
					}
				}
			}
			if (touches) touching.push(at);
		}
		return touching;
	};
	const touchingRow = (ref: string, touching: number[]): StaleRef | null =>
		touching.length
			? {
					ref,
					modified: new Date(touching[touching.length - 1]!).toISOString(),
					since: new Date(touching[0]!).toISOString(),
				}
			: null;

	const evaluate = async (page: Page): Promise<Omit<PageEntry, 'key'>> => {
		const pageCommits = commits.get(`${PAGES}${page.path}`) ?? [];
		const checked = verifiedAt(
			page.meta.last_verified!,
			pageCommits.map(({ at }) => at),
		);
		// A commit that changes cited code and the page together is the page's own update of that code.
		const checkedFor = (ref: string): number => {
			let at = checked;
			for (const own of pageCommits)
				if ((filesOf.get(own.sha) ?? []).some((file) => under(ref, file))) at = Math.max(at, own.at);
			return at;
		};
		const refRow = async (ref: string): Promise<StaleRef | null> => {
			const sibling = siblingRef(ref);
			if (sibling) {
				const at = siblingPins.get(sibling.repo);
				if (!at) return null;
				const siblingSymbol = symbolRef(sibling.path);
				if (siblingSymbol) {
					const change = await definitionChange(at.root, at.pin, siblingSymbol.file, siblingSymbol.name, checked);
					if (change === 'missing') return { ref, modified: MISSING };
					return change
						? { ref, modified: new Date(change.newest).toISOString(), since: new Date(change.first).toISOString() }
						: null;
				}
				const after = await siblingCommits(at.root, at.pin.sha, sibling.path, checked);
				if (after === null) return { ref, modified: MISSING };
				return touchingRow(ref, await touchingChanges(page.path, sibling.path, after, readerOf(at.root)));
			}
			if (onDisk(ref) || !local(ref)) return null;
			const symbol = symbolRef(ref);
			const file = fileOf(ref);
			if (symbol && tracked.has(file)) {
				const head = await definitionAt(pin.sha, file, symbol.name);
				if (head === null) return { ref, modified: MISSING };
				const since = checkedFor(file);
				const after = (commits.get(file) ?? []).filter(({ at }) => at > since).reverse();
				if (!after.length) return null;
				const atCheck = await definitionAt(`${after[0]!.sha}^1`, file, symbol.name);
				const follow = followed(sourceOf(page.path), atCheck);
				const textAt = async (rev: string): Promise<string | null> =>
					follow(await definitionAt(rev, file, symbol.name));
				const change = await definitionDates(after, follow(head)!, textAt, pin);
				return change
					? { ref, modified: new Date(change.newest).toISOString(), since: new Date(change.first).toISOString() }
					: null;
			}
			if (trackedUnder(file)) {
				return touchingRow(ref, await touchingChanges(page.path, ref, localCommits(ref, checkedFor(ref)), readerOf(repoRoot)));
			}
			return { ref, modified: MISSING };
		};
		const rows: Array<StaleRef | null> = [];
		for (const ref of page.meta.source_refs ?? []) rows.push(await refRow(ref));
		return { verifiedAt: checked, refs: rows };
	};
	return {
		evaluate,
		close: () => {
			for (const reader of readers.values()) reader.close();
		},
	};
}
