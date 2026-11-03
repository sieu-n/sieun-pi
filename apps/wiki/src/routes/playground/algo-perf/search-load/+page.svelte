<script lang="ts">
	import { base } from '$app/paths';
	// The apps/search page-load experiment, in detail: one suite run = every
	// core /app surface measured cold+warm (route-load.mjs) plus a rail-click
	// navigation cycle (nav-hops.mjs). This page renders the ARTIFACTS the
	// suite files under content/.wiki/search-perf/runs; the parent ledger page
	// trends the same numbers over time (presets "Search · …").
	type RouteSummary = {
		route: string;
		ssr_ms: number | null;
		shell_ms: number | null;
		first_sub_ms: number | null;
		settled_ms: number | null;
		content_states: number | null;
		subs: number | null;
		ws_kb: number | null;
		exceptions: number;
	};
	type NavSummary = {
		hops: number;
		failed: number;
		avg_commit_ms: number | null;
		avg_content_ms: number | null;
		worst_commit_ms: number | null;
	};
	type RunMeta = {
		run_id: string;
		at: string;
		label: string;
		git: { sha: string; branch: string };
		base: string;
		summary: { routes: RouteSummary[]; nav: NavSummary };
	};
	type RoutePass = {
		route: string;
		consoleErrors: string[];
		ssr: { ms: number; ssrMainChars: number; timing: string | null };
		shellAt: number | null;
		settledAt: number | null;
		contentStates: number;
		convex: { subs: number; rxBytes: number; firstSubAt: number | null; byUdf: { udf: string; bytes: number }[] };
	};
	type NavPair = {
		pair: string;
		samples: number;
		failed: number;
		via: string;
		avg_commit_ms: number | null;
		avg_content_ms: number | null;
	};
	type Artifact = RunMeta & {
		routes: { route: string; cold: RoutePass | null; warm: RoutePass | null }[];
		nav: { pairs: NavPair[]; summary: NavSummary };
	};

	let index: RunMeta[] = $state([]);
	let loadErr = $state('');
	let selectedId: string | null = $state(null);
	let compareId: string | null = $state(null); // '' = none
	let compareTouched = $state(false);
	let current: Artifact | null = $state(null);
	let compare: Artifact | null = $state(null);

	async function loadIndex() {
		try {
			const r = await fetch(`${base}/api/playground/search-perf`);
			if (!r.ok) throw new Error((await r.json().catch(() => null))?.message ?? `HTTP ${r.status}`);
			index = ((await r.json()) as { runs: RunMeta[] }).runs;
			if (index.length && !selectedId) selectedId = index[index.length - 1].run_id;
		} catch (e) {
			loadErr = e instanceof Error ? e.message : String(e);
		}
	}
	$effect(() => {
		if (!index.length && !loadErr) void loadIndex();
	});
	// Default comparison: the run right before the selected one (until touched).
	$effect(() => {
		if (compareTouched || !selectedId) return;
		const i = index.findIndex((r) => r.run_id === selectedId);
		compareId = i > 0 ? index[i - 1].run_id : '';
	});
	async function fetchArtifact(id: string): Promise<Artifact | null> {
		const r = await fetch(`${base}/api/playground/search-perf?run=${encodeURIComponent(id)}`);
		return r.ok ? ((await r.json()) as Artifact) : null;
	}
	$effect(() => {
		const id = selectedId;
		if (!id) return;
		void fetchArtifact(id).then((a) => {
			if (selectedId === id) current = a;
		});
	});
	$effect(() => {
		const id = compareId;
		if (!id) {
			compare = null;
			return;
		}
		void fetchArtifact(id).then((a) => {
			if (compareId === id) compare = a;
		});
	});

	const fmtMs = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `${Math.round(v)} ms`);
	const fmtKb = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `${v.toFixed(1)} KB`);
	// Delta chip: negative = faster/lighter = good (every suite metric is lower-is-better).
	function delta(cur: number | null | undefined, prev: number | null | undefined): { txt: string; cls: string } | null {
		if (cur === null || cur === undefined || prev === null || prev === undefined) return null;
		const d = cur - prev;
		if (Math.abs(d) < 0.05) return null;
		const pct = prev !== 0 ? ` (${d > 0 ? '+' : ''}${Math.round((d / prev) * 100)}%)` : '';
		return { txt: `${d > 0 ? '+' : '−'}${Math.abs(Math.round(d * 10) / 10)}${pct}`, cls: d > 0 ? 'worse' : 'better' };
	}
	const compRoute = (route: string): RouteSummary | null =>
		compare?.summary.routes.find((r) => r.route === route) ?? null;

	// Aggregates for the KPI tiles.
	const avg = (xs: (number | null)[]) => {
		const v = xs.filter((x): x is number => x !== null);
		return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
	};
	// $derived.by closures on purpose — top-level CFA narrows the $state's
	// initial null into the derived (`never`); a closure resets the narrowing
	// (same note as the parent ledger page).
	const curRoutes = $derived.by(() => current?.summary.routes ?? []);
	const kpi = $derived.by(() => ({
		settled: avg(curRoutes.map((r) => r.settled_ms)),
		ws: curRoutes.reduce((a, r) => a + (r.ws_kb ?? 0), 0),
		commit: current?.summary.nav.avg_commit_ms ?? null,
		worst: current?.summary.nav.worst_commit_ms ?? null,
	}));
	const cmpRoutes = $derived.by(() => compare?.summary.routes ?? []);
	const kpiPrev = $derived.by(() => ({
		settled: avg(cmpRoutes.map((r) => r.settled_ms)),
		ws: cmpRoutes.length ? cmpRoutes.reduce((a, r) => a + (r.ws_kb ?? 0), 0) : null,
		commit: compare?.summary.nav.avg_commit_ms ?? null,
		worst: compare?.summary.nav.worst_commit_ms ?? null,
	}));

	// Load-phase bar geometry: shell → first sub → settled are cumulative
	// moments on one timeline; the bar is that timeline, scaled to the slowest
	// settle in the run so routes compare at a glance.
	const barMax = $derived.by(() => Math.max(1, ...curRoutes.map((r) => r.settled_ms ?? 0)));
	const pct = (v: number | null) => (v === null ? 0 : (v / barMax) * 100);

	// Wire detail: per-route top subscriptions with byte deltas vs comparison.
	function topSubs(route: string): { udf: string; bytes: number; prev: number | null }[] {
		const warm = current?.routes.find((r) => r.route === route)?.warm;
		if (!warm) return [];
		const prevByUdf = new Map(
			(compare?.routes.find((r) => r.route === route)?.warm?.convex.byUdf ?? []).map((u) => [u.udf, u.bytes]),
		);
		return warm.convex.byUdf
			.slice(0, 6)
			.map((u) => ({ udf: u.udf, bytes: u.bytes, prev: prevByUdf.get(u.udf) ?? null }));
	}
	function warmExceptions(route: string): string[] {
		const warm = current?.routes.find((r) => r.route === route)?.warm;
		return (warm?.consoleErrors ?? []).filter((e) => e.startsWith('EXCEPTION:'));
	}

	// Trends over every suite run in the index (per-route settled + weight, nav commit).
	const trendRoutes = $derived([...new Set(index.flatMap((r) => r.summary.routes.map((s) => s.route)))]);
	function trend(route: string, key: 'settled_ms' | 'ws_kb'): { at: string; label: string; v: number }[] {
		return index
			.map((r) => ({ at: r.at, label: r.label, v: r.summary.routes.find((s) => s.route === route)?.[key] ?? null }))
			.filter((p): p is { at: string; label: string; v: number } => p.v !== null);
	}
	const navTrend = $derived.by(() =>
		index
			.map((r) => ({ at: r.at, label: r.label, v: r.summary.nav.avg_commit_ms }))
			.filter((p): p is { at: string; label: string; v: number } => p.v !== null),
	);
	// Tiny sparkline path for a trend series (fixed 150×36 box).
	function spark(pts: { v: number }[]): string {
		if (pts.length < 2) return '';
		const max = Math.max(...pts.map((p) => p.v));
		const min = Math.min(...pts.map((p) => p.v));
		const span = Math.max(1e-6, max - min);
		return pts
			.map((p, i) => `${i === 0 ? 'M' : 'L'}${(i / (pts.length - 1)) * 146 + 2},${32 - ((p.v - min) / span) * 28 + 2}`)
			.join(' ');
	}
	const fmtWhen = (at: string) =>
		new Date(at).toLocaleString('en-US', {
			month: 'short',
			day: 'numeric',
			hour: '2-digit',
			minute: '2-digit',
			hour12: false,
		});

	const REPLAY = `# from the repo root — throwaway search dev server, NEVER the owner's :5174
cd apps/search && npx dotenvx run -q -f .env.local -- npx vite dev --port 5189 --strictPort &
cd ../.. && sleep 12

node scripts/repo/agent/browser-harness.mjs run -- \\
  node apps/search/scripts/perf/perf-suite.mjs \\
    --base http://localhost:5189 --label "what-changed"

lsof -ti tcp:5189 | xargs kill`;
</script>

