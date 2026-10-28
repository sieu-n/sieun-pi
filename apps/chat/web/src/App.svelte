<script lang="ts">
  import Shell from "$lib/shell/Shell.svelte";
  import Toaster from "$lib/ui/Toaster.svelte";
  import { trackKeyboardNavigation, modKey } from "$lib/ui/keyboard";
  import { router, hrefFor } from "$lib/router.svelte";
  import { search } from "$lib/shell/search.svelte";
  import "$lib/shell/theme.svelte";
  import { initZoom, stepZoom } from "$lib/shell/zoom";
  import ChannelPage from "$pages/channel/ChannelPage.svelte";
  import AgentsPage from "$pages/agents/AgentsPage.svelte";
  import BoardPage from "$pages/board/BoardPage.svelte";
  import SettingsPage from "$pages/settings/SettingsPage.svelte";
  import SearchDialog from "$pages/search/SearchDialog.svelte";
  import SearchPage from "$pages/search/SearchPage.svelte";

  trackKeyboardNavigation();
  initZoom();

  function onKeydown(e: KeyboardEvent) {
    if (!modKey(e) || e.altKey) return;
    const key = e.key.toLowerCase();
    if (key === "k" && !e.shiftKey) {
      e.preventDefault();
      search.toggle({ kind: "global" });
    } else if (key === "f" && !e.shiftKey && router.conversationId) {
      e.preventDefault();
      search.open({ kind: "conversation", id: router.conversationId });
    } else if (key === "n" && !e.shiftKey) {
      e.preventDefault();
      router.navigate(hrefFor("messages", ["new"], { kind: "chat" }));
    } else if (key === "=" || key === "+") {
      e.preventDefault();
      stepZoom(0.1);
    } else if (key === "-") {
      e.preventDefault();
      stepZoom(-0.1);
    } else if (key === "0") {
      e.preventDefault();
      stepZoom(null);
    } else if (key === "[") {
      e.preventDefault();
      history.back();
    } else if (key === "]") {
      e.preventDefault();
      history.forward();
    }
  }
</script>

<svelte:window onkeydown={onKeydown} />

<Shell>
  {#if router.route.page === "messages"}
    <ChannelPage />
  {:else if router.route.page === "agents"}
    <AgentsPage />
  {:else if router.route.page === "board"}
    <BoardPage />
  {:else if router.route.page === "settings"}
    <SettingsPage />
  {:else if router.route.page === "search"}
    <SearchPage />
  {:else if router.route.page === "ui"}
    {#await import("$lib/ui/gallery/Gallery.svelte") then m}<m.default />{/await}
  {/if}
</Shell>

<SearchDialog open={search.isOpen} scope={search.scope} query={search.query} onclose={() => search.close()} />
<Toaster />
