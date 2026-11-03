import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

/**
 * Where the wiki engine finds its content, its mounts and the code repos its pages describe. One JSON file holds it,
 * `~/.config/sieun-pi/wiki.json` or the file `WIKI_CONFIG` names, and `WIKI_CONTENT_ROOT` and `WIKI_AGENTS_ROOT` win over
 * its `contentRoot` and `mounts.agents`. The backup committer of scripts/wiki-storage reads the same file.
 *
 * {
 *   "contentRoot": "~/.pi/wiki/content",
 *   "mounts": { "agents": "~/.pi/agent/agents" },
 *   "repos": { "auto-sns-agent": "~/Documents/Github/auto-sns-agent", "sieun-pi": "~/src/sieun-pi" },
 *   "codeRepo": "auto-sns-agent",
 *   "mirrorRepo": "auto-sns-agent",
 *   "betterleaks": "~/.local/bin/betterleaks",
 *   "backupRepo": "git@github.com:sieu-n/wiki-content.git",
 *   "gitStatusScript": "~/Documents/Github/auto-sns-agent/scripts/ci/git-status.mjs",
 *   "specsDir": "~/Documents/Github/auto-sns-agent/apps/llm-wiki/specs"
 * }
 *
 * With no file, the content root is ./content under the working directory and the repos are the checkouts of
 * auto-sns-agent and sieun-pi found under ~/src or ~/Documents/Github, which is what a test or a dev server needs.
 */

/** @typedef {{ contentRoot: string, mounts: Record<string, string>, repos: Map<string, string>, codeRepo: string | null, mirrorRepo: string | null, mirrorDir: string | null, betterleaks: string | null, backupRepo: string | null, gitStatusScript: string | null, specsDir: string | null, file: string | null }} WikiConfig */

/** The real path, because the page reader refuses a root reached through a symlink (wiki-mirror.ts inspectWikiFile). */
/** @param {string | null} p @returns {string} */
const real = (p) => {
	if (!p) return /** @type {string} */ (p);
	try {
		return realpathSync(p);
	} catch {
		return p;
	}
};
/** @param {string} home @param {unknown} p @returns {string | null} */
const expandIn = (home, p) => (typeof p === 'string' && p ? path.resolve(p.replace(/^~(?=$|\/)/, home)) : null);

/** The repos looked for when the file names none, each tried under its env var, ~/src and ~/Documents/Github. */
const KNOWN_REPOS = { 'auto-sns-agent': 'AUTO_SNS_AGENT_REPO', 'sieun-pi': 'SIEUN_PI_REPO' };

/** @param {NodeJS.ProcessEnv} env @param {string} home */
function foundRepos(env, home) {
	/** @type {Map<string, string>} */
	const repos = new Map();
	for (const [name, key] of Object.entries(KNOWN_REPOS)) {
		const dir = [env[key], path.join(home, 'src', name), path.join(home, 'Documents/Github', name)].find(
			(root) => root && existsSync(path.join(root, '.git')),
		);
		if (dir) repos.set(name, path.resolve(dir));
	}
	return repos;
}

/** @param {NodeJS.ProcessEnv} [env] @param {string} [cwd] @param {string} [home] @returns {WikiConfig} */
export function readWikiConfig(env = process.env, cwd = process.cwd(), home = env.HOME || homedir()) {
	const expand = (/** @type {unknown} */ p) => expandIn(home, p);
	const file = expand(env.WIKI_CONFIG) ?? path.join(home, '.config/sieun-pi/wiki.json');
	const raw = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
	const json = raw ?? {};
	const repos = json.repos
		? new Map(Object.entries(json.repos).flatMap(([name, dir]) => (expand(dir) ? [[name, /** @type {string} */ (expand(dir))]] : [])))
		: foundRepos(env, home);
	const mounts = Object.fromEntries(Object.entries(json.mounts ?? {}).map(([name, dir]) => [name, real(expand(dir))]));
	if (env.WIKI_AGENTS_ROOT) mounts.agents = real(expand(env.WIKI_AGENTS_ROOT));
	const codeRepo = json.codeRepo ?? (repos.has('auto-sns-agent') ? 'auto-sns-agent' : null);
	const mirrorRepo = json.mirrorRepo ?? codeRepo;
	return {
		file: raw ? file : null,
		contentRoot: real(expand(env.WIKI_CONTENT_ROOT) ?? expand(json.contentRoot) ?? path.resolve(cwd, 'content')),
		mounts,
		repos,
		codeRepo,
		mirrorRepo,
		// WIKI_MIRROR_ROOT points the @code mirror at another tree, such as the committed tree wiki-health.mjs unpacks.
		mirrorDir: expand(env.WIKI_MIRROR_ROOT) ?? (mirrorRepo ? (repos.get(mirrorRepo) ?? null) : null),
		betterleaks: expand(json.betterleaks),
		backupRepo: json.backupRepo ?? null,
		gitStatusScript: expand(json.gitStatusScript),
		specsDir: expand(env.SPECS_DIR) ?? expand(json.specsDir),
	};
}

/** @type {WikiConfig | null} */
let cached = null;

/** The config of this process, read once. */
export function wikiConfig() {
	cached ??= readWikiConfig();
	return cached;
}

/** The checkout of the repo `name`, or null when this box has none. @param {string | null | undefined} name @returns {string | null} */
export function repoDir(name) {
	return (name && wikiConfig().repos.get(name)) || null;
}

/** The checkout a bare repo path on a page (`apps/search/...` with no `<repo>:` prefix) is read in, or null. */
export function codeRepoDir() {
	return repoDir(wikiConfig().codeRepo);
}

/** @type {string | null | undefined} */
let contentGit;
/** The git checkout that holds the content root, or null when it is in none. @returns {string | null} */
export function contentGitRoot() {
	if (contentGit === undefined) {
		try {
			contentGit = execFileSync('git', ['rev-parse', '--show-toplevel'], {
				cwd: wikiConfig().contentRoot,
				encoding: 'utf8',
				stdio: ['ignore', 'pipe', 'ignore'],
			}).trim();
		} catch {
			contentGit = null;
		}
	}
	return contentGit;
}
