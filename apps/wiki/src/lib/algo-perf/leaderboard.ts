import type { BenchmarkDef, Ledger, MetricDef, MetricUnit, Run, VariantDef } from './types';

/** Every piece of view state. The query string is the only place it lives. */
export type ViewQuery = {
	task: string | null;
	dataset: string | null;
	metric: string | null;
	/** Explicit arm list. When set it wins over `arms`. */
	variants: string | null;
	/** `product` (default) shows the shipped endpoints only; `all` adds the research arms. */
	arms: string | null;
	since: string | null;
	view: string | null;
};

export function queryFromSearchParams(params: URLSearchParams): ViewQuery {
	return {
		task: params.get('task'),
		dataset: params.get('dataset'),
		metric: params.get('metric'),
		variants: params.get('variants'),
		arms: params.get('arms'),
		since: params.get('since'),
		view: params.get('view'),
	};
}

export function searchParamsFromQuery(q: ViewQuery): URLSearchParams {
	const params = new URLSearchParams();
	for (const [k, v] of Object.entries(q)) if (v) params.set(k, v);
	return params;
}

const DAY = 86_400_000;

/** Column order after the north star and its pinned pair. Unlisted metrics follow, alphabetically. */
const METRIC_ORDER = [
	'recall_strict',
	'recall_permissive',
	'recall_conditional',
	'recall_anyrank',
	'recall_domain',
	'precision_top1',
	'precision_addr',
	'e2e_yield',
	'found_rate',
	'found_proven',
	'emails_per_profile',
	'median_latency_s',
	'mean_latency_s',
	'p90_latency_s',
	'max_latency_s',
	'over_5s',
	'over_120s',
	'settled_ms',
	'shell_ms',
	'ssr_ms',
	'first_sub_ms',
	'ws_kb',
	'subs',
	'content_states',
	'avg_commit_ms',
	'avg_content_ms',
	'worst_commit_ms',
];

export const FALLBACK_METRIC_DEF: MetricDef = {
	description: null,
	higher_is_better: true,
	unit: 'ratio',
	pair_with: null,
};

/** A dataset nobody has annotated yet still shows up — loudly, not silently. */
export const FALLBACK_BENCHMARK_DEF: BenchmarkDef = {
	description: null,
	source: null,
	label: null,
	primary_metric: null,
	n_rows: null,
	exposure: null,
	status: 'active',
	caveat: null,
	sort: 100,
	task: null,
};

/** An unregistered arm is a research arm, so a newly recorded arm waits behind "show all variants" until someone marks it a product. */
export const FALLBACK_VARIANT_DEF: VariantDef = {
	task: null,
	label: null,
	kind: 'research',
	description: null,
	status: 'active',
	sort: 100,
};

export const metricDef = (ledger: Ledger, metric: string): MetricDef =>
	ledger.metric_defs[metric] ?? FALLBACK_METRIC_DEF;

export const benchmarkDef = (ledger: Ledger, benchmark: string): BenchmarkDef =>
	ledger.benchmark_defs[benchmark] ?? FALLBACK_BENCHMARK_DEF;

export const variantDef = (ledger: Ledger, variant: string): VariantDef =>
	ledger.variant_defs?.[variant] ?? FALLBACK_VARIANT_DEF;

export const variantLabel = (ledger: Ledger, variant: string): string => variantDef(ledger, variant).label ?? variant;

export function formatValue(value: number, unit: MetricUnit): string {
	if (!Number.isFinite(value)) return '—';
	switch (unit) {
		case 'ratio':
			return `${(value * 100).toFixed(1)}%`;
		case 'seconds':
			return `${value.toFixed(1)}s`;
		case 'ms':
			return `${Math.round(value)} ms`;
		case 'kb':
			return `${Math.round(value)} KB`;
		case 'count':
			return Number.isInteger(value) ? String(value) : value.toFixed(2);
	}
}

/** run_at is naive local wall clock; midnight means the date alone was recorded. */
export function formatWhen(iso: string): string {
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return iso;
	const dateOnly = d.getHours() === 0 && d.getMinutes() === 0 && d.getSeconds() === 0;
	return d.toLocaleString('en-GB', {
		day: 'numeric',
		month: 'short',
		...(dateOnly ? {} : { hour: '2-digit', minute: '2-digit', hour12: false }),
	});
}

export type DatasetEntry = {
	name: string;
	def: BenchmarkDef;
	runs: number;
	variants: number;
	lastAt: string | null;
};

