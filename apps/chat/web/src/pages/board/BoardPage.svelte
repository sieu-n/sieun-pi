<script lang="ts">
  import { router } from "$lib/router.svelte";
  import BoardIndex from "./BoardIndex.svelte";
  import ChatBoardPage from "./ChatBoardPage.svelte";

  const head = $derived(router.route.rest[0] ?? null);
</script>

{#if head}
  {#key head}<ChatBoardPage chatId={head} focus={router.route.params.focus ?? null} />{/key}
{:else}
  <BoardIndex />
{/if}
