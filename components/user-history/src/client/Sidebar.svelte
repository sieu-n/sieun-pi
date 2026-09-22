<script lang="ts">
  import { api } from "./api.ts";
  import { store } from "./store.svelte.ts";
  import { dateGroup, relativeTime, type DateGroup } from "./format.ts";
  import type { SessionRow } from "../shared/types.ts";
  import Icon from "./Icon.svelte";
  import { ui, SIDEBAR_MAX, SIDEBAR_MIN } from "./ui.svelte.ts";

  let { narrow }: { narrow: boolean } = $props();
  let query = $state("");
  let showArchived = $state(false);
  let renaming = $state<{ id: string; name: string } | null>(null);
  let now = $state(Date.now());
  let warmTimer: ReturnType<typeof setTimeout> | null = null;

  $effect(() => {
    const timer = setInterval(() => { now = Date.now(); }, 30_000);
    return () => clearInterval(timer);
  });

  const ORDER: readonly DateGroup[] = ["Today", "Yesterday", "Previous 7 days", "Older"];
  const activity = (row: SessionRow): number => Date.parse(row.lastActivityAt ?? row.created ?? "") || 0;
  const archivedCount = $derived(store.sessions.filter(row => row.archived).length);
  const groups = $derived.by(() => {
    const needle = query.trim().toLowerCase();
    const rows = store.sessions.filter(row => (showArchived || !row.archived) && (!needle || row.name.toLowerCase().includes(needle))).sort((a, b) => activity(b) - activity(a));
    const buckets = new Map<DateGroup, SessionRow[]>();
    for (const row of rows) {
      const label = dateGroup(row.lastActivityAt ?? row.created, now);
      const bucket = buckets.get(label);
      if (bucket) bucket.push(row); else buckets.set(label, [row]);
    }
    return ORDER.flatMap(label => { const items = buckets.get(label); return items ? [{ label, items }] : []; });
  });

  function warm(id: string): void {
    if (warmTimer) clearTimeout(warmTimer);
    warmTimer = setTimeout(() => store.warm(id), 150);
  }
  function cancelWarm(): void { if (warmTimer) { clearTimeout(warmTimer); warmTimer = null; } }

  function startRename(row: SessionRow): void { renaming = { id: row.id, name: row.named ? row.name : "" }; }
  async function commitRename(): Promise<void> {
    const current = renaming;
    renaming = null;
    if (!current) return;
    const name = current.name.trim();
    const row = store.session(current.id);
    if (!name || !row || name === row.name) return;
    await store.run(api.rename(current.id, name));
  }
  function onRenameKey(event: KeyboardEvent): void {
    if (event.key === "Enter") { event.preventDefault(); void commitRename(); }
    else if (event.key === "Escape") { event.stopPropagation(); renaming = null; }
  }
  function focusAndSelect(node: HTMLInputElement): void { node.focus(); node.select(); }

  let aside: HTMLElement | undefined = $state();
  let resizing = $state(false);
  function startResize(event: PointerEvent): void {
    if (event.button !== 0 || !aside) return;
    event.preventDefault();
    const handle = event.currentTarget as HTMLElement;
    const left = aside.getBoundingClientRect().left;
    handle.setPointerCapture(event.pointerId);
    resizing = true;
    const move = (next: PointerEvent) => ui.setSidebarWidth(next.clientX - left, false);
    const end = () => {
      resizing = false;
      ui.setSidebarWidth(ui.sidebarWidth, true);
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", end);
      handle.removeEventListener("pointercancel", end);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  }
  function resizeKey(event: KeyboardEvent): void {
    const next = event.key === "ArrowLeft" ? ui.sidebarWidth - 16 : event.key === "ArrowRight" ? ui.sidebarWidth + 16
      : event.key === "Home" ? SIDEBAR_MIN : event.key === "End" ? SIDEBAR_MAX : null;
    if (next === null) return;
    event.preventDefault();
    ui.setSidebarWidth(next, true);
  }
</script>

<aside class="sidebar" class:open={store.sidebarOpen} class:narrow class:resizing aria-label="Threads" bind:this={aside}>
  <div class="inner">
    <div class="top">
      <button class="new" onclick={() => store.select(null)}><Icon name="plus" size={16} /><span>New chat</span></button>
      <button class="icon-button" aria-label="Settings" title="Settings" onclick={() => { store.drawer = "accounts"; }}><Icon name="settings" /></button>
      <button class="icon-button" aria-label="Hide sidebar" title="Hide sidebar (Cmd+B)" onclick={() => { store.sidebarOpen = false; }}><Icon name="sidebar" /></button>
    </div>
    <label class="search">
      <Icon name="search" size={15} />
      <input data-search type="search" placeholder="Search threads" aria-label="Search threads" bind:value={query} />
    </label>
    <div class="list">
      {#each groups as group (group.label)}
        <div class="group-label">{group.label}</div>
        {#each group.items as row (row.id)}
          <div class="row" class:selected={row.id === store.selectedId} class:archived={row.archived} onmouseenter={() => warm(row.id)} onmouseleave={cancelWarm} role="presentation">
            {#if renaming?.id === row.id}
              <input class="field rename" bind:value={renaming.name} placeholder={row.name} aria-label="Thread name" use:focusAndSelect onkeydown={onRenameKey} onblur={() => void commitRename()} />
            {:else}
              <a class="link" href={"#" + encodeURIComponent(row.id)} title={row.name}>
                <span class="title">{row.name}</span>
                <span class="meta">
                  {#if row.status === "running"}<span class="spinner tiny" title={row.statusLabel ?? "Running"}></span>
                  {:else if row.unread}<span class="dot" title="Unread"></span>{/if}
                  <span class="time">{relativeTime(row.lastActivityAt ?? row.created, now)}</span>
                </span>
              </a>
              <button class="icon-button pencil" aria-label="Rename thread" title="Rename (F2)" onclick={() => startRename(row)}><Icon name="pencil" size={14} /></button>
            {/if}
          </div>
        {/each}
      {/each}
      {#if !groups.length}
        <div class="empty">{store.daemon === "unknown" ? "Loading threads" : query ? "No threads match." : "No threads yet."}</div>
      {/if}
      {#if archivedCount}
        <button class="archived-toggle" onclick={() => { showArchived = !showArchived; }}>{showArchived ? "Hide archived" : `Show ${archivedCount} archived`}</button>
      {/if}
    </div>
  </div>
  {#if !narrow && store.sidebarOpen}
    <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
    <div class="resize" role="separator" aria-orientation="vertical" aria-label="Resize sidebar" tabindex="0"
      aria-valuemin={SIDEBAR_MIN} aria-valuemax={SIDEBAR_MAX} aria-valuenow={ui.sidebarWidth}
      onpointerdown={startResize} onkeydown={resizeKey} ondblclick={() => ui.setSidebarWidth(260, true)}></div>
  {/if}
</aside>

<style>
  .sidebar { position: relative; flex: none; width: 0; overflow: hidden; background: var(--bg-sunken); border-right: 1px solid transparent; transition: width 0.18s ease; }
  .sidebar.resizing { transition: none; user-select: none; }
  .resize { position: absolute; top: 0; right: 0; bottom: 0; width: 6px; cursor: col-resize; z-index: 2; }
  .resize:hover, .resize:focus-visible, .resizing .resize { background: linear-gradient(to right, transparent 4px, var(--accent) 4px); outline: none; }
  .sidebar.open { width: var(--sidebar); border-right-color: var(--border); }
  .sidebar.narrow { position: fixed; top: 0; bottom: 0; left: 0; z-index: 50; width: min(var(--sidebar), 86vw); transform: translateX(-100%); transition: transform 0.2s ease; border-right-color: var(--border); box-shadow: none; }
  .sidebar.narrow.open { transform: none; box-shadow: var(--shadow); }
  .inner { display: flex; flex-direction: column; height: 100%; width: var(--sidebar); max-width: 100%; }
  .top { display: flex; align-items: center; gap: 6px; padding: 12px 12px 6px; }
  .new { display: inline-flex; align-items: center; gap: 8px; flex: 1; height: 34px; padding: 0 12px; border-radius: var(--radius-small); background: var(--bg-elevated); border: 1px solid var(--border); font-weight: 500; }
  .new:hover { border-color: var(--border-strong); }
  .search { display: flex; align-items: center; gap: 8px; margin: 4px 12px 8px; padding: 0 10px; height: 32px; border-radius: var(--radius-small); background: var(--bg-elevated); border: 1px solid var(--border); color: var(--text-faint); }
  .search:focus-within { border-color: var(--accent); }
  .search input { flex: 1; min-width: 0; border: 0; background: none; outline: none; font-size: 14px; }
  .search input::-webkit-search-cancel-button { appearance: none; }
  .list { flex: 1; overflow-y: auto; padding: 0 8px 8px; }
  .group-label { padding: 12px 8px 4px; font-size: 11px; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; color: var(--text-faint); }
  .row { position: relative; border-radius: var(--radius-small); }
  .row:hover { background: var(--bg-hover); }
  .row.selected { background: var(--bg-active); }
  .row.archived .title { color: var(--text-muted); }
  .link { display: flex; align-items: center; gap: 8px; padding: 7px 8px; color: inherit; text-decoration: none; font-size: 14px; min-width: 0; }
  .title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .meta { display: inline-flex; align-items: center; gap: 6px; flex: none; color: var(--text-faint); font-size: 12px; font-variant-numeric: tabular-nums; }
  .time { min-width: 26px; text-align: right; }
  .row:hover .time { visibility: hidden; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--accent); }
  .spinner.tiny { width: 11px; height: 11px; border-width: 1.5px; }
  .pencil { position: absolute; right: 4px; top: 50%; transform: translateY(-50%); width: 26px; height: 26px; opacity: 0; }
  .row:hover .pencil, .pencil:focus-visible { opacity: 1; }
  .rename { margin: 2px; width: calc(100% - 4px); font-size: 14px; padding: 4px 6px; }
  .empty { padding: 24px 8px; color: var(--text-faint); font-size: 13px; text-align: center; }
  .archived-toggle { display: block; width: 100%; padding: 8px; margin-top: 8px; font-size: 12px; color: var(--text-faint); border-radius: var(--radius-small); }
  .archived-toggle:hover { background: var(--bg-hover); color: var(--text-muted); }
</style>
