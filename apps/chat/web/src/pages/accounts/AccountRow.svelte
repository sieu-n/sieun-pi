<script lang="ts">
  import type { PoolAccount, PoolConfig, PoolProvider, UsageRefreshAccount } from "$lib/api/shared/types.ts";
  import { Button, IconButton, Meter, Spinner, tooltip } from "$lib/ui";
  import { accountState, isManualAccount, pendingReset, planText, resetText, rowNotes, shownName, span, STATE_LABEL, staleText, threadsText, usableGrant, windowLabel } from "./model";

  /**
   * One account on one line: label, plan, threads, a meter per usage window, a status cell and the row actions.
   * The status cell names what stops the account first and carries the row's plain-words notes as its tooltip.
   */
  let {
    row, provider, columns, now, thread, read, refreshing, busy, locked, loginRunning, poolConfig, menuOpen,
    onuse, onrefresh, onreset, onenable, onlogin, onmore, onopen,
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
    /** Opens the account's detail with its full numbers and threads. */
    onopen: () => void;
  } = $props();

  /** A click on the row's empty space opens the detail; a click on one of its controls does its own thing. */
  function rowClick(event: MouseEvent): void {
    if (!(event.target instanceof Element) || event.target.closest("button, a, input, select")) return;
    onopen();
  }

  const status = $derived(accountState(row));
  const manual = $derived(isManualAccount(provider, row.id));
  const inUse = $derived(manual || row.id === provider.resolution?.account);
  const role = $derived(manual ? "Manual" : thread ? "Auto" : "Next request");
  const roleHint = $derived(manual ? "This thread stays on this account." : thread ? "Auto picks this account for the thread." : "A new thread starts on this account.");
  const threads = $derived(threadsText(row, poolConfig));
  const pending = $derived(pendingReset(row.resets, now));
  const grant = $derived(usableGrant(row.resets, now));
  const notes = $derived(rowNotes(row, now, read?.state === "failed" ? read.reason : null));
  /** The status cell's tooltip: what the in-use mark means, then the row's notes. */
  const hint = $derived([inUse ? roleHint : null, ...notes].filter(Boolean).join(" "));
  /** How old the usage numbers are, once pi-pool calls them stale (20 min), for a row with nothing worse to say. */
  const stale = $derived(status || !staleText(row, now) ? null : row.usageAt ? `Usage ${span(now - row.usageAt)} old` : "Usage never read");
  const pickable = $derived(thread !== null && !manual && !locked);
  let more = $state<HTMLButtonElement>();
</script>

