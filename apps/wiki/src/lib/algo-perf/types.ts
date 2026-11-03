/**
 * Shapes of the algo-perf ledger export (scripts/algo-perf.py export): task -> dataset -> leaderboard.
 * A dataset owns its metrics, and `primary_metric` is the one it ranks by.
 */

export type MetricUnit = 'ratio' | 'seconds' | 'ms' | 'count' | 'kb';

export type MetricVal = { value: number; ci_low: number | null; ci_high: number | null };

export type Run = {
	run_id: string;
	run_at: string;
	algo: string;
	variant: string;
	benchmark: string;
	n: number | null;
	source: string | null;
	notes: string | null;
	metrics: Record<string, MetricVal>;
};

export type Preset = {
	id: string;
	label: string;
	description: string | null;
	algo: string;
	metric: string;
	benchmarks: string[] | null;
	sort: number;
};

export type MetricDef = {
	description: string | null;
	higher_is_better: boolean;
	unit: MetricUnit;
	/** Publishing contract: this metric is never quoted without that one. */
	pair_with: string | null;
};

export type BenchmarkDef = {
	description: string | null;
	source: string | null;
	/** Plain-words noun phrase, no size: "creators with no address on their profile". */
	label: string | null;
	primary_metric: string | null;
	n_rows: number | null;
	exposure: 'held_out' | 'selection' | null;
	status: 'active' | 'archived';
	caveat: string | null;
	/** Dataset order; the lowest-sort active dataset is its task's landing view. */
	sort: number;
	/** Owning algo family. Lets a frame register BEFORE it is scored and still appear. */
	task: string | null;
};

export type VariantDef = {
	task: string | null;
	label: string | null;
	/** `product` is what the leaderboard shows by default; everything else is a research arm. */
	kind: 'product' | 'research';
	description: string | null;
	status: 'active' | 'superseded';
	sort: number;
};

export type Ledger = {
	db: string;
	runs: Run[];
	presets: Preset[];
	metric_defs: Record<string, MetricDef>;
	benchmark_defs: Record<string, BenchmarkDef>;
	variant_defs: Record<string, VariantDef>;
};