export function tasksOf(ledger: Ledger): string[] {
	return [...new Set(ledger.runs.map((r) => r.algo))].sort();
}

export function datasetsOf(ledger: Ledger, task: string): DatasetEntry[] {
	const byName = new Map<string, Run[]>();
	for (const r of ledger.runs) {
		if (r.algo !== task) continue;
		const list = byName.get(r.benchmark) ?? [];
		list.push(r);
		byName.set(r.benchmark, list);
	}
	// An annotated but unscored dataset still shows as a tab with "0 runs".
	for (const name of Object.keys(ledger.benchmark_defs)) {
		if (byName.has(name)) continue;
		if (taskOfDef(ledger, name) === task) byName.set(name, []);
	}
	return [...byName.entries()]
		.map(([name, runs]) => ({
			name,
			def: benchmarkDef(ledger, name),
			runs: runs.length,
			variants: new Set(runs.map((r) => r.variant)).size,
			lastAt: runs.length
				? runs
						.map((r) => r.run_at)
						.sort()
						.at(-1)!
				: null,
		}))
		.sort((a, b) => a.def.sort - b.def.sort || b.runs - a.runs || a.name.localeCompare(b.name));
}

/** The task that owns a dataset with no runs; the primary-metric guess covers rows written before `task` existed. */
function taskOfDef(ledger: Ledger, name: string): string | null {
	const def = ledger.benchmark_defs[name];
	if (!def) return null;
	if (def.task) return def.task;
	if (!def.primary_metric) return null;
	const tasks = new Set(ledger.runs.filter((r) => def.primary_metric! in r.metrics).map((r) => r.algo));
	return [...tasks].sort()[0] ?? null;
}

const isActive = (d: DatasetEntry) => d.def.status === 'active';

/** Default task = the task owning the lowest-sort active dataset in the whole ledger. */
export function defaultTask(ledger: Ledger): string {
	const tasks = tasksOf(ledger);
	let best: { task: string; sort: number } | null = null;
	for (const task of tasks) {
		for (const d of datasetsOf(ledger, task)) {
			if (!isActive(d) || !d.runs) continue;
			if (!best || d.def.sort < best.sort) best = { task, sort: d.def.sort };
		}
	}
	return best?.task ?? tasks[0] ?? '';
}

export type MetricStat = {
	metric: string;
	def: MetricDef;
	/** How many of the variant's draws recorded THIS metric. */
	draws: number;
	/** Recorded on some draws and not others; renders differently from a metric never recorded (a dash). */
	partial: boolean;
	min: number;
	max: number;
	median: number;
	latest: number;
};

export type LeaderRow = {
	variant: string;
	label: string;
	def: VariantDef;
	slug: string;
	draws: number;
	lastAt: string;
	runs: Run[];
	stats: Record<string, MetricStat>;
	/** The scored denominator the runs recorded — distinct from the dataset's size. */
	scoredN: number | null;
};

export type ResolvedView = {
	task: string;
	tasks: string[];
	dataset: string;
	def: BenchmarkDef;
	datasets: DatasetEntry[];
	activeDatasets: DatasetEntry[];
	otherDatasets: DatasetEntry[];
	/** North star: the column the leaderboard sorts by. */
	metric: string;
	/** The metric that may never be quoted without it; pinned as the next column. */
	pairedMetric: string | null;
	metricsAvailable: string[];
	columns: string[];
	/** Every variant on this dataset in the window, before the product filter. */
	variants: string[];
	variantFilter: string[];
	/** `product` shows the shipped endpoints only; `all` adds the research arms. */
	arms: 'product' | 'all';
	/** No variant on this dataset is registered as a product, so everything is shown. */
	armsFallback: boolean;
	productCount: number;
	researchCount: number;
	/** A shown row has no value at all in a column another shown row carries. */
	hasBlankCell: boolean;
	/** A shown row recorded a metric on some draws and not others. */
	hasPartialCell: boolean;
	since: string;
	view: 'table' | 'chart' | 'matrix';
	rows: LeaderRow[];
	scopedRuns: Run[];
	datasetRuns: Run[];
	/** Query with every default made explicit — what a link should carry. */
	canonical: ViewQuery;
};

export const slugify = (s: string) =>
	s
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-|-$/g, '');

