<script lang="ts">
  import { store } from "./store.svelte.ts";
  import { loadAccounts, PROVIDER_LABEL, reasonText, resolvedAccount, threadProvider } from "./accounts.ts";
  import { initial } from "./format.ts";
  import type { AccountsView } from "../shared/types.ts";
  import Meter from "./Meter.svelte";
  import Icon from "./Icon.svelte";

  let { threadId, compact = false }: { threadId: string | null; compact?: boolean } = $props();
  let view = $state<AccountsView | null>(null);
  let failed = $state(false);

  const modelProvider = $derived(threadId ? store.thread(threadId)?.state?.info.model?.provider : undefined);
  const provider = $derived(view ? threadProvider(view, modelProvider) : undefined);
  const account = $derived(provider ? resolvedAccount(provider) : undefined);
  const unresolved = $derived(view !== null && provider !== undefined && !provider.resolution?.email);
  const label = $derived(account?.email ?? provider?.resolution?.email ?? (provider ? `No ${PROVIDER_LABEL[provider.provider]} account` : "Pool"));
  const why = $derived(provider ? reasonText(provider.resolution?.reason ?? null) : null);
  const title = $derived(provider?.resolution?.email ? `${provider.resolution.email}${why ? " because " + why : ""}. Open accounts.` : "Open accounts");

  $effect(() => {
    const id = threadId;
    let cancelled = false;
    failed = false;
    loadAccounts(id).then(result => { if (!cancelled) view = result; }, () => { if (!cancelled) failed = true; });
    return () => { cancelled = true; };
  });
</script>

<button class="chip-button" class:compact class:unresolved {title} onclick={() => { store.drawer = "accounts"; }}>
  {#if account}
    <span class="avatar">{initial(account.email)}</span>
  {:else}
    <span class="avatar faint"><Icon name="account" size={15} /></span>
  {/if}
  <span class="text">
    <span class="email" class:warning={unresolved}>{failed ? "Accounts unavailable" : view ? label : "Loading accounts"}</span>
    {#if account}
      <span class="meters">
        {#if account.plan}<span class="plan">{account.plan}</span>{/if}
        <Meter value={account.session_pct} label="5h" size="tiny" />
        <Meter value={account.weekly_pct} label="Weekly" size="tiny" />
      </span>
    {:else if provider?.resolution?.email && why}
      <span class="meters"><span class="plan">{why}</span></span>
    {:else if provider?.resolution?.pinned && unresolved}
      <span class="meters"><span class="plan">pinned account unavailable</span></span>
    {/if}
  </span>
</button>

<style>
  .chip-button { display: flex; align-items: center; gap: 10px; width: 100%; padding: 6px 8px; border-radius: var(--radius-small); text-align: left; min-width: 0; }
  .chip-button:hover { background: var(--bg-hover); }
  .avatar { display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; border-radius: 50%; background: var(--accent-soft); color: var(--accent); font-size: 13px; font-weight: 600; flex: none; }
  .avatar.faint { background: var(--bg-active); color: var(--text-muted); }
  .text { display: flex; flex-direction: column; min-width: 0; line-height: 1.3; }
  .email { font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .meters { display: flex; align-items: center; gap: 8px; font-size: 11px; color: var(--text-faint); }
  .plan { text-transform: none; }
  .email.warning { color: var(--warning); }
  .compact { width: auto; padding: 2px 6px; gap: 6px; }
  .compact .avatar { width: 20px; height: 20px; font-size: 11px; }
  .compact .text { flex-direction: row; align-items: center; gap: 8px; }
  .compact .email { font-size: 12px; color: var(--text-muted); max-width: 180px; }
</style>
