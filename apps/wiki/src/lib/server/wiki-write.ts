/**
 * The wiki write path: str_replace edits and full-content creates, each logged as a SQLite revision with a unified diff.
 * The EDITABLE gate lives in the route; this module confines paths to content/, rejects @code/ and allows page extensions only.
 */
import { statSync } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { normalizeLinkTarget, normalizeRequestedPath, PAGE_READ_LIMIT, readLimitFor } from './wiki';
import { extractHtmlTitle, META_COMMENT, parseHtmlMeta } from './wiki-html';
import { hubsLinking, isCuratedPath, missingHubRow, isRetiredStatus, retiredLinksAdded, titleMatchesH1 } from './wiki-lint';
import { addRevision, currentVersion } from './wiki-store';
import { deadLinkReason, deadLinksAdded, pageWriteReasons, pageWriteWarnings } from '../../../scripts/page-gate.mjs';
import { staleWrite } from './stale-base.mjs';
import { mermaidWriteCheck } from '../../../scripts/mermaid-check.mjs';
import { renumberLists } from '../../../scripts/ol-numbering.mjs';
import { codeRepoDir, contentGitRoot } from '../wiki-config.mjs';
import { diskPath, rootOf } from './wiki-mounts';
import { isSessionPath, sessionFolderOf as folderOfSession } from './session-artifact-index';
import { shouldSkip } from './wiki-paths';

const WRITABLE = /\.(md|mdx|txt|ya?ml|json|html)$/i;

export class WriteError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
	}
}

export type Edit = { old_string: string; new_string: string; replace_all?: boolean };

/** Apply str_replace edits in order. old_string must match exactly once (unless replace_all) — ambiguity is an error, never a guess. */
export function applyEdits(content: string, edits: Edit[]): { content: string; applied: number } {
	let out = content;
	edits.forEach((edit, i) => {
		if (typeof edit.old_string !== 'string' || typeof edit.new_string !== 'string')
			throw new WriteError(400, `edit ${i}: need string old_string + new_string`);
		if (edit.old_string === edit.new_string) throw new WriteError(400, `edit ${i}: old_string equals new_string`);
		const first = out.indexOf(edit.old_string);
		if (first === -1) throw new WriteError(422, `edit ${i}: old_string not found`);
		if (edit.replace_all) {
			out = out.split(edit.old_string).join(edit.new_string);
			return;
		}
		const second = out.indexOf(edit.old_string, first + edit.old_string.length);
		if (second !== -1)
			throw new WriteError(422, `edit ${i}: old_string is not unique — add surrounding context or set replace_all`);
		out = out.slice(0, first) + edit.new_string + out.slice(first + edit.old_string.length);
	});
	return { content: out, applied: edits.length };
}

/** Common head/tail line trim — the shared core of the diff and its accounting. */
function trimCommon(before: string, after: string): { head: number; aMid: string[]; bMid: string[] } {
	const a = before.split('\n');
	const b = after.split('\n');
	let head = 0;
	while (head < a.length && head < b.length && a[head] === b[head]) head += 1;
	let tail = 0;
	while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail])
		tail += 1;
	return { head, aMid: a.slice(head, a.length - tail), bMid: b.slice(head, b.length - tail) };
}

/** Minimal unified diff: trim common head/tail lines, emit the changed middle as one hunk. */
export function unifiedDiff(before: string, after: string, label: string): string {
	if (before === after) return '';
	const { head, aMid, bMid } = trimCommon(before, after);
	const hunk = [
		`--- a/${label}`,
		`+++ b/${label}`,
		`@@ -${head + 1},${aMid.length} +${head + 1},${bMid.length} @@`,
		...aMid.map((l) => `-${l}`),
		...bMid.map((l) => `+${l}`),
	];
	return hunk.join('\n');
}

/**
 * The length of the shortest line edit script from a to b (Myers 1986, the greedy forward pass), in O(N+M) memory and
 * O((N+M)D) time. Only the length is needed, so no trace is kept.
 */
