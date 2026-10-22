<script lang="ts">
  import { store } from "./store.svelte.ts";
  import { clockTime } from "./format.ts";
  import { boardActionText, isBoardAction, type MentionIndex } from "./board.ts";
  import { foldJob } from "./jobs.ts";
  import { foldLabel, stampedItems, type ChatItem, type Fold, type ReplyQuote } from "../shared/chat-feed.ts";
  import { bubbleBlocks, renderMarkdown } from "./markdown.ts";
  import { ownerExcerpt, renderSaid } from "./reply.ts";
  import { diagrams } from "./diagrams.ts";
  import WikiEmbeds from "./WikiEmbeds.svelte";
  import { brokenImage } from "./prose.ts";
  import Icon from "./Icon.svelte";
  import { tooltip } from "./ui/tooltip.ts";
  import { longpress } from "./ui/longpress.ts";

  /**
   * The lines of a chat's feed (Chat.svelte): the owner's bubbles, the chat's replies, fold rows of background lines, board actions, notices,
   * the time stamps between them and the typing dots. `feed` is the whole loaded feed and the lines start at `feed[start]`.
   */
  let { id, feed, start, minute, cwd, mentions, typing, reply, copyLink, goToLine, viewImage, seeReply, press, onProseClick, readFold }: {
    id: string; feed: ChatItem[]; start: number; minute: number; cwd: string; mentions: MentionIndex | null; typing: boolean;
    reply: (text: string) => void; copyLink: (at: number) => Promise<void>; goToLine: (line: string) => Promise<void>;
    viewImage: (item: Extract<ChatItem, { kind: "user" }>, index: number) => void; seeReply: (item: Extract<ChatItem, { kind: "user" }>) => void;
    press: (at: number, text: string) => (anchor: HTMLElement) => void; onProseClick: (event: MouseEvent) => void;
    readFold: (fold: Fold) => void;
  } = $props();

  const shown = $derived(start ? feed.slice(start) : feed);
  const stamped = $derived(stampedItems(feed));
  function stamp(at: number): string {
    const date = new Date(at);
    const today = new Date(minute);
    return date.toDateString() === today.toDateString() ? clockTime(at) : date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  }
  /** The feed item id of a page send is "p" + its outbox id (chat-feed.ts chatFeed). */
  const sendId = (item: ChatItem) => item.id.slice(1);
</script>

