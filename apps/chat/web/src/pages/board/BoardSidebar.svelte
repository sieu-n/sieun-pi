<script lang="ts">
  import type { BoardRow } from "$lib/api";
  import Avatar from "$lib/ui/Avatar.svelte";
  import Badge from "$lib/ui/Badge.svelte";
  import IconButton from "$lib/ui/IconButton.svelte";
  import Menu from "$lib/ui/Menu.svelte";
  import type { MenuEntry } from "$lib/ui/menu";
  import SidebarFrame from "$lib/shell/SidebarFrame.svelte";
  import SidebarRow from "$lib/shell/SidebarRow.svelte";
  import SidebarSection from "$lib/shell/SidebarSection.svelte";
  import { folds } from "$lib/shell/folds.svelte";
  import { hrefFor, router } from "$lib/router.svelte";
  import { boardMenu, boards, needsYou } from "./boards.svelte";
  import { boardHref } from "./chips";

  boards.start();

  const open = $derived(router.route.page === "board" ? (router.route.rest[0] ?? null) : null);
  /** A hidden board stays out of the list, except while it is the one open. */
  const rows = $derived((boards.rows ?? []).filter(row => !row.hidden || row.chatId === open));
  const sections = $derived([
    { id: "needs-you", label: "Needs you", rows: rows.filter(needsYou) },
    { id: "boards", label: "Boards", rows: rows.filter(row => !needsYou(row)) },
  ]);
  let menu = $state<{ id: string; anchor: HTMLElement | { x: number; y: number }; items: MenuEntry[] } | null>(null);
  const frame = $derived(boards.error ? "offline" : boards.rows ? "ready" : "loading");

  const waits = (row: BoardRow): string => {
    const parts = [row.openAsks ? `${row.openAsks} ${row.openAsks === 1 ? "ask" : "asks"} for you` : "", row.needsGo ? `${row.needsGo} ${row.needsGo === 1 ? "step needs" : "steps need"} your go` : ""].filter(Boolean);
    return parts.length ? `${row.chatName}: ${parts.join(", ")}` : row.chatName;
  };
</script>

<SidebarFrame title="Board" root="board" state={frame} loadingText="Loading boards…" offlineText={boards.rows ? undefined : (boards.error ?? undefined)}>
  <SidebarRow href={hrefFor("board")} label="All boards" icon="board" selected={router.route.page === "board" && open === null} />
  {#each sections as section (section.id)}
    {@const key = `board:${section.id}`}
    {@const folded = folds.isFolded(key)}
    {#if section.rows.length || (section.id === "boards" && boards.rows && !rows.length)}
      <SidebarSection
        id={section.id}
        label={section.label}
        count={folded ? section.rows.length : undefined}
        {folded}
        ontoggle={() => folds.toggle(key)}
        empty="No boards yet."
        isEmpty={!rows.length}
      >
        {#each folded ? section.rows.filter(row => row.chatId === open) : section.rows as row (row.chatId)}
          <SidebarRow href={boardHref(row.chatId)} label={row.chatName} title={waits(row)} selected={open === row.chatId}
            oncontextmenu={(e) => { e.preventDefault(); menu = { id: row.chatId, anchor: { x: e.clientX, y: e.clientY }, items: boardMenu(row) }; }}>
            {#snippet leading()}<Avatar name={row.chatName} kind="agent" seed={row.chatId} size={20} />{/snippet}
            {#snippet actions()}
              <IconButton icon="more" label="{row.chatName} options" size="xs" aria-haspopup="menu" aria-expanded={menu?.id === row.chatId}
                onclick={(e: MouseEvent) => { menu = { id: row.chatId, anchor: e.currentTarget as HTMLElement, items: boardMenu(row) }; }} />
            {/snippet}
            {#snippet trailing()}{#if row.openAsks}<Badge value={row.openAsks} title="{row.openAsks} open {row.openAsks === 1 ? 'ask' : 'asks'} for you" />{/if}{/snippet}
          </SidebarRow>
        {/each}
      </SidebarSection>
    {/if}
  {/each}
</SidebarFrame>

<Menu open={menu !== null} anchor={menu?.anchor} items={menu?.items ?? []} label="Board actions" onclose={() => (menu = null)} />
