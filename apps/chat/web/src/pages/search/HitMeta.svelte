<script lang="ts">
  import Badge from "$lib/ui/Badge.svelte";
  import Icon from "$lib/ui/Icon.svelte";
  import { author, location, what, type Hit } from "./hit-view";

  /**
   * Who said a hit, an AGENT or SYSTEM badge, where it sits and what kind of text holds the match. The place reads "in # room" for a
   * top-level post, "reply in <thread title>" with the thread icon for a reply, and "in <job>" with a tool or job icon for a hit inside an
   * agent's work (owner p115: root message, in thread, "diggen in some internal tool call").
   */
  type Props = { hit: Hit; showAuthor?: boolean; showPlace?: boolean; showWhat?: boolean; showThread?: boolean };
  let { hit, showAuthor = true, showPlace = true, showWhat = true, showThread = true }: Props = $props();
  const who = $derived(author(hit));
  const where = $derived(location(hit.conversation));
  const place = $derived(hit.where);
  const reply = $derived(place === "thread" && showThread);
  const roomName = $derived(`${hit.conversation.kind === "channel" ? "#" : ""}${where.name}`);
  const threadTitle = $derived(hit.thread?.title || "a thread");
  /** A tool's call or output shows the terminal icon; a job's own messages show the job's. */
  const placeIcon = $derived(place === "tool" && (hit.role === "tool" || hit.kind === "tool") ? "terminal" : where.icon);
  const kind = $derived(showWhat && place !== "thread" ? what(hit) : undefined);
  /**
   * A job that wrote the hit is already named as its author, so its place shows only the agent it works for and the row's width goes to the
   * snippet: "kernel exits on spawn AGENT … in agent factory", with the whole path in the tooltip.
   */
  const named = $derived(!!where.parent && hit.author.name === hit.conversation.name);
</script>

<span class="meta" data-hit-meta>
  {#if showAuthor}
    <span class="name" data-hit-author>{who.name}</span>
    {#if who.badge}<Badge tone="outline">{who.badge}</Badge>{/if}
  {/if}
  {#if reply}
    <span class="place" data-hit-place data-where="thread" title={`Reply in “${threadTitle}” in ${where.kind.toLowerCase()} ${roomName}`}>
      <Icon name="thread" size={14} label="Thread reply" />
      <span class="lead">reply in</span>
      <span class="where">“{threadTitle}”</span>
    </span>
  {:else if showPlace}
    <span class="place" data-hit-place data-where={place} title={`${place === "tool" ? "Inside work in" : `In ${where.kind.toLowerCase()}`} ${where.parent ? `${where.parent} › ` : ""}${roomName}`}>
      <span class="lead">in</span>
      <Icon name={placeIcon} size={14} label={place === "tool" ? "Inside work" : where.kind} />
      {#if named}<span class="where">{where.parent}</span>
      {:else}
        {#if where.parent}<span class="parent">{where.parent}</span><span class="crumb" aria-hidden="true">›</span>{/if}
        <span class="where">{where.name}</span>
      {/if}
      {#if where.archived}<span class="archived">(archived)</span>{/if}
    </span>
  {/if}
  {#if kind}<span class="what" data-hit-what>{kind}</span>{/if}
</span>

<style>
  .meta {
    display: flex;
    flex: 1 1 auto;
    align-items: center;
    gap: 6px;
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
  }
  .name {
    flex: 0 1 auto;
    max-width: 22rem;
    overflow: hidden;
    text-overflow: ellipsis;
    color: var(--text-standard);
    font-weight: 500;
  }
  .place {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    min-width: 0;
    overflow: hidden;
    color: var(--text-subtle);
  }
  .place :global(svg) {
    flex: none;
  }
  /* The agent and the job both give way when the row is narrow, each in proportion to its length, and each keeps its ellipsis. */
  .parent {
    flex: 0 1 auto;
    min-width: 0;
    max-width: 12rem;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .crumb {
    flex: none;
    color: var(--text-metadata);
  }
  .where {
    flex: 0 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .archived {
    flex: none;
    color: var(--text-metadata);
  }
  .lead {
    flex: none;
    color: var(--text-metadata);
  }
  .what {
    flex: none;
    padding: 0 6px;
    border-radius: var(--radius-pill);
    background: var(--affordance-subtle);
    color: var(--text-subtle);
    font: var(--text-caption);
  }
</style>
