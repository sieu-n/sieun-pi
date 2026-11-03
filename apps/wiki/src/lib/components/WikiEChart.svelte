<script lang="ts" module>
	/** A chart file written by a script: `{ at, charts: { [key]: { height, option } } }`, plain JSON options. */
	export interface ChartFile {
		at: string;
		charts: Record<string, { height: number; option: Record<string, unknown> }>;
	}

	const REFRESH_MS = 5 * 60_000;
	const loads = new Map<string, { at: number; file: Promise<ChartFile> }>();

	/** One fetch per file per refresh tick, shared by every chart slot on the page. */
	function load(src: string): Promise<ChartFile> {
		const hit = loads.get(src);
		if (hit && Date.now() - hit.at < REFRESH_MS / 2) return hit.file;
		const file = fetch(src, { cache: 'no-store' }).then((response) => {
			if (!response.ok) throw new Error(`${src} answered ${response.status}`);
			return response.json() as Promise<ChartFile>;
		});
		loads.set(src, { at: Date.now(), file });
		return file;
	}
</script>

<script lang="ts">
	import EChart from '$lib/charts/EChart.svelte';
	import { axisChrome, baseTooltip, type ChartTokens } from '$lib/charts/tokens';

	/** Space the SVG version keeps for its title, which this host draws as an HTML header row instead. */
	const TITLE_PX = 48;

	let { src, chart }: { src: string; chart: string } = $props();
	let file = $state.raw<ChartFile | null>(null);
	let failed = $state<string | null>(null);

	$effect(() => {
		let live = true;
		const read = () =>
			load(src).then(
				(next) => {
					if (!live) return;
					file = next;
					failed = next.charts[chart] ? null : `no chart "${chart}" in ${src}`;
				},
				(error: unknown) => {
					if (live) failed = error instanceof Error ? error.message : String(error);
				},
			);
		void read();
		const timer = setInterval(read, REFRESH_MS);
		return () => {
			live = false;
			clearInterval(timer);
		};
	});

	const spec = $derived(file?.charts[chart] ?? null);
	const title = $derived((spec?.option.title ?? {}) as { text?: string; subtext?: string });

	function themed(option: Record<string, unknown>, t: ChartTokens): Record<string, unknown> {
		const chrome = axisChrome(t);
		const axis = (value: unknown) => {
			const a = (value ?? {}) as Record<string, unknown>;
			return {
				...a,
				axisLine: chrome.axisLine,
				axisTick: chrome.axisTick,
				splitLine: chrome.splitLine,
				axisLabel: { ...chrome.axisLabel, ...(a.axisLabel as object) },
			};
		};
		const grid = (option.grid ?? {}) as Record<string, number>;
		const legend = (option.legend ?? {}) as Record<string, unknown>;
		const tooltip = (option.tooltip ?? {}) as Record<string, unknown>;
		const rest = { ...option };
		delete rest.title;
		delete rest.backgroundColor;
		return {
			...rest,
			textStyle: { color: t.ink, fontFamily: t.sans },
			grid: { ...grid, top: Math.max(12, (grid.top ?? TITLE_PX) - TITLE_PX + (legend.top === undefined ? 0 : 20)) },
			legend: {
				// A legend with one entry per runner wraps into the plot; past two rows it scrolls on one row instead.
				...(Array.isArray(option.series) && option.series.length > 8 ? { type: 'scroll' } : {}),
				...legend,
				top: legend.top === undefined ? undefined : 0,
				textStyle: { ...(legend.textStyle as object), color: t.inkMuted },
			},
			tooltip: { ...baseTooltip(t), trigger: 'axis', ...tooltip, confine: true },
			xAxis: axis(option.xAxis),
			yAxis: axis(option.yAxis),
		};
	}
</script>

<figure class="wiki-echart">
	{#if spec}
		<figcaption>
			<strong>{title.text}</strong>
			{#if title.subtext}<span>{title.subtext}</span>{/if}
		</figcaption>
		<EChart option={(t) => themed(spec.option, t)} height="{spec.height - TITLE_PX + 20}px" />
	{:else if failed}
		<p class="wiki-echart-failed" role="alert">Chart did not load: {failed}</p>
	{:else}
		<div class="wiki-echart-wait" aria-hidden="true"></div>
	{/if}
</figure>

<style>
	.wiki-echart {
		margin: 1rem 0;
	}
	figcaption {
		display: flex;
		flex-wrap: wrap;
		gap: 0 0.6rem;
		align-items: baseline;
		font-size: 0.8rem;
		color: var(--color-ink-muted);
	}
	figcaption strong {
		font-size: 0.9rem;
		color: var(--color-ink);
	}
	.wiki-echart-failed {
		font-size: 0.8rem;
		color: var(--color-ink-muted);
	}
	.wiki-echart-wait {
		height: 240px;
		border-radius: 6px;
		background: var(--color-surface-alt);
	}
</style>
