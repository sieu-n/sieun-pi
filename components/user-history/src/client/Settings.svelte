<script lang="ts">
  import { store } from "./store.svelte.ts";
  import Modal from "./Modal.svelte";
  import AccountsSettings from "./AccountsSettings.svelte";
  import UsageSettings from "./UsageSettings.svelte";
  import DefaultsSettings from "./DefaultsSettings.svelte";
  import RemoteSettings from "./RemoteSettings.svelte";
  import SlackSettings from "./SlackSettings.svelte";
  import VersionsSettings from "./VersionsSettings.svelte";

  type Section = NonNullable<typeof store.drawer>;
  let { section }: { section: Section } = $props();
  const SECTIONS: { id: Section; label: string }[] = [{ id: "accounts", label: "Accounts" }, { id: "usage", label: "Usage" }, { id: "defaults", label: "Defaults" }, { id: "remote", label: "Phone access" }, { id: "slack", label: "Slack" }, { id: "versions", label: "Versions" }];
</script>

<Modal title="Settings" width="920px" onclose={() => { store.drawer = null; }}>
  <div class="settings">
    <nav class="sections" aria-label="Settings sections">
      {#each SECTIONS as entry (entry.id)}
        <button class="section" aria-current={entry.id === section ? "page" : undefined} onclick={() => { store.drawer = entry.id; }}>{entry.label}</button>
      {/each}
    </nav>
    <div class="content">
      {#if section === "accounts"}<AccountsSettings />{:else if section === "usage"}<UsageSettings />{:else if section === "defaults"}<DefaultsSettings />{:else if section === "remote"}<RemoteSettings />{:else if section === "slack"}<SlackSettings />{:else if section === "versions"}<VersionsSettings />{/if}
    </div>
  </div>
</Modal>

<style>
  .settings { display: grid; grid-template-columns: 160px minmax(0, 1fr); height: min(72vh, 680px); }
  .sections { display: flex; flex-direction: column; gap: 2px; padding: 10px 8px; border-right: 1px solid var(--border); background: var(--bg-sunken); }
  .section { text-align: left; padding: 6px 10px; border-radius: var(--radius-small); font-size: 13px; color: var(--text-muted); }
  .section:hover { background: var(--bg-hover); color: var(--text); }
  .section[aria-current="page"] { background: var(--bg-active); color: var(--text); font-weight: 500; }
  .content { min-width: 0; min-height: 0; overflow: auto; }
</style>
