<script lang="ts" module>
	type Registry = typeof import('./registry');
	/** The chart registries this tab has loaded, by preset. A chart that mounts again inits from them in the same
	 *  frame instead of painting the skeleton first (10-24: every switch back to /app/dashboards/our-posts showed
	 *  it, 10 of 10, app-speed spec). */
	const loaded: { basic?: Registry; full?: Registry } = {};
</script>

<script lang="ts">
	/**
	 * The one shared ECharts host. Client-only: the registry is dynamic-imported inside the attachment, so SSR
	 * renders the skeleton. The option is a factory over the design tokens, re-applied when its reactive state
	 * changes or the nearest `[data-theme]` ancestor flips.
	 */
	import { untrack } from 'svelte';
	import type { EChartsType } from 'echarts/core';
	import { readTokens, type ChartTokens } from '$lib/charts/tokens';
	import { chartRegistry } from '$lib/charts/preload';

	interface Props {
		option: (t: ChartTokens) => Record<string, unknown>;
		height?: string;
		/**
		 * Which echarts registration to pull. `basic` (default) = line/area + grid,
		 * tooltip, legend, zoom — everything a trend chart needs, and all a public
		 * page should pay for. `full` adds the enterprise set (map, graph, treemap,
		 * themeRiver, heatmap, boxplot, calendar, geo, visualMap, bar, scatter).
		 */
		preset?: 'basic' | 'full';
		onEvents?: Record<string, (params: never) => void>;
		/**
		 * Starts the chart after its page's first paint, each chart in a task of its own, for a chart under the fold: a
		 * switch to the page paints its first screen before ECharts builds the chart. measured: on staging 685b928
		 * (10-25, load 76 to 108) the Brand intelligence page's three charts, all under the fold at 1440 by 900, took
		 * 154 ms of each switch's 284 ms Svelte flush, init and setOption in the click's task.
		 */
		lazy?: boolean;
	}

	let { option, height = '300px', preset = 'basic', onEvents, lazy = false }: Props = $props();

	/** A lazy chart waiting for its page's first paint draws an empty box, not the skeleton: its registry is loaded,
	 *  so it draws a frame later and a skeleton would only flash (slow-pages' lazy board showed it on 30 of 30
	 *  switches). A registry that still has to load shows the skeleton as before. */
	// svelte-ignore state_referenced_locally
	let deferring = $state(lazy);

	/**
	 * One import of the registry. A discarded warm-up import would record a load failure in the module map, and
	 * re-importing the same specifier replays the cached rejection, so a retry cache-busts the specifier.
	 */
	async function loadRegistry(full: boolean, attemptN: number) {
		// Imported by package specifier: Vite's optimizeDeps prebundles only bare specifiers, and a relative
		// import is served in dev as `/@fs/<abs-path>/registry-basic.ts` (see apps/search/vite.config.ts).
		// The first load reads the one import preload.ts keeps per tab.
		if (attemptN === 0) return await chartRegistry(full);
		const url = new URL(full ? './registry.ts' : './registry-basic.ts', import.meta.url);
		url.searchParams.set('retry', String(attemptN));
		return (await import(/* @vite-ignore */ url.href)) as typeof import('./registry');
	}

	const BASIC_MERGE = ['series', 'xAxis', 'yAxis', 'legend', 'dataZoom'];
	const FULL_MERGE = [...BASIC_MERGE, 'visualMap', 'singleAxis', 'calendar', 'geo'];
	const REPLACE_MERGE = $derived(preset === 'full' ? FULL_MERGE : BASIC_MERGE);

	let chart = $state.raw<EChartsType | null>(null);
	let ready = $state(false);
	/** An init failure is surfaced, logged and offered a retry, never left as a running skeleton. */
	let failed = $state<string | null>(null);
	let attempt = $state(0);
	let hostNode: HTMLElement | null = null;

	const reduced = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

	/** The host's design tokens, read once per host and again when its theme flips. measured: on staging 22bfae8ae6
	 *  (11-01, Adapt Korea) reading them on each re-apply took about 9 ms of a range switch's click task per chart, in
	 *  getComputedStyle and its getPropertyValue calls. */
	let tokens: ChartTokens | null = null;

	/** The full option for the chart now: the caller's factory over the host's tokens. Reading it in an effect tracks
	 *  the state the factory reads. */
	const built = (node: HTMLElement) => ({
		animation: !reduced,
		animationDuration: 700,
		animationEasing: 'cubicOut',
		animationDurationUpdate: 420,
		...option((tokens ??= readTokens(node))),
	});

	function draw(next: Record<string, unknown>) {
		if (!chart) return;
		// replaceMerge may only name registered component types, or echarts throws
		// ("\"visualMap\" is not valid component main type"). Keep it in step with the two registries.
		chart.setOption(next, { replaceMerge: REPLACE_MERGE });
		ready = true;
	}

	function apply() {
		if (!chart || !hostNode) return;
		draw(built(hostNode));
	}

	/**
	 * A chart already drawn takes a new option after the frame the change paints in, so a range switch paints its text
	 * first; the first draw stays in the same frame. measured: on staging 7ec66ca (11-01, Adapt Korea, load 76 to 107) a
	 * switch back to a kept range ran one 216 to 616 ms task before the Summary drew, about a quarter of it ECharts
	 * setOption on the charts on screen.
	 */
	$effect(() => {
		void option;
		if (!chart || !hostNode) return;
		const next = built(hostNode);
		if (!untrack(() => ready)) {
			draw(next);
			return;
		}
		let later: ReturnType<typeof setTimeout> | undefined;
		const frame = requestAnimationFrame(() => (later = setTimeout(() => draw(next))));
		return () => {
			cancelAnimationFrame(frame);
			clearTimeout(later);
		};
	});

	function host(node: HTMLElement) {
		let disposed = false;
		let ro: ResizeObserver | undefined;
		let mo: MutationObserver | undefined;
		let frame = 0;
		let later: ReturnType<typeof setTimeout> | undefined;
		hostNode = node;
		tokens = null;
		// Watchdog: on a loaded machine the chunk fetch can stall without ever
		// rejecting. Skeleton forever is indistinguishable from a hang, so cap it.
		const watchdog = setTimeout(() => {
			if (!ready && !failed) failed = 'timeout: chart runtime did not load in 15s';
		}, 15000);
		const full = preset === 'full';
		const start = (mod: Registry) => {
			const c = mod.echarts.init(node, undefined, { renderer: 'canvas' });
			if (onEvents) for (const [ev, fn] of Object.entries(onEvents)) c.on(ev, fn as never);
			// The observer's first callback reports the size init already drew at, and an equal size needs no resize: on
			// staging (10-25) that first resize redrew every chart of a board a second time, 45 to 80 ms of each switch to it.
			ro = new ResizeObserver(([entry]) => {
				const box = entry?.contentRect;
				if (box && Math.round(box.width) === c.getWidth() && Math.round(box.height) === c.getHeight()) return;
				c.resize();
			});
			ro.observe(node);
			// The nearest `[data-theme]`, because `.mkt[data-theme]` on marketing pages never touches `<html>`.
			const themeRoot = node.closest('[data-theme]') ?? document.documentElement;
			mo = new MutationObserver(() => {
				tokens = null;
				apply();
			});
			mo.observe(themeRoot, { attributes: true, attributeFilter: ['data-theme'] });
			chart = c;
		};
		const kept = full ? loaded.full : loaded.basic;
		if (kept) {
			const begin = () => {
				if (disposed) return;
				deferring = false;
				try {
					start(kept);
				} catch (err) {
					// eslint-disable-next-line no-console
					console.error('[EChart] failed to initialise', err);
					failed = err instanceof Error ? err.message : String(err);
				}
			};
			if (lazy) frame = requestAnimationFrame(() => (later = setTimeout(begin)));
			else begin();
			return stop;
		}
		deferring = false;
		(async () => {
			// Split registries: the public trend charts must not download the
			// enterprise chart set.
			const mod = (await loadRegistry(full, attempt)) as Registry;
			loaded[full ? 'full' : 'basic'] = mod;
			if (disposed) return;
			start(mod);
		})().catch((err) => {
			if (disposed) return;
			// eslint-disable-next-line no-console
			console.error('[EChart] failed to initialise', err);
			failed = err instanceof Error ? err.message : String(err);
		});
		function stop() {
			disposed = true;
			clearTimeout(watchdog);
			cancelAnimationFrame(frame);
			clearTimeout(later);
			hostNode = null;
			ro?.disconnect();
			mo?.disconnect();
			chart?.dispose();
			chart = null;
		}
		return stop;
	}
