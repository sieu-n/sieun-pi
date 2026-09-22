<script lang="ts">
  import { onMount, untrack } from "svelte";
  import { api } from "./api.ts";
  import { store } from "./store.svelte.ts";
  import { ui } from "./ui.svelte.ts";
  import { isThreadBusy } from "../shared/thread-state.ts";
  import Sidebar from "./Sidebar.svelte";
  import Thread from "./Thread.svelte";
  import NewChat from "./NewChat.svelte";
  import Settings from "./Settings.svelte";

  const NARROW_BELOW = 900;
  let root: HTMLElement | undefined = $state();
  let narrow = $state(window.innerWidth < NARROW_BELOW);

  onMount(() => {
    store.start();
    const observer = new ResizeObserver(entries => {
      const width = entries[0]?.contentRect.width ?? window.innerWidth;
      const next = width < NARROW_BELOW;
      if (next !== narrow) store.sidebarOpen = !next;
      narrow = next;
    });
    if (root) observer.observe(root);
    return () => observer.disconnect();
  });

  let previous: string | null = null;
  $effect(() => {
    const id = store.selectedId;
    untrack(() => {
      if (previous && previous !== id) store.release(previous);
      if (id) store.open(id);
      if (id && narrow) store.sidebarOpen = false;
      previous = id;
    });
  });

  function focusSearch(): void {
    store.sidebarOpen = true;
    requestAnimationFrame(() => document.querySelector<HTMLInputElement>("[data-search]")?.focus());
  }

  function onKeydown(event: KeyboardEvent): void {
    const meta = event.metaKey || event.ctrlKey;
    if (meta && !event.shiftKey && !event.altKey) {
      const key = event.key.toLowerCase();
      if (key === "n") { event.preventDefault(); store.select(null); }
      else if (key === "k") { event.preventDefault(); focusSearch(); }
      else if (key === "b") { event.preventDefault(); store.sidebarOpen = !store.sidebarOpen; }
      return;
    }
    if (event.key === "Escape") {
      if (store.drawer) return;
      if (narrow && store.sidebarOpen) { store.sidebarOpen = false; return; }
      const id = store.selectedId;
      const state = id ? store.thread(id)?.state : undefined;
      const composerFocused = event.target instanceof HTMLElement && event.target.matches("[data-composer]");
      if (id && state && composerFocused && isThreadBusy(state)) void store.run(api.abort(id));
      return;
    }
    if (event.key === "F2" && store.selectedId) { event.preventDefault(); ui.requestRename(); }
  }
</script>

<svelte:window onkeydown={onKeydown} />

<div class="app" class:narrow bind:this={root} style:--sidebar="{ui.sidebarWidth}px">
  {#if store.daemon === "down"}
    <div class="banner" role="alert">
      <span>The Prime Agent daemon is not reachable{store.daemonError ? ". " + store.daemonError : "."}</span>
      <button class="button small" onclick={() => store.retry()}>Retry</button>
    </div>
  {/if}
  <div class="body">
    {#if narrow && store.sidebarOpen}
      <button class="scrim" aria-label="Close sidebar" onclick={() => { store.sidebarOpen = false; }}></button>
    {/if}
    <Sidebar {narrow} />
    <main class="main">
      {#if store.selectedId}
        {#key store.selectedId}
          <Thread id={store.selectedId} {narrow} />
        {/key}
      {:else}
        <NewChat {narrow} />
      {/if}
    </main>
    {#if store.drawer}
      <Settings section={store.drawer} />
    {/if}
  </div>
  {#if store.toasts.length}
    <div class="toasts" aria-live="polite">
      {#each store.toasts as toast (toast.id)}
        <div class="toast fade-in {toast.kind}">{toast.text}</div>
      {/each}
    </div>
  {/if}
</div>

<style>
  .app { display: flex; flex-direction: column; height: 100%; container-type: inline-size; container-name: app; }
  .banner { display: flex; align-items: center; justify-content: center; gap: 12px; padding: 8px 16px; background: var(--danger-soft); color: var(--danger); font-size: 14px; }
  .body { position: relative; display: flex; flex: 1; min-height: 0; }
  .main { position: relative; flex: 1; min-width: 0; display: flex; flex-direction: column; }
  .scrim { position: fixed; inset: 0; z-index: 40; background: rgba(0, 0, 0, 0.35); }
  .toasts { position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%); z-index: 60; display: flex; flex-direction: column; gap: 8px; align-items: center; pointer-events: none; }
  .toast { padding: 10px 16px; border-radius: var(--radius); background: var(--text); color: var(--bg); font-size: 14px; box-shadow: var(--shadow); max-width: min(520px, 90vw); }
  .toast.error { background: var(--danger); color: #fff; }
</style>
