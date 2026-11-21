<script lang="ts">
  import { untrack } from "svelte";
  import IconButton from "$lib/ui/IconButton.svelte";
  import Avatar from "$lib/ui/Avatar.svelte";
  import Menu from "$lib/ui/Menu.svelte";
  import type { Anchor } from "$lib/ui/floating";
  import type { MenuAction, MenuEntry } from "$lib/ui/menu";
  import { agents, api, me, type ConversationSummary } from "$lib/api";
  import { toast } from "$lib/ui/toast.svelte";
  import { conversationHref, hrefFor, router } from "$lib/router.svelte";
  import SidebarFrame from "$lib/shell/SidebarFrame.svelte";
  import SidebarSection from "$lib/shell/SidebarSection.svelte";
  import SidebarRow from "$lib/shell/SidebarRow.svelte";
  import SectionDialog from "$lib/shell/SectionDialog.svelte";
  import { sidebar, soloGroups } from "$lib/shell/sidebar.svelte";
  import { soloDialog } from "$lib/shell/solo-dialog.svelte";
  import { renameDialog } from "$lib/shell/rename-dialog.svelte";
  import { CHANNEL_DRAG_TYPE, channelDrop, groupChannels, sidebarSections, visibleRows, type BuiltinSection, type SectionId } from "$lib/shell/sidebar-sections.svelte";
  import { forYouHref } from "$pages/board/chips";
  import { later, laterHref } from "$lib/later.svelte";
  import { drafts, draftsHref } from "$lib/drafts.svelte";
  import Badge from "$lib/ui/Badge.svelte";
  import { roomActions, rowUnread, starredRows, unstarred } from "$lib/shell/room-actions.svelte";
  import { isUnread, markAllRead, unreadRooms, unreadsHref } from "$lib/unreads.svelte";
  import HostBadge from "$pages/agents/HostBadge.svelte";

  const current = $derived(router.conversationId);
  const names = (row: ConversationSummary): string[] => row.working.map((w) => w.name);
  /** Slack's pencil on a room whose box holds a draft, left off the open room, whose box shows the draft itself. */
  const hasDraft = (row: ConversationSummary): boolean => row.id !== current && drafts.inRoom(row.id);
  const starred = $derived(starredRows(current));
  const solo = $derived(soloGroups(unstarred(sidebar.data.solo, current)));
  const forYouSelected = $derived(router.messagesView === "for-you");
  later.start();
  const channels = $derived(groupChannels(unstarred(sidebar.data.channels, current), sidebarSections.model));
  const folded = (id: BuiltinSection | SectionId): boolean => sidebarSections.isFolded(id);
  /** A folded section still shows the open conversation and every unread one, as Slack does. */
  const shown = (rows: readonly ConversationSummary[], id: BuiltinSection | SectionId): ConversationSummary[] =>
    visibleRows(rows, folded(id), (row) => row.id === current || rowUnread(row).unread > 0 || rowUnread(row).fresh);
  const channelCount = (id: string): number => channels.sections.find((s) => s.section.id === id)?.rows.length ?? 0;
  const newChannel = () => router.navigate(hrefFor("messages", ["new"], { kind: "channel" }));

  /** The one open sidebar menu: a channel row's, a section header's or the Channels header's, keyed so its "..." shows as pressed. */
  let menu = $state<{ key: string; anchor: Anchor; items: MenuEntry[] } | null>(null);

  function openMenu(key: string, anchor: Anchor, items: MenuEntry[]): void {
    menu = { key, anchor, items };
  }

  function contextMenu(e: MouseEvent, key: string, items: MenuEntry[]): void {
    e.preventDefault();
    openMenu(key, { x: e.clientX, y: e.clientY }, items);
  }

  /** The items every conversation row's menu starts with, whatever its kind. */
  function rowMenu(row: ConversationSummary): MenuEntry[] {
    return [
      {
        id: "read",
        label: "Mark as read",
        icon: "check",
        disabled: !(row.unread > 0 || row.hasNew),
        onselect: () => void api.read(row.id).catch(() => toast.error(`Could not mark ${row.name} as read`)),
      },
      {
        id: "link",
        label: "Copy link",
        icon: "link",
        onselect: () => void navigator.clipboard.writeText(`${location.origin}${location.pathname}${conversationHref(row.id)}`).then(() => toast.show("Link copied")),
      },
    ];
  }

  function dmMenu(row: ConversationSummary): MenuEntry[] {
    const agent = row.agent;
    const open: MenuEntry[] = agent ? [{ type: "separator" }, { id: "agent", label: "Open agent", icon: "robot", onselect: () => router.navigate(hrefFor("agents", [agent])) }] : [];
    return [...rowMenu(row), ...open, { type: "separator" }, ...roomActions(row.id)];
  }

  function soloMenu(row: ConversationSummary): MenuEntry[] {
    return [...rowMenu(row), { type: "separator" }, ...roomActions(row.id)];
  }

  function channelMenu(row: ConversationSummary): MenuEntry[] {
    const at = sidebarSections.sectionOf(row.id);
    const to = (id: SectionId | null, label: string): MenuAction => ({ id: id ?? "channels", label, onselect: () => sidebarSections.move(row.id, id) });
    const targets = [...sidebarSections.sections.map((s) => to(s.id, s.name)), to(null, "Channels")].filter((entry) => entry.id !== (at ?? "channels"));
    return [
      ...rowMenu(row),
      { type: "separator" },
      { id: "rename", label: "Rename channel", icon: "edit", onselect: () => renameDialog.open(row.id, row.name) },
      {
        type: "submenu",
        id: "move",
        label: "Move to",
        icon: "folder",
        items: [
          ...targets,
          ...(targets.length ? [{ type: "separator" } as const] : []),
          { id: "new-section", label: "New section…", icon: "plus", onselect: () => (sidebarSections.dialog = { kind: "new", channelId: row.id }) },
        ],
      },
      { type: "separator" },
      ...roomActions(row.id),
    ];
  }

  /** A section menu's Mark all as read, which reads every unread room in the section, as Slack's does. */
  function readAllItem(rows: readonly ConversationSummary[]): MenuEntry {
    const unread = rows.filter(isUnread);
    return { id: "read-all", label: "Mark all as read", icon: "check", disabled: !unread.length, onselect: () => void markAllRead(unread) };
  }

  function sectionMenu(id: SectionId): MenuEntry[] {
    return [
      readAllItem(channels.sections.find((s) => s.section.id === id)?.rows ?? []),
      { type: "separator" },
      { id: "rename", label: "Rename section", icon: "edit", onselect: () => (sidebarSections.dialog = { kind: "rename", id }) },
      {
        id: "delete",
        label: "Delete section",
        icon: "trash",
        tone: "danger",
        onselect: () => (channelCount(id) ? (sidebarSections.dialog = { kind: "delete", id }) : sidebarSections.remove(id)),
      },
    ];
  }

  function dragChannel(e: DragEvent, id: string): void {
    if (!e.dataTransfer) return;
    e.dataTransfer.setData(CHANNEL_DRAG_TYPE, id);
    e.dataTransfer.effectAllowed = "move";
  }
