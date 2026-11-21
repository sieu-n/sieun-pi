<script lang="ts">
  import type { Item, TurnPlace } from "$lib/api";
  import ActionBar from "$lib/ui/ActionBar.svelte";
  import Avatar from "$lib/ui/Avatar.svelte";
  import Bubble from "$lib/ui/Bubble.svelte";
  import Icon from "$lib/ui/Icon.svelte";
  import IconButton from "$lib/ui/IconButton.svelte";
  import FileCard from "$lib/ui/FileCard.svelte";
  import Lightbox from "$lib/ui/Lightbox.svelte";
  import Menu from "$lib/ui/Menu.svelte";
  import type { MenuEntry } from "$lib/ui/menu";
  import { toast } from "$lib/ui/toast.svelte";
  import { api, markUnread } from "$lib/api";
  import { later, laterHref } from "$lib/later.svelte";
  import RemindDialog from "$lib/RemindDialog.svelte";
  import { dueLabel, remindedText, remindMenu } from "$lib/remind";
  import { askNotifyPermission } from "$lib/remind-notify";
  import Markdown from "$lib/ui/Markdown.svelte";
  import LinkCards from "$lib/ui/LinkCards.svelte";
  import TypingDots from "$lib/ui/TypingDots.svelte";
  import { clockLabel, stampLabel, timeLabel } from "$lib/ui/datetime";
  import { wikiUrl, withAuthor, type MarkdownContext } from "$lib/ui/markdown";
  import type { Status } from "$lib/ui/types";
  import { conversationHref, router } from "$lib/router.svelte";
  import { profileCard } from "$lib/shell/profile-card.svelte";
  import { frequentEmoji } from "./frequent-emoji.svelte";
  import Reactions from "./Reactions.svelte";
  import StepLine from "./StepLine.svelte";
  import ThreadPill from "./ThreadPill.svelte";
  import DeletePostDialog from "./DeletePostDialog.svelte";
  import ForwardCard from "./ForwardCard.svelte";
  import ForwardDialog from "./ForwardDialog.svelte";
  import PostEditor from "./PostEditor.svelte";
  import { setPin } from "./pins";
  import { offlineText } from "$pages/agents/host-badge";
  import { avatarKind, avatarOf, deliveryText, isOwn, placeText, QUIET_TURN, runningTool } from "./present";

  type Props = {
    item: Exclude<Item, { kind: "system" }>;
    first: boolean;
    last: boolean;
    /** bubble is the chat look; slack is a channel's full-width left-aligned row with the avatar on a group's first post. */
    layout?: "bubble" | "slack";
    /** A slack row in the thread pane, which has no day dividers, names the day in its time: "Yesterday at 5:31 PM". */
    fullTime?: boolean;
    context: MarkdownContext;
    /** The live tool or thinking line of the streaming turn. */
    liveLabel?: string | null;
    /** The conversation's queue place, when this row is the send that waits for it. */
    queue?: TurnPlace | null;
    flash?: boolean;
    /** The thread key open in the side pane: a job id or a channel root post id. */
    openThread?: string | null;
    /** Channel root posts get Reply in thread. */
    canReply?: boolean;
    statusOf?: (id: string) => Status | null;
    /** Retry and Discard on the owner's send that was not delivered. */
    onretrysend?: (item: Item) => void;
    ondiscardsend?: (item: Item) => void;
    onthread: (key: string) => void;
    oncopylink: (item: Item) => void;
    onmention?: (id: string, kind: string, e: MouseEvent) => void;
    onboardid?: (id: string, chatId: string, e: MouseEvent) => void;
    onartifact?: (target: string, e: MouseEvent) => void;
    /** The post this one answers, when it is not the row right above (rows.ts `replyTo`): a slack row names it in one line over the text. */
    replyTo?: Item | null;
    /**
     * A thread reply also sent to the channel: in the channel it opens with Slack's "replied to a thread" line, and in its thread it ends with
     * "Also sent to the channel".
     */
    alsoIn?: "channel" | "thread" | null;
  };
  let { item, first, last, layout = "bubble", fullTime = false, replyTo = null, alsoIn = null, context: roomContext, liveLabel = null, queue = null, flash = false, openThread = null, canReply = false, statusOf, onretrysend, ondiscardsend, onthread, oncopylink, onmention, onboardid, onartifact }: Props = $props();

  const own = $derived(isOwn(item));
  /** Reply in thread opens the post's own thread, or for a reply also sent to the channel, the thread it is in. */
  const replyKey = $derived(item.kind === "message" && item.alsoInChannel && item.threadRoot ? item.threadRoot : item.id);
  /** An agent's name and avatar open its profile card, as a person's do in Slack; the owner's and a job's stay plain. */
  const profiled = $derived(item.author.kind === "chat");
  const openProfile = (e: MouseEvent) => profileCard.toggle(item.author.id, item.author.name, e.currentTarget as HTMLElement);
  /** Board ids and job names in a post chip against its author's board and jobs, so p12 in vent's post is vent's p12. */
  const context = $derived(withAuthor(roomContext, item.author.id));
  const slack = $derived(layout === "slack");
  const turn = $derived(item.kind === "turn" ? item : null);
  const message = $derived(item.kind === "message" ? item : null);
  const live = $derived(turn?.live ?? false);
  const pending = $derived(message?.pending || item.id.startsWith("r:"));
  /**
   * A send draws at full strength, as in Slack, with one small line under it: Sending…, Sent, or Not delivered. A pending send always has
   * one; a stored DM post has one while its delivery to the agent is on the way or failed.
   */
  const sendState = $derived(message?.send ?? (pending ? "sending" : null));
  /** A DM send that waits on an away box shows "Queued, Mac is offline" in place of Sending… or Not delivered, since it goes when the box is back. */
  const offline = $derived(sendState ? offlineText(message?.sendError) : null);
  /** A DM post's jobs, or the jobs a thread turn started, drawn as pills under it. */
  const jobs = $derived(turn?.jobs ?? message?.jobs ?? []);
  /** The work-thread turn behind an agent's DM post. */
  const workHref = $derived(message?.work ? conversationHref(message.work.conversation, { messageId: message.work.around }) : null);
  const why = $derived(message?.why ? `${message.why.charAt(0).toUpperCase()}${message.why.slice(1)}` : null);
  /** A turn of an agent that talks through send_message: one bubble per sent message, and its fold on a row of its own. */
  const sent = $derived(turn?.sent ?? null);
  const pictures = $derived(item.images.filter((image) => image.mimeType.startsWith("image/")));
  const files = $derived(item.images.filter((image) => !image.mimeType.startsWith("image/")));
  const hasBubble = $derived(!!item.text || (turn ? turn.steps.length > 0 || live : item.images.length === 0 && !message?.forward));
  const toolNow = $derived(turn ? runningTool(turn.steps) : null);
  const stepLabel = $derived(liveLabel ?? (toolNow ? `Running ${toolNow}` : null));
  const waits = $derived(placeText(message?.queue ?? queue));
  const stackPosition = (index: number, count: number): "single" | "first" | "middle" | "last" => (count === 1 ? "single" : index === 0 ? "first" : index === count - 1 ? "last" : "middle");
  const notes = $derived([
    ...(message?.testSend ? [`Test send from ${message.testSend.by.name}, not from you. ${message.testSend.reason}`] : []),
    ...(waits ? [`${waits.charAt(0).toUpperCase()}${waits.slice(1)} for a working slot.`] : []),
    ...(message?.deliveries
      .filter((delivery) => !(offline && delivery.error === message.sendError))
      .map(deliveryText)
      .filter((text): text is string => !!text) ?? []),
  ]);
  let lightbox = $state<string | null>(null);
  /** A stored post of the open DM, channel or Solo room takes reactions; a thread's transcript and a pending send do not. */
  const room = $derived(router.conversationId && /^(dm|ch|so)_/.test(router.conversationId) ? router.conversationId : null);
  const reactable = $derived(message && room && message.seq !== undefined && !pending && !message.deleted ? message : null);
  /** The owner's own stored post takes Slack's Edit message and Delete message; a deleted one is a stub. */
  const editable = $derived(reactable && reactable.author.kind === "owner" && !reactable.testSend ? reactable : null);
  const deleted = $derived(message?.deleted ?? false);
  let editing = $state(false);
  let deleting = $state(false);
  let rowEl = $state<HTMLElement>();

  /** The Up arrow in an empty composer opens the owner's last post in the same conversation in its editor, as in Slack. */
  function editLast(e: Event) {
    const composer = (e as CustomEvent<HTMLElement>).detail;
    const scope = composer.closest("section.conversation");
    if (!editable || !rowEl || !scope?.contains(rowEl) || [...scope.querySelectorAll("[data-own-post]")].at(-1) !== rowEl) return;
    editing = true;
    rowEl.scrollIntoView({ block: "nearest" });
  }
  $effect(() => {
    if (!editable) return;
    window.addEventListener("chat:edit-last", editLast);
    return () => window.removeEventListener("chat:edit-last", editLast);
  });
  let reactions = $state<Reactions>();
  let reactButton = $state<HTMLButtonElement>();
  let picking = $state(false);
  /** The hover bar and an empty reactions bar mount on the row's first hover or focus, so a timeline does not build them for every row it draws. */
  let active = $state(false);
  /**
   * The bar sits in the gap above the post, as in Slack, so the post's own first line stays readable. A post at the top edge of its scroller
   * would get the bar cut off there, so the bar drops inside it; a row under 480 px wide, the thread pane's, drops the three quick reactions.
   */
  let barInside = $state(false);
  let barCompact = $state(false);
  function activate() {
    active = true;
    if (!rowEl) return;
    let scroller = rowEl.parentElement;
    while (scroller && !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement;
    barInside = !!scroller && rowEl.getBoundingClientRect().top - scroller.getBoundingClientRect().top < 36;
    barCompact = rowEl.clientWidth < 480;
  }

  /**
   * A thread's root, a channel post with no threadRoot or any DM post, takes Mark thread done and Reopen thread (server/thread-done.ts). A
   * done root draws a small check and reads a little dimmed, with its replies bar, as the owner asked on 11-20 (p113).
   */
  const doneable = $derived(reactable && room && !reactable.threadRoot ? reactable : null);
  const done = $derived(message?.done ?? null);
  const doneLabel = $derived(done ? `Done, marked by ${done.by.kind === "owner" ? "you" : done.by.name} ${stampLabel(done.at)}` : "");

  function toggleDone() {
    if (!doneable || !room) return;
    api.threadDone(room, doneable.id, !done).catch(() => toast.error(done ? "Could not reopen the thread" : "Could not mark the thread done"));
  }

  /** Slack's Pin to channel, in a DM Pin to this conversation: the post shows who pinned it, and the header's Pinned list holds it (server/pins.ts). */
  const pinned = $derived(message?.pinned ?? null);
  const pinPlace = $derived(room?.startsWith("ch_") ? "channel" : "this conversation");
  const pinnedLabel = $derived(pinned ? `Pinned by ${pinned.by.kind === "owner" ? "you" : pinned.by.name}` : "");

  function togglePin() {
    if (reactable && room) setPin(room, reactable.id, !pinned);
  }

  /**
   * The message menu behind the hover bar's More actions. The bar keeps Slack's few buttons (reactions, Reply in thread, Save for later),
   * so it stays narrow and off the text, and every other message action goes in this one list.
   */
  let menuOpen = $state(false);
  let moreButton = $state<HTMLButtonElement>();
  const separator: MenuEntry = { type: "separator" };
  const menuItems = $derived<MenuEntry[]>([
    ...(reactable ? [
      { id: "unread", label: "Mark unread", icon: "dot", shortcut: "U", onselect: unread },
      { ...remindMenu({ remindAt: reactable.later?.remindAt, kept: !!reactable.later?.unread, set: remind, custom: () => (customRemind = true), clear: () => remind(null) }), shortcut: "M" },
      separator,
    ] : []),
    ...(doneable ? [{ id: "done", label: done ? "Reopen thread" : "Mark thread done", icon: "check", onselect: afterPick(toggleDone) }] : []),
    ...(reactable ? [{ id: "pin", label: pinned ? `Un-pin from ${pinPlace}` : `Pin to ${pinPlace}`, icon: "pin", shortcut: "P", onselect: afterPick(togglePin) }] : []),
    ...(workHref && !why ? [{ id: "work", label: "Show work", icon: "robot", onselect: afterPick(() => workHref && router.navigate(workHref)) }] : []),
    { id: "copy-link", label: "Copy link", icon: "link", onselect: afterPick(() => oncopylink(item)) },
    { id: "copy-text", label: "Copy text", icon: "copy", onselect: afterPick(copyText) },
    ...(editable ? [
      separator,
      { id: "edit", label: "Edit message", icon: "edit", shortcut: "E", onselect: () => (editing = true) },
      { id: "delete", label: "Delete message", icon: "trash", shortcut: "Delete", tone: "danger" as const, onselect: () => (deleting = true) },
    ] : []),
  ]);
  /** Slack's Save for later: the hover bar's bookmark, the menu item and the label over a saved post (lib/later.svelte.ts). */
  const saved = $derived(reactable && room ? later.saved(room, reactable) : false);
  let customRemind = $state(false);
  /** Slack's Forward message, from the hover bar: the dialog that posts this one with its quote card into another room. */
  let forwarding = $state(false);

  /** Remind me about this: saves the post for later with the reminder, or clears the reminder and keeps the save. */
  async function remind(at: number | null) {
    if (!reactable || !room) return;
    try {
      if (at === null) await api.patchLater(`${room}:${reactable.id}`, { remindAt: null });
      else {
        void askNotifyPermission();
        await api.saveLater(room, reactable.id, at);
        toast.show(remindedText(at, Date.now(), !!reactable.later?.unread));
      }
    } catch {
      toast.error(at === null ? "Could not remove the reminder" : "Could not set the reminder");
    }
  }

  /** Mark unread: the room reads as unread from this post on, in every tab and the app, and the post waits in Later until he handles it. */
  function unread() {
    if (!reactable || !room) return;
    markUnread(room, reactable.id, reactable.threadRoot).then(
      () => toast.show("Marked as unread. It stays in Later until you reply, react or check it off."),
      () => toast.error("Could not mark the message unread"),
    );
    dropBar();
  }

  /** The menu hands focus back to More actions, which would keep the hover bar up; Slack drops it once the pick is made. */
  function dropBar() {
    requestAnimationFrame(() => {
      if (document.activeElement instanceof HTMLElement && rowEl?.contains(document.activeElement)) document.activeElement.blur();
    });
  }
  function afterPick(action: () => void): () => void {
    return () => {
      action();
      dropBar();
    };
  }

  /** Remind me about this from the message menu, which M opens on its own from the post's keys. */
  let remindOpen = $state(false);
  const remindItems = $derived.by(() => {
    const entry = menuItems.find((e) => e.type === "submenu" && e.id === "remind");
    return entry?.type === "submenu" ? entry.items : [];
  });

  /** A key Timeline hands the post it acts on, focused or under the pointer, as Slack's message keys do; cancels the event when it acted. */
  function postKey(e: Event) {
    const key = (e as CustomEvent<string>).detail;
    const thread = canReply || message?.thread ? replyKey : null;
    const act: (() => void) | null =
      key === "u" && reactable ? unread
      : key === "a" && reactable && room ? () => void later.toggle(room, reactable)
      : key === "m" && remindItems.length ? () => (remindOpen = true)
      : key === "r" && reactable ? () => reactButton && reactions?.pick(reactButton)
      : key === "t" && thread ? () => onthread(thread)
      : key === "e" && editable && !editing ? () => (editing = true)
      : key === "p" && reactable ? togglePin
      : key === "Delete" && editable ? () => (deleting = true)
      : null;
    if (!act) return;
    e.preventDefault();
    act();
  }

  $effect(() => {
    const el = rowEl;
    if (!el) return;
    el.addEventListener("postkey", postKey);
    return () => el.removeEventListener("postkey", postKey);
  });

  /** Alt-click, Option-click on a Mac, marks the post unread as in Slack, before a link or button inside it acts on the click. */
  function altClick(e: MouseEvent) {
    if (!e.altKey || !reactable || editing || (e.target as Element).closest("input, textarea, [contenteditable]")) return;
    e.preventDefault();
    e.stopPropagation();
    unread();
  }

  function copyText() {
    navigator.clipboard.writeText(sent ? sent.join("\n\n") : item.text).then(
      () => toast.show("Message text copied"),
      () => toast.error("Could not copy the message text"),
    );
  }
</script>

{#snippet actionBar()}
  <ActionBar label="Message actions" open={picking || menuOpen} inside={barInside}>
    {#if reactable}
      {#each barCompact ? [] : frequentEmoji.list.slice(0, 3) as emoji (emoji)}
        <button type="button" class="quick" aria-label="React with {emoji}" data-quick-reaction={emoji} onclick={() => reactions?.toggle(emoji)}>{emoji}</button>
      {/each}
      <IconButton icon="emoji-add" label="Add reaction" shortcut="R" size="sm" bind:element={reactButton} onclick={() => reactButton && reactions?.pick(reactButton)} data-add-reaction />
      <span role="separator" aria-orientation="vertical"></span>
    {/if}
    {#if canReply}<IconButton icon="reply" label="Reply in thread" shortcut="T" size="sm" onclick={() => onthread(replyKey)} />{/if}
    {#if reactable && room}
      <IconButton icon="forward" label="Forward message" size="sm" onclick={() => (forwarding = true)} data-forward-message />
      <IconButton icon={saved ? "bookmark-filled" : "bookmark"} label={saved ? "Remove from Later" : "Save for later"} shortcut="A" size="sm" pressed={saved} onclick={() => room && reactable && later.toggle(room, reactable)} data-save-later />
    {/if}
    <IconButton icon="more" label="More actions" size="sm" aria-haspopup="menu" aria-expanded={menuOpen} bind:element={moreButton} onclick={() => (menuOpen = !menuOpen)} data-message-menu />
  </ActionBar>
  {#if menuOpen}<Menu bind:open={menuOpen} anchor={moreButton} items={menuItems} placement="bottom-end" label="Message actions" />{/if}
  {#if remindOpen}<Menu bind:open={remindOpen} anchor={moreButton ?? rowEl} items={remindItems} placement="bottom-end" label="Remind me about this" />{/if}
  {#if customRemind}<RemindDialog at={reactable?.later?.remindAt} onpick={remind} onclose={() => (customRemind = false)} />{/if}
{/snippet}

{#snippet pinLabel()}
  <p class="pinned-label" title={pinned ? stampLabel(pinned.at) : undefined} data-pinned-label><Icon name="pin" size={12} />{pinnedLabel}</p>
{/snippet}

{#snippet savedLabel()}
  <p class="saved-label" data-saved-label><Icon name="bookmark-filled" size={12} /><a href={laterHref()}>{reactable?.later?.unread ? "Kept unread in Later" : "Saved for later"}</a>{#if reactable?.later?.remindAt !== undefined}{@const due = dueLabel(reactable.later.remindAt, Date.now(), !!reactable.later.unread)}<span aria-hidden="true">·</span><span class="saved-due" class:overdue={due.due} data-saved-due>{due.text}</span>{/if}</p>
{/snippet}

{#snippet images()}
  {#if message?.forward && !deleted}<ForwardCard forward={message.forward} {context} {onmention} {onartifact} />{/if}
  {#if pictures.length}
    <div class="images">
      {#each pictures as image, index (image.url + index)}
        <button type="button" class="image" aria-label="View image {index + 1}" onclick={() => (lightbox = image.url)}>
          {#if image.width && image.height}
            <img class="sized" src={image.url} alt="Attached image {index + 1}" loading="lazy" width={image.width} height={image.height} style:--w={image.width} style:--h={image.height} />
          {:else}
            <img src={image.url} alt="Attached image {index + 1}" loading="lazy" />
          {/if}
        </button>
      {/each}
    </div>
  {/if}
  {#if files.length}
    <div class="files">
      {#each files as file, index (file.url + index)}
        <FileCard name={file.name ?? "file"} mimeType={file.mimeType} size={file.size} href={file.url.startsWith("/api/uploads/") ? file.url : undefined} />
      {/each}
    </div>
  {/if}
  {#if !live && (sent?.length || item.text)}
    <LinkCards text={sent ? sent.join("\n\n") : item.text} onopen={(path, e) => (onartifact ? onartifact(`wiki:${path}`, e) : window.open(wikiUrl(path), "_blank", "noopener"))} />
  {/if}
{/snippet}

{#snippet doneMark()}
  <span class="done-mark" title={doneLabel} data-thread-done><Icon name="check" size={12} /><span class="sr-only">{doneLabel}</span></span>
{/snippet}

{#snippet tail()}
  {#if reactable && room && (active || reactable.reactions?.length)}<Reactions bind:this={reactions} bind:picking item={reactable} {room} />{/if}
  {#if offline}
    <p class="send-state queued" role="status" data-send-state="queued" title="It goes when the box is back.">{offline}</p>
  {:else if sendState === "failed"}
    <p class="send-state failed" role="status" data-send-state="failed" title={message?.sendError ?? ""}>
      <span>Not delivered</span>
      <span aria-hidden="true">·</span>
      <button type="button" onclick={() => onretrysend?.(item)}>Retry</button>
      {#if pending}
        <span aria-hidden="true">·</span>
        <button type="button" onclick={() => ondiscardsend?.(item)}>Discard</button>
      {/if}
    </p>
  {:else if sendState === "sending"}
    <p class="send-state sending" data-send-state="sending" title={message?.sendError ?? ""}>Sending…</p>
  {:else if sendState === "sent"}
    <p class="send-state sent" data-send-state="sent" title="The agent has it and reads it when its turn allows."><Icon name="check" size={12} /><span>Sent</span></p>
  {/if}
  {#if turn?.stop || turn?.error}
    <p class="note danger" role="status">{turn.stop === "aborted" ? "Response stopped" : turn.error || "The answer failed"}</p>
  {/if}
  {#each notes as note, index (index)}<p class="note" data-note>{note}</p>{/each}
  {#if alsoIn === "thread"}<p class="note" data-also-in="thread">Also sent to the channel</p>{/if}
  {#if why}
    <p class="meta" data-post-meta>
      <span class="why" data-why={message?.why}>{why}</span>
      {#if workHref}<span aria-hidden="true">·</span><a class="work" href={workHref} data-show-work>Show work</a>{/if}
    </p>
  {/if}
  {#if jobs.length}
    {#each jobs as job (job.conversation)}
      <ThreadPill
        {own}
        {layout}
        members={[{ id: job.conversation, name: job.name, kind: "agent" }]}
        label={job.name}
        replies={job.replies}
        lastAt={job.lastAt}
        working={job.status === "working"}
        failed={job.status === "failed"}
        open={openThread === job.conversation}
        onclick={() => onthread(job.conversation)}
      />
    {/each}
  {/if}
  {#if message?.thread}
    <ThreadPill
      {own}
      {layout}
      members={message.thread.authors.map(avatarOf)}
      label=""
      replies={message.thread.replies}
      lastAt={message.thread.lastAt}
      open={openThread === item.id}
      onclick={() => onthread(item.id)}
    />
  {/if}
{/snippet}

{#snippet authorName()}
  {#if profiled}
    <button type="button" class="author author-button" aria-haspopup="dialog" onclick={openProfile} onpointerenter={() => profileCard.warm(item.author.id)} data-author-button>{item.author.name}</button>
  {:else}
    <span class="author">{item.author.name}</span>
  {/if}
{/snippet}

{#snippet authorAvatar(size: number)}
  {#if profiled}
    <button type="button" class="avatar-button" aria-label="Open {item.author.name}'s profile" aria-haspopup="dialog" tabindex="-1" onclick={openProfile} onpointerenter={() => profileCard.warm(item.author.id)} data-author-avatar>
      <Avatar name={avatarOf(item.author).name} kind={avatarKind(item.author)} seed={item.author.id} {size} status={statusOf?.(item.author.id) ?? null} />
    </button>
  {:else}
    <Avatar name={avatarOf(item.author).name} kind={avatarKind(item.author)} seed={item.author.id} {size} status={statusOf?.(item.author.id) ?? null} />
  {/if}
{/snippet}

{#if slack}
  <li bind:this={rowEl} data-action-host tabindex="-1" class="row slack" class:pinned={!!pinned} class:own class:first class:done={!!done} class:pending class:picking={picking || menuOpen} data-own-post={editable ? "" : undefined} data-message-id={item.id} data-kind={item.kind} data-flash={flash ? "" : undefined} data-live={live || undefined} onpointerenter={activate} onfocusin={activate} onclickcapture={altClick}>
    <div class="gutter">
      {#if first}
        {@render authorAvatar(36)}
      {:else}
        <time class="clock" datetime={new Date(item.at).toISOString()} title={stampLabel(item.at)}>{clockLabel(item.at)}</time>
        {#if done}{@render doneMark()}{/if}
      {/if}
    </div>
    <div class="body">
      {#if pinned}{@render pinLabel()}{/if}
      {#if saved}{@render savedLabel()}{/if}
      {#if first}
        <div class="head">
          {@render authorName()}
          <time datetime={new Date(item.at).toISOString()} title={stampLabel(item.at)}>{fullTime ? stampLabel(item.at) : timeLabel(item.at)}</time>
          {#if done}{@render doneMark()}{/if}
        </div>
      {/if}
      {#if replyTo?.kind === "message"}
        <p class="reply-to" data-reply-to={replyTo.id} title={replyTo.text}>
          <Icon name="reply" size={12} /><span class="reply-author">{replyTo.author.name}</span><span class="reply-text">{replyTo.text}</span>
        </p>
      {/if}
      {#if alsoIn === "channel" && message?.alsoInChannel}
        <button type="button" class="reply-to also-in" title="Open the thread" onclick={() => onthread(replyKey)} data-also-in="channel">
          <Icon name="thread" size={12} /><span class="reply-author">replied to a thread:</span><span class="reply-text">{message.alsoInChannel.rootText || "a deleted message"}</span>
        </button>
      {/if}
      {#if turn && sent}
        {#if turn.steps.length || live}
          <div class="fold" data-fold data-quiet={!sent.length && !live ? "" : undefined}>
            <StepLine steps={turn.steps} {live} liveLabel={stepLabel} label={!live && !sent.length ? QUIET_TURN : null} onjob={onthread} />
          </div>
        {/if}
        {#each sent as text, index (index)}
          <div class="text t-message {stackPosition(index, sent.length)}" data-sent={index}>
            <Markdown {text} {context} {onmention} {onboardid} {onartifact} class="msg-text" />
          </div>
        {/each}
      {:else if hasBubble}
        {#if turn && (turn.steps.length || (live && stepLabel))}
          <div class="fold" data-fold>
            <StepLine steps={turn.steps} {live} liveLabel={stepLabel} onjob={onthread} />
          </div>
        {/if}
        {#if editing && editable && room}
          <PostEditor {room} post={item.id} text={item.text} ondone={() => (editing = false)} ondelete={() => ((editing = false), (deleting = true))} />
        {:else if deleted}
          <p class="deleted" data-deleted>This message was deleted.</p>
        {:else if item.text}
          <div class="text t-message">
            <Markdown text={item.text} {context} {onmention} {onboardid} {onartifact} class="msg-text" />
            {#if message?.editedAt}<span class="edited" title="Edited {stampLabel(message.editedAt)}" data-edited>(edited)</span>{/if}
          </div>
        {:else if live && !stepLabel}
          <span class="waiting"><TypingDots mode="working" label="Writing" /></span>
        {/if}
      {/if}
      {@render images()}
      {@render tail()}
    </div>
    {#if active && !editing}{@render actionBar()}{/if}
  </li>
{:else}
  <li bind:this={rowEl} data-action-host tabindex="-1" class="row" class:own class:first class:done={!!done} class:pending class:picking={picking || menuOpen} data-own-post={editable ? "" : undefined} data-message-id={item.id} data-kind={item.kind} data-flash={flash ? "" : undefined} data-live={live || undefined} onpointerenter={activate} onfocusin={activate} onclickcapture={altClick}>
    {#if first}
      <div class="byline">
        {#if !own && item.author.kind !== "owner"}<Icon name="robot" size={13} />{/if}
        {@render authorName()}
        <time datetime={new Date(item.at).toISOString()} title={stampLabel(item.at)}>{timeLabel(item.at)}</time>
        {#if done}{@render doneMark()}{/if}
      </div>
    {/if}
    <div class="line">
      <div class="gutter">
        {#if last}
          {@render authorAvatar(32)}
        {/if}
      </div>
      <div class="stack">
        {#if done && !first}{@render doneMark()}{/if}
        {#if pinned}{@render pinLabel()}{/if}
        {#if saved}{@render savedLabel()}{/if}
        {#if turn && sent}
          {#if turn.steps.length || live}
            <div class="fold" data-fold data-quiet={!sent.length && !live ? "" : undefined}>
              <StepLine steps={turn.steps} {live} liveLabel={stepLabel} label={!live && !sent.length ? QUIET_TURN : null} onjob={onthread} />
            </div>
          {/if}
          {#each sent as text, index (index)}
            <Bubble {own} highlighted={flash} position={stackPosition(index, sent.length)} class="msg-bubble" data-sent={index}>
              <Markdown {text} {context} {onmention} {onboardid} {onartifact} class="msg-text" />
            </Bubble>
          {/each}
        {:else if hasBubble}
          <Bubble {own} highlighted={flash} class="msg-bubble">
            {#if turn && (turn.steps.length || (live && stepLabel))}
              <StepLine steps={turn.steps} {live} liveLabel={stepLabel} onjob={onthread} />
            {/if}
            {#if editing && editable && room}
              <PostEditor {room} post={item.id} text={item.text} ondone={() => (editing = false)} ondelete={() => ((editing = false), (deleting = true))} />
            {:else if deleted}
              <span class="deleted" data-deleted>This message was deleted.</span>
            {:else if item.text}
              <Markdown text={item.text} {context} {onmention} {onboardid} {onartifact} class="msg-text" />
              {#if message?.editedAt}<span class="edited" title="Edited {stampLabel(message.editedAt)}" data-edited>(edited)</span>{/if}
            {:else if live && !stepLabel}
              <span class="waiting"><TypingDots mode="working" label="Writing" /></span>
            {/if}
          </Bubble>
        {/if}
        {@render images()}
        {#if active && !editing}{@render actionBar()}{/if}
      </div>
    </div>
    {@render tail()}
  </li>
{/if}

<Lightbox src={lightbox} onclose={() => (lightbox = null)} />
{#if editable && room}<DeletePostDialog bind:open={deleting} {room} post={item.id} text={item.text} />{/if}
{#if forwarding && reactable && room}<ForwardDialog subject={{ kind: "post", room, item: reactable }} onclose={() => ((forwarding = false), dropBar())} />{/if}

<style>
  /* "(edited)" sits at the end of the post's last paragraph, as in Slack; after a list, a table or a code block it takes a line of its own. */
  .edited {
    color: var(--text-metadata);
    font: var(--text-caption);
    letter-spacing: var(--tracking-caption);
  }
  .row :global(.msg-text:has(> p:last-child) + .edited) {
    display: none;
  }
  .row :global(.msg-text:has(+ .edited) > p:last-child::after) {
    content: " (edited)";
    color: var(--text-metadata);
    font: var(--text-caption);
    letter-spacing: var(--tracking-caption);
  }
  .deleted {
    margin: 0;
    color: var(--text-metadata);
    font-style: italic;
  }
  .row {
    --gutter: 32px;
    --gap: 12px;
    position: relative;
    display: flex;
    flex-direction: column;
    padding: 2px 0;
  }
  .row.first {
    padding-top: 14px;
  }
  .byline {
    display: flex;
    align-items: baseline;
    gap: 6px;
    padding: 0 0 4px calc(var(--gutter) + var(--gap) + 16px);
    font: var(--text-caption);
    letter-spacing: var(--tracking-caption);
    color: var(--text-standard);
  }
  .byline :global(.icon) {
    align-self: center;
    color: var(--text-subtle);
  }
  .author {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-weight: 500;
  }
  .author-button {
    padding: 0;
    border: 0;
    background: none;
    color: inherit;
    font-family: inherit;
    font-size: inherit;
    line-height: inherit;
    letter-spacing: inherit;
    cursor: pointer;
  }
  .author-button:hover {
    text-decoration: underline;
  }
  .avatar-button {
    display: inline-flex;
    padding: 0;
    border: 0;
    border-radius: var(--radius-control, 6px);
    background: none;
    cursor: pointer;
  }
  .byline time {
    flex: none;
    color: var(--text-metadata);
  }
  .own .byline {
    justify-content: flex-end;
    padding: 0 calc(var(--gutter) + var(--gap) + 16px) 4px 0;
  }
  .line {
    display: flex;
    align-items: flex-end;
    gap: var(--gap);
  }
  .own .line {
    flex-direction: row-reverse;
  }
  .gutter {
    display: flex;
    flex: 0 0 var(--gutter);
    justify-content: center;
  }
  .stack {
    position: relative;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 4px;
    min-width: 0;
    max-width: min(85%, 46rem);
  }
  .own .stack {
    align-items: flex-end;
  }
  .stack :global(.msg-bubble) {
    max-width: 100%;
  }
  .stack :global(.msg-text) {
    min-width: 0;
  }
  /* As wide as its line, so the folded summary never cuts, and no wider than a bubble once open. */
  .fold {
    box-sizing: border-box;
    width: max-content;
    max-width: min(100%, calc(60ch + 32px));
    padding: 0 12px 0 8px;
  }
  .fold :global([data-steps]) {
    margin: 0;
  }
  /* The toggle's -4px hang would take 4px off the fold's own width and cut the summary. */
  .fold :global([data-steps] > button) {
    margin-left: 0;
  }
  .waiting {
    display: inline-flex;
    padding: 6px 0;
  }
  .images,
  .files {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .files {
    margin-top: 4px;
  }
  .image {
    display: block;
    padding: 0;
    border: 1px solid var(--border-standard);
    border-radius: 16px;
    overflow: hidden;
    background: var(--surface-inset);
    cursor: zoom-in;
  }
  .image img {
    --cap: 280px;
    display: block;
    max-width: 280px;
    max-height: 280px;
  }
  /* An image whose size the server read from its header draws its box at the shown size before its bytes arrive, so the rows below never move. */
  .image img.sized {
    width: min(calc(var(--w) * 1px), var(--cap), calc(var(--cap) * var(--w) / var(--h)));
    height: auto;
    aspect-ratio: var(--w) / var(--h);
  }
  /* The hover bar is lib/ui ActionBar; its bottom edge meets the top of the post's first line, so it covers only the end of the line above. */
  .row {
    --action-bar-top: -26px;
  }
  .own:not(.slack) {
    --action-bar-right: auto;
    --action-bar-left: 8px;
  }
  .quick {
    display: grid;
    place-items: center;
    width: 28px;
    height: 28px;
    padding: 0;
    border: 0;
    border-radius: var(--radius-icon-button);
    background: transparent;
    font-family: "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif;
    font-size: 16px;
    line-height: 1;
    cursor: pointer;
  }
  .quick:hover {
    background: var(--affordance-ghost-hover);
  }

  .pending :global([data-action-bar]) {
    display: none;
  }
  .note {
    margin: 4px 0 0 calc(var(--gutter) + var(--gap) + 16px);
    font: var(--text-caption);
    letter-spacing: var(--tracking-caption);
    color: var(--text-subtle);
  }
  .own:not(.slack) .note {
    align-self: flex-end;
    margin: 4px calc(var(--gutter) + var(--gap) + 16px) 0 0;
  }
  .row:not(.slack) :global([data-reactions]) {
    margin-left: calc(var(--gutter) + var(--gap));
  }
  .own:not(.slack) :global([data-reactions]) {
    align-self: flex-end;
    margin: 4px calc(var(--gutter) + var(--gap)) 0 0;
  }
  .send-state {
    display: flex;
    align-items: center;
    gap: 4px;
    align-self: flex-end;
    margin: 2px calc(var(--gutter) + var(--gap) + 16px) 0 0;
    font: var(--text-caption);
    letter-spacing: var(--tracking-caption);
    color: var(--text-metadata);
  }
  .send-state.sending {
    /* A send that lands quickly never shows the line. */
    animation: send-appear 0s linear 600ms both;
  }
  @keyframes send-appear {
    from {
      visibility: hidden;
    }
    to {
      visibility: visible;
    }
  }
  .send-state.failed {
    color: var(--text-danger);
  }
  .send-state button {
    padding: 0;
    border: 0;
    background: none;
    color: inherit;
    font: inherit;
    font-weight: 500;
    text-decoration: underline;
    cursor: pointer;
  }
  .meta {
    display: flex;
    align-items: center;
    gap: 4px;
    margin: 2px 0 0 calc(var(--gutter) + var(--gap) + 16px);
    font: var(--text-caption);
    letter-spacing: var(--tracking-caption);
    color: var(--text-metadata);
  }
  .own:not(.slack) .meta {
    align-self: flex-end;
    margin: 2px calc(var(--gutter) + var(--gap) + 16px) 0 0;
  }
  .why {
    padding: 0 6px;
    border-radius: var(--radius-capsule);
    background: var(--surface-inset);
    color: var(--text-subtle);
  }
  .work {
    color: var(--text-subtle);
    text-decoration: none;
  }
  .work:hover {
    color: var(--text-standard);
    text-decoration: underline;
  }
  .note.danger {
    color: var(--text-danger);
  }
  .row :global([data-thread-pill]) {
    margin-left: calc(var(--gutter) + var(--gap) + 12px);
  }
  .own:not(.slack) :global([data-thread-pill]) {
    margin-left: 0;
    margin-right: calc(var(--gutter) + var(--gap) + 12px);
  }
  .slack {
    isolation: isolate;
    display: grid;
    grid-template-columns: 36px minmax(0, 1fr);
    column-gap: 8px;
    margin-inline: -12px;
    padding: 4px 12px;
    border-radius: 8px;
  }
  .slack.first {
    margin-top: 4px;
    padding-top: 8px;
  }
  .slack:hover {
    background: color-mix(in srgb, var(--affordance-ghost-hover) 60%, transparent);
  }
  /* A post keyboard focus is on reads as hovered, with its hover bar and time, inside an inset ring, as in Slack. */
  .row:focus-visible {
    outline-offset: -2px;
  }
  .slack:focus-visible {
    background: color-mix(in srgb, var(--affordance-ghost-hover) 60%, transparent);
  }
  .slack:focus-visible .clock {
    visibility: visible;
  }
  .slack::before {
    content: "";
    position: absolute;
    inset: 0;
    z-index: -1;
    border-radius: inherit;
    background: rgb(242 199 68 / 24%);
    opacity: 0;
    transition: opacity 1.2s var(--ease-standard);
    pointer-events: none;
  }
  .slack[data-flash]::before {
    opacity: 1;
    transition: none;
  }
  .slack .gutter {
    display: block;
    flex: none;
  }
  /* A done thread's root reads quieter, its replies bar too, and full again under the pointer or keyboard focus; the hover bar stays at full ink. */
  .slack.done > :is(.gutter, .body),
  .row.done:not(.slack) > :not(.line),
  .row.done:not(.slack) .line > .gutter,
  .row.done:not(.slack) .stack > :not([data-action-bar]) {
    opacity: 0.55;
    transition: opacity var(--duration-fast) var(--ease-standard);
  }
  .slack.done:is(:hover, :focus-visible, :has(:focus-visible)) > :is(.gutter, .body),
  .row.done:not(.slack):is(:hover, :focus-visible, :has(:focus-visible)) > :not(.line),
  .row.done:not(.slack):is(:hover, :focus-visible, :has(:focus-visible)) .line > .gutter,
  .row.done:not(.slack):is(:hover, :focus-visible, :has(:focus-visible)) .stack > :not([data-action-bar]) {
    opacity: 1;
  }
  .done-mark {
    display: inline-grid;
    place-items: center;
    align-self: center;
    width: 16px;
    height: 16px;
    border-radius: 50%;
    background: var(--status-online);
    color: white;
  }
  .done-mark :global(.icon) {
    stroke-width: 2.5;
  }
  /* On a stacked root the check takes the gutter's hidden clock place, and the clock comes back under the pointer. */
  .slack .gutter .done-mark {
    display: grid;
    margin: 3px 0 0 auto;
  }
  .slack.done:not(:hover) .gutter .clock,
  .slack:hover .gutter .done-mark {
    display: none;
  }
  .slack.pinned {
    background: rgb(242 199 68 / 10%);
  }
  .pinned-label {
    display: flex;
    align-items: center;
    gap: 4px;
    margin: 0 0 2px;
    font: var(--text-caption);
    letter-spacing: var(--tracking-caption);
    color: var(--text-metadata);
  }
  .saved-label {
    display: flex;
    align-items: center;
    gap: 4px;
    margin: 0 0 2px;
    font: var(--text-caption);
    letter-spacing: var(--tracking-caption);
    color: var(--accent-link);
  }
  .saved-due {
    color: var(--text-metadata);
  }
  .saved-due.overdue {
    color: var(--text-danger);
  }
  .saved-label a {
    color: inherit;
    text-decoration: none;
  }
  .saved-label a:hover {
    text-decoration: underline;
  }
  .reply-to {
    display: flex;
    align-items: center;
    gap: 4px;
    margin: 0 0 2px;
    padding-left: 8px;
    border-left: 2px solid var(--border-message-thread);
    font: var(--text-caption);
    letter-spacing: var(--tracking-caption);
    color: var(--text-metadata);
    white-space: nowrap;
  }
  .also-in {
    max-inline-size: 100%;
    background: none;
    border-top: 0;
    border-right: 0;
    border-bottom: 0;
    padding-block: 0;
    cursor: pointer;
  }
  .also-in:hover .reply-text {
    color: var(--text-standard);
    text-decoration: underline;
  }
  .reply-author {
    flex: none;
    font-weight: 500;
    color: var(--text-subtle);
  }
  .reply-text {
    min-inline-size: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .clock {
    display: block;
    padding-top: 3px;
    color: var(--text-metadata);
    font: var(--text-caption);
    letter-spacing: var(--tracking-caption);
    text-align: right;
    white-space: nowrap;
    visibility: hidden;
  }
  .slack:hover .clock {
    visibility: visible;
  }
  .body {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    min-width: 0;
  }
  .head {
    display: flex;
    align-items: baseline;
    gap: 8px;
    min-width: 0;
    max-width: 100%;
  }
  .head .author {
    color: var(--text-standard);
    font: var(--text-label-sm);
    font-weight: 700;
  }
  .head time {
    flex: none;
    color: var(--text-metadata);
    font: var(--text-caption);
    letter-spacing: var(--tracking-caption);
  }
  .head time:hover {
    text-decoration: underline;
  }
  .text {
    max-width: 100%;
    color: var(--text-standard);
    overflow-wrap: anywhere;
  }
  .text + .text {
    margin-top: 4px;
  }
  .text :global(a) {
    color: var(--text-message-link);
  }
  .text :global(p) {
    margin: 0;
  }
  .text :global(p + p) {
    margin-top: 8px;
  }
  .slack .text :global(.mention) {
    max-width: 100%;
  }
  .slack .fold {
    width: auto;
    max-width: 100%;
    padding: 0;
  }
  .slack .images {
    container-type: inline-size;
    align-self: stretch;
    margin-top: 4px;
  }
  .slack .image {
    border-radius: 8px;
  }
  .slack .image img {
    --cap: 360px;
    max-width: min(360px, calc(100cqi - 2px));
    max-height: 360px;
  }
  .slack .image img.sized {
    width: min(calc(var(--w) * 1px), var(--cap), calc(100cqi - 2px), calc(var(--cap) * var(--w) / var(--h)));
  }
  .slack {
    --action-bar-top: -28px;
    --action-bar-right: 12px;
  }
  .slack .note,
  .slack .meta {
    margin: 2px 0 0;
  }
  .slack .send-state {
    align-self: flex-start;
    margin: 2px 0 0;
  }
  .slack :global([data-thread-pill]) {
    margin-left: -4px;
  }
</style>
