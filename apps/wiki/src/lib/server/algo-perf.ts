import { dev } from '$app/environment';
import { env } from '$env/dynamic/private';
import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { scriptEnv } from './script-env';
import { queryFromSearchParams } from '$lib/algo-perf/leaderboard';
import { renderMarkdown } from '$lib/algo-perf/markdown';
import type { Ledger } from '$lib/algo-perf/types';

const execFileP = promisify(execFile);

/** The playground writes and reads a machine-local DuckDB store; it never ships. */
export const ALGO_PERF_ENABLED = dev || env.WIKI_EDITABLE === 'true';

// The ledger tool owns the store at content/.wiki/algo-perf.duckdb.
const SCRIPT = resolve(process.cwd(), 'scripts/algo-perf.py');

export async function runTool(args: string[]): Promise<unknown> {
	const { stdout } = await execFileP('uv', ['run', '--no-project', '--with', 'duckdb', 'python', SCRIPT, ...args], {
		cwd: process.cwd(),
		env: scriptEnv(),
		maxBuffer: Infinity,
	});
	return JSON.parse(stdout);
}

export const exportLedger = () => runTool(['export']) as Promise<Ledger>;

/**
 * `?format=md` on the dashboard path, routed from hooks.server.ts so curl and a browser get the same answer for one URL.
 */
export async function algoPerfMarkdown(url: URL): Promise<Response> {
	if (!ALGO_PERF_ENABLED) {
		return new Response('Playground is local-dev only (WIKI_EDITABLE).\n', {
			status: 403,
			headers: { 'content-type': 'text/plain; charset=utf-8' },
		});
	}
	try {
		const ledger = await exportLedger();
		return new Response(renderMarkdown(ledger, queryFromSearchParams(url.searchParams)), {
			headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
		});
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		return new Response(`algo-perf export failed: ${msg.slice(0, 800)}\n`, {
			status: 500,
			headers: { 'content-type': 'text/plain; charset=utf-8' },
		});
	}
}
