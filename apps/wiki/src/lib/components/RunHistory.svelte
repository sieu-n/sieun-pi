<script lang="ts">
	import EChart from '$lib/charts/EChart.svelte';
	import {
		axisTooltip,
		insideZoom,
		lineSeries,
		recipeGrid,
		recipeLegend,
		sliderZoom,
		timeAxis,
		tooltipHtml,
		valueAxis,
	} from '$lib/charts/recipe';
	import type { ChartTokens } from '$lib/charts/tokens';
	import {
		axisTimeLabel,
		diffRuns,
		formatAxis,
		formatDelta,
		formatMetric,
		formatUtc,
		metricNames,
		metricOf,
		shortSha,
		trendLines,
		trendPoints,
		unitOf,
		type Run,
		type TrendPoint,
	} from '$lib/run-history';

	let {
		component,
		runs,
		metric = $bindable(null),
	}: { component: string; runs: Run[]; metric?: string | null } = $props();

	const metrics = $derived(metricNames(runs));
	const chosen = $derived(metric && metrics.includes(metric) ? metric : (metrics[0] ?? null));
	const unit = $derived(chosen ? unitOf(runs, chosen) : null);
	const points = $derived(chosen ? trendPoints(runs, chosen) : []);
	const hasBand = $derived(points.some((p) => p.lo !== null && p.hi !== null));
	const newestFirst = $derived(
		[...runs].sort((a, b) => b.started_at.localeCompare(a.started_at) || b.run_id.localeCompare(a.run_id)),
	);

	let picked = $state<string[]>([]);
	const pair = $derived.by(() => {
		const [a, b] = picked.map((id) => runs.find((r) => r.run_id === id)).filter((r): r is Run => !!r);
		if (!a || !b) return null;
		return a.started_at <= b.started_at ? [a, b] : [b, a];
	});
	const diff = $derived(pair ? diffRuns(pair[0], pair[1]) : null);

	function toggle(runId: string) {
		picked = picked.includes(runId) ? picked.filter((id) => id !== runId) : [...picked, runId].slice(-2);
	}

	const lines = $derived(trendLines(points));
	// A ratio that stays within 0 to 1 reads on a fixed 0 to 100% axis, so two metrics compare at a glance.
	const ratioScale = $derived(unit === 'ratio' && points.every((p) => p.value >= 0 && (p.hi ?? p.value) <= 1));
	const lineName = (dataset: string | null) => dataset ?? 'no dataset';

	function trendOption(t: ChartTokens): Record<string, unknown> {
		const fmt = (v: number) => formatMetric(v, unit);
		const time = timeAxis(t);
		const span = points.length ? points[points.length - 1].t - points[0].t : 0;
		const color = (i: number) => (lines.length === 1 ? t.accent : t.palette[i % t.palette.length]);
		const series = lines.flatMap((line, i) => {
			const ci = (id: string, at: (lo: number, hi: number) => number) => ({
				id: `${id}:${i}`,
				type: 'line',
				stack: `ci:${i}`,
				symbol: 'none',
				silent: true,
				lineStyle: { opacity: 0 },
				data: line.points.map((p) => [p.t, p.lo !== null && p.hi !== null ? at(p.lo, p.hi) : null]),
			});
			const band = line.points.some((p) => p.lo !== null && p.hi !== null)
				? [
						ci('ci-low', (lo) => lo),
						{ ...ci('ci-band', (lo, hi) => hi - lo), areaStyle: { color: color(i), opacity: 0.14 } },
					]
				: [];
			const value = {
				...lineSeries(t, {
					name: lineName(line.dataset),
					color: color(i),
					data: line.points.map((p) => [p.t, p.value]),
					smooth: false,
					areaOpacity: 0,
					symbolSize: 7,
				}),
				id: `value:${i}`,
			};
			return [...band, value];
		});
		return {
			grid: recipeGrid({ top: lines.length > 1 ? 34 : 16, right: 16, bottom: 46, left: 4 }),
			legend: { ...recipeLegend(t, { show: lines.length > 1 }), type: 'scroll' },
			xAxis: { ...time, axisLabel: { ...(time.axisLabel as object), formatter: axisTimeLabel(span) } },
			yAxis: ratioScale
				? { ...valueAxis(t, { formatter: (v: number) => formatAxis(v, unit), min: 0, max: 1 }), interval: 0.25 }
				: { ...valueAxis(t, { formatter: (v: number) => formatAxis(v, unit) }), scale: true },
			tooltip: axisTooltip(t, {
				formatter: (items: { dataIndex: number; seriesId: string }[]) => {
					const hits = items
						.filter((it) => it.seriesId.startsWith('value:'))
						.map((it) => {
							const i = Number(it.seriesId.slice('value:'.length));
							return { i, p: lines[i]?.points[it.dataIndex] };
						})
						.filter((h): h is { i: number; p: TrendPoint } => !!h.p);
					if (!hits.length) return '';
					return tooltipHtml(
						t,
						formatUtc(new Date(hits[0].p.t).toISOString()),
						hits.map(({ i, p }) => ({
							swatch: color(i),
							label: lines.length > 1 ? `${p.run_id} · ${lineName(p.dataset)}` : p.run_id,
							value: fmt(p.value),
							sub: p.lo !== null && p.hi !== null ? `CI ${fmt(p.lo)} to ${fmt(p.hi)}` : undefined,
						})),
					);
				},
			}),
			dataZoom: [insideZoom(), sliderZoom(t)],
			series,
		};
	}

	const onEvents = {
		click: (params: { seriesId?: string; dataIndex: number }) => {
			const i = params.seriesId?.startsWith('value:') ? Number(params.seriesId.slice('value:'.length)) : -1;
			const p = lines[i]?.points[params.dataIndex];
			if (p) toggle(p.run_id);
		},
	};