function editDistance(a: string[], b: string[]): number {
	const ids = new Map<string, number>();
	const id = (line: string) => ids.get(line) ?? (ids.set(line, ids.size), ids.size - 1);
	const x = Int32Array.from(a, id);
	const y = Int32Array.from(b, id);
	const n = x.length;
	const m = y.length;
	const max = n + m;
	const v = new Int32Array(2 * max + 2);
	for (let d = 0; d <= max; d += 1) {
		for (let k = -d; k <= d; k += 2) {
			let i = k === -d || (k !== d && v[max + k - 1] < v[max + k + 1]) ? v[max + k + 1] : v[max + k - 1] + 1;
			let j = i - k;
			while (i < n && j < m && x[i] === y[j]) {
				i += 1;
				j += 1;
			}
			v[max + k] = i;
			if (i >= n && j >= m) return d;
		}
	}
	return max;
}

/**
 * Edit-log accounting: the lines a shortest line diff adds and removes, plus byte sizes, for a revision record. Until
 * 2026-11-04 it counted every line between the first and the last change, so apps/llm-wiki/index.html v59 logged 577
 * added and 560 removed for an edit near each end of the page.
 */
export function changeStats(
	before: string,
	after: string,
): { linesAdded: number; linesRemoved: number; bytesBefore: number; bytesAfter: number } {
	const { aMid, bMid } = before === after ? { aMid: [], bMid: [] } : trimCommon(before, after);
	// A line the other side lacks can never match, so dropping it first leaves the longest common subsequence as it was
	// and makes a full rewrite cost no diff work (a 3000-line rewrite took 808 ms in editDistance without this).
	const inB = new Set(bMid);
	const inA = new Set(aMid);
	const a = aMid.filter((line) => inB.has(line));
	const b = bMid.filter((line) => inA.has(line));
	const common = (a.length + b.length - editDistance(a, b)) / 2;
	return {
		linesAdded: bMid.length - common,
		linesRemoved: aMid.length - common,
		bytesBefore: Buffer.byteLength(before),
		bytesAfter: Buffer.byteLength(after),
	};
}

/** Read a page's current bytes straight from disk (not the 5s-cached index) so writes are consistent. null if it doesn't exist. */
export async function readForEdit(rawPath: string): Promise<string | null> {
	const { full } = resolveWritePath(rawPath);
	try {
		return await readFile(full, 'utf8');
	} catch (error) {
		if ((error as { code?: string }).code === 'ENOENT') return null;
		throw error;
	}
}

/** The session folder (`sessions/YYYY/MM/DD/hhmm-slug`, or the same under `agents/<agent>/jobs/`) that owns a path under it, or null. */
export const sessionFolderOf = folderOfSession;

/** A session folder's artifacts are writable while its `index.html` log is open and frozen after close. */
export async function assertSessionWorkspaceWritable(rel: string): Promise<void> {
	const folder = sessionFolderOf(rel);
	if (!folder || rel === `${folder}/index.html`) {
		throw new WriteError(
			403,
			'session logs are API-managed — POST /api/agent/sessions (+ /events, /close); artifacts go next to the log as sessions/<id>/<file>',
		);
	}
	const log = await readForEdit(`${folder}/index.html`);
	if (log === null) {
		throw new WriteError(403, `no session at ${folder} — open one first (POST /api/agent/sessions)`);
	}
	if (parseHtmlMeta(log).status !== 'open') {
		throw new WriteError(403, `session ${folder} is closed — its folder is frozen`);
	}
}

/** Repo prefixes a writer puts in front of a page path by mistake, longest first. */
const REPO_PREFIXES = ['apps/llm-wiki/content/', 'content/'];

/**
 * Page paths are content-relative. A path given as `apps/llm-wiki/content/sessions/...` lands
 * in a nested `content/apps/llm-wiki/content/` copy that skips the sessions/ guard, so refuse
 * the prefix and name the path to use instead.
 */
