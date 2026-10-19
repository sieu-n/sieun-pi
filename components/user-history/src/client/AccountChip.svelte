<script lang="ts">
  import { untrack } from "svelte";
  import { store } from "./store.svelte.ts";
  import { pushedAccounts } from "./thread-side.svelte.ts";
  import { cachedAccounts, loadAccounts, PROVIDER_LABEL, reasonText, resetText, resolvedAccount, threadProvider, windowLabel } from "./accounts.ts";
  import type { AccountsView, NewChatAccount } from "../shared/types.ts";
  import UsageMeters from "./UsageMeters.svelte";
  import AccountPicker from "./AccountPicker.svelte";
  import Floating from "./ui/Floating.svelte";
  import Icon from "./Icon.svelte";

  /**
   * The account a thread draws on, with its usage meters. `model` is the current model id and name (for the per-model window). With `onchoose`
   * (the new-chat screen) a click opens the account picker for the model's provider; otherwise it opens account settings.
   */
  let { threadId, provider: providerId, model, choice = null, onchoose }: {
    threadId: string | null; provider?: string | undefined; model?: string | undefined; choice?: NewChatAccount | null; onchoose?: (account: NewChatAccount | null) => void;
  } = $props();
  let view = $state<AccountsView | null>(null);
  let failed = $state(false);
  let button: HTMLButtonElement | undefined = $state();
  let picking = $state(false);

  const modelProvider = $derived(providerId ?? (threadId ? store.thread(threadId)?.state?.info.model?.provider : undefined));
  const provider = $derived(view ? threadProvider(view, modelProvider) : undefined);
  const choosingManual = $derived(choice !== null && choice.provider === provider?.provider);
  const chosen = $derived(choosingManual ? provider?.rows.find(row => row.id === choice?.id) : undefined);
  const account = $derived(choosingManual ? chosen : provider ? resolvedAccount(provider) : undefined);
  const selection = $derived(provider?.resolution?.selection);
  const manual = $derived(choosingManual || selection?.mode === "manual");
  const email = $derived(account?.email ?? (choice?.provider === provider?.provider ? choice?.id : selection?.mode === "manual" ? selection.account_id : provider?.resolution?.email) ?? null);
  const globalManual = $derived(!choosingManual && selection?.mode === "manual" && provider?.poolPin === selection.account_id);
  const why = $derived(manual ? globalManual ? "Manual pool override keeps this account until it is unpinned" : "Manual keeps this account until you choose Auto" : provider ? reasonText(provider.resolution?.reason ?? null) : null);
  const accountError = $derived(choosingManual ? null : provider?.resolution?.error ?? provider?.error ?? null);
  const label = $derived(failed ? "Accounts unavailable" : !view ? "Account" : email ?? (provider ? `No ${PROVIDER_LABEL[provider.provider]} account` : "No account pool"));
  const windows = $derived(account?.windows ?? []);
  const title = $derived([email ? `${email}${why ? " (" + why + ")" : ""}` : label,
    ...(accountError ? [accountError] : []),
    ...windows.map(window => `${windowLabel(window)} ${Math.round(window.pct)}%${resetText(window) ? ", " + resetText(window) : ""}`),
    onchoose ? "Choose the account for this chat" : "Open account settings"].join("\n"));

  const modelId = $derived(model?.split(" ")[0] ?? null);

  $effect(() => {
    const id = threadId;
    const forModel = modelId;
    void pushedAccounts.revision;
    let cancelled = false;
    failed = false;
    view = cachedAccounts(id, forModel) ?? null;
    // The thread feed pushes this view after a new subscription (store.side); the chip asks only when none is coming.
    if (id && untrack(() => pushedAccounts.isComing(id))) return;
    loadAccounts(id, { model: forModel }).then(result => { if (!cancelled) view = result; }, () => { if (!cancelled) failed = true; });
    return () => { cancelled = true; };
  });
</script>

<button bind:this={button} class="account" class:warning={view !== null && (!email || accountError !== null)} {title} aria-haspopup={onchoose ? "dialog" : undefined} aria-expanded={onchoose ? picking : undefined}
  onclick={() => { if (onchoose) picking = !picking; else store.drawer = "accounts"; }}>
  {#if choosingManual || selection}<span class="mode">{manual ? "Manual" : "Auto"}</span>{/if}
  <span class="email">{label}</span>
  <UsageMeters {windows} {model} />
  {#if onchoose}<Icon name="chevronDown" size={12} />{/if}
</button>
{#if picking && button && onchoose && provider}
  <Floating anchor={button} width={400} maxHeight={420} label="Account for the new chat" onclose={() => { picking = false; }}>
    <AccountPicker {provider} {model} {choice} onchoose={next => { picking = false; onchoose(next); }} />
  </Floating>
{/if}

<style>
  .account { display: inline-flex; align-items: center; gap: 8px; height: 30px; padding: 0 8px; border-radius: var(--radius-small); color: var(--text-muted); font-size: 12px; min-width: 0; }
  .account:hover, .account[aria-expanded="true"] { background: var(--bg-hover); color: var(--text); }
  .account.warning .email { color: var(--warning); }
  .mode { color: var(--text-faint); font-size: 11px; }
  .email { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 200px; margin-right: 2px; }
  @container app (max-width: 720px) { .account :global(.meter) { display: none; } }
</style>
