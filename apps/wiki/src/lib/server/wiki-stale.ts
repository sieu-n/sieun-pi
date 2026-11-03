import { execFile, spawn } from 'node:child_process';
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

export type Change = { at: number; sha: string; files: string[] };

/**
 * The first-parent commits of `pin` in `root` since `since`, newest first, each with every file it changed against its first parent.
 * A commit's files never change, so they are kept by sha in the git dir (`wiki-stale/first-parent-files.json`), and git diffs only
 * the commits no earlier report saw. On 2026-11-02 one `git log --name-only` over 1,737 pathspecs (1,521 refs and 216 pages) and
 * the 20,024 first-parent commits since 2026-10-19 took 514 s of a 531 s report on us-metal02 at load 139 to 218, and the
 * same log with no pathspec took 42 s at load 100.
 */
async function firstParentChanges(root: string, pin: string, since: string[]): Promise<Change[]> {
	const listed = (await git(root, ['log', pin, '--first-parent', '--format=%ct %H %P', ...since]))
		.split('\n')
		.map((line) => line.trim().split(' '))
		.filter(([stamp, sha]) => stamp && sha);
	const store = path.resolve(
		root,
		(await git(root, ['rev-parse', '--git-path', 'wiki-stale/first-parent-files.json'])).trim(),
	);
	const known: Record<string, string[]> = await readFile(store, 'utf8')
		.then((text) => JSON.parse(text))
		.catch(() => ({}));
	const missing = listed.filter(([, sha]) => !known[sha!]);
	if (missing.length) {
		const diff = await git(
			root,
			['diff-tree', '--stdin', '-r', '--root', '--name-only', '--no-renames', '--always', '--format=%x1e%H'],
			missing.map(([, sha, parent]) => `${sha} ${parent ?? ''}`.trim()).join('\n') + '\n',
		);
		for (const block of diff.split('\x1e')) {
			const [sha = '', ...files] = block.trim().split('\n');
			if (sha) known[sha.trim()] = files.map((line) => line.trim()).filter(Boolean);
		}
		const kept = Object.fromEntries(listed.map(([, sha]) => [sha, known[sha!] ?? []]));
		await mkdir(path.dirname(store), { recursive: true });
		const temp = `${store}.${process.pid}`;
		await writeFile(temp, JSON.stringify(kept));
		await rename(temp, store);
	}
	return listed.map(([stamp, sha]) => ({ at: Number(stamp) * 1000, sha: sha!, files: known[sha!] ?? [] }));
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

/** The time in ms of the newest commit at `pin` of `root` that touched `rel`, or null when the pinned tree has no such path. */
async function commitTime(root: string, pin: string, rel: string): Promise<number | null> {
	const file = rel.replace(/\/+$/, '');
	if (!(await git(root, ['ls-tree', '--name-only', pin, '--', file])).trim()) return null;
	return Number((await git(root, ['log', '-1', '--format=%ct', pin, '--', file])).trim()) * 1000;
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
			`--since=${Math.floor(checked / 1000)}`,
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
		staleRefs: Array<{ ref: string; modified: string; since?: string }>;
	}>;
};

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
 * the 7 days to 2026-10-29 06:20Z. A `sieun-pi:<path>` ref is dated by its sibling repo, unmeasured with no checkout.
 * GET /api/agent/stale and wiki-health.mjs use it.
 */
