<script lang="ts">
  import type { PoolAccount, PoolConfig, PoolProvider, UsageRefreshAccount } from "$lib/api/shared/types.ts";
  import { Badge, Button, IconButton, Meter, Spinner, tooltip } from "$lib/ui";
  import { accountState, isManualAccount, pendingReset, planText, resetText, rowNotes, STATE_LABEL, threadsText, usableGrant, windowLabel, type Tone } from "./model";

  /** One account in the table: its label, plan and badges, a meter per usage window, the row actions and the plain-words notes. */
  let {
    row, provider, columns, now, thread, read, refreshing, busy, locked, loginRunning, poolConfig, menuOpen,
    onuse, onrefresh, onreset, onenable, onlogin, onmore,
  }: {
    row: PoolAccount;
    provider: PoolProvider;
    columns: string[];
    now: number;
    /** The thread the page is for, or null for the whole pool. */
    thread: string | null;
    /** This row's state in the usage refresh the page watches. */
    read: UsageRefreshAccount | undefined;
    refreshing: boolean;
    /** An action on this row is running. */
    busy: boolean;
    /** Some action is running, so the row's own buttons wait. */
    locked: boolean;
    loginRunning: boolean;
    poolConfig: PoolConfig | null;
    menuOpen: boolean;
    onuse: () => void;
    onrefresh: () => void;
    onreset: () => void;
    onenable: () => void;
    onlogin: () => void;
    onmore: (anchor: HTMLElement) => void;
  } = $props();

  const BADGE: Record<Tone, "accent" | "success" | "neutral" | "warning" | "danger"> = { accent: "accent", success: "success", muted: "neutral", warning: "warning", danger: "danger" };

  const status = $derived(accountState(row));
  const manual = $derived(isManualAccount(provider, row.id));
  const inUse = $derived(manual || row.id === provider.resolution?.account);
  const threads = $derived(threadsText(row, poolConfig));
  const pending = $derived(pendingReset(row.resets, now));
  const grant = $derived(usableGrant(row.resets, now));
  const notes = $derived(rowNotes(row, now, read?.state === "failed" ? read.reason : null));
  const pickable = $derived(thread !== null && !manual && !locked);
  let more = $state<HTMLButtonElement>();
</script>

<div class="row" role="row" class:in-use={inUse} class:off={row.disabled} class:dead={status === "needs-login"} class:busy data-testid="account-row" data-account={row.id}>
  <div class="who" role="cell">
    <div class="label" title={row.email}>{row.label}</div>
    <div class="sub">
      {#if planText(row)}<span>{planText(row)}</span>{/if}
      {#if threads}<span class="threads" use:tooltip={threads.hint}>{threads.label}</span>{/if}
      {#if status}<Badge tone={BADGE[STATE_LABEL[status].tone]} value={STATE_LABEL[status].label} />{/if}
      {#if pending}<Badge tone="warning" value="Reset unknown" />
      {:else if grant}<Badge tone="success" value="{grant.resetsLeft} reset{grant.resetsLeft === 1 ? '' : 's'}" />{/if}
      {#if inUse}<Badge tone="accent" value={manual ? "Manual" : thread ? "Auto" : "Next request"} />{/if}
    </div>
  </div>
  {#each columns as column (column)}
    {@const window = row.windows.find(entry => windowLabel(entry) === column)}
    <div class="cell" role="cell">
      {#if window}
        {@const resets = resetText(window, now)}
        <Meter percent={window.pct} title="{column}: {Math.round(window.pct)}% used{resets ? `, ${resets}` : ''}" />
        <span class="reset">{resets ?? ""}</span>
      {/if}
    </div>
  {/each}
  <div class="actions" role="cell">
    {#if read?.state === "queued"}<span class="read-state">Queued</span>
    {:else if read?.state === "reading"}<span class="read-state"><Spinner size={12} /> Reading</span>
    {:else}
      {#if read?.state === "read"}<span class="read-state ok">Updated</span>
      {:else if read?.state === "failed"}<span class="read-state bad">Not read</span>{/if}
      <span class="reveal">
        <IconButton icon="refresh" label="Refresh usage for {row.label}" size="sm" disabled={refreshing} onclick={onrefresh} />
      </span>
    {/if}
    {#if busy}<Spinner size={14} />
    {:else if pickable}<span class="reveal"><Button size="sm" variant="ghost" aria-label="Use {row.label} in this thread" onclick={onuse}>Use in this thread</Button></span>{/if}
    {#if !row.disabled && (pending || grant)}
      <Button size="sm" variant="outline" disabled={locked} onclick={onreset}>{pending ? "Retry reset" : "Use reset"}</Button>
    {/if}
    {#if row.disabled}
      <Button size="sm" variant="outline" disabled={locked} onclick={onenable}>Turn on</Button>
    {:else if status === "needs-login"}
      <Button size="sm" variant="outline" disabled={loginRunning} onclick={onlogin}>Sign in again</Button>
    {/if}
    <IconButton bind:element={more} icon="more" label="More actions for {row.label}" size="sm" aria-haspopup="menu" aria-expanded={menuOpen}
      onclick={() => more && onmore(more)} />
  </div>
  {#if notes.length}
    <div class="notes">{#each notes as note (note)}<span>{note}</span>{/each}</div>
  {/if}
</div>

<style>
  .row {
    display: grid; grid-template-columns: subgrid; grid-column: 1 / -1; align-items: center; column-gap: var(--space-4);
    padding: var(--space-2) var(--space-3); border-top: 1px solid var(--border-standard); border-radius: var(--radius-row);
    transition: background-color var(--duration-fast, 0.12s);
  }
  .row:hover { background: var(--affordance-ghost-hover); border-top-color: transparent; }
  .row:hover + :global(.row) { border-top-color: transparent; }
  .row.in-use { background: var(--affordance-sidebar-hover); border-top-color: transparent; }
  .row.in-use + :global(.row) { border-top-color: transparent; }
  .row.off .who, .row.off .cell, .row.dead .who, .row.dead .cell { opacity: 0.5; }
  .row.busy { opacity: 0.7; }
  .who { min-width: 0; }
  .label { overflow: hidden; color: var(--text-standard); font: var(--text-label-sm); text-overflow: ellipsis; white-space: nowrap; }
  .sub { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-1-5); margin-top: var(--space-half); color: var(--text-subtle); font: var(--text-caption); }
  .threads { cursor: default; }
  .cell { display: flex; flex-direction: column; gap: var(--space-half); min-width: 0; font-variant-numeric: tabular-nums; }
  .reset { min-height: 16px; overflow: hidden; color: var(--text-subtle); font: var(--text-caption); text-overflow: ellipsis; white-space: nowrap; }
  .actions { display: flex; align-items: center; justify-content: flex-end; gap: var(--space-1); white-space: nowrap; }
  .read-state { display: inline-flex; align-items: center; gap: var(--space-1); padding: 0 var(--space-1); color: var(--text-subtle); font: var(--text-caption); }
  .read-state.ok { color: var(--status-online-border); }
  .read-state.bad { color: var(--border-danger); }
  .reveal { display: inline-flex; opacity: 0; transition: opacity var(--duration-fast, 0.12s); }
  .row:hover .reveal, .reveal:focus-within { opacity: 1; }
  .notes { display: flex; flex-wrap: wrap; grid-column: 1 / -1; gap: var(--space-1) var(--space-3); margin-top: var(--space-1); color: var(--text-subtle); font: var(--text-caption); }
</style>
