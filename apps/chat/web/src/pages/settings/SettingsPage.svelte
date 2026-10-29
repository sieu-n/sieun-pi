<script lang="ts">
  import UsagePage from "$pages/usage/UsagePage.svelte";
  import HostsPage from "$pages/hosts/HostsPage.svelte";
  import { openSection } from "./sections";

  const section = $derived(openSection());
</script>

<div class="section" data-testid="settings-section" data-section={section}>
  {#if section === "usage"}
    <UsagePage />
  {:else}
    <HostsPage />
  {/if}
</div>

<style>
  .section {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-width: 0;
    min-height: 0;
  }
</style>
