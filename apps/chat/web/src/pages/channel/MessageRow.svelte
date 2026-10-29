<script lang="ts">
  import type { Item, TurnPlace } from "$lib/api";
  import Avatar from "$lib/ui/Avatar.svelte";
  import Bubble from "$lib/ui/Bubble.svelte";
  import Icon from "$lib/ui/Icon.svelte";
  import IconButton from "$lib/ui/IconButton.svelte";
  import Lightbox from "$lib/ui/Lightbox.svelte";
  import Markdown from "$lib/ui/Markdown.svelte";
  import TypingDots from "$lib/ui/TypingDots.svelte";
  import { clockLabel, stampLabel, timeLabel } from "$lib/ui/datetime";
  import type { MarkdownContext } from "$lib/ui/markdown";
  import type { Status } from "$lib/ui/types";
  import { conversationHref, router } from "$lib/router.svelte";
  import StepLine from "./StepLine.svelte";
  import ThreadPill from "./ThreadPill.svelte";
  import { offlineText } from "$pages/agents/host-badge";
  import { avatarKind, deliveryText, isOwn, placeText, QUIET_TURN, runningTool } from "./present";

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
  };
  let { item, first, last, layout = "bubble", fullTime = false, context, liveLabel = null, queue = null, flash = false, openThread = null, canReply = false, statusOf, onretrysend, ondiscardsend, onthread, oncopylink, onmention, onboardid, onartifact }: Props = $props();

  const own = $derived(isOwn(item));
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
  const hasBubble = $derived(!!item.text || (turn ? turn.steps.length > 0 || live : item.images.length === 0));
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
  let copied = $state(false);

  function copyText() {
    void navigator.clipboard.writeText(item.text).then(() => {
      copied = true;
      setTimeout(() => (copied = false), 1200);
    });
  }
</script>

{#snippet actionBar()}
  <div class="actions" role="toolbar" aria-label="Message actions">
    {#if canReply}<IconButton icon="reply" label="Reply in thread" size="sm" onclick={() => onthread(item.id)} />{/if}
    {#if workHref && !why}<IconButton icon="robot" label="Show work" size="sm" onclick={() => workHref && router.navigate(workHref)} data-show-work />{/if}
    <IconButton icon="link" label="Copy link" size="sm" onclick={() => oncopylink(item)} />
    <IconButton icon={copied ? "check" : "copy"} label={copied ? "Copied" : "Copy message"} size="sm" onclick={copyText} />
  </div>
{/snippet}

{#snippet images()}
  {#if item.images.length}
    <div class="images">
      {#each item.images as image, index (image.url + index)}
        <button type="button" class="image" aria-label="View image {index + 1}" onclick={() => (lightbox = image.url)}>
          <img src={image.url} alt="Attached image {index + 1}" loading="lazy" />
        </button>
      {/each}
    </div>
  {/if}
{/snippet}

{#snippet tail()}
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
  {#each notes as note (note)}<p class="note" data-note>{note}</p>{/each}
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
      members={message.thread.authors.map((a) => ({ id: a.id, name: a.name, kind: avatarKind(a) }))}
      label=""
      replies={message.thread.replies}
      lastAt={message.thread.lastAt}
      open={openThread === item.id}
      onclick={() => onthread(item.id)}
    />
  {/if}
{/snippet}

{#if slack}
  <li class="row slack" class:own class:first class:pending data-message-id={item.id} data-kind={item.kind} data-flash={flash ? "" : undefined} data-live={live || undefined}>
    <div class="gutter">
      {#if first}
        <Avatar name={item.author.name} kind={avatarKind(item.author)} seed={item.author.id} size={36} status={statusOf?.(item.author.id) ?? null} />
      {:else}
        <time class="clock" datetime={new Date(item.at).toISOString()} title={stampLabel(item.at)}>{clockLabel(item.at)}</time>
      {/if}
    </div>
    <div class="body">
      {#if first}
        <div class="head">
          <span class="author">{item.author.name}</span>
          <time datetime={new Date(item.at).toISOString()} title={stampLabel(item.at)}>{fullTime ? stampLabel(item.at) : timeLabel(item.at)}</time>
        </div>
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
        {#if item.text}
          <div class="text t-message">
            <Markdown text={item.text} {context} {onmention} {onboardid} {onartifact} class="msg-text" />
          </div>
        {:else if live && !stepLabel}
          <span class="waiting"><TypingDots mode="working" label="Writing" /></span>
        {/if}
      {/if}
      {@render images()}
      {@render tail()}
    </div>
    {@render actionBar()}
  </li>
{:else}
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
            {#if item.text}
              <Markdown text={item.text} {context} {onmention} {onboardid} {onartifact} class="msg-text" />
            {:else if live && !stepLabel}
              <span class="waiting"><TypingDots mode="working" label="Writing" /></span>
            {/if}
          </Bubble>
        {/if}
        {@render images()}
        {@render actionBar()}
      </div>
    </div>
    {@render tail()}
  </li>
{/if}

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
  .own:not(.slack) .actions {
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
  .own:not(.slack) .note {
    align-self: flex-end;
    margin: 4px calc(var(--gutter) + var(--gap) + 16px) 0 0;
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
    margin-top: 4px;
  }
  .slack .image {
    border-radius: 8px;
  }
  .slack .image img {
    max-width: 360px;
    max-height: 360px;
  }
  .slack .actions {
    top: -14px;
    right: 12px;
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
