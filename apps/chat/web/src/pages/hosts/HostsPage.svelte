<script lang="ts">
  import EmptyState from "$lib/ui/EmptyState.svelte";
  import PanelHeader from "$lib/ui/PanelHeader.svelte";
</script>

<PanelHeader title="Hosts" icon="server" level={1} />
<EmptyState icon="server" title="Hosts" description="This page is a placeholder. The usage and hosts builder replaces it." />
