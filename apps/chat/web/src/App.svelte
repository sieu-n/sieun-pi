<script lang="ts">
  import Shell from "$lib/shell/Shell.svelte";
  import Toaster from "$lib/ui/Toaster.svelte";
  import { trackKeyboardNavigation, composing } from "$lib/ui/keyboard";
  import { SHORTCUT_GROUPS, matches, type Shortcut, type ShortcutId } from "$lib/shortcuts";
  import { nextStop } from "$lib/shell/conversation-order";
  import { sidebar } from "$lib/shell/sidebar.svelte";
  import { shortcutsSheet } from "$lib/shell/shortcuts-sheet.svelte";
  import ShortcutsSheet from "$lib/shell/ShortcutsSheet.svelte";
  import { laterHref } from "$lib/later.svelte";
  import { forYouHref } from "$pages/board/chips";
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
  import LaterPage from "$pages/later/LaterPage.svelte";
  import DraftsPage from "$pages/drafts/DraftsPage.svelte";
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
  const SHORTCUTS = SHORTCUT_GROUPS.flatMap((g): readonly (Shortcut & { id: ShortcutId })[] => g.shortcuts);
  window.addEventListener("swfactory:menu", onMenu);

  // A tab left open across a release runs the old bundle, whose sends the new server may refuse. It reloads itself once the tab is hidden
  // or out of focus and nothing is on its way (lib/api/reload.ts), and offers a Reload until then. Drafts and unsent posts outlive it.
  let staleShown = false;
  $effect(() => {
    if (staleShown || !isStale(me.value?.web, pageEntry())) return;
    staleShown = true;
    reloadWhenSafe();
    toast.show("A new version of the chat is out. It loads when you switch away, or reload now.", { duration: 0, action: { label: "Reload", run: () => location.reload() } });
  });

  /** What each global key in lib/shortcuts.ts does. A key handled inside one view, such as U, has no entry here. */
  const ACTIONS: Partial<Record<ShortcutId, () => void>> = {
    search: () => search.toggle({ kind: "global" }),
    "prev-conversation": () => goStop(-1, false),
    "next-conversation": () => goStop(1, false),
    "prev-unread": () => goStop(-1, true),
    "next-unread": () => goStop(1, true),
    dms: () => router.navigate(hrefFor("messages", ["new"], { kind: "dm" })),
    "for-you": () => router.navigate(forYouHref()),
    later: () => router.navigate(laterHref()),
    messages: () => router.navigate(router.tabHref("messages")),
    agents: () => router.navigate(router.tabHref("agents")),
    board: () => router.navigate(router.tabHref("board")),
    settings: () => router.navigate(hrefFor("settings", ["usage"])),
    back: () => history.back(),
    forward: () => history.forward(),
    "new-dm": () => router.navigate(hrefFor("messages", ["new"], { kind: "dm" })),
    sidebar: () => sidebar.toggle(),
    "zoom-in": () => stepZoom(0.1),
    "zoom-out": () => stepZoom(-0.1),
    "zoom-reset": () => stepZoom(null),
    shortcuts: () => shortcutsSheet.toggle(),
  };
  /** Keys that still work while a dialog or a menu is open; the rest wait until it closes. */
  const OVER_DIALOGS: ReadonlySet<ShortcutId> = new Set(["search", "shortcuts", "zoom-in", "zoom-out", "zoom-reset"]);

  function goStop(step: 1 | -1, unreadOnly: boolean) {
    const stop = nextStop(step, unreadOnly);
    if (stop) router.navigate(stop.href);
    else if (unreadOnly) toast.show("No unread conversations");
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.defaultPrevented || composing(e)) return;
    const hit = SHORTCUTS.find((s) => ACTIONS[s.id] && matches(e, s));
    if (!hit) return;
    if (!OVER_DIALOGS.has(hit.id) && document.querySelector("dialog[open], [role=menu]")) return;
    e.preventDefault();
    ACTIONS[hit.id]?.();
  }

  /** The Mac app's menu items, such as Settings… with Cmd+, (apps/desktop), send the shortcut id they stand for. */
  function onMenu(e: Event) {
    const id = (e as CustomEvent<unknown>).detail;
    const hit = SHORTCUTS.find((s) => s.id === id);
    if (hit) ACTIONS[hit.id]?.();
  }
</script>

<svelte:window onkeydown={onKeydown} />

<Shell>
  {#if router.route.page === "messages"}
    {#if router.messagesView === "for-you"}<ForYouPage />{:else if router.messagesView === "later"}<LaterPage />{:else if router.messagesView === "drafts"}<DraftsPage />{:else}<ChannelPage />{/if}
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
<ShortcutsSheet />
<Toaster />
