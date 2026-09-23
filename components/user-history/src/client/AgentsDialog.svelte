<script lang="ts">
  import { store } from "./store.svelte.ts";
  import { labels } from "./labels.ts";
  import { shortPath, relativeTime } from "./format.ts";
  import { emptyFilter, matchesFilter, modelShort, money, needsResponse, PRIORITY_LABEL, PROGRESS_LABEL, shortDate, sortBy, statusOf, STATUS_LABEL, type AgentFilter, type RowStatus, type SortKey } from "./organize.ts";
  import { PROGRESS_STEPS, type Priority, type Progress, type SessionRow } from "../shared/types.ts";
  import type { Anchor } from "./ui/floating.ts";
  import Modal from "./Modal.svelte";
  import Icon from "./Icon.svelte";
  import PriorityBars from "./PriorityBars.svelte";
  import ProgressSteps from "./ProgressSteps.svelte";
  import TagChip from "./TagChip.svelte";
  import ThreadMenu from "./ThreadMenu.svelte";
  import Checkbox from "./ui/Checkbox.svelte";
  import Select from "./ui/Select.svelte";
  import DateRange from "./ui/DateRange.svelte";
  import Floating from "./ui/Floating.svelte";
  import TagPicker from "./ui/TagPicker.svelte";

  let { onclose }: { onclose: () => void } = $props();

  const COLUMNS: readonly { key: SortKey; label: string; firstDescending: boolean }[] = [
    { key: "status", label: "Status", firstDescending: false },
    { key: "name", label: "Title", firstDescending: false },
    { key: "tags", label: "Tags", firstDescending: false },
    { key: "priority", label: "Priority", firstDescending: true },
    { key: "progress", label: "Progress", firstDescending: true },
    { key: "cwd", label: "Workspace", firstDescending: false },
    { key: "model", label: "Model", firstDescending: false },
    { key: "cost", label: "Cost", firstDescending: true },
    { key: "created", label: "Created", firstDescending: true },
    { key: "activity", label: "Activity", firstDescending: true },
  ];
  const STATUSES: readonly RowStatus[] = ["needs", "working", "idle", "saved"];
  const LEVELS: readonly Priority[] = [0, 1, 2, 3];

  let filter = $state<AgentFilter>(emptyFilter());
  let sort = $state<{ key: SortKey; descending: boolean }>({ key: "status", descending: false });
  let selected = $state<Set<string>>(new Set());
  let active = $state(0);
  let menu = $state<{ ids: string[]; at: Anchor } | null>(null);
  let tagAnchor = $state<HTMLElement | null>(null);
  let search: HTMLInputElement | undefined = $state();
  let grid: HTMLElement | undefined = $state();
  const now = Date.now();

  const tagMap = $derived(new Map(store.tags.map(tag => [tag.id, tag])));
  const workspaces = $derived([...new Set(store.sessions.map(row => row.cwd))].sort());
  const models = $derived([...new Set(store.sessions.flatMap(row => row.model ? [row.model] : []))].sort());
  const rows = $derived(sortBy(store.sessions.filter(row => matchesFilter(row, filter, tagMap)), sort.key, sort.descending, tagMap));
  const selectedIds = $derived(rows.filter(row => selected.has(row.id)).map(row => row.id));
  const allSelected = $derived(rows.length > 0 && selectedIds.length === rows.length);
  const filtered = $derived(JSON.stringify({ ...filter, query: "", archived: false }) !== JSON.stringify(emptyFilter()));
  const archivedCount = $derived(store.sessions.filter(row => row.archived).length);
  const bulkPriority = $derived(selectedIds.length && rows.filter(row => selected.has(row.id)).every(row => row.priority === rows.find(entry => selected.has(entry.id))!.priority)
    ? rows.find(row => selected.has(row.id))!.priority : null);
  const bulkProgress = $derived(selectedIds.length && rows.filter(row => selected.has(row.id)).every(row => row.progress === rows.find(entry => selected.has(entry.id))!.progress)
    ? rows.find(row => selected.has(row.id))!.progress : null);
  const any = (label: string) => ({ value: "any", label });
  const statusOptions = [any("Any status"), ...STATUSES.map(status => ({ value: status, label: STATUS_LABEL[status] }))];
  const kindOptions = [any("Threads and heartbeats"), { value: "threads", label: "Threads" }, { value: "heartbeats", label: "Heartbeats" }];
  const tagOptions = $derived([any("Any tag"), { value: "none", label: "No tags" }, ...store.tags.map(tag => ({ value: tag.id, label: tag.name }))]);
  const priorityOptions = [any("Any priority"), ...LEVELS.map(level => ({ value: String(level), label: PRIORITY_LABEL[level] }))];
  const progressOptions = [any("Any progress"), ...PROGRESS_STEPS.map(step => ({ value: step, label: PROGRESS_LABEL[step] }))];
  const workspaceOptions = $derived([any("Any workspace"), ...workspaces.map(cwd => ({ value: cwd, label: shortPath(cwd) }))]);
  const modelOptions = $derived([any("Any model"), ...models.map(model => ({ value: model, label: modelName(model), hint: modelShort(model) }))]);

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
  function openMenu(event: MouseEvent, ids: string[]): void {
    if (!ids.length) return;
    menu = { ids, at: event.type === "contextmenu" ? { x: event.clientX, y: event.clientY } : event.currentTarget as HTMLElement };
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
    } else if (event.key === " " && rows[active]) {
      event.preventDefault(); toggle(rows[active]!.id);
    } else if (meta && event.key.toLowerCase() === "a") {
      event.preventDefault(); toggleAll();
    } else if (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey)) {
      event.preventDefault();
      const row = grid?.querySelector<HTMLElement>(`[data-index="${active}"]`);
      if (row) menu = { ids: targets(), at: row };
    }
  }
  function onSearchKey(event: KeyboardEvent): void {
    if (event.key === "ArrowDown" || (event.key === "Enter" && rows.length)) { event.preventDefault(); active = 0; grid?.focus(); scrollActive(); }
  }
  function modelName(model: string | undefined): string { return model ? model.slice(model.indexOf("/") + 1) : ""; }
  function archiveSelected(): void {
    const ids = [...selectedIds];
    selected = new Set();
    void labels.archive(ids);
  }
