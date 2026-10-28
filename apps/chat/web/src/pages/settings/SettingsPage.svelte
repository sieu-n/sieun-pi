<script lang="ts">
  import { hrefFor, router } from "$lib/router.svelte";
  import { PanelHeader } from "$lib/ui";
  import SidebarRow from "$lib/shell/SidebarRow.svelte";
  import UsagePage from "$pages/usage/UsagePage.svelte";
  import HostsPage from "$pages/hosts/HostsPage.svelte";

  /** Settings: the admin pages behind the avatar menu, one section per row in the list at the left, each at #/settings/<id>. */
  const SECTIONS = [
    { id: "usage", label: "Usage", icon: "chart-bar" },
    { id: "hosts", label: "Hosts", icon: "server" },
  ] as const;
  type SectionId = (typeof SECTIONS)[number]["id"];

  const section = $derived<SectionId>(SECTIONS.find((s) => s.id === router.route.rest[0])?.id ?? "usage");
</script>

<div class="settings">
  <nav class="sections" aria-label="Settings">
    <PanelHeader title="Settings" icon="settings" />
    <div class="rows">
      {#each SECTIONS as item (item.id)}
        <SidebarRow href={hrefFor("settings", [item.id])} label={item.label} icon={item.icon} selected={section === item.id} />
      {/each}
    </div>
  </nav>
  <div class="section" data-testid="settings-section" data-section={section}>
    {#if section === "usage"}
      <UsagePage />
    {:else}
      <HostsPage />
    {/if}
  </div>
</div>

<style>
  .settings {
    display: flex;
    flex: 1;
    min-height: 0;
  }
  .sections {
    display: flex;
    flex-direction: column;
    flex: none;
    width: var(--size-sidebar-min);
    border-right: 1px solid var(--border-standard);
  }
  .rows {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 4px 12px 12px;
  }
  .section {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-width: 0;
    min-height: 0;
  }
  @media (max-width: 650px) {
    .settings {
      flex-direction: column;
    }
    .sections {
      width: auto;
      border-right: 0;
      border-bottom: 1px solid var(--border-standard);
    }
    .rows {
      flex-direction: row;
    }
  }
</style>
