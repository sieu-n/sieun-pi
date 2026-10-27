<script lang="ts">
  import Dialog from "$lib/ui/Dialog.svelte";
  import EmptyState from "$lib/ui/EmptyState.svelte";
  import type { SearchScope } from "$lib/shell/search.svelte";

  type Props = { open: boolean; scope: SearchScope; query: string; onclose: () => void };
  let { open, scope, query, onclose }: Props = $props();
</script>

<Dialog {open} {onclose} presentation="search" label="Search">
  <EmptyState
    icon="search"
    title="Search"
    description={scope.kind === "conversation" ? `Search in this conversation. ${query}` : `The search page builder replaces this placeholder. ${query}`}
  />
</Dialog>
