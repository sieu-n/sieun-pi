<script lang="ts">
  import type { BoardRow } from "$lib/api";
  import Avatar from "$lib/ui/Avatar.svelte";
  import Badge from "$lib/ui/Badge.svelte";
  import SidebarFrame from "$lib/shell/SidebarFrame.svelte";
  import SidebarRow from "$lib/shell/SidebarRow.svelte";
  import SidebarSection from "$lib/shell/SidebarSection.svelte";
  import { folds } from "$lib/shell/folds.svelte";
  import { hrefFor, router } from "$lib/router.svelte";
  import { boards, needsYou } from "./boards.svelte";
  import { boardHref } from "./chips";

  boards.start();

  const open = $derived(router.route.page === "board" ? (router.route.rest[0] ?? null) : null);
  const rows = $derived(boards.rows ?? []);
  const sections = $derived([
    { id: "needs-you", label: "Needs you", rows: rows.filter(needsYou) },
    { id: "boards", label: "Boards", rows: rows.filter(row => !needsYou(row)) },
  ]);
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
          <SidebarRow href={boardHref(row.chatId)} label={row.chatName} title={waits(row)} selected={open === row.chatId}>
            {#snippet leading()}<Avatar name={row.chatName} kind="agent" seed={row.chatId} size={20} />{/snippet}
            {#snippet trailing()}{#if row.openAsks}<Badge value={row.openAsks} title="{row.openAsks} open {row.openAsks === 1 ? 'ask' : 'asks'} for you" />{/if}{/snippet}
          </SidebarRow>
        {/each}
      </SidebarSection>
    {/if}
  {/each}
</SidebarFrame>
