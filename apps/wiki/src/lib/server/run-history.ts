import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { scriptEnv } from './script-env';

/**
 * Runs `scripts/run_history.py <args>` in the wiki app dir and parses its JSON answer. run_history.py owns
 * <content root>/.wiki/run-history.duckdb and rebuilds it from <content root>/experiments/runs/.
 */
export function runHistory<T>(args: string[], opts: { wikiDir?: string; stdin?: string } = {}): Promise<T> {
	const wikiDir = opts.wikiDir ?? process.cwd();
	const script = resolve(wikiDir, 'scripts/run_history.py');
	return new Promise((done, fail) => {
		const child = execFile(
			'uv',
			['run', '--no-project', '--with', 'duckdb', 'python', script, ...args],
			{ cwd: wikiDir, env: scriptEnv(), maxBuffer: Infinity },
			(err, stdout, stderr) =>
				err ? fail(new Error(`run_history.py ${args[0]}: ${stderr || err.message}`)) : done(JSON.parse(stdout)),
		);
		child.stdin?.end(opts.stdin);
	});
}
