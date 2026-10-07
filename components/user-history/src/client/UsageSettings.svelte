<script lang="ts">
  import { untrack } from "svelte";
  import { api } from "./api.ts";
  import { clock } from "./clock.svelte.ts";
  import Icon from "./Icon.svelte";
  import Select from "./ui/Select.svelte";
  import { tooltip } from "./ui/tooltip.ts";
  import type { UsageBucket, UsageGroup, UsageModelRow, UsageSeries, UsageSummary, UsageWindow } from "../shared/usage.ts";
  import { barAt, BUCKET_LABEL, bucketsFor, bucketTitle, cost, defaultBucket, fullTokens, ingestLine, layout, modelLabel, sourceCounts, sparkPath, tokens, tps, WINDOWS, type Bar } from "./usage.ts";

  /** Settings > Usage: every agent on this Mac together. The headline is live from the `usage` feed; the chart and table come from api/usage/series and api/usage/models. */
  const PLOT = { left: 44, right: 8, top: 10, bottom: 22, height: 190 };
  const GROUPS: { id: UsageGroup; label: string }[] = [{ id: "none", label: "All" }, { id: "source", label: "By source" }, { id: "model", label: "By model" }];
  const WINDOW_LABEL: Record<UsageWindow, string> = { "1h": "1h", "24h": "24h", "7d": "7d", "30d": "30d", "90d": "90d", all: "All" };
  const isWindow = (value: string | null): value is UsageWindow => WINDOWS.includes(value as UsageWindow);
  const isGroup = (value: string | null): value is UsageGroup => GROUPS.some(entry => entry.id === value);

  let summary = $state<UsageSummary | null>(null);
  let feedDown = $state(false);
  const savedWindow = localStorage.getItem("usage.window");
  const savedGroup = localStorage.getItem("usage.group");
  let window_ = $state<UsageWindow>(isWindow(savedWindow) ? savedWindow : "24h");
  let bucket = $state<UsageBucket>(defaultBucket(isWindow(savedWindow) ? savedWindow : "24h"));
  let group = $state<UsageGroup>(isGroup(savedGroup) ? savedGroup : "none");
  let series = $state<UsageSeries | null>(null);
  let models = $state<UsageModelRow[] | null>(null);
  let error = $state<string | null>(null);
  let loading = $state(false);
  let chartWidth = $state(0);
  let hover = $state<{ bar: Bar; px: number } | null>(null);
  /** The sync the chart was last loaded for, and when; a newer sync reloads it at most every 20 s. */
  let loadedSync = $state<number | null>(null);
  let loadedAt = 0;
  let request = 0;

  $effect(() => api.usageStream(next => { summary = next; feedDown = false; }, () => { feedDown = true; }));

  async function load(): Promise<void> {
    const id = ++request;
    const picked = { window: window_, bucket, group };
    loading = true;
    try {
      const [nextSeries, nextModels] = await Promise.all([api.usageSeries(picked.window, picked.bucket, picked.group), api.usageModels(picked.window)]);
      if (id !== request) return;
      series = nextSeries;
      models = nextModels;
      error = null;
      loadedAt = Date.now();
      loadedSync = summary?.ingest.lastSyncAt ?? null;
    } catch (reason) {
      if (id !== request) return;
      error = reason instanceof Error ? reason.message : String(reason);
    } finally {
      if (id === request) loading = false;
    }
  }
  $effect(() => { void window_; void bucket; void group; hover = null; void load(); });
  $effect(() => {
    const sync = summary?.ingest.lastSyncAt ?? null;
    untrack(() => { if (sync !== null && sync !== loadedSync && Date.now() - loadedAt > 20_000 && !loading) void load(); });
  });

  function pickWindow(next: UsageWindow): void {
    window_ = next;
    bucket = defaultBucket(next);
    localStorage.setItem("usage.window", next);
  }
  function pickGroup(next: UsageGroup): void {
    group = next;
    localStorage.setItem("usage.group", next);
  }

  const bucketOptions = $derived(bucketsFor(window_).map(value => ({ value, label: BUCKET_LABEL[value] })));
  const plotWidth = $derived(Math.max(0, chartWidth - PLOT.left - PLOT.right));
  const chart = $derived(series && plotWidth > 0 ? layout(series, plotWidth, PLOT.height, clock.now) : null);
  const ingest = $derived(summary ? ingestLine(summary.ingest, clock.now) : null);
  const rows = $derived([...(models ?? [])].sort((a, b) => b.tokens.total - a.tokens.total));
  const stats = $derived(summary ? [
    { label: "Tokens / s", note: "last 60 s", rate: summary.perSecond, spark: summary.sparkSeconds },
    { label: "Tokens / min", note: "last 60 min", rate: summary.perMinute, spark: summary.sparkMinutes },
    { label: "Tokens / day", note: "last 24 h", rate: summary.perDay, spark: null },
  ] : []);

  function onMove(event: PointerEvent): void {
    if (!chart) return;
    const rect = event.currentTarget instanceof Element ? event.currentTarget.getBoundingClientRect() : null;
    if (!rect) return;
    const px = event.clientX - rect.left - PLOT.left;
    const bar = barAt(chart.bars, px);
    hover = bar ? { bar, px: px + PLOT.left } : null;
  }
  const keyIndex = (key: string): number => chart ? Math.max(0, chart.keys.indexOf(key)) % 9 : 0;
