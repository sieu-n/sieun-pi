<script lang="ts">
  import { router } from "$lib/router.svelte";
  import EmptyState from "$lib/ui/EmptyState.svelte";
  import PanelHeader from "$lib/ui/PanelHeader.svelte";
  import Conversation from "./Conversation.svelte";
  import NewConversation from "./NewConversation.svelte";

  const id = $derived(router.conversationId);
  const around = $derived(router.route.params.m);
  /** A new `m` on the same conversation reopens it at that message. */
  const viewKey = $derived(`${id}|${around ?? ""}`);
</script>

{#if !id}
  <PanelHeader title="Messages" icon="messages" level={1} />
  <EmptyState icon="messages" title="Pick a conversation" description="Choose a chat, channel or direct message in the sidebar, or start one with +." />
{:else if id === "new"}
  <NewConversation kind={router.route.params.kind ?? "chat"} />
{:else}
  {#key viewKey}
    <Conversation {id} {around} />
  {/key}
{/if}
