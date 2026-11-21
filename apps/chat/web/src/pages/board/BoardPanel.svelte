<script lang="ts">
  import { onDestroy } from "svelte";
  import { boardStore, reads, view, type BoardOp } from "$lib/api";
  import { Button, EmptyState, Icon, LoadingText } from "$lib/ui";
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

  /** Each shows from the page's kept answer and reads again behind it; the socket's duties events keep the rows current. */
  const dutyRows = view(() => reads.duties(chatId));
  const checkIn = view(() => reads.checkIn(chatId));
  const jobs = view(() => reads.chatAgents(chatId));
  const duties = $derived(dutyRows.value?.duties ?? []);
  const agents = $derived(jobs.value?.agents ?? []);
  let doneOpen = $state(false);
  let now = $state(Date.now());
  const clock = setInterval(() => { now = Date.now(); }, 30_000);
  onDestroy(() => clearInterval(clock));

  const board = $derived(store.view?.board ?? null);
  const awaitingGo = $derived(new Set(store.view?.awaitingGo ?? []));
  const asks = $derived(groupAsks(board?.todos ?? []));
  const titles = $derived(boardTitles(board, duties.map(duty => duty.duty)));
  $effect(() => rememberTitles(chatId, titles));
  $effect(() => {
    if (focus && board?.todos.some(todo => todo.id === focus && todo.done)) doneOpen = true;
  });

  const apply = (ops: BoardOp[]) => store.apply(ops);
  let draft = $state<{ parent: string | null } | null>(null);
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
      {#if !draft}
        <EmptyState icon="board" title="No plan yet" description="The chat writes its plan and its asks for you here as it works, and you can add a step too." size="sm">
          {#snippet action()}<Button size="sm" icon="plus" onclick={() => { draft = { parent: null }; }}>Add a step</Button>{/snippet}
        </EmptyState>
      {/if}
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
          <button type="button" class="fold t-caption" aria-expanded={doneOpen} onclick={() => { doneOpen = !doneOpen; }}><Icon name={doneOpen ? "chevron-down" : "chevron-right"} size={14} />Done <span class="count">{asks.done.length}</span></button>
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

    {#if board?.plan.length || draft}
      <section class="group" aria-label="Plan">
        <PlanTree {chatId} plan={board?.plan ?? []} {awaitingGo} {agents} {where} {focus} {onboardid} onops={apply} bind:draft />
      </section>
    {/if}

    {#if duties.length}
      <section class="group" aria-label="Duties">
        <h3 class="heading t-label-sm">Duties <span class="count">{dutiesCount(duties)}</span></h3>
        <DutyList {chatId} {duties} onchange={next => dutyRows.set({ duties: next })} {now} {focus} />
      </section>
    {/if}

    <section class="group" aria-label="Check-in">
      <h3 class="heading t-label-sm">Check-in</h3>
      <CheckInControl {chatId} view={checkIn.value} onchange={checkIn.set} {now} />
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
  .fold { justify-self: start; display: inline-flex; align-items: center; gap: var(--space-1); border: 0; background: none; padding: var(--space-1) 0; color: var(--text-subtle); cursor: pointer; font: inherit; }
  .fold:hover { color: var(--text-standard); }
</style>