<svelte:head><title>Search page-load · algo-perf · llm-wiki</title></svelte:head>

<main class="main">
	<header class="head">
		<p class="eyebrow"><a href="{base}/playground/algo-perf">algo-perf</a> · experiment · apps/search</p>
		<h1>Search page-load &amp; navigation</h1>
		<p class="muted">
			Every core <code>/app</code> surface of virev.ai, measured as a signed-in user: cold + warm route load (SSR, shell
			paint, first Convex subscription, content settle, bytes per subscription) and a rail-click navigation cycle
			(URL-commit and content time per hop). One command reproduces the whole experiment — see <em>Reproduce</em> at the
			foot. Trends live on the
			<a href="{base}/playground/algo-perf">ledger dashboard</a> under the <strong>Search ·</strong> presets; the page-load rules live in
			<code>.claude/rules/search-pages.md</code>.
		</p>
	</header>

	{#if loadErr}
		<p class="error">{loadErr}</p>
	{:else if !index.length}
		<section class="empty">
			<p class="muted">No suite runs recorded on this machine yet. Run the suite once:</p>
			<pre>{REPLAY}</pre>
		</section>
	{:else}
		<section class="picker">
			<label class="field">
				<span>Run</span>
				<select bind:value={selectedId}>
					{#each [...index].reverse() as r (r.run_id)}
						<option value={r.run_id}>{fmtWhen(r.at)} · {r.label} · {r.git.sha}</option>
					{/each}
				</select>
			</label>
			<label class="field">
				<span>Compare against</span>
				<select bind:value={compareId} onchange={() => (compareTouched = true)}>
					<option value="">— none —</option>
					{#each [...index].reverse() as r (r.run_id)}
						{#if r.run_id !== selectedId}<option value={r.run_id}>{fmtWhen(r.at)} · {r.label}</option>{/if}
					{/each}
				</select>
			</label>
			{#if current}
				<span class="hint">
					{current.git.branch}@{current.git.sha} · {current.base}
					{#if compare}&ensp;vs&ensp;{compare.label} ({fmtWhen(compare.at)}){/if}
				</span>
			{/if}
		</section>

		<section class="kpis">
			{#each [{ label: 'avg settled (warm)', v: fmtMs(kpi.settled), d: delta(kpi.settled, kpiPrev.settled) }, { label: 'payload, all surfaces', v: fmtKb(kpi.ws), d: delta(kpi.ws, kpiPrev.ws) }, { label: 'avg hop → URL commit', v: fmtMs(kpi.commit), d: delta(kpi.commit, kpiPrev.commit) }, { label: 'worst hop', v: fmtMs(kpi.worst), d: delta(kpi.worst, kpiPrev.worst) }] as t (t.label)}
				<article class="tile">
					<p class="tile-label">{t.label}</p>
					<p class="tile-value">{t.v}</p>
					{#if t.d}<p class="tile-sub {t.d.cls}">{t.d.txt} vs comparison</p>{/if}
				</article>
			{/each}
		</section>

		<h2>Surfaces — warm pass</h2>
		<p class="small">
			One bar per route on a shared timeline (scaled to the slowest settle):
			<span class="lg p-shell"></span> shell painted → <span class="lg p-sub"></span> first subscription →
			<span class="lg p-settle"></span> content settled. Deltas compare against the selected comparison run.
		</p>
		<div class="routes">
			{#each curRoutes as r (r.route)}
				{@const prev = compRoute(r.route)}
				{@const exc = warmExceptions(r.route)}
				<article class="route">
					<div class="route-head">
						<span class="route-name mono">{r.route}</span>
						<span class="route-nums mono">
							settled {fmtMs(r.settled_ms)}
							{#if delta(r.settled_ms, prev?.settled_ms)}{@const d = delta(r.settled_ms, prev?.settled_ms)}<span
									class="chip {d?.cls}">{d?.txt}</span
								>{/if}
							· {fmtKb(r.ws_kb)}
							{#if delta(r.ws_kb, prev?.ws_kb)}{@const d = delta(r.ws_kb, prev?.ws_kb)}<span class="chip {d?.cls}"
									>{d?.txt}</span
								>{/if}
							· {r.subs ?? '—'} subs · {r.content_states ?? '—'} states
						</span>
					</div>
					<div
						class="bar"
						role="img"
						aria-label={`${r.route}: shell ${fmtMs(r.shell_ms)}, first sub ${fmtMs(r.first_sub_ms)}, settled ${fmtMs(r.settled_ms)}`}
					>
						<div class="seg p-settle" style={`width:${pct(r.settled_ms)}%`}></div>
						<div class="seg p-sub" style={`width:${pct(r.first_sub_ms)}%`}></div>
						<div class="seg p-shell" style={`width:${pct(r.shell_ms)}%`}></div>
					</div>
					{#if exc.length}
						<p class="error small">
							⚠ {exc.length} page exception(s) — a crashed surface settles fast and lies; fix before trusting:
							<code>{exc[0].slice(0, 120)}</code>
						</p>
					{/if}
					<details>
						<summary class="small">wire — top subscriptions ({fmtKb(r.ws_kb)} total)</summary>
						<table class="subs">
							<tbody>
								{#each topSubs(r.route) as srow (srow.udf)}
									<tr>
										<td class="mono">{srow.udf}</td>
										<td class="mono num">{(srow.bytes / 1024).toFixed(1)} KB</td>
										<td class="num">
											{#if srow.prev !== null && delta(srow.bytes / 1024, srow.prev / 1024)}{@const d = delta(
													srow.bytes / 1024,
													srow.prev / 1024,
												)}<span class="chip {d?.cls}">{d?.txt} KB</span>{/if}
										</td>
									</tr>
								{/each}
							</tbody>
						</table>
					</details>
				</article>
			{/each}
		</div>

		<h2>Switching between apps — rail-click hops</h2>
		{#if current?.nav}
			<p class="small">
				{current.nav.summary.hops} hops{current.nav.summary.failed ? ` (${current.nav.summary.failed} failed)` : ''} · avg
				URL-commit <strong>{fmtMs(current.nav.summary.avg_commit_ms)}</strong> · avg content
				<strong>{fmtMs(current.nav.summary.avg_content_ms)}</strong> · worst commit
				<strong>{fmtMs(current.nav.summary.worst_commit_ms)}</strong>. SvelteKit holds the URL until the target's loads
				resolve — a slow commit is a frozen address bar.
			</p>
			<div class="tablewrap">
				<table class="runs">
					<thead
						><tr><th>hop</th><th>n</th><th>avg commit</th><th>avg content</th><th>vs comparison</th><th>via</th></tr
						></thead
					>
					<tbody>
						{#each current.nav.pairs as pr (pr.pair)}
							{@const prevPair = compare?.nav.pairs.find((x) => x.pair === pr.pair)}
							<tr>
								<td class="mono">{pr.pair}</td>
								<td class="mono">{pr.samples - pr.failed}</td>
								<td class="mono">{fmtMs(pr.avg_commit_ms)}</td>
								<td class="mono">{fmtMs(pr.avg_content_ms)}</td>
								<td>
									{#if prevPair && delta(pr.avg_commit_ms, prevPair.avg_commit_ms)}{@const d = delta(
											pr.avg_commit_ms,
											prevPair.avg_commit_ms,
										)}<span class="chip {d?.cls}">{d?.txt}</span>{/if}
								</td>
								<td class="small">{pr.via}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}

		{#if index.length >= 2}
			<h2>Trend across suite runs</h2>
			<div class="sparks">
				{#each trendRoutes as route (route)}
					{@const s = trend(route, 'settled_ms')}
					{@const w = trend(route, 'ws_kb')}
					<article class="spark">
						<p class="mono small">{route}</p>
						{#if s.length >= 2}
							<svg width="150" height="36"><path d={spark(s)} class="line settleLine" /></svg>
							<p class="small dim">
								settled {Math.round(s[0].v)} → <strong>{Math.round(s[s.length - 1].v)} ms</strong>
							</p>
						{/if}
						{#if w.length >= 2}
							<p class="small dim">weight {w[0].v.toFixed(0)} → <strong>{w[w.length - 1].v.toFixed(0)} KB</strong></p>
						{/if}
					</article>
				{/each}
				{#if navTrend.length >= 2}
					<article class="spark">
						<p class="mono small">rail-cycle · avg commit</p>
						<svg width="150" height="36"><path d={spark(navTrend)} class="line navLine" /></svg>
						<p class="small dim">
							{Math.round(navTrend[0].v)} → <strong>{Math.round(navTrend[navTrend.length - 1].v)} ms</strong>
						</p>
					</article>
				{/if}
			</div>
			<p class="small">
				Full history with variants and CIs: <a href="{base}/playground/algo-perf">the ledger dashboard</a> ("Search ·"
				presets), or ad-hoc SQL there over <code>runs</code>/<code>metrics</code> with
				<code>algo IN ('search-page-load','search-nav')</code>.
			</p>
		{/if}
	{/if}

	<details class="record" open={!index.length}>
		<summary>Reproduce (one command per run)</summary>
		<pre>{REPLAY}</pre>
		<p class="small">
			The suite is <code>apps/search/scripts/perf/perf-suite.mjs</code>: it runs the committed
			<code>route-load.mjs</code> harness (each route twice — the warm pass is the honest dev number), then
			<code>nav-hops.mjs</code> (real rail clicks), writes the artifact this page reads into
			<code>apps/llm-wiki/content/.wiki/search-perf/runs/</code>, and records summary metrics into the algo-perf ledger
			(<code>--label</code> becomes the variant). <code>--no-record</code> measures without touching the ledger. Dev numbers
			include Vite; compare runs on the SAME machine and rig, and only warm passes.
		</p>
	</details>
</main>

<style>
	.main {
		max-width: 1150px;
		margin: 0 auto;
		padding: 32px 24px 80px;
	}
	.eyebrow {
		font-size: 12px;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		opacity: 0.6;
		margin: 0 0 4px;
	}
	.head h1 {
		margin: 0 0 6px;
	}
	.muted {
		opacity: 0.75;
		max-width: 90ch;
	}
	.small {
		font-size: 12.5px;
		opacity: 0.8;
	}
	.dim {
		opacity: 0.6;
	}
	.error {
		color: #b3261e;
		font-weight: 600;
	}
	.mono {
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		font-size: 12.5px;
	}
	.picker {
		display: flex;
		gap: 16px;
		align-items: flex-end;
		flex-wrap: wrap;
		margin: 18px 0 14px;
	}
	.field {
		display: flex;
		flex-direction: column;
		gap: 4px;
		font-size: 12px;
	}
	.field span {
		opacity: 0.65;
	}
	select {
		font: inherit;
		font-size: 13px;
		padding: 6px 8px;
		border: 1px solid var(--border);
		border-radius: 8px;
		background: var(--surface);
		color: inherit;
	}
	.hint {
		font-size: 12px;
		opacity: 0.65;
		padding-bottom: 8px;
	}
	.kpis {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
		gap: 10px;
		margin: 8px 0 20px;
	}
	.tile {
		border: 1px solid var(--border);
		border-radius: 10px;
		padding: 10px 14px;
		background: var(--surface);
	}
	.tile-label {
		margin: 0;
		font-size: 11.5px;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		opacity: 0.6;
	}
	.tile-value {
		margin: 2px 0 0;
		font-size: 22px;
		font-weight: 650;
		font-variant-numeric: tabular-nums;
	}
	.tile-sub {
		margin: 2px 0 0;
		font-size: 12px;
	}
	.better {
		color: #0a7a4b;
	}
	.worse {
		color: #b3261e;
	}
	.chip {
		display: inline-block;
		font-size: 11px;
		font-weight: 600;
		padding: 0 6px;
		border-radius: 999px;
		background: color-mix(in srgb, currentColor 12%, transparent);
		margin-left: 4px;
	}
	.lg {
		display: inline-block;
		width: 10px;
		height: 10px;
		border-radius: 2px;
		vertical-align: -1px;
	}
	/* p- prefix: the wiki app.css owns a GLOBAL .shell (min-height:100vh) */
	.lg.p-shell,
	.seg.p-shell {
		background: #2a78d6;
	}
	.lg.p-sub,
	.seg.p-sub {
		background: #eda100;
	}
	.lg.p-settle,
	.seg.p-settle {
		background: #d7dbe0;
	}
	.routes {
		display: flex;
		flex-direction: column;
		gap: 14px;
		margin: 10px 0 26px;
	}
	.route {
		border: 1px solid var(--border);
		border-radius: 10px;
		padding: 10px 14px;
		background: var(--surface);
	}
	.route-head {
		display: flex;
		justify-content: space-between;
		gap: 12px;
		flex-wrap: wrap;
		margin-bottom: 6px;
	}
	.route-name {
		font-weight: 650;
	}
	.bar {
		position: relative;
		height: 14px;
		border-radius: 4px;
		background: color-mix(in srgb, var(--border) 40%, transparent);
		overflow: hidden;
	}
	.seg {
		position: absolute;
		inset: 0 auto 0 0;
		border-radius: 4px 0 0 4px;
	}
	.subs {
		border-collapse: collapse;
		margin-top: 6px;
	}
	.subs td {
		padding: 2px 14px 2px 0;
		border-bottom: 1px dashed color-mix(in srgb, var(--border) 60%, transparent);
	}
	.num {
		text-align: right;
	}
	.tablewrap {
		overflow-x: auto;
		margin: 8px 0 22px;
	}
	.runs {
		border-collapse: collapse;
		font-size: 13px;
		min-width: 640px;
	}
	.runs th {
		text-align: left;
		font-size: 11.5px;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		opacity: 0.6;
		padding: 4px 16px 4px 0;
	}
	.runs td {
		padding: 4px 16px 4px 0;
		border-top: 1px solid color-mix(in srgb, var(--border) 60%, transparent);
	}
	.sparks {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
		gap: 10px;
		margin: 10px 0 6px;
	}
	.spark {
		border: 1px solid var(--border);
		border-radius: 10px;
		padding: 8px 12px;
		background: var(--surface);
	}
	.spark p {
		margin: 0 0 2px;
	}
	.line {
		fill: none;
		stroke-width: 2;
	}
	.settleLine {
		stroke: #2a78d6;
	}
	.navLine {
		stroke: #1baf7a;
	}
	.empty pre,
	.record pre {
		background: color-mix(in srgb, var(--border) 25%, transparent);
		border-radius: 8px;
		padding: 12px 14px;
		font-size: 12.5px;
		overflow-x: auto;
	}
	.record {
		margin-top: 28px;
	}
	.record summary {
		cursor: pointer;
		font-weight: 600;
	}
	h2 {
		margin: 26px 0 6px;
	}
</style>
