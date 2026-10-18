<script lang="ts">
  import { api } from "./api.ts";
  import { store } from "./store.svelte.ts";
  import SlackLogo from "./SlackLogo.svelte";
  import SlackChannelDialog, { type SlackConnectInput } from "./SlackChannelDialog.svelte";
  import { tooltip } from "./ui/tooltip.ts";

  /**
   * The chat header's Slack control. Not synced: "Connect to Slack", which opens the setup dialog. Synced: the Slack mark and the channel, which opens
   * the same dialog on the channel (rename, Open in Slack, Stop syncing behind a confirm). A click never turns sync off. Hidden where no bridge runs.
   */
  let { id, narrow }: { id: string; narrow: boolean } = $props();
  let open = $state(false);
  const view = $derived(store.slack);
  const link = $derived(view?.chats[id] ?? null);
  const connected = $derived(view?.state === "on");
  const chatName = $derived(store.session(id)?.name ?? "");
  const tip = $derived(!connected ? "Connect Slack in Settings > Slack first" : link ? `In Slack as #${link.name}. Rename, open, or stop syncing` : "Connect to Slack: a channel for this chat");
  $effect(() => { void id; void store.loadSlack(); });

  const connect = (input: SlackConnectInput) => store.slackChat(id, { action: "connect", ...input });
  const rename = (name: string) => store.slackChat(id, { action: "rename", name });
  const stop = () => store.slackChat(id, { action: "stop" });
  const channels = () => api.slackChannels();
</script>

{#if view}
  <button type="button" class="icon-button slack" class:on={link !== null} class:labelled={!narrow} aria-haspopup="dialog" aria-expanded={open}
    aria-disabled={!connected} aria-label={link ? `In Slack as #${link.name}` : "Connect to Slack"} use:tooltip={tip} onclick={() => { if (connected) open = true; }}>
    <SlackLogo size={15} />
    {#if !narrow}<span class="text">{link ? `#${link.name}` : "Connect to Slack"}</span>{/if}
  </button>
{/if}

{#if open}
  <SlackChannelDialog {chatName} {link} teamId={view?.teamId ?? null} {channels} onconnect={connect} onrename={rename} onstop={stop} onclose={() => { open = false; }} />
{/if}

<style>
  .slack.labelled { width: auto !important; gap: 6px; padding: 0 8px; font-size: 12.5px; }
  .slack.on { color: var(--accent-bold); background: var(--accent-soft); }
  .slack[aria-disabled="true"] { opacity: 0.45; cursor: not-allowed; }
  .text { max-width: 160px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
