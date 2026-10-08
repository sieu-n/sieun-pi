<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import { api } from "./api.ts";
  import { store } from "./store.svelte.ts";
  import type { SlackInput, SlackView } from "../shared/types.ts";
  import Icon from "./Icon.svelte";
  import Checkbox from "./ui/Checkbox.svelte";
  import { tooltip } from "./ui/tooltip.ts";

  /** null after a load: this chat instance runs no Slack bridge. undefined while loading. */
  let view = $state<SlackView | null | undefined>(undefined);
  let error = $state<string | null>(null);
  let busy = $state(false);
  let owner = $state("");
  let ownerTouched = $state(false);
  let timer: ReturnType<typeof setInterval> | undefined;

  const dotState = $derived(view?.state === "on" ? "on" : view?.state === "problem" ? "problem" : "off");

  async function load(): Promise<void> {
    try {
      view = await api.slack();
      store.slack = view;
      error = null;
      if (view && !ownerTouched) owner = view.ownerUserId ?? "";
    } catch (reason) { error = reason instanceof Error ? reason.message : String(reason); }
  }
  async function apply(request: Promise<SlackView>): Promise<void> {
    busy = true;
    const next = await store.run(request);
    if (next) { view = next; store.slack = next; ownerTouched = false; owner = next.ownerUserId ?? ""; }
    busy = false;
  }
  const set = (input: SlackInput) => apply(api.setSlack(input));
  onMount(() => {
    void load();
    timer = setInterval(() => { void load(); }, 5000);
  });
  onDestroy(() => clearInterval(timer));
</script>

<section class="slack" aria-label="Slack">
  <header class="bar">
    <h3>Slack</h3>
    <span class="spacer"></span>
    <button class="icon-button small" disabled={busy || !view} aria-label="Read the tokens again" use:tooltip={"Read the tokens again"} onclick={() => void apply(api.checkSlack())}>
      {#if busy}<span class="spinner tiny"></span>{:else}<Icon name="refresh" size={14} />{/if}
    </button>
  </header>
  {#if error && view === undefined}
    <div class="empty">
      <div class="error"><Icon name="alert" size={16} /> Slack status unavailable. {error}</div>
      <button class="button small" onclick={() => void load()}>Retry</button>
    </div>
  {:else if view === undefined}
    <div class="empty muted"><span class="spinner"></span> Loading Slack</div>
  {:else if view === null}
    <p class="note">Only the main chat instance in ~/.prime/agent/browser-chat links chats to Slack.</p>
  {:else}
    <p class="current {dotState}" aria-live="polite">
      {#if view.state === "connecting"}<span class="spinner tiny"></span>{:else}<span class="dot" aria-hidden="true"></span>{/if}
      <span>{view.message}</span>
    </p>

    <button type="button" class="toggle" role="switch" aria-checked={view.enabled} disabled={!view.editable || busy} onclick={() => void set({ enabled: !view?.enabled })}>
      <Checkbox visual checked={view.enabled} />
      <span class="text">
        <span class="label">Connect Slack</span>
        <span class="note">No chat is synced until you turn on Sync to Slack in its header or when you create it. A synced chat gets a private channel #vp-&lt;chat name&gt;: what you write there goes to the chat, its replies and pings come back. Archiving the chat archives the channel. Messages you type here are not copied to Slack.</span>
      </span>
    </button>

    <form class="owner" onsubmit={event => { event.preventDefault(); void set({ ownerUserId: owner.trim() || null }); }}>
      <label for="slack-owner" class="label">Your Slack member id</label>
      <div class="row">
        <input id="slack-owner" class="field" placeholder="U012ABCDEF" bind:value={owner} oninput={() => { ownerTouched = true; }} disabled={!view.editable || busy} autocomplete="off" spellcheck="false" />
        <button class="button small" type="submit" disabled={!view.editable || busy || !ownerTouched}>Save</button>
      </div>
      <p class="note">Only messages from this member reach the chats. In Slack: your profile, the three dots, Copy member ID.</p>
    </form>

    <dl class="facts">
      <dt>Workspace</dt><dd>{view.teamName ? `${view.teamName} (${view.teamId})` : "Not connected yet"}</dd>
      <dt>Synced chats</dt><dd>{view.channels}</dd>
      <dt>Tokens</dt><dd>{view.tokenSource === "keychain" ? "Keychain" : view.tokenSource === "environment" ? "Environment" : "Not found"}</dd>
    </dl>
    {#if !view.tokenSource}
      <p class="note">Save the bot token (xoxb-) and the app-level token (xapp-) in the Keychain, then press the refresh button:</p>
      <code class="command">security add-generic-password -U -s {view.keychainService} -a bot-token -w</code>
      <code class="command">security add-generic-password -U -s {view.keychainService} -a app-token -w</code>
    {/if}
    {#if !view.editable}<p class="note">You opened this page from another device. Change Slack on the Mac that runs the chat.</p>{/if}
  {/if}
</section>

<style>
  .slack { display: flex; flex-direction: column; gap: 14px; padding: 12px 18px 18px; font-size: 13px; }
  .bar { display: flex; align-items: center; gap: 6px; border-bottom: 1px solid var(--border); margin: 0 -18px; padding: 0 18px 8px; }
  h3 { margin: 0; font-size: 13px; font-weight: 600; }
  .spacer { flex: 1; }
  .current { display: flex; align-items: center; gap: 8px; margin: 0; font-size: 14px; font-weight: 500; line-height: 1.4; }
  .dot { flex: none; width: 8px; height: 8px; border-radius: 50%; background: var(--text-muted); }
  .current.on .dot { background: var(--success, #2e9e5b); }
  .current.problem .dot { background: var(--danger); }
  .current.problem { color: var(--danger); }
  .toggle { display: flex; align-items: flex-start; gap: 10px; width: 100%; padding: 10px 12px; text-align: left; border: 1px solid var(--border); border-radius: var(--radius); background: var(--bg-elevated); }
  .toggle:hover:not(:disabled) { background: var(--bg-hover); }
  .toggle:disabled { cursor: default; opacity: 0.75; }
  .toggle :global(.box) { margin-top: 2px; }
  .text { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
  .label { font-weight: 500; }
  .note { margin: 0; color: var(--text-muted); line-height: 1.45; }
  .owner { display: flex; flex-direction: column; gap: 6px; }
  .row { display: flex; gap: 8px; align-items: center; }
  .row .field { width: 220px; }
  .facts { display: grid; grid-template-columns: max-content 1fr; gap: 4px 14px; margin: 0; }
  .facts dt { color: var(--text-muted); }
  .facts dd { margin: 0; }
  .command { display: block; padding: 6px 8px; border-radius: var(--radius-small); background: var(--bg-sunken); font-size: 12px; overflow-wrap: anywhere; user-select: all; }
  .empty { display: flex; align-items: center; justify-content: center; gap: 10px; padding: 32px 0; }
  .error { display: flex; align-items: center; gap: 8px; color: var(--danger); }
</style>
