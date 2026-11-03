<script lang="ts">
	import { base } from '$app/paths';
	// Auto-discovers every playground with `import.meta.glob` (compile-time, keys only), single level on purpose so a
	// playground's sub-pages do not list. META is optional; a META key with no route renders a stale warning.
	const discovered = Object.keys(import.meta.glob('./*/+page.svelte'))
		.map((file) => file.replace(/^\.\//, '').replace(/\/\+page\.svelte$/, ''))
		.sort();

	// `availability` is what a row needs at RUNTIME — not what it costs.
	type Availability = 'dev/WIKI_EDITABLE gated' | 'read-only, open on the served wiki';
	type Meta = { title: string; description: string; exercises: string; availability: Availability; cost?: string };

	const META: Record<string, Meta> = {
		runs: {
			title: 'Run history',
			description:
				"Every recorded run of every component (email finder, visual enrichment, algo-perf and more) in one table: pick a component and a metric for its trend over time with the CI band, read each run's commit, model, dataset and config hash, and tick two runs to diff their config and metrics.",
			exercises:
				'content/experiments/runs/<component>/<run_id>.json · scripts/run_history.py · content/.wiki/run-history.duckdb',
			availability: 'read-only, open on the served wiki',
		},
		ci: {
			title: 'CI',
			description:
				"The CI system duty's four numbers against target (jobs waiting over 10 min now, push to verify-dev verdict, verify-dev run time, land to staging), measured on load with scripts/duties/ci/ci-system.mjs, then the CI monitor's queue, wait, busy, run time and land charts and its anomaly list. Refreshes every 5 min.",
			exercises: 'ci-monitor dashboard/charts.json · store.json · snapshot.md · ~/.cache/virev/ci-runs.json',
			availability: 'dev/WIKI_EDITABLE gated',
		},
		'algo-perf': {
			title: 'Algo performance',
			description:
				'Time-series ledger of algorithm benchmark runs (email-finder + search page-load) over a local DuckDB store — every run dated, sourced to its wiki page, charted per benchmark frame with CIs, plus read-only SQL. The search-load sub-page details each perf-suite run (load-phase bars, per-subscription bytes, rail-hop times).',
			exercises: 'content/.wiki/algo-perf.duckdb · scripts/algo-perf.py · perf-suite.mjs',
			availability: 'dev/WIKI_EDITABLE gated',
		},
		'email-finder-analytics': {
			title: 'Email finder analytics',
			description:
				'Every benchmark run and its fetched-page source check loaded into DuckDB (email_facts / profile_facts) — slice a metric by sub-category or run read-only SQL.',
			exercises: 'content/experiments/email-finder · DuckDB',
			availability: 'dev/WIKI_EDITABLE gated',
		},
		'visual-enrichment': {
			title: 'Visual enrichment',
			description:
				'Renders the IG-style profile composite for a crawled profile and vision-classifies it — model picker, tile count, header and badge toggles.',
			exercises: 'crawler-v3 visual enrichment · CLIProxy vision',
			availability: 'dev/WIKI_EDITABLE gated',
			cost: 'paid vision call per run',
		},
	};

	function metaFor(slug: string): Meta | undefined {
		return META[slug];
	}

	const entries = [
		...Object.keys(META).filter((slug) => discovered.includes(slug)),
		...discovered.filter((slug) => !(slug in META)),
	];
	const staleMeta = Object.keys(META).filter((slug) => !discovered.includes(slug));

	type External = { name: string; url: string; note?: string; description: string };

	const EXTERNAL: External[] = [
		{
			name: 'Search dev harnesses',
			url: 'http://localhost:5174/dev',
			description:
				'apps/search — auto-discovered index of mocks and design-playground micro-probes, including the /dev/design component galleries.',
		},
		{
			name: 'API live-demo console',
			url: 'http://localhost:5175/docs',
			description:
				'api-portal public docs — interactive console running real calls for one fixed account; editing gates to sign-up.',
		},
		{
			name: 'Portal API reference (Scalar)',
			url: 'http://localhost:5175/dashboard/docs',
			note: 'sign-in to run',
			description: 'Scalar click-to-work reference over the commercial /v1 surface with dev-key prefill.',
		},
		{
			name: 'Raw Instagram doc-id playground',
			url: 'http://localhost:5175/admin/instagram',
			note: 'sign-in required',
			description: 'api-portal admin console probing the raw IG wire through the crawler live surface.',
		},
		{
			name: 'Crawler API console (Scalar)',
			url: 'http://localhost:8787/scalar',
			description: 'crawler-v3 — Scalar console over the whole crawler API surface (Swagger /docs is disabled).',
		},
	];
</script>

<svelte:head><title>Playground · llm-wiki</title></svelte:head>

<div class="playground">
	<h1>Playground</h1>
	<p class="lede">
		Internal consoles for poking the live stack. The consoles that write or call paid services are gated to local dev (<code
			>WIKI_EDITABLE=true</code
		>), and the read-only run history is open. None of them are built for outside readers.
	</p>

	{#if staleMeta.length > 0}
		<div class="stale">
			<strong>Stale metadata:</strong>
			curated entr{staleMeta.length === 1 ? 'y' : 'ies'} for <code>{staleMeta.join(', ')}</code>
			no longer resolve{staleMeta.length === 1 ? 's' : ''} to a route — remove from META in
			<code>routes/playground/+page.svelte</code>.
		</div>
	{/if}

	<h2>In this wiki</h2>
	<ul class="list">
		{#each entries as slug (slug)}
			{@const meta = metaFor(slug)}
			<li>
				<div class="row-head">
					<!-- plain href: resolve() is typed to the literal union of known routes, so an
					     auto-discovered slug (a runtime string) cannot type-check against it. -->
					<a class="name" href="{base}/playground/{slug}">{meta?.title ?? slug}</a>
					<span class="badge">{meta?.availability ?? 'availability not documented'}</span>
					{#if meta?.cost}<span class="badge cost">{meta.cost}</span>{/if}
				</div>
				<p class="desc">
					{meta?.description ?? 'No curated description yet — add this slug to META in routes/playground/+page.svelte.'}
				</p>
				{#if meta?.exercises}
					<p class="meta-line">exercises <code>{meta.exercises}</code></p>
				{/if}
			</li>
		{/each}
	</ul>

	<h2>Elsewhere in the stack</h2>
	<ul class="list">
		{#each EXTERNAL as ext (ext.url)}
			<li>
				<div class="row-head">
					<a class="name" href={ext.url} target="_blank" rel="noreferrer">{ext.name}</a>
					<code class="url">{ext.url.replace(/^http:\/\//, '')}</code>
					{#if ext.note}<span class="badge">{ext.note}</span>{/if}
				</div>
				<p class="desc">{ext.description}</p>
			</li>
		{/each}
	</ul>
</div>

<style>
	.playground {
		max-width: 72rem;
	}
	.lede {
		color: var(--ink-muted);
		margin: 0.35rem 0 1.5rem;
		max-width: 48rem;
	}
	h2 {
		margin: 2.25rem 0 0.4rem;
	}
	.stale {
		border: 1px solid #fcd34d;
		background: #fffbeb;
		color: #92400e;
		border-radius: 8px;
		padding: 0.55rem 0.8rem;
		font-size: 0.82rem;
		margin-bottom: 1rem;
	}
	.list {
		list-style: none;
		margin: 0;
		padding: 0;
	}
	.list li {
		padding: 0.85rem 0;
		border-bottom: 1px solid var(--border-soft);
	}
	.list li:last-child {
		border-bottom: none;
	}
	.row-head {
		display: flex;
		align-items: baseline;
		gap: 0.6rem;
		flex-wrap: wrap;
	}
	.name {
		font-weight: 600;
		font-size: 0.95rem;
		color: var(--accent);
	}
	.name:hover {
		text-decoration: underline;
	}
	.badge {
		font-size: 0.72rem;
		line-height: 1;
		padding: 0.22rem 0.5rem;
		border-radius: 999px;
		color: var(--ink-muted);
		background: var(--surface-alt);
		border: 1px solid var(--border);
		white-space: nowrap;
	}
	.badge.cost {
		color: #92400e;
		background: #fef3c7;
		border-color: #fde68a;
	}
	.desc {
		margin: 0.3rem 0 0;
		color: var(--ink-soft);
		font-size: 0.88rem;
		max-width: 48rem;
	}
	.meta-line {
		margin: 0.3rem 0 0;
		font-size: 0.78rem;
		color: var(--ink-muted);
	}
	.url {
		font-size: 0.78rem;
		color: var(--ink-muted);
	}
</style>
