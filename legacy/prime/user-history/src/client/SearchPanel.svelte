<script lang="ts" module>
  import { emptySearchFilters, mergeAsks, type Asks, type Merged, type SearchFilters } from "./search.ts";
  /** The last search, so the panel opens again on the same results. */
  let kept: { query: string; filters: SearchFilters; ran: string; asks: Asks; view: Merged; names: Record<string, string> } =
    { query: "", filters: emptySearchFilters(), ran: "", asks: {}, view: mergeAsks({}, "newest"), names: {} };
</script>

<script lang="ts">
  import { tick, untrack } from "svelte";
  import Modal from "./Modal.svelte";
  import Icon from "./Icon.svelte";
  import Spinner from "./Spinner.svelte";
  import Select, { type SelectOption } from "./ui/Select.svelte";
  import DateRange from "./ui/DateRange.svelte";
  import { store } from "./store.svelte.ts";
  import { machinesOf } from "./organize.ts";
  import { searchPanel } from "./search-panel.svelte.ts";
  import { appendHits, boxesToAsk, boxNotices, countLine, emptyLine, groupHits, hitTime, KIND_FILTERS, kindLabel, rememberBoxes, rememberedBoxes,
    searchingLine, searchMessages, SHOWN_PER_THREAD, snippetParts, SORT_LABEL, type Ask, type Hit, type SearchSort, type ThreadGroup } from "./search.ts";

  let query = $state(kept.query);
  let filters = $state<SearchFilters>(kept.filters);
  /** The query and filters of the shown search; Enter runs the search again when the box no longer matches it. */
  let ran = $state(kept.ran);
  /** Each box's answer to the shown search, one request per box, and the merge the list draws. */
  let asks = $state.raw<Asks>(kept.asks);
  let view = $state.raw<Merged>(kept.view);
  /** Names for a thread the Chat filter scopes to after "N more in this thread", which the chat list does not hold. */
  let names = $state<Record<string, string>>(kept.names);
  let loadingMore = $state(false);
  /** The row the keys or the pointer chose, by its key, so a box that answers late moves neither the choice nor the row on screen; null is the first row. */
  let activeKey = $state<string | null>(null);
  let input: HTMLInputElement | undefined = $state();
  let list: HTMLElement | undefined = $state();
  let asked = 0;

  type Target = { kind: "hit"; key: string; hit: Hit; group: ThreadGroup } | { kind: "more"; key: string; group: ThreadGroup };
  const groups = $derived(groupHits(view.hits));
  const targets = $derived(groups.flatMap((group): Target[] => [...group.hits.slice(0, SHOWN_PER_THREAD).map(hit => ({ kind: "hit" as const, key: hit.ref, hit, group })),
    ...(group.hits.length > SHOWN_PER_THREAD ? [{ kind: "more" as const, key: "more:" + group.key, group }] : [])]));
  const active = $derived(Math.max(0, activeKey === null ? 0 : targets.findIndex(target => target.key === activeKey)));
  const key = (text: string, set: SearchFilters): string => JSON.stringify([text.trim(), set]);
  const shownQuery = $derived(ran ? (JSON.parse(ran) as [string])[0] : "");
  const answered = $derived(Object.values(asks).some(ask => ask.state === "done"));
  const waiting = $derived(Object.values(asks).some(ask => ask.state === "loading"));
  const notices = $derived([...view.loading.map(searchingLine), ...boxNotices(view.boxes)]);
  const filtered = $derived(filters.kind !== "any" || filters.box !== "any" || filters.chat !== "any" || filters.from !== "" || filters.to !== "");

  const SORTS: readonly SearchSort[] = ["newest", "relevant"];
  const kindOptions: SelectOption[] = KIND_FILTERS.map(option => ({ ...option }));
  const boxOptions = $derived<SelectOption[]>([{ value: "any", label: "Any box" },
    ...[...new Set([...machinesOf(store.sessions), ...rememberedBoxes(), ...Object.keys(view.boxes), ...(filters.box !== "any" ? [filters.box] : [])])].sort().map(box => ({ value: box, label: box }))]);
  const chatRows = $derived(store.sessions.filter(row => row.chat && !row.archived));
  const chatOptions = $derived<SelectOption[]>([{ value: "any", label: "Any chat" },
    ...(filters.chat !== "any" && !chatRows.some(row => row.id === filters.chat) ? [{ value: filters.chat, label: names[filters.chat] ?? store.session(filters.chat)?.name ?? filters.chat }] : []),
    ...chatRows.map(row => ({ value: row.id, label: row.name }))]);

  $effect(() => { kept = { query, filters, ran, asks, view, names }; });

  /**
   * Takes one box's answer into the list. With a row chosen, the list scrolls by however far that row moved, so hits a late box adds above it
   * never push it from under the pointer or the keys.
   */
  function settle(box: string, ask: Ask): void {
    const chosen = activeKey === null ? null : list?.querySelector<HTMLElement>(`[data-key="${CSS.escape(activeKey)}"]`) ?? null;
    const before = chosen?.getBoundingClientRect().top;
    asks = { ...asks, [box]: ask };
    const sort = (JSON.parse(ran) as [string, SearchFilters])[1].sort;
    view = mergeAsks(asks, sort, view.shownTo);
    if (chosen && before !== undefined) void tick().then(() => { if (list && chosen.isConnected) list.scrollTop += chosen.getBoundingClientRect().top - before; });
    if (view.gap) void more();
  }

  function run(): void {
    const text = query.trim();
    const set = $state.snapshot(filters);
    const mine = ++asked;
    activeKey = null;
    loadingMore = false;
    if (!text) { ran = ""; asks = {}; view = mergeAsks({}, set.sort); return; }
    const boxes = boxesToAsk(set.box, [...machinesOf(store.sessions), ...rememberedBoxes()]);
    ran = key(text, set);
    asks = Object.fromEntries(boxes.map(box => [box, { state: "loading" } as const]));
    view = mergeAsks(asks, set.sort);
    list?.scrollTo({ top: 0 });
    for (const box of boxes) {
      searchMessages(text, set, box).then(result => {
        if (mine !== asked) return;
        rememberBoxes([...rememberedBoxes(), ...Object.keys(result.boxes)]);
        settle(box, { state: "done", result, hits: result.hits, ...result.nextCursor ? { next: result.nextCursor } : {} });
      }, (failure: Error) => { if (mine === asked) settle(box, { state: "failed", error: failure.message }); });
    }
  }

  /** The next page of the box the list waits on, when the list nears its end, the keys move past the last hit, or a late box left a gap. */
  async function more(): Promise<void> {
    const box = view.more;
    const ask = box === null ? undefined : asks[box];
    if (box === null || ask?.state !== "done" || !ask.next || loadingMore) return;
    const mine = asked;
    const [text, set] = JSON.parse(ran) as [string, SearchFilters];
    loadingMore = true;
    try {
      const result = await searchMessages(text, set, box, ask.next);
      if (mine !== asked) return;
      loadingMore = false;
      settle(box, { state: "done", result, hits: appendHits(ask.hits, result.hits), ...result.nextCursor ? { next: result.nextCursor } : {} });
    } catch {
      // A page that fails ends that box's list where it is, so a scroll does not ask for it again and again.
      if (mine === asked) settle(box, { state: "done", result: ask.result, hits: ask.hits });
    } finally {
      if (mine === asked) loadingMore = false;
    }
  }

  function setFilters(patch: Partial<SearchFilters>): void {
    filters = { ...filters, ...patch };
    run();
  }

  function open(hit: Hit): void {
    searchPanel.close();
    store.select(hit.session, hit.at);
  }
  /** "N more in this thread" scopes the search to that thread through the Chat filter, which takes a session id as well as a chat's. */
  function scope(group: ThreadGroup): void {
    names = { ...names, [group.session]: group.thread };
    setFilters({ chat: group.session });
    input?.focus();
  }
  function activate(target: Target | undefined): void {
    if (!target) return;
    if (target.kind === "hit") open(target.hit); else scope(target.group);
  }
  function move(to: number): void {
    if (!targets.length) return;
    const index = Math.max(0, Math.min(targets.length - 1, to));
    activeKey = targets[index]!.key;
    if (index >= targets.length - 2) void more();
    requestAnimationFrame(() => list?.querySelector(`#search-target-${index}`)?.scrollIntoView({ block: "nearest" }));
  }
  function onKey(event: KeyboardEvent): void {
    if (event.isComposing) return;
    if (event.key === "ArrowDown") { event.preventDefault(); move(active + 1); }
    else if (event.key === "ArrowUp") { event.preventDefault(); move(active - 1); }
    else if (event.key === "Enter") {
      event.preventDefault();
      if (key(query, filters) !== ran) run(); else activate(targets[active]);
    }
  }
  function onScroll(): void {
    if (list && list.scrollHeight - list.scrollTop - list.clientHeight < 240) void more();
  }

  $effect(() => {
    const seed = searchPanel.seed;
    untrack(() => {
      if (seed !== null) { query = seed; searchPanel.seed = null; run(); }
      input?.focus();
      input?.select();
    });
  });
