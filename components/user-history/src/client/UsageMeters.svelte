<script lang="ts">
  import { meterTone, windowLabel } from "./accounts.ts";
  import type { PoolWindow } from "../shared/types.ts";

  /**
   * One meter per usage window in one recipe (the Virev ProgressBar): label left, percent right, a fully rounded 4 px track, ink fill that turns
   * warning at 70% and danger at 90%. A per-model window (Fable) shows only when `model` (the current model id and name) names it.
   */
  let { windows, model }: { windows: readonly PoolWindow[]; model?: string | undefined } = $props();
  const shown = $derived(windows.filter(window => window.kind !== "model" || (model ?? "").toLowerCase().includes(windowLabel(window).toLowerCase())));
</script>

{#each shown as window (window.label)}
  <span class="meter {meterTone(window.pct)}">
    <span class="figure"><span class="meter-label">{windowLabel(window)}</span><span class="pct">{Math.round(window.pct)}%</span></span>
    <span class="track"><span class="fill" style:width="{Math.max(0, Math.min(100, window.pct))}%"></span></span>
  </span>
{/each}

<style>
  .meter { display: inline-flex; flex-direction: column; gap: 3px; flex: none; width: 56px; font-size: 11px; font-weight: 500; line-height: 1; font-variant-numeric: tabular-nums; }
  .figure { display: flex; justify-content: space-between; gap: 4px; }
  .meter-label { color: var(--text-faint); }
  .pct { color: var(--text-muted); }
  .track { display: block; height: 4px; border-radius: 999px; background: var(--bg-active); overflow: hidden; }
  .fill { display: block; height: 100%; border-radius: 999px; background: var(--text-muted); transition: width 0.3s ease-out; }
  .mid .fill { background: var(--warning); }
  .high .fill { background: var(--danger); }
  .mid .pct { color: var(--warning); }
  .high .pct { color: var(--danger); }
</style>
