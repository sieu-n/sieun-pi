import { constants, type Stats } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { wikiConfig } from '../wiki-config.mjs';
import { rootOf } from './wiki-mounts';

/**
 * Read-only `@code/` mirror of the markdown docs (CLAUDE.md, rules, skills) of the wiki config's `mirrorRepo`, mapped back
 * to their repo paths. With no mirror repo on this box the mirror is empty.
 * It depends only on the filesystem (the ignore predicate is injected), so it never imports `wiki.ts`.
 */

export const CODE_PREFIX = '@code/';

const REPO_ROOT = wikiConfig().mirrorDir ?? '';

export function getRepoRoot(): string {
	return REPO_ROOT;
}

// Curated sources — markdown only. Bounded, no full-repo walk.
const ROOT_FILES = ['CLAUDE.md', 'README.md', 'AGENTS.md', '.claude/skills/README.md'];
const APP_DOC_FILES = ['CLAUDE.md', 'README.md'];
const EXTRA_DOC_DIRS = ['convex'];
const WALK_DIRS = ['.claude/rules', '.claude/skills-native', '.agents/skills'];
const SKIP_DIRS = new Set([
	'node_modules',
	'.git',
	'.svelte-kit',
	'.vercel',
	'dist',
	'build',
	'__pycache__',
	'.venv',
	'venv',
	'coverage',
]);
const MARKDOWN = /\.(md|mdx)$/i;

export type MirrorFile = { fullPath: string; wikiPath: string };
type IgnorePredicate = (repoRelativePath: string) => boolean;

export async function getMirrorFiles(isIgnored: IgnorePredicate): Promise<MirrorFile[]> {
	const out: MirrorFile[] = [];
	if (!REPO_ROOT) return out;

	for (const name of ROOT_FILES) {
		await addFile(path.join(REPO_ROOT, name), out, isIgnored);
	}

	for (const appDir of await safeReaddir(path.join(REPO_ROOT, 'apps'))) {
		for (const name of APP_DOC_FILES) {
			await addFile(path.join(REPO_ROOT, 'apps', appDir, name), out, isIgnored);
		}
	}

	for (const dir of EXTRA_DOC_DIRS) {
		for (const name of APP_DOC_FILES) {
			await addFile(path.join(REPO_ROOT, dir, name), out, isIgnored);
		}
	}

	for (const dir of WALK_DIRS) {
		await walkDir(path.join(REPO_ROOT, dir), out, isIgnored);
	}

	return out;
}

export class WikiFileUnavailable extends Error {
	readonly code = 'ENOENT';
	constructor() {
		super('Wiki file is unavailable.');
	}
}

function canonicalRelative(value: string): boolean {
	return Boolean(
		value &&
		!/[\\%\x00-\x1f\x7f]/.test(value) &&
		!path.posix.isAbsolute(value) &&
		value.split('/').every((part) => part && part !== '.' && part !== '..'),
	);
}

export function isMirrorDocumentPath(relative: string): boolean {
	if (!canonicalRelative(relative) || !MARKDOWN.test(relative)) return false;
	if (ROOT_FILES.includes(relative)) return true;
	const parts = relative.split('/');
	if (parts.some((part, index) => SKIP_DIRS.has(part) || (index > 0 && part.startsWith('.')))) return false;
	if (parts.length === 3 && parts[0] === 'apps' && APP_DOC_FILES.includes(parts[2])) return true;
	if (parts.length === 2 && EXTRA_DOC_DIRS.includes(parts[0]) && APP_DOC_FILES.includes(parts[1])) return true;
	return WALK_DIRS.some((directory) => relative.startsWith(`${directory}/`));
}

type WikiFileRequest = { wikiPath: string; contentRoot: string };
function publicTarget({ wikiPath, contentRoot }: WikiFileRequest): { root: string; relative: string } {
	if (wikiPath.startsWith(CODE_PREFIX)) {
		const relative = wikiPath.slice(CODE_PREFIX.length);
		if (!REPO_ROOT || !isMirrorDocumentPath(relative)) throw new WikiFileUnavailable();
		return { root: REPO_ROOT, relative };
	}
	if (!canonicalRelative(wikiPath) || wikiPath.split('/').some((part) => part.startsWith('.')))
		throw new WikiFileUnavailable();
	if (path.resolve(contentRoot) === wikiConfig().contentRoot) return rootOf(wikiPath);
	return { root: path.resolve(contentRoot), relative: wikiPath };
}

