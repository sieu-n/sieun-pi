import { spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { wikiConfig } from '../wiki-config.mjs';

/**
 * The secret scan of one page write, ported from auto-sns-agent scripts/repo/agent/wiki-secrets.mjs: betterleaks over a
 * copy of the bytes at the page's path, with gitleaks.toml (a copy of auto-sns-agent's .gitleaks.toml) as its rules, so a
 * page the API saves passes the same scan the content backup and auto-sns-agent CI run. One betterleaks spawn took a
 * median 163 ms on us-metal02.
 */

const RULES = path.resolve(process.cwd(), 'gitleaks.toml');

/** The betterleaks binary: the wiki config's `betterleaks`, else PATH, ~/.local/bin or /opt/homebrew/bin; null when none runs. */
export function betterleaksBin(env = process.env) {
	const dirs = [...(env.PATH ?? '').split(path.delimiter).filter(Boolean), path.join(env.HOME || homedir(), '.local', 'bin'), '/opt/homebrew/bin'];
	for (const bin of [wikiConfig().betterleaks, ...dirs.map((dir) => path.join(dir, 'betterleaks'))]) {
		if (!bin) continue;
		try {
			accessSync(bin, constants.X_OK);
			return bin;
		} catch {
			// not here
		}
	}
	return null;
}

/**
 * `{ findings: [{ path, line, rule }], scanner }` for `files` ([{ path, bytes }] with content paths). With no betterleaks
 * the scan cannot run and throws, and the page API logs that and saves the page, as it did when the old import failed.
 */
/** @param {{ path: string, bytes: Buffer }[]} files */
export function scanWikiFiles(files) {
	if (!files.length) return { findings: [], scanner: 'none' };
	const bin = betterleaksBin();
	if (!bin) throw new Error('betterleaks is in none of the config, PATH, ~/.local/bin and /opt/homebrew/bin');
	const dir = mkdtempSync(path.join(tmpdir(), 'wiki-secrets-'));
	try {
		for (const f of files) {
			const to = path.join(dir, 'files', f.path);
			mkdirSync(path.dirname(to), { recursive: true });
			writeFileSync(to, f.bytes);
		}
		const report = path.join(dir, 'report.json');
		const rules = existsSync(RULES) ? ['-c', RULES] : [];
		const run = spawnSync(bin, ['dir', '--no-banner', '--no-color', '--redact', '--exit-code', '0', '-f', 'json', '-r', report, ...rules, '--', '.'], {
			cwd: path.join(dir, 'files'),
			encoding: 'utf8',
		});
		if (run.error || run.status !== 0)
			throw new Error(`${bin} failed (${run.error?.message ?? `exit ${run.status}`}): ${(run.stderr || '').trim().split('\n').pop()}`);
		// betterleaks writes `null`, not `[]`, when it finds nothing.
		const findings = (JSON.parse(readFileSync(report, 'utf8')) ?? []).map((/** @type {{ File: string, StartLine: number, RuleID: string }} */ x) => ({ path: path.normalize(x.File), line: x.StartLine, rule: x.RuleID }));
		return { findings, scanner: 'betterleaks' };
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}
