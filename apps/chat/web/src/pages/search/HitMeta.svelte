<script lang="ts">
  import Badge from "$lib/ui/Badge.svelte";
  import Icon from "$lib/ui/Icon.svelte";
  import { author, location, what, type Hit } from "./hit-view";

  /** Who said a hit, an AGENT or SYSTEM badge, where (with its icon) and what kind of text holds the match. */
  let { hit, showPlace = true, showThread = true }: { hit: Hit; showPlace?: boolean; showThread?: boolean } = $props();
  const who = $derived(author(hit));
  const where = $derived(location(hit.conversation));
  const kind = $derived(!showThread && hit.threadRoot && hit.role !== "tool" ? undefined : what(hit));
</script>

<span class="meta" data-hit-meta>
  <span class="name" data-hit-author>{who.name}</span>
  {#if who.badge}<Badge tone="outline">{who.badge}</Badge>{/if}
  {#if showPlace}
    <span class="place" data-hit-place title={`${where.kind}: ${where.parent ? `${where.parent} › ` : ""}${where.name}`}>
      <Icon name={where.icon} size={14} label={where.kind} />
      {#if where.parent}<span class="parent">{where.parent}</span><span class="crumb" aria-hidden="true">›</span>{/if}
      <span class="where">{where.name}</span>
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
  .parent {
    flex: none;
    max-width: 12rem;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .crumb {
    flex: none;
    color: var(--text-metadata);
  }
  .where {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .archived {
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
