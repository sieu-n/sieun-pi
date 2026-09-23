<script lang="ts">
  import { accountState, PROVIDER_LABEL, STATE_LABEL, staleText } from "./accounts.ts";
  import type { NewChatAccount, PoolAccount, PoolProvider } from "../shared/types.ts";
  import UsageMeters from "./UsageMeters.svelte";
  import Icon from "./Icon.svelte";

  /**
   * Pool accounts for one provider, to start a new chat on. Follow the pool is the default and names the account the pool would pick next.
   * Accounts that cannot serve now (depleted, cooldown, refused) are greyed and need a second click to force; turned off or signed out ones cannot be chosen.
   */
  let { provider, model, choice, onchoose }: { provider: PoolProvider; model?: string | undefined; choice: NewChatAccount | null; onchoose: (account: NewChatAccount | null) => void } = $props();
  let confirming = $state<string | null>(null);

  const next = $derived(provider.resolution?.account ?? null);
  const nextEmail = $derived(provider.rows.find(row => row.id === next)?.email ?? provider.resolution?.email ?? null);
  const selected = $derived(choice?.provider === provider.provider ? choice.id : null);
  const blocked = (row: PoolAccount) => row.disabled || row.reason === "needs-reauth";
  const unusable = (row: PoolAccount) => !row.usable && !blocked(row);

  function pick(row: PoolAccount): void {
    if (blocked(row)) return;
    if (unusable(row) && confirming !== row.id) { confirming = row.id; return; }
    onchoose({ provider: provider.provider, id: row.id, force: unusable(row) });
  }
</script>

<div class="menu-heading">{PROVIDER_LABEL[provider.provider]} account for this chat</div>
<button type="button" class="menu-item follow" role="menuitemradio" aria-checked={selected === null} data-autofocus={selected === null ? true : undefined} onclick={() => onchoose(null)}>
  <span class="check">{#if selected === null}<Icon name="check" size={13} />{/if}</span>
  <span class="text"><span class="email">Follow the pool</span><span class="sub">{nextEmail ? "Next pick: " + nextEmail : "The pool picks when the chat starts"}</span></span>
</button>
<div class="menu-separator"></div>
{#each provider.rows as row (row.id)}
  {@const state = accountState(row)}
  {@const stale = staleText(row)}
  <button type="button" class="menu-item account" class:greyed={blocked(row) || unusable(row)} role="menuitemradio" aria-checked={selected === row.id} aria-disabled={blocked(row)}
    data-autofocus={selected === row.id ? true : undefined} onclick={() => pick(row)}>
    <span class="check">{#if selected === row.id}<Icon name="check" size={13} />{/if}</span>
    <span class="text">
      <span class="email">{row.email}</span>
      <span class="sub">
        {#if confirming === row.id}<span class="warn">This account cannot serve now. Click again to use it anyway.</span>
        {:else}{[row.plan, row.id === next ? "Next pick" : null, stale].filter(Boolean).join(" · ")}{/if}
      </span>
    </span>
    <span class="meters"><UsageMeters windows={row.windows} {model} /></span>
    <span class="badge-slot">
      {#if state && state !== "live" && state !== "seat"}<span class="badge {STATE_LABEL[state].tone}">{STATE_LABEL[state].label}</span>
      {:else if row.id === next}<span class="badge accent">Next</span>{/if}
    </span>
  </button>
{/each}
{#if !provider.rows.length}<div class="empty">{provider.error ?? `No ${PROVIDER_LABEL[provider.provider]} accounts in the pool.`}</div>{/if}

<style>
  .menu-item { align-items: center; }
  .check { display: inline-flex; width: 14px; flex: none; color: var(--accent-bold); }
  .text { display: flex; flex-direction: column; flex: 1; min-width: 0; }
  .email { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sub { font-size: 11.5px; color: var(--text-faint); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .warn { color: var(--warning); white-space: normal; }
  .meters { display: inline-flex; gap: 8px; flex: none; }
  .greyed .email, .greyed .meters { opacity: 0.5; }
  .account[aria-disabled="true"] { cursor: not-allowed; }
  .badge-slot { display: inline-flex; justify-content: flex-end; flex: none; width: 76px; }
  .badge { flex: none; padding: 0 6px; border-radius: 4px; font-size: 11px; font-weight: 500; line-height: 18px; background: var(--bg-sunken); color: var(--text-muted); }
  .badge.accent { background: var(--accent-soft); color: var(--accent-bold); }
  .badge.success { background: color-mix(in srgb, var(--success) 14%, transparent); color: var(--success); }
  .badge.warning { background: color-mix(in srgb, var(--warning) 16%, transparent); color: var(--warning); }
  .badge.danger { background: var(--danger-soft); color: var(--danger); }
  .empty { padding: 8px 10px; font-size: 12.5px; color: var(--text-faint); }
</style>
