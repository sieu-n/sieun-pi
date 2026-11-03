/**
 * Which commits change what a curated wiki page states through its `source_refs`, read by the rules the stale report
 * (src/lib/server/wiki-stale.ts) applies to each commit after a page's check (src/lib/stale-rules.mjs). The follow gate
 * (follow-gate.mjs) judges the one commit a session is about to write with refBehind, and names with commitsBehind the older
 * commits a page already fell behind, and the page gate (page-gate.mjs) names with commitsBehind the commits a write's later
 * `last_verified` would hide from the stale report.
 */
import { spawnSync } from 'node:child_process';
import { codeText } from '../src/lib/code-text.mjs';
import { definitionCode, symbolRef } from '../src/lib/definitions.mjs';
import { siblingRef } from '../src/lib/sibling-repos.mjs';
import { changedLines, citedWords, citesLines, dayStart, followed, linesTouch, under, verifiedAt } from '../src/lib/stale-rules.mjs';
import { parseMeta } from './wiki-health.mjs';

const CONTENT = 'apps/llm-wiki/content/';

function git(root, args) {
	const run = spawnSync('git', ['--literal-pathspecs', '-C', root, ...args], { maxBuffer: Infinity });
	if (run.error || run.status !== 0)
		throw new Error(`git ${args[0]} failed: ${String(run.stderr ?? run.error).trim()}`);
	return String(run.stdout);
}

/** The text of each `rev:path` spec, read with one `git cat-file --batch` process; a spec git lacks is left out. */
export function blobsAt(root, specs) {
	const texts = new Map();
	if (!specs.length) return texts;
	const run = spawnSync('git', ['-C', root, 'cat-file', '--batch'], { input: specs.join('\n') + '\n', maxBuffer: Infinity });
	if (run.error || run.status !== 0) throw new Error(`git cat-file failed: ${String(run.stderr ?? run.error).trim()}`);
	const out = run.stdout;
	let at = 0;
	for (const spec of specs) {
		const eol = out.indexOf(10, at);
		const header = String(out.subarray(at, eol));
		at = eol + 1;
		if (header.endsWith(' missing') || header.endsWith(' ambiguous')) continue;
		const size = Number(header.split(' ')[2]);
		texts.set(spec, String(out.subarray(at, at + size)));
		at += size + 1;
	}
	return texts;
}

/**
 * Whether one commit from `before` to `after` changes what the page `html` states through its cited `ref`, read by the rules the
 * stale report (wiki-stale.ts) applies to each commit after a page's check: a `path::name` ref when the code of that definition
 * changed, or for a table only the entries the page names, or for a class all but a field added with a default the page does not
 * name; a whole-file or folder ref when the page cites its line numbers, or a
 * changed code line holds a distinctive word or a whole path of the page's `<code>` spans, or a definition the page names changed.
 */
export function refBehind(html, ref, changed, before, after, read) {
	const symbol = symbolRef(ref);
	if (siblingRef(ref) || /^[a-z][a-z0-9+.-]*:/i.test(symbol?.file ?? ref)) return false;
	const files = changed.filter((file) => under(symbol?.file ?? ref, file));
	if (!files.length) return false;
	const definitionAt = (rev, file, name) => definitionCode(read(rev, file), name, file);
	if (symbol) {
		const was = definitionAt(before, symbol.file, symbol.name);
		const now = definitionAt(after, symbol.file, symbol.name);
		if (was === null || now === null) return false;
		const follow = followed(html, was);
		return follow(was) !== follow(now);
	}
	const lines = citesLines(html, ref);
	const cited = citedWords(html);
	return files.some((file) => {
		if (lines) return read(before, file) !== read(after, file);
		const was = read(before, file);
		const now = read(after, file);
		const wasCode = was === null ? null : codeText(was, file);
		const nowCode = now === null ? null : codeText(now, file);
		if (wasCode === nowCode) return false;
		if (linesTouch(changedLines(wasCode, nowCode), cited)) return true;
		return [...cited.names].some((name) => definitionAt(before, file, name) !== definitionAt(after, file, name));
	});
}

