<script lang="ts">
  import { onMount, tick, untrack } from "svelte";
  import { agents, api, conversations, listedAhead, me, type SearchMissing, type SearchResult } from "$lib/api";
  import { hrefFor, router } from "$lib/router.svelte";
  import type { SearchScope } from "$lib/shell/search.svelte";
  import Avatar from "$lib/ui/Avatar.svelte";
  import Button from "$lib/ui/Button.svelte";
  import Dialog from "$lib/ui/Dialog.svelte";
  import IconButton from "$lib/ui/IconButton.svelte";
  import LoadingText from "$lib/ui/LoadingText.svelte";
  import Menu from "$lib/ui/Menu.svelte";
  import NavItem from "$lib/ui/NavItem.svelte";
  import SearchField from "$lib/ui/SearchField.svelte";
  import { composing, isMac } from "$lib/ui/keyboard";
  import FilterBar from "./FilterBar.svelte";
  import { filterQuery, hasFilters, NO_FILTERS, withoutLast, type Filters } from "./filters";
  import Highlight from "./Highlight.svelte";
  import HitAvatar from "./HitAvatar.svelte";
  import HitMeta from "./HitMeta.svelte";
  import { shortAge } from "./hit-view";
  import { localHits } from "./local-index";
  import { pieces } from "./match";
  import { recentMessages } from "./recent";
  import { resultParams } from "./results-model";
  import { absorb, prompt, searchText, withOperator, withoutPrompt, type NamedOperator } from "./operators";
  import { answered, buildGroups, messageGroupLabel, SEE_ALL, type Action, type Icon, type Messages, type Person, type Row, type Sort } from "./search-model";

  type Props = { open: boolean; scope: SearchScope; query: string; onclose: () => void };
  let { open, scope, query, onclose }: Props = $props();

  const PAGE = 20;
  const icons: Record<Icon, string> = { chat: "chat", channel: "hash", calendar: "clock", search: "search", more: "more" };

  let text = $state("");
  /** The one filter state: the chips under the field set it, and so do typed operators such as `from:vent` (operators.ts `absorb`). */
  let filters = $state<Filters>(NO_FILTERS);
  let sort = $state<Sort>("relevance");
  let messages = $state<Messages>({ state: "idle" });
  let cursor = $state<string | undefined>();
  /** The boxes whose threads the last search could not read, such as a Mac that is offline. */
  let missing = $state<SearchMissing[]>([]);
  let active = $state<string | undefined>();
  let input = $state<HTMLInputElement>();
  let sortButton = $state<HTMLButtonElement>();
  let sortOpen = $state(false);
  let list = $state<HTMLDivElement>();
  let now = $state(new Date());
  const listId = "search-results";

  $effect(() => {
    if (!open) return;
    text = query;
    now = new Date();
    filters = scope.kind === "conversation" ? { ...NO_FILTERS, in: scope.id } : NO_FILTERS;
    sort = "relevance";
    messages = { state: "idle" };
    active = undefined;
    answers.clear();
    recentMessages.refresh();
  });

  // The feed loads once the page is idle, so the first Cmd K already matches in the page.
  onMount(() => {
    const idle = globalThis.requestIdleCallback ?? ((run: () => void) => setTimeout(run, 1));
    idle(() => recentMessages.refresh());
  });

  /** The server's first page for each request of this opening, so a key taken back or typed again shows its answer with no request. */
  const answers = new Map<string, SearchResult>();

  const owner = $derived(me.value?.owner);
  const people = $derived<Person[]>([
    ...(owner ? [{ id: "owner", name: owner.name, kind: "owner" as const, aliases: ["owner", "me", "you"] }] : []),
    ...agents.list
      .filter(agent => !agent.archived)
      .map(agent => ({
        id: agent.id,
        name: agent.name,
        kind: "agent" as const,
        conversationId: agents.room(agent.id),
        detail: agent.status === "working" ? "Agent · working now" : "Agent",
      })),
  ]);

  function resolveNamed(kind: NamedOperator["kind"], value: string): string | undefined {
    const needle = value.toLowerCase();
    if (kind === "from") {
      if (needle === "owner" || needle === "me" || needle === "agents") return needle === "agents" ? "agents" : "owner";
      const found = people.filter(person => person.id.toLowerCase() === needle || person.name.toLowerCase() === needle);
      return found.length === 1 ? found[0]!.id : undefined;
    }
    const found = conversations.list.filter(c => c.id.toLowerCase() === needle || c.name.replace(/^#/, "").toLowerCase() === needle);
    return found.length === 1 ? found[0]!.id : undefined;
  }

  function setText(value: string) {
    const next = absorb(value, filters, resolveNamed);
    text = next.text;
    filters = next.filters;
  }

  /** The server matches words, so a search asks only once some are typed; the filters narrow them. */
  const request = $derived.by(() => {
    const q = searchText(text);
    return q && !prompt(text)?.kind ? { q, ...filterQuery(filters), sort } : undefined;
  });
  const requestKey = $derived(request ? JSON.stringify(request) : "");

  let generation = 0;
  let attempt = $state(0);
  $effect(() => {
    const key = requestKey;
    void attempt;
    if (!open) return;
    const params = request;
    if (!params || !key) {
      messages = { state: "idle" };
      return;
    }
    const mine = ++generation;
    const known = answers.get(key);
    if (known) {
      show(known, false);
      return;
    }
    // The page's own matches show at this keystroke: the hits on screen that still match, then the feed's. The server's answer replaces them.
    const shown = untrack(() => (messages.state === "ready" || messages.state === "loading" ? messages.hits : []));
    messages = { state: "loading", hits: localHits(shown, recentMessages.feed.entries(), { q: params.q, filters, sort: params.sort, limit: PAGE }) };
    // A newer keystroke or a close aborts this one's request, and an aborted request shows no error. The request leaves at the keystroke:
    // a wait before it added 150 ms to every answer, and the server answers a search in about 20 ms (11-19, 5 GETs of q=duty).
    const controller = new AbortController();
    const { signal } = controller;
    // One search answers for every box with the exact count: the index holds every box's rows (server/search-engine.ts).
    api.search({ ...params, limit: PAGE, brief: true }, { signal }).then(
      result => {
        answers.set(key, result);
        if (mine === generation) show(result, false);
      },
      (error: unknown) => {
        if (mine !== generation || signal.aborted) return;
        messages = { state: "error", message: error instanceof Error ? error.message : String(error) };
      },
    );
    return () => controller.abort();
  });

  function show(result: SearchResult, append: boolean) {
    cursor = result.nextCursor;
    missing = result.missing ?? [];
    messages = answered(result, append && messages.state === "ready" ? messages.hits : []);
  }

  async function loadMore() {
    if (!request || !cursor || messages.state !== "ready" || messages.loadingMore) return;
    const mine = generation;
    messages = { ...messages, loadingMore: true };
    try {
      const result = await api.search({ ...request, limit: PAGE, cursor, brief: true });
      if (mine === generation) show(result, true);
    } catch (error) {
      if (mine === generation) messages = { state: "error", message: error instanceof Error ? error.message : String(error) };
    }
  }

  const groups = $derived(
    buildGroups({
      text,
      filters,
      current: router.conversationId ?? undefined,
      sort,
      conversations: conversations.list,
      people,
      messages,
      now,
    }),
  );
  const rows = $derived(groups.flatMap(group => group.rows));
  const messageLabel = $derived(messageGroupLabel(sort, !!filters.in));
  /** Shift Cmd 1 to 9 pick the conversations and messages, past "See all results" and the search-here row. */
  const numbered = $derived(rows.filter(row => row.key !== SEE_ALL && row.action.type !== "scope"));
  const hasQuery = $derived(!!text.trim() || hasFilters(filters));

  $effect(() => {
    const keys = rows.map(row => row.key);
    if (active && keys.includes(active)) return;
    active = hasQuery ? keys[0] : undefined;
  });

  // The conversations and message hits listed are read ahead, so the one the owner picks opens from the page's cache.
  $effect(() => listedAhead(rows.flatMap(row => (row.action.type === "open" ? [row.action] : []))));

  $effect(() => {
    if (!active || !list) return;
    list.querySelector(`[data-key="${CSS.escape(active)}"]`)?.scrollIntoView({ block: "nearest" });
  });

  function close() {
    onclose();
  }

  function retry() {
    attempt += 1;
    focusInput();
  }

  function focusInput() {
    void tick().then(() => input?.focus());
  }

  function run(action: Action) {
    switch (action.type) {
      case "open":
        close();
        if (action.link) router.navigate(action.link);
        else router.openConversation(action.conversation, action.messageId ? { messageId: action.messageId } : {});
        return;
      case "scope":
        filters = { ...filters, in: action.conversation };
        text = "";
        focusInput();
        return;
      case "operator": {
        const open = prompt(text);
        filters = withOperator(filters, action.operator);
        text = open ? withoutPrompt(text, open) : text;
        focusInput();
        return;
      }
      case "more":
        void loadMore();
        focusInput();
        return;
      case "page":
        close();
        router.navigate(hrefFor("search", [], resultParams({ q: searchText(text), sort, filters })));
        return;
    }
  }

  function onkeydown(e: KeyboardEvent) {
    if (composing(e)) return;
    const index = active ? rows.findIndex(row => row.key === active) : -1;
    const digit = /^Digit([1-9])$/.exec(e.code)?.[1];
    if (digit && e.shiftKey && (isMac ? e.metaKey : e.ctrlKey) && !e.altKey) {
      const row = numbered[Number(digit) - 1];
      if (row) {
        e.preventDefault();
        if (!e.repeat) run(row.action);
      }
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (!rows.length) return;
      e.preventDefault();
      const step = e.key === "ArrowDown" ? 1 : -1;
      const next = index < 0 ? (step > 0 ? 0 : rows.length - 1) : (index + step + rows.length) % rows.length;
      active = rows[next]!.key;
    } else if (e.key === "Home" && e.ctrlKey && rows.length) {
      e.preventDefault();
      active = rows[0]!.key;
    } else if (e.key === "End" && e.ctrlKey && rows.length) {
      e.preventDefault();
      active = rows.at(-1)!.key;
    } else if (e.key === "Enter") {
      const row = rows[index];
      if (row) {
        e.preventDefault();
        run(row.action);
      }
    } else if (e.key === "Backspace" && input && input.selectionStart === 0 && input.selectionEnd === 0 && hasFilters(filters)) {
      e.preventDefault();
      filters = withoutLast(filters);
    }
  }

  const label = $derived(filters.in ? "Search this conversation" : "Search");
  const sortItems = $derived([
    { type: "radio" as const, id: "relevance", label: "Most relevant", group: "sort", checked: sort === "relevance", onselect: () => (sort = "relevance") },
    { type: "radio" as const, id: "recent", label: "Most recent", group: "sort", checked: sort === "recent", onselect: () => (sort = "recent") },
  ]);
  const optionId = (key: string) => `search-row-${key.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
</script>

<Dialog {open} onclose={close} presentation="search" {label}>
  <div class="palette" data-search-palette>
    <div class="field">
      <SearchField
        variant="palette"
        placeholder="Search..."
        {label}
        bind:value={() => text, setText}
        bind:element={input}
        {onkeydown}
        role="combobox"
        aria-expanded="true"
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={active ? optionId(active) : undefined}
        maxlength={256}
        data-autofocus
      />
    </div>
    <div class="filters">
      <FilterBar {filters} {now} onchange={next => (filters = next)}>
        {#snippet trailing()}
          <IconButton bind:element={sortButton} icon="sort" label="Sort messages" size="sm" pressed={sortOpen} onclick={() => (sortOpen = !sortOpen)} />
          <Menu bind:open={sortOpen} anchor={sortButton} items={sortItems} placement="bottom-end" label="Sort messages" />
        {/snippet}
      </FilterBar>
    </div>
    <div class="scroll" bind:this={list}>
      <div id={listId} role="listbox" aria-label="Search results" class="results">
        {#each groups as group (group.label)}
          {#if group.rows.length || group.empty !== undefined}
            <div role="group" aria-label={group.label} class="group" data-group={group.label}>
              <h2 class="heading" class:sr-only={group.hideLabel}>
                <span>{group.label}</span>
                {#if group.count !== undefined}
                  <span class="count" data-testid="search-count">{`${group.count.toLocaleString("en-US")} ${group.count === 1 ? "message" : "messages"}`}</span>
                {:else if messages.state === "loading" && group.label === messageLabel && group.rows.length}
                  <span class="count" data-testid="search-pending"><LoadingText text="Searching all messages…" /></span>
                {/if}
              </h2>
              {#each group.rows as row (row.key)}
                {@render result(row)}
              {/each}
              {#if group.label === messageLabel && messages.state === "ready"}
                {#each missing as box (box.box)}<p class="empty" data-testid="search-missing">{box.note}</p>{/each}
              {/if}
              {#if !group.rows.length && group.empty}
                {#if messages.state === "loading" && group.label === messageLabel}
                  <p class="empty"><LoadingText text={group.empty} /></p>
                {:else}
                  <p class="empty">{group.empty}</p>
                {/if}
              {/if}
              {#if messages.state === "error" && group.label === messageLabel && !group.rows.length}
                <div class="retry">
                  <Button variant="ghost" size="sm" onclick={retry}>Retry messages</Button>
                </div>
              {/if}
            </div>
          {/if}
        {/each}
      </div>
    </div>
  </div>
</Dialog>

{#snippet result(row: Row)}
  {#if row.hit}
    {@render hitRow(row, row.hit)}
  {:else}
    {#snippet avatar()}
      {#if row.avatar}
        <Avatar name={row.avatar.name} kind={row.avatar.shape === "circle" ? "person" : "agent"} seed={row.key.replace(/^person:/, "")} src={row.avatar.src ?? null} size={20} />
      {/if}
    {/snippet}
    {#snippet enter()}
      {#if row.key === SEE_ALL}<kbd class="enter">Enter</kbd>{/if}
    {/snippet}
    <NavItem
      variant="palette"
      role="option"
      id={optionId(row.key)}
      data-key={row.key}
      data-search-result=""
      tabindex={-1}
      label={row.label}
      detail={row.detail}
      icon={row.avatar ? undefined : icons[row.icon]}
      leading={row.avatar ? avatar : undefined}
      trailing={row.key === SEE_ALL ? enter : undefined}
      highlighted={active === row.key}
      onpointermove={() => (active = row.key)}
      onclick={() => run(row.action)}
    >
      {#snippet labelContent()}
        <Highlight pieces={row.snippet ?? pieces(row.label, row.positions)} />
      {/snippet}
    </NavItem>
  {/if}
{/snippet}

{#snippet hitRow(row: Row, hit: NonNullable<Row["hit"]>)}
  {#snippet lead()}<HitAvatar {hit} size={20} />{/snippet}
  {#snippet meta()}<span class="who"><HitMeta {hit} showPlace={false} showWhat={false} showThread={false} /></span>{/snippet}
  {#snippet text()}<span class="snippet" class:tool={hit.role === "tool"}><Highlight pieces={row.snippet ?? []} /></span>{/snippet}
  {#snippet age()}
    <span class="place-cell"><HitMeta {hit} showAuthor={false} showPlace={!filters.in} /></span>
    <time class="age" datetime={new Date(hit.at).toISOString()} title={new Date(hit.at).toLocaleString()}>{shortAge(hit.at, now)}</time>
  {/snippet}
  <NavItem
    variant="palette"
    role="option"
    id={optionId(row.key)}
    data-key={row.key}
    data-search-result=""
    data-role={hit.role ?? ""}
    tabindex={-1}
    label={row.label}
    detail={row.detail}
    leading={lead}
    labelContent={meta}
    detailContent={text}
    trailing={age}
    highlighted={active === row.key}
    onpointermove={() => (active = row.key)}
    onclick={() => run(row.action)}
  />
{/snippet}

<style>
  .palette {
    display: flex;
    flex-direction: column;
    min-height: 0;
    max-height: calc(100vh - 128px - 48px);
  }
  .filters {
    padding: 8px 8px;
    border-bottom: 1px solid var(--border-standard);
  }
  .scroll {
    position: relative;
    flex: 1;
    min-height: 0;
    max-height: min(60vh, calc(100dvh - 128px - 48px - 64px));
    overflow-x: hidden;
    overflow-y: auto;
    padding: 6px 0 8px;
  }
  .results {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .group {
    display: flex;
    flex-direction: column;
  }
  .heading {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    min-height: 24px;
    margin: 0;
    padding: 0 8px;
    color: var(--neutral-7);
    font: var(--text-caption);
    letter-spacing: var(--tracking-caption);
    font-weight: 400;
  }
  .count {
    font-variant-numeric: tabular-nums;
  }
  .empty {
    margin: 4px 0;
    padding: 0 8px;
    color: var(--text-subtle);
    font: var(--text-body-sm);
  }
  .retry {
    padding: 0 4px;
  }
  .snippet {
    color: var(--text-standard);
    font: var(--text-body-sm);
    letter-spacing: var(--tracking-body-sm);
  }
  .snippet.tool {
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--text-subtle);
  }
  .who {
    display: flex;
  }
  .who :global([data-hit-author]) {
    max-width: 9rem;
  }
  /* The place shows in full up to 18rem, and the snippet before it gives way first. */
  .place-cell {
    display: flex;
    max-width: 18rem;
    min-width: 0;
    overflow: hidden;
  }
  .age {
    color: var(--text-metadata);
    font: var(--text-caption);
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }
  .enter {
    padding: 0 5px;
    border: 1px solid var(--border-standard);
    border-radius: 5px;
    color: var(--text-metadata);
    font: var(--text-caption);
  }
</style>