</script>

<section class="usage" aria-label="Usage">
  <header class="bar"><h3>Usage</h3><span class="faint">All agents on this Mac</span></header>

  {#if !summary && feedDown}
    <div class="empty"><div class="error"><Icon name="alert" size={16} /> Usage feed unavailable. Reconnecting.</div></div>
  {:else if !summary}
    <div class="empty muted"><span class="spinner"></span> Loading usage</div>
  {:else}
    <div class="headline" aria-live="off">
      {#each stats as stat (stat.label)}
        <div class="stat">
          <div class="stat-label">{stat.label}</div>
          <div class="stat-value tabular" title={fullTokens(stat.rate.total)}>{tokens(stat.rate.total)}</div>
          <div class="stat-sub tabular">out {tokens(stat.rate.output)} · {stat.note}</div>
          {#if stat.spark}
            <svg class="spark" viewBox="0 0 120 28" preserveAspectRatio="none" aria-hidden="true"><path d={sparkPath(stat.spark, 120, 28)} /></svg>
          {/if}
        </div>
      {/each}
      <div class="stat">
        <div class="stat-label">Cost today</div>
        <div class="stat-value tabular">{cost(summary.costToday)}</div>
        <div class="stat-sub">since midnight</div>
      </div>
    </div>

    <div class="controls">
      <div class="segmented" role="radiogroup" aria-label="Window">
        {#each WINDOWS as id (id)}<button type="button" role="radio" aria-checked={window_ === id} class:on={window_ === id} onclick={() => pickWindow(id)}>{WINDOW_LABEL[id]}</button>{/each}
      </div>
      {#if bucketOptions.length > 1}
        <Select label="Bucket" options={bucketOptions} value={bucket} resetValue="" width={160} onchange={value => { bucket = value as UsageBucket; }} />
      {/if}
      <div class="spacer"></div>
      <div class="segmented" role="radiogroup" aria-label="Group">
        {#each GROUPS as entry (entry.id)}<button type="button" role="radio" aria-checked={group === entry.id} class:on={group === entry.id} onclick={() => pickGroup(entry.id)}>{entry.label}</button>{/each}
      </div>
    </div>

    <div class="chart" bind:clientWidth={chartWidth}>
      {#if chart}
        <svg class="plot" width={chartWidth} height={PLOT.top + PLOT.height + PLOT.bottom} onpointermove={onMove} onpointerleave={() => { hover = null; }} role="img" aria-label="Tokens over time">
          <g transform="translate({PLOT.left} {PLOT.top})">
            {#each chart.grid as line (line.y)}
              <line class="grid" x1="0" x2={plotWidth} y1={line.y} y2={line.y} />
              <text class="axis" x="-6" y={line.y + 3.5} text-anchor="end">{line.label}</text>
            {/each}
            <line class="base" x1="0" x2={plotWidth} y1={PLOT.height} y2={PLOT.height} />
            {#each chart.bars as bar (bar.t)}
              {#each bar.stack as part (part.key)}
                <rect x={bar.x} y={part.y} width={bar.w} height={part.h} class="k{series?.group === "none" ? 0 : keyIndex(part.key)}" class:dim={hover !== null && hover.bar !== bar} />
              {/each}
            {/each}
            {#each chart.ticks as tick, index (index)}
              <text class="axis" x={tick.x} y={PLOT.height + 15} text-anchor={index === 0 ? "start" : index === chart.ticks.length - 1 ? "end" : "middle"}>{tick.label}</text>
            {/each}
          </g>
        </svg>
        {#if hover && series}
          <div class="hover panel-surface" class:flip={hover.px > chartWidth / 2} style="left: {hover.px}px">
            <div class="hover-title">{bucketTitle(hover.bar.t, series.bucket)}</div>
            <div class="hover-row"><span>Tokens</span><span class="tabular">{fullTokens(hover.bar.total)}</span></div>
            <div class="hover-row"><span>Calls</span><span class="tabular">{fullTokens(hover.bar.calls)}</span></div>
            <div class="hover-row"><span>Cost</span><span class="tabular">{cost(hover.bar.costUsd)}</span></div>
            {#if series.group !== "none"}
              {#each [...hover.bar.stack].reverse() as part (part.key)}
                <div class="hover-row key"><span><i class="swatch k{keyIndex(part.key)}"></i>{series.group === "model" ? modelLabel(part.key) : part.key}</span><span class="tabular">{fullTokens(part.value)}</span></div>
              {/each}
            {/if}
          </div>
        {/if}
        {#if chart.keys.length && series?.group !== "none"}
          <div class="legend">
            {#each chart.keys as key, index (key)}<span class="legend-item"><i class="swatch k{index % 9}"></i>{series?.group === "model" ? modelLabel(key) : key}</span>{/each}
          </div>
        {/if}
        {#if !chart.bars.length}<div class="chart-empty faint">No calls in this window</div>{/if}
      {:else if error}
        <div class="empty"><div class="error"><Icon name="alert" size={16} /> {error}</div><button class="button small" onclick={() => void load()}>Retry</button></div>
      {:else}
        <div class="empty muted"><span class="spinner"></span></div>
      {/if}
    </div>

    {#if rows.length}
      <table class="models">
        <thead><tr><th>Source</th><th>Model</th><th class="num">Calls</th><th class="num">Tokens</th><th class="num">Cost</th><th class="num" title="Median output tokens per second per call">Out tok/s</th></tr></thead>
        <tbody>
          {#each rows as row (row.source + " " + row.model)}
            <tr>
              <td class="muted">{row.source}</td>
              <td class="model" title={row.model}>{modelLabel(row.model)}</td>
              <td class="num tabular">{fullTokens(row.calls)}</td>
              <td class="num tabular" title="in {fullTokens(row.tokens.input)} · out {fullTokens(row.tokens.output)} · cache read {fullTokens(row.tokens.cacheRead)} · cache write {fullTokens(row.tokens.cacheWrite)}">{tokens(row.tokens.total)}</td>
              <td class="num tabular">{cost(row.costUsd)}</td>
              <td class="num tabular">{tps(row.medianOutputTps)}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    {/if}

    {#if ingest}
      <p class="ingest {ingest.tone}">
        {#if ingest.tone === "busy"}<span class="spinner tiny"></span>{:else if ingest.tone === "error"}<Icon name="alert" size={13} />{/if}
        <span use:tooltip={sourceCounts(summary.ingest)}>{ingest.text}</span>
        {#if feedDown}<span class="faint">· feed reconnecting</span>{/if}
      </p>
    {/if}
  {/if}
</section>

<style>
  .usage { display: flex; flex-direction: column; gap: 14px; padding: 12px 18px 18px; font-size: 13px; container-type: inline-size;
    --k0: var(--accent); --k1: light-dark(#0f9d8a, #2fc4ad); --k2: light-dark(#7c5cd6, #a68bff); --k3: light-dark(#d97706, #f5b544); --k4: light-dark(#db4f7f, #f279a3);
    --k5: light-dark(#4f7fdb, #86a8f5); --k6: light-dark(#5f9e2e, #8fd24f); --k7: light-dark(#c2612e, #f08a52); --k8: light-dark(#8a919c, #6a7180); }
  .bar { display: flex; align-items: baseline; gap: 10px; border-bottom: 1px solid var(--border); margin: 0 -18px; padding: 0 18px 8px; }
  h3 { margin: 0; font-size: 13px; font-weight: 600; }
  .headline { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; }
  @container (width < 480px) { .headline { grid-template-columns: 1fr 1fr; } }
  .stat { position: relative; display: flex; flex-direction: column; gap: 2px; min-width: 0; padding: 10px 12px 8px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--bg-elevated); overflow: hidden; }
  .stat-label { font-size: 12px; color: var(--text-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .stat-value { font-size: 24px; font-weight: 600; line-height: 1.15; letter-spacing: -0.02em; }
  .stat-sub { font-size: 12px; color: var(--text-faint); }
  .spark { width: 100%; height: 28px; margin-top: 4px; }
  .spark path { fill: none; stroke: var(--accent); stroke-width: 1.5; vector-effect: non-scaling-stroke; }
  .controls { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
  .spacer { flex: 1; }
  .chart { position: relative; min-height: 222px; border: 1px solid var(--border); border-radius: var(--radius); padding: 2px 0 4px; }
  .plot { display: block; touch-action: none; }
  .grid { stroke: var(--border); }
  .base { stroke: var(--border-strong); }
  .axis { fill: var(--text-faint); font-size: 10.5px; font-variant-numeric: tabular-nums; }
  rect { transition: opacity 0.12s; }
  rect.dim { opacity: 0.45; }
  .k0 { fill: var(--k0); background: var(--k0); } .k1 { fill: var(--k1); background: var(--k1); } .k2 { fill: var(--k2); background: var(--k2); }
  .k3 { fill: var(--k3); background: var(--k3); } .k4 { fill: var(--k4); background: var(--k4); } .k5 { fill: var(--k5); background: var(--k5); }
  .k6 { fill: var(--k6); background: var(--k6); } .k7 { fill: var(--k7); background: var(--k7); } .k8 { fill: var(--k8); background: var(--k8); }
  .hover { position: absolute; top: 8px; width: 220px; padding: 6px 10px; margin-left: 14px; font-size: 12px; line-height: 1.5; pointer-events: none; }
  .hover.flip { margin-left: -14px; transform: translateX(-100%); }
  .hover-title { font-weight: 600; margin-bottom: 2px; }
  .hover-row { display: flex; justify-content: space-between; gap: 10px; color: var(--text-muted); }
  .hover-row.key { color: var(--text); }
  .hover-row span:first-child { display: inline-flex; align-items: center; gap: 6px; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .swatch { display: inline-block; flex: none; width: 8px; height: 8px; border-radius: 2px; }
  .legend { display: flex; flex-wrap: wrap; gap: 4px 12px; padding: 2px 12px 4px; font-size: 11.5px; color: var(--text-muted); }
  .legend-item { display: inline-flex; align-items: center; gap: 5px; }
  .chart-empty { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; pointer-events: none; }
  .models { width: 100%; border-collapse: collapse; font-size: 12.5px; }
  .models th { padding: 0 8px 6px; text-align: left; font-size: 11px; font-weight: 500; color: var(--text-faint); white-space: nowrap; }
  .models td { padding: 6px 8px; border-top: 1px solid var(--border); white-space: nowrap; }
  .models .num { text-align: right; }
  .models .model { max-width: 240px; overflow: hidden; text-overflow: ellipsis; }
  .ingest { display: flex; align-items: center; gap: 6px; margin: 0; font-size: 12px; color: var(--text-faint); }
  .ingest.error { color: var(--danger); }
  .ingest > span:nth-child(1 of span) { cursor: default; }
  .empty { display: flex; align-items: center; justify-content: center; gap: 10px; padding: 32px 0; }
  .error { display: flex; align-items: center; gap: 8px; color: var(--danger); }
</style>
