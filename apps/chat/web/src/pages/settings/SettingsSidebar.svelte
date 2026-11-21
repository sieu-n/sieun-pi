<script lang="ts">
  import { hrefFor } from "$lib/router.svelte";
  import SidebarFrame from "$lib/shell/SidebarFrame.svelte";
  import SidebarRow from "$lib/shell/SidebarRow.svelte";
  import { SETTINGS_GROUPS, SETTINGS_SECTIONS, openSection } from "./sections";

  const section = $derived(openSection());
</script>

<SidebarFrame title="Settings" root="settings">
  {#each SETTINGS_GROUPS as group (group)}
    <div class="rows" data-group={group}>
      {#each SETTINGS_SECTIONS.filter((s) => s.group === group) as item (item.id)}
        <SidebarRow href={hrefFor("settings", [item.id])} label={item.label} icon={item.icon} selected={section === item.id} />
      {/each}
    </div>
  {/each}
</SidebarFrame>

<style>
  .rows {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .rows + .rows {
    margin-top: var(--space-4);
  }
</style>
