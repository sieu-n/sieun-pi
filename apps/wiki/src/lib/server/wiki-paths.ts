import path from 'node:path';
import { isMountHidden } from './wiki-mounts';

/** Which content paths the index walks and reads. Pure rules on a path or a folder listing, with no state. */

export const INDEXABLE_EXTENSIONS = new Set(['.md', '.mdx', '.txt', '.yaml', '.yml', '.json', '.html']);
export const IGNORED_DIR_NAMES = new Set([
	'.batch_state',
	'.cache',
	'.git',
	'.mypy_cache',
	'.pytest_cache',
	'.ruff_cache',
	'.svelte-kit',
	'.tox',
	'.venv',
	'.vercel',
	'__pycache__',
	'build',
	'coverage',
	'dist',
	'logs',
	'node_modules',
	'playwright-report',
	'pw',
	'reports',
	'results',
	'site-packages',
	'test-results',
	'traces',
	'venv',
]);
const IGNORED_FILE_NAMES = new Set(['.DS_Store']);
/**
 * A folder that holds one of these is a repo copy (a clone or a `git archive` export) and is never walked or
 * indexed. On 2026-10-18 jobs had copied whole repo trees into their session folders, sessions/ held 1.1M
 * files and gained about 80k indexed files in an hour.
 */
const REPO_COPY_MARKERS = new Set(['.git', 'pnpm-workspace.yaml']);

export function isRepoCopy(entries: readonly { name: string }[]): boolean {
	return entries.some((entry) => REPO_COPY_MARKERS.has(entry.name));
}
export const IGNORED_EXTENSIONS = new Set([
	'.7z',
	'.avif',
	'.bak',
	'.db',
	'.dylib',
	'.duckdb',
	'.feather',
	'.gif',
	'.gz',
	'.heic',
	'.jpeg',
	'.jpg',
	'.log',
	'.logpath',
	'.lock',
	'.mov',
	'.mp4',
	'.ndjson',
	'.npy',
	'.npz',
	'.out',
	'.parquet',
	'.pickle',
	'.pid',
	'.pkl',
	'.psv',
	'.pdf',
	'.png',
	'.pyc',
	'.rar',
	'.sqlite',
	'.sqlite3',
	'.so',
	'.tar',
	'.webm',
	'.webp',
	'.xls',
	'.xlsx',
	'.zip',
]);

export function isIgnoredWikiPath(candidatePath: string): boolean {
	const normalized = candidatePath.replace(/\\/g, '/');
	const name = path.posix.basename(normalized);
	if (IGNORED_FILE_NAMES.has(name)) return true;
	if (isGeneratedArtifactFile(normalized)) return true;

	const segments = normalized.split('/').filter(Boolean);
	if (segments.some((segment) => IGNORED_DIR_NAMES.has(segment))) return true;

	const extension = path.posix.extname(name).toLowerCase();
	if (IGNORED_EXTENSIONS.has(extension)) return true;
	if (!extension || !INDEXABLE_EXTENSIONS.has(extension)) return true;

	return false;
}

export function shouldSkip(relativePath: string, isDirectory = false): boolean {
	if (!relativePath) return false;
	const segments = relativePath.split('/').filter(Boolean);
	const directories = isDirectory ? segments : segments.slice(0, -1);
	if (directories.some((segment) => segment.startsWith('.'))) return true;
	if (segments.some((segment) => IGNORED_DIR_NAMES.has(segment))) return true;
	if (isMountHidden(relativePath)) return true;
	const name = segments.at(-1) ?? '';
	if (IGNORED_FILE_NAMES.has(name)) return true;
	if (!isDirectory && isGeneratedArtifactFile(relativePath)) return true;
	if (isDirectory) return false;
	const extension = path.posix.extname(name).toLowerCase();
	if (IGNORED_EXTENSIONS.has(extension)) return true;
	if (!extension || !INDEXABLE_EXTENSIONS.has(extension)) return true;
	return false;
}

function isGeneratedArtifactFile(relativePath: string): boolean {
	const normalized = relativePath.replace(/\\/g, '/').toLowerCase();
	const lowerName = path.posix.basename(normalized);
	if ((normalized.startsWith('sessions/') || /^agents\/[^/]+\/jobs\//.test(normalized) || normalized.startsWith('experiments/')) && lowerName.endsWith('.json')) {
		return true;
	}
	return (
		lowerName === 'profile_cache.json' ||
		lowerName === 'golden_dataset.json' ||
		lowerName.startsWith('golden_dataset_v') ||
		lowerName === 'verified_golden.json' ||
		(lowerName.startsWith('test_set') && lowerName.endsWith('.json'))
	);
}
