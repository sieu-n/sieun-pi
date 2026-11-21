<script lang="ts">
  import { onDestroy, tick } from "svelte";
  import { markUnread, type LaterRow, type LaterState } from "$lib/api";
  import { later, laterHref } from "$lib/later.svelte";
  import { conversationHref, router } from "$lib/router.svelte";
  import { Avatar, Button, EmptyState, Icon, IconButton, LoadingText, PanelHeader, Tabs, stampLabel } from "$lib/ui";
  import { previewText } from "$pages/agents/agents-model";
  import { avatarOf } from "$pages/channel/present";
  import Menu from "$lib/ui/Menu.svelte";
  import type { Anchor } from "$lib/ui/floating";
  import { isMac } from "$lib/ui/keyboard";
  import type { MenuEntry } from "$lib/ui/menu";
  import { toast } from "$lib/ui/toast.svelte";
  import RemindDialog from "$lib/RemindDialog.svelte";
  import { dueFirst, dueLabel, isOverdue, remindMenu } from "$lib/remind";

  later.start();
  let now = $state(Date.now());
  const clock = setInterval(() => (now = Date.now()), 30_000);
  onDestroy(() => clearInterval(clock));
  /** A reminder that fires writes the list, so the clock moves with each new list and the row turns Overdue at once. */
  $effect(() => {
    if (later.lists.open) now = Date.now();
  });
  /** `?test=1` shows a walk's test-room posts too (lib/later.svelte.ts `refresh`), so the lists are read again when it comes or goes. */
  const test = $derived(router.route.params.test === "1");
  $effect(() => {
    if (test !== later.withTest) void later.refresh();
  });

  /** `#/c/later` is In progress, `#/c/later/archived` Archived and `#/c/later/done` Completed, so back and a link keep the tab. */
  const tab = $derived<LaterState>(router.route.rest[1] === "done" ? "done" : router.route.rest[1] === "archived" ? "archived" : "open");
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
  /** Slack's three Later tabs, in its order. */
  const tabs = $derived([
    { id: "open" as const, label: "In progress", badge: later.open || null },
    { id: "archived" as const, label: "Archived" },
    { id: "done" as const, label: "Completed" },
  ]);
  const tabLabel: Record<LaterState, string> = { open: "In progress", archived: "Archived", done: "Completed" };
  const showTab = (id: LaterState) => router.navigate(`${laterHref(id)}${test ? "?test=1" : ""}`, { replace: true });
  /** A saved reply opens its thread at the reply, and any other post its room at the post. */
  const hrefOf = (row: LaterRow) => conversationHref(row.room, row.threadRoot ? { thread: row.threadRoot, messageId: row.post } : { messageId: row.post });
  /** A room that is gone keeps only its id as its name, and has nothing to open. */
  const roomHref = (row: LaterRow) => (row.roomName === row.room ? null : conversationHref(row.room));
  /** The row whose Remind me menu is open, and the button it hangs from; the row whose Custom picker is open. */
  let remindOpen = $state(false);
  let remindRow = $state<LaterRow | null>(null);
  let remindAnchor = $state<HTMLElement | null>(null);
  let customRow = $state<LaterRow | null>(null);
  const remindItems = $derived(remindRow ? remindMenu({ remindAt: remindRow.remindAt, kept: !!remindRow.unread, set: (at) => remindRow && later.remind(remindRow, at), custom: () => (customRow = remindRow), clear: () => remindRow && later.remind(remindRow, null) }).items : []);

  function openRemind(row: LaterRow, anchor: HTMLElement) {
    remindRow = row;
    remindAnchor = anchor;
    remindOpen = true;
  }
  const roomIcon = (row: LaterRow) => (row.roomKind === "dm" ? "user" : row.roomKind === "solo" ? "chat" : null);

  /**
   * The keyboard path, as Slack's Later list has it: the list is one tab stop, the arrow keys, Home and End move between rows, Enter opens
   * the focused one, and the letters of its More actions menu act on it. `focusId` is the row that takes the tab stop.
   */
  let list = $state<HTMLUListElement>();
  let focusId = $state<string | null>(null);
  const tabStop = $derived(rows?.some((r) => r.id === focusId) ? focusId : (stacks[0]?.rows[0]?.id ?? null));
  const links = (): HTMLAnchorElement[] => (list ? [...list.querySelectorAll<HTMLAnchorElement>("a[data-later-open]")] : []);
  const rowOf = (el: Element | null): LaterRow | undefined => {
    const id = el?.closest<HTMLElement>("[data-later-id]")?.dataset.laterId;
    return rows?.find((r) => r.id === id);
  };

  /** After a row leaves the tab from the keyboard or its menu, the row that took its place takes focus, so the next key acts on it. */
  async function refocus(at: number) {
    await tick();
    const all = links();
    const next = all[Math.min(at, all.length - 1)];
    if (next) {
      focusId = rowOf(next)?.id ?? null;
      next.focus();
    }
  }
  function leave(row: LaterRow, run: () => unknown) {
    const at = links().findIndex((a) => rowOf(a)?.id === row.id);
    const kept = !!list?.contains(document.activeElement) || menuOpen;
    void run();
    if (kept && at >= 0) void refocus(at);
  }

  const archive = (row: LaterRow) => leave(row, () => later.setState(row, row.state === "archived" ? "open" : "archived"));
  const complete = (row: LaterRow) => leave(row, () => later.setState(row, row.state === "done" ? "open" : "done"));
  const remove = (row: LaterRow) => leave(row, () => later.remove(row));
  function unread(row: LaterRow) {
    markUnread(row.room, row.post, row.threadRoot).then(
      () => toast.show("Marked as unread. It stays in Later until you reply, react or check it off."),
      () => toast.error("Could not mark the message unread"),
    );
  }
  function copyLink(row: LaterRow) {
    void navigator.clipboard.writeText(`${location.origin}${location.pathname}${hrefOf(row)}`).then(
      () => toast.show("Link copied"),
      () => toast.error("Could not copy the link"),
    );
  }

  /** Slack's More actions on a Later item: open it, move it between tabs, remind, mark unread, copy its link, or take it out of Later. */
  function rowMenu(row: LaterRow): MenuEntry[] {
    const room = roomHref(row);
    return [
      { id: "open", label: row.threadRoot ? "Open in thread" : "Open message", icon: row.threadRoot ? "thread" : "external", shortcut: "Enter", onselect: () => router.navigate(hrefOf(row)) },
      ...(room ? [{ id: "room", label: `Go to ${row.roomName}`, icon: row.roomKind === "channel" ? "hash" : (roomIcon(row) ?? "chat"), onselect: () => router.navigate(room) }] : []),
      { type: "separator" },
      row.state === "done"
        ? { id: "complete", label: "Move to In progress", icon: "refresh", shortcut: "C", onselect: () => complete(row) }
        : { id: "complete", label: "Mark complete", icon: "check", shortcut: "C", onselect: () => complete(row) },
      row.state === "archived"
        ? { id: "archive", label: "Move to In progress", icon: "unarchive", shortcut: "E", onselect: () => archive(row) }
        : { id: "archive", label: "Archive", icon: "archive", shortcut: "E", onselect: () => archive(row) },
      ...(row.state === "open" ? [{ ...remindMenu({ label: "Remind me", remindAt: row.remindAt, kept: !!row.unread, set: (at) => later.remind(row, at), custom: () => (customRow = row), clear: () => later.remind(row, null) }), detail: "M" }] : []),
      ...(row.gone ? [] : [
        { id: "unread", label: "Mark unread", icon: "dot", shortcut: "U", onselect: () => unread(row) },
        { id: "link", label: "Copy link", icon: "link", shortcut: "L", onselect: () => copyLink(row) },
      ]),
      { type: "separator" },
      { id: "remove", label: "Remove from Later", icon: "bookmark-filled", shortcut: isMac ? "⌫" : "Del", tone: "danger", onselect: () => remove(row) },
    ];
  }
  let menuOpen = $state(false);
  let menuRow = $state<LaterRow | null>(null);
  let menuAnchor = $state<Anchor | null>(null);
  const menuItems = $derived(menuRow ? rowMenu(menuRow) : []);
  function openMenu(row: LaterRow, anchor: Anchor) {
    menuRow = row;
    menuAnchor = anchor;
    menuOpen = true;
  }

  function onkeydown(e: KeyboardEvent) {
    const link = e.target instanceof HTMLAnchorElement && e.target.matches("a[data-later-open]") ? e.target : null;
    const row = link ? rowOf(link) : undefined;
    if (!link || !row || e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return;
    const all = links();
    const at = all.indexOf(link);
    const move = e.key === "ArrowDown" ? at + 1 : e.key === "ArrowUp" ? at - 1 : e.key === "Home" ? 0 : e.key === "End" ? all.length - 1 : null;
    if (move !== null) {
      const next = all[move];
      if (!next) return;
      e.preventDefault();
      focusId = rowOf(next)?.id ?? null;
      next.focus();
      next.scrollIntoView({ block: "nearest" });
      return;
    }
    const key = e.key.toLowerCase();
    const act: Record<string, () => void> = {
      c: () => complete(row),
      e: () => archive(row),
      u: () => !row.gone && unread(row),
      l: () => !row.gone && copyLink(row),
      m: () => row.state === "open" && openRemind(row, link.closest("li")?.querySelector<HTMLElement>("[data-later-remind]") ?? link),
      delete: () => remove(row),
      backspace: () => remove(row),
      contextmenu: () => openMenu(row, link),
    };
    const run = e.key === "F10" && e.shiftKey ? act.contextmenu : e.shiftKey ? undefined : act[key];
    if (!run) return;
    e.preventDefault();
    run();
  }
</script>

<div class="page" data-testid="later-page">
  <PanelHeader title="Later" icon="bookmark" level={1} />
  <div class="tabs">
    <Tabs items={tabs} value={tab} variant="underline" size="sm" label="Later" onchange={(id: LaterState) => showTab(id)} />
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
          <EmptyState
            icon={tab === "archived" ? "archive" : "check"}
            title={tab === "archived" ? "Nothing archived" : "Nothing completed yet"}
            description={tab === "archived" ? "Archive a saved message to keep it here without treating it as a task." : "Items you mark complete move here."}
          >
            {#snippet action()}{#if later.open}<Button size="sm" onclick={() => showTab("open")}>Go to In progress</Button>{/if}{/snippet}
          </EmptyState>
        {/if}
      </div>
    {:else}
      <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
      <ul class="rows" aria-label={tabLabel[tab]} bind:this={list} {onkeydown}>
        {#each stacks as stack (stack.id)}
          {#if stack.label}<li class="stack t-caption" role="presentation" data-later-stack={stack.id}>{stack.label}</li>{/if}
          {#each stack.rows as row (row.id)}
            {@const overdue = isOverdue(row, now)}
            {@const room = roomHref(row)}
            {@const active = row.id === tabStop}
            <li
              class="row"
              class:overdue
              data-later-id={row.id}
              data-overdue={overdue || undefined}
              oncontextmenu={(e) => {
                e.preventDefault();
                openMenu(row, { x: e.clientX, y: e.clientY });
              }}
            >
              <span class="avatar">
                {#if row.author}<Avatar {...avatarOf(row.author)} seed={row.author.id} size={36} />{:else}<span class="no-author"><Icon name="trash" size={16} /></span>{/if}
              </span>
              <span class="main">
                <span class="where t-caption">
                  {#if roomIcon(row)}<Icon name={roomIcon(row)!} size={12} />{/if}
                  {#if room}<a class="room" href={room} tabindex="-1" data-later-room>{row.roomName}</a>{:else}<span class="room">{row.roomName}</span>{/if}
                  {#if row.threadRoot}<span aria-hidden="true">·</span><span>Thread</span>{/if}
                </span>
                <a class="open" href={hrefOf(row)} tabindex={active ? 0 : -1} onfocus={() => (focusId = row.id)} aria-keyshortcuts="C E M U L Delete Shift+F10" data-later-open>
                  <span class="heading">
                    <strong class="author t-label-sm">{row.author?.name ?? "Deleted message"}</strong>
                    <time class="t-caption" datetime={new Date(row.at).toISOString()} title={stampLabel(row.at, now)}>{stampLabel(row.at, now)}</time>
                  </span>
                  {#if row.state === "open" && row.remindAt !== undefined}
                    <span class="due t-caption" class:overdue data-later-due><Icon name={row.unread ? "dot" : "clock"} size={12} />{dueLabel(row.remindAt, now, !!row.unread).text}</span>
                  {/if}
                  {#if row.gone}
                    <span class="preview t-body gone">This message was deleted.</span>
                  {:else}
                    <span class="preview t-body">{previewText(row.text) || (row.images ? `${row.images} image${row.images === 1 ? "" : "s"}` : "")}</span>
                  {/if}
                </a>
              </span>
              <span class="row-actions">
                {#if row.state === "done"}
                  <IconButton size="sm" icon="refresh" label="Move to In progress" shortcut="C" tabindex={active ? 0 : -1} onclick={() => complete(row)} data-later-reopen />
                {:else}
                  <IconButton size="sm" icon="check" label="Mark complete" shortcut="C" tabindex={active ? 0 : -1} onclick={() => complete(row)} data-later-done />
                {/if}
                {#if row.state === "open"}
                  <IconButton size="sm" icon="clock" label={row.unread && row.remindAt !== undefined ? "Change when it comes back" : overdue ? "Snooze" : row.remindAt !== undefined ? "Change reminder" : "Remind me"} shortcut="M" tabindex={active ? 0 : -1} aria-haspopup="menu" onclick={(e: MouseEvent) => openRemind(row, e.currentTarget as HTMLElement)} data-later-remind />
                {/if}
                <IconButton size="sm" icon="bookmark-filled" label="Remove from Later" shortcut={isMac ? "⌫" : "Del"} tabindex={active ? 0 : -1} onclick={() => remove(row)} data-later-remove />
                <IconButton size="sm" icon="more" label="More actions" tabindex={active ? 0 : -1} aria-haspopup="menu" onclick={(e: MouseEvent) => openMenu(row, e.currentTarget as HTMLElement)} data-later-more />
              </span>
            </li>
          {/each}
        {/each}
      </ul>
    {/if}
  </div>
</div>
{#if remindOpen}<Menu bind:open={remindOpen} anchor={remindAnchor} items={remindItems} placement="bottom-end" label={remindRow?.unread ? "Change when it comes back" : remindRow && isOverdue(remindRow, now) ? "Snooze" : "Remind me"} />{/if}
{#if menuOpen}<Menu bind:open={menuOpen} anchor={menuAnchor} items={menuItems} placement="bottom-end" label="More actions" />{/if}
{#if customRow}<RemindDialog title="Remind me" at={customRow.remindAt} onpick={(at) => (customRow ? later.remind(customRow, at) : undefined)} onclose={() => (customRow = null)} />{/if}

<style>
  .page { display: flex; flex-direction: column; height: 100%; min-height: 0; }
  .tabs { flex: none; padding-inline: var(--space-panel-inset); border-bottom: 1px solid var(--border-standard); }
  .scroll { flex: 1; min-height: 0; overflow: auto; }
  .notice { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-3); padding: var(--space-3) var(--space-panel-inset); }
  .notice p { margin: 0; }
  .empty { display: grid; place-items: center; min-height: 60%; padding: var(--space-page-section-gap) var(--space-panel-inset); }
  .rows { list-style: none; margin: 0; padding: var(--space-1) var(--space-1-5) var(--space-panel-inset); display: grid; gap: 2px; }
  .stack { padding: var(--space-3) var(--space-3) var(--space-1); color: var(--text-subtle); font-weight: 600; }
  .row { position: relative; display: grid; grid-template-columns: 36px minmax(0, 1fr); gap: var(--space-3); min-width: 0; padding: 10px var(--space-3); border-radius: var(--radius-row); }
  .row:hover, .row:focus-within { background: var(--neutral-3); }
  /* The post link covers the whole row, and the room link and the hover buttons sit above it. */
  .open { display: grid; gap: 2px; min-width: 0; color: inherit; text-decoration: none; outline: none; }
  .open::before { content: ""; position: absolute; inset: 0; border-radius: inherit; }
  :global(html[data-keyboard-navigation]) .row:has(.open:focus-visible) { outline: 2px solid var(--border-focus); outline-offset: -2px; }
  .avatar { padding-top: 2px; }
  .no-author { display: grid; place-items: center; width: 36px; height: 36px; border-radius: 10px; background: var(--neutral-3); color: var(--text-subtle); }
  .main { display: grid; gap: 2px; min-width: 0; }
  .where { display: flex; align-items: center; gap: 4px; color: var(--text-subtle); min-width: 0; white-space: nowrap; }
  .room { overflow: hidden; text-overflow: ellipsis; font-weight: 600; color: inherit; text-decoration: none; }
  a.room { position: relative; z-index: 1; }
  a.room:hover { color: var(--text-standard); text-decoration: underline; }
  .heading { display: flex; align-items: baseline; gap: var(--space-2); min-width: 0; }
  .author { color: var(--text-standard); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .heading time { color: var(--text-metadata); flex: none; }
  .preview { display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; overflow-wrap: anywhere; max-inline-size: 72ch; white-space: pre-line; color: var(--text-standard); }
  .preview.gone { color: var(--text-subtle); font-style: italic; }
  .due { display: flex; align-items: center; gap: 4px; color: var(--text-metadata); }
  .due.overdue { color: var(--text-danger); font-weight: 600; }
  .row-actions { position: absolute; top: 8px; right: var(--space-3); display: flex; gap: 2px; padding: 2px; border-radius: 8px; background: var(--surface-panel); box-shadow: var(--shadow-float); opacity: 0; z-index: 1; }
  .row:hover .row-actions, .row:focus-within .row-actions { opacity: 1; }
</style>
