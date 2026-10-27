<script lang="ts">
  import { hueFor } from "./hash";

  type Props = {
    /** The board id, for example p1128, t34 or d9. */
    id: string;
    /** The chat the id belongs to; it seeds the color with the id. */
    chatId?: string;
    href?: string;
    title?: string;
    onclick?: (e: MouseEvent) => void;
  };
  let { id, chatId = "", href, title, onclick }: Props = $props();
  const hue = $derived(hueFor(`${chatId}:${id}`));
</script>

<!-- The element is a link or a button whenever it has a click handler. -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<svelte:element
  this={href ? "a" : onclick ? "button" : "span"}
  {href}
  type={!href && onclick ? "button" : undefined}
  class="id-chip"
  style:--h={hue}
  data-board-id={id}
  data-chat-id={chatId || undefined}
  {title}
  {onclick}
>
  <span class="dot"></span>{id}
</svelte:element>

