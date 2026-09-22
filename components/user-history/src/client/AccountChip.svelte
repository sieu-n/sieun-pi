<script lang="ts">
  import { store } from "./store.svelte.ts";
  import { loadAccounts, PROVIDER_LABEL, reasonText, resolvedAccount, threadProvider } from "./accounts.ts";
  import type { AccountsView } from "../shared/types.ts";

  let { threadId, provider: providerId }: { threadId: string | null; provider?: string | undefined } = $props();
  let view = $state<AccountsView | null>(null);
  let failed = $state(false);

  const modelProvider = $derived(providerId ?? (threadId ? store.thread(threadId)?.state?.info.model?.provider : undefined));
  const provider = $derived(view ? threadProvider(view, modelProvider) : undefined);
  const account = $derived(provider ? resolvedAccount(provider) : undefined);
  const email = $derived(account?.email ?? provider?.resolution?.email ?? null);
  const name = $derived(email ? email.split("@")[0] : null);
  const why = $derived(provider ? reasonText(provider.resolution?.reason ?? null) : null);
  const label = $derived(failed ? "Accounts unavailable" : !view ? "Account" : name ?? (provider ? `No ${PROVIDER_LABEL[provider.provider]} account` : "No account pool"));
  const title = $derived(email ? `${email}${why ? ", " + why : ""}. Open accounts.` : "Open accounts");
  const meters = $derived(account ? [{ label: "Session", value: account.session_pct }, { label: "Week", value: account.weekly_pct }] : []);
  const tone = (value: number | null) => value === null ? "unknown" : value >= 90 ? "high" : value >= 70 ? "mid" : "low";

  $effect(() => {
    const id = threadId;
    let cancelled = false;
    failed = false;
    loadAccounts(id).then(result => { if (!cancelled) view = result; }, () => { if (!cancelled) failed = true; });
    return () => { cancelled = true; };
  });
</script>

<button class="account" class:warning={view !== null && !email} {title} onclick={() => { store.drawer = "accounts"; }}>
  <span class="name">{label}</span>
  {#if meters.length}
    <span class="meters">
      {#each meters as meter (meter.label)}
        <span class="meter {tone(meter.value)}">
          <span class="meter-label">{meter.label}</span>
          <span class="track"><span class="fill" style:width="{Math.max(0, Math.min(100, meter.value ?? 0))}%"></span></span>
          <span class="pct">{meter.value === null ? "?" : Math.round(meter.value) + "%"}</span>
        </span>
      {/each}
    </span>
  {/if}
</button>

<style>
  .account { display: inline-flex; align-items: center; gap: 8px; height: 30px; padding: 0 8px; border-radius: var(--radius-small); color: var(--text-muted); font-size: 12px; min-width: 0; }
  .account:hover { background: var(--bg-hover); color: var(--text); }
  .account.warning .name { color: var(--warning); }
  .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 120px; }
  .meters { display: grid; gap: 1px; line-height: 1; }
  .meter { display: grid; grid-template-columns: 40px 34px 28px; align-items: center; gap: 4px; font-size: 10px; color: var(--text-faint); font-variant-numeric: tabular-nums; }
  .meter-label { text-align: right; }
  .track { height: 4px; border-radius: 2px; background: var(--bg-active); overflow: hidden; }
  .fill { display: block; height: 100%; border-radius: 2px; background: var(--success); }
  .mid .fill { background: var(--warning); }
  .high .fill { background: var(--danger); }
  .unknown .track { background: repeating-linear-gradient(90deg, var(--bg-active) 0 3px, transparent 3px 6px); }
  .pct { text-align: left; }
</style>
