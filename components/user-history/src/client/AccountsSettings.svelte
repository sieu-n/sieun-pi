<script lang="ts">
  import { api } from "./api.ts";
  import { store } from "./store.svelte.ts";
  import { accountState, forgetAccounts, loadAccounts, meterTone, PROVIDER_LABEL, rememberAccounts, resetText, resolutionSentence, span, staleText, STATE_LABEL, threadProvider, windowColumns, windowLabel,
    type AccountState } from "./accounts.ts";
  import type { AccountAction, AccountsView, PoolAccount, PoolProvider } from "../shared/types.ts";
  import Modal from "./Modal.svelte";
  import Icon from "./Icon.svelte";

  type Provider = PoolProvider["provider"];
  type Confirm = { title: string; body: string; label: string; action: AccountAction };

  const threadId = $derived(store.selectedId);
  const modelProvider = $derived(threadId ? store.thread(threadId)?.state?.info.model?.provider : undefined);
  let view = $state<AccountsView | null>(null);
  let loading = $state(false);
  let error = $state<string | null>(null);
  let tab = $state<Provider | null>(null);
  let acting = $state<string | null>(null);
  let confirm = $state<Confirm | null>(null);
  let expanded = $state<string | null>(null);
  let notice = $state<string | null>(null);
  let now = $state(Date.now());

  $effect(() => {
    const timer = setInterval(() => { now = Date.now(); }, 30_000);
    return () => clearInterval(timer);
  });

  const current = $derived(view ? (view.providers.find(entry => entry.provider === tab) ?? threadProvider(view, modelProvider)) : undefined);
  const resolution = $derived(current?.resolution ?? null);
  const columns = $derived(current ? windowColumns(current.rows) : []);
  const RANK: Record<AccountState | "ready", number> = { seat: 1, pinned: 1, ready: 2, live: 2, depleted: 3, cooldown: 4, refused: 4, "needs-login": 5 };
  const rows = $derived([...(current?.rows ?? [])].sort((a, b) => rank(a) - rank(b) || a.email.localeCompare(b.email)));

  function rank(row: PoolAccount): number {
    return row.id === resolution?.account ? 0 : RANK[accountState(row) ?? "ready"];
  }

  async function load(fresh = false): Promise<void> {
    loading = true;
    error = null;
    try {
      const result = await loadAccounts(threadId, { fresh });
      view = result;
      if (!tab) tab = threadProvider(result, modelProvider)?.provider ?? result.providers[0]?.provider ?? null;
    } catch (caught) { error = caught instanceof Error ? caught.message : String(caught); }
    finally { loading = false; }
  }
  $effect(() => { void threadId; void load(); });

  async function run(action: AccountAction, key: string): Promise<void> {
    confirm = null;
    acting = key;
    try {
      const result = await api.accountAction(action);
      forgetAccounts();
      rememberAccounts("id" in action ? action.id : threadId, result);
      view = result;
      notice = result.notice ?? null;
    } catch (caught) { store.toast(caught instanceof Error ? caught.message : String(caught)); }
    finally { acting = null; }
  }

  const planText = (row: PoolAccount): string | null => {
    const plan = row.plan ?? row.tier;
    return plan ? plan.charAt(0).toUpperCase() + plan.slice(1) : null;
  };

  function notes(provider: Provider, row: PoolAccount): string[] {
    const out: string[] = [];
    const state = accountState(row);
    if (state === "needs-login") out.push(`Login expired. Run tokenmaxxing auth${provider === "openai-codex" ? " --codex" : ""} ${row.email} in a terminal.`);
    else if (state === "refused" || state === "cooldown") {
      const left = row.cooldownUntil && row.cooldownUntil > now ? ` The pool tries it again in ${span(row.cooldownUntil - now)}.` : "";
      out.push((row.cooldownReason ? `Refused: ${row.cooldownReason}.` : "Cooling down after a failure.") + left);
    }
    const stale = staleText(row, now);
    if (stale && state !== "needs-login") out.push(stale + ".");
    return out;
  }

  function useForThread(provider: Provider, row: PoolAccount): void {
    if (!threadId) return;
    if (row.usable) { void run({ action: "use", provider, account: row.id, id: threadId, force: false }, row.id); return; }
    confirm = { title: `Use ${row.email} anyway?`, body: `${row.email} cannot serve right now (${row.reason ?? "not usable"}). This thread keeps it until you follow the pool again.`, label: "Use anyway",
      action: { action: "use", provider, account: row.id, id: threadId, force: true } };
  }
  function askPin(provider: Provider, row: PoolAccount): void {
    confirm = { title: `Pin ${row.email} for all sessions?`, body: `Every ${PROVIDER_LABEL[provider]} session uses this account until you unpin it.`, label: "Pin", action: { action: "pin", provider, account: row.id } };
  }
  function askUnpin(provider: Provider): void {
    confirm = { title: `Unpin ${PROVIDER_LABEL[provider]}?`, body: "Sessions go back to the pool's own choice.", label: "Unpin", action: { action: "unpin", provider } };
  }
  function askDropSeat(provider: Provider, row: PoolAccount): void {
    confirm = { title: `Drop the seat on ${row.email}?`, body: "The next request moves the seat to the best account. Running sessions keep their connection.", label: "Drop seat", action: { action: "switch", provider } };
  }
  function askRecheck(provider: Provider): void {
    confirm = { title: "Check refused accounts again?", body: "The pool sends one free request per Claude account. An account the API accepts again returns to the pool. One it refuses cools down for 24 hours.", label: "Check again",
      action: { action: "recheck", provider } };
  }
  const actionKey = (action: AccountAction): string => "account" in action ? action.account : action.action;
