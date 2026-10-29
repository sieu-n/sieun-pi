<script lang="ts">
  import { hrefFor } from "$lib/router.svelte";
  import SidebarFrame from "$lib/shell/SidebarFrame.svelte";
  import SidebarRow from "$lib/shell/SidebarRow.svelte";
  import { SETTINGS_SECTIONS, openSection } from "./sections";

  const section = $derived(openSection());
</script>

<SidebarFrame title="Settings" root="settings">
  <div class="rows">
    {#each SETTINGS_SECTIONS as item (item.id)}
      <SidebarRow href={hrefFor("settings", [item.id])} label={item.label} icon={item.icon} selected={section === item.id} />
    {/each}
  </div>
</SidebarFrame>

<style>
  .rows {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
</style>