{#snippet actions(at: number, text: string)}
  <span class="actions">
    <button type="button" class="icon-button small" aria-label="Reply to this message" use:tooltip={"Reply"} onclick={() => reply(text)}><Icon name="reply" size={13} /></button>
    <button type="button" class="icon-button small" aria-label="Copy link to this message" use:tooltip={"Copy link"} onclick={() => void copyLink(at)}><Icon name="link" size={13} /></button>
  </span>
{/snippet}

{#snippet replyQuote(quote: ReplyQuote)}
  <button type="button" class="quote reply-quote" aria-label="Show the message this answers" use:tooltip={"Show your message"} onclick={() => void goToLine(quote.id)}>{ownerExcerpt(quote.text)}</button>
{/snippet}

{#each shown as item (item.id)}
  {#if stamped.has(item.id)}<div class="stamp" data-stamp={item.at}>{stamp(item.at)}</div>{/if}
  {#if item.kind === "user" && !item.images.length && isBoardAction(item.text)}
    <div class="owner-action" class:pending={item.pending}><Icon name="check" size={12} /><span>{boardActionText(item.text)}</span></div>
  {:else if item.kind === "user"}
    <div class="line user" data-at={item.at} data-line={item.id}>
      {#if !item.pending && item.failed === undefined}{@render actions(item.at, item.text)}{/if}
      <div class="bubble mine" class:pending={item.pending} use:longpress={press(item.at, item.text)}>
        {#if item.images.length}
          <div class="images">
            {#each item.images as image, position (image.url + position)}
              <button type="button" class="view" aria-label="View image {position + 1}" onclick={() => viewImage(item, position)}><img src={image.url} alt="Attached" loading="lazy" /></button>
            {/each}
          </div>
        {/if}
        <!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
        {#if item.text}<div class="text said" onclick={onProseClick}>{@html renderSaid(item.text, mentions)}</div>{/if}
      </div>
    </div>
    {#if item.failed !== undefined}
      <div class="send-failed" role="status"><span>Not sent. {item.failed}</span>
        <button type="button" class="more" onclick={() => void store.retrySend(sendId(item))}>Retry</button>
        <button type="button" class="more" onclick={() => store.editFailed(sendId(item))}>Edit</button></div>
    {/if}
    {#if item.replies?.length}
      <div class="see-reply"><button type="button" class="more" onclick={() => seeReply(item)}>{item.replies.length === 1 ? "See reply" : `See replies (${item.replies.length})`}</button></div>
    {/if}
  {:else if item.kind === "agent"}
    {@const blocks = bubbleBlocks(item.text)}
    <div class="line agent" data-at={item.at} data-line={item.id}>
      <div class="blocks">
        {#if item.replyTo && blocks[0]?.kind !== "prose"}
          <div class="bubble theirs quote-only">{@render replyQuote(item.replyTo)}</div>
        {/if}
        {#each blocks as block, position (position)}
          {@const html = renderMarkdown(block.text, cwd, mentions, true)}
          {@const streaming = item.streaming ?? false}
          {#if block.kind === "prose"}
            <div class="bubble theirs" use:longpress={press(item.at, item.text)}>
              {#if item.replyTo && position === 0}{@render replyQuote(item.replyTo)}{/if}
              <!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
              <div class="prose plain bubble-prose" onclick={onProseClick} onerrorcapture={brokenImage} use:diagrams={{ html, live: streaming }}>{@html html}{#if streaming && position === blocks.length - 1}<span class="caret"></span>{/if}</div>
            </div>
          {:else}
            <!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
            <div class="card prose plain {block.kind}" onclick={onProseClick} onerrorcapture={brokenImage} use:diagrams={{ html, live: streaming && block.kind === "diagram" && !block.closed }} use:longpress={press(item.at, item.text)}>{@html html}</div>
          {/if}
        {/each}
        {#if !item.streaming}<WikiEmbeds text={item.text} chat={id} />{/if}
        {#if !blocks.length && item.streaming}<div class="bubble theirs"><span class="caret"></span></div>{/if}
      </div>
      {#if !item.streaming}{@render actions(item.at, item.text)}{/if}
    </div>
  {:else if item.kind === "fold"}
    {@const label = foldLabel(item)}
    <div class="line fold" data-at={item.at}>
      <button type="button" class="fold-line" title="Read these updates" data-preview-chat={id} data-preview-job={foldJob(item)} onclick={() => readFold(item)}>
        <span class="fold-latest">{label.latest}</span>
        {#if item.entries.length > 1}<span class="dot-sep"></span><span class="fold-count">{label.count}</span>{#if label.names}<span class="fold-names">from {label.names}</span>{/if}{/if}
        <span class="fold-mark"><Icon name="chevronRight" size={12} /></span>
      </button>
    </div>
  {:else}
    <div class="notice">{item.text}</div>
  {/if}
{/each}
{#if typing}
  <div class="line agent"><div class="bubble theirs typing" role="status" aria-label="Typing"><span></span><span></span><span></span></div></div>
{/if}

<style>
  .stamp { align-self: center; margin: 10px 0 4px; font-size: 11.5px; color: var(--text-faint); font-variant-numeric: tabular-nums; }
  .line { display: flex; align-items: flex-end; gap: 4px; border-radius: 20px; }
  .line.user { justify-content: flex-end; }
  .line.agent { justify-content: flex-start; }
  /* Reply and Copy link beside the bubble, shown on hover (a long press opens the same two as a menu on touch); the owner's side mirrors the order. */
  .actions { display: inline-flex; flex: none; align-items: center; gap: 2px; margin-bottom: 4px; color: var(--text-faint); }
  .actions > button { opacity: 0; transition: opacity 0.15s; }
  .line.user .actions { flex-direction: row-reverse; }
  .line:hover .actions > button, .actions:focus-within > button { opacity: 1; }
  .line:global(.linked) { animation: linked 2s ease-out; }
  @keyframes linked { from { background: var(--accent-soft); box-shadow: 0 0 0 6px var(--accent-soft); } to { background: transparent; box-shadow: none; } }
  .bubble { max-width: min(82%, 560px); min-width: 0; padding: 8px 14px; border-radius: 18px; font-size: calc(var(--chat-text) + 0.5px); line-height: 1.45; }
  /* The owner's bubble is a light blue tint with normal text, calm next to the gray replies (owner, 10-08: "this blue is too blue"). */
  .bubble.mine { background: var(--mine-bubble); color: var(--text); border-bottom-right-radius: 5px; transition: opacity 0.2s; }
  .bubble.mine.pending { opacity: 0.55; }
  .send-failed { display: flex; justify-content: flex-end; align-items: baseline; flex-wrap: wrap; gap: 0 10px; margin: -2px 6px 2px; font-size: 12.5px; color: var(--text-muted); }
  .bubble.theirs { background: var(--user-bubble); border-bottom-left-radius: 5px; }
  .text { white-space: pre-wrap; overflow-wrap: anywhere; }
  /* The quote a Reply put on top: small and muted, a bar on the left, the owner's text under it. */
  .said :global(blockquote.quote) { margin: 0 0 6px; padding: 2px 0 2px 9px; border-left: 2.5px solid color-mix(in srgb, currentColor 40%, transparent); font-size: 13px; line-height: 1.4; color: color-mix(in srgb, currentColor 72%, transparent); }
  .said :global(blockquote.quote:last-child) { margin-bottom: 0; }
  /* The quote over a chat reply that answers an older owner message: the owner's quote style, as a button to that message. */
  .reply-quote { display: block; margin: 0 0 6px; padding: 2px 0 2px 9px; border: 0; border-left: 2.5px solid color-mix(in srgb, currentColor 40%, transparent); background: none; text-align: left; white-space: pre-wrap; overflow-wrap: anywhere; font: inherit; font-size: 13px; line-height: 1.4; color: color-mix(in srgb, var(--text) 72%, transparent); cursor: pointer; }
  .quote-only .reply-quote { margin-bottom: 0; }
  .reply-quote:hover { color: var(--text); }
  .see-reply { display: flex; justify-content: flex-end; margin: -2px 6px 2px; }
  .said :global(a) { color: inherit; text-decoration: underline; text-underline-offset: 0.15em; }
  .said :global(code) { font-family: var(--mono); font-size: 0.88em; padding: 0.05em 0.3em; border-radius: 4px; background: color-mix(in srgb, currentColor 16%, transparent); }
  .said :global(.artifact-link) { color: inherit; text-decoration-color: color-mix(in srgb, currentColor 55%, transparent); }
  /* In the owner's bubble the pill takes the bubble text color; the dot keeps the item's color with a thin ring so it reads on the tint. */
  .said :global(.mention-chip) { border-color: color-mix(in srgb, currentColor 55%, transparent); background: color-mix(in srgb, currentColor 16%, transparent); }
  .said :global(.mention-chip .dot) { box-shadow: 0 0 0 1px color-mix(in srgb, currentColor 70%, transparent); }
  .blocks { display: flex; flex-direction: column; align-items: flex-start; gap: 6px; flex: 1; min-width: 0; }
  .blocks > .bubble { max-width: min(82%, 560px); }
  /* Bubble typography: paragraphs and lists sit tight, nothing is bold, blocks scroll sideways inside the bubble. */
  .bubble-prose { line-height: 1.45; }
  .more { margin-top: 4px; padding: 0; border: 0; background: none; color: var(--accent-bold); font: inherit; font-size: 12.5px; cursor: pointer; }
  .more:hover { text-decoration: underline; }
  .bubble-prose :global(p), .bubble-prose :global(ul), .bubble-prose :global(ol), .bubble-prose :global(blockquote), .bubble-prose :global(.table-wrap), .bubble-prose :global(.code-block) { margin: 0 0 0.55em; }
  .bubble-prose :global(li + li) { margin-top: 0.15em; }
  .bubble-prose :global(li > ul), .bubble-prose :global(li > ol) { margin-top: 0.15em; }
  .bubble-prose :global(.code-block), .bubble-prose :global(.table-wrap) { max-width: 100%; background: var(--bg-elevated); }
  .bubble-prose :global(pre) { padding: 0.7em 0.9em; }
  .bubble-prose :global(.reply-image) { display: inline-block; vertical-align: middle; max-height: 180px; margin: 0.2em 0; }
  /* A standalone image or diagram: a wide card under the bubble, up to the feed width. */
  .card { align-self: stretch; max-width: 100%; border: 1px solid var(--border); border-radius: 14px; background: var(--bg-elevated); overflow: hidden; }
  .card :global(p) { margin: 0; }
  .card.image :global(.reply-image) { display: block; max-width: 100%; max-height: 560px; margin: 0; border: 0; border-radius: 0; }
  .card.image :global(.inert-image) { display: block; padding: 10px 14px; }
  .card.diagram :global(.code-block) { margin: 0; border: 0; border-radius: 0; background: var(--bg-elevated); }
  .owner-action { display: flex; align-items: center; justify-content: flex-end; gap: 5px; padding: 1px 6px; font-size: 12.5px; color: var(--text-faint); overflow-wrap: anywhere; }
  .owner-action.pending { opacity: 0.55; }
  .images { display: flex; flex-wrap: wrap; gap: 6px; margin: 2px 0 6px; }
  .view { display: block; cursor: zoom-in; border-radius: 10px; }
  .images img { max-width: 220px; max-height: 220px; border-radius: 10px; display: block; }
  .typing { display: inline-flex; align-items: center; gap: 4px; padding: 12px 14px; }
  .typing span { width: 7px; height: 7px; border-radius: 50%; background: var(--text-faint); animation: typing 1.2s ease-in-out infinite; }
  .typing span:nth-child(2) { animation-delay: 0.2s; }
  .typing span:nth-child(3) { animation-delay: 0.4s; }
  @keyframes typing { 0%, 60%, 100% { opacity: 0.35; } 30% { opacity: 1; } }
  /* A fold of background lines: one muted line, centered like a notice, with its latest line and count; it opens the reader. */
  .line.fold { justify-content: center; margin: 2px 0; border-radius: 999px; }
  .fold-line { display: inline-flex; align-items: center; gap: 6px; max-width: 100%; min-width: 0; padding: 3px 8px 3px 10px; border-radius: 999px; font-size: 12.5px; line-height: 1.4; color: var(--text-faint); transition: background-color 0.12s, color 0.12s; }
  .fold-line:hover { background: var(--bg-hover); color: var(--text-muted); }
  .fold-latest, .fold-names { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .fold-count { flex: none; }
  /* The sender names give way before the latest line, so a wait keeps its time ("until 00:26") on a narrow feed. */
  .fold-names { flex-shrink: 1000000; margin-left: -2px; }
  .fold-mark { display: inline-flex; flex: none; opacity: 0.7; }
  .dot-sep { flex: none; width: 3px; height: 3px; border-radius: 50%; background: currentColor; opacity: 0.6; }
  .notice { align-self: center; max-width: 90%; padding: 2px 10px; text-align: center; font-size: 12.5px; color: var(--text-faint); overflow-wrap: anywhere; }
  @container app (max-width: 899px) {
    .bubble, .blocks > .bubble { max-width: 86%; }
  }
</style>
