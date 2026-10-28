<script lang="ts">
  import { untrack } from "svelte";
  import { SvelteMap, SvelteSet } from "svelte/reactivity";
  import { agents, api, conversations, type SearchHit } from "$lib/api";
  import { hrefFor, router } from "$lib/router.svelte";
  import { search as searchDialog } from "$lib/shell/search.svelte";
  import Button from "$lib/ui/Button.svelte";
  import Chip from "$lib/ui/Chip.svelte";
  import Icon from "$lib/ui/Icon.svelte";
  import LoadingText from "$lib/ui/LoadingText.svelte";
  import Menu from "$lib/ui/Menu.svelte";
  import Page from "$lib/ui/Page.svelte";
  import Picker from "$lib/ui/Picker.svelte";
  import SearchField from "$lib/ui/SearchField.svelte";
  import type { PickerItem } from "$lib/ui/types";
  import { contextOf, replyContextOf, type HitContext } from "./context";
  import ResultCard from "./ResultCard.svelte";
  import { dateLabel, dateRanges, readResults, resultCount, resultParams, searchParams, type Results, type ResultType } from "./results-model";

  const PAGE = 20;

  const results = $derived(readResults(router.route.params));
  const key = $derived(JSON.stringify(searchParams(results)));

  type State = { state: "idle" } | { state: "loading" } | { state: "error"; message: string } | { state: "ready" };
  let status = $state<State>({ state: "idle" });
  let hits = $state<SearchHit[]>([]);
  let total = $state(0);
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
    untrack(() => {
      draft = params.q;
      hits = [];
      total = 0;
      cursor = undefined;
      focusedIndex = 0;
      expanded.clear();
      now = new Date();
      status = params.q ? { state: "loading" } : { state: "idle" };
    });
    if (!params.q) return;
    api.search({ ...params, limit: PAGE }).then(
      result => {
        if (mine !== generation) return;
        hits = result.hits;
        total = result.total;
        cursor = result.nextCursor;
        status = { state: "ready" };
      },
      error => {
        if (mine === generation) status = { state: "error", message: error instanceof Error ? error.message : String(error) };
      },
    );
  });

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
      if (hit.threadRoot) contexts.set(hit.id, replyContextOf(await api.replies(hit.conversation.id, hit.threadRoot), hit));
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
    if (e.key !== "Enter" || e.isComposing) return;
    e.preventDefault();
    go({ q: draft.trim() });
  }

  // Filters

  const ownerOnly = $derived(results.from === "owner");
  const agentsOnly = $derived(results.from === "agents");
  const ranges = $derived(dateRanges(now));
  const lastWeek = $derived(ranges.find(range => range.id === "7d")!);
  const inLastWeek = $derived(results.after === lastWeek.after && !results.before);
  const fromLabel = $derived(
    !results.from ? undefined : results.from === "owner" ? "You" : results.from === "agents" ? "Agents" : (agents.byId(results.from)?.name ?? conversations.byId(results.from)?.name ?? results.from),
  );
  const inLabel = $derived(results.in ? (conversations.byId(results.in)?.name ?? results.in) : undefined);
  const typeLabels: Record<ResultType, string> = { messages: "Messages only", tools: "Tool output only" };
  const anyFilter = $derived(!!(results.from || results.in || results.after || results.before || results.type));

  let typeAnchor = $state<HTMLElement>();
  let typeOpen = $state(false);
  let fromAnchor = $state<HTMLElement>();
  let fromOpen = $state(false);
  let inAnchor = $state<HTMLElement>();
  let inOpen = $state(false);
  let dateAnchor = $state<HTMLElement>();
  let dateOpen = $state(false);
  let sortAnchor = $state<HTMLButtonElement>();
  let sortOpen = $state(false);

  const typeItems = $derived([
    { type: "radio" as const, id: "all", group: "type", label: "Everything", detail: "Messages first, then tool output", checked: !results.type, onselect: () => go({ type: undefined }) },
    { type: "radio" as const, id: "messages", group: "type", label: "Messages only", detail: "What you and agents wrote", checked: results.type === "messages", onselect: () => go({ type: "messages" }) },
    { type: "radio" as const, id: "tools", group: "type", label: "Tool output only", detail: "Commands and their output", checked: results.type === "tools", onselect: () => go({ type: "tools" }) },
  ]);
  const fromItems = $derived<PickerItem[]>([
    { id: "", label: "Anyone", icon: "users" },
    { id: "owner", label: "You", icon: "user" },
    { id: "agents", label: "Agents only", icon: "robot", detail: "Everyone but you" },
    ...agents.list
      .filter(agent => !agent.archived)
      .map(agent => ({ id: agent.id, label: agent.name, group: "Agents", avatar: { name: agent.name, kind: "agent" as const, seed: agent.id }, ...(agent.parent ? { trailing: agent.parent.name } : {}) })),
  ]);
  const inItems = $derived<PickerItem[]>([
    { id: "", label: "Anywhere", icon: "search" },
    ...[...conversations.list]
      .filter(c => !c.archived)
      .sort((a, b) => b.lastActivityAt - a.lastActivityAt)
      .map(c => ({ id: c.id, label: c.kind === "channel" ? c.name.replace(/^#?/, "#") : c.name, group: c.kind === "channel" ? "Channels" : c.kind === "job" ? "Jobs" : "Conversations", icon: c.kind === "channel" ? "hash" : c.kind === "job" ? "robot" : "chat" })),
  ]);
  const dateItems = $derived(
    ranges.map(range => ({
      type: "radio" as const, id: range.id, group: "date", label: range.label,
      checked: range.id === "any" ? !results.after && !results.before : results.after === range.after && results.before === range.before,
      onselect: () => go({ after: range.after, before: range.before }),
    })),
  );
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

  function onkeydown(e: KeyboardEvent) {
    if (searchDialog.isOpen || e.metaKey || e.ctrlKey || e.altKey || e.isComposing) return;
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
      if (hit) router.openConversation(hit.conversation.id, { messageId: hit.messageId });
    }
  }
</script>

<svelte:window {onkeydown} />

<Page measure="full">
  {#snippet header()}
    <header class="header" data-search-page>
      <div class="title-row">
        <h1 class="title">
          {#if results.q}Results for: <span class="query" data-testid="results-query">{results.q}</span>{:else}Search{/if}
        </h1>
        <div class="field">
          <SearchField bind:value={draft} placeholder="Search messages" label="Search messages" onkeydown={submit} maxlength={256} />
        </div>
      </div>
      <div class="filters" role="toolbar" aria-label="Filters" data-search-filters>
        <span bind:this={typeAnchor}>
          <Chip selected={!!results.type} onclick={() => (typeOpen = !typeOpen)}>
            <span class="chip-label">{results.type ? typeLabels[results.type] : "Messages"}</span><Icon name="chevron-down" size={14} />
          </Chip>
        </span>
        <Menu bind:open={typeOpen} anchor={typeAnchor} items={typeItems} label="Result type" />
        <span bind:this={fromAnchor}>
          <Chip selected={!!results.from} onclick={() => (fromOpen = !fromOpen)}>
            <span class="chip-label">{fromLabel ? `From: ${fromLabel}` : "From"}</span><Icon name="chevron-down" size={14} />
          </Chip>
        </span>
        <Picker bind:open={fromOpen} anchor={fromAnchor} items={fromItems} value={results.from ?? ""} label="From" placeholder="Find a person or agent" onselect={id => go({ from: id || undefined })} />
        <span bind:this={inAnchor}>
          <Chip selected={!!results.in} onclick={() => (inOpen = !inOpen)}>
            <span class="chip-label">{inLabel ? `In: ${inLabel}` : "In"}</span><Icon name="chevron-down" size={14} />
          </Chip>
        </span>
        <Picker bind:open={inOpen} anchor={inAnchor} items={inItems} value={results.in ?? ""} label="In" placeholder="Find a conversation" onselect={id => go({ in: id || undefined })} />
        <span bind:this={dateAnchor}>
          <Chip selected={!!(results.after || results.before)} onclick={() => (dateOpen = !dateOpen)}>
            <span class="chip-label">{dateLabel(results, now) ?? "Date"}</span><Icon name="chevron-down" size={14} />
          </Chip>
        </span>
        <Menu bind:open={dateOpen} anchor={dateAnchor} items={dateItems} label="Date" />
        <span class="divider" aria-hidden="true"></span>
        <Chip label="You only" selected={ownerOnly} onclick={() => go({ from: ownerOnly ? undefined : "owner" })} />
        <Chip label="Agents only" selected={agentsOnly} onclick={() => go({ from: agentsOnly ? undefined : "agents" })} />
        <Chip label="Last 7 days" selected={inLastWeek} onclick={() => go(inLastWeek ? { after: undefined, before: undefined } : { after: lastWeek.after, before: undefined })} />
        <Chip label="No tool output" selected={results.type === "messages"} onclick={() => go({ type: results.type === "messages" ? undefined : "messages" })} />
        {#if anyFilter}
          <Button variant="ghost" size="sm" onclick={() => go({ from: undefined, in: undefined, after: undefined, before: undefined, type: undefined })}>Clear filters</Button>
        {/if}
      </div>
      <div class="summary">
        <span class="sort">
          Sorted by
          <button type="button" class="sort-button" bind:this={sortAnchor} onclick={() => (sortOpen = !sortOpen)} aria-haspopup="menu" aria-expanded={sortOpen}>
            {results.sort === "recent" ? "Most recent" : "Most relevant (default)"}<Icon name="chevron-down" size={14} />
          </button>
        </span>
        <Menu bind:open={sortOpen} anchor={sortAnchor} items={sortItems} label="Sort results" />
        {#if status.state === "ready"}<span class="count" data-testid="results-count">{resultCount(total)}</span>{/if}
      </div>
    </header>
  {/snippet}

  <section class="results" aria-label="Search results" bind:this={list} data-search-results>
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
      <p class="note">No results for “{results.q}”{anyFilter ? " with these filters" : ""}.</p>
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
  .filters {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 6px;
  }
  .chip-label {
    margin-right: 2px;
  }
  .divider {
    width: 1px;
    height: 20px;
    margin: 0 4px;
    background: var(--border-standard);
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
  .results {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .note,
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
