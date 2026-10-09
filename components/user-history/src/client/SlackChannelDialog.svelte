<script lang="ts" module>
  /** What Connect sends: a channel to create (or reuse by name), or an existing channel's id or #name. */
  export type SlackConnectInput = { name: string; isPrivate: boolean } | { existing: string };
</script>

<script lang="ts">
  import { untrack } from "svelte";
  import Modal from "./Modal.svelte";
  import ConfirmDialog from "./ConfirmDialog.svelte";
  import SlackLogo from "./SlackLogo.svelte";
  import { CHANNEL_NAME_MAX, CHANNEL_NAME_RULE, channelNameError, defaultChannelName, slackChannelUrl } from "../shared/slack-channel.ts";
  import type { SlackChannelOption, SlackChannelSetup, SlackChatLink } from "../shared/types.ts";

  /**
   * The one Slack dialog, opened from the chat header and from the new-chat screen. Not synced: a channel name (prefilled, checked like Slack checks it),
   * private or public, or an existing channel. Synced: the channel with its Open in Slack link, a rename, and Stop syncing behind a confirm.
   * Nothing here turns sync off by accident: the only way off is Stop syncing, then its confirm.
   */
  let { chatName, link = null, teamId = null, draft = null, channels = null, onconnect, onrename, onstop, onclear, onclose }: {
    chatName: string;
    /** The chat's channel now; null while the chat is not synced. */
    link?: SlackChatLink | null;
    teamId?: string | null;
    /** The new-chat screen: the channel chosen for a chat that does not exist yet. */
    draft?: SlackChannelSetup | null;
    /** Loads the channels the bot can see; null hides the existing-channel choice (the new-chat screen has none). */
    channels?: (() => Promise<SlackChannelOption[] | null>) | null;
    /** Resolves true when the dialog may close. */
    onconnect: (input: SlackConnectInput) => Promise<boolean>;
    onrename?: (name: string) => Promise<boolean>;
    onstop?: () => Promise<boolean>;
    /** The new-chat screen: drop the draft, the chat starts without Slack. */
    onclear?: () => void;
    onclose: () => void;
  } = $props();

  // The fields start from the props as they were when the dialog opened; the dialog is remounted on each open.
  const initial = untrack(() => ({ name: draft?.name ?? defaultChannelName(chatName), isPrivate: draft?.isPrivate ?? true, rename: link?.name ?? "", listed: channels !== null }));
  let name = $state(initial.name);
  let isPrivate = $state(initial.isPrivate);
  let source = $state<"new" | "existing">("new");
  let existing = $state("");
  /** undefined while loading, null when the bot cannot list (the field takes an id or #name instead). */
  let list = $state<SlackChannelOption[] | null | undefined>(initial.listed ? undefined : null);
  let rename = $state(initial.rename);
  let busy = $state(false);
  let stopping = $state(false);

  const nameError = $derived(channelNameError(name));
  const renameError = $derived(channelNameError(rename));
  const canConnect = $derived(!busy && (source === "new" ? nameError === null : existing.trim() !== ""));
  const canRename = $derived(!busy && link !== null && rename !== link.name && renameError === null);
  const title = $derived(link ? `Slack: #${link.name}` : draft ? "Slack channel for the new chat" : "Connect to Slack");

  $effect(() => {
    if (!channels || list !== undefined) return;
    channels().then(result => { list = result; if (result?.length) existing = result[0]!.id; }, () => { list = null; });
  });

  async function run(work: () => Promise<boolean>): Promise<void> {
    if (busy) return;
    busy = true;
    try { if (await work()) onclose(); } finally { busy = false; }
  }
  const connect = () => run(() => onconnect(source === "new" ? { name, isPrivate } : { existing: existing.trim() }));
  const save = () => run(() => onrename?.(rename) ?? Promise.resolve(false));
  const stop = () => run(async () => { const done = await (onstop?.() ?? Promise.resolve(false)); stopping = false; return done; });
</script>

