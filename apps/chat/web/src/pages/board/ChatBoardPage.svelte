<script lang="ts">
  import { agents, conversations } from "$lib/api";
  import { Button, PanelHeader } from "$lib/ui";
  import { hrefFor, router } from "$lib/router.svelte";
  import BoardPanel from "./BoardPanel.svelte";
  import { boardHref, chatHref } from "./chips";

  let { chatId, focus = null }: { chatId: string; focus?: string | null } = $props();
  const name = $derived(agents.byId(chatId)?.name ?? conversations.byId(chatId)?.name ?? "Board");
</script>

<div class="page">
  <PanelHeader title={name} icon="board" level={1} divider>
    {#snippet actions()}
      <Button size="sm" variant="ghost" icon="arrow-left" href={hrefFor("board")}>All boards</Button>
      <Button size="sm" variant="ghost" icon="messages" href={chatHref(chatId)}>Open chat</Button>
    {/snippet}
  </PanelHeader>
  <div class="scroll">
    <BoardPanel {chatId} where="page" {focus} onboardid={(id) => router.navigate(boardHref(chatId, id))} />
  </div>
</div>

<style>
  .page { display: flex; flex-direction: column; height: 100%; min-height: 0; }
  .scroll { flex: 1; min-height: 0; overflow-y: auto; }
</style>