export async function inspectWikiFile(request: WikiFileRequest): Promise<{ fullPath: string; stat: Stats }> {
	const target = publicTarget(request);
	if ((await realpath(target.root)) !== target.root) throw new WikiFileUnavailable();
	let fullPath = target.root;
	const parts = target.relative.split('/');
	let entry: Stats | undefined;
	for (const [index, part] of parts.entries()) {
		fullPath = path.join(fullPath, part);
		entry = await lstat(fullPath);
		if (entry.isSymbolicLink() || (index < parts.length - 1 && !entry.isDirectory())) throw new WikiFileUnavailable();
	}
	if (!entry?.isFile() || entry.nlink !== 1 || (await realpath(fullPath)) !== fullPath) throw new WikiFileUnavailable();
	return { fullPath, stat: entry };
}

function sameFile(left: Stats, right: Stats): boolean {
	return (
		left.isFile() &&
		right.isFile() &&
		left.nlink === 1 &&
		right.nlink === 1 &&
		left.dev === right.dev &&
		left.ino === right.ino &&
		left.size === right.size &&
		left.mtimeMs === right.mtimeMs &&
		left.ctimeMs === right.ctimeMs
	);
}

/** Both raw assets and indexed pages read through the same policy and checked file handle. */
export async function readWikiFile(
	request: WikiFileRequest & { maxBytes?: number },
): Promise<{ bytes: Buffer; stat: Stats }> {
	const before = await inspectWikiFile(request);
	const file = await open(before.fullPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	try {
		const opened = await file.stat();
		const current = await inspectWikiFile(request);
		if (!sameFile(before.stat, opened) || !sameFile(opened, current.stat)) throw new WikiFileUnavailable();
		const length = Math.min(opened.size, request.maxBytes ?? opened.size);
		if (!Number.isSafeInteger(length) || length < 0) throw new WikiFileUnavailable();
		const bytes = Buffer.alloc(length);
		let offset = 0;
		while (offset < length) {
			const read = await file.read(bytes, offset, length - offset, offset);
			if (!read.bytesRead) throw new WikiFileUnavailable();
			offset += read.bytesRead;
		}
		const after = await inspectWikiFile(request);
		if (!sameFile(opened, await file.stat()) || !sameFile(opened, after.stat)) throw new WikiFileUnavailable();
		return { bytes, stat: opened };
	} finally {
		await file.close();
	}
}

async function walkDir(dir: string, out: MirrorFile[], isIgnored: IgnorePredicate): Promise<void> {
	let entries;
	try {
		if (!(await lstat(dir)).isDirectory() || (await realpath(dir)) !== dir) return;
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		if (entry.isSymbolicLink()) continue;
		const fullPath = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			if (SKIP_DIRS.has(entry.name)) continue;
			await walkDir(fullPath, out, isIgnored);
		} else if (entry.isFile()) {
			await addFile(fullPath, out, isIgnored);
		}
	}
}

async function addFile(fullPath: string, out: MirrorFile[], isIgnored: IgnorePredicate): Promise<void> {
	const repoRelative = path.relative(REPO_ROOT, fullPath).split(path.sep).join('/');
	if (!repoRelative || repoRelative.startsWith('../')) return;
	if (!isMirrorDocumentPath(repoRelative) || isIgnored(repoRelative)) return;
	try {
		await inspectWikiFile({ wikiPath: CODE_PREFIX + repoRelative, contentRoot: REPO_ROOT });
	} catch {
		return;
	}
	out.push({ fullPath, wikiPath: CODE_PREFIX + repoRelative });
}

async function safeReaddir(dir: string): Promise<string[]> {
	try {
		return (await readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
	} catch {
		return [];
	}
}
