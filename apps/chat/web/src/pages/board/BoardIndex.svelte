<script lang="ts">
  import { onDestroy } from "svelte";
  import { Avatar, Badge, Button, EmptyState, Icon, IdChip, LoadingText, Meter, PanelHeader, timeLabel } from "$lib/ui";
  import { boards } from "./boards.svelte";
  import { boardHref, forYouHref } from "./chips";
  import { WHEN_LABEL, whenGroup, type When } from "./schedule";

  boards.start();
  const rows = $derived(boards.rows);
  const error = $derived(boards.error);
  let now = $state(Date.now());
  const clock = setInterval(() => { now = Date.now(); }, 30_000);
  onDestroy(() => clearInterval(clock));

  interface Due { key: string; chatId: string; chatName: string; at: number; kind: "checkin" | "duty"; id?: string; name: string; verdict?: string | null }
  const dues = $derived.by(() => {
    const list: Due[] = [];
    for (const row of rows ?? []) {
      if (row.checkIn && !row.checkIn.paused && row.checkIn.nextAt !== null) list.push({ key: `${row.chatId}/checkin`, chatId: row.chatId, chatName: row.chatName, at: row.checkIn.nextAt, kind: "checkin", name: "Check-in" });
      for (const duty of row.duties) if (duty.nextAt !== null) list.push({ key: `${row.chatId}/${duty.id}`, chatId: row.chatId, chatName: row.chatName, at: duty.nextAt, kind: "duty", id: duty.id, name: duty.name, verdict: duty.lastVerdict });
    }
    return list.sort((left, right) => left.at - right.at);
  });
  const groups = $derived((["overdue", "today", "upcoming"] as When[]).map(when => ({ when, items: dues.filter(due => whenGroup(due.at, now) === when) })).filter(group => group.items.length));
  const dueWords = (at: number) => {
    const day = (ms: number) => { const date = new Date(ms); date.setHours(0, 0, 0, 0); return date.getTime(); };
    const days = Math.round((day(at) - day(now)) / 86_400_000);
    if (days === 0) return `Due at ${timeLabel(at)}`;
    if (days === 1) return `Due tomorrow at ${timeLabel(at)}`;
    if (days === -1) return `Due at ${timeLabel(at)} yesterday`;
    return `Due ${new Date(at).toLocaleDateString("en-US", { month: "short", day: "numeric" })} at ${timeLabel(at)}`;
  };
  const totals = $derived((rows ?? []).reduce((sum, row) => ({ asks: sum.asks + row.openAsks, go: sum.go + row.needsGo }), { asks: 0, go: 0 }));
</script>

