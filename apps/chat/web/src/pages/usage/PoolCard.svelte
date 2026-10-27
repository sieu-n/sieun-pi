<script lang="ts">
  import type { AccountsView } from "$lib/api";
  import { CardGroup, Meter } from "$lib/ui";
  import { accountState, caps, kindsOf, PROVIDER_LABEL, summary, WINDOW_LABEL, windowName, type PoolProvider, type WindowKind } from "./pool";

  /** One provider's account pool: the pool's spent share per window, then each account with its own windows and state. */
  let { provider, view }: { provider: PoolProvider; view: AccountsView } = $props();

  const label = $derived(PROVIDER_LABEL[provider.provider] ?? provider.provider);
  const pool = $derived(summary(provider, caps(view)));
  const kinds = $derived(kindsOf(provider));
  const now = $derived(Date.parse(view.checkedAt) || Date.now());
  const POOL_KEY: Partial<Record<WindowKind, "5h" | "week">> = { session: "5h", weekly: "week" };
  /** Usable accounts first, then pi-pool's own order, with turned-off accounts last. */
  const rows = $derived([...provider.rows].sort((a, b) => Number(a.disabled) - Number(b.disabled) || Number(b.usable) - Number(a.usable)));
</script>

<CardGroup title="{label} accounts" description="{pool.usable} of {pool.total} take a new thread now. A blocked account counts as full in the pool meters.">
  <div class="rows" style:--meters={kinds.length}>
    <div class="row pool" data-testid="pool-{provider.provider}">
      <span class="name">{label} pool</span>
      {#each kinds as kind (kind)}
        {@const key = POOL_KEY[kind]}
        {@const meter = key ? pool.meters.find(entry => entry.key === key) : undefined}
        {#if meter && key}
          <Meter percent={meter.pct} label={WINDOW_LABEL[key]} title="{WINDOW_LABEL[key]}: {Math.round(meter.pct)}% of the pool used, blocked accounts as full" />
        {:else}
          <span></span>
        {/if}
      {/each}
      <span class="usable" class:empty={pool.usable === 0}>{pool.usable}/{pool.total}</span>
    </div>
    {#each rows as row (row.id)}
      {@const state = accountState(row, now)}
      <div class="row" class:off={row.disabled} data-testid="account-{row.id}">
        <span class="account">
          <span class="name" title={row.email}>{row.label}</span>
          <span class="state {state.tone}">{[row.tier, state.text].filter(Boolean).join(" · ")}</span>
        </span>
        {#each kinds as kind (kind)}
          {@const window = row.windows.find(entry => entry.kind === kind)}
          {#if window}<Meter percent={window.pct} label={windowName(window)} />{:else}<span></span>{/if}
        {/each}
        <span class="usable"></span>
      </div>
    {/each}
  </div>
</CardGroup>

<style>
  .rows { display: flex; flex-direction: column; }
  .rows > * + * { border-top: 1px solid var(--border-standard); }
  .row { display: grid; grid-template-columns: minmax(0, 1.4fr) repeat(var(--meters), minmax(5rem, 1fr)) 3rem; align-items: center; gap: var(--space-6); padding: var(--space-3) var(--space-4); }
  .pool .name { font: var(--text-label-sm); letter-spacing: var(--tracking-label-sm); }
  .account { display: flex; min-width: 0; flex-direction: column; }
  .name { overflow: hidden; color: var(--text-standard); font: var(--text-body); text-overflow: ellipsis; white-space: nowrap; }
  .state { overflow: hidden; color: var(--text-subtle); font: var(--text-caption); letter-spacing: var(--tracking-caption); text-overflow: ellipsis; white-space: nowrap; }
  .state.warn { color: var(--text-standard); }
  .state.danger { color: var(--border-danger); }
  .off { opacity: 0.6; }
  .usable { color: var(--text-metadata); font: var(--text-caption); text-align: right; font-variant-numeric: tabular-nums; }
  .usable.empty { color: var(--border-danger); font-weight: 500; }
</style>
