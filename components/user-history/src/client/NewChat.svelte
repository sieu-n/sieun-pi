<script lang="ts">
  import { onMount } from "svelte";
  import { api } from "./api.ts";
  import { store } from "./store.svelte.ts";
  import type { ImageInput, ModelCatalog, ModelInfo, SendMode, ThinkingLevel, Workspace } from "../shared/types.ts";
  import { relativeTime, shortPath } from "./format.ts";
  import ModelMenu from "./ModelMenu.svelte";
  import Composer from "./Composer.svelte";
  import Popover from "./Popover.svelte";
  import Icon from "./Icon.svelte";
  import AccountChip from "./AccountChip.svelte";

  let { narrow }: { narrow: boolean } = $props();
  let workspaces = $state<Workspace[]>([]);
  let cwd = $state("");
  let customCwd = $state("");
  let catalog = $state<ModelCatalog | null>(null);
  let catalogError = $state<string | null>(null);
  let model = $state<ModelInfo | null>(null);
  let effort = $state<ThinkingLevel | null>(null);
  type PopoverName = "workspace" | "model" | "effort";
  let popover = $state<PopoverName | null>(null);
  const closePopover = () => { popover = null; };

  const hour = new Date().getHours();
  const greeting = hour < 5 ? "Still up?" : hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  const modelLabel = $derived(model?.name ?? catalog?.current?.name ?? "Default model");
  const effortLevels = $derived(catalog?.availableThinkingLevels ?? []);
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
      <button class="icon-button" aria-label="Show sidebar" title="Show sidebar (Cmd+B)" onclick={() => { store.sidebarOpen = true; }}><Icon name={narrow ? "menu" : "sidebar"} /></button>
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
        <p class="sub">What are we working on?</p>
        <Composer draftKey="new" {acceptsImages} focusOnMount={!narrow} {send} placeholder="Ask Prime Agent anything">
          {#snippet left()}
            <Popover open={popover === "workspace"} onclose={closePopover} width="320px">
              {#snippet trigger()}
                <button class="bar-button" onclick={() => { popover = popover === "workspace" ? null : "workspace"; }} title={cwd || "Workspace"}>
                  <Icon name="folder" size={14} /><span class="label">{cwd ? shortPath(cwd) : "Workspace"}</span><Icon name="chevronDown" size={12} />
                </button>
              {/snippet}
              {#each workspaces as workspace (workspace.cwd)}
                <button class="menu-item" class:current={workspace.cwd === cwd} onclick={() => chooseWorkspace(workspace.cwd)}>
                  <span class="path">{workspace.cwd.replace(/^\/Users\/[^/]+/, "~")}</span>
                  <span class="hint">{workspace.count}{workspace.lastUsedAt ? " · " + relativeTime(workspace.lastUsedAt) : ""}</span>
                </button>
              {/each}
              <div class="menu-separator"></div>
              <form class="custom" onsubmit={event => { event.preventDefault(); chooseWorkspace(customCwd); }}>
                <input class="field" placeholder="/absolute/path" aria-label="Other workspace path" bind:value={customCwd} />
                <button class="button small" type="submit" disabled={!customCwd.trim()}>Use</button>
              </form>
            </Popover>
            <AccountChip threadId={null} provider={(model ?? catalog?.current)?.provider} />
          {/snippet}
          {#snippet right()}
            <Popover open={popover === "model"} onclose={closePopover} align="end" width="260px">
              {#snippet trigger()}
                <button class="bar-button" onclick={() => { popover = popover === "model" ? null : "model"; }} title="Model">
                  <span class="label">{modelLabel}</span><Icon name="chevronDown" size={12} />
                </button>
              {/snippet}
              <ModelMenu {catalog} error={catalogError} current={model} defaultLabel={catalog?.current?.name ?? ""} ondefault={() => { model = null; closePopover(); }} onchoose={entry => { model = entry; closePopover(); }} />
            </Popover>
            <Popover open={popover === "effort"} onclose={closePopover} align="end" width="160px">
              {#snippet trigger()}
                <button class="bar-button" disabled={!effortLevels.length} onclick={() => { popover = popover === "effort" ? null : "effort"; }} title="Effort">
                  <span class="label">{effort ?? "Default effort"}</span><Icon name="chevronDown" size={12} />
                </button>
              {/snippet}
              <button class="menu-item" class:current={effort === null} onclick={() => { effort = null; closePopover(); }}>Default</button>
              {#each effortLevels as level (level)}
                <button class="menu-item" class:current={effort === level} onclick={() => { effort = level; closePopover(); }}>{level}</button>
              {/each}
            </Popover>
          {/snippet}
        </Composer>
      {/if}
    </div>
  </div>
</div>

<style>
  .new-chat { display: flex; flex-direction: column; height: 100%; }
  .top { display: flex; align-items: center; padding: 8px 12px; min-height: 52px; }
  .center { flex: 1; display: flex; align-items: center; justify-content: center; padding: 0 20px 10vh; overflow-y: auto; }
  .column { width: 100%; max-width: var(--column); }
  .greeting { margin: 0 0 4px; font-size: 28px; font-weight: 600; letter-spacing: -0.01em; }
  .sub { margin: 0 0 20px; color: var(--text-muted); font-size: 16px; }
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
