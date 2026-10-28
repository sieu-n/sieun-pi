<script lang="ts">
  import { conversationHref } from "$lib/router.svelte";
  import Icon from "$lib/ui/Icon.svelte";
  import type { ContextLine, HitContext } from "./context";
  import Highlight from "./Highlight.svelte";
  import HitAvatar from "./HitAvatar.svelte";
  import HitMeta from "./HitMeta.svelte";
  import { author, location, longStamp, type Hit } from "./hit-view";
  import { snippetPieces } from "./match";

  type Props = {
    hit: Hit;
    now: Date;
    /** The keyboard's current result: it shows its context without a click. */
    focused: boolean;
    expanded: boolean;
    context: HitContext | "loading" | "error" | undefined;
    ontoggle: () => void;
    onfocus: () => void;
  };
  let { hit, now, focused, expanded, context, ontoggle, onfocus }: Props = $props();

  const pieces = $derived(snippetPieces(expanded && hit.text ? hit.text : hit.snippet));
  const href = $derived(conversationHref(hit.conversation.id, { messageId: hit.messageId }));
  const showContext = $derived(expanded || focused);
  const lines = $derived(typeof context === "object" ? context : undefined);
  const where = $derived(location(hit.conversation));
</script>

<article class="card" class:focused class:expanded data-result-card data-hit-id={hit.id} data-role={hit.role ?? ""} data-kind={hit.kind} aria-current={focused || undefined}>
  {#if hit.threadRoot}
    <p class="thread" data-thread-label>
      <Icon name="thread" size={14} />
      <span>Thread in</span>
      <Icon name={where.icon} size={12} />
      <span class="thread-name">{where.name}</span>
      <span aria-hidden="true">·</span>
      <span>{author(hit).name} replied</span>
    </p>
  {/if}
  {#if showContext && lines?.before}{@render line(lines.before, "before")}{/if}
  <div class="main">
    <span class="avatar"><HitAvatar {hit} size={32} /></span>
    <div class="body">
      <div class="head">
        <HitMeta {hit} showThread={false} />
        <time class="stamp" datetime={new Date(hit.at).toISOString()}>{longStamp(hit.at, now)}</time>
      </div>
      <!-- The link covers the card, so a click anywhere opens the conversation at the message, and it opens in a new tab too. -->
      <a class="open" {href} onfocus={onfocus} data-result-open>
        <p class="snippet" class:clamped={!expanded} class:tool={hit.role === "tool"} data-result-snippet><Highlight {pieces} /></p>
      </a>
      <div class="actions">
        <button type="button" class="more" onclick={ontoggle} aria-expanded={expanded} data-result-more>
          {expanded ? "Show less" : hit.text ? "Show more" : "Show context"}
        </button>
      </div>
    </div>
  </div>
  {#if showContext && lines?.after}{@render line(lines.after, "after")}{/if}
  {#if showContext && context === "loading"}<p class="context-note">Loading the messages around it…</p>{/if}
</article>

{#snippet line(entry: ContextLine, side: "before" | "after")}
  <div class="context {side}" data-context={side}>
    <span class="context-author">{entry.author}</span>
    <span class="context-text">{entry.text}</span>
  </div>
{/snippet}

<style>
  .card {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 12px 16px;
    border: 1px solid var(--border-standard);
    border-radius: var(--radius-control);
    background: var(--bg-panel);
    transition: background-color var(--duration-fast) var(--ease-standard);
  }
  .card:hover {
    background: var(--bg-app);
  }
  .card.focused {
    border-color: var(--border-prominent);
  }
  .main {
    display: flex;
    gap: 12px;
    min-width: 0;
  }
  .avatar {
    flex: none;
    padding-top: 2px;
  }
  .body {
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }
  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    min-width: 0;
    font: var(--text-body-sm);
  }
  .stamp {
    flex: none;
    color: var(--text-metadata);
    font: var(--text-caption);
    font-variant-numeric: tabular-nums;
  }
  .open {
    color: inherit;
    text-decoration: none;
  }
  .open::after {
    content: "";
    position: absolute;
    inset: 0;
    border-radius: inherit;
  }
  .open:focus-visible {
    outline: none;
  }
  .card:has(.open:focus-visible) {
    outline: 2px solid var(--border-focus);
    outline-offset: 2px;
  }
  .snippet {
    margin: 0;
    color: var(--text-standard);
    font: var(--text-body);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .snippet.clamped {
    display: -webkit-box;
    -webkit-line-clamp: 3;
    line-clamp: 3;
    -webkit-box-orient: vertical;
    overflow: hidden;
    white-space: normal;
  }
  .snippet.tool {
    font: var(--text-mono);
    color: var(--text-subtle);
  }
  .snippet :global(mark) {
    font-weight: 500;
  }
  .actions {
    display: flex;
    gap: 8px;
  }
  .more {
    position: relative;
    z-index: 1;
    padding: 0;
    border: 0;
    background: none;
    color: var(--text-subtle);
    font: var(--text-caption);
    cursor: pointer;
  }
  .more:hover {
    color: var(--text-standard);
    text-decoration: underline;
  }
  .thread {
    display: flex;
    align-items: center;
    gap: 4px;
    margin: 0;
    color: var(--text-subtle);
    font: var(--text-caption);
  }
  .thread-name {
    color: var(--text-standard);
  }
  .context {
    display: flex;
    gap: 6px;
    margin-left: 44px;
    padding: 4px 0 4px 10px;
    border-left: 2px solid var(--border-standard);
    color: var(--text-subtle);
    font: var(--text-body-sm);
    opacity: 0.8;
  }
  .context-author {
    flex: none;
    font-weight: 500;
  }
  .context-text {
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .context-note {
    margin: 0 0 0 44px;
    color: var(--text-metadata);
    font: var(--text-caption);
  }
</style>
