<script lang="ts">
  import { api } from "./api.ts";
  import { store } from "./store.svelte.ts";
  import { labels, threadTags } from "./labels.ts";
  import { clock } from "./clock.svelte.ts";
  import { activeFilters, pulseOf, BUCKET_LABEL, createdAge, elapsed, emptyRowFilter, groupRows, matchesQuery, matchesRowFilter, matchesView, modelShort, money, needsResponse, nextRun, SIDEBAR_SORT_LABEL, SIDEBAR_VIEW_LABEL, tabOf, type SidebarSort, type SidebarView, type Tab } from "./organize.ts";
  import type { SessionRow } from "../shared/types.ts";
  import type { Anchor } from "./ui/floating.ts";
  import Icon from "./Icon.svelte";
  import PriorityBars from "./PriorityBars.svelte";
  import ProgressSteps from "./ProgressSteps.svelte";
  import TagChip from "./TagChip.svelte";
  import ThreadMenu from "./ThreadMenu.svelte";
  import FilterSelects from "./FilterSelects.svelte";
  import StatusMark from "./StatusMark.svelte";
  import Floating from "./ui/Floating.svelte";
  import TagPicker from "./ui/TagPicker.svelte";
  import { tooltip } from "./ui/tooltip.ts";
  import { ui, SIDEBAR_MAX, SIDEBAR_MIN, SIDEBAR_SNAP } from "./ui.svelte.ts";

  let { narrow }: { narrow: boolean } = $props();
  let query = $state("");
  let tab = $state<Tab>("threads");
  let showArchived = $state(false);
  let renaming = $state<{ id: string; name: string } | null>(null);
  let menu = $state<{ id: string; at: Anchor } | null>(null);
  let tagging = $state<{ id: string; anchor: HTMLElement } | null>(null);
  let filterButton: HTMLButtonElement | undefined = $state();
  let filterOpen = $state(false);
  let list: HTMLElement | undefined = $state();
  let warmTimer: ReturnType<typeof setTimeout> | null = null;

  const tagMap = $derived(new Map(store.tags.map(tag => [tag.id, tag])));
  const visible = $derived(store.sessions.filter(row => showArchived || !row.archived));
  const counts = $derived({
    threads: visible.filter(row => tabOf(row) === "threads").length,
    heartbeats: visible.filter(row => tabOf(row) === "heartbeats").length,
    heartbeatsNeeding: visible.filter(row => tabOf(row) === "heartbeats" && needsResponse(row)).length,
  });
  const archivedCount = $derived(store.sessions.filter(row => row.archived && tabOf(row) === tab).length);
  const filterCount = $derived(activeFilters(ui.sidebarFilter));
  const groups = $derived(groupRows(visible.filter(row => tabOf(row) === tab && matchesView(row, ui.sidebarView, tagMap) && matchesRowFilter(row, ui.sidebarFilter, tick) && matchesQuery(row, query.trim(), tagMap)), ui.sidebarSort));
  const SORTS: readonly SidebarSort[] = ["grouped", "recent"];
  const VIEWS: readonly { view: SidebarView; icon: "list" | "tag" }[] = [{ view: "current", icon: "list" }, { view: "tags", icon: "tag" }];
  const minute = $derived(Math.floor(clock.now / 60_000));
  /** Freshness marks move on a 5 s step of the page clock. */
  const tick = $derived(Math.floor(clock.now / 5000) * 5000);

  function warm(id: string): void {
    if (warmTimer) clearTimeout(warmTimer);
    warmTimer = setTimeout(() => store.warm(id), 150);
  }
  function cancelWarm(): void { if (warmTimer) { clearTimeout(warmTimer); warmTimer = null; } }

  function startRename(row: SessionRow): void { renaming = { id: row.id, name: row.name }; }
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
    menu = { id: row.id, at: event.type === "contextmenu" ? { x: event.clientX, y: event.clientY } : event.currentTarget as HTMLElement };
  }
  function focusRow(id: string): void {
    requestAnimationFrame(() => { if (!document.activeElement || document.activeElement === document.body) list?.querySelector<HTMLElement>(`[data-row="${CSS.escape(id)}"]`)?.focus(); });
  }
  function archive(row: SessionRow): void { void labels.archive([row.id]); }
  $effect(() => { ui.sidebarOrder = groups.flatMap(group => group.rows.map(row => row.id)); });

  function onRowKey(row: SessionRow, event: KeyboardEvent): void {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const links = list ? [...list.querySelectorAll<HTMLElement>("[data-row]")] : [];
      const index = links.indexOf(event.currentTarget as HTMLElement);
      links[event.key === "ArrowDown" ? Math.min(links.length - 1, index + 1) : Math.max(0, index - 1)]?.focus();
    } else if (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey)) {
      event.preventDefault();
      menu = { id: row.id, at: event.currentTarget as HTMLElement };
    }
  }

  function workingLabel(row: SessionRow): string {
    if (row.statusLabel) return row.statusLabel;
    const since = Date.parse(row.workingSince ?? "");
    return Number.isFinite(since) ? elapsed(Math.max(0, minute * 60_000 - since)) : "";
  }

  let aside: HTMLElement | undefined = $state();
  let resizing = $state(false);
  const edge = $derived(store.sidebarOpen ? ui.sidebarWidth : 0);
  /**
   * One pointer gesture for the edge. Past the snap point the sidebar follows the pointer (clamped to its range); below it the sidebar
   * collapses, the same state as Cmd+B, without losing the saved width. A press without a drag on a closed edge reopens it.
   */
  function startResize(event: PointerEvent): void {
    if (event.button !== 0 || !aside) return;
    event.preventDefault();
    const handle = event.currentTarget as HTMLElement;
    const left = aside.getBoundingClientRect().left;
    const startX = event.clientX;
    const wasOpen = store.sidebarOpen;
    const startWidth = ui.sidebarWidth;
    let moved = false;
    handle.setPointerCapture(event.pointerId);
    resizing = true;
    const move = (next: PointerEvent) => {
      if (!moved && Math.abs(next.clientX - startX) < 3) return;
      moved = true;
      const width = next.clientX - left;
      if (width < SIDEBAR_SNAP) { store.sidebarOpen = false; return; }
      store.sidebarOpen = true;
      ui.setSidebarWidth(width, false);
    };
    const end = () => {
      resizing = false;
      if (!moved && !wasOpen) store.sidebarOpen = true;
      ui.setSidebarWidth(moved && !store.sidebarOpen ? startWidth : ui.sidebarWidth, true);
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", end);
      handle.removeEventListener("pointercancel", end);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  }
  function resizeKey(event: KeyboardEvent): void {
    if (!store.sidebarOpen) {
      if (["Enter", " ", "ArrowRight", "End"].includes(event.key)) { event.preventDefault(); store.sidebarOpen = true; }
      return;
    }
    if (event.key === "ArrowLeft" && ui.sidebarWidth <= SIDEBAR_MIN) { event.preventDefault(); store.sidebarOpen = false; return; }
    const next = event.key === "ArrowLeft" ? ui.sidebarWidth - 16 : event.key === "ArrowRight" ? ui.sidebarWidth + 16
      : event.key === "Home" ? SIDEBAR_MIN : event.key === "End" ? SIDEBAR_MAX : null;
    if (event.key === "Enter") { event.preventDefault(); store.sidebarOpen = false; return; }
    if (next === null) return;
    event.preventDefault();
    ui.setSidebarWidth(next, true);
  }
</script>

<aside class="sidebar" class:open={store.sidebarOpen} class:narrow class:resizing aria-label="Threads" bind:this={aside}>
  <div class="inner">
    <div class="top">
      <button type="button" class="new" use:tooltip={"New chat ⌘N"} onclick={() => store.select(null)}><Icon name="plus" size={15} /><span>New chat</span></button>
      <button type="button" class="icon-button" aria-label="Agents view" use:tooltip={"Agents view ⌘K"} onclick={() => { ui.agentsOpen = true; }}><Icon name="list" /></button>
      <button type="button" class="icon-button" aria-label="Settings" use:tooltip={"Settings"} onclick={() => { store.drawer = "accounts"; }}><Icon name="settings" /></button>
      <button type="button" class="icon-button" aria-label="Hide sidebar" use:tooltip={"Hide sidebar ⌘B"} onclick={() => { store.sidebarOpen = false; }}><Icon name="sidebar" /></button>
    </div>
    <div class="find">
      <label class="search">
        <Icon name="search" size={14} />
        <input type="search" placeholder="Search threads or tags" aria-label="Search threads" bind:value={query} />
      </label>
      <div class="view" role="radiogroup" aria-label="Sidebar view">
        {#each VIEWS as entry (entry.view)}
          <button type="button" role="radio" aria-checked={ui.sidebarView === entry.view} class:on={ui.sidebarView === entry.view} aria-label={SIDEBAR_VIEW_LABEL[entry.view]}
            use:tooltip={SIDEBAR_VIEW_LABEL[entry.view]} onclick={() => ui.setSidebarView(entry.view)}><Icon name={entry.icon} size={14} /></button>
        {/each}
      </div>
      <button type="button" class="filter-button" class:on={filterCount > 0} bind:this={filterButton} aria-haspopup="dialog" aria-expanded={filterOpen}
        aria-label={filterCount ? `Filter, ${filterCount} active` : "Filter and sort"} use:tooltip={"Filter and sort"} onclick={() => { filterOpen = !filterOpen; }}>
        <Icon name="filter" size={14} />{#if filterCount}<span class="filter-count">{filterCount}</span>{/if}
      </button>
    </div>
    <div class="segmented tabs" role="tablist" aria-label="Thread kind">
      <button type="button" role="tab" aria-selected={tab === "threads"} class:on={tab === "threads"} onclick={() => { tab = "threads"; }}>Threads <span class="count">{counts.threads}</span></button>
      <button type="button" role="tab" aria-selected={tab === "heartbeats"} class:on={tab === "heartbeats"} onclick={() => { tab = "heartbeats"; }}>
        Heartbeats <span class="count">{counts.heartbeats}</span>{#if counts.heartbeatsNeeding && tab !== "heartbeats"}<span class="dot small" aria-label="{counts.heartbeatsNeeding} need a response"></span>{/if}
      </button>
    </div>
    <div class="list" bind:this={list} role="tabpanel">
      {#each groups as group, index (group.bucket)}
        {#if group.bucket && (group.bucket !== "other" || index > 0)}<div class="group-label">{BUCKET_LABEL[group.bucket]} <span class="count">{group.rows.length}</span></div>{/if}
        {#each group.rows as row (row.id)}
          <div class="row" class:selected={row.id === store.selectedId} class:archived={row.archived} class:held={menu?.id === row.id || tagging?.id === row.id}
            onmouseenter={() => warm(row.id)} onmouseleave={cancelWarm} oncontextmenu={event => openMenu(row, event)} role="presentation">
            {#if renaming?.id === row.id}
              <input class="field rename" bind:value={renaming.name} placeholder={row.name} aria-label="Thread name" use:focusAndSelect onkeydown={onRenameKey} onblur={() => void commitRename()} />
            {:else}
              {@const pulse = pulseOf(row, tick)}
              <a class="link" data-row={row.id} href={"#" + encodeURIComponent(row.id)} onkeydown={event => onRowKey(row, event)}>
                <span class="line" title={pulse && pulse.level !== "live" ? pulse.text : undefined}>
                  <span class="title" class:strong={needsResponse(row)}>{row.name}</span>
                  {#if row.status === "running"}<span class="run" role="img" aria-label={pulse?.text ? "Working, " + pulse.text : "Working"}><StatusMark status="working" level={pulse?.level ?? "live"} /></span>
                  {:else if row.failure}<span class="dot failed" role="img" aria-label="Last turn failed"></span>
                  {:else if needsResponse(row)}<span class="dot" role="img" aria-label="Needs response"></span>{/if}
                </span>
                {#if pulse?.level === "failed" || (row.status !== "running" && row.failure)}
                {@const failure = pulse?.level === "failed" ? pulse.text : row.failure}
                <span class="line sub"><span class="meta failure" title={failure}>{failure}</span></span>
                {:else}
                <span class="line sub">
                  {#if row.schedule}
                    <span class="meta date">{row.schedule.label ?? row.schedule.kind}{row.schedule.status === "paused" ? ", paused" : row.schedule.nextRunAt ? ", " + nextRun(row.schedule.nextRunAt, minute * 60_000) : ""}</span>
                  {:else if createdAge(row.created ?? row.lastActivityAt, minute * 60_000)}
                    <span class="meta date">{createdAge(row.created ?? row.lastActivityAt, minute * 60_000)}</span>
                  {/if}
                  {#if pulse && pulse.level !== "live"}<span class="meta working {pulse.level}">{pulse.text}</span>
                  {:else if row.status === "running" && workingLabel(row)}<span class="meta working">{workingLabel(row)}</span>{/if}
                  <span class="meta cost" class:unknown={row.cost === undefined}>{money(row.cost)}</span>
                  {#if row.model}<span class="meta model">{modelShort(row.model)}</span>{/if}
                  <span class="chips">
                    {#each row.tags.slice(0, 2) as id (id)}{@const tag = tagMap.get(id)}{#if tag}<TagChip {tag} />{/if}{/each}
                    {#if row.tags.length > 2}<span class="more-tags">+{row.tags.length - 2}</span>{/if}
                  </span>
                  {#if row.progress !== "none"}<ProgressSteps progress={row.progress} />{/if}
                  {#if row.priority > 0}<PriorityBars level={row.priority} />{/if}
                </span>
                {/if}
              </a>
              <div class="actions">
                  <button type="button" class="icon-button small" aria-label="Tags for {row.name}" use:tooltip={"Add tag"}
                    onclick={event => { tagging = { id: row.id, anchor: event.currentTarget as HTMLElement }; }}><Icon name="tag" /></button>
                  <span class="expand">
                    <button type="button" class="icon-button small" aria-label="Archive {row.name}" use:tooltip={"Archive"} onclick={() => archive(row)}><Icon name="archive" /></button>
                  </span>
                  <button type="button" class="icon-button small" aria-label="Options for {row.name}" aria-haspopup="menu" aria-expanded={menu?.id === row.id}
                    use:tooltip={"More"} onclick={event => openMenu(row, event)}><Icon name="more" /></button>
                
              </div>
            {/if}
          </div>
        {/each}
      {/each}
      {#if !groups.length}
        <div class="empty">
          {#if store.daemon === "unknown"}<span class="spinner tiny"></span>
          {:else if query || filterCount}<span>No threads match.{#if filterCount}{" "}<button type="button" class="link-button" onclick={() => ui.setSidebarFilter(emptyRowFilter())}>Clear filters</button>{/if}</span>
          {:else if ui.sidebarView === "tags"}No tagged threads.
          {:else if tab === "heartbeats"}No heartbeat threads.
          {:else}No threads yet.{/if}
        </div>
      {/if}
      {#if archivedCount}
        <button type="button" class="archived-toggle" onclick={() => { showArchived = !showArchived; }}>{showArchived ? "Hide archived" : `Show ${archivedCount} archived`}</button>
      {/if}
    </div>
  </div>
</aside>
{#if !narrow}
  <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
  <div class="resize" class:closed={!store.sidebarOpen} class:resizing role="separator" aria-orientation="vertical" tabindex="0"
    aria-label={store.sidebarOpen ? "Resize sidebar" : "Show sidebar"} aria-valuemin={0} aria-valuemax={SIDEBAR_MAX} aria-valuenow={edge}
    style:transform="translateX({edge}px)" onpointerdown={startResize} onkeydown={resizeKey}></div>
{/if}

{#if menu}
  {@const id = menu.id}
  <ThreadMenu ids={[id]} at={menu.at} onclose={() => { focusRow(id); menu = null; }} onrename={() => { const row = store.session(id); if (row) startRename(row); }}
    onarchive={() => { const row = store.session(id); menu = null; if (row) archive(row); }} />
{/if}
{#if tagging}
  <Floating anchor={tagging.anchor} width={260} maxHeight={360} label="Tags" onclose={() => { if (tagging) focusRow(tagging.id); tagging = null; }}>
    <TagPicker selection={threadTags([tagging.id])} />
  </Floating>
{/if}
{#if filterOpen && filterButton}
  <Floating anchor={filterButton} width={300} maxHeight={420} label="Filter and sort" onclose={() => { filterOpen = false; }}>
    <div class="panel-head">
      <span class="menu-heading">Filter</span>
      {#if filterCount}<button type="button" class="link-button" onclick={() => ui.setSidebarFilter(emptyRowFilter())}>Clear</button>{/if}
    </div>
    <div class="filter-chips"><FilterSelects filter={ui.sidebarFilter} onchange={patch => ui.setSidebarFilter({ ...ui.sidebarFilter, ...patch })} /></div>
    <div class="menu-separator"></div>
    <div class="menu-heading" id="sidebar-sort">Sort</div>
    <div role="radiogroup" aria-labelledby="sidebar-sort">
      {#each SORTS as sort (sort)}
        <button type="button" class="menu-item" role="radio" aria-checked={ui.sidebarSort === sort} onclick={() => ui.setSidebarSort(sort)}>
          <span class="check">{#if ui.sidebarSort === sort}<Icon name="check" size={13} />{/if}</span>{SIDEBAR_SORT_LABEL[sort]}
        </button>
      {/each}
    </div>
  </Floating>
{/if}

<style>
  .sidebar { position: relative; flex: none; width: 0; overflow: hidden; background: var(--bg-sunken); border-right: 1px solid transparent; transition: width 0.18s ease; }
  .sidebar.resizing { transition: none; }
  .sidebar.open { width: var(--sidebar); border-right-color: var(--border); }
  .sidebar.narrow { position: fixed; top: 0; bottom: 0; left: 0; z-index: 50; width: min(var(--sidebar), 86vw); transform: translateX(-100%); transition: transform 0.2s ease; border-right-color: var(--border); box-shadow: none; }
  .sidebar.narrow.open { transform: none; box-shadow: var(--shadow); }
  .resize { position: absolute; top: 0; bottom: 0; left: -3px; z-index: 20; width: 7px; cursor: col-resize; touch-action: none; transition: transform 0.18s ease; }
  .resize.resizing { transition: none; }
  .resize::after { content: ""; position: absolute; top: 0; bottom: 0; left: 2px; width: 2px; background: transparent; transition: background-color 0.12s 0.1s; }
  .resize:hover::after, .resize:focus-visible::after, .resize.resizing::after { background: var(--accent); }
  .resize.closed { left: 0; width: 6px; cursor: e-resize; }
  .resize.closed::after { left: 0; }
  .resize:focus-visible { outline: none; }
  :global(body:has(.resize.resizing)) { cursor: col-resize; user-select: none; }
  .inner { display: flex; flex-direction: column; height: 100%; width: var(--sidebar); max-width: 100%; }
  .top { display: flex; align-items: center; gap: 2px; padding: 10px 10px 6px; }
  .new { display: inline-flex; align-items: center; gap: 7px; flex: 1; height: 32px; margin-right: 4px; padding: 0 10px; border-radius: var(--radius-small); background: var(--bg-elevated);
    border: 1px solid var(--border-strong); font-size: 13px; font-weight: 500; box-shadow: var(--shadow-small); transition: border-color 0.12s; }
  .new:hover { border-color: var(--text-faint); }
  .find { display: flex; align-items: center; gap: 4px; margin: 2px 10px 8px; }
  .search { flex: 1; min-width: 0; display: flex; align-items: center; gap: 7px; padding: 0 8px; height: 30px; border-radius: var(--radius-small); background: var(--bg-elevated); border: 1px solid var(--border); color: var(--text-faint); }
  .search:focus-within { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
  .search input { flex: 1; min-width: 0; border: 0; background: none; outline: none; font-size: 13px; }
  .search input::-webkit-search-cancel-button { appearance: none; }
  .view { display: flex; flex: none; height: 30px; padding: 2px; gap: 2px; border: 1px solid var(--border); background: var(--bg-elevated); border-radius: var(--radius-small); }
  .view > button { display: inline-flex; align-items: center; justify-content: center; width: 24px; border-radius: 4px; color: var(--text-faint); transition: background-color 0.12s, color 0.12s; }
  .view > button:hover { color: var(--text); }
  .view > button.on { background: var(--bg-active); color: var(--text); }
  .filter-button { display: inline-flex; align-items: center; justify-content: center; gap: 4px; flex: none; min-width: 30px; height: 30px; padding: 0 7px; border-radius: var(--radius-small);
    border: 1px solid var(--border); background: var(--bg-elevated); color: var(--text-muted); transition: border-color 0.12s, color 0.12s, background-color 0.12s; }
  .filter-button:hover, .filter-button[aria-expanded="true"] { color: var(--text); border-color: var(--border-strong); }
  .filter-button.on { background: var(--accent-soft); border-color: color-mix(in srgb, var(--accent) 35%, transparent); color: var(--accent-bold); }
  .filter-count { font-size: 11.5px; font-weight: 600; font-variant-numeric: tabular-nums; line-height: 1; }
  .panel-head { display: flex; align-items: center; justify-content: space-between; padding-right: 4px; }
  .filter-chips { display: flex; flex-wrap: wrap; gap: 6px; padding: 4px 6px 8px; }
  .check { display: inline-flex; width: 14px; flex: none; color: var(--accent-bold); }
  .link-button { padding: 2px 6px; border-radius: var(--radius-small); font-size: 12px; color: var(--accent-bold); }
  .link-button:hover { background: var(--accent-soft); }
  .tabs { display: flex; margin: 0 10px 4px; }
  .tabs > button { flex: 1; }
  .count { font-size: 11px; color: var(--text-faint); font-variant-numeric: tabular-nums; font-weight: 500; }
  .tabs .on .count { color: inherit; opacity: 0.7; }
  .list { flex: 1; overflow-y: auto; padding: 0 6px 10px; }
  .group-label { padding: 12px 8px 4px; font-size: 11.5px; font-weight: 600; color: var(--text-muted); }
  .row { position: relative; border-radius: var(--radius-small); content-visibility: auto; contain-intrinsic-size: auto 44px; --row-bg: var(--bg-sunken); }
  .row:hover, .row.held { background: var(--rail-hover); --row-bg: var(--rail-hover); }
  .row.selected { background: var(--rail-active); --row-bg: var(--rail-active); }
  .row.archived .title { color: var(--text-muted); }
  .link { display: flex; flex-direction: column; gap: 1px; padding: 5px 8px; color: inherit; text-decoration: none; min-width: 0; border-radius: var(--radius-small); }
  .link:focus-visible { outline-offset: -2px; }
  .line { display: flex; align-items: center; gap: 6px; min-width: 0; }
  .title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13.5px; line-height: 20px; }
  .title.strong { font-weight: 600; }
  .sub { height: 16px; font-size: 11.5px; line-height: 16px; color: var(--text-faint); gap: 5px; }
  .meta { flex: none; white-space: nowrap; font-variant-numeric: tabular-nums; }
  .date { flex: 0 1 auto; min-width: 3ch; overflow: hidden; text-overflow: ellipsis; }
  .working { color: var(--accent-bold); }
  .working.quiet { color: var(--text-faint); }
  .working.stalled { color: var(--warning); }
  .failure { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; color: var(--danger); }
  .run { display: inline-flex; flex: none; align-items: center; justify-content: center; width: 11px; }
  .cost { color: var(--text-muted); }
  .cost.unknown { color: var(--text-faint); }
  .model { flex: 0 1 auto; min-width: 3ch; max-width: 72px; overflow: hidden; text-overflow: ellipsis; }
  .chips { display: inline-flex; align-items: center; gap: 3px; flex: 1; min-width: 0; overflow: hidden; }
  .more-tags { flex: none; font-size: 11px; color: var(--text-faint); }
  .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--accent); flex: none; }
  .dot.failed { background: var(--danger); }
  .dot.small { width: 6px; height: 6px; }
  .actions { position: absolute; right: 4px; top: 3px; display: none; align-items: center; gap: 0; padding-left: 14px; border-radius: var(--radius-small);
    background: linear-gradient(to right, transparent, var(--row-bg) 12px); }
  .row:hover .actions, .row.held .actions, .actions:focus-within { display: inline-flex; }
  .actions .icon-button.small { width: 24px; height: 22px; color: var(--text-muted); }
  .actions .icon-button.small:hover { background: var(--bg-active); color: var(--text); }
  .expand { display: inline-flex; overflow: hidden; max-width: 0; transition: max-width 0.15s ease; }
  .actions:hover .expand, .actions:focus-within .expand { max-width: 30px; }
  .rename { margin: 3px 2px; width: calc(100% - 4px); }
  .empty { display: flex; justify-content: center; padding: 24px 8px; color: var(--text-faint); font-size: 12.5px; text-align: center; }
  .archived-toggle { display: block; width: 100%; padding: 8px; margin-top: 8px; font-size: 12px; color: var(--text-faint); border-radius: var(--radius-small); }
  .archived-toggle:hover { background: var(--bg-hover); color: var(--text-muted); }
</style>