<Modal {title} width="460px" {onclose}>
  {#snippet header()}<SlackLogo size={16} />{/snippet}
  {#if link}
    <div class="body">
      <p class="current">
        <span class="channel">#{link.name}</span>
        <span class="kind">{link.isPrivate ? "Private" : "Public"}</span>
        {#if teamId}<a class="open" href={slackChannelUrl(teamId, link.channel)} target="_blank" rel="noopener">Open in Slack</a>{/if}
      </p>
      <p class="note">What you write in the channel steers <strong>{chatName.trim() || "this chat"}</strong>; its replies and pings come back there.</p>
      <form class="rename" onsubmit={event => { event.preventDefault(); if (canRename) void save(); }}>
        <label class="label" for="slack-rename">Channel name</label>
        <div class="row">
          <span class="hash">#</span>
          <input id="slack-rename" class="field" bind:value={rename} maxlength={CHANNEL_NAME_MAX} autocomplete="off" spellcheck="false" autocapitalize="off" />
          <button type="submit" class="button small" disabled={!canRename}>{#if busy}<span class="spinner tiny"></span>{/if}Rename</button>
        </div>
        <p class="rule" class:bad={rename !== link.name && renameError !== null}>{rename !== link.name && renameError ? renameError : CHANNEL_NAME_RULE}</p>
      </form>
      <div class="actions">
        <button type="button" class="button danger" disabled={busy} onclick={() => { stopping = true; }}>Stop syncing</button>
        <span class="spacer"></span>
        <button type="button" class="button" onclick={onclose}>Done</button>
      </div>
    </div>
  {:else}
    <form class="body" onsubmit={event => { event.preventDefault(); if (canConnect) void connect(); }}>
      <p class="note">The chat gets a Slack channel. What you write there steers <strong>{chatName.trim() || "the chat"}</strong>; its replies and pings come back there.</p>
      {#if channels}
        <div class="segmented" role="radiogroup" aria-label="Channel">
          <button type="button" role="radio" aria-checked={source === "new"} class:on={source === "new"} onclick={() => { source = "new"; }}>New channel</button>
          <button type="button" role="radio" aria-checked={source === "existing"} class:on={source === "existing"} onclick={() => { source = "existing"; }}>Existing channel</button>
        </div>
      {/if}
      {#if source === "new"}
        <label class="label" for="slack-name">Channel name</label>
        <div class="row">
          <span class="hash">#</span>
          <!-- svelte-ignore a11y_autofocus -->
          <input id="slack-name" class="field" bind:value={name} maxlength={CHANNEL_NAME_MAX} autocomplete="off" spellcheck="false" autocapitalize="off" autofocus />
        </div>
        <p class="rule" class:bad={name !== "" && nameError !== null}>{name !== "" && nameError ? nameError : CHANNEL_NAME_RULE}</p>
        <div class="segmented" role="radiogroup" aria-label="Visibility">
          <button type="button" role="radio" aria-checked={isPrivate} class:on={isPrivate} onclick={() => { isPrivate = true; }}>Private</button>
          <button type="button" role="radio" aria-checked={!isPrivate} class:on={!isPrivate} onclick={() => { isPrivate = false; }}>Public</button>
        </div>
        <p class="rule">{isPrivate ? "Only you and the bot see a private channel. A name that is taken is reused when the bot is in that channel." : "Anyone in the workspace can read a public channel; only your messages steer the chat."}</p>
      {:else if list === undefined}
        <p class="rule"><span class="spinner tiny"></span> Reading the channel list</p>
      {:else if list && list.length}
        <label class="label" for="slack-existing">A channel the bot is in</label>
        <select id="slack-existing" class="field" bind:value={existing}>
          {#each list as channel (channel.id)}<option value={channel.id}>#{channel.name}{channel.isPrivate ? "" : " (public)"}</option>{/each}
        </select>
      {:else}
        <label class="label" for="slack-existing">Channel id or #name</label>
        <!-- svelte-ignore a11y_autofocus -->
        <input id="slack-existing" class="field" bind:value={existing} placeholder="#ops-room or C0123ABCDE" autocomplete="off" spellcheck="false" autofocus />
        <p class="rule">{list === null ? "The bot cannot list channels; invite it to the channel first." : "The bot is in no channel yet; invite it to one first."}</p>
      {/if}
      <div class="actions">
        {#if draft && onclear}<button type="button" class="button" disabled={busy} onclick={() => { onclear?.(); onclose(); }}>Don't sync</button>{/if}
        <span class="spacer"></span>
        <button type="button" class="button" onclick={onclose}>Cancel</button>
        <button type="submit" class="button primary" disabled={!canConnect}>{#if busy}<span class="spinner tiny"></span>{/if}{draft !== null && !link ? "Use this channel" : "Connect"}</button>
      </div>
    </form>
  {/if}
</Modal>

{#if stopping && link}
  <ConfirmDialog title={`Stop syncing #${link.name}?`} body="The channel is archived in Slack and this chat stays in the browser only. You can connect it again later." label="Stop syncing" danger {busy}
    onconfirm={() => void stop()} onclose={() => { stopping = false; }} />
{/if}

<style>
  .body { display: flex; flex-direction: column; gap: 10px; padding: 14px 18px 16px; font-size: 13px; }
  .note, .rule { margin: 0; color: var(--text-muted); line-height: 1.45; }
  .rule { font-size: 12px; }
  .rule.bad { color: var(--danger); }
  .label { font-weight: 500; }
  .row { display: flex; align-items: center; gap: 6px; }
  .hash { color: var(--text-faint); font-size: 14px; }
  .current { display: flex; align-items: center; gap: 10px; margin: 0; font-size: 14px; }
  .channel { font-weight: 600; overflow-wrap: anywhere; }
  .kind { padding: 1px 7px; border-radius: 999px; background: var(--bg-sunken); color: var(--text-muted); font-size: 11.5px; }
  .open { margin-left: auto; color: var(--accent-bold); white-space: nowrap; }
  .rename { display: flex; flex-direction: column; gap: 6px; }
  .segmented { align-self: flex-start; }
  select.field { width: 100%; padding: 5px 10px; border-radius: var(--radius-small); border: 1px solid var(--border-strong); background: var(--bg-elevated); font-size: 13px; }
  .actions { display: flex; align-items: center; gap: 8px; margin-top: 4px; }
  .spacer { flex: 1; }
</style>
