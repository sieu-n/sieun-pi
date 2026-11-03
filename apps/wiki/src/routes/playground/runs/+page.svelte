<script lang="ts">
	import { base } from '$app/paths';
	import { browser } from '$app/environment';
	import { replaceState } from '$app/navigation';
	import { page } from '$app/state';
	import RunHistory from '$lib/components/RunHistory.svelte';
	import { componentCounts, fetchRuns, formatUtc, type Run } from '$lib/run-history';

	let runs = $state.raw<Run[] | null>(null);
	let loadErr = $state('');
	let component = $state(page.url.searchParams.get('component'));
	let metric = $state(page.url.searchParams.get('metric'));

	$effect(() => {
		fetchRuns().then(
			(r) => (runs = r),
			(e: unknown) => (loadErr = e instanceof Error ? e.message : String(e)),
		);
	});

	const counts = $derived(runs ? componentCounts(runs) : []);
	const shown = $derived(component ?? counts[0]?.component ?? null);
	const picker = $derived(
		shown && !counts.some((c) => c.component === shown) ? [...counts, { component: shown, runs: 0 }] : counts,
	);
	const componentRuns = $derived(runs && shown ? runs.filter((r) => r.component === shown) : []);
	const last = $derived(componentRuns.at(-1)?.started_at ?? null);

	// The query string is the view, written with replaceState so nothing reloads.
	$effect(() => {
		if (!browser || !runs) return;
		const url = new URL(location.href);
		for (const [k, v] of [
			['component', shown],
			['metric', metric],
		] as const) {
			if (v) url.searchParams.set(k, v);
			else url.searchParams.delete(k);
		}
		if (url.href !== location.href) replaceState(url, page.state);
	});
</script>

<svelte:head><title>{shown ? `${shown} runs` : 'Runs'} · Playground · llm-wiki</title></svelte:head>

<main class="main">
	<p class="crumb"><a href="{base}/playground">Playground</a> / Runs</p>
	<h1>Run history</h1>
	<p class="lede">
		Every recorded run of every component, from one JSON file per run under
		<code>content/experiments/runs/&lt;component&gt;/</code>. Pick a component and a metric, then tick two runs to see
		what changed between them.
	</p>

	{#if loadErr}
		<p class="error">{loadErr}</p>
	{:else if !runs}
		<p class="muted">Loading runs…</p>
	{:else if !picker.length}
		<p class="empty">
			No component has recorded a run yet. A run shows up here once its script or route calls <code>record_run</code> in
			<code>scripts/run_history.py</code>.
		</p>
	{:else}
		<nav class="components" aria-label="Component">
			{#each picker as c (c.component)}
				<button
					class="dchip"
					class:on={c.component === shown}
					onclick={() => {
						component = c.component;
						metric = null;
					}}
				>
					<span class="dname">{c.component}</span>
					<span class="dmeta">{c.runs} run{c.runs === 1 ? '' : 's'}</span>
				</button>
			{/each}
		</nav>
		{#if shown}
			<p class="meta">
				{componentRuns.length} run{componentRuns.length === 1 ? '' : 's'}
				{#if last}· last started {formatUtc(last)}{/if}
				· <a href="{base}/api/playground/runs?component={shown}">JSON</a>
			</p>
			<RunHistory component={shown} runs={componentRuns} bind:metric />
		{/if}
	{/if}
</main>

<style>
	.main {
		max-width: 1180px;
		margin: 0 auto;
		padding: 28px 24px 80px;
	}
	.crumb {
		margin: 0 0 6px;
		font-size: 0.8rem;
		color: var(--ink-muted);
	}
	.crumb a,
	.meta a {
		color: var(--accent);
	}
	h1 {
		margin: 0;
		font-size: 27px;
		letter-spacing: -0.01em;
	}
	.lede {
		margin: 6px 0 0;
		color: var(--ink-muted);
		max-width: 72ch;
	}
	.components {
		display: flex;
		gap: 8px;
		flex-wrap: wrap;
		margin: 18px 0 8px;
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
	.dchip.on {
		border-color: var(--accent);
		box-shadow: inset 0 0 0 1px var(--accent);
	}
	.dname {
		font-family: ui-monospace, monospace;
		font-size: 12.5px;
	}
	.dmeta {
		font-size: 11px;
		color: var(--ink-muted);
	}
	.meta {
		margin: 4px 0 14px;
		font-size: 12.5px;
		color: var(--ink-muted);
	}
	.muted {
		color: var(--ink-muted);
	}
	.error {
		color: #b3261e;
		font-weight: 600;
	}
	.empty {
		font-size: 13.5px;
		color: var(--ink-muted);
		padding: 18px;
		border: 1px dashed var(--border);
		border-radius: 10px;
		background: var(--surface);
	}
</style>
