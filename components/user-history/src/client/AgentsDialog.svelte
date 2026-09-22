<script lang="ts">
  import { store } from "./store.svelte.ts";
  import { labels } from "./labels.ts";
  import { shortPath, relativeTime } from "./format.ts";
  import { emptyFilter, matchesFilter, needsResponse, PRIORITY_LABEL, shortDate, sortBy, statusOf, STATUS_LABEL, type AgentFilter, type RowStatus, type SortKey } from "./organize.ts";
  import type { Priority, SessionRow } from "../shared/types.ts";
  import Modal from "./Modal.svelte";
  import Icon from "./Icon.svelte";
  import PriorityBars from "./PriorityBars.svelte";
  import TagChip from "./TagChip.svelte";
  import ThreadMenu from "./ThreadMenu.svelte";

  let { onclose }: { onclose: () => void } = $props();

  const COLUMNS: readonly { key: SortKey; label: string; firstDescending: boolean }[] = [
    { key: "status", label: "Status", firstDescending: false },
    { key: "name", label: "Title", firstDescending: false },
    { key: "tags", label: "Tags", firstDescending: false },
    { key: "priority", label: "Priority", firstDescending: true },
    { key: "cwd", label: "Workspace", firstDescending: false },
    { key: "model", label: "Model", firstDescending: false },
    { key: "created", label: "Created", firstDescending: true },
    { key: "activity", label: "Activity", firstDescending: true },
  ];
  const STATUSES: readonly RowStatus[] = ["needs", "working", "idle", "saved"];
  const LEVELS: readonly Priority[] = [0, 1, 2, 3];

  let filter = $state<AgentFilter>(emptyFilter());
  let sort = $state<{ key: SortKey; descending: boolean }>({ key: "status", descending: false });
  let selected = $state<Set<string>>(new Set());
  let active = $state(0);
  let menu = $state<{ ids: string[]; at: { x: number; y: number } } | null>(null);
  let search: HTMLInputElement | undefined = $state();
  let grid: HTMLElement | undefined = $state();
  const now = Date.now();

  const tagMap = $derived(new Map(store.tags.map(tag => [tag.id, tag])));
  const workspaces = $derived([...new Set(store.sessions.map(row => row.cwd))].sort());
  const models = $derived([...new Set(store.sessions.flatMap(row => row.model ? [row.model] : []))].sort());
  const rows = $derived(sortBy(store.sessions.filter(row => matchesFilter(row, filter, tagMap)), sort.key, sort.descending, tagMap));
  const selectedIds = $derived(rows.filter(row => selected.has(row.id)).map(row => row.id));
  const allSelected = $derived(rows.length > 0 && selectedIds.length === rows.length);
  const filtered = $derived(JSON.stringify(filter) !== JSON.stringify(emptyFilter()));

  $effect(() => { search?.focus(); });
  $effect(() => { if (active >= rows.length) active = Math.max(0, rows.length - 1); });

  function toggleSort(key: SortKey, firstDescending: boolean): void {
    sort = sort.key === key ? { key, descending: !sort.descending } : { key, descending: firstDescending };
  }
  function toggle(id: string): void {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id); else next.add(id);
    selected = next;
  }
  function toggleAll(): void { selected = allSelected ? new Set() : new Set(rows.map(row => row.id)); }
  function open(row: SessionRow): void { store.select(row.id); onclose(); }
  function targets(): string[] { return selectedIds.length ? selectedIds : rows[active] ? [rows[active]!.id] : []; }
  function openMenu(event: MouseEvent | KeyboardEvent, ids: string[]): void {
    if (!ids.length) return;
    const box = (event.currentTarget as HTMLElement).getBoundingClientRect();
    menu = { ids, at: event instanceof MouseEvent && event.type === "contextmenu" ? { x: event.clientX, y: event.clientY } : { x: box.left, y: box.bottom + 4 } };
  }
  function closeMenu(): void { menu = null; requestAnimationFrame(() => grid?.focus()); }
  function scrollActive(): void {
    requestAnimationFrame(() => grid?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" }));
  }

  function onGridKey(event: KeyboardEvent): void {
    const meta = event.metaKey || event.ctrlKey;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (event.key === "ArrowUp" && active === 0) { search?.focus(); return; }
      active = Math.max(0, Math.min(rows.length - 1, active + (event.key === "ArrowDown" ? 1 : -1)));
      if (event.shiftKey && rows[active]) selected = new Set([...selected, rows[active]!.id]);
      scrollActive();
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault(); active = event.key === "Home" ? 0 : rows.length - 1; scrollActive();
    } else if (event.key === "Enter" && rows[active]) {
      event.preventDefault(); open(rows[active]!);
    } else if ((event.key === " " || event.key === "x") && rows[active]) {
      event.preventDefault(); toggle(rows[active]!.id);
    } else if (meta && event.key.toLowerCase() === "a") {
      event.preventDefault(); toggleAll();
    } else if (!meta && !event.altKey && /^[0-3]$/.test(event.key)) {
      event.preventDefault(); void labels.setPriority(targets(), Number(event.key) as Priority);
    } else if (!meta && (event.key === "t" || event.key === "l")) {
      event.preventDefault();
      const row = grid?.querySelector<HTMLElement>(`[data-index="${active}"]`);
      if (row) { const box = row.getBoundingClientRect(); menu = { ids: targets(), at: { x: box.left + 40, y: box.bottom } }; }
    } else if (event.key === "/") {
      event.preventDefault(); search?.focus();
    }
  }
  function onSearchKey(event: KeyboardEvent): void {
    if (event.key === "ArrowDown" || (event.key === "Enter" && rows.length)) { event.preventDefault(); active = 0; grid?.focus(); scrollActive(); }
  }
  function modelName(model: string | undefined): string { return model ? model.slice(model.indexOf("/") + 1) : ""; }
