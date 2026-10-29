<script lang="ts">
  import { onDestroy } from "svelte";
  import { api, boardStore, live, type BoardOp, type ChatAgent, type CheckInView, type DutyRow } from "$lib/api";
  import { Button, EmptyState, LoadingText } from "$lib/ui";
  import AskCard from "./AskCard.svelte";
  import PlanTree from "./PlanTree.svelte";
  import DutyList from "./DutyList.svelte";
  import CheckInControl from "./CheckInControl.svelte";
  import { boardTitles, rememberTitles } from "./chips";
  import { groupAsks } from "./model";
  import { dutiesCount } from "./schedule";

  /**
   * One chat's board: its asks for the owner, the plan by status, its duties and its check-in.
   * `where` is "panel" in the channel view's 420 px side pane and "page" on #/board/<chatId>, which adds step notes and requirement lines.
   */
  let {
    chatId,
    where = "panel",
    focus = null,
    onboardid,
  }: { chatId: string; where?: "panel" | "page"; focus?: string | null; onboardid?: (id: string) => void } = $props();

  const store = $derived(boardStore(chatId));
  $effect(() => {
    const current = store;
    return () => current.close();
  });

  let duties = $state<DutyRow[]>([]);
  let checkIn = $state<CheckInView | null>(null);
  let agents = $state<ChatAgent[]>([]);
  let doneOpen = $state(false);
  let now = $state(Date.now());
  const clock = setInterval(() => { now = Date.now(); }, 30_000);
  onDestroy(() => clearInterval(clock));

  $effect(() => {
    const id = chatId;
    duties = [];
    checkIn = null;
    agents = [];
    void api.duties(id).then(body => { if (id === chatId) duties = body.duties; }).catch(() => {});
    void api.checkIn(id).then(view => { if (id === chatId) checkIn = view; }).catch(() => {});
    void api.chatAgents(id).then(body => { if (id === chatId) agents = body.agents; }).catch(() => {});
    // A run that starts or ends while the card is open, or a socket that comes back after missing one, replaces the rows.
    return live.on(event => {
      if (event.type === "duties" && event.chatId === id) duties = event.duties;
      if (event.type === "hello") void api.duties(id).then(body => { if (id === chatId) duties = body.duties; }).catch(() => {});
    });
  });

  const board = $derived(store.view?.board ?? null);
  const awaitingGo = $derived(new Set(store.view?.awaitingGo ?? []));
  const asks = $derived(groupAsks(board?.todos ?? []));
  const titles = $derived(boardTitles(board, duties.map(duty => duty.duty)));
  $effect(() => rememberTitles(chatId, titles));
  $effect(() => {
    if (focus && board?.todos.some(todo => todo.id === focus && todo.done)) doneOpen = true;
  });

  const apply = (ops: BoardOp[]) => store.apply(ops);
  const empty = $derived(!board || (!board.plan.length && !board.todos.length));
</script>

<div class="board" data-where={where} data-chat={chatId}>
  {#if store.loading && !store.view}
    <div class="state"><LoadingText text="Loading board…" /></div>
  {:else if store.error && !store.view}
    <div class="state" role="alert">
      <p class="t-body">{store.error}</p>
      <Button size="sm" onclick={() => store.refresh()}>Retry board</Button>
    </div>
  {:else}
    {#if empty}
      <EmptyState icon="board" title="No plan yet" description="The chat writes its plan and its asks for you here as it works." size="sm" />
    {/if}

    {#if board && board.todos.length}
      <section class="group" aria-label="For you">
        <h3 class="heading t-label-sm">For you <span class="count">{asks.open.length}</span></h3>
        {#if asks.open.length}
          <ul class="asks">
            {#each asks.open as ask (ask.id)}
              <li class="ask-row" class:focused={focus === ask.id}><AskCard {chatId} {ask} {titles} onops={apply} {onboardid} /></li>
            {/each}
          </ul>
        {:else}
          <p class="none t-body-sm">Nothing waiting on you.</p>
        {/if}
        {#if asks.done.length}
          <button type="button" class="fold t-caption" aria-expanded={doneOpen} onclick={() => { doneOpen = !doneOpen; }}>{doneOpen ? "Hide done" : `Done (${asks.done.length})`}</button>
          {#if doneOpen}
            <ul class="asks">
              {#each asks.done as ask (ask.id)}
                <li class="ask-row" class:focused={focus === ask.id}><AskCard {chatId} {ask} {titles} onops={apply} {onboardid} /></li>
              {/each}
            </ul>
          {/if}
        {/if}
      </section>
    {/if}

    {#if board && board.plan.length}
      <section class="group" aria-label="Plan">
        <PlanTree {chatId} plan={board.plan} {awaitingGo} {agents} {where} {focus} {onboardid} />
      </section>
    {/if}

    {#if duties.length}
      <section class="group" aria-label="Duties">
        <h3 class="heading t-label-sm">Duties <span class="count">{dutiesCount(duties)}</span></h3>
        <DutyList {chatId} bind:duties {now} {focus} />
      </section>
    {/if}

    <section class="group" aria-label="Check-in">
      <h3 class="heading t-label-sm">Check-in</h3>
      <CheckInControl {chatId} bind:view={checkIn} {now} />
    </section>
  {/if}
</div>

<style>
  .board { display: grid; gap: var(--space-6); align-content: start; padding: var(--space-6); container-type: inline-size; min-width: 0; }
  .board[data-where="page"] { max-width: 45rem; margin-inline: auto; width: 100%; box-sizing: border-box; }
  @container (max-width: 30rem) { .board { padding: var(--space-4); } }
  .state { display: grid; justify-items: start; gap: var(--space-3); }
  .group { display: grid; gap: var(--space-1); min-width: 0; }
  .heading { display: flex; align-items: baseline; gap: var(--space-2); margin: 0 0 var(--space-1); color: var(--text-standard); }
  .count { opacity: 0.5; }
  .asks { list-style: none; margin: 0; padding: 0; }
  .ask-row { padding-block: var(--space-3); border-bottom: 1px solid var(--border-standard); }
  .ask-row:first-child { padding-block-start: var(--space-1); }
  .ask-row:last-child { border-bottom: 0; }
  .ask-row.focused { background: var(--affordance-sidebar-hover); border-radius: var(--radius-row); padding-inline: var(--space-2); }
  .none { margin: 0; color: var(--text-subtle); }
  .fold { justify-self: start; border: 0; background: none; padding: var(--space-1) 0; color: var(--text-subtle); cursor: pointer; font: inherit; }
  .fold:hover { color: var(--text-standard); }
</style>