</script>

<section class="accounts" aria-label="Accounts">
  <header class="bar">
    {#if view}
      <div class="tabs" role="tablist">
        {#each view.providers as provider (provider.provider)}
          <button class="tab" role="tab" aria-selected={current?.provider === provider.provider} onclick={() => { tab = provider.provider; expanded = null; }}>
            {PROVIDER_LABEL[provider.provider]} <span class="count">{provider.rows.length}</span>
          </button>
        {/each}
      </div>
    {/if}
    <span class="spacer"></span>
    <button class="button small" disabled={acting !== null || !current} title="Read every account's usage from the providers now. Takes up to a minute."
      onclick={() => current && void run({ action: "refresh", provider: current.provider }, "refresh")}>
      {#if acting === "refresh"}<span class="spinner tiny"></span> Reading usage{:else}<Icon name="refresh" size={14} /> Refresh usage{/if}
    </button>
  </header>

  {#if error && !view}
    <div class="empty">
      <div class="error"><Icon name="alert" size={16} /> Accounts unavailable. {error}</div>
      <button class="button small" onclick={() => void load(true)}>Retry</button>
    </div>
  {:else if !view || !current}
    <div class="empty muted"><span class="spinner"></span> Loading accounts</div>
  {:else}
    <div class="uses">
      <span class:warning={threadId && !resolution?.email}>{threadId ? resolutionSentence(current) : "No thread is open. Each thread draws from the pool."}</span>
      {#if threadId && resolution?.pinned}
        <button class="button small" disabled={acting !== null} onclick={() => threadId && void run({ action: "follow", provider: current.provider, id: threadId }, "follow")}>Follow the pool</button>
      {/if}
    </div>
    {#if notice}
      <div class="notice"><span>{notice}</span><button class="icon-button" aria-label="Dismiss" onclick={() => { notice = null; }}><Icon name="x" size={14} /></button></div>
    {/if}
    {#if error}<div class="inline-error">{error}</div>{/if}
    {#if current.error && !current.rows.length}
      <div class="inline-error">{current.error}</div>
    {:else if !current.rows.length}
      <div class="empty muted">No pooled {PROVIDER_LABEL[current.provider]} accounts.</div>
    {:else}
      <div class="table" role="table" style:--windows={columns.length} class:busy={loading}>
        <div class="row head" role="row">
          <span role="columnheader">Account</span>
          {#each columns as column (column)}<span role="columnheader">{column}</span>{/each}
          <span role="columnheader" class="sr-only">Actions</span>
        </div>
        {#each rows as row (row.id)}
          {@const state = accountState(row)}
          {@const inUse = row.id === resolution?.account}
          {@const rowNotes = notes(current.provider, row)}
          <div class="row" role="row" class:this={inUse} class:dead={state === "needs-login"} class:busy={acting === row.id}>
            <div class="who" role="cell">
              <div class="email" title={row.email}>{row.email}</div>
              <div class="sub">
                {#if planText(row)}<span>{planText(row)}</span>{/if}
                {#if state}<span class="badge {STATE_LABEL[state].tone}">{STATE_LABEL[state].label}</span>{/if}
                {#if inUse}<span class="badge accent">This thread</span>{/if}
              </div>
            </div>
            {#each columns as column (column)}
              {@const window = row.windows.find(entry => windowLabel(entry) === column)}
              <div class="cell {window ? meterTone(window.pct) : ''}" role="cell">
                {#if window}
                  <span class="pct">{Math.round(window.pct)}%</span>
                  <span class="track"><span class="fill" style:width="{Math.max(0, Math.min(100, window.pct))}%"></span></span>
                  <span class="reset">{resetText(window, now) ?? ""}</span>
                {/if}
              </div>
            {/each}
            <div class="actions" role="cell">
              {#if acting === row.id}<span class="spinner tiny"></span>{/if}
              {#if threadId && !inUse}
                <button class="button small" disabled={acting !== null} title="Use {row.email} for this thread" onclick={() => useForThread(current.provider, row)}>Use</button>
              {/if}
              <button class="icon-button" aria-label="More actions for {row.email}" aria-expanded={expanded === row.id} onclick={() => { expanded = expanded === row.id ? null : row.id; }}><Icon name="more" size={16} /></button>
            </div>
            {#if rowNotes.length}
              <div class="notes">{#each rowNotes as note (note)}<span>{note}</span>{/each}</div>
            {/if}
            {#if expanded === row.id}
              <div class="more fade-in">
                {#if current.poolPin === row.id}
                  <button class="button small" disabled={acting !== null} onclick={() => askUnpin(current.provider)}>Unpin for all sessions</button>
                {:else}
                  <button class="button small" disabled={acting !== null} onclick={() => askPin(current.provider, row)}>Pin for all sessions</button>
                {/if}
                {#if row.seat}<button class="button small" disabled={acting !== null} onclick={() => askDropSeat(current.provider, row)}>Drop seat</button>{/if}
                {#if current.provider === "anthropic" && (state === "refused" || state === "cooldown")}
                  <button class="button small" disabled={acting !== null} onclick={() => askRecheck(current.provider)}>Check again</button>
                {/if}
              </div>
            {/if}
          </div>
        {/each}
      </div>
    {/if}
  {/if}
</section>

{#if confirm}
  <Modal title={confirm.title} width="420px" onclose={() => { confirm = null; }}>
    <div class="confirm">
      <p>{confirm.body}</p>
      <div class="confirm-actions">
        <button class="button" onclick={() => { confirm = null; }}>Cancel</button>
        <button class="button primary" onclick={() => confirm && void run(confirm.action, actionKey(confirm.action))}>{confirm.label}</button>
      </div>
    </div>
  </Modal>
{/if}

<style>
  .accounts { display: flex; flex-direction: column; gap: 12px; padding: 12px 18px 18px; font-size: 13px; }
  .bar { display: flex; align-items: center; gap: 8px; border-bottom: 1px solid var(--border); margin: 0 -18px; padding: 0 18px; }
  .tabs { display: flex; gap: 4px; }
  .tab { padding: 6px 10px 9px; color: var(--text-muted); border-bottom: 2px solid transparent; margin-bottom: -1px; }
  .tab[aria-selected="true"] { color: var(--text); border-bottom-color: var(--accent); }
  .count { color: var(--text-faint); font-variant-numeric: tabular-nums; }
  .spacer { flex: 1; }
  .bar .button { margin-bottom: 6px; display: inline-flex; align-items: center; gap: 6px; }
  .uses { display: flex; align-items: center; gap: 10px; line-height: 1.4; }
  .uses span { flex: 1; }
  .warning { color: var(--warning); }
  .notice { display: flex; align-items: flex-start; gap: 8px; padding: 8px 8px 8px 12px; border-radius: var(--radius-small); background: var(--bg-sunken); color: var(--text-muted); line-height: 1.4; }
  .notice span { flex: 1; overflow-wrap: anywhere; }
  .inline-error { padding: 8px 10px; border-radius: var(--radius-small); background: var(--danger-soft); color: var(--danger); }
  .empty { display: flex; align-items: center; justify-content: center; gap: 10px; padding: 32px 0; }
  .error { display: flex; align-items: center; gap: 8px; color: var(--danger); }
  .table { display: grid; grid-template-columns: minmax(200px, 1.5fr) repeat(var(--windows), minmax(96px, 1fr)) auto; }
  .table.busy { opacity: 0.7; }
  .row { display: grid; grid-template-columns: subgrid; grid-column: 1 / -1; align-items: center; column-gap: 14px; padding: 8px 6px; border-top: 1px solid var(--border); border-radius: var(--radius-small); }
  .row.head { border-top: none; padding-top: 0; padding-bottom: 6px; font-size: 11px; color: var(--text-faint); }
  .row.this { background: var(--accent-soft); border-top-color: transparent; }
  .row.this + .row { border-top-color: transparent; }
  .row.dead .who, .row.dead .cell { opacity: 0.55; }
  .row.busy { opacity: 0.7; }
  .who { min-width: 0; }
  .email { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 500; }
  .sub { display: flex; align-items: center; gap: 6px; margin-top: 2px; font-size: 12px; color: var(--text-muted); }
  .badge { padding: 0 6px; border-radius: 999px; font-size: 11px; line-height: 17px; font-weight: 500; background: var(--bg-active); color: var(--text-muted); }
  .badge.accent { background: var(--accent-soft); color: var(--accent); }
  .row.this .badge.accent { background: var(--bg-elevated); }
  .badge.success { background: rgba(47, 158, 99, 0.14); color: var(--success); }
  .badge.warning { background: rgba(201, 138, 18, 0.16); color: var(--warning); }
  .badge.danger { background: var(--danger-soft); color: var(--danger); }
  .cell { display: grid; grid-template-columns: 1fr; gap: 3px; min-width: 0; font-variant-numeric: tabular-nums; }
  .pct { font-size: 13px; }
  .track { height: 4px; border-radius: 2px; background: var(--bg-active); overflow: hidden; }
  .fill { display: block; height: 100%; border-radius: 2px; background: var(--success); }
  .mid .fill { background: var(--warning); }
  .high .fill { background: var(--danger); }
  .reset { font-size: 11px; color: var(--text-faint); white-space: nowrap; min-height: 13px; }
  .actions { display: flex; align-items: center; justify-content: flex-end; gap: 4px; }
  .notes { grid-column: 1 / -1; display: flex; flex-wrap: wrap; gap: 4px 12px; margin-top: 4px; font-size: 12px; color: var(--text-muted); }
  .more { grid-column: 1 / -1; display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
  .spinner.tiny { width: 11px; height: 11px; border-width: 1.5px; }
  .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
  .confirm { display: flex; flex-direction: column; gap: 14px; padding: 14px 18px 16px; }
  .confirm p { margin: 0; color: var(--text-muted); line-height: 1.45; }
  .confirm-actions { display: flex; justify-content: flex-end; gap: 8px; }
</style>
