import { existsSync } from 'node:fs';
import path from 'node:path';
import { wikiConfig } from '../wiki-config.mjs';

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

function mountFor(rel: string): { mount: Mount; rest: string } | null {
	const slash = rel.indexOf('/');
	if (slash <= 0) return null;
	const mount = mounts().find((m) => m.name === rel.slice(0, slash));
	if (!mount) return null;
	const rest = rel.slice(slash + 1);
	const top = rest.split('/')[0];
	const root = wikiConfig().contentRoot;
	if (!existsSync(path.join(mount.dir, top)) && existsSync(path.join(root, mount.name, top))) return null;
	return { mount, rest };
}

/** The folder a content path is read and written under, and the path relative to it. */
export function rootOf(rel: string): { root: string; relative: string } {
	const hit = mountFor(rel);
	return hit ? { root: path.resolve(hit.mount.dir), relative: hit.rest } : { root: wikiConfig().contentRoot, relative: rel };
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
