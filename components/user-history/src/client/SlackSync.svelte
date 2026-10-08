<script lang="ts">
  import { store } from "./store.svelte.ts";
  import Icon from "./Icon.svelte";
  import { tooltip } from "./ui/tooltip.ts";

  /** The chat header's Slack switch: off for every chat until the owner turns it on; on shows the channel. Hidden where no bridge runs. */
  let { id, narrow }: { id: string; narrow: boolean } = $props();
  let busy = $state(false);
  const view = $derived(store.slack);
  const channel = $derived(view?.chats[id] ?? null);
  const connected = $derived(view?.state === "on");
  const tip = $derived(!connected ? "Connect Slack in Settings > Slack to sync this chat"
    : channel ? `Synced to #${channel}. Click to stop syncing and archive the channel` : "Sync to Slack: a private channel for this chat");
  $effect(() => { void id; void store.loadSlack(); });

  async function toggle(): Promise<void> {
    if (busy || !connected) return;
    busy = true;
    await store.setChatSlack(id, !channel);
    busy = false;
  }
</script>

{#if view}
  <button type="button" class="icon-button slack-sync" class:on={channel !== null} class:labelled={channel !== null && !narrow} aria-pressed={channel !== null}
    aria-disabled={!connected || busy} aria-label={channel ? `Synced to Slack, #${channel}` : "Sync to Slack"} use:tooltip={tip} onclick={() => void toggle()}>
    {#if busy}<span class="spinner tiny"></span>{:else}<Icon name="slack" size={15} />{/if}
    {#if channel && !narrow}<span class="channel">#{channel}</span>{/if}
  </button>
{/if}

<style>
  .slack-sync.labelled { width: auto !important; gap: 5px; padding: 0 8px; font-size: 12.5px; }
  .slack-sync.on { color: var(--accent-bold); background: var(--accent-soft); }
  .slack-sync[aria-disabled="true"] { opacity: 0.45; cursor: not-allowed; }
  .channel { max-width: 160px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
