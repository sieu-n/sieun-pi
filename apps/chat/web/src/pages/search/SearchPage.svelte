<script lang="ts">
  import { tick, untrack } from "svelte";
  import { SvelteMap, SvelteSet } from "svelte/reactivity";
  import { agents, api, conversations, type SearchHit, type SearchMissing } from "$lib/api";
  import { conversationHref, hrefFor, router } from "$lib/router.svelte";
  import Avatar from "$lib/ui/Avatar.svelte";
  import CardGroup from "$lib/ui/CardGroup.svelte";
  import EmptyState from "$lib/ui/EmptyState.svelte";
  import NavItem from "$lib/ui/NavItem.svelte";
  import Tabs from "$lib/ui/Tabs.svelte";
  import { search as searchDialog } from "$lib/shell/search.svelte";
  import Button from "$lib/ui/Button.svelte";
  import Icon from "$lib/ui/Icon.svelte";
  import LoadingText from "$lib/ui/LoadingText.svelte";
  import Menu from "$lib/ui/Menu.svelte";
  import Page from "$lib/ui/Page.svelte";
  import SearchField from "$lib/ui/SearchField.svelte";
  import { contextOf, replyContextOf, type HitContext } from "./context";
  import { entryId, keepPlace, placeOf, type Place } from "./back-place";
  import FilterBar from "./FilterBar.svelte";
  import { hasFilters, NO_FILTERS } from "./filters";
  import { recentSearches } from "./recent-searches.svelte";
  import ResultCard from "./ResultCard.svelte";
  import { readResults, resultCount, resultParams, searchable, searchParams, type Results, type ResultTab } from "./results-model";
  import { channelMatches, NO_HITS, peopleMatches, widenRows, type Person } from "./search-model";
  import { composing } from "$lib/ui/keyboard";

  const PAGE = 20;

  const results = $derived(readResults(router.route.params));
  const key = $derived(JSON.stringify(searchParams(results)));

  type State = { state: "idle" } | { state: "loading" } | { state: "error"; message: string } | { state: "ready" };
  let status = $state<State>({ state: "idle" });
  let hits = $state<SearchHit[]>([]);
  let total = $state(0);
  let missing = $state<SearchMissing[]>([]);
  let cursor = $state<string | undefined>();
  let loadingMore = $state(false);
  let focusedIndex = $state(0);
  let now = $state(new Date());
  let draft = $state("");
  const expanded = new SvelteSet<string>();
  const contexts = new SvelteMap<string, HitContext | "loading" | "error">();

  let generation = 0;
  let attempt = $state(0);
  $effect(() => {
    void key;
    void attempt;
    const params = searchParams(results);
    const mine = ++generation;
    const searched = key;
    const entry = entryId();
    // Back or Forward to an entry shows what it showed; Retry reads anew.
    const place = attempt === placedAttempt ? placeOf(entry, searched) : undefined;
    placedAttempt = attempt;
    untrack(() => {
      draft = params.q;
      hits = place?.hits ?? [];
      total = place?.total ?? 0;
      missing = place?.missing ?? [];
      cursor = place?.cursor;
      focusedIndex = place?.focusedIndex ?? 0;
      expanded.clear();
      for (const id of place?.expanded ?? []) expanded.add(id);
      for (const [id, lines] of place?.contexts ?? []) contexts.set(id, lines);
      now = new Date();
      status = place ? { state: "ready" } : searchable(results) ? { state: "loading" } : { state: "idle" };
      if (params.q) recentSearches.add({ q: params.q, filters: results.filters });
    });
    const keep = () => {
      if (status.state === "ready") keepPlace(entry, placeNow(searched));
    };
    if (place) {
      void tick().then(() => showPlace(place));
      return keep;
    }
    if (!searchable(results)) return;
    const controller = new AbortController();
    api.search({ ...params, limit: PAGE }, { signal: controller.signal }).then(
      result => {
        if (mine !== generation) return;
        hits = result.hits;
        total = result.total;
        missing = result.missing ?? [];
        cursor = result.nextCursor;
        status = { state: "ready" };
      },
      error => {
        if (mine === generation && !controller.signal.aborted) status = { state: "error", message: error instanceof Error ? error.message : String(error) };
      },
    );
    return () => {
      keep();
      controller.abort();
    };
  });

  let placedAttempt = 0;
  /** The results scroll, read as he scrolls, since the page is gone by the time a Back from a result could read it. */
  let scrollTop = 0;
  const scroller = (): HTMLElement | null | undefined => list?.closest<HTMLElement>(".scroll");
  $effect(() => {
    const element = scroller();
    if (!element) return;
    const onscroll = () => (scrollTop = element.scrollTop);
    element.addEventListener("scroll", onscroll, { passive: true });
    return () => element.removeEventListener("scroll", onscroll);
  });

  function placeNow(searched: string): Place {
    const settled = [...contexts].filter((entry): entry is [string, HitContext | "error"] => entry[1] !== "loading");
    return { key: searched, hits, total, missing, cursor, focusedIndex, scrollTop, expanded: [...expanded], contexts: settled };
  }

  /** Puts the scroll and the picked card back, with the keyboard on that card. */
  function showPlace(place: Place) {
    const element = scroller();
    if (element) element.scrollTop = place.scrollTop;
    list?.querySelectorAll<HTMLElement>("[data-result-card]")[place.focusedIndex]?.querySelector<HTMLElement>("[data-result-open]")?.focus({ preventScroll: true });
  }

  async function loadMore() {
    if (!cursor || loadingMore || status.state !== "ready") return;
    const mine = generation;
    loadingMore = true;
    try {
      const result = await api.search({ ...searchParams(results), limit: PAGE, cursor });
      if (mine !== generation) return;
      const seen = new Set(hits.map(hit => hit.id));
      hits = [...hits, ...result.hits.filter(hit => !seen.has(hit.id))];
      total = result.total;
      missing = result.missing ?? [];
      cursor = result.nextCursor;
    } catch (error) {
      if (mine === generation) status = { state: "error", message: error instanceof Error ? error.message : String(error) };
    } finally {
      if (mine === generation) loadingMore = false;
    }
  }

  /** The messages before and after a hit, read once from its conversation's page around it. */
  async function loadContext(hit: SearchHit) {
    if (contexts.has(hit.id)) return;
    contexts.set(hit.id, "loading");
    try {
      if (hit.thread) contexts.set(hit.id, replyContextOf(await api.replies(hit.conversation.id, hit.thread.root), hit));
      else contexts.set(hit.id, contextOf(await api.items(hit.conversation.id, { around: hit.messageId, limit: 6 }), hit));
    } catch {
      contexts.set(hit.id, "error");
    }
  }

  const focused = $derived(hits[focusedIndex]);
  $effect(() => {
    if (focused) void loadContext(focused);
  });

  function toggle(hit: SearchHit) {
    if (expanded.has(hit.id)) expanded.delete(hit.id);
    else {
      expanded.add(hit.id);
      void loadContext(hit);
    }
  }

  function go(patch: Partial<Results>) {
    router.navigate(hrefFor("search", [], resultParams({ ...results, ...patch })));
  }

  function submit(e: KeyboardEvent) {
    if (e.key !== "Enter" || composing(e)) return;
    e.preventDefault();
    go({ q: draft.trim() });
  }

  // Filters: the same chip bar as the Cmd K search, writing to the address.

  const anyFilter = $derived(hasFilters(results.filters));
  let sortAnchor = $state<HTMLButtonElement>();
  let sortOpen = $state(false);
  const sortItems = $derived([
    { type: "radio" as const, id: "relevance", group: "sort", label: "Most relevant", detail: "Default", checked: results.sort === "relevance", onselect: () => go({ sort: "relevance" }) },
    { type: "radio" as const, id: "recent", group: "sort", label: "Most recent", checked: results.sort === "recent", onselect: () => go({ sort: "recent" }) },
  ]);

  // Infinite scroll: the sentinel under the list loads the next page as it comes into view.
  let sentinel = $state<HTMLDivElement>();
  $effect(() => {
    if (!sentinel || !cursor) return;
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) void loadMore();
    }, { rootMargin: "400px 0px" });
    observer.observe(sentinel);
    return () => observer.disconnect();
  });

  let list = $state<HTMLElement>();
  function focusCard(index: number) {
    focusedIndex = Math.max(0, Math.min(hits.length - 1, index));
    const card = list?.querySelectorAll<HTMLElement>("[data-result-card]")[focusedIndex];
    card?.scrollIntoView({ block: "nearest" });
    card?.querySelector<HTMLElement>("[data-result-open]")?.focus({ preventScroll: true });
    if (focusedIndex >= hits.length - 3) void loadMore();
  }

  // Tabs: the messages, then the channels and the agents whose name matches what is typed, as Slack's results page lists them.
  const tab = $derived<ResultTab>(results.tab ?? "messages");
  const people = $derived<Person[]>(agents.list.map(agent => ({ id: agent.id, name: agent.name, kind: "agent", conversationId: agents.room(agent.id), archived: !!agent.archived, detail: agent.archived ? "Archived agent" : agent.status === "working" ? "Agent · working now" : "Agent" })));
  const channels = $derived(channelMatches(conversations.list, results.q));
  const peopleFound = $derived(peopleMatches(people, results.q));
  const tabs = $derived([
    { id: "messages" as const, label: "Messages", badge: status.state === "ready" ? total : null },
    { id: "channels" as const, label: "Channels", badge: channels.length },
    { id: "people" as const, label: "People", badge: peopleFound.length },
  ]);
  const widen = $derived(widenRows(results.filters));

  function onkeydown(e: KeyboardEvent) {
    if (tab !== "messages") return;
    if (searchDialog.isOpen || e.metaKey || e.ctrlKey || e.altKey || composing(e)) return;
    const target = e.target as HTMLElement | null;
    if (target?.closest("input, textarea, [contenteditable=true], [role=menu], [role=dialog], [role=listbox]")) return;
    if (!hits.length) return;
    if (e.key === "ArrowDown" || e.key === "j") {
      e.preventDefault();
      focusCard(focusedIndex + 1);
    } else if (e.key === "ArrowUp" || e.key === "k") {
      e.preventDefault();
      focusCard(focusedIndex - 1);
    } else if (e.key === "Enter" && !target?.closest("a, button")) {
      e.preventDefault();
      const hit = hits[focusedIndex];
      if (hit) router.navigate(hit.link);
    }
  }
