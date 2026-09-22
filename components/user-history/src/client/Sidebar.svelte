<script lang="ts">
  import { api } from "./api.ts";
  import { store } from "./store.svelte.ts";
  import { labels } from "./labels.ts";
  import { BUCKET_LABEL, elapsed, groupRows, matchesQuery, needsResponse, nextRun, shortDate, tabOf, type Tab } from "./organize.ts";
  import type { Priority, SessionRow } from "../shared/types.ts";
  import Icon from "./Icon.svelte";
  import PriorityBars from "./PriorityBars.svelte";
  import TagChip from "./TagChip.svelte";
  import ThreadMenu from "./ThreadMenu.svelte";
  import AgentsDialog from "./AgentsDialog.svelte";
  import { ui, SIDEBAR_MAX, SIDEBAR_MIN } from "./ui.svelte.ts";

  let { narrow }: { narrow: boolean } = $props();
  let query = $state("");
  let tab = $state<Tab>("threads");
  let showArchived = $state(false);
  let renaming = $state<{ id: string; name: string } | null>(null);
  let menu = $state<{ id: string; at: { x: number; y: number } } | null>(null);
  let agentsOpen = $state(false);
  let now = $state(Date.now());
  let list: HTMLElement | undefined = $state();
  let warmTimer: ReturnType<typeof setTimeout> | null = null;

  $effect(() => {
    const timer = setInterval(() => { now = Date.now(); }, 15_000);
    return () => clearInterval(timer);
  });

  const tagMap = $derived(new Map(store.tags.map(tag => [tag.id, tag])));
  const visible = $derived(store.sessions.filter(row => showArchived || !row.archived));
  const counts = $derived({
    threads: visible.filter(row => tabOf(row) === "threads").length,
    heartbeats: visible.filter(row => tabOf(row) === "heartbeats").length,
    heartbeatsNeeding: visible.filter(row => tabOf(row) === "heartbeats" && needsResponse(row)).length,
  });
  const archivedCount = $derived(store.sessions.filter(row => row.archived && tabOf(row) === tab).length);
  const groups = $derived(groupRows(visible.filter(row => tabOf(row) === tab && matchesQuery(row, query.trim(), tagMap))));

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

  function openMenu(row: SessionRow, event: MouseEvent): void {
    event.preventDefault();
    const box = (event.currentTarget as HTMLElement).getBoundingClientRect();
    menu = { id: row.id, at: event.type === "contextmenu" ? { x: event.clientX, y: event.clientY } : { x: box.left, y: box.bottom + 4 } };
  }
  function closeMenu(): void {
    const id = menu?.id;
    menu = null;
    if (id) requestAnimationFrame(() => list?.querySelector<HTMLElement>(`[data-row="${CSS.escape(id)}"]`)?.focus());
  }

  function onRowKey(row: SessionRow, event: KeyboardEvent): void {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const links = list ? [...list.querySelectorAll<HTMLElement>("[data-row]")] : [];
      const index = links.indexOf(event.currentTarget as HTMLElement);
      links[event.key === "ArrowDown" ? Math.min(links.length - 1, index + 1) : Math.max(0, index - 1)]?.focus();
    } else if (/^[0-3]$/.test(event.key)) {
      event.preventDefault();
      void labels.setPriority([row.id], Number(event.key) as Priority);
    } else if (event.key === "F2") {
      event.preventDefault(); event.stopPropagation();
      startRename(row);
    } else if (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey) || event.key === "t") {
      event.preventDefault();
      const box = (event.currentTarget as HTMLElement).getBoundingClientRect();
      menu = { id: row.id, at: { x: box.left + 24, y: box.bottom } };
    }
  }

  function workingLabel(row: SessionRow): string {
    if (row.statusLabel) return row.statusLabel;
    const since = Date.parse(row.workingSince ?? "");
    return Number.isFinite(since) ? "working " + elapsed(Math.max(0, now - since)) : "working";
  }
  function rowTitle(row: SessionRow): string {
    const created = row.created ? "Created " + new Date(row.created).toLocaleString() : "";
    const active = row.lastActivityAt ? "Last activity " + new Date(row.lastActivityAt).toLocaleString() : "";
    return [row.name, created, active].filter(Boolean).join("\n");
  }

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
      <button class="icon-button" aria-label="Agents view" title="Agents view: search, filter and label all threads" onclick={() => { agentsOpen = true; }}><Icon name="list" /></button>
      <button class="icon-button" aria-label="Settings" title="Settings" onclick={() => { store.drawer = "accounts"; }}><Icon name="settings" /></button>
      <button class="icon-button" aria-label="Hide sidebar" title="Hide sidebar (Cmd+B)" onclick={() => { store.sidebarOpen = false; }}><Icon name="sidebar" /></button>
    </div>
    <label class="search">
      <Icon name="search" size={15} />
      <input data-search type="search" placeholder="Search threads or tags" aria-label="Search threads" bind:value={query} />
    </label>
    <div class="tabs" role="tablist" aria-label="Thread kind">
      <button role="tab" aria-selected={tab === "threads"} class:active={tab === "threads"} onclick={() => { tab = "threads"; }}>Threads <span class="count">{counts.threads}</span></button>
      <button role="tab" aria-selected={tab === "heartbeats"} class:active={tab === "heartbeats"} onclick={() => { tab = "heartbeats"; }}
        title="Threads with an active or paused heartbeat or cron job">
        Heartbeats <span class="count">{counts.heartbeats}</span>{#if counts.heartbeatsNeeding && tab !== "heartbeats"}<span class="dot small" title="{counts.heartbeatsNeeding} need a response"></span>{/if}
      </button>
    </div>
    <div class="list" bind:this={list} role="tabpanel">
      {#each groups as group, index (group.bucket)}
        {#if group.bucket !== "other" || index > 0}<div class="group-label">{BUCKET_LABEL[group.bucket]} <span class="count">{group.rows.length}</span></div>{/if}
        {#each group.rows as row (row.id)}
          <div class="row" class:selected={row.id === store.selectedId} class:archived={row.archived} class:menu-open={menu?.id === row.id}
            onmouseenter={() => warm(row.id)} onmouseleave={cancelWarm} oncontextmenu={event => openMenu(row, event)} role="presentation">
            {#if renaming?.id === row.id}
              <input class="field rename" bind:value={renaming.name} placeholder={row.name} aria-label="Thread name" use:focusAndSelect onkeydown={onRenameKey} onblur={() => void commitRename()} />
            {:else}
              <a class="link" data-row={row.id} href={"#" + encodeURIComponent(row.id)} title={rowTitle(row)} onkeydown={event => onRowKey(row, event)}>
                <span class="line">
                  <span class="title" class:strong={needsResponse(row)}>{row.name}</span>
                  <span class="status">
                    {#if row.status === "running"}<span class="spinner tiny"></span><span class="working">{workingLabel(row)}</span>
                    {:else if needsResponse(row)}<span class="dot" title="Needs response"></span>{/if}
                  </span>
                </span>
                <span class="line sub">
                  {#if row.schedule}
                    <span class="date">{row.schedule.label ?? row.schedule.kind}{row.schedule.status === "paused" ? " · paused" : row.schedule.nextRunAt ? " · " + nextRun(row.schedule.nextRunAt, now) : ""}</span>
                  {:else}
                    <span class="date">{shortDate(row.created ?? row.lastActivityAt, now)}</span>
                  {/if}
                  <span class="chips">
                    {#each row.tags.slice(0, 2) as id (id)}{@const tag = tagMap.get(id)}{#if tag}<TagChip {tag} />{/if}{/each}
                    {#if row.tags.length > 2}<span class="more-tags">+{row.tags.length - 2}</span>{/if}
                  </span>
                  {#if row.priority > 0}<PriorityBars level={row.priority} />{/if}
                </span>
              </a>
              <button class="icon-button more" aria-label="Thread options" title="Priority, tags, rename (right click)" onclick={event => openMenu(row, event)}><Icon name="more" size={16} /></button>
            {/if}
          </div>
        {/each}
      {/each}
      {#if !groups.length}
        <div class="empty">
          {#if store.daemon === "unknown"}Loading threads
          {:else if query}No threads match.
          {:else if tab === "heartbeats"}No heartbeat threads. A thread with an active or paused heartbeat or cron job shows here.
          {:else}No threads yet.{/if}
        </div>
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

{#if menu}
  {@const id = menu.id}
  <ThreadMenu ids={[id]} at={menu.at} onclose={closeMenu} onrename={() => { const row = store.session(id); if (row) startRename(row); }} />
{/if}
{#if agentsOpen}
  <AgentsDialog onclose={() => { agentsOpen = false; }} />
{/if}

<style>
  .sidebar { position: relative; flex: none; width: 0; overflow: hidden; background: var(--bg-sunken); border-right: 1px solid transparent; transition: width 0.18s ease; }
  .sidebar.resizing { transition: none; user-select: none; }
  .resize { position: absolute; top: 0; right: 0; bottom: 0; width: 6px; cursor: col-resize; z-index: 2; }
  .resize:hover, .resize:focus-visible, .resizing .resize { background: linear-gradient(to right, transparent 4px, var(--accent) 4px); outline: none; }
  .sidebar.open { width: var(--sidebar); border-right-color: var(--border); }
  .sidebar.narrow { position: fixed; top: 0; bottom: 0; left: 0; z-index: 50; width: min(var(--sidebar), 86vw); transform: translateX(-100%); transition: transform 0.2s ease; border-right-color: var(--border); box-shadow: none; }
  .sidebar.narrow.open { transform: none; box-shadow: var(--shadow); }
  .inner { display: flex; flex-direction: column; height: 100%; width: var(--sidebar); max-width: 100%; }
  .top { display: flex; align-items: center; gap: 4px; padding: 12px 12px 6px; }
  .new { display: inline-flex; align-items: center; gap: 8px; flex: 1; height: 34px; padding: 0 12px; border-radius: var(--radius-small); background: var(--bg-elevated); border: 1px solid var(--border); font-weight: 500; }
  .new:hover { border-color: var(--border-strong); }
  .search { display: flex; align-items: center; gap: 8px; margin: 4px 12px 6px; padding: 0 10px; height: 32px; border-radius: var(--radius-small); background: var(--bg-elevated); border: 1px solid var(--border); color: var(--text-faint); }
  .search:focus-within { border-color: var(--accent); }
  .search input { flex: 1; min-width: 0; border: 0; background: none; outline: none; font-size: 14px; }
  .search input::-webkit-search-cancel-button { appearance: none; }
  .tabs { display: flex; gap: 2px; margin: 0 12px 4px; padding: 2px; border-radius: var(--radius-small); background: var(--bg-hover); }
  .tabs button { flex: 1; display: inline-flex; align-items: center; justify-content: center; gap: 5px; height: 26px; border-radius: 6px; font-size: 13px; color: var(--text-muted); }
  .tabs button.active { background: var(--bg-elevated); color: var(--text); box-shadow: 0 1px 2px var(--shadow-near); }
  .count { font-size: 11px; color: var(--text-faint); font-variant-numeric: tabular-nums; font-weight: 500; }
  .list { flex: 1; overflow-y: auto; padding: 0 8px 8px; }
  .group-label { padding: 10px 8px 3px; font-size: 11px; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; color: var(--text-faint); }
  .row { position: relative; border-radius: var(--radius-small); }
  .row:hover, .row.menu-open { background: var(--bg-hover); }
  .row.selected { background: var(--bg-active); }
  .row.archived .title { color: var(--text-muted); }
  .link { display: flex; flex-direction: column; gap: 1px; padding: 5px 8px; color: inherit; text-decoration: none; min-width: 0; }
  .line { display: flex; align-items: center; gap: 6px; min-width: 0; }
  .title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 14px; line-height: 20px; }
  .title.strong { font-weight: 600; }
  .status { display: inline-flex; align-items: center; gap: 5px; flex: none; font-size: 11px; color: var(--accent); font-variant-numeric: tabular-nums; white-space: nowrap; }
  .working { color: var(--text-muted); }
  .sub { height: 16px; font-size: 11.5px; line-height: 16px; color: var(--text-faint); }
  .date { flex: none; max-width: 60%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-variant-numeric: tabular-nums; }
  .chips { display: inline-flex; align-items: center; gap: 3px; flex: 1; min-width: 0; overflow: hidden; }
  .more-tags { flex: none; font-size: 11px; color: var(--text-faint); }
  .row:hover .status, .row.menu-open .status { visibility: hidden; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--accent); flex: none; }
  .dot.small { width: 6px; height: 6px; }
  .spinner.tiny { width: 11px; height: 11px; border-width: 1.5px; }
  .more { position: absolute; right: 4px; top: 3px; width: 26px; height: 24px; opacity: 0; }
  .row:hover .more, .row.menu-open .more, .more:focus-visible { opacity: 1; }
  .rename { margin: 2px; width: calc(100% - 4px); font-size: 14px; padding: 4px 6px; }
  .empty { padding: 24px 8px; color: var(--text-faint); font-size: 13px; text-align: center; }
  .archived-toggle { display: block; width: 100%; padding: 8px; margin-top: 8px; font-size: 12px; color: var(--text-faint); border-radius: var(--radius-small); }
  .archived-toggle:hover { background: var(--bg-hover); color: var(--text-muted); }
</style>
