<script lang="ts">
  import EmptyState from "$lib/ui/EmptyState.svelte";
  import PanelHeader from "$lib/ui/PanelHeader.svelte";
</script>

<PanelHeader title="Messages" icon="messages" level={1} />
<EmptyState icon="messages" title="Messages" description="This page is a placeholder. The channel view builder replaces it." />
