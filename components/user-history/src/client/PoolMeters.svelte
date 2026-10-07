<script lang="ts">
  import { onMount } from "svelte";
  import { loadAccounts, meterTone, PROVIDER_LABEL, span } from "./accounts.ts";
  import { poolSummary } from "./pool-meter.ts";
  import { store } from "./store.svelte.ts";
  import type { AccountsView } from "../shared/types.ts";
  import ThroughputLine from "./ThroughputLine.svelte";

  /** The whole pool's spent share per provider, at the bottom of the sidebar. A click opens account settings. */
  let view = $state<AccountsView | null>(null);
  const rows = $derived((view?.providers ?? []).filter(provider => provider.rows.length).map(provider => ({ provider, summary: poolSummary(provider) })));

  function title(label: string, summary: ReturnType<typeof poolSummary>): string {
    return [`${label} pool: ${summary.usable} of ${summary.total} accounts can serve now.`,
      ...summary.meters.map(meter => `${meter.key === "week" ? "Week" : meter.key}: ${Math.round(meter.pct)}% of the pool used (blocked accounts count as full).`),
      summary.nextFree ? `Next blocked account frees in ${span(summary.nextFree - Date.now())}.` : "", "Open account settings"].filter(Boolean).join("\n");
  }

  onMount(() => {
    const load = (fresh: boolean) => { loadAccounts(null, { fresh }).then(result => { view = result; }, () => {}); };
    load(false);
    const timer = setInterval(() => load(true), 60_000);
    return () => clearInterval(timer);
  });
</script>

<div class="pool">
  <ThroughputLine />
  {#if rows.length}
    {#each rows as { provider, summary } (provider.provider)}
      {@const label = PROVIDER_LABEL[provider.provider]}
      <button type="button" class="line" class:empty={summary.usable === 0} title={title(label, summary)} onclick={() => { store.drawer = "accounts"; }}>
        <span class="name">{label}</span>
        {#if !summary.meters.some(meter => meter.key === "5h")}<span class="meter" aria-hidden="true"></span>{/if}
        {#each summary.meters as meter (meter.key)}
          <span class="meter {meterTone(meter.pct)}">
            <span class="figure"><span class="key">{meter.key === "week" ? "Week" : meter.key}</span><span class="pct">{Math.round(meter.pct)}%</span></span>
            <span class="track"><span class="fill" style:width="{Math.min(100, meter.pct)}%"></span></span>
          </span>
        {/each}
        <span class="usable">{summary.usable}/{summary.total}</span>
      </button>
    {/each}
  {/if}
</div>

<style>
  .pool { flex: none; display: flex; flex-direction: column; gap: 2px; padding: 6px 6px 8px; border-top: 1px solid var(--border); }
  .line { display: flex; align-items: center; gap: 10px; padding: 4px 6px; border-radius: var(--radius-small); font-size: 11px; line-height: 1; text-align: left; font-variant-numeric: tabular-nums; }
  .line:hover { background: var(--bg-hover); }
  .name { width: 42px; flex: none; font-weight: 600; color: var(--text-muted); }
  .meter { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; font-weight: 500; }
  .figure { display: flex; justify-content: space-between; gap: 4px; }
  .key { color: var(--text-faint); }
  .pct { color: var(--text-muted); }
  .track { display: block; height: 4px; border-radius: 999px; background: var(--bg-active); overflow: hidden; }
  .fill { display: block; height: 100%; border-radius: 999px; background: var(--text-muted); transition: width 0.3s ease-out; }
  .mid .fill { background: var(--warning); }
  .high .fill { background: var(--danger); }
  .mid .pct { color: var(--warning); }
  .high .pct { color: var(--danger); }
  .usable { flex: none; width: 26px; text-align: right; color: var(--text-faint); }
  .empty .usable { color: var(--danger); font-weight: 600; }
</style>