</script>

{#if runs.length === 0}
	<p class="empty">
		No runs recorded for <code>{component}</code> yet. A run shows up here once its script or route calls
		<code>record_run</code> in <code>scripts/run_history.py</code>.
	</p>
{:else}
	{#if metrics.length}
		<label class="field">
			<span>Metric ({metrics.length})</span>
			<select value={chosen} onchange={(e) => (metric = e.currentTarget.value)}>
				{#each metrics as m (m)}<option value={m}>{m}</option>{/each}
			</select>
		</label>
		<div class="chart">
			<EChart option={trendOption} height="300px" {onEvents} />
		</div>
		<p class="note">
			Each dot is one run's <code>{chosen}</code> by its start time in UTC{lines.length > 1
				? ', with one line per dataset'
				: ''}{hasBand ? ', and the shaded band is its CI' : ''}. Click a dot or tick two rows to compare them.
		</p>
	{:else}
		<p class="empty">These runs carry no metrics.</p>
	{/if}

	<div class="tablewrap">
		<table class="board">
			<thead>
				<tr>
					<th><span class="sr">Compare</span></th>
					<th>started (UTC)</th>
					<th>run</th>
					<th>kind</th>
					<th>commit</th>
					<th>model</th>
					<th>dataset</th>
					<th>config</th>
					{#if chosen}<th class="num star">{chosen}</th>{/if}
				</tr>
			</thead>
			<tbody>
				{#each newestFirst as r (r.run_id)}
					{@const m = chosen ? metricOf(r, chosen) : null}
					<tr class:picked={picked.includes(r.run_id)}>
						<td>
							<input
								type="checkbox"
								checked={picked.includes(r.run_id)}
								onchange={() => toggle(r.run_id)}
								aria-label={`Compare ${r.run_id}`}
							/>
						</td>
						<td class="mono nowrap">{formatUtc(r.started_at)}</td>
						<td class="mono run" title={r.notes ?? r.source}>{r.run_id}</td>
						<td>{r.kind}</td>
						<td class="mono" title={r.commit ?? 'no commit recorded'}>{shortSha(r.commit)}</td>
						<td>{r.model ?? '—'}</td>
						<td class="mono">{r.dataset ?? '—'}</td>
						<td class="mono" title={r.config_hash}>{r.config_hash.slice(0, 8)}</td>
						{#if chosen}
							<td class="num star"
								>{formatMetric(m?.value ?? null, m?.unit ?? unit)}{#if m?.ci_low != null && m?.ci_high != null}<span
										class="ci">{formatMetric(m.ci_low, m.unit)} to {formatMetric(m.ci_high, m.unit)}</span
									>{/if}</td
							>
						{/if}
					</tr>
				{/each}
			</tbody>
		</table>
	</div>

	{#if pair && diff}
		<section class="diff" aria-label="Run comparison">
			<h3>
				<span class="mono">{pair[0].run_id}</span> against <span class="mono">{pair[1].run_id}</span>
				<button class="tab" onclick={() => (picked = [])}>Clear</button>
			</h3>
			<table class="board">
				<colgroup><col class="key" /><col /><col /><col class="change" /></colgroup>
				<thead>
					<tr><th></th><th>older</th><th>newer</th><th class="num">change</th></tr>
				</thead>
				<tbody>
					<tr class="group"><td colspan="4">Metrics</td></tr>
					{#each diff.metrics as row (row.name)}
						<tr class:changed={row.a !== row.b}>
							<td class="mono">{row.name}</td>
							<td class="num">{formatMetric(row.a, row.unit)}</td>
							<td class="num">{formatMetric(row.b, row.unit)}</td>
							<td class="num">{formatDelta(row.delta, row.unit)}</td>
						</tr>
					{:else}
						<tr><td colspan="4" class="muted">Neither run has metrics.</td></tr>
					{/each}
					<tr class="group"><td colspan="4">Config</td></tr>
					{#each diff.config as row (row.key)}
						<tr class:changed={row.changed}>
							<td class="mono">{row.key}</td>
							<td class="mono">{row.a ?? '—'}</td>
							<td class="mono">{row.b ?? '—'}</td>
							<td class="num">{row.changed ? 'changed' : ''}</td>
						</tr>
					{:else}
						<tr><td colspan="4" class="muted">Both configs are empty.</td></tr>
					{/each}
					<tr class="group"><td colspan="4">Run</td></tr>
					{#each diff.fields as row (row.key)}
						<tr class:changed={row.changed}>
							<td class="mono">{row.key}</td>
							<td class="mono">{row.key === 'started_at' ? formatUtc(row.a) : (row.a ?? '—')}</td>
							<td class="mono">{row.key === 'started_at' ? formatUtc(row.b) : (row.b ?? '—')}</td>
							<td class="num">{row.changed ? 'changed' : ''}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</section>
	{:else if picked.length === 1}
		<p class="note">Tick one more run to compare it with <span class="mono">{picked[0]}</span>.</p>
	{/if}
{/if}

<style>
	.field {
		display: inline-flex;
		flex-direction: column;
		gap: 4px;
		font-size: 12px;
		margin: 0 0 10px;
	}
	.field > span {
		color: var(--ink-muted);
	}
	.field select {
		font: inherit;
		font-size: 13px;
		padding: 5px 9px;
		border: 1px solid var(--border);
		border-radius: 6px;
		background: var(--surface);
		color: inherit;
		max-width: 28rem;
	}
	.tab {
		font: inherit;
		font-size: 12px;
		padding: 4px 11px;
		border-radius: 999px;
		border: 1px solid var(--border);
		background: var(--surface);
		color: var(--ink-muted);
		cursor: pointer;
	}
	.chart {
		--color-ink: var(--ink);
		--color-ink-muted: var(--ink-muted);
		--color-ink-faint: var(--ink-muted);
		--color-rule: var(--border);
		--color-surface: var(--surface);
		--color-surface-alt: var(--surface-alt);
		--color-accent: var(--accent);
		--color-positive: var(--accent);
		border: 1px solid var(--border);
		border-radius: 10px;
		background: var(--surface);
		padding: 8px 10px 4px;
	}
	.note,
	.empty {
		margin: 8px 2px 0;
		font-size: 12px;
		color: var(--ink-muted);
		max-width: 92ch;
	}
	.empty {
		font-size: 13.5px;
		padding: 18px;
		border: 1px dashed var(--border);
		border-radius: 10px;
		background: var(--surface);
		max-width: none;
	}
	.tablewrap {
		overflow-x: auto;
		margin: 18px 0 0;
		border: 1px solid var(--border);
		border-radius: 10px;
		background: var(--surface);
	}
	table.board {
		border-collapse: collapse;
		width: 100%;
		font-size: 13px;
	}
	table.board th {
		text-align: left;
		padding: 7px 9px;
		color: var(--ink-muted);
		font-weight: 500;
		font-size: 11px;
		border-bottom: 1px solid var(--border);
		white-space: nowrap;
	}
	table.board td {
		white-space: nowrap;
		padding: 6px 9px;
		border-bottom: 1px solid var(--border-soft);
		color: var(--ink-soft);
		vertical-align: top;
	}
	table.board tbody tr:last-child td {
		border-bottom: none;
	}
	table.board .num {
		text-align: right;
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
	}
	table.board th.star,
	table.board td.star {
		color: var(--ink);
	}
	table.board td.star {
		font-weight: 600;
	}
	table.board td.run {
		white-space: normal;
		overflow-wrap: anywhere;
		min-width: 18ch;
	}
	.diff table.board td {
		white-space: normal;
		overflow-wrap: anywhere;
	}
	.diff table.board {
		table-layout: fixed;
	}
	.diff col.key {
		width: 26%;
	}
	.diff col.change {
		width: 12%;
	}
	.diff table.board td.num {
		white-space: nowrap;
	}
	tr.picked td {
		background: var(--accent-soft);
	}
	tr.changed td {
		color: var(--ink);
		background: #fffbeb;
	}
	tr.group td {
		padding-top: 12px;
		font-size: 11px;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: var(--ink-muted);
		background: var(--surface-alt);
	}
	.ci {
		display: block;
		font-weight: 400;
		font-size: 11px;
		color: var(--ink-muted);
	}
	.mono {
		font-family: ui-monospace, monospace;
		font-size: 11.5px;
	}
	.nowrap {
		white-space: nowrap;
	}
	.muted {
		color: var(--ink-muted);
	}
	.diff {
		margin: 22px 0 0;
		border: 1px solid var(--border);
		border-radius: 10px;
		background: var(--surface);
		overflow-x: auto;
	}
	.diff h3 {
		display: flex;
		flex-wrap: wrap;
		overflow-wrap: anywhere;
		align-items: center;
		gap: 8px;
		margin: 0;
		padding: 10px 12px;
		font-size: 14px;
		border-bottom: 1px solid var(--border);
	}
	.diff h3 .tab {
		margin-left: auto;
	}
	.sr {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip: rect(0 0 0 0);
	}
</style>
