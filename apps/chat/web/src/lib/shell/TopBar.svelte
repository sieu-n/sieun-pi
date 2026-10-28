<script lang="ts">
  import IconButton from "$lib/ui/IconButton.svelte";
  import Icon from "$lib/ui/Icon.svelte";
  import Tabs from "$lib/ui/Tabs.svelte";
  import Menu from "$lib/ui/Menu.svelte";
  import Avatar from "$lib/ui/Avatar.svelte";
  import type { MenuEntry } from "$lib/ui/menu";
  import { isMac } from "$lib/ui/keyboard";
  import { tooltip } from "$lib/ui/tooltip";
  import { PAGES, hrefFor, router, type PageId } from "$lib/router.svelte";
  import { sidebar } from "./sidebar.svelte";
  import { search } from "./search.svelte";
  import { theme } from "./theme.svelte";
  import { inDesktopShell } from "./desktop";

  type Props = { ownerName?: string };
  let { ownerName = "Sieun" }: Props = $props();

  let newOpen = $state(false);
  let newAnchor = $state<HTMLButtonElement>();
  let profileOpen = $state(false);
  let profileAnchor = $state<HTMLButtonElement>();

  const tabs = $derived(PAGES.map((p) => ({ id: p.id, label: p.label, icon: p.icon, href: hrefFor(p.id, p.id === "messages" && lastConversation ? [lastConversation] : []) })));
  let lastConversation = $state<string | null>(null);
  $effect(() => {
    if (router.conversationId && router.conversationId !== "new") lastConversation = router.conversationId;
  });

  const newItems: MenuEntry[] = [
    { id: "chat", label: "New chat", icon: "chat", shortcut: isMac ? "⌘N" : "Ctrl N", onselect: () => router.navigate(hrefFor("messages", ["new"], { kind: "chat" })) },
    { id: "channel", label: "New channel", icon: "hash", onselect: () => router.navigate(hrefFor("messages", ["new"], { kind: "channel" })) },
    { id: "dm", label: "New DM", icon: "messages", onselect: () => router.navigate(hrefFor("messages", ["new"], { kind: "dm" })) },
  ];
  const profileItems: MenuEntry[] = $derived([
    { id: "settings", label: "Settings", icon: "settings", onselect: () => router.navigate(hrefFor("settings", ["usage"])) },
    { type: "separator" },
    { type: "label", label: "Appearance" },
    { type: "radio", id: "light", group: "mode", label: "Light", checked: theme.mode === "light", onselect: () => theme.set("light") },
    { type: "radio", id: "dark", group: "mode", label: "Dark", checked: theme.mode === "dark", onselect: () => theme.set("dark") },
    { type: "radio", id: "system", group: "mode", label: "System", checked: theme.mode === "system", onselect: () => theme.set("system") },
  ]);
  const searchKey = isMac ? "⌘K" : "Ctrl K";
</script>

<header class="topbar" class:desktop={inDesktopShell} data-tauri-drag-region={inDesktopShell ? "deep" : undefined}>
  <div class="left">
    <IconButton icon="sidebar" label={sidebar.collapsed ? "Show sidebar" : "Hide sidebar"} onclick={() => sidebar.toggle()} />
    <IconButton icon="arrow-left" label="Back" shortcut={isMac ? "⌘[" : "Alt ←"} onclick={() => history.back()} />
    <IconButton icon="arrow-right" label="Forward" shortcut={isMac ? "⌘]" : "Alt →"} onclick={() => history.forward()} />
  </div>

  <div class="capsule" data-testid="nav-capsule">
    <IconButton bind:element={newAnchor} icon="plus" label="New" variant="ghost" class="capsule-btn" pressed={newOpen} onclick={() => (newOpen = !newOpen)} />
    <nav aria-label="Pages">
      <Tabs items={tabs} value={router.route.page} variant="chrome" embedded label="Pages" onchange={(id: PageId) => router.navigate(tabs.find((t) => t.id === id)?.href ?? hrefFor(id))} />
    </nav>
    <button class="search-pill" type="button" onclick={() => search.open()} use:tooltip={{ text: "Search", shortcut: searchKey }} aria-label="Search">
      <Icon name="search" size={18} />
      <span>Search</span>
      <kbd>({searchKey})</kbd>
    </button>
  </div>

  <div class="right">
    <IconButton icon="settings" label="Settings" pressed={router.route.page === "settings"} onclick={() => router.navigate(hrefFor("settings", ["usage"]))} />
    <button bind:this={profileAnchor} class="profile" type="button" aria-label="Profile, appearance and settings" onclick={() => (profileOpen = !profileOpen)}>
      <Avatar name={ownerName} kind="person" size={28} status="online" />
    </button>
  </div>
</header>

<Menu bind:open={newOpen} anchor={newAnchor} items={newItems} label="New" />
<Menu bind:open={profileOpen} anchor={profileAnchor} items={profileItems} placement="bottom-end" label="Profile" />

<style>
  .topbar {
    position: relative;
    display: flex;
    align-items: center;
    justify-content: space-between;
    min-height: var(--size-topbar);
    padding: 0 8px;
  }
  /* apps/desktop puts the macOS window buttons at x 20 to 80 and centers them 28 px from the top, so the row keeps that room at any interface scale. */
  .topbar.desktop {
    min-height: calc(var(--size-topbar) / var(--interface-scale, 1));
    padding-left: calc(88px / var(--interface-scale, 1));
  }
  .left,
  .right {
    display: flex;
    align-items: center;
    gap: 2px;
    z-index: 1;
  }
  .capsule {
    position: absolute;
    left: 50%;
    top: 50%;
    transform: translate(-50%, -50%);
    display: flex;
    align-items: center;
    gap: 2px;
    height: var(--size-nav-track);
    padding: 4px;
    border-radius: var(--radius-pill);
    background: var(--affordance-chrome);
  }
  .capsule :global(.capsule-btn) {
    border-radius: var(--radius-pill);
    color: var(--text-chrome-subtle);
  }
  .capsule :global(.capsule-btn:hover) {
    background: var(--affordance-chrome-hover);
  }
  .search-pill {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: var(--size-nav-tab);
    padding: 0 14px 0 12px;
    border: 0;
    border-radius: var(--radius-pill);
    background: transparent;
    color: var(--text-chrome-subtle);
    font: var(--text-label);
    white-space: nowrap;
  }
  .search-pill:hover {
    background: var(--affordance-chrome-hover);
  }
  .search-pill kbd {
    font: var(--text-body-sm);
    color: var(--text-metadata);
  }
  .profile {
    display: inline-grid;
    place-items: center;
    width: 36px;
    height: 36px;
    padding: 0;
    border: 0;
    border-radius: 50%;
    background: transparent;
  }
  @media (max-width: 1100px) {
    .search-pill span,
    .search-pill kbd {
      display: none;
    }
  }
  @media (max-width: 860px) {
    .capsule :global(.tab > span) {
      display: none;
    }
    .capsule :global(.tab) {
      padding: 0 10px;
    }
  }
  @media (max-width: 560px) {
    .left :global(.icon-btn:not(:first-child)) {
      display: none;
    }
  }
</style>
