<script lang="ts">
  import type { UsageBucket } from "$lib/api";
  import { BUCKET_MS } from "$lib/api/shared/usage-range";
  import { Button, Popover } from "$lib/ui";
  import { bucketName, bucketTick, full, onStride, type ChartFormat, type TipRow } from "./format";
  import { axis, type Series, type UsageBucketSum } from "./stats";

  /**
   * One value per minute, hour or day, stacked by model, as Prime's chat Usage chart groups it: cost, tokens or tokens per second, as the
   * caller's `cells` and `format` say. A hover shows the bucket's split and sum, then the caller's own rows (`tip`), and every bucket that
   * ran a call is in a table one click away, each figure exact (c191), with the range's total under it when `total` is given.
   */
  let { buckets, series, bucket, cells, format, total, tip }: {
    buckets: readonly UsageBucketSum[];
    series: readonly Series[];
    bucket: UsageBucket;
    /** Each bucket's value per series, in series order. */
    cells: readonly (readonly number[])[];
    format: ChartFormat;
    /** The line over the plot; null hides it and the table's total row, as for a rate, whose sum means nothing. */
    total: { text: string; title: string } | null;
    /** More tip rows for the bucket at this index, muted, under its split and sum. */
    tip?: (index: number) => readonly TipRow[];
  } = $props();

  const HEIGHT = 200;
  const AXIS = 44;
  const LABELS = 20;
  const BAR = 24;
  const GAP = 2;
  const RADIUS = 4;
  /** The least room an axis label takes, in px. */
  const LABEL_PX = 72;
  /** Label strides in buckets, so labels land on round local times: 15 min, 6 h, 7 days. */
  const STRIDES: Record<UsageBucket, readonly number[]> = {
    minute: [1, 5, 10, 15, 30, 60, 120, 180, 360, 720, 1440],
    hour: [1, 2, 3, 6, 12, 24, 48, 72, 168, 336],
    day: [1, 2, 7, 14, 30],
  };
  const UNIT: Record<UsageBucket, string> = { minute: "minute", hour: "hour", day: "day" };

  let width = $state(0);
  let plotEl = $state<HTMLElement | null>(null);
  let hovered = $state<number | null>(null);
  let figures = $state(false);

  const totals = $derived(cells.map(row => row.reduce((sum, value) => sum + value, 0)));
  const scale = $derived(axis(Math.max(0, ...totals)));
  const plotTop = 8;
  const plotBottom = HEIGHT - LABELS;
  const y = (value: number) => plotBottom - (value / scale.top) * (plotBottom - plotTop);
  const step = $derived(buckets.length ? Math.max(0, width - AXIS) / buckets.length : 0);
  const bar = $derived(Math.max(1, Math.min(BAR, step > 4 ? step * 0.75 : step)));
  const left = (index: number) => AXIS + step * index + (step - bar) / 2;
  const stride = $derived.by(() => {
    const room = Math.max(2, Math.floor(Math.max(0, width - AXIS) / LABEL_PX));
    const options = STRIDES[bucket];
    return options.find(option => buckets.length / option <= room) ?? options[options.length - 1]!;
  });
  const labelled = (start: number) => onStride(start, BUCKET_MS[bucket], stride);
  const anchorAt = (x: number) => (x < AXIS + LABEL_PX / 2 ? "start" : x > width - LABEL_PX / 2 ? "end" : "middle");
  const stacked = $derived(series.length > 1);
  const used = $derived(buckets.map((entry, index) => ({ entry, index })).filter(({ entry }) => entry.turns > 0));
  const sum = $derived(totals.reduce((all, value) => all + value, 0));

  /** A bar segment, its top corners rounded when it ends the stack. */
  function segment(x: number, top: number, w: number, h: number, round: boolean): string {
    const r = round ? Math.min(RADIUS, h, w / 2) : 0;
    return `M${x},${top + h}V${top + r}Q${x},${top} ${x + r},${top}H${x + w - r}Q${x + w},${top} ${x + w},${top + r}V${top + h}Z`;
  }
  function stack(index: number): { key: string; d: string; color: string }[] {
    const row = cells[index] ?? [];
    const last = row.reduce((found, value, line) => (value > 0 ? line : found), -1);
    const gap = bar > 4 ? GAP : 0;
    let base = y(0);
    const parts: { key: string; d: string; color: string }[] = [];
    row.forEach((value, line) => {
      if (value <= 0) return;
      const top = y(value) - y(0) + base;
      const h = Math.max(1, base - top - (line < last ? gap : 0));
      parts.push({ key: series[line]!.key, d: segment(left(index), base - h, bar, h, line === last && bar > 4), color: series[line]!.color });
      base = top;
    });
    return parts;
  }

  /** The bucket under the pointer, from its x in the plot: one hit area serves 1,440 minute bars as well as 7 days. */
  function move(event: PointerEvent): void {
    if (!step || !plotEl) return;
    const rect = plotEl.getBoundingClientRect();
    const zoom = plotEl.offsetWidth ? rect.width / plotEl.offsetWidth : 1;
    const index = Math.floor((event.clientX - rect.left) / zoom / step - AXIS / step);
    hovered = index >= 0 && index < buckets.length ? index : null;
  }
  let cursor = $state<HTMLElement | null>(null);
  const tipOf = (value: number) => (format.tip ?? format.short)(value);
