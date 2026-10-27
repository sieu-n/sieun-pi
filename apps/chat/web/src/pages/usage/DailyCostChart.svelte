<script lang="ts">
  import { Button, Popover } from "$lib/ui";
  import { cost, day, exactCost } from "./format";
  import { axis, dayCells, type Series, type UsageDay } from "./stats";

  /** Cost per day, stacked by model, with each day's split on hover and every figure in a table one click away. */
  let { days, series }: { days: readonly UsageDay[]; series: readonly Series[] } = $props();

  const HEIGHT = 176;
  const AXIS = 40;
  const LABELS = 20;
  const BAR = 24;
  const GAP = 2;
  const RADIUS = 4;

  let width = $state(0);
  let hovered = $state<number | null>(null);
  let hitEl = $state<HTMLElement | null>(null);
  let figures = $state(false);

  const cells = $derived(dayCells(days, series));
  const totals = $derived(cells.map(row => row.reduce((sum, value) => sum + value, 0)));
  const scale = $derived(axis(Math.max(0, ...totals)));
  const plotTop = 8;
  const plotBottom = HEIGHT - LABELS;
  const y = (value: number) => plotBottom - (value / scale.top) * (plotBottom - plotTop);
  const step = $derived(days.length ? Math.max(0, width - AXIS) / days.length : 0);
  const bar = $derived(Math.max(1, Math.min(BAR, step * 0.75)));
  const left = (index: number) => AXIS + step * index + (step - bar) / 2;
  const every = $derived(Math.max(1, Math.ceil(days.length / Math.max(2, Math.floor(width / 72)))));
  const labelled = (index: number) => index === days.length - 1 || (days.length - 1 - index) % every === 0;
  const stacked = $derived(series.length > 1);

  /** A bar segment, its top corners rounded when it ends the stack. */
  function segment(x: number, top: number, w: number, h: number, round: boolean): string {
    const r = round ? Math.min(RADIUS, h, w / 2) : 0;
    return `M${x},${top + h}V${top + r}Q${x},${top} ${x + r},${top}H${x + w - r}Q${x + w},${top} ${x + w},${top + r}V${top + h}Z`;
  }
  function stack(index: number): { key: string; d: string; color: string }[] {
    const row = cells[index] ?? [];
    const last = row.reduce((found, value, line) => (value > 0 ? line : found), -1);
    let base = y(0);
    const parts: { key: string; d: string; color: string }[] = [];
    row.forEach((value, line) => {
      if (value <= 0) return;
      const top = y(value) - y(0) + base;
      const h = Math.max(1, base - top - (line < last ? GAP : 0));
      parts.push({ key: series[line]!.key, d: segment(left(index), base - h, bar, h, line === last), color: series[line]!.color });
      base = top;
    });
    return parts;
  }
  const tick = (value: number) => (value === 0 ? "$0" : `$${value < 1 ? value.toFixed(2).replace(/0$/, "") : value.toLocaleString("en-US")}`);
  function hover(index: number | null, element: HTMLElement | null = null): void {
    hovered = index;
    hitEl = element;
  }
</script>

