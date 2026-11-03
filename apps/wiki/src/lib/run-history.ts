import { base } from '$app/paths';
/** The shared run history as the wiki reads it: `scripts/run_history.py export` prints `{ runs }`. */

export type RunKind = 'eval' | 'benchmark' | 'load-test' | 'probe' | 'arm';

export interface RunMetric {
	name: string;
	value: number | null;
	ci_low: number | null;
	ci_high: number | null;
	unit: string | null;
}

export interface Run {
	component: string;
	run_id: string;
	kind: RunKind;
	/** UTC ISO with a trailing Z. */
	started_at: string;
	ended_at: string | null;
	commit: string | null;
	model: string | null;
	prompt_hash: string | null;
	dataset: string | null;
	config: Record<string, unknown>;
	config_hash: string;
	artifacts: { label?: string; path: string }[];
	source: string;
	notes: string | null;
	metrics: RunMetric[];
}

export interface RunsExport {
	runs: Run[];
}

/** GET /api/playground/runs, failing with the route's message. */
export async function fetchRuns(component?: string): Promise<Run[]> {
	const resp = await fetch(component ? `${base}/api/playground/runs?component=${component}` : `${base}/api/playground/runs`);
	if (!resp.ok) throw new Error((await resp.json().catch(() => null))?.message ?? `HTTP ${resp.status}`);
	return ((await resp.json()) as RunsExport).runs;
}

/** The slug rule run_history.py checks on every component name. */
const SLUG = /^[a-z0-9][a-z0-9._-]*$/;

export const isComponent = (value: string): boolean => SLUG.test(value);

export function componentCounts(runs: Run[]): { component: string; runs: number }[] {
	const counts = new Map<string, number>();
	for (const r of runs) counts.set(r.component, (counts.get(r.component) ?? 0) + 1);
	return [...counts.entries()]
		.map(([component, n]) => ({ component, runs: n }))
		.sort((a, b) => a.component.localeCompare(b.component));
}

/** Metric names with a value, the most recorded first. */
export function metricNames(runs: Run[]): string[] {
	const counts = new Map<string, number>();
	for (const r of runs)
		for (const m of r.metrics) if (m.value !== null) counts.set(m.name, (counts.get(m.name) ?? 0) + 1);
	return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([name]) => name);
}

export const metricOf = (run: Run, name: string): RunMetric | null => run.metrics.find((m) => m.name === name) ?? null;

export interface TrendPoint {
	run_id: string;
	dataset: string | null;
	t: number;
	value: number;
	lo: number | null;
	hi: number | null;
}

export function trendPoints(runs: Run[], metric: string): TrendPoint[] {
	const out: TrendPoint[] = [];
	for (const r of runs) {
		const m = metricOf(r, metric);
		if (m?.value === null || m?.value === undefined) continue;
		out.push({
			run_id: r.run_id,
			dataset: r.dataset,
			t: Date.parse(r.started_at),
			value: m.value,
			lo: m.ci_low,
			hi: m.ci_high,
		});
	}
	return out.sort((a, b) => a.t - b.t || a.run_id.localeCompare(b.run_id));
}

/** One line per dataset, because a metric on two datasets is two different measurements. */
export function trendLines(points: TrendPoint[]): { dataset: string | null; points: TrendPoint[] }[] {
	const lines = new Map<string | null, TrendPoint[]>();
	for (const p of points) lines.set(p.dataset, [...(lines.get(p.dataset) ?? []), p]);
	return [...lines.entries()].map(([dataset, pts]) => ({ dataset, points: pts }));
}

export const unitOf = (runs: Run[], metric: string): string | null =>
	runs.map((r) => metricOf(r, metric)?.unit).find((u) => u) ?? null;

/** Config leaves keyed by their dotted path; arrays and scalars print as JSON. */
function flattenConfig(value: unknown, prefix = ''): Record<string, string> {
	if (value === null || typeof value !== 'object' || Array.isArray(value))
		return { [prefix || '(config)']: JSON.stringify(value) };
	const entries = Object.entries(value as Record<string, unknown>);
	if (!entries.length) return prefix ? { [prefix]: '{}' } : {};
	return Object.assign({}, ...entries.map(([k, v]) => flattenConfig(v, prefix ? `${prefix}.${k}` : k)));
}

interface DiffRow {
	key: string;
	a: string | null;
	b: string | null;
	changed: boolean;
}

