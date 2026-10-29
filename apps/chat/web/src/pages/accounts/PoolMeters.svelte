<script lang="ts">
  import type { AccountsView } from "$lib/api/shared/types.ts";
  import { Meter } from "$lib/ui";
  import { caps, summary, WINDOW_LABEL } from "../usage/pool";
  import { PROVIDER_LABEL, span } from "./model";

  /** The whole pool per provider: the share spent in the 5h and week windows, and how many accounts take a new thread now. */
  let { view, now }: { view: AccountsView; now: number } = $props();

  const rows = $derived(view.providers.filter(provider => provider.rows.length).map(provider => ({ provider, pool: summary(provider, caps(view)) })));

  /** The next time a blocked account of this provider frees: its cooldown or 429 ends. */
  function nextFree(provider: AccountsView["providers"][number]): number | null {
    const times = provider.rows.filter(row => !row.disabled && !row.usable)
      .flatMap(row => [row.cooldownUntil, row.limitedUntil]).filter((at): at is number => at !== null && at > now);
    return times.length ? Math.min(...times) : null;
  }
</script>

{#if rows.length}
  <div class="meters" data-testid="pool-meters">
    {#each rows as { provider, pool } (provider.provider)}
      {@const label = PROVIDER_LABEL[provider.provider]}
      {@const free = nextFree(provider)}
      <div class="pool" class:empty={pool.usable === 0} data-testid="pool-meter-{provider.provider}"
        title="{label} pool. {pool.usable} of {pool.total} accounts take a new thread now. A blocked account counts as full.{free ? ` The next blocked account frees in ${span(free - now)}.` : ''}">
        <span class="name">{label}</span>
        {#each pool.meters as meter (meter.key)}
          <Meter percent={meter.pct} label={WINDOW_LABEL[meter.key]} />
        {/each}
        <span class="usable"><strong>{pool.usable}/{pool.total}</strong> take a new thread</span>
      </div>
    {/each}
  </div>
{/if}

<style>
  .meters { display: grid; grid-template-columns: repeat(auto-fit, minmax(18rem, 1fr)); gap: var(--space-3); }
  .pool {
    display: grid; grid-template-columns: 4rem repeat(2, minmax(0, 1fr)); align-items: center; gap: var(--space-2) var(--space-4);
    padding: var(--space-3) var(--space-4); border-radius: var(--radius-container); background: var(--surface-inset);
  }
  .name { grid-row: span 2; color: var(--text-standard); font: var(--text-label-sm); letter-spacing: var(--tracking-label-sm); }
  .usable { grid-column: 2 / -1; color: var(--text-subtle); font: var(--text-caption); letter-spacing: var(--tracking-caption); font-variant-numeric: tabular-nums; }
  .usable strong { color: var(--text-standard); font-weight: 500; }
  .empty .usable strong { color: var(--border-danger); }
</style>
