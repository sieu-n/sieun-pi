import { base } from '$app/paths';
import type { Ledger } from './types';
import {
	buildMatrix,
	cellNote,
	datasetSentence,
	formatWhen,
	metricDef,
	resolveView,
	searchParamsFromQuery,
	statText,
	taskLabel,
	type ResolvedView,
	type ViewQuery,
} from './leaderboard';

export const ALGO_PERF_PATH = '/playground/algo-perf';

/** The link that reproduces a view. Every default is written out, so it never drifts. */
export function viewHref(q: ViewQuery, extra: Record<string, string> = {}): string {
	const params = searchParamsFromQuery(q);
	for (const [k, v] of Object.entries(extra)) params.set(k, v);
	const qs = params.toString();
	return qs ? `${base}${ALGO_PERF_PATH}?${qs}` : `${base}${ALGO_PERF_PATH}`;
}

const cell = (s: string) => s.replace(/\|/g, '\\|');

function leaderboardTable(v: ResolvedView): string[] {
	if (!v.rows.length) return ['No runs on this dataset in the current window.'];
	const head = ['variant', ...v.columns, 'draws', 'last measured'];
	const out = [
		`| ${head.map(cell).join(' | ')} |`,
		`| ${head.map((_, i) => (i === 0 ? '---' : '---:')).join(' | ')} |`,
	];
	for (const row of v.rows) {
		const cells = [
			cell(row.label),
			...v.columns.map((m) => {
				const stat = row.stats[m];
				const note = cellNote(row, stat, m);
				if (!stat) return '—';
				return stat.partial ? `${statText(stat)} (${note})` : statText(stat);
			}),
			String(row.draws),
			formatWhen(row.lastAt),
		];
		out.push(`| ${cells.join(' | ')} |`);
	}
	return out;
}

function matrixTable(ledger: Ledger, v: ResolvedView): string[] {
	const m = buildMatrix(ledger, v);
	if (m.columns.length < 2 || !m.rows.length) return ['Not enough measured datasets to compare.'];
	const out: string[] = [];
	// Exposure is spelled out in every column header, because a markdown table
	// has no colour to carry the held-out / selection divider.
	const head = ['variant', ...m.columns.map((c) => `${c.name} (${c.group.replace('_', ' ')})`)];
	out.push(`| ${head.map(cell).join(' | ')} |`);
	out.push(`| ${head.map((_, i) => (i === 0 ? '---' : '---:')).join(' | ')} |`);
	for (const row of m.rows) {
		const cells = [
			cell(row.label),
			...row.cells.map((c) => {
				if (!c.primary) return c.draws ? '—' : 'not measured';
				const paired = c.paired ? ` / ${statText(c.paired)}` : '';
				return `${statText(c.primary)}${paired} (n=${c.draws})`;
			}),
		];
		out.push(`| ${cells.join(' | ')} |`);
	}
	out.push('');
	out.push(
		`Each cell is \`${m.metric}\`${m.pairedMetric ? ` / \`${m.pairedMetric}\`` : ''} with the draw count. Held-out columns come first; a selection column is a number the arms were tuned against.`,
	);
	// Leaving a dataset's tab must not lose its caveat. v5-heldout-guessable is
	// held out AND measures guessing; side by side with v5-heldout-good its 90.9%
	// reads as the better number unless the caveat travels with the column.
	const caveats = m.columns.filter((c) => c.caveat);
	if (caveats.length) {
		out.push('');
		for (const c of caveats) out.push(`- \`${c.name}\`: ${c.caveat}`);
	}
	if (m.excluded.length) out.push(`Left out (their runs never recorded ${m.metric}): ${m.excluded.join(', ')}.`);
	if (m.unmeasured.length) out.push(`Never measured on any of these datasets: ${m.unmeasured.join(', ')}.`);
	return out;
}

