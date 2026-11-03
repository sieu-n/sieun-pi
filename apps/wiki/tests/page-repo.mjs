import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { assertFixtureRepo, fixtureGitEnv } from './test-git-env.mjs';

/**
 * A git repo in a temp dir, removed after the test `t`, with wiki pages under apps/llm-wiki/content/apps. `page` writes a
 * page with its `source_refs`, `commit` commits the whole tree at a UTC time and returns its sha.
 */
export function pageRepo(t, name) {
	const dir = mkdtempSync(path.join(tmpdir(), name));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const env = fixtureGitEnv(dir);
	const write = (rel, text) => {
		mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
		writeFileSync(path.join(dir, rel), text);
	};
	const page = (rel, refs, { verified = '2026-10-20T03:00Z', body = '' } = {}) =>
		write(
			`apps/llm-wiki/content/apps/${rel}`,
			`<!--wiki ${JSON.stringify({ title: rel, description: 'd', last_verified: verified, source_refs: refs })}-->\n<h1>${rel}</h1>\n${body}\n`,
		);
	const init = () => {
		execFileSync('git', ['init', '-q'], { cwd: dir, env });
		assertFixtureRepo(dir, env);
	};
	const commit = (at, message) => {
		execFileSync('git', ['add', '-A'], { cwd: dir, env });
		execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', message], {
			cwd: dir,
			env: { ...env, GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at },
		});
		return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, env }).toString().trim();
	};
	return { dir, env, write, page, init, commit };
}
