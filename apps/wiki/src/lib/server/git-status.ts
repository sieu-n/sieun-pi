import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { wikiConfig } from '../wiki-config.mjs';

const run = promisify(execFile);
/** auto-sns-agent's scripts/ci/git-status.mjs, run as a child in its repo, from the wiki config's `gitStatusScript`. */
const SCRIPT = wikiConfig().gitStatusScript;
// measured: scripts/dev/ci-cache.mjs polls GitHub every 30 s (INTERVAL_S), so a newer read would show the same runs.
const FRESH_MS = 30_000;

let last: { at: number; body: Promise<string> } | null = null;

/** The branch snapshot as JSON text from scripts/ci/git-status.mjs, shared by every viewer for one cache cycle. */
export function gitStatus(): Promise<string> {
	if (last && Date.now() - last.at < FRESH_MS) return last.body;
	if (!SCRIPT) return Promise.reject(new Error('no gitStatusScript in the wiki config'));
	const body = run(process.execPath, [SCRIPT], { cwd: path.dirname(SCRIPT) }).then(({ stdout }) => stdout);
	last = { at: Date.now(), body };
	body.catch(() => {
		if (last?.body === body) last = null;
	});
	return body;
}
