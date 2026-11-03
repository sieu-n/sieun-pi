import { codeRepoDir, wikiConfig } from '../wiki-config.mjs';

/** The env a script the engine spawns (scripts/*.py) reads its content root and code repo from. */
export function scriptEnv(): NodeJS.ProcessEnv {
	return { ...process.env, WIKI_CONTENT_ROOT: wikiConfig().contentRoot, WIKI_CODE_REPO: codeRepoDir() ?? '' };
}