export function assertContentRelative(rel: string): void {
	const prefix = REPO_PREFIXES.find((p) => rel.startsWith(p));
	if (!prefix) return;
	throw new WriteError(
		400,
		`path "${rel}" starts with the repo prefix "${prefix}". Page paths are relative to ` +
			`apps/llm-wiki/content/, so write "${rel.slice(prefix.length)}" instead`,
	);
}

function resolveWritePath(rawPath: string): { rel: string; full: string } {
	let rel: string;
	try {
		rel = normalizeRequestedPath(rawPath);
	} catch {
		throw new WriteError(400, 'invalid path');
	}
	assertContentRelative(rel);
	if (rel.startsWith('@code/')) throw new WriteError(403, '@code/ mirrors repo source docs and is read-only');
	if (!WRITABLE.test(rel)) throw new WriteError(400, 'only .md/.mdx/.txt/.yaml/.yml/.json/.html are writable');
	const { root, relative } = rootOf(rel);
	const full = path.resolve(root, relative);
	if (full !== root && !full.startsWith(`${root}${path.sep}`)) throw new WriteError(400, 'path escapes content root');
	return { rel, full };
}

/** Write full content to a page, logging a revision + diff. baseVersion (if given) is checked for optimistic concurrency. */
export async function commitPage(input: {
	rawPath: string;
	content: string;
	author?: string;
	summary?: string;
	baseVersion?: number | null;
	/** Set only by the sessions API — sessions/ pages have their own append-only write path. */
	allowSessions?: boolean;
	/** Opt out of the read-cap truncation guard — only for a deliberate tail-deletion. */
	allowTruncate?: boolean;
	/** Refuse full content made from an older committed copy (staleCopyReason); a write that sends baseVersion skips it. */
	refuseStaleCopy?: boolean;
}): Promise<{
	path: string;
	version: number;
	bytes: number;
	diff: string;
	linesAdded: number;
	linesRemoved: number;
	/** False when the content equals the stored page: the answer names the current version and no revision is logged. */
	changed: boolean;
	/** Page gate warnings (rules 6 and 7): a source_ref this write adds, or a commit its new last_verified hides, changed after the page's last_verified; a broken mermaid block the page already held; a page the write leaves past its whole-read cap; and a created curated page no hub lists. */
	warnings?: string[];
}> {
	const { rel, full } = resolveWritePath(input.rawPath);
	if (isSessionPath(rel) && !input.allowSessions) await assertSessionWorkspaceWritable(rel);
	if (input.baseVersion !== undefined && input.baseVersion !== null) {
		const cur = currentVersion(rel);
		if (cur !== input.baseVersion)
			throw new WriteError(409, `stale: baseVersion ${input.baseVersion} != current ${cur}`);
	}
	let before = '';
	let exists = false;
	try {
		before = await readFile(full, 'utf8');
		exists = true;
	} catch (error) {
		if ((error as { code?: string }).code !== 'ENOENT') throw error; // missing = new file; anything else is real
	}
	// archive/ is a one-way door: pages can be moved in (created), never edited in place.
	// The space hub itself stays editable — it must list every new arrival.
	if (rel.startsWith('archive/') && rel !== 'archive/index.html' && exists)
		throw new WriteError(403, 'archive/ is frozen — archived pages are not editable');
	// Read-cap round-trip guard: a strict prefix of a stored page larger than PAGE_READ_LIMIT is a capped read posted
	// back, which would drop every byte past the cap. A deliberate tail-deletion opts out with allowTruncate.
	if (exists && !input.allowTruncate && Buffer.byteLength(before) > PAGE_READ_LIMIT) {
		const incoming = Buffer.byteLength(input.content);
		// The cap cuts at a byte boundary, so a CJK page's capped copy can end in U+FFFD; strip it before comparing.
		const probe = input.content.replace(/\uFFFD+$/, '');
		if (incoming < Buffer.byteLength(before) && probe.length > 0 && before.startsWith(probe))
			throw new WriteError(
				409,
				`refusing truncating write: the submitted content is a strict prefix of the stored page ` +
					`(${incoming} of ${Buffer.byteLength(before)} bytes). This page is larger than the ` +
					`${PAGE_READ_LIMIT}-byte read cap, so a copy fetched from /api/agent/page is incomplete — ` +
					`re-read the whole file from /raw/${rel} before writing. Pass allowTruncate:true only if ` +
					`you genuinely mean to delete the tail.`,
			);
	}
	const numbered = renumberedPage(rel, input.content);
	const content = numbered.content;
	// A write of the bytes already stored logs no revision. On 2026-11-04 golden-and-release v71 and v72 had one hash.
	if (exists && content === before) return unchangedWrite(rel, before);
	if (exists && input.refuseStaleCopy && (input.baseVersion === undefined || input.baseVersion === null)) {
		const reason = staleCopyReason(rel, input.content);
		if (reason) throw new WriteError(409, reason);
	}
	await assertPageInvariants(rel, exists ? before : null, content);
	const mermaid = await mermaidCheck(rel, exists ? before : null, content);
	if (mermaid.reasons.length) throw new WriteError(422, `refusing ${rel}: ${mermaid.reasons.join('. Also, ')}`);
	const code = codeRepoDir();
	const warnings = [
		...(isCuratedPath(rel) && code ? pageWriteWarnings(code, rel, exists ? before : null, content, input.summary) : []),
		...numbered.warnings,
		...mermaid.warnings,
		...readCapWarning(rel, content),
		...(exists ? [] : await hubRowWarning(rel, content)),
	];
	const written = await writeLogged({
		rel,
		full,
		before,
		content,
		author: input.author,
		summary: input.summary,
		baseVersion: input.baseVersion ?? null,
	});
	return warnings.length ? { ...written, changed: true, warnings } : { ...written, changed: true };
}

