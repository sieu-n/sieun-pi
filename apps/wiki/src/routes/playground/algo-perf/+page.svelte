<script lang="ts">
	import { base } from '$app/paths';
	import { browser } from '$app/environment';
	import { replaceState } from '$app/navigation';
	import { page } from '$app/state';
	import {
		buildMatrix,
		cellNote,
		datasetSentence,
		formatValue,
		formatWhen,
		metricDef,
		queryFromSearchParams,
		resolveView,
		slugify,
		statText,
		taskLabel,
		variantDef,
		variantMatches,
		type LeaderRow,
		type ViewQuery,
	} from '$lib/algo-perf/leaderboard';
	import { viewHref } from '$lib/algo-perf/markdown';
	import type { Ledger } from '$lib/algo-perf/types';

	let ledger = $state.raw<Ledger | null>(null);
	let loadErr = $state('');

	// The query string is the view. `q` mirrors it, and replaceState updates the address bar without a navigation.
	let q = $state<ViewQuery>(queryFromSearchParams(page.url.searchParams));
	function setQ(patch: Partial<ViewQuery>) {
		q = { ...q, ...patch };
		if (!browser) return;
		const url = new URL(location.href);
		for (const [k, v] of Object.entries(q)) {
			if (v) url.searchParams.set(k, v);
			else url.searchParams.delete(k);
		}
		replaceState(url, page.state);
	}

	async function load() {
		try {
			const r = await fetch(`${base}/api/playground/algo-perf`);
			if (!r.ok) throw new Error((await r.json().catch(() => null))?.message ?? `HTTP ${r.status}`);
			ledger = (await r.json()) as Ledger;
		} catch (e) {
			loadErr = e instanceof Error ? e.message : String(e);
		}
	}
	$effect(() => {
		if (!ledger && !loadErr) void load();
	});

	const view = $derived(ledger ? resolveView(ledger, q) : null);
	const mdef = (m: string) => (ledger ? metricDef(ledger, m) : null);
	const UNANNOTATED = 'No annotation — add one with scripts/algo-perf.py';
	const metricTitle = (m: string) => mdef(m)?.description ?? UNANNOTATED;

	// A variant's colour follows the variant, never its rank: a golden-angle walk
	// over a stable hash of the name, so a re-sort never repaints the chart.
	function hue(name: string): string {
		let h = 0;
		for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
		return `oklch(0.62 0.15 ${Math.round((h * 137.508) % 360)})`;
	}

	const scoredN = $derived(view?.rows.find((r) => r.scoredN !== null)?.scoredN ?? null);
	const headline = $derived(view ? datasetSentence(view, scoredN) : '');
	const lastMeasured = $derived(view?.datasetRuns.at(-1)?.run_at ?? null);

	let expanded = $state<string[]>([]);
	const toggleRow = (v: string) =>
		(expanded = expanded.includes(v) ? expanded.filter((x) => x !== v) : [...expanded, v]);

	const SINCE_OPTIONS = ['all', '7d', '14d', '30d', '90d', '180d', '365d'];
	let sinceN = $state(30);

	// Both endpoints across every frame. Built by the SHARED buildMatrix, so the
	// page and the &format=md answer cannot disagree about a number.
	const matrix = $derived(ledger && view ? buildMatrix(ledger, view) : null);

	const savedViews = $derived((ledger?.presets ?? []).filter((p) => p.algo === view?.task));
	function presetHref(benchmarks: string[] | null, metric: string): string {
		const dataset = benchmarks?.find((b) => view?.datasets.some((d) => d.name === b)) ?? null;
		return viewHref({ task: view?.task ?? null, dataset, metric, variants: null, arms: null, since: null, view: null });
	}

	const DAY = 86_400_000;
	let chartW = $state(900);
	const H = 320;
	const M = { t: 14, r: 96, b: 30, l: 58 };
	type Point = { runId: string; variant: string; t: number; value: number; lo: number | null; hi: number | null };
	const points = $derived.by<Point[]>(() => {
		if (!view) return [];
		return view.scopedRuns
			.filter((r) => view.metric in r.metrics)
			.map((r) => ({
				runId: r.run_id,
				variant: r.variant,
				t: Date.parse(r.run_at),
				value: r.metrics[view.metric].value,
				lo: r.metrics[view.metric].ci_low,
				hi: r.metrics[view.metric].ci_high,
			}))
			.sort((a, b) => a.t - b.t || a.runId.localeCompare(b.runId));
	});
	const chartUnit = $derived(view ? (mdef(view.metric)?.unit ?? 'ratio') : 'ratio');
	const dates = $derived([...new Set(points.map((p) => p.t))].sort((a, b) => a - b));
	const span = $derived(Math.max(1, (dates.at(-1) ?? 0) - (dates[0] ?? 0)));
	const x0 = $derived((dates[0] ?? 0) - span * 0.05);
	const x1 = $derived((dates.at(-1) ?? 0) + span * 0.05);
	const yMax = $derived(chartUnit === 'ratio' ? 1 : Math.max(0.001, ...points.map((p) => p.hi ?? p.value)) * 1.15);
	const px = (t: number) => M.l + ((t - x0) / Math.max(1, x1 - x0)) * (chartW - M.l - M.r);
	const py = (v: number) => M.t + (1 - v / yMax) * (H - M.t - M.b);
	const chartSeries = $derived.by(() => {
		const byVariant = new Map<string, Point[]>();
		for (const p of points) byVariant.set(p.variant, [...(byVariant.get(p.variant) ?? []), p]);
		return [...byVariant.entries()].map(([variant, pts]) => ({ variant, pts }));
	});
	const yTicks = $derived(
		[0, 0.25, 0.5, 0.75, 1].map((f) => (chartUnit === 'ratio' ? f : Math.round(yMax * f * 100) / 100)),
	);
	const xTicks = $derived.by(() => {
		const out: number[] = [];
		let last = -Infinity;
		for (const d of dates) {
			if (px(d) - last >= 56) {
				out.push(d);
				last = px(d);
			}
		}
		return out;
	});
	const fmtDay = (t: number) => new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
	let activeDate = $state<number | null>(null);
	let pointerX = $state(0);
	function onMove(e: PointerEvent) {
		if (!dates.length) return;
		const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
		const mx = e.clientX - rect.left;
		let best = dates[0];
		for (const d of dates) if (Math.abs(px(d) - mx) < Math.abs(px(best) - mx)) best = d;
		activeDate = best;
		pointerX = px(best);
	}
	function onKey(e: KeyboardEvent) {
		if (!dates.length) return;
		const i = activeDate === null ? -1 : dates.indexOf(activeDate);
		if (e.key === 'ArrowRight') activeDate = dates[Math.min(dates.length - 1, i + 1)];
		else if (e.key === 'ArrowLeft') activeDate = dates[Math.max(0, i < 0 ? 0 : i - 1)];
		else if (e.key === 'Escape') activeDate = null;
		else return;
		e.preventDefault();
		if (activeDate !== null) pointerX = px(activeDate);
	}
	const activePoints = $derived(activeDate === null ? [] : points.filter((p) => p.t === activeDate));

	let sql = $state(
		'SELECT r.run_at, r.variant, r.benchmark, m.metric, m.value, r.n\nFROM runs r JOIN metrics m USING (run_id)\nORDER BY r.run_at DESC, r.run_id',
	);
	let sqlRunning = $state(false);
	let sqlErr = $state('');
	let sqlResult = $state.raw<{ columns: string[]; rows: unknown[][] } | null>(null);
	async function runSql() {
		sqlRunning = true;
		sqlErr = '';
		sqlResult = null;
		try {
			const r = await fetch(`${base}/api/playground/algo-perf`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ sql }),
			});
			if (!r.ok) throw new Error((await r.json().catch(() => null))?.message ?? `HTTP ${r.status}`);
			sqlResult = await r.json();
		} catch (e) {
			sqlErr = e instanceof Error ? e.message : String(e);
		} finally {
			sqlRunning = false;
		}
	}

	const rowKey = (r: LeaderRow) => r.variant;
