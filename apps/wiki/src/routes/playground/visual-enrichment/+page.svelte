<script lang="ts">
	import { base } from '$app/paths';
	import RunHistory from '$lib/components/RunHistory.svelte';
	import { fetchRuns, type Run } from '$lib/run-history';

	type RunResult = {
		username: string;
		snapshot_b64: string;
		missing_cdn: number;
		result: Record<string, unknown> & { visual?: Record<string, unknown> };
		model: string;
		input_tokens: number;
		output_tokens: number;
		duration_ms: number;
	};

	// ENRICH_VISUAL_MODEL in apps/crawler-v3/src/settings.py first; the crawler's release gate (enrichment/client.py
	// RELEASE_MODELS) refuses every model but the newest of each tier.
	const MODELS = ['gpt-6-luna', 'gpt-6.1-sol', 'gpt-6.1-terra'];

	let username = $state('essenherb');
	let model = $state(MODELS[0]);
	let limit = $state(12);
	let header = $state(true);
	let tileMeta = $state(true);
	let burnCaptions = $state(false);
	let captionsText = $state(true);
	let attachImage = $state(true);
	let prompt = $state('');
	let running = $state(false);
	let errorMsg = $state('');
	let run = $state<RunResult | null>(null);

	async function execute() {
		running = true;
		errorMsg = '';
		try {
			const resp = await fetch(`${base}/api/playground/visual-enrich`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					username: username.trim().replace(/^@/, ''),
					model,
					limit,
					header,
					tile_meta: tileMeta,
					captions: burnCaptions,
					captions_text: captionsText,
					attach_image: attachImage,
					...(prompt.trim() ? { prompt: prompt.trim() } : {}),
				}),
			});
			if (!resp.ok) {
				const body = await resp.json().catch(() => null);
				throw new Error(body?.message ?? `HTTP ${resp.status}`);
			}
			run = await resp.json();
		} catch (e) {
			run = null;
			errorMsg = e instanceof Error ? e.message : String(e);
		} finally {
			running = false;
		}
	}

	let pastRuns = $state.raw<Run[] | null>(null);
	let pastErr = $state('');
	$effect(() => {
		fetchRuns('visual-enrichment').then(
			(r) => (pastRuns = r),
			(e: unknown) => (pastErr = e instanceof Error ? e.message : String(e)),
		);
	});

	const visual = $derived((run?.result?.visual ?? {}) as Record<string, unknown>);
	const shared = $derived.by(() => {
		if (!run) return {} as Record<string, unknown>;
		const { visual: _v, ...rest } = run.result;
		return rest;
	});
</script>

<svelte:head><title>Visual enrichment playground · llm-wiki</title></svelte:head>

