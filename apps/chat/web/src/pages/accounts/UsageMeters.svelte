<script lang="ts">
  import type { PoolWindow } from "$lib/api/shared/types.ts";
  import Meter from "$lib/ui/Meter.svelte";
  import { resetText, shownWindows, windowLabel } from "./model";

  /**
   * One lib/ui Meter per usage window, amber at 70% and red at 90%. A per-model window such as Fable shows only when `model`, the thread's
   * model id and name, names it.
   */
  let { windows, model }: { windows: readonly PoolWindow[]; model?: string | null } = $props();
  const shown = $derived(shownWindows(windows, model));
</script>

{#each shown as window (window.label)}
  <span class="usage-meter" data-window={window.label}>
    <Meter percent={window.pct} label={windowLabel(window)} title={resetText(window) ?? undefined} />
  </span>
{/each}

<style>
  .usage-meter {
    display: inline-flex;
    flex-direction: column;
    flex: none;
    width: 72px;
  }
</style>
