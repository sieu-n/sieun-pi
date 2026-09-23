<script lang="ts">
  import { store } from "./store.svelte.ts";
  import { loadAccounts, meterTone, PROVIDER_LABEL, reasonText, resetText, resolvedAccount, threadProvider, windowLabel } from "./accounts.ts";
  import type { AccountsView } from "../shared/types.ts";

  /** `model` is the current model id and name; a per-model window (Fable) shows only when it names that model. */
  let { threadId, provider: providerId, model }: { threadId: string | null; provider?: string | undefined; model?: string | undefined } = $props();
  let view = $state<AccountsView | null>(null);
  let failed = $state(false);

  const modelProvider = $derived(providerId ?? (threadId ? store.thread(threadId)?.state?.info.model?.provider : undefined));
  const provider = $derived(view ? threadProvider(view, modelProvider) : undefined);
  const account = $derived(provider ? resolvedAccount(provider) : undefined);
  const email = $derived(account?.email ?? provider?.resolution?.email ?? null);
  const why = $derived(provider ? reasonText(provider.resolution?.reason ?? null) : null);
  const label = $derived(failed ? "Accounts unavailable" : !view ? "Account" : email ?? (provider ? `No ${PROVIDER_LABEL[provider.provider]} account` : "No account pool"));
  const windows = $derived((account?.windows ?? []).filter(window => window.kind !== "model" || (model ?? "").toLowerCase().includes(windowLabel(window).toLowerCase())));
  const title = $derived([email ? `${email}${why ? " (" + why + ")" : ""}` : label,
    ...windows.map(window => `${windowLabel(window)} ${Math.round(window.pct)}%${resetText(window) ? ", " + resetText(window) : ""}`), "Open account settings"].join("\n"));

  $effect(() => {
    const id = threadId;
    let cancelled = false;
    failed = false;
    loadAccounts(id).then(result => { if (!cancelled) view = result; }, () => { if (!cancelled) failed = true; });
    return () => { cancelled = true; };
  });
</script>

<button class="account" class:warning={view !== null && !email} {title} onclick={() => { store.drawer = "accounts"; }}>
  <span class="email">{label}</span>
  {#each windows as window (window.label)}
    <span class="meter {meterTone(window.pct)}">
      <span class="figure"><span class="meter-label">{windowLabel(window)}</span><span class="pct">{Math.round(window.pct)}%</span></span>
      <span class="track"><span class="fill" style:width="{Math.max(0, Math.min(100, window.pct))}%"></span></span>
    </span>
  {/each}
</button>

<style>
  .account { display: inline-flex; align-items: center; gap: 10px; height: 30px; padding: 0 8px; border-radius: var(--radius-small); color: var(--text-muted); font-size: 12px; min-width: 0; }
  .account:hover { background: var(--bg-hover); color: var(--text); }
  .account.warning .email { color: var(--warning); }
  .email { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 200px; }
  /* One meter recipe for every window (the Virev ProgressBar): label left, percent right, a fully rounded 4 px track, ink fill that turns warning at 70% and danger at 90%. */
  .meter { display: inline-flex; flex-direction: column; gap: 3px; flex: none; width: 56px; font-size: 11px; font-weight: 500; line-height: 1; font-variant-numeric: tabular-nums; }
  .figure { display: flex; justify-content: space-between; gap: 4px; }
  .meter-label { color: var(--text-faint); }
  .pct { color: var(--text-muted); }
  .track { display: block; height: 4px; border-radius: 999px; background: var(--bg-active); overflow: hidden; }
  .fill { display: block; height: 100%; border-radius: 999px; background: var(--text-muted); transition: width 0.3s ease-out; }
  .mid .pct { color: var(--warning); }
  .high .pct { color: var(--danger); }
  .mid .fill { background: var(--warning); }
  .high .fill { background: var(--danger); }
  @container app (max-width: 720px) { .meter { display: none; } }
</style>