<main class="main">
	<header class="head">
		<p class="eyebrow">Playground · staging crawler-v3 · all LLM calls via CLIProxy</p>
		<h1>Visual enrichment</h1>
		<p class="muted">
			Renders the IG-style profile composite and vision-classifies it. Design:
			<a href="{base}/page/projects/visual-enrichment/index.html">projects/visual-enrichment</a> · evidence:
			<a href="{base}/page/experiments/2026-07-05-enrichment/visual-enrichment-ablation/index.html">ablation</a>. Profile must
			exist in the staging crawler DB with fresh media (run <code>POST /refresh</code> +
			<code>GET /timeline?persist=true</code> first for new accounts).
		</p>
	</header>

	<form
		class="controls"
		onsubmit={(e) => {
			e.preventDefault();
			void execute();
		}}
	>
		<label class="field grow">
			<span>Username</span>
			<input bind:value={username} placeholder="essenherb" required />
		</label>
		<label class="field">
			<span>Model</span>
			<select bind:value={model}>
				{#each MODELS as m (m)}<option value={m}>{m}</option>{/each}
			</select>
		</label>
		<label class="field">
			<span>Tiles</span>
			<select bind:value={limit}>
				<option value={12}>12</option>
				<option value={6}>6</option>
				<option value={0}>0 (header only)</option>
			</select>
		</label>
		<div class="toggles">
			<label><input type="checkbox" bind:checked={header} /> header</label>
			<label><input type="checkbox" bind:checked={tileMeta} /> tile badges</label>
			<label><input type="checkbox" bind:checked={burnCaptions} /> burn captions</label>
			<label><input type="checkbox" bind:checked={captionsText} /> captions as text</label>
			<label><input type="checkbox" bind:checked={attachImage} /> attach image</label>
		</div>
		<label class="field wide">
			<span>Prompt override <em>(empty = production field-guided prompt)</em></span>
			<textarea bind:value={prompt} rows="3" placeholder="Leave empty for the production prompt"></textarea>
		</label>
		<button type="submit" disabled={running}>{running ? 'Running…' : 'Render + classify'}</button>
	</form>

	{#if errorMsg}<p class="error">{errorMsg}</p>{/if}

	{#if run}
		<section class="meta">
			<span><strong>{run.model}</strong></span>
			<span>{run.duration_ms.toLocaleString()} ms</span>
			<span>{run.input_tokens.toLocaleString()} in / {run.output_tokens.toLocaleString()} out tokens</span>
			<span>{run.missing_cdn} missing tiles</span>
		</section>
		<section class="results">
			<figure class="render">
				<img src={`data:image/png;base64,${run.snapshot_b64}`} alt={`Rendered profile snapshot of @${run.username}`} />
				<figcaption>Model input — rendered composite</figcaption>
			</figure>
			<div class="output">
				<h2>Shared fields</h2>
				<table>
					<tbody>
						{#each Object.entries(shared) as [key, value] (key)}
							<tr><th>{key}</th><td>{Array.isArray(value) ? value.join(', ') : String(value ?? '—')}</td></tr>
						{/each}
					</tbody>
				</table>
				<h2>visual.*</h2>
				<table>
					<tbody>
						{#each Object.entries(visual) as [key, value] (key)}
							<tr>
								<th>{key}</th>
								<td>
									{#if key === 'dominant_palette' && Array.isArray(value)}
										{#each value as hex (hex)}
											<span class="swatch" style={`background:${hex}`}></span><code>{hex}</code>&nbsp;
										{/each}
									{:else}
										{Array.isArray(value) ? value.join(', ') : String(value ?? '—')}
									{/if}
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		</section>
	{/if}

	<section class="past">
		<h2>Past runs</h2>
		<p class="muted">
			Every visual-enrichment run from the shared <a href="{base}/playground/runs?component=visual-enrichment">run history</a
			>.
		</p>
		{#if pastErr}
			<p class="error">{pastErr}</p>
		{:else if !pastRuns}
			<p class="muted">Loading runs…</p>
		{:else}
			<RunHistory component="visual-enrichment" runs={pastRuns} />
		{/if}
	</section>
</main>

<style>
	.main {
		max-width: 1200px;
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
		max-width: 70ch;
	}
	.controls {
		display: flex;
		flex-wrap: wrap;
		gap: 14px;
		align-items: flex-end;
		margin: 24px 0 8px;
		padding: 16px;
		border: 1px solid color-mix(in srgb, currentColor 15%, transparent);
		border-radius: 10px;
	}
	.field {
		display: flex;
		flex-direction: column;
		gap: 4px;
		font-size: 13px;
	}
	.field span {
		opacity: 0.7;
	}
	.field.grow {
		flex: 1 1 180px;
	}
	.field.wide {
		flex: 1 1 100%;
	}
	.field input,
	.field select,
	.field textarea {
		font: inherit;
		padding: 6px 10px;
		border: 1px solid color-mix(in srgb, currentColor 25%, transparent);
		border-radius: 6px;
		background: transparent;
		color: inherit;
	}
	.toggles {
		display: flex;
		gap: 12px;
		flex-wrap: wrap;
		font-size: 13px;
		padding-bottom: 8px;
	}
	button {
		font: inherit;
		font-weight: 600;
		padding: 8px 18px;
		border-radius: 8px;
		border: 1px solid color-mix(in srgb, currentColor 30%, transparent);
		background: color-mix(in srgb, currentColor 8%, transparent);
		color: inherit;
		cursor: pointer;
	}
	button:disabled {
		opacity: 0.5;
		cursor: wait;
	}
	.error {
		color: #ef4444;
		font-weight: 600;
	}
	.meta {
		display: flex;
		gap: 18px;
		font-size: 13px;
		opacity: 0.85;
		margin: 14px 0;
	}
	.results {
		display: grid;
		grid-template-columns: minmax(320px, 480px) 1fr;
		gap: 28px;
		align-items: start;
	}
	@media (max-width: 900px) {
		.results {
			grid-template-columns: 1fr;
		}
	}
	.render img {
		width: 100%;
		border: 1px solid color-mix(in srgb, currentColor 15%, transparent);
		border-radius: 8px;
	}
	.render figcaption {
		font-size: 12px;
		opacity: 0.6;
		text-align: center;
		margin-top: 6px;
	}
	.output h2 {
		font-size: 15px;
		margin: 0 0 8px;
	}
	.output h2 + table {
		margin-bottom: 20px;
	}
	.output table {
		width: 100%;
		border-collapse: collapse;
		font-size: 13px;
	}
	.output th {
		text-align: left;
		white-space: nowrap;
		padding: 5px 14px 5px 0;
		vertical-align: top;
		opacity: 0.7;
		font-weight: 500;
	}
	.output td {
		padding: 5px 0;
	}
	.output tr {
		border-bottom: 1px solid color-mix(in srgb, currentColor 8%, transparent);
	}
	.past {
		margin-top: 40px;
	}
	.past h2 {
		font-size: 18px;
		margin: 0 0 4px;
	}
	.past .muted a {
		text-decoration: underline;
	}
	.swatch {
		display: inline-block;
		width: 14px;
		height: 14px;
		border-radius: 3px;
		border: 1px solid color-mix(in srgb, currentColor 25%, transparent);
		vertical-align: -2px;
		margin-right: 4px;
	}
</style>
