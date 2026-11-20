<script lang="ts">
  import { onDestroy } from "svelte";
  import type { LaterRow, LaterState } from "$lib/api";
  import { later, laterHref } from "$lib/later.svelte";
  import { conversationHref, router } from "$lib/router.svelte";
  import { Avatar, Button, EmptyState, Icon, IconButton, LoadingText, PanelHeader, Tabs, stampLabel } from "$lib/ui";
  import { previewText } from "$pages/agents/agents-model";
  import { avatarOf } from "$pages/channel/present";
  import { api } from "$lib/api";
  import Menu from "$lib/ui/Menu.svelte";
  import RemindDialog from "$lib/RemindDialog.svelte";
  import { dueFirst, dueLabel, isOverdue, remindedText, remindMenu } from "$lib/remind";
  import { askNotifyPermission } from "$lib/remind-notify";
  import { toast } from "$lib/ui/toast.svelte";

  later.start();
  let now = $state(Date.now());
  const clock = setInterval(() => (now = Date.now()), 30_000);
  onDestroy(() => clearInterval(clock));
  /** A reminder that fires writes the list, so the clock moves with each new list and the row turns Overdue at once. */
  $effect(() => {
    if (later.lists.open) now = Date.now();
  });

  /** `#/c/later` is In progress and `#/c/later/done` Completed, so back and a link keep the tab. */
  const tab = $derived<LaterState>(router.route.rest[1] === "done" ? "done" : "open");
  const rows = $derived(tab === "open" && later.lists.open ? dueFirst(later.lists.open, now) : later.lists[tab]);
  /** In progress pins the posts he marked unread on top, as their own Keep unread stack, until he handles each one (server/keep-unread.ts). */
  const stacks = $derived.by(() => {
    if (!rows) return [];
    if (tab !== "open") return [{ id: "all", label: null, rows }];
    const kept = rows.filter((r) => r.unread);
    if (!kept.length) return [{ id: "all", label: null, rows }];
    const saved = rows.filter((r) => !r.unread);
    return [{ id: "unread", label: "Keep unread", rows: kept }, ...(saved.length ? [{ id: "saved", label: "Saved", rows: saved }] : [])];
  });
  const tabs = $derived([
    { id: "open" as const, label: "In progress", badge: later.open || null },
    { id: "done" as const, label: "Completed" },
  ]);
  /** A saved reply opens its thread at the reply, and any other post its room at the post. */
  const hrefOf = (row: LaterRow) => conversationHref(row.room, row.threadRoot ? { thread: row.threadRoot, messageId: row.post } : { messageId: row.post });
  /** The row whose Remind me menu is open, and the button it hangs from; the row whose Custom picker is open. */
  let remindOpen = $state(false);
  let remindRow = $state<LaterRow | null>(null);
  let remindAnchor = $state<HTMLElement | null>(null);
  let customRow = $state<LaterRow | null>(null);
  const remindItems = $derived(remindRow ? remindMenu({ remindAt: remindRow.remindAt, set: (at) => remindRow && remind(remindRow, at), custom: () => (customRow = remindRow), clear: () => remindRow && remind(remindRow, null) }).items : []);

  function openRemind(row: LaterRow, e: MouseEvent) {
    remindRow = row;
    remindAnchor = e.currentTarget as HTMLElement;
    remindOpen = true;
  }

  /** Sets, snoozes or clears a row's reminder; the live later event re-reads the list. */
  async function remind(row: LaterRow, at: number | null) {
    try {
      if (at !== null) void askNotifyPermission();
      await api.patchLater(row.id, { remindAt: at });
      toast.show(at === null ? "Reminder removed" : remindedText(at));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not change the reminder");
    }
  }
  const roomIcon = (row: LaterRow) => (row.roomKind === "dm" ? "user" : row.roomKind === "solo" ? "chat" : null);
</script>

