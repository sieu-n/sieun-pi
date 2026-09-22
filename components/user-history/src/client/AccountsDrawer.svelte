<script lang="ts">
  import { api } from "./api.ts";
  import { store } from "./store.svelte.ts";
  import { accountState, forgetAccounts, loadAccounts, PROVIDER_LABEL, rememberAccounts, resolutionSentence, STATE_LABEL, stateDetail, threadProvider } from "./accounts.ts";
  import { initial, relativeTime } from "./format.ts";
  import type { AccountAction, AccountsView, PoolAccount, PoolEvent, PoolProvider } from "../shared/types.ts";
  import Meter from "./Meter.svelte";
  import Popover from "./Popover.svelte";
  import Icon from "./Icon.svelte";

  let { narrow }: { narrow: boolean } = $props();
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
  let menuFor = $state<string | null>(null);
  let logOpen = $state(false);
  let log = $state<PoolEvent[] | null>(null);
  let logError = $state<string | null>(null);

  const current = $derived(view ? (view.providers.find(entry => entry.provider === tab) ?? threadProvider(view, modelProvider)) : undefined);
  const rows = $derived([...(current?.rows ?? [])].sort((a, b) => Number(b.seat) - Number(a.seat) || Number(b.current) - Number(a.current) || (a.score ?? 1e9) - (b.score ?? 1e9)));
  const resolution = $derived(current?.resolution ?? null);

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

  async function loadLog(): Promise<void> {
    logError = null;
    try { log = await api.accountsLog(); }
    catch (caught) { logError = caught instanceof Error ? caught.message : String(caught); }
  }
  function toggleLog(): void {
    logOpen = !logOpen;
    if (logOpen && !log) void loadLog();
  }

  async function run(action: AccountAction, key: string): Promise<void> {
    confirm = null;
    menuFor = null;
    acting = key;
    try {
      const result = await api.accountAction(action);
      forgetAccounts();
      rememberAccounts("id" in action ? action.id : null, result);
      view = result;
      if (logOpen) void loadLog();
    } catch (caught) { store.toast(caught instanceof Error ? caught.message : String(caught)); }
    finally { acting = null; }
  }

  function useForThread(provider: Provider, row: PoolAccount): void {
    if (!threadId) return;
    if (row.usable) { void run({ action: "use", provider, account: row.id, id: threadId, force: false }, row.id); return; }
    confirm = { title: `Use ${row.email} anyway?`, body: `${row.email} is ${row.reason ?? "not usable"} right now. The thread will use it until you follow the pool again.`, label: "Use anyway",
      action: { action: "use", provider, account: row.id, id: threadId, force: true } };
  }
  function followPool(provider: Provider): void {
    if (threadId) void run({ action: "follow", provider, id: threadId }, "follow");
  }
  function askPin(provider: Provider, row: PoolAccount): void {
    menuFor = null;
    confirm = { title: `Pin ${row.email} for all sessions?`, body: "Every session on " + PROVIDER_LABEL[provider] + " will use this account until you unpin it.", label: "Pin",
      action: { action: "pin", provider, account: row.id } };
  }
  function askUnpin(provider: Provider): void {
    menuFor = null;
    confirm = { title: "Unpin " + PROVIDER_LABEL[provider] + "?", body: "Sessions go back to the pool's own choice.", label: "Unpin", action: { action: "unpin", provider } };
  }
  function askSwitch(provider: Provider, row: PoolAccount): void {
    menuFor = null;
    confirm = { title: `Drop the seat on ${row.email}?`, body: "The pool moves the seat to the next best account. Running sessions on this account keep their connection.", label: "Drop seat",
      action: { action: "switch", provider } };
  }
  const actionKey = (action: AccountAction): string => "account" in action ? action.account : action.action;
</script>