/** A variant's family: the name before its build tag. `fast (7aa06eded)` -> `fast`. */
export const variantFamily = (variant: string) => slugify(variant.split(/[\s(]/)[0] ?? variant);

/**
 * A token matches the variant family or the full slug, never a loose prefix, so `fast` does not pull in `fast-ship`.
 */
export function variantMatches(variant: string, token: string): boolean {
	const t = slugify(token);
	return !!t && (t === slugify(variant) || t === variantFamily(variant));
}

/** `email-finder` -> `Email finder`. The id stays the id; only the heading is prose. */
export const taskLabel = (task: string) =>
	task ? task.replace(/[-_]/g, ' ').replace(/^./, (c) => c.toUpperCase()) : task;

function median(values: number[]): number {
	const v = [...values].sort((a, b) => a - b);
	const mid = v.length >> 1;
	return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

function sinceCutoff(since: string, runs: Run[]): number {
	const m = /^(\d+)d$/.exec(since);
	if (!m) return -Infinity;
	// Anchored to the dataset's latest run, not to today: the ledger sleeps for
	// days at a time and a wall-clock window would silently empty the page.
	const latest = Math.max(...runs.map((r) => Date.parse(r.run_at)));
	return Number.isFinite(latest) ? latest - Number(m[1]) * DAY : -Infinity;
}

/** Group runs into one row per variant, with a band and a coverage flag per metric. */
function buildRows(ledger: Ledger, runs: Run[], columns: string[]): LeaderRow[] {
	const byVariant = new Map<string, Run[]>();
	for (const r of runs) {
		const list = byVariant.get(r.variant) ?? [];
		list.push(r);
		byVariant.set(r.variant, list);
	}
	return [...byVariant.entries()].map(([variant, group]) => {
		const stats: Record<string, MetricStat> = {};
		for (const m of columns) {
			const carrying = group.filter((r) => m in r.metrics).sort((a, b) => a.run_at.localeCompare(b.run_at));
			if (!carrying.length) continue;
			const vals = carrying.map((r) => r.metrics[m].value);
			stats[m] = {
				metric: m,
				def: metricDef(ledger, m),
				draws: carrying.length,
				partial: carrying.length < group.length,
				min: Math.min(...vals),
				max: Math.max(...vals),
				median: median(vals),
				latest: carrying.at(-1)!.metrics[m].value,
			};
		}
		const ns = [...new Set(group.map((r) => r.n).filter((n): n is number => n !== null))];
		return {
			variant,
			label: variantLabel(ledger, variant),
			def: variantDef(ledger, variant),
			slug: slugify(variant),
			draws: group.length,
			lastAt: group
				.map((r) => r.run_at)
				.sort()
				.at(-1)!,
			runs: [...group].sort((a, b) => a.run_at.localeCompare(b.run_at)),
			stats,
			scoredN: ns.length === 1 ? ns[0] : null,
		};
	});
}

export function resolveView(ledger: Ledger, q: ViewQuery): ResolvedView {
	const tasks = tasksOf(ledger);
	const task = q.task && tasks.includes(q.task) ? q.task : defaultTask(ledger);
	const datasets = datasetsOf(ledger, task);
	const activeDatasets = datasets.filter(isActive);
	const otherDatasets = datasets.filter((d) => !isActive(d));
	// A frame that has registered but not yet scored is a visible tab, never the
	// landing view — landing on an empty leaderboard would read as a broken page.
	const landing = activeDatasets.find((d) => d.runs > 0) ?? activeDatasets[0] ?? datasets[0];
	const chosen = datasets.find((d) => d.name === q.dataset) ?? landing;
	const dataset = chosen?.name ?? '';
	const def = chosen?.def ?? FALLBACK_BENCHMARK_DEF;

	const datasetRuns = ledger.runs
		.filter((r) => r.algo === task && r.benchmark === dataset)
		.sort((a, b) => a.run_at.localeCompare(b.run_at));

	const since = /^(\d+)d$/.test(q.since ?? '') ? q.since! : 'all';
	const cutoff = sinceCutoff(since, datasetRuns);
	const windowed = datasetRuns.filter((r) => Date.parse(r.run_at) >= cutoff);

	const variants = [...new Set(windowed.map((r) => r.variant))];
	const variantFilter = (q.variants ?? '')
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean);

	// THE DEFAULT IS THE PRODUCT. `kind` lives in variant_defs, so this is a data
	// fact, not a substring match on whatever someone typed into a variant name.
	const productVariants = variants.filter((v) => variantDef(ledger, v).kind === 'product');
	const requestedArms: 'product' | 'all' = q.arms === 'all' ? 'all' : 'product';
	// Label-only arms (every /app route in search-page-load) would render an empty table under the product default.
	const armsFallback = requestedArms === 'product' && !variantFilter.length && productVariants.length === 0;
	const arms: 'product' | 'all' = armsFallback ? 'all' : requestedArms;

	const scopedRuns = variantFilter.length
		? windowed.filter((r) => variantFilter.some((t) => variantMatches(r.variant, t)))
		: arms === 'product'
			? windowed.filter((r) => variantDef(ledger, r.variant).kind === 'product')
			: windowed;

	// Columns come from the SHOWN rows only. A metric no shown row carries is not
	// a column at all, instead of a column of dashes nobody can read.
	const present = new Set(scopedRuns.flatMap((r) => Object.keys(r.metrics)));
	const metricsAvailable = [
		...METRIC_ORDER.filter((m) => present.has(m)),
		...[...present].filter((m) => !METRIC_ORDER.includes(m)).sort(),
	];
	const metric =
		q.metric && present.has(q.metric)
			? q.metric
			: def.primary_metric && present.has(def.primary_metric)
				? def.primary_metric
				: (def.primary_metric ?? metricsAvailable[0] ?? '');
	const pairedMetric = metricDef(ledger, metric).pair_with;
	const columns = [
		metric,
		...(pairedMetric && pairedMetric !== metric ? [pairedMetric] : []),
		...metricsAvailable.filter((m) => m !== metric && m !== pairedMetric),
	].filter(Boolean);

	const view = q.view === 'chart' ? 'chart' : q.view === 'matrix' ? 'matrix' : 'table';

	// ONE ROW PER VARIANT. Three draws of a frozen configuration are one row with
	// a band and n=3, never three unrelated points.
	const rows = buildRows(ledger, scopedRuns, columns);
	const hasBlankCell = rows.some((row) => columns.some((m) => !row.stats[m]));
	const hasPartialCell = rows.some((row) => columns.some((m) => row.stats[m]?.partial));

	// Rank on the MEDIAN of a variant's draws — a max would be the cherry-pick
	// the band exists to prevent.
	const higherWins = metricDef(ledger, metric).higher_is_better;
	rows.sort((a, b) => {
		const av = a.stats[metric]?.median;
		const bv = b.stats[metric]?.median;
		if (av === undefined && bv === undefined) return b.lastAt.localeCompare(a.lastAt);
		if (av === undefined) return 1;
		if (bv === undefined) return -1;
		if (av !== bv) return higherWins ? bv - av : av - bv;
		return b.lastAt.localeCompare(a.lastAt);
	});

	return {
		task,
		tasks,
		dataset,
		def,
		datasets,
		activeDatasets,
		otherDatasets,
		metric,
		pairedMetric,
		metricsAvailable,
		columns,
		variants,
		variantFilter,
		arms,
		armsFallback,
		productCount: productVariants.length,
		researchCount: variants.length - productVariants.length,
		hasBlankCell,
		hasPartialCell,
		since,
		view,
		rows,
		scopedRuns,
		datasetRuns,
		canonical: {
			task,
			dataset,
			metric,
			variants: variantFilter.length ? variantFilter.join(',') : null,
			// `armsFallback` is a consequence of the data, not a choice the user
			// made, so it never lands in the link they copy.
			arms: !armsFallback && arms === 'all' ? 'all' : null,
			since: since === 'all' ? null : since,
			view: view === 'table' ? null : view,
		},
	};
}

export type MatrixCell = {
	dataset: string;
	primary: MetricStat | undefined;
	paired: MetricStat | undefined;
	draws: number;
};
export type ExposureGroup = 'held_out' | 'selection' | 'unrecorded';
export type MatrixColumn = {
	name: string;
	def: BenchmarkDef;
	group: ExposureGroup;
	runs: number;
	/** Carried onto the column so a caveat cannot be lost by leaving its own tab. */
	caveat: string | null;
};
export type MatrixRow = { variant: string; label: string; def: VariantDef; cells: MatrixCell[] };
export type Matrix = {
	metric: string;
	pairedMetric: string | null;
	columns: MatrixColumn[];
	/** Contiguous column runs, so the header can span a band per exposure. */
	groups: { key: ExposureGroup; label: string; span: number }[];
	rows: MatrixRow[];
	/** Active datasets left out because their runs never recorded the matrix metric. */
	excluded: string[];
	/** Arms dropped because they were never measured on any column. */
	unmeasured: string[];
};

const GROUP_ORDER: ExposureGroup[] = ['held_out', 'selection', 'unrecorded'];
const GROUP_LABEL: Record<ExposureGroup, string> = {
	held_out: 'Held out — no arm saw this data before it was scored',
	selection: 'Selection — the arms were iterated against this data',
	unrecorded: 'Exposure not recorded',
};

/**
 * One row per shown variant, one column per active dataset, held-out first and banded by exposure.
 */
export function buildMatrix(ledger: Ledger, v: ResolvedView): Matrix {
	const metric = v.metric;
	const pairedMetric = metricDef(ledger, metric).pair_with;
	const carriesMetric = (name: string) =>
		ledger.runs.some((r) => r.algo === v.task && r.benchmark === name && metric in r.metrics);

	const candidates = v.activeDatasets.filter((d) => d.runs > 0);
	const columns: MatrixColumn[] = candidates
		.filter((d) => carriesMetric(d.name))
		.map((d) => ({
			name: d.name,
			def: d.def,
			group: (d.def.exposure ?? 'unrecorded') as ExposureGroup,
			runs: d.runs,
			caveat: d.def.caveat,
		}))
		.sort(
			(a, b) =>
				GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group) ||
				a.def.sort - b.def.sort ||
				a.name.localeCompare(b.name),
		);
	const excluded = candidates.filter((d) => !carriesMetric(d.name)).map((d) => d.name);

	const groups: Matrix['groups'] = [];
	for (const c of columns) {
		const last = groups.at(-1);
		if (last && last.key === c.group) last.span += 1;
		else groups.push({ key: c.group, label: GROUP_LABEL[c.group], span: 1 });
	}

	// The same arms the leaderboard is showing — the matrix is the SAME question
	// asked across frames, so it must never disagree about who is on screen.
	const shown = [...new Set(v.rows.map((r) => r.variant))];
	const built: MatrixRow[] = shown
		.map((variant) => {
			const cells = columns.map((c) => {
				const runs = ledger.runs.filter((r) => r.algo === v.task && r.benchmark === c.name && r.variant === variant);
				const built = buildRows(ledger, runs, [metric, ...(pairedMetric ? [pairedMetric] : [])])[0];
				return {
					dataset: c.name,
					primary: built?.stats[metric],
					paired: pairedMetric ? built?.stats[pairedMetric] : undefined,
					draws: runs.length,
				};
			});
			return { variant, label: variantLabel(ledger, variant), def: variantDef(ledger, variant), cells };
		})
		.sort((a, b) => a.def.sort - b.def.sort || a.label.localeCompare(b.label));

	// An arm measured on none of these datasets contributes a row of "not
	// measured" and nothing else. Name it below the table instead.
	const rows = built.filter((r) => r.cells.some((c) => c.primary));
	const unmeasured = built.filter((r) => !r.cells.some((c) => c.primary)).map((r) => r.label);

	return {
		metric,
		pairedMetric,
		columns,
		groups,
		rows,
		excluded,
		unmeasured,
	};
}