</script>

<Modal title="Search messages" width="900px" height="82vh" tall onclose={() => searchPanel.close()}>
  {#snippet header()}
    <label class="query">
      <Icon name="search" size={14} />
      <input bind:this={input} data-search-query type="search" placeholder="Words, &quot;a phrase&quot;, in:chat from:owner kind:tool after:2026-10-20"
        aria-label="Search messages" role="combobox" aria-expanded={targets.length > 0} aria-controls="search-results"
        aria-activedescendant={targets[active] ? "search-target-" + active : undefined} autocomplete="off" spellcheck="false" bind:value={query} onkeydown={onKey} />
    </label>
  {/snippet}
  <div class="view">
    <div class="filters" role="group" aria-label="Filters">
      <div class="segmented sort" role="radiogroup" aria-label="Sort">
        {#each SORTS as sort (sort)}
          <button type="button" role="radio" aria-checked={filters.sort === sort} class:on={filters.sort === sort} onclick={() => setFilters({ sort })}>{SORT_LABEL[sort]}</button>
        {/each}
      </div>
      <Select label="Kind" options={kindOptions} value={filters.kind} resetValue="any" onchange={kind => setFilters({ kind })} />
      <Select label="Box" options={boxOptions} value={filters.box} resetValue="any" onchange={box => setFilters({ box })} />
      <Select label="Chat" options={chatOptions} value={filters.chat} resetValue="any" width={300} onchange={chat => setFilters({ chat })} />
      <DateRange label="Date" from={filters.from} to={filters.to} onchange={(from, to) => setFilters({ from, to })} />
      {#if filtered}<button type="button" class="clear" onclick={() => setFilters({ ...emptySearchFilters(), sort: filters.sort })}>Clear filters</button>{/if}
      <span class="count" aria-live="polite">{#if answered}{countLine(view)}{/if}{#if waiting}<Spinner />{/if}</span>
    </div>
    {#each notices as notice (notice)}<div class="notice">{notice}</div>{/each}
    <div class="results" id="search-results" role="listbox" aria-label="Matching messages" bind:this={list} onscroll={onScroll}>
      {#if view.error}
        <div class="empty failed">Search failed: {view.error}</div>
      {:else if answered && !waiting && !view.hits.length}
        <div class="empty">{emptyLine(shownQuery)}</div>
      {:else if !ran}
        <div class="empty">Type words and press Enter. A quoted string matches a phrase; in:, from:, kind:, box:, before:, after:, on:, -word and is:error narrow it.</div>
      {/if}
      {#each targets as target, index (target.key)}
        {#if index === 0 || targets[index - 1]!.group !== target.group}
          <div class="thread" class:first={index === 0}>
            <span class="names">
              {#if target.group.rootName}<span class="root">{target.group.rootName}</span><span class="sep"><Icon name="chevronRight" size={11} /></span>{/if}
              <span class="name">{target.group.thread}</span>
            </span>
            <span class="box">{target.group.box}</span>
            <span class="when">{hitTime(target.group.hits[0]!.at)}</span>
          </div>
        {/if}
        {#if target.kind === "hit"}
          {@const hit = target.hit}
          <button type="button" class="hit" class:active={index === active} id="search-target-{index}" role="option" aria-selected={index === active}
            data-key={target.key} data-session={hit.session} data-at={hit.at} onmousemove={() => { activeKey = target.key; }} onclick={() => open(hit)}>
            <span class="kind" class:error={hit.isError}>{kindLabel(hit)}</span>
            <span class="snippet">{#each snippetParts(hit.snippet) as part, partIndex (partIndex)}{#if part.mark}<mark>{part.text}</mark>{:else}{part.text}{/if}{/each}</span>
            <span class="time">{hitTime(hit.at).split(", ").at(-1)}</span>
          </button>
        {:else}
          <button type="button" class="more" class:active={index === active} id="search-target-{index}" role="option" aria-selected={index === active}
            data-key={target.key} onmousemove={() => { activeKey = target.key; }} onclick={() => scope(target.group)}>{target.group.hits.length - SHOWN_PER_THREAD} more in this thread</button>
        {/if}
      {/each}
      {#if loadingMore}<div class="empty"><Spinner /></div>{/if}
    </div>
    <div class="foot">Enter opens the message. Up and down move. Tab focuses filters. Esc closes.</div>
  </div>
</Modal>

<style>
  .query { flex: 1; min-width: 0; display: flex; align-items: center; gap: 7px; height: 32px; padding: 0 9px; border-radius: var(--radius-small); border: 1px solid var(--border-strong); color: var(--text-faint); background: var(--bg); }
  .query:focus-within { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
  .query input { flex: 1; min-width: 0; border: 0; background: none; outline: none; font-size: 13.5px; color: var(--text); }
  .query input::-webkit-search-cancel-button { appearance: none; }
  .view { display: flex; flex-direction: column; height: 100%; }
  .filters { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; padding: 8px 14px; border-bottom: 1px solid var(--border); }
  .sort > button { height: 26px; padding: 0 9px; font-size: 12.5px; }
  .sort { margin-right: 4px; }
  .clear { height: 28px; padding: 0 8px; border-radius: var(--radius-small); font-size: 12.5px; color: var(--accent-bold); }
  .clear:hover { background: var(--accent-soft); }
  .count { display: inline-flex; align-items: center; gap: 6px; margin-left: auto; font-size: 12px; color: var(--text-faint); font-variant-numeric: tabular-nums; white-space: nowrap; }
  .notice { padding: 6px 16px; border-bottom: 1px solid var(--border); background: var(--bg-sunken); font-size: 12.5px; color: var(--text-muted); }
  .results { flex: 1; min-height: 0; overflow-y: auto; padding: 0 8px 8px; }
  .empty { display: flex; justify-content: center; padding: 32px 16px; font-size: 13px; color: var(--text-faint); text-align: center; }
  .empty.failed { color: var(--danger); }
  .thread { display: flex; align-items: baseline; gap: 10px; margin-top: 6px; padding: 10px 8px 3px; border-top: 1px solid var(--border); font-size: 12.5px; }
  .thread.first { margin-top: 0; border-top: 0; }
  .names { display: flex; align-items: baseline; gap: 4px; flex: 1; min-width: 0; overflow: hidden; white-space: nowrap; }
  .root { flex: 0 1 auto; min-width: 3ch; overflow: hidden; text-overflow: ellipsis; color: var(--text-muted); }
  .sep { display: inline-flex; align-self: center; flex: none; color: var(--text-faint); }
  .name { flex: 0 1 auto; min-width: 3ch; overflow: hidden; text-overflow: ellipsis; font-weight: 600; color: var(--text); }
  .box, .when { flex: none; font-size: 11.5px; color: var(--text-faint); font-variant-numeric: tabular-nums; }
  .hit { display: flex; align-items: baseline; gap: 8px; width: 100%; padding: 4px 8px 4px 18px; border-radius: var(--radius-small); text-align: left; font-size: 12.5px; line-height: 18px; }
  .hit.active, .more.active { background: var(--row-hover); }
  .hit.active { box-shadow: inset 2px 0 0 var(--accent); }
  .kind { flex: none; max-width: 210px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-muted); }
  .kind.error { color: var(--danger); }
  .snippet { flex: 1; min-width: 0; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical; overflow-wrap: anywhere; color: var(--text); }
  .snippet mark { padding: 0 1px; border-radius: 2px; background: color-mix(in srgb, var(--warning, #b45309) 22%, transparent); color: inherit; font-weight: 600; }
  .time { flex: none; font-size: 11px; color: var(--text-faint); font-variant-numeric: tabular-nums; }
  .more { display: block; width: 100%; padding: 3px 8px 3px 18px; border-radius: var(--radius-small); text-align: left; font-size: 12px; color: var(--accent-bold); }
  .more:hover { text-decoration: underline; }
  .foot { flex: none; padding: 7px 16px; border-top: 1px solid var(--border); font-size: 11.5px; color: var(--text-faint); }
</style>