</script>

<svelte:window {onkeydown} />

<Page measure="full">
  {#snippet header()}
    <header class="header" data-search-page>
      <div class="title-row">
        <h1 class="title">
          {#if results.q}Results for: <span class="query" data-testid="results-query">{results.q}</span>{:else if anyFilter}Search results{:else}Search{/if}
        </h1>
        <div class="field">
          <SearchField bind:value={draft} placeholder="Search messages" label="Search messages" onkeydown={submit} maxlength={256} />
        </div>
      </div>
      <Tabs items={tabs} value={tab} variant="underline" size="sm" label="Result types" onchange={next => go({ tab: next })} />
      {#if tab === "messages"}
        <FilterBar filters={results.filters} {now} onchange={filters => go({ filters })}>
          {#snippet trailing()}
            {#if anyFilter}<Button variant="ghost" size="sm" onclick={() => go({ filters: NO_FILTERS })}>Clear filters</Button>{/if}
          {/snippet}
        </FilterBar>
        <div class="summary">
          <span class="sort">
            Sorted by
            {#if results.q}
              <button type="button" class="sort-button" bind:this={sortAnchor} onclick={() => (sortOpen = !sortOpen)} aria-haspopup="menu" aria-expanded={sortOpen}>
                {results.sort === "recent" ? "Most recent" : "Most relevant (default)"}<Icon name="chevron-down" size={14} />
              </button>
            {:else}
              <span class="sort-fixed" title="A search with no words lists the newest first">Most recent</span>
            {/if}
          </span>
          <Menu bind:open={sortOpen} anchor={sortAnchor} items={sortItems} label="Sort results" />
          {#if status.state === "ready"}<span class="count" data-testid="results-count">{resultCount(total)}</span>{/if}
        </div>
      {/if}
    </header>
  {/snippet}

  {#if tab === "channels"}
    <section class="names" aria-label="Channels" data-search-channels>
      {#if channels.length}
        <CardGroup>
          {#each channels as channel (channel.id)}
            <NavItem
              variant="card"
              href={conversationHref(channel.id)}
              icon={channel.archived ? "archive" : channel.kind === "channel" ? "hash" : "chat"}
              label={channel.kind === "channel" ? channel.name.replace(/^#/, "") : channel.name}
              detail={[channel.archived ? "Archived" : channel.kind === "channel" ? "Channel" : "Solo room", channel.preview].filter(Boolean).join(" · ")}
            />
          {/each}
        </CardGroup>
      {:else}
        <EmptyState icon="hash" title={`No channels match “${results.q}”`} description="Check the spelling, or look in Messages for what was said." />
      {/if}
    </section>
  {:else if tab === "people"}
    <section class="names" aria-label="People" data-search-people>
      {#if peopleFound.length}
        <CardGroup>
          {#each peopleFound as person (person.id)}
            {#snippet face()}<Avatar name={person.name} kind="agent" seed={person.id} size={24} />{/snippet}
            <NavItem variant="card" href={person.conversationId ? conversationHref(person.conversationId) : undefined} leading={face} label={person.name} detail={person.detail} />
          {/each}
        </CardGroup>
      {:else}
        <EmptyState icon="users" title={`No agents match “${results.q}”`} description="Check the spelling, or look in Messages for what was said." />
      {/if}
    </section>
  {:else}
  <section class="results" aria-label="Search results" bind:this={list} data-search-results>
    {#if status.state === "ready"}
      {#each missing as box (box.box)}<p class="missing" data-testid="search-missing">{box.note}</p>{/each}
    {/if}
    {#if status.state === "idle"}
      <p class="note">Type what to look for and press Enter. Cmd K searches from anywhere.</p>
    {:else if status.state === "loading"}
      <p class="note"><LoadingText text="Searching…" /></p>
    {:else if status.state === "error"}
      <div class="note">
        <p>Search is unavailable: {status.message}</p>
        <Button variant="outline" size="sm" onclick={() => (attempt += 1)}>Retry</Button>
      </div>
    {:else if !hits.length}
      <EmptyState icon="search" title={results.q ? `No results for “${results.q}”` : "No messages match these filters"} description={results.q ? NO_HITS : "Try other filters, or remove some."}>
        {#snippet action()}
          {#each widen as row (row.key)}
            {#if row.action.type === "filters"}
              {@const filters = row.action.filters}
              <Button variant={row.key === widen[0]?.key ? "primary" : "outline"} size="sm" onclick={() => go({ filters })}>{row.label}</Button>
            {/if}
          {/each}
        {/snippet}
      </EmptyState>
    {:else}
      {#each hits as hit, index (hit.id)}
        <ResultCard
          {hit}
          {now}
          focused={index === focusedIndex}
          expanded={expanded.has(hit.id)}
          context={contexts.get(hit.id)}
          ontoggle={() => toggle(hit)}
          onfocus={() => (focusedIndex = index)}
        />
      {/each}
      {#if cursor}
        <div class="more" bind:this={sentinel}>
          <Button variant="outline" size="sm" loading={loadingMore} onclick={() => void loadMore()}>Load more results</Button>
        </div>
      {:else}
        <p class="end">That's every result.</p>
      {/if}
    {/if}
  </section>
  {/if}
</Page>

<style>
  .header {
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 24px var(--space-panel-inset) 12px;
    border-bottom: 1px solid var(--border-standard);
  }
  .title-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    flex-wrap: wrap;
  }
  .title {
    margin: 0;
    min-width: 0;
    font: var(--text-heading);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .query {
    font-weight: 500;
  }
  .field {
    width: min(22rem, 100%);
  }
  .summary {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    color: var(--text-subtle);
    font: var(--text-body-sm);
  }
  .sort {
    display: inline-flex;
    align-items: center;
    gap: 4px;
  }
  .sort-button {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    padding: 2px 4px;
    border: 0;
    border-radius: var(--radius-row);
    background: none;
    color: var(--text-standard);
    font: inherit;
    font-weight: 500;
    cursor: pointer;
  }
  .sort-button:hover {
    background: var(--bg-app);
  }
  .count {
    font-variant-numeric: tabular-nums;
  }
  .sort-fixed {
    padding: 2px 4px;
    color: var(--text-standard);
    font-weight: 500;
  }
  .results {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .note,
  .missing {
    margin: 0;
    color: var(--text-subtle);
    font: var(--text-body-sm);
  }
  .end {
    margin: 24px 0;
    color: var(--text-subtle);
    font: var(--text-body-sm);
    text-align: center;
  }
  .note p {
    margin: 0 0 8px;
  }
  .more {
    display: flex;
    justify-content: center;
    padding: 12px 0 24px;
  }
</style>