<!-- The row's click is a mouse shortcut; the name button opens the same detail from the keyboard. -->
<!-- svelte-ignore a11y_click_events_have_key_events -->
<div class="row" role="row" tabindex="-1" class:in-use={inUse} class:off={row.disabled} class:dead={status === "needs-login"} class:busy data-testid="account-row" data-account={row.id}
  onclick={rowClick}>
  <div class="who" role="cell">
    <button type="button" class="label" title={row.name ? `${row.name}, ${row.label}` : row.email} aria-haspopup="dialog" onclick={onopen}>{shownName(row)}</button>
  </div>
  <div class="plan" role="cell">{planText(row) ?? ""}</div>
  <div class="threads" role="cell">
    {#if threads}<button type="button" class="count" use:tooltip={threads.hint} aria-label={threads.label} aria-haspopup="dialog" onclick={onopen}>{row.sessions}</button>{/if}
  </div>
  {#each columns as column (column)}
    {@const window = row.windows.find(entry => windowLabel(entry) === column)}
    <div class="cell" role="cell">
      {#if window}
        {@const resets = resetText(window, now)}
        <span class="nums">
          <span class="pct">{Math.round(window.pct)}%</span>
          {#if window.resetsAt && window.resetsAt > now}<span class="reset">{span(window.resetsAt - now)}</span>{/if}
        </span>
        <Meter percent={window.pct} compact title="{column}: {Math.round(window.pct)}% used{resets ? `, ${resets}` : ''}" />
      {/if}
    </div>
  {/each}
  <div class="status" role="cell" data-testid="account-status" use:tooltip={hint ? { text: hint, placement: "bottom" } : null}>
    {#if inUse}<span class="tag accent">{role}</span>{/if}
    {#if status}<span class="tag {STATE_LABEL[status].tone}">{STATE_LABEL[status].label}</span>{/if}
    {#if pending}<span class="tag warning">Reset unknown</span>
    {:else if grant}<span class="tag success">{grant.resetsLeft} reset{grant.resetsLeft === 1 ? "" : "s"}</span>{/if}
    {#if stale && !inUse && !pending && !grant}<span class="quiet">{stale}</span>{/if}
  </div>
  <div class="actions" role="cell">
    {#if read?.state === "queued"}<span class="read-state">Queued</span>
    {:else if read?.state === "reading"}<span class="read-state"><Spinner size={12} /> Reading</span>
    {:else}
      {#if read?.state === "read"}<span class="read-state ok">Updated</span>
      {:else if read?.state === "failed"}<span class="read-state bad" use:tooltip={read.reason ? `Not read: ${read.reason.replace(/\.$/, "")}.` : null}>Not read</span>{/if}
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
      <Button size="sm" variant="ghost" disabled={locked} onclick={onenable}>Turn on</Button>
    {:else if status === "needs-login"}
      <Button size="sm" variant="ghost" disabled={loginRunning} onclick={onlogin}>Sign in again</Button>
    {/if}
    <IconButton bind:element={more} icon="more" label="More actions for {row.label}" size="sm" aria-haspopup="menu" aria-expanded={menuOpen}
      onclick={() => more && onmore(more)} />
  </div>
</div>

<style>
  .row {
    display: grid; grid-template-columns: subgrid; grid-column: 1 / -1; align-items: center; column-gap: inherit;
    position: relative; min-height: 40px; padding: 0 var(--space-2) 0 var(--space-3); border-radius: var(--radius-row);
    transition: background-color var(--duration-fast, 0.12s);
  }
  .row::before { content: ""; position: absolute; top: 0; inset-inline: var(--space-3); border-top: 1px solid var(--border-standard); }
  .row:hover { background: var(--affordance-ghost-hover); }
  .row:hover::before, .row:hover + :global(.row)::before { border-top-color: transparent; }
  .row.in-use { background: var(--affordance-sidebar-hover); }
  .row.in-use::before, .row.in-use + :global(.row)::before { border-top-color: transparent; }
  .row.off > :not(.actions, .status), .row.dead > :not(.actions, .status) { opacity: 0.5; }
  .row.busy { opacity: 0.7; }
  .who { min-width: 0; }
  .row { cursor: pointer; }
  .label { display: block; max-width: 100%; padding: 0; border: 0; background: none; overflow: hidden; color: var(--text-standard); font: var(--text-body-sm); text-align: left; text-overflow: ellipsis; white-space: nowrap; cursor: pointer; }
  .label:hover { text-decoration: underline; text-decoration-color: var(--border-standard); }
  .count { padding: 0 var(--space-1); margin-left: calc(-1 * var(--space-1)); border: 0; border-radius: var(--radius-chip, 4px); background: none; color: inherit; font: inherit; cursor: pointer; }
  .count:hover { background: var(--affordance-ghost-hover); color: var(--text-standard); }
  .plan, .threads { overflow: hidden; color: var(--text-subtle); font: var(--text-body-sm); white-space: nowrap; font-variant-numeric: tabular-nums; }
  .cell { display: flex; flex-direction: column; gap: 3px; min-width: 0; font-variant-numeric: tabular-nums; }
  .nums { display: flex; align-items: baseline; justify-content: space-between; gap: var(--space-2); }
  .pct { color: var(--text-standard); font: var(--text-caption); font-weight: 500; }
  .reset { overflow: hidden; color: var(--text-subtle); font: var(--text-caption); text-overflow: ellipsis; white-space: nowrap; }
  .status { display: flex; align-self: stretch; align-items: center; gap: var(--space-1-5); min-width: 0; overflow: hidden; white-space: nowrap; font: var(--text-caption); }
  .tag { display: inline-flex; align-items: center; gap: 5px; color: var(--text-standard); }
  .tag::before { content: ""; flex: none; width: 6px; height: 6px; border-radius: 50%; background: var(--text-subtle); }
  .tag.accent::before { background: var(--affordance-accent-prominent); }
  .tag.success::before { background: var(--status-online); }
  .tag.warning::before { background: var(--status-away); }
  .tag.danger { color: var(--text-danger); }
  .tag.danger::before { background: var(--border-danger); }
  .tag.muted { color: var(--text-subtle); }
  .quiet { overflow: hidden; color: var(--text-subtle); text-overflow: ellipsis; }
  .actions { display: flex; align-items: center; justify-content: flex-end; gap: var(--space-1); white-space: nowrap; }
  .read-state { display: inline-flex; align-items: center; gap: var(--space-1); padding: 0 var(--space-1); color: var(--text-subtle); font: var(--text-caption); }
  .read-state.ok { color: var(--status-online-border); }
  .read-state.bad { color: var(--text-danger); cursor: default; }
  .reveal { display: inline-flex; opacity: 0; transition: opacity var(--duration-fast, 0.12s); }
  .row:hover .reveal, .reveal:focus-within { opacity: 1; }
</style>
