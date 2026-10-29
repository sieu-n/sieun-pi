<script lang="ts">
  import { untrack } from "svelte";
  import Tabs from "$lib/ui/Tabs.svelte";
  import IconButton from "$lib/ui/IconButton.svelte";
  import Avatar from "$lib/ui/Avatar.svelte";
  import Icon from "$lib/ui/Icon.svelte";
  import LoadingText from "$lib/ui/LoadingText.svelte";
  import type { ConversationSummary } from "$lib/api";
  import ResizeHandle from "$lib/ui/ResizeHandle.svelte";
  import { conversationHref, hrefFor, router } from "$lib/router.svelte";
  import SidebarRow from "./SidebarRow.svelte";
  import { sidebar, SIDEBAR_DEFAULT, SIDEBAR_MAX, SIDEBAR_MIN } from "./sidebar.svelte";
  import { soloDialog } from "./solo-dialog.svelte";
  import type { SidebarFilter } from "./sidebar.svelte";

  const filters: { id: SidebarFilter; label: string }[] = [
    { id: "all", label: "All" },
    { id: "solo", label: "Solo" },
    { id: "team", label: "Team" },
  ];
  const current = $derived(router.conversationId);
  const names = (row: ConversationSummary): string[] => row.working.map((w) => w.name);
  /** Solo holds only the rooms the server puts there, and hides when it has none, unless the owner picked the Solo filter. */
  const showSolo = $derived(sidebar.filter === "solo" || (sidebar.filter === "all" && sidebar.data.solo.length > 0));
  const showTeam = $derived(sidebar.filter !== "solo");
  const solo = $derived(sidebar.solo);
  const forYouSelected = $derived(router.route.page === "board" && router.route.rest[0] === "for-you");

  $effect(() => {
    const id = current;
    if (sidebar.state !== "ready") return;
    untrack(() => sidebar.follow(id));
  });
</script>

