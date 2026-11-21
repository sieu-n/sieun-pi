<script lang="ts">
  import UsagePage from "$pages/usage/UsagePage.svelte";
  import HostsPage from "$pages/hosts/HostsPage.svelte";
  import AccountsPage from "$pages/accounts/AccountsPage.svelte";
  import SkillsPage from "$pages/skills/SkillsPage.svelte";
  import ReviewPage from "$pages/skills-review/ReviewPage.svelte";
  import PreferencesPage from "$pages/preferences/PreferencesPage.svelte";
  import NotificationsPage from "$pages/notifications/NotificationsPage.svelte";
  import KeyboardPage from "$pages/keyboard/KeyboardPage.svelte";
  import { router } from "$lib/router.svelte";
  import { openSection } from "./sections";

  const section = $derived(openSection());
</script>

<div class="section" data-testid="settings-section" data-section={section}>
  {#if section === "usage"}
    <UsagePage />
  {:else if section === "preferences"}
    <PreferencesPage />
  {:else if section === "notifications"}
    <NotificationsPage />
  {:else if section === "keyboard"}
    <KeyboardPage />
  {:else if section === "accounts"}
    <AccountsPage />
  {:else if section === "skills" && router.route.rest[1] === "review"}
    <ReviewPage />
  {:else if section === "skills"}
    <SkillsPage />
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
