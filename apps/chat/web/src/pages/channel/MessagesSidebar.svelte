<script lang="ts">
  import { untrack } from "svelte";
  import IconButton from "$lib/ui/IconButton.svelte";
  import Avatar from "$lib/ui/Avatar.svelte";
  import Menu from "$lib/ui/Menu.svelte";
  import type { Anchor } from "$lib/ui/floating";
  import type { MenuEntry } from "$lib/ui/menu";
  import type { ConversationSummary } from "$lib/api";
  import { conversationHref, hrefFor, router } from "$lib/router.svelte";
  import SidebarFrame from "$lib/shell/SidebarFrame.svelte";
  import SidebarSection from "$lib/shell/SidebarSection.svelte";
  import SidebarRow from "$lib/shell/SidebarRow.svelte";
  import SectionDialog from "$lib/shell/SectionDialog.svelte";
  import { sidebar } from "$lib/shell/sidebar.svelte";
  import { soloDialog } from "$lib/shell/solo-dialog.svelte";
  import { renameDialog } from "$lib/shell/rename-dialog.svelte";
  import { CHANNEL_DRAG_TYPE, channelDrop, groupChannels, sidebarSections, visibleRows, type BuiltinSection, type SectionId } from "$lib/shell/sidebar-sections.svelte";
  import { forYouHref } from "$pages/board/chips";

  const current = $derived(router.conversationId);
  const names = (row: ConversationSummary): string[] => row.working.map((w) => w.name);
  const solo = $derived(sidebar.solo);
  const forYouSelected = $derived(router.route.page === "messages" && router.route.rest[0] === "for-you");
  const channels = $derived(groupChannels(sidebar.data.channels, sidebarSections.model));
  const folded = (id: BuiltinSection | SectionId): boolean => sidebarSections.isFolded(id);
  /** A folded section still shows the open conversation, as Slack does. */
  const shown = <T extends { id: string }>(rows: readonly T[], id: BuiltinSection | SectionId): T[] => visibleRows(rows, folded(id), current);
  const channelCount = (id: string): number => channels.sections.find((s) => s.section.id === id)?.rows.length ?? 0;
  const newChannel = () => router.navigate(hrefFor("messages", ["new"], { kind: "channel" }));

  /** The one open sidebar menu: a channel row's, a section header's or the Channels header's, keyed so its "..." shows as pressed. */
  let menu = $state<{ key: string; anchor: Anchor; items: MenuEntry[] } | null>(null);

  function openMenu(key: string, anchor: Anchor, items: MenuEntry[]): void {
    menu = { key, anchor, items };
  }

  function channelMenu(row: ConversationSummary): MenuEntry[] {
    const at = sidebarSections.sectionOf(row.id);
    const to = (id: SectionId | null, label: string): MenuEntry => ({
      type: "radio",
      id: id ?? "channels",
      group: "section",
      label,
      checked: at === id,
      onselect: () => sidebarSections.move(row.id, id),
    });
    return [
      { id: "rename", label: "Rename channel", icon: "edit", onselect: () => renameDialog.open(row.id, row.name) },
      {
        type: "submenu",
        id: "move",
        label: "Move to",
        icon: "folder",
        items: [
          ...sidebarSections.sections.map((s) => to(s.id, s.name)),
          to(null, "Channels"),
          { type: "separator" },
          { id: "new-section", label: "New section…", icon: "plus", onselect: () => (sidebarSections.dialog = { kind: "new", channelId: row.id }) },
        ],
      },
    ];
  }

  function sectionMenu(id: SectionId): MenuEntry[] {
    return [
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
    unread={row.unread}
    fresh={row.hasNew}
    working={names(row)}
    ondragstart={(e) => dragChannel(e, row.id)}
    oncontextmenu={(e) => {
      e.preventDefault();
      openMenu(row.id, { x: e.clientX, y: e.clientY }, channelMenu(row));
    }}
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
    unread={row.unread}
    fresh={row.hasNew}
    working={names(row)}
  />
{/snippet}

<SidebarFrame title="Messages" root="messages" label="Conversations" state={sidebar.state} loadingText="Loading your sidebar…" offlineText="Offline · Showing saved conversations.">
  {#snippet actions()}
    <IconButton icon="edit" label="New message" size="sm" onclick={() => router.navigate(hrefFor("messages", ["new"], { kind: "dm" }))} />
  {/snippet}

  <div class="rows">
    <SidebarRow href={forYouHref()} label="For you" icon="inbox" selected={forYouSelected} unread={sidebar.data.forYou} />
  </div>

  <SidebarSection id="solo" label="Solo" folded={folded("solo")} ontoggle={() => sidebarSections.toggle("solo")} empty="No Solo rooms yet." isEmpty={!sidebar.data.solo.length}>
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
    {#each shown(solo.chats, "solo") as row (row.id)}{@render soloRow(row, "chat")}{/each}
  </SidebarSection>

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
          { id: "new-section", label: "New section", icon: "plus", onselect: () => (sidebarSections.dialog = { kind: "new" }) },
        ])}
        <IconButton icon="plus" label="Create channel" size="xs" onclick={newChannel} />
      {/snippet}
      {#each shown(channels.rest, "channels") as row (row.id)}{@render channelRow(row)}{/each}
    </SidebarSection>
  </div>

  <SidebarSection id="dms" label="Direct messages" folded={folded("dms")} ontoggle={() => sidebarSections.toggle("dms")}>
    {#snippet actions()}<IconButton icon="plus" label="New message" size="xs" onclick={() => router.navigate(hrefFor("messages", ["new"], { kind: "dm" }))} />{/snippet}
    {#each shown(sidebar.data.dms, "dms") as row (row.id)}
      <SidebarRow
        href={conversationHref(row.id)}
        label={row.name}
        title={row.preview ? `${row.name}: ${row.preview}` : row.name}
        selected={current === row.id}
        unread={row.unread}
        fresh={row.hasNew}
        working={names(row)}
      >
        {#snippet leading()}
          <Avatar name={row.name} kind="agent" seed={row.agent ?? row.id} size={20} status={row.status === "working" ? "online" : row.status === "failed" ? "busy" : null} />
        {/snippet}
      </SidebarRow>
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
  .drop {
    border-radius: var(--radius-row);
    transition: background-color var(--duration-fast) var(--ease-standard);
  }
  .drop:global([data-drop]) {
    background: var(--affordance-sidebar-hover);
    box-shadow: inset 0 0 0 2px var(--affordance-accent-prominent);
  }
</style>