interface MetricDiffRow {
	name: string;
	unit: string | null;
	a: number | null;
	b: number | null;
	/** b minus a when both have a value. */
	delta: number | null;
}

const FIELDS = ['kind', 'started_at', 'commit', 'model', 'prompt_hash', 'dataset', 'config_hash', 'source'] as const;

function rows(a: Record<string, string | null>, b: Record<string, string | null>, keys: string[]): DiffRow[] {
	return keys.map((key) => ({
		key,
		a: a[key] ?? null,
		b: b[key] ?? null,
		changed: (a[key] ?? null) !== (b[key] ?? null),
	}));
}

/** The two-run comparison: run fields, every config leaf and every metric, in the order a reader scans them. */
export function diffRuns(a: Run, b: Run): { fields: DiffRow[]; config: DiffRow[]; metrics: MetricDiffRow[] } {
	const pick = (r: Run) => Object.fromEntries(FIELDS.map((f) => [f, r[f]]));
	const ca = flattenConfig(a.config);
	const cb = flattenConfig(b.config);
	const configKeys = [...new Set([...Object.keys(ca), ...Object.keys(cb)])].sort();
	const names = [...new Set([...a.metrics, ...b.metrics].map((m) => m.name))].sort();
	return {
		fields: rows(pick(a), pick(b), [...FIELDS]),
		config: rows(ca, cb, configKeys),
		metrics: names.map((name) => {
			const ma = metricOf(a, name);
			const mb = metricOf(b, name);
			const va = ma?.value ?? null;
			const vb = mb?.value ?? null;
			return {
				name,
				unit: ma?.unit ?? mb?.unit ?? null,
				a: va,
				b: vb,
				delta: va !== null && vb !== null ? vb - va : null,
			};
		}),
	};
}

/** `2026-10-20 09:00Z`: every stored time is UTC. */
export function formatUtc(iso: string | null): string {
	if (!iso) return '—';
	const d = new Date(iso);
	return Number.isNaN(d.getTime()) ? iso : `${d.toISOString().slice(0, 16).replace('T', ' ')}Z`;
}

export const shortSha = (commit: string | null): string => (commit ? commit.slice(0, 10) : '—');

export function formatMetric(value: number | null, unit: string | null): string {
	if (value === null || !Number.isFinite(value)) return '—';
	switch (unit) {
		case 'ratio':
			return `${(value * 100).toFixed(1)}%`;
		case 'ms':
			return `${Math.round(value).toLocaleString('en-US')} ms`;
		case 'seconds':
		case 's':
			return `${value.toFixed(2)} s`;
		case 'usd':
			return `$${value.toFixed(2)}`;
		default: {
			const n = (Number.isInteger(value) ? value : Number(value.toPrecision(4))).toLocaleString('en-US', {
				maximumFractionDigits: 4,
			});
			return unit && unit !== 'count' ? `${n} ${unit}` : n;
		}
	}
}

const COMPACT = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });

/** A short axis label: percents for a ratio, compact numbers otherwise. */
export function formatAxis(value: number, unit: string | null): string {
	if (unit === 'ratio') return `${Number((value * 100).toFixed(1))}%`;
	if (unit === 'usd') return `$${COMPACT.format(value)}`;
	if (unit === 'ms' || unit === 's' || unit === 'seconds')
		return `${COMPACT.format(value)} ${unit === 'ms' ? 'ms' : 's'}`;
	return COMPACT.format(value);
}

const DAY_TIME = new Intl.DateTimeFormat('en-US', {
	month: 'short',
	day: 'numeric',
	hour: '2-digit',
	minute: '2-digit',
	hourCycle: 'h23',
	timeZone: 'UTC',
});
const DAY = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

/** Time-axis labels in UTC, with the hour when the runs span under a week, where ticks fall inside a day. */
export function axisTimeLabel(spanMs: number): (t: number) => string {
	const fmt = spanMs < 7 * 86_400_000 ? DAY_TIME : DAY;
	return (t) => fmt.format(new Date(t));
}

/** A delta in the metric's own unit, with its sign. */
export function formatDelta(delta: number | null, unit: string | null): string {
	if (delta === null) return '—';
	if (delta === 0) return '0';
	const abs = Math.abs(delta);
	return `${delta > 0 ? '+' : '−'}${unit === 'ratio' ? `${(abs * 100).toFixed(1)} pp` : formatMetric(abs, unit)}`;
}
