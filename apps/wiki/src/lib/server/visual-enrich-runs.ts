import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runHistory } from './run-history';
import { wikiConfig } from '../wiki-config.mjs';

/** What crawler-v3 `POST /api/profiles/<username>/visual-enrich` answers inside `data`. */
interface VisualEnrichAnswer {
	username: string;
	snapshot_b64: string;
	missing_cdn: number;
	result: Record<string, unknown>;
	model: string;
	input_tokens: number;
	output_tokens: number;
	cached_input_tokens?: number;
	cost_usd?: number | null;
	duration_ms: number;
	prompt_sha256?: string;
	persisted: boolean;
}

interface ProbeCall {
	runId: string;
	username: string;
	/** The request body sent to the crawler, without the username. */
	body: Record<string, unknown>;
	answer: VisualEnrichAnswer;
	/** The crawler's GET /health answer, or null when it did not answer. */
	health: { git_sha?: string | null; revision?: string | null } | null;
	startedAt: Date;
	endedAt: Date;
	/** Artifact paths relative to content/. */
	artifacts: { label: string; path: string }[];
}

const COMPONENT = 'visual-enrichment';
// The request defaults of VisualEnrichRequest in apps/crawler-v3/src/enrichment/routes.py, the ablation's B0 shape.
// measured: 12 posts is Instagram's first profile grid page, the crawler's own default.
const B0_KNOBS = { limit: 12, header: true, tile_meta: true, captions: false, captions_text: true, attach_image: true };
const SOURCE = 'sieun-pi:apps/wiki/src/routes/api/playground/visual-enrich/+server.ts';

const metric = (name: string, value: number | null | undefined, unit: string) => ({
	name,
	value: value ?? null,
	ci_low: null,
	ci_high: null,
	unit,
});

/** A run id run_history.py accepts: probe-<UTC stamp>-<username>-<4 random hex>. */
function probeRunId(username: string, at: Date, suffix = randomBytes(2).toString('hex')): string {
	const stamp = at
		.toISOString()
		.replace(/[-:]/g, '')
		.replace(/\.\d+Z$/, 'z')
		.toLowerCase();
	const user = username.toLowerCase().replace(/[^a-z0-9._-]/g, '-');
	return `probe-${stamp}-${user}-${suffix}`;
}

/** The run file for one playground call, in the shape run_history.py `record` reads. */
function probeRun(call: ProbeCall): Record<string, unknown> {
	const { prompt, ...knobs } = call.body;
	const a = call.answer;
	return {
		component: COMPONENT,
		run_id: call.runId,
		kind: 'probe',
		started_at: call.startedAt.toISOString(),
		ended_at: call.endedAt.toISOString(),
		commit: call.health?.git_sha ?? call.health?.revision ?? null,
		model: a.model,
		prompt_hash: a.prompt_sha256 ?? null,
		dataset: null,
		config: {
			...B0_KNOBS,
			...knobs,
			username: call.username,
			model: a.model,
			prompt: prompt ? 'override' : 'production',
		},
		metrics: [
			metric('duration_ms', a.duration_ms, 'ms'),
			metric('input_tokens', a.input_tokens, 'tokens'),
			metric('output_tokens', a.output_tokens, 'tokens'),
			metric('cached_input_tokens', a.cached_input_tokens, 'tokens'),
			metric('cost_usd', a.cost_usd, 'usd'),
			metric('missing_cdn', a.missing_cdn, 'tiles'),
		],
		artifacts: call.artifacts,
		source: SOURCE,
		notes: call.health ? null : 'crawler GET /health did not answer, so the run has no commit',
	};
}

async function crawlerHealth(base: string): Promise<ProbeCall['health']> {
	try {
		const resp = await fetch(`${base}/health`);
		return resp.ok ? await resp.json() : null;
	} catch {
		return null;
	}
}

type VisualEnrichOutcome =
	| { ok: true; answer: VisualEnrichAnswer; run_id: string; run_path: string }
	| { ok: true; answer: VisualEnrichAnswer; run_id: string; run_error: string }
	| { ok: false; status: number; message: string };

/**
 * One playground call: asks the crawler to render and classify, then records the call as a kind=probe run in the
 * shared run history. The render and the result sit beside the run file in
 * content/experiments/runs/visual-enrichment/<run_id>/, where git ignores them. A failed record does not hide the
 * paid answer: it comes back as `run_error`.
 */
export async function visualEnrich(opts: {
	base: string;
	key: string;
	username: string;
	body: Record<string, unknown>;
	wikiDir: string;
}): Promise<VisualEnrichOutcome> {
	const base = opts.base.replace(/\/$/, '');
	const health = crawlerHealth(base);
	const startedAt = new Date();
	const upstream = await fetch(`${base}/api/profiles/${encodeURIComponent(opts.username)}/visual-enrich`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', 'X-API-Key': opts.key },
		body: JSON.stringify(opts.body),
	});
	const payload = await upstream.json().catch(() => null);
	if (!upstream.ok) {
		const message = payload?.error?.message ?? payload?.error ?? `crawler ${upstream.status}`;
		return { ok: false, status: upstream.status, message: String(message) };
	}
	const answer = (payload?.data ?? payload) as VisualEnrichAnswer;
	const endedAt = new Date();
	const runId = probeRunId(opts.username, startedAt);
	const dir = `experiments/runs/${COMPONENT}/${runId}`;
	try {
		await mkdir(join(wikiConfig().contentRoot, dir), { recursive: true });
		await writeFile(join(wikiConfig().contentRoot, dir, 'snapshot.png'), Buffer.from(answer.snapshot_b64, 'base64'));
		await writeFile(join(wikiConfig().contentRoot, dir, 'result.json'), JSON.stringify(answer.result, null, 1) + '\n');
		const run = probeRun({
			runId,
			username: opts.username,
			body: opts.body,
			answer,
			health: await health,
			startedAt,
			endedAt,
			artifacts: [
				{ label: 'render', path: `${dir}/snapshot.png` },
				{ label: 'result', path: `${dir}/result.json` },
			],
		});
		const { path } = await runHistory<{ path: string }>(['record'], {
			wikiDir: opts.wikiDir,
			stdin: JSON.stringify(run),
		});
		return { ok: true, answer, run_id: runId, run_path: path };
	} catch (e) {
		const message = e instanceof Error ? e.message : String(e);
		console.error(`visual-enrich run ${runId} was not recorded: ${message}`);
		return { ok: true, answer, run_id: runId, run_error: message };
	}
}
