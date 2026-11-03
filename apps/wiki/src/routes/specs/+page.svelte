<script lang="ts">
	import { base } from '$app/paths';
	import SpecCard from '$lib/components/specs/SpecCard.svelte';
	import type { SpecsPage } from '$lib/components/specs/types';

	let { data }: { data: SpecsPage } = $props();
	let fresh = $state.raw<SpecsPage | null>(null);
	const model = $derived(fresh ?? data);
	let toast = $state<{ text: string; bad: boolean } | null>(null);

	const count = $derived(model.folders.reduce((n, f) => n + f.specs.length, 0));
	const drafts = $derived(model.folders.reduce((n, f) => n + f.specs.filter((s) => s.status === 'draft').length, 0));
	const range = $derived(`${model.days[0]} to ${model.days.at(-1)}`);

	async function refresh() {
		try {
			const response = await fetch(`${base}/api/specs`, { cache: 'no-store' });
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			fresh = (await response.json()) as SpecsPage;
		} catch (failure) {
			say(`Could not reload: ${failure instanceof Error ? failure.message : 'request failed'}`, true);
		}
	}
	function say(text: string, bad = false) {
		toast = { text, bad };
		setTimeout(() => toast?.text === text && (toast = null), bad ? 8000 : 2500);
	}
</script>

<svelte:head><title>Specs · llm-wiki</title></svelte:head>

<div class="page">
	<header class="top">
		<div>
			<h1>Specs</h1>
			<p class="sum">
				{count} spec{count === 1 ? '' : 's'}{drafts ? `, ${drafts} draft${drafts === 1 ? '' : 's'}` : ''} in {model
					.folders.length}
				folder{model.folders.length === 1 ? '' : 's'}. Cells are the newest run per day, {range}.
				{#if !model.local}Read only here; play, edit and approve work on the local dev server.{/if}
			</p>
		</div>
		<nav class="folders" aria-label="Folders">
			{#each model.folders as folder (folder.path)}
				<a href={`#folder-${folder.path.replace(/[^\w-]/g, '-')}`}
					>{folder.path || 'top level'}<span>{folder.specs.length}</span></a
				>
			{/each}
		</nav>
	</header>

	{#each model.problems as problem (problem)}<p class="banner bad">{problem}</p>{/each}

	{#each model.folders as folder (folder.path)}
		<section id={`folder-${folder.path.replace(/[^\w-]/g, '-')}`}>
			<h2>{folder.path || 'top level'}</h2>
			{#each folder.specs as spec (spec.id)}
				<SpecCard {spec} days={model.days} local={model.local} onrefresh={refresh} onsay={say} />
			{/each}
		</section>
	{:else}
		<p class="banner">No spec files under <code>apps/specs/</code>.</p>
	{/each}

	<p class="foot">
		Files live in <code>apps/specs/&lt;folder&gt;/&lt;slug&gt;.md</code>. From a terminal:
		<code>node apps/specs/run.mjs --spec SPEC-n --env local</code>
	</p>
</div>

{#if toast}<div class="toast" class:bad={toast.bad} role="status">{toast.text}</div>{/if}

<style>
	.page {
		max-width: 1180px;
		margin: 0 auto;
		padding: 20px 24px 60px;
	}
	.top {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 24px;
		flex-wrap: wrap;
		padding-bottom: 14px;
		border-bottom: 1px solid var(--border);
		margin-bottom: 18px;
	}
	h1 {
		margin: 0;
		font-size: 20px;
		font-weight: 650;
	}
	.sum {
		margin: 4px 0 0;
		font-size: 12.5px;
		color: var(--ink-muted);
		max-width: 70ch;
		line-height: 1.5;
	}
	.folders {
		display: flex;
		flex-wrap: wrap;
		gap: 4px 6px;
		max-width: 520px;
		justify-content: flex-end;
	}
	.folders a {
		font-size: 12px;
		color: var(--ink-soft);
		border: 1px solid var(--border);
		border-radius: 999px;
		padding: 3px 9px;
		background: var(--surface);
		white-space: nowrap;
	}
	.folders a:hover {
		color: var(--ink);
		border-color: var(--ink-muted);
	}
	.folders a span {
		margin-left: 5px;
		color: var(--ink-muted);
		font-variant-numeric: tabular-nums;
	}
	section {
		margin-bottom: 26px;
	}
	h2 {
		font-size: 12px;
		font-weight: 600;
		color: var(--ink-muted);
		text-transform: none;
		margin: 0 0 8px;
		scroll-margin-top: 70px;
	}
	.banner {
		font-size: 12.5px;
		padding: 9px 12px;
		border-radius: 8px;
		background: var(--surface-alt);
		border: 1px solid var(--border);
		margin: 0 0 12px;
	}
	.banner.bad {
		background: #fcefeb;
		border-color: #f1cfc6;
		color: #b03a22;
	}
	.foot {
		font-size: 11.5px;
		color: var(--ink-muted);
		line-height: 1.6;
	}
	code {
		font-size: 11.5px;
	}
	.toast {
		position: fixed;
		bottom: 22px;
		left: 50%;
		transform: translateX(-50%);
		background: #1f1f24;
		color: #fff;
		font-size: 13px;
		padding: 9px 14px;
		border-radius: 8px;
		box-shadow: 0 8px 24px rgb(0 0 0 / 0.2);
		z-index: 60;
		max-width: min(90vw, 720px);
		white-space: pre-wrap;
	}
	.toast.bad {
		background: #b03a22;
	}
</style>
