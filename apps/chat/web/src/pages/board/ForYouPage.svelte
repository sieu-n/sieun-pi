<script lang="ts">
  import { onDestroy } from "svelte";
  import { api, forYou, type BoardOp } from "$lib/api";
  import { Avatar, Bubble, Button, EmptyState, IconButton, IdChip, LoadingText, Menu, NavItem, PanelHeader, SplitPane, stampLabel, toast, type MenuEntry } from "$lib/ui";
  import { router, conversationHref } from "$lib/router.svelte";
  import AskCard from "./AskCard.svelte";
  import PlanMark from "./PlanMark.svelte";
  import { boardHref, forYouHref } from "./chips";
  import { STATUS_LABEL as STEP_LABEL, type StepStatus } from "./model";
  import {
    DEFAULT_FILTER, STATUS_LABEL, TYPE_LABEL, emptyWords, filterSummary, itemKey, shortAge, visibleItems,
    type ForYouFilter, type ForYouItem, type ForYouStatus, type ForYouType,
  } from "./for-you";

  let filter = $state<ForYouFilter>({ ...DEFAULT_FILTER });
  let menuOpen = $state(false);
  let menuAnchor = $state<HTMLElement>();
  let splitWidth = $state(0);
  let now = $state(Date.now());
  const clock = setInterval(() => { now = Date.now(); }, 30_000);
  onDestroy(() => clearInterval(clock));

  const items = $derived(forYou.items as ForYouItem[]);
  const visible = $derived(visibleItems(items, filter));
  const selectedKey = $derived(router.route.rest[1] && router.route.rest[2] ? `${router.route.rest[1]}/${router.route.rest[2]}` : null);
  const selected = $derived(selectedKey ? items.find(item => itemKey(item) === selectedKey) ?? null : null);
  const empty = $derived(emptyWords(filter));

  const menu = $derived<MenuEntry[]>([
    { type: "label", label: "Type" },
    ...(Object.keys(TYPE_LABEL) as ForYouType[]).map(type => ({
      type: "radio" as const, id: `type-${type}`, group: "type", label: TYPE_LABEL[type], checked: filter.type === type, keepOpen: true,
      onselect: () => { filter = { ...filter, type }; },
    })),
    { type: "separator" },
    { type: "label", label: "Status" },
    ...(Object.keys(STATUS_LABEL) as ForYouStatus[]).map(status => ({
      type: "radio" as const, id: `status-${status}`, group: "status", label: STATUS_LABEL[status], checked: filter.status === status, keepOpen: true,
      onselect: () => { filter = { ...filter, status }; },
    })),
    { type: "separator" },
    { type: "checkbox", id: "unanswered", label: "Show unanswered only", checked: filter.unansweredOnly, onselect: (checked: boolean) => { filter = { ...filter, unansweredOnly: checked }; } },
  ]);

  const open = (item: ForYouItem) => router.navigate(forYouHref(item.chatId, item.todo.id));
  const close = () => router.navigate(forYouHref());

  async function apply(item: ForYouItem, ops: BoardOp[]) {
    await api.boardOps(item.chatId, ops);
    await forYou.refresh();
  }
  async function markDone(item: ForYouItem) {
    try {
      await apply(item, [{ op: "todo_update", id: item.todo.id, done: !item.todo.done }]);
      toast.success(item.todo.done ? `Reopened ${item.todo.id}` : `${item.todo.from === "agent" ? "Dismissed" : "Done"} ${item.todo.id}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "The board did not take that change.");
    }
  }
  const titlesFor = (item: ForYouItem): Map<string, string> => {
    const titles = new Map<string, string>([[item.todo.id, item.todo.text]]);
    if (item.step) titles.set(item.step.id, item.step.text);
    return titles;
  };
  const boardId = (item: ForYouItem) => (id: string) => router.navigate(boardHref(item.chatId, id));
</script>

{#snippet toolbar()}
  <header class="toolbar">
    <Button size="sm" variant="ghost" trailingIcon="chevron-down" bind:element={menuAnchor} aria-label="For you filters" onclick={() => { menuOpen = !menuOpen; }}>{filterSummary(filter)}</Button>
    <IconButton size="sm" icon="filter" label={filter.unansweredOnly ? "Show every ask" : "Show unanswered only"} pressed={filter.unansweredOnly} onclick={() => { filter = { ...filter, unansweredOnly: !filter.unansweredOnly }; }} />
    <Menu bind:open={menuOpen} anchor={menuAnchor} items={menu} label="For you filters" />
    <span class="spacer"></span>
    {#if forYou.loading && items.length}<span class="t-caption status">Checking your chats…</span>{/if}
  </header>
{/snippet}

{#snippet list()}
  <div class="list-pane">
    {@render toolbar()}
    <div class="scroll">
      {#if forYou.error && !items.length && !forYou.loading}
        <div class="notice" role="alert"><p class="t-body">{forYou.error}</p><Button size="sm" onclick={() => forYou.refresh()}>Retry For you</Button></div>
      {:else if forYou.loading && !items.length}
        <div class="notice"><LoadingText text="Loading For you…" /></div>
      {:else if !visible.length}
        <div class="empty" role="status"><EmptyState icon="inbox" title={empty.title} description={empty.description} /></div>
      {:else}
        <ul class="rows" aria-label="For you asks">
          {#each visible as item (itemKey(item))}
            {@const unanswered = item.todo.from === "agent" && !item.todo.done && !item.todo.reply}
            <li class="row" class:selected={selectedKey === itemKey(item)} data-key={itemKey(item)}>
              <NavItem variant="search" label={item.chatName} selected={selectedKey === itemKey(item)} unread={unanswered} aria-label="Open {item.todo.id} from {item.chatName}" onclick={() => open(item)}>
                {#snippet leading()}<Avatar name={item.chatName} kind={item.todo.from === "agent" ? "agent" : "person"} seed={item.chatId} size={32} />{/snippet}
                {#snippet labelContent()}
                  <span class="heading">
                    <span class="identity"><strong class="sender t-label-sm">{item.chatName}</strong><span class="source t-caption">{item.todo.id}{item.step ? ` · ${item.step.id}` : ""}{item.todo.from === "owner" ? " · your note" : ""}</span></span>
                    <time class="date t-caption" datetime={item.todo.at}>{shortAge(item.todo.at, now)}</time>
                  </span>
                {/snippet}
                {#snippet detailContent()}<span class="preview t-body" class:quiet={!unanswered}>{item.todo.text}</span>{/snippet}
                {#snippet trailing()}{#if unanswered}<span class="dot" aria-label="Unanswered"></span>{/if}{/snippet}
              </NavItem>
              <span class="row-action">
                <IconButton size="xs" icon={item.todo.done ? "refresh" : "check"} label={item.todo.done ? `Reopen ${item.todo.id}` : `${item.todo.from === "agent" ? "Dismiss" : "Done"} ${item.todo.id}`} onclick={() => markDone(item)} />
              </span>
            </li>
          {/each}
        </ul>
      {/if}
    </div>
  </div>
{/snippet}

{#snippet detail()}
  {#if selected}
    {@const item = selected}
    <section class="ask-detail" aria-label="Ask">
      <PanelHeader closeLabel="Close" onclose={close} divider>
        {#snippet titleContent()}<a class="detail-title t-label" href={conversationHref(item.chatId)}>{item.chatName}</a>{/snippet}
      </PanelHeader>
      <div class="detail-body">
        <div class="message">
          <Avatar name={item.chatName} kind={item.todo.from === "agent" ? "agent" : "person"} seed={item.chatId} size={32} />
          <div class="message-main">
            <div class="byline t-caption"><strong class="t-label-sm">{item.todo.from === "agent" ? item.chatName : "You"}</strong><span>{stampLabel(Date.parse(item.todo.at), now)}</span><IdChip id={item.todo.id} chatId={item.chatId} href={boardHref(item.chatId, item.todo.id)} /></div>
            <Bubble own={item.todo.from === "owner"}>
              {#key itemKey(item)}
                <AskCard chatId={item.chatId} ask={item.todo} titles={titlesFor(item)} onops={(ops) => apply(item, ops)} onboardid={boardId(item)} autofocusReply={!item.todo.choices?.length} />
              {/key}
            </Bubble>
          </div>
        </div>
        {#if item.step}
          <a class="step" href={boardHref(item.chatId, item.step.id)} data-board-id={item.step.id}>
            <PlanMark status={item.step.status as StepStatus} />
            <span class="step-text"><span class="t-caption step-meta">{item.step.id} · {STEP_LABEL[item.step.status as StepStatus]} · the step this ask is about</span><span class="t-body-sm">{item.step.text}</span></span>
          </a>
        {/if}
        <div class="detail-actions">
          <Button size="sm" variant="outline" icon="messages" href={conversationHref(item.chatId)}>Open chat</Button>
          <Button size="sm" variant="outline" icon="board" href={boardHref(item.chatId, item.todo.id)}>Open board</Button>
        </div>
      </div>
    </section>
  {:else if selectedKey && !forYou.loading}
    <section class="ask-detail" aria-label="Ask"><PanelHeader closeLabel="Close" onclose={close} divider title="For you" /><div class="detail-body"><EmptyState icon="inbox" title="This ask is gone" description="The chat removed it, or it moved to another chat." size="sm" /></div></section>
  {/if}
{/snippet}

<div class="page">
  <PanelHeader title="For you" icon="inbox" level={1} divider />
  <div class="split" bind:clientWidth={splitWidth}>
    {#if selectedKey && splitWidth > 0 && splitWidth < 700}
      {@render detail()}
    {:else}
      <SplitPane {list} detail={selectedKey ? detail : undefined} storageKey="board.forYouDetail" label="Resize the ask" />
    {/if}
  </div>
</div>

<style>
  .page { display: flex; flex-direction: column; height: 100%; min-height: 0; }
  .split { flex: 1; min-height: 0; display: flex; }
  .split > :global(*) { flex: 1; min-width: 0; }
  .list-pane { display: flex; flex-direction: column; min-width: 0; min-height: 0; height: 100%; }
  .toolbar { display: flex; flex: none; align-items: center; gap: var(--space-1); min-height: var(--size-panel-header); padding-inline: var(--space-1); border-bottom: 1px solid var(--border-standard); }
  .spacer { flex: 1; }
  .status { color: var(--text-subtle); padding-inline-end: var(--space-2); }
  .scroll { flex: 1; min-height: 0; overflow: auto; }
  .notice { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-3); padding: var(--space-3) var(--space-panel-inset); }
  .notice p { margin: 0; }
  .empty { padding: var(--space-page-section-gap) var(--space-panel-inset); }
  .rows { list-style: none; margin: 0; padding: var(--space-1) var(--space-1-5) var(--space-panel-inset); display: grid; gap: 2px; }
  .row { position: relative; min-width: 0; }
  .row :global(.nav-item) { align-items: flex-start; padding-block: 10px; }
  .row :global(.nav-item .text) { gap: var(--space-1); }
  .row.selected :global(.nav-item), .row.selected :global(.nav-item:hover) { background: var(--neutral-3); color: var(--text-standard); }
  .heading { display: flex; align-items: baseline; justify-content: space-between; gap: var(--space-2); min-width: 0; }
  .identity { display: flex; align-items: baseline; gap: var(--space-2); min-width: 0; flex: 1; }
  .sender { color: var(--text-standard); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
  .source { color: var(--text-subtle); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .date { color: var(--text-subtle); flex: none; }
  .row:hover .date, .row:focus-within .date { opacity: 0; }
  .preview { display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; overflow-wrap: anywhere; max-inline-size: 64ch; white-space: normal; color: var(--text-standard); }
  .preview.quiet { color: var(--text-subtle); }
  .dot { display: block; width: 8px; height: 8px; border-radius: 50%; background: var(--text-navigation-unread); margin-top: 6px; }
  .row-action { position: absolute; top: var(--space-1-5); right: var(--space-3); opacity: 0; }
  .row:hover .row-action, .row:focus-within .row-action { opacity: 1; }
  .ask-detail { display: flex; flex-direction: column; height: 100%; min-height: 0; min-width: 0; }
  .detail-title { color: var(--text-standard); text-decoration: none; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .detail-title:hover { text-decoration: underline; }
  .detail-body { flex: 1; overflow: auto; padding: var(--space-6) var(--space-4); display: grid; gap: var(--space-4); align-content: start; }
  .message { display: grid; grid-template-columns: 32px minmax(0, 1fr); gap: var(--space-2); align-items: end; }
  .message-main { display: grid; gap: var(--space-1); min-width: 0; justify-items: start; width: 100%; }
  .byline { display: flex; align-items: center; gap: var(--space-2); color: var(--text-metadata); min-width: 0; max-width: 100%; white-space: nowrap; }
  .byline strong { overflow: hidden; text-overflow: ellipsis; min-width: 0; }
  .byline > span { flex: none; }
  .byline strong { color: var(--text-standard); }
  .step { display: flex; gap: var(--space-3); align-items: center; padding: var(--space-3); border: 1px solid var(--border-standard); border-radius: var(--radius-container); color: inherit; text-decoration: none; margin-inline-start: 40px; }
  .step:hover { background: var(--surface-inset); }
  .step-text { display: grid; gap: 2px; min-width: 0; }
  .step-meta { color: var(--text-subtle); }
  .detail-actions { display: flex; gap: var(--space-2); margin-inline-start: 40px; }
</style>