/** The leaderboard as text/plain markdown, from the same `resolveView` the page uses. */
export function renderMarkdown(ledger: Ledger, q: ViewQuery): string {
	const v = resolveView(ledger, q);
	const out: string[] = [];
	const scoredN = v.rows.find((r) => r.scoredN !== null)?.scoredN ?? null;

	out.push(`# ${taskLabel(v.task)} on ${v.dataset}`);
	out.push('');
	out.push(datasetSentence(v, scoredN) + '.');
	out.push('');

	if (v.def.exposure === 'selection') {
		out.push(
			'> SELECTION SET — the arms below were iterated against this data. A number here is not evidence that it generalises.',
		);
		out.push('');
	} else if (v.def.exposure === 'held_out') {
		out.push('> HELD OUT — the arms never saw this data before it was scored.');
		out.push('');
	} else {
		out.push('> Exposure not recorded for this dataset — treat it as a selection set until someone says otherwise.');
		out.push('');
	}
	if (v.def.caveat) {
		out.push(`> Caveat: ${v.def.caveat}`);
		out.push('');
	}

	const north = metricDef(ledger, v.metric);
	out.push(
		`- North star: \`${v.metric}\` (${north.higher_is_better ? 'higher' : 'lower'} is better)` +
			(north.description ? ` — ${north.description}` : ' — UNANNOTATED'),
	);
	if (v.pairedMetric) {
		out.push(
			`- Published beside it, always: \`${v.pairedMetric}\` — the scoring contract forbids quoting \`${v.metric}\` alone.`,
		);
	}
	if (v.def.n_rows !== null) out.push(`- Dataset size: ${v.def.n_rows} rows.`);
	if (scoredN !== null) out.push(`- Scored denominator recorded by the runs: n=${scoredN}.`);
	out.push(
		`- Showing ${v.arms === 'product' ? 'the SHIPPED endpoints only' : 'every variant'}` +
			` — ${v.productCount} product, ${v.researchCount} research arm(s) on this dataset.` +
			(v.arms === 'product' && v.researchCount ? ` Add \`&arms=all\` for the research arms.` : ''),
	);
	if (v.armsFallback) {
		out.push(
			'- No variant on this dataset is registered as a product, so every arm is shown. Register one with `algo-perf.py variant-set --kind product`.',
		);
	}
	out.push(`- ${v.scopedRuns.length} run(s), ${v.rows.length} variant(s), window \`since=${v.since}\`.`);
	if (v.def.source) out.push(`- Evidence: /page/${v.def.source}`);
	out.push(`- This view: ${viewHref(v.canonical)}`);
	out.push('');

	if (v.view === 'matrix') {
		out.push(`## Every dataset at once`);
		out.push('');
		out.push(...matrixTable(ledger, v));
		out.push('');
	} else {
		out.push('## Leaderboard');
		out.push('');
		out.push(...leaderboardTable(v));
		out.push('');
		out.push(
			'A variant measured more than once shows the BAND across its draws (min–max), never one draw. Rows rank on the median.',
		);
		if (v.hasBlankCell) {
			out.push(
				'A dash means that arm never recorded that metric — not that it scored zero. Columns no shown arm carries are dropped entirely.',
			);
		}
		out.push('');
		out.push(`## ${v.arms === 'product' ? 'Both endpoints' : 'These arms'} across every dataset`);
		out.push('');
		out.push(...matrixTable(ledger, v));
		out.push('');
		out.push(`Full view: ${viewHref({ ...v.canonical, view: 'matrix' })}`);
		out.push('');
	}

	out.push('## Dataset');
	out.push('');
	out.push(
		v.def.description ?? 'No description recorded. Add one with `scripts/algo-perf.py benchmark-set --description`.',
	);
	out.push('');

	out.push('## Metrics on this dataset');
	out.push('');
	for (const m of v.columns) {
		const d = metricDef(ledger, m);
		out.push(`- \`${m}\` (${d.unit}) — ${d.description ?? 'UNANNOTATED'}`);
	}
	out.push('');

	if (v.rows.some((r) => r.def.description)) {
		out.push('## Arms shown');
		out.push('');
		for (const r of v.rows) {
			if (!r.def.description) continue;
			out.push(`- **${r.label}** (${r.def.kind}) — ${r.def.description}`);
		}
		out.push('');
	}

	out.push(`## Other datasets for ${v.task}`);
	out.push('');
	for (const d of v.datasets) {
		if (d.name === v.dataset) continue;
		const marks = [d.def.status === 'archived' ? 'archived' : null, d.def.exposure ?? 'exposure unrecorded']
			.filter(Boolean)
			.join(', ');
		out.push(
			`- \`${d.name}\` — ${d.runs} run(s), ${marks} — ${viewHref({ ...v.canonical, dataset: d.name, metric: null, variants: null })}`,
		);
	}
	out.push('');
	out.push('## Tasks');
	out.push('');
	for (const t of v.tasks) {
		out.push(
			`- \`${t}\` — ${viewHref({ task: t, dataset: null, metric: null, variants: null, arms: null, since: null, view: null })}`,
		);
	}
	out.push('');
	out.push(
		'Add `&format=md` to any of these URLs for this plain-text view. Query strings accepted: `task`, `dataset`, `metric`, `variants` (comma-separated, slug prefix match), `arms` (`product`|`all`), `since` (`30d`), `view` (`table`|`chart`|`matrix`).',
	);
	out.push('');
	return out.join('\n');
}
