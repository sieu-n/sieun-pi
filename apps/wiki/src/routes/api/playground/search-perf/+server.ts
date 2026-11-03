import { error, json } from '@sveltejs/kit';
import { dev } from '$app/environment';
import { env } from '$env/dynamic/private';
import { readFile, readdir } from 'node:fs/promises';
import { resolve, basename } from 'node:path';
import { wikiConfig } from '$lib/wiki-config.mjs';

const ENABLED = dev || env.WIKI_EDITABLE === 'true';

// perf-suite.mjs (apps/search/scripts/perf) writes one JSON artifact per suite run here; algo-perf.duckdb carries the
// trend, these carry the per-subscription and per-hop detail the search-load dashboard renders.
const RUNS_DIR = resolve(wikiConfig().contentRoot, '.wiki/search-perf/runs');

type Artifact = {
	run_id: string;
	at: string;
	label: string;
	git: { sha: string; branch: string };
	base: string;
	summary: unknown;
};

async function listRuns(): Promise<Artifact[]> {
	let files: string[] = [];
	try {
		files = (await readdir(RUNS_DIR)).filter((f) => f.endsWith('.json'));
	} catch {
		return []; // no runs yet — the dashboard shows the replay command instead
	}
	const runs: Artifact[] = [];
	for (const f of files) {
		try {
			runs.push(JSON.parse(await readFile(resolve(RUNS_DIR, f), 'utf8')) as Artifact);
		} catch {
			// a half-written artifact never breaks the index
		}
	}
	return runs.sort((a, b) => a.at.localeCompare(b.at) || a.run_id.localeCompare(b.run_id));
}

/** GET → index of every suite run (summaries only).
 *  GET ?run=<run_id> → that run's FULL artifact (routes incl. per-sub bytes, nav hops). */
export async function GET({ url }) {
	if (!ENABLED) error(403, 'Playground is local-dev only (WIKI_EDITABLE).');
	const runId = url.searchParams.get('run');
	if (runId) {
		// The id came from our own index, but never let it walk the filesystem.
		const safe = basename(runId).replace(/[^A-Za-z0-9._-]/g, '');
		try {
			return json(JSON.parse(await readFile(resolve(RUNS_DIR, `${safe}.json`), 'utf8')));
		} catch {
			error(404, `no artifact for run ${safe}`);
		}
	}
	const runs = await listRuns();
	return json({
		dir: 'content/.wiki/search-perf/runs',
		runs: runs.map((r) => ({
			run_id: r.run_id,
			at: r.at,
			label: r.label,
			git: r.git,
			base: r.base,
			summary: r.summary,
		})),
	});
}
