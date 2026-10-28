<script lang="ts">
  import { tick } from "svelte";
  import { agents, api, conversations, me, type SearchResult } from "$lib/api";
  import { router } from "$lib/router.svelte";
  import type { SearchScope } from "$lib/shell/search.svelte";
  import Avatar from "$lib/ui/Avatar.svelte";
  import Button from "$lib/ui/Button.svelte";
  import Chip from "$lib/ui/Chip.svelte";
  import Dialog from "$lib/ui/Dialog.svelte";
  import IconButton from "$lib/ui/IconButton.svelte";
  import LoadingText from "$lib/ui/LoadingText.svelte";
  import Menu from "$lib/ui/Menu.svelte";
  import NavItem from "$lib/ui/NavItem.svelte";
  import SearchField from "$lib/ui/SearchField.svelte";
  import { isMac } from "$lib/ui/keyboard";
  import Highlight from "./Highlight.svelte";
  import { pieces } from "./match";
  import { absorb, chipLabel, filters, prompt, withOperator, withoutPrompt, type NamedOperator, type Operator } from "./operators";
  import { buildGroups, messageGroupLabel, type Action, type Icon, type Messages, type Person, type Row, type Sort } from "./search-model";

  type Props = { open: boolean; scope: SearchScope; query: string; onclose: () => void };
  let { open, scope, query, onclose }: Props = $props();

  const PAGE = 20;
  const DEBOUNCE_MS = 150;
  const icons: Record<Icon, string> = { chat: "chat", channel: "hash", calendar: "clock", search: "search", more: "more" };

  let text = $state("");
  let operators = $state<Operator[]>([]);
  let scopeId = $state<string | undefined>();
  let sort = $state<Sort>("relevance");
  let messages = $state<Messages>({ state: "idle" });
  let cursor = $state<string | undefined>();
  let active = $state<string | undefined>();
  let input = $state<HTMLInputElement>();
  let sortButton = $state<HTMLButtonElement>();
  let sortOpen = $state(false);
  let list = $state<HTMLDivElement>();
  const listId = "search-results";

  $effect(() => {
    if (!open) return;
    text = query;
    operators = [];
    scopeId = scope.kind === "conversation" ? scope.id : undefined;
    sort = "relevance";
    messages = { state: "idle" };
    active = undefined;
  });

  const owner = $derived(me.value?.owner);
  const people = $derived<Person[]>([
    ...(owner ? [{ id: owner.id, name: owner.name, kind: "owner" as const, aliases: ["owner", "me", "you"] }] : []),
    ...agents.list
      .filter(agent => !agent.archived)
      .map(agent => ({
        id: agent.id,
        name: agent.name,
        kind: "agent" as const,
        conversationId: agent.id,
        detail: agent.kind === "job" ? (agent.parent ? `Job of ${agent.parent.name}` : "Job") : "Chat",
      })),
  ]);
  const scopeConversation = $derived(scopeId ? conversations.byId(scopeId) : undefined);

  function resolveNamed(kind: NamedOperator["kind"], value: string): NamedOperator | undefined {
    const needle = value.toLowerCase();
    if (kind === "from") {
      if (needle === "owner" || needle === "me") return owner ? { kind, id: owner.id, label: owner.name } : undefined;
      const found = people.filter(person => person.id.toLowerCase() === needle || person.name.toLowerCase() === needle);
      return found.length === 1 ? { kind, id: found[0]!.id, label: found[0]!.name } : undefined;
    }
    const found = conversations.list.filter(c => c.id.toLowerCase() === needle || c.name.replace(/^#/, "").toLowerCase() === needle);
    return found.length === 1 ? { kind, id: found[0]!.id, label: found[0]!.name.replace(/^#/, "") } : undefined;
  }

  function setText(value: string) {
    const next = absorb(value, operators, resolveNamed);
    text = next.text;
    operators = next.operators;
  }

  const request = $derived.by(() => {
    const base = filters(text, operators);
    const scoped = scopeId ? { ...base, in: scopeId } : base;
    const asks = !!scoped.q || operators.length > 0;
    return asks && !prompt(text)?.kind ? { ...scoped, sort: scopeId ? sort : ("relevance" as Sort) } : undefined;
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
    messages = { state: "loading" };
    const timer = setTimeout(async () => {
      try {
        const result = await api.search({ ...params, limit: PAGE });
        if (mine !== generation) return;
        show(result, false);
      } catch (error) {
        if (mine === generation) messages = { state: "error", message: error instanceof Error ? error.message : String(error) };
      }
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  });

  function show(result: SearchResult, append: boolean) {
    const before = append && messages.state === "ready" ? messages.hits : [];
    cursor = result.nextCursor;
    messages = { state: "ready", hits: [...before, ...result.hits], total: result.total, more: !!result.nextCursor, loadingMore: false };
  }

  async function loadMore() {
    if (!request || !cursor || messages.state !== "ready" || messages.loadingMore) return;
    const mine = generation;
    messages = { ...messages, loadingMore: true };
    try {
      const result = await api.search({ ...request, limit: PAGE, cursor });
      if (mine === generation) show(result, true);
    } catch (error) {
      if (mine === generation) messages = { state: "error", message: error instanceof Error ? error.message : String(error) };
    }
  }

  const groups = $derived(
    buildGroups({
      text,
      operators,
      scope: scopeId,
      current: router.conversationId ?? undefined,
      sort,
      conversations: conversations.list,
      people,
      messages,
      now: new Date(),
    }),
  );
  const rows = $derived(groups.flatMap(group => group.rows));
  const messageLabel = $derived(messageGroupLabel(scopeId ? sort : "relevance"));
  const hasQuery = $derived(!!text.trim() || operators.length > 0);

  $effect(() => {
    const keys = rows.map(row => row.key);
    if (active && keys.includes(active)) return;
    active = hasQuery || scopeId ? keys[0] : undefined;
  });

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
        router.openConversation(action.conversation, action.messageId ? { messageId: action.messageId } : {});
        return;
      case "scope":
        scopeId = action.conversation;
        text = "";
        focusInput();
        return;
      case "operator": {
        const open = prompt(text);
        operators = withOperator(operators, action.operator);
        text = open ? withoutPrompt(text, open) : text;
        focusInput();
        return;
      }
      case "more":
        void loadMore();
        focusInput();
        return;
    }
  }

  function removeOperator(operator: Operator) {
    operators = operators.filter(item => item !== operator);
    focusInput();
  }

  function onkeydown(e: KeyboardEvent) {
    if (e.isComposing) return;
    const index = active ? rows.findIndex(row => row.key === active) : -1;
    const digit = /^Digit([1-9])$/.exec(e.code)?.[1];
    if (digit && e.shiftKey && (isMac ? e.metaKey : e.ctrlKey) && !e.altKey) {
      const row = rows[Number(digit) - 1];
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
    } else if (e.key === "Backspace" && input && input.selectionStart === 0 && input.selectionEnd === 0) {
      if (operators.length) {
        e.preventDefault();
        operators = operators.slice(0, -1);
      } else if (scopeId && !text) {
        e.preventDefault();
        scopeId = undefined;
      }
    }
  }

  const label = $derived(scopeId ? "Search this conversation" : "Search");
  const sortItems = $derived([
    { type: "radio" as const, id: "relevance", label: "Most relevant", group: "sort", checked: sort === "relevance", onselect: () => (sort = "relevance") },
    { type: "radio" as const, id: "recent", label: "Most recent", group: "sort", checked: sort === "recent", onselect: () => (sort = "recent") },
  ]);
  const optionId = (key: string) => `search-row-${key.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
</script>

<Dialog {open} onclose={close} presentation="search" {label}>
  <div class="palette" data-search-palette>
    {#if scopeId}
      <div class="scope-row">
        <Chip
          label={scopeConversation?.name ?? "This conversation"}
          onremove={() => {
            scopeId = undefined;
            focusInput();
          }}
          removeLabel={`Remove ${scopeConversation?.name ?? "this conversation"} search scope`}
        />
        <IconButton bind:element={sortButton} icon="sort" label="Sort messages" size="sm" pressed={sortOpen} onclick={() => (sortOpen = !sortOpen)} />
        <Menu bind:open={sortOpen} anchor={sortButton} items={sortItems} placement="bottom-end" label="Sort messages" />
      </div>
    {/if}
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
    >
      {#snippet prefix()}
        {#if operators.length}
          {#each operators as operator (operator.kind)}
            <Chip label={chipLabel(operator)} onremove={() => removeOperator(operator)} removeLabel={`Remove ${chipLabel(operator)}`} />
          {/each}
        {/if}
      {/snippet}
    </SearchField>
    <div class="scroll" bind:this={list}>
      <div id={listId} role="listbox" aria-label="Search results" class="results">
        {#each groups as group (group.label)}
          {#if group.rows.length || group.empty !== undefined}
            <div role="group" aria-label={group.label} class="group" data-group={group.label}>
              <h2 class="heading">
                <span>{group.label}</span>
                {#if group.count !== undefined}
                  <span class="count" data-testid="search-count">{group.count.toLocaleString("en-US")} {group.count === 1 ? "message" : "messages"}</span>
                {/if}
              </h2>
              {#each group.rows as row (row.key)}
                {@render result(row)}
              {/each}
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
  {#snippet avatar()}
    {#if row.avatar}
      <Avatar name={row.avatar.name} kind={row.avatar.shape === "circle" ? "person" : "agent"} seed={row.key.replace(/^person:/, "")} src={row.avatar.src ?? null} size={24} />
    {/if}
  {/snippet}
  <NavItem
    variant="search"
    role="option"
    id={optionId(row.key)}
    data-key={row.key}
    data-search-result=""
    tabindex={-1}
    label={row.label}
    detail={row.detail}
    icon={row.avatar ? undefined : icons[row.icon]}
    leading={row.avatar ? avatar : undefined}
    highlighted={active === row.key}
    onpointermove={() => (active = row.key)}
    onclick={() => run(row.action)}
  >
    {#snippet labelContent()}
      <Highlight pieces={row.snippet ?? pieces(row.label, row.positions)} />
    {/snippet}
  </NavItem>
{/snippet}

<style>
  .palette {
    display: flex;
    flex-direction: column;
    min-height: 0;
    max-height: calc(100vh - 128px - 48px);
  }
  .scope-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 12px 0 0;
  }
  .scroll {
    position: relative;
    flex: 1;
    min-height: 0;
    max-height: min(55vh, calc(100dvh - 128px - 8rem));
    overflow-x: hidden;
    overflow-y: auto;
    padding: 0 0 12px;
  }
  .results {
    display: flex;
    flex-direction: column;
    gap: 24px;
  }
  .group {
    display: flex;
    flex-direction: column;
    gap: 1px;
  }
  .heading {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    min-height: 28px;
    margin: 0;
    padding: 0 12px;
    color: var(--neutral-7);
    font: var(--text-body-sm);
    letter-spacing: var(--tracking-body-sm);
    font-weight: 400;
  }
  .count {
    font-variant-numeric: tabular-nums;
  }
  .empty {
    margin: 4px 0;
    padding: 0 12px;
    color: var(--text-subtle);
    font: var(--text-body-sm);
  }
  .retry {
    padding: 0 4px;
  }
</style>