</script>

<Modal title="Agents" width="1180px" {onclose}>
  {#snippet header()}
    <label class="search">
      <Icon name="search" size={15} />
      <input bind:this={search} type="search" placeholder="Search title, workspace, model or tag" aria-label="Search threads" bind:value={filter.query} onkeydown={onSearchKey} />
    </label>
    <span class="total">{rows.length} of {store.sessions.length}</span>
  {/snippet}
  <div class="view">
    <div class="filters" role="group" aria-label="Filters">
      <select bind:value={filter.status} aria-label="Status" class:set={filter.status !== "any"}>
        <option value="any">Any status</option>
        {#each STATUSES as status (status)}<option value={status}>{STATUS_LABEL[status]}</option>{/each}
      </select>
      <select bind:value={filter.kind} aria-label="Kind" class:set={filter.kind !== "any"}>
        <option value="any">Threads and heartbeats</option>
        <option value="threads">Threads only</option>
        <option value="heartbeats">Heartbeats only</option>
      </select>
      <select bind:value={filter.tag} aria-label="Tag" class:set={filter.tag !== "any"}>
        <option value="any">Any tag</option>
        <option value="none">No tags</option>
        {#each store.tags as tag (tag.id)}<option value={tag.id}>{tag.name}</option>{/each}
      </select>
      <select bind:value={filter.priority} aria-label="Priority" class:set={filter.priority !== "any"}>
        <option value="any">Any priority</option>
        {#each LEVELS as level (level)}<option value={level}>{PRIORITY_LABEL[level]}</option>{/each}
      </select>
      <select bind:value={filter.cwd} aria-label="Workspace" class:set={filter.cwd !== "any"}>
        <option value="any">Any workspace</option>
        {#each workspaces as cwd (cwd)}<option value={cwd}>{shortPath(cwd)}</option>{/each}
      </select>
      <select bind:value={filter.model} aria-label="Model" class:set={filter.model !== "any"}>
        <option value="any">Any model</option>
        {#each models as model (model)}<option value={model}>{modelName(model)}</option>{/each}
      </select>
      <label class="date">Created <input type="date" bind:value={filter.from} aria-label="Created from" max={filter.to || undefined} /></label>
      <label class="date">to <input type="date" bind:value={filter.to} aria-label="Created to" min={filter.from || undefined} /></label>
      <label class="check"><input type="checkbox" bind:checked={filter.archived} /> Archived</label>
      {#if filtered}<button class="button small" onclick={() => { filter = emptyFilter(); search?.focus(); }}>Clear</button>{/if}
    </div>
    {#if selectedIds.length}
      <div class="bulk" role="toolbar" aria-label="Selection">
        <span>{selectedIds.length} selected</span>
        <button class="button small" onclick={event => openMenu(event, selectedIds)}>Tags and priority</button>
        <button class="button small" onclick={() => { selected = new Set(); }}>Clear selection</button>
      </div>
    {/if}
    <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
    <div class="grid" role="grid" tabindex="0" aria-label="Threads" aria-multiselectable="true" aria-rowcount={rows.length}
      aria-activedescendant={rows[active] ? "agent-row-" + active : undefined} bind:this={grid} onkeydown={onGridKey}>
      <table>
        <thead>
          <tr>
            <th class="pick"><input type="checkbox" checked={allSelected} indeterminate={selectedIds.length > 0 && !allSelected} aria-label="Select all" onchange={toggleAll} tabindex="-1" /></th>
            {#each COLUMNS as column (column.key)}
              <th class={column.key} aria-sort={sort.key === column.key ? (sort.descending ? "descending" : "ascending") : "none"}>
                <button tabindex="-1" onclick={() => toggleSort(column.key, column.firstDescending)}>
                  {column.label}{#if sort.key === column.key}<span class="arrow">{sort.descending ? "↓" : "↑"}</span>{/if}
                </button>
              </th>
            {/each}
          </tr>
        </thead>
        <tbody>
          {#each rows as row, index (row.id)}
            {@const status = statusOf(row)}
            <tr id={"agent-row-" + index} data-index={index} class:active={index === active} class:picked={selected.has(row.id)} aria-selected={selected.has(row.id)}
              onclick={() => { active = index; }} ondblclick={() => open(row)} oncontextmenu={event => { event.preventDefault(); active = index; openMenu(event, selected.has(row.id) ? selectedIds : [row.id]); }}>
              <td class="pick"><input type="checkbox" checked={selected.has(row.id)} aria-label="Select {row.name}" tabindex="-1" onchange={() => toggle(row.id)} onclick={event => event.stopPropagation()} /></td>
              <td class="status">
                <span class="state {status}" title={row.status === "running" && row.statusLabel ? row.statusLabel : STATUS_LABEL[status]}>
                  {#if status === "working"}<span class="spinner tiny"></span>{:else if status === "needs"}<span class="dot"></span>{:else}<span class="ring"></span>{/if}
                  {STATUS_LABEL[status]}
                </span>
              </td>
              <td class="name">
                <button tabindex="-1" class="open" class:strong={needsResponse(row)} title={row.name} onclick={event => { event.stopPropagation(); open(row); }}>{row.name}</button>
                {#if row.schedule}<span class="kind" title={row.schedule.expression}>{row.schedule.label ?? row.schedule.kind}</span>{/if}
                {#if row.archived}<span class="kind">archived</span>{/if}
              </td>
              <td class="tags">{#each row.tags as id (id)}{@const tag = tagMap.get(id)}{#if tag}<TagChip {tag} />{/if}{/each}</td>
              <td class="priority">{#if row.priority > 0}<PriorityBars level={row.priority} />{/if}</td>
              <td class="cwd" title={row.cwd}>{shortPath(row.cwd)}</td>
              <td class="model" title={row.model ?? ""}>{modelName(row.model)}</td>
              <td class="created">{shortDate(row.created, now)}</td>
              <td class="activity">{relativeTime(row.lastActivityAt ?? row.created, now)}</td>
            </tr>
          {/each}
        </tbody>
      </table>
      {#if !rows.length}<div class="empty">No threads match these filters.</div>{/if}
    </div>
    <div class="keys">Up and Down move. Enter opens. Space selects. 0 to 3 set priority. T edits tags. Right click for the menu.</div>
  </div>
  {#if menu}
    <ThreadMenu ids={menu.ids} at={menu.at} onclose={closeMenu} />
  {/if}
</Modal>

<style>
  .search { flex: 1; display: flex; align-items: center; gap: 8px; max-width: 460px; height: 30px; padding: 0 10px; border-radius: var(--radius-small); border: 1px solid var(--border); color: var(--text-faint); }
  .search:focus-within { border-color: var(--accent); }
  .search input { flex: 1; min-width: 0; border: 0; background: none; outline: none; font-size: 14px; color: var(--text); }
  .total { font-size: 12px; color: var(--text-faint); font-variant-numeric: tabular-nums; white-space: nowrap; }
  .view { display: flex; flex-direction: column; height: min(72vh, 760px); }
  .filters { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding: 10px 14px; border-bottom: 1px solid var(--border); }
  .filters select, .filters input[type="date"] { height: 28px; padding: 0 6px; border-radius: var(--radius-small); border: 1px solid var(--border); background: var(--bg-elevated); font-size: 13px; color: var(--text-muted); }
  .filters select.set { border-color: var(--accent); color: var(--text); background: var(--accent-soft); }
  .date, .check { display: inline-flex; align-items: center; gap: 5px; font-size: 13px; color: var(--text-muted); }
  .bulk { display: flex; align-items: center; gap: 8px; padding: 6px 14px; border-bottom: 1px solid var(--border); background: var(--accent-soft); font-size: 13px; }
  .grid { flex: 1; min-height: 0; overflow: auto; outline: none; }
  .grid:focus-visible tr.active { box-shadow: inset 2px 0 0 var(--accent); }
  table { width: 100%; border-collapse: collapse; font-size: 13px; table-layout: fixed; }
  thead th { position: sticky; top: 0; z-index: 1; background: var(--bg-elevated); border-bottom: 1px solid var(--border); text-align: left; font-weight: 500; color: var(--text-faint); font-size: 12px; padding: 0; }
  th button { width: 100%; text-align: left; padding: 7px 8px; color: inherit; }
  th button:hover { color: var(--text); }
  .arrow { margin-left: 4px; color: var(--accent); }
  td { padding: 5px 8px; border-bottom: 1px solid var(--border); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; vertical-align: middle; }
  tr.active td { background: var(--bg-hover); }
  tr.picked td { background: var(--accent-soft); }
  .pick { width: 34px; padding-left: 14px; }
  th.status, td.status { width: 132px; }
  th.tags, td.tags { width: 170px; }
  th.priority, td.priority { width: 72px; }
  th.cwd, td.cwd { width: 150px; }
  th.model, td.model { width: 130px; }
  th.created, td.created { width: 84px; }
  th.activity, td.activity { width: 76px; }
  td.tags { display: table-cell; }
  td.tags :global(.tag) { margin-right: 3px; }
  td.cwd, td.model, td.created, td.activity { color: var(--text-muted); font-variant-numeric: tabular-nums; }
  .state { display: inline-flex; align-items: center; gap: 6px; color: var(--text-muted); }
  .state.needs { color: var(--accent); font-weight: 500; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--accent); }
  .ring { width: 8px; height: 8px; border-radius: 50%; border: 1.5px solid var(--border-strong); }
  .state.saved .ring { border-style: dashed; }
  .spinner.tiny { width: 11px; height: 11px; border-width: 1.5px; }
  .name { display: flex; align-items: center; gap: 6px; }
  .open { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: left; color: var(--text); }
  .open:hover { text-decoration: underline; text-decoration-color: var(--border-strong); }
  .open.strong { font-weight: 600; }
  .kind { flex: none; font-size: 11px; padding: 0 6px; border-radius: 999px; border: 1px solid var(--border); color: var(--text-faint); }
  .empty { padding: 40px; text-align: center; color: var(--text-faint); font-size: 13px; }
  .keys { padding: 6px 14px; border-top: 1px solid var(--border); font-size: 11.5px; color: var(--text-faint); }
</style>
