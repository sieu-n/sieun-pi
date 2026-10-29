<script lang="ts">
  import { hrefFor, router } from "$lib/router.svelte";
  import SidebarFrame from "$lib/shell/SidebarFrame.svelte";
  import SidebarSection from "$lib/shell/SidebarSection.svelte";
  import SidebarRow from "$lib/shell/SidebarRow.svelte";
  import { PROVIDER_LABEL, PROVIDER_SLUG, type ProviderId } from "./model";
  import { accountsShown } from "./shown.svelte";

  const PROVIDERS = Object.keys(PROVIDER_LABEL) as ProviderId[];
  const thread = $derived(router.route.params.thread || null);
  const rows = (id: ProviderId) => accountsShown.view?.providers.find((entry) => entry.provider === id)?.rows ?? [];
</script>

<SidebarFrame title="Accounts" root="accounts" state={accountsShown.view ? "ready" : "loading"} loadingText="Loading accounts…">
  <SidebarSection id="providers" label="Providers">
    {#each PROVIDERS as id (id)}
      <SidebarRow href={hrefFor("accounts", [PROVIDER_SLUG[id]], { thread })} label={PROVIDER_LABEL[id]} icon="users" selected={accountsShown.provider === id}>
        {#snippet trailing()}
          {#if rows(id).length}<span class="count">{rows(id).length}</span>{/if}
        {/snippet}
      </SidebarRow>
    {/each}
  </SidebarSection>
</SidebarFrame>

<style>
  .count {
    font: var(--text-caption);
    color: var(--text-metadata);
  }
</style>
