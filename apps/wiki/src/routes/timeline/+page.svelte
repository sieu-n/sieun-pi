<script lang="ts">
	import { base } from '$app/paths';
	type Log = { path: string; title: string; date: string; apps: string[]; tags: string[]; status: string };
	let { data } = $props();

	const MONTHS = [
		'',
		'January',
		'February',
		'March',
		'April',
		'May',
		'June',
		'July',
		'August',
		'September',
		'October',
		'November',
		'December',
	];

	const groups = $derived.by(() => {
		const map = new Map<string, Log[]>();
		for (const log of data.logs as Log[]) {
			const key = log.date.slice(0, 7);
			(map.get(key) ?? map.set(key, []).get(key)!).push(log);
		}
		return [...map.entries()].sort((a, b) => b[0].localeCompare(a[0]));
	});

	function monthLabel(ym: string): string {
		const [y, m] = ym.split('-');
		return `${MONTHS[Number(m)] ?? m} ${y}`;
	}

	function href(patch: Record<string, string | undefined>): string {
		const next = { ...data.filter, ...patch } as Record<string, string | undefined>;
		const qs = Object.entries(next)
			.filter(([, v]) => v)
			.map(([k, v]) => `${k}=${encodeURIComponent(v as string)}`)
			.join('&');
		return qs ? `${base}/timeline?${qs}` : `${base}/timeline`;
	}

	const hasFilter = $derived(Boolean(data.filter.app || data.filter.tag || data.filter.status));
</script>

<svelte:head><title>Timeline · llm-wiki</title></svelte:head>

<main class="main">
	<header class="tl-head">
		<p class="eyebrow">History · a view over {data.total.toLocaleString()} session logs</p>
		<h1>Timeline</h1>
		<p class="muted">
			Programmatically generated — one entry per work session. Filter by app or status; each project and app page embeds
			its own slice.
		</p>
	</header>

	<div class="tl-filters">
		<span class="fl-label">App</span>
		{#each data.facets.apps.slice(0, 14) as app (app)}
			<a class="chip" class:on={data.filter.app === app} href={href({ app: data.filter.app === app ? undefined : app })}
				>{app}</a
			>
		{/each}
		<span class="fl-label">Status</span>
		{#each data.facets.statuses as st (st)}
			<a
				class="chip"
				class:on={data.filter.status === st}
				href={href({ status: data.filter.status === st ? undefined : st })}>{st}</a
			>
		{/each}
		{#if data.filter.tag}
			<span class="chip on">tag: {data.filter.tag} <a class="x" href={href({ tag: undefined })}>×</a></span>
		{/if}
		{#if hasFilter}<a class="clear" href="{base}/timeline">clear</a>{/if}
	</div>

	<p class="count">{data.logs.length.toLocaleString()} {data.logs.length === 1 ? 'entry' : 'entries'}</p>

	{#each groups as [ym, logs] (ym)}
		<section class="tl-month">
			<h2>{monthLabel(ym)} <span class="m-count">{logs.length}</span></h2>
			<div class="tl-list">
				{#each logs as log (log.path)}
					<a class="tl-row" href="{base}/page/{log.path}">
						<span class="tl-date">{log.date.slice(5)}</span>
						<span class="tl-title">{log.title}</span>
						<span class="tl-tags">
							{#each log.apps.slice(0, 3) as a (a)}<span class="tl-app">{a}</span>{/each}
							{#if log.status && log.status !== 'complete'}<span class="tl-status">{log.status}</span>{/if}
						</span>
					</a>
				{/each}
			</div>
		</section>
	{/each}

	{#if data.logs.length === 0}<p class="muted">No logs match this filter.</p>{/if}
</main>

<style>
	.tl-head {
		max-width: 720px;
		margin-bottom: 22px;
	}
	.eyebrow {
		margin: 0 0 8px;
		color: var(--ink-muted);
		font-size: 13px;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.07em;
	}
	.tl-head h1 {
		margin: 0 0 8px;
		font-size: clamp(28px, 3.4vw, 38px);
	}
	.tl-filters {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 6px;
		margin-bottom: 14px;
		padding-bottom: 16px;
		border-bottom: 1px solid var(--border);
	}
	.fl-label {
		margin: 0 4px 0 6px;
		color: var(--ink-muted);
		font-size: 11px;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.06em;
	}
	.fl-label:first-child {
		margin-left: 0;
	}
	.chip {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		border: 1px solid var(--border);
		border-radius: 999px;
		background: var(--surface);
		padding: 3px 10px;
		color: var(--ink-soft);
		font-size: 12px;
	}
	.chip:hover {
		border-color: #b9c6c0;
	}
	.chip.on {
		border-color: var(--accent);
		background: var(--accent-soft);
		color: var(--accent);
		font-weight: 600;
	}
	.chip .x {
		color: inherit;
	}
	.clear {
		margin-left: 6px;
		color: var(--ink-muted);
		font-size: 12px;
		text-decoration: underline;
	}
	.count {
		margin: 0 0 18px;
		color: var(--ink-muted);
		font-size: 13px;
		font-variant-numeric: tabular-nums;
	}
	.tl-month {
		margin-bottom: 26px;
	}
	.tl-month h2 {
		display: flex;
		align-items: center;
		gap: 8px;
		margin: 0 0 8px;
		font-size: 15px;
		color: var(--ink-soft);
	}
	.m-count {
		border-radius: 999px;
		background: var(--surface-alt);
		padding: 1px 8px;
		color: var(--ink-muted);
		font-size: 11px;
		font-variant-numeric: tabular-nums;
	}
	.tl-list {
		display: grid;
		gap: 1px;
		border: 1px solid var(--border-soft);
		border-radius: 9px;
		overflow: hidden;
	}
	.tl-row {
		display: grid;
		grid-template-columns: 46px minmax(0, 1fr) auto;
		align-items: baseline;
		gap: 12px;
		background: var(--surface);
		padding: 8px 13px;
		border-bottom: 1px solid var(--border-soft);
	}
	.tl-row:last-child {
		border-bottom: none;
	}
	.tl-row:hover {
		background: var(--surface-alt);
	}
	.tl-date {
		color: var(--ink-muted);
		font-family: ui-monospace, Menlo, Consolas, monospace;
		font-size: 11px;
		font-variant-numeric: tabular-nums;
	}
	.tl-title {
		color: var(--ink);
		font-size: 13.5px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.tl-tags {
		display: flex;
		gap: 5px;
	}
	.tl-app {
		color: var(--ink-muted);
		font-family: ui-monospace, Menlo, Consolas, monospace;
		font-size: 10.5px;
	}
	.tl-status {
		border-radius: 4px;
		background: #fbe9e4;
		padding: 0 5px;
		color: #b4541f;
		font-size: 10.5px;
	}
	@media (max-width: 760px) {
		.tl-tags {
			display: none;
		}
	}
</style>
