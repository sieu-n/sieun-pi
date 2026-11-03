<script lang="ts">
	import { base } from '$app/paths';
	let { data } = $props();
	const report = $derived(data.report);

	const groups = $derived([
		{ key: 'brokenLinks', label: 'Broken links', tone: 'bad', items: report.brokenLinks },
		{ key: 'orphans', label: 'Orphan pages', tone: 'warn', items: report.orphans },
		{ key: 'stale', label: `Stale (>180d)`, tone: 'warn', items: report.stale },
		{ key: 'untitled', label: 'Missing H1 title', tone: 'info', items: report.untitled },
	]);
</script>

<svelte:head><title>Wiki health · llm-wiki</title></svelte:head>

<main class="main">
	<header class="lint-head">
		<div>
			<p class="eyebrow">Health check</p>
			<h1>{report.healthy ? 'Wiki is healthy' : 'Issues found'}</h1>
			<p class="muted">{report.pageCount} pages · generated {report.generatedAt.slice(0, 19).replace('T', ' ')}</p>
		</div>
		<div class="score" class:ok={report.healthy}>
			{report.healthy ? '✓' : report.counts.brokenLinks + report.counts.orphans}
		</div>
	</header>

	<div class="counts">
		{#each groups as g (g.key)}
			<div class="count-card {g.tone}">
				<span class="count-n">{report.counts[g.key as keyof typeof report.counts]}</span>
				<span class="count-l">{g.label}</span>
			</div>
		{/each}
	</div>

	{#each groups as g (g.key)}
		{#if g.items.length > 0}
			<section class="lint-group">
				<h2>{g.label} <span class="n">{report.counts[g.key as keyof typeof report.counts]}</span></h2>
				<div class="findings">
					{#each g.items as item (item.path + ('target' in item ? item.target : ''))}
						<a class="finding" href="{base}/page/{item.path}">
							<span class="f-title">{item.title}</span>
							<span class="f-detail">{item.detail}</span>
							<span class="f-path">{item.path}</span>
						</a>
					{/each}
				</div>
			</section>
		{/if}
	{/each}
</main>

<style>
	.lint-head {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 20px;
		margin-bottom: 24px;
	}

	.eyebrow {
		margin: 0 0 8px;
		color: var(--ink-muted);
		font-size: 13px;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.08em;
	}

	.lint-head h1 {
		margin: 0 0 6px;
		font-size: clamp(26px, 3.4vw, 36px);
	}

	.score {
		display: grid;
		place-items: center;
		min-width: 64px;
		height: 64px;
		padding: 0 14px;
		border-radius: 14px;
		background: #fbe9e4;
		color: #b4541f;
		font-size: 26px;
		font-weight: 800;
	}

	.score.ok {
		background: var(--accent-soft);
		color: var(--accent);
	}

	.counts {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
		gap: 12px;
		margin-bottom: 32px;
	}

	.count-card {
		display: grid;
		gap: 6px;
		border: 1px solid var(--border);
		border-radius: 11px;
		background: var(--surface);
		padding: 16px 18px;
	}

	.count-card.bad {
		border-color: #e7c3b6;
	}

	.count-n {
		font-size: 30px;
		font-weight: 800;
		font-variant-numeric: tabular-nums;
		line-height: 1;
	}

	.count-l {
		color: var(--ink-muted);
		font-size: 13px;
	}

	.lint-group {
		margin-bottom: 30px;
	}

	.lint-group h2 {
		display: flex;
		align-items: center;
		gap: 8px;
		margin: 0 0 12px;
		font-size: 16px;
	}

	.lint-group .n {
		border-radius: 999px;
		background: var(--surface-alt);
		padding: 1px 8px;
		color: var(--ink-muted);
		font-size: 12px;
	}

	.findings {
		display: grid;
		gap: 6px;
	}

	.finding {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		gap: 2px 14px;
		border: 1px solid var(--border-soft);
		border-radius: 8px;
		background: var(--surface-alt);
		padding: 9px 13px;
	}

	.finding:hover {
		border-color: #b9c6c0;
	}

	.f-title {
		color: var(--ink);
		font-size: 14px;
		font-weight: 600;
	}

	.f-detail {
		grid-row: 2;
		color: #b4541f;
		font-size: 12px;
	}

	.f-path {
		grid-column: 2;
		grid-row: 1 / 3;
		align-self: center;
		color: var(--ink-muted);
		font-family: ui-monospace, Menlo, Consolas, monospace;
		font-size: 11px;
		word-break: break-all;
	}
</style>