</script>

<Modal title="Agents" width="1240px" {onclose}>
  {#snippet header()}
    <label class="search">
      <Icon name="search" size={14} />
      <input bind:this={search} type="search" placeholder="Search title, workspace, model or tag" aria-label="Search threads" bind:value={filter.query} onkeydown={onSearchKey} />
    </label>
    <span class="total">{rows.length} of {filter.archived ? store.sessions.length : store.sessions.length - archivedCount}</span>
  {/snippet}
  <div class="view">
    <div class="filters" role="group" aria-label="Filters">
      <Select label="Status" options={statusOptions} value={filter.status} resetValue="any" onchange={value => { filter.status = value as RowStatus | "any"; }} />
      <Select label="Kind" options={kindOptions} value={filter.kind} resetValue="any" onchange={value => { filter.kind = value as AgentFilter["kind"]; }} />
      <Select label="Tag" options={tagOptions} value={filter.tag} resetValue="any" onchange={value => { filter.tag = value; }} />
      <Select label="Priority" options={priorityOptions} value={String(filter.priority)} resetValue="any" onchange={value => { filter.priority = value === "any" ? "any" : Number(value) as Priority; }} />
      <Select label="Progress" options={progressOptions} value={filter.progress} resetValue="any" onchange={value => { filter.progress = value as Progress | "any"; }} />
      <Select label="Workspace" options={workspaceOptions} value={filter.cwd} resetValue="any" width={300} onchange={value => { filter.cwd = value; }} />
      <Select label="Model" options={modelOptions} value={filter.model} resetValue="any" width={280} onchange={value => { filter.model = value; }} />
      <DateRange label="Created" from={filter.from} to={filter.to} onchange={(from, to) => { filter.from = from; filter.to = to; }} />
      <button type="button" class="toggle-chip" class:on={filter.archived} aria-pressed={filter.archived} onclick={() => { filter.archived = !filter.archived; }}>
        <Icon name="archive" size={13} />{filter.archived ? "Archived shown" : "Show archived"}<span class="n">{archivedCount}</span>
      </button>
      {#if filtered}<button type="button" class="clear" onclick={() => { filter = { ...emptyFilter(), query: filter.query, archived: filter.archived }; search?.focus(); }}>Clear filters</button>{/if}
    </div>
    {#if selectedIds.length}
      <div class="bulk fade-in" role="toolbar" aria-label="Selection">
        <span class="picked">{selectedIds.length} selected</span>
        <button type="button" class="button small" aria-haspopup="dialog" aria-expanded={tagAnchor !== null} onclick={event => { tagAnchor = event.currentTarget as HTMLElement; }}><Icon name="tag" size={13} />Tags</button>
        <div class="segmented" role="radiogroup" aria-label="Priority">
          {#each LEVELS as level (level)}
            <button type="button" role="radio" aria-checked={bulkPriority === level} aria-label={PRIORITY_LABEL[level]} class:on={bulkPriority === level} onclick={() => void labels.setPriority(selectedIds, level)}>
              {#if level === 0}None{:else}<PriorityBars {level} size={12} />{/if}
            </button>
          {/each}
        </div>
        <div class="segmented" role="radiogroup" aria-label="Progress">
          {#each PROGRESS_STEPS as step (step)}
            <button type="button" role="radio" aria-checked={bulkProgress === step} class:on={bulkProgress === step} onclick={() => void labels.setProgress(selectedIds, step)}>{step === "none" ? "None" : PROGRESS_LABEL[step]}</button>
          {/each}
        </div>
        <button type="button" class="button small" onclick={archiveSelected}><Icon name="archive" size={13} />Archive</button>
        <button type="button" class="clear" onclick={() => { selected = new Set(); }}>Clear selection</button>
      </div>
    {/if}
    <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
    <div class="grid" role="grid" tabindex="0" aria-label="Threads" aria-multiselectable="true" aria-rowcount={rows.length}
      aria-activedescendant={rows[active] ? "agent-row-" + active : undefined} bind:this={grid} onkeydown={onGridKey}>
      <table>
        <thead>
          <tr>
            <th class="pick"><Checkbox checked={allSelected} indeterminate={selectedIds.length > 0 && !allSelected} label="Select all" tabindex={-1} onchange={toggleAll} /></th>
            {#each COLUMNS as column (column.key)}
              <th class={column.key} aria-sort={sort.key === column.key ? (sort.descending ? "descending" : "ascending") : "none"}>
                <button type="button" tabindex="-1" onclick={() => toggleSort(column.key, column.firstDescending)}>
                  {column.label}{#if sort.key === column.key}<span class="arrow"><Icon name={sort.descending ? "chevronDown" : "chevronUp"} size={11} /></span>{/if}
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
              <td class="pick"><Checkbox checked={selected.has(row.id)} label="Select {row.name}" tabindex={-1} onchange={() => toggle(row.id)} /></td>
              <td class="status">
                <span class="state {status}">
                  {#if status === "working"}<span class="spinner tiny"></span>{:else if status === "needs"}<span class="dot"></span>{:else}<span class="ring"></span>{/if}
                  {row.status === "running" && row.statusLabel ? row.statusLabel : STATUS_LABEL[status]}
                </span>
              </td>
              <td class="name">
                <button type="button" tabindex="-1" class="open" class:strong={needsResponse(row)} onclick={event => { event.stopPropagation(); open(row); }}>{row.name}</button>
                {#if row.schedule}<span class="kind">{row.schedule.label ?? row.schedule.kind}</span>{/if}
                {#if row.archived}<span class="kind">archived</span>{/if}
              </td>
              <td class="tags">{#each row.tags as id (id)}{@const tag = tagMap.get(id)}{#if tag}<TagChip {tag} />{/if}{/each}</td>
              <td class="priority">{#if row.priority > 0}<PriorityBars level={row.priority} />{/if}</td>
              <td class="progress">{#if row.progress !== "none"}<span class="progress-cell"><ProgressSteps progress={row.progress} />{PROGRESS_LABEL[row.progress]}</span>{/if}</td>
              <td class="cwd">{shortPath(row.cwd)}</td>
              <td class="model">{modelShort(row.model)}</td>
              <td class="cost" class:unknown={row.cost === undefined}>{money(row.cost)}</td>
              <td class="created">{shortDate(row.created, now)}</td>
              <td class="activity">{relativeTime(row.lastActivityAt ?? row.created, now)}</td>
            </tr>
          {/each}
        </tbody>
      </table>
      {#if !rows.length}<div class="empty">No threads match these filters.</div>{/if}
    </div>
  </div>
  {#if menu}
    <ThreadMenu ids={menu.ids} at={menu.at} onclose={closeMenu} />
  {/if}
  {#if tagAnchor}
    <Floating anchor={tagAnchor} width={260} maxHeight={360} label="Tags for {selectedIds.length} threads" onclose={() => { tagAnchor = null; }}><TagPicker ids={selectedIds} /></Floating>
  {/if}
</Modal>

<style>
  .search { flex: 1; display: flex; align-items: center; gap: 7px; max-width: 460px; height: 30px; padding: 0 9px; border-radius: var(--radius-small); border: 1px solid var(--border-strong); color: var(--text-faint); background: var(--bg); }
  .search:focus-within { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
  .search input { flex: 1; min-width: 0; border: 0; background: none; outline: none; font-size: 13px; color: var(--text); }
  .total { font-size: 12px; color: var(--text-faint); font-variant-numeric: tabular-nums; white-space: nowrap; }
  .view { display: flex; flex-direction: column; height: min(74vh, 780px); }
  .filters { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding: 10px 14px; border-bottom: 1px solid var(--border); }
  .toggle-chip { display: inline-flex; align-items: center; gap: 5px; height: 28px; padding: 0 9px; border-radius: var(--radius-small); border: 1px dashed var(--border-strong); font-size: 12.5px; color: var(--text-muted); }
  .toggle-chip:hover { color: var(--text); }
  .toggle-chip.on { border-style: solid; border-color: color-mix(in srgb, var(--accent) 35%, transparent); background: var(--accent-soft); color: var(--accent-bold); }
  .n { font-size: 11px; font-variant-numeric: tabular-nums; opacity: 0.7; }
  .clear { height: 28px; padding: 0 8px; border-radius: var(--radius-small); font-size: 12.5px; color: var(--accent-bold); }
  .clear:hover { background: var(--accent-soft); }
  .bulk { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 7px 14px; border-bottom: 1px solid var(--border); background: var(--row-selected); font-size: 12.5px; }
  .picked { font-weight: 600; margin-right: 4px; font-variant-numeric: tabular-nums; }
  .bulk .segmented { background: var(--bg-elevated); }
  .grid { flex: 1; min-height: 0; overflow: auto; outline: none; }
  .grid:focus-visible tr.active td:first-child { box-shadow: inset 2px 0 0 var(--accent); }
  table { width: 100%; border-collapse: collapse; font-size: 12.5px; table-layout: fixed; }
  thead th { position: sticky; top: 0; z-index: 1; background: var(--bg-elevated); border-bottom: 1px solid var(--border); text-align: left; font-weight: 500; color: var(--text-muted); font-size: 12px; padding: 0; }
  th button { display: inline-flex; align-items: center; gap: 3px; width: 100%; text-align: left; padding: 7px 8px; color: inherit; }
  th button:hover { color: var(--text); }
  .arrow { display: inline-flex; color: var(--accent-bold); }
  td { padding: 4px 8px; height: 34px; border-bottom: 1px solid var(--border); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; vertical-align: middle; }
  tbody tr:hover td { background: var(--row-hover); }
  tr.active td { background: var(--row-hover); }
  tr.picked td { background: var(--row-selected); }
  .pick { width: 40px; padding-left: 12px; }
  th.status, td.status { width: 132px; }
  th.tags, td.tags { width: 160px; }
  th.priority, td.priority { width: 70px; }
  th.progress, td.progress { width: 128px; }
  th.cwd, td.cwd { width: 150px; }
  th.model, td.model { width: 96px; }
  th.cost, td.cost { width: 70px; text-align: right; }
  th.cost button { justify-content: flex-end; }
  th.created, td.created { width: 76px; }
  th.activity, td.activity { width: 70px; }
  td.tags :global(.tag) { margin-right: 3px; }
  td.cwd, td.model, td.created, td.activity, td.cost { color: var(--text-muted); font-variant-numeric: tabular-nums; }
  td.cwd { font-family: var(--mono); font-size: 11.5px; }
  td.cost.unknown { color: var(--text-faint); }
  .progress-cell { display: inline-flex; align-items: center; gap: 6px; color: var(--text-muted); }
  .state { display: inline-flex; align-items: center; gap: 6px; color: var(--text-muted); }
  .state.needs { color: var(--accent-bold); font-weight: 500; }
  .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--accent); }
  .ring { width: 7px; height: 7px; border-radius: 50%; border: 1.5px solid var(--border-strong); }
  .state.saved .ring { border-style: dashed; }
  .name { display: flex; align-items: center; gap: 6px; }
  .open { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: left; color: var(--text); font-size: 13px; }
  .open:hover { text-decoration: underline; text-decoration-color: var(--border-strong); }
  .open.strong { font-weight: 600; }
  .kind { flex: none; font-size: 11px; padding: 0 6px; border-radius: 4px; background: var(--bg-sunken); color: var(--text-muted); }
  .empty { padding: 40px; text-align: center; color: var(--text-faint); font-size: 13px; }
</style>