/** The answer to a write whose content equals the stored page, the same shape supersedePage gives an unchanged write. */
function unchangedWrite(rel: string, before: string): WriteResult & { changed: false } {
	return {
		path: rel,
		version: currentVersion(rel),
		bytes: Buffer.byteLength(before),
		diff: '',
		linesAdded: 0,
		linesRemoved: 0,
		changed: false,
	};
}

/**
 * A curated page with its top-level <ol> lists numbered on in order (scripts/ol-numbering.mjs), so a writer who adds or
 * drops a line never has to shift each later start= by hand. A write whose "item N" names a number two lines shared is
 * refused, because the reference has no one line to move with.
 */
function renumberedPage(rel: string, content: string): { content: string; warnings: string[] } {
	if (!rel.endsWith('.html') || !isCuratedPath(rel)) return { content, warnings: [] };
	const result = renumberLists(content);
	if (result.ambiguous.length)
		throw new WriteError(
			422,
			`refusing ${rel}: its numbered lines need new start= values, and "item ${result.ambiguous.join('", "item ')}" ` +
				`names a number that two lines share, so the reference cannot move with its line. Point it at the line you ` +
				`mean by its number once the lists run on, or reword it to name the fact`,
		);
	if (!result.moved) return { content, warnings: [] };
	return {
		content: result.html,
		warnings: [
			`the page API set start= on ${result.moved} numbered list(s) of ${rel} so its line numbers run on, and moved each ` +
				`"item N" with its line. Read the page again before your next edit`,
		],
	};
}

/**
 * A warning when the write leaves the page past its whole-read cap, because every later whole read of it answers 413.
 * On 2026-11-04 apps/crawler-v3/adding-a-platform/retrieval.html reached 64,289 bytes with no word to any of its writers.
 */
function readCapWarning(rel: string, content: string): string[] {
	const bytes = Buffer.byteLength(content);
	const cap = readLimitFor(rel);
	if (bytes <= cap) return [];
	return [
		`${rel} is ${bytes} bytes, past the ${cap}-byte whole-page read cap, so GET /api/agent/page and the markdown view of it ` +
			`answer 413 and a reader has to slice it with ?section= or read /raw/${rel}. Split it into a short index page and ` +
			`child pages by topic, and add a row for each child page to the hub that lists this page.`,
	];
}

