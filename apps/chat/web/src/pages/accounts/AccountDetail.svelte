<script lang="ts">
  import type { AccountThread, PoolAccount, PoolConfig, PoolProvider } from "$lib/api/shared/types.ts";
  import { Button, Dialog, Input, Meter, Spinner } from "$lib/ui";
  import { accountsApi } from "./api";
  import { accountState, clockText, planText, resetNote, rowNotes, shownName, span, STATE_LABEL, threadsText, windowLabel } from "./model";

  /**
   * One account in full: its name (which a person can change), every usage window with its exact share and reset time, its notes, its banked
   * resets and the threads on it, each a link that opens the thread. The row menu keeps every other action.
   */
  let {
    open = $bindable(), row, provider, now, poolConfig, refreshing, locked, onrename, onrefresh, ontoggle, onremove,
  }: {
    open: boolean;
    row: PoolAccount;
    provider: PoolProvider;
    now: number;
    poolConfig: PoolConfig | null;
    refreshing: boolean;
    /** Some action is running, so the buttons wait. */
    locked: boolean;
    /** Saves the name, or clears it with null; resolves once the server has it. */
    onrename: (name: string | null) => Promise<void>;
    onrefresh: () => void;
    ontoggle: () => void;
    onremove: () => void;
  } = $props();

  let name = $state("");
  let saving = $state(false);
  let threads = $state<AccountThread[] | null>(null);
  let threadsError = $state<string | null>(null);

  $effect(() => {
    name = row.name ?? "";
  });
  $effect(() => {
    const id = row.id;
    threads = null;
    threadsError = null;
    accountsApi.threads(provider.provider, id).then(
      list => { if (row.id === id) threads = list; },
      caught => { if (row.id === id) threadsError = caught instanceof Error ? caught.message : String(caught); },
    );
  });

  const status = $derived(accountState(row));
  const notes = $derived(rowNotes(row, now).filter(note => note !== resetNote(row.resets, now)));
  const resets = $derived(resetNote(row.resets, now));
  const count = $derived(threadsText(row, poolConfig));
  const changed = $derived(name.trim() !== (row.name ?? ""));
  const pct = (value: number): string => `${Number.isInteger(value) ? value : value.toFixed(1)}%`;

  async function save(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (!changed || saving) return;
    saving = true;
    try {
      await onrename(name.trim() || null);
    } finally {
      saving = false;
    }
  }
</script>

