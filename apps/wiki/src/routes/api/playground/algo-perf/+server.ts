import { error, json } from '@sveltejs/kit';
import { ALGO_PERF_ENABLED, exportLedger, runTool } from '$lib/server/algo-perf';

/** GET → every recorded run with its metrics (the dashboard's full dataset). */
export async function GET() {
	if (!ALGO_PERF_ENABLED) error(403, 'Playground is local-dev only (WIKI_EDITABLE).');
	try {
		return json(await exportLedger());
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		error(500, `algo-perf export failed: ${msg.slice(0, 400)}`);
	}
}

/** POST { sql } → one read-only SELECT/WITH statement against the store. */
export async function POST({ request }) {
	if (!ALGO_PERF_ENABLED) error(403, 'Playground is local-dev only (WIKI_EDITABLE).');
	const { sql } = await request.json();
	if (typeof sql !== 'string' || !sql.trim()) error(400, 'sql is required');
	const q = sql.trim().replace(/;+\s*$/, '');
	if (!/^(select|with)\b/i.test(q)) error(400, 'Only SELECT / WITH queries are allowed.');
	if (q.includes(';')) error(400, 'One statement only.');
	if (q.length > 4000) error(400, 'Query too long.');
	try {
		return json(await runTool(['sql', q]));
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		error(400, `DuckDB query failed: ${msg.slice(0, 400)}`);
	}
}
