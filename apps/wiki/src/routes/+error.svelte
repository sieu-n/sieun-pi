<script lang="ts">
	import { base } from '$app/paths';
	import { page } from '$app/state';

	const slug = $derived(
		page.url.pathname.startsWith(`${base}/page/`) ? decodeURIComponent(page.url.pathname.slice(`${base}/page/`.length)) : '',
	);
</script>

<div class="error-pane">
	<p class="code">{page.status}</p>
	<h1>{page.error?.message ?? 'Something went wrong'}</h1>
	{#if page.status === 404 && slug}
		<p class="muted">No page exists at <code>{slug}</code>.</p>
		<div class="actions">
			<a class="primary" href="{base}/edit/{slug}?new=1">Create this page</a>
			<a class="ghost" href="{base}/">Back to home</a>
		</div>
	{:else}
		<a class="ghost" href="{base}/">Back to home</a>
	{/if}
</div>

<style>
	.error-pane {
		max-width: 560px;
		margin: 12vh auto;
		padding: 0 24px;
		text-align: center;
	}

	.code {
		margin: 0;
		color: #1d4f43;
		font-size: 56px;
		font-weight: 800;
		font-variant-numeric: tabular-nums;
	}

	h1 {
		margin: 4px 0 14px;
		font-size: 24px;
	}

	.actions {
		display: flex;
		justify-content: center;
		gap: 10px;
		margin-top: 20px;
	}

	.primary,
	.ghost {
		border-radius: 8px;
		padding: 10px 16px;
		font-weight: 600;
	}

	.primary {
		background: #1d4f43;
		color: #fff;
	}

	.ghost {
		border: 1px solid #cdd7d2;
		color: #36524b;
	}

	code {
		font-family: ui-monospace, Menlo, Consolas, monospace;
		font-size: 13px;
	}
</style>
