<script lang="ts">
  import { EmptyState, Page, PanelHeader, SearchField } from "$lib/ui";
  import { SHORTCUT_GROUPS } from "$lib/shortcuts";
  import ShortcutList from "$lib/shell/ShortcutList.svelte";
  import { filterShortcuts } from "./filter";

  /** Keyboard: every shortcut in lib/shortcuts.ts, the table the Cmd+/ sheet shows, grouped and filtered by name or keys. */
  let query = $state("");
  const groups = $derived(filterShortcuts(SHORTCUT_GROUPS, query));
</script>

<Page measure="default">
  {#snippet header()}
    <PanelHeader title="Keyboard" icon="command" level={1} />
  {/snippet}

  <SearchField bind:value={query} placeholder="Search shortcuts" label="Search shortcuts" />
  {#if groups.length}
    <ShortcutList {groups} />
  {:else}
    <EmptyState size="sm" icon="search" title={`No shortcut matches "${query.trim()}"`} />
  {/if}
</Page>
