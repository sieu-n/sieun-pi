<script lang="ts">
  import IconButton from "$lib/ui/IconButton.svelte";
  import Icon from "$lib/ui/Icon.svelte";
  import Tabs from "$lib/ui/Tabs.svelte";
  import Menu from "$lib/ui/Menu.svelte";
  import Avatar from "$lib/ui/Avatar.svelte";
  import { OWNER_ID, OWNER_NAME } from "$lib/owner";
  import type { MenuEntry } from "$lib/ui/menu";
  import { shortcutLabel } from "$lib/shortcuts";
  import { shortcutsSheet } from "./shortcuts-sheet.svelte";
  import { tooltip } from "$lib/ui/tooltip";
  import { PAGES, hrefFor, router, type PageId } from "$lib/router.svelte";
  import { sidebar } from "./sidebar.svelte";
  import { search } from "./search.svelte";
  import { theme } from "./theme.svelte";
  import { inDesktopShell } from "./desktop";
  import { navHistory, describePlace } from "./nav-history.svelte";
  import { zoom, stepZoom, setZoom, ZOOM_MAX, ZOOM_MIN } from "./zoom.svelte";
  import StatusDialog from "./StatusDialog.svelte";
  import { presence, setAway, setStatus } from "$lib/presence.svelte";
  import { notifyPrefs, notificationsPaused, pauseNotifications } from "$lib/notify-prefs.svelte";
  import { toast } from "$lib/ui/toast.svelte";

  /** `hasSidebar` is false on a page with no left sidebar, which hides the sidebar button. */
  type Props = { ownerName?: string; hasSidebar?: boolean };
  let { ownerName = OWNER_NAME, hasSidebar = true }: Props = $props();

  let newOpen = $state(false);
  let newAnchor = $state<HTMLButtonElement>();
  let profileOpen = $state(false);
  let profileAnchor = $state<HTMLButtonElement>();
  let historyOpen = $state(false);
  let historyAnchor = $state<HTMLButtonElement>();
  let statusOpen = $state(false);

  const tabs = $derived(PAGES.map((p) => ({ id: p.id, label: p.label, icon: p.icon, href: router.tabHref(p.id) })));

  const newItems: MenuEntry[] = [
    { id: "dm", label: "New DM", icon: "messages", shortcut: shortcutLabel("new-dm"), onselect: () => router.navigate(hrefFor("messages", ["new"], { kind: "dm" })) },
    { id: "solo", label: "New Solo room", icon: "users", onselect: () => router.navigate(hrefFor("messages", ["new"], { kind: "solo" })) },
    { id: "channel", label: "New channel", icon: "hash", onselect: () => router.navigate(hrefFor("messages", ["new"], { kind: "channel" })) },
  ];
  const clock = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
  const dayClock = new Intl.DateTimeFormat(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" });
  /** "14:30" today, "Mon 09:00" on a later day. */
  function whenLabel(at: number): string {
    return new Date(at).toDateString() === new Date().toDateString() ? clock.format(at) : dayClock.format(at);
  }
  /** The next 9:00 after `days` midnights, as Slack's Until tomorrow and Until next week pick the start of a working day. */
  function nineAfter(days: number): number {
    const d = new Date();
    d.setDate(d.getDate() + days);
    d.setHours(9, 0, 0, 0);
    return d.getTime();
  }
  const untilMonday = (): number => nineAfter(((8 - new Date().getDay()) % 7) || 7);

  // A pause ends on its own, so the menu and the avatar re-read the clock each minute.
  let now = $state(Date.now());
  $effect(() => {
    const id = setInterval(() => (now = Date.now()), 30_000);
    return () => clearInterval(id);
  });
  const paused = $derived(notificationsPaused(now) ? notifyPrefs.pausedUntil : undefined);
  const status = $derived(presence.status);

  function pause(until: number | null) {
    pauseNotifications(until);
    toast.show(until ? `Notifications paused until ${whenLabel(until)}` : "Notifications resumed");
  }
  function clearStatus() {
    const before = presence.status;
    setStatus(null);
    if (before) toast.show("Status cleared", { action: { label: "Undo", run: () => setStatus(before) } });
  }

  const pauseItems: MenuEntry[] = $derived([
    ...(paused ? ([{ id: "resume", label: "Resume notifications", icon: "bell", onselect: () => pause(null) }, { type: "separator" }] satisfies MenuEntry[]) : []),
    { id: "30m", label: "For 30 minutes", onselect: () => pause(Date.now() + 30 * 60_000) },
    { id: "1h", label: "For 1 hour", onselect: () => pause(Date.now() + 60 * 60_000) },
    { id: "2h", label: "For 2 hours", onselect: () => pause(Date.now() + 2 * 60 * 60_000) },
    { id: "tomorrow", label: "Until tomorrow", detail: dayClock.format(nineAfter(1)), onselect: () => pause(nineAfter(1)) },
    { id: "week", label: "Until next week", detail: dayClock.format(untilMonday()), onselect: () => pause(untilMonday()) },
  ]);
  const zoomItems: MenuEntry[] = $derived([
    { id: "zoom-in", label: "Zoom in", icon: "plus", shortcut: shortcutLabel("zoom-in"), disabled: zoom.scale >= ZOOM_MAX, keepOpen: true, onselect: () => stepZoom(0.1) },
    { id: "zoom-out", label: "Zoom out", icon: "minus", shortcut: shortcutLabel("zoom-out"), disabled: zoom.scale <= ZOOM_MIN, keepOpen: true, onselect: () => stepZoom(-0.1) },
    { id: "zoom-reset", label: "Actual size", icon: "refresh", shortcut: shortcutLabel("zoom-reset"), disabled: zoom.scale === 1, onselect: () => setZoom(1) },
  ]);

  const profileItems: MenuEntry[] = $derived([
    status
      ? { id: "status", label: "Edit status", icon: "smile", onselect: () => (statusOpen = true) }
      : { id: "status", label: "Set a status", icon: "smile", onselect: () => (statusOpen = true) },
    ...(status ? [{ id: "clear-status", label: "Clear status", icon: "close", onselect: clearStatus }] : []),
    presence.away
      ? { id: "away", label: "Set yourself as active", icon: "user", onselect: () => setAway(false) }
      : { id: "away", label: "Set yourself as away", icon: "user", onselect: () => setAway(true) },
    { type: "submenu", id: "pause", label: "Pause notifications", icon: paused ? "bell-off" : "bell", detail: paused ? `Paused until ${whenLabel(paused)}` : undefined, items: pauseItems },
    { type: "separator" },
    { id: "settings", label: "Settings", icon: "settings", shortcut: shortcutLabel("settings"), onselect: () => router.navigate(hrefFor("settings", ["usage"])) },
    { id: "shortcuts", label: "Keyboard shortcuts", icon: "command", shortcut: shortcutLabel("shortcuts"), onselect: () => shortcutsSheet.open() },
    { type: "separator" },
    { type: "label", label: "Appearance" },
    { type: "radio", id: "light", group: "mode", label: "Light", checked: theme.mode === "light", onselect: () => theme.set("light") },
    { type: "radio", id: "dark", group: "mode", label: "Dark", checked: theme.mode === "dark", onselect: () => theme.set("dark") },
    { type: "radio", id: "system", group: "mode", label: "System", checked: theme.mode === "system", onselect: () => theme.set("system") },
    { type: "submenu", id: "zoom", label: "Interface size", icon: "expand", detail: `${Math.round(zoom.scale * 100)}%`, items: zoomItems },
  ]);
  const historyItems: MenuEntry[] = $derived.by(() => {
    const places = navHistory.recent.slice(1);
    if (places.length === 0) return [{ id: "none", label: "Places you open show here", disabled: true }];
    return [
      { type: "label", label: "Recent" },
      ...places.map((place, i) => ({ id: `place-${i}`, ...describePlace(place.hash), detail: whenLabel(place.at), onselect: () => router.navigate(place.hash) })),
    ];
  });
  const searchKey = shortcutLabel("search");
</script>

<header class="topbar" class:desktop={inDesktopShell} data-tauri-drag-region={inDesktopShell ? "deep" : undefined}>
  <div class="left">
    {#if hasSidebar}<IconButton icon="sidebar" label={sidebar.collapsed ? "Show sidebar" : "Hide sidebar"} shortcut={shortcutLabel("sidebar")} onclick={() => sidebar.toggle()} />{/if}
    <IconButton icon="arrow-left" label="Back" shortcut={shortcutLabel("back")} disabled={!navHistory.canBack} onclick={() => navHistory.back()} />
    <IconButton icon="arrow-right" label="Forward" shortcut={shortcutLabel("forward")} disabled={!navHistory.canForward} onclick={() => navHistory.forward()} />
    <IconButton bind:element={historyAnchor} icon="clock" label="History" pressed={historyOpen} onclick={() => (historyOpen = !historyOpen)} />
  </div>

  <div class="capsule" data-testid="nav-capsule">
    <IconButton bind:element={newAnchor} icon="plus" label="New" variant="ghost" class="capsule-btn" pressed={newOpen} onclick={() => (newOpen = !newOpen)} />
    <nav aria-label="Pages">
      <Tabs items={tabs} value={router.route.page} variant="chrome" embedded label="Pages" onchange={(id: PageId) => router.navigate(router.tabHref(id))} />
    </nav>
    <button class="search-pill" type="button" onclick={() => search.open()} use:tooltip={{ text: "Search", shortcut: searchKey }} aria-label="Search">
      <Icon name="search" size={18} />
      <span>Search</span>
      <kbd>({searchKey})</kbd>
    </button>
  </div>

  <div class="right">
    <IconButton icon="settings" label="Settings" shortcut={shortcutLabel("settings")} pressed={router.route.page === "settings"} onclick={() => router.navigate(hrefFor("settings", ["usage"]))} />
    <button
      bind:this={profileAnchor}
      class="profile"
      type="button"
      aria-label="Profile: {presence.away ? 'away' : 'active'}{status ? `, ${status.emoji} ${status.text}` : ''}{paused ? ', notifications paused' : ''}"
      use:tooltip={{ text: status ? `${status.emoji} ${status.text}` : presence.away ? "Away" : "Profile" }}
      onclick={() => (profileOpen = !profileOpen)}
    >
      <Avatar name={ownerName} kind="person" seed={OWNER_ID} size={28} status={presence.away ? "away" : "online"} />
      {#if paused}<span class="badge zzz" aria-hidden="true">z</span>{:else if status}<span class="badge" aria-hidden="true">{status.emoji}</span>{/if}
    </button>
  </div>
</header>

<Menu bind:open={newOpen} anchor={newAnchor} items={newItems} label="New" />
<Menu bind:open={historyOpen} anchor={historyAnchor} items={historyItems} label="History" width={300} />
<Menu bind:open={profileOpen} anchor={profileAnchor} items={profileItems} placement="bottom-end" label="Profile" width={280}>
  {#snippet header()}
    <div class="me">
      <Avatar name={ownerName} kind="person" seed={OWNER_ID} size={36} status={presence.away ? "away" : "online"} />
      <div class="me-text">
        <span class="me-name">{ownerName}</span>
        <span class="me-state">{presence.away ? "Away" : "Active"}{paused ? `, notifications paused until ${whenLabel(paused)}` : ""}</span>
      </div>
    </div>
    {#if status}
      <button type="button" class="me-status" onclick={() => ((profileOpen = false), (statusOpen = true))}>
        <span class="me-emoji">{status.emoji}</span>
        <span class="me-status-text">{status.text}{#if status.until}<span class="me-until"> until {whenLabel(status.until)}</span>{/if}</span>
      </button>
    {/if}
  {/snippet}
</Menu>
{#if statusOpen}<StatusDialog onclose={() => (statusOpen = false)} />{/if}

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
    position: relative;
    display: inline-grid;
    place-items: center;
    width: 36px;
    height: 36px;
    padding: 0;
    border: 0;
    border-radius: 50%;
    background: transparent;
  }
  .badge {
    position: absolute;
    left: -2px;
    bottom: -2px;
    display: grid;
    place-items: center;
    min-width: 16px;
    height: 16px;
    border-radius: 50%;
    background: var(--bg-app);
    box-shadow: 0 0 0 1.5px var(--bg-app);
    font-size: 11px;
    line-height: 1;
  }
  .zzz {
    color: var(--text-subtle);
    font: var(--text-caption);
    font-weight: 700;
  }
  .me {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .me-text {
    display: flex;
    min-width: 0;
    flex-direction: column;
  }
  .me-name {
    font: var(--text-label);
    color: var(--text-standard);
  }
  .me-state {
    font: var(--text-caption);
    color: var(--text-metadata);
  }
  .me-status {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    margin-top: 8px;
    padding: 6px 10px;
    border: 1px solid var(--border-standard);
    border-radius: 12px;
    background: transparent;
    color: var(--text-standard);
    font: var(--text-body-sm);
    text-align: left;
  }
  .me-status:hover {
    background: var(--affordance-ghost-hover);
  }
  .me-until {
    color: var(--text-metadata);
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