export const EXPOSURE_WORD: Record<string, string> = {
	held_out: 'held out',
	selection: 'a selection set',
};

/**
 * Composed from n_rows + label + exposure so the size is never typed twice; falls back to the description's first sentence.
 */
export function datasetSentence(v: ResolvedView, fallbackN: number | null): string {
	const n = v.def.n_rows ?? fallbackN;
	const exposure = v.def.exposure ? `, ${EXPOSURE_WORD[v.def.exposure]}` : '';
	if (v.def.label) return `${n === null ? '' : `${n} `}${v.def.label}${exposure}`;
	const firstSentence = v.def.description?.split(/(?<=[.;])\s/)[0]?.trim();
	if (firstSentence) return `${firstSentence.replace(/\.$/, '')}${exposure}`;
	return `No plain-words label recorded — add one with benchmark-set --label${exposure}`;
}

/** A cell: the BAND across draws when they differ, the single value when they do not. */
export function statText(stat: MetricStat | undefined): string {
	if (!stat) return '—';
	const unit = stat.def.unit;
	if (stat.draws > 1 && stat.min !== stat.max) {
		return `${formatValue(stat.min, unit)}–${formatValue(stat.max, unit)}`;
	}
	return formatValue(stat.median, unit);
}

/** Why a cell is not a plain number: never recorded and recorded on some draws are different facts. */
export function cellNote(row: { draws: number; label: string }, stat: MetricStat | undefined, metric: string): string {
	if (!stat) return `${row.label} never recorded ${metric}`;
	if (stat.partial) return `measured on ${stat.draws} of ${row.draws} draws`;
	return '';
}