/** The repo file or folder a `source_refs` entry names in this repo, or null for a sibling repo or a URL. */
function localFile(ref) {
	if (typeof ref !== 'string' || siblingRef(ref)) return null;
	const file = symbolRef(ref)?.file ?? ref;
	return /^[a-z][a-z0-9+.-]*:/i.test(file) ? null : file.replace(/\/+$/, '');
}

/**
 * When the page `page` (a content path) was checked against the code, in ms, as the stale report reads `lastVerified`
 * (verifiedAt): a bare day is dated by the page's newest first-parent commit of `rev` on that day, or by `writtenAt` (ms), the
 * time a write that carries the day lands.
 */
export function checkedAt(root, rev, page, lastVerified, writtenAt) {
	if (lastVerified.includes('T')) return verifiedAt(lastVerified);
	const stamps = git(root, ['log', '--first-parent', '--format=%ct', `--since=${dayStart(lastVerified) / 1000}`, rev, '--', `${CONTENT}${page}`])
		.split('\n')
		.filter(Boolean)
		.map((stamp) => Number(stamp) * 1000);
	return verifiedAt(lastVerified, writtenAt === undefined ? stamps : [writtenAt, ...stamps]);
}

/**
 * The first-parent commits of `rev` after `checked` and up to `until` (both ms) that change what the page `page` (`html`) states
 * through a `source_refs` entry, by refBehind, oldest first, as `{ sha, at }` with `at` in ms. A commit that changed a ref and the
 * page together is the page's own check of that ref, and a `path::name` ref whose definition `rev` holds as it was at the check
 * counts no commit, as the stale report dates both (checkedFor and definitionDates in wiki-stale.ts).
 */
export function commitsBehind(root, rev, page, html, checked, until = Infinity) {
	const refs = (parseMeta(html)?.source_refs ?? []).filter((ref) => localFile(ref) !== null);
	const files = [...new Set(refs.map(localFile))];
	if (!files.length) return [];
	const pageFile = `${CONTENT}${page}`;
	const since = `--since=${Math.floor(checked / 1000)}`;
	const commits = git(root, ['log', '--first-parent', '--format=%x1e%ct %H', '--name-only', since, rev, '--', ...files, pageFile])
		.split('\x1e')
		.map((block) => block.trim().split('\n'))
		.filter(([head]) => head)
		.map(([head, ...changed]) => {
			const [stamp, sha] = head.split(' ');
			return { sha, at: Number(stamp) * 1000, files: changed.map((file) => file.trim()).filter(Boolean) };
		})
		.filter(({ at }) => at > checked && at <= until)
		.reverse();
	if (!commits.length) return [];
	const checkedFor = (file) =>
		commits
			.filter((c) => c.files.includes(pageFile) && c.files.some((changed) => under(file, changed)))
			.reduce((at, c) => Math.max(at, c.at), checked);
	const code = commits.map((c) => ({ ...c, files: c.files.filter((file) => file !== pageFile) }));
	const heads = refs.filter((ref) => symbolRef(ref)).map((ref) => `${rev}:${symbolRef(ref).file}`);
	const texts = blobsAt(root, [
		...new Set([...heads, ...code.flatMap((c) => c.files.flatMap((file) => [`${c.sha}^1:${file}`, `${c.sha}:${file}`]))]),
	]);
	const read = (at, file) => texts.get(`${at}:${file}`) ?? null;
	const counted = refs.filter((ref) => {
		const symbol = symbolRef(ref);
		if (!symbol) return true;
		const first = code.find((c) => c.at > checkedFor(symbol.file) && c.files.includes(symbol.file));
		if (!first) return false;
		const atCheck = definitionCode(read(`${first.sha}^1`, symbol.file), symbol.name, symbol.file);
		const follow = followed(html, atCheck);
		return follow(atCheck) !== follow(definitionCode(read(rev, symbol.file), symbol.name, symbol.file));
	});
	return code
		.filter((c) =>
			counted.some(
				(ref) => c.at > checkedFor(localFile(ref)) && refBehind(html, ref, c.files, `${c.sha}^1`, c.sha, read),
			),
		)
		.map(({ sha, at }) => ({ sha, at }));
}
