<script lang="ts">
  import type { AccountsView } from "$lib/api/shared/types.ts";
  import { Meter, tooltip } from "$lib/ui";
  import { caps, summary, WINDOW_LABEL } from "../usage/pool";
  import { PROVIDER_LABEL, span } from "./model";

  /** One provider's pool on one line: how many accounts take a new thread now, and the share spent in the 5h and week windows. */
  let { view, provider, now }: { view: AccountsView; provider: AccountsView["providers"][number]; now: number } = $props();

  const pool = $derived(summary(provider, caps(view)));

  /** The next time a blocked account of this provider frees: its cooldown or 429 ends. */
  const nextFree = $derived.by((): number | null => {
    const times = provider.rows.filter(row => !row.disabled && !row.usable)
      .flatMap(row => [row.cooldownUntil, row.limitedUntil]).filter((at): at is number => at !== null && at > now);
    return times.length ? Math.min(...times) : null;
  });
  const hint = $derived(`${PROVIDER_LABEL[provider.provider]} pool. A blocked account counts as full.${nextFree ? ` The next blocked account frees in ${span(nextFree - now)}.` : ""}`);
</script>

{#if provider.rows.length}
  <div class="pool" class:empty={pool.usable === 0} data-testid="pool-meter-{provider.provider}">
    <span class="usable" use:tooltip={hint}><strong>{pool.usable} of {pool.total}</strong> take a new thread</span>
    {#each pool.meters as meter (meter.key)}
      <span class="window">
        <span class="key">{WINDOW_LABEL[meter.key]}</span>
        <Meter percent={meter.pct} compact title="{WINDOW_LABEL[meter.key]}: {Math.round(meter.pct)}% of the pool used" />
        <span class="pct">{Math.round(meter.pct)}%</span>
      </span>
    {/each}
  </div>
{/if}

<style>
  .pool { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-1) var(--space-6, 24px); color: var(--text-subtle); font: var(--text-body-sm); font-variant-numeric: tabular-nums; }
  .usable { cursor: default; }
  .usable strong { color: var(--text-standard); font-weight: 500; }
  .empty .usable strong { color: var(--text-danger); }
  .window { display: inline-grid; grid-template-columns: auto 5rem auto; align-items: center; gap: var(--space-2); }
  .pct { color: var(--text-standard); }
</style>
