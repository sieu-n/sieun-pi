<script lang="ts">
  import type { Component } from "svelte";
  import { store } from "./store.svelte.ts";
  import { SETTINGS_SECTIONS, type SettingsSection } from "./settings-sections.ts";
  import Modal from "./Modal.svelte";
  import Icon from "./Icon.svelte";
  import { tooltip } from "./ui/tooltip.ts";
  import AccountsSettings from "./AccountsSettings.svelte";
  import UsageSettings from "./UsageSettings.svelte";
  import NewChatsSettings from "./NewChatsSettings.svelte";
  import AppearanceSettings from "./AppearanceSettings.svelte";
  import RemoteSettings from "./RemoteSettings.svelte";
  import SlackSettings from "./SlackSettings.svelte";
  import MachineSettings from "./MachineSettings.svelte";
  import UpdatesSettings from "./UpdatesSettings.svelte";
  import HowItWorksSettings from "./HowItWorksSettings.svelte";

  let { section }: { section: SettingsSection } = $props();
  const PANES: Record<SettingsSection, Component> = { accounts: AccountsSettings, usage: UsageSettings, "new-chats": NewChatsSettings, appearance: AppearanceSettings,
    remote: RemoteSettings, slack: SlackSettings, machine: MachineSettings, updates: UpdatesSettings, how: HowItWorksSettings };
  const Pane = $derived(PANES[section]);
</script>

<Modal title="Settings" width="920px" onclose={() => { store.drawer = null; }}>
  <div class="settings">
    <nav class="sections" aria-label="Settings sections">
      {#each SETTINGS_SECTIONS as entry (entry.id)}
        <button class="section" class:guide={entry.id === "how"} aria-current={entry.id === section ? "page" : undefined} use:tooltip={{ text: entry.description, side: "right" }} onclick={() => { store.drawer = entry.id; }}>
          <Icon name={entry.icon} size={15} /><span>{entry.label}</span>
        </button>
      {/each}
    </nav>
    <div class="content"><Pane /></div>
  </div>
</Modal>

<style>
  .settings { display: grid; grid-template-columns: 176px minmax(0, 1fr); height: min(72vh, 680px); }
  .sections { display: flex; flex-direction: column; gap: 2px; padding: 10px 8px; border-right: 1px solid var(--border); background: var(--bg-sunken); overflow-y: auto; }
  .section { display: flex; align-items: center; gap: 9px; text-align: left; padding: 6px 10px; border-radius: var(--radius-small); font-size: 13px; color: var(--text-muted); }
  .section :global(svg) { flex: none; color: var(--text-faint); }
  .section:hover { background: var(--bg-hover); color: var(--text); }
  .section:hover :global(svg) { color: var(--text-muted); }
  .section[aria-current="page"] { background: var(--bg-active); color: var(--text); font-weight: 500; }
  .section[aria-current="page"] :global(svg) { color: var(--accent); }
  .section.guide { margin-top: auto; }
  .content { min-width: 0; min-height: 0; overflow: auto; }
</style>
