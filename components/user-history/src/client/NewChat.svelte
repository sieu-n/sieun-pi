<script lang="ts">
  import { onMount } from "svelte";
  import { api } from "./api.ts";
  import { store } from "./store.svelte.ts";
  import { labels, type TagSelection } from "./labels.ts";
  import { PRIORITY_LABEL, PROGRESS_LABEL } from "./organize.ts";
  import type { ImageInput, ModelCatalog, ModelInfo, NewChatAccount, Priority, Progress, SendMode, ThinkingLevel, Workspace } from "../shared/types.ts";
  import { relativeTime, shortPath } from "./format.ts";
  import ModelPicker from "./ModelPicker.svelte";
  import Composer from "./Composer.svelte";
  import Popover from "./Popover.svelte";
  import Icon from "./Icon.svelte";
  import AccountChip from "./AccountChip.svelte";
  import { tooltip } from "./ui/tooltip.ts";
  import Floating from "./ui/Floating.svelte";
  import TagPicker from "./ui/TagPicker.svelte";
  import TagChip from "./TagChip.svelte";
  import PriorityBars from "./PriorityBars.svelte";
  import ProgressSteps from "./ProgressSteps.svelte";
  import PriorityPicker from "./PriorityPicker.svelte";
  import ProgressPicker from "./ProgressPicker.svelte";
  import Lightbox from "./ui/Lightbox.svelte";

  let { narrow }: { narrow: boolean } = $props();
  let workspaces = $state<Workspace[]>([]);
  let cwd = $state("");
  let customCwd = $state("");
  let catalog = $state<ModelCatalog | null>(null);
  let catalogError = $state<string | null>(null);
  let model = $state<ModelInfo | null>(null);
  let effort = $state<ThinkingLevel | null>(null);
  let workspaceOpen = $state(false);
  /** An explicit thread name; empty lets Prime Agent title the thread from its first message. */
  let threadName = $state("");
  const closePopover = () => { workspaceOpen = false; };
  let lightbox = $state<number | null>(null);

  /** Labels for the thread this send creates; they are written to it right after the create returns its id. */
  let draftTags = $state<string[]>([]);
  let draftPriority = $state<Priority>(0);
  let draftProgress = $state<Progress>("none");
  let labelPicker = $state<{ field: "tags" | "priority" | "progress"; anchor: HTMLElement } | null>(null);
  const shownTags = $derived(store.tags.filter(tag => draftTags.includes(tag.id)));
  const draftSelection: TagSelection = {
    label: "Tags for the new thread",
    coverage: tag => draftTags.includes(tag.id) ? "all" : "none",
    set: async (tagId, on) => { draftTags = on ? [...draftTags.filter(entry => entry !== tagId), tagId] : draftTags.filter(entry => entry !== tagId); },
    create: async name => { const tagId = await labels.create(name, []); if (tagId && !draftTags.includes(tagId)) draftTags = [...draftTags, tagId]; },
  };
  function pick(event: MouseEvent, field: "tags" | "priority" | "progress"): void {
    const anchor = event.currentTarget as HTMLElement;
    labelPicker = labelPicker?.field === field ? null : { field, anchor };
  }

  const hour = new Date().getHours();
  const greeting = hour < 5 ? "Still up?" : hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  const shownEffort = $derived(effort ?? (model ? null : catalog?.thinkingLevel ?? null));
  const modelLabel = $derived((model?.name ?? catalog?.current?.name ?? "Default model") + (shownEffort ? " · " + shownEffort : ""));
  const effortLevels = $derived((model ?? catalog?.current)?.thinkingLevels ?? catalog?.availableThinkingLevels ?? []);
  $effect(() => { if (effort && !effortLevels.includes(effort)) effort = null; });
  const activeModel = $derived(model ?? catalog?.current ?? null);
  /** The pool account for the new chat; null follows the pool. A model from another provider resets it. */
  let account = $state<NewChatAccount | null>(null);
  $effect(() => { if (account && activeModel && activeModel.provider !== account.provider) account = null; });
  const acceptsImages = $derived((model ?? catalog?.current)?.input.includes("image") ?? true);

  onMount(() => {
    api.workspaces().then(list => { workspaces = list; if (!cwd && list[0]) cwd = list[0].cwd; }, error => store.toast(error instanceof Error ? error.message : String(error)));
  });
  $effect(() => {
    void store.defaultsRevision;
    let cancelled = false;
    api.models(null).then(result => { if (!cancelled) { catalog = result; catalogError = null; } }, error => { if (!cancelled) catalogError = error instanceof Error ? error.message : String(error); });
    return () => { cancelled = true; };
  });

  /** The folder dialog opens on the Mac running the service, so it is offered only on a loopback page. */
  const canChooseFolder = ["127.0.0.1", "localhost", "[::1]"].includes(location.hostname);
  let choosing = $state(false);
  const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

  function useWorkspace(path: string): void {
    cwd = path;
    if (!workspaces.some(workspace => workspace.cwd === path)) workspaces = [{ cwd: path, count: 0 }, ...workspaces];
    customCwd = "";
    closePopover();
  }
  async function typeWorkspace(): Promise<void> {
    if (!customCwd.trim()) return;
    try { useWorkspace(await api.resolveWorkspace(customCwd)); } catch (error) { store.toast(errorText(error)); }
  }
  async function browseWorkspace(): Promise<void> {
    if (choosing) return;
    choosing = true;
    try { const chosen = await api.chooseFolder(cwd); if (chosen) useWorkspace(chosen); }
    catch (error) { store.toast(errorText(error)); }
    finally { choosing = false; }
  }

  async function send(text: string, images: ImageInput[], _mode: SendMode): Promise<boolean> {
    if (!cwd) { store.toast("Choose a workspace first."); return false; }
    const tags = shownTags.map(tag => tag.id);
    const priority = draftPriority;
    const progress = draftProgress;
    const chosen = activeModel;
    const name = threadName.trim();
    const id = await store.createChat({ cwd, ...(name ? { name } : {}), message: text, images, ...(chosen ? { provider: chosen.provider, modelId: chosen.id } : {}), ...(shownEffort ? { thinkingLevel: shownEffort } : {}),
      ...(account ? { account } : {}) });
    if (!id) return false;
    threadName = "";
    draftTags = [];
    draftPriority = 0;
    draftProgress = "none";
    await Promise.all([
      ...tags.map(tagId => labels.setTag([id], tagId, true)),
      priority ? labels.setPriority([id], priority) : null,
      progress !== "none" ? labels.setProgress([id], progress) : null,
    ]);
    return true;
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
                  <button type="button" class="view" aria-label="View image {index + 1}" onclick={() => { lightbox = index; }}><img src={"data:" + image.mimeType + ";base64," + image.data} alt="Attached" /></button>
                {/each}
              </div>
            {/if}
            {#if store.pending.message}<div class="text">{store.pending.message}</div>{/if}
          </div>
          {#if store.pending.name}<div class="pending-name">{store.pending.name}</div>{/if}
          <div class="starting"><span class="spinner"></span> Starting the chat in {shortPath(store.pending.cwd)}</div>
        </div>
      {:else}
        <h1 class="greeting">{greeting}</h1>
        <input class="thread-name" type="text" maxlength="200" placeholder="Thread name (optional)" aria-label="Thread name" autocomplete="off" spellcheck="false" bind:value={threadName}
          onkeydown={event => { if (event.key === "Enter") { event.preventDefault(); document.querySelector<HTMLTextAreaElement>("[data-composer]")?.focus(); } }} />
        <Composer draftKey="new" {acceptsImages} focusOnMount={!narrow} {send} placeholder="Ask Prime Agent anything" />
        <div class="options-row">
          <div class="group" role="group" aria-label="Setup for the new thread">
            <Popover open={workspaceOpen} onclose={closePopover} width={340} label="Workspace">
              {#snippet trigger()}
                <button type="button" class="bar-button" aria-haspopup="dialog" aria-expanded={workspaceOpen} aria-label="Workspace: {cwd || 'none'}" onclick={() => { workspaceOpen = !workspaceOpen; }}>
                  <Icon name="folder" size={14} /><span class="label">{cwd ? shortPath(cwd) : "Workspace"}</span><Icon name="chevronDown" size={12} />
                </button>
              {/snippet}
              {#each workspaces as workspace (workspace.cwd)}
                <button type="button" class="menu-item" class:current={workspace.cwd === cwd} onclick={() => useWorkspace(workspace.cwd)}>
                  <span class="path"><bdi>{workspace.cwd.replace(/^\/Users\/[^/]+/, "~")}</bdi></span>
                  <span class="hint">{workspace.count}{workspace.lastUsedAt ? " · " + relativeTime(workspace.lastUsedAt) : ""}</span>
                </button>
              {/each}
              <div class="menu-separator"></div>
              <form class="custom" onsubmit={event => { event.preventDefault(); void typeWorkspace(); }}>
                <input class="field" placeholder="~/path or /absolute/path" aria-label="Other workspace path" bind:value={customCwd} />
                <button class="button small primary" type="submit" disabled={!customCwd.trim()}>Use</button>
              </form>
              {#if canChooseFolder}
                <button type="button" class="menu-item choose" disabled={choosing} onclick={() => void browseWorkspace()}>
                  <Icon name="folder" size={14} /><span>{choosing ? "Waiting for the folder dialog…" : "Choose path…"}</span>
                </button>
              {/if}
            </Popover>
            <AccountChip threadId={null} provider={activeModel?.provider} model={activeModel ? activeModel.id + " " + activeModel.name : undefined}
              choice={account} onchoose={next => { account = next; }} />
            <ModelPicker label={modelLabel} {catalog} error={catalogError} current={model} effort={effort} levels={effortLevels} defaultEffort
              defaultLabel={catalog?.current?.name ?? ""} ondefault={() => { model = null; }} onchoose={entry => { model = entry; }} oneffort={level => { effort = level; }} />
          </div>
          <div class="group" role="group" aria-label="Labels for the new thread">
            <button type="button" class="bar-button" aria-haspopup="dialog" aria-expanded={labelPicker?.field === "tags"} onclick={event => pick(event, "tags")}>
              <Icon name="tag" size={13} />
              {#if shownTags.length}{#each shownTags as tag (tag.id)}<TagChip {tag} />{/each}{:else}<span>Tags</span>{/if}
            </button>
            <button type="button" class="bar-button" aria-haspopup="dialog" aria-expanded={labelPicker?.field === "priority"} onclick={event => pick(event, "priority")}>
              <PriorityBars level={draftPriority} /><span>{draftPriority ? PRIORITY_LABEL[draftPriority] : "Priority"}</span>
            </button>
            <button type="button" class="bar-button" aria-haspopup="dialog" aria-expanded={labelPicker?.field === "progress"} onclick={event => pick(event, "progress")}>
              <ProgressSteps progress={draftProgress} /><span>{draftProgress !== "none" ? PROGRESS_LABEL[draftProgress] : "Progress"}</span>
            </button>
          </div>
        </div>
      {/if}
    </div>
  </div>
</div>

{#if lightbox !== null && store.pending}
  <Lightbox images={store.pending.images.map((image, index) => ({ src: "data:" + image.mimeType + ";base64," + image.data, alt: `Image ${index + 1}` }))} index={lightbox} onclose={() => { lightbox = null; }} />
{/if}
{#if labelPicker}
  {#if labelPicker.field === "tags"}
    <Floating anchor={labelPicker.anchor} width={260} maxHeight={360} label="Tags for the new thread" onclose={() => { labelPicker = null; }}><TagPicker selection={draftSelection} /></Floating>
  {:else if labelPicker.field === "priority"}
    <Floating anchor={labelPicker.anchor} width={210} maxHeight={120} label="Priority for the new thread" onclose={() => { labelPicker = null; }}>
      <div class="menu-heading">Priority</div>
      <PriorityPicker value={draftPriority} autofocus onchange={level => { draftPriority = level; labelPicker = null; }} />
    </Floating>
  {:else}
    <Floating anchor={labelPicker.anchor} width={300} maxHeight={120} label="Progress for the new thread" onclose={() => { labelPicker = null; }}>
      <div class="menu-heading">Progress</div>
      <ProgressPicker value={draftProgress} autofocus onchange={step => { draftProgress = step; labelPicker = null; }} />
    </Floating>
  {/if}
{/if}

<style>
  .new-chat { display: flex; flex-direction: column; height: 100%; }
  .top { display: flex; align-items: center; padding: 0 8px; height: 40px; }
  .center { flex: 1; display: flex; align-items: center; justify-content: center; padding: 0 20px 10vh; overflow-y: auto; }
  .column { width: 100%; max-width: var(--column); }
  .greeting { margin: 0 0 18px; font-size: 28px; font-weight: 600; letter-spacing: -0.01em; }
  .thread-name { display: block; width: 100%; margin: 0 0 8px; padding: 6px 4px; border: 0; border-bottom: 1px solid transparent; background: none; outline: none; color: var(--text); font-size: 15px; font-weight: 600; }
  .thread-name::placeholder { color: var(--text-faint); font-weight: 500; }
  .thread-name:hover { border-bottom-color: var(--border); }
  .thread-name:focus { border-bottom-color: var(--accent); }
  .pending-name { align-self: flex-start; font-size: 15px; font-weight: 600; }
  .options-row { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 4px 12px; margin-top: 8px; padding: 0 4px; }
  .group { display: flex; flex-wrap: wrap; align-items: center; gap: 2px; min-width: 0; }
  .group .bar-button { gap: 6px; }
  .options-row :global(.bar-button), .options-row :global(.account) { height: 26px; font-size: 12.5px; }
  .path { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; direction: rtl; text-align: left; font-family: var(--mono); font-size: 12px; }
  .custom { display: flex; gap: 6px; padding: 6px 4px 2px; }
  .pending { display: flex; flex-direction: column; align-items: flex-end; gap: 16px; }
  .bubble { max-width: min(85%, 640px); padding: 10px 16px; border-radius: 18px 18px 6px 18px; background: var(--user-bubble); }
  .text { white-space: pre-wrap; overflow-wrap: anywhere; }
  .images { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 6px; }
  .view { display: block; cursor: zoom-in; border-radius: var(--radius-small); }
  .images img { max-width: 200px; max-height: 200px; border-radius: var(--radius-small); display: block; }
  .starting { align-self: flex-start; display: flex; align-items: center; gap: 10px; color: var(--text-muted); font-size: 14px; }
  @container app (max-width: 899px) { .greeting { font-size: 24px; } .center { padding-bottom: 4vh; } }
</style>