</script>

<div class="ec-container" style="height:{height}">
	<!-- keyed on `attempt` so Retry tears the host down and re-runs init -->
	{#key attempt}
		<div class="ec-host" {@attach host}></div>
	{/key}
	{#if failed}
		<div class="ec-failed" role="alert">
			<p class="ec-failed-msg">{failed}</p>
			<button
				type="button"
				class="ec-retry"
				onclick={() => {
					failed = null;
					ready = false;
					attempt += 1;
				}}
			>
				Retry
			</button>
		</div>
	{:else if !ready && !deferring}
		<div class="ec-skeleton" aria-hidden="true"></div>
	{/if}
</div>

<style>
	.ec-container {
		position: relative;
		width: 100%;
	}
	.ec-host {
		position: absolute;
		inset: 0;
	}
	.ec-failed,
	.ec-skeleton {
		position: absolute;
		inset: 0.5rem;
		border-radius: 0.375rem;
	}
	.ec-failed {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 10px;
		text-align: center;
		padding: 16px;
		background: var(--color-surface-alt);
	}
	.ec-failed-msg {
		margin: 0;
		font-size: 12px;
		line-height: 1.5;
		color: var(--color-ink-muted, #66736f);
		max-width: 46ch;
		word-break: break-word;
	}
	.ec-retry {
		font-size: 12px;
		padding: 4px 12px;
		border-radius: 6px;
		border: 1px solid var(--color-rule, rgba(0, 0, 0, 0.12));
		background: var(--color-surface, #fff);
		color: var(--color-ink, inherit);
		cursor: pointer;
	}
	.ec-retry:hover {
		border-color: var(--color-ink-faint, rgba(0, 0, 0, 0.3));
	}
	.ec-skeleton {
		background: linear-gradient(
			100deg,
			var(--color-surface-alt) 30%,
			color-mix(in srgb, var(--color-surface-alt) 40%, var(--color-surface)) 50%,
			var(--color-surface-alt) 70%
		);
		background-size: 200% 100%;
		animation: ecSheen 1.3s ease-in-out infinite;
	}
	@keyframes ecSheen {
		from {
			background-position: 150% 0;
		}
		to {
			background-position: -50% 0;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.ec-skeleton {
			animation: none;
		}
	}
</style>