export async function getStaleReport(
	repoRoot: string,
	app: string | null = null,
	siblings: Map<string, string> = siblingRepos(),
): Promise<StaleReport> {
	const index = await getWikiIndex();
	const checkable = index.pages.filter(
		(p) =>
			!p.path.startsWith('@code/') &&
			p.meta.last_verified &&
			(p.meta.source_refs?.length ?? 0) > 0 &&
			(!app || p.meta.apps.includes(app)),
	);
	const fileOf = (ref: string): string => symbolRef(ref)?.file ?? ref;
	const local = (ref: string): boolean => {
		const file = fileOf(ref);
		if (siblingRef(ref) || /^[a-z][a-z0-9+.-]*:/i.test(file)) return false;
		const full = path.resolve(repoRoot, file);
		return full !== repoRoot && full.startsWith(`${repoRoot}${path.sep}`);
	};
	const refs = [...new Set(checkable.flatMap((p) => (p.meta.source_refs ?? []).filter(local).map(fileOf)))];
	const days = checkable.map((p) => dayStart(p.meta.last_verified!)).filter(Number.isFinite);
	const since = days.length ? [`--since=${new Date(Math.min(...days)).toISOString()}`] : [];
	const pageFiles = checkable.map((p) => `${PAGES}${p.path}`);
	const pin = await pinHead(repoRoot);
	const siblingPins = new Map<string, Promise<Pin>>();
	const siblingPin = (root: string): Promise<Pin> => {
		if (!siblingPins.has(root)) siblingPins.set(root, pinHead(root));
		return siblingPins.get(root)!;
	};
	const [changes, tree] = await Promise.all([
		firstParentChanges(repoRoot, pin.sha, since),
		refs.length ? git(repoRoot, ['ls-tree', '-r', '-z', '--name-only', pin.sha, '--', ...refs]) : Promise.resolve(''),
	]);
	const watched = new Set([...refs.map((ref) => ref.replace(/\/+$/, '')), ...pageFiles]);
	const commits = fileCommits(changes, (file) => matchesPath(watched, file));
	const filesOf = new Map<string, string[]>();
	for (const [file, list] of commits)
		for (const { sha } of list) {
			const files = filesOf.get(sha);
			if (files) files.push(file);
			else filesOf.set(sha, [file]);
		}
	const tracked = tree.split('\0').filter(Boolean);
	const versions = new Map<string, Promise<string | null>>();
	const blobs = blobReader(repoRoot);
	const definitions = new Map<string, Map<string, string | null>>();
	const versionAt = (rev: string, file: string): Promise<string | null> => {
		const key = `${rev}:${file}`;
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

	const sources = new Map<string, Promise<string>>();
	const sourceOf = (page: string): Promise<string> => {
		if (!sources.has(page))
			sources.set(
				page,
				readFile(diskPath(page), 'utf8').catch(() => ''),
			);
		return sources.get(page)!;
	};
	/**
	 * The times, oldest first, of the commits after `checked` that changed a whole-file or folder `ref` in a way the page states. A commit
	 * touches the page when the page cites line numbers of the ref, since a comment cut moves them too, else when it changed the code
	 * of a file (`codeText`, comments and docstrings removed) and a changed code line holds a distinctive word or a whole path of the
	 * page's `<code>` spans (`linesTouch`), the code of a definition the page names changed, or the page cites neither. On the 2026-10-26 comment
	 * sweep (23:20Z to 00:18Z) that cut comments only, a replay at c842f86a0c read 116 pages as behind code before this filter and 11 after it.
	 */
	const touchingChanges = async (pagePath: string, ref: string, checked: number): Promise<number[]> => {
		const byCommit = new Map<string, { at: number; files: string[] }>();
		for (const [file, list] of commits)
			if (under(ref, file))
				for (const { at, sha } of list)
					if (at > checked) {
						const row = byCommit.get(sha) ?? { at, files: [] };
						row.files.push(file);
						byCommit.set(sha, row);
					}
		const after = [...byCommit].sort((a, b) => a[1].at - b[1].at);
		if (!after.length) return [];
		const source = await sourceOf(pagePath);
		const cited = citedWords(source);
		if (citesLines(source, ref)) return after.map(([, row]) => row.at);
		const touching: number[] = [];
		for (const [sha, { at, files }] of after) {
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

	const stale: StaleReport['stale'] = [];
	for (const page of checkable) {
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
		const staleRefs: Array<{ ref: string; modified: string; since?: string }> = [];
		for (const ref of page.meta.source_refs ?? []) {
			const sibling = siblingRef(ref);
			if (sibling) {
				const root = siblings.get(sibling.repo);
				if (!root) continue;
				const siblingSymbol = symbolRef(sibling.path);
				if (siblingSymbol) {
					const change = await definitionChange(
						root,
						await siblingPin(root),
						siblingSymbol.file,
						siblingSymbol.name,
						checked,
					);
					if (change === 'missing') staleRefs.push({ ref, modified: MISSING });
					else if (change)
						staleRefs.push({
							ref,
							modified: new Date(change.newest).toISOString(),
							since: new Date(change.first).toISOString(),
						});
					continue;
				}
				const at = await commitTime(root, (await siblingPin(root)).sha, sibling.path);
				if (at === null) staleRefs.push({ ref, modified: MISSING });
				else if (at > checked) staleRefs.push({ ref, modified: new Date(at).toISOString() });
				continue;
			}
			// A ref into the wiki content by its old repo path names a page's own file, which left git with the content on
			// 2026-11-03: it resolves on disk under the content root, and no code commit dates it.
			if (fileOf(ref).startsWith(PAGES)) {
				if (!existsSync(diskPath(fileOf(ref).slice(PAGES.length)))) staleRefs.push({ ref, modified: MISSING });
				continue;
			}
			if (!local(ref)) continue;
			const symbol = symbolRef(ref);
			const file = fileOf(ref);
			if (symbol && tracked.includes(file)) {
				const head = await definitionAt(pin.sha, file, symbol.name);
				if (head === null) {
					staleRefs.push({ ref, modified: MISSING });
					continue;
				}
				const since = checkedFor(file);
				const after = (commits.get(file) ?? []).filter(({ at }) => at > since).reverse();
				if (!after.length) continue;
				const atCheck = await definitionAt(`${after[0]!.sha}^1`, file, symbol.name);
				const follow = followed(await sourceOf(page.path), atCheck);
				const textAt = async (rev: string): Promise<string | null> =>
					follow(await definitionAt(rev, file, symbol.name));
				const change = await definitionDates(after, follow(head)!, textAt, pin);
				if (change)
					staleRefs.push({
						ref,
						modified: new Date(change.newest).toISOString(),
						since: new Date(change.first).toISOString(),
					});
				continue;
			}
			if (tracked.some((entry) => under(file, entry))) {
				const touching = await touchingChanges(page.path, ref, checkedFor(ref));
				if (touching.length)
					staleRefs.push({
						ref,
						modified: new Date(touching[touching.length - 1]!).toISOString(),
						since: new Date(touching[0]!).toISOString(),
					});
				continue;
			}
			staleRefs.push({ ref, modified: MISSING });
		}
		if (staleRefs.length > 0) {
			stale.push({
				path: page.path,
				title: page.title,
				last_verified: page.meta.last_verified!,
				verified_at: new Date(checked).toISOString(),
				staleRefs,
			});
		}
	}
	blobs.close();
	return { checkable: checkable.length, count: stale.length, stale };
}