<aside class="drawer" class:narrow aria-label="Accounts">
  <header class="head">
    <h2>Accounts</h2>
    <span class="spacer"></span>
    <button class="icon-button" aria-label="Refresh" title="Refresh" disabled={loading} onclick={() => void load(true)}><Icon name="refresh" /></button>
    <button class="icon-button" aria-label="Close" title="Close (Esc)" onclick={() => { store.drawer = null; }}><Icon name="x" /></button>
  </header>
  {#if view}
    <div class="tabs" role="tablist">
      {#each view.providers as provider (provider.provider)}
        <button class="tab" role="tab" aria-selected={current?.provider === provider.provider} onclick={() => { tab = provider.provider; menuFor = null; }}>{PROVIDER_LABEL[provider.provider]}</button>
      {/each}
    </div>
  {/if}
  <div class="body">
    {#if error && !view}
      <div class="card error-card">
        <div class="error-title"><Icon name="alert" size={16} /> Accounts unavailable</div>
        <div class="muted">{error}</div>
        <button class="button" onclick={() => void load(true)}>Retry</button>
      </div>
    {:else if !view}
      <div class="loading muted"><span class="spinner"></span> Loading accounts</div>
    {:else if current}
      {#if error}<div class="inline-error">{error}</div>{/if}
      <div class="uses">
        {#if !threadId}
          <span>No thread selected. Each thread draws from the pool.</span>
        {:else}
          <span class:warning={!resolution?.email}>{resolutionSentence(current)}</span>
        {/if}
        {#if threadId && resolution?.pinned}
          <button class="button small" disabled={acting !== null} onclick={() => followPool(current.provider)}>Follow pool</button>
        {/if}
      </div>
      {#if current.error && current.rows.length === 0}
        <div class="inline-error">{current.error}</div>
      {/if}
      {#each rows as row (row.id)}
        {@const status = accountState(row)}
        {@const badge = STATE_LABEL[status]}
        {@const detail = stateDetail(row)}
        <div class="card account" class:busy={acting === row.id}>
          <div class="account-head">
            <span class="avatar">{initial(row.email)}</span>
            <div class="identity">
              <div class="email">{row.email}</div>
              <div class="tags">
                {#if row.plan}<span class="plan">{row.plan}</span>{/if}
                {#if row.seat && status !== "seat"}<span class="badge accent">Seat</span>{/if}
                <span class="badge {badge.tone}">{detail ?? badge.label}</span>
                {#if resolution?.account === row.id}<span class="badge accent">This thread</span>{:else if row.current}<span class="badge muted">Last used here</span>{/if}
                {#if row.pinned}<span class="badge muted">{row.force ? "Pinned, forced" : "Pinned"}</span>{/if}
              </div>
            </div>
            {#if acting === row.id}<span class="spinner"></span>{/if}
            <Popover open={menuFor === row.id} onclose={() => { menuFor = null; }} align="end" width="190px">
              {#snippet trigger()}
                <button class="icon-button" aria-label="More actions for {row.email}" onclick={() => { menuFor = menuFor === row.id ? null : row.id; }}><Icon name="more" /></button>
              {/snippet}
              <button class="menu-item" onclick={() => askPin(current.provider, row)}>Pin for all sessions</button>
              {#if row.pinned}<button class="menu-item" onclick={() => askUnpin(current.provider)}>Unpin</button>{/if}
              {#if row.seat}<button class="menu-item danger" onclick={() => askSwitch(current.provider, row)}>Drop seat</button>{/if}
            </Popover>
          </div>
          <div class="meters">
            <Meter value={row.session_pct} label="5h" />
            <Meter value={row.weekly_pct} label="Weekly" />
          </div>
          <div class="account-foot">
            <span class="score muted">{row.score === null ? "No score" : "Score " + row.score}</span>
            <span class="spacer"></span>
            {#if threadId}
              <button class="button small" disabled={acting !== null || row.current} onclick={() => useForThread(current.provider, row)}>{row.current ? "In use" : "Use for this thread"}</button>
            {/if}
          </div>
        </div>
      {/each}
      {#if view.providers.every(provider => provider.rows.length === 0)}
        <div class="muted center-note">No pooled accounts.</div>
      {/if}
      <div class="log">
        <button class="log-toggle" aria-expanded={logOpen} onclick={toggleLog}>
          <span class="chevron" class:down={logOpen}><Icon name="chevronRight" size={14} /></span> Recent pool events
        </button>
        {#if logOpen}
          <div class="log-body fade-in">
            {#if logError}
              <div class="inline-error">{logError}</div>
            {:else if !log}
              <div class="muted"><span class="spinner tiny"></span> Loading</div>
            {:else if !log.length}
              <div class="muted">No events yet.</div>
            {:else}
              {#each [...log].reverse() as event, index (event.ts + ":" + index)}
                <div class="event">
                  <span class="event-time">{relativeTime(event.ts)}</span>
                  <span class="event-text"><strong>{event.event.replaceAll("_", " ")}</strong>{event.account ? " " + event.account : ""}{event.provider ? " on " + (PROVIDER_LABEL[event.provider as Provider] ?? event.provider) : ""}{event.reason ? ", " + event.reason.replaceAll("_", " ") : ""}{event.source ? " (" + event.source + ")" : ""}</span>
                </div>
              {/each}
            {/if}
          </div>
        {/if}
      </div>
      <div class="checked muted">Checked {relativeTime(view.checkedAt) === "now" ? "just now" : relativeTime(view.checkedAt) + " ago"}</div>
    {/if}
  </div>
  {#if confirm}
    <div class="confirm-scrim" role="presentation">
      <div class="card confirm fade-in" role="alertdialog" aria-labelledby="confirm-title">
        <div class="confirm-title" id="confirm-title">{confirm.title}</div>
        <div class="muted">{confirm.body}</div>
        <div class="confirm-actions">
          <button class="button" onclick={() => { confirm = null; }}>Cancel</button>
          <button class="button primary" onclick={() => confirm && void run(confirm.action, actionKey(confirm.action))}>{confirm.label}</button>
        </div>
      </div>
    </div>
  {/if}
</aside>

<style>
  .drawer { position: relative; display: flex; flex-direction: column; flex: none; width: 400px; max-width: 100%; border-left: 1px solid var(--border); background: var(--bg-sunken); }
  .drawer.narrow { position: fixed; top: 0; right: 0; bottom: 0; z-index: 50; width: min(400px, 94vw); box-shadow: var(--shadow); }
  .head { display: flex; align-items: center; gap: 6px; padding: 10px 12px 10px 16px; border-bottom: 1px solid var(--border); }
  h2 { margin: 0; font-size: 15px; font-weight: 600; }
  .spacer { flex: 1; }
  .tabs { display: flex; gap: 4px; padding: 10px 16px 0; border-bottom: 1px solid var(--border); }
  .tab { padding: 6px 10px 10px; font-size: 14px; color: var(--text-muted); border-bottom: 2px solid transparent; margin-bottom: -1px; }
  .tab[aria-selected="true"] { color: var(--text); border-bottom-color: var(--accent); }
  .body { flex: 1; overflow-y: auto; padding: 14px 16px 20px; display: flex; flex-direction: column; gap: 12px; }
  .loading { display: flex; align-items: center; gap: 10px; padding: 24px 0; justify-content: center; }
  .uses { display: flex; align-items: center; gap: 10px; font-size: 14px; line-height: 1.4; }
  .uses span { flex: 1; }
  .uses .warning { color: var(--warning); }
  .inline-error { padding: 8px 10px; border-radius: var(--radius-small); background: var(--danger-soft); color: var(--danger); font-size: 13px; }
  .error-card { display: flex; flex-direction: column; gap: 10px; align-items: flex-start; }
  .error-title { display: flex; align-items: center; gap: 8px; font-weight: 600; color: var(--danger); }
  .account { display: flex; flex-direction: column; gap: 10px; }
  .account.busy { opacity: 0.7; }
  .account-head { display: flex; align-items: center; gap: 10px; }
  .avatar { display: inline-flex; align-items: center; justify-content: center; width: 34px; height: 34px; border-radius: 50%; background: var(--accent-soft); color: var(--accent); font-weight: 600; flex: none; }
  .identity { flex: 1; min-width: 0; }
  .email { font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tags { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-top: 2px; font-size: 12px; color: var(--text-muted); }
  .plan { text-transform: capitalize; }
  .badge { padding: 1px 7px; border-radius: 999px; font-size: 11px; font-weight: 500; background: var(--bg-active); color: var(--text-muted); }
  .badge.accent { background: var(--accent-soft); color: var(--accent); }
  .badge.success { background: rgba(47, 158, 99, 0.14); color: var(--success); }
  .badge.warning { background: rgba(201, 138, 18, 0.16); color: var(--warning); }
  .badge.danger { background: var(--danger-soft); color: var(--danger); }
  .meters { display: flex; flex-direction: column; gap: 6px; }
  .account-foot { display: flex; align-items: center; gap: 8px; font-size: 12px; }
  .center-note { text-align: center; padding: 16px 0; }
  .log-toggle { display: flex; align-items: center; gap: 6px; font-size: 13px; color: var(--text-muted); padding: 4px 0; }
  .chevron { display: inline-flex; transition: transform 0.15s ease; }
  .chevron.down { transform: rotate(90deg); }
  .log-body { display: flex; flex-direction: column; gap: 6px; padding: 8px 0 0 4px; font-size: 13px; }
  .event { display: flex; gap: 10px; align-items: baseline; }
  .event-time { flex: none; width: 40px; color: var(--text-faint); font-size: 12px; font-variant-numeric: tabular-nums; }
  .event-text { overflow-wrap: anywhere; }
  .checked { font-size: 12px; }
  .spinner.tiny { width: 11px; height: 11px; border-width: 1.5px; }
  .confirm-scrim { position: absolute; inset: 0; z-index: 10; display: flex; align-items: center; justify-content: center; padding: 20px; background: rgba(0, 0, 0, 0.25); }
  .confirm { display: flex; flex-direction: column; gap: 10px; width: 100%; max-width: 340px; box-shadow: var(--shadow); }
  .confirm-title { font-weight: 600; }
  .confirm-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 4px; }
</style>