<div class="page" data-testid="later-page">
  <PanelHeader title="Later" icon="bookmark" level={1} />
  <div class="tabs">
    <Tabs items={tabs} value={tab} variant="underline" size="sm" label="Later" onchange={(id: LaterState) => router.navigate(laterHref(id === "done"), { replace: true })} />
  </div>
  <div class="scroll">
    {#if later.error && !rows}
      <div class="notice" role="alert"><p class="t-body">{later.error}</p><Button size="sm" onclick={() => later.refresh()}>Try again</Button></div>
    {:else if !rows}
      <div class="notice"><LoadingText text="Loading Later…" /></div>
    {:else if !rows.length}
      <div class="empty" role="status">
        {#if tab === "open"}
          <EmptyState icon="bookmark" title="Nothing saved for later" description="Hover over a message and click the bookmark to save it here. Check it off once you are done with it." />
        {:else}
          <EmptyState icon="check" title="Nothing completed yet" description="Items you mark complete move here." />
        {/if}
      </div>
    {:else}
      <ul class="rows" aria-label={tab === "open" ? "In progress" : "Completed"}>
        {#each stacks as stack (stack.id)}
          {#if stack.label}<li class="stack t-caption" role="presentation" data-later-stack={stack.id}>{stack.label}</li>{/if}
          {#each stack.rows as row (row.id)}
            {@const overdue = isOverdue(row, now)}
            <li class="row" class:overdue data-later-id={row.id} data-overdue={overdue || undefined}>
              <a class="open" href={hrefOf(row)} data-later-open>
                <span class="avatar">
                  {#if row.author}<Avatar {...avatarOf(row.author)} seed={row.author.id} size={36} />{:else}<span class="no-author"><Icon name="trash" size={16} /></span>{/if}
                </span>
                <span class="main">
                  <span class="where t-caption">
                    {#if roomIcon(row)}<Icon name={roomIcon(row)!} size={12} />{/if}
                    <span class="room">{row.roomName}</span>
                    {#if row.threadRoot}<span aria-hidden="true">·</span><span>Thread</span>{/if}
                  </span>
                  <span class="heading">
                    <strong class="author t-label-sm">{row.author?.name ?? "Deleted message"}</strong>
                    <time class="t-caption" datetime={new Date(row.at).toISOString()} title={stampLabel(row.at, now)}>{stampLabel(row.at, now)}</time>
                  </span>
                  {#if row.state === "open" && row.remindAt !== undefined}
                    <span class="due t-caption" class:overdue data-later-due><Icon name="clock" size={12} />{dueLabel(row.remindAt, now).text}</span>
                  {/if}
                  {#if row.gone}
                    <span class="preview t-body gone">This message was deleted.</span>
                  {:else}
                    <span class="preview t-body">{previewText(row.text) || (row.images ? `${row.images} image${row.images === 1 ? "" : "s"}` : "")}</span>
                  {/if}
                </span>
              </a>
              <span class="row-actions">
                {#if row.state === "open"}
                  <IconButton size="sm" icon="check" label="Mark complete" onclick={() => later.setState(row, "done")} data-later-done />
                  <IconButton size="sm" icon="clock" label={overdue ? "Snooze" : row.remindAt !== undefined ? "Change reminder" : "Remind me"} aria-haspopup="menu" onclick={(e: MouseEvent) => openRemind(row, e)} data-later-remind />
                {:else}
                  <IconButton size="sm" icon="refresh" label="Move to In progress" onclick={() => later.setState(row, "open")} data-later-reopen />
                {/if}
                <IconButton size="sm" icon="bookmark-filled" label="Remove from Later" onclick={() => later.remove(row)} data-later-remove />
              </span>
            </li>
          {/each}
        {/each}
      </ul>
    {/if}
  </div>
</div>
{#if remindOpen}<Menu bind:open={remindOpen} anchor={remindAnchor} items={remindItems} placement="bottom-end" label={remindRow && isOverdue(remindRow, now) ? "Snooze" : "Remind me"} />{/if}
{#if customRow}<RemindDialog title="Remind me" at={customRow.remindAt} onpick={(at) => (customRow ? remind(customRow, at) : undefined)} onclose={() => (customRow = null)} />{/if}

<style>
  .page { display: flex; flex-direction: column; height: 100%; min-height: 0; }
  .tabs { flex: none; padding-inline: var(--space-panel-inset); border-bottom: 1px solid var(--border-standard); }
  .scroll { flex: 1; min-height: 0; overflow: auto; }
  .notice { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-3); padding: var(--space-3) var(--space-panel-inset); }
  .notice p { margin: 0; }
  .empty { display: grid; place-items: center; min-height: 60%; padding: var(--space-page-section-gap) var(--space-panel-inset); }
  .rows { list-style: none; margin: 0; padding: var(--space-1) var(--space-1-5) var(--space-panel-inset); display: grid; gap: 2px; }
  .stack { padding: var(--space-3) var(--space-3) var(--space-1); color: var(--text-subtle); font-weight: 600; }
  .row { position: relative; min-width: 0; border-radius: var(--radius-row); }
  .row:hover, .row:focus-within { background: var(--neutral-3); }
  .open { display: grid; grid-template-columns: 36px minmax(0, 1fr); gap: var(--space-3); padding: 10px var(--space-3); color: inherit; text-decoration: none; border-radius: inherit; }
  .avatar { padding-top: 2px; }
  .no-author { display: grid; place-items: center; width: 36px; height: 36px; border-radius: 10px; background: var(--neutral-3); color: var(--text-subtle); }
  .main { display: grid; gap: 2px; min-width: 0; }
  .where { display: flex; align-items: center; gap: 4px; color: var(--text-subtle); min-width: 0; white-space: nowrap; }
  .room { overflow: hidden; text-overflow: ellipsis; font-weight: 600; }
  .heading { display: flex; align-items: baseline; gap: var(--space-2); min-width: 0; }
  .author { color: var(--text-standard); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .heading time { color: var(--text-metadata); flex: none; }
  .preview { display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; overflow-wrap: anywhere; max-inline-size: 72ch; white-space: pre-line; color: var(--text-standard); }
  .preview.gone { color: var(--text-subtle); font-style: italic; }
  .due { display: flex; align-items: center; gap: 4px; color: var(--text-metadata); }
  .due.overdue { color: var(--text-danger); font-weight: 600; }
  .row-actions { position: absolute; top: 8px; right: var(--space-3); display: flex; gap: 2px; padding: 2px; border-radius: 8px; background: var(--surface-panel); box-shadow: var(--shadow-float); opacity: 0; }
  .row:hover .row-actions, .row:focus-within .row-actions { opacity: 1; }
</style>
