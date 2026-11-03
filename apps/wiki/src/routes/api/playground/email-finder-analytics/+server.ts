import { error, json } from '@sveltejs/kit';
import { dev } from '$app/environment';
import { env } from '$env/dynamic/private';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { repoDir, wikiConfig } from '$lib/wiki-config.mjs';

const execFileP = promisify(execFile);
const ENABLED = dev || env.WIKI_EDITABLE === 'true';

const ANALYTICS_DIR = resolve(wikiConfig().contentRoot, 'experiments/email-finder/analytics');
const STATS_PATH = resolve(ANALYTICS_DIR, 'eval_stats.json');
// The DuckDB analytics script lives with the experiment session artifacts.
const SCRIPT = resolve(wikiConfig().contentRoot, 'sessions/2026/07/13/1105-email-finder-overhaul/data/eval_analytics.py');
// The query runs in auto-sns-agent's crawler-v3, whose uv environment has duckdb.
const CRAWLER_CWD = resolve(repoDir('auto-sns-agent') ?? '.', 'apps/crawler-v3');

/** GET → the DuckDB-computed stat rollups (all metrics × every sub-category). */
export async function GET() {
	if (!ENABLED) error(403, 'Playground is local-dev only (WIKI_EDITABLE).');
	const raw = await readFile(STATS_PATH, 'utf-8').catch(() => null);
	if (raw === null) error(500, 'eval_stats.json missing — run eval_analytics.py first (see the experiment page).');
	return json(JSON.parse(raw));
}

/** POST { sql } runs one read-only SELECT/WITH DuckDB query against eval.duckdb, dev-gated. */
export async function POST({ request }) {
	if (!ENABLED) error(403, 'Playground is local-dev only (WIKI_EDITABLE).');
	const { sql } = await request.json();
	if (typeof sql !== 'string' || !sql.trim()) error(400, 'sql is required');
	const q = sql.trim().replace(/;+\s*$/, '');
	if (!/^(select|with)\b/i.test(q)) error(400, 'Only SELECT / WITH queries are allowed.');
	if (q.includes(';')) error(400, 'One statement only.');
	if (q.length > 4000) error(400, 'Query too long.');
	try {
		const { stdout } = await execFileP('uv', ['run', '--with', 'duckdb', 'python', SCRIPT, '--sql', q], {
			cwd: CRAWLER_CWD,
			maxBuffer: Infinity,
		});
		return json(JSON.parse(stdout));
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		error(400, `DuckDB query failed: ${msg.slice(0, 400)}`);
	}
}
