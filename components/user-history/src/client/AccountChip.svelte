<script lang="ts">
  import { store } from "./store.svelte.ts";
  import { loadAccounts, PROVIDER_LABEL, reasonText, resetText, resolvedAccount, threadProvider, windowLabel } from "./accounts.ts";
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
  const chosen = $derived(choice && provider?.provider === choice.provider ? provider.rows.find(row => row.id === choice.id) : undefined);
  const account = $derived(chosen ?? (provider ? resolvedAccount(provider) : undefined));
  const email = $derived(account?.email ?? provider?.resolution?.email ?? null);
  const why = $derived(chosen ? "chosen for this chat" : provider ? reasonText(provider.resolution?.reason ?? null) : null);
  const label = $derived(failed ? "Accounts unavailable" : !view ? "Account" : email ?? (provider ? `No ${PROVIDER_LABEL[provider.provider]} account` : "No account pool"));
  const windows = $derived(account?.windows ?? []);
  const title = $derived([email ? `${email}${why ? " (" + why + ")" : ""}` : label,
    ...windows.map(window => `${windowLabel(window)} ${Math.round(window.pct)}%${resetText(window) ? ", " + resetText(window) : ""}`),
    onchoose ? "Choose the account for this chat" : "Open account settings"].join("\n"));

  $effect(() => {
    const id = threadId;
    let cancelled = false;
    failed = false;
    loadAccounts(id).then(result => { if (!cancelled) view = result; }, () => { if (!cancelled) failed = true; });
    return () => { cancelled = true; };
  });
</script>

<button bind:this={button} class="account" class:warning={view !== null && !email} {title} aria-haspopup={onchoose ? "dialog" : undefined} aria-expanded={onchoose ? picking : undefined}
  onclick={() => { if (onchoose) picking = !picking; else store.drawer = "accounts"; }}>
  {#if chosen}<Icon name="account" size={13} />{/if}
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
  .email { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 200px; margin-right: 2px; }
  @container app (max-width: 720px) { .account :global(.meter) { display: none; } }
</style>
