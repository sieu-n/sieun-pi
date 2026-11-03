import type { Stats } from 'node:fs';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import type { WikiPageSummary } from './wiki';

/**
 * content/ holds about 117k indexable files, and all but about 3.6k are session artifacts: the files
 * agents leave next to a session log. The index reads curated pages and session logs at start and lists
 * the artifacts afterwards by path alone (see wiki.ts). This module names the two session tiers, finds
 * the logs without walking every artifact, and builds the unread artifact summary.
 */

/**
 * A session folder is `sessions/YYYY/MM/DD/hhmm-slug`, or `agents/<agent>/jobs/YYYY/MM/DD/hhmm-slug` for a job folder
 * opened under an agent's space (POST /api/agent/sessions with `root`). Both hold one API-managed log, `index.html`,
 * and the artifacts beside it.
 */
const JOB_ROOT = /^agents\/[^/]+\/jobs\//;

/** True for every path under sessions/ or under an agent's jobs/ folder. */
export function isSessionPath(wikiPath: string): boolean {
	return wikiPath.startsWith('sessions/') || JOB_ROOT.test(wikiPath);
}

/** sessions/YYYY/MM/DD/hhmm-slug/index.html (or the same under agents/<agent>/jobs/), the one page per session. */
export function isSessionLog(wikiPath: string): boolean {
	const segments = wikiPath.split('/');
	if (segments[0] === 'sessions') return segments.length === 6 && segments[5] === 'index.html';
	return JOB_ROOT.test(wikiPath) && segments.length === 8 && segments[7] === 'index.html';
}

/** The session folder that owns a path under it, or null: `sessions/YYYY/MM/DD/hhmm-slug` or `agents/<agent>/jobs/YYYY/MM/DD/hhmm-slug`. */
export function sessionFolderOf(rel: string): string | null {
	const m = /^((?:sessions|agents\/[^/]+\/jobs)\/\d{4}\/\d{2}\/\d{2}\/[^/]+)\//.exec(rel);
	return m ? m[1] : null;
}

export function isSessionArtifact(wikiPath: string): boolean {
	return isSessionPath(wikiPath) && !isSessionLog(wikiPath);
}

/**
 * The log path in every folder at the depth of sessions/YYYY/MM/DD/hhmm-slug. The file may not exist.
 * `onFolder` sees each folder on the way down before it is read, and each session folder.
 */
export async function listSessionLogs(
	sessionsRoot: string,
	skipFolder: (fullPath: string) => boolean,
	onFolder: (fullPath: string) => void = () => {},
): Promise<string[]> {
	let folders = [sessionsRoot];
	for (let depth = 0; depth < 4; depth += 1) {
		folders.forEach((folder) => onFolder(folder));
		const listed = await Promise.all(folders.map((folder) => listFolders(folder, skipFolder)));
		folders = listed.flat();
	}
	folders.forEach((folder) => onFolder(folder));
	return folders.map((folder) => path.join(folder, 'index.html'));
}

async function listFolders(root: string, skipFolder: (fullPath: string) => boolean): Promise<string[]> {
	let entries;
	try {
		entries = await readdir(root, { withFileTypes: true });
	} catch (error) {
		if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return [];
		throw error;
	}
	return entries
		.filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
		.map((entry) => path.join(root, entry.name))
		.filter((fullPath) => !skipFolder(fullPath));
}

/** Every stub shares its empty lists and metadata: there are hundreds of thousands, and nothing writes to a summary's lists. */
const NONE: string[] = [];
Object.freeze(NONE);
const NO_META = Object.freeze({ apps: NONE, tags: NONE });

/**
 * A session artifact as the index holds it: found by path and filename, never read. `readPage`
 * summarizes the file when it is opened.
 */
export function artifactStub(wikiPath: string, fileStat: Stats): WikiPageSummary {
	return {
		path: wikiPath,
		title: deriveTitleFromPath(wikiPath),
		kind: path.extname(wikiPath).slice(1).toLowerCase() || 'text',
		size: fileStat.size,
		updated: fileStat.mtime.toISOString(),
		headings: NONE,
		links: NONE,
		excerpt: '',
		searchText: '',
		meta: NO_META,
	};
}

/** Title-case a filename (sans extension) — the fallback when a page has no H1. */
export function deriveTitleFromPath(relativePath: string): string {
	const baseName = path.posix.basename(relativePath, path.posix.extname(relativePath));
	return baseName
		.split(/[-_]/)
		.filter(Boolean)
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join(' ');
}
