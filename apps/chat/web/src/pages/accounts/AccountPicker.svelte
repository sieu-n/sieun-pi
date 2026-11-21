<script lang="ts">
  import type { PoolAccount, PoolProvider } from "$lib/api/shared/types.ts";
  import { hrefFor } from "$lib/router.svelte";
  import Badge from "$lib/ui/Badge.svelte";
  import Button from "$lib/ui/Button.svelte";
  import Picker from "$lib/ui/Picker.svelte";
  import type { Anchor } from "$lib/ui/floating";
  import type { PickerItem } from "$lib/ui/types";
  import { accountState, planText, PROVIDER_LABEL, PROVIDER_SLUG, sortedRows, STATE_LABEL, staleText, type Tone } from "./model";
  import UsageMeters from "./UsageMeters.svelte";

  /**
   * The account picker of one provider: Auto with the pool's next pick, then every account with its plan, usage meters, stale note and
   * state badge, in the Accounts table's order, with the accounts that are off or signed out last in their own group, as Slack lists
   * deactivated people last. `value` is the manual account, null for Auto. `thread` names the thread the footer opens in Settings > Accounts.
   */
  let {
    open = $bindable(),
    anchor,
    provider,
    model = null,
    value,
    thread = null,
    label,
    onchoose,
  }: {
    open: boolean;
    anchor: Anchor | null | undefined;
    provider: PoolProvider;
    model?: string | null;
    value: string | null;
    thread?: string | null;
    label?: string;
    onchoose: (account: string | null) => void;
  } = $props();

  const AUTO = "auto:follow";
  const BADGE_TONE: Record<Tone, "accent" | "success" | "outline" | "warning" | "danger"> = {
    accent: "accent", success: "success", muted: "outline", warning: "warning", danger: "danger",
  };
  const name = $derived(PROVIDER_LABEL[provider.provider]);
  /** The pool's own next pick; under Manual the resolution names the kept account, so there is none to show. */
  const next = $derived(provider.resolution?.selection.mode === "manual" ? null : (provider.resolution?.account ?? null));
  const nextLabel = $derived(next ? (provider.rows.find((row) => row.id === next)?.label ?? provider.resolution?.email ?? next) : null);
  const parked = (row: PoolAccount): boolean => {
    const state = accountState(row);
    return state === "off" || state === "needs-login";
  };
  const rows = $derived(sortedRows(provider));
  const accountItem = (row: PoolAccount, group: string): PickerItem => ({
    id: row.id,
    label: row.label,
    detail: [planText(row), row.id === next ? "Next pick" : null, staleText(row)].filter(Boolean).join(" · ") || undefined,
    group,
    keywords: [row.email, row.id],
  });
  const items = $derived<PickerItem[]>([
    { id: AUTO, label: "Auto", detail: nextLabel ? `Next pick: ${nextLabel}` : value ? "The pool picks again on the next request" : "The pool picks when the thread starts", group: "Auto follows the pool" },
    ...rows.filter((row) => !parked(row)).map((row) => accountItem(row, "Manual keeps one account")),
    ...rows.filter(parked).map((row) => accountItem(row, "Off or signed out")),
  ]);
  const href = $derived(hrefFor("settings", ["accounts", PROVIDER_SLUG[provider.provider]], { thread }));
</script>

{#snippet rowEnd(item: PickerItem)}
  {@const row = provider.rows.find((entry) => entry.id === item.id)}
  {#if row}
    {@const state = accountState(row)}
    <UsageMeters windows={row.windows} {model} />
    <span class="state">
      {#if state}<Badge value={STATE_LABEL[state].label} tone={BADGE_TONE[STATE_LABEL[state].tone]} />{:else if row.id === next}<Badge value="Next" tone="accent" />{/if}
    </span>
  {/if}
{/snippet}

{#snippet footer({ close }: { query: string; close: () => void })}
  <div class="footer">
    {#if !provider.rows.length}<p class="empty t-caption">{provider.error ?? `No ${name} accounts in the pool.`}</p>{/if}
    <Button variant="ghost" size="sm" icon="external" {href} onclick={close}>Open Accounts in Settings</Button>
  </div>
{/snippet}

<Picker
  bind:open
  {anchor}
  {items}
  value={value ?? AUTO}
  width={520}
  placement="bottom-end"
  label={label ?? `${name} account for this thread`}
  placeholder="Find an account"
  {rowEnd}
  {footer}
  onselect={(id) => onchoose(id === AUTO ? null : id)}
/>

<style>
  .state {
    display: inline-flex;
    justify-content: flex-end;
    width: 84px;
  }
  .footer {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 4px;
    padding: 2px;
  }
  .empty {
    margin: 0;
    padding: 4px 8px;
    color: var(--text-metadata);
  }
</style>
