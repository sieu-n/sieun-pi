import { homedir } from 'node:os';
import { readWikiConfig, wikiConfig } from './wiki-config.mjs';

/**
 * The repos besides the code repo that wiki pages describe, keyed by the name a `source_refs` entry puts before a colon,
 * as in `sieun-pi:components/pi-pool/pool/sched.py`. wiki-stale.ts, wiki-health.mjs and page-gate.mjs read that form here.
 * The repos come from the wiki config (wiki-config.mjs); a sibling path with no repo name is stat-ed under the code repo.
 */

/**
 * The sibling checkouts this box has, as a map from repo name to root; a repo with no checkout here is left out.
 * On 2026-10-28 the Mac had no ~/src/sieun-pi, so land-object.mjs refused a staging page that cites sieun-pi's
 * packages/pi-pool as a path git does not have; with no config file the lookup tries ~/Documents/Github too.
 * @param {NodeJS.ProcessEnv} [env]
 * @param {string} [home]
 * @returns {Map<string, string>}
 */
export function siblingRepos(env = process.env, home = homedir()) {
	const config = readWikiConfig(env, process.cwd(), home);
	return new Map([...config.repos].filter(([name, dir]) => name !== config.codeRepo && dir));
}

/**
 * `{ repo, path }` for a ref in the form `<sibling repo>:<path>`, else null.
 * @param {string} ref
 * @returns {{ repo: string, path: string } | null}
 */
export function siblingRef(ref) {
	const match = /^([a-z][a-z0-9-]*):(?!\/)(.+)$/.exec(ref);
	if (!match) return null;
	const config = wikiConfig();
	const known = match[1] === 'sieun-pi' || (config.repos.has(match[1]) && match[1] !== config.codeRepo);
	return known ? { repo: match[1], path: match[2] } : null;
}
