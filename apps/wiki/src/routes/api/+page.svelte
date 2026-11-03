<script lang="ts">
	import { onMount } from 'svelte';
	import { base } from '$app/paths';
	import '@scalar/api-reference/style.css';

	let mountEl = $state<HTMLDivElement | null>(null);
	let errorMsg = $state('');

	onMount(() => {
		let instance: { destroy?: () => void; unmount?: () => void } | undefined;
		(async () => {
			const { createApiReference } = await import('@scalar/api-reference');
			if (!mountEl) return;
			instance = createApiReference(mountEl, {
				url: `${base}/api/openapi-spec`,
				theme: 'default',
				hideClientButton: false,
			});
		})().catch((err) => {
			errorMsg = `Could not load API reference: ${err.message}`;
		});
		return () => {
			instance?.destroy?.();
			instance?.unmount?.();
		};
	});
</script>

<svelte:head><title>API Reference · llm-wiki</title></svelte:head>

{#if errorMsg}
	<div class="api-error">
		<h1>API reference unavailable</h1>
		<p class="muted">{errorMsg}</p>
		<p class="muted small">
			The reference renders <code>api.virev.ai/openapi.json</code> through <code>/api/openapi-spec</code>. Set
			<code>OPENAPI_SPEC_URL</code> to point at a different spec.
		</p>
	</div>
{/if}
<div class="scalar-host" bind:this={mountEl}></div>

<style>
	.scalar-host {
		min-height: calc(100vh - 49px);
	}

	.api-error {
		max-width: 560px;
		margin: 10vh auto;
		padding: 0 24px;
		text-align: center;
	}

	.api-error h1 {
		font-size: 24px;
	}

	.api-error code {
		font-family: ui-monospace, Menlo, Consolas, monospace;
		font-size: 0.9em;
	}
</style>
