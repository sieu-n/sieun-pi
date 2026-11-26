import path from 'node:path';
import { wikiConfig } from '../wiki-config.mjs';
import { mountRootOf } from './mount-root';

/**
 * Extra folders served under a wiki path prefix, from the wiki config's `mounts`, such as `agents/` for
 * ~/.pi/agent/agents, where each sw factory agent keeps its brief, its work notebook and its job folders. A mount
 * owns its prefix, with one fallback while the old content root still holds `agents/<x>`: a path whose first folder
 * under the prefix exists only in the content root reads and writes there. Each `<mount>/<x>/harness/` folder stays
 * out of the wiki, because it holds an agent's harness state, not pages.
 */
export type Mount = { name: string; dir: string };

export function mounts(): Mount[] {
	return Object.entries(wikiConfig().mounts)
		.filter(([, dir]) => Boolean(dir))
		.map(([name, dir]) => ({ name, dir: dir as string }));
}

/** The folder a content path is read and written under, and the path relative to it (mount-root.ts `mountRootOf`). */
export function rootOf(rel: string): { root: string; relative: string } {
	return mountRootOf(wikiConfig(), rel);
}

/** The file on disk of a content path. */
export function diskPath(rel: string): string {
	const { root, relative } = rootOf(rel);
	return path.join(root, relative);
}

/** The content path of a file on disk, under the content root or a mount. */
export function wikiPathOf(fullPath: string): string {
	for (const mount of mounts()) {
		const relative = path.relative(mount.dir, fullPath);
		if (relative === '') return mount.name;
		if (!relative.startsWith('..') && !path.isAbsolute(relative)) return `${mount.name}/${relative.split(path.sep).join('/')}`;
	}
	return path.relative(wikiConfig().contentRoot, fullPath).split(path.sep).join('/');
}

/** True for `<mount>/<x>/harness` and everything under it. */
export function isMountHidden(rel: string): boolean {
	const parts = rel.split('/');
	return parts.length >= 3 && parts[2] === 'harness' && mounts().some((m) => m.name === parts[0]);
}