<div class="chart">
  {#if stacked}
    <ul class="legend" aria-label="Models">
      {#each series as line (line.key)}<li><span class="swatch" style:background={line.color}></span>{line.label}</li>{/each}
    </ul>
  {/if}
  <div class="plot" bind:clientWidth={width} style:height="{HEIGHT}px">
    {#if width > 0}
      <svg {width} height={HEIGHT} role="img" aria-label="Daily cost">
        {#each scale.ticks as value (value)}
          <line x1={AXIS} x2={width} y1={y(value)} y2={y(value)} class="grid" />
          <text x={AXIS - 8} y={y(value)} dy="0.32em" text-anchor="end" class="tick">{tick(value)}</text>
        {/each}
        {#each days as entry, index (entry.start)}
          <g opacity={hovered === null || hovered === index ? 1 : 0.5}>
            {#each stack(index) as part (part.key)}<path d={part.d} fill={part.color} />{/each}
            {#if labelled(index)}
              <text x={left(index) + bar / 2} y={HEIGHT - 4} text-anchor={index === days.length - 1 ? "end" : "middle"} class="tick">{day(entry.start)}</text>
            {/if}
          </g>
        {/each}
      </svg>
      {#each days as entry, index (entry.start)}
        <div
          class="hit"
          aria-hidden="true"
          style:left="{AXIS + step * index}px"
          style:width="{step}px"
          style:height="{plotBottom}px"
          onpointerenter={event => hover(index, event.currentTarget)}
          onpointerleave={() => hover(null)}
        ></div>
      {/each}
    {/if}
  </div>
  <Popover open={hovered !== null && hitEl !== null} anchor={hitEl} placement="top" autofocus={false} role="tooltip" padding={10} onclose={() => hover(null)}>
    {#if hovered !== null}
      <span class="tip">
        <span>{day(days[hovered]!.start)}</span>
        {#if stacked}
          {#each series as line, position (line.key)}
            <span class="tip-row"><span class="swatch" style:background={line.color}></span>{line.label}<span class="num">{cost(cells[hovered]?.[position] ?? 0)}</span></span>
          {/each}
        {/if}
        <span class="tip-row">{stacked ? "Total" : "Cost"}<span class="num" title={exactCost(totals[hovered] ?? 0)}>{cost(totals[hovered] ?? 0)}</span></span>
      </span>
    {/if}
  </Popover>
  <div class="toggle">
    <Button variant="plain" size="sm" trailingIcon={figures ? "chevron-up" : "chevron-down"} aria-expanded={figures} onclick={() => (figures = !figures)}>
      {figures ? "Hide daily figures" : "Show daily figures"}
    </Button>
  </div>
  <table class={figures ? "figures" : "sr-only"}>
    <caption class="sr-only">Daily cost</caption>
    <thead>
      <tr>
        <th scope="col">Day</th>
        {#if stacked}{#each series as line (line.key)}<th scope="col">{line.label}</th>{/each}{/if}
        <th scope="col">{stacked ? "Total" : "Cost"}</th>
      </tr>
    </thead>
    <tbody>
      {#each days as entry, index (entry.start)}
        <tr>
          <th scope="row">{day(entry.start)}</th>
          {#if stacked}{#each series as line, position (line.key)}<td>{exactCost(cells[index]?.[position] ?? 0)}</td>{/each}{/if}
          <td>{exactCost(totals[index] ?? 0)}</td>
        </tr>
      {/each}
    </tbody>
  </table>
</div>

<style>
  .chart { display: flex; flex-direction: column; gap: var(--space-3); }
  .legend { display: flex; flex-wrap: wrap; gap: var(--space-1) var(--space-4); margin: 0; padding: 0; list-style: none; color: var(--text-subtle); font: var(--text-caption); letter-spacing: var(--tracking-caption); }
  .legend li, .tip-row { display: inline-flex; align-items: center; gap: var(--space-2); }
  .swatch { display: inline-block; width: 8px; height: 8px; border-radius: 2px; }
  .plot { position: relative; width: 100%; }
  svg { display: block; overflow: visible; }
  .grid { stroke: var(--border-standard); stroke-width: 1; }
  .tick { fill: var(--text-metadata); font: var(--text-caption); font-variant-numeric: tabular-nums; }
  .hit { position: absolute; top: 0; }
  .tip { display: flex; flex-direction: column; gap: var(--space-1); min-width: 160px; font: var(--text-caption); font-variant-numeric: tabular-nums; }
  .tip .num { margin-left: auto; padding-left: var(--space-4); }
  .toggle { display: flex; }
  .figures { width: 100%; border-collapse: collapse; color: var(--text-subtle); font: var(--text-caption); letter-spacing: var(--tracking-caption); font-variant-numeric: tabular-nums; }
  .figures th, .figures td { padding: var(--space-1) var(--space-2); border-bottom: 1px solid var(--border-standard); text-align: right; }
  .figures th:first-child { text-align: left; }
  .figures thead th { color: var(--text-metadata); font-weight: 500; }
  .figures tbody th { font-weight: inherit; }
</style>
