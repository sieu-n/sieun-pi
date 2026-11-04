<script lang="ts">
  import Shell from "$lib/shell/Shell.svelte";
  import Toaster from "$lib/ui/Toaster.svelte";
  import { trackKeyboardNavigation, modKey } from "$lib/ui/keyboard";
  import { router, hrefFor } from "$lib/router.svelte";
  import { search } from "$lib/shell/search.svelte";
  import { soloDialog } from "$lib/shell/solo-dialog.svelte";
  import { renameDialog } from "$lib/shell/rename-dialog.svelte";
  import "$lib/shell/theme.svelte";
  import { initZoom, stepZoom } from "$lib/shell/zoom";
  import ChannelPage from "$pages/channel/ChannelPage.svelte";
  import CreateSoloDialog from "$pages/channel/CreateSoloDialog.svelte";
  import RenameChannelDialog from "$pages/channel/RenameChannelDialog.svelte";
  import AgentsPage from "$pages/agents/AgentsPage.svelte";
  import BoardPage from "$pages/board/BoardPage.svelte";
  import ForYouPage from "$pages/board/ForYouPage.svelte";
  import SettingsPage from "$pages/settings/SettingsPage.svelte";
  import SearchDialog from "$pages/search/SearchDialog.svelte";
  import SearchPage from "$pages/search/SearchPage.svelte";
  import ArtifactViewer from "$lib/shell/ArtifactViewer.svelte";
  import { me } from "$lib/api";
  import { isStale, pageEntry } from "$lib/api/stale";
  import { reloadWhenSafe } from "$lib/api/reload";
  import { toast } from "$lib/ui/toast.svelte";

  trackKeyboardNavigation();
  initZoom();

  // A tab left open across a release runs the old bundle, whose sends the new server may refuse. It reloads itself once the tab is hidden
  // or out of focus and nothing is on its way (lib/api/reload.ts), and offers a Reload until then. Drafts and unsent posts outlive it.
  let staleShown = false;
  $effect(() => {
    if (staleShown || !isStale(me.value?.web, pageEntry())) return;
    staleShown = true;
    reloadWhenSafe();
    toast.show("A new version of the chat is out. It loads when you switch away, or reload now.", { duration: 0, action: { label: "Reload", run: () => location.reload() } });
  });

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
    {#if router.messagesView === "for-you"}<ForYouPage />{:else}<ChannelPage />{/if}
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
<CreateSoloDialog open={soloDialog.isOpen} onclose={() => soloDialog.close()} />
{#if renameDialog.target}<RenameChannelDialog target={renameDialog.target} onclose={() => renameDialog.close()} />{/if}
<ArtifactViewer />
<Toaster />