/**
 * A warning when a write creates a current curated page that no ancestor hub lists, naming the hub and the row to add.
 * It warns instead of refusing, because the dead-link gate refuses a hub row written before its page exists.
 */
async function hubRowWarning(rel: string, content: string): Promise<string[]> {
	if (!rel.endsWith('.html') || !isCuratedPath(rel) || isRetiredStatus(parseHtmlMeta(content).status)) return [];
	const missing = await missingHubRow(rel);
	if (!missing) return [];
	return [
		`no hub lists ${rel} yet, so wiki-health counts it as a hub orphan. Add a row to ${missing.hub} that links ` +
			`href="${missing.href}" with its one-line summary, or list its folder there with a <wiki-children> tag.`,
	];
}

/**
 * The mermaid check of a curated page or the home page (scripts/mermaid-check.mjs): a block the write adds that does not
 * parse refuses it, and a broken block the page already held is a warning. When the parser cannot run, the write saves.
 */
async function mermaidCheck(rel: string, before: string | null, after: string): Promise<{ reasons: string[]; warnings: string[] }> {
	if (!isCuratedPath(rel) && rel !== 'index.html') return { reasons: [], warnings: [] };
	try {
		return await mermaidWriteCheck(before, after);
	} catch (error) {
		console.error(`page API: the mermaid check of ${rel} could not run: ${error}`);
		return { reasons: [], warnings: [] };
	}
}

/** A git runner in the repo that holds the content root, for stale-base.mjs: (args, { input, encoding }) => { status, stdout, stderr }. */
function gitRun(args: string[], opts: { input?: string; encoding?: BufferEncoding | 'buffer' } = {}) {
	const r = spawnSync('git', args, {
		cwd: contentGitRoot() ?? undefined,
		input: opts.input,
		encoding: opts.encoding === 'buffer' ? undefined : (opts.encoding ?? 'utf8'),
		maxBuffer: Infinity,
	});
	return { status: r.status, stdout: r.stdout, stderr: String(r.stderr ?? r.error?.message ?? '') };
}

/**
 * Why a full write of `content` to rel would undo committed text, or null. On 2026-10-28 a session edited its 04d0afcc5d
 * copy of apps/crawler-v3/platforms/linkedin/fields.html after dbaf9ad972 had changed three of its lines. The wiki host
 * commits a page the API wrote as meant, so the same copy posted here would have undone dbaf9ad972 with no error.
 * The check reads the git repo that holds the content root (the backup repo); with none, or for a mounted path, it passes.
 */
function staleCopyReason(rel: string, content: string): string | null {
	const gitRoot = contentGitRoot();
	if (!gitRoot) return null;
	const repoPath = path.relative(gitRoot, diskPath(rel)).split(path.sep).join('/');
	if (repoPath.startsWith('..')) return null;
	const stale = staleWrite(gitRun, 'HEAD', repoPath, content);
	if (!stale) return null;
	return (
		`stale copy: this content reads as an edit of the copy of ${rel} at ${stale.tip.slice(0, 10)}, and it drops lines ` +
		`that ${stale.since.join(', ')} added since. Read the page again, make your change on its current text and write ` +
		`that, or send the version GET /api/agent/page returns as baseVersion to write over it on purpose.`
	);
}

/** True when the index serves the content path `p` as a page: a file on disk the index walk does not skip. */
function isServedOnDisk(p: string): boolean {
	if (shouldSkip(p)) return false;
	try {
		return statSync(diskPath(p)).isFile();
	} catch {
		return false;
	}
}

/** The meta title and first <h1> when they differ, the titleH1Mismatch lint finding; null when they match. */
function titleH1Gap(html: string): { title: string; h1: string } | null {
	const title = parseHtmlMeta(html).title;
	const h1 = extractHtmlTitle(html);
	return title && h1 !== null && !titleMatchesH1(title, h1) ? { title, h1 } : null;
}

/**
 * Write invariants for pages outside sessions/ and archive/: meta title matches the first <h1> (old debt stays editable),
 * a current hub gains no link to a retired page, a page is not retired while a current hub links it, and a curated page
 * has last_verified, no repo path git lacks and no dead link (the page-gate.mjs rules commit.mjs runs).
 */
