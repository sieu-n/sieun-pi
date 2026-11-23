<script lang="ts">
  import { onDestroy, tick } from "svelte";
  import { markUnread, type LaterRow, type LaterState } from "$lib/api";
  import { later } from "$lib/later.svelte";
  import { SAVED_KINDS, filterOf, filteredCounts, filtering, kindOf, matches, savedPage, savedRooms } from "$lib/saved-items";
  import MemoField from "$lib/MemoField.svelte";
  import { conversationHref, hrefFor, router } from "$lib/router.svelte";
  import { Avatar, Button, Chip, EmptyState, Icon, IconButton, LoadingText, PanelHeader, Picker, SearchField, Tabs, stampLabel, type PickerItem } from "$lib/ui";
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

  /** `#/c/saved` is In progress, `#/c/saved/archived` Archived and `#/c/saved/done` Completed, so back and a link keep the tab. */
  const tab = $derived<LaterState>(router.route.rest[1] === "done" ? "done" : router.route.rest[1] === "archived" ? "archived" : "open");
  /** The search box and the Kind and In filters, kept in the URL (`?q=`, `?kind=`, `?in=`), so reload and back keep them. */
  const filter = $derived(filterOf(router.route.params));
  const filtered = $derived(filtering(filter));
  const counts = $derived(filteredCounts(later.lists, filter));
  const tabRows = $derived(tab === "open" && later.lists.open ? dueFirst(later.lists.open, now) : later.lists[tab]);
  const rows = $derived(tabRows && filtered ? tabRows.filter((row) => matches(row, filter)) : tabRows);
  /** In progress pins the posts he marked unread on top, as their own Keep unread stack, until he handles each one (server/keep-unread.ts). */
  const stacks = $derived.by(() => {
    if (!rows) return [];
    if (tab !== "open") return [{ id: "all", label: null, rows }];
    const kept = rows.filter((r) => r.unread);
    if (!kept.length) return [{ id: "all", label: null, rows }];
    const saved = rows.filter((r) => !r.unread);
    return [{ id: "unread", label: "Keep unread", rows: kept }, ...(saved.length ? [{ id: "saved", label: "Saved", rows: saved }] : [])];
  });
  /** Slack's three Later tabs, in its order; with a search or filter on, each counts the items it keeps. */
  const tabs = $derived([
    { id: "open" as const, label: "In progress", badge: filtered ? counts.open : later.open || null },
    { id: "archived" as const, label: "Archived", badge: filtered ? counts.archived : null },
    { id: "done" as const, label: "Completed", badge: filtered ? counts.done : null },
  ]);
  const tabLabel: Record<LaterState, string> = { open: "In progress", archived: "Archived", done: "Completed" };
  /** A tab's path; the walk's `?test=1` and the search and filters carry over to every link the page makes. */
  const tabPath = (state: LaterState) => (state === "open" ? ["saved"] : ["saved", state]);
  const kept = () => ({ test: test ? "1" : null, q: filter.q || null, kind: filter.kind, in: filter.room });
  const showTab = (id: LaterState) => router.navigate(hrefFor("messages", tabPath(id), kept()), { replace: true });
  const setFilter = (patch: Record<string, string | null>) => router.setParams(patch, { replace: true });
  const clearFilters = () => setFilter({ q: null, kind: null, in: null });

  let kindOpen = $state(false);
  let roomOpen = $state(false);
  let kindChip = $state<HTMLSpanElement>();
  let roomChip = $state<HTMLSpanElement>();
  const kindLabel = $derived(SAVED_KINDS.find((k) => k.id === filter.kind)?.label);
  const kindItems = $derived<MenuEntry[]>([
    { type: "radio", id: "all", group: "kind", label: "All", checked: !filter.kind, onselect: () => setFilter({ kind: null }) },
    ...SAVED_KINDS.map((k): MenuEntry => ({ type: "radio", id: k.id, group: "kind", label: k.label, checked: filter.kind === k.id, onselect: () => setFilter({ kind: k.id }) })),
  ]);
  const rooms = $derived(savedRooms(later.lists));
  const roomName = $derived(rooms.find((r) => r.id === filter.room)?.name ?? filter.room);
  const roomItems = $derived<PickerItem[]>([
    { id: "", label: "Anywhere", icon: "search" },
    ...rooms.map((r) => ({ id: r.id, label: r.name, icon: r.kind === "channel" ? "hash" : r.kind === "dm" ? "user" : "chat" })),
  ]);
  /** What an empty filtered tab says matched nothing, and which other tab has matches. */
  const noMatch = $derived.by(() => {
    const noun = kindLabel?.toLowerCase() ?? "saved items";
    const title = `No ${noun}${filter.room ? ` in ${roomName}` : ""}${filter.q.trim() ? ` match "${filter.q.trim()}"` : ""}`;
    const elsewhere = (["open", "archived", "done"] as const).filter((s) => s !== tab && counts[s]).map((s) => `${counts[s]} in ${tabLabel[s]}`);
    return { title, description: elsewhere.length ? `Nothing in ${tabLabel[tab]} matches. ${elsewhere.join(", ")}.` : `Nothing in ${tabLabel[tab]} matches.` };
  });
  function onsearchkey(e: KeyboardEvent) {
    if (e.key === "Escape" && filter.q) {
      e.preventDefault();
      setFilter({ q: null });
    } else if (e.key === "ArrowDown") {
      const first = list?.querySelector<HTMLAnchorElement>(`[data-later-id="${tabStop}"] a[data-later-open]`) ?? links()[0];
      if (!first) return;
      e.preventDefault();
      first.focus();
    }
  }
  /** A saved reply opens its thread at the reply, and any other post its room at the post. */
  const hrefOf = (row: LaterRow) =>
    row.room === undefined ? pageHref(row) : conversationHref(row.room, row.threadRoot ? { thread: row.threadRoot, messageId: row.post } : { messageId: row.post });
  /** A saved wiki page opens beside Saved in the viewer; a /remind reminder opens nothing. */
  function pageHref(row: LaterRow): string {
    const page = savedPage(row.text);
    return hrefFor("messages", tabPath(row.state), { ...kept(), ...(page ? { view: `wiki:${page.path}` } : {}) });
  }
  /** A room that is gone keeps only its id as its name, and has nothing to open; a /remind reminder has no room. */
  const roomHref = (row: LaterRow) => (row.room === undefined || row.roomName === row.room ? null : conversationHref(row.room));
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
  /** The row whose memo field is open in place of its memo. */
  let memoRow = $state<string | null>(null);
  /** Opens the memo field after the menu that asked for it has closed and handed focus back, so that hand-back does not end the edit. */
  async function editMemo(row: LaterRow) {
    await tick();
    memoRow = row.id;
  }
  /** Enter and Esc leave focus on nothing once the field goes, so it comes back to the row; a click elsewhere keeps its own focus. */
  async function endMemo(row: LaterRow, text: string | null) {
    memoRow = null;
    if (text !== null) void later.setMemo(row.id, text);
    await tick();
    if (document.activeElement && document.activeElement !== document.body) return;
    const link = list?.querySelector<HTMLAnchorElement>(`[data-later-id="${row.id}"] a[data-later-open]`);
    if (link) {
      focusId = row.id;
      link.focus();
    }
  }
  function unread(row: LaterRow) {
    if (row.room === undefined) return;
    markUnread(row.room, row.post, row.threadRoot).then(
      () => toast.show("Marked as unread. It stays in Saved until you reply, react or check it off."),
      () => toast.error("Could not mark the message unread"),
    );
  }
  function copyLink(row: LaterRow) {
    void navigator.clipboard.writeText(`${location.origin}${location.pathname}${hrefOf(row)}`).then(
      () => toast.show("Link copied"),
      () => toast.error("Could not copy the link"),
    );
  }

  /** Slack's More actions on a saved item: open it, move it between tabs, remind, write its memo, mark unread, copy its link, or unsave it. */
  function rowMenu(row: LaterRow): MenuEntry[] {
    const room = roomHref(row);
    return [
      ...(row.room === undefined ? (savedPage(row.text) ? [{ id: "open", label: "Open page", icon: "file", shortcut: "Enter", onselect: () => router.navigate(hrefOf(row)) }] : []) : [{ id: "open", label: row.threadRoot ? "Open in thread" : "Open message", icon: row.threadRoot ? "thread" : "external", shortcut: "Enter", onselect: () => router.navigate(hrefOf(row)) }]),
      ...(room ? [{ id: "room", label: `Go to ${row.roomName}`, icon: row.roomKind === "channel" ? "hash" : (roomIcon(row) ?? "chat"), onselect: () => router.navigate(room) }] : []),
      { type: "separator" },
      row.state === "done"
        ? { id: "complete", label: "Move to In progress", icon: "refresh", shortcut: "C", onselect: () => complete(row) }
        : { id: "complete", label: "Mark complete", icon: "check", shortcut: "C", onselect: () => complete(row) },
      row.state === "archived"
        ? { id: "archive", label: "Move to In progress", icon: "unarchive", shortcut: "E", onselect: () => archive(row) }
        : { id: "archive", label: "Archive", icon: "archive", shortcut: "E", onselect: () => archive(row) },
      ...(row.state === "open" ? [{ ...remindMenu({ label: "Remind me", remindAt: row.remindAt, kept: !!row.unread, set: (at) => later.remind(row, at), custom: () => (customRow = row), clear: () => later.remind(row, null) }), detail: "M" }] : []),
      { id: "memo", label: row.memo ? "Edit memo" : "Add memo", icon: "edit", onselect: () => void editMemo(row) },
      ...(row.gone || row.room === undefined ? [] : [
        { id: "unread", label: "Mark unread", icon: "dot", shortcut: "U", onselect: () => unread(row) },
        { id: "link", label: "Copy link", icon: "link", shortcut: "L", onselect: () => copyLink(row) },
      ]),
      { type: "separator" },
      { id: "remove", label: "Remove from Saved", icon: "bookmark-filled", shortcut: isMac ? "⌫" : "Del", tone: "danger", onselect: () => remove(row) },
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
      u: () => !row.gone && row.room !== undefined && unread(row),
      l: () => !row.gone && row.room !== undefined && copyLink(row),
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
  <PanelHeader title="Saved" icon="bookmark" level={1} />
  <div class="tabs">
    <Tabs items={tabs} value={tab} variant="underline" size="sm" label="Saved" onchange={(id: LaterState) => showTab(id)} />
  </div>
  <div class="toolbar" data-saved-filters>
    <span class="search"><SearchField value={filter.q} placeholder="Search saved items" label="Search saved items" oninput={(q: string) => setFilter({ q: q || null })} onkeydown={onsearchkey} data-saved-search /></span>
    <Chip
      bind:element={kindChip}
      size="md"
      selected={!!filter.kind}
      popup={{ kind: "menu", open: kindOpen }}
      onclick={() => (kindOpen = !kindOpen)}
      onremove={filter.kind ? () => setFilter({ kind: null }) : undefined}
      removeLabel="Remove the Kind filter"
    ><span class="chip-value" data-chip="kind">{kindLabel ?? "Kind"}</span></Chip>
    <Chip
      bind:element={roomChip}
      size="md"
      selected={!!filter.room}
      popup={{ kind: "dialog", open: roomOpen }}
      onclick={() => (roomOpen = !roomOpen)}
      onremove={filter.room ? () => setFilter({ in: null }) : undefined}
      removeLabel="Remove the In filter"
    ><span class="chip-value" data-chip="in">{filter.room ? `In: ${roomName}` : "In"}</span></Chip>
  </div>
  <div class="scroll">
    {#if later.error && !rows}
      <div class="notice" role="alert"><p class="t-body">{later.error}</p><Button size="sm" onclick={() => later.refresh()}>Try again</Button></div>
    {:else if !rows}
      <div class="notice"><LoadingText text="Loading saved items…" /></div>
    {:else if !rows.length}
      <div class="empty" role="status">
        {#if filtered}
          <EmptyState icon="search" title={noMatch.title} description={noMatch.description}>
            {#snippet action()}<Button size="sm" onclick={clearFilters} data-saved-clear>Clear filters</Button>{/snippet}
          </EmptyState>
        {:else if tab === "open"}
          <EmptyState icon="bookmark" title="Nothing saved yet" description="Hover over a message and click the bookmark to save it here. Check it off once you are done with it." />
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
              data-kind={kindOf(row)}
              oncontextmenu={(e) => {
                if (e.target instanceof HTMLTextAreaElement) return;
                e.preventDefault();
                openMenu(row, { x: e.clientX, y: e.clientY });
              }}
            >
              <span class="avatar">
                {#if row.author}<Avatar {...avatarOf(row.author)} seed={row.author.id} size={36} />{:else}<span class="no-author"><Icon name="trash" size={16} /></span>{/if}
              </span>
              <span class="main">
                <span class="where t-caption">
                  {#if row.room === undefined && savedPage(row.text)}<Icon name="file" size={12} /><span class="room" data-later-page>Wiki page</span>
                  {:else if row.room === undefined}<Icon name="clock" size={12} /><span class="room" data-later-note>Reminder</span>
                  {:else}
                  {#if roomIcon(row)}<Icon name={roomIcon(row)!} size={12} />{/if}
                  {#if room}<a class="room" href={room} tabindex="-1" data-later-room>{row.roomName}</a>{:else}<span class="room">{row.roomName}</span>{/if}
                  {/if}
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
                    <span class="preview t-body">{savedPage(row.text)?.title || previewText(row.text) || (row.images ? `${row.images} image${row.images === 1 ? "" : "s"}` : "")}</span>
                  {/if}
                </a>
                {#if memoRow === row.id}
                  <span class="memo-edit"><MemoField value={row.memo ?? ""} label="Memo" onsave={(text) => endMemo(row, text)} oncancel={() => endMemo(row, null)} /></span>
                {:else if row.memo}
                  <button type="button" class="memo t-body-sm" tabindex="-1" title="Edit memo" onclick={() => void editMemo(row)} data-later-memo>{row.memo}</button>
                {/if}
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
                <IconButton size="sm" icon="edit" label={row.memo ? "Edit memo" : "Add memo"} tabindex={active ? 0 : -1} onclick={() => void editMemo(row)} data-later-memo-edit />
                <IconButton size="sm" icon="bookmark-filled" label="Remove from Saved" shortcut={isMac ? "⌫" : "Del"} tabindex={active ? 0 : -1} onclick={() => remove(row)} data-later-remove />
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
{#if kindOpen}<Menu bind:open={kindOpen} anchor={kindChip} items={kindItems} label="Kind" />{/if}
<Picker bind:open={roomOpen} anchor={roomChip} items={roomItems} value={filter.room ?? ""} searchable label="In" placeholder="Find a room" onselect={(id: string) => setFilter({ in: id || null })} />
{#if customRow}<RemindDialog title="Remind me" at={customRow.remindAt} onpick={(at) => (customRow ? later.remind(customRow, at) : undefined)} onclose={() => (customRow = null)} />{/if}

<style>
  .page { display: flex; flex-direction: column; height: 100%; min-height: 0; }
  .tabs { flex: none; padding-inline: var(--space-panel-inset); border-bottom: 1px solid var(--border-standard); }
  .toolbar { flex: none; display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2); padding: var(--space-2) var(--space-panel-inset); }
  .search { flex: 1 1 16rem; max-inline-size: 28rem; min-inline-size: 12rem; }
  .chip-value { max-width: 16rem; overflow: hidden; text-overflow: ellipsis; }
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
  /* The memo sits above the row's link, so a click on it edits the memo instead of opening the post. */
  .memo { position: relative; z-index: 1; justify-self: start; max-inline-size: 72ch; margin: 2px 0 0; padding: 2px 8px; border: 0; border-left: 2px solid var(--border-prominent); border-radius: 0 var(--radius-row) var(--radius-row) 0; background: var(--neutral-2); color: var(--text-subtle); font: var(--text-body-sm); text-align: start; white-space: pre-line; overflow-wrap: anywhere; cursor: text; }
  .memo:hover { color: var(--text-standard); }
  .memo-edit { position: relative; z-index: 2; display: block; max-inline-size: 72ch; margin-top: 2px; }
  .due.overdue { color: var(--text-danger); font-weight: 600; }
  .row-actions { position: absolute; top: 8px; right: var(--space-3); display: flex; gap: 2px; padding: 2px; border-radius: 8px; background: var(--surface-panel); box-shadow: var(--shadow-float); opacity: 0; z-index: 1; }
  .row:hover .row-actions, .row:focus-within .row-actions { opacity: 1; }
</style>
