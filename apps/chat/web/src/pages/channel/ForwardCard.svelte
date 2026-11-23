<script lang="ts">
  import type { ForwardedPost } from "$lib/api";
  import Avatar from "$lib/ui/Avatar.svelte";
  import Markdown from "$lib/ui/Markdown.svelte";
  import { dayLabel, stampLabel } from "$lib/ui/datetime";
  import type { MarkdownContext } from "$lib/ui/markdown";
  import { conversationHref } from "$lib/router.svelte";
  import { avatarKind, avatarOf } from "./present";

  /**
   * A forwarded post as Slack draws it under a forward: a bar at the left, its author, its text and images, and a line with where it was
   * posted, its day and View message, which opens it in its room.
   */
  type Props = {
    forward: ForwardedPost;
    context?: MarkdownContext;
    onmention?: (id: string, kind: string, e: MouseEvent) => void;
    onartifact?: (target: string, e: MouseEvent) => void;
  };
  let { forward, context = {}, onmention, onartifact }: Props = $props();

  const place = $derived(forward.room.startsWith("ch_") ? `#${forward.roomName}` : forward.room.startsWith("dm_") ? `your DM with ${forward.roomName}` : forward.roomName);
  const href = $derived(conversationHref(forward.room, { messageId: forward.post }));
  const images = $derived(forward.images.filter((image) => image.mimeType.startsWith("image/")));
  const files = $derived(forward.images.length - images.length);
</script>

<div class="forward" data-forward={`${forward.room}:${forward.post}`}>
  <div class="head">
    <Avatar name={avatarOf(forward.author).name} kind={avatarKind(forward.author)} seed={forward.author.id} size={20} />
    <span class="author">{forward.author.name}</span>
  </div>
  {#if forward.text}<Markdown text={forward.text} {context} {onmention} {onartifact} class="msg-text" />{/if}
  {#if images.length}
    <div class="images">
      {#each images as image, index (image.url + index)}
        {#if image.width && image.height}
          <img src={image.url} alt="Forwarded image {index + 1}" loading="lazy" width={image.width} height={image.height} style:--w={image.width} style:--h={image.height} />
        {:else}
          <img class="unsized" src={image.url} alt="Forwarded image {index + 1}" loading="lazy" />
        {/if}
      {/each}
    </div>
  {/if}
  {#if files}<p class="files">{files} file{files > 1 ? "s" : ""} attached</p>{/if}
  <p class="foot">
    <span>Posted in <a href={conversationHref(forward.room)}>{place}</a></span>
    <span aria-hidden="true">|</span>
    <time datetime={new Date(forward.at).toISOString()} title={stampLabel(forward.at)}>{dayLabel(forward.at)}</time>
    <span aria-hidden="true">|</span>
    <a {href} data-forward-view>View message</a>
  </p>
</div>

<style>
  .forward {
    display: flex;
    flex-direction: column;
    gap: 4px;
    max-width: min(100%, 46rem);
    margin-top: 4px;
    padding: 2px 0 2px 12px;
    border-left: 4px solid var(--border-standard);
    text-align: left;
  }
  .head {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .author {
    font-weight: 600;
  }
  .images {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-start;
    gap: 6px;
  }
  /* An image draws its box at its shown size before its bytes arrive, so the rows below a forward never move when it loads. */
  .images img {
    width: min(calc(var(--w) * 1px), 240px, calc(160px * var(--w) / var(--h)));
    height: auto;
    aspect-ratio: var(--w) / var(--h);
    border-radius: 8px;
    object-fit: cover;
  }
  /* An image whose size the server could not read takes the largest box a forward shows. */
  .images img.unsized {
    width: 240px;
    height: 160px;
  }
  .files,
  .foot {
    margin: 0;
    color: var(--text-metadata);
    font: var(--text-caption);
    letter-spacing: var(--tracking-caption);
  }
  .foot {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .foot a {
    color: inherit;
  }
  .foot a:hover {
    color: var(--text-standard);
  }
</style>