async function assertPageInvariants(rel: string, before: string | null, after: string): Promise<void> {
	if (!rel.endsWith('.html') || isSessionPath(rel) || rel.startsWith('archive/')) return;
	const gap = titleH1Gap(after);
	if (gap && !(before !== null && titleH1Gap(before)))
		throw new WriteError(
			422,
			`the meta title "${gap.title}" and the first <h1> "${gap.h1}" differ. Change both in the same ` +
				`write; a note such as "test output" belongs in the description and the tldr`,
		);
	if (!isCuratedPath(rel) && rel !== 'index.html') return;
	const dead = deadLinksAdded(rel, before ?? undefined, after, isServedOnDisk);
	const code = codeRepoDir();
	const reasons = [...(dead.length ? [deadLinkReason(dead)] : []), ...(code ? pageWriteReasons(code, rel, before, after) : [])];
	if (reasons.length)
		throw new WriteError(
			422,
			`refusing ${rel}: ${reasons.join('. Also, ')}. See the page gate rules 3 to 5 in apps/llm-wiki/scripts/page-gate.mjs`,
		);
	if (!isRetiredStatus(parseHtmlMeta(after).status)) {
		const added = await retiredLinksAdded(rel, before, after);
		if (added.length)
			throw new WriteError(
				409,
				`this write makes a current hub link retired page(s): ${added.join(', ')}. Link the page that ` +
					`replaced each one (its superseded_by), or leave the link out`,
			);
		return;
	}
	if (!isCuratedPath(rel) || (before !== null && isRetiredStatus(parseHtmlMeta(before).status))) return;
	const hubs = await hubsLinking(rel);
	if (hubs.length === 0) return;
	throw new WriteError(
		409,
		`${rel} is linked from ${hubs.length} current hub page(s): ${hubs.join(', ')}. Repoint or drop ` +
			`those links first, then change the status. To send readers to a newer page, keep this ` +
			`status and POST /api/agent/supersede {"path": "${rel}", "by": "<new page>"}`,
	);
}

type WriteResult = {
	path: string;
	version: number;
	bytes: number;
	diff: string;
	linesAdded: number;
	linesRemoved: number;
};

/** Write the bytes and log the revision + diff. Every guard has already run. */
async function writeLogged(input: {
	rel: string;
	full: string;
	before: string;
	content: string;
	author?: string;
	summary?: string;
	baseVersion: number | null;
}): Promise<WriteResult> {
	await mkdir(path.dirname(input.full), { recursive: true });
	await writeFile(input.full, input.content, 'utf8');
	const diff = unifiedDiff(input.before, input.content, input.rel);
	const stats = changeStats(input.before, input.content);
	const version = addRevision({
		path: input.rel,
		author: input.author ?? 'agent',
		summary: input.summary ?? '',
		baseVersion: input.baseVersion,
		contentHash: createHash('sha1').update(input.content).digest('hex'),
		diff,
		...stats,
	});
	return {
		path: input.rel,
		version,
		bytes: stats.bytesAfter,
		diff,
		linesAdded: stats.linesAdded,
		linesRemoved: stats.linesRemoved,
	};
}

/**
 * The frontmatter JSON with `superseded_by` set, keeping the author's own layout: the key's
 * value is replaced in place, or the key is added before the closing brace. The text edit
 * must parse back to exactly `{ ...meta, superseded_by }`; if it does not, re-serialize.
 */
function withSupersededBy(jsonText: string, meta: Record<string, unknown>, target: string): string {
	const value = JSON.stringify(target);
	const existing = /("superseded_by"\s*:\s*)"(?:[^"\\]|\\.)*"/;
	const close = jsonText.lastIndexOf('}');
	const head = jsonText.slice(0, close).trimEnd();
	const separator = jsonText.includes('\n') ? `,\n${/\n([ \t]*)"/.exec(jsonText)?.[1] ?? '\t'}` : ', ';
	const edited =
		'superseded_by' in meta
			? jsonText.replace(existing, (_m, key: string) => `${key}${value}`)
			: `${head}${head.endsWith('{') ? '' : separator}"superseded_by": ${value}${jsonText.slice(head.length)}`;
	const expected = JSON.stringify({ ...meta, superseded_by: target });
	try {
		if (JSON.stringify(JSON.parse(edited)) === expected) return edited;
	} catch {
		// fall through to a clean re-serialize
	}
	return JSON.stringify({ ...meta, superseded_by: target });
}