<Dialog bind:open title={shownName(row)} description={row.name ? row.label : undefined} width={560}>
  <div class="detail" data-testid="account-detail">
    <form class="name" onsubmit={save}>
      <label for="account-name">Name</label>
      <Input id="account-name" bind:value={name} size="sm" placeholder={row.label} maxlength={80} autocomplete="off" spellcheck="false" />
      <Button type="submit" size="sm" variant="outline" loading={saving} disabled={!changed}>{name.trim() || !row.name ? "Save" : "Clear name"}</Button>
    </form>

    <dl class="facts">
      {#if status}<dt>State</dt><dd class:danger={STATE_LABEL[status].tone === "danger"}>{STATE_LABEL[status].label}</dd>{/if}
      {#if planText(row)}<dt>Plan</dt><dd>{planText(row)}</dd>{/if}
      <dt>Usage read</dt><dd>{row.usageAt ? `${clockText(row.usageAt, now)}, ${span(now - row.usageAt)} ago` : "Never"}</dd>
      <dt>Account id</dt><dd class="mono">{row.id}</dd>
    </dl>

    {#if notes.length}
      <ul class="notes">{#each notes as note (note)}<li>{note}</li>{/each}</ul>
    {/if}

    {#if row.windows.length}
      <table class="windows">
        <thead><tr><th scope="col">Window</th><th scope="col">Used</th><th scope="col" class="bar"><span class="sr-only">Bar</span></th><th scope="col">Resets</th></tr></thead>
        <tbody>
          {#each row.windows as window (window.label)}
            <tr>
              <th scope="row">{windowLabel(window)}</th>
              <td class="num">{pct(window.pct)}</td>
              <td class="bar"><Meter percent={window.pct} compact title="{windowLabel(window)}: {pct(window.pct)} used" /></td>
              <td>{window.resetsAt && window.resetsAt > now ? `${clockText(window.resetsAt, now)}, in ${span(window.resetsAt - now)}` : "No reset time"}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    {/if}

    {#if resets}<p class="resets">{resets}</p>{/if}

    <section class="threads" aria-label="Threads on this account" data-testid="account-threads">
      <h3>{count ? count.label : "No threads"}<span>{count ? ` in the last ${Math.round((poolConfig?.["active_session_sec"] ?? 3600) / 60)} min` : ""}</span></h3>
      {#if threadsError}
        <p class="quiet" title={threadsError}>The thread list did not load.</p>
      {:else if threads === null}
        {#if row.sessions}<p class="quiet"><Spinner size={12} /> Loading</p>{/if}
      {:else if threads.length}
        <ul>
          {#each threads as entry (entry.tree)}
            <li>
              {#if entry.href}<a href={entry.href} onclick={() => (open = false)}>{entry.name}</a>{:else}<span>{entry.name}</span>{/if}
              <span class="quiet">{span(now - entry.at)} ago{entry.requests !== null ? `, ${entry.requests} requests` : ""}</span>
            </li>
          {/each}
        </ul>
      {:else if row.sessions}
        <p class="quiet">The pool lists no thread on it now.</p>
      {/if}
    </section>
  </div>
  {#snippet actions()}
    <Button size="sm" variant="ghost" class="remove-account" onclick={onremove}>Remove</Button>
    <span class="spacer"></span>
    <Button size="sm" variant="outline" disabled={locked} onclick={ontoggle}>{row.disabled ? "Turn on" : "Turn off"}</Button>
    <Button size="sm" variant="outline" icon="refresh" disabled={refreshing} onclick={onrefresh}>Refresh usage</Button>
  {/snippet}
</Dialog>

<style>
  .detail { display: flex; flex-direction: column; gap: var(--space-4); color: var(--text-standard); font: var(--text-body-sm); }
  .name { display: grid; grid-template-columns: auto 1fr auto; align-items: center; gap: var(--space-2) var(--space-3); }
  .name label { color: var(--text-subtle); }
  .facts { display: grid; grid-template-columns: max-content 1fr; gap: var(--space-1) var(--space-4); margin: 0; }
  .facts dt { color: var(--text-subtle); }
  .facts dd { margin: 0; min-width: 0; overflow-wrap: anywhere; font-variant-numeric: tabular-nums; }
  .facts dd.danger { color: var(--text-danger); }
  .mono { font-family: var(--font-mono); font-size: 12px; }
  .notes { display: flex; flex-direction: column; gap: var(--space-1); margin: 0; padding-left: var(--space-4); color: var(--text-subtle); }
  .windows { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
  .windows th, .windows td { padding: var(--space-1-5) var(--space-2) var(--space-1-5) 0; border-bottom: 1px solid var(--border-standard); text-align: left; font-weight: 400; }
  .windows thead th { color: var(--text-subtle); font: var(--text-caption); }
  .windows .num { text-align: right; width: 4rem; }
  .windows .bar { width: 6rem; }
  .resets { margin: 0; color: var(--text-subtle); }
  .threads h3 { margin: 0 0 var(--space-2); font: var(--text-label-sm); }
  .threads h3 span { color: var(--text-subtle); font-weight: 400; }
  .threads ul { display: flex; flex-direction: column; gap: var(--space-1); max-height: 14rem; margin: 0; padding: 0; overflow: auto; list-style: none; }
  .threads li { display: flex; justify-content: space-between; gap: var(--space-3); }
  .threads a { overflow: hidden; color: var(--text-standard); text-decoration: underline; text-decoration-color: var(--border-standard); text-overflow: ellipsis; white-space: nowrap; }
  .quiet { display: inline-flex; align-items: center; gap: var(--space-1); margin: 0; color: var(--text-subtle); white-space: nowrap; }
  .spacer { flex: 1; }
  :global(.btn.remove-account) { color: var(--text-danger); }
  .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
</style>
