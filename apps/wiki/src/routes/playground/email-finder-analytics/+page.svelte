<script lang="ts">
	import { base } from '$app/paths';
	type CI = [number, number, number];
	type ProfileRow = {
		bucket: string;
		profiles: number;
		found: number;
		found_rate: CI;
		bio_probe_recall: CI | null;
		emails_per_profile: number;
	};
	type EmailRow = {
		bucket: string;
		emails: number;
		supported: number;
		unsupported: number;
		unretrievable: number;
		recommended: number;
		source_supported_rate: CI | null;
		recommended_share: CI;
		mean_reliability: number;
	};
	type Stats = {
		generated_from: string[];
		by_dimension: Record<string, { profile?: ProfileRow[]; email?: EmailRow[] }>;
		calibration: { reliability_bucket: string; n: number; supported: number; supported_rate: number | null }[];
		reliability_discrimination: Record<string, { mean: number; n: number }>;
	};

	// metric → which fact table + how to read a row
	const METRICS = {
		found_rate: { label: 'Found-rate', table: 'profile' as const },
		bio_probe_recall: { label: 'Bio-probe recall', table: 'profile' as const },
		emails_per_profile: { label: 'Emails / profile', table: 'profile' as const },
		source_supported_rate: { label: 'Source-supported %', table: 'email' as const },
		recommended_share: { label: 'Recommended share', table: 'email' as const },
		mean_reliability: { label: 'Mean reliability', table: 'email' as const },
	};
	type MetricKey = keyof typeof METRICS;

	const PROFILE_DIMS = ['platform', 'region', 'band', 'niche', 'model', 'prompt_variant', 'run_id'];
	const EMAIL_DIMS = [...PROFILE_DIMS, 'category', 'contact_relevance', 'source_type', 'verify_status'];

	let stats: Stats | null = $state(null);
	let loadErr = $state('');
	let metric = $state<MetricKey>('found_rate');
	let dimension = $state('region');

	let sql = $state(
		'SELECT platform, contact_relevance, count(*) AS n\nFROM email_facts\nGROUP BY 1,2 ORDER BY 1,3 DESC',
	);
	let sqlRunning = $state(false);
	let sqlErr = $state('');
	let sqlResult: { columns: string[]; rows: unknown[][] } | null = $state(null);

	async function load() {
		try {
			const r = await fetch(`${base}/api/playground/email-finder-analytics`);
			if (!r.ok) throw new Error((await r.json().catch(() => null))?.message ?? `HTTP ${r.status}`);
			stats = await r.json();
		} catch (e) {
			loadErr = e instanceof Error ? e.message : String(e);
		}
	}
	$effect(() => {
		if (!stats && !loadErr) void load();
	});

	const table = $derived(METRICS[metric].table);
	const dims = $derived(table === 'profile' ? PROFILE_DIMS : EMAIL_DIMS);
	// keep dimension valid when metric flips profile↔email
	$effect(() => {
		if (!dims.includes(dimension)) dimension = 'region';
	});

	type Bar = { bucket: string; value: number | null; lo?: number; hi?: number; n: number; sub: string };
	const bars = $derived.by<Bar[]>(() => {
		if (!stats) return [];
		const block = stats.by_dimension[dimension];
		if (!block) return [];
		if (table === 'profile') {
			const rows = block.profile ?? [];
			return rows.map((r) => {
				if (metric === 'emails_per_profile')
					return { bucket: r.bucket, value: r.emails_per_profile, n: r.profiles, sub: `${r.profiles} profiles` };
				const ci = (r as any)[metric] as CI | null;
				return {
					bucket: r.bucket,
					value: ci ? ci[0] : null,
					lo: ci?.[1],
					hi: ci?.[2],
					n: r.profiles,
					sub: metric === 'found_rate' ? `${r.found}/${r.profiles}` : `${r.profiles} profiles`,
				};
			});
		}
		const rows = block.email ?? [];
		return rows.map((r) => {
			if (metric === 'mean_reliability')
				return { bucket: r.bucket, value: r.mean_reliability, n: r.emails, sub: `${r.emails} emails` };
			const ci = (r as any)[metric] as CI | null;
			return {
				bucket: r.bucket,
				value: ci ? ci[0] : null,
				lo: ci?.[1],
				hi: ci?.[2],
				n: r.emails,
				sub:
					metric === 'source_supported_rate'
						? `${r.supported}/${r.supported + r.unsupported}`
						: `${r.recommended}/${r.emails}`,
			};
		});
	});
	const isPct = $derived(metric !== 'emails_per_profile' && metric !== 'mean_reliability');
	const maxVal = $derived(Math.max(0.0001, ...bars.map((b) => b.value ?? 0)));
	function fmt(v: number | null): string {
		if (v === null) return '—';
		return isPct ? `${(v * 100).toFixed(1)}%` : v.toFixed(2);
	}

	async function runSql() {
		sqlRunning = true;
		sqlErr = '';
		sqlResult = null;
		try {
			const r = await fetch(`${base}/api/playground/email-finder-analytics`, {
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
</script>

<svelte:head><title>Email finder analytics · llm-wiki</title></svelte:head>

<main class="main">
	<header class="head">
		<p class="eyebrow">Playground · local dev · DuckDB over the email-finder benchmark</p>
		<h1>Email finder analytics</h1>
		<p class="small">
			Every email-finder run, old and new, is also in the shared <a href="{base}/playground/runs?component=email-finder"
				>run history</a
			>.
		</p>
		<p class="muted">
			Every email-finder benchmark run and its fetched-page source check, loaded into DuckDB (<code>email_facts</code> /
			<code>profile_facts</code>). Pick a metric and a sub-category to slice it, or run read-only SQL. The write-up:
			<a href="{base}/page/experiments/email-finder/FINDINGS.html">the benchmark</a>.
		</p>
	</header>

	{#if loadErr}
		<p class="error">{loadErr}</p>
	{:else if !stats}
		<p class="muted">Loading…</p>
	{:else}
		<p class="note">
			Buckets pool every run, so slicing by <code>platform</code>, <code>region</code>, or <code>niche</code>
			mixes all model and prompt arms together. Filter by <code>prompt_variant</code>, <code>model</code>, or
			<code>run_id</code> to isolate one arm; the <a href="{base}/page/experiments/email-finder/FINDINGS.html">findings</a>
			report the per-arm numbers.
		</p>
		<p class="small">
			DuckDB over {stats.generated_from.length} runs. Reliability discriminates:
			{#each Object.entries(stats.reliability_discrimination) as [k, v] (k)}
				<code>{k}</code> mean {v.mean} (n={v.n}){' '}
			{/each}
		</p>

		<section class="controls">
			<label class="field">
				<span>Metric</span>
				<select bind:value={metric}>
					{#each Object.entries(METRICS) as [k, m] (k)}<option value={k}>{m.label}</option>{/each}
				</select>
			</label>
			<label class="field">
				<span>Sub-category</span>
				<select bind:value={dimension}>
					{#each dims as d (d)}<option value={d}>{d}</option>{/each}
				</select>
			</label>
			<span class="hint">{METRICS[metric].table === 'profile' ? 'per-profile metric' : 'per-email metric'}</span>
		</section>

		<table class="bars">
			<tbody>
				{#each bars as b (b.bucket)}
					<tr>
						<th>{b.bucket}</th>
						<td class="barcell">
							<span class="bar" style={`width:${((b.value ?? 0) / maxVal) * 100}%`}></span>
						</td>
						<td class="val">{fmt(b.value)}</td>
						<td class="sub"
							>{b.sub}{#if b.lo !== undefined && isPct && b.value !== null}<span class="ci">
									[{(b.lo * 100).toFixed(0)}–{(b.hi! * 100).toFixed(0)}%]</span
								>{/if}</td
						>
					</tr>
				{/each}
			</tbody>
		</table>

		<h2>Reliability calibration</h2>
		<p class="small">
			Model-stated reliability bucket → share of emails whose cited page actually contained the address.
		</p>
		<table class="calib">
			<thead><tr><th>reliability</th><th>n</th><th>supported</th><th></th></tr></thead>
			<tbody>
				{#each stats.calibration as c (c.reliability_bucket)}
					<tr>
						<td class="mono">{c.reliability_bucket}</td>
						<td class="mono">{c.n}</td>
						<td class="mono">{c.supported_rate === null ? '—' : `${(c.supported_rate * 100).toFixed(0)}%`}</td>
						<td class="barcell"><span class="bar cal" style={`width:${(c.supported_rate ?? 0) * 100}%`}></span></td>
					</tr>
				{/each}
			</tbody>
		</table>

		<h2>Ad-hoc DuckDB</h2>
		<p class="small">Read-only SELECT/WITH over <code>email_facts</code> and <code>profile_facts</code>.</p>
		<textarea bind:value={sql} rows="4" spellcheck="false"></textarea>
		<div>
			<button onclick={() => void runSql()} disabled={sqlRunning}>{sqlRunning ? 'Running…' : 'Run query'}</button>
		</div>
		{#if sqlErr}<p class="error">{sqlErr}</p>{/if}
		{#if sqlResult}
			<div class="sqlout">
				<table>
					<thead
						><tr
							>{#each sqlResult.columns as c (c)}<th>{c}</th>{/each}</tr
						></thead
					>
					<tbody>
						{#each sqlResult.rows.slice(0, 200) as row, i (i)}
							<tr
								>{#each row as cell, j (j)}<td class="mono">{cell === null ? '—' : String(cell)}</td>{/each}</tr
							>
						{/each}
					</tbody>
				</table>
				<p class="small">{sqlResult.rows.length} rows{sqlResult.rows.length > 200 ? ' (showing 200)' : ''}</p>
			</div>
		{/if}
	{/if}
</main>

<style>
	.main {
		max-width: 1100px;
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
		max-width: 75ch;
	}
	.small {
		font-size: 12.5px;
		opacity: 0.8;
	}
	.note {
		font-size: 12.5px;
		opacity: 0.85;
		margin: 10px 0;
		padding: 8px 12px;
		border-left: 2px solid color-mix(in srgb, currentColor 30%, transparent);
		border-radius: 0 6px 6px 0;
		background: color-mix(in srgb, currentColor 4%, transparent);
	}
	.error {
		color: #ef4444;
		font-weight: 600;
	}
	.controls {
		display: flex;
		gap: 16px;
		align-items: flex-end;
		margin: 18px 0 10px;
		flex-wrap: wrap;
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
	.field select {
		font: inherit;
		padding: 6px 10px;
		border: 1px solid color-mix(in srgb, currentColor 25%, transparent);
		border-radius: 6px;
		background: transparent;
		color: inherit;
	}
	.hint {
		font-size: 12px;
		opacity: 0.6;
		padding-bottom: 8px;
	}
	table.bars {
		width: 100%;
		border-collapse: collapse;
		font-size: 13px;
	}
	table.bars th {
		text-align: right;
		white-space: nowrap;
		padding: 4px 12px 4px 0;
		font-weight: 500;
		width: 140px;
	}
	.barcell {
		width: 55%;
	}
	.bar {
		display: inline-block;
		height: 14px;
		border-radius: 3px;
		background: color-mix(in srgb, currentColor 55%, transparent);
		min-width: 1px;
		vertical-align: middle;
	}
	.bar.cal {
		background: color-mix(in srgb, currentColor 40%, transparent);
		height: 10px;
	}
	.val {
		font-family: ui-monospace, monospace;
		text-align: right;
		white-space: nowrap;
		padding: 4px 10px;
		font-weight: 600;
	}
	.sub {
		font-size: 11.5px;
		opacity: 0.65;
		white-space: nowrap;
	}
	.ci {
		opacity: 0.75;
	}
	table.calib {
		border-collapse: collapse;
		font-size: 12.5px;
		margin-top: 6px;
		width: 520px;
		max-width: 100%;
	}
	table.calib th,
	table.calib td {
		text-align: left;
		padding: 3px 12px 3px 0;
	}
	table.calib .barcell {
		width: 200px;
	}
	.mono {
		font-family: ui-monospace, monospace;
	}
	textarea {
		width: 100%;
		font-family: ui-monospace, monospace;
		font-size: 12.5px;
		padding: 10px;
		border: 1px solid color-mix(in srgb, currentColor 25%, transparent);
		border-radius: 8px;
		background: transparent;
		color: inherit;
		box-sizing: border-box;
	}
	button {
		font: inherit;
		font-weight: 600;
		padding: 7px 16px;
		margin-top: 8px;
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
	.sqlout {
		overflow-x: auto;
		margin-top: 12px;
	}
	.sqlout table {
		border-collapse: collapse;
		font-size: 12px;
	}
	.sqlout th {
		text-align: left;
		padding: 4px 12px 4px 0;
		opacity: 0.7;
		border-bottom: 1px solid color-mix(in srgb, currentColor 15%, transparent);
	}
	.sqlout td {
		padding: 3px 12px 3px 0;
		border-bottom: 1px solid color-mix(in srgb, currentColor 7%, transparent);
	}
</style>