</script>

<svelte:head><title>{view ? `${view.task} · ${view.dataset}` : 'Algo performance'} · llm-wiki</title></svelte:head>

<main class="main">
	{#if loadErr}
		<p class="error">{loadErr}</p>
	{:else if !ledger || !view}
		<p class="muted">Loading the ledger…</p>
	{:else}
		<p class="meta">
			Every run of this task is also in the shared
			<a href="{base}/playground/runs?component={view.task}">run history</a> as component <code>{view.task}</code>.
		</p>
		{#if view.tasks.length > 1}
			<nav class="tasks" aria-label="Task">
				{#each view.tasks as t (t)}
					<button
						class="tab"
						class:on={t === view.task}
						onclick={() => setQ({ task: t, dataset: null, metric: null, variants: null, since: null })}
						>{taskLabel(t)}</button
					>
				{/each}
			</nav>
		{/if}

		<h1>{taskLabel(view.task)} on <span class="ds">{view.dataset}</span></h1>
		<p class="sentence">{headline}</p>
		<p class="meta">
			north star <code title={metricTitle(view.metric)}>{view.metric}</code>
			· {view.rows.length}
			{view.arms === 'product' && !view.variantFilter.length && !view.armsFallback ? 'shipped' : ''} variant{view.rows
				.length === 1
				? ''
				: 's'}
			· {view.scopedRuns.length} run{view.scopedRuns.length === 1 ? '' : 's'}
			{#if lastMeasured}· last measured {formatWhen(lastMeasured)}{/if}
			· <a href={viewHref(view.canonical, { format: 'md' })}>markdown</a>
			{#if view.def.source}· <a href={`${base}/page/${view.def.source}`}>evidence</a>{/if}
		</p>

		<nav class="datasets" aria-label="Dataset">
			{#if view.activeDatasets.length <= 6}
				{#each view.activeDatasets as d (d.name)}
					<button
						class="dchip"
						class:on={d.name === view.dataset}
						class:sel={d.def.exposure === 'selection'}
						title={d.def.description ?? UNANNOTATED}
						onclick={() => setQ({ dataset: d.name, metric: null, variants: null })}
					>
						<span class="dname">{d.name}</span>
						<span class="dn"
							>{d.runs === 0 ? 'not scored yet' : d.def.n_rows ? `${d.def.n_rows} rows` : `${d.runs} runs`}</span
						>
						{#if d.def.exposure === 'selection'}<span class="dmark" title="Selection set">selection</span>
						{:else if d.def.exposure === 'held_out'}<span class="dmark held" title="Held out">held out</span>{/if}
					</button>
				{/each}
			{:else}
				<label class="field">
					<span>Dataset</span>
					<select
						value={view.dataset}
						onchange={(e) => setQ({ dataset: e.currentTarget.value, metric: null, variants: null })}
					>
						{#each view.activeDatasets as d (d.name)}
							<option value={d.name}
								>{d.name} — {d.runs === 0
									? 'not scored yet'
									: d.def.n_rows
										? `${d.def.n_rows} rows`
										: `${d.runs} runs`}</option
							>
						{/each}
					</select>
				</label>
			{/if}
		</nav>

		{#if view.def.exposure === 'selection'}
			<p class="banner sel">
				<strong>Selection set.</strong> Every arm below was iterated against this data, so a win here is a selection number,
				not evidence that it generalises.
			</p>
		{:else if view.def.exposure === 'held_out'}
			<p class="banner held"><strong>Held out.</strong> No arm saw this data before it was scored.</p>
		{:else}
			<p class="banner unknown">
				<strong>Exposure not recorded.</strong> Nobody has said whether the arms were tuned against this data — treat it
				as a selection set until they do (<code>benchmark-set --exposure</code>).
			</p>
		{/if}
		{#if view.def.caveat}<p class="caveat">{view.def.caveat}</p>{/if}

		<div class="board-head">
			<h2>Leaderboard</h2>
			<div class="seg" role="group" aria-label="Payload">
				<button class:on={view.view === 'table'} onclick={() => setQ({ view: null })}>This dataset</button>
				<button class:on={view.view === 'matrix'} onclick={() => setQ({ view: 'matrix' })}>All frames</button>
				<button class:on={view.view === 'chart'} onclick={() => setQ({ view: 'chart' })}>Over time</button>
			</div>
		</div>

		<div class="arms">
			{#if view.armsFallback}
				<span class="arms-note warn"
					>No arm on this dataset is registered as a product, so every variant is shown. Register one with
					<code>algo-perf.py variant-set --kind product</code>.</span
				>
			{:else if view.variantFilter.length}
				<span class="arms-note">Filtered to {view.rows.length} of {view.variants.length} variants by the URL.</span>
				<button class="armbtn" onclick={() => setQ({ variants: null })}>Clear filter</button>
			{:else if view.arms === 'product'}
				<span class="arms-note"
					><strong>The shipped endpoints.</strong>
					{view.researchCount} research arm{view.researchCount === 1 ? '' : 's'} on this dataset are hidden — they never recorded
					most of these metrics.</span
				>
				{#if view.researchCount}
					<button class="armbtn" onclick={() => setQ({ arms: 'all' })}>Show all {view.variants.length} variants</button>
				{/if}
			{:else}
				<span class="arms-note"
					>Showing all {view.variants.length} variants, research arms included. Coverage is uneven — an arm from an earlier
					round never recorded the newer metrics.</span
				>
				<button class="armbtn" onclick={() => setQ({ arms: null })}>Shipped endpoints only</button>
			{/if}
		</div>

		{#if !view.rows.length}
			<p class="muted empty">No runs on this dataset in the current window.</p>
		{:else if view.view === 'matrix'}
			{#if matrix && matrix.columns.length > 1 && matrix.rows.length}
				<div class="tablewrap">
					<table class="board matrix">
						<thead>
							<tr class="groupband">
								<th class="vcol"></th>
								{#each matrix.groups as g, i (g.key + i)}
									<th class={`band ${g.key}`} colspan={g.span}>{g.label}</th>
								{/each}
							</tr>
							<tr>
								<th class="vcol">variant</th>
								{#each matrix.columns as c (c.name)}
									<th class={`num col-${c.group}`} title={c.def.description ?? UNANNOTATED}>
										{c.name}{#if c.caveat}<span class="cvt" title={c.caveat}>!</span>{/if}
										<span class="sub">{c.def.n_rows ? `${c.def.n_rows} rows` : `${c.runs} runs`}</span>
									</th>
								{/each}
							</tr>
						</thead>
						<tbody>
							{#each matrix.rows as row (row.variant)}
								<tr>
									<td class="vcol">
										<span class="key" style={`background:${hue(row.variant)}`}></span><span class="vname"
											>{row.label}</span
										>
									</td>
									{#each row.cells as c (c.dataset)}
										<td class={`num col-${matrix.columns.find((x) => x.name === c.dataset)?.group}`}>
											{#if c.primary}
												<span class="mstar">{statText(c.primary)}</span>
												{#if c.paired}<span class="mpair">{statText(c.paired)}</span>{/if}
												<span class="mdraws">n={c.draws}</span>
											{:else}
												<span class="missing" title={`${row.label} has no run on ${c.dataset}`}>not measured</span>
											{/if}
										</td>
									{/each}
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
				<p class="boardnote">
					Each cell is <code>{matrix.metric}</code>{#if matrix.pairedMetric}&nbsp;over
						<code>{matrix.pairedMetric}</code>{/if} with the draw count. <strong>Held-out columns come first</strong>
					— a selection column is a number the arms were tuned against, and the two must never be read as the same kind of
					evidence.
					{#if matrix.excluded.length}
						Left out because their runs never recorded {matrix.metric}: {matrix.excluded.join(', ')}.
					{/if}
				</p>
				{#each matrix.columns.filter((c) => c.caveat) as c (c.name)}
					<p class="caveat"><code>{c.name}</code> — {c.caveat}</p>
				{/each}
				{#if matrix.unmeasured.length}
					<p class="boardnote">
						Never measured on any of these datasets: {matrix.unmeasured.join(', ')}.
					</p>
				{/if}
			{:else}
				<p class="muted empty">Not enough measured datasets to compare on <code>{view.metric}</code>.</p>
			{/if}
		{:else if view.view === 'table'}
			<div class="tablewrap">
				<table class="board">
					<thead>
						<tr>
							<th class="vcol">variant</th>
							{#each view.columns as m (m)}
								<th class="num" class:star={m === view.metric} class:pinned={m === view.pairedMetric}>
									<button class="colbtn" title={metricTitle(m)} onclick={() => setQ({ metric: m })}>{m}</button>
									{#if m === view.metric}
										<span class="sub" title={`Sorted; ${mdef(m)?.higher_is_better ? 'higher' : 'lower'} is better.`}
											>north star {mdef(m)?.higher_is_better ? '▼' : '▲'}</span
										>
									{:else if m === view.pairedMetric}
										<span
											class="sub pin"
											title={`The scoring contract forbids quoting ${view.metric} without ${m}, so this column cannot be removed.`}
											>always shown</span
										>
									{/if}
								</th>
							{/each}
							<th class="num">draws</th>
							<th class="num">last measured</th>
						</tr>
					</thead>
					<tbody>
						{#each view.rows as row (rowKey(row))}
							<tr class:open={expanded.includes(row.variant)}>
								<td class="vcol">
									<button
										class="rowbtn"
										title={row.def.description ?? undefined}
										onclick={() => toggleRow(row.variant)}
									>
										<span class="caret">{expanded.includes(row.variant) ? '▾' : '▸'}</span>
										<span class="key" style={`background:${hue(row.variant)}`}></span>
										<span class="vname">{row.label}</span>
										{#if row.def.kind === 'product'}<span class="kind">shipped</span>{/if}
										{#if row.def.status === 'superseded'}<span class="kind old">superseded</span>{/if}
									</button>
								</td>
								{#each view.columns as m (m)}
									{@const stat = row.stats[m]}
									<td
										class="num"
										class:star={m === view.metric}
										class:missing={!stat}
										class:partial={stat?.partial}
										title={cellNote(row, stat, m) || undefined}
									>
										{statText(stat)}{#if stat?.partial}<span class="pflag">{stat.draws} of {row.draws}</span>{/if}
									</td>
								{/each}
								<td class="num draws">n={row.draws}</td>
								<td class="num when">{formatWhen(row.lastAt)}</td>
							</tr>
							{#if expanded.includes(row.variant)}
								<tr class="detail">
									<td colspan={view.columns.length + 3}>
										<table class="runs">
											<thead>
												<tr>
													<th>run</th>
													<th>measured</th>
													<th class="num">scored n</th>
													{#each view.columns as m (m)}<th class="num">{m}</th>{/each}
													<th>notes</th>
												</tr>
											</thead>
											<tbody>
												{#each row.runs as r (r.run_id)}
													<tr>
														<td class="mono"
															>{r.run_id}{#if r.source}&nbsp;<a href={`${base}/page/${r.source}`}>page</a>{/if}</td
														>
														<td class="mono nowrap">{formatWhen(r.run_at)}</td>
														<td class="num mono">{r.n ?? '—'}</td>
														{#each view.columns as m (m)}
															<td class="num mono"
																>{m in r.metrics ? formatValue(r.metrics[m].value, mdef(m)?.unit ?? 'ratio') : '—'}</td
															>
														{/each}
														<td class="notes">{r.notes ?? ''}</td>
													</tr>
												{/each}
											</tbody>
										</table>
									</td>
								</tr>
							{/if}
						{/each}
					</tbody>
				</table>
			</div>
			<p class="boardnote">
				One row per variant. A variant measured more than once shows the <strong>band</strong> across its draws (lowest
				to highest) and its draw count; rows rank on the median, never on a best draw. Open a row for its individual
				runs.
				{#if view.hasBlankCell}
					A dash means that arm <strong>never recorded</strong> that metric — not that it scored zero. A column no shown arm
					carries is dropped, not printed as a wall of dashes.
				{/if}
				{#if view.hasPartialCell}
					A value flagged <span class="pflag inline">k of n</span> was measured on only some of that arm's draws.
				{/if}
			</p>
		{:else}
			<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions —
			     hover and arrow keys only ENHANCE the crosshair; every value stays reachable in the table view -->
			<div
				class="chartwrap"
				bind:clientWidth={chartW}
				role="application"
				aria-label={`${view.metric} over time, one line per variant`}
				tabindex="0"
				onpointermove={onMove}
				onpointerleave={() => (activeDate = null)}
				onkeydown={onKey}
			>
				<svg width={chartW} height={H} role="img" aria-label={`${view.metric} over time, one line per variant`}>
					{#each yTicks as t (t)}
						<line class="grid" x1={M.l} x2={chartW - M.r} y1={py(t)} y2={py(t)} />
						<text class="tick" x={M.l - 8} y={py(t) + 4} text-anchor="end">{formatValue(t, chartUnit)}</text>
					{/each}
					{#each xTicks as d (d)}
						<text class="tick" x={px(d)} y={H - 8} text-anchor="middle">{fmtDay(d)}</text>
					{/each}
					{#if activeDate !== null}
						<line class="crosshair" x1={pointerX} x2={pointerX} y1={M.t} y2={H - M.b} />
					{/if}
					{#each chartSeries as s (s.variant)}
						{#if s.pts.length > 1}
							<path
								class="line"
								stroke={hue(s.variant)}
								d={s.pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${px(p.t)},${py(p.value)}`).join(' ')}
							/>
						{/if}
						{#each s.pts as p (p.runId)}
							{#if p.lo !== null && p.hi !== null}
								<line class="whisker" stroke={hue(s.variant)} x1={px(p.t)} x2={px(p.t)} y1={py(p.lo)} y2={py(p.hi)} />
							{/if}
							<circle class="dot" cx={px(p.t)} cy={py(p.value)} r="4.5" fill={hue(s.variant)} />
						{/each}
						{#if s.pts.length}
							{@const end = s.pts.at(-1)!}
							<text class="endlabel" x={px(end.t) + 9} y={py(end.value) + 4}>{formatValue(end.value, chartUnit)}</text>
						{/if}
					{/each}
				</svg>
				{#if activeDate !== null && activePoints.length}
					<div class="tooltip" style={`left:${Math.min(pointerX + 12, Math.max(0, chartW - 300))}px`}>
						<p class="tt-date">{formatWhen(new Date(activeDate).toISOString().slice(0, 19))}</p>
						{#each activePoints as p (p.runId)}
							<p class="tt-row">
								<span class="tt-key" style={`background:${hue(p.variant)}`}></span>
								<strong>{formatValue(p.value, chartUnit)}</strong>
								<span class="tt-name">{p.variant}</span>
							</p>
						{/each}
					</div>
				{/if}
			</div>
			<div class="legend">
				{#each chartSeries as s (s.variant)}
					<span class="legend-item"><span class="key" style={`background:${hue(s.variant)}`}></span>{s.variant}</span>
				{/each}
			</div>
			<p class="boardnote">
				Each dot is one run of <code>{view.metric}</code> on {view.dataset}; a line joins one variant's runs in order.
				Replicates of a frozen build sit on top of each other — the table view collapses them into a band.
			</p>
		{/if}

		<section class="about">
			<h2>About <span class="raw">{view.dataset}</span></h2>
			<p class="desc">{view.def.description ?? 'No description recorded. Add one with benchmark-set --description.'}</p>
			<dl class="glossary">
				{#each view.columns as m (m)}
					<div class="grow">
						<dt class:star={m === view.metric}>{m}</dt>
						<dd>
							{metricTitle(m)}
							{#if mdef(m) && !mdef(m)!.higher_is_better}<em>&ensp;(lower is better)</em>{/if}
						</dd>
					</div>
				{/each}
			</dl>
		</section>

		<details class="advanced">
			<summary>Advanced — filters, other datasets, saved views, SQL</summary>

			<div class="adv-block">
				<h3>Filters</h3>
				<div class="adv-row">
					<label class="field">
						<span>Rank by</span>
						<select value={view.metric} onchange={(e) => setQ({ metric: e.currentTarget.value })}>
							{#each view.metricsAvailable as m (m)}<option value={m}>{m}</option>{/each}
						</select>
					</label>
					<label class="field">
						<span>Window (back from the latest run)</span>
						<select
							value={view.since}
							onchange={(e) => setQ({ since: e.currentTarget.value === 'all' ? null : e.currentTarget.value })}
						>
							{#each SINCE_OPTIONS as s (s)}<option value={s}
									>{s === 'all' ? 'all history' : `last ${s.replace('d', ' days')}`}</option
								>{/each}
							{#if !SINCE_OPTIONS.includes(view.since)}<option value={view.since}
									>last {view.since.replace('d', ' days')}</option
								>{/if}
						</select>
					</label>
					<div class="field">
						<span>In the last</span>
						<div class="stepper">
							<input type="number" min="1" bind:value={sinceN} />
							<span class="unit">days</span>
							<button onclick={() => setQ({ since: `${Math.max(1, Math.round(sinceN))}d` })}>Apply</button>
						</div>
					</div>
				</div>
				<div class="field">
					<span
						>Variants ({view.variantFilter.length
							? `${view.rows.length} of ${view.variants.length}`
							: view.arms === 'product'
								? `${view.productCount} shipped of ${view.variants.length}`
								: 'all'}) — a chip marked
						<em>shipped</em> is a product arm (<code>variant_defs.kind</code>)</span
					>
					<div class="vchips">
						{#each view.variants as v (v)}
							{@const vd = ledger ? variantDef(ledger, v) : null}
							{@const on = view.variantFilter.length
								? view.variantFilter.some((t) => variantMatches(v, t))
								: view.arms === 'all' || vd?.kind === 'product'}
							<button
								class="vchip"
								class:off={!on}
								class:product={vd?.kind === 'product'}
								title={vd?.description ?? undefined}
								onclick={() => {
									const cur = view.variantFilter.length ? [...view.variantFilter] : view.variants.map(slugify);
									const next = cur.filter((t) => !variantMatches(v, t));
									const toggled = next.length === cur.length ? [...cur, slugify(v)] : next;
									setQ({
										variants: toggled.length && toggled.length < view.variants.length ? toggled.join(',') : null,
									});
								}}>{v}</button
							>
						{/each}
						{#if view.variantFilter.length}
							<button class="vchip clear" onclick={() => setQ({ variants: null })}>clear filter</button>
						{/if}
					</div>
				</div>
			</div>

			<div class="adv-block">
				<h3>Across datasets</h3>
				<p class="small">
					Moved out of this disclosure and onto the main path — it answers the only question that matters about a
					selection number. <a href={viewHref({ ...view.canonical, view: 'matrix' })}>Open the all-frames view</a>.
				</p>
			</div>

			<div class="adv-block">
				<h3>Archived and empty datasets</h3>
				{#if view.otherDatasets.length}
					<ul class="otherds">
						{#each view.otherDatasets as d (d.name)}
							<li>
								<button class="linkish" onclick={() => setQ({ dataset: d.name, metric: null, variants: null })}
									>{d.name}</button
								>
								<span class="small">{d.runs} run{d.runs === 1 ? '' : 's'}</span>
								{#if d.def.exposure}<span class="small">· {d.def.exposure.replace('_', ' ')}</span>{/if}
								{#if !d.def.description}<span class="small warn">· no description</span>{/if}
							</li>
						{/each}
					</ul>
				{:else}
					<p class="small">None.</p>
				{/if}
			</div>

			{#if savedViews.length}
				<div class="adv-block">
					<h3>Saved views</h3>
					<p class="small">
						Named views kept in the store (<code>algo-perf.py preset-set</code>). Each one is now just a URL.
					</p>
					<ul class="saved">
						{#each savedViews as p (p.id)}
							<li>
								<a href={presetHref(p.benchmarks, p.metric)}>{p.label}</a>
								{#if p.description}<span class="small">{p.description}</span>{/if}
							</li>
						{/each}
					</ul>
				</div>
			{/if}

			<div class="adv-block">
				<h3>Ad-hoc DuckDB</h3>
				<p class="small">
					Read-only SELECT / WITH over <code>runs</code>, <code>metrics</code>, <code>benchmark_defs</code>,
					<code>metric_defs</code>.
				</p>
				<textarea bind:value={sql} rows="4" spellcheck="false"></textarea>
				<div>
					<button onclick={() => void runSql()} disabled={sqlRunning}>{sqlRunning ? 'Running…' : 'Run query'}</button>
				</div>
				{#if sqlErr}<p class="error">{sqlErr}</p>{/if}
				{#if sqlResult}
					<div class="tablewrap">
						<table class="board">
							<thead
								><tr
									>{#each sqlResult.columns as c (c)}<th>{c}</th>{/each}</tr
								></thead
							>
							<tbody>
								{#each sqlResult.rows.slice(0, 200) as row, i (i)}
									<tr
										>{#each row as cellv, j (j)}<td class="mono">{cellv === null ? '—' : String(cellv)}</td>{/each}</tr
									>
								{/each}
							</tbody>
						</table>
					</div>
					<p class="small">{sqlResult.rows.length} rows{sqlResult.rows.length > 200 ? ' (showing 200)' : ''}</p>
				{/if}
			</div>

			<div class="adv-block">
				<h3>Record a run · annotate a dataset</h3>
				<pre>cd apps/llm-wiki
uv run --no-project --with duckdb python scripts/algo-perf.py record \
  --run-id ef-v5-fast-01 --at 2026-08-19T18:21 \
  --algo email-finder --variant "fast (7aa06eded)" --benchmark v5-heldout-good \
  --n 17 --source "experiments/.../index.html" --notes "frozen build" \
  --metric recall_strict=0.4118 --metric e2e_yield=0.4118 --metric median_latency_s=3.5

uv run --no-project --with duckdb python scripts/algo-perf.py benchmark-set \
  --benchmark v5-heldout-good --primary-metric recall_strict --n-rows 17 \
  --exposure held_out --status active --sort 10 \
  --label "creators with no address on their profile" \
  --caveat "Scored once and never shown to an arm."</pre>
				<p class="small">
					A dataset owns its metrics: the leaderboard's columns are whatever its runs carry, and
					<code>--primary-metric</code> is the north star it ranks by. <code>metric-set --pair-with</code> makes a
					publishing contract structural — <code>recall_strict</code> is pinned beside <code>e2e_yield</code> and no control
					can drop it.
				</p>
			</div>

			<div class="adv-block">
				<h3>Elsewhere</h3>
				<p class="small">
					<a href="{base}/playground/algo-perf/search-load">Search page-load &amp; navigation detail</a> ·
					<a href="{base}/page/apps/llm-wiki/algo-perf.html">the ledger write-up</a> · store
					<code>{ledger.db.split('/').slice(-3).join('/')}</code>
				</p>
			</div>
		</details>
	{/if}
</main>

<style>
	.main {
		max-width: 1180px;
		margin: 0 auto;
		padding: 28px 24px 80px;
	}
	.muted {
		color: var(--ink-muted);
	}
	.small {
		font-size: 12.5px;
		color: var(--ink-muted);
	}
	.error {
		color: #b3261e;
		font-weight: 600;
	}
	.warn {
		color: #b3261e;
	}
	.mono {
		font-family: ui-monospace, monospace;
		font-size: 11.5px;
	}
	.nowrap {
		white-space: nowrap;
	}
	.key {
		display: inline-block;
		width: 9px;
		height: 9px;
		border-radius: 2px;
		flex: none;
	}

	.tasks {
		display: flex;
		gap: 6px;
		margin: 0 0 12px;
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
	.tab.on {
		background: var(--accent);
		border-color: var(--accent);
		color: #fff;
	}
	h1 {
		margin: 0;
		font-size: 27px;
		letter-spacing: -0.01em;
	}
	h1 .ds {
		font-family: ui-monospace, monospace;
		font-size: 24px;
		color: var(--accent);
	}
	.sentence {
		margin: 5px 0 0;
		font-size: 16px;
		color: var(--ink-soft);
	}
	.meta {
		margin: 6px 0 0;
		font-size: 12.5px;
		color: var(--ink-muted);
	}
	.meta a {
		text-decoration: underline;
		text-underline-offset: 2px;
	}

	.datasets {
		display: flex;
		gap: 8px;
		flex-wrap: wrap;
		margin: 16px 0 12px;
	}
	.dchip {
		font: inherit;
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 2px;
		padding: 7px 13px;
		border-radius: 9px;
		border: 1px solid var(--border);
		background: var(--surface);
		color: var(--ink-soft);
		cursor: pointer;
		text-align: left;
	}
	.dchip:hover {
		border-color: var(--ink-muted);
	}
	.dchip.on {
		border-color: var(--accent);
		box-shadow: inset 0 0 0 1px var(--accent);
	}
	.dchip.sel {
		border-left: 3px solid #c2721b;
	}
	.dname {
		font-family: ui-monospace, monospace;
		font-size: 12.5px;
	}
	.dn {
		font-size: 11px;
		color: var(--ink-muted);
	}
	.dmark {
		font-size: 9.5px;
		letter-spacing: 0.07em;
		text-transform: uppercase;
		color: #a55c12;
	}
	.dmark.held {
		color: var(--accent);
	}

	.banner {
		margin: 0 0 6px;
		padding: 8px 13px;
		border-radius: 8px;
		font-size: 13px;
		border: 1px solid var(--border);
		background: var(--surface-alt);
		color: var(--ink-soft);
	}
	.banner.sel {
		border-color: #e6c79a;
		background: #fdf5ea;
		color: #6b4310;
	}
	.banner.held {
		border-color: #bcd8cd;
		background: var(--accent-soft);
		color: #143c33;
	}
	.banner.unknown {
		border-color: #e2c5c2;
		background: #fdf1f0;
		color: #6d2a24;
	}
	.caveat {
		margin: 0 0 4px;
		font-size: 12.5px;
		color: var(--ink-muted);
		padding-left: 13px;
		border-left: 2px solid var(--border);
	}

	.board-head {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 16px;
		margin: 20px 0 8px;
	}
	h2 {
		margin: 0;
		font-size: 14px;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		color: var(--ink-muted);
		font-weight: 600;
	}
	h2 .raw {
		text-transform: none;
		letter-spacing: 0;
		font-family: ui-monospace, monospace;
		font-size: 13px;
	}
	.seg {
		display: flex;
		border: 1px solid var(--border);
		border-radius: 7px;
		overflow: hidden;
	}
	.seg button {
		font: inherit;
		font-size: 12px;
		padding: 4px 12px;
		border: 0;
		background: var(--surface);
		color: var(--ink-muted);
		cursor: pointer;
	}
	.seg button.on {
		background: var(--accent);
		color: #fff;
	}
	.tablewrap {
		overflow-x: auto;
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
		vertical-align: bottom;
		white-space: nowrap;
	}
	table.board th.num,
	table.board td.num {
		text-align: right;
		font-variant-numeric: tabular-nums;
		/* A band is one value. Never let `90.3%–91.9%` break across two lines. */
		white-space: nowrap;
	}
	table.board th.star {
		color: var(--ink);
	}
	.colbtn {
		font: inherit;
		font-family: ui-monospace, monospace;
		font-size: 11px;
		padding: 0;
		border: 0;
		background: none;
		color: inherit;
		cursor: pointer;
		text-decoration: underline dotted;
		text-underline-offset: 3px;
	}
	th.star .colbtn {
		font-weight: 700;
	}
	.sub {
		display: block;
		font-size: 9.5px;
		letter-spacing: 0.05em;
		text-transform: uppercase;
		color: var(--ink-muted);
		font-weight: 400;
	}
	.sub.pin {
		color: #a55c12;
	}
	th.pinned {
		background: #fdf8f1;
	}
	table.board td {
		padding: 6px 9px;
		border-bottom: 1px solid var(--border-soft);
		color: var(--ink-soft);
	}
	table.board tbody tr:last-child td {
		border-bottom: 0;
	}
	table.board td.star {
		color: var(--ink);
		font-weight: 700;
		font-size: 13.5px;
	}
	td.missing {
		color: var(--ink-muted);
		opacity: 0.6;
	}
	td.draws,
	td.when {
		color: var(--ink-muted);
		font-size: 11.5px;
		white-space: nowrap;
	}
	/* The identity column stays put while a wide leaderboard scrolls sideways —
	   a number is useless once you cannot see which arm it belongs to. */
	.vcol {
		max-width: 230px;
		position: sticky;
		left: 0;
		background: var(--surface);
		z-index: 1;
	}
	tr.open .vcol {
		background: var(--surface-alt);
	}
	th.vcol {
		z-index: 2;
	}
	.rowbtn {
		font: inherit;
		display: inline-flex;
		align-items: center;
		gap: 7px;
		padding: 0;
		border: 0;
		background: none;
		color: inherit;
		cursor: pointer;
		text-align: left;
	}
	.rowbtn .vname {
		font-family: ui-monospace, monospace;
		font-size: 12px;
		line-height: 1.25;
	}
	.caret {
		color: var(--ink-muted);
		font-size: 11px;
		width: 10px;
		flex: none;
	}
	tr.open {
		background: var(--surface-alt);
	}
	tr.detail td {
		padding: 0 14px 12px 34px;
		background: var(--surface-alt);
	}
	table.runs {
		border-collapse: collapse;
		width: 100%;
		font-size: 11.5px;
	}
	table.runs th {
		text-align: left;
		padding: 4px 10px 4px 0;
		color: var(--ink-muted);
		font-weight: 500;
		border-bottom: 1px solid var(--border);
		white-space: nowrap;
	}
	table.runs th.num,
	table.runs td.num {
		text-align: right;
		font-variant-numeric: tabular-nums;
	}
	table.runs td {
		padding: 4px 10px 4px 0;
		border-bottom: 1px solid var(--border-soft);
		color: var(--ink-soft);
		vertical-align: top;
	}
	table.runs .notes {
		color: var(--ink-muted);
		min-width: 260px;
	}
	table.runs a {
		text-decoration: underline;
		text-underline-offset: 2px;
	}
	.arms {
		display: flex;
		align-items: baseline;
		gap: 12px;
		flex-wrap: wrap;
		margin: 0 2px 8px;
	}
	.arms-note {
		font-size: 12.5px;
		color: var(--ink-muted);
		max-width: 86ch;
	}
	.arms-note.warn {
		color: #6d2a24;
	}
	.arms-note strong {
		color: var(--ink);
	}
	.armbtn {
		font: inherit;
		font-size: 12px;
		padding: 3px 11px;
		border-radius: 999px;
		border: 1px solid var(--border);
		background: var(--surface);
		color: var(--accent);
		cursor: pointer;
		white-space: nowrap;
	}
	.armbtn:hover {
		border-color: var(--accent);
	}
	.kind {
		font-size: 9px;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--accent);
		border: 1px solid var(--accent-soft);
		background: var(--accent-soft);
		border-radius: 4px;
		padding: 1px 5px;
		flex: none;
	}
	.kind.old {
		color: var(--ink-muted);
		background: var(--surface-alt);
		border-color: var(--border);
	}
	/* A value measured on only some draws is NOT the same fact as a dash. */
	.pflag {
		display: inline-block;
		margin-left: 5px;
		font-size: 9.5px;
		font-weight: 500;
		color: #a55c12;
		background: #fdf5ea;
		border: 1px solid #e6c79a;
		border-radius: 4px;
		padding: 0 4px;
		vertical-align: 1px;
	}
	.pflag.inline {
		vertical-align: 0;
	}
	td.partial {
		background: #fffdf8;
	}

	table.matrix th.band {
		text-align: center;
		font-size: 10px;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		padding: 6px 9px;
		border-bottom: 2px solid var(--border);
	}
	table.matrix th.band.held_out {
		color: #143c33;
		background: var(--accent-soft);
		border-bottom-color: var(--accent);
	}
	table.matrix th.band.selection {
		color: #6b4310;
		background: #fdf5ea;
		border-bottom-color: #c2721b;
	}
	table.matrix th.band.unrecorded {
		color: #6d2a24;
		background: #fdf1f0;
		border-bottom-color: #b3261e;
	}
	table.matrix th.col-held_out,
	table.matrix td.col-held_out {
		background: color-mix(in oklab, var(--accent-soft) 30%, var(--surface));
	}
	table.matrix th.col-selection,
	table.matrix td.col-selection {
		background: color-mix(in oklab, #fdf5ea 55%, var(--surface));
	}
	table.matrix td {
		padding: 9px;
	}
	.mstar {
		display: block;
		font-size: 15px;
		font-weight: 700;
		color: var(--ink);
	}
	.mpair {
		display: block;
		font-size: 11.5px;
		color: var(--ink-soft);
	}
	.mdraws {
		display: block;
		font-size: 10px;
		color: var(--ink-muted);
	}
	.cvt {
		display: inline-block;
		margin-left: 4px;
		width: 13px;
		height: 13px;
		line-height: 13px;
		text-align: center;
		border-radius: 50%;
		background: #b3261e;
		color: #fff;
		font-size: 9.5px;
		font-weight: 700;
		cursor: help;
	}
	.missing {
		font-size: 11.5px;
		color: var(--ink-muted);
		font-style: italic;
	}
	.vchip.product {
		border-color: var(--accent);
		color: var(--accent);
	}

	.boardnote {
		margin: 8px 2px 0;
		font-size: 12px;
		color: var(--ink-muted);
		max-width: 92ch;
	}
	.empty {
		margin: 12px 0;
	}

	.chartwrap {
		position: relative;
		border: 1px solid var(--border);
		border-radius: 10px;
		background: var(--surface);
	}
	.chartwrap:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}
	svg {
		display: block;
		touch-action: none;
	}
	.grid {
		stroke: var(--border-soft);
		stroke-width: 1;
	}
	.tick {
		font-size: 10.5px;
		fill: var(--ink-muted);
	}
	.crosshair {
		stroke: var(--ink-muted);
		stroke-width: 1;
		opacity: 0.5;
	}
	.line {
		fill: none;
		stroke-width: 2;
		stroke-linejoin: round;
		stroke-linecap: round;
	}
	.whisker {
		stroke-width: 1.5;
		opacity: 0.45;
	}
	.dot {
		stroke: var(--surface);
		stroke-width: 2;
	}
	.endlabel {
		font-size: 11px;
		font-weight: 600;
		fill: var(--ink-soft);
	}
	.tooltip {
		position: absolute;
		top: 12px;
		width: 288px;
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: 8px;
		box-shadow: 0 4px 16px rgb(0 0 0 / 0.08);
		padding: 8px 12px;
		pointer-events: none;
		font-size: 12px;
	}
	.tt-date {
		margin: 0 0 4px;
		font-weight: 600;
		color: var(--ink-muted);
	}
	.tt-row {
		margin: 2px 0;
		display: flex;
		align-items: baseline;
		gap: 6px;
	}
	.tt-row strong {
		font-variant-numeric: tabular-nums;
	}
	.tt-key {
		width: 12px;
		height: 3px;
		border-radius: 2px;
		flex: none;
	}
	.tt-name {
		color: var(--ink-muted);
		font-family: ui-monospace, monospace;
		font-size: 11px;
	}
	.legend {
		display: flex;
		gap: 16px;
		flex-wrap: wrap;
		margin: 8px 2px 0;
		font-size: 11.5px;
		color: var(--ink-soft);
		font-family: ui-monospace, monospace;
	}
	.legend-item {
		display: inline-flex;
		align-items: center;
		gap: 6px;
	}

	.about {
		margin: 30px 0 0;
	}
	.desc {
		margin: 8px 0 0;
		font-size: 13px;
		color: var(--ink-soft);
		max-width: 100ch;
	}
	.glossary {
		margin: 12px 0 0;
		display: grid;
		gap: 4px;
	}
	.grow {
		display: flex;
		gap: 12px;
		align-items: baseline;
	}
	.glossary dt {
		font-family: ui-monospace, monospace;
		font-size: 11.5px;
		color: var(--ink-soft);
		min-width: 160px;
		flex: none;
	}
	.glossary dt.star {
		color: var(--ink);
		font-weight: 700;
	}
	.glossary dd {
		margin: 0;
		font-size: 12px;
		color: var(--ink-muted);
		max-width: 100ch;
	}

	.advanced {
		margin: 34px 0 0;
		border-top: 1px solid var(--border);
		padding-top: 12px;
	}
	.advanced > summary {
		cursor: pointer;
		font-size: 13px;
		color: var(--ink-muted);
	}
	.adv-block {
		margin: 22px 0 0;
	}
	.adv-block h3 {
		margin: 0 0 8px;
		font-size: 13px;
		color: var(--ink);
	}
	.adv-row {
		display: flex;
		gap: 20px;
		flex-wrap: wrap;
		align-items: flex-end;
		margin-bottom: 12px;
	}
	.field {
		display: flex;
		flex-direction: column;
		gap: 4px;
		font-size: 12px;
	}
	.field > span {
		color: var(--ink-muted);
	}
	.field select,
	.stepper input {
		font: inherit;
		font-size: 13px;
		padding: 5px 9px;
		border: 1px solid var(--border);
		border-radius: 6px;
		background: var(--surface);
		color: inherit;
	}
	.stepper {
		display: flex;
		align-items: center;
		gap: 6px;
	}
	.stepper input {
		width: 74px;
	}
	.stepper .unit {
		font-size: 12px;
		color: var(--ink-muted);
	}
	button,
	.stepper button {
		font: inherit;
	}
	.stepper button,
	.adv-block > div > button,
	textarea + div button {
		font-size: 12.5px;
		padding: 5px 12px;
		border: 1px solid var(--border);
		border-radius: 6px;
		background: var(--surface);
		color: var(--ink-soft);
		cursor: pointer;
	}
	.vchips {
		display: flex;
		gap: 6px;
		flex-wrap: wrap;
		max-width: 100%;
	}
	.vchip {
		font-family: ui-monospace, monospace;
		font-size: 11px;
		padding: 4px 9px;
		border-radius: 6px;
		border: 1px solid var(--border);
		background: var(--surface);
		color: var(--ink-soft);
		cursor: pointer;
	}
	.vchip.off {
		color: var(--ink-muted);
		opacity: 0.5;
		text-decoration: line-through;
	}
	.vchip.clear {
		font-family: inherit;
		color: var(--accent);
	}
	.otherds,
	.saved {
		margin: 0;
		padding: 0;
		list-style: none;
		display: grid;
		gap: 4px;
		font-size: 12.5px;
	}
	.otherds li,
	.saved li {
		display: flex;
		gap: 8px;
		align-items: baseline;
		flex-wrap: wrap;
	}
	.linkish {
		font-family: ui-monospace, monospace;
		font-size: 12px;
		padding: 0;
		border: 0;
		background: none;
		color: var(--accent);
		cursor: pointer;
		text-decoration: underline;
		text-underline-offset: 2px;
	}
	.saved a {
		color: var(--accent);
		text-decoration: underline;
		text-underline-offset: 2px;
	}
	textarea {
		font-family: ui-monospace, monospace;
		font-size: 12.5px;
		width: 100%;
		padding: 9px 11px;
		border: 1px solid var(--border);
		border-radius: 8px;
		background: var(--surface);
		color: inherit;
		margin-bottom: 8px;
	}
	pre {
		font-size: 11.5px;
		background: var(--surface-alt);
		border: 1px solid var(--border-soft);
		border-radius: 8px;
		padding: 10px 12px;
		overflow-x: auto;
	}
	.advanced a {
		text-decoration: underline;
		text-underline-offset: 2px;
	}

	@media (max-width: 720px) {
		.main {
			padding: 20px 14px 60px;
		}
		h1 {
			font-size: 21px;
		}
		h1 .ds {
			font-size: 18px;
		}
		.adv-row {
			gap: 12px;
		}
	}
</style>
