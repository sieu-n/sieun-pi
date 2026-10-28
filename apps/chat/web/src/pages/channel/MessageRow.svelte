<script lang="ts">
  import type { Item, TurnPlace } from "$lib/api";
  import Avatar from "$lib/ui/Avatar.svelte";
  import Bubble from "$lib/ui/Bubble.svelte";
  import Icon from "$lib/ui/Icon.svelte";
  import IconButton from "$lib/ui/IconButton.svelte";
  import Lightbox from "$lib/ui/Lightbox.svelte";
  import Markdown from "$lib/ui/Markdown.svelte";
  import TypingDots from "$lib/ui/TypingDots.svelte";
  import { stampLabel, timeLabel } from "$lib/ui/datetime";
  import type { MarkdownContext } from "$lib/ui/markdown";
  import type { Status } from "$lib/ui/types";
  import StepLine from "./StepLine.svelte";
  import ThreadPill from "./ThreadPill.svelte";
  import { avatarKind, deliveryText, isOwn, placeText, runningTool } from "./present";

  type Props = {
    item: Exclude<Item, { kind: "system" }>;
    first: boolean;
    last: boolean;
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
    onthread: (key: string) => void;
    oncopylink: (item: Item) => void;
    onmention?: (id: string, kind: string, e: MouseEvent) => void;
    onboardid?: (id: string, chatId: string, e: MouseEvent) => void;
    onartifact?: (target: string, e: MouseEvent) => void;
  };
  let { item, first, last, context, liveLabel = null, queue = null, flash = false, openThread = null, canReply = false, statusOf, onthread, oncopylink, onmention, onboardid, onartifact }: Props = $props();

  const own = $derived(isOwn(item));
  const turn = $derived(item.kind === "turn" ? item : null);
  const message = $derived(item.kind === "message" ? item : null);
  const live = $derived(turn?.live ?? false);
  const pending = $derived(message?.pending || item.id.startsWith("r:"));
  const hasBubble = $derived(!!item.text || (turn ? turn.steps.length > 0 || live : item.images.length === 0));
  const toolNow = $derived(turn ? runningTool(turn.steps) : null);
  const stepLabel = $derived(liveLabel ?? (toolNow ? `Running ${toolNow}` : null));
  const waits = $derived(placeText(message?.queue ?? queue));
  const notes = $derived([
    ...(waits ? [`${waits.charAt(0).toUpperCase()}${waits.slice(1)} for a working slot.`] : []),
    ...(message?.deliveries.map(deliveryText).filter((text): text is string => !!text) ?? []),
  ]);
  let lightbox = $state<string | null>(null);
  let copied = $state(false);

  function copyText() {
    void navigator.clipboard.writeText(item.text).then(() => {
      copied = true;
      setTimeout(() => (copied = false), 1200);
    });
  }
</script>

<li class="row" class:own class:first class:pending data-message-id={item.id} data-kind={item.kind} data-flash={flash ? "" : undefined} data-live={live || undefined}>
  {#if first}
    <div class="byline">
      {#if !own && item.author.kind !== "owner"}<Icon name="robot" size={13} />{/if}
      <span class="author">{item.author.name}</span>
      <time datetime={new Date(item.at).toISOString()} title={stampLabel(item.at)}>{timeLabel(item.at)}</time>
    </div>
  {/if}
  <div class="line">
    <div class="gutter">
      {#if last}
        <Avatar name={item.author.name} kind={avatarKind(item.author)} seed={item.author.id} size={32} status={statusOf?.(item.author.id) ?? null} />
      {/if}
    </div>
    <div class="stack">
      {#if hasBubble}
        <Bubble {own} highlighted={flash} class="msg-bubble">
          {#if turn && (turn.steps.length || (live && stepLabel))}
            <StepLine steps={turn.steps} {live} liveLabel={stepLabel} onjob={onthread} />
          {/if}
          {#if item.text}
            <Markdown text={item.text} {context} streaming={live} {onmention} {onboardid} {onartifact} class="msg-text" />
          {:else if live && !stepLabel}
            <span class="waiting"><TypingDots mode="working" label="Writing" /></span>
          {/if}
        </Bubble>
      {/if}
      {#if item.images.length}
        <div class="images">
          {#each item.images as image, index (image.url + index)}
            <button type="button" class="image" aria-label="View image {index + 1}" onclick={() => (lightbox = image.url)}>
              <img src={image.url} alt="Attached image {index + 1}" loading="lazy" />
            </button>
          {/each}
        </div>
      {/if}
      <div class="actions" role="toolbar" aria-label="Message actions">
        {#if canReply}<IconButton icon="reply" label="Reply in thread" size="sm" onclick={() => onthread(item.id)} />{/if}
        <IconButton icon="link" label="Copy link" size="sm" onclick={() => oncopylink(item)} />
        <IconButton icon={copied ? "check" : "copy"} label={copied ? "Copied" : "Copy message"} size="sm" onclick={copyText} />
      </div>
    </div>
  </div>
  {#if turn?.stop || turn?.error}
    <p class="note danger" role="status">{turn.stop === "aborted" ? "Response stopped" : turn.error || "The answer failed"}</p>
  {/if}
  {#each notes as note (note)}<p class="note" data-note>{note}</p>{/each}
  {#if turn}
    {#each turn.jobs as job (job.conversation)}
      <ThreadPill
        {own}
        members={[{ id: job.conversation, name: job.name, kind: "agent" }]}
        label={job.name}
        replies={job.replies}
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
      members={message.thread.authors.map((a) => ({ id: a.id, name: a.name, kind: avatarKind(a) }))}
      label=""
      replies={message.thread.replies}
      open={openThread === item.id}
      onclick={() => onthread(item.id)}
    />
  {/if}
</li>

<Lightbox src={lightbox} onclose={() => (lightbox = null)} />

<style>
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
  .row.pending {
    opacity: 0.6;
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
  .waiting {
    display: inline-flex;
    padding: 6px 0;
  }
  .images {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
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
    display: block;
    max-width: 280px;
    max-height: 280px;
  }
  .actions {
    position: absolute;
    top: -18px;
    right: 8px;
    z-index: 2;
    display: flex;
    gap: 2px;
    padding: 2px;
    border-radius: var(--radius-row);
    background: var(--popover-glass-fill);
    backdrop-filter: blur(8px);
    box-shadow: var(--shadow-sm);
    opacity: 0;
    pointer-events: none;
    transition: opacity var(--duration-fast) var(--ease-standard);
  }
  .own .actions {
    right: auto;
    left: 8px;
  }
  .row:hover .actions,
  .actions:focus-within {
    opacity: 1;
    pointer-events: auto;
  }
  .pending .actions {
    display: none;
  }
  .note {
    margin: 4px 0 0 calc(var(--gutter) + var(--gap) + 16px);
    font: var(--text-caption);
    letter-spacing: var(--tracking-caption);
    color: var(--text-subtle);
  }
  .own .note {
    align-self: flex-end;
    margin: 4px calc(var(--gutter) + var(--gap) + 16px) 0 0;
  }
  .note.danger {
    color: var(--text-danger);
  }
  .row :global([data-thread-pill]) {
    margin-left: calc(var(--gutter) + var(--gap) + 12px);
  }
  .own :global([data-thread-pill]) {
    margin-left: 0;
    margin-right: calc(var(--gutter) + var(--gap) + 12px);
  }
</style>