</script>

{#snippet more(key: string, label: string, items: () => MenuEntry[])}
  <IconButton icon="more" {label} size="xs" aria-haspopup="menu" aria-expanded={menu?.key === key} onclick={(e) => openMenu(key, e.currentTarget, items())} />
{/snippet}

{#snippet channelRow(row: ConversationSummary)}
  <SidebarRow
    href={conversationHref(row.id)}
    label={row.name}
    icon="hash"
    selected={current === row.id}
    unread={rowUnread(row).unread}
    fresh={rowUnread(row).fresh}
    muted={row.muted}
    working={names(row)}
    draft={hasDraft(row)}
    ondragstart={(e) => dragChannel(e, row.id)}
    oncontextmenu={(e) => contextMenu(e, row.id, channelMenu(row))}
  >
    {#snippet actions()}{@render more(row.id, `${row.name} options`, () => channelMenu(row))}{/snippet}
  </SidebarRow>
{/snippet}

{#snippet soloRow(row: ConversationSummary, icon: string)}
  <SidebarRow
    href={conversationHref(row.id)}
    label={row.name}
    title={row.agenda ? `${row.name}: ${row.agenda}` : row.name}
    {icon}
    selected={current === row.id}
    unread={rowUnread(row).unread}
    fresh={rowUnread(row).fresh}
    muted={row.muted}
    working={names(row)}
    draft={hasDraft(row)}
    oncontextmenu={(e) => contextMenu(e, row.id, soloMenu(row))}
  >
    {#snippet actions()}{@render more(row.id, `${row.name} options`, () => soloMenu(row))}{/snippet}
  </SidebarRow>
{/snippet}

{#snippet dmRow(row: ConversationSummary)}
  <SidebarRow
    href={conversationHref(row.id)}
    label={row.name}
    title={row.preview ? `${row.name}: ${row.preview}` : row.name}
    selected={current === row.id}
    unread={rowUnread(row).unread}
    fresh={rowUnread(row).fresh}
    muted={row.muted}
    working={names(row)}
    draft={hasDraft(row)}
    oncontextmenu={(e) => contextMenu(e, row.id, dmMenu(row))}
  >
    {#snippet actions()}{@render more(row.id, `${row.name} options`, () => dmMenu(row))}{/snippet}
    {#snippet leading()}
      <Avatar name={row.name} kind="agent" seed={row.agent ?? row.id} size={20} status={row.status === "working" ? "online" : row.status === "failed" ? "busy" : null} />
    {/snippet}
    {#snippet tag()}
      {@const agent = row.agent ? agents.byId(row.agent) : undefined}
      {#if agent}<HostBadge {agent} self={me.value?.host} />{/if}
    {/snippet}
  </SidebarRow>
{/snippet}

<SidebarFrame title="Messages" root="messages" label="Conversations" state={sidebar.state} loadingText="Loading your sidebar…" offlineText="Offline · Showing saved conversations.">
  {#snippet actions()}
    <IconButton icon="edit" label="New message" size="sm" onclick={() => router.navigate(hrefFor("messages", ["new"], { kind: "dm" }))} />
  {/snippet}

  <div class="rows">
    <SidebarRow href={laterHref()} label="Later" icon="bookmark" selected={router.messagesView === "later"}>
      {#snippet trailing()}
        {#if later.open}<span class="count" title="{later.open} in progress">{later.open}</span>{/if}
        {#if later.due}<Badge value={later.due} tone="danger" title="{later.due} due" />{/if}
      {/snippet}
    </SidebarRow>
    <SidebarRow href={draftsHref()} label="Drafts" icon="edit" selected={router.messagesView === "drafts"}>
      {#snippet trailing()}
        {#if drafts.byKey.size}<span class="count" title="{drafts.byKey.size} unsent">{drafts.byKey.size}</span>{/if}
      {/snippet}
    </SidebarRow>
    <SidebarRow href={forYouHref()} label="For you" icon="inbox" selected={forYouSelected} unread={sidebar.data.forYou} />
    <SidebarRow href={unreadsHref()} label="All unreads" icon="messages" selected={router.messagesView === "unreads"} fresh={unreadRooms().length > 0} />
  </div>

  {#if starred.length}
    <SidebarSection id="starred" label="Starred" folded={folded("starred")} ontoggle={() => sidebarSections.toggle("starred")}>
      {#each shown(starred, "starred") as row (row.id)}
        {#if row.kind === "dm"}{@render dmRow(row)}{:else if row.kind === "channel"}{@render channelRow(row)}{:else}{@render soloRow(row, row.closedAt ? "check" : "users")}{/if}
      {/each}
    </SidebarSection>
  {/if}

  {#if sidebar.data.solo.length}
    <SidebarSection id="solo" label="Solo" folded={folded("solo")} ontoggle={() => sidebarSections.toggle("solo")}>
      {#snippet actions()}<IconButton icon="plus" label="New Solo room" size="xs" onclick={() => soloDialog.open()} />{/snippet}
      {#each shown(solo.open, "solo") as row (row.id)}{@render soloRow(row, "users")}{/each}
      {#if folded("solo")}
        {#each shown(solo.done, "solo") as row (row.id)}{@render soloRow(row, "check")}{/each}
      {:else if solo.done.length}
        <SidebarSection id="done" label="Done" count={solo.done.length} folded={!sidebar.doneOpen} ontoggle={() => (sidebar.doneOpen = !sidebar.doneOpen)}>
          {#if sidebar.doneOpen}
            <div class="done" data-group="done">
              {#each solo.done as row (row.id)}{@render soloRow(row, "check")}{/each}
            </div>
          {/if}
        </SidebarSection>
      {/if}
    </SidebarSection>
  {/if}

  {#each channels.sections as { section, rows } (section.id)}
    <div class="drop" data-section-id={section.id} use:channelDrop={(id) => sidebarSections.move(id, section.id)}>
      <SidebarSection id={section.id} label={section.name} folded={folded(section.id)} ontoggle={() => sidebarSections.toggle(section.id)}>
        {#snippet actions()}{@render more(section.id, `${section.name} options`, () => sectionMenu(section.id))}{/snippet}
        {#each shown(rows, section.id) as row (row.id)}{@render channelRow(row)}{/each}
      </SidebarSection>
    </div>
  {/each}

  <div class="drop" data-section-id="channels" use:channelDrop={(id) => sidebarSections.move(id, null)}>
    <SidebarSection id="channels" label="Channels" folded={folded("channels")} ontoggle={() => sidebarSections.toggle("channels")} empty="No channels yet." isEmpty={!sidebar.data.channels.length}>
      {#snippet actions()}
        {@render more("channels", "Channels options", () => [
          readAllItem(channels.rest),
          { type: "separator" },
          { id: "new-section", label: "New section", icon: "plus", onselect: () => (sidebarSections.dialog = { kind: "new" }) },
        ])}
        <IconButton icon="plus" label="Create channel" size="xs" onclick={newChannel} />
      {/snippet}
      {#each shown(channels.rest, "channels") as row (row.id)}{@render channelRow(row)}{/each}
    </SidebarSection>
  </div>

  <SidebarSection id="dms" label="Direct messages" folded={folded("dms")} ontoggle={() => sidebarSections.toggle("dms")}>
    {#snippet actions()}
      {@render more("dms", "Direct messages options", () => [readAllItem(sidebar.data.dms)])}
      <IconButton icon="plus" label="New message" size="xs" onclick={() => router.navigate(hrefFor("messages", ["new"], { kind: "dm" }))} />
    {/snippet}
    {#each shown(unstarred(sidebar.data.dms, current), "dms") as row (row.id)}
      {@render dmRow(row)}
    {/each}
  </SidebarSection>
</SidebarFrame>

<Menu open={menu !== null} anchor={menu?.anchor} items={menu?.items ?? []} onclose={() => (menu = null)} />
<SectionDialog {channelCount} />

<style>
  .rows,
  .done {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .done {
    opacity: 0.8;
  }
  .count {
    color: var(--text-metadata);
    font: var(--text-caption);
    font-variant-numeric: tabular-nums;
  }
  .drop {
    border-radius: var(--radius-row);
    transition: background-color var(--duration-fast) var(--ease-standard);
  }
  .drop:global([data-drop]) {
    background: var(--affordance-sidebar-hover);
    box-shadow: inset 0 0 0 2px var(--affordance-accent-prominent);
  }
</style>
