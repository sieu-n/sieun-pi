<script lang="ts">
  import { onMount } from "svelte";
  import { api } from "./api.ts";
  import { store } from "./store.svelte.ts";
  import type { ImageInput, ModelCatalog, ModelInfo, SendMode, ThinkingLevel, Workspace } from "../shared/types.ts";
  import { relativeTime, shortPath } from "./format.ts";
  import ModelPicker from "./ModelPicker.svelte";
  import Composer from "./Composer.svelte";
  import Popover from "./Popover.svelte";
  import Icon from "./Icon.svelte";
  import AccountChip from "./AccountChip.svelte";
  import { tooltip } from "./ui/tooltip.ts";

  let { narrow }: { narrow: boolean } = $props();
  let workspaces = $state<Workspace[]>([]);
  let cwd = $state("");
  let customCwd = $state("");
  let catalog = $state<ModelCatalog | null>(null);
  let catalogError = $state<string | null>(null);
  let model = $state<ModelInfo | null>(null);
  let effort = $state<ThinkingLevel | null>(null);
  let workspaceOpen = $state(false);
  const closePopover = () => { workspaceOpen = false; };

  const hour = new Date().getHours();
  const greeting = hour < 5 ? "Still up?" : hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  const modelLabel = $derived((model?.name ?? catalog?.current?.name ?? "Default model") + (effort ? " · " + effort : ""));
  const effortLevels = $derived((model ?? catalog?.current)?.thinkingLevels ?? catalog?.availableThinkingLevels ?? []);
  $effect(() => { if (effort && !effortLevels.includes(effort)) effort = null; });
  const acceptsImages = $derived((model ?? catalog?.current)?.input.includes("image") ?? true);

  onMount(() => {
    api.workspaces().then(list => { workspaces = list; if (!cwd && list[0]) cwd = list[0].cwd; }, error => store.toast(error instanceof Error ? error.message : String(error)));
    api.models(null).then(result => { catalog = result; }, error => { catalogError = error instanceof Error ? error.message : String(error); });
  });

  function chooseWorkspace(path: string): void {
    const trimmed = path.trim();
    if (!trimmed.startsWith("/")) { store.toast("Use an absolute workspace path."); return; }
    cwd = trimmed;
    customCwd = "";
    closePopover();
  }

  async function send(text: string, images: ImageInput[], _mode: SendMode): Promise<boolean> {
    if (!cwd) { store.toast("Choose a workspace first."); return false; }
    return store.createChat({ cwd, message: text, images, ...(model ? { provider: model.provider, modelId: model.id } : {}), ...(effort ? { thinkingLevel: effort } : {}) });
  }
</script>

<div class="new-chat">
  <div class="top">
    {#if !store.sidebarOpen || narrow}
      <button class="icon-button" aria-label="Show sidebar" use:tooltip={"Show sidebar ⌘B"} onclick={() => { store.sidebarOpen = true; }}><Icon name={narrow ? "menu" : "sidebar"} /></button>
    {/if}
  </div>
  <div class="center">
    <div class="column">
      {#if store.pending}
        <div class="pending fade-in">
          <div class="bubble">
            {#if store.pending.images.length}
              <div class="images">
                {#each store.pending.images as image, index (index)}
                  <img src={"data:" + image.mimeType + ";base64," + image.data} alt="Attached" />
                {/each}
              </div>
            {/if}
            {#if store.pending.message}<div class="text">{store.pending.message}</div>{/if}
          </div>
          <div class="starting"><span class="spinner"></span> Starting the chat in {shortPath(store.pending.cwd)}</div>
        </div>
      {:else}
        <h1 class="greeting">{greeting}</h1>
        <Composer draftKey="new" {acceptsImages} focusOnMount={!narrow} {send} placeholder="Ask Prime Agent anything">
          {#snippet left()}
            <Popover open={workspaceOpen} onclose={closePopover} width={340} label="Workspace">
              {#snippet trigger()}
                <button type="button" class="bar-button" aria-haspopup="dialog" aria-expanded={workspaceOpen} aria-label="Workspace: {cwd || 'none'}" onclick={() => { workspaceOpen = !workspaceOpen; }}>
                  <Icon name="folder" size={14} /><span class="label">{cwd ? shortPath(cwd) : "Workspace"}</span><Icon name="chevronDown" size={12} />
                </button>
              {/snippet}
              {#each workspaces as workspace (workspace.cwd)}
                <button type="button" class="menu-item" class:current={workspace.cwd === cwd} onclick={() => chooseWorkspace(workspace.cwd)}>
                  <span class="path">{workspace.cwd.replace(/^\/Users\/[^/]+/, "~")}</span>
                  <span class="hint">{workspace.count}{workspace.lastUsedAt ? " · " + relativeTime(workspace.lastUsedAt) : ""}</span>
                </button>
              {/each}
              <div class="menu-separator"></div>
              <form class="custom" onsubmit={event => { event.preventDefault(); chooseWorkspace(customCwd); }}>
                <input class="field" placeholder="/absolute/path" aria-label="Other workspace path" bind:value={customCwd} />
                <button class="button small primary" type="submit" disabled={!customCwd.trim()}>Use</button>
              </form>
            </Popover>
            <AccountChip threadId={null} provider={(model ?? catalog?.current)?.provider} />
          {/snippet}
          {#snippet right()}
            <ModelPicker label={modelLabel} {catalog} error={catalogError} current={model} effort={effort} levels={effortLevels} defaultEffort
              defaultLabel={catalog?.current?.name ?? ""} ondefault={() => { model = null; }} onchoose={entry => { model = entry; }} oneffort={level => { effort = level; }} />
          {/snippet}
        </Composer>
      {/if}
    </div>
  </div>
</div>

<style>
  .new-chat { display: flex; flex-direction: column; height: 100%; }
  .top { display: flex; align-items: center; padding: 0 8px; height: 40px; }
  .center { flex: 1; display: flex; align-items: center; justify-content: center; padding: 0 20px 10vh; overflow-y: auto; }
  .column { width: 100%; max-width: var(--column); }
  .greeting { margin: 0 0 18px; font-size: 28px; font-weight: 600; letter-spacing: -0.01em; }
  .path { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; direction: rtl; text-align: left; font-family: var(--mono); font-size: 12px; }
  .custom { display: flex; gap: 6px; padding: 6px 4px 2px; }
  .pending { display: flex; flex-direction: column; align-items: flex-end; gap: 16px; }
  .bubble { max-width: min(85%, 640px); padding: 10px 16px; border-radius: 18px 18px 6px 18px; background: var(--user-bubble); }
  .text { white-space: pre-wrap; overflow-wrap: anywhere; }
  .images { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 6px; }
  .images img { max-width: 200px; max-height: 200px; border-radius: var(--radius-small); display: block; }
  .starting { align-self: flex-start; display: flex; align-items: center; gap: 10px; color: var(--text-muted); font-size: 14px; }
  @container app (max-width: 899px) { .greeting { font-size: 24px; } .center { padding-bottom: 4vh; } }
</style>