/** The content-root path of an existing page that `by` names, read as content-root first, then page-relative. */
async function resolveSupersedeTarget(by: string, fromRel: string): Promise<string> {
	const stripped = by
		.trim()
		.replace(/^\/page\//, '')
		.replace(/^apps\/llm-wiki\/content\//, '');
	const candidates: string[] = [];
	try {
		candidates.push(normalizeRequestedPath(stripped));
	} catch {
		// not a valid content-root path; the page-relative reading may still be
	}
	const relative = normalizeLinkTarget(stripped, fromRel);
	if (relative) candidates.push(relative);
	for (const candidate of candidates) {
		for (const file of [candidate, path.posix.join(candidate, 'index.html')]) {
			if (file.startsWith('@code/') || !WRITABLE.test(file)) continue;
			const full = diskPath(file);
			const isFile = await stat(full).then(
				(s) => s.isFile(),
				() => false,
			);
			if (isFile) return file;
		}
	}
	throw new WriteError(404, `superseding page not found: ${by}. Write the new page first`);
}

/**
 * Point an old page at its replacement by setting `superseded_by` in its `<!--wiki {json}-->`
 * frontmatter, and nothing else. The one write a closed session folder accepts: a closed
 * session is frozen, but a reader who opens its stale page must still find the new one.
 * Only the JSON inside the meta comment changes; every other byte of the file stays as it was.
 */
export async function supersedePage(input: {
	rawPath: string;
	by: string;
	author?: string;
	summary?: string;
}): Promise<WriteResult & { superseded_by: string; changed: boolean }> {
	const { rel, full } = resolveWritePath(input.rawPath);
	const folder = sessionFolderOf(rel);
	if (folder && rel === `${folder}/index.html`)
		throw new WriteError(403, 'session logs are API-managed; supersede an artifact page, not the log');
	if (rel.startsWith('archive/')) throw new WriteError(403, 'archive/ is frozen: archived pages are not editable');
	if (typeof input.by !== 'string' || !input.by.trim()) throw new WriteError(400, 'need a string "by"');
	const before = await readForEdit(rel);
	if (before === null) throw new WriteError(404, `page not found: ${rel}`);
	const target = await resolveSupersedeTarget(input.by, rel);
	if (target === rel) throw new WriteError(400, 'a page cannot supersede itself');

	const match = META_COMMENT.exec(before);
	if (!match) throw new WriteError(422, `${rel} has no <!--wiki {json}--> frontmatter to carry superseded_by`);
	const jsonText = match[1].trim();
	let meta: Record<string, unknown>;
	try {
		meta = JSON.parse(jsonText) as Record<string, unknown>;
	} catch {
		throw new WriteError(422, `${rel} frontmatter is not valid JSON`);
	}
	if (!meta || typeof meta !== 'object' || Array.isArray(meta))
		throw new WriteError(422, `${rel} frontmatter is not a JSON object`);
	if (meta.superseded_by === target) return { ...unchangedWrite(rel, before), superseded_by: target };
	const nextJson = withSupersededBy(jsonText, meta, target);
	const jsonStart = match.index + match[0].length - '-->'.length - match[1].length + match[1].indexOf(jsonText);
	const content = before.slice(0, jsonStart) + nextJson + before.slice(jsonStart + jsonText.length);
	const result = await writeLogged({
		rel,
		full,
		before,
		content,
		author: input.author,
		summary: input.summary ?? `superseded by ${target}`,
		baseVersion: null,
	});
	return { ...result, superseded_by: target, changed: true };
}
