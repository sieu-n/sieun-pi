<script lang="ts">
  import type { ModelRef } from "$lib/api";
  import type { AccountsView, NewChatAccount } from "$lib/api/shared/types.ts";
  import Chip from "$lib/ui/Chip.svelte";
  import Icon from "$lib/ui/Icon.svelte";
  import Spinner from "$lib/ui/Spinner.svelte";
  import { toast } from "$lib/ui/toast.svelte";
  import { tooltip } from "$lib/ui/tooltip";
  import AccountPicker from "./AccountPicker.svelte";
  import { accountsApi } from "./api";
  import { PROVIDER_LABEL, resetText, resolutionSentence, resolvedAccount, shownWindows, threadProvider, windowLabel } from "./model";
  import UsageMeters from "./UsageMeters.svelte";

  /**
   * The account a thread draws on, with its usage meters. `thread` is any sw factory id (a conversation, an agent or a DM room) and `model`
   * the thread's model, for its provider and its per-model window. A click opens the account picker, and a pick runs `use` or `follow` on
   * the thread. With `onchoose` there is no thread yet: the chip holds `choice` for a new agent or chat and runs nothing.
   */
  let {
    thread,
    model = null,
    choice = null,
    onchoose,
  }: {
    thread: string | null;
    model?: ModelRef | null;
    choice?: NewChatAccount | null;
    onchoose?: (account: NewChatAccount | null) => void;
  } = $props();

  let view = $state<AccountsView | null>(null);
  let failed = $state(false);
  let open = $state(false);
  let busy = $state(false);
  let anchor = $state<HTMLElement>();

  const modelId = $derived(model?.id ?? null);
  const modelText = $derived(model ? `${model.id} ${model.label}` : null);
  const choosing = $derived(onchoose !== undefined);
  const provider = $derived(view ? threadProvider(view.providers, model?.provider) : undefined);
  const providerName = $derived(provider ? PROVIDER_LABEL[provider.provider] : null);
  const choosingManual = $derived(choosing && choice !== null && choice.provider === provider?.provider);
  const selection = $derived(choosing ? undefined : provider?.resolution?.selection);
  const manual = $derived(choosingManual || selection?.mode === "manual");
  const account = $derived(choosingManual ? provider?.rows.find((row) => row.id === choice?.id) : provider ? resolvedAccount(provider) : undefined);
  const accountLabel = $derived(
    account?.label ?? (choosingManual ? choice?.id : selection?.mode === "manual" ? selection.account_id : provider?.resolution?.email) ?? null,
  );
  const accountError = $derived(choosingManual ? null : (provider?.resolution?.error ?? provider?.error ?? null));
  const label = $derived(
    failed ? "Accounts unavailable" : !view ? "Account" : (accountLabel ?? (providerName ? `No ${providerName} account` : "No account pool")),
  );
  const modeText = $derived(!view || failed ? null : choosing ? (choosingManual ? "Manual" : "Auto") : selection ? (manual ? "Manual" : "Auto") : null);
  const warning = $derived(failed || (view !== null && (!accountLabel || accountError !== null)));
  const windows = $derived(account?.windows ?? []);
  const reason = $derived.by(() => {
    if (failed) return "The account pool did not answer.";
    if (!provider) return view ? "This box has no account pool." : "Reading the account pool.";
    if (!choosing) return resolutionSentence(provider);
    if (choosingManual) return `Manual keeps ${accountLabel} for the new thread.`;
    return accountLabel ? `Auto lets the pool pick. Its next pick is ${accountLabel}.` : "Auto lets the pool pick when the thread starts.";
  });
  const title = $derived(
    [
      reason,
      ...(accountError && !reason.includes(accountError) ? [accountError] : []),
      ...shownWindows(windows, modelText).map((window) => `${windowLabel(window)} ${Math.round(window.pct)}%${resetText(window) ? `, ${resetText(window)}` : ""}`),
      choosing ? "Choose the account for the new thread." : "Choose the account for this thread.",
    ].join("\n"),
  );
  const value = $derived(choosing ? (choosingManual ? (choice?.id ?? null) : null) : selection?.mode === "manual" ? selection.account_id : null);

  async function load(id: string | null, forModel: string | null): Promise<void> {
    try {
      const next = await accountsApi.view({ thread: id, model: forModel });
      if (id === thread && forModel === modelId) {
        view = next;
        failed = false;
      }
    } catch {
      if (id === thread && forModel === modelId) failed = true;
    }
  }

  $effect(() => {
    const id = thread;
    const forModel = modelId;
    view = null;
    failed = false;
    void load(id, forModel);
    const timer = setInterval(() => void load(id, forModel), 60_000);
    return () => clearInterval(timer);
  });

  async function choose(next: string | null): Promise<void> {
    if (!provider) return;
    if (onchoose) {
      onchoose(next ? { provider: provider.provider, id: next } : null);
      return;
    }
    if (!thread || busy) return;
    busy = true;
    try {
      const answer = await accountsApi.action(
        next ? { action: "use", provider: provider.provider, account: next, id: thread } : { action: "follow", provider: provider.provider, id: thread },
      );
      if (answer.notice) toast.show(answer.notice);
      await load(thread, modelId);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "The account did not change");
    } finally {
      busy = false;
    }
  }
</script>

<span
  class="account-chip"
  class:warning
  bind:this={anchor}
  use:tooltip={{ text: title, placement: "bottom" }}
  data-testid="account-chip"
  data-mode={modeText?.toLowerCase()}
  data-account={account?.id}
>
  <Chip size="sm" onclick={() => (open = !open)}>
    {#if busy}<Spinner size={12} label="Changing the account" />{:else if warning}<Icon name="warning" size={14} />{/if}
    {#if modeText}<span class="mode">{modeText}</span>{/if}
    <span class="name">{label}</span>
    <span class="meters"><UsageMeters {windows} model={modelText} /></span>
    <Icon name="chevron-down" size={12} />
  </Chip>
</span>
{#if provider}
  <AccountPicker
    bind:open
    {anchor}
    {provider}
    model={modelText}
    {value}
    thread={choosing ? null : thread}
    label={choosing ? `${providerName} account for the new thread` : undefined}
    onchoose={(next) => void choose(next)}
  />
{/if}

<style>
  .account-chip {
    display: inline-flex;
    min-width: 0;
    max-width: 100%;
  }
  .account-chip :global(.chip) {
    padding: 2px 8px;
    gap: 6px;
  }
  .mode {
    color: var(--text-subtle);
  }
  .name {
    max-width: 180px;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .warning .name {
    color: var(--text-danger);
  }
  .meters {
    display: inline-flex;
    gap: 8px;
  }
  @media (max-width: 720px) {
    .meters {
      display: none;
    }
  }
</style>