</script>

<div class="chart">
  <div class="legend-row">
    {#if stacked}
      <ul class="legend" aria-label="Models">
        {#each series as line (line.key)}<li><span class="swatch" style:background={line.color}></span>{line.label}</li>{/each}
      </ul>
    {/if}
    {#if total}<p class="sum" data-testid="usage-chart-total" title={total.title}>{total.text}</p>{/if}
  </div>
  <div class="plot" bind:this={plotEl} bind:clientWidth={width} style:height="{HEIGHT}px">
    {#if width > 0}
      <svg {width} height={HEIGHT} role="img" aria-label="{format.label} per {UNIT[bucket]}">
        {#each scale.ticks as value (value)}
          <line x1={AXIS} x2={width} y1={y(value)} y2={y(value)} class="grid" />
          <text x={AXIS - 8} y={y(value)} dy="0.32em" text-anchor="end" class="tick">{format.tick(value)}</text>
        {/each}
        {#each buckets as entry, index (entry.start)}
          <g opacity={hovered === null || hovered === index ? 1 : 0.5}>
            {#each stack(index) as part (part.key)}<path d={part.d} fill={part.color} />{/each}
          </g>
          {#if labelled(entry.start)}
            {@const x = left(index) + bar / 2}
            <line x1={x} x2={x} y1={plotBottom} y2={plotBottom + 4} class="mark" />
            <text {x} y={HEIGHT - 4} text-anchor={anchorAt(x)} class="tick">{bucketTick(entry.start, bucket)}</text>
          {/if}
        {/each}
      </svg>
      <div
        class="hit"
        aria-hidden="true"
        data-testid="usage-chart-hit"
        style:left="{AXIS}px"
        style:height="{plotBottom}px"
        onpointermove={move}
        onpointerleave={() => (hovered = null)}
      ></div>
      {#if hovered !== null}
        <!-- The tip's anchor: the hovered bar's column from the plot's top, so the tip sits beside the bar and never covers it. -->
        <div class="cursor" bind:this={cursor} aria-hidden="true" style:left="{left(hovered)}px" style:width="{bar}px" style:top="{plotTop}px"></div>
      {/if}
    {/if}
  </div>
  {#key hovered}
  <Popover open={hovered !== null && cursor !== null} anchor={cursor} placement="right-start" gap={12} surface="solid" autofocus={false} role="tooltip" padding={10} class="usage-tip" onclose={() => (hovered = null)}>
    {#if hovered !== null && buckets[hovered]}
      {@const entry = buckets[hovered]!}
      <span class="tip" data-testid="usage-chart-tip">
        <span class="tip-title">{bucketName(entry.start, bucket)}</span>
        {#if stacked}
          {#each series as line, position (line.key)}
            {@const value = cells[hovered]?.[position] ?? 0}
            <span class="tip-row"><span class="swatch" style:background={line.color}></span>{line.label}<span class="num" title={format.exact(value)}>{tipOf(value)}</span></span>
          {/each}
        {/if}
        <span class="tip-row strong">{stacked ? "Total" : format.label}<span class="num" title={format.exact(totals[hovered] ?? 0)}>{tipOf(totals[hovered] ?? 0)}</span></span>
        {#each tip?.(hovered) ?? [] as row (row.label)}
          <span class="tip-row muted">{row.label}<span class="num" title={row.title}>{row.value}</span></span>
        {/each}
      </span>
    {/if}
  </Popover>
  {/key}
  <div class="toggle">
    <Button variant="plain" size="sm" trailingIcon={figures ? "chevron-up" : "chevron-down"} aria-expanded={figures} onclick={() => (figures = !figures)}>
      {figures ? `Hide figures per ${UNIT[bucket]}` : `Show figures per ${UNIT[bucket]}`}
    </Button>
  </div>
  <table class={figures ? "figures" : "sr-only"} data-testid="usage-figures">
    <caption class="sr-only">{format.label} per {UNIT[bucket]}, for each {UNIT[bucket]} that ran a model call</caption>
    <thead>
      <tr>
        <th scope="col">{UNIT[bucket][0]!.toUpperCase()}{UNIT[bucket].slice(1)}</th>
        {#if stacked}{#each series as line (line.key)}<th scope="col">{line.label}</th>{/each}{/if}
        <th scope="col">Turns</th>
        <th scope="col">{stacked ? "Total" : format.label}</th>
      </tr>
    </thead>
    <tbody>
      {#each used as { entry, index } (entry.start)}
        <tr>
          <th scope="row">{bucketName(entry.start, bucket)}</th>
          {#if stacked}{#each series as line, position (line.key)}<td>{format.exact(cells[index]?.[position] ?? 0)}</td>{/each}{/if}
          <td>{full(entry.turns)}</td>
          <td>{format.exact(totals[index] ?? 0)}</td>
        </tr>
      {/each}
    </tbody>
    {#if total}
      <tfoot>
        <tr>
          <th scope="row">Total</th>
          {#if stacked}{#each series as line, position (line.key)}<td>{format.exact(cells.reduce((all, row) => all + (row[position] ?? 0), 0))}</td>{/each}{/if}
          <td>{full(buckets.reduce((all, entry) => all + entry.turns, 0))}</td>
          <td data-testid="usage-figures-total">{format.exact(sum)}</td>
        </tr>
      </tfoot>
    {/if}
  </table>
</div>

<style>
  .chart { display: flex; flex-direction: column; gap: var(--space-3); }
  .legend-row { display: flex; flex-wrap: wrap; align-items: baseline; gap: var(--space-2) var(--space-4); }
  .legend { display: flex; flex-wrap: wrap; gap: var(--space-1) var(--space-4); margin: 0; padding: 0; list-style: none; color: var(--text-subtle); font: var(--text-caption); letter-spacing: var(--tracking-caption); }
  .legend li, .tip-row { display: inline-flex; align-items: center; gap: var(--space-2); }
  .sum { margin: 0 0 0 auto; color: var(--text-standard); font: var(--text-body); font-variant-numeric: tabular-nums; }
  .swatch { display: inline-block; width: 8px; height: 8px; border-radius: 2px; }
  .plot { position: relative; width: 100%; }
  svg { display: block; overflow: visible; }
  .grid { stroke: var(--border-standard); stroke-width: 1; }
  .mark { stroke: var(--border-standard); stroke-width: 1; }
  .tick { fill: var(--text-metadata); font: var(--text-caption); font-variant-numeric: tabular-nums; }
  .hit { position: absolute; top: 0; right: 0; touch-action: none; }
  .cursor { position: absolute; height: 1px; pointer-events: none; }
  .tip { display: flex; flex-direction: column; gap: var(--space-1); min-width: 180px; font: var(--text-caption); font-variant-numeric: tabular-nums; }
  .tip-title { color: var(--text-standard); font-weight: 500; }
  .tip-row.strong { color: var(--text-standard); }
  .tip-row.muted { color: var(--text-subtle); }
  .tip .num { margin-left: auto; padding-left: var(--space-4); }
  /* The tip sits over the plot, so it lets the pointer through: else it takes the hover from the bars it covers. */
  :global(.popover.usage-tip) { pointer-events: none; }
  .toggle { display: flex; }
  .figures { width: 100%; border-collapse: collapse; color: var(--text-subtle); font: var(--text-caption); letter-spacing: var(--tracking-caption); font-variant-numeric: tabular-nums; }
  .figures th, .figures td { padding: var(--space-1) var(--space-2); border-bottom: 1px solid var(--border-standard); text-align: right; }
  .figures th:first-child { text-align: left; }
  .figures thead th { color: var(--text-metadata); font-weight: 500; }
  .figures tbody th { font-weight: inherit; }
  .figures tfoot th, .figures tfoot td { color: var(--text-standard); font-weight: 500; border-bottom: 0; }
</style>