<nav class="sidebar" aria-label="Conversations" data-filter={sidebar.filter}>
  <div class="head">
    <Tabs items={filters} value={sidebar.filter} variant="segmented" full label="Show" onchange={(f) => sidebar.setFilter(f)} />
  </div>

  <div class="scroll">
    <div class="group">
      <SidebarRow href={hrefFor("board", ["for-you"])} label="For you" icon="inbox" selected={forYouSelected} unread={sidebar.data.forYou} />
    </div>

    {#if sidebar.state === "loading"}
      <div class="note"><LoadingText text="Loading your sidebar…" /></div>
    {:else if sidebar.state === "offline"}
      <div class="note"><span>Offline · Showing saved conversations.</span></div>
    {/if}

    {#if showSolo}
      <section class="group" data-section="solo">
        <div class="heading">
          <h2>Solo</h2>
          <IconButton icon="plus" label="New Solo room" size="xs" onclick={() => soloDialog.open()} />
        </div>
        {#each solo.open as row (row.id)}
          <SidebarRow
            href={conversationHref(row.id)}
            label={row.name}
            title={row.agenda ? `${row.name}: ${row.agenda}` : row.name}
            icon="users"
            selected={current === row.id}
            unread={row.unread}
            fresh={row.hasNew}
            working={names(row)}
          />
        {/each}
        {#if solo.done.length}
          <button type="button" class="fold" aria-expanded={sidebar.doneOpen} data-fold="done" onclick={() => (sidebar.doneOpen = !sidebar.doneOpen)}>
            <Icon name="chevron-right" size={14} />
            <span>Done</span>
            <span class="count">{solo.done.length}</span>
          </button>
          {#if sidebar.doneOpen}
            <div class="done" data-group="done">
              {#each solo.done as row (row.id)}
                <SidebarRow href={conversationHref(row.id)} label={row.name} title={row.agenda ? `${row.name}: ${row.agenda}` : row.name} icon="check" selected={current === row.id} />
              {/each}
            </div>
          {/if}
        {/if}
        {#each solo.chats as row (row.id)}
          <SidebarRow href={conversationHref(row.id)} label={row.name} icon="chat" selected={current === row.id} unread={row.unread} fresh={row.hasNew} working={names(row)} />
        {/each}
        {#if !sidebar.data.solo.length}
          <p class="empty">No Solo rooms yet.</p>
        {/if}
      </section>
    {/if}

    {#if showTeam}
      <section class="group" data-section="team">
        {#if sidebar.filter === "all"}<div class="heading"><h2>Team</h2></div>{/if}
        <div class="subheading">
          <h3>Channels</h3>
          <IconButton icon="plus" label="Create channel" size="xs" onclick={() => router.navigate(hrefFor("messages", ["new"], { kind: "channel" }))} />
        </div>
        {#each sidebar.data.channels as row (row.id)}
          <SidebarRow
            href={conversationHref(row.id)}
            label={row.name}
            icon="hash"
            selected={current === row.id}
            unread={row.unread}
            fresh={row.hasNew}
            working={names(row)}
          />
        {:else}
          <p class="empty">No channels yet.</p>
        {/each}
        <div class="subheading">
          <h3>Direct messages</h3>
          <IconButton icon="plus" label="New message" size="xs" onclick={() => router.navigate(hrefFor("messages", ["new"], { kind: "dm" }))} />
        </div>
        {#each sidebar.data.dms as row (row.id)}
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
      </section>
    {/if}
  </div>

  {#if !sidebar.narrow}<ResizeHandle
    size={sidebar.width}
    min={SIDEBAR_MIN}
    max={SIDEBAR_MAX}
    edge="start"
    label="Resize sidebar"
    onresize={(px) => sidebar.setWidth(px)}
    oncommit={() => sidebar.saveWidth()}
    ondoubleclick={() => {
      sidebar.setWidth(SIDEBAR_DEFAULT);
      sidebar.saveWidth();
    }}
  />{/if}
</nav>

<style>
  .sidebar {
    position: relative;
    width: 100%;
    display: flex;
    flex-direction: column;
    flex: none;
    min-height: 0;
    border-radius: var(--radius-container);
    background: var(--surface-panel);
    box-shadow: var(--shadow-panel);
  }
  .head {
    padding: 12px 12px 8px;
  }
  .scroll {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 0 12px 12px;
  }
  .group {
    display: flex;
    flex-direction: column;
    gap: 2px;
    margin-top: 16px;
  }
  .group:first-child {
    margin-top: 4px;
  }
  .heading,
  .subheading {
    display: flex;
    align-items: center;
    justify-content: space-between;
    min-height: 28px;
    padding: 0 4px 0 8px;
  }
  .subheading {
    margin-top: 8px;
  }
  h2 {
    margin: 0;
    font: var(--text-label-sm);
    color: var(--text-standard);
  }
  h3 {
    margin: 0;
    font: var(--text-body-sm);
    color: var(--text-subtle);
  }
  .heading :global(.icon-btn),
  .subheading :global(.icon-btn) {
    opacity: 0;
  }
  .heading:hover :global(.icon-btn),
  .subheading:hover :global(.icon-btn),
  .heading :global(.icon-btn:focus-visible),
  .subheading :global(.icon-btn:focus-visible) {
    opacity: 1;
  }
  .note {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 8px;
    font: var(--text-caption);
    color: var(--text-subtle);
  }
  .fold {
    display: flex;
    align-items: center;
    gap: 6px;
    height: var(--size-row);
    padding: 0 8px;
    border: 0;
    border-radius: var(--radius-row);
    background: transparent;
    color: var(--text-subtle);
    font: var(--text-body-sm);
    text-align: left;
    cursor: pointer;
  }
  .fold:hover {
    background: var(--affordance-sidebar-hover);
    color: var(--text-sidebar-hover);
  }
  .fold :global(.icon) {
    margin: 0 3px;
    transition: transform var(--duration-base) var(--ease-standard);
  }
  .fold[aria-expanded="true"] :global(.icon) {
    transform: rotate(90deg);
  }
  .count {
    margin-left: auto;
    font: var(--text-caption);
    color: var(--text-metadata);
  }
  .done {
    display: flex;
    flex-direction: column;
    gap: 2px;
    opacity: 0.8;
  }
  .empty {
    margin: 0;
    padding: 4px 8px;
    font: var(--text-caption);
    color: var(--text-metadata);
  }
</style>
