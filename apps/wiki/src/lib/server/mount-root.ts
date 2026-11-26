import { existsSync } from 'node:fs';
import path from 'node:path';

/**
 * The folder a wiki content path is read and written under, and the path relative to it. A mount such as `agents` owns its prefix, with one
 * fallback while the old content root still holds `agents/<x>`: a path whose first folder under the prefix exists only in the content root
 * reads and writes there. It takes the roots as plain values and reads no config, so the tell_owner link check
 * (legacy/prime/user-history/src/chat-guard.ts `localWikiPages`) maps a path to disk the way the engine does (wiki-mounts.ts `rootOf`).
 */
export type WikiRoots = { contentRoot: string; mounts: Record<string, string> };

export function mountRootOf(roots: WikiRoots, rel: string, exists: (file: string) => boolean = existsSync): { root: string; relative: string } {
	const slash = rel.indexOf('/');
	const name = slash > 0 ? rel.slice(0, slash) : '';
	const dir = name && Object.hasOwn(roots.mounts, name) ? roots.mounts[name] : undefined;
	if (dir) {
		const rest = rel.slice(slash + 1);
		const top = rest.split('/')[0] ?? '';
		if (exists(path.join(dir, top)) || !exists(path.join(roots.contentRoot, name, top))) return { root: path.resolve(dir), relative: rest };
	}
	return { root: roots.contentRoot, relative: rel };
}