<div class="page">
  <PanelHeader title="All boards" icon="board" level={1} divider>
    {#snippet actions()}
      <Button size="sm" variant="ghost" icon="inbox" href={forYouHref()}>For you{totals.asks ? ` ${totals.asks}` : ""}</Button>
    {/snippet}
  </PanelHeader>
  <div class="scroll">
    <div class="sections">
      {#if error && !rows}
        <div class="notice" role="alert"><p class="t-body">{error}</p><Button size="sm" onclick={() => boards.load()}>Retry boards</Button></div>
      {:else if !rows}
        <LoadingText text="Loading boards…" />
      {:else if !rows.length}
        <EmptyState icon="board" title="No boards yet" description="A chat's plan, its asks for you, its duties and its check-in show here once it writes them." />
      {:else}
        <section class="group" aria-label="Plans">
          <h2 class="heading t-label">Plans <span class="count">{rows.length}</span></h2>
          <ul class="list">
            {#each rows as row (row.chatId)}
              <li class="row">
                <a class="plan" href={boardHref(row.chatId)} data-chat={row.chatId}>
                  <Avatar name={row.chatName} kind="agent" seed={row.chatId} size={28} />
                  <span class="plan-main">
                    <span class="name t-body-sm">{row.chatName}</span>
                    <span class="meter"><Meter percent={row.progress.total ? (100 * row.progress.done) / row.progress.total : 0} compact warn={101} danger={101} label="{row.progress.done} of {row.progress.total} done" /></span>
                  </span>
                  <span class="badges">
                    {#if row.openAsks}<Badge value={`${row.openAsks} for you`} tone="accent" />{/if}
                    {#if row.needsGo}<Badge value={`${row.needsGo} need your go`} tone="strong" />{/if}
                  </span>
                </a>
              </li>
            {/each}
          </ul>
        </section>

        {#each groups as group (group.when)}
          <section class="group" aria-label={WHEN_LABEL[group.when]}>
            <h2 class="heading t-label">{WHEN_LABEL[group.when]} <span class="count">{group.items.length}</span></h2>
            <ul class="list">
              {#each group.items as due (due.key)}
                <li class="row">
                  <div class="due-row">
                    <span class="lead" aria-hidden="true"><Icon name={due.kind === "checkin" ? "clock" : "refresh"} size={16} /></span>
                    <a class="due-main" href={boardHref(due.chatId, due.id)}>
                      <span class="t-body-sm due-name">{due.name}{#if due.verdict}<span class="verdict">· last run {due.verdict === "missed" ? "off target" : due.verdict}</span>{/if}</span>
                      <span class="t-caption chat">{due.chatName}</span>
                    </a>
                    {#if due.id}<IdChip id={due.id} chatId={due.chatId} href={boardHref(due.chatId, due.id)} />{/if}
                    <span class="due t-caption" class:overdue={group.when === "overdue"}>{dueWords(due.at)}</span>
                    <Avatar name={due.chatName} kind="agent" seed={due.chatId} size={20} />
                  </div>
                </li>
              {/each}
            </ul>
          </section>
        {/each}
      {/if}
    </div>
  </div>
</div>

<style>
  .page { display: flex; flex-direction: column; height: 100%; min-height: 0; }
  .scroll { flex: 1; min-height: 0; overflow-y: auto; }
  .sections { display: flex; flex-direction: column; gap: var(--space-6); max-width: 45rem; margin-inline: auto; padding: var(--space-6) var(--space-panel-inset); container-type: inline-size; }
  .notice { display: flex; align-items: center; gap: var(--space-3); }
  .notice p { margin: 0; }
  .group { display: flex; flex-direction: column; gap: var(--space-1); }
  .heading { display: inline-flex; align-items: baseline; gap: var(--space-2); margin: 0; color: var(--text-standard); }
  .count { opacity: 0.5; font-weight: 400; }
  .list { list-style: none; margin: 0; padding: 0; }
  .row { border-bottom: 1px solid var(--border-standard); }
  .row:last-child { border-bottom: 0; }
  .plan { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: var(--space-3); padding: var(--space-2) var(--space-1); color: inherit; text-decoration: none; border-radius: var(--radius-row); }
  .plan:hover, .due-main:hover .due-name { color: var(--text-standard); }
  .plan:hover { background: var(--surface-inset); }
  .plan-main { display: grid; gap: var(--space-1); min-width: 0; }
  .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-standard); }
  .meter { max-width: 20rem; }
  .chat { color: var(--text-subtle); white-space: nowrap; }
  .badges { display: flex; gap: var(--space-1); }
  .due-row { display: grid; grid-template-columns: auto minmax(0, 1fr) auto auto auto; align-items: center; gap: var(--space-2); padding-block: var(--space-2); }
  .lead { display: grid; place-items: center; width: 28px; color: var(--text-subtle); }
  .due-main { display: grid; min-width: 0; color: inherit; text-decoration: none; }
  .due-name { color: var(--text-standard); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .verdict { color: var(--text-subtle); margin-inline-start: 0.3em; }
  .due { color: var(--text-subtle); white-space: nowrap; padding: 2px 10px; }
  .due.overdue { color: var(--text-danger); font-weight: 500; border: 1px dashed var(--border-danger); border-radius: var(--radius-pill); }
  @container (max-width: 30rem) {
    .plan { grid-template-columns: auto minmax(0, 1fr); }
    .badges { grid-column: 2; }
  }
</style>
