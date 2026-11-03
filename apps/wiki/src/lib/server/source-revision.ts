import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';

/** What a dev server serves: its source tree and the config that builds it, relative to the app root. */
export const DEV_SOURCE = ['src', 'svelte.config.js', 'vite.config.ts', 'package.json'];

async function files(root: string, entry: string): Promise<string[]> {
	const path = join(root, entry);
	const info = await stat(path).catch(() => null);
	if (!info) return [];
	if (info.isFile()) return [path];
	if (!info.isDirectory()) return [];
	const listed = await readdir(path, { recursive: true, withFileTypes: true });
	return listed.filter((item) => item.isFile()).map((item) => join(item.parentPath, item.name));
}

let cached: { signature: string; revision: string } | null = null;

/**
 * `sha256:<hex>` over every file's app-relative path and bytes under `entries`, or null
 * when none exists. A dev server runs its working tree, uncommitted edits included, so
 * the tree bytes name what it serves; the specs runner compares this value before and
 * after a check. The digest is recomputed only when a path, size or mtime changed.
 */
export async function sourceRevision(root: string, entries = DEV_SOURCE): Promise<string | null> {
	const paths = (await Promise.all(entries.map((entry) => files(root, entry)))).flat().sort();
	if (!paths.length) return null;
	const stats = await Promise.all(paths.map((path) => stat(path)));
	const signature = paths.map((path, index) => `${path}:${stats[index].size}:${stats[index].mtimeMs}`).join('\n');
	if (cached?.signature === signature) return cached.revision;
	const digest = createHash('sha256');
	for (const path of paths) {
		digest.update(`${relative(root, path)}\0`);
		digest.update(
			createHash('sha256')
				.update(await readFile(path))
				.digest(),
		);
	}
	cached = { signature, revision: `sha256:${digest.digest('hex')}` };
	return cached.revision;
}
