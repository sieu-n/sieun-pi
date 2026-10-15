<script lang="ts">
  import type { TurnHour } from "../shared/types.ts";
  import { dayTicks, waitText } from "./agent-queue.ts";

  /** Two small bar charts over the same hours: turns finished per hour, and the median queued wait per hour. */
  let { hours }: { hours: TurnHour[] } = $props();

  const H = 44;
  const pad = (value: number): string => String(value).padStart(2, "0");
  const label = (at: number): string => {
    const date = new Date(at);
    return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:00`;
  };
  const maxDone = $derived(Math.max(1, ...hours.map(hour => hour.finished)));
  const maxWait = $derived(Math.max(1, ...hours.map(hour => hour.medianWaitS ?? 0)));
  const ticks = $derived(dayTicks(hours));
  const height = (value: number, max: number): number => value > 0 ? Math.max(1, (value / max) * H) : 0;
  const totalDone = $derived(hours.reduce((sum, hour) => sum + hour.finished, 0));
</script>

{#if hours.length}
  <div class="history">
    {#snippet chart(title: string, peak: string, values: Array<number>, max: number, tip: (hour: TurnHour) => string, tone: string)}
      <div class="row">
        <div class="head"><span>{title}</span><span class="peak">{peak}</span></div>
        <svg viewBox="0 0 {hours.length} {H}" preserveAspectRatio="none" role="img" aria-label={title}>
          {#each ticks as tick (tick.index)}<line class="day" x1={tick.index} x2={tick.index} y1="0" y2={H} vector-effect="non-scaling-stroke" />{/each}
          {#each hours as hour, i (hour.at)}
            <rect class={tone} x={i + 0.12} width="0.76" y={H - height(values[i] ?? 0, max)} height={height(values[i] ?? 0, max)}><title>{tip(hour)}</title></rect>
          {/each}
        </svg>
      </div>
    {/snippet}
    {@render chart("Turns finished per hour", `peak ${maxDone}`, hours.map(hour => hour.finished), maxDone,
      hour => `${label(hour.at)}: ${hour.finished} turns finished`, "done")}
    {@render chart("Median wait per hour", `peak ${waitText(maxWait)}`, hours.map(hour => hour.medianWaitS ?? 0), maxWait,
      hour => `${label(hour.at)}: ${hour.medianWaitS === null ? "no queued turns" : `median wait ${waitText(hour.medianWaitS)}`}`, "wait")}
    <div class="axis">
      {#each ticks as tick (tick.index)}<span style="left: {(tick.index / hours.length) * 100}%">{tick.label}</span>{/each}
    </div>
    <p class="foot">{totalDone.toLocaleString("en-US")} turns finished in the last {Math.round(hours.length / 24) || 1} {Math.round(hours.length / 24) > 1 ? "days" : "day"}.</p>
  </div>
{/if}

<style>
  .history { display: flex; flex-direction: column; gap: 6px; }
  .row { display: flex; flex-direction: column; gap: 2px; }
  .head { display: flex; justify-content: space-between; font-size: 12px; color: var(--text-muted); }
  .peak { font-variant-numeric: tabular-nums; color: var(--text-faint); }
  svg { width: 100%; height: 44px; display: block; border-bottom: 1px solid var(--border); }
  rect.done { fill: var(--accent); }
  rect.wait { fill: var(--warning); }
  rect:hover { opacity: 0.7; }
  line.day { stroke: var(--border-strong); stroke-width: 1; }
  .axis { position: relative; height: 14px; font-size: 11px; color: var(--text-faint); }
  .axis span { position: absolute; transform: translateX(2px); white-space: nowrap; font-variant-numeric: tabular-nums; }
  .foot { margin: 0; font-size: 12px; color: var(--text-muted); }
</style>
